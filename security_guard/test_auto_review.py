"""Automatic triage integration: harmless fixtures, no key/network/dialog access."""
from __future__ import annotations

from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from security_guard import cli, deepseek, defender, identity, scanner


TEST_KEY = "integration-placeholder-key"


def response(findings, assessment="uncertain", usage=None):
    return {
        "items": [{"id": index, "assessment": assessment, "confidence": "low",
                   "reason": "此无害测试夹具用于验证自动分类流程。", "suggestion": "保留文件。"}
                  for index, _ in enumerate(findings, 1)],
        "usage": usage,
        "model": "integration-test-model",
    }


class AutomaticReviewTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="xhy-auto-review-test-")
        self.directory = Path(self.temporary.name)
        self.source = self.directory / "input"
        self.source.mkdir()
        self.reports = self.directory / "reports"
        self.patch = mock.patch.object(cli, "REPORTS", self.reports)
        self.patch.start()
        # File identity extraction has separate tests. These orchestration tests
        # must not launch a real signature PowerShell process for every fixture.
        self.identity_patch = mock.patch.object(identity, "collect_identity", return_value={
            "basename": "fixture.cmd", "content_eligible": False,
            "content_status": "withheld", "source_excerpt": ""})
        self.identity_patch.start()
        self.output = io.StringIO()
        self.quiet = redirect_stdout(self.output)
        self.quiet.__enter__()

    def tearDown(self):
        self.quiet.__exit__(None, None, None)
        self.patch.stop()
        self.identity_patch.stop()
        self.temporary.cleanup()

    def files(self, count):
        paths = []
        for index in range(count):
            path = self.source / ("note-%03d.txt.cmd" % index)
            path.write_bytes(b"echo harmless integration fixture\r\n")
            paths.append(path)
        return paths

    def report_path(self):
        return next(self.reports.glob("*/report.json"))

    def report(self):
        return json.loads(self.report_path().read_text(encoding="utf-8"))

    def log(self):
        path = self.report_path().parent / "findings.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]

    def run_mocked(self, fake_review, notify=None, **kwargs):
        with mock.patch.object(deepseek, "load_api_key", return_value=TEST_KEY), \
                mock.patch.object(deepseek.DeepSeekClient, "review", side_effect=fake_review):
            return cli.do_scan([self.source], local_only=True, notify=notify, **kwargs)

    def test_ai_and_saved_verdict_precede_first_manual_prompt(self):
        self.files(1)
        events = []

        def classify(findings):
            events.append("ai")
            return response(findings)

        def notify(finding):
            events.append("notify")
            self.assertEqual(events, ["ai", "notify"])
            self.assertEqual(finding.verdict["basis"], "ai")
            saved = self.report()["findings"][0]["verdict"]
            self.assertEqual(saved, finding.verdict)
            analyses = [row for row in self.log() if row["type"] == "analysis"]
            self.assertEqual(analyses[0]["verdict"], finding.verdict)
            return "kept"

        self.assertEqual(self.run_mocked(classify, notify), 1)
        self.assertEqual(events, ["ai", "notify"])

    def test_all_27_candidates_are_reviewed_in_bounded_batches(self):
        paths = self.files(27)
        before = {str(path): path.read_bytes() for path in paths}
        batches = []

        def classify(findings):
            batches.append([finding.path for finding in findings])
            return response(findings, "likely_benign")

        notify = mock.Mock(return_value="kept")
        self.run_mocked(classify, notify)
        self.assertGreater(len(batches), 1)
        self.assertTrue(all(0 < len(batch) <= deepseek.MAX_BATCH for batch in batches))
        reviewed = [path for batch in batches for path in batch]
        self.assertEqual(set(reviewed), set(before))
        self.assertEqual(len(reviewed), 27)
        self.assertEqual(self.report()["ai"]["reviewed"], 27)
        self.assertEqual(self.report()["verdict_counts"]["low_risk"], 27)
        notify.assert_not_called()
        for path in paths:
            self.assertEqual(path.read_bytes(), before[str(path)])

    def test_low_risk_kept_without_dialog_or_source_change(self):
        path = self.files(1)[0]
        original = path.read_bytes()
        notify = mock.Mock(return_value="requested_manual_review")
        self.run_mocked(lambda rows: response(rows, "likely_benign"), notify)
        notify.assert_not_called()
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(self.report()["files_modified_by_program"], 0)
        decisions = [row for row in self.log() if row["type"] == "decision"]
        self.assertEqual(decisions[0]["choice"], "kept_low_risk")

    def test_engine_detection_still_prompts_when_ai_says_benign(self):
        path = self.source / "engine-only.bin"
        path.write_bytes(b"harmless engine-response fixture")
        finding = scanner.Finding(str(path), "defender", "high", ["Microsoft Defender 测试检测结果"])
        result = defender.DefenderResult(str(self.source), "threat", 2, [finding], "模拟检测", False)
        notify = mock.Mock(return_value="kept")
        with mock.patch.object(deepseek, "load_api_key", return_value=TEST_KEY), \
                mock.patch.object(deepseek.DeepSeekClient, "review", side_effect=lambda rows: response(rows, "likely_benign")), \
                mock.patch.object(defender, "run_scan", return_value=result):
            self.assertEqual(cli.do_scan([self.source], notify=notify), 1)
        notify.assert_called_once()
        verdict = notify.call_args.args[0].verdict
        self.assertEqual(verdict["level"], "confirmed_threat")
        self.assertEqual(verdict["basis"], "defender")
        self.assertTrue(path.is_file())

    def test_actual_usage_sums_across_all_batches(self):
        self.files(27)
        usages = []

        def classify(rows):
            usage = {"prompt_tokens": 100 + len(rows), "completion_tokens": 20 + len(rows)}
            usage["total_tokens"] = sum(usage.values())
            usages.append(usage)
            return response(rows, "likely_benign", usage)

        self.run_mocked(classify, mock.Mock())
        recorded = self.report()["ai"]
        for field in ("prompt_tokens", "completion_tokens", "total_tokens"):
            self.assertEqual(recorded["usage"][field], sum(usage[field] for usage in usages))
        self.assertEqual(recorded["requests"], len(usages))
        self.assertTrue(recorded["usage_complete"])
        self.assertEqual(recorded["model"], "integration-test-model")

    def test_missing_usage_is_marked_unknown_instead_of_claiming_zero(self):
        self.files(1)
        self.run_mocked(lambda rows: response(rows, "likely_benign", None), mock.Mock())
        self.assertFalse(self.report()["ai"]["usage_complete"])
        self.assertIn("非完整总数", self.output.getvalue())

    def test_ai_failure_does_not_retry_endlessly_or_claim_clean(self):
        self.files(27)
        notify = mock.Mock(return_value="kept")
        with mock.patch.object(deepseek, "load_api_key", return_value=TEST_KEY) as key, \
                mock.patch.object(deepseek.DeepSeekClient, "review", side_effect=deepseek.DeepSeekError("连接超时")) as review:
            self.assertEqual(cli.do_scan([self.source], local_only=True, notify=notify), 1)
        review.assert_called_once()
        key.assert_called_once()
        saved = self.report()
        self.assertEqual(saved["verdict_counts"]["uncertain"], 27)
        self.assertEqual(saved["verdict_counts"]["low_risk"], 0)
        self.assertEqual(saved["ai"]["reviewed"], 0)
        self.assertEqual(saved["ai"]["failed"] + saved["ai"]["not_reviewed"], 27)
        self.assertIn("超时", saved["ai_error"])
        self.assertFalse(saved["ai"]["usage_complete"])
        self.assertEqual(notify.call_count, 27)

    def test_failure_after_success_does_not_count_previous_usage_twice(self):
        self.files(27)
        calls = []

        def classify(rows):
            calls.append(len(rows))
            if len(calls) == 1:
                return response(rows, "likely_benign", {"prompt_tokens": 80, "completion_tokens": 20, "total_tokens": 100})
            raise deepseek.DeepSeekError("第二次请求超时")

        self.run_mocked(classify, mock.Mock(return_value="kept"))
        self.assertEqual(len(calls), 2)
        saved = self.report()["ai"]
        self.assertEqual(saved["usage"]["total_tokens"], 100)
        self.assertEqual(saved["usage"]["prompt_tokens"], 80)
        self.assertFalse(saved["usage_complete"])
        self.assertEqual(saved["reviewed"], calls[0])
        self.assertEqual(saved["failed"], calls[1])

    def test_no_ai_never_loads_credentials_for_candidates(self):
        self.files(3)
        with mock.patch.object(deepseek, "load_api_key") as key, \
                mock.patch.object(deepseek.DeepSeekClient, "review") as review:
            cli.do_scan([self.source], local_only=True, use_ai=False, notify=lambda _: "kept")
        key.assert_not_called()
        review.assert_not_called()
        self.assertEqual(self.report()["verdict_counts"]["uncertain"], 3)
        self.assertFalse(self.report()["ai"]["enabled"])

    def test_replaying_report_keeps_prior_verdict_without_a_new_ai_request(self):
        self.files(2)
        self.run_mocked(lambda rows: response(rows, "suspicious"), mock.Mock(return_value="kept"))
        original = {row["path"]: row["verdict"] for row in self.log() if row["type"] == "analysis"}
        notify = mock.Mock(return_value="kept")
        with mock.patch.object(deepseek, "load_api_key") as key, \
                mock.patch.object(deepseek.DeepSeekClient, "review") as review:
            cli.review_report(str(self.report_path()), notify=notify)
        self.assertEqual(notify.call_count, 2)
        for call in notify.call_args_list:
            finding = call.args[0]
            self.assertEqual(finding.verdict, original[finding.path])
        key.assert_not_called()
        review.assert_not_called()

    def test_entire_classified_batch_survives_interrupt_at_first_dialog(self):
        self.files(cli.AI_BATCH_SIZE)
        notify = mock.Mock(side_effect=KeyboardInterrupt)
        code = self.run_mocked(lambda rows: response(rows, "suspicious"), notify)
        self.assertEqual(code, 130)
        analyses = [row for row in self.log() if row["type"] == "analysis"]
        self.assertEqual(len(analyses), cli.AI_BATCH_SIZE)
        replayed = list(cli.report_findings(self.report_path().parent))
        self.assertEqual(len(replayed), cli.AI_BATCH_SIZE)
        self.assertTrue(all(finding.verdict["basis"] == "ai" for finding in replayed))
        self.assertEqual(self.report()["ai"]["reviewed"], cli.AI_BATCH_SIZE)

    def test_interrupt_during_ai_request_records_unknown_usage(self):
        self.files(1)
        notify = mock.Mock(return_value="kept")
        with mock.patch.object(deepseek, "load_api_key", return_value=TEST_KEY), \
                mock.patch.object(deepseek.DeepSeekClient, "review", side_effect=KeyboardInterrupt) as review:
            code = cli.do_scan([self.source], local_only=True, notify=notify)
        self.assertEqual(code, 130)
        review.assert_called_once()
        notify.assert_not_called()
        saved = self.report()
        self.assertEqual(saved["status"], "cancelled")
        self.assertEqual(saved["ai"]["requests"], 1)
        self.assertFalse(saved["ai"]["usage_complete"])
        self.assertEqual(saved["ai"]["reviewed"], 0)
        # Discovery survives even when the response was never received.
        self.assertEqual(saved["findings_count"], 1)
        replayed = list(cli.report_findings(self.report_path().parent))
        self.assertEqual(replayed[0].verdict["level"], "uncertain")


if __name__ == "__main__":
    unittest.main()
