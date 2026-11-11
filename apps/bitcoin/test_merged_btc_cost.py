"""Two exchange books, exact fees, resumable scans and credential isolation."""
import copy
import datetime as dt
from decimal import Decimal
from pathlib import Path
import tempfile
import threading
import unittest

from btc_cost_tracker import dca_diary, iso, summarize
from merged_btc_cost import BinanceBTCTracker, MergedBTCCostTracker
from okx_wallet_service import OKXVault

NOW = int(dt.datetime(2026, 11, 9, 7, tzinfo=dt.timezone(dt.timedelta(hours=8))).timestamp() * 1000)
START = int(dt.datetime(2024, 12, 14, tzinfo=dt.timezone(dt.timedelta(hours=8))).timestamp() * 1000)


def event(n=1, venue='binance', at=NOW - 10000, cash='100', net='0.000999', currency='USDT', side='buy'):
    quantity = Decimal('0.001')
    signed = quantity if side == 'buy' else -quantity
    net = Decimal(net) if side == 'buy' else -quantity
    prefix = '7101' + str(n).zfill(20) if venue == 'binance' else str(n * 2)
    return {'id': ('binance:BTC' + currency + ':' + str(n)) if venue == 'binance' else 'BTC-' + currency + ':' + str(n),
            'venue': venue, 'at_ms': at, 'side': side, 'inst_id': 'BTC-' + currency,
            'trade_id': str(n), 'order_id': str(n),
            'bill_id': prefix + '1' if venue == 'binance' else str(n * 2),
            'counter_bill_id': prefix + '2' if venue == 'binance' else str(n * 2 + 1),
            'price': '100000', 'btc_gross': str(quantity), 'btc_net': str(net),
            'fee_btc': str(net - signed), 'fee_quote': '0', 'quote_ccy': currency,
            'quote_gross': '100', 'quote_amount': cash, 'original_price': '100000'}


def minute_rate(currency, at, close='1.01'):
    minute = at // 60000 * 60000
    return {currency + ':' + str(minute): {'currency': currency, 'minute_ms': minute,
            'close': close, 'low': close, 'high': close, 'source': 'Binance/1m-close'}}


class OKX:
    def __init__(self):
        self.lock = threading.RLock()


class Base:
    def __init__(self, now):
        self.okx, self.now = OKX(), now
        self.connection, self.start, self.as_of = 'a' * 24, START, now[0]
        self.records, self.refreshed = [event(1, 'okx')], 0

    def accounting_snapshot(self):
        with self.okx.lock:
            return {'connection_id': self.connection, 'status': 'fresh', 'coverage_complete': True,
                    'ledger': {'version': 1, 'identity': self.connection, 'complete': True,
                               'coverage_start_ms': self.start, 'as_of_ms': self.as_of,
                               'records': copy.deepcopy(self.records)}}

    def read_public(self):
        summary, today = summarize(self.records, self.now[0])
        return {'status': 'fresh', 'connection_id': self.connection, 'summary': summary, 'today': today,
                'last_success_at': iso(self.as_of), 'coverage_complete': True,
                'recent_trades': [], 'plan_daily_usdt': '20', 'error': None, 'error_code': None}

    def request_refresh(self):
        self.refreshed += 1


class Portfolio:
    def __init__(self):
        self.lock = threading.RLock()
        self.credentials = {'api_key': 'A' * 64, 'secret_key': 'B' * 64}
        self.generation = 0

    def change_account(self):
        with self.lock:
            self.credentials = {'api_key': 'C' * 64, 'secret_key': 'D' * 64}
            self.generation += 1


class ReaderFactory:
    def __init__(self, now):
        self.now = now
        self.rows, self.rates, self.complete = [event()], {}, True
        self.calls, self.closed, self.error, self.on_read = [], 0, None, None

    def __call__(self, credentials):
        parent = self
        class Reader:
            def read_since(self, coverage, *, meta=None, rates=None):
                parent.calls.append((coverage, copy.deepcopy(meta), copy.deepcopy(rates)))
                if parent.on_read:
                    parent.on_read()
                if parent.error:
                    raise parent.error
                return {'records': copy.deepcopy(parent.rows), 'rates': copy.deepcopy(parent.rates),
                        'complete': parent.complete, 'as_of_ms': parent.now[0],
                        'meta': {'complete': parent.complete, 'as_of_ms': parent.now[0],
                                 'cursor': len(parent.calls)}}
            def close(self):
                parent.closed += 1
        return Reader()


class MergedCostTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = [NOW]
        self.base, self.portfolio = Base(self.now), Portfolio()
        self.factory = ReaderFactory(self.now)
        self.vault = OKXVault(Path(self.tmp.name), seal=lambda b: b, unseal=lambda b: b)
        self.tracker = BinanceBTCTracker(self.portfolio, self.base, vault=self.vault,
                                         client_factory=self.factory, clock=lambda: self.now[0] / 1000)
        self.merged = MergedBTCCostTracker(self.base, self.tracker, clock=lambda: self.now[0] / 1000,
                                          rates_provider=lambda: {})

    def test_both_venues_count_same_trade_identifier_and_net_fees(self):
        self.factory.rows = [event(cash='100.1')]
        self.assertTrue(self.tracker.refresh_once())
        result = self.merged.read_public()
        self.assertEqual(result['venues'], ['okx', 'binance'])
        self.assertEqual(result['summary']['buy_count'], 2)
        self.assertEqual(result['summary']['bought_btc'], '0.001998')
        self.assertEqual(result['summary']['net_invested_usdt'], '200.1')
        self.assertEqual(result['today']['buy_spent_usdt'], '200.1')
        diary = self.merged.read_dca_diary()
        self.assertEqual(diary['days'], [['2026-11-09', '0.001998', '200.1', 2]])
        self.assertEqual(len(self.base.records), 1, 'Binance must not be written into the OKX book')
        self.assertEqual(self.factory.closed, 1)

    def test_overlap_is_idempotent_and_new_fill_updates_once(self):
        self.assertTrue(self.tracker.refresh_once())
        self.factory.rows.append(event(2))
        self.now[0] += 30000
        self.assertTrue(self.tracker.refresh_once())
        self.assertTrue(self.tracker.refresh_once())
        result = self.merged.read_public()
        self.assertEqual(result['summary']['buy_count'], 3)
        self.assertEqual(result['summary']['net_invested_usdt'], '300')
        self.assertEqual(self.factory.calls[1][1]['cursor'], 1)

    def test_conflicting_duplicate_keeps_last_verified_book(self):
        self.assertTrue(self.tracker.refresh_once())
        self.factory.rows = [event(cash='101')]
        self.assertFalse(self.tracker.refresh_once())
        result = self.merged.read_public()
        self.assertEqual(result['venues'], ['okx', 'binance'])
        self.assertEqual(result['status'], 'stale')
        self.assertEqual(result['summary']['net_invested_usdt'], '200')

    def test_initial_partial_import_never_claims_shared_coverage(self):
        before = self.merged.accounting_snapshot()
        self.factory.complete = False
        self.assertTrue(self.tracker.refresh_once())
        partial = self.merged.read_public()
        self.assertEqual(partial['venues'], ['okx'])
        self.assertEqual(partial['binance_history']['status'], 'importing')
        self.assertEqual(partial['summary']['buy_count'], 1)
        self.factory.complete = True
        self.assertTrue(self.tracker.refresh_once())
        full = self.merged.accounting_snapshot()
        self.assertEqual(full['venues'], ['okx', 'binance'])
        self.assertFalse(self.merged.context_matches(before))
        self.assertNotEqual(before['public_connection_id'], full['public_connection_id'])
        self.assertEqual(full['connection_id'], self.base.connection)

    def test_later_partial_import_keeps_verified_snapshot_until_complete(self):
        self.assertTrue(self.tracker.refresh_once())
        self.factory.rows.append(event(2))
        self.factory.complete = False
        self.now[0] += 30000
        self.assertTrue(self.tracker.refresh_once())
        held = self.merged.read_public()
        self.assertEqual(held['status'], 'stale')
        self.assertEqual(held['summary']['buy_count'], 2)
        self.factory.complete = True
        self.assertTrue(self.tracker.refresh_once())
        self.assertEqual(self.merged.read_public()['summary']['buy_count'], 3)

    def test_restart_restores_only_matching_encrypted_book(self):
        self.assertTrue(self.tracker.refresh_once())
        restarted = BinanceBTCTracker(self.portfolio, self.base, vault=self.vault,
                    client_factory=self.factory, clock=lambda: self.now[0] / 1000)
        self.assertEqual(restarted.snapshot()['records'], self.factory.rows)
        self.portfolio.change_account()
        self.assertFalse(restarted.snapshot()['complete'])
        self.assertEqual(restarted.snapshot()['records'], [])

    def test_binance_account_switch_hides_previous_totals_and_context(self):
        self.assertTrue(self.tracker.refresh_once())
        old = self.merged.accounting_snapshot()
        old_public = self.merged.read_public()['connection_id']
        self.portfolio.change_account()
        new = self.merged.read_public()
        self.assertEqual(new['venues'], ['okx'])
        self.assertEqual(new['summary']['buy_count'], 1)
        self.assertNotEqual(old_public, new['connection_id'])
        self.assertFalse(self.merged.context_matches(old))

    def test_okx_account_or_coverage_switch_cannot_reuse_binance_book(self):
        self.assertTrue(self.tracker.refresh_once())
        self.base.connection = 'c' * 24
        self.assertEqual(self.merged.read_public()['venues'], ['okx'])
        self.base.connection = 'a' * 24
        self.base.start += 86400000
        self.assertEqual(self.merged.read_public()['venues'], ['okx'])

    def test_account_switch_during_network_read_never_persists_result(self):
        self.factory.on_read = self.portfolio.change_account
        self.assertFalse(self.tracker.refresh_once())
        self.assertEqual(list(Path(self.tmp.name).glob('ledger-*.json')), [])
        self.assertEqual(self.merged.read_public()['summary']['buy_count'], 1)

    def test_failure_retains_same_account_book_then_recovers(self):
        self.assertTrue(self.tracker.refresh_once())
        self.factory.error = RuntimeError('a private provider detail that must never appear')
        self.assertFalse(self.tracker.refresh_once())
        result = self.merged.read_public()
        self.assertEqual(result['status'], 'stale')
        self.assertNotIn('private', result['error'])
        self.assertEqual(result['summary']['buy_count'], 2)
        self.factory.error = None
        self.assertTrue(self.tracker.refresh_once())
        self.assertEqual(self.merged.read_public()['status'], 'fresh')

    def test_day_rollover_and_age_do_not_reuse_yesterdays_progress(self):
        self.assertTrue(self.tracker.refresh_once())
        self.now[0] += 86400000
        result = self.merged.read_public()
        self.assertEqual(result['status'], 'stale')
        self.assertEqual(result['today']['date_beijing'], '2026-11-10')
        self.assertEqual(result['today']['buy_spent_usdt'], '0')
        self.assertEqual(self.merged.read_dca_diary()['totals']['buys'], 2)

    def test_non_usdt_cost_and_diary_use_confirmed_minute_conversion(self):
        at = NOW - 10000
        self.factory.rows = [event(currency='USDC', cash='100.1', at=at)]
        self.factory.rates = minute_rate('USDC', at)
        self.assertTrue(self.tracker.refresh_once())
        result = self.merged.read_public()
        self.assertEqual(result['summary']['net_invested_usdt'], '201.101')
        self.assertEqual(result['today']['buy_spent_usdt'], '201.101')
        self.assertEqual(self.merged.read_dca_diary()['days'][0][2], '201.1')
        ledger = self.merged.accounting_snapshot()['ledger']
        self.assertEqual(ledger['records'][-1]['quote_ccy'], 'USDC', 'Accounting retains original quote')

    def test_display_price_converts_with_its_quote_for_profile_bins_without_mutating_ledger(self):
        at = NOW - 10000
        original = event(currency='USDC', cash='64.064', at=at)
        original.update(price='64000', original_price='64000', quote_gross='64', fee_quote='-0.064')
        display = self.merged._display_records([original], minute_rate('USDC', at, close='1.02'))
        self.assertEqual(display[0]['quote_ccy'], 'USDT')
        self.assertEqual(display[0]['price'], '65280')
        self.assertEqual(display[0]['original_price'], '64000')
        self.assertEqual(original['price'], '64000')
        self.assertEqual(original['quote_ccy'], 'USDC')
        self.assertEqual(dca_diary(display)['buy_price_distribution'], {'bucket_usdt': '5000',
                         'priced_btc': '0.000999', 'unpriced_btc': '0',
                         'bins': [{'from': '65000', 'to': '70000', 'btc': '0.000999'}]})

    def test_missing_quote_conversion_is_unknown_not_zero(self):
        self.factory.rows = [event(currency='USDC')]
        self.assertTrue(self.tracker.refresh_once())
        result = self.merged.read_public()
        self.assertEqual(result['summary']['unpriced_currencies'], ['USDC'])
        self.assertIsNone(result['today']['buy_spent_usdt'])
        self.assertIsNone(self.merged.read_dca_diary()['days'][0][2])

    def test_bad_rate_or_reused_bill_does_not_publish_new_book(self):
        self.factory.rates = minute_rate('USDC', NOW - 10000)
        next(iter(self.factory.rates.values()))['close'] = '2'
        self.assertFalse(self.tracker.refresh_once())
        self.assertEqual(self.merged.read_public()['venues'], ['okx'])
        self.factory.rates = {}
        bad = event(2)
        bad['counter_bill_id'] = self.factory.rows[0]['counter_bill_id']
        self.factory.rows.append(bad)
        self.assertFalse(self.tracker.refresh_once())

    def test_manual_refresh_wakes_both_trackers_without_trading(self):
        self.merged.request_refresh()
        self.assertEqual(self.base.refreshed, 1)
        self.assertTrue(self.tracker.wake.is_set())

    def test_newer_venue_fill_waits_for_shared_watermark(self):
        self.now[0] += 30000
        self.factory.rows = [event(at=NOW + 10000)]
        self.assertTrue(self.tracker.refresh_once())
        waiting = self.merged.accounting_snapshot()
        self.assertEqual(waiting['ledger']['as_of_ms'], NOW)
        self.assertEqual(waiting['pending_events'], 1)
        self.assertEqual(waiting['status'], 'stale')
        self.assertEqual(len(waiting['ledger']['records']), 1)
        self.base.as_of = self.now[0]
        current = self.merged.accounting_snapshot()
        self.assertEqual(current['pending_events'], 0)
        self.assertEqual(current['status'], 'fresh')
        self.assertEqual(len(current['ledger']['records']), 2)

    def test_same_keys_reconfiguration_still_invalidates_published_context(self):
        self.assertTrue(self.tracker.refresh_once())
        old = self.merged.accounting_snapshot()
        self.portfolio.generation += 1
        self.assertFalse(self.merged.context_matches(old))
        self.assertEqual(self.merged.read_public()['venues'], ['okx', 'binance'])


if __name__ == '__main__':
    unittest.main()
