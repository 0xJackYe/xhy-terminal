"""Compact read-only telemetry without copying the complete options chain."""
import copy
import http.client
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import dashboard_server as server
import focused_market_recovery as focused
from btc_terminal_server import TerminalServer
from test_mark_fallback import recovery_snapshot


class FocusedMarketReadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cache = server.MarketCache(self.directory.name, websocket_factory=None)
        self.cache._snapshot = recovery_snapshot(100)
        self.cache._rows_by_symbol = {row["symbol"]: row for row in self.cache._snapshot["options"]}
        self.symbols = list(self.cache._rows_by_symbol)

    def tearDown(self):
        self.cache.stop()
        self.directory.cleanup()

    def test_selects_only_requested_rows_and_returns_compact_model_metadata(self):
        selected = [self.symbols[2], self.symbols[0]]
        payload = self.cache.read_focused(selected)
        self.assertEqual(selected, [row["symbol"] for row in payload["options"]])
        keys = ("btc_index_price", "index_updated_at", "index_event_ms", "index_source",
                "catalog_updated_at", "exchange_clock_offset_ms", "fetched_at", "source")
        for key in keys:
            self.assertEqual(self.cache._snapshot.get(key), payload[key])
        self.assertEqual(self.cache._revision, payload["revision"])
        self.assertEqual(self.cache._instance_id, payload["instance_id"])
        self.assertLess(abs(payload["server_now_ms"] - int(time.time() * 1000)), 1000)
        for key in ("endpoints", "realtime", "data_health", "connection_details"):
            self.assertNotIn(key, payload)
        compact_size = len(json.dumps(payload))
        full_size = len(json.dumps(self.cache.read()))
        self.assertLess(compact_size, 15000)
        self.assertLess(compact_size * 15, full_size)

    def test_request_order_and_duplicate_symbols_are_stable(self):
        selected = [self.symbols[2], self.symbols[0], self.symbols[2]]
        result = self.cache.read_focused(selected)
        self.assertEqual([self.symbols[2], self.symbols[0]], [row["symbol"] for row in result["options"]])

    def test_selected_recovery_status_excludes_unrelated_contracts(self):
        first, other = self.symbols[:2]
        self.cache._mark_status = {first: {"state": "recovering"}, other: {"state": "recovered"}}
        self.cache._focused_status = {"depth:" + first: {"state": "recovering"},
            "depth:" + other: {"state": "recovered"}, "index:BTCUSDT": {"state": "recovered"}}
        result = self.cache.read_focused([first])
        self.assertEqual({first}, set(result["mark_recovery"]["contracts"]))
        self.assertEqual({"depth:" + first, "index:BTCUSDT"}, set(result["market_recovery"]["contracts"]))

    def test_nested_rows_and_recovery_status_are_isolated_copies(self):
        symbol = self.symbols[0]
        row = self.cache._rows_by_symbol[symbol]
        row["extension"] = {"items": ["original"]}
        self.cache._mark_status[symbol] = {"details": {"count": 1}}
        self.cache._focused_status["depth:" + symbol] = {"details": {"count": 2}}
        before = copy.deepcopy(self.cache._snapshot)
        result = self.cache.read_focused([symbol])
        result["options"][0]["extension"]["items"].append("modified")
        result["options"][0]["field_updated_at"]["bid_price"] = 1
        result["mark_recovery"]["contracts"][symbol]["details"]["count"] = 3
        result["market_recovery"]["contracts"]["depth:" + symbol]["details"]["count"] = 4
        self.assertEqual(before, self.cache._snapshot)
        self.assertEqual(1, self.cache._mark_status[symbol]["details"]["count"])
        self.assertEqual(2, self.cache._focused_status["depth:" + symbol]["details"]["count"])

    def test_invalid_or_expired_symbols_are_rejected_without_mutation(self):
        original = copy.deepcopy(self.cache._snapshot)
        invalid = (None, "BTC-any", [], self.symbols[:9], [self.symbols[0], 1],
                   ["BTC-UNKNOWN"], ["ETH-991231-2000-P"], [" " + self.symbols[0]])
        for symbols in invalid:
            with self.subTest(symbols=symbols):
                with self.assertRaises(ValueError):
                    self.cache.read_focused(symbols)
        self.assertEqual(original, self.cache._snapshot)
        self.cache._rows_by_symbol[self.symbols[0]]["expiry_ms"] = int(time.time() * 1000) - 1
        with self.assertRaises(ValueError):
            self.cache.read_focused([self.symbols[0]])

    def test_read_never_fetches_renews_watch_or_walks_full_snapshot(self):
        self.cache._mark_watch[self.symbols[0]] = {"until": time.time() + 10, "priority": 0}
        before = copy.deepcopy(self.cache._mark_watch)
        original_revision = self.cache._revision
        with patch.object(server, "get_public", side_effect=AssertionError("network on read")), \
                patch.object(focused, "get_public", side_effect=AssertionError("network on read")), \
                patch.object(self.cache, "watch_marks", side_effect=AssertionError("lease on read")), \
                patch.object(self.cache, "_read_locked", side_effect=AssertionError("whole chain copied")), \
                patch.object(self.cache, "_active_rows_locked", side_effect=AssertionError("whole chain walked")), \
                patch.object(self.cache, "request_refresh", side_effect=AssertionError("refresh on read")), \
                patch.object(self.cache, "request_mark_refresh", side_effect=AssertionError("refresh on read")), \
                patch.object(self.cache, "request_focused_refresh", side_effect=AssertionError("refresh on read")):
            self.assertEqual(1, len(self.cache.read_focused([self.symbols[0]])["options"]))
        self.assertEqual(before, self.cache._mark_watch)
        self.assertEqual(original_revision, self.cache._revision)

    def test_coherent_ws_certificate_and_original_receipts_match_main_view(self):
        symbol = self.symbols[0]
        now = int(time.time() * 1000)
        self.cache.stream_state("book-0", {"connected": True, "subscription_confirmed": True,
            "generation": 1, "symbols": [symbol], "heartbeat_at": now, "heartbeat_kind": "pong"})
        self.cache.apply_stream_message({"data": {"e": "bookTicker", "E": now,
            "u": 1000, "s": symbol, "b": "60", "a": "64", "B": "0.2", "A": "0.3"},
            "_transport": {"connection": "book-0", "generation": 1}})
        with self.cache._lock:
            expected = copy.deepcopy(self.cache._quote_view_locked(self.cache._rows_by_symbol[symbol], now))
        actual = self.cache.read_focused([symbol])["options"][0]
        for key in ("bid_price", "ask_price", "bid_quantity", "ask_quantity", "quote_verification",
                    "quote_verified_at", "field_updated_at", "field_source", "field_event_ms"):
            self.assertEqual(expected[key], actual[key])
        self.assertIsNotNone(actual["quote_verification"])


class FocusedMarketRoutesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.cache = server.MarketCache(cls.directory.name, websocket_factory=None)
        cls.cache._snapshot = recovery_snapshot(3)
        cls.cache._rows_by_symbol = {row["symbol"]: row for row in cls.cache._snapshot["options"]}
        cls.symbols = list(cls.cache._rows_by_symbol)
        cls.servers = [server.DashboardServer(("127.0.0.1", 0), cls.cache, Path(__file__).parent / "dashboard" / "dist"),
                       TerminalServer(("127.0.0.1", 0), None, None, cls.cache)]
        cls.threads = [threading.Thread(target=item.serve_forever, daemon=True) for item in cls.servers]
        for thread in cls.threads:
            thread.start()

    @classmethod
    def tearDownClass(cls):
        for item in cls.servers:
            item.shutdown()
            item.server_close()
        for thread in cls.threads:
            thread.join(2)
        cls.cache.stop()
        cls.directory.cleanup()

    def call(self, item, query, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", item.server_port, timeout=3)
        try:
            connection.request("GET", "/api/focused-market" + query, headers=headers or {})
            response = connection.getresponse()
            return response.status, response.getheader("Cache-Control"), json.loads(response.read())
        finally:
            connection.close()

    def test_both_entry_points_return_compact_uncached_requested_rows(self):
        selected = list(reversed(self.symbols[:2]))
        for item in self.servers:
            with self.subTest(server=type(item).__name__):
                status, cache_control, payload = self.call(item, "?symbols=" + "%2C".join(selected))
                self.assertEqual(200, status)
                self.assertEqual("no-store", cache_control)
                self.assertEqual(selected, [row["symbol"] for row in payload["options"]])
                self.assertNotIn("endpoints", payload)
                self.assertNotIn("realtime", payload)

    def test_unknown_empty_extra_and_duplicate_query_parameters_are_client_errors(self):
        queries = ("", "?symbols=", "?symbols=,", "?symbols=" + self.symbols[0] + ",",
                   "?symbols=" + ",".join([self.symbols[0]] * 9), "?symbols=BTC-UNKNOWN",
                   "?symbols=" + self.symbols[0] + "&symbols=" + self.symbols[1],
                   "?symbols=" + self.symbols[0] + "&refresh=1", "?other=x")
        for item in self.servers:
            for query in queries:
                with self.subTest(server=type(item).__name__, query=query):
                    self.assertEqual(400, self.call(item, query)[0])

    def test_missing_cache_returns_unavailable_on_both_entry_points(self):
        for item in self.servers:
            original = item.cache
            try:
                item.cache = None
                self.assertEqual(503, self.call(item, "?symbols=" + self.symbols[0])[0])
            finally:
                item.cache = original

    def test_untrusted_hosts_cannot_read_compact_telemetry(self):
        for item in self.servers:
            self.assertEqual(403, self.call(item, "?symbols=" + self.symbols[0], {"Host": "untrusted.example"})[0])

    def test_http_read_never_triggers_upstream_or_renews_watch(self):
        before = copy.deepcopy(self.cache._mark_watch)
        with patch.object(server, "get_public", side_effect=AssertionError("network on read")), \
                patch.object(focused, "get_public", side_effect=AssertionError("network on read")), \
                patch.object(self.cache, "watch_marks", side_effect=AssertionError("lease on read")):
            for item in self.servers:
                self.assertEqual(200, self.call(item, "?symbols=" + self.symbols[0])[0])
        self.assertEqual(before, self.cache._mark_watch)


if __name__ == "__main__":
    unittest.main()
