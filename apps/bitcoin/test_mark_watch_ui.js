"use strict";

// Interest renewal is public, same-origin, bounded and independent of pricing.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ui = require("./dashboard/dist/sell-put-ui.js");
let checks = 0;
async function check(name, fn) {await fn(); checks++; console.log(`OK ${name}`);}
const flush = async () => {for (let i = 0; i < 6; i++) await Promise.resolve();};
const symbol = index => `BTC-301116-${60000 + 1000 * index}-P`;
function harness(send) {
  let clock = 100000;
  const state = {active: true, paused: false, hidden: false, selectedSymbol: symbol(9), entries: Array.from({length: 12}, (_, index) => ({symbol: symbol(index)}))};
  const requests = [];
  const watch = ui.createMarkWatch(() => state, (url, options) => {requests.push({url, options}); return send?.(url, options) ?? Promise.resolve({ok: true});}, () => clock);
  return {state, requests, watch, advance: amount => {clock += amount;}, requested: () => decodeURIComponent(requests.at(-1).url.split("symbols=")[1]).split(",")};
}

function controllerHarness() {
  const nodes = new Map(), listeners = {}, intervals = new Map(), requests = [];
  let clock = Date.parse("2030-11-01T00:00:00Z"), sequence = 0;
  const stale = "标记价/IV已陈旧，仅可查看报价参考";
  let rows = [symbol(0), symbol(1)].map(name => ({symbol: name, row: {symbol: name, mark_price: 48}, days: 15, expiryMs: clock + 15 * 86400000, issue: stale, metrics: null}));
  class Node {
    constructor() {this.value = ""; this.checked = this.hidden = this.open = this.disabled = false; this.events = {}; this.innerHTML = ""; this.dataset = {}; this.classList = {toggle() {}}; this.scrollLeft = this.scrollTop = 0;}
    addEventListener(name, fn) {this.events[name] = fn;}
    setAttribute() {}
    focus() {}
    showModal() {this.open = true;}
    close() {this.open = false; this.events.close?.();}
    querySelectorAll() {return [];}
    fire(name, event = {}) {this.events[name]?.(event);}
  }
  const node = id => {if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id);};
  const document = {hidden: false, activeElement: null, getElementById: node, addEventListener: (name, fn) => {listeners[name] = fn;}};
  const window = {SellPutEngine: {evaluate: () => ({rows, issues: []})}, fetch: (url, options) => {requests.push({url, options}); return Promise.resolve({ok: true});}};
  class Clock extends Date {static now() {return clock;}}
  const context = vm.createContext({window, document, Date: Clock, Intl, console, setInterval: fn => {const id = ++sequence; intervals.set(id, fn); return id;}, clearInterval: id => intervals.delete(id), setTimeout: () => ++sequence, clearTimeout() {}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "dashboard/dist/sell-put-ui.js"), "utf8"), context);
  const percent = new Set(["minStrikeRatio", "maxStrikeRatio", "feeRate", "exerciseFeeRate", "feeCap"]);
  for (const [key, value] of Object.entries(ui.DEFAULTS)) node("sellPut" + key[0].toUpperCase() + key.slice(1)).value = String(percent.has(key) ? value * 100 : value);
  node("sellPutExpiry").value = "ALL";
  window.SellPutUI.initialize({getSnapshot: () => ({options: rows.map(entry => entry.row)})});
  return {controller: window.SellPutUI, requests, node, document,
    tick: () => {clock += 1000; [...intervals.values()].forEach(fn => fn());},
    setRows: value => {rows = value;}, rows: () => rows,
    visible: value => {document.hidden = !value; listeners.visibilitychange?.();}};
}

(async () => {
  await check("selected contract leads a deduplicated local list capped at eight", async () => {
    const h = harness(); h.watch.poll();
    assert.equal(h.requests.length, 1); assert.deepEqual(h.requested(), [symbol(9), ...Array.from({length: 7}, (_, index) => symbol(index))]);
    assert.ok(h.requests[0].url.startsWith("/api/mark-watch?symbols="));
    assert.deepEqual(h.requests[0].options, {cache: "no-store", credentials: "same-origin"});
    await flush();
  });
  await check("steady interest renews at ten seconds and pending calls never overlap", async () => {
    let finish; const h = harness(() => new Promise(resolve => {finish = resolve;}));
    h.watch.poll(); h.advance(60000); h.watch.poll(); assert.equal(h.requests.length, 1);
    finish({ok: true}); await flush(); h.watch.poll(); assert.equal(h.requests.length, 2);
    finish({ok: true}); await flush(); h.advance(9999); h.watch.poll(); assert.equal(h.requests.length, 2);
    h.advance(1); h.watch.poll(); assert.equal(h.requests.length, 3); finish({ok: true}); await flush();
  });
  await check("selecting another contract requests it immediately even inside renewal window", async () => {
    const h = harness(); h.watch.poll(); await flush();
    h.state.selectedSymbol = symbol(2); h.watch.poll(); assert.equal(h.requests.length, 2); assert.equal(h.requested()[0], symbol(2)); await flush();
    assert.equal(new Set(h.requested()).size, 8);
  });
  await check("selection changes queued during a pending request are sent after completion", async () => {
    let finish; const h = harness(() => new Promise(resolve => {finish = resolve;})); h.watch.poll();
    h.state.selectedSymbol = symbol(1); h.watch.poll(); assert.equal(h.requests.length, 1);
    finish({ok: true}); await flush(); assert.equal(h.requests.length, 2); assert.equal(h.requested()[0], symbol(1)); finish({ok: true}); await flush();
  });
  await check("closed hidden and paused panels never renew interest, including pending completion", async () => {
    for (const [key, value] of [["active", false], ["hidden", true], ["paused", true]]) {
      let finish; const h = harness(() => new Promise(resolve => {finish = resolve;})); h.watch.poll();
      h.state[key] = value; h.state.selectedSymbol = symbol(1); h.advance(60000); h.watch.poll();
      finish({ok: true}); await flush(); assert.equal(h.requests.length, 1);
      h.state[key] = !value; h.watch.poll(); assert.equal(h.requests.length, 2); finish({ok: true}); await flush();
    }
  });
  await check("failed local requests are contained and retry on the next renewal", async () => {
    const h = harness(() => Promise.reject(new Error("offline"))); h.watch.poll(); await flush(); h.watch.poll(); assert.equal(h.requests.length, 1);
    h.advance(10000); h.watch.poll(); await flush(); assert.equal(h.requests.length, 2);
    const throws = harness(() => {throw new Error("offline");}); throws.watch.poll(); await flush(); throws.advance(10000); throws.watch.poll(); await flush(); assert.equal(throws.requests.length, 2);
  });
  await check("empty and malformed interest cannot become arbitrary endpoint requests", async () => {
    const h = harness(); h.state.selectedSymbol = "https://evil.invalid/key"; h.state.entries = [{symbol: "BTC-foo"}, {symbol: "ETH-301116-2000-P"}];
    h.watch.poll(); await flush(); assert.equal(h.requests.length, 0);
    h.state.entries = [{symbol: symbol(0)}]; h.watch.poll(); await flush(); assert.deepEqual(h.requested(), [symbol(0)]);
    h.watch.poll(); await flush(); assert.equal(h.requests.length, 1);
  });
  await check("synchronizing language changes presentation only and CSV retains stale reason", () => {
    const reason = "标记价/IV已陈旧，仅可查看报价参考";
    assert.equal(ui.issueLabel(reason), "行情同步中");
    assert.equal(ui.issueLabel(reason, "live", true), "行情同步中，恢复后自动继续计算。");
    assert.equal(ui.issueLabel(reason, "paused", true), "固定快照待更新，请恢复跟随行情");
    assert.equal(ui.issueLabel("标记价/IV更新时间未知或异常", "live", true), "行情同步中，恢复后自动继续计算。");
    const row = {symbol: symbol(0), issue: reason, metrics: null};
    assert.match(ui.exportRows([row], {}, {}, {}), /标记价\/IV已陈旧，仅可查看报价参考/);
    assert.deepEqual(ui.filterVisible([row], {onlyCalculated: true}), []);
  });
  await check("actual dialog controller registers interest and stops it while paused hidden or closed", async () => {
    const h = controllerHarness(); h.tick(); assert.equal(h.requests.length, 0);
    h.controller.open(); await flush(); assert.equal(h.requests.length, 1);
    const selected = {dataset: {spSymbol: symbol(1)}};
    h.node("sellPutRows").fire("click", {target: {closest: () => selected}}); await flush();
    assert.equal(h.requests.length, 2); assert.ok(decodeURIComponent(h.requests.at(-1).url).includes("symbols=" + symbol(1)));
    h.node("sellPutPause").fire("click"); for (let i = 0; i < 15; i++) h.tick(); await flush(); assert.equal(h.requests.length, 2);
    h.node("sellPutPause").fire("click"); await flush(); assert.equal(h.requests.length, 3);
    h.visible(false); for (let i = 0; i < 15; i++) h.tick(); await flush(); assert.equal(h.requests.length, 3);
    h.visible(true); await flush(); assert.equal(h.requests.length, 4);
    h.controller.close(); for (let i = 0; i < 15; i++) h.tick(); await flush(); assert.equal(h.requests.length, 4);
  });
  await check("actual stale rendering stays non-calculable until fresh engine metrics arrive", async () => {
    const h = controllerHarness(); h.controller.open(); await flush();
    assert.match(h.node("sellPutDetail").innerHTML, /sp-sync-status[^>]*role="status"/);
    assert.match(h.node("sellPutDetail").innerHTML, /行情同步中，恢复后自动继续计算/);
    assert.doesNotMatch(h.node("sellPutDetail").innerHTML, /sp-yields|sp-error/);
    assert.match(h.node("sellPutRows").innerHTML, /行情同步中/);
    assert.equal(h.node("sellPutRecord").disabled, true);
    h.node("sellPutPause").fire("click"); assert.match(h.node("sellPutDetail").innerHTML, /固定快照待更新，请恢复跟随行情/);
    h.node("sellPutPause").fire("click"); h.setRows(h.rows().map(entry => ({...entry, issue: null, metrics: {}}))); h.tick(); await flush();
    assert.match(h.node("sellPutDetail").innerHTML, /sp-yields/); assert.doesNotMatch(h.node("sellPutDetail").innerHTML, /正在同步标记价/);
    assert.equal(h.node("sellPutRecord").disabled, false);
    h.controller.close();
  });
  console.log(`${checks} mark-watch UI checks passed.`);
})().catch(error => {console.error(error); process.exitCode = 1;});
