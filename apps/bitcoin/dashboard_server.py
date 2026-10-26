#!/usr/bin/env python3
"""Local, read-only Binance BTC options dashboard. Python 3.9+."""

import argparse
import copy
import json
import mimetypes
import threading
import time
import urllib.parse
import webbrowser
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

from binance_btc_options import BEIJING, decode_public_json, get_public, number, rows_from_data, validate_response
from market_catalog_cache import load_catalog, save_catalog
from focused_market_recovery import FocusedMarketRecoveryMixin, balanced_strategy_symbols, default_strategy_contract
from realtime_market import (
    GROUP_FIELDS, MARK_FIELDS, MARK_QUOTE_FIELDS, QUOTE_FIELDS, TICKER_FIELDS,
    OptionsWebSocketHub, HEARTBEAT_TIMEOUT_SECONDS, decimal_text, event_millis, initialize_row, merge_fields,
    preserve_concurrent_updates,
)

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "dashboard" / "dist"
SNAPSHOT_DIR = ROOT / "market_data"
REFRESH_SECONDS = 15  # Conservative REST fallback; never one request per tick.
MIN_REFRESH_SECONDS = 15
DIRECTORY_REFRESH_SECONDS = 300
FULL_SNAPSHOT_WEIGHT = 48
SSE_INTERVAL_SECONDS = 0.5
STREAM_FRESH_SECONDS = 20
REST_FRESH_SECONDS = REFRESH_SECONDS * 2
MARK_REFRESH_AGE_SECONDS = 10
MARK_WATCH_SECONDS = 35
MARK_REFRESH_BATCH = 4
MARK_REFRESH_WEIGHT_PER_MINUTE = 120
HEALTH_FIELDS = {
    "quote": ("bid_price", "ask_price", "bid_quantity", "ask_quantity"),
    "mark": ("mark_price", "mark_iv", "delta", "gamma", "theta", "vega"),
    "ticker": ("volume_24h_contracts", "amount_24h_quote", "last_price"),
}
REST_ROW_FIELDS = {
    "mark": {"markPrice": "mark_price", "markIV": "mark_iv", "bidIV": "bid_iv", "askIV": "ask_iv",
             "delta": "delta", "gamma": "gamma", "theta": "theta", "vega": "vega"},
    "ticker": {"bidPrice": "bid_price", "askPrice": "ask_price", "lastPrice": "last_price",
               "volume": "volume_24h_contracts", "amount": "amount_24h_quote",
               "priceChange": "price_change", "priceChangePercent": "price_change_percent"},
}
ENDPOINTS = (
    ("time", "/eapi/v1/time", None),
    ("exchange_info", "/eapi/v1/exchangeInfo", None),
    ("index", "/eapi/v1/index", {"underlying": "BTCUSDT"}),
    ("mark", "/eapi/v1/mark", None),
    ("ticker", "/eapi/v1/ticker", None),
)
ALL_FILTERS = {"side": "ALL", "min_days": 0, "max_days": 10000, "min_otm": None, "max_otm": None}
_JSON_ATOMIC_TYPES = (str, int, float, bool, type(None))


def _copy_snapshot_value(value):
    """Isolate JSON snapshot trees without deepcopy's per-scalar memo work.

    Public snapshots contain dict/list trees and immutable JSON scalars. Keep
    unfamiliar values isolated too, rather than assuming every future field is
    flat or silently sharing a mutable extension with callers.
    """
    kind = type(value)
    if kind is dict:
        return {key: _copy_snapshot_value(child) for key, child in value.items()}
    if kind is list:
        return [_copy_snapshot_value(child) for child in value]
    return value if kind in _JSON_ATOMIC_TYPES else copy.deepcopy(value)


def beijing_now():
    return datetime.now(BEIJING).isoformat(timespec="milliseconds")


class MarketFetchError(Exception):
    def __init__(self, message, failed_endpoints=None, successful_endpoints=None,
                 collected_at=None, exchange_clock_offset_ms=None):
        super().__init__(message)
        self.failed_endpoints = failed_endpoints or {}
        self.successful_endpoints = successful_endpoints or {}
        self.collected_at = collected_at
        self.exchange_clock_offset_ms = exchange_clock_offset_ms


def received_millis(endpoint, fallback_at=None):
    stamp = endpoint.get("received_at_beijing") or fallback_at
    try:
        parsed = datetime.fromisoformat(stamp)
        return int(parsed.timestamp() * 1000) if parsed.tzinfo is not None else None
    except (ValueError, TypeError, OverflowError):
        return None


def clock_offset(endpoints):
    """Anchor each server timestamp to its own response, not a later endpoint."""
    for name in ("time", "exchange_info"):
        endpoint = endpoints.get(name, {})
        server_ms = event_millis(endpoint.get("data", {}).get("serverTime")) if endpoint.get("ok") else None
        received = received_millis(endpoint)
        if server_ms is not None and received is not None:
            return server_ms - received
    return None


def checked_endpoints(endpoints):
    """Validate copies: caller's cached/saved data must never be mutated."""
    result = {}
    failures = {}
    for name, _, _ in ENDPOINTS:
        endpoint = copy.deepcopy(endpoints.get(name, {"ok": False}))
        try:
            validate_response(name, endpoint)
        except (KeyError, TypeError, ValueError, OverflowError):
            endpoint["ok"] = False
            endpoint["error"] = {"type": "UNEXPECTED_SCHEMA", "message": "行情数据结构无效。"}
        result[name] = endpoint
        if not endpoint.get("ok"):
            failure = dict(endpoint.get("error", {"message": "接口没有成功返回。"}))
            failure.update(http_status=endpoint.get("http_status"), retry_after=endpoint.get("retry_after"))
            for key in ("rate_limited", "blocked_by_http_status", "attempts", "request_weight"):
                if key in endpoint:
                    failure[key] = endpoint[key]
            failures[name] = failure
    if failures:
        raise MarketFetchError("部分公开接口刷新失败，成功字段独立更新，其余保留原数据。", failures,
                               {name: endpoint for name, endpoint in result.items() if endpoint.get("ok")})
    return result


def build_snapshot(endpoints, now_ms, fetched_at):
    endpoints = checked_endpoints(endpoints)
    rows, total, index = rows_from_data(endpoints, now_ms, SimpleNamespace(**ALL_FILTERS))
    if not total or len(rows) != total or not all(row["has_mark"] and row["has_ticker"] for row in rows):
        raise MarketFetchError("BTC 期权行情不完整，保留已验证字段。", {"consistency": {"message": "部分有效合约缺少标记价或报价。"}},
                               endpoints, fetched_at, now_ms - received_millis({}, fetched_at))
    marks = {item["symbol"]: item for item in endpoints["mark"]["data"]}
    contracts = {item["symbol"]: item for item in endpoints["exchange_info"]["data"]["optionSymbols"]}
    for row in rows:
        mark = marks[row["symbol"]]
        row["bid_iv"] = decimal_text(mark.get("bidIV"))
        row["ask_iv"] = decimal_text(mark.get("askIV"))
        row["expiry_ms"] = int(number(contracts[row["symbol"]]["expiryDate"]))
        row["price_scale"] = int(contracts[row["symbol"]].get("priceScale", 2))
        row["quantity_scale"] = int(contracts[row["symbol"]].get("quantityScale", 2))
        initialize_row(row, int(datetime.fromisoformat(fetched_at).timestamp() * 1000))
        for group, fields in GROUP_FIELDS.items():
            stamp = received_millis(endpoints["mark" if group == "mark" else "ticker"], fetched_at)
            row[group + "_updated_at"] = stamp
            for field in fields:
                if field in row:
                    row["field_updated_at"][field] = stamp
    symbols = {row["symbol"] for row in rows}
    # Never expose other underlyings, expired contracts, or unmatched quotes.
    for name in ("mark", "ticker"):
        endpoints[name]["data"] = [item for item in endpoints[name]["data"] if item["symbol"] in symbols]
    info = endpoints["exchange_info"]["data"]
    info["optionSymbols"] = [item for item in info["optionSymbols"] if item["symbol"] in symbols]
    if "optionContracts" in info:
        info["optionContracts"] = [item for item in info["optionContracts"] if item.get("underlying") == "BTCUSDT"]
    return {
        "generated_at_beijing": fetched_at,
        "fetched_at": fetched_at,
        "status": "SUCCESS",
        "credentials_used": False,
        "credential_validity_tested": False,
        "filters": dict(ALL_FILTERS),
        "btc_index_price": decimal_text(endpoints["index"]["data"]["indexPrice"]),
        "btc_contracts_total": total,
        "selected_contracts": len(rows),
        "server_time_ms": endpoints["time"]["data"]["serverTime"],
        "endpoints": endpoints,
        "options": rows,
        "source": "binance_public_api",
        "stale": False,
        "error": None,
        "index_updated_at": received_millis(endpoints["index"], fetched_at),
        "index_event_ms": event_millis(endpoints["index"]["data"].get("time")),
        "index_source": "rest",
        "catalog_updated_at": endpoints["exchange_info"].get("received_at_beijing") or fetched_at,
        "rate_limits": copy.deepcopy(info.get("rateLimits", [])),
        "exchange_clock_offset_ms": int(now_ms - datetime.fromisoformat(fetched_at).timestamp() * 1000),
    }


def fetch_snapshot(timeout=12):
    """Only unsigned GET calls to the official public market-data host."""
    def collect(path, params=None):
        endpoint = copy.deepcopy(get_public(path, timeout, params))
        # Stamp in each worker immediately after the body was received/parsed.
        endpoint["received_at_beijing"] = beijing_now()
        return endpoint
    endpoints = {"time": collect("/eapi/v1/time")}
    validate_response("time", endpoints["time"])
    if not endpoints["time"].get("ok") and (endpoints["time"].get("http_status") in (418, 429)
                                            or endpoints["time"].get("rate_limited")):
        failed = dict(endpoints["time"].get("error", {}))
        failed.update(http_status=endpoints["time"].get("http_status"), retry_after=endpoints["time"].get("retry_after"))
        for key in ("rate_limited", "blocked_by_http_status", "attempts", "request_weight"):
            if key in endpoints["time"]:
                failed[key] = endpoints["time"][key]
        raise MarketFetchError("币安行情时间接口暂时不可用，保留上次成功数据。", {"time": failed})
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {name: pool.submit(collect, path, params) for name, path, params in ENDPOINTS[1:]}
        for name, future in futures.items():
            endpoints[name] = future.result()
    collected_at = beijing_now()
    try:
        validated = checked_endpoints(endpoints)
        offset = clock_offset(validated) or 0
        return build_snapshot(validated, received_millis({}, collected_at) + offset, collected_at)
    except MarketFetchError as exc:
        exc.collected_at = collected_at
        exc.exchange_clock_offset_ms = clock_offset(exc.successful_endpoints)
        raise


def load_saved_snapshot(directory):
    """Find newest genuinely complete saved snapshot, skipping filtered exports."""
    paths = sorted(Path(directory).glob("btc_options_*.json"), reverse=True)
    for path in paths:
        try:
            saved = decode_public_json(path.read_text(encoding="utf-8"))
            if not isinstance(saved, dict):
                continue
            filters = saved.get("filters", {})
            if not isinstance(filters, dict):
                continue
            if saved.get("status") != "SUCCESS" or filters.get("side") != "ALL" or filters.get("min_days") != 0 or (number(filters.get("max_days")) or 0) < 10000 or filters.get("min_otm") is not None or filters.get("max_otm") is not None:
                continue
            options = saved.get("options")
            if not isinstance(options, list) or not options or not all(isinstance(row, dict) for row in options) or len(options) != saved.get("btc_contracts_total") or saved.get("selected_contracts") != len(options):
                continue
            fetched_at = saved["generated_at_beijing"]
            parsed = datetime.fromisoformat(fetched_at)
            if parsed.tzinfo is None or parsed.timestamp() > time.time() + 60:
                continue
            endpoints = checked_endpoints(saved.get("endpoints", {}))
            # Only a paired server/receipt timestamp measures clock skew.
            # Days elapsed since a saved collection are cache age, not skew.
            offset = clock_offset(endpoints) or 0
            original_ms = int(parsed.timestamp() * 1000)
            # Verify the saved full export really matches every valid contract at collection.
            original = build_snapshot(endpoints, original_ms + offset, fetched_at)
            if {row.get("symbol") for row in options} != {row["symbol"] for row in original["options"]}:
                continue
            # Expired contracts are removed without claiming a new collection time.
            snapshot = build_snapshot(endpoints, max(original_ms, int(time.time() * 1000)) + offset, fetched_at)
            snapshot.update(source="local_snapshot", stale=True, exchange_clock_offset_ms=offset)
            return snapshot
        except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError, MarketFetchError):
            continue
    return None


class MarketCache(FocusedMarketRecoveryMixin):
    def __init__(self, snapshot_dir=SNAPSHOT_DIR, collector=fetch_snapshot, websocket_factory=OptionsWebSocketHub):
        self._lock = threading.Lock()
        self._hub_action_lock = threading.Lock()
        self._condition = threading.Condition(self._lock)
        self._stop = threading.Event()
        self._collector = collector
        self._catalog_path = Path(snapshot_dir) / "dashboard_catalog_cache.json"
        self._snapshot = load_saved_snapshot(snapshot_dir)
        self._rows_by_symbol = {row["symbol"]: row for row in self._snapshot["options"]} if self._snapshot else {}
        self._last_attempt = None
        self._last_attempt_epoch = None
        self._refreshing = False
        self._error = None
        self._revision = 0
        self._instance_id = uuid.uuid4().hex
        # One immutable encoded frame is shared by all SSE readers. Client
        # writes never run while the market lock or this single-flight is held.
        self._market_frame = None
        self._market_frame_building = False
        self._market_frame_ready_at = -float("inf")
        self._rest_attempts = deque()
        self._blocked_until = 0
        self._failure_count = 0
        self._last_success = None
        self._stream_states = {}
        self._book_baselines = {}
        self._plan = {"streams": 0, "connections": 0}
        self._last_message_at = None
        self._last_messages = {}
        self._mark_watch = {}
        self._mark_attempts = deque()
        self._mark_retry_at = {}
        self._mark_failures = {}
        self._mark_status = {}
        self._mark_refreshing = False
        self._mark_blocked_until = 0
        self._init_focused_recovery()
        self._ticker_generation = 0
        self._ticker_observed_expiries = set()
        catalog = load_catalog(self._catalog_path)
        if catalog is not None and (received_millis(catalog) or 0) > (self._endpoint_received_locked("exchange_info") or 0):
            restored, _ = self._merge_partial_locked({"exchange_info": catalog}, beijing_now(),
                                                    clock_offset({"exchange_info": catalog}), int(time.time() * 1000))
            if restored is not None:
                restored.update(source="local_snapshot", stale=True)
                self._snapshot = restored
                self._rows_by_symbol = {row["symbol"]: row for row in restored["options"]}
        self._hub = websocket_factory(self.apply_stream_message, self.stream_state, self.request_refresh) if websocket_factory else None

    def _notify_locked(self):
        self._revision += 1
        self._condition.notify_all()

    def _endpoint_received_locked(self, name):
        if not self._snapshot:
            return None
        endpoint = self._snapshot.get("endpoints", {}).get(name, {})
        stamp = endpoint.get("received_at_beijing") or self._snapshot.get("fetched_at")
        try:
            parsed = datetime.fromisoformat(stamp)
            return int(parsed.timestamp() * 1000) if parsed.tzinfo is not None else None
        except (ValueError, TypeError, OverflowError):
            return None

    def _group_refresh_failed_locked(self, endpoint):
        failed = (self._error or {}).get("failed_endpoints", {})
        return bool(self._error and (not failed or endpoint in failed))

    def _active_rows_locked(self, now_ms):
        exchange_now = now_ms + (self._snapshot or {}).get("exchange_clock_offset_ms", 0)
        return [row for row in (self._snapshot or {}).get("options", []) if row["expiry_ms"] > exchange_now]

    def _ticker_coverage_locked(self, now_ms, rows=None):
        """A quiet change-only feed stays valid only with a current full baseline.

        Traffic for one expiry must not certify all other subscriptions. A
        reconnect invalidates previous traffic evidence and requires a REST
        baseline collected after the new connection was confirmed.
        """
        states = [state for name, state in self._stream_states.items() if name.startswith("ticker")]
        connected = bool(states and all(state.get("connected") for state in states))
        since = max([state.get("connected_since_ms") or 0 for state in states] or [0])
        rows = self._active_rows_locked(now_ms) if rows is None else rows
        expiries = {row["expiry_ms"] for row in rows}
        symbols = {row["symbol"] for row in rows}
        endpoint = (self._snapshot or {}).get("endpoints", {}).get("ticker", {})
        records = endpoint.get("data", []) if endpoint.get("ok") else []
        covered_symbols = {item.get("symbol") for item in records if isinstance(item, dict)
                           and all(decimal_text(item.get(field)) is not None for field in ("volume", "amount", "lastPrice"))}
        covered = len(symbols & covered_symbols)
        complete = bool(symbols and covered == len(symbols))
        observed = len(expiries & self._ticker_observed_expiries)
        baseline = self._endpoint_received_locked("ticker")
        verified = bool(connected and since and baseline is not None and baseline >= since
                        and complete and expiries and observed == len(expiries))
        return {"connected": connected, "stream_verified": verified,
                "connection_generation": self._ticker_generation,
                "connection_since_ms": since or None,
                "observed_expiries": observed, "total_expiries": len(expiries),
                "rest_covered_contracts": covered, "total_contracts": len(symbols),
                "rest_coverage_complete": complete, "rest_last_received_at": baseline,
                "last_verified_at": baseline if complete else None}

    def _refresh_interval_locked(self, now_ms=None, realtime=None, ticker=None):
        now_ms = int(time.time() * 1000) if now_ms is None else now_ms
        ticker = self._ticker_coverage_locked(now_ms) if ticker is None else ticker
        realtime = self._realtime_locked(now_ms, ticker=ticker) if realtime is None else realtime
        return DIRECTORY_REFRESH_SECONDS if (realtime["connected"] and ticker["stream_verified"]) else REFRESH_SECONDS

    def _data_health_locked(self, now_ms, rows=None, ticker=None, quote_rows=None):
        rows = self._active_rows_locked(now_ms) if rows is None else rows
        ticker = self._ticker_coverage_locked(now_ms, rows=rows) if ticker is None else ticker
        market_connected = bool(self._stream_states.get("market", {}).get("connected"))
        groups = {}
        for name, fields in HEALTH_FIELDS.items():
            if name == "quote":
                observed_rows = [self._quote_view_locked(row, now_ms) for row in rows] if quote_rows is None else quote_rows
            else:
                observed_rows = rows
            values = [(row.get(field), row.get("field_updated_at", {}).get(field),
                       row.get("field_source", {}).get(field, "rest")) for row in observed_rows for field in fields]
            verification_times = [row.get("quote_verified_at") for row in observed_rows for field in fields] if name == "quote" else None
            certified = [row.get("quote_verified_at") for row in observed_rows if row.get("quote_verified_at")]
            groups[name] = self._field_health_locked(values, now_ms, "mark" if name == "mark" else "ticker",
                ticker["connected"] if name == "ticker" else bool(certified) or market_connected,
                STREAM_FRESH_SECONDS if name != "ticker" else REST_FRESH_SECONDS,
                allow_live=name != "ticker", verified=ticker["stream_verified"] if name == "ticker" else bool(rows and len(certified) == len(rows)) if name == "quote" else False,
                verification_times=verification_times)
            if name == "quote":
                groups[name]["verified_contracts"] = len(certified)
                if certified:
                    groups[name]["last_verified_at"] = min(certified)
                    groups[name]["message"] = "盘口订阅及心跳已验证；未变动字段保留最后变更时间" if len(certified) == len(rows) else groups[name]["message"]
        if self._snapshot:
            index_values = [(self._snapshot.get("btc_index_price"), self._snapshot.get("index_updated_at"),
                             self._snapshot.get("index_source", "rest"))]
        else:
            index_values = []
        index_connected = bool(self._stream_states.get("index", {}).get("connected")) or market_connected
        groups["index"] = self._field_health_locked(index_values, now_ms, "index", index_connected,
                                                    STREAM_FRESH_SECONDS)
        catalog_stamp = self._endpoint_received_locked("exchange_info")
        catalog_age = max(0, (now_ms - catalog_stamp) / 1000) if catalog_stamp is not None else None
        groups["catalog"] = {
            "status": "unavailable" if catalog_stamp is None else "fresh" if catalog_age <= DIRECTORY_REFRESH_SECONDS * 2 else "stale",
            "source": "unavailable" if catalog_stamp is None else "local_snapshot" if self._snapshot.get("source") == "local_snapshot" else "rest",
            "available_fields": len(rows), "total_fields": len(rows), "missing_fields": 0,
            "last_updated_at": catalog_stamp, "oldest_updated_at": catalog_stamp,
            "last_verified_at": catalog_stamp, "age_seconds": round(catalog_age, 1) if catalog_age is not None else None,
            "rest_age_seconds": round(catalog_age, 1) if catalog_age is not None else None,
            "connected": False, "rest_refresh_failed": self._group_refresh_failed_locked("exchange_info"),
            "message": "尚无经过验证的合约目录" if catalog_stamp is None else "合约目录已核验" if catalog_age <= DIRECTORY_REFRESH_SECONDS * 2 else "合约目录核验已超过正常间隔",
        }
        groups["ticker"].update(ticker)
        if ticker["total_contracts"] and not ticker["rest_coverage_complete"]:
            groups["ticker"]["status"] = "partial" if groups["ticker"]["available_fields"] else "unavailable"
            groups["ticker"]["message"] = "REST 统计覆盖 %s/%s 个合约；其余保留原数据" % (ticker["rest_covered_contracts"], ticker["total_contracts"])
        elif ticker["stream_verified"]:
            groups["ticker"]["message"] = "统计通道及所有到期日已验证；未变动字段保留最后变更时间"
        elif groups["ticker"]["status"] == "fresh":
            groups["ticker"]["message"] = "统计由最近 REST 核验补齐；WS 覆盖尚未全部验证"
        return groups

    def _field_health_locked(self, values, now_ms, endpoint, connected, threshold,
                             allow_live=True, verified=False, verification_times=None):
        available = [(value, stamp, source) for value, stamp, source in values
                     if decimal_text(value) is not None and isinstance(stamp, (int, float)) and stamp > 0]
        times = [stamp for _, stamp, _ in available]
        verified_times = verification_times or [None] * len(values)
        fresh = sum((event_millis(cert) is not None and 0 <= now_ms - cert <= HEARTBEAT_TIMEOUT_SECONDS * 1000)
                    or -2000 <= now_ms - stamp <= (threshold if source == "websocket" else REST_FRESH_SECONDS) * 1000
                    for (value, stamp, source), cert in zip(values, verified_times)
                    if decimal_text(value) is not None and isinstance(stamp, (int, float)) and stamp > 0)
        sources = {source for _, _, source in available}
        baseline = self._endpoint_received_locked(endpoint)
        rest_age = max(0, (now_ms - baseline) / 1000) if baseline is not None else None
        all_present = bool(values and len(available) == len(values))
        if not available:
            status = "unavailable"
        elif not all_present:
            status = "partial"
        elif verified or (allow_live and connected and sources == {"websocket"} and fresh == len(available)):
            status = "live"
        elif fresh == len(available):
            status = "fresh"
        elif fresh:
            status = "partial"
        else:
            status = "stale"
        source = "unavailable" if not sources else next(iter(sources)) if len(sources) == 1 else "mixed"
        if source == "rest" and self._snapshot and self._snapshot.get("source") == "local_snapshot":
            source = "local_snapshot"
        return {
            "status": status, "source": source, "available_fields": len(available), "total_fields": len(values),
            "missing_fields": len(values) - len(available), "fresh_fields": fresh,
            "websocket_fields": sum(source == "websocket" for _, _, source in available),
            "rest_fields": sum(source == "rest" for _, _, source in available),
            "last_updated_at": max(times) if times else None, "oldest_updated_at": min(times) if times else None,
            "last_verified_at": baseline, "age_seconds": round(max(0, (now_ms - min(times)) / 1000), 1) if times else None,
            "rest_age_seconds": round(rest_age, 1) if rest_age is not None else None,
            "connected": connected, "rest_refresh_failed": self._group_refresh_failed_locked(endpoint),
            "message": {"live": "实时推送覆盖完整", "fresh": "最近缓存仍有效", "partial": "仅部分字段可用或新鲜",
                        "stale": "保留旧数据；已超过正常更新间隔", "unavailable": "尚无有效数据"}[status],
        }

    def _realtime_locked(self, now_ms=None, ticker=None):
        now_ms = int(time.time() * 1000) if now_ms is None else now_ms
        alive = self._last_message_at is not None and now_ms - self._last_message_at < STREAM_FRESH_SECONDS * 1000
        core_alive = all(now_ms - (self._last_messages.get(channel) or 0) < STREAM_FRESH_SECONDS * 1000 for channel in ("mark", "index"))
        states = list(self._stream_states.values())
        open_count = sum(bool(state.get("connected")) for state in states)
        connected = bool(alive and core_alive and self._plan["connections"] and open_count == self._plan["connections"])
        ticker = self._ticker_coverage_locked(now_ms) if ticker is None else ticker
        mode = "websocket" if connected and ticker["stream_verified"] else "hybrid" if alive and open_count else "rest_fallback"
        error = next((state.get("error") for state in states if state.get("error")), None)
        return {"connected": connected, "last_message_at": self._last_message_at,
                "last_error": error, "mode": mode, "stream_count": self._plan["streams"],
                "connections": self._plan["connections"], "connected_connections": open_count,
                "connection_details": copy.deepcopy(self._stream_states),
                "channel_updated_at": dict(self._last_messages), "quote_speed": "all-symbol bookTicker change-only; mark/index 1000ms",
                "quote_interval_ms": 1000, "book_symbol_count": self._plan.get("book_symbol_count", 0),
                "ticker_stream_observed": bool(self._last_messages.get("ticker")),
                "mark_interval_ms": 1000, "ticker_interval_ms": 1000,
                "catalog_interval_seconds": DIRECTORY_REFRESH_SECONDS}

    def watch_marks(self, symbols):
        """Renew a bounded local viewing lease; never accept arbitrary upstream symbols."""
        if not isinstance(symbols, (list, tuple)) or not 1 <= len(symbols) <= 8 or any(not isinstance(symbol, str) for symbol in symbols):
            raise ValueError("请指定1至8个有效BTC期权合约。")
        accepted = list(dict.fromkeys(symbols))
        with self._condition:
            if self._stop.is_set():
                return []
            now = time.time()
            exchange_now = int(now * 1000) + (self._snapshot or {}).get("exchange_clock_offset_ms", 0)
            if any(not symbol.startswith("BTC-") or symbol not in self._rows_by_symbol
                   or self._rows_by_symbol[symbol]["expiry_ms"] <= exchange_now for symbol in accepted):
                raise ValueError("只能同步当前目录中尚未到期的BTC期权。")
            self._mark_watch = {symbol: lease for symbol, lease in self._mark_watch.items() if lease["until"] > now}
            for priority, symbol in enumerate(accepted):
                self._mark_watch[symbol] = {"until": now + MARK_WATCH_SECONDS, "priority": priority}
            # Bound the union of leases from multiple tabs as well as each request.
            ordered = sorted(self._mark_watch, key=lambda symbol: (-self._mark_watch[symbol]["until"], self._mark_watch[symbol]["priority"]))
            self._mark_watch = {symbol: self._mark_watch[symbol] for symbol in ordered[:16]}
        self.request_mark_refresh()
        self.request_focused_refresh()
        return accepted

    def _mark_candidates_locked(self, now):
        now_ms = int(now * 1000)
        self._mark_watch = {symbol: lease for symbol, lease in self._mark_watch.items() if lease["until"] > now}
        spot = number((self._snapshot or {}).get("btc_index_price"))
        clock = now_ms + (self._snapshot or {}).get("exchange_clock_offset_ms", 0)
        watched, puts, calls = [], [], []
        for row in self._rows_by_symbol.values():
            days = (row["expiry_ms"] - clock) / 86400000
            if days <= 0 or not row["symbol"].startswith("BTC-"):
                continue
            watch = self._mark_watch.get(row["symbol"])
            ratio = (number(row.get("strike_price")) or 0) / spot if spot and spot > 0 else 0
            if not watch and not default_strategy_contract(row.get("side"), days, ratio):
                continue
            if self._mark_retry_at.get(row["symbol"], 0) > now:
                continue
            stamps = [event_millis(row.get("field_updated_at", {}).get(field) or row.get("mark_updated_at"))
                      for field in HEALTH_FIELDS["mark"]]
            complete = all(number(row.get(field)) is not None for field in HEALTH_FIELDS["mark"])
            if complete and all(stamp is not None and 0 <= now_ms - stamp < MARK_REFRESH_AGE_SECONDS * 1000 for stamp in stamps):
                continue
            attempted = self._mark_status.get(row["symbol"], {}).get("last_attempt_at", 0)
            if watch:
                watched.append((watch["priority"], attempted, row["symbol"]))
            else:
                (puts if row["side"] == "PUT" else calls).append((abs(days - 15), attempted, row["symbol"]))
        return balanced_strategy_symbols(watched, puts, calls)

    def request_mark_refresh(self):
        """Single shared mark repair, independent of slow full-snapshot retries."""
        with self._condition:
            now = time.time()
            if self._stop.is_set() or self._mark_refreshing or now < self._mark_blocked_until:
                return False
            while self._mark_attempts and self._mark_attempts[0][0] <= now - 60:
                self._mark_attempts.popleft()
            capacity = (MARK_REFRESH_WEIGHT_PER_MINUTE - sum(cost for _, cost in self._mark_attempts)) // 5
            candidates = self._mark_candidates_locked(now)
            # The public all-symbol mark response costs the same five weight
            # as one symbol. Many independent fallbacks cannot keep sixteen
            # watched groups fresh within our 120/min budget. Share one
            # validated response once more than a small batch needs repair.
            bulk = len(candidates) > MARK_REFRESH_BATCH and capacity > 0
            symbols = candidates[:16] if bulk else candidates[:max(0, min(MARK_REFRESH_BATCH, int(capacity)))]
            if not symbols:
                return False
            self._mark_refreshing = True
            if bulk:
                self._mark_attempts.append((now, 5))
            for symbol in symbols:
                if not bulk:
                    self._mark_attempts.append((now, 5))
                self._mark_status[symbol] = {**self._mark_status.get(symbol, {}), "refreshing": True,
                                             "last_attempt_at": int(now * 1000), "error": None}
            self._notify_locked()
        threading.Thread(target=self._refresh_marks, args=(symbols, bulk), name="options-mark-repair", daemon=True).start()
        return True

    def _fetch_mark(self, symbol):
        began_ms = int(time.time() * 1000)
        if self._stop.is_set():
            return symbol, began_ms, None, None
        with self._lock:
            if time.time() < self._mark_blocked_until:
                return symbol, began_ms, None, None
        try:
            endpoint = get_public("/eapi/v1/mark", 8, {"symbol": symbol} if symbol is not None else None, max_attempts=1)
        except Exception:
            endpoint = {"ok": False, "error": {"type": "MARK_REFRESH_FAILED"}}
        return symbol, began_ms, int(time.time() * 1000), endpoint

    def _apply_mark_result(self, result):
        symbol, began_ms, received, endpoint = result
        with self._condition:
            if self._stop.is_set():
                return
            status = self._mark_status.setdefault(symbol, {})
            status["refreshing"] = False
            if endpoint is None:
                return
            endpoint = copy.deepcopy(endpoint)
            if endpoint.get("ok"):
                validate_response("mark", endpoint)
            records = endpoint.get("data", []) if endpoint.get("ok") else []
            # Require exactly the requested symbol and one coherent valid group.
            valid = len(records) == 1 and isinstance(records[0], dict) and records[0].get("symbol") == symbol
            record = records[0] if valid else {}
            valid = valid and number(record.get("markPrice")) is not None and number(record["markPrice"]) >= 0 and (number(record.get("markIV")) or 0) > 0
            row = self._rows_by_symbol.get(symbol)
            if valid and row and row["expiry_ms"] > received + (self._snapshot or {}).get("exchange_clock_offset_ms", 0):
                initialize_row(row, None)
                # A full REST response or a WS update arriving during this request
                # takes precedence. Do not mix two mark/IV observations.
                changed_during_request = any((event_millis(row["field_updated_at"].get(field)) or 0) >= began_ms
                                             for field in HEALTH_FIELDS["mark"])
                if not changed_during_request:
                    for wire, field in REST_ROW_FIELDS["mark"].items():
                        value = decimal_text(record.get(wire))
                        if value is not None:
                            row[field] = value
                            row["field_updated_at"][field] = received
                            row["field_event_ms"][field] = None
                            row["field_source"][field] = "rest"
                    row.update(mark_updated_at=received, mark_source="rest", mark_event_ms=None, has_mark=True)
                self._mark_failures.pop(symbol, None)
                self._mark_retry_at.pop(symbol, None)
                status.pop("retry_after_seconds", None)
                status.update(last_success_at=received, error=None)
            else:
                failures = self._mark_failures.get(symbol, 0) + 1
                self._mark_failures[symbol] = failures
                delay = min(60, 5 * 2 ** min(failures - 1, 4))
                http = endpoint.get("http_status") or endpoint.get("blocked_by_http_status")
                if http in (418, 429) or endpoint.get("rate_limited"):
                    delay = max(delay, number(endpoint.get("retry_after")) or (120 if http == 418 else 60))
                    self._mark_blocked_until = max(self._mark_blocked_until, time.time() + delay)
                self._mark_retry_at[symbol] = time.time() + delay
                status.update(error="标记数据同步暂未成功，将自动重试", retry_after_seconds=delay)
            self._notify_locked()

    def _refresh_marks(self, symbols, bulk=False):
        try:
            if bulk:
                _, began, received, endpoint = self._fetch_mark(None)
                records = {}
                if endpoint is not None and endpoint.get("ok"):
                    endpoint = copy.deepcopy(endpoint)
                    validate_response("mark", endpoint)
                    if endpoint.get("ok"):
                        records = {record["symbol"]: record for record in endpoint["data"]}
                for symbol in symbols:
                    selected = endpoint
                    if endpoint is not None and endpoint.get("ok"):
                        selected = {key: value for key, value in endpoint.items() if key != "data"}
                        selected["data"] = [records[symbol]] if symbol in records else []
                    self._apply_mark_result((symbol, began, received, selected))
                return
            # Two small responses avoid a long all-symbol body, while the common
            # get_public limiter still charges every attempt across all workers.
            with ThreadPoolExecutor(max_workers=2) as pool:
                for offset in range(0, len(symbols), 2):
                    if self._stop.is_set():
                        break
                    with self._lock:
                        if time.time() < self._mark_blocked_until:
                            break
                    futures = [pool.submit(self._fetch_mark, symbol) for symbol in symbols[offset:offset+2]]
                    for future in futures:
                        self._apply_mark_result(future.result())
        finally:
            with self._condition:
                self._mark_refreshing = False
                for symbol in symbols:
                    if symbol in self._mark_status:
                        self._mark_status[symbol]["refreshing"] = False
                self._notify_locked()

    def _mark_background(self):
        while not self._stop.is_set():
            self.request_mark_refresh()
            if self._stop.wait(1):
                return

    def _recovery_status_view_locked(self, status, kind, symbol, now_ms):
        """Project current WS availability over historical REST repair status.

        A failed fallback is not a current data failure after the live feed
        recovers. Keep HTTP attempt/success times intact, and let the override
        expire with the actual data rather than persisting a synthetic success.
        """
        result = _copy_snapshot_value(status)
        verified_at = None
        if kind == "index":
            row = self._snapshot or {}
            fields = ("btc_index_price",)
            stamps = [event_millis(row.get("index_updated_at"))]
            sources = [row.get("index_source")]
            valid = (number(row.get("btc_index_price")) or 0) > 0
        else:
            row = self._rows_by_symbol.get(symbol, {})
            if kind == "depth":
                row = self._quote_view_locked(row, now_ms) if row else row
                fields = HEALTH_FIELDS["quote"]
                prices = [number(row.get(field)) for field in fields]
                valid = (row.get("quote_group_valid") is not False
                         and all(value is not None and value >= 0 for value in prices)
                         and (not prices[0] or not prices[1] or prices[0] <= prices[1]))
                verified_at = event_millis(row.get("quote_verified_at"))
            else:
                fields = HEALTH_FIELDS["mark"]
                mark_price = number(row.get("mark_price"))
                valid = (all(number(row.get(field)) is not None for field in fields)
                         and mark_price is not None and mark_price >= 0
                         and (number(row.get("mark_iv")) or 0) > 0)
            stamps = [event_millis(row.get("field_updated_at", {}).get(field)) for field in fields]
            sources = [row.get("field_source", {}).get(field) for field in fields]
        fresh = (verified_at is not None and 0 <= now_ms - verified_at <= HEARTBEAT_TIMEOUT_SECONDS * 1000
                 or all(stamp is not None and -2000 <= now_ms - stamp <= STREAM_FRESH_SECONDS * 1000 for stamp in stamps))
        if valid and fresh and all(source == "websocket" for source in sources):
            result.update(state="live", error=None, current_source="websocket",
                          data_observed_at=verified_at or min(stamps))
            result.pop("retry_after_seconds", None)
        return result

    def _read_locked(self, include_endpoints=True):
        now_ms = int(time.time() * 1000)
        rows = self._active_rows_locked(now_ms)
        ticker = self._ticker_coverage_locked(now_ms, rows=rows)
        realtime = self._realtime_locked(now_ms, ticker=ticker)
        if self._snapshot is None:
            result = {"status": "FAILED", "generated_at_beijing": None, "fetched_at": None, "btc_index_price": None, "btc_contracts_total": 0, "selected_contracts": 0, "options": [], "endpoints": {}, "source": "unavailable", "stale": True, "credentials_used": False, "credential_validity_tested": False}
        else:
            result = _copy_snapshot_value({key: value for key, value in self._snapshot.items() if include_endpoints or key != "endpoints"})
            age = time.time() - datetime.fromisoformat(result["fetched_at"]).timestamp()
            result["stale"] = bool((result["stale"] or age > REFRESH_SECONDS * 2 or self._error) and not realtime["connected"])
            exchange_now = now_ms + result.get("exchange_clock_offset_ms", 0)
            result["options"] = [self._quote_view_locked(row, now_ms) for row in result["options"] if row["expiry_ms"] > exchange_now]
            result["btc_contracts_total"] = result["selected_contracts"] = len(result["options"])
        interval = self._refresh_interval_locked(now_ms, realtime=realtime, ticker=ticker)
        result.update(error=copy.deepcopy(self._error), refreshing=self._refreshing, refresh_interval_seconds=interval,
                      realtime=realtime, revision=self._revision, instance_id=self._instance_id,
                      retry_after_seconds=max(0, round(self._blocked_until - time.time())))
        result["next_refresh_at"] = datetime.fromtimestamp(max(self._last_attempt_epoch + interval, self._blocked_until), BEIJING).isoformat(timespec="seconds") if self._last_attempt_epoch is not None else None
        result["field_freshness_note"] = "字段分别记录接收时间和币安事件时间；静默合约的最后报价不会伪装为新报价。"
        result["data_health"] = self._data_health_locked(now_ms, rows=rows, ticker=ticker, quote_rows=result["options"])
        result["server_now_ms"] = now_ms + result.get("exchange_clock_offset_ms", 0)
        if self._mark_status:
            result["mark_recovery"] = {"refreshing": self._mark_refreshing,
                "contracts": {symbol: self._recovery_status_view_locked(status, "mark", symbol, now_ms)
                              for symbol, status in self._mark_status.items()}}
        if not include_endpoints:
            result.pop("endpoints", None)
        return result

    def read(self):
        with self._lock:
            return self._read_locked()

    def read_focused(self, symbols):
        """Copy only requested active contracts; reading never renews a lease.

        This telemetry path avoids copying the whole chain or walking every
        connection while retaining exactly the same coherent quote projection
        and original field timestamps as the main market snapshot.
        """
        with self._lock:
            if (not isinstance(symbols, (list, tuple)) or not 1 <= len(symbols) <= 8
                    or any(not isinstance(symbol, str) for symbol in symbols)):
                raise ValueError("请指定 1 至 8 个有效 BTC 期权合约。")
            selected = list(dict.fromkeys(symbols))
            now_ms = int(time.time() * 1000)
            snapshot = self._snapshot or {}
            exchange_now = now_ms + snapshot.get("exchange_clock_offset_ms", 0)
            if any(not symbol.startswith("BTC-") or symbol not in self._rows_by_symbol
                   or self._rows_by_symbol[symbol]["expiry_ms"] <= exchange_now for symbol in selected):
                raise ValueError("只能读取当前目录中尚未到期的 BTC 期权。")
            keys = ("btc_index_price", "index_updated_at", "index_event_ms", "index_source",
                    "catalog_updated_at", "exchange_clock_offset_ms", "fetched_at", "source")
            result = {key: _copy_snapshot_value(snapshot.get(key)) for key in keys}
            result.update(revision=self._revision, instance_id=self._instance_id,
                          server_now_ms=exchange_now,
                          options=[_copy_snapshot_value(self._quote_view_locked(self._rows_by_symbol[symbol], now_ms))
                                   for symbol in selected])
            result["mark_recovery"] = {"refreshing": self._mark_refreshing,
                "contracts": {symbol: self._recovery_status_view_locked(self._mark_status[symbol], "mark", symbol, now_ms)
                              for symbol in selected if symbol in self._mark_status}}
            selected_status = ["index:BTCUSDT"] + ["depth:" + symbol for symbol in selected]
            result["market_recovery"] = {"refreshing": self._focused_refreshing,
                "contracts": {key: self._recovery_status_view_locked(self._focused_status[key], *key.split(":", 1), now_ms)
                              for key in selected_status if key in self._focused_status}}
            return result

    def wait_snapshot(self, revision, timeout=15):
        with self._condition:
            self._condition.wait_for(lambda: self._revision != revision or self._stop.is_set(), timeout)
            return self._revision, self._read_locked(include_endpoints=False)

    def wait_revision(self, revision, timeout=15):
        with self._condition:
            self._condition.wait_for(lambda: self._revision != revision or self._stop.is_set(), timeout)
            return self._revision

    def wait_market_frame(self, revision, timeout=15):
        """Return a shared immutable SSE frame without per-client snapshots.

        A single reader captures the public snapshot under the market lock and
        encodes it after releasing that lock. Other readers share its bytes.
        A quiet connection receives keepalives, not newly dated old observations.
        New connections may refresh an aged frame to capture actual server time.
        """
        deadline = time.monotonic() + max(0, timeout)
        with self._condition:
            while not self._stop.is_set():
                tick = time.monotonic()
                changed = self._revision != revision
                cached = self._market_frame
                if (changed and cached is not None and cached[0] != revision
                        and (cached[0] > revision or self._revision < revision)
                        and tick - self._market_frame_ready_at < SSE_INTERVAL_SECONDS):
                    return cached
                if changed and not self._market_frame_building:
                    delay = self._market_frame_ready_at + SSE_INTERVAL_SECONDS - tick
                    if delay <= 0:
                        self._market_frame_building = True
                        try:
                            captured_revision = self._revision
                            snapshot = self._read_locked(include_endpoints=False)
                        except Exception:
                            self._market_frame_building = False
                            self._condition.notify_all()
                            raise
                        break
                else:
                    delay = deadline - tick
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return revision, None
                self._condition.wait(min(remaining, max(.001, delay)))
            else:
                return revision, None
        try:
            # JSON can hold the GIL; do it once per frame, outside the market
            # critical section, instead of once for each connected browser.
            payload = json.dumps(snapshot, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
            packet = ("id: %s\nevent: snapshot\ndata: " % captured_revision).encode("ascii") + payload + b"\n\n"
        except Exception:
            with self._condition:
                self._market_frame_building = False
                self._condition.notify_all()
            raise
        with self._condition:
            self._market_frame_building = False
            if self._stop.is_set():
                self._condition.notify_all()
                return revision, None
            self._market_frame = captured_revision, packet
            self._market_frame_ready_at = time.monotonic()
            self._condition.notify_all()
            return self._market_frame

    def stream_state(self, name, state):
        with self._condition:
            if self._stop.is_set():
                return
            current_plan = self._plan.get("plan_generation")
            incoming_plan = state.get("plan_generation")
            if current_plan is not None:
                if type(incoming_plan) is not int or (incoming_plan <= current_plan if name == "plan" else incoming_plan != current_plan):
                    return
            elif incoming_plan is not None and type(incoming_plan) is not int:
                return
            if name == "plan":
                self._plan = state
                self._stream_states = {}
                self._book_baselines.clear()
                self._ticker_generation += 1
                self._ticker_observed_expiries.clear()
                self._last_messages.pop("ticker", None)
            else:
                previous = self._stream_states.get(name, {})
                state = dict(state)
                if previous.get("last_disconnect"):
                    state["last_disconnect"] = previous["last_disconnect"]
                if not state.get("connected") and state.get("error_type"):
                    state["last_disconnect"] = {"at_ms": int(time.time() * 1000),
                        "error_type": state["error_type"], "generation": state.get("generation"),
                        "diagnostics": state.get("diagnostics", {})}
                same_generation = state.get("generation") == previous.get("generation")
                if name.startswith("book-") and (not state.get("connected") or not same_generation):
                    self._book_baselines = {symbol: baseline for symbol, baseline in self._book_baselines.items()
                                            if baseline["connection"] != name}
                if state.get("connected"):
                    state["connected_since_ms"] = previous.get("connected_since_ms") if previous.get("connected") and same_generation else int(time.time() * 1000)
                if name.startswith("ticker") and bool(state.get("connected")) != bool(previous.get("connected")):
                    self._ticker_generation += 1
                    self._ticker_observed_expiries.clear()
                    self._last_messages.pop("ticker", None)
                self._stream_states[name] = state
            self._notify_locked()

    def _quote_view_locked(self, original, now_ms):
        focused = self._focused_book_view_locked(original, now_ms)
        if focused is not None:
            return focused
        row = dict(original)
        row.update(quote_verified_at=None, quote_verification=None)
        def uncertified():
            fields = ("bid_price", "ask_price", "bid_quantity", "ask_quantity")
            stamps = [event_millis(row.get("field_updated_at", {}).get(field)) for field in fields]
            if all(stamps) and len(set(stamps)) > 1:
                row["quote_group_valid"] = False
            return row
        baseline = self._book_baselines.get(row.get("symbol"))
        if baseline is None or self._stop.is_set():
            return uncertified()
        state = self._stream_states.get(baseline["connection"], {})
        heartbeat = event_millis(state.get("heartbeat_at"))
        if (not state.get("connected") or not state.get("subscription_confirmed") or state.get("heartbeat_kind") != "pong"
                or state.get("generation") != baseline["generation"] or heartbeat is None
                or not 0 <= now_ms - heartbeat <= HEARTBEAT_TIMEOUT_SECONDS * 1000
                or state.get("diagnostics", {}).get("queue_pending", 0) > 0
                or state.get("diagnostics", {}).get("dispatch_error")
                or row.get("symbol") not in state.get("symbols", [])):
            return uncertified()
        for meta in ("field_updated_at", "field_event_ms", "field_source"):
            row[meta] = dict(row.get(meta, {}))
        for field, value in baseline["values"].items():
            row[field] = value
            for meta in ("field_updated_at", "field_event_ms", "field_source"):
                row[meta][field] = baseline[meta][field]
        row.update(quote_source="websocket", quote_updated_at=baseline["baseline_at"], quote_group_valid=True,
                   quote_event_ms=baseline["event_ms"], quote_verified_at=heartbeat)
        row["quote_verification"] = {"verified": True, "kind": "bookTicker", "connection": baseline["connection"],
            "generation": baseline["generation"], "verified_at": heartbeat, "baseline_at": baseline["baseline_at"],
            "baseline_source": baseline["baseline_source"], "heartbeat_kind": "pong", "values": dict(baseline["values"])}
        return row

    def _remember_quote_baseline_locked(self, row, event, mapping, received_ms, transport):
        if transport and str(transport.get("connection", "")).startswith("book-"):
            names = [transport["connection"]]
        elif event.get("e") == "markPrice":
            names = [name for name, state in self._stream_states.items() if name.startswith("book-")
                     and state.get("connected") and state.get("subscription_confirmed")
                     and received_ms >= (state.get("connected_since_ms") or received_ms + 1)]
        else:
            return
        values = {field: decimal_text(event.get(wire)) for wire, field in mapping.items()}
        complete = len(values) == 4 and all(value is not None and Decimal(value) >= 0 for value in values.values())
        for name in names:
            state = self._stream_states.get(name, {})
            if row["symbol"] not in state.get("symbols", []) or type(state.get("generation")) is not int:
                continue
            if transport and name == transport.get("connection") and transport.get("generation") != state["generation"]:
                continue
            previous = self._book_baselines.get(row["symbol"])
            event_ms = event_millis(event.get("E"))
            if previous and previous["generation"] == state["generation"] and event_ms < previous["event_ms"]:
                continue
            if previous and not complete and any(value is not None and row.get(field) == value
                    and row["field_event_ms"].get(field) == event.get("E")
                    and row["field_updated_at"].get(field) == received_ms
                    and previous["values"].get(field) != value for field, value in values.items()):
                # A newer partial WS observation must never be hidden by an old
                # complete baseline (notably a newly empty side of the book).
                self._book_baselines.pop(row["symbol"], None)
                continue
            if event.get("e") == "bookTicker" and not complete:
                self._book_baselines.pop(row["symbol"], None)
                continue
            if not complete or any(row.get(field) != value or row["field_event_ms"].get(field) != event.get("E")
                                   or row["field_updated_at"].get(field) != received_ms for field, value in values.items()):
                continue
            self._book_baselines[row["symbol"]] = {"connection": name, "generation": state["generation"],
                "values": values, "baseline_at": received_ms, "event_ms": event_ms, "baseline_source": event["e"],
                **{meta: {field: row[meta][field] for field in values} for meta in ("field_updated_at", "field_event_ms", "field_source")}}

    def apply_stream_message(self, payload):
        transport = payload.get("_transport") if isinstance(payload, dict) else None
        if isinstance(payload, dict) and "data" in payload:
            payload = payload["data"]
        events = payload if isinstance(payload, list) else [payload]
        delivered_ms = int(time.time() * 1000)
        receipts = transport.get("received_at_by_symbol") if isinstance(transport, dict) else None
        changed = False
        catalog_changed = False
        latest_received = 0
        with self._condition:
            if self._stop.is_set() or not self._snapshot:
                return False
            cancelled = transport.get("_cancelled") if isinstance(transport, dict) else None
            if cancelled is not None and cancelled.is_set():
                return False
            # Dispatch may wait behind a reader. Expiry uses the actual time
            # after acquiring the cache lock; field age uses the wire receipt.
            now_ms = int(time.time() * 1000)
            current_plan = self._plan.get("plan_generation")
            if current_plan is not None and (not isinstance(transport, dict)
                    or type(transport.get("plan_generation")) is not int or transport.get("plan_generation") != current_plan):
                return False
            if transport and self._stream_states.get(transport.get("connection"), {}).get("generation") != transport.get("generation"):
                return False
            rows = self._rows_by_symbol
            for event in events:
                if not isinstance(event, dict):
                    continue
                received_ms = event_millis(receipts.get(event.get("s"))) if isinstance(receipts, dict) else delivered_ms
                if received_ms is None or received_ms > now_ms + 2000:
                    continue
                event_ms = event_millis(event.get("E"))
                symbol, kind = event.get("s"), event.get("e")
                if (transport and str(transport.get("connection", "")).startswith("book-")
                        and symbol not in self._stream_states[transport["connection"]].get("symbols", [])):
                    continue
                if kind == "optionSymbol" and event.get("ps") == "BTCUSDT":
                    catalog_changed = True
                    continue
                # A future exchange event can poison every ordering watermark,
                # causing subsequent genuine updates to be discarded. Compare
                # with calibrated exchange time at wire receipt, not dispatch.
                latest_event_ms = received_ms + self._snapshot.get("exchange_clock_offset_ms", 0) + 2000
                if event_ms is None or event_ms > latest_event_ms:
                    continue
                if kind == "indexPrice" and symbol == "BTCUSDT":
                    value = decimal_text(event.get("p"))
                    if value is not None and float(value) > 0 and event_ms >= (self._snapshot.get("ws_index_watermark_ms") or self._snapshot.get("index_event_ms") or 0):
                        self._snapshot.update(btc_index_price=value, index_updated_at=received_ms, index_event_ms=event_ms, index_source="websocket")
                        self._snapshot["ws_index_watermark_ms"] = event_ms
                        self._last_messages["index"] = received_ms
                        changed = True
                    continue
                row = rows.get(symbol)
                if row is None or row["expiry_ms"] <= now_ms + self._snapshot.get("exchange_clock_offset_ms", 0):
                    continue
                initialize_row(row, received_ms)
                updated = False
                if kind == "markPrice":
                    index_value = decimal_text(event.get("i"))
                    if index_value is not None and Decimal(index_value) > 0 and event_ms >= (self._snapshot.get("ws_index_watermark_ms") or self._snapshot.get("index_event_ms") or 0):
                        self._snapshot.update(btc_index_price=index_value, index_updated_at=received_ms,
                                              index_event_ms=event_ms, index_source="websocket",
                                              index_stream="btcusdt@optionMarkPrice", ws_index_watermark_ms=event_ms)
                        self._last_messages["index"] = received_ms
                        changed = True
                    updated = merge_fields(row, event, MARK_FIELDS, "mark", received_ms, event_ms)
                    quote_updated = merge_fields(row, event, MARK_QUOTE_FIELDS, "quote", received_ms, event_ms)
                    if quote_updated:
                        self._focused_books.pop(symbol, None)
                    updated = quote_updated or updated
                    if updated:
                        self._last_messages["mark"] = received_ms
                        self._remember_quote_baseline_locked(row, event, MARK_QUOTE_FIELDS, received_ms, transport)
                elif kind == "bookTicker":
                    update_id = event_millis(event.get("u"))
                    if update_id is not None and update_id < (row.get("book_update_id") or 0):
                        continue
                    updated = merge_fields(row, event, QUOTE_FIELDS, "quote", received_ms, event_ms)
                    if updated:
                        self._focused_books.pop(symbol, None)
                        if update_id is not None:
                            row["book_update_id"] = update_id
                        self._last_messages["book"] = max(self._last_messages.get("book", 0), received_ms)
                        self._remember_quote_baseline_locked(row, event, QUOTE_FIELDS, received_ms, transport)
                elif kind == "24hrTicker":
                    previous_price = decimal_text(row.get("last_price"))
                    updated = merge_fields(row, event, TICKER_FIELDS, "ticker", received_ms, event_ms)
                    # C is the statistics close time in WS, not last trade time.
                    if updated:
                        current_price = decimal_text(row.get("last_price"))
                        if previous_price is not None and current_price is not None and Decimal(previous_price) != Decimal(current_price):
                            row["last_trade_beijing"] = None
                            row["field_updated_at"]["last_trade_beijing"] = received_ms
                            row["field_event_ms"]["last_trade_beijing"] = None
                            row["field_source"]["last_trade_beijing"] = "unknown"
                        self._last_messages["ticker"] = received_ms
                        if all(decimal_text(event.get(wire)) is not None
                               and row["field_event_ms"].get(field) == event_ms
                               and row["field_updated_at"].get(field) == received_ms
                               for wire, field in (("v", "volume_24h_contracts"), ("q", "amount_24h_quote"))):
                            self._ticker_observed_expiries.add(row["expiry_ms"])
                elif kind == "trade":
                    trade_ms = event_millis(event.get("T"))
                    if trade_ms is not None and trade_ms <= latest_event_ms and decimal_text(event.get("p")) is not None:
                        updated = merge_fields(row, event, {"p": "last_price"}, "ticker", received_ms, event_ms)
                        if updated:
                            row["last_trade_beijing"] = datetime.fromtimestamp(trade_ms / 1000, BEIJING).isoformat(timespec="milliseconds")
                            row["field_updated_at"]["last_trade_beijing"] = received_ms
                            row["field_event_ms"]["last_trade_beijing"] = event_ms
                            row["field_source"]["last_trade_beijing"] = "websocket"
                            row["ws_event_watermarks"]["last_trade_beijing"] = event_ms
                            row["last_trade_time_ms"] = trade_ms
                            self._last_messages["trade"] = received_ms
                changed = changed or updated
                if updated:
                    latest_received = max(latest_received, received_ms)
            if changed:
                self._last_message_at = max(self._last_message_at or 0, latest_received or received_ms)
                self._snapshot["source"] = "binance_public_websocket"
                self._notify_locked()
        if catalog_changed:
            self.request_refresh()
        return changed

    def _merge_partial_locked(self, endpoints, collected_at, offset, began_ms):
        """Apply only independently validated groups to authoritative catalog rows."""
        checked = {}
        for name, _, _ in ENDPOINTS:
            if name not in endpoints:
                continue
            endpoint = copy.deepcopy(endpoints[name])
            try:
                validate_response(name, endpoint)
            except (KeyError, TypeError, ValueError, OverflowError):
                continue
            if endpoint.get("ok"):
                checked[name] = endpoint
        if not checked or (self._snapshot is None and "exchange_info" not in checked):
            return None, {}
        stamp_ms = received_millis({}, collected_at)
        if stamp_ms is None:
            return None, {}
        snapshot = copy.deepcopy(self._snapshot) if self._snapshot else {
            "generated_at_beijing": collected_at, "fetched_at": collected_at, "filters": dict(ALL_FILTERS),
            "credentials_used": False, "credential_validity_tested": False, "btc_index_price": None,
            "server_time_ms": None, "endpoints": {}, "options": [], "source": "binance_public_api",
            "stale": True, "index_updated_at": None, "index_event_ms": None, "index_source": "unknown",
            "exchange_clock_offset_ms": 0, "catalog_updated_at": None, "rate_limits": [],
        }
        if offset is not None:
            snapshot["exchange_clock_offset_ms"] = offset
        exchange_now = stamp_ms + snapshot.get("exchange_clock_offset_ms", 0)
        previous_rows = {row["symbol"]: row for row in snapshot["options"]}
        snapshot["endpoints"].update(checked)
        if "exchange_info" in checked:
            info = checked["exchange_info"]["data"]
            rows, _, _ = rows_from_data({"exchange_info": checked["exchange_info"]}, exchange_now,
                                       SimpleNamespace(**ALL_FILTERS))
            contracts = {item["symbol"]: item for item in info["optionSymbols"]}
            for row in rows:
                contract = contracts[row["symbol"]]
                row["expiry_ms"] = int(number(contract["expiryDate"]))
                for wire, field in (("priceScale", "price_scale"), ("quantityScale", "quantity_scale")):
                    scale = number(contract.get(wire, 2))
                    row[field] = int(scale) if scale is not None and scale == int(scale) and 0 <= scale <= 18 else 2
                row.update(bid_iv=None, ask_iv=None)
                old = previous_rows.get(row["symbol"])
                if old:
                    for group_fields in GROUP_FIELDS.values():
                        for field in group_fields:
                            if field in old:
                                row[field] = old[field]
                    for key in ("field_updated_at", "field_event_ms", "field_source", "ws_event_watermarks",
                                "book_update_id", "last_trade_time_ms", "has_mark", "has_ticker"):
                        if key in old:
                            row[key] = copy.deepcopy(old[key])
                    for group in GROUP_FIELDS:
                        for suffix in ("_updated_at", "_event_ms", "_source"):
                            row[group + suffix] = old.get(group + suffix)
                initialize_row(row, None)
            snapshot["options"] = rows
            snapshot["catalog_updated_at"] = checked["exchange_info"].get("received_at_beijing") or collected_at
            snapshot["rate_limits"] = copy.deepcopy(info.get("rateLimits", snapshot["rate_limits"]))
        else:
            snapshot["options"] = [row for row in snapshot["options"] if row["expiry_ms"] > exchange_now]
        symbols = {row["symbol"] for row in snapshot["options"]}
        for name in ("mark", "ticker"):
            endpoint = checked.get(name)
            if endpoint is None:
                continue
            receive = received_millis(endpoint, collected_at)
            if receive is None:
                continue
            records = {item["symbol"]: item for item in endpoint["data"] if item["symbol"] in symbols}
            for row in snapshot["options"]:
                record = records.get(row["symbol"])
                if record is None:
                    continue
                initialize_row(row, None)
                last_price_kept = self._keep_ws_field(row, "last_price", began_ms)
                for wire, field in REST_ROW_FIELDS[name].items():
                    value = decimal_text(record.get(wire))
                    current_received = event_millis(row["field_updated_at"].get(field)) or 0
                    recovery_field = field in GROUP_FIELDS["mark"] or field in GROUP_FIELDS["quote"]
                    newer_field = current_received > receive and (name == "mark" or recovery_field and row["field_source"].get(field) == "rest")
                    concurrent_rest = recovery_field and row["field_source"].get(field) == "rest" and current_received > began_ms
                    if value is None or newer_field or concurrent_rest or self._keep_ws_field(row, field, began_ms):
                        continue
                    row[field] = value
                    row["field_updated_at"][field] = receive
                    row["field_event_ms"][field] = None
                    row["field_source"][field] = "rest"
                if name == "ticker" and not last_price_kept:
                    trade_ms = event_millis(record.get("closeTime"))
                    row["last_trade_beijing"] = datetime.fromtimestamp(trade_ms / 1000, BEIJING).isoformat(timespec="milliseconds") if trade_ms else None
                    row["last_trade_time_ms"] = trade_ms
                    row["field_updated_at"]["last_trade_beijing"] = receive
                    row["field_event_ms"]["last_trade_beijing"] = trade_ms
                    row["field_source"]["last_trade_beijing"] = "rest" if trade_ms else "unknown"
                row["has_mark" if name == "mark" else "has_ticker"] = True
        for row in snapshot["options"]:
            for group, fields in GROUP_FIELDS.items():
                available = [field for field in fields if event_millis(row.get("field_updated_at", {}).get(field)) is not None]
                if not available:
                    continue
                row[group + "_updated_at"] = max(event_millis(row["field_updated_at"][field]) for field in available)
                events = [event_millis(row["field_event_ms"].get(field)) for field in available]
                events = [value for value in events if value is not None]
                row[group + "_event_ms"] = max(events) if events else None
                sources = {row["field_source"].get(field) for field in available}
                row[group + "_source"] = next(iter(sources)) if len(sources) == 1 else "mixed"
        index_received = event_millis(snapshot.get("index_updated_at"))
        incoming_index_at = received_millis(checked["index"], collected_at) if "index" in checked else None
        index_concurrent = index_received is not None and (snapshot.get("index_source") == "rest" and index_received > (incoming_index_at or 0) or index_received > began_ms
                            or snapshot.get("index_source") == "websocket" and index_received >= began_ms)
        if "index" in checked and not index_concurrent:
            endpoint = checked["index"]
            snapshot.update(btc_index_price=decimal_text(endpoint["data"]["indexPrice"]),
                            index_updated_at=received_millis(endpoint, collected_at),
                            index_event_ms=event_millis(endpoint["data"].get("time")), index_source="rest")
        if "time" in checked:
            snapshot["server_time_ms"] = checked["time"]["data"]["serverTime"]
        elif "exchange_info" in checked and event_millis(checked["exchange_info"]["data"].get("serverTime")):
            snapshot["server_time_ms"] = checked["exchange_info"]["data"]["serverTime"]
        # Keep the last complete collection timestamp. Each applied group has
        # its own receipt timestamp and must not rejuvenate failed groups.
        snapshot.update(status="PARTIAL", last_partial_refresh_at=collected_at,
                        btc_contracts_total=len(snapshot["options"]), selected_contracts=len(snapshot["options"]))
        for name in ("mark", "ticker"):
            if name in snapshot["endpoints"]:
                snapshot["endpoints"][name]["data"] = [item for item in snapshot["endpoints"][name].get("data", []) if item["symbol"] in symbols]
        info = snapshot["endpoints"].get("exchange_info", {}).get("data")
        if info is not None:
            info["optionSymbols"] = [item for item in info["optionSymbols"] if item["symbol"] in symbols]
            if "optionContracts" in info:
                info["optionContracts"] = [item for item in info["optionContracts"] if item.get("underlying") == "BTCUSDT"]
        return snapshot, checked

    @staticmethod
    def _keep_ws_field(row, field, began_ms):
        received = event_millis(row.get("field_updated_at", {}).get(field))
        return (row.get("field_source", {}).get(field) == "websocket"
                and received is not None and received >= began_ms)

    def _configure_hub(self):
        if not self._hub:
            return
        with self._hub_action_lock:
            with self._lock:
                if self._stop.is_set() or not self._snapshot:
                    return
                symbols = tuple(row["symbol"] for row in self._active_rows_locked(int(time.time() * 1000)))
                index = self._snapshot.get("btc_index_price")
                offset = self._snapshot.get("exchange_clock_offset_ms", 0)
            if symbols:
                set_clock = getattr(self._hub, "set_exchange_clock_offset", None)
                if set_clock is not None:
                    set_clock(offset)
                self._hub.configure(symbols, index)

    def request_refresh(self):
        with self._lock:
            now_epoch = time.time()
            while self._rest_attempts and now_epoch - self._rest_attempts[0] >= 60:
                self._rest_attempts.popleft()
            limits = self._snapshot.get("rate_limits", []) if self._snapshot else []
            live_limit = next((int(limit["limit"]) for limit in limits if limit.get("rateLimitType") == "REQUEST_WEIGHT" and limit.get("interval") == "MINUTE" and limit.get("intervalNum") == 1), 400)
            budget = min(250, int(live_limit * 0.7))
            if self._refreshing or self._stop.is_set() or now_epoch < self._blocked_until or (len(self._rest_attempts) + 1) * FULL_SNAPSHOT_WEIGHT > budget or (self._last_attempt is not None and time.monotonic() - self._last_attempt < MIN_REFRESH_SECONDS):
                return False
            self._refreshing = True
            self._last_attempt = time.monotonic()
            self._last_attempt_epoch = time.time()
            self._rest_attempts.append(now_epoch)
            self._notify_locked()
        threading.Thread(target=self._refresh, name="options-market-refresh", daemon=True).start()
        return True

    def _refresh(self):
        try:
            self._collect_and_apply()
        except Exception:
            # A merge/validation error must not strand the refresh worker forever.
            # The authoritative snapshot is committed only after preparation succeeds.
            with self._condition:
                if not self._stop.is_set():
                    self._failure_count += 1
                    delay = min(120, REFRESH_SECONDS * 2 ** min(self._failure_count - 1, 3))
                    self._blocked_until = max(self._blocked_until, time.time() + delay)
                    self._error = {"message": "公开行情合并失败，保留上次成功数据。",
                                   "failed_endpoints": {}, "attempted_at": beijing_now()}
        finally:
            with self._condition:
                self._refreshing = False
                self._notify_locked()

    def _collect_and_apply(self):
        snapshot = None
        failure = None
        partial = None
        applied_endpoints = {}
        began_ms = int(time.time() * 1000)
        try:
            snapshot = self._collector()
        except MarketFetchError as exc:
            failure = {"message": str(exc), "failed_endpoints": exc.failed_endpoints, "attempted_at": beijing_now()}
            partial = exc
        except Exception:
            # Do not expose proxy settings, credentials, tracebacks, or local paths.
            failure = {"message": "公开行情刷新失败，保留上次成功数据。", "failed_endpoints": {}, "attempted_at": beijing_now()}
        finally:
            with self._condition:
                if self._stop.is_set():
                    return
                if partial is not None:
                    snapshot, applied_endpoints = self._merge_partial_locked(partial.successful_endpoints,
                        partial.collected_at or beijing_now(), partial.exchange_clock_offset_ms, began_ms)
                if snapshot is not None:
                    if self._snapshot and partial is None:
                        preserve_concurrent_updates(snapshot, self._snapshot, began_ms)
                    rows_by_symbol = {row["symbol"]: row for row in snapshot["options"]}
                    current_endpoints = applied_endpoints if partial is not None else snapshot.get("endpoints", {})
                    headers = [endpoint.get("rate_headers", {}) for endpoint in current_endpoints.values()]
                    used = max([int(value) for header in headers for key, value in header.items() if key.lower().startswith("x-mbx-used-weight-1m") and str(value).isdigit()] or [0])
                    limits = snapshot.get("rate_limits", [])
                    live_limit = next((int(limit["limit"]) for limit in limits if limit.get("rateLimitType") == "REQUEST_WEIGHT" and limit.get("interval") == "MINUTE" and limit.get("intervalNum") == 1), 400)
                    if used + FULL_SNAPSHOT_WEIGHT > live_limit * 0.85:
                        self._blocked_until = (int(time.time()) // 60 + 1) * 60 + 1
                    self._snapshot = snapshot
                    self._rows_by_symbol = rows_by_symbol
                    self._last_success = time.monotonic()
                    self._failure_count = 0
                if failure:
                    self._failure_count = self._failure_count + 1 if snapshot is None else 1
                    delay = min(120, REFRESH_SECONDS * 2 ** min(self._failure_count - 1, 3))
                    for endpoint in failure["failed_endpoints"].values():
                        status = endpoint.get("http_status") or endpoint.get("blocked_by_http_status")
                        if status in (418, 429) or endpoint.get("rate_limited"):
                            retry = number(endpoint.get("retry_after"))
                            delay = max(delay, retry if retry is not None else 120 if status == 418 else 60)
                    self._blocked_until = max(self._blocked_until, time.time() + delay)
                self._error = failure
            if snapshot is not None:
                catalog = current_endpoints.get("exchange_info")
                if catalog is not None:
                    save_catalog(self._catalog_path, catalog)
                self._configure_hub()

    def start(self):
        self._configure_hub()
        self.request_refresh()
        threading.Thread(target=self._background, name="options-market-timer", daemon=True).start()
        threading.Thread(target=self._mark_background, name="options-mark-timer", daemon=True).start()
        threading.Thread(target=self._focused_background, name="options-focused-timer", daemon=True).start()

    def _background(self):
        while not self._stop.wait(1):
            with self._lock:
                interval = self._refresh_interval_locked()
                due = self._last_attempt is None or time.monotonic() - self._last_attempt >= interval
            if due:
                self.request_refresh()

    def stop(self):
        self._stop.set()
        with self._condition:
            self._condition.notify_all()
        with self._hub_action_lock:
            if self._hub:
                self._hub.stop()


class DashboardServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, cache, static_dir=STATIC_DIR, ai_service=None):
        self.cache = cache
        self.ai_service = ai_service
        self.static_dir = Path(static_dir).resolve()
        super().__init__(address, DashboardHandler)


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "OptionsDashboard/2.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        pass

    def _respond(self, status, payload, content_type="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(payload)

    def _json(self, status, value):
        self._respond(status, json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))

    def do_GET(self):
        from option_ai_http import handle_ai
        if handle_ai(self):
            return
        host = self.headers.get("Host", "").split(":", 1)[0].lower()
        if host not in ("127.0.0.1", "localhost"):
            self._json(403, {"error": "本服务仅允许本机访问。"})
            return
        url = urllib.parse.urlsplit(self.path)
        if url.path == "/api/events":
            self._events()
            return
        if url.path == "/api/market":
            query = urllib.parse.parse_qs(url.query)
            if query.get("refresh") == ["1"]:
                self.server.cache.request_refresh()
            self._json(200, self.server.cache.read())
            return
        if url.path == "/api/focused-market":
            if self.server.cache is None:
                self._json(503, {"error": "期权行情尚未启动。"})
                return
            try:
                query = urllib.parse.parse_qs(url.query, keep_blank_values=True)
                if set(query) != {"symbols"} or len(query["symbols"]) != 1:
                    raise ValueError("请提供一组需要读取的合约。")
                symbols = query["symbols"][0].split(",")
                if not 1 <= len(symbols) <= 8 or any(not symbol for symbol in symbols):
                    raise ValueError("每次可读取 1 至 8 个有效 BTC 期权合约。")
                self._json(200, self.server.cache.read_focused(symbols))
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
            return
        if url.path == "/api/mark-watch":
            try:
                query = urllib.parse.parse_qs(url.query, keep_blank_values=True)
                if set(query) != {"symbols"} or len(query["symbols"]) != 1:
                    raise ValueError("请提供一组需要同步的合约。")
                symbols = query["symbols"][0].split(",")
                if not 1 <= len(symbols) <= 8 or any(not symbol for symbol in symbols):
                    raise ValueError("每次可关注 1 至 8 个有效 BTC 期权合约。")
                self._json(200, {"accepted": self.server.cache.watch_marks(symbols)})
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
            return
        path = urllib.parse.unquote(url.path)
        if "\\" in path or "\x00" in path or any(part == ".." for part in path.split("/")) or not path.startswith("/"):
            self._json(403, {"error": "路径不可访问。"})
            return
        candidate = (self.server.static_dir / ("index.html" if path == "/" else path.lstrip("/"))).resolve()
        try:
            candidate.relative_to(self.server.static_dir)
        except ValueError:
            self._json(403, {"error": "路径不可访问。"})
            return
        if not candidate.is_file():
            self._json(404, {"error": "页面文件不存在，请先构建看板。"})
            return
        try:
            data = candidate.read_bytes()
        except OSError:
            self._json(404, {"error": "页面文件无法读取。"})
            return
        # Use the built-in web types without guess_type()'s Windows registry
        # initialization, so the first page load cannot block on that scan.
        suffix = candidate.suffix.lower()
        content_type = mimetypes.types_map.get(suffix, "application/octet-stream")
        if suffix == ".js":
            content_type = "text/javascript"
        elif suffix == ".wav":
            content_type = "audio/wav"
        if content_type.startswith("text/") or content_type == "application/json":
            content_type += "; charset=utf-8"
        self._respond(200, data, content_type)

    def _events(self):
        """Fan out shared cached market updates. Reading this never fetches upstream."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.close_connection = True
        last_event = self.headers.get("Last-Event-ID", "")
        revision = int(last_event) if len(last_event) <= 20 and last_event.isascii() and last_event.isdigit() else -1
        try:
            self.connection.settimeout(10)
            self.wfile.write(b"retry: 2000\n\n")
            self.wfile.flush()
            while not self.server.cache._stop.is_set():
                latest, frame = self.server.cache.wait_market_frame(revision, timeout=15)
                if self.server.cache._stop.is_set():
                    break
                if frame is not None:
                    self.wfile.write(frame)
                    revision = latest
                else:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            pass

    def _unsupported_method(self):
        self._json(405, {"error": "只支持读取行情的 GET 请求。"})

    def do_POST(self):
        from option_ai_http import handle_ai
        if not handle_ai(self):
            self._unsupported_method()

    do_DELETE = do_POST
    do_PUT = do_PATCH = do_HEAD = do_OPTIONS = _unsupported_method


def main():
    parser = argparse.ArgumentParser(description="在浏览器打开本机 BTC 期权行情看板，仅公开行情。")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1 到 65535 之间。")
    if not (STATIC_DIR / "index.html").is_file():
        parser.error("未找到 dashboard/dist/index.html，请先构建前端。")
    cache = MarketCache()
    try:
        from option_ai_service import OptionAIService
        ai_service = OptionAIService(cache.read)
    except Exception:
        ai_service = None
    try:
        server = DashboardServer(("127.0.0.1", args.port), cache, ai_service=ai_service)
    except OSError:
        parser.error("本机端口无法绑定，请通过 --port 选择其他端口。")
    cache.start()
    if ai_service is not None:
        ai_service.start_discovery()
    url = "http://127.0.0.1:%s/" % args.port
    print("BTC 期权看板：" + url, flush=True)
    print("实时 WebSocket 行情；合约目录每 5 分钟核对，断线时 15 秒 REST 降级；Ctrl+C 关闭。", flush=True)
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已关闭本地看板。")
    finally:
        if ai_service is not None:
            ai_service.stop()
        cache.stop()
        server.server_close()
    return 0


if __name__ == "__main__":
    import sys
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    raise SystemExit(main())
