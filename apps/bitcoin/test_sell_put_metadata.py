"""Offline contract-metadata propagation checks; no credentials or network."""

import copy
import csv
import io
import tempfile
import unittest
from datetime import datetime
from types import SimpleNamespace

from binance_btc_options import FIELDS, rows_from_data
from dashboard_server import ALL_FILTERS, BEIJING, MarketCache, build_snapshot
from test_dashboard_server import fixture_endpoints


EXPECTED = {
    "initial_margin_rate": "0.17100000000000000001",
    "min_initial_margin_rate": "0.111000",
    "maintenance_margin_rate": "0.081000",
    "min_maintenance_margin_rate": "0.051000",
    "liquidation_fee_rate": "0.00212345678901234567",
    "quantity_step": "0.005000",
    "max_qty": "123.4500",
}


def add_metadata(contract):
    contract.update(initialMargin=EXPECTED["initial_margin_rate"],
                    minInitialMargin=EXPECTED["min_initial_margin_rate"],
                    maintenanceMargin=EXPECTED["maintenance_margin_rate"],
                    minMaintenanceMargin=EXPECTED["min_maintenance_margin_rate"],
                    liquidationFeeRate=EXPECTED["liquidation_fee_rate"])
    contract["filters"] = [
        {"filterType": "PRICE_FILTER", "stepSize": "999", "maxQty": "999"},
        {"filterType": "LOT_SIZE", "minQty": "0.005", "stepSize": EXPECTED["quantity_step"], "maxQty": EXPECTED["max_qty"]},
    ]


class SellPutMetadataTests(unittest.TestCase):
    def setUp(self):
        self.endpoints, self.now = fixture_endpoints()
        self.stamp = datetime.fromtimestamp(self.now / 1000, BEIJING).isoformat(timespec="milliseconds")
        self.contract = self.endpoints["exchange_info"]["data"]["optionSymbols"][0]

    def rows(self):
        return rows_from_data(self.endpoints, self.now, SimpleNamespace(**ALL_FILTERS))[0]

    def assert_metadata(self, row, expected=EXPECTED):
        self.assertEqual(expected, {field: row[field] for field in EXPECTED})

    def test_public_rows_preserve_exact_rates_and_lot_limits_per_contract(self):
        add_metadata(self.contract)
        original = copy.deepcopy(self.endpoints)
        rows = self.rows()
        self.assert_metadata(rows[0])
        self.assert_metadata(rows[1], dict.fromkeys(EXPECTED))
        self.assertEqual(1, rows[0]["unit"])
        self.assertEqual("0.01", rows[0]["min_qty"])
        self.assertEqual(original, self.endpoints)

    def test_absent_metadata_is_explicitly_unknown_and_csv_schema_carries_it(self):
        rows = self.rows()
        self.assertTrue(rows)
        for row in rows:
            self.assert_metadata(row, dict.fromkeys(EXPECTED))
        stream = io.StringIO()
        writer = csv.DictWriter(stream, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
        exported = next(csv.DictReader(io.StringIO(stream.getvalue())))
        self.assertTrue(all(field in exported and exported[field] == "" for field in EXPECTED))

    def test_invalid_optional_numbers_do_not_invent_margin_or_break_public_quotes(self):
        add_metadata(self.contract)
        self.contract.update(initialMargin=True, minInitialMargin="NaN", maintenanceMargin=float("inf"),
                             minMaintenanceMargin={"value": "0.05"}, liquidationFeeRate="")
        self.contract["filters"][1].update(stepSize="Infinity", maxQty=False)
        snapshot = build_snapshot(self.endpoints, self.now, self.stamp)
        self.assertEqual("SUCCESS", snapshot["status"])
        self.assert_metadata(snapshot["options"][0], dict.fromkeys(EXPECTED))
        self.assertEqual("490", snapshot["options"][0]["bid_price"])

    def test_lot_size_is_not_inferred_from_top_level_or_price_filter(self):
        self.contract.update(maxQty="500", minQty="0.02", unit=2)
        for filters in (None, [], [None, "bad", {"filterType": "PRICE_FILTER", "stepSize": "1", "maxQty": "3"}],
                        [{"filterType": "LOT_SIZE", "stepSize": "0.01"}, {"filterType": "LOT_SIZE", "stepSize": "0.02"}]):
            with self.subTest(filters=filters):
                self.contract["filters"] = filters
                row = self.rows()[0]
                self.assertIsNone(row["quantity_step"])
                self.assertIsNone(row["max_qty"])
                self.assertEqual((2, "0.02"), (row["unit"], row["min_qty"]))

    def test_snapshot_and_lightweight_public_cache_view_keep_metadata(self):
        add_metadata(self.contract)
        snapshot = build_snapshot(self.endpoints, self.now, self.stamp)
        self.assert_metadata(snapshot["options"][0])
        with tempfile.TemporaryDirectory() as directory:
            cache = MarketCache(directory, websocket_factory=None)
            try:
                cache._snapshot = snapshot
                cache._rows_by_symbol = {row["symbol"]: row for row in snapshot["options"]}
                _, view = cache.wait_snapshot(-1, timeout=0)
                self.assertNotIn("endpoints", view)
                self.assert_metadata(view["options"][0])
            finally:
                cache.stop()

    def test_catalog_partial_refresh_replaces_rates_and_clears_missing_metadata(self):
        add_metadata(self.contract)
        with tempfile.TemporaryDirectory() as directory:
            cache = MarketCache(directory, websocket_factory=None)
            try:
                cache._snapshot = build_snapshot(self.endpoints, self.now, self.stamp)
                refreshed = copy.deepcopy(self.endpoints["exchange_info"])
                contract = refreshed["data"]["optionSymbols"][0]
                contract["initialMargin"] = "0.181"
                contract.pop("minInitialMargin")
                contract["filters"][1]["stepSize"] = "0.02"
                contract["filters"][1].pop("maxQty")
                with cache._condition:
                    result, checked = cache._merge_partial_locked({"exchange_info": refreshed}, self.stamp, 0, self.now)
                expected = dict(EXPECTED, initial_margin_rate="0.181", min_initial_margin_rate=None,
                                quantity_step="0.02", max_qty=None)
                self.assert_metadata(result["options"][0], expected)
                self.assertIn("exchange_info", checked)
                self.assertEqual("490", result["options"][0]["bid_price"])
                self.assertEqual("rest", result["options"][0]["field_source"]["bid_price"])
            finally:
                cache.stop()

    def test_quote_only_partial_refresh_does_not_change_contract_metadata(self):
        add_metadata(self.contract)
        with tempfile.TemporaryDirectory() as directory:
            cache = MarketCache(directory, websocket_factory=None)
            try:
                cache._snapshot = build_snapshot(self.endpoints, self.now, self.stamp)
                mark = copy.deepcopy(self.endpoints["mark"])
                mark["data"][0]["markPrice"] = "600"
                with cache._condition:
                    result, _ = cache._merge_partial_locked({"mark": mark}, self.stamp, 0, self.now)
                self.assert_metadata(result["options"][0])
                self.assertEqual("600", result["options"][0]["mark_price"])
            finally:
                cache.stop()


if __name__ == "__main__":
    unittest.main()

