"""Deterministic alert boundary, time, persistence, and notification tests."""

import json
import io
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

from btc_alert import (BtcAlertMonitor, DAY_MS, WS_URL, PublicRateLimitError,
                       beijing_day_start, fetch_public_json, retry_after_seconds)


class Clock:
    def __init__(self):
        self.ms = int(datetime(2030, 1, 2, 4, tzinfo=timezone.utc).timestamp() * 1000)

    def __call__(self):
        return self.ms / 1000

    def advance(self, milliseconds=10):
        self.ms += milliseconds


def daily_event(clock, opening="100", high=None, low=None, closing=None, event_ms=None, day=None):
    start = beijing_day_start(clock.ms) if day is None else day
    return {"e": "kline", "s": "BTCUSDT", "E": clock.ms if event_ms is None else event_ms,
            "k": {"s": "BTCUSDT", "i": "1d", "t": start, "T": start + DAY_MS - 1,
                  "o": opening, "h": high or opening, "l": low or opening,
                  "c": closing or opening}}


class AlertTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.path = Path(self.temp.name) / "state.json"
        self.monitor = BtcAlertMonitor(state_path=self.path, clock=self.clock)
        self.monitor.configure({"sound": False, 'threshold_pct': 2.5})
        self.trade_id = 0

    def tearDown(self):
        self.monitor.stop()
        self.temp.cleanup()

    def baseline(self, **kwargs):
        return self.monitor.ingest(daily_event(self.clock, **kwargs))

    def trade(self, price, **kwargs):
        self.clock.advance()
        self.trade_id += 1
        event = {"e": "trade", "s": "BTCUSDT", "E": self.clock.ms,
                 "T": self.clock.ms, "t": self.trade_id, "p": str(price)}
        event.update(kwargs)
        return self.monitor.ingest(event)

    def market_alerts(self):
        return [item for item in self.monitor.read()["alerts"] if item["kind"] == "market"]

    def test_exact_2_5_percent_boundary_without_float_tolerance(self):
        self.assertTrue(self.baseline())
        self.trade("102.49999999")
        self.assertEqual([], self.market_alerts())
        self.trade("102.5")
        self.assertEqual("up", self.market_alerts()[0]["direction"])
        self.assertEqual(2.5, self.market_alerts()[0]["change_pct"])

    def test_downward_exact_boundary(self):
        self.baseline()
        self.trade("97.50000001")
        self.assertEqual([], self.market_alerts())
        self.trade("97.5")
        self.assertEqual("down", self.market_alerts()[0]["direction"])
        self.assertEqual(-2.5, self.market_alerts()[0]["change_pct"])

    def test_once_per_day_per_direction(self):
        self.baseline()
        for price in (103, 104, 100, 103, 97, 95, 100, 96):
            self.trade(price)
        self.assertEqual(["up", "down"], [item["direction"] for item in self.market_alerts()])

    def test_day_range_uses_full_day_high_low_and_open(self):
        self.monitor.configure({"metric": "day_range"})
        self.baseline(high="101.25", low="98.75")
        alert = self.market_alerts()[0]
        self.assertEqual("range", alert["direction"])
        self.assertEqual(2.5, alert["range_pct"])
        self.assertEqual(0, alert["change_pct"])
        self.trade(110)
        self.assertEqual(1, len(self.market_alerts()))

    def test_day_range_trades_update_extremes_even_if_price_returns(self):
        self.monitor.configure({"metric": "day_range"})
        self.baseline()
        self.trade("101.3")
        self.trade("98.8")
        self.trade("100")
        state = self.monitor.read()
        self.assertEqual(2.5, state["market"]["range_pct"])
        self.assertEqual("range", self.market_alerts()[0]["direction"])

    def test_pause_resume_waits_for_fresh_price_and_retains_deduplication(self):
        self.baseline()
        self.monitor.configure({"enabled": False})
        self.trade(105)
        self.assertEqual([], self.market_alerts())
        self.monitor.configure({"enabled": True})
        self.assertEqual([], self.market_alerts())
        self.trade(105)
        self.assertEqual(1, len(self.market_alerts()))
        self.monitor.configure({"enabled": False})
        self.monitor.configure({"enabled": True})
        self.trade(106)
        self.assertEqual(1, len(self.market_alerts()))

    def test_new_threshold_is_new_rule_only_on_new_event(self):
        self.baseline()
        self.trade(104)
        self.monitor.configure({"threshold_pct": 3})
        self.assertEqual(1, len(self.market_alerts()))
        self.trade(104)
        self.assertEqual(2, len(self.market_alerts()))
        self.monitor.configure({"threshold_pct": 2.5})
        self.trade(104)
        self.assertEqual(2, len(self.market_alerts()))

    def test_stale_event_never_changes_price_or_triggers(self):
        self.baseline()
        self.clock.advance(20000)
        self.trade(110, E=self.clock.ms - 20000, T=self.clock.ms - 20000)
        self.assertEqual(100, self.monitor.read()["market"]["price"])
        self.assertEqual("stale", self.monitor.read()["market"]["status"])
        self.assertEqual([], self.market_alerts())

    def test_future_event_never_triggers(self):
        self.baseline()
        self.assertFalse(self.trade(110, E=self.clock.ms + 10000, T=self.clock.ms + 10000))
        self.assertEqual([], self.market_alerts())
        self.assertEqual(100, self.monitor.read()["market"]["price"])

    def test_fresh_event_with_stale_trade_timestamp_is_rejected(self):
        self.baseline()
        self.assertFalse(self.trade(110, T=self.clock.ms - 20000))
        self.assertEqual([], self.market_alerts())

    def test_wrong_symbol_and_malformed_fields_are_ignored(self):
        self.baseline()
        for changes in ({"s": "ETHUSDT"}, {"p": "NaN"}, {"p": "-1"},
                        {"p": True}, {"t": True}, {"E": "123"}):
            self.assertFalse(self.trade(110, **changes))
        self.assertEqual([], self.market_alerts())

    def test_duplicate_and_backward_trade_ids_are_ignored(self):
        self.baseline()
        self.trade(101)
        self.assertFalse(self.trade(110, t=1))
        self.assertFalse(self.trade(110, t=0))
        self.assertEqual(101, self.monitor.read()["market"]["price"])
        self.assertEqual([], self.market_alerts())

    def test_multiple_unique_trades_in_same_millisecond_are_processed(self):
        self.baseline()
        for number, price in ((1, "101"), (2, "102.5")):
            self.assertTrue(self.monitor.ingest({"e": "trade", "s": "BTCUSDT", "E": self.clock.ms,
                                              "T": self.clock.ms, "t": number, "p": price}))
        self.assertEqual(1, len(self.market_alerts()))

    def test_out_of_order_trade_timestamp_does_not_change_extremes(self):
        self.baseline()
        self.trade(101)
        self.clock.advance(50)
        self.assertFalse(self.trade(110, T=self.clock.ms - 60))
        self.assertEqual(101, self.monitor.read()["market"]["day_high"])

    def test_older_kline_cannot_replace_baseline_or_trigger_range(self):
        self.monitor.configure({"metric": "day_range"})
        self.baseline()
        event = daily_event(self.clock, high="120", event_ms=self.clock.ms - 1)
        self.assertFalse(self.monitor.ingest(event))
        self.assertEqual(100, self.monitor.read()["market"]["day_high"])
        self.assertEqual([], self.market_alerts())

    def test_kline_updates_price_when_no_trade_stream_has_arrived(self):
        self.baseline()
        self.clock.advance(2000)
        self.baseline(high="103", closing="103")
        self.assertEqual(103, self.monitor.read()["market"]["price"])
        self.assertEqual(1, len(self.market_alerts()))

    def test_rest_baseline_after_live_trade_preserves_known_extreme(self):
        self.trade(104)
        start = beijing_day_start(self.clock.ms)
        self.monitor._apply_bootstrap([[start, "100", "101", "99", "101", "0", start + DAY_MS - 1]], [], self.clock.ms)
        self.assertEqual(104, self.monitor.read()["market"]["day_high"])
        self.assertEqual([], self.market_alerts())
        self.trade(104)
        self.assertEqual(1, len(self.market_alerts()))

    def test_utc_daily_kline_is_not_a_beijing_day(self):
        utc_start = self.clock.ms // DAY_MS * DAY_MS
        self.assertFalse(self.baseline(day=utc_start))
        self.assertIsNone(self.monitor.read()["market"]["day_open"])

    def test_day_rollover_waits_for_new_day_baseline(self):
        self.baseline()
        self.trade(103)
        self.clock.ms = beijing_day_start(self.clock.ms) + DAY_MS + 100
        self.assertIsNone(self.monitor.read()["market"]["day_open"])
        self.assertIsNone(self.monitor.read()["market"]["change_pct"])
        self.trade(206)
        self.assertEqual(1, len(self.market_alerts()))
        self.assertEqual("waiting_baseline", self.monitor.read()["market"]["status"])
        self.baseline(opening="200", high="206", low="200", closing="206")
        self.assertEqual(2, len(self.market_alerts()))
        self.assertEqual(200, self.monitor.read()["market"]["day_open"])

    def test_rest_bootstrap_never_triggers_but_next_live_event_can(self):
        start = beijing_day_start(self.clock.ms)
        row = [start, "100", "110", "100", "110", "0", start + DAY_MS - 1]
        self.monitor._apply_bootstrap([row], [], self.clock.ms)
        self.assertEqual([], self.market_alerts())
        self.assertEqual("waiting_live", self.monitor.read()["market"]["status"])
        self.trade(110)
        self.assertEqual(1, len(self.market_alerts()))

    def test_late_rest_does_not_overwrite_live_market_and_chart(self):
        self.baseline()
        self.trade(101)
        start = beijing_day_start(self.clock.ms)
        minute = self.clock.ms // 60000 * 60000
        daily = [start, "100", "100", "99", "99", "0", start + DAY_MS - 1]
        chart = [minute, "100", "100", "99", "99", "0", minute + 59999]
        self.monitor._apply_bootstrap([daily], [chart], self.clock.ms)
        state = self.monitor.read()
        self.assertEqual(101, state["market"]["price"])
        self.assertEqual(101, state["market"]["day_high"])
        self.assertEqual(101, state["history"][-1]["price"])

    def test_chart_gap_after_sleep_is_refilled_from_five_minute_candles_and_rechecked(self):
        # The clock is 12:00 Beijing: the open at 00:00 and one live trade now
        # left the chart as a straight line across the morning.
        self.baseline()
        self.trade(101)
        start = beijing_day_start(self.clock.ms)
        calls = []

        def fetcher(url):
            calls.append(url)
            query = parse_qs(urlsplit(url).query)
            if query["interval"] == ["1d"]:
                return [[start, "100", "110", "90", "101", "0", start + DAY_MS - 1]]
            return [[opening, "100", "105", "95", str(100 + (opening - start) // 300000 % 7), "0", opening + 299999]
                    for opening in range(start, self.clock.ms, 300000)]

        test = self

        class Stops(threading.Event):
            def __init__(self):
                super().__init__()
                self.waits = 0

            def wait(self, timeout=None):
                self.waits += 1
                if self.waits == 1:
                    # The computer sleeps for two hours, then the live stream
                    # resumes: a new gap opens after the startup load.
                    test.clock.advance(2 * 3600000)
                    test.trade(102)
                    return False
                self.set()
                return True

        self.monitor._fetcher = fetcher
        self.monitor._public_fetch = fetcher
        self.monitor._stop = Stops()
        with self.monitor._lock:
            self.assertTrue(self.monitor._history_gap_locked(self.clock.ms))
        self.monitor._bootstrap_loop()
        history = self.monitor.read()["history"]
        self.assertGreater(len(history), 150)
        self.assertGreater(len({point["price"] for point in history}), 3)
        self.assertEqual(102, history[-1]["price"])
        with self.monitor._lock:
            self.assertFalse(self.monitor._history_gap_locked(self.clock.ms))
        # Startup loads the daily and 5-minute candles; the re-check after the
        # sleep fetches only the 5-minute candles again.
        self.assertEqual(["1d", "5m", "5m"], [parse_qs(urlsplit(url).query)["interval"][0] for url in calls])

    def test_rest_previous_day_never_establishes_today_baseline(self):
        start = beijing_day_start(self.clock.ms) - DAY_MS
        self.monitor._apply_bootstrap([[start, "100", "200", "100", "200", "0", start + DAY_MS - 1]], [], self.clock.ms)
        self.assertIsNone(self.monitor.read()["market"]["day_open"])

    def test_restart_preserves_settings_and_daily_trigger_deduplication(self):
        self.baseline()
        self.trade(103)
        self.monitor.stop()
        replacement = BtcAlertMonitor(state_path=self.path, clock=self.clock)
        self.monitor = replacement
        self.assertFalse(replacement.read()["settings"]["sound"])
        self.assertEqual(1, len(self.market_alerts()))
        replacement.ingest(daily_event(self.clock, high="104", closing="104"))
        self.assertEqual(1, len(self.market_alerts()))
        self.assertEqual(104, replacement.read()["market"]["price"])

    def test_snapshot_instance_stays_stable_and_changes_after_restart(self):
        first = self.monitor.read()["instance_id"]
        self.baseline()
        self.trade(103)
        self.assertEqual(first, self.monitor.read()["instance_id"])
        self.monitor.stop()
        replacement = BtcAlertMonitor(state_path=self.path, clock=self.clock)
        self.monitor = replacement
        self.assertNotEqual(first, replacement.read()["instance_id"])
        self.assertLess(replacement.read()["revision"], 3)

    def test_midnight_trade_from_previous_day_cannot_move_new_day_price(self):
        self.baseline()
        self.trade(103)
        midnight = beijing_day_start(self.clock.ms) + DAY_MS
        self.clock.ms = midnight + 20
        self.assertFalse(self.trade(90, E=midnight + 10, T=midnight - 1))
        self.assertIsNone(self.monitor.read()["market"]["day_open"])
        self.assertIsNone(self.monitor.read()["market"]["change_pct"])
        self.assertEqual(1, len(self.market_alerts()))

    def test_fresh_recovery_after_stale_event_resumes_threshold_detection(self):
        self.baseline()
        self.clock.advance(20000)
        self.assertFalse(self.trade(110, E=self.clock.ms - 20000, T=self.clock.ms - 20000))
        self.assertEqual([], self.market_alerts())
        self.assertTrue(self.trade(103))
        self.assertEqual("live", self.monitor.read()["market"]["status"])
        self.assertEqual("up", self.market_alerts()[0]["direction"])

    def test_malformed_kline_is_atomic_and_cannot_replace_valid_baseline(self):
        self.baseline()
        before = self.monitor.read()["market"]
        self.clock.advance()
        for changes in ({"o": "200"}, {"h": "99"}, {"l": "101"},
                        {"c": "NaN"}, {"T": self.clock.ms}):
            event = daily_event(self.clock)
            event["k"].update(changes)
            self.assertFalse(self.monitor.ingest(event))
            state = self.monitor.read()["market"]
            for field in ("price", "day_open", "day_high", "day_low", "event_ms"):
                self.assertEqual(before[field], state[field])
        self.assertEqual([], self.market_alerts())

    def test_corrupted_state_reports_storage_error_and_keeps_safe_default_rule(self):
        self.monitor.stop()
        self.path.write_text('{"version": 1, "settings": {"sound": "yes"}}', encoding="utf-8")
        self.monitor = BtcAlertMonitor(state_path=self.path, clock=self.clock,
                                       notifier=lambda cancel: "played")
        snapshot = self.monitor.read()
        self.assertEqual(2.5, snapshot["settings"]["threshold_pct"])
        self.assertTrue(snapshot["settings"]["sound"])
        self.assertIsNotNone(snapshot["storage_error"])
        self.monitor.configure({"sound": False})
        self.assertIsNone(self.monitor.read()["storage_error"])

    def test_restart_marks_unfinished_sound_interrupted_and_never_replays_it(self):
        self.monitor.stop()
        self.path.write_text(json.dumps({"version": 1, "settings": {"sound": True},
            "alerts": [{"id": "unfinished", "kind": "test", "sound_status": "playing"}],
            "fired": []}), encoding="utf-8")
        calls = []
        self.monitor = BtcAlertMonitor(state_path=self.path, clock=self.clock,
                                       notifier=lambda cancel: calls.append(True) or "played")
        self.assertEqual("interrupted", self.monitor.read()["alerts"][0]["sound_status"])
        self.assertEqual([], calls)
        self.assertIsNone(self.monitor._sound_thread)

    def test_invalid_settings_are_atomic(self):
        original = self.monitor.read()["settings"]
        for changes in ({"sound": 1}, {"enabled": "yes"}, {"metric": "24h"},
                        {"threshold_pct": True}, {"threshold_pct": "2.5"},
                        {"threshold_pct": float("nan")}, {"threshold_pct": float("inf")},
                        {"threshold_pct": 0.099}, {"threshold_pct": 50.1},
                        {"threshold_pct": 3, "api_key": "unused"}, []):
            with self.assertRaises(ValueError):
                self.monitor.configure(changes)
            self.assertEqual(original, self.monitor.read()["settings"])

    def test_read_returns_copy_and_limits_live_chart_to_minute_buckets(self):
        self.baseline()
        for value in (100.1, 100.2, 100.3):
            self.trade(value)
        snapshot = self.monitor.read()
        self.assertEqual(1, len(snapshot["history"]))
        snapshot["settings"]["enabled"] = False
        snapshot["history"][0]["price"] = 0
        self.assertTrue(self.monitor.read()["settings"]["enabled"])
        self.assertEqual(100.3, self.monitor.read()["history"][0]["price"])

    def test_combined_url_preserves_plus_timezone(self):
        streams = parse_qs(urlsplit(WS_URL).query)["streams"][0]
        self.assertEqual("btcusdt@trade/btcusdt@kline_1d@+08:00", streams)

    def test_websocket_client_text_bytes_are_decoded(self):
        wrapped = {"stream": "btcusdt@kline_1d@+08:00", "data": daily_event(self.clock)}
        self.assertTrue(self.monitor.ingest(json.dumps(wrapped).encode("utf-8")))
        self.assertEqual("live", self.monitor.read()["market"]["status"])
        self.clock.advance()
        trade = {"e": "trade", "s": "BTCUSDT", "E": self.clock.ms,
                 "T": self.clock.ms, "t": 1, "p": "103"}
        self.assertTrue(self.monitor.ingest(bytearray(json.dumps(trade).encode("utf-8"))))
        self.assertEqual(1, len(self.market_alerts()))
        self.assertFalse(self.monitor.ingest(b"\xff"))

    def test_stop_rejects_late_events_and_settings(self):
        self.baseline()
        self.monitor.stop()
        self.assertFalse(self.trade(120))
        self.assertEqual("stopped", self.monitor.read()["market"]["status"])
        with self.assertRaises(RuntimeError):
            self.monitor.configure({"enabled": True})
        with self.assertRaises(RuntimeError):
            self.monitor.test_alarm()


class SoundTests(unittest.TestCase):
    def test_native_notification_runs_off_callback_thread_and_can_be_silenced(self):
        started = threading.Event()
        finished = threading.Event()
        calls = []

        def notifier(cancel):
            calls.append(threading.current_thread().name)
            started.set()
            cancel.wait(2)
            finished.set()
            return "silenced" if cancel.is_set() else "played"

        with tempfile.TemporaryDirectory() as directory:
            monitor = BtcAlertMonitor(state_path=Path(directory) / "state.json", notifier=notifier)
            try:
                state = monitor.test_alarm()
                self.assertEqual("test", state["alerts"][0]["kind"])
                self.assertTrue(started.wait(1))
                monitor.silence()
                self.assertTrue(finished.wait(1))
                monitor._sound_queue.join()
                self.assertEqual(["btc-alert-sound"], calls)
                self.assertEqual("silenced", monitor.read()["alerts"][0]["sound_status"])
                self.assertEqual([], list(monitor._fired))
            finally:
                monitor.stop()

    def test_sound_error_is_reported_and_worker_recovers(self):
        calls = []

        def notifier(cancel):
            calls.append(True)
            if len(calls) == 1:
                raise OSError("speaker unavailable")
            return "played"

        with tempfile.TemporaryDirectory() as directory:
            monitor = BtcAlertMonitor(state_path=Path(directory) / "state.json", notifier=notifier)
            try:
                monitor.test_alarm()
                monitor._sound_queue.join()
                first = monitor.read()["alerts"][0]
                self.assertEqual("error", first["sound_status"])
                self.assertIn("speaker unavailable", first["sound_error"])
                monitor.test_alarm()
                monitor._sound_queue.join()
                self.assertEqual("played", monitor.read()["alerts"][1]["sound_status"])
            finally:
                monitor.stop()

    def test_disabled_sound_and_unsupported_sound_are_honest(self):
        with tempfile.TemporaryDirectory() as directory:
            monitor = BtcAlertMonitor(state_path=Path(directory) / "state.json", notifier=lambda cancel: "unsupported")
            try:
                monitor.configure({"sound": False})
                monitor.test_alarm()
                self.assertEqual("disabled", monitor.read()["alerts"][0]["sound_status"])
                monitor.configure({"sound": True})
                monitor.test_alarm()
                monitor._sound_queue.join()
                self.assertEqual("unsupported", monitor.read()["alerts"][1]["sound_status"])
            finally:
                monitor.stop()

    def test_stopping_cancels_active_sound_and_clears_queue(self):
        started = threading.Event()
        calls = []

        def notifier(cancel):
            calls.append(True)
            started.set()
            cancel.wait(2)
            return "silenced"

        with tempfile.TemporaryDirectory() as directory:
            monitor = BtcAlertMonitor(state_path=Path(directory) / "state.json", notifier=notifier)
            monitor.test_alarm()
            self.assertTrue(started.wait(1))
            monitor.test_alarm()
            monitor.stop()
            self.assertEqual(1, len(calls))
            self.assertEqual(["silenced", "silenced"], [a["sound_status"] for a in monitor.read()["alerts"]])

    def test_disabling_sound_cancels_active_playback_and_remaining_queue(self):
        started = threading.Event()
        calls = []

        def notifier(cancel):
            calls.append(True)
            started.set()
            cancel.wait(2)
            return "silenced"

        with tempfile.TemporaryDirectory() as directory:
            monitor = BtcAlertMonitor(state_path=Path(directory) / "state.json", notifier=notifier)
            try:
                monitor.test_alarm()
                self.assertTrue(started.wait(1))
                monitor.test_alarm()
                monitor.configure({"sound": False})
                monitor._sound_queue.join()
                self.assertEqual(1, len(calls))
                self.assertEqual(["silenced", "silenced"],
                                 [alert["sound_status"] for alert in monitor.read()["alerts"]])
                monitor.test_alarm()
                self.assertEqual("disabled", monitor.read()["alerts"][-1]["sound_status"])
                self.assertEqual(1, len(calls))
            finally:
                monitor.stop()


class ClockCalibrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.mono = [100.0]
        self.monitor = BtcAlertMonitor(state_path=Path(self.temp.name) / "state.json",
                                      clock=self.clock, monotonic=lambda: self.mono[0])
        self.monitor.configure({"sound": False})
        self.monitor._injected_clock = False
        self.monitor._clock_status = "unverified"
        self.monitor._clock_offset_ms = None

    def tearDown(self):
        self.monitor.stop()
        self.temp.cleanup()

    def calibrate(self, offset_ms=10000, roundtrip_ms=100):
        before = self.clock.ms
        before_mono = self.mono[0]
        self.clock.advance(roundtrip_ms)
        self.mono[0] += roundtrip_ms / 1000
        self.monitor._calibrate_time({"serverTime": before + roundtrip_ms // 2 + offset_ms},
                                     before, self.clock.ms, before_mono, self.mono[0])

    def test_uncalibrated_production_clock_never_accepts_events(self):
        self.assertFalse(self.monitor.ingest(daily_event(self.clock, high="110", closing="110")))
        self.assertEqual("waiting_time", self.monitor.read()["market"]["status"])
        self.assertEqual([], self.monitor.read()["alerts"])

    def test_exchange_midpoint_offset_permits_fresh_stream_without_widening_age_limit(self):
        self.calibrate()
        event = daily_event(self.clock, high="103", closing="103", event_ms=self.clock.ms + 10000)
        self.assertTrue(self.monitor.ingest(event))
        state = self.monitor.read()
        self.assertEqual("calibrated", state["market"]["clock_status"])
        self.assertEqual(10000, state["market"]["clock_offset_ms"])
        self.assertEqual(100, state["market"]["clock_rtt_ms"])
        self.assertEqual(self.clock.ms + 10000, state["server_time_ms"])
        self.assertEqual(self.clock.ms + 10000, state["market"]["received_ms"])
        self.assertEqual("live", state["market"]["status"])
        self.assertEqual(1, len(state["alerts"]))

    def test_slow_time_request_does_not_create_offset(self):
        with self.assertRaises(ValueError):
            self.calibrate(roundtrip_ms=5000)
        self.assertEqual("unverified", self.monitor.read()["market"]["clock_status"])
        self.assertIsNone(self.monitor.read()["market"]["clock_offset_ms"])

    def test_wall_clock_jump_discards_old_offset_and_blocks_alerts(self):
        self.calibrate()
        self.clock.advance(20000)
        state = self.monitor.read()
        self.assertEqual("unverified", state["market"]["clock_status"])
        self.assertEqual("waiting_time", state["market"]["status"])
        self.assertIsNone(state["market"]["clock_offset_ms"])
        self.assertTrue(self.monitor._time_wakeup.is_set())
        self.assertFalse(self.monitor.ingest(daily_event(self.clock, high="110", closing="110")))
        self.assertEqual([], self.monitor.read()["alerts"])

    def test_clock_jump_during_calibration_is_rejected(self):
        before = self.clock.ms
        self.clock.advance(20000)
        with self.assertRaises(ValueError):
            self.monitor._calibrate_time({"serverTime": before + 10000}, before,
                                         self.clock.ms, self.mono[0], self.mono[0] + 0.1)
        self.assertIsNone(self.monitor.read()["market"]["clock_offset_ms"])

    def test_calibration_expires_after_one_hour(self):
        self.calibrate()
        self.clock.advance(3601000)
        self.mono[0] += 3601
        state = self.monitor.read()
        self.assertEqual("expired", state["market"]["clock_status"])
        self.assertEqual("waiting_time", state["market"]["status"])

    def test_recalibration_recovers_clock_jump_and_fresh_price(self):
        self.calibrate()
        self.clock.advance(20000)
        self.monitor.read()
        self.calibrate(offset_ms=-10000)
        event = daily_event(self.clock, event_ms=self.clock.ms - 10000)
        self.assertTrue(self.monitor.ingest(event))
        self.assertEqual("live", self.monitor.read()["market"]["status"])


class TransportTests(unittest.TestCase):
    def test_rate_limit_retries_honor_header_seconds_and_http_dates(self):
        self.assertEqual(120, retry_after_seconds("120"))
        now = datetime(2030, 1, 1, tzinfo=timezone.utc).timestamp()
        self.assertEqual(3600, retry_after_seconds("Tue, 01 Jan 2030 01:00:00 GMT", now=now))
        self.assertEqual(60, retry_after_seconds("nonsense"))
        self.assertEqual(60, retry_after_seconds("1e999"))
        with patch("btc_alert.urlopen", side_effect=HTTPError(
                "https://data-api.binance.vision/api/v3/klines", 429, "Too Many Requests", {"Retry-After": "123"}, io.BytesIO(b"rate limited"))):
            with self.assertRaises(PublicRateLimitError) as caught:
                fetch_public_json("https://data-api.binance.vision/api/v3/klines")
        self.assertEqual(123, caught.exception.retry_seconds)

    def test_rest_418_wait_is_not_shortened_by_normal_backoff(self):
        class RecordingStop(threading.Event):
            def __init__(self):
                super().__init__()
                self.waits = []

            def wait(self, timeout=None):
                self.waits.append(timeout)
                self.set()
                return True

        calls = []

        def fetcher(url):
            calls.append(url)
            raise PublicRateLimitError(418, 7200)

        with tempfile.TemporaryDirectory() as directory:
            monitor = BtcAlertMonitor(state_path=Path(directory) / "state.json", fetcher=fetcher)
            monitor._stop = RecordingStop()
            monitor._bootstrap_loop()
            self.assertEqual([7200], monitor._stop.waits)
            self.assertEqual(1, len(calls))
            self.assertIsNotNone(monitor.read()["market"]["rest_retry_at_ms"])
            monitor.stop()

    def test_single_shared_connection_rest_bootstrap_and_shutdown(self):
        clock = Clock()
        sockets = []
        socket_ready = threading.Event()

        class FakeSocket:
            def __init__(self, url, **callbacks):
                self.url = url
                self.callbacks = callbacks
                self.closed = threading.Event()
                sockets.append(self)

            def run_forever(self, **kwargs):
                self.callbacks["on_open"](self)
                self.callbacks["on_message"](self, json.dumps({"stream": "btcusdt@kline_1d@+08:00", "data": daily_event(clock)}))
                socket_ready.set()
                self.closed.wait(2)
                self.callbacks["on_close"](self, 1000, "closed")

            def close(self):
                self.closed.set()

        urls = []

        def fetcher(url):
            urls.append(url)
            start = beijing_day_start(clock.ms)
            return [[start, "100", "100", "100", "100", "0", start + DAY_MS - 1]]

        with tempfile.TemporaryDirectory() as directory:
            monitor = BtcAlertMonitor(state_path=Path(directory) / "state.json", clock=clock,
                                      ws_factory=FakeSocket, fetcher=fetcher)
            monitor.configure({"sound": False})
            try:
                monitor.start()
                monitor.start()
                self.assertTrue(socket_ready.wait(1))
                self.assertEqual("live", monitor.read()["market"]["status"])
                self.assertEqual(1, len(sockets))
                self.assertEqual(WS_URL, sockets[0].url)
                monitor.stop()
                self.assertTrue(sockets[0].closed.is_set())
                self.assertEqual(2, len(urls))
                self.assertTrue(all("timeZone=8" in url for url in urls))
            finally:
                monitor.stop()


if __name__ == "__main__":
    unittest.main()
