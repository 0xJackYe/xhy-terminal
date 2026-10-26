"use strict";

// Public fixtures only. Margin expectations are expanded from Binance's
// signed Call OTM definition, independent of the engine's shared helper.
const assert = require("node:assert/strict");
const engine = require("./dashboard/dist/sell-put-engine.js");
const NOW = Date.parse("2030-01-01T00:00:00Z"), DAY = 86400000;
let checks = 0;
function test(name, run) {run(); checks++; console.log("OK sell-call: " + name);}
function near(actual, expected, tolerance = 1e-8) {
  assert.ok(Number.isFinite(actual), "nonfinite result " + actual);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}
function fixture(overrides = {}) {
  const fields = ["bid_price", "ask_price", "bid_quantity", "ask_quantity", "mark_price", "mark_iv"];
  const row = {symbol: "BTC-300116-98000-C", side: "CALL", status: "TRADING", unit: 1, quote_asset: "USDT",
    strike_price: 98000, expiry_ms: NOW + 15 * DAY, min_qty: .01, max_qty: 200, quantity_step: .01, quantity_scale: 2,
    initial_margin_rate: .15, min_initial_margin_rate: .1, maintenance_margin_rate: .075,
    min_maintenance_margin_rate: .05, liquidation_fee_rate: .0019,
    bid_price: 65, ask_price: 70, bid_quantity: 10, ask_quantity: 10, mark_price: 65, mark_iv: .6,
    delta: .04, gamma: .00001, vega: 12, theta: -3, quote_source: "websocket", quote_updated_at: NOW,
    mark_source: "websocket", mark_updated_at: NOW,
    field_updated_at: Object.fromEntries(fields.map(field => [field, NOW])),
    field_source: Object.fromEntries(fields.map(field => [field, "websocket"])), ...overrides};
  return {options: [row], btc_index_price: 80000, index_updated_at: NOW, index_source: "websocket",
    catalog_updated_at: NOW, exchange_clock_offset_ms: 0};
}
function entry(settings = {}, overrides = {}) {
  const result = engine.evaluateCall(fixture(overrides), settings, NOW);
  assert.deepEqual(result.issues, [], "invalid test settings");
  assert.equal(result.rows.length, 1, "fixture must pass selected screening");
  return result.rows[0];
}

test("Call API is explicit and default Put evaluation stays isolated", () => {
  const source = fixture(), before = JSON.stringify(source);
  assert.equal(engine.evaluate(source, {}, NOW).rows.length, 0);
  const explicit = engine.evaluate(source, {}, NOW, "CALL"), named = engine.evaluateCall(source, {}, NOW);
  const selected = engine.evaluate(source, {side: "CALL"}, NOW);
  assert.equal(explicit.side, "CALL"); assert.equal(explicit.rows[0].side, "CALL");
  assert.deepEqual(explicit, named); assert.equal(selected.rows[0].metrics.quantity, explicit.rows[0].metrics.quantity);
  assert.equal(engine.evaluate(source, {side: "CALL"}, NOW, "PUT").rows.length, 0);
  assert.equal(JSON.stringify(source), before);
});
test("defaults mirror 20-25 percent OTM with upward shocks and never mutate Put defaults", () => {
  assert.equal(engine.DEFAULTS.minStrikeRatio, .75); assert.equal(engine.DEFAULTS.maxStrikeRatio, .8);
  assert.deepEqual(engine.DEFAULTS.stressMoves, [-.1, -.2, -.3]);
  assert.equal(engine.CALL_DEFAULTS.minStrikeRatio, 1.2); assert.equal(engine.CALL_DEFAULTS.maxStrikeRatio, 1.25);
  assert.deepEqual(engine.CALL_DEFAULTS.stressMoves, [.1, .2, .3]);
  const result = engine.normalizeSettings({}, "CALL"); assert.deepEqual(result.issues, []);
  assert.equal(result.settings.minStrikeRatio, 1.2); assert.equal(result.settings.maxStrikeRatio, 1.25);
});
test("Call filters include both exact strike and expiry boundaries", () => {
  for (const strike_price of [96000, 100000]) for (const days of [10, 20]) {
    const result = engine.evaluateCall(fixture({strike_price, expiry_ms: NOW + days * DAY}), {}, NOW);
    assert.equal(result.rows.length, 1); assert.equal(result.rows[0].issue, null);
  }
  for (const patch of [{strike_price: 95999}, {strike_price: 100001}, {expiry_ms: NOW + 9.99 * DAY},
    {expiry_ms: NOW + 20.01 * DAY}, {expiry_ms: NOW}, {side: "PUT", symbol: "BTC-300116-98000-P"}]) {
    assert.equal(engine.evaluateCall(fixture(patch), {}, NOW).rows.length, 0);
  }
});
test("invalid sides and nonfinite, inverted or ITM strike ranges are rejected", () => {
  assert.ok(engine.evaluate(fixture(), {}, NOW, "OTHER").issues.length);
  for (const update of [{minStrikeRatio: .9}, {maxStrikeRatio: 1.1}, {minStrikeRatio: NaN},
    {maxStrikeRatio: Infinity}, {minStrikeRatio: 1.3, maxStrikeRatio: 1.2}]) {
    assert.ok(engine.normalizeSettings(update, "CALL").issues.length, JSON.stringify(update));
  }
});
test("1000 USDT supports .12 using Call signed OTM, not the Put OTM direction", () => {
  const e = entry(), m = e.metrics; assert.equal(e.issue, null);
  near(m.quantity, .12); near(m.orderMargin, (8000 + 6.5) * .12); near(m.positionMargin, (8000 + 65) * .12);
  near(m.grossPremium, 7.8); near(m.entryFee, .78); near(m.netPremium, 7.02);
  near(m.adjustedEquity, 1007.02); near(m.equity, 999.22);
});
test("near-ATM Call margin subtracts K minus S before applying its minimum", () => {
  const m = entry({minStrikeRatio: 1, maxStrikeRatio: 1.3}, {strike_price: 82000}).metrics;
  near(m.quantity, .09); near(m.orderMargin, (12000 - 2000 + 6.5) * .09);
  near(m.positionMargin, (12000 - 2000 + 65) * .09);
});
test("maintenance includes Call OTM floor and exactly one liquidation reserve", () => {
  const m = entry().metrics, expected = (Math.max(4000, 6000 - 18000) + 65 + 152) * .12;
  near(m.maintenanceMargin, expected); near(m.marginRatio, expected / 1007.02);
  assert.notEqual(m.marginRatio, expected / m.equity);
});
test("an ITM upward stress uses full Call maintenance rate rather than Put OTM discount", () => {
  const e = entry({quantityMode: "manual", quantity: .1, stressMoves: [.3], stressElapsedDays: 0, stressVols: [.6]});
  const p = e.stress[0]; near(p.spot, 104000);
  near(p.maintenanceMargin, (7800 + p.mark + 197.6) * .1);
});
test("three return denominators distinguish spot notional reference from cash cover", () => {
  const m = entry().metrics;
  near(m.accountAnnualPct, 7.02 / 1000 / 15 * 365 * 100);
  near(m.orderAnnualPct, 7.02 / m.orderMargin / 15 * 365 * 100);
  near(m.notionalCapital, 80000 * .12);
  near(m.notionalDailyPct, 7.02 / (80000 * .12) / 15 * 100);
  near(m.notionalAnnualPct, m.notionalDailyPct * 365);
  assert.equal(m.capitalBasis, "spot_notional_reference");
  for (const field of ["cashDailyPct", "cashAnnualPct", "cashSecuredCapital", "cashSecuredQuantity"]) assert.equal(m[field], null);
});
test("unlimited maximum liability stays explicit after JSON cloning", () => {
  const e = entry(); assert.equal(e.metrics.maxExpiryLoss, Infinity); assert.equal(e.metrics.lossUnbounded, true);
  const stored = JSON.parse(JSON.stringify(e)); assert.equal(stored.metrics.lossUnbounded, true);
  assert.equal(stored.metrics.maxExpiryLoss, null); assert.equal(stored.metrics.capitalBasis, "spot_notional_reference");
  assert.ok(e.warnings.some(text => /亏损无上限/.test(text)));
});
test("cash secured mode cannot manufacture a finite naked Call payout ceiling", () => {
  const result = engine.evaluateCall(fixture(), {quantityMode: "cashSecured"}, NOW);
  assert.equal(result.rows.length, 0); assert.ok(result.issues.includes("裸卖Call无有限足额赔付模式"));
  const settings = {...engine.CALL_DEFAULTS, quantityMode: "cashSecured"};
  assert.equal(engine.analyzeCandidate(fixture(), fixture().options[0], settings, NOW).issue, "裸卖Call无有限足额赔付模式");
});
test("manual size, reserve and bid depth obey the original strict admission and lot rules", () => {
  assert.match(entry({quantityMode: "manual", quantity: .13}).issue, /保证金不足/);
  near(entry({reserve: 200}).metrics.quantity, .09);
  const depth = entry({}, {bid_quantity: .035}); near(depth.metrics.quantity, .03); near(depth.metrics.maxMarginQuantity, .12);
  assert.ok(depth.warnings.some(text => /深度/.test(text)));
  near(entry({}, {quantity_step: .05, min_qty: .05}).metrics.quantity, .1);
  assert.match(entry({quantityMode: "manual", quantity: .12}, {quantity_step: .05, min_qty: .05}).issue, /步长/);
});
test("exact initial-margin equality fails admission for maximum and manual sizes", () => {
  const balance = (8000 + 6.5) * .1;
  near(entry({balance}).metrics.quantity, .09);
  assert.match(entry({balance, quantityMode: "manual", quantity: .1}).issue, /保证金不足/);
});
test("all original balance reserve fee and quantity validation remains active", () => {
  for (const update of [{balance: 0}, {balance: ""}, {balance: Infinity}, {reserve: -1}, {reserve: 1000},
    {quantityMode: "manual", quantity: 0}, {quantityMode: "manual", quantity: ""}, {feeRate: ""},
    {exerciseFeeRate: null}, {feeCap: 1.01}, {stressVols: [5.01]}, {stressMoves: [-1]}]) {
    assert.ok(engine.evaluateCall(fixture(), update, NOW).issues.length, JSON.stringify(update));
  }
});
test("stale quote mark index catalog and incoherent books remain uncalculable", () => {
  for (const patch of [{bid_price: 0}, {bid_quantity: null}, {bid_quantity: .001}, {ask_price: 60},
    {quote_group_valid: false}, {unit: .1}, {status: "HALT"}, {quote_asset: "BTC"},
    {field_updated_at: {bid_price: NOW - 21000}}, {field_updated_at: {mark_price: NOW - 21000}},
    {field_updated_at: {mark_iv: NOW + 2001}}, {initial_margin_rate: undefined}]) {
    const e = entry({}, patch); assert.ok(e.issue, JSON.stringify(patch)); assert.equal(e.metrics, null);
  }
  for (const field of ["index_updated_at", "catalog_updated_at"]) {
    const snap = fixture(); snap[field] = NOW - 700000;
    assert.ok(engine.evaluateCall(snap, {}, NOW).rows[0].issue);
  }
});
test("Call quote upper bound is spot, not its larger strike", () => {
  assert.match(entry({}, {bid_price: 80000, ask_price: 80001, mark_price: 80000}).issue, /上界/);
  assert.match(entry({}, {mark_price: 80001}).issue, /标记价/);
});
test("signed short Call Greeks reverse API values and scale the chosen quantity", () => {
  const m = entry().metrics; near(m.entryDelta, -.04 * .12); near(m.entryGamma, -.00001 * .12);
  near(m.entryVega, -12 * .12); near(m.entryTheta, 3 * .12);
});
test("default stress matrix is three upward moves by three IV scenarios", () => {
  const e = entry(); assert.equal(e.stress.length, 9);
  assert.deepEqual([...new Set(e.stress.map(p => p.movePct))], [.1, .2, .3]);
  assert.deepEqual([...new Set(e.stress.map(p => p.vol))], [.6, .8, 1.2]);
  assert.ok(e.stress.every(p => p.spot > e.spot && Number.isFinite(p.pnl)));
});
test("zero shock anchors mark and close fee once; higher IV worsens short Call stress", () => {
  const e = entry({stressElapsedDays: 0, stressMoves: [0], stressVols: [.6, 1.2]}, {mark_price: 69});
  near(e.stress[0].mark, 69); near(e.stress[0].equity, e.metrics.equity);
  near(e.stress[0].pnl, e.metrics.netPremium - 69 * .12 - 6.9 * .12);
  assert.ok(e.stress[1].mark > e.stress[0].mark); assert.ok(e.stress[1].pnl < e.stress[0].pnl);
});
test("upward ITM stress price stays between intrinsic and spot, with finite margin state", () => {
  const e = entry({stressMoves: [.1, .2, .3], stressVols: [.6, 1.2, 5]});
  for (const p of e.stress) {
    assert.ok(p.mark >= Math.max(p.spot - e.strike, 0)); assert.ok(p.mark <= p.spot);
    assert.ok(Number.isFinite(p.maintenanceMargin)); assert.ok(Number.isFinite(p.marginRatio));
  }
});
test("expiry cash uses Call intrinsic and exercised-option fee, releasing ongoing margin", () => {
  const e = entry({quantityMode: "manual", quantity: .1, stressElapsedDays: 15, stressMoves: [.25], stressVols: [.6, 1.2]});
  for (const p of e.stress) {
    near(p.mark, 2000); near(p.closingFee, 1.5); near(p.pnl, 5.85 - 200 - 1.5);
    assert.equal(p.state, "settled"); near(p.maintenanceMargin, 0); near(p.marginRatio, 0);
  }
});
test("OTM and ATM expiry have zero liability and zero exercise fees", () => {
  const e = entry({quantityMode: "manual", quantity: .1});
  for (const settlement of [0, 90000, 98000]) {
    const cash = engine.expiryCash(e, settlement); near(cash.fee, 0); near(cash.pnl, 5.85);
  }
});
test("exercise cap and uncapped branch match independent cash arithmetic", () => {
  const e = entry({quantityMode: "manual", quantity: .1});
  const nearStrike = engine.expiryCash(e, 98001); near(nearStrike.fee, .01); near(nearStrike.pnl, 5.74);
  const farITM = engine.expiryCash(e, 120000); near(farITM.fee, 1.8); near(farITM.pnl, 5.85 - 2200 - 1.8);
  assert.ok(engine.expiryCash(e, 1e9).pnl < -1e7, "liability is not capped by strike times quantity or wallet");
});
test("Call break-even solves both exercise-fee branches", () => {
  const capped = entry({quantityMode: "manual", quantity: .1});
  near(capped.metrics.breakEven, 98000 + 58.5 / 1.1);
  near(engine.expiryCash(capped, capped.metrics.breakEven).pnl, 0);
  const uncapped = entry({quantityMode: "manual", quantity: .1}, {bid_price: 1000, ask_price: 1010, mark_price: 1000});
  near(uncapped.metrics.breakEven, (98000 + 980.8) / 1.00015);
  near(engine.expiryCash(uncapped, uncapped.metrics.breakEven).pnl, 0);
});
test("expiry filters use calibrated exchange time and exclude an already expired Call", () => {
  const snap = fixture({expiry_ms: NOW + 1000}); snap.exchange_clock_offset_ms = 2000;
  assert.equal(engine.evaluateCall(snap, {minDays: 0}, NOW).rows.length, 0);
});
test("r=0 Call pricing respects deterministic limits and put-call parity", () => {
  near(engine.callPrice(100, 100, 1, .2), 7.965567455405804, 1e-12);
  for (const [s, k, years, vol] of [[80000, 98000, 15 / 365, .6], [80000, 60000, .5, 1.2], [100, 120, 0, .8], [100, 90, 1, 0]]) {
    near(engine.callPrice(s, k, years, vol) - engine.putPrice(s, k, years, vol), s - k, 1e-8);
  }
  assert.equal(engine.callPrice(100, 120, 0, .6), 0); assert.equal(engine.callPrice(100, 90, 1, 0), 10);
});
// Direct Simpson integration of the lognormal Call payoff is independent of
// the production BS / normal-CDF implementation and its duality shortcut.
function integratedCall(spot, strike, years, vol) {
  const v = vol * Math.sqrt(years), boundary = (Math.log(strike / spot) + v * v / 2) / v;
  const lo = Math.max(-14, boundary), hi = 14, n = 40000;
  if (lo >= hi) return 0;
  const h = (hi - lo) / n;
  const f = z => Math.max(spot * Math.exp(-v * v / 2 + v * z) - strike, 0) * Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  let sum = f(lo) + f(hi);
  for (let i = 1; i < n; i++) sum += (i % 2 ? 4 : 2) * f(lo + i * h);
  return sum * h / 3;
}
test("Call prices match independent Gaussian-payoff integration including far OTM tails", () => {
  for (const [s, k, days, vol] of [[80000, 98000, 15, .6], [80000, 60000, 15, .6], [1, 1.25, 12, .66], [1, 2, 15, .6], [100, 100, 90, 1.2]]) {
    const expected = integratedCall(s, k, days / 365, vol);
    near(engine.callPrice(s, k, days / 365, vol), expected, Math.max(1e-12, expected * 1e-9));
  }
  assert.ok(engine.callPrice(1, 2, 15 / 365, .6) > 0);
});
test("Call pricing rejects unsupported or overflowing inputs", () => {
  for (const args of [[0, 100, 1, .2], [100, 0, 1, .2], [100, 100, -1, .2], [100, 100, 1, 5.1], [Infinity, 100, 1, .2]]) {
    assert.throws(() => engine.callPrice(...args), RangeError);
  }
});
console.log(`${checks} sell-call engine checks passed.`);
