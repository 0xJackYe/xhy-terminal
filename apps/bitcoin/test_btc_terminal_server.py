"""Local API security and public wallet relay integration checks."""
import io
import http.client
import json
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timezone
from unittest.mock import patch

from btc_terminal_server import OPTIONS_STATIC, TerminalServer, WalletProxy, ProxyError, history_delta, market_view


ADDRESS = "bc1q" + "a" * 38


class FakeMonitor:
    def __init__(self):
        self.settings = {"threshold_pct": 2.5}
        self.test_count = self.silence_count = 0

    def read(self):
        return {"settings": self.settings}

    def configure(self, settings):
        if set(settings) - {"threshold_pct"}:
            raise ValueError("unknown setting")
        self.settings.update(settings)

    def test_alarm(self, sound_level=1):
        self.test_count += 1
        self.last_sound_level = sound_level

    def silence(self):
        self.silence_count += 1


class FakeOptionsCache:
    def __init__(self):
        self._stop = threading.Event()
        self.refresh_count = 0

    def read(self):
        return {"credentials_used": False, "options": [{"symbol": "BTC-261127-84000-C"}]}

    def request_refresh(self):
        self.refresh_count += 1

    def wait_revision(self, revision, timeout=15):
        if revision >= 1:
            self._stop.wait(timeout)
        return 1

    def wait_snapshot(self, revision, timeout=0):
        return 1, self.read()

    def wait_market_frame(self, revision, timeout=15):
        if revision >= 1:
            self._stop.wait(timeout)
            return revision, None
        payload = json.dumps(self.read(), separators=(",", ":")).encode("utf-8")
        return 1, b"id: 1\nevent: snapshot\ndata: " + payload + b"\n\n"


class TerminalTests(unittest.TestCase):
    def setUp(self):
        self.monitor = FakeMonitor()
        self.options = FakeOptionsCache()
        self.server = TerminalServer(("127.0.0.1", 0), self.monitor, WalletProxy(ADDRESS), self.options)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:%s" % self.server.server_address[1]

    def tearDown(self):
        self.server.stopping.set()
        self.options._stop.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def call(self, path, method="GET", value=None, headers=None):
        data = json.dumps(value).encode() if value is not None else None
        request = urllib.request.Request(self.url + path, data=data, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers, exc.read()

    def mutation(self, path, value, headers=None):
        base = {"Content-Type": "application/json", "X-Terminal-Request": "1", "Origin": self.url}
        base.update(headers or {})
        return self.call(path, "POST", value, base)

    def raw_post(self, body, extra_headers=()):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.putrequest("POST", "/api/terminal/settings")
        connection.putheader("Content-Type", "application/json")
        connection.putheader("X-Terminal-Request", "1")
        connection.putheader("Origin", self.url)
        connection.putheader("Content-Length", str(len(body)))
        for key, value in extra_headers:
            connection.putheader(key, value)
        connection.endheaders(body)
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_state_read_and_static_whitelist(self):
        status, headers, data = self.call("/api/terminal")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["settings"]["threshold_pct"], 2.5)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Frame-Options"], "SAMEORIGIN")
        for path in ("/../btc_alert.py", "/%2e%2e/btc_alert.py", "/terminal/data/terminal-alert-state.json", "/api/account"):
            self.assertEqual(self.call(path)[0], 404)

    def test_rebinding_and_foreign_origin_rejected(self):
        self.assertEqual(self.call("/api/terminal", headers={"Host": "evil.invalid"})[0], 403)
        self.assertEqual(self.call("/api/terminal", headers={"Origin": "https://evil.invalid"})[0], 403)
        self.assertEqual(self.mutation("/api/terminal/test", {}, {"Origin": "null"})[0], 403)
        self.assertEqual(self.monitor.test_count, 0)

    def test_only_authorized_json_actions_can_change_monitor(self):
        self.assertEqual(self.call("/api/terminal/test", "POST", {})[0], 403)
        self.assertEqual(self.mutation("/api/terminal/test", {}, {"Content-Type": "text/plain"})[0], 403)
        self.assertEqual(self.call("/api/terminal/test", "OPTIONS")[0], 405)
        self.assertEqual(self.mutation("/api/terminal/test", {})[0], 200)
        self.assertEqual(self.monitor.test_count, 1)
        self.assertEqual(self.mutation("/api/terminal/silence", {})[0], 200)
        self.assertEqual(self.monitor.silence_count, 1)
        self.assertEqual(self.mutation("/api/terminal/settings", {"threshold_pct": 3})[0], 200)
        self.assertEqual(self.monitor.settings["threshold_pct"], 3)

    def test_invalid_bodies_and_order_routes_rejected(self):
        for value in ([], {"sound": "yes"}):
            self.assertEqual(self.mutation("/api/terminal/settings", value)[0], 400)
        self.assertEqual(self.mutation("/api/terminal/test", {"url": "https://example.com"})[0], 400)
        self.assertEqual(self.mutation("/api/order", {})[0], 405)
        self.assertEqual(self.mutation("/api/terminal/settings", {"threshold_pct": "x" * 5000})[0], 400)

    def test_sound_preview_level_is_bounded_and_audio_files_are_served(self):
        for level in (1, 2, 3):
            self.assertEqual(200, self.mutation('/api/terminal/test', {'sound_level': level})[0])
            self.assertEqual(level, self.monitor.last_sound_level)
        for level in (True, 0, 4, '2', 1.5):
            self.assertEqual(400, self.mutation('/api/terminal/test', {'sound_level': level})[0])
        self.assertEqual(3, self.monitor.test_count)
        for filename in ('alert.wav', 'alert-2.wav', 'alert-3.wav'):
            status, headers, data = self.call('/audio/' + filename)
            self.assertEqual(200, status)
            self.assertEqual('audio/wav', headers['Content-Type'])
            self.assertTrue(data.startswith(b'RIFF'))

    def test_duplicate_json_and_non_json_numbers_do_not_change_settings(self):
        for body in (b'{"threshold_pct": 3, "threshold_pct": 4}',
                     b'{"threshold_pct": NaN}', b'{"threshold_pct": Infinity}',
                     b'{"threshold_pct": -Infinity}', b'{"threshold_pct": 3',
                     b'{"threshold_pct": "\xff"}'):
            with self.subTest(body=body):
                self.assertEqual(self.raw_post(body)[0], 400)
                self.assertEqual(2.5, self.monitor.settings["threshold_pct"])

    def test_ambiguous_duplicate_request_headers_are_rejected_before_mutation(self):
        for header, value, status in (("Host", "evil.invalid", 403),
                                     ("Origin", "https://evil.invalid", 403),
                                     ("Content-Type", "text/plain", 403),
                                     ("X-Terminal-Request", "1", 403),
                                     ("Content-Length", "20", 400)):
            with self.subTest(header=header):
                self.assertEqual(self.raw_post(b'{"threshold_pct": 3}', [(header, value)])[0], status)
                self.assertEqual(2.5, self.monitor.settings["threshold_pct"])

    def test_stopped_monitor_returns_explicit_unavailable_response(self):
        for action, method in (("settings", "configure"), ("test", "test_alarm"),
                               ("silence", "silence")):
            with self.subTest(action=action), patch.object(self.monitor, method,
                    side_effect=RuntimeError("monitor is stopped")):
                body = {"threshold_pct": 3} if action == "settings" else {}
                status, _, payload = self.mutation("/api/terminal/" + action, body)
                self.assertEqual(503, status)
                self.assertIn("error", json.loads(payload))

    def test_browser_disconnect_does_not_prevent_later_snapshot_request(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        response = None
        try:
            connection.request("GET", "/app.js")
            response = connection.getresponse()
            self.assertEqual(200, response.status)
            # Abandon the script/body unread, as when switching pages.
        finally:
            if response is not None:
                response.close()
            connection.close()
        status, _, payload = self.call("/api/terminal")
        self.assertEqual(200, status)
        self.assertEqual(2.5, json.loads(payload)["settings"]["threshold_pct"])

    def test_static_content_types_do_not_scan_the_platform_mime_registry(self):
        with patch("btc_terminal_server.mimetypes.guess_type",
                   side_effect=AssertionError("static serving must not initialize platform MIME data")) as guess:
            for asset, expected in (("/", "text/html; charset=utf-8"),
                                    ("/app.js", "text/javascript; charset=utf-8"),
                                    ("/anthropic.css", "text/css; charset=utf-8"),
                                    ("/audio/alert.wav", "audio/wav")):
                with self.subTest(asset=asset):
                    status, headers, payload = self.call(asset)
                    self.assertEqual(200, status)
                    self.assertEqual(expected, headers["Content-Type"])
                    self.assertTrue(payload)
            guess.assert_not_called()

    def test_sse_is_current_shared_state(self):
        with urllib.request.urlopen(self.url + "/api/terminal/events", timeout=2) as response:
            self.assertEqual(response.headers.get_content_type(), "text/event-stream")
            lines = [response.readline() for _ in range(4)]
            payload = next(line[6:] for line in lines if line.startswith(b"data: "))
            self.assertEqual(json.loads(payload)["settings"], self.monitor.settings)

    def test_market_view_stream_omits_chart_history(self):
        self.monitor.read = lambda: {"settings": self.monitor.settings, "market": {"price": 1.0}, "revision": 3,
                                     "history": [{"time_ms": 1, "price": 1.0}], "alerts": [{"id": str(i)} for i in range(12)]}
        with urllib.request.urlopen(self.url + "/api/terminal/events?view=market", timeout=2) as response:
            lines = [response.readline() for _ in range(4)]
            payload = json.loads(next(line[6:] for line in lines if line.startswith(b"data: ")))
        self.assertNotIn("history", payload)
        self.assertEqual(payload["market"], {"price": 1.0})
        self.assertEqual([alert["id"] for alert in payload["alerts"]], [str(i) for i in range(4, 12)])

    def test_options_page_and_original_scripts_share_the_terminal_origin(self):
        status, headers, body = self.call("/options.html")
        self.assertEqual(status, 200)
        markup = body.decode("utf-8")
        self.assertIn('id="expiryTabs"', markup)
        self.assertIn('src="/terminal-embed.js"', markup)
        self.assertIn('href="/options.html" aria-label="BTC 期权看板首页"', markup)
        for asset in ("app.js", "portfolio.js", "payoff.js", "anthropic.css", "terminal-embed.js",
                      "risk-metrics.js", "risk-ui.js", "risk.css"):
            self.assertEqual(self.call("/" + asset)[0], 200)

    def test_options_cache_is_shared_and_gets_no_refresh_for_ordinary_reads(self):
        for _ in range(3):
            status, headers, payload = self.call("/api/market")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(payload)["options"][0]["symbol"], "BTC-261127-84000-C")
        self.assertEqual(self.options.refresh_count, 0)
        self.call("/api/market?refresh=1")
        self.assertEqual(self.options.refresh_count, 1)

    def test_quote_dependencies_load_without_retired_seller_interfaces(self):
        status, _, body = self.call("/options.html")
        self.assertEqual(200, status)
        markup = body.decode("utf-8")
        for asset, content_type in (("payoff.js", "text/javascript; charset=utf-8"),
                                    ("payoff-ui.js", "text/javascript; charset=utf-8"),
                                    ("payoff.css", "text/css; charset=utf-8"),
                                    ("app.js", "text/javascript; charset=utf-8")):
            with self.subTest(asset=asset):
                self.assertIn('"/' + asset + '"', markup)
                status, headers, payload = self.call("/" + asset)
                self.assertEqual(200, status)
                self.assertEqual(content_type, headers["Content-Type"])
                self.assertEqual((OPTIONS_STATIC / asset).read_bytes(), payload)
                self.assertTrue(payload)
        for asset in ("sell-put-engine.js", "sell-put-ui.js", "sell-put.css",
                      "seller-screen-engine.js", "seller-screen-ui.js", "seller-screen.css"):
            self.assertNotIn('"/' + asset + '"', markup)
        for retired_id in ("sellerScreen", "sellerAdvanced", "sellPutDialog", "ruleButton", "callRuleButton"):
            self.assertNotIn('id="' + retired_id + '"', markup)
        self.assertIn('id="payoffDailyPremiumCard"', markup)

    def test_options_event_stream_remains_compatible(self):
        with urllib.request.urlopen(self.url + "/api/events", timeout=2) as response:
            self.assertEqual(response.headers.get_content_type(), "text/event-stream")
            lines = [response.readline() for _ in range(5)]
            payload = next(line[6:] for line in lines if line.startswith(b"data: "))
            self.assertEqual(json.loads(payload), self.options.read())

    def test_options_trade_methods_are_still_unavailable(self):
        self.assertEqual(self.mutation("/api/market", {})[0], 405)
        self.assertEqual(self.mutation("/api/order", {})[0], 405)
        self.assertEqual(self.call("/api/account")[0], 404)


class LiveStreamTests(unittest.TestCase):
    @staticmethod
    def point(minute, price):
        return {"time_ms": minute * 60000 + 5000, "price": price}

    def test_history_is_sent_once_then_only_its_newest_points(self):
        first = [self.point(m, 100 + m) for m in range(3)]
        sent, held = history_delta({"history": first, "revision": 1}, None)
        self.assertEqual(sent["history"], first)
        # The current minute moves: only that point travels.
        moved = first[:2] + [self.point(2, 150)]
        sent, held = history_delta({"history": moved}, held)
        self.assertNotIn("history", sent)
        self.assertEqual(sent["history_tail"], [self.point(2, 150)])
        # A new minute starts: the finished minute and the new one travel.
        grown = moved + [self.point(3, 160)]
        sent, held = history_delta({"history": grown}, held)
        self.assertEqual(sent["history_tail"], [self.point(2, 150), self.point(3, 160)])
        self.assertEqual(held, grown)

    def test_any_change_to_earlier_minutes_resends_the_full_history(self):
        start = [self.point(m, 100) for m in range(4)]
        _, held = history_delta({"history": start}, None)
        for changed in (start[1:] + [self.point(4, 100)],           # oldest minute trimmed
                        [self.point(0, 99)] + start[1:],            # an earlier minute corrected
                        [],                                         # day rollover cleared it
                        start + [self.point(4, 1), self.point(5, 1)]):  # two new minutes at once
            sent, _ = history_delta({"history": changed}, held)
            self.assertEqual(sent["history"], changed)
            self.assertNotIn("history_tail", sent)
        self.assertEqual(history_delta({"settings": {}}, held), ({"settings": {}}, held))

    def test_market_view_keeps_quote_rules_and_recent_alerts_only(self):
        value = {"market": {"price": 2}, "settings": {"enabled": True}, "revision": 9, "instance_id": "a",
                 "server_time_ms": 5, "history": [1, 2], "alerts": list(range(20)), "storage_error": None}
        self.assertEqual(market_view(value), {"market": {"price": 2}, "settings": {"enabled": True}, "revision": 9,
                                              "instance_id": "a", "server_time_ms": 5, "alerts": list(range(12, 20))})


class RelayTests(unittest.TestCase):
    def test_transient_public_connection_and_server_failures_recover_once(self):
        for error in (urllib.error.URLError('temporary reset'),
                      urllib.error.HTTPError('https://mempool.space/', 503, 'unavailable', {}, None)):
            calls = []
            def open_fake(request, timeout):
                calls.append(timeout)
                if len(calls) == 1:
                    raise error
                return io.BytesIO(b'{"USD": 83000}')
            proxy = WalletProxy(ADDRESS, opener=open_fake)
            with self.subTest(error=type(error).__name__):
                self.assertEqual(83000, json.loads(proxy.read({'resource': ['quote']}))['USD'])
                self.assertEqual(2, len(calls))
                proxy.read({'resource': ['quote']})
                self.assertEqual(2, len(calls), 'Recovered result must be cached for other consumers')

    def test_public_retry_budget_is_shared_and_permanent_http_errors_do_not_retry(self):
        clock, timeouts = [1], []
        def slow(request, timeout):
            timeouts.append(timeout)
            if len(timeouts) == 1:
                clock[0] += 13
                raise TimeoutError()
            return io.BytesIO(b'{"USD": 83000}')
        proxy = WalletProxy(ADDRESS, opener=slow, clock=lambda: clock[0])
        proxy.read({'resource': ['quote']})
        self.assertEqual([12, 5], timeouts)
        calls = []
        def forbidden(request, timeout):
            calls.append(True)
            raise urllib.error.HTTPError(request.full_url, 403, 'denied', {}, None)
        proxy = WalletProxy(ADDRESS, opener=forbidden)
        with self.assertRaises(ProxyError):
            proxy.read({'resource': ['quote']})
        self.assertEqual(1, len(calls))

    def test_failed_public_retries_never_relabel_previous_cache_as_fresh(self):
        clock, failed, calls = [1], [False], []
        def open_fake(request, timeout):
            calls.append(True)
            if failed[0]:
                raise TimeoutError()
            return io.BytesIO(b'{"USD": 83000}')
        proxy = WalletProxy(ADDRESS, opener=open_fake, clock=lambda: clock[0])
        params = {'resource': ['quote']}
        proxy.read(params)
        before = dict(proxy._cache)
        failed[0], clock[0] = True, 32
        with self.assertRaises(ProxyError):
            proxy.read(params)
        self.assertEqual(3, len(calls))
        self.assertEqual(before, proxy._cache)

    def test_slow_fx_does_not_block_independent_prices(self):
        started, finish = threading.Event(), threading.Event()
        def open_fake(req, timeout):
            if "frankfurter" in req.full_url:
                started.set()
                finish.wait(2)
                return io.BytesIO(b'[]')
            return io.BytesIO(b'{"USD": 83000}')
        proxy = WalletProxy(ADDRESS, opener=open_fake)
        fx = {"resource": ["fx"], "from": ["2026-01-01"], "to": ["2026-10-14"]}
        thread = threading.Thread(target=lambda: proxy.read(fx), daemon=True)
        thread.start()
        self.assertTrue(started.wait(1))
        try:
            self.assertEqual(json.loads(proxy.read({"resource": ["quote"]}))["USD"], 83000)
            self.assertFalse(finish.is_set())
            self.assertTrue(thread.is_alive(), "Quote must return before the slow FX request finishes")
        finally:
            finish.set()
            thread.join(2)

    def test_fixed_public_targets_and_validation(self):
        proxy = WalletProxy(ADDRESS)
        self.assertEqual(proxy.target({"resource": ["quote"]})[1], "https://mempool.space/api/v1/prices")
        self.assertTrue(proxy.target({"resource": ["fx"], "from": ["2026-01-01"], "to": ["2026-10-14"]})[1].startswith("https://api.frankfurter.dev/v2/rates?"))
        cases = [
            {"resource": ["address"], "address": ["https://127.0.0.1"]},
            {"resource": ["transactions"], "address": [ADDRESS], "cursor": ["../"]},
            {"resource": ["quote"], "url": ["http://localhost"]},
            {"resource": ["quote", "address"]},
            {"resource": ["fx"], "from": ["2026-02-30"], "to": ["2026-10-14"]},
            {"resource": ["fx"], "from": ["2026-11-01"], "to": ["2026-10-14"]},
        ]
        for params in cases:
            with self.assertRaises(ValueError):
                proxy.target(params)

    def test_tabs_share_cached_provider_data(self):
        calls = []
        clock = [1]
        def open_fake(req, timeout):
            calls.append(req.full_url)
            return io.BytesIO(b'{"USD": 83000}')
        proxy = WalletProxy(ADDRESS, opener=open_fake, clock=lambda: clock[0])
        for _ in range(3):
            self.assertEqual(json.loads(proxy.read({"resource": ["quote"]}))["USD"], 83000)
        self.assertEqual(len(calls), 1)
        clock[0] += 31
        proxy.read({"resource": ["quote"]})
        self.assertEqual(len(calls), 2)

    def test_rate_limit_backoff_is_shared_by_provider(self):
        calls = []
        def fail(req, timeout):
            calls.append(req.full_url)
            raise urllib.error.HTTPError(req.full_url, 429, "Limited", {"Retry-After": "120"}, None)
        proxy = WalletProxy(ADDRESS, opener=fail, clock=lambda: 1)
        with self.assertRaises(ProxyError) as first:
            proxy.read({"resource": ["quote"]})
        self.assertEqual(first.exception.retry_after, 120)
        with self.assertRaises(ProxyError):
            proxy.read({"resource": ["history"]})
        self.assertEqual(len(calls), 1)

    def test_http_date_retry_after_and_missing_ban_header_are_not_shortened(self):
        instant = datetime(2030, 1, 1, tzinfo=timezone.utc).timestamp()
        for status, headers, expected in ((429, {"Retry-After": "Tue, 01 Jan 2030 01:00:00 GMT"}, 3600),
                                          (418, {}, 3600), (429, {"Retry-After": "nonsense"}, 60)):
            calls = []

            def fail(req, timeout):
                calls.append(req.full_url)
                raise urllib.error.HTTPError(req.full_url, status, "Limited", headers, None)

            proxy = WalletProxy(ADDRESS, opener=fail, clock=lambda: 1)
            with self.subTest(status=status, headers=headers), patch("btc_alert.time.time", return_value=instant):
                with self.assertRaises(ProxyError) as limited:
                    proxy.read({"resource": ["quote"]})
                self.assertEqual(expected, limited.exception.retry_after)
                with self.assertRaises(ProxyError):
                    proxy.read({"resource": ["history"]})
                self.assertEqual(1, len(calls))

    def test_concurrent_same_resource_requests_share_one_upstream_result(self):
        entered, release = threading.Event(), threading.Event()
        calls, results = [], []

        def open_fake(req, timeout):
            calls.append(req.full_url)
            entered.set()
            release.wait(2)
            return io.BytesIO(b'{"USD": 83000}')

        proxy = WalletProxy(ADDRESS, opener=open_fake)
        threads = [threading.Thread(target=lambda: results.append(proxy.read({"resource": ["quote"]})))
                   for _ in range(6)]
        for thread in threads:
            thread.start()
        self.assertTrue(entered.wait(1))
        release.set()
        for thread in threads:
            thread.join(2)
            self.assertFalse(thread.is_alive())
        self.assertEqual(1, len(calls))
        self.assertEqual([b'{"USD": 83000}'] * 6, results)

    def test_invalid_json_and_oversized_provider_response_are_never_cached(self):
        for payload in (b'not json', b'x' * (8 * 1024 * 1024 + 1)):
            calls = []

            def open_fake(req, timeout):
                calls.append(True)
                return io.BytesIO(payload)

            proxy = WalletProxy(ADDRESS, opener=open_fake)
            with self.subTest(size=len(payload)):
                for _ in range(2):
                    with self.assertRaises(ProxyError):
                        proxy.read({"resource": ["quote"]})
                self.assertEqual(2, len(calls))
                self.assertEqual({}, proxy._cache)


if __name__ == "__main__":
    unittest.main()
