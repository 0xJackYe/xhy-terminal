"""Offline financial invariants; no credentials, API data, or network are used."""

import json
import unittest
from decimal import Decimal

from account_audit_performance import (
    audit_json_default, cashflow_adjusted_pnl, modified_dietz, value_option_account,
)


D = Decimal
START = 1700000000000
DAY = 86400000
END = START + 365 * DAY


def flow(amount, day):
    return {"amount": str(amount), "timestamp_ms": START + day * DAY}


def performance(start="1000", end="1100", flows=(), **kwargs):
    return modified_dietz(start, end, flows, START, END, flows_complete=True, **kwargs)


class CashFlowPerformanceTests(unittest.TestCase):
    def test_sell_open_premium_increases_cash_but_is_not_profit(self):
        after_open = value_option_account("1010", [
            {"symbol": "BTC-P", "quantity": "-1", "side": "SELL",
             "markPrice": "10", "unit": "1", "markValue": "10"},
        ])
        self.assertTrue(after_open["valid"])
        self.assertEqual(after_open["option_mark_value"], D("-10"))
        self.assertEqual(after_open["equity"], D("1000"))
        result = performance("1000", after_open["equity"])
        self.assertEqual(result["net_pnl"], D(0))
        self.assertEqual(result["period_return"], D(0))

    def test_deposit_only_is_not_profit(self):
        records = [flow(500, 100)]
        self.assertEqual(cashflow_adjusted_pnl("1000", "1500", records, START, END), D(0))
        result = performance(end="1500", flows=records)
        self.assertEqual(result["period_return"], D(0))
        self.assertEqual(result["simple_annualized_return"], D(0))

    def test_multiple_flows_have_correct_time_weights(self):
        # Over 100 days: +500 at day 20 weighs 0.8; -200 at day 75 weighs 0.25.
        result = modified_dietz("1000", "1435", [flow(500, 20), flow(-200, 75)],
                                START, START + 100 * DAY, flows_complete=True)
        self.assertEqual(result["net_external_flow"], D("300"))
        self.assertEqual(result["weighted_external_flow"], D("350"))
        self.assertEqual(result["weighted_capital"], D("1350"))
        self.assertEqual(result["net_pnl"], D("135"))
        self.assertEqual(result["period_return"], D("0.1"))
        self.assertEqual(result["simple_annualized_return"], D("0.365"))
        self.assertGreater(result["compound_annualized_return"], D("0.4"))

    def test_withdrawal_is_not_a_loss(self):
        result = performance(end="600", flows=[flow(-400, 100)])
        self.assertEqual(result["net_pnl"], D(0))
        self.assertEqual(result["period_return"], D(0))

    def test_open_seller_liability_reduces_ending_equity(self):
        valuation = value_option_account("1100", [
            {"quantity": "-2", "side": "SHORT", "markPrice": "150", "unit": "1"},
        ])
        self.assertEqual(valuation["equity"], D("800"))
        result = performance(end=valuation["equity"])
        self.assertEqual(result["net_pnl"], D("-200"))
        self.assertEqual(result["period_return"], D("-0.2"))

    def test_fees_are_losses_even_after_premium_received(self):
        valuation = value_option_account("1009.50", [
            {"quantity": "-1", "side": "SHORT", "markPrice": "10", "unit": "1"},
        ])
        result = performance(end=valuation["equity"])
        self.assertEqual(result["net_pnl"], D("-0.50"))
        self.assertEqual(result["period_return"], D("-0.0005"))

    def test_interval_boundaries_and_outside_records(self):
        result = modified_dietz("100", "150", [flow(20, 0), flow(30, 100),
                                                 flow(999, -1), flow(999, 101)],
                                START, START + 100 * DAY, flows_complete=True)
        self.assertEqual(result["included_flow_count"], 2)
        self.assertEqual(result["excluded_flow_count"], 2)
        self.assertEqual(result["weighted_external_flow"], D("20"))
        self.assertEqual(result["weighted_capital"], D("120"))
        self.assertEqual(result["net_pnl"], D(0))

    def test_time_ms_alias_and_conflicting_timestamps(self):
        record = {"amount": "100", "time_ms": START}
        self.assertEqual(performance(end="1100", flows=[record])["net_pnl"], D(0))
        record["timestamp_ms"] = END
        self.assertIsNone(performance(flows=[record])["net_pnl"])

    def test_missing_start_equity_does_not_invent_history(self):
        result = performance(start=None)
        self.assertIsNone(result["net_pnl"])
        self.assertIsNone(result["period_return"])
        self.assertIsNone(result["simple_annualized_return"])
        self.assertIsNone(result["compound_annualized_return"])
        self.assertIn("MISSING_START_EQUITY", result["warnings"])

    def test_unknown_or_unconfirmed_flows_suppress_returns(self):
        for records in (None, [flow(100, 100)]):
            with self.subTest(records=records):
                result = modified_dietz("1000", "1100", records, START, END)
                self.assertFalse(result["flows_complete"])
                self.assertIsNone(result["net_pnl"])
                self.assertIsNone(result["period_return"])
                self.assertIsNone(result["simple_annualized_return"])
                self.assertFalse(result["annualization_allowed"])

    def test_malformed_flow_is_not_silently_zero(self):
        for record in ({"amount": "10"}, {"timestamp_ms": START},
                       {"amount": "NaN", "timestamp_ms": START},
                       {"amount": True, "timestamp_ms": START},
                       {"amount": "10", "timestamp_ms": START, "external": None}):
            with self.subTest(record=record):
                result = performance(flows=[record])
                self.assertFalse(result["flows_complete"])
                self.assertIsNone(result["net_pnl"])
                self.assertIsNone(result["compound_annualized_return"])
                self.assertIsNone(cashflow_adjusted_pnl("1000", "1100", [record], START, END))

    def test_nonpositive_capital_has_no_return_or_annualization(self):
        for starting, ending, records in (("0", "0", []), ("100", "0", [flow(-300, 0)]),
                                          ("-100", "10", [])):
            with self.subTest(starting=starting, records=records):
                result = performance(start=starting, end=ending, flows=records)
                self.assertIsNotNone(result["net_pnl"])
                self.assertIsNone(result["period_return"])
                self.assertIsNone(result["simple_annualized_return"])
                self.assertIsNone(result["compound_annualized_return"])

    def test_negative_ending_equity_reports_loss_without_annualizing(self):
        result = performance(start="100", end="-20")
        self.assertEqual(result["net_pnl"], D("-120"))
        self.assertEqual(result["period_return"], D("-1.2"))
        self.assertIsNone(result["simple_annualized_return"])
        self.assertIsNone(result["compound_annualized_return"])
        self.assertIn("NEGATIVE_END_EQUITY_NO_ANNUALIZATION", result["warnings"])

    def test_short_period_retains_period_result_without_forecast(self):
        result = modified_dietz("1000", "1100", [], START, START + DAY, flows_complete=True)
        self.assertEqual(result["period_return"], D("0.1"))
        self.assertIsNone(result["simple_annualized_return"])
        self.assertIsNone(result["compound_annualized_return"])
        self.assertIn("SHORT_PERIOD_NO_ANNUALIZATION", result["warnings"])
        self.assertFalse(result["annualization_is_forecast"])

    def test_annualization_is_retrospective_ratio(self):
        result = performance()
        self.assertEqual(result["period_return"], D("0.1"))
        self.assertEqual(result["simple_annualized_return"], D("0.1"))
        self.assertEqual(result["compound_annualized_return"], D("0.1"))
        self.assertTrue(result["annualization_allowed"])
        self.assertTrue(result["annualization_is_estimate"])

    def test_invalid_and_zero_duration_intervals_are_not_annualized(self):
        for start, end in ((START, START), (START + 1, START), (None, END), (True, END)):
            with self.subTest(start=start, end=end):
                result = modified_dietz("100", "110", [], start, end, flows_complete=True)
                self.assertIsNone(result["period_return"])
                self.assertIsNone(result["simple_annualized_return"])
                self.assertIn("INVALID_TIME_INTERVAL", result["warnings"])

    def test_internal_trade_or_transfer_is_not_an_external_flow(self):
        record = {"amount": "100", "timestamp_ms": START, "external": False}
        result = performance(flows=[record])
        self.assertEqual(result["net_external_flow"], D(0))
        self.assertEqual(result["net_pnl"], D("100"))
        self.assertEqual(result["ignored_internal_flow_count"], 1)

    def test_decimal_precision_and_json_are_preserved(self):
        result = performance(start="1000.123456789123456789", end="1000.123456789123456790")
        self.assertEqual(result["net_pnl"], D("0.000000000000000001"))
        encoded = json.loads(json.dumps(result, default=audit_json_default))
        self.assertEqual(encoded["net_pnl"], "1E-18")


class OptionValuationTests(unittest.TestCase):
    def test_signed_positions_and_unit_determine_mark_value(self):
        result = value_option_account("1000", [
            {"quantity": "2", "side": "LONG", "markPrice": "20", "unit": "0.1", "markValue": "-999"},
            {"quantity": "-3", "side": "SHORT", "markPrice": "30", "unit": "0.1", "markValue": "999"},
        ])
        self.assertTrue(result["valid"])
        self.assertEqual(result["option_mark_value"], D("-5.0"))
        self.assertEqual(result["equity"], D("995.0"))

    def test_side_sign_conflicts_are_rejected_not_reinterpreted(self):
        for quantity, side in (("1", "SELL"), ("-1", "BUY"), ("-1", "LONG"), ("1", "SHORT")):
            with self.subTest(quantity=quantity, side=side):
                result = value_option_account("1000", [
                    {"quantity": quantity, "side": side, "markPrice": "10", "unit": "1"},
                ])
                self.assertFalse(result["valid"])
                self.assertIsNone(result["equity"])
                self.assertIn("POSITION_SIDE_SIGN_MISMATCH", result["warnings"])

    def test_missing_marks_units_or_incomplete_list_do_not_make_equity(self):
        positions = [{"quantity": "-1", "side": "SELL", "markPrice": "10", "unit": "1"}]
        for field in ("quantity", "markPrice", "unit"):
            bad = dict(positions[0])
            del bad[field]
            with self.subTest(field=field):
                self.assertIsNone(value_option_account("1000", [bad])["equity"])
        self.assertIsNone(value_option_account("1000", positions, marks_complete=False)["equity"])
        self.assertIsNone(value_option_account("1000", None)["equity"])
        self.assertIsNone(value_option_account(None, [])["equity"])

    def test_bad_numeric_marks_and_unknown_sides_fail(self):
        for field, value in (("markPrice", "-1"), ("markPrice", "NaN"), ("unit", "0"),
                             ("quantity", True), ("side", "BOTH")):
            bad = {"quantity": "1", "side": "BUY", "markPrice": "10", "unit": "1"}
            bad[field] = value
            with self.subTest(field=field, value=value):
                self.assertIsNone(value_option_account("1000", [bad])["equity"])

    def test_empty_complete_account_and_negative_equity(self):
        self.assertEqual(value_option_account("12.34", [])["equity"], D("12.34"))
        result = value_option_account("10", [{"quantity": "-2", "markPrice": "20", "unit": "1"}])
        self.assertEqual(result["equity"], D("-30"))
        self.assertTrue(result["valid"])
        self.assertIn("NEGATIVE_ACCOUNT_EQUITY", result["warnings"])


if __name__ == "__main__":
    unittest.main()
