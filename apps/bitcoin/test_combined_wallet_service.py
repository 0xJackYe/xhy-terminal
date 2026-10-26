"""Offline aggregate-service and actual loopback boundary tests.

Only synthetic account data is used; no real vault or network provider is read.
"""
import copy
import datetime as dt
from decimal import Decimal
import http.client
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from btc_terminal_server import TerminalServer
from combined_wallet_engine import build_combined
from combined_wallet_service import AddressSnapshots, CombinedWalletService, adapt_view, fiat_text
from okx_wallet_service import asset_view
from test_combined_wallet_engine import DAY, END, fixture, iso
from test_okx_wallet_service import snapshot as account_fixture


class FakeVault:
    def __init__(self):
        self.lock = threading.RLock()
        self.data = {}

    def _write(self, filename, value):
        self.data[filename] = copy.deepcopy(value)


class FakeOKX:
    def __init__(self):
        _, self.value, self.history = fixture()
        self.value['connection_id'] = 'synthetic-account-A'
        self.lock = threading.RLock()
        self.vault = FakeVault()
        self.credentials = {'test': 'synthetic-never-exposed'}
        self.calls = []
        self.release = self.started = None
        self.failure = None

    def read_public(self):
        return copy.deepcopy(self.value)

    def client_factory(self, credentials):
        parent = self

        class Client:
            def read_btc_history(self, start, end):
                parent.calls.append((start, end))
                if parent.started:
                    parent.started.set()
                if parent.release and not parent.release.wait(2):
                    raise RuntimeError('fixture timeout')
                if parent.failure:
                    raise parent.failure
                return copy.deepcopy(parent.history)
        return Client()


class FakeSource:
    def __init__(self):
        self.snapshot = fixture()[0]
        self.calls = 0
        self.failure = None

    def refresh(self):
        self.calls += 1
        if self.failure:
            raise self.failure
        return copy.deepcopy(self.snapshot)


def service(preload=True):
    now = [END / 1000]
    online, offline = FakeOKX(), FakeSource()
    result = CombinedWalletService(online, None, source=offline, clock=lambda: now[0])
    if preload:
        result.connection = online.value['connection_id']
        result.ledger_connection = result.connection
        result.ledger = copy.deepcopy(online.history)
        result.last_ledger_attempt = now[0]
    return result, online, offline, now


class CombinedServiceTests(unittest.TestCase):
    def test_beijing_rollover_refreshes_both_anchors_before_five_minute_interval(self):
        result, online, source, now = service()
        midnight = ((int(now[0]) + 28800) // 86400) * 86400 - 28800
        now[0] = midnight - 30
        result.last_address_refresh = result.last_ledger_attempt = now[0]
        with patch.object(result, '_history_task') as history:
            result.refresh_once()
            self.assertEqual(source.calls, 0)
            self.assertEqual(history.call_count, 0)
            now[0] = midnight + 1
            result.refresh_once()
            result.history_thread.join(1)
            self.assertEqual(source.calls, 1)
            self.assertEqual(history.call_count, 1)
            result.refresh_once()
            self.assertEqual(source.calls, 1)
            self.assertEqual(history.call_count, 1)

    def test_adapt_view_maps_real_engine_fields_to_browser_contract(self):
        chain, okx, ledger = fixture()
        raw = build_combined(chain, okx, ledger, now_ms=END)
        result = adapt_view(raw, okx, now_ms=END)
        self.assertEqual(result['totals'], {'btc': '1.1', 'usd': '143', 'cny': '1001'})
        self.assertEqual(result['quotes'], {'btc_usd': '130', 'usd_cny': '7'})
        self.assertEqual(result['pnl']['week']['usd'], '33')
        self.assertEqual(result['pnl']['week']['cny'], '231')
        self.assertEqual(result['sources'][0]['btc'], '1')
        self.assertEqual(result['sources'][1]['btc'], '0.1')
        self.assertEqual(result['history'][-1]['btc'], '1.1')
        self.assertEqual(result['coverage']['start_date'], iso(END - 90 * DAY)[:10])
        self.assertFalse(result['stale'])

    def test_current_only_observation_when_ledger_missing_never_fake_flat_history(self):
        result, online, _, _ = service()
        result.ledger = result.ledger_connection = None
        self.assertTrue(result.refresh_once())
        view = result.read_public()
        self.assertEqual(view['totals']['btc'], '1.1')
        self.assertEqual(len(view['history']), 1)
        self.assertFalse(view['coverage']['complete'])
        self.assertTrue(all(row['usd'] is None for row in view['pnl'].values()))
        self.assertEqual(online.calls, [])

    def test_unconfigured_initial_state_is_unknown_not_zero_and_no_fetch(self):
        result, online, offline, _ = service()
        online.value.update(configured=False, last_success_at=None)
        self.assertFalse(result.refresh_once())
        view = result.read_public()
        self.assertFalse(view['ok'])
        self.assertIsNone(view['totals']['btc'])
        self.assertIsNone(view['totals']['usd'])
        self.assertEqual(view['history'], [])
        self.assertEqual(offline.calls, 0)
        self.assertEqual(online.calls, [])

    def test_live_new_balance_does_not_replace_older_verified_anchor_history(self):
        result, online, _, _ = service()
        historical_end = END - 30000
        result.ledger['coverage_end_ms'] = historical_end
        # read_btc_history closing_balances are already as-of coverage_end.
        result.ledger['anchor_observed_at_ms'] = END - 20000
        result.ledger['closing_balances'] = {'trading': '.1', 'funding': '0'}
        online.value['summary']['btc_holdings_total'] = '.9'
        self.assertTrue(result.refresh_once())
        view = result.read_public()
        self.assertEqual(view['totals']['btc'], '1.9')
        self.assertTrue(view['coverage']['complete'])
        self.assertEqual(view['history'][-1]['btc'], '1.1')
        self.assertEqual(dt.datetime.fromisoformat(view['history'][-1]['timestamp']).timestamp() * 1000, historical_end)
        self.assertEqual(dt.datetime.fromisoformat(view['pnl']['week']['end_at']).timestamp() * 1000, historical_end)

    def test_account_switch_immediately_hides_cached_previous_account(self):
        result, online, _, _ = service()
        result.refresh_once()
        self.assertEqual(result.read_public()['totals']['btc'], '1.1')
        online.value.update(connection_id='synthetic-account-B', last_success_at=None, status='connecting')
        view = result.read_public()
        self.assertFalse(view['ok'])
        self.assertIsNone(view['totals']['btc'])
        self.assertEqual(view['history'], [])

    def test_account_switch_discards_old_history_on_next_refresh(self):
        result, online, _, _ = service()
        result.refresh_once()
        online.value.update(connection_id='synthetic-account-B', last_success_at=None, status='connecting')
        self.assertFalse(result.refresh_once())
        self.assertIsNone(result.ledger)
        self.assertIsNone(result.ledger_connection)
        self.assertIsNone(result.read_public()['totals']['btc'])

    def test_read_public_isolated_deepcopy_and_zero_provider_requests(self):
        result, online, offline, _ = service()
        result.refresh_once()
        calls = offline.calls
        first = result.read_public()
        first['totals']['btc'] = '999'
        first['history'].clear()
        for _ in range(20):
            view = result.read_public()
            self.assertEqual(view['totals']['btc'], '1.1')
            self.assertGreater(len(view['history']), 1)
        self.assertEqual(offline.calls, calls)
        self.assertEqual(online.calls, [])

    def test_age_of_each_source_is_checked_on_reads_not_only_background_loop(self):
        result, _, _, now = service()
        result.refresh_once()
        now[0] += 91
        view = result.read_public()
        self.assertTrue(view['stale'])
        self.assertEqual(view['sources'][1]['status'], 'stale')
        self.assertEqual(view['sources'][0]['status'], 'fresh')
        self.assertEqual(view['totals']['btc'], '1.1')
        now[0] += 600
        self.assertEqual(result.read_public()['sources'][0]['status'], 'stale')

    def test_offline_refresh_error_keeps_verified_total_and_marks_stale(self):
        result, _, offline, now = service()
        result.refresh_once()
        offline.failure = RuntimeError('synthetic upstream failure')
        now[0] += 301
        result.refresh_once()
        view = result.read_public()
        self.assertEqual(view['totals']['btc'], '1.1')
        self.assertTrue(view['stale'])
        self.assertEqual(view['sources'][0]['status'], 'stale')

    def test_background_history_after_account_change_cannot_republish_old_account(self):
        result, online, _, _ = service()
        old = result.connection
        online.started, online.release = threading.Event(), threading.Event()
        worker = threading.Thread(target=result._history_task, args=(online.credentials, old))
        worker.start()
        try:
            self.assertTrue(online.started.wait(1))
            with result.lock:
                result.connection, result.ledger, result.ledger_connection = 'synthetic-account-B', None, None
            online.release.set()
            worker.join(1)
            self.assertFalse(worker.is_alive())
            self.assertIsNone(result.ledger)
            self.assertEqual(online.vault.data, {})
        finally:
            online.release.set()
            worker.join(1)

    def test_history_failure_preserves_prior_verified_ledger(self):
        result, online, _, _ = service()
        old = copy.deepcopy(result.ledger)
        online.failure = RuntimeError('https://provider.invalid/DO-NOT-ECHO')
        result._history_task(online.credentials, result.connection)
        self.assertEqual(result.ledger, old)
        self.assertIn('暂未完整读取', result.ledger_error)
        self.assertNotIn('DO-NOT-ECHO', result.ledger_error)

    def test_history_request_covers_full_ninety_days_of_shared_snapshot(self):
        result, online, source, now = service()
        # Reproduce the real acceptance gap: address finished 45 ms before
        # the background ledger query began. It must not lose the whole 90D P&L.
        address_end = END - 45
        source.snapshot['fetchedAt'] = iso(address_end)
        source.snapshot['quote'] = {'time': (END - 1000) // 1000, 'USD': 130}
        original_factory = online.client_factory

        def factory(credentials):
            client = original_factory(credentials)
            original_read = client.read_btc_history

            def read(start, end):
                ledger = original_read(start, end)
                ledger.update(coverage_start_ms=start, coverage_end_ms=end,
                              anchor_observed_at_ms=END,
                              closing_balances={'trading': '.1', 'funding': '0'})
                return ledger
            client.read_btc_history = read
            return client
        online.client_factory = factory
        result._history_task(online.credentials, result.connection)
        self.assertEqual(online.calls[-1], (address_end - 90 * DAY, address_end))
        self.assertTrue(result.refresh_once())
        view = result.read_public()
        self.assertTrue(view['coverage']['complete'])
        self.assertEqual(view['pnl']['days90']['usd'], '33')
        self.assertEqual(view['pnl']['days90']['cny'], '231')
        self.assertEqual(view['pnl']['days90']['reason'], '')
        self.assertEqual(dt.datetime.fromisoformat(view['pnl']['days90']['end_at']).timestamp() * 1000, address_end)

    def test_history_query_never_uses_future_address_snapshot_as_anchor(self):
        result, online, source, _ = service()
        source.snapshot['fetchedAt'] = iso(END + 1000)
        result._history_task(online.credentials, result.connection)
        self.assertEqual(online.calls[-1], (END - 90 * DAY, END))

    def test_btc_cash_inventory_does_not_add_unrealized_derivative_pnl(self):
        account = account_fixture()
        account['trading']['assets'][0].update(cash_balance='.2', liabilities='.03', equity='9.99')
        account['funding']['assets'][0]['balance'] = '.02'
        view = asset_view(account)
        self.assertEqual(view['summary']['btc_holdings_total'], '0.19')
        self.assertEqual(view['summary']['btc_total'], '10.01')

    def test_missing_cash_or_liabilities_not_invented_zero(self):
        for field in ('cash_balance', 'liabilities'):
            account = account_fixture()
            account['trading']['assets'][0].pop(field)
            if field == 'liabilities':
                # Reader guarantees liabilities; malformed direct input must not silently pass.
                with self.assertRaises(KeyError):
                    asset_view(account)
            else:
                self.assertIsNone(asset_view(account)['summary']['btc_holdings_total'])

    def test_fiat_contract_preserves_null_and_expands_exponents_without_rounding(self):
        self.assertIsNone(fiat_text(None))
        self.assertEqual(fiat_text(0), '0')
        self.assertEqual(fiat_text(-0.0), '0')
        self.assertEqual(fiat_text(1e-8), '0.00000001')
        self.assertEqual(fiat_text(1.23456789123456), '1.23456789123456')
        self.assertEqual(fiat_text(Decimal('1234.50000000000000000001')), '1234.50000000000000000001')
        for bad in (True, float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                fiat_text(bad)

    def test_real_engine_json_is_accepted_by_actual_wallet_js_money_and_chart(self):
        chain, online, ledger = fixture()
        view = adapt_view(build_combined(chain, online, ledger, END), online, now_ms=END)
        amounts = list(view['totals'].values()) + list(view['quotes'].values())
        amounts += [row[key] for row in view['history'] for key in ('usd', 'cny')]
        amounts += [row[key] for row in view['pnl'].values() for key in ('usd', 'cny')]
        self.assertTrue(all(value is None or isinstance(value, str) for value in amounts))
        node = shutil.which('node')
        self.assertIsNotNone(node, 'Node is needed for the service-to-browser contract check.')
        script = """
const assert=require('node:assert/strict');
const api=require('./terminal/dist/combined-wallet.js');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{const view=JSON.parse(input);
assert.equal(api.money(view.totals.usd,'usd'),'$143.00');
assert.equal(api.money(view.totals.cny,'cny'),'¥1,001.00');
assert.equal(api.money(view.pnl.week.usd,'usd',true),'+$33.00');
assert.equal(api.money(view.pnl.week.cny,'cny',true),'+¥231.00');
const end=Date.parse(view.updated_at);
assert.ok(api.geometry(view.history,'usd','all',end));
assert.ok(api.geometry(view.history,'cny','all',end));
assert.ok(api.geometry(view.history,'btc','all',end));
assert.ok(api.decimal(view.quotes.btc_usd));assert.ok(api.decimal(view.quotes.usd_cny));
});
"""
        process = subprocess.run([node, '-e', script], input=json.dumps(view), encoding='utf-8',
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 cwd=Path(__file__).resolve().parent, timeout=10)
        self.assertEqual(process.returncode, 0, process.stderr)


class CombinedHTTPTests(unittest.TestCase):
    def setUp(self):
        self.service, self.online, self.offline, self.now = service()
        self.service.refresh_once()

        class Monitor:
            def read(self):
                return {'settings': {'threshold_pct': 2.5}}
        self.server = TerminalServer(('127.0.0.1', 0), Monitor(), None, combined_service=self.service)
        self.host = '127.0.0.1:%s' % self.server.server_port
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.stopping.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(1)
        self.service.stop()

    def call(self, path='/api/wallet/combined', headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=2)
        request_headers = {'Host': self.host}
        request_headers.update(headers or {})
        try:
            connection.request('GET', path, headers=request_headers)
            response = connection.getresponse()
            payload = response.read()
            try:
                body = json.loads(payload)
            except ValueError:
                body = payload.decode('utf-8', errors='replace')
            return response.status, response.headers, body
        finally:
            connection.close()

    def test_endpoint_cached_no_network_security_headers_no_private_contents(self):
        before = self.offline.calls
        for _ in range(5):
            status, headers, view = self.call()
            self.assertEqual(status, 200)
            self.assertEqual(view['totals']['btc'], '1.1')
            self.assertEqual(headers['Cache-Control'], 'no-store')
            self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
            self.assertIsNone(headers.get('Access-Control-Allow-Origin'))
            self.assertNotIn('synthetic-never-exposed', json.dumps(view))
            self.assertNotIn('credentials', json.dumps(view))
        self.assertEqual(self.offline.calls, before)
        self.assertEqual(self.online.calls, [])

    def test_foreign_origin_and_host_denied(self):
        for headers in ({'Origin': 'https://evil.invalid'}, {'Origin': 'null'},
                        {'Host': 'evil.invalid'}, {'Host': '127.0.0.1:1'}):
            with self.subTest(headers=headers):
                self.assertEqual(self.call(headers=headers)[0], 403)

    def test_query_parameters_cannot_select_accounts_or_trigger_provider_fetch(self):
        for path in ('?refresh=1', '?api_key=synthetic', '?address=other', '?url=https://evil.invalid'):
            self.assertEqual(self.call('/api/wallet/combined' + path)[0], 400)
        self.assertEqual(self.online.calls, [])

    def test_data_code_and_encrypted_files_are_not_static_routes(self):
        for path in ('/terminal/data/okx-wallet/btc-ledger.protected.json', '/combined_wallet_engine.py',
                     '/terminal/data/bitcoin-balance-snapshot.json', '/combined_wallet_service.py',
                     '/data/okx-wallet/credentials.protected.json'):
            with self.subTest(path=path):
                status, _, view = self.call(path)
                self.assertEqual(status, 404)
                self.assertNotIn('ciphertext', json.dumps(view))

    def test_missing_provider_explicitly_unavailable(self):
        self.server.combined_service = None
        status, _, view = self.call()
        self.assertEqual(status, 503)
        self.assertIn('尚未启动', view['error'])


class AddressProviderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        directory = Path(self.temporary.name) / 'terminal' / 'data'
        directory.mkdir(parents=True)
        self.chain, _, _ = fixture()
        (directory / 'bitcoin-balance-snapshot.json').write_text(json.dumps(self.chain), encoding='utf-8')
        (directory / 'bitcoin-cny-rates.json').write_text(json.dumps(self.chain['fx']), encoding='utf-8')
        self.patch_root = patch('combined_wallet_service.ROOT', Path(self.temporary.name))
        self.patch_root.start()
        parent = self

        class Proxy:
            address = parent.chain['address']

            def __init__(self):
                self.values = {
                    'address': parent.chain['summary'],
                    'transactions': [{'txid': format(1, '064x'), 'status': {'confirmed': True,
                        'block_time': (END - 100 * DAY) // 1000, 'block_height': 1},
                        'vin': [], 'vout': [{'scriptpubkey_address': self.address, 'value': 10**8}], 'fee': 10}],
                    'history': {'prices': parent.chain['prices']},
                    'quote': parent.chain['quote'],
                    'fx': [dict(row, base='USD', quote='CNY') for row in parent.chain['fx']['rates']]}
                self.failure = None
                self.calls = []

            def read(self, query):
                resource = query['resource'][0]
                self.calls.append(copy.deepcopy(query))
                if resource == self.failure:
                    raise RuntimeError('synthetic_failure')
                return json.dumps(self.values[resource])
        self.proxy = Proxy()
        self.source = AddressSnapshots(self.proxy, clock=lambda: END / 1000)

    def tearDown(self):
        self.patch_root.stop()
        self.temporary.cleanup()

    def test_complete_fixed_proxy_snapshots_are_normalized_and_reconciled(self):
        result = self.source.refresh()
        self.assertEqual(result['transactions'][0]['delta'], 10**8)
        self.assertEqual(result['address'], self.proxy.address)
        self.assertEqual({row['resource'][0] for row in self.proxy.calls}, {'address', 'transactions', 'history', 'quote', 'fx'})

    def test_upstream_historical_prices_are_sorted_like_existing_wallet(self):
        self.proxy.values['history']['prices'] = list(reversed(self.chain['prices']))
        result = self.source.refresh()
        self.assertEqual([row['time'] for row in result['prices']], sorted(row['time'] for row in self.chain['prices']))

    def test_empty_address_history_can_refresh(self):
        self.source.snapshot['transactions'] = []
        self.proxy.values['transactions'] = []
        self.proxy.values['address']['chain_stats'] = {'tx_count': 0, 'funded_txo_sum': 0, 'spent_txo_sum': 0}
        result = self.source.refresh()
        self.assertEqual(result['transactions'], [])

    def test_failed_public_provider_preserves_verified_snapshot(self):
        before = copy.deepcopy(self.source.snapshot)
        self.proxy.failure = 'quote'
        with self.assertRaises(RuntimeError):
            self.source.refresh()
        self.assertEqual(self.source.snapshot, before)

    def test_fx_failure_keeps_existing_reference_rates_without_faking_zero(self):
        self.proxy.failure = 'fx'
        result = self.source.refresh()
        self.assertEqual(result['fx']['rates'], self.chain['fx']['rates'])

    def test_missing_confirmed_pages_fail_full_address_reconciliation(self):
        self.proxy.values['transactions'] = []
        before = copy.deepcopy(self.source.snapshot)
        with self.assertRaises(ValueError):
            self.source.refresh()
        self.assertEqual(self.source.snapshot, before)


if __name__ == '__main__':
    unittest.main()
