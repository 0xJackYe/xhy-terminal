"""Bounded, fixed-route Binance Options read-only access diagnostics.

No order, transfer, permission, user-stream creation or other write API exists.
Callers must encrypt the financial ``data`` returned by probe_account; public
acceptance reports should retain only safe_diagnostics(result).
"""
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import hmac
import json
import math
import re
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request

from binance_wallet import (_verified_opener, _unique_object, _bad_constant,
                            validate_read_only_permissions, BinanceWalletError)


ROUTES = {
    'wallet_time': ('https://api.binance.com', '/api/v3/time', False),
    'options_time': ('https://eapi.binance.com', '/eapi/v1/time', False),
    'permissions': ('https://api.binance.com', '/sapi/v1/account/apiRestrictions', True),
    'margin_account': ('https://eapi.binance.com', '/eapi/v1/marginAccount', True),
    'positions': ('https://eapi.binance.com', '/eapi/v1/position', True),
    'open_orders': ('https://eapi.binance.com', '/eapi/v1/openOrders', True),
    'portfolio_account': ('https://api.binance.com', '/sapi/v1/portfolio/account', True),
}
MAX_BYTES = 4 * 1024 * 1024
MESSAGES = {
    'credentials_invalid': '本机币安凭据格式不完整。',
    'invalid_config': '只读连接配置无效。',
    'closed': '只读连接已关闭。',
    'route_rejected': '只允许固定的账户只读接口。',
    'read_only_required': 'API 必须仅启用读取权限。',
    'permission_denied': '交易所拒绝此产品的读取，请检查产品权限及 IP 限制。',
    'account_not_enabled': '交易所返回账户尚未开通或不支持该账户模式。',
    'route_unavailable': '此接口当前不可用。',
    'rate_limited': '交易所限流，暂停本次探测。',
    'clock_error': '请求时间校验失败。',
    'invalid_response': '交易所响应格式不完整。',
    'redirect_rejected': '交易所重定向已拒绝。',
    'timeout': '只读查询超时。',
    'network_error': '只读查询暂时无法连接。',
    'exchange_error': '交易所返回读取错误。',
}


class OptionsReadError(Exception):
    def __init__(self, code, *, http_status=None, exchange_code=None):
        self.code = code if code in MESSAGES else 'exchange_error'
        self.message = MESSAGES[self.code]
        self.http_status = http_status if type(http_status) is int else None
        self.exchange_code = exchange_code if type(exchange_code) is int else None
        super().__init__(self.message)

    def __repr__(self):
        return 'OptionsReadError(%r, http_status=%r, exchange_code=%r)' % (
            self.code, self.http_status, self.exchange_code)

    def diagnostic(self):
        return {'status': self.code, 'http_status': self.http_status,
                'exchange_code': self.exchange_code, 'message': self.message}


def _finite(value):
    if (not isinstance(value, str) or len(value) > 160
            or re.fullmatch(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?', value) is None):
        raise OptionsReadError('invalid_response')
    try:
        decimal = Decimal(value)
    except InvalidOperation:
        raise OptionsReadError('invalid_response') from None
    if not decimal.is_finite():
        raise OptionsReadError('invalid_response')
    return decimal


def validate_account(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get('asset'), list):
        raise OptionsReadError('invalid_response')
    if len(payload['asset']) > 100:
        raise OptionsReadError('invalid_response')
    seen = set()
    for row in payload['asset']:
        if not isinstance(row, dict) or re.fullmatch(r'[A-Z0-9]{1,20}', str(row.get('asset', ''))) is None:
            raise OptionsReadError('invalid_response')
        if row['asset'] in seen:
            raise OptionsReadError('invalid_response')
        seen.add(row['asset'])
        for field in ('marginBalance', 'equity', 'available', 'initialMargin', 'maintMargin',
                      'unrealizedPNL', 'adjustedEquity'):
            _finite(row.get(field))
        if _finite(row['maintMargin']) < 0 or _finite(row['initialMargin']) < 0:
            raise OptionsReadError('invalid_response')
    return payload


def validate_positions(payload):
    if not isinstance(payload, list) or len(payload) > 10000:
        raise OptionsReadError('invalid_response')
    for row in payload:
        if (not isinstance(row, dict) or
                re.fullmatch(r'[A-Z0-9._]+-[0-9]{6}-[0-9.]+-[CP]', str(row.get('symbol', ''))) is None):
            raise OptionsReadError('invalid_response')
        quantity = _finite(row.get('quantity'))
        if row.get('side') not in ('LONG', 'SHORT'):
            raise OptionsReadError('invalid_response')
        if quantity < 0 and row['side'] != 'SHORT' or quantity > 0 and row['side'] != 'LONG':
            raise OptionsReadError('invalid_response')
        for field in ('entryPrice', 'markValue', 'unrealizedPNL', 'initialMargin', 'maintenanceMargin'):
            if field in row:
                _finite(row[field])
    return payload


class BinanceOptionsReadClient:
    def __init__(self, api_key, secret_key, *, opener=None, clock=None,
                 monotonic=None, socket_timeout=6.0, total_timeout=40.0):
        if any(not isinstance(value, str) or re.fullmatch('[A-Za-z0-9]{64}', value) is None
               for value in (api_key, secret_key)):
            raise OptionsReadError('credentials_invalid')
        if any(type(value) not in (int, float) or not math.isfinite(value)
               for value in (socket_timeout, total_timeout)) or not 0 < socket_timeout <= 15 or not 1 <= total_timeout <= 60:
            raise OptionsReadError('invalid_config')
        self._key, self._secret = api_key, secret_key.encode('ascii')
        self._opener = opener if opener is not None else _verified_opener()
        self._clock, self._monotonic = clock or time.time, monotonic or time.monotonic
        self._socket_timeout, self._total_timeout = socket_timeout, total_timeout
        self._offsets, self._closed = {}, False

    def __repr__(self):
        return 'BinanceOptionsReadClient(closed=%r)' % self._closed

    def close(self):
        self._key, self._secret, self._closed = None, None, True

    def _once(self, route, deadline):
        if self._closed:
            raise OptionsReadError('closed')
        if route not in ROUTES:
            raise OptionsReadError('route_rejected')
        origin, path, signed = ROUTES[route]
        headers = {'Accept': 'application/json', 'User-Agent': 'BitcoinTerminal-ReadOnly/1'}
        query = ''
        if signed:
            query = urlencode([('recvWindow', 5000),
                ('timestamp', int(self._clock() * 1000) + self._offsets.get(origin, 0))])
            query += '&signature=' + hmac.new(self._secret, query.encode('ascii'), hashlib.sha256).hexdigest()
            headers['X-MBX-APIKEY'] = self._key
        remaining = deadline - self._monotonic()
        if remaining <= 0:
            raise OptionsReadError('timeout')
        request = Request(origin + path + ('?' + query if query else ''), headers=headers, method='GET')
        status, raw = None, b''
        try:
            with self._opener.open(request, timeout=min(self._socket_timeout, remaining)) as response:
                status, raw = response.getcode(), response.read(MAX_BYTES + 1)
        except HTTPError as error:
            status = error.code
            try:
                raw = error.read(MAX_BYTES + 1)
            except Exception:
                raw = b''
            finally:
                error.close()
        except TimeoutError:
            raise OptionsReadError('timeout') from None
        except Exception:
            raise OptionsReadError('network_error') from None
        if status is not None and 300 <= status < 400:
            raise OptionsReadError('redirect_rejected', http_status=status)
        if status in (418, 429):
            raise OptionsReadError('rate_limited', http_status=status)
        try:
            if len(raw) > MAX_BYTES:
                raise ValueError('oversize')
            payload = json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_bad_constant)
        except Exception:
            raise OptionsReadError('invalid_response', http_status=status) from None
        code = payload.get('code') if isinstance(payload, dict) else None
        code = code if type(code) is int else None
        if status == 200 and (code is None or code >= 0):
            return payload
        if code == -1021:
            failure = 'clock_error'
        elif code in (-2014, -2015, -1002, -5002, -5005, -5008, -5009) or status in (401, 403):
            failure = 'permission_denied'
        elif code in (-21001, -4080):
            failure = 'account_not_enabled'
        elif status in (404, 405):
            failure = 'route_unavailable'
        elif status is not None and 500 <= status < 600:
            failure = 'network_error'
        else:
            failure = 'exchange_error'
        raise OptionsReadError(failure, http_status=status, exchange_code=code)

    def _sync(self, origin, deadline):
        before = self._clock() * 1000
        route = 'options_time' if origin == 'https://eapi.binance.com' else 'wallet_time'
        payload = self._once(route, deadline)
        after = self._clock() * 1000
        stamp = payload.get('serverTime') if isinstance(payload, dict) else None
        if type(stamp) is not int or not 0 < stamp < 8640000000000000 or not 0 <= after-before <= 15000:
            raise OptionsReadError('clock_error')
        self._offsets[origin] = round(stamp - (before + after) / 2)

    def _read(self, route, deadline):
        if route not in ROUTES or not ROUTES[route][2]:
            raise OptionsReadError('route_rejected')
        origin = ROUTES[route][0]
        if origin not in self._offsets:
            self._sync(origin, deadline)
        for attempt in range(2):
            try:
                return self._once(route, deadline)
            except OptionsReadError as error:
                if error.code == 'clock_error' and attempt == 0:
                    self._sync(origin, deadline)
                    continue
                if error.code in ('network_error', 'timeout') and attempt == 0 and self._monotonic() < deadline:
                    continue
                raise

    def probe_account(self):
        deadline = self._monotonic() + self._total_timeout
        result = {'observed_at': datetime.fromtimestamp(self._clock(), timezone.utc).isoformat(),
                  'read_only_verified': False, 'access': {}, 'data': {}}
        try:
            permissions = self._read('permissions', deadline)
            validate_read_only_permissions(permissions)
            result['read_only_verified'] = True
        except BinanceWalletError:
            result['access']['permissions'] = OptionsReadError('read_only_required').diagnostic()
            return result
        except OptionsReadError as error:
            result['access']['permissions'] = error.diagnostic()
            return result
        result['access']['permissions'] = {'status': 'connected', 'http_status': 200, 'exchange_code': None}
        for route in ('margin_account', 'positions', 'open_orders', 'portfolio_account'):
            try:
                payload = self._read(route, deadline)
                if route == 'margin_account':
                    validate_account(payload)
                elif route == 'positions':
                    validate_positions(payload)
                elif route == 'open_orders':
                    if not isinstance(payload, list) or len(payload) > 10000 or any(not isinstance(x, dict) for x in payload):
                        raise OptionsReadError('invalid_response')
                elif not isinstance(payload, dict) or payload.get('accountType') not in ('PM_1', 'PM_2', 'PM_3'):
                    raise OptionsReadError('invalid_response')
                result['access'][route] = {'status': 'connected', 'http_status': 200, 'exchange_code': None}
                result['data'][route] = payload
            except OptionsReadError as error:
                result['access'][route] = error.diagnostic()
                if error.code in ('rate_limited', 'timeout') and self._monotonic() >= deadline:
                    break
                if error.code == 'rate_limited':
                    break
        return result


def safe_diagnostics(result):
    """No position sizes, balances, account identity, keys or signed URLs."""
    positions = result.get('data', {}).get('positions')
    orders = result.get('data', {}).get('open_orders')
    portfolio = result.get('data', {}).get('portfolio_account')
    account = result.get('data', {}).get('margin_account')
    has_balances = isinstance(account, dict) and isinstance(account.get('asset'), list) and bool(account['asset'])
    return {'observed_at': result.get('observed_at'),
            'read_only_verified': result.get('read_only_verified') is True,
            'access': result.get('access', {}),
            'position_rows': len(positions) if isinstance(positions, list) else None,
            'open_order_rows': len(orders) if isinstance(orders, list) else None,
            'portfolio_account_type': portfolio.get('accountType') if isinstance(portfolio, dict) else None,
            'risk_data_complete': has_balances and all(result.get('access', {}).get(route, {}).get('status') == 'connected'
                for route in ('margin_account', 'positions', 'open_orders'))}
