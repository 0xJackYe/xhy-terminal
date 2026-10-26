"""Offline read-only account diagnostics; no real credentials or requests."""
import copy
import hashlib
import hmac
import io
import json
import unittest
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

from binance_options_account import (BinanceOptionsReadClient, OptionsReadError,
    ROUTES, MAX_BYTES, safe_diagnostics, validate_account, validate_positions)

KEY, SECRET = 'K'*64, 'S'*64
NOW = 1792855000
READ = {'enableReading': True, 'enableWithdrawals': False, 'enableFutures': False,
        'enableVanillaOptions': False, 'enableSpotAndMarginTrading': False}


class Response:
    def __init__(self, payload=None, status=200, raw=None):
        self.raw = json.dumps(payload).encode() if raw is None else raw
        self.status = status
    def getcode(self):
        return self.status
    def read(self, maximum):
        return self.raw[:maximum]
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass


class Transport:
    def __init__(self, *outcomes):
        self.outcomes, self.requests = list(outcomes), []
    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if not self.outcomes:
            raise AssertionError('Offline fixture exhausted')
        result = self.outcomes.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def client(transport, **kwargs):
    return BinanceOptionsReadClient(KEY, SECRET, opener=transport,
        clock=lambda:NOW, monotonic=lambda:1.0, **kwargs)


def account(**changes):
    return {'asset':[{'asset':'USDT','marginBalance':'1000','equity':'980',
        'available':'700','initialMargin':'300','maintMargin':'150',
        'unrealizedPNL':'-20','adjustedEquity':'1000',**changes}],
        'greek':[],'time':NOW*1000}


def position(**changes):
    return {'symbol':'BTC-261127-60000-P','side':'SHORT','quantity':'-0.02',
            'entryPrice':'165','markValue':'-4.56','markPrice':'228','unrealizedPNL':'-1.26',**changes}


def fixture(a=None, positions=None, portfolio=None):
    return [Response({'serverTime':NOW*1000}),Response(READ),
        Response({'serverTime':NOW*1000}), Response(account() if a is None else a),
        Response([position()] if positions is None else positions),Response([]),
        Response({'uniMMR':'5','accountType':'PM_3'} if portfolio is None else portfolio)]


class ReadOnlyProbeTests(unittest.TestCase):
    def test_success_contains_all_readonly_data(self):
        transport=Transport(*fixture())
        result=client(transport).probe_account()
        self.assertTrue(result['read_only_verified'])
        self.assertEqual('connected',result['access']['margin_account']['status'])
        self.assertEqual('-0.02',result['data']['positions'][0]['quantity'])
        self.assertEqual([],result['data']['open_orders'])
        self.assertTrue(safe_diagnostics(result)['risk_data_complete'])
        self.assertEqual(7,len(transport.requests))

    def test_every_endpoint_is_allowlisted_get(self):
        transport=Transport(*fixture())
        client(transport).probe_account()
        allowed={(urlsplit(origin).netloc,path) for origin,path,_ in ROUTES.values()}
        for request,timeout in transport.requests:
            url=urlsplit(request.full_url)
            self.assertEqual('GET',request.get_method())
            self.assertEqual('https',url.scheme)
            self.assertIn((url.netloc,url.path),allowed)
            self.assertIsNone(request.data)
            self.assertLessEqual(timeout,6)

    def test_public_time_requests_do_not_receive_key(self):
        transport=Transport(*fixture())
        client(transport).probe_account()
        for index in (0,2):
            request=transport.requests[index][0]
            self.assertNotIn(KEY,repr(request.header_items()))
            self.assertNotIn('signature',request.full_url)

    def test_signature_and_timestamp_are_correct(self):
        transport=Transport(*fixture())
        client(transport).probe_account()
        query=urlsplit(transport.requests[1][0].full_url).query
        signed,signature=query.rsplit('&signature=',1)
        self.assertEqual(hmac.new(SECRET.encode(),signed.encode(),hashlib.sha256).hexdigest(),signature)
        self.assertEqual([str(NOW*1000)],parse_qs(signed)['timestamp'])
        self.assertEqual(['5000'],parse_qs(signed)['recvWindow'])

    def test_trade_permission_fails_closed_before_option_reads(self):
        transport=Transport(Response({'serverTime':NOW*1000}),Response({**READ,'enableVanillaOptions':True}))
        result=client(transport).probe_account()
        self.assertFalse(result['read_only_verified'])
        self.assertEqual('read_only_required',result['access']['permissions']['status'])
        self.assertEqual(2,len(transport.requests))
        self.assertFalse(result['data'])

    def test_missing_read_permission_fails_closed(self):
        transport=Transport(Response({'serverTime':NOW*1000}),Response({'enableReading':False}))
        self.assertFalse(client(transport).probe_account()['read_only_verified'])

    def test_rejected_options_key_is_not_zero_balance(self):
        outcomes=fixture()
        outcomes[3]=Response({'code':-2015,'msg':KEY+SECRET},status=401)
        result=client(Transport(*outcomes)).probe_account()
        self.assertEqual('permission_denied',result['access']['margin_account']['status'])
        self.assertNotIn('margin_account',result['data'])
        self.assertFalse(safe_diagnostics(result)['risk_data_complete'])
        self.assertNotIn(KEY,json.dumps(result));self.assertNotIn(SECRET,json.dumps(result))

    def test_unopened_portfolio_account_classified_separately(self):
        result=client(Transport(*fixture(portfolio={'code':-21001,'msg':'not enabled'}))).probe_account()
        self.assertEqual('account_not_enabled',result['access']['portfolio_account']['status'])
        self.assertTrue(safe_diagnostics(result)['risk_data_complete'])

    def test_empty_positions_success_is_zero_not_permission_failure(self):
        result=client(Transport(*fixture(positions=[]))).probe_account()
        self.assertEqual(0,safe_diagnostics(result)['position_rows'])
        self.assertEqual('connected',result['access']['positions']['status'])

    def test_absent_margin_assets_cannot_be_complete_risk_data(self):
        result=client(Transport(*fixture(a={'asset':[]}))).probe_account()
        self.assertEqual('connected',result['access']['margin_account']['status'])
        self.assertFalse(safe_diagnostics(result)['risk_data_complete'])

    def test_invalid_margin_payload_does_not_enter_data(self):
        result=client(Transport(*fixture(a={'asset':'invalid'}))).probe_account()
        self.assertEqual('invalid_response',result['access']['margin_account']['status'])
        self.assertNotIn('margin_account',result['data'])

    def test_rate_limit_stops_later_reads(self):
        outcomes=fixture();outcomes[3]=Response({'code':-1003,'msg':'pause'},429)
        transport=Transport(*outcomes)
        result=client(transport).probe_account()
        self.assertEqual('rate_limited',result['access']['margin_account']['status'])
        self.assertEqual(4,len(transport.requests))

    def test_clock_skew_recalibrates_once(self):
        outcomes=fixture()
        outcomes[1:2]=[Response({'code':-1021},400),Response({'serverTime':NOW*1000+1000}),Response(READ)]
        transport=Transport(*outcomes)
        result=client(transport).probe_account()
        self.assertTrue(result['read_only_verified'])
        request=transport.requests[3][0]
        self.assertEqual([str(NOW*1000+1000)],parse_qs(urlsplit(request.full_url).query)['timestamp'])

    def test_network_retry_is_bounded(self):
        outcomes=fixture();outcomes[3:4]=[URLError(KEY+SECRET),Response(account())]
        transport=Transport(*outcomes)
        self.assertTrue(safe_diagnostics(client(transport).probe_account())['risk_data_complete'])
        self.assertEqual(8,len(transport.requests))

    def test_redirects_rejected_and_never_followed(self):
        transport=Transport(Response({},302))
        result=client(transport).probe_account()
        self.assertEqual('redirect_rejected',result['access']['permissions']['status'])
        self.assertEqual(1,len(transport.requests))

    def test_hostile_exception_urls_and_provider_messages_not_leaked(self):
        error=HTTPError('https://eapi.binance.com/?signature='+SECRET,401,KEY,{},
            io.BytesIO(json.dumps({'code':-2015,'msg':KEY+SECRET}).encode()))
        transport=Transport(Response({'serverTime':NOW*1000}),error)
        result=client(transport).probe_account()
        serialized=json.dumps(result)
        self.assertNotIn(KEY,serialized);self.assertNotIn(SECRET,serialized)
        self.assertNotIn('signature',serialized)

    def test_duplicate_json_keys_rejected(self):
        transport=Transport(Response(raw=b'{"serverTime":1,"serverTime":2}'))
        result=client(transport).probe_account()
        self.assertEqual('invalid_response',result['access']['permissions']['status'])

    def test_oversized_response_rejected(self):
        transport=Transport(Response(raw=b' '*(MAX_BYTES+1)))
        result=client(transport).probe_account()
        self.assertEqual('invalid_response',result['access']['permissions']['status'])

    def test_nonfinite_json_rejected(self):
        transport=Transport(Response(raw=b'{"serverTime":NaN}'))
        result=client(transport).probe_account()
        self.assertEqual('invalid_response',result['access']['permissions']['status'])

    def test_no_arbitrary_route_or_public_route_can_be_signed(self):
        c=client(Transport())
        for route in ('/eapi/v1/order','https://evil.invalid','options_time'):
            with self.assertRaises(OptionsReadError) as raised:
                c._read(route,50)
            self.assertEqual('route_rejected',raised.exception.code)

    def test_closed_client_clears_credentials(self):
        c=client(Transport());c.close()
        self.assertIsNone(c._key);self.assertIsNone(c._secret)
        self.assertNotIn(KEY,repr(c));self.assertNotIn(SECRET,repr(c))
        with self.assertRaises(OptionsReadError):c._once('permissions',50)

    def test_invalid_credentials_and_timeouts_rejected(self):
        for value in ('short',None,'x'*65,'x\n'*32):
            with self.assertRaises(OptionsReadError):BinanceOptionsReadClient(value,SECRET)
        for kwargs in ({'socket_timeout':float('nan')},{'socket_timeout':0},{'total_timeout':1000}):
            with self.assertRaises(OptionsReadError):client(Transport(),**kwargs)

    def test_safe_report_does_not_include_financial_values_or_symbols(self):
        result=client(Transport(*fixture())).probe_account()
        report=safe_diagnostics(result)
        serialized=json.dumps(report)
        self.assertNotIn('60000',serialized);self.assertNotIn('adjustedEquity',serialized)
        self.assertNotIn('marginBalance',serialized);self.assertNotIn('quantity',serialized)
        self.assertEqual(1,report['position_rows'])


class SchemaTests(unittest.TestCase):
    def test_exact_decimals_preserved(self):
        payload=account(adjustedEquity='0.123456789123456789123456789')
        self.assertEqual(payload,validate_account(payload))

    def test_bad_decimal_or_negative_margin_rejected(self):
        for field,value in (('maintMargin','-1'),('initialMargin','-0.01'),('equity','NaN'),
                            ('adjustedEquity',1.0),('available','1e3'),('marginBalance',None)):
            with self.subTest(field=field,value=value):
                with self.assertRaises(OptionsReadError):validate_account(account(**{field:value}))

    def test_duplicate_asset_rows_rejected(self):
        value=account();value['asset'].append(copy.deepcopy(value['asset'][0]))
        with self.assertRaises(OptionsReadError):validate_account(value)

    def test_long_and_short_signs_checked(self):
        self.assertEqual(1,len(validate_positions([position()])))
        self.assertEqual(1,len(validate_positions([position(side='LONG',quantity='0.02')])) )
        for row in (position(side='LONG'),position(side='SHORT',quantity='0.2'),position(quantity='NaN')):
            with self.assertRaises(OptionsReadError):validate_positions([row])

    def test_symbol_and_payload_shape_checked(self):
        for value in ({},None,[position(symbol='<script>')],[{'symbol':'BTC-261127-60000-P'}]):
            with self.assertRaises(OptionsReadError):validate_positions(value)


if __name__ == '__main__':
    unittest.main()
