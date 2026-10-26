"""Local encrypted OKX credentials and asynchronous, read-only asset snapshots."""
import base64
import copy
import datetime as dt
from decimal import Decimal, InvalidOperation, localcontext
import hashlib
import json
import os
from pathlib import Path
import re
import threading
import time
import uuid

from alert_email import _dpapi

DIRECTORY = Path(__file__).resolve().parent / 'terminal' / 'data' / 'okx-wallet'
FIELDS = ('api_key', 'secret_key', 'passphrase')


class WalletError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.status = code, status


def validate_credentials(value, complete=False):
    if not isinstance(value, dict) or set(value) - set(FIELDS):
        raise WalletError('invalid_credentials', '欧易凭据格式无效。')
    result = {}
    for key, text in value.items():
        if (not isinstance(text, str) or not 1 <= len(text) <= 256
                or any(ord(c) < 33 or ord(c) > 126 for c in text)):
            raise WalletError('invalid_credentials', '请检查欧易 API 凭据，不能包含空白或控制字符。')
        result[key] = text
    if complete and set(result) != set(FIELDS):
        raise WalletError('missing_credentials', '还需要创建 API 时设置的 Passphrase。')
    return result


class OKXVault:
    def __init__(self, directory=DIRECTORY, seal=None, unseal=None):
        self.directory = Path(directory)
        self.seal = seal or _dpapi
        self.unseal = unseal or (lambda b: _dpapi(b, decrypt=True))
        self.lock = threading.RLock()

    def _read(self, filename, fallback):
        try:
            box = json.loads((self.directory / filename).read_text(encoding='utf-8'))
            raw = self.unseal(base64.b64decode(box['ciphertext'], validate=True))
            return json.loads(raw.decode('utf-8'))
        except (OSError, ValueError, KeyError, TypeError, UnicodeError, RuntimeError):
            return fallback

    def _write(self, filename, value):
        temporary = None
        try:
            raw = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
            cipher = base64.b64encode(self.seal(raw)).decode('ascii')
            self.directory.mkdir(parents=True, exist_ok=True)
            temporary = self.directory / ('.okx-' + uuid.uuid4().hex + '.tmp')
            with temporary.open('x', encoding='utf-8') as f:
                json.dump({'version': 1, 'ciphertext': cipher}, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(str(temporary), str(self.directory / filename))
        except Exception:
            raise WalletError('storage', '本机欧易加密存储暂不可用。', 503) from None
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def read(self):
        with self.lock:
            try:
                return validate_credentials(self._read('credentials.protected.json', {}))
            except WalletError:
                return {}

    def save(self, credentials):
        clean = validate_credentials(credentials)
        with self.lock:
            self._write('credentials.protected.json', clean)

    def history(self, identity):
        with self.lock:
            value = self._read('history.protected.json', {})
            if isinstance(value, dict) and value.get('identity') == identity and isinstance(value.get('points'), list):
                clean = []
                for point in value['points'][-8640:]:
                    if (not isinstance(point, dict) or type(point.get('at_ms')) is not int
                            or not 0 < point['at_ms'] < 4102444800000
                            or not isinstance(point.get('timestamp'), str)):
                        continue
                    if any(point.get(k) is not None and dec(point[k]) is None for k in ('btc_total', 'total_usd')):
                        continue
                    clean.append({k: point.get(k) for k in ('timestamp', 'at_ms', 'btc_total', 'total_usd')})
                return sorted(clean, key=lambda p: p['at_ms'])
            return []

    def save_history(self, identity, points):
        with self.lock:
            self._write('history.protected.json', {'identity': identity, 'points': points[-8640:]})


def identity(credentials):
    return hashlib.sha256((credentials.get('api_key', '') + ':' + credentials.get('secret_key', '')).encode()).hexdigest()


def dec(value):
    if value is None:
        return None
    try:
        number = Decimal(str(value))
        return number if number.is_finite() else None
    except (ValueError, InvalidOperation):
        return None


def asset_view(account, valuation=None):
    if valuation is None:
        from okx_account_reader import value_cash_assets
        valuation = value_cash_assets(dict(account, server_time_ms=account.get('server_time_ms')))
    valued = {row['ccy']: row for row in valuation['assets']}
    assets = {}
    for row in account['trading']['assets']:
        ccy = row['currency']
        assets[ccy] = {'ccy': ccy, 'trading_equity': row['equity'],
                       'trading_cash_balance': row.get('cash_balance'),
                       'trading_available': row['available'], 'funding_balance': '0',
                       'funding_available': '0', 'debt': row['liabilities']}
    for row in account['funding']['assets']:
        ccy = row['currency']
        target = assets.setdefault(ccy, {'ccy': ccy, 'trading_equity': '0',
                                      'trading_cash_balance': '0', 'trading_available': '0', 'debt': '0'})
        target.update(funding_balance=row['balance'], funding_available=row['available'])
    for ccy, row in assets.items():
        value = valued.get(ccy, {})
        row['usd_value'] = value.get('usd_value')
        row['valuation_status'] = 'priced' if row['usd_value'] is not None else 'unpriced'
    # USD trading equity is official. Funding has no USD valuation in balances;
    # never invent zero value or assume USDT is always worth exactly USD 1.
    funding_zero = all(dec(row['balance']) == 0 for row in account['funding']['assets'])
    total = account['trading']['total_equity_usd'] if funding_zero else None
    btc = assets.get('BTC')
    btc_total = Decimal(0) if btc is None else None
    btc_holdings = Decimal(0) if btc is None else None
    if btc is not None:
        a, b = dec(btc.get('trading_equity')), dec(btc.get('funding_balance'))
        if a is not None and b is not None:
            with localcontext() as context:
                context.prec = max(256, len(a.as_tuple().digits) + len(b.as_tuple().digits) + 32)
                btc_total = a + b
        cash, debt = dec(btc.get('trading_cash_balance')), dec(btc.get('debt'))
        if cash is not None and debt is not None and b is not None:
            with localcontext() as context:
                context.prec = 256
                btc_holdings = cash - debt + b
    return {'assets': [assets[k] for k in sorted(assets)], 'summary': {
        'trading_usd': account['trading']['total_equity_usd'],
        'funding_usd': '0' if funding_zero else None, 'total_usd': total,
        'valuation_complete': total is not None,
        'btc_total': format(btc_total, 'f') if btc_total is not None else None,
        'btc_holdings_total': format(btc_holdings, 'f') if btc_holdings is not None else None,
        'scope_label': '交易账户与资金账户；不含赚币及子账户',
    }, 'permissions': account['permissions'], 'observed_at': account['observed_at'],
        'cash_valuation': copy.deepcopy(valuation)}


class OKXWalletService:
    def __init__(self, vault=None, client_factory=None, clock=time.time, interval=30):
        self.vault = vault or OKXVault()
        if client_factory is None:
            from okx_account_reader import OKXReadOnlyClient
            client_factory = OKXReadOnlyClient
        self.client_factory, self.clock, self.interval = client_factory, clock, max(30, interval)
        self.lock = threading.RLock()
        self.wake, self.stop_event = threading.Event(), threading.Event()
        self.credentials = self.vault.read()
        self.identity = identity(self.credentials)
        self.history = self.vault.history(self.identity)
        self.generation = 0
        self.thread = None
        self.refreshing = False
        self.last_attempt = 0
        self.last_success = None
        self.last_success_clock = 0
        self.error = None
        self.error_code = None
        self.view = None
        self.consecutive_failures = 0
        self.next_retry = 0
        self.history_error = None

    def start(self):
        with self.lock:
            if self.thread is not None:
                return
            self.thread = threading.Thread(target=self._loop, name='okx-assets-readonly', daemon=True)
            self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.wake.set()
        if self.thread:
            self.thread.join(1)

    def read_public(self):
        with self.lock:
            missing = [x for x in FIELDS if not self.credentials.get(x)]
            aged = self.view is not None and self.clock() - self.last_success_clock > 90
            result = {'configured': not missing, 'pending_credentials': bool(self.credentials) and bool(missing),
                      'missing_fields': missing, 'refreshing': self.refreshing,
                      'last_success_at': self.last_success, 'error': self.error, 'error_code': self.error_code,
                      'status': 'needs_credentials' if missing else 'stale' if (self.error or aged) and self.view else
                      'error' if self.error else 'connected' if self.view else 'connecting',
                      'assets': [], 'summary': {}, 'history': copy.deepcopy(self.history),
                      'cash_valuation': None,
                      'refresh_interval_seconds': self.interval}
            result['retry_in_seconds'] = max(0, int(self.next_retry - self.clock()))
            result['consecutive_failures'] = self.consecutive_failures
            result['history_error'] = self.history_error
            result['connection_id'] = self.identity[:24]
            if self.view:
                result.update(copy.deepcopy(self.view))
            return result

    def configure(self, updates):
        updates = validate_credentials(updates)
        if not updates:
            raise WalletError('missing_credentials', '请填写 API Passphrase。')
        with self.lock:
            candidate = dict(self.credentials)
            candidate.update(updates)
            validate_credentials(candidate, complete=True)
            self.vault.save(candidate)
            new_identity = identity(candidate)
            if new_identity != self.identity:
                self.history = self.vault.history(new_identity)
            self.credentials, self.identity = candidate, new_identity
            self.generation += 1
            self.view = None
            self.last_success = None
            self.error = self.error_code = None
            self.last_attempt = 0
            self.next_retry = 0
            self.consecutive_failures = 0
            self.history_error = None
        self.wake.set()
        return self.read_public()

    def request_refresh(self):
        self.wake.set()
        return self.read_public()

    def _loop(self):
        while not self.stop_event.is_set():
            self.wake.clear()
            self.refresh_once()
            self.wake.wait(self.interval)

    def refresh_once(self):
        with self.lock:
            if (self.refreshing or set(self.credentials) != set(FIELDS)
                    or self.clock() < self.next_retry
                    or self.last_attempt and self.clock() - self.last_attempt < 10):
                return False
            self.last_attempt = self.clock()
            self.refreshing = True
            credentials, generation = dict(self.credentials), self.generation
        try:
            client = self.client_factory(credentials)
            try:
                if callable(getattr(client, 'read_wallet_snapshot', None)):
                    snapshot = client.read_wallet_snapshot()
                    account, valuation = snapshot['account'], snapshot['valuation']
                else:
                    account, valuation = client.read_account(), None
                view = asset_view(account, valuation)
            finally:
                close = getattr(client, 'close', None)
                if callable(close):
                    close()
            with self.lock:
                if generation != self.generation or self.stop_event.is_set():
                    return False
                now = self.clock()
                stamp = dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat(timespec='seconds')
                points = list(self.history)
                if not points or now - points[-1]['at_ms'] / 1000 >= 300:
                    points.append({'timestamp': stamp, 'at_ms': int(now * 1000),
                                   'btc_total': view['summary']['btc_total'],
                                   'total_usd': view['summary']['total_usd']})
                    points = points[-8640:]
                    try:
                        self.vault.save_history(self.identity, points)
                        self.history_error = None
                    except WalletError:
                        # Local history persistence must not make a live API
                        # connection look unavailable or erase current assets.
                        self.history_error = 'history_storage_unavailable'
                self.view, self.history = view, points
                self.last_success = stamp
                self.last_success_clock = now
                self.error = self.error_code = None
                self.next_retry = 0
                self.consecutive_failures = 0
            return True
        except Exception as exc:
            from okx_account_reader import OKXReadError
            with self.lock:
                if generation == self.generation:
                    self.error = str(exc) if isinstance(exc, (OKXReadError, WalletError)) else '欧易资产暂时无法更新，稍后自动重试。'
                    self.error_code = exc.code if isinstance(exc, (OKXReadError, WalletError)) else 'unavailable'
                    self.consecutive_failures += 1
                    permanent = self.error_code in {'credentials_invalid', 'passphrase_invalid',
                        'ip_restricted', 'access_denied', 'permission_denied', 'read_only_required'}
                    delay = 300 if permanent else min(300, 30 * 2 ** min(self.consecutive_failures - 1, 4))
                    self.next_retry = self.clock() + delay
            return False
        finally:
            with self.lock:
                self.refreshing = False
