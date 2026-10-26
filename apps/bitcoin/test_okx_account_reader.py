"""Offline tests.  All credentials and account balances below are synthetic."""
import base64
import copy
import datetime as dt
import hashlib
import hmac
import io
import json
import socket
import unittest
import urllib.error
import urllib.request
import urllib.parse
from unittest.mock import patch

import okx_account_reader as reader


CREDENTIALS = {"api_key": "fixture-key-not-real", "secret_key": "fixture-secret-not-real",
               "passphrase": "fixture-passphrase-not-real"}
SERVER_MS = "1760000000123"
NOW = int(SERVER_MS) / 1000.0
TRADING = [{"totalEq": "12345.678901234567890123", "uTime": SERVER_MS, "details": [
    {"ccy": "BTC", "eq": "0.1234567890123456789012345", "cashBal": "0.15",
     "availBal": "0.05", "liab": "0.02", "upl": "-0.0065432109876543210987655",
     "eqUsd": "10000.1234567890123456789", "uTime": SERVER_MS},
    {"ccy": "USDT", "eq": "-2.00001", "cashBal": "-1.5", "availBal": "-2",
     "liab": "2", "upl": "-0.50001", "eqUsd": "-2.00001"},
]}]
FUNDING = [{"ccy": "BTC", "bal": "0.02", "availBal": "0.015", "frozenBal": "0.005"},
           {"ccy": "ETH", "bal": "3.25", "availBal": "", "frozenBal": ""}]


def body(data, code="0", **kwargs):
    return json.dumps(dict({"code": code, "data": data, "msg": ""}, **kwargs)).encode("utf-8")


class Response:
    def __init__(self, payload, status=200, url=None):
        self.payload = payload
        self.status = status
        self.url = url
        self.closed = False
        self.offset = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.closed = True

    def geturl(self):
        return self.url

    def getcode(self):
        return self.status

    def read(self, count):
        if isinstance(self.payload, Exception):
            raise self.payload
        chunk = self.payload[self.offset:self.offset + count]
        self.offset += len(chunk)
        return chunk


class Opener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def open(self, request, timeout=None):
        self.calls.append((request, timeout))
        if not self.responses:
            raise AssertionError("unexpected request")
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        response = result if isinstance(result, Response) else Response(result)
        if response.url is None:
            response.url = request.full_url
        return response


def responses(config=None, trading=None, funding=None):
    return [body([{"ts": SERVER_MS}]), body([{"perm": "read_only"}] if config is None else config),
            body(TRADING if trading is None else trading), body(FUNDING if funding is None else funding)]


def client(items=None, **kwargs):
    opener = Opener(responses() if items is None else items)
    options = {"clock": lambda: NOW, "monotonic": lambda: 100.0}
    options.update(kwargs)
    return reader.OKXReadOnlyClient(CREDENTIALS, opener=opener, **options), opener


class ReaderTests(unittest.TestCase):
    def assert_error(self, callback, code):
        with self.assertRaises(reader.OKXReadError) as caught:
            callback()
        error = caught.exception
        self.assertEqual(error.code, code)
        self.assertEqual(str(error), error.message)
        for secret in CREDENTIALS.values():
            self.assertNotIn(secret, str(error))
        return error

    def test_full_snapshot_preserves_decimal_strings(self):
        account, opener = client()
        result = account.read_account()
        self.assertEqual(result["trading"]["total_equity_usd"], "12345.678901234567890123")
        self.assertEqual(result["trading"]["assets"][0]["equity"], "0.1234567890123456789012345")
        self.assertEqual(result["trading"]["assets"][1]["equity"], "-2.00001")
        self.assertEqual(result["trading"]["assets"][1]["available"], "-2")
        self.assertEqual(result["permissions"], {"verified": True, "read_only": True})
        self.assertEqual(result["funding"]["assets"][0]["balance"], "0.02")
        self.assertEqual(len(opener.calls), 4)
        json.dumps(result, allow_nan=False)

    def test_cash_equity_liabilities_remain_distinct_not_summed(self):
        normalized = reader.normalize_trading(TRADING)
        btc = normalized["assets"][0]
        self.assertEqual(btc["equity"], TRADING[0]["details"][0]["eq"])
        self.assertEqual(btc["cash_balance"], "0.15")
        self.assertEqual(btc["liabilities"], "0.02")
        self.assertEqual(normalized["total_equity_usd"], TRADING[0]["totalEq"])

    def test_unsigned_time_and_fresh_hmac_for_each_private_get(self):
        account, opener = client()
        account.read_account()
        public_headers = dict((k.lower(), v) for k, v in opener.calls[0][0].header_items())
        self.assertFalse(any(k.startswith("ok-access-") for k in public_headers))
        for request, timeout in opener.calls[1:]:
            headers = dict((k.lower(), v) for k, v in request.header_items())
            self.assertEqual(request.get_method(), "GET")
            self.assertIsNone(request.data)
            self.assertEqual(headers["ok-access-key"], CREDENTIALS["api_key"])
            self.assertEqual(headers["ok-access-passphrase"], CREDENTIALS["passphrase"])
            path = request.full_url[len(reader.ORIGIN):]
            expected = base64.b64encode(hmac.new(CREDENTIALS["secret_key"].encode(),
                (headers["ok-access-timestamp"] + "GET" + path).encode(), hashlib.sha256).digest()).decode()
            self.assertEqual(headers["ok-access-sign"], expected)
            self.assertLessEqual(timeout, reader.SOCKET_TIMEOUT)

    def test_time_sync_corrects_host_clock_without_local_timezone(self):
        account, opener = client(clock=lambda: 1000.0)
        result = account.read_account()
        expected = dt.datetime.fromtimestamp(NOW, dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self.assertEqual(result["observed_at"], expected)
        headers = dict((k.lower(), v) for k, v in opener.calls[1][0].header_items())
        self.assertEqual(headers["ok-access-timestamp"], expected)

    def test_time_sync_uses_round_trip_midpoint(self):
        # deadline, before_mono, request, bodychunk, bodyEOF, post-read, after
        ticks = iter([100.0, 100.0, 100.0, 100.0, 102.0, 102.0, 102.0] + [102.0] * 40)
        account, unused = client(monotonic=lambda: next(ticks))
        account.read_account()
        self.assertAlmostEqual(account._offset, -1.0, places=5)

    def test_gets_are_only_allowlisted_paths(self):
        account, opener = client()
        account.read_account()
        self.assertEqual([request.full_url for request, _ in opener.calls],
                         [reader.ORIGIN + path for path in [reader.TIME_PATH, reader.CONFIG_PATH,
                                                           reader.TRADING_PATH, reader.FUNDING_PATH]])
        self.assert_error(lambda: account._request("/api/v5/trade/order", True, 200), "endpoint_rejected")
        self.assert_error(lambda: account._request(reader.TRADING_PATH, False, 200), "endpoint_rejected")
        self.assert_error(lambda: account._request("https://evil.invalid", True, 200), "endpoint_rejected")
        self.assertEqual(len(opener.calls), 4)

    def test_present_write_permissions_rejected_before_reading_balances(self):
        for permission in ["read_only,trade", "read_only,withdraw", "trade", "read_only,new_write", "unknown"]:
            with self.subTest(permission=permission):
                account, opener = client(responses(config=[{"perm": permission}]))
                self.assert_error(account.read_account, "read_only_required")
                self.assertEqual(len(opener.calls), 2)

    def test_missing_permission_not_falsely_verified(self):
        for data in [[{}], [{"perm": ""}], [{"perm": None}]]:
            account, _ = client(responses(config=data))
            self.assertEqual(account.read_account()["permissions"], {"verified": False, "read_only": None})

    def test_private_account_identity_and_config_fields_never_returned(self):
        config = [{"perm": "read_only", "uid": "private-identity", "label": "secret-label", "ip": "secret-ip"}]
        trading = copy.deepcopy(TRADING)
        trading[0]["secret-field"] = "private-extra"
        account, _ = client(responses(config=config, trading=trading))
        encoded = json.dumps(account.read_account())
        for value in ["private-identity", "secret-label", "secret-ip", "private-extra"] + list(CREDENTIALS.values()):
            self.assertNotIn(value, encoded)
        for value in CREDENTIALS.values():
            self.assertNotIn(value, repr(account))

    def test_zero_balance_assets_not_discarded(self):
        trading = [{"totalEq": "0", "details": [{"ccy": "BTC", "eq": "0", "cashBal": "0", "liab": "1"}]}]
        account, _ = client(responses(trading=trading, funding=[{"ccy": "BTC", "bal": "0"}]))
        result = account.read_account()
        self.assertEqual(len(result["trading"]["assets"]), 1)
        self.assertEqual(len(result["funding"]["assets"]), 1)
        self.assertEqual(result["trading"]["assets"][0]["liabilities"], "1")

    def test_missing_values_stay_unknown_not_zero(self):
        normalized = reader.normalize_funding(FUNDING)
        self.assertIsNone(normalized["assets"][1]["available"])
        self.assertIsNone(normalized["assets"][1]["frozen"])
        trading = reader.normalize_trading([{"totalEq": "0", "details": [{"ccy": "BTC"}]}])
        self.assertIsNone(trading["assets"][0]["equity"])
        self.assertIsNone(trading["assets"][0]["equity_usd"])

    def test_empty_funding_account_is_legitimate(self):
        self.assertEqual(reader.normalize_funding([]), {"assets": []})
        self.assertEqual(reader.normalize_trading([{"totalEq": "0", "details": []}])["assets"], [])

    def test_missing_account_total_cannot_be_silently_zeroed(self):
        for bad in [{"details": []}, {"totalEq": "", "details": []}, {"totalEq": None, "details": []}]:
            self.assert_error(lambda: reader.normalize_trading([bad]), "invalid_response")

    def test_numeric_corruption_cannot_be_accepted(self):
        for value in [True, 1, 1.2, float("nan"), "NaN", "Infinity", "1e999", "+1", " 1", "1 ", [], {}, "0" * 200]:
            with self.subTest(value=repr(value)):
                data = [{"ccy": "BTC", "bal": value}]
                self.assert_error(lambda: reader.normalize_funding(data), "invalid_response")

    def test_negative_values_and_negative_zero_preserved(self):
        data = [{"ccy": "USDT", "bal": "-3.123", "availBal": "-4.1", "frozenBal": "-0.00"}]
        normalized = reader.normalize_funding(data)["assets"][0]
        self.assertEqual(normalized["balance"], "-3.123")
        self.assertEqual(normalized["available"], "-4.1")
        self.assertEqual(normalized["frozen"], "-0.00")

    def test_duplicate_currency_rejected_for_both_scopes(self):
        self.assert_error(lambda: reader.normalize_funding([FUNDING[0], FUNDING[0]]), "invalid_response")
        self.assert_error(lambda: reader.normalize_trading([{"totalEq": "0", "details": [TRADING[0]["details"][0]] * 2}]), "invalid_response")

    def test_currency_injection_rejected(self):
        for value in ["<script>", "BTC\n", "btc", None, 123, "A" * 33]:
            self.assert_error(lambda: reader.normalize_funding([{"ccy": value, "bal": "1"}]), "invalid_response")

    def test_balance_shapes_must_be_exact(self):
        for data in [None, {}, [], [None], [{}, {}], [{"totalEq": "0", "details": None}]]:
            self.assert_error(lambda: reader.normalize_trading(data), "invalid_response")
        for data in [None, {}, [None]]:
            self.assert_error(lambda: reader.normalize_funding(data), "invalid_response")

    def test_bad_timestamp_rejected(self):
        for value in [1234, "123.4", "-123", True, "x", "1" * 17]:
            account, _ = client([body([{"ts": value}])])
            self.assert_error(account.read_account, "invalid_response")

    def test_implausible_server_time_rejected(self):
        for value in ["0", "1577836799000", "4102444801000"]:
            account, _ = client([body([{"ts": value}])])
            self.assert_error(account.read_account, "invalid_response")

    def test_authentication_errors_are_safe_and_not_retried(self):
        for provider, expected in [("50105", "passphrase_invalid"), ("50113", "credentials_invalid"),
                                   ("50110", "ip_restricted"), ("50102", "clock_error"),
                                   ("50120", "permission_denied"), ("59999", "provider_error")]:
            account, opener = client([body([{"ts": SERVER_MS}]), body([], provider, msg=CREDENTIALS["secret_key"])])
            self.assert_error(account.read_account, expected)
            self.assertEqual(len(opener.calls), 2)

    def test_provider_rate_limit_safe_and_bounded(self):
        for provider in ["50011", "50040", "50061"]:
            account, opener = client([body([], provider)])
            self.assertEqual(self.assert_error(account.read_account, "rate_limited").status, 429)
            self.assertEqual(len(opener.calls), 1)

    def test_http_errors_discard_raw_message_and_body(self):
        for status, expected in [(301, "redirect_rejected"), (401, "access_denied"),
                                 (403, "access_denied"), (429, "rate_limited"), (503, "http_error")]:
            error = urllib.error.HTTPError("https://private.invalid/" + CREDENTIALS["api_key"],
                status, CREDENTIALS["passphrase"], {}, io.BytesIO(CREDENTIALS["secret_key"].encode()))
            account, opener = client([error])
            self.assert_error(account.read_account, expected)
            self.assertEqual(len(opener.calls), 1)

    def test_network_and_timeout_messages_do_not_leak_exception(self):
        errors = [(socket.timeout(CREDENTIALS["secret_key"]), "timeout"),
                  (urllib.error.URLError(CREDENTIALS["passphrase"]), "network_error"),
                  (OSError(CREDENTIALS["api_key"]), "network_error")]
        for cause, code in errors:
            account, opener = client([cause])
            self.assert_error(account.read_account, code)
            self.assertEqual(len(opener.calls), 1)

    def test_read_timeout_safe(self):
        account, _ = client([Response(socket.timeout(CREDENTIALS["secret_key"]))])
        self.assert_error(account.read_account, "timeout")

    def test_no_redirect_handler_fails_closed_before_destination(self):
        handler = reader._NoRedirect()
        for target in [reader.ORIGIN + reader.TIME_PATH, "http://www.okx.com/", "https://evil.invalid/"]:
            self.assert_error(lambda: handler.redirect_request(None, None, 302, "", {}, target), "redirect_rejected")
        opener = reader._verified_opener()
        self.assertTrue(any(isinstance(item, reader._NoRedirect) for item in opener.handlers))

    def test_redirected_or_redirect_status_response_rejected(self):
        for response in [Response(body([]), url="https://evil.invalid/"), Response(body([]), status=302)]:
            account, _ = client([response])
            self.assert_error(account.read_account, "redirect_rejected")

    def test_invalid_json_duplicate_keys_and_nonfinite_json_rejected(self):
        for raw in [b"not-json", b"\xff", b'{"code":"0","code":"1","data":[]}',
                    b'{"code":"0","data":[],"x":NaN}', b'[]', b'{"code":0,"data":[]}',
                    b'{"code":"0","data":{}}']:
            account, _ = client([raw])
            self.assert_error(account.read_account, "invalid_response")

    def test_oversized_response_rejected(self):
        account, _ = client([b" " * (reader.MAX_RESPONSE_BYTES + 1)])
        self.assert_error(account.read_account, "invalid_response")

    def test_whole_operation_deadline_stops_additional_requests(self):
        ticks = iter([0.0, 0.0, 0.0, 29.0])
        account, opener = client(monotonic=lambda: next(ticks))
        self.assert_error(account.read_account, "timeout")
        self.assertEqual(len(opener.calls), 1)

    def test_slow_drip_response_obeys_total_deadline_and_uses_read1(self):
        now = [100.0]
        class SlowResponse(Response):
            def read(self, count):
                raise AssertionError('unbounded aggregate read must not be used')

            def read1(self, count):
                now[0] += 7
                return b' '
        account, opener = client([SlowResponse(b'')], monotonic=lambda: now[0])
        self.assert_error(account.read_account, 'timeout')
        self.assertEqual(now[0], 128)
        self.assertEqual(len(opener.calls), 1)

    def test_body_socket_timeout_shrinks_with_remaining_deadline(self):
        class Sock:
            def __init__(self):
                self.values = []
            def settimeout(self, value):
                self.values.append(value)
        class Box:
            pass
        response = Response(b'ok')
        response.fp = Box()
        response.fp.raw = Box()
        response.fp.raw._sock = Sock()
        self.assertEqual(reader._read_body(response, 102, lambda: 100), b'ok')
        self.assertEqual(response.fp.raw._sock.values, [2, 2])

    def test_remaining_deadline_bounds_socket_timeout(self):
        account, opener = client()
        account._request(reader.TIME_PATH, False, 101.25)
        self.assertEqual(opener.calls[0][1], 1.25)
        self.assert_error(lambda: account._request(reader.TIME_PATH, False, 99.0), "timeout")
        self.assertEqual(len(opener.calls), 1)

    def test_bad_final_scope_does_not_return_partial_snapshot(self):
        account, opener = client(responses(funding=[{"ccy": "BTC", "bal": "garbled"}]))
        self.assert_error(account.read_account, "invalid_response")
        self.assertEqual(len(opener.calls), 4)

    def test_credential_input_is_copied_and_header_injection_rejected(self):
        supplied = dict(CREDENTIALS)
        account = reader.OKXReadOnlyClient(supplied, opener=Opener(responses()), clock=lambda: NOW, monotonic=lambda: 100)
        supplied["api_key"] = "mutated"
        account.read_account()
        headers = dict((k.lower(), v) for k, v in account._opener.calls[1][0].header_items())
        self.assertEqual(headers["ok-access-key"], CREDENTIALS["api_key"])
        for key in CREDENTIALS:
            bad = dict(CREDENTIALS, **{key: "bad\r\nHeader:injected"})
            self.assert_error(lambda: reader.OKXReadOnlyClient(bad), "credentials_missing")

    def test_credentials_require_all_three_fields(self):
        for supplied in [None, {}, {"api_key": "key", "secret_key": "secret"}, dict(CREDENTIALS, passphrase="")]:
            self.assert_error(lambda: reader.OKXReadOnlyClient(supplied), "credentials_missing")

    def test_timeout_configuration_is_bounded(self):
        for value in [0, -1, 9, float("nan"), True, "8"]:
            with self.assertRaises(ValueError):
                reader.OKXReadOnlyClient(CREDENTIALS, timeout=value)

    def test_optional_public_btc_ticker_has_no_auth_and_keeps_usdt_unit(self):
        account, opener = client([body([{"instId": "BTC-USDT", "last": "80000.123456789", "ts": SERVER_MS}])])
        self.assertEqual(account.get_btc_price(), {"price_usdt": "80000.123456789", "timestamp_ms": SERVER_MS})
        request = opener.calls[0][0]
        self.assertEqual(request.full_url, reader.ORIGIN + reader.BTC_PRICE_PATH)
        self.assertFalse(any(k.lower().startswith("ok-access-") for k, _ in request.header_items()))

    def test_bad_public_ticker_rejected(self):
        for row in [{"instId": "BTC-USDT", "last": "0", "ts": SERVER_MS},
                    {"instId": "BTC-USD", "last": "80000", "ts": SERVER_MS}]:
            account, _ = client([body([row])])
            self.assert_error(account.get_btc_price, "invalid_response")


class HistoryReaderTests(unittest.TestCase):
    def history_client(self, pages=None, trading=None, funding=None, config=None):
        trading = [{"totalEq": "100", "details": [{"ccy": "BTC", "eq": "0.19",
                    "cashBal": "0.15", "liab": "0", "upl": "0.04"}]}] if trading is None else trading
        funding = [{"ccy": "BTC", "bal": "0.02"}] if funding is None else funding
        responses_list = responses(config=config, trading=trading, funding=funding)
        responses_list += [body(rows) for rows in (pages if pages is not None else [[], [], []])]
        pauses = []
        account, opener = client(responses_list, sleeper=pauses.append)
        return account, opener, pauses

    def bill(self, identifier, delta, balance, offset=-1000, **extra):
        row = {"billId": str(identifier), "ts": str(int(SERVER_MS) + offset),
               "ccy": "BTC", "type": "2", "balChg": delta, "bal": balance}
        row.update(extra)
        return row

    def read(self, account, start=None, end=None):
        return account.read_btc_history(int(SERVER_MS) - 86400000 if start is None else start,
                                       int(SERVER_MS) if end is None else end)

    def assert_error(self, callback, code):
        with self.assertRaises(reader.OKXReadError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)
        for value in CREDENTIALS.values():
            self.assertNotIn(value, str(caught.exception))

    def test_empty_exhausted_history_valid_and_does_not_use_equity(self):
        account, opener, _ = self.history_client()
        result = self.read(account)
        self.assertTrue(result["complete"])
        self.assertEqual(result["closing_balances"], {"trading": "0.15", "funding": "0.02"})
        self.assertEqual(result["events"], [])
        self.assertEqual(len(opener.calls), 7)
        self.assertEqual(result["coverage_end_ms"], int(SERVER_MS))

    def test_fresh_funding_bridge_merges_archive_duplicate_once(self):
        trading = self.bill("15", "0.01", "0.15")
        funding = self.bill("20", "0.02", "0.02", type="1")
        account, opener, _ = self.history_client([[trading], [funding], [funding]])
        result = self.read(account)
        self.assertTrue(result["complete"])
        self.assertEqual(len(result["events"]), 2)
        self.assertEqual({event["account"] for event in result["events"]}, {"trading", "funding"})
        self.assertTrue(all(request.get_method() == "GET" and request.data is None for request, _ in opener.calls))

    def test_funding_archive_lag_can_be_filled_from_recent_bills(self):
        old = self.bill("20", "0.01", "0.01", offset=-2000, type="1")
        latest = self.bill("21", "0.01", "0.02", type="1")
        account, _, _ = self.history_client([[], [old], [latest, old]])
        result = self.read(account)
        self.assertTrue(result["complete"])
        self.assertEqual([row["id"] for row in result["events"]], ["20", "21"])

    def test_conflicting_duplicate_rejected(self):
        old = self.bill("20", "0.02", "0.02", type="1")
        altered = dict(old, balChg="0.03")
        account, _, _ = self.history_client([[], [old], [altered]])
        self.assert_error(lambda: self.read(account), "history_invalid")

    def test_read_only_guard_before_cash_and_bills(self):
        account, opener, _ = self.history_client(config=[{"perm": "read_only,trade"}])
        self.assert_error(lambda: self.read(account), "read_only_required")
        self.assertEqual(len(opener.calls), 2)
        account, opener, _ = self.history_client(config=[{}])
        self.assert_error(lambda: self.read(account), "permissions_unverified")
        self.assertEqual(len(opener.calls), 2)

    def test_dynamic_endpoints_are_strictly_fixed_filtered_signed_get(self):
        account, opener, _ = self.history_client()
        self.read(account)
        for request, _ in opener.calls[4:]:
            headers = dict((key.lower(), value) for key, value in request.header_items())
            path = request.full_url[len(reader.ORIGIN):]
            self.assertTrue(reader._history_path_allowed(path))
            expected = base64.b64encode(hmac.new(CREDENTIALS["secret_key"].encode(),
                (headers["ok-access-timestamp"] + "GET" + path).encode(), hashlib.sha256).digest()).decode()
            self.assertEqual(headers["ok-access-sign"], expected)
        for path in ["/api/v5/trade/order?ccy=BTC&limit=100",
                     reader.TRADING_BILLS_PATH + "?ccy=ETH&limit=100&begin=1&end=2",
                     reader.FUNDING_BILLS_PATH + "?ccy=BTC&limit=100&after=1&pagingType=2&url=https://evil.invalid",
                     reader.FUNDING_BILLS_PATH + "?ccy=BTC&limit=100&after=1&pagingType=2&after=2",
                     reader.FUNDING_BILLS_PATH + "?ccy=BTC&limit=100&after=x&pagingType=2",
                     reader.FUNDING_BILLS_PATH + "?ccy=BTC&limit=100&after=1&pagingType=3"]:
            self.assert_error(lambda: account._request(path, True, 999), "endpoint_rejected")

    def test_invalid_window_before_any_requests(self):
        for start, end in [(True, int(SERVER_MS)), (int(SERVER_MS), 0),
                           (int(SERVER_MS) + 1000, int(SERVER_MS))]:
            account, opener, _ = self.history_client()
            self.assert_error(lambda: account.read_btc_history(start, end), "history_invalid")
            self.assertEqual(opener.calls, [])

    def test_three_calendar_month_limit_returns_real_coverage(self):
        account, _, _ = self.history_client()
        requested = int(SERVER_MS) - 120 * 86400000
        result = self.read(account, start=requested)
        self.assertGreater(result["coverage_start_ms"], requested)
        self.assertEqual(result["requested_start_ms"], requested)
        self.assertLess(result["coverage_start_ms"], result["coverage_end_ms"])

    def test_bill_pagination_same_millisecond_preserves_bill_id(self):
        rows = [self.bill(str(1000 - index), "0", "0.15") for index in range(100)]
        account, opener, pauses = self.history_client([rows, [], [], []])
        result = self.read(account)
        self.assertTrue(result["complete"])
        self.assertEqual(len(result["events"]), 100)
        next_path = opener.calls[5][0].full_url
        self.assertIn("after=901", next_path)
        self.assertEqual(pauses, [0.45])

    def test_funding_history_uses_bill_id_pagination_from_first_page(self):
        rows = [self.bill(str(1000 - index), "0", "0.02", type="1") for index in range(100)]
        account, opener, pauses = self.history_client([[], rows, [], []])
        result = self.read(account)
        self.assertTrue(result["complete"])
        first = opener.calls[5][0].full_url
        next_path = opener.calls[6][0].full_url
        self.assertIn("pagingType=2", first)
        self.assertNotIn("after=", first)
        self.assertIn("pagingType=2", next_path)
        self.assertIn("after=901", next_path)
        self.assertEqual(pauses, [1.05])

    def test_page_limit_remains_honestly_incomplete(self):
        rows = [self.bill(str(1000 - index), "0", "0.15") for index in range(100)]
        account, _, _ = self.history_client([rows, [], []])
        with patch.object(reader, "HISTORY_MAX_PAGES", 1):
            result = self.read(account)
        self.assertFalse(result["complete"])
        self.assertEqual(result["reason"], "page_limit")

    def test_recent_full_page_not_silently_timestamp_skipped(self):
        rows = [self.bill(str(1000 - index), "0", "0.02", type="1") for index in range(100)]
        account, _, _ = self.history_client([[], [], rows])
        result = self.read(account)
        self.assertFalse(result["complete"])
        self.assertEqual(result["reason"], "recent_page_saturated")

    def test_nonprogressing_or_unordered_history_rejected(self):
        for rows in [[self.bill("1", "0", "0.15", offset=-2000), self.bill("2", "0", "0.15")],
                     [self.bill("1", "0", "0.15"), self.bill("1", "0", "0.15")]]:
            account, _, _ = self.history_client([rows, [], []])
            self.assert_error(lambda: self.read(account), "history_invalid")

    def test_funding_same_millisecond_rows_in_ascending_id_order_are_valid(self):
        # Live provider behaviour: ts desc but tie IDs ascend.  Balances still
        # describe bill-ID settlement order, so normalization must sort ties.
        older = self.bill("40", "0.01", "0.01", type="1")
        newer = self.bill("41", "0.01", "0.02", type="1")
        account, _, _ = self.history_client([[], [older, newer], [older, newer]])
        result = self.read(account)
        self.assertTrue(result["complete"])
        self.assertEqual([row["id"] for row in result["events"]], ["40", "41"])

    def test_funding_unbounded_first_page_filters_post_anchor_events(self):
        newer = self.bill("30", "0.01", "0.03", offset=1000, type="1")
        current = self.bill("29", "0.02", "0.02", type="1")
        account, _, _ = self.history_client([[], [newer, current], [current]])
        result = self.read(account)
        self.assertTrue(result["complete"])
        self.assertEqual([row["id"] for row in result["events"]], ["29"])

    def test_unknown_debt_and_nonzero_debt_cannot_generate_net_history(self):
        for debt, expected in [("", "history_invalid"), ("0.02", None)]:
            trading = [{"totalEq": "100", "details": [{"ccy": "BTC", "cashBal": "0.15", "liab": debt}]}]
            account, _, _ = self.history_client(trading=trading)
            if expected:
                self.assert_error(lambda: self.read(account), expected)
            else:
                result = self.read(account)
                self.assertFalse(result["complete"])
                self.assertEqual(result["reason"], "unsupported_debt_history")

    def test_provider_raw_fields_and_notes_not_exposed(self):
        row = self.bill("1", "0.01", "0.15", notes="private-wallet-address", ordId="private-order-id")
        account, _, _ = self.history_client([[row], [], []])
        encoded = json.dumps(self.read(account))
        self.assertNotIn("private-wallet-address", encoded)
        self.assertNotIn("private-order-id", encoded)
        for value in CREDENTIALS.values():
            self.assertNotIn(value, encoded)


class PortfolioValuationTests(unittest.TestCase):
    def account(self, rows=None, funding=None):
        rows = [{"ccy": "BTC", "eq": "1.1", "eqUsd": "88000", "cashBal": "1", "liab": "0.1", "upl": "0.1"},
                {"ccy": "USDT", "eq": "100", "eqUsd": "99.8", "cashBal": "100", "liab": "0"}] if rows is None else rows
        funding = [{"ccy": "BTC", "bal": "0.2"}, {"ccy": "DOGE", "bal": "10"}] if funding is None else funding
        return {"trading": reader.normalize_trading([{"totalEq": "88099.8", "details": rows}]),
                "funding": reader.normalize_funding(funding), "server_time_ms": SERVER_MS,
                "observed_at": "2025-10-09T00:00:00Z"}

    def ticker(self, inst="DOGE-USDT", price="0.2", at=SERVER_MS):
        return {"instId": inst, "last": price, "ts": at}

    def test_cash_net_debt_quantity_and_derivative_upl_excluded(self):
        result = reader.value_cash_assets(self.account())
        btc = next(row for row in result["assets"] if row["ccy"] == "BTC")
        self.assertEqual(btc["quantity"], "1.1")  # cash1 - debt.1 + funding.2
        self.assertEqual(btc["trading_quantity"], "0.9")
        self.assertEqual(btc["usd_value"], "88000")
        self.assertNotIn("unrealized_pnl", btc)
        self.assertIn("unrealized_derivative_pnl", result["scope"]["excluded"])

    def test_funding_only_asset_uses_one_spot_snapshot_and_real_usdt_usd(self):
        result = reader.value_cash_assets(self.account(), [self.ticker()])
        doge = next(row for row in result["assets"] if row["ccy"] == "DOGE")
        self.assertEqual(doge["usd_value"], "1.9960")
        self.assertEqual(doge["price_usd"], "0.1996")
        self.assertEqual(doge["price_source"], "OKX_SPOT_USDT_x_observed_USDT_USD")
        self.assertTrue(result["complete"])
        self.assertIsNotNone(result["total_value_usd"])

    def test_stablecoins_not_assumed_one_usd(self):
        result = reader.value_cash_assets(self.account(rows=[], funding=[{"ccy": "USDT", "bal": "100"}, {"ccy": "USDC", "bal": "10"}]),
                                         [self.ticker("USDC-USDT", "1")])
        self.assertTrue(all(row["usd_value"] is None for row in result["assets"]))
        self.assertFalse(result["complete"])
        self.assertIsNone(result["total_value_usd"])
        self.assertEqual(result["known_value_usd"], "0")

    def test_zero_equity_does_not_invent_unit_price(self):
        row = {"ccy": "BTC", "eq": "0", "eqUsd": "0", "cashBal": "0.1", "liab": "0"}
        result = reader.value_cash_assets(self.account(rows=[row], funding=[]))
        self.assertEqual(result["assets"][0]["quantity"], "0.1")
        self.assertIsNone(result["assets"][0]["usd_value"])

    def test_unknown_cash_or_debt_stays_unknown(self):
        for missing in ["cashBal", "liab"]:
            row = {"ccy": "BTC", "eq": "1", "eqUsd": "80000", "cashBal": "1", "liab": "0"}
            row.pop(missing)
            result = reader.value_cash_assets(self.account(rows=[row], funding=[]))
            self.assertIsNone(result["assets"][0]["quantity"])
            self.assertIsNone(result["assets"][0]["usd_value"])
            self.assertFalse(result["complete"])

    def test_negative_debt_adjusted_holdings_not_hidden_or_absed(self):
        row = {"ccy": "BTC", "eq": "1", "eqUsd": "80000", "cashBal": "0.1", "liab": "0.2"}
        result = reader.value_cash_assets(self.account(rows=[row], funding=[]))
        self.assertEqual(result["assets"][0]["quantity"], "-0.1")
        self.assertEqual(result["assets"][0]["usd_value"], "-8000.0")

    def test_zero_holdings_can_be_zero_without_a_price(self):
        result = reader.value_cash_assets(self.account(rows=[], funding=[{"ccy": "DOGE", "bal": "0"}]))
        self.assertEqual(result["assets"][0]["usd_value"], "0")
        self.assertIsNone(result["assets"][0]["price_usd"])
        self.assertTrue(result["complete"])

    def test_duplicate_public_tickers_cannot_select_an_arbitrary_price(self):
        result = reader.value_cash_assets(self.account(), [self.ticker(), self.ticker(price="100")])
        doge = next(row for row in result["assets"] if row["ccy"] == "DOGE")
        self.assertIsNone(doge["usd_value"])

    def test_invalid_or_stale_public_quotes_remain_unpriced(self):
        for row in [self.ticker(price="NaN"), self.ticker(price="0"), self.ticker(price="-1"),
                    self.ticker(at=str(int(SERVER_MS) - 120001)), self.ticker(at=str(int(SERVER_MS) + 5001)),
                    self.ticker(at="garbled")]:
            result = reader.value_cash_assets(self.account(), [row])
            doge = next(item for item in result["assets"] if item["ccy"] == "DOGE")
            self.assertIsNone(doge["usd_value"])

    def test_quote_freshness_uses_response_clock_after_slow_private_reads(self):
        later_ms = int(SERVER_MS) + 15000
        result = reader.value_cash_assets(self.account(), [self.ticker(at=str(later_ms))],
                                         price_reference_ms=later_ms)
        doge = next(item for item in result["assets"] if item["ccy"] == "DOGE")
        self.assertIsNotNone(doge["usd_value"])

    def test_usd_is_calculation_unit_not_stablecoin_peg(self):
        result = reader.value_cash_assets(self.account(rows=[], funding=[{"ccy": "USD", "bal": "10"}]))
        self.assertEqual(result["assets"][0]["usd_value"], "10")
        self.assertEqual(result["assets"][0]["price_source"], "USD_unit")

    def test_live_method_keeps_original_read_account_requests_and_one_public_fallback(self):
        raw_trading = [{"totalEq": "100", "details": [{"ccy": "USDT", "cashBal": "100", "liab": "0", "eq": "100", "eqUsd": "99.8"}]}]
        raw_funding = [{"ccy": "DOGE", "bal": "10"}]
        items = responses(trading=raw_trading, funding=raw_funding) + [body([self.ticker()])]
        account, opener = client(items)
        result = account.read_valued_assets()
        self.assertTrue(result["complete"])
        self.assertEqual(len(opener.calls), 5)
        request = opener.calls[-1][0]
        self.assertEqual(request.full_url, reader.ORIGIN + reader.SPOT_TICKERS_PATH)
        self.assertFalse(any(key.lower().startswith("ok-access-") for key, _ in request.header_items()))

    def test_public_quote_failure_keeps_known_values_and_marks_unknown(self):
        items = responses() + [urllib.error.URLError("private-secret-error")]
        account, opener = client(items)
        result = account.read_valued_assets()
        self.assertFalse(result["complete"])
        self.assertEqual(result["price_error"]["code"], "network_error")
        self.assertNotIn("private-secret-error", json.dumps(result))
        self.assertIsNone(next(row for row in result["assets"] if row["ccy"] == "ETH")["usd_value"])

    def test_no_public_fallback_when_all_assets_have_observed_prices(self):
        trading = [{"totalEq": "100", "details": [{"ccy": "USDT", "cashBal": "100", "liab": "0", "eq": "100", "eqUsd": "99.8"}]}]
        account, opener = client(responses(trading=trading, funding=[]))
        result = account.read_valued_assets()
        self.assertTrue(result["complete"])
        self.assertEqual(len(opener.calls), 4)

    def test_new_portfolio_method_requires_verified_read_only_permission(self):
        account, _ = client(responses(config=[{}]))
        with self.assertRaises(reader.OKXReadError) as caught:
            account.read_valued_assets()
        self.assertEqual(caught.exception.code, "permissions_unverified")


if __name__ == "__main__":
    unittest.main()
