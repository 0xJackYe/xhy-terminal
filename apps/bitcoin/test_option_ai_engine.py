"""Offline deterministic screening tests; no providers, accounts or credentials."""
import copy
import datetime as dt
import json
import math
import unittest

from option_ai_engine import DAY_MS, CRITERIA_JSON_SCHEMA, screen_snapshot, validate_criteria


NOW = int(dt.datetime(2030, 1, 1, tzinfo=dt.timezone.utc).timestamp() * 1000)


def contract(side="PUT", strike=70000, days=10, **updates):
    expiry = NOW + days * DAY_MS
    expiry_code = dt.datetime.fromtimestamp(expiry / 1000, dt.timezone.utc).strftime("%y%m%d")
    row = {"symbol": "BTC-%s-%s-%s" % (expiry_code, strike, "P" if side == "PUT" else "C"),
           "side": side, "status": "TRADING", "strike_price": str(strike), "unit": "1", "quote_asset": "USDT",
           "min_qty": ".01", "max_qty": "200", "quantity_scale": 2, "expiry_ms": expiry,
           "bid_price": "100", "ask_price": "110", "bid_quantity": "2", "ask_quantity": "3",
           "quote_updated_at": NOW, "quote_source": "websocket", "quote_group_valid": True,
           "mark_updated_at": NOW, "mark_source": "websocket",
           "mark_iv": ".5", "delta": "-.1" if side == "PUT" else ".1", "gamma": ".00001",
           "vega": "12", "theta": "-20"}
    row.update(updates)
    return row


def snapshot(rows=None, **updates):
    result = {"instance_id": "test-service", "revision": 17, "fetched_at": "2030-01-01T00:00:00Z",
              "options": [contract()] if rows is None else rows, "btc_index_price": "80000",
              "index_updated_at": NOW, "index_source": "websocket", "exchange_clock_offset_ms": 0}
    result.update(updates)
    return result


def certified(row=None, **proof_updates):
    value = copy.deepcopy(row or contract())
    value["quote_updated_at"] = NOW - 3600000
    value["quote_verified_at"] = NOW
    value["quote_verification"] = {
        "verified": True, "kind": "bookTicker", "connection": "book-2", "generation": 3,
        "verified_at": NOW, "baseline_at": NOW - 3600000,
        "values": {key: value[key] for key in ("bid_price", "ask_price", "bid_quantity", "ask_quantity")},
    }
    value["quote_verification"].update(proof_updates)
    return value


def screen(rows=None, criteria=None, now=NOW, **updates):
    return screen_snapshot(snapshot(rows, **updates), criteria or {}, now_ms=now)


class CriteriaTests(unittest.TestCase):
    def test_defaults_are_explicit_and_input_is_not_mutated(self):
        source = {"min_days": 2}
        result = validate_criteria(source)
        self.assertEqual(source, {"min_days": 2})
        self.assertEqual((result["direction"], result["type"], result["expiry"], result["quantity"], result["limit"]),
                         ("SELL", "PUT", "ALL", .01, 10))
        self.assertFalse(CRITERIA_JSON_SCHEMA["additionalProperties"])
        self.assertTrue(set(result) <= set(CRITERIA_JSON_SCHEMA["properties"]))

    def test_unknown_fields_cannot_inject_a_symbol_or_change_the_source(self):
        for source in ({"symbol": "BTC-FAKE"}, {"url": "https://elsewhere"}, {"max_loss": 10}, {"nested": {}}, {1: 2}):
            with self.subTest(source=source), self.assertRaises(ValueError):
                validate_criteria(source)

    def test_numbers_are_finite_json_numbers_and_never_booleans_or_strings(self):
        for field in ("quantity", "min_days", "max_spread_pct", "min_iv", "max_gamma"):
            for value in (None, True, False, "10", "", " ", math.nan, math.inf, -math.inf, [], {}):
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    validate_criteria({field: value})

    def test_identity_dates_limits_and_negative_bounds_are_validated(self):
        for change in ({"direction": "SHORT"}, {"type": "put"}, {"expiry": "2030-02-30"}, {"expiry": "01-02-2030"},
                       {"expiry": None}, {"limit": 0}, {"limit": 21}, {"limit": True}, {"limit": 1.5},
                       {"quantity": 0}, {"min_days": -1}, {"max_iv": -.1}, {"max_abs_delta": 1.01},
                       {"min_days": 20, "max_days": 10}, {"min_theta": 0, "max_theta": -1}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_criteria(change)

    def test_signed_greeks_and_itm_otm_bounds_are_preserved(self):
        value = validate_criteria({"min_otm_pct": -30, "min_theta": -100, "max_theta": -5,
                                   "min_gamma": -1, "max_gamma": .01, "min_iv": .5})
        self.assertEqual(value["min_theta"], -100)
        self.assertEqual(value["min_iv"], .5)

    def test_cash_return_filter_and_sort_reject_unsupported_sides(self):
        for direction, option_type in (("BUY", "PUT"), ("BUY", "CALL"), ("SELL", "CALL")):
            for extra in ({"sort": "cash_daily_return_desc"}, {"min_cash_daily_return_pct": .01}):
                with self.subTest(direction=direction, type=option_type, extra=extra), self.assertRaises(ValueError):
                    validate_criteria({"direction": direction, "type": option_type, **extra})


class ScreeningTests(unittest.TestCase):
    def test_user_example_ten_usdt_in_ten_days_is_one_per_day(self):
        result = screen([contract(strike=100, bid_price="10", ask_price="11")], {"quantity": 1})
        item = result["candidates"][0]
        self.assertEqual(item["premium_total"], 10)
        self.assertEqual(item["daily_premium"], 1)
        self.assertEqual(item["cash_daily_return_pct"], 1)
        self.assertEqual(item["premium_cashflow"], "credit")

    def test_four_directions_use_their_actual_executable_quote(self):
        for side in ("PUT", "CALL"):
            for direction, expected in (("SELL", 100), ("BUY", 110)):
                with self.subTest(side=side, direction=direction):
                    result = screen([contract(side=side)], {"type": side, "direction": direction})
                    item = result["candidates"][0]
                    self.assertEqual(item["quote_price"], expected)
                    self.assertEqual(item["premium_total"], expected * .01)
                    self.assertEqual(item["quote_reference"], "bid" if direction == "SELL" else "ask")
                    self.assertEqual(item["quote_quantity"], 2 if direction == "SELL" else 3)
                    if side == "CALL" or direction == "BUY":
                        self.assertIsNone(item["cash_daily_return_pct"])
                    if direction == "BUY":
                        self.assertEqual(item["premium_cashflow"], "debit")
                        self.assertTrue(any("支出" in text for text in result["warnings"]))

    def test_fractional_days_and_calibrated_clock_do_not_age_local_receipts(self):
        row = contract(days=.25)
        result = screen([row], exchange_clock_offset_ms=3600000)
        item = result["candidates"][0]
        self.assertAlmostEqual(item["remaining_days"], 5 / 24)
        self.assertAlmostEqual(item["daily_premium"], 4.8)
        self.assertEqual(result["snapshot"]["exchange_now_ms"], NOW + 3600000)
        self.assertEqual(item["quote_received_at_ms"], NOW)

    def test_exact_exchange_expiry_boundary_excludes_the_contract(self):
        row = contract(expiry_ms=NOW + 1000)
        self.assertEqual(screen([row], exchange_clock_offset_ms=999)["matched_count"], 1)
        result = screen([row], exchange_clock_offset_ms=1000)
        self.assertFalse(result["candidates"])
        self.assertEqual(result["exclusions"], {"expired": 1})

    def test_beijing_expiry_filter_uses_official_instant_not_cached_display(self):
        value = int(dt.datetime(2030, 1, 10, 16, 30, tzinfo=dt.timezone.utc).timestamp() * 1000)
        row = contract(expiry_ms=value, expiry_beijing="2030-01-10T16:00:00+08:00")
        result = screen([row], {"expiry": "2030-01-11"})
        self.assertEqual(result["matched_count"], 1)
        self.assertEqual(result["candidates"][0]["expiry_ms"], value)
        fallback = screen([contract(expiry_ms=None, expiry_beijing="2030-01-11T00:30:00+08:00")], {"expiry": "2030-01-11"})
        self.assertEqual(fallback["matched_count"], 1)

    def test_all_requested_bounds_are_enforced_without_inventing_defaults(self):
        criteria = {"min_days": 10, "max_days": 10, "min_strike": 64000, "max_strike": 64000,
                    "min_otm_pct": 20, "max_otm_pct": 20, "min_abs_delta": .1, "max_abs_delta": .1,
                    "min_iv": .5, "max_iv": .5, "min_gamma": .00001, "max_gamma": .00001,
                    "min_vega": 12, "max_vega": 12, "min_theta": -20, "max_theta": -20,
                    "min_premium": 100, "max_premium": 100, "min_daily_premium": .1,
                    "max_spread_pct": 10, "min_cash_daily_return_pct": .015}
        result = screen([contract(strike=64000)], criteria)
        self.assertEqual(result["matched_count"], 1)
        self.assertEqual(len(result["candidates"][0]["matched_filters"]), 12)
        for changed in ({"min_days": 10.1, "max_days": 11}, {"max_strike": 63000, "min_strike": 63000}, {"min_otm_pct": 21, "max_otm_pct": 22},
                        {"min_abs_delta": .2, "max_abs_delta": .3}, {"min_iv": .6, "max_iv": .7},
                        {"min_gamma": .00002, "max_gamma": .00003}, {"min_vega": 13, "max_vega": 14},
                        {"min_theta": -10, "max_theta": -5}, {"min_premium": 101, "max_premium": 102},
                        {"min_daily_premium": .2}, {"max_spread_pct": 1}, {"min_cash_daily_return_pct": .1}):
            with self.subTest(changed=changed):
                self.assertEqual(screen([contract(strike=64000)], {**criteria, **changed})["matched_count"], 0)

    def test_missing_greeks_only_exclude_if_the_requested_bound_needs_them(self):
        row = contract(delta=None, mark_iv="-1", gamma=None, vega=None, theta=None)
        self.assertEqual(screen([row])["matched_count"], 1)
        for criteria in ({"max_abs_delta": .2}, {"min_iv": .01}, {"max_gamma": 1}, {"min_vega": 0}, {"max_theta": 0}):
            with self.subTest(criteria=criteria):
                result = screen([row], criteria)
                self.assertEqual(result["matched_count"], 0)
                self.assertTrue(any(key.endswith("_missing") for key in result["exclusions"]))

    def test_zero_ask_does_not_remove_a_valid_sell_bid_but_spread_filter_requires_two_sides(self):
        row = contract(ask_price="0")
        self.assertEqual(screen([row])["matched_count"], 1)
        self.assertEqual(screen([row], {"max_spread_pct": 100})["exclusions"], {"spread_pct_missing": 1})

    def test_greek_filters_never_inherit_quote_or_book_certificate_freshness(self):
        for updates in ({"mark_updated_at": NOW-20001}, {"mark_updated_at": None},
                        {"field_updated_at": {"delta": None}}, {"field_updated_at": {"delta": NOW+2001}}):
            row = certified(); row.update(updates)
            with self.subTest(updates=updates):
                self.assertEqual(screen([row], {"max_abs_delta": .2})["exclusions"], {"abs_delta_missing": 1})
                item = screen([row])["candidates"][0]
                self.assertIsNone(item["delta"])
                self.assertIsNotNone(item["metric_provenance"]["delta"]["issue"])
        row = contract(mark_updated_at=NOW-30000, mark_source="rest")
        self.assertEqual(screen([row], {"max_abs_delta": .2})["matched_count"], 1)

    def test_spread_requires_independently_current_ask_and_bid(self):
        row = contract(field_updated_at={"ask_price": NOW-20001})
        item = screen([row])["candidates"][0]
        self.assertIsNone(item["spread_pct"])
        self.assertEqual(screen([row], {"max_spread_pct": 100})["exclusions"], {"spread_pct_missing": 1})
        row = certified(); row["field_updated_at"] = {"ask_price": NOW+2001}
        self.assertEqual(screen([row], {"max_spread_pct": 100})["exclusions"], {"spread_pct_missing": 1})

    def test_quantity_minimum_maximum_precision_and_depth_are_applied(self):
        for updates, quantity, expected in (({}, .001, "quantity_out_of_range"), ({}, 200.01, "quantity_out_of_range"),
                                             ({}, .011, "quantity_precision"), ({"bid_quantity": ".009"}, .01, "depth_insufficient"),
                                             ({"bid_quantity": None}, .01, "depth_missing"),
                                             ({"quantity_scale": None}, .01, "quantity_rules_missing"),
                                             ({"min_qty": None}, .01, "quantity_rules_missing"),
                                             ({"max_qty": "bad"}, .01, "quantity_rules_missing")):
            with self.subTest(updates=updates, quantity=quantity):
                result = screen([contract(**updates)], {"quantity": quantity})
                self.assertEqual(result["exclusions"], {expected: 1})

    def test_buy_checks_ask_depth_and_quantity_scaling_does_not_change_cash_rate(self):
        row = contract(ask_quantity="0.005")
        self.assertEqual(screen([row])["matched_count"], 1)
        self.assertEqual(screen([row], {"direction": "BUY"})["exclusions"], {"depth_insufficient": 1})
        one, two = screen()["candidates"][0], screen(criteria={"quantity": .02})["candidates"][0]
        self.assertEqual(two["premium_total"], one["premium_total"] * 2)
        self.assertEqual(two["daily_premium"], one["daily_premium"] * 2)
        self.assertEqual(two["cash_daily_return_pct"], one["cash_daily_return_pct"])

    def test_quotes_zero_crossed_incoherent_and_nontrading_are_not_current_candidates(self):
        for updates, expected in (({"bid_price": 0}, "no_bid"), ({"bid_price": None}, "no_bid"),
                                  ({"ask_price": -1}, "invalid_book"),
                                  ({"bid_price": "111"}, "crossed_book"), ({"quote_group_valid": False}, "book_group_unverified"),
                                  ({"status": "HALT"}, "contract_not_trading"), ({"unit": "0.1"}, "unsupported_contract"),
                                  ({"quote_asset": "BTC"}, "unsupported_contract"), ({"strike_price": 0}, "strike_invalid")):
            with self.subTest(updates=updates):
                self.assertEqual(screen([contract(**updates)])["exclusions"], {expected: 1})

    def test_all_timestamps_use_local_receipt_age_and_exact_source_boundaries(self):
        for source, age, expected in (("websocket", 20000, 1), ("websocket", 20001, 0),
                                      ("rest", 30000, 1), ("rest", 30001, 0),
                                      ("websocket", -2000, 1), ("websocket", -2001, 0)):
            with self.subTest(source=source, age=age):
                result = screen([contract(quote_source=source, quote_updated_at=NOW-age)])
                self.assertEqual(result["matched_count"], expected)

    def test_explicit_missing_field_timestamp_never_inherits_a_fresh_group_stamp(self):
        row = contract(field_updated_at={"bid_price": None})
        self.assertEqual(screen([row])["exclusions"], {"quote_unknown": 1})
        row = contract(field_updated_at={"bid_quantity": NOW-20001})
        self.assertEqual(screen([row])["exclusions"], {"depth_stale": 1})

    def test_complete_live_book_certificate_accepts_a_quiet_old_book(self):
        result = screen([certified()])
        self.assertEqual(result["matched_count"], 1)
        self.assertTrue(result["candidates"][0]["book_verified"])
        self.assertEqual(result["candidates"][0]["quote_received_at_ms"], NOW-3600000)
        self.assertFalse(result["warnings"])

    def test_invalid_partial_forged_or_expired_certificates_never_refresh_an_old_book(self):
        mutations = [lambda r: r.update(quote_verified_at=None),
                     lambda r: r["quote_verification"].update(verified=False),
                     lambda r: r["quote_verification"].update(kind="ticker"),
                     lambda r: r["quote_verification"].update(connection="market"),
                     lambda r: r["quote_verification"].update(generation=True),
                     lambda r: r["quote_verification"].update(generation="3"),
                     lambda r: r["quote_verification"].update(baseline_at=NOW+2001),
                     lambda r: r["quote_verification"].update(verified_at=str(NOW)),
                     lambda r: r["quote_verification"]["values"].pop("ask_quantity"),
                     lambda r: r["quote_verification"]["values"].update(bid_price="99"),
                     lambda r: r.update(quote_verified_at=NOW-20001),
                     lambda r: r["quote_verification"].update(verified_at=NOW-20001)]
        for mutate in mutations:
            row=certified(); mutate(row)
            with self.subTest(mutation=str(mutate)):
                result=screen([row])
                self.assertEqual(result["matched_count"], 0)
                self.assertEqual(result["exclusions"], {"quote_stale": 1})

    def test_proof_cannot_excuse_unknown_or_future_receipt_or_revoked_group(self):
        for update, reason in (({"field_updated_at": {"bid_price": None}}, "quote_unknown"),
                               ({"field_updated_at": {"bid_quantity": NOW+2001}}, "depth_future"),
                               ({"quote_group_valid": False}, "book_group_unverified")):
            row=certified(); row.update(update)
            self.assertEqual(screen([row])["exclusions"], {reason:1})

    def test_index_freshness_is_independent_of_book_certificate_and_other_market_groups(self):
        self.assertEqual(screen([certified()], stale=True, error={"message":"unrelated ticker outage"})["matched_count"],1)
        for updates in ({"btc_index_price":None},{"index_updated_at":None},{"index_updated_at":NOW-20001},
                        {"index_updated_at":NOW+2001}):
            with self.subTest(updates=updates):
                result=screen([certified()],**updates)
                self.assertFalse(result["market_usable"])
                self.assertFalse(result["candidates"])
                self.assertTrue(any(key.startswith("index_") for key in result["exclusions"]))

    def test_present_but_revoked_proof_with_fresh_receipts_is_a_labeled_snapshot(self):
        row=contract(quote_verified_at=None,quote_verification=None)
        result=screen([row])
        self.assertEqual(result["matched_count"],1)
        self.assertFalse(result["candidates"][0]["book_verified"])
        self.assertTrue(any("快照" in text for text in result["warnings"]))

    def test_snapshot_and_criteria_stay_immutable_and_same_reference_is_repeatable(self):
        source=snapshot([certified()]); criteria={"max_abs_delta":.2}
        original=copy.deepcopy((source,criteria))
        first=screen_snapshot(source,criteria,NOW); second=screen_snapshot(source,criteria,NOW)
        self.assertEqual((source,criteria),original)
        self.assertEqual(first,second)
        self.assertEqual(first["snapshot"]["instance_id"],source["instance_id"])
        self.assertEqual(first["snapshot"]["revision"],17)
        changed=snapshot([contract(bid_price="101")])
        self.assertNotEqual(screen_snapshot(changed,criteria,NOW)["snapshot"]["reference_id"],first["snapshot"]["reference_id"])

    def test_each_sort_is_stable_missing_last_and_limit_is_enforced(self):
        rows=[contract(strike=70000,bid_price="100",ask_price="110",delta=None),
              contract(strike=71000,bid_price="200",ask_price="205",delta="-.2"),
              contract(strike=72000,bid_price="300",ask_price="305",delta="-.1")]
        self.assertEqual([r["strike"] for r in screen(rows)["candidates"]],[72000,71000,70000])
        self.assertEqual([r["strike"] for r in screen(rows,{"sort":"delta_asc"})["candidates"]],[72000,71000,70000])
        self.assertEqual([r["strike"] for r in screen(rows,{"sort":"spread_asc"})["candidates"]],[72000,71000,70000])
        limited=screen(rows,{"limit":2})
        self.assertEqual(limited["matched_count"],3)
        self.assertEqual(len(limited["candidates"]),2)
        tied=[contract(strike=70000),contract(strike=71000)]
        self.assertEqual([r["symbol"] for r in screen(tied)["candidates"]],
                         [r["symbol"] for r in screen(list(reversed(tied)))["candidates"]])

    def test_cash_sort_ranks_puts_before_undefined_calls_and_filter_excludes_calls(self):
        rows=[contract(side="CALL",strike=90000),contract(strike=70000)]
        result=screen(rows,{"type":"ALL","sort":"cash_daily_return_desc"})
        self.assertEqual([row["type"] for row in result["candidates"]],["PUT","CALL"])
        result=screen(rows,{"type":"ALL","min_cash_daily_return_pct":.001})
        self.assertEqual([row["type"] for row in result["candidates"]],["PUT"])

    def test_duplicate_or_malformed_symbols_cannot_manufacture_candidates(self):
        one=contract(); duplicate={**one,"bid_price":"101"}
        result=screen([one,duplicate])
        self.assertEqual(result["exclusions"],{"duplicate_symbol":2})
        for invalid in (None,{}, {"symbol":{}}, {"symbol":"<script>alert(1)</script>"}, contract(symbol="BTC-300111-70000-C")):
            with self.subTest(invalid=invalid):
                self.assertFalse(screen([invalid])["candidates"])

    def test_empty_market_and_no_match_have_counts_without_fake_recommendations(self):
        empty=screen([])
        self.assertFalse(empty["candidates"])
        self.assertFalse(empty["market_usable"])
        self.assertEqual(empty["total_contracts"],0)
        no_match=screen(criteria={"min_days":50})
        self.assertEqual(no_match["matched_count"],0)
        self.assertEqual(no_match["excluded_count"],1)
        self.assertTrue(no_match["market_usable"])

    def test_oversized_money_and_tiny_positive_horizon_never_emit_nonfinite_json(self):
        for row in (contract(bid_price="1e308",ask_price="1e308"),
                    contract(expiry_ms=NOW+.001),contract(strike_price="1e-300",bid_price="1e300",ask_price="1e300")):
            with self.subTest(row=row):
                result=screen([row])
                json.dumps(result,allow_nan=False)
                for item in result["candidates"]:
                    self.assertTrue(all(not isinstance(value,float) or math.isfinite(value) for value in item.values()))

    def test_malformed_public_metadata_and_large_revisions_remain_json_safe(self):
        for updates in ({"quantity_scale": 10**1000}, {"quantity_scale": math.inf},
                        {"field_source": {"delta": {"invalid": math.nan}}},
                        {"mark_source": {"invalid": math.nan}}, {"field_updated_at": []}):
            with self.subTest(updates=updates):
                json.dumps(screen([contract(**updates)]), allow_nan=False)
        revision = 10**100
        self.assertEqual(screen(revision=revision)["snapshot"]["revision"], revision)

    def test_invalid_snapshot_or_time_does_not_silently_use_another_clock(self):
        for value in (None,[],{}, {"options":None}, {"options":"rows"}):
            with self.subTest(value=value),self.assertRaises(ValueError):
                screen_snapshot(value,{},NOW)
        for value in (None,0,True,"10",math.nan,math.inf):
            if value is None:
                continue
            with self.subTest(value=value),self.assertRaises(ValueError):
                screen_snapshot(snapshot(),{},value)
        for offset in (None,True,"bad",math.inf):
            with self.subTest(offset=offset),self.assertRaises(ValueError):
                screen(exchange_clock_offset_ms=offset)


if __name__=="__main__":
    unittest.main()
