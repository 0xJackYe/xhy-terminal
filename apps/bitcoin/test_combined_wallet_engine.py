import copy
import datetime as dt
from decimal import Decimal
import json
import unittest

from combined_wallet_engine import AccountingError, build_combined, normalize_onchain


END = int(dt.datetime(2026, 10, 24, 8, tzinfo=dt.timezone.utc).timestamp() * 1000)
DAY = 86400000
ADDRESS = 'synthetic-offline-wallet'


def iso(at):
    return dt.datetime.fromtimestamp(at / 1000, dt.timezone.utc).isoformat()


def transaction(n, at, received=0, spent=0, height=None):
    return {'txid': format(n, '064x'), 'time': at // 1000, 'height': height or n,
            'received': received, 'spent': spent, 'delta': received - spent, 'fee': 10}


def fixture():
    chain = {'version': 1, 'address': ADDRESS, 'fetchedAt': iso(END), 'transactions': [
        transaction(1, END - 100 * DAY, received=10**8)], 'pending': [],
        'summary': {'address': ADDRESS, 'chain_stats': {'tx_count': 1,
            'funded_txo_sum': 10**8, 'spent_txo_sum': 0}},
        'prices': [{'time': (END - 100 * DAY) // 1000, 'USD': 100},
                   {'time': (END - 7 * DAY) // 1000, 'USD': 100}],
        'quote': {'time': END // 1000, 'USD': 130},
        'fx': {'rates': [{'date': '2026-01-01', 'rate': 7}]}}
    okx = {'configured': True, 'status': 'connected', 'last_success_at': iso(END),
           'summary': {'btc_holdings_total': '.1', 'btc_total': '1234'}}
    ledger = {'complete': True, 'coverage_start_ms': END - 90 * DAY,
              'coverage_end_ms': END, 'events': [], 'reason': ''}
    return chain, okx, ledger


def add_tx(chain, row):
    chain['transactions'].append(row)
    stats = chain['summary']['chain_stats']
    stats['tx_count'] += 1
    stats['funded_txo_sum'] += row['received']
    stats['spent_txo_sum'] += row['spent']


class CombinedAccountingTests(unittest.TestCase):
    def run_engine(self, triple=None, now=END):
        return build_combined(*(triple or fixture()), now_ms=now)

    def test_exact_current_btc_uses_cash_net_not_derivatives_equity(self):
        chain, okx, ledger = fixture()
        okx['summary']['btc_holdings_total'] = '0.00000000000000012345678901234567'
        result = self.run_engine((chain, okx, ledger))
        self.assertEqual(result['current']['btc_total'], '1.00000000000000012345678901234567')
        self.assertEqual(result['current']['okx_btc'], '0.00000000000000012345678901234567')
        self.assertAlmostEqual(result['current']['value_usd'], 130.0, places=12)
        self.assertFalse(result['current']['stale'])

    def test_all_btc_is_same_usd_cny_basis_and_milestones(self):
        result = self.run_engine()
        self.assertEqual(result['current']['value_usd'], 143)
        self.assertEqual(result['current']['value_cny'], 1001)
        self.assertEqual(result['milestones']['progress_pct'], 100)
        self.assertEqual(result['milestones']['remaining_btc'], '0')
        self.assertTrue(all(row['state'] == 'achieved' for row in result['milestones']['stages']))

    def test_negative_exchange_net_holdings_preserved(self):
        chain, okx, ledger = fixture()
        okx['summary']['btc_holdings_total'] = '-1.25'
        result = self.run_engine((chain, okx, ledger))
        self.assertEqual(result['current']['btc_total'], '-0.25')
        self.assertEqual(result['milestones']['progress_pct'], 0)
        self.assertEqual(result['milestones']['remaining_btc'], '1.25')
        self.assertEqual(result['milestones']['next_remaining_btc'], '0.35')

    def test_milestones_total_all_sources_not_each_separately(self):
        chain, okx, ledger = fixture()
        chain['transactions'][0]['received'] = 20_000_000
        chain['transactions'][0]['delta'] = 20_000_000
        chain['summary']['chain_stats']['funded_txo_sum'] = 20_000_000
        result = self.run_engine((chain, okx, ledger))
        self.assertEqual(result['milestones']['progress_pct'], 30)
        self.assertEqual(result['milestones']['next_btc'], '0.5')
        self.assertEqual(result['milestones']['next_remaining_btc'], '0.2')
        self.assertEqual([row['state'] for row in result['milestones']['stages']], ['achieved', 'achieved', 'next', 'upcoming'])

    def test_history_never_invents_prefix_before_verified_ledger(self):
        chain, okx, ledger = fixture()
        ledger['coverage_start_ms'] = END - DAY
        result = self.run_engine((chain, okx, ledger))
        self.assertEqual(result['history'][0]['at_ms'], END - DAY)
        self.assertTrue(all(row['at_ms'] >= END - DAY for row in result['history']))
        self.assertIsNone(result['pnl']['7']['value_usd'])
        self.assertIn('完整周期', result['pnl']['7']['reason'])

    def test_incomplete_history_never_turns_unknown_into_zero_profit(self):
        chain, okx, ledger = fixture()
        ledger.update(complete=False, reason='接口仅返回部分账单')
        result = self.run_engine((chain, okx, ledger))
        self.assertEqual(result['current']['btc_total'], '1.1')
        self.assertEqual(result['history'], [])
        self.assertEqual(result['coverage']['reason'], '接口仅返回部分账单')
        self.assertTrue(all(row['value_usd'] is None for row in result['pnl'].values()))

    def test_ledger_ending_before_live_account_does_not_assume_unchanged(self):
        chain, okx, ledger = fixture()
        ledger['coverage_end_ms'] = END - 1000
        result = self.run_engine((chain, okx, ledger))
        self.assertFalse(result['coverage']['complete'])
        self.assertEqual(result['history'], [])
        self.assertIsNone(result['pnl']['today']['value_usd'])
        self.assertEqual(result['current']['btc_total'], '1.1')

    def test_non_overlapping_sources_keep_current_without_history(self):
        chain, okx, ledger = fixture()
        chain['fetchedAt'] = iso(END - DAY)
        chain['quote'] = None
        ledger['coverage_start_ms'] = END - 1000
        result = self.run_engine((chain, okx, ledger))
        self.assertFalse(result['coverage']['complete'])
        self.assertIn('共同', result['coverage']['reason'])
        self.assertEqual(result['current']['btc_total'], '1.1')

    def test_current_stale_retains_last_valid_values_and_source_times(self):
        chain, okx, ledger = fixture()
        okx['status'] = 'stale'
        result = self.run_engine((chain, okx, ledger))
        self.assertTrue(result['current']['stale'])
        self.assertEqual(result['current']['btc_total'], '1.1')
        self.assertEqual(result['current']['onchain_as_of_ms'], END)
        self.assertEqual(result['current']['okx_as_of_ms'], END)
        self.assertTrue(self.run_engine(now=END + 91000)['current']['stale'])

    def test_cash_adjusted_usd_profit_all_supported_periods(self):
        result = self.run_engine()
        for period in ('today', '7', '30', '90'):
            expected = 33
            self.assertEqual(result['pnl'][period]['value_usd'], expected)
            self.assertEqual(result['pnl'][period]['value_cny'], expected * 7)
            self.assertEqual(result['pnl'][period]['reason'], '')

    def test_deposits_withdrawals_trades_fees_are_not_btc_price_profit(self):
        chain, okx, ledger = fixture()
        start, middle = END - 7 * DAY, END - 3 * DAY
        add_tx(chain, transaction(2, start, received=2 * 10**8))
        add_tx(chain, transaction(3, middle, spent=10**8))
        chain['prices'].append({'time': middle // 1000, 'USD': 120})
        okx['summary']['btc_holdings_total'] = '.5'
        ledger['events'] = [{'id': 'btc-trade', 'at_ms': middle, 'account': 'trading',
                             'delta_btc': '.3', 'kind': 'trade'}]
        result = self.run_engine((chain, okx, ledger))['pnl']['7']
        self.assertEqual(result['opening_usd'], 120)
        self.assertEqual(result['flows_usd'], 116)
        self.assertEqual(result['closing_usd'], 325)
        self.assertEqual(result['value_usd'], 89)
        self.assertEqual(result['value_cny'], 623)

    def test_same_timestamp_price_and_flow_use_that_price_without_future_lookahead(self):
        chain, okx, ledger = fixture()
        middle = END - 3 * DAY
        chain['prices'].append({'time': middle // 1000, 'USD': 110})
        ledger['events'] = [{'id': 'trade', 'at_ms': middle, 'account': 'trading', 'delta_btc': '.05', 'kind': 'trade'}]
        result = self.run_engine((chain, okx, ledger))
        self.assertEqual(result['pnl']['7']['flows_usd'], 5.5)
        self.assertEqual(result['pnl']['7']['value_usd'], 32.5)
        point = next(row for row in result['history'] if row['at_ms'] == middle)
        self.assertEqual(point['btc_total'], '1.1')
        self.assertEqual(point['value_usd'], 121)

    def test_same_time_onchain_to_exchange_transfer_does_not_count_twice(self):
        chain, okx, ledger = fixture()
        middle = END - 3 * DAY
        add_tx(chain, transaction(2, middle, spent=20_000_000))
        okx['summary']['btc_holdings_total'] = '.3'
        ledger['events'] = [{'id': 'deposit', 'at_ms': middle, 'account': 'funding', 'delta_btc': '.2', 'kind': 'flow'}]
        result = self.run_engine((chain, okx, ledger))
        self.assertEqual(result['current']['btc_total'], '1.1')
        self.assertEqual(result['pnl']['7']['flows_usd'], 0)
        self.assertEqual(result['pnl']['7']['value_usd'], 33)
        self.assertTrue(all(row['btc_total'] == '1.1' for row in result['history']))

    def test_identified_internal_transfer_different_times_is_neutral(self):
        chain, okx, ledger = fixture()
        first, second = END - 5 * DAY, END - 4 * DAY
        chain['prices'].extend([{'time': first // 1000, 'USD': 105}, {'time': second // 1000, 'USD': 120}])
        ledger['events'] = [
            {'id': 'out', 'at_ms': first, 'account': 'trading', 'delta_btc': '-.09', 'kind': 'internal_transfer', 'transfer_id': 'verified-id'},
            {'id': 'in', 'at_ms': second, 'account': 'funding', 'delta_btc': '.09', 'kind': 'internal_transfer', 'transfer_id': 'verified-id'}]
        result = self.run_engine((chain, okx, ledger))
        self.assertEqual(result['pnl']['7']['value_usd'], 33)
        self.assertEqual(result['pnl']['7']['flows_usd'], 0)
        self.assertTrue(all(row['btc_total'] == '1.1' for row in result['history']))
        self.assertFalse(result['coverage']['internal_transfer_timing_uncertain'])

    def test_closed_internal_transfers_need_no_guessed_bill_pairing_for_period_pnl(self):
        chain, okx, ledger = fixture()
        ledger['events'] = [
            {'id': 'out', 'at_ms': END - 5 * DAY, 'account': 'trading', 'delta_btc': '-.09', 'kind': 'internal_transfer'},
            {'id': 'in', 'at_ms': END - 4 * DAY, 'account': 'funding', 'delta_btc': '.09', 'kind': 'internal_transfer'}]
        result = self.run_engine((chain, okx, ledger))
        self.assertEqual(33, result['pnl']['7']['value_usd'])
        self.assertEqual(0, result['pnl']['7']['flows_usd'])
        self.assertIsNotNone(result['pnl']['today']['value_usd'])
        self.assertTrue(result['coverage']['internal_transfer_timing_uncertain'])

    def test_closed_internal_legs_at_different_prices_never_create_market_pnl(self):
        chain, okx, ledger = fixture()
        first, second = END - 5 * DAY, END - 4 * DAY
        chain['prices'].extend([{'time': first // 1000, 'USD': 105}, {'time': second // 1000, 'USD': 120}])
        ledger['events'] = [
            {'id': 'out', 'at_ms': first, 'account': 'trading', 'delta_btc': '-.09', 'kind': 'internal_transfer'},
            {'id': 'in', 'at_ms': second, 'account': 'funding', 'delta_btc': '.09', 'kind': 'internal_transfer'}]
        result = self.run_engine((chain, okx, ledger))
        self.assertEqual(33, result['pnl']['7']['value_usd'])
        self.assertEqual(0, result['pnl']['7']['flows_usd'])
        self.assertEqual(231, result['pnl']['7']['value_cny'])

    def test_unsettled_internal_flow_at_period_boundary_remains_unavailable(self):
        chain, okx, ledger = fixture()
        ledger['events'] = [
            {'id': 'out', 'at_ms': END - 8 * DAY, 'account': 'trading', 'delta_btc': '-.09', 'kind': 'internal_transfer'},
            {'id': 'in', 'at_ms': END - 6 * DAY, 'account': 'funding', 'delta_btc': '.09', 'kind': 'internal_transfer'}]
        result = self.run_engine((chain, okx, ledger))
        self.assertIsNone(result['pnl']['7']['value_usd'])
        self.assertIn('未结清', result['pnl']['7']['reason'])
        self.assertIsNotNone(result['pnl']['30']['value_usd'])

    def test_internal_transfer_id_cannot_hide_wrong_or_same_account_legs(self):
        for second_account, second_amount in [('trading', '.09'), ('funding', '.08')]:
            chain, okx, ledger = fixture()
            ledger['events'] = [
                {'id': 'out', 'at_ms': END - 5 * DAY, 'account': 'trading', 'delta_btc': '-.09', 'kind': 'internal_transfer', 'transfer_id': 'same'},
                {'id': 'in', 'at_ms': END - 4 * DAY, 'account': second_account, 'delta_btc': second_amount, 'kind': 'internal_transfer', 'transfer_id': 'same'}]
            self.assertIsNone(self.run_engine((chain, okx, ledger))['pnl']['7']['value_usd'])

    def test_distinct_account_bill_ids_are_not_duplicates(self):
        chain, okx, ledger = fixture()
        ledger['events'] = [{'id': '1', 'at_ms': END - DAY, 'account': account, 'delta_btc': delta, 'kind': 'flow'}
                            for account, delta in [('trading', '.01'), ('funding', '-.01')]]
        self.assertEqual(self.run_engine((chain, okx, ledger))['pnl']['7']['value_usd'], 33)
        ledger['events'].append(copy.deepcopy(ledger['events'][0]))
        with self.assertRaisesRegex(AccountingError, '重复'):
            self.run_engine((chain, okx, ledger))

    def test_unchanged_prices_and_arbitrary_fractional_cashflows_give_exact_zero(self):
        chain, okx, ledger = fixture()
        for sample in chain['prices'] + [chain['quote']]:
            sample['USD'] = '81829.12345678'
        ledger['events'] = [{'id': str(n), 'at_ms': END - n * DAY, 'account': 'trading',
            'delta_btc': delta, 'kind': kind} for n, delta, kind in [
                (1, '.00000000000000000001', 'fee'), (2, '-.01234567890123456789', 'trade'), (3, '.1', 'income')]]
        result = self.run_engine((chain, okx, ledger))
        self.assertEqual(result['pnl']['7']['value_usd'], 0)
        self.assertEqual(result['pnl']['7']['value_cny'], 0)

    def test_missing_fx_only_suppresses_cny_not_usd(self):
        chain, okx, ledger = fixture()
        chain['fx'] = None
        result = self.run_engine((chain, okx, ledger))
        self.assertEqual(result['current']['value_usd'], 143)
        self.assertIsNone(result['current']['value_cny'])
        self.assertEqual(result['pnl']['7']['value_usd'], 33)
        self.assertIsNone(result['pnl']['7']['value_cny'])
        self.assertEqual(result['pnl']['7']['reason_usd'], '')
        self.assertIn('汇率', result['pnl']['7']['reason_cny'])

    def test_exchange_rate_applies_next_utc_day_never_future_same_day_fixing(self):
        chain, okx, ledger = fixture()
        chain['fx']['rates'] += [{'date': '2026-10-23', 'rate': 6}, {'date': '2026-10-24', 'rate': 1}]
        result = self.run_engine((chain, okx, ledger))
        self.assertEqual(result['current']['fx_rate'], 6)
        self.assertEqual(result['current']['value_cny'], 858)
        self.assertEqual(result['pnl']['7']['value_cny'], 88)

    def test_fx_rate_changes_are_valued_at_each_cashflow(self):
        chain, okx, ledger = fixture()
        mid = END - 3 * DAY
        ledger['events'] = [{'id': 'acquire', 'at_ms': mid, 'account': 'trading', 'delta_btc': '.1', 'kind': 'trade'}]
        chain['fx']['rates'] += [{'date': '2026-10-20', 'rate': 6}, {'date': '2026-10-23', 'rate': 5}]
        result = self.run_engine((chain, okx, ledger))['pnl']['7']
        self.assertEqual(result['opening_cny'], 700)
        self.assertEqual(result['flows_cny'], 60)
        self.assertEqual(result['closing_cny'], 715)
        self.assertEqual(result['value_cny'], -45)

    def test_missing_historical_price_does_not_use_future_quote(self):
        chain, okx, ledger = fixture()
        chain['prices'] = []
        result = self.run_engine((chain, okx, ledger))
        self.assertEqual(result['current']['value_usd'], 143)
        self.assertIsNone(result['history'][0]['value_usd'])
        self.assertIsNone(result['pnl']['7']['value_usd'])
        self.assertIn('期初', result['pnl']['7']['reason'])

    def test_zero_balance_requires_no_prices_or_fx(self):
        chain, okx, ledger = fixture()
        chain['transactions'] = []
        chain['summary']['chain_stats'] = {'tx_count': 0, 'funded_txo_sum': 0, 'spent_txo_sum': 0}
        chain['prices'], chain['quote'], chain['fx'] = [], None, None
        okx['summary']['btc_holdings_total'] = '0'
        result = self.run_engine((chain, okx, ledger))
        self.assertEqual(result['current']['value_usd'], 0)
        self.assertEqual(result['current']['value_cny'], 0)
        self.assertEqual(result['pnl']['7']['value_usd'], 0)
        self.assertEqual(result['pnl']['7']['value_cny'], 0)

    def test_shanghai_midnight_boundary_and_stale_previous_day(self):
        chain, okx, ledger = fixture()
        result = self.run_engine((chain, okx, ledger))
        today_start = int(dt.datetime(2026, 10, 23, 16, tzinfo=dt.timezone.utc).timestamp() * 1000)
        self.assertEqual(result['pnl']['today']['start_ms'], today_start)
        self.assertEqual(result['pnl']['today']['value_usd'], 33)
        result = self.run_engine((chain, okx, ledger), now=END + DAY)
        self.assertIsNone(result['pnl']['today']['value_usd'])
        self.assertIn('今天', result['pnl']['today']['reason'])

    def test_no_price_from_today_rejects_today_pnl(self):
        chain, okx, ledger = fixture()
        chain['quote'] = None
        result = self.run_engine((chain, okx, ledger))
        self.assertIsNone(result['pnl']['today']['value_usd'])
        self.assertIn('今日', result['pnl']['today']['reason'])

    def test_price_and_event_after_common_end_do_not_affect_history_pnl(self):
        chain, okx, ledger = fixture()
        okx['last_success_at'] = iso(END - DAY)
        ledger['coverage_end_ms'] = END - DAY
        chain['prices'].append({'time': (END - DAY) // 1000, 'USD': 110})
        add_tx(chain, transaction(2, END - 1000, received=5 * 10**8))
        result = self.run_engine((chain, okx, ledger))
        self.assertEqual(result['history'][-1]['btc_total'], '1.1')
        self.assertEqual(result['history'][-1]['value_usd'], 121)
        self.assertEqual(result['current']['btc_total'], '6.1')
        self.assertEqual(result['pnl']['7']['value_usd'], 11)

    def test_ledger_cash_balance_reconstructs_history_instead_of_current_flat_prefix(self):
        chain, okx, ledger = fixture()
        ledger['events'] = [{'id': 'buy', 'at_ms': END - DAY, 'account': 'trading', 'delta_btc': '.08', 'kind': 'trade'}]
        result = self.run_engine((chain, okx, ledger))
        self.assertEqual(result['history'][0]['okx_btc'], '0.02')
        self.assertEqual(result['history'][-1]['okx_btc'], '0.1')
        self.assertEqual(result['pnl']['7']['value_usd'], 33)

    def test_input_data_is_not_mutated_and_output_is_strict_json(self):
        values = fixture()
        before = copy.deepcopy(values)
        result = self.run_engine(values)
        self.assertEqual(values, before)
        encoded = json.dumps(result, allow_nan=False)
        self.assertNotIn('Decimal', encoded)

    def test_invalid_snapshot_coverage_and_double_counting_fail_closed(self):
        mutations = [lambda c: c['summary']['chain_stats'].update(tx_count=2),
                     lambda c: c['summary']['chain_stats'].update(funded_txo_sum=2 * 10**8),
                     lambda c: c['transactions'][0].update(delta=2 * 10**8),
                     lambda c: c['transactions'][0].update(time=None),
                     lambda c: c['transactions'][0].update(received=True),
                     lambda c: c['summary'].update(address='other'),
                     lambda c: c['transactions'][0].update(fee=-1)]
        for change in mutations:
            with self.subTest(change=change):
                chain, okx, ledger = fixture()
                change(chain)
                with self.assertRaises(AccountingError):
                    self.run_engine((chain, okx, ledger))

    def test_bad_decimal_values_never_become_zero_holdings(self):
        for bad in [None, '', True, 'NaN', 'Infinity', {}, [], '1e500', '0.' + '0' * 32 + '1']:
            with self.subTest(bad=bad):
                chain, okx, ledger = fixture()
                okx['summary']['btc_holdings_total'] = bad
                with self.assertRaises(AccountingError):
                    self.run_engine((chain, okx, ledger))
        chain, okx, ledger = fixture()
        del okx['summary']['btc_holdings_total']
        with self.assertRaises(AccountingError):
            self.run_engine((chain, okx, ledger))

    def test_invalid_price_fx_and_naive_timestamps_fail_closed(self):
        changes = [lambda c: c['prices'].append(copy.deepcopy(c['prices'][-1])),
                   lambda c: c['quote'].update(time=END // 1000 + 1),
                   lambda c: c['quote'].update(USD='NaN'),
                   lambda c: c['fx']['rates'].append({'date': '2026-02-30', 'rate': 7}),
                   lambda c: c['fx']['rates'].append({'date': '2026-01-01', 'rate': 8}),
                   lambda c: c.update(fetchedAt='2026-10-24T08:00:00')]
        for change in changes:
            with self.subTest(change=change):
                chain, okx, ledger = fixture()
                change(chain)
                with self.assertRaises(AccountingError):
                    self.run_engine((chain, okx, ledger))


class NormalizeOnchainTests(unittest.TestCase):
    def raw_fixture(self):
        chain, _, _ = fixture()
        raw = [{'txid': format(1, '064x'), 'status': {'confirmed': True,
            'block_time': (END - 100 * DAY) // 1000, 'block_height': 100},
            'vin': [], 'vout': [{'scriptpubkey_address': ADDRESS, 'value': 10**8}], 'fee': 10}]
        return chain, raw

    def normalize(self, chain, raw):
        return normalize_onchain(chain['summary'], raw, chain['prices'], chain['quote'],
                                 chain['fx'], chain['fetchedAt'], ADDRESS)

    def test_public_address_history_matches_original_wallet_schema(self):
        chain, raw = self.raw_fixture()
        result = self.normalize(chain, raw)
        self.assertEqual(result['transactions'][0]['delta'], 10**8)
        self.assertEqual(result['summary'], chain['summary'])
        _, okx, ledger = fixture()
        self.assertEqual(build_combined(result, okx, ledger, END)['current']['btc_total'], '1.1')

    def test_unconfirmed_rows_excluded_and_never_counted_as_offline_balance(self):
        chain, raw = self.raw_fixture()
        raw.append({'txid': 'unconfirmed', 'status': {'confirmed': False}})
        self.assertEqual(len(self.normalize(chain, raw)['transactions']), 1)

    def test_same_block_dependency_order_replays_spend_after_receive(self):
        chain, raw = self.raw_fixture()
        raw[0]['vout'][0]['value'] = 10**8
        spend = {'txid': format(2, '064x'), 'status': dict(raw[0]['status']),
                 'vin': [{'txid': raw[0]['txid'], 'prevout': {'scriptpubkey_address': ADDRESS, 'value': 10**8}}],
                 'vout': [{'scriptpubkey_address': ADDRESS, 'value': 50_000_000}], 'fee': 10}
        chain['summary']['chain_stats'] = {'tx_count': 2, 'funded_txo_sum': 150_000_000, 'spent_txo_sum': 10**8}
        result = self.normalize(chain, [spend, raw[0]])
        self.assertEqual([row['txid'] for row in result['transactions']], [raw[0]['txid'], spend['txid']])
        _, okx, ledger = fixture()
        self.assertEqual(build_combined(result, okx, ledger, END)['current']['btc_total'], '0.6')

    def test_duplicates_in_raw_history_cannot_disappear_in_dependency_map(self):
        chain, raw = self.raw_fixture()
        chain['summary']['chain_stats']['tx_count'] = 2
        with self.assertRaisesRegex(AccountingError, '重复'):
            self.normalize(chain, raw + raw)

    def test_incomplete_pages_rejected_not_shown_as_small_wallet(self):
        chain, raw = self.raw_fixture()
        with self.assertRaisesRegex(AccountingError, '数量'):
            self.normalize(chain, [])

    def test_unrelated_address_transactions_rejected(self):
        chain, raw = self.raw_fixture()
        raw[0]['vout'][0]['scriptpubkey_address'] = 'other-address'
        with self.assertRaises(AccountingError):
            self.normalize(chain, raw)


if __name__ == '__main__':
    unittest.main()
