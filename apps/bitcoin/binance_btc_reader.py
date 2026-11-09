"""Bounded, resumable Binance BTC spot/Convert history; approved GETs only.

Spot uses fromId (inclusive) instead of a recent-date window. Convert is read
in windows no longer than 30 days. No order, quote acceptance or transfer
route is implemented. Credentials and provider error bodies never escape.

Official contracts:
https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account
https://developers.binance.com/en/docs/catalog/core-trading-convert/api/rest-api/trade
"""
import copy
from decimal import Decimal, localcontext
import hashlib
import hmac
import json
import math
import re
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request

from binance_wallet import (_verified_opener, _unique_object, _bad_constant,
                            validate_read_only_permissions, BinanceWalletError)

MINUTE = 60000
DAY = 86400000
CONVERT_WINDOW = 30 * DAY - 1
MARKETS = (('BTCUSDT', 'USDT', '01'), ('BTCUSDC', 'USDC', '02'),
           ('BTCFDUSD', 'FDUSD', '03'))
TIME = '/api/v3/time'
PERMISSIONS = '/sapi/v1/account/apiRestrictions'
TRADES = '/api/v3/myTrades'
CONVERT = '/sapi/v1/convert/tradeFlow'
KLINES = '/api/v3/klines'
_PRIVATE = frozenset((PERMISSIONS, TRADES, CONVERT))
_ASSET = re.compile(r'[A-Z0-9]{1,20}\Z')
_convert_lock = threading.Lock()
_convert_last = 0.0

_MESSAGES = {
    'credentials_invalid': '币安读取凭据不完整。',
    'read_only_required': '请使用仅有读取权限的币安 API。',
    'permission_denied': '币安拒绝读取成交历史，请检查权限和 IP 白名单。',
    'rate_limited': '币安成交接口限流，稍后自动重试。',
    'clock_error': '币安成交请求时间校验失败。',
    'network_error': '币安成交历史暂时无法连接。',
    'invalid_response': '币安成交历史未通过完整性校验。',
    'historical_rate_missing': '币安成交的历史分钟汇率尚未获取。',
    'route_rejected': '不支持此币安成交查询。',
    'closed': '币安成交连接已关闭。',
}


class BinanceBTCError(Exception):
    def __init__(self, code='invalid_response', status=502):
        self.code = code if code in _MESSAGES else 'invalid_response'
        self.status = status
        self.message = _MESSAGES[self.code]
        super().__init__(self.message)


class _Paused(Exception):
    pass


def _integer(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise BinanceBTCError()
    value = str(value)
    if re.fullmatch(r'\d{1,24}', value) is None:
        raise BinanceBTCError()
    return int(value)


def _amount(value):
    if not isinstance(value, str) or re.fullmatch(r'-?(?:0|[1-9]\d*)(?:\.\d+)?', value) is None or len(value) > 120:
        raise BinanceBTCError()
    result = Decimal(value)
    if not result.is_finite():
        raise BinanceBTCError()
    return result


def _text(value):
    if not value:
        return '0'
    value = format(value, 'f')
    return value.rstrip('0').rstrip('.') if '.' in value else value


def _bill(kind, code, identifier, leg):
    return '7' + kind + code + str(_integer(identifier)).zfill(20) + leg


def _rate(rates, currency, at_ms):
    if currency == 'USDT':
        return Decimal(1)
    value = rates.get(currency + ':' + str(at_ms // MINUTE * MINUTE))
    value = value.get('close') if isinstance(value, dict) else value
    try:
        rate = _amount(value)
    except Exception:
        raise BinanceBTCError('historical_rate_missing') from None
    if rate <= 0:
        raise BinanceBTCError('historical_rate_missing')
    return rate


def spot_rate_needs(raw, market):
    _, quote, _ = market
    result = {quote} if quote != 'USDT' else set()
    fee = _amount(raw.get('commission', '0'))
    fee_asset = raw.get('commissionAsset', '')
    if fee > 0 and fee_asset not in ('BTC', quote, 'USDT'):
        if not isinstance(fee_asset, str) or not _ASSET.fullmatch(fee_asset):
            raise BinanceBTCError()
        result.add(fee_asset)
    return sorted(result)


def normalize_spot(raw, market, rates=None):
    """Exactly the cloud book's fee/net-quantity convention, Decimal strings."""
    rates = rates or {}
    symbol, quote, code = market
    if not isinstance(raw, dict) or raw.get('symbol', symbol) != symbol or type(raw.get('isBuyer')) is not bool:
        raise BinanceBTCError()
    identifier, order, at = _integer(raw.get('id')), _integer(raw.get('orderId')), _integer(raw.get('time'))
    if not 1230768000000 <= at < 4102444800000:
        raise BinanceBTCError()
    with localcontext() as context:
        context.prec = 256
        quantity, cash, price = (_amount(raw.get(k)) for k in ('qty', 'quoteQty', 'price'))
        fee = _amount(raw.get('commission', '0'))
        if min(quantity, cash, price) <= 0 or fee < 0:
            raise BinanceBTCError()
        buy, fee_asset = raw['isBuyer'], raw.get('commissionAsset', '')
        btc_fee = fee if fee_asset == 'BTC' else Decimal(0)
        quote_fee = fee if fee_asset == quote else Decimal(0)
        other_fee = Decimal(0)
        if fee and fee_asset not in ('BTC', quote):
            if not isinstance(fee_asset, str) or not _ASSET.fullmatch(fee_asset):
                raise BinanceBTCError()
            other_fee = fee * _rate(rates, fee_asset, at) / _rate(rates, quote, at)
        if quote != 'USDT':
            _rate(rates, quote, at)
        net_btc = (quantity if buy else -quantity) - btc_fee
        net_cash = cash + quote_fee + other_fee if buy else cash - quote_fee - other_fee
        if (buy and net_btc <= 0) or (not buy and net_btc >= 0) or net_cash < 0:
            raise BinanceBTCError()
        event = {'id': 'binance:' + symbol + ':' + str(identifier), 'venue': 'binance', 'source': '币安现货',
                 'at_ms': at, 'side': 'buy' if buy else 'sell', 'inst_id': 'BTC-' + quote,
                 'trade_id': str(identifier), 'order_id': str(order),
                 'bill_id': _bill('1', code, identifier, '1'), 'counter_bill_id': _bill('1', code, identifier, '2'),
                 'price': _text(price), 'btc_gross': _text(quantity), 'btc_net': _text(net_btc),
                 'fee_btc': _text(-btc_fee), 'fee_quote': _text(-quote_fee), 'quote_ccy': quote,
                 'quote_gross': _text(cash), 'quote_amount': _text(net_cash), 'original_price': _text(price)}
        if other_fee:
            event.update(fee_asset=fee_asset, fee_amount=_text(fee), fee_value_quote=_text(other_fee))
        return event


def convert_side(raw):
    if not isinstance(raw, dict):
        raise BinanceBTCError()
    if raw.get('orderStatus') != 'SUCCESS':
        return None
    source, target = raw.get('fromAsset'), raw.get('toAsset')
    if (source == 'BTC') == (target == 'BTC'):
        return None
    other = source if target == 'BTC' else target
    if not isinstance(other, str) or not _ASSET.fullmatch(other):
        raise BinanceBTCError()
    return target == 'BTC', other


def normalize_convert(raw, rates=None):
    side = convert_side(raw)
    if side is None:
        return None
    buy, quote = side
    order, at = _integer(raw.get('orderId')), _integer(raw.get('createTime'))
    if not 1230768000000 <= at < 4102444800000:
        raise BinanceBTCError()
    with localcontext() as context:
        context.prec = 256
        quantity = _amount(raw.get('toAmount' if buy else 'fromAmount'))
        cash = _amount(raw.get('fromAmount' if buy else 'toAmount'))
        if min(quantity, cash) <= 0:
            raise BinanceBTCError()
        _rate(rates or {}, quote, at)
        price = _text(cash / quantity)
        return {'id': 'binance-convert:' + str(order), 'venue': 'binance', 'source': '币安闪兑',
                'at_ms': at, 'side': 'buy' if buy else 'sell', 'inst_id': 'BTC-' + quote + '-CONVERT',
                'trade_id': str(order), 'order_id': str(order),
                'bill_id': _bill('2', '00', order, '1'), 'counter_bill_id': _bill('2', '00', order, '2'),
                'price': price, 'btc_gross': _text(quantity), 'btc_net': _text(quantity if buy else -quantity),
                'fee_btc': '0', 'fee_quote': '0', 'quote_ccy': quote, 'quote_gross': _text(cash),
                'quote_amount': _text(cash), 'original_price': price}


class BinanceBTCReader:
    def __init__(self, credentials, *, opener=None, clock=time.time, monotonic=time.monotonic,
                 sleeper=time.sleep, max_requests=28, total_timeout=45, timeout=8,
                 convert_interval=300, convert_spacing=3.1):
        if not isinstance(credentials, dict) or any(not isinstance(credentials.get(k), str) or
                re.fullmatch(r'[A-Za-z0-9]{64}', credentials[k]) is None for k in ('api_key', 'secret_key')):
            raise BinanceBTCError('credentials_invalid', 400)
        if (type(max_requests) is not int or not 6 <= max_requests <= 200 or
                not all(type(v) in (int, float) and math.isfinite(v) and v >= 0 for v in
                        (total_timeout, timeout, convert_interval, convert_spacing)) or
                not 0 < total_timeout <= 120 or not 0 < timeout <= 20):
            raise BinanceBTCError('route_rejected', 400)
        self._key, self._secret = credentials['api_key'], credentials['secret_key'].encode('ascii')
        self._opener = opener or _verified_opener()
        self._clock, self._mono, self._sleep = clock, monotonic, sleeper
        self._max, self._total, self._timeout = max_requests, total_timeout, timeout
        self._convert_interval, self._spacing = convert_interval * 1000, convert_spacing
        self._offset, self._closed = 0, False

    def __repr__(self):
        return 'BinanceBTCReader(closed=%r)' % self._closed

    def close(self):
        self._closed, self._key, self._secret = True, None, None

    def _allowed(self, path, params):
        if path == TIME:
            return params == {}
        if path == PERMISSIONS:
            return params == {'recvWindow': 5000}
        if path == TRADES:
            return (set(params) == {'symbol', 'fromId', 'limit', 'recvWindow'} and
                    params['symbol'] in {m[0] for m in MARKETS} and params['limit'] == 1000 and
                    params['recvWindow'] == 5000 and re.fullmatch(r'\d{1,24}', str(params['fromId'])) is not None)
        if path == CONVERT:
            return (set(params) == {'startTime', 'endTime', 'limit', 'recvWindow'} and
                    all(type(params[k]) is int for k in ('startTime', 'endTime')) and
                    1230768000000 <= params['startTime'] <= params['endTime'] < 4102444800000 and
                    params['endTime'] - params['startTime'] < 30 * DAY and
                    params['limit'] == 1000 and params['recvWindow'] == 5000)
        if path == KLINES:
            return (set(params) == {'symbol', 'interval', 'startTime', 'limit'} and
                    isinstance(params['symbol'], str) and re.fullmatch(r'[A-Z0-9]{1,20}USDT', params['symbol']) is not None and
                    params['interval'] == '1m' and type(params['startTime']) is int and
                    1230768000000 <= params['startTime'] < 4102444800000 and params['startTime'] % MINUTE == 0 and params['limit'] == 1)
        return False

    def _get(self, path, params, deadline):
        if self._closed:
            raise BinanceBTCError('closed', 400)
        if not self._allowed(path, params):
            raise BinanceBTCError('route_rejected', 400)
        if self._budget <= 0 or self._mono() >= deadline:
            raise _Paused()
        if path == CONVERT and self._spacing:
            global _convert_last
            with _convert_lock:
                wait = max(0, _convert_last + self._spacing - self._mono())
                if wait >= deadline - self._mono():
                    raise _Paused()
                if wait:
                    self._sleep(wait)
                _convert_last = self._mono()
        self._budget -= 1
        pairs = sorted(params.items())
        headers = {'Accept': 'application/json', 'User-Agent': 'BitcoinTerminal-BTC-ReadOnly/1'}
        if path in _PRIVATE:
            pairs.append(('timestamp', int(self._clock() * 1000) + self._offset))
        query = urlencode(pairs)
        if path in _PRIVATE:
            query += '&signature=' + hmac.new(self._secret, query.encode('ascii'), hashlib.sha256).hexdigest()
            headers['X-MBX-APIKEY'] = self._key
        request = Request('https://api.binance.com' + path + ('?' + query if query else ''), headers=headers, method='GET')
        try:
            with self._opener.open(request, timeout=min(self._timeout, max(.001, deadline - self._mono()))) as response:
                status = response.getcode()
                raw = response.read(4 * 1024 * 1024 + 1)
        except HTTPError as error:
            status = error.code
            try:
                raw = error.read(4 * 1024 * 1024 + 1)
            except Exception:
                raise BinanceBTCError('network_error') from None
            finally:
                error.close()
        except Exception:
            raise BinanceBTCError('network_error') from None
        if status in (418, 429):
            raise BinanceBTCError('rate_limited', 429)
        if status in (401, 403):
            raise BinanceBTCError('permission_denied', 403)
        if 300 <= status < 400:
            raise BinanceBTCError('route_rejected')
        try:
            if len(raw) > 4 * 1024 * 1024:
                raise ValueError()
            body = json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_bad_constant)
        except Exception:
            raise BinanceBTCError() from None
        api_code = body.get('code') if isinstance(body, dict) else None
        if api_code == -1021:
            raise BinanceBTCError('clock_error')
        if api_code in (-2014, -2015, -1002):
            raise BinanceBTCError('permission_denied', 403)
        if status != 200 or isinstance(api_code, int) and api_code < 0:
            raise BinanceBTCError('network_error')
        return body

    def _ensure_rate(self, rates, currency, at, server_now, deadline):
        try:
            return _rate(rates, currency, at)
        except BinanceBTCError:
            pass
        if not isinstance(currency, str) or not _ASSET.fullmatch(currency):
            raise BinanceBTCError('historical_rate_missing')
        minute = at // MINUTE * MINUTE
        rows = self._get(KLINES, {'symbol': currency + 'USDT', 'interval': '1m', 'startTime': minute, 'limit': 1}, deadline)
        try:
            if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], list) or len(rows[0]) < 7:
                raise ValueError()
            row = rows[0]
            if _integer(row[0]) != minute or _integer(row[6]) >= server_now:
                raise ValueError()
            low, high, close = _amount(row[3]), _amount(row[2]), _amount(row[4])
            if not 0 < low <= close <= high:
                raise ValueError()
        except Exception:
            raise BinanceBTCError('historical_rate_missing') from None
        rates[currency + ':' + str(minute)] = {'currency': currency, 'minute_ms': minute,
                    'close': _text(close), 'low': _text(low), 'high': _text(high), 'source': 'Binance/1m-close'}
        return close

    def read_since(self, coverage_start_ms, *, meta=None, rates=None):
        coverage = _integer(coverage_start_ms)
        if not 1230768000000 <= coverage < 4102444800000:
            raise BinanceBTCError()
        deadline, self._budget = self._mono() + self._total, self._max
        before = self._clock() * 1000
        body = self._get(TIME, {}, deadline)
        after = self._clock() * 1000
        server_now = _integer(body.get('serverTime')) if isinstance(body, dict) else 0
        if not coverage <= server_now < 4102444800000 or after < before or after - before > 15000:
            raise BinanceBTCError('clock_error')
        self._offset = round(server_now - (before + after) / 2)
        try:
            validate_read_only_permissions(self._get(PERMISSIONS, {'recvWindow': 5000}, deadline))
        except BinanceWalletError as error:
            raise BinanceBTCError(error.code, error.status) from None
        if meta is None:
            meta = {'version': 1, 'coverage_start_ms': coverage, 'spot': {},
                    'convert': {'checked_until_ms': None}, 'complete': False, 'as_of_ms': coverage,
                    'last_convert_ms': 0}
        else:
            meta = copy.deepcopy(meta)
            if not isinstance(meta, dict) or meta.get('version') != 1 or meta.get('coverage_start_ms') != coverage or not isinstance(meta.get('spot'), dict) or not isinstance(meta.get('convert'), dict):
                raise BinanceBTCError()
        rates = copy.deepcopy(rates) if isinstance(rates, dict) else {}
        fresh, spot_done, convert_done = [], True, False
        try:
            for market in MARKETS:
                state = meta['spot'].setdefault(market[0], {'next_from_id': '0'})
                while True:
                    cursor = _integer(state['next_from_id'])
                    rows = self._get(TRADES, {'symbol': market[0], 'fromId': str(cursor), 'limit': 1000, 'recvWindow': 5000}, deadline)
                    if not isinstance(rows, list) or len(rows) > 1000:
                        raise BinanceBTCError()
                    previous = cursor - 1
                    for raw in rows:
                        if not isinstance(raw, dict):
                            raise BinanceBTCError()
                        identifier, at = _integer(raw.get('id')), _integer(raw.get('time'))
                        if identifier <= previous or not 1230768000000 <= at <= server_now:
                            raise BinanceBTCError()
                        previous = identifier
                        if at >= coverage:
                            for currency in spot_rate_needs(raw, market):
                                self._ensure_rate(rates, currency, at, server_now, deadline)
                            fresh.append(normalize_spot(raw, market, rates))
                        state['next_from_id'] = str(identifier + 1)
                    if len(rows) < 1000:
                        state['scanned_until_ms'] = server_now
                        break
        except _Paused:
            spot_done = False
        if spot_done:
            convert = meta['convert']
            pending = convert.get('pending', [])
            checked = convert.get('checked_until_ms')
            if checked is not None:
                checked = _integer(checked)
            due = (checked is None or pending or not meta.get('complete') or
                   server_now - _integer(meta.get('last_convert_ms', 0)) >= self._convert_interval)
            if not due:
                convert_done = True
            else:
                if not pending:
                    start = coverage if checked is None else max(coverage, checked - DAY)
                    convert.update(checked_until_ms=start - 1, scan_end_ms=server_now, pending=[])
                    checked = start - 1
                # An initial scan may span several bounded invocations. Extend
                # its tail to this invocation's observation before claiming it
                # complete, including orders made while older windows loaded.
                scan_end = max(_integer(convert['scan_end_ms']), server_now)
                convert['scan_end_ms'] = scan_end
                try:
                    while convert['checked_until_ms'] < scan_end or convert['pending']:
                        if not convert['pending']:
                            start = convert['checked_until_ms'] + 1
                            convert['pending'] = [[start, min(start + CONVERT_WINDOW, scan_end)]]
                        start, end = convert['pending'][0]
                        result = self._get(CONVERT, {'startTime': start, 'endTime': end, 'limit': 1000, 'recvWindow': 5000}, deadline)
                        if not isinstance(result, dict) or not isinstance(result.get('list'), list) or len(result['list']) > 1000 or type(result.get('moreData')) is not bool:
                            raise BinanceBTCError()
                        if result['moreData']:
                            if end - start < 2:
                                raise BinanceBTCError()
                            mid = (start + end) // 2
                            convert['pending'][:1] = [[start, mid], [mid + 1, end]]
                            continue
                        # A window commits its cursor only once every needed
                        # quote is available; overlap/retry IDs remain stable.
                        window = []
                        for raw in result['list']:
                            side = convert_side(raw)
                            if side is None:
                                continue
                            at = _integer(raw.get('createTime'))
                            if not start <= at <= end:
                                raise BinanceBTCError()
                            self._ensure_rate(rates, side[1], at, server_now, deadline)
                            window.append(normalize_convert(raw, rates))
                        fresh.extend(window)
                        convert['pending'].pop(0)
                        convert['checked_until_ms'] = end
                    meta['last_convert_ms'] = server_now
                    convert_done = True
                except _Paused:
                    pass
        meta['complete'] = spot_done and convert_done
        meta['updated_ms'] = server_now
        if meta['complete']:
            meta['as_of_ms'] = min(server_now, meta['convert']['checked_until_ms'])
        # Cursor-aware consumers deduplicate overlap IDs against their book.
        by_id = {}
        for record in fresh:
            if record['id'] in by_id and by_id[record['id']] != record:
                raise BinanceBTCError()
            by_id[record['id']] = record
        records = sorted(by_id.values(), key=lambda r: (r['at_ms'], int(r['bill_id'])))
        return {'records': records, 'meta': meta, 'rates': rates,
                # Observation upper bound includes partial spot rows. The
                # internal meta watermark advances only after full coverage;
                # the owner must not publish a partial working book as final.
                'complete': meta['complete'], 'as_of_ms': server_now}
