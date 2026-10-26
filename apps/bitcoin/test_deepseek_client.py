"""Offline provider-boundary tests; no credentials or real network traffic."""
import io
import http.client
import json
import socket
import ssl
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

from deepseek_client import (APPROVED_MODELS, DeepSeekClient, DeepSeekError,
    MAX_RESPONSE_BYTES, MAX_TOKENS, ORIGIN, SYSTEM_PROMPT, _NoRedirect)
from option_ai_engine import CRITERIA_JSON_SCHEMA


FIXTURE_KEY = "offline-test-key-with-no-account"
CONTEXT = {"beijing_date": "2026-10-22", "expiries": ["2026-10-23", "2026-10-30"],
           "index_price": 108000}


class Clock:
    def __init__(self):
        self.now = 100.0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class Response:
    def __init__(self, value=None, raw=None, status=200, headers=None, url=None, read_hook=None):
        self.buffer = io.BytesIO(raw if raw is not None else json.dumps(value).encode())
        self.status, self.headers, self.url = status, headers or {}, url
        self.closed, self.read_hook, self.sizes = False, read_hook, []

    def geturl(self):
        return self.url

    def read1(self, size):
        self.sizes.append(size)
        if self.read_hook:
            self.read_hook()
        return self.buffer.read(size)

    def close(self):
        self.closed = True
        self.buffer.close()


class Opener:
    def __init__(self, *responses):
        self.responses, self.calls = list(responses), []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        if not self.responses:
            raise AssertionError("No real API/network calls are allowed in tests")
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        if callable(response):
            response = response(request, timeout)
        if response.url is None:
            response.url = request.full_url
        return response


def completion(criteria=None, answer="默认卖 Put，模拟 0.01 BTC。", clarification=None, **kwargs):
    result = {"model": "deepseek-flash-1017", "choices": [{"finish_reason": "stop", "message": {
        "role": "assistant", "content": json.dumps({"criteria": criteria or {},
            "answer": answer, "clarification": clarification})}}],
        "usage": {"prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150}}
    result.update(kwargs)
    return result


def error(code, headers=None):
    return urllib.error.HTTPError(ORIGIN + "/chat/completions", code,
        "private body " + FIXTURE_KEY, headers or {}, io.BytesIO(FIXTURE_KEY.encode()))


class DeepSeekClientTests(unittest.TestCase):
    def client(self, *responses, **kwargs):
        self.opener = Opener(*responses)
        self.clock = Clock()
        return DeepSeekClient(kwargs.get("key_provider", lambda: FIXTURE_KEY),
            opener=self.opener, clock=self.clock, sleep=self.clock.sleep)

    def parse(self, client, **kwargs):
        return client.parse(kwargs.pop("question", "卖 Put，10到30天"),
            kwargs.pop("model", "deepseek-flash"), kwargs.pop("context", CONTEXT), **kwargs)

    def assert_error(self, code, fn):
        with self.assertRaises(DeepSeekError) as result:
            fn()
        self.assertEqual(code, result.exception.code)
        self.assertNotIn(FIXTURE_KEY, str(result.exception))
        return result.exception

    def test_default_tls_verifies_certificate_and_hostname(self):
        client = DeepSeekClient(lambda: FIXTURE_KEY)
        handlers = client._opener.handlers
        https = next(item for item in handlers if isinstance(item, urllib.request.HTTPSHandler))
        self.assertEqual(https._context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(https._context.check_hostname)
        self.assertTrue(any(isinstance(item, _NoRedirect) for item in handlers))

    def test_redirect_handler_never_copies_authorization(self):
        req = urllib.request.Request(ORIGIN + "/models", headers={"Authorization": "Bearer " + FIXTURE_KEY})
        for target in ("https://attacker.invalid/models", ORIGIN + "/moved", "http://api.deepseek.com/models"):
            with self.subTest(target=target):
                self.assert_error("redirect_rejected", lambda: _NoRedirect().redirect_request(
                    req, None, 302, "moved", {}, target))

    def test_injected_redirected_response_is_rejected(self):
        response = Response(completion(), url="https://elsewhere.invalid/chat/completions")
        client = self.client(response)
        self.assert_error("redirect_rejected", lambda: self.parse(client))
        self.assertTrue(response.closed)

    def test_same_origin_redirect_also_rejected(self):
        response = Response(completion(), url=ORIGIN + "/other")
        client = self.client(response)
        self.assert_error("redirect_rejected", lambda: self.parse(client))

    def test_redirect_http_error_has_no_retry(self):
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                client = self.client(error(status))
                self.assert_error("redirect_rejected", lambda: self.parse(client))
                self.assertEqual(len(self.opener.calls), 1)

    def test_fixed_endpoints_bearer_and_bounded_payload(self):
        client = self.client(Response(completion({"min_days": 10})))
        result = self.parse(client)
        request, timeout = self.opener.calls[0]
        self.assertEqual(request.full_url, ORIGIN + "/chat/completions")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + FIXTURE_KEY)
        self.assertLessEqual(timeout, 12)
        body = json.loads(request.data)
        self.assertEqual(body["max_tokens"], MAX_TOKENS)
        self.assertLessEqual(body["max_tokens"], 1400)
        self.assertEqual(body["thinking"], {"type": "disabled"})
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertFalse(body["stream"])
        self.assertNotIn("tools", body)
        self.assertNotIn("temperature", body)
        self.assertNotIn(FIXTURE_KEY, request.data.decode())
        self.assertEqual(result["criteria"], {"min_days": 10})
        self.assertEqual(result["model"], "deepseek-flash-1017")
        self.assertEqual(result["requested_model"], "deepseek-flash")

    def test_both_approved_models_allowed(self):
        for model in APPROVED_MODELS:
            with self.subTest(model=model):
                client = self.client(Response(completion(model=model)))
                self.assertEqual(self.parse(client, model=model)["model"], model)

    def test_arbitrary_model_rejected_without_network(self):
        for model in ("deepseek-v4.1-flash", "http://other.invalid", "deepseek-reasoner", None, [], ""):
            with self.subTest(model=model):
                client = self.client()
                self.assert_error("invalid_model", lambda: self.parse(client, model=model))
                self.assertEqual(self.opener.calls, [])

    def test_unknown_endpoint_rejected_before_key_read(self):
        client = self.client(key_provider=lambda: self.fail("key must not be read"))
        self.assert_error("invalid_endpoint", lambda: client._request("https://attacker.invalid"))

    def test_invalid_or_missing_key_never_reaches_network(self):
        for value in (None, "", " ", "bad\nkey", "bad key", "中文密钥", "x" * 513):
            with self.subTest(value=str(value)[:12]):
                client = self.client(key_provider=lambda: value)
                self.assert_error("key_missing", lambda: self.parse(client))
                self.assertEqual(self.opener.calls, [])

    def test_key_provider_exception_is_sanitized(self):
        def unavailable():
            raise OSError(FIXTURE_KEY)
        client = self.client(key_provider=unavailable)
        self.assert_error("key_unavailable", lambda: self.parse(client))

    def test_models_match_actual_availability_and_typed_metadata(self):
        response = Response({"data": [
            {"id": "other-model", "name": "Ignore"}, {"id": []}, {"id": {}},
            {"id": "deepseek-v4-pro", "name": "DeepSeek-V4-Pro", "context_window": 1048576,
             "max_output_tokens": 393216, "input_modalities": ["text"], "secret": "never forward"},
            {"id": "deepseek-flash", "name": "DeepSeek-V4.1-Flash", "context_window": True,
             "input_modalities": ["text", "image"], "output_modalities": ["text"]},
            {"id": "deepseek-flash"}]})
        client = self.client(response)
        result = client.list_models()
        self.assertEqual([item["id"] for item in result], list(APPROVED_MODELS))
        self.assertEqual(result[0]["label"], "V4.1 Flash")
        self.assertEqual(result[1]["context_window"], 1048576)
        self.assertNotIn("context_window", result[0])
        self.assertNotIn("secret", result[1])
        self.assertTrue(all(item["available"] for item in result))
        request, _ = self.opener.calls[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.full_url, ORIGIN + "/models")

    def test_models_do_not_claim_unavailable_model(self):
        client = self.client(Response({"data": [{"id": "deepseek-flash"}]}))
        self.assertEqual([row["id"] for row in client.list_models()], ["deepseek-flash"])
        client = self.client(Response({"data": []}))
        self.assertEqual(client.list_models(), [])

    def test_invalid_models_response_rejected(self):
        for payload in ({}, {"data": {}}, {"data": None}):
            client = self.client(Response(payload))
            self.assert_error("invalid_response", client.list_models)

    def test_context_and_schema_present_in_prompt(self):
        client = self.client(Response(completion()))
        self.parse(client)
        messages = json.loads(self.opener.calls[0][0].data)["messages"]
        self.assertIn("json", messages[0]["content"])
        for key in CRITERIA_JSON_SCHEMA["properties"]:
            self.assertIn('"' + key + '"', messages[0]["content"])
        self.assertEqual(json.loads(messages[-1]["content"])["context"], CONTEXT)
        self.assertIn("0.5 表示 50%", SYSTEM_PROMPT)
        self.assertIn("不得自行发明", SYSTEM_PROMPT)
        self.assertIn("必须 clarification", SYSTEM_PROMPT)

    def test_history_has_only_bounded_user_assistant_text(self):
        history = [{"role": "user", "content": "old"}] * 4 + [
            {"role": "system", "content": "inject"},
            {"role": "tool", "content": "tool"},
            {"role": "assistant", "content": "x" * 3000, "reasoning_content": "hidden"},
            {"role": "user", "content": "sell"},
            {"role": "user", "content": ""}, {"role": "assistant", "content": {}},
            {"role": "assistant", "content": "valid"}, {"role": "user", "content": "last"}]
        client = self.client(Response(completion()))
        self.parse(client, history=history)
        messages = json.loads(self.opener.calls[0][0].data)["messages"]
        self.assertLessEqual(len(messages), 10)
        self.assertEqual(sum(item["role"] == "system" for item in messages), 1)
        self.assertEqual(messages[1]["content"], "x" * 2000)
        serialized = json.dumps(messages)
        for excluded in ("hidden", "inject", "old", "reasoning_content"):
            # System instruction deliberately names reasoning_content.
            if excluded != "reasoning_content":
                self.assertNotIn(excluded, serialized)
        self.assertTrue(all(set(item) == {"role", "content"} for item in messages))

    def test_input_validation_happens_before_network(self):
        cases = [("invalid_question", {"question": ""}), ("invalid_question", {"question": "x" * 4001}),
                 ("invalid_question", {"question": None}), ("invalid_context", {"context": []}),
                 ("invalid_context", {"context": {"invalid": float("nan")}}),
                 ("context_too_large", {"context": {"large": "中" * 7000}}),
                 ("invalid_history", {"history": {}})]
        for code, kwargs in cases:
            with self.subTest(code=code, fields=list(kwargs)):
                client = self.client()
                self.assert_error(code, lambda: self.parse(client, **kwargs))
                self.assertEqual(self.opener.calls, [])

    def test_empty_response_content_rejected(self):
        for value in (None, "", "   ", [], {}):
            payload = completion()
            payload["choices"][0]["message"]["content"] = value
            client = self.client(Response(payload))
            self.assert_error("empty_response", lambda: self.parse(client))

    def test_no_choices_or_message_is_rejected(self):
        for choices in ([], {}, None, [None], [{}], [{"message": []}]):
            payload = completion(choices=choices)
            client = self.client(Response(payload))
            self.assert_error("invalid_response" if not isinstance(choices, list) or not choices
                              or choices[0] is None else "empty_response", lambda: self.parse(client))

    def test_truncation_rejected_even_when_json_looks_valid(self):
        payload = completion()
        payload["choices"][0]["finish_reason"] = "length"
        client = self.client(Response(payload))
        self.assert_error("truncated_response", lambda: self.parse(client))

    def test_invalid_content_json_and_markdown_rejected(self):
        for content in ("not json", "```json\n{}\n```", '{"criteria":',
                        '{"criteria":{},"criteria":{},"answer":"x"}',
                        '{"criteria":{"min_iv":NaN},"answer":"x"}'):
            payload = completion()
            payload["choices"][0]["message"]["content"] = content
            client = self.client(Response(payload))
            self.assert_error("invalid_json", lambda: self.parse(client))

    def test_invalid_content_shapes_rejected(self):
        for parsed in ([], None, 3, {}, {"criteria": [], "answer": "x"},
                       {"criteria": {}, "answer": 4}, {"criteria": {}, "answer": "x", "clarification": False},
                       {"criteria": {}, "answer": "x", "prices": [123]},
                       {"criteria": {}, "answer": "x" * 2401},
                       {"criteria": {}, "answer": "x", "clarification": "x" * 1201}):
            payload = completion()
            payload["choices"][0]["message"]["content"] = json.dumps(parsed)
            client = self.client(Response(payload))
            self.assert_error("invalid_response", lambda: self.parse(client))

    def test_criteria_unknown_keys_and_wrong_types_rejected(self):
        for criteria in ({"symbols": ["invented"]}, {"min_iv": "0.5"}, {"limit": True},
                         {"quantity": None}, {"min_days": False}, {"type": []}):
            payload = completion(criteria)
            client = self.client(Response(payload))
            self.assert_error("invalid_criteria", lambda: self.parse(client))

    def test_clarification_and_empty_criteria_preserved(self):
        client = self.client(Response(completion({}, "请指定风险口径。", "绝对 Delta 上限是多少？")))
        result = self.parse(client, question="低风险高收益")
        self.assertEqual(result["criteria"], {})
        self.assertEqual(result["clarification"], "绝对 Delta 上限是多少？")

    def test_usage_int_whitelist_and_no_reasoning_or_provider_fields(self):
        payload = completion(usage={"prompt_tokens": 100, "completion_tokens": True,
            "total_tokens": -1, "prompt_cache_hit_tokens": 30, "prompt_cache_miss_tokens": "70",
            "completion_tokens_details": {"reasoning_tokens": 500}, "key": FIXTURE_KEY},
            private=FIXTURE_KEY)
        payload["choices"][0]["message"]["reasoning_content"] = FIXTURE_KEY
        client = self.client(Response(payload))
        result = self.parse(client)
        self.assertEqual(result["usage"], {"prompt_tokens": 100, "prompt_cache_hit_tokens": 30})
        self.assertNotIn(FIXTURE_KEY, json.dumps(result))
        self.assertNotIn("reasoning_content", json.dumps(result))

    def test_bad_actual_model_falls_back_to_requested_model(self):
        for model in (None, [], "https://bad.invalid", "x" * 121, "model\nname"):
            client = self.client(Response(completion(model=model)))
            self.assertEqual(self.parse(client)["model"], "deepseek-flash")

    def test_elapsed_time_metadata(self):
        client = self.client()
        response = Response(completion(), read_hook=lambda: setattr(self.clock, "now", self.clock.now + .2))
        self.opener.responses.append(response)
        result = self.parse(client)
        self.assertIsInstance(result["latency_ms"], int)
        self.assertGreaterEqual(result["latency_ms"], 399)

    def test_nonretryable_http_errors_sanitized_and_no_body_read(self):
        expected = {400: "unsupported_parameters", 401: "authentication", 402: "insufficient_balance",
                    403: "access_denied", 422: "unsupported_parameters", 404: "provider_error"}
        for status, code in expected.items():
            with self.subTest(status=status):
                exc = error(status)
                exc.read = lambda *unused: self.fail("HTTP error bodies must never be read")
                client = self.client(exc)
                result = self.assert_error(code, lambda: self.parse(client))
                self.assertEqual(len(self.opener.calls), 1)
                self.assertEqual(result.status, status if status != 404 else 502)

    def test_retry_only_once_on_transient_http_errors(self):
        for status in (429, 500, 503):
            with self.subTest(status=status):
                client = self.client(error(status), Response(completion()))
                self.parse(client)
                self.assertEqual(len(self.opener.calls), 2)
                self.assertAlmostEqual(sum(self.clock.sleeps), .5)
                client = self.client(error(status), error(status), Response(completion()))
                self.assert_error("rate_limited" if status == 429 else "provider_unavailable",
                                  lambda: self.parse(client))
                self.assertEqual(len(self.opener.calls), 2)

    def test_retry_after_seconds_capped_at_four(self):
        for raw, expected in (("1.25", 1.25), ("99", 4), ("-1", 0), ("garbage", .5), ("nan", .5)):
            with self.subTest(raw=raw):
                client = self.client(error(429, {"Retry-After": raw}), Response(completion()))
                self.parse(client)
                self.assertAlmostEqual(sum(self.clock.sleeps), expected)
                self.assertTrue(all(value <= .1 for value in self.clock.sleeps))

    def test_retry_after_http_date_supported(self):
        client = self.client(error(429, {"Retry-After": "Wed, 21 Oct 2015 07:28:03 GMT"}), Response(completion()))
        with patch("deepseek_client.time.time", return_value=1445412480):
            self.parse(client)
        self.assertAlmostEqual(sum(self.clock.sleeps), 3)

    def test_nonraising_retryable_status_response_closed(self):
        response = Response({}, status=503, headers={"Retry-After": "0"})
        client = self.client(response, Response(completion()))
        self.parse(client)
        self.assertTrue(response.closed)
        self.assertEqual(len(self.opener.calls), 2)

    def test_socket_timeout_has_no_retry(self):
        client = self.client(socket.timeout("private " + FIXTURE_KEY))
        self.assert_error("timeout", lambda: self.parse(client))
        self.assertEqual(len(self.opener.calls), 1)

    def test_urlerror_wrapped_timeout_is_timeout(self):
        client = self.client(urllib.error.URLError(socket.timeout(FIXTURE_KEY)))
        self.assert_error("timeout", lambda: self.parse(client))
        self.assertEqual(len(self.opener.calls), 1)

    def test_incomplete_transport_response_is_sanitized_and_closed(self):
        def broken_read():
            raise http.client.IncompleteRead(FIXTURE_KEY.encode(), 3)
        response = Response(completion(), read_hook=broken_read)
        client = self.client(response)
        self.assert_error("connection_failed", lambda: self.parse(client))
        self.assertTrue(response.closed)

    def test_extremely_large_criteria_number_is_rejected(self):
        payload = completion({"min_iv": 10 ** 1000})
        client = self.client(Response(payload))
        self.assert_error("invalid_criteria", lambda: self.parse(client))

    def test_transport_errors_sanitized_and_no_retry(self):
        for exc in (urllib.error.URLError(FIXTURE_KEY), ssl.SSLError(FIXTURE_KEY), OSError(FIXTURE_KEY)):
            client = self.client(exc)
            self.assert_error("connection_failed", lambda: self.parse(client))
            self.assertEqual(len(self.opener.calls), 1)

    def test_read_timeout_closes_response(self):
        def timeout():
            raise socket.timeout(FIXTURE_KEY)
        response = Response(completion(), read_hook=timeout)
        client = self.client(response)
        self.assert_error("timeout", lambda: self.parse(client))
        self.assertTrue(response.closed)

    def test_blank_keepalives_cannot_bypass_total_deadline(self):
        class Heartbeats(Response):
            def read1(inner, size):
                self.clock.now += 11
                return b" "
        response = Heartbeats({})
        client = self.client(response)
        self.assert_error("timeout", lambda: self.parse(client))
        self.assertTrue(response.closed)
        self.assertLess(self.clock.now - 100, 57)

    def test_retry_does_not_reset_total_deadline(self):
        def slow_error(request, timeout):
            self.clock.now += 43
            raise error(429, {"Retry-After": "4"})
        client = self.client(slow_error, Response(completion()))
        self.assert_error("timeout", lambda: self.parse(client))
        self.assertEqual(len(self.opener.calls), 1)
        self.assertLessEqual(self.clock.now - 100, 45.00001)

    def test_cancel_before_request_does_not_read_key_or_network(self):
        cancelled = threading.Event()
        cancelled.set()
        client = self.client(key_provider=lambda: self.fail("cancelled request read key"))
        self.assert_error("cancelled", lambda: self.parse(client, cancel_event=cancelled))
        self.assertEqual(self.opener.calls, [])

    def test_cancel_during_read_closes_response(self):
        cancelled = threading.Event()
        response = Response(completion(), read_hook=cancelled.set)
        client = self.client(response)
        self.assert_error("cancelled", lambda: self.parse(client, cancel_event=cancelled))
        self.assertTrue(response.closed)

    def test_cancel_during_retry_wait_stops_second_request(self):
        cancelled = threading.Event()
        client = self.client(error(429, {"Retry-After": "4"}), Response(completion()))
        def sleep(seconds):
            self.clock.sleep(seconds)
            cancelled.set()
        client._sleep = sleep
        self.assert_error("cancelled", lambda: self.parse(client, cancel_event=cancelled))
        self.assertEqual(len(self.opener.calls), 1)
        self.assertLessEqual(sum(self.clock.sleeps), .1)

    def test_response_byte_limit_closes_response(self):
        response = Response(raw=b" " * (MAX_RESPONSE_BYTES + 1))
        client = self.client(response)
        self.assert_error("response_too_large", lambda: self.parse(client))
        self.assertTrue(response.closed)

    def test_invalid_wire_json_nonobject_duplicate_nonfinite_rejected(self):
        for raw, code in ((b"", "invalid_json"), (b"{", "invalid_json"), (b"\xff", "invalid_json"),
                          (b"[]", "invalid_response"), (b'{"a":1,"a":2}', "invalid_json"),
                          (b'{"a":Infinity}', "invalid_json")):
            client = self.client(Response(raw=raw))
            self.assert_error(code, lambda: self.parse(client))

    def test_wrapper_fp_read1_is_used(self):
        class Wrapper:
            def __init__(inner):
                inner.fp = io.BytesIO(json.dumps(completion()).encode())
                inner.url, inner.status, inner.closed = None, 200, False
            def geturl(inner):
                return inner.url
            def read(inner, unused):
                self.fail("blocking read() must not be used when fp.read1 exists")
            def close(inner):
                inner.closed = True
                inner.fp.close()
        response = Wrapper()
        client = self.client(response)
        self.parse(client)
        self.assertTrue(response.closed)

    def test_fallback_read_uses_one_byte_to_allow_deadline_checks(self):
        class Wrapper:
            def __init__(inner):
                inner.buffer = io.BytesIO(json.dumps(completion()).encode())
                inner.url, inner.status, inner.closed = None, 200, False
                inner.sizes = []
            def geturl(inner):
                return inner.url
            def read(inner, size):
                inner.sizes.append(size)
                return inner.buffer.read(size)
            def close(inner):
                inner.closed = True
                inner.buffer.close()
        response = Wrapper()
        client = self.client(response)
        self.parse(client)
        self.assertTrue(response.closed)
        self.assertEqual(set(response.sizes), {1})


if __name__ == "__main__":
    unittest.main()
