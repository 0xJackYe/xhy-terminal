"""Offline only: mocked HTTP transport, synthetic credentials, no Binance calls."""

import io
import json
import ssl
import traceback
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPSHandler

from options_account_reader import ReadOnlyAPIError, ReadOnlyBinanceClient, _NoRedirect


KEY = "SYNTHETICKEY"
SECRET = "testsecret"
SYMBOL = "BTC-261030-82000-P"


class Response:
    def __init__(self, payload=None, status=200, headers=None, raw=None):
        self.status = status
        self.headers = headers or {}
        self.raw = json.dumps(payload).encode() if raw is None else raw

    def getcode(self):
        return self.status

    def read(self, maximum):
        return self.raw[:maximum]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class Transport:
    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if not self.outcomes:
            raise AssertionError("Mock transport exhausted; no network is available")
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def http_error(status, code=-1000, headers=None):
    # Deliberately malicious diagnostics: public errors must discard all of it.
    raw = json.dumps({"code": code, "msg": KEY + SECRET + "signature=unsafe"}).encode()
    return HTTPError("https://eapi.binance.com/?signature=unsafe&key=" + KEY,
                     status, SECRET, headers or {}, io.BytesIO(raw))


class ReadOnlyClientTests(unittest.TestCase):
    def setUp(self):
        self.clock = patch("options_account_reader.time.time", return_value=1700000000.0)
        self.monotonic = patch("options_account_reader.time.monotonic", return_value=100.0)
        self.sleep = patch("options_account_reader.time.sleep")
        self.clock.start()
        self.monotonic.start()
        self.sleep_mock = self.sleep.start()
        self.addCleanup(self.clock.stop)
        self.addCleanup(self.monotonic.stop)
        self.addCleanup(self.sleep.stop)

    def client(self, *outcomes, credentials=True):
        client = ReadOnlyBinanceClient(KEY if credentials else None, SECRET if credentials else None)
        transport = Transport(*outcomes)
        client._opener = transport
        self.addCleanup(client.close)
        return client, transport

    def assert_safe(self, error):
        diagnostics = str(error) + repr(error) + repr(error.__dict__) + "".join(traceback.format_exception(type(error), error, error.__traceback__))
        for value in (KEY, SECRET, "signature=", "https://", "unsafe"):
            self.assertNotIn(value, diagnostics)
        self.assertIsNone(error.__context__)

    def test_fixed_hmac_vector_header_only_key_and_forced_get(self):
        client, transport = self.client(Response([]))
        self.assertEqual([], client.get("/eapi/v1/position", {"symbol": SYMBOL}))
        request, timeout = transport.requests[0]
        self.assertEqual("GET", request.get_method())
        self.assertIsNone(request.data)
        self.assertEqual(10, timeout)
        self.assertEqual(KEY, request.get_header("X-mbx-apikey"))
        self.assertEqual("https://eapi.binance.com/eapi/v1/position?symbol=BTC-261030-82000-P&timestamp=1700000000000&signature=82177fe6fd1cdf2953bda90125a32368da73b4b714f2e8f594fe3113e6f9955b", request.full_url)
        self.assertNotIn(KEY, request.full_url)
        self.assertNotIn(SECRET, request.full_url)

    def test_public_time_needs_no_credentials_or_api_header(self):
        client, transport = self.client(Response({"serverTime": 1700000000000}), credentials=False)
        self.assertEqual(1700000000000, client.get("/eapi/v1/time")["serverTime"])
        request, _ = transport.requests[0]
        self.assertEqual("https://eapi.binance.com/eapi/v1/time", request.full_url)
        self.assertIsNone(request.get_header("X-mbx-apikey"))

    def test_even_configured_key_is_not_attached_to_public_time(self):
        client, transport = self.client(Response({"serverTime": 1700000000000}))
        client.get("/eapi/v1/time")
        self.assertIsNone(transport.requests[0][0].get_header("X-mbx-apikey"))

    def test_only_approved_paths_and_hosts_and_no_write_methods(self):
        routes = [("/eapi/v1/position", {}), ("/eapi/v1/marginAccount", {}),
                  ("/eapi/v1/bill", {"currency": "USDT"}),
                  ("/eapi/v1/userTrades", {"symbol": SYMBOL}),
                  ("/eapi/v1/exerciseRecord", {}), ("/eapi/v1/commission", {}),
                  ("/sapi/v1/account/apiRestrictions", {})]
        client, transport = self.client(*(Response([]) for _ in routes))
        for path, params in routes:
            client.get(path, params)
        for request, _ in transport.requests:
            parsed = urlsplit(request.full_url)
            self.assertEqual("https", parsed.scheme)
            self.assertEqual("api.binance.com" if parsed.path.startswith("/sapi/") else "eapi.binance.com", parsed.hostname)
            self.assertEqual("GET", request.get_method())
        for name in ("post", "delete", "put", "request"):
            self.assertFalse(hasattr(client, name))

    def test_unknown_urls_write_paths_and_query_path_are_rejected_before_transport(self):
        client, transport = self.client()
        for path in ("https://attacker.invalid/eapi/v1/position", "//attacker.invalid", "/eapi/v1/order", "/eapi/v1/historyOrders", "/eapi/v1/position?symbol=" + SYMBOL, "/eapi/v1/../order", None):
            with self.subTest(path=path), self.assertRaises(ReadOnlyAPIError) as caught:
                client.get(path)
            self.assert_safe(caught.exception)
        self.assertEqual([], transport.requests)

    def test_unapproved_or_malicious_params_are_not_encoded_or_echoed(self):
        client, transport = self.client()
        params = [{"timestamp": 1}, {"signature": SECRET}, {"api_secret": SECRET},
                  {"url": "https://attacker.invalid"}, {"method": "POST"},
                  {"symbol": SYMBOL + "&apiKey=" + KEY}, {"symbol": [SYMBOL]},
                  {"symbol": SYMBOL, "limit": True}, {"recvWindow": "5000&signature=" + SECRET},
                  {"recvWindow": 60001}, {"startTime": 3, "endTime": 2},
                  {"limit": 1001}, {"fromId": -1}, {"symbol": SYMBOL, SECRET: None}]
        for params_ in params:
            with self.subTest(params=list(params_)), self.assertRaises(ReadOnlyAPIError) as caught:
                client.get("/eapi/v1/userTrades", params_)
            self.assert_safe(caught.exception)
        self.assertEqual([], transport.requests)

    def test_required_params_and_missing_credentials_fail_locally(self):
        client, transport = self.client(credentials=False)
        for path, params in (("/eapi/v1/position", {}), ("/eapi/v1/bill", {}), ("/eapi/v1/userTrades", {})):
            with self.assertRaises(ReadOnlyAPIError) as caught:
                client.get(path, params)
            self.assert_safe(caught.exception)
        self.assertEqual([], transport.requests)

    def test_valid_integer_strings_are_canonical_and_optional_none_is_omitted(self):
        client, transport = self.client(Response([]))
        client.get("/eapi/v1/userTrades", {"symbol": SYMBOL, "fromId": "000123", "startTime": 1, "endTime": 2, "limit": 1000, "recvWindow": None})
        query = parse_qs(urlsplit(transport.requests[0][0].full_url).query)
        self.assertEqual(["123"], query["fromId"])
        self.assertNotIn("recvWindow", query)

    def test_http_error_body_url_and_exception_chain_are_redacted(self):
        client, transport = self.client(http_error(403, -2015))
        with self.assertRaises(ReadOnlyAPIError) as caught:
            client.get("/eapi/v1/position")
        self.assertEqual(403, caught.exception.status)
        self.assertEqual(-2015, caught.exception.code)
        self.assert_safe(caught.exception)
        self.assertEqual(1, len(transport.requests))

    def test_application_errors_and_invalid_numeric_codes_never_echo_body(self):
        for code in (-6073, SECRET, True, -2 ** 80):
            response = Response({"code": code, "msg": KEY + SECRET}, status=400)
            client, _ = self.client(response)
            with self.assertRaises(ReadOnlyAPIError) as caught:
                client.get("/eapi/v1/bill", {"currency": "USDT"})
            self.assert_safe(caught.exception)
            self.assertEqual(-6073 if code == -6073 else None, caught.exception.code)

    def test_invalid_json_is_not_reflected_and_is_not_retried(self):
        client, transport = self.client(Response(raw=(KEY + SECRET).encode()))
        with self.assertRaises(ReadOnlyAPIError) as caught:
            client.get("/eapi/v1/position")
        self.assertEqual("format", caught.exception.reason)
        self.assert_safe(caught.exception)
        self.assertEqual(1, len(transport.requests))

    def test_redirect_is_rejected_and_never_followed(self):
        client, transport = self.client(http_error(302, headers={"Location": "https://attacker.invalid"}))
        with self.assertRaises(ReadOnlyAPIError) as caught:
            client.get("/eapi/v1/position")
        self.assertEqual("redirect", caught.exception.reason)
        self.assertEqual(1, len(transport.requests))
        self.assert_safe(caught.exception)
        self.assertIsNone(_NoRedirect().redirect_request(None, None, 307, SECRET, {}, "https://attacker.invalid"))

    def test_tls_verification_and_redirect_handler_are_installed(self):
        client = ReadOnlyBinanceClient()
        self.addCleanup(client.close)
        self.assertTrue(any(isinstance(handler, _NoRedirect) for handler in client._opener.handlers))
        https = next(handler for handler in client._opener.handlers if isinstance(handler, HTTPSHandler))
        self.assertTrue(https._context.check_hostname)
        self.assertEqual(ssl.CERT_REQUIRED, https._context.verify_mode)

    def test_rate_limit_and_ban_stop_immediately_with_numeric_retry_after(self):
        for status in (418, 429):
            client, transport = self.client(http_error(status, -1003, {"Retry-After": "123"}), Response([]))
            with self.assertRaises(ReadOnlyAPIError) as caught:
                client.get("/eapi/v1/position")
            self.assertEqual(status, caught.exception.status)
            self.assertEqual(123, caught.exception.retry_after)
            self.assertEqual(1, len(transport.requests))
            self.assert_safe(caught.exception)

    def test_unsafe_retry_after_header_is_discarded(self):
        client, _ = self.client(http_error(429, headers={"Retry-After": KEY + SECRET}))
        with self.assertRaises(ReadOnlyAPIError) as caught:
            client.get("/eapi/v1/position")
        self.assertIsNone(caught.exception.retry_after)
        self.assert_safe(caught.exception)

    def test_timeout_and_5xx_retry_at_most_twice_then_fail_safely(self):
        for make_error in (lambda: TimeoutError(KEY + SECRET), lambda: URLError(KEY + SECRET), lambda: http_error(503)):
            client, transport = self.client(*(make_error() for _ in range(3)))
            with self.assertRaises(ReadOnlyAPIError) as caught:
                client.get("/eapi/v1/position")
            self.assertEqual(3, len(transport.requests))
            self.assert_safe(caught.exception)

    def test_transient_error_can_recover_without_changing_get_semantics(self):
        client, transport = self.client(http_error(503), TimeoutError(SECRET), Response([{"quantity": "-0.01"}]))
        self.assertEqual([{"quantity": "-0.01"}], client.get("/eapi/v1/position"))
        self.assertEqual(3, len(transport.requests))
        self.assertTrue(all(request.get_method() == "GET" for request, _ in transport.requests))

    def test_timestamp_error_calibrates_once_and_resigns_once(self):
        client, transport = self.client(http_error(400, -1021), Response({"serverTime": 1700000009000}), Response([]))
        self.assertEqual([], client.get("/eapi/v1/position"))
        paths = [urlsplit(request.full_url).path for request, _ in transport.requests]
        self.assertEqual(["/eapi/v1/position", "/eapi/v1/time", "/eapi/v1/position"], paths)
        first = parse_qs(urlsplit(transport.requests[0][0].full_url).query)
        last = parse_qs(urlsplit(transport.requests[2][0].full_url).query)
        self.assertEqual(["1700000009000"], last["timestamp"])
        self.assertNotEqual(first["signature"], last["signature"])
        self.assertIsNone(transport.requests[1][0].get_header("X-mbx-apikey"))

    def test_repeated_timestamp_error_does_not_loop_or_resync_again(self):
        client, transport = self.client(http_error(400, -1021), Response({"serverTime": 1700000009000}), http_error(400, -1021))
        with self.assertRaises(ReadOnlyAPIError) as caught:
            client.get("/eapi/v1/position")
        self.assertEqual("clock", caught.exception.reason)
        self.assertEqual(3, len(transport.requests))
        self.assert_safe(caught.exception)

    def test_sync_time_uses_network_midpoint_and_rejects_invalid_server_time(self):
        client, _ = self.client(Response({"serverTime": 1700000000900}))
        with patch("options_account_reader.time.time", side_effect=[1700000000.5, 1700000000.7]):
            self.assertEqual(300, client.sync_time())
        for value in (None, True, "1700000000900", -1):
            client, _ = self.client(Response({"serverTime": value}))
            with self.assertRaises(ReadOnlyAPIError):
                client.sync_time()

    def test_weighted_spacing_serializes_heavier_reads(self):
        client, _ = self.client(Response([]), Response({"serverTime": 1700000000000}))
        client.get("/eapi/v1/position")
        client.get("/eapi/v1/time")
        self.sleep_mock.assert_called_once_with(1.75)

    def test_permission_flags_are_data_and_never_cause_privilege_changes(self):
        flags = {"enableReading": True, "enableVanillaOptions": False, "enableWithdrawals": True}
        client, transport = self.client(Response(flags), Response([]))
        self.assertEqual(flags, client.get("/sapi/v1/account/apiRestrictions"))
        self.assertEqual([], client.get("/eapi/v1/position"))
        self.assertEqual(2, len(transport.requests))

    def test_repr_and_closed_client_never_retain_or_display_credentials(self):
        client, transport = self.client()
        for text in (str(client), repr(client)):
            self.assertNotIn(KEY, text)
            self.assertNotIn(SECRET, text)
        client.close()
        self.assertIsNone(client._api_key)
        self.assertIsNone(client._api_secret)
        self.assertIsNone(client._opener)
        with self.assertRaises(ReadOnlyAPIError) as caught:
            client.get("/eapi/v1/time")
        self.assert_safe(caught.exception)
        self.assertEqual([], transport.requests)

    def test_invalid_credential_input_has_only_fixed_error_text(self):
        for key, secret in ((KEY + "\r\nInjected: x", SECRET), (KEY, "\ud800"), (KEY, object())):
            with self.assertRaises(ReadOnlyAPIError) as caught:
                ReadOnlyBinanceClient(key, secret)
            self.assert_safe(caught.exception)


if __name__ == "__main__":
    unittest.main()

