"""Real loopback boundary tests for OKX balances, using only fake accounts."""
import http.client
import json
import threading
import time
import unittest
from unittest.mock import patch

from btc_terminal_server import TerminalServer
from okx_wallet_service import OKXWalletService
from test_okx_wallet_service import CREDS, FakeFactory, MemoryVault


PREFIX = '/api/wallet/okx'


class Monitor:
    def read(self):
        return {'settings': {'threshold_pct': 2.5}}


class RunningServer:
    def __init__(self, service):
        self.server = TerminalServer(('127.0.0.1', 0), Monitor(), None, okx_service=service)
        self.port = self.server.server_port
        self.host = '127.0.0.1:%s' % self.port
        self.origin = 'http://' + self.host
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()

    def close(self):
        self.server.stopping.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(1)

    def call(self, path=PREFIX, method='GET', value=None, raw=None, headers=None, extra=(), length=None):
        if raw is None:
            raw = json.dumps(value, ensure_ascii=False).encode('utf-8') if value is not None else b''
        standard = [('Host', self.host)]
        if method == 'POST':
            standard += [('Origin', self.origin), ('X-Terminal-Request', '1'),
                         ('Content-Type', 'application/json'),
                         ('Content-Length', str(len(raw) if length is None else length))]
        if headers is not None:
            for name, value in headers.items():
                standard = [(key, current) for key, current in standard if key.lower() != name.lower()]
                if value is not None:
                    standard.append((name, value))
        standard += list(extra)
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        try:
            connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            for name, value in standard:
                connection.putheader(name, value)
            connection.endheaders(raw)
            response = connection.getresponse()
            payload = response.read()
            try:
                result = json.loads(payload)
            except (ValueError, UnicodeError):
                result = payload.decode('utf-8', errors='replace')
            return response.status, response.headers, result
        finally:
            connection.close()


class OKXWalletHTTPTests(unittest.TestCase):
    def setUp(self):
        self.vault = MemoryVault(CREDS)
        self.factory = FakeFactory()
        self.service = OKXWalletService(vault=self.vault, client_factory=self.factory)
        self.server = RunningServer(self.service)

    def tearDown(self):
        if self.factory.release is not None:
            self.factory.release.set()
        self.service.stop()
        self.server.close()

    def assert_no_secret(self, body):
        encoded = json.dumps(body)
        for secret in CREDS.values():
            self.assertNotIn(secret, encoded)

    def test_cached_balance_endpoint_security_headers_and_no_credentials(self):
        self.assertTrue(self.service.refresh_once())
        status, headers, body = self.server.call()
        self.assertEqual(status, 200)
        self.assertEqual(body['status'], 'connected')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(headers['Referrer-Policy'], 'no-referrer')
        self.assertIsNone(headers.get('Access-Control-Allow-Origin'))
        self.assert_no_secret(body)
        for _ in range(5):
            self.assertEqual(self.server.call()[0], 200)
        self.assertEqual(len(self.factory.calls), 1)

    def test_partial_passphrase_configuration_merges_without_echoing_key(self):
        self.service.credentials.pop('passphrase')
        self.assertEqual(self.server.call()[2]['missing_fields'], ['passphrase'])
        status, _, body = self.server.call(PREFIX + '/config', 'POST', {'passphrase': CREDS['passphrase']})
        self.assertEqual(status, 200)
        self.assertTrue(body['configured'])
        self.assertEqual(self.vault.credentials, CREDS)
        self.assert_no_secret(body)

    def test_refresh_is_async_and_old_snapshot_remains_readable_during_request(self):
        self.factory.started, self.factory.release = threading.Event(), threading.Event()
        self.service.start()
        self.assertTrue(self.factory.started.wait(1))
        start = time.monotonic()
        status, _, body = self.server.call(PREFIX + '/refresh', 'POST', {})
        self.assertEqual(status, 202)
        self.assertEqual(body['status'], 'connecting')
        self.assertTrue(body['refreshing'])
        self.assertLess(time.monotonic() - start, .4)
        self.assertEqual(self.server.call('/api/terminal')[0], 200)
        self.factory.release.set()
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            latest = self.server.call()[2]
            if latest['status'] == 'connected':
                break
            time.sleep(.01)
        self.assertEqual(latest['status'], 'connected')
        self.assertEqual(len(self.factory.calls), 1)

    def test_foreign_origin_and_rebinding_are_rejected_before_dispatch(self):
        for headers in [{'Host': 'evil.invalid'}, {'Host': '127.0.0.1:1'}, {'Host': None},
                        {'Origin': 'null'}, {'Origin': 'http://evil.invalid'},
                        {'Origin': 'https://' + self.server.host}]:
            with self.subTest(headers=headers):
                self.assertEqual(self.server.call(headers=headers)[0], 403)
                self.assertEqual(self.server.call(PREFIX + '/config', 'POST', CREDS, headers=headers)[0], 403)
        self.assertEqual(self.vault.saves, [])

    def test_duplicate_host_or_origin_are_rejected(self):
        for extra in [('Host', self.server.host), ('Origin', self.server.origin)]:
            self.assertEqual(self.server.call(PREFIX + '/config', 'POST', CREDS, extra=[extra])[0], 403)
        self.assertEqual(self.vault.saves, [])

    def test_localhost_exact_port_with_matching_origin_is_accepted(self):
        host = 'localhost:%s' % self.server.port
        self.assertEqual(self.server.call(PREFIX + '/refresh', 'POST', {},
            headers={'Host': host, 'Origin': 'http://' + host})[0], 202)

    def test_writes_require_terminal_header_and_json_content_type(self):
        for headers in [{'X-Terminal-Request': None}, {'X-Terminal-Request': 'true'},
                        {'Content-Type': None}, {'Content-Type': 'text/plain'}]:
            self.assertEqual(self.server.call(PREFIX + '/config', 'POST', CREDS, headers=headers)[0], 403)
        for duplicate in [('X-Terminal-Request', '1'), ('Content-Type', 'application/json')]:
            self.assertEqual(self.server.call(PREFIX + '/config', 'POST', CREDS, extra=[duplicate])[0], 403)
        self.assertEqual(self.vault.saves, [])

    def test_missing_duplicate_or_bad_content_length_and_chunking_rejected(self):
        cases = [{'Content-Length': None}, {'Content-Length': '-1'}, {'Content-Length': '4097'},
                 {'Content-Length': 'not-a-number'}, {'Transfer-Encoding': 'chunked'}]
        for headers in cases:
            self.assertEqual(self.server.call(PREFIX + '/refresh', 'POST', {}, headers=headers)[0], 400)
        self.assertEqual(self.server.call(PREFIX + '/refresh', 'POST', {},
            extra=[('Content-Length', '2')])[0], 400)

    def test_invalid_json_and_duplicate_keys_rejected(self):
        for raw in [b'not-json', b'[]', b'null', b'\xff', b'{"passphrase":"a","passphrase":"b"}', b'{}']:
            self.assertEqual(self.server.call(PREFIX + '/config', 'POST', raw=raw)[0], 400)
        self.assertEqual(self.vault.saves, [])

    def test_only_credential_fields_and_valid_values_accepted(self):
        for value in [{'url': 'https://evil.invalid'}, {'passphrase': 1}, {'passphrase': True},
                      {'passphrase': 'x\ny'}, {'passphrase': ''}, {'passphrase': 'x' * 257}]:
            status, _, body = self.server.call(PREFIX + '/config', 'POST', value)
            self.assertEqual(status, 400)
            self.assert_no_secret(body)
        self.assertEqual(self.vault.saves, [])

    def test_refresh_rejects_payload_and_queries_are_not_forwarded(self):
        self.assertEqual(self.server.call(PREFIX + '/refresh', 'POST', {'api_key': 'bad'})[0], 400)
        self.assertEqual(self.server.call(PREFIX + '?url=https://evil.invalid')[0], 400)
        self.assertEqual(self.server.call(PREFIX + '/config?passphrase=bad', 'POST', CREDS)[0], 400)
        self.assertEqual(self.vault.saves, [])

    def test_unsupported_paths_and_methods_do_not_mutate(self):
        for path in [PREFIX + '/trade', PREFIX + '/config', PREFIX + '/credentials']:
            self.assertEqual(self.server.call(path)[0], 405)
        self.assertEqual(self.server.call(PREFIX + '/trade', 'POST', {})[0], 405)
        self.assertGreaterEqual(self.server.call(PREFIX, 'DELETE')[0], 400)
        self.assertEqual(self.vault.saves, [])

    def test_cors_preflight_has_no_permissive_access_headers(self):
        status, headers, _ = self.server.call(PREFIX + '/config', 'OPTIONS',
            headers={'Origin': 'http://evil.invalid', 'Access-Control-Request-Method': 'POST'})
        self.assertGreaterEqual(status, 400)
        self.assertIsNone(headers.get('Access-Control-Allow-Origin'))
        self.assertIsNone(headers.get('Access-Control-Allow-Credentials'))

    def test_static_routes_cannot_serve_vault_source_or_asset_history(self):
        for path in ['/terminal/data/okx-wallet/credentials.protected.json',
                     '/terminal/data/okx-wallet/history.protected.json', '/okx_wallet_service.py',
                     '/wallet/../data/okx-wallet/credentials.protected.json',
                     '/%2e%2e/terminal/data/okx-wallet/credentials.protected.json']:
            status, _, body = self.server.call(path)
            self.assertEqual(status, 404)
            self.assert_no_secret(body)

    def test_internal_exception_and_missing_service_return_safe_json(self):
        with patch.object(self.service, 'configure', side_effect=RuntimeError(CREDS['secret_key'])):
            status, _, body = self.server.call(PREFIX + '/config', 'POST', CREDS)
            self.assertEqual(status, 503)
            self.assertEqual(body['code'], 'unavailable')
            self.assert_no_secret(body)
        self.server.server.okx_service = None
        status, _, body = self.server.call()
        self.assertEqual(status, 503)
        self.assert_no_secret(body)


if __name__ == '__main__':
    unittest.main()
