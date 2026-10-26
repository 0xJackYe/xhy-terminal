"""Both option sides share bounded public recovery, with deterministic fairness."""
import copy
import tempfile
import time
import unittest
from unittest.mock import patch

import dashboard_server as server
import focused_market_recovery as focused
from test_mark_fallback import CORE, mark_record, recovery_snapshot


class SymmetricCallRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cache = server.MarketCache(self.directory.name, websocket_factory=None)
        self.now = int(time.time() * 1000)
        self.base = recovery_snapshot()
        self.template = copy.deepcopy(self.base["options"][0])
        self.serial = 0
        self.clock = patch("dashboard_server.time.time", side_effect=lambda: self.now / 1000)
        self.clock.start()
        self.no_mark_network = patch.object(server, "get_public", side_effect=AssertionError("unmocked mark network"))
        self.no_book_network = patch.object(focused, "get_public", side_effect=AssertionError("unmocked book network"))
        self.no_mark_network.start()
        self.no_book_network.start()

    def tearDown(self):
        self.cache.stop()
        self.no_mark_network.stop()
        self.no_book_network.stop()
        self.clock.stop()
        self.directory.cleanup()

    def row(self, side, strike, days=15, **extra):
        self.serial += 1
        result = copy.deepcopy(self.template)
        result.update(symbol="BTC-%06d-%s-%s" % (990000 + self.serial, strike, "P" if side == "PUT" else "C"),
                      side=side, strike_price=str(strike), expiry_ms=self.now + round(days * 86400000))
        for field in result["field_updated_at"]:
            result["field_updated_at"][field] = self.now - 60000
        result.update(extra)
        return result

    def install(self, rows):
        self.cache._snapshot = copy.deepcopy(self.base)
        self.cache._snapshot["options"] = rows
        self.cache._snapshot["index_updated_at"] = self.now
        self.cache._rows_by_symbol = {row["symbol"]: row for row in rows}

    def many(self, put_count=20, call_count=20):
        rows = [self.row("PUT", 60000 + 100 * index) for index in range(put_count)]
        rows += [self.row("CALL", 96000 + 100 * index) for index in range(call_count)]
        self.install(rows)
        return rows

    def marks(self):
        return self.cache._mark_candidates_locked(self.now / 1000)

    def books(self):
        return self.cache._focused_symbols_locked(self.now / 1000)

    def sides(self, symbols):
        return [self.cache._rows_by_symbol[symbol]["side"] for symbol in symbols]

    def watch(self, symbols):
        with patch.object(self.cache, "request_mark_refresh", return_value=False), \
                patch.object(self.cache, "request_focused_refresh", return_value=False):
            return self.cache.watch_marks(symbols)

    def test_both_strike_and_day_boundaries_are_inclusive_and_outside_contracts_are_excluded(self):
        included = [self.row("PUT", 60000, 10), self.row("PUT", 64000, 20),
                    self.row("CALL", 96000, 10), self.row("CALL", 100000, 20)]
        excluded = [self.row("PUT", 59999), self.row("PUT", 64001), self.row("CALL", 95999),
                    self.row("CALL", 100001), self.row("CALL", 98000, 9.99), self.row("PUT", 62000, 20.01),
                    self.row("CALL", 98000, -1), self.row("PUT", 62000, 0)]
        self.install(included + excluded)
        expected = {row["symbol"] for row in included}
        self.assertEqual(expected, set(self.marks()))
        self.assertEqual(expected, set(self.books()))

    def test_default_protection_alternates_sides_and_is_independent_of_directory_order(self):
        rows = self.many()
        marks, books = self.marks(), self.books()
        self.assertEqual(["PUT", "CALL"] * 8, self.sides(books))
        self.assertEqual(["PUT", "CALL"] * 20, self.sides(marks))
        self.assertEqual(16, len(books))
        self.install(list(reversed(rows)))
        self.assertEqual(marks, self.marks())
        self.assertEqual(books, self.books())

    def test_a_missing_or_short_side_leaves_slots_to_the_other_side(self):
        for puts, calls, expected in ((20, 0, {"PUT": 16, "CALL": 0}),
                                      (0, 20, {"PUT": 0, "CALL": 16}),
                                      (2, 20, {"PUT": 2, "CALL": 14}),
                                      (20, 2, {"PUT": 14, "CALL": 2})):
            with self.subTest(puts=puts, calls=calls):
                self.many(puts, calls)
                books, marks = self.sides(self.books()), self.sides(self.marks()[:16])
                self.assertEqual(expected, {side: books.count(side) for side in ("PUT", "CALL")})
                self.assertEqual(expected, {side: marks.count(side) for side in ("PUT", "CALL")})

    def test_explicit_watches_come_first_even_outside_the_default_strategy(self):
        rows = self.many()
        watched = [self.row("CALL", 120000, 3), self.row("PUT", 70000, 4)]
        self.install(rows + watched)
        ordered = [row["symbol"] for row in reversed(watched)]
        self.assertEqual(ordered, self.watch(ordered))
        self.assertEqual(ordered, self.books()[:2])
        self.assertEqual(ordered, self.marks()[:2])
        self.assertEqual(["PUT", "CALL"] * 7, self.sides(self.books()[2:]))
        self.assertEqual(16, len(self.books()))

    def test_sixteen_explicit_watches_fill_the_existing_cap_without_an_extra_side_pool(self):
        rows = self.many()
        watched = [self.row("CALL", 120000 + index * 100, 3) for index in range(16)]
        self.install(rows + watched)
        symbols = [row["symbol"] for row in watched]
        self.watch(symbols[:8])
        self.now += 1
        self.watch(symbols[8:])
        self.assertEqual(16, len(self.cache._mark_watch))
        self.assertEqual(set(symbols), set(self.books()))
        self.assertEqual(set(symbols), set(self.marks()[:16]))
        self.assertEqual(16, len(self.books()))

    def test_mark_freshness_and_backoff_are_applied_before_filling_the_balanced_batch(self):
        rows = self.many(4, 4)
        for row in rows[:4]:
            for field in CORE:
                row["field_updated_at"][field] = self.now
        self.cache._mark_retry_at[rows[4]["symbol"]] = self.now / 1000 + 10
        selected = self.marks()
        self.assertEqual(["CALL"] * 3, self.sides(selected))
        self.assertNotIn(rows[4]["symbol"], selected)
        self.now += 11000
        self.assertEqual(["PUT", "CALL"] * 4, self.sides(self.marks()))

    def test_single_side_put_priority_stays_the_same_as_before(self):
        rows = [self.row("PUT", 60000, 16), self.row("PUT", 61000, 15),
                self.row("PUT", 62000, 15), self.row("PUT", 63000, 14)]
        self.install(list(reversed(rows)))
        expected = [row["symbol"] for row in sorted(rows, key=lambda row:
            (abs((row["expiry_ms"] - self.now) / 86400000 - 15), row["symbol"]))]
        self.assertEqual(expected, self.books())
        self.assertEqual(expected, self.marks())

    def test_call_and_put_marks_share_one_bulk_request_and_the_same_five_weight_charge(self):
        rows = self.many()
        with patch("dashboard_server.threading.Thread") as worker:
            self.assertTrue(self.cache.request_mark_refresh())
            symbols, bulk = worker.call_args.kwargs["args"]
        self.assertTrue(bulk)
        self.assertEqual(16, len(symbols))
        self.assertEqual(["PUT", "CALL"] * 8, self.sides(symbols))
        self.assertEqual(5, sum(cost for _, cost in self.cache._mark_attempts))
        response = {"ok": True, "http_status": 200,
                    "data": [mark_record(row["symbol"]) for row in rows]}
        with patch.object(server, "get_public", return_value=response) as request:
            self.cache._refresh_marks(symbols, bulk)
        self.assertEqual(1, request.call_count)
        self.assertIsNone(request.call_args.args[2])
        self.assertEqual(1, request.call_args.kwargs["max_attempts"])
        self.assertFalse(self.cache._mark_refreshing)
        self.assertTrue(all(self.cache._rows_by_symbol[symbol]["mark_price"] == "55" for symbol in symbols))

    def test_depth_repair_still_uses_one_four_book_batch_and_one_shared_budget(self):
        self.many()
        with patch("focused_market_recovery.threading.Thread") as worker:
            self.assertTrue(self.cache.request_focused_refresh())
            tasks = worker.call_args.kwargs["args"][0]
        self.assertEqual(4, len(tasks))
        self.assertEqual(["PUT", "CALL"] * 2, self.sides([symbol for kind, symbol in tasks]))
        self.assertTrue(all(kind == "depth" for kind, _ in tasks))
        self.assertEqual(4, sum(cost for _, cost in self.cache._focused_attempts))
        self.assertFalse(self.cache.request_focused_refresh())  # same shared single-flight
        self.cache._focused_refreshing = False
        self.cache._focused_attempts.clear()
        self.cache._focused_attempts.append((self.now / 1000, 80))
        with patch("focused_market_recovery.threading.Thread") as worker:
            self.assertFalse(self.cache.request_focused_refresh())
            worker.assert_not_called()

    def test_watched_call_receives_a_complete_atomic_depth_without_refreshing_unrelated_marks(self):
        rows = self.many(0, 1)
        symbol = rows[0]["symbol"]
        before = copy.deepcopy(rows[0])
        self.watch([symbol])
        self.cache._apply_focused_result(("depth", symbol, self.now - 100, self.now,
            {"ok": True, "http_status": 200, "data": {"bids": [["50", ".2"]], "asks": [["54", ".3"]],
             "T": self.now, "lastUpdateId": 100}}))
        result = self.cache.read_focused([symbol])["options"][0]
        self.assertEqual("CALL", result["side"])
        for field, value in zip(focused.BOOK_FIELDS, ("50", "54", ".2", ".3")):
            self.assertEqual(value, result[field])
            self.assertEqual(self.now, result["field_updated_at"][field])
        self.assertTrue(result["quote_group_valid"])
        for field in CORE:
            self.assertEqual(before[field], result[field])
            self.assertEqual(before["field_updated_at"][field], result["field_updated_at"][field])


if __name__ == "__main__":
    unittest.main()
