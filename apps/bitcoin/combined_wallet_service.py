"""Background aggregation of a confirmed address and OKX BTC cash holdings."""
import copy
import datetime as dt
from decimal import Decimal, localcontext
import json
from pathlib import Path
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from combined_wallet_engine import build_combined, normalize_onchain
from okx_wallet_service import DIRECTORY, identity

ROOT = Path(__file__).resolve().parent


def iso(milliseconds):
    return dt.datetime.fromtimestamp(milliseconds / 1000, dt.timezone.utc).isoformat(timespec='milliseconds')


def fiat_text(value):
    """Use the wallet UI's decimal-string contract for every fiat field."""
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError('invalid_fiat_amount')
    number = Decimal(str(value))
    if not number.is_finite():
        raise ValueError('invalid_fiat_amount')
    if number == 0:
        return '0'
    result = format(number, 'f')
    return result.rstrip('0').rstrip('.') if '.' in result else result


class AddressSnapshots:
    def __init__(self, proxy, clock=time.time):
        self.proxy, self.clock = proxy, clock
        self.snapshot = json.loads((ROOT / 'terminal/data/bitcoin-balance-snapshot.json').read_text(encoding='utf-8-sig'))
        self.snapshot['fx'] = json.loads((ROOT / 'terminal/data/bitcoin-cny-rates.json').read_text(encoding='utf-8-sig'))

    def request(self, resource, **params):
        return json.loads(self.proxy.read({k: [v] for k, v in dict(resource=resource, **params).items()}))

    def refresh(self):
        address = self.proxy.address
        def transactions():
            result, seen, cursor = [], set(), None
            for _ in range(100):
                args = {'address': address}
                if cursor:
                    args['cursor'] = cursor
                rows = self.request('transactions', **args)
                if not isinstance(rows, list):
                    raise ValueError('invalid_transactions')
                for row in rows:
                    if not isinstance(row, dict) or row.get('txid') in seen:
                        raise ValueError('duplicate_transaction')
                    seen.add(row.get('txid'))
                    result.append(row)
                if len(rows) < 25:
                    return result
                cursor = rows[-1]['txid']
            raise ValueError('history_too_large')
        first = (self.snapshot.get('transactions') or [{}])[0].get('time', int(self.clock()))
        since = dt.datetime.fromtimestamp(first - 7 * 86400, dt.timezone.utc).date().isoformat()
        today = dt.datetime.fromtimestamp(self.clock(), dt.timezone.utc).date().isoformat()
        with ThreadPoolExecutor(max_workers=5) as pool:
            futures = [pool.submit(self.request, 'address', address=address), pool.submit(transactions),
                       pool.submit(self.request, 'history'), pool.submit(self.request, 'quote'),
                       pool.submit(self.request, 'fx', **{'from': since, 'to': today})]
            summary, rows, prices, quote = [future.result() for future in futures[:4]]
            try:
                raw_fx = futures[4].result()
                rates = [{'date': r['date'], 'rate': r['rate']} for r in raw_fx
                         if r.get('base') == 'USD' and r.get('quote') == 'CNY']
                if not rates:
                    raise ValueError('missing_fx')
                rates = sorted({r['date']: r for r in rates}.values(), key=lambda r: r['date'])
                fx = {'rates': rates}
            except Exception:
                fx = self.snapshot.get('fx')
        price_rows = sorted((r for r in prices['prices'] if r['time'] >= first - 86400), key=lambda r: r['time'])
        result = normalize_onchain(summary, rows, price_rows, quote, fx,
                                   iso(int(self.clock() * 1000)), address)
        self.snapshot = result
        return result


def adapt_view(result, online, offline_error=None, ledger_error=None, now_ms=None):
    current = result['current']
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    chain_stale = bool(offline_error) or now_ms - current['onchain_as_of_ms'] > 600000
    online_stale = online.get('status') != 'connected' or now_ms - current['okx_as_of_ms'] > 90000
    coverage = result['coverage']
    points = [{'timestamp': row['timestamp'], 'btc': row['btc_total'],
               'usd': fiat_text(row['value_usd']), 'cny': fiat_text(row['value_cny'])} for row in result['history']]
    # If historical reconstruction is unavailable, a single genuine current
    # observation is useful; it must never be turned into a historical line.
    if not points:
        points = [{'timestamp': iso(current['as_of_ms']), 'btc': current['btc_total'],
                   'usd': fiat_text(current['value_usd']), 'cny': fiat_text(current['value_cny'])}]
    periods = {}
    for key, original in (('today', 'today'), ('week', '7'), ('month', '30'), ('days90', '90')):
        row = result['pnl'][original]
        periods[key] = {'btc': None, 'usd': fiat_text(row['value_usd']), 'cny': fiat_text(row['value_cny']),
                        'reason': row.get('reason') or row.get('reason_usd') or row.get('reason_cny'),
                        'start_at': iso(row['start_ms']) if row.get('start_ms') else None,
                        'end_at': iso(row['end_ms']) if row.get('end_ms') else None}
    return {'ok': True, 'updated_at': iso(current['as_of_ms']),
            'stale': chain_stale or online_stale, 'goal_btc': '1',
            'totals': {'btc': current['btc_total'], 'usd': fiat_text(current['value_usd']), 'cny': fiat_text(current['value_cny'])},
            'sources': [{'id': 'offline', 'label': '离线钱包', 'btc': current['onchain_btc'],
                         'status': 'stale' if chain_stale else 'fresh', 'updated_at': iso(current['onchain_as_of_ms'])},
                        {'id': 'okx', 'label': '欧易 BTC 净持有', 'btc': current['okx_btc'],
                         'status': 'stale' if online_stale else 'fresh', 'updated_at': iso(current['okx_as_of_ms'])}],
            'quotes': {'btc_usd': fiat_text(current.get('price_usd')), 'usd_cny': fiat_text(current.get('fx_rate'))},
            'history': points, 'pnl': periods,
            'coverage': {'complete': coverage['complete'],
                         'start_date': iso(coverage['start_ms'])[:10] if coverage.get('start_ms') else None,
                         'end_date': iso(coverage['end_ms'])[:10] if coverage.get('end_ms') else None,
                         'note': coverage.get('reason') or ledger_error or
                         '已核对欧易流水与链上确认历史；转入转出和买卖数量变动不计作价格盈亏。'}}


class CombinedWalletService:
    def __init__(self, okx_service, proxy, source=None, clock=time.time):
        self.okx, self.clock = okx_service, clock
        self.source = source or AddressSnapshots(proxy, clock)
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.thread = self.history_thread = None
        self.view = None
        self.connection = None
        self.ledger = None
        self.ledger_connection = None
        self.ledger_error = None
        self.offline_error = None
        self.last_address_refresh = 0
        self.last_ledger_attempt = 0

    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self._loop, name='btc-combined-wallet', daemon=True)
            self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(1)

    def read_public(self):
        online = self.okx.read_public()
        with self.lock:
            if (self.view is not None and online.get('connection_id') == self.connection
                    and online.get('configured') and online.get('last_success_at')):
                result = copy.deepcopy(self.view)
                for source in result['sources']:
                    limit = 90 if source['id'] == 'okx' else 600
                    old = self.clock() - dt.datetime.fromisoformat(source['updated_at']).timestamp() > limit
                    if old or source['id'] == 'okx' and online.get('status') != 'connected':
                        source['status'] = 'stale'
                result['stale'] = result['stale'] or any(s['status'] != 'fresh' for s in result['sources'])
                return result
        return {'ok': False, 'stale': True, 'updated_at': None, 'totals': {'btc': None, 'usd': None, 'cny': None},
                'sources': [], 'history': [], 'pnl': {}, 'quotes': {},
                'coverage': {'complete': False, 'note': '正在核对欧易与离线钱包余额及历史流水。'}, 'goal_btc': '1'}

    def _history_task(self, credentials, connection):
        try:
            now_ms = int(self.clock() * 1000)
            # Both sources must cover the whole displayed period. Asking for
            # [now - 90 days, now] leaves a fresh address snapshot a few
            # milliseconds older than the start required by its 90-day window.
            # Anchor the requested interval at the address snapshot instead.
            address_as_of = int(dt.datetime.fromisoformat(
                self.source.snapshot['fetchedAt'].replace('Z', '+00:00')).timestamp() * 1000)
            end_ms = min(now_ms, address_as_of)
            client = self.okx.client_factory(credentials)
            ledger = client.read_btc_history(end_ms - 90 * 86400000, end_ms)
            with self.lock:
                if connection != self.connection or self.stop_event.is_set():
                    return
                self.ledger, self.ledger_connection = ledger, connection
                self.ledger_error = None if ledger.get('complete') else ledger.get('reason', '欧易历史尚未完整核对。')
                with self.okx.vault.lock:
                    self.okx.vault._write('btc-ledger.protected.json', {'identity': connection, 'ledger': ledger})
        except Exception:
            with self.lock:
                if connection == self.connection:
                    self.ledger_error = '欧易历史流水暂未完整读取；当前余额可用，缺少记录的历史盈亏暂不估算。'

    def refresh_once(self):
        now = self.clock()
        online = self.okx.read_public()
        connection = online.get('connection_id')
        with self.lock:
            if connection != self.connection:
                self.connection, self.view = connection, None
                self.ledger = None
                self.ledger_connection = None
                self.last_ledger_attempt = 0
        if not online.get('configured') or not online.get('last_success_at'):
            return False
        day = int((now + 28800) // 86400)
        if (not self.last_address_refresh or now - self.last_address_refresh >= 300
                or int((self.last_address_refresh + 28800) // 86400) != day):
            try:
                self.source.refresh()
                self.offline_error = None
            except Exception:
                self.offline_error = '离线钱包刷新失败，保留已核验快照。'
            self.last_address_refresh = now
        if (not self.last_ledger_attempt or now - self.last_ledger_attempt >= 300
                or int((self.last_ledger_attempt + 28800) // 86400) != day) and not (self.history_thread and self.history_thread.is_alive()):
            with self.okx.lock:
                credentials = dict(self.okx.credentials)
            self.last_ledger_attempt = now
            self.history_thread = threading.Thread(target=self._history_task, args=(credentials, connection),
                                                   name='okx-btc-history', daemon=True)
            self.history_thread.start()
        incomplete = {'complete': False, 'reason': '欧易历史流水正在核对；不把当前余额回填到过去。',
                      'coverage_start_ms': int(now * 1000) - 90 * 86400000,
                      'coverage_end_ms': int(now * 1000), 'events': []}
        result = build_combined(self.source.snapshot, online, incomplete, now_ms=int(now * 1000))
        with self.lock:
            ledger = copy.deepcopy(self.ledger) if self.ledger_connection == connection else None
        if ledger and ledger.get('complete'):
            # A separate reconciled closing anchor drives historical accounting;
            # later live balance polls must not erase verified older history or
            # imply that unseen later transactions were absent.
            historical = copy.deepcopy(online)
            anchor = ledger.get('closing_balances', {})
            if anchor:
                with localcontext() as context:
                    context.prec = 256
                    holding = sum((Decimal(str(anchor[x])) for x in ('trading', 'funding')), Decimal(0))
                historical['summary']['btc_holdings_total'] = format(holding, 'f')
                historical['last_success_at'] = iso(ledger['coverage_end_ms'])
            historical_result = build_combined(self.source.snapshot, historical, ledger, now_ms=int(now * 1000))
            result.update(history=historical_result['history'], coverage=historical_result['coverage'], pnl=historical_result['pnl'])
        view = adapt_view(result, online, self.offline_error, self.ledger_error, int(now * 1000))
        with self.lock:
            if connection == self.connection:
                self.view = view
        return True

    def _loop(self):
        while not self.stop_event.is_set():
            try:
                self.refresh_once()
            except Exception:
                with self.lock:
                    if self.view:
                        self.view['stale'] = True
                    self.ledger_error = '合计快照暂时无法更新，正在自动重试。'
            self.stop_event.wait(15)
