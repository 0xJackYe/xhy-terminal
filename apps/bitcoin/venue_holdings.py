"""Exact current BTC inventory across venues, without inventing past balances.

Binance's BTC-valued wallet totals are valuations, not held BTC. Only actual
coin quantities in Spot, Funding and Earn wallets are eligible here.
"""
import copy
import datetime as dt
from decimal import Decimal, InvalidOperation, localcontext
import hashlib
import math
import re
import time


_HOLDING_WALLETS = frozenset((
    'spot', 'funding', 'earn', 'simpleearn', 'simpleearnflexible',
    'simpleearnlocked', 'flexibleearn', 'lockedearn',
))
_EXCLUDED_WALLETS = frozenset((
    'margin', 'crossmargin', 'isolatedmargin', 'futures', 'usdmfutures',
    'usdsmfutures', 'coinmfutures', 'options', 'option', 'portfoliomargin',
))
_HISTORY_NOTE = '历史曲线仅包含欧易与离线钱包；币安 BTC 从当前只读余额计入，未用当前数量回填历史。'


def _wallet_kind(name):
    if not isinstance(name, str) or not name:
        return 'unknown'
    normalized = re.sub(r'[^a-z0-9]', '', name.casefold().replace('ⓢ', 's'))
    if normalized in _HOLDING_WALLETS:
        return 'holding'
    if normalized in _EXCLUDED_WALLETS or any(part in normalized for part in ('margin', 'futures', 'options')):
        return 'excluded'
    return 'unknown'


def _number(value):
    if not isinstance(value, str) or len(value) > 512 or not re.fullmatch(r'-?\d+(?:\.\d+)?', value):
        return None
    try:
        result = Decimal(value)
        return result if result.is_finite() and len(result.as_tuple().digits) <= 220 else None
    except InvalidOperation:
        return None


def _text(value):
    if value == 0:
        return '0'
    return format(value, 'f').rstrip('0').rstrip('.') if value.as_tuple().exponent < 0 else format(value, 'f')


def _stamp(seconds):
    try:
        if isinstance(seconds, bool) or not isinstance(seconds, (float, int)) or not math.isfinite(seconds) or seconds <= 0:
            return None
        return dt.datetime.fromtimestamp(seconds, dt.timezone.utc).isoformat(timespec='milliseconds')
    except (ValueError, OverflowError, OSError):
        return None


def binance_btc_source(portfolio_service, now=None):
    """Read one account-consistent, quantity-only Binance source snapshot.

    ``context`` contains a credential identity digest and generation only. It
    lets callers reject work when an account is changed during calculation.
    Unknown or unitemized eligible wallets are unknown quantities, never zero.
    """
    source = {'id': 'binance', 'label': '币安 BTC 持有', 'btc': None,
              'status': 'unavailable', 'updated_at': None, 'context': None,
              'complete': False, 'scope': '现货、资金及理财钱包的实际 BTC；不含杠杆、合约及期权钱包。'}
    if portfolio_service is None:
        return dict(source, error='币安持仓服务尚未启动。')
    with portfolio_service.lock:
        credentials = dict(portfolio_service.credentials)
        generation = portfolio_service.generation
        data = copy.deepcopy(portfolio_service.binance_data)
        success_at = portfolio_service.binance_success_at
        error = portfolio_service.binance_error
    account = hashlib.sha256((credentials.get('api_key', '') + ':' + credentials.get('secret_key', '')).encode()).hexdigest()
    source['context'] = (account, generation)
    source['updated_at'] = _stamp(success_at)
    if not all(isinstance(credentials.get(key), str) and credentials[key] for key in ('api_key', 'secret_key')):
        return dict(source, error='币安只读账户尚未连接。')
    if not isinstance(data, dict) or not isinstance(data.get('assets'), list):
        return dict(source, error='币安持仓尚未读取成功。')
    missing = data.get('missing_wallets')
    if not isinstance(missing, list):
        return dict(source, error='币安钱包明细完整性尚未核实。')
    incomplete = any(_wallet_kind(name) != 'excluded' for name in missing)
    # A provider can flag an unrecognized incompleteness without wallet names.
    if data.get('complete') is not True and not missing:
        incomplete = True
    seen = set()
    with localcontext() as context:
        context.prec = 256
        total = Decimal(0)
        for row in data['assets']:
            if not isinstance(row, dict):
                incomplete = True
                continue
            kind = _wallet_kind(row.get('wallet'))
            if kind == 'unknown':
                incomplete = True
                continue
            if kind == 'excluded' or row.get('ccy') != 'BTC':
                continue
            wallet = row['wallet']
            amount = _number(row.get('quantity'))
            if wallet in seen or row.get('quantity_complete') is not True or amount is None or amount < 0:
                incomplete = True
                continue
            seen.add(wallet)
            total += amount
        if incomplete:
            return dict(source, error='币安存在未完整拆分币种的钱包，BTC 总持有暂不可核实。')
        source['btc'] = _text(total)
    source['complete'] = True
    observed = success_at if source['updated_at'] is not None else None
    current = (getattr(portfolio_service, 'clock', time.time)() if now is None else now)
    fresh = (isinstance(current, (int, float)) and not isinstance(current, bool)
             and math.isfinite(current) and observed is not None
             and -5 <= current - observed <= 120 and not error)
    source['status'] = 'fresh' if fresh else 'stale'
    if not fresh:
        source['error'] = '币安持仓暂未更新，保留同一账户最近一次实际余额。'
    return source


def with_binance_holdings(base_combined_view, portfolio_service, now=None):
    """Add only current BTC quantities; historical curves retain their scope."""
    result = copy.deepcopy(base_combined_view)
    if not isinstance(result, dict):
        return result
    existing = result.get('sources')
    if isinstance(existing, list) and any(isinstance(row, dict) and row.get('id') == 'binance' for row in existing):
        return result
    source = binance_btc_source(portfolio_service, now)
    result['sources'] = (existing if isinstance(existing, list) else []) + [source]
    result['holdings_venues'] = ['okx', 'binance', 'offline']
    totals = result.get('totals')
    totals = totals if isinstance(totals, dict) else {}
    base_btc, extra = _number(totals.get('btc')), _number(source['btc'])
    if base_btc is None or extra is None or base_btc < 0:
        result['totals'] = dict(totals, btc=None, usd=None, cny=None)
        result['stale'] = True
        coverage = result.setdefault('coverage', {})
        coverage.update(complete=False, note='币安或原持仓数量尚未完整核实，总持仓暂不估算。')
        return result
    quotes = result.get('quotes')
    quotes = quotes if isinstance(quotes, dict) else {}
    price, fx = _number(quotes.get('btc_usd')), _number(quotes.get('usd_cny'))
    with localcontext() as context:
        context.prec = 256
        total = base_btc + extra
        # Revalue the aggregate at one quote, instead of mixing quote times.
        usd = total * price if price is not None and price > 0 else None
        cny = usd * fx if usd is not None and fx is not None and fx > 0 else None
        result['totals'] = dict(totals, btc=_text(total), usd=_text(usd) if usd is not None else None,
                                cny=_text(cny) if cny is not None else None)
    result['stale'] = bool(result.get('stale')) or source['status'] != 'fresh'
    if extra != 0:
        coverage = result.setdefault('coverage', {})
        coverage.update(complete=False, note=_HISTORY_NOTE, history_venues=['okx', 'offline'])
        periods = result.get('pnl')
        if isinstance(periods, dict):
            result['pnl'] = {key: dict(row if isinstance(row, dict) else {}, btc=None, usd=None, cny=None,
                                      reason='币安历史余额尚未重建，不能用欧易与离线钱包的盈亏代替总持仓盈亏。')
                             for key, row in periods.items()}
    return result
