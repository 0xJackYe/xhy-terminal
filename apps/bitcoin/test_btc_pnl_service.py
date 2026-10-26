"""Accounting, transport and account isolation; no live keys or network."""
import copy
import datetime as dt
from decimal import Decimal
import json
import io
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from btc_pnl_service import (compute_position, PnLError, PublicPnLMarket,
                             BTCPnLService, handle_btc_pnl)
from btc_cost_tracker import iso
from okx_wallet_service import identity

NOW = 1793060000000
CREDS = {'api_key': 'fixture-key', 'secret_key': 'fixture-secret', 'passphrase': 'fixture-pass'}


def row(side, quantity, cash, n, currency='USDT', at=NOW - 10000):
    return {'id': str(n), 'bill_id': str(n), 'at_ms': at + n, 'side': side,
            'btc_net': quantity, 'quote_amount': cash, 'quote_ccy': currency}


def book():
    return [row('buy', '1', '100', 1), row('buy', '1', '300', 2),
            row('sell', '-0.5', '150', 3), row('sell', '-0.5', '50', 4)]


class AccountingTests(unittest.TestCase):
    def test_average_cost_current_unrealized_and_percentage(self):
        m = compute_position(book(), '1', '250', {})['metrics']
        self.assertEqual(m['unrealized_net'], '50')
        self.assertEqual(m['unrealized_return_pct'], '25')
        self.assertEqual(m['average_cost'], '200')
        for key in ['realized_profit','realized_loss','realized_net','total_net','break_even_price']:
            self.assertNotIn(key,m)

    def test_current_inventory_adjustment_is_counted_once(self):
        m = compute_position(book(), '1.1', '250', {})['metrics']
        self.assertEqual(m['nonspot_btc_adjustment'], '0.1')
        self.assertEqual(m['unrealized_net'], '75')
        self.assertEqual(Decimal(m['unrealized_net']), Decimal(m['market_value']) - Decimal(m['remaining_cost']))

    def test_past_sale_proceeds_do_not_change_current_average_or_float(self):
        rows = [row('buy','2','200',1), row('sell','-1','150',2)]
        m = compute_position(rows,'1','120',{})['metrics']
        self.assertEqual(m['average_cost'],'100')
        self.assertEqual(m['unrealized_net'],'20')
        rows[-1]['quote_amount']='1000'
        self.assertEqual(compute_position(rows,'1','120',{})['metrics'],m)

    def test_quote_fee_and_btc_fee_already_net_in_inputs(self):
        rows = [row('buy','.999','100.1',1)]
        m = compute_position(rows,'.999','120',{})['metrics']
        self.assertEqual(m['unrealized_net'],'19.78')
        self.assertEqual(m['remaining_cost'],'100.1')

    def test_rebates_are_not_subtracted_again(self):
        m = compute_position([row('buy','1.01','99',1)],'1.01','100',{})['metrics']
        self.assertEqual(m['unrealized_net'],'2')

    def test_historical_currency_conversion_is_time_specific(self):
        r = row('buy','1','2',1,'ETH')
        result = compute_position([r],'1','6000',{('ETH',r['at_ms']//60000*60000):Decimal('2000')})
        self.assertEqual(result['metrics']['remaining_cost'],'4000')
        self.assertEqual(result['metrics']['unrealized_net'],'2000')

    def test_missing_foreign_currency_is_never_zero_or_one(self):
        for ccy in ['ETH','USDC','BNB']:
            with self.assertRaisesRegex(PnLError,'historical_rate_missing'):
                compute_position([row('buy','1','1',1,ccy)],'1','100',{})

    def test_oversold_and_duplicate_and_negative_cash_fail(self):
        for rows in [[row('sell','-1','100',1)], [book()[0],book()[0]], [row('buy','1','-100',1)]]:
            with self.assertRaises(PnLError): compute_position(rows,'1','100',{})

    def test_full_liquidation_zero_inventory_does_not_divide_by_zero(self):
        m = compute_position([row('buy','1','100',1),row('sell','-1','110',2)],'0','100',{})['metrics']
        self.assertEqual(m['unrealized_net'],'0')
        self.assertEqual(m['remaining_cost'],'0')
        self.assertIsNone(m['average_cost'])
        self.assertIsNone(m['unrealized_return_pct'])

    def test_empty_book_is_not_fabricated_as_zero_profit(self):
        with self.assertRaisesRegex(PnLError,'needs_history'): compute_position([],'1','100',{})

    def test_zero_added_cost_inventory_never_produces_infinite_percentage(self):
        m=compute_position([row('buy','1','0',1)],'1','100',{})['metrics']
        self.assertEqual(m['unrealized_net'],'100')
        self.assertIsNone(m['unrealized_return_pct'])

    def test_first_and_last_net_buy_dates_and_effective_prices(self):
        result=compute_position(book(),'1','250',{})
        self.assertEqual(result['first_buy_at'],iso(book()[0]['at_ms']))
        self.assertEqual(result['last_buy_at'],iso(book()[1]['at_ms']))
        self.assertEqual(result['metrics']['first_net_buy_price'],'100')
        self.assertEqual(result['metrics']['last_net_buy_price'],'300')


class Vault:
    def __init__(self): self.data = {}; self.lock = threading.RLock()
    def _read(self,name,default): return copy.deepcopy(self.data.get(name,default))
    def _write(self,name,value): self.data[name] = copy.deepcopy(value)


class Market:
    def __init__(self): self.fail = False; self.during_quote = None
    def historical_rate(self,*args): raise AssertionError('unexpected historical query')
    def quote(self):
        if self.during_quote: self.during_quote()
        if self.fail: raise PnLError('market_unavailable')
        return '250', iso(NOW)


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.now = NOW/1000
        self.okx = type('OKX',(),{'lock':threading.RLock(),'credentials':dict(CREDS)})()
        self.account = identity(CREDS)
        self.snapshot = {'connection_id':self.account[:24], 'status':'fresh','coverage_complete':True,
                         'ledger':{'complete':True,'as_of_ms':NOW,'coverage_start_ms':NOW-20000,'records':book()}}
        self.cost = type('Cost',(),{'okx':self.okx,'accounting_snapshot':lambda _:copy.deepcopy(self.snapshot)})()
        self.holdings = {'ok':True,'stale':False,'totals':{'btc':'1.1'},'updated_at':iso(NOW)}
        self.combined = type('Combined',(),{'read_public':lambda _:copy.deepcopy(self.holdings)})()
        self.vault = Vault()
        self.vault.data['policy-'+self.account+'.protected.json'] = {'identity':self.account,
            'small_inflows_no_added_cost':True,'received_btc':'0.1',
            'verified_nonspot_adjustment_btc':'0.1','verified_at':iso(NOW)}
        self.market = Market()
        self.service = BTCPnLService(self.cost,self.combined,self.vault,self.market,clock=lambda:self.now)

    def test_refresh_and_cached_read_no_network(self):
        self.assertTrue(self.service.refresh_once())
        self.market.fail = True
        public = self.service.read_public()
        self.assertEqual(public['status'],'fresh')
        self.assertEqual(public['metrics']['unrealized_net'],'75')
        self.assertTrue(public['estimated'])
        public['metrics']['unrealized_net']='evil'
        self.assertEqual(self.service.read_public()['metrics']['unrealized_net'],'75')
        for value in CREDS.values(): self.assertNotIn(value,json.dumps(public))

    def test_market_failure_retains_last_success_with_stale_status(self):
        self.service.refresh_once(); self.market.fail=True
        self.assertFalse(self.service.refresh_once())
        self.assertEqual(self.service.read_public()['status'],'stale')
        self.assertEqual(self.service.read_public()['metrics']['unrealized_net'],'75')

    def test_daily_new_buy_updates_average_cost_and_latest_purchase(self):
        self.service.refresh_once()
        old=self.service.read_public()
        self.snapshot['ledger']['records'].append(row('buy','0.5','150',5,at=NOW-1000))
        self.holdings['totals']['btc']='1.6'
        self.assertTrue(self.service.refresh_once())
        new=self.service.read_public()
        self.assertEqual(new['metrics']['average_cost'],'218.75')
        self.assertEqual(new['metrics']['remaining_cost'],'350')
        self.assertEqual(new['metrics']['unrealized_net'],'50')
        self.assertGreater(new['last_buy_at'],old['last_buy_at'])
        self.assertEqual(new['buy_count'],old['buy_count']+1)
        self.assertEqual(new['status'],'fresh')

    def test_account_change_never_exposes_previous_account(self):
        self.service.refresh_once()
        self.okx.credentials['api_key']='new-key'
        self.assertEqual(self.service.read_public()['metrics'],{})
        self.assertFalse(self.service.refresh_once())
        self.assertEqual(self.service.read_public()['status'],'unavailable')

    def test_account_change_during_market_query_discards_work(self):
        self.market.during_quote=lambda:self.okx.credentials.update(api_key='new-key')
        self.assertFalse(self.service.refresh_once())
        self.assertEqual(self.service.read_public()['metrics'],{})

    def test_new_nonspot_change_is_visible_as_unreconciled(self):
        self.holdings['totals']['btc']='1.2'
        self.service.refresh_once()
        result=self.service.read_public()
        self.assertEqual(result['status'],'stale')
        self.assertFalse(result['reconciliation']['matched'])
        self.assertEqual(result['reconciliation']['change_since_verification_btc'],'0.1')

    def test_history_gap_is_not_called_complete(self):
        self.snapshot['coverage_complete']=False
        self.assertFalse(self.service.refresh_once())
        self.assertEqual(self.service.read_public()['metrics'],{})

    def test_cached_quote_and_ledger_age_show_stale(self):
        self.service.refresh_once(); self.now += 91
        self.assertEqual(self.service.read_public()['status'],'stale')

    def test_chain_fallback_can_verify_holdings_when_chart_provider_is_down(self):
        self.holdings.update(stale=True, sources=[
            {'id':'okx','btc':'0.1','status':'fresh','updated_at':iso(NOW)},
            {'id':'offline','btc':'1','status':'stale','updated_at':iso(NOW-86400000)}])
        self.vault.data['policy-'+self.account+'.protected.json']['wallet_address']='bc1q'+'a'*38
        self.market.confirmed_balance=lambda _: {'btc':'1','observed_ms':NOW,'provider':'Blockstream/confirmed'}
        self.assertTrue(self.service.refresh_once())
        result=self.service.read_public()
        self.assertEqual(result['status'],'fresh')
        self.assertEqual(result['metrics']['unrealized_net'],'75')
        self.assertEqual(result['balance_sources'][1]['provider'],'Blockstream/confirmed')


class PublicMarketTests(unittest.TestCase):
    def test_only_exact_completed_minute_is_accepted_and_cached(self):
        vault=Vault(); market=PublicPnLMarket(vault,clock=lambda:NOW/1000)
        calls=[]; minute=NOW//60000*60000
        def get(route,params):
            calls.append((route,params))
            return [[str(minute),'2','3','1','2.5','1','1','1','1']]
        market._get=get
        rate,evidence=market.historical_rate('ETH',minute)
        self.assertEqual(rate,Decimal('2.5'))
        self.assertEqual(evidence['source'],'OKX/1m-close')
        market.historical_rate('ETH',minute)
        self.assertEqual(len(calls),1)
        with self.assertRaises(PnLError): market.historical_rate('ETH/evil',minute)

    def test_wrong_or_incomplete_candle_cannot_supply_cost(self):
        market=PublicPnLMarket(Vault()); minute=NOW//60000*60000
        for value in [[str(minute+60000),'2','3','1','2','1','1','1','1'],
                      [str(minute),'2','3','1','2','1','1','1','0']]:
            market._get=lambda *args:[value]
            with self.assertRaises(PnLError):market.historical_rate('USDC',minute)

    def test_exchange_clock_offset_does_not_reject_fresh_quote(self):
        market=PublicPnLMarket(Vault(),clock=lambda:NOW/1000)
        market._get=lambda route,params: [{'ts':str(NOW+9000)}] if route=='time' else [{'instId':'BTC-USDT','last':'80000','ts':str(NOW+9000)}]
        self.assertEqual(market.quote(),('80000',iso(NOW+9000)))
        market._get=lambda route,params: [{'instId':'BTC-USDT','last':'80000','ts':str(NOW-100000)}]
        with self.assertRaises(PnLError):market.quote()

    def test_chain_address_and_integer_satoshis_are_validated_and_cached(self):
        address='bc1q'+'a'*38
        calls=[]
        class Response(io.BytesIO):
            def geturl(self):return 'https://blockstream.info/api/address/'+address
            def getcode(self):return 200
        class Opener:
            def open(self,request,timeout):
                calls.append(request)
                return Response(json.dumps({'address':address,'chain_stats':{
                    'funded_txo_sum':110000000,'spent_txo_sum':10000000}}).encode())
        market=PublicPnLMarket(Vault(),Opener(),clock=lambda:NOW/1000)
        self.assertEqual(market.confirmed_balance(address)['btc'],'1')
        market.confirmed_balance(address)
        self.assertEqual(len(calls),1)
        self.assertFalse(any('OK-ACCESS' in key.upper() for key in calls[0].headers))
        with self.assertRaises(PnLError):market.confirmed_balance('https://evil.invalid')


class HTTPTests(unittest.TestCase):
    def setUp(self):
        from btc_terminal_server import TerminalServer, WalletProxy
        self.calls=0
        self.fail=False
        parent=self
        class Cache:
            def read_public(self):
                parent.calls+=1
                if parent.fail:raise ValueError('secret-internal-error')
                return {'status':'fresh','metrics':{'unrealized_net':'12.34'}}
        self.server=TerminalServer(('127.0.0.1',0),None,WalletProxy(''))
        self.server.pnl_service=Cache()
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.url='http://127.0.0.1:'+str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join(2)

    def call(self,path='/api/wallet/btc-pnl',method='GET',headers=None):
        try:
            with urlopen(Request(self.url+path,method=method,headers=headers or {}),timeout=3) as r:
                return r.status,r.headers,json.load(r)
        except HTTPError as r:return r.code,r.headers,json.load(r)

    def test_cached_get_and_non_mutating_contract(self):
        status,headers,data=self.call()
        self.assertEqual(status,200)
        self.assertEqual(headers['Cache-Control'],'no-store')
        self.assertEqual(data['metrics']['unrealized_net'],'12.34')
        self.assertEqual(self.calls,1)
        self.assertEqual(self.call(method='POST')[0],405)
        self.assertEqual(self.call(path='/api/wallet/btc-pnl?refresh=1')[0],400)
        self.assertEqual(self.calls,1)

    def test_foreign_site_cannot_read_private_pnl(self):
        self.assertEqual(self.call(headers={'Origin':'https://evil.invalid'})[0],403)
        self.assertEqual(self.call(headers={'Host':'evil.invalid'})[0],403)
        self.assertEqual(self.calls,0)

    def test_internal_errors_do_not_escape_and_unstarted_service_is_explicit(self):
        self.fail=True
        status,_,data=self.call()
        self.assertEqual(status,503)
        self.assertNotIn('secret',json.dumps(data))
        self.server.pnl_service=None
        self.assertEqual(self.call()[0],503)


if __name__ == '__main__': unittest.main()
