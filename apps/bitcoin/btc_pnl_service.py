"""Read-only long-term BTC unrealized return and average acquisition cost.

Trades come from the account-bound, reconciled cost ledger. Public OKX minute
closes convert non-USDT cash legs at their historical times. The user's explicit
small-inflow policy is account-bound and encrypted. Non-trading BTC changes are
an end-of-period quantity adjustment, not fictional spot purchases. This is a
management estimate, not tax accounting or a full derivatives return report.
"""
import copy
import datetime as dt
from decimal import Decimal, localcontext
import json
import re
import threading
import time
import urllib.parse
import urllib.request

from btc_cost_tracker import number, text, iso
from okx_account_reader import _verified_opener
from okx_wallet_service import DIRECTORY, OKXVault, identity

ZERO = Decimal(0)
INTERVAL = 20
MINUTE = 60000
MESSAGES = {
    'needs_history': '等待已核验的完整买卖账本。',
    'needs_policy': '此账户尚未完成持仓成本口径核对。',
    'holdings_unavailable': '合计持仓尚未完整读取。',
    'history_invalid': '买卖记录未通过成本核算校验。',
    'historical_rate_missing': '跨币种成交的历史汇率暂不可用，保留上次结果。',
    'market_unavailable': '实时 BTC/USDT 行情暂不可用，保留上次结果。',
    'refresh_failed': '持仓成本与浮盈暂未更新，正在自动重试。',
}


class PnLError(ValueError):
    pass


def compute_position(records, holdings_btc, price_usdt, rates):
    """Exact Decimal book; rate lookup is keyed by (currency, UTC minute)."""
    with localcontext() as context:
        context.prec = 96
        inventory = cost = bought = ZERO
        buys = sells = 0
        seen = set()
        first = last = None
        first_buy = last_buy = None
        first_price = last_price = None
        if not isinstance(records, list) or not records:
            raise PnLError('needs_history')
        # bill IDs break same-millisecond ties, preserving the original ledger.
        for row in sorted(records, key=lambda r: (r['at_ms'], int(r['bill_id']))):
            if row.get('id') in seen or row.get('side') not in ('buy', 'sell'):
                raise PnLError('history_invalid')
            seen.add(row.get('id'))
            at = row['at_ms']
            if isinstance(at, bool) or not isinstance(at, int):
                raise PnLError('history_invalid')
            first = at if first is None else min(first, at)
            last = at if last is None else max(last, at)
            quantity = number(row['btc_net'])
            if row['side'] == 'buy':
                ccy = row['quote_ccy']
                rate = Decimal(1) if ccy == 'USDT' else rates.get((ccy, at // MINUTE * MINUTE))
                if rate is None or number(rate) <= 0:
                    raise PnLError('historical_rate_missing')
                cash = number(row['quote_amount']) * number(rate)
                if cash < 0:
                    raise PnLError('history_invalid')
                if quantity <= 0:
                    raise PnLError('history_invalid')
                inventory += quantity
                cost += cash
                bought += quantity
                buys += 1
                if first_buy is None:
                    first_buy, first_price = at, cash / quantity
                last_buy, last_price = at, cash / quantity
            else:
                sold = -quantity
                if sold <= 0 or sold > inventory:
                    raise PnLError('history_invalid')
                removed_cost = cost if sold == inventory else cost * sold / inventory
                cost -= removed_cost
                inventory -= sold
                sells += 1
        holdings, price = number(holdings_btc), number(price_usdt)
        if holdings < 0 or price <= 0:
            raise PnLError('holdings_unavailable')
        market = holdings * price
        unrealized = market - cost
        metrics = {
            'unrealized_net': unrealized,
            'unrealized_return_pct': unrealized / cost * 100 if cost else None,
            'remaining_cost': cost, 'average_cost': cost / holdings if holdings else None,
            'spot_average_cost': cost / inventory if inventory else None,
            'holdings_btc': holdings, 'spot_inventory_btc': inventory,
            'known_net_bought_btc': inventory, 'bought_net_btc': bought,
            'nonspot_btc_adjustment': holdings - inventory,
            'market_value': market, 'price_usdt': price,
            'first_net_buy_price': first_price, 'last_net_buy_price': last_price,
        }
        return {'metrics': {k: text(v) if v is not None else None for k, v in metrics.items()},
                'trade_count': len(records), 'buy_count': buys, 'sell_count': sells,
                'first_trade_at': iso(first), 'last_trade_at': iso(last),
                'first_buy_at': iso(first_buy) if first_buy is not None else None,
                'last_buy_at': iso(last_buy) if last_buy is not None else None}


class PublicPnLMarket:
    """No credentials, no redirects, fixed public ticker/candle routes only."""
    def __init__(self, vault=None, opener=None, clock=time.time):
        self.vault = vault or OKXVault(DIRECTORY.parent / 'btc-pnl')
        self.opener = opener or _verified_opener()
        self.clock = clock
        self.offset, self.synced_at = 0.0, None
        self.balances = {}
        self.cache = self.vault._read('public-rates.protected.json', {})
        if not isinstance(self.cache, dict):
            self.cache = {}

    def _get(self, route, params):
        if route not in ('ticker', 'history-candles', 'time'):
            raise PnLError('market_unavailable')
        if route == 'time' and params:
            raise PnLError('market_unavailable')
        path = '/api/v5/public/time' if route == 'time' else '/api/v5/market/' + route
        url = 'https://www.okx.com' + path + ('?' + urllib.parse.urlencode(params) if params else '')
        req = urllib.request.Request(url, headers={'Accept': 'application/json',
            'User-Agent': 'BitcoinDashboardPnLReadOnly/1.0'}, method='GET')
        try:
            with self.opener.open(req, timeout=8) as response:
                if response.geturl() != url or response.getcode() != 200:
                    raise ValueError()
                raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError()
            data = json.loads(raw.decode('utf-8'))
            if data.get('code') != '0' or not isinstance(data.get('data'), list):
                raise ValueError()
            return data['data']
        except Exception:
            raise PnLError('historical_rate_missing' if route == 'history-candles' else 'market_unavailable') from None

    def historical_rate(self, currency, minute):
        if currency not in ('ETH', 'USDC') or isinstance(minute, bool) or not isinstance(minute, int) or minute % MINUTE:
            raise PnLError('historical_rate_missing')
        key = currency + ':' + str(minute)
        saved = self.cache.get(key)
        if isinstance(saved, dict):
            try:
                if (saved.get('currency') == currency and saved.get('minute_ms') == minute
                        and number(saved['close']) > 0 and saved.get('source') == 'OKX/1m-close'):
                    return number(saved['close']), copy.deepcopy(saved)
            except Exception:
                pass
        rows = self._get('history-candles', {'instId': currency + '-USDT', 'bar': '1m',
            'after': str(minute + MINUTE), 'before': str(minute - 1), 'limit': '3'})
        matches = [r for r in rows if isinstance(r, list) and len(r) >= 9 and r[0] == str(minute) and r[8] == '1']
        if len(matches) != 1:
            raise PnLError('historical_rate_missing')
        row = matches[0]
        close, high, low = number(row[4]), number(row[2]), number(row[3])
        if not ZERO < low <= close <= high:
            raise PnLError('historical_rate_missing')
        saved = {'currency': currency, 'minute_ms': minute, 'close': text(close),
                 'low': text(low), 'high': text(high), 'source': 'OKX/1m-close'}
        self.cache[key] = saved
        with self.vault.lock:
            self.vault._write('public-rates.protected.json', self.cache)
        return close, copy.deepcopy(saved)

    def quote(self):
        if self.synced_at is None or self.clock() - self.synced_at > 300:
            start = self.clock()
            rows = self._get('time', {})
            if len(rows) != 1:
                raise PnLError('market_unavailable')
            self.offset = int(rows[0]['ts']) / 1000 - (start + self.clock()) / 2
            self.synced_at = self.clock()
        rows = self._get('ticker', {'instId': 'BTC-USDT'})
        if len(rows) != 1 or rows[0].get('instId') != 'BTC-USDT':
            raise PnLError('market_unavailable')
        price, at = number(rows[0]['last']), int(rows[0]['ts'])
        if price <= 0 or not -5000 <= int((self.clock() + self.offset) * 1000) - at <= 90000:
            raise PnLError('market_unavailable')
        return text(price), iso(at)

    def confirmed_balance(self, address):
        """Independent confirmed chain quantity when the primary relay is down."""
        if not isinstance(address, str) or not re.fullmatch(r'(?:bc1[a-z0-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})', address):
            raise PnLError('holdings_unavailable')
        cached = self.balances.get(address)
        if cached and self.clock() - cached['observed_ms'] / 1000 < 120:
            return copy.deepcopy(cached)
        url = 'https://blockstream.info/api/address/' + address
        request = urllib.request.Request(url, headers={'Accept': 'application/json',
            'User-Agent': 'BitcoinDashboardPnLReadOnly/1.0'}, method='GET')
        try:
            with self.opener.open(request, timeout=8) as response:
                if response.geturl() != url or response.getcode() != 200:
                    raise ValueError()
                raw = response.read(65537)
            if len(raw) > 65536:
                raise ValueError()
            data = json.loads(raw.decode('utf-8'))
            if data.get('address') != address:
                raise ValueError()
            stats = data['chain_stats']
            funded, spent = stats['funded_txo_sum'], stats['spent_txo_sum']
            if any(isinstance(x,bool) or not isinstance(x,int) or not 0 <= x <= 21000000 * 10**8 for x in (funded,spent)) or spent > funded:
                raise ValueError()
            result = {'btc': text(Decimal(funded - spent) / 10**8),
                      'observed_ms': int(self.clock() * 1000), 'provider': 'Blockstream/confirmed'}
            self.balances[address] = result
            return copy.deepcopy(result)
        except Exception:
            raise PnLError('holdings_unavailable') from None


class BTCPnLService:
    def __init__(self, cost_service, combined_service, vault=None, market=None, clock=time.time):
        self.cost, self.combined, self.okx = cost_service, combined_service, cost_service.okx
        self.vault = vault or OKXVault(DIRECTORY.parent / 'btc-pnl')
        self.market = market or PublicPnLMarket(self.vault, clock=clock)
        self.clock = clock
        self.lock = threading.RLock()
        self.refresh_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread, self.view, self.connection = None, None, None
        self.error = None

    def _account(self):
        # Match the tracker's okx -> tracker lock order on account changes.
        with self.okx.lock:
            return identity(dict(self.okx.credentials))

    def _select(self, account):
        with self.lock:
            if self.connection != account:
                self.connection, self.view, self.error = account, None, None

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._loop, name='btc-lifetime-pnl-readonly', daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(1)

    def _loop(self):
        while not self.stop_event.is_set():
            self.refresh_once()
            self.stop_event.wait(INTERVAL)

    def refresh_once(self):
        if not self.refresh_lock.acquire(blocking=False):
            return False
        account = self._account()
        self._select(account)
        try:
            policy = self.vault._read('policy-' + account + '.protected.json', {})
            if policy.get('identity') != account or policy.get('small_inflows_no_added_cost') is not True:
                raise PnLError('needs_policy')
            snapshot = self.cost.accounting_snapshot()
            ledger = snapshot.get('ledger')
            if (snapshot.get('connection_id') != account[:24] or not ledger or not ledger.get('complete')
                    or snapshot.get('coverage_complete') is not True):
                raise PnLError('needs_history')
            # Read holdings under the same active credential context. No network
            # calls are made while this lock is held.
            with self.okx.lock:
                if self._account() != account:
                    return False
                holdings = self.combined.read_public() if self.combined else {}
            if not holdings.get('ok') or holdings.get('totals', {}).get('btc') is None:
                raise PnLError('holdings_unavailable')
            holding_btc = holdings['totals']['btc']
            holding_at = holdings.get('updated_at')
            holding_stale = holdings.get('stale') is True
            balance_sources = copy.deepcopy(holdings.get('sources', []))
            source_map = {r['id']: r for r in balance_sources}
            if set(source_map) == {'okx', 'offline'}:
                if source_map['offline'].get('status') != 'fresh' and policy.get('wallet_address'):
                    chain = self.market.confirmed_balance(policy['wallet_address'])
                    source_map['offline'].update(btc=chain['btc'], status='fresh',
                        updated_at=iso(chain['observed_ms']), provider=chain['provider'])
                # P&L uses OKX USDT prices, so historical chart/FX availability
                # must not unnecessarily invalidate independently fresh balances.
                holding_stale = any(r.get('status') != 'fresh' for r in source_map.values())
                with localcontext() as context:
                    context.prec = 96
                    holding_btc = text(sum((number(r['btc']) for r in source_map.values()), ZERO))
                holding_at = min((r['updated_at'] for r in source_map.values()),
                    key=lambda value:dt.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp())
            rates, evidence = {}, []
            for ccy, minute in sorted({(r['quote_ccy'], r['at_ms'] // MINUTE * MINUTE)
                                      for r in ledger['records'] if r['side'] == 'buy' and r['quote_ccy'] != 'USDT'}):
                rates[(ccy, minute)], source = self.market.historical_rate(ccy, minute)
                evidence.append(source)
            price, quote_at = self.market.quote()
            result = compute_position(ledger['records'], holding_btc, price, rates)
            now_ms = int(self.clock() * 1000)
            outdated = (snapshot.get('status') != 'fresh' or holding_stale
                        or now_ms - ledger['as_of_ms'] > 90000)
            delta = number(result['metrics']['nonspot_btc_adjustment']) - number(policy['verified_nonspot_adjustment_btc'])
            reconciliation = {'verified_at': policy['verified_at'],
                              'verified_adjustment_btc': policy['verified_nonspot_adjustment_btc'],
                              'change_since_verification_btc': text(delta),
                              'matched': abs(delta) < Decimal('0.00000001')}
            # New non-trade quantity changes or temporarily unsynchronized DCA
            # snapshots must not silently become verified lifetime returns.
            outdated = outdated or not reconciliation['matched']
            result.update(status='stale' if outdated else 'fresh', estimated=True, currency='USDT',
                focus='long_term_unrealized',
                method='moving_weighted_average', as_of=iso(now_ms), ledger_as_of=iso(ledger['as_of_ms']),
                holdings_as_of=holding_at, balance_sources=balance_sources, quote_at=quote_at,
                coverage_start=iso(ledger['coverage_start_ms']), coverage_complete=True,
                history_status=snapshot.get('status'), connection_id=account[:24],
                refresh_interval_seconds=INTERVAL, historical_rates=evidence, reconciliation=reconciliation,
                ignored_received_btc=policy.get('received_btc', '0'),
                assumptions=[
                    '每笔定投以净到账 BTC 和含手续费的实际支出更新持仓平均买入价，后台自动刷新。',
                    '历史卖出仅按当时平均成本调整剩余数量与成本，卖出回款不计入当前浮盈。',
                    '按你的要求，两笔小额 Received 转入不追加原始成本；持仓成本与浮盈为估算。',
                    'ETH、USDC 支付按成交当分钟 OKX/USDT 收盘价折算，不将 USDC 直接视为 USDT。',
                    'Earn、历史合约净变动和提币/矿工费以实际持仓的期末数量调整体现，不重复加减。',
                    '持仓浮盈 = 当前总持仓 × BTC/USDT 现价 − 剩余持仓成本；浮盈率 = 浮盈 ÷ 剩余持仓成本。',
                    '平均买入价 = 剩余持仓成本 ÷ 实际 BTC 总持有；只计算当前长期持仓的浮盈。',
                ], error=('持仓或历史含缓存，或有新的持仓数量调整待核对。' if outdated else None))
            with self.okx.lock:
                if self._account() != account:
                    return False
                with self.lock:
                    self.view, self.error = result, None
            return True
        except Exception as exc:
            code = str(exc) if isinstance(exc, PnLError) and str(exc) in MESSAGES else 'refresh_failed'
            with self.lock:
                if self.connection == account:
                    self.error = MESSAGES[code]
            return False
        finally:
            self.refresh_lock.release()

    def read_public(self):
        with self.okx.lock:
            account = self._account()
            self._select(account)
            with self.lock:
                if not self.view:
                    return {'status': 'unavailable' if self.error else 'loading', 'estimated': True,
                            'currency': 'USDT', 'method': 'moving_weighted_average', 'metrics': {},
                            'focus': 'long_term_unrealized',
                            'connection_id': account[:24],
                            'error': self.error, 'refresh_interval_seconds': INTERVAL}
                result = copy.deepcopy(self.view)
                age = self.clock() - dt.datetime.fromisoformat(result['as_of']).timestamp()
                if self.error or age > 90:
                    result['status'] = 'stale'
                    result['error'] = self.error or '持仓浮盈快照待更新。'
                return result


def handle_btc_pnl(handler):
    url = urllib.parse.urlsplit(handler.path)
    if url.path != '/api/wallet/btc-pnl':
        return False
    if handler.command != 'GET':
        handler.json(405, {'error': '持仓浮盈接口仅支持读取。'})
    elif url.query:
        handler.json(400, {'error': '持仓浮盈接口不接受查询参数。'})
    else:
        service = getattr(handler.server, 'pnl_service', None)
        try:
            handler.json(200, service.read_public()) if service else handler.json(503, {'error': '持仓浮盈服务尚未启动。'})
        except Exception:
            handler.json(503, {'error': '持仓浮盈暂时无法读取，已保存的记录保留在本机。'})
    return True
