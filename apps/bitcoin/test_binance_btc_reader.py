"""Synthetic-key tests for accounting and resumable fixed-route transport."""
import copy
from decimal import localcontext
import hashlib
import hmac
import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

import binance_btc_reader as m

KEY, SECRET = 'K' * 64, 'S' * 64
NOW = 1794178800000
AT = NOW - 120000
READ = {'enableReading': True, 'enableWithdrawals': False,
        'enableSpotAndMarginTrading': False, 'enableInternalTransfer': False}


def spot(identifier=1, at=AT, **extra):
    return {'symbol': 'BTCUSDT', 'id': identifier, 'orderId': 100 + identifier,
            'time': at, 'qty': '0.001', 'quoteQty': '100', 'price': '100000',
            'commission': '0.000001', 'commissionAsset': 'BTC', 'isBuyer': True, **extra}


def convert(order=9, at=AT, **extra):
    return {'orderId': order, 'orderStatus': 'SUCCESS', 'createTime': at,
            'fromAsset': 'USDT', 'toAsset': 'BTC', 'fromAmount': '100',
            'toAmount': '0.001', **extra}


def rates(currency='BNB', at=AT, close='600'):
    return {currency + ':' + str(at // m.MINUTE * m.MINUTE):
            {'currency': currency, 'minute_ms': at // m.MINUTE * m.MINUTE,
             'close': close, 'low': close, 'high': close, 'source': 'Binance/1m-close'}}


class Response:
    def __init__(self, payload, status=200):
        self.body, self.status = json.dumps(payload).encode(), status

    def getcode(self):
        return self.status

    def read(self, maximum):
        return self.body[:maximum]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class Transport:
    def __init__(self, handler=None):
        self.handler, self.requests = handler, []

    def open(self, request, timeout):
        url = urlsplit(request.full_url)
        params = {k: v[0] for k, v in parse_qs(url.query).items()}
        self.requests.append((request, params))
        if self.handler:
            result = self.handler(url.path, params)
            if result is not None:
                if isinstance(result, Exception):
                    raise result
                return result if isinstance(result, Response) else Response(result)
        defaults = {m.TIME: {'serverTime': NOW}, m.PERMISSIONS: READ,
                    m.TRADES: [], m.CONVERT: {'list': [], 'moreData': False}}
        if url.path not in defaults:
            raise AssertionError('Unexpected route in offline test')
        return Response(defaults[url.path])


def reader(transport=None, **kwargs):
    return m.BinanceBTCReader({'api_key': KEY, 'secret_key': SECRET},
            opener=transport or Transport(), clock=lambda: NOW / 1000,
            convert_spacing=0, **kwargs)


class AccountingTests(unittest.TestCase):
    def test_btc_fee_reduces_buy_quantity_and_synthetic_ids_do_not_collide(self):
        event = m.normalize_spot(spot(), m.MARKETS[0])
        self.assertEqual('0.000999', event['btc_net'])
        self.assertEqual('100', event['quote_amount'])
        self.assertEqual('binance:BTCUSDT:1', event['id'])
        self.assertEqual('binance', event['venue'])
        self.assertEqual('7101000000000000000000011', event['bill_id'])
        self.assertNotEqual(event['bill_id'], event['counter_bill_id'])

    def test_quote_fee_and_sell_fee_count_correctly(self):
        buy = m.normalize_spot(spot(commission='0.1', commissionAsset='USDT'), m.MARKETS[0])
        sell = m.normalize_spot(spot(commission='0.1', commissionAsset='USDT', isBuyer=False), m.MARKETS[0])
        self.assertEqual('100.1', buy['quote_amount'])
        self.assertEqual('99.9', sell['quote_amount'])
        self.assertEqual('-0.001', sell['btc_net'])
        btc_sell = m.normalize_spot(spot(isBuyer=False), m.MARKETS[0])
        self.assertEqual('-0.001001', btc_sell['btc_net'])

    def test_bnb_fee_is_valued_at_its_closed_trade_minute(self):
        event = m.normalize_spot(spot(commission='0.001', commissionAsset='BNB'), m.MARKETS[0], rates())
        self.assertEqual('100.6', event['quote_amount'])
        self.assertEqual('0.6', event['fee_value_quote'])
        self.assertEqual('0', event['fee_quote'])
        with self.assertRaises(m.BinanceBTCError) as error:
            m.normalize_spot(spot(commission='0.001', commissionAsset='BNB'), m.MARKETS[0])
        self.assertEqual('historical_rate_missing', error.exception.code)

    def test_non_usdt_quote_and_third_currency_fee_preserve_original_quote(self):
        cache = {**rates('USDC', close='0.999'), **rates('BNB', close='599.4')}
        event = m.normalize_spot(spot(symbol='BTCUSDC', commission='0.001', commissionAsset='BNB'), m.MARKETS[1], cache)
        self.assertEqual('USDC', event['quote_ccy'])
        self.assertEqual('100.6', event['quote_amount'])
        self.assertEqual(['BNB', 'USDC'], m.spot_rate_needs(spot(symbol='BTCUSDC', commission='0.001', commissionAsset='BNB'), m.MARKETS[1]))

    def test_convert_both_directions_and_non_btc_are_handled(self):
        event = m.normalize_convert(convert())
        self.assertEqual('0.001', event['btc_net'])
        self.assertEqual('100000', event['price'])
        sold = m.normalize_convert(convert(fromAsset='BTC', toAsset='USDT', fromAmount='0.001', toAmount='100'))
        self.assertEqual('sell', sold['side'])
        self.assertEqual('-0.001', sold['btc_net'])
        self.assertIsNone(m.normalize_convert(convert(fromAsset='USDT', toAsset='BNB')))
        self.assertIsNone(m.normalize_convert(convert(orderStatus='PROCESSING')))

    def test_bad_rows_never_become_zero_cost_or_zero_quantity(self):
        for changes in ({'qty': '-1'}, {'commission': '-1'}, {'id': True},
                        {'isBuyer': 'true'}, {'price': 'NaN'}, {'qty': 0.001},
                        {'commission': '1', 'commissionAsset': 'BTC'}):
            with self.subTest(changes=changes), self.assertRaises(m.BinanceBTCError):
                m.normalize_spot(spot(**changes), m.MARKETS[0])

    def test_accounting_is_independent_of_ambient_decimal_precision(self):
        with localcontext() as context:
            context.prec = 4
            event = m.normalize_spot(spot(qty='0.00123456789123456789', commission='0.00000000000000000001'), m.MARKETS[0])
        self.assertEqual('0.00123456789123456788', event['btc_net'])


class ReaderTests(unittest.TestCase):
    def test_routes_and_hmac_are_fixed_get_and_public_requests_have_no_key(self):
        transport = Transport()
        result = reader(transport).read_since(NOW - m.DAY)
        self.assertTrue(result['complete'])
        self.assertEqual([], result['records'])
        for request, params in transport.requests:
            url = urlsplit(request.full_url)
            self.assertEqual('GET', request.get_method())
            self.assertEqual('https', url.scheme)
            self.assertEqual('api.binance.com', url.netloc)
            if url.path == m.TIME:
                self.assertNotIn('signature', params)
                self.assertIsNone(request.get_header('X-mbx-apikey'))
            else:
                unsigned, signature = url.query.rsplit('&signature=', 1)
                self.assertEqual(hmac.new(SECRET.encode(), unsigned.encode(), hashlib.sha256).hexdigest(), signature)
                self.assertEqual(KEY, request.get_header('X-mbx-apikey'))
        for path in ['/api/v3/order', '/sapi/v1/asset/transfer', 'https://host.test/']:
            with self.assertRaises(m.BinanceBTCError) as error:
                reader()._get(path, {}, 999999999999)
            self.assertEqual('route_rejected', error.exception.code)

    def test_trade_permission_is_rejected_before_any_history_call(self):
        transport = Transport(lambda path, _: {**READ, 'enableSpotAndMarginTrading': True} if path == m.PERMISSIONS else None)
        with self.assertRaises(m.BinanceBTCError) as error:
            reader(transport).read_since(NOW - m.DAY)
        self.assertEqual('read_only_required', error.exception.code)
        self.assertEqual([m.TIME, m.PERMISSIONS], [urlsplit(r.full_url).path for r, _ in transport.requests])

    def test_from_id_pages_cover_entire_spot_history_and_resume_at_next_fill(self):
        def respond(path, params):
            if path == m.TRADES and params['symbol'] == 'BTCUSDT':
                return [spot(i) for i in range(1000)] if params['fromId'] == '0' else [spot(1000)] if params['fromId'] == '1000' else []
        transport = Transport(respond)
        first = reader(transport).read_since(NOW - m.DAY)
        self.assertEqual(1001, len(first['records']))
        self.assertEqual('1001', first['meta']['spot']['BTCUSDT']['next_from_id'])
        again = reader(transport).read_since(NOW - m.DAY, meta=first['meta'], rates=first['rates'])
        self.assertEqual([], again['records'])
        self.assertTrue(again['complete'])

    def test_initial_history_import_is_bounded_and_resumes_convert_windows(self):
        transport = Transport()
        start = NOW - 61 * m.DAY
        first = reader(transport, max_requests=6).read_since(start)
        self.assertFalse(first['complete'])
        self.assertEqual(6, len(transport.requests))
        self.assertEqual(NOW, first['as_of_ms'])
        self.assertEqual(start, first['meta']['as_of_ms'])
        prior = copy.deepcopy(first['meta'])
        second = reader(transport, max_requests=6).read_since(start, meta=prior)
        self.assertEqual(first['meta'], prior)
        self.assertFalse(second['complete'])
        third = reader(transport, max_requests=6).read_since(start, meta=second['meta'])
        self.assertTrue(third['complete'])
        intervals = [(int(p['startTime']), int(p['endTime'])) for req, p in transport.requests if urlsplit(req.full_url).path == m.CONVERT]
        self.assertEqual(start, intervals[0][0])
        self.assertEqual(NOW, intervals[-1][1])
        for previous, current in zip(intervals, intervals[1:]):
            self.assertEqual(previous[1] + 1, current[0])
        self.assertTrue(all(end - begin < 30 * m.DAY for begin, end in intervals))

    def test_resumed_initial_convert_scan_catches_orders_during_the_import(self):
        current = [NOW]
        purchase_at = NOW + 30000
        def respond(path, params):
            if path == m.TIME:
                return {'serverTime': current[0]}
            if path == m.CONVERT:
                start, end = int(params['startTime']), int(params['endTime'])
                return {'list': [convert(at=purchase_at)] if start <= purchase_at <= end else [],
                        'moreData': False}
        transport = Transport(respond)
        start = NOW - 61 * m.DAY
        first = reader(transport, max_requests=6).read_since(start)
        self.assertFalse(first['complete'])
        current[0] += 60000
        final = reader(transport).read_since(start, meta=first['meta'], rates=first['rates'])
        self.assertTrue(final['complete'])
        self.assertEqual(current[0], final['meta']['convert']['checked_until_ms'])
        self.assertEqual([purchase_at], [event['at_ms'] for event in final['records']])

    def test_convert_more_data_splits_range_without_skipping_boundaries(self):
        seen = []
        def respond(path, params):
            if path == m.CONVERT:
                start, end = int(params['startTime']), int(params['endTime'])
                seen.append((start, end))
                if len(seen) == 1:
                    return {'list': [], 'moreData': True}
                return {'list': [convert(at=start, order=start)], 'moreData': False}
        result = reader(Transport(respond)).read_since(NOW - m.DAY)
        self.assertTrue(result['complete'])
        self.assertEqual(2, len(result['records']))
        self.assertEqual(seen[1][1] + 1, seen[2][0])
        self.assertEqual(seen[0][0], seen[1][0])
        self.assertEqual(seen[0][1], seen[2][1])

    def test_minute_rate_cache_uses_exact_closed_candle_and_no_public_auth(self):
        def respond(path, params):
            if path == m.TRADES and params['symbol'] == 'BTCUSDT':
                return [spot(commission='0.001', commissionAsset='BNB')]
            if path == m.KLINES:
                minute = int(params['startTime'])
                return [[minute, '600', '610', '590', '600', '1', minute + 59999]]
        transport = Transport(respond)
        result = reader(transport).read_since(NOW - m.DAY)
        self.assertEqual('100.6', result['records'][0]['quote_amount'])
        self.assertEqual('600', result['rates']['BNB:' + str(AT // m.MINUTE * m.MINUTE)]['close'])
        kline = next(req for req, _ in transport.requests if urlsplit(req.full_url).path == m.KLINES)
        self.assertIsNone(kline.get_header('X-mbx-apikey'))
        self.assertNotIn('signature', kline.full_url)

    def test_open_candle_is_not_accepted_as_historical_cost(self):
        def respond(path, params):
            if path == m.TRADES and params['symbol'] == 'BTCUSDT':
                return [spot(at=NOW - 1, commission='0.001', commissionAsset='BNB')]
            if path == m.KLINES:
                return [[NOW, '600', '610', '590', '600', '1', NOW + 59999]]
        with self.assertRaises(m.BinanceBTCError) as error:
            reader(Transport(respond)).read_since(NOW - m.DAY)
        self.assertEqual('historical_rate_missing', error.exception.code)

    def test_out_of_order_or_future_fill_rejects_scan_without_mutating_input_meta(self):
        for rows in ([spot(2), spot(1)], [spot(at=NOW + 1)]):
            transport = Transport(lambda path, p: rows if path == m.TRADES and p['symbol'] == 'BTCUSDT' else None)
            with self.assertRaises(m.BinanceBTCError):
                reader(transport).read_since(NOW - m.DAY)

    def test_errors_do_not_include_provider_messages_key_or_signed_url(self):
        def respond(path, params):
            if path == m.TRADES:
                return HTTPError('https://api.binance.com/?signature=PRIVATE&' + KEY,
                    429, SECRET, {}, io.BytesIO(json.dumps({'code': -1003, 'msg': KEY + SECRET}).encode()))
        with self.assertRaises(m.BinanceBTCError) as error:
            reader(Transport(respond)).read_since(NOW - m.DAY)
        self.assertEqual('rate_limited', error.exception.code)
        for secret in (KEY, SECRET, 'PRIVATE'):
            self.assertNotIn(secret, repr(error.exception))
            self.assertNotIn(secret, str(error.exception))

    def test_unknown_fields_in_history_response_do_not_enable_other_routes(self):
        with self.assertRaises(m.BinanceBTCError):
            reader()._get(m.TRADES, {'symbol': 'BTCUSDT', 'fromId': '0', 'limit': 1000,
                           'recvWindow': 5000, 'url': 'https://evil.test'}, 999999999999)

    def test_convert_is_not_requeried_on_every_spot_poll(self):
        transport = Transport()
        first = reader(transport).read_since(NOW - m.DAY)
        transport.requests.clear()
        again = reader(transport).read_since(NOW - m.DAY, meta=first['meta'])
        self.assertTrue(again['complete'])
        paths = [urlsplit(req.full_url).path for req, _ in transport.requests]
        self.assertEqual(3, paths.count(m.TRADES))
        self.assertNotIn(m.CONVERT, paths)

    def test_shared_convert_spacing_applies_across_reader_instances(self):
        mono = [100.0]
        starts = []
        def respond(path, params):
            if path == m.CONVERT:
                starts.append(mono[0])
        def sleep(seconds):
            mono[0] += seconds
        with patch.object(m, '_convert_last', 0):
            for _ in range(2):
                instance = m.BinanceBTCReader({'api_key': KEY, 'secret_key': SECRET},
                        opener=Transport(respond), clock=lambda: NOW / 1000,
                        monotonic=lambda: mono[0], sleeper=sleep)
                self.assertTrue(instance.read_since(NOW - m.DAY)['complete'])
        self.assertEqual(2, len(starts))
        self.assertGreaterEqual(starts[1] - starts[0], 3.09)


if __name__ == '__main__':
    unittest.main()
