"""Offline failure/recovery checks for the shared public market transport."""
import io
import json
import unittest
import urllib.error
from unittest.mock import patch

import binance_btc_options as market


class Response(io.BytesIO):
    status = 200

    def __init__(self, payload=b'{"serverTime":1792182000000}', *, error=None, length=None):
        super().__init__(payload)
        self.headers = {"Content-Length": str(len(payload) if length is None else length)}
        self.error = error

    def read1(self, amount=-1):
        if self.error:
            raise self.error
        return super().read1(amount)


class PublicTransportRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.guard = patch.object(market, "_PUBLIC_REQUEST_LIMITER", market.PublicRequestLimiter())
        self.guard.start()
        self.sleep = patch.object(market.time, "sleep")
        self.sleep_mock = self.sleep.start()

    def tearDown(self):
        self.sleep.stop()
        self.guard.stop()

    def test_reset_after_200_retries_complete_body_and_keeps_failure_evidence(self):
        with patch.object(market.urllib.request, "urlopen", side_effect=[
                Response(error=ConnectionResetError("private-proxy-secret")), Response()]) as request:
            result = market.get_public("/eapi/v1/time", 1)
        self.assertTrue(result["ok"])
        self.assertEqual(2, request.call_count)
        self.assertEqual(2, result["attempts"])
        self.assertTrue(result["response_complete"])
        self.assertEqual("READ_RESET", result["attempt_history"][0]["error_type"])
        self.assertEqual(200, result["attempt_history"][0]["http_status"])
        self.assertNotIn("private-proxy-secret", json.dumps(result))

    def test_persistent_read_timeout_stops_at_three_and_never_exposes_partial_data(self):
        with patch.object(market.urllib.request, "urlopen", side_effect=[
                Response(error=TimeoutError()) for _ in range(3)]) as request:
            result = market.get_public("/eapi/v1/time", 1)
        self.assertFalse(result["ok"])
        self.assertEqual(3, request.call_count)
        self.assertEqual("READ_TIMEOUT", result["error"]["type"])
        self.assertEqual("read", result["error"]["phase"])
        self.assertFalse(result["response_complete"])
        self.assertNotIn("data", result)
        self.assertEqual(2, self.sleep_mock.call_count)

    def test_truncated_body_retries_instead_of_treating_headers_as_success(self):
        with patch.object(market.urllib.request, "urlopen", side_effect=[
                Response(b'{"serverTime":', length=100), Response()]):
            result = market.get_public("/eapi/v1/time", 1)
        self.assertTrue(result["ok"])
        self.assertEqual("READ_INTERRUPTED", result["attempt_history"][0]["error_type"])

    def test_invalid_schema_is_not_retried_or_returned_as_usable_data(self):
        with patch.object(market.urllib.request, "urlopen", return_value=Response(b'{"serverTime":null}')) as request:
            result = market.get_public("/eapi/v1/time", 1)
        self.assertFalse(result["ok"])
        self.assertEqual(1, request.call_count)
        self.assertEqual("UNEXPECTED_SCHEMA", result["error"]["type"])
        self.assertNotIn("data", result)

    def test_rate_limit_cools_down_other_endpoint_without_sending_another_request(self):
        error = urllib.error.HTTPError("https://eapi.binance.com/eapi/v1/time", 429,
                                      "limited", {"Retry-After": "90"}, io.BytesIO())
        with patch.object(market.urllib.request, "urlopen", side_effect=error) as request:
            first = market.get_public("/eapi/v1/time", 1)
            second = market.get_public("/eapi/v1/mark", 1)
        self.assertEqual(1, request.call_count)
        self.assertEqual(429, first["http_status"])
        self.assertTrue(second["rate_limited"])
        self.assertEqual(0, second["attempts"])
        self.assertEqual(429, second["blocked_by_http_status"])
        self.assertNotIn("http_status", second)
        self.assertGreaterEqual(int(second["retry_after"]), 89)

    def test_each_attempt_is_charged_to_weight_budget(self):
        with patch.object(market.urllib.request, "urlopen", side_effect=[
                Response(error=ConnectionResetError()), Response()]):
            result = market.get_public("/eapi/v1/time", 1)
        self.assertTrue(result["ok"])
        self.assertEqual(2, sum(cost for _, cost in market._PUBLIC_REQUEST_LIMITER._events))

    def test_local_weight_limit_blocks_before_request(self):
        market._PUBLIC_REQUEST_LIMITER = market.PublicRequestLimiter(minute_limit=2)
        with patch.object(market.urllib.request, "urlopen", return_value=Response()) as request:
            market.get_public("/eapi/v1/time", 1)
            result = market.get_public("/eapi/v1/time", 1)
        self.assertEqual(1, request.call_count)
        self.assertEqual("LOCAL_RATE_LIMIT", result["error"]["type"])
        self.assertEqual(0, result["attempts"])


if __name__ == "__main__":
    unittest.main()
