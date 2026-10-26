"""Deterministic, read-only screening of one coherent public options snapshot.

The language model supplies criteria, never prices or contract identifiers.
All matches, sizes, expiry times and monetary values are checked here.  This
module has no network, credential, account, order or persistent-storage access.
"""
import datetime as dt
from decimal import Decimal, InvalidOperation
import hashlib
import json
import math
import re
import time


DAY_MS = 86400000
BEIJING = dt.timezone(dt.timedelta(hours=8))
SORTS = ("daily_premium_desc", "cash_daily_return_desc", "spread_asc", "delta_asc")
DEFAULTS = {"direction": "SELL", "type": "PUT", "expiry": "ALL",
            "quantity": .01, "limit": 10, "sort": "daily_premium_desc"}
BOUNDS = {
    "days": "remaining_days", "strike": "strike", "otm_pct": "otm_pct",
    "abs_delta": "abs_delta", "iv": "iv", "gamma": "gamma", "vega": "vega",
    "theta": "theta", "premium": "quote_price",
}
MARK_METRICS = {"delta": "delta", "gamma": "gamma", "vega": "vega", "theta": "theta", "iv": "mark_iv"}
NUMERIC_KEYS = {prefix + name for name in BOUNDS for prefix in ("min_", "max_")}
NUMERIC_KEYS.update(("min_daily_premium", "max_spread_pct", "min_cash_daily_return_pct"))
KEYS = set(DEFAULTS) | NUMERIC_KEYS


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    if isinstance(value, str) and not value.strip():
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if math.isfinite(result) else None


def _stamp(value):
    if not isinstance(value, str):
        result = _number(value)
        return result if result is not None and result > 0 else None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return None
        result = parsed.timestamp() * 1000
        return result if math.isfinite(result) and result > 0 else None
    except (ValueError, OverflowError, OSError):
        return None


def _expiry(row):
    value = _number(row.get("expiry_ms"))
    return value if value is not None else _stamp(row.get("expiry_beijing"))


def _date(value):
    try:
        return dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc).astimezone(BEIJING).date().isoformat()
    except (ValueError, OverflowError, OSError, TypeError):
        return None


def validate_criteria(criteria):
    """Return normalized criteria; reject unknown fields and numeric coercion.

    OTM and spread use percentage points (20 means 20%); IV uses the API's
    decimal volatility (.6 means 60%). Premium bounds are quote-price USDT per
    BTC, not the whole position. Greeks are the exchange's unscaled reference
    Greeks, not signed position exposures. Spread is relative to bid/ask mid.
    """
    if not isinstance(criteria, dict) or any(not isinstance(key, str) for key in criteria):
        raise ValueError("筛选条件必须是 JSON 对象。")
    if set(criteria) - KEYS:
        raise ValueError("筛选条件包含未支持字段。")
    result = dict(DEFAULTS)
    result.update(criteria)
    if result["direction"] not in ("BUY", "SELL") or result["type"] not in ("PUT", "CALL", "ALL"):
        raise ValueError("买卖方向或期权类型无效。")
    if result["sort"] not in SORTS:
        raise ValueError("排序方式无效。")
    expiry = result["expiry"]
    if expiry != "ALL":
        if not isinstance(expiry, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", expiry):
            raise ValueError("到期日须为 YYYY-MM-DD 或 ALL。")
        try:
            dt.date.fromisoformat(expiry)
        except ValueError as exc:
            raise ValueError("到期日不是有效日历日期。") from exc
    limit = result["limit"]
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 20:
        raise ValueError("结果数量须为 1 到 20 的整数。")
    quantity = result["quantity"]
    if isinstance(quantity, bool) or not isinstance(quantity, (int, float)) or _number(quantity) is None or quantity <= 0:
        raise ValueError("模拟数量须为有限正数。")
    result["quantity"] = float(quantity)
    for key in NUMERIC_KEYS & result.keys():
        value = result[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or _number(value) is None:
            raise ValueError("筛选数值须为有限数字，不接受字符串、空值或布尔值。")
        if key.endswith(("days", "strike", "abs_delta", "iv", "premium", "spread_pct", "return_pct")) and value < 0:
            raise ValueError("期限、价格、绝对 Delta、IV 和收益率筛选不能为负数。")
        if key.endswith("abs_delta") and value > 1:
            raise ValueError("绝对 Delta 须在 0 至 1 之间。")
        result[key] = float(value)
    for name in BOUNDS:
        low, high = result.get("min_" + name), result.get("max_" + name)
        if low is not None and high is not None and low > high:
            raise ValueError("筛选下限不能大于上限。")
    if (result["sort"] == "cash_daily_return_desc" or "min_cash_daily_return_pct" in result):
        if result["direction"] != "SELL" or result["type"] == "CALL":
            raise ValueError("足额现金日权利金收益率仅适用于卖 Put。")
    return result


CRITERIA_JSON_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "direction": {"type": "string", "enum": ["BUY", "SELL"]},
        "type": {"type": "string", "enum": ["PUT", "CALL", "ALL"]},
        "expiry": {"type": "string", "description": "Beijing expiry date YYYY-MM-DD or ALL"},
        "quantity": {"type": "number", "exclusiveMinimum": 0},
        "limit": {"type": "integer", "minimum": 1, "maximum": 20},
        "sort": {"type": "string", "enum": list(SORTS)},
        **{key: {"type": "number"} for key in sorted(NUMERIC_KEYS)},
    },
}


def _fresh(value, source, now):
    stamp = _stamp(value)
    if stamp is None:
        return "unknown"
    if stamp > now + 2000:
        return "future"
    return "stale" if now - stamp > (20000 if source == "websocket" else 30000) else None


def _receipt(row, field):
    metadata = row.get("field_updated_at")
    group = "mark" if field in MARK_METRICS.values() else "quote"
    return metadata[field] if isinstance(metadata, dict) and field in metadata else row.get(group + "_updated_at")


def _source(row, field):
    metadata = row.get("field_source")
    source = metadata.get(field) if isinstance(metadata, dict) else None
    group = "mark" if field in MARK_METRICS.values() else "quote"
    return source if source is not None else row.get(group + "_source")


def _field_issue(row, field, now, verified=False):
    issue = _fresh(_receipt(row, field), _source(row, field), now)
    return None if issue == "stale" and verified else issue


def _verified_book(row, now):
    proof, verified = row.get("quote_verification"), row.get("quote_verified_at")
    if not isinstance(proof, dict) or proof.get("verified") is not True or proof.get("kind") != "bookTicker":
        return False
    if not isinstance(proof.get("connection"), str) or not re.fullmatch(r"book-\d+", proof["connection"]):
        return False
    generation = proof.get("generation")
    if (isinstance(generation, bool) or not isinstance(generation, (int, float))
            or _number(generation) is None or generation != int(generation) or generation <= 0):
        return False
    if isinstance(verified, bool) or not isinstance(verified, (int, float)) or _number(verified) is None or verified <= 0:
        return False
    verified_at = proof.get("verified_at")
    if isinstance(verified_at, bool) or not isinstance(verified_at, (int, float)) or verified_at != verified:
        return False
    if verified > now + 2000 or now - verified > 20000:
        return False
    baseline = proof.get("baseline_at")
    if isinstance(baseline, bool) or not isinstance(baseline, (int, float)) or _number(baseline) is None or baseline <= 0 or baseline > now + 2000:
        return False
    values = proof.get("values")
    if not isinstance(values, dict):
        return False
    for field in ("bid_price", "ask_price", "bid_quantity", "ask_quantity"):
        expected, actual = _number(values.get(field)), _number(row.get(field))
        if expected is None or actual is None or expected < 0 or expected != actual:
            return False
    return True


def _quote_issue(row, criteria, now):
    if row.get("status") != "TRADING":
        return "contract_not_trading"
    symbol, side = row.get("symbol"), row.get("side")
    if (not isinstance(symbol, str) or not re.fullmatch(r"BTC-\d{6}-\d+(?:\.\d+)?-[CP]", symbol)
            or side not in ("CALL", "PUT") or not symbol.endswith("-C" if side == "CALL" else "-P")
            or _number(row.get("unit")) != 1 or row.get("quote_asset", "USDT") != "USDT"):
        return "unsupported_contract"
    minimum, maximum, scale = _number(row.get("min_qty")), _number(row.get("max_qty")), row.get("quantity_scale")
    if (minimum is None or minimum <= 0 or (row.get("max_qty") is not None and maximum is None)
            or maximum is not None and maximum < minimum or isinstance(scale, bool)
            or not isinstance(scale, (int, float)) or _number(scale) is None
            or scale != int(scale) or not 0 <= scale <= 12):
        return "quantity_rules_missing"
    quantity = criteria["quantity"]
    try:
        if Decimal(str(quantity)) < Decimal(str(minimum)) or maximum is not None and Decimal(str(quantity)) > Decimal(str(maximum)):
            return "quantity_out_of_range"
        scaled = Decimal(str(quantity)) * (Decimal(10) ** int(scale))
        if scaled != scaled.to_integral_value():
            return "quantity_precision"
    except InvalidOperation:
        return "quantity_precision"
    bid, ask = _number(row.get("bid_price")), _number(row.get("ask_price"))
    field, depth_field = ("bid_price", "bid_quantity") if criteria["direction"] == "SELL" else ("ask_price", "ask_quantity")
    quote = bid if criteria["direction"] == "SELL" else ask
    if quote is None or quote <= 0:
        return "no_bid" if criteria["direction"] == "SELL" else "no_ask"
    if bid is not None and bid < 0 or ask is not None and ask < 0:
        return "invalid_book"
    if bid is not None and ask is not None and bid > 0 and ask > 0 and bid > ask:
        return "crossed_book"
    if row.get("quote_group_valid") is False:
        return "book_group_unverified"
    verified = _verified_book(row, now)
    for key in (field, depth_field):
        issue = _field_issue(row, key, now, verified)
        if issue:
            return "quote_" + issue if key == field else "depth_" + issue
    size = _number(row.get(depth_field))
    if size is None:
        return "depth_missing"
    if size < quantity and not math.isclose(size, quantity, rel_tol=1e-12, abs_tol=1e-12):
        return "depth_insufficient"
    return None


def _within(value, low, high):
    if value is None:
        return False
    if low is not None and value < low and not math.isclose(value, low, rel_tol=1e-12, abs_tol=1e-12):
        return False
    return not (high is not None and value > high and not math.isclose(value, high, rel_tol=1e-12, abs_tol=1e-12))


def _candidate(row, criteria, index, now, exchange_now, expiry, expiry_date):
    strike = _number(row.get("strike_price"))
    days = (expiry - exchange_now) / DAY_MS
    price_field = "bid_price" if criteria["direction"] == "SELL" else "ask_price"
    quote = _number(row.get(price_field))
    quantity, unit = criteria["quantity"], _number(row.get("unit"))
    total = quote * quantity * unit
    daily = total / days
    collateral = strike * quantity * unit
    otm = ((index - strike) / index if row["side"] == "PUT" else (strike - index) / index) * 100
    if not all(math.isfinite(value) for value in (total, daily, collateral, otm)) or min(total, daily, collateral) <= 0:
        return None
    bid, ask = _number(row.get("bid_price")), _number(row.get("ask_price"))
    spread = (ask - bid) / ((ask / 2) + (bid / 2)) * 100 if bid is not None and ask is not None and min(bid, ask) > 0 else None
    verified = _verified_book(row, now)
    if spread is not None and (not math.isfinite(spread) or any(_field_issue(row, field, now, verified) for field in ("bid_price", "ask_price"))):
        spread = None
    metrics, provenance = {}, {}
    for metric, field in MARK_METRICS.items():
        issue = _field_issue(row, field, now)
        metrics[metric] = _number(row.get(field)) if issue is None else None
        source = _source(row, field)
        provenance[metric] = {"source": source if isinstance(source, str) else "unknown",
                              "received_at_ms": _stamp(_receipt(row, field)), "issue": issue}
    delta = metrics["delta"]
    if delta is not None and abs(delta) > 1:
        delta = None
    iv = metrics["iv"]
    if iv is not None and iv < 0:
        iv = None
    cash_rate = daily / collateral * 100 if criteria["direction"] == "SELL" and row["side"] == "PUT" else None
    if cash_rate is not None and not math.isfinite(cash_rate):
        cash_rate = None
    return {
        "symbol": row["symbol"], "type": row["side"], "direction": criteria["direction"],
        "expiry": expiry_date, "expiry_ms": expiry, "strike": strike,
        "quantity": quantity, "unit": unit, "bid_price": bid, "ask_price": ask,
        "bid_quantity": _number(row.get("bid_quantity")), "ask_quantity": _number(row.get("ask_quantity")),
        "quote_quantity": _number(row.get("bid_quantity" if criteria["direction"] == "SELL" else "ask_quantity")),
        "quote_price": quote, "premium_total": total, "daily_premium": daily,
        "premium_cashflow": "credit" if criteria["direction"] == "SELL" else "debit",
        "remaining_days": days, "otm_pct": otm, "abs_delta": abs(delta) if delta is not None else None,
        "delta": delta, "gamma": metrics["gamma"], "vega": metrics["vega"],
        "theta": metrics["theta"], "iv": iv, "spread_pct": spread,
        "metric_provenance": provenance,
        "spread_basis": "mid", "cash_daily_return_pct": cash_rate,
        "quote_source": _source(row, price_field) if _source(row, price_field) in ("websocket", "rest") else "unknown",
        "quote_received_at_ms": _stamp(_receipt(row, price_field)),
        "depth_received_at_ms": _stamp(_receipt(row, "bid_quantity" if criteria["direction"] == "SELL" else "ask_quantity")),
        "book_verified": verified,
        "quote_reference": "bid" if criteria["direction"] == "SELL" else "ask",
    }


def screen_snapshot(snapshot, criteria, now_ms=None):
    """Screen one caller-owned snapshot without fetching, mutating or guessing.

    Receipt freshness is checked against local time; expiry is checked against
    local time plus the exchange offset. A current complete book proof permits
    unchanged old quotes but never excuses an unknown or future timestamp.
    Missing or stale descriptive Greeks are null unless a corresponding bound
    was requested, in which case they fail that bound. Book proofs never
    certify mark/Greek freshness. All income is gross; this is not model EV.
    """
    config = validate_criteria(criteria)
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("options"), list):
        raise ValueError("行情快照须包含期权列表。")
    now = _number(time.time() * 1000 if now_ms is None else now_ms)
    if now is None or now <= 0 or isinstance(now_ms, (str, bool)):
        raise ValueError("估值时间须为有效毫秒数。")
    offset = _number(snapshot.get("exchange_clock_offset_ms", 0))
    if offset is None:
        raise ValueError("交易所时钟偏差无效。")
    exchange_now = now + offset
    if not math.isfinite(exchange_now) or _date(exchange_now) is None:
        raise ValueError("校正后的估值时间无效。")
    rows = snapshot["options"]
    index = _number(snapshot.get("btc_index_price"))
    reference = {
        "instance_id": snapshot.get("instance_id") if isinstance(snapshot.get("instance_id"), str) else None,
        "revision": snapshot.get("revision") if isinstance(snapshot.get("revision"), (str, int, float))
        and not isinstance(snapshot.get("revision"), bool) and (not isinstance(snapshot.get("revision"), float)
        or math.isfinite(snapshot["revision"])) else None,
        "fetched_at": snapshot.get("fetched_at") if isinstance(snapshot.get("fetched_at"), str) else None,
        "evaluated_at_ms": now, "exchange_clock_offset_ms": offset,
        "exchange_now_ms": exchange_now, "btc_index_price": index,
        "index_updated_at": _stamp(snapshot.get("index_updated_at")),
    }
    excluded, matched, warnings = {}, [], []

    def exclude(reason):
        excluded[reason] = excluded.get(reason, 0) + 1

    index_issue = "index_missing" if index is None or index <= 0 else _fresh(snapshot.get("index_updated_at"), snapshot.get("index_source"), now)
    if index_issue and not index_issue.startswith("index_"):
        index_issue = "index_" + index_issue
    if index_issue:
        excluded[index_issue] = len(rows)
        warnings.append("指数缺失或无法确认仍然有效，未生成当前候选。")
    else:
        symbols = [row.get("symbol") for row in rows if isinstance(row, dict) and isinstance(row.get("symbol"), str)]
        duplicate_symbols, seen = set(), set()
        for symbol in symbols:
            if symbol in seen:
                duplicate_symbols.add(symbol)
            seen.add(symbol)
        for row in rows:
            if not isinstance(row, dict):
                exclude("invalid_contract"); continue
            if isinstance(row.get("symbol"), str) and row["symbol"] in duplicate_symbols:
                exclude("duplicate_symbol"); continue
            if config["type"] != "ALL" and row.get("side") != config["type"]:
                exclude("type_filter"); continue
            expiry = _expiry(row)
            expiry_date = _date(expiry) if expiry is not None else None
            if expiry_date is None:
                exclude("expiry_invalid"); continue
            if expiry <= exchange_now:
                exclude("expired"); continue
            if config["expiry"] != "ALL" and expiry_date != config["expiry"]:
                exclude("expiry_filter"); continue
            issue = _quote_issue(row, config, now)
            if issue:
                exclude(issue); continue
            strike = _number(row.get("strike_price"))
            if strike is None or strike <= 0:
                exclude("strike_invalid"); continue
            try:
                item = _candidate(row, config, index, now, exchange_now, expiry, expiry_date)
            except (ArithmeticError, TypeError, ValueError):
                item = None
            if item is None:
                exclude("numeric_range"); continue
            failed = None
            reasons = []
            for name, metric in BOUNDS.items():
                low, high = config.get("min_" + name), config.get("max_" + name)
                if low is None and high is None:
                    continue
                if not _within(item[metric], low, high):
                    failed = metric + ("_missing" if item[metric] is None else "_filter"); break
                reasons.append({"field": metric, "value": item[metric], "minimum": low, "maximum": high})
            for key, metric, upper in (("min_daily_premium", "daily_premium", False),
                                       ("max_spread_pct", "spread_pct", True),
                                       ("min_cash_daily_return_pct", "cash_daily_return_pct", False)):
                if failed or key not in config:
                    continue
                low, high = (None, config[key]) if upper else (config[key], None)
                if not _within(item[metric], low, high):
                    failed = metric + ("_missing" if item[metric] is None else "_filter")
                else:
                    reasons.append({"field": metric, "value": item[metric], "minimum": low, "maximum": high})
            if failed:
                exclude(failed); continue
            item["matched_filters"] = reasons
            matched.append(item)
    sort_field, descending = {
        "daily_premium_desc": ("daily_premium", True),
        "cash_daily_return_desc": ("cash_daily_return_pct", True),
        "spread_asc": ("spread_pct", False), "delta_asc": ("abs_delta", False),
    }[config["sort"]]
    matched.sort(key=lambda item: (item[sort_field] is None,
                                  (-item[sort_field] if descending else item[sort_field]) if item[sort_field] is not None else 0,
                                  item["expiry_ms"], item["strike"], item["symbol"]))
    candidates = matched[:config["limit"]]
    if config["direction"] == "BUY":
        warnings.append("买入方向的日权利金表示平均支出，不表示盈利。")
    if candidates and any(not item["book_verified"] for item in candidates):
        warnings.append("部分结果使用新近接收的盘口快照，尚未取得持续盘口认证；成交不保证。")
    if not rows:
        warnings.append("当前没有期权合约数据。")
    fingerprint = {"snapshot": reference, "criteria": config, "candidates": candidates,
                   "matched_count": len(matched), "exclusions": excluded}
    reference["reference_id"] = hashlib.sha256(json.dumps(fingerprint, sort_keys=True, ensure_ascii=False,
                                                         allow_nan=False, separators=(",", ":")).encode("utf-8")).hexdigest()[:24]
    return {"criteria": config, "snapshot": reference, "candidates": candidates,
            "matched_count": len(matched), "excluded_count": sum(excluded.values()),
            "total_contracts": len(rows), "exclusions": excluded, "warnings": warnings,
            "market_usable": not bool(index_issue) and bool(rows),
            "calculation_basis": "gross premium / exact remaining days; cash rate uses full strike exposure for SELL PUT only; spread / mid; Greeks are exchange reference values"}
