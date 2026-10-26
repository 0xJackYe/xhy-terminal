"""Offline checks for complete snapshots, stale cache, and local read-only HTTP."""

import copy
import http.client
import json
import tempfile
import threading
import time
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from dashboard_server import (
    ALL_FILTERS, BEIJING, REFRESH_SECONDS, DashboardServer, MarketCache, MarketFetchError,
    build_snapshot, fetch_snapshot, load_saved_snapshot,
)


def fixture_endpoints():
    now_ms = int(time.time() * 1000)
    contracts = []
    marks = []
    tickers = []
    for symbol, underlying, side, expiry in (
        ("BTC-991231-80000-C", "BTCUSDT", "CALL", now_ms + 86400000),
        ("BTC-991231-80000-P", "BTCUSDT", "PUT", now_ms + 86400000),
        ("BTC-900101-80000-C", "BTCUSDT", "CALL", now_ms - 86400000),
        ("ETH-991231-80000-C", "ETHUSDT", "CALL", now_ms + 86400000),
    ):
        contracts.append({"symbol": symbol, "underlying": underlying, "side": side, "expiryDate": expiry, "strikePrice": "80000", "status": "TRADING", "unit": 1, "minQty": "0.01", "quoteAsset": "USDT"})
        marks.append({"symbol": symbol, "markPrice": "500", "markIV": "0.5", "bidIV": "0.48", "askIV": "0.52", "delta": "0.5", "gamma": "0.01", "theta": "-10", "vega": "2"})
        tickers.append({"symbol": symbol, "bidPrice": "490", "askPrice": "510", "lastPrice": "500", "volume": "2", "amount": "1000", "closeTime": now_ms})
    payloads = {"time": {"serverTime": now_ms}, "exchange_info": {"optionSymbols": contracts, "optionContracts": [{"underlying": "BTCUSDT"}, {"underlying": "ETHUSDT"}]}, "index": {"indexPrice": "85000"}, "mark": marks, "ticker": tickers}
    return {name: {"ok": True, "data": data, "http_status": 200} for name, data in payloads.items()}, now_ms


def fixture_snapshot():
    endpoints, now_ms = fixture_endpoints()
    stamp = datetime.fromtimestamp(now_ms / 1000, BEIJING).isoformat(timespec="seconds")
    return build_snapshot(endpoints, now_ms, stamp)


def wait_until_idle(cache):
    deadline = time.monotonic() + 2
    while cache.read()["refreshing"] and time.monotonic() < deadline:
        threading.Event().wait(0.005)
    if cache.read()["refreshing"]:
        raise AssertionError("refresh did not finish")


def reference_uncached_read(cache, include_endpoints=True):
    """Pre-optimization read assembly: independent repeated helper evaluations."""
    now_ms = int(time.time() * 1000)
    if cache._snapshot is None:
        result = {"status": "FAILED", "generated_at_beijing": None, "fetched_at": None,
                  "btc_index_price": None, "btc_contracts_total": 0, "selected_contracts": 0,
                  "options": [], "endpoints": {}, "source": "unavailable", "stale": True,
                  "credentials_used": False, "credential_validity_tested": False}
    else:
        result = copy.deepcopy({key: value for key, value in cache._snapshot.items()
                                if include_endpoints or key != "endpoints"})
        age = time.time() - datetime.fromisoformat(result["fetched_at"]).timestamp()
        realtime = cache._realtime_locked(now_ms)
        result["stale"] = bool((result["stale"] or age > REFRESH_SECONDS * 2 or cache._error)
                               and not realtime["connected"])
        exchange_now = now_ms + result.get("exchange_clock_offset_ms", 0)
        result["options"] = [cache._quote_view_locked(row, now_ms) for row in result["options"]
                             if row["expiry_ms"] > exchange_now]
        result["btc_contracts_total"] = result["selected_contracts"] = len(result["options"])
    interval = cache._refresh_interval_locked(now_ms)
    result.update(error=copy.deepcopy(cache._error), refreshing=cache._refreshing,
                  refresh_interval_seconds=interval, realtime=cache._realtime_locked(now_ms),
                  revision=cache._revision, instance_id=cache._instance_id,
                  retry_after_seconds=max(0, round(cache._blocked_until - time.time())))
    result["next_refresh_at"] = datetime.fromtimestamp(
        max(cache._last_attempt_epoch + interval, cache._blocked_until), BEIJING).isoformat(
        timespec="seconds") if cache._last_attempt_epoch is not None else None
    result["field_freshness_note"] = "字段分别记录接收时间和币安事件时间；静默合约的最后报价不会伪装为新报价。"
    result["data_health"] = cache._data_health_locked(now_ms)
    result["server_now_ms"] = now_ms + result.get("exchange_clock_offset_ms", 0)
    if not include_endpoints:
        result.pop("endpoints", None)
    return result


class SnapshotReadPerformanceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cache = MarketCache(self.directory.name, websocket_factory=None)
        self.cache._snapshot = fixture_snapshot()
        self.cache._rows_by_symbol = {row["symbol"]: row for row in self.cache._snapshot["options"]}
        self.now = int(time.time() * 1000)

    def tearDown(self):
        self.cache.stop()
        self.directory.cleanup()

    def install_verified_books(self):
        symbols = list(self.cache._rows_by_symbol)
        self.cache._stream_states["book-0"] = dict(connected=True, subscription_confirmed=True,
            generation=1, heartbeat_at=self.now, heartbeat_kind="pong", symbols=symbols)
        for row in self.cache._rows_by_symbol.values():
            row.update(bid_quantity="0.25", ask_quantity="0.5")
            fields = ("bid_price", "ask_price", "bid_quantity", "ask_quantity")
            for field in fields:
                row["field_updated_at"][field] = self.now - 90000
                row["field_event_ms"][field] = self.now - 90001
                row["field_source"][field] = "websocket"
            self.cache._book_baselines[row["symbol"]] = dict(connection="book-0", generation=1,
                values={field: row[field] for field in fields}, baseline_at=self.now - 90000,
                event_ms=self.now - 90001, baseline_source="bookTicker",
                **{meta: {field: row[meta][field] for field in fields}
                   for meta in ("field_updated_at", "field_event_ms", "field_source")})

    def test_read_matches_previous_assembly_for_rest_live_stale_and_empty_states(self):
        original = copy.deepcopy(self.cache._snapshot)
        with patch("dashboard_server.time.time", return_value=self.now / 1000):
            for scenario in ("rest", "verified", "expired-heartbeat", "failed", "empty"):
                with self.subTest(scenario=scenario):
                    self.cache._snapshot = copy.deepcopy(original)
                    self.cache._rows_by_symbol = {row["symbol"]: row for row in self.cache._snapshot["options"]}
                    self.cache._stream_states = {}
                    self.cache._book_baselines = {}
                    self.cache._error = None
                    if scenario in ("verified", "expired-heartbeat"):
                        self.install_verified_books()
                        if scenario == "expired-heartbeat":
                            self.cache._stream_states["book-0"]["heartbeat_at"] -= 21000
                    if scenario == "failed":
                        self.cache._error = {"message": "failed", "failed_endpoints": {"mark": {}}}
                        self.cache._blocked_until = self.now / 1000 + 30
                        self.cache._last_attempt_epoch = self.now / 1000 - 2
                    if scenario == "empty":
                        self.cache._snapshot = None
                    for endpoints in (True, False):
                        expected = reference_uncached_read(self.cache, endpoints)
                        actual = self.cache._read_locked(endpoints)
                        self.assertEqual(expected, actual)

    def test_one_sse_read_evaluates_coverage_realtime_and_each_quote_once(self):
        with patch.object(self.cache, "_ticker_coverage_locked", wraps=self.cache._ticker_coverage_locked) as coverage, \
                patch.object(self.cache, "_realtime_locked", wraps=self.cache._realtime_locked) as realtime, \
                patch.object(self.cache, "_quote_view_locked", wraps=self.cache._quote_view_locked) as quote:
            _, result = self.cache.wait_snapshot(-1, timeout=0)
        self.assertEqual(1, coverage.call_count)
        self.assertEqual(1, realtime.call_count)
        self.assertEqual(len(result["options"]), quote.call_count)
        self.assertNotIn("endpoints", result)

    def test_read_outputs_isolate_unknown_nested_fields_and_certified_quote_metadata(self):
        self.install_verified_books()
        snapshot = self.cache._snapshot
        snapshot["extension"] = {"nested": [{"value": [1]}], "tuple": ({"value": [2]},)}
        first = snapshot["options"][0]
        first["extension"] = {"nested": [{"value": [3]}]}
        snapshot["endpoints"]["extension"] = {"nested": [{"value": [4]}]}
        self.cache._stream_states["book-0"]["last_disconnect"] = {"diagnostics": {"lag": [5]}}
        saved_snapshot = copy.deepcopy(snapshot)
        saved_baselines = copy.deepcopy(self.cache._book_baselines)
        saved_states = copy.deepcopy(self.cache._stream_states)
        result = self.cache.read()
        result["extension"]["nested"][0]["value"].append(9)
        result["extension"]["tuple"][0]["value"].append(9)
        result["options"][0]["extension"]["nested"][0]["value"].append(9)
        result["options"][0]["field_source"]["bid_price"] = "changed"
        result["options"][0]["quote_verification"]["values"]["bid_price"] = "changed"
        result["endpoints"]["extension"]["nested"][0]["value"].append(9)
        result["realtime"]["connection_details"]["book-0"]["last_disconnect"]["diagnostics"]["lag"].append(9)
        self.assertEqual(saved_snapshot, snapshot)
        self.assertEqual(saved_baselines, self.cache._book_baselines)
        self.assertEqual(saved_states, self.cache._stream_states)
        later = self.cache.read()
        self.assertEqual([1], later["extension"]["nested"][0]["value"])
        self.assertEqual("490", later["options"][0]["quote_verification"]["values"]["bid_price"])


class SnapshotTests(unittest.TestCase):
    def test_full_snapshot_has_only_complete_active_btc_quotes_and_iv(self):
        endpoints, now_ms = fixture_endpoints()
        original = copy.deepcopy(endpoints)
        result = build_snapshot(endpoints, now_ms, datetime.now(BEIJING).isoformat())
        symbols = {row["symbol"] for row in result["options"]}
        self.assertEqual(2, result["btc_contracts_total"])
        self.assertEqual(2, result["selected_contracts"])
        self.assertEqual({"BTC-991231-80000-C", "BTC-991231-80000-P"}, symbols)
        self.assertEqual("0.48", result["options"][0]["bid_iv"])
        self.assertEqual("0.52", result["options"][0]["ask_iv"])
        self.assertGreater(result["options"][0]["expiry_ms"], now_ms)
        for name in ("mark", "ticker"):
            self.assertEqual(symbols, {item["symbol"] for item in result["endpoints"][name]["data"]})
        self.assertEqual(symbols, {item["symbol"] for item in result["endpoints"]["exchange_info"]["data"]["optionSymbols"]})
        self.assertEqual([{"underlying": "BTCUSDT"}], result["endpoints"]["exchange_info"]["data"]["optionContracts"])
        self.assertEqual(original, endpoints)

    def test_missing_quote_rejects_whole_collection(self):
        endpoints, now_ms = fixture_endpoints()
        endpoints["ticker"]["data"].pop(0)
        with self.assertRaises(MarketFetchError):
            build_snapshot(endpoints, now_ms, datetime.now(BEIJING).isoformat())

    def test_duplicate_or_invalid_endpoint_is_not_joined(self):
        endpoints, now_ms = fixture_endpoints()
        endpoints["mark"]["data"].append(copy.deepcopy(endpoints["mark"]["data"][0]))
        with self.assertRaises(MarketFetchError) as failure:
            build_snapshot(endpoints, now_ms, datetime.now(BEIJING).isoformat())
        self.assertIn("mark", failure.exception.failed_endpoints)

    def test_latest_filtered_export_is_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            full = fixture_snapshot()
            newer = copy.deepcopy(full)
            newer["filters"] = dict(ALL_FILTERS, side="PUT")
            newer["options"] = newer["options"][:1]
            newer["selected_contracts"] = 1
            Path(directory, "btc_options_20261013_010000.json").write_text(json.dumps(full), encoding="utf-8")
            Path(directory, "btc_options_20261013_020000.json").write_text(json.dumps(newer), encoding="utf-8")
            result = load_saved_snapshot(directory)
            self.assertEqual(2, len(result["options"]))
            self.assertEqual(full["fetched_at"], result["fetched_at"])
            self.assertEqual("local_snapshot", result["source"])
            self.assertTrue(result["stale"])

    def test_inconsistent_full_export_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            full = fixture_snapshot()
            full["options"][0]["symbol"] = "BTC-FAKE"
            Path(directory, "btc_options_20261013_030000.json").write_text(json.dumps(full), encoding="utf-8")
            self.assertIsNone(load_saved_snapshot(directory))

    def test_saved_snapshot_restart_days_later_does_not_turn_cache_age_into_clock_skew(self):
        collected = datetime(2026, 10, 13, 12, tzinfo=BEIJING)
        collected_ms = int(collected.timestamp() * 1000)
        restart_ms = collected_ms + 5 * 86400000
        stamp = collected.isoformat(timespec="milliseconds")
        # Include both timestamp sources and legacy exports without a paired
        # server/receipt timestamp, which must conservatively use zero skew.
        for offset, clock_source in ((0, None), (2500, "time"), (-2000, "exchange_info")):
            with self.subTest(offset=offset, clock_source=clock_source), tempfile.TemporaryDirectory() as directory:
                endpoints, _ = fixture_endpoints()
                listings = (("BTC-261014-80000-C", collected_ms + 86400000),
                            ("BTC-261019-80000-P", restart_ms + 86400000),
                            ("BTC-261018-80000-C", restart_ms + 250))
                for position, (symbol, expiry) in enumerate(listings):
                    endpoints["exchange_info"]["data"]["optionSymbols"][position].update(symbol=symbol, expiryDate=expiry)
                    for name in ("mark", "ticker"):
                        endpoints[name]["data"][position]["symbol"] = symbol
                for endpoint in endpoints.values():
                    endpoint["received_at_beijing"] = stamp
                for ticker in endpoints["ticker"]["data"]:
                    ticker["closeTime"] = collected_ms - 1000
                endpoints["time"]["data"]["serverTime"] = collected_ms + offset
                if clock_source != "time":
                    endpoints["time"].pop("received_at_beijing")
                if clock_source == "exchange_info":
                    endpoints["exchange_info"]["data"]["serverTime"] = collected_ms + offset
                elif clock_source is None:
                    endpoints["exchange_info"].pop("received_at_beijing")
                saved = build_snapshot(endpoints, collected_ms + offset, stamp)
                # Never trust an offset previously fabricated by an old loader.
                saved["exchange_clock_offset_ms"] = 4 * 86400000
                Path(directory, "btc_options_20261013_120000.json").write_text(json.dumps(saved), encoding="utf-8")
                originals = {row["symbol"]: row for row in saved["options"]}
                expected_symbols = {"BTC-261019-80000-P"}
                if offset <= 250:
                    expected_symbols.add("BTC-261018-80000-C")
                with patch("dashboard_server.time.time", return_value=restart_ms / 1000):
                    loaded = load_saved_snapshot(directory)
                    self.assertIsNotNone(loaded)
                    self.assertEqual(offset, loaded["exchange_clock_offset_ms"])
                    self.assertEqual(expected_symbols, {row["symbol"] for row in loaded["options"]})
                    self.assertEqual(stamp, loaded["fetched_at"])
                    self.assertEqual(stamp, loaded["catalog_updated_at"])
                    self.assertEqual(collected_ms, loaded["index_updated_at"])
                    self.assertTrue(loaded["stale"])
                    for row in loaded["options"]:
                        old = originals[row["symbol"]]
                        for field in ("field_updated_at", "field_event_ms", "field_source",
                                      "quote_updated_at", "mark_updated_at", "ticker_updated_at"):
                            self.assertEqual(old[field], row[field])
                        self.assertEqual(round((row["expiry_ms"] - restart_ms - offset) / 86400000, 6), row["days_to_expiry"])
                    # The ordinary cache read must not filter a second time
                    # using a fabricated multi-day offset or rejuvenate ages.
                    cache = MarketCache(directory, websocket_factory=None)
                    try:
                        view = cache.read()
                        self.assertEqual(restart_ms + offset, view["server_now_ms"])
                        self.assertEqual(expected_symbols, {row["symbol"] for row in view["options"]})
                        self.assertEqual(stamp, view["catalog_updated_at"])
                    finally:
                        cache.stop()


class CacheTests(unittest.TestCase):
    def test_full_rest_refresh_does_not_discard_existing_ws_depth(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = MarketCache(directory, collector=fixture_snapshot, websocket_factory=None)
            cache._snapshot = fixture_snapshot()
            cache._rows_by_symbol = {row["symbol"]: row for row in cache._snapshot["options"]}
            received = int(time.time() * 1000) - 60000
            for row in cache._snapshot["options"]:
                row.update(bid_quantity="0.25", ask_quantity="0.50")
                for field in ("bid_quantity", "ask_quantity"):
                    row["field_updated_at"][field] = received
                    row["field_event_ms"][field] = received - 10
                    row["field_source"][field] = "websocket"
            self.assertTrue(cache.request_refresh())
            wait_until_idle(cache)
            result = cache.read()
            self.assertIsNone(result["error"])
            self.assertFalse(result["refreshing"])
            for row in result["options"]:
                self.assertEqual("0.25", row["bid_quantity"])
                self.assertEqual("0.50", row["ask_quantity"])
                for field in ("bid_quantity", "ask_quantity"):
                    self.assertEqual(received, row["field_updated_at"][field])
                    self.assertEqual(received - 10, row["field_event_ms"][field])
                    self.assertEqual("websocket", row["field_source"][field])
                self.assertEqual("rest", row["field_source"]["bid_price"])
                self.assertEqual("mixed", row["quote_source"])
            cache.stop()

    def test_full_merge_exception_releases_refresh_and_preserves_data_for_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = MarketCache(directory, collector=fixture_snapshot, websocket_factory=None)
            cache._snapshot = fixture_snapshot()
            cache._rows_by_symbol = {row["symbol"]: row for row in cache._snapshot["options"]}
            before = cache.read()
            with patch("dashboard_server.preserve_concurrent_updates", side_effect=TypeError("private merge details")):
                self.assertTrue(cache.request_refresh())
                wait_until_idle(cache)
            failed = cache.read()
            self.assertFalse(failed["refreshing"])
            self.assertEqual(before["options"], failed["options"])
            self.assertEqual(before["fetched_at"], failed["fetched_at"])
            self.assertGreater(failed["revision"], before["revision"])
            self.assertIn("合并失败", failed["error"]["message"])
            self.assertNotIn("private", json.dumps(failed["error"]))
            self.assertGreater(failed["retry_after_seconds"], 0)
            self.assertFalse(cache.request_refresh())
            cache._last_attempt = None
            cache._blocked_until = 0
            self.assertTrue(cache.request_refresh())
            wait_until_idle(cache)
            self.assertFalse(cache.read()["refreshing"])
            self.assertIsNone(cache.read()["error"])
            cache.stop()

    def test_partial_merge_exception_releases_refresh_and_next_attempt_recovers(self):
        with tempfile.TemporaryDirectory() as directory:
            def partial():
                raise MarketFetchError("partial collection", {"mark": {"message": "unavailable"}})
            cache = MarketCache(directory, collector=partial, websocket_factory=None)
            cache._snapshot = fixture_snapshot()
            cache._rows_by_symbol = {row["symbol"]: row for row in cache._snapshot["options"]}
            before = cache.read()
            with patch.object(cache, "_merge_partial_locked", side_effect=TypeError("unknown timestamp")):
                self.assertTrue(cache.request_refresh())
                wait_until_idle(cache)
            self.assertFalse(cache.read()["refreshing"])
            self.assertEqual(before["options"], cache.read()["options"])
            self.assertIn("合并失败", cache.read()["error"]["message"])
            cache._last_attempt = None
            cache._blocked_until = 0
            cache._collector = fixture_snapshot
            self.assertTrue(cache.request_refresh())
            wait_until_idle(cache)
            self.assertIsNone(cache.read()["error"])
            cache.stop()

    def test_invalid_commit_metadata_cannot_replace_previous_snapshot_or_strand_refresh(self):
        with tempfile.TemporaryDirectory() as directory:
            invalid = fixture_snapshot()
            invalid["rate_limits"] = [{"rateLimitType": "REQUEST_WEIGHT", "interval": "MINUTE", "intervalNum": 1, "limit": "invalid"}]
            cache = MarketCache(directory, collector=lambda: invalid, websocket_factory=None)
            cache._snapshot = fixture_snapshot()
            cache._rows_by_symbol = {row["symbol"]: row for row in cache._snapshot["options"]}
            before = cache.read()
            self.assertTrue(cache.request_refresh())
            wait_until_idle(cache)
            self.assertFalse(cache.read()["refreshing"])
            self.assertEqual(before["options"], cache.read()["options"])
            self.assertEqual(before["rate_limits"], cache.read()["rate_limits"])
            self.assertIn("合并失败", cache.read()["error"]["message"])
            cache._last_attempt = None
            cache._blocked_until = 0
            cache._collector = fixture_snapshot
            self.assertTrue(cache.request_refresh())
            wait_until_idle(cache)
            self.assertIsNone(cache.read()["error"])
            cache.stop()

    def test_refresh_failure_preserves_data_and_real_collection_time(self):
        with tempfile.TemporaryDirectory() as directory:
            full = fixture_snapshot()
            Path(directory, "btc_options_20261013_010000.json").write_text(json.dumps(full), encoding="utf-8")
            def fail():
                raise MarketFetchError("network unavailable", {"ticker": {"message": "unavailable"}})
            cache = MarketCache(directory, collector=fail, websocket_factory=None)
            before = cache.read()
            cache.request_refresh()
            wait_until_idle(cache)
            after = cache.read()
            self.assertEqual(before["fetched_at"], after["fetched_at"])
            self.assertEqual(before["options"], after["options"])
            self.assertTrue(after["stale"])
            self.assertIn("ticker", after["error"]["failed_endpoints"])
            self.assertIsNotNone(after["error"]["attempted_at"])
            cache.stop()

    def test_refreshes_do_not_overlap_and_have_minimum_interval(self):
        release = threading.Event()
        started = threading.Event()
        calls = []
        def collect():
            calls.append(1)
            started.set()
            release.wait(2)
            return fixture_snapshot()
        with tempfile.TemporaryDirectory() as directory:
            cache = MarketCache(directory, collector=collect, websocket_factory=None)
            self.assertTrue(cache.request_refresh())
            self.assertTrue(started.wait(1))
            for _ in range(8):
                self.assertFalse(cache.request_refresh())
            release.set()
            wait_until_idle(cache)
            self.assertFalse(cache.request_refresh())
            self.assertEqual(1, len(calls))
            self.assertFalse(cache.read()["stale"])
            self.assertEqual("binance_public_api", cache.read()["source"])
            cache.stop()

    def test_unavailable_cache_is_explicit_and_ordinary_read_never_fetches(self):
        with tempfile.TemporaryDirectory() as directory:
            def unexpected_fetch():
                raise AssertionError("ordinary reads must not fetch")
            cache = MarketCache(directory, collector=unexpected_fetch, websocket_factory=None)
            value = cache.read()
            self.assertIsNone(value["fetched_at"])
            self.assertEqual([], value["options"])
            self.assertTrue(value["stale"])
            self.assertEqual("unavailable", value["source"])
            cache.stop()


class RecordingHub:
    def __init__(self, on_message, on_state, on_reconnect):
        self.on_message, self.on_state, self.on_reconnect = on_message, on_state, on_reconnect
        self.configured = []
        self.stopped = False

    def configure(self, symbols, index):
        self.configured.append((tuple(symbols), index))

    def stop(self):
        self.stopped = True


class IndependentRestTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cache = MarketCache(self.directory.name, websocket_factory=RecordingHub)
        self.cache._snapshot = fixture_snapshot()
        self.cache._rows_by_symbol = {row["symbol"]: row for row in self.cache._snapshot["options"]}
        self.endpoints, self.now = fixture_endpoints()
        self.stamp = datetime.fromtimestamp(self.now / 1000, BEIJING).isoformat(timespec="milliseconds")
        for endpoint in self.endpoints.values():
            endpoint["received_at_beijing"] = self.stamp

    def tearDown(self):
        self.cache.stop()
        self.directory.cleanup()

    def partial(self, successes, failures=None):
        return MarketFetchError("partial collection", failures or {"mark": {"message": "unavailable"}},
            {name: copy.deepcopy(self.endpoints[name]) for name in successes}, self.stamp)

    def refresh_with(self, error):
        def collect():
            raise error
        self.cache._collector = collect
        self.assertTrue(self.cache.request_refresh())
        wait_until_idle(self.cache)

    def test_time_network_failure_still_collects_other_public_groups(self):
        self.endpoints["time"] = {"ok": False, "http_status": 503, "error": {"message": "unavailable"}}
        paths = {"/eapi/v1/time": "time", "/eapi/v1/exchangeInfo": "exchange_info",
                 "/eapi/v1/index": "index", "/eapi/v1/mark": "mark", "/eapi/v1/ticker": "ticker"}
        original = copy.deepcopy(self.endpoints)
        with patch("dashboard_server.get_public", side_effect=lambda path, *args: self.endpoints[paths[path]]) as fetch:
            with self.assertRaises(MarketFetchError) as failure:
                fetch_snapshot()
        self.assertEqual(5, fetch.call_count)
        self.assertEqual({"exchange_info", "index", "mark", "ticker"}, set(failure.exception.successful_endpoints))
        self.assertEqual(original, self.endpoints)

    def test_time_rate_limit_stops_remaining_collection(self):
        limited = {"ok": False, "http_status": 429, "retry_after": "90", "error": {"message": "limited"}}
        with patch("dashboard_server.get_public", return_value=limited) as fetch:
            with self.assertRaises(MarketFetchError) as failure:
                fetch_snapshot()
        self.assertEqual(1, fetch.call_count)
        self.assertEqual({}, failure.exception.successful_endpoints)
        self.assertEqual("90", failure.exception.failed_endpoints["time"]["retry_after"])

    def test_shared_local_cooldown_stops_batch_without_faking_an_http_response(self):
        limited = {"ok": False, "rate_limited": True, "retry_after": "90",
                   "blocked_by_http_status": 429, "attempts": 0,
                   "error": {"type": "RATE_LIMIT_COOLDOWN", "message": "cooldown"}}
        with patch("dashboard_server.get_public", return_value=limited) as fetch:
            with self.assertRaises(MarketFetchError) as failure:
                fetch_snapshot()
        self.assertEqual(1, fetch.call_count)
        endpoint = failure.exception.failed_endpoints["time"]
        self.assertIsNone(endpoint["http_status"])
        self.assertTrue(endpoint["rate_limited"])
        self.assertEqual(429, endpoint["blocked_by_http_status"])
        self.assertEqual(0, endpoint["attempts"])
        self.assertEqual("90", endpoint["retry_after"])

    def test_partial_refresh_respects_client_cooldown_without_http_status(self):
        self.refresh_with(self.partial(("ticker",), {"mark": {
            "rate_limited": True, "retry_after": "90",
            "blocked_by_http_status": 429, "attempts": 0}}))
        result = self.cache.read()
        self.assertGreaterEqual(result["retry_after_seconds"], 89)
        self.assertEqual(429, result["error"]["failed_endpoints"]["mark"]["blocked_by_http_status"])
        self.assertFalse(self.cache.request_refresh())

    def test_schema_valid_incomplete_join_keeps_successful_groups_for_cache_merge(self):
        self.endpoints["ticker"]["data"].pop(0)
        for item in self.endpoints["ticker"]["data"]:
            item["volume"] = "77"
        for item in self.endpoints["mark"]["data"]:
            item["markPrice"] = "600"
        paths = {"/eapi/v1/time": "time", "/eapi/v1/exchangeInfo": "exchange_info",
                 "/eapi/v1/index": "index", "/eapi/v1/mark": "mark", "/eapi/v1/ticker": "ticker"}
        before = self.cache.read()
        self.cache._collector = fetch_snapshot
        with patch("dashboard_server.get_public", side_effect=lambda path, *args: self.endpoints[paths[path]]):
            self.assertTrue(self.cache.request_refresh())
            wait_until_idle(self.cache)
        after = self.cache.read()
        self.assertEqual("PARTIAL", after["status"])
        self.assertEqual(before["fetched_at"], after["fetched_at"])
        self.assertIn("consistency", after["error"]["failed_endpoints"])
        self.assertEqual("600", after["options"][0]["mark_price"])
        self.assertEqual("600", after["options"][1]["mark_price"])
        self.assertEqual(before["options"][0]["volume_24h_contracts"], after["options"][0]["volume_24h_contracts"])
        self.assertEqual("77", after["options"][1]["volume_24h_contracts"])
        self.assertFalse(after["data_health"]["ticker"]["rest_coverage_complete"])

    def prepare_current_ticker_coverage(self):
        rows = self.cache._snapshot["options"]
        rows[1]["expiry_ms"] += 86400000
        self.cache.stream_state("plan", {"streams": 8, "connections": 3})
        for name in ("market", "ticker-0", "book-0"):
            self.cache.stream_state(name, {"connected": True})
        self.cache._snapshot["endpoints"]["ticker"]["received_at_beijing"] = datetime.now(BEIJING).isoformat(timespec="milliseconds")
        for row in rows:
            event_ms = int(time.time() * 1000)
            self.cache.apply_stream_message({"e": "24hrTicker", "E": event_ms, "s": row["symbol"], "v": "2", "q": "1000", "c": "500"})
            self.cache.apply_stream_message({"e": "markPrice", "E": event_ms, "s": row["symbol"], "i": "85000", "mp": "500", "bo": "490", "ao": "510"})
        self.assertTrue(self.cache.read()["data_health"]["ticker"]["stream_verified"])

    def check_incomplete_ticker_baseline(self, records):
        self.prepare_current_ticker_coverage()
        self.endpoints["ticker"]["data"] = records
        error = self.partial(("ticker",), {"mark": {"message": "unavailable"}})
        error.collected_at = datetime.now(BEIJING).isoformat(timespec="milliseconds")
        error.successful_endpoints["ticker"]["received_at_beijing"] = error.collected_at
        self.refresh_with(error)
        after = self.cache.read()
        health = after["data_health"]["ticker"]
        self.assertEqual(6, health["available_fields"])
        self.assertEqual(2, health["observed_expiries"])
        self.assertGreaterEqual(health["rest_last_received_at"], health["connection_since_ms"])
        self.assertFalse(health["rest_coverage_complete"])
        self.assertFalse(health["stream_verified"])
        self.assertEqual("partial", health["status"])
        self.assertIsNone(health["last_verified_at"])
        self.assertEqual(15, after["refresh_interval_seconds"])

    def test_old_rows_and_current_ws_coverage_do_not_certify_missing_rest_ticker_record(self):
        self.check_incomplete_ticker_baseline([self.endpoints["ticker"]["data"][0]])

    def test_old_rows_and_current_ws_coverage_do_not_certify_empty_rest_ticker_result(self):
        self.check_incomplete_ticker_baseline([])

    def test_ticker_success_updates_statistics_when_mark_and_time_fail(self):
        before = copy.deepcopy(self.cache._snapshot)
        for ticker in self.endpoints["ticker"]["data"]:
            ticker.update(volume="99", amount="9900", bidPrice="480", askPrice="520")
        self.refresh_with(self.partial(("ticker",), {"mark": {"message": "unavailable"}, "time": {"message": "unavailable"}}))
        after = self.cache.read()
        self.assertEqual("PARTIAL", after["status"])
        self.assertEqual(before["fetched_at"], after["fetched_at"])
        self.assertEqual(self.stamp, after["last_partial_refresh_at"])
        for old, row in zip(before["options"], after["options"]):
            self.assertEqual("99", row["volume_24h_contracts"])
            self.assertEqual("9900", row["amount_24h_quote"])
            self.assertEqual("480", row["bid_price"])
            self.assertEqual(self.now, row["field_updated_at"]["volume_24h_contracts"])
            self.assertEqual("rest", row["field_source"]["volume_24h_contracts"])
            self.assertEqual(old["mark_price"], row["mark_price"])
            self.assertEqual(old["field_updated_at"]["mark_price"], row["field_updated_at"]["mark_price"])
        self.assertFalse(after["data_health"]["ticker"]["rest_refresh_failed"])
        self.assertTrue(after["data_health"]["mark"]["rest_refresh_failed"])

    def test_first_partial_bootstrap_requires_a_valid_catalog(self):
        self.cache._snapshot = None
        self.cache._rows_by_symbol = {}
        self.refresh_with(self.partial(("mark", "ticker", "index"), {"exchange_info": {"message": "unavailable"}}))
        self.assertEqual([], self.cache.read()["options"])
        self.assertEqual([], self.cache._hub.configured)
        self.assertIsNone(self.cache._snapshot)

    def test_first_valid_catalog_can_bootstrap_ws_with_missing_mark_fields(self):
        self.cache._snapshot = None
        self.cache._rows_by_symbol = {}
        self.refresh_with(self.partial(("exchange_info", "ticker", "index")))
        snapshot = self.cache.read()
        self.assertEqual("PARTIAL", snapshot["status"])
        self.assertEqual(2, len(snapshot["options"]))
        self.assertEqual(1, len(self.cache._hub.configured))
        for row in snapshot["options"]:
            self.assertIsNone(row["mark_price"])
            self.assertIsNone(row["field_updated_at"]["mark_price"])
            self.assertEqual("490", row["bid_price"])
            self.assertEqual(self.now, row["field_updated_at"]["bid_price"])

    def test_partial_catalog_and_records_remain_btc_active_only_without_mutating_input(self):
        error = self.partial(("exchange_info", "mark", "ticker"), {"time": {"message": "unavailable"}})
        before = copy.deepcopy(error.successful_endpoints)
        self.refresh_with(error)
        snapshot = self.cache.read()
        symbols = {row["symbol"] for row in snapshot["options"]}
        info = snapshot["endpoints"]["exchange_info"]["data"]
        self.assertEqual(symbols, {item["symbol"] for item in info["optionSymbols"]})
        self.assertEqual([{"underlying": "BTCUSDT"}], info["optionContracts"])
        for name in ("mark", "ticker"):
            self.assertEqual(symbols, {item["symbol"] for item in snapshot["endpoints"][name]["data"]})
        self.assertEqual(before, error.successful_endpoints)

    def test_failed_catalog_does_not_admit_unknown_quotes_and_old_directory_is_trimmed(self):
        expired = self.cache._snapshot["options"][0]
        expired["expiry_ms"] = self.now - 1000
        for contract in self.cache._snapshot["endpoints"]["exchange_info"]["data"]["optionSymbols"]:
            if contract["symbol"] == expired["symbol"]:
                contract["expiryDate"] = self.now - 1000
        extra = copy.deepcopy(self.endpoints["ticker"]["data"][0])
        extra["symbol"] = "BTC-991231-90000-C"
        self.endpoints["ticker"]["data"].append(extra)
        self.refresh_with(self.partial(("ticker",), {"exchange_info": {"message": "unavailable"}}))
        snapshot = self.cache.read()
        symbols = {row["symbol"] for row in snapshot["options"]}
        self.assertEqual(1, len(symbols))
        self.assertNotIn(extra["symbol"], symbols)
        self.assertEqual(symbols, {item["symbol"] for item in snapshot["endpoints"]["exchange_info"]["data"]["optionSymbols"]})

    def test_cached_bootstrap_configures_only_valid_unexpired_symbols_before_rest_failure(self):
        endpoints, now = fixture_endpoints()
        endpoints["exchange_info"]["data"]["optionSymbols"][0]["expiryDate"] = now + 1000
        stamp = datetime.fromtimestamp(now / 1000, BEIJING).isoformat(timespec="milliseconds")
        saved = build_snapshot(endpoints, now, stamp)
        Path(self.directory.name, "btc_options_20261013_010000.json").write_text(json.dumps(saved), encoding="utf-8")
        def unavailable():
            raise MarketFetchError("all unavailable", {"time": {"message": "unavailable"}})
        with patch("dashboard_server.time.time", return_value=(now + 2000) / 1000):
            cache = MarketCache(self.directory.name, collector=unavailable, websocket_factory=RecordingHub)
            try:
                cache.start()
                wait_until_idle(cache)
                self.assertEqual(1, len(cache._hub.configured))
                self.assertEqual(("BTC-991231-80000-P",), cache._hub.configured[0][0])
                self.assertIsNotNone(cache.read()["error"])
            finally:
                cache.stop()

    def test_partial_rest_preserves_inflight_ws_prices_trade_pair_and_sequence(self):
        started, release = threading.Event(), threading.Event()
        def collect():
            started.set()
            release.wait(2)
            raise self.partial(("ticker",))
        self.cache._collector = collect
        before = self.cache.read()["options"][0]
        self.assertTrue(self.cache.request_refresh())
        self.assertTrue(started.wait(1))
        time.sleep(0.002)
        event_ms = int(time.time() * 1000) + 100
        self.cache.apply_stream_message({"e": "bookTicker", "E": event_ms, "u": 10, "s": before["symbol"], "b": "700", "a": "710"})
        self.cache.apply_stream_message({"e": "trade", "E": event_ms, "T": event_ms - 1, "s": before["symbol"], "p": "705"})
        release.set()
        wait_until_idle(self.cache)
        row = self.cache.read()["options"][0]
        self.assertEqual("700", row["bid_price"])
        self.assertEqual("705", row["last_price"])
        self.assertEqual(event_ms - 1, row["last_trade_time_ms"])
        self.assertEqual("websocket", row["field_source"]["last_trade_beijing"])
        self.assertEqual(self.now, row["field_updated_at"]["volume_24h_contracts"])
        self.cache.apply_stream_message({"e": "bookTicker", "E": event_ms, "u": 9, "s": before["symbol"], "b": "600", "a": "610"})
        self.assertEqual("700", self.cache.read()["options"][0]["bid_price"])

    def test_stop_rejects_late_collection_and_transport_callbacks(self):
        started, release = threading.Event(), threading.Event()
        def collect():
            started.set()
            release.wait(2)
            return fixture_snapshot()
        self.cache._collector = collect
        self.cache.start()
        self.assertTrue(started.wait(1))
        before = copy.deepcopy(self.cache._snapshot)
        configurations = len(self.cache._hub.configured)
        self.cache.stop()
        release.set()
        wait_until_idle(self.cache)
        symbol = before["options"][0]["symbol"]
        self.assertFalse(self.cache._hub.on_message({"e": "markPrice", "E": self.now + 1000, "s": symbol, "mp": "999"}))
        self.cache._hub.on_state("market", {"connected": True})
        self.assertEqual({}, self.cache._stream_states)
        self.assertEqual(before, self.cache._snapshot)
        self.assertEqual(configurations, len(self.cache._hub.configured))

    def test_partial_success_still_obeys_rate_limit_retry_after(self):
        for ticker in self.endpoints["ticker"]["data"]:
            ticker["volume"] = "88"
        self.refresh_with(self.partial(("ticker",), {"mark": {"http_status": 429, "retry_after": "90"}}))
        self.assertEqual("88", self.cache.read()["options"][0]["volume_24h_contracts"])
        self.assertGreaterEqual(self.cache.read()["retry_after_seconds"], 89)
        self.assertFalse(self.cache.request_refresh())

    def test_repeated_partial_progress_keeps_fifteen_second_recovery(self):
        for attempt in range(3):
            current_ms = self.now + attempt * 16000
            for item in self.endpoints["ticker"]["data"]:
                item["volume"] = str(90 + attempt)
            self.endpoints["ticker"]["received_at_beijing"] = datetime.fromtimestamp(current_ms / 1000, BEIJING).isoformat(timespec="milliseconds")
            error = self.partial(("ticker",), {"mark": {"message": "network unavailable"}})
            error.collected_at = self.endpoints["ticker"]["received_at_beijing"]
            self.cache._last_attempt = None
            with patch("dashboard_server.time.time", return_value=current_ms / 1000):
                self.refresh_with(error)
                self.assertEqual(str(90 + attempt), self.cache.read()["options"][0]["volume_24h_contracts"])
                self.assertEqual(1, self.cache._failure_count)
                self.assertLessEqual(self.cache.read()["retry_after_seconds"], 15)

    def test_total_failure_preserves_every_quote_and_timestamp(self):
        before = copy.deepcopy(self.cache._snapshot)
        self.refresh_with(MarketFetchError("all unavailable", {"ticker": {"message": "unavailable"}}))
        self.assertEqual(before, self.cache._snapshot)
        self.assertIsNotNone(self.cache.read()["error"])


class DataHealthTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cache = MarketCache(self.directory.name, websocket_factory=None)
        self.cache._snapshot = fixture_snapshot()
        self.now = int(time.time() * 1000)
        self.cache._snapshot["fetched_at"] = self.stamp(self.now)
        for endpoint in self.cache._snapshot["endpoints"].values():
            endpoint["received_at_beijing"] = self.stamp(self.now)
        self.cache._snapshot["index_updated_at"] = self.now
        for row in self.cache._snapshot["options"]:
            for field in row["field_updated_at"]:
                row["field_updated_at"][field] = self.now
        self.cache._rows_by_symbol = {row["symbol"]: row for row in self.cache._snapshot["options"]}
        self.clock = patch("dashboard_server.time.time", return_value=self.now / 1000)
        self.clock.start()

    def tearDown(self):
        self.clock.stop()
        self.cache.stop()
        self.directory.cleanup()

    def stamp(self, milliseconds):
        return datetime.fromtimestamp(milliseconds / 1000, BEIJING).isoformat(timespec="milliseconds")

    def connect(self):
        self.cache.stream_state("plan", {"streams": 8, "connections": 3})
        for name in ("market", "ticker-0", "book-0"):
            self.cache.stream_state(name, {"connected": True})

    def ticker(self, row, event_ms=None, **extra):
        event = {"e": "24hrTicker", "E": event_ms or self.now, "s": row["symbol"],
                 "v": "0", "q": "0", "c": "500"}
        event.update(extra)
        return self.cache.apply_stream_message(event)

    def mark(self, row):
        return self.cache.apply_stream_message({"e": "markPrice", "E": self.now, "s": row["symbol"],
            "i": "85000", "mp": "500", "vo": "0.5", "d": "0.5", "g": "0.01", "t": "-10",
            "v": "2", "bo": "490", "ao": "510"})

    def two_expiries(self):
        self.cache._snapshot["options"][1]["expiry_ms"] += 86400000
        return self.cache._snapshot["options"]

    def test_health_is_explicit_without_any_snapshot(self):
        self.cache._snapshot = None
        self.cache._rows_by_symbol = {}
        health = self.cache.read()["data_health"]
        self.assertEqual({"quote", "mark", "index", "ticker", "catalog"}, set(health))
        self.assertTrue(all(group["status"] == "unavailable" for group in health.values()))

    def test_recent_rest_and_zero_statistics_are_valid_without_live_claim(self):
        for row in self.cache._snapshot["options"]:
            row.update(volume_24h_contracts="0", amount_24h_quote="0")
        health = self.cache.read()["data_health"]
        self.assertTrue(all(group["status"] == "fresh" for name, group in health.items() if name != "quote"))
        # The ticker endpoint supplies prices, not order-book quantities.
        self.assertEqual("partial", health["quote"]["status"])
        self.assertEqual(4, health["quote"]["fresh_fields"])
        self.assertEqual(8, health["quote"]["total_fields"])
        self.assertEqual(4, health["quote"]["missing_fields"])
        self.assertEqual(0, health["ticker"]["missing_fields"])
        self.assertEqual("rest", health["ticker"]["source"])
        self.assertFalse(health["ticker"]["stream_verified"])

    def test_live_prices_do_not_hide_old_statistics_or_directory(self):
        for endpoint in self.cache._snapshot["endpoints"].values():
            endpoint["received_at_beijing"] = self.stamp(self.now - 901000)
        self.cache._snapshot["fetched_at"] = self.stamp(self.now - 901000)
        for row in self.cache._snapshot["options"]:
            for field in row["field_updated_at"]:
                row["field_updated_at"][field] = self.now - 901000
        self.cache._error = {"message": "network unavailable", "failed_endpoints": {"ticker": {}}}
        self.connect()
        for row in self.cache._snapshot["options"]:
            self.mark(row)
        result = self.cache.read()
        self.assertFalse(result["stale"])  # Backward-compatible quote-level flag.
        for name in ("mark", "index"):
            self.assertEqual("live", result["data_health"][name]["status"])
        quote = result["data_health"]["quote"]
        self.assertEqual("partial", quote["status"])
        self.assertEqual(4, quote["fresh_fields"])
        self.assertEqual(8, quote["total_fields"])
        self.assertEqual(4, quote["missing_fields"])
        self.assertEqual("stale", result["data_health"]["ticker"]["status"])
        self.assertEqual("stale", result["data_health"]["catalog"]["status"])
        self.assertEqual(901, result["data_health"]["ticker"]["rest_age_seconds"])
        self.assertTrue(result["data_health"]["ticker"]["rest_refresh_failed"])

    def test_partial_statistics_have_distinct_coverage_and_missing_count(self):
        rows = self.cache._snapshot["options"]
        rows[1]["volume_24h_contracts"] = None
        self.ticker(rows[0])
        health = self.cache.read()["data_health"]["ticker"]
        self.assertEqual("partial", health["status"])
        self.assertEqual("mixed", health["source"])
        self.assertEqual(1, health["missing_fields"])
        self.assertEqual(5, health["available_fields"])

    def test_one_expiry_event_does_not_certify_all_expiries(self):
        rows = self.two_expiries()
        self.connect()
        self.ticker(rows[0])
        result = self.cache.read()
        ticker = result["data_health"]["ticker"]
        self.assertEqual(1, ticker["observed_expiries"])
        self.assertEqual(2, ticker["total_expiries"])
        self.assertFalse(ticker["stream_verified"])
        self.assertNotEqual("live", ticker["status"])
        self.assertEqual(15, result["refresh_interval_seconds"])

    def test_quiet_verified_change_only_feed_keeps_original_change_times(self):
        rows = self.two_expiries()
        self.connect()
        for state in self.cache._stream_states.values():
            state["connected_since_ms"] = self.now - 3601000
        self.cache._snapshot["endpoints"]["ticker"]["received_at_beijing"] = self.stamp(self.now - 3600000)
        for row in rows:
            self.ticker(row)
            self.mark(row)
            for field in ("volume_24h_contracts", "amount_24h_quote", "last_price"):
                row["field_updated_at"][field] = self.now - 3500000
        self.cache._last_messages["ticker"] = self.now - 3500000
        result = self.cache.read()
        ticker = result["data_health"]["ticker"]
        self.assertEqual("live", ticker["status"])
        self.assertTrue(ticker["stream_verified"])
        self.assertEqual(self.now - 3500000, ticker["oldest_updated_at"])
        self.assertEqual(3500, ticker["age_seconds"])
        self.assertEqual(300, result["refresh_interval_seconds"])

    def test_reconnection_invalidates_old_evidence_and_requires_new_rest_baseline(self):
        rows = self.two_expiries()
        self.connect()
        for row in rows:
            self.ticker(row)
        before = self.cache.read()["data_health"]["ticker"]
        self.assertTrue(before["stream_verified"])
        self.cache.stream_state("ticker-0", {"connected": False})
        self.assertFalse(self.cache.read()["realtime"]["ticker_stream_observed"])
        with patch("dashboard_server.time.time", return_value=(self.now + 2000) / 1000):
            self.cache.stream_state("ticker-0", {"connected": True})
            for row in rows:
                self.ticker(row, self.now + 2000)
            ticker = self.cache.read()["data_health"]["ticker"]
            self.assertEqual(2, ticker["observed_expiries"])
            self.assertFalse(ticker["stream_verified"])
            self.assertGreater(ticker["connection_generation"], before["connection_generation"])
            self.cache._snapshot["endpoints"]["ticker"]["received_at_beijing"] = self.stamp(self.now + 2000)
            self.assertTrue(self.cache.read()["data_health"]["ticker"]["stream_verified"])

    def test_partial_or_rejected_statistic_fields_do_not_count_as_expiry_coverage(self):
        self.connect()
        row = self.cache._snapshot["options"][0]
        self.cache.apply_stream_message({"e": "24hrTicker", "E": self.now, "s": row["symbol"], "c": "501"})
        self.assertEqual(0, self.cache.read()["data_health"]["ticker"]["observed_expiries"])
        for field in ("volume_24h_contracts", "amount_24h_quote"):
            row["ws_event_watermarks"][field] = self.now + 100
        self.ticker(row, self.now + 1)
        self.assertEqual(0, self.cache.read()["data_health"]["ticker"]["observed_expiries"])


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.static = self.directory / "dist"
        self.static.mkdir()
        (self.static / "index.html").write_text("<html>Dashboard</html>", encoding="utf-8")
        (self.directory / "outside.txt").write_text("private", encoding="utf-8")
        self.cache = MarketCache(self.directory, websocket_factory=None)
        self.server = DashboardServer(("127.0.0.1", 0), self.cache, self.static)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.cache.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(1)
        self.temporary.cleanup()

    def request(self, path, method="GET", headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        status, payload = response.status, response.read()
        connection.close()
        return status, payload

    def test_html_and_cache_are_readable_and_trading_methods_are_rejected(self):
        self.assertEqual((200, b"<html>Dashboard</html>"), self.request("/"))
        status, payload = self.request("/api/market")
        self.assertEqual(200, status)
        self.assertTrue(json.loads(payload)["stale"])
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            with self.subTest(method=method):
                self.assertEqual(405, self.request("/api/market", method)[0])
        self.assertEqual(404, self.request("/api/account")[0])

    def test_http_verified_quote_matches_complete_snapshot_and_disconnect_revokes_it(self):
        self.cache._snapshot = fixture_snapshot()
        self.cache._rows_by_symbol = {row["symbol"]: row for row in self.cache._snapshot["options"]}
        symbol = self.cache._snapshot["options"][0]["symbol"]
        now = int(time.time() * 1000)
        self.cache.stream_state("book-0", {"connected": True, "subscription_confirmed": True,
            "generation": 7, "symbols": [symbol], "heartbeat_at": now, "heartbeat_kind": "pong", "opened_at_ms": now - 1})
        self.cache.apply_stream_message({"_transport": {"connection": "book-0", "generation": 7}, "data": {
            "e": "bookTicker", "E": now, "u": 1, "s": symbol, "b": "490", "a": "510", "B": "2", "A": "3"}})
        status, payload = self.request("/api/market")
        self.assertEqual(200, status)
        row = next(row for row in json.loads(payload)["options"] if row["symbol"] == symbol)
        self.assertEqual({key: row[key] for key in ("bid_price", "ask_price", "bid_quantity", "ask_quantity")}, row["quote_verification"]["values"])
        self.assertEqual(now, row["quote_verified_at"])
        self.cache.stream_state("book-0", {"connected": False})
        status, payload = self.request("/api/market")
        self.assertEqual(200, status)
        self.assertTrue(all(row["quote_verification"] is None for row in json.loads(payload)["options"]))

    def test_static_types_do_not_initialize_the_platform_mime_registry(self):
        cases = (("index.html", "text/html; charset=utf-8"),
                 ("app.js", "text/javascript; charset=utf-8"),
                 ("styles.css", "text/css; charset=utf-8"),
                 ("alarm.wav", "audio/wav"),
                 ("unknown.asset", "application/octet-stream"))
        for asset, _ in cases:
            (self.static / asset).write_bytes(b"static test payload")
        with patch("dashboard_server.mimetypes.guess_type",
                   side_effect=AssertionError("static serving must not initialize platform MIME data")) as guess:
            for asset, expected in cases:
                with self.subTest(asset=asset):
                    connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
                    response = None
                    try:
                        connection.request("GET", "/" + asset)
                        response = connection.getresponse()
                        self.assertEqual(200, response.status)
                        self.assertEqual(expected, response.getheader("Content-Type"))
                        self.assertEqual(b"static test payload", response.read())
                    finally:
                        if response is not None:
                            response.close()
                        connection.close()
            guess.assert_not_called()

    def test_encoded_traversal_windows_paths_and_untrusted_host_are_blocked(self):
        for path in ("/../outside.txt", "/%2e%2e/outside.txt", "/..%5coutside.txt", "/%00", "/C:/Windows/win.ini"):
            with self.subTest(path=path):
                self.assertEqual(403, self.request(path)[0])
        self.assertEqual(403, self.request("/api/market", headers={"Host": "untrusted.example"})[0])

    def test_sse_sends_read_only_snapshot_without_raw_rest_payloads(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.request("GET", "/api/events")
        response = connection.getresponse()
        self.assertEqual(200, response.status)
        self.assertEqual("text/event-stream; charset=utf-8", response.getheader("Content-Type"))
        lines = []
        while len(lines) < 8:
            line = response.fp.readline().decode("utf-8").strip()
            lines.append(line)
            if line.startswith("data: "):
                payload = json.loads(line[6:])
                self.assertEqual([], payload["options"])
                self.assertNotIn("endpoints", payload)
                self.assertFalse(payload["realtime"]["connected"])
                self.assertEqual("unavailable", payload["data_health"]["ticker"]["status"])
                break
        self.assertIn("event: snapshot", lines)
        connection.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
