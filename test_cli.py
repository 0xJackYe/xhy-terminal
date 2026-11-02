"""CLI contract tests use an isolated loopback server, never the real diary."""
import copy
import http.server
import io
import json
import socket
import threading
import unittest
from unittest.mock import patch

import cli


class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        state = self.server.state
        if self.path == "/diet/api/diary":
            self.respond(200, state["snapshot"])
        elif self.path == "/api/overview":
            self.respond(200, {"updatedAt": "2026-10-26T23:00:00+08:00", "services": {"diet": {"status": "online"}, "btc": {"status": "online"}},
                               "diet": {"date": "2026-10-26", "status": "empty"},
                               "wallet": {"status": "stale", "complete": False, "totalUsd": "123.45", "assets": [{"ccy": "BTC", "quantity": "0.01", "usd_value": "123.45"}]},
                               "alerts": {"status": "stale", "price": 80000.5, "thresholds": [1, 2], "enabled": False}})
        else:
            self.respond(404, {"error": "没有这个接口"})

    def do_POST(self):
        state = self.server.state
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        state["requests"].append((self.path, copy.deepcopy(body), self.headers.get("Origin")))
        if body["requestId"] in state["receipts"]:
            self.respond(200, state["receipts"][body["requestId"]])
            return
        if body["expectedRevision"] != state["snapshot"]["revision"]:
            self.respond(409, {"error": {"message": "日记已在另一处更新"}})
            return
        if state.get("reject"):
            self.respond(503, {"error": {"message": "AI 服务暂时不可用"}})
            return
        saved = body.get("text") != "查询"
        state["snapshot"]["revision"] += 1
        if saved:
            state["writes"] += 1
            state["snapshot"]["diary"]["updatedAt"] = "update-" + str(state["writes"])
        result = {**copy.deepcopy(state["snapshot"]), "reply": "饮食已处理", "saved": saved, "canUndo": not self.path.endswith("/undo"),
                  "changes": [{"date": body["recordDate"], "action": "修改", "title": "牛奶"}] if saved else []}
        state["receipts"][body["requestId"]] = result
        if state.get("drop_once"):
            state["drop_once"] = False
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        self.respond(200, result)


class CLITests(unittest.TestCase):
    def setUp(self):
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        self.server.state = {"snapshot": {"revision": 0, "persistence": "local", "apiConfigured": True,
                                        "diary": {"schemaVersion": 1, "days": [{"date": "2026-10-26", "title": "牛奶早餐", "meals": [{"title": "早餐", "status": "eaten", "items": [{"name": "牛奶", "amount": 200, "unit": "ml", "nutrition": {"kcal": 120}}]}]}]}},
                             "requests": [], "receipts": {}, "writes": 0}
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.stream = io.StringIO()
        self.api = cli.API(self.server.server_port)
        self.console = cli.Console(color=False, stream=self.stream, width=76)
        self.terminal = cli.Terminal(self.api, self.console)
        self.terminal.record_date = "2026-10-26"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_overview_and_all_sections_are_read_only(self):
        for section in ("overview", "wallet", "alerts"):
            self.terminal.overview(section)
        self.terminal.diet("2026-10-26")
        text = self.stream.getvalue()
        for term in ("GMT / UTC+0", "饮食日记", "加密资产", "比特币价格警报", "数据延迟", "估值不完整", "牛奶", "200ml"):
            self.assertIn(term, text)
        self.assertNotIn("\x1b", text)
        self.assertIn("$ 123.45", text)
        self.assertEqual(self.server.state["writes"], 0)
        self.assertEqual(self.server.state["requests"], [])

    def test_lost_response_retries_exact_request_without_duplicate(self):
        self.server.state["drop_once"] = True
        with self.assertRaises(cli.APIError):
            self.terminal.chat("把牛奶改成200毫升")
        request_id = self.terminal.pending["payload"]["requestId"]
        self.terminal.chat("新的修改")
        self.assertEqual(len(self.server.state["requests"]), 1)
        self.terminal.chat("把牛奶改成200毫升")
        requests = self.server.state["requests"]
        self.assertEqual(requests[0][1], requests[1][1])
        self.assertEqual(request_id, requests[1][1]["requestId"])
        self.assertEqual(self.server.state["writes"], 1)
        self.assertIsNone(self.terminal.pending)
        self.assertIn("已保存到本机日记", self.stream.getvalue())

    def test_multiturn_and_read_only_reply(self):
        self.terminal.chat("修改早餐")
        self.terminal.chat("查询")
        requests = self.server.state["requests"]
        self.assertEqual(len(requests[1][1]["history"]), 2)
        self.assertEqual(requests[1][1]["expectedRevision"], 1)
        self.assertEqual(requests[1][1]["draftDays"], [])
        self.assertEqual(requests[1][2], f"http://127.0.0.1:{self.server.server_port}")
        self.assertIn("日记内容未修改", self.stream.getvalue())
        self.assertEqual(self.terminal.own_undo[0], 2)

    def test_revision_conflict_refreshes_without_resend(self):
        self.terminal.read_diary()
        self.server.state["snapshot"]["revision"] = 4
        self.terminal.chat("修改早餐")
        self.assertEqual(len(self.server.state["requests"]), 1)
        self.assertEqual(self.terminal.snapshot["revision"], 4)
        self.assertIsNone(self.terminal.pending)
        self.assertIn("没有自动重发", self.stream.getvalue())
        self.assertEqual(self.server.state["writes"], 0)

    def test_undo_refuses_other_page_changes(self):
        self.terminal.undo()
        self.assertEqual(len(self.server.state["requests"]), 0)
        self.terminal.chat("修改早餐")
        self.server.state["snapshot"]["revision"] += 1
        self.terminal.undo()
        self.assertEqual(len(self.server.state["requests"]), 1)
        self.assertIn("不能从这里撤销其他页面", self.stream.getvalue())

    def test_undo_only_current_session_edit(self):
        self.terminal.chat("修改早餐")
        self.terminal.undo()
        self.assertTrue(self.server.state["requests"][-1][0].endswith("/undo"))
        self.assertIsNone(self.terminal.own_undo)

    def test_provider_failure_does_not_claim_saved(self):
        self.server.state["reject"] = True
        with self.assertRaisesRegex(cli.APIError, "AI 服务暂时不可用"):
            self.terminal.chat("修改早餐")
        self.assertNotIn("已保存", self.stream.getvalue())
        self.assertEqual(self.server.state["writes"], 0)
        self.assertIsNotNone(self.terminal.pending)

    def test_narrow_cjk_wrapping_and_escape_filter(self):
        console = cli.Console(color=False, stream=self.stream, width=23)
        console.box("中文标题", ["中文内容测试ABC" * 8, "恶意\x1b[31m颜色\x1b[0m\x1b]0;bad\x07"])
        for line in self.stream.getvalue().splitlines():
            self.assertLessEqual(cli.cell_width(line), 23)
        self.assertNotIn("\x1b", self.stream.getvalue())
        self.assertEqual(cli.cell_width("牛奶200ml"), 9)

    def test_local_endpoint_allowlist_and_date_validation(self):
        with self.assertRaises(ValueError):
            self.api.request("http://example.com")
        with self.assertRaises(ValueError):
            cli.date_value("2026-02-30")
        self.assertEqual(cli.date_value("2026-10-26"), "2026-10-26")
        self.assertEqual(cli.number(None), "—")
        self.assertEqual(cli.number(1000), "1,000")
        self.assertEqual(cli.number("0.00012345", 8), "0.00012345")
        self.assertEqual(cli.number("NaN"), "—")

    def test_theme_text_contrast_at_least_4_5(self):
        def luminance(rgb):
            channels = [v / 255 for v in rgb]
            channels = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in channels]
            return sum(a * b for a, b in zip(channels, (.2126, .7152, .0722)))
        for theme, palette in cli.PALETTES.items():
            for name in ("fg", "muted", "accent", "good", "bad"):
                a, b = sorted((luminance(palette["bg"]), luminance(palette[name])))
                self.assertGreaterEqual((b + .05) / (a + .05), 4.5, (theme, name))



def utc(text):
    return cli.dt.datetime.fromisoformat(text.replace("Z", "+00:00"))


class ScheduleAndClockTests(unittest.TestCase):
    def test_denver_workday_boundaries_in_summer_and_winter(self):
        cases = [
            ("2026-07-06T14:59:59Z", False, "休息"),   # Monday 08:59:59 MDT
            ("2026-07-06T15:00:00Z", True, "工作中"),  # Monday 09:00 MDT
            ("2026-07-06T22:59:59Z", True, "工作中"),  # Monday 16:59:59 MDT
            ("2026-07-06T23:00:00Z", False, "休息"),   # Monday 17:00 MDT
            ("2026-01-05T15:59:59Z", False, "休息"),   # Monday 08:59:59 MST
            ("2026-01-05T16:00:00Z", True, "工作中"),  # Monday 09:00 MST
            ("2026-01-05T23:59:59Z", True, "工作中"),  # Monday 16:59:59 MST
            ("2026-01-06T00:00:00Z", False, "休息"),   # Monday 17:00 MST
            ("2026-03-09T14:59:59Z", False, "休息"),   # First Monday after spring DST change
            ("2026-03-09T15:00:00Z", True, "工作中"),
            ("2026-11-02T15:59:59Z", False, "休息"),   # First Monday after fall DST change
            ("2026-11-02T16:00:00Z", True, "工作中"),
        ]
        # Force the dependency-free Windows fallback as well as the normal conversion.
        for zone in (cli.DENVER, None):
            with patch.object(cli, "DENVER", zone):
                for moment, working, label in cases:
                    with self.subTest(zone=zone, moment=moment):
                        self.assertEqual(cli.work_status(utc(moment)), (working, label))

    def test_weekdays_follow_denver_even_when_beijing_or_utc_has_a_new_date(self):
        cases = [
            ("2026-07-10T22:59:59Z", True, "工作中"),  # Friday 16:59:59 MDT; already Saturday in Beijing
            ("2026-07-10T23:00:00Z", False, "休息"),   # Friday 17:00 MDT
            ("2026-07-11T15:00:00Z", False, "周末"),   # Saturday 09:00 MDT
            ("2026-07-13T00:00:00Z", False, "周末"),   # UTC Monday, still Sunday in Denver
            ("2026-07-13T06:00:00Z", False, "休息"),   # Monday 00:00 MDT
            ("2026-01-09T23:59:59Z", True, "工作中"),  # Friday 16:59:59 MST
            ("2026-01-10T00:00:00Z", False, "休息"),   # UTC Saturday, still Friday 17:00 MST
            ("2026-01-10T16:00:00Z", False, "周末"),   # Saturday 09:00 MST
            ("2026-01-12T06:59:59Z", False, "周末"),   # Sunday 23:59:59 MST
            ("2026-01-12T07:00:00Z", False, "休息"),   # Monday 00:00 MST
            ("2026-01-12T16:00:00Z", True, "工作中"),  # Monday 09:00 MST
        ]
        for zone in (cli.DENVER, None):
            with patch.object(cli, "DENVER", zone):
                for moment, working, label in cases:
                    with self.subTest(zone=zone, moment=moment):
                        self.assertEqual(cli.work_status(utc(moment)), (working, label))

    def test_denver_dst_transition_instants_without_a_time_zone_database(self):
        cases = [
            ("2026-03-08T08:59:59Z", "2026-03-08 01:59:59", "UTC-7"),
            ("2026-03-08T09:00:00Z", "2026-03-08 03:00:00", "UTC-6"),
            ("2026-11-01T07:59:59Z", "2026-11-01 01:59:59", "UTC-6"),
            ("2026-11-01T08:00:00Z", "2026-11-01 01:00:00", "UTC-7"),
        ]
        with patch.object(cli, "DENVER", None):
            for moment, clock, offset in cases:
                with self.subTest(moment=moment):
                    denver = cli.denver_time(utc(moment))
                    self.assertEqual(denver.strftime("%Y-%m-%d %H:%M:%S"), clock)
                    self.assertEqual(cli.utc_label(denver), offset)
                    self.assertEqual(cli.work_status(utc(moment)), (False, "周末"))

    def test_mountain_time_rule_matches_the_time_zone_database(self):
        try:
            from zoneinfo import ZoneInfo
            denver = ZoneInfo("America/Denver")
        except Exception:
            self.skipTest("no time zone database")
        for year in (2025, 2026, 2027, 2030):
            moment = cli.dt.datetime(year, 1, 1, tzinfo=cli.dt.timezone.utc)
            while moment.year == year:
                expected = moment.astimezone(denver).utcoffset().total_seconds() / 3600
                self.assertEqual(cli.mountain_offset(moment), expected, moment)
                moment += cli.dt.timedelta(minutes=30) if moment.month in (3, 11) else cli.dt.timedelta(hours=7)

    def test_header_uses_denver_as_primary_clock_with_automatic_schedule(self):
        stream = io.StringIO()
        terminal = cli.Terminal(None, cli.Console(color=False, stream=stream, width=76))
        terminal.header(now=utc("2026-10-31T20:25:47Z"))
        text = stream.getvalue()
        for term in ("北京 UTC+8  2026-11-01 04:25:47", "GMT / UTC+0  2026-10-31 20:25:47", "丹佛 UTC-6  2026-10-31 14:25:47",
                     "新德里 UTC+5:30  2026-11-01 01:55:47", "工作 丹佛时间 09:00–17:00", "周一至周五 · 周末",
                     "America/Denver · 自动切换夏令时"):
            self.assertIn(term, text)
        self.assertLess(text.index("丹佛 UTC-6"), text.index("北京 UTC+8"))
        self.assertNotIn("23:00–次日07:00", text)
        self.assertNotIn("冬令", text)
        terminal.header(now=utc("2026-11-02T15:30:00Z"))
        self.assertIn("丹佛 UTC-7  2026-11-02 08:30:00", stream.getvalue())

    def test_old_shift_setting_is_ignored(self):
        stream = io.StringIO()
        terminal = cli.Terminal(None, cli.Console(color=False, stream=stream, width=76))
        self.assertNotIn("shift", terminal.settings)
        for season in ("summer", "winter"):
            terminal.settings["shift"] = season
            stream.seek(0)
            stream.truncate(0)
            terminal.header(now=utc("2026-11-02T15:30:00Z"))
            self.assertIn("周一至周五 · 休息", stream.getvalue())
        with patch.object(cli, "SETTINGS") as settings:
            settings.read_text.return_value = '{"theme":"light","shift":"winter"}'
            self.assertEqual(cli.load_settings(), {"theme": "light"})


if __name__ == "__main__":
    unittest.main()
