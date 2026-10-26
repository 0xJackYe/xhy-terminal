"use strict";

// Independent audit: direct contractual cash flows plus numerical integration.
// This oracle does not use the risk module's piecewise payoff or normal helpers.
const assert = require("node:assert/strict");
const risk = require("./dashboard/dist/risk-metrics.js");
let checks = 0;
function test(name, run) {run(); checks++; console.log(`OK independent: ${name}`);}
function close(actual, expected, tolerance = 2e-7) {
  assert.ok(Number.isFinite(actual), `Expected finite value, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `Expected ${expected}, got ${actual}; difference ${Math.abs(actual - expected)}`);
}
const defaults = {type: "PUT", direction: "SELL", strike: 64000, premium: 95,
  quantity: .01, unit: 1, spot: 81805.1265, years: 15.598 / 365,
  annualVol: .6, annualDrift: 0, additionalFees: 0,
  feeEntryRate: .00024, feeExerciseRate: .00015, feeCap: .1};
function config(values = {}) {return {...defaults, ...values};}
function intrinsic(c, s) {return Math.max(c.type === "CALL" ? s - c.strike : c.strike - s, 0);}
function entry(c) {return Math.min(c.spot * c.feeEntryRate, c.premium * c.feeCap) * c.quantity * c.unit;}
function cash(c, s) {
  const value = intrinsic(c, s), units = c.quantity * c.unit;
  const sign = c.direction === "BUY" ? 1 : -1;
  return sign * (value - c.premium) * units - entry(c) - c.additionalFees
    - Math.min(c.feeExerciseRate * s, c.feeCap * value) * units;
}
function phi(z) {return Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);}
function simpson(f, a, b, tolerance = 1e-10) {
  if (a === b) return 0;
  const m = (a + b) / 2, fa = f(a), fm = f(m), fb = f(b);
  const total = (b - a) * (fa + 4 * fm + fb) / 6;
  function refine(left, right, fLeft, fMid, fRight, previous, eps, depth) {
    const mid = (left + right) / 2;
    const quarter = (left + mid) / 2, threeQuarter = (mid + right) / 2;
    const fq = f(quarter), ft = f(threeQuarter);
    const first = (mid - left) * (fLeft + 4 * fq + fMid) / 6;
    const second = (right - mid) * (fMid + 4 * ft + fRight) / 6;
    const delta = first + second - previous;
    if (depth === 0 || Math.abs(delta) < 15 * eps) return first + second + delta / 15;
    return refine(left, mid, fLeft, fq, fMid, first, eps / 2, depth - 1)
      + refine(mid, right, fMid, ft, fRight, second, eps / 2, depth - 1);
  }
  return refine(a, b, fa, fm, fb, total, tolerance, 22);
}
function cdf(z) {
  if (z <= -12) return 0;
  if (z >= 12) return 1;
  return .5 + (z < 0 ? -simpson(phi, z, 0) : simpson(phi, 0, z));
}
function increasing(c) {return (c.type === "CALL") === (c.direction === "BUY");}
function root(c) {
  let low = 0, high = Math.max(c.spot, c.strike, c.premium) * 4;
  const rising = increasing(c);
  if ((rising && cash(c, low) >= 0) || (!rising && cash(c, low) <= 0)) return null;
  for (let i = 0; i < 40 && (rising ? cash(c, high) < 0 : cash(c, high) > 0); i++) high *= 2;
  if (rising ? cash(c, high) < 0 : cash(c, high) > 0) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (low + high) / 2;
    if (rising ? cash(c, mid) < 0 : cash(c, mid) > 0) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}
function oracle(c) {
  const volatility = c.annualVol * Math.sqrt(c.years);
  const location = Math.log(c.spot) + (c.annualDrift - c.annualVol ** 2 / 2) * c.years;
  const spotAt = z => Math.exp(location + volatility * z);
  const be = root(c), rising = increasing(c);
  const feeCross = c.type === "CALL"
    ? c.feeCap * c.strike / (c.feeCap - c.feeExerciseRate)
    : c.feeCap * c.strike / (c.feeCap + c.feeExerciseRate);
  const zFor = s => (Math.log(s) - location) / volatility;
  const breaks = [c.strike, feeCross, be].filter(s => s > 0).map(zFor);
  function integral(fn, from, to) {
    const bounds = [from, ...breaks.filter(z => z > from && z < to).sort((a,b) => a-b), to];
    return bounds.slice(1).reduce((sum, right, i) => sum + simpson(fn, bounds[i], right), 0);
  }
  const expectedPnl = integral(z => cash(c, spotAt(z)) * phi(z), -12, 12);
  const profitProbability = be === null
    ? (cash(c, c.spot) > 0 ? 1 : 0)
    : (rising ? 1 - cdf(zFor(be)) : cdf(zFor(be)));
  const result = {expectedPnl, profitProbability};
  for (const [tail, label, z] of [[.05, "95", 1.6448536269514722], [.01, "99", 2.3263478740408408]]) {
    const adverse = rising ? -z : z;
    result[`var${label}`] = Math.max(-cash(c, spotAt(adverse)), 0);
    result[`es${label}`] = integral(v => Math.max(-cash(c, spotAt(v)), 0) * phi(v),
      rising ? -12 : adverse, rising ? adverse : 12) / tail;
  }
  return result;
}

test("known 64k Put uses 0.01 BTC exposure and capped opening fee", () => {
  const c = config(), result = risk.analyze(c);
  close(result.entryFee, .095, 1e-12);
  close(result.premiumTotal, .95, 1e-12);
  close(result.maxProfit, .855, 1e-12);
  close(result.maxLoss, 639.145, 1e-10);
  // At this root the 10% intrinsic-value cap binds, not the notional-rate branch.
  close(result.breakEven, 64000 - 85.5 / 1.1, 1e-7);
  close(result.rewardRiskRatio, .855 / 639.145, 1e-12);
});

for (const type of ["CALL", "PUT"]) {
  for (const direction of ["BUY", "SELL"]) {
    test(`${direction} ${type}: EV, profit probability and both tail losses match independent quadrature`, () => {
      const c = config({type, direction, strike: 80000, premium: 2100, annualVol: .7, annualDrift: .12,
        years: 40 / 365, quantity: .03, unit: .5, additionalFees: .07});
      const actual = risk.analyze(c).model, expected = oracle(c);
      for (const field of ["expectedPnl", "profitProbability", "var95", "es95", "var99", "es99"])
        close(actual[field], expected[field], field === "profitProbability" ? 2e-7 : 2e-5);
      close(actual.profitProbability + actual.lossProbability + actual.zeroProbability, 1, 1e-10);
      assert.ok(actual.es95 + 1e-8 >= actual.var95);
      assert.ok(actual.es99 + 1e-8 >= actual.es95);
    });
    test(`${direction} ${type}: each stress scenario uses correct direct cash settlement and exercise fee`, () => {
      const c = config({type, direction, strike: 80000, premium: 2100, additionalFees: .3});
      for (const scenario of risk.analyze(c).scenarios) {
        close(scenario.pnl, cash(c, scenario.settlement), 1e-8);
        close(scenario.settlement, c.spot * (1 + scenario.movePct), 1e-7);
      }
    });
    test(`${direction} ${type}: zero-volatility distribution is deterministic`, () => {
      const c = config({type, direction, annualVol: 0, annualDrift: .09});
      const result = risk.analyze(c).model, pnl = cash(c, c.spot * Math.exp(c.annualDrift * c.years));
      close(result.expectedPnl, pnl, 1e-9);
      assert.equal(result.profitProbability, pnl > 0 ? 1 : 0);
      assert.equal(result.lossProbability, pnl < 0 ? 1 : 0);
      assert.equal(result.zeroProbability, pnl === 0 ? 1 : 0);
      close(result.var95, Math.max(-pnl, 0), 1e-9);
      close(result.es99, Math.max(-pnl, 0), 1e-9);
    });
  }
}

test("64k Put model expectation agrees with the independently integrated cash flow", () => {
  const c = config(), result = risk.analyze(c).model, expected = oracle(c);
  for (const field of ["expectedPnl", "profitProbability", "var95", "es95", "var99", "es99"])
    close(result[field], expected[field], field === "profitProbability" ? 2e-7 : 2e-6);
});
test("remote Put ES includes zero-loss observations within the entire tail mass", () => {
  const c = config({strike: 52000, premium: 3, annualVol: .6});
  const actual = risk.analyze(c).model, expected = oracle(c);
  assert.ok(actual.lossProbability < .01);
  close(actual.var95, 0);
  close(actual.var99, 0);
  close(actual.es95, expected.es95, 1e-7);
  close(actual.es99, expected.es99, 1e-7);
  close(actual.es99, actual.es95 * 5, 1e-7);
});
test("quantity and contract multiplier scale money while probability and ratios remain invariant", () => {
  const c = config({additionalFees: .03}), first = risk.analyze(c);
  const second = risk.analyze({...c, quantity: c.quantity * 3, additionalFees: c.additionalFees * 3});
  const third = risk.analyze({...c, unit: c.unit * 3, additionalFees: c.additionalFees * 3});
  for (const other of [second, third]) {
    for (const key of ["entryFee", "premiumTotal", "maxProfit", "maxLoss"]) close(other[key], first[key] * 3, 1e-7);
    for (const key of ["expectedPnl", "var95", "es95", "var99", "es99"]) close(other.model[key], first.model[key] * 3, 1e-7);
    close(other.model.profitProbability, first.model.profitProbability, 1e-10);
    close(other.rewardRiskRatio, first.rewardRiskRatio, 1e-12);
  }
});
test("unbounded Call profits and losses cannot turn into sortable infinite reward ratios", () => {
  const buy = risk.analyze(config({type: "CALL", direction: "BUY"}));
  const sell = risk.analyze(config({type: "CALL", direction: "SELL"}));
  assert.equal(buy.profitUnbounded, true);
  assert.equal(buy.maxProfit, null);
  assert.equal(buy.rewardRiskRatio, null);
  assert.equal(sell.lossUnbounded, true);
  assert.equal(sell.maxLoss, null);
  assert.equal(sell.rewardRiskRatio, null);
});
test("no-fee long plus short PnL has zero expectation rather than artificial positive edge", () => {
  for (const type of ["CALL", "PUT"]) {
    const c = config({type, feeEntryRate: 0, feeExerciseRate: 0, additionalFees: 0});
    const buy = risk.analyze({...c, direction: "BUY"}), sell = risk.analyze({...c, direction: "SELL"});
    close(buy.model.expectedPnl + sell.model.expectedPnl, 0, 1e-7);
    close(buy.model.profitProbability + sell.model.profitProbability, 1, 1e-10);
  }
});
test("common distribution gives distinct expected payouts rather than using each contract IV as real-world truth", () => {
  const c = config({annualVol: .6, iv: .2, mark_iv: .2});
  const first = risk.analyze(c), second = risk.analyze({...c, iv: 2, mark_iv: 2});
  close(first.model.expectedPnl, second.model.expectedPnl, 1e-12);
  close(first.model.profitProbability, second.model.profitProbability, 1e-12);
});
test("deterministic exact break-even is zero probability rather than a win or loss", () => {
  const c = config({type: "CALL", direction: "BUY", strike: 100, premium: 10,
    spot: 110, annualVol: 0, annualDrift: 0, feeEntryRate: 0, feeExerciseRate: 0});
  const result = risk.analyze(c).model;
  close(result.expectedPnl, 0, 1e-12);
  assert.equal(result.zeroProbability, 1);
  assert.equal(result.profitProbability, 0);
  assert.equal(result.lossProbability, 0);
  assert.equal(result.es95, 0);
});
test("fee-neutral short Put has a zero-PnL plateau with separately accounted probability mass", () => {
  const c = config({strike: 100, premium: 10, spot: 100, feeEntryRate: 1,
    feeCap: 1, annualVol: .8, years: .25});
  const result = risk.analyze(c), location = Math.log(c.spot) - c.annualVol ** 2 * c.years / 2;
  const lossProbability = cdf((Math.log(c.strike) - location) / (c.annualVol * Math.sqrt(c.years)));
  assert.equal(result.maxProfit, 0);
  assert.equal(result.model.profitProbability, 0);
  close(result.model.lossProbability, lossProbability);
  close(result.model.zeroProbability, 1 - lossProbability);
});
test("100% exercise cap may cancel an entire long Call, preserving its all-zero atom", () => {
  const c = config({type: "CALL", direction: "BUY", strike: 100, premium: 0,
    spot: 100, feeEntryRate: 0, feeExerciseRate: 1, feeCap: 1});
  const result = risk.analyze(c);
  assert.equal(result.maxProfit, 0);
  assert.equal(result.maxLoss, 0);
  assert.equal(result.profitUnbounded, false);
  assert.equal(result.lossUnbounded, false);
  assert.equal(result.rewardRiskRatio, null);
  close(result.model.expectedPnl, 0);
  close(result.model.zeroProbability, 1);
  assert.equal(result.model.profitProbability, 0);
  assert.equal(result.model.lossProbability, 0);
});
test("unusual fee-branch order still matches independent integration in all four directions", () => {
  for (const type of ["CALL", "PUT"]) for (const direction of ["BUY", "SELL"]) {
    const c = config({type, direction, strike: 80000, premium: 2100, annualVol: .9,
      feeExerciseRate: .4, feeCap: .2, years: .3, annualDrift: -.15});
    const result = risk.analyze(c).model, expected = oracle(c);
    for (const key of ["expectedPnl", "var95", "es95", "var99", "es99"])
      close(result[key], expected[key], 2e-5);
    close(result.profitProbability, expected.profitProbability, 2e-7);
  }
});
console.log(`${checks} independent risk tests passed`);
