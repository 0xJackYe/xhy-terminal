'use strict';
// 定投日记 checks without a browser: calendar maths, colour levels, streaks,
// the grid markup and the panel's read/refresh behaviour on a fake DOM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const api = require('./terminal/dist/dca-diary.js');
const html = fs.readFileSync('terminal/dist/index.html', 'utf8');
const css = fs.readFileSync('terminal/dist/dca-diary.css', 'utf8');
const server = fs.readFileSync('btc_terminal_server.py', 'utf8');
const DAY = 86400000, D = api.parseDate;
const NOW = Date.parse('2026-11-08T19:31:00Z'); // 2026-11-09 03:31 in Beijing

const DIARY = {
  status: 'fresh', connection_id: 'account-A', venues: ['okx'], as_of: '2026-11-09T03:30:00.000Z', today: '2026-11-09', timezone: 'Asia/Shanghai', error: null,
  start_date: '2024-12-14', first_buy_date: '2024-12-14', coverage_start_date: '2024-12-14', fields: ['date', 'btc', 'usdt', 'buys'],
  days: [['2024-12-14', '0.00520089', '320', 2], ['2024-12-15', '0.00019461', '20', 1], ['2026-11-06', '0.0002', '20', 1], ['2026-11-07', '0.00024574', '20', 1], ['2026-11-08', '0.00025133', '20', 1]],
  totals: { days: 5, buys: 6, btc: '0.00609257', usdt: '400' },
};

let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('OK ' + name); }

(async () => {
  await check('the page loads the diary under the allocation and the local server serves its files', () => {
    assert.match(html, /<link rel="stylesheet" href="\/dca-diary\.css">/);
    assert.match(html, /<script src="\/dca-diary\.js" defer><\/script>/);
    assert.ok(html.indexOf('id="dcaDiaryPanel"') > html.indexOf('id="cryptoPortfolioPanel"'), 'diary sits after 资产分布');
    assert.ok(html.indexOf('id="dcaDiaryPanel"') < html.indexOf('id="okxWalletPanel"'));
    assert.match(server, /"\/dca-diary\.js": STATIC \/ "dca-diary\.js"/); assert.match(server, /"\/dca-diary\.css": STATIC \/ "dca-diary\.css"/);
    assert.equal(api.START, '2024-12-14');
  });

  await check('calendar days are exact UTC dates and today is the Beijing date', () => {
    assert.equal(D('2024-12-14'), Date.UTC(2024, 11, 14)); assert.equal(D('2025-02-29'), null); assert.equal(D('2024-2-1'), null); assert.equal(D(20241214), null);
    assert.equal(api.formatDate(api.beijingToday(NOW)), '2026-11-09');
    assert.equal(api.formatDate(api.beijingToday(Date.parse('2026-11-08T15:59:59Z'))), '2026-11-08');
    assert.equal(api.weekday(D('2026-11-09')), 0, 'Monday is the first row'); assert.equal(api.weekday(D('2026-11-08')), 6);
    assert.equal(api.formatDate(api.monday(D('2024-12-14'))), '2024-12-09');
  });

  await check('BTC and USDT stay exact as satoshis and cents', () => {
    assert.equal(api.units('0.00025133', 8), 25133); assert.equal(api.units('12', 8), 1200000000); assert.equal(api.units('0.123456789', 8), null);
    assert.equal(api.units('-1', 8), null); assert.equal(api.units(0.1, 8), null); assert.equal(api.units('10445', 2), 1044500);
    assert.equal(api.btcText(21480487), '0.21480487'); assert.equal(api.btcText(123456789012), '1,234.56789012'); assert.equal(api.btcText(100000000), '1');
    assert.equal(api.usdtText(1044500), '10,445.00'); assert.equal(api.usdtText(5), '0.05'); assert.equal(api.btcText(-1), '—'); assert.equal(api.usdtText(null), '—');
  });

  await check('full precision decimal summaries round once without floating point or per-day drift', () => {
    assert.equal(api.exactText('0.0030000147', 8), '0.00300001');
    assert.equal(api.exactText('239.1147', 2, true), '239.11');
    assert.equal(api.exactText('79704.509447903705271844', 0), '79,705');
    assert.equal(api.exactText('99999.999999999999999999', 2, true), '100,000.00');
    assert.equal(api.exactText('9007199254740993.005', 2, true), '9,007,199,254,740,993.01');
    for (const value of ['-1', 'NaN', 'Infinity', '1e3', 1, '<script>']) assert.equal(api.exactText(value, 8), '—');
    assert.equal(api.exactSummary({btc:'1',usdt:'100',average_buy_price:'100',buys:1,days:1}).btc, '1');
    assert.equal(api.exactSummary({btc:'-1',usdt:'100',average_buy_price:'100',buys:1,days:1}), null);
  });

  await check('the payload is checked and malformed days are dropped, never drawn', () => {
    assert.equal(api.normalize(null), null); assert.equal(api.normalize({ status: 'odd', days: [] }), null); assert.equal(api.normalize({ status: 'fresh', days: {} }), null);
    const model = api.normalize({ ...DIARY, venues: ['okx', 'evil'], days: [...DIARY.days, ['2025-02-30', '0.1', '1', 1], ['2025-03-01', '0', '0', 1], ['2025-03-02', '-0.1', '1', 1], 'x', ['2025-03-03', '0.000000001', '1', 1], ['2024-12-15', '0.00000539', null, 1]] });
    assert.equal(model.days.size, 5); assert.deepEqual(model.venues, ['okx']);
    assert.deepEqual(model.days.get(D('2024-12-15')), { btc: 20000, usdt: null, buys: 2 }, 'a repeated date merges; an unpriced part makes the USDT unknown');
    assert.equal(model.start, D('2024-12-14')); assert.equal(model.first, D('2024-12-14')); assert.equal(model.today, D('2026-11-09'));
    const earlier = api.normalize({ status: 'fresh', days: [['2024-12-10', '0.001', '100', 1]] });
    assert.equal(api.formatDate(earlier.start), '2024-12-10', 'a recorded earlier buy is never hidden');
    const reordered = api.normalize({ status: 'fresh', fields: ['buys', 'date', 'btc'], days: [[1, '2025-01-01', '0.001']] });
    assert.deepEqual(reordered.days.get(D('2025-01-01')), { btc: 100000, usdt: null, buys: 1 });
  });
  await check('exact personal price bins are validated separately from daily averages',()=>{
    const distribution={bucket_usdt:'5000',priced_btc:'0.000100000001',unpriced_btc:'0.00002',bins:[{from:'60000',to:'65000',btc:'0.000100000001'}]};
    assert.deepEqual(api.normalize({...DIARY,buy_price_distribution:distribution}).buyPriceDistribution,distribution);
    assert.equal(api.normalize(DIARY).buyPriceDistribution,null);
    for(const bad of [{...distribution,bucket_usdt:'1000'},{...distribution,bins:[{from:'60000',to:'66000',btc:'1'}]},{...distribution,bins:[{from:'60000',to:'65000',btc:'-1'}]},{...distribution,bins:[...distribution.bins,...distribution.bins]},{...distribution,unpriced_btc:null}])assert.equal(api.priceDistribution(bad),null);
  });

  await check('six orange levels measure what went in against the usual daily buy, so bigger days keep getting deeper', () => {
    // Cents of USDT and satoshis: a usual 20 USDT day, then 8, 12, 40, 99.50 and 320 USDT days.
    const days = new Map([[1, { btc: 25000, usdt: 2000 }], [2, { btc: 25000, usdt: 2000 }], [3, { btc: 25000, usdt: 2000 }], [4, { btc: 50000, usdt: 4000 }], [5, { btc: 125000, usdt: 9950 }], [6, { btc: 400000, usdt: 32000 }], [7, { btc: 10000, usdt: 800 }]]);
    const measure = api.scale(days);
    assert.equal(measure.unit, 'usdt'); assert.equal(measure.usual, 2000);
    assert.deepEqual(measure.limits, [1000, 1800, 3000, 6000, 12000]);
    assert.deepEqual([7, 1, 4, 5, 6].map(key => api.level(days.get(key), measure)), [1, 3, 4, 5, 6], '8 → 1, the usual 20 → 3, 40 → 4, 99.50 → 5, 320 → 6');
    assert.equal(api.level({ btc: 15000, usdt: 1200 }, measure), 2);
    assert.equal(api.level(undefined, measure), 0); assert.equal(api.level({ btc: 0, usdt: 0 }, measure), 0);
    assert.equal(api.level({ btc: 50000, usdt: null }, measure), 4, 'an unpriced day is valued at the median price paid');
    const btcOnly = api.scale(new Map([[1, { btc: 100, usdt: null }], [2, { btc: 200, usdt: null }], [3, { btc: 300, usdt: null }]]));
    assert.equal(btcOnly.unit, 'btc'); assert.equal(btcOnly.usual, 200); assert.equal(api.level({ btc: 1300, usdt: null }, btcOnly), 6);
    assert.equal(api.scale(new Map()), null); assert.equal(api.level({ btc: 5, usdt: null }, null), 3);
    assert.equal(api.legendText(measure), '颜色越深，当天投入越多（USDT）：10 以下 · 10–18 · 18–30 · 30–60 · 60–120 · 120 以上');
  });

  await check('近一年 is 53 whole weeks ending this week; a year covers its own days only', () => {
    const model = api.normalize(DIARY);
    assert.deepEqual(api.ranges(model), ['recent', '2026', '2025', '2024']);
    const recent = api.bounds('recent', model);
    assert.equal(api.weekday(recent.gridStart), 0); assert.equal(api.weekday(recent.gridEnd), 6);
    assert.equal((recent.gridEnd - recent.gridStart + DAY) / DAY, 53 * 7); assert.equal(recent.to, model.today); assert.equal(recent.label, '近一年');
    const year = api.bounds('2024', model);
    assert.equal(api.formatDate(year.from), '2024-01-01'); assert.equal(api.formatDate(year.to), '2024-12-31'); assert.equal(api.formatDate(year.gridStart), '2023-01-01'.replace('2023-01-01', '2024-01-01'));
    const current = api.bounds('2026', model);
    assert.equal(current.to, model.today, 'the current year stops today'); assert.equal(api.formatDate(current.gridEnd), '2027-01-03');
  });

  await check('range totals count buying days, BTC, USDT and streaks from the start only', () => {
    const model = api.normalize(DIARY);
    const all = api.stats(model, model.start, model.today);
    assert.deepEqual(all, { days: 5, btc: 609257, usdt: 40000, buys: 6, longest: 3, current: 3 });
    const recent = api.bounds('recent', model);
    assert.deepEqual(api.stats(model, recent.from, recent.to), { days: 3, btc: 69707, usdt: 6000, buys: 3, longest: 3, current: 3 });
    // A day without a buy yet does not break the streak; a missed day does.
    const missed = api.normalize({ ...DIARY, days: DIARY.days.filter(([date]) => date !== '2026-11-07') });
    assert.equal(api.stats(missed, missed.start, missed.today).current, 1);
    const gap = api.normalize({ ...DIARY, coverage_start_date: '2024-12-15' });
    assert.equal(api.stats(gap, gap.start, gap.today).days, 4, 'days the ledger does not cover are never counted');
    const unpriced = api.normalize({ ...DIARY, days: [['2026-11-08', '0.0002', null, 1]] });
    assert.equal(api.stats(unpriced, unpriced.start, unpriced.today).usdt, null);
  });

  await check('each square explains itself', () => {
    const model = api.normalize({ ...DIARY, coverage_start_date: '2024-12-15' });
    assert.deepEqual(api.describe(D('2024-12-01'), model), { title: '2024年12月1日 周日', detail: '首笔买入（2024-12-14）之前' });
    assert.equal(api.describe(D('2024-12-14'), model).detail, '成本账本未覆盖这一天');
    const full = api.normalize(DIARY);
    assert.deepEqual(api.describe(D('2024-12-14'), full), { title: '2024年12月14日 周六 · 首笔买入', detail: '买入 0.00520089 BTC · 约 320.00 USDT · 2 笔' });
    assert.equal(api.describe(D('2025-06-01'), full).detail, '没有买入'); assert.equal(api.describe(D('2026-11-09'), full).detail, '今天还没有买入');
  });

  await check('the grid places one square per day, hides days outside the range and labels months inside it', () => {
    const model = api.normalize(DIARY), view = api.bounds('recent', model), limits = api.scale(model.days);
    const built = api.gridHtml(view, model, limits), cells = [...built.html.matchAll(/<i class="dca-cell([^"]*)"([^>]*)>/g)];
    assert.equal(built.weeks, 53); assert.equal(cells.length, 53 * 7);
    const outside = cells.filter(([, cls]) => cls.includes('is-outside'));
    assert.equal(outside.length, 6, 'the six days after today this week are hidden');
    assert.ok(outside.every(([, , rest]) => !rest.includes('data-date')));
    const today = cells.find(([, cls]) => cls.includes('is-today'));
    assert.match(today[2], /data-date="2026-11-09"/); assert.match(today[2], /data-level="0"/);
    assert.match(built.html, /data-level="\d" data-date="2026-11-08"/);
    const months = [...built.html.matchAll(/class="dca-month" style="grid-column:(\d+)"[^>]*>(\d+)月/g)].map(([, column, month]) => [Number(column), Number(month)]);
    assert.ok(months.length >= 11); assert.ok(months.every(([column]) => column - 2 <= built.weeks - 2), 'no label runs past the grid');
    for (let i = 1; i < months.length; i++) assert.ok(months[i][0] - months[i - 1][0] >= 3, 'labels never crowd each other');
    assert.equal((built.html.match(/class="dca-weekday"/g) || []).length, 7);
    const early = api.gridHtml(api.bounds('2024', model), model, limits).html;
    assert.match(early, /class="dca-cell is-before" data-level="0" data-date="2024-12-13"/);
    assert.match(early, /class="dca-cell" data-level="6" data-date="2024-12-14"/, 'the 320 USDT first day is the deepest orange');
    assert.match(built.html, /class="dca-cell" data-level="3" data-date="2026-11-07"/, 'a usual 20 USDT day sits in the middle');
  });

  await check('the stylesheet deepens through bitcoin orange in both themes and pins the weekday labels', () => {
    assert.match(css, /--dca-4:#f7931a;--dca-5:#d17208;--dca-6:#9a4c04/);
    assert.match(css, /body\.dark :is\(\.dca-diary,\.dca-records\)[^{]*\{[^}]*--dca-5:#f7931a;--dca-6:#ffad47/, 'on a dark page the biggest days are the brightest');
    for (const level of [5, 6]) { assert.match(css, new RegExp('\\.dca-cell\\[data-level="' + level + '"\\]')); }
    assert.match(css, /\.dca-diary-open\{/);
    assert.match(css, /\.dca-weekday\{[^}]*position:sticky/); assert.match(css, /\.dca-cell\.is-outside\{visibility:hidden\}/);
  });

  await check('the records list every buying day newest first, with totals and the price paid', () => {
    const model = api.normalize(DIARY), all = api.records(model, 'all');
    assert.deepEqual(all.map(day => api.formatDate(day.time)), ['2026-11-08', '2026-11-07', '2026-11-06', '2024-12-15', '2024-12-14']);
    assert.deepEqual(api.records(model, '2024').map(day => api.formatDate(day.time)), ['2024-12-15', '2024-12-14']);
    assert.equal(api.priceText(all[0]), '79,577', '20 USDT for 0.00025133 BTC'); assert.equal(api.priceText({ btc: 100, usdt: null }), '—');
    assert.equal(api.recordsSummary(all, '全部'), '全部 · 5 天 · 6 笔 · 累计买入 0.00609257 BTC · 约 400.00 USDT · 历史买入均价 65,654');
    assert.equal(api.recordsSummary([], '2025 年'), '2025 年 · 暂无定投记录');
    assert.equal(api.recordsSummary([{ time: 0, btc: 100, usdt: null, buys: null }], '全部'), '全部 · 1 天 · 累计买入 0.000001 BTC');
    const rows = api.recordRows(all.slice(0, 2), api.scale(model.days), D('2026-11-07'));
    assert.equal(rows, '<tr data-date="2026-11-08"><td><i class="dca-swatch" data-level="3"></i>2026-11-08<small>周日</small></td><td>0.00025133</td><td>20.00</td><td>79,577</td><td>1</td></tr>' +
      '<tr data-date="2026-11-07" class="is-selected"><td><i class="dca-swatch" data-level="3"></i>2026-11-07<small>周六</small></td><td>0.00024574</td><td>20.00</td><td>81,387</td><td>1</td></tr>');
  });

  // ---------- the panel on a fake DOM ----------
  function harness(options = {}) {
    const nodes = new Map(), timers = new Map(), requests = [], responses = [...(options.responses || [])]; let nextTimer = 0;
    class Node {
      constructor(id) { this.id = id; this.hidden = false; this.textContent = ''; this.title = ''; this._innerHTML = ''; this.listeners = {}; this.attrs = {}; this.dataset = {}; this.props = {}; this.style = { setProperty: (k, v) => { this.props[k] = v; } }; this.classList = { add() {}, remove() {} }; this.scrollLeft = 0; this.scrollWidth = 0; this.clientWidth = 0; }
      set innerHTML(value) { this._innerHTML = value; for (const match of value.matchAll(/\bid="([^"]+)"/g)) if (!nodes.has(match[1])) nodes.set(match[1], new Node(match[1])); }
      get innerHTML() { return this._innerHTML; }
      get firstChild() { return this._first ??= { textContent: '' }; }
      get lastChild() { return this._last ??= { textContent: '' }; }
      setAttribute(key, value) { this.attrs[key] = String(value); }
      getAttribute(key) { return this.attrs[key] ?? null; }
      querySelector() { return null; }
      contains() { return false; }
      addEventListener(event, handler) { (this.listeners[event] ??= []).push(handler); }
      removeEventListener(event, handler) { this.listeners[event] = (this.listeners[event] || []).filter(fn => fn !== handler); }
      async fire(event, detail = {}) { for (const handler of this.listeners[event] || []) handler({ target: this, ...detail }); for (let i = 0; i < 5; i++) await new Promise(setImmediate); }
    }
    nodes.set('dcaDiaryPanel', new Node('dcaDiaryPanel')); nodes.set('walletPage', new Node('walletPage')); nodes.get('walletPage').hidden = !!options.hidden;
    const document = new Node('document'); document.hidden = false; document.getElementById = id => nodes.get(id) || null;
    const root = new Node('root'); root.document = document; root.AbortController = class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } };
    const setTimeout = (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout = id => timers.delete(id);
    async function fetch(url, init) { requests.push({ url, init }); const value = responses.length ? responses.shift() : structuredClone(DIARY); if (value instanceof Error) throw value; return { ok: value.ok !== false, json: async () => value }; }
    const candleState = {opened:false,model:null,date:null,updates:0,destroyed:false};
    const candles = {open(model,date){candleState.opened=true;candleState.model=model;candleState.date=date;},close(){candleState.opened=false;},updateBuys(model){candleState.model=model;candleState.updates++;},destroy(){candleState.opened=false;candleState.destroyed=true;},isOpen:()=>candleState.opened};
    const controller = api.mount({ root, document, fetch, setTimeout, clearTimeout, now: () => NOW, candles });
    const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
    async function tick() { const timer = [...timers].find(([, value]) => value.delay === api.REFRESH_MS); assert.ok(timer, 'a refresh is scheduled'); timers.delete(timer[0]); timer[1].fn(); await settle(); }
    return { node: id => nodes.get(id), requests, timers, controller, settle, tick, document, root, candleState };
  }

  await check('the panel reads the diary once, draws it and refreshes every thirty seconds', async () => {
    assert.equal(api.REFRESH_MS, 30000);
    const h = harness(); await h.settle();
    assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, '/api/wallet/btc-dca-diary');
    assert.equal(h.requests[0].init.cache, 'no-store'); assert.equal(h.requests[0].init.method, 'GET');
    assert.equal(h.node('dcaDiarySince').textContent, '自 2024-12-14 起 · 5 天 · 累计买入 0.00609257 BTC');
    assert.match(h.node('dcaDiarySince').title, /首笔买入 2024-12-14；累计买入 6 笔，约 400\.00 USDT/);
    assert.equal(h.node('dcaDiarySummary').textContent, '近一年买入 3 天 · 0.00069707 BTC · 最长连续 3 天 · 当前连续 3 天');
    assert.match(h.node('dcaDiarySummary').title, /约 60\.00 USDT/);
    assert.match(h.node('dcaDiaryRange').innerHTML, /data-range="recent" aria-pressed="true">近一年/); assert.match(h.node('dcaDiaryRange').innerHTML, /data-range="2024"/);
    assert.equal(h.node('dcaDiaryGrid').props['--weeks'], '53'); assert.match(h.node('dcaDiaryGrid').innerHTML, /data-date="2026-11-08"/);
    assert.equal(h.node('dcaDiaryMessage').hidden, true);
    assert.match(h.node('dcaDiaryGrid').attrs['aria-label'], /近一年买入 3 天/);
    await h.tick(); assert.equal(h.requests.length, 2);
  });

  await check('merged diary names both venues and removes an obsolete scope after a change', async () => {
    const merged = structuredClone(DIARY); merged.venues = ['okx','binance'];
    const h = harness({responses:[merged,structuredClone(DIARY)]}); await h.settle();
    assert.match(h.node('dcaDiarySince').textContent, /^欧易 \+ 币安 · 自 2024-12-14/);
    await h.tick(); assert.doesNotMatch(h.node('dcaDiarySince').textContent, /币安/);
  });

  await check('all and annual records use precise server buy totals and identify their historical purchase basis', async () => {
    // Each daily display has already rounded to 0.001 BTC / 79.70 USDT.
    // Their exact fills were 0.0010000049 BTC / 79.7049 USDT, so adding the
    // rounded days would lose a satoshi and a cent and change the average.
    const price = '79704.509447903705271844';
    const precise = {...structuredClone(DIARY), days:[['2024-12-14','0.001','79.70',1],['2026-11-07','0.001','79.70',1],['2026-11-08','0.001','79.70',1]],
      exact_totals:{btc:'0.0030000147',usdt:'239.1147',average_buy_price:price,buys:3,days:3},
      exact_periods:{'2024':{btc:'0.0010000049',usdt:'79.7049',average_buy_price:price,buys:1,days:1},'2026':{btc:'0.0020000098',usdt:'159.4098',average_buy_price:price,buys:2,days:2}}};
    const h = harness({responses:[precise]}); await h.settle();
    assert.equal(h.node('dcaDiarySince').textContent, '自 2024-12-14 起 · 3 天 · 累计买入 0.00300001 BTC');
    assert.match(h.node('dcaDiarySince').title, /239\.11 USDT/);
    assert.match(h.node('dcaDiarySince').title, /不扣历史卖出/);
    h.controller.open();
    assert.equal(h.candleState.opened,true);
    assert.equal(h.candleState.model.exactTotals.usdt,'239.1147');
    const m=h.candleState.model;
    assert.equal(api.recordsSummary(api.records(m,'all'),'全部',m.exactTotals),'全部 · 3 天 · 3 笔 · 累计买入 0.00300001 BTC · 约 239.11 USDT · 历史买入均价 79,705');
    assert.equal(api.recordsSummary(api.records(m,'2026'),'2026 年',m.exactPeriods['2026']),'2026 年 · 2 天 · 2 笔 · 累计买入 0.00200001 BTC · 约 159.41 USDT · 历史买入均价 79,705');
    assert.doesNotMatch(h.node('dcaDiaryPanel').innerHTML,/<table|dcaRecords/,'the popup is now a separate candlestick chart');
    h.controller.select('2026');
    assert.match(h.node('dcaDiarySummary').textContent, /^2026 年买入 2 天 · 0\.00200001 BTC/);
    assert.match(h.node('dcaDiarySummary').title, /159\.41 USDT/);
    assert.equal(api.priceText({btc:100000,usdt:7970}), '79,700', 'a daily row keeps its own daily purchase price');
  });

  await check('unpriced or invalid precise summaries never invent an average and legacy payloads still work', async () => {
    const unpriced = {...structuredClone(DIARY),exact_totals:{btc:'0.00609257',usdt:null,average_buy_price:null,buys:6,days:5}};
    const h = harness({responses:[unpriced]}); await h.settle();h.controller.open();
    const m=h.candleState.model;assert.equal(api.recordsSummary(api.records(m,'all'),'全部',m.exactTotals),'全部 · 5 天 · 6 笔 · 累计买入 0.00609257 BTC');
    const invalid = {...structuredClone(DIARY),exact_totals:{btc:'-1',usdt:'0',average_buy_price:'0',buys:6,days:5},exact_periods:{'2026':{btc:'1',usdt:'0',average_buy_price:'NaN',buys:1,days:1},'<img>':{btc:'1',usdt:'0',average_buy_price:'0',buys:1,days:1}}};
    const model = api.normalize(invalid);
    assert.equal(model.exactTotals, null);assert.deepEqual(model.exactPeriods, {});
    assert.match(api.recordsSummary(api.records(model,'all'),'全部',model.exactTotals), /历史买入均价 65,654$/);
  });

  await check('choosing a year redraws the board for that year', async () => {
    const h = harness(); await h.settle();
    await h.node('dcaDiaryRange').fire('click', { target: { closest: () => ({ dataset: { range: '2024' } }) } });
    assert.match(h.node('dcaDiarySummary').textContent, /^2024 年买入 2 天 · 0\.0053955 BTC · 最长连续 2 天$/);
    assert.match(h.node('dcaDiarySummary').title, /约 340\.00 USDT/);
    assert.match(h.node('dcaDiaryRange').innerHTML, /data-range="2024" aria-pressed="true"/);
    assert.match(h.node('dcaDiaryGrid').innerHTML, /data-date="2024-12-14"/);
    h.controller.select('nonsense'); assert.match(h.node('dcaDiaryRange').innerHTML, /data-range="recent" aria-pressed="true"/);
  });

  await check('a failed refresh keeps the last diary and says so; an unavailable ledger explains why', async () => {
    const h = harness({ responses: [structuredClone(DIARY), new Error('offline')] }); await h.settle(); await h.tick();
    assert.match(h.node('dcaDiarySummary').textContent, /近一年买入 3 天/);
    assert.equal(h.node('dcaDiaryMessage').hidden, false); assert.match(h.node('dcaDiaryMessage').textContent, /保留上次的定投记录/);
    const empty = harness({ responses: [{ status: 'unavailable', error: '当前账户尚未导入已核验的历史成本。', start_date: '2024-12-14', today: '2026-11-09', days: [], fields: ['date', 'btc', 'usdt', 'buys'] }] }); await empty.settle();
    assert.equal(empty.node('dcaDiaryMessage').textContent, '当前账户尚未导入已核验的历史成本。'); assert.equal(empty.node('dcaDiarySince').textContent, '自 2024-12-14 起');
    assert.equal(empty.node('dcaDiarySummary').textContent, '等待成本账本');
    const gap = harness({ responses: [{ ...structuredClone(DIARY), coverage_start_date: '2025-01-01' }] }); await gap.settle();
    assert.match(gap.node('dcaDiaryMessage').textContent, /成本账本自 2025-01-01 起/);
    const bad = harness({ responses: [{ status: 'fresh', days: 'nope' }] }); await bad.settle();
    assert.match(bad.node('dcaDiaryMessage').textContent, /暂时无法读取/);
  });

  await check('the heading opens the K-line chart and a calendar day locates that date without changing the heatmap', async () => {
    const h=harness();await h.settle();const panel=h.node('dcaDiaryPanel'),before=h.node('dcaDiaryGrid').innerHTML;
    assert.equal(h.candleState.opened,false);
    await panel.fire('click',{target:{closest:selector=>selector==='#dcaDiaryOpen'?{}:null}});
    assert.equal(h.candleState.opened,true);assert.equal(h.candleState.date,null);assert.equal(h.node('dcaDiaryGrid').innerHTML,before);
    h.controller.close();
    await panel.fire('click',{target:{closest:selector=>selector.includes('dca-cell')?{dataset:{date:'2024-12-14'}}:null}});
    assert.equal(h.candleState.opened,true);assert.equal(h.candleState.date,'2024-12-14');
    h.controller.close();await panel.fire('click',{target:{closest:selector=>selector.startsWith('button')?{}:null}});
    assert.equal(h.candleState.opened,false,'range controls keep their existing role');
    await h.node('dcaDiaryGrid').fire('keydown',{key:'Enter',preventDefault(){}});assert.equal(h.candleState.opened,true);
    h.node('walletPage').hidden=true;await h.root.fire('hashchange');assert.equal(h.candleState.opened,false);
  });
  await check('B-marker inputs use unrounded daily fills and account replacement clears old purchases',async()=>{
    const first={...structuredClone(DIARY),connection_id:'account-a',exact_days:{'2024-12-14':{btc:'0.005200891234',usdt:'320.004456',buys:2}}};
    const second={status:'unavailable',connection_id:'account-b',start_date:'2024-12-14',today:'2026-11-09',days:[]};
    const h=harness({responses:[first,second]});await h.settle();h.controller.open();
    const day=h.candleState.model.days.get(D('2024-12-14'));assert.equal(day.exactBTC,'0.005200891234');assert.equal(day.exactUSDT,'320.004456');
    await h.tick();assert.equal(h.candleState.model.connectionId,'account-b');assert.equal(h.candleState.model.days.size,0);
  });

  await check('a hidden wallet page reads nothing until it is shown; destroy removes every listener', async () => {
    const h = harness({ hidden: true }); await h.settle();
    assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0);
    h.node('walletPage').hidden = false; await h.root.fire('hashchange'); assert.equal(h.requests.length, 1);
    h.controller.destroy();
    for (const node of [h.document, h.root, h.node('dcaDiaryGrid'), h.node('dcaDiaryRange'), h.node('dcaDiaryPanel')]) for (const list of Object.values(node.listeners)) assert.equal(list.length, 0);
    assert.equal(h.candleState.destroyed,true);assert.equal(api.mount({ root: {}, document: { getElementById: () => null } }), null);
  });

  console.log(checks + ' DCA diary checks passed');
})().catch(error => { console.error(error); process.exit(1); });
