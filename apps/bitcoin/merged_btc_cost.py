"""Account-bound Binance history and a combined, read-only BTC cost view.

The original OKX book is never rewritten with another exchange's records.
Binance imports resume from encrypted cursors, and only complete scans enter
the shared book. An interrupted later scan keeps the last complete view.
"""
import copy
from decimal import Decimal, localcontext
import hashlib
import re
import threading
import time

from btc_cost_tracker import (BTCCostTracker, CostValidationError, MAX_ROWS,
                              dca_diary, iso, merge_trades, millis, number,
                              summarize, text)
from okx_wallet_service import DIRECTORY, OKXVault

MINUTE = 60000
_MESSAGES = {
    'needs_credentials': '币安只读账户尚未连接。',
    'needs_history': '等待欧易历史账本的覆盖起点。',
    'importing': '正在读取币安现货和闪兑历史，完成后并入成本。',
    'refresh_failed': '币安成交暂未同步，保留已核验的同账户记录。',
    'invalid_ledger': '币安历史账本未通过校验，暂不并入成本。',
}


def _binance_identity(credentials):
    if not all(isinstance(credentials.get(k), str) and credentials[k]
               for k in ('api_key', 'secret_key')):
        return None
    return hashlib.sha256((credentials['api_key'] + ':' + credentials['secret_key']).encode()).hexdigest()


def _validate_rates(value):
    if not isinstance(value, dict) or len(value) > MAX_ROWS:
        raise CostValidationError('invalid_rates')
    output = {}
    for key, row in value.items():
        match = re.fullmatch(r'([A-Z0-9]{1,20}):(\d+)', key) if isinstance(key, str) else None
        if not match or not isinstance(row, dict):
            raise CostValidationError('invalid_rates')
        currency, stamp = match.group(1), millis(match.group(2))
        if (stamp % MINUTE or row.get('currency') != currency or row.get('minute_ms') != stamp
                or row.get('source') not in ('Binance/1m-close', 'OKX/1m-close')):
            raise CostValidationError('invalid_rates')
        low, close, high = (number(row[k]) for k in ('low', 'close', 'high'))
        if not Decimal(0) < low <= close <= high:
            raise CostValidationError('invalid_rates')
        output[key] = copy.deepcopy(row)
    return output


def _validate_records(records, start, as_of):
    # Reuse exactly the original ledger's numeric, bill-uniqueness and coverage
    # rules without constructing a worker or reading any credentials.
    validator = object.__new__(BTCCostTracker)
    validator._validate_state({'version': 1, 'identity': 'validation', 'complete': True,
                               'coverage_start_ms': start, 'as_of_ms': as_of,
                               'records': records}, 'validation')
    for row in records:
        if row.get('venue') != 'binance' or not row['id'].startswith(('binance:', 'binance-convert:')):
            raise CostValidationError('invalid_binance_event')


class BinanceBTCTracker:
    def __init__(self, portfolio_service, okx_cost, vault=None, client_factory=None,
                 clock=time.time, interval=30):
        self.portfolio, self.okx_cost, self.clock = portfolio_service, okx_cost, clock
        self.vault = vault or OKXVault(DIRECTORY.parent / 'binance-btc-cost')
        if client_factory is None:
            from binance_btc_reader import BinanceBTCReader
            client_factory = BinanceBTCReader
        self.client_factory, self.interval = client_factory, max(10, interval)
        self.lock, self.refresh_lock = threading.RLock(), threading.Lock()
        self.stop_event, self.wake = threading.Event(), threading.Event()
        self.thread, self.context, self.state = None, None, None
        self.error_code, self.refreshing = None, False
        self.next_retry, self.failures = 0, 0

    def current_context(self):
        base = self.okx_cost.accounting_snapshot()
        ledger = base.get('ledger')
        start = ledger.get('coverage_start_ms') if isinstance(ledger, dict) else None
        with self.portfolio.lock:
            credentials = dict(self.portfolio.credentials)
            generation = getattr(self.portfolio, 'generation', None)
        account = _binance_identity(credentials)
        return credentials, {'okx_connection_id': base.get('connection_id'),
                             'binance_identity': account, 'binance_generation': generation,
                             'coverage_start_ms': start}

    @staticmethod
    def _filename(context):
        return ('ledger-' + context['binance_identity'] + '-'
                + context['okx_connection_id'] + '.protected.json')

    def _validate(self, state, context):
        if (not isinstance(state, dict) or state.get('version') != 1
                or state.get('identity') != context['binance_identity']
                or state.get('okx_connection_id') != context['okx_connection_id']
                or state.get('coverage_start_ms') != context['coverage_start_ms']
                or not isinstance(state.get('meta'), dict)
                or type(state.get('complete')) is not bool):
            raise CostValidationError('invalid_ledger')
        stamp = millis(state['as_of_ms'])
        _validate_records(state['records'], millis(context['coverage_start_ms']), stamp)
        _validate_rates(state.get('rates', {}))
        verified = state.get('verified')
        if verified is not None:
            if not isinstance(verified, dict):
                raise CostValidationError('invalid_ledger')
            _validate_records(verified['records'], context['coverage_start_ms'], millis(verified['as_of_ms']))
            _validate_rates(verified.get('rates', {}))
        return state

    def _select(self):
        credentials, context = self.current_context()
        with self.lock:
            if context == self.context:
                return credentials, context
            self.context, self.state = context, None
            self.error_code, self.next_retry, self.failures = None, 0, 0
            if not context['binance_identity']:
                self.error_code = 'needs_credentials'
                return credentials, context
            if not context['coverage_start_ms'] or not context['okx_connection_id']:
                self.error_code = 'needs_history'
                return credentials, context
        with self.vault.lock:
            state = self.vault._read(self._filename(context), None)
        error = None
        if state is not None:
            try:
                self._validate(state, context)
            except Exception:
                state, error = None, 'invalid_ledger'
        with self.lock:
            if self.context == context:
                self.state, self.error_code = state, error
        return credentials, context

    def snapshot(self):
        self._select()
        with self.lock:
            state = self.state
            verified = state.get('verified') if state else None
            if state and state.get('complete'):
                verified = state
            now_ms = int(self.clock() * 1000)
            as_of = verified.get('as_of_ms') if verified else None
            stale = bool(verified and (self.error_code or not state.get('complete')
                                      or now_ms - as_of > max(90, self.interval * 3) * 1000))
            status = ('stale' if stale else 'fresh') if verified else (
                'unavailable' if self.error_code in ('needs_credentials', 'needs_history', 'invalid_ledger')
                else 'importing')
            code = self.error_code or ('importing' if not verified else None)
            return {'status': status, 'complete': bool(verified), 'context': copy.deepcopy(self.context),
                    'records': copy.deepcopy(verified['records']) if verified else [],
                    'record_count': len(state['records']) if state else 0,
                    'rates': copy.deepcopy(verified.get('rates', {})) if verified else {},
                    'as_of_ms': as_of, 'refreshing': self.refreshing,
                    'stream_meta': copy.deepcopy(state.get('meta', {})) if state else {},
                    'error_code': code, 'error': _MESSAGES.get(code),
                    'retry_in_seconds': max(0, int(self.next_retry - self.clock()))}

    def refresh_once(self):
        if not self.refresh_lock.acquire(blocking=False):
            return False
        client, context = None, None
        try:
            credentials, context = self._select()
            if not context['binance_identity'] or not context['coverage_start_ms']:
                return False
            with self.lock:
                previous = copy.deepcopy(self.state)
                self.refreshing = True
            client = self.client_factory(credentials)
            result = client.read_since(context['coverage_start_ms'],
                                       meta=copy.deepcopy(previous['meta']) if previous else None,
                                       rates=copy.deepcopy(previous.get('rates', {})) if previous else None)
            if (not isinstance(result, dict) or type(result.get('complete')) is not bool
                    or not isinstance(result.get('meta'), dict) or not isinstance(result.get('records'), list)):
                raise CostValidationError('invalid_ledger')
            stamp = millis(result['as_of_ms'])
            if stamp > int(self.clock() * 1000) + 300000 or previous and stamp < previous['as_of_ms']:
                raise CostValidationError('invalid_coverage')
            records = merge_trades(previous['records'] if previous else [], result['records'])
            _validate_records(records, context['coverage_start_ms'], stamp)
            rates = _validate_rates(result.get('rates', {}))
            if previous:
                rates = _validate_rates(dict(previous.get('rates', {}), **rates))
            state = {'version': 1, 'identity': context['binance_identity'],
                     'okx_connection_id': context['okx_connection_id'],
                     'coverage_start_ms': context['coverage_start_ms'], 'as_of_ms': stamp,
                     'records': records, 'rates': rates, 'meta': copy.deepcopy(result['meta']),
                     'complete': result['complete'],
                     'verified': copy.deepcopy(previous.get('verified')) if previous else None}
            if previous and previous['complete']:
                state['verified'] = {k: copy.deepcopy(previous[k]) for k in ('records', 'rates', 'as_of_ms')}
            if result['complete']:
                # This distinct snapshot prevents an interrupted later import
                # from exposing a partially updated position as complete.
                state['verified'] = {k: copy.deepcopy(state[k]) for k in ('records', 'rates', 'as_of_ms')}
            self._validate(state, context)
            _, current = self.current_context()
            if current != context or self.stop_event.is_set():
                return False
            with self.vault.lock:
                self.vault._write(self._filename(context), state)
            _, current = self.current_context()
            with self.lock:
                if current != context or self.context != context or self.stop_event.is_set():
                    return False
                self.state, self.error_code, self.failures, self.next_retry = state, None, 0, 0
            return True
        except Exception:
            _, current = self.current_context()
            with self.lock:
                if context == current == self.context:
                    self.error_code = 'refresh_failed'
                    self.failures += 1
                    self.next_retry = self.clock() + min(300, self.interval * 2 ** min(4, self.failures - 1))
            return False
        finally:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass
            with self.lock:
                self.refreshing = False
            self.refresh_lock.release()

    def request_refresh(self):
        self.wake.set()
        return self.snapshot()

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._loop, name='binance-btc-history-readonly', daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.wake.set()
        if self.thread:
            self.thread.join(1)

    def _loop(self):
        while not self.stop_event.is_set():
            self.wake.clear()
            self._select()
            if self.clock() >= self.next_retry:
                self.refresh_once()
            self.wake.wait(min(300, max(self.interval, self.next_retry - self.clock())))


class MergedBTCCostTracker:
    def __init__(self, okx_cost, binance_tracker, clock=time.time, rates_provider=None):
        self.base, self.binance, self.okx, self.clock = okx_cost, binance_tracker, okx_cost.okx, clock
        self.rates_provider = rates_provider

    def start(self):
        self.binance.start()

    def stop(self):
        self.binance.stop()

    def request_refresh(self):
        self.base.request_refresh()
        self.binance.request_refresh()
        return self.read_public()

    def context_matches(self, value):
        context = value.get('venue_context') if isinstance(value, dict) and 'venue_context' in value else value
        return context == self.accounting_snapshot()['venue_context']

    def _rates(self):
        try:
            value = (self.rates_provider() if self.rates_provider else
                     OKXVault(DIRECTORY.parent / 'btc-pnl')._read('public-rates.protected.json', {}))
            return _validate_rates(value)
        except Exception:
            return {}

    def accounting_snapshot(self):
        with self.okx.lock, self.binance.portfolio.lock:
            base = self.base.accounting_snapshot()
            extra = self.binance.snapshot()
            ledger = copy.deepcopy(base.get('ledger'))
            context = copy.deepcopy(extra['context'])
            include = bool(extra['complete'] and ledger and ledger.get('complete')
                           and context.get('okx_connection_id') == base.get('connection_id')
                           and context.get('coverage_start_ms') == ledger.get('coverage_start_ms'))
            pending_events = 0
            observed = {'okx': ledger['as_of_ms']} if ledger else {}
            if include:
                merged = merge_trades(ledger['records'], extra['records'])
                observed['binance'] = extra['as_of_ms']
                ledger['as_of_ms'] = min(observed.values())
                # Only the interval observed by both venues is a complete
                # combined book. A newer fill joins once the other poll catches
                # up; neither its cost nor its timestamp is backdated.
                ledger['records'] = [row for row in merged if row['at_ms'] <= ledger['as_of_ms']]
                pending_events = len(merged) - len(ledger['records'])
            status = base.get('status', 'unavailable')
            if ledger and (status != 'fresh' or extra['status'] != 'fresh' or pending_events):
                status = 'stale'
            rates = self._rates()
            rates.update(extra['rates'])
            history = {'status': 'included' if include else 'error' if extra['error_code'] not in (None, 'importing', 'needs_credentials')
                       else 'not_connected' if extra['error_code'] == 'needs_credentials' else 'importing',
                       'records': len(extra['records']) if include else extra['record_count'],
                       'error': extra['error'], 'as_of': iso(extra['as_of_ms']) if extra['as_of_ms'] else None,
                       'complete': extra['complete'], 'sync_status': extra['status']}
            stream_meta = extra['stream_meta']
            history['spot_refresh_seconds'] = self.binance.interval
            history['convert_refresh_seconds'] = 300
            history['history_complete_through_ms'] = stream_meta.get('as_of_ms')
            spot = stream_meta.get('spot', {})
            stamps = [value.get('scanned_until_ms') for value in spot.values() if isinstance(value, dict)]
            spot_as_of = min(stamps) if stamps and all(type(value) is int for value in stamps) else None
            convert_as_of = stream_meta.get('convert', {}).get('checked_until_ms')
            history['spot_as_of_ms'] = spot_as_of
            history['spot_as_of'] = iso(spot_as_of) if spot_as_of else None
            history['convert_checked_until_ms'] = convert_as_of
            history['convert_checked_until'] = iso(convert_as_of) if convert_as_of else None
            context['binance_included'] = include
            public_connection = ((base.get('connection_id') or 'unconnected') + ':'
                                 + (context.get('binance_identity') or 'none')[:16]
                                 + (':both' if include else ':okx'))
            return {**base, 'ledger': ledger, 'status': status,
                    'coverage_complete': base.get('coverage_complete') is True,
                    'historical_rates': rates, 'venues': ['okx', 'binance'] if include else ['okx'],
                    'binance_status': extra['status'], 'binance_history': history,
                    'binance_import': history, 'venue_context': context,
                    'public_connection_id': public_connection, 'observed_through_ms': observed,
                    'pending_events': pending_events}

    @staticmethod
    def _display_records(records, rates):
        output = []
        with localcontext() as context:
            context.prec = 256
            for original in records:
                row = copy.deepcopy(original)
                currency = row['quote_ccy']
                rate = rates.get(currency + ':' + str(row['at_ms'] // MINUTE * MINUTE))
                if currency != 'USDT' and rate:
                    row['quote_ccy'] = 'USDT'
                    row['quote_amount'] = text(number(row['quote_amount']) * number(rate['close']))
                output.append(row)
        return output

    def _public_context(self, snapshot):
        return snapshot['public_connection_id']

    def read_public(self):
        with self.okx.lock, self.binance.portfolio.lock:
            return self._read_public_locked()

    def _read_public_locked(self):
        snapshot = self.accounting_snapshot()
        original = self.base.read_public()
        ledger = snapshot.get('ledger')
        public = copy.deepcopy(original)
        public.update(status=snapshot['status'], connection_id=self._public_context(snapshot),
                      venues=snapshot['venues'], binance_history=snapshot['binance_history'],
                      binance_import=snapshot['binance_import'],
                      observed_through_ms=snapshot['observed_through_ms'], pending_events=snapshot['pending_events'])
        if ledger:
            now_ms = int(self.clock() * 1000)
            display = self._display_records(ledger['records'], snapshot['historical_rates'])
            public['summary'], public['today'] = summarize(display, now_ms)
            unpriced = sorted({row['quote_ccy'] for row in display if row['quote_ccy'] != 'USDT'})
            public['summary']['unpriced_currencies'] = unpriced
            if not unpriced:
                public['summary']['net_invested_usdt'] = next(
                    (row['net_invested'] for row in public['summary']['by_currency']
                     if row['currency'] == 'USDT'), '0')
            if any(row['side'] == 'buy' and row['quote_ccy'] != 'USDT'
                   and iso(row['at_ms'])[:10] == iso(now_ms)[:10] for row in display):
                public['today']['buy_spent_usdt'] = None
                public['today']['remaining_plan_usdt'] = None
            public['last_success_at'] = iso(ledger['as_of_ms'])
            public['coverage_complete'] = snapshot['coverage_complete']
            public['recent_trades'] = [{'id': hashlib.sha256(row['id'].encode()).hexdigest()[:24],
                                        'venue': row.get('venue', 'okx'), 'time_beijing': iso(row['at_ms']),
                                        'side': row['side'], **{k: row[k] for k in (
                                            'price', 'quote_ccy', 'quote_amount', 'btc_net', 'fee_btc')}}
                                       for row in reversed(ledger['records'][-30:])]
        if snapshot['binance_status'] != 'fresh' and not public.get('error'):
            public['error'] = snapshot['binance_history']['error']
            public['error_code'] = 'binance_history_pending'
        if snapshot['pending_events'] and not public.get('error'):
            public['error'] = '两家交易所的成交采样时间正在对齐，最新成交将在下一轮并入。'
            public['error_code'] = 'venue_samples_pending'
        return public

    def read_dca_diary(self):
        with self.okx.lock, self.binance.portfolio.lock:
            return self._read_dca_diary_locked()

    def _read_dca_diary_locked(self):
        snapshot = self.accounting_snapshot()
        ledger = snapshot.get('ledger')
        records = self._display_records(ledger['records'], snapshot['historical_rates']) if ledger else []
        error = self.base.read_public().get('error')
        if snapshot['binance_status'] != 'fresh':
            error = error or snapshot['binance_history']['error']
        if snapshot['pending_events']:
            error = error or '两家交易所的成交采样时间正在对齐，最新成交将在下一轮并入。'
        now_ms = int(self.clock() * 1000)
        return {'status': snapshot['status'], 'connection_id': self._public_context(snapshot),
                'venues': snapshot['venues'], 'as_of': iso(ledger['as_of_ms']) if ledger else None,
                'today': iso(now_ms)[:10], 'timezone': 'Asia/Shanghai', 'error': error,
                'binance_history': snapshot['binance_history'],
                **dca_diary(records, ledger.get('coverage_start_ms') if ledger else None)}
