import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../frontend/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Unable to isolate shipped overview code: ${start}`);
  return source.slice(from, to);
}

// Use the shipped wallet renderer and formatters against IDs from the actual
// page. Only unrelated charts, balances and venue lists are stubbed out.
function harness() {
  class Element {
    constructor(id = '') { this.id = id; this.textContent = ''; this.className = ''; this.dataset = {}; this.title = ''; this.hidden = false; this.children = []; }
    get parentElement() { return this.parent ||= new Element(); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
  }
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element(id)]));
  const document = {
    getElementById(id) { assert.ok(elements.has(id), `Missing page element: ${id}`); return elements.get(id); },
    createElement() { return new Element(); },
  };
  const ui = runInNewContext([
    section('  const $ =', '  const views ='),
    'const local = false;',
    'const setModuleStatus = () => {}, renderTrend = () => {}, renderGoal = () => {}, renderLocations = () => {};',
    'const animateNumber = (id, value, digits) => text(id, fixed(value, digits));',
    section('  const assetName =', '  const tone ='),
    section('  const tone =', '  // Thirty days of the BTC held'),
    section('  function renderPriceChange(', '  // Progress towards 1 BTC'),
    '({ renderWallet });',
  ].join('\n'), { document, Intl }, { filename: 'overview-pnl-renderers.js' });
  return { render: ui.renderWallet, get: id => elements.get(id), text: id => elements.get(id).textContent };
}

function wallet(overrides = {}) {
  return {
    status: 'online', complete: true,
    conversionQuotes: { usd_cny: '7.2' },
    pnl: { averageCost: '58210.44', unrealized: '1250.5', returnPct: '12.5' },
    totalProfit: { profit_usdt: '-250.25', contributed_usdt: '10000', market_value_usdt: '9000', withdrawn_usdt: '749.75' },
    priceChange: { usd: '12.5', cny: '-19.37' },
    ...overrides,
  };
}

test('overview renders signed USD and CNY profit while preserving the ledger and returns', () => {
  const h = harness(), data = wallet(), before = JSON.stringify(data);
  h.render(data);
  assert.equal(h.text('wallet-unrealized'), '+$1,250.50');
  assert.equal(h.text('wallet-unrealized-cny'), '+¥9,003.60');
  assert.equal(h.text('wallet-total-profit'), '−$250.25');
  assert.equal(h.text('wallet-total-profit-cny'), '−¥1,801.80');
  assert.equal(h.get('wallet-unrealized').className, 'positive');
  assert.match(h.get('wallet-total-profit-cny').className, /negative/);
  assert.equal(h.text('wallet-avg-cost'), '58,210.44');
  assert.equal(h.text('wallet-return'), '+12.50%');
  assert.equal(h.text('wallet-total-return'), '-2.50%');
  for (const id of ['wallet-unrealized-cell', 'wallet-total-cell']) {
    assert.match(h.get(id).title, /1 USDT ≈ 1 USD/);
    assert.match(h.get(id).title, /人民币按当前美元兑人民币汇率换算/);
  }
  assert.equal(JSON.stringify(data), before, 'display conversion must not alter account figures');
});

test('zero profit remains a real zero in both currencies with no gain/loss tone', () => {
  const h = harness();
  h.render(wallet({ pnl: { unrealized: '0', returnPct: 0 }, totalProfit: { profit_usdt: 0, contributed_usdt: 100 }, priceChange: { usd: 0, cny: '0' } }));
  for (const id of ['wallet-unrealized', 'wallet-total-profit', 'wallet-price-change-value']) {
    assert.equal(h.text(id), '$0.00');
    assert.equal(h.text(`${id}-cny`), '¥0.00');
    assert.equal(h.get(id).className, '');
    assert.equal(h.get(`${id}-cny`).className, 'pnl-secondary');
  }
  assert.equal(h.text('wallet-return'), '0.00%');
  assert.equal(h.text('wallet-total-return'), '0.00%');
});

test('missing, zero or invalid FX clears previous CNY values without hiding USD', () => {
  const invalid = [undefined, null, '', ' ', ' 7.2', '7.2 ', '0x7', '0b111', '7e0', 0, '0', -7, 'invalid', NaN, Infinity, 'Infinity', true, [], [7], {}];
  for (const rate of invalid) {
    const h = harness();
    h.render(wallet());
    h.render(wallet({ conversionQuotes: { usd_cny: rate } }));
    assert.equal(h.text('wallet-unrealized'), '+$1,250.50');
    assert.equal(h.text('wallet-total-profit'), '−$250.25');
    for (const id of ['wallet-unrealized-cny', 'wallet-total-profit-cny']) {
      assert.equal(h.text(id), '—', `invalid FX ${String(rate)}`);
      assert.equal(h.get(id).className, 'pnl-secondary');
    }
    assert.match(h.get('wallet-unrealized-cell').title, /汇率暂不可用/);
    assert.equal(h.text('wallet-price-change-value-cny'), '−¥19.37', 'period CNY is independent of conversion FX');
  }
  const h = harness();
  h.render(wallet({ conversionQuotes: undefined }));
  assert.equal(h.text('wallet-unrealized-cny'), '—');
});

test('positive decimal FX accepts numeric values and decimal strings', () => {
  for (const rate of [7, '7', '7.00', '+7.0', '07.00', '7.', '.7']) {
    const h = harness();
    h.render(wallet({ conversionQuotes: { usd_cny: rate } }));
    assert.equal(h.text('wallet-unrealized-cny'), rate === '.7' ? '+¥875.35' : '+¥8,753.50');
  }
});

test('rounded zero has no sign or tone while each currency keeps its own result', () => {
  for (const tiny of [.004, -.004]) {
    const h = harness(), sign = tiny > 0 ? '+' : '−', css = tiny > 0 ? 'positive' : 'negative';
    h.render(wallet({
      pnl: { unrealized: tiny, returnPct: tiny },
      totalProfit: { profit_usdt: tiny, contributed_usdt: 1 },
      priceChange: { usd: tiny, cny: tiny > 0 ? .03 : -.03 },
    }));
    for (const id of ['wallet-unrealized', 'wallet-total-profit', 'wallet-price-change-value']) {
      assert.equal(h.text(id), '$0.00');
      assert.equal(h.get(id).className, '');
      assert.equal(h.text(`${id}-cny`), `${sign}¥0.03`);
      assert.equal(h.get(`${id}-cny`).className, `pnl-secondary ${css}`);
    }
    assert.equal(h.text('wallet-return'), tiny > 0 ? '+0.00%' : '-0.00%', 'percentage formatting is unchanged');
    h.render(wallet({ priceChange: { usd: tiny > 0 ? .03 : -.03, cny: tiny } }));
    assert.equal(h.text('wallet-price-change-value'), `${sign}$0.03`);
    assert.equal(h.get('wallet-price-change-value').className, css);
    assert.equal(h.text('wallet-price-change-value-cny'), '¥0.00');
    assert.equal(h.get('wallet-price-change-value-cny').className, 'pnl-secondary');
    assert.match(h.get('wallet-price-change').title, /人民币 ¥0.00/);
  }
});

test('half-cent amounts still round up with their original sign and tone', () => {
  for (const value of [.005, -.005]) {
    const h = harness(), sign = value > 0 ? '+' : '−', css = value > 0 ? 'positive' : 'negative';
    h.render(wallet({ priceChange: { usd: value, cny: value } }));
    assert.equal(h.text('wallet-price-change-value'), `${sign}$0.01`);
    assert.equal(h.text('wallet-price-change-value-cny'), `${sign}¥0.01`);
    assert.equal(h.get('wallet-price-change-value').className, css);
    assert.equal(h.get('wallet-price-change-value-cny').className, `pnl-secondary ${css}`);
  }
});

test('missing account figures stay unknown even when a conversion rate exists', () => {
  for (const missing of [undefined, null, '', NaN, Infinity]) {
    const h = harness();
    h.render(wallet());
    h.render(wallet({ pnl: { unrealized: missing, returnPct: missing }, totalProfit: { profit_usdt: missing, contributed_usdt: 100 } }));
    for (const id of ['wallet-unrealized', 'wallet-total-profit']) {
      assert.equal(h.text(id), '—');
      assert.equal(h.text(`${id}-cny`), '—');
      assert.equal(h.get(id).className, '');
    }
    assert.equal(h.text('wallet-return'), '');
    assert.equal(h.text('wallet-total-return'), '');
  }
  const h = harness();
  h.render({});
  for (const id of ['wallet-unrealized', 'wallet-total-profit', 'wallet-price-change-value']) {
    assert.equal(h.text(id), '—');
    assert.equal(h.text(`${id}-cny`), '—');
  }
  assert.doesNotMatch(h.get('wallet-total-cell').title, /。。/);
});

test('today preserves independent signs and CNY exchange-rate movement', () => {
  const h = harness();
  h.render(wallet());
  assert.equal(h.text('wallet-price-change-value'), '+$12.50');
  assert.equal(h.text('wallet-price-change-value-cny'), '−¥19.37');
  assert.equal(h.get('wallet-price-change-value').className, 'positive');
  assert.equal(h.get('wallet-price-change-value-cny').className, 'pnl-secondary negative');
  assert.match(h.get('wallet-price-change').title, /人民币 −¥19.37（含汇率变化）/);
  h.render(wallet({ priceChange: { usd: '-2.05', cny: '1.3' } }));
  assert.equal(h.text('wallet-price-change-value'), '−$2.05');
  assert.equal(h.text('wallet-price-change-value-cny'), '+¥1.30');
});

test('today can show either known currency without inventing the other one', () => {
  const h = harness();
  h.render(wallet({ priceChange: { usd: '12.5' } }));
  assert.equal(h.text('wallet-price-change-value'), '+$12.50');
  assert.equal(h.text('wallet-price-change-value-cny'), '—');
  h.render(wallet({ priceChange: { cny: '-4.1' } }));
  assert.equal(h.text('wallet-price-change-value'), '—');
  assert.equal(h.text('wallet-price-change-value-cny'), '−¥4.10');
  h.render(wallet({ priceChange: null }));
  assert.equal(h.text('wallet-price-change-value'), '—');
  assert.equal(h.text('wallet-price-change-value-cny'), '—');
  assert.equal(h.get('wallet-price-change-value-cny').className, 'pnl-secondary');
});

test('refresh recomputes conversion and recovers after FX becomes available', () => {
  const h = harness();
  h.render(wallet({ conversionQuotes: {} }));
  assert.equal(h.text('wallet-unrealized-cny'), '—');
  h.render(wallet({ conversionQuotes: { usd_cny: 7 } }));
  assert.equal(h.text('wallet-unrealized-cny'), '+¥8,753.50');
  h.render(wallet({ conversionQuotes: { usd_cny: '8' } }));
  assert.equal(h.text('wallet-unrealized-cny'), '+¥10,004.00');
  assert.equal(h.text('wallet-total-profit-cny'), '−¥2,002.00');
  assert.equal(h.text('wallet-price-change-value-cny'), '−¥19.37');
  assert.equal(h.text('wallet-return'), '+12.50%');
  assert.equal(h.text('wallet-total-return'), '-2.50%');
  h.render(wallet({ conversionQuotes: { usd_cny: Number.MAX_VALUE } }));
  assert.equal(h.text('wallet-unrealized-cny'), '—', 'overflow must not render Infinity or NaN');
});
