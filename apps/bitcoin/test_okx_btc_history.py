"""Synthetic BTC cash ledger tests; no live credentials or account data."""
import copy
from decimal import Decimal
import unittest

import okx_btc_history as history


START = 1760000000000
END = START + 5000


def bill(identifier="2", at=START + 1000, delta="0.1", balance="0.3", **extra):
    row = {"billId": identifier, "ts": str(at), "ccy": "BTC", "type": "2",
           "balChg": delta, "bal": balance}
    row.update(extra)
    return row


def event(**kwargs):
    account = kwargs.pop("account", "trading")
    return history.normalize_btc_bill(bill(**kwargs), account)


class LedgerTests(unittest.TestCase):
    def build(self, events, closing=None, **kwargs):
        return history.build_btc_history(events, START, END, END,
            closing or {"trading": "0.3", "funding": "0"}, **kwargs)

    def test_decimal_precision_not_float(self):
        value = "0.123456789012345678901234567890123456789"
        row = event(delta=value, balance=value)
        result = self.build([row], {"trading": value, "funding": "0"})
        self.assertTrue(result["complete"])
        self.assertEqual(result["events"][0]["delta_btc"], value)

    def test_currencies_strict_btc_only(self):
        for value in [None, "USDT", "btc", "BTC\n", True]:
            with self.assertRaises(history.HistoryValidationError):
                history.normalize_btc_bill(bill(ccy=value), "trading")

    def test_bad_decimals_rejected(self):
        for value in [None, "", True, 1, "NaN", "Infinity", "1e-5", "+1", " 0.1", "0.1 ", "1" * 161]:
            with self.subTest(value=repr(value)):
                with self.assertRaises(history.HistoryValidationError):
                    event(delta=value)

    def test_bad_ids_timestamps_shapes_rejected(self):
        for row in [None, {}, bill(identifier="not-an-id"), bill(identifier="9" * 31),
                    bill(at=0), bill(ts=True), bill(ts="NaN"), bill(type="<x>"), bill(subType=[]), bill(bal=None)]:
            with self.assertRaises(history.HistoryValidationError):
                history.normalize_btc_bill(row, "trading")
        with self.assertRaises(history.HistoryValidationError):
            history.normalize_btc_bill(bill(), "margin")

    def test_cash_change_already_contains_fee_and_trade_size(self):
        row = event(delta="0.00999", balance="0.20999", fee="-0.00001", sz="0.01")
        self.assertEqual(row["delta_btc"], "0.00999")
        self.assertNotIn("fee", row)
        self.assertNotIn("sz", row)

    def test_derivative_realized_cash_included_unrealized_ignored(self):
        row = event(delta="-0.02", balance="0.3", instType="SWAP", upl="0.99", pnl="-0.02")
        self.assertEqual(row["delta_btc"], "-0.02")
        self.assertNotIn("upl", row)
        self.assertTrue(self.build([row])["complete"])

    def test_internal_transfer_legs_sum_zero_not_double_deduplicated(self):
        rows = [event(identifier="8", delta="0.1", balance="0.3", type="1", **{"from": "6", "to": "18"}),
                event(identifier="8", delta="-0.1", balance="0.2", type="131", account="funding")]
        result = self.build(rows, {"trading": "0.3", "funding": "0.2"})
        self.assertTrue(result["complete"])
        self.assertEqual(len(result["events"]), 2)
        self.assertEqual(sum(Decimal(row["delta_btc"]) for row in rows), 0)
        self.assertTrue(all(row["kind"] == "internal_transfer" for row in rows))

    def test_same_account_same_id_deduplicated_only_if_identical(self):
        row = event()
        self.assertEqual(len(self.build([row, copy.deepcopy(row)])["events"]), 1)
        modified = dict(row, delta_btc="0.2")
        with self.assertRaises(history.HistoryValidationError):
            self.build([row, modified])

    def test_order_sorted_by_ms_then_id(self):
        rows = [event(identifier="10", delta="0.1", balance="0.3"),
                event(identifier="9", delta="0.1", balance="0.2")]
        result = self.build(rows)
        self.assertTrue(result["complete"])
        self.assertEqual([row["id"] for row in result["events"]], ["9", "10"])

    def test_deposit_withdraw_and_fee_are_one_bill_each(self):
        rows = [event(identifier="2", type="1", delta="0.2", balance="0.4", account="funding"),
                event(identifier="3", type="2", delta="-0.1", balance="0.3", at=START + 2000, account="funding"),
                event(identifier="4", type="221", delta="-0.0001", balance="0.2999", at=START + 3000, account="funding")]
        result = self.build(rows, {"trading": "0", "funding": "0.2999"})
        self.assertTrue(result["complete"])
        self.assertEqual([row["kind"] for row in rows], ["deposit", "withdrawal", "withdrawal_fee"])

    def test_cash_chain_gap_marks_incomplete(self):
        rows = [event(identifier="1", balance="0.1"),
                event(identifier="2", at=START + 2000, delta="0.1", balance="0.3")]
        result = self.build(rows)
        self.assertFalse(result["complete"])
        self.assertEqual(result["reason"], "balance_chain_gap")

    def test_funding_lag_vs_snapshot_detected(self):
        row = event(account="funding", balance="0.3")
        result = self.build([row], {"trading": "0", "funding": "0.4"})
        self.assertFalse(result["complete"])
        self.assertEqual(result["reason"], "anchor_balance_mismatch")

    def test_history_closing_balances_back_out_after_requested_end(self):
        rows = [event(identifier="1", delta="0.1", balance="0.3"),
                event(identifier="2", at=END + 1000, delta="0.2", balance="0.5")]
        result = history.build_btc_history(rows, START, END, END + 2000,
                                          {"trading": "0.5", "funding": "0"})
        self.assertTrue(result["complete"])
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["closing_balances"]["trading"], "0.3")

    def test_empty_fully_exhausted_interval_uses_observed_anchor(self):
        result = self.build([], {"trading": "0.7", "funding": "0.3"})
        self.assertTrue(result["complete"])
        self.assertEqual(result["closing_balances"], {"trading": "0.7", "funding": "0.3"})

    def test_original_incomplete_not_overridden_by_valid_balances(self):
        result = self.build([event()], complete=False, reason="page_limit")
        self.assertFalse(result["complete"])
        self.assertEqual(result["reason"], "page_limit")

    def test_borrow_repay_isolated_cannot_invent_net_debt_history(self):
        for extra in [{"type": "16"}, {"subType": "306"}, {"subType": "309"},
                      {"interest": "0.001"}, {"posBalChg": "0.1"}, {"instType": "MARGIN"},
                      {"mgnMode": "isolated"}, {"type": "217", "account": "funding"}]:
            with self.subTest(extra=extra):
                row = event(**extra)
                closing = {"trading": "0.3", "funding": "0"} if row["account"] == "trading" else {"trading": "0", "funding": "0.3"}
                result = self.build([row], closing)
                self.assertFalse(result["complete"])
                self.assertEqual(result["reason"], "unsupported_debt_history")

    def test_negative_cash_is_not_absed_or_zeroed(self):
        row = event(delta="-0.1", balance="-0.3")
        result = self.build([row], {"trading": "-0.3", "funding": "0"})
        self.assertEqual(result["closing_balances"]["trading"], "-0.3")

    def test_future_and_outside_events_rejected(self):
        for at in [START - 1, END + 1]:
            with self.assertRaises(history.HistoryValidationError):
                self.build([event(at=at)])

    def test_interval_validation(self):
        for values in [(True, END, END), (START, START - 1, END), (START, END + 1, END), (0, END, END)]:
            with self.assertRaises(history.HistoryValidationError):
                history.build_btc_history([], *values, {"trading": "0", "funding": "0"})

    def test_excessive_events_rejected(self):
        with self.assertRaises(history.HistoryValidationError):
            self.build([event()] * (history.MAX_BILLS + 1))


if __name__ == "__main__":
    unittest.main()
