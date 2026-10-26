"use strict";

// Execute the actual CLI with a local historical fixture; no server or network.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const Risk = require("./dashboard/dist/risk-metrics.js");
const UI = require("./dashboard/dist/risk-ui.js");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "btc-risk-cli-test-"));
const input = path.join(directory, "historical.json");
const exchangeTime = Date.parse("2020-01-01T01:00:00.000Z"), offset = 12000;
const localTime = exchangeTime - offset;
const received = new Date(localTime - 1000).toISOString();
const expiry = Date.parse("2020-02-01T08:00:00.000Z");
const base = {status: "TRADING", unit: 1, quote_asset: "USDT", min_qty: .01,
  max_qty: 100, quantity_scale: 2, expiry_ms: expiry,
  bid_price: 500, ask_price: 550, bid_quantity: 1, ask_quantity: 1,
  quote_updated_at: received, quote_source: "websocket", mark_iv: .6,
  delta: -.4, gamma: .00001, theta: -4, vega: 8};
const snapshot = {server_now_ms: exchangeTime, exchange_clock_offset_ms: offset,
  // REST collection may be older than the current WS data and valuation time.
  fetched_at: new Date(localTime - 300000).toISOString(), btc_index_price: 10000,
  index_updated_at: received, index_source: "websocket", options: [
    {...base, symbol: "BTC-200201-10000-C", side: "CALL", strike_price: 10000, delta: .5},
    {...base, symbol: "BTC-200201-10000-P", side: "PUT", strike_price: 10000},
    {...base, symbol: "BTC-200201-11000-P", side: "PUT", strike_price: 11000, bid_price: null, ask_price: null},
    {...base, symbol: "BTC-200201-12000-C", side: "CALL", strike_price: 12000,
      quote_updated_at: new Date(localTime - 21000).toISOString()}
  ]};
fs.writeFileSync(input, JSON.stringify(snapshot), "utf8");
let checks = 0;
function test(name, run) {run(); checks++; console.log(`OK CLI: ${name}`);}
function invoke(args = []) {
  return spawnSync(process.execPath, [path.join(__dirname, "compare_option_risk.js"), "--input", input, ...args],
    {cwd: directory, encoding: "utf8", timeout: 10000, windowsHide: true});
}
function report(args = []) {
  const result = invoke(args);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}
function parseCsv(text) {
  return text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean).map(line =>
    line.slice(1, -1).split('","').map(value => value.replace(/""/g, '"')));
}

try {
  test("historical snapshot uses original exchange time and retains its historical label", () => {
    const result = report(["--type", "ALL"]);
    assert.equal(result.source, "Historical snapshot; not live");
    assert.equal(result.valuation_time_utc, "2020-01-01T01:00:00.000Z");
    assert.equal(result.as_of_beijing, "2020-01-01 09:00:00");
    assert.equal(result.count, 4);
    assert.equal(result.unavailable, 2);
    assert.ok(result.options.find(row => row.symbol.endsWith("10000-P")).metrics);
  });
  for (const direction of ["BUY", "SELL"]) {
    test(`${direction} uses executable side and exactly the shared UI/engine results`, () => {
      const result = report(["--direction", direction, "--type", "ALL", "--vol", ".7", "--drift", ".1"]);
      const settings = {...result.settings};
      const expected = UI.evaluateRows(snapshot, settings, localTime, Risk.analyze);
      for (const item of result.options) {
        const matching = expected.find(entry => entry.row.symbol === item.symbol);
        assert.ok(matching);
        assert.deepEqual(item.metrics, matching.metrics);
        assert.equal(item.issue, matching.issue);
        assert.equal(item.quoteLabel, direction === "SELL" ? "买一" : "卖一");
      }
      const put = result.options.find(row => row.symbol.endsWith("10000-P"));
      const call = result.options.find(row => row.symbol.endsWith("10000-C"));
      assert.equal(put.metrics.profitUnbounded, false);
      assert.equal(put.metrics.lossUnbounded, false);
      assert.equal(typeof put.metrics.rewardRiskRatio, "number");
      assert.equal(call.metrics.rewardRiskRatio, null);
      assert.equal(call.metrics[direction === "BUY" ? "maxProfit" : "maxLoss"], null);
      assert.equal(call.metrics[direction === "BUY" ? "profitUnbounded" : "lossUnbounded"], true);
      assert.equal(put.metrics.premiumTotal, (direction === "BUY" ? 550 : 500) * .01);
    });
  }
  test("missing quote and stale quote stay unavailable without a fabricated zero metric", () => {
    const result = report(["--type", "ALL"]);
    const unknown = result.options.find(row => row.symbol.endsWith("11000-P"));
    const stale = result.options.find(row => row.symbol.endsWith("12000-C"));
    assert.equal(unknown.bid, null);
    assert.equal(unknown.metrics, null);
    assert.match(unknown.issue, /无有效买一报价/);
    assert.equal(stale.metrics, null);
    assert.match(stale.issue, /已陈旧/);
  });
  test("CSV emits one UTF-8 BOM, matches displayed calculations, and records historical timestamps", () => {
    const output = path.join(directory, "比较结果.csv");
    const result = invoke(["--type", "ALL", "--output", output]);
    assert.equal(result.status, 0, result.stderr);
    const bytes = fs.readFileSync(output), text = bytes.toString("utf8");
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal((text.match(/\uFEFF/g) || []).length, 1);
    const [header, ...rows] = parseCsv(text);
    assert.equal(rows.length, 4);
    assert.ok(rows.every(row => row.length === header.length));
    const field = (row, name) => row[header.indexOf(name)];
    const put = rows.find(row => field(row, "合约").endsWith("10000-P"));
    const sameJson = report(["--type", "ALL"]).options.find(row => row.symbol.endsWith("10000-P"));
    assert.equal(Number(field(put, "模型期望净盈亏_USDT")), sameJson.metrics.model.expectedPnl);
    assert.equal(field(put, "报价接收时间"), received);
    assert.equal(field(put, "快照参考时间"), snapshot.fetched_at);
    assert.equal(field(put, "模型估值时间_UTC"), new Date(exchangeTime).toISOString());
    assert.notEqual(field(put, "模型估值时间_UTC"), field(put, "快照参考时间"));
    assert.equal(Number(field(put, "模型剩余年限")), (expiry - exchangeTime) / (365 * 86400000));
    assert.equal(Number(field(put, "模型剩余年限")), sameJson.metrics.model.years);
    const unknown = rows.find(row => field(row, "合约").endsWith("11000-P"));
    assert.equal(field(unknown, "模型期望净盈亏_USDT"), "");
    assert.match(field(unknown, "状态"), /无有效买一报价/);
    const call = rows.find(row => field(row, "合约").endsWith("10000-C"));
    assert.equal(field(call, "最大净亏损_USDT"), "无限");
    assert.equal(field(call, "最大盈利除最大亏损"), "");
  });
  test("JSON file output preserves null unbounded values without Infinity or extra BOM", () => {
    const output = path.join(directory, "report.json");
    const result = invoke(["--direction", "BUY", "--type", "CALL", "--output", output]);
    assert.equal(result.status, 0, result.stderr);
    const text = fs.readFileSync(output, "utf8");
    assert.notEqual(text.charCodeAt(0), 0xfeff);
    const data = JSON.parse(text);
    assert.equal(data.options[0].metrics.maxProfit, null);
    assert.equal(data.options[0].metrics.profitUnbounded, true);
  });
  test("invalid finite/range/date arguments fail before writing a misleading report", () => {
    const output = path.join(directory, "should-not-exist.csv");
    for (const args of [["--quantity", "0"], ["--vol", "NaN"], ["--vol", "6"],
      ["--drift", "-6"], ["--budget", "-1"], ["--expiry", "2020-02-30"]]) {
      const result = invoke([...args, "--output", output]);
      assert.equal(result.status, 1, `${args}: ${result.stdout}`);
      assert.match(result.stderr, /计算失败/);
      assert.equal(fs.existsSync(output), false);
    }
  });
  test("missing or invalid historical valuation time cannot silently become today's valuation", () => {
    const invalidFile = path.join(directory, "invalid-time.json");
    const output = path.join(directory, "invalid-time-report.json");
    for (const value of [undefined, null, "2020-01-01T01:00:00Z", 0, -1, 1e20]) {
      const changed = {...snapshot};
      if (value === undefined) delete changed.server_now_ms;
      else changed.server_now_ms = value;
      fs.writeFileSync(invalidFile, JSON.stringify(changed), "utf8");
      const result = invoke(["--input", invalidFile, "--output", output]);
      assert.equal(result.status, 1, `${String(value)} unexpectedly produced ${result.stdout}`);
      assert.match(result.stderr, /计算失败/);
      assert.equal(fs.existsSync(output), false);
    }
  });
  test("historical clock offset rejects nonnumeric values rather than applying two incompatible offsets", () => {
    const invalidFile = path.join(directory, "invalid-offset.json");
    const output = path.join(directory, "invalid-offset-report.csv");
    for (const value of ["12000", true, null]) {
      fs.writeFileSync(invalidFile, JSON.stringify({...snapshot, exchange_clock_offset_ms: value}), "utf8");
      const result = invoke(["--input", invalidFile, "--output", output]);
      assert.equal(result.status, 1, `${String(value)} unexpectedly produced ${result.stdout}`);
      assert.match(result.stderr, /计算失败/);
      assert.equal(fs.existsSync(output), false);
    }
  });
  test("daily returns use the historical expiry horizon and net premium rather than today's date", () => {
    const result=report(),put=result.options.find(row=>row.symbol.endsWith("10000-P")),m=put.metrics;
    const days=(expiry-exchangeTime)/86400000;
    assert.equal(m.remainingDays,days);assert.equal(m.dailyReturnBasis,"cash_secured");
    assert.ok(Math.abs(m.averageDailyMaxProfit-(m.premiumTotal-m.entryFee)/days)<1e-12);
    assert.ok(Math.abs(m.averageDailyReturnPct-(m.premiumTotal-m.entryFee)/(10000*.01)*100/days)<1e-12);
    assert.ok(m.averageDailyMaxProfit>0&&m.averageDailyReturnPct>0);
    const repeat=report().options.find(row=>row.symbol===put.symbol).metrics;
    assert.equal(repeat.remainingDays,m.remainingDays);assert.equal(repeat.averageDailyMaxProfit,m.averageDailyMaxProfit);assert.equal(repeat.averageDailyReturnPct,m.averageDailyReturnPct);
  });
  test("daily-return CLI sorting ranks valid finite rates ahead of unsupported and missing rows", () => {
    const result=report(["--type","ALL","--sort","dailyReturn"]);
    assert.equal(result.settings.sort,"dailyReturn");assert.equal(result.options[0].symbol,"BTC-200201-10000-P");
    assert.ok(result.options.slice(1).every(item=>item.metrics?.averageDailyReturnPct==null));
    const call=result.options.find(row=>row.symbol.endsWith("10000-C"));
    assert.ok(call.metrics.averageDailyMaxProfit>0);assert.equal(call.metrics.dailyReturnBasis,null);assert.equal(call.metrics.averageDailyReturnPct,null);
    const longCall=report(["--type","CALL","--direction","BUY","--sort","dailyReturn"]).options.find(row=>row.symbol.endsWith("10000-C"));
    assert.equal(longCall.metrics.dailyReturnBasis,"premium_paid");assert.equal(longCall.metrics.averageDailyMaxProfit,null);assert.equal(longCall.metrics.averageDailyReturnPct,null);
  });
  test("CSV daily-return fields preserve original columns and match JSON across both trade directions", () => {
    for(const direction of ["BUY","SELL"]){
      const output=path.join(directory,`daily-${direction}.csv`),result=invoke(["--type","ALL","--direction",direction,"--output",output]);
      assert.equal(result.status,0,result.stderr);const [header,...rows]=parseCsv(fs.readFileSync(output,"utf8"));
      assert.deepEqual(header.slice(-4),["剩余天数","最高平均日收益_USDT","最高平均日收益率_百分比","日收益率资金口径"]);
      assert.equal(header[34],"模型估值时间_UTC");assert.equal(header[35],"模型剩余年限");assert.ok(rows.every(row=>row.length===40));
      const json=report(["--type","ALL","--direction",direction]);
      for(const record of rows){
        const item=json.options.find(item=>item.symbol===record[0]),m=item.metrics;
        assert.equal(record[36],m?String(m.remainingDays):"");
        assert.equal(record[37],m?.averageDailyMaxProfit==null?"":String(m.averageDailyMaxProfit));
        assert.equal(record[38],m?.averageDailyReturnPct==null?"":String(m.averageDailyReturnPct));
        assert.equal(record[39],m?.dailyReturnBasis??"");
      }
    }
  });
  console.log(`${checks} CLI risk tests passed`);
} finally {
  // Only this test's mkdtemp directory is removed, using the same native API.
  const resolved = fs.realpathSync(directory), tempRoot = fs.realpathSync(os.tmpdir());
  assert.ok(path.basename(resolved).startsWith("btc-risk-cli-test-") && path.dirname(resolved) === tempRoot);
  fs.rmSync(resolved, {recursive: true, force: true});
}
