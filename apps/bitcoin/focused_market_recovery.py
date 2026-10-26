"""Shared, bounded recovery of coherent public books and the BTC index.

This module never marks an old book as fresh. Each REST book is one complete
observation; downstream calculations retain their existing age checks.
"""
import copy
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

from binance_btc_options import get_public, number, validate_response
from realtime_market import decimal_text, event_millis, initialize_row


BOOK_FIELDS = ("bid_price", "ask_price", "bid_quantity", "ask_quantity")
REFRESH_AGE_SECONDS = 8
WEIGHT_PER_MINUTE = 80


def default_strategy_contract(side, days, strike_ratio):
    """Equal linear OTM distance: Put 20–25% below, Call 20–25% above."""
    return 10 <= days <= 20 and (side == "PUT" and .75 <= strike_ratio <= .8
                               or side == "CALL" and 1.2 <= strike_ratio <= 1.25)


def balanced_strategy_symbols(watched, puts, calls):
    """Keep viewing priority, then alternate stable per-side default queues.

    Each item has its existing sort key followed by the symbol. Starting with
    Put retains the old single-side order. Missing/exhausted sides leave their
    slots to the other side; this does not create another request budget.
    """
    result = [item[-1] for item in sorted(watched)]
    puts, calls = sorted(puts), sorted(calls)
    for index in range(max(len(puts), len(calls))):
        if index < len(puts):
            result.append(puts[index][-1])
        if index < len(calls):
            result.append(calls[index][-1])
    return result


def parse_depth(data):
    if not isinstance(data, dict):
        raise ValueError("Invalid book")
    result = {}
    for side, price_key, size_key, descending in (("bids", "bid_price", "bid_quantity", True), ("asks", "ask_price", "ask_quantity", False)):
        levels = data.get(side)
        if not isinstance(levels, list):
            raise ValueError("Missing book side")
        previous = None
        for level in levels:
            if not isinstance(level, list) or len(level) < 2 or any(decimal_text(value) is None for value in level[:2]):
                raise ValueError("Invalid book level")
            price, size = (Decimal(str(value)) for value in level[:2])
            if price <= 0 or size <= 0 or previous is not None and (price >= previous if descending else price <= previous):
                raise ValueError("Invalid book ordering")
            previous = price
        result[price_key], result[size_key] = (decimal_text(levels[0][0]), decimal_text(levels[0][1])) if levels else ("0", "0")
    if Decimal(result["bid_price"]) > 0 and Decimal(result["ask_price"]) > 0 and Decimal(result["bid_price"]) > Decimal(result["ask_price"]):
        raise ValueError("Crossed book")
    for field in ("T", "lastUpdateId"):
        value = data.get(field)
        if value is not None and (isinstance(value, bool) or number(value) is None or number(value) < 0 or not number(value).is_integer()):
            raise ValueError("Invalid book sequence")
    return result


class FocusedMarketRecoveryMixin:
    def _init_focused_recovery(self):
        self._focused_refreshing = False
        self._focused_attempts = deque()
        self._focused_retry_at = {}
        self._focused_failures = {}
        self._focused_status = {}
        self._focused_blocked_until = 0
        self._focused_books = {}

    def _focused_book_view_locked(self, original, now_ms):
        book = self._focused_books.get(original.get("symbol"))
        if book is None or not 0 <= now_ms - book["received_at"] <= 30000:
            return None
        row = dict(original)
        for meta in ("field_updated_at", "field_event_ms", "field_source"):
            row[meta] = dict(row.get(meta, {}))
        for field, value in book["values"].items():
            row[field] = value
            row["field_updated_at"][field] = book["received_at"]
            row["field_event_ms"][field] = book["event_ms"]
            row["field_source"][field] = "rest"
        row.update(quote_source="rest", quote_origin="rest_depth", quote_updated_at=book["received_at"],
                   quote_event_ms=book["event_ms"], quote_verified_at=None, quote_verification=None,
                   depth_updated_at=book["received_at"], depth_update_id=book["update_id"], quote_group_valid=True)
        return row

    def _focused_symbols_locked(self, now):
        spot = number((self._snapshot or {}).get("btc_index_price"))
        clock = int(now * 1000) + (self._snapshot or {}).get("exchange_clock_offset_ms", 0)
        watched, puts, calls = [], [], []
        for symbol, row in self._rows_by_symbol.items():
            days = (row["expiry_ms"] - clock) / 86400000
            watch = self._mark_watch.get(symbol)
            watch = watch if watch and watch["until"] > now else None
            ratio = (number(row.get("strike_price")) or 0) / spot if spot and spot > 0 else 0
            if not symbol.startswith("BTC-") or days <= 0:
                continue
            if watch:
                watched.append((watch["priority"], symbol))
            elif default_strategy_contract(row.get("side"), days, ratio):
                (puts if row["side"] == "PUT" else calls).append((abs(days - 15), symbol))
        return balanced_strategy_symbols(watched, puts, calls)[:16]

    def request_focused_refresh(self):
        with self._condition:
            now = time.time()
            if self._stop.is_set() or not self._snapshot or self._focused_refreshing or now < self._focused_blocked_until:
                return False
            while self._focused_attempts and self._focused_attempts[0][0] <= now - 60:
                self._focused_attempts.popleft()
            room = max(0, int(WEIGHT_PER_MINUTE - sum(cost for _, cost in self._focused_attempts)))
            now_ms = int(now * 1000)
            tasks = []
            index_at = event_millis(self._snapshot.get("index_updated_at")) or 0
            if (not (number(self._snapshot.get("btc_index_price")) or 0) > 0 or not 0 <= now_ms - index_at < REFRESH_AGE_SECONDS * 1000) and self._focused_retry_at.get("index:BTCUSDT", 0) <= now:
                tasks.append(("index", "BTCUSDT"))
            symbols = self._focused_symbols_locked(now)
            # Sixteen books every eight seconds would consume 120 weight/min
            # before the index, exceeding our own 80/min guard. Scale the
            # cadence with the protected set, leaving room for index repairs
            # and batch timing instead of repeatedly starving the last books.
            refresh_age_ms = max(REFRESH_AGE_SECONDS, len(symbols)) * 1000
            due_books = []
            for priority, symbol in enumerate(symbols):
                if self._focused_retry_at.get("depth:" + symbol, 0) > now:
                    continue
                row = self._quote_view_locked(self._rows_by_symbol[symbol], now_ms)
                proof = row.get("quote_verification") or {}
                if proof.get("verified") and 0 <= now_ms - proof.get("verified_at", 0) < 10000:
                    continue
                stamps = [event_millis(row.get("field_updated_at", {}).get(field)) or 0 for field in BOOK_FIELDS]
                fresh = all(number(row.get(field)) is not None and -2000 <= now_ms - stamp < refresh_age_ms
                            for field, stamp in zip(BOOK_FIELDS, stamps))
                if not fresh or row.get("quote_group_valid") is False:
                    due_books.append((min(stamps), priority, symbol))
            tasks.extend(("depth", symbol) for _, _, symbol in sorted(due_books)[:4])
            tasks = tasks[:room]
            if not tasks:
                return False
            self._focused_refreshing = True
            for kind, symbol in tasks:
                key = kind + ":" + symbol
                self._focused_attempts.append((now, 1))
                self._focused_status[key] = {**self._focused_status.get(key, {}), "refreshing": True, "last_attempt_at": now_ms, "error": None}
            self._notify_locked()
        threading.Thread(target=self._refresh_focused, args=(tasks,), name="options-focused-recovery", daemon=True).start()
        return True

    def _fetch_focused(self, kind, symbol):
        began = int(time.time() * 1000)
        with self._lock:
            if self._stop.is_set() or time.time() < self._focused_blocked_until:
                return kind, symbol, began, None, None
        try:
            endpoint = get_public("/eapi/v1/" + kind, 6,
                                  {"symbol": symbol, "limit": 10} if kind == "depth" else {"underlying": "BTCUSDT"}, max_attempts=1)
        except Exception:
            endpoint = {"ok": False, "error": {"type": "PUBLIC_RECOVERY_FAILED"}}
        return kind, symbol, began, int(time.time() * 1000), endpoint

    def _apply_focused_result(self, result):
        kind, symbol, began, received, endpoint = result
        with self._condition:
            if self._stop.is_set():
                return
            key = kind + ":" + symbol
            status = self._focused_status.setdefault(key, {})
            status["refreshing"] = False
            if endpoint is None:
                return
            valid, superseded = False, False
            try:
                endpoint = copy.deepcopy(endpoint)
                if endpoint.get("ok"):
                    validate_response(kind, endpoint)
                if endpoint.get("ok") and received is not None and 0 <= int(time.time() * 1000) - received <= 30000:
                    data = endpoint["data"]
                    if kind == "depth":
                        values = parse_depth(data)
                        event = event_millis(data.get("T"))
                        if data.get("T") is not None and (event is None or event > received + (self._snapshot or {}).get("exchange_clock_offset_ms", 0) + 2000):
                            raise ValueError("Invalid book event time")
                        row = self._rows_by_symbol.get(symbol)
                        if row is not None and row["expiry_ms"] > received + (self._snapshot or {}).get("exchange_clock_offset_ms", 0):
                            initialize_row(row, None)
                            update = data.get("lastUpdateId")
                            if update is not None and row.get("book_update_id") is not None and int(update) < row["book_update_id"]:
                                raise ValueError("Old book sequence")
                            superseded = any((event_millis(row["field_updated_at"].get(field)) or 0) >= began for field in BOOK_FIELDS)
                            if not superseded:
                                for field, value in values.items():
                                    row[field] = value
                                    row["field_updated_at"][field] = received
                                    row["field_event_ms"][field] = event
                                    row["field_source"][field] = "rest"
                                    if event is not None:
                                        row["ws_event_watermarks"][field] = max(event, row["ws_event_watermarks"].get(field) or 0)
                                row.update(quote_source="rest", quote_origin="rest_depth", quote_updated_at=received,
                                           quote_event_ms=event, depth_updated_at=received, depth_update_id=update, quote_group_valid=True)
                                if update is not None:
                                    row["book_update_id"] = int(update)
                                self._book_baselines.pop(symbol, None)
                                self._focused_books[symbol] = {"values": values, "received_at": received, "event_ms": event, "update_id": update}
                            valid = True
                    elif kind == "index" and symbol == "BTCUSDT" and (number(data.get("indexPrice")) or 0) > 0:
                        index_event = event_millis(data.get("time"))
                        if data.get("time") is not None and (index_event is None or index_event > received + self._snapshot.get("exchange_clock_offset_ms", 0) + 2000):
                            raise ValueError("Invalid index event time")
                        superseded = (event_millis(self._snapshot.get("index_updated_at")) or 0) >= began
                        if not superseded:
                            self._snapshot.update(btc_index_price=decimal_text(data["indexPrice"]), index_updated_at=received,
                                                  index_event_ms=event_millis(data.get("time")), index_source="rest")
                        valid = True
            except (ValueError, TypeError, KeyError, OverflowError):
                valid = False
            if valid:
                self._focused_failures.pop(key, None)
                self._focused_retry_at[key] = time.time() + (1 if superseded else 0)
                status.pop("retry_after_seconds", None)
                status.update(error=None, last_success_at=received, state="superseded" if superseded else "recovered")
            else:
                failures = self._focused_failures.get(key, 0) + 1
                self._focused_failures[key] = failures
                delay = min(30, 3 * 2 ** min(failures - 1, 4))
                http = endpoint.get("http_status") or endpoint.get("blocked_by_http_status")
                if http in (418, 429) or endpoint.get("rate_limited"):
                    delay = max(delay, number(endpoint.get("retry_after")) or (120 if http == 418 else 60))
                    self._focused_blocked_until = max(self._focused_blocked_until, time.time() + delay)
                self._focused_retry_at[key] = time.time() + delay
                status.update(error="行情同步暂未完成，后台自动重试", state="recovering", retry_after_seconds=delay)
            self._notify_locked()

    def _refresh_focused(self, tasks):
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                for offset in range(0, len(tasks), 2):
                    with self._lock:
                        if self._stop.is_set() or time.time() < self._focused_blocked_until:
                            break
                    futures = [pool.submit(self._fetch_focused, *task) for task in tasks[offset:offset+2]]
                    for future in futures:
                        self._apply_focused_result(future.result())
        finally:
            with self._condition:
                self._focused_refreshing = False
                for kind, symbol in tasks:
                    self._focused_status.setdefault(kind + ":" + symbol, {})["refreshing"] = False
                self._notify_locked()

    def _focused_background(self):
        while not self._stop.is_set():
            self.request_focused_refresh()
            if self._stop.wait(1):
                return
