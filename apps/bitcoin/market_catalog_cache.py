"""Small atomic cache for validated, unsigned public option catalogs.

The exchange receipt time is retained exactly; loading a file never renews it.
No account data or authentication fields are accepted or persisted.
"""

import copy
import json
import math
import os
import re
import tempfile
import time
from datetime import datetime
from pathlib import Path

from binance_btc_options import decode_public_json, validate_response


MAX_CATALOG_BYTES = 32 * 1024 * 1024
_WEIGHT_HEADER = re.compile(r"x-mbx-used-weight-\d+[smhd]", re.IGNORECASE)


def _validated(endpoint, now_ms=None):
    if not isinstance(endpoint, dict) or endpoint.get("ok") is not True:
        return None
    stamp = endpoint.get("received_at_beijing")
    if not isinstance(stamp, str):
        return None
    received = datetime.fromisoformat(stamp)
    if received.tzinfo is None or received.utcoffset() is None:
        return None
    received_ms = received.timestamp() * 1000
    current_ms = time.time() * 1000 if now_ms is None else now_ms
    if isinstance(current_ms, bool) or not isinstance(current_ms, (int, float)) or not math.isfinite(current_ms):
        return None
    if not math.isfinite(received_ms) or received_ms <= 0 or received_ms > current_ms + 2000:
        return None
    clean = {"ok": True, "data": copy.deepcopy(endpoint.get("data")), "received_at_beijing": stamp}
    validate_response("exchange_info", clean)
    if not clean["ok"] or not clean.get("data", {}).get("optionSymbols"):
        return None
    headers = endpoint.get("rate_headers")
    if isinstance(headers, dict):
        clean["rate_headers"] = {
            key: value for key, value in headers.items()
            if isinstance(key, str) and isinstance(value, str) and value.isascii() and value.isdigit()
            and (_WEIGHT_HEADER.fullmatch(key) or key.lower() == "retry-after")
        }
    return clean


def load_catalog(path, now_ms=None):
    """Return an isolated public endpoint, or None for any unusable cache."""
    try:
        target = Path(path)
        if target.stat().st_size > MAX_CATALOG_BYTES:
            return None
        with target.open("rb") as stream:
            raw = stream.read(MAX_CATALOG_BYTES + 1)
        if len(raw) > MAX_CATALOG_BYTES:
            return None
        endpoint = decode_public_json(raw.decode("utf-8"))
        return _validated(endpoint, now_ms)
    except (OSError, ValueError, TypeError, KeyError, OverflowError, RecursionError):
        return None


def save_catalog(path, endpoint):
    """Atomically persist allowed public fields, retaining any old file on failure."""
    temporary = None
    try:
        clean = _validated(endpoint)
        if clean is None:
            return False
        raw = json.dumps(clean, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(raw) > MAX_CATALOG_BYTES:
            return False
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="wb", prefix=".catalog-", suffix=".tmp",
                                         dir=target.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(target)
        temporary = None
        return True
    except (OSError, ValueError, TypeError, KeyError, OverflowError, RecursionError):
        return False
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass
