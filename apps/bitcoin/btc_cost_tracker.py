"""Persistent, read-only BTC cash-flow accounting for the local wallet page.

Amounts are Decimal strings.  This is cumulative buy expenditure less sale
proceeds, separated by actual payment currency; it is not a remaining-position
FIFO/average accounting basis and never sends an order to an exchange.
"""
from collections import defaultdict
import copy
import datetime as dt
from decimal import Decimal, InvalidOperation, localcontext
import hashlib
import re
import threading
import time

from okx_wallet_service import DIRECTORY, FIELDS, OKXVault, identity


BJ = dt.timezone(dt.timedelta(hours=8))
DAY_MS = 86400000
OVERLAP_MS = 2 * DAY_MS
MAX_OFFLINE_MS = 85 * DAY_MS
MAX_ROWS = 300000
STORAGE = DIRECTORY.parent / 'btc-cost'
ERRORS = {
    'needs_history': '当前账户尚未导入已核验的历史成本。',
    'needs_credentials': '请先连接欧易只读账户。',
    'history_gap': '离线时间超出可查询范围，保留原成本，需补齐历史账单。',
    'refresh_failed': '成本流水暂未更新，保留上次已核验记录。',
    'invalid_ledger': '本地成本账本未能通过核验，请重新导入历史账单。',
}


class CostValidationError(ValueError):
    """Fixed local codes only: never include account data in error messages."""


def number(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        raise CostValidationError('invalid_amount')
    if len(str(value)) > 512:
        raise CostValidationError('invalid_amount')
    try:
        result = Decimal(value)
    except (InvalidOperation, ValueError):
        raise CostValidationError('invalid_amount') from None
    if not result.is_finite() or abs(result.adjusted()) > 120 or len(result.as_tuple().digits) > 256:
        raise CostValidationError('invalid_amount')
    return result


def text(value):
    value = number(value)
    if not value:
        return '0'
    result = format(value, 'f')
    return result.rstrip('0').rstrip('.') if '.' in result else result


def integer(value):
    if isinstance(value, bool) or not re.fullmatch(r'[0-9]{1,30}', str(value).lstrip("'")):
        raise CostValidationError('invalid_identifier')
    return str(value).lstrip("'")


def millis(value):
    result = int(integer(value))
    if not 1230768000000 <= result < 4102444800000:
        raise CostValidationError('invalid_timestamp')
    return result


def iso(value):
    return dt.datetime.fromtimestamp(value / 1000, BJ).isoformat(timespec='milliseconds')


def _canonical_bill(raw):
    fields = ('instType', 'instId', 'subType', 'ccy', 'billId', 'ordId', 'tradeId',
              'ts', 'fillTime', 'sz', 'px', 'fee', 'balChg')
    row = {key: raw.get(key, '') for key in fields}
    for key in ('billId', 'tradeId'):
        row[key] = integer(row[key])
    row['ordId'] = integer(row['ordId']) if row['ordId'] else ''
    row['ts'] = millis(row['ts'])
    row['fillTime'] = millis(row['fillTime']) if row['fillTime'] else row['ts']
    for key in ('sz', 'px', 'balChg'):
        row[key] = text(row[key])
    # Preserve the exchange's declared last decimal place for convert rounding;
    # cosmetic trailing zero removal must not widen an accounting tolerance.
    row['_size_exponent'] = number(raw['sz']).as_tuple().exponent
    row['fee'] = text(row['fee'] or '0')
    return row


def normalize_bills(rows):
    """Pair BTC and payment legs, including BTC received from cross pairs.

    Only SPOT buys/sells and conversions are cost events. Transfers, interest,
    derivative PnL and MARGIN events are deliberately excluded.
    """
    if not isinstance(rows, list) or len(rows) > MAX_ROWS:
        raise CostValidationError('invalid_rows')
    bills, groups = {}, defaultdict(list)
    with localcontext() as context:
        context.prec = 256
        for raw in rows:
            if not isinstance(raw, dict):
                raise CostValidationError('invalid_bill')
            if (raw.get('instType') != 'SPOT' or raw.get('subType') not in ('1', '2', '318', '319')
                    or 'BTC' not in str(raw.get('instId', '')).split('-')):
                continue
            row = _canonical_bill(raw)
            old = bills.get(row['billId'])
            if old is not None:
                if any(old[key] != row[key] for key in row if key not in ('ts', 'fillTime', '_size_exponent')) or any(
                        old[key] // 1000 != row[key] // 1000 for key in ('ts', 'fillTime')):
                    raise CostValidationError('conflicting_bill')
                old['_size_exponent'] = min(old['_size_exponent'], row['_size_exponent'])
                continue
            bills[row['billId']] = row
            groups[(row['instId'], row['tradeId'], row['ordId'])].append(row)
        result = []
        for (instrument, trade_id, order_id), legs in groups.items():
            parts = instrument.split('-')
            if (len(parts) not in (2, 3) or len(parts) == 3 and parts[2] != 'CONVERT'
                    or parts[:2].count('BTC') != 1
                    or any(not re.fullmatch('[A-Z0-9]{1,20}', ccy) for ccy in parts[:2])):
                raise CostValidationError('invalid_instrument')
            ccy = next(value for value in parts[:2] if value != 'BTC')
            btc_legs = [row for row in legs if row['ccy'] == 'BTC']
            pay_legs = [row for row in legs if row['ccy'] == ccy]
            if len(legs) != 2 or len(btc_legs) != 1 or len(pay_legs) != 1:
                raise CostValidationError('incomplete_trade_legs')
            btc, pay = btc_legs[0], pay_legs[0]
            buy = btc['subType'] in ('1', '318')
            conversion = btc['subType'] in ('318', '319')
            opposite = ('319' if buy else '318') if conversion else ('2' if buy else '1')
            if pay['subType'] != opposite or abs(btc['fillTime'] - pay['fillTime']) > 1000:
                raise CostValidationError('inconsistent_trade_legs')
            size, amount, price = number(btc['sz']), number(pay['sz']), number(btc['px'])
            fee_btc, fee_pay = number(btc['fee']), number(pay['fee'])
            if size <= 0 or amount <= 0 or price <= 0:
                raise CostValidationError('invalid_trade_size')
            if parts[0] == 'BTC':
                expected, actual = size * price, amount
                unit_price = price
            else:
                expected, actual = amount * price, size
                unit_price = amount / size
            rounded_leg = btc if parts[0] != 'BTC' else pay
            tolerance = Decimal(10) ** rounded_leg['_size_exponent'] / 2 if conversion else Decimal(0)
            if abs(expected - actual) > tolerance:
                raise CostValidationError('notional_mismatch')
            btc_net = (size if buy else -size) + fee_btc
            pay_net = (-amount if buy else amount) + fee_pay
            if btc_net != number(btc['balChg']) or pay_net != number(pay['balChg']):
                raise CostValidationError('balance_change_mismatch')
            if (buy and (btc_net <= 0 or pay_net >= 0)) or (not buy and (btc_net >= 0 or pay_net < 0)):
                raise CostValidationError('invalid_net_direction')
            event_id = instrument + ':' + trade_id + ':' + order_id
            result.append({'id': event_id, 'at_ms': btc['fillTime'], 'side': 'buy' if buy else 'sell',
                           'inst_id': instrument, 'trade_id': trade_id, 'order_id': order_id,
                           'bill_id': btc['billId'], 'counter_bill_id': pay['billId'],
                           'price': text(unit_price), 'btc_gross': text(size), 'btc_net': text(btc_net),
                           'fee_btc': text(fee_btc), 'fee_quote': text(fee_pay), 'quote_ccy': ccy,
                           'quote_gross': text(amount), 'quote_amount': text(-pay_net if buy else pay_net),
                           'original_price': text(price)})
    return sorted(result, key=lambda row: (row['at_ms'], int(row['bill_id'])))


def merge_trades(existing, updates):
    records = {row['id']: copy.deepcopy(row) for row in existing}
    for row in updates:
        old = records.get(row['id'])
        if old is not None and (any(old.get(key) != row.get(key) for key in set(old) | set(row) if key != 'at_ms')
                                or old['at_ms'] // 1000 != row['at_ms'] // 1000):
            raise CostValidationError('conflicting_trade')
        records[row['id']] = copy.deepcopy(row)
    if len(records) > MAX_ROWS:
        raise CostValidationError('ledger_too_large')
    _unique_event_bills(records.values())
    return sorted(records.values(), key=lambda row: (row['at_ms'], int(row['bill_id'])))


def _unique_event_bills(records):
    owners = {}
    for row in records:
        for field in ('bill_id', 'counter_bill_id'):
            bill = integer(row[field])
            if bill in owners:
                raise CostValidationError('bill_reused_by_event')
            owners[bill] = row['id']


def summarize(records, now_ms):
    by_currency = defaultdict(lambda: defaultdict(Decimal))
    today_date = iso(now_ms)[:10]
    buy_count = sell_count = today_count = 0
    bought = sold = today_bought = today_usdt = Decimal(0)
    with localcontext() as context:
        context.prec = 256
        for row in records:
            target = by_currency[row['quote_ccy']]
            btc, amount = number(row['btc_net']), number(row['quote_amount'])
            if row['side'] == 'buy':
                buy_count += 1
                bought += btc
                target['buy_spent'] += amount
                target['bought_btc'] += btc
                if iso(row['at_ms'])[:10] == today_date:
                    today_count += 1
                    today_bought += btc
                    if row['quote_ccy'] == 'USDT':
                        today_usdt += amount
            else:
                sell_count += 1
                sold -= btc
                target['sell_received'] += amount
        currencies = []
        for currency, values in sorted(by_currency.items()):
            average = values['buy_spent'] / values['bought_btc'] if values['bought_btc'] else None
            currencies.append({'currency': currency, 'buy_spent': text(values['buy_spent']),
                               'sell_received': text(values['sell_received']),
                               'net_invested': text(values['buy_spent'] - values['sell_received']),
                               'average_buy_cost': text(average) if average is not None else None})
        summary = {'buy_count': buy_count, 'sell_count': sell_count, 'bought_btc': text(bought),
                   'sold_btc': text(sold), 'net_bought_btc': text(bought - sold), 'by_currency': currencies}
        today = {'date_beijing': today_date, 'buy_count': today_count, 'buy_spent_usdt': text(today_usdt),
                 'bought_btc': text(today_bought), 'remaining_plan_usdt': text(max(Decimal(0), 20 - today_usdt))}
    return summary, today


def daily_progress(records, now_ms):
    """Only scan today's tail; midnight never needs to recalculate all costs."""
    date = iso(now_ms)[:10]
    count, spent, bought = 0, Decimal(0), Decimal(0)
    with localcontext() as context:
        context.prec = 256
        for row in reversed(records):
            row_date = iso(row['at_ms'])[:10]
            if row_date < date:
                break
            if row_date != date or row['side'] != 'buy':
                continue
            count += 1
            bought += number(row['btc_net'])
            if row['quote_ccy'] == 'USDT':
                spent += number(row['quote_amount'])
        return {'date_beijing': date, 'buy_count': count, 'buy_spent_usdt': text(spent),
                'bought_btc': text(bought), 'remaining_plan_usdt': text(max(Decimal(0), 20 - spent))}


class BTCCostTracker:
    def __init__(self, okx_service, vault=None, client_factory=None, clock=time.time, interval=20):
        self.okx, self.clock = okx_service, clock
        self.vault = vault or OKXVault(STORAGE)
        if client_factory is None:
            from btc_cost_reader import BTCCostReader
            client_factory = BTCCostReader
        self.client_factory, self.interval = client_factory, max(10, interval)
        self.lock, self.refresh_lock = threading.RLock(), threading.Lock()
        self.wake, self.stop_event = threading.Event(), threading.Event()
        self.thread = None
        self.connection = None
        self.state = None
        self.summary = self.today = None
        self.refreshing = False
        self.error = None
        self.error_code = None
        self.failures = 0
        self.next_retry = 0
        self._switch_account()

    def _credentials(self):
        with self.okx.lock:
            return dict(self.okx.credentials)

    def _filename(self, account):
        return 'ledger-' + account + '.protected.json'

    def _context_matches_locked(self, account, credentials, generation):
        """Caller holds okx.lock then self.lock, the sole combined lock order."""
        return (self.connection == account and dict(self.okx.credentials) == credentials
                and identity(self.okx.credentials) == account
                and getattr(self.okx, 'generation', None) == generation
                and not self.stop_event.is_set())

    def _switch_account(self):
        credentials = self._credentials()
        account = identity(credentials)
        with self.lock:
            if account == self.connection:
                return credentials, account
            self.connection, self.state = account, None
            self.summary = self.today = None
            self.error = self.error_code = None
            self.failures, self.next_retry = 0, 0
            if not all(credentials.get(key) for key in FIELDS):
                self._error('needs_credentials')
                return credentials, account
        # DPAPI and a complete historical validation run outside the UI lock.
        with self.vault.lock:
            state = self.vault._read(self._filename(account), None)
        summary = today = None
        load_error = 'needs_history'
        if state is not None:
            try:
                self._validate_state(state, account)
                summary, today = summarize(state['records'], int(self.clock() * 1000))
                load_error = None
            except Exception:
                state = None
                load_error = 'invalid_ledger'
        with self.lock:
            if self.connection != account:
                return credentials, account
            self.state, self.summary, self.today = state, summary, today
            if load_error:
                self._error(load_error)
            else:
                self.error = self.error_code = None
        return credentials, account

    def _validate_state(self, state, account):
        with localcontext() as context:
            context.prec = 256
            return self._validate_state_values(state, account)

    def _validate_state_values(self, state, account):
        if (not isinstance(state, dict) or state.get('version') != 1 or state.get('identity') != account
                or state.get('complete') is not True or not isinstance(state.get('records'), list)):
            raise CostValidationError('invalid_ledger')
        if millis(state['coverage_start_ms']) > millis(state['as_of_ms']):
            raise CostValidationError('invalid_coverage')
        if len(state['records']) > MAX_ROWS:
            raise CostValidationError('ledger_too_large')
        seen = set()
        for row in state['records']:
            if not isinstance(row, dict) or row.get('side') not in ('buy', 'sell') or row.get('id') in seen:
                raise CostValidationError('invalid_event')
            if not isinstance(row.get('id'), str) or not row['id']:
                raise CostValidationError('invalid_event')
            seen.add(row['id'])
            at = millis(row['at_ms'])
            if not state['coverage_start_ms'] <= at <= state['as_of_ms']:
                raise CostValidationError('event_outside_coverage')
            if not re.fullmatch('[A-Z0-9]{1,20}', row['quote_ccy']):
                raise CostValidationError('invalid_currency')
            for key in ('price', 'btc_gross', 'btc_net', 'fee_btc', 'fee_quote', 'quote_gross', 'quote_amount', 'original_price'):
                number(row[key])
            if number(row['price']) <= 0 or number(row['btc_gross']) <= 0 or number(row['quote_gross']) <= 0 or number(row['quote_amount']) < 0:
                raise CostValidationError('invalid_event')
            sign = 1 if row['side'] == 'buy' else -1
            if number(row['btc_net']) != sign * number(row['btc_gross']) + number(row['fee_btc']):
                raise CostValidationError('invalid_event')
        _unique_event_bills(state['records'])

    def _error(self, code):
        self.error_code, self.error = code, ERRORS[code]

    def bootstrap(self, rows, *, as_of_ms, coverage_start_ms, account_identity=None):
        """Import a verified complete historical interval, never trading.

        Call once after an offline historical reconciliation, passing original
        SPOT bill legs.  Later updates are fetched automatically in background.
        """
        credentials, account = self._switch_account()
        if not all(credentials.get(key) for key in FIELDS):
            raise CostValidationError('missing_credentials')
        if account_identity is not None and account_identity != account:
            raise CostValidationError('account_changed')
        with self.okx.lock:
            if dict(self.okx.credentials) != credentials:
                raise CostValidationError('account_changed')
            generation = getattr(self.okx, 'generation', None)
        with self.refresh_lock:
            with self.okx.lock:
                with self.lock:
                    if not self._context_matches_locked(account, credentials, generation):
                        raise CostValidationError('account_changed')
                    previous = self.state
                    if previous and millis(as_of_ms) < previous['as_of_ms']:
                        raise CostValidationError('bootstrap_is_older_than_ledger')
            records = normalize_bills(rows)
            if previous:
                records = merge_trades(previous['records'], records)
            state = {'version': 1, 'identity': account, 'complete': True,
                     'coverage_start_ms': millis(coverage_start_ms), 'as_of_ms': millis(as_of_ms),
                     'records': records}
            self._validate_state(state, account)
            summary, today = summarize(state['records'], int(self.clock() * 1000))
            _, current = self._switch_account()
            if current != account:
                raise CostValidationError('account_changed')
            with self.vault.lock:
                self.vault._write(self._filename(account), state)
            with self.okx.lock:
                with self.lock:
                    if not self._context_matches_locked(account, credentials, generation):
                        raise CostValidationError('account_changed')
                    self.state = state
                    self.summary, self.today = summary, today
                    self.error = self.error_code = None
                    self.failures, self.next_retry = 0, 0
        self.wake.set()
        return self.read_public()

    def start(self):
        with self.lock:
            if self.thread and self.thread.is_alive():
                return
            self.stop_event.clear()
            self.thread = threading.Thread(target=self._loop, name='okx-btc-cost-readonly', daemon=True)
            self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.wake.set()
        if self.thread:
            self.thread.join(1)

    def request_refresh(self):
        self.wake.set()
        return self.read_public()

    def accounting_snapshot(self):
        """Internal atomic cost-book copy for read-only lifetime accounting."""
        with self.okx.lock:
            self._switch_account()
            with self.lock:
                public = self._read_public_for_current_account()
                return {'connection_id': public.get('connection_id'),
                        'status': public.get('status'), 'coverage_complete': public.get('coverage_complete'),
                        'ledger': copy.deepcopy(self.state)}

    def read_public(self):
        # Keep the selected credential context stable through cache selection.
        # RLock nesting follows the same okx -> tracker order as publication.
        with self.okx.lock:
            self._switch_account()
            return self._read_public_for_current_account()

    def _read_public_for_current_account(self):
        with self.lock:
            now_ms = int(self.clock() * 1000)
            if self.state and (self.today is None or self.today['date_beijing'] != iso(now_ms)[:10]):
                self.today = daily_progress(self.state['records'], now_ms)
            old = self.state and now_ms - self.state['as_of_ms'] > max(90, self.interval * 3) * 1000
            status = ('stale' if self.error or old else 'fresh') if self.state else ('loading' if self.refreshing else 'unavailable')
            recent = []
            for row in reversed(self.state['records'][-30:] if self.state else []):
                recent.append({'id': hashlib.sha256(row['id'].encode()).hexdigest()[:24],
                               'time_beijing': iso(row['at_ms']), 'side': row['side'],
                               **{key: row[key] for key in ('price', 'quote_ccy', 'quote_amount', 'btc_net', 'fee_btc')}})
            return {'status': status, 'refreshing': self.refreshing, 'last_success_at': iso(self.state['as_of_ms']) if self.state else None,
                    'error': self.error, 'error_code': self.error_code, 'plan_daily_usdt': '20',
                    'coverage_complete': bool(self.state) and self.error_code != 'history_gap',
                    'summary': copy.deepcopy(self.summary), 'today': copy.deepcopy(self.today),
                    'recent_trades': recent, 'refresh_interval_seconds': self.interval,
                    'connection_id': self.connection[:24],
                    'retry_in_seconds': max(0, int(self.next_retry - self.clock()))}

    def refresh_once(self):
        if not self.refresh_lock.acquire(blocking=False):
            return False
        client = None
        account = None
        try:
            credentials, account = self._switch_account()
            with self.okx.lock:
                generation = getattr(self.okx, 'generation', None)
                with self.lock:
                    if not self._context_matches_locked(account, credentials, generation) or not self.state:
                        return False
                    now_ms = int(self.clock() * 1000)
                    if now_ms - self.state['as_of_ms'] > MAX_OFFLINE_MS:
                        self._error('history_gap')
                        return False
                    previous = self.state
                    previous_summary = self.summary
                    old_asof = previous['as_of_ms']
                    start_ms = max(previous['coverage_start_ms'], old_asof - OVERLAP_MS)
                    self.refreshing = True
            client = self.client_factory(credentials)
            result = client.read_since(start_ms)
            if (not isinstance(result, dict) or result.get('complete') is not True
                    or millis(result['coverage_start_ms']) > start_ms
                    or millis(result['as_of_ms']) < old_asof
                    or result['as_of_ms'] > int(self.clock() * 1000) + 300000):
                raise CostValidationError('incomplete_coverage')
            records = normalize_bills(result['rows'])
            _, current = self._switch_account()
            if current != account or self.stop_event.is_set():
                return False
            state = dict(previous, records=merge_trades(previous['records'], records), as_of_ms=result['as_of_ms'])
            self._validate_state(state, account)
            if state['records'] == previous['records']:
                summary = previous_summary
                today = daily_progress(state['records'], int(self.clock() * 1000))
            else:
                summary, today = summarize(state['records'], int(self.clock() * 1000))
            # State becomes visible only after the complete encrypted file has
            # committed. Reads continue to serve the previous immutable cache.
            if self.stop_event.is_set():
                return False
            with self.vault.lock:
                self.vault._write(self._filename(account), state)
            # A stop during atomic write may leave a valid newer account-bound
            # file for the next start. It must never publish into another
            # selected account or continue publishing after stop.
            _, current = self._switch_account()
            if current != account or self.stop_event.is_set():
                return False
            with self.okx.lock:
                with self.lock:
                    if not self._context_matches_locked(account, credentials, generation):
                        return False
                    self.state = state
                    self.summary, self.today = summary, today
                    self.error = self.error_code = None
                    self.failures, self.next_retry = 0, 0
            return True
        except Exception:
            with self.okx.lock:
                with self.lock:
                    if account == self.connection and identity(self.okx.credentials) == account:
                        self._error('refresh_failed')
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

    def _loop(self):
        while not self.stop_event.is_set():
            self.wake.clear()
            self._switch_account()
            if self.clock() >= self.next_retry:
                self.refresh_once()
            delay = max(self.interval, self.next_retry - self.clock())
            self.wake.wait(min(300, delay))
