"""CMD interface. Findings can only open Explorer; source files are never changed."""
from __future__ import annotations

import argparse
import ctypes
from dataclasses import asdict
import datetime as dt
import getpass
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import threading
import time
import unicodedata
import uuid

from . import deepseek, defender, identity, reviewer, scanner, triage

DATA = Path(__file__).resolve().parent.parent / ".local" / "security-guard"
REPORTS = DATA / "reports"
BEIJING = dt.timezone(dt.timedelta(hours=8))
MAX_SUMMARY = 1000
AI_BATCH_SIZE = 4
EXPLANATION_FIELDS = (
    ("file_type", "文件是什么"), ("purpose", "主要用途"),
    ("likely_origin", "可能来源"), ("observed_behavior", "内容分析"),
    ("deletion_impact", "删除影响"), ("limitations", "分析局限"),
)


def safe_text(value, limit=1800):
    value = str(value)
    return "".join(
        c if unicodedata.category(c) not in ("Cc", "Cf", "Cs") else
        (" " if c in "\r\n\t" else "\\u%04x" % ord(c))
        for c in value[:limit]
    )


def say(value=""):
    print(safe_text(value), flush=True)


def report_identity(value):
    """Preserve metadata and sharing state without retaining uploaded excerpts."""
    if not isinstance(value, dict):
        return {}
    result = identity.safe_report_identity(value)
    result["excerpt_chars_sent"] = len(value.get("source_excerpt", "")) if isinstance(value.get("source_excerpt"), str) else 0
    return result


def show_explanation(finding):
    if finding.explanation:
        for name, label in EXPLANATION_FIELDS:
            say(label + "：" + safe_text(finding.explanation.get(name) or "暂未获得说明。", 1200))


def explanation_text(finding):
    lines = ["文件：" + safe_text(finding.path)]
    lines.extend(label + "：" + safe_text(finding.explanation.get(name) or "暂未获得说明。", 1200)
                 for name, label in EXPLANATION_FIELDS)
    lines.extend(["风险建议：" + safe_text(finding.verdict.get("label", "尚未完成")),
                  "处理建议：" + safe_text(finding.verdict.get("recommendation", "建议保留"))])
    return "\n".join(lines) + "\n\n"


def confirm_content_share(path, metadata):
    """Consent concerns external content sharing, never file deletion."""
    text = ("为了说明这个文件的用途，需要把脱敏后的内容片段发送给 DeepSeek。\n\n"
        + safe_text(path, 650) + "\n\n发送：文件名、类型、属性、签名，以及最多 6000 字符的脚本/文本片段。\n"
        "接收方：api.deepseek.com。不会执行文件或上传完整文件。\n"
        "会遮盖可识别的密钥等信息，但脱敏无法保证去掉所有私人内容。\n\n"
        "【是】允许本次发送此文件的脱敏片段。\n【否】只用属性分析，内容留在电脑上。")
    if os.name == "nt":
        try:
            message = ctypes.WinDLL("user32", use_last_error=True).MessageBoxW
            message.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint)
            message.restype = ctypes.c_int
            result = message(None, text, "AI 文件说明 · 内容分享确认", 0x10000 | 0x100 | 0x40 | 0x4)
            if result:
                return result == 6
        except (OSError, AttributeError):
            pass
    if not sys.stdin.isatty():
        return False
    say(text)
    return input("允许发送这个文件的脱敏片段？[y/N] ").strip().lower() == "y"


def normalized_roots(values):
    roots = []
    for value in values:
        path = Path(os.path.abspath(os.path.expanduser(str(value))))
        if not any(path == item or item in path.parents for item in roots):
            roots = [item for item in roots if path not in item.parents]
            roots.append(path)
    return roots


def inside(path, directory):
    try:
        path.relative_to(directory)
        return True
    except ValueError:
        return False


def open_file_location(value):
    """Invoke only the OS file manager, never a suspect file or shell command."""
    if os.name != "nt":
        return False
    path = Path(value)
    if not path.is_absolute() or len(path.drive) != 2 or path.drive[1:] != ":":
        return False
    try:
        scanner._validate_ancestors(path)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or scanner._unsafe_reason(info):
            return False
        executable = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "explorer.exe"
        subprocess.Popen([str(executable), "/select,", str(path)], shell=False,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except OSError:
        return False


def alert_finding(finding):
    unresolved = finding.source == "defender_unresolved"
    verdict = finding.verdict or triage.make_verdict(finding)
    say("[待你确认] " + ("Defender 检测到威胁，具体文件未解析" if unresolved else finding.path))
    show_explanation(finding)
    say("自动结论：" + verdict["label"])
    say("建议：" + verdict["recommendation"])
    say("判断理由：" + verdict["reason"])
    for reason in finding.reasons:
        say("  " + reason)
    text = (
        ("Defender 检测到威胁，但未能解析具体文件。\n\n" if unresolved else
         "发现需要检查的文件：\n\n" + safe_text(finding.path, 900) + "\n\n") +
        "\n".join(label + "：" + safe_text(finding.explanation.get(name) or "暂未获得说明。", 180)
                    for name, label in EXPLANATION_FIELDS) + "\n\n" +
        "风险结论：" + safe_text(verdict["label"], 120) +
        "\n建议：" + safe_text(verdict["recommendation"], 400) +
        "\n理由：" + safe_text(verdict["reason"], 400) +
        "\n\n扫描依据：\n" + "\n".join(safe_text(x, 240) for x in finding.reasons[:3]) +
        "\n\n是否现在打开位置进行手动处理？\n" +
        ("【是】在终端查看日志路径，检查后由你亲手操作。\n" if unresolved else
         "【是】仅打开文件所在位置，是否删除由你亲手操作。\n") +
        "【否】保留文件，结果已记入报告。\n程序不会删除、隔离或运行该文件。"
    )
    confirmed = False
    if os.name == "nt":
        try:
            message = ctypes.WinDLL("user32", use_last_error=True).MessageBoxW
            message.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint)
            message.restype = ctypes.c_int
            # Yes/No, warning, default NO, bring the dialog to the foreground.
            result = message(None, text, "XHY 安全卫士 · 手动处理确认", 0x10000 | 0x100 | 0x30 | 0x4)
            if result:
                confirmed = result == 6
            else:
                raise OSError("无法显示提示窗口")
        except (OSError, AttributeError):
            say("弹窗不可用，改为终端确认。")
            confirmed = terminal_confirmation()
    else:
        confirmed = terminal_confirmation()
    if confirmed and unresolved:
        say("请查看上面的 Defender 日志路径，核实具体文件后再手动处理。")
    elif confirmed and not open_file_location(finding.path):
        say("无法安全定位该文件；请根据报告中的路径自行检查。未修改文件。")
    return "requested_manual_review" if confirmed else "kept"


def terminal_confirmation():
    if not sys.stdin.isatty():
        say("当前无交互终端，保留文件。请启动程序查看报告后手动处理。")
        return False
    return input("是否定位文件供你手动处理？[y/N] ").strip().lower() == "y"


class Report:
    """Append and flush evidence before showing a dialog, including on interruption."""
    def __init__(self, roots, local_only):
        stamp = dt.datetime.now(BEIJING).strftime("%Y%m%d-%H%M%S")
        self.directory = REPORTS / (stamp + "-" + uuid.uuid4().hex[:8])
        self.directory.mkdir(parents=True, exist_ok=False)
        self.handles = {}
        self.data = {
            "version": 3, "started_at": dt.datetime.now(BEIJING).isoformat(),
            "roots": [str(p) for p in roots], "mode": "local_only" if local_only else "local_and_defender",
            "status": "running", "findings_count": 0, "findings": [], "defender": [],
            "ai": None, "ai_error": None, "files_modified_by_program": 0, "generated_report_files_skipped": 0,
            "verdict_counts": {"confirmed_threat": 0, "high_risk": 0, "low_risk": 0, "uncertain": 0},
            "scope_note": "已分配盘符的本地固定盘和可移动盘；跳过重解析点、离线占位符和无法读取的范围。",
            "finding_log": "findings.jsonl", "skip_log": "skipped.jsonl", "engine_log": "defender.log",
        }
        self.save()

    def append(self, name, value):
        if name not in self.handles:
            self.handles[name] = (self.directory / name).open("a", encoding="utf-8")
        handle = self.handles[name]
        handle.write(json.dumps(value, ensure_ascii=True) + "\n")
        handle.flush()

    def append_explanation(self, finding):
        name = "文件说明.txt"
        if name not in self.handles:
            self.handles[name] = (self.directory / name).open("a", encoding="utf-8")
        self.handles[name].write(explanation_text(finding))
        self.handles[name].flush()

    def save(self):
        temporary = self.directory / "report.json.tmp"
        temporary.write_text(json.dumps(self.data, ensure_ascii=True, indent=2), encoding="utf-8")
        os.replace(str(temporary), str(self.directory / "report.json"))

    def close(self):
        for handle in self.handles.values():
            handle.close()


def do_scan(roots, *, local_only=False, use_ai=True, model=None, notify=None,
            content_consent=None, content_mode="ask", force_analysis=False):
    roots = normalized_roots(roots)
    if not roots:
        say("未找到可扫描的本地磁盘；可用 --scan 指定文件夹。")
        return 2
    notify = notify or alert_finding
    report = Report(roots, local_only)
    stats = scanner.ScanStats()
    stop = threading.Event()
    stage = {"phase": "准备", "current": ""}
    seen = set()
    pending = []
    analysis = reviewer.AutoReviewer(enabled=use_ai, model=model,
        content_consent=content_consent or confirm_content_share, content_mode=content_mode)
    if force_analysis:
        report.data["mode"] = "file_explanation"
    last_checkpoint = time.monotonic()
    last_review = time.monotonic()
    incomplete = False

    def checkpoint(force=False):
        nonlocal last_checkpoint
        if force or time.monotonic() - last_checkpoint >= 3:
            report.data.update(stats=asdict(stats), phase=stage["phase"], current_file=stage["current"],
                               ai=dict(analysis.summary), ai_error=analysis.error)
            report.save()
            last_checkpoint = time.monotonic()

    def flush_pending(show_prompt=True):
        nonlocal last_review
        if not pending:
            return
        batch = list(pending)
        stage["phase"] = "AI 自动识别" if use_ai else "生成本地结论"
        checkpoint(force=True)
        classified = analysis.classify(batch)
        pending.clear()
        report.data["ai"] = analysis.summary
        report.data["ai_error"] = analysis.error
        for finding in classified:
            report.append("findings.jsonl", {"type": "analysis", "path": finding.path,
                "source": finding.source, "reasons": finding.reasons, "verdict": finding.verdict,
                "identity": report_identity(finding.identity), "explanation": finding.explanation})
            report.append_explanation(finding)
            report.data["verdict_counts"][finding.verdict["level"]] += 1
            for summary in report.data["findings"]:
                if summary["path"] == finding.path and summary["source"] == finding.source and summary["reasons"] == finding.reasons:
                    summary["verdict"] = finding.verdict
                    summary["identity"] = report_identity(finding.identity)
                    summary["explanation"] = finding.explanation
                    break
        # Preserve every completed verdict in this paid batch before the first
        # dialog, so interrupting one dialog cannot discard the other results.
        checkpoint(force=True)
        for finding in classified:
            say("[AI 文件说明] " + finding.path)
            show_explanation(finding)
            say("  结论：" + finding.verdict["label"] + "；建议：" + finding.verdict["recommendation"])
            if show_prompt and finding.verdict["notify"]:
                stage["phase"] = "已完成自动识别，等待你确认手动处理"
                checkpoint(force=True)
                choice = notify(finding)
            else:
                choice = "kept_low_risk" if not finding.verdict["notify"] else "pending_review_after_cancellation"
            report.append("findings.jsonl", {"type": "decision", "path": finding.path,
                "source": finding.source, "choice": choice})
        last_review = time.monotonic()

    def record(finding, show_prompt=True):
        identity = (os.path.normcase(finding.path), finding.source, tuple(finding.reasons))
        if identity in seen:
            return
        seen.add(identity)
        value = asdict(finding)
        value["identity"] = report_identity(finding.identity)
        report.data["findings_count"] += 1
        report.append("findings.jsonl", {"type": "finding", **value})
        if len(report.data["findings"]) < MAX_SUMMARY:
            report.data["findings"].append(value)
        # All candidates are persisted before automatic classification or dialogs.
        pending.append(finding)
        checkpoint(force=True)
        if not show_prompt:
            report.append("findings.jsonl", {"type": "decision", "path": finding.path,
                "source": finding.source, "choice": "pending_review_after_cancellation"})
            return
        if len(pending) >= AI_BATCH_SIZE or time.monotonic() - last_review >= 30:
            flush_pending()

    def skipped(path, reason):
        if inside(Path(path), report.directory):
            report.data["generated_report_files_skipped"] += 1
        else:
            stats.skipped += 1
        report.append("skipped.jsonl", {"path": str(path), "reason": str(reason)})

    def heartbeat():
        while not stop.wait(4):
            say("[%s] 文件 %s | 已读 %.1f MiB | 跳过 %s | 读取错误 %s | 候选项 %s" % (
                stage["phase"], stats.files, stats.bytes_read / 1048576,
                stats.skipped, stats.errors, report.data["findings_count"]))
            if stage["current"]:
                say("  " + stage["current"])

    say(("分析文件：" if force_analysis else "扫描范围：") + "、".join(str(p) for p in roots))
    say("正在读取文件属性和有限片段，不会运行文件。" if force_analysis else
        "只读扫描。全盘读取可能需要数小时；Ctrl+C 可停止并保存已有结果。")
    say("报告目录：" + str(report.directory))
    say("本程序不自动处置文件；系统实时防护仍独立运行。")
    say("AI 会先说明文件是什么、用途、来源、内容行为及删除影响，再给出风险建议。" if use_ai else
        "本次已禁用 AI，只展示本地引擎结论；证据不足时建议保留。")
    ticker = threading.Thread(target=heartbeat, daemon=True)
    ticker.start()
    try:
        stage["phase"] = "本地文件检查"
        for path in scanner.walk_files(roots, on_skip=skipped, stop=stop.is_set):
            if inside(path, report.directory):
                skipped(path, "本次扫描正在写入的报告，避免自扫描")
                continue
            stage["current"] = str(path)
            stage["phase"] = "本地文件检查"
            try:
                if force_analysis:
                    finding = scanner.Finding(str(path), "file_analysis", "unknown", ["用户要求分析文件是什么及具体用途"])
                    size = 0
                else:
                    finding, size = scanner.scan_file(path, stop=stop.is_set)
                stats.files += 1
                stats.bytes_read += size
                if finding:
                    record(finding)
                if pending and time.monotonic() - last_review >= 30:
                    flush_pending()
                checkpoint()
            except InterruptedError:
                stats.cancelled = True
                break
            except OSError as error:
                stats.errors += 1
                report.append("skipped.jsonl", {"path": str(path), "reason": safe_text(error)})
        if not stats.cancelled:
            flush_pending()
        if not local_only and not stats.cancelled:
            for root in roots:
                stage.update(phase="Defender 病毒库扫描", current=str(root))
                checkpoint(force=True)
                say("Defender 扫描：" + str(root) + "（禁用自动处置）")

                def engine_output(line):
                    report.append("defender.log", {"target": str(root), "output": line})
                    if line.strip():
                        say("  Defender: " + safe_text(line, 450))

                result = defender.run_scan(root, on_output=engine_output, stop=stop.is_set)
                report.data["defender"].append(asdict(result))
                report.save()
                if result.status == "cancelled":
                    stats.cancelled = True
                for finding in result.findings:
                    record(finding, show_prompt=not stats.cancelled)
                if result.status == "threat" and not result.findings:
                    record(scanner.Finding(path="", source="defender_unresolved", severity="high", reasons=[
                        "扫描范围：" + str(root), result.detail,
                        "检测输出日志：" + str(report.directory / "defender.log")]))
                if not stats.cancelled:
                    flush_pending()
                if getattr(result, "coverage_incomplete", False):
                    incomplete = True
                if result.status not in ("clean", "threat"):
                    incomplete = True
                    say("Defender 未完成：" + result.detail)
                if result.status == "cancelled":
                    break
        elif local_only:
            say("本次提供文件说明，未额外启动 Defender 病毒库扫描。" if force_analysis else
                "本次仅进行本地特征检查，没有病毒库结论。")

        if analysis.error:
            say(analysis.error + " 后续项目标为证据不足，保留文件。")
    except KeyboardInterrupt:
        stats.cancelled = True
        say("扫描已中止，正在保存已有结果。")
    except (OSError, RuntimeError) as error:
        incomplete = True
        report.data["error"] = safe_text(error)
        say("扫描未完成：" + safe_text(error))
    finally:
        stop.set()
        ticker.join(timeout=1)
        incomplete = incomplete or stats.errors > 0 or stats.skipped > 0
        report.data["stats"] = asdict(stats)
        report.data["ai"] = analysis.summary
        report.data["ai_error"] = analysis.error
        report.data["pending_analysis"] = max(0, report.data["findings_count"] - sum(report.data["verdict_counts"].values()))
        report.data["coverage_incomplete"] = incomplete or stats.cancelled
        report.data["status"] = "cancelled" if stats.cancelled else "incomplete" if incomplete else "completed"
        report.data["finished_at"] = dt.datetime.now(BEIJING).isoformat()
        report.save()
        report.close()
    say("结果：检查 %s 个文件，候选项 %s，跳过 %s，读取错误 %s。" % (
        stats.files, report.data["findings_count"], stats.skipped, stats.errors))
    if report.data["coverage_incomplete"]:
        say("存在未扫描或未完成的范围，详见报告。")
    elif not report.data["findings_count"]:
        say("本次扫描未发现可疑项；这不能保证电脑不存在恶意软件。")
    say("报告：" + str(report.directory / "report.json"))
    counts = report.data["verdict_counts"]
    say("自动结论：引擎检测 %s，高风险 %s，建议保留 %s，证据不足 %s。" % (
        counts["confirmed_threat"], counts["high_risk"], counts["low_risk"], counts["uncertain"]))
    if analysis.summary["requests"]:
        say("AI 请求 %s 次，完成识别 %s 项；已记录 Token %s%s。" % (
            analysis.summary["requests"], analysis.summary["reviewed"],
            analysis.summary["usage"]["total_tokens"],
            "（部分请求未返回用量，非完整总数）" if not analysis.summary["usage_complete"] else ""))
    if force_analysis:
        return 130 if stats.cancelled else 2 if incomplete or analysis.error or not use_ai else 1 if (
            counts["confirmed_threat"] or counts["high_risk"]) else 0
    return 130 if stats.cancelled else 2 if incomplete else 1 if report.data["findings_count"] else 0


def show_status():
    say("XHY 安全卫士 · 只读文件检查 + Defender + DeepSeek")
    say("Python: " + sys.version.split()[0])
    say("管理员权限：" + ("是" if os.name == "nt" and ctypes.windll.shell32.IsUserAnAdmin() else "否"))
    say("本地磁盘：" + "、".join(str(p) for p in scanner.discover_drives()))
    for name, value in defender.status().items():
        say("Defender %s: %s" % (name, value))
    for name, value in deepseek.key_status().items():
        say("DeepSeek %s: %s" % (name, value))
    say("Defender 无法运行时会明确标记，不会把本地规则扫描当作杀毒结论。")


def configure_key():
    key = getpass.getpass("输入 DeepSeek API key（隐藏输入，回车保存）：").strip()
    if not key:
        say("未更改配置。")
        return 0
    deepseek.save_api_key(key)
    say("已用当前 Windows 用户的 DPAPI 加密保存在本机。")
    return 0


def check_api(model=None):
    key = deepseek.load_api_key()
    if not key:
        say("尚未配置 API key，请选择配置密钥或使用 --configure-key。")
        return 2
    result = deepseek.DeepSeekClient(key, model=model or deepseek.DEFAULT_MODEL).check_connection()
    say("DeepSeek 连接成功：" + json.dumps(result, ensure_ascii=False))
    if result.get("model_available") is False:
        say("认证成功，但所选模型不可用。请通过 --model 指定账户可用的模型。")
        return 2
    return 0


def report_findings(directory):
    """Replay full append log with the classification that preceded each dialog."""
    finding_log = directory / "findings.jsonl"
    if not finding_log.is_file():
        return
    analyses = {}

    def entries():
        with finding_log.open(encoding="utf-8") as handle:
            while True:
                line = handle.readline(65537)
                if not line:
                    return
                if len(line) > 65536:
                    raise ValueError("报告条目过大，停止读取。")
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise ValueError("报告条目格式无效。")
                yield value

    def identity(value):
        return (value.get("path"), value.get("source"), tuple(str(x) for x in value.get("reasons", [])))

    for value in entries():
        if value.get("type") == "analysis" and isinstance(value.get("verdict"), dict):
            analyses[identity(value)] = value
    for value in entries():
        if value.get("type") != "finding":
            continue
        if not isinstance(value.get("path"), str) or not isinstance(value.get("reasons"), list):
            raise ValueError("报告条目格式无效。")
        saved = analyses.get(identity(value), {})
        finding = scanner.Finding(path=value["path"], source=value.get("source", "report"),
            severity=value.get("severity", "unknown"), reasons=[str(x) for x in value["reasons"]],
            sha256=value.get("sha256"), evidence=value.get("evidence") or {},
            verdict=saved.get("verdict") or value.get("verdict") or {},
            identity=saved.get("identity") or value.get("identity") or {},
            explanation=saved.get("explanation") or value.get("explanation") or {})
        if not finding.verdict:
            finding.verdict = triage.make_verdict(finding, ai_error="此项目尚无已保存的 AI 判断。")
        yield finding


def review_report(value=None, notify=None):
    notify = notify or alert_finding
    if value:
        path = Path(value)
        directory = path if path.is_dir() else path.parent
    else:
        choices = sorted(REPORTS.glob("*/report.json"), reverse=True)
        if not choices:
            say("尚无扫描报告。")
            return 0
        directory = choices[0].parent
    path = directory / "report.json"
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("报告过大，无法在终端读取。")
    data = json.loads(path.read_text(encoding="utf-8"))
    say("报告：" + str(path))
    say("扫描时间：%s；状态：%s；可疑项：%s" % (
        data.get("started_at"), data.get("status"), data.get("findings_count")))
    for finding in report_findings(directory):
        show_explanation(finding)
        say("[已保存结论] " + finding.path + "：" + safe_text(finding.verdict.get("label")))
        say("  建议：" + safe_text(finding.verdict.get("recommendation")))
        if finding.verdict.get("notify", True):
            notify(finding)
    return 0


def analyze_file(value, *, use_ai=True, model=None, content_mode="ask", content_consent=None, notify=None):
    path = normalized_roots([value])[0]
    scanner._validate_ancestors(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or scanner._unsafe_reason(info):
        raise ValueError("请选择本机常规文件；此入口用于说明一个文件是什么。")
    return do_scan([path], local_only=True, use_ai=use_ai, model=model, notify=notify,
        content_mode=content_mode, content_consent=content_consent, force_analysis=True)


def menu(*, local_only=False, use_ai=True, model=None, content_mode="ask"):
    say("XHY 安全卫士 / CMD · AI 文件说明")
    say("AI 会解释文件是什么、用途、来源和删除影响，再说明风险。删除必须由你手动完成。")
    scan_options = {"local_only": local_only, "use_ai": use_ai, "model": model}
    if content_mode != "ask":
        scan_options["content_mode"] = content_mode
    while True:
        print("\n1 全盘扫描    2 指定位置扫描    3 防护状态\n4 检测 DeepSeek 连接    5 配置密钥    6 查看最近报告\n7 AI 分析这个文件是什么    0 退出", flush=True)
        try:
            choice = input("请选择 > ").strip()
            if choice == "0":
                return 0
            if choice == "1":
                do_scan(scanner.discover_drives(), **scan_options)
            elif choice == "2":
                value = input("文件或文件夹路径（可直接粘贴）> ").strip().strip('"')
                if value:
                    do_scan([Path(value)], **scan_options)
            elif choice == "3":
                show_status()
            elif choice == "4":
                check_api(model)
            elif choice == "5":
                configure_key()
            elif choice == "6":
                review_report()
            elif choice == "7":
                value = input("要解释的文件路径 > ").strip().strip('"')
                if value:
                    analyze_file(value, use_ai=use_ai, model=model, content_mode=content_mode)
            else:
                say("请输入菜单编号。")
        except EOFError:
            return 0
        except KeyboardInterrupt:
            say("已返回菜单。输入 0 退出。")
        except (OSError, ValueError, RuntimeError) as error:
            say(safe_text(error))


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="XHY 安全卫士：AI 说明文件是什么、用途、来源、内容和删除影响，文件处置由用户手动完成。")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--all", action="store_true", help="扫描所有固定盘和已挂载可移动盘")
    group.add_argument("--scan", metavar="PATH", action="append", help="指定路径，可重复传入")
    group.add_argument("--status", action="store_true", help="查看 Defender 与密钥状态")
    group.add_argument("--configure-key", action="store_true", help="隐藏输入并加密保存 key")
    group.add_argument("--check-api", action="store_true", help="检测 DeepSeek 认证与可用模型")
    group.add_argument("--review", nargs="?", const="", metavar="REPORT", help="重新查看最近或指定扫描报告")
    group.add_argument("--analyze", "--explain", metavar="FILE", help="让 AI 说明指定文件是什么、用途、来源和删除影响")
    content = parser.add_mutually_exclusive_group()
    content.add_argument("--share-content", action="store_true", help="允许发送脱敏后的有限脚本/文本片段，敏感文件仍不发送内容")
    content.add_argument("--metadata-only", action="store_true", help="只根据文件属性说明，不发送任何内容片段")
    parser.add_argument("--local-only", action="store_true", help="仅检查本地特征，不调用 Defender")
    parser.add_argument("--no-ai", action="store_true", help="不向 DeepSeek 发送任何复核请求")
    parser.add_argument("--model", default=deepseek.DEFAULT_MODEL, help="DeepSeek 模型名称")
    args = parser.parse_args(argv)
    content_mode = "allow" if args.share_content else "metadata" if args.metadata_only else "ask"
    if os.name != "nt":
        say("此程序需要 Windows 10/11。")
        return 2
    try:
        if args.status:
            show_status()
            return 0
        if args.configure_key:
            return configure_key()
        if args.check_api:
            return check_api(args.model)
        if args.review is not None:
            return review_report(args.review or None)
        if args.analyze:
            return analyze_file(args.analyze, use_ai=not args.no_ai, model=args.model, content_mode=content_mode)
        if args.all or args.scan:
            return do_scan(scanner.discover_drives() if args.all else args.scan,
                           local_only=args.local_only, use_ai=not args.no_ai, model=args.model, content_mode=content_mode)
        return menu(local_only=args.local_only, use_ai=not args.no_ai, model=args.model, content_mode=content_mode)
    except KeyboardInterrupt:
        say("操作已停止。")
        return 130
    except (OSError, ValueError, RuntimeError) as error:
        say(safe_text(error))
        return 2
