"""Bounded local AI jobs. Public market screening never holds a network lock."""
import base64
import copy
import datetime as dt
import hashlib
import json
import math
import os
import queue
import re
import threading
import time
import uuid
from pathlib import Path

from alert_email import _dpapi
from option_ai_engine import screen_snapshot, validate_criteria

MODELS = ({"id": "deepseek-flash", "label": "V4.1 Flash"},
          {"id": "deepseek-v4-pro", "label": "V4 Pro"})
DEFAULT_DIRECTORY = Path(__file__).resolve().parent / "terminal" / "data" / "option-ai"


class AIServiceError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.status = code, status


class KeyVault:
    """Only current Windows user's DPAPI ciphertext is persisted."""
    def __init__(self, directory=DEFAULT_DIRECTORY, seal=None, unseal=None):
        self.path = Path(directory) / "deepseek-key.protected.json"
        self.seal = seal or _dpapi
        self.unseal = unseal or (lambda data: _dpapi(data, decrypt=True))
        self.lock = threading.Lock()

    def read(self):
        with self.lock:
            try:
                value = json.loads(self.path.read_text(encoding="utf-8"))
                key = self.unseal(base64.b64decode(value["ciphertext"], validate=True)).decode("ascii")
                if not re.fullmatch(r"sk-[A-Za-z0-9_-]{16,256}", key):
                    return None
                return key
            except (OSError, ValueError, KeyError, TypeError, UnicodeError, RuntimeError):
                return None

    def save(self, key):
        if not isinstance(key, str) or not re.fullmatch(r"sk-[A-Za-z0-9_-]{16,256}", key):
            raise AIServiceError("invalid_key", "请填写有效的 DeepSeek API Key。")
        with self.lock:
            temporary = None
            try:
                cipher = base64.b64encode(self.seal(key.encode("ascii"))).decode("ascii")
                self.path.parent.mkdir(parents=True, exist_ok=True)
                temporary = self.path.with_name(".key-" + uuid.uuid4().hex + ".tmp")
                with temporary.open("x", encoding="utf-8") as handle:
                    json.dump({"version": 1, "ciphertext": cipher}, handle)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(str(temporary), str(self.path))
            except Exception:
                raise AIServiceError("vault_unavailable", "密钥尚未保存，请检查本机凭据保护及存储。", 503) from None
            finally:
                if temporary is not None:
                    try:
                        temporary.unlink(missing_ok=True)
                    except OSError:
                        pass


def _text(value, maximum):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise AIServiceError("invalid_question", "请填写有效的筛选需求，单条最多 3000 字。")
    # Keys accidentally pasted into chat must never be forwarded to a model.
    return re.sub(r"sk-[A-Za-z0-9_-]{8,}", "[密钥已隐藏]", value.strip())


def describe_criteria(criteria):
    """Explain the executed criteria, never model-authored price/profit claims."""
    config = validate_criteria(criteria)
    fmt = lambda value: format(value, ".12g")
    direction = "卖出" if config["direction"] == "SELL" else "买入"
    kind = {"PUT": "Put", "CALL": "Call", "ALL": "Call / Put"}[config["type"]]
    sort = {"daily_premium_desc": "整笔平均每日权利金%s降序" % ("支出" if config["direction"] == "BUY" else ""),
            "cash_daily_return_desc": "足额现金卖 Put 平均日权利金率降序",
            "spread_asc": "买卖价差升序", "delta_asc": "绝对 Delta 升序"}[config["sort"]]
    summary = "%s %s · %s · 模拟 %s BTC · 最多 %s 项 · 按%s。" % (
        direction, kind, "全部到期日" if config["expiry"] == "ALL" else config["expiry"] + " 到期",
        fmt(config["quantity"]), config["limit"], sort)
    filters = []
    metrics = (("days", "剩余期限", "天", 1), ("strike", "行权价", " USDT", 1),
               ("otm_pct", "虚值率", "%", 1), ("abs_delta", "|Delta|", "", 1),
               ("iv", "标记 IV", "%", 100), ("gamma", "Gamma", "", 1),
               ("vega", "Vega", "", 1), ("theta", "Theta", "", 1),
               ("premium", "权利金单价", " USDT/BTC", 1))
    for key, label, unit, scale in metrics:
        low, high = config.get("min_" + key), config.get("max_" + key)
        if low is not None and high is not None:
            filters.append(label + " " + fmt(low * scale) + "–" + fmt(high * scale) + unit)
        elif low is not None:
            filters.append(label + " ≥ " + fmt(low * scale) + unit)
        elif high is not None:
            filters.append(label + " ≤ " + fmt(high * scale) + unit)
    for key, label, suffix in (("min_daily_premium", "整笔日均权利金 ≥ ", " USDT"),
                               ("max_spread_pct", "买卖价差 / 中间价 ≤ ", "%"),
                               ("min_cash_daily_return_pct", "现金日权利金率 ≥ ", "%")):
        if key in config:
            filters.append(label + fmt(config[key]) + suffix)
    return summary + ("\n条件：" + "；".join(filters) + "。" if filters else "")


class OptionAIService:
    def __init__(self, snapshot_reader, directory=DEFAULT_DIRECTORY, client=None,
                 vault=None, clock=None, workers=2, queue_size=2, ttl=600):
        self.snapshot_reader = snapshot_reader
        self.vault = vault or KeyVault(directory)
        self.clock = clock or time.monotonic
        if client is None:
            from deepseek_client import DeepSeekClient
            client = DeepSeekClient(self.vault.read)
        self.client = client
        self.default_model = "deepseek-flash"
        self.models = [dict(item) for item in MODELS]
        self.models_verified = False
        self._discovering = False
        self._lock = threading.Lock()
        self._jobs, self._dedup = {}, {}
        self._stop = threading.Event()
        self._queue = queue.Queue(maxsize=queue_size)
        self._ttl, self._capacity = ttl, workers + queue_size
        self._threads = []
        for index in range(workers):
            thread = threading.Thread(target=self._worker, name="option-ai-%s" % index, daemon=True)
            thread.start()
            self._threads.append(thread)

    def status(self):
        configured = self.vault.read() is not None
        with self._lock:
            return {"configured": configured, "models": copy.deepcopy(self.models),
                    "models_verified": self.models_verified, "default_model": self.default_model,
                    "active_jobs": sum(job["status"] in ("queued", "running") for job in self._jobs.values())}

    def configure(self, key):
        with self._lock:
            if any(job["status"] in ("queued", "running") for job in self._jobs.values()):
                raise AIServiceError("busy", "请先取消或等待当前筛选，再更换密钥。", 409)
            self.vault.save(key)
            self.models_verified = False
            self.models = [dict(item) for item in MODELS]
        return self.status()

    def discover_models(self):
        # Explicit startup/diagnostic operation; never invoked by market ticks.
        found = self.client.list_models()
        ids = {item["id"] for item in found}
        with self._lock:
            self.models = [dict(item, available=item["id"] in ids) for item in MODELS]
            self.models_verified = True
        return self.status()

    def start_discovery(self):
        if self.vault.read() is None:
            return
        with self._lock:
            if self._discovering or self._stop.is_set():
                return
            self._discovering = True
        def discover():
            try:
                self.discover_models()
            except Exception:
                pass  # Failure is confined to the optional AI connection.
            finally:
                with self._lock:
                    self._discovering = False
        threading.Thread(target=discover, name="option-ai-model-discovery", daemon=True).start()

    def _prune(self):
        now = self.clock()
        terminal = [key for key, job in self._jobs.items() if job["status"] not in ("queued", "running")]
        for key in terminal:
            if now - self._jobs[key]["updated"] > self._ttl or len(self._jobs) > 32:
                del self._jobs[key]

    def submit(self, question=None, model=None, history=None, previous_criteria=None,
               risk_profile=None, expiry=None, quantity=None):
        profile_config = None
        if risk_profile is not None:
            from option_risk_profiles import risk_profile_config
            if question is not None or history is not None or previous_criteria is not None:
                raise AIServiceError("invalid_profile", "风险快捷筛选不能混入自定义对话条件。")
            try:
                profile_config = risk_profile_config(risk_profile, expiry="ALL" if expiry is None else expiry,
                                                     quantity=.01 if quantity is None else quantity)
            except (ValueError, TypeError):
                raise AIServiceError("invalid_profile", "风险档位、到期日或模拟数量无效。") from None
            question = "按 %s 预设筛选足额现金卖 Put" % risk_profile
        else:
            if expiry is not None or quantity is not None:
                raise AIServiceError("invalid_request", "自定义筛选请在需求中描述到期日和数量。")
            question = _text(question, 3000)
        if model not in {item["id"] for item in MODELS}:
            raise AIServiceError("invalid_model", "请选择支持的 DeepSeek 模型。")
        if previous_criteria is not None:
            previous_criteria = validate_criteria(previous_criteria)
        if history is None:
            history = []
        if not isinstance(history, list) or len(history) > 8:
            raise AIServiceError("invalid_history", "对话历史最多保留 8 条。")
        clean = []
        for item in history:
            if not isinstance(item, dict) or set(item) != {"role", "content"} or item["role"] not in ("user", "assistant"):
                raise AIServiceError("invalid_history", "对话历史格式无效。")
            clean.append({"role": item["role"], "content": _text(item["content"], 3000)[:2000]})
        if self.vault.read() is None:
            raise AIServiceError("not_configured", "请先配置 DeepSeek 密钥。", 503)
        digest = hashlib.sha256(json.dumps([question, model, clean, previous_criteria, risk_profile, profile_config], ensure_ascii=False).encode("utf-8")).hexdigest()
        with self._lock:
            if self._stop.is_set():
                raise AIServiceError("stopping", "AI 服务正在停止。", 503)
            self._prune()
            existing = self._jobs.get(self._dedup.get(digest))
            if existing and existing["status"] in ("queued", "running"):
                return {"job_id": existing["id"], "status": existing["status"]}
            if sum(job["status"] in ("queued", "running") for job in self._jobs.values()) >= self._capacity:
                raise AIServiceError("busy", "筛选队列已满，请稍后再试。", 429)
            job_id = uuid.uuid4().hex
            job = {"id": job_id, "status": "queued", "question": question, "model": model,
                   "history": clean, "previous_criteria": previous_criteria, "risk_profile": risk_profile,
                   "profile_config": profile_config, "cancel": threading.Event(), "updated": self.clock(), "digest": digest}
            self._jobs[job_id] = job
            self._dedup[digest] = job_id
            try:
                self._queue.put_nowait(job_id)
            except queue.Full:
                del self._jobs[job_id]
                self._dedup.pop(digest, None)
                raise AIServiceError("busy", "筛选队列已满，请稍后再试。", 429) from None
            return {"job_id": job_id, "status": "queued"}

    def _find(self, job_id):
        self._prune()
        job = self._jobs.get(job_id)
        if not job:
            raise AIServiceError("not_found", "筛选记录已失效，请重新描述需求。", 404)
        return job

    def read_job(self, job_id):
        with self._lock:
            job = self._find(job_id)
            return copy.deepcopy({key: job[key] for key in ("status", "result", "error") if key in job})

    def cancel(self, job_id):
        with self._lock:
            job = self._find(job_id)
            if job["status"] in ("queued", "running"):
                job["cancel"].set()
                job.update(status="cancelled", updated=self.clock())
            return {"status": job["status"]}

    def revalidate(self, job_id):
        with self._lock:
            job = self._find(job_id)
            if job["status"] != "complete" or job["result"].get("needs_clarification"):
                raise AIServiceError("not_ready", "请先完成一次有效的需求筛选。", 409)
            previous = copy.deepcopy(job["result"])
        # No AI request and no service lock during market read / calculations.
        if previous.get("risk_profile"):
            from option_risk_profiles import screen_risk_profile
            result = screen_risk_profile(self.snapshot_reader(), previous["risk_profile"]["id"],
                                         expiry=previous["criteria"]["expiry"], quantity=previous["criteria"]["quantity"])
            result["ai_explanation"] = {"status": "outdated", "overview": "报价已重新计算，请重新点击风险档位生成新解读。", "candidates": []}
        else:
            result = screen_snapshot(self.snapshot_reader(), previous["criteria"])
        for key in ("answer", "model", "requested_model", "latency_ms", "usage"):
            if key in previous:
                result[key] = previous[key]
        with self._lock:
            job = self._find(job_id)
            if job["status"] != "complete":
                raise AIServiceError("cancelled", "筛选已取消。", 409)
            job.update(result=result, updated=self.clock())
        return {"status": "complete", "result": copy.deepcopy(result)}

    def select(self, symbol, criteria, risk_profile=None):
        if not isinstance(symbol, str) or not re.fullmatch(r"BTC-[A-Za-z0-9.-]{1,80}", symbol):
            raise AIServiceError("invalid_symbol", "请选择有效的 BTC 期权合约。")
        criteria = validate_criteria(criteria)
        snapshot = self.snapshot_reader()
        rows = [row for row in snapshot.get("options", []) if row.get("symbol") == symbol]
        if len(rows) != 1:
            raise AIServiceError("quote_unavailable", "该合约已移除，请更新筛选报价。", 409)
        if risk_profile is not None:
            from option_risk_profiles import risk_profile_config, screen_risk_profile
            if criteria != risk_profile_config(risk_profile, expiry=criteria["expiry"], quantity=criteria["quantity"]):
                raise AIServiceError("invalid_profile", "风险档位条件不匹配，请重新筛选。")
            screening = screen_risk_profile(dict(snapshot, options=rows), risk_profile,
                                           expiry=criteria["expiry"], quantity=criteria["quantity"])
        else:
            screening = screen_snapshot(dict(snapshot, options=rows), criteria)
        if not screening["candidates"]:
            raise AIServiceError("quote_changed", "当前报价已不符合条件或暂时失效，请更新筛选报价。", 409)
        return {"candidate": screening["candidates"][0], "row": rows[0],
                "snapshot": dict(screening["snapshot"], stale=bool(snapshot.get("stale")))}

    @staticmethod
    def _context(snapshot):
        beijing = dt.timezone(dt.timedelta(hours=8))
        offset = float(snapshot.get("exchange_clock_offset_ms", 0))
        if not math.isfinite(offset):
            raise ValueError("Invalid exchange clock")
        now_ms = time.time() * 1000 + offset
        now = dt.datetime.fromtimestamp(now_ms / 1000, beijing)
        expiries = set()
        for row in snapshot.get("options", []):
            if not isinstance(row, dict) or row.get("status") != "TRADING":
                continue
            try:
                expiry = float(row["expiry_ms"]) if row.get("expiry_ms") is not None else dt.datetime.fromisoformat(row["expiry_beijing"].replace("Z", "+00:00")).timestamp() * 1000
                if math.isfinite(expiry) and expiry > now_ms:
                    expiries.add(dt.datetime.fromtimestamp(expiry / 1000, beijing).date().isoformat())
            except (ValueError, KeyError, TypeError, OverflowError, OSError):
                continue
        return {"beijing_now": now.isoformat(), "available_expiries": sorted(expiries),
                "btc_index_price": snapshot.get("btc_index_price"), "snapshot_revision": snapshot.get("revision")}

    def _worker(self):
        while not self._stop.is_set():
            try:
                job_id = self._queue.get(timeout=.2)
            except queue.Empty:
                continue
            try:
                with self._lock:
                    job = self._jobs.get(job_id)
                    if job is None or job["status"] != "queued":
                        continue
                    job["status"] = "running"
                if job["risk_profile"] is not None:
                    result = self._run_profile(job)
                    with self._lock:
                        if not job["cancel"].is_set():
                            job.update(status="complete", result=result, updated=self.clock())
                    continue
                context = self._context(self.snapshot_reader())
                if job["previous_criteria"] is not None:
                    context["previous_criteria"] = job["previous_criteria"]
                plan = self.client.parse(job["question"], job["model"], context,
                                         history=job["history"], cancel_event=job["cancel"])
                if job["cancel"].is_set():
                    continue
                if plan.get("clarification"):
                    result = {"needs_clarification": True, "answer": plan["clarification"],
                              "criteria": {}, "candidates": [], "warnings": []}
                else:
                    criteria = validate_criteria(plan["criteria"])
                    result = screen_snapshot(self.snapshot_reader(), criteria)
                    result["answer"] = describe_criteria(criteria)
                for key in ("model", "requested_model", "latency_ms", "usage"):
                    if key in plan:
                        result[key] = plan[key]
                with self._lock:
                    if not job["cancel"].is_set():
                        job.update(status="complete", result=result, updated=self.clock())
            except Exception as exc:
                # Only allow the client's sanitized errors; arbitrary provider,
                # filesystem or injected exceptions must not leak their text.
                from deepseek_client import DeepSeekError
                if isinstance(exc, DeepSeekError):
                    error = {"code": exc.code, "message": str(exc)}
                elif isinstance(exc, ValueError):
                    error = {"code": "invalid_criteria", "message": "模型返回的条件未通过校验，请明确条件后重试。"}
                else:
                    error = {"code": "unavailable", "message": "AI 筛选暂时不可用，请稍后重试；行情继续更新。"}
                with self._lock:
                    if job is not None and not job["cancel"].is_set():
                        job.update(status="failed", error=error, updated=self.clock())
            finally:
                with self._lock:
                    if job is not None and self._dedup.get(job["digest"]) == job_id:
                        self._dedup.pop(job["digest"], None)
                self._queue.task_done()

    def _run_profile(self, job):
        from option_risk_profiles import screen_risk_profile
        config = job["profile_config"]
        result = screen_risk_profile(self.snapshot_reader(), job["risk_profile"],
                                     expiry=config["expiry"], quantity=config["quantity"])
        result["answer"] = result["risk_profile"]["label"] + " · " + describe_criteria(result["criteria"])
        result["requested_model"] = job["model"]
        if not result["candidates"] or job["cancel"].is_set():
            result["ai_explanation"] = {"status": "skipped", "overview": "当前没有符合该风险档位的有效合约。", "candidates": []}
            return result
        try:
            explanation = self.client.explain(result, job["model"], cancel_event=job["cancel"])
            result["ai_explanation"] = explanation
            # Tie every narrative to the exact computed snapshot and criteria.
            result["ai_explanation"]["snapshot_reference_id"] = result["snapshot"]["reference_id"]
            for key in ("model", "latency_ms", "usage"):
                if key in explanation:
                    result[key] = explanation[key]
        except Exception:
            result["ai_explanation"] = {"status": "unavailable", "overview": "AI 解读暂不可用；下方本机计算的报价和风险数据仍可查看。", "candidates": []}
        return result

    def stop(self):
        self._stop.set()
        with self._lock:
            for job in self._jobs.values():
                if job["status"] in ("queued", "running"):
                    job["cancel"].set()
                    job.update(status="cancelled", updated=self.clock())
