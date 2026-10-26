"""Human-readable verdict policy for evidence, AI advice and engine detections.

This module is pure: it never accesses a file, starts a process, or applies an
action. Recommendations are fixed policy text rather than executable AI output.
"""
from __future__ import annotations

import re
import unicodedata


ASSESSMENTS = {"likely_threat", "suspicious", "uncertain", "likely_benign"}
CONFIDENCE = {"high", "medium", "low"}
DEFENDER_SOURCES = {"defender", "defender_unresolved"}


def _text(value, limit=1000):
    if not isinstance(value, str):
        return ""
    value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)
    value = "".join(
        c if unicodedata.category(c) not in {"Cc", "Cf", "Cs"} else " "
        for c in value[:limit]
    ).strip()
    return re.sub(r"sk-[A-Za-z0-9_.-]{8,}", "[已隐藏密钥]", value)


def make_verdict(finding, ai_item: dict | None = None, ai_error: str | None = None) -> dict:
    """Combine local detection and AI advice without claiming AI proves infection.

    An engine detection always takes priority. An AI failure, disabled AI, bad
    response or uncertain result never becomes a low-risk/clean conclusion.
    ``notify`` suppresses only low-risk AI advice; it never authorizes an action.
    """
    source = getattr(finding, "source", "")
    item = ai_item if isinstance(ai_item, dict) else {}
    assessment = item.get("assessment")
    if not isinstance(assessment, str) or assessment not in ASSESSMENTS:
        assessment = None
    confidence = item.get("confidence", "low")
    if not isinstance(confidence, str) or confidence not in CONFIDENCE:
        confidence = "low"
    explanation = _text(item.get("reason"))

    if source in DEFENDER_SOURCES:
        unresolved = source == "defender_unresolved"
        reasons = getattr(finding, "reasons", [])
        local_reason = "；".join(_text(reason, 300) for reason in reasons[:4]) if isinstance(reasons, (list, tuple)) else ""
        return {
            "label": "Defender 已检出威胁，具体文件尚未定位" if unresolved else "Defender 已检出威胁",
            "level": "confirmed_threat",
            "recommendation": (
                "先查看 Defender 日志定位具体文件；定位前保留文件，不删除其他文件。"
                if unresolved else
                "建议不要打开或运行；点击确认可定位此文件，再由你手动清除。"
            ),
            "reason": local_reason or "Windows Defender 已报告本地检测结果。",
            "confidence": "high",
            "notify": True,
            "ai_assessment": assessment,
            "basis": "defender",
        }

    if assessment == "likely_threat":
        return {
            "label": "AI 判断为高风险，疑似恶意文件",
            "level": "high_risk",
            "recommendation": "建议不要打开或运行；先保留并使用可信安全引擎复核，确认后由你手动清除。",
            "reason": explanation or "AI 根据本地静态特征判断风险较高；尚无病毒库确诊。",
            "confidence": confidence,
            "notify": True,
            "ai_assessment": assessment,
            "basis": "ai",
        }
    if assessment == "suspicious":
        return {
            "label": "AI 判断为可疑，存在风险特征",
            "level": "high_risk",
            "recommendation": "建议暂时保留且不要运行；用可信安全引擎进一步检查后，再决定是否手动清除。",
            "reason": explanation or "AI 发现可疑特征，现有证据仍不足以确认病毒。",
            "confidence": confidence,
            "notify": True,
            "ai_assessment": assessment,
            "basis": "ai",
        }
    if assessment == "likely_benign":
        return {
            "label": "AI 倾向低风险，建议保留",
            "level": "low_risk",
            "recommendation": "建议保留，无需因本次特征提示删除；AI 判断不能保证文件安全。",
            "reason": explanation or "AI 认为已有特征更符合正常用途，未取得病毒确诊证据。",
            "confidence": confidence,
            "notify": False,
            "ai_assessment": assessment,
            "basis": "ai",
        }

    if assessment == "uncertain":
        reason = explanation or "AI 分析后仍无法根据现有证据判断。"
        basis = "ai"
    elif ai_error:
        reason = "AI 识别未完成：" + (_text(ai_error, 500) or "服务暂时不可用。")
        basis = "unreviewed"
    else:
        reason = "该文件只有本地可疑特征，尚未获得 AI 识别或病毒库确诊结果。"
        basis = "unreviewed"
    return {
        "label": "证据不足，暂时无法判断",
        "level": "uncertain",
        "recommendation": "建议保留且不要运行；等待可信安全引擎复核，证据不足时不要删除。",
        "reason": reason,
        "confidence": "low",
        "notify": True,
        "ai_assessment": assessment,
        "basis": basis,
    }
