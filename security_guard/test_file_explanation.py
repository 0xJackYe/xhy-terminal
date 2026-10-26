"""File-purpose integration tests: harmless fixtures, mocked identity and AI."""
from __future__ import annotations

from contextlib import redirect_stdout
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from security_guard import cli, deepseek, identity, reviewer, scanner


TEST_KEY = "explanation-test-placeholder-key"
EXCERPT_MARKER = "PRIVATE_CONTENT_MARKER_ONLY_FOR_CONSENT_TEST"
EXPLANATION = {
    "file_type": "配置管理脚本",
    "purpose": "此脚本用于展示文件身份分析功能。",
    "likely_origin": "本地属性显示它属于无害的验证夹具，不能据文件名证明发布者。",
    "observed_behavior": "所提供的片段只输出一段说明文字。",
    "deletion_impact": "删除会使这个验证夹具无法再被检查，建议保留。",
    "limitations": "只分析了经过允许分享的片段，没有运行此文件。",
}


def metadata(path, *, trusted=False):
    return {
        "basename": Path(path).name,
        "location_class": "windows_system" if trusted else "user_documents",
        "location_hint": "WinSxS/example-component" if trusted else "用户文档目录",
        "size_bytes": 100,
        "actual_format": "script",
        "version_info": {"description": "无害验证脚本", "company": "验证夹具",
                         "product": "文件身份分析测试", "original_filename": Path(path).name,
                         "file_version": "1.0"},
        "signature": {"status": "valid" if trusted else "unsigned",
                      "publisher": "Microsoft Windows" if trusted else ""},
        "content_status": "withheld",
        "content_eligible": True,
        "content_authorized": False,
        "source_excerpt": "",
        "content_sample_bytes": 0,
        "sample_complete": False,
        "sha256_verification": "matched",
    }


def response(rows, assessment="uncertain"):
    return {
        "items": [{"id": index, "assessment": assessment, "confidence": "low",
                   "reason": "静态内容不足以确定风险，但可以说明文件用途。",
                   "suggestion": "保留文件。", "explanation": dict(EXPLANATION)}
                  for index, _ in enumerate(rows, 1)],
        "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
        "model": "explanation-test-model",
    }


class FileExplanationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="xhy-file-explanation-")
        self.directory = Path(self.temporary.name)
        self.source = self.directory / "input"
        self.source.mkdir()
        self.path = self.source / "fixture.txt.cmd"
        self.path.write_text("@echo off\necho " + EXCERPT_MARKER + "\n", encoding="utf-8")
        self.original = self.path.read_bytes()
        self.reports = self.directory / "reports"
        self.patch = mock.patch.object(cli, "REPORTS", self.reports)
        self.patch.start()
        self.output = io.StringIO()
        self.quiet = redirect_stdout(self.output)
        self.quiet.__enter__()

    def tearDown(self):
        self.quiet.__exit__(None, None, None)
        self.patch.stop()
        self.temporary.cleanup()

    def report_path(self):
        return next(self.reports.glob("*/report.json"))

    def report(self):
        return json.loads(self.report_path().read_text(encoding="utf-8"))

    def log(self):
        return [json.loads(line) for line in (self.report_path().parent / "findings.jsonl").read_text(encoding="utf-8").splitlines()]

    def add_excerpt(self, path, facts, **kwargs):
        self.assertEqual(Path(path), self.path)
        return dict(facts, source_excerpt="echo " + EXCERPT_MARKER,
                    content_status="included", content_authorized=True,
                    content_sample_bytes=50, sample_complete=True)

    def test_consented_content_and_identity_reach_ai_before_notification(self):
        events = []
        shared = []

        def consent(path, facts):
            events.append("consent")
            self.assertEqual(Path(path), self.path)
            self.assertEqual(facts["basename"], self.path.name)
            return True

        def classify(rows):
            events.append("ai")
            shared.append(copy.deepcopy(rows[0].identity))
            self.assertIn(EXCERPT_MARKER, rows[0].identity["source_excerpt"])
            self.assertEqual(rows[0].identity["version_info"]["description"], "无害验证脚本")
            return response(rows)

        def notify(finding):
            events.append("notify")
            self.assertEqual(events, ["consent", "ai", "notify"])
            self.assertEqual(finding.explanation, EXPLANATION)
            self.assertEqual(self.report()["findings"][0]["explanation"], EXPLANATION)
            saved = [row for row in self.log() if row["type"] == "analysis"]
            self.assertEqual(saved[0]["explanation"], EXPLANATION)
            return "kept"

        with mock.patch.object(identity, "collect_identity", side_effect=lambda path, **kw: metadata(path)), \
                mock.patch.object(identity, "add_content_excerpt", side_effect=self.add_excerpt), \
                mock.patch.object(deepseek, "load_api_key", return_value=TEST_KEY), \
                mock.patch.object(deepseek.DeepSeekClient, "review", side_effect=classify):
            code = cli.do_scan([self.source], local_only=True, content_consent=consent, notify=notify)
        self.assertEqual(code, 1)
        self.assertEqual(len(shared), 1)
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_declined_content_preserves_useful_identity_without_excerpt(self):
        captured = []
        consent = mock.Mock(return_value=False)

        def classify(rows):
            captured.append(copy.deepcopy(rows[0].identity))
            self.assertEqual(rows[0].identity["basename"], self.path.name)
            self.assertEqual(rows[0].identity["version_info"]["description"], "无害验证脚本")
            self.assertNotIn(EXCERPT_MARKER, json.dumps(rows[0].identity))
            self.assertFalse(rows[0].identity.get("source_excerpt"))
            return response(rows)

        with mock.patch.object(identity, "collect_identity", side_effect=lambda path, **kw: metadata(path)), \
                mock.patch.object(identity, "add_content_excerpt") as excerpt, \
                mock.patch.object(deepseek, "load_api_key", return_value=TEST_KEY), \
                mock.patch.object(deepseek.DeepSeekClient, "review", side_effect=classify):
            cli.do_scan([self.source], local_only=True, content_consent=consent, notify=lambda _: "kept")
        consent.assert_called_once()
        excerpt.assert_not_called()
        self.assertEqual(len(captured), 1)
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_authorized_excerpt_reaches_actual_api_payload_with_file_identity(self):
        outgoing = []

        def request(method, path, payload):
            self.assertEqual((method, path), ("POST", "/chat/completions"))
            outgoing.append(copy.deepcopy(payload))
            model_input = json.loads(payload["messages"][1]["content"])["findings"][0]
            self.assertIn(EXCERPT_MARKER, model_input["identity"]["source_excerpt"])
            self.assertEqual(model_input["identity"]["basename"], self.path.name)
            self.assertEqual(model_input["identity"]["version_info"]["description"], "无害验证脚本")
            self.assertNotIn(str(self.directory), json.dumps(model_input, ensure_ascii=False))
            item = response([None])["items"][0]
            return {"model": "explanation-test-model",
                    "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
                    "choices": [{"finish_reason": "stop", "message": {
                        "content": json.dumps({"items": [item]}, ensure_ascii=False)}}]}

        with mock.patch.object(identity, "collect_identity", side_effect=lambda path, **kw: metadata(path)), \
                mock.patch.object(identity, "add_content_excerpt", side_effect=self.add_excerpt), \
                mock.patch.object(deepseek, "load_api_key", return_value=TEST_KEY), \
                mock.patch.object(deepseek.DeepSeekClient, "_request", side_effect=request):
            cli.do_scan([self.source], local_only=True, content_consent=lambda *_: True, notify=lambda _: "kept")
        self.assertEqual(len(outgoing), 1)
        self.assertEqual(self.report()["findings"][0]["explanation"], EXPLANATION)
        self.assertEqual(self.report()["ai"]["usage"]["total_tokens"], 150)

    def test_uncertain_risk_popup_explains_what_file_is_and_its_purpose(self):
        finding = scanner.Finding(str(self.path), "heuristic", "low", ["测试发现"],
                                  identity=metadata(self.path), explanation=dict(EXPLANATION))
        message = mock.Mock(return_value=7)
        dll = mock.Mock(MessageBoxW=message)
        with mock.patch.object(cli.ctypes, "WinDLL", return_value=dll), \
                mock.patch.object(cli, "open_file_location") as locate:
            self.assertEqual(cli.alert_finding(finding), "kept")
        text = message.call_args.args[1]
        for field in ("file_type", "purpose", "likely_origin", "observed_behavior", "deletion_impact", "limitations"):
            self.assertIn(EXPLANATION[field], text)
        self.assertIn(EXPLANATION["purpose"], self.output.getvalue())
        locate.assert_not_called()

    def test_approved_excerpt_not_persisted_but_explanation_is_replayable(self):
        with mock.patch.object(identity, "collect_identity", side_effect=lambda path, **kw: metadata(path)), \
                mock.patch.object(identity, "add_content_excerpt", side_effect=self.add_excerpt), \
                mock.patch.object(deepseek, "load_api_key", return_value=TEST_KEY), \
                mock.patch.object(deepseek.DeepSeekClient, "review", side_effect=response):
            cli.do_scan([self.source], local_only=True, content_consent=lambda *_: True, notify=lambda _: "kept")
        persisted = self.report_path().read_text(encoding="utf-8") + (self.report_path().parent / "findings.jsonl").read_text(encoding="utf-8")
        self.assertNotIn(EXCERPT_MARKER, persisted)
        self.assertIn("explanation", persisted)
        notify = mock.Mock(return_value="kept")
        with mock.patch.object(deepseek, "load_api_key") as key, \
                mock.patch.object(deepseek.DeepSeekClient, "review") as request:
            cli.review_report(str(self.report_path()), notify=notify)
        notify.assert_called_once()
        self.assertEqual(notify.call_args.args[0].explanation, EXPLANATION)
        key.assert_not_called()
        request.assert_not_called()

    def test_no_ai_never_collects_or_requests_content(self):
        consent = mock.Mock(return_value=True)
        with mock.patch.object(identity, "collect_identity") as collect, \
                mock.patch.object(identity, "add_content_excerpt") as excerpt, \
                mock.patch.object(deepseek, "load_api_key") as key:
            cli.do_scan([self.source], local_only=True, use_ai=False,
                        content_consent=consent, notify=lambda _: "kept")
        consent.assert_not_called()
        collect.assert_not_called()
        excerpt.assert_not_called()
        key.assert_not_called()

    def test_metadata_mode_never_prompts_or_reads_source_excerpt(self):
        consent = mock.Mock(return_value=True)
        with mock.patch.object(identity, "collect_identity", side_effect=lambda path, **kw: metadata(path)), \
                mock.patch.object(identity, "add_content_excerpt") as excerpt, \
                mock.patch.object(deepseek, "load_api_key", return_value=TEST_KEY), \
                mock.patch.object(deepseek.DeepSeekClient, "review", side_effect=response):
            cli.do_scan([self.source], local_only=True, content_mode="metadata",
                        content_consent=consent, notify=lambda _: "kept")
        consent.assert_not_called()
        excerpt.assert_not_called()

    def test_unverified_microsoft_name_does_not_bypass_content_consent(self):
        facts = metadata(self.path, trusted=True)
        facts["signature"]["status"] = "unavailable"
        consent = mock.Mock(return_value=False)
        with mock.patch.object(identity, "collect_identity", return_value=facts), \
                mock.patch.object(identity, "add_content_excerpt") as excerpt, \
                mock.patch.object(deepseek, "load_api_key", return_value=TEST_KEY), \
                mock.patch.object(deepseek.DeepSeekClient, "review", side_effect=response):
            cli.do_scan([self.source], local_only=True, content_consent=consent, notify=lambda _: "kept")
        consent.assert_called_once()
        excerpt.assert_not_called()

    def test_explicit_normal_file_is_explained_without_a_suspicious_rule_hit(self):
        ordinary = self.source / "ordinary.txt"
        ordinary.write_text("A harmless ordinary text document for explicit analysis.\n", encoding="utf-8")
        original = ordinary.read_bytes()
        finding, _ = scanner.scan_file(ordinary)
        self.assertIsNone(finding)
        seen = []
        expected = dict(EXPLANATION, file_type="纯文本说明文件",
                        purpose="这是手动指定的普通文本文件，用于演示文档用途分析。")

        def classify(rows):
            seen.extend(row.path for row in rows)
            result = response(rows)
            for item in result["items"]:
                item["explanation"] = dict(expected)
            return result

        def facts(path, **kwargs):
            return dict(metadata(path), actual_format="other")

        with mock.patch.object(identity, "collect_identity", side_effect=facts), \
                mock.patch.object(identity, "add_content_excerpt") as excerpt, \
                mock.patch.object(deepseek, "load_api_key", return_value=TEST_KEY), \
                mock.patch.object(deepseek.DeepSeekClient, "review", side_effect=classify) as request:
            cli.analyze_file(str(ordinary), content_mode="metadata", notify=lambda _: "kept")
        request.assert_called_once()
        self.assertEqual(seen, [str(ordinary)])
        self.assertEqual(self.report()["findings"][0]["explanation"], expected)
        self.assertIn(expected["purpose"], self.output.getvalue())
        excerpt.assert_not_called()
        self.assertEqual(ordinary.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
