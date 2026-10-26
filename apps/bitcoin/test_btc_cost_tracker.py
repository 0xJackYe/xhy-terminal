"""Exact accounting and failure/restart controls, with no real keys or network."""
import copy
import datetime as dt
from decimal import Decimal
from pathlib import Path
import tempfile
import threading
import time
import unittest

from btc_cost_tracker import (BTCCostTracker, CostValidationError, MAX_OFFLINE_MS,
                              normalize_bills, merge_trades, summarize)
from okx_wallet_service import OKXVault, identity


NOW = int(dt.datetime(2026, 10, 26, 1, 0, tzinfo=dt.timezone(dt.timedelta(hours=8))).timestamp() * 1000)
CREDS = {'api_key': 'fixture-key', 'secret_key': 'fixture-secret', 'passphrase': 'fixture-passphrase'}


def trade(side='buy', size='0.001', price='100000', fee_btc='-0.000001', fee_quote='0',
          at=NOW - 1000, trade_id=1, quote='USDT', convert=False, reverse=False):
    gross = Decimal(size) * Decimal(price)
    buy = side == 'buy'
    inst = quote + '-BTC' if reverse else 'BTC-' + quote
    if convert:
        inst += '-CONVERT'
    row = {'instType': 'SPOT', 'instId': inst, 'tradeId': str(trade_id), 'ordId': str(trade_id + 100),
           'ts': str(at), 'fillTime': str(at), 'px': str(Decimal(1) / Decimal(price)) if reverse else price}
    btc = dict(row, billId=str(trade_id * 2), ccy='BTC', sz=size, fee=fee_btc,
               balChg=str((Decimal(size) if buy else -Decimal(size)) + Decimal(fee_btc)),
               subType=('318' if buy else '319') if convert else ('1' if buy else '2'))
    pay = dict(row, billId=str(trade_id * 2 + 1), ccy=quote, sz=str(gross), fee=fee_quote,
               balChg=str((-gross if buy else gross) + Decimal(fee_quote)),
               subType=('319' if buy else '318') if convert else ('2' if buy else '1'))
    return [btc, pay]


class FakeOKX:
    def __init__(self):
        self.lock = threading.RLock()
        self.credentials = dict(CREDS)
        self.generation = 0


class Factory:
    def __init__(self, now):
        self.now = now
        self.rows = []
        self.error = None
        self.calls = []
        self.closed = 0
        self.result_changes = {}
        self.on_read = None

    def __call__(self, credentials):
        self.calls.append(copy.deepcopy(credentials))
        parent = self
        class Client:
            def read_since(self, start):
                parent.start = start
                if parent.on_read:
                    parent.on_read()
                if parent.error:
                    raise parent.error
                return dict({'rows': copy.deepcopy(parent.rows), 'as_of_ms': parent.now[0],
                             'coverage_start_ms': start, 'complete': True}, **parent.result_changes)
            def close(self):
                parent.closed += 1
        return Client()


class NormalizationTests(unittest.TestCase):
    def test_buy_uses_actual_cash_and_net_btc(self):
        result = normalize_bills(trade(fee_quote='-0.1'))[0]
        self.assertEqual(result['btc_net'], '0.000999')
        self.assertEqual(result['quote_amount'], '100.1')
        self.assertEqual(result['fee_btc'], '-0.000001')

    def test_sale_deducts_quote_fee_and_btc_fee(self):
        result = normalize_bills(trade('sell', fee_quote='-0.1'))[0]
        self.assertEqual(result['btc_net'], '-0.001001')
        self.assertEqual(result['quote_amount'], '99.9')

    def test_rebate_is_added_to_actual_balance(self):
        row = normalize_bills(trade(fee_btc='0.0000001', fee_quote='0.1'))[0]
        self.assertEqual(row['btc_net'], '0.0010001')
        self.assertEqual(row['quote_amount'], '99.9')

    def test_reverse_pair_unit_is_payment_currency_per_btc(self):
        row = normalize_bills(trade(price='25', quote='ETH', reverse=True, fee_btc='0'))[0]
        self.assertEqual(row['price'], '25')
        self.assertEqual(row['quote_amount'], '0.025')
        self.assertEqual(row['original_price'], '0.04')

    def test_convert_both_directions(self):
        for side in ('buy', 'sell'):
            row = normalize_bills(trade(side, price='25', quote='ETH', reverse=True, convert=True))[0]
            self.assertEqual(row['side'], side)

    def test_convert_rounding_tolerance_matches_actual_ledger_amount(self):
        rows = trade(convert=True, fee_btc='0')
        rows[1].update(sz='100.00001', balChg='-100.00001')
        with self.assertRaises(CostValidationError):
            normalize_bills(rows)
        rows[1].update(sz='100.0', balChg='-100.0')
        self.assertEqual(normalize_bills(rows)[0]['quote_amount'], '100')

    def test_convert_trailing_zeroes_do_not_widen_declared_rounding(self):
        rows = trade(convert=True, fee_btc='0', size='0.00100000')
        rows[1].update(sz='100.00000000', balChg='-100.00000000')
        rows[0]['px'] = '100001'
        with self.assertRaises(CostValidationError):
            normalize_bills(rows)

    def test_duplicate_bills_are_idempotent(self):
        rows = trade()
        self.assertEqual(len(normalize_bills(rows + copy.deepcopy(rows))), 1)

    def test_same_original_bill_cannot_be_remapped_to_new_trade(self):
        original = normalize_bills(trade())
        changed_rows = trade(trade_id=2)
        changed_rows[0]['billId'], changed_rows[1]['billId'] = '2', '3'
        with self.assertRaises(CostValidationError):
            merge_trades(original, normalize_bills(changed_rows))

    def test_archived_leading_apostrophe_ids_and_second_precision(self):
        rows = trade(at=NOW-1234)
        old = copy.deepcopy(rows)
        for row in old:
            for key in ('billId', 'tradeId', 'ordId'):
                row[key] = "'" + row[key]
            row['ts'] = row['fillTime'] = str(int(row['ts']) // 1000 * 1000)
        self.assertEqual(len(normalize_bills(rows + old)), 1)
        combined = merge_trades(normalize_bills(old), normalize_bills(rows))
        self.assertEqual(len(combined), 1)

    def test_conflicting_duplicate_fails(self):
        rows = trade()
        duplicate = copy.deepcopy(rows)
        duplicate[0]['fee'] = '-0.000002'
        with self.assertRaises(CostValidationError):
            normalize_bills(rows + duplicate)

    def test_unpaired_or_corrupt_legs_fail(self):
        rows = trade()
        for broken in ([rows[0]], [dict(rows[0], balChg='999'), rows[1]],
                       [rows[0], dict(rows[1], px='NaN')],
                       [rows[0], dict(rows[1], subType='1')]):
            with self.subTest(broken=broken):
                with self.assertRaises(CostValidationError):
                    normalize_bills(broken)

    def test_ignores_transfers_derivatives_margin_other_coin(self):
        rows = []
        for inst_type, instrument, subtype in [('SWAP', 'BTC-USDT', '1'), ('MARGIN', 'BTC-USDT', '1'),
                                               ('SPOT', 'BTC-USDT', '11'), ('SPOT', 'ETH-USDT', '1')]:
            rows.append({'instType': inst_type, 'instId': instrument, 'subType': subtype})
        self.assertEqual(normalize_bills(rows), [])

    def test_separate_currency_cost_and_no_sale_subtracted_from_buy_average(self):
        records = normalize_bills(trade() + trade('sell', fee_btc='0', trade_id=2)
                                  + trade(trade_id=3, quote='USDC') + trade(trade_id=4, price='25', quote='ETH', reverse=True))
        summary, today = summarize(records, NOW)
        self.assertEqual(summary['buy_count'], 3)
        self.assertEqual(summary['sell_count'], 1)
        currencies = {row['currency']: row for row in summary['by_currency']}
        self.assertEqual(currencies['USDT']['net_invested'], '0')
        self.assertEqual(currencies['USDC']['net_invested'], '100')
        self.assertEqual(currencies['ETH']['net_invested'], '0.025')
        self.assertEqual(today['buy_spent_usdt'], '100')
        self.assertEqual(today['remaining_plan_usdt'], '0')


class TrackerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.vault = OKXVault(self.tmp.name, seal=lambda b: b'fixture:' + b,
                              unseal=lambda b: b.removeprefix(b'fixture:'))
        self.okx = FakeOKX()
        self.now = [NOW]
        self.factory = Factory(self.now)
        self.tracker = self.make_tracker()

    def tearDown(self):
        self.tracker.stop()
        self.tmp.cleanup()

    def make_tracker(self):
        return BTCCostTracker(self.okx, vault=self.vault, client_factory=self.factory,
                              clock=lambda: self.now[0] / 1000, interval=20)

    def seed(self, rows=None):
        self.tracker.bootstrap(trade() if rows is None else rows, as_of_ms=NOW,
                               coverage_start_ms=NOW-30*86400000)

    def test_without_history_does_not_invent_three_month_total(self):
        self.assertFalse(self.tracker.refresh_once())
        view = self.tracker.read_public()
        self.assertEqual(view['status'], 'unavailable')
        self.assertIsNone(view['summary'])
        self.assertEqual(view['error_code'], 'needs_history')
        self.assertEqual(self.factory.calls, [])

    def test_incremental_buy_is_durable_and_replays_are_idempotent(self):
        self.seed()
        self.now[0] += 10000
        self.factory.rows = trade() + trade(trade_id=2, at=self.now[0]-1, size='0.00002', price='100000', fee_btc='-0.00000002')
        self.assertTrue(self.tracker.refresh_once())
        self.assertTrue(self.tracker.refresh_once())
        self.assertEqual(self.tracker.read_public()['summary']['buy_count'], 2)
        self.assertEqual(self.tracker.read_public()['summary']['by_currency'][0]['buy_spent'], '102')
        restarted = self.make_tracker()
        self.assertEqual(restarted.read_public()['summary'], self.tracker.read_public()['summary'])
        self.assertEqual(self.factory.closed, 2)
        self.assertEqual(self.factory.start, NOW - 2*86400000 + 10000)

    def test_sale_updates_net_investment_and_net_bought(self):
        self.seed()
        self.factory.rows = trade('sell', trade_id=2, size='0.0001', fee_btc='0', fee_quote='-0.01')
        self.assertTrue(self.tracker.refresh_once())
        summary = self.tracker.read_public()['summary']
        self.assertEqual(summary['net_bought_btc'], '0.000899')
        self.assertEqual(summary['by_currency'][0]['net_invested'], '90.01')

    def test_failure_keeps_verified_total_and_redacts_provider_message(self):
        self.seed()
        old = self.tracker.read_public()['summary']
        self.factory.error = RuntimeError('credential=TOP-SECRET https://bad.invalid/?signature=SECRET')
        self.assertFalse(self.tracker.refresh_once())
        view = self.tracker.read_public()
        self.assertEqual(view['summary'], old)
        self.assertEqual(view['status'], 'stale')
        self.assertNotIn('SECRET', str(view))
        self.assertGreater(view['retry_in_seconds'], 0)

    def test_failed_atomic_write_does_not_commit_in_memory(self):
        self.seed()
        original = self.vault._write
        self.vault._write = lambda *args: (_ for _ in ()).throw(OSError('disk full'))
        self.factory.rows = trade(trade_id=2)
        self.assertFalse(self.tracker.refresh_once())
        self.assertEqual(self.tracker.read_public()['summary']['buy_count'], 1)
        self.vault._write = original
        self.assertEqual(self.make_tracker().read_public()['summary']['buy_count'], 1)

    def test_account_switch_never_mixes_ledgers(self):
        self.seed()
        self.okx.credentials['api_key'] = 'other-key'
        view = self.tracker.read_public()
        self.assertIsNone(view['summary'])
        self.assertEqual(view['error_code'], 'needs_history')
        self.okx.credentials = dict(CREDS)
        self.assertEqual(self.tracker.read_public()['summary']['buy_count'], 1)

    def test_credentials_changed_during_request_discards_result(self):
        self.seed()
        self.factory.on_read = lambda: self.okx.credentials.update(api_key='other-key')
        self.assertFalse(self.tracker.refresh_once())
        self.assertIsNone(self.tracker.read_public()['summary'])

    def test_long_offline_gap_is_not_silently_accepted(self):
        self.seed()
        self.now[0] += MAX_OFFLINE_MS + 1
        self.assertFalse(self.tracker.refresh_once())
        view = self.tracker.read_public()
        self.assertEqual(view['summary']['buy_count'], 1)
        self.assertFalse(view['coverage_complete'])
        self.assertEqual(view['error_code'], 'history_gap')
        self.assertEqual(self.factory.calls, [])

    def test_incomplete_result_cannot_advance_cost_ledger(self):
        self.seed()
        for changes in ({'complete':False}, {'coverage_start_ms': NOW}, {'as_of_ms':NOW-1}):
            self.factory.result_changes = changes
            self.assertFalse(self.tracker.refresh_once())
            self.assertEqual(self.tracker.read_public()['last_success_at'], '2026-10-26T01:00:00.000+08:00')

    def test_conflicting_trade_keeps_previous_ledger(self):
        self.seed()
        self.factory.rows = trade(price='110000')
        self.assertFalse(self.tracker.refresh_once())
        self.assertEqual(self.tracker.read_public()['summary']['by_currency'][0]['buy_spent'], '100')

    def test_cannot_bootstrap_older_snapshot_over_newer_ledger(self):
        self.seed()
        with self.assertRaises(CostValidationError):
            self.tracker.bootstrap([], as_of_ms=NOW-1, coverage_start_ms=NOW-2000)
        self.assertEqual(self.tracker.read_public()['summary']['buy_count'], 1)

    def test_midnight_resets_daily_progress_only(self):
        self.seed(trade(at=NOW-2*3600000))
        self.assertEqual(self.tracker.read_public()['today']['buy_count'], 0)
        self.factory.rows = trade(trade_id=2, at=NOW-1000, size='0.00002', fee_btc='0')
        self.assertTrue(self.tracker.refresh_once())
        self.assertEqual(self.tracker.read_public()['today']['buy_spent_usdt'], '2')
        self.now[0] += 86400000
        view = self.tracker.read_public()
        self.assertEqual(view['today']['buy_spent_usdt'], '0')
        self.assertEqual(view['today']['remaining_plan_usdt'], '20')
        self.assertEqual(view['summary']['buy_count'], 2)

    def test_public_response_contains_no_raw_ids_or_credentials(self):
        self.seed()
        view = self.tracker.read_public()
        self.assertEqual(len(view['recent_trades'][0]['id']), 24)
        for value in CREDS.values():
            self.assertNotIn(value, str(view))
        self.assertNotIn('order_id', str(view))
        self.assertNotIn('trade_id', str(view))

    def test_read_public_and_refresh_request_do_not_network(self):
        self.seed()
        self.tracker.read_public()
        self.tracker.request_refresh()
        self.assertEqual(self.factory.calls, [])

    def test_public_read_is_not_blocked_by_encrypted_write(self):
        self.seed()
        original = self.vault._write
        writing, release = threading.Event(), threading.Event()
        def delayed_write(*args):
            writing.set()
            if not release.wait(2):
                raise RuntimeError('fixture write wait timeout')
            return original(*args)
        self.vault._write = delayed_write
        self.factory.rows = trade(trade_id=2)
        worker = threading.Thread(target=self.tracker.refresh_once)
        worker.start()
        self.assertTrue(writing.wait(1))
        start = time.monotonic()
        self.assertEqual(self.tracker.read_public()['summary']['buy_count'], 1)
        self.assertLess(time.monotonic() - start, 0.1)
        release.set()
        worker.join(2)
        self.assertEqual(self.tracker.read_public()['summary']['buy_count'], 2)

    def test_stopped_service_discards_late_network_result(self):
        self.seed()
        self.factory.rows = trade(trade_id=2)
        self.factory.on_read = self.tracker.stop_event.set
        self.assertFalse(self.tracker.refresh_once())
        self.assertEqual(self.tracker.read_public()['summary']['buy_count'], 1)
        self.assertEqual(self.make_tracker().read_public()['summary']['buy_count'], 1)

    def test_no_new_trade_reuses_cached_summary(self):
        self.seed()
        old = self.tracker.summary
        self.factory.rows = trade()
        self.assertTrue(self.tracker.refresh_once())
        self.assertIs(self.tracker.summary, old)

    def test_daily_non_usdt_buys_do_not_reduce_usdt_plan(self):
        self.seed(trade(quote='USDC'))
        today = self.tracker.read_public()['today']
        self.assertEqual(today['buy_count'], 1)
        self.assertEqual(today['buy_spent_usdt'], '0')
        self.assertEqual(today['remaining_plan_usdt'], '20')

    def test_bounded_recent_public_trades_and_connection(self):
        rows = []
        for index in range(1, 40):
            rows.extend(trade(trade_id=index, at=NOW-index*1000))
        self.seed(rows)
        view = self.tracker.read_public()
        self.assertEqual(len(view['recent_trades']), 30)
        self.assertEqual(view['connection_id'], identity(CREDS)[:24])
        self.assertGreater(view['recent_trades'][0]['time_beijing'], view['recent_trades'][-1]['time_beijing'])

    def test_account_switch_after_final_check_cannot_publish_other_account(self):
        self.seed()
        self.factory.rows = trade(trade_id=2)
        original_switch = self.tracker._switch_account
        switch_count = [0]
        switched = threading.Event()
        def switch_at_publication_boundary():
            result = original_switch()
            switch_count[0] += 1
            if switch_count[0] == 3:
                def select_b():
                    with self.okx.lock:
                        self.okx.credentials['api_key'] = 'other-key'
                        self.okx.generation += 1
                    original_switch()
                    switched.set()
                other = threading.Thread(target=select_b)
                other.start()
                self.assertTrue(switched.wait(1))
                other.join(1)
            return result
        self.tracker._switch_account = switch_at_publication_boundary
        self.assertFalse(self.tracker.refresh_once())
        self.tracker._switch_account = original_switch
        with self.tracker.lock:
            self.assertIsNone(self.tracker.state)
            self.assertNotEqual(self.tracker.connection, identity(CREDS))
        self.assertIsNone(self.tracker.read_public()['summary'])

    def test_source_credentials_change_without_tracker_switch_blocks_publish(self):
        self.seed()
        self.factory.rows = trade(trade_id=2)
        original_switch = self.tracker._switch_account
        switch_count = [0]
        def source_only_change():
            result = original_switch()
            switch_count[0] += 1
            if switch_count[0] == 3:
                with self.okx.lock:
                    self.okx.credentials['api_key'] = 'other-key'
                    self.okx.generation += 1
            return result
        self.tracker._switch_account = source_only_change
        self.assertFalse(self.tracker.refresh_once())
        self.tracker._switch_account = original_switch
        self.assertEqual(self.tracker.state['identity'], identity(CREDS))
        self.assertEqual(self.tracker.summary['buy_count'], 1)
        self.assertIsNone(self.tracker.read_public()['summary'])

    def test_generation_change_even_with_same_final_key_blocks_late_publish(self):
        self.seed()
        self.factory.rows = trade(trade_id=2)
        original_switch = self.tracker._switch_account
        switch_count = [0]
        def changed_generation():
            result = original_switch()
            switch_count[0] += 1
            if switch_count[0] == 3:
                with self.okx.lock:
                    self.okx.generation += 2
            return result
        self.tracker._switch_account = changed_generation
        self.assertFalse(self.tracker.refresh_once())
        self.tracker._switch_account = original_switch
        self.assertEqual(self.tracker.read_public()['summary']['buy_count'], 1)

    def test_bootstrap_source_change_during_write_never_exposes_wrong_account(self):
        original_write = self.vault._write
        def switch_during_write(*args):
            original_write(*args)
            with self.okx.lock:
                self.okx.credentials['api_key'] = 'other-key'
                self.okx.generation += 1
        self.vault._write = switch_during_write
        with self.assertRaises(CostValidationError):
            self.seed()
        self.assertIsNone(self.tracker.state)
        self.assertIsNone(self.tracker.read_public()['summary'])

    def test_stop_during_atomic_write_keeps_valid_durable_account_file_only(self):
        self.seed()
        original_write = self.vault._write
        def stop_during_write(*args):
            self.tracker.stop_event.set()
            return original_write(*args)
        self.vault._write = stop_during_write
        self.factory.rows = trade(trade_id=2)
        self.assertFalse(self.tracker.refresh_once())
        self.assertEqual(self.tracker.read_public()['summary']['buy_count'], 1)
        self.vault._write = original_write
        restarted = self.make_tracker()
        self.assertEqual(restarted.read_public()['summary']['buy_count'], 2)
        self.assertEqual(restarted.state['identity'], identity(CREDS))

    def test_reused_bill_rejects_refresh_and_preserves_old_file(self):
        self.seed()
        self.factory.rows = trade(trade_id=2)
        self.factory.rows[0]['billId'], self.factory.rows[1]['billId'] = '2', '3'
        self.assertFalse(self.tracker.refresh_once())
        self.assertEqual(self.tracker.read_public()['summary']['buy_count'], 1)
        self.assertEqual(self.make_tracker().read_public()['summary']['buy_count'], 1)

    def test_stored_ledger_validation_rejects_global_bill_reuse(self):
        self.seed()
        changed = copy.deepcopy(self.tracker.state)
        event = copy.deepcopy(changed['records'][0])
        event['id'] += ':changed'
        changed['records'].append(event)
        with self.assertRaises(CostValidationError):
            self.tracker._validate_state(changed, identity(CREDS))


if __name__ == '__main__':
    unittest.main()
