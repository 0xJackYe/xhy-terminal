"use strict";

const assert = require("node:assert/strict");
const ui = require("./dashboard/dist/risk-ui.js");
const risk = require("./dashboard/dist/risk-metrics.js");
const now = Date.parse("2030-01-01T00:00:00Z");
const defaults = {expiry: "ALL", direction: "SELL", type: "PUT", quantity: .01, annualVol: .6, annualDrift: 0, budget: 1000, sort: "strike"};
function row(overrides = {}) {
  return {symbol: "BTC-300201-70000-P", status: "TRADING", side: "PUT", strike_price: "70000", unit: "1", min_qty: ".01", max_qty: "200", quantity_scale: 2, expiry_ms: now + 31 * 86400000, bid_price: "100", ask_price: "110", bid_quantity: "2", ask_quantity: "2", quote_updated_at: now, quote_source: "websocket", mark_iv: ".99", delta: "-.1", ...overrides};
}
function snapshot(rows = [row()], overrides = {}) {return {options: rows, btc_index_price: "80000", index_updated_at: now, index_source: "websocket", fetched_at: new Date(now).toISOString(), exchange_clock_offset_ms: 0, ...overrides};}
function verifiedQuietRow(overrides = {}, verification = {}) {
  const contract=row({quote_updated_at:now-3600000,...overrides});
  contract.quote_verified_at=now;
  contract.quote_verification={verified:true,kind:"bookTicker",connection:"book-0",generation:1,verified_at:now,baseline_at:now-3600000,values:Object.fromEntries(["bid_price","ask_price","bid_quantity","ask_quantity"].map(field=>[field,contract[field]])),...verification};
  return contract;
}
const evaluate = (source = snapshot(), settings = {}, time = now, analyzer = risk.analyze) => ui.evaluateRows(source, {...defaults, ...settings}, time, analyzer);
let count = 0;
function check(name, fn) {fn(); count++; console.log(`OK ${name}`);}
function csvRecords(text) {return text.replace(/^\uFEFF/, "").split("\r\n").map(line=>[...line.matchAll(/"((?:[^"]|"")*)"/g)].map(match=>match[1].replace(/""/g,'"')));}
function closeTo(actual, expected, message) {assert.ok(Math.abs(actual-expected)<=1e-12*Math.max(1,Math.abs(expected)), `${message}: ${actual} != ${expected}`);}

check("SELL uses executable-side bid and BUY uses ask for both option types", () => {
  for (const type of ["PUT", "CALL"]) for (const direction of ["SELL", "BUY"]) {
    const contract = row({side: type, symbol: `BTC-300201-70000-${type === "PUT" ? "P" : "C"}`});
    const entry = evaluate(snapshot([contract]), {type, direction})[0];
    assert.equal(entry.issue, null); assert.equal(entry.metrics.premiumTotal, (direction === "SELL" ? 100 : 110) * .01);
  }
});
check("every strike uses one common volatility and drift; IV and Delta are descriptive", () => {
  const seen = [];
  evaluate(snapshot([row(), row({symbol: "BTC-300201-75000-P", strike_price: "75000", mark_iv: ".15", delta: "-.8"})]), {annualVol: .4, annualDrift: -.1}, now, (params) => {seen.push(params); return risk.analyze(params);});
  assert.equal(seen.length, 2); assert.ok(seen.every((item) => item.annualVol === .4 && item.annualDrift === -.1));
  assert.ok(seen.every((item) => !Object.hasOwn(item, "mark_iv") && !Object.hasOwn(item, "delta")));
});
check("specific and all expiry/type filters preserve every matching contract", () => {
  const source = snapshot([row(), row({symbol: "BTC-300301-70000-P", expiry_ms: now + 59 * 86400000}), row({side: "CALL", symbol: "BTC-300201-70000-C"})]);
  assert.equal(evaluate(source).length, 2); assert.equal(evaluate(source, {expiry: "2030-02-01"}).length, 1);
  assert.equal(evaluate(source, {type: "ALL"}).length, 3); assert.equal(evaluate(source, {type: "CALL"}).length, 1);
});
check("exchange offset calibrates expiry years but never ages local receipt stamps", () => {
  const entry = evaluate(snapshot([row()], {exchange_clock_offset_ms: 10000}))[0];
  assert.equal(entry.issue, null); assert.equal(entry.metrics.model.years, (31 * 86400000 - 10000) / (365 * 86400000));
});
check("calibrated expiry boundary suppresses a just-expired contract", () => {
  const entry = evaluate(snapshot([row({expiry_ms: now + 9000})], {exchange_clock_offset_ms: 10000}))[0];
  assert.match(entry.issue, /到期/); assert.equal(entry.metrics, null);
});
check("fresh quote/index remain usable when unrelated market refresh failed", () => {
  const entry = evaluate(snapshot(undefined, {stale: true, status: "PARTIAL", error: {message: "ticker failed"}, data_health: {ticker: {status: "stale"}}}))[0];
  assert.equal(entry.issue, null); assert.ok(entry.metrics);
});
check("zero and missing quote never become free premiums", () => {
  for (const bid of [0, "0", null, undefined, "", "NaN"]) {
    const entry = evaluate(snapshot([row({bid_price: bid})]))[0];
    assert.match(entry.issue, /无有效买一报价/); assert.equal(entry.metrics, null);
  }
});
check("crossed bid/ask is rejected", () => {assert.match(evaluate(snapshot([row({bid_price: "111"})]))[0].issue, /交叉/);});
check("websocket freshness expires after twenty seconds", () => {
  assert.equal(evaluate(snapshot(), {}, now + 20000)[0].issue, null);
  assert.match(evaluate(snapshot(), {}, now + 20001)[0].issue, /报价已陈旧/);
});
check("REST uses thirty-second freshness and is labeled cache reference", () => {
  const source = snapshot([row({quote_source: "rest"})], {index_source: "rest"});
  const entry = evaluate(source, {}, now + 30000)[0]; assert.equal(entry.issue, null); assert.equal(entry.sourceLabel, "REST 缓存参考");
  assert.match(evaluate(source, {}, now + 30001)[0].issue, /陈旧/);
});
check("field-specific stale receipt cannot be refreshed by a recent group stamp", () => {
  const entry = evaluate(snapshot([row({field_updated_at: {bid_price: now - 21000}, quote_updated_at: now})]))[0];
  assert.match(entry.issue, /报价已陈旧/);
});
check("explicit unknown field receipt does not fall back to recent group time", () => {
  const entry = evaluate(snapshot([row({field_updated_at: {bid_price: null}, quote_updated_at: now})]))[0];
  assert.match(entry.issue, /报价时间未知/);
});
check("absent or future receipt cannot claim a fresh quote", () => {
  assert.match(evaluate(snapshot([row({quote_updated_at: null})]))[0].issue, /时间未知/);
  assert.match(evaluate(snapshot([row({quote_updated_at: now + 2001})]))[0].issue, /时间异常/);
});
check("depth age is independently checked", () => {
  const entry = evaluate(snapshot([row({field_updated_at: {bid_price: now, bid_quantity: now - 21000}})]))[0];
  assert.match(entry.issue, /深度已陈旧/); assert.equal(entry.metrics, null);
});
check("missing, zero and insufficient depth prevent executable-price simulation", () => {
  for (const depth of [null, 0, .009]) {
    const entry = evaluate(snapshot([row({bid_quantity: depth})]))[0]; assert.match(entry.issue, /深度/); assert.equal(entry.metrics, null);
  }
});
check("fresh quotes do not hide a missing or stale BTC index", () => {
  for (const overrides of [{btc_index_price: null}, {index_updated_at: null}, {index_updated_at: now - 21000}]) {
    const entry = evaluate(snapshot(undefined, overrides))[0]; assert.match(entry.issue, /指数/); assert.equal(entry.metrics, null);
  }
});
check("contract minimum, maximum, precision and unsupported units are checked", () => {
  assert.match(evaluate(snapshot(), {quantity: .005})[0].issue, /数量/);
  assert.match(evaluate(snapshot(), {quantity: 201})[0].issue, /数量/);
  assert.match(evaluate(snapshot(), {quantity: .015})[0].issue, /精度/);
  assert.match(evaluate(snapshot([row({unit: 2})]))[0].issue, /仅支持/);
});
check("invalid model settings fail explicitly before ranking", () => {
  for (const settings of [{quantity: 0}, {quantity: Infinity}, {annualVol: NaN}, {annualVol: null}, {annualDrift: undefined}, {budget: -1}, {direction: "NA"}, {type: "NA"}]) assert.throws(() => evaluate(snapshot(), settings), RangeError);
});
check("over-budget and unlimited call loss are marked without hiding valid metrics", () => {
  const put = evaluate(snapshot(), {budget: 10})[0]; assert.equal(put.overBudget, true); assert.ok(put.metrics);
  const call = evaluate(snapshot([row({side: "CALL"})]), {type: "CALL", budget: 1e10})[0];
  assert.equal(call.metrics.lossUnbounded, true); assert.equal(call.metrics.rewardRiskRatio, null); assert.equal(call.overBudget, true);
});
check("default strike sorting retains invalid contracts but modeled ranks put missing results last", () => {
  const source = snapshot([row({strike_price: 75000, symbol: "BTC-300201-75000-P"}), row({strike_price: 65000, symbol: "BTC-300201-65000-P", bid_price: 0}), row()]);
  assert.deepEqual(evaluate(source).map((item) => +item.row.strike_price), [65000, 70000, 75000]);
  const ranked = evaluate(source, {sort: "expected"}); assert.equal(ranked.at(-1).row.strike_price, 65000); assert.ok(ranked[0].metrics.model.expectedPnl >= ranked[1].metrics.model.expectedPnl);
});
check("CSV includes assumed inputs and explicit units with full numeric precision", () => {
  const entries = evaluate(), text = ui.exportRows(entries, defaults, snapshot());
  assert.ok(text.startsWith("\uFEFF")); assert.match(text, /数量_张/); assert.match(text, /模型最差1%平均亏损_USDT/); assert.match(text, /连续复利年化价格漂移_mu/);
  assert.match(text, /"0\.01"/); assert.match(text, /"0\.6"/); assert.match(text, /快照参考/);
});
check("CSV protects spreadsheet formulas, quotes and multiline labels", () => {
  const source = snapshot(), entry = {...evaluate()[0], row: {...row(), symbol: '=HYPERLINK("bad")\nline', side: " @SUM(1)"}};
  const text = ui.exportRows([entry], defaults, source);
  assert.match(text, /"'=HYPERLINK\(""bad""\)\nline"/); assert.match(text, /"' @SUM\(1\)"/);
});
check("CSV invalid rows retain observed prices but omit uncomputed returns", () => {
  const source = snapshot([row({bid_quantity: 0})]), entries = evaluate(source), text = ui.exportRows(entries, defaults, source);
  assert.equal(entries[0].metrics, null); assert.match(text, /深度不足/); assert.match(text, /"100"/); assert.ok(!text.includes("NaN") && !text.includes("undefined"));
});
check("row evaluation and CSV export never mutate source snapshots", () => {
  const source = snapshot(), before = JSON.stringify(source); ui.exportRows(evaluate(source), defaults, source); assert.equal(JSON.stringify(source), before);
});
check("unknown or suspended contract status is explicit and never modeled", () => {
  for (const status of [null, undefined, "SUSPENDED"]) {const entry = evaluate(snapshot([row({status})]))[0]; assert.match(entry.issue, /状态/); assert.equal(entry.metrics, null);}
});
check("boolean, array and object quote fields are not coerced into numbers", () => {
  for (const bid of [true, false, [], [100], {valueOf: () => 100}]) {const entry = evaluate(snapshot([row({bid_price: bid})]))[0]; assert.match(entry.issue, /报价/); assert.equal(entry.metrics, null);}
});
check("freshness can advance while the chosen valuation time remains frozen", () => {
  const source = snapshot(), first = evaluate(source)[0];
  const later = ui.evaluateRows(source, defaults, now + 5000, risk.analyze, now)[0];
  assert.deepEqual(later.metrics, first.metrics);
  const stale = ui.evaluateRows(source, defaults, now + 20001, risk.analyze, now)[0];
  assert.match(stale.issue, /陈旧/); assert.equal(stale.metrics, null);
});
check("both rising and falling scenario columns export exact net results in all four directions", () => {
  const columns = [["到期下跌20%净盈亏_USDT", -.2], ["到期下跌30%净盈亏_USDT", -.3], ["到期上涨20%净盈亏_USDT", .2], ["到期上涨30%净盈亏_USDT", .3]];
  for (const type of ["PUT", "CALL"]) for (const direction of ["SELL", "BUY"]) {
    const config = {...defaults, type, direction}, source = snapshot([row({side: type})]), entry = evaluate(source, config)[0];
    const [header, record] = ui.exportRows([entry], config, source).replace(/^\uFEFF/, "").split("\r\n").map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1].replace(/""/g, '"')));
    assert.equal(header.length, record.length);
    for (const [name, move] of columns) {
      const index = header.indexOf(name); assert.ok(index >= 0, name);
      assert.equal(Number(record[index]), entry.metrics.scenarios.find((scenario) => Math.abs(scenario.movePct - move) < 1e-8).pnl);
    }
    if (type === "CALL" && direction === "SELL") assert.ok(Number(record[header.indexOf("到期上涨30%净盈亏_USDT")]) < Number(record[header.indexOf("到期上涨20%净盈亏_USDT")]), "short-call upward stress loss grows with price");
  }
});
check("invalid quotes export blank rising and falling scenario results", () => {
  const source = snapshot([row({bid_quantity: 0})]), entries = evaluate(source), csv = ui.exportRows(entries, defaults, source).replace(/^\uFEFF/, "");
  const [header, record] = csv.split("\r\n").map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1]));
  for (const name of ["到期下跌20%净盈亏_USDT", "到期下跌30%净盈亏_USDT", "到期上涨20%净盈亏_USDT", "到期上涨30%净盈亏_USDT"]) assert.equal(record[header.indexOf(name)], "");
});
check("CSV distinguishes calibrated valuation time, individual receipt and old REST collection time", () => {
  const restTime = new Date(now - 3600000).toISOString(), receiptTime = now - 500;
  const source = snapshot([row({quote_updated_at: receiptTime})], {fetched_at: restTime, exchange_clock_offset_ms: 10000});
  const entry = evaluate(source)[0]; assert.equal(entry.issue, null); assert.equal(entry.valuationAt, now + 10000);
  const [header, record] = ui.exportRows([entry], defaults, source).replace(/^\uFEFF/, "").split("\r\n").map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1]));
  assert.equal(record[header.indexOf("报价接收时间")], String(receiptTime));
  assert.equal(record[header.indexOf("快照参考时间")], restTime);
  assert.equal(record[header.indexOf("模型估值时间_UTC")], new Date(now + 10000).toISOString());
  assert.equal(Number(record[header.indexOf("模型剩余年限")]), entry.metrics.model.years);
  assert.deepEqual(header.slice(34, 36), ["模型估值时间_UTC", "模型剩余年限"], "new daily-return fields must preserve existing CSV column positions");
});
check("historical export preserves original calibrated valuation time and original years", () => {
  const source = snapshot(undefined, {exchange_clock_offset_ms: 10000}), first = evaluate(source)[0];
  const entry = ui.evaluateRows(source, defaults, now + 5000, risk.analyze, now)[0];
  entry.currentIssue = "报价已陈旧";
  assert.equal(entry.valuationAt, first.valuationAt); assert.equal(entry.metrics.model.years, first.metrics.model.years);
  const [header, record] = ui.exportRows([entry], defaults, source).replace(/^\uFEFF/, "").split("\r\n").map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1]));
  assert.equal(record[header.indexOf("模型估值时间_UTC")], new Date(first.valuationAt).toISOString());
  assert.equal(Number(record[header.indexOf("模型剩余年限")]), first.metrics.model.years);
  assert.match(record[header.indexOf("状态")], /历史快照/);
});
check("an old quote for a future expiry never claims that the contract traded or expired", () => {
  const source = snapshot(), entry = evaluate(source, {}, now + 21000)[0];
  assert.ok(entry.issue); assert.equal(entry.metrics, null);
  assert.doesNotMatch(entry.issue, /成交|已到期/);
  const csv = ui.exportRows([entry], defaults, source);
  assert.doesNotMatch(csv, /合约已到期|报价已成交/);
  assert.equal(entry.row.expiry_ms, now + 31 * 86400000);
});
check("a missing executable-side bid never substitutes the available ask or mark price", () => {
  const source = snapshot([row({bid_price: "0", ask_price: "777", mark_price: "666"})]);
  const before = JSON.stringify(source), sell = evaluate(source)[0], buy = evaluate(source, {direction: "BUY"})[0];
  assert.ok(sell.issue); assert.equal(sell.metrics, null); assert.doesNotMatch(sell.issue, /已到期|成交/);
  assert.equal(buy.issue, null); assert.ok(Math.abs(buy.metrics.premiumTotal - 7.77) < 1e-12);
  assert.equal(JSON.stringify(source), before, "side selection must not repair the source by inventing prices");
});
check("an aged index is distinguished from a fresh quote and an actually expired contract", () => {
  const indexOld = evaluate(snapshot(undefined, {index_updated_at: now - 21000}))[0];
  assert.match(indexOld.issue, /指数/); assert.doesNotMatch(indexOld.issue, /成交|已到期/); assert.equal(indexOld.metrics, null);
  const expired = evaluate(snapshot([row({expiry_ms: now - 1})]))[0];
  assert.match(expired.issue, /到期/); assert.equal(expired.metrics, null);
});
check("mixed-source CSV retains each entry's original index collection time and valuation horizon", () => {
  const before = snapshot(undefined, {fetched_at: "2029-12-31T23:00:00.000Z"}), first = evaluate(before)[0];
  first.snapshot = before; first.currentIssue = "报价已陈旧";
  const laterTime = now + 21000, after = snapshot([row({symbol: "BTC-300201-75000-P", strike_price: "75000", bid_price: "200", ask_price: "210", quote_updated_at: laterTime})], {btc_index_price: "90000", index_updated_at: laterTime, fetched_at: new Date(laterTime).toISOString()});
  const fresh = evaluate(after, {}, laterTime)[0]; fresh.snapshot = after;
  const [header, ...records] = ui.exportRows([first, fresh], defaults, after).replace(/^\uFEFF/, "").split("\r\n").map(line => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(match => match[1].replace(/""/g, '"')));
  const column = name => {const index=header.indexOf(name);assert.ok(index>=0,name);return index;};
  assert.equal(Number(records[0][column("指数参考_USDT")]), 80000); assert.equal(Number(records[1][column("指数参考_USDT")]), 90000);
  assert.equal(records[0][column("快照参考时间")], before.fetched_at); assert.equal(records[1][column("快照参考时间")], after.fetched_at);
  assert.equal(records[0][column("模型估值时间_UTC")], new Date(now).toISOString()); assert.equal(records[1][column("模型估值时间_UTC")], new Date(laterTime).toISOString());
  assert.equal(Number(records[0][column("模型剩余年限")]), first.metrics.model.years); assert.equal(Number(records[1][column("模型剩余年限")]), fresh.metrics.model.years);
  assert.match(records[0][column("状态")], /历史快照/); assert.doesNotMatch(records[1][column("状态")], /历史快照/);
});
check("verified unchanged book prices remain usable in all four directions without rewriting their old receipts",()=>{
  for(const type of ["CALL","PUT"])for(const direction of ["BUY","SELL"]){
    const contract=verifiedQuietRow({side:type,symbol:`BTC-300201-70000-${type==="CALL"?"C":"P"}`,mark_updated_at:now-3600000});const source=snapshot([contract]),before=JSON.stringify(source),entry=evaluate(source,{type,direction})[0];
    assert.equal(entry.issue,null);assert.ok(entry.metrics);assert.equal(entry.row.quote_updated_at,now-3600000);assert.equal(entry.row.mark_updated_at,now-3600000);assert.equal(JSON.stringify(source),before);
  }
});
check("book proof allows a newer complete baseline than the last heartbeat and enforces the exact time bounds",()=>{
  assert.equal(evaluate(snapshot([verifiedQuietRow({}, {verified_at:now-500,baseline_at:now-100})].map(contract=>({...contract,quote_verified_at:now-500}))))[0].issue,null);
  for(const delta of [-20000,2000]){const contract=verifiedQuietRow({}, {verified_at:now+delta});contract.quote_verified_at=now+delta;assert.equal(evaluate(snapshot([contract]))[0].issue,null);}
  for(const delta of [-20001,2001]){const contract=verifiedQuietRow({}, {verified_at:now+delta});contract.quote_verified_at=now+delta;assert.match(evaluate(snapshot([contract]))[0].issue,/陈旧/);}
});
check("partial forged revoked and mismatched book proofs never bypass stale quote checks",()=>{
  const variants=[
    contract=>{contract.quote_verification=null;},contract=>{contract.quote_verified_at=null;},contract=>{contract.quote_verified_at=String(now);},
    contract=>{contract.quote_verification.verified=false;},contract=>{contract.quote_verification.verified="true";},contract=>{contract.quote_verification.kind="ticker";},
    contract=>{contract.quote_verification.connection="market";},contract=>{contract.quote_verification.connection="book-x";},
    ...[0,-1,1.5,"1",null].map(generation=>contract=>{contract.quote_verification.generation=generation;}),
    contract=>{contract.quote_verification.verified_at=now-1;},contract=>{contract.quote_verification.verified_at=String(now);},
    ...[null,0,undefined,String(now),now+2001].map(baseline=>contract=>{contract.quote_verification.baseline_at=baseline;}),
    contract=>{delete contract.quote_verification.values.bid_price;},contract=>{contract.quote_verification.values.ask_quantity=true;},
    ...["bid_price","ask_price","bid_quantity","ask_quantity"].map(field=>contract=>{contract.quote_verification.values[field]=999;})
  ];
  for(const mutate of variants){const contract=verifiedQuietRow();mutate(contract);const entry=evaluate(snapshot([contract]))[0];assert.match(entry.issue,/陈旧/);assert.equal(entry.metrics,null);}
  const contract=verifiedQuietRow();delete contract.quote_verification;assert.match(evaluate(snapshot([contract],{realtime:{connected:true}}))[0].issue,/陈旧/);
});
check("book certification cannot certify index freshness or repair unknown and future field receipts",()=>{
  for(const index of [{index_updated_at:now-21000},{index_updated_at:null},{btc_index_price:null}]){const entry=evaluate(snapshot([verifiedQuietRow()],index))[0];assert.match(entry.issue,/指数/);assert.equal(entry.metrics,null);}
  for(const receipt of [null,now+2001]){const entry=evaluate(snapshot([verifiedQuietRow({field_updated_at:{bid_price:receipt}})]))[0];assert.match(entry.issue,/时间未知|时间异常/);assert.equal(entry.metrics,null);}
});
check("certified zero prices shallow depth and actual expiry still prohibit calculations",()=>{
  for(const [override,reason]of [[{bid_price:"0"},/买一/],[{bid_quantity:"0.009"},/深度/],[{expiry_ms:now},/到期/]]){const entry=evaluate(snapshot([verifiedQuietRow(override)]))[0];assert.match(entry.issue,reason);assert.equal(entry.metrics,null);}
});
check("CSV preserves original receipt and valuation time for a verified unchanged quote",()=>{
  const source=snapshot([verifiedQuietRow()]),entry=evaluate(source)[0],before=JSON.stringify(source);
  const [header,record]=ui.exportRows([entry],defaults,source).replace(/^\uFEFF/,"").split("\r\n").map(line=>[...line.matchAll(/"((?:[^"]|"")*)"/g)].map(match=>match[1].replace(/""/g,'"')));
  assert.equal(record[header.indexOf("报价接收时间")],String(now-3600000));assert.equal(record[header.indexOf("模型估值时间_UTC")],new Date(now).toISOString());assert.notEqual(record[header.indexOf("最大净盈利_USDT")],"");assert.doesNotMatch(record[header.indexOf("状态")],/历史快照/);assert.equal(JSON.stringify(source),before);
});
check("daily SELL PUT return uses net income and exact remaining days rather than expected PnL or margin",()=>{
  const source=snapshot([row({strike_price:100,bid_price:10.024,ask_price:11,expiry_ms:now+10*86400000})],{btc_index_price:100});
  const entry=evaluate(source,{quantity:1})[0],m=entry.metrics;
  assert.equal(entry.issue,null);assert.equal(m.remainingDays,10);assert.equal(m.dailyReturnBasis,"cash_secured");
  closeTo(m.averageDailyMaxProfit,1,"10 net USDT over 10 days is 1 USDT per day");
  closeTo(m.averageDailyReturnPct,1,"1 daily USDT on 100 USDT cash collateral is 1 percent");
  assert.notEqual(m.averageDailyMaxProfit,m.model.expectedPnl/m.remainingDays,"maximum income is not modeled expected income");
});
check("daily rate can compare different expiries and ranks unavailable capital bases last",()=>{
  const source=snapshot([
    row({symbol:"BTC-300201-65000-P",strike_price:65000,bid_price:0}),
    row({symbol:"BTC-300201-70000-C",side:"CALL"}),
    row({symbol:"BTC-300301-70000-P",expiry_ms:now+59*86400000}),
    row(),
    row({symbol:"BTC-300201-75000-P",strike_price:75000,bid_price:200,ask_price:210})
  ]);
  const ranked=evaluate(source,{sort:"dailyReturn",type:"ALL"});
  assert.deepEqual(ranked.slice(0,3).map(entry=>entry.row.symbol),["BTC-300201-75000-P","BTC-300201-70000-P","BTC-300301-70000-P"]);
  assert.ok(ranked.slice(0,3).every((entry,index,list)=>index===0||entry.metrics.averageDailyReturnPct<=list[index-1].metrics.averageDailyReturnPct));
  assert.ok(ranked.slice(-2).every(entry=>entry.metrics?.averageDailyReturnPct==null));
  assert.equal(ranked.at(-1).row.symbol,"BTC-300201-70000-C","missing values retain deterministic strike tie breakers");
});
check("sub-day remaining time is not rounded up to one whole day",()=>{
  const entry=evaluate(snapshot([row({expiry_ms:now+6*3600000})]))[0],m=entry.metrics;
  assert.equal(entry.issue,null);closeTo(m.remainingDays,.25,"six hours");
  closeTo(m.averageDailyMaxProfit,m.maxProfit*4,"daily amount uses fractional days");
  closeTo(m.averageDailyReturnPct,m.cashReturnPct*4,"daily rate uses fractional days");
});
check("daily income scales with contract quantity while the capital-normalized percentage stays constant",()=>{
  const first=evaluate()[0].metrics,second=evaluate(snapshot(),{quantity:.02})[0].metrics;
  closeTo(second.averageDailyMaxProfit,first.averageDailyMaxProfit*2,"quantity doubles daily amount");
  closeTo(second.averageDailyReturnPct,first.averageDailyReturnPct,"quantity cannot double percentage return");
});
check("BUY PUT daily rate uses paid premium and entry fee while naked SELL CALL has no capital denominator",()=>{
  const bought=evaluate(snapshot(),{direction:"BUY"})[0].metrics;
  assert.equal(bought.dailyReturnBasis,"premium_paid");
  closeTo(bought.averageDailyReturnPct,bought.maxProfit/(bought.premiumTotal+bought.entryFee+bought.additionalFees)*100/bought.remainingDays,"long PUT premium-cost denominator");
  const soldCall=evaluate(snapshot([row({side:"CALL"})]),{type:"CALL"})[0].metrics;
  assert.ok(soldCall.averageDailyMaxProfit>0);assert.equal(soldCall.averageDailyReturnPct,null);assert.equal(soldCall.dailyReturnBasis,null);
  const boughtCall=evaluate(snapshot([row({side:"CALL"})]),{type:"CALL",direction:"BUY"})[0].metrics;
  assert.equal(boughtCall.profitUnbounded,true);assert.equal(boughtCall.averageDailyMaxProfit,null);assert.equal(boughtCall.averageDailyReturnPct,null);assert.equal(boughtCall.dailyReturnBasis,"premium_paid");
});
check("live calibrated valuation advances daily returns but explicit fixed valuation preserves their original horizon",()=>{
  const source=snapshot(undefined,{exchange_clock_offset_ms:10000}),first=evaluate(source)[0].metrics;
  const live=evaluate(source,{},now+5000)[0].metrics;
  closeTo(first.remainingDays,31-10000/86400000,"calibrated remaining days");
  closeTo(live.remainingDays,first.remainingDays-5000/86400000,"elapsed local time");
  assert.ok(live.averageDailyMaxProfit>first.averageDailyMaxProfit);assert.ok(live.averageDailyReturnPct>first.averageDailyReturnPct);
  const fixed=ui.evaluateRows(source,defaults,now+5000,risk.analyze,now)[0].metrics;
  assert.equal(fixed.remainingDays,first.remainingDays);assert.equal(fixed.averageDailyMaxProfit,first.averageDailyMaxProfit);assert.equal(fixed.averageDailyReturnPct,first.averageDailyReturnPct);
});
check("CSV appends daily fields without changing original columns and exports exact numeric values for all directions",()=>{
  const names=["剩余天数","最高平均日收益_USDT","最高平均日收益率_百分比","日收益率资金口径"];
  for(const type of ["PUT","CALL"])for(const direction of ["BUY","SELL"]){
    const settings={...defaults,type,direction},source=snapshot([row({side:type})]),entry=evaluate(source,settings)[0],m=entry.metrics;
    const [header,record]=csvRecords(ui.exportRows([entry],settings,source));
    assert.equal(header.length,record.length);assert.equal(header.length,40);assert.deepEqual(header.slice(-4),names);
    assert.equal(Number(record[36]),m.remainingDays);
    assert.equal(record[37],m.averageDailyMaxProfit===null?"":String(m.averageDailyMaxProfit));
    assert.equal(record[38],m.averageDailyReturnPct===null?"":String(m.averageDailyReturnPct));
    assert.equal(record[39],m.dailyReturnBasis??"");
  }
});
check("CSV invalid or expired rows keep daily fields blank and never claim zero daily income",()=>{
  for(const overrides of [{bid_quantity:0},{expiry_ms:now}]){
    const source=snapshot([row(overrides)]),entry=evaluate(source)[0];assert.equal(entry.metrics,null);
    const [header,record]=csvRecords(ui.exportRows([entry],defaults,source));
    for(const name of ["剩余天数","最高平均日收益_USDT","最高平均日收益率_百分比","日收益率资金口径"])assert.equal(record[header.indexOf(name)],"");
  }
});
check("historical daily CSV preserves each leg's original time instead of using export time",()=>{
  const source=snapshot(),first=evaluate(source)[0],entry=ui.evaluateRows(source,defaults,now+5000,risk.analyze,now)[0];
  entry.currentIssue="报价已陈旧";entry.historical=true;
  const [header,record]=csvRecords(ui.exportRows([entry],defaults,source));
  assert.equal(Number(record[header.indexOf("剩余天数")]),first.metrics.remainingDays);
  assert.equal(Number(record[header.indexOf("最高平均日收益_USDT")]),first.metrics.averageDailyMaxProfit);
  assert.equal(Number(record[header.indexOf("最高平均日收益率_百分比")]),first.metrics.averageDailyReturnPct);
  assert.match(record[header.indexOf("状态")],/历史快照/);
});
console.log(`${count} risk comparison checks passed`);
