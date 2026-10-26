"""Offline qualitative risk commentary tests; no real key or provider calls."""
import copy
import json
import math
import threading
import unittest

from deepseek_client import DeepSeekError, MAX_TOKENS
from option_ai_explainer import RISK_SYSTEM_PROMPT, explain_risk_screen


SYMBOL = "BTC-301011-70000-P"
SECOND = "BTC-301011-69000-P"
SYNTHETIC_SECRET = "sk-offline-explanation-only-secret"


def screening(count=1):
    row = {"symbol": SYMBOL, "direction": "SELL", "type": "PUT", "expiry": "2030-10-11",
           "expiry_ms": 1917907200000, "strike": 70000, "quantity": .01, "unit": 1,
           "quote_price": 100, "premium_total": 1, "daily_premium": .1, "remaining_days": 10,
           "abs_delta": .1, "delta": -.1, "gamma": .00001, "vega": 12, "theta": -20,
           "iv": .5, "otm_pct": 12.5, "spread_pct": 10, "cash_daily_return_pct": .1 / 700 * 100,
           "cash_required": 700, "max_profit_gross": 1, "max_loss_gross": 699,
           "break_even": 69900, "break_even_drop_pct": 12.625,
           "stress_scenarios": [{"move_pct": -10, "settlement": 72000, "pnl_gross": 1},
                                {"move_pct": -20, "settlement": 64000, "pnl_gross": -59},
                                {"move_pct": -30, "settlement": 56000, "pnl_gross": -139}],
           "risk_summary": "权利金不能抵消极端下跌带来的全部损失。"}
    rows = []
    for index in range(count):
        rows.append(dict(row, symbol=SYMBOL if index == 0 else "BTC-301011-%s-P" % (70000 - index * 1000)))
    return {"criteria": {"direction": "SELL", "type": "PUT", "expiry": "2030-10-11", "quantity": .01},
            "risk_profile": {"id": "low", "label": "低风险", "definition": "绝对Delta大于0且不超过0.15。",
                             "basis": "假设预留完整行权名义金额，非实际保证金。"},
            "snapshot": {"reference_id": "same-snapshot-1", "revision": 17, "instance_id": "market-1",
                         "evaluated_at_ms": 1917043200000, "exchange_now_ms": 1917043200000,
                         "btc_index_price": 80000}, "candidates": rows,
            "warnings": []}


def explanation(symbols=None, **updates):
    value = {"overview": "这是同类策略的相对分档，尾部损失仍可能发生。",
             "candidates": [{"symbol": symbol, "text": "权利金提供有限缓冲，显著下跌时亏损仍可能超过所收权利金。"}
                            for symbol in (symbols or [SYMBOL])]}
    value.update(updates)
    return value


def completion(value=None, **updates):
    result = {"model": "deepseek-flash-1017", "choices": [{"finish_reason": "stop", "message": {
        "content": json.dumps(value or explanation(), ensure_ascii=False)}}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 40, "total_tokens": 140}}
    result.update(updates)
    return result


class Client:
    def __init__(self, response=None, effect=None):
        self.response = completion() if response is None else response
        self.effect = effect
        self.calls = []
        self.now = 100.
        self._clock = lambda: self.now

    def _request(self, path, payload, cancel_event=None, deadline=None):
        self.calls.append({"path": path, "payload": copy.deepcopy(payload), "cancel_event": cancel_event, "deadline": deadline})
        if self.effect:
            self.effect(self)
        if isinstance(self.response, Exception):
            raise self.response
        return copy.deepcopy(self.response)


class ExplainerTests(unittest.TestCase):
    def rejected(self, response, code="invalid_explanation", screen=None):
        client = Client(response)
        with self.assertRaises(DeepSeekError) as captured:
            explain_risk_screen(client, screening() if screen is None else screen, "deepseek-flash")
        self.assertEqual(captured.exception.code, code)
        self.assertNotIn(SYNTHETIC_SECRET, str(captured.exception))
        return captured.exception, client

    def test_exports_the_complete_cash_settled_relative_risk_system_prompt(self):
        for required in ("现金结算", "相对分档", "完整行权名义金额", "不是币安实际保证金", "不能重新选合约",
                         "不能解释为真实胜率", "不写任何数字", "平均每日权利金", "未计费用", "压力情景"):
            self.assertIn(required, RISK_SYSTEM_PROMPT)
        self.assertIn('"overview"', RISK_SYSTEM_PROMPT)
        self.assertIn('"symbol"', RISK_SYSTEM_PROMPT)

    def test_valid_commentary_uses_fixed_client_route_json_mode_and_bounded_tokens(self):
        client = Client()
        before = screening()
        frozen = copy.deepcopy(before)
        result = explain_risk_screen(client, before, "deepseek-flash")
        self.assertEqual(before, frozen)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["candidates"][0]["symbol"], SYMBOL)
        self.assertEqual(result["model"], "deepseek-flash-1017")
        self.assertEqual(result["usage"]["total_tokens"], 140)
        call = client.calls[0]
        self.assertEqual(call["path"], "/chat/completions")
        self.assertEqual(call["deadline"], 145)
        self.assertEqual(call["payload"]["max_tokens"], MAX_TOKENS)
        self.assertEqual(call["payload"]["thinking"], {"type": "disabled"})
        self.assertEqual(call["payload"]["response_format"], {"type": "json_object"})
        self.assertFalse(call["payload"]["stream"])
        self.assertEqual(call["payload"]["messages"][0]["content"], RISK_SYSTEM_PROMPT)

    def test_only_allowlisted_public_same_snapshot_facts_are_forwarded(self):
        data = screening()
        data.update(api_key=SYNTHETIC_SECRET, private_wallet={"balance": 123456})
        data["snapshot"]["account"] = SYNTHETIC_SECRET
        data["candidates"][0]["authorization"] = SYNTHETIC_SECRET
        data["risk_profile"]["private"] = SYNTHETIC_SECRET
        client = Client()
        explain_risk_screen(client, data, "deepseek-v4-pro")
        raw = client.calls[0]["payload"]["messages"][1]["content"]
        self.assertNotIn(SYNTHETIC_SECRET, raw)
        context = json.loads(raw)["context"]
        self.assertEqual(set(context), {"risk_profile", "criteria", "snapshot", "candidates"})
        self.assertEqual(context["snapshot"]["reference_id"], "same-snapshot-1")
        facts = context["candidates"][0]
        self.assertEqual(facts["premium_total"], 1)
        self.assertEqual(facts["max_loss_gross"], 699)
        self.assertEqual(facts["stress_scenarios"][1]["pnl_gross"], -59)

    def test_empty_candidates_skip_model_request(self):
        client = Client()
        result = explain_risk_screen(client, screening(0), "deepseek-flash")
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["candidates"], [])
        self.assertEqual(client.calls, [])

    def test_only_approved_models_are_accepted(self):
        for model in (None, "deepseek-chat", "https://other.test", "deepseek-flash\nprivate"):
            with self.subTest(model=model):
                client = Client()
                with self.assertRaises(DeepSeekError) as captured:
                    explain_risk_screen(client, screening(), model)
                self.assertEqual((captured.exception.code, captured.exception.status), ("invalid_model", 400))
                self.assertEqual(client.calls, [])

    def test_input_is_limited_to_cash_secured_sell_put_profiles(self):
        for change in ({"criteria": {"direction": "BUY", "type": "PUT"}},
                       {"criteria": {"direction": "SELL", "type": "CALL"}},
                       {"risk_profile": {"id": "custom"}}, {"snapshot": None}):
            data = screening(); data.update(change)
            error, client = self.rejected(completion(), "invalid_risk_screen", data)
            self.assertEqual(error.status, 400)
            self.assertEqual(client.calls, [])

    def test_unknown_criteria_cannot_be_sent_as_provider_instructions(self):
        data = screening(); data["criteria"]["system_override"] = SYNTHETIC_SECRET
        self.rejected(completion(), "invalid_risk_screen", data)

    def test_input_duplicate_unknown_or_too_many_candidates_fail_closed(self):
        invalid = []
        data = screening(); data["candidates"].append(copy.deepcopy(data["candidates"][0])); invalid.append(data)
        data = screening(); data["candidates"][0]["symbol"] = "BTC-301011-70000-C"; invalid.append(data)
        invalid.append(screening(6))
        for data in invalid:
            with self.subTest(count=len(data["candidates"])):
                self.rejected(completion(), "invalid_risk_screen", data)

    def test_input_nonfinite_missing_and_unscaled_reference_values_are_rejected(self):
        for field, value in (("cash_required", math.inf), ("daily_premium", None), ("abs_delta", True),
                             ("remaining_days", 0), ("quantity", -.01), ("unit", .1), ("max_loss_gross", -1)):
            data = screening(); data["candidates"][0][field] = value
            with self.subTest(field=field, value=value):
                self.rejected(completion(), "invalid_risk_screen", data)

    def test_missing_optional_greeks_remain_null_without_being_invented(self):
        data = screening()
        for field in ("gamma", "vega", "theta", "iv"):
            data["candidates"][0][field] = None
        client = Client(); explain_risk_screen(client, data, "deepseek-flash")
        row = json.loads(client.calls[0]["payload"]["messages"][1]["content"])["context"]["candidates"][0]
        self.assertTrue(all(row[field] is None for field in ("gamma", "vega", "theta", "iv")))

    def test_missing_greeks_cannot_be_described_as_known_low_or_high_values(self):
        data = screening()
        data["candidates"][0].update(vega=None, gamma=None)
        value = explanation(candidates=[{"symbol": SYMBOL,
            "text": "该合约 Vega 较低，波动率变化影响可控，Gamma 也较低。"}])
        self.rejected(completion(value), screen=data)
        for metric, text in (("vega", "维伽较低"), ("gamma", "伽马较低"),
                             ("theta", "Theta较高"), ("iv", "隐含波动率较低"),
                             ("delta", "Delta较低")):
            case = screening(); case["candidates"][0][metric] = None
            for field in ("overview", "text"):
                value = explanation()
                if field == "overview": value[field] = text
                else: value["candidates"][0][field] = text
                with self.subTest(metric=metric, field=field):
                    self.rejected(completion(value), screen=case)

    def test_overview_uses_union_of_missing_greeks_but_candidate_uses_own_facts(self):
        data = screening(2); data["candidates"][0]["vega"] = None
        value = explanation([SYMBOL, SECOND])
        value["candidates"][0]["text"] = "部分参数尚未提供，尾部下跌风险仍需关注。"
        value["candidates"][1]["text"] = "Vega 是合约参考敏感度，不等于卖方的持仓暴露。"
        result = explain_risk_screen(Client(completion(value)), data, "deepseek-flash")
        self.assertEqual(result["status"], "complete")
        value["overview"] = "Vega 只是参考参数。"
        self.rejected(completion(value), screen=data)

    def test_general_volatility_mechanics_and_ordinary_words_are_allowed_when_greeks_missing(self):
        data = screening()
        data["candidates"][0].update(vega=None, gamma=None, theta=None, iv=None)
        value = explanation(overview="同一策略仍受多种因素影响，一旦波动加剧，风险会发生变化。",
            candidates=[{"symbol": SYMBOL, "text": "部分参数尚未提供。波动率上升可能使平仓成本上升，权利金缓冲有限，本金仍可能损失。"}])
        result = explain_risk_screen(Client(completion(value)), data, "deepseek-flash")
        self.assertEqual(result["status"], "complete")

    def test_invalid_scenarios_are_not_forwarded(self):
        for scenario in ([{"move_pct": -20, "settlement": 1, "pnl_gross": 1}],
                         [{"move_pct": -20, "settlement": 1, "pnl_gross": 1}] * 3,
                         [{"move_pct": value, "settlement": 1, "pnl_gross": math.nan} for value in (-10, -20, -30)]):
            data = screening(); data["candidates"][0]["stress_scenarios"] = scenario
            self.rejected(completion(), "invalid_risk_screen", data)

    def test_secret_in_allowlisted_fact_is_rejected_before_provider_call(self):
        data = screening(); data["candidates"][0]["risk_summary"] = SYNTHETIC_SECRET
        error, client = self.rejected(completion(), "invalid_risk_screen", data)
        self.assertEqual(client.calls, [])

    def test_unknown_duplicate_or_missing_output_symbols_are_rejected(self):
        data = screening(2)
        cases = [[SYMBOL], [SYMBOL, SYMBOL], [SYMBOL, "BTC-301011-99999-P"], [SYMBOL, SECOND, "BTC-301011-68000-P"]]
        for symbols in cases:
            with self.subTest(symbols=symbols):
                self.rejected(completion(explanation(symbols)), screen=data)

    def test_valid_out_of_order_explanations_are_returned_in_local_screen_order(self):
        client = Client(completion(explanation([SECOND, SYMBOL])))
        result = explain_risk_screen(client, screening(2), "deepseek-flash")
        self.assertEqual([row["symbol"] for row in result["candidates"]], [SYMBOL, SECOND])

    def test_numeric_or_percentage_claims_are_rejected_in_both_narrative_fields(self):
        for text in ("权利金100美元", "下降２０", "收益百分之五", "损失为20%", "比例为１０％", "合约BTC-301011-70000-P"):
            for field in ("overview", "text"):
                data = explanation()
                if field == "overview": data[field] = text
                else: data["candidates"][0][field] = text
                with self.subTest(text=text, field=field):
                    self.rejected(completion(data))

    def test_profit_guarantees_html_control_codes_and_echoed_keys_are_rejected(self):
        for text in ("一定保本", "稳赚", "无风险", "保证盈利", "<script>坏内容</script>", "坏\x00内容", SYNTHETIC_SECRET):
            self.rejected(completion(explanation(overview=text)))

    def test_chinese_numbers_with_monetary_ratio_and_time_units_are_rejected(self):
        for text in ("预留一万美元即可，最多亏两千美元", "损失最多贰仟元", "资金需三百USDT", "每天赚二十美金",
                     "收益为三成", "价格下降三分之一", "波动扩大二点五倍", "持有三天", "期限为两个月",
                     "隐含比例达千分之三", "损失减半", "收益翻倍", "最多亏一半本金"):
            for field in ("overview", "text"):
                value = explanation()
                if field == "overview": value[field] = text
                else: value["candidates"][0][field] = text
                with self.subTest(text=text, field=field):
                    self.rejected(completion(value))

    def test_principal_guarantee_variants_are_rejected_without_numeric_words(self):
        for text in ("这张合约能够让本金得到保证", "资金受到保障", "能够确保本金安全", "本金绝对安全",
                     "本金得到保护", "资金受到充分保护", "本金不会亏损", "本金不受损",
                     "承诺获得收益", "一定盈利", "保证资金不受损", "亏损有人兜底"):
            for field in ("overview", "text"):
                value = explanation()
                if field == "overview": value[field] = text
                else: value["candidates"][0][field] = text
                with self.subTest(text=text, field=field):
                    self.rejected(completion(value))

    def test_btc_market_description_is_allowed_without_numeric_claims_or_contract_codes(self):
        value = explanation(overview="BTC 下跌时，卖方仍可能承担显著损失，权利金缓冲有限。")
        result = explain_risk_screen(Client(completion(value)), screening(), "deepseek-flash")
        self.assertEqual(result["overview"], value["overview"])
        for text in ("参照BTC-当前合约", "参照BTC/USDT合约", "BTC 下跌20%时风险较大"):
            self.rejected(completion(explanation(overview=text)))

    def test_extra_or_wrong_output_fields_are_rejected(self):
        for value in ({"overview": "说明", "candidates": [], "reasoning_content": SYNTHETIC_SECRET},
                      {"overview": "说明", "candidates": [{"symbol": SYMBOL, "text": "说明", "price": 1}]},
                      {"overview": "说明"}, {"overview": [], "candidates": []}):
            self.rejected(completion(value))

    def test_empty_and_oversized_narratives_are_rejected(self):
        for value in (explanation(overview=" "), explanation(overview="长" * 1201),
                      explanation(candidates=[{"symbol": SYMBOL, "text": "长" * 901}])):
            self.rejected(completion(value))

    def test_truncated_empty_tool_and_non_json_responses_are_rejected(self):
        for finish, content, code in (("length", "{}", "truncated_explanation"),
                                      ("stop", "", "empty_explanation"), ("tool_calls", "{}", "invalid_explanation"),
                                      ("stop", "not JSON " + SYNTHETIC_SECRET, "invalid_explanation"),
                                      ("stop", '{"overview":"说明","overview":"重复","candidates":[]}', "invalid_explanation")):
            payload = completion()
            payload["choices"][0]["finish_reason"] = finish
            payload["choices"][0]["message"]["content"] = content
            self.rejected(payload, code)

    def test_reasoning_content_is_rejected_and_never_returned(self):
        payload = completion(); payload["choices"][0]["message"]["reasoning_content"] = SYNTHETIC_SECRET
        error, _ = self.rejected(payload)
        self.assertNotIn("reasoning_content", str(error))

    def test_arbitrary_transport_exception_text_is_never_exposed(self):
        for error in (RuntimeError(SYNTHETIC_SECRET), ValueError(SYNTHETIC_SECRET),
                      DeepSeekError("authentication", SYNTHETIC_SECRET, 401),
                      DeepSeekError("authentication", SYNTHETIC_SECRET, SYNTHETIC_SECRET),
                      DeepSeekError("unknown_" + SYNTHETIC_SECRET, SYNTHETIC_SECRET)):
            client = Client(error)
            with self.assertRaises(DeepSeekError) as captured:
                explain_risk_screen(client, screening(), "deepseek-flash")
            self.assertNotIn(SYNTHETIC_SECRET, str(captured.exception))
            self.assertNotIn(SYNTHETIC_SECRET, captured.exception.code)
            self.assertIsInstance(captured.exception.status, int)

    def test_cancelled_before_call_or_after_provider_response_is_discarded(self):
        cancel = threading.Event(); cancel.set()
        client = Client()
        with self.assertRaises(DeepSeekError) as captured:
            explain_risk_screen(client, screening(), "deepseek-flash", cancel)
        self.assertEqual(captured.exception.code, "cancelled")
        self.assertEqual(client.calls, [])
        cancel.clear()
        client = Client(effect=lambda unused: cancel.set())
        with self.assertRaises(DeepSeekError) as captured:
            explain_risk_screen(client, screening(), "deepseek-flash", cancel)
        self.assertEqual(captured.exception.code, "cancelled")
        self.assertIs(client.calls[0]["cancel_event"], cancel)

    def test_total_deadline_is_checked_even_for_injected_transport(self):
        client = Client(effect=lambda value: setattr(value, "now", 145.1))
        with self.assertRaises(DeepSeekError) as captured:
            explain_risk_screen(client, screening(), "deepseek-flash")
        self.assertEqual(captured.exception.code, "timeout")

    def test_usage_and_reported_model_are_allowlisted_and_never_echo_private_metadata(self):
        payload = completion(model=SYNTHETIC_SECRET, usage={"total_tokens": 140, "prompt_tokens": True,
            "completion_tokens": -1, "reasoning": SYNTHETIC_SECRET, "prompt_cache_hit_tokens": 2 ** 54})
        result = explain_risk_screen(Client(payload), screening(), "deepseek-v4-pro")
        self.assertEqual(result["model"], "deepseek-v4-pro")
        self.assertEqual(result["usage"], {"total_tokens": 140})
        self.assertNotIn(SYNTHETIC_SECRET, json.dumps(result))
        payload["model"] = "deepseek-flash-" + SYNTHETIC_SECRET
        result = explain_risk_screen(Client(payload), screening(), "deepseek-v4-pro")
        self.assertEqual(result["model"], "deepseek-v4-pro")
        self.assertNotIn(SYNTHETIC_SECRET, json.dumps(result))

    def test_real_local_profile_result_is_accepted_without_losing_snapshot_identity(self):
        from option_risk_profiles import screen_risk_profile
        from test_option_ai_engine import NOW, snapshot
        local = screen_risk_profile(snapshot(), "low", now_ms=NOW)
        symbols = [row["symbol"] for row in local["candidates"]]
        self.assertTrue(symbols)
        client = Client(completion(explanation(symbols)))
        result = explain_risk_screen(client, local, "deepseek-flash")
        self.assertEqual(result["status"], "complete")
        context = json.loads(client.calls[0]["payload"]["messages"][1]["content"])["context"]
        self.assertEqual(context["snapshot"]["reference_id"], local["snapshot"]["reference_id"])
        self.assertEqual(context["candidates"][0]["cash_required"], local["candidates"][0]["cash_required"])


if __name__ == "__main__":
    unittest.main()
