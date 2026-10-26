"""Independent failure-injection checks for focused public market repair.

A slow bulk REST response must not undo a more recent targeted observation.
These checks intentionally vary receipt times independently from collector
completion and retain the original catalogue/full-collection timestamps.
"""

import copy
import tempfile
import threading
import time
import unittest
from datetime import datetime
from unittest.mock import patch

import dashboard_server as server
import focused_market_recovery as focused
from test_mark_fallback import recovery_snapshot


QUOTE_FIELDS = ("bid_price", "ask_price", "bid_quantity", "ask_quantity")


class FocusedObservationOrderingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cache = server.MarketCache(self.directory.name, websocket_factory=None)
        self.original = recovery_snapshot()
        self.now = int(time.time() * 1000)
        self.cache._snapshot = copy.deepcopy(self.original)
        self.cache._rows_by_symbol = {row["symbol"]: row for row in self.cache._snapshot["options"]}
        self.symbol = next(iter(self.cache._rows_by_symbol))

    def tearDown(self):
        self.cache.stop()
        self.directory.cleanup()

    def install_focused_quote(self):
        row = self.cache._rows_by_symbol[self.symbol]
        for field, value in zip(QUOTE_FIELDS, ("60", "64", "0.2", "0.3")):
            row[field] = value
            row["field_updated_at"][field] = self.now - 100
            row["field_event_ms"][field] = None
            row["field_source"][field] = "rest"
        row.update(quote_updated_at=self.now - 100, quote_event_ms=None, quote_source="rest")
        return copy.deepcopy(row)

    def install_focused_index(self):
        self.cache._snapshot.update(btc_index_price="80500", index_updated_at=self.now - 100,
                                    index_event_ms=None, index_source="rest")

    def collect_bulk(self, partial, late_receipt=False):
        bulk = copy.deepcopy(self.original)
        # Simulate a request that started before the targeted observation and
        # whose response body was already received before that observation.
        bulk_received = self.now + 100 if late_receipt else self.now - 200
        old_receipt = datetime.fromtimestamp(bulk_received / 1000,
            server.BEIJING).isoformat(timespec="milliseconds")
        bulk["fetched_at"] = old_receipt
        for endpoint in bulk["endpoints"].values():
            endpoint["received_at_beijing"] = old_receipt
        for row in bulk["options"]:
            for field in row["field_updated_at"]:
                row["field_updated_at"][field] = bulk_received
        bulk["index_updated_at"] = bulk_received
        if partial:
            def collector():
                raise server.MarketFetchError("one unrelated endpoint unavailable", {"mark": {}},
                    {name: bulk["endpoints"][name] for name in ("index", "ticker")},
                    old_receipt, 0)
            self.cache._collector = collector
        else:
            self.cache._collector = lambda: bulk
        with patch.object(server.time, "time", return_value=(self.now - 500) / 1000):
            self.cache._collect_and_apply()

    def assert_quote_preserved(self, observed):
        row = self.cache._rows_by_symbol[self.symbol]
        for field in QUOTE_FIELDS:
            self.assertEqual(observed[field], row[field], field)
            for meta in ("field_updated_at", "field_event_ms", "field_source"):
                self.assertEqual(observed[meta][field], row[meta][field], (meta, field))

    def test_bulk_full_response_cannot_mix_old_prices_with_new_focused_depth(self):
        observed = self.install_focused_quote()
        self.collect_bulk(partial=False)
        self.assert_quote_preserved(observed)

    def test_bulk_partial_response_cannot_mix_old_prices_with_new_focused_depth(self):
        observed = self.install_focused_quote()
        self.collect_bulk(partial=True)
        self.assert_quote_preserved(observed)

    def test_bulk_full_response_cannot_roll_back_new_focused_index(self):
        self.install_focused_index()
        self.collect_bulk(partial=False)
        snapshot = self.cache._snapshot
        self.assertEqual("80500", snapshot["btc_index_price"])
        self.assertEqual(self.now - 100, snapshot["index_updated_at"])
        self.assertEqual("rest", snapshot["index_source"])

    def test_bulk_partial_response_cannot_roll_back_new_focused_index(self):
        self.install_focused_index()
        self.collect_bulk(partial=True)
        snapshot = self.cache._snapshot
        self.assertEqual("80500", snapshot["btc_index_price"])
        self.assertEqual(self.now - 100, snapshot["index_updated_at"])
        self.assertEqual("rest", snapshot["index_source"])

    def test_slow_bulk_full_body_cannot_override_concurrent_focused_observations(self):
        observed = self.install_focused_quote()
        self.install_focused_index()
        self.collect_bulk(partial=False, late_receipt=True)
        self.assert_quote_preserved(observed)
        self.assertEqual("80500", self.cache._snapshot["btc_index_price"])

    def test_slow_bulk_partial_body_cannot_override_concurrent_focused_observations(self):
        observed = self.install_focused_quote()
        self.install_focused_index()
        self.collect_bulk(partial=True, late_receipt=True)
        self.assert_quote_preserved(observed)
        self.assertEqual("80500", self.cache._snapshot["btc_index_price"])


class FocusedMarketIngressTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cache = server.MarketCache(self.directory.name, websocket_factory=None)
        self.cache._snapshot = recovery_snapshot()
        self.cache._rows_by_symbol = {row["symbol"]: row for row in self.cache._snapshot["options"]}
        self.symbol = next(iter(self.cache._rows_by_symbol))
        # The original fixture precedes every injected request below. Each test
        # controls wire receipt independently from the current display clock.
        self.now = int(time.time() * 1000) + 1000
        self.clock = patch.object(server.time, "time", side_effect=lambda: self.now / 1000)
        self.clock.start()

    def tearDown(self):
        self.clock.stop()
        self.cache.stop()
        self.directory.cleanup()

    def row(self):
        return self.cache._rows_by_symbol[self.symbol]

    def view(self):
        return next(row for row in self.cache.read()["options"] if row["symbol"] == self.symbol)

    def depth(self, bids=None, asks=None, **extra):
        data = {"bids": [["60", "0.2"]] if bids is None else bids,
                "asks": [["64", "0.3"]] if asks is None else asks,
                "T": self.now - 150, "lastUpdateId": 1000}
        data.update(extra)
        return {"ok": True, "data": data, "http_status": 200}

    def apply_depth(self, endpoint=None, began=None, received=None):
        self.cache._apply_focused_result(("depth", self.symbol,
            self.now - 200 if began is None else began,
            self.now - 100 if received is None else received,
            self.depth() if endpoint is None else endpoint))

    def apply_index(self, endpoint=None, began=None, received=None):
        self.cache._apply_focused_result(("index", "BTCUSDT",
            self.now - 200 if began is None else began,
            self.now - 100 if received is None else received,
            {"ok": True, "http_status": 200, "data": {"indexPrice": "80500", "time": self.now - 150}}
            if endpoint is None else endpoint))

    def test_targeted_book_is_one_coherent_observation_without_rejuvenating_other_groups(self):
        before = copy.deepcopy(self.cache._snapshot)
        self.apply_depth()
        row, view = self.row(), self.view()
        for field, value in zip(QUOTE_FIELDS, ("60", "64", "0.2", "0.3")):
            self.assertEqual(value, row[field])
            self.assertEqual(value, view[field])
            self.assertEqual(self.now - 100, row["field_updated_at"][field])
            self.assertEqual("rest", row["field_source"][field])
        self.assertIsNone(view.get("quote_verification"))
        self.assertIsNone(view.get("quote_verified_at"))
        for field in ("mark_price", "mark_iv", "delta", "last_price"):
            self.assertEqual(before["options"][0][field], row[field])
            self.assertEqual(before["options"][0]["field_updated_at"][field], row["field_updated_at"][field])
        for field in ("fetched_at", "generated_at_beijing", "catalog_updated_at", "btc_index_price", "index_updated_at"):
            self.assertEqual(before[field], self.cache._snapshot[field])

    def test_empty_book_side_removes_old_executable_price_and_quantity(self):
        self.apply_depth(self.depth(bids=[]))
        view = self.view()
        self.assertEqual(0, float(view["bid_price"]))
        self.assertEqual(0, float(view["bid_quantity"]))
        self.assertEqual("64", view["ask_price"])
        self.assertEqual(self.now - 100, view["field_updated_at"]["bid_quantity"])

    def test_malformed_crossed_negative_or_unsorted_books_cannot_refresh_prices_or_times(self):
        variants = [
            {"ok": True, "http_status": 200, "data": {}},
            self.depth(bids=[["NaN", "1"]]),
            self.depth(bids=[["60", "-1"]]),
            self.depth(asks=[["-1", "1"]]),
            self.depth(bids=[[True, "1"]]),
            self.depth(bids=[["65", "1"]]),
            self.depth(bids=[["60", "1"], ["61", "1"]]),
            self.depth(asks=[["64", "1"], ["63", "1"]]),
            self.depth(bids=[["60"]]),
        ]
        for response in variants:
            with self.subTest(response=response):
                before = copy.deepcopy(self.row())
                self.apply_depth(response)
                for field in QUOTE_FIELDS:
                    self.assertEqual(before.get(field), self.row().get(field), field)
                    self.assertEqual(before["field_updated_at"].get(field),
                                     self.row()["field_updated_at"].get(field), field)

    def test_concurrent_quote_observation_blocks_entire_rest_group(self):
        for source in ("websocket", "rest"):
            with self.subTest(source=source):
                row = self.row()
                row["bid_price"] = "62"
                row["field_updated_at"]["bid_price"] = self.now - 150
                row["field_source"]["bid_price"] = source
                observed = copy.deepcopy(row)
                self.apply_depth()
                for field in QUOTE_FIELDS:
                    self.assertEqual(observed.get(field), row.get(field))
                    self.assertEqual(observed["field_updated_at"].get(field), row["field_updated_at"].get(field))

    def test_same_millisecond_quote_update_is_conservatively_preserved(self):
        row = self.row()
        row["ask_price"] = "63"
        row["field_updated_at"]["ask_price"] = self.now - 200
        row["field_source"]["ask_price"] = "websocket"
        observed = copy.deepcopy(row)
        self.apply_depth()
        for field in QUOTE_FIELDS:
            self.assertEqual(observed.get(field), row.get(field))

    def test_older_exchange_book_sequence_cannot_roll_back_current_ws_book(self):
        self.row()["book_update_id"] = 1001
        before = copy.deepcopy(self.row())
        self.apply_depth()
        for field in QUOTE_FIELDS:
            self.assertEqual(before.get(field), self.row().get(field))
            self.assertEqual(before["field_updated_at"].get(field), self.row()["field_updated_at"].get(field))

    def test_future_exchange_book_time_cannot_manufacture_a_fresh_book(self):
        before = copy.deepcopy(self.row())
        self.apply_depth(self.depth(T=self.now + 60000))
        for field in QUOTE_FIELDS:
            self.assertEqual(before.get(field), self.row().get(field))
            self.assertEqual(before["field_updated_at"].get(field), self.row()["field_updated_at"].get(field))

    def test_index_repair_updates_only_index_and_preserves_actual_receipt(self):
        before = copy.deepcopy(self.cache._snapshot)
        self.apply_index()
        after = self.cache._snapshot
        self.assertEqual("80500", after["btc_index_price"])
        self.assertEqual(self.now - 100, after["index_updated_at"])
        self.assertEqual("rest", after["index_source"])
        for field in ("options", "fetched_at", "generated_at_beijing", "catalog_updated_at"):
            self.assertEqual(before[field], after[field])

    def test_index_repair_cannot_override_a_concurrent_ws_or_rest_index(self):
        for source in ("websocket", "rest"):
            with self.subTest(source=source):
                self.cache._snapshot.update(btc_index_price="81000", index_updated_at=self.now - 150,
                                            index_source=source, index_event_ms=self.now - 150)
                self.apply_index()
                self.assertEqual("81000", self.cache._snapshot["btc_index_price"])
                self.assertEqual(self.now - 150, self.cache._snapshot["index_updated_at"])

    def test_future_rest_index_time_cannot_poison_following_ws_index_watermark(self):
        original = copy.deepcopy(self.cache._snapshot)
        self.apply_index({"ok": True, "http_status": 200,
            "data": {"indexPrice": "80500", "time": self.now + 60000}})
        self.assertEqual(original["btc_index_price"], self.cache._snapshot["btc_index_price"])
        self.assertEqual(original["index_updated_at"], self.cache._snapshot["index_updated_at"])
        self.assertTrue(self.cache.apply_stream_message({"e": "indexPrice", "E": self.now,
            "s": "BTCUSDT", "p": "81000"}))
        self.assertEqual("81000", self.cache._snapshot["btc_index_price"])

    def test_invalid_index_or_expired_contract_never_gets_new_receipt(self):
        before = copy.deepcopy(self.cache._snapshot)
        for value in ("0", "-1", "NaN", None, True):
            self.apply_index({"ok": True, "http_status": 200, "data": {"indexPrice": value}})
            self.assertEqual(before["btc_index_price"], self.cache._snapshot["btc_index_price"])
            self.assertEqual(before["index_updated_at"], self.cache._snapshot["index_updated_at"])
        self.row()["expiry_ms"] = self.now - 1000
        before_row = copy.deepcopy(self.row())
        self.apply_depth()
        self.assertEqual(before_row, self.row())

    def test_accepted_ws_quote_supersedes_rest_projection_immediately(self):
        self.apply_depth()
        self.now += 100
        self.assertTrue(self.cache.apply_stream_message({"e": "bookTicker", "E": self.now,
            "u": 1001, "s": self.symbol, "b": "61", "a": "65", "B": "0.4", "A": "0.5"}))
        row = self.view()
        self.assertEqual("61", row["bid_price"])
        self.assertEqual("0.4", row["bid_quantity"])
        self.assertEqual("websocket", row["field_source"]["bid_quantity"])
        self.assertNotIn(self.symbol, self.cache._focused_books)

    def test_disconnected_rest_book_has_no_heartbeat_or_infinite_freshness_certificate(self):
        self.apply_depth()
        original = self.view()["field_updated_at"]["bid_quantity"]
        self.now += 31000
        row = self.view()
        self.assertEqual(original, row["field_updated_at"]["bid_quantity"])
        self.assertIsNone(row.get("quote_verification"))
        self.assertIsNone(row.get("quote_verified_at"))

    def test_pending_socket_book_dispatch_cannot_extend_quiet_book_certificate(self):
        self.cache.stream_state("book-0", {"connected": True, "subscription_confirmed": True,
            "generation": 1, "symbols": [self.symbol], "heartbeat_at": self.now,
            "heartbeat_kind": "pong", "diagnostics": {"queue_pending": 0}})
        self.now += 1
        self.assertTrue(self.cache.apply_stream_message({"data": {"e": "bookTicker", "E": self.now,
            "u": 1001, "s": self.symbol, "b": "61", "a": "65", "B": "0.4", "A": "0.5"},
            "_transport": {"connection": "book-0", "generation": 1}}))
        self.assertIsNotNone(self.view().get("quote_verification"))
        self.cache._stream_states["book-0"]["diagnostics"]["queue_pending"] = 1
        self.assertIsNone(self.view().get("quote_verification"))
        self.cache._stream_states["book-0"]["diagnostics"]["queue_pending"] = 0
        self.assertIsNotNone(self.view().get("quote_verification"))

    def test_failure_and_late_stopped_results_keep_original_snapshot(self):
        before = copy.deepcopy(self.cache._snapshot)
        self.apply_depth({"ok": False, "error": {"type": "READ_TIMEOUT"}})
        self.assertEqual(before, self.cache._snapshot)
        self.cache.stop()
        self.apply_depth()
        self.apply_index()
        self.assertEqual(before, self.cache._snapshot)

    def wait_idle(self):
        deadline = time.monotonic() + 3
        while self.cache._focused_refreshing and time.monotonic() < deadline:
            threading.Event().wait(.002)
        self.assertFalse(self.cache._focused_refreshing, "focused recovery did not release single-flight")

    def age_observations(self):
        self.cache._snapshot["index_updated_at"] = self.now - 60000
        for row in self.cache._rows_by_symbol.values():
            for field in QUOTE_FIELDS:
                row["field_updated_at"][field] = self.now - 60000

    def public_response(self, path, timeout, params=None, **kwargs):
        if path.endswith("/depth"):
            return self.depth()
        if path.endswith("/index"):
            return {"ok": True, "http_status": 200, "data": {"indexPrice": "80500", "time": self.now}}
        raise AssertionError("Focused recovery must use small public depth/index responses")

    def test_snapshot_reads_and_sse_reads_never_fetch_upstream(self):
        self.age_observations()
        with patch.object(server, "get_public", side_effect=AssertionError("read must not fetch")) as request, \
                patch.object(focused, "get_public", side_effect=AssertionError("read must not fetch")) as focused_request:
            self.cache.read()
            self.cache.wait_snapshot(-1, timeout=0)
        request.assert_not_called()
        focused_request.assert_not_called()

    def test_multiple_callers_share_one_small_single_flight_worker(self):
        self.age_observations()
        started, release = threading.Event(), threading.Event()

        def fetch(*args, **kwargs):
            started.set()
            release.wait(2)
            return self.public_response(*args, **kwargs)

        with patch.object(focused, "get_public", side_effect=fetch) as request:
            try:
                self.assertTrue(self.cache.request_focused_refresh())
                self.assertTrue(started.wait(1))
                for _ in range(8):
                    self.assertFalse(self.cache.request_focused_refresh())
                release.set()
                self.wait_idle()
            finally:
                release.set()
        self.assertGreaterEqual(request.call_count, 1)
        self.assertLessEqual(request.call_count, 2)  # one symbol + one shared index
        for args, kwargs in request.call_args_list:
            self.assertIn(args[0], ("/eapi/v1/depth", "/eapi/v1/index"))
            self.assertEqual(6, kwargs.get("timeout", args[1] if len(args) > 1 else None))
            self.assertEqual(1, kwargs.get("max_attempts"))

    def test_local_weight_ceiling_prevents_upstream_even_with_many_watchers(self):
        self.age_observations()
        self.cache._focused_attempts.extend([(self.now / 1000, 1)] * 80)
        with patch.object(focused, "get_public") as request:
            self.assertFalse(self.cache.request_focused_refresh())
        request.assert_not_called()

    def test_large_strategy_chain_has_bounded_depth_fanout_and_one_shared_index(self):
        self.cache._snapshot = recovery_snapshot(12, extras=True)
        self.cache._rows_by_symbol = {row["symbol"]: row for row in self.cache._snapshot["options"]}
        self.age_observations()
        with patch.object(focused, "get_public", side_effect=self.public_response) as request:
            self.assertTrue(self.cache.request_focused_refresh())
            self.wait_idle()
        depth_symbols = []
        index_count = 0
        for args, kwargs in request.call_args_list:
            params = kwargs.get("params", args[2] if len(args) > 2 else {})
            if args[0].endswith("/depth"):
                depth_symbols.append(params["symbol"])
            elif args[0].endswith("/index"):
                index_count += 1
        self.assertEqual(4, len(depth_symbols))
        self.assertEqual(4, len(set(depth_symbols)))
        self.assertEqual(1, index_count)
        self.assertTrue(all(symbol.endswith("-P") and int(symbol.split("-")[2]) < 62000 for symbol in depth_symbols))

    def test_rate_limit_cools_down_depth_and_index_as_one_group(self):
        self.age_observations()
        limited = {"ok": False, "http_status": 429, "rate_limited": True,
                   "retry_after": "90", "error": {"type": "HTTP_ERROR"}}
        with patch.object(focused, "get_public", return_value=limited) as request:
            self.assertTrue(self.cache.request_focused_refresh())
            self.wait_idle()
            call_count = request.call_count
            self.assertFalse(self.cache.request_focused_refresh())
            self.assertEqual(call_count, request.call_count)
        self.assertGreaterEqual(self.cache._focused_blocked_until - self.now / 1000, 89)


if __name__ == "__main__":
    unittest.main()
