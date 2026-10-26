"""Second-pass adversarial transport and alert lifecycle checks; no live I/O."""
import io
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import binance_btc_options as market
from btc_alert import BtcAlertMonitor, DAY_MS, beijing_day_start, fetch_public_json
from test_btc_alert import Clock, daily_event


class SlowNotificationRestartTests(unittest.TestCase):
    def test_late_closed_sound_worker_cannot_overwrite_restarted_monitor_settings(self):
        entered, release = threading.Event(), threading.Event()

        def notification(_cancel):
            entered.set()
            release.wait(5)
            return "played"

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            old = BtcAlertMonitor(state_path=path, clock=Clock(), notifier=notification)
            new = None
            try:
                old.test_alarm()
                self.assertTrue(entered.wait(1))
                old.stop()  # Bounded shutdown may return before a driver does.
                self.assertTrue(old._sound_thread.is_alive())
                new = BtcAlertMonitor(state_path=path, clock=Clock(), notifier=lambda _: "unsupported")
                new.configure({"sound": False, "threshold_pct": 7.5})
                saved = path.read_text(encoding="utf-8")
                release.set()
                old._sound_thread.join(1)
                self.assertFalse(old._sound_thread.is_alive())
                self.assertEqual(saved, path.read_text(encoding="utf-8"), "a terminated monitor overwrote the new instance")
            finally:
                release.set()
                old.stop()
                if new:
                    new.stop()


class ExtremePublicPayloadTests(unittest.TestCase):
    def test_oversized_numeric_value_is_rejected_as_schema_failure_without_worker_exception(self):
        class Response(io.BytesIO):
            status = 200

            def __init__(self):
                body = ('{"serverTime":' + '9' * 400 + '}').encode()
                super().__init__(body)
                self.headers = {"Content-Length": str(len(body))}

        with patch.object(market, "_PUBLIC_REQUEST_LIMITER", market.PublicRequestLimiter()), \
                patch.object(market.urllib.request, "urlopen", return_value=Response()):
            result = market.get_public("/eapi/v1/time", 1, max_attempts=1)
        self.assertFalse(result["ok"])
        self.assertEqual("UNEXPECTED_SCHEMA", result["error"]["type"])
        self.assertNotIn("data", result)

    def test_exponent_overflow_in_nested_metadata_cannot_break_downstream_json_snapshots(self):
        class Response(io.BytesIO):
            status = 200

            def __init__(self):
                body = b'{"serverTime":1792182000000,"metadata":[{"overflow":1e999}]}'
                super().__init__(body)
                self.headers = {"Content-Length": str(len(body))}

        with patch.object(market, "_PUBLIC_REQUEST_LIMITER", market.PublicRequestLimiter()), \
                patch.object(market.urllib.request, "urlopen", return_value=Response()):
            result = market.get_public("/eapi/v1/time", 1, max_attempts=1)
        self.assertFalse(result["ok"])
        self.assertEqual("INVALID_JSON", result["error"]["type"])
        self.assertNotIn("data", result)
        json.dumps(result, allow_nan=False)


class SpotBootstrapCompletenessTests(unittest.TestCase):
    class Response(io.BytesIO):
        def __init__(self, body, length=None):
            super().__init__(body)
            self.headers = {"Content-Length": str(len(body) if length is None else length)}

    def test_a_valid_json_prefix_does_not_hide_the_rest_of_an_oversized_response(self):
        body = b'{"serverTime":1792182000000}' + b" " * 2000000 + b"not-json"
        with patch("btc_alert.urlopen", return_value=self.Response(body)):
            with self.assertRaises(ValueError):
                fetch_public_json("https://data-api.binance.vision/api/v3/time")

    def test_valid_json_in_a_truncated_declared_body_is_not_a_success(self):
        body = b'{"serverTime":1792182000000}'
        with patch("btc_alert.urlopen", return_value=self.Response(body, len(body) + 100)):
            with self.assertRaises(http.client.IncompleteRead):
                fetch_public_json("https://data-api.binance.vision/api/v3/time")

    def test_nonfinite_json_never_reaches_time_or_history_validation(self):
        for token in (b"NaN", b"Infinity", b"-Infinity"):
            with self.subTest(token=token), patch("btc_alert.urlopen", return_value=self.Response(b'{"serverTime":' + token + b'}')):
                with self.assertRaises(ValueError):
                    fetch_public_json("https://data-api.binance.vision/api/v3/time")

    def test_exponent_overflow_is_rejected_even_in_non_schema_fields(self):
        body = b'{"serverTime":1792182000000,"nested":[{"extra":1e999}]}'
        with patch("btc_alert.urlopen", return_value=self.Response(body)):
            with self.assertRaises(ValueError):
                fetch_public_json("https://data-api.binance.vision/api/v3/time")


class AlertMidnightCombinedTests(unittest.TestCase):
    def test_non_utf8_socket_bytes_cannot_be_auto_detected_as_another_json_encoding(self):
        clock = Clock()
        with tempfile.TemporaryDirectory() as directory:
            monitor = BtcAlertMonitor(state_path=Path(directory) / "state.json", clock=clock,
                notifier=lambda _: "unsupported")
            try:
                monitor.configure({"sound": False, "threshold_pct": 2.5})
                event = daily_event(clock, opening="100", high="110", closing="110")
                self.assertFalse(monitor.ingest(json.dumps(event).encode("utf-16")))
                self.assertIsNone(monitor.read()["market"]["day_open"])
                self.assertEqual([], monitor.read()["alerts"])
                self.assertTrue(monitor.ingest(json.dumps(event).encode("utf-8")))
                self.assertEqual(1, len(monitor.read()["alerts"]))
            finally:
                monitor.stop()

    def test_bad_and_delayed_events_around_midnight_do_not_contaminate_the_new_rule_day(self):
        clock = Clock()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            monitor = BtcAlertMonitor(state_path=path, clock=clock, notifier=lambda _: "unsupported")
            try:
                monitor.configure({"sound": False, "threshold_pct": 2.5})
                self.assertTrue(monitor.ingest(daily_event(clock)))
                trade = {"e": "trade", "s": "BTCUSDT", "E": clock.ms, "T": clock.ms, "t": 1, "p": "103"}
                self.assertTrue(monitor.ingest(trade))
                midnight = beijing_day_start(clock.ms) + DAY_MS
                clock.ms = midnight + 10
                state = monitor.read()["market"]
                for invalid in ({"E": None}, {"E": True}, {"T": None}, {"T": True}, {"p": "NaN"},
                                {"E": midnight + 60000}, {"T": midnight - 1}, {"t": False}):
                    event = dict(trade, E=clock.ms, T=clock.ms, t=2, p="1000")
                    event.update(invalid)
                    self.assertFalse(monitor.ingest(event))
                    actual = monitor.read()["market"]
                    for field in ("day_open", "day_high", "day_low", "change_pct", "event_ms", "price"):
                        self.assertEqual(state[field], actual[field], (invalid, field))
                self.assertTrue(monitor.ingest(daily_event(clock, opening="200")))
                self.assertTrue(monitor.ingest(dict(trade, E=clock.ms, T=clock.ms, t=2, p="206")))
                self.assertTrue(monitor.ingest(dict(trade, E=clock.ms, T=clock.ms, t=3, p="207")))
                alerts = monitor.read()["alerts"]
                self.assertEqual(2, len(alerts))
                self.assertEqual([midnight - DAY_MS, midnight], [alert["day_start_ms"] for alert in alerts])
                self.assertEqual(3.0, alerts[-1]["change_pct"])
            finally:
                monitor.stop()
            replacement = BtcAlertMonitor(state_path=path, clock=clock, notifier=lambda _: "unsupported")
            try:
                self.assertTrue(replacement.ingest(daily_event(clock, opening="200", high="207", closing="207")))
                self.assertEqual(2, len(replacement.read()["alerts"]), "restart repeated today's already fired rule")
            finally:
                replacement.stop()


if __name__ == "__main__":
    unittest.main()
