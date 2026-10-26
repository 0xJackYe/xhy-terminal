"""Many watched contracts must share fallback work, not exhaust its budget."""
import copy
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from dashboard_server import MarketCache
from test_mark_fallback import CORE, mark_record, recovery_snapshot, wait_mark_idle


class MarkCapacityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cache = MarketCache(self.directory.name, websocket_factory=None)
        self.cache._snapshot = recovery_snapshot(16)
        self.cache._rows_by_symbol = {row["symbol"]: row for row in self.cache._snapshot["options"]}
        self.symbols = list(self.cache._rows_by_symbol)

    def tearDown(self):
        self.cache.stop()
        self.directory.cleanup()

    def test_sixteen_watches_keep_mark_iv_and_greeks_fresh_with_the_real_budget(self):
        now = [time.time()]
        began = now[0]
        for priority, symbol in enumerate(self.symbols):
            self.cache._mark_watch[symbol] = {"until": began + 300, "priority": priority}
        ages, reservations = [], []
        with patch("dashboard_server.time.time", side_effect=lambda: now[0]), \
                patch("dashboard_server.threading.Thread") as worker:
            for tick in range(180):
                now[0] = began + tick
                if self.cache.request_mark_refresh():
                    selected = worker.call_args.kwargs["args"][0]
                    request_at = int(now[0] * 1000)
                    # Each scheduled target is committed through the real
                    # unchanged-group validation; only transport is simulated.
                    now[0] += .01
                    received = int(now[0] * 1000)
                    for symbol in selected:
                        self.cache._apply_mark_result((symbol, request_at, received,
                            {"ok": True, "data": [mark_record(symbol)], "http_status": 200}))
                    reservations.append((now[0], sum(cost for _, cost in self.cache._mark_attempts)))
                    self.cache._mark_refreshing = False
                self.assertLessEqual(sum(cost for _, cost in self.cache._mark_attempts), 120)
                if tick >= 30:
                    ages.extend((now[0] * 1000 - row["field_updated_at"][field]) / 1000
                                for row in self.cache._rows_by_symbol.values() for field in CORE)
        self.assertLessEqual(max(ages), 30, "per-symbol fallback exhausted the budget and starved watched marks")
        self.assertTrue(reservations)

    def test_many_targets_share_one_public_response_and_only_update_selected_rows(self):
        before = copy.deepcopy(self.cache._snapshot)
        records = [mark_record(symbol) for symbol in self.symbols]
        records.append(mark_record("ETH-991231-4000-P"))
        with patch("dashboard_server.get_public", return_value={"ok": True, "data": records, "http_status": 200}) as fetch:
            self.assertTrue(self.cache.request_mark_refresh())
            wait_mark_idle(self.cache)
        self.assertEqual(fetch.call_count, 1)
        args, kwargs = fetch.call_args
        self.assertEqual(args[0], "/eapi/v1/mark")
        self.assertFalse(args[2] if len(args) > 2 else kwargs.get("params"))
        self.assertEqual(sum(cost for _, cost in self.cache._mark_attempts), 5)
        for symbol in self.symbols:
            self.assertEqual(self.cache._rows_by_symbol[symbol]["mark_price"], "55")
        self.assertNotIn("ETH-991231-4000-P", self.cache._rows_by_symbol)
        for key in ("fetched_at", "catalog_updated_at", "index_updated_at", "endpoints"):
            self.assertEqual(before[key], self.cache._snapshot[key])

    def test_incomplete_bulk_result_fails_only_the_missing_target_without_faking_its_time(self):
        missing = self.symbols[3]
        original = copy.deepcopy(self.cache._rows_by_symbol[missing])
        records = [mark_record(symbol) for symbol in self.symbols if symbol != missing]
        with patch("dashboard_server.get_public", return_value={"ok": True, "data": records, "http_status": 200}):
            self.assertTrue(self.cache.request_mark_refresh())
            wait_mark_idle(self.cache)
        self.assertEqual(self.cache._rows_by_symbol[missing], original)
        self.assertTrue(self.cache._mark_status[missing].get("error"))
        self.assertEqual(self.cache._rows_by_symbol[self.symbols[-1]]["mark_price"], "55")

    def test_bulk_response_preserves_a_concurrent_group_and_updates_other_targets(self):
        started, release = threading.Event(), threading.Event()
        def fetch(*args, **kwargs):
            started.set()
            release.wait(2)
            return {"ok": True, "data": [mark_record(symbol) for symbol in self.symbols], "http_status": 200}
        with patch("dashboard_server.get_public", side_effect=fetch) as transport:
            try:
                self.assertTrue(self.cache.request_mark_refresh())
                self.assertTrue(started.wait(1))
                row = self.cache._rows_by_symbol[self.symbols[4]]
                with self.cache._condition:
                    row["mark_iv"] = "0.99"
                    row["field_updated_at"]["mark_iv"] = int(time.time() * 1000) + 1
                    row["field_source"]["mark_iv"] = "websocket"
                    unchanged = copy.deepcopy(row)
                release.set()
                wait_mark_idle(self.cache)
            finally:
                release.set()
        self.assertEqual(transport.call_count, 1)
        self.assertEqual(row, unchanged)
        self.assertEqual(self.cache._rows_by_symbol[self.symbols[-1]]["mark_price"], "55")

    def test_rate_limited_bulk_response_sets_one_cooldown_and_preserves_all_fields(self):
        original = copy.deepcopy(self.cache._snapshot)
        with patch("dashboard_server.get_public", return_value={"ok": False, "http_status": 429,
                "rate_limited": True, "retry_after": "90"}) as transport:
            self.assertTrue(self.cache.request_mark_refresh())
            wait_mark_idle(self.cache)
            self.assertFalse(self.cache.request_mark_refresh())
        self.assertEqual(transport.call_count, 1)
        self.assertEqual(sum(cost for _, cost in self.cache._mark_attempts), 5)
        self.assertGreater(self.cache._mark_blocked_until - time.time(), 89)
        self.assertEqual(self.cache._snapshot, original)

    def test_ambiguous_bulk_contracts_do_not_refresh_any_target(self):
        original = copy.deepcopy(self.cache._snapshot)
        records = [mark_record(symbol) for symbol in self.symbols]
        records.append(mark_record(self.symbols[-1], "999"))
        with patch("dashboard_server.get_public", return_value={"ok": True, "data": records, "http_status": 200}):
            self.assertTrue(self.cache.request_mark_refresh())
            wait_mark_idle(self.cache)
        self.assertEqual(self.cache._snapshot, original)
        self.assertTrue(all(status.get("error") for status in self.cache._mark_status.values()))


if __name__ == "__main__":
    unittest.main()
