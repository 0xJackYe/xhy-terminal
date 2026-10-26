"""File identity tests use inert sources, no suspect execution or network."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from security_guard import identity


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="xhy-identity-")
        self.directory = Path(self.temporary.name)
        self.metadata = mock.patch.object(identity, "_native_metadata", return_value={"version_info": {}, "signature": {"status": "not_checked", "publisher": ""}})
        self.metadata.start()

    def tearDown(self):
        self.metadata.stop()
        self.temporary.cleanup()

    def source(self, name, value):
        path = self.directory / name
        path.write_bytes(value)
        return path

    def test_content_requires_explicit_authorization(self):
        source = self.source("management.vbs", b"' Windows remote management helper\nWScript.Echo \"hello\"\n")
        result = identity.collect_identity(source)
        self.assertEqual(result["basename"], "management.vbs")
        self.assertEqual(result["content_status"], "withheld")
        self.assertEqual(result["source_excerpt"], "")
        self.assertFalse(result["content_authorized"])
        allowed = identity.collect_identity(source, include_content=True)
        self.assertIn("remote management", allowed["source_excerpt"])
        self.assertEqual(allowed["actual_format"], "script")
        self.assertTrue(allowed["sample_complete"])
        self.assertEqual(source.read_bytes(), b"' Windows remote management helper\nWScript.Echo \"hello\"\n")

    def test_credential_and_private_document_contents_remain_blocked(self):
        for name in (".env", "id_rsa", "wallet.dat", "customer.db", "passwords.txt", "private.pem", "report.pdf", "private.docx"):
            with self.subTest(name=name):
                source = self.source(name, b"PRIVATE_CONTENT_EXAMPLE")
                result = identity.collect_identity(source, include_content=True)
                self.assertEqual(result["content_status"], "blocked_sensitive")
                self.assertNotIn("PRIVATE_CONTENT_EXAMPLE", json.dumps(result))

    def test_expected_hash_mismatch_rejects_changed_file(self):
        source = self.source("example.py", b"print('harmless')")
        with self.assertRaises(OSError):
            identity.collect_identity(source, expected_sha256="0" * 64, include_content=True)
        result = identity.collect_identity(source, expected_sha256=hashlib.sha256(source.read_bytes()).hexdigest(), include_content=True)
        self.assertEqual(result["sha256_verification"], "matched")

    def test_large_file_hash_is_explicitly_not_rechecked(self):
        source = self.source("large.py", b"# " + b"a" * 10000)
        with mock.patch.object(identity, "HASH_RECHECK_LIMIT", 4096):
            result = identity.collect_identity(source, expected_sha256="a" * 64, include_content=True)
        self.assertEqual(result["sha256_verification"], "not_rechecked_large_file")
        self.assertLessEqual(len(result["source_excerpt"]), identity.EXCERPT_CHARS)
        self.assertFalse(result["sample_complete"])

    def test_secret_redaction_covers_assignments_keys_urls_and_personal_paths(self):
        text = ("api_key = 'sk-testsecret987654321'\npassword: huntersecret\n"
                "Authorization: Bearer abcdefghijklmnop\n"
                "url='https://myuser:mypassword@example.test/download?token=privatevalue&x=somevalue'\n"
                "mail='alice@example.test'\npath='C:\\Users\\PrivatePerson\\Documents\\file'\n")
        redacted = identity.redact_text(text)
        for value in ("testsecret", "huntersecret", "abcdefghijklmnop", "myuser", "mypassword", "privatevalue", "somevalue", "alice", "PrivatePerson"):
            self.assertNotIn(value, redacted)
        self.assertIn("example.test/download", redacted)
        self.assertIn("api_key", redacted)

    def test_whitelist_rejects_unknown_keys_and_unapproved_excerpt(self):
        result = identity.prepare_identity_for_ai({"basename": "tool.vbs", "full_path": r"C:\Users\Secret\tool.vbs",
            "location_hint": r"C:\Users\Secret\Documents", "content_status": "included",
            "content_authorized": False, "source_excerpt": "PRIVATE_SOURCE", "size_bytes": True,
            "version_info": {"description": "helper", "private": "PRIVATE_DATA"}})
        raw = json.dumps(result)
        self.assertNotIn("PRIVATE", raw)
        self.assertNotIn("Secret", raw)
        self.assertEqual(result["source_excerpt"], "")
        self.assertEqual(result["content_status"], "withheld")
        self.assertNotIn("size_bytes", result)

    def test_system_location_retains_only_technical_context(self):
        with mock.patch.dict(os.environ, {"SystemRoot": r"C:\Windows"}):
            category, hint = identity._location(Path(r"C:\Windows\WinSxS\amd64_remote-management_component\winrm.vbs"))
        self.assertEqual(category, "windows_system")
        self.assertIn("WinSxS", hint)
        self.assertIn("remote-management", hint)
        category, hint = identity._location(Path(r"C:\Users\PrivatePerson\Documents\CustomerSecret\test.py"))
        self.assertEqual(category, "user_documents")
        self.assertNotIn("PrivatePerson", hint)
        self.assertNotIn("CustomerSecret", hint)

    def test_binary_content_is_not_passed_as_text(self):
        source = self.source("program.exe", b"MZ\x00\x01\x00\x00 executable placeholder")
        result = identity.collect_identity(source, include_content=True)
        self.assertEqual(result["actual_format"], "pe")
        self.assertEqual(result["content_status"], "included")
        self.assertIn("Binary printable strings", result["source_excerpt"])
        self.assertFalse(result["sample_complete"])

    def test_unicode_excerpt_has_both_character_and_byte_limits(self):
        source = self.source("说明.py", ("# 中文说明与用途\n" * 10000).encode())
        result = identity.collect_identity(source, include_content=True)
        self.assertLessEqual(len(result["source_excerpt"]), identity.EXCERPT_CHARS)
        self.assertLessEqual(len(result["source_excerpt"].encode()), identity.EXCERPT_BYTES)
        self.assertFalse(result["sample_complete"])

    def test_unsafe_source_never_reaches_metadata_or_subprocess(self):
        from security_guard import scanner
        source = self.source("unsafe.py", b"harmless")
        with mock.patch.object(scanner, "_unsafe_reason", return_value="reparse"), mock.patch.object(identity, "_native_metadata") as metadata:
            with self.assertRaises(OSError):
                identity.collect_identity(source)
        metadata.assert_not_called()

    def test_native_metadata_uses_fixed_program_literal_path_and_no_shell(self):
        source = self.source("test [x]; harmless.ps1", b"# harmless")
        self.metadata.stop()
        completed = mock.Mock(returncode=0, stdout=json.dumps({"version_info": {"description": "test"},
            "signature": {"status": "NotSigned", "publisher": ""}}).encode())
        with mock.patch.object(identity.subprocess, "run", return_value=completed) as run:
            result = identity._native_metadata(source)
        self.metadata.start()
        self.assertEqual(result["signature"]["status"], "unsigned")
        command = run.call_args.args[0]
        self.assertEqual(Path(command[0]).name.casefold(), "powershell.exe")
        self.assertIn("Get-AuthenticodeSignature -LiteralPath $p", command[-1])
        self.assertIn("Import-Module $a.Location -ErrorAction Stop", command[-1])
        self.assertNotIn(str(source), command[-1])
        self.assertEqual(run.call_args.kwargs["env"]["XHY_GUARD_IDENTITY_PATH"], str(source))
        self.assertIn(r"WindowsPowerShell\v1.0\Modules", run.call_args.kwargs["env"]["PSModulePath"])
        self.assertFalse(run.call_args.kwargs["shell"])

    def test_content_eligibility_and_reuse_do_not_repeat_signature_collection(self):
        source = self.source("management.vbs", b"' remote management\nWScript.Echo \"harmless\"")
        with mock.patch.object(identity, "_native_metadata", return_value={"version_info": {}, "signature": {"status": "unsigned", "publisher": ""}}) as native:
            facts = identity.collect_identity(source)
            self.assertTrue(facts["content_eligible"])
            allowed = identity.add_content_excerpt(source, facts)
        native.assert_called_once()
        self.assertEqual(allowed["content_status"], "included")
        self.assertTrue(allowed["content_authorized"])
        private = self.source("private.pdf", b"%PDF harmless")
        self.assertFalse(identity.collect_identity(private)["content_eligible"])

    def test_content_consent_fails_if_source_changed_since_metadata(self):
        source = self.source("management.vbs", b"old")
        facts = identity.collect_identity(source)
        source.write_bytes(b"new content")
        with self.assertRaises(OSError):
            identity.add_content_excerpt(source, facts)

    def test_report_identity_strips_source_and_freshness_token(self):
        source = self.source("sample.py", b"# Unique source example\nprint('hello')")
        allowed = identity.collect_identity(source, include_content=True)
        report = identity.safe_report_identity(allowed)
        self.assertNotIn("source_excerpt", report)
        self.assertNotIn("_source_token", report)
        self.assertNotIn("Unique source", json.dumps(report))
        self.assertTrue(report["content_authorized"])
        self.assertGreater(report["excerpt_characters"], 0)

    def test_microsoft_trust_requires_verified_signer_and_location(self):
        facts = {"location_class": "windows_system", "signature": {"status": "valid", "publisher": "CN=Microsoft Windows, O=Microsoft Corporation, C=US"}}
        self.assertTrue(identity.trusted_system_identity(facts))
        for changed in ({"location_class": "user_documents"},
                        {"signature": {"status": "unsigned", "publisher": "Microsoft Corporation"}},
                        {"signature": {"status": "valid", "publisher": "CN=Not Microsoft Windows, O=Other Company"}},
                        {"signature": {"status": "valid", "publisher": "CN=Microsoft Corporation, O=Fake Microsoft Corporation"}}):
            self.assertFalse(identity.trusted_system_identity(dict(facts, **changed)))


if __name__ == "__main__":
    unittest.main()
