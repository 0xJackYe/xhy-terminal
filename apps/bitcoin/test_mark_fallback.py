"""Offline invariants for targeted public mark/IV recovery.

The fixtures deliberately give books/index/catalog independent timestamps. A
small mark response must refresh only its own complete, unchanged contract
group, without making unrelated market data look newly collected.
"""

import copy
import tempfile
import threading
import time
import unittest
from datetime import datetime
from unittest.mock import patch

import dashboard_server as server


CORE = ("mark_price", "mark_iv", "delta", "gamma", "theta", "vega")


def mark_record(symbol, price="55", iv="0.8"):
    return {"symbol": symbol, "markPrice": price, "markIV": iv,
            "delta": "-0.09", "gamma": "0.0001", "theta": "-8", "vega": "2.1",
            "bidIV": "0.78", "askIV": "0.82"}


def recovery_snapshot(count=1, extras=False):
    now = int(time.time() * 1000)
    listings = [("BTC-991231-%s-P" % (60000 + 100 * i), "PUT", 15, 60000 + 100 * i)
                for i in range(count)]
    if extras:
        listings += [("BTC-991231-62000-C", "CALL", 15, 62000),
                     ("BTC-991231-72000-P", "PUT", 15, 72000),
                     ("BTC-991231-63000-P", "PUT", 90, 63000)]
    contracts, marks, tickers = [], [], []
    for symbol, side, days, strike in listings:
        contracts.append({"symbol": symbol, "underlying": "BTCUSDT", "side": side,
                          "expiryDate": now + days * 86400000, "strikePrice": str(strike),
                          "status": "TRADING", "unit": 1, "minQty": "0.01",
                          "quoteAsset": "USDT"})
        marks.append(mark_record(symbol, "50", "0.5"))
        tickers.append({"symbol": symbol, "bidPrice": "49", "askPrice": "51", "lastPrice": "50",
                        "volume": "2", "amount": "100", "closeTime": now})
    payloads = {"time": {"serverTime": now},
                "exchange_info": {"optionSymbols": contracts, "optionContracts": [{"underlying": "BTCUSDT"}]},
                "index": {"indexPrice": "80000"}, "mark": marks, "ticker": tickers}
    stamp = datetime.fromtimestamp(now / 1000, server.BEIJING).isoformat(timespec="milliseconds")
    old = datetime.fromtimestamp((now - 60000) / 1000, server.BEIJING).isoformat(timespec="milliseconds")
    endpoints = {name: {"ok": True, "data": data, "http_status": 200,
                        "received_at_beijing": old if name == "mark" else stamp}
                 for name, data in payloads.items()}
    return server.build_snapshot(endpoints, now, stamp)


def requested_symbol(args, kwargs):
    params = kwargs.get("params") if "params" in kwargs else args[2] if len(args) > 2 else None
    return (params or {}).get("symbol")


def successful_mark(*args, **kwargs):
    return {"ok": True, "data": [mark_record(requested_symbol(args, kwargs))], "http_status": 200}


def wait_mark_idle(cache, timeout=3):
    end = time.monotonic() + timeout
    while cache._mark_refreshing and time.monotonic() < end:
        threading.Event().wait(0.002)
    if cache._mark_refreshing:
        raise AssertionError("targeted mark worker did not finish")


class MarkRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cache = server.MarketCache(self.directory.name, websocket_factory=None)
        self.install(recovery_snapshot())

    def tearDown(self):
        self.cache.stop()
        self.directory.cleanup()

    def install(self, snapshot):
        self.cache._snapshot = snapshot
        self.cache._rows_by_symbol = {row["symbol"]: row for row in snapshot["options"]}
        return list(self.cache._rows_by_symbol)

    def refresh(self, response=successful_mark):
        with patch.object(server, "get_public", side_effect=response) as fetch:
            self.assertTrue(self.cache.request_mark_refresh())
            wait_mark_idle(self.cache)
        return fetch

    def test_complete_targeted_response_updates_fields_without_rejuvenating_other_groups(self):
        before = copy.deepcopy(self.cache._snapshot)
        symbol = next(iter(self.cache._rows_by_symbol))
        fetch = self.refresh()
        after = self.cache._snapshot
        row = self.cache._rows_by_symbol[symbol]
        self.assertEqual("55", row["mark_price"])
        self.assertEqual("0.8", row["mark_iv"])
        for field in CORE:
            self.assertGreater(row["field_updated_at"][field], before["options"][0]["field_updated_at"][field])
            self.assertEqual("rest", row["field_source"][field])
        for field in ("endpoints", "fetched_at", "generated_at_beijing", "catalog_updated_at",
                      "btc_index_price", "index_updated_at", "rate_limits"):
            self.assertEqual(before[field], after[field])
        for group in ("quote", "ticker"):
            for suffix in ("_updated_at", "_event_ms", "_source"):
                self.assertEqual(before["options"][0][group + suffix], row[group + suffix])
        args, kwargs = fetch.call_args
        self.assertEqual("/eapi/v1/mark", args[0])
        self.assertEqual(8, kwargs.get("timeout", args[1] if len(args) > 1 else None))
        self.assertEqual(1, kwargs.get("max_attempts"))
        self.assertEqual(symbol, requested_symbol(args, kwargs))
        self.assertTrue(self.cache.read().get("mark_recovery"))

    def test_recent_complete_marks_and_plain_reads_never_fetch(self):
        now = int(time.time() * 1000)
        row = next(iter(self.cache._rows_by_symbol.values()))
        for field in CORE:
            row["field_updated_at"][field] = now
        with patch.object(server, "get_public", side_effect=AssertionError("no upstream on read")) as fetch:
            self.cache.read()
            self.cache.wait_snapshot(-1, timeout=0)
            self.assertFalse(self.cache.request_mark_refresh())
        fetch.assert_not_called()

    def test_auto_selection_only_strategy_puts_and_each_batch_is_bounded(self):
        self.install(recovery_snapshot(4, extras=True))
        calls, active, maximum = [], [0], [0]
        lock, both_started, release = threading.Lock(), threading.Event(), threading.Event()

        def fetch(*args, **kwargs):
            with lock:
                symbol = requested_symbol(args, kwargs)
                calls.append(symbol)
                active[0] += 1
                maximum[0] = max(maximum[0], active[0])
                if active[0] == 2:
                    both_started.set()
            release.wait(2)
            with lock:
                active[0] -= 1
            return {"ok": True, "data": [mark_record(symbol)], "http_status": 200}

        with patch.object(server, "get_public", side_effect=fetch):
            try:
                self.assertTrue(self.cache.request_mark_refresh())
                self.assertTrue(both_started.wait(1))
                release.set()
                wait_mark_idle(self.cache)
            finally:
                release.set()
        self.assertEqual(4, len(calls))
        self.assertEqual(4, len(set(calls)))
        self.assertLessEqual(maximum[0], 2)
        self.assertTrue(all(symbol.endswith("-P") and int(symbol.split("-")[2]) < 63000 for symbol in calls))

    def test_watch_leases_validate_atomically_and_preserve_priority(self):
        symbols = self.install(recovery_snapshot(2, extras=True))
        watch = ["BTC-991231-72000-P", "BTC-991231-62000-C"]
        with patch.object(self.cache, "request_mark_refresh", return_value=False):
            self.assertEqual(watch, self.cache.watch_marks(watch + watch[:1]))
        original = copy.deepcopy(self.cache._mark_watch)
        self.assertLess(original[watch[0]]["priority"], original[watch[1]]["priority"])
        for invalid in ([], ["BTC-UNKNOWN"], [symbols[0], 5], "BTC-991231-72000-P", symbols * 2):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    self.cache.watch_marks(invalid)
                self.assertEqual(original, self.cache._mark_watch)
        fetch = self.refresh()
        called = {requested_symbol(args, kwargs) for args, kwargs in fetch.call_args_list}
        self.assertTrue(set(watch).issubset(called))
        self.assertEqual(4, len(called))

    def test_expired_watch_does_not_keep_an_outside_strategy_contract_polling(self):
        self.install(recovery_snapshot(0, extras=True))
        symbol = "BTC-991231-72000-P"
        with patch.object(self.cache, "request_mark_refresh", return_value=False):
            self.cache.watch_marks([symbol])
        self.cache._mark_watch[symbol]["until"] = time.time() - 1
        with patch.object(server, "get_public") as fetch:
            self.assertFalse(self.cache.request_mark_refresh())
        fetch.assert_not_called()

    def test_missing_malformed_and_unmatched_payloads_cannot_refresh_old_mark_or_iv(self):
        symbol = next(iter(self.cache._rows_by_symbol))
        missing_iv = mark_record(symbol)
        missing_iv.pop("markIV")
        variants = [[], [mark_record("BTC-UNREQUESTED")], [missing_iv],
                    [mark_record(symbol), mark_record(symbol)], [mark_record(symbol, iv="-1")],
                    [mark_record(symbol, price="NaN")], [mark_record(symbol, iv="0")]]
        for records in variants:
            with self.subTest(records=records):
                self.install(recovery_snapshot())
                self.cache._mark_retry_at.clear()
                before = copy.deepcopy(self.cache._rows_by_symbol[symbol])
                self.refresh(lambda *a, **k: {"ok": True, "data": records, "http_status": 200})
                row = self.cache._rows_by_symbol[symbol]
                for field in CORE:
                    self.assertEqual(before[field], row[field])
                    self.assertEqual(before["field_updated_at"][field], row["field_updated_at"][field])
                self.assertTrue(self.cache._mark_status[symbol].get("error"))

    def test_optional_iv_absence_does_not_relabel_old_optional_fields(self):
        symbol = next(iter(self.cache._rows_by_symbol))
        before = copy.deepcopy(self.cache._rows_by_symbol[symbol])
        record = mark_record(symbol)
        record.pop("bidIV")
        record.pop("askIV")
        self.refresh(lambda *a, **k: {"ok": True, "data": [record], "http_status": 200})
        row = self.cache._rows_by_symbol[symbol]
        self.assertEqual("55", row["mark_price"])
        for field in ("bid_iv", "ask_iv"):
            self.assertEqual(before[field], row[field])
            self.assertEqual(before["field_updated_at"][field], row["field_updated_at"][field])

    def test_single_flight_and_concurrent_ws_or_rest_group_is_never_rolled_back(self):
        for source in ("websocket", "rest"):
            with self.subTest(source=source):
                self.install(recovery_snapshot())
                self.cache._mark_retry_at.clear()
                started, release = threading.Event(), threading.Event()

                def fetch(*args, **kwargs):
                    started.set()
                    release.wait(2)
                    return successful_mark(*args, **kwargs)

                with patch.object(server, "get_public", side_effect=fetch) as request:
                    try:
                        self.assertTrue(self.cache.request_mark_refresh())
                        self.assertTrue(started.wait(1))
                        for _ in range(8):
                            self.assertFalse(self.cache.request_mark_refresh())
                        with self.cache._condition:
                            row = next(iter(self.cache._rows_by_symbol.values()))
                            row["mark_iv"] = "0.99"
                            row["field_updated_at"]["mark_iv"] = int(time.time() * 1000) + 1
                            row["field_source"]["mark_iv"] = source
                            preserved = copy.deepcopy(row)
                        release.set()
                        wait_mark_idle(self.cache)
                    finally:
                        release.set()
                self.assertEqual(1, request.call_count)
                row = next(iter(self.cache._rows_by_symbol.values()))
                for field in CORE:
                    self.assertEqual(preserved[field], row[field])
                    self.assertEqual(preserved["field_updated_at"][field], row["field_updated_at"][field])

    def test_same_millisecond_stream_update_is_conservatively_preserved(self):
        symbol = next(iter(self.cache._rows_by_symbol))
        now = int(time.time() * 1000)
        row = self.cache._rows_by_symbol[symbol]
        row["mark_iv"] = "0.99"
        row["field_updated_at"]["mark_iv"] = now
        row["field_source"]["mark_iv"] = "websocket"
        preserved = copy.deepcopy(row)
        self.cache._apply_mark_result((symbol, now, now + 100,
            {"ok": True, "data": [mark_record(symbol)], "http_status": 200}))
        for field in CORE:
            self.assertEqual(preserved[field], row[field])
            self.assertEqual(preserved["field_updated_at"][field], row["field_updated_at"][field])

    def test_failure_is_sanitized_cools_down_and_releases_busy_for_later_recovery(self):
        symbol = next(iter(self.cache._rows_by_symbol))
        self.refresh(lambda *a, **k: (_ for _ in ()).throw(RuntimeError("private-proxy-token")))
        self.assertFalse(self.cache._mark_refreshing)
        self.assertGreater(self.cache._mark_retry_at[symbol], time.time())
        self.assertNotIn("private-proxy-token", str(self.cache._mark_status))
        with patch.object(server, "get_public") as fetch:
            self.assertFalse(self.cache.request_mark_refresh())
        fetch.assert_not_called()
        self.cache._mark_retry_at[symbol] = time.time() - 1
        self.refresh()
        self.assertEqual("55", self.cache._rows_by_symbol[symbol]["mark_price"])
        self.assertFalse(self.cache._mark_status[symbol].get("error"))
        self.assertNotIn("retry_after_seconds", self.cache._mark_status[symbol])

    def test_late_full_and_partial_rest_cannot_undo_newer_targeted_rest(self):
        for partial in (False, True):
            with self.subTest(partial=partial):
                original = recovery_snapshot()
                symbol = self.install(copy.deepcopy(original))[0]
                now = int(time.time() * 1000)
                self.cache._apply_mark_result((symbol, now - 400, now - 200,
                    {"ok": True, "data": [mark_record(symbol)], "http_status": 200}))
                preserved = copy.deepcopy(self.cache._rows_by_symbol[symbol])
                if partial:
                    def collector():
                        raise server.MarketFetchError("ticker unavailable", {"ticker": {}},
                            {"mark": copy.deepcopy(original["endpoints"]["mark"])},
                            original["fetched_at"], 0)
                    self.cache._collector = collector
                else:
                    self.cache._collector = lambda: copy.deepcopy(original)
                # Reproduce a full request that began before the targeted one,
                # then finishes after the new targeted mark has been committed.
                with patch.object(server.time, "time", return_value=(now - 500) / 1000):
                    self.cache._collect_and_apply()
                row = self.cache._rows_by_symbol[symbol]
                for field in CORE:
                    self.assertEqual(preserved[field], row[field])
                    self.assertEqual(preserved["field_updated_at"][field], row["field_updated_at"][field])

    def test_later_rest_receipt_does_not_override_ws_observed_during_request(self):
        for partial in (False, True):
            with self.subTest(partial=partial):
                incoming = recovery_snapshot()
                symbol = self.install(copy.deepcopy(incoming))[0]
                now = int(time.time() * 1000)
                row = self.cache._rows_by_symbol[symbol]
                row["mark_price"] = "70"
                for field in CORE:
                    row["field_updated_at"][field] = now - 200
                    row["field_source"][field] = "websocket"
                preserved = copy.deepcopy(row)
                received_stamp = datetime.fromtimestamp((now + 100) / 1000,
                    server.BEIJING).isoformat(timespec="milliseconds")
                incoming["endpoints"]["mark"]["received_at_beijing"] = received_stamp
                for field in CORE:
                    incoming["options"][0]["field_updated_at"][field] = now + 100
                if partial:
                    def collector():
                        raise server.MarketFetchError("ticker unavailable", {"ticker": {}},
                            {"mark": copy.deepcopy(incoming["endpoints"]["mark"])}, received_stamp, 0)
                    self.cache._collector = collector
                else:
                    self.cache._collector = lambda: copy.deepcopy(incoming)
                with patch.object(server.time, "time", return_value=(now - 500) / 1000):
                    self.cache._collect_and_apply()
                row = self.cache._rows_by_symbol[symbol]
                for field in CORE:
                    self.assertEqual(preserved[field], row[field])
                    self.assertEqual(preserved["field_updated_at"][field], row["field_updated_at"][field])

    def test_rate_limit_stops_unstarted_symbols_and_obeys_retry_after(self):
        self.install(recovery_snapshot(8))
        calls = []

        def limited(*args, **kwargs):
            calls.append(requested_symbol(args, kwargs))
            return {"ok": False, "http_status": 429, "retry_after": "90", "rate_limited": True,
                    "error": {"type": "HTTP_ERROR", "message": "limited"}}

        with patch.object(server, "get_public", side_effect=limited):
            self.assertTrue(self.cache.request_mark_refresh())
            wait_mark_idle(self.cache)
            self.assertFalse(self.cache.request_mark_refresh())
        self.assertLessEqual(len(calls), 2)
        self.assertGreaterEqual(self.cache._mark_blocked_until - time.time(), 89)

    def test_fallback_local_weight_cap_never_enters_transport(self):
        now = time.time()
        self.cache._mark_attempts.extend([(now, 5)] * 24)
        with patch.object(server, "get_public") as fetch:
            self.assertFalse(self.cache.request_mark_refresh())
        fetch.assert_not_called()

    def test_stop_returns_promptly_and_discards_late_response(self):
        before = copy.deepcopy(self.cache._snapshot)
        started, release = threading.Event(), threading.Event()

        def fetch(*args, **kwargs):
            started.set()
            release.wait(2)
            return successful_mark(*args, **kwargs)

        with patch.object(server, "get_public", side_effect=fetch):
            try:
                self.assertTrue(self.cache.request_mark_refresh())
                self.assertTrue(started.wait(1))
                began = time.monotonic()
                self.cache.stop()
                self.assertLess(time.monotonic() - began, 0.5)
                release.set()
                wait_mark_idle(self.cache)
            finally:
                release.set()
        self.assertEqual(before, self.cache._snapshot)
        self.assertFalse(self.cache.request_mark_refresh())


if __name__ == "__main__":
    unittest.main()
