"use strict";

// Pure public fixtures, independent payout quadrature and hand-expanded
// fees/margins. No network, account keys, orders or production state.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const screen = require("./dashboard/dist/seller-screen-engine.js");
const NOW = Date.parse("2030-01-01T00:00:00Z"), DAY = 86400000;
let checks = 0;
function check(name, fn) {fn(); checks++; console.log("OK seller-screen: " + name);}
function near(actual, expected, tolerance = 1e-8) {assert.ok(Number.isFinite(actual)); assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);}
function row(strike = 62000, side = "PUT", premium = 65, patch = {}) {
  const names = ["bid_price", "ask_price", "bid_quantity", "ask_quantity", "mark_price", "mark_iv"];
  return {symbol: `BTC-300116-${strike}-${side === "PUT" ? "P" : "C"}`, side, strike_price: strike,
    expiry_ms: NOW + 15 * DAY, status: "TRADING", unit: 1, quote_asset: "USDT", min_qty: .01, max_qty: 100,
    quantity_step: .01, quantity_scale: 2, initial_margin_rate: .15, min_initial_margin_rate: .1,
    maintenance_margin_rate: .075, min_maintenance_margin_rate: .05, liquidation_fee_rate: .0019,
    bid_price: premium, ask_price: premium + 5, bid_quantity: 1, ask_quantity: 1, mark_price: premium, mark_iv: .6,
    quote_updated_at: NOW, quote_source: "websocket", mark_updated_at: NOW, mark_source: "websocket",
    field_updated_at: Object.fromEntries(names.map(name => [name, NOW])), field_source: Object.fromEntries(names.map(name => [name, "websocket"])), ...patch};
}
function snapshot(rows = [row()]) {return {options: rows, btc_index_price: 80000, index_updated_at: NOW, index_source: "websocket", catalog_updated_at: NOW, exchange_clock_offset_ms: 0};}
function evaluate(rows = [row()], input = {}, patch = {}) {return screen.evaluate({...snapshot(rows), ...patch}, input, NOW);}
function only(rows = [row()], input = {}, patch = {}) {const out = evaluate(rows, input, patch); assert.deepEqual(out.issues, []); assert.equal(out.candidates.length, 1, JSON.stringify(out.rejected)); return out.candidates[0];}
const rankingRows = () => [row(60000, "PUT", 30), row(62000, "PUT", 300), row(64000, "PUT", 320)];

check("defaults use the same fixed 0.1 size and manual 1000 balance in all modes", () => {
  assert.equal(screen.DEFAULTS.side, "PUT"); assert.equal(screen.DEFAULTS.mode, "balanced");
  for (const mode of ["risk", "balanced", "premium"]) {
    const out = evaluate(rankingRows(), {mode}); assert.equal(out.settings.balance, 1000);
    assert.ok(out.candidates.every(candidate => candidate.quantity === .1));
    assert.ok(out.candidates.every(candidate => candidate.metrics.quantity === .1));
  }
});
check("three modes implement distinct transparent criteria rather than hidden scores", () => {
  const first = mode => evaluate(rankingRows(), {mode}).candidates[0].strike;
  assert.equal(first("risk"), 60000); assert.equal(first("balanced"), 62000); assert.equal(first("premium"), 64000);
  const candidate = only(); near(candidate.dailyPremium, 5.85 / 15);
  near(candidate.balanceRatio, candidate.dailyPremium / (candidate.worstStressLoss + 5.85));
  assert.match(screen.FORMULAS.balanced, /最大不利压力亏损\+本次净权利金/);
});
check("balanced and premium may correctly show the same ordered list without reusing the same formula", () => {
  const rows = [row(60000, "PUT", 10), row(62000, "PUT", 20), row(63000, "PUT", 20), row(64000, "PUT", 25)];
  const balanced = evaluate(rows, {mode: "balanced"}), premium = evaluate(rows, {mode: "premium"});
  assert.equal(balanced.summary.eligibleCount, 4); assert.equal(balanced.summary.omittedCount, 0);
  assert.deepEqual(balanced.candidates.map(c => c.strike), [64000, 62000, 63000, 60000]);
  assert.deepEqual(premium.candidates.map(c => c.symbol), balanced.candidates.map(c => c.symbol));
  assert.notEqual(balanced.formula, premium.formula);
  for (const c of balanced.candidates) near(c.balanceRatio, (c.netPremium / 15) / (c.worstStressLoss + c.netPremium));
  const tied = balanced.candidates.slice(1, 3);
  assert.equal(tied[0].dailyPremium, tied[1].dailyPremium); assert.ok(tied[0].worstStressLoss < tied[1].worstStressLoss);
  assert.deepEqual(balanced.modeComparison, {mode: "premium", sameContracts: true, sameOrder: true, count: 4});
  assert.deepEqual(premium.modeComparison, {mode: "balanced", sameContracts: true, sameOrder: true, count: 4});
});
check("balanced and premium preserve different orders when their actual criteria disagree", () => {
  const balanced = evaluate(rankingRows(), {mode: "balanced"}), premium = evaluate(rankingRows(), {mode: "premium"});
  assert.equal(balanced.summary.eligibleCount, 3); assert.equal(premium.summary.eligibleCount, 3);
  assert.deepEqual([...balanced.candidates.map(c => c.symbol)].sort(), [...premium.candidates.map(c => c.symbol)].sort());
  assert.notDeepEqual(balanced.candidates.map(c => c.symbol), premium.candidates.map(c => c.symbol));
  const b = balanced.candidates[0], p = premium.candidates[0];
  assert.equal(b.strike, 62000); assert.equal(p.strike, 64000);
  assert.ok(b.balanceRatio > p.balanceRatio); assert.ok(p.dailyPremium > b.dailyPremium);
  assert.deepEqual(balanced.modeComparison, {mode: "premium", sameContracts: true, sameOrder: false, count: 3});
  assert.deepEqual(premium.modeComparison, {mode: "balanced", sameContracts: true, sameOrder: false, count: 3});
  for (const mode of ["balanced", "premium"]) {
    const out = evaluate(rankingRows(), {mode, limit: 1});
    assert.deepEqual(out.modeComparison, {mode: mode === "balanced" ? "premium" : "balanced", sameContracts: false, sameOrder: false, count: 1});
  }
});
check("sorting before the five-row limit can produce the same selected set in opposite orders", () => {
  const rows = [row(60000, "PUT", 30), row(61000, "PUT", 40), row(62000, "PUT", 300), row(62500, "PUT", 305),
    row(63000, "PUT", 310), row(63500, "PUT", 315), row(64000, "PUT", 320)];
  const balanced = evaluate(rows, {mode: "balanced"}), premium = evaluate(rows, {mode: "premium"});
  for (const out of [balanced, premium]) {
    assert.equal(out.summary.eligibleCount, 7); assert.equal(out.summary.shownCount, 5); assert.equal(out.summary.omittedCount, 2);
  }
  assert.deepEqual(balanced.candidates.map(c => c.strike), [62000, 62500, 63000, 63500, 64000]);
  assert.deepEqual(premium.candidates.map(c => c.strike), [64000, 63500, 63000, 62500, 62000]);
  assert.deepEqual(balanced.modeComparison, {mode: "premium", sameContracts: true, sameOrder: false, count: 5});
  assert.deepEqual(premium.modeComparison, {mode: "balanced", sameContracts: true, sameOrder: false, count: 5});
  assert.equal(evaluate(rows, {mode: "risk"}).modeComparison, null);
  assert.equal(evaluate([], {mode: "balanced"}).modeComparison, null);
});
check("same input is immutable and sort ties resolve deterministically by symbol", () => {
  const source = snapshot(rankingRows()), input = {mode: "risk"}, before = JSON.stringify({source, input});
  screen.evaluate(source, input, NOW); assert.equal(JSON.stringify({source, input}), before);
  const a = {symbol: "BTC-Z", dailyPremium: 1, worstStressLossPct: 2, worstStressMarginRatio: .5, balanceRatio: .1};
  const b = {...a, symbol: "BTC-A"};
  for (const mode of ["risk", "balanced", "premium"]) assert.ok(screen.compareCandidates(a, b, mode) > 0);
});
check("risk ties use worst maintenance ratio before the premium tie-break", () => {
  const a = {symbol: "A", dailyPremium: 100, worstStressLossPct: 10, worstStressMarginRatio: .9, balanceRatio: .1};
  const b = {...a, symbol: "B", dailyPremium: 1, worstStressMarginRatio: .5};
  assert.ok(screen.compareCandidates(a, b, "risk") > 0);
  assert.ok(screen.compareCandidates(a, b, "premium") < 0);
});
check("quantities are never reduced to hide depth or opening-balance failure", () => {
  for (const [patch, input, expected] of [[{bid_quantity: .05}, {}, "depth"], [{}, {balance: 800.65}, "balance"]]) {
    const out = evaluate([row(62000, "PUT", 65, patch)], input);
    assert.equal(out.candidates.length, 0); assert.equal(out.rejected.length, 1); assert.equal(out.rejected[0].category, expected);
  }
});
check("freshness failures remain rejected with actual reasons and never reuse a previous recommendation", () => {
  const source = snapshot(); assert.equal(screen.evaluate(source, {}, NOW).candidates.length, 1);
  const out = screen.evaluate(source, {}, NOW + 31000);
  assert.equal(out.candidates.length, 0); assert.equal(out.rejected[0].category, "freshness"); assert.match(out.rejected[0].reason, /陈旧/);
});
check("depth, spread, margin, metadata and filter rejections stay distinct", () => {
  const cases = [[{bid_price: 0}, {}, "depth"], [{ask_price: 200}, {}, "spread"], [{}, {balance: 500}, "balance"],
    [{quantity_step: undefined}, {}, "metadata"], [{unit: .1}, {}, "metadata"], [{strike_price: 70000, symbol: "BTC-300116-70000-P"}, {}, "filter"]];
  for (const [patch, input, category] of cases) {
    const out = evaluate([row(62000, "PUT", 65, patch)], input);
    assert.equal(out.candidates.length, 0); assert.equal(out.rejected[0].category, category, JSON.stringify(out.rejected));
    assert.ok(out.rejected[0].reason);
  }
});
check("incoherent book, old mark, old index and unverified catalog cannot rank", () => {
  for (const patch of [{quote_group_valid: false}, {field_updated_at: {mark_iv: NOW - 21000}}, {field_updated_at: {bid_quantity: NOW - 21000}}]) {
    const out = evaluate([row(62000, "PUT", 65, patch)]); assert.equal(out.candidates.length, 0); assert.equal(out.rejected[0].category, "freshness");
  }
  for (const patch of [{index_updated_at: NOW - 21000}, {catalog_updated_at: NOW - 600001}]) assert.equal(evaluate(undefined, {}, patch).candidates.length, 0);
});
check("six visible stresses use one consistent +20pp IV and three adverse points drive risk", () => {
  for (const side of ["PUT", "CALL"]) {
    const c = only([row(side === "PUT" ? 62000 : 98000, side)], {side});
    assert.equal(c.stress.length, 6); assert.equal(c.adverseStress.length, 3); assert.ok(c.stress.every(p => Math.abs(p.vol - .8) < 1e-12 && p.elapsedDays === 1));
    assert.deepEqual(c.adverseStress.map(p => p.movePct), side === "PUT" ? [-.1, -.2, -.3] : [.1, .2, .3]);
    assert.equal(c.primaryStress.movePct, side === "PUT" ? -.2 : .2);
    near(c.worstStressLoss, Math.max(...c.adverseStress.map(p => Math.max(0, -p.pnl))));
    near(c.worstStressLossPct, c.worstStressLoss / 1000 * 100);
    near(c.worstStressMarginRatio, Math.max(...c.adverseStress.map(p => p.marginRatio)));
    for (const p of c.stress) {near(p.loss, Math.max(0, -p.pnl)); near(p.lossPct, p.loss / 1000 * 100);}
  }
});
check("pressure state flags are hypothetical and never erase unlimited Call liability", () => {
  const c = only([row(98000, "CALL")], {side: "CALL"});
  assert.equal(c.lossUnbounded, true); assert.equal(c.maxExpiryLoss, Infinity); assert.equal(c.metrics.lossUnbounded, true);
  assert.equal(c.stressState, "liquidation"); assert.equal(c.isPriority, false);
  assert.match(screen.STRESS_ASSUMPTION, /非成交保证、概率预测或精确强平价/);
  assert.equal(JSON.parse(JSON.stringify(c)).lossUnbounded, true);
});
check("changing risk mode never changes margin, fees, quantity or pressure prices", () => {
  const outputs = ["risk", "balanced", "premium"].map(mode => evaluate(rankingRows(), {mode}).candidates);
  for (const first of outputs[0]) for (const candidates of outputs.slice(1)) {
    const second = candidates.find(c => c.symbol === first.symbol);
    for (const key of ["quantity", "netPremium", "orderMargin", "maintenanceMargin", "worstStressLoss", "dailyPremium", "balanceRatio"]) assert.equal(second[key], first[key]);
    assert.deepEqual(second.stress, first.stress);
  }
});
check("expiry, OTM boundaries and calibrated expiry time are applied consistently", () => {
  for (const [side, strike] of [["PUT", 60000], ["PUT", 64000], ["CALL", 96000], ["CALL", 100000]]) {
    assert.equal(evaluate([row(strike, side)], {side}).candidates.length, 1);
  }
  const out = evaluate([row(62000, "PUT", 65, {expiry_ms: NOW + 1000})], {minDays: 0}, {exchange_clock_offset_ms: 2000});
  assert.equal(out.candidates.length, 0); assert.equal(out.rejected[0].reason, "合约已到期");
});
check("ALL support still keeps each side's adverse direction and cash-cover meaning separate", () => {
  const out = evaluate([row(), row(98000, "CALL")], {side: "ALL"}); assert.equal(out.candidates.length, 2);
  const call = out.candidates.find(c => c.side === "CALL"), put = out.candidates.find(c => c.side === "PUT");
  assert.equal(call.primaryStress.movePct, .2); assert.equal(put.primaryStress.movePct, -.2);
  assert.equal(call.metrics.cashSecuredCapital, null); near(put.metrics.cashSecuredCapital, 6200);
});
check("limit is applied after complete ranking and summary accounts for every input", () => {
  const rows = [row(60000), row(61000), row(62000), row(63000), row(64000), row(65000), row(98000, "CALL")];
  const out = evaluate(rows, {limit: 2, mode: "risk"});
  assert.equal(out.candidates.length, 2); assert.equal(out.summary.eligibleCount, 5); assert.equal(out.summary.omittedCount, 3);
  assert.equal(out.summary.rejectedCount, 2); assert.equal(out.summary.inputCount, 7); assert.equal(out.summary.reasonCounts.filter, 2);
  assert.deepEqual(out.candidates.map(c => c.rank), [1, 2]);
  assert.equal(Object.values(out.summary.pressureCounts).reduce((a, b) => a + b, 0), 5);
});
check("empty malformed snapshots and missing index return explicit issues without invented candidates", () => {
  for (const snap of [null, {}, {options: {}}, {options: []}, {options: [row()], btc_index_price: null}]) {
    const out = screen.evaluate(snap, {}, NOW); assert.equal(out.candidates.length, 0); assert.ok(out.issues.length);
  }
  const out = screen.evaluate({options: [row()], btc_index_price: null}, {}, NOW);
  assert.equal(out.rejected[0].category, "freshness");
});
check("malformed contract records and mismatched Call/Put symbols do not enter ranking", () => {
  const out = evaluate([null, [], 5, row(62000, "PUT", 65, {symbol: "BTC-300116-62000-C"}), row(62000, "PUT", 65, {symbol: "BTC-300116-63000-P"})]);
  assert.equal(out.candidates.length, 0); assert.equal(out.rejected.length, 5);
  assert.equal(out.summary.reasonCounts.invalid, 3); assert.equal(out.summary.reasonCounts.metadata, 2);
});
check("blank boolean nonfinite inverted and oversized input parameters fail clearly", () => {
  for (const input of [null, [], {balance: ""}, {balance: true}, {quantity: 0}, {minDays: null}, {minOtmPct: ""},
    {maxSpreadPct: null}, {maxDays: Infinity}, {minDays: 21}, {minOtmPct: 30}, {maxOtmPct: 100},
    {limit: 0}, {limit: 6}, {limit: 1.5}, {side: "BAD"}, {mode: "BAD"}]) {
    const out = screen.evaluate(snapshot(), input, NOW); assert.equal(out.candidates.length, 0); assert.ok(out.issues.length, JSON.stringify(input));
  }
  for (const now of [NaN, Infinity, 0, 1e20]) assert.ok(screen.evaluate(snapshot(), {}, now).issues.length);
});
check("Call OTM widths above 100 percent are valid while Put and ALL reject them", () => {
  assert.deepEqual(screen.normalizeInput({side: "CALL", minOtmPct: 100, maxOtmPct: 150}).issues, []);
  assert.ok(screen.normalizeInput({side: "PUT", minOtmPct: 100, maxOtmPct: 150}).issues.length);
  assert.ok(screen.normalizeInput({side: "ALL", minOtmPct: 100, maxOtmPct: 150}).issues.length);
});
check("IV ceiling is disclosed and never creates duplicate or missing pressure rows", () => {
  const c = only([row(62000, "PUT", 65, {mark_iv: 4.9})]);
  assert.equal(c.stress.length, 6); assert.ok(c.stress.every(p => p.vol === 5 && p.ivCapped));
  near(c.stress[0].ivShift, .1); assert.match(screen.STRESS_ASSUMPTION, /最高500%/);
});
// Independent lognormal-payoff integral: no engine CDF or option-pricing helper.
function integralPrice(side, spot, strike, days, vol) {
  const v = vol * Math.sqrt(days / 365), z0 = (Math.log(strike / spot) + v * v / 2) / v;
  const lo = side === "PUT" ? -14 : Math.max(-14, z0), hi = side === "PUT" ? Math.min(14, z0) : 14;
  if (lo >= hi) return 0;
  const n = 30000, h = (hi - lo) / n;
  const f = z => Math.max(side === "PUT" ? strike - spot * Math.exp(-v*v/2 + v*z) : spot * Math.exp(-v*v/2 + v*z) - strike, 0) * Math.exp(-z*z/2) / Math.sqrt(2*Math.PI);
  let sum = f(lo) + f(hi);
  for (let i = 1; i < n; i++) sum += (i % 2 ? 4 : 2) * f(lo + i*h);
  return sum*h/3;
}
check("stress PnL and MM match independent pricing integrals plus hand-expanded fees", () => {
  for (const side of ["PUT", "CALL"]) {
    const strike = side === "PUT" ? 62000 : 98000, c = only([row(strike, side)], {side});
    const base = integralPrice(side, 80000, strike, 15, .6);
    for (const point of c.adverseStress) {
      const s = 80000 * (1 + point.movePct), intrinsic = Math.max(side === "PUT" ? strike - s : s - strike, 0);
      const estimated = 65 + integralPrice(side, s, strike, 14, .8) - base;
      const mark = Math.max(intrinsic, Math.min(side === "PUT" ? strike : s, estimated));
      const closeFee = Math.min(.00024*s, .1*mark)*.1, pnl = 5.85 - mark*.1 - closeFee;
      const otm = Math.max(side === "PUT" ? s - strike : strike - s, 0);
      const maintenance = (Math.max(.05*s, .075*s-otm) + mark + .0019*s)*.1;
      near(point.pnl, pnl, 1e-6); near(point.maintenanceMargin, maintenance, 1e-6); near(point.marginRatio, maintenance/1005.85, 1e-8);
    }
  }
});
check("browser UMD missing dependency and zero-loss edge never produce an infinite balance ratio", () => {
  const source = fs.readFileSync("dashboard/dist/seller-screen-engine.js", "utf8"), context = {};
  vm.runInNewContext(source, context); assert.ok(context.SellerScreenEngine.evaluate(snapshot(), {}, NOW).issues.length);
  const fake = {normalizeSettings: settings => ({settings, issues: []}), analyzeCandidate: (_s, contract) => ({row: contract, warnings: [], issue: null,
    metrics: {quantity: .1, netPremium: 5, grossPremium: 5.5, entryFee: .5, orderMargin: 800, maintenanceMargin: 400, marginRatio: .4, breakEven: 61950, maxExpiryLoss: 6195},
    stress: [-.3,-.2,-.1,.1,.2,.3].map(movePct => ({movePct, pnl: 10, mark: 1, marginRatio: .1, vol: .8, elapsedDays: 1}))})};
  const zero = {SellPutEngine: fake}; vm.runInNewContext(source, zero);
  const out = zero.SellerScreenEngine.evaluate(snapshot(), {}, NOW), c = out.candidates[0];
  assert.equal(c.worstStressLoss, 0); near(c.balanceRatio, 1/15); assert.equal(c.stressState, "normal");
  fake.analyzeCandidate = () => ({metrics: {netPremium: 0}, issue: null});
  assert.equal(zero.SellerScreenEngine.evaluate(snapshot(), {}, NOW).candidates.length, 0);
});
console.log(`${checks} seller-screen engine checks passed.`);
