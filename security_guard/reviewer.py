"""Classify each batch before any manual decision, with accountable API usage."""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from . import deepseek, identity, triage


class AutoReviewer:
    def __init__(self, enabled=True, model=None, content_consent=None, content_mode="ask"):
        if content_mode not in {"ask", "allow", "metadata"}:
            raise ValueError("文件内容分享模式无效。")
        self.enabled = enabled
        self.content_consent = content_consent
        self.content_mode = content_mode
        self.model = model or deepseek.DEFAULT_MODEL
        self.client = None
        self.error = None
        self.summary = {
            "enabled": enabled, "model": self.model, "requests": 0,
            "reviewed": 0, "failed": 0, "not_reviewed": 0,
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            "usage_complete": True,
            "content_mode": content_mode,
        }

    def _with_identity(self, finding):
        if not finding.path:
            return finding
        try:
            path = Path(finding.path)
            details = identity.collect_identity(path, expected_sha256=finding.sha256, include_content=False)
            permitted = self.content_mode == "allow"
            if self.content_mode == "ask" and details.get("content_eligible"):
                permitted = identity.trusted_system_identity(details)
                if not permitted and self.content_consent:
                    permitted = bool(self.content_consent(path, details))
            if self.content_mode == "metadata":
                permitted = False
            if permitted and details.get("content_eligible"):
                details = identity.add_content_excerpt(path, details, expected_sha256=finding.sha256)
                details["content_sharing"] = "approved"
            else:
                details["source_excerpt"] = ""
                details["content_sharing"] = "metadata_only" if self.content_mode == "metadata" else "not_shared"
            return replace(finding, identity=details)
        except (OSError, ValueError, RuntimeError):
            return replace(finding, identity={"basename": Path(finding.path).name,
                "content_status": "unavailable", "source_excerpt": "", "content_eligible": False,
                "identity_error": "无法读取完整文件属性或文件发生变化，不能确认来源和用途。"})

    def _account_usage(self, usage):
        if not isinstance(usage, dict):
            self.summary["usage_complete"] = False
            return
        for name in self.summary["usage"]:
            value = usage.get(name)
            if type(value) is not int or value < 0:
                self.summary["usage_complete"] = False
                return
        for name in self.summary["usage"]:
            self.summary["usage"][name] += usage[name]

    def classify(self, findings):
        if not findings:
            return []
        if len(findings) > deepseek.MAX_BATCH:
            raise ValueError("一次自动识别最多 20 项，请分批。")
        response = None
        batch_error = "已禁用 AI 自动识别。" if not self.enabled else self.error
        if self.enabled and not self.error:
            try:
                if self.client is None:
                    key = deepseek.load_api_key()
                    if not key:
                        raise deepseek.DeepSeekError("未配置 DeepSeek 密钥。")
                    self.client = deepseek.DeepSeekClient(key, self.model)
                findings = [self._with_identity(finding) for finding in findings]
                self.summary["requests"] += 1
                # Clear the last response metadata so a failed request cannot
                # accidentally count usage from the preceding successful batch.
                self.client.last_usage = None
                response = self.client.review(findings)
                self._account_usage(response.get("usage"))
                self.summary["reviewed"] += len(findings)
                self.summary["model"] = response.get("model") or self.model
            except KeyboardInterrupt:
                if self.client is not None:
                    self._account_usage(getattr(self.client, "last_usage", None))
                raise
            except (OSError, ValueError, RuntimeError) as error:
                self.error = "AI 自动复核失败：" + str(error)
                batch_error = self.error
                if self.client is not None:
                    self._account_usage(getattr(self.client, "last_usage", None))
                self.summary["failed"] += len(findings)
        elif self.enabled:
            self.summary["not_reviewed"] += len(findings)
        else:
            self.summary["not_reviewed"] += len(findings)
        items = {item["id"]: item for item in response["items"]} if response else {}
        return [replace(finding, verdict=triage.make_verdict(finding, items.get(index), batch_error),
                        explanation=items.get(index, {}).get("explanation", {}) or {
                            "file_type": "尚未完成文件说明",
                            "purpose": "" if self.enabled else "本次未启用 AI 文件说明。",
                            "likely_origin": "尚未取得足够来源证据。",
                            "observed_behavior": "尚未取得完整内容分析结果。",
                            "deletion_impact": "不要仅凭名称删除，删除可能影响所属程序。",
                            "limitations": batch_error or "AI 未返回具体文件说明。"})
                for index, finding in enumerate(findings, 1)]
