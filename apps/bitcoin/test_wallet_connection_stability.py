"""Offline connection recovery tests; synthetic credentials only."""
import copy
from decimal import Decimal
import json
import socket
import threading
import unittest
import urllib.error
from unittest.mock import patch

import okx_account_reader as reader
import test_okx_account_reader as fixture_reader
import test_okx_wallet_service as fixture_wallet
import test_crypto_portfolio_service as fixture_portfolio
from okx_wallet_service import WalletError, asset_view
from binance_wallet import BinanceWalletError


class SharedReadTests(unittest.TestCase):
    def data(self):
        return fixture_reader.responses(trading=[{'totalEq': '99.8', 'details': [
            {'ccy': 'USDT', 'cashBal': '100', 'liab': '0', 'eq': '100', 'eqUsd': '99.8'}]}], funding=[])

    def client(self, items, **kwargs):
        return fixture_reader.client(items, sleeper=lambda unused: None, **kwargs)

    def test_shared_snapshot_reads_one_inventory_and_values_exact_same_cash(self):
        client, opener = self.client(self.data())
        result = client.read_wallet_snapshot()
        self.assertEqual(4, len(opener.calls))
        self.assertEqual('100', result['valuation']['assets'][0]['quantity'])
        self.assertEqual(Decimal('99.8'), Decimal(result['valuation']['assets'][0]['usd_value']))
        self.assertEqual(result['account']['observed_at'], result['valuation']['observed_at'])

    def test_transient_network_failure_retries_only_failed_get(self):
        items = self.data()
        items.insert(2, urllib.error.URLError('synthetic-private-error'))
        client, opener = self.client(items)
        result = client.read_wallet_snapshot()
        self.assertTrue(result['valuation']['complete'])
        self.assertEqual(5, len(opener.calls))
        self.assertEqual([reader.TIME_PATH, reader.CONFIG_PATH, reader.TRADING_PATH, reader.TRADING_PATH, reader.FUNDING_PATH],
                         [call[0].full_url[len(reader.ORIGIN):] for call in opener.calls])

    def test_transient_server_failure_retries_once(self):
        client, opener = self.client([fixture_reader.Response(b'', status=503)] + self.data())
        self.assertTrue(client.read_wallet_snapshot()['valuation']['complete'])
        self.assertEqual(5, len(opener.calls))

    def test_repeated_transport_failure_is_bounded_and_redacted(self):
        client, opener = self.client([socket.timeout('synthetic-secret'), socket.timeout('synthetic-secret')])
        with self.assertRaises(reader.OKXReadError) as caught:
            client.read_wallet_snapshot()
        self.assertEqual('timeout', caught.exception.code)
        self.assertNotIn('synthetic-secret', str(caught.exception))
        self.assertEqual(2, len(opener.calls))

    def test_no_retry_when_whole_operation_budget_exhausted(self):
        clock = [100.0]
        client, opener = self.client([socket.timeout()], monotonic=lambda: clock[0])
        original = opener.open
        def slow(*args, **kwargs):
            clock[0] = 127.5
            return original(*args, **kwargs)
        opener.open = slow
        with self.assertRaises(reader.OKXReadError):
            client.read_wallet_snapshot()
        self.assertEqual(1, len(opener.calls))

    def test_rate_limits_auth_and_redirects_are_not_retried(self):
        for response, expected in [(fixture_reader.Response(b'', status=429), 'rate_limited'),
                                   (fixture_reader.Response(b'', status=400), 'http_error'),
                                   (fixture_reader.Response(b'', status=302), 'redirect_rejected')]:
            client, opener = self.client([response])
            with self.assertRaises(reader.OKXReadError) as caught:
                client.read_wallet_snapshot()
            self.assertEqual(expected, caught.exception.code)
            self.assertEqual(1, len(opener.calls))

    def test_invalid_json_is_not_retried(self):
        client, opener = self.client([b'not-json'])
        with self.assertRaises(reader.OKXReadError) as caught:
            client.read_wallet_snapshot()
        self.assertEqual('invalid_response', caught.exception.code)
        self.assertEqual(1, len(opener.calls))

    def test_optional_quotes_failure_keeps_inventory_and_unknown_prices(self):
        client, opener = self.client(fixture_reader.responses() + [urllib.error.URLError('secret')] * 2)
        result = client.read_wallet_snapshot()
        self.assertEqual(6, len(opener.calls))
        self.assertFalse(result['valuation']['complete'])
        self.assertEqual('network_error', result['valuation']['price_error']['code'])
        self.assertEqual(3, len(result['valuation']['assets']))

    def test_unverified_permissions_do_not_publish_portfolio_valuation(self):
        client, opener = self.client(fixture_reader.responses(config=[{}]))
        with self.assertRaises(reader.OKXReadError) as caught:
            client.read_wallet_snapshot()
        self.assertEqual('permissions_unverified', caught.exception.code)
        self.assertEqual(4, len(opener.calls))


class WalletRecoveryTests(unittest.TestCase):
    def test_all_asset_rows_have_usd_field_but_backend_does_not_drop_dust(self):
        view = asset_view(fixture_wallet.snapshot())
        self.assertEqual(2, len(view['assets']))
        self.assertTrue(all('usd_value' in row for row in view['assets']))
        btc = next(row for row in view['assets'] if row['ccy'] == 'BTC')
        expected = next(row for row in view['cash_valuation']['assets'] if row['ccy'] == 'BTC')
        self.assertEqual(expected['usd_value'], btc['usd_value'])

    def test_service_uses_shared_method_instead_of_reading_account_twice(self):
        wallet, _, factory, _ = fixture_wallet.service()
        account = fixture_wallet.snapshot()
        valuation = asset_view(account)['cash_valuation']
        class Client:
            def read_wallet_snapshot(self):
                return {'account': account, 'valuation': valuation}
            def read_account(self):
                raise AssertionError('duplicate account read')
        wallet.client_factory = lambda unused: Client()
        self.assertTrue(wallet.refresh_once())
        self.assertEqual(valuation, wallet.read_public()['cash_valuation'])
        self.assertEqual([], factory.calls)

    def test_transient_failures_back_off_and_success_resets_failure_count(self):
        wallet, _, factory, clock = fixture_wallet.service()
        wallet.refresh_once()
        factory.failure = reader.OKXReadError('network_error', 'transient')
        clock[0] += 30
        wallet.refresh_once()
        clock[0] += 30
        wallet.refresh_once()
        self.assertEqual(2, wallet.read_public()['consecutive_failures'])
        self.assertEqual(60, wallet.read_public()['retry_in_seconds'])
        before = len(factory.calls)
        clock[0] += 30
        self.assertFalse(wallet.refresh_once())
        self.assertEqual(before, len(factory.calls))
        factory.failure = None
        clock[0] += 30
        self.assertTrue(wallet.refresh_once())
        self.assertEqual('connected', wallet.read_public()['status'])
        self.assertEqual(0, wallet.read_public()['consecutive_failures'])

    def test_auth_error_waits_for_reconfiguration_or_bounded_retry(self):
        wallet, _, factory, clock = fixture_wallet.service()
        factory.failure = reader.OKXReadError('credentials_invalid', 'invalid', 400)
        wallet.refresh_once()
        clock[0] += 30
        self.assertFalse(wallet.refresh_once())
        self.assertEqual(1, len(factory.calls))
        wallet.configure({'passphrase': 'new-synthetic-passphrase'})
        factory.failure = None
        self.assertTrue(wallet.refresh_once())

    def test_history_storage_failure_does_not_erase_live_connection(self):
        wallet, vault, _, _ = fixture_wallet.service()
        with patch.object(vault, 'save_history', side_effect=WalletError('storage', 'safe', 503)):
            self.assertTrue(wallet.refresh_once())
        state = wallet.read_public()
        self.assertEqual('connected', state['status'])
        self.assertEqual('history_storage_unavailable', state['history_error'])
        self.assertTrue(state['assets'])

    def test_public_quote_outage_is_partial_valuation_not_account_disconnect(self):
        wallet, _, _, _ = fixture_wallet.service()
        client, unused = fixture_reader.client(fixture_reader.responses() + [urllib.error.URLError('secret')] * 2,
                                               sleeper=lambda unused: None)
        wallet.client_factory = lambda unused: client
        self.assertTrue(wallet.refresh_once())
        state = wallet.read_public()
        self.assertEqual('connected', state['status'])
        self.assertIsNotNone(state['summary']['btc_holdings_total'])
        self.assertFalse(state['cash_valuation']['complete'])
        self.assertIsNone(next(row['usd_value'] for row in state['assets'] if row['ccy'] == 'ETH'))

    def test_singleflight_blocks_duplicate_refresh_but_not_cached_reads(self):
        wallet, _, factory, _ = fixture_wallet.service()
        factory.started, factory.release = threading.Event(), threading.Event()
        worker = threading.Thread(target=wallet.refresh_once)
        worker.start()
        try:
            self.assertTrue(factory.started.wait(1))
            self.assertFalse(wallet.refresh_once())
            self.assertTrue(wallet.read_public()['refreshing'])
            self.assertEqual(1, len(factory.calls))
        finally:
            factory.release.set()
            worker.join(2)


class PortfolioRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture_portfolio.fixture()
        self.service = self.f.service

    def tearDown(self):
        for factory in [self.f.okx, self.f.factory]:
            if factory.release:
                factory.release.set()
        self.service.stop()

    def shared(self):
        self.f.okx.public = {'cash_valuation': copy.deepcopy(self.f.okx.data),
                            'summary': {'btc_holdings_total': '0.001'},
                            'last_success_at': fixture_portfolio.stamp(), 'status': 'connected'}

    def test_shared_okx_snapshot_has_no_additional_private_reads(self):
        self.shared()
        self.assertTrue(self.service.refresh_once())
        self.assertEqual([], self.f.okx.calls)
        self.assertTrue(self.service.read_public()['complete'])
        self.f.clock.now += 61
        self.f.okx.public['last_success_at'] = fixture_portfolio.stamp(self.f.clock.now)
        self.service.refresh_once()
        self.assertEqual([], self.f.okx.calls)

    def test_initial_shared_connection_does_not_trigger_duplicate_private_read(self):
        self.f.okx.public = {'cash_valuation': None, 'status': 'connecting'}
        self.service.refresh_once()
        self.assertEqual([], self.f.okx.calls)
        self.assertFalse(self.service.read_public()['complete'])

    def test_slow_binance_read_cannot_mix_new_btc_with_old_other_okx_coins(self):
        self.shared()
        original_factory = self.service.binance_factory
        def factory(*args):
            client = original_factory(*args)
            fetch = client.fetch_balances
            def advancing():
                result = fetch()
                self.f.okx.public['cash_valuation']['assets'][1]['quantity'] = '0.02'
                self.f.okx.public['cash_valuation']['assets'][1]['usd_value'] = '60'
                self.f.okx.public['summary']['btc_holdings_total'] = '0.002'
                return result
            client.fetch_balances = advancing
            return client
        self.service.binance_factory = factory
        self.service.refresh_once()
        state = self.service.read_public()
        self.assertEqual('60', next(row['usd_value'] for row in state['assets'] if row['ccy'] == 'ETH'))
        self.assertEqual(Decimal('0.012'), Decimal(next(row['quantity'] for row in state['assets'] if row['ccy'] == 'BTC')))

    def test_shared_failure_keeps_assets_stale_and_recovers_automatically(self):
        self.shared()
        self.service.refresh_once()
        before = self.service.read_public()
        self.f.okx.public.update(status='stale', error_code='timeout')
        self.service.refresh_once()
        failed = self.service.read_public()
        self.assertEqual(before['assets'], failed['assets'])
        self.assertFalse(failed['complete'])
        self.assertEqual('stale', next(row['status'] for row in failed['sources'] if row['id'] == 'okx'))
        self.f.okx.public.update(status='connected', error_code=None)
        self.service.refresh_once()
        self.assertTrue(self.service.read_public()['complete'])

    def test_partial_valuation_is_not_reported_as_connection_failure(self):
        self.shared()
        self.f.okx.public['cash_valuation']['complete'] = False
        self.f.okx.public['cash_valuation']['assets'].append({'ccy': 'DOGE', 'quantity': '1', 'usd_value': None})
        self.service.refresh_once()
        state = self.service.read_public()
        source = next(row for row in state['sources'] if row['id'] == 'okx')
        self.assertEqual('partial', source['status'])
        self.assertFalse(source['valuation_complete'])
        self.assertFalse(state['complete'])
        self.assertFalse(state['stale'])
        self.assertEqual(['DOGE'], state['unpriced_currencies'])

    def test_aging_binance_snapshot_is_stale_even_if_portfolio_heartbeat_runs(self):
        self.service.refresh_once()
        self.f.clock.now += 121
        # Simulate an in-flight or backoff-held upstream refresh, while the
        # portfolio heartbeat still assembles the unchanged balances.
        self.service.binance_retry_at = self.f.clock.now + 300
        self.service.refresh_once()
        state = self.service.read_public()
        self.assertEqual('stale', state['binance']['status'])
        self.assertEqual('stale', next(row['status'] for row in state['sources'] if row['id'] == 'binance'))
        self.assertFalse(state['complete'])

    def test_binance_retry_backoff_preserves_last_success_time_and_resets_on_recovery(self):
        self.service.refresh_once()
        success = self.service.binance_success_at
        self.f.factory.failure = BinanceWalletError('rate_limited', 429)
        self.f.clock.now += 61
        self.service.refresh_once()
        self.assertEqual(success, self.service.binance_success_at)
        self.f.clock.now += 60
        self.service.refresh_once()
        self.assertEqual(2, self.service.binance_failures)
        self.assertEqual(120, self.service.binance_status()['retry_in_seconds'])
        before = len(self.f.factory.calls)
        self.f.clock.now += 60
        self.service.refresh_once()
        self.assertEqual(before, len(self.f.factory.calls))
        self.f.factory.failure = None
        self.f.clock.now += 60
        self.service.refresh_once()
        self.assertEqual('connected', self.service.binance_status()['status'])
        self.assertEqual(0, self.service.binance_failures)

    def test_portfolio_refresh_singleflight_prevents_overlapping_exchange_reads(self):
        self.f.factory.started, self.f.factory.release = threading.Event(), threading.Event()
        worker = threading.Thread(target=self.service.refresh_once)
        worker.start()
        try:
            self.assertTrue(self.f.factory.started.wait(1))
            self.assertFalse(self.service.refresh_once())
            self.assertEqual(1, len(self.f.factory.calls))
            self.assertIsNone(self.service.read_public()['total_usd'])
        finally:
            self.f.factory.release.set()
            worker.join(2)
        self.assertFalse(worker.is_alive())


if __name__ == '__main__':
    unittest.main()
