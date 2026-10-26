"""Offline alert-to-mail and loopback API integration; never sends real mail."""

import copy
import http.client
import json
import sqlite3
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch

from btc_alert import BtcAlertMonitor, DAY_MS, beijing_day_start
from btc_terminal_server import TerminalServer, replay_recent_email_alerts


class Clock:
    def __init__(self):
        self.ms = int(datetime(2030, 1, 2, 4, tzinfo=timezone.utc).timestamp() * 1000)

    def __call__(self):
        return self.ms / 1000


class AlertSinkIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "alert-state.json"
        self.clock = Clock()
        self.received = []
        self.monitors = []
        self.monitor = self.make_monitor(self.received.append)
        self.monitor.configure({"sound": False, 'threshold_pct': 2.5})
        self.trade_id = 0

    def tearDown(self):
        for monitor in self.monitors:
            monitor.stop()
        self.directory.cleanup()

    def make_monitor(self, sink, notifier=None):
        monitor = BtcAlertMonitor(state_path=self.path, clock=self.clock,
                                  alert_sink=sink, notifier=notifier or (lambda cancel: "played"))
        self.monitors.append(monitor)
        return monitor

    def baseline(self):
        start = beijing_day_start(self.clock.ms)
        return self.monitor.ingest({"e": "kline", "s": "BTCUSDT", "E": self.clock.ms,
            "k": {"s": "BTCUSDT", "i": "1d", "t": start, "T": start + DAY_MS - 1,
                  "o": "100", "h": "100", "l": "100", "c": "100"}})

    def trade(self, price):
        self.clock.ms += 10
        self.trade_id += 1
        return self.monitor.ingest({"e": "trade", "s": "BTCUSDT", "E": self.clock.ms,
            "T": self.clock.ms, "t": self.trade_id, "p": str(price)})

    def market_alerts(self):
        return [item for item in self.monitor.read()["alerts"] if item["kind"] == "market"]

    def test_only_real_market_alerts_enter_sink_and_sound_test_does_not(self):
        self.assertTrue(self.baseline())
        self.monitor.test_alarm()
        self.assertEqual([], self.received)
        self.trade(102.5)
        first_id = self.market_alerts()[0]["id"]
        self.assertEqual({first_id}, {item["id"] for item in self.received})
        self.monitor.test_alarm()
        self.assertTrue(all(item["kind"] == "market" for item in self.received))
        self.assertEqual({first_id}, {item["id"] for item in self.received})

    def test_both_directions_keep_the_original_durable_alert_ids(self):
        self.baseline()
        self.trade(103)
        self.trade(97)
        expected = {item["id"] for item in self.market_alerts()}
        self.assertEqual({"up", "down"}, {item["direction"] for item in self.received})
        self.assertEqual(expected, {item["id"] for item in self.received})
        self.assertEqual(expected, {item["id"] for item in json.loads(self.path.read_text("utf-8"))["alerts"]})

    def test_settings_replay_does_not_change_market_alert_deduplication(self):
        self.baseline()
        self.trade(103)
        original = self.market_alerts()
        self.received.clear()
        self.monitor.configure({"sound": False})
        self.assertEqual([original[0]["id"]], [item["id"] for item in self.received])
        self.trade(104)
        self.assertEqual(original, self.market_alerts())
        self.assertEqual([original[0]["id"]], [item["id"] for item in self.received])

    def test_restarted_monitor_can_replay_saved_ids_without_refiring_rule(self):
        self.baseline()
        self.trade(103)
        identifier = self.market_alerts()[0]["id"]
        self.monitor.stop()
        self.received.clear()
        self.monitor = self.make_monitor(self.received.append)
        self.monitor.configure({"sound": False})
        self.assertEqual([identifier], [item["id"] for item in self.received])
        self.baseline()
        self.trade(103)
        self.assertEqual([identifier], [item["id"] for item in self.market_alerts()])

    def test_sink_observes_an_alert_only_after_atomic_persistence(self):
        observed_durable = []

        def sink(alert):
            persisted = json.loads(self.path.read_text("utf-8"))
            observed_durable.append(alert["id"] in {item["id"] for item in persisted["alerts"]})

        self.monitor._alert_sink = sink
        self.baseline()
        self.trade(103)
        self.assertEqual([True], observed_durable)

    def test_failed_save_never_enqueues_and_successful_save_replays_same_alert(self):
        self.baseline()
        with patch("btc_alert.os.replace", side_effect=OSError("simulated disk failure")):
            self.assertTrue(self.trade(103))
        self.assertEqual([], self.received)
        self.assertIsNotNone(self.monitor.read()["storage_error"])
        identifier = self.market_alerts()[0]["id"]
        self.monitor.configure({"sound": False})
        self.assertIsNone(self.monitor.read()["storage_error"])
        self.assertEqual([identifier], [item["id"] for item in self.received])
        self.trade(104)
        self.assertEqual(1, len(self.market_alerts()))

    def test_sink_failure_is_sanitized_and_does_not_prevent_audio_or_fresh_quotes(self):
        played = threading.Event()
        secret = "DUMMY-INTEGRATION-SECRET-NEVER-REAL"

        def sink(_alert):
            raise RuntimeError(secret)

        def notifier(_cancel):
            played.set()
            return "played"

        self.monitor._alert_sink = sink
        self.monitor._notifier = notifier
        self.monitor.configure({"sound": True})
        self.baseline()
        self.assertTrue(self.trade(103))
        self.assertTrue(played.wait(2), "a failed mail queue must not prevent audio")
        deadline = time.monotonic() + 2
        while self.market_alerts()[0]["sound_status"] != "played" and time.monotonic() < deadline:
            time.sleep(.005)
        state = self.monitor.read()
        self.assertEqual("played", state["alerts"][0]["sound_status"])
        self.assertEqual("live", state["market"]["status"])
        self.assertIn("邮件", state["email_queue_error"])
        self.assertNotIn(secret, json.dumps(state))
        self.assertTrue(self.trade(104))
        self.assertEqual(104, self.monitor.read()["market"]["price"])
        self.monitor._alert_sink = self.received.append
        self.monitor.configure({"sound": False})
        self.assertIsNone(self.monitor.read()["email_queue_error"])

    def test_sink_receives_a_deep_copy_and_cannot_rewrite_alarm_history(self):
        def sink(alert):
            alert["id"] = "sink-mutated-id"
            alert["kind"] = "test"
            alert["sound_status"] = "sink-mutated-status"
            if "extra" in alert:
                alert["extra"]["values"].append("sink-mutated-nested-value")

        self.monitor._alert_sink = sink
        self.baseline()
        self.trade(103)
        original = self.market_alerts()[0]
        self.assertNotEqual("sink-mutated-id", original["id"])
        self.assertEqual("disabled", original["sound_status"])
        with self.monitor._lock:
            self.monitor._alerts[0]["extra"] = {"values": [1]}
        self.monitor.configure({"sound": False})
        self.assertEqual([1], self.market_alerts()[0]["extra"]["values"])
        stored = json.loads(self.path.read_text("utf-8"))["alerts"][0]
        self.assertEqual(original["id"], stored["id"])
        self.assertEqual([1], stored["extra"]["values"])

    def test_optional_sink_and_stopped_monitor_never_enqueue(self):
        self.monitor._alert_sink = None
        self.baseline()
        self.trade(103)
        self.assertEqual(1, len(self.market_alerts()))
        self.assertIsNone(self.monitor.read()["email_queue_error"])
        self.monitor._alert_sink = self.received.append
        self.monitor.stop()
        self.assertEqual([], self.received)
        self.assertFalse(self.trade(97))


class FakeMonitor:
    def __init__(self):
        self.settings = {"threshold_pct": 2.5}
        self.test_count = 0
        self.queue_error = None

    def read(self):
        return {"settings": self.settings.copy(), "email_queue_error": self.queue_error}

    def test_alarm(self):
        self.test_count += 1


class FakeEmailService:
    """Provider boundary only; no SMTP worker or credentials are accessed."""
    def __init__(self):
        self.calls = []
        self.tests = 0
        self.authorization_code = "DUMMY-INTEGRATION-CODE-NEVER-REAL"
        self.public = {"enabled": False, "configured": False, "recipient_masked": "qa***@qq.com",
                       "enabled_at": None, "last_error": None, "counts": {"queued": 0}, "recent": []}

    def configure(self, **body):
        self.calls.append(copy.deepcopy(body))
        self.public.update(enabled=body.get("enabled", False), configured=True)

    def enqueue_test(self):
        self.tests += 1
        self.public["counts"]["queued"] += 1

    def read_public(self):
        return copy.deepcopy(self.public)


class EmailApiIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.monitor = FakeMonitor()
        self.mail = FakeEmailService()
        self.server = TerminalServer(("127.0.0.1", 0), self.monitor, None, email_service=self.mail)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        self.host = "127.0.0.1:%s" % self.server.server_port
        self.origin = "http://" + self.host

    def tearDown(self):
        self.server.stopping.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def request(self, path, method="GET", body=None, headers=None, extra_headers=()):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.putrequest(method, path, skip_host=True)
        pairs = {"Host": self.host}
        if method == "POST":
            if body is None:
                body = b"{}"
            pairs.update({"Content-Type": "application/json", "X-Terminal-Request": "1",
                          "Origin": self.origin, "Content-Length": str(len(body))})
        pairs.update(headers or {})
        for key, value in list(pairs.items()) + list(extra_headers):
            if value is not None:
                connection.putheader(key, value)
        try:
            connection.endheaders(body)
            response = connection.getresponse()
            return response.status, response.headers, json.loads(response.read())
        finally:
            connection.close()

    def post(self, suffix, value, **kwargs):
        return self.request("/api/terminal/email/" + suffix, "POST", json.dumps(value).encode(), **kwargs)

    def test_public_status_is_uncached_and_never_echoes_authorization_code(self):
        status, headers, body = self.request("/api/terminal/email")
        self.assertEqual(200, status)
        self.assertEqual(self.mail.public, body)
        self.assertEqual("no-store", headers["Cache-Control"])
        self.assertEqual("nosniff", headers["X-Content-Type-Options"])
        self.assertEqual("SAMEORIGIN", headers["X-Frame-Options"])
        self.assertNotIn(self.mail.authorization_code, json.dumps(body))
        self.assertNotIn("authorization_code", body)

    def test_configuration_forwards_only_allowed_fields_and_returns_public_status(self):
        value = {"email": "qa-integration@qq.com", "authorization_code": "LOCALTESTONLY123", "enabled": True}
        status, _, result = self.post("settings", value)
        self.assertEqual(200, status)
        self.assertEqual([value], self.mail.calls)
        self.assertTrue(result["enabled"])
        self.assertNotIn(value["authorization_code"], json.dumps(result))
        self.assertNotIn("email", result)
        self.assertEqual(0, self.monitor.test_count)

    def test_explicit_mail_test_only_enqueues_mail_and_does_not_play_sound_test(self):
        status, _, result = self.post("test", {})
        self.assertEqual(200, status)
        self.assertEqual(1, self.mail.tests)
        self.assertEqual(1, result["counts"]["queued"])
        self.assertEqual(0, self.monitor.test_count)
        self.assertEqual([], self.mail.calls)

    def test_unknown_configuration_fields_and_test_parameters_are_rejected(self):
        for value in ({"recipient": "other@qq.com"}, {"smtp_host": "example.invalid"},
                      {"password": "dummy"}, {"url": "https://example.invalid"}):
            with self.subTest(value=value):
                self.assertEqual(400, self.post("settings", value)[0])
        for value in ({"email": "other@qq.com"}, {"enabled": True}, {"authorization_code": "dummy"}):
            self.assertEqual(400, self.post("test", value)[0])
        self.assertEqual([], self.mail.calls)
        self.assertEqual(0, self.mail.tests)

    def test_foreign_origin_and_rebinding_cannot_read_or_change_email(self):
        for headers in ({"Host": "evil.invalid"}, {"Origin": "https://evil.invalid"}, {"Origin": "null"}):
            with self.subTest(headers=headers):
                self.assertEqual(403, self.request("/api/terminal/email", headers=headers)[0])
                self.assertEqual(403, self.post("settings", {}, headers=headers)[0])
                self.assertEqual(403, self.post("test", {}, headers=headers)[0])
        self.assertEqual([], self.mail.calls)
        self.assertEqual(0, self.mail.tests)

    def test_json_and_local_action_headers_are_required_for_both_mutations(self):
        for suffix in ("settings", "test"):
            for headers in ({"Content-Type": "text/plain"}, {"X-Terminal-Request": None}, {"X-Terminal-Request": "0"}):
                with self.subTest(suffix=suffix, headers=headers):
                    self.assertEqual(403, self.post(suffix, {}, headers=headers)[0])
        self.assertEqual([], self.mail.calls)
        self.assertEqual(0, self.mail.tests)

    def test_duplicate_headers_are_rejected_before_mail_mutation(self):
        for key, value, status in (("Host", "evil.invalid", 403), ("Origin", self.origin, 403),
                                   ("X-Terminal-Request", "1", 403), ("Content-Type", "application/json", 403),
                                   ("Content-Length", "2", 400)):
            with self.subTest(header=key):
                self.assertEqual(status, self.post("test", {}, extra_headers=[(key, value)])[0])
        self.assertEqual(0, self.mail.tests)

    def test_invalid_raw_json_is_rejected_without_changing_settings(self):
        for raw in (b'{"enabled":true,"enabled":false}', b'{"enabled":NaN}',
                    b'{"enabled":Infinity}', b'{"enabled":-Infinity}', b'{"email":"\xff"}',
                    b'{"enabled":true', b'[]', b'null', b'"string"', b'true'):
            with self.subTest(raw=raw):
                self.assertEqual(400, self.request("/api/terminal/email/settings", "POST", raw)[0])
        self.assertEqual([], self.mail.calls)

    def test_oversized_ambiguous_or_streamed_bodies_do_not_reach_service(self):
        self.assertEqual(400, self.request("/api/terminal/email/settings", "POST", b" " * 4097)[0])
        self.assertEqual(400, self.post("test", {}, headers={"Content-Length": None})[0])
        self.assertEqual(400, self.post("test", {}, headers={"Transfer-Encoding": "chunked"})[0])
        self.assertEqual([], self.mail.calls)
        self.assertEqual(0, self.mail.tests)

    def test_missing_service_returns_503_for_status_settings_and_test(self):
        self.server.email_service = None
        for path, method in (("/api/terminal/email", "GET"), ("/api/terminal/email/settings", "POST"),
                             ("/api/terminal/email/test", "POST")):
            with self.subTest(path=path):
                status, _, body = self.request(path, method)
                self.assertEqual(503, status)
                self.assertIn("error", body)
        self.assertEqual(0, self.monitor.test_count)

    def test_queue_failures_are_reported_without_modifying_public_provider_state(self):
        self.monitor.queue_error = "邮件提醒暂未进入发送队列，请检查邮件设置。"
        status, _, body = self.request("/api/terminal/email")
        self.assertEqual(200, status)
        self.assertEqual(self.monitor.queue_error, body["last_error"])
        self.assertIsNone(self.mail.public["last_error"])
        self.monitor.queue_error = None
        self.assertIsNone(self.request("/api/terminal/email")[2]["last_error"])

    def test_provider_write_failures_return_sanitized_errors(self):
        for method, error, expected in (("configure", ValueError("invalid setting"), 400),
                                         ("configure", OSError("DUMMY-SECRET-PATH"), 503),
                                         ("enqueue_test", RuntimeError("DUMMY-SECRET-TRANSPORT"), 503),
                                         ("configure", sqlite3.OperationalError("DUMMY-SECRET-CONFIG-DB"), 503),
                                         ("enqueue_test", sqlite3.OperationalError("DUMMY-SECRET-QUEUE-DB"), 503)):
            with self.subTest(method=method, error=type(error).__name__), patch.object(self.mail, method, side_effect=error):
                suffix = "settings" if method == "configure" else "test"
                status, _, body = self.post(suffix, {})
                self.assertEqual(expected, status)
                self.assertNotIn("DUMMY-SECRET", json.dumps(body))
        self.assertEqual(0, self.monitor.test_count)

    def test_status_storage_failure_returns_sanitized_503_and_other_terminal_reads_continue(self):
        for error in (OSError("DUMMY-SECRET-DB-PATH"), sqlite3.OperationalError("DUMMY-SECRET-STATUS-DB"),
                      RuntimeError("DUMMY-SECRET-STOPPED")):
            with self.subTest(error=type(error).__name__), patch.object(self.mail, "read_public", side_effect=error):
                status, _, body = self.request("/api/terminal/email")
                self.assertEqual(503, status)
                self.assertNotIn("DUMMY-SECRET", json.dumps(body))
        self.assertEqual(200, self.request("/api/terminal")[0])


class EmailReplayTests(unittest.TestCase):
    def test_transient_outbox_failure_is_retried_from_the_same_durable_id(self):
        now = 1000000
        alert = {"id": "durable-id", "kind": "market", "local_at_ms": now, "at_ms": now - 8000}
        monitor, service = Mock(), Mock()
        monitor.read.return_value = {"alerts": [alert], "storage_error": None}
        service.enqueue.side_effect = [sqlite3.OperationalError("FAKE-BUSY"), True]
        replay_recent_email_alerts(monitor, service, now)
        replay_recent_email_alerts(monitor, service, now + 5000)
        self.assertEqual(2, service.enqueue.call_count)
        self.assertEqual("durable-id", service.enqueue.call_args[0][0]["id"])

    def test_replay_excludes_expired_test_future_and_unsaved_records(self):
        now = 2000000
        records = [{"kind": "market", "at_ms": now - 900001},
                   {"kind": "test", "at_ms": now},
                   {"kind": "market", "at_ms": now + 2001},
                   {"kind": "market", "at_ms": True},
                   {"kind": "market", "at_ms": float("nan")}]
        monitor, service = Mock(), Mock()
        monitor.read.return_value = {"alerts": records, "storage_error": None}
        replay_recent_email_alerts(monitor, service, now)
        service.enqueue.assert_not_called()
        monitor.read.return_value = {"alerts": [{"kind": "market", "at_ms": now}], "storage_error": "disk failed"}
        replay_recent_email_alerts(monitor, service, now)
        service.enqueue.assert_not_called()


if __name__ == "__main__":
    unittest.main()
