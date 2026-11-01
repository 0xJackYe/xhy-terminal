"""Local, public BTCUSDT alerts against the Beijing calendar-day open.

One shared Binance Spot connection supplies trades and complete UTC+8 daily
klines. REST only bootstraps the chart and day baseline; it never triggers an
alarm. No API key, account access, or trading endpoint is used.
"""

import copy
import json
import math
import os
import queue
import random
import threading
import time
import uuid
from decimal import Decimal, InvalidOperation
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from binance_btc_options import _read_response, decode_public_json


DAY_MS = 86400000
BEIJING_OFFSET_MS = 8 * 3600000
MAX_EVENT_AGE_MS = 10000
MAX_FUTURE_MS = 2000
MAX_CALIBRATION_RTT_MS = 4000
CLOCK_CALIBRATION_INTERVAL_S = 300
MAX_CALIBRATION_AGE_S = 3600
REST_BASE = "https://data-api.binance.vision"
# The chart is re-checked for gaps (sleep, a dropped connection, a new day) and
# missing minutes are filled from genuine 5-minute candles.
BACKFILL_CHECK_SECONDS = 600
HISTORY_GAP_MS = 10 * 60000
WS_URL = "wss://data-stream.binance.vision/stream?" + urlencode(
    {"streams": "btcusdt@trade/btcusdt@kline_1d@+08:00"}, safe="@/:"
)
DEFAULT_SETTINGS = {
    "enabled": True, "threshold_pct": 2.5,
    "thresholds_pct": [2.5, 3.5, 5.0],
    "metric": "daily_change", "sound": True,
}


class PublicRateLimitError(Exception):
    def __init__(self, status, retry_seconds):
        self.status = status
        self.retry_seconds = retry_seconds
        super().__init__("Binance HTTP {}，暂停请求 {:.0f} 秒".format(status, retry_seconds))


def retry_after_seconds(header, now=None, default=60):
    """Retry-After is either seconds or an HTTP date; never shorten a ban."""
    try:
        seconds = Decimal(str(header))
        if seconds.is_finite() and seconds >= 0 and math.isfinite(float(seconds)):
            return max(1.0, float(seconds))
    except (InvalidOperation, TypeError, ValueError):
        pass
    try:
        instant = parsedate_to_datetime(header).timestamp()
        return max(1.0, instant - (time.time() if now is None else now))
    except (TypeError, ValueError, OverflowError, AttributeError):
        return float(default)


def beijing_day_start(milliseconds):
    return ((milliseconds + BEIJING_OFFSET_MS) // DAY_MS) * DAY_MS - BEIJING_OFFSET_MS


def _positive_decimal(value):
    if value is None or isinstance(value, bool):
        raise ValueError("price must be a positive finite number")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError("price must be a positive finite number")
    if not result.is_finite() or result <= 0 or result > Decimal("1e15"):
        raise ValueError("price must be a positive finite number")
    return result


def _millis(value):
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ValueError("invalid exchange timestamp")
    return value


def _validate_settings(changes):
    if not isinstance(changes, dict) or set(changes) - set(DEFAULT_SETTINGS):
        raise ValueError("unsupported alert settings")
    result = copy.deepcopy(changes)
    for field in ("enabled", "sound"):
        if field in result and type(result[field]) is not bool:
            raise ValueError(field + " must be true or false")
    if "metric" in result and result["metric"] not in ("daily_change", "day_range"):
        raise ValueError("metric must be daily_change or day_range")
    if "threshold_pct" in result:
        value = result["threshold_pct"]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("threshold_pct must be a number from 0.1 to 50")
        try:
            threshold = Decimal(str(value))
        except InvalidOperation:
            raise ValueError("threshold_pct must be a number from 0.1 to 50")
        if not threshold.is_finite() or not Decimal("0.1") <= threshold <= 50:
            raise ValueError("threshold_pct must be a number from 0.1 to 50")
        result["threshold_pct"] = float(threshold)
    if 'thresholds_pct' in result:
        values = result['thresholds_pct']
        if not isinstance(values, list) or not 1 <= len(values) <= 3:
            raise ValueError('thresholds_pct must contain one to three increasing thresholds')
        if any(type(value) not in (int, float) or not math.isfinite(value) or not .1 <= value <= 50 for value in values):
            raise ValueError('each threshold must be a number from 0.1 to 50')
        values = [float(value) for value in values]
        if any(a >= b for a, b in zip(values, values[1:])):
            raise ValueError('thresholds must be strictly increasing')
        if 'threshold_pct' in result and result['threshold_pct'] != values[0]:
            raise ValueError('threshold_pct must match the first threshold')
        result['thresholds_pct'], result['threshold_pct'] = values, values[0]
    elif 'threshold_pct' in result:
        # Existing API clients may continue to configure a single threshold.
        result['thresholds_pct'] = [result['threshold_pct']]
    return result


def fetch_public_json(url):
    request = Request(url, headers={"User-Agent": "LocalBtcMonitor/1.0", "Accept": "application/json"})
    deadline = time.monotonic() + 10
    try:
        with urlopen(request, timeout=10) as response:
            # A valid JSON prefix must not hide an oversized or truncated body.
            # Reuse the options transport's bounded wire read and total deadline.
            raw = _read_response(response, deadline, 10, max_bytes=2000000)
            return decode_public_json(raw.decode("utf-8"))
    except HTTPError as exc:
        if exc.code in (418, 429):
            retry = retry_after_seconds(exc.headers.get("Retry-After"), default=3600 if exc.code == 418 else 60)
            exc.close()
            raise PublicRateLimitError(exc.code, retry) from exc
        raise


def play_native_sound(cancel):
    """Play the bundled PCM alarm through the application's Windows audio.

    ``played`` means the playback request completed without a Windows API
    error, not proof that a speaker was audible. No system volume is changed.
    The sound worker waits without blocking the websocket; cancellation stops
    the asynchronous waveform immediately.
    """
    if cancel.is_set():
        return "silenced"
    try:
        import winsound
    except ImportError:
        return "unsupported"
    from audio_assets import ensure_alarm_wav, ensure_tier_wav
    level = getattr(cancel, 'sound_level', 1)
    if type(level) is not int or level not in (1, 2, 3):
        level = 1
    path, duration = ensure_alarm_wav() if level == 1 else ensure_tier_wav(level)
    if cancel.is_set():
        return "silenced"
    flags = winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT
    winsound.PlaySound(str(path), flags)
    try:
        # A short tail allows the driver's playback buffer to finish normally.
        return "silenced" if cancel.wait(duration + 0.15) else "played"
    finally:
        # SND_PURGE is unsupported on modern Windows; None is the documented
        # way to stop an asynchronously playing waveform in this process.
        winsound.PlaySound(None, 0)


class BtcAlertMonitor:
    """Thread-safe monitor; ``read`` returns an independent JSON-safe snapshot.

    ``clock`` returns Unix seconds. ``notifier(cancel_event)`` returns played,
    unsupported, silenced, or raises an exception. ``ingest`` is the same event
    entry point used by the socket and deterministic tests. ``stop`` is final.
    Settings changes apply on the next fresh exchange event, never on a cached
    price. Each rule/day/direction fires once, including across restarts.
    """

    def __init__(self, state_path=None, clock=None, notifier=None,
                 ws_factory=None, fetcher=None, monotonic=None, alert_sink=None):
        self._clock = clock or time.time
        self._monotonic = monotonic or time.monotonic
        # A test-provided clock is already authoritative; production verifies
        # the computer's time against the exchange before enabling detection.
        self._injected_clock = clock is not None
        self._clock_status = "injected" if self._injected_clock else "unverified"
        self._clock_offset_ms = 0 if self._injected_clock else None
        self._clock_rtt_ms = None
        self._clock_calibrated_local_ms = self._clock_calibrated_mono = None
        self._clock_error = None if self._injected_clock else "正在核实交易所时间，警报等待时间校准"
        self._clock_warning = None
        self._time_wakeup = threading.Event()
        self._notifier = notifier or play_native_sound
        # The sink only commits to a local outbox. Network delivery belongs to
        # its own worker and must never run inside the market-data lock.
        self._alert_sink = alert_sink
        self._email_queue_error = None
        self._ws_factory = ws_factory
        self._fetcher = fetcher or fetch_public_json
        self._state_path = Path(state_path) if state_path is not None else (
            Path(__file__).resolve().parent / "data" / "terminal-alert-state.json")
        self._lock = threading.RLock()
        self._rest_lock = threading.Lock()
        self._rest_block_until_mono = 0
        self._stop = threading.Event()
        self._started = False
        self._closed = False
        self._threads = []
        self._socket = None
        self._connected = False
        self._settings = copy.deepcopy(DEFAULT_SETTINGS)
        self._day_start_ms = beijing_day_start(self._now())
        self._day_open = self._day_high = self._day_low = None
        self._baseline_event_ms = None
        self._price = None
        self._event_ms = self._received_ms = None
        self._price_source = None
        self._last_trade_id = self._last_trade_ms = None
        self._history = {}
        self._alerts = []
        self._fired = set()
        self._instance_id = uuid.uuid4().hex
        self._revision = 0
        self._error = None
        self._rest_error = None
        self._rest_retry_at_ms = None
        self._storage_error = None
        self._time_error = None
        self._sound_queue = queue.Queue(maxsize=8)
        self._sound_thread = None
        self._sound_cancel = None
        self._sound_generation = 0
        self._restore()

    def _now(self):
        return self._local_now() + (self._clock_offset_ms or 0)

    def _local_now(self):
        return int(self._clock() * 1000)

    def _check_clock_locked(self):
        if self._injected_clock and self._clock_status == "injected":
            return True
        if self._clock_status != "calibrated" or self._clock_calibrated_mono is None:
            return False
        elapsed = self._monotonic() - self._clock_calibrated_mono
        wall_elapsed = self._local_now() - self._clock_calibrated_local_ms
        if elapsed < 0 or abs(wall_elapsed - elapsed * 1000) > MAX_FUTURE_MS:
            self._clock_status = "unverified"
            self._clock_offset_ms = None
            self._clock_error = "本机时钟发生变化，正在重新校准；警报已暂停"
        elif elapsed > MAX_CALIBRATION_AGE_S:
            self._clock_status = "expired"
            self._clock_offset_ms = None
            self._clock_error = "交易所时间校准已超过一小时，警报等待重新校准"
        else:
            return True
        self._time_wakeup.set()
        self._revision += 1
        return False

    def _calibrate_time(self, payload, before_ms, after_ms, before_mono, after_mono):
        server_ms = _millis(payload.get("serverTime") if isinstance(payload, dict) else None)
        elapsed_ms = (after_mono - before_mono) * 1000
        if not 0 <= elapsed_ms <= MAX_CALIBRATION_RTT_MS:
            raise ValueError("交易所时间请求过慢，无法可靠校准")
        if abs((after_ms - before_ms) - elapsed_ms) > MAX_FUTURE_MS:
            raise ValueError("校准过程中本机时钟发生变化")
        midpoint = (before_ms + after_ms) // 2
        if abs(server_ms - midpoint) > 365 * DAY_MS:
            raise ValueError("交易所时间与本机日期相差过大")
        with self._lock:
            if self._closed:
                return
            self._clock_offset_ms = server_ms - midpoint
            self._clock_status = "calibrated"
            self._clock_rtt_ms = round(elapsed_ms)
            self._clock_calibrated_local_ms, self._clock_calibrated_mono = after_ms, after_mono
            self._clock_error = self._clock_warning = self._time_error = None
            self._roll_day_locked(self._now())
            self._revision += 1

    def _public_fetch(self, url, timed=False):
        # Both bootstrap and time calibration share any 429/418 ban interval.
        while not self._stop.is_set():
            with self._rest_lock:
                wait = self._rest_block_until_mono - self._monotonic()
                if wait <= 0:
                    try:
                        before_ms, before_mono = self._local_now(), self._monotonic()
                        payload = self._fetcher(url)
                        after_ms, after_mono = self._local_now(), self._monotonic()
                        return (payload, before_ms, after_ms, before_mono, after_mono) if timed else payload
                    except PublicRateLimitError as exc:
                        self._rest_block_until_mono = self._monotonic() + exc.retry_seconds
                        raise
            if self._stop.wait(wait):
                break
        raise RuntimeError("monitor is stopped")

    def _time_loop(self):
        next_attempt = self._monotonic()
        last_attempt = next_attempt - 30
        while not self._stop.is_set():
            wait = next_attempt - self._monotonic()
            if wait > 0:
                if self._time_wakeup.wait(min(wait, 1)):
                    self._time_wakeup.clear()
                    next_attempt = max(self._monotonic(), last_attempt + 30)
                continue
            last_attempt = self._monotonic()
            try:
                payload, before_ms, after_ms, before_mono, after_mono = self._public_fetch(
                    REST_BASE + "/api/v3/time", timed=True)
                self._calibrate_time(payload, before_ms, after_ms, before_mono, after_mono)
                next_attempt = self._monotonic() + CLOCK_CALIBRATION_INTERVAL_S
            except Exception as exc:
                with self._lock:
                    if self._closed:
                        return
                    if self._check_clock_locked():
                        self._clock_warning = "时间重新核实暂不可用：" + str(exc)[:120]
                    else:
                        self._clock_error = "交易所时间无法可靠校准，警报已暂停：" + str(exc)[:120]
                    self._revision += 1
                next_attempt = self._monotonic() + (max(30, exc.retry_seconds)
                    if isinstance(exc, PublicRateLimitError) else 30)

    def _restore(self):
        try:
            payload = decode_public_json(self._state_path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or payload.get("version") != 1:
                return
            settings = _validate_settings(payload.get("settings", {}))
            self._settings.update(settings)
            alerts = payload.get("alerts", [])
            if isinstance(alerts, list):
                self._alerts = [item for item in alerts[-100:] if isinstance(item, dict)
                                and isinstance(item.get("id"), str)
                                and item.get("kind") in ("test", "market")]
                # A process cannot finish playing a sound after it has exited.
                for item in self._alerts:
                    if item.get("sound_status") in ("queued", "playing"):
                        item["sound_status"] = "interrupted"
            fired = payload.get("fired", [])
            if isinstance(fired, list):
                self._fired = {entry for entry in fired if isinstance(entry, str) and len(entry) < 120}
        except FileNotFoundError:
            pass
        except (ValueError, TypeError, OSError) as exc:
            self._storage_error = "无法读取提醒设置：" + str(exc)[:160]

    def _persist_locked(self):
        cutoff = self._day_start_ms - 7 * DAY_MS
        self._fired = {entry for entry in self._fired
                       if entry.split("|", 1)[0].isdigit() and int(entry.split("|", 1)[0]) >= cutoff}
        payload = {"version": 1, "settings": self._settings,
                   "alerts": self._alerts[-100:], "fired": sorted(self._fired)}
        temporary = self._state_path.with_name(self._state_path.name + ".tmp")
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            with temporary.open("w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, allow_nan=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(str(temporary), str(self._state_path))
            self._storage_error = None
        except (OSError, ValueError) as exc:
            self._storage_error = "提醒设置保存失败：" + str(exc)[:160]
        if self._storage_error is None:
            self._queue_recent_alerts_locked()

    def _queue_recent_alerts_locked(self):
        if self._closed or self._alert_sink is None:
            return
        try:
            # Replaying durable alert IDs closes the restart/save-to-outbox
            # gap. The sink owns deduplication, enable time and expiry checks.
            for alert in self._alerts:
                if alert.get("kind") == "market":
                    self._alert_sink(copy.deepcopy(alert))
            self._email_queue_error = None
        except Exception:
            # SMTP/provider errors may contain credentials or recipient data.
            self._email_queue_error = "邮件提醒暂未进入发送队列，请检查邮件设置。"

    def _roll_day_locked(self, now):
        current = beijing_day_start(now)
        if current != self._day_start_ms:
            self._day_start_ms = current
            self._day_open = self._day_high = self._day_low = None
            self._baseline_event_ms = None
            self._history = {stamp: point for stamp, point in self._history.items()
                             if stamp >= current}
            self._revision += 1

    def _fresh_timestamp(self, stamp, now):
        return -MAX_FUTURE_MS <= now - stamp <= MAX_EVENT_AGE_MS

    def _fresh_locked(self, now):
        return (self._check_clock_locked() and self._connected and self._event_ms is not None
                and self._fresh_timestamp(self._event_ms, now)
                and self._received_ms is not None
                and 0 <= now - self._received_ms <= MAX_EVENT_AGE_MS
                and beijing_day_start(self._event_ms) == self._day_start_ms)

    def read(self):
        with self._lock:
            clock_ready = self._check_clock_locked()
            now = self._now()
            self._roll_day_locked(now)
            if self._closed:
                status = "stopped"
            elif not clock_ready:
                status = "waiting_time"
            elif self._fresh_locked(now):
                status = "live" if self._day_open is not None else "waiting_baseline"
            elif self._event_ms is not None:
                status = "stale" if self._connected or self._time_error else "reconnecting"
            else:
                status = "waiting_live" if self._day_open is not None else "connecting"
            change = (float((self._price - self._day_open) * 100 / self._day_open)
                      if self._price is not None and self._day_open is not None
                      and self._event_ms is not None
                      and beijing_day_start(self._event_ms) == self._day_start_ms else None)
            amplitude = (float((self._day_high - self._day_low) * 100 / self._day_open)
                         if self._day_open is not None else None)
            market = {
                "symbol": "BTCUSDT", "source": "Binance Spot", "timezone": "Asia/Shanghai",
                "price": float(self._price) if self._price is not None else None,
                "price_source": self._price_source, "day_start_ms": self._day_start_ms,
                "day_open": float(self._day_open) if self._day_open is not None else None,
                "day_high": float(self._day_high) if self._day_high is not None else None,
                "day_low": float(self._day_low) if self._day_low is not None else None,
                "change_pct": change, "range_pct": amplitude,
                "event_ms": self._event_ms, "received_ms": self._received_ms,
                "status": status, "connected": self._connected,
                "error": self._clock_error or self._time_error or self._error,
                "rest_error": self._rest_error,
                "rest_retry_at_ms": self._rest_retry_at_ms,
                "clock_status": self._clock_status, "clock_offset_ms": self._clock_offset_ms,
                "clock_error": self._clock_error, "clock_warning": self._clock_warning,
                "clock_rtt_ms": self._clock_rtt_ms,
                "clock_calibrated_at_ms": (self._clock_calibrated_local_ms + self._clock_offset_ms
                    if self._clock_calibrated_local_ms is not None and self._clock_offset_ms is not None else None),
                "local_time_ms": self._local_now(),
            }
            return copy.deepcopy({"settings": self._settings, "market": market,
                                  "history": [self._history[key] for key in sorted(self._history)],
                                  "alerts": self._alerts[-100:], "revision": self._revision,
                                  "instance_id": self._instance_id,
                                  "server_time_ms": now, "storage_error": self._storage_error,
                                  "email_queue_error": self._email_queue_error})

    def configure(self, changes):
        clean = _validate_settings(changes)
        with self._lock:
            if self._closed:
                raise RuntimeError("monitor is stopped")
            self._settings.update(clean)
            self._revision += 1
            if not self._settings["enabled"] or not self._settings["sound"]:
                self._silence_locked()
            self._persist_locked()
        return self.read()

    def _rule_key_locked(self, direction, threshold=None):
        threshold = format(Decimal(str(self._settings['threshold_pct'] if threshold is None else threshold)).normalize(), "f")
        return "{}|{}|{}|{}".format(self._day_start_ms, self._settings["metric"], threshold, direction)

    def _detect_locked(self, now):
        if (self._closed or not self._settings["enabled"]
                or self._day_open is None or self._price is None or not self._fresh_locked(now)):
            return
        change = (self._price - self._day_open) * 100 / self._day_open
        amplitude = (self._day_high - self._day_low) * 100 / self._day_open
        if self._settings["metric"] == "daily_change":
            direction = "up" if self._price >= self._day_open else "down"
            movement = abs(self._price - self._day_open) * 100
        else:
            direction = "range"
            movement = (self._day_high - self._day_low) * 100
        for level, value in enumerate(self._settings.get('thresholds_pct', [self._settings['threshold_pct']]), 1):
            threshold = Decimal(str(value))
            if movement < threshold * self._day_open:
                continue
            key = self._rule_key_locked(direction, value)
            if key in self._fired:
                continue
            self._fired.add(key)
            self._record_alert_locked('market', direction, now, change, amplitude,
                                      threshold=value, sound_level=level)

    def _record_alert_locked(self, kind, direction, now, change=None, amplitude=None, threshold=None, sound_level=1):
        alert = {
            "id": uuid.uuid4().hex, "kind": kind, "direction": direction,
            "metric": self._settings["metric"], "threshold_pct": self._settings['threshold_pct'] if threshold is None else threshold,
            'sound_level': sound_level,
            "change_pct": float(change) if change is not None else None,
            "range_pct": float(amplitude) if amplitude is not None else None,
            "price": float(self._price) if self._price is not None else None,
            "at_ms": now, "event_ms": self._event_ms,
            "local_at_ms": self._local_now(),
            "day_start_ms": self._day_start_ms,
            "sound_status": "queued" if self._settings["sound"] else "disabled",
        }
        self._alerts.append(alert)
        self._alerts = self._alerts[-100:]
        self._revision += 1
        self._persist_locked()
        if self._settings["sound"]:
            self._ensure_sound_worker_locked()
            try:
                self._sound_queue.put_nowait((alert["id"], self._sound_generation))
            except queue.Full:
                alert["sound_status"] = "skipped_busy"
                self._persist_locked()
        return alert

    def test_alarm(self, sound_level=1):
        if type(sound_level) is not int or sound_level not in (1, 2, 3):
            raise ValueError('sound_level must be 1, 2 or 3')
        with self._lock:
            if self._closed:
                raise RuntimeError("monitor is stopped")
            self._record_alert_locked("test", "test", self._now(), sound_level=sound_level)
        return self.read()

    def _set_sound_status_locked(self, alert_id, status, error=None):
        for alert in self._alerts:
            if alert["id"] == alert_id:
                alert["sound_status"] = status
                if error:
                    alert["sound_error"] = error[:160]
                self._revision += 1
                # stop() has a bounded wait. A delayed audio driver may finish
                # after another monitor has restored the same file, so a closed
                # instance may update only its own in-memory final status.
                if not self._closed:
                    self._persist_locked()
                break

    def _silence_locked(self):
        self._sound_generation += 1
        if self._sound_cancel is not None:
            self._sound_cancel.set()
        while True:
            try:
                alert_id, _ = self._sound_queue.get_nowait()
                self._set_sound_status_locked(alert_id, "silenced")
                self._sound_queue.task_done()
            except queue.Empty:
                break

    def silence(self):
        with self._lock:
            self._silence_locked()
        return self.read()

    def _ensure_sound_worker_locked(self):
        if self._sound_thread is None:
            self._sound_thread = threading.Thread(target=self._sound_loop, name="btc-alert-sound", daemon=True)
            self._sound_thread.start()
            self._threads.append(self._sound_thread)

    def _sound_loop(self):
        while not self._stop.is_set():
            try:
                alert_id, generation = self._sound_queue.get(timeout=0.2)
            except queue.Empty:
                continue
            cancel = threading.Event()
            with self._lock:
                if self._closed or generation != self._sound_generation:
                    self._set_sound_status_locked(alert_id, "silenced")
                    self._sound_queue.task_done()
                    continue
                self._sound_cancel = cancel
                cancel.sound_level = next((a.get('sound_level', 1) for a in self._alerts if a['id'] == alert_id), 1)
                self._set_sound_status_locked(alert_id, "playing")
            error = None
            try:
                result = self._notifier(cancel)
                status = result if result in ("played", "unsupported", "silenced") else "played"
            except Exception as exc:
                status, error = "error", str(exc)
            with self._lock:
                if cancel.is_set():
                    status = "silenced"
                self._set_sound_status_locked(alert_id, status, error)
                if self._sound_cancel is cancel:
                    self._sound_cancel = None
            self._sound_queue.task_done()

    def _append_history_locked(self, stamp, price, source):
        # One live chart point per minute; detection still sees every trade.
        bucket = stamp // 60000 * 60000
        previous = self._history.get(bucket)
        if previous is None or stamp >= previous["time_ms"]:
            self._history[bucket] = {"time_ms": stamp, "price": float(price), "source": source}
        if len(self._history) > 1441:
            for key in sorted(self._history)[:-1441]:
                del self._history[key]

    def ingest(self, message, received_ms=None):
        """Accept a combined or raw public event; return whether state changed."""
        try:
            # skip_utf8_validation makes websocket-client deliver text as bytes.
            if isinstance(message, (bytes, bytearray)):
                message = message.decode("utf-8")
            event = decode_public_json(message) if isinstance(message, str) else message
            if not isinstance(event, dict):
                return False
            event = event.get("data", event)
            if not isinstance(event, dict) or event.get("s") != "BTCUSDT":
                return False
            with self._lock:
                if self._closed:
                    return False
                if not self._check_clock_locked():
                    return False
                now = self._now() if received_ms is None else _millis(received_ms)
                self._roll_day_locked(now)
                event_ms = _millis(event.get("E"))
                if not self._fresh_timestamp(event_ms, now):
                    self._time_error = "行情时间与本机时间相差过大，已暂停触发警报"
                    self._time_wakeup.set()
                    return False
                if event.get("e") == "trade":
                    accepted = self._ingest_trade_locked(event, event_ms, now)
                elif event.get("e") == "kline":
                    accepted = self._ingest_kline_locked(event, event_ms, now)
                else:
                    return False
                if accepted:
                    self._connected = True
                    self._error = self._time_error = None
                    self._revision += 1
                    self._detect_locked(now)
                return accepted
        except (ValueError, TypeError, KeyError, InvalidOperation, OverflowError, UnicodeDecodeError):
            return False

    def _ingest_trade_locked(self, event, event_ms, now):
        stamp = _millis(event.get("T"))
        trade_id = event.get("t")
        if not isinstance(trade_id, int) or isinstance(trade_id, bool) or trade_id < 0:
            return False
        if not self._fresh_timestamp(stamp, now) or stamp > event_ms + 1000:
            return False
        if beijing_day_start(stamp) != self._day_start_ms:
            return False
        if self._last_trade_id is not None and (trade_id <= self._last_trade_id
                or stamp < self._last_trade_ms):
            return False
        price = _positive_decimal(event.get("p"))
        self._last_trade_id, self._last_trade_ms = trade_id, stamp
        # A freshly received kline can be ahead of the first trade by milliseconds.
        if self._event_ms is not None and stamp < self._event_ms:
            return False
        self._price, self._event_ms, self._received_ms = price, stamp, now
        self._price_source = "websocket_trade"
        if self._day_open is not None:
            self._day_high = max(self._day_high, price)
            self._day_low = min(self._day_low, price)
        self._append_history_locked(stamp, price, "websocket")
        return True

    def _ingest_kline_locked(self, event, event_ms, now):
        kline = event.get("k")
        if not isinstance(kline, dict) or kline.get("i") != "1d" or kline.get("s") != "BTCUSDT":
            return False
        start, end = _millis(kline.get("t")), _millis(kline.get("T"))
        if start != self._day_start_ms or end != start + DAY_MS - 1:
            return False
        if self._baseline_event_ms is not None and event_ms <= self._baseline_event_ms:
            return False
        opening, high, low, closing = [_positive_decimal(kline.get(field)) for field in ("o", "h", "l", "c")]
        if low > min(opening, closing) or high < max(opening, closing) or low > high:
            return False
        if self._day_open is not None and self._day_open != opening:
            return False
        self._day_open = opening
        self._day_high = max(high, self._day_high or high)
        self._day_low = min(low, self._day_low or low)
        self._baseline_event_ms = event_ms
        # Preserve the latest fresh trade; klines mainly supply authoritative OHLC.
        if (self._price_source == "websocket_trade" and self._price is not None and self._event_ms is not None
                and self._fresh_timestamp(self._event_ms, now)
                and beijing_day_start(self._event_ms) == start):
            self._day_high = max(self._day_high, self._price)
            self._day_low = min(self._day_low, self._price)
        else:
            self._price, self._event_ms, self._received_ms = closing, event_ms, now
            self._price_source = "websocket_kline"
            self._append_history_locked(event_ms, closing, "websocket")
        return True

    def _apply_bootstrap(self, daily_rows, chart_rows, received_ms):
        """Merge REST without replacing live fields or interpreting it as an event."""
        with self._lock:
            if self._closed:
                return
            now = self._now()
            self._roll_day_locked(now)
            for row in daily_rows:
                try:
                    if _millis(row[0]) != self._day_start_ms or row[6] != row[0] + DAY_MS - 1:
                        continue
                    opening, high, low, closing = [_positive_decimal(row[index]) for index in (1, 2, 3, 4)]
                    if low > min(opening, closing) or high < max(opening, closing):
                        continue
                    if self._day_open is None:
                        self._day_open, self._day_high, self._day_low = opening, high, low
                        if (self._price is not None and self._event_ms is not None
                                and beijing_day_start(self._event_ms) == self._day_start_ms):
                            self._day_high = max(self._day_high, self._price)
                            self._day_low = min(self._day_low, self._price)
                    if self._price is None:
                        self._price, self._received_ms = closing, received_ms
                        self._price_source = "rest_bootstrap"
                except (ValueError, TypeError, IndexError):
                    continue
            for row in chart_rows:
                try:
                    start = _millis(row[0])
                    if not self._day_start_ms <= start <= now:
                        continue
                    closing = _positive_decimal(row[4])
                    stamp = min(_millis(row[6]), received_ms)
                    if stamp < self._day_start_ms or stamp > now:
                        continue
                    bucket = stamp // 60000 * 60000
                    if bucket not in self._history:
                        self._append_history_locked(stamp, closing, "rest")
                except (ValueError, TypeError, IndexError):
                    continue
            self._rest_error = None
            self._rest_retry_at_ms = None
            self._revision += 1

    def _history_gap_locked(self, now):
        start = self._day_start_ms
        if start is None:
            return False
        times = sorted(point["time_ms"] for point in self._history.values() if start <= point["time_ms"] <= now)
        points = [start] + times + [now]
        return any(later - earlier > HISTORY_GAP_MS for earlier, later in zip(points, points[1:]))

    def _bootstrap_loop(self):
        delay = 30
        loaded = False
        while not self._stop.is_set():
            try:
                with self._lock:
                    now = self._now()
                    self._roll_day_locked(now)
                    need_daily = not loaded or self._day_open is None
                    need_chart = not loaded or self._history_gap_locked(now)
                if need_daily:
                    daily_url = REST_BASE + "/api/v3/klines?" + urlencode(
                        {"symbol": "BTCUSDT", "interval": "1d", "timeZone": "8", "limit": 2})
                    daily = self._public_fetch(daily_url)
                    if self._stop.is_set():
                        return
                    if not isinstance(daily, list):
                        raise ValueError("日线接口返回格式错误")
                    self._apply_bootstrap(daily, [], self._now())
                if need_chart:
                    chart_url = REST_BASE + "/api/v3/klines?" + urlencode(
                        {"symbol": "BTCUSDT", "interval": "5m", "timeZone": "8", "limit": 288})
                    chart = self._public_fetch(chart_url)
                    if not isinstance(chart, list):
                        raise ValueError("历史行情接口返回格式错误")
                    self._apply_bootstrap([], chart, self._now())
                loaded = True
                delay = 30
                # Keep checking: a chart that lost minutes (the computer slept or
                # the live connection dropped) is refilled instead of keeping a
                # straight line across the gap.
                if self._stop.wait(BACKFILL_CHECK_SECONDS):
                    return
            except Exception as exc:
                retry_delay = max(delay, exc.retry_seconds) if isinstance(exc, PublicRateLimitError) else delay
                with self._lock:
                    if not self._closed:
                        self._rest_error = "初始历史行情暂不可用：" + str(exc)[:160]
                        self._rest_retry_at_ms = self._now() + int(retry_delay * 1000)
                        self._revision += 1
                if self._stop.wait(retry_delay):
                    return
                delay = min(delay * 2, 300)

    def start(self):
        with self._lock:
            if self._closed:
                raise RuntimeError("monitor is stopped")
            if self._started:
                return
            self._started = True
            workers = [(self._bootstrap_loop, "btc-alert-bootstrap"), (self._ws_loop, "btc-alert-stream")]
            if not self._injected_clock:
                workers.insert(0, (self._time_loop, "btc-alert-time"))
            for target, name in workers:
                thread = threading.Thread(target=target, name=name, daemon=True)
                self._threads.append(thread)
                thread.start()

    def _ws_loop(self):
        if self._ws_factory is None:
            try:
                import websocket
                factory = websocket.WebSocketApp
            except ImportError:
                with self._lock:
                    self._error = "未安装 websocket-client，无法启动实时监测"
                return
        else:
            factory = self._ws_factory
        delay = 1.0
        while not self._stop.is_set():
            connected_at = [None]

            def on_open(socket):
                with self._lock:
                    if self._closed:
                        socket.close()
                        return
                    connected_at[0] = self._clock()
                    self._connected = True
                    self._error = None
                    self._revision += 1

            def on_message(socket, message):
                self.ingest(message)

            def on_error(socket, error):
                with self._lock:
                    if not self._closed:
                        self._error = "实时连接暂不可用：" + str(error)[:160]
                        self._revision += 1

            def on_close(socket, status, reason):
                with self._lock:
                    self._connected = False
                    if not self._closed:
                        self._revision += 1

            try:
                socket = factory(WS_URL, on_open=on_open, on_message=on_message,
                                 on_error=on_error, on_close=on_close)
                with self._lock:
                    if self._closed:
                        socket.close()
                        return
                    self._socket = socket
                # websocket-client automatically replies to Binance's ping frames.
                socket.run_forever(ping_interval=20, ping_timeout=10,
                                   skip_utf8_validation=True)
            except Exception as exc:
                with self._lock:
                    if not self._closed:
                        self._error = "实时连接暂不可用：" + str(exc)[:160]
            finally:
                with self._lock:
                    self._connected = False
                    self._socket = None
            if connected_at[0] is not None and self._clock() - connected_at[0] > 30:
                delay = 1.0
            if self._stop.wait(delay + random.random() * min(delay * 0.2, 1)):
                return
            delay = min(delay * 2, 60)

    def stop(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._stop.set()
            self._time_wakeup.set()
            self._connected = False
            self._silence_locked()
            self._persist_locked()
            socket = self._socket
            self._revision += 1
        if socket is not None:
            try:
                socket.close()
            except Exception:
                pass
        for thread in self._threads:
            if thread is not threading.current_thread():
                thread.join(timeout=1.0)
