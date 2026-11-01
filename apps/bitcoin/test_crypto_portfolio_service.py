"""Offline exact accounting + real loopback HTTP portfolio regression tests.

All keys/accounts are synthetic. No live credentials or exchange APIs are read.
"""
import copy
import datetime as dt
from decimal import Decimal, localcontext
import http.client
import json
import math
from pathlib import Path
import re
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

from binance_wallet import BinanceWalletError
from btc_terminal_server import TerminalServer
from crypto_portfolio_service import (BinanceVault, CryptoPortfolioService,
                                      aggregate_assets, number)
from okx_wallet_service import WalletError


NOW = 1792800000.0
KEY, SECRET = 'K'*64, 'S'*64
NEW_KEY, NEW_SECRET = 'N'*64, 'T'*64
CREDS = {'api_key':KEY,'secret_key':SECRET}
NEW_CREDS = {'api_key':NEW_KEY,'secret_key':NEW_SECRET}
OKX_CREDS = {'api_key':'SYNTHETIC-OKX-API','secret_key':'SYNTHETIC-OKX-SECRET','passphrase':'SYNTHETIC-PASSPHRASE'}


def stamp(clock=NOW):
    return dt.datetime.fromtimestamp(clock,dt.timezone.utc).isoformat()


def row(ccy='BTC', quantity='1', usd='100', location='offline'):
    return {'ccy':ccy,'quantity':quantity,'usd_value':usd,'location':location}


def sources(**statuses):
    return [{'id':name,'status':statuses.get(name,'connected')} for name in ['offline','okx','binance']]


def binance_data(rows=None, complete=True):
    return {'assets':[{'ccy':'USDT','quantity':'20','btc_value':'0.0002','usd_value':None,'wallet':'Spot'}] if rows is None else rows,
            'complete':complete,'observed_at':stamp(),'missing_wallets':[],'wallets_count':1}


class Clock:
    def __init__(self):self.now=NOW
    def __call__(self):return self.now


class MemoryVault:
    def __init__(self,credentials=None):
        self.credentials=copy.deepcopy(CREDS if credentials is None else credentials);self.saves=[]
    def read(self):return copy.deepcopy(self.credentials)
    def save(self,credentials):
        if (not isinstance(credentials,dict) or set(credentials)!={'api_key','secret_key'}
                or any(not isinstance(value,str) or not re.fullmatch('[A-Za-z0-9]{64}',value) for value in credentials.values())):
            raise WalletError('credentials_invalid','本机测试凭据格式无效。')
        self.saves.append(copy.deepcopy(credentials));self.credentials=copy.deepcopy(credentials)


class FakeOKX:
    def __init__(self):
        self.lock=threading.RLock();self.credentials=copy.deepcopy(OKX_CREDS)
        self.connection='okx-synthetic-A';self.configured=True;self.calls=[];self.closed=[]
        self.started=self.release=None;self.failure=None
        self.public={};self.after_read=None
        self.data={'assets':[{'ccy':'BTC','quantity':'0.001','usd_value':'777'},
                             {'ccy':'ETH','quantity':'0.01','usd_value':'30'}], 'complete':True}
    def read_public(self):return {'configured':self.configured,'connection_id':self.connection,**copy.deepcopy(self.public)}
    def switch(self):
        with self.lock:self.connection='okx-synthetic-B';self.credentials={'api_key':'OKX-B','secret_key':'OKX-B-SECRET','passphrase':'OKX-B-PASS'}
    def client_factory(self,credentials):
        parent=self;captured=copy.deepcopy(self.data);failure=self.failure
        parent.calls.append(copy.deepcopy(credentials))
        class Client:
            def read_valued_assets(self):
                if parent.started:parent.started.set()
                if parent.release:parent.release.wait(2)
                if failure:raise failure
                if parent.after_read:parent.after_read()
                return copy.deepcopy(captured)
            def close(self):parent.closed.append(True)
        return Client()


class FakeBinanceFactory:
    def __init__(self):
        self.calls=[];self.closed=[];self.data=binance_data();self.failure=None
        self.started=self.release=None
    def __call__(self,api_key,secret_key):
        parent=self;captured=copy.deepcopy(self.data);failure=self.failure
        self.calls.append((api_key,secret_key))
        class Client:
            def fetch_balances(self):
                if parent.started:parent.started.set()
                if parent.release:parent.release.wait(2)
                if failure:raise failure
                return copy.deepcopy(captured)
            def close(self):parent.closed.append(True)
        return Client()


def fixture(credentials=None):
    clock=Clock();vault=MemoryVault(credentials);okx=FakeOKX();factory=FakeBinanceFactory()
    snapshot={'fetchedAt':stamp(clock()),'quote':{'USD':'100000','time':clock()},
              'summary':{'chain_stats':{'funded_txo_sum':1000000,'spent_txo_sum':0}}}
    combined=types.SimpleNamespace(source=types.SimpleNamespace(snapshot=snapshot))
    service=CryptoPortfolioService(okx,combined,vault=vault,binance_factory=factory,clock=clock)
    return types.SimpleNamespace(service=service,clock=clock,vault=vault,okx=okx,factory=factory,combined=combined)


def private_values():return [KEY,SECRET,NEW_KEY,NEW_SECRET,*OKX_CREDS.values()]


class AggregateAssetsTests(unittest.TestCase):
    def test_a_caseless_listing_name_joins_the_portfolio_instead_of_failing_it(self):
        result=aggregate_assets([row('币安人生','1000','12','binance'),row('BTC','1','100','offline')],sources(),int(NOW*1000))
        self.assertIn('币安人生',[item['ccy'] for item in result['assets']])
        with self.assertRaises(ValueError):aggregate_assets([row('btc','1','100','offline')],sources(),int(NOW*1000))

    def test_threshold_is_applied_after_cross_location_coin_aggregation(self):
        result=aggregate_assets([row('ETH','1','3','okx'),row('ETH','1','3','binance')],sources(),int(NOW*1000))
        self.assertEqual('6',result['total_usd']);self.assertEqual(['ETH'],[item['ccy'] for item in result['assets']])
        self.assertEqual('2',result['assets'][0]['quantity']);self.assertEqual(2,len(result['locations']))
        self.assertEqual([50,50],[item['percentage'] for item in result['locations']])

    def test_exact_five_is_included_and_just_below_five_excluded(self):
        result=aggregate_assets([row('BTC','0.00005','5'),row('ETH','0.001','4.999999999999999999999999')],sources(),int(NOW*1000))
        self.assertEqual('5',result['total_usd']);self.assertEqual('5',result['threshold_usd'])
        self.assertEqual('4.999999999999999999999999',result['excluded_usd'])
        self.assertEqual(['BTC'],[item['ccy'] for item in result['assets']])

    def test_two_coin_legs_with_dust_remain_eligible_together(self):
        result=aggregate_assets([row('BTC','0.00003','3','offline'),row('BTC','0.00002','2','okx'),row('ETH','0.001','4','binance')],sources(),int(NOW*1000))
        self.assertEqual('5',result['total_usd']);self.assertEqual('4',result['excluded_usd'])
        self.assertEqual({'offline','okx'},{item['id'] for item in result['locations']})
        self.assertEqual('0.00005',result['assets'][0]['quantity'])

    def test_unpriced_coin_is_not_silently_counted_as_zero_or_partial_value(self):
        result=aggregate_assets([row('BTC','1','100','offline'),row('BTC','1',None,'binance'),row('ETH','1','30','okx')],sources(),int(NOW*1000))
        self.assertEqual('30',result['total_usd']);self.assertFalse(result['complete'])
        self.assertEqual(['BTC'],result['unpriced_currencies']);self.assertEqual(['ETH'],[item['ccy'] for item in result['assets']])

    def test_real_zero_quantity_with_no_valuation_is_not_an_unknown_holding(self):
        result=aggregate_assets([row('BTC','0',None)],sources(),int(NOW*1000))
        self.assertTrue(result['complete']);self.assertEqual([],result['unpriced_currencies'])
        self.assertEqual('0',result['total_usd']);self.assertEqual([],result['assets'])

    def test_unknown_quantity_keeps_known_valuation_and_marks_quantity_unknown(self):
        result=aggregate_assets([row('ETH',None,'10','okx')],sources(),int(NOW*1000))
        self.assertEqual('10',result['total_usd']);self.assertIsNone(result['assets'][0]['quantity'])

    def test_signed_liabilities_are_reported_and_not_positive_asset_slices(self):
        result=aggregate_assets([row('BTC','1','100'),row('USDT','-20','-20','okx')],sources(),int(NOW*1000))
        self.assertFalse(result['complete']);self.assertEqual('20',result['liabilities_usd'])
        self.assertEqual(['BTC'],[item['ccy'] for item in result['assets']]);self.assertEqual('100',result['total_usd'])

    def test_negative_coin_leg_disables_misleading_location_pie_and_reports_debt(self):
        result=aggregate_assets([row('BTC','1','100','offline'),row('BTC','-0.2','-20','okx')],sources(),int(NOW*1000))
        total=Decimal(result['total_usd'])
        self.assertEqual(total,sum((Decimal(item['usd_value']) for item in result['assets']),Decimal(0)))
        self.assertEqual([],result['locations']);self.assertFalse(result['location_allocation_complete'])
        self.assertEqual('20',result['liabilities_usd']);self.assertFalse(result['complete'])
        self.assertAlmostEqual(100,sum(item['percentage'] for item in result['assets']),places=9)

    def test_sub_five_net_liability_is_filtered_before_allocation_health(self):
        result=aggregate_assets([row('BTC','1','100','offline'),row('BNB','0','-0.306','binance')],sources(),int(NOW*1000))
        self.assertTrue(result['complete']);self.assertTrue(result['location_allocation_complete'])
        self.assertEqual('0',result['liabilities_usd']);self.assertEqual('0.306',result['excluded_liabilities_usd'])
        self.assertEqual('100',result['total_usd']);self.assertEqual(['BTC'],[item['ccy'] for item in result['assets']])
        self.assertAlmostEqual(100,sum(item['percentage'] for item in result['locations']),places=9)

    def test_exact_negative_five_is_material_but_tiny_fraction_below_is_excluded(self):
        result=aggregate_assets([row('BTC','1','100'),row('BNB','-1','-5','binance'),row('ETH','-1','-4.999999999999999999999','okx')],sources(),int(NOW*1000))
        self.assertFalse(result['complete']);self.assertEqual('5',result['liabilities_usd'])
        self.assertEqual('4.999999999999999999999',result['excluded_liabilities_usd'])
        self.assertEqual('100',result['total_usd']);self.assertTrue(result['location_allocation_complete'])

    def test_offsetting_legs_for_excluded_coin_do_not_disable_location_pie(self):
        result=aggregate_assets([row('BTC','1','100'),row('BNB','1','10','okx'),row('BNB','-0.6','-6','binance')],sources(),int(NOW*1000))
        self.assertTrue(result['complete']);self.assertTrue(result['location_allocation_complete'])
        self.assertEqual('4',result['excluded_usd']);self.assertEqual('0',result['liabilities_usd'])
        self.assertEqual(['BTC'],[item['ccy'] for item in result['assets']])

    def test_even_small_negative_leg_for_selected_coin_blocks_invalid_pie(self):
        result=aggregate_assets([row('BTC','1','10.3'),row('BTC','-0.03','-0.3','okx')],sources(),int(NOW*1000))
        self.assertFalse(result['complete']);self.assertFalse(result['location_allocation_complete'])
        self.assertEqual([],result['locations']);self.assertEqual('0.3',result['liabilities_usd'])
        self.assertEqual(Decimal('10'),Decimal(result['total_usd']))

    def test_percentages_sum_to_one_hundred_for_both_views(self):
        result=aggregate_assets([row('BTC','1','101','offline'),row('BTC','0.1','11','okx'),row('ETH','1','17','okx'),row('USDT','29','29','binance'),row('ETH','0.2','4','binance')],sources(),int(NOW*1000))
        self.assertAlmostEqual(100,sum(item['percentage'] for item in result['assets']),places=9)
        self.assertAlmostEqual(100,sum(item['percentage'] for item in result['locations']),places=9)
        for key in ['assets','locations']:
            self.assertEqual(Decimal(result['total_usd']),sum((Decimal(item['usd_value']) for item in result[key]),Decimal(0)))

    def test_financial_sums_are_independent_of_ambient_decimal_precision(self):
        with localcontext() as context:
            context.prec=5
            result=aggregate_assets([row('BTC','0.1234567891234567','12345.67891234567'),row('BTC','0.0000000000000001','5.00000000000000001','okx')],sources(),int(NOW*1000))
        self.assertEqual('0.1234567891234568',result['assets'][0]['quantity'])
        self.assertEqual('12350.67891234567000001',result['total_usd'])

    def test_invalid_valuation_does_not_become_zero(self):
        for value in [None,True,False,'NaN','Infinity','bad',{},[]]:
            self.assertIsNone(number(value))
            result=aggregate_assets([row('BTC','1',value)],sources(),int(NOW*1000))
            self.assertEqual(['BTC'],result['unpriced_currencies']);self.assertFalse(result['complete'])

    def test_invalid_currency_and_location_cannot_enter_portfolio(self):
        for value in [row('<img>'),row('BTC',location='evil')]:
            with self.assertRaises(ValueError):aggregate_assets([value],sources(),int(NOW*1000))

    def test_source_availability_remains_distinct_from_numeric_totals(self):
        for status in ['needs_credentials','connecting','error','stale']:
            result=aggregate_assets([row()],sources(binance=status),int(NOW*1000))
            self.assertFalse(result['complete']);self.assertEqual('100',result['total_usd'])
            self.assertEqual(status in ['error','stale'],result['stale'])

    def test_coin_ordering_is_value_descending_then_currency(self):
        result=aggregate_assets([row('USDT','10','10'),row('ETH','1','20'),row('BTC','0.1','20')],sources(),int(NOW*1000))
        self.assertEqual(['BTC','ETH','USDT'],[item['ccy'] for item in result['assets']])

    def test_asset_extra_fields_never_leak_upstream_credentials(self):
        data=dict(row(),secret_key=SECRET,api_key=KEY,passphrase=OKX_CREDS['passphrase'])
        result=aggregate_assets([data],sources(),int(NOW*1000))
        for secret in private_values():self.assertNotIn(secret,json.dumps(result))


class ServiceTests(unittest.TestCase):
    def setUp(self):self.f=fixture();self.service=self.f.service
    def tearDown(self):
        for factory in [self.f.okx,self.f.factory]:
            if factory.release:factory.release.set()
        self.service.stop()
    def test_initial_public_state_has_no_fabricated_total_or_secrets(self):
        result=self.service.read_public();self.assertIsNone(result['total_usd']);self.assertTrue(result['stale'])
        self.assertEqual([],result['assets']);self.assertTrue(result['binance']['configured'])
        self.assert_no_secret(result)
    def assert_no_secret(self,result):
        for secret in private_values():self.assertNotIn(secret,json.dumps(result))
    def test_refresh_uses_same_btc_usd_price_across_all_locations(self):
        self.f.factory.data=binance_data([{'ccy':'BTC','quantity':'0.002','usd_value':'1','btc_value':'999','wallet':'Spot'}])
        self.assertTrue(self.service.refresh_once());result=self.service.read_public()
        self.assertEqual(Decimal('1330'),Decimal(result['total_usd']))
        btc=next(item for item in result['assets'] if item['ccy']=='BTC')
        self.assertEqual(Decimal('0.013'),Decimal(btc['quantity']));self.assertEqual(Decimal('1300'),Decimal(btc['usd_value']))
        self.assert_no_secret(result)
    def test_okx_public_cash_net_btc_overrides_independent_inventory_read(self):
        self.f.okx.public={'summary':{'btc_holdings_total':'0.0024691234567891'},'last_success_at':stamp(),'status':'connected'}
        self.f.okx.data['assets'][0]['quantity']='0.0099999999999999'
        self.service.refresh_once();result=self.service.read_public()
        btc=next(item for item in result['assets'] if item['ccy']=='BTC')
        self.assertEqual(Decimal('0.0124691234567891'),Decimal(btc['quantity']))
        self.assertEqual(Decimal('1246.9123456789100000'),Decimal(btc['usd_value']))
        source=next(item for item in result['sources'] if item['id']=='okx')
        self.assertEqual('wallet_summary_cash_net',source['btc_basis']);self.assertEqual(stamp(),source['btc_snapshot_at'])
        self.assertEqual('0.0024691234567891',source['btc_quantity'])
    def test_okx_public_btc_zero_replaces_stale_nonzero_inventory(self):
        self.f.okx.public={'summary':{'btc_holdings_total':'0'},'status':'connected'}
        self.service.refresh_once();btc=next(item for item in self.service.read_public()['assets'] if item['ccy']=='BTC')
        self.assertEqual(Decimal('0.01'),Decimal(btc['quantity']));self.assertEqual(Decimal('1000'),Decimal(btc['usd_value']))
    def test_okx_public_btc_is_created_if_valued_inventory_omits_btc(self):
        self.f.okx.public={'summary':{'btc_holdings_total':'0.002'},'status':'connected'}
        self.f.okx.data['assets']=[item for item in self.f.okx.data['assets'] if item['ccy']!='BTC']
        self.service.refresh_once();result=self.service.read_public();btc=next(item for item in result['assets'] if item['ccy']=='BTC')
        self.assertEqual(Decimal('0.012'),Decimal(btc['quantity']))
        self.assertTrue(any(item['ccy']=='ETH' for item in result['assets']))
    def test_duplicate_inventory_btc_legs_do_not_repeat_total_public_btc(self):
        self.f.okx.public={'summary':{'btc_holdings_total':'0.002'},'status':'connected'}
        self.f.okx.data['assets'].append({'ccy':'BTC','quantity':'0.1','usd_value':'10000'})
        self.service.refresh_once();btc=next(item for item in self.service.read_public()['assets'] if item['ccy']=='BTC')
        self.assertEqual(Decimal('0.012'),Decimal(btc['quantity']))
    def test_present_invalid_btc_summary_does_not_fall_back_to_other_snapshot(self):
        for summary in [None,{}, {'btc_holdings_total':None},{'btc_holdings_total':'bad'},{'btc_holdings_total':True}]:
            with self.subTest(summary=summary):
                self.f=fixture();self.service=self.f.service;self.f.okx.public={'summary':summary,'status':'connected'}
                self.service.refresh_once();result=self.service.read_public()
                self.assertEqual(['BTC'],result['unpriced_currencies']);self.assertFalse(result['complete'])
                self.assertNotIn('BTC',[item['ccy'] for item in result['assets']])
                self.assertEqual('partial',next(item['status'] for item in result['sources'] if item['id']=='okx'))
    def test_public_btc_remains_usable_if_other_coin_valuation_fails(self):
        self.f.okx.public={'summary':{'btc_holdings_total':'0.002'},'status':'connected'}
        self.f.okx.failure=RuntimeError(OKX_CREDS['secret_key']);self.service.refresh_once();result=self.service.read_public()
        btc=next(item for item in result['assets'] if item['ccy']=='BTC')
        self.assertEqual(Decimal('0.012'),Decimal(btc['quantity']));self.assertFalse(result['complete'])
        self.assertEqual('error',next(item['status'] for item in result['sources'] if item['id']=='okx'));self.assert_no_secret(result)
    def test_latest_same_account_public_btc_snapshot_after_inventory_read_is_used(self):
        self.f.okx.public={'summary':{'btc_holdings_total':'0.002'},'status':'connected'}
        self.f.okx.after_read=lambda:self.f.okx.public.update(summary={'btc_holdings_total':'0.003'})
        self.service.refresh_once();btc=next(item for item in self.service.read_public()['assets'] if item['ccy']=='BTC')
        self.assertEqual(Decimal('0.013'),Decimal(btc['quantity']))
    def test_stale_public_btc_state_marks_source_stale_even_with_fresh_inventory(self):
        self.f.okx.public={'summary':{'btc_holdings_total':'0.002'},'status':'stale','last_success_at':stamp(NOW-100)}
        self.service.refresh_once();result=self.service.read_public()
        self.assertTrue(result['stale']);self.assertFalse(result['complete'])
        self.assertEqual('stale',next(item['status'] for item in result['sources'] if item['id']=='okx'))
    def test_non_btc_binance_asset_uses_documented_btc_valuation_without_usdt_peg(self):
        self.service.refresh_once();result=self.service.read_public()
        usdt=next(item for item in result['assets'] if item['ccy']=='USDT')
        self.assertEqual(Decimal('20'),Decimal(usdt['usd_value']))
        self.f.clock.now+=61;self.f.factory.data['assets'][0]['btc_value']='0.00019'
        self.service.refresh_once();usdt=next(item for item in self.service.read_public()['assets'] if item['ccy']=='USDT')
        self.assertEqual(Decimal('19'),Decimal(usdt['usd_value']))
    def test_missing_market_quote_does_not_invent_offline_value(self):
        self.f.combined.source.snapshot['quote']={};self.service.refresh_once();result=self.service.read_public()
        self.assertFalse(result['complete']);self.assertIn('USDT',result['unpriced_currencies'])
        self.assertEqual('error',next(source['status'] for source in result['sources'] if source['id']=='offline'))
    def test_public_reads_are_cached_and_do_not_call_exchange_factories(self):
        self.service.refresh_once()
        for _ in range(10):self.service.read_public()
        self.assertEqual(1,len(self.f.factory.calls));self.assertEqual(1,len(self.f.okx.calls))
        self.service.refresh_once();self.assertEqual(1,len(self.f.factory.calls));self.assertEqual(1,len(self.f.okx.calls))
    def test_fresh_data_age_marks_cached_public_result_stale(self):
        self.service.refresh_once();original=self.service.read_public();self.f.clock.now+=181
        current=self.service.read_public();self.assertTrue(current['stale']);self.assertEqual(original['assets'],current['assets'])
    def test_returned_snapshots_are_deep_copies(self):
        self.service.refresh_once();result=self.service.read_public();result['assets'][0]['quantity']='PRIVATE';result['sources'].clear()
        current=self.service.read_public();self.assertNotEqual('PRIVATE',current['assets'][0]['quantity']);self.assertTrue(current['sources'])
    def test_failed_binance_refresh_retains_cache_marks_source_stale_and_closes_client(self):
        self.service.refresh_once();before=self.service.read_public();self.f.clock.now+=61
        self.f.factory.failure=BinanceWalletError('permission_denied');self.service.refresh_once();after=self.service.read_public()
        self.assertEqual(before['assets'],after['assets']);self.assertTrue(after['stale']);self.assertFalse(after['complete'])
        self.assertEqual('stale',next(item['status'] for item in after['sources'] if item['id']=='binance'))
        self.assertEqual(2,len(self.f.factory.closed));self.assert_no_secret(after)
    def test_failed_okx_refresh_preserves_last_asset_values(self):
        self.service.refresh_once();before=self.service.read_public();self.f.clock.now+=61
        self.f.okx.failure=RuntimeError(OKX_CREDS['secret_key']);self.service.refresh_once();after=self.service.read_public()
        self.assertEqual(before['assets'],after['assets']);self.assertEqual('stale',next(item['status'] for item in after['sources'] if item['id']=='okx'))
        self.assert_no_secret(after)
    def test_unexpected_binance_exception_is_redacted(self):
        self.f.factory.failure=RuntimeError(KEY+SECRET+'PRIVATE');self.service.refresh_once();result=self.service.read_public()
        self.assertEqual('network_error',result['binance']['error_code']);self.assert_no_secret(result)
        self.assertNotIn('PRIVATE',json.dumps(result))
    def test_pending_single_key_never_calls_private_binance_client(self):
        self.service.credentials={'api_key':KEY};self.service.refresh_once();result=self.service.read_public()
        self.assertEqual([],self.f.factory.calls);self.assertTrue(result['binance']['pending_credentials'])
        self.assertEqual(['secret_key'],result['binance']['missing_fields']);self.assertFalse(result['complete'])
    def test_configuration_clears_old_account_cache_and_wakes_worker(self):
        self.service.refresh_once();self.service.configure_binance(NEW_CREDS)
        self.assertEqual(NEW_CREDS,self.f.vault.credentials);self.assertEqual(1,self.service.generation)
        self.assertIsNone(self.service.binance_data);self.assertIsNone(self.service.view);self.assertTrue(self.service.wake.is_set())
        self.assert_no_secret(self.service.read_public())
    def test_invalid_configuration_cannot_replace_active_pair(self):
        for body in [None,[],{}, {'api_key':'bad'},{'secret_key':True},{'url':'https://evil.invalid'}]:
            with self.assertRaises(WalletError):self.service.configure_binance(body)
        self.assertEqual(CREDS,self.service.credentials);self.assertEqual([],self.f.vault.saves)
    def test_storage_failure_preserves_credentials_generation_and_snapshot(self):
        self.service.refresh_once();before=self.service.read_public()
        with patch.object(self.f.vault,'save',side_effect=WalletError('storage','存储不可用。',503)):
            with self.assertRaises(WalletError):self.service.configure_binance(NEW_CREDS)
        self.assertEqual(CREDS,self.service.credentials);self.assertEqual(0,self.service.generation);self.assertEqual(before,self.service.read_public())
    def test_inflight_old_binance_account_result_never_publishes_after_reconfigure(self):
        self.f.factory.started,self.f.factory.release=threading.Event(),threading.Event()
        self.f.factory.data=binance_data([{'ccy':'OLDC','quantity':'10','usd_value':'100','btc_value':'0.001','wallet':'Spot'}])
        thread=threading.Thread(target=self.service.refresh_once);thread.start()
        try:
            self.assertTrue(self.f.factory.started.wait(1));self.service.configure_binance(NEW_CREDS)
        finally:self.f.factory.release.set();thread.join(2)
        self.assertFalse(thread.is_alive());result=self.service.read_public()
        self.assertIsNone(self.service.binance_data);self.assertNotIn('OLDC',json.dumps(result));self.assert_no_secret(result)
    def test_inflight_old_okx_account_result_never_publishes_after_connection_change(self):
        self.f.okx.started,self.f.okx.release=threading.Event(),threading.Event()
        self.f.okx.data={'assets':[{'ccy':'OLDC','quantity':'10','usd_value':'100'}],'complete':True}
        thread=threading.Thread(target=self.service.refresh_once);thread.start()
        try:
            self.assertTrue(self.f.okx.started.wait(1));self.f.okx.switch()
        finally:self.f.okx.release.set();thread.join(2)
        self.assertFalse(thread.is_alive());self.assertNotIn('OLDC',json.dumps(self.service.read_public()))
    def test_partial_exchange_inventory_keeps_known_rows_but_incomplete_source(self):
        self.f.factory.data['complete']=False;self.service.refresh_once();result=self.service.read_public()
        self.assertFalse(result['complete']);self.assertTrue(any(item['ccy']=='USDT' for item in result['assets']))
        self.assertEqual('partial',next(item['status'] for item in result['sources'] if item['id']=='binance'))
    def test_long_fraction_btc_just_below_five_is_never_rounded_into_eligibility(self):
        quantity='0.0000499999999999999999999999999999999999'
        with localcontext() as context:
            context.prec=256;expected=Decimal(quantity)*Decimal('100000')
        for origin in ['okx_btc','binance_btc','binance_equivalent']:
            with self.subTest(origin=origin):
                self.f=fixture();self.service=self.f.service
                self.f.combined.source.snapshot['summary']['chain_stats']['funded_txo_sum']=0
                self.f.okx.data={'assets':[],'complete':True};self.f.factory.data=binance_data([])
                if origin=='okx_btc':
                    self.f.okx.data['assets']=[{'ccy':'BTC','quantity':quantity,'usd_value':'999'}]
                else:
                    self.f.factory.data=binance_data([{'ccy':'BTC' if origin=='binance_btc' else 'ETH',
                        'quantity':quantity if origin=='binance_btc' else '1','usd_value':None,'btc_value':quantity,'wallet':'Spot'}])
                self.service.refresh_once();result=self.service.read_public()
                self.assertEqual([],result['assets']);self.assertEqual('0',result['total_usd'])
                self.assertEqual(expected,Decimal(result['excluded_usd']))
    def test_offline_price_precision_just_below_five_remains_excluded(self):
        self.f.okx.data={'assets':[],'complete':True};self.f.factory.data=binance_data([])
        self.f.combined.source.snapshot['summary']['chain_stats']['funded_txo_sum']=1
        price='499999999.99999999999999999999999999999999999'
        self.f.combined.source.snapshot['quote']['USD']=price
        with localcontext() as context:
            context.prec=256;expected=Decimal(price)/Decimal(100000000)
        self.service.refresh_once();result=self.service.read_public()
        self.assertEqual([],result['assets']);self.assertEqual(expected,Decimal(result['excluded_usd']))
    def test_valuation_paths_are_independent_of_ambient_decimal_precision(self):
        self.f.okx.data={'assets':[{'ccy':'BTC','quantity':'0.00001234567891234567','usd_value':'999'}],'complete':True}
        self.f.factory.data=binance_data([{'ccy':'BTC','quantity':'0.00008765432108765434','usd_value':'1','btc_value':'0','wallet':'Spot'}])
        with localcontext() as context:
            context.prec=5;self.service.refresh_once()
        result=self.service.read_public();btc=next(item for item in result['assets'] if item['ccy']=='BTC')
        self.assertEqual(Decimal('0.01010000000000000001'),Decimal(btc['quantity']))
        self.assertEqual(Decimal('1010.00000000000000100'),Decimal(btc['usd_value']))
    def test_binance_source_note_distinguishes_connecting_pending_and_error(self):
        self.service.binance_at=self.f.clock();self.service.refresh_once()
        source=next(item for item in self.service.read_public()['sources'] if item['id']=='binance')
        self.assertEqual('connecting',source['status']);self.assertNotIn('仅收到一串',source['note'])
        self.assertRegex(source['note'],'同步|连接')
        self.service.credentials={'api_key':KEY};self.service.refresh_once()
        source=next(item for item in self.service.read_public()['sources'] if item['id']=='binance')
        self.assertEqual('needs_credentials',source['status']);self.assertRegex(source['note'],'Secret|配套')
        self.service.credentials=dict(CREDS);self.service.binance_error='permission_denied';self.service.refresh_once()
        source=next(item for item in self.service.read_public()['sources'] if item['id']=='binance')
        self.assertEqual('error',source['status']);self.assertNotIn('仅收到一串',source['note'])
        self.assert_no_secret(source)
    def test_old_offline_snapshot_is_visibly_stale(self):
        self.f.combined.source.snapshot['fetchedAt']=stamp(NOW-601);self.service.refresh_once();result=self.service.read_public()
        self.assertTrue(result['stale']);self.assertEqual('stale',next(item['status'] for item in result['sources'] if item['id']=='offline'))


class VaultTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.patch=patch('crypto_portfolio_service.DIRECTORY',Path(self.directory.name)/'okx-wallet');self.patch.start();self.addCleanup(self.patch.stop)
        self.vault=BinanceVault(seal=lambda data:b'FAKE-ENCRYPTED'+data[::-1],unseal=lambda data:data[14:][::-1])
    def test_ciphertext_only_write_roundtrips_pair_without_plaintext(self):
        self.vault.save(CREDS);self.assertEqual(CREDS,self.vault.read())
        text=(self.vault.directory/'credentials.protected.json').read_text()
        self.assertIn('ciphertext',text);self.assertNotIn(KEY,text);self.assertNotIn(SECRET,text)
    def test_corrupted_vault_never_returns_partial_or_raw_secret(self):
        self.vault.save(CREDS);(self.vault.directory/'credentials.protected.json').write_text('broken')
        self.assertEqual({},self.vault.read())
    def test_invalid_pair_never_replaces_existing_ciphertext(self):
        self.vault.save(CREDS);before=(self.vault.directory/'credentials.protected.json').read_bytes()
        for body in [{'api_key':KEY},{'api_key':'bad','secret_key':SECRET},{**CREDS,'url':'https://evil.invalid'}]:
            with self.assertRaises(WalletError):self.vault.save(body)
        self.assertEqual(before,(self.vault.directory/'credentials.protected.json').read_bytes())


class Monitor:
    def read(self):return {'settings':{'threshold_pct':2.5}}


class Loopback:
    def __init__(self,service):
        self.server=TerminalServer(('127.0.0.1',0),Monitor(),None);self.server.portfolio_service=service
        self.port=self.server.server_port;self.host='127.0.0.1:%s'%self.port;self.origin='http://'+self.host
        self.thread=threading.Thread(target=lambda:self.server.serve_forever(poll_interval=.01),daemon=True);self.thread.start()
    def close(self):
        self.server.stopping.set();self.server.shutdown();self.server.server_close();self.thread.join(1)
    def call(self,path='/api/wallet/portfolio',method='GET',value=None,raw=None,headers=None,extra=()):
        if raw is None:raw=json.dumps(value).encode() if value is not None else b''
        pairs=[('Host',self.host)]
        if method=='POST':pairs += [('Origin',self.origin),('X-Terminal-Request','1'),('Content-Type','application/json'),('Content-Length',str(len(raw)))]
        for key,value in (headers or {}).items():
            pairs=[(name,current) for name,current in pairs if name.lower()!=key.lower()]
            if value is not None:pairs.append((key,value))
        pairs += list(extra);connection=http.client.HTTPConnection('127.0.0.1',self.port,timeout=3)
        try:
            connection.putrequest(method,path,skip_host=True,skip_accept_encoding=True)
            for key,value in pairs:connection.putheader(key,value)
            connection.endheaders(raw);response=connection.getresponse();body=response.read()
            try:body=json.loads(body)
            except (ValueError,UnicodeError):body=body.decode(errors='replace')
            return response.status,response.headers,body
        finally:connection.close()


class PortfolioHTTPTests(unittest.TestCase):
    def setUp(self):self.f=fixture();self.service=self.f.service;self.server=Loopback(self.service)
    def tearDown(self):self.server.close();self.service.stop()
    def assert_no_secret(self,body,headers=None):
        result=json.dumps(body)+str(headers or '')
        for secret in private_values():self.assertNotIn(secret,result)
    def test_get_is_cached_loopback_only_and_has_no_store_headers(self):
        self.service.refresh_once();status,headers,body=self.server.call()
        self.assertEqual(200,status);self.assertEqual('no-store',headers['Cache-Control']);self.assertEqual('nosniff',headers['X-Content-Type-Options'])
        self.assertEqual('no-referrer',headers['Referrer-Policy']);self.assertIsNone(headers.get('Access-Control-Allow-Origin'));self.assert_no_secret(body,headers)
        for _ in range(4):self.assertEqual(200,self.server.call()[0])
        self.assertEqual(1,len(self.f.factory.calls))
    def test_configuration_response_never_echoes_posted_pair(self):
        status,headers,body=self.server.call('/api/wallet/binance/config','POST',NEW_CREDS)
        self.assertEqual(200,status);self.assertTrue(body['configured']);self.assertEqual(NEW_CREDS,self.f.vault.credentials);self.assert_no_secret(body,headers)
    def test_foreign_origin_and_dns_rebinding_are_rejected_before_configuration(self):
        for headers in [{'Host':'evil.invalid'},{'Host':'127.0.0.1:1'},{'Host':None},{'Origin':'null'},{'Origin':'http://evil.invalid'},{'Origin':'https://'+self.server.host}]:
            self.assertEqual(403,self.server.call(headers=headers)[0]);status,response,body=self.server.call('/api/wallet/binance/config','POST',NEW_CREDS,headers=headers)
            self.assertEqual(403,status);self.assert_no_secret(body,response)
        self.assertEqual([],self.f.vault.saves)
    def test_duplicate_origin_host_or_security_headers_are_rejected(self):
        for pair in [('Host',self.server.host),('Origin',self.server.origin),('X-Terminal-Request','1'),('Content-Type','application/json')]:
            self.assertEqual(403,self.server.call('/api/wallet/binance/config','POST',NEW_CREDS,extra=[pair])[0])
        self.assertEqual([],self.f.vault.saves)
    def test_write_requires_exact_terminal_header_and_json_content_type(self):
        for headers in [{'X-Terminal-Request':None},{'X-Terminal-Request':'true'},{'Content-Type':None},{'Content-Type':'text/plain'}]:
            self.assertEqual(403,self.server.call('/api/wallet/binance/config','POST',NEW_CREDS,headers=headers)[0])
        self.assertEqual([],self.f.vault.saves)
    def test_invalid_json_duplicate_fields_and_nonobject_payloads_are_rejected(self):
        for raw in [b'bad',b'[]',b'null',b'\xff',b'{"api_key":"x","api_key":"y"}',b'{}']:
            status,headers,body=self.server.call('/api/wallet/binance/config','POST',raw=raw)
            self.assertEqual(400,status);self.assert_no_secret(body,headers)
        self.assertEqual([],self.f.vault.saves)
    def test_content_lengths_and_chunking_are_rejected_without_mutation(self):
        for headers in [{'Content-Length':None},{'Content-Length':'-1'},{'Content-Length':'4097'},{'Content-Length':'NaN'},{'Transfer-Encoding':'chunked'}]:
            self.assertEqual(400,self.server.call('/api/wallet/binance/config','POST',NEW_CREDS,headers=headers)[0])
        self.assertEqual(400,self.server.call('/api/wallet/binance/config','POST',NEW_CREDS,extra=[('Content-Length','2')])[0]);self.assertEqual([],self.f.vault.saves)
    def test_query_parameters_are_never_forwarded_to_private_api(self):
        for path,method in [('/api/wallet/portfolio?url=https://evil.invalid','GET'),('/api/wallet/binance/config?api_key=PRIVATE','POST')]:
            self.assertEqual(400,self.server.call(path,method,NEW_CREDS if method=='POST' else None)[0])
        self.assertEqual([],self.f.vault.saves);self.assertEqual([],self.f.factory.calls)
    def test_unknown_fields_and_bad_credential_values_return_safe_errors(self):
        for value in [{'url':'https://evil.invalid'},{'api_key':KEY,'secret_key':False},{'api_key':KEY,'secret_key':'bad'},{'api_key':KEY,'secret_key':SECRET+'\n'}]:
            status,headers,body=self.server.call('/api/wallet/binance/config','POST',value)
            self.assertEqual(400,status);self.assert_no_secret(body,headers)
        self.assertEqual([],self.f.vault.saves)
    def test_server_failures_and_missing_service_have_fixed_safe_json(self):
        with patch.object(self.service,'configure_binance',side_effect=RuntimeError(KEY+SECRET)):
            status,headers,body=self.server.call('/api/wallet/binance/config','POST',NEW_CREDS)
            self.assertEqual(503,status);self.assertEqual('unavailable',body['code']);self.assert_no_secret(body,headers)
        self.server.server.portfolio_service=None;self.assertEqual(503,self.server.call()[0])
    def test_static_routes_cannot_serve_binance_vault_or_reader_source(self):
        for path in ['/terminal/data/binance-wallet/credentials.protected.json','/binance_wallet.py','/crypto_portfolio_service.py','/%2e%2e/terminal/data/binance-wallet/credentials.protected.json']:
            status,headers,body=self.server.call(path);self.assertEqual(404,status);self.assert_no_secret(body,headers)
    def test_unsupported_methods_and_routes_never_mutate(self):
        for path,method in [('/api/wallet/portfolio','POST'),('/api/wallet/binance/config','GET'),('/api/wallet/portfolio','DELETE'),('/api/wallet/binance/config','PUT')]:
            with self.subTest(path=path,method=method):
                # Only POST config carries a JSON body in this protocol. Do
                # not attach unframed credential bytes to GET/DELETE/PUT.
                status,headers,body=self.server.call(path,method,NEW_CREDS if method=='POST' else None)
                self.assertEqual(405,status);self.assert_no_secret(body,headers)
        self.assertEqual([],self.f.vault.saves)


if __name__=='__main__':unittest.main()
