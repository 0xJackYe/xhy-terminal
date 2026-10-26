// Shared by the standalone HTML and Node verification. Amounts stay in satoshis.
const SATOSHIS_PER_BTC = 100_000_000;

function coreAssert(condition, message) {
  if (!condition) throw new Error(message);
}

function isSatoshiAmount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function checkedSum(values, label) {
  let sum = 0;
  for (const value of values) {
    coreAssert(isSatoshiAmount(value), `${label}必须是非负整数聪。`);
    sum += value;
    coreAssert(Number.isSafeInteger(sum), `${label}超出可精确计算的范围。`);
  }
  return sum;
}

function orderedTransactions(transactions) {
  // Modern JS sorting is stable: preserve the dependency order within a block.
  return [...transactions].sort((a, b) => a.time - b.time || a.height - b.height);
}

/** Convert an Esplora address transaction list, excluding all unconfirmed rows. */
export function normalizeTransactions(rawEsploraTxs, address) {
  coreAssert(Array.isArray(rawEsploraTxs), '交易接口未返回有效列表。');
  coreAssert(typeof address === 'string' && address.length > 0, '缺少比特币地址。');
  const txs = rawEsploraTxs.filter(tx => tx?.status?.confirmed === true).map(tx => {
    coreAssert(typeof tx.txid === 'string' && /^[a-f0-9]{64}$/i.test(tx.txid), '交易编号格式无效。');
    coreAssert(Number.isSafeInteger(tx.status.block_time) && tx.status.block_time > 0,
      '已确认交易缺少有效的区块时间。');
    coreAssert(isSatoshiAmount(tx.status.block_height), '已确认交易缺少有效的区块高度。');
    coreAssert(Array.isArray(tx.vin) && Array.isArray(tx.vout), '交易的输入或输出数据不完整。');
    const received = checkedSum(tx.vout.filter(output => output.scriptpubkey_address === address)
      .map(output => output.value), '转入金额');
    const spent = checkedSum(tx.vin.filter(input => input.prevout?.scriptpubkey_address === address)
      .map(input => input.prevout.value), '支出金额');
    coreAssert(received > 0 || spent > 0, '交易列表包含与此地址无关的记录。');
    coreAssert(isSatoshiAmount(tx.fee), '交易手续费数据无效。');
    return {
      txid: tx.txid, time: tx.status.block_time, height: tx.status.block_height,
      received, spent, delta: received - spent, fee: tx.fee,
      dependencies: tx.vin.map(input => input.txid).filter(Boolean),
    };
  });
  coreAssert(new Set(txs.map(tx => tx.txid)).size === txs.length, '交易列表包含重复记录。');
  const groups = new Map();
  for (const tx of orderedTransactions(txs)) {
    const key = `${tx.height}:${tx.time}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tx);
  }
  const output = [];
  for (const group of groups.values()) {
    // Esplora returns newest first, including a spend before its same-block parent.
    const remaining = new Map(group.map(tx => [tx.txid, tx]));
    while (remaining.size) {
      const next = [...remaining.values()].find(tx => tx.dependencies.every(id => !remaining.has(id)));
      coreAssert(next, '同一区块的交易依赖关系无效。');
      remaining.delete(next.txid);
      const { dependencies, ...normalized } = next;
      output.push(normalized);
    }
  }
  return output;
}

/** Return only a sample that was already available at the requested instant. */
export function priceAt(prices, time) {
  let low = 0;
  let high = prices.length - 1;
  let found = null;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (prices[middle].time <= time) {
      found = prices[middle];
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

function validateNormalizedTx(tx, asOf, pending = false) {
  coreAssert(tx && typeof tx === 'object', '交易记录格式无效。');
  coreAssert(typeof tx.txid === 'string' && /^[a-f0-9]{64}$/i.test(tx.txid), '交易编号格式无效。');
  if (pending) coreAssert(tx.time === null, '待确认交易不应包含确认时间。');
  else {
    coreAssert(Number.isSafeInteger(tx.time) && tx.time > 0 && tx.status?.confirmed !== false,
      '已确认历史包含未确认交易或无效的时间。');
    coreAssert(tx.time <= asOf, '交易时间晚于本次数据更新时间，无法回放。');
    coreAssert(isSatoshiAmount(tx.height), '交易区块高度无效。');
  }
  coreAssert(isSatoshiAmount(tx.received) && isSatoshiAmount(tx.spent), '交易金额必须以整数聪记录。');
  coreAssert(tx.received > 0 || tx.spent > 0, '交易列表包含与此地址无关的记录。');
  coreAssert(Number.isSafeInteger(tx.delta) && tx.delta === tx.received - tx.spent,
    '交易净变动与输入输出金额不一致。');
  coreAssert(isSatoshiAmount(tx.fee), '交易手续费数据无效。');
}

/** Reject incomplete histories before displaying an apparently correct total. */
export function validateSnapshot(data, expectedAddress) {
  coreAssert(data && typeof data === 'object' && data.version === 1, '余额快照格式或版本无效。');
  coreAssert(typeof data.address === 'string' && data.address.trim().length > 0, '快照缺少有效的比特币地址。');
  if (expectedAddress !== undefined) {
    coreAssert(data.address === expectedAddress, '快照地址与当前展示地址不一致。');
  }
  const parsedTime = typeof data.fetchedAt === 'string' ? Date.parse(data.fetchedAt) : NaN;
  coreAssert(Number.isFinite(parsedTime) && parsedTime > 0, '快照缺少有效的更新时间。');
  const asOf = Math.floor(parsedTime / 1000);
  coreAssert(data.summary?.address === data.address, '链上接口返回了另一个地址的数据。');
  const stats = data.summary?.chain_stats;
  coreAssert(stats && isSatoshiAmount(stats.tx_count) && isSatoshiAmount(stats.funded_txo_sum)
    && isSatoshiAmount(stats.spent_txo_sum), '地址链上汇总数据不完整。');
  const pendingStats = data.summary.mempool_stats;
  coreAssert(pendingStats && isSatoshiAmount(pendingStats.tx_count)
    && isSatoshiAmount(pendingStats.funded_txo_sum) && isSatoshiAmount(pendingStats.spent_txo_sum),
  '地址待确认交易汇总数据不完整。');
  coreAssert(Array.isArray(data.transactions), '快照缺少完整的已确认交易历史。');
  coreAssert(data.transactions.length === stats.tx_count, '已确认交易数量与链上汇总不一致，拒绝展示不完整的历史。');
  const ids = new Set();
  for (const tx of data.transactions) {
    validateNormalizedTx(tx, asOf);
    coreAssert(!ids.has(tx.txid), '交易历史包含重复记录。');
    ids.add(tx.txid);
  }
  const received = checkedSum(data.transactions.map(tx => tx.received), '累计转入金额');
  const spent = checkedSum(data.transactions.map(tx => tx.spent), '累计支出金额');
  coreAssert(received === stats.funded_txo_sum && spent === stats.spent_txo_sum,
    '历史转入或支出总额与链上汇总不一致，拒绝展示不完整的历史。');
  let balance = 0;
  for (const tx of orderedTransactions(data.transactions)) {
    balance += tx.delta;
    coreAssert(Number.isSafeInteger(balance) && balance >= 0,
      '历史余额出现负数，交易历史不完整或同一区块交易顺序有误。');
  }
  coreAssert(balance === stats.funded_txo_sum - stats.spent_txo_sum,
    '回放余额与链上余额不一致。');
  coreAssert(Array.isArray(data.pending), '快照缺少待确认交易列表。');
  for (const tx of data.pending) {
    validateNormalizedTx(tx, asOf, true);
    coreAssert(!ids.has(tx.txid), '已确认与待确认列表包含重复交易。');
    ids.add(tx.txid);
  }
  coreAssert(Array.isArray(data.prices), '历史价格列表格式无效。');
  let lastPriceTime = -1;
  for (const price of data.prices) {
    coreAssert(price && Number.isSafeInteger(price.time) && price.time > 0
      && price.time > lastPriceTime, '历史价格必须按时间严格递增排列。');
    coreAssert(price.time <= asOf, '历史价格时间晚于本次数据更新时间。');
    coreAssert(Number.isFinite(price.USD) && price.USD > 0, '历史价格包含无效的美元报价。');
    lastPriceTime = price.time;
  }
  if (data.quote != null) {
    coreAssert(Number.isSafeInteger(data.quote.time) && data.quote.time > 0
      && data.quote.time <= asOf, '当前报价的时间无效或晚于数据更新时间。');
    coreAssert(Number.isFinite(data.quote.USD) && data.quote.USD > 0, '当前美元报价无效。');
  }
  if (data.fx != null) {
    coreAssert(Array.isArray(data.fx.rates), '汇率历史格式无效。');
    let previousDate = '';
    for (const rate of data.fx.rates) {
      const day = rate && typeof rate.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rate.date)
        ? Date.parse(rate.date + 'T00:00:00Z') : NaN;
      coreAssert(Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === rate.date
        && rate.date > previousDate, '汇率历史必须按有效日期严格递增排列。');
      coreAssert(Number.isFinite(rate.rate) && rate.rate > 0, '汇率历史包含无效报价。');
      previousDate = rate.date;
    }
  }
  return data;
}

/** Historical address valuation, not investment P&L or realized cost basis. */
export function buildHistory(data, expectedAddress) {
  validateSnapshot(data, expectedAddress);
  const asOf = Math.floor(Date.parse(data.fetchedAt) / 1000);
  const txs = orderedTransactions(data.transactions);
  const firstTime = txs[0]?.time ?? null;
  const observations = new Map(data.prices.map(price => [price.time, { ...price, kind: 'price' }]));
  if (data.quote) observations.set(data.quote.time, { ...data.quote, kind: 'quote' });
  const samples = [...observations.values()].sort((a, b) => a.time - b.time);
  const points = [];
  const transactions = [];
  let balanceSats = 0;
  const valueOf = (sats, price) => sats === 0 ? 0 : price == null ? null : sats / SATOSHIS_PER_BTC * price;
  const addPoint = (time, kind, sample, txid) => {
    const price = sample?.USD ?? null;
    const point = { time, sats: balanceSats, price, value: valueOf(balanceSats, price),
      priceTime: sample?.time ?? null, kind };
    if (txid) point.txid = txid;
    points.push(point);
  };
  if (firstTime !== null) {
    addPoint(firstTime, 'start', priceAt(samples, firstTime));
    const events = [
      ...samples.filter(price => price.time >= firstTime).map(price => ({ time: price.time, price })),
      ...txs.map(tx => ({ time: tx.time, tx })),
    ].sort((a, b) => a.time - b.time || (a.price ? 0 : 1) - (b.price ? 0 : 1));
    for (const event of events) {
      if (event.price) addPoint(event.time, event.price.kind, event.price);
      else {
        const tx = event.tx;
        const sample = priceAt(samples, tx.time);
        addPoint(tx.time, 'transaction-before', sample, tx.txid);
        balanceSats += tx.delta;
        addPoint(tx.time, 'transaction-after', sample, tx.txid);
        transactions.push({ ...tx, balanceSats, price: sample?.USD ?? null,
          priceTime: sample?.time ?? null, valueUSD: valueOf(tx.delta, sample?.USD ?? null) });
      }
    }
  }
  addPoint(asOf, 'snapshot', priceAt(samples, asOf));
  return { points, transactions, balanceSats,
    receivedSats: data.summary.chain_stats.funded_txo_sum,
    spentSats: data.summary.chain_stats.spent_txo_sum, asOf, firstTime };
}

// Daily reference rates are applied from the following UTC day to avoid using
// a fixing before it was published. Weekends carry the previous available rate.
export function fxRateAt(rates, seconds) {
  const day = new Date(seconds * 1000).toISOString().slice(0, 10);
  let low = 0, high = (rates?.length ?? 0) - 1, found = null;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (rates[mid].date < day) { found = rates[mid]; low = mid + 1; }
    else high = mid - 1;
  }
  return found && Number.isFinite(found.rate) && found.rate > 0 ? found : null;
}

export function convertUsd(value, seconds, currency, rates) {
  if (value == null || !Number.isFinite(value)) return null;
  if (currency !== 'CNY' || value === 0) return value;
  const rate = fxRateAt(rates, seconds);
  return rate ? value * rate.rate : null;
}

/** Cash-flow-adjusted mark-to-market P&L over a day or a snapshot-relative window. */
export function periodProfit(data, currency = 'USD', period = 'today', now = Date.now() / 1000) {
  coreAssert(['today', '7', '30', '90'].includes(period), '盈亏周期无效，请选择今日、7 天、30 天或 90 天。');
  const asOf = Math.floor(Date.parse(data.fetchedAt) / 1000);
  coreAssert(Number.isFinite(asOf), '快照缺少有效的更新时间。');
  coreAssert(period !== 'today' || Number.isFinite(now), '当前时间无效，无法计算今日盈亏。');
  const start = period === 'today'
    ? Math.floor((now + 28800) / 86400) * 86400 - 28800
    : asOf - Number(period) * 86400;
  const result = { value: null, start, end: asOf, opening: null, closing: null, flows: null, reason: '', period };
  if (period === 'today' && asOf < start) return { ...result, reason: '快照不属于今天，刷新后计算' };
  const samples = [...data.prices, ...(data.quote ? [data.quote] : [])].sort((a, b) => a.time - b.time);
  const closingPrice = priceAt(samples, asOf);
  if (period === 'today' && (!closingPrice || closingPrice.time < start)) {
    return { ...result, reason: '缺少今日行情' };
  }
  // Never let records after this snapshot, or unconfirmed records, alter its P&L.
  const confirmed = data.transactions.filter(tx => Number.isSafeInteger(tx.time) && tx.time > 0 && tx.time <= asOf);
  const openingSats = confirmed.filter(tx => tx.time < start).reduce((sum, tx) => sum + tx.delta, 0);
  const closingSats = confirmed.reduce((sum, tx) => sum + tx.delta, 0);
  const valuation = (sats, seconds) => {
    const price = priceAt(samples, seconds);
    return convertUsd(sats === 0 ? 0 : price ? sats / 1e8 * price.USD : null, seconds, currency, data.fx?.rates);
  };
  const opening = valuation(openingSats, start), closing = valuation(closingSats, asOf);
  let flows = 0;
  let absoluteFlows = 0;
  for (const tx of confirmed.filter(tx => tx.time >= start)) {
    const flow = valuation(tx.delta, tx.time);
    if (flow == null) return { ...result, opening, closing, reason: '缺少转账时行情或汇率' };
    flows += flow;
    absoluteFlows += Math.abs(flow);
  }
  const reason = opening == null ? (period === 'today' ? '缺少日初行情或汇率' : '缺少期初行情或汇率')
    : closing == null ? '缺少期末行情或汇率' : '';
  let value = reason ? null : closing - opening - flows;
  // Remove floating-point cancellation dust, without rounding actual monetary changes.
  const roundoff = Number.EPSILON * Math.max(1, Math.abs(opening) + Math.abs(closing) + absoluteFlows)
    * (confirmed.length + 3);
  if (value != null && Math.abs(value) <= roundoff) value = 0;
  return { ...result, value, opening, closing, flows, reason };
}

/** Backwards-compatible daily entry point; the day starts at 00:00 Asia/Shanghai. */
export function dailyProfit(data, currency = 'USD', now = Date.now() / 1000) {
  return periodProfit(data, currency, 'today', now);
}
