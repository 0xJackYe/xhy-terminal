"""Standalone read-only C2C cash-flow audit. Does not change the dashboard.

Binance's ordinary API exposes six months of fiat C2C order totals. OKX's
ordinary funding bills expose crypto movements, not the C2C fiat payment.
Keep these two sources separate rather than inventing a fiat conversion.
"""
import calendar
import datetime as dt
from decimal import Decimal, InvalidOperation, localcontext
import base64
import hashlib
import hmac
import json
from pathlib import Path
import re
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request

from binance_wallet import _verified_opener

DAY = 86400000
BEIJING = dt.timezone(dt.timedelta(hours=8))
C2C_PATH = '/sapi/v1/c2c/orderMatch/listUserOrderHistory'
OKX_BILLS = '/api/v5/asset/bills-history'
STATUSES = {'PENDING', 'TRADING', 'BUYER_PAYED', 'DISTRIBUTING', 'COMPLETED',
            'IN_APPEAL', 'CANCELLED', 'CANCELLED_BY_SYSTEM'}


class AuditError(Exception):
    """Only fixed error codes; never provider bodies, signed URLs or secrets."""
    def __init__(self, code, retry_after=0):
        super().__init__(code)
        self.retry_after = retry_after


def money(value, signed=False):
    if not isinstance(value, str) or len(value) > 100:
        raise AuditError('invalid_amount')
    try:
        result = Decimal(value)
    except InvalidOperation:
        raise AuditError('invalid_amount') from None
    if not result.is_finite() or abs(result) > Decimal('1e40') or not signed and result < 0:
        raise AuditError('invalid_amount')
    return result


def six_month_start(end_ms):
    end = dt.datetime.fromtimestamp(end_ms / 1000, dt.timezone.utc)
    index = end.year * 12 + end.month - 1 - 6
    year, month = index // 12, index % 12 + 1
    start = end.replace(year=year, month=month, day=min(end.day, calendar.monthrange(year, month)[1]))
    # Stay inside the rolling boundary while the subsequent pages are read.
    return int(start.timestamp() * 1000) + 60000


def windows(start, end):
    if type(start) is not int or type(end) is not int or not 0 < start <= end:
        raise AuditError('invalid_interval')
    while start <= end:
        stop = min(start + 30 * DAY - 1, end)
        yield start, stop
        start = stop + 1


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise AuditError('invalid_json')
        result[key] = value
    return result


class HistoryClient:
    def __init__(self, venue, credentials, opener=None, clock=time.time, sleeper=time.sleep):
        if venue not in {'binance', 'okx'}:
            raise AuditError('invalid_venue')
        required = {'api_key', 'secret_key'} | ({'passphrase'} if venue == 'okx' else set())
        if not isinstance(credentials, dict) or set(credentials) != required or any(
                not isinstance(v, str) or not v or any(ord(c) < 33 or ord(c) > 126 for c in v)
                for v in credentials.values()):
            raise AuditError('credentials_unavailable')
        self.venue, self._credentials = venue, dict(credentials)
        self._opener, self._clock, self._sleep = opener or _verified_opener(), clock, sleeper
        self.offset = 0

    def close(self):
        self._credentials.clear()

    def get(self, path, params):
        for attempt in range(3):
            try:
                return self._get_once(path, params)
            except AuditError as error:
                if (str(error) not in {'rate_limited', 'network_error', 'temporary_http_error'}
                        or attempt == 2 or error.retry_after > 30):
                    raise
                self._sleep(max(3 * (attempt + 1), error.retry_after))

    def _get_once(self, path, params):
        public = '/api/v3/time' if self.venue == 'binance' else '/api/v5/public/time'
        private = C2C_PATH if self.venue == 'binance' else OKX_BILLS
        if path not in {public, private} or not isinstance(params, dict):
            raise AuditError('endpoint_rejected')
        if path == public:
            if params:
                raise AuditError('parameters_rejected')
        elif self.venue == 'binance':
            if (set(params) != {'tradeType', 'startTimestamp', 'endTimestamp', 'page', 'rows'}
                    or params['tradeType'] not in {'BUY', 'SELL'} or params['rows'] != 100
                    or type(params['page']) is not int or not 1 <= params['page'] <= 100
                    or any(type(params[k]) is not int for k in ('startTimestamp', 'endTimestamp'))
                    or params['startTimestamp'] <= 0
                    or not 0 <= params['endTimestamp'] - params['startTimestamp'] < 30 * DAY):
                raise AuditError('parameters_rejected')
        elif (not {'type', 'limit', 'pagingType'} <= set(params) <= {'type', 'limit', 'pagingType', 'after'}
              or params['type'] not in {'116', '117', '118'} or params['limit'] != '100'
              or params['pagingType'] != '2'
              or 'after' in params and not re.fullmatch(r'[0-9]{1,40}', params['after'])):
            raise AuditError('parameters_rejected')
        signed = path == private
        values = dict(params)
        headers = {'Accept': 'application/json', 'User-Agent': 'BitcoinTerminal-Cashflow-ReadOnly/1'}
        origin = 'https://api.binance.com' if self.venue == 'binance' else 'https://www.okx.com'
        if signed and self.venue == 'binance':
            values.update(timestamp=int((self._clock() + self.offset) * 1000), recvWindow=5000)
        query = urlencode(sorted(values.items()))
        if signed and self.venue == 'binance':
            query += '&signature=' + hmac.new(self._credentials['secret_key'].encode(), query.encode(), hashlib.sha256).hexdigest()
            headers['X-MBX-APIKEY'] = self._credentials['api_key']
        full_path = path + ('?' + query if query else '')
        if signed and self.venue == 'okx':
            stamp = dt.datetime.fromtimestamp(self._clock() + self.offset, dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            signature = base64.b64encode(hmac.new(self._credentials['secret_key'].encode(),
                (stamp + 'GET' + full_path).encode(), hashlib.sha256).digest()).decode()
            headers.update({'OK-ACCESS-KEY': self._credentials['api_key'],
                'OK-ACCESS-PASSPHRASE': self._credentials['passphrase'],
                'OK-ACCESS-TIMESTAMP': stamp, 'OK-ACCESS-SIGN': signature})
        url = origin + full_path
        try:
            with self._opener.open(Request(url, headers=headers, method='GET'), timeout=12) as response:
                if response.getcode() != 200 or response.geturl() != url:
                    raise AuditError('http_or_redirect_error')
                raw = response.read(4 * 1024 * 1024 + 1)
        except HTTPError as error:
            status = error.code
            try:
                retry_after = float(error.headers.get('Retry-After', '0'))
                if not 0 <= retry_after <= 3600:
                    retry_after = 0
            except (ValueError, TypeError, AttributeError):
                retry_after = 0
            error.close()
            code = ('rate_limited' if status == 429 else 'ip_banned' if status == 418
                    else 'permission_denied' if status in (401, 403)
                    else 'temporary_http_error' if 500 <= status < 600 else 'http_error')
            raise AuditError(code, retry_after) from None
        except AuditError:
            raise
        except Exception:
            raise AuditError('network_error') from None
        try:
            if len(raw) > 4 * 1024 * 1024:
                raise ValueError()
            data = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object,
                parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except Exception:
            raise AuditError('invalid_json') from None
        if not isinstance(data, dict):
            raise AuditError('invalid_response')
        if signed or self.venue == 'okx':
            code = '000000' if self.venue == 'binance' else '0'
            if data.get('code') != code:
                if self.venue == 'okx' and data.get('code') in {'50011', '50040'}:
                    raise AuditError('rate_limited')
                raise AuditError('provider_rejected')
        return data

    def sync_time(self):
        before = self._clock()
        path = '/api/v3/time' if self.venue == 'binance' else '/api/v5/public/time'
        data = self.get(path, {})
        try:
            stamp = data['serverTime'] if self.venue == 'binance' else int(data['data'][0]['ts'])
            if type(stamp) is not int or not 1577836800000 <= stamp < 4102444800000:
                raise ValueError()
        except Exception:
            raise AuditError('invalid_server_time') from None
        self.offset = stamp / 1000 - (before + self._clock()) / 2
        return stamp

    def binance_orders(self, start, end):
        if self.venue != 'binance':
            raise AuditError('invalid_venue')
        result = {}
        for begin, finish in windows(start, end):
            for side in ('BUY', 'SELL'):
                seen, expected = set(), None
                for page in range(1, 101):
                    data = self.get(C2C_PATH, {'tradeType': side, 'startTimestamp': begin,
                        'endTimestamp': finish, 'page': page, 'rows': 100})
                    rows, total = data.get('data'), data.get('total')
                    if (data.get('success') is not True or not isinstance(rows, list)
                            or len(rows) > 100 or type(total) is not int or total < 0
                            or expected is not None and expected != total):
                        raise AuditError('incomplete_pagination')
                    expected = total
                    for raw in rows:
                        row = normalize_binance(raw)
                        key = row['order_id']
                        if row['side'] != side or not begin <= row['at_ms'] <= finish or key in seen:
                            raise AuditError('inconsistent_order')
                        seen.add(key)
                        if key in result and result[key] != row:
                            raise AuditError('inconsistent_order')
                        result[key] = row
                    if len(seen) == total:
                        break
                    if not rows or len(seen) > total or page == 100:
                        raise AuditError('incomplete_pagination')
                    self._sleep(.2)
        return sorted(result.values(), key=lambda row: (row['at_ms'], row['order_id']))

    def okx_bills(self):
        if self.venue != 'okx':
            raise AuditError('invalid_venue')
        result = {}
        for kind in ('116', '117', '118'):
            after = None
            for page in range(50):
                self._sleep(1.2)
                params = {'type': kind, 'limit': '100', 'pagingType': '2'}
                if after:
                    params['after'] = after
                rows = self.get(OKX_BILLS, params).get('data')
                if not isinstance(rows, list) or len(rows) > 100:
                    raise AuditError('invalid_bills')
                for raw in rows:
                    row = normalize_okx(raw)
                    if row['type'] != kind or row['bill_id'] in result:
                        raise AuditError('inconsistent_bill')
                    result[row['bill_id']] = row
                if len(rows) < 100:
                    break
                if page == 49:
                    raise AuditError('incomplete_pagination')
                after = rows[-1]['billId']
        return sorted(result.values(), key=lambda row: (row['at_ms'], row['bill_id']))


def normalize_binance(raw):
    if (not isinstance(raw, dict) or not isinstance(raw.get('orderNumber'), str)
            or not re.fullmatch(r'[0-9]{1,50}', raw['orderNumber'])
            or raw.get('tradeType') not in {'BUY', 'SELL'} or raw.get('orderStatus') not in STATUSES
            or type(raw.get('createTime')) is not int or raw['createTime'] <= 0
            or not isinstance(raw.get('fiat'), str) or not re.fullmatch(r'[A-Z]{3,8}', raw['fiat'])
            or not isinstance(raw.get('asset'), str) or not re.fullmatch(r'[A-Z0-9._-]{1,30}', raw['asset'])):
        raise AuditError('invalid_order')
    fiat, crypto = money(raw.get('totalPrice')), money(raw.get('amount'))
    if raw['orderStatus'] == 'COMPLETED' and (fiat <= 0 or crypto <= 0):
        raise AuditError('invalid_order')
    return {'order_id': raw['orderNumber'], 'side': raw['tradeType'], 'status': raw['orderStatus'],
            'at_ms': raw['createTime'], 'fiat': raw['fiat'], 'asset': raw['asset'],
            'fiat_amount': format(fiat, 'f'), 'crypto_amount': format(crypto, 'f')}


def normalize_okx(raw):
    if (not isinstance(raw, dict) or not isinstance(raw.get('billId'), str)
            or not re.fullmatch(r'[0-9]{1,40}', raw['billId']) or raw.get('type') not in {'116', '117', '118'}
            or not isinstance(raw.get('ts'), str) or not re.fullmatch(r'[0-9]{13}', raw['ts'])
            or not isinstance(raw.get('ccy'), str) or not re.fullmatch(r'[A-Z0-9._-]{1,30}', raw['ccy'])):
        raise AuditError('invalid_bill')
    change = money(raw.get('balChg'), signed=True)
    return {'bill_id': raw['billId'], 'type': raw['type'], 'at_ms': int(raw['ts']),
            'asset': raw['ccy'], 'crypto_change': format(change, 'f')}


def summarize_orders(orders):
    with localcontext() as context:
        context.prec = 128
        values, seen, excluded = {}, {}, 0
        for row in orders:
            key = row['order_id']
            if key in seen:
                if seen[key] != row:
                    raise AuditError('conflicting_duplicate')
                continue
            seen[key] = dict(row)
            if row['status'] != 'COMPLETED':
                excluded += 1
                continue
            group = values.setdefault(row['fiat'], {'buy_paid': Decimal(0), 'sell_received': Decimal(0), 'buy_count': 0, 'sell_count': 0})
            field, count = ('buy_paid', 'buy_count') if row['side'] == 'BUY' else ('sell_received', 'sell_count')
            group[field] += money(row['fiat_amount'])
            group[count] += 1
        result = {}
        for fiat, group in values.items():
            result[fiat] = {k: format(v, 'f') if isinstance(v, Decimal) else v for k, v in group.items()}
            result[fiat]['net_contribution'] = format(group['buy_paid'] - group['sell_received'], 'f')
        return {'by_fiat': result, 'completed_orders': sum(g['buy_count'] + g['sell_count'] for g in values.values()),
                'excluded_uncompleted': excluded, 'unique_orders': len(seen)}


def main():
    from crypto_portfolio_service import BinanceVault
    from okx_wallet_service import OKXVault
    report = {'as_of_beijing': dt.datetime.now(BEIJING).isoformat(),
              'all_time_combined_complete': False, 'net_asset_value': None}
    for venue, credentials in (('binance', BinanceVault().read()), ('okx', OKXVault().read())):
        client = None
        try:
            client = HistoryClient(venue, credentials)
            end = client.sync_time()
            if venue == 'binance':
                start = six_month_start(end)
                orders = client.binance_orders(start, end)
                report[venue] = {'status': 'verified_in_api_window', 'start_ms': start, 'end_ms': end,
                    'all_time_complete': False, 'orders': orders, 'summary': summarize_orders(orders)}
            else:
                bills = client.okx_bills()
                report[venue] = {'status': 'crypto_bills_only', 'fiat_totals': None, 'bills': bills,
                    'all_time_complete': False, 'reason': 'ordinary_api_has_no_c2c_fiat_payment_fields'}
        except AuditError as error:
            report[venue] = {'status': 'unavailable', 'reason': str(error), 'fiat_totals': None}
        finally:
            if client:
                client.close()
            credentials.clear()
    directory = Path(__file__).resolve().parent / 'terminal' / 'data' / 'c2c-cashflow'
    OKXVault(directory)._write('audit.protected.json', report)
    output = {key: {k: v for k, v in value.items() if k not in {'orders', 'bills'}} if isinstance(value, dict) else value
              for key, value in report.items()}
    output['okx']['bill_count'] = len(report['okx'].get('bills', []))
    output['okx']['bill_fields'] = sorted(report['okx']['bills'][0]) if report['okx'].get('bills') else []
    print(json.dumps(output, ensure_ascii=True, indent=2))


if __name__ == '__main__':
    main()
