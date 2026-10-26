import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { normalizeTransactions, validateSnapshot, priceAt, buildHistory, fxRateAt, convertUsd, dailyProfit, periodProfit } from './core.mjs';

const address = 'synthetic-test-address';
const otherAddress = 'other-address';
const epoch = 1_700_000_000;
const id = n => n.toString(16).padStart(64, '0');

test('CNY uses previous available reference fixing, including weekends, never future rates', () => {
  const rates=[{date:'2026-10-01',rate:7},{date:'2026-10-02',rate:6.9},{date:'2026-10-05',rate:6.8}];
  const t=Date.parse('2026-10-04T06:00:00Z')/1000;
  assert.equal(fxRateAt(rates,t).rate,6.9);
  assert.equal(convertUsd(100,t,'CNY',rates),690);
  assert.equal(fxRateAt(rates,Date.parse('2026-10-01T23:59:59Z')/1000),null);
});

test('today P&L removes intraday deposits and withdrawals and rejects yesterday snapshots', () => {
  const start=Date.parse('2026-10-02T16:00:00Z')/1000;
  const data={fetchedAt:new Date((start+300)*1000).toISOString(),transactions:[
    {time:start-1,delta:1e8},{time:start+100,delta:2e8},{time:start+200,delta:-1e8}],
    prices:[{time:start,USD:100},{time:start+100,USD:110},{time:start+200,USD:120}],
    quote:{time:start+300,USD:130},fx:{rates:[{date:'2026-10-01',rate:7}]}};
  const result=dailyProfit(data,'USD',start+300);
  assert.equal(result.start,start);
  assert.equal(result.value,60);
  assert.equal(dailyProfit(data,'CNY',start+300).value,420);
  assert.equal(dailyProfit(data,'USD',start+86400).value,null);
  data.quote.USD=120;data.prices.forEach(p=>p.USD=120);
  assert.equal(dailyProfit(data,'USD',start+300).value,0);
});

test('7/30/90-day windows use exactly N days before the snapshot even when viewed later', () => {
  const end = Date.parse('2026-10-06T06:12:34Z') / 1000;
  for (const period of ['7', '30', '90']) {
    const start = end - Number(period) * 86400;
    const data = { fetchedAt: new Date(end * 1000).toISOString(),
      transactions: [{ time: start - 1, delta: 1e8 }],
      prices: [{ time: start, USD: 100 }], quote: { time: end, USD: 130 } };
    const result = periodProfit(data, 'USD', period, end + 200 * 86400);
    assert.equal(result.start, start);
    assert.equal(result.end, end);
    assert.equal(result.period, period);
    assert.equal(result.opening, 100);
    assert.equal(result.closing, 130);
    assert.equal(result.flows, 0);
    assert.equal(result.value, 30);
    assert.equal(result.reason, '');
  }
});

test('period P&L includes boundary cash flows and excludes transactions after the snapshot', () => {
  const end = Date.parse('2026-10-06T12:00:00Z') / 1000;
  const start = end - 7 * 86400;
  const middle = start + 86400;
  const data = { fetchedAt: new Date(end * 1000).toISOString(), transactions: [
    { time: start - 100, delta: 3e8 }, { time: start - 1, delta: -2e8 },
    { time: start, delta: 2e8 }, { time: start, delta: -0.5e8 },
    { time: middle, delta: -0.5e8 }, { time: end, delta: 0.5e8 },
    { time: end + 1, delta: 100e8 }, { time: null, delta: 100e8 },
  ], prices: [{ time: start, USD: 100 }, { time: middle, USD: 120 }],
  quote: { time: end, USD: 130 } };
  const result = periodProfit(data, 'USD', '7');
  assert.equal(result.opening, 100);
  assert.equal(result.closing, 325);
  assert.equal(result.flows, 155);
  assert.equal(result.value, 70);
  data.prices.forEach(price => { price.USD = 120; });
  data.quote.USD = 120;
  assert.equal(periodProfit(data, 'USD', '7').value, 0, 'cash movements alone are not profit');
});

test('a period beginning before first funding needs no price or FX while holdings are zero', () => {
  const end = Date.parse('2026-10-06T12:00:00Z') / 1000;
  const first = end - 100;
  const data = { fetchedAt: new Date(end * 1000).toISOString(),
    transactions: [{ time: first, delta: 1e8 }],
    prices: [{ time: first, USD: 100 }], quote: { time: end, USD: 110 },
    fx: { rates: [{ date: '2026-10-05', rate: 7 }] } };
  const result = periodProfit(data, 'CNY', '90');
  assert.equal(result.opening, 0);
  assert.equal(result.flows, 700);
  assert.equal(result.closing, 770);
  assert.equal(result.value, 70);
});

test('fractional-BTC cash flows at an unchanged price produce zero rather than floating-point profit', () => {
  const end = Date.parse('2026-10-06T12:00:00Z') / 1000;
  const start = end - 7 * 86400;
  const data = { fetchedAt: new Date(end * 1000).toISOString(), transactions: [
    { time: start - 1, delta: 1129179 }, { time: start, delta: 1000035 },
    { time: start + 1, delta: -79379 },
  ], prices: [{ time: start, USD: 49999.13 }], quote: { time: end, USD: 49999.13 } };
  assert.equal(periodProfit(data, 'USD', '7').value, 0);
});

test('CNY period P&L values opening, closing and every cash flow at their historical exchange rates', () => {
  const end = Date.parse('2026-10-06T12:00:00Z') / 1000;
  const start = end - 7 * 86400;
  const depositTime = start + 86400, withdrawalTime = start + 2 * 86400;
  const data = { fetchedAt: new Date(end * 1000).toISOString(), transactions: [
    { time: start - 1, delta: 1e8 }, { time: depositTime, delta: 2e8 },
    { time: withdrawalTime, delta: -1e8 },
  ], prices: [{ time: start, USD: 100 }, { time: depositTime, USD: 110 },
    { time: withdrawalTime, USD: 120 }], quote: { time: end, USD: 130 }, fx: { rates: [
    { date: '2026-09-28', rate: 7 }, { date: '2026-09-29', rate: 6.8 },
    { date: '2026-09-30', rate: 6.9 }, { date: '2026-10-05', rate: 6.7 },
    { date: '2026-10-06', rate: 99 },
  ] } };
  const result = periodProfit(data, 'CNY', '7');
  assert.ok(Math.abs(result.opening - 700) < 1e-9);
  assert.ok(Math.abs(result.closing - 1742) < 1e-9);
  assert.ok(Math.abs(result.flows - 668) < 1e-9);
  assert.ok(Math.abs(result.value - 374) < 1e-9);
});

test('nonzero opening holdings require an earlier price; later observations never fill that gap', () => {
  const end = Date.parse('2026-10-06T12:00:00Z') / 1000;
  const start = end - 30 * 86400;
  const data = { fetchedAt: new Date(end * 1000).toISOString(),
    transactions: [{ time: start - 1, delta: 1e8 }],
    prices: [{ time: start + 1, USD: 100 }], quote: { time: end, USD: 110 } };
  const result = periodProfit(data, 'USD', '30');
  assert.equal(result.value, null);
  assert.equal(result.opening, null);
  assert.equal(result.closing, 110);
  assert.match(result.reason, /期初/);
  data.transactions = [{ time: start, delta: 1e8 }];
  const missingFlow = periodProfit(data, 'USD', '30');
  assert.equal(missingFlow.opening, 0);
  assert.equal(missingFlow.value, null);
  assert.equal(missingFlow.flows, null);
  assert.match(missingFlow.reason, /转账时/);
});

test('missing closing prices and missing FX produce unavailable P&L rather than invented amounts', () => {
  const end = Date.parse('2026-10-06T12:00:00Z') / 1000;
  const start = end - 7 * 86400;
  const data = { fetchedAt: new Date(end * 1000).toISOString(),
    transactions: [{ time: start - 1, delta: 1e8 }],
    prices: [], quote: { time: end + 1, USD: 200 } };
  const missingPrice = periodProfit(data, 'USD', '7');
  assert.equal(missingPrice.value, null);
  assert.equal(missingPrice.closing, null);
  data.prices = [{ time: start, USD: 100 }];
  data.quote.time = end;
  assert.equal(periodProfit(data, 'CNY', '7').value, null);
  const zero = periodProfit({ ...data, transactions: [], prices: [], quote: null }, 'CNY', '7');
  assert.equal(zero.value, 0);
});

test('daily wrapper retains Beijing-day semantics and rejects unsupported period choices', () => {
  const start = Date.parse('2026-10-05T16:00:00Z') / 1000;
  const data = { fetchedAt: new Date((start + 10) * 1000).toISOString(), transactions: [],
    prices: [{ time: start, USD: 100 }], quote: null };
  assert.deepEqual(dailyProfit(data, 'USD', start + 10), periodProfit(data, 'USD', 'today', start + 10));
  const stale = periodProfit(data, 'USD', 'today', start + 86400);
  assert.equal(stale.value, null);
  assert.equal(stale.start, start + 86400);
  assert.equal(stale.end, start + 10);
  assert.match(stale.reason, /不属于今天/);
  data.prices[0].time = start - 1;
  assert.match(periodProfit(data, 'USD', 'today', start + 10).reason, /今日行情/);
  for (const period of ['all', 'week', '0', '365', 7, null]) {
    assert.throws(() => periodProfit(data, 'USD', period), /周期无效/);
  }
});

const tx = (n, time, received, spent = 0) => ({ txid: id(n), time, height: n,
  received, spent, delta: received - spent, fee: 100 });

function snapshot(transactions = [tx(1, epoch + 100, 100_000_000)], changes = {}) {
  return {
    version: 1, address, fetchedAt: new Date((epoch + 1000) * 1000).toISOString(),
    summary: { address, chain_stats: { tx_count: transactions.length,
      funded_txo_sum: transactions.reduce((sum, item) => sum + item.received, 0),
      spent_txo_sum: transactions.reduce((sum, item) => sum + item.spent, 0) },
      mempool_stats: { tx_count: 0, funded_txo_sum: 0, spent_txo_sum: 0 } },
    transactions, pending: [], prices: [{ time: epoch, USD: 20_000 }, { time: epoch + 500, USD: 30_000 }],
    quote: { time: epoch + 900, USD: 40_000 }, sources: {}, ...changes,
  };
}

function rawTx(n, { time = epoch + 100, height = n, confirmed = true, inputs = [], outputs = [] } = {}) {
  return { txid: id(n), status: { confirmed, block_time: time, block_height: height }, fee: 100,
    vin: inputs.map(([source, value, owner = address]) => ({ txid: id(source),
      prevout: { value, scriptpubkey_address: owner } })),
    vout: outputs.map(([value, owner = address]) => ({ value, scriptpubkey_address: owner })) };
}

test('historical lookup never borrows the next price or current quote', () => {
  const prices = [{ time: epoch + 200, USD: 20_000 }, { time: epoch + 400, USD: 30_000 }];
  assert.equal(priceAt(prices, epoch + 199), null);
  assert.equal(priceAt([], epoch), null);
  assert.equal(priceAt(prices, epoch + 200).USD, 20_000);
  assert.equal(priceAt(prices, epoch + 399).USD, 20_000);
  const result = buildHistory(snapshot(undefined, { prices }));
  assert.equal(result.transactions[0].price, null);
  assert.equal(result.transactions[0].valueUSD, null);
  assert.equal(result.points.find(point => point.kind === 'transaction-after').value, null);
  assert.equal(result.points.at(-1).value, 40_000);
  assert.equal(result.points.at(-1).priceTime, epoch + 900);
});

test('a missing price history stays unavailable until a dated quote exists', () => {
  const result = buildHistory(snapshot(undefined, { prices: [] }));
  assert.equal(result.points[0].value, 0);
  assert.equal(result.transactions[0].priceTime, null);
  assert.equal(result.points.find(point => point.kind === 'quote').time, epoch + 900);
  const noQuote = buildHistory(snapshot(undefined, { prices: [], quote: null }));
  assert.equal(noQuote.points.at(-1).price, null);
  assert.equal(noQuote.points.at(-1).value, null);
});

test('outflows create a vertical amount change; address change is counted once', () => {
  const normalized = normalizeTransactions([
    rawTx(2, { time: epoch + 600, inputs: [[1, 100_000_000]], outputs: [[39_999_900], [60_000_000, otherAddress]] }),
    rawTx(1, { outputs: [[100_000_000]] }),
  ], address);
  assert.equal(normalized[1].delta, -60_000_100);
  const result = buildHistory(snapshot(normalized));
  assert.equal(result.balanceSats, 39_999_900);
  assert.equal(result.receivedSats, 139_999_900);
  assert.equal(result.spentSats, 100_000_000);
  assert.equal(result.transactions[1].valueUSD, -60_000_100 / 100_000_000 * 30_000);
  const jump = result.points.filter(point => point.txid === id(2));
  assert.deepEqual(jump.map(point => [point.time, point.sats]), [[epoch + 600, 100_000_000], [epoch + 600, 39_999_900]]);
  assert.equal(result.points.at(-1).value, 39_999_900 / 100_000_000 * 40_000);
});

test('same-block dependencies are replayed parent before child despite API order', () => {
  const raw = [
    rawTx(2, { height: 10, inputs: [[1, 1000]], outputs: [[900]] }),
    rawTx(1, { height: 10, outputs: [[1000]] }),
  ];
  const normalized = normalizeTransactions(raw, address);
  assert.deepEqual(normalized.map(item => item.txid), [id(1), id(2)]);
  assert.equal(buildHistory(snapshot(normalized)).balanceSats, 900);
});

test('unconfirmed movements never enter confirmed holdings or historical value', () => {
  const normalized = normalizeTransactions([
    rawTx(1, { outputs: [[1000]] }),
    rawTx(2, { confirmed: false, inputs: [[1, 1000]], outputs: [[100]] }),
  ], address);
  assert.equal(normalized.length, 1);
  const pending = { ...tx(2, null, 100, 1000), height: null };
  const result = buildHistory(snapshot(normalized, { pending: [pending] }));
  assert.equal(result.balanceSats, 1000);
  assert.equal(result.transactions.length, 1);
  assert.throws(() => validateSnapshot(snapshot([pending])), /未确认交易/);
});

test('the first confirmed credit starts at zero and ends at fetch time', () => {
  const result = buildHistory(snapshot());
  assert.equal(result.points[0].kind, 'start');
  assert.equal(result.points[0].time, epoch + 100);
  assert.equal(result.points[0].sats, 0);
  assert.equal(result.points.at(-1).time, epoch + 1000);
  assert.equal(result.firstTime, epoch + 100);
  assert.equal(result.asOf, epoch + 1000);
});

test('an empty address has a verified zero balance and no fictitious start date', () => {
  const result = buildHistory(snapshot([]));
  assert.equal(result.balanceSats, 0);
  assert.equal(result.firstTime, null);
  assert.equal(result.points.length, 1);
  assert.equal(result.points[0].value, 0);
});

test('spending the full address balance remains an exact zero without a quote', () => {
  const result = buildHistory(snapshot([tx(1, epoch + 100, 17), tx(2, epoch + 600, 0, 17)],
    { prices: [], quote: null }));
  assert.equal(result.balanceSats, 0);
  assert.equal(result.points.at(-1).value, 0);
});

test('incomplete history, wrong amounts and duplicate rows are refused', () => {
  const incomplete = snapshot([tx(1, epoch + 100, 100), tx(2, epoch + 200, 200)]);
  incomplete.transactions.pop();
  assert.throws(() => validateSnapshot(incomplete), /交易数量/);
  const wrongTotal = snapshot();
  wrongTotal.summary.chain_stats.funded_txo_sum += 1;
  assert.throws(() => validateSnapshot(wrongTotal), /总额/);
  assert.throws(() => validateSnapshot(snapshot([tx(1, epoch + 100, 100), tx(1, epoch + 200, 200)])), /重复/);
  assert.throws(() => validateSnapshot(snapshot([tx(1, epoch + 100, 0, 100)])), /负数/);
  const wrongDelta = snapshot();
  wrongDelta.transactions[0].delta += 1;
  assert.throws(() => validateSnapshot(wrongDelta), /净变动/);
});

test('address mismatch and future transactions or prices are refused', () => {
  assert.throws(() => validateSnapshot(snapshot(undefined, { address: otherAddress })), /地址/);
  const wrongSummary = snapshot();
  wrongSummary.summary.address = otherAddress;
  assert.throws(() => validateSnapshot(wrongSummary), /地址/);
  assert.throws(() => validateSnapshot(snapshot([tx(1, epoch + 1001, 100)])), /交易时间/);
  assert.throws(() => validateSnapshot(snapshot(undefined, { prices: [{ time: epoch + 1001, USD: 20_000 }] })), /价格时间/);
  assert.throws(() => validateSnapshot(snapshot(undefined, { quote: { time: epoch + 1001, USD: 20_000 } })), /报价的时间/);
});

test('snapshots can use any supplied address while an expected address pins cache and refresh data', () => {
  const first = snapshot();
  assert.equal(validateSnapshot(first, address), first);
  const alternate = snapshot(undefined, { address: otherAddress });
  alternate.summary.address = otherAddress;
  assert.equal(validateSnapshot(alternate), alternate);
  assert.throws(() => validateSnapshot(alternate, address), /当前展示地址不一致/);
  assert.throws(() => buildHistory(alternate, address), /当前展示地址不一致/);
  assert.equal(buildHistory(alternate, otherAddress).balanceSats, 100_000_000);
  for (const invalidAddress of [undefined, null, '', ' ', 123]) {
    const invalid = snapshot(undefined, { address: invalidAddress });
    invalid.summary.address = invalidAddress;
    assert.throws(() => validateSnapshot(invalid), /比特币地址/);
  }
  const inconsistent = snapshot();
  inconsistent.summary.address = otherAddress;
  assert.throws(() => validateSnapshot(inconsistent, address), /另一个地址/);
});

test('pending summary must be renderable but does not require a separate pending transaction fetch', () => {
  const absent = snapshot();
  delete absent.summary.mempool_stats;
  assert.throws(() => validateSnapshot(absent), /待确认交易汇总/);
  for (const field of ['tx_count', 'funded_txo_sum', 'spent_txo_sum']) {
    const invalid = snapshot();
    invalid.summary.mempool_stats[field] = '1';
    assert.throws(() => validateSnapshot(invalid), /待确认交易汇总/);
  }
  const summaryOnly = snapshot();
  summaryOnly.summary.mempool_stats = { tx_count: 2, funded_txo_sum: 1000, spent_txo_sum: 2000 };
  assert.doesNotThrow(() => validateSnapshot(summaryOnly));
  assert.equal(buildHistory(summaryOnly).balanceSats, 100_000_000);
});

test('invalid prices and fractional or unsafe satoshis are refused', () => {
  for (const USD of [NaN, Infinity, 0, -1, '20000']) {
    assert.throws(() => validateSnapshot(snapshot(undefined, { prices: [{ time: epoch, USD }] })), /报价/);
  }
  assert.throws(() => validateSnapshot(snapshot(undefined, { prices: [
    { time: epoch + 1, USD: 10 }, { time: epoch, USD: 10 },
  ] })), /严格递增/);
  assert.throws(() => validateSnapshot(snapshot([tx(1, epoch + 100, 0.5)])), /不完整|整数聪/);
  assert.throws(() => normalizeTransactions([rawTx(1, { outputs: [[Number.MAX_SAFE_INTEGER], [1]] })], address), /精确计算/);
});

test('wallet snapshots reject malformed, duplicate, unsorted and impossible FX fixings before valuation', () => {
  const valid=[{date:'2026-10-01',rate:7},{date:'2026-10-02',rate:6.9}];
  assert.doesNotThrow(()=>validateSnapshot(snapshot(undefined,{fx:{rates:valid}})));
  assert.doesNotThrow(()=>validateSnapshot(snapshot(undefined,{fx:{rates:[]}})));
  for (const rates of [undefined,[...valid].reverse(),[valid[0],valid[0]],
    [{date:'2026-02-30',rate:7}],[{date:'2026-10-01',rate:'7'}],[{date:'2026-10-01',rate:Infinity}],
    [{date:'2026-10-01',rate:0}],[null]]) {
    assert.throws(()=>validateSnapshot(snapshot(undefined,{fx:{rates}})),/汇率历史/);
  }
});

test('small satoshi movements retain integer precision across the entire replay', () => {
  const result = buildHistory(snapshot([
    tx(1, epoch + 100, 100_000_001), tx(2, epoch + 200, 0, 1), tx(3, epoch + 300, 1),
  ]));
  assert.equal(result.balanceSats, 100_000_001);
  assert.deepEqual(result.transactions.map(item => item.balanceSats), [100_000_001, 100_000_000, 100_000_001]);
});

const realSnapshotPath = new URL('../data/bitcoin-balance-snapshot.json', import.meta.url);
test('saved real address snapshot fully reconciles to explorer totals', { skip: !existsSync(realSnapshotPath) }, () => {
  const data = JSON.parse(readFileSync(realSnapshotPath, 'utf8'));
  const result = buildHistory(data);
  assert.equal(result.transactions.length, data.summary.chain_stats.tx_count);
  assert.equal(result.balanceSats, data.summary.chain_stats.funded_txo_sum - data.summary.chain_stats.spent_txo_sum);
  assert.ok(result.points.every(point => Number.isSafeInteger(point.sats) && point.sats >= 0));
  assert.ok(result.transactions.every(item => item.priceTime === null || item.priceTime <= item.time));
});
