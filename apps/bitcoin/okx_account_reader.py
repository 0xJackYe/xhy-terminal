"""Read-only OKX balances over fixed, verified HTTPS endpoints.

The client deliberately exposes no generic trading API.  Monetary values remain
decimal strings; trading ``totalEq`` already includes its currency equities and
must not be added to ``cashBal`` or to those equities a second time.

Official field definitions: https://www.okx.com/docs-v5/en/
Credentials are supplied in memory by the local encrypted credential service.
No account identifiers, raw response bodies or provider error messages leave
this module.  ``opener`` / clocks are injectable solely for offline tests.
"""

import base64
import calendar
import datetime as dt
from decimal import Decimal, InvalidOperation, localcontext
import hashlib
import hmac
import http.client
import json
import math
import re
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request
import urllib.parse

from okx_btc_history import (HistoryValidationError, build_btc_history,
                             normalize_btc_bill, timestamp as history_timestamp)


ORIGIN = "https://www.okx.com"
TIME_PATH = "/api/v5/public/time"
CONFIG_PATH = "/api/v5/account/config"
TRADING_PATH = "/api/v5/account/balance"
FUNDING_PATH = "/api/v5/asset/balances"
BTC_PRICE_PATH = "/api/v5/market/ticker?instId=BTC-USDT"
SPOT_TICKERS_PATH = "/api/v5/market/tickers?instType=SPOT"
TRADING_BILLS_PATH = "/api/v5/account/bills-archive"
FUNDING_BILLS_PATH = "/api/v5/asset/bills-history"
FUNDING_RECENT_BILLS_PATH = "/api/v5/asset/bills"
_PRIVATE_PATHS = frozenset((CONFIG_PATH, TRADING_PATH, FUNDING_PATH))
_PUBLIC_PATHS = frozenset((TIME_PATH, BTC_PRICE_PATH, SPOT_TICKERS_PATH))
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_ASSETS = 2000
TOTAL_TIMEOUT = 28.0
SOCKET_TIMEOUT = 8.0
HISTORY_TIMEOUT = 50.0
HISTORY_MAX_PAGES = 12
HISTORY_PAGE_SIZE = 100


def _history_path_allowed(path):
    """Only BTC bills with tightly bounded numeric filters, no generic API."""
    if not isinstance(path, str) or len(path) > 300:
        return False
    base, separator, query = path.partition("?")
    if not separator or base not in {TRADING_BILLS_PATH, FUNDING_BILLS_PATH, FUNDING_RECENT_BILLS_PATH}:
        return False
    try:
        pairs = urllib.parse.parse_qsl(query, keep_blank_values=True, strict_parsing=True)
    except ValueError:
        return False
    values = dict(pairs)
    if len(values) != len(pairs) or values.get("ccy") != "BTC" or values.get("limit") != "100":
        return False
    required, allowed = {"ccy", "limit"}, {"ccy", "limit", "after"}
    if base == TRADING_BILLS_PATH:
        required |= {"begin", "end"}
        allowed |= {"begin", "end"}
    elif base == FUNDING_BILLS_PATH:
        required |= {"pagingType"}
        allowed |= {"pagingType"}
        if values.get("pagingType") not in {"1", "2"}:
            return False
        if values["pagingType"] == "1" and "after" not in values:
            return False
    if not required <= set(values) <= allowed:
        return False
    return all(key in {"ccy", "limit", "pagingType"}
               or re.fullmatch(r"[0-9]{1,30}", value) for key, value in pairs)


class OKXReadError(Exception):
    """Public-safe failure.  ``code``, ``message`` and ``status`` are local."""

    def __init__(self, code, message, status=502):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # urllib otherwise forwards OK-ACCESS-* to the redirect destination.
        raise OKXReadError("redirect_rejected", "欧易接口返回了不支持的重定向。")


def _verified_opener():
    context = ssl.create_default_context()
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    return urllib.request.build_opener(
        _NoRedirect(), urllib.request.HTTPSHandler(context=context))


def _bad_response():
    return OKXReadError("invalid_response", "欧易账户数据格式异常，未更新资产。")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _decimal(value, required=False):
    """Validate without rounding, coercing booleans or erasing signed debt."""
    if value is None or value == "":
        if required:
            raise _bad_response()
        return None
    if not isinstance(value, str) or len(value) > 160:
        raise _bad_response()
    if not re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value):
        raise _bad_response()
    try:
        result = Decimal(value)
        if not result.is_finite() or len(result.as_tuple().digits) > 100:
            raise _bad_response()
        return format(result, "f")
    except InvalidOperation:
        raise _bad_response() from None


def _timestamp_ms(value, required=False):
    if value is None or value == "":
        if required:
            raise _bad_response()
        return None
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,16}", value):
        raise _bad_response()
    return value


def _currency(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Z0-9][A-Z0-9.-]{0,31}", value):
        raise _bad_response()
    return value


def normalize_trading(data):
    """Normalize the sole account balance object; do not sum cash and equity."""
    if (not isinstance(data, list) or len(data) != 1
            or not isinstance(data[0], dict)):
        raise _bad_response()
    row = data[0]
    details = row.get("details")
    if not isinstance(details, list) or len(details) > MAX_ASSETS:
        raise _bad_response()
    assets, currencies = [], set()
    for detail in details:
        if not isinstance(detail, dict):
            raise _bad_response()
        currency = _currency(detail.get("ccy"))
        if currency in currencies:
            raise _bad_response()
        currencies.add(currency)
        assets.append({
            "currency": currency,
            "equity": _decimal(detail.get("eq")),
            "cash_balance": _decimal(detail.get("cashBal")),
            "available": _decimal(detail.get("availBal")),
            "liabilities": _decimal(detail.get("liab")),
            "unrealized_pnl": _decimal(detail.get("upl")),
            "equity_usd": _decimal(detail.get("eqUsd")),
            "updated_at_ms": _timestamp_ms(detail.get("uTime")),
        })
    return {
        "total_equity_usd": _decimal(row.get("totalEq"), required=True),
        "updated_at_ms": _timestamp_ms(row.get("uTime")),
        "assets": sorted(assets, key=lambda item: item["currency"]),
    }


def normalize_funding(data):
    """Funding bal is the total; availBal and frozenBal are its components."""
    if not isinstance(data, list) or len(data) > MAX_ASSETS:
        raise _bad_response()
    assets, currencies = [], set()
    for detail in data:
        if not isinstance(detail, dict):
            raise _bad_response()
        currency = _currency(detail.get("ccy"))
        if currency in currencies:
            raise _bad_response()
        currencies.add(currency)
        assets.append({
            "currency": currency,
            "balance": _decimal(detail.get("bal"), required=True),
            "available": _decimal(detail.get("availBal")),
            "frozen": _decimal(detail.get("frozenBal")),
        })
    return {"assets": sorted(assets, key=lambda item: item["currency"])}


def value_cash_assets(account, spot_tickers=None, price_reference_ms=None):
    """Value observable cash net of liabilities, excluding derivative UPL.

    Official trading ``eqUsd / eq`` supplies each currency's current USD unit
    reference.  A single public SPOT snapshot can supply funding-only symbols
    quoted in USDT, but only when an observed USDT/USD reference exists.  No
    stablecoin is assumed to equal one USD; unknown values stay None.
    """
    try:
        trading = {row["currency"]: row for row in account["trading"]["assets"]}
        funding = {row["currency"]: row for row in account["funding"]["assets"]}
        quantities, prices, sources = {}, {}, {}
        with localcontext() as ctx:
            ctx.prec = 220
            for ccy in set(trading) | set(funding):
                trow, frow = trading.get(ccy), funding.get(ccy)
                cash = Decimal(trow["cash_balance"]) if trow and trow.get("cash_balance") is not None else (Decimal(0) if trow is None else None)
                debt = Decimal(trow["liabilities"]) if trow and trow.get("liabilities") is not None else (Decimal(0) if trow is None else None)
                fqty = Decimal(frow["balance"]) if frow else Decimal(0)
                tqty = cash - debt if cash is not None and debt is not None else None
                quantities[ccy] = (tqty, fqty, tqty + fqty if tqty is not None else None)
                if trow and trow.get("equity") is not None and trow.get("equity_usd") is not None:
                    eq, usd = Decimal(trow["equity"]), Decimal(trow["equity_usd"])
                    if eq > 0 and usd > 0:
                        prices[ccy], sources[ccy] = usd / eq, "OKX_trading_eqUsd_per_eq"
            # USD itself is the calculation unit; this is not a USDT/USDC peg.
            if "USD" in quantities:
                prices["USD"], sources["USD"] = Decimal(1), "USD_unit"
            if spot_tickers is not None:
                if not isinstance(spot_tickers, list) or len(spot_tickers) > 5000:
                    raise _bad_response()
                usdt_usd = prices.get("USDT")
                wanted = {ccy + "-USDT": ccy for ccy in quantities if ccy not in prices and ccy != "USDT"}
                seen, blocked = set(), set()
                now_ms = int(account["server_time_ms"]) if price_reference_ms is None else price_reference_ms
                if isinstance(now_ms, bool) or not isinstance(now_ms, int):
                    raise _bad_response()
                for row in spot_tickers:
                    if not isinstance(row, dict) or row.get("instId") not in wanted:
                        continue
                    inst_id = row["instId"]
                    ccy = wanted[inst_id]
                    if inst_id in seen:
                        blocked.add(ccy)
                        prices.pop(ccy, None)
                        sources.pop(ccy, None)
                        continue
                    seen.add(inst_id)
                    try:
                        last = Decimal(_decimal(row.get("last"), required=True))
                        at_ms = int(_timestamp_ms(row.get("ts"), required=True))
                    except OKXReadError:
                        continue
                    if usdt_usd is not None and last > 0 and now_ms - 120000 <= at_ms <= now_ms + 5000:
                        prices[ccy], sources[ccy] = last * usdt_usd, "OKX_SPOT_USDT_x_observed_USDT_USD"
                for ccy in blocked:
                    prices.pop(ccy, None)
                    sources.pop(ccy, None)
            assets, unpriced = [], []
            for ccy in sorted(quantities):
                tqty, fqty, qty = quantities[ccy]
                price = prices.get(ccy)
                # A zero holding is valued at zero without inventing a quote.
                value = Decimal(0) if qty == 0 else qty * price if qty is not None and price is not None else None
                if value is None:
                    unpriced.append(ccy)
                assets.append({"ccy": ccy, "quantity": format(qty, "f") if qty is not None else None,
                    "trading_quantity": format(tqty, "f") if tqty is not None else None,
                    "funding_quantity": format(fqty, "f"),
                    "usd_value": format(value, "f") if value is not None else None,
                    "price_usd": format(price, "f") if price is not None else None,
                    "price_source": sources.get(ccy)})
            known = sum((Decimal(row["usd_value"]) for row in assets if row["usd_value"] is not None), Decimal(0))
            return {"exchange": "OKX", "observed_at": account["observed_at"],
                "server_time_ms": account["server_time_ms"], "assets": assets,
                "known_value_usd": format(known, "f"),
                "total_value_usd": format(known, "f") if not unpriced else None,
                "complete": not unpriced,
                "scope": {"included": ["trading_cash_net_liabilities", "funding"],
                          "excluded": ["unrealized_derivative_pnl", "earn", "subaccounts", "classic"],
                          "valuation_currency": "USD", "unpriced_currencies": unpriced}}
    except (KeyError, TypeError, ValueError, InvalidOperation):
        raise _bad_response() from None


def _permissions(data):
    if (not isinstance(data, list) or len(data) != 1
            or not isinstance(data[0], dict)):
        raise _bad_response()
    raw = data[0].get("perm")
    if raw is None or raw == "":
        return {"verified": False, "read_only": None}
    if not isinstance(raw, str) or len(raw) > 100:
        raise _bad_response()
    permissions = {part.strip() for part in raw.split(",")}
    if permissions != {"read_only"}:
        raise OKXReadError("read_only_required", "请使用仅含读取权限的欧易 API Key。", 400)
    return {"verified": True, "read_only": True}


def _provider_error(code):
    if code in {"50102", "50112"}:
        return OKXReadError("clock_error", "欧易请求时间校验失败，请检查本机时间后重试。")
    if code == "50105":
        return OKXReadError("passphrase_invalid", "欧易 API Passphrase 不匹配。", 400)
    if code in {"50103", "50104", "50106", "50111", "50113", "50114", "50119"}:
        return OKXReadError("credentials_invalid", "欧易 API 凭证校验失败，请检查配置。", 400)
    if code == "50110":
        return OKXReadError("ip_restricted", "当前网络地址不在欧易 API IP 白名单内。", 403)
    if code in {"50011", "50040", "50061"}:
        return OKXReadError("rate_limited", "欧易请求达到频率限制，稍后自动重试。", 429)
    if code == "50120":
        return OKXReadError("permission_denied", "欧易 API 没有读取该账户的权限。", 403)
    return OKXReadError("provider_error", "欧易暂时无法提供账户数据，稍后重试。")


def _read_body(response, deadline, monotonic):
    # HTTPResponse.read(n) can wait indefinitely while a slow peer keeps feeding
    # bytes before each socket timeout. read1 performs at most one underlying
    # buffered read, allowing the whole-operation deadline to be checked between
    # chunks. The finite socket timeout bounds any individual network read.
    read_chunk = getattr(response, "read1", None) or response.read
    parts, total = [], 0
    while True:
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise OKXReadError("timeout", "欧易账户查询超时，稍后重试。", 504)
        # urllib's HTTPResponse owns a BufferedReader backed by this socket.
        # Reduce the timeout as the deadline approaches; custom test responses
        # need not expose a socket.
        raw_socket = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
        if raw_socket is not None:
            raw_socket.settimeout(min(SOCKET_TIMEOUT, remaining))
        chunk = read_chunk(min(64 * 1024, MAX_RESPONSE_BYTES + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_RESPONSE_BYTES:
            raise _bad_response()
        parts.append(chunk)
    return b"".join(parts)


class OKXReadOnlyClient:
    """Read-only balance/config and strictly filtered BTC bill GET endpoints."""

    def __init__(self, credentials, opener=None, clock=time.time,
                 monotonic=time.monotonic, timeout=SOCKET_TIMEOUT, sleeper=time.sleep):
        if not isinstance(credentials, dict):
            raise OKXReadError("credentials_missing", "请先配置欧易只读 API 凭证。", 400)
        copied = {}
        for key in ("api_key", "secret_key", "passphrase"):
            value = credentials.get(key)
            if (not isinstance(value, str) or not value or len(value) > 256
                    or any(ord(char) < 33 or ord(char) > 126 for char in value)):
                message = ("请填写创建欧易 API 时设置的 Passphrase。" if key == "passphrase"
                           else "请先配置完整的欧易只读 API 凭证。")
                raise OKXReadError("credentials_missing", message, 400)
            copied[key] = value
        if (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
                or not math.isfinite(timeout) or not 0 < timeout <= SOCKET_TIMEOUT):
            raise ValueError("invalid timeout")
        self._credentials = copied
        self._opener = opener if opener is not None else _verified_opener()
        self._clock = clock
        self._monotonic = monotonic
        self._timeout = float(timeout)
        self._offset = 0.0
        self._lock = threading.RLock()
        self._sleep = sleeper

    def _request(self, path, authenticated, deadline):
        approved = _PRIVATE_PATHS if authenticated else _PUBLIC_PATHS
        if path not in approved and not (authenticated and _history_path_allowed(path)):
            raise OKXReadError("endpoint_rejected", "不支持此欧易接口。", 400)
        remaining = deadline - self._monotonic()
        if remaining <= 0:
            raise OKXReadError("timeout", "欧易账户查询超时，稍后重试。", 504)
        headers = {"Accept": "application/json", "User-Agent": "BitcoinDashboardReadOnly/1.0"}
        if authenticated:
            timestamp = dt.datetime.fromtimestamp(
                self._clock() + self._offset, dt.timezone.utc
            ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            message = (timestamp + "GET" + path).encode("utf-8")
            signature = base64.b64encode(hmac.new(
                self._credentials["secret_key"].encode("utf-8"),
                message, hashlib.sha256).digest()).decode("ascii")
            headers.update({
                "OK-ACCESS-KEY": self._credentials["api_key"],
                "OK-ACCESS-PASSPHRASE": self._credentials["passphrase"],
                "OK-ACCESS-SIGN": signature,
                "OK-ACCESS-TIMESTAMP": timestamp,
            })
        url = ORIGIN + path
        request = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with self._opener.open(request, timeout=min(self._timeout, remaining)) as response:
                if response.geturl() != url:
                    raise OKXReadError("redirect_rejected", "欧易接口返回了不支持的重定向。")
                status = response.getcode()
                if 300 <= status < 400:
                    raise OKXReadError("redirect_rejected", "欧易接口返回了不支持的重定向。")
                if status == 429:
                    raise _provider_error("50011")
                if status != 200:
                    raise OKXReadError("http_error", "欧易账户接口暂时不可用。", status if 400 <= status < 500 else 502)
                raw = _read_body(response, deadline, self._monotonic)
            if self._monotonic() > deadline:
                raise OKXReadError("timeout", "欧易账户查询超时，稍后重试。", 504)
            payload = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                                 parse_constant=lambda unused: (_ for _ in ()).throw(ValueError()))
            if not isinstance(payload, dict) or not isinstance(payload.get("code"), str):
                raise _bad_response()
            if payload["code"] != "0":
                raise _provider_error(payload["code"])
            if not isinstance(payload.get("data"), list):
                raise _bad_response()
            return payload["data"]
        except OKXReadError:
            raise
        except urllib.error.HTTPError as exc:
            status = exc.code
            exc.close()
            if 300 <= status < 400:
                raise OKXReadError("redirect_rejected", "欧易接口返回了不支持的重定向。") from None
            if status == 429:
                raise _provider_error("50011") from None
            if status in {401, 403}:
                raise OKXReadError("access_denied", "欧易拒绝访问，请检查凭证、IP 白名单和账户地区。", 403) from None
            raise OKXReadError("http_error", "欧易账户接口暂时不可用。", status if 400 <= status < 500 else 502) from None
        except (socket.timeout, TimeoutError):
            raise OKXReadError("timeout", "欧易账户查询超时，稍后重试。", 504) from None
        except (urllib.error.URLError, OSError, http.client.HTTPException):
            raise OKXReadError("network_error", "无法连接欧易账户接口，请检查网络后重试。") from None
        except (ValueError, TypeError, UnicodeError, OverflowError):
            raise _bad_response() from None

    def _sync_time(self, deadline, request=None):
        before_wall = self._clock()
        before_mono = self._monotonic()
        data = (request or self._request)(TIME_PATH, False, deadline)
        after_mono = self._monotonic()
        if len(data) != 1 or not isinstance(data[0], dict):
            raise _bad_response()
        timestamp = _timestamp_ms(data[0].get("ts"), required=True)
        server_seconds = int(timestamp) / 1000.0
        if not 1577836800 <= server_seconds <= 4102444800:
            raise _bad_response()
        # Midpoint compensates the public time request's round-trip delay.
        self._offset = server_seconds - (before_wall + (after_mono - before_mono) / 2.0)
        return timestamp

    def _request_resilient(self, path, authenticated, deadline):
        """Retry a transient read once, inside the same operation deadline.

        Authentication and permission failures need configuration changes;
        retrying them would only consume the account's request allowance.
        Rate limits are left to the owning service's longer backoff.
        """
        try:
            return self._request(path, authenticated, deadline)
        except OKXReadError as exc:
            if exc.code not in {'network_error', 'timeout', 'http_error', 'provider_error'} or exc.status < 500:
                raise
            if deadline - self._monotonic() <= 1:
                raise
            self._sleep(0.25)
            return self._request(path, authenticated, deadline)

    def read_wallet_snapshot(self):
        """Read one account inventory and value those exact same quantities.

        The live wallet and portfolio share this result. Optional price lookup
        failure cannot erase a successfully read account inventory.
        """
        with self._lock:
            deadline = self._monotonic() + TOTAL_TIMEOUT
            account = self._read_account(deadline, self._request_resilient)
            if not account['permissions']['verified']:
                raise OKXReadError('permissions_unverified', '欧易只读权限尚未核实，暂不汇总资产。', 400)
            result = value_cash_assets(account)
            if result['scope']['unpriced_currencies']:
                try:
                    tickers = self._request_resilient(SPOT_TICKERS_PATH, False, deadline)
                    result = value_cash_assets(account, tickers,
                        price_reference_ms=int((self._clock() + self._offset) * 1000))
                except OKXReadError as exc:
                    result['price_error'] = {'code': exc.code, 'message': exc.message}
            return {'account': account, 'valuation': result}

    def _read_account(self, deadline, request=None):
        request = request or self._request
        server_time = self._sync_time(deadline, request)
        permissions = _permissions(request(CONFIG_PATH, True, deadline))
        trading = normalize_trading(request(TRADING_PATH, True, deadline))
        funding = normalize_funding(request(FUNDING_PATH, True, deadline))
        observed = dt.datetime.fromtimestamp(
            self._clock() + self._offset, dt.timezone.utc
        ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        return {"exchange": "OKX", "observed_at": observed,
                "server_time_ms": server_time, "permissions": permissions,
                "trading": trading, "funding": funding}

    def read_account(self):
        """Read complete trading + funding snapshots, or fail atomically.

        No retries are hidden here.  The owning service controls polling/backoff
        and keeps the last successful snapshot visibly stale after failures.
        """
        with self._lock:
            deadline = self._monotonic() + TOTAL_TIMEOUT
            return self._read_account(deadline)

    def get_btc_price(self):
        """Optional public BTC-USDT reference, never used as a USD peg."""
        with self._lock:
            data = self._request(BTC_PRICE_PATH, False, self._monotonic() + self._timeout)
            if (len(data) != 1 or not isinstance(data[0], dict)
                    or data[0].get("instId") != "BTC-USDT"):
                raise _bad_response()
            price = _decimal(data[0].get("last"), required=True)
            if Decimal(price) <= 0:
                raise _bad_response()
            return {"price_usdt": price,
                    "timestamp_ms": _timestamp_ms(data[0].get("ts"), required=True)}

    def read_valued_assets(self):
        """Optional whole-coin cash portfolio; leave read_account unchanged.

        Run this low-frequency operation on its own client so public quote
        fallback cannot block the live account poll or the options market.
        """
        with self._lock:
            deadline = self._monotonic() + TOTAL_TIMEOUT
            account = self.read_account()
            if not account["permissions"]["verified"]:
                raise OKXReadError("permissions_unverified", "欧易只读权限尚未核实，暂不汇总资产。", 400)
            result = value_cash_assets(account)
            if result["scope"]["unpriced_currencies"]:
                # Request at most one public tickers snapshot for all held
                # symbols.  If it fails, retain known balances/values and mark
                # other values unavailable instead of presenting zeros.
                try:
                    tickers = self._request(SPOT_TICKERS_PATH, False, deadline)
                    result = value_cash_assets(account, tickers,
                        price_reference_ms=int((self._clock() + self._offset) * 1000))
                except OKXReadError as exc:
                    result["price_error"] = {"code": exc.code, "message": exc.message}
            return result

    def _btc_bill_pages(self, base, account, start_ms, anchor_ms, deadline):
        # Use bill-ID paging from the first archived funding page.  Timestamp
        # ordering does not define order within the same millisecond, so
        # switching from timestamp paging midway could omit boundary records.
        events, after, paging_type = [], None, "2"
        last_call, previous_key = None, None
        interval = 1.05 if base == FUNDING_BILLS_PATH else (0.45 if account == "trading" else 0.2)
        for page_index in range(HISTORY_MAX_PAGES):
            if last_call is not None:
                pause = max(0, interval - (self._monotonic() - last_call))
                if self._monotonic() + pause >= deadline:
                    return events, False, "history_timeout"
                if pause:
                    self._sleep(pause)
            query = [("ccy", "BTC"), ("limit", "100")]
            if account == "trading":
                query.extend([("begin", str(start_ms)), ("end", str(anchor_ms + 1))])
                if after is not None:
                    query.append(("after", after))
            else:
                if base == FUNDING_BILLS_PATH:
                    query.append(("pagingType", paging_type))
                    if after is not None:
                        query.append(("after", after))
                else:
                    query.append(("after", after if after is not None else str(anchor_ms + 1)))
            path = base + "?" + urllib.parse.urlencode(query)
            last_call = self._monotonic()
            rows = self._request(path, True, deadline)
            if len(rows) > HISTORY_PAGE_SIZE:
                raise _bad_response()
            if not rows:
                return events, True, None
            normalized = [normalize_btc_bill(row, account) for row in rows]
            # Funding API can return equal-ts rows in either ID order.  A
            # same-ms tie is not corrupted chronology.  Validate decreasing
            # timestamps in provider order, then sort the tie deterministically.
            if any(a["at_ms"] < b["at_ms"] for a, b in zip(normalized, normalized[1:])):
                raise HistoryValidationError("invalid_chronology")
            normalized.sort(key=lambda row: (row["at_ms"], int(row["id"])), reverse=True)
            keys = [(row["at_ms"], int(row["id"])) for row in normalized]
            # Reject reversed pages, repeated/nonprogressing cursors and changed
            # records; exact duplicates across *different* sources merge later.
            if (any(a <= b for a, b in zip(keys, keys[1:]))
                    or any(int(a["id"]) <= int(b["id"]) for a, b in zip(normalized, normalized[1:]))):
                raise HistoryValidationError("invalid_chronology")
            if previous_key is not None and (keys[0] >= previous_key or keys[0][1] >= previous_key[1]):
                raise HistoryValidationError("nonprogressing_page")
            if base != FUNDING_BILLS_PATH and any(row["at_ms"] > anchor_ms for row in normalized):
                raise HistoryValidationError("future_bill")
            events.extend(row for row in normalized if start_ms <= row["at_ms"] <= anchor_ms)
            if keys[-1][0] < start_ms or len(rows) < HISTORY_PAGE_SIZE:
                return events, True, None
            previous_key = keys[-1]
            if base == FUNDING_RECENT_BILLS_PATH:
                # This endpoint offers timestamp-only pagination.  A full page
                # can split one millisecond: never silently skip the remainder.
                # The archive's bill-ID pagination supplies the complete older
                # range, while recent is only a freshness bridge.
                return events, False, "recent_page_saturated"
            after = normalized[-1]["id"]
            paging_type = "2"
        return events, False, "page_limit"

    def read_btc_history(self, start_ms, end_ms):
        """Read bounded BTC cash ledgers; use a separate client from live poll.

        No POST, trading, transfers, withdrawals or CSV downloads.  The trading
        API limits coverage to three calendar months.  Returned coverage is the
        actual queried interval, never an invented older balance.  Snapshot
        balance reconciliation exposes provider lag/in-flight transfers as an
        incomplete history instead of silently fabricating past holdings.
        """
        try:
            start_ms, end_ms = history_timestamp(start_ms), history_timestamp(end_ms)
            if start_ms > end_ms:
                raise HistoryValidationError("invalid_interval")
            with self._lock:
                deadline = self._monotonic() + HISTORY_TIMEOUT
                self._sync_time(deadline)
                permissions = _permissions(self._request(CONFIG_PATH, True, deadline))
                if not permissions["verified"]:
                    raise OKXReadError("permissions_unverified", "欧易只读权限尚未核实，暂不回补历史。", 400)
                trading = normalize_trading(self._request(TRADING_PATH, True, deadline))
                funding = normalize_funding(self._request(FUNDING_PATH, True, deadline))
                anchor_ms = int((self._clock() + self._offset) * 1000)
                now = dt.datetime.fromtimestamp(anchor_ms / 1000, dt.timezone.utc)
                month_index = now.year * 12 + now.month - 1 - 3
                year, month_zero = divmod(month_index, 12)
                month = month_zero + 1
                floor = now.replace(year=year, month=month,
                                    day=min(now.day, calendar.monthrange(year, month)[1]))
                coverage_start = max(start_ms, int(floor.timestamp() * 1000) + 60000)
                coverage_end = min(end_ms, anchor_ms)
                if coverage_start > coverage_end:
                    return {"coverage_start_ms": coverage_start, "coverage_end_ms": coverage_end,
                            "events": [], "complete": False, "reason": "outside_history_window"}
                closing, debt = {}, False
                for account, assets in (("trading", trading["assets"]), ("funding", funding["assets"])):
                    btc = next((row for row in assets if row["currency"] == "BTC"), None)
                    if btc is None:
                        closing[account] = "0"
                    elif account == "trading":
                        if btc["cash_balance"] is None or btc["liabilities"] is None:
                            raise HistoryValidationError("unknown_cash_or_debt")
                        closing[account] = btc["cash_balance"]
                        debt = Decimal(btc["liabilities"]) != 0
                    else:
                        closing[account] = btc["balance"]
                trading_events, trading_ok, trading_reason = self._btc_bill_pages(
                    TRADING_BILLS_PATH, "trading", coverage_start, anchor_ms, deadline)
                funding_events, funding_ok, funding_reason = self._btc_bill_pages(
                    FUNDING_BILLS_PATH, "funding", coverage_start, anchor_ms, deadline)
                recent_events, recent_ok, recent_reason = self._btc_bill_pages(
                    FUNDING_RECENT_BILLS_PATH, "funding", coverage_start, anchor_ms, deadline)
                # A saturated recent page is safe only if all its records also
                # appear in the fully exhausted ID-paginated funding archive.
                if not recent_ok and recent_reason == "recent_page_saturated" and funding_ok:
                    archived_ids = {row["id"] for row in funding_events}
                    recent_ok = all(row["id"] in archived_ids for row in recent_events)
                complete = trading_ok and funding_ok and recent_ok and not debt
                reason = ("unsupported_debt_history" if debt else
                          (trading_reason if not trading_ok else funding_reason if not funding_ok
                           else recent_reason if not recent_ok else None))
                result = build_btc_history(trading_events + funding_events + recent_events,
                    coverage_start, coverage_end, anchor_ms, closing, complete, reason)
                result["requested_start_ms"] = start_ms
                result["requested_end_ms"] = end_ms
                return result
        except HistoryValidationError:
            raise OKXReadError("history_invalid", "欧易 BTC 历史记录未通过完整性校验，暂不回补。") from None
