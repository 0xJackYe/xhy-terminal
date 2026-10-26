"use strict";

// Market quality can fluctuate without erasing a trader's working reference.
// Retained views must never regain current calculation/record/export authority.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ui = require("./dashboard/dist/sell-put-ui.js");
const engine = require("./dashboard/dist/sell-put-engine.js");
const source = fs.readFileSync("dashboard/dist/sell-put-ui.js", "utf8");
const at = Date.parse("2030-01-01T00:00:00Z");
let checks = 0;
function check(name, fn) {fn(); checks++; console.log(`OK ${name}`);}
const clone = value => JSON.parse(JSON.stringify(value));
const settings = {...ui.DEFAULTS};
function row(strike = 60000) {
  return {symbol: `BTC-300116-${strike}-P`, side: "PUT", status: "TRADING", unit: 1, quote_asset: "USDT",
    strike_price: strike, expiry_ms: at + 15 * 86400000, bid_price: 65, ask_price: 70,
    bid_quantity: 1, ask_quantity: 2, mark_price: 65, mark_iv: .6,
    quote_updated_at: at, quote_source: "websocket", mark_updated_at: at, mark_source: "websocket",
    field_updated_at: Object.fromEntries(["bid_price", "ask_price", "bid_quantity", "ask_quantity", "mark_price", "mark_iv"].map(name => [name, at])),
    field_source: Object.fromEntries(["bid_price", "ask_price", "bid_quantity", "ask_quantity", "mark_price", "mark_iv"].map(name => [name, "websocket"])),
    initial_margin_rate: .15, min_initial_margin_rate: .1, maintenance_margin_rate: .075,
    min_maintenance_margin_rate: .05, liquidation_fee_rate: .0019,
    quantity_step: .01, min_qty: .01, max_qty: 1000, quantity_scale: 2};
}
function snapshot(rows = [row()]) {return {options: rows, btc_index_price: 80000, index_updated_at: at, index_source: "websocket", catalog_updated_at: at};}
function sample(snap = snapshot(), time = at, mode = "live") {return {snapshot: snap, at: time, mode};}
function valid() {const value = engine.evaluate(snapshot(), settings, at).rows[0]; assert.equal(value.issue, null); return value;}
function stale(value = valid(), issue = "深度已陈旧") {return {...clone(value), issue, metrics: null, stress: []};}
function harness() {
  const nodes = new Map(), intervals = new Map(), storage = new Map(), timeouts = new Map(), listeners = new Map(), downloads = [], blobs = new Map(); let clock = at, seq = 0, chainExpiry = "ALL", snap = snapshot([row(), row(62000)]);
  class Element {
    constructor(tag = "div") {this.tagName = tag.toUpperCase(); this.value = ""; this.checked = this.hidden = this.open = this.disabled = false; this.events = {}; this.dataset = {}; this.innerHTML = this.textContent = ""; this.scrollLeft = this.scrollTop = 0; this.classList = {toggle() {}};}
    set innerHTML(value) {this.markup = value; const source = value.match(/<details class="sp-source-details"([^>]*)>/); this.sourceDetails = source ? {open: /\bopen\b/.test(source[1])} : null;}
    get innerHTML() {return this.markup;}
    querySelector(selector) {return selector === "details.sp-source-details" ? this.sourceDetails : null;}
    addEventListener(name, fn) {this.events[name] = fn;} setAttribute() {} focus() {}
    appendChild() {} remove() {} click() {if (this.tagName === "A") downloads.push({url: this.href, filename: this.download}); else this.fire("click");}
    showModal() {this.open = true;} close() {this.open = false; this.events.close?.();}
    querySelectorAll() {return [];} fire(name, event = {}) {this.events[name]?.(event);}
  }
  const node = name => {if (!nodes.has(name)) nodes.set(name, new Element()); return nodes.get(name);};
  const document = {hidden: false, activeElement: null, body: new Element("body"), createElement: tag => new Element(tag), getElementById: node, addEventListener(name, fn) {listeners.set(name, fn);}};
  class Clock extends Date {constructor(...args) {super(...(args.length ? args : [clock]));} static now() {return clock;}}
  const window = {SellPutEngine: engine};
  class CapturedBlob {constructor(parts) {this.content = parts.join("");}}
  vm.runInNewContext(source, {window, document, Date: Clock, Intl, console, Blob: CapturedBlob, URL: {createObjectURL(blob) {const url = "blob:sell-put-" + blobs.size; blobs.set(url, blob); return url;}, revokeObjectURL() {}}, localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)}, setInterval: fn => {intervals.set(++seq, fn); return seq;}, clearInterval: id => intervals.delete(id), setTimeout: (fn, period) => {timeouts.set(++seq, {fn, period}); return seq;}, clearTimeout: id => timeouts.delete(id)});
  const percent = new Set(["minStrikeRatio", "maxStrikeRatio", "feeRate", "exerciseFeeRate", "feeCap"]);
  for (const [key, value] of Object.entries(ui.DEFAULTS)) node("sellPut" + key[0].toUpperCase() + key.slice(1)).value = String(percent.has(key) ? value * 100 : value);
  node("sellPutExpiry").value = "ALL";
  window.SellPutUI.initialize({getSnapshot: () => snap, getExpiry: () => chainExpiry});
  return {node, storage, timeouts, intervals, downloads, blobs, setChainExpiry: value => {chainExpiry = value;}, advance: amount => {clock += amount;}, controller: window.SellPutUI, snapshot: () => snap, setSnapshot: value => {snap = value;},
    runTimeouts(period) {for (const [id, task] of [...timeouts]) if (period === undefined || period === task.period) {timeouts.delete(id); task.fn();}},
    visibility(hidden) {document.hidden = hidden; listeners.get("visibilitychange")?.();},
    tick(amount = 1000) {clock += amount; for (const fn of intervals.values()) fn();},
    select(symbol) {node("sellPutRows").fire("click", {target: {closest: () => ({dataset: {spSymbol: symbol}})}});}};
}

check("all transient market fields share a quiet synchronization state, genuine limits do not", () => {
  for (const issue of ["报价已陈旧", "深度已陈旧", "报价时间未知", "深度时间异常", "指数已陈旧", "BTC 指数缺失", "报价深度未知", "盘口快照待核验", "标记价/IV已陈旧，仅可查看报价参考", "标记价/IV更新时间未知或异常", "合约规则核验过旧或时间未知", "合约保证金/数量规则缺失，等待目录核验", "等待有效BTC公开行情"]) {
    assert.equal(ui.isTemporaryDataIssue(issue), true, issue); assert.equal(ui.issueLabel(issue), "行情同步中");
  }
  for (const issue of ["买卖一深度不足", "合约已到期", "买卖报价交叉，待核验", "按所填余额与预留资金，开仓保证金不足", "数量不符合合约步长", "买卖价差超过筛选上限", "标记价、买卖报价或IV异常"]) assert.equal(ui.isTemporaryDataIssue(issue), false, issue);
  assert.equal(ui.isTemporaryDataIssue("无有效买一报价", {row: {bid_price: 0}}), false);
  assert.equal(ui.isTemporaryDataIssue("无有效买一报价", {row: {}}), true);
});
check("reference cache retains one atomic snapshot, never grants metrics to current entry", () => {
  const store = ui.createReferenceStore(), good = valid(), original = sample();
  store.update([good], settings, original, at);
  good.metrics.netPremium = 999; original.snapshot.index_updated_at = at + 999;
  const current = stale(), newer = sample({...snapshot(), index_updated_at: at + 30000}, at + 30000);
  store.update([current], settings, newer, at + 30000);
  const view = store.present(current, settings, newer, at + 30000);
  assert.equal(view.retained, true); assert.notEqual(view.entry.metrics.netPremium, 999);
  assert.equal(view.sample.snapshot.index_updated_at, at); assert.equal(view.sample.at, at);
  assert.equal(view.sample.snapshot.options, undefined); assert.equal(current.metrics, null);
  assert.equal(current.stress.length, 0); assert.equal(current.issue, "深度已陈旧");
});
check("five-minute retention, expiry and exchange clock offset are strict boundaries", () => {
  const store = ui.createReferenceStore(), good = valid(), current = stale(good);
  store.update([good], settings, sample(), at);
  assert.equal(store.present(current, settings, sample(), at + 300000).retained, true);
  assert.equal(store.present(current, settings, sample(), at + 300001).retained, false);
  const expiring = {...good, expiryMs: at + 1000}, st = ui.createReferenceStore();
  st.update([expiring], settings, sample(), at);
  assert.equal(st.present(stale(expiring), settings, sample({...snapshot(), exchange_clock_offset_ms: 1000}), at).retained, false);
});
check("any changed setting invalidates prior references, including fees and quantity", () => {
  for (const change of [{balance: 999}, {quantity: .11}, {quantityMode: "manual"}, {feeRate: .0002}, {maxSpreadPct: 25}, {stressElapsedDays: 2}, {sort: "spread"}]) {
    const store = ui.createReferenceStore(), good = valid(); store.update([good], settings, sample(), at);
    assert.equal(store.present(stale(good), {...settings, ...change}, sample(), at + 1000).retained, false);
    assert.equal(store.present(stale(good), settings, sample(), at + 1000).retained, false);
  }
});
check("hard trade conditions evict references even when freshness is the first engine failure", () => {
  for (const patch of [{row: {...row(), bid_quantity: 0}}, {row: {...row(), bid_price: 0}}, {row: {...row(), bid_price: 80, ask_price: 70}}, {row: {...row(), ask_price: 200}}, {row: {...row(), unit: 2}}, {row: {...row(), status: "HALT"}}, {issue: "买卖一深度不足"}, {issue: "数量不符合合约步长"}]) {
    const store = ui.createReferenceStore(), good = valid(); store.update([good], settings, sample(), at);
    store.update([{...stale(good), ...patch}], settings, sample(), at + 1000);
    assert.equal(store.present(stale(good), settings, sample(), at + 2000).retained, false);
  }
  const manual = {...settings, quantityMode: "manual", quantity: .1}, store = ui.createReferenceStore(), good = valid();
  store.update([good], manual, sample(), at); store.update([{...stale(good), row: {...row(), bid_quantity: .05}}], manual, sample(), at + 1000);
  assert.equal(store.present(stale(good), manual, sample(), at + 2000).retained, false);
});
check("paused snapshots neither read nor overwrite live references", () => {
  const store = ui.createReferenceStore(), good = valid(); store.update([good], settings, sample(), at);
  assert.equal(store.present(stale(good), settings, sample(snapshot(), at, "paused"), at + 1000).retained, false);
  const changed = clone(good); changed.metrics.netPremium = 999;
  store.update([changed], settings, sample(snapshot(), at, "paused"), at + 1000);
  assert.notEqual(store.present(stale(good), settings, sample(), at + 2000).entry.metrics.netPremium, 999);
  assert.equal(store.pendingRows("等待有效BTC公开行情", settings, sample(snapshot(), at, "paused"), at + 1000).length, 0);
  const expiredFixed = store.present(good, settings, sample(snapshot(), at, "paused"), good.expiryMs + 1);
  assert.equal(expiredFixed.retained, false); assert.equal(expiredFixed.issue, null); assert.ok(expiredFixed.entry.metrics);
});
check("global market interruptions can retain candidates, empty valid filters cannot", () => {
  const store = ui.createReferenceStore(), good = valid(); store.update([good], settings, sample(), at);
  const pending = store.pendingRows("等待有效BTC公开行情", settings, sample({options: [], btc_index_price: null}), at + 1000);
  assert.equal(pending.length, 1); assert.equal(pending[0].metrics, null); assert.equal(pending[0].issue, "等待有效BTC公开行情");
  assert.equal(store.pendingRows("", settings, sample(), at + 1000).length, 0);
  assert.equal(store.pendingRows("买卖一深度不足", settings, sample(), at + 1000).length, 0);
});
check("CSV exports current failure and empty money, reference timestamp is separate", () => {
  const store = ui.createReferenceStore(), good = valid(), current = stale(good); store.update([good], settings, sample(), at);
  const view = store.present(current, settings, sample(), at + 1000);
  const csv = ui.exportRows([current], settings, snapshot(), {at: at + 1000, references: new Map([[good.symbol, view]])});
  assert.match(csv, /深度已陈旧/); assert.match(csv, /页面保留历史参考/); assert.match(csv, /2030-01-01T00:00:00\.000Z/);
  assert.doesNotMatch(csv.split("\r\n")[1], /"7\.02"|"7\.8"/); // The displayed historical premium is not a current CSV amount.
});
check("actual controller and real engine keep selected stale reference then replace it on recovery", () => {
  const h = harness(); h.controller.open(); const selected = row(62000).symbol; h.select(selected);
  const current = clone(h.snapshot()); current.options[1].field_updated_at.bid_quantity = at - 30000;
  current.options[1].quote_updated_at = at + 1000; current.options[1].field_updated_at.bid_price = at + 1000;
  current.options[1].field_updated_at.ask_price = at + 1000; current.index_updated_at = at + 1000;
  h.setSnapshot(current); h.tick();
  let detail = h.node("sellPutDetail").innerHTML;
  assert.match(detail, new RegExp(selected)); assert.match(detail, /参考快照，等待最新行情/);
  assert.match(detail, /sp-yields/); assert.match(detail, /sp-matrix/); assert.doesNotMatch(detail, /sp-error/);
  assert.equal(h.node("sellPutRecord").disabled, true);
  assert.match(detail, /2030\/01\/01 08:00:00（北京）/); assert.doesNotMatch(detail, /2030\/01\/01 08:00:01（北京）/);
  const fixedOrder = h.node("sellPutRows").innerHTML;
  assert.ok(fixedOrder.indexOf(row().symbol) < fixedOrder.indexOf(selected));
  const recovered = clone(h.snapshot()); recovered.options[1].field_updated_at.bid_quantity = at + 2000;
  recovered.options[1].bid_price = 66; recovered.options[1].mark_price = 66;
  h.setSnapshot(recovered); h.tick(); detail = h.node("sellPutDetail").innerHTML;
  assert.match(detail, new RegExp(selected)); assert.doesNotMatch(detail, /参考快照，等待最新行情/);
  assert.match(detail, /66 USDT ×/); assert.equal(h.node("sellPutRecord").disabled, false);
});
check("actual controller clears retained money on bad quantity, insufficient depth and changed balance", () => {
  for (const kind of ["quantity", "depth", "balance"]) {
    const h = harness(); h.controller.open();
    if (kind === "quantity") {h.node("sellPutQuantityMode").value = "manual"; h.node("sellPutQuantity").value = ".005"; h.node("sellPutForm").fire("change");}
    else if (kind === "depth") {const snap = clone(h.snapshot()); snap.options[0].bid_quantity = 0; snap.options[0].field_updated_at.bid_quantity = at - 30000; h.setSnapshot(snap); h.tick(); assert.match(h.node("sellPutDetail").innerHTML, /买卖一深度不足/);}
    else {const snap = clone(h.snapshot()); snap.options.forEach(value => {value.field_updated_at.bid_quantity = at - 30000;}); h.setSnapshot(snap); h.tick(); assert.match(h.node("sellPutDetail").innerHTML, /sp-yields/); h.node("sellPutBalance").value = "999"; h.node("sellPutForm").fire("change");}
    assert.doesNotMatch(h.node("sellPutDetail").innerHTML, /sp-yields|sp-matrix/);
    assert.equal(h.node("sellPutRecord").disabled, true);
  }
});
check("actual controller never reuses references after blank inputs and preserves selection when calculated-only hides it", () => {
  const h = harness(); h.controller.open(); const symbol = row(62000).symbol; h.select(symbol);
  h.node("sellPutOnlyCalculated").checked = true;
  const snap = clone(h.snapshot()); snap.options[1].field_updated_at.bid_quantity = at - 30000; h.setSnapshot(snap); h.tick();
  assert.match(h.node("sellPutDetail").innerHTML, new RegExp(symbol));
  assert.match(h.node("sellPutDetail").innerHTML, /参考快照，等待最新行情/);
  assert.doesNotMatch(h.node("sellPutRows").innerHTML, new RegExp(symbol));
  h.node("sellPutBalance").value = ""; h.node("sellPutForm").fire("change");
  assert.equal(h.node("sellPutError").hidden, false); assert.doesNotMatch(h.node("sellPutDetail").innerHTML, /sp-yields/);
  h.node("sellPutBalance").value = "1000"; h.node("sellPutForm").fire("change");
  h.select(symbol); assert.doesNotMatch(h.node("sellPutDetail").innerHTML, /参考快照，等待最新行情/);
});
check("actual controller preserves manually opened and closed source details across live and retained renders", () => {
  const h = harness(); h.controller.open(); const detail = h.node("sellPutDetail");
  assert.equal(detail.querySelector("details.sp-source-details").open, false);
  detail.querySelector("details.sp-source-details").open = true;
  h.tick(); assert.equal(detail.querySelector("details.sp-source-details").open, true);
  assert.match(detail.innerHTML, /sp-source-details" open/);
  const interrupted = clone(h.snapshot()); interrupted.options[0].field_updated_at.bid_quantity = at - 30000;
  h.setSnapshot(interrupted); h.tick();
  assert.match(detail.innerHTML, /参考快照，等待最新行情/); assert.equal(detail.querySelector("details.sp-source-details").open, true);
  detail.querySelector("details.sp-source-details").open = false;
  h.tick(); assert.equal(detail.querySelector("details.sp-source-details").open, false);
  detail.querySelector("details.sp-source-details").open = true;
  h.select(row(62000).symbol); assert.equal(detail.querySelector("details.sp-source-details").open, false);
});

check("record click validates pending edits before persisting a simulation", () => {
  const h = harness(); h.controller.open();
  h.node("sellPutQuantityMode").value = "manual"; h.node("sellPutQuantity").value = ".005";
  h.node("sellPutForm").fire("input"); // The 120 ms render has not run.
  assert.equal(h.node("sellPutRecord").disabled, false);
  h.node("sellPutRecord").fire("click");
  assert.equal(h.storage.size, 0); assert.equal(h.node("sellPutRecord").disabled, true);
});
check("record click uses the currently typed valid quantity and current snapshot", () => {
  const h = harness(); h.controller.open();
  h.node("sellPutQuantityMode").value = "manual"; h.node("sellPutQuantity").value = ".02";
  h.node("sellPutForm").fire("input"); h.node("sellPutRecord").fire("click");
  const records = JSON.parse(h.storage.get("btc-options-sell-put-trials-v1"));
  assert.equal(records.length, 1); assert.equal(records[0].entry.metrics.quantity, .02);
  assert.equal(records[0].settings.quantity, .02);
  assert.equal(records[0].kind, "手工试算，非实盘成交");
});
check("record click detects intervening depth loss before the next live render", () => {
  const h = harness(); h.controller.open(); const current = clone(h.snapshot());
  current.options[0].bid_quantity = 0; h.setSnapshot(current);
  h.node("sellPutRecord").fire("click");
  assert.equal(h.storage.size, 0); assert.equal(h.node("sellPutRecord").disabled, true);
});
check("expired fixed snapshots cannot be recorded even between timer updates", () => {
  const h = harness(); h.controller.open(); h.node("sellPutPause").fire("click");
  assert.equal(h.node("sellPutRecord").disabled, false);
  h.advance(15 * 86400000); h.node("sellPutRecord").fire("click");
  assert.equal(h.storage.size, 0); assert.equal(h.node("sellPutRecord").disabled, true);
});
check("local simulation records cap history and report corrupt storage without overwriting it", () => {
  const key = "btc-options-sell-put-trials-v1", h = harness(); h.controller.open();
  h.storage.set(key, JSON.stringify(Array.from({length: 50}, (_, n) => ({n}))));
  h.node("sellPutRecord").fire("click"); const saved = JSON.parse(h.storage.get(key));
  assert.equal(saved.length, 50); assert.equal(saved[0].n, 1); assert.equal(saved[49].kind, "手工试算，非实盘成交");
  h.storage.set(key, "{bad json"); h.node("sellPutRecord").fire("click");
  assert.equal(h.storage.get(key), "{bad json"); assert.match(h.node("sellPutRecordStatus").textContent, /未保存/);
});
check("changing expiry scope replaces a syncing selection that belongs to another expiry", () => {
  const h = harness(), before = clone(h.snapshot());
  before.options[1].symbol = "BTC-300117-62000-P"; before.options[1].expiry_ms += 86400000;
  h.setSnapshot(before); h.controller.open(); const oldSymbol = before.options[0].symbol, target = before.options[1].symbol;
  h.select(oldSymbol); const pending = clone(before); pending.options[0].field_updated_at.bid_quantity = at - 30000;
  h.setSnapshot(pending); h.tick(); assert.match(h.node("sellPutDetail").innerHTML, /参考快照，等待最新行情/);
  h.node("sellPutExpiry").value = "2030-01-17"; h.node("sellPutForm").fire("change");
  assert.match(h.node("sellPutDetail").innerHTML, new RegExp(target));
  assert.doesNotMatch(h.node("sellPutDetail").innerHTML, new RegExp(oldSymbol));
  assert.equal(h.node("sellPutRecord").disabled, false);
});
check("switching from an unfinished manual quantity to automatic sizing clears the unused input error", () => {
  for (const mode of ["maxMargin", "cashSecured"]) {
    const h = harness(); h.controller.open();
    h.node("sellPutQuantityMode").value = "manual"; h.node("sellPutQuantity").value = ""; h.node("sellPutForm").fire("change");
    assert.equal(h.node("sellPutError").hidden, false);
    h.node("sellPutQuantityMode").value = mode; h.node("sellPutForm").fire("change");
    assert.equal(h.node("sellPutQuantity").disabled, true); assert.equal(h.node("sellPutError").hidden, true);
    assert.match(h.node("sellPutDetail").innerHTML, /sp-yields/); assert.equal(h.node("sellPutRecord").disabled, false);
    h.node("sellPutQuantityMode").value = "manual"; h.node("sellPutForm").fire("change");
    assert.equal(h.node("sellPutError").hidden, false); assert.equal(h.node("sellPutRecord").disabled, true);
  }
});
check("independent retest: chain-following expiry never keeps a reference from an excluded date", () => {
  const h = harness(), snap = clone(h.snapshot()); snap.options[1].symbol = "BTC-300117-62000-P"; snap.options[1].expiry_ms += 86400000;
  h.setSnapshot(snap); h.controller.open(); const old = snap.options[0].symbol; h.select(old);
  const pending = clone(snap); pending.options[0].field_updated_at.bid_quantity = at - 30000; h.setSnapshot(pending); h.tick();
  h.setChainExpiry("2030-01-17"); h.node("sellPutExpiry").value = "CHAIN"; h.node("sellPutForm").fire("change");
  assert.match(h.node("sellPutDetail").innerHTML, /BTC-300117-62000-P/); assert.doesNotMatch(h.node("sellPutDetail").innerHTML, new RegExp(old));
  h.setChainExpiry("2030-01-18"); h.tick(); assert.equal(h.node("sellPutDetail").innerHTML, ""); assert.equal(h.node("sellPutRecord").disabled, true);
});
check("independent retest: pending input exports current valid settings and blocks newly invalid settings", () => {
  const h = harness(); h.controller.open(); h.node("sellPutQuantityMode").value = "manual"; h.node("sellPutQuantity").value = ".02";
  h.node("sellPutForm").fire("input"); h.node("sellPutExport").fire("click");
  assert.equal(h.downloads.length, 1);
  const [headers, first] = h.blobs.get(h.downloads[0].url).content.replace(/^\uFEFF/, "").split("\r\n").map(line => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(match => match[1].replace(/""/g, '"')));
  assert.equal(first[headers.indexOf("数量张")], "0.02");
  h.node("sellPutQuantity").value = ""; h.node("sellPutForm").fire("input"); h.node("sellPutExport").fire("click");
  assert.equal(h.downloads.length, 1); assert.equal(h.node("sellPutError").hidden, false);
});
check("independent retest: close cancels input work and reopening always starts live with the latest frame", () => {
  const h = harness(); h.controller.open(); h.node("sellPutPause").fire("click");
  h.node("sellPutQuantityMode").value = "manual"; h.node("sellPutQuantity").value = ".02"; h.node("sellPutForm").fire("input");
  assert.equal(h.timeouts.size, 1); h.controller.close(); assert.equal(h.timeouts.size, 0); assert.equal(h.intervals.size, 0);
  const updated = clone(h.snapshot()); updated.options.forEach(item => {item.bid_price = 66; item.mark_price = 66;}); h.setSnapshot(updated);
  h.controller.open(); h.runTimeouts(120); assert.equal(h.node("sellPutMode").textContent, "自动跟随行情"); assert.equal(h.intervals.size, 1);
  h.node("sellPutRecord").fire("click"); const saved = JSON.parse(h.storage.get("btc-options-sell-put-trials-v1"))[0];
  assert.equal(saved.mode, "live"); assert.equal(saved.entry.metrics.quantity, .02); assert.equal(saved.entry.row.bid_price, 66);
});
check("independent retest: restoring visibility consumes hidden input changes and the current quote", () => {
  const h = harness(); h.controller.open(); h.node("sellPutQuantityMode").value = "manual"; h.node("sellPutQuantity").value = ".03"; h.node("sellPutForm").fire("input");
  h.visibility(true); h.runTimeouts(120);
  const updated = clone(h.snapshot()); updated.options.forEach(item => {item.bid_price = 67; item.mark_price = 67;}); h.setSnapshot(updated);
  h.visibility(false); h.node("sellPutRecord").fire("click"); const saved = JSON.parse(h.storage.get("btc-options-sell-put-trials-v1"))[0];
  assert.equal(saved.entry.metrics.quantity, .03); assert.equal(saved.entry.row.bid_price, 67);
});
console.log(`${checks} stable sell-put UI checks passed.`);
