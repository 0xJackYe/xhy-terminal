"use strict";

// Execute the real UI scripts and listeners with a controlled clock. These
// checks exercise expiry/refresh state without network calls or real sleeps.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const OptionPayoff = require("./dashboard/dist/payoff.js");
const OptionPortfolio = require("./dashboard/dist/portfolio.js");

function harness(file) {
  let now = Date.parse("2030-01-01T00:00:00Z"), nextTimer = 0;
  const timers = new Map(), nodes = new Map();
  class Node {
    constructor() {this.listeners = {}; this.dataset = {}; this.hidden = false; this.open = false; this.value = ""; this.clientWidth = 760; this.isConnected = true; this.children = new Map(); this.classList = {toggle() {}, remove() {}, add() {}}; this.htmlWrites = 0; this._innerHTML = "";}
    get innerHTML() {return this._innerHTML;}
    set innerHTML(value) {this._innerHTML = value; this.htmlWrites++;}
    addEventListener(type, listener) {(this.listeners[type] ??= []).push(listener);}
    async fire(type, event = {}) {for (const fn of this.listeners[type] ?? []) await fn({target: this, ...event});}
    setAttribute() {}
    focus() {}
    querySelector(selector) {if (!this.children.has(selector)) this.children.set(selector, new Node()); return this.children.get(selector);}
    querySelectorAll() {return [];}
    showModal() {this.open = true;}
    close() {this.open = false; for (const fn of this.listeners.close ?? []) fn();}
    appendChild(node) {nodes.set(node.id, node);}
    getBoundingClientRect() {return {left: 0, top: 0, right: 760, bottom: 700};}
  }
  const node = (id) => {if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id);};
  class ClockDate extends Date {constructor(...args) {super(...(args.length ? args : [now]));} static now() {return now;}}
  const window = {innerWidth: 1200, addEventListener() {}};
  const context = vm.createContext({window, document: {getElementById: node, createElement: () => new Node(), querySelectorAll: () => [], body: new Node(), activeElement: new Node()}, OptionPayoff, OptionPortfolio, Date: ClockDate, Intl, console, RangeError,
    setInterval: (fn) => {timers.set(++nextTimer, fn); return nextTimer;}, clearInterval: (id) => timers.delete(id)});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "dashboard", "dist", file), "utf8"), context);
  const row = (side = "CALL", expiry = now + 2000) => ({symbol: `BTC-300101-80000-${side === "CALL" ? "C" : "P"}`, side, strike_price: "80000", unit: "1", min_qty: "0.01", ask_price: "500", bid_price: "480", expiry_ms: expiry});
  const snapshot = (offset = 0) => ({btc_index_price: "85000", fetched_at: new Date(now).toISOString(), exchange_clock_offset_ms: offset, stale: false});
  const market = (contract = row(), offset = 0) => ({row: contract, snapshot: snapshot(offset)});
  const openSingle = (value, latest = () => value, direction = "BUY") => window.OptionPayoffPreview.open(value, direction, latest, {dataset: {symbol: value.row.symbol, column: direction === "SELL" ? "bid" : "ask"}});
  const legs = (expiry = now + 2000) => ["CALL", "PUT"].map(side => ({row: row(side, expiry), direction: "BUY", premium: "500", quantity: "0.01"}));
  const openCombo = (value, latest) => window.OptionPortfolioPreview.open({legs: value, snapshot: snapshot(), getLatest: latest});
  return {node, market, snapshot, legs, openSingle, openCombo, timers, advance: ms => {now += ms;}, tick: () => {for (const fn of [...timers.values()]) fn();}, input: async (id, value) => {node(id).value = String(value); await node(id).fire("input");}};
}

let count = 0;
const check = async (name, fn) => {await fn(); count++; console.log(`OK ${name}`);};
const dayMs = 86400000, initialTime = Date.parse("2030-01-01T00:00:00Z");
const dailyMarket = (h, side = "PUT", days = 10, offset = 0, overrides = {}) => h.market({...h.market().row, side, symbol: `BTC-300111-80000-${side === "PUT" ? "P" : "C"}`, expiry_ms: initialTime + days * dayMs, bid_price: "1000", ask_price: "2000", ...overrides}, offset);
const dailyAmount = (h) => Number(String(h.node("payoffDailyPremium").textContent).replace(/,/g, ""));
const directionClick = (h, direction) => h.node("payoffDirections").fire("click", {target: {closest: () => ({dataset: {direction}})}});
const clearedDaily = (h) => {assert.equal(h.node("payoffDailyPremiumCard").hidden, true); assert.ok(["", "—"].includes(h.node("payoffDailyPremium").textContent), "unavailable daily amount must not retain its previous numeric value");};
(async () => {
  await check("idle single preview expires at the calibrated exchange boundary and clears its timer on close", async () => {
    const h = harness("payoff-ui.js"), value = h.market(undefined, 500);
    h.openSingle(value); assert.equal(h.node("payoffResults").hidden, false); assert.equal(h.timers.size, 1);
    h.advance(1499); h.tick(); assert.equal(h.node("payoffResults").hidden, false);
    h.advance(1); h.tick(); assert.equal(h.node("payoffResults").hidden, true); assert.match(h.node("payoffError").textContent, /已到期/);
    await h.input("payoffQuantity", "0.3"); assert.equal(h.node("payoffResults").hidden, true);
    await h.node("payoffDirections").fire("click", {target: {closest: () => ({dataset: {direction: "SELL"}})}});
    assert.equal(h.node("payoffResults").hidden, true);
    h.node("payoffDialog").close(); assert.equal(h.timers.size, 0);
    h.openSingle(h.market()); assert.equal(h.node("payoffResults").hidden, false); assert.equal(h.timers.size, 1);
    h.node("payoffDialog").close();
  });
  await check("single input validates expiry even before the timer fires", async () => {
    const h = harness("payoff-ui.js"); h.openSingle(h.market()); h.advance(2000);
    await h.input("payoffSettlement", "90000"); assert.equal(h.node("payoffResults").hidden, true); assert.match(h.node("payoffError").textContent, /已到期/);
  });
  await check("removed single contract stays paused after input, then explicit successful refresh restores preserved parameters", async () => {
    const h = harness("payoff-ui.js"), value = h.market(); let latest = value;
    h.openSingle(value, () => latest); await h.input("payoffQuantity", ".25"); await h.input("payoffFees", "7"); await h.input("payoffSettlement", "85000");
    latest = {snapshot: h.snapshot()}; await h.node("payoffRefresh").fire("click");
    assert.equal(h.node("payoffResults").hidden, true); await h.input("payoffQuantity", ".3"); assert.equal(h.node("payoffResults").hidden, true);
    latest = {...value, row: {...value.row, ask_price: "600"}}; await h.node("payoffRefresh").fire("click");
    assert.equal(h.node("payoffResults").hidden, false); assert.equal(h.node("payoffQuantity").value, ".3"); assert.equal(h.node("payoffFees").value, "7"); assert.equal(h.node("payoffSettlement").value, "85000"); assert.equal(h.node("payoffScenarioPnl").textContent, "+1,313");
  });
  await check("single refresh exception is persistent and an expired refresh never restores results", async () => {
    const h = harness("payoff-ui.js"), value = h.market(); let fail = true;
    h.openSingle(value, () => {if (fail) throw new Error("offline"); return value;});
    await h.node("payoffRefresh").fire("click"); await h.input("payoffFees", "1"); assert.equal(h.node("payoffResults").hidden, true);
    fail = false; h.advance(2000); await h.node("payoffRefresh").fire("click"); assert.equal(h.node("payoffResults").hidden, true); assert.match(h.node("payoffError").textContent, /已到期/);
  });
  await check("idle combination expires without recomputing its frozen graph and stops timer on close", async () => {
    const h = harness("portfolio-ui.js"), legs = h.legs(); h.openCombo(legs, () => ({legs, snapshot: h.snapshot()}));
    assert.equal(h.node("portfolioResults").hidden, false); const chart = h.node("portfolioChart").innerHTML;
    h.advance(1999); h.tick(); assert.equal(h.node("portfolioResults").hidden, false); assert.equal(h.node("portfolioChart").innerHTML, chart);
    h.advance(1); h.tick(); assert.equal(h.node("portfolioResults").hidden, true); assert.match(h.node("portfolioError").textContent, /已到期/);
    await h.input("portfolioFees", "1"); assert.equal(h.node("portfolioResults").hidden, true);
    h.node("portfolioDialog").close(); assert.equal(h.timers.size, 0);
    h.openCombo(h.legs()); assert.equal(h.node("portfolioResults").hidden, false); assert.equal(h.timers.size, 1); h.node("portfolioDialog").close();
  });
  await check("combination refresh failure stays paused until a successful refresh preserves fees and scenario", async () => {
    const h = harness("portfolio-ui.js"), legs = h.legs(); let latest = {legs, snapshot: h.snapshot()};
    h.openCombo(legs, () => latest); await h.input("portfolioFees", "7"); await h.input("portfolioSettlement", "90000");
    latest = {error: "合约已移除"}; await h.node("portfolioRefresh").fire("click"); await h.input("portfolioFees", "9"); assert.equal(h.node("portfolioResults").hidden, true);
    latest = {legs, snapshot: h.snapshot()}; await h.node("portfolioRefresh").fire("click");
    assert.equal(h.node("portfolioResults").hidden, false); assert.equal(h.node("portfolioFees").value, "9"); assert.equal(h.node("portfolioSettlement").value, "90000"); assert.equal(h.node("portfolioPnl").textContent, "+81");
  });
  await check("single UI accepts zero settlement, rejects negative settlement and fees, and recovers without replacing its fixed quote", async () => {
    const h = harness("payoff-ui.js");h.openSingle(h.market());
    await h.input("payoffSettlement", "0");assert.equal(h.node("payoffResults").hidden, false);assert.equal(h.node("payoffScenarioPnl").textContent, "-5");
    await h.input("payoffSettlement", "-1");assert.equal(h.node("payoffResults").hidden, true);
    await h.input("payoffSettlement", "85000");await h.input("payoffFees", "-1");assert.equal(h.node("payoffResults").hidden, true);
    await h.input("payoffFees", "0");assert.equal(h.node("payoffResults").hidden, false);assert.equal(h.node("payoffPremium").value, "500");
    h.node("payoffDialog").close();
  });
  await check("single missing reference quote stays unavailable until an explicit custom positive premium", async () => {
    const h = harness("payoff-ui.js"), value=h.market();value.row.ask_price=null;h.openSingle(value);
    assert.equal(h.node("payoffResults").hidden, true);assert.match(h.node("payoffError").textContent,/没有有效正报价/);
    await h.input("payoffPremium", "200");assert.equal(h.node("payoffResults").hidden, false);assert.match(h.node("payoffQuoteNote").textContent,/自定义/);
    h.node("payoffDialog").close();
  });
  await check("combination UI rejects different precise expiry instants and only one remaining leg", async () => {
    const h=harness("portfolio-ui.js"), legs=h.legs();legs[1].row.expiry_ms++;
    h.openCombo(legs);assert.equal(h.node("portfolioResults").hidden,true);assert.match(h.node("portfolioError").textContent,/相同到期/);
    h.openCombo(h.legs());assert.equal(h.node("portfolioResults").hidden,false);
    await h.node("portfolioLegs").fire("click",{target:{closest:()=>({dataset:{remove:"0"}})}});
    assert.equal(h.node("portfolioResults").hidden,true);assert.match(h.node("portfolioError").textContent,/至少需要 2/);
    h.node("portfolioDialog").close();
  });
  await check("a retired asynchronous combo refresh cannot pause a newly opened combination or unlock its pending refresh", async () => {
    const h=harness("portfolio-ui.js"), legs=h.legs();let rejectOld,resolveNew;
    h.openCombo(legs,()=>new Promise((_,reject)=>{rejectOld=reject;}));
    const oldRefresh=h.node("portfolioRefresh").fire("click");h.node("portfolioDialog").close();
    h.openCombo(h.legs(),()=>new Promise(resolve=>{resolveNew=resolve;}));
    const newRefresh=h.node("portfolioRefresh").fire("click");
    assert.equal(typeof resolveNew,"function");assert.equal(h.node("portfolioRefresh").disabled,true);
    rejectOld(new Error("retired connection"));await oldRefresh;
    assert.equal(h.node("portfolioResults").hidden,false);assert.equal(h.node("portfolioRefresh").disabled,true);
    resolveNew({legs:h.legs(),snapshot:h.snapshot()});await newRefresh;
    assert.equal(h.node("portfolioResults").hidden,false);assert.equal(h.node("portfolioRefresh").disabled,false);
    h.node("portfolioDialog").close();
  });
  await check("SELL Put and Call show ten USDT premium over ten days as one USDT per day", () => {
    for (const side of ["PUT", "CALL"]) {
      const h = harness("payoff-ui.js"); h.openSingle(dailyMarket(h, side), undefined, "SELL");
      assert.equal(h.node("payoffResults").hidden, false); assert.equal(h.node("payoffDailyPremiumCard").hidden, false);
      assert.equal(h.node("payoffPremiumTotal").textContent, "10"); assert.equal(dailyAmount(h), 1);
      assert.match(h.node("payoffHeading").textContent, new RegExp(`卖出 ${side === "PUT" ? "Put" : "Call"}`));
      assert.match(h.node("payoffDailyPremiumNote").textContent, /USDT\s*\/\s*日/);
      assert.match(h.node("payoffDailyPremiumNote").textContent, /剩余\s*10\s*天/);
      assert.match(h.node("payoffDailyPremiumNote").textContent, /未扣费用/);
      assert.doesNotMatch(h.node("payoffDailyPremiumNote").textContent, /收益率|现金覆盖|%/);
      h.node("payoffDialog").close();
    }
  });
  await check("six hours to expiry are a quarter day rather than one whole calendar day", () => {
    const h = harness("payoff-ui.js"); h.openSingle(dailyMarket(h, "PUT", .25), undefined, "SELL");
    assert.equal(dailyAmount(h), 40); assert.match(h.node("payoffDailyPremiumNote").textContent, /剩余\s*0\.25\s*天/);
  });
  await check("daily premium uses the calibrated exchange clock for positive and negative offsets", () => {
    for (const [days, offset, expected] of [[.5, .25 * dayMs, 40], [.25, -.25 * dayMs, 20]]) {
      const h = harness("payoff-ui.js"); h.openSingle(dailyMarket(h, "CALL", days, offset), undefined, "SELL");
      assert.equal(dailyAmount(h), expected); assert.equal(h.node("payoffDailyPremiumCard").hidden, false);
    }
  });
  await check("a precise date fallback retains the time of day in the daily denominator", () => {
    const h = harness("payoff-ui.js"), value = dailyMarket(h, "PUT", 1.5);
    value.row.expiry_beijing = new Date(value.row.expiry_ms).toISOString(); delete value.row.expiry_ms;
    h.openSingle(value, undefined, "SELL");
    assert.ok(Math.abs(dailyAmount(h) - 10 / 1.5) < 1e-7); assert.match(h.node("payoffDailyPremiumNote").textContent, /剩余\s*1\.5\s*天/);
  });
  await check("quantity and custom premium scale gross daily premium while settlement does not", async () => {
    const h = harness("payoff-ui.js"); h.openSingle(dailyMarket(h), undefined, "SELL");
    await h.input("payoffQuantity", ".03"); assert.equal(dailyAmount(h), 3);
    await h.input("payoffPremium", "2000"); assert.equal(dailyAmount(h), 6); assert.match(h.node("payoffQuoteNote").textContent, /自定义/);
    await h.input("payoffSettlement", "0"); assert.equal(dailyAmount(h), 6);
    await h.input("payoffSettlement", "100000"); assert.equal(dailyAmount(h), 6);
  });
  await check("fees reduce net profit but never turn gross daily premium into net daily profit", async () => {
    const h = harness("payoff-ui.js"); h.openSingle(dailyMarket(h), undefined, "SELL");
    assert.equal(dailyAmount(h), 1); await h.input("payoffFees", "20");
    assert.equal(dailyAmount(h), 1); assert.equal(h.node("payoffMaxProfit").textContent, "0");
    assert.match(h.node("payoffDailyPremiumNote").textContent, /未扣费用/);
  });
  await check("small positive daily premiums retain a nonzero value instead of rounding to zero", () => {
    const h = harness("payoff-ui.js"); h.openSingle(dailyMarket(h, "PUT", 10, 0, {bid_price: "0.000001"}), undefined, "SELL");
    assert.equal(h.node("payoffDailyPremiumCard").hidden, false); assert.equal(dailyAmount(h), 1e-9);
    assert.notEqual(h.node("payoffDailyPremium").textContent, "0"); assert.doesNotMatch(h.node("payoffDailyPremium").textContent, /NaN|Infinity/);
  });
  await check("BUY hides and clears sell-only daily premium and changing back uses the bid quote", async () => {
    const h = harness("payoff-ui.js"); h.openSingle(dailyMarket(h), undefined, "SELL"); assert.equal(dailyAmount(h), 1);
    await directionClick(h, "BUY"); clearedDaily(h); assert.equal(h.node("payoffPremiumTotal").textContent, "20");
    await directionClick(h, "SELL"); assert.equal(h.node("payoffDailyPremiumCard").hidden, false); assert.equal(dailyAmount(h), 1);
  });
  await check("the open-dialog timer updates only daily text without rewriting the fixed-price chart", () => {
    const h = harness("payoff-ui.js"); h.openSingle(dailyMarket(h, "CALL", 1), undefined, "SELL");
    const chart = h.node("payoffChart"), writes = chart.htmlWrites, svg = chart.innerHTML;
    assert.equal(dailyAmount(h), 10); h.advance(.5 * dayMs); h.tick();
    assert.equal(dailyAmount(h), 20); assert.match(h.node("payoffDailyPremiumNote").textContent, /剩余\s*0\.5\s*天/);
    assert.equal(chart.htmlWrites, writes, "a clock tick must not rebuild the chart"); assert.equal(chart.innerHTML, svg);
    assert.equal(h.node("payoffPremium").value, "1000"); h.node("payoffDialog").close(); assert.equal(h.timers.size, 0);
  });
  await check("daily premium is cleared on expiry and does not emit an infinite per-day amount", async () => {
    const h = harness("payoff-ui.js"); h.openSingle(dailyMarket(h, "PUT", 1), undefined, "SELL");
    h.advance(dayMs); h.tick(); clearedDaily(h); assert.equal(h.node("payoffResults").hidden, true);
    assert.match(h.node("payoffError").textContent, /已到期/); await h.input("payoffQuantity", ".03"); clearedDaily(h);
    assert.doesNotMatch(String(h.node("payoffDailyPremium").textContent), /Infinity|NaN/);
  });
  await check("invalid inputs and missing quotes cannot leave a stale daily premium visible", async () => {
    const h = harness("payoff-ui.js"); h.openSingle(dailyMarket(h), undefined, "SELL");
    await h.input("payoffQuantity", "0"); clearedDaily(h); await h.input("payoffQuantity", ".01"); assert.equal(dailyAmount(h), 1);
    await h.input("payoffPremium", ""); clearedDaily(h); await h.input("payoffPremium", "1000"); assert.equal(dailyAmount(h), 1);
    const missing = dailyMarket(h, "CALL", 10, 0, {bid_price: null}); h.openSingle(missing, undefined, "SELL"); clearedDaily(h);
    await h.input("payoffPremium", "1000"); assert.equal(dailyAmount(h), 1);
  });
  await check("explicit quote refresh recalculates daily premium and preserves quantity fees and scenario", async () => {
    const h = harness("payoff-ui.js"), value = dailyMarket(h); let latest = value;
    h.openSingle(value, () => latest, "SELL"); await h.input("payoffQuantity", ".02"); await h.input("payoffFees", "7"); await h.input("payoffSettlement", "70000");
    assert.equal(dailyAmount(h), 2); h.advance(dayMs);
    latest = {...value, row: {...value.row, bid_price: "2000"}, snapshot: h.snapshot()};
    await h.node("payoffRefresh").fire("click");
    assert.ok(Math.abs(dailyAmount(h) - 40 / 9) < 1e-7); assert.match(h.node("payoffDailyPremiumNote").textContent, /剩余\s*9\s*天/);
    assert.equal(h.node("payoffQuantity").value, ".02"); assert.equal(h.node("payoffFees").value, "7"); assert.equal(h.node("payoffSettlement").value, "70000");
  });
  await check("failed refresh clears daily premium and timer cannot resurrect it before recovery", async () => {
    const h = harness("payoff-ui.js"), value = dailyMarket(h); let fail = true;
    h.openSingle(value, () => {if (fail) throw new Error("feed unavailable"); return value;}, "SELL"); assert.equal(dailyAmount(h), 1);
    await h.node("payoffRefresh").fire("click"); clearedDaily(h); h.advance(dayMs); h.tick(); clearedDaily(h);
    await h.input("payoffFees", "1"); clearedDaily(h); fail = false; await h.node("payoffRefresh").fire("click");
    assert.equal(h.node("payoffDailyPremiumCard").hidden, false); assert.ok(Math.abs(dailyAmount(h) - 10 / 9) < 1e-7);
  });
  console.log(`${count} preview UI checks passed.`);
})().catch(error => {console.error(error); process.exitCode = 1;});
