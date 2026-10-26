"""Offline coverage for the public catalog restart cache."""

import copy
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import market_catalog_cache as catalog


class MarketCatalogCacheTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "catalog.json"
        self.now = 1792269645000
        self.stamp = datetime.fromtimestamp((self.now - 10000) / 1000, timezone.utc).isoformat(timespec="milliseconds")
        self.endpoint = {"ok": True, "received_at_beijing": self.stamp, "data": {"optionSymbols": [
            {"symbol": "BTC-261030-63000-P", "side": "PUT", "underlying": "BTCUSDT",
             "expiryDate": 1793347200000, "strikePrice": "63000.000", "initialMargin": "0.15000000"}
        ]}, "rate_headers": {"x-mbx-used-weight-1m": "42", "Retry-After": "10", "Authorization": "private"},
            "url": "https://eapi.binance.com/eapi/v1/exchangeInfo", "secret": "must-not-persist"}
        self.clock = patch.object(catalog.time, "time", return_value=self.now / 1000)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def test_roundtrip_preserves_original_receipt_and_exact_metadata(self):
        before = copy.deepcopy(self.endpoint)
        self.assertTrue(catalog.save_catalog(self.path, self.endpoint))
        result = catalog.load_catalog(self.path, now_ms=self.now + 86400000)
        self.assertEqual(self.stamp, result["received_at_beijing"])
        self.assertEqual(self.endpoint["data"], result["data"])
        self.assertEqual(before, self.endpoint)
        self.assertEqual({"ok", "data", "received_at_beijing", "rate_headers"}, set(result))
        self.assertEqual({"x-mbx-used-weight-1m": "42", "Retry-After": "10"}, result["rate_headers"])
        self.assertNotIn("must-not-persist", self.path.read_text(encoding="utf-8"))
        result["data"]["optionSymbols"].clear()
        self.assertTrue(catalog.load_catalog(self.path, self.now)["data"]["optionSymbols"])

    def test_missing_bad_json_and_oversized_file_return_none(self):
        self.assertIsNone(catalog.load_catalog(self.path, self.now))
        for raw in (b"{", b"null", b"[]", b'{"ok":true,"data":NaN}'):
            with self.subTest(raw=raw):
                self.path.write_bytes(raw)
                self.assertIsNone(catalog.load_catalog(self.path, self.now))
        with self.path.open("wb") as stream:
            stream.truncate(catalog.MAX_CATALOG_BYTES + 1)
        self.assertIsNone(catalog.load_catalog(self.path, self.now))

    def test_invalid_schema_never_replaces_valid_cache(self):
        self.assertTrue(catalog.save_catalog(self.path, self.endpoint))
        original = self.path.read_bytes()
        for mutation in ({"ok": False}, {"ok": 1}, {"data": None}, {"data": {"optionSymbols": []}},
                         {"data": {"optionSymbols": [{"symbol": "BTC-bad"}]}}):
            bad = dict(self.endpoint, **mutation)
            with self.subTest(mutation=mutation):
                self.assertFalse(catalog.save_catalog(self.path, bad))
                self.assertEqual(original, self.path.read_bytes())
                self.path.write_text(json.dumps(bad), encoding="utf-8")
                self.assertIsNone(catalog.load_catalog(self.path, self.now))
                self.path.write_bytes(original)

    def test_missing_naive_invalid_and_future_receipts_are_rejected(self):
        for stamp in (None, "not-a-date", "2026-10-18T04:40:45", "1970-01-01T00:00:00+00:00",
                      datetime.fromtimestamp((self.now + 2001) / 1000, timezone.utc).isoformat(timespec="milliseconds")):
            bad = dict(self.endpoint, received_at_beijing=stamp)
            with self.subTest(stamp=stamp):
                self.assertFalse(catalog.save_catalog(self.path, bad))
                self.path.write_text(json.dumps(bad), encoding="utf-8")
                self.assertIsNone(catalog.load_catalog(self.path, self.now))
        acceptable = dict(self.endpoint, received_at_beijing=datetime.fromtimestamp((self.now + 2000) / 1000,
                          timezone.utc).isoformat(timespec="milliseconds"))
        self.assertTrue(catalog.save_catalog(self.path, acceptable))
        self.assertIsNotNone(catalog.load_catalog(self.path, self.now))

    def test_atomic_replace_failure_preserves_old_file_and_cleans_temporary(self):
        self.assertTrue(catalog.save_catalog(self.path, self.endpoint))
        original = self.path.read_bytes()
        newer = copy.deepcopy(self.endpoint)
        newer["data"]["optionSymbols"][0]["strikePrice"] = "64000.000"
        with patch.object(Path, "replace", side_effect=OSError("replace failed")):
            self.assertFalse(catalog.save_catalog(self.path, newer))
        self.assertEqual(original, self.path.read_bytes())
        self.assertEqual([self.path], list(self.path.parent.iterdir()))

    def test_write_failure_preserves_old_file(self):
        self.assertTrue(catalog.save_catalog(self.path, self.endpoint))
        original = self.path.read_bytes()
        with patch.object(catalog.os, "fsync", side_effect=OSError("disk failure")):
            self.assertFalse(catalog.save_catalog(self.path, self.endpoint))
        self.assertEqual(original, self.path.read_bytes())
        self.assertEqual([self.path], list(self.path.parent.iterdir()))

    def test_oversized_or_unserializable_endpoint_is_not_saved(self):
        self.assertTrue(catalog.save_catalog(self.path, self.endpoint))
        original = self.path.read_bytes()
        bad = copy.deepcopy(self.endpoint)
        bad["data"]["extra"] = object()
        self.assertFalse(catalog.save_catalog(self.path, bad))
        bad["data"]["extra"] = "x" * 100
        with patch.object(catalog, "MAX_CATALOG_BYTES", 40):
            self.assertFalse(catalog.save_catalog(self.path, bad))
        self.assertEqual(original, self.path.read_bytes())


if __name__ == "__main__":
    unittest.main()
