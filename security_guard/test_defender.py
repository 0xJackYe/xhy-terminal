"""Tests never start Defender or write malware samples."""
import ctypes
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from security_guard import defender


class FakeProcess:
    def __init__(self, output=b"", code=0):
        self.stdout = io.BytesIO(output)
        self.returncode = code
        self.terminated = False
        self.killed = False

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = -15

    def kill(self):
        self.killed = True
        self.returncode = -9


class DefenderTests(unittest.TestCase):
    def test_command_is_custom_no_remediation_and_does_not_use_shell(self):
        target = Path('a & dangerous; $(name).exe')
        command = defender.build_scan_command(Path('C:/Program Files/Windows Defender/MpCmdRun.exe'), target)
        self.assertEqual(command[1:4], ['-Scan', '-ScanType', '3'])
        self.assertEqual(command[-1], '-DisableRemediation')
        self.assertEqual(command[5], os.path.abspath(str(target)))
        self.assertNotIn('-ReturnHR', command)

    def test_numeric_platform_version_order_and_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = root / 'Microsoft' / 'Windows Defender' / 'Platform'
            for version in ('4.18.9.2-0', '4.18.10.1-0', 'not-a-version'):
                directory = base / version
                directory.mkdir(parents=True)
                (directory / 'MpCmdRun.exe').touch()
            with patch.object(defender, 'WINDOWS', True), patch.dict(os.environ, {'ProgramData': tmp, 'ProgramFiles': tmp}):
                self.assertEqual(defender.find_engine().parent.name, '4.18.10.1-0')

    def test_exit_two_without_explicit_detection_is_error(self):
        result = defender.classify_result(Path('C:/'), 2, 'Scan failed with hr = 0x800106ba\n')
        self.assertEqual(result.status, 'error')
        self.assertEqual(result.findings, [])
        self.assertTrue(result.coverage_incomplete)
        self.assertIn('2', result.detail)

    def test_clean_output_has_no_findings(self):
        result = defender.classify_result(Path('C:/'), 0, 'Scan finished.\nNo threats found.\n')
        self.assertEqual(result.status, 'clean')
        self.assertEqual(result.findings, [])
        self.assertFalse(result.coverage_incomplete)

    def test_explicit_detection_without_paths_does_not_invent_a_file(self):
        result = defender.classify_result(Path('C:/'), 2, 'Threat : Example:Demo/Suspicious\n')
        self.assertEqual(result.status, 'threat')
        self.assertEqual(result.findings, [])
        self.assertIn('未能解析', result.detail)
        self.assertTrue(result.coverage_incomplete)

    def test_labelled_resources_and_archive_container_are_retained(self):
        output = '\n'.join([
            'file : C:\\must-not-invent.exe',
            'Threat : Example:Demo/Suspicious',
            'file : C:\\Downloads\\a & b.exe',
            'file : C:\\Downloads\\a & b.exe',
            'containerfile : C:\\Downloads\\archive.zip -> inner.exe',
            'resource : file:_D:\\a.cmd',
            'resource : relative\\a.cmd',
        ])
        result = defender.classify_result(Path('C:/'), 2, output)
        self.assertEqual(result.status, 'threat')
        self.assertEqual([f.path for f in result.findings], [r'C:\Downloads\a & b.exe', r'C:\Downloads\archive.zip', r'D:\a.cmd'])
        self.assertTrue(all(f.source == 'defender' and f.severity == 'high' for f in result.findings))
        self.assertFalse(result.coverage_incomplete)

    def test_localized_detection_labels(self):
        result = defender.classify_result(Path('C:/'), 2, '威胁名称：Example:Demo/Test\n文件：D:\\下载\\测试.exe\n')
        self.assertEqual(result.status, 'threat')
        self.assertEqual(result.findings[0].path, 'D:\\下载\\测试.exe')

    def test_nonzero_exit_never_claims_clean(self):
        result = defender.classify_result(Path('C:/'), 0x80070005, '')
        self.assertEqual(result.status, 'error')
        self.assertTrue(result.coverage_incomplete)

    def test_threat_with_nonstandard_exit_is_incomplete(self):
        result = defender.classify_result(Path('C:/'), 0x80070005, 'Threat : Example:Demo/Test\nfile : C:\\sample.exe\n')
        self.assertEqual(result.status, 'threat')
        self.assertEqual(len(result.findings), 1)
        self.assertTrue(result.coverage_incomplete)

    def test_threat_with_scan_failure_is_incomplete_even_with_exit_two(self):
        result = defender.classify_result(Path('C:/'), 2, 'Threat : Example:Demo/Test\nfile : C:\\sample.exe\nScan failed with error 5\n')
        self.assertEqual(result.status, 'threat')
        self.assertTrue(result.coverage_incomplete)

    def test_streamed_scan_keeps_all_guard_flags(self):
        fake = FakeProcess(b'Scan finished.\nNo threats found.\n', 0)
        output = []
        with patch.object(defender, 'find_engine', return_value=Path('C:/engine/MpCmdRun.exe')), patch.object(defender, 'validate_scan_target', side_effect=lambda p: p), patch.object(defender.subprocess, 'Popen', return_value=fake) as popen:
            result = defender.run_scan(Path('C:/harmless'), on_output=output.append)
        self.assertEqual(result.status, 'clean')
        self.assertIn('Scan finished.', ''.join(output))
        args, kwargs = popen.call_args
        self.assertIn('-DisableRemediation', args[0])
        self.assertEqual(args[0][args[0].index('-ScanType') + 1], '3')
        self.assertIs(kwargs['shell'], False)
        self.assertFalse(fake.terminated)

    def test_cancel_only_terminates_owned_process(self):
        fake = FakeProcess(b'', None)
        checks = iter([False, True])
        with patch.object(defender, 'find_engine', return_value=Path('C:/engine/MpCmdRun.exe')), patch.object(defender, 'validate_scan_target', side_effect=lambda p: p), patch.object(defender.subprocess, 'Popen', return_value=fake) as popen:
            result = defender.run_scan(Path('C:/harmless'), stop=lambda: next(checks, True))
        self.assertEqual(result.status, 'cancelled')
        self.assertTrue(fake.terminated)
        self.assertEqual(popen.call_count, 1)
        self.assertNotIn('-Cancel', popen.call_args[0][0])
        self.assertIn('可能继续', result.detail)
        self.assertTrue(result.coverage_incomplete)

    def test_rejected_root_cannot_bypass_local_scanner_policy(self):
        from security_guard import scanner
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(defender, 'find_engine', return_value=Path('C:/engine/MpCmdRun.exe')), patch.object(scanner, '_validate_ancestors'), patch.object(scanner, '_unsafe_reason', return_value='重解析点，未跟随'), patch.object(defender.subprocess, 'Popen') as popen:
                result = defender.run_scan(Path(tmp))
        self.assertEqual(result.status, 'error')
        self.assertTrue(result.coverage_incomplete)
        popen.assert_not_called()

    def test_unsafe_ancestor_and_missing_root_do_not_launch_defender(self):
        from security_guard import scanner
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(defender, 'find_engine', return_value=Path('C:/engine/MpCmdRun.exe')), patch.object(scanner, '_validate_ancestors', side_effect=OSError('unsafe ancestor')), patch.object(defender.subprocess, 'Popen') as popen:
                result = defender.run_scan(Path(tmp))
                self.assertTrue(result.coverage_incomplete)
                popen.assert_not_called()
            with patch.object(defender, 'find_engine', return_value=Path('C:/engine/MpCmdRun.exe')), patch.object(defender.subprocess, 'Popen') as popen:
                result = defender.run_scan(Path(tmp) / 'does-not-exist')
                self.assertTrue(result.coverage_incomplete)
                popen.assert_not_called()

    def test_partial_output_overflow_is_incomplete(self):
        fake = FakeProcess(b'01234567890123456789', 0)
        output = []
        with patch.object(defender, 'MAX_CAPTURE', 10), patch.object(defender, 'find_engine', return_value=Path('C:/engine/MpCmdRun.exe')), patch.object(defender, 'validate_scan_target', side_effect=lambda p: p), patch.object(defender.subprocess, 'Popen', return_value=fake):
            result = defender.run_scan(Path('C:/harmless'), on_output=output.append)
        self.assertEqual(result.status, 'error')
        self.assertTrue(result.coverage_incomplete)
        self.assertEqual(''.join(output), '01234567890123456789')

    @unittest.skipUnless(os.name == 'nt', 'Native Windows command-line parser')
    def test_windows_quoting_round_trips_drive_root_and_spaced_path(self):
        parse = ctypes.WinDLL('shell32', use_last_error=True).CommandLineToArgvW
        parse.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
        parse.restype = ctypes.POINTER(ctypes.c_wchar_p)
        free = ctypes.WinDLL('kernel32', use_last_error=True).LocalFree
        free.argtypes = [ctypes.c_void_p]
        free.restype = ctypes.c_void_p
        for target in (Path(Path.cwd().anchor), Path(Path.cwd().anchor) / 'a b' / ''):
            command = defender.build_scan_command(Path('C:/Program Files/Windows Defender/MpCmdRun.exe'), target)
            count = ctypes.c_int()
            pointer = parse(subprocess.list2cmdline(command), ctypes.byref(count))
            self.assertTrue(pointer)
            try:
                self.assertEqual([pointer[i] for i in range(count.value)], command)
            finally:
                free(pointer)

    def test_unavailable_engine_does_not_start_any_process(self):
        with patch.object(defender, 'find_engine', return_value=None), patch.object(defender.subprocess, 'Popen') as popen:
            result = defender.run_scan(Path('C:/'))
        self.assertEqual(result.status, 'error')
        popen.assert_not_called()

    def test_status_uses_read_only_command_and_does_not_expose_output_on_error(self):
        data = {'enabled': True, 'realtime_enabled': True, 'signature_updated': '2026-10-27T10:00:00',
                'signature_age_days': 0, 'signature_version': '1.2.3.4', 'running_mode': 'Normal'}
        completed = subprocess.CompletedProcess([], 0, json.dumps(data).encode('utf-8'), b'')
        with patch.object(defender, 'WINDOWS', True), patch.object(defender, 'find_engine', return_value=Path('C:/engine.exe')), patch.object(defender.subprocess, 'run', return_value=completed) as run:
            result = defender.status()
        self.assertTrue(result['enabled'])
        self.assertTrue(result['realtime_enabled'])
        self.assertEqual(result['signature_age_days'], 0)
        script = run.call_args[0][0][-1]
        self.assertIn('Get-MpComputerStatus', script)
        self.assertNotIn('Set-MpPreference', script)
        self.assertNotIn('Start-MpScan', script)
        self.assertNotIn('Update-MpSignature', script)


if __name__ == '__main__':
    unittest.main()
