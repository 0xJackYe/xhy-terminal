"""Strictly read-only Binance account transport. Python 3.9, standard library.

Secrets are supplied by the caller (prefer a local hidden input), never logged.
This module has no order, transfer, permission-changing, or arbitrary-URL API.
Official reference: https://developers.binance.com/en/docs/catalog/
core-trading-derivatives-trading-options/api/rest-api
"""

import hashlib
import hmac
import json
import math
import re
import ssl
import threading
import time
from email.utils import parsedate_to_datetime
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener


_REASONS = {
    "route": "只允许指定的币安只读接口。",
    "params": "只读接口参数无效。",
    "credentials": "请在本机提供有效的只读 API Key 和 Secret。",
    "config": "只读客户端配置无效。",
    "closed": "只读客户端已关闭。",
    "network": "币安只读连接暂时失败，请稍后重试。",
    "redirect": "已拒绝接口重定向，未转发凭据。",
    "format": "币安只读响应格式无效。",
    "clock": "币安请求时间校准失败。",
    "rate": "币安接口限流，已停止重试。",
    "permission": "币安拒绝只读访问，请检查密钥、IP 和读取权限。",
    "window": "币安仅支持查询指定的近期历史窗口。",
    "api": "币安只读请求失败。",
}


class ReadOnlyAPIError(Exception):
    """Carries only fixed text and validated numeric diagnostics, never a URL/body."""

    def __init__(self, reason="api", status=None, code=None, retry_after=None):
        self.reason = reason if type(reason) is str and reason in _REASONS else "api"
        self.status = status if type(status) is int and 100 <= status <= 599 else None
        self.http_status = self.status
        self.code = code if type(code) is int and -(2 ** 31) <= code < 2 ** 31 else None
        self.retry_after = (retry_after if type(retry_after) in (int, float)
                            and math.isfinite(retry_after) and 0 <= retry_after <= 7 * 86400 else None)
        super().__init__(_REASONS[self.reason])

    def __repr__(self):
        return ("ReadOnlyAPIError(reason=%r, status=%r, code=%r, retry_after=%r)"
                % (self.reason, self.status, self.code, self.retry_after))


# host, signed, request weight, allowed optional/required query fields.
_ROUTES = {
    "/eapi/v1/time": ("eapi.binance.com", False, 1, frozenset()),
    "/eapi/v1/position": ("eapi.binance.com", True, 5, frozenset(("symbol", "recvWindow"))),
    "/eapi/v1/marginAccount": ("eapi.binance.com", True, 3, frozenset(("recvWindow",))),
    "/eapi/v1/bill": ("eapi.binance.com", True, 1, frozenset(("currency", "recordId", "startTime", "endTime", "limit", "recvWindow"))),
    "/eapi/v1/userTrades": ("eapi.binance.com", True, 5, frozenset(("symbol", "fromId", "startTime", "endTime", "limit", "recvWindow"))),
    "/eapi/v1/exerciseRecord": ("eapi.binance.com", True, 5, frozenset(("symbol", "startTime", "endTime", "limit", "recvWindow"))),
    "/eapi/v1/commission": ("eapi.binance.com", True, 5, frozenset(("recvWindow",))),
    "/sapi/v1/account/apiRestrictions": ("api.binance.com", True, 1, frozenset(("recvWindow",))),
}
_SYMBOL = re.compile(r"[A-Z0-9]{2,24}-[0-9]{6}-[0-9]+(?:\.[0-9]+)?-[CP]\Z")
_MAX_BODY = 8 * 1024 * 1024


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _retry_after(headers):
    """Return seconds only; never retain an arbitrary server header value."""
    try:
        value = headers.get("Retry-After")
        if not isinstance(value, str) or len(value) > 128:
            return None
        if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value):
            seconds = float(value)
        else:
            seconds = parsedate_to_datetime(value).timestamp() - time.time()
        return min(7 * 86400, max(0, seconds)) if math.isfinite(seconds) else None
    except Exception:
        return None


def _validated_params(path, params):
    if params is None:
        params = {}
    if type(params) is not dict or any(type(key) is not str or key not in _ROUTES[path][3] for key in params):
        raise ReadOnlyAPIError("params")
    clean = {}
    for key, value in params.items():
        if value is None:
            continue
        if key == "symbol":
            if type(value) is not str or len(value) > 100 or _SYMBOL.fullmatch(value) is None:
                raise ReadOnlyAPIError("params")
        elif key == "currency":
            if type(value) is not str or value != "USDT":
                raise ReadOnlyAPIError("params")
        else:
            if type(value) is str and len(value) <= 20 and re.fullmatch(r"[0-9]+", value):
                value = int(value)
            maximum = 1000 if key == "limit" else 60000 if key == "recvWindow" else 2 ** 63 - 1
            minimum = 1 if key in ("limit", "recvWindow") else 0
            if type(value) is not int or not minimum <= value <= maximum:
                raise ReadOnlyAPIError("params")
        clean[key] = value
    if path == "/eapi/v1/bill" and "currency" not in clean:
        raise ReadOnlyAPIError("params")
    if path == "/eapi/v1/userTrades" and "symbol" not in clean:
        raise ReadOnlyAPIError("params")
    if "startTime" in clean and "endTime" in clean and clean["startTime"] > clean["endTime"]:
        raise ReadOnlyAPIError("params")
    return clean


class ReadOnlyBinanceClient:
    """Serialized GET-only client. No real request is made during construction.

    get(path, params=None) -> decoded JSON
    sync_time() -> local server clock offset in milliseconds
    close() drops credential references; it cannot guarantee Python memory erasure.
    """

    def __init__(self, api_key=None, api_secret=None, timeout=10):
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 60:
            raise ReadOnlyAPIError("config")
        if api_key is not None and (type(api_key) is not str or re.fullmatch(r"[A-Za-z0-9_-]{1,512}", api_key) is None):
            raise ReadOnlyAPIError("credentials")
        if api_secret is not None and (type(api_secret) is not str or re.fullmatch(r"[A-Za-z0-9_-]{1,4096}", api_secret) is None):
            raise ReadOnlyAPIError("credentials")
        self._api_key = api_key
        self._api_secret = api_secret.encode("utf-8") if api_secret is not None else None
        self._timeout = timeout
        self._offset_ms = 0
        self._last_request_timing = None
        self._next_request_at = 0.0
        self._lock = threading.RLock()
        self._closed = False
        self._opener = build_opener(_NoRedirect(), HTTPSHandler(context=ssl.create_default_context()))

    def __repr__(self):
        return "ReadOnlyBinanceClient(closed=%r)" % self._closed

    def _request_once(self, host, path, params, signed, weight):
        """All unsafe transport errors are consumed, not chained into public errors."""
        pause = self._next_request_at - time.monotonic()
        if pause > 0:
            time.sleep(pause)
        self._next_request_at = time.monotonic() + 0.35 * weight
        status, payload, retry_after, failure, raw = None, None, None, None, b""
        started_ms = None
        try:
            pairs = sorted(params.items())
            headers = {"Accept": "application/json", "User-Agent": "OptionsReadOnly/1"}
            if signed:
                pairs.append(("timestamp", int(time.time() * 1000) + self._offset_ms))
            query = urlencode(pairs)
            if signed:
                digest = hmac.new(self._api_secret, query.encode("ascii"), hashlib.sha256).hexdigest()
                query += "&signature=" + digest
                headers["X-MBX-APIKEY"] = self._api_key
            url = "https://" + host + path + ("?" + query if query else "")
            request = Request(url, headers=headers, method="GET")
            started_ms = time.time() * 1000
            with self._opener.open(request, timeout=self._timeout) as response:
                status = response.getcode()
                retry_after = _retry_after(response.headers)
                raw = response.read(_MAX_BODY + 1)
        except HTTPError as error:
            status = error.code if type(error.code) is int else None
            retry_after = _retry_after(error.headers)
            try:
                raw = error.read(_MAX_BODY + 1)
            except Exception:
                raw = b""
            finally:
                try:
                    error.close()
                except Exception:
                    pass
        except Exception:
            failure = "network"
        self._last_request_timing = (started_ms, time.time() * 1000)
        # Raise no exceptions inside the handlers above: __context__ must not
        # retain urllib errors whose URL includes a signature or an unsafe body.
        if status is not None and 300 <= status <= 399:
            failure = "redirect"
        elif failure is None:
            try:
                if len(raw) > _MAX_BODY:
                    failure = "format"
                else:
                    payload = json.loads(raw)
            except Exception:
                failure = "format"
        return status, payload, retry_after, failure

    def get(self, path, params=None):
        with self._lock:
            if self._closed:
                raise ReadOnlyAPIError("closed")
            if type(path) is not str or path not in _ROUTES:
                raise ReadOnlyAPIError("route")
            clean = _validated_params(path, params)
            host, signed, weight, _ = _ROUTES[path]
            if signed and (not self._api_key or not self._api_secret):
                raise ReadOnlyAPIError("credentials")
            transient_retries, calibrated = 0, False
            while True:
                status, payload, retry_after, failure = self._request_once(host, path, clean, signed, weight)
                code = payload.get("code") if isinstance(payload, dict) else None
                code = code if type(code) is int and -(2 ** 31) <= code < 2 ** 31 else None
                if status in (418, 429):
                    raise ReadOnlyAPIError("rate", status, code, retry_after)
                if failure == "redirect":
                    raise ReadOnlyAPIError("redirect", status, code)
                if signed and code == -1021 and not calibrated:
                    calibrated = True
                    self.sync_time()
                    continue
                transient = failure == "network" or (status is not None and 500 <= status <= 599)
                if transient and transient_retries < 2:
                    time.sleep(0.5 * (2 ** transient_retries))
                    transient_retries += 1
                    continue
                if code == -1021:
                    reason = "clock"
                elif code in (-2014, -2015, -1002) or status in (401, 403):
                    reason = "permission"
                elif code == -6073:
                    reason = "window"
                elif transient:
                    reason = "network"
                elif failure:
                    reason = failure
                elif status is None or not 200 <= status <= 299 or (code is not None and code < 0):
                    reason = "api"
                else:
                    return payload
                raise ReadOnlyAPIError(reason, status, code)

    def sync_time(self):
        with self._lock:
            payload = self.get("/eapi/v1/time")
            server = payload.get("serverTime") if isinstance(payload, dict) else None
            if type(server) is not int or not 0 < server < 253402300800000:
                raise ReadOnlyAPIError("clock")
            # Exclude local rate-limit sleeps and earlier retry attempts from
            # the midpoint used to estimate the server clock offset.
            began, ended = self._last_request_timing
            self._offset_ms = int(server - (began + ended) / 2)
            return self._offset_ms

    def close(self):
        with self._lock:
            self._api_key = None
            self._api_secret = None
            self._opener = None
            self._closed = True

