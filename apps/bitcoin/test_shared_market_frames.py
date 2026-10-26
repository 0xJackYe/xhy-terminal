"""Offline checks for shared SSE encoding, lock isolation and reader cursors."""

import io
import json
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock, patch

from dashboard_server import DashboardHandler, MarketCache
from test_dashboard_server import fixture_snapshot


def frame_value(packet):
    return json.loads(packet.split(b"data: ", 1)[1].strip())


class SharedMarketFrameTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.collector = Mock(side_effect=AssertionError("SSE must not fetch upstream"))
        self.cache = MarketCache(self.directory.name, collector=self.collector, websocket_factory=None)
        self.cache._snapshot = fixture_snapshot()
        self.cache._rows_by_symbol = {row["symbol"]: row for row in self.cache._snapshot["options"]}
        self.symbol = next(iter(self.cache._rows_by_symbol))
        self.interval = patch("dashboard_server.SSE_INTERVAL_SECONDS", .03)
        self.interval.start()

    def tearDown(self):
        self.interval.stop()
        self.cache.stop()
        self.directory.cleanup()
        self.collector.assert_not_called()

    def update(self, size="4"):
        stamp = int(time.time() * 1000)
        self.cache.apply_stream_message({"e": "bookTicker", "E": stamp,
            "u": stamp, "s": self.symbol, "b": "490", "a": "510", "B": size, "A": "3"})

    def handler(self, stream, headers=None):
        return SimpleNamespace(server=SimpleNamespace(cache=self.cache),
            headers=headers or {}, wfile=stream, close_connection=False,
            connection=SimpleNamespace(settimeout=lambda _: None),
            send_response=lambda _: None, send_header=lambda *_: None,
            end_headers=lambda: None)

    def test_three_readers_share_one_snapshot_and_one_encoding_outside_market_lock(self):
        gate = threading.Barrier(3)
        original_dumps = json.dumps
        encode_count = []

        def encode(*args, **kwargs):
            self.assertTrue(self.cache._lock.acquire(blocking=False), "encoding held market lock")
            self.cache._lock.release()
            encode_count.append(1)
            time.sleep(.02)
            return original_dumps(*args, **kwargs)

        def reader():
            gate.wait()
            return self.cache.wait_market_frame(-1, timeout=1)

        with patch.object(self.cache, "_read_locked", wraps=self.cache._read_locked) as read:
            with patch("dashboard_server.json.dumps", side_effect=encode):
                with ThreadPoolExecutor(max_workers=3) as pool:
                    futures = [pool.submit(reader) for _ in range(3)]
                    frames = [future.result(timeout=2) for future in futures]
            self.assertEqual(1, read.call_count)
        self.assertEqual(1, len(encode_count))
        self.assertTrue(all(frame[1] is frames[0][1] for frame in frames))
        self.assertEqual([0, 0, 0], [frame[0] for frame in frames])
        value = frame_value(frames[0][1])
        self.assertNotIn("endpoints", value)
        self.assertFalse(value["credentials_used"])

    def test_quiet_same_cursor_times_out_without_rebuilding_or_relabeling_data(self):
        revision, packet = self.cache.wait_market_frame(-1, timeout=0)
        with patch.object(self.cache, "_read_locked", wraps=self.cache._read_locked) as read:
            self.assertEqual((revision, None), self.cache.wait_market_frame(revision, timeout=.02))
            read.assert_not_called()
        self.assertIs(packet, self.cache._market_frame[1])

    def test_burst_updates_coalesce_into_next_shared_frame(self):
        revision, first = self.cache.wait_market_frame(-1, timeout=0)
        for size in ("4", "5", "6"):
            self.update(size)
        with patch.object(self.cache, "_read_locked", wraps=self.cache._read_locked) as read:
            latest, second = self.cache.wait_market_frame(revision, timeout=1)
            shared = self.cache.wait_market_frame(revision, timeout=0)
            self.assertEqual(1, read.call_count)
        self.assertGreater(latest, revision)
        self.assertIs(second, shared[1])
        self.assertIsNot(first, second)
        row = next(row for row in frame_value(second)["options"] if row["symbol"] == self.symbol)
        self.assertEqual("6", row["bid_quantity"])

    def test_new_reader_refreshes_old_server_clock_without_changing_market_times(self):
        _, first = self.cache.wait_market_frame(-1, timeout=0)
        initial = frame_value(first)
        self.cache._market_frame_ready_at -= 1
        later = int(time.time() * 1000) + 60000
        with patch("dashboard_server.time.time", return_value=later / 1000):
            _, second = self.cache.wait_market_frame(-1, timeout=0)
        refreshed = frame_value(second)
        self.assertEqual(later + refreshed.get("exchange_clock_offset_ms", 0), refreshed["server_now_ms"])
        self.assertEqual(initial["options"][0]["field_updated_at"], refreshed["options"][0]["field_updated_at"])
        self.assertEqual(initial["index_updated_at"], refreshed["index_updated_at"])
        self.assertNotEqual(initial["server_now_ms"], refreshed["server_now_ms"])

    def test_stop_wakes_waiting_readers_without_starting_new_snapshot(self):
        revision, _ = self.cache.wait_market_frame(-1, timeout=0)
        entered = threading.Event()

        def reader():
            entered.set()
            return self.cache.wait_market_frame(revision, timeout=5)

        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(reader)
            self.assertTrue(entered.wait(1))
            self.cache.stop()
            self.assertEqual((revision, None), pending.result(timeout=1))

    def test_stop_during_encoding_discards_inflight_frame(self):
        entered, release = threading.Event(), threading.Event()
        original = json.dumps

        def encode(*args, **kwargs):
            entered.set()
            release.wait(1)
            return original(*args, **kwargs)

        with patch("dashboard_server.json.dumps", side_effect=encode):
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(self.cache.wait_market_frame, -1, 1)
                self.assertTrue(entered.wait(1))
                self.cache.stop()
                release.set()
                self.assertEqual((-1, None), pending.result(timeout=1))
        self.assertIsNone(self.cache._market_frame)
        self.assertFalse(self.cache._market_frame_building)

    def test_encoding_failure_does_not_strand_single_flight(self):
        with patch("dashboard_server.json.dumps", side_effect=ValueError("bad json")):
            with self.assertRaises(ValueError):
                self.cache.wait_market_frame(-1, timeout=0)
        self.assertFalse(self.cache._market_frame_building)
        revision, packet = self.cache.wait_market_frame(-1, timeout=0)
        self.assertEqual(0, revision)
        self.assertIsNotNone(packet)

    def test_slow_client_write_does_not_block_next_shared_market_frame(self):
        entered, release = threading.Event(), threading.Event()
        packets = []

        class SlowStream:
            def write(_, data):
                if data.startswith(b"id: "):
                    packets.append(data)
                    entered.set()
                    release.wait(1)
                    raise BrokenPipeError()

            def flush(_):
                pass

        worker = threading.Thread(target=DashboardHandler._events, args=(self.handler(SlowStream()),))
        worker.start()
        try:
            self.assertTrue(entered.wait(1))
            revision = self.cache._market_frame[0]
            self.update("8")
            latest, packet = self.cache.wait_market_frame(revision, timeout=1)
            self.assertGreater(latest, revision)
            self.assertIsNot(packet, packets[0])
            row = next(row for row in frame_value(packet)["options"] if row["symbol"] == self.symbol)
            self.assertEqual("8", row["bid_quantity"])
        finally:
            release.set()
            worker.join(1)
        self.assertFalse(worker.is_alive())

    def test_last_event_id_current_cursor_receives_keepalive_not_duplicate_frame(self):
        revision, _ = self.cache.wait_market_frame(-1, timeout=0)
        output = []

        class Stream:
            def write(_, data):
                output.append(data)
                if data.startswith(b": keepalive"):
                    raise BrokenPipeError()

            def flush(_):
                pass

        original = self.cache.wait_market_frame
        with patch.object(self.cache, "wait_market_frame", side_effect=lambda cursor, timeout: original(cursor, .02)) as wait:
            DashboardHandler._events(self.handler(Stream(), {"Last-Event-ID": str(revision)}))
        self.assertEqual(revision, wait.call_args.args[0])
        self.assertFalse(any(packet.startswith(b"id: ") for packet in output))
        self.assertIn(b": keepalive\n\n", output)


if __name__ == "__main__":
    unittest.main()
