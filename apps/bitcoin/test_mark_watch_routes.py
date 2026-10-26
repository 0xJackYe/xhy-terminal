"""Both local entry points expose bounded public mark interest, never accounts."""
import http.client
import json
import threading
import unittest
from pathlib import Path

from btc_terminal_server import TerminalServer
from dashboard_server import DashboardServer


SYMBOLS = ("BTC-301116-60000-P", "BTC-301116-65000-P")


class WatchCache:
    def __init__(self):
        self.calls = []

    def watch_marks(self, symbols):
        self.calls.append(symbols)
        if any(symbol not in SYMBOLS for symbol in symbols):
            raise ValueError("只支持有效 BTC 期权合约。")
        return list(dict.fromkeys(symbols))


class MarkWatchRoutesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.caches = [WatchCache(), WatchCache()]
        cls.servers = [DashboardServer(("127.0.0.1", 0), cls.caches[0], Path(__file__).parent / "dashboard" / "dist"),
                       TerminalServer(("127.0.0.1", 0), None, None, cls.caches[1])]
        cls.threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in cls.servers]
        for thread in cls.threads:
            thread.start()

    @classmethod
    def tearDownClass(cls):
        for server in cls.servers:
            server.shutdown()
            server.server_close()
        for thread in cls.threads:
            thread.join(2)

    def setUp(self):
        for cache in self.caches:
            cache.calls.clear()

    def call(self, server, path, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        try:
            connection.request("GET", path, headers=headers or {})
            response = connection.getresponse()
            return response.status, response.getheader("Cache-Control"), json.loads(response.read())
        finally:
            connection.close()

    def test_public_interest_is_forwarded_in_order_and_not_cached(self):
        for server, cache in zip(self.servers, self.caches):
            with self.subTest(server=type(server).__name__):
                status, cache_control, payload = self.call(server, "/api/mark-watch?symbols=" + "%2C".join(reversed(SYMBOLS)))
                self.assertEqual(200, status)
                self.assertEqual("no-store", cache_control)
                self.assertEqual(list(reversed(SYMBOLS)), payload["accepted"])
                self.assertEqual([list(reversed(SYMBOLS))], cache.calls)

    def test_missing_ambiguous_empty_and_oversized_queries_never_reach_cache(self):
        queries = ("", "?symbols=", "?symbols=,", "?symbols=" + SYMBOLS[0] + ",",
                   "?symbols=" + ",".join([SYMBOLS[0]] * 9),
                   "?symbols=" + SYMBOLS[0] + "&symbols=" + SYMBOLS[1],
                   "?symbols=" + SYMBOLS[0] + "&apiKey=unused", "?other=x")
        for server, cache in zip(self.servers, self.caches):
            for query in queries:
                with self.subTest(server=type(server).__name__, query=query):
                    self.assertEqual(400, self.call(server, "/api/mark-watch" + query)[0])
            self.assertEqual([], cache.calls)

    def test_active_contract_rejection_from_cache_is_a_clear_client_error(self):
        for server, cache in zip(self.servers, self.caches):
            with self.subTest(server=type(server).__name__):
                status, _, payload = self.call(server, "/api/mark-watch?symbols=ETH-301116-2000-P")
                self.assertEqual(400, status)
                self.assertIn("BTC", payload["error"])
                self.assertEqual([["ETH-301116-2000-P"]], cache.calls)

    def test_untrusted_hosts_cannot_register_interest(self):
        for server, cache in zip(self.servers, self.caches):
            with self.subTest(server=type(server).__name__):
                self.assertEqual(403, self.call(server, "/api/mark-watch?symbols=" + SYMBOLS[0], {"Host": "untrusted.example"})[0])
                self.assertEqual([], cache.calls)

    def test_terminal_missing_public_cache_returns_unavailable(self):
        terminal = self.servers[1]
        original = terminal.cache
        try:
            terminal.cache = None
            status, _, payload = self.call(terminal, "/api/mark-watch?symbols=" + SYMBOLS[0])
            self.assertEqual(503, status)
            self.assertIn("error", payload)
        finally:
            terminal.cache = original


if __name__ == "__main__":
    unittest.main()
