"use strict";

// Regression checks for source precision and out-of-order REST/SSE snapshots.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const riskUI = require("./dashboard/dist/risk-ui.js");
const source = fs.readFileSync(path.join(__dirname, "dashboard", "dist", "app.js"), "utf8");
const definitions = source.slice(0, source.indexOf('$("expiryTabs").addEventListener'));
const previews = [];
const portfolios = [];
const riskSnapshots = [];
const nodes = new Map();
function node(id) {
  if (!nodes.has(id)) nodes.set(id, {hidden: true, value: "", disabled: false, textContent: "", className: "", style: {}, listeners: {}, classList: {toggle() {}}, querySelector: () => node(`${id}:span`), querySelectorAll: () => [], addEventListener(name, callback) {this.listeners[name] = callback;}, setAttribute() {}, getBoundingClientRect: () => ({height: 90})});
  return nodes.get(id);
}
const context = vm.createContext({document: {hidden: true, body: {classList: {toggle() {}, contains: () => false}}, getElementById: node}, window: {OptionPayoffPreview: {open: (...args) => previews.push(args)}, OptionPortfolioPreview: {open: (config) => portfolios.push(config)}, OptionRiskUI: {onSnapshot: snapshot => riskSnapshots.push(snapshot), isVerifiedBook: riskUI.isVerifiedBook}}, localStorage: {getItem: () => null}, Intl, Date, Set, Map, Number, String, Object, JSON});
vm.runInContext(definitions + "\nthis.ui = {state, combo, comboKey, comboOptions, changeComboExpiry, setComboMode, comboLegFromQuote, toggleComboQuote, openComboPreview, priceFormat, ivFormat, mergeFreshSnapshot, acceptSnapshot, queueSnapshot, optionDate, detailValues, fieldDescription, quoteAction, activateQuoteCell, isLiveSnapshot, statisticsHealth, statisticsDescription, renderConnection, renderMarket, allOptions, daysLeft};", context);
const ui = context.ui;
let count = 0;
const check = (name, fn) => {fn(); count++; console.log(`OK ${name}`);};

check("mark precision is independent of order tick precision", () => {
  assert.equal(ui.priceFormat({price_scale: 2}, "315.89600000"), "315.896");
  assert.equal(ui.priceFormat({price_scale: 2}, "0.00001234"), "0.00001234");
  assert.equal(ui.priceFormat({}, "1.25e-7"), "0.000000125");
});
check("IV matches two decimal percentage display and preserves zero", () => {
  assert.equal(ui.ivFormat("0.4953"), "49.53%");
  assert.equal(ui.ivFormat("0"), "0.00%");
  assert.equal(ui.ivFormat(null), "—");
  assert.equal(ui.ivFormat("-1"), "—");
});

const epoch = Date.parse("2026-10-13T12:00:00Z");
const expiry = Date.now() + 45 * 86400000;
const contract = {symbol: "BTC-TEST-64000-P", side: "PUT", expiry_ms: expiry, expiry_beijing: new Date(expiry).toISOString(), strike_price: "64000", price_scale: 2};
const olderRest = {status: "SUCCESS", options: [{...contract, bid_price: "315", ask_price: "325", mark_price: "315.896", delta: "-0.04914", last_price: "316", quote_updated_at: epoch, mark_updated_at: epoch, ticker_updated_at: epoch, quote_source: "rest", mark_source: "rest", ticker_source: "rest", field_updated_at: {bid_price: epoch, ask_price: epoch, mark_price: epoch, delta: epoch, last_price: epoch}, field_source: {bid_price: "rest", ask_price: "rest", mark_price: "rest", delta: "rest", last_price: "rest"}, field_event_ms: {bid_price: null, ask_price: null, mark_price: null}}], fetched_at: new Date(epoch).toISOString(), btc_index_price: "83000", index_updated_at: epoch, index_source: "rest", revision: 1};
const latestWs = {...olderRest, revision: 5, btc_index_price: "83100", index_updated_at: epoch + 2000, index_source: "websocket", index_event_ms: epoch + 1990, options: [{...olderRest.options[0], bid_price: "320", mark_price: "315.961", quote_updated_at: epoch + 2000, mark_updated_at: epoch + 2000, quote_source: "websocket", mark_source: "websocket", quote_event_ms: epoch + 1990, mark_event_ms: epoch + 1990, field_updated_at: {bid_price: epoch + 2000, ask_price: epoch, mark_price: epoch + 2000, delta: epoch, last_price: epoch}, field_source: {bid_price: "websocket", ask_price: "rest", mark_price: "websocket", delta: "rest", last_price: "rest"}, field_event_ms: {bid_price: epoch + 1990, ask_price: null, mark_price: epoch + 1990}}]};
const slowRest = {...olderRest, revision: 6, fetched_at: new Date(epoch + 3000).toISOString(), options: [{...olderRest.options[0], last_price: "322", field_updated_at: {...olderRest.options[0].field_updated_at, last_price: epoch + 3000}}]};

check("late REST preserves each newer WS field and its source event time", () => {
  const merged = ui.mergeFreshSnapshot(latestWs, slowRest);
  assert.equal(merged.options[0].bid_price, "320");
  assert.equal(merged.options[0].mark_price, "315.961");
  assert.equal(merged.options[0].field_event_ms.bid_price, epoch + 1990);
  assert.equal(merged.options[0].field_source.bid_price, "websocket");
  assert.equal(merged.options[0].delta, "-0.04914");
  assert.equal(merged.options[0].last_price, "322");
  assert.equal(merged.btc_index_price, "83100");
});
check("lower revision cannot roll back the displayed snapshot", () => {
  ui.acceptSnapshot(latestWs);
  ui.acceptSnapshot(olderRest);
  assert.equal(ui.state.snapshot.revision, 5);
  assert.equal(ui.state.snapshot.options[0].bid_price, "320");
});
check("restarted server instance can reset revision without losing fresh fields", () => {
  ui.acceptSnapshot({...latestWs, instance_id: "before-restart", revision: 2000});
  ui.acceptSnapshot({...slowRest, instance_id: "after-restart", revision: 1});
  assert.equal(ui.state.snapshot.instance_id, "after-restart");
  assert.equal(ui.state.snapshot.revision, 1);
  assert.equal(ui.state.snapshot.options[0].bid_price, "320");
  assert.equal(ui.state.snapshot.options[0].last_price, "322");
});
check("accepted SSE snapshots notify risk analysis while the page is hidden and older revisions do not", () => {
  const saved=ui.state.snapshot, before=riskSnapshots.length;
  assert.equal(context.document.hidden,true);
  ui.queueSnapshot({...latestWs,instance_id:"risk-event-test",revision:10});
  assert.equal(riskSnapshots.length,before+1);assert.equal(riskSnapshots.at(-1),ui.state.snapshot);assert.equal(riskSnapshots.at(-1).revision,10);
  ui.acceptSnapshot({...olderRest,instance_id:"risk-event-test",revision:9});
  assert.equal(riskSnapshots.length,before+1);assert.equal(ui.state.snapshot.revision,10);
  ui.state.snapshot=saved;
});
check("an unavailable snapshot still notifies risk analysis about retained-state health", () => {
  const saved=ui.state.snapshot;ui.state.snapshot={...latestWs,instance_id:"risk-health-test",revision:10};const before=riskSnapshots.length;
  ui.acceptSnapshot({instance_id:"risk-health-test",revision:11,options:[],btc_index_price:null,error:{message:"feed unavailable"},realtime:{connected:false}});
  assert.equal(riskSnapshots.length,before+1);assert.equal(riskSnapshots.at(-1),ui.state.snapshot);assert.equal(ui.state.snapshot.stale,true);assert.equal(ui.state.snapshot.options[0].bid_price,"320");assert.equal(ui.state.snapshot.realtime.connected,false);
  ui.state.snapshot=saved;
});
check("a higher-revision certified book retains its entire quote group over newer REST change receipts",()=>{
  const saved=ui.state.snapshot,at=Date.now(),old=at-3600000,fields=["bid_price","ask_price","bid_quantity","ask_quantity"];
  const book={...contract,bid_price:"100",ask_price:"110",bid_quantity:"1.2",ask_quantity:"1.3",quote_updated_at:old,quote_source:"websocket",quote_event_ms:old-10,field_updated_at:Object.fromEntries(fields.map(field=>[field,old])),field_source:Object.fromEntries(fields.map(field=>[field,"websocket"])),field_event_ms:Object.fromEntries(fields.map(field=>[field,old-10])),quote_verified_at:at};
  book.quote_verification={verified:true,kind:"bookTicker",connection:"book-2",generation:3,verified_at:at,baseline_at:old,values:Object.fromEntries(fields.map(field=>[field,book[field]]))};
  const incoming={instance_id:"coherent-book",revision:6,options:[book],btc_index_price:"83000",index_updated_at:at,index_source:"websocket",fetched_at:new Date(old).toISOString()};
  const rest={...book,bid_price:"500",ask_price:"510",bid_quantity:"8",ask_quantity:"9",quote_updated_at:at-100,quote_source:"rest",quote_event_ms:null,field_updated_at:Object.fromEntries(fields.map(field=>[field,at-100])),field_source:Object.fromEntries(fields.map(field=>[field,"rest"])),field_event_ms:Object.fromEntries(fields.map(field=>[field,null])),quote_verified_at:null,quote_verification:null};
  const previous={...incoming,revision:5,options:[rest]},before=JSON.stringify({previous,incoming});ui.state.snapshot=previous;ui.acceptSnapshot(incoming);let merged=ui.state.snapshot.options[0];
  for(const field of fields){assert.equal(merged[field],book[field]);assert.equal(merged.field_updated_at[field],old);assert.equal(merged.field_source[field],"websocket");assert.equal(merged.field_event_ms[field],old-10);}
  assert.equal(merged.quote_updated_at,old);assert.equal(merged.quote_source,"websocket");assert.equal(merged.quote_event_ms,old-10);assert.equal(riskUI.isVerifiedBook(merged,at),true);assert.equal(JSON.stringify({previous,incoming}),before);
  ui.acceptSnapshot(previous);assert.equal(ui.state.snapshot.revision,6);assert.equal(ui.state.snapshot.options[0].bid_price,"100");
  const partial={...book,bid_price:"0",quote_verified_at:null,quote_verification:null,quote_updated_at:at+1,field_updated_at:{...book.field_updated_at,bid_price:at+1},field_event_ms:{...book.field_event_ms,bid_price:at+1}};
  ui.acceptSnapshot({...incoming,revision:7,options:[partial]});merged=ui.state.snapshot.options[0];assert.equal(merged.bid_price,"0");assert.equal(merged.ask_price,"110");assert.equal(merged.quote_verification,null);assert.equal(riskUI.isVerifiedBook(merged,at+1),false);
  ui.state.snapshot=saved;
});
check("ordinary field merging cannot manufacture a valid certificate out of an initially mismatched proof",()=>{
  const at=Date.now(),old=at-3600000,fields=["bid_price","ask_price","bid_quantity","ask_quantity"];
  const oldRow={...contract,bid_price:"100",ask_price:"110",bid_quantity:"1",ask_quantity:"1",quote_updated_at:at-1,quote_source:"rest",field_updated_at:Object.fromEntries(fields.map(field=>[field,at-1]))};
  const incomingRow={...oldRow,bid_price:"101",ask_price:"111",quote_updated_at:old,quote_source:"websocket",field_updated_at:Object.fromEntries(fields.map(field=>[field,old])),quote_verified_at:at,quote_verification:{verified:true,kind:"bookTicker",connection:"book-0",generation:1,verified_at:at,baseline_at:old,values:{bid_price:"100",ask_price:"110",bid_quantity:"1",ask_quantity:"1"}}};
  assert.equal(riskUI.isVerifiedBook(incomingRow,at),false);const merged=ui.mergeFreshSnapshot({options:[oldRow]},{options:[incomingRow]}).options[0];
  assert.equal(merged.bid_price,"100");assert.equal(merged.quote_verification,null);assert.equal(merged.quote_verified_at,null);assert.equal(riskUI.isVerifiedBook(merged,at),false);
});
check("field metadata separates WS exchange time from REST receive time", () => {
  const row = latestWs.options[0];
  assert.match(ui.fieldDescription(row, "quote", "bid_price"), /WebSocket · 源时间/);
  assert.match(ui.fieldDescription(row, "quote", "bid_price"), /本机接收/);
  assert.match(ui.fieldDescription(row, "quote", "ask_price"), /REST 本机接收/);
  assert.match(ui.fieldDescription(row, "mark", "mark_price"), /WebSocket · 源时间/);
});
check("expiry uses actual official milliseconds and Beijing timezone", () => {
  const row = {...contract, expiry_ms: Date.parse("2027-01-15T09:30:00Z"), expiry_beijing: "2027-01-15T17:30:00+08:00"};
  assert.equal(ui.optionDate(row), "2027-01-15");
  assert.match(ui.detailValues(row).expiry, /17:30:00/);
});
check("expiry grouping follows the official instant even when a cached display date disagrees", () => {
  const row = {...contract, expiry_ms: Date.parse("2027-01-15T16:30:00Z"), expiry_beijing: "2027-01-15T16:00:00+08:00"};
  assert.equal(ui.optionDate(row), "2027-01-16");
  assert.match(ui.detailValues(row).expiry, /2027\/01\/16 00:30:00/);
});
check("expiration filtering uses Binance clock offset", () => {
  const saved = ui.state.snapshot;
  const row = {...contract, expiry_ms: Date.now() + 3000};
  ui.state.snapshot = {...saved, options: [row], exchange_clock_offset_ms: 5000};
  assert.equal(ui.allOptions().length, 0);
  assert.ok(ui.daysLeft(row) < 0);
  ui.state.snapshot = saved;
});
check("clicking ask buys and clicking bid sells for both Call and Put", () => {
  const saved = ui.state.snapshot;
  for (const type of ["CALL", "PUT"]) {
    const row = {...contract, side: type, symbol: `BTC-TEST-64000-${type === "CALL" ? "C" : "P"}`};
    ui.state.snapshot = {...saved, options: [row]};
    for (const [column, direction] of [["ask", "BUY"], ["bid", "SELL"]]) {
      ui.activateQuoteCell({dataset: {symbol: row.symbol, column}});
      const [market, selectedDirection, latest] = previews.at(-1);
      assert.equal(selectedDirection, direction);
      assert.equal(market.row.symbol, row.symbol);
      assert.equal(latest().row.symbol, row.symbol);
      assert.match(ui.quoteAction(row, column), direction === "BUY" ? /按卖一价模拟买入/ : /按买一价模拟卖出/);
    }
  }
  ui.state.snapshot = saved;
});
check("upstream disconnect or old messages mark preview data as cached", () => {
  const now = Date.now(), saved = ui.state.snapshot;
  ui.state.streamConnected = true; ui.state.streamLastAt = now;
  const row = {...contract, bid_price: "320"};
  const current = {...saved, stale: false, options: [row], realtime: {connected: true, last_message_at: now}};
  assert.equal(ui.isLiveSnapshot(current), true);
  for (const realtime of [{connected: false, last_message_at: now}, {connected: true, last_message_at: now - 30000}]) {
    ui.state.snapshot = {...current, realtime};
    ui.activateQuoteCell({dataset: {symbol: row.symbol, column: "bid"}});
    assert.equal(previews.at(-1)[0].snapshot.stale, true);
  }
  ui.state.snapshot = saved; ui.state.streamConnected = false;
});
const fixedNow = Date.parse("2026-10-14T06:00:00+08:00");
const todayCall = {...contract, symbol: "BTC-261014-83000-C", side: "CALL", expiry_ms: Date.parse("2026-10-14T16:00:00+08:00"), expiry_beijing: "2026-10-14T16:00:00+08:00", unit: "1", min_qty: "0.01", ask_price: "400", bid_price: "380"};
const todayPut = {...todayCall, symbol: "BTC-261014-83000-P", side: "PUT", ask_price: "300", bid_price: "280"};
check("same-expiry basket freezes selected ask/bid quotes and direction", () => {
  ui.state.snapshot = {btc_index_price: "83100", exchange_clock_offset_ms: fixedNow - Date.now(), options: [todayCall, todayPut]};
  ui.state.expiry = "2026-10-14";
  ui.changeComboExpiry("2026-10-14");
  const buy = ui.comboLegFromQuote(todayCall, "ask"), sell = ui.comboLegFromQuote(todayPut, "bid");
  assert.equal(buy.direction, "BUY"); assert.equal(buy.premium, "400"); assert.equal(buy.quantity, "0.01");
  assert.equal(sell.direction, "SELL"); assert.equal(sell.premium, "280");
  todayCall.ask_price = "405";
  assert.equal(buy.row.ask_price, "400"); assert.equal(buy.premium, "400");
  todayCall.ask_price = "400";
  assert.notEqual(ui.comboKey(todayCall.symbol, "BUY"), ui.comboKey(todayCall.symbol, "SELL"));
});
check("different-expiry, expired, non-price or zero-price quotes cannot enter selected basket", () => {
  assert.throws(() => ui.comboLegFromQuote({...todayCall, expiry_ms: fixedNow - 1000}, "ask"), /尚未到期/);
  assert.throws(() => ui.comboLegFromQuote({...todayCall, expiry_ms: Date.parse("2026-10-15T16:00:00+08:00"), expiry_beijing: "2026-10-15T16:00:00+08:00"}, "ask"), /同一到期日/);
  assert.throws(() => ui.comboLegFromQuote(todayCall, "mark"), /买价或卖价/);
  assert.throws(() => ui.comboLegFromQuote({...todayCall, bid_price: "0"}, "bid"), /没有有效买一报价/);
});
check("multi-select accumulates Call and Put without opening single-leg modal; repeat removes", () => {
  // Stub only rendering so the actual click routing and selection state run.
  vm.runInContext("renderCombo = () => {}; syncComboCells = () => {};", context);
  ui.combo.active = true; ui.combo.legs.clear();
  const before = previews.length;
  ui.activateQuoteCell({dataset: {symbol: todayCall.symbol, column: "ask"}});
  ui.activateQuoteCell({dataset: {symbol: todayPut.symbol, column: "ask"}});
  assert.equal(previews.length, before); assert.equal(ui.combo.legs.size, 2);
  assert.equal(ui.combo.legs.get(ui.comboKey(todayCall.symbol, "BUY")).direction, "BUY");
  assert.equal(ui.combo.legs.get(ui.comboKey(todayPut.symbol, "BUY")).direction, "BUY");
  ui.activateQuoteCell({dataset: {symbol: todayCall.symbol, column: "ask"}});
  assert.equal(ui.combo.legs.size, 1);
  ui.activateQuoteCell({dataset: {symbol: todayPut.symbol, column: "bid"}});
  assert.equal(ui.combo.legs.size, 2);
  assert.ok(ui.combo.legs.has(ui.comboKey(todayPut.symbol, "BUY")));
  assert.ok(ui.combo.legs.has(ui.comboKey(todayPut.symbol, "SELL")));
  ui.combo.active = false;
  ui.activateQuoteCell({dataset: {symbol: todayCall.symbol, column: "ask"}});
  assert.equal(previews.length, before + 1);
});
check("combo refresh reads requested remaining legs and rejects expired/delisted ones", () => {
  const third = {...todayCall, symbol: "BTC-261014-84000-C", strike_price: "84000"};
  ui.combo.legs.clear();
  for (const row of [todayCall, todayPut, third]) ui.combo.legs.set(ui.comboKey(row.symbol, "BUY"), ui.comboLegFromQuote(row, "ask"));
  ui.state.snapshot.options = [todayCall, todayPut, third];
  ui.openComboPreview();
  const opened = portfolios.at(-1);
  assert.equal(opened.legs.length, 3);
  ui.state.snapshot.options = [{...todayCall, ask_price: "410"}, todayPut];
  const latest = opened.getLatest(opened.legs.slice(0, 2));
  assert.equal(latest.error, undefined); assert.equal(latest.legs.length, 2);
  assert.equal(latest.legs[0].premium, "410"); assert.equal(opened.legs[0].premium, "400");
  assert.match(opened.getLatest().error, /已到期|移除/);
  ui.state.snapshot.exchange_clock_offset_ms += 11 * 3600000;
  assert.match(opened.getLatest(opened.legs.slice(0, 2)).error, /已到期/);
});
check("enabling combo preserves a selected future expiry and permits future legs", () => {
  vm.runInContext("render = () => {};", context);
  const futureCall = {...todayCall, symbol: "BTC-261016-83000-C", expiry_ms: Date.parse("2026-10-16T16:00:00+08:00"), expiry_beijing: "2026-10-16T16:00:00+08:00"};
  const futurePut = {...futureCall, symbol: "BTC-261016-83000-P", side: "PUT"};
  ui.state.snapshot = {btc_index_price: "83100", exchange_clock_offset_ms: fixedNow - Date.now(), options: [todayCall, todayPut, futureCall, futurePut]};
  ui.combo.active = false; ui.state.expiry = "2026-10-16";
  ui.setComboMode(true);
  assert.equal(ui.state.expiry, "2026-10-16"); assert.equal(ui.combo.expiry, "2026-10-16"); assert.equal(ui.combo.active, true);
  ui.toggleComboQuote(futureCall, "ask"); ui.toggleComboQuote(futurePut, "ask");
  assert.equal(ui.combo.legs.size, 2);
  assert.equal(ui.combo.legs.get(ui.comboKey(futureCall.symbol, "BUY")).row.expiry_beijing, futureCall.expiry_beijing);
  assert.throws(() => ui.comboLegFromQuote(todayCall, "ask"), /同一到期日/);
  ui.openComboPreview();
  assert.equal(portfolios.at(-1).getLatest().legs.length, 2);
});
check("switching expiry clears old legs and allows a distant date without leaving combo mode", () => {
  const farCall = {...todayCall, symbol: "BTC-261127-83000-C", expiry_ms: Date.parse("2026-11-27T16:00:00+08:00"), expiry_beijing: "2026-11-27T16:00:00+08:00"};
  ui.changeComboExpiry("2026-11-27"); ui.state.expiry = "2026-11-27";
  ui.state.snapshot.options.push(farCall);
  assert.equal(ui.combo.active, true); assert.equal(ui.combo.legs.size, 0);
  ui.toggleComboQuote(farCall, "ask");
  assert.equal(ui.combo.legs.size, 1);
  assert.equal(ui.combo.legs.values().next().value.row.symbol, farCall.symbol);
  assert.throws(() => ui.comboLegFromQuote({...farCall, symbol: "BTC-261127-83000-P", side: "PUT", expiry_ms: farCall.expiry_ms + 3600000}, "ask"), /到期时间/);
});
check("ALL entry selects the nearest still-valid expiry rather than requiring today's date", () => {
  ui.combo.active = false; ui.state.expiry = "ALL";
  ui.state.snapshot.exchange_clock_offset_ms = fixedNow + 11 * 3600000 - Date.now();
  ui.setComboMode(true);
  assert.equal(ui.state.expiry, "2026-10-16"); assert.equal(ui.combo.expiry, "2026-10-16"); assert.equal(ui.combo.legs.size, 0);
});
check("automatic expiry rollover keeps combo date aligned and clears expired legs", () => {
  const expired = ui.state.snapshot.options.find((row) => row.symbol === "BTC-261016-83000-C");
  ui.state.expiry = "2026-10-16"; ui.changeComboExpiry("2026-10-16"); ui.combo.active = true;
  ui.combo.legs.set(ui.comboKey(expired.symbol, "BUY"), {row: expired, direction: "BUY", quantity: "0.01", premium: "400"});
  ui.acceptSnapshot({...ui.state.snapshot, exchange_clock_offset_ms: Date.parse("2026-10-16T17:00:00+08:00") - Date.now()});
  assert.equal(ui.state.expiry, "2026-11-27"); assert.equal(ui.combo.expiry, "2026-11-27"); assert.equal(ui.combo.legs.size, 0);
});

// Register and execute the actual resetButton listener, including its state
// transitions. Testing changeComboExpiry alone missed the original mismatch.
vm.runInContext(source.slice(source.indexOf('$("resetButton").addEventListener'), source.indexOf('$("chainBody").addEventListener')), context);
check("actual clear-filters click preserves the selected combo expiry and frozen legs", () => {
  const now = Date.now();
  const near = {...todayCall, symbol: "BTC-NEAR-83000-C", expiry_ms: Date.parse("2026-10-15T16:00:00+08:00"), expiry_beijing: "2026-10-15T16:00:00+08:00"};
  const far = {...todayCall, symbol: "BTC-FAR-83000-C", expiry_ms: Date.parse("2026-11-27T16:00:00+08:00"), expiry_beijing: "2026-11-27T16:00:00+08:00"};
  ui.state.snapshot = {btc_index_price: "83100", options: [near, far], exchange_clock_offset_ms: fixedNow - now};
  ui.state.expiry = "2026-11-27"; ui.state.search = "not-a-contract"; ui.state.side = "PUT"; ui.state.atm = true;
  ui.combo.active = true; ui.combo.expiry = "2026-11-27"; ui.combo.legs.clear();
  const key = ui.comboKey(far.symbol, "BUY"), leg = ui.comboLegFromQuote(far, "ask");
  ui.combo.legs.set(key, leg); node("searchInput").value = ui.state.search;
  node("resetButton").listeners.click();
  assert.equal(ui.state.expiry, "2026-11-27"); assert.equal(ui.combo.expiry, "2026-11-27"); assert.equal(ui.combo.active, true);
  assert.equal(ui.combo.legs.get(key), leg); assert.equal(leg.premium, "400"); assert.equal(ui.state.search, ""); assert.equal(node("searchInput").value, "");
  assert.equal(ui.state.side, "ALL"); assert.equal(ui.state.atm, false); assert.doesNotThrow(() => ui.comboLegFromQuote(far, "ask"));
});
check("actual clear-filters click keeps a valid normal date or ALL, and safely rolls an expired basket", () => {
  ui.combo.active = false; ui.state.expiry = "2026-11-27";
  node("resetButton").listeners.click(); assert.equal(ui.state.expiry, "2026-11-27");
  ui.state.expiry = "ALL"; node("resetButton").listeners.click(); assert.equal(ui.state.expiry, "ALL");
  ui.combo.active = true; ui.combo.expiry = "2026-10-14"; ui.state.expiry = "2026-10-14";
  node("resetButton").listeners.click();
  assert.equal(ui.state.expiry, "2026-10-15"); assert.equal(ui.combo.expiry, "2026-10-15"); assert.equal(ui.combo.legs.size, 0);
});

const healthyCore = {quote: {status: "live"}, mark: {status: "live"}, index: {status: "live"}};
function statisticsSnapshot({age = 2, source = "rest", error = null, missing = false, health = undefined} = {}) {
  const now = Date.now();
  const row = {...todayCall, expiry_ms: now + 86400000, volume_24h_contracts: missing ? null : "0", amount_24h_quote: missing ? null : "1200.5", ticker_updated_at: now - age * 1000, ticker_source: source};
  return {options: [row], btc_index_price: "83100", fetched_at: new Date(now - age * 1000).toISOString(), realtime: {connected: true, last_message_at: now}, error, data_health: health};
}
check("missing statistics stay unavailable while genuine zero volume is preserved", () => {
  ui.state.snapshot = statisticsSnapshot({missing: true}); ui.renderMarket();
  assert.equal(node("marketVolume").textContent, "—"); assert.equal(node("marketAmount").textContent, "—");
  assert.equal(ui.statisticsHealth().status, "unavailable"); assert.match(node("statisticsStatus").textContent, /暂无数据/);
  ui.state.snapshot = statisticsSnapshot(); ui.renderMarket();
  assert.equal(node("marketVolume").textContent, "0"); assert.equal(node("marketAmount").textContent, "1,200.5");
  assert.match(node("statisticsStatus").textContent, /已更新.*最早更新/);
});
check("live quotes plus old REST statistics or REST failure are independently marked in normal and focus modes", () => {
  ui.state.streamConnected = true; ui.state.streamLastAt = Date.now(); ui.state.apiError = null;
  ui.state.snapshot = statisticsSnapshot({age: 744, error: {message: "timeout"}});
  ui.renderConnection();
  assert.match(node("connectionBadge:span").textContent, /报价实时/);
  assert.match(node("statisticsStatus").textContent, /旧缓存.*最早更新.*刷新失败/);
  assert.match(node("noticeBar").textContent, /部分数据刷新失败.*报价实时/);
  assert.doesNotMatch(node("noticeBar").textContent, /报价缓存|重连中/);
  assert.equal(node("focusStatus").textContent, "统计旧缓存"); assert.doesNotMatch(node("focusStatus").textContent, /实时/);
  ui.state.snapshot = statisticsSnapshot({age: 1, error: {message: "timeout"}}); ui.renderConnection();
  assert.equal(node("focusStatus").textContent, "统计刷新失败"); assert.match(node("statisticsStatus").textContent, /刷新失败/);
  assert.doesNotMatch(node("statisticsStatus").textContent, /旧缓存/);
});
check("mixed WS statistics retain oldest REST time and partial coverage is explicit", () => {
  const snapshot = statisticsSnapshot({age: 100}); const row = snapshot.options[0];
  row.field_source = {volume_24h_contracts: "websocket", amount_24h_quote: "rest"};
  row.field_updated_at = {volume_24h_contracts: Date.now(), amount_24h_quote: Date.now() - 100000};
  ui.state.snapshot = snapshot; ui.renderConnection();
  assert.equal(ui.statisticsHealth().source, "mixed"); assert.ok(ui.statisticsHealth().ageSeconds >= 100);
  assert.match(node("statisticsStatus").textContent, /旧缓存.*最早更新/);
  row.amount_24h_quote = null; ui.renderMarket();
  assert.equal(ui.statisticsHealth().status, "partial"); assert.equal(node("marketAmount").textContent, "—");
  assert.match(node("statisticsStatus").textContent, /部分缺失/); assert.equal(node("focusStatus").textContent, "统计缺失");
});
check("partial freshness with complete statistics is marked old, not missing", () => {
  const snapshot = statisticsSnapshot({age: 100, health: {...healthyCore, ticker: {status: "partial", missing_fields: 0, available_fields: 2, total_fields: 2, fresh_fields: 1}}});
  snapshot.options[0].field_source = {volume_24h_contracts: "websocket", amount_24h_quote: "rest"};
  snapshot.options[0].field_updated_at = {volume_24h_contracts: Date.now(), amount_24h_quote: Date.now() - 100000};
  ui.state.snapshot = snapshot; ui.renderMarket();
  assert.equal(ui.statisticsHealth().status, "partial"); assert.equal(ui.statisticsHealth().missing, false);
  assert.equal(node("marketVolume").textContent, "0"); assert.equal(node("marketAmount").textContent, "1,200.5");
  assert.match(node("statisticsStatus").textContent, /部分旧缓存.*最早更新/);
  assert.doesNotMatch(node("statisticsStatus").textContent, /缺失/); assert.equal(node("focusStatus").textContent, "统计旧缓存");
});
check("verified quiet ticker remains live and healthy recovery clears warnings and focus wording", () => {
  ui.state.snapshot = statisticsSnapshot({age: 3600, source: "websocket", health: {...healthyCore, ticker: {status: "live", source: "websocket"}}});
  ui.renderConnection(); assert.equal(ui.statisticsHealth().status, "live");
  assert.match(node("statisticsStatus").textContent, /24h 统计：实时/); assert.equal(node("focusStatus").textContent, "");
  ui.state.snapshot = statisticsSnapshot({health: {...healthyCore, ticker: {status: "fresh", source: "rest"}}}); ui.renderConnection();
  assert.match(node("statisticsStatus").textContent, /已更新/); assert.doesNotMatch(node("statisticsStatus").textContent, /旧缓存|失败/);
  assert.equal(node("focusStatus").textContent, ""); assert.equal(node("noticeBar").hidden, true);
});
check("verified quiet ticker keeps old REST and mixed baseline fields healthy without changing provenance", () => {
  for (const mixed of [false, true]) {
    const snapshot = statisticsSnapshot({age: 3600, source: "rest", health: {...healthyCore, ticker: {status: "live", stream_verified: true, rest_refresh_failed: false}}});
    if (mixed) {
      snapshot.options[0].field_source = {volume_24h_contracts: "websocket", amount_24h_quote: "rest"};
      snapshot.options[0].field_updated_at = {volume_24h_contracts: Date.now() - 1800000, amount_24h_quote: Date.now() - 3600000};
    }
    ui.state.snapshot = snapshot; ui.renderConnection();
    const health = ui.statisticsHealth();
    assert.equal(health.status, "live"); assert.equal(health.stale, false); assert.ok(health.ageSeconds >= 3600);
    assert.equal(health.source, mixed ? "mixed" : "rest");
    assert.match(node("statisticsStatus").textContent, /24h 统计：实时.*最早更新/);
    assert.doesNotMatch(node("statisticsStatus").textContent, /旧缓存/); assert.equal(node("focusStatus").textContent, "");
  }
});
check("group-specific successful statistics do not inherit another REST group's failure", () => {
  ui.state.snapshot = statisticsSnapshot({error: {message: "mark failed"}, health: {...healthyCore, ticker: {status: "fresh", rest_refresh_failed: false}}});
  ui.renderConnection();
  assert.equal(ui.statisticsHealth().restFailed, false); assert.equal(node("focusStatus").textContent, "");
  assert.doesNotMatch(node("statisticsStatus").textContent, /刷新失败|旧缓存/);
});
check("new health distinguishes core quotation status from another disconnected stream", () => {
  const snapshot = statisticsSnapshot({health: JSON.parse(JSON.stringify({...healthyCore, ticker: {status: "stale"}}))});
  snapshot.realtime.connected = false;
  assert.equal(ui.isLiveSnapshot(snapshot), true);
  snapshot.data_health.quote.status = "partial";
  assert.equal(ui.isLiveSnapshot(snapshot), false);
});

check("mark failure does not turn independently live books into quote-cache warnings", () => {
  ui.state.streamConnected = true; ui.state.streamLastAt = Date.now(); ui.state.currentSnapshotUnavailable = false;
  ui.state.apiError = null;
  ui.state.snapshot = statisticsSnapshot({health: {...healthyCore, mark: {status: "stale", rest_refresh_failed: true}, ticker: {status: "fresh"}}, error: {message: "mark failed", failed_endpoints: {mark: {}}}});
  ui.state.snapshot.realtime.connection_details = {market: {connected: false}, "book-0": {connected: true}};
  ui.renderConnection();
  assert.equal(node("connectionBadge:span").textContent, "报价实时");
  assert.match(node("noticeBar").textContent, /标记价.*旧缓存/);
  assert.match(node("noticeBar").textContent, /标记价通道中断/);
  assert.doesNotMatch(node("noticeBar").textContent, /报价缓存|盘口通道中断/);
  assert.equal(ui.isLiveSnapshot(ui.state.snapshot), false);
});
check("partial books report their exact fresh field coverage without claiming all books live", () => {
  ui.state.snapshot = statisticsSnapshot({health: {...healthyCore, quote: {status: "partial", fresh_fields: 1398, total_fields: 1400}, ticker: {status: "fresh"}}});
  ui.renderConnection();
  assert.match(node("connectionBadge:span").textContent, /报价部分更新.*1,?398\/1,?400/);
  assert.match(node("noticeBar").textContent, /不能视为全部实时/);
  assert.doesNotMatch(node("noticeBar").textContent, /自动重连/);
});
check("index failure is identified separately while current books remain live", () => {
  ui.state.snapshot = statisticsSnapshot({health: {...healthyCore, index: {status: "stale"}, ticker: {status: "fresh"}}});
  ui.renderConnection();
  assert.equal(node("connectionBadge:span").textContent, "报价实时");
  assert.match(node("noticeBar").textContent, /指数：旧缓存/);
  assert.doesNotMatch(node("noticeBar").textContent, /报价缓存|自动重连/);
});
check("local event-stream loss never leaves a live quote badge even with old healthy metadata", () => {
  ui.state.snapshot = statisticsSnapshot({health: {...healthyCore, ticker: {status: "fresh"}}});
  ui.state.streamConnected = false;
  ui.renderConnection();
  assert.match(node("connectionBadge:span").textContent, /本地推送中断/);
  assert.match(node("noticeBar").textContent, /正在恢复本地连接/);
  ui.state.streamConnected = true; ui.state.streamLastAt = Date.now();
});

// Keep the document listener intact; replace only table/detail rendering so the
// actual modal state, inert restoration, focus return and Esc routing execute.
const drawerNodes = new Map(), drawerListeners = {}, drawerModes = new Set(["quote-focus"]), focusTransitions = [];
let drawerCells = [];
const drawerDocument = {hidden: true, activeElement: null, getElementById: drawerNode, addEventListener(name, callback) {drawerListeners[name] = callback;}, body: {children: [], classList: {contains: (name) => drawerModes.has(name), toggle(name, enabled) {if (enabled) drawerModes.add(name); else drawerModes.delete(name);}}}};
function drawerNode(id) {
  if (!drawerNodes.has(id)) drawerNodes.set(id, {id, tagName: id.endsWith("Dialog") ? "DIALOG" : "DIV", hidden: id === "detailDrawer" || id === "drawerBackdrop", open: false, inert: false, isConnected: true, dataset: {}, attributes: {}, setAttribute(name, value) {this.attributes[name] = value;}, focus() {drawerDocument.activeElement = this;}, closest() {return this.dataset.symbol ? this : null;}, getClientRects() {return this.hidden ? [] : [{}];}, querySelectorAll() {return id === "chainBody" ? drawerCells : id === "detailDrawer" ? [drawerNode("closeDrawer"), drawerNode("detailFavorite")] : [];}, contains(element) {return [drawerNode("closeDrawer"), drawerNode("detailFavorite")].includes(element);}});
  return drawerNodes.get(id);
}
drawerDocument.body.children = ["header", "chainArea", "comboTray", "focusControls", "alreadyInert", "drawerBackdrop", "detailDrawer", "payoffDialog", "portfolioDialog", "helpDialog"].map(drawerNode);
drawerNode("alreadyInert").inert = true;
const drawerContext = vm.createContext({document: drawerDocument, window: {}, localStorage: {getItem: () => null}, Intl, Date, Set, Map, Number, String, Object, JSON, focusTransitions});
vm.runInContext(definitions + '\nrenderDrawer=()=>{};renderChain=()=>{}; function applyQuoteFocus(enabled) {document.body.classList.toggle("quote-focus", enabled);focusTransitions.push(enabled);} this.ui={state,combo,openDrawer,closeDrawer,activateQuoteCell};', drawerContext);
vm.runInContext(source.slice(source.indexOf('document.addEventListener("keydown"'), source.indexOf('$("comboButton").addEventListener')), drawerContext);
const drawerUi = drawerContext.ui;
function keyEvent(key, shiftKey = false) {return {key, shiftKey, prevented: false, preventDefault() {this.prevented = true;}};}
check("actual document Esc closes details first, preserves combo/focus mode and returns to rebuilt quote", () => {
  const original = drawerNode("originalQuote"); original.dataset = {symbol: "BTC-TEST-83000-C", column: "mark"};
  drawerCells = [original]; drawerUi.combo.active = true; drawerUi.combo.legs.set("test-leg", {premium: "400"});
  drawerUi.activateQuoteCell(original);
  assert.equal(drawerNode("detailDrawer").hidden, false); assert.equal(drawerNode("detailDrawer").attributes["aria-modal"], "true");
  for (const id of ["header", "chainArea", "comboTray", "focusControls"]) assert.equal(drawerNode(id).inert, true);
  assert.equal(drawerNode("payoffDialog").inert, false); assert.equal(drawerDocument.activeElement, drawerNode("closeDrawer"));
  const rebuilt = drawerNode("rebuiltQuote"); rebuilt.dataset = {...original.dataset}; drawerCells = [rebuilt];
  const first = keyEvent("Escape"); drawerListeners.keydown(first);
  assert.equal(first.prevented, true); assert.equal(drawerNode("detailDrawer").hidden, true); assert.equal(drawerNode("drawerBackdrop").hidden, true);
  assert.equal(drawerModes.has("quote-focus"), true); assert.equal(focusTransitions.length, 0); assert.equal(drawerDocument.activeElement, rebuilt);
  assert.equal(drawerUi.combo.active, true); assert.equal(drawerUi.combo.legs.size, 1);
  for (const id of ["header", "chainArea", "comboTray", "focusControls"]) assert.equal(drawerNode(id).inert, false);
  assert.equal(drawerNode("alreadyInert").inert, true);
  const second = keyEvent("Escape"); drawerListeners.keydown(second);
  assert.equal(second.prevented, true); assert.equal(drawerModes.has("quote-focus"), false); assert.deepEqual(focusTransitions, [false]);
});
check("actual document keydown keeps keyboard focus inside details and yields to native dialogs", () => {
  drawerModes.add("quote-focus"); drawerUi.openDrawer("BTC-TEST-83000-C", drawerNode("rebuiltQuote"));
  drawerDocument.activeElement = drawerNode("detailFavorite");
  const forward = keyEvent("Tab"); drawerListeners.keydown(forward);
  assert.equal(forward.prevented, true); assert.equal(drawerDocument.activeElement, drawerNode("closeDrawer"));
  const backward = keyEvent("Tab", true); drawerListeners.keydown(backward);
  assert.equal(backward.prevented, true); assert.equal(drawerDocument.activeElement, drawerNode("detailFavorite"));
  drawerDocument.activeElement = drawerNode("header"); const outside = keyEvent("Tab"); drawerListeners.keydown(outside);
  assert.equal(outside.prevented, true); assert.equal(drawerDocument.activeElement, drawerNode("closeDrawer"));
  for (const id of ["payoffDialog", "portfolioDialog", "helpDialog"]) {
    drawerNode(id).open = true; const escape = keyEvent("Escape"); drawerListeners.keydown(escape);
    assert.equal(escape.prevented, false); assert.equal(drawerNode("detailDrawer").hidden, false); assert.equal(drawerModes.has("quote-focus"), true);
    drawerNode(id).open = false;
  }
  drawerUi.closeDrawer();
});
check("closing details after a quote disappears returns to a visible focus-mode control", () => {
  drawerModes.add("quote-focus"); drawerUi.openDrawer("BTC-TEST-83000-C", drawerNode("rebuiltQuote")); drawerCells = [];
  drawerUi.closeDrawer(); assert.equal(drawerDocument.activeElement, drawerNode("exitFocus"));
  drawerModes.delete("quote-focus"); drawerUi.openDrawer("BTC-TEST-83000-C", drawerNode("rebuiltQuote"));
  drawerUi.closeDrawer(); assert.equal(drawerDocument.activeElement, drawerNode("focusButton"));
});
check("stale catalog is explicitly marked even with live quotes and fresh statistics, including dated snapshot reference", () => {
  ui.state.streamConnected = true; ui.state.streamLastAt = Date.now(); ui.state.apiError = null;
  ui.state.snapshot = statisticsSnapshot({health: {...healthyCore, ticker: {status: "fresh", rest_refresh_failed: false}, catalog: {status: "stale", last_verified_at: Date.now() - 86400000}}});
  ui.renderConnection();
  assert.match(node("connectionBadge:span").textContent, /报价实时/);
  assert.match(node("noticeBar").textContent, /到期目录缓存.*核验 \d{4}\//);
  assert.match(node("lastUpdate").textContent, /快照 \d{4}\//);
  assert.equal(node("focusStatus").textContent, "目录旧缓存");
  ui.state.snapshot.data_health.catalog.status = "fresh"; ui.renderConnection();
  assert.equal(node("focusStatus").textContent, ""); assert.equal(node("noticeBar").hidden, true);
});
check("live bid ask quotes are independent of stale mark Greeks and the disconnected mark channel", () => {
  ui.state.streamConnected = true; ui.state.streamLastAt = Date.now(); ui.state.apiError = null;
  const health = {...healthyCore, mark: {status: "stale"}, ticker: {status: "fresh", rest_refresh_failed: false}, catalog: {status: "fresh"}};
  ui.state.snapshot = statisticsSnapshot({health});
  ui.state.snapshot.realtime = {connected: false, last_message_at: Date.now(), connection_details: {market: {connected: false}, "book-0": {connected: true}, index: {connected: true}}};
  ui.renderConnection();
  assert.equal(node("connectionBadge:span").textContent, "报价实时");
  assert.match(node("lastUpdate").textContent, /标记价 \/ Greeks：旧缓存.*指数：实时/s);
  assert.match(node("noticeBar").textContent, /标记价 \/ Greeks：旧缓存/);
  assert.match(node("noticeBar").textContent, /标记价通道中断，自动重连中/);
  assert.doesNotMatch(node("noticeBar").textContent, /报价缓存|盘口通道中断/);
  assert.match(node("focusStatus").textContent, /标记 \/ Greeks旧缓存/);
  assert.equal(ui.isLiveSnapshot(ui.state.snapshot), false);
});
check("partial quotes report their actual freshness coverage without claiming all quotes are disconnected", () => {
  ui.state.snapshot.data_health.quote = {status: "partial", fresh_fields: 1398, total_fields: 1400};
  ui.renderConnection();
  assert.equal(node("connectionBadge:span").textContent, "报价部分更新（1398/1400 字段新鲜）");
  assert.match(node("focusStatus").textContent, /1398\/1400 字段新鲜/);
  assert.match(node("noticeBar").textContent, /其余字段保留原数据，不能视为全部实时/);
  assert.doesNotMatch(node("noticeBar").textContent, /报价缓存|盘口通道中断/);
});
check("an index failure warns about the index while leaving live quotes identifiable", () => {
  ui.state.snapshot = statisticsSnapshot({health: {...healthyCore, index: {status: "unavailable"}, ticker: {status: "fresh", rest_refresh_failed: false}, catalog: {status: "fresh"}}, error: {message: "partial failure", failed_endpoints: {index: {}}}});
  ui.state.snapshot.realtime.connection_details = {index: {connected: false}, "book-0": {connected: true}, market: {connected: true}};
  ui.renderConnection();
  assert.equal(node("connectionBadge:span").textContent, "报价实时");
  assert.match(node("lastUpdate").textContent, /指数：暂无数据/);
  assert.match(node("noticeBar").textContent, /指数刷新失败；报价实时/);
  assert.match(node("noticeBar").textContent, /指数通道中断/);
  assert.doesNotMatch(node("noticeBar").textContent, /报价缓存|盘口通道中断/);
  assert.equal(ui.isLiveSnapshot(ui.state.snapshot), false);
});
check("a catalog-only REST failure names the directory and does not downgrade other groups", () => {
  ui.state.snapshot = statisticsSnapshot({health: {...healthyCore, ticker: {status: "fresh", rest_refresh_failed: false}, catalog: {status: "fresh", rest_refresh_failed: true}}, error: {message: "partial failure", failed_endpoints: {exchange_info: {}}}});
  ui.renderConnection();
  assert.equal(node("connectionBadge:span").textContent, "报价实时");
  assert.match(node("noticeBar").textContent, /到期目录刷新失败；报价实时/);
  assert.doesNotMatch(node("noticeBar").textContent, /报价缓存|重连中/);
  assert.match(node("lastUpdate").textContent, /到期目录：已核验 · 刷新失败/);
});
check("genuinely disconnected old quote streams remain visibly cached with named reconnect warnings", () => {
  ui.state.snapshot = statisticsSnapshot({health: {quote: {status: "stale", fresh_fields: 0, total_fields: 1400}, mark: {status: "stale"}, index: {status: "stale"}, ticker: {status: "stale"}}});
  ui.state.snapshot.realtime = {connected: false, connection_details: {"book-0": {connected: false}, market: {connected: false}, index: {connected: false}}};
  ui.renderConnection();
  assert.equal(node("connectionBadge:span").textContent, "报价旧缓存");
  assert.match(node("noticeBar").textContent, /买卖报价已是旧缓存/);
  assert.match(node("noticeBar").textContent, /盘口 \/ 标记价 \/ 指数通道中断，自动重连中/);
  assert.doesNotMatch(node("noticeBar").textContent, /报价实时/);
  ui.state.streamConnected = false; ui.renderConnection();
  assert.match(node("connectionBadge:span").textContent, /本地推送中断/);
  assert.match(node("noticeBar").textContent, /本地实时推送中断/);
});
check("unavailable new snapshots cannot leave retained health visibly live", () => {
  ui.state.streamConnected = true; ui.state.streamLastAt = Date.now(); ui.state.apiError = null;
  ui.state.snapshot = statisticsSnapshot({health: healthyCore});
  ui.acceptSnapshot({options: [], btc_index_price: null, error: {message: "unavailable"}, realtime: {connected: false}});
  assert.match(node("connectionBadge:span").textContent, /最新快照不可用/);
  assert.doesNotMatch(node("noticeBar").textContent, /报价实时/);
  ui.acceptSnapshot(statisticsSnapshot({health: healthyCore})); ui.renderConnection();
  assert.equal(node("connectionBadge:span").textContent, "报价实时");
});
check("late snapshots preserve newer book quantities along with their original receipts", () => {
  const fields = ["bid_price", "ask_price", "bid_quantity", "ask_quantity"];
  const book = (at, bidQuantity, askQuantity) => ({...contract, bid_price: "100", ask_price: "110", bid_quantity: bidQuantity, ask_quantity: askQuantity, quote_source: "rest", quote_updated_at: at, quote_group_valid: true,
    field_updated_at: Object.fromEntries(fields.map(field => [field, at])), field_source: Object.fromEntries(fields.map(field => [field, "rest"]))});
  const previous = {options: [book(epoch + 2000, "0.02", "0.03")]};
  const incoming = {options: [book(epoch, "8", "9")]};
  const before = JSON.stringify({previous, incoming}), merged = ui.mergeFreshSnapshot(previous, incoming).options[0];
  assert.equal(merged.bid_quantity, "0.02"); assert.equal(merged.ask_quantity, "0.03");
  assert.equal(merged.field_updated_at.bid_quantity, epoch + 2000);
  assert.equal(merged.field_updated_at.ask_quantity, epoch + 2000);
  assert.equal(JSON.stringify({previous, incoming}), before);
});
check("merging an independently newer price cannot certify a mixed price and depth frame", () => {
  const fields = ["bid_price", "ask_price", "bid_quantity", "ask_quantity"];
  const base = {...contract, status: "TRADING", unit: "1", min_qty: ".01", max_qty: "100", quantity_scale: 2, bid_price: "100", ask_price: "110", bid_quantity: "1", ask_quantity: "1", quote_source: "rest", quote_group_valid: true,
    field_updated_at: Object.fromEntries(fields.map(field => [field, Date.now()])), field_source: Object.fromEntries(fields.map(field => [field, "rest"]))};
  const previous = {...base, bid_price: "101", field_updated_at: {...base.field_updated_at, bid_price: base.field_updated_at.bid_price + 1}};
  const merged = ui.mergeFreshSnapshot({options: [previous]}, {options: [base]}).options[0];
  assert.equal(merged.bid_price, "101"); assert.equal(merged.bid_quantity, "1");
  assert.equal(merged.quote_group_valid, false);
  assert.equal(riskUI.quoteIssue({btc_index_price: "83000", index_updated_at: Date.now(), index_source: "rest"}, merged, {direction: "SELL", quantity: .01}), "盘口快照待核验");
});
function isolatedSnapshotReceiver() {
  const frames = [], target = vm.createContext({document: {hidden: true, body: {classList: {contains: () => false}}, getElementById: node}, window: {OptionRiskUI: {isVerifiedBook: riskUI.isVerifiedBook}}, localStorage: {getItem: () => null}, Intl, Date, Set, Map, Number, String, Object, JSON, requestAnimationFrame: fn => frames.push(fn)});
  vm.runInContext(definitions + '\nrender = renderMarket = renderExpiries = renderFilters = updateChain = renderOverview = renderDrawer = renderConnection = () => {}; this.receiver = {state, acceptSnapshot, queueSnapshot};', target);
  return {receiver: target.receiver, show: () => {target.document.hidden = false;}, flush: () => {while (frames.length) frames.shift()();}, retired: () => vm.runInContext('retiredSnapshotInstances.size', target)};
}
check("retired server responses cannot restore an old instance or its catalog after restart", () => {
  const {receiver: r} = isolatedSnapshotReceiver();
  const old = {...latestWs, instance_id: "old-process", revision: 2000};
  const fresh = {...slowRest, instance_id: "new-process", revision: 1};
  r.acceptSnapshot(old); r.acceptSnapshot(fresh); r.acceptSnapshot({...old, revision: 2001});
  assert.equal(r.state.snapshot.instance_id, "new-process"); assert.equal(r.state.snapshot.revision, 1);
  assert.equal(r.state.snapshot.options[0].bid_price, "320"); // Fresh fields survive the legitimate restart.
  const empty = {instance_id: "next-process", revision: 10, options: [], btc_index_price: null};
  r.acceptSnapshot(empty); r.acceptSnapshot({...fresh, revision: 2});
  assert.equal(r.state.currentSnapshotUnavailable, true);
  r.acceptSnapshot({...fresh, instance_id: "next-process", revision: 9});
  assert.equal(r.state.currentSnapshotUnavailable, true); // Empty new-instance frames also advance the revision fence.
  r.acceptSnapshot({...fresh, instance_id: "next-process", revision: 11});
  assert.equal(r.state.snapshot.instance_id, "next-process");
});
check("animation-frame batching cannot replace a pending restarted instance with retired callbacks", () => {
  const h = isolatedSnapshotReceiver(), r = h.receiver;
  r.acceptSnapshot({...latestWs, instance_id: "queued-old", revision: 2000}); h.show();
  r.queueSnapshot({...slowRest, instance_id: "queued-new", revision: 5});
  r.queueSnapshot({...latestWs, instance_id: "queued-old", revision: 2001});
  r.acceptSnapshot({...slowRest, instance_id: "queued-new", revision: 4});
  assert.equal(r.state.pendingSnapshot.instance_id, "queued-new"); assert.equal(r.state.pendingSnapshot.revision, 5);
  h.flush(); assert.equal(r.state.snapshot.instance_id, "queued-new"); assert.equal(r.state.snapshot.revision, 5);
  r.queueSnapshot({...slowRest, instance_id: "queued-new", revision: 6});
  r.acceptSnapshot({...slowRest, instance_id: "third-process", revision: 1}); h.flush();
  assert.equal(r.state.snapshot.instance_id, "third-process");
});
check("retired instance history stays bounded while recent retired processes remain rejected", () => {
  const h = isolatedSnapshotReceiver(), r = h.receiver;
  for (let n = 0; n < 30; n++) r.acceptSnapshot({...slowRest, instance_id: `bounded-process-${n}`, revision: 1});
  assert.equal(h.retired(), 16);
  r.acceptSnapshot({...latestWs, instance_id: "bounded-process-28", revision: 99999});
  assert.equal(r.state.snapshot.instance_id, "bounded-process-29");
});
check("an unavailable restarted service cannot keep the prior process book certificate authoritative", () => {
  const {receiver: r} = isolatedSnapshotReceiver(), now = Date.now(), fields = ["bid_price", "ask_price", "bid_quantity", "ask_quantity"];
  const row = {...contract, status: "TRADING", unit: "1", min_qty: ".01", max_qty: "100", bid_price: "100", ask_price: "110", bid_quantity: "2", ask_quantity: "3", quote_group_valid: true,
    quote_updated_at: now - 3600000, quote_source: "websocket", field_updated_at: Object.fromEntries(fields.map(field => [field, now - 3600000])), quote_verified_at: now};
  row.quote_verification = {verified: true, kind: "bookTicker", connection: "book-0", generation: 1, verified_at: now, baseline_at: now - 3600000, values: Object.fromEntries(fields.map(field => [field, row[field]]))};
  r.acceptSnapshot({instance_id: "certified-old", revision: 100, options: [row], btc_index_price: "83000", index_updated_at: now, index_source: "websocket"});
  assert.equal(riskUI.isVerifiedBook(r.state.snapshot.options[0], now), true);
  r.acceptSnapshot({instance_id: "empty-new", revision: 1, options: [], btc_index_price: null});
  const retained = r.state.snapshot.options[0];
  assert.equal(retained.bid_quantity, "2"); assert.equal(retained.bid_price, "100");
  assert.equal(retained.quote_verification, null); assert.equal(retained.quote_verified_at, null);
  assert.equal(retained.quote_group_valid, false);
  assert.equal(riskUI.quoteIssue(r.state.snapshot, retained, {direction: "SELL", quantity: .01}, now), "盘口快照待核验");
});
check("independent retest: unavailable proof revocation preserves the source and accepts a fresh replacement certificate", () => {
  for (const restart of [false, true]) {
    const {receiver: r} = isolatedSnapshotReceiver(), now = Date.now(), fields = ["bid_price", "ask_price", "bid_quantity", "ask_quantity"];
    const row = {...contract, bid_price: "100", ask_price: "110", bid_quantity: "2", ask_quantity: "3", quote_verified_at: now};
    row.quote_verification = {verified: true, kind: "bookTicker", connection: "book-0", generation: 1, verified_at: now, baseline_at: now - 1000, values: Object.fromEntries(fields.map(field => [field, row[field]]))};
    const original = JSON.stringify(row), id = restart ? "proof-restarted" : "proof-original";
    r.acceptSnapshot({instance_id: "proof-original", revision: 10, options: [row], btc_index_price: "83000"});
    r.acceptSnapshot({instance_id: id, revision: 11, options: [], btc_index_price: null});
    assert.equal(riskUI.isVerifiedBook(r.state.snapshot.options[0], now), false); assert.equal(JSON.stringify(row), original);
    const recovered = {...row, bid_price: "101", quote_verification: {...row.quote_verification, generation: 2, values: {...row.quote_verification.values, bid_price: "101"}}};
    r.acceptSnapshot({instance_id: id, revision: 12, options: [recovered], btc_index_price: "83000"});
    assert.equal(riskUI.isVerifiedBook(r.state.snapshot.options[0], now), true); assert.equal(r.state.currentSnapshotUnavailable, false);
  }
});
console.log(`${count} frontend data checks passed.`);
