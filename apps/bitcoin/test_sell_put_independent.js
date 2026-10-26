"use strict";

// Independent public-data fixtures and direct Gaussian-payoff quadrature.
// No account access, network requests, application startup, or engine edits.
const assert = require("node:assert/strict");
const engine = require("./dashboard/dist/sell-put-engine.js");
const DAY = 86400000;
const NOW = Date.parse("2026-10-18T08:00:00Z");
let passed = 0, failed = 0;
function check(name, callback) {
  try { callback(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}
function near(actual, expected, tolerance = 1e-8) {
  assert.ok(Number.isFinite(actual), `nonfinite result: ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${actual} differs from independent expectation ${expected}`);
}
function fixture(overrides = {}) {
  const fields = ["bid_price", "ask_price", "bid_quantity", "ask_quantity", "mark_price", "mark_iv"];
  const row = {symbol: "BTC-261102-65000-P", side: "PUT", status: "TRADING", unit: 1,
    quote_asset: "USDT", strike_price: "65000", expiry_ms: NOW + 15 * DAY,
    expiry_beijing: new Date(NOW + 15 * DAY).toISOString(),
    bid_price: "65", ask_price: "70", bid_quantity: "63.5", ask_quantity: "18.8",
    mark_price: "65", mark_iv: ".6", quote_source: "websocket", mark_source: "websocket",
    quote_updated_at: NOW, mark_updated_at: NOW,
    field_updated_at: Object.fromEntries(fields.map(field => [field, NOW])),
    field_source: Object.fromEntries(fields.map(field => [field, "websocket"])),
    initial_margin_rate: ".15", min_initial_margin_rate: ".1",
    maintenance_margin_rate: ".075", min_maintenance_margin_rate: ".05",
    liquidation_fee_rate: ".0019", min_qty: ".01", max_qty: "100", quantity_step: ".01",
    quantity_scale: 2, delta: "-.04", gamma: ".00001", vega: "12", theta: "-3",
    ...overrides};
  return {btc_index_price: "81400", index_updated_at: NOW, index_source: "websocket",
    exchange_clock_offset_ms: 0, catalog_updated_at: NOW,
    fetched_at: new Date(NOW).toISOString(), options: [row]};
}
function analyze(settings = {}, row = {}) {
  const result = engine.evaluate(fixture(row), settings, NOW);
  assert.deepEqual(result.issues, []);
  assert.equal(result.rows.length, 1);
  const entry = result.rows[0];
  assert.equal(entry.issue, null);
  assert.ok(entry.metrics);
  return entry;
}

// Evaluate E[(K-S*exp(-v^2/2+vZ))_+] directly by Simpson integration.
// This uses neither the engine's normal CDF nor a second BS implementation.
function integratedPut(spot, strike, years, vol) {
  if (years === 0 || vol === 0) return Math.max(strike - spot, 0);
  const v = vol * Math.sqrt(years);
  const boundary = (Math.log(strike / spot) + v * v / 2) / v;
  const lower = -14, upper = Math.min(14, boundary);
  if (upper <= lower) return 0;
  const steps = 30000, h = (upper - lower) / steps;
  const integrand = z => Math.max(strike - spot * Math.exp(-v * v / 2 + v * z), 0)
    * Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  let sum = integrand(lower) + integrand(upper);
  for (let index = 1; index < steps; index++) sum += (index % 2 ? 4 : 2) * integrand(lower + h * index);
  return sum * h / 3;
}

check("put prices agree with independently integrated terminal payoffs", () => {
  for (const [spot, strike, days, vol] of [[1,.75,15,.6], [1,.8,15,.6],
    [81400,65000,15,.6], [68000,65000,14,1.2], [50000,65000,7,.8],
    [1,1,365,.2], [100,10,365,.2], [1,.8,730,5]]) {
    const expected = integratedPut(spot, strike, days / 365, vol);
    near(engine.putPrice(spot, strike, days / 365, vol), expected,
      Math.max(2e-11, Math.abs(expected) * 2e-9));
  }
});
check("zero time and zero volatility respect deterministic intrinsic value", () => {
  near(engine.putPrice(50000,65000,0,.6),15000);
  near(engine.putPrice(81400,65000,1,0),0);
  near(engine.putPrice(50000,65000,1,0),15000);
});
check("1000 cash admits .12 rather than .01 and credits premium once", () => {
  const m = analyze().metrics;
  near(m.quantity,.12); near(m.grossPremium,7.8); near(m.entryFee,.78); near(m.netPremium,7.02);
  near(m.orderMargin,977.58); near(m.positionMargin,984.6);
  near(m.adjustedEquity,1007.02); near(m.equity,999.22); near(m.availableAfterEntry,22.42);
});
check("maintenance includes liquidation reserve and uses AE rather than MTM equity", () => {
  const m = analyze().metrics;
  near(m.maintenanceMargin,514.7592);
  near(m.marginRatio,514.7592 / 1007.02);
  assert.ok(Math.abs(m.marginRatio - 514.7592 / 999.22) > .001);
});
check("cash and account income denominators remain explicitly different", () => {
  const full = analyze().metrics, small = analyze({quantityMode:"manual",quantity:.1}).metrics;
  near(full.cashSecuredCapital,7800); near(small.cashSecuredCapital,6500);
  near(full.accountAnnualPct,17.082); near(full.cashAnnualPct,2.19);
  near(small.accountAnnualPct,14.235); near(small.cashAnnualPct,2.19);
  near(full.entryDelta,.0048); near(full.entryGamma,-.0000012);
  near(full.entryVega,-1.44); near(full.entryTheta,.36);
});
check("depth and manual reserves limit quantity independently", () => {
  near(analyze({}, {bid_quantity: ".055"}).metrics.quantity,.05);
  near(analyze({reserve:100}).metrics.quantity,.11);
  const result=engine.evaluate(fixture(), {quantityMode:"manual",quantity:.13}, NOW);
  assert.equal(result.rows[0].metrics,null);
  assert.match(result.rows[0].issue,/保证金不足/);
});
check("mark-minus-order-price is retained when mark is different", () => {
  // A distinct reference mark within the quote verification policy still must
  // retain the 10 USDT/BTC mark-minus-entry-price basis in initial margin.
  const m=analyze({}, {mark_price:"75"}).metrics;
  near(m.orderMargin,978.78); near(m.positionMargin,985.8);
  near(m.equity,998.02); near(m.adjustedEquity,1007.02);
});
check("zero-shock mark is anchored and mark equity excludes hypothetical close fees", () => {
  const entry=analyze({stressElapsedDays:0,stressMoves:[0],stressVols:[.6]});
  const point=entry.stress[0];
  near(point.mark,65); near(point.equity,999.22);
  near(point.pnl,-1.56); near(point.closingFee,.78);
  near(point.equity,1000+point.pnl+point.closingFee);
});
check("independent quadrature verifies joint price-IV-time repricing", () => {
  const futureSpot=68000, futureVol=1.2;
  const entry=analyze({stressElapsedDays:1,stressMoves:[futureSpot/81400-1],stressVols:[futureVol]});
  const point=entry.stress[0];
  const reference=65+integratedPut(futureSpot,65000,14/365,futureVol)
    -integratedPut(81400,65000,15/365,.6);
  const expectedMark=Math.max(0,Math.min(65000,reference));
  near(point.mark,expectedMark,2e-6);
  near(point.adjustedEquity,1007.02);
  near(point.pnl,7.02-point.mark*.12-Math.min(.00024*68000,.1*point.mark)*.12,2e-7);
});
check("expiry is cash settlement with zero continuing maintenance", () => {
  const entry=analyze({stressElapsedDays:15,stressMoves:[50000/81400-1],stressVols:[.6,1.2]});
  for(const point of entry.stress) {
    near(point.pnl,-1793.88); near(point.closingFee,.9);
    near(point.maintenanceMargin,0); near(point.equity,-793.88);
    assert.equal(point.state,"settled"); assert.equal(point.settled,true);
  }
});
check("breakeven includes exercise fee and maximum obligation is not capped at wallet", () => {
  const entry=analyze();
  near(engine.expiryCash(entry,entry.metrics.breakEven).pnl,0,2e-8);
  near(entry.metrics.maxExpiryLoss,7792.98);
  near(engine.expiryCash(entry,0).pnl,-7792.98);
});
check("missing or stale margin inputs do not manufacture live capacity", () => {
  for(const row of [{initial_margin_rate:undefined},
    {field_updated_at:{mark_price:NOW-31000,mark_iv:NOW-31000}}]) {
    const entry=engine.evaluate(fixture(row),{},NOW).rows[0];
    assert.equal(entry.metrics,null); assert.ok(entry.issue);
  }
});

// Input/rounding audit cases intentionally expose unsafe silent coercion.
check("blank/non-numeric fee settings cannot silently become zero fees", () => {
  for(const update of [{feeRate:""},{feeCap:"not a number"},{exerciseFeeRate:null}]) {
    assert.ok(engine.normalizeSettings(update).issues.length>0, JSON.stringify(update));
  }
});
check("invalid stress settings cannot silently become a zero price shock", () => {
  assert.ok(engine.normalizeSettings({stressMoves:["bad"]}).issues.length>0);
  assert.ok(engine.normalizeSettings({stressVols:[null]}).issues.length>0);
});
check("scientific-notation quantity steps retain their decimal resolution", () => {
  near(engine.floorStep(.12345678,1e-7),.1234567,1e-12);
});
check("exact equality does not satisfy strictly-greater opening admission", () => {
  const entry=analyze({balance:977.58});
  near(entry.metrics.quantity,.11);
});
check("put premiums above maximum undiscounted payoff are rejected", () => {
  const result=engine.evaluate(fixture({bid_price:"65001",ask_price:"65005"}),{},NOW);
  assert.equal(result.rows[0].metrics,null);
  assert.ok(result.rows[0].issue);
});

console.log(`${passed} independent seller checks passed; ${failed} failed.`);
process.exitCode=failed?1:0;
