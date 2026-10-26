"""Integration tests use harmless files and mocked dialogs/antivirus/AI."""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from security_guard import cli, deepseek, defender, scanner


class CLITests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="xhy-guard-test-")
        self.directory = Path(self.temporary.name)
        self.source = self.directory / "input"
        self.source.mkdir()
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

    def report(self):
        return json.loads(next(self.reports.glob("*/report.json")).read_text(encoding="utf-8"))

    def test_harmless_files_scan_without_antivirus_or_network_or_changes(self):
        source = self.source / "正常文件.txt"
        source.write_bytes(b"harmless sample")
        before = source.read_bytes()
        with mock.patch.object(defender, "run_scan") as engine, mock.patch.object(deepseek, "load_api_key") as key:
            code = cli.do_scan([self.source], local_only=True, use_ai=False)
        self.assertEqual(code, 0)
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(self.report()["stats"]["files"], 1)
        engine.assert_not_called()
        key.assert_not_called()

    def test_finding_saved_before_confirmation_and_never_deleted(self):
        source = self.source / "invoice.pdf.exe"
        source.write_bytes(b"this is a harmless test, not executable")
        before = source.read_bytes()
        called = []

        def notify(finding):
            called.append(finding)
            saved = self.report()
            self.assertEqual(saved["findings_count"], 1)
            self.assertTrue(next(self.reports.glob("*/findings.jsonl")).is_file())
            return "requested_manual_review"

        self.assertEqual(cli.do_scan([self.source], local_only=True, use_ai=False, notify=notify), 1)
        self.assertEqual(len(called), 1)
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(self.report()["files_modified_by_program"], 0)

    def test_missing_root_records_incomplete_coverage(self):
        code = cli.do_scan([self.source / "missing"], local_only=True, use_ai=False)
        self.assertEqual(code, 2)
        self.assertTrue(self.report()["coverage_incomplete"])
        self.assertGreater(self.report()["stats"]["skipped"], 0)

    def test_unparsed_defender_threat_is_saved_and_prompts(self):
        result = defender.DefenderResult(str(self.source), "threat", 2, [], "未能解析文件", True)
        notify = mock.Mock(return_value="kept")
        with mock.patch.object(defender, "run_scan", return_value=result):
            code = cli.do_scan([self.source], use_ai=False, notify=notify)
        self.assertEqual(code, 2)
        notify.assert_called_once()
        self.assertEqual(notify.call_args.args[0].source, "defender_unresolved")
        self.assertEqual(notify.call_args.args[0].path, "")
        self.assertEqual(self.report()["findings_count"], 1)
        self.assertNotIn("本次扫描未发现可疑项", self.output.getvalue())

    def test_engine_failure_does_not_claim_virus_free(self):
        result = defender.DefenderResult(str(self.source), "error", 2, [], "扫描失败", True)
        with mock.patch.object(defender, "run_scan", return_value=result):
            self.assertEqual(cli.do_scan([self.source], use_ai=False), 2)
        self.assertEqual(self.report()["status"], "incomplete")

    def test_ai_errors_are_advisory_and_keep_local_evidence(self):
        (self.source / "note.txt.cmd").write_bytes(b"echo harmless")
        with mock.patch.object(deepseek, "load_api_key", return_value="placeholder-key"), \
                mock.patch.object(deepseek.DeepSeekClient, "review", side_effect=deepseek.DeepSeekError("账户余额不足")):
            code = cli.do_scan([self.source], local_only=True, notify=lambda _: "kept")
        self.assertEqual(code, 1)
        self.assertEqual(self.report()["findings_count"], 1)
        self.assertIn("复核失败", self.report()["ai_error"])

    def test_interrupt_saves_current_result(self):
        (self.source / "note.txt.cmd").write_bytes(b"echo harmless")
        notify = mock.Mock(side_effect=KeyboardInterrupt)
        code = cli.do_scan([self.source], local_only=True, use_ai=False, notify=notify)
        self.assertEqual(code, 130)
        self.assertEqual(self.report()["findings_count"], 1)
        self.assertEqual(self.report()["status"], "cancelled")

    def test_report_replay_uses_complete_append_log(self):
        (self.source / "note.txt.cmd").write_bytes(b"echo harmless")
        cli.do_scan([self.source], local_only=True, use_ai=False, notify=lambda _: "kept")
        notify = mock.Mock(return_value="kept")
        cli.review_report(notify=notify)
        notify.assert_called_once()

    def test_menu_preserves_no_ai_and_local_only(self):
        with mock.patch("builtins.input", side_effect=["1", "0"]), \
                mock.patch.object(scanner, "discover_drives", return_value=[self.source]), \
                mock.patch.object(cli, "do_scan") as scan:
            cli.menu(local_only=True, use_ai=False, model="custom-model")
        scan.assert_called_once_with([self.source], local_only=True, use_ai=False, model="custom-model")

    def test_popup_no_preserves_file_yes_only_requests_explorer(self):
        source = self.source / "note.txt.cmd"
        source.write_bytes(b"harmless")
        finding = scanner.Finding(str(source), "heuristic", "low", ["测试提示"])
        message = mock.Mock(return_value=7)
        dll = mock.Mock(MessageBoxW=message)
        with mock.patch.object(cli.ctypes, "WinDLL", return_value=dll), \
                mock.patch.object(cli, "open_file_location", return_value=True) as locate:
            self.assertEqual(cli.alert_finding(finding), "kept")
            locate.assert_not_called()
            message.return_value = 6
            self.assertEqual(cli.alert_finding(finding), "requested_manual_review")
            locate.assert_called_once_with(str(source))
        self.assertEqual(source.read_bytes(), b"harmless")
        self.assertIn("手动", message.call_args.args[1])
        self.assertEqual(message.call_args.args[3] & 0x100, 0x100)

    def test_explorer_never_executes_selected_file_or_a_shell(self):
        source = self.source / "note with spaces.txt.cmd"
        source.write_bytes(b"harmless")
        with mock.patch.object(cli.subprocess, "Popen") as popen:
            self.assertTrue(cli.open_file_location(str(source)))
        command = popen.call_args.args[0]
        self.assertEqual(Path(command[0]).name.lower(), "explorer.exe")
        self.assertIn(str(source), command)
        self.assertFalse(popen.call_args.kwargs["shell"])

    def test_no_ai_never_loads_credentials_even_with_findings(self):
        (self.source / "note.txt.cmd").write_bytes(b"echo harmless")
        with mock.patch.object(deepseek, "load_api_key") as key:
            cli.do_scan([self.source], local_only=True, use_ai=False, notify=lambda _: "kept")
        key.assert_not_called()

    def test_new_combined_script_capabilities_are_sent_to_auto_classification(self):
        # Inert text fixtures; no command in these files is executed.
        source = self.source / "static-capabilities.ps1"
        content = (b"Set-MpPreference -DisableRealtimeMonitoring $true\n"
                   b"schtasks /create /tn harmless-test-placeholder\n")
        source.write_bytes(content)
        finding, _ = scanner.scan_file(source)
        self.assertIsNotNone(finding)
        self.assertIn("defense_evasion", finding.evidence["script_features"])
        self.assertIn("persistence", finding.evidence["script_features"])
        self.assertEqual(source.read_bytes(), content)


if __name__ == "__main__":
    unittest.main()
