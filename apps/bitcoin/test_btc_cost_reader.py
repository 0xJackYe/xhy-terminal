"""Offline transport tests: synthetic credentials and financial records only."""

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
import urllib.parse

import btc_cost_reader as reader


CREDENTIALS = {"api_key": "fixture-key", "secret_key": "fixture-secret",
               "passphrase": "fixture-passphrase"}
SERVER_MS = 1792972800123  # 2026-10-26 UTC.
START_MS = SERVER_MS - 2 * 86400000


def payload(data, code="0", **extra):
    return json.dumps({"code": code, "data": data, **extra}).encode()


def bill(identifier="1000", ts=SERVER_MS - 1000, ccy="BTC", **changes):
    row = {"billId": str(identifier), "ts": str(ts), "instType": "SPOT",
           "ccy": ccy, "instId": "BTC-USDT", "subType": "1",
           "sz": "0.000025", "px": "80000", "fee": "-0.000000025",
           "balChg": "0.000024975", "ordId": "800", "tradeId": "700"}
    row.update(changes)
    return row


class Clock:
    def __init__(self):
        self.seconds = 100.0
        self.sleeps = []

    def wall(self):
        return SERVER_MS / 1000 + self.seconds - 100

    def mono(self):
        return self.seconds

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.seconds += seconds


class Response:
    def __init__(self, content, status=200, url=None):
        self.content, self.status, self.url = content, status, url
        self.offset, self.closed = 0, False

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        self.closed = True

    def geturl(self):
        return self.url

    def getcode(self):
        return self.status

    def read(self, count):
        if isinstance(self.content, Exception):
            raise self.content
        result = self.content[self.offset:self.offset + count]
        self.offset += len(result)
        return result


class Opener:
    def __init__(self, results, clock):
        self.results, self.clock = list(results), clock
        self.calls, self.closed = [], False

    def open(self, request, timeout):
        self.calls.append((request, timeout, self.clock.mono()))
        if not self.results:
            raise AssertionError("unexpected request")
        item = self.results.pop(0)
        if isinstance(item, Exception):
            raise item
        response = item if isinstance(item, Response) else Response(item)
        if response.url is None:
            response.url = request.full_url
        return response

    def close(self):
        self.closed = True


def make(pages=None, config=None, results=None, **options):
    clock = Clock()
    if results is None:
        results = [payload([{"ts": str(SERVER_MS)}]),
                   payload([{"perm": "read_only"}] if config is None else config)]
        results += [payload(rows) for rows in ([[]] if pages is None else pages)]
    opener = Opener(results, clock)
    supplied = {"clock": clock.wall, "monotonic": clock.mono, "sleeper": clock.sleep}
    supplied.update(options)
    client = reader.BTCCostReader(CREDENTIALS, opener=opener, **supplied)
    return client, opener, clock


class BTCCostReaderTests(unittest.TestCase):
    def safe_error(self, callback, code):
        with self.assertRaises(reader.OKXReadError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(str(caught.exception), caught.exception.message)
        for secret in CREDENTIALS.values():
            self.assertNotIn(secret, str(caught.exception))
        return caught.exception

    def test_complete_empty_interval_has_frozen_server_anchor(self):
        client, opener, unused = make()
        result = client.read_since(START_MS)
        self.assertEqual(result, {"rows": [], "as_of_ms": SERVER_MS,
                                  "coverage_start_ms": START_MS, "complete": True})
        self.assertEqual(len(opener.calls), 3)

    def test_all_currency_legs_preserved_with_decimal_strings(self):
        btc = bill("1001")
        quote = bill("1000", ccy="USDT", subType="2", sz="2", fee="0", balChg="-2")
        client, unused, unused_clock = make([[btc, quote]])
        rows = client.read_since(START_MS)["rows"]
        self.assertEqual(rows, [btc, quote])
        self.assertIsInstance(rows[0]["sz"], str)
        self.assertEqual(rows[1]["ccy"], "USDT")

    def test_convert_and_cross_currency_pairs_preserved(self):
        btc = bill("1001", instId="ETH-BTC-CONVERT", subType="318", px="0.03")
        eth = bill("1000", ccy="ETH", instId="ETH-BTC-CONVERT", subType="319", fee="0")
        client, unused, unused_clock = make([[btc, eth]])
        self.assertEqual(client.read_since(START_MS)["rows"], [btc, eth])

    def test_private_notes_and_account_identity_are_not_returned(self):
        raw = bill(notes="private-address", tag="private-label", uid="private-id", clOrdId="private-reference")
        client, unused, unused_clock = make([[raw]], config=[{"perm": "read_only", "uid": "private-id"}])
        result = json.dumps(client.read_since(START_MS))
        self.assertNotIn("private-", result)

    def test_signatures_get_only_exact_path_and_no_url_credentials(self):
        client, opener, unused = make()
        client.read_since(START_MS)
        for index, (request, timeout, unused_at) in enumerate(opener.calls):
            self.assertEqual(request.get_method(), "GET")
            self.assertIsNone(request.data)
            self.assertTrue(request.full_url.startswith(reader.ORIGIN + "/api/v5/"))
            self.assertLessEqual(timeout, reader.SOCKET_TIMEOUT)
            for secret in CREDENTIALS.values():
                self.assertNotIn(secret, request.full_url)
            headers = {k.lower(): v for k, v in request.header_items()}
            if index == 0:
                self.assertFalse(any(k.startswith("ok-access-") for k in headers))
            else:
                path = request.full_url[len(reader.ORIGIN):]
                expected = base64.b64encode(hmac.new(CREDENTIALS["secret_key"].encode(),
                    (headers["ok-access-timestamp"] + "GET" + path).encode(), hashlib.sha256).digest()).decode()
                self.assertEqual(headers["ok-access-sign"], expected)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(opener.calls[-1][0].full_url).query)
        self.assertEqual(query, {"instType": ["SPOT"], "limit": ["100"],
                                "begin": [str(START_MS)], "end": [str(SERVER_MS)]})

    def test_route_allowlist_rejects_arbitrary_or_malformed_queries(self):
        client, opener, unused = make()
        valid = reader.BILLS_PATH + f"?instType=SPOT&begin={START_MS}&end={SERVER_MS}&limit=100"
        rejected = [("https://evil.invalid", True), (reader.TIME_PATH, True),
                    (reader.CONFIG_PATH, False), ("/api/v5/trade/order", True),
                    (valid.replace("SPOT", "SWAP"), True),
                    (valid + "&ccy=BTC", True), (valid + "&after=1&after=2", True),
                    (valid + "&after=0", True), (valid + "&after=x", True),
                    (valid + "&url=https://evil.invalid", True),
                    (valid.replace("limit=100", "limit=10"), True),
                    (valid.replace(f"begin={START_MS}", "begin=9999999999999"), True),
                    (valid, False)]
        for path, authenticated in rejected:
            self.safe_error(lambda: client._request(path, authenticated, 200), "endpoint_rejected")
        self.assertEqual(opener.calls, [])

    def test_permissions_must_be_verified_read_only(self):
        for config, code in [([{}], "permissions_unverified"),
                             ([{"perm": ""}], "permissions_unverified"),
                             ([{"perm": "read_only,trade"}], "read_only_required"),
                             ([{"perm": "withdraw"}], "read_only_required")]:
            client, opener, unused = make(config=config)
            self.safe_error(lambda: client.read_since(START_MS), code)
            self.assertEqual(len(opener.calls), 2)

    def test_missing_credentials_or_header_injection_rejected(self):
        for value in [None, {}, {**CREDENTIALS, "api_key": ""},
                      {**CREDENTIALS, "passphrase": "bad\r\nInjected: true"},
                      {**CREDENTIALS, "secret_key": "a" * 257}]:
            self.safe_error(lambda: reader.BTCCostReader(value), "credentials_missing")

    def test_invalid_constructor_limits_rejected(self):
        for key, values in {"timeout": [0, 9, True, float("nan")],
                            "total_timeout": [0, 301, "120", True],
                            "max_pages": [0, 1001, True, 1.5]}.items():
            for value in values:
                with self.assertRaises(ValueError):
                    make(**{key: value})

    def test_invalid_intervals_rejected_before_private_queries(self):
        for value in [0, -1, True, "1", 1.5, 4102444800001]:
            client, opener, unused = make()
            self.safe_error(lambda: client.read_since(value), "invalid_interval")
            self.assertEqual(opener.calls, [])
        client, opener, unused = make()
        self.safe_error(lambda: client.read_since(SERVER_MS + 1), "invalid_interval")
        self.assertEqual(len(opener.calls), 1)

    def test_old_window_is_rejected_not_silently_clamped(self):
        client, opener, unused = make()
        floor = reader._three_month_floor(SERVER_MS)
        self.safe_error(lambda: client.read_since(floor - 1), "outside_history_window")
        self.assertEqual(len(opener.calls), 1)
        client, unused_opener, unused_clock = make()
        self.assertEqual(client.read_since(floor)["coverage_start_ms"], floor)

    def test_calendar_month_floor_clamps_end_of_month(self):
        anchor = int(dt.datetime(2026, 5, 31, 12, 30, tzinfo=dt.timezone.utc).timestamp() * 1000)
        expected = int(dt.datetime(2026, 2, 28, 12, 30, tzinfo=dt.timezone.utc).timestamp() * 1000)
        self.assertEqual(reader._three_month_floor(anchor), expected)

    def test_bill_id_pagination_preserves_same_millisecond_complete_pair(self):
        first = [bill(2000 - index) for index in range(100)]
        final = [bill("1900", ccy="USDT", subType="2", sz="2", fee="0", balChg="-2")]
        client, opener, unused = make([first, final])
        result = client.read_since(START_MS)
        self.assertEqual(len(result["rows"]), 101)
        self.assertIn("after=1901", opener.calls[-1][0].full_url)
        for request, unused_timeout, unused_at in opener.calls[2:]:
            self.assertIn(f"end={SERVER_MS}", request.full_url)

    def test_full_final_page_requires_exhaustion_probe(self):
        rows = [bill(2000 - index) for index in range(100)]
        client, opener, unused = make([rows, []])
        self.assertEqual(len(client.read_since(START_MS)["rows"]), 100)
        self.assertEqual(len(opener.calls), 4)

    def test_duplicate_reverse_ids_and_future_time_rejected(self):
        for rows in [[bill("1000"), bill("1000")], [bill("1000"), bill("1001")],
                     [bill("1001"), bill("1000", ts=SERVER_MS + 1)],
                     [bill("1001"), bill("1000", ts=START_MS - 1)],
                     [bill("1001", ts=SERVER_MS - 2000), bill("1000")]]:
            client, unused, unused_clock = make([rows])
            self.safe_error(lambda: client.read_since(START_MS), "history_invalid")

    def test_nonprogressing_second_page_does_not_return_partial_rows(self):
        first = [bill(2000 - index) for index in range(100)]
        for tail in [[bill("1901")], [bill("2500")]]:
            client, unused, unused_clock = make([first, tail])
            self.safe_error(lambda: client.read_since(START_MS), "history_invalid")

    def test_page_limit_does_not_publish_incomplete_ledger(self):
        client, unused, unused_clock = make([[bill(2000 - index) for index in range(100)]], max_pages=1)
        self.safe_error(lambda: client.read_since(START_MS), "page_limit")

    def test_oversized_page_or_wrong_scope_rejected(self):
        for rows in [[bill(2000 - index) for index in range(101)],
                     [bill(instType="SWAP")], [None], [bill(billId="bad")],
                     [bill(ts=None)], [bill(sz="NaN")], [bill(fee=None)],
                     [bill(ccy="<script>")], [bill(ordId="../")]]:
            client, unused, unused_clock = make([rows])
            self.safe_error(lambda: client.read_since(START_MS), "history_invalid")

    def test_invalid_payload_shapes_and_duplicate_json_keys_rejected(self):
        for raw in [b"not json", b"\xff", b'{"code":"0","code":"0","data":[]}',
                    b'{"code":"0","data":[],"x":NaN}', b'[]',
                    b'{"code":0,"data":[]}', b'{"code":"0","data":{}}']:
            client, unused, unused_clock = make(results=[raw])
            self.safe_error(lambda: client.read_since(START_MS), "history_invalid")

    def test_response_size_cap_and_cleanup(self):
        response = Response(b" " * (1024 * 1024 + 1))
        client, unused, unused_clock = make(results=[response])
        self.safe_error(lambda: client.read_since(START_MS), "invalid_response")
        self.assertTrue(response.closed)

    def test_network_retry_has_backoff_and_safe_error(self):
        start = payload([{"ts": str(SERVER_MS)}])
        for failure in [urllib.error.URLError("fixture-secret"), socket.timeout("fixture-secret")]:
            client, opener, clock = make(results=[failure, start, payload([{"perm": "read_only"}]), payload([])])
            self.assertTrue(client.read_since(START_MS)["complete"])
            self.assertEqual(len(opener.calls), 4)
            self.assertIn(0.5, clock.sleeps)
        client, opener, unused = make(results=[OSError("fixture-key"), OSError("fixture-secret")])
        self.safe_error(lambda: client.read_since(START_MS), "network_error")
        self.assertEqual(len(opener.calls), 2)

    def test_auth_failures_are_not_retried(self):
        for code, expected in [("50105", "passphrase_invalid"), ("50113", "credentials_invalid"),
                               ("50110", "ip_restricted"), ("50120", "permission_denied")]:
            client, opener, unused = make(results=[payload([{"ts": str(SERVER_MS)}]),
                                                   payload([], code, msg="fixture-secret")])
            self.safe_error(lambda: client.read_since(START_MS), expected)
            self.assertEqual(len(opener.calls), 2)

    def test_clock_error_resyncs_once_then_retries_same_query(self):
        client, opener, unused = make(results=[payload([{"ts": str(SERVER_MS)}]),
            payload([{"perm": "read_only"}]), payload([], "50102"),
            payload([{"ts": str(SERVER_MS + 1000)}]), payload([])])
        result = client.read_since(START_MS)
        self.assertEqual(result["as_of_ms"], SERVER_MS)
        self.assertEqual(opener.calls[2][0].full_url, opener.calls[4][0].full_url)
        client, opener, unused = make(results=[payload([{"ts": str(SERVER_MS)}]),
            payload([], "50102"), payload([{"ts": str(SERVER_MS)}]), payload([], "50102")])
        self.safe_error(lambda: client.read_since(START_MS), "clock_error")
        self.assertEqual(len(opener.calls), 4)

    def test_rate_limits_backoff_twice_and_stay_bounded(self):
        client, opener, clock = make(results=[payload([], "50011")] * 3)
        self.safe_error(lambda: client.read_since(START_MS), "rate_limited")
        self.assertEqual(len(opener.calls), 3)
        self.assertEqual(clock.sleeps, [1.0, 2.0])

    def test_http_errors_suppress_body_and_close_http_error(self):
        for status, code in [(302, "redirect_rejected"), (401, "access_denied"), (403, "access_denied")]:
            fp = io.BytesIO(b"fixture-secret")
            error = urllib.error.HTTPError("https://private.invalid/fixture-key", status,
                                          "fixture-passphrase", {}, fp)
            client, opener, unused = make(results=[error])
            self.safe_error(lambda: client.read_since(START_MS), code)
            self.assertTrue(fp.closed)
            self.assertEqual(len(opener.calls), 1)

    def test_response_redirect_never_follows_or_authenticates_destination(self):
        for response in [Response(payload([]), url="https://evil.invalid"), Response(payload([]), status=302)]:
            client, opener, unused = make(results=[response])
            self.safe_error(lambda: client.read_since(START_MS), "redirect_rejected")
            self.assertEqual(len(opener.calls), 1)
            self.assertTrue(response.closed)

    def test_all_requests_are_spaced_under_provider_rate_limit(self):
        rows = [bill(2000 - index) for index in range(100)]
        client, opener, unused = make([rows, []])
        client.read_since(START_MS)
        starts = [at for unused_request, unused_timeout, at in opener.calls]
        self.assertTrue(all(b - a >= 0.419999 for a, b in zip(starts, starts[1:])))

    def test_total_deadline_stops_retry_and_further_requests(self):
        client, opener, clock = make(total_timeout=0.3)
        self.safe_error(lambda: client.read_since(START_MS), "timeout")
        self.assertEqual(len(opener.calls), 1)
        client, opener, clock = make(results=[socket.timeout("fixture-secret")], total_timeout=0.3)
        self.safe_error(lambda: client.read_since(START_MS), "timeout")
        self.assertEqual(len(opener.calls), 1)

    def test_slow_body_deadline_is_bounded_and_closed(self):
        clock = Clock()
        class SlowResponse(Response):
            def read1(self, count):
                clock.seconds += 7
                return b" "
        response = SlowResponse(b"")
        opener = Opener([response], clock)
        client = reader.BTCCostReader(CREDENTIALS, opener=opener, clock=clock.wall,
            monotonic=clock.mono, sleeper=clock.sleep, total_timeout=5)
        self.safe_error(lambda: client.read_since(START_MS), "timeout")
        self.assertTrue(response.closed)
        self.assertEqual(len(opener.calls), 1)

    def test_close_forgets_owned_credentials_and_is_idempotent(self):
        source = copy.deepcopy(CREDENTIALS)
        client, opener, unused = make()
        client.close()
        client.close()
        self.assertTrue(opener.closed)
        self.assertEqual(client._credentials, {})
        self.assertEqual(source, CREDENTIALS)
        self.safe_error(lambda: client.read_since(START_MS), "closed")
        self.assertEqual(opener.calls, [])

    def test_credentials_are_copied_without_mutating_caller(self):
        supplied = copy.deepcopy(CREDENTIALS)
        clock = Clock()
        opener = Opener([payload([{"ts": str(SERVER_MS)}]), payload([{"perm": "read_only"}]), payload([])], clock)
        client = reader.BTCCostReader(supplied, opener=opener, clock=clock.wall,
            monotonic=clock.mono, sleeper=clock.sleep)
        supplied["api_key"] = "changed"
        client.read_since(START_MS)
        headers = {k.lower(): v for k, v in opener.calls[1][0].header_items()}
        self.assertEqual(headers["ok-access-key"], CREDENTIALS["api_key"])
        client.close()
        self.assertEqual(supplied["secret_key"], CREDENTIALS["secret_key"])


if __name__ == "__main__":
    unittest.main()
