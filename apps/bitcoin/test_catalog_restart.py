"""Restart recovery must retain verified rules without refreshing old quotes."""
import copy
import json
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path

from dashboard_server import BEIJING, MarketCache, MarketFetchError, build_snapshot
from market_catalog_cache import load_catalog, save_catalog
from test_dashboard_server import fixture_endpoints


class CatalogRestartTests(unittest.TestCase):
    def test_restart_uses_newest_verified_rules_without_relabeling_old_marks(self):
        endpoints, now = fixture_endpoints()
        old_at = datetime.fromtimestamp((now - 65000) / 1000, BEIJING).isoformat(timespec="milliseconds")
        baseline = build_snapshot(endpoints, now - 65000, old_at)
        latest = copy.deepcopy(endpoints["exchange_info"])
        latest["received_at_beijing"] = datetime.fromtimestamp((now - 5000) / 1000, BEIJING).isoformat(timespec="milliseconds")
        for contract in latest["data"]["optionSymbols"]:
            contract["initialMargin"] = "0.20"
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "btc_options_old.json").write_text(json.dumps(baseline), encoding="utf-8")
            self.assertTrue(save_catalog(Path(directory, "dashboard_catalog_cache.json"), latest))
            cache = MarketCache(directory, websocket_factory=None)
            try:
                snapshot = cache.read()
                self.assertEqual(latest["received_at_beijing"], snapshot["catalog_updated_at"])
                for row in snapshot["options"]:
                    self.assertEqual("0.20", row["initial_margin_rate"])
                    self.assertEqual(now - 65000, row["field_updated_at"]["mark_price"])
                self.assertEqual("stale", snapshot["data_health"]["mark"]["status"])
                self.assertEqual("fresh", snapshot["data_health"]["catalog"]["status"])
                self.assertTrue(snapshot["stale"])
            finally:
                cache.stop()

    def test_partial_catalog_success_is_saved_and_survives_restart_alone(self):
        endpoints, now = fixture_endpoints()
        latest = endpoints["exchange_info"]
        latest["received_at_beijing"] = datetime.fromtimestamp(now / 1000, BEIJING).isoformat(timespec="milliseconds")
        def collect():
            raise MarketFetchError("partial", {"mark": {"type": "READ_TIMEOUT"}},
                                   {"exchange_info": latest}, latest["received_at_beijing"], 0)
        with tempfile.TemporaryDirectory() as directory:
            cache = MarketCache(directory, collector=collect, websocket_factory=None)
            try:
                cache._collect_and_apply()
                saved = load_catalog(Path(directory, "dashboard_catalog_cache.json"))
                self.assertEqual(latest["received_at_beijing"], saved["received_at_beijing"])
            finally:
                cache.stop()
            restored = MarketCache(directory, websocket_factory=None)
            try:
                snapshot = restored.read()
                self.assertTrue(snapshot["options"])
                self.assertEqual(latest["received_at_beijing"], snapshot["catalog_updated_at"])
                self.assertIsNone(snapshot["options"][0]["mark_price"])
                self.assertIsNone(snapshot["options"][0]["field_updated_at"]["mark_price"])
            finally:
                restored.stop()


if __name__ == "__main__":
    unittest.main()
