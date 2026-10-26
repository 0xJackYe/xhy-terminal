"use strict";
// The former personal-preset suite now guards the direct chain's basic filters.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {test} = require("node:test");
const source = fs.readFileSync("dashboard/dist/app.js", "utf8");
const html = fs.readFileSync("dashboard/dist/index.html", "utf8");
const NOW = Date.parse("2030-01-01T00:00:00Z"), DAY = 86400000;

function harness(rows = []) {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {value: "", textContent: "", attributes: {}, listeners: {},
        classList: {toggle(name, yes) {if (yes) classes.add(name); else classes.delete(name);}},
        setAttribute(name, value) {this.attributes[name] = value;},
        addEventListener(name, callback) {this.listeners[name] = callback;},
        querySelectorAll() {return [];}, querySelector() {return null;}});
    }
    return nodes.get(id);
  }
  class ClockDate extends Date {constructor(...args) {super(...(args.length ? args : [NOW]));} static now() {return NOW;}}
  const context = vm.createContext({document: {getElementById: node, querySelectorAll: () => []},
    window: {}, localStorage: {getItem: () => null}, Intl, Date: ClockDate, Map, Set, Object, Number, String, JSON});
  const definitions = source.slice(0, source.indexOf('$("expiryTabs").addEventListener'));
  vm.runInContext(definitions + "\nrender = () => renderFilters();\nthis.api = {state, filteredOptions, renderFilters, expiryDates, allOptions};", context);
  for (const line of source.split("\n")) {
    if (['sideButtons','atmButton','favoritesButton'].some(id => line.startsWith('$("'+id+'").addEventListener'))) vm.runInContext(line, context);
  }
  const reset = source.match(/\$\("resetButton"\)\.addEventListener\("click", \(\) => \{[\s\S]*?\n\}\);/)[0];
  vm.runInContext(reset, context);
  const api = context.api;
  api.state.snapshot = {btc_index_price: "80000", exchange_clock_offset_ms: 0, options: rows};
  api.state.expiry = "ALL";
  return {api, node, click: id => node(id).listeners.click({}),
    choose: side => node("sideButtons").listeners.click({target: {closest: () => ({dataset: {side}})}})};
}
function row(side, strike, days = 15) {
  return {side, strike_price: String(strike), expiry_ms: NOW + days * DAY,
    symbol: `BTC-${days}-${strike}-${side === "CALL" ? "C" : "P"}`};
}
const symbols = h => Array.from(h.api.filteredOptions(), item => item.symbol);

test("the quote chain starts with both sides and no duration or OTM preset", () => {
  const rows = [row("PUT", 79000, 1), row("CALL", 82000, 3), row("PUT", 40000, 60), row("CALL", 130000, 180)];
  const h = harness(rows); assert.deepEqual(symbols(h), rows.map(item => item.symbol));
  assert.equal(h.api.state.side,"ALL"); assert.equal(h.api.state.atm,false); assert.equal(h.api.state.favoritesOnly,false);
  assert.ok(!Object.hasOwn(h.api.state,"rule"));
  for(const id of ['ruleButton','callRuleButton','sellPutButton','sellCallButton']) assert.ok(!html.includes('id="'+id+'"'));
});
test("manual Call and Put choices use only the requested side without resetting expiry", () => {
  const put=row("PUT",79000),call=row("CALL",82000),h=harness([put,call]);
  h.choose("CALL");assert.deepEqual(symbols(h),[call.symbol]);assert.equal(h.api.state.expiry,"ALL");
  h.choose("PUT");assert.deepEqual(symbols(h),[put.symbol]);h.choose("ALL");assert.deepEqual(symbols(h),[put.symbol,call.symbol]);
});
test("explicit search matches contract symbols and comma-separated strikes",()=>{
  const put=row("PUT",79000),call=row("CALL",82000),h=harness([put,call]);
  h.api.state.search="82,000";assert.deepEqual(symbols(h),[call.symbol]);
  h.api.state.search=put.symbol.toLowerCase();assert.deepEqual(symbols(h),[put.symbol]);
  h.api.state.search="";assert.equal(symbols(h).length,2);
});
test("ATM filtering is opt-in and switching it off restores distant quoted strikes",()=>{
  const near=row("CALL",82000),far=row("PUT",40000),h=harness([near,far]);
  assert.equal(symbols(h).length,2);h.click("atmButton");assert.deepEqual(symbols(h),[near.symbol]);
  h.click("atmButton");assert.equal(symbols(h).length,2);
});
test("favorites filtering is opt-in and does not suppress the initial chain",()=>{
  const put=row("PUT",79000),call=row("CALL",82000),h=harness([put,call]);h.api.state.favorites.add(call.symbol);
  assert.equal(symbols(h).length,2);h.click("favoritesButton");assert.deepEqual(symbols(h),[call.symbol]);
  h.click("favoritesButton");assert.equal(symbols(h).length,2);
});
test("clear filters recovers quotes while preserving the chosen valid expiry",()=>{
  const rows=[row("PUT",79000),row("CALL",82000)],h=harness(rows),date=h.api.expiryDates()[0];
  Object.assign(h.api.state,{side:"CALL",search:"missing",atm:true,favoritesOnly:true,expiry:date});h.node("searchInput").value="missing";
  assert.equal(symbols(h).length,0);h.click("resetButton");assert.equal(h.api.state.expiry,date);assert.equal(h.node("searchInput").value,"");
  assert.deepEqual(symbols(h),rows.map(item=>item.symbol));assert.equal(h.api.state.atm,false);assert.equal(h.api.state.favoritesOnly,false);
});
test("real expiration still follows the calibrated exchange clock",()=>{
  const almost=row("PUT",79000,1/1440),later=row("CALL",82000,1),h=harness([almost,later]);
  assert.equal(h.api.allOptions().length,2);h.api.state.snapshot.exchange_clock_offset_ms=60000;
  assert.deepEqual(Array.from(h.api.allOptions(),item=>item.symbol),[later.symbol]);
});
