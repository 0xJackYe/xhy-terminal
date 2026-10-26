"""Local, read-only relative risk presets for cash-secured short BTC puts.

These are application-defined Delta bands, not an industry risk rating.  They
never turn Delta into a real-world probability or treat option credit as net
profit.  The shared market screener remains the sole quote/freshness gate.
"""
import hashlib
import json
import math

from option_ai_engine import screen_snapshot, validate_criteria


RISK_PROFILE_IDS = ("low", "medium", "high")
_LEVELS = {
    "low": ("低风险", 0.0, .15),
    "medium": ("中风险", .15, .30),
    "high": ("高风险", .30, .60),
}
_BASIS = ("自定义相对风险档，非行业统一等级；仅足额现金卖 Put 口径，非交易所保证金要求。"
          "分档比较绝对 Delta，不代表保本；Delta 不是实际亏损概率或真实胜率。"
          "未计手续费、提前平仓、滑点或强平。")


def _profile(profile):
    if not isinstance(profile, str) or profile not in _LEVELS:
        raise ValueError("请选择 low、medium 或 high 风险档。")
    return _LEVELS[profile]


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError, OverflowError):
        return None


def _definition(profile):
    label, lower, upper = _profile(profile)
    return {
        "id": profile, "label": label, "version": 1,
        "definition": ("足额现金卖 Put；%g < |Delta| ≤ %g；剩余 2–60 天；"
                       "买卖价差 / 中间价 ≤ 20%%；按足额现金日权利金率降序，最多 5 项。"
                       "空结果不放宽条件。" % (lower, upper)),
        "basis": _BASIS, "direction": "SELL", "type": "PUT",
        "delta_min_exclusive": lower, "delta_max_inclusive": upper,
        "min_days": 2, "max_days": 60, "max_spread_pct": 20,
        "sort": "cash_daily_return_desc", "limit": 5,
    }


def risk_profile_definitions():
    """Return fresh JSON metadata; callers cannot alter the preset constants."""
    return [_definition(profile) for profile in RISK_PROFILE_IDS]


def risk_profile_config(profile, expiry="ALL", quantity=.01):
    """Validate the public preset inputs and return its fixed local criteria.

    The lower Delta bound is exclusive in the preset, although the shared
    criteria schema uses inclusive bounds.  screen_risk_profile enforces that
    exact exclusivity before ranking, never after an arbitrary top-N cutoff.
    """
    _, lower, upper = _profile(profile)
    return validate_criteria({
        "direction": "SELL", "type": "PUT", "expiry": expiry,
        "quantity": quantity, "limit": 5, "sort": "cash_daily_return_desc",
        "min_abs_delta": lower, "max_abs_delta": upper,
        "min_days": 2, "max_days": 60, "max_spread_pct": 20,
    })


def _risk_facts(candidate, index, label):
    strike, quantity, unit = candidate["strike"], candidate["quantity"], candidate["unit"]
    price, credit = candidate["quote_price"], candidate["premium_total"]
    cash = strike * quantity * unit
    break_even = strike - price
    loss = break_even * quantity * unit
    drop = (index - break_even) / index * 100
    scenarios = []
    for move in (-10, -20, -30):
        settlement = index * (1 + move / 100)
        pnl = credit - max(strike - settlement, 0) * quantity * unit
        scenarios.append({"move_pct": move, "settlement": settlement, "pnl_gross": pnl})
    values = [cash, credit, break_even, loss, drop]
    values.extend(value for scenario in scenarios for value in scenario.values())
    if (not all(math.isfinite(value) for value in values)
            or cash <= 0 or not 0 < price < strike or loss <= 0):
        raise ValueError("风险计算参数无效。")
    return {
        "cash_required": cash, "max_profit_gross": credit, "max_loss_gross": loss,
        "break_even": break_even, "break_even_drop_pct": drop,
        "stress_scenarios": scenarios,
        "risk_summary": (
            "%s档的足额现金卖 Put，|Delta| 为 %.6g。按买一价模拟 %.6g BTC，"
            "整笔收取权利金 %.8g USDT；需覆盖行权金额 %.8g USDT。"
            "持有到期且 BTC 结算价低于 %.8g USDT 时出现毛亏损；"
            "若结算价归零，最大毛亏损 %.8g USDT。"
            "以上未扣费用，Delta 不代表真实胜率。" % (
                label, candidate["abs_delta"], quantity * unit, credit, cash, break_even, loss)),
    }


def screen_risk_profile(snapshot, profile, expiry="ALL", quantity=.01, now_ms=None):
    """Rank one immutable public snapshot under an exact, fixed risk preset.

    Keep duplicates in the input view so prefiltering cannot bless a duplicate
    symbol rejected by the shared engine.  Raw Delta is only an early strict
    band gate: the engine independently requires that Delta and both book sides
    are current, quantity/depth is valid, and the contract is actually trading.
    """
    criteria = risk_profile_config(profile, expiry, quantity)
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("options"), list):
        raise ValueError("行情快照须包含期权列表。")
    label, lower, upper = _profile(profile)
    rows = snapshot["options"]
    seen, duplicates = set(), set()
    for row in rows:
        symbol = row.get("symbol") if isinstance(row, dict) else None
        if isinstance(symbol, str):
            if symbol in seen:
                duplicates.add(symbol)
            seen.add(symbol)
    selected, excluded = [], {}
    for row in rows:
        if (isinstance(row, dict) and row.get("side") == "PUT"
                and isinstance(row.get("symbol"), str) and row["symbol"] not in duplicates):
            delta = _number(row.get("delta"))
            bid, strike = _number(row.get("bid_price")), _number(row.get("strike_price"))
            if delta is not None and delta >= 0:
                excluded["put_delta_sign_invalid"] = excluded.get("put_delta_sign_invalid", 0) + 1
                continue
            if delta is not None and not lower < abs(delta) <= upper:
                excluded["profile_delta_band"] = excluded.get("profile_delta_band", 0) + 1
                continue
            if bid is not None and strike is not None and bid >= strike:
                excluded["premium_at_or_above_strike"] = excluded.get("premium_at_or_above_strike", 0) + 1
                continue
            if (bid is not None and strike is not None and 0 < bid < strike
                    and (strike - bid) * criteria["quantity"] <= 0):
                excluded["risk_numeric_range"] = excluded.get("risk_numeric_range", 0) + 1
                continue
        selected.append(row)
    result = screen_snapshot(dict(snapshot, options=selected), criteria, now_ms=now_ms)
    if rows and not selected:
        # An empty strict band is not an empty/offline exchange catalog.
        result["warnings"] = [text for text in result["warnings"] if text != "当前没有期权合约数据。"]
        result["market_usable"] = not any(key.startswith("index_") for key in result["exclusions"])
    result["risk_profile"] = _definition(profile)
    result["risk_profile"].update(expiry=criteria["expiry"], quantity=criteria["quantity"])
    for key, count in excluded.items():
        result["exclusions"][key] = result["exclusions"].get(key, 0) + count
    result["excluded_count"] += sum(excluded.values())
    result["total_contracts"] = len(rows)
    candidates = []
    for candidate in result["candidates"]:
        # The early gate makes these calculations safe before top-N ranking.
        # The postcondition also fails closed if the shared engine changes.
        try:
            facts = _risk_facts(candidate, result["snapshot"]["btc_index_price"], label)
        except (ValueError, TypeError, ArithmeticError):
            result["exclusions"]["risk_numeric_range"] = result["exclusions"].get("risk_numeric_range", 0) + 1
            result["excluded_count"] += 1
            result["matched_count"] -= 1
            continue
        candidates.append(dict(candidate, **facts))
    result["candidates"] = candidates
    result["warnings"] = [_BASIS] + result["warnings"]
    if not candidates:
        result["warnings"].append("当前快照没有满足该风险档且报价有效的合约；条件未放宽。")
    # The final reference covers the actual preset and added risk facts too.
    reference = dict(result["snapshot"])
    base_reference = reference.pop("reference_id", None)
    result["snapshot"]["base_reference_id"] = base_reference
    fingerprint = {"snapshot": reference, "criteria": criteria, "risk_profile": result["risk_profile"],
                   "candidates": candidates, "matched_count": result["matched_count"],
                   "exclusions": result["exclusions"]}
    result["snapshot"]["reference_id"] = hashlib.sha256(json.dumps(
        fingerprint, ensure_ascii=False, sort_keys=True, allow_nan=False,
        separators=(",", ":")).encode("utf-8")).hexdigest()[:24]
    return result
