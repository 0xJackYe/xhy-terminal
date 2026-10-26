"""Bounded static facts for AI review; no file access, execution, or verdicts.

Only fixed categories and numeric facts leave this module. API imports express
capabilities, not observed behaviour; entropy is measured on a sample and is not
proof of packing or malware. Signatures are explicitly left unchecked.

PE layouts follow Microsoft's PE Format reference:
https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
"""
from __future__ import annotations

from collections import Counter
import math
from pathlib import PureWindowsPath
import re
import struct


SAMPLE_LIMIT = 256 * 1024
SCRIPT_SUFFIXES = {".ps1", ".psm1", ".bat", ".cmd", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".hta", ".py", ".pyw", ".sh"}
SCRIPT_FEATURES = {
    "network_fetch", "dynamic_execution", "encoded_command", "base64_decode",
    "credential_access", "defense_evasion", "persistence", "destructive_commands",
}
PE_IMPORT_CATEGORIES = {
    "network", "process_creation", "memory_execution", "process_injection",
    "registry", "credential_crypto", "file_deletion", "service_control",
}
_IMPORTS = {
    "network": {b"winhttpopen", b"winhttpconnect", b"winhttpsendrequest", b"internetopena", b"internetopenw", b"internetopena", b"internetopenw", b"internetconnecta", b"internetconnectw", b"urldownloadtofilea", b"urldownloadtofilew", b"wsastartup", b"connect", b"send", b"recv"},
    "process_creation": {b"createprocessa", b"createprocessw", b"winexec", b"shellexecutea", b"shellexecutew", b"shellexecuteexa", b"shellexecuteexw"},
    "memory_execution": {b"virtualalloc", b"virtualprotect", b"createthread", b"ntallocatevirtualmemory", b"ntprotectvirtualmemory"},
    "registry": {b"regopenkeyexa", b"regopenkeyexw", b"regsetvalueexa", b"regsetvalueexw", b"regcreatekeyexa", b"regcreatekeyexw"},
    "credential_crypto": {b"cryptunprotectdata", b"credreada", b"credreadw", b"credenumeratea", b"credenumeratew", b"lsaretrieveprivatedata"},
    "file_deletion": {b"deletefilea", b"deletefilew", b"removedirectorya", b"removedirectoryw"},
    "service_control": {b"openscmanagera", b"openscmanagerw", b"createservicea", b"createservicew", b"controlservice", b"startservicea", b"startservicew"},
}


def _entropy(sample: bytes) -> float:
    if not sample:
        return 0.0
    length = len(sample)
    return round(max(0.0, min(8.0, -sum((count / length) * math.log2(count / length) for count in Counter(sample).values()))), 3)


def _script_features(sample: bytes) -> list[str]:
    encoding = "utf-16" if sample.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
    text = sample.decode(encoding, errors="replace")
    patterns = {
        "network_fetch": r"(?:\bdownloadstring\s*\(|\bdownloadfile\s*\(|\binvoke-webrequest\b|\binvoke-restmethod\b|\burllib\.request\b|\brequests\.(?:get|post)\s*\(|\b(?:curl|wget)\s+https?://)",
        "dynamic_execution": r"(?:\biex\b\s*\(?|\binvoke-expression\b|\beval\s*\(|\bexec\s*\(|\bexecuteglobal\b)",
        "encoded_command": r"\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]{0,300}-(?:encodedcommand|enc)\s+[a-z0-9+/]{40,}={0,2}(?:\s|$)",
        "base64_decode": r"(?:\bfrombase64string\s*\(|\bbase64\.(?:b64decode|decodebytes)\s*\(|\batob\s*\()",
        "credential_access": r"(?:\bsekurlsa\s*::|\blsadump\s*::|\bmini(?:dumpwritedump|dump)\b[^\r\n]{0,160}\blsass\b|\blsass\b[^\r\n]{0,160}\b(?:comsvcs|procdump|dump)\b)",
        "defense_evasion": r"(?:\bset-mppreference\b[^\r\n]{0,200}\bdisablerealtimemonitoring\b\s+\$?true|\badd-mppreference\b[^\r\n]{0,120}\bexclusion(?:path|process|extension)\b|\bamsi(?:initfailed|utils)\b[^\r\n]{0,160}\b(?:setvalue|true)\b)",
        "persistence": r"(?:\bschtasks(?:\.exe)?\s+/create\b|\bregister-scheduledtask\b|\b(?:currentversion[\\/]+run(?:once)?)\b[^\r\n]{0,180}\b(?:set-itemproperty|reg\s+add)\b|\b(?:set-itemproperty|reg\s+add)\b[^\r\n]{0,180}\bcurrentversion[\\/]+run(?:once)?\b)",
        "destructive_commands": r"(?:\bvssadmin(?:\.exe)?\s+delete\s+shadows\b|\bwbadmin(?:\.exe)?\s+delete\s+catalog\b|\bbcdedit(?:\.exe)?\s+/set\s+\S+\s+recoveryenabled\s+no\b|\bformat(?:\.com)?\s+[a-z]:\s+/[qy]\b)",
    }
    return [name for name, pattern in patterns.items() if re.search(pattern, text, re.I)]


def _pe_facts(sample: bytes, size: int) -> dict:
    result = {"pe_sections_count": 0, "pe_import_categories": [], "pe_parse_status": "not_pe"}
    if not sample.startswith(b"MZ"):
        return result
    missing = "truncated" if size > len(sample) else "invalid"
    result["pe_parse_status"] = missing
    if len(sample) < 64:
        return result
    pe = struct.unpack_from("<I", sample, 0x3c)[0]
    if pe < 64 or pe + 24 > len(sample):
        return result
    if sample[pe:pe + 4] != b"PE\0\0":
        result["pe_parse_status"] = "invalid"
        return result
    count = struct.unpack_from("<H", sample, pe + 6)[0]
    optional_size = struct.unpack_from("<H", sample, pe + 20)[0]
    if not 1 <= count <= 96:
        result["pe_parse_status"] = "invalid"
        return result
    result["pe_sections_count"] = count
    optional = pe + 24
    if optional_size < 2 or optional + optional_size + count * 40 > len(sample):
        return result
    magic = struct.unpack_from("<H", sample, optional)[0]
    if magic not in (0x10b, 0x20b):
        result["pe_parse_status"] = "invalid"
        return result
    directories = 96 if magic == 0x10b else 112
    number_offset = 92 if magic == 0x10b else 108
    if optional_size < directories or optional_size < 64:
        result["pe_parse_status"] = "invalid"
        return result
    result["pe_parse_status"] = "valid"
    size_of_headers = struct.unpack_from("<I", sample, optional + 60)[0]
    section_start = optional + optional_size
    sections = []
    for index in range(count):
        offset = section_start + index * 40
        virtual_size, virtual_address, raw_size, raw_offset = struct.unpack_from("<IIII", sample, offset + 8)
        sections.append((virtual_address, virtual_size, raw_offset, raw_size))

    def offset_for(rva, length=1):
        if rva < size_of_headers and rva + length <= min(size_of_headers, len(sample)):
            return rva
        for address, virtual_size, raw, raw_size in sections:
            delta = rva - address
            if 0 <= delta < max(virtual_size, raw_size) and delta + length <= raw_size:
                offset = raw + delta
                return offset if offset + length <= len(sample) else None
        return None

    def name_for(rva):
        offset = offset_for(rva)
        if offset is None:
            return None
        end = sample.find(b"\0", offset, min(len(sample), offset + 256))
        return sample[offset:end].lower() if end >= 0 else None

    directories_count = struct.unpack_from("<I", sample, optional + number_offset)[0]
    if directories_count < 2:
        return result
    if optional_size < directories + 16:
        result["pe_parse_status"] = "invalid"
        return result
    import_rva, import_size = struct.unpack_from("<II", sample, optional + directories + 8)
    if not import_rva or not import_size:
        return result
    if import_size < 20:
        result["pe_parse_status"] = "invalid"
        return result
    names = set()
    width = 4 if magic == 0x10b else 8
    ordinal_flag = 1 << (width * 8 - 1)
    total_names = 0
    for descriptor_index in range(min(128, import_size // 20)):
        descriptor = offset_for(import_rva + descriptor_index * 20, 20)
        if descriptor is None:
            result["pe_parse_status"] = missing
            break
        lookup, stamp, forwarder, dll, address_table = struct.unpack_from("<IIIII", sample, descriptor)
        if not any((lookup, stamp, forwarder, dll, address_table)):
            break
        thunk_rva = lookup or address_table
        if not thunk_rva:
            continue
        for name_index in range(512):
            if total_names >= 2048:
                result["pe_parse_status"] = "truncated"
                break
            thunk = offset_for(thunk_rva + name_index * width, width)
            if thunk is None:
                result["pe_parse_status"] = missing
                break
            value = struct.unpack_from("<I" if width == 4 else "<Q", sample, thunk)[0]
            if not value:
                break
            total_names += 1
            if value & ordinal_flag:
                continue
            name = name_for(value + 2)
            if name is None:
                result["pe_parse_status"] = missing
            else:
                names.add(name)
        else:
            result["pe_parse_status"] = "truncated"
    else:
        # Hitting a bound is not evidence that every import was inspected.
        result["pe_parse_status"] = "truncated"
    categories = [category for category, members in _IMPORTS.items() if names.intersection(members)]
    if b"writeprocessmemory" in names and names.intersection({b"virtualallocex", b"createremotethread", b"ntcreatethreadex"}):
        categories.append("process_injection")
    result["pe_import_categories"] = categories
    return result


def from_sample(path, sample: bytes, size: int) -> dict:
    """Return fixed static facts from a bounded sample supplied by the scanner.

    No path is opened. Neither the source name nor any source text/API name is
    returned. Imported API categories and script keywords cannot prove malware.
    """
    if not isinstance(sample, (bytes, bytearray, memoryview)):
        raise TypeError("sample must be bytes-like")
    if type(size) is not int or size < 0:
        raise ValueError("size must be a nonnegative integer")
    sample = bytes(sample[:SAMPLE_LIMIT])
    if len(sample) > size:
        raise ValueError("sample cannot exceed the file size")
    suffix = PureWindowsPath(str(path)).suffix.casefold()
    pe = _pe_facts(sample, size)
    actual_format = "other"
    if pe["pe_parse_status"] == "valid" or pe["pe_sections_count"]:
        actual_format = "pe"
    elif sample.startswith(b"%PDF-"):
        actual_format = "pdf"
    elif sample.startswith((b"PK\x03\x04", b"PK\x05\x06", b"7z\xbc\xaf\x27\x1c", b"Rar!\x1a\x07", b"\x1f\x8b")):
        actual_format = "archive"
    elif suffix in SCRIPT_SUFFIXES or sample.startswith(b"#!"):
        actual_format = "script"
    return {
        "size_bytes": size, "actual_format": actual_format,
        "sample_bytes": len(sample), "sample_complete": len(sample) == size,
        "entropy": _entropy(sample),
        "script_features": _script_features(sample) if actual_format == "script" else [],
        **pe, "signature_status": "not_checked", "signature_publisher_class": "unknown",
    }
