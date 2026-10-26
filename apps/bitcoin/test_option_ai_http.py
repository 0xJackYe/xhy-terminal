"""Real loopback HTTP acceptance on both local dashboard servers, fully offline."""
import copy
import http.client
import json
import threading
import time
import unittest
from unittest.mock import patch

from btc_terminal_server import TerminalServer
from dashboard_server import DashboardServer
from option_ai_engine import screen_snapshot
from option_ai_service import AIServiceError, OptionAIService
from test_option_ai_engine import NOW
from test_option_ai_service import FakeClient, MemoryVault, PublicMarket


JOB = "0123456789abcdef0123456789abcdef"
PREFIX = "/api/option-ai"


class BoundaryService:
    """Record only boundary dispatch; actual calculations have separate tests."""
    def __init__(self):
        self.calls = []
        self.failure = None

    def record(self, method, *args):
        self.calls.append((method, args))
        if self.failure is not None:
            raise self.failure

    def status(self):
        self.record("status")
        return {"configured": True, "models": [{"id": "deepseek-flash", "label": "V4.1 Flash"}],
                "default_model": "deepseek-flash", "active_jobs": 0}

    def configure(self, api_key):
        self.record("configure", api_key)
        return {"configured": True}

    def submit(self, question=None, model=None, history=None, previous_criteria=None,
               risk_profile=None, expiry=None, quantity=None):
        self.record("submit", question, model, history)
        if previous_criteria is not None:
            self.record("previous_criteria", previous_criteria)
        if risk_profile is not None:
            self.record("risk_profile", risk_profile, expiry, quantity)
        return {"job_id": JOB, "status": "queued"}

    def read_job(self, job_id):
        self.record("read_job", job_id)
        return {"status": "complete", "result": {"candidates": []}}

    def cancel(self, job_id):
        self.record("cancel", job_id)
        return {"status": "cancelled"}

    def revalidate(self, job_id):
        self.record("revalidate", job_id)
        return {"status": "complete", "result": {"candidates": [], "snapshot": {"revision": 2}}}

    def select(self, symbol, criteria, risk_profile=None):
        self.record("select", symbol, criteria)
        if risk_profile is not None:
            self.record("select_profile", risk_profile)
        return {"candidate": {"symbol": symbol}, "row": {"symbol": symbol}, "snapshot": {"revision": 3}}


class Monitor:
    def read(self):
        return {"settings": {"threshold_pct": 2.5}}


class Cache:
    def __init__(self):
        self._stop = threading.Event()
        self.refreshes = 0

    def read(self):
        return {"options": [], "btc_index_price": "80000", "revision": 7, "credentials_used": False}

    def request_refresh(self):
        self.refreshes += 1


class RunningServer:
    def __init__(self, kind, service):
        self.cache = Cache()
        if kind == "dashboard":
            self.server = DashboardServer(("127.0.0.1", 0), self.cache, ai_service=service)
        else:
            self.server = TerminalServer(("127.0.0.1", 0), Monitor(), None, self.cache, ai_service=service)
        self.port = self.server.server_port
        self.host = "127.0.0.1:%s" % self.port
        self.origin = "http://" + self.host
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()

    def close(self):
        self.cache._stop.set()
        if hasattr(self.server, "stopping"):
            self.server.stopping.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(1)

    def call(self, path, method="GET", value=None, raw=None, headers=None, extra=(), length=None):
        if raw is None:
            raw = json.dumps(value, ensure_ascii=False).encode("utf-8") if value is not None else b""
        standard = [("Host", self.host)]
        if method in ("POST", "DELETE"):
            standard += [("Origin", self.origin), ("X-Terminal-Request", "1")]
        if method == "POST":
            standard += [("Content-Type", "application/json"), ("Content-Length", str(len(raw) if length is None else length))]
        elif raw or length is not None:
            standard += [("Content-Length", str(len(raw) if length is None else length))]
        if headers is not None:
            for name, value in headers.items():
                standard = [(key, current) for key, current in standard if key.lower() != name.lower()]
                if value is not None:
                    standard.append((name, value))
        standard += list(extra)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            for name, value in standard:
                connection.putheader(name, value)
            connection.endheaders(raw)
            response = connection.getresponse()
            payload = response.read()
            return response.status, response.headers, json.loads(payload)
        finally:
            connection.close()


class AIBoundaryHTTPTests(unittest.TestCase):
    def setUp(self):
        self.services = {kind: BoundaryService() for kind in ("dashboard", "terminal")}
        self.servers = {kind: RunningServer(kind, service) for kind, service in self.services.items()}

    def tearDown(self):
        for server in self.servers.values():
            server.close()

    def each(self):
        return self.servers.items()

    def test_read_status_and_valid_same_origin_json_routes_on_both_servers(self):
        for kind, server in self.each():
            with self.subTest(server=kind):
                status, headers, body = server.call(PREFIX + "/status")
                self.assertEqual(status, 200)
                self.assertTrue(body["configured"])
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
                self.assertEqual(server.call(PREFIX + "/config", "POST", {"api_key": "synthetic-only"})[0], 200)
                self.assertEqual(server.call(PREFIX + "/jobs", "POST", {"question": "筛选卖 Put", "model": "deepseek-flash"})[0], 202)
                self.assertEqual(server.call(PREFIX + "/jobs/" + JOB)[0], 200)
                self.assertEqual(server.call(PREFIX + "/jobs/" + JOB, "DELETE")[2], {"status": "cancelled"})
                self.assertEqual(server.call(PREFIX + "/jobs/" + JOB + "/revalidate", "POST", {})[0], 200)
                criteria = {"direction": "SELL", "type": "PUT", "quantity": .01}
                symbol = "BTC-301011-70000-P"
                self.assertEqual(server.call(PREFIX + "/selection", "POST", {"symbol": symbol, "criteria": criteria})[0], 200)
                self.assertIn(("select", (symbol, criteria)), self.services[kind].calls)

    def test_config_response_never_echoes_the_submitted_secret(self):
        for kind, server in self.each():
            with self.subTest(server=kind):
                status, _, body = server.call(PREFIX + "/config", "POST", {"api_key": "sk-offline-test-credential-000000000"})
                self.assertEqual(status, 200)
                self.assertNotIn("sk-offline", json.dumps(body))

    def test_foreign_origin_dns_rebinding_wrong_port_and_ambiguous_host_are_rejected(self):
        for kind, server in self.each():
            cases = [{"Host": "evil.invalid"}, {"Host": "127.0.0.1:1"}, {"Host": "localhost"},
                     {"Host": None}, {"Origin": "null"}, {"Origin": "https://" + server.host},
                     {"Origin": "http://evil.invalid"}, {"Origin": "http://localhost:" + str(server.port)}]
            for headers in cases:
                with self.subTest(server=kind, headers=headers):
                    self.assertEqual(server.call(PREFIX + "/status", headers=headers)[0], 403)
            for extra in (("Host", server.host), ("Origin", server.origin)):
                with self.subTest(server=kind, duplicate=extra[0]):
                    self.assertEqual(server.call(PREFIX + "/jobs", "POST", {"question": "q", "model": "deepseek-flash"}, extra=[extra])[0], 403)
            self.assertEqual(self.services[kind].calls, [])

    def test_localhost_with_its_matching_origin_is_accepted(self):
        for kind, server in self.each():
            with self.subTest(server=kind):
                host = "localhost:" + str(server.port)
                status = server.call(PREFIX + "/config", "POST", {"api_key": "synthetic-only"},
                                     headers={"Host": host, "Origin": "http://" + host})[0]
                self.assertEqual(status, 200)

    def test_writes_require_one_terminal_header_and_one_json_content_type(self):
        for kind, server in self.each():
            for path, method, value in (("/config", "POST", {"api_key": "synthetic"}),
                                        ("/jobs", "POST", {"question": "q", "model": "deepseek-flash"}),
                                        ("/jobs/" + JOB, "DELETE", None),
                                        ("/jobs/" + JOB + "/revalidate", "POST", {}),
                                        ("/selection", "POST", {"symbol": "BTC-301011-70000-P", "criteria": {}})):
                for headers in ({"X-Terminal-Request": None}, {"X-Terminal-Request": "true"}):
                    with self.subTest(server=kind, path=path, headers=headers):
                        self.assertEqual(server.call(PREFIX + path, method, value, headers=headers)[0], 403)
            for headers, extra in (({"Content-Type": None}, ()), ({"Content-Type": "text/plain"}, ()),
                                    ({}, [("Content-Type", "application/json")]),
                                    ({}, [("X-Terminal-Request", "1")])):
                with self.subTest(server=kind, headers=headers, extra=extra):
                    self.assertEqual(server.call(PREFIX + "/config", "POST", {"api_key": "synthetic"}, headers=headers, extra=extra)[0], 403)
            self.assertEqual(self.services[kind].calls, [])

    def test_json_duplicate_keys_nonfinite_numbers_invalid_utf8_and_non_objects_are_rejected(self):
        invalid = [b'{"api_key":"a","api_key":"b"}', b'{"api_key":NaN}', b'{"api_key":Infinity}',
                   b'{"api_key":-Infinity}', b'{"api_key":"\xff"}', b'{"api_key":', b'[]', b'null', b'"text"',
                   b'{"question":"q","model":"deepseek-flash","history":[{"role":"user","role":"assistant","content":"q"}]}']
        for kind, server in self.each():
            for raw in invalid:
                with self.subTest(server=kind, body=raw):
                    self.assertEqual(server.call(PREFIX + "/config", "POST", raw=raw)[0], 400)
            self.assertEqual(self.services[kind].calls, [])

    def test_declared_size_invalid_lengths_chunking_and_duplicate_lengths_are_rejected(self):
        for kind, server in self.each():
            for length in (0, -1, 65537, "no-number"):
                with self.subTest(server=kind, length=length):
                    self.assertEqual(server.call(PREFIX + "/config", "POST", raw=b"", length=length)[0], 400)
            for headers, extra in (({"Content-Length": None}, ()), ({}, [("Content-Length", "2")]),
                                    ({"Transfer-Encoding": "chunked"}, ())):
                with self.subTest(server=kind, headers=headers, extra=extra):
                    self.assertEqual(server.call(PREFIX + "/config", "POST", raw=b"{}", headers=headers, extra=extra)[0], 400)
            self.assertEqual(self.services[kind].calls, [])

    def test_delete_rejects_body_and_streaming_but_dispatches_bodyless_cancel(self):
        for kind, server in self.each():
            with self.subTest(server=kind):
                self.assertEqual(server.call(PREFIX + "/jobs/" + JOB, "DELETE", raw=b"{}")[0], 400)
                self.assertEqual(server.call(PREFIX + "/jobs/" + JOB, "DELETE", headers={"Transfer-Encoding": "chunked"})[0], 400)
                self.assertEqual(self.services[kind].calls, [])
                self.assertEqual(server.call(PREFIX + "/jobs/" + JOB, "DELETE")[0], 200)
                self.assertEqual(self.services[kind].calls, [("cancel", (JOB,))])

    def test_closed_schemas_reject_extra_fields_missing_fields_and_revalidate_payload(self):
        invalid = [("/config", {}), ("/config", {"api_key": "synthetic", "url": "https://other.invalid"}),
                   ("/jobs", {"question": "q"}), ("/jobs", {"question": "q", "model": "deepseek-flash", "order": True}),
                   ("/selection", {"symbol": "BTC-301011-70000-P"}),
                   ("/selection", {"symbol": "BTC-301011-70000-P", "criteria": {}, "price": 100}),
                   ("/jobs/" + JOB + "/revalidate", {"criteria": {}})]
        for kind, server in self.each():
            for path, value in invalid:
                with self.subTest(server=kind, path=path, fields=list(value)):
                    self.assertEqual(server.call(PREFIX + path, "POST", value)[0], 400)
            self.assertEqual(self.services[kind].calls, [])

    def test_queries_invalid_job_ids_and_unsupported_methods_never_dispatch(self):
        for kind, server in self.each():
            for path in ("/status?x=1", "/jobs/" + JOB + "?x=1"):
                with self.subTest(server=kind, path=path):
                    self.assertEqual(server.call(PREFIX + path)[0], 400)
            cases = [("/jobs/../config", "GET", None), ("/jobs/" + "a" * 31, "GET", None),
                     ("/jobs/" + JOB.upper(), "GET", None), ("/jobs/" + JOB + "/revalidate", "GET", None),
                     ("/status", "DELETE", None), ("/jobs/" + JOB, "POST", {}),
                     ("/unknown", "POST", {}), ("/status", "OPTIONS", None), ("/config", "PUT", None)]
            for path, method, value in cases:
                with self.subTest(server=kind, path=path, method=method):
                    self.assertEqual(server.call(PREFIX + path, method, value)[0], 405)
            self.assertEqual(self.services[kind].calls, [])

    def test_service_errors_are_mapped_without_traceback_or_sensitive_exception_text(self):
        for kind, server in self.each():
            for error, expected in ((AIServiceError("busy", "筛选队列已满。", 429), 429),
                                    (AIServiceError("not_found", "筛选已失效。", 404), 404),
                                    (ValueError("sk-offline-sensitive-error"), 400),
                                    (RuntimeError("sk-offline-sensitive-error"), 503)):
                with self.subTest(server=kind, error_type=type(error).__name__):
                    self.services[kind].failure = error
                    status, _, body = server.call(PREFIX + "/status")
                    self.assertEqual(status, expected)
                    self.assertNotIn("sk-offline", json.dumps(body))
                    self.assertNotIn("Traceback", json.dumps(body))
            self.services[kind].failure = None
            self.assertEqual(server.call(PREFIX + "/status")[0], 200)

    def test_structured_previous_criteria_reaches_service_on_both_ports(self):
        criteria = {"expiry": "2030-01-11", "quantity": .03, "max_abs_delta": .2}
        for kind, server in self.each():
            status, _, result = server.call(PREFIX + "/jobs", "POST", {
                "question": "再加一个条件", "model": "deepseek-flash", "previous_criteria": criteria})
            self.assertEqual(status, 202)
            self.assertIn(("previous_criteria", (criteria,)), self.services[kind].calls)

    def test_risk_presets_dispatch_same_origin_jobs_and_selection_on_both_ports(self):
        for kind, server in self.each():
            for profile in ("low", "medium", "high"):
                status, _, result = server.call(PREFIX + "/jobs", "POST", {
                    "model": "deepseek-flash", "risk_profile": profile, "expiry": "ALL", "quantity": .03})
                self.assertEqual(status, 202)
                self.assertIn(("risk_profile", (profile, "ALL", .03)), self.services[kind].calls)
            criteria = {"direction": "SELL", "type": "PUT"}
            self.assertEqual(server.call(PREFIX + "/selection", "POST", {
                "symbol": "BTC-301011-70000-P", "criteria": criteria, "risk_profile": "low"})[0], 200)
            self.assertIn(("select_profile", ("low",)), self.services[kind].calls)

    def test_risk_presets_reject_mixed_conversation_or_arbitrary_thresholds(self):
        for kind, server in self.each():
            for extra in ({"question": "change my risk"}, {"history": []}, {"previous_criteria": {}},
                          {"max_abs_delta": .99}, {"criteria": {}}, {"api_key": "sk-fake"}):
                self.assertEqual(server.call(PREFIX + "/jobs", "POST", {
                    "model": "deepseek-flash", "risk_profile": "low", **extra})[0], 400)

    def test_ai_unavailable_preserves_core_market_and_normal_static_assets(self):
        for kind, server in self.each():
            with self.subTest(server=kind):
                server.server.ai_service = None
                self.assertEqual(server.call(PREFIX + "/status")[0], 503)
                self.assertEqual(server.call("/api/market")[0], 200)
                self.assertFalse(server.call("/api/market")[2]["credentials_used"])


class SlowModelHTTPTests(unittest.TestCase):
    def test_slow_ai_does_not_block_market_status_cancel_or_another_worker(self):
        release = threading.Event()
        self.addCleanup(release.set)
        market = PublicMarket()
        def action(call, count):
            if call["question"] == "slow":
                release.wait(3)
        client = FakeClient(action)
        service = OptionAIService(market.read, client=client, vault=MemoryVault(), workers=2)
        self.addCleanup(service.stop)
        screen = patch("option_ai_service.screen_snapshot",
                       side_effect=lambda value, criteria: screen_snapshot(value, criteria, now_ms=NOW))
        screen.start()
        self.addCleanup(screen.stop)
        servers = [RunningServer(kind, service) for kind in ("dashboard", "terminal")]
        for server in servers:
            self.addCleanup(server.close)
        try:
            first_status, _, first = servers[0].call(PREFIX + "/jobs", "POST", {"question": "slow", "model": "deepseek-flash"})
            self.assertEqual(first_status, 202)
            self.assertTrue(client.started.wait(1))
            self.assertFalse(release.is_set())
            for server in servers:
                start = time.monotonic()
                for unused in range(4):
                    self.assertEqual(server.call("/api/market")[0], 200)
                    self.assertEqual(server.call(PREFIX + "/status")[0], 200)
                self.assertLess(time.monotonic() - start, 1.5, "core HTTP waited for a blocked model")
            status, _, second = servers[1].call(PREFIX + "/jobs", "POST", {"question": "fast", "model": "deepseek-flash"})
            self.assertEqual(status, 202)
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                job = servers[1].call(PREFIX + "/jobs/" + second["job_id"])[2]
                if job["status"] == "complete":
                    break
                threading.Event().wait(.002)
            self.assertEqual(job["status"], "complete")
            self.assertEqual(servers[0].call(PREFIX + "/jobs/" + first["job_id"], "DELETE")[2], {"status": "cancelled"})
            self.assertFalse(release.is_set(), "fast HTTP checks must finish before slow model is released")
        finally:
            release.set()
            service.stop()
            for thread in service._threads:
                thread.join(1)


if __name__ == "__main__":
    unittest.main()
