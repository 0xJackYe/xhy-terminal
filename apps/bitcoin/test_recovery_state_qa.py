"""Current data availability must not be masked by an old REST recovery error."""
import copy
import tempfile
import time
import unittest
from unittest.mock import patch

from dashboard_server import MarketCache
from test_mark_fallback import recovery_snapshot


class RecoveryStateQATests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cache = MarketCache(self.directory.name, websocket_factory=None)
        self.cache._snapshot = recovery_snapshot()
        self.cache._rows_by_symbol = {row["symbol"]: row for row in self.cache._snapshot["options"]}
        self.symbol = next(iter(self.cache._rows_by_symbol))
        self.now = int(time.time() * 1000)
        self.clock = patch("dashboard_server.time.time", side_effect=lambda: self.now / 1000)
        self.clock.start()
        self.error = {"state": "recovering", "error": "old transport failure", "retry_after_seconds": 30,
                      "last_success_at": self.now - 3600000, "last_attempt_at": self.now - 3500000}
        self.cache._focused_status = {"depth:" + self.symbol: copy.deepcopy(self.error),
                                      "index:BTCUSDT": copy.deepcopy(self.error)}
        self.cache._mark_status = {self.symbol: copy.deepcopy(self.error)}

    def tearDown(self):
        self.clock.stop()
        self.cache.stop()
        self.directory.cleanup()

    def recover_stream(self, partial=False):
        mark = {"e": "markPrice", "E": self.now, "s": self.symbol, "mp": "55", "i": "81000"}
        if not partial:
            mark.update(vo="0.6", d="-0.1", g="0.001", t="-5", v="2")
        self.cache.apply_stream_message(mark)
        self.cache.apply_stream_message({"e": "bookTicker", "E": self.now, "s": self.symbol,
            "u": self.now, "b": "54", "a": "56", **({} if partial else {"B": "0.1", "A": "0.2"})})

    def focused(self):
        return self.cache.read_focused([self.symbol])

    def test_live_book_index_and_mark_supersede_old_recovery_errors_without_faking_http_success(self):
        self.recover_stream()
        result = self.focused()
        statuses = list(result["market_recovery"]["contracts"].values()) + list(result["mark_recovery"]["contracts"].values())
        for status in statuses:
            self.assertEqual("live", status["state"])
            self.assertIsNone(status["error"])
            self.assertNotIn("retry_after_seconds", status)
            self.assertEqual(self.error["last_success_at"], status["last_success_at"])
            self.assertEqual(self.error["last_attempt_at"], status["last_attempt_at"])
        self.assertIsNone(self.cache.read()["mark_recovery"]["contracts"][self.symbol]["error"])
        # Projection is isolated: raw HTTP diagnostics remain historical facts.
        self.assertEqual(self.error, self.cache._mark_status[self.symbol])

    def test_partial_ws_does_not_hide_an_unrecovered_depth_or_mark_group(self):
        self.recover_stream(partial=True)
        result = self.focused()
        self.assertEqual("recovering", result["market_recovery"]["contracts"]["depth:" + self.symbol]["state"])
        self.assertEqual("recovering", result["mark_recovery"]["contracts"][self.symbol]["state"])
        self.assertIsNone(result["market_recovery"]["contracts"]["index:BTCUSDT"]["error"])

    def test_live_override_expires_with_the_actual_observation(self):
        self.recover_stream()
        self.now += 21000
        result = self.focused()
        statuses = list(result["market_recovery"]["contracts"].values()) + list(result["mark_recovery"]["contracts"].values())
        self.assertTrue(all(status["state"] == "recovering" for status in statuses))
        self.assertTrue(all(status["error"] for status in statuses))

    def test_late_http_failure_does_not_mask_a_new_complete_ws_recovery(self):
        self.recover_stream()
        self.cache._apply_focused_result(("depth", self.symbol, self.now - 50, self.now,
            {"ok": False, "http_status": 502}))
        self.cache._apply_mark_result((self.symbol, self.now - 50, self.now,
            {"ok": False, "http_status": 502}))
        result = self.focused()
        self.assertIsNone(result["market_recovery"]["contracts"]["depth:" + self.symbol]["error"])
        self.assertIsNone(result["mark_recovery"]["contracts"][self.symbol]["error"])


if __name__ == "__main__":
    unittest.main()
