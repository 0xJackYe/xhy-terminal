"""Binance Options public WebSocket transport and lossless field updates.

Current official streams use fstream /market and /public (October 2026).
No API keys, signing, orders, account streams, or credentials are supported.
"""

import copy
import json
import random
import threading
import time
from decimal import Decimal, InvalidOperation

MARKET_URL = "wss://fstream.binance.com/market/stream"
PUBLIC_URL = "wss://fstream.binance.com/public/stream"
MAX_STREAMS = 180  # Official maximum: 200; leave room for future additions.
HEARTBEAT_INTERVAL_SECONDS = 10
HEARTBEAT_TIMEOUT_SECONDS = 20
BOOK_BATCH_INTERVAL_SECONDS = 0.05
MARK_FIELDS = {"mp": "mark_price", "vo": "mark_iv", "b": "bid_iv", "a": "ask_iv", "d": "delta", "g": "gamma", "t": "theta", "v": "vega"}
QUOTE_FIELDS = {"b": "bid_price", "a": "ask_price", "B": "bid_quantity", "A": "ask_quantity"}
MARK_QUOTE_FIELDS = {"bo": "bid_price", "ao": "ask_price", "bq": "bid_quantity", "aq": "ask_quantity"}
TICKER_FIELDS = {"c": "last_price", "v": "volume_24h_contracts", "q": "amount_24h_quote", "p": "price_change", "P": "price_change_percent"}
GROUP_FIELDS = {
    "quote": set(QUOTE_FIELDS.values()),
    "mark": set(MARK_FIELDS.values()),
    "ticker": set(TICKER_FIELDS.values()) | {"last_trade_beijing"},
}


def decode_json_frame(message):
    """Decode WebSocket JSON once, strictly as UTF-8 rather than JSON auto-detection."""
    return json.loads(message.decode("utf-8") if isinstance(message, bytes) else message)


def decimal_text(value):
    """Preserve the exact exchange decimal string; reject bool/NaN/infinity."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        candidate = str(value)
        return candidate if Decimal(candidate).is_finite() else None
    except (InvalidOperation, ValueError, TypeError):
        return None


def event_millis(value):
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
        return number if 0 < number < 253402300800000 else None
    except (ValueError, TypeError, OverflowError):
        return None


def initialize_row(row, received_ms):
    row.setdefault("field_updated_at", {})
    row.setdefault("field_event_ms", {})
    row.setdefault("field_source", {})
    row.setdefault("ws_event_watermarks", {})
    for group, fields in GROUP_FIELDS.items():
        row.setdefault(group + "_updated_at", received_ms)
        row.setdefault(group + "_event_ms", None)
        row.setdefault(group + "_source", "rest")
        for field in fields:
            if field in row:
                row["field_updated_at"].setdefault(field, received_ms)
                row["field_event_ms"].setdefault(field, None)
                row["field_source"].setdefault(field, "rest")


def merge_fields(row, event, mapping, group, received_ms, event_ms):
    """Older stream events must not roll back newer fields across stream types."""
    changed = False
    for wire, field in mapping.items():
        if wire not in event:
            continue
        value = decimal_text(event[wire])
        if value is None:
            continue
        previous = event_millis(row["ws_event_watermarks"].get(field, row["field_event_ms"].get(field)))
        if previous is not None and event_ms < previous:
            continue
        # REST has a receipt time, not a guaranteed exchange event timestamp.
        # Only compare exchange times against other exchange times.
        row[field] = value
        row["field_updated_at"][field] = received_ms
        row["field_event_ms"][field] = event_ms
        row["field_source"][field] = "websocket"
        row["ws_event_watermarks"][field] = event_ms
        changed = True
    if changed:
        row[group + "_updated_at"] = max(event_millis(row.get(group + "_updated_at")) or 0, received_ms)
        row[group + "_event_ms"] = max(event_millis(row.get(group + "_event_ms")) or 0, event_ms)
        row[group + "_source"] = "websocket"
    return changed


def preserve_concurrent_updates(snapshot, previous, began_ms):
    """Retain omitted fields and never roll back WS updates received during REST."""
    old_rows = {row["symbol"]: row for row in previous.get("options", [])}
    for row in snapshot.get("options", []):
        old = old_rows.get(row["symbol"])
        if not old:
            continue
        row["ws_event_watermarks"] = copy.deepcopy(old.get("ws_event_watermarks", {}))
        if old.get("book_update_id") is not None:
            row["book_update_id"] = old["book_update_id"]
        for field, received in old.get("field_updated_at", {}).items():
            received = event_millis(received)
            omitted = field not in row
            incoming_received = event_millis(row.get("field_updated_at", {}).get(field)) or 0
            recovery_field = field in GROUP_FIELDS["mark"] or field in GROUP_FIELDS["quote"]
            mark_newer = received is not None and received > incoming_received and (field in GROUP_FIELDS["mark"] or field in GROUP_FIELDS["quote"] and old.get("field_source", {}).get(field) == "rest")
            concurrent = received is not None and received >= began_ms and old.get("field_source", {}).get(field) == "websocket"
            concurrent = concurrent or (recovery_field and received is not None and received > began_ms and old.get("field_source", {}).get(field) == "rest")
            if field in old and (omitted or concurrent or mark_newer):
                row[field] = old[field]
                for meta in ("field_updated_at", "field_event_ms", "field_source"):
                    row[meta][field] = old[meta].get(field)
                row["field_updated_at"][field] = received
                row["field_event_ms"][field] = event_millis(row["field_event_ms"][field])
        for group, fields in GROUP_FIELDS.items():
            available = [field for field in fields if event_millis(row["field_updated_at"].get(field)) is not None]
            if available:
                row[group + "_updated_at"] = max(event_millis(row["field_updated_at"][field]) for field in available)
                events = [event_millis(row["field_event_ms"].get(field)) for field in available]
                row[group + "_event_ms"] = max((value for value in events if value is not None), default=None)
                sources = {row["field_source"].get(field) for field in available}
                row[group + "_source"] = next(iter(sources)) if len(sources) == 1 else "mixed"
    index_received = event_millis(previous.get("index_updated_at"))
    incoming_index_at = event_millis(snapshot.get("index_updated_at")) or 0
    if index_received is not None and (previous.get("index_source") == "rest" and index_received > incoming_index_at or index_received > began_ms
                                      or previous.get("index_source") == "websocket" and index_received >= began_ms):
        for field in ("btc_index_price", "index_updated_at", "index_event_ms", "index_source"):
            snapshot[field] = copy.deepcopy(previous.get(field))
        snapshot["index_updated_at"] = index_received
        snapshot["index_event_ms"] = event_millis(snapshot["index_event_ms"])
    snapshot["ws_index_watermark_ms"] = event_millis(previous.get("ws_index_watermark_ms", previous.get("index_event_ms") if previous.get("index_source") == "websocket" else None))


def subscription_plan(symbols, index_price=None):
    symbols = sorted(set(symbols))
    if not symbols:
        return []
    expiries = sorted({symbol.split("-")[1] for symbol in symbols if symbol.startswith("BTC-") and len(symbol.split("-")) == 4})
    # The mark feed includes the underlying index in its official `i` field.
    # Keep it in a dedicated connection to avoid multiplexing large mark arrays.
    # Contract listings are reconciled by the scheduled REST catalog refresh.
    plan = [("market", MARKET_URL, ["btcusdt@optionMarkPrice"]),
            ("index", MARKET_URL, ["!index@arr"])]
    ticker_streams = ["btcusdt@optionTrade"] + ["btcusdt@optionTicker" + expiry for expiry in expiries]
    for offset in range(0, len(ticker_streams), MAX_STREAMS):
        plan.append(("ticker-%s" % (offset // MAX_STREAMS), PUBLIC_URL, ticker_streams[offset:offset + MAX_STREAMS]))
    index = Decimal(decimal_text(index_price) or "0")
    def priority(symbol):
        parts = symbol.split("-")
        return parts[1], abs(Decimal(parts[2]) - index), symbol
    selected = sorted(symbols, key=priority)
    book_streams = [symbol.lower() + "@bookTicker" for symbol in selected]
    book_connections = (len(book_streams) + MAX_STREAMS - 1) // MAX_STREAMS
    for group in range(book_connections):
        # Spread nearby active strikes across sockets instead of concentrating
        # the entire nearest expiry and its receive backlog in the first group.
        plan.append(("book-%s" % group, PUBLIC_URL, book_streams[group::book_connections]))
    return plan


class BookTickerMailbox:
    """Bounded latest-complete-book mailbox for one physical socket generation.

    Protocol reads never wait for the cache callback. A quiet symbol's original
    receipt time survives coalescing and dispatch; reconnects cancel old batches.
    """
    def __init__(self, symbols, on_message, transport, is_active=lambda: True, start=True,
                 exchange_clock_offset=lambda: 0):
        self._symbols = frozenset(symbols)
        self._on_message = on_message
        self._transport = dict(transport)
        self._is_active = is_active
        self._exchange_clock_offset = exchange_clock_offset
        self._lock = threading.Lock()
        self._cancelled = threading.Event()
        self._pending = {}
        self._watermarks = {}
        self._coalesced = self._dispatched = 0
        self._callback_last_ms = self._callback_max_ms = 0
        self._error = None
        self._thread = None
        if start:
            self._thread = threading.Thread(target=self._run,
                name="options-book-dispatch-" + str(transport.get("connection", "")), daemon=True)
            self._thread.start()

    def offer(self, data, received_ms):
        events = data if isinstance(data, list) else [data]
        with self._lock:
            if self._cancelled.is_set() or not self._is_active():
                return
            for event in events:
                if not isinstance(event, dict) or event.get("e") != "bookTicker" or event.get("s") not in self._symbols:
                    continue
                stamp = event_millis(event.get("E"))
                if stamp is None:
                    continue
                receipt = event_millis(received_ms)
                if receipt is None or stamp > receipt + self._exchange_clock_offset() + 2000:
                    # Reject before committing a queue watermark. Otherwise one
                    # future frame can discard every normal book that follows,
                    # even when the cache correctly rejects that bad frame.
                    raise ValueError("FutureBookTicker")
                # The official bookTicker is a complete four-field book. If a
                # malformed partial frame appears, revoke this connection rather
                # than let an older certified book hide a new zero/missing side.
                values = [decimal_text(event.get(field)) for field in QUOTE_FIELDS]
                if any(value is None or Decimal(value) < 0 for value in values):
                    raise ValueError("IncompleteBookTicker")
                symbol, update = event["s"], event_millis(event.get("u"))
                previous = self._watermarks.get(symbol)
                if previous is not None:
                    old_stamp, old_update = previous
                    if stamp < old_stamp or (update is not None and old_update is not None and update < old_update):
                        continue
                    if stamp == old_stamp and (update is None or old_update is None or update == old_update):
                        continue
                if symbol in self._pending:
                    self._coalesced += 1
                self._watermarks[symbol] = stamp, update if update is not None else previous[1] if previous else None
                self._pending[symbol] = (dict(event), received_ms)

    def dispatch_once(self):
        with self._lock:
            if self._cancelled.is_set() or not self._is_active() or not self._pending:
                return 0
            pending, self._pending = self._pending, {}
        if self._cancelled.is_set() or not self._is_active():
            return 0
        transport = dict(self._transport,
            received_at_by_symbol={symbol: item[1] for symbol, item in pending.items()},
            _cancelled=self._cancelled)
        began = time.perf_counter()
        self._on_message({"data": [item[0] for item in pending.values()], "_transport": transport})
        duration = (time.perf_counter() - began) * 1000
        with self._lock:
            self._dispatched += 1
            self._callback_last_ms = duration
            self._callback_max_ms = max(self._callback_max_ms, duration)
        return len(pending)

    def _run(self):
        while not self._cancelled.wait(BOOK_BATCH_INTERVAL_SECONDS):
            try:
                self.dispatch_once()
            except Exception as exc:
                with self._lock:
                    self._error = type(exc).__name__
                self.close()
                return

    def diagnostics(self):
        with self._lock:
            return {"queue_pending": len(self._pending), "queue_capacity": len(self._symbols),
                    "coalesced_frames": self._coalesced, "dispatched_batches": self._dispatched,
                    "dispatch_callback_last_ms": round(self._callback_last_ms, 3),
                    "dispatch_callback_max_ms": round(self._callback_max_ms, 3), "dispatch_error": self._error}

    def close(self):
        self._cancelled.set()
        with self._lock:
            self._pending.clear()


class OptionsWebSocketHub:
    """One shared set of read-only sockets for every local browser client."""
    def __init__(self, on_message, on_state, on_reconnect):
        self.on_message = on_message
        self.on_state = on_state
        self.on_reconnect = on_reconnect
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._symbols = ()
        self._connections = {}
        self._threads = []
        self._generation = 0
        self._connection_serial = 0
        self._book_mailboxes = {}
        self._exchange_clock_offset_ms = 0

    def set_exchange_clock_offset(self, offset):
        self._exchange_clock_offset_ms = offset

    def configure(self, symbols, index_price=None):
        symbols = tuple(sorted(set(symbols)))
        with self._lock:
            if symbols == self._symbols or self._stop.is_set():
                return
            self._symbols = symbols
            self._generation += 1
            generation = self._generation
            old = list(self._connections.values())
            self._connections = {}
            mailboxes = list(self._book_mailboxes.values())
            self._book_mailboxes = {}
        for mailbox in mailboxes:
            mailbox.close()
        for socket in old:
            try:
                socket.close()
            except Exception:
                # A disconnected socket must not prevent the new generation
                # from subscribing to the current contract directory.
                pass
        plan = subscription_plan(symbols, index_price)
        self.on_state("plan", {"streams": sum(len(item[2]) for item in plan), "connections": len(plan),
                               "book_symbol_count": sum(len(streams) for name, _, streams in plan if name.startswith("book-")),
                               "plan_generation": generation})
        for name, url, streams in plan:
            thread = threading.Thread(target=self._run, args=(name, url, streams, generation), name="options-ws-" + name, daemon=True)
            self._threads.append(thread)
            thread.start()

    def _active(self, generation):
        return not self._stop.is_set() and generation == self._generation

    def _run(self, name, url, streams, generation):
        try:
            import websocket
        except ImportError:
            self.on_state(name, {"connected": False, "error": "未安装 websocket-client，已切换公开 REST 行情。", "plan_generation": generation})
            return
        failures = 0
        while self._active(generation):
            connection = None
            mailbox = None
            opened_at = time.monotonic()
            last_data_at = opened_at
            confirmed = False
            data_received = False
            error_type = None
            error_message = "实时连接中断，正在重连；保留最近行情。"
            state_meta = {"plan_generation": generation}
            business_frames = 0
            callback_last_ms = callback_max_ms = 0
            last_wire_at = last_event_at = None
            ping_serial, pending_ping, ping_sent_at, last_pong_at = 0, None, None, None
            close_code = None

            def diagnostics():
                details = {"received_frames": business_frames, "callback_last_ms": round(callback_last_ms, 3),
                        "callback_max_ms": round(callback_max_ms, 3), "last_wire_at_ms": last_wire_at,
                        "last_event_at_ms": last_event_at,
                        "last_wire_lag_ms": last_wire_at - last_event_at if last_wire_at and last_event_at else None,
                        "pending_ping_age_ms": round((time.monotonic() - ping_sent_at) * 1000) if pending_ping is not None else None,
                        "last_pong_age_ms": round((time.monotonic() - last_pong_at) * 1000) if last_pong_at is not None else None,
                        "connection_lifetime_ms": round((time.monotonic() - opened_at) * 1000), "close_code": close_code}
                if mailbox is not None:
                    details.update(mailbox.diagnostics())
                return details
            try:
                # recv_data(control_frame=True) processes server PING frames
                # automatically and also exposes PONG replies to our own PINGs.
                # Avoid an extra dispatcher/watchdog thread competing with ticks.
                # Declare streams in the handshake URL as well as requesting a
                # confirmation. The explicit combined URL is the documented
                # route and was stable in independent direct-recv checks.
                stream_url = url + "?streams=" + "/".join(streams)
                # decode_json_frame already performs strict UTF-8 decoding.
                # Avoid websocket-client's second, pure-Python validation of
                # every byte; large mark arrays otherwise hold the GIL.
                connection = websocket.create_connection(stream_url, timeout=10, enable_multithread=True,
                                                         skip_utf8_validation=True)
                connection.settimeout(5)
                with self._lock:
                    if not self._active(generation):
                        connection.close()
                        return
                    self._connections[name] = connection
                with self._lock:
                    self._connection_serial += 1
                    connection_generation = self._connection_serial
                opened_ms = int(time.time() * 1000)
                state_meta = {"plan_generation": generation, "generation": connection_generation, "opened_at_ms": opened_ms,
                              "symbols": [stream.split("@")[0].upper() for stream in streams] if name.startswith("book-") else []}
                self.on_state(name, dict(state_meta, connected=False, error=None))
                if name.startswith("book-"):
                    mailbox = BookTickerMailbox(state_meta["symbols"], self.on_message,
                        {"connection": name, "generation": connection_generation, "plan_generation": generation},
                        is_active=lambda expected_plan=generation, expected_name=name, expected_socket=connection:
                            self._active(expected_plan) and self._connections.get(expected_name) is expected_socket,
                        exchange_clock_offset=lambda: self._exchange_clock_offset_ms)
                    with self._lock:
                        self._book_mailboxes[name] = mailbox
                # LIST is used once to verify the exact subscription set. Its
                # application response is not used as a recurring heartbeat.
                connection.send(json.dumps({"method": "LIST_SUBSCRIPTIONS", "id": 1}))
                list_pending = True
                list_sent_at = time.monotonic()
                last_data_at = list_sent_at
                while self._active(generation):
                    tick = time.monotonic()
                    if mailbox is not None and mailbox.diagnostics()["dispatch_error"]:
                        error_type = "BookDispatchError"
                        break
                    if tick - opened_at > 23.5 * 3600:
                        error_type = "ScheduledRotation"
                        break
                    if list_pending and tick - list_sent_at > HEARTBEAT_TIMEOUT_SECONDS:
                        error_message = "实时行情订阅确认超时，正在重连。"
                        error_type = "SubscriptionTimeout"
                        break
                    if pending_ping is not None and tick - ping_sent_at > HEARTBEAT_TIMEOUT_SECONDS:
                        error_message = "实时行情 PONG 心跳超时，正在重连。"
                        error_type = "HeartbeatTimeout"
                        break
                    if confirmed and name in ("market", "index") and tick - last_data_at > 20:
                        error_message = "标记价实时流暂时静默，正在重连。" if name == "market" else "指数实时流暂时静默，正在重连。"
                        error_type = "MarketStreamSilent" if name == "market" else "IndexStreamSilent"
                        break
                    if confirmed and pending_ping is None and (last_pong_at is None or tick - last_pong_at >= HEARTBEAT_INTERVAL_SECONDS):
                        ping_serial += 1
                        pending_ping = ("btc-options:%s:%s:%s" % (generation, connection_generation, ping_serial)).encode("ascii")
                        ping_sent_at = tick
                        connection.ping(pending_ping)
                    try:
                        opcode, message = connection.recv_data(control_frame=True)
                        received_wire_ms = int(time.time() * 1000)
                    except websocket.WebSocketTimeoutException:
                        continue
                    if not self._active(generation):
                        return
                    if opcode == websocket.ABNF.OPCODE_PING:
                        # websocket-client already sent the matching PONG.
                        continue
                    if opcode == websocket.ABNF.OPCODE_PONG:
                        pong = message.encode("utf-8") if isinstance(message, str) else message
                        if pending_ping is not None and pong == pending_ping:
                            pending_ping = None
                            last_pong_at = time.monotonic()
                            self.on_state(name, dict(state_meta, connected=True, error=None, subscription_confirmed=True,
                                heartbeat_at=int(time.time() * 1000), heartbeat_kind="pong", heartbeat_request_id=ping_serial,
                                diagnostics=diagnostics()))
                        continue
                    if opcode == websocket.ABNF.OPCODE_CLOSE:
                        error_type = "RemoteClosed"
                        if isinstance(message, bytes) and len(message) >= 2:
                            close_code = int.from_bytes(message[:2], "big")
                        break
                    if message in ("", b""):
                        error_type = "RemoteClosed"
                        break
                    try:
                        payload = decode_json_frame(message)
                    except (ValueError, TypeError):
                        continue
                    if isinstance(payload, dict) and payload.get("code") is not None:
                        error_message = "币安拒绝实时行情订阅，已降级为 REST。"
                        error_type = "SubscriptionRejected"
                        break
                    if isinstance(payload, dict) and "id" in payload and "result" in payload:
                        if not list_pending or type(payload["id"]) is not int or payload["id"] != 1:
                            continue
                        subscriptions = payload["result"]
                        if not isinstance(subscriptions, list) or not all(isinstance(item, str) for item in subscriptions) or not set(streams).issubset(set(subscriptions)):
                            error_message = "实时行情订阅未成功，已降级为 REST。"
                            error_type = "SubscriptionRejected"
                            break
                        confirmed, list_pending = True, False
                        self.on_state(name, dict(state_meta, connected=True, error=None, subscription_confirmed=True))
                        if name == "market":
                            self.on_reconnect()
                        continue
                    last_data_at = time.monotonic()
                    data = payload.get("data", payload) if isinstance(payload, dict) else payload
                    last_wire_at = received_wire_ms
                    events = data if isinstance(data, list) else [data]
                    event_times = [event_millis(event.get("E")) for event in events if isinstance(event, dict)]
                    last_event_at = max((stamp for stamp in event_times if stamp is not None), default=None)
                    callback_began = time.perf_counter()
                    if mailbox is not None:
                        mailbox.offer(data, last_wire_at)
                    else:
                        self.on_message({"data": data, "_transport": {"connection": name, "generation": connection_generation,
                                                                      "plan_generation": generation}})
                    callback_last_ms = (time.perf_counter() - callback_began) * 1000
                    callback_max_ms = max(callback_max_ms, callback_last_ms)
                    data_received = True
                    business_frames += 1
                    if name.startswith("book-") and business_frames % 32 == 0:
                        # Windows can round a timed 1ms sleep to a scheduler
                        # tick. Yield without a timer after a batch instead.
                        time.sleep(0)
                    if time.monotonic() - opened_at > 23.5 * 3600:
                        error_type = "ScheduledRotation"
                        break
            except Exception as exc:
                # Expose only the exception class, never proxy URLs/settings.
                error_type = type(exc).__name__
            finally:
                if mailbox is not None:
                    mailbox.close()
                if self._active(generation):
                    # Revoke quote certificates before a slow close/backoff.
                    self.on_state(name, dict(state_meta, connected=False, error=error_message, error_type=error_type,
                                            diagnostics=diagnostics()))
                if connection is not None:
                    try:
                        connection.close(timeout=1)
                    except Exception:
                        pass
                with self._lock:
                    if self._connections.get(name) is connection:
                        self._connections.pop(name, None)
                    if self._book_mailboxes.get(name) is mailbox:
                        self._book_mailboxes.pop(name, None)
            if not self._active(generation):
                return
            lifetime = time.monotonic() - opened_at
            failures = 0 if lifetime > 60 and data_received else min(failures + 1, 6)
            delay = min(60, 2 ** failures) + random.uniform(0, 1)
            if self._stop.wait(delay):
                return

    def stop(self):
        self._stop.set()
        with self._lock:
            sockets = list(self._connections.values())
            mailboxes = list(self._book_mailboxes.values())
        for mailbox in mailboxes:
            mailbox.close()
        for socket in sockets:
            try:
                socket.close()
            except Exception:
                pass

