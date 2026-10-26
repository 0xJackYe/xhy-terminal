"""Offline QQ notification tests: no real SMTP, mailbox or credentials."""
import json
import os
import smtplib
import sqlite3
import ssl
import tempfile
import threading
import time
import unittest
from pathlib import Path
from email.parser import BytesParser
from email.policy import default
from unittest.mock import patch

from alert_email import EmailAlertService, TTL_MS, _dpapi


SECRET = "fixtureonlycodeab"
SENDER = "fixture@qq.com"


def seal(data):
    return bytes(value ^ 125 for value in data)


class SMTP:
    def __init__(self, calls, login_error=None, data_error=None, refused=None, entered=None, release=None):
        self.calls = calls
        self.login_error, self.data_error, self.refused = login_error, data_error, refused
        self.entered, self.release = entered, release

    def login(self, sender, secret):
        self.calls.append(("login", sender, secret))
        if self.login_error:
            raise self.login_error

    def sendmail(self, sender, recipients, packet):
        self.calls.append(("data", sender, recipients, packet))
        if self.entered:
            self.entered.set()
        if self.release:
            self.release.wait(4)
        if self.data_error:
            raise self.data_error
        return self.refused or {}

    def close(self):
        self.calls.append(("close",))


class EmailServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.now = [1900000000.0]
        self.calls = []
        self.factory_calls = []
        self.services = []

    def tearDown(self):
        for service in self.services:
            service.stop()
        self.directory.cleanup()

    def service(self, factory=None, **kwargs):
        def smtp_factory(*args, **options):
            self.factory_calls.append((args, options))
            return SMTP(self.calls)
        result = EmailAlertService(self.directory.name, smtp_factory=factory or smtp_factory,
            seal=kwargs.pop("seal", seal), unseal=kwargs.pop("unseal", seal),
            clock=lambda: self.now[0], **kwargs)
        self.services.append(result)
        return result

    def configured(self, **kwargs):
        service = self.service(**kwargs)
        service.configure(SENDER, SECRET, True)
        return service

    def alert(self, identifier="alert-one", age=0, **extra):
        return dict({"id": identifier, "kind": "market", "at_ms": int(self.now[0] * 1000) - age,
                     "metric": "daily_change", "direction": "up", "threshold_pct": 2.5,
                     "change_pct": 2.6, "range_pct": 3.0, "price": 90000}, **extra)

    def wait_state(self, service, state, timeout=2):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            public = service.status()
            if public["counts"].get(state):
                return public
            time.sleep(.01)
        self.fail("notification state did not become " + state)

    def send_one(self, service):
        claimed = service._claim()
        self.assertIsNotNone(claimed)
        service._send(claimed)

    def test_configuration_protects_code_and_exposes_only_masked_safe_status(self):
        service = self.configured()
        public = json.dumps(service.read_public())
        self.assertTrue(service.status()["configured"])
        self.assertTrue(service.status()["enabled"])
        self.assertEqual("ox***@qq.com", service.status()["recipient_masked"])
        self.assertNotIn(SECRET, public)
        self.assertNotIn(SENDER, public)
        self.assertNotIn("oxjackye@qq.com", public)
        config = Path(self.directory.name, "email-config.protected.json").read_text()
        self.assertNotIn(SECRET, config)
        self.assertNotIn("authorization_code", config)
        service.stop()
        restored = self.service()
        self.assertTrue(restored.status()["configured"])
        self.assertEqual(service.status()["enabled_at"], restored.status()["enabled_at"])

    def test_unconfigured_disabled_old_future_and_test_records_never_auto_send(self):
        service = self.service()
        self.assertFalse(service.enqueue(self.alert()))
        with self.assertRaises(ValueError):
            service.test()
        service.configure(SENDER, SECRET, False)
        self.assertFalse(service.enqueue(self.alert()))
        self.now[0] += 1
        service.configure(enabled=True)
        for alert in (self.alert("old", age=1001), self.alert("future", age=-3000),
                      self.alert("test", kind="test"), self.alert("bad\nid"), self.alert("nan", at_ms=float("nan"))):
            self.assertFalse(service.enqueue(alert))
        self.assertEqual(0, sum(service.status()["counts"].values()))
        self.assertEqual([], self.calls)

    def test_asynchronous_delivery_is_durable_deduplicated_and_only_claims_acceptance(self):
        service = self.configured()
        alert = self.alert()
        self.assertTrue(service.enqueue(alert))
        self.assertFalse(service.enqueue(alert))
        service.stop()
        replacement = self.service()
        replacement.start()
        self.wait_state(replacement, "accepted")
        self.assertFalse(replacement.enqueue(alert))
        data = [call for call in self.calls if call[0] == "data"]
        self.assertEqual(1, len(data))
        self.assertEqual(["oxjackye@qq.com"], data[0][2])
        self.assertNotIn(SECRET.encode(), data[0][3])
        self.assertIn(b"Message-ID:", data[0][3])
        self.assertEqual(("smtp.qq.com", 465), self.factory_calls[0][0])
        context = self.factory_calls[0][1]["context"]
        self.assertTrue(context.check_hostname)
        self.assertEqual(ssl.CERT_REQUIRED, context.verify_mode)
        self.assertNotIn("delivered", json.dumps(replacement.status()))

    def test_inflight_restart_becomes_unknown_without_automatic_replay(self):
        service = self.configured()
        service.enqueue(self.alert())
        self.assertIsNotNone(service._claim())
        replacement = self.service()
        replacement.start()
        self.assertEqual(1, replacement.status()["counts"]["unknown"])
        self.assertFalse(replacement.enqueue(self.alert()))
        self.assertEqual([], self.calls)

    def test_data_timeout_is_unknown_and_never_blindly_retried(self):
        service = self.configured(factory=lambda *a, **kw: SMTP(self.calls, data_error=TimeoutError(SECRET)))
        service.enqueue(self.alert())
        self.send_one(service)
        self.assertEqual(1, service.status()["counts"]["unknown"])
        self.now[0] += 30
        self.assertIsNone(service._claim())
        self.assertNotIn(SECRET, json.dumps(service.status()))
        self.assertEqual(1, len([call for call in self.calls if call[0] == "data"]))

    def test_authentication_failure_is_permanent_and_error_is_sanitized(self):
        service = self.configured(factory=lambda *a, **kw: SMTP(self.calls,
            login_error=smtplib.SMTPAuthenticationError(535, SECRET.encode())))
        service.enqueue(self.alert())
        self.send_one(service)
        self.assertEqual(1, service.status()["counts"]["failed"])
        self.assertIn("授权码", service.status()["last_error"])
        self.assertNotIn(SECRET, json.dumps(service.status()))
        self.assertEqual([], [call for call in self.calls if call[0] == "data"])

    def test_connection_failure_has_bounded_retry_before_data_only(self):
        def fail(*args, **kwargs):
            self.calls.append(("connect",))
            raise OSError(SECRET)
        service = self.configured(factory=fail)
        service.enqueue(self.alert())
        self.send_one(service)
        self.assertEqual(1, service.status()["counts"]["queued"])
        self.assertIsNone(service._claim())
        self.now[0] += 5
        self.send_one(service)
        self.now[0] += 10
        self.send_one(service)
        self.assertEqual(1, service.status()["counts"]["failed"])
        self.assertEqual(3, len(self.calls))
        self.assertNotIn(SECRET, json.dumps(service.status()))

    def test_ttl_expiry_and_disabled_or_updated_configuration_cancel_pending_jobs(self):
        service = self.configured()
        service.enqueue(self.alert("expires"))
        self.now[0] += TTL_MS / 1000 + 1
        self.assertIsNone(service._claim())
        self.assertEqual(1, service.status()["counts"]["expired"])
        service.enqueue(self.alert("disable"))
        service.configure(enabled=False)
        self.assertEqual(1, service.status()["counts"]["cancelled"])
        self.now[0] += 1
        service.configure(enabled=True)
        service.enqueue(self.alert("new-code"))
        self.now[0] += 1
        service.configure(authorization_code="updatedfixtureab")
        self.assertEqual(2, service.status()["counts"]["cancelled"])
        self.assertFalse(service.enqueue(self.alert("before-change", age=1)))

    def test_explicit_test_is_separate_and_never_generated_from_old_test_alert(self):
        service = self.configured()
        self.assertFalse(service.enqueue(self.alert(kind="test")))
        queued = service.test()
        self.assertEqual("queued", queued["state"])
        self.send_one(service)
        self.assertEqual("test", service.status()["recent"][0]["kind"])
        self.assertEqual(1, service.status()["counts"]["accepted"])

    def test_slow_smtp_does_not_block_enqueue_and_stopped_worker_cannot_write_new_instance(self):
        entered, release = threading.Event(), threading.Event()
        service = self.configured(factory=lambda *a, **kw: SMTP(self.calls, entered=entered, release=release))
        service.enqueue(self.alert("inflight"))
        service.start()
        try:
            self.assertTrue(entered.wait(1))
            before = time.monotonic()
            self.assertTrue(service.enqueue(self.alert("other")))
            self.assertLess(time.monotonic() - before, .3)
            before = time.monotonic()
            service.stop()
            self.assertLess(time.monotonic() - before, 1.5)
            replacement = self.service()
            self.now[0] += 1
            replacement.configure(authorization_code="updatedfixtureab")
            saved = Path(self.directory.name, "email-config.protected.json").read_bytes()
            release.set()
            service._thread.join(1)
            self.assertEqual(saved, Path(self.directory.name, "email-config.protected.json").read_bytes())
            self.assertEqual(1, replacement.status()["counts"]["unknown"])
            self.assertEqual(0, replacement.status()["counts"]["accepted"])
        finally:
            release.set()

    def test_configuration_failure_leaves_saved_settings_and_secret_private(self):
        service = self.configured()
        saved = Path(self.directory.name, "email-config.protected.json").read_bytes()
        service._seal = lambda _data: (_ for _ in ()).throw(ValueError(SECRET))
        with self.assertRaisesRegex(ValueError, "加密失败") as error:
            service.configure(authorization_code="updatedfixtureab")
        self.assertNotIn(SECRET, str(error.exception))
        self.assertEqual(saved, Path(self.directory.name, "email-config.protected.json").read_bytes())
        with self.assertRaises(ValueError):
            service.configure(email="other@qq.com")

    def test_blank_fields_keep_existing_code_and_repeat_enable_keeps_the_activation_time(self):
        service = self.configured()
        enabled_at = service.status()["enabled_at"]
        self.now[0] += 5
        service.configure(email="", authorization_code="", enabled=True)
        self.assertEqual(enabled_at, service.status()["enabled_at"])
        service.enqueue(self.alert())
        self.send_one(service)
        self.assertEqual(("login", SENDER, SECRET), self.calls[0])

    def test_local_creation_time_handles_exchange_clock_skew_without_replaying_old_alerts(self):
        service = self.configured()
        current_local = int(self.now[0] * 1000)
        self.assertTrue(service.enqueue(self.alert("negative-skew", at_ms=current_local - 1500, local_at_ms=current_local)))
        self.assertFalse(service.enqueue(self.alert("old-positive-skew", at_ms=current_local + 1500, local_at_ms=current_local - 1)))
        self.send_one(service)
        self.assertEqual(1, service.status()["counts"]["accepted"])

    def test_disabled_enqueue_skips_sqlite_and_busy_sqlite_does_not_hold_market_callback(self):
        service = self.configured()
        service.configure(enabled=False)
        with patch.object(service, "_db", side_effect=AssertionError("disabled enqueue opened SQLite")):
            self.assertFalse(service.enqueue(self.alert()))
        service.configure(enabled=True)
        blocker = sqlite3.connect(str(service._db_path))
        try:
            blocker.execute("BEGIN IMMEDIATE")
            began = time.monotonic()
            self.assertFalse(service.enqueue(self.alert()))
            self.assertLess(time.monotonic() - began, .2)
        finally:
            blocker.rollback()
            blocker.close()
        self.assertTrue(service.enqueue(self.alert()))

    def test_non_text_configuration_is_rejected_without_replacing_saved_state(self):
        service = self.configured()
        for value in (True, 1, {}, [], [SECRET]):
            for field in ("email", "authorization_code"):
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    service.configure(**{field: value})
        self.assertTrue(service.status()["enabled"])
        self.assertTrue(service.status()["configured"])

    def test_mobile_subject_includes_actual_direction_or_range_price_and_date(self):
        service = self.configured()
        service.enqueue(self.alert("down", direction="down", change_pct=-2.7, price=85000))
        self.send_one(service)
        first = BytesParser(policy=default).parsebytes([call for call in self.calls if call[0] == "data"][-1][3])
        self.assertIn("下跌 2.70%", str(first["Subject"]))
        self.assertIn("85000.00 USDT", str(first["Subject"]))
        self.assertIsNotNone(first["Date"])
        service.enqueue(self.alert("range", metric="day_range", direction="range", range_pct=4.2, change_pct=1.1))
        self.send_one(service)
        second = BytesParser(policy=default).parsebytes([call for call in self.calls if call[0] == "data"][-1][3])
        self.assertIn("当日振幅 4.20%", str(second["Subject"]))
        self.assertNotIn("上涨", str(second["Subject"]))

    def test_replacement_waits_for_an_atomic_configuration_change_and_reads_the_new_ciphertext(self):
        service = self.configured()
        entered, release = threading.Event(), threading.Event()
        replacement, errors = [], []

        def protected(data):
            entered.set()
            release.wait(1)
            return seal(data)

        def update():
            try:
                service.configure(authorization_code="updatedfixtureab")
            except Exception as error:
                errors.append(type(error).__name__)

        def replace():
            try:
                replacement.append(self.service())
            except Exception as error:
                errors.append(type(error).__name__)

        service._seal = protected
        first = threading.Thread(target=update)
        second = threading.Thread(target=replace)
        first.start()
        self.assertTrue(entered.wait(1))
        second.start()
        release.set()
        first.join(2)
        second.join(2)
        self.assertEqual([], errors)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual("updatedfixtureab", replacement[0]._secret)
        self.assertFalse(service.enqueue(self.alert()))

    def test_stop_is_idempotent_and_rejects_new_jobs_and_configuration(self):
        service = self.configured()
        service.stop()
        service.stop()
        self.assertFalse(service.enqueue(self.alert()))
        for operation in (service.start, service.test, lambda: service.configure(enabled=True)):
            with self.assertRaises(RuntimeError):
                operation()

    @unittest.skipUnless(os.name == "nt", "Windows DPAPI integration")
    def test_windows_current_user_dpapi_round_trip_uses_ciphertext(self):
        plain = b"temporary-fixture-only"
        encrypted = _dpapi(plain)
        self.assertNotEqual(plain, encrypted)
        self.assertNotIn(plain, encrypted)
        self.assertEqual(plain, _dpapi(encrypted, decrypt=True))


if __name__ == "__main__":
    unittest.main()
