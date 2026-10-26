"use strict";

// Exercise the real app controller with isolated DOM, EventSource and fetch.
// The retired candidate/workbench libraries have separate isolated unit tests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {execFileSync} = require("node:child_process");
const riskUI = require("./dashboard/dist/risk-ui.js");
const directory = path.join(__dirname, "dashboard", "dist");
const html = fs.readFileSync(path.join(directory, "index.html"), "utf8");
const source = fs.readFileSync(path.join(directory, "app.js"), "utf8");

function harness() {
  const nodes = new Map(), listeners = new Map(), intervals = [], frames = [], trace = [], writes = new Map();
  let document, serial = 0;
  function element(id, tagName = "DIV") {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set(), attributes = new Map();
    const result = {id, tagName, hidden: false, open: false, inert: false, isConnected: true,
      value: "", checked: false, disabled: false, dataset: {}, style: {}, children: [], parentElement: null,
      textContent: "", scrollTop: 0, clientHeight: 500, listeners: new Map(),
      classList: {contains: name => classes.has(name), add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        toggle(name, enabled) {const active = enabled === undefined ? !classes.has(name) : enabled; active ? classes.add(name) : classes.delete(name); return active;}},
      addEventListener(name, callback) {if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(callback);},
      dispatchEvent(event) {(this.listeners.get(event.type) ?? []).forEach(callback => callback(event));},
      setAttribute(name, value) {attributes.set(name, value);}, getAttribute: name => attributes.get(name),
      getBoundingClientRect: () => ({height: 90}),
      getClientRects() {for (let item = this; item; item = item.parentElement) if (item.hidden) return []; return [{}];},
      focus() {if (this.getClientRects().length && document) document.activeElement = this;},
      contains(target) {for (let item = target; item; item = item.parentElement) if (item === this) return true; return false;},
      closest(selector) {return selector === "td[data-symbol]" && this.tagName === "TD" && this.dataset.symbol ? this : null;},
      querySelectorAll(selector) {
        const all = [], visit = parent => parent.children.forEach(child => {all.push(child); visit(child);}); visit(this);
        if (selector === "button" || selector.startsWith("button:")) return all.filter(item => item.tagName === "BUTTON");
        if (selector === "td[data-symbol]") return all.filter(item => item.tagName === "TD" && item.dataset.symbol);
        return [];
      },
      querySelector(selector) {return this.querySelectorAll(selector)[0] ?? null;},
      showModal() {this.open = true;}, close() {this.open = false; (this.listeners.get("close") ?? []).forEach(callback => callback());},
      scrollIntoView() {},
    };
    Object.defineProperty(result, "innerHTML", {get: () => result.markup ?? "", set(value) {result.markup = value; writes.set(id, (writes.get(id) ?? 0) + 1);}});
    nodes.set(id, result);
    return result;
  }
  const body = element("_body", "BODY"), stack = [body];
  const voidTags = new Set(["AREA", "BASE", "BR", "COL", "EMBED", "HR", "IMG", "INPUT", "LINK", "META", "PARAM", "SOURCE", "TRACK", "WBR"]);
  let insideBody = false;
  for (const match of html.matchAll(/<(\/?)([a-z][a-z0-9:-]*)\b([^>]*)>/gi)) {
    const closing = Boolean(match[1]), tagName = match[2].toUpperCase(), attributes = match[3];
    if (tagName === "BODY") {insideBody = !closing; continue;}
    if (!insideBody) continue;
    if (closing) {const position = stack.findLastIndex(item => item.tagName === tagName); if (position > 0) stack.length = position; continue;}
    const id = /\bid="([^"]+)"/.exec(attributes)?.[1] ?? "_anonymous" + ++serial;
    const node = element(id, tagName);
    node.hidden = /(?:^|\s)hidden(?:\s|=|$)/.test(attributes);
    node.parentElement = stack.at(-1); node.parentElement.children.push(node);
    for (const name of /\bclass="([^"]+)"/.exec(attributes)?.[1]?.split(/\s+/) ?? []) node.classList.add(name);
    node.value = /\bvalue="([^"]*)"/.exec(attributes)?.[1] ?? "";
    if (!voidTags.has(tagName) && !/\/\s*$/.test(attributes)) stack.push(node);
  }
  document = {hidden: true, activeElement: null, body,
    getElementById: id => nodes.get(id) ?? null, querySelectorAll: () => [],
    addEventListener(name, callback) {if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback);}};
  const h = {nodes, document, listeners, intervals, frames, trace, writes,
    fetchImpl: () => new Promise(() => {}), hooks: null, deliveries: [], refreshes: 0, streams: [],
    emit(name, event = {}) {(listeners.get(name) ?? []).forEach(callback => callback(event));},
    click(id, event = {}) {(element(id).listeners.get("click") ?? []).forEach(callback => callback({target: element(id), ...event}));},
    flushFrames() {while (frames.length) frames.shift()();},
  };
  class EventSource {
    constructor(url) {this.url = url; this.listeners = new Map(); h.streams.push(this); trace.push("stream-created");}
    addEventListener(name, callback) {this.listeners.set(name, callback);}
    close() {}
  }
  const forbiddenLegacyCall = () => {throw new Error("Retired seller UI was called");};
  const window = {scrollY: 0, scrollTo() {}, addEventListener() {}, EventSource,
    OptionAIUI: {initialize(config) {h.aiHooks = config;}},
    OptionPayoffPreview: {open(...args) {(h.previews ??= []).push(args);}},
    OptionRiskUI: {initialize() {}, onSnapshot(snapshot) {h.deliveries.push(snapshot);}, isVerifiedBook: riskUI.isVerifiedBook},
    SellPutUI: {initialize: forbiddenLegacyCall},
    SellerScreenUI: {initialize: forbiddenLegacyCall, onSnapshot: forbiddenLegacyCall, refresh: forbiddenLegacyCall},
  };
  const context = vm.createContext({document, window, EventSource,
    localStorage: {getItem: () => null, setItem() {}},
    fetch: (...args) => {trace.push(args[0]); return h.fetchImpl(...args);},
    AbortController: class {constructor() {this.signal = {};} abort() {}},
    setTimeout: () => 1, clearTimeout() {},
    setInterval: (callback, delay) => {intervals.push({callback, delay}); return intervals.length;}, clearInterval() {},
    requestAnimationFrame: callback => {frames.push(callback); return frames.length;},
    console, Intl, Date, Set, Map, Number, String, Object, Array, JSON, Promise, Event,
  });
  vm.runInContext(source + "\nthis.app={state,combo,acceptSnapshot,queueSnapshot,fetchMarket,applyQuoteFocus,openDrawer,closeDrawer,render,filteredOptions};", context);
  h.app = context.app;
  return h;
}

function snapshot({instance = "service-a", revision = 1, price = "80000"} = {}) {
  const now = Date.now();
  return {instance_id: instance, revision, btc_index_price: price, index_updated_at: now, index_source: "rest",
    fetched_at: new Date(now).toISOString(), exchange_clock_offset_ms: 0,
    options: [{symbol: "BTC-991231-62000-P", side: "PUT", expiry_ms: now + 15 * 86400000,
      strike_price: "62000", unit: "1", min_qty: ".01", status: "TRADING", quote_asset: "USDT",
      bid_price: "49", ask_price: "51", bid_quantity: ".1", ask_quantity: ".2", mark_price: "50", mark_iv: ".6",
      volume_24h_contracts: "0", amount_24h_quote: "0", quote_source: "rest", quote_updated_at: now,
      mark_source: "rest", mark_updated_at: now, ticker_updated_at: now}]};
}

let count = 0;
async function check(name, operation) {await operation(); count++; console.log("OK " + name);}
(async () => {
  await check("the full chain is the direct initial view and removed seller interfaces are absent", () => {
    const h = harness();
    for (const id of ["sellerScreen", "sellerAdvanced", "sellerBackButton", "ruleButton", "callRuleButton", "sellPutButton", "sellCallButton", "focusSellPutButton", "focusSellCallButton", "sellPutDialog"]) {
      assert.equal(h.nodes.has(id), false, id);
    }
    for (const name of ["seller-screen-engine.js", "seller-screen-ui.js", "seller-screen.css", "sell-put-engine.js", "sell-put-ui.js", "sell-put.css"]) assert.ok(!html.includes('"/' + name + '"'), name);
    assert.equal(h.nodes.get("chainArea").getClientRects().length, 1);
    assert.equal(h.nodes.get("focusButton").getClientRects().length, 1);
    assert.equal(h.app.state.side, "ALL"); assert.equal(h.app.state.atm, false); assert.equal(h.app.state.favoritesOnly, false);
    assert.ok(!Object.hasOwn(h.app.state, "rule"));
    assert.match(html, /<title>BTC 期权行情看板<\/title>/);
  });
  await check("fresh data immediately renders quotes outside the discarded candidate conditions", () => {
    const h = harness(); h.document.hidden = false;
    const data = snapshot(), first = data.options[0];
    data.options = [{...first, symbol: "BTC-991231-80000-C", side: "CALL", strike_price: "80000", expiry_ms: Date.now() + 86400000},
      {...first, symbol: "BTC-991231-79000-P", strike_price: "79000", expiry_ms: Date.now() + 86400000}];
    h.app.acceptSnapshot(data);
    const rows = Array.from(h.app.filteredOptions(), row => row.symbol);
    assert.equal(rows.length, 2); assert.ok(rows.includes("BTC-991231-79000-P")); assert.ok(rows.includes("BTC-991231-80000-C"));
    assert.equal(h.nodes.get("optionChain").hidden, false); assert.equal(h.nodes.get("emptyState").hidden, true);
    assert.match(h.nodes.get("chainBody").innerHTML, /BTC-991231-79000-P/); assert.match(h.nodes.get("chainBody").innerHTML, /BTC-991231-80000-C/);
    assert.doesNotMatch(h.nodes.get("expiryTabs").innerHTML, /符合.*条件|title=/);
  });
  await check("hidden data advances state and risk analysis without writing the quote DOM", () => {
    const h = harness(), first = snapshot({revision: 5}); h.app.acceptSnapshot(first);
    assert.equal(h.deliveries.length, 1); assert.equal(h.deliveries[0], h.app.state.snapshot);
    h.app.acceptSnapshot(snapshot({revision: 4})); assert.equal(h.deliveries.length, 1); assert.equal(h.app.state.snapshot.revision, 5);
    assert.equal(h.writes.get("chainBody") ?? 0, 0);
  });
  await check("unavailable frames revoke certificates but retain the previous quote catalog and recover", () => {
    const h = harness(); h.app.acceptSnapshot(snapshot());
    h.app.acceptSnapshot({instance_id: "service-a", revision: 2, btc_index_price: null, options: [], error: {message: "feed temporarily unavailable"}});
    assert.equal(h.deliveries.length, 2); assert.equal(h.app.state.currentSnapshotUnavailable, true);
    assert.equal(h.app.state.snapshot.options.length, 1); assert.equal(h.app.state.snapshot.options[0].quote_group_valid, false);
    assert.equal(h.app.state.snapshot.options[0].quote_verification, null);
    h.app.acceptSnapshot(snapshot({revision: 3})); assert.equal(h.app.state.currentSnapshotUnavailable, false); assert.equal(h.deliveries.length, 3);
  });
  await check("pending animation frames cannot revive a retired server instance", () => {
    const h = harness(); h.document.hidden = false;
    h.app.queueSnapshot(snapshot({instance: "old", revision: 100}));
    h.app.queueSnapshot(snapshot({instance: "new", revision: 1, price: "81000"}));
    h.app.queueSnapshot(snapshot({instance: "old", revision: 101, price: "70000"})); h.flushFrames();
    assert.equal(h.app.state.snapshot.instance_id, "new"); assert.equal(h.app.state.snapshot.btc_index_price, "81000"); assert.equal(h.deliveries.length, 1);
    assert.equal(h.nodes.get("optionChain").hidden, false);
  });
  await check("HTTP failure preserves the chain and the actual refresh button requests fresh local data", async () => {
    const h = harness(); h.document.hidden = false; h.app.acceptSnapshot(snapshot()); h.app.state.fetching = false;
    h.fetchImpl = () => Promise.reject(new Error("fixture-only offline")); await h.app.fetchMarket();
    assert.ok(h.app.state.apiError); assert.equal(h.app.state.snapshot.options.length, 1); assert.equal(h.nodes.get("optionChain").hidden, false);
    h.fetchImpl = async () => ({ok: true, json: async () => snapshot({revision: 2})});
    h.click("refreshButton"); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.trace.at(-1), "/api/market?refresh=1"); assert.equal(h.app.state.apiError, null);
  });
  await check("focused quotes keep the expiry chooser and exit to the visible chain", () => {
    const h = harness(); h.document.hidden = false; h.app.acceptSnapshot(snapshot());
    h.click("focusButton"); assert.equal(h.document.body.classList.contains("quote-focus"), true);
    assert.equal(h.nodes.get("focusControls").hidden, false); assert.equal(h.document.activeElement.id, "exitFocus");
    assert.equal(h.nodes.get("expiryTabs").getClientRects().length, 1); assert.equal(h.nodes.has("focusSellPutButton"), false);
    h.click("exitFocus"); assert.equal(h.document.body.classList.contains("quote-focus"), false);
    assert.equal(h.nodes.get("focusControls").hidden, true); assert.equal(h.document.activeElement.id, "focusButton");
  });
  await check("returning to foreground renders the direct chain from its latest hidden snapshot", () => {
    const h = harness(); h.app.acceptSnapshot(snapshot()); assert.equal(h.nodes.get("optionChain").hidden, true);
    h.document.hidden = false; h.app.state.streamConnected = true; h.app.state.streamLastAt = Date.now(); h.emit("visibilitychange");
    assert.equal(h.nodes.get("optionChain").hidden, false); assert.ok((h.writes.get("chainBody") ?? 0) > 0);
    const deliveries = h.deliveries.length; h.intervals.find(timer => timer.delay === 1000).callback(); assert.equal(h.deliveries.length, deliveries);
  });
  await check("a payoff dialog keeps Escape while open and focus Escape works after it closes", () => {
    const h = harness(); h.click("focusButton"); h.nodes.get("payoffDialog").open = true; let prevented = false;
    h.emit("keydown", {key: "Escape", preventDefault() {prevented = true;}});
    assert.equal(prevented, false); assert.equal(h.document.body.classList.contains("quote-focus"), true);
    h.nodes.get("payoffDialog").open = false; h.emit("keydown", {key: "Escape", preventDefault() {prevented = true;}});
    assert.equal(prevented, true); assert.equal(h.document.body.classList.contains("quote-focus"), false);
  });
  await check("basic side selection works directly and does not activate any personal preset", () => {
    const h = harness(); h.document.hidden = false; const data = snapshot(), put = data.options[0];
    data.options.push({...put, side: "CALL", symbol: "BTC-991231-82000-C", strike_price: "82000"}); h.app.acceptSnapshot(data);
    const choose = side => h.click("sideButtons", {target: {closest: () => ({dataset: {side}})}});
    choose("CALL"); assert.equal(h.app.filteredOptions().length, 1); assert.equal(h.app.filteredOptions()[0].side, "CALL");
    choose("PUT"); assert.equal(h.app.filteredOptions().length, 1); assert.equal(h.app.filteredOptions()[0].side, "PUT");
    choose("ALL"); assert.equal(h.app.filteredOptions().length, 2); assert.ok(!Object.hasOwn(h.app.state, "rule"));
  });
  await check("integrated HTTP entry serves the active quote and payoff assets with correct MIME types", () => {
    const probe = [
      "import http.client,json,threading", "from btc_terminal_server import TerminalServer",
      "server=TerminalServer(('127.0.0.1',0),None,None,None)",
      "thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()", "result=[]", "try:",
      " for path in ['/app.js','/payoff.js','/payoff-ui.js','/payoff.css','/options.html','/option-ai-ui.js','/option-ai.css']:",
      "  client=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)",
      "  client.request('GET',path); response=client.getresponse(); body=response.read()",
      "  result.append({'path':path,'status':response.status,'type':response.getheader('Content-Type'),'bytes':len(body)})", "  client.close()",
      "finally:", " server.shutdown();server.server_close();thread.join(2)", "print(json.dumps(result))",
    ].join("\n");
    const replies = JSON.parse(execFileSync("python", ["-B", "-c", probe], {cwd: __dirname, encoding: "utf8", timeout: 15000}));
    for (const reply of replies) {assert.equal(reply.status, 200, reply.path); assert.ok(reply.bytes > 0, reply.path);
      assert.match(reply.type, reply.path.endsWith(".js") ? /^text\/javascript/ : reply.path.endsWith(".css") ? /^text\/css/ : /^text\/html/);}
  });
  await check("AI candidates are rechecked on the server and open the newest quote with the requested size", async () => {
    const h = harness(), data = snapshot(); h.document.hidden = false; h.app.acceptSnapshot(data);
    h.nodes.get("aiDialog").open = true;
    const row = {...data.options[0], bid_price: "58"};
    h.fetchImpl = async (url, options) => {
      assert.equal(url, "/api/option-ai/selection"); assert.equal(options.headers["X-Terminal-Request"], "1");
      assert.equal(JSON.parse(options.body).symbol, row.symbol);
      return {ok: true, json: async () => ({row, candidate: {quantity: .07}, snapshot: data})};
    };
    await h.aiHooks.onOpenCandidate({symbol: row.symbol, direction: "SELL"}, {criteria: {direction: "SELL"}, isCurrent: () => true});
    assert.equal(h.previews.length, 1); assert.equal(h.previews[0][0].row.bid_price, "58");
    assert.equal(h.previews[0][1], "SELL"); assert.equal(h.nodes.get("payoffQuantity").value, .07);
    assert.equal(h.previews[0][3].dataset.symbol, row.symbol); assert.equal(h.app.combo.active, false);
  });
  await check("AI selection rejection never opens a stale payoff or changes the selected expiry", async () => {
    const h = harness(); h.app.acceptSnapshot(snapshot()); h.nodes.get("aiDialog").open = true;
    const expiry = h.app.state.expiry;
    h.fetchImpl = async () => ({ok: false, json: async () => ({error: "当前报价不再符合条件"})});
    await assert.rejects(h.aiHooks.onOpenCandidate({symbol: "BTC-991231-62000-P", direction: "BUY"}, {criteria: {}}), /当前报价/);
    assert.equal(h.previews, undefined); assert.equal(h.app.state.expiry, expiry);
  });
  await check("closing and reopening AI cannot let an old selection response open another payoff", async () => {
    const h = harness(), data = snapshot(); h.app.acceptSnapshot(data); h.nodes.get("aiDialog").open = true;
    h.fetchImpl = async () => ({ok: true, json: async () => ({row: data.options[0], candidate: {quantity: .01}, snapshot: data})});
    await assert.rejects(h.aiHooks.onOpenCandidate({symbol: data.options[0].symbol, direction: "SELL"}, {criteria: {}, isCurrent: () => false}), /需求已变更/);
    assert.equal(h.previews, undefined);
  });
  await check("risk preset candidate opening carries its exact band to current-quote verification", async () => {
    const h = harness(), data = snapshot(); h.document.hidden = false; h.app.acceptSnapshot(data);
    h.nodes.get("aiDialog").open = true;
    h.fetchImpl = async (url, options) => {
      assert.equal(JSON.parse(options.body).risk_profile, "medium");
      return {ok: true, json: async () => ({row: data.options[0], candidate: {quantity: .03}, snapshot: data})};
    };
    await h.aiHooks.onOpenCandidate({symbol: data.options[0].symbol, direction: "SELL"},
      {criteria: {direction: "SELL", quantity: .03}, risk_profile: {id: "medium"}, isCurrent: () => true});
    assert.equal(h.previews[0][1], "SELL"); assert.equal(h.nodes.get("payoffQuantity").value, .03);
  });
  console.log(count + " direct quote integration checks passed");
})().catch(error => {console.error(error); process.exitCode = 1;});
