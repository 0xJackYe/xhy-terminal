"""A damaged newer public cache cannot prevent an offline restart."""
import copy
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from dashboard_server import BEIJING, build_snapshot, load_saved_snapshot
from market_catalog_cache import load_catalog
from test_dashboard_server import fixture_endpoints


class RestartCacheIntegrityTests(unittest.TestCase):
    def test_malformed_snapshot_shapes_skip_to_the_last_valid_export(self):
        endpoints, now = fixture_endpoints()
        baseline = build_snapshot(endpoints, now, datetime.fromtimestamp(now / 1000, BEIJING).isoformat())
        variants = [[], [baseline], {**baseline, "filters": []},
                    {**baseline, "endpoints": []},
                    {**baseline, "endpoints": {**baseline["endpoints"], "mark": []}},
                    {**baseline, "options": ["not-a-contract"] * len(baseline["options"])}]
        for invalid in variants:
            with self.subTest(kind=type(invalid).__name__), tempfile.TemporaryDirectory() as directory:
                Path(directory, "btc_options_a_valid.json").write_text(json.dumps(baseline), encoding="utf-8")
                Path(directory, "btc_options_z_damaged.json").write_text(json.dumps(invalid), encoding="utf-8")
                loaded = load_saved_snapshot(directory)
                self.assertIsNotNone(loaded)
                self.assertEqual(loaded["btc_index_price"], baseline["btc_index_price"])
                json.dumps(loaded, allow_nan=False)

    def test_nonfinite_nested_snapshot_metadata_never_poison_the_restored_stream(self):
        endpoints, now = fixture_endpoints()
        baseline = build_snapshot(endpoints, now, datetime.fromtimestamp(now / 1000, BEIJING).isoformat())
        for literal in ("NaN", "Infinity", "-Infinity", "1e999"):
            invalid = copy.deepcopy(baseline)
            invalid["endpoints"]["exchange_info"]["data"]["extra"] = "NONFINITE_PLACEHOLDER"
            raw = json.dumps(invalid).replace('"NONFINITE_PLACEHOLDER"', literal)
            with self.subTest(literal=literal), tempfile.TemporaryDirectory() as directory:
                Path(directory, "btc_options_a_valid.json").write_text(json.dumps(baseline), encoding="utf-8")
                Path(directory, "btc_options_z_damaged.json").write_text(raw, encoding="utf-8")
                loaded = load_saved_snapshot(directory)
                self.assertIsNotNone(loaded)
                self.assertNotIn("extra", loaded["endpoints"]["exchange_info"]["data"])
                json.dumps(loaded, allow_nan=False)

    def test_nonfinite_catalog_metadata_is_rejected_before_cache_restore(self):
        endpoints, now = fixture_endpoints()
        catalog = endpoints["exchange_info"]
        catalog["received_at_beijing"] = datetime.fromtimestamp(now / 1000, BEIJING).isoformat()
        catalog["data"]["extra"] = "NONFINITE_PLACEHOLDER"
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory, "catalog.json")
            for literal in ("NaN", "Infinity", "1e999"):
                with self.subTest(literal=literal):
                    target.write_text(json.dumps(catalog).replace('"NONFINITE_PLACEHOLDER"', literal), encoding="utf-8")
                    self.assertIsNone(load_catalog(target))


if __name__ == "__main__":
    unittest.main()
