"""Tests use local fixture servers only; no model calls or wallet mutations."""
import datetime as dt
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import server
import services


def meal(status="eaten", protein=10):
    return {"id": "fixed-meal", "type": "lunch", "status": status, "title": "午餐",
            "items": [{"nutrition": {"kcal": 100, "protein": protein, "carbs": 15, "fat": 2, "fiber": None, "saturatedFat": 1}}]}


class OverviewTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / "data").mkdir()
        self.config = server.Config(diet_root=self.root, diet_port=1)
        self.diary = {"schemaVersion": 1, "updatedAt": "2026-10-26T08:00:00+08:00", "days": [
            {"date": "2026-10-24", "meals": [meal(), meal("planned")]},
            {"date": "2026-10-26", "meals": [meal(protein=None)]}]}
        (self.root / "data" / "diary.json").write_text(json.dumps(self.diary), encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def test_unknown_nutrients_and_planned_food_are_not_counted_as_zero_or_eaten(self):
        with patch("server.safe_read", return_value=None):
            result = server.diet_overview(self.config, dt.date(2026, 10, 26))
        self.assertEqual(result["today"]["totals"]["kcal"], 100)
        self.assertIsNone(result["today"]["totals"]["protein"])
        self.assertEqual(result["week"]["totals"]["kcal"], 200)
        self.assertEqual(result["week"]["recordedDays"], 2)
        self.assertEqual(result["week"]["days"][4]["mealCount"], 1)
        self.assertIsNone(result["week"]["days"][0]["totals"]["kcal"])

    def test_diary_day_changes_at_utc_midnight_not_beijing_midnight(self):
        # 01:30 Beijing on 10-28 is still the 10-27 night shift; 08:00 Beijing starts 10-28.
        self.assertEqual(server.diary_today(dt.datetime(2026, 10, 28, 1, 30, tzinfo=server.BEIJING)), dt.date(2026, 10, 27))
        self.assertEqual(server.diary_today(dt.datetime(2026, 10, 28, 7, 59, tzinfo=server.BEIJING)), dt.date(2026, 10, 27))
        self.assertEqual(server.diary_today(dt.datetime(2026, 10, 28, 8, 0, tzinfo=server.BEIJING)), dt.date(2026, 10, 28))

    def test_live_store_and_atomic_runtime_store_take_precedence_over_seed(self):
        live = dict(self.diary, days=[])
        with patch("server.safe_read", return_value={"diary": live}):
            self.assertFalse(server.diet_overview(self.config, dt.date(2026, 10, 26))["recorded"])
        (self.root / ".local").mkdir()
        (self.root / ".local" / "runtime-diary.json").write_text(json.dumps({"diary": live, "revision": 4}), encoding="utf-8")
        with patch("server.safe_read", return_value=None):
            self.assertFalse(server.diet_overview(self.config, dt.date(2026, 10, 26))["recorded"])

    def test_corrupt_runtime_does_not_silently_show_old_seed(self):
        (self.root / ".local").mkdir()
        (self.root / ".local" / "runtime-diary.json").write_text("[]", encoding="utf-8")
        with patch("server.safe_read", return_value=None):
            result = server.diet_overview(self.config)
        self.assertEqual(result["status"], "offline")
        self.assertIsNone(result["today"])

    def test_disconnected_assets_and_alerts_are_null_and_stale(self):
        wallet = server.wallet_overview(None, None)
        alerts = server.alerts_overview(None)
        self.assertIsNone(wallet["totalUsd"])
        self.assertTrue(wallet["stale"])
        self.assertIsNone(alerts["price"])
        self.assertIsNone(alerts["enabled"])
        self.assertTrue(alerts["stale"])

    def test_btc_holdings_and_portfolio_btc_equivalent_are_distinct(self):
        portfolio = {"complete": True, "stale": False, "total_btc": "0.9", "total_usd": "70000"}
        combined = {"totals": {"btc": "0.5"}, "stale": True}
        result = server.wallet_overview(portfolio, combined)
        self.assertEqual(result["totalBtc"], "0.9")
        self.assertEqual(result["btcHoldings"], "0.5")
        self.assertTrue(result["btcHoldingsStale"])
        self.assertIsNone(result["pnl"])

    def test_today_lists_eaten_meals_with_their_energy(self):
        with patch("server.safe_read", return_value=None):
            result = server.diet_overview(self.config, dt.date(2026, 10, 24))
        self.assertEqual([(m["title"], m["kcal"]) for m in result["today"]["meals"]], [("午餐", 100)])

    def test_long_term_position_summarizes_the_cost_basis_metrics(self):
        lifetime = {"status": "fresh", "metrics": {"average_cost": "58000", "price_usdt": "67000",
                    "unrealized_net": "900", "unrealized_return_pct": "15.5", "remaining_cost": "5800"}}
        pnl = server.wallet_overview({"complete": True, "stale": False}, {"lifetime_pnl": lifetime})["pnl"]
        self.assertEqual(pnl, {"status": "fresh", "averageCost": "58000", "price": "67000",
                               "unrealized": "900", "returnPct": "15.5", "cost": "5800"})
        self.assertIsNone(server.lifetime_summary({"status": "loading", "metrics": {}}))

    def test_price_chart_is_sorted_downsampled_and_keeps_the_latest_point(self):
        history = [{"time_ms": 1000 * i, "price": 100 + i} for i in reversed(range(500))]
        history.append({"time_ms": "bad", "price": 1})
        points = server.price_chart(history, limit=120)
        self.assertLessEqual(len(points), 121)
        self.assertEqual(points[0], [0, 100])
        self.assertEqual(points[-1], [499000, 599])
        self.assertEqual(points, sorted(points))
        self.assertEqual(server.price_chart(None), [])
        self.assertEqual(server.alerts_overview(None)["chart"], [])


class ProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.calls = []
        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                cls.calls.append((self.command, self.path, dict(self.headers)))
                if self.path == "/stream":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    self.wfile.write(b"event: ready\ndata: {\"price\":42}\n\n")
                    return
                if self.path == "/api/raw":
                    data, kind = b'{"note":"/api/unchanged"}', "application/json"
                else:
                    data, kind = b'<script src="/app.js"></script><iframe src="/wallet.html"></iframe>', "text/html"
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                data = self.rfile.read(length)
                cls.calls.append((self.command, self.path, dict(self.headers), data))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_DELETE(self):
                cls.calls.append((self.command, self.path, dict(self.headers)))
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        cls.upstream_thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.upstream_thread.start()
        cls.portal = server.TerminalServer(server.Config(port=0, diet_port=cls.upstream.server_port, btc_port=cls.upstream.server_port))
        cls.portal_thread = threading.Thread(target=cls.portal.serve_forever, daemon=True)
        cls.portal_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.portal.shutdown()
        cls.portal.server_close()
        cls.upstream.shutdown()
        cls.upstream.server_close()

    def request(self, path, method="GET", body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.portal.server_port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.headers), response.read()
        connection.close()
        return result

    def test_html_and_json_preserve_separate_paths(self):
        status, headers, html = self.request("/btc/")
        self.assertEqual(status, 200)
        self.assertIn(b'src="/btc/app.js"', html)
        self.assertIn(b'src="/btc/wallet.html"', html)
        self.assertEqual(headers["X-Frame-Options"], "SAMEORIGIN")
        self.assertEqual(self.request("/diet/api/raw")[2], b'{"note":"/api/unchanged"}')

    def test_dynamic_js_and_css_roots_are_rewritten(self):
        source = b"fetch(`/api/chat/${id}`); new EventSource('/api/events'); import('/lib.mjs'); const url='https://example.com/api';"
        result = server.rewrite_asset(source, "text/javascript", "/diet")
        self.assertIn(b"fetch(`/diet/api/chat/${id}`)", result)
        self.assertIn(b"EventSource('/diet/api/events')", result)
        self.assertIn(b"https://example.com/api", result)
        self.assertIn(b"url(/diet/image.png)", server.rewrite_asset(b"url(/image.png)", "text/css", "/diet"))

    def test_project_html_restores_local_theme_before_app_scripts(self):
        source = b'<!doctype html><html><head><meta charset="utf-8"><script src="/app.js" defer></script></head><body></body></html>'
        for prefix in ("/diet", "/btc"):
            result = server.rewrite_asset(source, "text/html; charset=utf-8", prefix)
            self.assertIn(b'<head><script src="/theme-bridge.js" data-xhy-embed></script>', result)
            self.assertLess(result.index(b"/theme-bridge.js"), result.index((prefix + "/app.js").encode()))
        self.assertNotIn("options", server.LINKS)

    def test_retired_options_page_redirects_without_opening_upstream(self):
        before = len(self.calls)
        status, headers, _body = self.request("/btc/options.html")
        self.assertEqual(status, 308)
        self.assertEqual(headers.get("Location"), "/btc/#alerts")
        self.assertEqual(len(self.calls), before)

    def test_remote_provider_paths_regex_literals_and_api_suffixes_are_unchanged(self):
        source = b'''const remote='/address/'+address; const suffix='/config'; const jobs='/jobs/'; const p='/api/v1/prices'; text.replace(/"/g, '""'); return '/api/wallet/proxy?'+query;'''
        expected = source.replace(b"'/api/wallet/proxy?", b"'/btc/api/wallet/proxy?")
        self.assertEqual(server.rewrite_asset(source, "text/javascript", "/btc"), expected)
        self.assertEqual(server.rewrite_asset(b"<script>"+source+b"</script>", "text/html", "/btc"), b"<script>"+expected+b"</script>")

    def test_same_origin_post_reaches_only_selected_upstream(self):
        origin = "http://127.0.0.1:%s" % self.portal.server_port
        body = b'{"message":"hello"}'
        status, _headers, data = self.request("/diet/api/chat?mode=save", "POST", body,
                                            {"Origin": origin, "Content-Type": "application/json", "X-Terminal-Request": "1"})
        self.assertEqual((status, data), (200, body))
        call = self.calls[-1]
        self.assertEqual(call[1], "/api/chat?mode=save")
        self.assertEqual(call[2]["Origin"], "http://127.0.0.1:%s" % self.upstream.server_port)
        self.assertEqual(call[2]["X-Terminal-Request"], "1")

    def test_cross_site_and_host_rebinding_are_blocked(self):
        before = len(self.calls)
        self.assertEqual(self.request("/btc/api/settings", "POST", b"{}", {"Origin": "https://untrusted.example"})[0], 403)
        self.assertEqual(self.request("/api/health", headers={"Host": "untrusted.example"})[0], 403)
        self.assertEqual(self.request("/btc/", headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(len(self.calls), before)

    def test_service_recovery_requires_local_launcher_header_and_reuses_worker(self):
        self.assertEqual(self.request("/api/services/ensure", "POST", b"")[0], 403)
        with patch.object(self.portal, "ensure_dependencies_async", return_value=False) as ensure:
            status, _headers, data = self.request("/api/services/ensure", "POST", b"", {"X-Terminal-Request": "1"})
        self.assertEqual(status, 202)
        self.assertFalse(json.loads(data)["started"])
        ensure.assert_called_once()

    def test_project_source_logs_and_traversal_are_not_public(self):
        for path in ("/server.py", "/.local/logs/terminal-service.log", "/%2e%2e/server.py", "/site/../../server.py"):
            self.assertEqual(self.request(path)[0], 404, path)

    def test_sse_is_forwarded(self):
        status, headers, data = self.request("/btc/stream")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/event-stream")
        self.assertIn(b"event: ready", data)

    def test_original_options_job_cancel_method_is_preserved(self):
        status, _headers, _data = self.request("/btc/api/option-ai/jobs/fixture", "DELETE", headers={"X-Terminal-Request": "1"})
        self.assertEqual(status, 200)
        self.assertEqual(self.calls[-1][:2], ("DELETE", "/api/option-ai/jobs/fixture"))
        self.assertEqual(self.request("/diet/api/diary", "DELETE")[0], 405)


class LauncherTests(unittest.TestCase):
    def test_existing_diet_is_reused_without_spawning_or_reading_key(self):
        with patch("services.startup_lock", return_value=__import__("contextlib").nullcontext()), \
             patch("services.service_status", return_value="ready"), \
             patch("services.start_hidden") as start, patch("services.diet_environment") as credentials:
            services.ensure_diet(server.Config())
        start.assert_not_called()
        credentials.assert_not_called()

    def test_occupied_diet_port_is_never_started_again(self):
        with patch("services.startup_lock", return_value=__import__("contextlib").nullcontext()), \
             patch("services.service_status", return_value="occupied"), patch("services.start_hidden") as start:
            with self.assertRaises(RuntimeError):
                services.ensure_diet(server.Config())
        start.assert_not_called()


if __name__ == "__main__":
    unittest.main()
