"""Local read-only portfolio: exact coin aggregation and a USD 5 display floor."""
import copy
import datetime as dt
from decimal import Decimal, InvalidOperation, localcontext
import hashlib
import json
import re
import threading
import time

from okx_wallet_service import OKXVault, WalletError, DIRECTORY
from binance_wallet import valid_currency


def number(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        result = Decimal(str(value))
        return result if result.is_finite() and len(str(value)) <= 512 else None
    except (ValueError, InvalidOperation):
        return None


def text(value):
    return format(value, 'f')


def usd_product(quantity, price):
    """Keep valuation exact before the USD 5 comparison, not just after it."""
    with localcontext() as context:
        context.prec = 256
        return text(quantity * price)


def display_totals(total_usd, snapshot, now):
    """Convert the exact eligible USD total using this inventory's quote.

    FX follows the existing wallet's fixing rule: a daily USD/CNY rate is
    available from the following UTC day. Unknown conversion rates stay null.
    BTC here is a portfolio value equivalent, not actual BTC inventory.
    """
    snapshot = snapshot if isinstance(snapshot, dict) else {}
    quote = snapshot.get('quote') or {}
    price = number(quote.get('USD')) if isinstance(quote, dict) else None
    if price is not None and price <= 0:
        price = None
    today = dt.datetime.fromtimestamp(now, dt.timezone.utc).date().isoformat()
    fx = snapshot.get('fx') or {}
    rates = fx.get('rates') if isinstance(fx, dict) else None
    candidates = []
    for row in rates if isinstance(rates, list) else []:
        if not isinstance(row, dict) or not isinstance(row.get('date'), str):
            continue
        try:
            day = dt.date.fromisoformat(row['date']).isoformat()
        except ValueError:
            continue
        rate = number(row.get('rate'))
        if day == row['date'] and day < today and rate is not None and rate > 0:
            candidates.append((day, rate))
    fx_date, rate = max(candidates, default=(None, None))
    usd = number(total_usd)
    with localcontext() as context:
        context.prec = 256
        return {'total_cny': text(usd * rate) if usd is not None and rate is not None else None,
                'total_btc': text(usd / price) if usd is not None and price is not None else None,
                'conversion_quotes': {'btc_usd': text(price) if price is not None else None,
                                      'usd_cny': text(rate) if rate is not None else None,
                                      'fx_date': fx_date}}


def synchronized_okx_assets(assets, online, price):
    """Use the wallet monitor's cash-net BTC snapshot for every BTC display.

    Other coins retain the separately valued inventory. A present but invalid
    summary is unknown; it must never silently reuse an older BTC inventory.
    The absent-summary path is retained for legacy providers only.
    """
    has_summary = 'summary' in online
    summary = online.get('summary')
    public_btc = number(summary.get('btc_holdings_total')) if isinstance(summary, dict) else None
    invalid_btc = has_summary and public_btc is None
    output, btc_seen = [], False
    for row in assets:
        item = dict(row, location='okx')
        if item['ccy'] == 'BTC':
            if has_summary:
                if btc_seen:
                    continue
                btc_seen = True
                item['quantity'] = text(public_btc) if public_btc is not None else None
                item['usd_value'] = usd_product(public_btc, price) if public_btc is not None and price is not None else None
            elif price is not None and number(item.get('quantity')) is not None:
                item['usd_value'] = usd_product(number(item['quantity']), price)
        output.append(item)
    if has_summary and not btc_seen and public_btc != 0:
        output.append({'ccy': 'BTC', 'quantity': text(public_btc) if public_btc is not None else None,
                       'usd_value': usd_product(public_btc, price) if public_btc is not None and price is not None else None,
                       'location': 'okx'})
    metadata = {'btc_basis': 'wallet_summary_cash_net' if has_summary else 'legacy_valued_assets',
                'btc_snapshot_at': online.get('last_success_at') if has_summary else None,
                'btc_quantity': text(public_btc) if public_btc is not None else None}
    return output, metadata, invalid_btc


class BinanceVault(OKXVault):
    def __init__(self, **kwargs):
        super().__init__(DIRECTORY.parent / 'binance-wallet', **kwargs)

    def read(self):
        with self.lock:
            value = self._read('credentials.protected.json', {})
            if not isinstance(value, dict) or set(value) - {'api_key', 'secret_key'}:
                return {}
            if any(not isinstance(v, str) or not re.fullmatch('[A-Za-z0-9]{64}', v) for v in value.values()):
                return {}
            return value

    def save(self, credentials):
        if (not isinstance(credentials, dict) or set(credentials) != {'api_key', 'secret_key'}
                or any(not isinstance(v, str) or not re.fullmatch('[A-Za-z0-9]{64}', v) for v in credentials.values())):
            raise WalletError('credentials_invalid', '请在本机填写配套的币安 API Key 和 Secret Key。')
        with self.lock:
            self._write('credentials.protected.json', credentials)


def aggregate_assets(rows, sources, now_ms):
    """Filter at the coin total, then assign eligible legs to venue slices."""
    with localcontext() as context:
        context.prec = 256
        coins, unpriced, liability, excluded_liability = {}, set(), Decimal(0), Decimal(0)
        negative_leg = False
        for row in rows:
            ccy, location = row['ccy'], row['location']
            if not valid_currency(ccy) or location not in {'offline', 'okx', 'binance'}:
                raise ValueError('invalid_asset')
            quantity, usd = number(row.get('quantity')), number(row.get('usd_value'))
            if quantity == 0 and usd in (None, Decimal(0)):
                continue
            coin = coins.setdefault(ccy, {'quantity': Decimal(0), 'quantity_complete': True, 'legs': []})
            if quantity is None:
                coin['quantity_complete'] = False
            else:
                coin['quantity'] += quantity
            if usd is None:
                unpriced.add(ccy)
            else:
                coin['legs'].append((location, usd))
        selected, excluded = [], Decimal(0)
        locations = {'offline': Decimal(0), 'okx': Decimal(0), 'binance': Decimal(0)}
        for ccy, coin in sorted(coins.items()):
            if ccy in unpriced:
                continue
            value = sum((amount for _, amount in coin['legs']), Decimal(0))
            if value < 0:
                if -value < 5:
                    excluded_liability += -value
                else:
                    liability += -value
                continue
            if value < 5:
                excluded += value
                continue
            selected.append({'ccy': ccy, 'quantity': text(coin['quantity']) if coin['quantity_complete'] else None,
                             'usd_value': text(value)})
            for location, amount in coin['legs']:
                locations[location] += amount
                if amount < 0:
                    negative_leg = True
                    liability += -amount
        selected.sort(key=lambda row: (-Decimal(row['usd_value']), row['ccy']))
        total = sum((Decimal(row['usd_value']) for row in selected), Decimal(0))
        for row in selected:
            row['percentage'] = float(Decimal(row['usd_value']) / total * 100) if total else 0
        location_rows = [{'id': key, 'label': {'offline': '离线钱包', 'okx': '欧易', 'binance': '币安'}[key],
                          'usd_value': text(amount), 'percentage': float(amount / total * 100) if total else 0}
                         for key, amount in locations.items() if amount > 0]
        if negative_leg:
            # A negative slice is mathematically invalid; do not silently drop
            # debt and display venue percentages greater than 100%.
            location_rows = []
        complete = all(source['status'] == 'connected' for source in sources) and not unpriced and liability == 0
        return {'updated_at': dt.datetime.fromtimestamp(now_ms / 1000, dt.timezone.utc).isoformat(timespec='seconds'),
                'complete': complete, 'stale': any(s['status'] in ('error', 'stale') for s in sources),
                'total_usd': text(total), 'excluded_usd': text(excluded), 'threshold_usd': '5',
                'assets': selected, 'locations': location_rows, 'sources': sources,
                'unpriced_currencies': sorted(unpriced), 'liabilities_usd': text(liability),
                'excluded_liabilities_usd': text(excluded_liability),
                'location_allocation_complete': not negative_leg,
                'scope_note': '欧易统计交易与资金账户；币安统计接口返回的钱包。不含欧易赚币、子账户及衍生品浮盈。'}


class CryptoPortfolioService:
    def __init__(self, okx_service, combined_service, vault=None, binance_factory=None, clock=time.time):
        self.okx, self.combined, self.clock = okx_service, combined_service, clock
        self.vault = vault or BinanceVault()
        if binance_factory is None:
            from binance_wallet import BinanceWalletClient
            binance_factory = BinanceWalletClient
        self.binance_factory = binance_factory
        self.credentials = self.vault.read()
        self.lock = threading.RLock()
        self.wake, self.stop_event = threading.Event(), threading.Event()
        self.thread = None
        self.generation = 0
        self.view = None
        self.binance_data = self.okx_data = None
        self.binance_error = self.okx_error = None
        self.binance_at = self.okx_at = 0
        self.okx_connection = None
        self.refreshing = False
        self.binance_success_at = self.okx_success_at = 0
        self.binance_failures = 0
        self.binance_retry_at = 0

    def binance_status(self):
        with self.lock:
            missing = [k for k in ('api_key', 'secret_key') if not self.credentials.get(k)]
            return {'configured': not missing, 'pending_credentials': bool(self.credentials) and bool(missing),
                    'missing_fields': missing, 'error_code': self.binance_error,
                    'retry_in_seconds': max(0, int(self.binance_retry_at - self.clock())),
                    'last_success_at': dt.datetime.fromtimestamp(self.binance_success_at, dt.timezone.utc).isoformat() if self.binance_success_at else None,
                    'status': 'needs_credentials' if missing else 'stale' if self.binance_data and (self.binance_error or self.clock() - self.binance_success_at > 120) else
                              'connected' if self.binance_data and not self.binance_error else
                              'error' if self.binance_error else 'connecting'}

    def configure_binance(self, body):
        if not isinstance(body, dict) or set(body) - {'api_key', 'secret_key'} or not body:
            raise WalletError('credentials_invalid', '请填写配套的币安 API Key 和 Secret Key。')
        with self.lock:
            candidate = dict(self.credentials)
            candidate.update(body)
            self.vault.save(candidate)
            self.credentials = candidate
            self.generation += 1
            self.binance_data = self.view = None
            self.binance_at = 0
            self.binance_error = None
            self.binance_success_at = self.binance_retry_at = self.binance_failures = 0
        self.wake.set()
        return self.binance_status()

    def read_public(self):
        live_connection = self.okx.read_public().get('connection_id')
        with self.lock:
            value = copy.deepcopy(self.view) if self.view and live_connection == self.okx_connection else {
                'updated_at': None, 'complete': False, 'stale': True, 'total_usd': None,
                'total_cny': None, 'total_btc': None, 'conversion_quotes': {}, 'excluded_usd': '0',
                'assets': [], 'locations': [], 'sources': [], 'threshold_usd': '5'}
            value['binance'] = self.binance_status()
            if value['updated_at'] and self.clock() - dt.datetime.fromisoformat(value['updated_at']).timestamp() > 90:
                value['stale'] = True
                value['complete'] = False
            online = self.okx.read_public()
            for source in value['sources']:
                if source['id'] == 'okx' and online.get('status') in {'stale', 'error', 'connecting', 'needs_credentials'}:
                    source['status'] = 'stale' if self.okx_data else online['status']
                if source['id'] == 'binance' and self.binance_data and (self.binance_error or self.clock() - self.binance_success_at > 120):
                    source['status'] = 'stale'
                if source['status'] != 'connected':
                    value['complete'] = False
                if source['status'] in {'stale', 'error'}:
                    value['stale'] = True
            return value

    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self._loop, name='crypto-portfolio-readonly', daemon=True)
            self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.wake.set()
        if self.thread:
            self.thread.join(1)

    def refresh_once(self):
        with self.lock:
            if self.refreshing or self.stop_event.is_set():
                return False
            self.refreshing = True
        try:
            return self._refresh_once()
        finally:
            with self.lock:
                self.refreshing = False

    def _refresh_once(self):
        now = self.clock()
        online = self.okx.read_public()
        connection = online.get('connection_id')
        with self.lock:
            generation, credentials = self.generation, dict(self.credentials)
            if connection != self.okx_connection:
                self.okx_data, self.okx_at = None, 0
                self.okx_success_at, self.okx_error = 0, None
                self.okx_connection = connection
        if 'cash_valuation' in online:
            # Live wallet and pie share one account read, observation time and
            # credential generation. Never start a second private poll here.
            with self.lock:
                self.okx_data = copy.deepcopy(online.get('cash_valuation'))
                self.okx_error = online.get('error_code')
                if self.okx_data and online.get('last_success_at'):
                    self.okx_success_at = dt.datetime.fromisoformat(online['last_success_at'].replace('Z', '+00:00')).timestamp()
                    self.okx_at = self.okx_success_at
        elif online.get('configured') and (not self.okx_at or now - self.okx_at >= 60):
            try:
                with self.okx.lock:
                    client = self.okx.client_factory(dict(self.okx.credentials))
                try:
                    data = client.read_valued_assets()
                finally:
                    close = getattr(client, 'close', None)
                    if callable(close):
                        close()
                with self.lock:
                    if connection == self.okx_connection:
                        self.okx_data, self.okx_error, self.okx_at = data, None, now
                        self.okx_success_at = self.clock()
            except Exception:
                self.okx_error = 'valuation_unavailable'
                self.okx_at = now
        if set(credentials) == {'api_key', 'secret_key'} and now >= self.binance_retry_at and (not self.binance_at or now - self.binance_at >= 60):
            try:
                client = self.binance_factory(credentials['api_key'], credentials['secret_key'])
                try:
                    data = client.fetch_balances()
                finally:
                    client.close()
                with self.lock:
                    if generation == self.generation:
                        self.binance_data, self.binance_error, self.binance_at = data, None, now
                        self.binance_success_at = self.clock()
                        self.binance_failures = self.binance_retry_at = 0
            except Exception as exc:
                from binance_wallet import BinanceWalletError
                with self.lock:
                    if generation == self.generation:
                        self.binance_error = exc.code if isinstance(exc, BinanceWalletError) else 'network_error'
                        self.binance_at = now
                        self.binance_failures += 1
                        self.binance_retry_at = self.clock() + min(300, 60 * 2 ** min(self.binance_failures - 1, 3))
        latest_online = self.okx.read_public()
        if latest_online.get('connection_id') != connection:
            return False
        online = latest_online
        if 'cash_valuation' in online:
            # A slow Binance read can span a new OKX poll. Publish every OKX
            # coin from that latest single inventory, including its BTC total.
            with self.lock:
                self.okx_data = copy.deepcopy(online.get('cash_valuation'))
                self.okx_error = online.get('error_code')
                if self.okx_data and online.get('last_success_at'):
                    self.okx_success_at = dt.datetime.fromisoformat(online['last_success_at'].replace('Z', '+00:00')).timestamp()
                    self.okx_at = self.okx_success_at
        now = self.clock()
        rows, sources = [], []
        source = self.combined.source if self.combined else None
        snapshot = copy.deepcopy(source.snapshot) if source else None
        price = number(snapshot.get('quote', {}).get('USD')) if snapshot else None
        if price is not None and price <= 0:
            price = None
        if snapshot and price is not None and price > 0:
            stats = snapshot['summary']['chain_stats']
            with localcontext() as context:
                context.prec = 256
                quantity = Decimal(stats['funded_txo_sum'] - stats['spent_txo_sum']) / Decimal(100000000)
            age = now - dt.datetime.fromisoformat(snapshot['fetchedAt'].replace('Z', '+00:00')).timestamp()
            quote_stamp = snapshot.get('quote', {}).get('time')
            quote_fresh = isinstance(quote_stamp, (int, float)) and not isinstance(quote_stamp, bool) and -5 <= now - quote_stamp <= 1800
            sources.append({'id': 'offline', 'status': 'connected' if age <= 600 and quote_fresh else 'stale', 'note': '已确认链上余额；BTC 使用统一 USD 行情'})
            rows.append({'ccy': 'BTC', 'quantity': text(quantity), 'usd_value': usd_product(quantity, price), 'location': 'offline'})
        else:
            sources.append({'id': 'offline', 'status': 'error', 'note': '离线钱包或统一美元行情尚未就绪'})
        with self.lock:
            okx_data, binance_data = copy.deepcopy(self.okx_data), copy.deepcopy(self.binance_data)
        okx_rows, btc_metadata, invalid_btc = synchronized_okx_assets(
            okx_data['assets'] if okx_data else [], online, price)
        rows.extend(okx_rows)
        if okx_data:
            public_stale = online.get('status') in ('stale', 'error') or bool(online.get('error')) or now - self.okx_success_at > 120
            status = ('stale' if self.okx_error or public_stale else
                      'partial' if invalid_btc or not okx_data['complete'] else 'connected')
            sources.append(dict(btc_metadata, id='okx', status=status,
                                valuation_complete=bool(okx_data['complete']) and not invalid_btc,
                                note='BTC 与钱包主看板使用同一现货净持有快照；其他币种按交易账户和资金账户估值'))
        else:
            sources.append(dict(btc_metadata, id='okx', status='error' if online.get('configured') else 'needs_credentials',
                                note='欧易其他币种估值待更新；BTC 使用钱包主看板快照' if okx_rows else '欧易资产估值正在连接'))
        if binance_data:
            for row in binance_data['assets']:
                usd = number(row.get('usd_value'))
                if usd is None and price is not None and number(row.get('btc_value')) is not None:
                    usd = number(usd_product(number(row['btc_value']), price))
                if row['ccy'] == 'BTC' and price is not None and number(row.get('quantity')) is not None:
                    usd = number(usd_product(number(row['quantity']), price))
                rows.append(dict(row, location='binance', usd_value=text(usd) if usd is not None else None))
            sources.append({'id': 'binance', 'status': 'stale' if self.binance_error or now - self.binance_success_at > 120 else 'connected' if binance_data['complete'] else 'partial',
                            'inventory_complete': bool(binance_data['complete']),
                            'note': '接口实际返回的钱包明细；缺失明细的账户不按零计算'})
        else:
            status = self.binance_status()
            note = ('还需要填写配套的 Secret Key 才能只读查询。' if status['pending_credentials'] else
                    '尚未连接币安，请在本机填写只读 API Key 与 Secret Key。' if not status['configured'] else
                    '币安资产暂未读取成功，请检查连接状态。' if status['status'] == 'error' else
                    '币安凭据已配置，正在只读同步资产。')
            sources.append({'id': 'binance', 'status': status['status'], 'note': note})
        result = aggregate_assets(rows, sources, int(now * 1000))
        result.update(display_totals(result['total_usd'], snapshot, now))
        live_connection = self.okx.read_public().get('connection_id')
        with self.lock:
            if generation == self.generation and connection == self.okx_connection == live_connection:
                self.view = result
        return True

    def _loop(self):
        while not self.stop_event.is_set():
            self.wake.clear()
            try:
                self.refresh_once()
            except Exception:
                with self.lock:
                    if self.view:
                        self.view['stale'] = True
            self.wake.wait(15)
