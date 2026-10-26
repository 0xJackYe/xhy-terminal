"""Offline Binance wallet tests: synthetic keys, never real requests."""
import copy
from decimal import Decimal, localcontext
import hashlib
import hmac
import io
import json
import ssl
import traceback
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPSHandler

import binance_wallet as module
from binance_wallet import (BALANCE_PATH, PERMISSIONS_PATH, TIME_PATH,
    BinanceWalletClient, BinanceWalletError, _NoRedirect, normalize_wallets,
    validate_read_only_permissions)

KEY, SECRET = 'K'*64, 'S'*64
NOW, OBSERVED = 1700000000.0, '2023-11-14T22:13:20+00:00'
READ = {'enableReading':True,'enableWithdrawals':False,'enableFutures':False,
        'enableVanillaOptions':False,'enableSpotAndMarginTrading':False,
        'enableInternalTransfer':False,'permitsUniversalTransfer':False}


def asset(ccy='BTC', free='0.1234567891234567', locked='0.01', **extra):
    return {'asset':ccy,'assetName':'Display name is ignored','free':free,'locked':locked,
            'freeze':'0','withdrawing':'0','btcValuation':free,**extra}


def wallet(name='Spot', assets=None, balance='0.5', activate=True):
    return {'walletName':name,'activate':activate,'balance':balance,
            'assetBalances':[asset()] if assets is None else assets}


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
            raise AssertionError('Offline mock exhausted')
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def hostile_error(status, code=-1000):
    return HTTPError('https://api.binance.com/?signature=PRIVATE&'+KEY,
        status, SECRET, {}, io.BytesIO(json.dumps({'code':code,'msg':KEY+SECRET}).encode()))


class WalletNormalizationTests(unittest.TestCase):
    def test_multiwallet_exact_quantities_and_valuation_never_mixed(self):
        result=normalize_wallets([wallet(assets=[asset(),asset('USDT','1250','25',btcValuation='0.02')]),
            wallet('Funding',[asset(free='0.002',locked='0')])],OBSERVED)
        self.assertTrue(result['complete']);self.assertEqual(2,result['wallets_count'])
        self.assertEqual('0.1334567891234567',result['assets'][0]['quantity'])
        self.assertEqual('1275',result['assets'][1]['quantity'])
        self.assertEqual('0.02',result['assets'][1]['btc_value'])
        self.assertEqual('Funding',result['assets'][2]['wallet'])
        self.assertEqual(OBSERVED,result['observed_at'])
        self.assertIsNone(result['assets'][0]['usd_value'])

    def test_arithmetic_does_not_depend_on_global_decimal_precision(self):
        with localcontext() as context:
            context.prec=6
            result=normalize_wallets([wallet(assets=[asset(free='9007199254740993.0000000000000001',locked='0.0000000000000001')])],OBSERVED)
        self.assertEqual('9007199254740993.0000000000000002',result['assets'][0]['quantity'])

    def test_btc_equivalent_for_usdt_is_never_counted_as_actual_btc(self):
        result=normalize_wallets([wallet(assets=[asset('USDT','1000','0',btcValuation='0.012')])],OBSERVED)
        self.assertEqual(['USDT'],[row['ccy'] for row in result['assets']])
        self.assertEqual('1000',result['assets'][0]['quantity'])

    def test_wallet_equivalent_cannot_fill_missing_asset_detail(self):
        row=wallet();del row['assetBalances']
        result=normalize_wallets([row],OBSERVED)
        self.assertFalse(result['complete']);self.assertEqual(['Spot'],result['missing_wallets'])
        self.assertEqual([],result['assets'])

    def test_zero_activated_wallet_without_detail_is_unknown_not_empty(self):
        row=wallet(balance='0');del row['assetBalances']
        self.assertFalse(normalize_wallets([row],OBSERVED)['complete'])

    def test_inactive_zero_wallet_is_accepted_as_empty(self):
        row=wallet(balance='0',activate=False);del row['assetBalances']
        result=normalize_wallets([row],OBSERVED)
        self.assertTrue(result['complete']);self.assertEqual([],result['assets'])

    def test_explicit_empty_detail_with_zero_balance_is_real_empty(self):
        result=normalize_wallets([wallet(assets=[],balance='0')],OBSERVED)
        self.assertTrue(result['complete']);self.assertEqual([],result['assets'])

    def test_empty_detail_for_positive_or_negative_balance_is_incomplete(self):
        for value in ['1','-0.1']:
            self.assertFalse(normalize_wallets([wallet(assets=[],balance=value)],OBSERVED)['complete'])

    def test_nonzero_freeze_or_withdrawing_keeps_components_but_does_not_guess(self):
        for field in ['freeze','withdrawing']:
            result=normalize_wallets([wallet(assets=[asset(**{field:'0.03'})])],OBSERVED)
            row=result['assets'][0]
            self.assertFalse(result['complete']);self.assertFalse(row['quantity_complete'])
            self.assertIsNone(row['quantity']);self.assertEqual('0.03',row['components'][field])
            self.assertEqual('0.1234567891234567',row['btc_value'])

    def test_missing_component_preserves_unknown_instead_of_zero(self):
        for field in ['free','locked','freeze','withdrawing']:
            item=asset();del item[field]
            result=normalize_wallets([wallet(assets=[item])],OBSERVED)
            self.assertFalse(result['complete']);self.assertIsNone(result['assets'][0]['quantity'])
            self.assertIsNone(result['assets'][0]['components'][field])

    def test_missing_btc_valuation_does_not_invent_market_price(self):
        item=asset();del item['btcValuation']
        result=normalize_wallets([wallet(assets=[item])],OBSERVED)
        self.assertFalse(result['complete']);self.assertIsNone(result['assets'][0]['btc_value'])
        self.assertEqual('0.1334567891234567',result['assets'][0]['quantity'])

    def test_signed_free_amount_does_not_hide_debt(self):
        result=normalize_wallets([wallet(assets=[asset(free='-0.02',locked='0.001',btcValuation='-0.019')])],OBSERVED)
        self.assertEqual('-0.019',result['assets'][0]['quantity'])
        self.assertEqual('-0.019',result['assets'][0]['btc_value'])

    def test_zero_and_trailing_zeros_normalize_without_scientific_notation(self):
        row=normalize_wallets([wallet(assets=[asset(free='0.0000000000000001',locked='-0.000',btcValuation='0.01000')])],OBSERVED)['assets'][0]
        self.assertEqual('0.0000000000000001',row['quantity']);self.assertEqual('0',row['components']['locked'])
        self.assertEqual('0.01',row['btc_value'])

    def test_invalid_decimal_shapes_are_rejected(self):
        for value in [True,False,0,None,'',' ','NaN','Infinity','1e-8','+1','00.1','.1','<script>','9'*101]:
            with self.subTest(value=type(value).__name__):
                with self.assertRaises(BinanceWalletError):
                    normalize_wallets([wallet(assets=[asset(free=value)])],OBSERVED) if value is not None else normalize_wallets([wallet(balance=value)],OBSERVED)

    def test_duplicate_wallets_or_currencies_fail_without_double_counting(self):
        for data in [[wallet(),wallet()],[wallet(assets=[asset(),asset()])]]:
            with self.assertRaises(BinanceWalletError):normalize_wallets(data,OBSERVED)

    def test_asset_labels_are_not_returned_or_used_for_currency_identity(self):
        item=asset(assetName='<img onerror=alert(1)>')
        result=normalize_wallets([wallet(assets=[item])],OBSERVED)
        self.assertNotIn('onerror',json.dumps(result));self.assertEqual('BTC',result['assets'][0]['ccy'])
        for currency in ['btc','<img>','','BTC/USDT','A'*33]:
            with self.assertRaises(BinanceWalletError):normalize_wallets([wallet(assets=[asset(currency)])],OBSERVED)

    def test_wallet_response_structure_limits_and_activation_are_strict(self):
        for data in [None,{},[],[None],[wallet(activate='true')],[wallet(name='')],[wallet(name='bad\nname')],[wallet(assets={})],[wallet()]*65]:
            with self.assertRaises(BinanceWalletError):normalize_wallets(data,OBSERVED)

    def test_observation_requires_valid_timezone_aware_time(self):
        for stamp in ['',0,'bad','2030-01-01T00:00:00','1900-01-01T00:00:00Z']:
            with self.assertRaises(BinanceWalletError):normalize_wallets([wallet()],stamp)
        self.assertEqual('2030-01-01T00:00:00Z',normalize_wallets([wallet()],'2030-01-01T00:00:00Z')['observed_at'])


class PermissionTests(unittest.TestCase):
    def test_minimum_read_permission_is_required(self):
        for payload in [None,[],{}, {'enableReading':False},{'enableReading':'true'}]:
            with self.assertRaises(BinanceWalletError):validate_read_only_permissions(payload)
        self.assertTrue(validate_read_only_permissions(READ))

    def test_each_dangerous_capability_is_rejected(self):
        for field in module._UNSAFE_FLAGS|{'enableFutureTradingV2','enableExternalWithdrawal','permitsAssetTransfer'}:
            with self.subTest(field=field):
                with self.assertRaises(BinanceWalletError) as found:
                    validate_read_only_permissions({**READ,field:True})
                self.assertEqual('read_only_required',found.exception.code)

    def test_readonly_and_ip_flags_are_allowed_but_malformed_write_flags_are_not(self):
        self.assertTrue(validate_read_only_permissions({**READ,'ipRestrict':True,'enableFixReadOnly':True}))
        for value in ['false',0,None,[]]:
            with self.assertRaises(BinanceWalletError):validate_read_only_permissions({**READ,'enableWithdrawals':value})


class BinanceTransportTests(unittest.TestCase):
    def client(self,*outcomes):
        transport=Transport(*outcomes)
        client=BinanceWalletClient(KEY,SECRET,opener=transport,clock=lambda:NOW,monotonic=lambda:100)
        self.addCleanup(client.close)
        return client,transport

    def full_client(self,balance=None,permissions=None):
        return self.client(Response({'serverTime':int(NOW*1000)}),Response(READ if permissions is None else permissions),Response([wallet()] if balance is None else balance))

    def assert_safe(self,error):
        text=str(error)+repr(error)+repr(error.__dict__)+''.join(traceback.format_exception(type(error),error,error.__traceback__))
        for secret in [KEY,SECRET,'signature=','PRIVATE','https://']:
            self.assertNotIn(secret,text)
        self.assertIsNone(error.__context__)

    def test_constructor_never_connects_or_exposes_credentials(self):
        client,transport=self.client()
        self.assertEqual([],transport.requests);self.assertNotIn(KEY,repr(client));self.assertNotIn(SECRET,repr(client))

    def test_hmac_credentials_are_exactly_64_ascii_alphanumerics(self):
        for value in [None,'','a'*63,'a'*65,'a'*63+'\n','a'*63+'é','a'*63+'_',True]:
            with self.assertRaises(BinanceWalletError):BinanceWalletClient(value,SECRET)
            with self.assertRaises(BinanceWalletError):BinanceWalletClient(KEY,value)
        for timeout in [0,-1,True,float('nan'),float('inf'),21]:
            with self.assertRaises(BinanceWalletError):BinanceWalletClient(KEY,SECRET,timeout=timeout)

    def test_fixed_signed_wallet_request_and_public_unsigned_clock(self):
        client,transport=self.full_client();result=client.fetch_balances()
        self.assertTrue(result['complete']);self.assertEqual(OBSERVED,result['observed_at'])
        self.assertEqual(3,len(transport.requests))
        clock_request=transport.requests[0][0]
        self.assertEqual('https://api.binance.com/api/v3/time',clock_request.full_url)
        self.assertIsNone(clock_request.get_header('X-mbx-apikey'))
        request,timeout=transport.requests[2]
        self.assertEqual('GET',request.get_method());self.assertIsNone(request.data);self.assertEqual(8,timeout)
        self.assertEqual(KEY,request.get_header('X-mbx-apikey'))
        parsed=urlsplit(request.full_url);query=parse_qs(parsed.query)
        self.assertEqual('api.binance.com',parsed.netloc);self.assertEqual(BALANCE_PATH,parsed.path)
        self.assertEqual(['true'],query['needBalanceDetail']);self.assertEqual(['BTC'],query['quoteAsset'])
        unsigned=parsed.query.rsplit('&signature=',1)[0]
        self.assertEqual(hmac.new(SECRET.encode(),unsigned.encode(),hashlib.sha256).hexdigest(),query['signature'][0])
        self.assertNotIn(KEY,request.full_url);self.assertNotIn(SECRET,request.full_url)

    def test_permissions_are_validated_before_reading_any_balances(self):
        client,transport=self.full_client(permissions={**READ,'enableWithdrawals':True})
        with self.assertRaises(BinanceWalletError) as found:client.fetch_balances()
        self.assertEqual('read_only_required',found.exception.code);self.assertEqual(2,len(transport.requests))

    def test_subsequent_reads_recheck_permissions_and_reuse_calibrated_clock(self):
        client,transport=self.full_client();client.fetch_balances()
        transport.outcomes.extend([Response(READ),Response([wallet()])]);client.fetch_balances()
        self.assertEqual([TIME_PATH,PERMISSIONS_PATH,BALANCE_PATH,PERMISSIONS_PATH,BALANCE_PATH],[urlsplit(item[0].full_url).path for item in transport.requests])

    def test_private_request_allowlist_rejects_urls_paths_and_parameter_injection(self):
        client,transport=self.client()
        for path,params in [('https://evil.test',{}),('/api/v3/order',{}),(BALANCE_PATH,{}),(BALANCE_PATH,{'needBalanceDetail':'true','quoteAsset':'BTC','recvWindow':5000,'url':'https://evil.test'}),(TIME_PATH,{'key':KEY})]:
            with self.assertRaises(BinanceWalletError) as found:client._request(path,params,128)
            self.assertEqual('route_rejected',found.exception.code)
        self.assertEqual([],transport.requests)

    def test_all_errors_drop_provider_keys_bodies_urls_and_exception_context(self):
        for outcome in [hostile_error(403,-2015),URLError(KEY+SECRET+'signature=PRIVATE'),Response(raw=b'not-json'),Response(raw=b'{"code":-2015,"msg":"PRIVATE"}',status=401)]:
            client,transport=self.client(outcome,outcome)
            with self.assertRaises(BinanceWalletError) as found:client.sync_time()
            self.assert_safe(found.exception)

    def test_429_and_418_do_not_retry(self):
        for status in [429,418]:
            client,transport=self.client(hostile_error(status))
            with self.assertRaises(BinanceWalletError) as found:client.sync_time()
            self.assertEqual('rate_limited',found.exception.code);self.assertEqual(1,len(transport.requests))

    def test_network_or_server_retry_is_bounded_to_one(self):
        for outcome in [URLError('offline'),hostile_error(503),TimeoutError()]:
            client,transport=self.client(outcome,outcome,outcome)
            with self.assertRaises(BinanceWalletError):client.sync_time()
            self.assertEqual(2,len(transport.requests))

    def test_one_transient_failure_can_recover(self):
        client,transport=self.client(URLError('offline'),Response({'serverTime':int(NOW*1000)}))
        self.assertEqual(0,client.sync_time());self.assertEqual(2,len(transport.requests))

    def test_redirect_cannot_forward_keys(self):
        self.assertIsNone(_NoRedirect().redirect_request(None,None,302,'','', 'https://evil.test'))
        client,transport=self.client(hostile_error(302))
        with self.assertRaises(BinanceWalletError) as found:client.sync_time()
        self.assertEqual('redirect_rejected',found.exception.code);self.assertEqual(1,len(transport.requests));self.assert_safe(found.exception)

    def test_tls_opener_requires_verified_hostname_and_certificates(self):
        client=BinanceWalletClient(KEY,SECRET);self.addCleanup(client.close)
        handlers=[handler for handler in client._opener.handlers if isinstance(handler,HTTPSHandler)]
        self.assertEqual(1,len(handlers));self.assertTrue(handlers[0]._context.check_hostname)
        self.assertEqual(ssl.CERT_REQUIRED,handlers[0]._context.verify_mode)

    def test_duplicate_json_keys_and_nonfinite_constants_are_rejected(self):
        for raw in [b'{"serverTime":1,"serverTime":2}',b'{"serverTime":NaN}',b'{"serverTime":Infinity}',b'null']:
            client,transport=self.client(Response(raw=raw))
            with self.assertRaises(BinanceWalletError):client.sync_time()
            self.assertEqual(1,len(transport.requests))

    def test_oversized_body_is_rejected_without_full_read(self):
        client,transport=self.client(Response(raw=b' '*(module.MAX_RESPONSE_BYTES+2)))
        with self.assertRaises(BinanceWalletError) as found:client.sync_time()
        self.assertEqual('invalid_response',found.exception.code)

    def test_timestamp_error_recalibrates_once_and_resigns(self):
        client,transport=self.client(Response({'serverTime':int(NOW*1000)}),hostile_error(400,-1021),Response({'serverTime':int(NOW*1000)+1000}),Response(READ),Response([wallet()]))
        self.assertTrue(client.fetch_balances()['complete']);self.assertEqual(5,len(transport.requests))
        signatures=[parse_qs(urlsplit(item[0].full_url).query).get('timestamp') for item in transport.requests]
        self.assertEqual([str(int(NOW*1000)+1000)],signatures[3])

    def test_repeated_timestamp_rejection_stops_without_loop(self):
        client,transport=self.client(Response({'serverTime':int(NOW*1000)}),hostile_error(400,-1021),Response({'serverTime':int(NOW*1000)}),hostile_error(400,-1021))
        with self.assertRaises(BinanceWalletError) as found:client.fetch_balances()
        self.assertEqual('clock_error',found.exception.code);self.assertEqual(4,len(transport.requests))

    def test_bad_server_clock_is_rejected(self):
        for stamp in [None,True,'1700000000000',0,-1,10**20]:
            client,transport=self.client(Response({'serverTime':stamp}))
            with self.assertRaises(BinanceWalletError) as found:client.sync_time()
            self.assertEqual('clock_error',found.exception.code)

    def test_deadline_expiry_prevents_transport_call(self):
        client,transport=self.client()
        with self.assertRaises(BinanceWalletError) as found:client._request(TIME_PATH,{},99)
        self.assertEqual('timeout',found.exception.code);self.assertEqual([],transport.requests)

    def test_closed_client_clears_secret_references_and_never_reconnects(self):
        client,transport=self.client();client.close();self.assertIsNone(client._api_key);self.assertIsNone(client._secret)
        with self.assertRaises(BinanceWalletError) as found:client.fetch_balances()
        self.assertEqual('closed',found.exception.code);self.assertEqual([],transport.requests)

    def test_unexpected_http_success_api_failure_is_fixed_error(self):
        client,transport=self.client(Response({'code':-999,'msg':KEY+SECRET}))
        with self.assertRaises(BinanceWalletError) as found:client.sync_time()
        self.assert_safe(found.exception)

    def test_no_secret_storage_logging_or_mutation_routes(self):
        import inspect
        source=inspect.getsource(module)
        for forbidden in ['print(', 'logging.', 'write_text(', 'write_bytes(', 'method="POST"', '/api/v3/order', '/sapi/v1/asset/transfer']:
            self.assertNotIn(forbidden,source)


if __name__=='__main__':
    unittest.main()
