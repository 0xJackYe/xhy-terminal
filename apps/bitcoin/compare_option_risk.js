#!/usr/bin/env node
"use strict";

// Read the existing public cache and use exactly the dashboard's calculation.
// No exchange credentials, OpenAI credentials, account endpoints or order calls.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

function parseArgs(argv) {
  const config = {expiry: "ALL", type: "PUT", direction: "SELL", quantity: .01,
    annualVol: .6, annualDrift: 0, budget: 1000, sort: "strike", input: null, output: null};
  const names = {"--expiry":"expiry","--type":"type","--direction":"direction","--quantity":"quantity",
    "--vol":"annualVol","--drift":"annualDrift","--budget":"budget","--sort":"sort","--input":"input","--output":"output"};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return {help: true};
    if (!names[arg] || i+1 >= argv.length || argv[i+1].startsWith("--")) throw new Error("未知参数或缺少参数值："+arg);
    config[names[arg]] = argv[++i];
  }
  for (const key of ["quantity", "annualVol", "annualDrift", "budget"]) {
    if (typeof config[key] === "string" && !config[key].trim()) throw new Error("数值参数不能为空。");
    config[key] = Number(config[key]);
    if (!Number.isFinite(config[key])) throw new Error("数值参数须为有限数字。");
  }
  if (config.quantity <= 0 || config.annualVol < 0 || config.budget < 0) throw new Error("数量须大于零，年化波动率和预算须非负。");
  if (!["CALL", "PUT", "ALL"].includes(config.type)) throw new Error("--type 使用 CALL、PUT 或 ALL。");
  if (!["BUY", "SELL"].includes(config.direction)) throw new Error("--direction 使用 BUY 或 SELL。");
  if (config.expiry !== "ALL" && !/^\d{4}-\d{2}-\d{2}$/.test(config.expiry)) throw new Error("--expiry 使用 YYYY-MM-DD 或 ALL。");
  if (config.expiry !== "ALL") {
    const parsed = new Date(config.expiry+"T00:00:00Z");
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== config.expiry) throw new Error("到期日不是有效日历日期。");
  }
  if (!["strike", "expected", "lossProbability", "tail", "rewardRisk", "dailyReturn", "maxLoss"].includes(config.sort)) throw new Error("未知排序字段。");
  if (config.output && !/\.(csv|json)$/i.test(config.output)) throw new Error("--output 只支持 .csv 或 .json。");
  return config;
}

function readPublicSnapshot() {
  return new Promise((resolve, reject) => {
    const request = http.get("http://127.0.0.1:8766/api/market", response => {
      if (response.statusCode !== 200) {response.resume(); reject(new Error("本机行情接口 HTTP "+response.statusCode)); return;}
      let count = 0;
      const pieces = [];
      response.on("data", piece => {
        count += piece.length;
        if (count > 16*1024*1024) request.destroy(new Error("行情响应超过上限。"));
        else pieces.push(piece);
      });
      response.on("end", () => {
        try {resolve(JSON.parse(Buffer.concat(pieces).toString("utf8")));}
        catch (_) {reject(new Error("本机行情响应不是有效 JSON。"));}
      });
      response.on("error", reject);
    });
    request.setTimeout(10000, () => request.destroy(new Error("本机行情接口超时。")));
    request.on("error", reject);
  });
}

async function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv);
  if (config.help) {
    console.log("本地期权收益风险比较（不访问账户、不下单）\n"+
      "node compare_option_risk.js --expiry 2026-10-30 --type PUT --direction SELL --quantity 0.01 --vol 0.6 --drift 0 --budget 1000 --output comparison.csv\n"+
      "--expiry ALL 可比较全部到期日；--type ALL/CALL/PUT；--direction BUY/SELL。\n"+
      "--vol/--drift 为年化小数，如0.6表示60%；--sort dailyReturn 按最高平均日收益率从高到低排列。\n"+
      "--input snapshot.json 以原始快照时间计算历史资料（不是实时行情）。");
    return 0;
  }
  const snapshot = config.input ? JSON.parse(fs.readFileSync(path.resolve(config.input), "utf8")) : await readPublicSnapshot();
  if (!snapshot || !Array.isArray(snapshot.options)) throw new Error("快照缺少期权列表。");
  const Risk = require("./dashboard/dist/risk-metrics.js");
  const UI = require("./dashboard/dist/risk-ui.js");
  if (config.input && Object.hasOwn(snapshot, "exchange_clock_offset_ms") && (typeof snapshot.exchange_clock_offset_ms !== "number" || !Number.isFinite(snapshot.exchange_clock_offset_ms))) {
    throw new Error("历史快照的 exchange_clock_offset_ms 须为有效数值。");
  }
  const offset = typeof snapshot.exchange_clock_offset_ms === "number" && Number.isFinite(snapshot.exchange_clock_offset_ms) ? snapshot.exchange_clock_offset_ms : 0;
  if (config.input && (typeof snapshot.server_now_ms !== "number" || !Number.isFinite(snapshot.server_now_ms) || snapshot.server_now_ms <= 0 || !Number.isFinite(new Date(snapshot.server_now_ms).getTime()))) {
    throw new Error("历史快照须有有效的 server_now_ms 数值，以明确原始估值时刻。");
  }
  const now = config.input ? snapshot.server_now_ms-offset : Date.now();
  const entries = UI.evaluateRows(snapshot, config, now, Risk.analyze);
  const report = {
    source: config.input ? "Historical snapshot; not live" : "Local public market cache",
    valuation_time_utc: new Date(now+offset).toISOString(),
    as_of_beijing: new Intl.DateTimeFormat("sv-SE", {timeZone:"Asia/Shanghai",dateStyle:"short",timeStyle:"medium"}).format(new Date(now+offset)),
    settings: config, count: entries.length,
    unavailable: entries.filter(entry => !entry.metrics).length,
    convention: "Reward/risk = maximum net profit / maximum net loss; unbounded cases are not ranked as finite ratios. Daily maxima use exact remaining days and simple averaging, not guaranteed income. Daily return capital is strike times quantity times unit for SELL PUT, premium plus entry/additional fees for BUY PUT; SELL CALL has no capital basis and BUY CALL has unbounded profit. Model EV and probabilities are conditional GBM assumptions, not forecasts.",
    options: entries.map(entry => ({symbol:entry.row.symbol,side:entry.row.side,expiry:entry.expiry,
      strike:entry.row.strike_price,bid:entry.row.bid_price,ask:entry.row.ask_price,iv:entry.row.mark_iv,
      delta:entry.row.delta,gamma:entry.row.gamma,theta:entry.row.theta,vega:entry.row.vega,
      issue:entry.issue,overBudget:entry.overBudget,quoteLabel:entry.quoteLabel,sourceLabel:entry.sourceLabel,metrics:entry.metrics}))
  };
  if (config.output) {
    const destination = path.resolve(config.output);
    const output = /\.csv$/i.test(destination) ? UI.exportRows(entries, config, snapshot) : JSON.stringify(report, null, 2)+"\n";
    fs.writeFileSync(destination, output, "utf8");
    console.log("已计算 "+report.count+" 个合约；不可用 "+report.unavailable+" 个。\n输出："+destination);
  } else console.log(JSON.stringify(report, null, 2));
  return 0;
}

if (require.main === module) main().then(code => {process.exitCode=code;}).catch(error => {
  console.error("计算失败："+(error.message || "未知错误"));
  process.exitCode = 1;
});
module.exports = {parseArgs, readPublicSnapshot, main};
