"""Pure local account valuation and cash-flow-adjusted performance (Python 3.9).

This module performs no I/O, network access, account lookup, or credential lookup.
Pass all money in ONE common reporting currency, preferably as Decimal or API
decimal strings. Internal option premiums, trade proceeds and fees are NOT
external cash flows. A transfer is external only relative to the account scope
being measured; transfers within a consolidated scope must not be counted twice.

Flow input: {"amount": "100", "time_ms": 123, "external": True}.
timestamp_ms is accepted as an alias (if both exist, they must agree).
Positive amounts enter the measured account; negative amounts leave it. external
defaults to True, so the caller must classify and deduplicate API records first.
Both interval endpoints are included. Starting equity must therefore be measured
BEFORE any listed flow exactly at start_ms; ending equity is AFTER flows exactly
at end_ms. A start-boundary flow has weight 1; an end-boundary flow has weight 0.
Records outside the interval are excluded; missing amount/time makes the history
incomplete rather than silently assuming zero. None means unknown history; []
means an explicitly empty history.

Position input: {"symbol": "...", "quantity": "-0.1", "side": "SHORT",
                 "markPrice": "100", "unit": "1"}.
quantity is SIGNED; side, when supplied, must agree (BUY/LONG positive,
SELL/SHORT negative). An API returning unsigned quantity must be normalized by
the caller under that API's documented convention. unit is required; markValue
is ignored. wallet_cash must exclude open option mark values. Mark-based equity
is an audit estimate, not necessarily Binance's margin equity or a liquidation
quote; stale, missing, or inconsistent marks must be flagged by the caller.

modified_dietz returns Decimal amounts and ratio returns (0.1 means 10%). Its
flows_complete flag defaults to False: incomplete account history cannot produce
an audited P&L, interval return or annualization. Annualized figures are labelled
retrospective estimates, suppressed for short intervals by default, and never a
forecast. Modified Dietz itself approximates time-weighted performance and can
be misleading around large flows and volatile markets. Use audit_json_default
with json.dumps(default=...) to serialize Decimal values losslessly as strings.
"""

from decimal import Decimal, DecimalException, InvalidOperation, localcontext


DAY_MS = Decimal(86400000)
YEAR_DAYS = Decimal(365)
_SIDES = {"BUY": 1, "LONG": 1, "SELL": -1, "SHORT": -1}


def _decimal(value):
    if value is None or isinstance(value, bool):
        raise ValueError("A finite decimal amount is required")
    try:
        parsed = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError("A finite decimal amount is required") from None
    if not parsed.is_finite():
        raise ValueError("A finite decimal amount is required")
    return parsed


def _millis(value):
    parsed = _decimal(value)
    if parsed < 0 or parsed != parsed.to_integral_value():
        raise ValueError("A nonnegative integral millisecond timestamp is required")
    return int(parsed)


def _note(warnings, code):
    if code not in warnings:
        warnings.append(code)


def _interval(start_ms, end_ms):
    start, end = _millis(start_ms), _millis(end_ms)
    if end <= start:
        raise ValueError("end_ms must be after start_ms")
    return start, end


def _flows_in_interval(flows, start, end):
    normalized, warnings = [], []
    excluded = internal = 0
    if flows is None:
        return normalized, False, excluded, internal, ["UNKNOWN_EXTERNAL_CASH_FLOWS"]
    if isinstance(flows, (str, bytes, dict)):
        return normalized, False, excluded, internal, ["INVALID_EXTERNAL_CASH_FLOWS"]
    try:
        records = iter(flows)
    except TypeError:
        return normalized, False, excluded, internal, ["INVALID_EXTERNAL_CASH_FLOWS"]
    valid = True
    for record in records:
        if not isinstance(record, dict):
            valid = False
            _note(warnings, "INCOMPLETE_EXTERNAL_CASH_FLOW")
            continue
        external = record.get("external", True)
        if external is False:
            internal += 1
            continue
        if external is not True:
            valid = False
            _note(warnings, "UNKNOWN_CASH_FLOW_CLASSIFICATION")
            continue
        try:
            stamp = _millis(record.get("time_ms", record.get("timestamp_ms")))
            if "time_ms" in record and "timestamp_ms" in record and stamp != _millis(record["timestamp_ms"]):
                raise ValueError("Conflicting cash-flow timestamps")
        except ValueError:
            valid = False
            _note(warnings, "INCOMPLETE_EXTERNAL_CASH_FLOW")
            continue
        if stamp < start or stamp > end:
            excluded += 1
            continue
        try:
            amount = _decimal(record.get("amount"))
        except ValueError:
            valid = False
            _note(warnings, "INCOMPLETE_EXTERNAL_CASH_FLOW")
            continue
        normalized.append((stamp, amount))
    normalized.sort(key=lambda item: item[0])
    return normalized, valid, excluded, internal, warnings


def cashflow_adjusted_pnl(start_equity, end_equity, flows, start_ms, end_ms,
                          *, flows_complete=True):
    """Return end - start - external flows as Decimal, or None if unknown.

    This arithmetic helper assumes the supplied history is complete unless
    flows_complete=False. For account/API auditing use modified_dietz, which
    instead requires explicit completeness confirmation. Negative ending equity
    can still have a meaningful loss amount; it does not justify annualization.
    """
    try:
        start, end = _interval(start_ms, end_ms)
        beginning, ending = _decimal(start_equity), _decimal(end_equity)
        normalized, valid, _, _, _ = _flows_in_interval(flows, start, end)
    except (ValueError, DecimalException):
        return None
    if flows_complete is not True or not valid:
        return None
    with localcontext() as context:
        context.prec = 40
        return ending - beginning - sum((amount for _, amount in normalized), Decimal(0))


def modified_dietz(start_equity, end_equity, flows, start_ms, end_ms,
                   *, flows_complete=False, minimum_annualization_days=30):
    """Audit P&L and estimate returns; invalid/unknown inputs suppress returns.

    P&L = end_equity - start_equity - sum(flow).
    Weighted capital = start_equity + sum(flow * (end_ms-t)/(end_ms-start_ms)).
    Return = P&L / weighted capital. Simple annualization = return * 365/days;
    compound annualization = (1+return)**(365/days)-1, when mathematically valid.
    P&L can be reported even when capital is invalid or ending equity is negative.
    """
    warnings = []
    result = {
        "method": "Modified Dietz", "is_estimate": True,
        "annualization_is_estimate": True, "annualization_is_forecast": False,
        "return_unit": "ratio", "currency_consistency_required": True,
        "start_equity": None, "end_equity": None, "start_ms": None, "end_ms": None,
        "duration_days": None, "observed_external_flow": None,
        "net_external_flow": None, "weighted_external_flow": None,
        "net_pnl": None, "weighted_capital": None, "period_return": None,
        "simple_annualized_return": None, "compound_annualized_return": None,
        "annualization_allowed": False, "flows_complete": False,
        "included_flow_count": 0, "excluded_flow_count": 0,
        "ignored_internal_flow_count": 0, "warnings": warnings,
        "annualization_note": "历史区间的数学换算估计，不代表未来收益；短区间不输出年化。",
    }
    try:
        minimum_days = _decimal(minimum_annualization_days)
        if minimum_days <= 0:
            raise ValueError("Annualization threshold must be positive")
    except ValueError:
        raise ValueError("minimum_annualization_days must be a positive finite number") from None
    try:
        start, end = _interval(start_ms, end_ms)
        result.update(start_ms=start, end_ms=end)
    except (ValueError, DecimalException):
        _note(warnings, "INVALID_TIME_INTERVAL")
        return result
    try:
        beginning = _decimal(start_equity)
        result["start_equity"] = beginning
    except ValueError:
        beginning = None
        _note(warnings, "MISSING_START_EQUITY" if start_equity is None else "INVALID_START_EQUITY")
    try:
        ending = _decimal(end_equity)
        result["end_equity"] = ending
    except ValueError:
        ending = None
        _note(warnings, "MISSING_END_EQUITY" if end_equity is None else "INVALID_END_EQUITY")
    normalized, valid_flows, excluded, internal, flow_warnings = _flows_in_interval(flows, start, end)
    warnings.extend(flow_warnings)
    complete = flows_complete is True and valid_flows
    result.update(flows_complete=complete, included_flow_count=len(normalized),
                  excluded_flow_count=excluded, ignored_internal_flow_count=internal)
    if flows_complete is not True:
        _note(warnings, "EXTERNAL_CASH_FLOW_HISTORY_NOT_CONFIRMED_COMPLETE")
    with localcontext() as context:
        context.prec = 40
        duration_ms = Decimal(end - start)
        days = duration_ms / DAY_MS
        result["duration_days"] = days
        observed_flow = sum((amount for _, amount in normalized), Decimal(0))
        result["observed_external_flow"] = observed_flow
        if days < minimum_days:
            _note(warnings, "SHORT_PERIOD_NO_ANNUALIZATION")
        if not complete:
            return result
        weighted_flow = sum((amount * Decimal(end - stamp) / duration_ms
                             for stamp, amount in normalized), Decimal(0))
        result.update(net_external_flow=observed_flow, weighted_external_flow=weighted_flow)
        if beginning is None or ending is None:
            return result
        pnl = ending - beginning - observed_flow
        capital = beginning + weighted_flow
        result.update(net_pnl=pnl, weighted_capital=capital)
        if beginning < 0:
            _note(warnings, "NEGATIVE_START_EQUITY")
        if ending < 0:
            _note(warnings, "NEGATIVE_END_EQUITY_NO_ANNUALIZATION")
        if capital <= 0:
            _note(warnings, "NONPOSITIVE_WEIGHTED_CAPITAL")
        if beginning < 0 or capital <= 0:
            return result
        period_return = pnl / capital
        result["period_return"] = period_return
        if ending < 0 or days < minimum_days:
            return result
        if period_return < -1:
            _note(warnings, "RETURN_BELOW_MINUS_ONE_NO_ANNUALIZATION")
            return result
        try:
            annual_factor = YEAR_DAYS / days
            simple = period_return * annual_factor
            compound = (Decimal(1) + period_return) ** annual_factor - Decimal(1)
            if not simple.is_finite() or not compound.is_finite():
                raise InvalidOperation()
        except DecimalException:
            _note(warnings, "ANNUALIZATION_UNDEFINED")
            return result
        result.update(simple_annualized_return=simple, compound_annualized_return=compound,
                      annualization_allowed=True)
    return result


def value_option_account(wallet_cash, positions, *, marks_complete=True):
    """Estimate equity from cash and signed option marks; never trust markValue.

    Pass positions=[] only if the position list is known to be complete and empty.
    Missing/inconsistent positions or marks give equity=None, not partial equity.
    Set marks_complete=False for a partial/stale/unverified valuation snapshot.
    Missing side is allowed only because quantity is explicitly signed.
    """
    warnings, normalized = [], []
    result = {"valid": False, "is_estimate": True, "wallet_cash": None,
              "option_mark_value": None, "equity": None, "positions": normalized,
              "warnings": warnings, "valuation_basis": "wallet_cash_plus_signed_option_marks"}
    try:
        cash = _decimal(wallet_cash)
        result["wallet_cash"] = cash
    except ValueError:
        cash = None
        _note(warnings, "MISSING_OR_INVALID_WALLET_CASH")
    if positions is None or isinstance(positions, (str, bytes, dict)):
        _note(warnings, "UNKNOWN_OR_INVALID_POSITIONS")
        return result
    try:
        records = iter(positions)
    except TypeError:
        _note(warnings, "UNKNOWN_OR_INVALID_POSITIONS")
        return result
    if marks_complete is not True:
        _note(warnings, "MARKS_NOT_CONFIRMED_COMPLETE")
    total = Decimal(0)
    with localcontext() as context:
        context.prec = 40
        for position in records:
            if not isinstance(position, dict):
                _note(warnings, "INVALID_POSITION")
                continue
            try:
                quantity = _decimal(position.get("quantity"))
                mark = _decimal(position.get("markPrice"))
                unit = _decimal(position.get("unit"))
                if mark < 0 or unit <= 0:
                    raise ValueError("Invalid mark or unit")
            except ValueError:
                _note(warnings, "MISSING_OR_INVALID_POSITION_VALUE")
                continue
            side = position.get("side")
            if side is not None:
                if not isinstance(side, str) or side.upper() not in _SIDES:
                    _note(warnings, "UNKNOWN_POSITION_SIDE")
                    continue
                if quantity != 0 and (1 if quantity > 0 else -1) != _SIDES[side.upper()]:
                    _note(warnings, "POSITION_SIDE_SIGN_MISMATCH")
                    continue
            value = quantity * mark * unit
            total += value
            normalized.append({"symbol": position.get("symbol"), "quantity": quantity,
                               "side": "LONG" if quantity > 0 else "SHORT" if quantity < 0 else "FLAT",
                               "markPrice": mark, "unit": unit, "market_value": value})
        if warnings or cash is None:
            return result
        result.update(valid=True, option_mark_value=total, equity=cash + total)
        if result["equity"] < 0:
            _note(warnings, "NEGATIVE_ACCOUNT_EQUITY")
    return result


def audit_json_default(value):
    """json.dumps default hook: preserve finite Decimal values as exact strings."""
    if isinstance(value, Decimal) and value.is_finite():
        return str(value)
    raise TypeError("Unsupported audit JSON value")
