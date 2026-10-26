"use strict";

// Offline checks exercise the actual controller, pause clock and exported data.
// The pricing/margin engine has its own independent financial tests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ui = require("./dashboard/dist/sell-put-ui.js");
const source = fs.readFileSync(path.join(__dirname, "dashboard/dist/sell-put-ui.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "dashboard/dist/index.html"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "dashboard/dist/app.js"), "utf8");
const now = Date.parse("2030-01-01T00:00:00Z");
let checks = 0;
function check(name, fn) {fn(); checks++; console.log(`OK ${name}`);}
function entry(extra = {}) {
  return {symbol: "BTC-300116-60000-P", row: {symbol: "BTC-300116-60000-P", unit: 1, bid_price: "65", ask_price: "70", bid_quantity: "1", ask_quantity: "2", mark_iv: .6},
    expiryMs: now + 15 * 86400000, days: 15, strike: 60000, strikeRatio: .75, issue: null, warnings: [],
    metrics: {quantity: .12, grossPremium: 7.8, entryFee: .8, netPremium: 7, orderMargin: 990,
      positionMargin: 900, maintenanceMargin: 300, adjustedEquity: 999.2, equity: 999,
      marginRatio: .30024, accountDailyPct: .05, accountAnnualPct: 18.25,
      orderDailyPct: .06, orderAnnualPct: 21.9, cashDailyPct: .007,
      cashAnnualPct: 2.555, notional: 9600, cashSecuredCapital: 7200, breakEven: 59941.66, maxExpiryLoss: 7193},
    stress: [-.1, -.2, -.3].flatMap(movePct => [.6, .8, 1.2].map(vol => ({movePct, vol, pnl: -123.45, marginRatio: .9, state: "normal", mark: 100}))), ...extra};
}

function harness() {
  const nodes = new Map(), intervals = new Map(), timeouts = new Map(), listeners = {};
  let sequence = 0, clock = now, reads = 0, result = {rows: [entry()], issues: []};
  let snapshot = {options: [entry().row], btc_index_price: 80000, revision: 1};
  const evaluations = [];
  class Node {
    constructor(id) {this.id = id; this.value = ""; this.checked = false; this.hidden = false; this.open = false; this.disabled = false; this.innerHTML = ""; this.textContent = ""; this.dataset = {}; this.events = {}; this.attrs = {}; this.classList = {toggle() {}}; this.scrollLeft = 0; this.scrollTop = 0;}
    addEventListener(name, fn) {this.events[name] = fn;}
    setAttribute(name, value) {this.attrs[name] = value;}
    focus() {document.activeElement = this;}
    showModal() {this.open = true;}
    close() {this.open = false; this.events.close?.();}
    querySelectorAll() {return [];}
    fire(name, event = {}) {this.events[name]?.(event);}
  }
  const node = id => {if (!nodes.has(id)) nodes.set(id, new Node(id)); return nodes.get(id);};
  const document = {hidden: false, activeElement: node("origin"), getElementById: node,
    addEventListener: (name, callback) => {listeners[name] = callback;}};
  class Clock extends Date {static now() {return clock;}}
  const engine = {evaluate(snap, settings, at) {evaluations.push({snap, settings, at}); return result;}};
  const window = {SellPutEngine: engine};
  const context = vm.createContext({window, document, Date: Clock, Intl, console,
    setInterval(fn) {const id = ++sequence; intervals.set(id, fn); return id;},
    clearInterval(id) {intervals.delete(id);},
    setTimeout(fn) {const id = ++sequence; timeouts.set(id, fn); return id;},
    clearTimeout(id) {timeouts.delete(id);}, localStorage: {getItem: () => null, setItem() {}}});
  vm.runInContext(source, context);
  const controller = window.SellPutUI;
  const ids = {balance: "Balance", reserve: "Reserve", quantityMode: "QuantityMode", quantity: "Quantity", minDays: "MinDays", maxDays: "MaxDays", minStrikeRatio: "MinStrikeRatio", maxStrikeRatio: "MaxStrikeRatio", maxSpreadPct: "MaxSpreadPct", feeRate: "FeeRate", exerciseFeeRate: "ExerciseFeeRate", feeCap: "FeeCap", stressElapsedDays: "StressElapsedDays", sort: "Sort"};
  const percent = new Set(["minStrikeRatio", "maxStrikeRatio", "feeRate", "exerciseFeeRate", "feeCap"]);
  for (const [key, suffix] of Object.entries(ids)) node("sellPut" + suffix).value = String(percent.has(key) ? ui.DEFAULTS[key] * 100 : ui.DEFAULTS[key]);
  node("sellPutExpiry").value = "ALL";
  controller.initialize({getSnapshot: () => {reads++; return snapshot;}, getExpiry: () => "2030-01-16"});
  return {node, document, controller, evaluations, engine,
    readCount: () => reads, tick: () => {clock += 1000; [...intervals.values()].forEach(fn => fn());},
    intervalCount: () => intervals.size, setSnapshot: value => {snapshot = value;},
    setResult: value => {result = value;}, advance: amount => {clock += amount;},
    getNow: () => clock};
}

check("omitted settings have defaults but cleared fields cannot silently size a trade", () => {
  const blank = ui.parseSettings({balance: " ", minDays: "", maxDays: "", minStrikeRatio: "", maxStrikeRatio: ""});
  assert.ok(blank.errors.length >= 5); assert.deepEqual(ui.parseSettings({}).errors, []);
  assert.ok(ui.parseSettings({balance: "0"}).errors.length);
  assert.equal(ui.parseSettings({reserve: "0"}).settings.reserve, 0);
  const h = harness(); h.node("sellPutBalance").value = ""; h.controller.open();
  assert.equal(h.evaluations.length, 0); assert.equal(h.node("sellPutExport").disabled, true);
});
check("UI percentages convert once; API Pct outputs are already percentages", () => {
  const parsed = ui.parseSettings({minStrikeRatio: "75", maxStrikeRatio: "80", feeRate: "0.024", exerciseFeeRate: "0.015", feeCap: "10"});
  assert.deepEqual(parsed.errors, []); assert.equal(parsed.settings.minStrikeRatio, .75);
  assert.equal(parsed.settings.feeRate, .00024); assert.equal(parsed.settings.exerciseFeeRate, .00015);
  assert.equal(parsed.settings.feeCap, .1); assert.equal(parsed.settings.quantityMode, "maxMargin");
  assert.equal(parsed.settings.stressVols, undefined);
  const h = harness(); h.controller.open(h.node("sellPutButton"));
  assert.match(h.node("sellPutRows").innerHTML, /0\.05%/);
  assert.match(h.node("sellPutRows").innerHTML, /18\.25%/);
});
check("invalid inputs return visible errors instead of invoking the engine", () => {
  for (const raw of [{balance: "NaN"}, {minDays: 21, maxDays: 20}, {minStrikeRatio: 90, maxStrikeRatio: 80}, {reserve: 1000}, {feeCap: 101}, {stressElapsedDays: -1}, {quantityMode: "manual", quantity: 0}]) assert.ok(ui.parseSettings(raw).errors.length);
  const h = harness(); h.node("sellPutBalance").value = "-1"; h.controller.open();
  assert.equal(h.evaluations.length, 0); assert.equal(h.node("sellPutError").hidden, false);
  assert.match(h.node("sellPutError").textContent, /余额/);
  assert.equal(h.node("sellPutExport").disabled, true);
});
check("closed sessions never read snapshots and pause clones both data and clock", () => {
  let clock = now, calls = 0, snapshot = {options: [{bid_price: 65}]};
  const session = ui.createSession(() => {calls++; return snapshot;}, () => clock);
  assert.equal(session.read(), null); assert.equal(calls, 0);
  session.open(); const frozen = session.pause(); snapshot.options[0].bid_price = 999; clock += 86400000;
  assert.equal(session.read().snapshot.options[0].bid_price, 65);
  assert.equal(session.read().at, frozen.at); assert.equal(session.read().mode, "paused");
  const before = calls; session.read(); assert.equal(calls, before);
  const resumed = session.resume(); assert.equal(resumed.snapshot.options[0].bid_price, 999); assert.equal(resumed.at, clock);
  session.close(); assert.equal(session.read(), null);
});
check("the actual controller stops background calculation and freezes engine now", () => {
  const h = harness(); h.tick(); assert.equal(h.evaluations.length, 0);
  h.node("focusSellPutButton").fire("click"); assert.equal(h.node("sellPutDialog").open, true);
  assert.equal(h.evaluations.length, 1); assert.equal(h.intervalCount(), 1);
  h.node("sellPutPause").fire("click"); const fixed = h.evaluations.at(-1).at;
  h.tick(); assert.equal(h.evaluations.at(-1).at, fixed);
  assert.match(h.node("sellPutMode").textContent, /固定历史试算/);
  h.node("sellPutPause").fire("click"); h.tick(); assert.ok(h.evaluations.at(-1).at > fixed);
  const before = h.evaluations.length; h.document.hidden = true; h.tick(); assert.equal(h.evaluations.length, before);
  h.document.hidden = false; h.controller.close(); assert.equal(h.intervalCount(), 0);
  const closed = h.evaluations.length, reads = h.readCount(); h.tick();
  assert.equal(h.evaluations.length, closed); assert.equal(h.readCount(), reads);
});
check("standalone workbench cancel restores its trigger while only active dialogs retain quote Escape", () => {
  const h = harness(), trigger = h.node("focusSellPutButton"); h.controller.open(trigger);
  let prevented = false, stopped = false;
  h.node("sellPutDialog").fire("cancel", {preventDefault() {prevented = true;}, stopPropagation() {stopped = true;}});
  assert.equal(prevented, true); assert.equal(stopped, true); assert.equal(h.node("sellPutDialog").open, false);
  assert.equal(h.document.activeElement, trigger);
  let handler, exited = 0;
  const block = appSource.slice(appSource.indexOf('document.addEventListener("keydown",'), appSource.indexOf('$("comboButton").addEventListener'));
  const nodes = {payoffDialog: {open: false}, portfolioDialog: {open: false}, helpDialog: {open: false}, riskDialog: {open: false}, sellPutDialog: {open: true}, detailDrawer: {hidden: true}};
  const context = vm.createContext({$: id => nodes[id], document: {addEventListener: (_name, fn) => {handler = fn;}, body: {classList: {contains: () => true}}}, applyQuoteFocus: () => {exited++;}});
  vm.runInContext(block, context); handler({key: "Escape", preventDefault() {}}); assert.equal(exited, 1, "a retired workbench cannot consume the active chain Escape key");
  nodes.payoffDialog.open = true; handler({key: "Escape", preventDefault() {}}); assert.equal(exited, 1, "the active single-option payoff dialog retains Escape");
});
check("unavailable quotes stay visible with reasons and remote text is escaped", () => {
  const h = harness(); h.setResult({rows: [entry({symbol: '<img src=x onerror="evil()">', issue: '<script>stale</script>', metrics: null})], issues: ['<svg onload="evil()">']});
  h.controller.open(); assert.match(h.node("sellPutRows").innerHTML, /&lt;script&gt;stale/);
  assert.doesNotMatch(h.node("sellPutRows").innerHTML, /<script>|<img/);
  assert.equal(h.node("sellPutIssues").textContent, '<svg onload="evil()">');
  assert.equal(h.node("sellPutRecord").disabled, true);
  const valid = entry(), unavailable = entry({symbol: "unavailable", metrics: null, issue: "标记价已陈旧"});
  assert.equal(ui.filterVisible([valid, unavailable]).length, 2);
  assert.deepEqual(ui.filterVisible([valid, unavailable], {onlyCalculated: true}), [valid]);
});
check("CSV contains only current visible rows with inputs, snapshot mode and every return basis", () => {
  const visible = ui.filterVisible([entry(), entry({symbol: "hidden-stale", issue: "陈旧", metrics: null})], {onlyCalculated: true});
  const csv = ui.exportRows(visible, ui.DEFAULTS, {btc_index_price: 80000}, {mode: "paused", at: now, exportedAt: now + 1000});
  assert.ok(csv.startsWith("\uFEFF")); assert.match(csv, /固定历史试算/); assert.match(csv, /2030-01-01T00:00:00\.000Z/);
  assert.match(csv, /quantityMode/); assert.match(csv, /maxMargin/); assert.match(csv, /账户单利年化%/); assert.match(csv, /订单保证金单利年化%/); assert.match(csv, /足额赔付单利年化%/);
  assert.match(csv, /BTC-300116-60000-P/); assert.doesNotMatch(csv, /hidden-stale/);
  assert.equal(csv.split("\r\n").length, 2);
  const unsafe = ui.exportRows([entry({symbol: '=HYPERLINK("bad")', issue: '+bad'})], {}, {}, {});
  assert.match(unsafe, /"'=HYPERLINK/); assert.match(unsafe, /"'\+bad"/);
});
check("stress matrix presents supplied states and MM ratios without recomputing finance", () => {
  const value = entry(); value.stress[0] = {...value.stress[0], state: "margin-call", marginRatio: .8};
  value.stress[1] = {...value.stress[1], state: "liquidation"}; value.stress[2] = {...value.stress[2], state: "settled", pnl: 7, marginRatio: 0};
  const matrix = ui.stressMatrix(value);
  assert.match(matrix, /触及预警条件/); assert.doesNotMatch(matrix, /追加保证金/);
  assert.match(matrix, /触及强平条件/); assert.match(matrix, /已到期现金结算/); assert.match(matrix, /不保证此前能持有到期/);
  assert.match(matrix, /80%/); assert.match(matrix, /-123\.45/); assert.match(matrix, /\+7/);
  assert.equal((matrix.match(/<td /g) ?? []).length, 9);
});
check("pressure columns follow engine IV values and preserve capped duplicate columns", () => {
  const value = entry(); value.stress = [-.1, -.2, -.3].flatMap(movePct => [1.4, 1.6, 2].map(vol => ({movePct, vol, state: "normal", pnl: 0, marginRatio: .2})));
  let matrix = ui.stressMatrix(value);
  assert.match(matrix, /当前 IV · 140%/); assert.match(matrix, /\+20 点 · 160%/); assert.match(matrix, /\+60 点 · 200%/);
  value.stress = [-.1, -.2, -.3].flatMap(movePct => [4.8, 5, 5].map(vol => ({movePct, vol, state: "normal", pnl: 0, marginRatio: .2})));
  matrix = ui.stressMatrix(value); assert.equal((matrix.match(/<td /g) ?? []).length, 9);
  assert.match(matrix, /\+60 点 · 500%/);
  const h = harness(); h.controller.open();
  assert.match(h.node("sellPutDetail").innerHTML, /足额赔付资金 · 基数 7,200 USDT/);
  assert.doesNotMatch(h.node("sellPutDetail").innerHTML, /足额赔付资金 · 基数 9,600/);
});
check("temporary global issues retain labeled references while thrown errors clear results", () => {
  const h = harness(); h.controller.open(); h.setResult({rows: [], issues: ["行情元数据缺失"]}); h.tick();
  assert.equal(h.node("sellPutIssues").hidden, false); assert.match(h.node("sellPutIssues").textContent, /行情同步中/);
  assert.equal(h.node("sellPutIssues").title, "行情元数据缺失");
  assert.match(h.node("sellPutDetail").innerHTML, /参考快照，等待最新行情/);
  assert.equal(h.node("sellPutRecord").disabled, true);
  assert.equal(h.node("sellPutExport").disabled, false); // Current issue is exportable, never the retained money as current metrics.
  h.engine.evaluate = () => {throw new Error("internal");}; h.tick();
  assert.equal(h.node("sellPutError").hidden, false); assert.doesNotMatch(h.node("sellPutError").textContent, /internal/);
});
check("retired workbench modules are not loaded by the active quote page", () => {
  for (const file of ["sell-put-engine.js", "sell-put-ui.js", "sell-put.css"]) {
    assert.ok(fs.existsSync(path.join(__dirname, "dashboard/dist", file)));
    assert.ok(!html.includes('"/' + file + '"'));
  }
  for(const id of ["sellPutButton","focusSellPutButton","sellPutDialog"])assert.ok(!html.includes('id="'+id+'"'));
  assert.doesNotMatch(appSource, /SellPutUI|SellerScreenUI/);
  assert.doesNotMatch(source, /XMLHttpRequest|apiKey|secretKey|https?:\/\//);
  assert.match(source, /\/api\/mark-watch\?symbols=/);
  assert.equal((source.match(/root\.fetch\(/g) ?? []).length, 1);
});
check("removed personal Put preset cannot restrict the live chain", () => {
  assert.doesNotMatch(appSource,/ruleMatches|activeRuleMatches|state\.rule|toggleSideRule/);
  assert.doesNotMatch(html,/id="(?:ruleButton|callRuleButton)"/);
});

console.log(`${checks} sell-put UI checks passed.`);
