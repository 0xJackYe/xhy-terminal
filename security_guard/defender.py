"""Read-only Microsoft Defender integration for Windows.

Every scan is custom and includes -DisableRemediation. Do not replace this with
Start-MpScan or ScanType 2: those can remediate detections. Independent real-time
protection remains enabled and is outside this program's control.

Microsoft documents exit code 2 as either detection OR a scan error:
https://learn.microsoft.com/en-us/defender-endpoint/command-line-arguments-microsoft-defender-antivirus
"""
from __future__ import annotations

import codecs
import ctypes
from dataclasses import dataclass, field
import json
import locale
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
from typing import Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from .scanner import Finding

WINDOWS = os.name == "nt"
MAX_CAPTURE = 2 * 1024 * 1024
MAX_LINE = 32768


@dataclass
class DefenderResult:
    target: str
    status: str
    returncode: int | None = None
    findings: list[Finding] = field(default_factory=list)
    detail: str = ""
    coverage_incomplete: bool = False


def _version(path: Path) -> tuple[int, ...]:
    if not re.fullmatch(r"\d+(?:\.\d+)+(?:-\d+)?", path.name):
        return ()
    return tuple(int(part) for part in re.split(r"[.-]", path.name))


def find_engine() -> Path | None:
    """Use the newest official platform directory, never search executable PATH."""
    if not WINDOWS:
        return None
    platform = Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "Microsoft" / "Windows Defender" / "Platform"
    try:
        versions = sorted((p for p in platform.iterdir() if _version(p)), key=_version, reverse=True)
    except OSError:
        versions = []
    for directory in versions:
        candidate = directory / "MpCmdRun.exe"
        try:
            if not directory.is_symlink() and candidate.is_file() and not candidate.is_symlink():
                return candidate
        except OSError:
            continue
    fallback = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Windows Defender" / "MpCmdRun.exe"
    try:
        return fallback if fallback.is_file() and not fallback.is_symlink() else None
    except OSError:
        return None


def build_scan_command(engine: Path, target: Path) -> list[str]:
    # An argument list with shell=False preserves spaces and shell metacharacters.
    # resolve() is deliberately avoided: the scanner owns reparse-point policy.
    return [str(engine), "-Scan", "-ScanType", "3", "-File", os.path.abspath(str(target)), "-DisableRemediation"]


def validate_scan_target(target: Path) -> Path:
    """Match the local scanner's root policy before delegating any traversal.

    Do not resolve a link before checking it: that would hide an unsafe root or
    ancestor from lstat. The check is a preflight, not a race-free filesystem
    snapshot; Defender remains responsible for its own recursive traversal.
    """
    from .scanner import _unsafe_reason, _validate_ancestors

    target = Path(os.path.abspath(os.fspath(target)))
    _validate_ancestors(target)
    info = target.lstat()
    reason = _unsafe_reason(info)
    if reason:
        raise OSError(reason)
    return target


def _powershell() -> Path:
    return Path(os.environ.get("WINDIR", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"


def status() -> dict:
    """Read engine health; never enable/disable settings, update, or remediate."""
    engine = find_engine()
    result = {"available": engine is not None, "engine": str(engine) if engine else None,
              "enabled": None, "realtime_enabled": None, "signature_updated": None,
              "signature_age_days": None, "signature_version": None, "running_mode": None,
              "error": None}
    if not WINDOWS:
        result["error"] = "Microsoft Defender 扫描仅支持 Windows。"
        return result
    script = (
        "$ErrorActionPreference='Stop';"
        "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);"
        "$s=Get-MpComputerStatus;"
        "[ordered]@{enabled=([bool]$s.AMServiceEnabled -and [bool]$s.AntivirusEnabled);"
        "realtime_enabled=[bool]$s.RealTimeProtectionEnabled;"
        "signature_updated=$s.AntivirusSignatureLastUpdated.ToString('o');"
        "signature_age_days=$s.AntivirusSignatureAge;"
        "signature_version=$s.AntivirusSignatureVersion;"
        "running_mode=$s.AMRunningMode} | ConvertTo-Json -Compress"
    )
    try:
        completed = subprocess.run([str(_powershell()), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20,
                                   shell=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if completed.returncode:
            result["error"] = "无法读取 Defender 状态；请确认服务可用，必要时以管理员身份运行。"
        else:
            payload = json.loads(completed.stdout.decode("utf-8-sig"))
            if not isinstance(payload, dict) or type(payload.get("enabled")) is not bool:
                raise ValueError("Invalid Defender status")
            for key in ("enabled", "realtime_enabled", "signature_updated", "signature_age_days", "signature_version", "running_mode"):
                result[key] = payload.get(key)
    except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired):
        result["error"] = "读取 Defender 状态失败或超时；未更改任何系统设置。"
    return result


_THREAT = re.compile(r"^\s*(?:Threat(?:\s+Name)?|威胁(?:名称)?)\s*[:：]\s*(\S.*?)\s*$", re.I)
_RESOURCE = re.compile(r"^\s*(file|containerfile|resource|resources|文件|容器文件|资源)\s*[:：]\s*(.+?)\s*$", re.I)
_ABSOLUTE = re.compile(r"^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+[\\/])")


def parse_findings(output: str) -> tuple[list[Finding], bool]:
    """Parse labelled detections only. Unknown/localized output remains in logs.

    A path is included only after an explicit threat label and resource label.
    The scanner target is never invented as a detected file. Archive member
    references are reduced to their physical container, never executed/opened.
    """
    from .scanner import Finding
    current = None
    detected = False
    findings = []
    seen = set()
    for raw in output.splitlines():
        line = raw[:MAX_LINE]
        threat = _THREAT.match(line)
        if threat:
            name = threat.group(1).strip()
            if name.lower() not in ("none", "not found", "no threats", "0", "无", "未发现", "无威胁"):
                current = name[:512]
                detected = True
            else:
                current = None
            continue
        resource = _RESOURCE.match(line)
        if not resource or current is None:
            continue
        path = resource.group(2).strip().strip('"')
        # Event-format resource prefixes can appear even in console output.
        path = re.sub(r"^(?:containerfile|file):_?", "", path, flags=re.I)
        path = path.split("->", 1)[0].strip().strip('"')
        if not _ABSOLUTE.match(path) or any(ord(c) < 32 for c in path):
            continue
        identity = (path.casefold(), current.casefold())
        if identity not in seen:
            seen.add(identity)
            findings.append(Finding(path=path, source="defender", severity="high",
                                    reasons=["Microsoft Defender 检测：" + current]))
    return findings, detected


def classify_result(target: Path, returncode: int, output: str) -> DefenderResult:
    findings, detected = parse_findings(output)
    # Explicit threat output is retained even if the engine encountered another
    # error later. Exit 2 alone is never reported as confirmed malware.
    if detected:
        detail = "Defender 报告检测；本次扫描未执行处置。"
        incomplete = not findings or returncode not in (0, 2)
        if not findings:
            detail += "未能解析具体文件路径，请查看原始 Defender 日志。"
        if returncode not in (0, 2):
            detail += "扫描同时出现错误，未能确认完整完成。"
        # Code 2 can also combine a detection with a scan failure. Only explicit
        # scan/error labels are considered, never filenames containing 'error'.
        if re.search(r"^\s*(?:ERROR\s*[:：]|Scan\b[^\r\n]*(?:failed|error)|错误\s*[:：]|扫描[^\r\n]*(?:失败|错误))", output, re.I | re.M):
            incomplete = True
            detail += "输出同时报告扫描错误，覆盖范围不完整。"
        return DefenderResult(str(target), "threat", returncode, findings, detail, incomplete)
    if returncode == 0:
        return DefenderResult(str(target), "clean", returncode, [], "Defender 本次扫描未报告检测；不代表保证无病毒。")
    if returncode == 2:
        detail = "Defender 返回 2（可能是检测或扫描错误），未取得明确检测证据；请查看原始日志。"
    else:
        detail = "Defender 扫描失败（返回码 %s）；请检查服务、权限及原始日志。" % returncode
    return DefenderResult(str(target), "error", returncode, [], detail, True)


def _output_encoding() -> str:
    if WINDOWS:
        try:
            page = ctypes.windll.kernel32.GetConsoleOutputCP()
            if page:
                return "cp%d" % page
        except (OSError, AttributeError):
            pass
    return locale.getpreferredencoding(False) or "utf-8"


def run_scan(target: Path, on_output: Callable[[str], None] | None = None,
             stop: Callable[[], bool] | None = None) -> DefenderResult:
    """Stream a custom, no-remediation scan without blocking cancellation.

    Cancelling terminates only the subprocess owned by this call. Defender's
    service may finish an already submitted read-only scan; -Cancel is not used
    because Microsoft documents it for quick/full scans and it could affect an
    unrelated scan. No global process/service is terminated.
    """
    stop = stop or (lambda: False)
    if stop():
        return DefenderResult(str(target), "cancelled", detail="扫描已取消。", coverage_incomplete=True)
    engine = find_engine()
    if engine is None:
        return DefenderResult(str(target), "error", detail="未找到 Microsoft Defender 引擎；仅能运行本地可疑特征检查。", coverage_incomplete=True)
    try:
        target = validate_scan_target(target)
    except OSError as exc:
        return DefenderResult(str(target), "error", detail="Defender 未扫描此位置：%s" % exc,
                              coverage_incomplete=True)
    try:
        process = subprocess.Popen(build_scan_command(engine, target), stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, bufsize=0, shell=False,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except OSError:
        return DefenderResult(str(target), "error", detail="无法启动 Defender 扫描；请检查权限及引擎可用性。", coverage_incomplete=True)
    chunks = queue.Queue(maxsize=128)
    finished = threading.Event()

    def read_output():
        try:
            while not finished.is_set():
                data = process.stdout.read(4096)
                if not data:
                    break
                while not finished.is_set():
                    try:
                        chunks.put(data, timeout=0.2)
                        break
                    except queue.Full:
                        pass
        except (OSError, ValueError):
            # The owner can close the pipe while cancelling this subprocess.
            pass
        finally:
            finished.set()

    reader = threading.Thread(target=read_output, name="defender-output", daemon=True)
    reader.start()
    decoder = codecs.getincrementaldecoder(_output_encoding())(errors="replace")
    captured = []
    captured_size = 0
    truncated = False
    cancelled = False
    try:
        while not finished.is_set() or not chunks.empty() or process.poll() is None:
            if stop():
                cancelled = True
                break
            try:
                data = chunks.get(timeout=0.2)
            except queue.Empty:
                continue
            text = decoder.decode(data)
            if on_output:
                on_output(text)
            if captured_size < MAX_CAPTURE:
                remaining = MAX_CAPTURE - captured_size
                captured.append(text[:remaining])
                captured_size += len(captured[-1])
                if len(text) > remaining:
                    truncated = True
            else:
                truncated = True
        if not cancelled:
            tail = decoder.decode(b"", final=True)
            if tail:
                if on_output:
                    on_output(tail)
                remaining = max(0, MAX_CAPTURE - captured_size)
                captured.append(tail[:remaining])
                if len(tail) > remaining:
                    truncated = True
            process.wait(timeout=5)
    except KeyboardInterrupt:
        cancelled = True
    finally:
        finished.set()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        process.stdout.close()
        reader.join(timeout=1)
    if cancelled:
        findings, _detected = parse_findings("".join(captured))
        return DefenderResult(str(target), "cancelled", process.returncode, findings,
                              "已停止等待本次扫描。Defender 服务可能继续完成已提交的只读扫描。", True)
    result = classify_result(target, process.returncode, "".join(captured))
    if truncated:
        result.detail += "检测解析超过 2 MiB 上限，详细输出见原始日志，可能仍有未列出的检测。"
        result.coverage_incomplete = True
        if result.status == "clean":
            result.status = "error"
    return result
