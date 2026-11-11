"""Public BTC/USDT daily candles, aligned to Beijing midnight.

Only fixed public market routes are used. Closed candles are persisted once;
the active candle is refreshed in memory while the chart is being read. No
account credentials, trades, wallet balances, or invented historical prices
are involved in this service.
"""
import copy
import datetime as dt
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from decimal import Decimal, InvalidOperation
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit, parse_qs
from urllib.request import Request

from okx_account_reader import _verified_opener


DAY_MS = 86400000
BEIJING_MS = 28800000
START_MS = 1719763200000
START_DATE = '2024-07-01'
REFRESH_SECONDS = 5
MAX_ROWS = 20000
MAX_BODY = 2000000
BINANCE_ORIGINS = ('https://data-api.binance.vision', 'https://api-gcp.binance.com')
OKX_ORIGIN = 'https://www.okx.com'
DEFAULT_CACHE = Path(__file__).resolve().parent / 'terminal' / 'data' / 'btc-daily-candles.json'


class DailyCandlesError(ValueError):
    def __init__(self, code='market_unavailable', retry_seconds=REFRESH_SECONDS):
        self.code = code
        self.retry_seconds = retry_seconds
        super().__init__(code)


def day_start(milliseconds):
    return (milliseconds + BEIJING_MS) // DAY_MS * DAY_MS - BEIJING_MS


def date_text(milliseconds):
    return dt.datetime.fromtimestamp((milliseconds + BEIJING_MS) / 1000, dt.timezone.utc).date().isoformat()


def _iso(milliseconds):
    return dt.datetime.fromtimestamp(milliseconds / 1000, dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _decimal(value, zero=False):
    if isinstance(value, bool) or not isinstance(value, (str, int)) or len(str(value)) > 100:
        raise DailyCandlesError('invalid_candle')
    try:
        result = Decimal(value)
    except (InvalidOperation, ValueError):
        raise DailyCandlesError('invalid_candle') from None
    if not result.is_finite() or result < 0 or (not zero and result == 0) or result > Decimal('1e30'):
        raise DailyCandlesError('invalid_candle')
    text = format(result, 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


def _candle(at, values, today):
    if isinstance(at, bool) or not isinstance(at, int) or at < 1230768000000 or at > today or day_start(at) != at:
        raise DailyCandlesError('invalid_day_boundary')
    opening, high, low, closing = [_decimal(value) for value in values[:4]]
    volume = _decimal(values[4], zero=True)
    if not Decimal(low) <= min(Decimal(opening), Decimal(closing)) <= max(Decimal(opening), Decimal(closing)) <= Decimal(high):
        raise DailyCandlesError('invalid_candle')
    return {'time': date_text(at), 'open': opening, 'high': high, 'low': low,
            'close': closing, 'volume': volume}


def _insert(rows, at, candle):
    if at in rows and rows[at] != candle:
        raise DailyCandlesError('conflicting_candle')
    rows[at] = candle


def parse_binance(payload, today):
    if not isinstance(payload, list) or len(payload) > 1000:
        raise DailyCandlesError('invalid_candles')
    rows = {}
    for row in payload:
        if not isinstance(row, list) or len(row) < 7:
            raise DailyCandlesError('invalid_candle')
        at = row[0]
        candle = _candle(at, row[1:6], today)
        if type(row[6]) is not int or row[6] != at + DAY_MS - 1:
            raise DailyCandlesError('invalid_day_boundary')
        _insert(rows, at, candle)
    return rows


def parse_okx(payload, today):
    if not isinstance(payload, dict) or payload.get('code') != '0' or not isinstance(payload.get('data'), list) or len(payload['data']) > 300:
        raise DailyCandlesError('invalid_candles')
    rows = {}
    for row in payload['data']:
        if not isinstance(row, list) or len(row) < 9 or not isinstance(row[0], str) or not row[0].isdigit() or row[8] not in ('0', '1'):
            raise DailyCandlesError('invalid_candle')
        at = int(row[0])
        candle = _candle(at, row[1:6], today)
        if at < today and row[8] != '1':
            raise DailyCandlesError('unconfirmed_history')
        _insert(rows, at, candle)
    return rows


def _safe_url(url):
    parsed = urlsplit(url)
    origin = parsed.scheme + '://' + parsed.netloc
    query = parse_qs(parsed.query)
    if parsed.fragment or parsed.username or parsed.password:
        return False
    if origin in BINANCE_ORIGINS:
        return (parsed.path == '/api/v3/klines' and set(query) == {'symbol', 'interval', 'timeZone', 'startTime', 'limit'}
                and query['symbol'] == ['BTCUSDT'] and query['interval'] == ['1d'] and query['timeZone'] == ['8']
                and len(query['startTime']) == len(query['limit']) == 1 and query['startTime'][0].isdigit()
                and query['limit'][0].isdigit() and 1 <= int(query['limit'][0]) <= 1000)
    return (origin == OKX_ORIGIN and parsed.path in ('/api/v5/market/history-candles', '/api/v5/market/candles')
            and set(query) <= {'instId', 'bar', 'limit', 'after'} and query.get('instId') == ['BTC-USDT']
            and query.get('bar') == ['1D'] and len(query.get('limit', [])) == 1
            and query['limit'][0].isdigit() and 1 <= int(query['limit'][0]) <= 300
            and ('after' not in query or len(query['after']) == 1 and query['after'][0].isdigit()))


def fetch_public_json(url):
    if not _safe_url(url):
        raise DailyCandlesError('endpoint_rejected')
    request = Request(url, headers={'Accept': 'application/json', 'User-Agent': 'XHY-Terminal-DailyCandles/1.0'}, method='GET')
    try:
        with _verified_opener().open(request, timeout=8) as response:
            if response.geturl() != url or response.getcode() != 200:
                raise DailyCandlesError()
            raw = response.read(MAX_BODY + 1)
        if len(raw) > MAX_BODY:
            raise DailyCandlesError('oversized_response')
        return json.loads(raw.decode('utf-8'))
    except HTTPError as error:
        retry = REFRESH_SECONDS
        if error.code in (418, 429):
            try:
                retry = max(60, min(3600, int(error.headers.get('Retry-After', '60'))))
            except (TypeError, ValueError, AttributeError):
                retry = 60
        raise DailyCandlesError(retry_seconds=retry) from None
    except DailyCandlesError:
        raise
    except Exception:
        raise DailyCandlesError() from None


def _complete(rows, start, end):
    return start <= end and all(at in rows for at in range(start, end + DAY_MS, DAY_MS))


class BTCDailyCandlesService:
    def __init__(self, cache_path=None, fetcher=None, clock=time.time):
        self.cache_path = Path(cache_path) if cache_path is not None else DEFAULT_CACHE
        self.fetcher = fetcher or fetch_public_json
        self.clock = clock
        self._lock = threading.RLock()
        self._archive = {}
        self._live = {}
        self._sources = []
        self._preferred = None
        self._last_success_ms = None
        self._next_attempt_ms = 0
        self._error = None
        self._refreshing = False
        self._closed = False
        self._thread = None
        self._load_cache()

    def _load_cache(self):
        try:
            if self.cache_path.stat().st_size > MAX_BODY:
                return
            data = json.loads(self.cache_path.read_text(encoding='utf-8'))
            if data.get('version') != 1 or data.get('timezone') != 'Asia/Shanghai' or not isinstance(data.get('candles'), list) or len(data['candles']) > MAX_ROWS:
                return
            today, rows = day_start(int(self.clock() * 1000)), {}
            for row in data['candles']:
                date = dt.date.fromisoformat(row['time'])
                at = int(dt.datetime.combine(date, dt.time(), dt.timezone(dt.timedelta(hours=8))).timestamp() * 1000)
                if at < START_MS or at >= today:
                    continue
                checked = _candle(at, [row[key] for key in ('open', 'high', 'low', 'close', 'volume')], today)
                _insert(rows, at, checked)
            self._archive = rows
            self._sources = [item for item in data.get('sources', []) if item in ('Binance Spot', 'OKX Spot')]
            saved_at = data.get('as_of_ms')
            self._last_success_ms = saved_at if type(saved_at) is int and 0 <= saved_at <= int(self.clock() * 1000) + 2000 else None
        except (OSError, ValueError, TypeError, KeyError, OverflowError):
            pass

    def _save_cache(self):
        with self._lock:
            data = {'version': 1, 'timezone': 'Asia/Shanghai', 'symbol': 'BTCUSDT', 'interval': '1d',
                    'as_of_ms': self._last_success_ms, 'sources': self._sources,
                    'candles': [self._archive[at] for at in sorted(self._archive)]}
        temporary = None
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.cache_path.parent,
                                             prefix=self.cache_path.name + '.', suffix='.tmp', delete=False) as stream:
                temporary = Path(stream.name)
                json.dump(data, stream, ensure_ascii=False, separators=(',', ':'))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.cache_path)
        except OSError:
            # The in-memory quote remains usable if the disk is unavailable.
            pass
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def _binance(self, origin, start, today):
        rows, cursor = {}, start
        for _ in range((MAX_ROWS + 999) // 1000):
            if cursor > today:
                break
            limit = min(1000, (today - cursor) // DAY_MS + 1)
            url = origin + '/api/v3/klines?' + urlencode({'symbol': 'BTCUSDT', 'interval': '1d', 'timeZone': 8,
                                                        'startTime': cursor, 'limit': limit})
            page = parse_binance(self.fetcher(url), today)
            if not page:
                break
            if min(page) < cursor:
                raise DailyCandlesError('invalid_page')
            rows.update(page)
            cursor = max(page) + DAY_MS
            if len(page) < limit:
                break
        return rows

    def _okx(self, start, today):
        rows, cursor = {}, today + DAY_MS
        if today - start <= DAY_MS:
            url = OKX_ORIGIN + '/api/v5/market/candles?' + urlencode({'instId': 'BTC-USDT', 'bar': '1D', 'limit': 2})
            return {at: row for at, row in parse_okx(self.fetcher(url), today).items() if at >= start}
        for _ in range((MAX_ROWS + 299) // 300):
            url = OKX_ORIGIN + '/api/v5/market/history-candles?' + urlencode({'instId': 'BTC-USDT', 'bar': '1D', 'limit': 300, 'after': cursor})
            page = parse_okx(self.fetcher(url), today)
            if not page:
                break
            oldest = min(page)
            if oldest >= cursor:
                raise DailyCandlesError('invalid_page')
            rows.update({at: row for at, row in page.items() if at >= start})
            if oldest <= start:
                break
            cursor = oldest
        if today not in rows:
            url = OKX_ORIGIN + '/api/v5/market/candles?' + urlencode({'instId': 'BTC-USDT', 'bar': '1D', 'limit': 2})
            rows.update({at: row for at, row in parse_okx(self.fetcher(url), today).items() if at >= start})
        return rows

    def _fetch(self, start, today):
        providers = list(BINANCE_ORIGINS) + [OKX_ORIGIN]
        if self._preferred in providers:
            providers.remove(self._preferred)
            providers.insert(0, self._preferred)
        best, best_provider, retry = {}, None, REFRESH_SECONDS
        for provider in providers:
            try:
                rows = self._okx(start, today) if provider == OKX_ORIGIN else self._binance(provider, start, today)
                if len(rows) > len(best):
                    best, best_provider = rows, provider
                if _complete(rows, start, today):
                    return rows, provider
            except Exception as error:
                retry = max(retry, error.retry_seconds if isinstance(error, DailyCandlesError) else REFRESH_SECONDS)
        if best:
            return best, best_provider
        raise DailyCandlesError(retry_seconds=retry)

    def _run(self):
        now_ms = int(self.clock() * 1000)
        today = day_start(now_ms)
        try:
            if today < START_MS or (today - START_MS) // DAY_MS >= MAX_ROWS:
                raise DailyCandlesError('unsupported_date')
            with self._lock:
                start = next((at for at in range(START_MS, today + DAY_MS, DAY_MS) if at not in self._archive), today)
            rows, provider = self._fetch(start, today)
            fresh_today = day_start(int(self.clock() * 1000))
            with self._lock:
                changed = False
                for at, row in rows.items():
                    # A request spanning midnight may have captured its then-
                    # active bar before the final trade. Refetch it as closed
                    # on the next pass instead of freezing a partial close.
                    if at < min(today, fresh_today) and at not in self._archive:
                        self._archive[at] = row
                        changed = True
                self._live = {at: row for at, row in self._live.items() if at == fresh_today}
                self._live.update({at: row for at, row in rows.items() if at == fresh_today})
                self._preferred = provider
                source = 'OKX Spot' if provider == OKX_ORIGIN else 'Binance Spot'
                if source not in self._sources:
                    self._sources.append(source)
                if fresh_today in rows:
                    self._last_success_ms = int(self.clock() * 1000)
                known = {**self._archive, **self._live}
                self._error = None if _complete(known, START_MS, fresh_today) and fresh_today in rows else '部分日 K 线暂未补齐，保留已核实行情。'
            if changed:
                self._save_cache()
        except Exception as error:
            with self._lock:
                self._error = '行情暂时无法更新，保留上次已核实日 K 线。'
                retry = error.retry_seconds if isinstance(error, DailyCandlesError) else REFRESH_SECONDS
                self._next_attempt_ms = max(self._next_attempt_ms, int(self.clock() * 1000) + int(retry * 1000))
        finally:
            with self._lock:
                self._refreshing = False

    def snapshot(self, wait=False):
        run, thread = False, None
        with self._lock:
            now_ms = int(self.clock() * 1000)
            if not self._closed and not self._refreshing and now_ms >= self._next_attempt_ms:
                self._refreshing = True
                self._next_attempt_ms = now_ms + REFRESH_SECONDS * 1000
                if wait:
                    run = True
                else:
                    self._thread = threading.Thread(target=self._run, name='btc-daily-candles', daemon=True)
                    self._thread.start()
            thread = self._thread
        if run:
            self._run()
        elif wait and thread is not None and thread.is_alive():
            thread.join(timeout=30)
        with self._lock:
            now_ms = int(self.clock() * 1000)
            today = day_start(now_ms)
            known = {**self._archive, **{at: row for at, row in self._live.items() if at == today}}
            complete = _complete(known, START_MS, today)
            fresh = complete and self._error is None and self._last_success_ms is not None and 0 <= now_ms - self._last_success_ms <= REFRESH_SECONDS * 3000
            status = 'fresh' if fresh else 'stale' if known else 'loading' if self._refreshing else 'unavailable'
            return {'status': status, 'timezone': 'Asia/Shanghai', 'symbol': 'BTCUSDT', 'interval': '1d',
                    'start_date': START_DATE, 'as_of': _iso(self._last_success_ms) if self._last_success_ms is not None else None,
                    'source': ' / '.join(self._sources) or None, 'coverage_complete': complete,
                    'error': self._error, 'refresh_interval_seconds': REFRESH_SECONDS,
                    'candles': [copy.deepcopy(known[at]) for at in sorted(known) if START_MS <= at <= today]}

    def close(self):
        with self._lock:
            self._closed = True
            thread = self._thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=1)
