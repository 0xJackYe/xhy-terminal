"""Adversarial public-feed checks: invalid events cannot poison later recovery."""
import copy
import tempfile
import time
import unittest
from unittest.mock import patch

from dashboard_server import MarketCache
from realtime_market import BookTickerMailbox
from test_mark_fallback import recovery_snapshot


class PublicFeedIngressQATests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cache = MarketCache(self.directory.name, websocket_factory=None)
        self.cache._snapshot = recovery_snapshot()
        self.cache._rows_by_symbol = {row["symbol"]: row for row in self.cache._snapshot["options"]}
        self.symbol = next(iter(self.cache._rows_by_symbol))
        self.now = int(time.time() * 1000)
        self.clock = patch("dashboard_server.time.time", side_effect=lambda: self.now / 1000)
        self.clock.start()

    def tearDown(self):
        self.clock.stop()
        self.cache.stop()
        self.directory.cleanup()

    def messages(self, event_time):
        return [
            {"e": "indexPrice", "E": event_time, "s": "BTCUSDT", "p": "81000"},
            {"e": "markPrice", "E": event_time, "s": self.symbol, "mp": "55", "vo": "0.6", "i": "81000"},
            {"e": "bookTicker", "E": event_time, "s": self.symbol, "u": event_time,
             "b": "54", "a": "56", "B": "0.1", "A": "0.2"},
            {"e": "24hrTicker", "E": event_time, "s": self.symbol, "c": "55", "v": "3", "q": "165"},
            {"e": "trade", "E": event_time, "s": self.symbol, "T": event_time, "p": "55"},
        ]

    def test_future_events_cannot_change_any_field_or_poison_ordering_watermarks(self):
        for future, valid in zip(self.messages(self.now + 60000), self.messages(self.now)):
            with self.subTest(kind=future["e"]):
                before = copy.deepcopy(self.cache._snapshot)
                self.assertFalse(self.cache.apply_stream_message(future))
                self.assertEqual(before, self.cache._snapshot)
                self.assertTrue(self.cache.apply_stream_message(valid), "valid event after a bad event was discarded")

    def test_event_clock_tolerance_uses_the_verified_exchange_offset(self):
        self.cache._snapshot["exchange_clock_offset_ms"] = 30000
        self.assertTrue(self.cache.apply_stream_message(self.messages(self.now + 31000)[0]))
        before = copy.deepcopy(self.cache._snapshot)
        self.assertFalse(self.cache.apply_stream_message(self.messages(self.now + 33000)[0]))
        self.assertEqual(before, self.cache._snapshot)

    def test_small_clock_skew_is_allowed_but_future_trade_time_is_not(self):
        self.assertTrue(self.cache.apply_stream_message(self.messages(self.now + 1500)[0]))
        trade = self.messages(self.now)[-1]
        trade["T"] = self.now + 60000
        before = copy.deepcopy(self.cache._snapshot)
        self.assertFalse(self.cache.apply_stream_message(trade))
        self.assertEqual(before, self.cache._snapshot)

    def test_event_time_is_checked_against_wire_receipt_before_delayed_dispatch(self):
        received = self.now
        self.now += 60000
        event = self.messages(self.now)[2]
        self.cache.stream_state("book-0", {"connected": True, "generation": 1, "symbols": [self.symbol]})
        before = copy.deepcopy(self.cache._snapshot)
        self.assertFalse(self.cache.apply_stream_message({"data": event,
            "_transport": {"connection": "book-0", "generation": 1,
                           "received_at_by_symbol": {self.symbol: received}}}))
        self.assertEqual(before, self.cache._snapshot)

    def test_book_queue_rejects_future_frame_before_it_can_poison_its_own_watermark(self):
        batches = []
        mailbox = BookTickerMailbox([self.symbol], batches.append, {}, start=False)
        with self.assertRaisesRegex(ValueError, "FutureBookTicker"):
            mailbox.offer(self.messages(self.now + 60000)[2], self.now)
        mailbox.offer(self.messages(self.now)[2], self.now)
        self.assertEqual(1, mailbox.dispatch_once())
        self.assertEqual(self.now, batches[0]["data"][0]["E"])

    def test_book_queue_honors_the_same_calibrated_exchange_clock(self):
        offset = [30000]
        batches = []
        mailbox = BookTickerMailbox([self.symbol], batches.append, {}, start=False,
            exchange_clock_offset=lambda: offset[0])
        mailbox.offer(self.messages(self.now + 31000)[2], self.now)
        self.assertEqual(1, mailbox.dispatch_once())
        offset[0] = 35000
        mailbox.offer(self.messages(self.now + 36000)[2], self.now)
        self.assertEqual(1, mailbox.dispatch_once())

    def test_missing_sequence_never_erases_cache_protection_against_an_older_book(self):
        first = self.messages(self.now)[2]
        first["u"] = 100
        self.assertTrue(self.cache.apply_stream_message(first))
        without_sequence = dict(first, E=self.now + 1, u=None, b="53")
        self.assertTrue(self.cache.apply_stream_message(without_sequence))
        before = copy.deepcopy(self.cache._snapshot)
        self.assertFalse(self.cache.apply_stream_message(dict(first, E=self.now + 2, u=99, b="52")))
        self.assertEqual(before, self.cache._snapshot)


if __name__ == "__main__":
    unittest.main()
