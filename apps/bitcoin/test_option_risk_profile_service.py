"""Risk preset orchestration: one snapshot, bounded AI, safe refresh and choice."""
import copy
import threading
import unittest
from unittest.mock import patch

from deepseek_client import DeepSeekError
from option_ai_service import AIServiceError, OptionAIService
from option_risk_profiles import screen_risk_profile, risk_profile_config
from test_option_ai_engine import NOW, contract, snapshot
from test_option_ai_service import MemoryVault, await_job


class Client:
    def __init__(self, action=None):
        self.calls, self.parse_calls = [], []
        self.action = action
        self.started = threading.Event()

    def parse(self, *args, **kwargs):
        self.parse_calls.append(args)
        raise AssertionError("preset selection must not ask a model to invent thresholds")

    def explain(self, result, model, cancel_event=None):
        self.calls.append(copy.deepcopy(result))
        self.started.set()
        if self.action:
            self.action(cancel_event)
        return {"status": "complete", "overview": "本组按固定档位比较，仍有下行风险。",
                "candidates": [{"symbol": item["symbol"], "text": "权利金有限，较大下跌可使到期亏损扩大。"}
                               for item in result["candidates"]],
                "model": model, "usage": {"total_tokens": 100}, "latency_ms": 12}


class RiskPresetServiceTests(unittest.TestCase):
    def setUp(self):
        self.value = snapshot([contract(strike=60000, delta="-.1", bid_price="100", ask_price="110"),
                               contract(strike=65000, delta="-.2", bid_price="200", ask_price="210"),
                               contract(strike=70000, delta="-.4", bid_price="500", ask_price="510")])
        self.reads, self.services = 0, []
        patcher = patch("option_risk_profiles.screen_risk_profile",
                        side_effect=lambda value, profile, expiry="ALL", quantity=.01:
                        screen_risk_profile(value, profile, expiry, quantity, now_ms=NOW))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.stop)

    def read(self):
        self.reads += 1
        return copy.deepcopy(self.value)

    def stop(self):
        for service in self.services:
            service.stop()
        for service in self.services:
            for thread in service._threads:
                thread.join(1)

    def service(self, action=None):
        service = OptionAIService(self.read, client=Client(action), vault=MemoryVault())
        self.services.append(service)
        return service

    def complete(self, service, profile="low", **kwargs):
        job = service.submit(model="deepseek-flash", risk_profile=profile, **kwargs)
        result = await_job(service, job["job_id"])
        self.assertEqual(result["status"], "complete", result)
        return job["job_id"], result["result"]

    def test_three_profiles_are_local_criteria_and_exact_same_snapshot_is_explained(self):
        service = self.service()
        for profile, lower, upper in (("low", 0, .15), ("medium", .15, .3), ("high", .3, .6)):
            _, result = self.complete(service, profile, quantity=.03)
            self.assertEqual(result["risk_profile"]["id"], profile)
            self.assertEqual(result["criteria"], risk_profile_config(profile, quantity=.03))
            self.assertTrue(result["candidates"])
            self.assertTrue(all(lower < item["abs_delta"] <= upper for item in result["candidates"]))
            explained = service.client.calls[-1]
            self.assertEqual(result["candidates"], explained["candidates"])
            self.assertEqual(result["snapshot"], explained["snapshot"])
            self.assertEqual(result["ai_explanation"]["snapshot_reference_id"], result["snapshot"]["reference_id"])
        self.assertEqual(self.reads, 3)
        self.assertEqual(service.client.parse_calls, [])

    def test_empty_does_not_call_ai_or_relax_profile(self):
        service = self.service()
        self.value["options"] = [contract(delta="-.8")]
        _, result = self.complete(service)
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["ai_explanation"]["status"], "skipped")
        self.assertEqual(service.client.calls, [])
        self.assertEqual(result["criteria"]["max_abs_delta"], .15)

    def test_explanation_failure_preserves_all_local_risk_facts_without_raw_error(self):
        def fail(_):
            raise RuntimeError("sk-do-not-expose-a-provider-secret")
        service = self.service(fail)
        _, result = self.complete(service)
        self.assertEqual(result["ai_explanation"]["status"], "unavailable")
        self.assertEqual(result["candidates"][0]["premium_total"], 1)
        self.assertEqual(result["candidates"][0]["max_loss_gross"], 599)
        self.assertNotIn("sk-do-not", str(result))

    def test_refresh_uses_new_prices_same_profile_no_model_and_removes_old_narrative(self):
        service = self.service()
        job, previous = self.complete(service)
        self.value.update(revision=20)
        self.value["options"][0].update(bid_price="120", ask_price="125")
        fresh = service.revalidate(job)["result"]
        self.assertEqual(fresh["risk_profile"], previous["risk_profile"])
        self.assertEqual(fresh["candidates"][0]["premium_total"], 1.2)
        self.assertEqual(fresh["snapshot"]["revision"], 20)
        self.assertEqual(fresh["ai_explanation"]["status"], "outdated")
        self.assertEqual(fresh["ai_explanation"]["candidates"], [])
        self.assertEqual(len(service.client.calls), 1)

    def test_select_and_refresh_enforce_exclusive_delta_boundary_after_market_changes(self):
        service = self.service()
        job, result = self.complete(service, "medium")
        candidate = result["candidates"][0]
        self.assertEqual(service.select(candidate["symbol"], result["criteria"], risk_profile="medium")["candidate"]["symbol"], candidate["symbol"])
        self.value["options"][1]["delta"] = "-.15"
        with self.assertRaises(AIServiceError) as captured:
            service.select(candidate["symbol"], result["criteria"], risk_profile="medium")
        self.assertEqual(captured.exception.status, 409)
        self.assertEqual(service.revalidate(job)["result"]["candidates"], [])

    def test_profile_selection_rejects_forged_criteria(self):
        service = self.service()
        _, result = self.complete(service)
        forged = dict(result["criteria"], max_abs_delta=.9)
        with self.assertRaises(AIServiceError):
            service.select(result["candidates"][0]["symbol"], forged, risk_profile="low")

    def test_invalid_and_mixed_presets_fail_before_market_or_model_access(self):
        service = self.service()
        for fields in ({"risk_profile": "extreme"}, {"risk_profile": False},
                       {"risk_profile": "low", "quantity": "0.01"},
                       {"risk_profile": "low", "quantity": -.01},
                       {"risk_profile": "low", "expiry": "2030-01-99"},
                       {"risk_profile": "low", "question": "change threshold"},
                       {"risk_profile": "low", "history": []},
                       {"risk_profile": "low", "previous_criteria": {}},
                       {"question": "custom", "quantity": .01}):
            with self.subTest(fields=fields), self.assertRaises(AIServiceError):
                service.submit(model="deepseek-flash", **fields)
        self.assertEqual(self.reads, 0)
        self.assertEqual(service.client.calls, [])

    def test_cancel_blocks_late_explanation_and_dedup_only_identical_active_presets(self):
        release = threading.Event()
        self.addCleanup(release.set)
        service = self.service(lambda _: release.wait(2))
        first = service.submit(model="deepseek-flash", risk_profile="low")
        self.assertTrue(service.client.started.wait(1))
        duplicate = service.submit(model="deepseek-flash", risk_profile="low")
        self.assertEqual(first["job_id"], duplicate["job_id"])
        other = service.submit(model="deepseek-flash", risk_profile="medium")
        self.assertNotEqual(first["job_id"], other["job_id"])
        service.cancel(first["job_id"])
        release.set()
        self.assertEqual(service.read_job(first["job_id"])["status"], "cancelled")
        self.assertNotIn("result", service.read_job(first["job_id"]))


if __name__ == "__main__":
    unittest.main()
