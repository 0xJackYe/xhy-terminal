"""Local HTTP boundary checks for cached BTC cost tracking."""
import json
import threading
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from btc_terminal_server import TerminalServer, WalletProxy


class CostService:
    def __init__(self):
        self.calls = 0
        self.fail = False

    def read_public(self):
        self.calls += 1
        if self.fail:
            raise RuntimeError('secret-private-internal-error')
        return {'status':'fresh', 'summary':{'net_bought_btc':'0.0684981895130917'},
                'plan_daily_usdt':'20', 'recent_trades':[]}


class BTCCostHTTPTests(unittest.TestCase):
    def setUp(self):
        self.service = CostService()
        self.server = TerminalServer(('127.0.0.1',0), None, WalletProxy(''), cost_service=self.service)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def call(self, path='/api/wallet/btc-cost', method='GET', headers=None):
        request = Request(self.url+path, method=method, headers=headers or {})
        try:
            with urlopen(request,timeout=2) as response:
                return response.status, response.headers, json.load(response)
        except HTTPError as error:
            return error.code, error.headers, json.load(error)

    def test_read_returns_cached_decimal_strings_and_no_store(self):
        status, headers, data = self.call()
        self.assertEqual(status,200)
        self.assertEqual(data['summary']['net_bought_btc'],'0.0684981895130917')
        self.assertEqual(headers['Cache-Control'],'no-store')
        self.assertEqual(self.service.calls,1)

    def test_private_local_api_cannot_be_read_by_foreign_origin(self):
        self.assertEqual(self.call(headers={'Origin':'https://evil.invalid'})[0],403)
        self.assertEqual(self.call(headers={'Host':'evil.invalid'})[0],403)
        self.assertEqual(self.service.calls,0)

    def test_unavailable_and_exception_messages_are_safe(self):
        self.service.fail = True
        status, _, data = self.call()
        self.assertEqual(status,503)
        self.assertNotIn('secret',json.dumps(data))
        self.server.cost_service = None
        self.assertEqual(self.call()[0],503)

    def test_queries_and_order_mutations_are_rejected(self):
        self.assertEqual(self.call('/api/wallet/btc-cost?refresh=1')[0],400)
        self.assertEqual(self.call('/api/wallet/btc-cost','POST')[0],405)
        self.assertEqual(self.service.calls,0)


if __name__ == '__main__':
    unittest.main()
