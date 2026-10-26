"""Read-only file inventory and conservative indicators, without a malware verdict.

Every regular file is hashed in full; content heuristics inspect at most the first
256 KiB. Reparse points and cloud placeholders are skipped, never followed or
hydrated intentionally. Real antivirus signatures are supplied by Defender.
"""
from __future__ import annotations

import ctypes
from dataclasses import asdict, dataclass, field
import errno
import hashlib
import os
from pathlib import Path
import re
import stat
from typing import Callable, Iterator, Optional

from . import evidence


SAMPLE_LIMIT = 256 * 1024
READ_CHUNK = 1024 * 1024
EXECUTABLE_SUFFIXES = {
    ".exe", ".scr", ".com", ".pif", ".cpl", ".msi", ".bat", ".cmd",
    ".ps1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".hta", ".lnk",
}
DOCUMENT_SUFFIXES = {
    ".txt", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".mp3", ".mp4", ".csv",
}
SCRIPT_SUFFIXES = {
    ".ps1", ".bat", ".cmd", ".vbs", ".vbe", ".js", ".jse", ".wsf",
    ".wsh", ".hta", ".py", ".pyw",
}
BIDI_CONTROLS = set("\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")


@dataclass
class Finding:
    path: str
    source: str
    severity: str
    reasons: list[str] = field(default_factory=list)
    sha256: Optional[str] = None
    evidence: dict = field(default_factory=dict)
    verdict: dict = field(default_factory=dict)
    identity: dict = field(default_factory=dict)
    explanation: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ScanStats:
    files: int = 0
    bytes_read: int = 0
    skipped: int = 0
    errors: int = 0
    cancelled: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


def discover_drives(include_removable: bool = True) -> list[Path]:
    """Return mounted local drive letters; network and optical drives are excluded."""
    if os.name != "nt":
        return [Path("/")]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetLogicalDrives.argtypes = []
    kernel.GetLogicalDrives.restype = ctypes.c_uint32
    kernel.GetDriveTypeW.argtypes = [ctypes.c_wchar_p]
    kernel.GetDriveTypeW.restype = ctypes.c_uint32
    mask = kernel.GetLogicalDrives()
    if not mask:
        raise ctypes.WinError(ctypes.get_last_error())
    allowed = {3, 2} if include_removable else {3}
    return [
        Path(chr(65 + index) + ":\\")
        for index in range(26)
        if mask & (1 << index)
        and kernel.GetDriveTypeW(chr(65 + index) + ":\\") in allowed
    ]


def _unsafe_reason(info: os.stat_result) -> Optional[str]:
    attrs = getattr(info, "st_file_attributes", 0)
    if stat.S_ISLNK(info.st_mode) or attrs & 0x400:
        return "符号链接、目录联接或其他重解析点，未跟随"
    if attrs & (0x1000 | 0x40000 | 0x400000):
        return "离线文件或云占位文件，未下载其内容"
    if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
        return "非常规文件，未打开"
    return None


def _validate_ancestors(path: Path) -> None:
    """Reject an explicitly supplied root or file below an observed junction."""
    for ancestor in reversed(path.parents):
        info = ancestor.lstat()
        reason = _unsafe_reason(info)
        if reason:
            raise OSError(errno.ELOOP, reason, str(ancestor))


def walk_files(
    roots: list[Path],
    on_skip: Optional[Callable[[Path, str], None]] = None,
    stop: Optional[Callable[[], bool]] = None,
) -> Iterator[Path]:
    """Yield regular files without resolving links; report every observed omission."""
    report = on_skip or (lambda path, reason: None)
    stopped = stop or (lambda: False)
    seen_dirs = set()
    seen_roots = set()
    for requested in roots:
        if stopped():
            return
        root = Path(os.path.abspath(os.fspath(requested)))
        root_key = os.path.normcase(str(root))
        if root_key in seen_roots:
            continue
        seen_roots.add(root_key)
        try:
            _validate_ancestors(root)
        except OSError as exc:
            report(root, str(exc))
            continue
        pending = [root]
        while pending:
            if stopped():
                return
            current = pending.pop()
            try:
                info = current.lstat()
                reason = _unsafe_reason(info)
                if reason:
                    report(current, reason)
                    continue
                if stat.S_ISREG(info.st_mode):
                    yield current
                    continue
                identity = (info.st_dev, info.st_ino) if info.st_ino else os.path.normcase(str(current))
                if identity in seen_dirs:
                    continue
                seen_dirs.add(identity)
                with os.scandir(current) as entries:
                    for entry in entries:
                        if stopped():
                            return
                        child = Path(entry.path)
                        try:
                            child_info = entry.stat(follow_symlinks=False)
                            reason = _unsafe_reason(child_info)
                            if reason:
                                report(child, reason)
                            elif stat.S_ISDIR(child_info.st_mode):
                                pending.append(child)
                            else:
                                yield child
                        except OSError as exc:
                            report(child, str(exc))
            except OSError as exc:
                report(current, str(exc))


def _open_readonly(path: Path):
    """On Windows, don't open the final reparse target or recall offline storage."""
    if os.name != "nt":
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        return os.fdopen(descriptor, "rb")
    import msvcrt

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [
        ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
        ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
    ]
    kernel.CreateFileW.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.CloseHandle.restype = ctypes.c_int
    # OPEN_REPARSE_POINT | OPEN_NO_RECALL | SEQUENTIAL_SCAN; no write access.
    native_path = str(path)
    if not native_path.startswith("\\\\?\\"):
        native_path = ("\\\\?\\UNC\\" + native_path[2:] if native_path.startswith("\\\\")
                       else "\\\\?\\" + native_path)
    handle = kernel.CreateFileW(native_path, 0x80000000, 1 | 2 | 4, None, 3,
                                0x00200000 | 0x00100000 | 0x08000000, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    except BaseException:
        kernel.CloseHandle(handle)
        raise
    return os.fdopen(descriptor, "rb")


def _decode_script(sample: bytes) -> str:
    if sample.startswith((b"\xff\xfe", b"\xfe\xff")):
        return sample.decode("utf-16", errors="replace")
    return sample.decode("utf-8-sig", errors="replace")


def _indicators(path: Path, sample: bytes) -> list[str]:
    reasons = []
    suffixes = [part.lower() for part in path.suffixes]
    suffix = suffixes[-1] if suffixes else ""
    if len(suffixes) > 1 and suffix in EXECUTABLE_SUFFIXES and suffixes[-2] in DOCUMENT_SUFFIXES:
        reasons.append("文档/图片扩展名后又带可执行扩展名，可能误导打开操作")
    if BIDI_CONTROLS.intersection(path.name):
        reasons.append("文件名包含双向文本控制符，显示顺序可能掩盖真实扩展名")
    if sample.startswith(b"MZ") and suffix in DOCUMENT_SUFFIXES:
        reasons.append("文件开头含 MZ 可执行格式标记，与文档/媒体扩展名不一致，需核实")
    if suffix not in SCRIPT_SUFFIXES:
        return reasons
    text = _decode_script(sample)
    # Individual admin commands or a network URL alone are not a finding.
    network = re.search(r"(?:https?://|downloadstring\s*\(|invoke-webrequest\b|\bwebclient\b|\biwr\s)", text, re.I)
    execution = re.search(r"(?:\biex\b|invoke-expression\b|\beval\s*\(|\bexec\s*\(|\bexecute(?:global)?\s*\(|\bwscript\.shell\b)", text, re.I)
    if network and execution:
        reasons.append("脚本同时包含网络获取与动态执行指令，需人工核实其用途")
    encoded = re.search(r"-(?:encodedcommand|enc)\s+[a-z0-9+/]{40,}={0,2}(?:\s|$)", text, re.I)
    launch = re.search(r"\b(?:powershell|pwsh)(?:\.exe)?\b", text, re.I)
    if encoded and launch:
        reasons.append("脚本启动 PowerShell 并携带较长编码命令，需检查编码内容")
    if re.search(r"frombase64string\s*\(", text, re.I) and execution and network:
        reasons.append("网络执行逻辑还包含 Base64 解码，可能隐藏实际指令")
    return reasons


def scan_file(
    path: Path,
    stop: Optional[Callable[[], bool]] = None,
) -> tuple[Optional[Finding], int]:
    """Hash a whole unchanged regular file and return bounded suspicious indicators.

    Raises OSError on access failures, changing files, links or placeholders.
    Cancellation raises InterruptedError; callers must record incomplete coverage.
    """
    stopped = stop or (lambda: False)
    if stopped():
        raise InterruptedError("扫描已取消")
    path = Path(os.path.abspath(os.fspath(path)))
    _validate_ancestors(path)
    before = path.lstat()
    reason = _unsafe_reason(before)
    if reason or not stat.S_ISREG(before.st_mode):
        raise OSError(errno.EINVAL, reason or "非常规文件，未打开", str(path))
    digest = hashlib.sha256()
    sample = bytearray()
    total = 0
    with _open_readonly(path) as stream:
        opened = os.fstat(stream.fileno())
        reason = _unsafe_reason(opened)
        if reason or not stat.S_ISREG(opened.st_mode):
            raise OSError(errno.EINVAL, reason or "非常规文件，未打开", str(path))
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            raise OSError(errno.ESTALE, "文件在打开前发生变化，未继续读取", str(path))
        while True:
            if stopped():
                raise InterruptedError("扫描已取消")
            chunk = stream.read(READ_CHUNK)
            if not chunk:
                break
            digest.update(chunk)
            total += len(chunk)
            if len(sample) < SAMPLE_LIMIT:
                sample.extend(chunk[:SAMPLE_LIMIT - len(sample)])
        after = os.fstat(stream.fileno())
        if opened.st_size != after.st_size or opened.st_mtime_ns != after.st_mtime_ns or total != after.st_size:
            raise OSError(errno.ESTALE, "读取期间文件发生变化，结果不可靠", str(path))
    reasons = _indicators(path, bytes(sample))
    facts = {}
    if reasons or path.suffix.lower() in evidence.SCRIPT_SUFFIXES or sample.startswith(b"MZ"):
        facts = evidence.from_sample(path, bytes(sample), total)
        script = set(facts.get("script_features", []))
        capabilities = set(facts.get("pe_import_categories", []))
        if {"network_fetch", "credential_access"} <= script:
            reasons.append("脚本同时出现网络获取与凭据访问特征，交由 AI 自动评估")
        if "defense_evasion" in script and script & {"encoded_command", "persistence", "destructive_commands"}:
            reasons.append("脚本同时出现防护规避与持久化、编码或破坏操作特征，交由 AI 自动评估")
        if "process_injection" in capabilities and capabilities & {"network", "memory_execution"}:
            reasons.append("PE 导入包含进程注入与网络或内存执行能力组合，交由 AI 自动评估")
    if not reasons:
        return None, total
    return Finding(str(path), "heuristic", "medium" if len(reasons) > 1 else "low", reasons,
                   digest.hexdigest(), evidence=facts), total
