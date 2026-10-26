"""Fixed-endpoint, read-only Binance wallet inventory. Python 3.9 stdlib.

Credentials stay in memory; the caller owns local encrypted storage. No generic
URL, order, transfer, withdrawal or settings API is exposed. Wallet ``balance``
and ``btcValuation`` are valuations, never evidence of BTC actually held.

Official schema (needBalanceDetail=true):
https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/asset
"""

from datetime import datetime, timezone
from decimal import Decimal, localcontext
import hashlib
import hmac
import json
import math
import re
import ssl
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener


ORIGIN = "https://api.binance.com"
TIME_PATH = "/api/v3/time"
PERMISSIONS_PATH = "/sapi/v1/account/apiRestrictions"
BALANCE_PATH = "/sapi/v1/asset/wallet/balance"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_WALLETS = 64
MAX_ASSETS = 5000
TOTAL_TIMEOUT = 28.0
SOCKET_TIMEOUT = 8.0
_PRIVATE_PATHS = frozenset((PERMISSIONS_PATH, BALANCE_PATH))
_MESSAGES = {
    "credentials_invalid": "请在本机填写配套的币安 API Key 和 Secret Key。",
    "read_only_required": "请使用仅有读取权限的币安 API，不启用交易、划转或提现权限。",
    "permission_denied": "币安拒绝读取，请检查 API、读取权限和 IP 白名单。",
    "invalid_response": "币安资产数据格式异常，未更新资产。",
    "network_error": "暂时无法连接币安，稍后重试。",
    "timeout": "币安查询超时，稍后重试。",
    "clock_error": "币安请求时间校验失败，请检查本机时间。",
    "rate_limited": "币安接口限流，稍后重试。",
    "redirect_rejected": "币安接口返回了不支持的重定向。",
    "closed": "币安只读连接已关闭。",
    "route_rejected": "只允许指定的币安资产读取接口。",
    "invalid_config": "币安只读连接配置无效。",
}
_UNSAFE_FLAGS = frozenset((
    "enableWithdrawals", "enableInternalTransfer", "enableMargin", "enableFutures",
    "permitsUniversalTransfer", "enableVanillaOptions", "enableFixApiTrade",
    "enableSpotAndMarginTrading", "enablePortfolioMarginTrading",
))


class BinanceWalletError(Exception):
    """Fixed diagnostics only; provider messages, URLs and keys are discarded."""

    def __init__(self, code="network_error", status=502):
        self.code = code if isinstance(code, str) and code in _MESSAGES else "network_error"
        self.message = _MESSAGES[self.code]
        self.status = status if type(status) is int and 400 <= status <= 599 else 502
        super().__init__(self.message)

    def __repr__(self):
        return "BinanceWalletError(code=%r, status=%r)" % (self.code, self.status)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _verified_opener():
    context = ssl.create_default_context()
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    return build_opener(_NoRedirect(), HTTPSHandler(context=context))


def _bad_response():
    return BinanceWalletError("invalid_response")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _bad_constant(value):
    raise ValueError("nonfinite constant")


def _decimal(value):
    if (not isinstance(value, str) or len(value) > 120
            or re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value) is None
            or sum(character.isdigit() for character in value) > 100):
        raise _bad_response()
    return Decimal(value)


def _text_decimal(value):
    if value == 0:
        return "0"
    result = format(value, "f")
    return result.rstrip("0").rstrip(".") if "." in result else result


def validate_read_only_permissions(payload):
    """Fail closed before balances; never change any exchange permissions."""
    if not isinstance(payload, dict) or payload.get("enableReading") is not True:
        raise BinanceWalletError("read_only_required", 403)
    for key, value in payload.items():
        unsafe = key in _UNSAFE_FLAGS or (isinstance(key, str)
                 and re.search(r"(?:trad(?:e|ing)|withdraw|transfer)", key, re.I)
                 and key.startswith(("enable", "permit")))
        if unsafe:
            if type(value) is not bool:
                raise _bad_response()
            if value:
                raise BinanceWalletError("read_only_required", 403)
    return True


def normalize_wallets(payload, observed_at=None):
    """Return per-wallet quantities without counting equivalent BTC as coins.

    Components are retained individually. ``quantity`` is free + locked; when
    freeze/withdrawing is nonzero and overlap is not documented, quantity is
    unavailable rather than guessed. A wallet-level equivalent balance does not
    repair absent per-asset detail. ``complete`` concerns the wallets returned
    by this endpoint, not every possible product or subaccount on Binance.
    """
    if not isinstance(payload, list) or not payload or len(payload) > MAX_WALLETS:
        raise _bad_response()
    assets, missing_wallets, names = [], [], set()
    if observed_at is None:
        observed_at = datetime.now(timezone.utc).isoformat()
    if not isinstance(observed_at, str) or len(observed_at) > 64:
        raise _bad_response()
    try:
        parsed = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
        valid_observation = parsed.tzinfo is not None and parsed.timestamp() > 0
    except (ValueError, OverflowError, OSError):
        valid_observation = False
    if not valid_observation:
        raise _bad_response()
    with localcontext() as context:
        context.prec = 220
        for wallet in payload:
            if not isinstance(wallet, dict):
                raise _bad_response()
            name, activated = wallet.get("walletName"), wallet.get("activate")
            if (not isinstance(name, str) or not name.strip() or len(name) > 80
                    or any(ord(c) < 32 for c in name) or name in names
                    or type(activated) is not bool):
                raise _bad_response()
            names.add(name)
            wallet_value = _decimal(wallet.get("balance"))
            details = wallet.get("assetBalances")
            if details is None:
                if wallet_value != 0 or activated:
                    missing_wallets.append(name)
                continue
            if not isinstance(details, list) or len(details) > MAX_ASSETS:
                raise _bad_response()
            if not details and wallet_value != 0:
                missing_wallets.append(name)
            currencies = set()
            for item in details:
                if not isinstance(item, dict):
                    raise _bad_response()
                currency = item.get("asset")
                if (not isinstance(currency, str)
                        or re.fullmatch(r"[A-Z0-9][A-Z0-9._-]{0,31}", currency) is None
                        or currency in currencies):
                    raise _bad_response()
                currencies.add(currency)
                fields, missing = {}, False
                for field in ("free", "locked", "freeze", "withdrawing"):
                    if field not in item or item[field] is None:
                        fields[field], missing = None, True
                    else:
                        fields[field] = _decimal(item[field])
                btc_value = _decimal(item["btcValuation"]) if item.get("btcValuation") is not None else None
                # Documentation does not establish whether these fields overlap
                # across all account types. Never silently double count them.
                ambiguous = any(fields[field] not in (None, Decimal(0))
                                for field in ("freeze", "withdrawing"))
                quantity = None if missing or ambiguous else fields["free"] + fields["locked"]
                if missing or ambiguous or btc_value is None:
                    missing_wallets.append(name)
                assets.append({"ccy": currency, "wallet": name,
                    "quantity": _text_decimal(quantity) if quantity is not None else None,
                    "btc_value": _text_decimal(btc_value) if btc_value is not None else None,
                    "usd_value": None,
                    "components": {field: _text_decimal(value) if value is not None else None
                                   for field, value in fields.items()},
                    "quantity_complete": quantity is not None,
                    "quantity_note": "冻结或提现字段的归属待核实，未估算合计。" if ambiguous else
                                     "币种数量字段不完整。" if missing else None})
            if len(assets) > MAX_ASSETS:
                raise _bad_response()
    return {"assets": assets, "complete": not missing_wallets,
            "missing_wallets": sorted(set(missing_wallets)), "wallets_count": len(payload),
            "observed_at": observed_at,
            "scope": "API 返回的主账户钱包；不承诺覆盖全部产品与子账户。"}


class BinanceWalletClient:
    """Credentials + fixed GET routes. Construction performs no network call."""

    def __init__(self, api_key=None, secret_key=None, *, opener=None, clock=None,
                 monotonic=None, timeout=SOCKET_TIMEOUT):
        for value in (api_key, secret_key):
            if (not isinstance(value, str)
                    or re.fullmatch(r"[A-Za-z0-9]{64}", value) is None):
                raise BinanceWalletError("credentials_invalid", 400)
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 20:
            raise BinanceWalletError("invalid_config", 400)
        self._api_key, self._secret = api_key, secret_key.encode("ascii")
        self._opener = opener if opener is not None else _verified_opener()
        self._clock, self._monotonic = clock or time.time, monotonic or time.monotonic
        self._timeout, self._offset_ms = timeout, 0
        self._closed, self._time_synced = False, False
        self._lock = threading.RLock()

    def __repr__(self):
        return "BinanceWalletClient(closed=%r)" % self._closed

    def close(self):
        with self._lock:
            self._closed, self._api_key, self._secret = True, None, None

    def _once(self, path, params, deadline):
        status, payload, failure, raw = None, None, None, b""
        headers = {"Accept": "application/json", "User-Agent": "BitcoinTerminal-ReadOnly/1"}
        pairs = sorted(params.items())
        if path in _PRIVATE_PATHS:
            pairs += [("timestamp", int(self._clock() * 1000) + self._offset_ms)]
        query = urlencode(pairs)
        if path in _PRIVATE_PATHS:
            query += "&signature=" + hmac.new(self._secret, query.encode("ascii"), hashlib.sha256).hexdigest()
            headers["X-MBX-APIKEY"] = self._api_key
        request = Request(ORIGIN + path + ("?" + query if query else ""), headers=headers, method="GET")
        remaining = deadline - self._monotonic()
        if remaining <= 0:
            return None, None, "timeout"
        try:
            with self._opener.open(request, timeout=min(self._timeout, remaining)) as response:
                status = response.getcode()
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as error:
            status = error.code if type(error.code) is int else None
            try:
                raw = error.read(MAX_RESPONSE_BYTES + 1)
            except Exception:
                raw = b""
            finally:
                try:
                    error.close()
                except Exception:
                    pass
        except (TimeoutError,):
            failure = "timeout"
        except Exception:
            failure = "network_error"
        if status is not None and 300 <= status < 400:
            return status, None, "redirect_rejected"
        if failure is None:
            try:
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise ValueError("oversize")
                payload = json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_bad_constant)
            except Exception:
                failure = "invalid_response"
        return status, payload, failure

    def _request(self, path, params, deadline, recalibrate=True):
        if self._closed:
            raise BinanceWalletError("closed", 400)
        if path == TIME_PATH:
            allowed = params == {}
        elif path == PERMISSIONS_PATH:
            allowed = params == {"recvWindow": 5000}
        elif path == BALANCE_PATH:
            allowed = params == {"needBalanceDetail": "true", "quoteAsset": "BTC", "recvWindow": 5000}
        else:
            allowed = False
        if not allowed:
            raise BinanceWalletError("route_rejected", 400)
        retries = 0
        while True:
            status, payload, failure = self._once(path, params, deadline)
            api_code = payload.get("code") if isinstance(payload, dict) else None
            if type(api_code) is not int:
                api_code = None
            if status in (418, 429):
                raise BinanceWalletError("rate_limited", 429)
            if failure == "redirect_rejected":
                raise BinanceWalletError("redirect_rejected")
            if api_code == -1021 and recalibrate and path in _PRIVATE_PATHS:
                self._sync_time(deadline)
                recalibrate = False
                continue
            transient = failure in ("network_error", "timeout") or status is not None and 500 <= status < 600
            if transient and retries < 1 and deadline > self._monotonic():
                retries += 1
                continue
            if api_code == -1021:
                raise BinanceWalletError("clock_error")
            if api_code in (-2014, -2015, -1002) or status in (401, 403):
                raise BinanceWalletError("permission_denied", 403)
            if failure:
                raise BinanceWalletError(failure)
            if status != 200 or api_code is not None and api_code < 0:
                raise BinanceWalletError("network_error")
            return payload

    def _sync_time(self, deadline):
        before = self._clock() * 1000
        payload = self._request(TIME_PATH, {}, deadline, recalibrate=False)
        after = self._clock() * 1000
        stamp = payload.get("serverTime") if isinstance(payload, dict) else None
        if type(stamp) is not int or not 0 < stamp < 8640000000000000 or after < before or after-before > 15000:
            raise BinanceWalletError("clock_error")
        self._offset_ms = round(stamp - (before+after)/2)
        self._time_synced = True

    def sync_time(self):
        with self._lock:
            self._sync_time(self._monotonic() + TOTAL_TIMEOUT)
            return self._offset_ms

    def fetch_balances(self):
        with self._lock:
            deadline = self._monotonic() + TOTAL_TIMEOUT
            if not self._time_synced:
                self._sync_time(deadline)
            permissions = self._request(PERMISSIONS_PATH, {"recvWindow": 5000}, deadline)
            validate_read_only_permissions(permissions)
            payload = self._request(BALANCE_PATH,
                {"needBalanceDetail": "true", "quoteAsset": "BTC", "recvWindow": 5000}, deadline)
            observed = datetime.fromtimestamp(self._clock(), timezone.utc).isoformat()
            return normalize_wallets(payload, observed)
