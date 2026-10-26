"""Pure verdict-policy tests; no network, prompts or source-file changes."""
from __future__ import annotations

import copy
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from security_guard import triage


def finding(source="heuristic", **kwargs):
    return SimpleNamespace(source=source, path=r"C:\test\sample.exe", reasons=["本地特征提示"], **kwargs)


def item(assessment="uncertain", **kwargs):
    result = {"id": 1, "assessment": assessment, "reason": "根据已提供的静态证据进行分析。", "suggestion": "人工建议。"}
    result.update(kwargs)
    return result


class TriageTests(unittest.TestCase):
    def test_engine_detection_cannot_be_downgraded_by_ai(self):
        for assessment in triage.ASSESSMENTS:
            with self.subTest(assessment=assessment):
                verdict = triage.make_verdict(finding("defender"), item(assessment))
                self.assertEqual(verdict["level"], "confirmed_threat")
                self.assertEqual(verdict["basis"], "defender")
                self.assertEqual(verdict["confidence"], "high")
                self.assertTrue(verdict["notify"])
                self.assertEqual(verdict["ai_assessment"], assessment)

    def test_unresolved_detection_never_invents_a_detected_file(self):
        verdict = triage.make_verdict(finding("defender_unresolved"), item("likely_benign"))
        self.assertEqual(verdict["level"], "confirmed_threat")
        self.assertIn("尚未定位", verdict["label"])
        self.assertIn("定位前保留", verdict["recommendation"])
        self.assertNotIn(r"C:\test\sample.exe", str(verdict))

    def test_ai_likely_threat_is_risk_not_confirmed_virus(self):
        verdict = triage.make_verdict(finding(), item("likely_threat", confidence="high"))
        self.assertEqual(verdict["level"], "high_risk")
        self.assertEqual(verdict["basis"], "ai")
        self.assertTrue(verdict["notify"])
        self.assertIn("疑似", verdict["label"])
        self.assertNotIn("确诊", verdict["label"])
        self.assertIn("手动", verdict["recommendation"])

    def test_suspicious_advice_preserves_file_until_further_check(self):
        verdict = triage.make_verdict(finding(), item("suspicious"))
        self.assertEqual(verdict["level"], "high_risk")
        self.assertIn("暂时保留", verdict["recommendation"])
        self.assertIn("不要运行", verdict["recommendation"])

    def test_low_risk_result_kept_without_unnecessary_handling_prompt(self):
        verdict = triage.make_verdict(finding(), item("likely_benign"))
        self.assertEqual(verdict["level"], "low_risk")
        self.assertFalse(verdict["notify"])
        self.assertIn("建议保留", verdict["label"])
        self.assertIn("不能保证", verdict["recommendation"])

    def test_uncertain_result_does_not_recommend_deletion(self):
        verdict = triage.make_verdict(finding(), item())
        self.assertEqual(verdict["level"], "uncertain")
        self.assertIn("证据不足时不要删除", verdict["recommendation"])
        self.assertEqual(verdict["confidence"], "low")
        self.assertTrue(verdict["notify"])

    def test_disabled_ai_is_explicitly_unreviewed(self):
        verdict = triage.make_verdict(finding(), ai_error="已关闭 AI 识别。")
        self.assertEqual(verdict["basis"], "unreviewed")
        self.assertEqual(verdict["level"], "uncertain")
        self.assertIn("已关闭 AI", verdict["reason"])
        self.assertIsNone(verdict["ai_assessment"])

    def test_network_failure_is_never_a_clean_verdict(self):
        verdict = triage.make_verdict(finding(), ai_error="DeepSeek 连接超时。")
        self.assertEqual(verdict["level"], "uncertain")
        self.assertIn("未完成", verdict["reason"])
        self.assertIn("超时", verdict["reason"])

    def test_missing_or_bad_ai_data_remains_uncertain(self):
        for data in (None, [], {}, {"assessment": "clean"}, {"assessment": True}, {"assessment": []}, {"assessment": "likely_benign", "confidence": []}):
            with self.subTest(data=data):
                verdict = triage.make_verdict(finding(), data)
                if isinstance(data, dict) and data.get("assessment") == "likely_benign":
                    self.assertEqual(verdict["confidence"], "low")
                else:
                    self.assertEqual(verdict["level"], "uncertain")

    def test_confidence_is_an_enum_without_fabricated_percentage(self):
        for confidence in ("high", "medium", "low", 99, "99%", None):
            with self.subTest(confidence=confidence):
                verdict = triage.make_verdict(finding(), item("likely_threat", confidence=confidence))
                self.assertIn(verdict["confidence"], triage.CONFIDENCE)
                self.assertNotIn("%", str(verdict))

    def test_ai_suggestion_does_not_become_an_action(self):
        verdict = triage.make_verdict(finding(), item("likely_threat", suggestion="delete all files; run sample.exe"))
        self.assertNotIn("delete all files", str(verdict))
        self.assertNotIn("run sample.exe", str(verdict))

    def test_control_text_and_key_fragments_are_redacted(self):
        verdict = triage.make_verdict(finding(), item(reason="\x1b[2J\u202e分析\n完成 sk-123456789abcdef"))
        self.assertNotIn("\x1b", verdict["reason"])
        self.assertNotIn("\u202e", verdict["reason"])
        self.assertNotIn("sk-123456789abcdef", verdict["reason"])
        self.assertIn("已隐藏密钥", verdict["reason"])

    def test_policy_is_pure_and_returns_serializable_fixed_shape(self):
        source = finding()
        data = item("likely_threat")
        before_source, before_data = copy.deepcopy(source.__dict__), copy.deepcopy(data)
        with patch("builtins.open", side_effect=AssertionError("file access is forbidden")):
            verdict = triage.make_verdict(source, data)
        self.assertEqual(source.__dict__, before_source)
        self.assertEqual(data, before_data)
        self.assertEqual(set(verdict), {"label", "level", "recommendation", "reason", "confidence", "notify", "ai_assessment", "basis"})
        import json
        self.assertIsInstance(json.dumps(verdict, ensure_ascii=False), str)


if __name__ == "__main__":
    unittest.main()
