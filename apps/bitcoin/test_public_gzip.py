"""Offline wire/decoding checks for compressed public market responses."""

import gzip
import io
import json
import unittest
from unittest.mock import patch

import binance_btc_options as market


class Response(io.BytesIO):
    status = 200

    def __init__(self, body, encoding=None, length=None):
        super().__init__(body)
        self.headers = {"Content-Length": str(len(body) if length is None else length)}
        if encoding is not None:
            self.headers["Content-Encoding"] = encoding


class PublicGzipTests(unittest.TestCase):
    def setUp(self):
        self.guard = patch.object(market, "_PUBLIC_REQUEST_LIMITER", market.PublicRequestLimiter())
        self.guard.start()

    def tearDown(self):
        self.guard.stop()

    def request(self, response, path="/eapi/v1/time"):
        with patch.object(market.urllib.request, "urlopen", return_value=response) as fetch:
            result = market.get_public(path, 1, max_attempts=1)
        self.assertEqual(1, fetch.call_count)
        self.assertEqual("gzip", fetch.call_args.args[0].get_header("Accept-encoding"))
        return result

    def assert_bad_body(self, result):
        self.assertFalse(result["ok"])
        self.assertNotIn("data", result)
        self.assertEqual("INVALID_JSON", result["error"]["type"])
        self.assertEqual("decode", result["error"]["phase"])
        self.assertFalse(result["error"]["retryable"])

    def test_gzip_utf8_json_decodes_and_header_requests_compression(self):
        payload = {"serverTime": 1792182000000, "notice": "公开行情正常"}
        compressed = gzip.compress(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        result = self.request(Response(compressed, "gzip"))
        self.assertTrue(result["ok"])
        self.assertTrue(result["response_complete"])
        self.assertEqual(payload, result["data"])

    def test_content_length_is_checked_against_wire_bytes_not_expanded_json(self):
        payload = {"serverTime": 1792182000000, "padding": "x" * 20000}
        expanded = json.dumps(payload).encode()
        compressed = gzip.compress(expanded)
        self.assertLess(len(compressed), len(expanded))
        result = self.request(Response(compressed, "gzip", length=len(compressed)))
        self.assertTrue(result["ok"])
        self.assertEqual(payload, result["data"])
        incomplete = self.request(Response(compressed, "gzip", length=len(expanded)))
        self.assertFalse(incomplete["ok"])
        self.assertEqual("READ_INTERRUPTED", incomplete["error"]["type"])
        self.assertFalse(incomplete["response_complete"])
        self.assertNotIn("data", incomplete)

    def test_expansion_limit_rejects_highly_compressible_body_without_data(self):
        expanded = json.dumps({"serverTime": 1792182000000, "padding": "x" * 5000}).encode()
        compressed = gzip.compress(expanded)
        self.assertLess(len(compressed), 512)
        with patch.object(market, "MAX_RESPONSE_BYTES", 512):
            result = self.request(Response(compressed, "gzip"))
        self.assert_bad_body(result)

    def test_corrupt_or_truncated_gzip_never_becomes_usable_or_network_retry(self):
        compressed = gzip.compress(b'{"serverTime":1792182000000}')
        corrupt_crc = bytearray(compressed)
        corrupt_crc[-8] ^= 1
        for body in (b"private-proxy-token", compressed[:-1], bytes(corrupt_crc), compressed[:12]):
            with self.subTest(body=body):
                result = self.request(Response(body, "gzip"))
                self.assert_bad_body(result)
                self.assertNotIn("private-proxy-token", json.dumps(result))

    def test_identity_or_absent_encoding_preserves_plain_response_compatibility(self):
        plain = b'{"serverTime":1792182000000}'
        for encoding in (None, "identity", " Identity "):
            with self.subTest(encoding=encoding):
                result = self.request(Response(plain, encoding))
                self.assertTrue(result["ok"])
                self.assertEqual(1792182000000, result["data"]["serverTime"])

    def test_gzip_header_is_case_insensitive_and_unknown_encodings_are_rejected(self):
        plain = b'{"serverTime":1792182000000}'
        self.assertTrue(self.request(Response(gzip.compress(plain), " GZip "))["ok"])
        for encoding in ("br", "deflate", "gzip, br"):
            with self.subTest(encoding=encoding):
                self.assert_bad_body(self.request(Response(plain, encoding)))

    def test_compressed_binance_error_and_nonfinite_json_still_fail_validation(self):
        payload = gzip.compress(b'{"code":-1121,"msg":"private-proxy-token"}')
        result = self.request(Response(payload, "gzip"))
        self.assertFalse(result["ok"])
        self.assertNotIn("data", result)
        self.assertEqual("BINANCE_ERROR", result["error"]["type"])
        self.assertEqual(-1121, result["error"]["code"])
        self.assertNotIn("private-proxy-token", json.dumps(result))
        self.assert_bad_body(self.request(Response(gzip.compress(b'{"serverTime":NaN}'), "gzip")))

    def test_compressed_invalid_utf8_or_json_is_sanitized(self):
        for plain in (b'{"serverTime":\xff}', b'{"private-proxy-token":'):
            with self.subTest(plain=plain):
                result = self.request(Response(gzip.compress(plain), "gzip"))
                self.assert_bad_body(result)
                self.assertNotIn("private-proxy-token", json.dumps(result))

    def test_concatenated_members_share_one_expanded_limit(self):
        # Gzip permits multiple members; a per-member limit would let each
        # member independently fit while the complete JSON exceeds the cap.
        body = gzip.compress(b'{"serverTime":1792182000000,"padding":"')
        body += gzip.compress(b"x" * 500 + b'"}')
        with patch.object(market, "MAX_RESPONSE_BYTES", 256):
            self.assert_bad_body(self.request(Response(body, "gzip")))


if __name__ == "__main__":
    unittest.main()
