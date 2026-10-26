#!/usr/bin/env python3
"""Read Binance BTC options public market data. Python 3.9+, no packages needed."""

import argparse
import csv
import gzip
import http.client
import io
import json
import math
import random
import re
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor
from collections import deque
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from email.utils import parsedate_to_datetime
from pathlib import Path

BASE_URL = "https://eapi.binance.com"
BEIJING = timezone(timedelta(hours=8))
DOCS = "https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-options/api/rest-api/market-data"
FIELDS = [
    "symbol", "side", "expiry_beijing", "days_to_expiry", "strike_price",
    "otm_pct", "unit", "min_qty", "initial_margin_rate", "min_initial_margin_rate",
    "maintenance_margin_rate", "min_maintenance_margin_rate", "liquidation_fee_rate",
    "quantity_step", "max_qty", "status", "bid_price", "ask_price",
    "last_price", "mark_price", "mark_iv", "delta", "gamma", "theta", "vega",
    "volume_24h_contracts", "amount_24h_quote", "quote_asset",
    "last_trade_beijing", "has_mark", "has_ticker",
]
GENERAL_DOCS = "https://developers.binance.com/en/docs/products/derivatives-trading-options/general-info"
MAX_HTTP_ATTEMPTS = 3
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
_WEIGHT_HEADER = re.compile(r"^x-mbx-used-weight-(\d+)([smhd])$", re.I)
_INTERVAL_SECONDS = {"SECOND": 1, "MINUTE": 60, "HOUR": 3600, "DAY": 86400}
_ENDPOINT_NAMES = {"time": "time", "exchangeInfo": "exchange_info", "index": "index",
                   "mark": "mark", "ticker": "ticker", "depth": "depth"}


def timestamp_ms(value):
    return datetime.fromtimestamp(int(value) / 1000, BEIJING).isoformat(timespec="seconds")


def number(value):
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    except (TypeError, ValueError, OverflowError):
        return None


def decode_public_json(raw):
    """Reject all nonfinite numbers, including exponent overflow in metadata."""
    def reject_constant(_value):
        raise ValueError("Nonfinite JSON")

    def finite_float(value):
        parsed = float(value)
        if not math.isfinite(parsed):
            raise ValueError("Nonfinite JSON")
        return parsed

    return json.loads(raw, parse_constant=reject_constant, parse_float=finite_float)


def _retry_after_seconds(value):
    """Accept seconds or an HTTP date; never return arbitrary header contents."""
    seconds = number(value)
    if seconds is None and isinstance(value, str):
        try:
            date = parsedate_to_datetime(value)
            if date.tzinfo is None:
                date = date.replace(tzinfo=timezone.utc)
            seconds = date.timestamp() - time.time()
        except (TypeError, ValueError, OverflowError):
            return None
    return max(0, math.ceil(seconds)) if seconds is not None else None


def _rate_headers(headers):
    safe = {}
    for key, value in (headers.items() if headers is not None else ()):
        if _WEIGHT_HEADER.fullmatch(key) and str(value).isdigit():
            safe[key] = str(int(value))
        elif key.lower() == "retry-after":
            delay = _retry_after_seconds(value)
            if delay is not None:
                safe["Retry-After"] = str(delay)
    return safe


def request_weight(path, params=None):
    """Options REST weights from DOCS; each retry spends weight again."""
    params = params or {}
    if path == "/eapi/v1/ticker":
        return 1 if params.get("symbol") else 40
    if path == "/eapi/v1/mark":
        return 5
    if path == "/eapi/v1/depth":
        limit = number(params.get("limit", 100))
        return 1 if limit is not None and limit <= 50 else 5 if limit is not None and limit <= 100 else 10 if limit is not None and limit <= 500 else 20
    return {"/eapi/v1/exerciseHistory": 3, "/eapi/v1/openInterest": 0,
            "/eapi/v1/trades": 5, "/eapi/v1/blockTrades": 5}.get(path, 1)


class PublicRequestLimiter:
    """Thread-safe process-local guard, not a substitute for Binance's IP limits.

    A conservative 400/min fallback is replaced by valid exchangeInfo limits.
    Local attempts use rolling windows; headers also account for other IP users.
    """
    def __init__(self, minute_limit=400):
        self._lock = threading.Lock()
        self._limits = {60: minute_limit}
        self._events = deque()
        self._observed = {}
        self._blocked_until = 0
        self._blocked_status = None

    def configure(self, limits):
        policies = {}
        for item in limits if isinstance(limits, list) else ():
            if not isinstance(item, dict) or item.get("rateLimitType") != "REQUEST_WEIGHT":
                continue
            period, count, limit = _INTERVAL_SECONDS.get(item.get("interval")), number(item.get("intervalNum")), number(item.get("limit"))
            if period and count is not None and limit is not None and count > 0 and limit > 0 and count.is_integer() and limit.is_integer():
                policies[period * int(count)] = int(limit)
        if policies:
            with self._lock:
                self._limits = policies

    def reserve(self, weight):
        with self._lock:
            now, wall = time.monotonic(), time.time()
            if now < self._blocked_until:
                return {"type": "RATE_LIMIT_COOLDOWN", "retry_after": max(1, math.ceil(self._blocked_until - now)),
                        "blocked_by_http_status": self._blocked_status}
            longest = max(self._limits)
            while self._events and self._events[0][0] <= now - longest:
                self._events.popleft()
            wait = 0
            for period, limit in self._limits.items():
                budget = max(1, int(limit * 0.9))
                events = [(stamp, cost) for stamp, cost in self._events if stamp > now - period]
                used = sum(cost for _, cost in events)
                excess = used + weight - budget
                if excess > 0:
                    freed = 0
                    for stamp, cost in events:
                        freed += cost
                        if freed >= excess:
                            wait = max(wait, stamp + period - now + 0.1)
                            break
                    else:
                        wait = max(wait, period)
                bucket, observed = self._observed.get(period, (None, 0))
                if bucket == int(wall // period) and observed + weight > budget:
                    wait = max(wait, period - wall % period + 1)
            if wait > 0:
                return {"type": "LOCAL_RATE_LIMIT", "retry_after": max(1, math.ceil(wait))}
            self._events.append((now, weight))
            for period, (bucket, used) in list(self._observed.items()):
                if bucket == int(wall // period):
                    self._observed[period] = (bucket, used + weight)
            return None

    def observe(self, headers, http_status=None):
        with self._lock:
            now, wall = time.monotonic(), time.time()
            for key, value in headers.items():
                match = _WEIGHT_HEADER.fullmatch(key)
                if match and str(value).isdigit():
                    period = int(match[1]) * {"s": 1, "m": 60, "h": 3600, "d": 86400}[match[2].lower()]
                    if period <= 0:
                        continue
                    bucket = int(wall // period)
                    old_bucket, used = self._observed.get(period, (None, 0))
                    self._observed[period] = (bucket, max(used if old_bucket == bucket else 0, int(value)))
            if http_status in (418, 429):
                delay = _retry_after_seconds(headers.get("Retry-After"))
                delay = max(1, delay if delay is not None else 120 if http_status == 418 else 60)
                if now + delay >= self._blocked_until:
                    self._blocked_until, self._blocked_status = now + delay, http_status


_PUBLIC_REQUEST_LIMITER = PublicRequestLimiter()


class _ResponseTooLarge(ValueError):
    pass


def _read_response(response, deadline, timeout, max_bytes=MAX_RESPONSE_BYTES):
    """Read complete bounded bytes before parsing; detect truncated bodies."""
    raw_length = response.headers.get("Content-Length")
    expected = int(raw_length) if raw_length is not None and str(raw_length).isdigit() else None
    if expected is not None and expected > max_bytes:
        raise _ResponseTooLarge()
    chunks, size = [], 0
    read = getattr(response, "read1", None) or response.read
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise socket.timeout()
        # urllib exposes no public response timeout setter. Adjust its underlying
        # socket when available so slow chunk delivery cannot restart the budget.
        sock = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
        if sock is not None:
            sock.settimeout(min(timeout, remaining))
        chunk = read(min(65536, max_bytes - size + 1))
        if not chunk:
            break
        size += len(chunk)
        if size > max_bytes:
            raise _ResponseTooLarge()
        chunks.append(chunk)
    if expected is not None and size != expected:
        raise http.client.IncompleteRead(b"", max(0, expected - size))
    if time.monotonic() > deadline:
        raise socket.timeout()
    return b"".join(chunks)


def _decode_public_body(raw, encoding):
    """Decode the bounded wire body, with a separate expanded-size limit.

    Content-Length describes compressed bytes, so completeness is checked by
    _read_response before this step. GzipFile's bounded read also validates its
    header, payload, CRC and trailer before a JSON document can be accepted.
    """
    encoding = (encoding or "identity").strip().lower()
    if encoding == "identity":
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("Decoded response exceeds limit")
        return raw
    if encoding != "gzip":
        raise ValueError("Unsupported content encoding")
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(raw), mode="rb") as body:
            decoded = body.read(MAX_RESPONSE_BYTES + 1)
        if len(decoded) > MAX_RESPONSE_BYTES:
            raise ValueError("Decoded response exceeds limit")
        return decoded
    except (OSError, EOFError, zlib.error):
        # Compression errors may include upstream bytes. Keep them away from
        # the transport's retry and diagnostics paths, just like invalid JSON.
        raise ValueError("Invalid compressed response") from None


def _network_failure(exc, phase):
    reason = getattr(exc, "reason", exc)
    if isinstance(reason, ssl.SSLCertVerificationError):
        kind, retryable = "TLS_CERTIFICATE_ERROR", False
    elif isinstance(reason, (socket.timeout, TimeoutError)):
        kind, retryable = ("READ_TIMEOUT" if phase == "read" else "CONNECT_TIMEOUT"), True
    elif isinstance(reason, ConnectionResetError):
        kind, retryable = ("READ_RESET" if phase == "read" else "CONNECT_RESET"), True
    elif isinstance(reason, socket.gaierror):
        kind, retryable = "DNS_ERROR", True
    elif isinstance(reason, (http.client.HTTPException, ssl.SSLEOFError)):
        kind, retryable = ("READ_INTERRUPTED" if phase == "read" else "CONNECTION_ERROR"), True
    elif isinstance(reason, ssl.SSLError):
        kind, retryable = "TLS_ERROR", False
    else:
        kind, retryable = "NETWORK_ERROR", True
    messages = {"READ_TIMEOUT": "已收到响应头，但行情内容读取超时。", "READ_RESET": "已收到响应头，但读取行情时连接被重置。",
                "READ_INTERRUPTED": "行情响应内容未完整接收。", "CONNECT_TIMEOUT": "连接公开行情接口超时。",
                "TLS_CERTIFICATE_ERROR": "公开行情接口的 TLS 证书校验失败。", "DNS_ERROR": "公开行情接口域名解析失败。"}
    # Never stringify an exception: proxy URLs and credentials can be in reason.
    return {"type": kind, "reason_type": type(reason).__name__, "phase": phase,
            "retryable": retryable, "message": messages.get(kind, "公开行情网络连接失败。")}


def get_public(path, timeout, params=None, *, max_attempts=MAX_HTTP_ATTEMPTS):
    """Unsigned official-host GET; at most three attempts with bounded backoff.

    timeout is an entire attempt's connect/body budget (also the socket timeout).
    HTTP 200 records response headers, not successful/complete JSON reception.
    429/418 never retry here; all workers share the resulting cooldown.
    """
    if number(timeout) is None or timeout <= 0 or isinstance(max_attempts, bool) or not isinstance(max_attempts, int) or not 1 <= max_attempts <= MAX_HTTP_ATTEMPTS:
        raise ValueError("Invalid public request timeout or attempt limit")
    if not isinstance(path, str) or not re.fullmatch(r"/eapi/v1/[A-Za-z0-9]+", path):
        raise ValueError("Only official public options API paths are accepted")
    if params and any(re.sub(r"[^a-z]", "", str(key).lower()) in {"token", "accesstoken", "apikey", "secret", "secretkey", "signature", "authorization"} for key in params):
        raise ValueError("Credentials are not accepted by the public market client")
    url = BASE_URL + path + ("?" + urllib.parse.urlencode(params) if params else "")
    started = time.monotonic()
    deadline = started + timeout * max_attempts + 3
    history = []
    result = {"url": url, "ok": False}
    attempts = 0
    for index in range(max_attempts):
        blocked = _PUBLIC_REQUEST_LIMITER.reserve(request_weight(path, params))
        if blocked:
            result = {"url": url, "ok": False, "rate_limited": True, "network_request_sent": False,
                      "retry_after": str(blocked["retry_after"]), "error": {"type": blocked["type"], "phase": "local_guard",
                      "retryable": False, "message": "公开行情请求处于限流冷却期，暂未发送新请求。"}}
            if blocked.get("blocked_by_http_status"):
                result["blocked_by_http_status"] = blocked["blocked_by_http_status"]
            break
        attempts += 1
        result = {"url": url, "ok": False, "network_request_sent": True, "response_complete": False}
        phase = "connect"
        attempt_started = time.monotonic()
        attempt_deadline = min(deadline, attempt_started + timeout)
        request = urllib.request.Request(url, headers={"Accept": "application/json", "Accept-Encoding": "gzip", "Connection": "close"}, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=min(timeout, max(0.001, attempt_deadline - time.monotonic()))) as response:
                result["http_status"] = response.status
                result["rate_headers"] = _rate_headers(response.headers)
                _PUBLIC_REQUEST_LIMITER.observe(result["rate_headers"], response.status)
                phase = "read"
                raw = _read_response(response, attempt_deadline, timeout)
                result["response_complete"] = True
                phase = "decode"
                raw = _decode_public_body(raw, response.headers.get("Content-Encoding"))
                payload = decode_public_json(raw)
                if isinstance(payload, dict) and isinstance(payload.get("code"), int) and not isinstance(payload["code"], bool) and payload["code"] < 0:
                    result["error"] = {"type": "BINANCE_ERROR", "phase": "validation", "code": payload["code"], "retryable": False, "message": "币安公开行情接口返回错误代码 %s。" % payload["code"]}
                    if payload["code"] == -1003:
                        _PUBLIC_REQUEST_LIMITER.observe(result["rate_headers"], 429)
                        result.update(rate_limited=True, retry_after=result["rate_headers"].get("Retry-After", "60"))
                else:
                    result.update(ok=True, data=payload)
                    name = _ENDPOINT_NAMES.get(path.rsplit("/", 1)[-1])
                    if name:
                        validate_response(name, result)
                    elif not isinstance(payload, (dict, list)):
                        result.update(ok=False, error={"type": "UNEXPECTED_SCHEMA", "phase": "validation", "retryable": False, "message": "公开行情接口返回结构无效。"})
                        result.pop("data", None)
                    if result["ok"] and name == "exchange_info":
                        _PUBLIC_REQUEST_LIMITER.configure(payload.get("rateLimits", []))
        except urllib.error.HTTPError as exc:
            result["http_status"] = exc.code
            result["rate_headers"] = _rate_headers(exc.headers)
            _PUBLIC_REQUEST_LIMITER.observe(result["rate_headers"], exc.code)
            result["error"] = {"type": "HTTP_ERROR", "phase": "http", "retryable": exc.code in (408, 500, 502, 503, 504), "message": "公开行情接口返回 HTTP %s。" % exc.code}
            if "Retry-After" in result["rate_headers"]:
                result["retry_after"] = result["rate_headers"]["Retry-After"]
            if exc.code in (418, 429):
                result["rate_limited"] = True
                result.setdefault("retry_after", "120" if exc.code == 418 else "60")
            # Header status is sufficient; do not let a stalled error body hide
            # a 429/418 or echo server/proxy text into diagnostics.
            exc.close()
        except _ResponseTooLarge:
            result["error"] = {"type": "RESPONSE_TOO_LARGE", "phase": "read", "retryable": False, "message": "公开行情响应超过安全读取上限。"}
        except (urllib.error.URLError, socket.timeout, TimeoutError, OSError, http.client.HTTPException) as exc:
            result["error"] = _network_failure(exc, phase)
        except (ValueError, UnicodeError):
            result["error"] = {"type": "INVALID_JSON", "phase": "decode", "retryable": False, "message": "公开行情响应不是有效 JSON。"}
        history.append({"attempt": attempts, "http_status": result.get("http_status"), "ok": result["ok"],
                        "error_type": result.get("error", {}).get("type"), "phase": result.get("error", {}).get("phase"),
                        "elapsed_ms": round((time.monotonic() - attempt_started) * 1000)})
        if result["ok"] or not result.get("error", {}).get("retryable") or index + 1 >= max_attempts:
            break
        delay = max(0.5 * (2 ** index) + random.uniform(0, 0.2), _retry_after_seconds(result.get("retry_after")) or 0)
        if time.monotonic() + delay >= deadline:
            break
        time.sleep(delay)
    if not result["ok"]:
        result.pop("data", None)
    result.update(attempts=attempts, attempt_history=history,
                  elapsed_ms=round((time.monotonic() - started) * 1000),
                  received_at_beijing=datetime.now(BEIJING).isoformat(timespec="seconds"))
    return result


def validate_response(name, result):
    if not result["ok"]:
        return
    data = result["data"]
    valid = False
    def valid_time(value):
        parsed = number(value)
        return parsed is not None and 0 <= parsed < 253402300800000

    def valid_symbol(item):
        return isinstance(item, dict) and isinstance(item.get("symbol"), str) and bool(item["symbol"])

    def numeric_fields(item, fields):
        return all(number(item.get(field)) is not None for field in fields)

    if name == "time":
        valid = isinstance(data, dict) and valid_time(data.get("serverTime")) and number(data["serverTime"]) > 0
    elif name == "exchange_info":
        valid = isinstance(data, dict) and isinstance(data.get("optionSymbols"), list) and all(
            valid_symbol(item) and item.get("side") in ("CALL", "PUT")
            and isinstance(item.get("underlying"), str) and valid_time(item.get("expiryDate"))
            and (number(item.get("strikePrice")) or 0) > 0
            for item in data["optionSymbols"]
        )
    elif name == "index":
        valid = isinstance(data, dict) and (number(data.get("indexPrice")) or 0) > 0
    elif name in ("mark", "ticker"):
        fields = ("markPrice", "markIV", "delta", "gamma", "theta", "vega") if name == "mark" else ("bidPrice", "askPrice", "lastPrice", "volume", "amount")
        valid = isinstance(data, list) and all(valid_symbol(item) and numeric_fields(item, fields) and
            (name != "ticker" or item.get("closeTime") is None or valid_time(item["closeTime"])) for item in data)
    elif name == "depth":
        valid = isinstance(data, dict) and all(isinstance(data.get(side), list) and all(
            isinstance(level, list) and len(level) >= 2 and all(number(value) is not None for value in level[:2])
            for level in data[side]) for side in ("bids", "asks"))
    if valid and name in ("exchange_info", "mark", "ticker"):
        items = data["optionSymbols"] if name == "exchange_info" else data
        valid = len({item["symbol"] for item in items}) == len(items)
    if not valid:
        result["ok"] = False
        result.pop("data", None)
        result["error"] = {"type": "UNEXPECTED_SCHEMA", "phase": "validation", "retryable": False, "message": "接口返回结构与预期不同。"}


def contract_trading_metadata(contract):
    """Keep exchangeInfo decimals as supplied; absent/invalid metadata stays unknown.

    Rates are ratios, not percentages. LOT_SIZE governs quantity increments and
    maximum size; a similarly named PRICE_FILTER field must not supply them.
    No default margin or liquidation rate is assumed for any contract.
    """
    def finite_original(value):
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            return None
        try:
            return value if Decimal(str(value)).is_finite() else None
        except (InvalidOperation, ValueError, OverflowError):
            return None

    rates = {
        "initialMargin": "initial_margin_rate",
        "minInitialMargin": "min_initial_margin_rate",
        "maintenanceMargin": "maintenance_margin_rate",
        "minMaintenanceMargin": "min_maintenance_margin_rate",
        "liquidationFeeRate": "liquidation_fee_rate",
    }
    metadata = {field: finite_original(contract.get(wire)) for wire, field in rates.items()}
    filters = contract.get("filters")
    lots = [item for item in filters if isinstance(item, dict) and item.get("filterType") == "LOT_SIZE"] if isinstance(filters, list) else []
    # Duplicate LOT_SIZE definitions are ambiguous; do not silently choose one.
    lot = lots[0] if len(lots) == 1 else {}
    metadata["quantity_step"] = finite_original(lot.get("stepSize"))
    metadata["max_qty"] = finite_original(lot.get("maxQty"))
    return metadata


def rows_from_data(endpoints, now_ms, args):
    info = endpoints.get("exchange_info", {}).get("data", {})
    index = number(endpoints.get("index", {}).get("data", {}).get("indexPrice"))
    marks = {item["symbol"]: item for item in endpoints.get("mark", {}).get("data", [])}
    tickers = {item["symbol"]: item for item in endpoints.get("ticker", {}).get("data", [])}
    rows = []
    total = 0
    for contract in info.get("optionSymbols", []):
        if contract.get("underlying") != "BTCUSDT" or contract.get("status", "TRADING") != "TRADING":
            continue
        expiry = number(contract.get("expiryDate"))
        strike = number(contract.get("strikePrice"))
        if expiry is None or strike is None or expiry <= now_ms:
            continue
        total += 1
        days = (expiry - now_ms) / 86400000
        side = contract.get("side")
        if args.side != "ALL" and side != args.side:
            continue
        if not args.min_days <= days <= args.max_days:
            continue
        otm = (100 * (1 - strike / index) if side == "PUT" else 100 * (strike / index - 1)) if index else None
        if args.min_otm is not None and (otm is None or otm < args.min_otm):
            continue
        if args.max_otm is not None and (otm is None or otm > args.max_otm):
            continue
        symbol = contract["symbol"]
        mark, ticker = marks.get(symbol, {}), tickers.get(symbol, {})
        last_trade = number(ticker.get("closeTime"))
        rows.append({
            "symbol": symbol, "side": side, "expiry_beijing": timestamp_ms(expiry),
            "days_to_expiry": round(days, 6), "strike_price": contract.get("strikePrice"),
            "otm_pct": round(otm, 6) if otm is not None else None,
            "unit": contract.get("unit"), "min_qty": contract.get("minQty"),
            **contract_trading_metadata(contract),
            "status": contract.get("status"), "bid_price": ticker.get("bidPrice"),
            "ask_price": ticker.get("askPrice"), "last_price": ticker.get("lastPrice"),
            "mark_price": mark.get("markPrice"), "mark_iv": mark.get("markIV"),
            "delta": mark.get("delta"), "gamma": mark.get("gamma"),
            "theta": mark.get("theta"), "vega": mark.get("vega"),
            "volume_24h_contracts": ticker.get("volume"), "amount_24h_quote": ticker.get("amount"),
            "quote_asset": contract.get("quoteAsset"),
            "last_trade_beijing": timestamp_ms(last_trade) if last_trade and last_trade > 0 else None,
            "has_mark": symbol in marks, "has_ticker": symbol in tickers,
        })
    rows.sort(key=lambda row: (row["expiry_beijing"], float(row["strike_price"]), row["side"]))
    return rows, total, index


def report(snapshot, limit):
    rows = snapshot["options"]
    lines = [
        "# 币安 BTC 期权行情测试", "",
        "- 测试时间（北京时间）：" + snapshot["generated_at_beijing"],
        "- 状态：" + snapshot["status"],
        "- BTC 指数价格（USDT）：" + str(snapshot.get("btc_index_price") or "未取得"),
        "- 有效 BTC 合约：%s；筛选后：%s" % (snapshot["btc_contracts_total"], len(rows)),
        "- 未使用凭据，未测试密钥有效性或账户权限。", "",
        "| 接口 | HTTP | 结果 |", "|---|---:|---|",
    ]
    for name, endpoint in snapshot["endpoints"].items():
        message = "成功" if endpoint["ok"] else endpoint.get("error", {}).get("message", "失败")
        lines.append("| %s | %s | %s |" % (name, endpoint.get("http_status", "—"), str(message).replace("|", "/").replace("\n", " ")))
    lines.extend(["", "表格展示前 %s 条，完整筛选结果见 CSV / JSON。" % limit, "",
                  "| 合约 | 剩余天数 | 行权价 | 买一 | 卖一 | 标记价 | IV（原值） | Delta | 24h 成交量（张） |",
                  "|---|---:|---:|---:|---:|---:|---:|---:|---:|"])
    for row in rows[:limit]:
        values = [row[key] for key in ("symbol", "days_to_expiry", "strike_price", "bid_price", "ask_price", "mark_price", "mark_iv", "delta", "volume_24h_contracts")]
        lines.append("| " + " | ".join("—" if value is None else str(value) for value in values) + " |")
    lines.extend(["", "买一是买方报价，卖一是卖方报价；标记价、最近成交价不能当作保证成交的价格。",
                  "零报价或缺失值不表示可成交。IV 保留 API 原值，0.50 对应 50%。Greeks 保留原值，不转换单位。",
                  "各接口分别请求，快照不是同一毫秒的原子快照。last_trade_beijing 是 ticker 的最近成交时间，并非盘口更新时间。",
                  "otm_pct：Put 为 (1 − K/S) × 100；Call 为 (K/S − 1) × 100；负值表示实值。",
                  "这次测试只证明公开行情访问情况，不证明账户具有卖开仓资格。",
                  "", "官方行情文档：[Binance Options Market Data](" + DOCS + ")", ""])
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="读取币安 BTC 期权公开行情，无需 API 密钥。")
    parser.add_argument("--side", choices=("ALL", "PUT", "CALL"), default="ALL")
    parser.add_argument("--min-days", type=float, default=0)
    parser.add_argument("--max-days", type=float, default=10000)
    parser.add_argument("--min-otm", type=float, help="虚值幅度下限，百分数，例如 20")
    parser.add_argument("--max-otm", type=float, help="虚值幅度上限，百分数，例如 30")
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--preview", type=int, default=10)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parent / "market_data")
    args = parser.parse_args()
    if not all(math.isfinite(value) for value in (args.min_days, args.max_days, args.timeout)) or not 0 <= args.min_days <= args.max_days or args.timeout <= 0 or args.preview < 1:
        parser.error("期限、超时或预览行数无效。")
    if any(value is not None and not math.isfinite(value) for value in (args.min_otm, args.max_otm)) or (args.min_otm is not None and args.max_otm is not None and args.min_otm > args.max_otm):
        parser.error("虚值幅度筛选范围无效。")

    started = time.monotonic()
    print("正在访问币安期权公开行情接口（无需密钥）...", flush=True)
    endpoints = {"time": get_public("/eapi/v1/time", args.timeout)}
    validate_response("time", endpoints["time"])
    if endpoints["time"]["ok"]:
        requests = [
            ("exchange_info", "/eapi/v1/exchangeInfo", None),
            ("index", "/eapi/v1/index", {"underlying": "BTCUSDT"}),
            ("mark", "/eapi/v1/mark", None),
            ("ticker", "/eapi/v1/ticker", None),
        ]
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [(name, pool.submit(get_public, path, args.timeout, params)) for name, path, params in requests]
            for name, future in futures:
                endpoints[name] = future.result()
                validate_response(name, endpoints[name])
    # Failed schemas must not be joined into apparently valid rows.
    usable = {name: value for name, value in endpoints.items() if value["ok"]}
    server_ms = usable.get("time", {}).get("data", {}).get("serverTime")
    now_ms = int(server_ms) + int((time.monotonic() - started) * 1000) if server_ms is not None else int(time.time() * 1000)
    rows, total, index = rows_from_data(usable, now_ms, args)
    if rows and index:
        sample = min(rows, key=lambda row: (row["days_to_expiry"], abs(float(row["strike_price"]) - index), row["side"]))
        endpoints["depth"] = get_public("/eapi/v1/depth", args.timeout, {"symbol": sample["symbol"], "limit": 20})
        endpoints["depth"]["symbol"] = sample["symbol"]
        validate_response("depth", endpoints["depth"])
    complete = len(endpoints) >= 5 and all(value["ok"] for value in endpoints.values()) and total > 0 and all(row["has_mark"] and row["has_ticker"] for row in rows)
    snapshot = {
        "generated_at_beijing": datetime.now(BEIJING).isoformat(timespec="seconds"),
        "status": "SUCCESS" if complete else ("PARTIAL" if total else "FAILED"),
        "credentials_used": False, "credential_validity_tested": False,
        "filters": {key: getattr(args, key) for key in ("side", "min_days", "max_days", "min_otm", "max_otm")},
        "btc_index_price": index, "btc_contracts_total": total,
        "selected_contracts": len(rows), "endpoints": endpoints, "options": rows,
    }
    # Raw responses retain only BTC data for the three all-symbol endpoints.
    for name in ("mark", "ticker"):
        if name in usable:
            endpoints[name]["data"] = [item for item in endpoints[name]["data"] if item["symbol"].startswith("BTC-")]
    if "exchange_info" in usable:
        endpoints["exchange_info"]["data"]["optionSymbols"] = [item for item in endpoints["exchange_info"]["data"]["optionSymbols"] if item.get("underlying") == "BTCUSDT"]
    args.output_dir.mkdir(parents=True, exist_ok=True)
    prefix = "btc_options_" + datetime.now(BEIJING).strftime("%Y%m%d_%H%M%S_%f")
    json_path, csv_path, md_path = [args.output_dir / (prefix + suffix) for suffix in (".json", ".csv", ".md")]
    json_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    with csv_path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    md_path.write_text(report(snapshot, args.preview), encoding="utf-8")
    print("状态：%s；BTC 指数价：%s USDT；有效合约：%s；筛选后：%s" % (snapshot["status"], index, total, len(rows)))
    for name, endpoint in endpoints.items():
        print("  %s: %s" % (name, "OK" if endpoint["ok"] else str(endpoint.get("error"))))
    for row in rows[:args.preview]:
        print("  %s  天数=%s  买一=%s  卖一=%s  标记价=%s  IV=%s" % tuple(row[key] for key in ("symbol", "days_to_expiry", "bid_price", "ask_price", "mark_price", "mark_iv")))
    for path in (json_path, csv_path, md_path):
        print(path.resolve())
    return 0 if complete else 1


if __name__ == "__main__":
    # Keep Chinese diagnostics readable in Windows terminals and captured output.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("已取消。", file=sys.stderr)
        sys.exit(130)
