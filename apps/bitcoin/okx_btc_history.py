"""Pure, Decimal-exact validation of read-only OKX BTC account cash ledgers.

Account bill ``balChg`` already contains the whole cash change: never add the
trade's ``sz``, ``fee``, deposits or withdrawals a second time.  Funding and
trading transfers have opposite account legs; keep both, deduplicating only
the same account/bill ID.  Their net effect is zero once both legs settle.
Unrealized derivative PnL is intentionally absent from this cash ledger.

Official contracts: https://www.okx.com/docs-v5/en/#trading-account-rest-api-get-bills-details-last-3-months
https://www.okx.com/docs-v5/en/#funding-account-rest-api-asset-bills-history
"""

from decimal import Decimal, InvalidOperation, localcontext
import re


MAX_BILLS = 4000
_DECIMAL = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?\Z")
_INTEGER = re.compile(r"[0-9]{1,30}\Z")
_DEBT_TYPES = frozenset({"4", "6", "7", "15", "16", "22", "29", "33"})
_DEBT_SUBTYPES = frozenset({"9", "14", "16", "17", "114", "115", "293",
                            "294", "295", "306", "307", "308", "309", "312"})
_FUNDING_DEBT_TYPES = frozenset({"175", "176", "177", "178", "179", "180",
                               "212", "215", "217", "218", "345", "346", "347", "351"})


class HistoryValidationError(ValueError):
    """Only fixed local error codes; never expose provider bill content."""


def decimal_text(value):
    if not isinstance(value, str) or len(value) > 160 or not _DECIMAL.fullmatch(value):
        raise HistoryValidationError("invalid_decimal")
    try:
        result = Decimal(value)
    except InvalidOperation:
        raise HistoryValidationError("invalid_decimal") from None
    if not result.is_finite() or len(result.as_tuple().digits) > 100:
        raise HistoryValidationError("invalid_decimal")
    return format(result, "f")


def timestamp(value):
    if isinstance(value, bool) or not isinstance(value, int):
        raise HistoryValidationError("invalid_timestamp")
    if not 1577836800000 <= value <= 4102444800000:
        raise HistoryValidationError("invalid_timestamp")
    return value


def normalize_btc_bill(row, account):
    if account not in {"trading", "funding"} or not isinstance(row, dict):
        raise HistoryValidationError("invalid_bill")
    bill_id, raw_ts = row.get("billId"), row.get("ts")
    if (row.get("ccy") != "BTC" or not isinstance(bill_id, str)
            or not _INTEGER.fullmatch(bill_id) or not isinstance(raw_ts, str)
            or not _INTEGER.fullmatch(raw_ts)):
        raise HistoryValidationError("invalid_bill")
    bill_type = row.get("type")
    subtype = row.get("subType", "")
    if (not isinstance(bill_type, str) or not _INTEGER.fullmatch(bill_type)
            or not isinstance(subtype, str) or (subtype and not _INTEGER.fullmatch(subtype))):
        raise HistoryValidationError("invalid_bill")
    delta, balance = decimal_text(row.get("balChg")), decimal_text(row.get("bal"))
    kind = "cash_change"
    unsupported = False
    if account == "funding":
        if bill_type in {"130", "131"}:
            kind = "internal_transfer"
        elif bill_type == "1":
            kind = "deposit"
        elif bill_type in {"2", "221"}:
            kind = "withdrawal" if bill_type == "2" else "withdrawal_fee"
        unsupported = bill_type in _FUNDING_DEBT_TYPES
    else:
        if bill_type == "1" and ((row.get("from") == "6" and row.get("to") == "18")
                                  or (row.get("from") == "18" and row.get("to") == "6")):
            kind = "internal_transfer"
        elif bill_type == "2":
            kind = "trade"
        position_delta = row.get("posBalChg", "")
        if position_delta:
            unsupported = Decimal(decimal_text(position_delta)) != 0
        interest = row.get("interest", "")
        if interest:
            unsupported = unsupported or Decimal(decimal_text(interest)) != 0
        unsupported = (unsupported or bill_type in _DEBT_TYPES
                       or subtype in _DEBT_SUBTYPES or row.get("instType") == "MARGIN"
                       or row.get("mgnMode") == "isolated")
    if unsupported:
        kind = "unsupported_debt_or_position_change"
    return {"id": bill_id, "at_ms": timestamp(int(raw_ts)), "delta_btc": delta,
            "balance_btc": balance, "account": account, "kind": kind}


def deduplicate_events(events):
    if not isinstance(events, list) or len(events) > MAX_BILLS:
        raise HistoryValidationError("too_many_bills")
    unique = {}
    for event in events:
        if (not isinstance(event, dict) or event.get("account") not in {"trading", "funding"}
                or not isinstance(event.get("id"), str) or not _INTEGER.fullmatch(event["id"])
                or not isinstance(event.get("kind"), str) or len(event["kind"]) > 60):
            raise HistoryValidationError("invalid_event")
        timestamp(event.get("at_ms"))
        decimal_text(event.get("delta_btc"))
        decimal_text(event.get("balance_btc"))
        key = (event["account"], int(event["id"]))
        previous = unique.get(key)
        if previous is not None and previous != event:
            raise HistoryValidationError("conflicting_bill")
        unique[key] = event
    return sorted(unique.values(), key=lambda row: (row["at_ms"], row["account"], int(row["id"])))


def build_btc_history(events, start_ms, end_ms, anchor_ms, closing_balances,
                      complete=True, reason=None):
    """Validate every account chain against observed cash balances.

    ``events`` must cover [start_ms, anchor_ms], including any bills after the
    requested end; those are undone before returning closing balances at end.
    The empty ledger is valid only because the full API interval was exhausted
    and the caller supplied observed balances; it is never a zero inference.
    """
    start_ms, end_ms, anchor_ms = map(timestamp, (start_ms, end_ms, anchor_ms))
    if not start_ms <= end_ms <= anchor_ms:
        raise HistoryValidationError("invalid_interval")
    if (not isinstance(complete, bool) or not isinstance(closing_balances, dict)
            or set(closing_balances) != {"trading", "funding"}):
        raise HistoryValidationError("invalid_anchor")
    balances = {key: decimal_text(value) for key, value in closing_balances.items()}
    normalized = deduplicate_events(events)
    if any(not start_ms <= row["at_ms"] <= anchor_ms for row in normalized):
        raise HistoryValidationError("bill_outside_interval")
    selected = [row for row in normalized if row["at_ms"] <= end_ms]
    # More than 100 digits are allowed in valid inputs, so retain enough
    # precision for adding signed values without losing a single satoshi.
    with localcontext() as ctx:
        ctx.prec = 220
        for account in ("trading", "funding"):
            rows = [row for row in normalized if row["account"] == account]
            for previous, current in zip(rows, rows[1:]):
                if Decimal(previous["balance_btc"]) + Decimal(current["delta_btc"]) != Decimal(current["balance_btc"]):
                    complete, reason = False, "balance_chain_gap"
            if rows and Decimal(rows[-1]["balance_btc"]) != Decimal(balances[account]):
                complete, reason = False, "anchor_balance_mismatch"
            later = sum((Decimal(row["delta_btc"]) for row in rows if row["at_ms"] > end_ms), Decimal(0))
            balances[account] = format(Decimal(balances[account]) - later, "f")
        if any(row["kind"] == "unsupported_debt_or_position_change" for row in normalized):
            complete, reason = False, "unsupported_debt_history"
    return {"coverage_start_ms": start_ms, "coverage_end_ms": end_ms,
            "anchor_observed_at_ms": anchor_ms, "events": selected,
            "closing_balances": balances, "complete": complete, "reason": reason}
