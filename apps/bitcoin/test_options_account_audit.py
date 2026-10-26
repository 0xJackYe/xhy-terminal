"""Offline integration checks: pagination, private output and real net equity."""
import copy
import json
import tempfile
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from options_account_audit import collect_account, fetch_window, redact, write_report


class WindowClient:
    def __init__(self, rows):
        self.rows = rows
        self.requests = 0

    def get(self, path, params):
        self.requests += 1
        return sorted([r for r in self.rows if params['startTime'] <= r['time'] <= params['endTime']],
                      key=lambda r: r['time'], reverse=True)[:params['limit']]


class AccountClient:
    now = int(datetime(2026, 10, 18, tzinfo=timezone.utc).timestamp() * 1000)

    def __init__(self, unknown=False):
        start = self.now - 40 * 86400000
        self.bills = [
            {'id': 1, 'asset': 'USDT', 'amount': '1000', 'type': 'TRANSFER', 'createDate': start},
            {'id': 2, 'asset': 'USDT', 'amount': '7.8', 'type': 'CONTRACT', 'symbol': 'BTC-261030-65000-P', 'createDate': start + 1},
            {'id': 3, 'asset': 'USDT', 'amount': '-0.78', 'type': 'FEE', 'symbol': 'BTC-261030-65000-P', 'createDate': start + 2},
        ]
        if unknown:
            self.bills.append({'id': 4, 'asset': 'USDT', 'amount': '0', 'type': 'NEW_TRANSFER_KIND', 'createDate': start + 3})

    def sync_time(self):
        return 0

    def get(self, path, params=None):
        if path.endswith('/time'):
            return {'serverTime': self.now}
        if path.endswith('/marginAccount'):
            return {'asset': [{'asset': 'USDT', 'marginBalance': '1007.02', 'equity': '999.22'}]}
        if path.endswith('/position'):
            return [{'symbol': 'BTC-261030-65000-P', 'side': 'SHORT', 'quantity': '-0.12',
                     'markPrice': '65', 'entryPrice': '65', 'markValue': '7.8',
                     'unrealizedPNL': '0', 'quoteAsset': 'USDT'}]
        if path.endswith('/apiRestrictions'):
            return {'enableReading': True, 'enableWithdrawals': False}
        if path.endswith('/bill'):
            return copy.deepcopy([r for r in self.bills if params['startTime'] <= r['createDate'] <= params['endTime']])
        if path.endswith('/exerciseRecord') or path.endswith('/userTrades'):
            return []
        raise AssertionError(path)


class AuditTests(unittest.TestCase):
    def test_full_page_splits_and_preserves_all_rows_and_large_ids(self):
        rows = [{'id': 9007199254740993000 + n, 'time': n} for n in range(1500)]
        client = WindowClient(rows)
        result, complete, notes = fetch_window(client, '/fake', 0, 1499, 'time')
        self.assertTrue(complete)
        self.assertEqual(len(result), 1500)
        self.assertEqual(result[0]['id'], 9007199254740993000)
        self.assertGreater(client.requests, 1)

    def test_saturated_single_millisecond_is_incomplete(self):
        client = WindowClient([{'id': n, 'time': 5} for n in range(1001)])
        rows, complete, notes = fetch_window(client, '/fake', 5, 5, 'time')
        self.assertFalse(complete)
        self.assertTrue(notes)

    def test_budget_exhaustion_is_incomplete(self):
        rows, complete, notes = fetch_window(WindowClient([]), '/fake', 1, 10, 'time', budget=[0])
        self.assertFalse(complete)

    def test_short_premium_is_not_profit_and_no_double_fee(self):
        client = AccountClient()
        result = collect_account(client, client.now - 40 * 86400000, Decimal(0))
        self.assertEqual(result['valuation']['equity'], Decimal('999.22'))
        self.assertEqual(result['performance']['net_pnl'], Decimal('-0.78'))
        self.assertEqual(result['performance']['net_external_flow'], Decimal('1000'))
        self.assertFalse(result['full_history_verified'])

    def test_missing_opening_equity_never_substitutes_1000_budget(self):
        client = AccountClient()
        result = collect_account(client, client.now - 40 * 86400000)
        self.assertIsNone(result['performance']['period_return'])
        self.assertIsNone(result['performance']['simple_annualized_return'])

    def test_unknown_bill_type_blocks_return(self):
        client = AccountClient(unknown=True)
        result = collect_account(client, client.now - 40 * 86400000, Decimal(0))
        self.assertFalse(result['performance']['flows_complete'])
        self.assertIsNone(result['performance']['period_return'])

    def test_conflicting_api_equity_blocks_return(self):
        class ConflictClient(AccountClient):
            def get(self, path, params=None):
                result = super().get(path, params)
                if path.endswith('/marginAccount'):
                    result['asset'][0]['equity'] = '1200'
                return result
        client = ConflictClient()
        result = collect_account(client, client.now - 40 * 86400000, Decimal(0))
        self.assertFalse(result['valuation']['api_equity_reconciled'])
        self.assertIsNone(result['performance']['period_return'])

    def test_transfer_during_final_snapshot_blocks_phantom_loss(self):
        class ActiveClient(AccountClient):
            def __init__(self):
                super().__init__()
                self.clock_calls = 0
                self.bills.append({'id': 99, 'asset': 'USDT', 'amount': '100',
                                   'type': 'TRANSFER', 'createDate': self.now + 1500})

            def get(self, path, params=None):
                if path.endswith('/time'):
                    offset = [0, 1000, 2000][min(self.clock_calls, 2)]
                    self.clock_calls += 1
                    return {'serverTime': self.now + offset}
                return super().get(path, params)
        client = ActiveClient()
        result = collect_account(client, client.now - 40 * 86400000, Decimal(0))
        self.assertTrue(result['snapshot_has_account_activity'])
        self.assertIsNone(result['performance']['net_pnl'])
        self.assertIsNone(result['performance']['period_return'])

    def test_old_start_cannot_apply_old_equity_to_recent_window(self):
        client = AccountClient()
        result = collect_account(client, client.now - 200 * 86400000, Decimal(500))
        self.assertIsNone(result['performance']['start_equity'])
        self.assertIsNone(result['performance']['period_return'])

    def test_redaction_nested_fields_and_echoed_secrets(self):
        value = {'API_Key': 'secret-key', 'list': [{'signature': 'signed-value', 'message': 'abc secret-value xyz'}]}
        result = redact(value, ('secret-key', 'secret-value'))
        self.assertNotIn('secret-key', json.dumps(result))
        self.assertNotIn('secret-value', json.dumps(result))
        self.assertNotIn('signed-value', json.dumps(result))

    def test_report_missing_return_stays_unknown(self):
        client = AccountClient()
        result = collect_account(client, client.now - 40 * 86400000)
        with tempfile.TemporaryDirectory() as folder:
            report = write_report(result, Path(folder))
            text = report.read_text(encoding='utf-8')
            self.assertIn('不可计算', text)
            self.assertIn('未确认', text)
            data = json.loads((Path(folder) / 'account-audit.json').read_text(encoding='utf-8'))
            self.assertIsNone(data['performance']['period_return'])


if __name__ == '__main__':
    unittest.main()
