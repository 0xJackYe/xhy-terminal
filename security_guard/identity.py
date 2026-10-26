"""Read-only file identity and consent-gated source excerpts for explanation.

File names and version resources help explain purpose but are not proof of
authenticity. Signature status is obtained separately, using a fixed PowerShell
command and LiteralPath. No scanned file is executed or modified.

API references:
https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-authenticodesignature
https://learn.microsoft.com/en-us/windows/win32/menurc/version-information-functions
"""
from __future__ import annotations

import errno
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import stat
import subprocess
import unicodedata
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode


SAMPLE_LIMIT = 65536
EXCERPT_CHARS = 6000
EXCERPT_BYTES = 12288
HASH_RECHECK_LIMIT = 8 * 1024 * 1024
LOCATION_CLASSES = {"windows_system", "program_files", "user_documents", "downloads", "temp", "startup", "other"}
FORMATS = {"pe", "script", "text", "archive", "pdf", "document", "image", "other"}
CONTENT_STATUSES = {"included", "withheld", "blocked_sensitive", "unsupported", "empty"}
SIGNATURE_STATUSES = {"valid", "unsigned", "invalid", "unavailable", "not_checked"}
SCRIPT_SUFFIXES = {".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".hta", ".cmd", ".bat", ".py", ".pyw", ".sh", ".rb", ".pl"}
SENSITIVE_SUFFIXES = {
    ".pem", ".key", ".pfx", ".p12", ".p7b", ".kdbx", ".wallet", ".dat",
    ".sqlite", ".sqlite3", ".db", ".mdb", ".accdb", ".sql", ".bak",
    ".doc", ".docx", ".docm", ".xls", ".xlsx", ".xlsm", ".ppt", ".pptx",
    ".pdf", ".csv", ".tsv", ".eml", ".msg", ".pst", ".ost",
}
VERSION_FIELDS = ("description", "company", "product", "original_filename", "file_version")


def _bounded_text(value, limit=240):
    if not isinstance(value, str):
        return ""
    return "".join(c for c in value[:limit] if unicodedata.category(c) not in {"Cc", "Cf", "Cs"}).strip()


def _redact_url(match):
    value = match.group(0)
    try:
        parts = urlsplit(value)
        hostname = parts.hostname or "[host]"
        if ":" in hostname and not hostname.startswith("["):
            hostname = "[" + hostname + "]"
        if parts.port:
            hostname += ":" + str(parts.port)
        query = urlencode([(name, "[REDACTED]") for name, _ in parse_qsl(parts.query, keep_blank_values=True)])
        return urlunsplit((parts.scheme, hostname, parts.path, query, ""))
    except ValueError:
        return "[REDACTED_URL]"


def redact_text(value, *, limit=EXCERPT_CHARS):
    """Best-effort minimization, not an assertion that private content is public."""
    if not isinstance(value, str):
        return ""
    value = value[:SAMPLE_LIMIT * 2]
    value = re.sub(r"-----BEGIN [A-Z ]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----.*?-----END [A-Z ]*PRIVATE KEY-----", "[REDACTED_PRIVATE_KEY]", value, flags=re.S)
    value = re.sub(r"\bsk-[A-Za-z0-9_.-]{8,}", "[REDACTED_API_KEY]", value)
    value = re.sub(r"\bAKIA[A-Z0-9]{16}\b", "[REDACTED_ACCESS_KEY]", value)
    value = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9_.+/=-]{8,}", "Bearer [REDACTED]", value)
    # Preserve the variable label so AI can explain the operation without values.
    value = re.sub(
        r'''(?im)(\b(?:password|passwd|pwd|secret|(?:api|access|private)[_-]?key|(?:access|refresh|auth)[_-]?token|token)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)''',
        r'\1"[REDACTED]"', value)
    value = re.sub(r"(?i)https?://[^\s\"'<>]+", _redact_url, value)
    value = re.sub(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[REDACTED_EMAIL]", value)
    value = re.sub(r"(?i)(?:[a-z]:[\\/](?:users|documents and settings)[\\/])[^\\/\s\"'<>]+", r"[USER_HOME]", value)
    value = re.sub(r"(?i)/(?:home|users)/[^/\s\"'<>]+", "[USER_HOME]", value)
    value = re.sub(r"\b[A-Fa-f0-9]{40,}\b", "[REDACTED_LONG_VALUE]", value)
    value = re.sub(r"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{80,}={0,2}(?![A-Za-z0-9+/])", "[REDACTED_LONG_VALUE]", value)
    value = "".join(c if c in "\n\t" or unicodedata.category(c) not in {"Cc", "Cf", "Cs"} else " " for c in value)
    value = value[:limit]
    return value.encode("utf-8", errors="replace")[:EXCERPT_BYTES].decode("utf-8", errors="ignore").strip()


def _sensitive(path):
    name = PureWindowsPath(str(path)).name.casefold()
    if name == ".env" or name.startswith(".env.") or name in {"id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "credentials.json", "secrets.json"}:
        return True
    if any(token in name for token in ("password", "passwd", "wallet", "private_key", "private-key", "api_key", "api-key", "secrets", "credential")):
        return True
    return PureWindowsPath(name).suffix in SENSITIVE_SUFFIXES


def _location(path):
    normalized = str(path).replace("/", "\\")
    folded = normalized.casefold()
    parts = PureWindowsPath(normalized).parts
    lower = [part.casefold() for part in parts]
    root = os.environ.get("SystemRoot", r"C:\Windows").rstrip("\\/")
    if folded.startswith(root.casefold() + "\\"):
        relative = normalized[len(root) + 1:].split("\\")
        technical = relative[:-1][:2]
        return "windows_system", _bounded_text("Windows/" + "/".join(technical), 240)
    for prefix in (os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")):
        if folded.startswith(prefix.rstrip("\\/").casefold() + "\\"):
            relative = normalized[len(prefix.rstrip("\\/")) + 1:].split("\\")
            return "program_files", _bounded_text("Program Files/" + "/".join(relative[:-1][:2]), 240)
    if "startup" in lower or "启动" in lower:
        return "startup", "用户或系统启动目录（私人路径已省略）"
    if "temp" in lower or "tmp" in lower:
        return "temp", "临时目录（私人路径已省略）"
    if "downloads" in lower or "下载" in lower:
        return "downloads", "下载目录（私人路径已省略）"
    if any(part in lower for part in ("documents", "desktop", "文档", "桌面")):
        return "user_documents", "用户文档目录（私人路径已省略）"
    return "other", "其他目录（完整路径未发送）"


def _decode(sample):
    if sample.startswith((b"\xff\xfe", b"\xfe\xff")):
        return sample.decode("utf-16", errors="replace")
    return sample.decode("utf-8-sig", errors="replace")


def _format(path, sample):
    suffix = path.suffix.casefold()
    if sample.startswith(b"MZ"):
        return "pe"
    if sample.startswith(b"%PDF"):
        return "pdf"
    if sample.startswith((b"PK\x03\x04", b"7z\xbc\xaf\x27\x1c", b"Rar!")):
        return "archive"
    if sample.startswith(b"\xd0\xcf\x11\xe0"):
        return "document"
    if sample.startswith((b"\x89PNG", b"\xff\xd8\xff", b"GIF87a", b"GIF89a")):
        return "image"
    if suffix in SCRIPT_SUFFIXES or sample.startswith(b"#!"):
        return "script"
    text = _decode(sample)
    if not sample or (sample.count(b"\0") <= len(sample) / 100 and text.count("\ufffd") <= max(1, len(text) / 100)):
        return "text"
    return "other"


def _native_metadata(path):
    result = {"version_info": {}, "signature": {"status": "not_checked", "publisher": ""}}
    if os.name != "nt" or path.suffix.casefold() not in {".exe", ".dll", ".sys", ".scr", ".cpl", ".msi", ".ps1", ".psm1", ".vbs", ".cmd", ".bat", ".ocx"}:
        return result
    executable = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    script = (
        "$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);"
        "$a=[Reflection.Assembly]::Load('Microsoft.PowerShell.Security, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35');"
        "Import-Module $a.Location -ErrorAction Stop;"
        "function cut([object]$x){$t=[string]$x;if($t.Length -gt 240){$t.Substring(0,240)}else{$t}};"
        "$p=$env:XHY_GUARD_IDENTITY_PATH;$v=[Diagnostics.FileVersionInfo]::GetVersionInfo($p);"
        "$s=Get-AuthenticodeSignature -LiteralPath $p;"
        "[ordered]@{version_info=[ordered]@{description=(cut $v.FileDescription);company=(cut $v.CompanyName);"
        "product=(cut $v.ProductName);original_filename=(cut $v.OriginalFilename);file_version=(cut $v.FileVersion)};"
        "signature=[ordered]@{status=([string]$s.Status);publisher=(cut $s.SignerCertificate.Subject)}}|ConvertTo-Json -Compress -Depth 4"
    )
    env = os.environ.copy()
    env["XHY_GUARD_IDENTITY_PATH"] = str(path)
    # The hosting shell can be PowerShell 7 and export incompatible module paths.
    # Use Windows PowerShell's own modules in this isolated reader process.
    env["PSModulePath"] = str(executable.parent / "Modules") + ";" + str(Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "WindowsPowerShell" / "Modules")
    try:
        completed = subprocess.run([str(executable), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, timeout=15, shell=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if completed.returncode or len(completed.stdout) > 16384:
            raise ValueError
        payload = json.loads(completed.stdout.decode("utf-8-sig"))
        if not isinstance(payload, dict):
            raise ValueError
        versions = payload.get("version_info", {})
        if isinstance(versions, dict):
            result["version_info"] = {key: redact_text(versions.get(key), limit=240) for key in VERSION_FIELDS}
        signature = payload.get("signature", {})
        statuses = {"Valid": "valid", "NotSigned": "unsigned", "HashMismatch": "invalid", "NotTrusted": "invalid", "NotSupportedFileFormat": "unavailable", "UnknownError": "unavailable", "Incompatible": "unavailable"}
        if isinstance(signature, dict):
            result["signature"] = {"status": statuses.get(signature.get("status"), "unavailable"),
                                   "publisher": redact_text(signature.get("publisher"), limit=240)}
    except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired):
        result["signature"] = {"status": "unavailable", "publisher": ""}
    return result


def _source_token(info):
    return hashlib.sha256(("%s:%s:%s:%s" % (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)).encode("ascii")).hexdigest()


def collect_identity(path: Path, expected_sha256: str | None = None, include_content: bool = False,
                     *, _known_metadata: dict | None = None) -> dict:
    """Collect local facts; include content only after the caller obtained consent.

    A provided hash is checked in full for files up to 8 MiB. Large-file identity
    uses a bounded sample and marks its hash as not rechecked rather than claiming
    an unperformed verification. Source identity/size/mtime are checked throughout.
    """
    from . import scanner

    path = Path(os.path.abspath(os.fspath(path)))
    if expected_sha256 is not None and (not isinstance(expected_sha256, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", expected_sha256)):
        raise ValueError("预期文件哈希格式无效。")
    scanner._validate_ancestors(path)
    before = path.lstat()
    if _known_metadata is not None and _known_metadata.get("_source_token") != _source_token(before):
        raise OSError(errno.ESTALE, "文件在内容授权前发生变化，请重新分析")
    reason = scanner._unsafe_reason(before)
    if reason or not stat.S_ISREG(before.st_mode):
        raise OSError(errno.EINVAL, reason or "仅能分析常规文件")
    recheck = expected_sha256 is not None and before.st_size <= HASH_RECHECK_LIMIT
    digest = hashlib.sha256() if recheck else None
    with scanner._open_readonly(path) as stream:
        opened = os.fstat(stream.fileno())
        if scanner._unsafe_reason(opened) or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise OSError(errno.ESTALE, "文件在打开前发生变化")
        sample = stream.read(SAMPLE_LIMIT)
        if digest:
            digest.update(sample)
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
        after = os.fstat(stream.fileno())
        if opened.st_size != after.st_size or opened.st_mtime_ns != after.st_mtime_ns:
            raise OSError(errno.ESTALE, "文件在分析期间发生变化")
    if digest and digest.hexdigest() != expected_sha256.casefold():
        raise OSError(errno.ESTALE, "文件内容已改变，请重新扫描后分析")
    location_class, location_hint = _location(path)
    actual_format = _format(path, sample)
    result = {
        "basename": redact_text(path.name, limit=180), "location_class": location_class,
        "location_hint": redact_text(location_hint, limit=240), "size_bytes": before.st_size,
        "actual_format": actual_format, "content_status": "withheld", "content_authorized": bool(include_content),
        "content_eligible": not _sensitive(path) and actual_format in {"script", "text", "pe"},
        "source_excerpt": "", "content_sample_bytes": len(sample), "sample_complete": before.st_size <= len(sample),
        "sha256_verification": "matched" if digest else "not_requested" if expected_sha256 is None else "not_rechecked_large_file",
    }
    if _known_metadata is None:
        result.update(_native_metadata(path))
    else:
        prepared_metadata = prepare_identity_for_ai(_known_metadata)
        result.update(version_info=prepared_metadata.get("version_info", {}),
                      signature=prepared_metadata.get("signature", {"status": "not_checked", "publisher": ""}))
    final = path.lstat()
    if scanner._unsafe_reason(final) or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns):
        raise OSError(errno.ESTALE, "文件属性在分析期间发生变化")
    if _sensitive(path):
        result["content_status"] = "blocked_sensitive"
    elif include_content and not sample:
        result["content_status"] = "empty"
    elif include_content and actual_format in {"script", "text"}:
        text = _decode(sample)
        result["source_excerpt"] = redact_text(text)
        result["content_status"] = "included" if result["source_excerpt"] else "empty"
        # sample_complete describes the uploaded excerpt, not just local reading.
        result["sample_complete"] = before.st_size <= len(sample) and len(result["source_excerpt"]) >= len(text.strip())
    elif include_content and actual_format == "pe":
        strings = [entry.decode("ascii", errors="ignore")[:100] for entry in re.findall(rb"[\x20-\x7e]{6,}", sample)[:20]]
        result["source_excerpt"] = redact_text("[Binary printable strings; not executed behavior]\n" + "\n".join(strings)) if strings else ""
        result["content_status"] = "included" if strings else "empty"
        result["sample_complete"] = False
    elif include_content:
        result["content_status"] = "unsupported"
    prepared = prepare_identity_for_ai(result)
    # Local freshness token is never included by prepare_identity_for_ai().
    prepared["_source_token"] = _source_token(before)
    return prepared


def add_content_excerpt(path: Path, identity: dict, expected_sha256: str | None = None) -> dict:
    """Add newly consented content without another signature/version subprocess."""
    if not isinstance(identity, dict):
        raise ValueError("文件身份信息无效。")
    return collect_identity(path, expected_sha256, True, _known_metadata=identity)


def trusted_system_identity(identity) -> bool:
    """Require verified signature, exact Microsoft signer and technical location.

    Version resource company names, filenames and folder names alone never grant
    content authorization. Call with newly collected local identity facts.
    """
    value = prepare_identity_for_ai(identity)
    if value.get("location_class") not in {"windows_system", "program_files"}:
        return False
    signature = value.get("signature", {})
    if signature.get("status") != "valid":
        return False
    publisher = signature.get("publisher", "").casefold().strip()
    if publisher in {"microsoft corporation", "microsoft windows"}:
        return True
    fields = {}
    for part in publisher.split(","):
        if "=" in part:
            name, content = part.split("=", 1)
            fields[name.strip()] = content.strip()
    return (fields.get("o") == "microsoft corporation"
            and fields.get("cn") in {"microsoft corporation", "microsoft windows", "microsoft windows publisher"})


def safe_report_identity(identity) -> dict:
    """Persist metadata and consent status without source or binary excerpts."""
    value = prepare_identity_for_ai(identity)
    excerpt = value.pop("source_excerpt", "")
    value["excerpt_characters"] = len(excerpt)
    return value


def prepare_identity_for_ai(identity) -> dict:
    """Revalidate saved/untrusted identity and remove content without consent."""
    if not isinstance(identity, dict):
        return {}
    result = {}
    for key, limit in (("basename", 180), ("location_hint", 240)):
        value = identity.get(key)
        if isinstance(value, str):
            # Full paths are never a substitute for technical location hints.
            value = re.sub(r"(?i)[a-z]:[\\/][^\r\n]+", "[ABSOLUTE_PATH_WITHHELD]", value)
            result[key] = redact_text(value, limit=limit)
    for key, allowed in (("location_class", LOCATION_CLASSES), ("actual_format", FORMATS),
                         ("content_status", CONTENT_STATUSES),
                         ("sha256_verification", {"matched", "not_requested", "not_rechecked_large_file"})):
        value = identity.get(key)
        if isinstance(value, str) and value in allowed:
            result[key] = value
    for key, maximum in (("size_bytes", 2 ** 63 - 1), ("content_sample_bytes", SAMPLE_LIMIT)):
        value = identity.get(key)
        if type(value) is int and 0 <= value <= maximum:
            result[key] = value
    for key in ("sample_complete", "content_authorized", "content_eligible"):
        if type(identity.get(key)) is bool:
            result[key] = identity[key]
    versions = identity.get("version_info")
    if isinstance(versions, dict):
        result["version_info"] = {key: redact_text(versions[key], limit=240) for key in VERSION_FIELDS if isinstance(versions.get(key), str)}
    signature = identity.get("signature")
    if isinstance(signature, dict):
        status = signature.get("status")
        result["signature"] = {"status": status if isinstance(status, str) and status in SIGNATURE_STATUSES else "unavailable",
                               "publisher": redact_text(signature.get("publisher"), limit=240)}
    if result.get("content_status") == "included" and result.get("content_authorized") is True:
        result["source_excerpt"] = redact_text(identity.get("source_excerpt"))
    else:
        result["source_excerpt"] = ""
        if result.get("content_status") == "included":
            result["content_status"] = "withheld"
    return result
