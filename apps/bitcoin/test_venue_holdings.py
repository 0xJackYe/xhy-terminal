"""Quantity and historical-scope checks; synthetic accounts only."""
import copy
import datetime as dt
from decimal import Decimal
import json
import threading
import types
import unittest

from venue_holdings import binance_btc_source, with_binance_holdings


NOW = 1794265200


def coin(wallet='Spot', ccy='BTC', quantity='0.001', **extra):
    return dict(wallet=wallet, ccy=ccy, quantity=quantity, quantity_complete=True,
                btc_value='12345', **extra)


def portfolio(assets=None, **data):
    return types.SimpleNamespace(
        lock=threading.RLock(), credentials={'api_key':'SYNTHETIC-KEY', 'secret_key':'SYNTHETIC-SECRET'},
        generation=1, binance_data={'assets':[coin()] if assets is None else assets,
                                   'complete':True,'missing_wallets':[], **data},
        binance_success_at=NOW, binance_error=None, clock=lambda:NOW)


def base():
    return {'ok':True,'stale':False,'totals':{'btc':'0.1','usd':'100','cny':'700'},
            'sources':[{'id':'okx','btc':'0.03'},{'id':'offline','btc':'0.07'}],
            'quotes':{'btc_usd':'1000','usd_cny':'7'},
            'history':[{'timestamp':'2026-11-01T00:00:00Z','btc':'0.05','usd':'50'}],
            'pnl':{'today':{'usd':'10','cny':'70','reason':None}},
            'coverage':{'complete':True,'note':'original verified history'}}


class BinanceSourceTests(unittest.TestCase):
    def test_actual_coins_not_btc_valuation(self):
        result = binance_btc_source(portfolio([coin('Spot'),coin('Funding',quantity='0.002'),
                                              coin('Earn',quantity='0.003'),
                                              coin('Spot','USDT','2000')]))
        self.assertEqual(result['btc'],'0.006')
        self.assertEqual(result['status'],'fresh')
        self.assertTrue(result['complete'])

    def test_margin_futures_and_options_are_excluded(self):
        result = binance_btc_source(portfolio([coin(),coin('Cross Margin',quantity='5'),
                                              coin('USDⓈ-M Futures',quantity='6'),
                                              coin('COIN-M Futures',quantity='7'),
                                              coin('Options',quantity='8')]))
        self.assertEqual(result['btc'],'0.001')

    def test_simple_earn_alias_is_real_holding(self):
        result = binance_btc_source(portfolio([coin('Simple Earn',quantity='0.002'),coin('Spot')]))
        self.assertEqual(result['btc'],'0.003')

    def test_unknown_wallet_cannot_be_silently_ignored(self):
        result = binance_btc_source(portfolio([coin(),coin('Unknown New Product',quantity='0.5')]))
        self.assertIsNone(result['btc'])
        self.assertFalse(result['complete'])
        self.assertEqual(result['status'],'unavailable')

    def test_complete_inventory_without_btc_is_verified_zero(self):
        result = binance_btc_source(portfolio([coin('Spot','USDT','500')]))
        self.assertEqual(result['btc'],'0')
        self.assertEqual(result['status'],'fresh')

    def test_missing_eligible_wallet_details_are_not_zero(self):
        result = binance_btc_source(portfolio([], complete=False, missing_wallets=['Earn']))
        self.assertIsNone(result['btc'])

    def test_excluded_wallet_missing_details_do_not_invalidate_cash_coins(self):
        result = binance_btc_source(portfolio([coin()], complete=False, missing_wallets=['Cross Margin']))
        self.assertEqual(result['btc'],'0.001')
        self.assertEqual(result['status'],'fresh')

    def test_missing_quantity_and_duplicate_btc_rows_are_incomplete(self):
        for assets in ([coin(quantity=None)],[coin(),coin()],
                       [dict(coin(),quantity_complete=False)],[coin(quantity='-1')]):
            with self.subTest(assets=assets):
                self.assertIsNone(binance_btc_source(portfolio(assets))['btc'])

    def test_stale_or_failed_same_account_balance_is_retained_and_marked(self):
        p = portfolio()
        self.assertEqual(binance_btc_source(p,now=NOW+121)['status'],'stale')
        p.binance_error = 'network_error'
        result = binance_btc_source(p)
        self.assertEqual(result['status'],'stale')
        self.assertEqual(result['btc'],'0.001')

    def test_credential_context_changes_and_never_contains_secrets(self):
        p = portfolio()
        first = binance_btc_source(p)
        p.credentials['api_key'] = 'ANOTHER-SYNTHETIC-KEY'
        p.generation += 1
        p.binance_data = None
        changed = binance_btc_source(p)
        self.assertNotEqual(first['context'],changed['context'])
        self.assertIsNone(changed['btc'])
        for text in ('SYNTHETIC-KEY','SYNTHETIC-SECRET','ANOTHER-SYNTHETIC-KEY'):
            self.assertNotIn(text,json.dumps([first,changed]))

    def test_missing_service_and_credentials_are_unavailable(self):
        self.assertIsNone(binance_btc_source(None)['btc'])
        p = portfolio();p.credentials={}
        self.assertIsNone(binance_btc_source(p)['btc'])


class CombinedHoldingsTests(unittest.TestCase):
    def test_decimal_total_uses_one_current_quote(self):
        original = base()
        result = with_binance_holdings(original,portfolio([coin(quantity='0.00000001')]))
        self.assertEqual(result['totals'],{'btc':'0.10000001','usd':'100.00001','cny':'700.00007'})
        self.assertEqual(result['sources'][-1]['id'],'binance')
        self.assertEqual(original,base())

    def test_does_not_backfill_past_with_current_coins(self):
        original = base()
        result = with_binance_holdings(original,portfolio())
        self.assertEqual(result['history'],original['history'])
        self.assertEqual(result['coverage']['history_venues'],['okx','offline'])
        self.assertFalse(result['coverage']['complete'])
        self.assertIn('历史曲线仅包含欧易',result['coverage']['note'])
        self.assertIsNone(result['pnl']['today']['usd'])
        self.assertIn('币安历史余额尚未重建',result['pnl']['today']['reason'])

    def test_unitemized_binance_holding_makes_total_unknown(self):
        result = with_binance_holdings(base(),portfolio([],complete=False,missing_wallets=['Spot']))
        self.assertEqual(result['totals'],{'btc':None,'usd':None,'cny':None})
        self.assertTrue(result['stale'])

    def test_existing_binance_source_is_not_counted_twice(self):
        result = with_binance_holdings(base(),portfolio())
        repeated = with_binance_holdings(result,portfolio())
        self.assertEqual(repeated,result)

    def test_zero_binance_preserves_known_history_and_periods(self):
        original=base()
        result=with_binance_holdings(original,portfolio([]))
        self.assertEqual(result['pnl'],original['pnl'])
        self.assertEqual(result['history'],original['history'])
        self.assertTrue(result['coverage']['complete'])

    def test_unavailable_quotes_do_not_hide_known_btc(self):
        original=base();original['quotes']={}
        result=with_binance_holdings(original,portfolio())
        self.assertEqual(result['totals']['btc'],'0.101')
        self.assertIsNone(result['totals']['usd'])
        self.assertIsNone(result['totals']['cny'])


if __name__ == '__main__':
    unittest.main()
