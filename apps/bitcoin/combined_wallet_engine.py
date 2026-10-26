"""Exact BTC accounting for a confirmed address and read-only OKX cash holdings.

This module performs no I/O. Historical balances require a complete, reconciled
OKX cash ledger. A current balance is never projected backwards. P&L follows the
existing wallet convention: every net BTC acquisition/disposal is removed at its
event-time valuation, leaving BTC/USD and USD/CNY mark-to-market changes only.
It is not trading P&L, cost basis, or the return of the whole exchange account.
"""
import bisect
import datetime as dt
from decimal import Decimal, InvalidOperation, localcontext
import math
import re


class AccountingError(ValueError):
    pass


def _require(condition, message):
    if not condition:
        raise AccountingError(message)


def _decimal(value, label='金额'):
    _require(isinstance(value, (str, int, float, Decimal)) and not isinstance(value, bool), label + '无效。')
    _require(len(str(value)) <= 100, label + '超出范围。')
    try:
        number = Decimal(str(value))
    except (ValueError, InvalidOperation):
        raise AccountingError(label + '无效。') from None
    _require(number.is_finite() and abs(number) <= Decimal('1e18')
             and number.as_tuple().exponent >= -32, label + '无效或超出精度范围。')
    return number


def _integer(value, label, minimum=0):
    _require(type(value) is int and minimum <= value <= 4102444800000, label + '无效。')
    return value


def _sats(value, label='链上金额'):
    _require(type(value) is int and 0 <= value <= 21000000 * 10**8, label + '必须为非负整数聪。')
    return value


def _stamp(value):
    _require(isinstance(value, str), '快照更新时间无效。')
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        _require(parsed.tzinfo is not None, '快照更新时间必须带时区。')
        milliseconds = int(parsed.timestamp() * 1000)
    except (ValueError, OverflowError):
        raise AccountingError('快照更新时间无效。') from None
    return _integer(milliseconds, '快照更新时间', 1)


def _iso(milliseconds):
    return dt.datetime.fromtimestamp(milliseconds / 1000, dt.timezone.utc).isoformat(timespec='milliseconds')


def _text(value):
    if value == 0:
        return '0'
    return format(value, 'f').rstrip('0').rstrip('.') if value.as_tuple().exponent < 0 else format(value, 'f')


def _number(value):
    if value is None:
        return None
    number = float(value)
    _require(math.isfinite(number), '估值超出范围。')
    return 0 if value == 0 else number


def _ordered_transactions(transactions):
    """Stable block dependency order, matching the existing browser core."""
    groups = {}
    for transaction in sorted(transactions, key=lambda row: (row['time'], row['height'])):
        groups.setdefault((transaction['height'], transaction['time']), []).append(transaction)
    output = []
    for rows in groups.values():
        remaining = {row['txid']: row for row in rows}
        while remaining:
            next_row = next((row for row in remaining.values()
                             if all(parent not in remaining for parent in row.get('dependencies', []))), None)
            _require(next_row is not None, '同一区块的交易依赖无效。')
            remaining.pop(next_row['txid'])
            output.append({key: value for key, value in next_row.items() if key != 'dependencies'})
    return output


def normalize_onchain(summary, raw_txs, prices, quote, fx, fetched_at, address):
    """Convert complete Esplora confirmed history to the old wallet schema.

    Pending rows are excluded. Totals, record count, addresses, transaction IDs,
    same-block dependencies and the final confirmed balance are reconciled.
    """
    _require(isinstance(raw_txs, list), '链上交易列表无效。')
    _require(isinstance(address, str) and 0 < len(address) <= 128, '链上地址无效。')
    normalized = []
    for tx in raw_txs:
        _require(isinstance(tx, dict), '链上交易格式无效。')
        if tx.get('status', {}).get('confirmed') is not True:
            continue
        _require(isinstance(tx.get('vin'), list) and isinstance(tx.get('vout'), list), '链上交易输入输出不完整。')
        received = sum(_sats(row.get('value')) for row in tx['vout'] if row.get('scriptpubkey_address') == address)
        spent = sum(_sats(row['prevout'].get('value')) for row in tx['vin']
                    if isinstance(row.get('prevout'), dict) and row['prevout'].get('scriptpubkey_address') == address)
        normalized.append({'txid': tx.get('txid'), 'time': tx['status'].get('block_time'),
                           'height': tx['status'].get('block_height'), 'received': received,
                           'spent': spent, 'delta': received - spent, 'fee': tx.get('fee'),
                           'dependencies': [row['txid'] for row in tx['vin'] if row.get('txid')]})
    # Validate IDs before using them as dependency-map keys, so duplicates cannot disappear.
    ids = [row.get('txid') for row in normalized]
    _require(all(isinstance(x, str) and re.fullmatch(r'[a-fA-F0-9]{64}', x) for x in ids), '链上交易编号无效。')
    _require(len(set(ids)) == len(ids), '链上历史包含重复记录。')
    result = {'version': 1, 'address': address, 'fetchedAt': fetched_at, 'summary': summary,
              'transactions': _ordered_transactions(normalized), 'pending': [],
              'prices': prices, 'quote': quote, 'fx': fx}
    _onchain(result)
    return result


def _onchain(snapshot):
    _require(isinstance(snapshot, dict) and snapshot.get('version') == 1, '链上快照版本无效。')
    address = snapshot.get('address')
    _require(isinstance(address, str) and address, '链上地址缺失。')
    as_of = _stamp(snapshot.get('fetchedAt'))
    summary = snapshot.get('summary')
    _require(isinstance(summary, dict) and summary.get('address') == address, '链上地址与汇总不一致。')
    stats = summary.get('chain_stats')
    _require(isinstance(stats, dict), '链上汇总缺失。')
    count = _sats(stats.get('tx_count'), '已确认交易数量')
    funded = _sats(stats.get('funded_txo_sum'), '累计转入')
    spent = _sats(stats.get('spent_txo_sum'), '累计转出')
    rows = snapshot.get('transactions')
    _require(isinstance(rows, list) and len(rows) == count, '已确认交易数量与链上汇总不一致。')
    ids, events = set(), []
    for row in rows:
        _require(isinstance(row, dict), '链上交易格式无效。')
        txid = row.get('txid')
        _require(isinstance(txid, str) and re.fullmatch(r'[a-fA-F0-9]{64}', txid) and txid not in ids,
                 '链上交易编号无效或重复。')
        ids.add(txid)
        at = _integer(row.get('time'), '确认时间', 1) * 1000
        _require(at <= as_of and row.get('status', {}).get('confirmed') is not False, '已确认交易时间不属于本快照。')
        _integer(row.get('height'), '区块高度')
        received, used = _sats(row.get('received')), _sats(row.get('spent'))
        _require(received > 0 or used > 0, '链上历史包含其他地址的交易。')
        _require(type(row.get('delta')) is int and row['delta'] == received - used, '链上交易净变动不一致。')
        _sats(row.get('fee'), '链上手续费')
        events.append({'id': txid, 'at_ms': at, 'delta': Decimal(row['delta']) / 10**8,
                       'kind': 'onchain', 'source': 'onchain'})
    _require(sum(row['received'] for row in rows) == funded and sum(row['spent'] for row in rows) == spent,
             '链上交易金额与汇总不一致，拒绝不完整历史。')
    ordered = sorted(zip(rows, events), key=lambda pair: (pair[0]['time'], pair[0]['height']))
    balance = Decimal(0)
    for _, event in ordered:
        balance += event['delta']
        _require(balance >= 0, '链上余额回放为负数，历史不完整或区块内排序错误。')
    _require(balance == Decimal(funded - spent) / 10**8, '链上余额对账失败。')
    prices = _prices(snapshot, as_of)
    rates = _rates(snapshot.get('fx'))
    return {'balance': balance, 'as_of_ms': as_of, 'events': [event for _, event in ordered],
            'prices': prices, 'rates': rates}


def _prices(snapshot, as_of):
    rows = snapshot.get('prices')
    _require(isinstance(rows, list), '历史价格缺失。')
    samples, last = {}, -1
    for row in rows:
        _require(isinstance(row, dict), '历史价格无效。')
        at = _integer(row.get('time'), '行情时间', 1) * 1000
        _require(last < at <= as_of, '历史行情必须严格递增且不晚于快照。')
        price = _decimal(row.get('USD'), '美元行情')
        _require(price > 0, '美元行情必须为正数。')
        samples[at] = price
        last = at
    quote = snapshot.get('quote')
    if quote is not None:
        _require(isinstance(quote, dict), '当前行情无效。')
        at = _integer(quote.get('time'), '当前行情时间', 1) * 1000
        price = _decimal(quote.get('USD'), '美元行情')
        _require(at <= as_of and price > 0, '当前行情晚于快照或价格无效。')
        samples[at] = price
    return sorted(samples.items())


def _rates(fx):
    if fx is None:
        return []
    _require(isinstance(fx, dict) and isinstance(fx.get('rates'), list), '汇率历史无效。')
    output, last = [], ''
    for row in fx['rates']:
        _require(isinstance(row, dict) and isinstance(row.get('date'), str), '汇率日期无效。')
        day = row['date']
        try:
            parsed = dt.date.fromisoformat(day)
        except ValueError:
            raise AccountingError('汇率日期无效。') from None
        rate = _decimal(row.get('rate'), '汇率')
        _require(parsed.isoformat() == day and day > last and rate > 0, '汇率历史必须严格按有效日期递增。')
        output.append((day, rate))
        last = day
    return output


def _lookup(samples, at_ms):
    index = bisect.bisect_right(samples, (at_ms, Decimal('Infinity'))) - 1
    return samples[index] if index >= 0 else (None, None)


def _fx_lookup(rates, at_ms):
    day = dt.datetime.fromtimestamp(at_ms / 1000, dt.timezone.utc).date().isoformat()
    # A fixing is used only from the following UTC day, as in the old wallet.
    index = bisect.bisect_left(rates, (day, Decimal('-Infinity'))) - 1
    return rates[index] if index >= 0 else (None, None)


def _valuation(balance, at_ms, chain, currency='USD'):
    if balance == 0:
        return Decimal(0)
    _, price = _lookup(chain['prices'], at_ms)
    if price is None:
        return None
    value = balance * price
    if currency == 'CNY':
        _, rate = _fx_lookup(chain['rates'], at_ms)
        if rate is None:
            return None
        value *= rate
    return value


def _ledger_rows(ledger, okx_as_of):
    _require(isinstance(ledger, dict), '欧易历史账本缺失。')
    start = _integer(ledger.get('coverage_start_ms'), '账本起始时间', 1)
    end = _integer(ledger.get('coverage_end_ms'), '账本结束时间', 1)
    _require(start <= end, '欧易历史覆盖时间无效。')
    rows = ledger.get('events')
    _require(isinstance(rows, list) and len(rows) <= 200000, '欧易历史事件列表无效。')
    seen, events = set(), []
    for row in rows:
        _require(isinstance(row, dict), '欧易历史事件无效。')
        account, event_id = row.get('account'), row.get('id')
        _require(account in ('trading', 'funding') and isinstance(event_id, str) and 0 < len(event_id) <= 256,
                 '欧易历史事件编号或账户无效。')
        key = (account, event_id)
        _require(key not in seen, '欧易历史包含重复账单。')
        seen.add(key)
        at = _integer(row.get('at_ms'), '账单时间', 1)
        _require(start <= at <= end, '欧易账单不在已验证覆盖范围内。')
        delta = _decimal(row.get('delta_btc'), '欧易 BTC 变动')
        kind = row.get('kind', 'unknown')
        _require(isinstance(kind, str) and len(kind) <= 80, '欧易账单类型无效。')
        transfer = row.get('transfer_id')
        _require(transfer is None or isinstance(transfer, str) and 0 < len(transfer) <= 256, '内部划转编号无效。')
        events.append({'id': event_id, 'account': account, 'at_ms': at, 'delta': delta,
                       'source': 'okx', 'kind': kind, 'transfer_id': transfer})
    # A true shared transfer identity is needed; matching amounts is insufficient.
    groups = {}
    for event in events:
        if event['kind'] == 'internal_transfer' and event['transfer_id']:
            groups.setdefault(event['transfer_id'], []).append(event)
    paired, consumed = [], set()
    for transfer, legs in groups.items():
        if (len(legs) == 2 and {row['account'] for row in legs} == {'trading', 'funding'}
                and sum((row['delta'] for row in legs), Decimal(0)) == 0):
            # Owner inventory remains constant while an identified internal transfer settles.
            paired.append({'id': 'transfer:' + transfer, 'account': 'combined',
                           'at_ms': min(row['at_ms'] for row in legs), 'delta': Decimal(0),
                           'source': 'okx', 'kind': 'verified_internal_transfer'})
            consumed.update((row['account'], row['id']) for row in legs)
    effective = [row for row in events if (row['account'], row['id']) not in consumed] + paired
    effective.sort(key=lambda row: (row['at_ms'], row['id']))
    complete = ledger.get('complete') is True and end >= okx_as_of
    reason = '' if complete else str(ledger.get('reason') or '欧易 BTC 流水尚未完整覆盖账户快照。')[:300]
    return start, end, effective, complete, reason


def _milestones(total):
    stages = [Decimal('.1'), Decimal('.25'), Decimal('.5'), Decimal(1)]
    next_stage = next((stage for stage in stages if stage > total), None)
    return {'target_btc': '1', 'held_btc': _text(total), 'remaining_btc': _text(max(Decimal(0), 1 - total)),
            'progress_pct': _number(min(Decimal(100), max(Decimal(0), total * 100))),
            'stages': [{'btc': _text(stage), 'state': 'achieved' if total >= stage else
                       'next' if stage == next_stage else 'upcoming'} for stage in stages],
            'next_btc': _text(next_stage) if next_stage is not None else None,
            'next_remaining_btc': _text(next_stage - total) if next_stage is not None else '0'}


def _empty_profit(start, end, reason):
    return {'value_usd': None, 'value_cny': None, 'opening_usd': None, 'closing_usd': None,
            'flows_usd': None, 'opening_cny': None, 'closing_cny': None, 'flows_cny': None,
            'start_ms': start, 'end_ms': end, 'reason': reason, 'reason_usd': reason, 'reason_cny': reason}


def _calculate(onchain, okx, ledger, now_ms):
    chain = _onchain(onchain)
    _require(isinstance(okx, dict) and okx.get('configured') is True and isinstance(okx.get('summary'), dict),
             '欧易账户尚未读取成功。')
    # BTC equity includes derivatives P&L; only cash less explicit BTC liabilities is inventory.
    okx_balance = _decimal(okx['summary'].get('btc_holdings_total'), '欧易 BTC 现货净持有量')
    okx_as_of = _stamp(okx.get('last_success_at'))
    as_of = max(chain['as_of_ms'], okx_as_of)
    end = min(chain['as_of_ms'], okx_as_of)
    current_total = chain['balance'] + okx_balance
    price_time, price = _lookup(chain['prices'], as_of)
    fx_date, rate = _fx_lookup(chain['rates'], as_of)
    stale = bool(okx.get('error')) or okx.get('status') in ('stale', 'error', 'offline', 'partial')
    stale = stale or now_ms - okx_as_of > 90000 or now_ms - chain['as_of_ms'] > 90000
    current = {'btc_total': _text(current_total), 'onchain_btc': _text(chain['balance']),
               'okx_btc': _text(okx_balance), 'value_usd': _number(_valuation(current_total, as_of, chain)),
               'value_cny': _number(_valuation(current_total, as_of, chain, 'CNY')),
               'price_usd': _number(price), 'price_at_ms': price_time, 'fx_rate': _number(rate), 'fx_date': fx_date,
               'as_of_ms': as_of, 'onchain_as_of_ms': chain['as_of_ms'], 'okx_as_of_ms': okx_as_of,
               'skew_ms': abs(chain['as_of_ms'] - okx_as_of), 'stale': stale,
               'status': 'stale' if stale else 'connected'}
    start, ledger_end, exchange_events, complete, reason = _ledger_rows(ledger, okx_as_of)
    if start > end:
        complete, reason = False, '两个账户没有共同的已验证历史时间范围。'
    source_events = chain['events'] + exchange_events
    source_events.sort(key=lambda row: (row['at_ms'], 0 if row['source'] == 'onchain' else 1))
    # Anchor at the actual exchange snapshot, not at a guessed first observation.
    def balances(at, before=False):
        chain_value = sum((row['delta'] for row in chain['events']
                           if row['at_ms'] < at or not before and row['at_ms'] == at), Decimal(0))
        exchange_value = okx_balance - sum((row['delta'] for row in exchange_events
                                           if row['at_ms'] <= okx_as_of and
                                           (row['at_ms'] >= at if before else row['at_ms'] > at)), Decimal(0))
        return chain_value, exchange_value

    history, all_times = [], []
    if complete:
        all_times = sorted({start, end} | {at for at, _ in chain['prices'] if start <= at <= end}
                           | {row['at_ms'] for row in source_events if start <= row['at_ms'] <= end})
        # History is a chart projection; calculation below always uses every event.
        display_times = all_times if len(all_times) <= 5000 else [all_times[round(i * (len(all_times) - 1) / 4999)] for i in range(5000)]
        for at in display_times:
            chain_value, exchange_value = balances(at)
            total = chain_value + exchange_value
            at_price, sample = _lookup(chain['prices'], at)
            history.append({'at_ms': at, 'timestamp': _iso(at), 'btc_total': _text(total),
                            'onchain_btc': _text(chain_value), 'okx_btc': _text(exchange_value),
                            'value_usd': _number(_valuation(total, at, chain)),
                            'value_cny': _number(_valuation(total, at, chain, 'CNY')),
                            'price_usd': _number(sample), 'price_at_ms': at_price, 'kind': 'verified_ledger'})
    pnl = {}
    for period in ('today', '7', '30', '90'):
        period_start = ((now_ms + 28800000) // 86400000 * 86400000 - 28800000
                        if period == 'today' else end - int(period) * 86400000)
        unavailable = reason if not complete else '历史不足，尚未覆盖完整周期。' if period_start < start else ''
        if end < period_start:
            unavailable = '快照不属于今天，刷新后计算。' if period == 'today' else '历史快照早于周期起点。'
        rows = [row for row in source_events if period_start <= row['at_ms'] <= end]
        internal = [row for row in rows if row['kind'] == 'internal_transfer']
        # Reconciled account ledgers establish the aggregate transfer amount
        # without guessing which bill IDs belong together. A closed period
        # with zero net internal BTC flow must not acquire artificial P&L from
        # the two account legs having slightly different valuation timestamps.
        if not unavailable and internal and (
                {row['account'] for row in internal} != {'trading', 'funding'} or
                sum((row['delta'] for row in internal), Decimal(0)) != 0):
            unavailable = '周期边界存在未结清内部划转，暂不计算该周期盈亏。'
        result = _empty_profit(period_start, end, unavailable)
        if not unavailable:
            opening = sum(balances(period_start, before=True))
            closing = sum(balances(end))
            for currency in ('USD', 'CNY'):
                key = currency.lower()
                opening_value = _valuation(opening, period_start, chain, currency)
                closing_value = _valuation(closing, end, chain, currency)
                flow_values = [_valuation(row['delta'], row['at_ms'], chain, currency)
                               for row in rows if row['kind'] != 'internal_transfer']
                error = '缺少期初行情或汇率。' if opening_value is None else '缺少期末行情或汇率。' if closing_value is None else ''
                if not error and any(value is None for value in flow_values):
                    error = '缺少 BTC 变动时的行情或汇率。'
                if period == 'today':
                    closing_price_at, _ = _lookup(chain['prices'], end)
                    if closing_price_at is None or closing_price_at < period_start:
                        error = '缺少今日行情。'
                flow_value = None if any(value is None for value in flow_values) else sum(flow_values, Decimal(0))
                result['opening_' + key] = _number(opening_value)
                result['closing_' + key] = _number(closing_value)
                result['flows_' + key] = _number(flow_value)
                result['value_' + key] = None if error else _number(closing_value - opening_value - flow_value)
                result['reason_' + key] = error
            result['reason'] = result['reason_usd']
        pnl[period] = result
    return {'version': 1, 'basis': 'BTC现货净持有量；剔除全部BTC净变动后的价格变动盈亏',
            'current': current, 'milestones': _milestones(current_total), 'history': history,
            'coverage': {'complete': complete, 'start_ms': start if complete else None,
                         'end_ms': end if complete else None, 'reason': reason,
                         'ledger_end_ms': ledger_end, 'point_count': len(all_times),
                         'internal_transfer_timing_uncertain': any(row['kind'] == 'internal_transfer' for row in source_events)},
            'pnl': pnl}


def build_combined(onchain, okx, ledger, now_ms=None):
    """Build a JSON-safe combined view, without network access or mutable state."""
    if now_ms is None:
        now_ms = int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)
    _integer(now_ms, '当前时间', 1)
    # The high precision preserves BTC quantities beyond on-chain satoshis.
    with localcontext() as context:
        context.prec = 100
        return _calculate(onchain, okx, ledger, now_ms)
