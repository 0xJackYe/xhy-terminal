"""Offline order-book health checks, including quantities and quiet-book proofs."""

import tempfile
import time
import unittest
from unittest.mock import patch

from dashboard_server import MarketCache
from test_dashboard_server import fixture_snapshot


BOOK_FIELDS = ("bid_price", "ask_price", "bid_quantity", "ask_quantity")


class QuoteHealthTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cache = MarketCache(self.directory.name, websocket_factory=None)
        self.cache._snapshot = fixture_snapshot()
        self.cache._snapshot["options"] = self.cache._snapshot["options"][:1]
        self.row = self.cache._snapshot["options"][0]
        self.symbol = self.row["symbol"]
        self.cache._rows_by_symbol = {self.symbol: self.row}
        self.now = int(time.time() * 1000)
        self.clock = patch("dashboard_server.time.time", return_value=self.now / 1000)
        self.clock.start()

    def tearDown(self):
        self.clock.stop()
        self.cache.stop()
        self.directory.cleanup()

    def set_book(self, source="rest", age_ms=0):
        for field, value in zip(BOOK_FIELDS, ("490", "510", "2", "3")):
            self.row[field] = value
            self.row["field_updated_at"][field] = self.now - age_ms
            self.row["field_event_ms"][field] = None
            self.row["field_source"][field] = source

    def health(self):
        return self.cache.read()["data_health"]["quote"]

    def connect(self, heartbeat=None):
        self.cache.stream_state("book-0", {
            "connected": True, "subscription_confirmed": True, "generation": 3,
            "symbols": [self.symbol], "heartbeat_kind": "pong",
            "heartbeat_at": self.now if heartbeat is None else heartbeat,
        })

    def quiet_book(self):
        old = self.now - 3600000
        with patch("dashboard_server.time.time", return_value=old / 1000):
            self.connect(heartbeat=old)
            self.cache.apply_stream_message({
                "_transport": {"connection": "book-0", "generation": 3},
                "data": {"e": "bookTicker", "E": old, "u": 7, "s": self.symbol,
                         "b": "490", "a": "510", "B": "2", "A": "3"},
            })
        self.connect()
        return old

    def test_recent_prices_without_quantities_are_partial(self):
        self.set_book()
        for field in ("bid_quantity", "ask_quantity"):
            self.row[field] = None
        health = self.health()
        self.assertEqual("partial", health["status"])
        self.assertEqual((2, 2, 2, 4), tuple(health[key] for key in (
            "available_fields", "fresh_fields", "missing_fields", "total_fields")))

    def test_fresh_prices_do_not_hide_stale_depth(self):
        self.set_book(source="websocket")
        for field in ("bid_quantity", "ask_quantity"):
            self.row["field_updated_at"][field] = self.now - 21000
        self.cache.stream_state("market", {"connected": True})
        health = self.health()
        self.assertEqual("partial", health["status"])
        self.assertEqual(2, health["fresh_fields"])
        self.assertEqual(0, health["missing_fields"])
        self.assertEqual(4, health["total_fields"])

    def test_complete_recent_rest_book_is_fresh_with_four_fields(self):
        self.set_book(age_ms=10000)
        health = self.health()
        self.assertEqual("fresh", health["status"])
        self.assertEqual("rest", health["source"])
        self.assertEqual((4, 4, 0, 4), tuple(health[key] for key in (
            "available_fields", "fresh_fields", "missing_fields", "total_fields")))
        self.assertEqual(0, health["verified_contracts"])

    def test_rest_prices_cannot_refresh_old_websocket_quantities(self):
        self.set_book(source="websocket", age_ms=120000)
        for field in ("bid_price", "ask_price"):
            self.row["field_updated_at"][field] = self.now
            self.row["field_source"][field] = "rest"
        health = self.health()
        self.assertEqual("partial", health["status"])
        self.assertEqual("mixed", health["source"])
        self.assertEqual(2, health["fresh_fields"])
        self.assertEqual(120, health["age_seconds"])

    def test_quiet_confirmed_book_proof_covers_all_four_without_changing_times(self):
        old = self.quiet_book()
        result = self.cache.read()
        health = result["data_health"]["quote"]
        self.assertEqual("live", health["status"])
        self.assertEqual(4, health["fresh_fields"])
        self.assertEqual(4, health["total_fields"])
        self.assertEqual(1, health["verified_contracts"])
        self.assertEqual(old, health["oldest_updated_at"])
        self.assertEqual(3600, health["age_seconds"])
        proof = result["options"][0]["quote_verification"]
        self.assertEqual(set(BOOK_FIELDS), set(proof["values"]))
        self.assertTrue(all(self.row["field_updated_at"][field] == old for field in BOOK_FIELDS))

    def test_future_depth_receipts_are_not_fresh(self):
        self.set_book(source="websocket")
        for field in ("bid_quantity", "ask_quantity"):
            self.row["field_updated_at"][field] = self.now + 60000
        self.cache.stream_state("market", {"connected": True})
        health = self.health()
        self.assertEqual("partial", health["status"])
        self.assertEqual(2, health["fresh_fields"])

    def test_future_heartbeat_cannot_certify_old_depth(self):
        self.quiet_book()
        self.connect(heartbeat=self.now + 60000)
        result = self.cache.read()
        health = result["data_health"]["quote"]
        self.assertIsNone(result["options"][0]["quote_verification"])
        self.assertEqual("stale", health["status"])
        self.assertEqual(0, health["fresh_fields"])
        self.assertEqual(0, health["verified_contracts"])


if __name__ == "__main__":
    unittest.main()
