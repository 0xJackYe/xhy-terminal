"""Launcher regression tests use fake processes, browser actions, clocks, and HTTP."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock
import urllib.error

import launch_btc_terminal as launcher


class Response:
    def __init__(self, payload=b'{"settings":{}}', server="BitcoinTerminal/2.0"):
        self.payload, self.headers = payload, {"Server": server}

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        return False

    def read(self, size):
        return self.payload[:size]


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.browser = mock.Mock(return_value=True)

    def tearDown(self):
        self.folder.cleanup()

    def probe(self, payload=b'{"settings":{}}', server="BitcoinTerminal/2.0"):
        return launcher.probe_server(8766, opener=mock.Mock(return_value=Response(payload, server)))

    def test_ready_api_accepts_empty_settings_when_market_is_offline(self):
        self.assertEqual(self.probe(), "ready")

    def test_other_app_is_rejected_even_if_it_has_similar_json(self):
        self.assertEqual(self.probe(server="OtherServer/1.0"), "occupied")

    def test_malformed_json_does_not_open_a_loading_page(self):
        self.assertEqual(self.probe(b'{"settings":'), "waiting")

    def test_json_array_is_not_a_terminal_state(self):
        self.assertEqual(self.probe(b'[{"settings":{}}]'), "waiting")

    def test_missing_settings_is_not_ready(self):
        self.assertEqual(self.probe(b'{"error":"loading"}'), "waiting")

    def test_response_size_is_bounded(self):
        self.assertEqual(self.probe(b" " * (launcher.MAX_RESPONSE + 1)), "waiting")

    def test_closed_port_is_missing(self):
        opener = mock.Mock(side_effect=urllib.error.URLError("connection refused"))
        with mock.patch.object(launcher.socket, "create_connection", side_effect=OSError("refused")):
            self.assertEqual(launcher.probe_server(8766, opener=opener), "missing")

    def test_busy_nonresponsive_port_waits_without_starting_another_service(self):
        opener = mock.Mock(side_effect=TimeoutError("timeout"))
        with mock.patch.object(launcher.socket, "create_connection", return_value=contextlib.nullcontext()):
            self.assertEqual(launcher.probe_server(8766, opener=opener), "waiting")

    def test_known_terminal_http_error_waits_for_recovery(self):
        error = urllib.error.HTTPError("local", 503, "loading", {"Server": "BitcoinTerminal/2.0"}, io.BytesIO())
        self.assertEqual(launcher.probe_server(8766, opener=mock.Mock(side_effect=error)), "waiting")

    def test_other_app_http_error_is_rejected(self):
        error = urllib.error.HTTPError("local", 404, "missing", {"Server": "Different"}, io.BytesIO())
        self.assertEqual(launcher.probe_server(8766, opener=mock.Mock(side_effect=error)), "occupied")

    def test_local_api_redirect_is_never_followed(self):
        self.assertIsNone(launcher.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://elsewhere.invalid"))

    def test_existing_ready_service_is_reused(self):
        start = mock.Mock()
        self.assertIsNone(launcher.ensure_server(probe=mock.Mock(return_value="ready"), start=start))
        start.assert_not_called()

    def test_server_is_started_once_and_waits_for_actual_api_readiness(self):
        child = mock.Mock()
        child.poll.return_value = None
        start = mock.Mock(return_value=child)
        sleep = mock.Mock()
        result = launcher.ensure_server(root=self.root, probe=mock.Mock(side_effect=["missing", "missing", "waiting", "ready"]),
                                        start=start, sleep=sleep)
        self.assertIs(result, child)
        start.assert_called_once_with(root=self.root, port=8766)
        self.assertEqual(sleep.call_count, 3)

    def test_existing_starting_service_is_not_started_twice(self):
        start = mock.Mock()
        launcher.ensure_server(probe=mock.Mock(side_effect=["waiting", "ready"]), start=start, sleep=mock.Mock())
        start.assert_not_called()

    def test_foreign_port_prevents_starting_service(self):
        start = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, "其他程序"):
            launcher.ensure_server(probe=mock.Mock(return_value="occupied"), start=start)
        start.assert_not_called()

    def test_early_process_exit_is_reported(self):
        child = mock.Mock()
        child.poll.return_value = 2
        with self.assertRaisesRegex(RuntimeError, "启动失败"):
            launcher.ensure_server(probe=mock.Mock(return_value="missing"), start=mock.Mock(return_value=child))

    def test_readiness_timeout_is_finite_without_duplicate_processes(self):
        start = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, "未重复启动"):
            launcher.ensure_server(timeout=1, probe=mock.Mock(return_value="waiting"), start=start,
                                   clock=mock.Mock(side_effect=[0, 0.4, 0.8, 1.2]), sleep=mock.Mock())
        start.assert_not_called()

    def test_port_taken_during_start_is_reported(self):
        child = mock.Mock()
        child.poll.return_value = None
        start = mock.Mock(return_value=child)
        with self.assertRaisesRegex(RuntimeError, "其他程序"):
            launcher.ensure_server(probe=mock.Mock(side_effect=["missing", "occupied"]), start=start, sleep=mock.Mock())
        start.assert_called_once()

    def test_hidden_server_uses_argument_list_and_log_not_shell_or_console(self):
        root = self.root / "路径 with spaces"
        process = mock.Mock()
        popen = mock.Mock(return_value=process)
        with mock.patch.object(launcher, "hidden_python", return_value=Path("C:/Python/pythonw.exe")):
            self.assertIs(launcher.start_server(root=root, port=8769, popen=popen), process)
        args, kwargs = popen.call_args
        self.assertEqual(args[0], [str(Path("C:/Python/pythonw.exe")), str(root.resolve() / "btc_terminal_server.py"),
                                   "--port", "8769", "--no-browser"])
        self.assertNotIn("shell", kwargs)
        self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(kwargs["stderr"], subprocess.STDOUT)
        self.assertTrue(kwargs["stdout"].closed)
        if launcher.os.name == "nt":
            self.assertEqual(kwargs["creationflags"], subprocess.CREATE_NO_WINDOW)
        self.assertTrue((root / "terminal" / "logs" / "btc-terminal-service.log").is_file())

    def autostart(self, key="boot-a/logon-a", port=8766):
        return launcher.open_for_logon(root=self.root, port=port, autostart=True, opener=self.browser,
                                       key_provider=lambda: key)

    def test_autostart_same_logon_opens_only_once(self):
        self.assertTrue(self.autostart())
        self.assertFalse(self.autostart())
        self.browser.assert_called_once_with("http://127.0.0.1:8766/")

    def test_new_boot_opens_even_if_authentication_id_was_reused(self):
        self.autostart("boot-a/same-token")
        self.assertTrue(self.autostart("boot-b/same-token"))
        self.assertEqual(self.browser.call_count, 2)

    def test_new_login_in_same_boot_opens_again(self):
        self.autostart("boot-a/logon-a")
        self.assertTrue(self.autostart("boot-a/logon-b"))
        self.assertEqual(self.browser.call_count, 2)

    def test_manual_launch_always_opens_after_autostart(self):
        self.autostart()
        self.assertTrue(launcher.open_for_logon(root=self.root, opener=self.browser))
        self.assertTrue(launcher.open_for_logon(root=self.root, opener=self.browser))
        self.assertEqual(self.browser.call_count, 3)

    def test_other_port_has_independent_open_state(self):
        self.autostart()
        self.assertTrue(self.autostart(port=8769))
        self.assertFalse(self.autostart(port=8766))
        self.assertFalse(self.autostart(port=8769))
        self.assertEqual(self.browser.call_count, 2)

    def test_new_logon_resets_each_port_independently(self):
        for port in (8766, 8769):
            self.assertTrue(self.autostart("boot-a/logon-a", port))
        for port in (8766, 8769):
            self.assertTrue(self.autostart("boot-b/logon-b", port))
            self.assertFalse(self.autostart("boot-b/logon-b", port))
        self.assertEqual(self.browser.call_count, 4)

    def test_legacy_marker_preserves_current_login_and_allows_next_boot(self):
        legacy = self.root / "terminal" / "logs" / "last-startup-logon.json"
        legacy.parent.mkdir(parents=True)
        old_value = {"logon": "boot-a/logon-a", "port": 8766}
        legacy.write_text(json.dumps(old_value), encoding="utf-8")
        self.assertFalse(self.autostart())
        self.assertTrue(self.autostart(port=8769))
        self.assertFalse(self.autostart())
        self.assertTrue(self.autostart("boot-b/logon-a"))
        self.assertFalse(self.autostart("boot-b/logon-a"))
        self.assertEqual(json.loads(legacy.read_text(encoding="utf-8")), old_value)
        self.assertEqual(self.browser.call_count, 2)

    def test_failed_browser_open_does_not_suppress_later_retry(self):
        self.browser.return_value = False
        with self.assertRaisesRegex(RuntimeError, "浏览器"):
            self.autostart()
        self.assertFalse((self.root / "terminal" / "logs" / "last-startup-logon-8766.json").exists())
        self.browser.return_value = True
        self.assertTrue(self.autostart())

    def test_corrupt_marker_is_recovered(self):
        marker = self.root / "terminal" / "logs" / "last-startup-logon-8766.json"
        marker.parent.mkdir(parents=True)
        marker.write_text("broken json", encoding="utf-8")
        self.assertTrue(self.autostart())
        self.assertEqual(json.loads(marker.read_text(encoding="utf-8"))["logon"], "boot-a/logon-a")

    def test_failed_logon_lookup_never_blocks_browser_or_future_boot(self):
        self.autostart()
        with mock.patch.object(launcher, "append_log") as log:
            self.assertTrue(launcher.open_for_logon(root=self.root, autostart=True, opener=self.browser,
                                                  key_provider=mock.Mock(side_effect=RuntimeError("CIM unavailable"))))
        log.assert_called_once()
        self.assertEqual(self.browser.call_count, 2)

    def test_marker_save_failure_does_not_report_a_successful_browser_as_failed(self):
        with mock.patch.object(launcher.os, "replace", side_effect=OSError("read-only marker")), \
             mock.patch.object(launcher, "append_log") as log:
            self.assertTrue(self.autostart())
        self.browser.assert_called_once()
        log.assert_called_once()

    def test_unwritable_log_does_not_break_a_running_service(self):
        with mock.patch.object(Path, "mkdir", side_effect=OSError("read-only")):
            launcher.append_log("startup", self.root)

    def test_boot_time_uses_authoritative_cim_time(self):
        runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0, "2026-10-14T01:00:00.1234567Z\r\n", ""))
        self.assertEqual(launcher.windows_boot_time(runner), "2026-10-14T01:00:00.1234567Z")
        self.assertIn("LastBootUpTime", runner.call_args.args[0][-1])
        self.assertEqual(runner.call_args.kwargs["timeout"], 15)

    def test_invalid_boot_time_is_rejected(self):
        runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0, "not a timestamp", ""))
        with self.assertRaisesRegex(RuntimeError, "启动时间无效"):
            launcher.windows_boot_time(runner)

    def test_boot_lookup_error_is_reported(self):
        runner = mock.Mock(return_value=subprocess.CompletedProcess([], 1, "", "unavailable"))
        with self.assertRaisesRegex(RuntimeError, "无法读取"):
            launcher.windows_boot_time(runner)

    def test_boot_time_without_timezone_is_rejected(self):
        runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0, "2026-10-14T01:00:00", ""))
        with self.assertRaisesRegex(RuntimeError, "启动时间无效"):
            launcher.windows_boot_time(runner)

    def fake_kernel(self, wait_result=0):
        kernel = mock.Mock()
        kernel.CreateMutexW.return_value = 123
        kernel.WaitForSingleObject.return_value = wait_result
        return kernel

    @unittest.skipUnless(launcher.os.name == "nt", "Windows mutex behavior")
    def test_named_mutex_holds_ownership_until_launcher_finishes(self):
        kernel = self.fake_kernel()
        with mock.patch.object(launcher.ctypes, "WinDLL", return_value=kernel):
            with launcher.startup_lock(self.root, 8766):
                kernel.ReleaseMutex.assert_not_called()
                kernel.CloseHandle.assert_not_called()
        kernel.ReleaseMutex.assert_called_once_with(123)
        kernel.CloseHandle.assert_called_once_with(123)
        self.assertTrue(kernel.CreateMutexW.call_args.args[2].startswith("Local\\BitcoinTerminal-"))

    @unittest.skipUnless(launcher.os.name == "nt", "Windows mutex behavior")
    def test_abandoned_launcher_mutex_is_recoverable(self):
        kernel = self.fake_kernel(0x80)
        with mock.patch.object(launcher.ctypes, "WinDLL", return_value=kernel), launcher.startup_lock(self.root):
            pass
        kernel.ReleaseMutex.assert_called_once_with(123)
        kernel.CloseHandle.assert_called_once_with(123)

    @unittest.skipUnless(launcher.os.name == "nt", "Windows mutex behavior")
    def test_mutex_timeout_never_runs_launch_or_releases_unowned_mutex(self):
        kernel = self.fake_kernel(258)
        with mock.patch.object(launcher.ctypes, "WinDLL", return_value=kernel), self.assertRaisesRegex(RuntimeError, "另一个"):
            with launcher.startup_lock(self.root):
                self.fail("timed-out launcher must not continue")
        kernel.ReleaseMutex.assert_not_called()
        kernel.CloseHandle.assert_called_once_with(123)

    @unittest.skipUnless(launcher.os.name == "nt", "Windows mutex behavior")
    def test_launcher_exception_releases_mutex_for_next_attempt(self):
        kernel = self.fake_kernel()
        with mock.patch.object(launcher.ctypes, "WinDLL", return_value=kernel), self.assertRaisesRegex(RuntimeError, "test failure"):
            with launcher.startup_lock(self.root):
                raise RuntimeError("test failure")
        kernel.ReleaseMutex.assert_called_once_with(123)
        kernel.CloseHandle.assert_called_once_with(123)

    def test_main_opens_after_readiness_inside_serial_lock(self):
        order = []
        @contextlib.contextmanager
        def lock(*args):
            order.append("lock")
            yield
            order.append("unlock")
        with mock.patch.object(launcher, "startup_lock", side_effect=lock), \
             mock.patch.object(launcher, "ensure_server", side_effect=lambda **kwargs: order.append("ready")), \
             mock.patch.object(launcher, "open_for_logon", side_effect=lambda **kwargs: order.append("open") or True), \
             mock.patch.object(launcher, "append_log"):
            self.assertEqual(launcher.main(["--autostart"]), 0)
        self.assertEqual(order, ["lock", "ready", "open", "unlock"])

    def test_main_service_failure_never_opens_browser(self):
        with mock.patch.object(launcher, "startup_lock", return_value=contextlib.nullcontext()), \
             mock.patch.object(launcher, "ensure_server", side_effect=RuntimeError("not ready")), \
             mock.patch.object(launcher, "open_for_logon") as opener, \
             mock.patch.object(launcher, "append_log") as log, mock.patch.object(launcher.sys, "stderr", io.StringIO()):
            self.assertEqual(launcher.main([]), 1)
        opener.assert_not_called()
        log.assert_called_once_with("not ready")

    def test_invalid_port_is_rejected_before_process_or_browser_work(self):
        with mock.patch.object(launcher, "ensure_server") as server, mock.patch.object(launcher.sys, "stderr", io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                launcher.main(["--port", "0"])
        self.assertEqual(raised.exception.code, 2)
        server.assert_not_called()


if __name__ == "__main__":
    unittest.main()
