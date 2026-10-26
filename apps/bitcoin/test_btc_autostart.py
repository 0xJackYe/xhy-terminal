"""Startup installer tests never create or delete a real Windows startup entry."""
import base64
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest import mock

import setup_btc_autostart as setup


class AutostartTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.base = Path(self.folder.name)
        self.root = self.base / "程序 with spaces"
        self.root.mkdir()
        (self.root / "launch_btc_terminal.py").touch()
        self.executable = self.base / "Python 路径" / "python.exe"
        self.executable.parent.mkdir()
        self.executable.with_name("pythonw.exe").touch()
        self.appdata = self.base / "当前用户 AppData"

    def tearDown(self):
        self.folder.cleanup()

    def spec(self):
        return setup.installation_spec(self.root, self.executable, self.appdata)

    def result(self, enabled=True):
        return subprocess.CompletedProcess([], 0, json.dumps({"enabled": enabled, "conflict": False}), "")

    def test_shortcut_is_current_user_only_and_hidden_python(self):
        spec = self.spec()
        self.assertEqual(Path(spec["target"]), self.executable.with_name("pythonw.exe"))
        self.assertEqual(Path(spec["shortcut"]), self.appdata / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup" / "Bitcoin Terminal.lnk")
        self.assertEqual(Path(spec["working_directory"]), self.root)
        self.assertEqual(spec["arguments"], subprocess.list2cmdline([str(self.root / "launch_btc_terminal.py"), "--autostart"]))

    def test_missing_pythonw_preserves_startup_directory(self):
        self.executable.with_name("pythonw.exe").unlink()
        with self.assertRaisesRegex(RuntimeError, "缺少"):
            self.spec()
        self.assertFalse(self.appdata.exists())

    def test_missing_launcher_preserves_startup_directory(self):
        (self.root / "launch_btc_terminal.py").unlink()
        with self.assertRaisesRegex(RuntimeError, "缺少"):
            self.spec()
        self.assertFalse(self.appdata.exists())

    def test_missing_appdata_fails_without_any_startup_change(self):
        with mock.patch.dict(setup.os.environ, {}, clear=True), self.assertRaisesRegex(RuntimeError, "APPDATA"):
            setup.installation_spec(self.root, self.executable)

    def test_read_or_remove_spec_retains_exact_ownership_paths_when_dependencies_missing(self):
        expected = self.spec()
        self.executable.with_name("pythonw.exe").unlink()
        (self.root / "launch_btc_terminal.py").unlink()
        actual = setup.installation_spec(self.root, self.executable, self.appdata, require_dependencies=False)
        self.assertEqual(actual, expected)
        self.assertFalse(self.appdata.exists())

    def test_cli_status_and_disable_work_when_launcher_and_pythonw_are_missing(self):
        expected = self.spec()
        self.executable.with_name("pythonw.exe").unlink()
        (self.root / "launch_btc_terminal.py").unlink()
        original_spec = setup.installation_spec
        def local_spec(require_dependencies):
            return original_spec(self.root, self.executable, self.appdata, require_dependencies=require_dependencies)
        for argv, mode in ((["--status"], "status"), (["--disable"], "disable")):
            with self.subTest(argv=argv), mock.patch.object(setup, "installation_spec", side_effect=local_spec), \
                 mock.patch.object(setup, "shortcut_operation", return_value={"enabled": False}) as operation, \
                 mock.patch("builtins.print"):
                self.assertEqual(setup.main(argv), 0)
            operation.assert_called_once_with(expected, mode)
        self.assertFalse(self.appdata.exists())

    def test_cli_enable_still_rejects_missing_dependencies_before_touching_startup(self):
        self.executable.with_name("pythonw.exe").unlink()
        original_spec = setup.installation_spec
        def local_spec(require_dependencies):
            return original_spec(self.root, self.executable, self.appdata, require_dependencies=require_dependencies)
        with mock.patch.object(setup, "installation_spec", side_effect=local_spec), \
             mock.patch.object(setup, "shortcut_operation") as operation, mock.patch("builtins.print"):
            self.assertEqual(setup.main(["--enable"]), 1)
        operation.assert_not_called()
        self.assertFalse(self.appdata.exists())

    def test_paths_are_json_data_not_powershell_executable_code(self):
        spec = self.spec()
        spec["working_directory"] = 'D:\\示例\\`$(Write-Output secrets) "quoted"'
        runner = mock.Mock(return_value=self.result())
        self.assertTrue(setup.shortcut_operation(spec, "install", runner)["enabled"])
        command = runner.call_args.args[0]
        script = base64.b64decode(command[-1]).decode("utf-16-le")
        self.assertNotIn(spec["working_directory"], script)
        match = re.search(r"FromBase64String\('([^']+)'\)", script)
        payload = json.loads(base64.b64decode(match.group(1)).decode("utf-8"))
        self.assertEqual(payload, {"spec": spec, "mode": "install"})
        self.assertNotIn("shell", runner.call_args.kwargs)
        self.assertEqual(runner.call_args.kwargs["timeout"], 30)

    def test_disable_is_own_entry_only_and_conflicts_are_preserved(self):
        runner = mock.Mock(return_value=self.result(False))
        self.assertFalse(setup.shortcut_operation(self.spec(), "disable", runner)["enabled"])
        script = base64.b64decode(runner.call_args.args[0][-1]).decode("utf-16-le")
        self.assertIn("-and $exists -and -not $owned", script)
        self.assertIn("Remove-Item -LiteralPath $spec.shortcut", script)
        self.assertNotIn("-Recurse", script)

    def test_installer_validates_saved_shortcut_target_arguments_and_folder(self):
        runner = mock.Mock(return_value=self.result())
        setup.shortcut_operation(self.spec(), "install", runner)
        script = base64.b64decode(runner.call_args.args[0][-1]).decode("utf-16-le")
        for field in ("$check.TargetPath", "$check.Arguments", "$check.WorkingDirectory"):
            self.assertIn(field, script)
        self.assertIn("Saved shortcut verification failed", script)

    def test_installer_failure_is_not_reported_as_enabled(self):
        runner = mock.Mock(return_value=subprocess.CompletedProcess([], 1, "", "name conflict"))
        with self.assertRaisesRegex(RuntimeError, "name conflict"):
            setup.shortcut_operation(self.spec(), "install", runner)

    def test_invalid_powershell_json_is_an_error(self):
        runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0, "partial output", ""))
        with self.assertRaisesRegex(RuntimeError, "有效结果"):
            setup.shortcut_operation(self.spec(), "status", runner)

    def test_success_without_boolean_status_is_an_error(self):
        runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0, '{"enabled":"true"}', ""))
        with self.assertRaisesRegex(RuntimeError, "结果无效"):
            setup.shortcut_operation(self.spec(), "status", runner)

    def test_unknown_mode_never_starts_powershell(self):
        runner = mock.Mock()
        with self.assertRaises(ValueError):
            setup.shortcut_operation(self.spec(), "remove-everything", runner)
        runner.assert_not_called()

    def test_cli_enable_status_disable_use_correct_operation(self):
        for argv, expected in ((["--enable"], "install"), (["--status"], "status"), (["--disable"], "disable"), ([], "install")):
            with self.subTest(argv=argv), mock.patch.object(setup, "installation_spec", return_value={}) as spec, \
                 mock.patch.object(setup, "shortcut_operation", return_value={"enabled": True}) as operation, \
                 mock.patch("builtins.print"):
                self.assertEqual(setup.main(argv), 0)
                spec.assert_called_once_with(require_dependencies=(expected == "install"))
                operation.assert_called_once_with({}, expected)


if __name__ == "__main__":
    unittest.main()
