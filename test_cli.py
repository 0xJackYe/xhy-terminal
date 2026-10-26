"""CLI contract tests use an isolated loopback server, never the real diary."""
import copy
import http.server
import io
import json
import socket
import threading
import unittest

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


if __name__ == "__main__":
    unittest.main()
