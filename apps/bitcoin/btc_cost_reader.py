"""Atomic, read-only OKX SPOT bills for the local BTC cost ledger.

Both currency legs are returned.  The tracker, rather than this transport,
interprets trades and merges bill IDs.  No trading, transfer or arbitrary URL
method exists; credentials are used only in HTTPS request headers.
"""

import base64
import calendar
import datetime as dt
import hashlib
import hmac
import http.client
import json
import math
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from okx_account_reader import (
    OKXReadError, _currency, _decimal, _permissions, _provider_error,
    _read_body, _unique_object, _verified_opener,
)


ORIGIN = "https://www.okx.com"
TIME_PATH = "/api/v5/public/time"
CONFIG_PATH = "/api/v5/account/config"
BILLS_PATH = "/api/v5/account/bills-archive"
PAGE_SIZE = 100
REQUEST_INTERVAL = 0.42  # At most five request starts in any two seconds.
SOCKET_TIMEOUT = 8.0
TOTAL_TIMEOUT = 120.0
MAX_PAGES = 200
_NUMBER = re.compile(r"[0-9]{1,30}\Z")
_FIELDS = frozenset((
    "instType", "billId", "subType", "ts", "balChg", "posBalChg", "bal",
    "posBal", "sz", "px", "ccy", "pnl", "fee", "mgnMode", "instId",
    "ordId", "execType", "interest", "fillTime", "tradeId", "fillIdxPx",
    "fillMarkPx", "fillPxVol", "fillPxUsd", "fillMarkVol", "fillFwdPx",
    "type", "earnAmt", "earnApr",
))
_DECIMAL_FIELDS = frozenset((
    "balChg", "posBalChg", "bal", "posBal", "sz", "px", "pnl", "fee",
    "interest", "fillIdxPx", "fillMarkPx", "fillPxVol", "fillPxUsd",
    "fillMarkVol", "fillFwdPx", "earnAmt", "earnApr",
))


def _error(code="history_invalid", status=502):
    messages = {
        "history_invalid": "欧易成本账单未通过完整性校验，保留上次记录。",
        "outside_history_window": "欧易成本账单超出近三个月范围，需要补齐历史账单。",
        "page_limit": "欧易成本账单超过单次查询上限，保留上次记录。",
        "timeout": "欧易成本账单查询超时，稍后重试。",
        "closed": "欧易成本账单连接已关闭。",
        "invalid_interval": "欧易成本账单查询起点无效。",
        "permissions_unverified": "欧易只读权限尚未核实，暂不更新成本账单。",
    }
    return OKXReadError(code, messages[code], status)


def _path_allowed(path, authenticated):
    if not isinstance(path, str) or len(path) > 300:
        return False
    if path == TIME_PATH:
        return not authenticated
    if path == CONFIG_PATH:
        return authenticated
    base, separator, query = path.partition("?")
    if not authenticated or base != BILLS_PATH or not separator:
        return False
    try:
        pairs = urllib.parse.parse_qsl(query, keep_blank_values=True, strict_parsing=True)
    except ValueError:
        return False
    values = dict(pairs)
    if len(values) != len(pairs):
        return False
    if set(values) not in ({"instType", "begin", "end", "limit"},
                           {"instType", "begin", "end", "limit", "after"}):
        return False
    if values["instType"] != "SPOT" or values["limit"] != str(PAGE_SIZE):
        return False
    if not all(_NUMBER.fullmatch(values[key]) for key in ("begin", "end")):
        return False
    if not 0 < int(values["begin"]) <= int(values["end"]) < 4102444800001:
        return False
    return "after" not in values or bool(_NUMBER.fullmatch(values["after"]) and int(values["after"]) > 0)


def _three_month_floor(anchor_ms):
    now = dt.datetime.fromtimestamp(anchor_ms / 1000, dt.timezone.utc)
    month_index = now.year * 12 + now.month - 1 - 3
    year, zero_month = divmod(month_index, 12)
    month = zero_month + 1
    floor = now.replace(year=year, month=month,
                        day=min(now.day, calendar.monthrange(year, month)[1]))
    return int(floor.timestamp() * 1000)


def _bill(row, begin_ms, anchor_ms):
    if not isinstance(row, dict) or row.get("instType") != "SPOT":
        raise _error()
    result = {}
    for key, value in row.items():
        if key not in _FIELDS:
            continue
        if not isinstance(value, str) or len(value) > 160:
            raise _error()
        result[key] = value
    for key in ("billId", "ts", "subType"):
        if not _NUMBER.fullmatch(result.get(key, "")):
            raise _error()
    if int(result["billId"]) <= 0 or not begin_ms <= int(result["ts"]) <= anchor_ms:
        raise _error()
    try:
        _currency(result.get("ccy"))
        for key in _DECIMAL_FIELDS & result.keys():
            if result[key] != "":
                _decimal(result[key], required=True)
        if result["subType"] in {"1", "2", "318", "319"}:
            for key in ("sz", "px", "fee", "balChg"):
                _decimal(result.get(key), required=True)
            if not re.fullmatch(r"[A-Z0-9][A-Z0-9.-]{0,79}", result.get("instId", "")):
                raise _error()
        for key in ("ordId", "tradeId", "fillTime"):
            if result.get(key, "") and not _NUMBER.fullmatch(result[key]):
                raise _error()
    except OKXReadError:
        raise _error() from None
    return result


class BTCCostReader:
    """One bounded full-history read; local callers own persistence/backoff."""

    def __init__(self, credentials, opener=None, clock=time.time,
                 monotonic=time.monotonic, timeout=SOCKET_TIMEOUT,
                 sleeper=time.sleep, total_timeout=TOTAL_TIMEOUT, max_pages=MAX_PAGES):
        if not isinstance(credentials, dict):
            raise OKXReadError("credentials_missing", "请先配置欧易只读 API 凭证。", 400)
        self._credentials = {}
        for key in ("api_key", "secret_key", "passphrase"):
            value = credentials.get(key)
            if (not isinstance(value, str) or not value or len(value) > 256
                    or any(ord(char) < 33 or ord(char) > 126 for char in value)):
                raise OKXReadError("credentials_missing", "请先配置完整的欧易只读 API 凭证。", 400)
            self._credentials[key] = value
        for value, upper in ((timeout, SOCKET_TIMEOUT), (total_timeout, 300)):
            if (isinstance(value, bool) or not isinstance(value, (int, float))
                    or not math.isfinite(value) or not 0 < value <= upper):
                raise ValueError("invalid timeout")
        if isinstance(max_pages, bool) or not isinstance(max_pages, int) or not 1 <= max_pages <= 1000:
            raise ValueError("invalid page limit")
        self._opener = opener if opener is not None else _verified_opener()
        self._clock, self._monotonic, self._sleep = clock, monotonic, sleeper
        self._timeout, self._total_timeout = float(timeout), float(total_timeout)
        self._max_pages = max_pages
        self._offset, self._last_call = 0.0, None
        self._lock, self._closed = threading.RLock(), False

    def _pause(self, seconds, deadline):
        remaining = deadline - self._monotonic()
        if seconds >= remaining:
            raise _error("timeout", 504)
        if seconds > 0:
            self._sleep(seconds)
        if self._monotonic() >= deadline:
            raise _error("timeout", 504)

    def _request(self, path, authenticated, deadline):
        if self._closed:
            raise _error("closed", 400)
        if not _path_allowed(path, authenticated):
            raise OKXReadError("endpoint_rejected", "不支持此欧易成本查询接口。", 400)
        if self._last_call is not None:
            self._pause(max(0.0, REQUEST_INTERVAL - (self._monotonic() - self._last_call)), deadline)
        remaining = deadline - self._monotonic()
        if remaining <= 0:
            raise _error("timeout", 504)
        headers = {"Accept": "application/json", "User-Agent": "BitcoinDashboardCostReadOnly/1.0"}
        if authenticated:
            timestamp = dt.datetime.fromtimestamp(self._clock() + self._offset,
                dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            signature = base64.b64encode(hmac.new(self._credentials["secret_key"].encode(),
                (timestamp + "GET" + path).encode(), hashlib.sha256).digest()).decode("ascii")
            headers.update({"OK-ACCESS-KEY": self._credentials["api_key"],
                "OK-ACCESS-PASSPHRASE": self._credentials["passphrase"],
                "OK-ACCESS-SIGN": signature, "OK-ACCESS-TIMESTAMP": timestamp})
        url = ORIGIN + path
        request = urllib.request.Request(url, headers=headers, method="GET")
        try:
            self._last_call = self._monotonic()
            with self._opener.open(request, timeout=min(remaining, self._timeout)) as response:
                if response.geturl() != url or 300 <= response.getcode() < 400:
                    raise OKXReadError("redirect_rejected", "欧易成本接口重定向已被拒绝。")
                status = response.getcode()
                if status == 429:
                    raise _provider_error("50011")
                if status != 200:
                    raise OKXReadError("http_error", "欧易成本接口暂时不可用。", status if 400 <= status < 500 else 502)
                raw = _read_body(response, deadline, self._monotonic)
            if self._monotonic() >= deadline:
                raise _error("timeout", 504)
            payload = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                parse_constant=lambda unused: (_ for _ in ()).throw(ValueError()))
            if not isinstance(payload, dict) or not isinstance(payload.get("code"), str):
                raise _error()
            if payload["code"] != "0":
                raise _provider_error(payload["code"])
            if not isinstance(payload.get("data"), list):
                raise _error()
            return payload["data"]
        except OKXReadError:
            raise
        except urllib.error.HTTPError as exc:
            status = exc.code
            exc.close()
            if 300 <= status < 400:
                raise OKXReadError("redirect_rejected", "欧易成本接口重定向已被拒绝。") from None
            if status == 429:
                raise _provider_error("50011") from None
            if status in {401, 403}:
                raise OKXReadError("access_denied", "欧易拒绝访问，请检查凭证和 IP 白名单。", 403) from None
            raise OKXReadError("http_error", "欧易成本接口暂时不可用。", status if 400 <= status < 500 else 502) from None
        except (socket.timeout, TimeoutError):
            raise _error("timeout", 504) from None
        except (urllib.error.URLError, OSError, http.client.HTTPException):
            raise OKXReadError("network_error", "欧易成本接口连接失败，稍后重试。") from None
        except (ValueError, TypeError, UnicodeError, OverflowError):
            raise _error() from None

    def _resilient(self, path, authenticated, deadline, allow_clock_sync=True):
        network_retries = rate_retries = 0
        while True:
            try:
                return self._request(path, authenticated, deadline)
            except OKXReadError as exc:
                if exc.code == "clock_error" and authenticated and allow_clock_sync:
                    allow_clock_sync = False
                    self._sync_time(deadline)
                    continue
                if exc.code == "rate_limited" and rate_retries < 2:
                    rate_retries += 1
                    self._pause(float(rate_retries), deadline)
                    continue
                if (exc.code in {"network_error", "timeout", "http_error"}
                        and exc.status >= 500 and network_retries < 1):
                    network_retries += 1
                    self._pause(0.5, deadline)
                    continue
                raise

    def _sync_time(self, deadline):
        before_wall, before_mono = self._clock(), self._monotonic()
        rows = self._resilient(TIME_PATH, False, deadline, allow_clock_sync=False)
        after_mono = self._monotonic()
        if len(rows) != 1 or not isinstance(rows[0], dict):
            raise _error()
        raw = rows[0].get("ts")
        if not isinstance(raw, str) or not _NUMBER.fullmatch(raw):
            raise _error()
        server_ms = int(raw)
        if not 1577836800000 <= server_ms <= 4102444800000:
            raise _error()
        self._offset = server_ms / 1000 - (before_wall + (after_mono - before_mono) / 2)
        return server_ms

    def read_since(self, start_ms):
        """Return a complete frozen interval or raise, never a partial page set.

        ``start_ms`` is inclusive. Re-reading an overlap is intentional: the
        owner merges immutable bill IDs so delayed provider records are caught.
        """
        if isinstance(start_ms, bool) or not isinstance(start_ms, int) or not 0 < start_ms < 4102444800001:
            raise _error("invalid_interval", 400)
        with self._lock:
            if self._closed:
                raise _error("closed", 400)
            deadline = self._monotonic() + self._total_timeout
            anchor_ms = self._sync_time(deadline)
            if start_ms > anchor_ms:
                raise _error("invalid_interval", 400)
            if start_ms < _three_month_floor(anchor_ms):
                raise _error("outside_history_window", 400)
            permissions = _permissions(self._resilient(CONFIG_PATH, True, deadline))
            if not permissions["verified"] or not permissions["read_only"]:
                raise _error("permissions_unverified", 400)
            result, seen, after, previous_ts = [], set(), None, None
            for unused in range(self._max_pages):
                query = [("instType", "SPOT"), ("begin", str(start_ms)),
                         ("end", str(anchor_ms)), ("limit", str(PAGE_SIZE))]
                if after is not None:
                    query.append(("after", str(after)))
                rows = self._resilient(BILLS_PATH + "?" + urllib.parse.urlencode(query), True, deadline)
                if len(rows) > PAGE_SIZE:
                    raise _error()
                for raw in rows:
                    row = _bill(raw, start_ms, anchor_ms)
                    identifier, at_ms = int(row["billId"]), int(row["ts"])
                    if identifier in seen or (after is not None and identifier >= after):
                        raise _error()
                    if previous_ts is not None and at_ms > previous_ts:
                        raise _error()
                    seen.add(identifier)
                    after, previous_ts = identifier, at_ms
                    result.append(row)
                if len(rows) < PAGE_SIZE:
                    return {"rows": result, "as_of_ms": anchor_ms,
                            "coverage_start_ms": start_ms, "complete": True}
            raise _error("page_limit")

    def close(self):
        """Forget the owned credential copy; safe to call more than once."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._credentials.clear()
            close = getattr(self._opener, "close", None)
            if close is not None:
                try:
                    close()
                except Exception:
                    pass
