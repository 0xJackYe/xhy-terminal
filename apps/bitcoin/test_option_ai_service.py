"""Offline acceptance of encrypted credentials and bounded local AI jobs.

Only synthetic secrets, an injected client and deterministic public-market
fixtures are used. No provider, wallet, order, real key vault or network access.
"""
import base64
import copy
import datetime as dt
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from deepseek_client import DeepSeekError
from option_ai_engine import screen_snapshot, validate_criteria
from option_ai_service import AIServiceError, KeyVault, OptionAIService, describe_criteria
from test_option_ai_engine import NOW, contract, snapshot


SYNTHETIC_KEY = "sk-offline-test-credential-000000000"
MODEL = "deepseek-flash"


class MemoryVault:
    def __init__(self, key=SYNTHETIC_KEY):
        self.key = key
        self.saved = []

    def read(self):
        return self.key

    def save(self, key):
        self.saved.append(key)
        self.key = key


class PublicMarket:
    def __init__(self):
        self.value = snapshot([contract(expiry_beijing="2030-01-11T08:00:00+08:00")])
        self.reads = 0
        self.lock = threading.Lock()

    def read(self):
        with self.lock:
            self.reads += 1
            return copy.deepcopy(self.value)

    def update(self, **changes):
        with self.lock:
            self.value.update(changes)


class FakeClient:
    def __init__(self, action=None):
        self.action = action
        self.calls = []
        self.started = threading.Event()
        self.model_calls = 0

    def list_models(self):
        self.model_calls += 1
        return [{"id": MODEL}]

    def parse(self, question, model, context, history=None, cancel_event=None):
        call = {"question": question, "model": model, "context": copy.deepcopy(context),
                "history": copy.deepcopy(history), "cancel": cancel_event}
        self.calls.append(call)
        self.started.set()
        if self.action is not None:
            result = self.action(call, len(self.calls))
            if result is not None:
                return result
        return {"criteria": {"type": "PUT", "direction": "SELL", "quantity": .01},
                "answer": "按卖 Put 盘口与剩余期限筛选。", "model": model,
                "requested_model": model, "latency_ms": 12,
                "usage": {"total_tokens": 20}}


def await_job(service, job_id, terminal=("complete", "failed", "cancelled"), timeout=2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = service.read_job(job_id)
        if result["status"] in terminal:
            return result
        threading.Event().wait(.002)
    raise AssertionError("local fake AI job failed to reach a terminal state")


class KeyVaultTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        # Reversible opaque fake encryption, deliberately not a plaintext wrapper.
        self.vault = KeyVault(self.directory.name,
            seal=lambda data: bytes(value ^ 0xAD for value in data),
            unseal=lambda data: bytes(value ^ 0xAD for value in data))

    def test_encrypted_atomic_roundtrip_never_persists_plaintext_or_temp_files(self):
        self.assertIsNone(self.vault.read())
        self.vault.save(SYNTHETIC_KEY)
        self.assertEqual(self.vault.read(), SYNTHETIC_KEY)
        raw = self.vault.path.read_bytes()
        self.assertNotIn(SYNTHETIC_KEY.encode(), raw)
        document = json.loads(raw)
        self.assertEqual(set(document), {"version", "ciphertext"})
        self.assertNotIn(SYNTHETIC_KEY.encode(), base64.b64decode(document["ciphertext"]))
        self.assertEqual(list(Path(self.directory.name).iterdir()), [self.vault.path])

    def test_failed_atomic_replace_preserves_previous_key_and_removes_temporary_ciphertext(self):
        self.vault.save(SYNTHETIC_KEY)
        previous = self.vault.path.read_bytes()
        with patch("option_ai_service.os.replace", side_effect=OSError("synthetic storage failure")):
            with self.assertRaises(AIServiceError) as captured:
                self.vault.save("sk-another-offline-credential-0000000")
        self.assertEqual(captured.exception.code, "vault_unavailable")
        self.assertEqual(captured.exception.status, 503)
        self.assertEqual(previous, self.vault.path.read_bytes())
        self.assertEqual(self.vault.read(), SYNTHETIC_KEY)
        self.assertEqual(list(Path(self.directory.name).iterdir()), [self.vault.path])

    def test_encryption_failure_does_not_create_a_plaintext_fallback(self):
        self.vault.seal = lambda unused: (_ for _ in ()).throw(RuntimeError(SYNTHETIC_KEY))
        with self.assertRaises(AIServiceError) as captured:
            self.vault.save(SYNTHETIC_KEY)
        self.assertNotIn(SYNTHETIC_KEY, str(captured.exception))
        self.assertFalse(self.vault.path.exists())
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_invalid_keys_never_reach_encryption_or_storage(self):
        for value in (None, True, "", "sk-short", " sk-" + "a" * 20, "sk-" + "x" * 257, "sk-" + "密" * 20):
            with self.subTest(value_type=type(value).__name__), self.assertRaises(AIServiceError) as captured:
                self.vault.save(value)
            self.assertEqual(captured.exception.code, "invalid_key")
        self.assertFalse(self.vault.path.exists())

    def test_corrupt_unsupported_or_unreadable_ciphertext_is_unconfigured(self):
        for value in ("not json", "[]", "null", '{"ciphertext":"%%%"}', '{"ciphertext":null}',
                      '{"ciphertext":"AA=="}', '{"version":1}'):
            with self.subTest(document=value):
                self.vault.path.write_text(value, encoding="utf-8")
                self.assertIsNone(self.vault.read())
        self.vault.save(SYNTHETIC_KEY)
        self.vault.unseal = lambda unused: (_ for _ in ()).throw(RuntimeError("another Windows user"))
        self.assertIsNone(self.vault.read())

    def test_replace_occurs_only_after_the_encrypted_file_is_flushed(self):
        self.vault.save(SYNTHETIC_KEY)
        previous = self.vault.path.read_bytes()
        import os
        replace = os.replace
        def observe(source, destination):
            self.assertEqual(self.vault.path.read_bytes(), previous)
            self.assertNotIn(SYNTHETIC_KEY.encode(), Path(source).read_bytes())
            self.assertEqual(Path(source).parent, self.vault.path.parent)
            self.assertTrue(flush.called)
            replace(source, destination)
        with patch("option_ai_service.os.fsync", wraps=os.fsync) as flush, \
                patch("option_ai_service.os.replace", side_effect=observe):
            self.vault.save("sk-another-offline-credential-0000000")
        self.assertEqual(self.vault.read(), "sk-another-offline-credential-0000000")


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.market = PublicMarket()
        self.services = []
        patcher = patch("option_ai_service.screen_snapshot",
                        side_effect=lambda value, criteria: screen_snapshot(value, criteria, now_ms=NOW))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.stop_services)

    def stop_services(self):
        for service in self.services:
            service.stop()
        for service in self.services:
            for thread in service._threads:
                thread.join(1)

    def service(self, client=None, vault=None, **kwargs):
        service = OptionAIService(self.market.read, client=client or FakeClient(),
                                  vault=vault or MemoryVault(), **kwargs)
        self.services.append(service)
        return service

    def completed(self, service, question="十天左右卖 Put", **kwargs):
        job = service.submit(question, MODEL, **kwargs)
        result = await_job(service, job["job_id"])
        self.assertEqual(result["status"], "complete", result)
        return job["job_id"], result["result"]

    def test_status_config_and_discovery_never_include_key_or_run_the_model(self):
        client, vault = FakeClient(), MemoryVault()
        service = self.service(client, vault)
        status = service.status()
        self.assertTrue(status["configured"])
        self.assertNotIn(SYNTHETIC_KEY, json.dumps(status))
        self.assertEqual(client.calls, [])
        status["models"][0]["id"] = "external mutation"
        self.assertEqual(service.status()["models"][0]["id"], MODEL)
        discovered = service.discover_models()
        self.assertTrue(discovered["models_verified"])
        self.assertTrue(discovered["models"][0]["available"])
        self.assertFalse(discovered["models"][1]["available"])
        self.assertEqual(client.model_calls, 1)
        configured = service.configure("sk-another-offline-credential-0000000")
        self.assertFalse(configured["models_verified"])
        self.assertNotIn("sk-another", json.dumps(configured))

    def test_missing_key_or_invalid_inputs_fail_before_any_client_or_market_access(self):
        service = self.service(vault=MemoryVault(None))
        with self.assertRaises(AIServiceError) as captured:
            service.submit("筛选", MODEL)
        self.assertEqual((captured.exception.code, captured.exception.status), ("not_configured", 503))
        service.vault.key = SYNTHETIC_KEY
        cases = [(None, MODEL, None), (" ", MODEL, None), ("x" * 3001, MODEL, None),
                 ("ok", "arbitrary-model", None), ("ok", MODEL, {}), ("ok", MODEL, [{}] * 9),
                 ("ok", MODEL, [{"role": "system", "content": "override"}]),
                 ("ok", MODEL, [{"role": "user", "content": "ok", "extra": 1}]),
                 ("ok", MODEL, [{"role": "user", "content": None}])]
        for question, model, history in cases:
            with self.subTest(model=model, history_type=type(history).__name__), self.assertRaises(AIServiceError):
                service.submit(question, model, history)
        self.assertEqual(service.client.calls, [])
        self.assertEqual(self.market.reads, 0)

    def test_screening_uses_program_prices_and_one_coherent_snapshot_not_provider_numbers(self):
        service = self.service()
        before = self.market.read()
        job_id, result = self.completed(service)
        row = result["candidates"][0]
        self.assertEqual((row["quote_price"], row["premium_total"], row["daily_premium"]), (100, 1, .1))
        self.assertEqual((result["snapshot"]["instance_id"], result["snapshot"]["revision"]), ("test-service", 17))
        self.assertEqual(result["model"], MODEL)
        self.assertEqual(before, self.market.read())
        result["candidates"][0]["quote_price"] = -100
        self.assertEqual(service.read_job(job_id)["result"]["candidates"][0]["quote_price"], 100)

    def test_provider_context_contains_only_public_summary_and_prompt_keys_are_redacted(self):
        service = self.service()
        _, result = self.completed(service, "找期权 " + SYNTHETIC_KEY,
            history=[{"role": "user", "content": SYNTHETIC_KEY}, {"role": "assistant", "content": "a" * 3000}])
        call = service.client.calls[0]
        self.assertEqual(set(call["context"]), {"beijing_now", "available_expiries", "btc_index_price", "snapshot_revision"})
        self.assertEqual(call["context"]["available_expiries"], ["2030-01-11"])
        self.assertNotIn(SYNTHETIC_KEY, json.dumps({key: value for key, value in call.items() if key != "cancel"}))
        self.assertEqual(len(call["history"][1]["content"]), 2000)
        self.assertNotIn(SYNTHETIC_KEY, json.dumps(result))

    def test_duplicate_requests_share_one_active_job_and_queue_capacity_is_bounded(self):
        release = threading.Event()
        self.addCleanup(release.set)
        client = FakeClient(lambda call, count: (release.wait(2), None)[1])
        service = self.service(client, workers=1, queue_size=1)
        first = service.submit("first", MODEL)
        self.assertTrue(client.started.wait(1))
        self.assertEqual(service.submit("first", MODEL)["job_id"], first["job_id"])
        second = service.submit("second", MODEL)
        self.assertEqual(service.submit("second", MODEL)["job_id"], second["job_id"])
        with self.assertRaises(AIServiceError) as captured:
            service.submit("third", MODEL)
        self.assertEqual((captured.exception.code, captured.exception.status), ("busy", 429))
        self.assertEqual(service.status()["active_jobs"], 2)
        release.set()
        self.assertEqual(await_job(service, first["job_id"])["status"], "complete")
        self.assertEqual(await_job(service, second["job_id"])["status"], "complete")
        self.assertEqual(len(client.calls), 2)

    def test_running_and_queued_cancellation_cannot_publish_a_late_provider_reply(self):
        release = threading.Event()
        self.addCleanup(release.set)
        client = FakeClient(lambda call, count: (release.wait(2), None)[1])
        service = self.service(client, workers=1, queue_size=1)
        first = service.submit("first", MODEL)
        self.assertTrue(client.started.wait(1))
        second = service.submit("second", MODEL)
        for job in (first, second):
            self.assertEqual(service.cancel(job["job_id"]), {"status": "cancelled"})
        release.set()
        service._queue.join()
        self.assertEqual(len(client.calls), 1)
        self.assertTrue(client.calls[0]["cancel"].is_set())
        for job in (first, second):
            self.assertEqual(service.read_job(job["job_id"]), {"status": "cancelled"})

    def test_replacing_key_is_blocked_while_a_job_runs(self):
        release = threading.Event()
        self.addCleanup(release.set)
        client = FakeClient(lambda call, count: (release.wait(2), None)[1])
        service = self.service(client)
        job = service.submit("first", MODEL)
        self.assertTrue(client.started.wait(1))
        with self.assertRaises(AIServiceError) as captured:
            service.configure("sk-another-offline-credential-0000000")
        self.assertEqual(captured.exception.status, 409)
        self.assertEqual(service.vault.saved, [])
        service.cancel(job["job_id"])
        release.set()

    def test_arbitrary_errors_and_invalid_plans_are_isolated_and_worker_recovers(self):
        for error in (RuntimeError(SYNTHETIC_KEY), ValueError(SYNTHETIC_KEY),
                      DeepSeekError("rate_limited", "模型服务限流，请稍后重试。", 429)):
            with self.subTest(error_type=type(error).__name__):
                def action(call, count):
                    if count == 1:
                        raise error
                service = self.service(FakeClient(action), workers=1)
                job = service.submit("first", MODEL)
                failed = await_job(service, job["job_id"])
                self.assertEqual(failed["status"], "failed")
                self.assertNotIn(SYNTHETIC_KEY, json.dumps(failed))
                self.assertNotIn("traceback", json.dumps(failed).lower())
                self.completed(service, "second")
        service = self.service(FakeClient(lambda call, count: {"criteria": {"symbol": "fabricated"}}))
        job = service.submit("invalid plan", MODEL)
        failed = await_job(service, job["job_id"])
        self.assertEqual(failed["error"]["code"], "invalid_criteria")

    def test_snapshot_reader_failure_does_not_crash_worker_or_leak_details(self):
        service = self.service(workers=1)
        service.snapshot_reader = lambda: (_ for _ in ()).throw(RuntimeError(SYNTHETIC_KEY))
        job = service.submit("first", MODEL)
        failed = await_job(service, job["job_id"])
        self.assertEqual(failed["status"], "failed")
        self.assertNotIn(SYNTHETIC_KEY, json.dumps(failed))
        service.snapshot_reader = self.market.read
        self.completed(service, "retry")

    def test_revalidation_uses_new_snapshot_with_same_criteria_and_no_second_model_call(self):
        service = self.service()
        job_id, old = self.completed(service)
        updated = contract(bid_price="200", ask_price="210", expiry_beijing="2030-01-11T08:00:00+08:00")
        self.market.update(revision=18, options=[updated])
        result = service.revalidate(job_id)
        self.assertEqual(result["status"], "complete")
        fresh = result["result"]
        self.assertEqual(len(service.client.calls), 1)
        self.assertEqual(fresh["criteria"], old["criteria"])
        self.assertEqual(fresh["snapshot"]["revision"], 18)
        self.assertEqual(fresh["candidates"][0]["quote_price"], 200)
        self.assertEqual(fresh["candidates"][0]["daily_premium"], .2)
        self.assertNotEqual(fresh["snapshot"]["reference_id"], old["snapshot"]["reference_id"])
        self.assertEqual(fresh["usage"], old["usage"])
        self.assertEqual(service.read_job(job_id)["result"], fresh)

    def test_clarification_never_generates_contracts_or_allows_refresh(self):
        client = FakeClient(lambda call, count: {"clarification": "请提供期限或 Delta 上限。", "criteria": {}})
        service = self.service(client)
        job_id, result = self.completed(service)
        self.assertTrue(result["needs_clarification"])
        self.assertEqual(result["candidates"], [])
        with self.assertRaises(AIServiceError) as captured:
            service.revalidate(job_id)
        self.assertEqual(captured.exception.status, 409)

    def test_expired_completed_job_is_not_found_but_live_job_is_retained(self):
        clock = [0]
        service = self.service(clock=lambda: clock[0], ttl=2)
        job_id, _ = self.completed(service)
        clock[0] = 3
        for operation in (service.read_job, service.cancel, service.revalidate):
            with self.assertRaises(AIServiceError) as captured:
                operation(job_id)
            self.assertEqual(captured.exception.status, 404)

    def test_stop_cancels_all_work_and_rejects_new_jobs(self):
        release = threading.Event()
        self.addCleanup(release.set)
        client = FakeClient(lambda call, count: (release.wait(2), None)[1])
        service = self.service(client, workers=1, queue_size=1)
        first = service.submit("first", MODEL)
        self.assertTrue(client.started.wait(1))
        second = service.submit("second", MODEL)
        service.stop()
        self.assertEqual(service.read_job(first["job_id"])["status"], "cancelled")
        self.assertEqual(service.read_job(second["job_id"])["status"], "cancelled")
        with self.assertRaises(AIServiceError) as captured:
            service.submit("third", MODEL)
        self.assertEqual(captured.exception.status, 503)
        release.set()

    def test_structured_previous_criteria_survives_five_followups_and_is_validated(self):
        service = self.service()
        previous = {"expiry": "2030-01-11", "quantity": .03, "max_abs_delta": .2}
        for index in range(5):
            self.completed(service, question="followup %s" % index, previous_criteria=previous)
            self.assertEqual(service.client.calls[-1]["context"]["previous_criteria"], validate_criteria(previous))
        before = len(service.client.calls)
        with self.assertRaises(ValueError):
            service.submit("bad criteria", MODEL, previous_criteria={"injected_order": True})
        self.assertEqual(len(service.client.calls), before)

    def test_context_uses_exchange_clock_across_midnight_and_official_expiry_time(self):
        local = dt.datetime(2030, 1, 1, 15, 55, tzinfo=dt.timezone.utc).timestamp()
        expiry = int((local + 3600) * 1000)
        data = snapshot([contract(expiry_ms=expiry, expiry_beijing="2029-12-31T08:00:00+08:00"),
                         contract(strike=71000, expiry_ms=expiry - 7200000),
                         contract(strike=72000, expiry_ms=expiry, status="EXPIRED")], exchange_clock_offset_ms=600000)
        with patch("option_ai_service.time.time", return_value=local):
            context = OptionAIService._context(data)
        self.assertTrue(context["beijing_now"].startswith("2030-01-02T00:05"))
        self.assertEqual(context["available_expiries"], ["2030-01-02"])

    def test_selection_rechecks_actual_current_quote_and_filters_without_calling_model(self):
        service = self.service()
        row = self.market.read()["options"][0]
        selected = service.select(row["symbol"], {"min_otm_pct": 10, "quantity": .03})
        self.assertEqual(selected["candidate"]["quote_price"], float(row["bid_price"]))
        self.assertEqual(selected["snapshot"]["revision"], self.market.read()["revision"])
        self.assertEqual(service.client.calls, [])
        self.market.update(revision=22, options=[dict(row, bid_price="80")])
        newer = service.select(row["symbol"], {"quantity": .03})
        self.assertEqual(newer["candidate"]["quote_price"], 80)
        self.assertEqual(newer["snapshot"]["revision"], 22)

    def test_selection_rejects_expired_stale_removed_and_no_longer_matching_candidates(self):
        service = self.service()
        row = self.market.read()["options"][0]
        for replacement, criteria in (([], {}), ([dict(row, expiry_ms=NOW - 1)], {}),
                                      ([dict(row, quote_updated_at=NOW - 60000)], {}),
                                      ([row], {"min_daily_premium": 9999})):
            self.market.update(options=replacement)
            with self.assertRaises(AIServiceError) as captured:
                service.select(row["symbol"], criteria)
            self.assertEqual(captured.exception.status, 409)
        self.assertEqual(service.client.calls, [])

    def test_background_discovery_is_single_flight_and_does_not_block_status(self):
        service = self.service()
        release, entered = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def models():
            entered.set(); release.wait(1)
            return [{"id": MODEL}]
        service.client.list_models = models
        service.start_discovery()
        self.assertTrue(entered.wait(1))
        service.start_discovery()
        self.assertFalse(service.status()["models_verified"])
        release.set()

    def test_explanation_is_derived_from_executed_criteria_not_model_profit_or_unit_claims(self):
        client = FakeClient(lambda call, count: {"criteria": {"quantity": .03},
                                                 "answer": "每BTC日收益999且保本"})
        _, result = self.completed(self.service(client))
        self.assertIn("整笔平均每日权利金", result["answer"])
        self.assertIn("模拟 0.03 BTC", result["answer"])
        self.assertNotIn("保本", result["answer"])
        self.assertNotIn("999", result["answer"])

    def test_explanation_preserves_iv_percentage_delta_and_buy_expense_units(self):
        answer = describe_criteria({"direction": "BUY", "type": "CALL", "min_iv": .4,
                                    "max_iv": .8, "max_abs_delta": .2, "min_premium": 10})
        for text in ("买入 Call", "权利金支出降序", "标记 IV 40–80%", "|Delta| ≤ 0.2", "USDT/BTC"):
            self.assertIn(text, answer)


if __name__ == "__main__":
    unittest.main()
