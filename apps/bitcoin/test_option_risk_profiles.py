"""Offline acceptance of custom cash-secured short-put risk presets."""
import copy
import json
import math
import time
import unittest

from option_risk_profiles import risk_profile_config, risk_profile_definitions, screen_risk_profile
from test_option_ai_engine import NOW, contract, snapshot, certified


def screen(rows=None, profile="low", **kwargs):
    return screen_risk_profile(snapshot(rows), profile, now_ms=NOW, **kwargs)


class ProfileConfigTests(unittest.TestCase):
    def test_three_fixed_presets_share_cash_coverage_size_time_and_liquidity_rules(self):
        expected = [("low", 0, .15), ("medium", .15, .30), ("high", .30, .60)]
        for profile, lower, upper in expected:
            config = risk_profile_config(profile)
            self.assertEqual((config["direction"], config["type"], config["quantity"]), ("SELL", "PUT", .01))
            self.assertEqual((config["min_abs_delta"], config["max_abs_delta"]), (lower, upper))
            self.assertEqual((config["min_days"], config["max_days"], config["max_spread_pct"]), (2, 60, 20))
            self.assertEqual((config["sort"], config["limit"]), ("cash_daily_return_desc", 5))

    def test_public_inputs_are_strict_and_cannot_change_the_direction_or_band(self):
        for value in ("LOW", "", "unknown", None, False, {}, []):
            with self.subTest(profile=value), self.assertRaises(ValueError):
                risk_profile_config(value)
        for expiry in (None, "2030-02-30", "tomorrow"):
            with self.subTest(expiry=expiry), self.assertRaises(ValueError):
                risk_profile_config("low", expiry=expiry)
        for quantity in (0, -1, True, "0.01", math.inf, math.nan):
            with self.subTest(quantity=quantity), self.assertRaises(ValueError):
                risk_profile_config("low", quantity=quantity)

    def test_metadata_is_explicit_and_mutating_returned_data_cannot_change_presets(self):
        records = risk_profile_definitions()
        self.assertEqual([record["id"] for record in records], ["low", "medium", "high"])
        self.assertTrue(all("非行业统一等级" in record["basis"] for record in records))
        self.assertTrue(all("不代表保本" in record["basis"] for record in records))
        self.assertTrue(all("2–60" in record["definition"] and "20%" in record["definition"] for record in records))
        records[0]["delta_max_inclusive"] = 1
        self.assertEqual(risk_profile_definitions()[0]["delta_max_inclusive"], .15)


class ProfileScreeningTests(unittest.TestCase):
    def test_delta_bands_are_strictly_disjoint_at_every_boundary(self):
        values = [0, .000001, .15, .15000000000001, .30, .30000000000001, .60, .60000000000001, 1]
        rows = [contract(strike=60000 + 1000 * index, delta=str(-value)) for index, value in enumerate(values)]
        found = {profile: {candidate["abs_delta"] for candidate in screen(rows, profile)["candidates"]}
                 for profile in ("low", "medium", "high")}
        self.assertEqual(found["low"], {.000001, .15})
        self.assertEqual(found["medium"], {.15000000000001, .30})
        self.assertEqual(found["high"], {.30000000000001, .60})
        self.assertFalse(found["low"] & found["medium"] | found["medium"] & found["high"])

    def test_only_puts_are_screened_and_all_results_are_sold_at_bid(self):
        result = screen([contract(), contract(side="CALL", strike=85000)])
        self.assertEqual(result["matched_count"], 1)
        item = result["candidates"][0]
        self.assertEqual((item["direction"], item["type"], item["quote_reference"], item["quote_price"]), ("SELL", "PUT", "bid", 100))

    def test_empty_result_never_changes_delta_time_spread_or_requested_expiry(self):
        result = screen([contract(delta="-.9"), contract(strike=71000, days=1), contract(strike=72000, days=61)], expiry="2030-01-11")
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["criteria"], risk_profile_config("low", "2030-01-11"))
        self.assertEqual(result["matched_count"], 0)

    def test_no_delta_matches_are_not_reported_as_a_missing_market_catalog(self):
        result = screen([contract(delta="-.9")])
        self.assertTrue(result["market_usable"])
        self.assertNotIn("当前没有期权合约数据。", result["warnings"])
        self.assertTrue(any("条件未放宽" in text for text in result["warnings"]))
        offline = screen_risk_profile(snapshot([contract(delta="-.9")], index_updated_at=NOW - 60000), "low", now_ms=NOW)
        self.assertFalse(offline["market_usable"])

    def test_delta_must_be_present_finite_and_fresh_even_when_book_is_verified(self):
        rows = [contract(strike=60000, delta=None), contract(strike=61000, delta="NaN"),
                certified(contract(strike=62000, mark_updated_at=NOW - 60000)),
                contract(strike=63000, field_updated_at={"delta": NOW - 60000})]
        result = screen(rows)
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["matched_count"], 0)

    def test_put_delta_must_be_negative_while_negative_band_boundaries_remain_valid(self):
        rows = [contract(strike=60000, delta=".1"), contract(strike=61000, delta=".2"),
                contract(strike=62000, delta=".5"), contract(strike=63000, delta="0"),
                contract(strike=64000, delta=None), contract(strike=65000, delta="-.15"),
                contract(strike=66000, delta="-.30"), contract(strike=67000, delta="-.60")]
        for profile, expected in (("low", -.15), ("medium", -.30), ("high", -.60)):
            with self.subTest(profile=profile):
                result = screen(rows, profile)
                self.assertEqual([candidate["delta"] for candidate in result["candidates"]], [expected])
                self.assertEqual(result["exclusions"]["put_delta_sign_invalid"], 4)
                self.assertTrue(all(candidate["delta"] < 0 for candidate in result["candidates"]))

    def test_optional_missing_iv_and_greeks_do_not_invent_values_or_exclude_current_delta(self):
        result = screen([contract(mark_iv=None, gamma=None, vega=None, theta=None)])
        self.assertEqual(result["matched_count"], 1)
        item = result["candidates"][0]
        self.assertTrue(all(item[key] is None for key in ("iv", "gamma", "vega", "theta")))

    def test_both_quote_sides_must_be_valid_and_fresh_for_spread_gate(self):
        rows = [contract(strike=60000, ask_price=None), contract(strike=61000, ask_price="0"),
                contract(strike=62000, ask_price="200"),
                contract(strike=63000, field_updated_at={"ask_price": NOW - 60000}),
                contract(strike=64000, bid_price="120", ask_price="110")]
        self.assertEqual(screen(rows)["candidates"], [])

    def test_shared_quote_depth_quantity_and_contract_gates_remain_authoritative(self):
        rows = [contract(strike=60000, bid_quantity=".001"), contract(strike=61000, status="EXPIRED"),
                contract(strike=62000, quantity_scale=1), contract(strike=63000, unit=".1"),
                contract(strike=64000, quote_group_valid=False)]
        self.assertEqual(screen(rows)["candidates"], [])

    def test_fixed_time_window_uses_calibrated_exchange_time_and_official_expiry(self):
        row = contract(days=2, expiry_beijing="2029-12-01T00:00:00+08:00")
        exact = screen([row], expiry="2030-01-03")
        self.assertEqual(exact["matched_count"], 1)
        data = snapshot([row], exchange_clock_offset_ms=1)
        after = screen_risk_profile(data, "low", now_ms=NOW)
        self.assertEqual(after["candidates"], [])

    def test_unreasonable_bid_at_or_above_strike_is_rejected_before_ranking(self):
        invalid = [contract(strike=100 + index, bid_price=str(100 + index), ask_price=str(101 + index)) for index in range(30)]
        valid = [contract(strike=70000 + index * 100, bid_price="100", ask_price="110") for index in range(6)]
        result = screen(invalid + valid)
        self.assertEqual(result["matched_count"], 6)
        self.assertEqual(len(result["candidates"]), 5)
        self.assertTrue(all(item["strike"] >= 70000 for item in result["candidates"]))
        self.assertEqual(result["exclusions"]["premium_at_or_above_strike"], 30)

    def test_many_lower_boundary_rows_cannot_hide_later_medium_matches_at_top_n_cutoff(self):
        boundary = [contract(strike=1000 + index, delta="-.15") for index in range(40)]
        eligible = [contract(strike=70000 + index * 100, delta="-.2") for index in range(9)]
        result = screen(boundary + eligible, "medium")
        self.assertEqual(result["matched_count"], 9)
        self.assertEqual(len(result["candidates"]), 5)
        self.assertTrue(all(item["abs_delta"] == .2 for item in result["candidates"]))

    def test_duplicates_remain_rejected_even_when_one_duplicate_is_outside_the_profile(self):
        row = contract()
        duplicate = dict(row, delta="-.5")
        result = screen([row, duplicate])
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["exclusions"]["duplicate_symbol"], 2)

    def test_malformed_catalog_rows_do_not_escape_the_shared_contract_gate(self):
        rows = [None, [], "invalid", contract(symbol={"not": "an identifier"}),
                contract(symbol=["wrong"]), contract(symbol=123), contract(symbol=None)]
        result = screen(rows)
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["excluded_count"], len(rows))

    def test_underflowed_loss_is_removed_before_it_can_crowd_out_valid_rows(self):
        tiny = [contract(strike=70000 + index, strike_price="1e-307", bid_price=repr(math.nextafter(1e-307, 0)),
                         ask_price="1e-307") for index in range(30)]
        valid = [contract(strike=80000 + index) for index in range(6)]
        result = screen(tiny + valid)
        self.assertEqual(result["matched_count"], 6)
        self.assertEqual(len(result["candidates"]), 5)
        self.assertEqual(result["exclusions"]["risk_numeric_range"], 30)

    def test_quantity_and_expiry_choices_are_preserved_in_metadata_and_risk_values(self):
        result = screen([contract()], expiry="2030-01-11", quantity=.03)
        item = result["candidates"][0]
        self.assertEqual(result["risk_profile"]["expiry"], "2030-01-11")
        self.assertEqual(result["risk_profile"]["quantity"], .03)
        self.assertEqual(item["premium_total"], 3)
        self.assertEqual(item["cash_required"], 2100)

    def test_risk_money_breakeven_and_stress_formulas_are_independently_checkable(self):
        result = screen([contract(strike=70000, bid_price="1000", ask_price="1050")], quantity=.1)
        item = result["candidates"][0]
        self.assertEqual(item["cash_required"], 7000)
        self.assertEqual(item["max_profit_gross"], 100)
        self.assertEqual(item["max_loss_gross"], 6900)
        self.assertEqual(item["break_even"], 69000)
        self.assertAlmostEqual(item["break_even_drop_pct"], 13.75)
        self.assertEqual(item["daily_premium"], 10)
        scenarios = item["stress_scenarios"]
        self.assertEqual([point["move_pct"] for point in scenarios], [-10, -20, -30])
        self.assertEqual([point["settlement"] for point in scenarios], [72000, 64000, 56000])
        self.assertEqual([point["pnl_gross"] for point in scenarios], [100, -500, -1300])
        self.assertIn("最大毛亏损 6900", item["risk_summary"])
        self.assertIn("Delta 不代表真实胜率", item["risk_summary"])
        self.assertIn("未扣费用", item["risk_summary"])

    def test_highest_cash_daily_return_is_ordered_first_without_claiming_expected_profit(self):
        rows = [contract(strike=60000, bid_price="100", ask_price="110"),
                contract(strike=70000, bid_price="300", ask_price="310"),
                contract(strike=65000, bid_price="200", ask_price="210")]
        result = screen(rows)
        rates = [item["cash_daily_return_pct"] for item in result["candidates"]]
        self.assertEqual(rates, sorted(rates, reverse=True))
        self.assertTrue(all("期望" not in item["risk_summary"] for item in result["candidates"]))

    def test_same_snapshot_is_never_mutated_and_final_reference_covers_risk_facts(self):
        data = snapshot([contract()])
        before = copy.deepcopy(data)
        first = screen_risk_profile(data, "low", now_ms=NOW)
        second = screen_risk_profile(data, "low", now_ms=NOW)
        self.assertEqual(data, before)
        self.assertEqual(first, second)
        self.assertNotEqual(first["snapshot"]["reference_id"], first["snapshot"]["base_reference_id"])
        first["candidates"][0]["stress_scenarios"][0]["pnl_gross"] = 999
        self.assertEqual(data, before)
        self.assertNotEqual(first, second)
        json.dumps(second, allow_nan=False)

    def test_large_catalog_is_linear_and_output_is_bounded(self):
        rows = [contract(strike=40000 + index, delta="-.1") for index in range(1500)]
        start = time.perf_counter()
        result = screen(rows)
        elapsed = time.perf_counter() - start
        self.assertEqual(result["matched_count"], 1500)
        self.assertEqual(len(result["candidates"]), 5)
        self.assertLess(elapsed, 2)


if __name__ == "__main__":
    unittest.main()
