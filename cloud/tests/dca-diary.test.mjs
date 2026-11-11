import test from 'node:test';
import assert from 'node:assert/strict';
import { dcaDiary, DCA_DIARY_START, DCA_FIELDS } from '../dca-diary.mjs';

const at = text => Date.parse(text);
let next = 1;
function fill(side, btcNet, quote, when, { ccy = 'USDT', venue } = {}) {
  const id = next++;
  return { id: String(id), bill_id: String(id * 2), counter_bill_id: String(id * 2 + 1), at_ms: at(when), side, inst_id: 'BTC-' + ccy, quote_ccy: ccy, btc_net: btcNet, btc_gross: btcNet.replace('-', ''), quote_amount: quote, quote_gross: quote, fee_btc: '0', fee_quote: '0', price: '1', original_price: '1', trade_id: String(id), order_id: String(id), ...(venue ? { venue } : {}) };
}
const minuteKey = (ccy, when) => ccy + ':' + Math.floor(at(when) / 60000) * 60000;

test('the diary starts on 2024-12-14 and groups buys by Beijing day', () => {
  assert.equal(DCA_DIARY_START, '2024-12-14');
  assert.deepEqual(DCA_FIELDS, ['date', 'btc', 'usdt', 'buys']);
  const diary = dcaDiary([
    fill('buy', '0.0003', '20', '2024-12-13T16:30:00Z'),   // 2024-12-14 00:30 Beijing: the first purchase
    fill('buy', '0.00021', '20', '2024-12-14T15:59:59Z'),  // 23:59:59 the same Beijing day
    fill('buy', '0.0002', '20', '2024-12-14T16:00:00Z'),   // 00:00 the next Beijing day
  ]);
  assert.equal(diary.start_date, '2024-12-14'); assert.equal(diary.first_buy_date, '2024-12-14');
  assert.deepEqual(diary.days, [['2024-12-14', '0.00051', '40', 2], ['2024-12-15', '0.0002', '20', 1]]);
  assert.deepEqual(diary.totals, { days: 2, buys: 3, btc: '0.00071', usdt: '60' });
});

test('days count the BTC received after fees, value other quotes at the fill minute and leave sales out', () => {
  const usdc = fill('buy', '0.0005', '50', '2025-03-02T02:00:30Z', { ccy: 'USDC' });
  const fee = fill('buy', '0.000999', '100', '2025-03-02T03:00:00Z'); fee.btc_gross = '0.001'; fee.fee_btc = '-0.000001';
  const diary = dcaDiary([usdc, fee, fill('sell', '-0.4', '30000', '2025-03-02T04:00:00Z')], { rates: { [minuteKey('USDC', '2025-03-02T02:00:30Z')]: { close: '0.9998' } } });
  assert.deepEqual(diary.days, [['2025-03-02', '0.001499', '149.99', 2]]);
  assert.equal(diary.start_date, '2024-12-14', 'the diary keeps its start when the first buy is later');
  assert.equal(diary.first_buy_date, '2025-03-02');
});

test('a buy without its minute rate leaves only that day\'s USDT unknown, never zero', () => {
  const diary = dcaDiary([fill('buy', '0.001', '90', '2025-05-01T01:00:00Z', { ccy: 'FDUSD' }), fill('buy', '0.0002', '20', '2025-05-02T01:00:00Z')]);
  assert.deepEqual(diary.days, [['2025-05-01', '0.001', null, 1], ['2025-05-02', '0.0002', '20', 1]]);
  assert.equal(diary.totals.usdt, null); assert.equal(diary.totals.btc, '0.0012');
});

test('amounts are rounded to satoshis and cents; malformed rows are skipped', () => {
  const diary = dcaDiary([
    fill('buy', '0.000123456789', '20.005', '2025-06-01T01:00:00Z'),
    { ...fill('buy', '0.1', '1', '2025-06-01T02:00:00Z'), at_ms: 1.5 },
    { ...fill('buy', 'nope', '1', '2025-06-01T03:00:00Z') },
    { ...fill('buy', '0', '1', '2025-06-01T04:00:00Z') },
    { ...fill('transfer', '0.1', '1', '2025-06-01T05:00:00Z') }, null, 'row']);
  assert.deepEqual(diary.days, [['2025-06-01', '0.00012346', '20.01', 1]]);
  assert.deepEqual(dcaDiary(null), { start_date: '2024-12-14', first_buy_date: null, coverage_start_date: null, fields: DCA_FIELDS, days: [], totals: { days: 0, buys: 0, btc: '0', usdt: '0' },
    exact_totals: { days: 0, buys: 0, btc: '0', usdt: '0', average_buy_price: null }, exact_periods: {}, exact_days: {} });
});

test('a recorded buy before the start moves the start back instead of being hidden; coverage is reported as a Beijing date', () => {
  const diary = dcaDiary([fill('buy', '0.001', '100', '2024-12-10T02:00:00Z'), fill('buy', '0.001', '100', '2024-12-20T02:00:00Z')], { coverageStartMs: at('2024-12-09T16:00:00Z') });
  assert.equal(diary.start_date, '2024-12-10'); assert.equal(diary.first_buy_date, '2024-12-10');
  assert.equal(diary.coverage_start_date, '2024-12-10');
  assert.equal(diary.days.length, 2);
});

test('exact summaries retain ledger precision across days and Beijing calendar years', () => {
  const diary = dcaDiary([
    fill('buy', '0.000123456789', '9.87654312', '2024-12-31T15:59:00Z'),
    fill('buy', '0.000123456789', '9.87654312', '2024-12-31T16:01:00Z', { venue: 'binance' }),
    fill('buy', '0.000123456789', '9.87654312', '2025-01-02T01:00:00Z'),
    fill('sell', '-0.0001', '20', '2025-01-02T02:00:00Z'),
  ]);
  assert.deepEqual(diary.days, [
    ['2024-12-31', '0.00012346', '9.88', 1],
    ['2025-01-01', '0.00012346', '9.88', 1],
    ['2025-01-02', '0.00012346', '9.88', 1],
  ]);
  assert.deepEqual(diary.exact_totals, { days: 3, buys: 3, btc: '0.000370370367', usdt: '29.62962936', average_buy_price: '80000' });
  assert.deepEqual(diary.exact_days['2024-12-31'], { btc: '0.000123456789', usdt: '9.87654312', buys: 1 });
  assert.deepEqual(diary.exact_days['2025-01-01'], { btc: '0.000123456789', usdt: '9.87654312', buys: 1 });
  assert.deepEqual(diary.exact_periods, {
    '2024': { days: 1, buys: 1, btc: '0.000123456789', usdt: '9.87654312', average_buy_price: '80000' },
    '2025': { days: 2, buys: 2, btc: '0.000246913578', usdt: '19.75308624', average_buy_price: '80000' },
  });
});

test('missing rates leave exact cost and average unknown only for affected periods', () => {
  const diary = dcaDiary([
    fill('buy', '0.001', '80', '2024-12-20T01:00:00Z'),
    fill('buy', '0.001', '80', '2025-01-02T01:00:00Z', { ccy: 'FDUSD' }),
    fill('buy', '0.001', '80', '2025-01-02T02:00:00Z'),
  ]);
  assert.deepEqual(diary.exact_totals, { days: 2, buys: 3, btc: '0.003', usdt: null, average_buy_price: null });
  assert.deepEqual(diary.exact_periods['2024'], { days: 1, buys: 1, btc: '0.001', usdt: '80', average_buy_price: '80000' });
  assert.deepEqual(diary.exact_periods['2025'], { days: 1, buys: 2, btc: '0.002', usdt: null, average_buy_price: null });
  assert.equal(diary.exact_days['2025-01-02'].usdt, null, 'an unpriced B marker never invents zero spending');
});
