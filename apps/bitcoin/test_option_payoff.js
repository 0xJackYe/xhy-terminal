"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const modelPath = path.join(__dirname, "dashboard", "dist", "payoff.js");
const model = require(modelPath);
const base = {type: "CALL", direction: "BUY", strike: 100, premium: 10, quantity: 2, unit: 0.5, fees: 2};
let count = 0;
function test(name, run) {run(); count++; console.log(`OK ${name}`);}
function close(actual, expected, tolerance = 1e-9) {assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);}

test("four directions produce the expected expiry bounds and break-even", () => {
  const cases = [
    {type: "CALL", direction: "BUY", min: -12, max: Infinity, root: 112, profit: Infinity, loss: 12},
    {type: "CALL", direction: "SELL", min: -Infinity, max: 8, root: 108, profit: 8, loss: Infinity},
    {type: "PUT", direction: "BUY", min: -12, max: 88, root: 88, profit: 88, loss: 12},
    {type: "PUT", direction: "SELL", min: -92, max: 8, root: 92, profit: 8, loss: 92}
  ];
  for (const row of cases) {
    const config = {...base, type: row.type, direction: row.direction};
    const metrics = model.metrics(config);
    assert.equal(metrics.exposure, 1);
    assert.equal(metrics.premiumTotal, 10);
    assert.equal(metrics.pnlMin, row.min);
    assert.equal(metrics.pnlMax, row.max);
    assert.equal(metrics.maxProfit, row.profit);
    assert.equal(metrics.maxLoss, row.loss);
    assert.equal(metrics.breakEven, row.root);
    assert.deepEqual(metrics.breakEvenRange, [row.root, row.root]);
    close(model.pnl(config, row.root), 0);
  }
});

test("out-of-the-money and at-strike buyer loses premium plus total fees", () => {
  for (const config of [{...base, type: "CALL"}, {...base, type: "PUT"}]) {
    assert.equal(model.pnl(config, 100), -12);
    assert.equal(model.pnl(config, config.type === "CALL" ? 50 : 150), -12);
  }
});

test("Put domain ends at S=0 and has finite profit/loss boundaries", () => {
  const buy = {...base, type: "PUT"};
  const sell = {...buy, direction: "SELL"};
  assert.equal(model.pnl(buy, 0), 88);
  assert.equal(model.pnl(sell, 0), -92);
  assert.equal(model.pnl(buy, 1e9), -12);
  assert.equal(model.pnl(sell, 1e9), 8);
});

test("Call bounds are theoretical infinities outside a finite chart window", () => {
  assert.equal(model.metrics(base).maxProfit, Infinity);
  assert.equal(model.metrics({...base, direction: "SELL"}).maxLoss, Infinity);
  assert.equal(model.pnl(base, 1100), 988);
  assert.equal(model.pnl({...base, direction: "SELL"}, 1100), -992);
});

test("quantity times unit scales payout/premium and aggregate fees apply once", () => {
  const config = {...base, premium: 250, strike: 64000, quantity: 3, unit: 0.1, fees: 5};
  const metrics = model.metrics(config);
  close(metrics.exposure, 0.3);
  close(metrics.premiumTotal, 75);
  close(model.pnl(config, 65000), 220);
  close(model.pnl(config, 64000), -80);
  close(metrics.breakEven, 64250 + 5 / 0.3);
});

test("premium above strike can make a long Put lose in every scenario", () => {
  const config = {...base, type: "PUT", premium: 150, fees: 0};
  const metrics = model.metrics(config);
  assert.equal(metrics.pnlMin, -150);
  assert.equal(metrics.pnlMax, -50);
  assert.equal(metrics.maxProfit, 0);
  assert.equal(metrics.maxLoss, 150);
  assert.equal(metrics.breakEven, null);
  assert.equal(metrics.breakEvenRange, null);
  assert.equal(model.pnl(config, 0), -50);
});

test("premium above strike can make a short Put profitable in every scenario", () => {
  const config = {...base, type: "PUT", direction: "SELL", premium: 150, fees: 0};
  const metrics = model.metrics(config);
  assert.equal(metrics.pnlMin, 50);
  assert.equal(metrics.pnlMax, 150);
  assert.equal(metrics.maxProfit, 150);
  assert.equal(metrics.maxLoss, 0);
  assert.equal(metrics.breakEven, null);
});

test("Put break-even at zero is valid and premium=strike creates no negative root", () => {
  for (const direction of ["BUY", "SELL"]) {
    const config = {...base, type: "PUT", direction, premium: 100, fees: 0};
    assert.equal(model.metrics(config).breakEven, 0);
    assert.deepEqual(model.metrics(config).breakEvenRange, [0, 0]);
    assert.equal(model.pnl(config, 0), 0);
  }
});
test("fractional currency/exposure cannot move an exact S=0 root below zero", () => {
  for (const direction of ["BUY", "SELL"]) {
    const config = {...base, type: "PUT", direction, strike: 0.1, premium: 0.1, quantity: 3, unit: 1, fees: 0};
    assert.equal(model.pnl(config, 0), 0);
    assert.equal(model.metrics(config).breakEven, 0);
  }
});

test("fee-neutral short options have flat zero-PnL settlement intervals", () => {
  const call = {...base, direction: "SELL", fees: 10};
  const put = {...call, type: "PUT"};
  assert.equal(model.metrics(call).breakEven, 100);
  assert.deepEqual(model.metrics(call).breakEvenRange, [0, 100]);
  assert.deepEqual(model.metrics(put).breakEvenRange, [100, Infinity]);
  for (const settlement of [0, 50, 100]) assert.equal(model.pnl(call, settlement), 0);
  for (const settlement of [100, 500, 1e6]) assert.equal(model.pnl(put, settlement), 0);
});

test("fees above received premium remove every short-option break-even", () => {
  for (const type of ["CALL", "PUT"]) {
    const config = {...base, type, direction: "SELL", fees: 11};
    const metrics = model.metrics(config);
    assert.equal(metrics.breakEven, null);
    assert.equal(metrics.breakEvenRange, null);
    assert.equal(metrics.maxProfit, 0);
    assert.equal(metrics.pnlMax, -1);
  }
});

test("fees can eliminate Put profit, with S=0 as the exact boundary", () => {
  const zeroAtOrigin = {...base, type: "PUT", fees: 90};
  assert.equal(model.metrics(zeroAtOrigin).pnlMax, 0);
  assert.equal(model.metrics(zeroAtOrigin).breakEven, 0);
  const allLoss = {...zeroAtOrigin, fees: 91};
  assert.equal(model.metrics(allLoss).pnlMax, -1);
  assert.equal(model.metrics(allLoss).breakEven, null);
});

test("all specified nonfinite, blank, boolean, zero and negative inputs fail", () => {
  for (const field of ["strike", "premium", "quantity", "unit"]) {
    for (const value of [null, undefined, "", "  ", 0, -0, -1, Infinity, -Infinity, NaN, "NaN", true, false, [], {}]) {
      const result = model.validate({...base, [field]: value});
      assert.equal(result.valid, false, `${field}=${String(value)}`);
      assert.equal(result.config, null);
      assert.ok(result.errors.some((error) => error.field === field));
      assert.throws(() => model.metrics({...base, [field]: value}), RangeError);
    }
  }
  for (const value of [null, undefined, "", " ", -1, Infinity, NaN, true, [], {}]) assert.equal(model.validate({...base, fees: value}).valid, false);
  for (const config of [null, undefined, [], "config"]) assert.equal(model.validate(config).valid, false);
  assert.equal(model.validate({...base, type: "call"}).valid, false);
  assert.equal(model.validate({...base, direction: "LONG"}).valid, false);
});

test("settlement is finite/nonnegative, including a valid zero", () => {
  assert.equal(model.pnl(base, 0), -12);
  for (const value of [-1, null, undefined, "", " ", Infinity, -Infinity, NaN, true, [], {}]) assert.throws(() => model.pnl(base, value), RangeError);
});

test("numeric string normalization does not mutate caller input", () => {
  const input = Object.freeze({type: "CALL", direction: "BUY", strike: "100", premium: " 10 ", quantity: "2", unit: "0.5", fees: "0"});
  const result = model.validate(input);
  assert.equal(result.valid, true);
  assert.equal(result.config.premium, 10);
  assert.equal(result.config.fees, 0);
  assert.equal(input.premium, " 10 ");
  assert.equal(model.pnl(input, "120"), 10);
});

test("overflow/underflow cannot masquerade as genuine unlimited risk", () => {
  assert.equal(model.validate({...base, quantity: 1e308, unit: 1e308}).valid, false);
  assert.equal(model.validate({...base, quantity: Number.MIN_VALUE, unit: 0.5}).valid, false);
  assert.equal(model.validate({...base, premium: 1e308, quantity: 3, unit: 1}).valid, false);
  assert.throws(() => model.pnl({...base, quantity: 1e100, unit: 1}, 1e308), RangeError);
});

test("buyer/seller PnLs are opposite before fees across the settlement domain", () => {
  for (const type of ["CALL", "PUT"]) {
    for (const settlement of [0, 25, 99, 100, 101, 500, 1e6]) {
      const buy = {...base, type, fees: 0};
      const sell = {...buy, direction: "SELL"};
      close(model.pnl(buy, settlement) + model.pnl(sell, settlement), 0);
      const feesBuy = {...buy, fees: 3.2}, feesSell = {...sell, fees: 4.5};
      close(model.pnl(feesBuy, settlement) + model.pnl(feesSell, settlement), -7.7);
    }
  }
});

test("UMD exposes the same standalone browser global without DOM dependencies", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(modelPath, "utf8"), context);
  assert.equal(typeof context.OptionPayoff.validate, "function");
  assert.equal(context.OptionPayoff.pnl(base, 120), 8);
  assert.equal(context.OptionPayoff.metrics({...base, type: "PUT"}).maxProfit, 88);
  assert.equal(Object.isFrozen(context.OptionPayoff), true);
});

console.log(`${count} option payoff checks passed.`);
