"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const modelPath = path.join(__dirname, "dashboard", "dist", "portfolio.js");
const Portfolio = require(modelPath);
const Payoff = require("./dashboard/dist/payoff.js");
let count = 0;
function test(name, run) {run(); count++; console.log(`OK ${name}`);}
function close(actual, expected, tolerance = 1e-9) {assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);}
function leg(type, direction, strike, premium, quantity = 1, unit = 1, fees = 0) {
  return {type, direction, strike, premium, quantity, unit, fees};
}
function portfolio(legs, fees = 0) {return {legs, fees};}

test("long straddle has two roots and unlimited high-side profit", () => {
  const config = portfolio([leg("CALL", "BUY", 100, 15), leg("PUT", "BUY", 100, 15)]);
  const metrics = Portfolio.metrics(config);
  assert.deepEqual(metrics.breakEvens, [70, 130]);
  assert.deepEqual(metrics.breakEvenRanges, []);
  assert.equal(metrics.premiumPaid, 30);
  assert.equal(metrics.premiumReceived, 0);
  assert.equal(metrics.netPremium, -30);
  assert.equal(metrics.maxLoss, 30);
  assert.equal(metrics.maxProfit, Infinity);
  assert.equal(Portfolio.pnl(config, 0), 70);
  assert.equal(Portfolio.pnl(config, 100), -30);
  assert.equal(Portfolio.pnl(config, 130), 0);
});

test("long strangle retains its flat loss between two distinct strikes", () => {
  const config = portfolio([leg("CALL", "BUY", 110, 5), leg("PUT", "BUY", 90, 5)]);
  const metrics = Portfolio.metrics(config);
  assert.deepEqual(metrics.strikes, [90, 110]);
  assert.deepEqual(metrics.breakEvens, [80, 120]);
  assert.equal(metrics.maxLoss, 10);
  assert.equal(Portfolio.pnl(config, 95), -10);
  assert.equal(Portfolio.pnl(config, 105), -10);
});

test("short straddle has bounded profit and unlimited Call-side loss", () => {
  const config = portfolio([leg("CALL", "SELL", 100, 15), leg("PUT", "SELL", 100, 15)]);
  const metrics = Portfolio.metrics(config);
  assert.deepEqual(metrics.breakEvens, [70, 130]);
  assert.equal(metrics.premiumPaid, 0);
  assert.equal(metrics.premiumReceived, 30);
  assert.equal(metrics.netPremium, 30);
  assert.equal(metrics.maxProfit, 30);
  assert.equal(metrics.maxLoss, Infinity);
  assert.equal(metrics.tailSlope, -1);
});

test("Call debit vertical has finite portfolio risk despite unbounded individual legs", () => {
  const config = portfolio([leg("CALL", "BUY", 100, 10), leg("CALL", "SELL", 120, 4)]);
  const metrics = Portfolio.metrics(config);
  assert.deepEqual(metrics.breakEvens, [106]);
  assert.equal(metrics.maxLoss, 6);
  assert.equal(metrics.maxProfit, 14);
  assert.equal(metrics.tailSlope, 0);
  assert.equal(Portfolio.pnl(config, 1e9), 14);
  assert.equal(Payoff.metrics(config.legs[1]).maxLoss, Infinity);
});

test("bounded spreads retain their finite net payout at enormous settlement prices", () => {
  const debit = portfolio([leg("CALL", "BUY", 100, 10), leg("CALL", "SELL", 120, 4)]);
  const credit = portfolio([leg("CALL", "SELL", 100, 10), leg("CALL", "BUY", 120, 4)]);
  assert.equal(Portfolio.pnl(debit, 1e300), 14);
  assert.equal(Portfolio.pnl(credit, 1e300), -14);
  const butterfly = portfolio([leg("CALL", "BUY", 90, 12), leg("CALL", "SELL", 100, 6, 2), leg("CALL", "BUY", 110, 2)]);
  assert.equal(Portfolio.pnl(butterfly, 1e300), -2);
});

test("Put debit vertical has finite loss and reaches maximum profit at low settlement", () => {
  const config = portfolio([leg("PUT", "BUY", 120, 15), leg("PUT", "SELL", 100, 5)]);
  const metrics = Portfolio.metrics(config);
  assert.deepEqual(metrics.breakEvens, [110]);
  assert.equal(metrics.maxLoss, 10);
  assert.equal(metrics.maxProfit, 10);
  assert.equal(metrics.tailSlope, 0);
  assert.equal(Portfolio.pnl(config, 0), 10);
  assert.equal(Portfolio.pnl(config, 1e9), -10);
});

test("Call butterfly reaches its exact finite peak at the middle strike", () => {
  const config = portfolio([leg("CALL", "BUY", 90, 12), leg("CALL", "SELL", 100, 6, 2), leg("CALL", "BUY", 110, 2)]);
  const metrics = Portfolio.metrics(config);
  assert.deepEqual(metrics.breakEvens, [92, 108]);
  assert.equal(metrics.maxProfit, 8);
  assert.equal(metrics.maxLoss, 2);
  assert.equal(Portfolio.pnl(config, 100), 8);
  assert.equal(Portfolio.pnl(config, 10000), -2);
});

test("zero-cost butterfly reports full zero bands and excludes their boundary roots", () => {
  const config = portfolio([leg("CALL", "BUY", 90, 10), leg("CALL", "SELL", 100, 6, 2), leg("CALL", "BUY", 110, 2)]);
  const metrics = Portfolio.metrics(config);
  assert.deepEqual(metrics.breakEvens, []);
  assert.deepEqual(metrics.breakEvenRanges, [[0, 90], [110, Infinity]]);
  assert.equal(metrics.maxProfit, 10);
  assert.equal(metrics.maxLoss, 0);
});

test("piecewise portfolio finds four distinct roots instead of assuming two", () => {
  const config = portfolio([
    leg("CALL", "BUY", 80, 1), leg("CALL", "SELL", 90, 1, 2),
    leg("CALL", "BUY", 100, 1, 2), leg("CALL", "SELL", 110, 1, 2), leg("CALL", "BUY", 120, 1)
  ], 5);
  const metrics = Portfolio.metrics(config);
  assert.deepEqual(metrics.breakEvens, [85, 95, 105, 115]);
  assert.equal(metrics.maxProfit, 5);
  assert.equal(metrics.maxLoss, 5);
});

test("perfectly offsetting legs merge adjacent zero intervals into the whole domain", () => {
  const config = portfolio([leg("CALL", "BUY", 100, 10), leg("CALL", "SELL", 100, 10)]);
  const metrics = Portfolio.metrics(config);
  assert.deepEqual(metrics.breakEvens, []);
  assert.deepEqual(metrics.breakEvenRanges, [[0, Infinity]]);
  assert.equal(metrics.maxProfit, 0);
  assert.equal(metrics.maxLoss, 0);
});

test("unequal Call quantities determine the infinite tail rather than chart endpoints", () => {
  const long = portfolio([leg("CALL", "BUY", 100, 10, 2), leg("CALL", "SELL", 120, 4)]);
  const short = portfolio([leg("CALL", "BUY", 100, 10), leg("CALL", "SELL", 120, 4, 2)]);
  assert.equal(Portfolio.metrics(long).tailSlope, 1);
  assert.equal(Portfolio.metrics(long).maxProfit, Infinity);
  assert.equal(Portfolio.metrics(short).tailSlope, -1);
  assert.equal(Portfolio.metrics(short).maxLoss, Infinity);
});

test("microscopic net Call exposure survives cancellation and is never treated as hedged", () => {
  const config = portfolio([leg("CALL", "BUY", 100, 1), leg("CALL", "BUY", 100, 1, 1e-100), leg("CALL", "SELL", 100, 1)]);
  const metrics = Portfolio.metrics(config);
  assert.equal(metrics.tailSlope, 1e-100);
  assert.equal(metrics.maxProfit, Infinity);
  assert.equal(metrics.maxLoss, 1e-100);
  assert.equal(metrics.netPremium, -1e-100);
  assert.deepEqual(metrics.breakEvens, [101]);
  assert.equal(Portfolio.pnl(config, 100), -1e-100);
  const reversed = portfolio([...config.legs].reverse());
  assert.equal(Portfolio.metrics(reversed).tailSlope, 1e-100);
});

test("0.3 is exactly hedged by 0.1 plus 0.2 with finite risk and one sensible root", () => {
  for (const quantities of [[0.3, 0.1, 0.2], ["0.3", "0.1", "0.2"]]) {
    const config = portfolio([
      leg("CALL", "BUY", 80000, 500, quantities[0]),
      leg("CALL", "SELL", 90000, 100, quantities[1]),
      leg("CALL", "SELL", 100000, 50, quantities[2])
    ]);
    for (const source of [config, portfolio([...config.legs].reverse()), JSON.parse(JSON.stringify(Portfolio.validate(config).config))]) {
      const metrics = Portfolio.metrics(source);
      assert.equal(metrics.tailSlope, 0);
      assert.equal(metrics.maxLoss, 130);
      assert.equal(metrics.maxProfit, 4870);
      assert.equal(metrics.netPremium, -130);
      assert.equal(metrics.breakEvens.length, 1);
      close(metrics.breakEvens[0], 80000 + 130 / 0.3);
      assert.ok(metrics.breakEvens[0] < 100000, "chart cannot be stretched by a spurious astronomical root");
      for (const settlement of [100000, 150000, 1e300]) assert.equal(Portfolio.pnl(source, settlement), 4870);
    }
  }
});

test("0.06 is exactly hedged by 0.01 plus 0.05 without inventing infinite loss", () => {
  const config = portfolio([
    leg("CALL", "BUY", 80000, 500, "0.06"),
    leg("CALL", "SELL", 90000, 100, "0.01"),
    leg("CALL", "SELL", 100000, 50, "0.05")
  ]);
  const metrics = Portfolio.metrics(config);
  assert.equal(metrics.tailSlope, 0);
  assert.equal(metrics.maxLoss, 26.5);
  assert.equal(metrics.maxProfit, 1073.5);
  assert.equal(metrics.breakEvens.length, 1);
  close(metrics.breakEvens[0], 80000 + 26.5 / 0.06);
  assert.equal(Portfolio.pnl(config, 1e300), 1073.5);
});

test("decimal quantity times decimal unit retains an exact hedge", () => {
  const config = portfolio([
    leg("CALL", "BUY", 80000, 500, "0.1", "0.3"),
    leg("CALL", "SELL", 90000, 100, "0.1", "0.1"),
    leg("CALL", "SELL", 100000, 50, "0.1", "0.2")
  ]);
  const normalized = Portfolio.validate(config);
  assert.equal(normalized.valid, true);
  const serialized = JSON.parse(JSON.stringify(normalized.config));
  for (const source of [config, serialized]) {
    const metrics = Portfolio.metrics(source);
    assert.equal(metrics.tailSlope, 0);
    assert.equal(metrics.maxLoss, 13);
    assert.equal(metrics.maxProfit, 487);
    assert.equal(metrics.breakEvens.length, 1);
    assert.equal(Portfolio.pnl(source, 1e300), 487);
  }
});

test("long decimal quantity strings preserve genuine positive and negative residual risk", () => {
  const precise = "0.3000000000000000000000000000000000000001";
  for (const direction of ["BUY", "SELL"]) {
    const other = direction === "BUY" ? "SELL" : "BUY";
    const config = portfolio([
      leg("CALL", direction, 100, 1, precise),
      leg("CALL", other, 100, 1, "0.1"),
      leg("CALL", other, 100, 1, "0.2")
    ]);
    const validated = Portfolio.validate(config);
    assert.equal(validated.valid, true);
    assert.equal(typeof validated.config.legs[0].quantity, "string");
    for (const source of [config, validated.config, JSON.parse(JSON.stringify(validated.config))]) {
      const metrics = Portfolio.metrics(source);
      assert.equal(metrics.tailSlope, direction === "BUY" ? 1e-40 : -1e-40);
      assert.equal(metrics.netPremium, direction === "BUY" ? -1e-40 : 1e-40);
      assert.equal(direction === "BUY" ? metrics.maxProfit : metrics.maxLoss, Infinity);
      assert.equal(direction === "BUY" ? metrics.maxLoss : metrics.maxProfit, 1e-40);
      assert.deepEqual(metrics.breakEvens, [101]);
      assert.equal(Portfolio.pnl(source, 101), 0);
      assert.equal(Portfolio.pnl(source, 102), direction === "BUY" ? 1e-40 : -1e-40);
    }
  }
});

test("long decimal multipliers survive normalization and JSON round trips", () => {
  const config = portfolio([
    leg("CALL", "BUY", 100, 1, "1", "1.0000000000000000000001"),
    leg("CALL", "SELL", 100, 1, "1", "1")
  ]);
  const normalized = Portfolio.validate(config).config;
  for (const source of [config, normalized, JSON.parse(JSON.stringify(normalized))]) {
    const metrics = Portfolio.metrics(source);
    assert.equal(metrics.tailSlope, 1e-22);
    assert.equal(metrics.maxProfit, Infinity);
    assert.equal(metrics.maxLoss, 1e-22);
    assert.deepEqual(metrics.breakEvens, [101]);
  }
});

test("a representable 1e-320 residual remains real risk rather than an epsilon-zero hedge", () => {
  const config = portfolio([
    leg("CALL", "BUY", 100, 1),
    leg("CALL", "BUY", 100, 1, "1e-320"),
    leg("CALL", "SELL", 100, 1)
  ]);
  const metrics = Portfolio.metrics(config);
  assert.equal(metrics.tailSlope, 1e-320);
  assert.equal(metrics.maxProfit, Infinity);
  assert.equal(metrics.maxLoss, 1e-320);
  assert.deepEqual(metrics.breakEvens, [101]);
  assert.equal(Portfolio.pnl(config, 101), 0);
});

test("an unrepresentable nonzero residual is rejected instead of reported as a zero hedge", () => {
  const config = portfolio([
    leg("CALL", "BUY", 100, 1, `1.${"0".repeat(399)}1`),
    leg("CALL", "SELL", 100, 1)
  ]);
  assert.equal(Portfolio.validate(config).valid, false);
  assert.throws(() => Portfolio.metrics(config), RangeError);
});

test("quantity and unit scale each leg while per-leg and total fees apply exactly once", () => {
  const config = portfolio([leg("CALL", "BUY", 100, 10, 2, 0.5, 1), leg("PUT", "BUY", 100, 10, 4, 0.25, 2)], 3);
  const metrics = Portfolio.metrics(config);
  assert.equal(metrics.premiumPaid, 20);
  assert.equal(metrics.fees, 6);
  assert.equal(metrics.maxLoss, 26);
  assert.deepEqual(metrics.breakEvens, [74, 126]);
  assert.equal(Portfolio.pnl(config, 100), -26);
});

test("credit and debit totals remain separate from signed net premium and fees", () => {
  const config = portfolio([leg("CALL", "SELL", 100, 10), leg("CALL", "BUY", 120, 4)], 2);
  const metrics = Portfolio.metrics(config);
  assert.equal(metrics.premiumReceived, 10);
  assert.equal(metrics.premiumPaid, 4);
  assert.equal(metrics.netPremium, 6);
  assert.equal(metrics.fees, 2);
  assert.equal(metrics.maxProfit, 4);
  assert.equal(metrics.maxLoss, 16);
  assert.deepEqual(metrics.breakEvens, [104]);
});

test("fees can make every scenario lose with no zero roots", () => {
  const config = portfolio([leg("CALL", "BUY", 100, 10), leg("CALL", "SELL", 100, 10)], 5);
  const metrics = Portfolio.metrics(config);
  assert.equal(metrics.pnlMin, -5);
  assert.equal(metrics.pnlMax, -5);
  assert.equal(metrics.maxProfit, 0);
  assert.equal(metrics.maxLoss, 5);
  assert.deepEqual(metrics.breakEvens, []);
  assert.deepEqual(metrics.breakEvenRanges, []);
});

test("a tiny constant loss is not rounded into a zero-PnL band", () => {
  const config = portfolio([leg("CALL", "BUY", 100, 1), leg("CALL", "SELL", 100, 1)], 1e-100);
  const metrics = Portfolio.metrics(config);
  assert.equal(metrics.maxLoss, 1e-100);
  assert.deepEqual(metrics.breakEvens, []);
  assert.deepEqual(metrics.breakEvenRanges, []);
});

test("always-profitable input has a positive lower bound and no invented break-even", () => {
  const config = portfolio([leg("CALL", "SELL", 100, 35), leg("CALL", "BUY", 120, 5)]);
  const metrics = Portfolio.metrics(config);
  assert.equal(metrics.pnlMin, 10);
  assert.equal(metrics.pnlMax, 30);
  assert.equal(metrics.maxProfit, 30);
  assert.equal(metrics.maxLoss, 0);
  assert.deepEqual(metrics.breakEvens, []);
});

test("Put portfolio's finite low-side maximum honors the S=0 boundary", () => {
  const config = portfolio([leg("PUT", "BUY", 100, 150), leg("PUT", "BUY", 110, 160)]);
  const metrics = Portfolio.metrics(config);
  assert.equal(metrics.pnlMax, -100);
  assert.equal(metrics.pnlMin, -310);
  assert.equal(metrics.maxProfit, 0);
  assert.equal(metrics.maxLoss, 310);
  assert.deepEqual(metrics.breakEvens, []);
});

test("roots at S=0 or a shared strike are unique and retained", () => {
  const atZero = portfolio([leg("PUT", "BUY", 100, 100), leg("PUT", "BUY", 110, 110)]);
  assert.deepEqual(Portfolio.metrics(atZero).breakEvens, [0]);
  const atStrike = portfolio([leg("CALL", "BUY", 100, 5), leg("PUT", "SELL", 100, 5)]);
  assert.deepEqual(Portfolio.metrics(atStrike).breakEvens, [100]);
});

test("portfolio PnL equals the sum of its legs minus the extra portfolio fee", () => {
  const config = portfolio([
    leg("CALL", "BUY", 80, 4, 2, 0.5, 1), leg("CALL", "SELL", 120, 3, 2, 0.25, 2),
    leg("PUT", "BUY", 90, 5, 3, 0.5, 3), leg("PUT", "SELL", 130, 8, 1, 0.5, 4)
  ], 5);
  for (const price of [0, 50, 80, 90, 100, 120, 130, 1000]) {
    close(Portfolio.pnl(config, price), config.legs.reduce((total, row) => total + Payoff.pnl(row, price), -config.fees));
  }
});

test("validation normalizes numeric strings without mutating source objects", () => {
  const input = {legs: [leg("CALL", "BUY", "100", "10", "1", "1", "0"), leg("PUT", "BUY", "100", "10", "1", "1", "0")], fees: "2"};
  const result = Portfolio.validate(input);
  assert.equal(result.valid, true);
  assert.equal(result.config.fees, 2);
  assert.equal(result.config.legs[0].strike, 100);
  result.config.legs[0].strike = 200;
  assert.equal(input.legs[0].strike, "100");
});

test("invalid portfolio, leg and settlement values give actionable RangeErrors", () => {
  const valid = portfolio([leg("CALL", "BUY", 100, 10), leg("PUT", "BUY", 100, 10)]);
  for (const invalid of [null, [], {}, {legs: [], fees: 0}, {legs: [valid.legs[0]], fees: 0}, {...valid, fees: -1}, {...valid, fees: ""}, {...valid, fees: true}, {...valid, fees: Infinity}, {...valid, legs: [valid.legs[0], {...valid.legs[1], premium: 0}]}, {...valid, legs: [valid.legs[0], {...valid.legs[1], direction: "HOLD"}]}]) {
    assert.equal(Portfolio.validate(invalid).valid, false);
    assert.throws(() => Portfolio.metrics(invalid), RangeError);
    assert.throws(() => Portfolio.pnl(invalid, 100), RangeError);
  }
  const errors = Portfolio.validate({...valid, legs: [valid.legs[0], {...valid.legs[1], premium: 0}]}).errors;
  assert.equal(errors[0].field, "legs.1.premium");
  for (const invalidPrice of [-1, "", null, true, Infinity, NaN]) assert.throws(() => Portfolio.pnl(valid, invalidPrice), RangeError);
});

test("aggregate premium, slope and scenario overflow throw rather than masquerading as infinity bounds", () => {
  const premiumOverflow = portfolio([leg("CALL", "BUY", 1, 1e308), leg("CALL", "BUY", 1, 1e308)]);
  assert.equal(Portfolio.validate(premiumOverflow).valid, false);
  assert.throws(() => Portfolio.metrics(premiumOverflow), RangeError);
  const slopeOverflow = portfolio([leg("CALL", "BUY", 1, 1e-308, 1e308), leg("CALL", "BUY", 1, 1e-308, 1e308)]);
  assert.equal(Portfolio.validate(slopeOverflow).valid, false);
  assert.throws(() => Portfolio.metrics(slopeOverflow), RangeError);
  const scenarioOverflow = portfolio([leg("CALL", "BUY", 1, 1, 1e100), leg("PUT", "BUY", 1, 1)]);
  assert.throws(() => Portfolio.pnl(scenarioOverflow, 1e308), RangeError);
});

test("a mathematically finite but unrepresentable break-even is reported as overflow", () => {
  const config = portfolio([leg("CALL", "BUY", 1, 1, 1e-300), leg("CALL", "SELL", 1, 1, 1e-300)], 1);
  // Change one leg after normalization: two tiny residual exposures and a
  // large fee make the theoretical root exceed Number.MAX_VALUE.
  config.legs[0].quantity = 2e-300;
  config.fees = 1e100;
  assert.equal(Portfolio.validate(config).valid, true);
  assert.throws(() => Portfolio.metrics(config), RangeError);
});

test("browser UMD exposes the same immutable API and depends on OptionPayoff", () => {
  const context = vm.createContext({OptionPayoff: Payoff});
  vm.runInContext(fs.readFileSync(modelPath, "utf8"), context);
  assert.equal(typeof context.OptionPortfolio.pnl, "function");
  assert.equal(Object.isFrozen(context.OptionPortfolio), true);
  const config = portfolio([leg("CALL", "BUY", 100, 10), leg("PUT", "BUY", 100, 10)]);
  assert.equal(context.OptionPortfolio.pnl(config, 100), -20);
  assert.throws(() => vm.runInNewContext(fs.readFileSync(modelPath, "utf8"), {}), /OptionPayoff must load/);
});

console.log(`${count} portfolio checks passed.`);
