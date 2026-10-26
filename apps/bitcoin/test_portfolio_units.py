"""Three portfolio display units use one filtered asset universe and quote."""
import datetime as dt
from decimal import Decimal
import unittest

from test_crypto_portfolio_service import fixture, binance_data


class PortfolioUnitsTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture()
        self.service = self.f.service
        self.snapshot = self.f.combined.source.snapshot
        self.today = dt.datetime.fromtimestamp(self.f.clock(), dt.timezone.utc).date()
        self.yesterday = (self.today - dt.timedelta(days=1)).isoformat()
        self.snapshot['fx'] = {'rates': [{'date': self.yesterday, 'rate': '7.2'}]}

    def read(self):
        self.service.refresh_once()
        return self.service.read_public()

    def test_three_totals_share_filtered_usd_and_same_btc_quote(self):
        result = self.read()
        self.assertEqual(Decimal('1150'), Decimal(result['total_usd']))
        self.assertEqual(Decimal('8280'), Decimal(result['total_cny']))
        self.assertEqual(Decimal('0.0115'), Decimal(result['total_btc']))
        self.assertEqual('100000', result['conversion_quotes']['btc_usd'])
        self.assertEqual('7.2', result['conversion_quotes']['usd_cny'])
        # This is the value of ALL coins in BTC, not actual BTC held.
        actual_btc = next(a['quantity'] for a in result['assets'] if a['ccy'] == 'BTC')
        self.assertNotEqual(Decimal(actual_btc), Decimal(result['total_btc']))

    def test_daily_fx_uses_latest_available_prior_utc_fixing(self):
        self.snapshot['fx']['rates'] = [
            {'date': self.today.isoformat(), 'rate': '99'},
            {'date': self.yesterday, 'rate': '7.2'},
            {'date': (self.today - dt.timedelta(days=2)).isoformat(), 'rate': '7.1'},
            {'date': (self.today + dt.timedelta(days=1)).isoformat(), 'rate': '999'},
        ]
        result = self.read()
        self.assertEqual(self.yesterday, result['conversion_quotes']['fx_date'])
        self.assertEqual(Decimal('8280'), Decimal(result['total_cny']))

    def test_both_extra_units_exclude_same_under_five_coin(self):
        self.f.okx.data = {'assets': [{'ccy': 'ETH', 'quantity': '1', 'usd_value': '4.99'}], 'complete': True}
        self.snapshot['summary']['chain_stats']['funded_txo_sum'] = 0
        result = self.read()
        self.assertEqual(['USDT'], [a['ccy'] for a in result['assets']])
        self.assertEqual(Decimal('20'), Decimal(result['total_usd']))
        self.assertEqual(Decimal('144'), Decimal(result['total_cny']))
        self.assertEqual(Decimal('0.0002'), Decimal(result['total_btc']))

    def test_missing_or_invalid_fx_keeps_usd_and_btc_without_fabricating_cny(self):
        for fx in (None, {}, {'rates': None}, {'rates': [{'date': self.yesterday, 'rate': '0'}]},
                   {'rates': [{'date': self.yesterday, 'rate': 'NaN'}]}):
            with self.subTest(fx=fx):
                self.snapshot['fx'] = fx
                result = self.read()
                self.assertIsNone(result['total_cny'])
                self.assertIsNone(result['conversion_quotes']['usd_cny'])
                self.assertEqual(Decimal('0.0115'), Decimal(result['total_btc']))
                self.assertTrue(result['complete'])

    def test_missing_btc_price_does_not_divide_by_zero_or_invent_value(self):
        for price in (None, '0', '-1', 'NaN'):
            with self.subTest(price=price):
                self.snapshot['quote']['USD'] = price
                result = self.read()
                self.assertIsNone(result['total_btc'])
                self.assertIsNone(result['conversion_quotes']['btc_usd'])
                self.assertIsNotNone(result['total_cny'])

    def test_zero_filtered_total_converts_to_real_zero(self):
        self.f.okx.data = {'assets': [], 'complete': True}
        self.f.factory.data = binance_data([])
        self.snapshot['summary']['chain_stats']['funded_txo_sum'] = 0
        result = self.read()
        for field in ('total_usd', 'total_cny', 'total_btc'):
            self.assertEqual(Decimal(0), Decimal(result[field]))

    def test_account_switch_removes_all_three_previous_totals(self):
        self.read()
        self.f.okx.switch()
        result = self.service.read_public()
        for field in ('total_usd', 'total_cny', 'total_btc'):
            self.assertIsNone(result[field])
        self.assertEqual({}, result['conversion_quotes'])


if __name__ == '__main__':
    unittest.main()
