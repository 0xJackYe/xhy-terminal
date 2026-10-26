"""Offline OKX wallet integration tests; never open a user's credential vault."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

from okx_account_reader import OKXReadError
from okx_wallet_service import (OKXVault, OKXWalletService, WalletError,
                                asset_view, identity, validate_credentials)


CREDS = {'api_key': 'offline-wallet-key', 'secret_key': 'offline-wallet-secret',
         'passphrase': 'offline-wallet-passphrase'}


def snapshot(btc='0.1234567890123456789012345', funding='0.02', total='10000.12'):
    return {'exchange': 'OKX', 'observed_at': '2026-10-24T00:00:00.000Z',
            'permissions': {'verified': True, 'read_only': True},
            'trading': {'total_equity_usd': total, 'assets': [
                {'currency': 'BTC', 'equity': btc, 'cash_balance': '0.2',
                 'available': '0.1', 'liabilities': '0.03', 'unrealized_pnl': '-0.01',
                 'equity_usd': '9000'},
                {'currency': 'USDT', 'equity': '-5', 'cash_balance': '-3',
                 'available': '-5', 'liabilities': '5', 'unrealized_pnl': '-2',
                 'equity_usd': '-5'}]},
            'funding': {'assets': [{'currency': 'BTC', 'balance': funding,
                                   'available': funding, 'frozen': '0'}]}}


class MemoryVault:
    def __init__(self, credentials=None):
        self.credentials = copy.deepcopy(credentials or {})
        self.histories = {}
        self.saves = []

    def read(self):
        return copy.deepcopy(self.credentials)

    def save(self, credentials):
        self.saves.append(copy.deepcopy(credentials))
        self.credentials = copy.deepcopy(credentials)

    def history(self, account_identity):
        return copy.deepcopy(self.histories.get(account_identity, []))

    def save_history(self, account_identity, points):
        self.histories[account_identity] = copy.deepcopy(points)


class FakeFactory:
    def __init__(self, value=None):
        self.value = value or snapshot()
        self.failure = None
        self.calls = []
        self.started = None
        self.release = None

    def __call__(self, credentials):
        self.calls.append(copy.deepcopy(credentials))
        parent = self

        class Client:
            def read_account(self):
                if parent.started is not None:
                    parent.started.set()
                if parent.release is not None:
                    if not parent.release.wait(2):
                        raise RuntimeError('fixture wait timeout')
                if parent.failure is not None:
                    raise parent.failure
                return copy.deepcopy(parent.value)
        return Client()


def service(credentials=None, value=None):
    vault = MemoryVault(CREDS if credentials is None else credentials)
    factory = FakeFactory(value)
    now = [1792800000.0]
    result = OKXWalletService(vault=vault, client_factory=factory, clock=lambda: now[0])
    return result, vault, factory, now


class OKXAssetViewTests(unittest.TestCase):
    def test_equity_and_funding_sum_btc_without_cash_or_debt_double_count(self):
        view = asset_view(snapshot())
        self.assertEqual(view['summary']['btc_total'], '0.1434567890123456789012345')
        self.assertEqual(view['summary']['trading_usd'], '10000.12')
        self.assertIsNone(view['summary']['funding_usd'])
        self.assertIsNone(view['summary']['total_usd'])
        self.assertFalse(view['summary']['valuation_complete'])
        btc = next(row for row in view['assets'] if row['ccy'] == 'BTC')
        self.assertEqual(btc['trading_equity'], '0.1234567890123456789012345')
        self.assertEqual(btc['debt'], '0.03')

    def test_high_precision_btc_addition_is_exact(self):
        view = asset_view(snapshot('0.123456789012345678901234567890123456', '0.000000000000000000000000000000000001'))
        self.assertEqual(view['summary']['btc_total'], '0.123456789012345678901234567890123457')

    def test_negative_net_equity_not_clipped_or_debt_subtracted_twice(self):
        view = asset_view(snapshot('-0.15', '0.02', '-100'))
        self.assertEqual(view['summary']['btc_total'], '-0.13')
        self.assertEqual(view['summary']['trading_usd'], '-100')

    def test_missing_btc_equity_remains_unknown(self):
        self.assertIsNone(asset_view(snapshot(None))['summary']['btc_total'])

    def test_zero_and_empty_funding_allow_official_trading_valuation_only(self):
        for funding in [[{'currency': 'BTC', 'balance': '0', 'available': '0'}], []]:
            account = snapshot()
            account['funding']['assets'] = funding
            view = asset_view(account)
            self.assertEqual(view['summary']['total_usd'], '10000.12')
            self.assertEqual(view['summary']['funding_usd'], '0')
            self.assertTrue(view['summary']['valuation_complete'])

    def test_nonzero_usdt_funding_does_not_assume_dollar_peg(self):
        account = snapshot()
        account['funding']['assets'] = [{'currency': 'USDT', 'balance': '100', 'available': '100'}]
        self.assertIsNone(asset_view(account)['summary']['total_usd'])

    def test_funding_only_currency_and_absent_btc_are_supported(self):
        account = snapshot()
        account['trading']['assets'] = []
        account['funding']['assets'] = [{'currency': 'ETH', 'balance': '3', 'available': '2'}]
        view = asset_view(account)
        self.assertEqual(view['summary']['btc_total'], '0')
        self.assertEqual(view['assets'][0]['trading_equity'], '0')
        self.assertEqual(view['assets'][0]['funding_balance'], '3')
        self.assertIn('不含赚币及子账户', view['summary']['scope_label'])


class OKXWalletServiceTests(unittest.TestCase):
    def test_unconfigured_and_partial_credentials_do_not_call_exchange(self):
        for credentials in [{}, {'api_key': 'partial-key', 'secret_key': 'partial-secret'}]:
            wallet, _, factory, _ = service(credentials)
            self.assertFalse(wallet.refresh_once())
            view = wallet.read_public()
            self.assertEqual(view['status'], 'needs_credentials')
            self.assertFalse(view['configured'])
            self.assertEqual(view['pending_credentials'], bool(credentials))
            self.assertEqual(factory.calls, [])
            encoded = json.dumps(view)
            self.assertNotIn('partial-key', encoded)
            self.assertNotIn('partial-secret', encoded)

    def test_partial_saved_credentials_can_be_completed_without_resending_key(self):
        wallet, vault, _, _ = service({'api_key': CREDS['api_key'], 'secret_key': CREDS['secret_key']})
        result = wallet.configure({'passphrase': CREDS['passphrase']})
        self.assertTrue(result['configured'])
        self.assertEqual(result['status'], 'connecting')
        self.assertEqual(vault.credentials, CREDS)
        self.assertTrue(wallet.wake.is_set())
        for value in CREDS.values():
            self.assertNotIn(value, json.dumps(result))

    def test_invalid_configuration_never_persists_or_changes_generation(self):
        wallet, vault, _, _ = service()
        for update in [{}, {'passphrase': ''}, {'api_key': 'line\nbreak'}, {'unknown': 'value'}, []]:
            with self.assertRaises(WalletError):
                wallet.configure(update)
        self.assertEqual(vault.saves, [])
        self.assertEqual(wallet.generation, 0)

    def test_incomplete_configuration_keeps_prior_credentials(self):
        wallet, vault, _, _ = service({})
        with self.assertRaises(WalletError):
            wallet.configure({'api_key': 'only-one-field'})
        self.assertEqual(vault.credentials, {})

    def test_success_is_cached_sanitized_and_public_copy_is_independent(self):
        wallet, vault, factory, _ = service()
        self.assertTrue(wallet.refresh_once())
        first = wallet.read_public()
        self.assertEqual(first['status'], 'connected')
        self.assertEqual(len(first['history']), 1)
        self.assertEqual(factory.calls, [CREDS])
        first['assets'][0]['ccy'] = 'changed'
        first['history'][0]['btc_total'] = 'changed'
        second = wallet.read_public()
        self.assertNotEqual(second['assets'][0]['ccy'], 'changed')
        self.assertNotEqual(second['history'][0]['btc_total'], 'changed')
        self.assertEqual(len(vault.histories[identity(CREDS)]), 1)
        for secret in CREDS.values():
            self.assertNotIn(secret, json.dumps(second))

    def test_refresh_is_throttled_and_history_sampled_every_five_minutes(self):
        wallet, _, factory, now = service()
        self.assertTrue(wallet.refresh_once())
        for _ in range(10):
            wallet.request_refresh()
            self.assertFalse(wallet.refresh_once())
        self.assertEqual(len(factory.calls), 1)
        now[0] += 10
        self.assertTrue(wallet.refresh_once())
        self.assertEqual(len(wallet.read_public()['history']), 1)
        now[0] += 290
        self.assertTrue(wallet.refresh_once())
        self.assertEqual(len(wallet.read_public()['history']), 2)

    def test_provider_failure_keeps_last_success_visibly_stale(self):
        wallet, _, factory, now = service()
        wallet.refresh_once()
        before = wallet.read_public()
        now[0] += 30
        factory.failure = OKXReadError('rate_limited', '欧易请求达到频率限制，稍后自动重试。', 429)
        self.assertFalse(wallet.refresh_once())
        after = wallet.read_public()
        self.assertEqual(after['status'], 'stale')
        self.assertEqual(after['assets'], before['assets'])
        self.assertEqual(after['last_success_at'], before['last_success_at'])
        self.assertEqual(after['error_code'], 'rate_limited')
        now[0] += 30
        factory.failure = None
        self.assertTrue(wallet.refresh_once())
        self.assertEqual(wallet.read_public()['status'], 'connected')

    def test_stuck_or_stopped_refresh_cannot_display_old_snapshot_as_connected_forever(self):
        wallet, _, _, now = service()
        wallet.refresh_once()
        now[0] += 3600
        self.assertEqual(wallet.read_public()['status'], 'stale')

    def test_generic_exception_never_discloses_raw_secret(self):
        wallet, _, factory, _ = service()
        factory.failure = RuntimeError(CREDS['secret_key'])
        self.assertFalse(wallet.refresh_once())
        view = wallet.read_public()
        self.assertEqual(view['status'], 'error')
        self.assertEqual(view['error_code'], 'unavailable')
        self.assertNotIn(CREDS['secret_key'], json.dumps(view))

    def test_slow_network_does_not_block_reading_or_reconfiguration(self):
        wallet, _, factory, _ = service()
        factory.started, factory.release = threading.Event(), threading.Event()
        worker = threading.Thread(target=wallet.refresh_once)
        worker.start()
        try:
            self.assertTrue(factory.started.wait(1))
            start = time.monotonic()
            self.assertTrue(wallet.read_public()['refreshing'])
            wallet.configure({'api_key': 'new-offline-key', 'secret_key': 'new-offline-secret'})
            self.assertLess(time.monotonic() - start, .25)
            self.assertEqual(wallet.read_public()['status'], 'connecting')
        finally:
            factory.release.set()
            worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(wallet.read_public()['assets'], [])
        self.assertEqual(wallet.read_public()['history'], [])
        self.assertTrue(wallet.refresh_once())
        self.assertEqual(factory.calls[-1]['api_key'], 'new-offline-key')

    def test_old_generation_error_cannot_poison_new_configuration(self):
        wallet, _, factory, _ = service()
        factory.started, factory.release = threading.Event(), threading.Event()
        factory.failure = RuntimeError('old-generation-error')
        worker = threading.Thread(target=wallet.refresh_once)
        worker.start()
        try:
            self.assertTrue(factory.started.wait(1))
            wallet.configure({'api_key': 'new-key'})
        finally:
            factory.release.set()
            worker.join(2)
        self.assertIsNone(wallet.read_public()['error'])
        self.assertIsNone(wallet.read_public()['error_code'])

    def test_account_switch_does_not_show_old_account_history(self):
        wallet, vault, _, _ = service()
        wallet.refresh_once()
        self.assertEqual(len(wallet.read_public()['history']), 1)
        wallet.configure({'api_key': 'different-account'})
        self.assertEqual(wallet.read_public()['history'], [])
        self.assertEqual(wallet.read_public()['assets'], [])
        self.assertEqual(len(vault.histories[identity(CREDS)]), 1)

    def test_start_stop_are_idempotent_and_stop_discards_late_result(self):
        wallet, _, factory, _ = service()
        factory.started, factory.release = threading.Event(), threading.Event()
        wallet.start()
        wallet.start()
        try:
            self.assertTrue(factory.started.wait(1))
            thread = wallet.thread
            wallet.stop_event.set()
            factory.release.set()
            wallet.stop()
            wallet.stop()
            self.assertIs(wallet.thread, thread)
            self.assertFalse(thread.is_alive())
            self.assertEqual(wallet.read_public()['assets'], [])
        finally:
            factory.release.set()
            wallet.stop()


class OKXVaultTests(unittest.TestCase):
    # Reversible test-only stand-in makes encryption-path tests platform-neutral.
    # Production defaults to Windows DPAPI and never uses this cipher.
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        def crypt(raw):
            return bytes(value ^ 0xAD for value in raw)
        self.vault = OKXVault(Path(self.temp.name) / 'fixture-vault', seal=crypt, unseal=crypt)

    def tearDown(self):
        self.temp.cleanup()

    def test_only_ciphertext_written_and_round_trip_preserves_partial_credentials(self):
        partial = {'api_key': CREDS['api_key'], 'secret_key': CREDS['secret_key']}
        self.vault.save(partial)
        self.assertEqual(self.vault.read(), partial)
        files = list(self.vault.directory.iterdir())
        self.assertEqual([p.name for p in files], ['credentials.protected.json'])
        encoded = files[0].read_text('utf-8')
        for value in CREDS.values():
            self.assertNotIn(value, encoded)
        self.assertEqual(set(json.loads(encoded)), {'version', 'ciphertext'})

    def test_encrypted_history_is_account_scoped_and_bounded(self):
        points = [{'at_ms': 1792800000000 + i, 'timestamp': '2026-10-24T00:00:00Z',
                   'btc_total': '0.1234567890123456789', 'total_usd': None} for i in range(9000)]
        self.vault.save_history('identity-one', points)
        self.assertEqual(len(self.vault.history('identity-one')), 8640)
        self.assertEqual(self.vault.history('identity-two'), [])
        encoded = (self.vault.directory / 'history.protected.json').read_text('utf-8')
        self.assertNotIn('0.1234567890123456789', encoded)
        self.assertNotIn('identity-one', encoded)

    def test_failed_encryption_preserves_existing_ciphertext_and_removes_temporary(self):
        self.vault.save(CREDS)
        def broken(unused):
            raise RuntimeError(CREDS['secret_key'])
        self.vault.seal = broken
        with self.assertRaises(WalletError) as caught:
            self.vault.save(dict(CREDS, api_key='replacement'))
        self.assertNotIn(CREDS['secret_key'], str(caught.exception))
        self.assertEqual(self.vault.read(), CREDS)
        self.assertEqual(len(list(self.vault.directory.iterdir())), 1)

    def test_corrupt_or_undecryptable_file_fails_closed(self):
        self.vault.directory.mkdir()
        path = self.vault.directory / 'credentials.protected.json'
        for raw in ['not-json', '{"ciphertext":"invalid#"}', '{}']:
            path.write_text(raw, encoding='utf-8')
            self.assertEqual(self.vault.read(), {})

    def test_credential_validation_omits_no_unrecognized_fields(self):
        self.assertEqual(validate_credentials(CREDS, complete=True), CREDS)
        for value in [{**CREDS, 'url': 'https://evil.invalid'}, {**CREDS, 'passphrase': 'x\r\ny'}]:
            with self.assertRaises(WalletError):
                validate_credentials(value, complete=True)


if __name__ == '__main__':
    unittest.main()
