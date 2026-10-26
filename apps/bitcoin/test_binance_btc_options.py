"""Offline checks for missing data, joins, filters, and HTTP failure handling."""

import contextlib
import copy
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

import binance_btc_options as app

NOW = 1791892000000


def fixture():
    symbols = ["BTC-261127-60000-P", "BTC-261127-68000-P", "BTC-261127-100000-C"]
    return {
        "/eapi/v1/time": {"serverTime": NOW},
        "/eapi/v1/exchangeInfo": {"optionSymbols": [
            {"symbol": symbol, "side": "CALL" if symbol.endswith("C") else "PUT",
             "underlying": "BTCUSDT", "expiryDate": NOW + 45 * 86400000,
             "strikePrice": str(strike), "status": "TRADING", "unit": 1,
             "minQty": "0.01", "quoteAsset": "USDT"}
            for symbol, strike in zip(symbols, (60000, 68000, 100000))]},
        "/eapi/v1/index": {"indexPrice": "80000", "time": NOW},
        # Deliberately reverse the order; symbol matching must determine prices.
        "/eapi/v1/mark": [
            {"symbol": symbol, "markPrice": str(price), "markIV": "0.5", "delta": "-0.1",
             "gamma": "0.001", "theta": "-3", "vega": "20"}
            for symbol, price in zip(reversed(symbols), (300, 200, 100))],
        "/eapi/v1/ticker": [
            {"symbol": symbol, "bidPrice": str(price), "askPrice": str(price + 10),
             "lastPrice": str(price), "volume": "0", "amount": "0", "closeTime": 0}
            for symbol, price in zip(symbols, (90, 190, 290))],
        "/eapi/v1/depth": {"bids": [["90", "0.1"]], "asks": [["100", "0.1"]]},
    }


class MarketDataTests(unittest.TestCase):
    def run_snapshot(self, data, flags=(), errors=None):
        calls = []

        def request(path, timeout, params=None):
            calls.append(path)
            if errors and path in errors:
                return copy.deepcopy(errors[path])
            return {"ok": True, "http_status": 200, "elapsed_ms": 1, "data": copy.deepcopy(data[path])}

        with tempfile.TemporaryDirectory() as folder:
            argv = ["binance_btc_options.py", "--output-dir", folder, *flags]
            with patch.object(app, "get_public", side_effect=request), patch.object(app.sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()):
                code = app.main()
            files = list(Path(folder).glob("*.json"))
            self.assertEqual(len(files), 1)
            snapshot = json.loads(files[0].read_text(encoding="utf-8"))
            return code, snapshot, calls

    def test_join_and_put_filter(self):
        code, snapshot, calls = self.run_snapshot(fixture(), ("--side", "PUT", "--min-days", "30", "--max-days", "60", "--min-otm", "20", "--max-otm", "30"))
        self.assertEqual(code, 0)
        self.assertEqual(snapshot["selected_contracts"], 1)
        row = snapshot["options"][0]
        self.assertEqual((row["strike_price"], row["otm_pct"], row["mark_price"], row["bid_price"]), ("60000", 25.0, "100", "90"))
        self.assertEqual(snapshot["status"], "SUCCESS")
        self.assertFalse(snapshot["credentials_used"])
        self.assertIn("/eapi/v1/depth", calls)

    def test_missing_mark_does_not_claim_success(self):
        data = fixture()
        data["/eapi/v1/mark"] = data["/eapi/v1/mark"][:-1]
        code, snapshot, _ = self.run_snapshot(data)
        self.assertEqual((code, snapshot["status"]), (1, "PARTIAL"))
        self.assertIsNone(snapshot["options"][0]["mark_price"])
        self.assertFalse(snapshot["options"][0]["has_mark"])

    def test_malformed_records_produce_failure_report(self):
        for path, bad_data in (("/eapi/v1/mark", [{"symbol": "BTC-bad"}]),
                               ("/eapi/v1/ticker", [{"symbol": None}]),
                               ("/eapi/v1/exchangeInfo", {"optionSymbols": [None]})):
            with self.subTest(path=path):
                data = fixture()
                data[path] = bad_data
                code, snapshot, _ = self.run_snapshot(data)
                self.assertEqual(code, 1)
                self.assertNotEqual(snapshot["status"], "SUCCESS")
                self.assertIn("UNEXPECTED_SCHEMA", json.dumps(snapshot))

    def test_valid_zero_quote_is_preserved(self):
        data = fixture()
        data["/eapi/v1/ticker"][0]["bidPrice"] = "0"
        code, snapshot, _ = self.run_snapshot(data)
        self.assertEqual(code, 0)
        self.assertEqual(snapshot["options"][0]["bid_price"], "0")

    def test_no_recent_trade_time_does_not_discard_quotes(self):
        data = fixture()
        data["/eapi/v1/ticker"][0]["closeTime"] = None
        code, snapshot, _ = self.run_snapshot(data)
        self.assertEqual(code, 0)
        self.assertEqual(snapshot["options"][0]["bid_price"], "90")
        self.assertIsNone(snapshot["options"][0]["last_trade_beijing"])

    def test_empty_filter_result_is_success(self):
        code, snapshot, calls = self.run_snapshot(fixture(), ("--min-days", "100", "--max-days", "200"))
        self.assertEqual((code, snapshot["status"], snapshot["selected_contracts"]), (0, "SUCCESS", 0))
        self.assertNotIn("/eapi/v1/depth", calls)

    def test_time_rate_limit_stops_further_requests(self):
        error = {"ok": False, "http_status": 429, "error": {"type": "HTTP_ERROR", "message": "Rate limited"}}
        code, snapshot, calls = self.run_snapshot(fixture(), errors={"/eapi/v1/time": error})
        self.assertEqual((code, snapshot["status"]), (1, "FAILED"))
        self.assertEqual(calls, ["/eapi/v1/time"])

    def test_http_request_has_no_auth_and_does_not_retry(self):
        error = urllib.error.HTTPError("https://eapi.binance.com/eapi/v1/time", 429, "Limited", {}, io.BytesIO(b'{"code":-1003,"msg":"Too many requests"}'))
        with patch.object(app.urllib.request, "urlopen", side_effect=error) as opened:
            result = app.get_public("/eapi/v1/time", 1)
        self.assertFalse(result["ok"])
        self.assertEqual(result["http_status"], 429)
        self.assertEqual(opened.call_count, 1)
        request = opened.call_args[0][0]
        self.assertEqual(request.get_method(), "GET")
        self.assertNotIn("x-mbx-apikey", {key.lower() for key, _ in request.header_items()})
        self.assertNotIn("signature", request.full_url)


if __name__ == "__main__":
    unittest.main()
