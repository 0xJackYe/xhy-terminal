"""Offline stream ordering, precision, REST recovery, and rate-budget checks."""

import copy
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from dashboard_server import FULL_SNAPSHOT_WEIGHT, MarketCache, MarketFetchError
from realtime_market import (
    MARKET_URL, MAX_STREAMS, PUBLIC_URL, BookTickerMailbox, OptionsWebSocketHub, decimal_text, subscription_plan, preserve_concurrent_updates,
)
from test_dashboard_server import fixture_snapshot, wait_until_idle


class TextSocketAdapter:
    """Text-only transport fixtures; protocol heartbeat cases use recv_data directly."""
    def recv_data(self, control_frame=False):
        return 1, self.recv()

    def ping(self, payload):
        self.last_ping = payload


class BookMailboxTests(unittest.TestCase):
    symbols = ("BTC-991231-80000-C", "BTC-991231-81000-P")

    def book(self, symbol=None, stamp=1000, update=1, **extra):
        event = {"e": "bookTicker", "s": symbol or self.symbols[0], "E": stamp,
                 "u": update, "b": "1", "a": "2", "B": "3", "A": "4"}
        event.update(extra)
        return event

    def mailbox(self, callback, **kwargs):
        return BookTickerMailbox(self.symbols, callback,
            {"connection": "book-0", "generation": 7, "plan_generation": 3}, **kwargs)

    def test_latest_complete_books_coalesce_with_zero_values_and_original_receipts(self):
        batches = []
        mailbox = self.mailbox(batches.append, start=False)
        mailbox.offer(self.book(), 2000)
        mailbox.offer(self.book(stamp=1001, update=2, b="0", B="0"), 2001)
        mailbox.offer(self.book(self.symbols[1]), 1999)
        self.assertEqual(2, mailbox.dispatch_once())
        batch = batches[0]
        by_symbol = {event["s"]: event for event in batch["data"]}
        self.assertEqual(("0", "0"), (by_symbol[self.symbols[0]]["b"], by_symbol[self.symbols[0]]["B"]))
        self.assertEqual({self.symbols[0]: 2001, self.symbols[1]: 1999}, batch["_transport"]["received_at_by_symbol"])
        self.assertEqual((7, 3), (batch["_transport"]["generation"], batch["_transport"]["plan_generation"]))
        self.assertEqual(1, mailbox.diagnostics()["coalesced_frames"])

    def test_queue_and_watermarks_are_bounded_by_subscribed_symbols(self):
        mailbox = self.mailbox(lambda payload: None, start=False)
        for update in range(1, 2001):
            mailbox.offer(self.book(stamp=update, update=update), update)
            mailbox.offer(self.book(self.symbols[1], stamp=update, update=update), update)
            mailbox.offer(self.book("BTC-991231-%s-C" % update, stamp=update, update=update), update)
        self.assertEqual(2, mailbox.diagnostics()["queue_pending"])
        self.assertEqual(2, mailbox.diagnostics()["queue_capacity"])
        self.assertEqual(2, len(mailbox._watermarks))

    def test_event_and_sequence_watermarks_reject_reverse_and_duplicate_after_dispatch(self):
        batches = []
        mailbox = self.mailbox(batches.append, start=False)
        mailbox.offer(self.book(stamp=100, update=10), 500)
        mailbox.dispatch_once()
        mailbox.offer(self.book(stamp=101, update=9, b="99"), 501)
        mailbox.offer(self.book(stamp=99, update=11, b="98"), 502)
        mailbox.offer(self.book(stamp=100, update=10, b="97"), 503)
        self.assertEqual(0, mailbox.dispatch_once())
        mailbox.offer(self.book(stamp=101, update=11, b="0"), 504)
        self.assertEqual(1, mailbox.dispatch_once())
        self.assertEqual("0", batches[-1]["data"][0]["b"])

    def test_missing_sequence_cannot_erase_known_update_watermark(self):
        batches = []
        mailbox = self.mailbox(batches.append, start=False)
        mailbox.offer(self.book(stamp=100, update=10), 500)
        mailbox.offer(self.book(stamp=101, update=None), 501)
        mailbox.offer(self.book(stamp=102, update=9, b="99"), 502)
        mailbox.dispatch_once()
        self.assertEqual("1", batches[-1]["data"][0]["b"])
        self.assertEqual(501, batches[-1]["_transport"]["received_at_by_symbol"][self.symbols[0]])

    def test_partial_books_fail_closed_instead_of_hiding_changed_side(self):
        mailbox = self.mailbox(lambda payload: None, start=False)
        mailbox.offer(self.book(), 2000)
        with self.assertRaisesRegex(ValueError, "IncompleteBookTicker"):
            mailbox.offer(self.book(stamp=1001, update=2, b="0", B=None), 2001)

    def test_close_and_obsolete_generation_discard_pending_batches(self):
        batches, active = [], [True]
        mailbox = self.mailbox(batches.append, is_active=lambda: active[0], start=False)
        mailbox.offer(self.book(), 2000)
        active[0] = False
        self.assertEqual(0, mailbox.dispatch_once())
        mailbox.close()
        self.assertEqual(0, mailbox.diagnostics()["queue_pending"])
        active[0] = True
        mailbox.offer(self.book(stamp=1001, update=2), 2001)
        self.assertEqual(0, mailbox.dispatch_once())
        self.assertEqual([], batches)

    def test_slow_consumer_does_not_block_offer_and_pending_books_stay_bounded(self):
        started, release, latest = threading.Event(), threading.Event(), threading.Event()
        batches = []
        def consumer(batch):
            batches.append(batch)
            if len(batches) == 1:
                started.set()
                release.wait(2)
            else:
                latest.set()
        mailbox = self.mailbox(consumer)
        try:
            mailbox.offer(self.book(), 2000)
            self.assertTrue(started.wait(1))
            for update in range(2, 1002):
                mailbox.offer(self.book(stamp=1000 + update, update=update, b=str(update)), 2000 + update)
            self.assertFalse(release.is_set())
            self.assertEqual(1, mailbox.diagnostics()["queue_pending"])
            release.set()
            self.assertTrue(latest.wait(1))
            self.assertEqual("1001", batches[-1]["data"][0]["b"])
            self.assertEqual(3001, batches[-1]["_transport"]["received_at_by_symbol"][self.symbols[0]])
        finally:
            release.set()
            mailbox.close()
            mailbox._thread.join(1)

    def test_callback_failure_stops_worker_and_exposes_error(self):
        def fail(batch):
            raise RuntimeError("fixture callback failure")
        mailbox = self.mailbox(fail)
        mailbox.offer(self.book(), 2000)
        mailbox._thread.join(1)
        self.assertFalse(mailbox._thread.is_alive())
        self.assertEqual("RuntimeError", mailbox.diagnostics()["dispatch_error"])
        self.assertTrue(mailbox._cancelled.is_set())


class StreamTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cache = MarketCache(self.directory.name, collector=fixture_snapshot, websocket_factory=None)
        self.cache.request_refresh()
        wait_until_idle(self.cache)
        self.symbol = self.cache.read()["options"][0]["symbol"]
        self.now_ms = int(time.time() * 1000)

    def tearDown(self):
        self.cache.stop()
        self.directory.cleanup()

    def row(self):
        return next(row for row in self.cache.read()["options"] if row["symbol"] == self.symbol)

    def test_mark_updates_preserve_exchange_decimal_precision_and_ticker_age(self):
        before = self.row()
        stamp = self.cache.read()["fetched_at"]
        self.assertTrue(self.cache.apply_stream_message({"stream": "btcusdt@optionMarkPrice", "data": [{
            "e": "markPrice", "E": self.now_ms, "s": self.symbol,
            "mp": "123.456789012345678901", "bo": "120.000", "ao": "130.000",
            "vo": "0.50000001", "b": "0.48", "a": "0.52", "d": "-0.12345678",
            "g": "0.00000123", "t": "-12.34567890", "v": "9.87654321",
        }]}))
        row = self.row()
        self.assertEqual("123.456789012345678901", row["mark_price"])
        self.assertEqual("120.000", row["bid_price"])
        self.assertEqual("-0.12345678", row["delta"])
        self.assertEqual(self.now_ms, row["field_event_ms"]["delta"])
        self.assertEqual("websocket", row["field_source"]["delta"])
        self.assertEqual(before["ticker_updated_at"], row["ticker_updated_at"])
        self.assertEqual(before["volume_24h_contracts"], row["volume_24h_contracts"])
        self.assertEqual(stamp, self.cache.read()["fetched_at"])

    def test_out_of_order_book_and_mark_quote_do_not_roll_back_prices(self):
        self.cache.apply_stream_message({"e": "bookTicker", "E": self.now_ms + 100, "u": 10, "s": self.symbol, "b": "101.000", "a": "102.000"})
        self.cache.apply_stream_message({"e": "markPrice", "E": self.now_ms, "s": self.symbol, "mp": "100.123", "bo": "99.000", "ao": "100.000"})
        self.assertEqual("101.000", self.row()["bid_price"])
        self.assertEqual("100.123", self.row()["mark_price"])
        self.cache.apply_stream_message({"e": "bookTicker", "E": self.now_ms + 200, "u": 9, "s": self.symbol, "b": "98.000", "a": "99.000"})
        self.assertEqual("101.000", self.row()["bid_price"])

    def test_partial_message_does_not_refresh_missing_field_timestamp(self):
        before = self.row()
        self.cache.apply_stream_message({"e": "markPrice", "E": self.now_ms, "s": self.symbol, "mp": "499.123"})
        row = self.row()
        self.assertEqual(before["delta"], row["delta"])
        self.assertEqual(before["field_updated_at"]["delta"], row["field_updated_at"]["delta"])
        self.assertEqual("rest", row["field_source"]["delta"])
        self.assertEqual("websocket", row["field_source"]["mark_price"])

    def test_invalid_numbers_foreign_symbols_and_control_messages_are_ignored(self):
        before = self.row()
        for message in ({"result": None, "id": 1}, {"e": "markPrice", "E": self.now_ms, "s": "ETH-991231-80000-C", "mp": "10"},
                        {"e": "markPrice", "E": self.now_ms, "s": self.symbol, "mp": "NaN", "d": True}):
            self.assertFalse(self.cache.apply_stream_message(message))
        self.assertEqual(before, self.row())
        self.assertIsNone(self.cache.read()["realtime"]["last_message_at"])

    def test_ticker_fields_update_independently_and_statistics_close_is_not_trade_time(self):
        before = self.row()
        self.cache.apply_stream_message({"e": "24hrTicker", "E": self.now_ms, "C": self.now_ms,
                                         "s": self.symbol, "c": "511.000", "v": "12.34", "q": "631.254"})
        row = self.row()
        self.assertEqual("12.34", row["volume_24h_contracts"])
        self.assertIsNone(row["last_trade_beijing"])
        self.assertEqual(before["quote_updated_at"], row["quote_updated_at"])

    def test_rest_request_in_progress_cannot_overwrite_live_updates(self):
        release = threading.Event()
        started = threading.Event()
        def slow_rest():
            snapshot = fixture_snapshot()
            started.set()
            release.wait(2)
            return snapshot
        self.cache._collector = slow_rest
        self.cache._last_attempt = None
        self.cache.request_refresh()
        self.assertTrue(started.wait(1))
        time.sleep(0.002)
        self.cache.apply_stream_message({"e": "bookTicker", "E": self.now_ms + 100, "u": 12,
                                         "s": self.symbol, "b": "888.123456", "a": "889.999999"})
        release.set()
        wait_until_idle(self.cache)
        self.assertEqual("888.123456", self.row()["bid_price"])
        self.assertEqual("websocket", self.row()["field_source"]["bid_price"])

    def test_rest_preserves_book_watermark_for_events_before_request_started(self):
        self.cache.apply_stream_message({"e": "bookTicker", "E": self.now_ms + 100, "u": 10,
                                         "s": self.symbol, "b": "101.000", "a": "102.000"})
        previous = self.cache.read()
        replacement = fixture_snapshot()
        preserve_concurrent_updates(replacement, previous, int(time.time() * 1000) + 1000)
        self.cache._snapshot = replacement
        self.cache._rows_by_symbol = {row["symbol"]: row for row in replacement["options"]}
        self.assertEqual("490", self.row()["bid_price"])
        self.cache.apply_stream_message({"e": "bookTicker", "E": self.now_ms + 99, "u": 9,
                                         "s": self.symbol, "b": "99.000", "a": "100.000"})
        self.assertEqual("490", self.row()["bid_price"])
        self.assertEqual(10, self.row()["book_update_id"])

    def test_rest_merge_skips_unknown_field_times_without_losing_concurrent_ws(self):
        began = self.now_ms
        invalid_times = (None, True, "invalid", 0, -1, float("inf"), 253402300800000)
        for invalid in invalid_times:
            with self.subTest(received=invalid):
                previous = fixture_snapshot()
                old = previous["options"][0]
                old.update(bid_price="888.123456", gamma="999", bid_quantity=None)
                old["field_source"].update(bid_price="websocket", gamma="websocket", bid_quantity="unknown")
                old["field_updated_at"].update(bid_price=began + 1, gamma=invalid, bid_quantity=None)
                old["field_event_ms"].update(bid_price=began, gamma=None, bid_quantity=None)
                replacement = fixture_snapshot()
                row = replacement["options"][0]
                row.update(bid_quantity=None)
                row["field_updated_at"]["bid_quantity"] = None
                row["field_event_ms"]["bid_quantity"] = None
                row["field_source"]["bid_quantity"] = "unknown"
                rest_gamma = row["gamma"]
                preserve_concurrent_updates(replacement, previous, began)
                self.assertEqual("888.123456", row["bid_price"])
                self.assertEqual(began + 1, row["field_updated_at"]["bid_price"])
                self.assertEqual("websocket", row["field_source"]["bid_price"])
                self.assertEqual(rest_gamma, row["gamma"])
                self.assertEqual("rest", row["field_source"]["gamma"])
                self.assertIsNone(row["field_updated_at"]["bid_quantity"])
                self.assertEqual("unknown", row["field_source"]["bid_quantity"])

    def test_rest_merge_validates_index_receipt_without_fabricating_freshness(self):
        began = self.now_ms
        for invalid in (None, True, "invalid", 0, -1, float("inf")):
            with self.subTest(received=invalid):
                previous = fixture_snapshot()
                previous.update(btc_index_price="99999", index_source="websocket", index_updated_at=invalid,
                                index_event_ms="invalid", ws_index_watermark_ms="invalid")
                replacement = fixture_snapshot()
                expected = (replacement["btc_index_price"], replacement["index_updated_at"])
                preserve_concurrent_updates(replacement, previous, began)
                self.assertEqual(expected, (replacement["btc_index_price"], replacement["index_updated_at"]))
                self.assertEqual("rest", replacement["index_source"])
                self.assertIsNone(replacement["ws_index_watermark_ms"])
        previous.update(index_updated_at=str(began + 1), index_event_ms=began, ws_index_watermark_ms=began)
        preserve_concurrent_updates(replacement, previous, began)
        self.assertEqual("99999", replacement["btc_index_price"])
        self.assertEqual(began + 1, replacement["index_updated_at"])
        self.assertEqual("websocket", replacement["index_source"])

    def test_rest_omitted_depth_keeps_old_values_sources_and_original_age(self):
        previous = fixture_snapshot()
        old = previous["options"][0]
        received, event = self.now_ms - 60000, self.now_ms - 60010
        old.update(bid_quantity="0.23", ask_quantity="1.45")
        for field in ("bid_quantity", "ask_quantity"):
            old["field_updated_at"][field] = received
            old["field_event_ms"][field] = event
            old["field_source"][field] = "websocket"
        replacement = fixture_snapshot()
        row = replacement["options"][0]
        self.assertNotIn("bid_quantity", row)
        rest_price_time = row["field_updated_at"]["bid_price"]
        preserve_concurrent_updates(replacement, previous, self.now_ms)
        self.assertEqual("0.23", row["bid_quantity"])
        self.assertEqual("1.45", row["ask_quantity"])
        for field in ("bid_quantity", "ask_quantity"):
            self.assertEqual(received, row["field_updated_at"][field])
            self.assertEqual(event, row["field_event_ms"][field])
            self.assertEqual("websocket", row["field_source"][field])
        self.assertEqual("rest", row["field_source"]["bid_price"])
        self.assertEqual(rest_price_time, row["field_updated_at"]["bid_price"])
        self.assertEqual("mixed", row["quote_source"])

    def test_rest_explicit_depth_zero_or_new_value_replaces_preexisting_depth(self):
        previous = fixture_snapshot()
        old = previous["options"][0]
        for field in ("bid_quantity", "ask_quantity"):
            old[field] = "9.99"
            old["field_updated_at"][field] = self.now_ms - 1000
            old["field_event_ms"][field] = self.now_ms - 1010
            old["field_source"][field] = "websocket"
        for value in ("0", "1.25"):
            with self.subTest(value=value):
                replacement = fixture_snapshot()
                row = replacement["options"][0]
                for field in ("bid_quantity", "ask_quantity"):
                    row[field] = value
                    row["field_updated_at"][field] = self.now_ms + 1
                    row["field_event_ms"][field] = None
                    row["field_source"][field] = "rest"
                preserve_concurrent_updates(replacement, previous, self.now_ms)
                self.assertEqual(value, row["bid_quantity"])
                self.assertEqual(value, row["ask_quantity"])
                self.assertEqual("rest", row["field_source"]["bid_quantity"])
                self.assertEqual(self.now_ms + 1, row["field_updated_at"]["bid_quantity"])

    def test_concurrent_ws_depth_still_wins_over_explicit_rest_depth(self):
        previous, replacement = fixture_snapshot(), fixture_snapshot()
        old, row = previous["options"][0], replacement["options"][0]
        for field in ("bid_quantity", "ask_quantity"):
            old[field] = "2.22"
            old["field_updated_at"][field] = self.now_ms + 1
            old["field_event_ms"][field] = self.now_ms
            old["field_source"][field] = "websocket"
            row[field] = "0"
            row["field_updated_at"][field] = self.now_ms + 2
            row["field_event_ms"][field] = None
            row["field_source"][field] = "rest"
        preserve_concurrent_updates(replacement, previous, self.now_ms)
        self.assertEqual("2.22", row["bid_quantity"])
        self.assertEqual("2.22", row["ask_quantity"])
        self.assertEqual(self.now_ms + 1, row["field_updated_at"]["bid_quantity"])
        self.assertEqual("websocket", row["field_source"]["bid_quantity"])

    def test_stream_recovers_from_invalid_stored_event_and_group_timestamps(self):
        row = self.cache._rows_by_symbol[self.symbol]
        row["ws_event_watermarks"]["bid_price"] = "invalid"
        row["quote_updated_at"] = "invalid"
        row["quote_event_ms"] = "invalid"
        self.assertTrue(self.cache.apply_stream_message({"e": "bookTicker", "E": self.now_ms + 100,
                                                       "u": 10, "s": self.symbol, "b": "101.000", "a": "102.000"}))
        self.assertEqual("101.000", self.row()["bid_price"])
        self.assertEqual(self.now_ms + 100, self.row()["field_event_ms"]["bid_price"])

    def test_rest_preserves_book_update_id_for_same_timestamp_smaller_sequence(self):
        self.cache.apply_stream_message({"e": "bookTicker", "E": self.now_ms + 100, "u": 10,
                                         "s": self.symbol, "b": "101.000", "a": "102.000"})
        previous = self.cache.read()
        replacement = fixture_snapshot()
        preserve_concurrent_updates(replacement, previous, self.now_ms - 1000)
        self.cache._snapshot = replacement
        self.cache._rows_by_symbol = {row["symbol"]: row for row in replacement["options"]}
        self.cache.apply_stream_message({"e": "bookTicker", "E": self.now_ms + 100, "u": 9,
                                         "s": self.symbol, "b": "99.000", "a": "100.000"})
        self.assertEqual("101.000", self.row()["bid_price"])
        self.assertEqual(10, self.row()["book_update_id"])

    def test_exchange_clock_adjustment_removes_expired_contracts_at_official_time(self):
        self.cache._snapshot["exchange_clock_offset_ms"] = 10000
        self.cache._snapshot["options"][0]["expiry_ms"] = int(time.time() * 1000) + 5000
        self.assertEqual(1, len(self.cache.read()["options"]))

    def test_connection_health_does_not_claim_one_socket_means_complete_stream(self):
        self.cache.stream_state("plan", {"streams": 8, "connections": 3})
        self.cache.stream_state("market", {"connected": True, "error": None})
        self.cache.apply_stream_message({"e": "indexPrice", "E": self.now_ms, "s": "BTCUSDT", "p": "85001.12345678"})
        self.assertEqual("hybrid", self.cache.read()["realtime"]["mode"])
        self.assertFalse(self.cache.read()["realtime"]["connected"])
        self.cache.stream_state("book", {"connected": True, "error": None})
        self.cache.stream_state("ticker", {"connected": True, "error": None})
        self.cache.apply_stream_message({"e": "markPrice", "E": self.now_ms, "s": self.symbol, "mp": "123.456"})
        self.assertTrue(self.cache.read()["realtime"]["connected"])
        self.cache._last_messages["mark"] = self.now_ms - 30000
        self.assertFalse(self.cache.read()["realtime"]["connected"])

    def test_server_instances_have_distinct_ids_even_when_revision_matches(self):
        other = MarketCache(self.directory.name, collector=fixture_snapshot, websocket_factory=None)
        self.assertNotEqual(self.cache.read()["instance_id"], other.read()["instance_id"])
        other.stop()

    def test_rate_limit_failure_obeys_retry_after_and_preserves_quotes(self):
        before = self.row()
        def limited():
            raise MarketFetchError("rate limit", {"ticker": {"http_status": 429, "retry_after": "90"}})
        self.cache._collector = limited
        self.cache._last_attempt = None
        self.cache.request_refresh()
        wait_until_idle(self.cache)
        self.assertGreaterEqual(self.cache.read()["retry_after_seconds"], 89)
        self.assertFalse(self.cache.request_refresh())
        self.assertEqual(before, self.row())

    def test_weight_budget_blocks_excess_manual_refreshes_even_without_timer(self):
        self.cache._snapshot["rate_limits"] = [{"rateLimitType": "REQUEST_WEIGHT", "interval": "MINUTE", "intervalNum": 1, "limit": 400}]
        for _ in range(4):
            self.cache._last_attempt = None
            self.assertTrue(self.cache.request_refresh())
            wait_until_idle(self.cache)
        self.cache._last_attempt = None
        self.assertFalse(self.cache.request_refresh())
        self.assertEqual(5 * FULL_SNAPSHOT_WEIGHT, len(self.cache._rest_attempts) * FULL_SNAPSHOT_WEIGHT)


class QuoteVerificationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cache = MarketCache(self.directory.name, websocket_factory=None)
        self.cache._snapshot = fixture_snapshot()
        self.cache._rows_by_symbol = {row["symbol"]: row for row in self.cache._snapshot["options"]}
        self.now = int(time.time() * 1000)
        self.clock = patch("dashboard_server.time.time", side_effect=lambda: self.now / 1000)
        self.clock.start()
        self.symbols = list(self.cache._rows_by_symbol)

    def tearDown(self):
        self.clock.stop()
        self.cache.stop()
        self.directory.cleanup()

    def connect(self, name="book-0", generation=1, confirmed=True, symbols=None, heartbeat=None, plan_generation=None):
        state = {"connected": True, "subscription_confirmed": confirmed,
            "generation": generation, "opened_at_ms": self.now - 1, "heartbeat_at": self.now if heartbeat is None else heartbeat,
            "heartbeat_kind": "pong",
            "symbols": self.symbols if symbols is None else symbols}
        if plan_generation is not None:
            state["plan_generation"] = plan_generation
        self.cache.stream_state(name, state)

    def book(self, symbol=None, generation=1, connection="book-0", plan_generation=None, **extra):
        event = {"e": "bookTicker", "E": self.now, "u": self.now, "s": symbol or self.symbols[0],
                 "b": "490", "a": "510", "B": "2", "A": "3"}
        event.update(extra)
        transport = {"connection": connection, "generation": generation}
        if plan_generation is not None:
            transport["plan_generation"] = plan_generation
        return self.cache.apply_stream_message({"data": event, "_transport": transport})

    def row(self, symbol=None):
        return next(row for row in self.cache.read()["options"] if row["symbol"] == (symbol or self.symbols[0]))

    def test_delayed_batch_keeps_each_wire_receipt_and_does_not_fabricate_quote_age(self):
        self.connect()
        batches = []
        mailbox = BookTickerMailbox(self.symbols, batches.append,
            {"connection": "book-0", "generation": 1}, start=False)
        original = self.now
        for offset, symbol in enumerate(self.symbols):
            mailbox.offer({"e": "bookTicker", "E": original + offset, "u": original + offset,
                "s": symbol, "b": "490", "a": "510", "B": "2", "A": "3"}, original + offset)
        mailbox.dispatch_once()
        self.now += 30000
        self.connect()
        self.assertTrue(self.cache.apply_stream_message(batches[0]))
        for offset, symbol in enumerate(self.symbols):
            row = self.row(symbol)
            self.assertEqual(original + offset, row["quote_updated_at"])
            self.assertEqual(original + offset, row["field_updated_at"]["bid_price"])
            self.assertEqual(self.now, row["quote_verified_at"])

    def test_cancelled_inflight_batch_cannot_apply_after_disconnect_or_stop(self):
        self.connect()
        batches = []
        mailbox = BookTickerMailbox(self.symbols, batches.append,
            {"connection": "book-0", "generation": 1}, start=False)
        mailbox.offer({"e": "bookTicker", "E": self.now, "u": self.now,
            "s": self.symbols[0], "b": "0", "a": "510", "B": "0", "A": "3"}, self.now)
        mailbox.dispatch_once()
        mailbox.close()
        self.assertFalse(self.cache.apply_stream_message(batches[0]))
        self.assertEqual("490", self.row()["bid_price"])

    def test_cancellation_is_rechecked_after_worker_waits_for_cache_lock(self):
        self.connect()
        entered, applied = threading.Event(), []
        def consume(batch):
            entered.set()
            applied.append(self.cache.apply_stream_message(batch))
        mailbox = BookTickerMailbox(self.symbols, consume,
            {"connection": "book-0", "generation": 1}, start=False)
        mailbox.offer({"e": "bookTicker", "E": self.now, "u": self.now,
            "s": self.symbols[0], "b": "0", "a": "510", "B": "0", "A": "3"}, self.now)
        with self.cache._condition:
            worker = threading.Thread(target=mailbox.dispatch_once)
            worker.start()
            self.assertTrue(entered.wait(1))
            mailbox.close()
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual([False], applied)
        self.assertEqual("490", self.row()["bid_price"])

    def test_queued_missing_or_future_receipt_does_not_become_fresh_at_dispatch(self):
        self.connect()
        symbol = self.symbols[0]
        for receipts in ({}, {symbol: None}, {symbol: self.now + 3000}):
            with self.subTest(receipts=receipts):
                self.assertFalse(self.cache.apply_stream_message({"data": [{"e": "bookTicker", "E": self.now,
                    "u": self.now, "s": symbol, "b": "0", "a": "510", "B": "0", "A": "3"}],
                    "_transport": {"connection": "book-0", "generation": 1, "received_at_by_symbol": receipts}}))
        self.assertEqual("490", self.row()["bid_price"])

    def test_dispatched_old_generation_cannot_change_or_certify_new_connection(self):
        self.connect(generation=1)
        batches = []
        mailbox = BookTickerMailbox(self.symbols, batches.append,
            {"connection": "book-0", "generation": 1}, start=False)
        mailbox.offer({"e": "bookTicker", "E": self.now, "u": self.now,
            "s": self.symbols[0], "b": "0", "a": "510", "B": "0", "A": "3"}, self.now)
        mailbox.dispatch_once()
        self.connect(generation=2)
        self.assertFalse(self.cache.apply_stream_message(batches[0]))
        self.assertEqual("490", self.row()["bid_price"])
        self.assertIsNone(self.row()["quote_verification"])

    def test_delayed_batch_checks_expiry_at_dispatch_time_instead_of_wire_receipt(self):
        self.connect()
        original = self.now
        symbol = self.symbols[0]
        self.cache._rows_by_symbol[symbol]["expiry_ms"] = original + 1000
        self.now += 2000
        self.assertFalse(self.cache.apply_stream_message({"data": [{"e": "bookTicker", "E": original,
            "u": original, "s": symbol, "b": "0", "a": "510", "B": "0", "A": "3"}],
            "_transport": {"connection": "book-0", "generation": 1,
                "received_at_by_symbol": {symbol: original}}}))
        self.assertEqual("490", self.cache._rows_by_symbol[symbol]["bid_price"])

    def test_subscription_ack_without_complete_current_baseline_cannot_verify_old_values(self):
        self.connect()
        self.assertIsNone(self.row()["quote_verification"])
        self.book(B=None)
        self.assertIsNone(self.row()["quote_verification"])
        self.now += 1
        self.book()
        verified = self.row()
        self.assertTrue(verified["quote_verification"]["verified"])
        self.assertEqual("bookTicker", verified["quote_verification"]["kind"])
        self.assertEqual({field: verified[field] for field in ("bid_price", "ask_price", "bid_quantity", "ask_quantity")}, verified["quote_verification"]["values"])

    def test_reconnect_keeps_disconnect_evidence_without_reusing_old_quote_certificate(self):
        self.connect()
        self.book()
        self.cache.stream_state("book-0", {"connected": False, "generation": 1,
            "error_type": "HeartbeatTimeout", "diagnostics": {"callback_max_ms": 12.5}})
        failure = self.cache.read()["realtime"]["connection_details"]["book-0"]["last_disconnect"]
        self.connect(generation=2)
        state = self.cache.read()["realtime"]["connection_details"]["book-0"]
        self.assertEqual(failure, state["last_disconnect"])
        self.assertEqual("HeartbeatTimeout", failure["error_type"])
        self.assertEqual(12.5, failure["diagnostics"]["callback_max_ms"])
        self.assertIsNone(self.row()["quote_verification"])

    def test_configure_race_rejects_old_or_unversioned_states_events_and_plan_rollback(self):
        def plan(generation):
            return {"streams": 2, "connections": 1, "plan_generation": generation}
        self.cache.stream_state("plan", plan(1))
        self.connect(plan_generation=1)
        self.book(plan_generation=1)
        self.assertIsNotNone(self.row()["quote_verification"])
        # Deterministically interleave a new configure before late callbacks
        # from an old worker that already passed its own _active() check.
        self.cache.stream_state("plan", plan(2))
        self.connect(generation=2, plan_generation=2)
        self.book(generation=2, plan_generation=2)
        baseline = self.row()["quote_verification"]
        self.cache.stream_state("book-0", {"connected": False, "plan_generation": 1})
        self.cache.stream_state("book-0", {"connected": False})
        self.connect(generation=1, plan_generation=1)
        self.cache.stream_state("plan", plan(1))
        self.cache.stream_state("plan", plan(2))
        self.cache.stream_state("plan", {"streams": 0, "connections": 0})
        self.assertEqual(baseline, self.row()["quote_verification"])
        self.assertEqual(2, self.cache._plan["plan_generation"])
        self.assertFalse(self.book(generation=1, plan_generation=1, b="0"))
        self.assertFalse(self.book(generation=2, b="0"))
        self.assertFalse(self.cache.apply_stream_message({"e": "indexPrice", "E": self.now + 1, "s": "BTCUSDT", "p": "1"}))
        self.assertEqual("490", self.row()["bid_price"])
        self.assertEqual(baseline, self.row()["quote_verification"])

    def test_quiet_book_remains_verified_with_own_heartbeat_without_rejuvenating_field_ages(self):
        self.connect()
        for symbol in self.symbols:
            self.book(symbol)
        original = self.row()["field_updated_at"]["bid_price"]
        self.now += 3600000
        self.connect()
        result = self.cache.read()
        self.assertTrue(all(row["quote_verification"]["verified"] for row in result["options"]))
        self.assertEqual(original, self.row()["field_updated_at"]["bid_price"])
        self.assertEqual(self.now, self.row()["quote_verified_at"])
        quote = result["data_health"]["quote"]
        self.assertEqual("live", quote["status"])
        self.assertEqual(8, quote["fresh_fields"])
        self.assertEqual(original, quote["oldest_updated_at"])
        self.assertEqual(3600, quote["age_seconds"])
        self.assertEqual("stale", result["data_health"]["mark"]["status"])
        self.assertEqual("stale", result["data_health"]["index"]["status"])

    def test_missing_stale_or_future_heartbeat_cannot_certify_even_complete_book(self):
        for heartbeat in (None, self.now - 20001, self.now + 1):
            with self.subTest(heartbeat=heartbeat):
                self.connect()
                self.book()
                self.cache._stream_states["book-0"]["heartbeat_at"] = heartbeat
                self.assertIsNone(self.row()["quote_verification"])

    def test_list_confirmation_is_not_a_substitute_for_matching_protocol_pong(self):
        self.connect()
        self.book()
        self.cache._stream_states["book-0"]["heartbeat_kind"] = "list"
        self.assertIsNone(self.row()["quote_verification"])
        self.cache._stream_states["book-0"].pop("heartbeat_kind")
        self.assertIsNone(self.row()["quote_verification"])

    def test_other_connection_activity_cannot_certify_disconnected_or_silent_connection(self):
        self.connect(symbols=[self.symbols[0]])
        self.book()
        self.now += 21000
        self.connect("book-1", generation=2, symbols=[self.symbols[1]])
        self.book(self.symbols[1], generation=2, connection="book-1")
        self.assertIsNone(self.row()["quote_verification"])
        self.assertIsNotNone(self.row(self.symbols[1])["quote_verification"])
        self.cache.stream_state("book-1", {"connected": False})
        self.assertIsNone(self.row(self.symbols[1])["quote_verification"])

    def test_disconnect_and_new_generation_revoke_baseline_and_reject_late_old_events(self):
        self.connect()
        self.book()
        self.cache.stream_state("book-0", {"connected": False})
        self.assertIsNone(self.row()["quote_verification"])
        self.now += 1
        self.connect(generation=2)
        self.assertIsNone(self.row()["quote_verification"])
        self.assertFalse(self.book(generation=1, b="999"))
        self.assertNotEqual("999", self.row()["bid_price"])
        self.book(generation=2)
        self.assertEqual(2, self.row()["quote_verification"]["generation"])

    def test_complete_baseline_requires_confirmation_and_exact_symbol_membership(self):
        self.connect(confirmed=False, symbols=[self.symbols[0]])
        self.book()
        self.assertIsNone(self.row()["quote_verification"])
        self.assertFalse(self.book(self.symbols[1]))
        self.assertIsNone(self.row(self.symbols[1])["quote_verification"])
        self.connect(symbols=[self.symbols[0]])
        self.assertIsNotNone(self.row()["quote_verification"])

    def test_rest_new_price_never_mixes_with_old_book_depth_in_verified_view(self):
        self.connect()
        self.book()
        original = self.row()
        replacement = fixture_snapshot()
        replacement["options"][0].update(bid_price="900", ask_price="1000")
        self.cache._snapshot = replacement
        self.cache._rows_by_symbol = {row["symbol"]: row for row in replacement["options"]}
        verified = self.row()
        for field in ("bid_price", "ask_price", "bid_quantity", "ask_quantity"):
            self.assertEqual(original[field], verified[field])
            self.assertEqual(original["field_updated_at"][field], verified["field_updated_at"][field])
        self.assertEqual("490", verified["quote_verification"]["values"]["bid_price"])
        self.cache.stream_state("book-0", {"connected": False})
        self.assertEqual("900", self.row()["bid_price"])
        self.assertIsNone(self.row()["quote_verification"])

    def test_newer_partial_ws_zero_price_changed_price_or_quantity_revokes_old_projection(self):
        for extra, field, value in (({"bo": "0", "ao": "510"}, "bid_price", "0"),
                                    ({"bo": "499"}, "bid_price", "499"),
                                    ({"bq": "0.001"}, "bid_quantity", "0.001")):
            with self.subTest(extra=extra):
                self.connect()
                self.now += 1
                self.book()
                self.assertIsNotNone(self.row()["quote_verification"])
                self.now += 1
                self.cache.apply_stream_message(dict({"e": "markPrice", "E": self.now, "s": self.symbols[0]}, **extra))
                observed = self.row()
                self.assertEqual(value, observed[field])
                self.assertIsNone(observed["quote_verification"])

    def test_mark_baseline_requires_current_confirmed_book_and_all_four_fields(self):
        event = {"e": "markPrice", "E": self.now, "s": self.symbols[0], "bo": "490", "ao": "510", "bq": "2", "aq": "3"}
        self.cache.apply_stream_message(event)
        self.connect()
        self.assertIsNone(self.row()["quote_verification"])
        self.now += 1
        self.cache.apply_stream_message(dict(event, E=self.now))
        self.assertEqual("markPrice", self.row()["quote_verification"]["baseline_source"])
        self.now += 1
        self.cache.stream_state("book-0", {"connected": False})
        self.connect(generation=2)
        self.assertIsNone(self.row()["quote_verification"])

    def test_independent_index_stream_can_be_live_while_mark_is_disconnected(self):
        self.cache.stream_state("market", {"connected": False})
        self.cache.stream_state("index", {"connected": True})
        self.cache.apply_stream_message({"e": "indexPrice", "E": self.now, "s": "BTCUSDT", "p": "86000"})
        index = self.cache.read()["data_health"]["index"]
        self.assertEqual("live", index["status"])
        self.assertEqual("86000", self.cache.read()["btc_index_price"])


class TransportPlanTests(unittest.TestCase):
    def test_plan_all_states_disconnect_and_message_carry_the_same_plan_generation(self):
        import websocket
        states, events, dispatched = [], [], threading.Event()
        def consume(batch):
            events.append(batch)
            dispatched.set()
        hub = OptionsWebSocketHub(consume, lambda name, value: None, lambda: None)
        def state(name, value):
            states.append((name, value))
            if value.get("error_type"): hub._stop.set()
        hub.on_state = state
        with patch("realtime_market.threading.Thread"):
            hub.configure(["BTC-991231-80000-C"], "80000")
        self.assertEqual(1, states[0][1]["plan_generation"])
        class Socket:
            step = 0
            def settimeout(self, seconds): pass
            def send(self, data): pass
            def ping(self, payload): self.nonce = payload
            def recv_data(self, control_frame=False):
                self.step += 1
                if self.step == 1: return 1, '{"result":["btc-991231-80000-c@bookTicker"],"id":1}'
                if self.step == 2: return websocket.ABNF.OPCODE_PONG, self.nonce
                if self.step == 3: return 1, '{"e":"bookTicker","E":1234,"s":"BTC-991231-80000-C","b":"1","a":"2","B":"3","A":"4"}'
                if not dispatched.wait(1): raise AssertionError("book batch was not dispatched")
                return websocket.ABNF.OPCODE_CLOSE, b""
            def close(self, **kwargs): pass
        with patch("websocket.create_connection", return_value=Socket()):
            hub._run("book-0", PUBLIC_URL, ["btc-991231-80000-c@bookTicker"], 1)
        self.assertTrue(all(value["plan_generation"] == 1 for _, value in states))
        self.assertEqual("RemoteClosed", states[-1][1]["error_type"])
        self.assertEqual(1, states[-1][1]["diagnostics"]["received_frames"])
        self.assertEqual(1234, states[-1][1]["diagnostics"]["last_event_at_ms"])
        self.assertEqual(1, events[0]["_transport"]["plan_generation"])

    def test_connection_failure_state_still_carries_plan_generation(self):
        states = []
        hub = OptionsWebSocketHub(lambda event: None, lambda name, value: None, lambda: None)
        hub._generation = 4
        def state(name, value):
            states.append(value)
            hub._stop.set()
        hub.on_state = state
        with patch("websocket.create_connection", side_effect=OSError("fixture connection failure")):
            hub._run("book-0", PUBLIC_URL, ["btc-991231-80000-c@bookTicker"], 4)
        self.assertEqual(4, states[-1]["plan_generation"])
        self.assertFalse(states[-1]["connected"])

    def test_previous_connection_pong_nonce_cannot_certify_a_new_generation(self):
        import websocket
        states, sockets, old_nonce = [], [], [None]
        hub = OptionsWebSocketHub(lambda event: None, lambda name, value: None, lambda: None)
        hub._generation = 1
        def state(name, value):
            states.append(value)
            if value.get("heartbeat_kind") == "pong" and value["generation"] == 2:
                hub._stop.set()
        hub.on_state = state
        class Socket:
            def __init__(self, number):
                self.number, self.step = number, 0
            def settimeout(self, seconds): pass
            def send(self, data): pass
            def ping(self, payload):
                self.last_ping = payload
                if self.number == 1: old_nonce[0] = payload
            def recv_data(self, control_frame=False):
                self.step += 1
                if self.step == 1: return 1, '{"result":["btc-991231-80000-c@bookTicker"],"id":1}'
                if self.step == 2:
                    return websocket.ABNF.OPCODE_PONG, old_nonce[0]
                if self.number == 1: return websocket.ABNF.OPCODE_CLOSE, b""
                self.old_nonce_was_rejected = len([value for value in states if value.get("heartbeat_kind") == "pong"]) == 1
                return websocket.ABNF.OPCODE_PONG, self.last_ping
            def close(self, **kwargs): pass
        def create(*args, **kwargs):
            socket = Socket(len(sockets) + 1)
            sockets.append(socket)
            return socket
        with patch("websocket.create_connection", side_effect=create), patch.object(hub._stop, "wait", return_value=False):
            hub._run("book-0", PUBLIC_URL, ["btc-991231-80000-c@bookTicker"], 1)
        self.assertEqual(2, len(sockets))
        self.assertNotEqual(sockets[0].last_ping, sockets[1].last_ping)
        self.assertTrue(sockets[1].old_nonce_was_rejected)
        self.assertEqual([1, 2], [value["generation"] for value in states if value.get("heartbeat_kind") == "pong"])

    def test_reconnect_uses_new_connection_generation_and_does_not_reuse_previous_heartbeat(self):
        states, generations = [], []
        hub = OptionsWebSocketHub(lambda event: None, lambda name, value: None, lambda: None)
        hub._generation = 1
        def state(name, value):
            states.append(value)
            if value.get("connected"):
                generations.append(value["generation"])
                if len(generations) == 2: hub._stop.set()
        hub.on_state = state
        class Socket(TextSocketAdapter):
            ack = False
            def settimeout(self, seconds): pass
            def send(self, data): pass
            def recv(self):
                if not self.ack:
                    self.ack = True
                    return '{"result":["btc-991231-80000-c@bookTicker"],"id":1}'
                return ""
            def close(self, **kwargs): pass
        with patch("websocket.create_connection", side_effect=lambda *args, **kwargs: Socket()), patch.object(hub._stop, "wait", return_value=False):
            hub._run("book-0", PUBLIC_URL, ["btc-991231-80000-c@bookTicker"], 1)
        self.assertEqual(2, len(generations))
        self.assertNotEqual(generations[0], generations[1])
        initial = [state for state in states if state.get("generation") and not state.get("connected")]
        self.assertTrue(all("heartbeat_at" not in state for state in initial))

    def test_matching_heartbeat_refreshes_connection_without_repeating_rest_reconnect(self):
        import websocket
        clock, states, sent, pings, reconnects = [0], [], [], [], []
        hub = OptionsWebSocketHub(lambda event: None, lambda name, value: states.append(value), lambda: reconnects.append(True))
        hub._generation = 1
        class Socket(TextSocketAdapter):
            step = 0
            def settimeout(self, seconds): pass
            def send(self, data): sent.append(json.loads(data))
            def ping(self, payload):
                pings.append(payload)
                self.last_ping = payload
            def recv_data(self, control_frame=False):
                assert control_frame
                self.step += 1
                if self.step == 1: return 1, '{"result":["btcusdt@optionMarkPrice"],"id":1}'
                if self.step == 2: return websocket.ABNF.OPCODE_PONG, self.last_ping
                if self.step == 3: return websocket.ABNF.OPCODE_PING, b"server-keepalive"
                if self.step == 4:
                    clock[0] = 11
                    raise websocket.WebSocketTimeoutException()
                if self.step == 5:
                    clock[0] = 12
                    return websocket.ABNF.OPCODE_PONG, self.last_ping
                hub._stop.set()
                return websocket.ABNF.OPCODE_CLOSE, b""
            def close(self, **kwargs): pass
        with patch("websocket.create_connection", return_value=Socket()), patch("realtime_market.time.monotonic", side_effect=lambda: clock[0]):
            hub._run("market", MARKET_URL, ["btcusdt@optionMarkPrice"], 1)
        self.assertEqual([1], [message["id"] for message in sent])
        self.assertEqual(2, len(pings))
        self.assertNotEqual(pings[0], pings[1])
        self.assertEqual([True], reconnects)
        healthy = [state for state in states if state.get("heartbeat_kind") == "pong"]
        self.assertEqual([1, 2], [state["heartbeat_request_id"] for state in healthy])
        self.assertEqual(healthy[0]["generation"], healthy[1]["generation"])

    def test_unmatched_pong_and_continuous_data_cannot_keep_silent_control_channel_healthy(self):
        import websocket
        clock, states, sent = [0], [], []
        hub = OptionsWebSocketHub(lambda event: None, lambda name, value: None, lambda: None)
        hub._generation = 1
        def state(name, value):
            states.append(value)
            if value.get("error_type"): hub._stop.set()
        hub.on_state = state
        class Socket(TextSocketAdapter):
            step = 0
            def settimeout(self, seconds): pass
            def send(self, data): sent.append(json.loads(data))
            def recv_data(self, control_frame=False):
                self.step += 1
                if self.step == 1: return 1, '{"result":["btc-991231-80000-c@bookTicker"],"id":1}'
                if self.step == 2:
                    clock[0] = 1
                    return websocket.ABNF.OPCODE_PONG, b"wrong-connection-or-nonce"
                clock[0] = 21
                return 1, '{"e":"bookTicker","s":"BTC-991231-80000-C","E":1234,"b":"1","a":"2","B":"1","A":"1"}'
            def close(self, **kwargs):
                self.revoked_before_close = bool(states and not states[-1].get("connected"))
        socket = Socket()
        with patch("websocket.create_connection", return_value=socket), patch("realtime_market.time.monotonic", side_effect=lambda: clock[0]):
            hub._run("book-0", PUBLIC_URL, ["btc-991231-80000-c@bookTicker"], 1)
        self.assertEqual("HeartbeatTimeout", states[-1]["error_type"])
        self.assertFalse(any(state.get("heartbeat_at") for state in states))
        self.assertTrue(socket.revoked_before_close)

    def test_no_pong_times_out_and_revokes_even_after_initial_subscription_ack(self):
        import websocket
        clock, states = [0], []
        hub = OptionsWebSocketHub(lambda event: None, lambda name, value: None, lambda: None)
        hub._generation = 1
        def state(name, value):
            states.append(value)
            if value.get("error_type"): hub._stop.set()
        hub.on_state = state
        class Socket(TextSocketAdapter):
            step = 0
            def settimeout(self, seconds): pass
            def send(self, data): pass
            def recv(self):
                self.step += 1
                if self.step == 1: return '{"result":["btc-991231-80000-c@bookTicker"],"id":1}'
                clock[0] = 21
                raise websocket.WebSocketTimeoutException()
            def close(self, **kwargs): pass
        with patch("websocket.create_connection", return_value=Socket()), patch("realtime_market.time.monotonic", side_effect=lambda: clock[0]):
            hub._run("book-0", PUBLIC_URL, ["btc-991231-80000-c@bookTicker"], 1)
        self.assertEqual("HeartbeatTimeout", states[-1]["error_type"])
        self.assertFalse(any(state.get("heartbeat_at") for state in states))

    def test_websocket_client_returns_server_ping_and_sends_matching_pong_automatically(self):
        import websocket
        client = websocket.WebSocket()
        frame = websocket.ABNF.create_frame(b"server-keepalive", websocket.ABNF.OPCODE_PING)
        with patch.object(client, "recv_frame", return_value=frame), patch.object(client, "pong") as pong:
            opcode, payload = client.recv_data(control_frame=True)
        self.assertEqual(websocket.ABNF.OPCODE_PING, opcode)
        self.assertEqual(b"server-keepalive", payload)
        pong.assert_called_once_with(b"server-keepalive")

    def test_single_strict_json_decode_preserves_unicode_and_rejects_other_encodings(self):
        import websocket
        from realtime_market import decode_json_frame
        client = websocket.WebSocket(skip_utf8_validation=True)
        valid = '{"e":"bookTicker","note":"行情","b":"123.45"}'.encode("utf-8")
        for payload in (valid, b'{"note":"\xff"}', '{"note":"行情"}'.encode("utf-16")):
            frame = websocket.ABNF.create_frame(payload, websocket.ABNF.OPCODE_TEXT)
            with patch.object(client, "recv_frame", return_value=frame):
                opcode, message = client.recv_data()
            self.assertEqual(websocket.ABNF.OPCODE_TEXT, opcode)
            if payload == valid:
                self.assertEqual({"e": "bookTicker", "note": "行情", "b": "123.45"}, decode_json_frame(message))
            else:
                with self.assertRaises(UnicodeDecodeError):
                    decode_json_frame(message)

    def test_book_burst_coalesces_to_latest_state_and_yields_without_timed_receive_sleep(self):
        import websocket
        events, calls, dispatched = [], [], threading.Event()
        def consume(batch):
            events.append(batch)
            dispatched.set()
        hub = OptionsWebSocketHub(consume, lambda name, value: None, lambda: None)
        hub._generation = 1
        class Socket(TextSocketAdapter):
            step = 0
            def settimeout(self, seconds): pass
            def send(self, data): pass
            def recv(self):
                self.step += 1
                if self.step == 1: return '{"result":["btc-991231-80000-c@bookTicker"],"id":1}'
                if self.step <= 66: return json.dumps({"e": "bookTicker", "E": 1234 + self.step,
                    "u": self.step, "s": "BTC-991231-80000-C", "b": str(self.step), "a": "99", "B": "3", "A": "4"})
                if not dispatched.wait(1): raise AssertionError("book burst was not dispatched")
                hub._stop.set()
                return ""
            def close(self, **kwargs): pass
        with patch("websocket.create_connection", return_value=Socket()), patch("realtime_market.time.sleep", side_effect=lambda value: calls.append(value)):
            hub._run("book-0", PUBLIC_URL, ["btc-991231-80000-c@bookTicker"], 1)
        self.assertTrue(events)
        self.assertEqual("66", events[-1]["data"][0]["b"])
        self.assertLess(len(events), 65)
        self.assertEqual([0, 0], calls)

    def test_slow_book_cache_consumer_does_not_prevent_matching_pong_processing(self):
        import websocket
        started, release, consumed = threading.Event(), threading.Event(), threading.Event()
        states = []
        def consumer(batch):
            started.set()
            release.wait(2)
            consumed.set()
        hub = OptionsWebSocketHub(consumer, lambda name, value: None, lambda: None)
        hub._generation = 1
        def state(name, value):
            states.append(value)
            if value.get("heartbeat_kind") == "pong":
                self.assertTrue(started.is_set())
                self.assertFalse(consumed.is_set())
                release.set()
        hub.on_state = state
        class Socket(TextSocketAdapter):
            step = 0
            def settimeout(self, seconds): pass
            def send(self, data): pass
            def recv_data(self, control_frame=False):
                self.step += 1
                if self.step == 1: return 1, '{"result":["btc-991231-80000-c@bookTicker"],"id":1}'
                if self.step == 2: return 1, '{"e":"bookTicker","E":1234,"u":1,"s":"BTC-991231-80000-C","b":"1","a":"2","B":"3","A":"4"}'
                if self.step == 3:
                    if not started.wait(1): raise AssertionError("worker did not start")
                    return websocket.ABNF.OPCODE_PONG, self.last_ping
                if not consumed.wait(1): raise AssertionError("consumer was not released by PONG")
                hub._stop.set()
                return websocket.ABNF.OPCODE_CLOSE, b""
            def close(self, **kwargs): pass
        try:
            with patch("websocket.create_connection", return_value=Socket()):
                hub._run("book-0", PUBLIC_URL, ["btc-991231-80000-c@bookTicker"], 1)
            self.assertEqual(1, len([value for value in states if value.get("heartbeat_kind") == "pong"]))
            self.assertTrue(consumed.is_set())
        finally:
            release.set()
            hub.stop()

    def test_blocking_transport_requires_ack_before_reporting_connected(self):
        states, events, reconnects = [], [], []
        hub = OptionsWebSocketHub(events.append, lambda name, value: states.append((name, value)), lambda: reconnects.append(True))
        hub._generation = 1
        class Socket(TextSocketAdapter):
            def settimeout(self, seconds):
                self.timeout = seconds
            def send(self, data):
                self.subscription = json.loads(data)
            def recv(self):
                if not getattr(self, "ack_sent", False):
                    self.ack_sent = True
                    self.pre_ack = all(not state.get("connected") for _, state in states)
                    return '{"result":["!index@arr"],"id":1}'
                if not getattr(self, "event_sent", False):
                    self.event_sent = True
                    return '{"stream":"!index@arr","data":[{"e":"indexPrice","E":1234,"s":"BTCUSDT","p":"85000.123"}]}'
                hub._stop.set()
                return ""
            def close(self, **kwargs):
                self.closed = True
        socket = Socket()
        with patch("websocket.create_connection", return_value=socket):
            hub._run("market", MARKET_URL, ["!index@arr"], 1)
        self.assertTrue(socket.pre_ack)
        self.assertTrue(socket.closed)
        self.assertEqual(5, socket.timeout)
        self.assertEqual("LIST_SUBSCRIPTIONS", socket.subscription["method"])
        self.assertTrue(states[-1][1]["subscription_confirmed"])
        self.assertEqual([True], reconnects)
        self.assertEqual(1, len(events))

    def test_replaced_generation_cannot_confirm_subscription_or_forward_late_frame(self):
        states, events, reconnects = [], [], []
        hub = OptionsWebSocketHub(events.append,
            lambda name, value: states.append(value), lambda: reconnects.append(True))
        hub._generation = 1

        class Socket(TextSocketAdapter):
            def settimeout(self, seconds):
                pass
            def send(self, data):
                pass
            def recv(self):
                # Reconfiguration happened while the old socket was blocked.
                hub._generation = 2
                return '{"result":["!index@arr"],"id":1}'
            def close(self, **kwargs):
                self.closed = True

        socket = Socket()
        with patch("websocket.create_connection", return_value=socket):
            hub._run("market", MARKET_URL, ["!index@arr"], 1)
        self.assertTrue(socket.closed)
        self.assertFalse(any(state.get("connected") for state in states))
        self.assertEqual([], events)
        self.assertEqual([], reconnects)

    def test_stop_during_recv_drops_late_event_and_closes_transport(self):
        events = []
        hub = OptionsWebSocketHub(events.append, lambda name, value: None, lambda: None)
        hub._generation = 1

        class Socket(TextSocketAdapter):
            def settimeout(self, seconds):
                pass
            def send(self, data):
                pass
            def recv(self):
                hub.stop()
                return '{"e":"indexPrice","E":1234,"s":"BTCUSDT","p":"85000"}'
            def close(self, **kwargs):
                self.closed = True

        socket = Socket()
        with patch("websocket.create_connection", return_value=socket):
            hub._run("market", MARKET_URL, ["!index@arr"], 1)
        self.assertTrue(socket.closed)
        self.assertEqual([], events)

    def test_stop_attempts_all_connections_even_if_one_close_fails(self):
        hub = OptionsWebSocketHub(lambda event: None, lambda name, value: None, lambda: None)
        failed = Mock()
        failed.close.side_effect = OSError("already disconnected")
        healthy = Mock()
        hub._connections = {"market": failed, "book-0": healthy}
        hub.stop()
        self.assertTrue(hub._stop.is_set())
        failed.close.assert_called_once()
        healthy.close.assert_called_once()

    def test_rejected_subscription_never_claims_live_or_requests_reconnect_snapshot(self):
        states, reconnects = [], []
        hub = OptionsWebSocketHub(lambda event: None, lambda name, value: None,
                                  lambda: reconnects.append(True))
        hub._generation = 1
        def state(name, value):
            states.append(value)
            if value.get("error_type"):
                hub._stop.set()
        hub.on_state = state

        class Socket(TextSocketAdapter):
            def settimeout(self, seconds):
                pass
            def send(self, data):
                pass
            def recv(self):
                return '{"result":[],"id":1}'
            def close(self, **kwargs):
                pass

        with patch("websocket.create_connection", return_value=Socket()):
            hub._run("market", MARKET_URL, ["!index@arr"], 1)
        self.assertEqual("SubscriptionRejected", states[-1]["error_type"])
        self.assertFalse(any(state.get("connected") for state in states))
        self.assertEqual([], reconnects)

    def test_blocking_transport_reconnects_market_after_20_seconds_without_frames(self):
        import websocket
        states = []
        hub = OptionsWebSocketHub(lambda value: None, lambda name, value: None, lambda: None)
        hub._generation = 1
        def state(name, value):
            states.append(value)
            if value.get("error_type"):
                hub._stop.set()
        hub.on_state = state
        class Socket(TextSocketAdapter):
            def settimeout(self, seconds):
                pass
            def send(self, data):
                pass
            def recv_data(self, control_frame=False):
                if not getattr(self, "ack_sent", False):
                    self.ack_sent = True
                    return 1, '{"result":["!index@arr"],"id":1}'
                if not getattr(self, "pong_sent", False):
                    self.pong_sent = True
                    return websocket.ABNF.OPCODE_PONG, self.last_ping
                clock[0] = 23
                raise websocket.WebSocketTimeoutException()
            def close(self, **kwargs):
                pass
        clock = [0]
        with patch("websocket.create_connection", return_value=Socket()), patch("realtime_market.time.monotonic", side_effect=lambda: clock[0]):
            hub._run("market", MARKET_URL, ["!index@arr"], 1)
        self.assertEqual("MarketStreamSilent", states[-1]["error_type"])
        self.assertFalse(states[-1]["connected"])

    def test_streams_use_correct_options_hosts_and_never_exceed_200_per_connection(self):
        symbols = ["BTC-991231-%s-C" % strike for strike in range(676)]
        plan = subscription_plan(symbols)
        self.assertEqual(7, len(plan))
        self.assertEqual(("market", MARKET_URL, ["btcusdt@optionMarkPrice"]), plan[0])
        self.assertEqual(("index", MARKET_URL, ["!index@arr"]), plan[1])
        self.assertEqual(["btcusdt@optionTrade", "btcusdt@optionTicker991231"], plan[2][2])
        self.assertTrue(all(len(streams) <= MAX_STREAMS for _, _, streams in plan))
        self.assertTrue(all(url == PUBLIC_URL for _, url, _ in plan[2:]))
        books = [stream for name, _, streams in plan if name.startswith("book-") for stream in streams]
        self.assertEqual(len(symbols), len(books))
        self.assertEqual(len(symbols), len(set(books)))
        self.assertEqual({symbol.lower() + "@bookTicker" for symbol in symbols}, set(books))

    def test_nearest_expiry_and_nearest_strikes_are_prioritized_for_event_level_book(self):
        symbols = ["BTC-991231-%s-C" % strike for strike in range(1000)] + ["BTC-991230-%s-P" % strike for strike in range(1000)]
        plan = subscription_plan(symbols, "500")
        books = [streams for name, _, streams in plan if name.startswith("book-")]
        sizes = [len(streams) for streams in books]
        active_counts = [sum(stream.startswith("btc-991230-") for stream in streams) for streams in books]
        self.assertLessEqual(max(sizes), MAX_STREAMS)
        self.assertLessEqual(max(sizes) - min(sizes), 1)
        self.assertLessEqual(max(active_counts) - min(active_counts), 1)
        self.assertIn("btc-991230-500-p@bookTicker", books[0])
        self.assertTrue(all(0 < count < size for count, size in zip(active_counts, sizes)))

    def test_trade_price_and_exact_transaction_timestamp_are_paired(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = MarketCache(tmp, collector=fixture_snapshot, websocket_factory=None)
            cache.request_refresh()
            wait_until_idle(cache)
            symbol = cache.read()["options"][0]["symbol"]
            stamp = int(time.time() * 1000)
            cache.apply_stream_message({"e": "trade", "E": stamp + 1, "T": stamp, "s": symbol, "p": "123.456"})
            row = cache.read()["options"][0]
            self.assertEqual("123.456", row["last_price"])
            self.assertEqual(stamp, row["last_trade_time_ms"])
            self.assertEqual("websocket", row["field_source"]["last_trade_beijing"])
            self.assertIsNotNone(row["last_trade_beijing"])
            cache.stop()

    def test_exact_decimal_values_and_nonfinite_values(self):
        self.assertEqual("0.123456789012345678901", decimal_text("0.123456789012345678901"))
        for invalid in (True, None, "NaN", "Infinity", "-Infinity", "invalid"):
            self.assertIsNone(decimal_text(invalid))


if __name__ == "__main__":
    unittest.main(verbosity=2)
