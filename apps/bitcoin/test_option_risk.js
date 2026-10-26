"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const Risk = require("./dashboard/dist/risk-metrics.js");
let checks = 0;
function test(name, run) { try { run(); checks++; } catch (error) { error.message = name + ": " + error.message; throw error; } }
function close(actual, expected, tolerance = 1e-10) { assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`); }
function analyze(overrides = {}) {
  return Risk.analyze(Object.assign({type:"PUT", direction:"SELL", strike:100, premium:10, spot:100, years:1, annualVol:.2, feeEntryRate:0, feeExerciseRate:0}, overrides));
}
function scenario(result, change) { return result.scenarios.find(row => row.movePct === change).pnl; }

test("sell Put capped reward and full cash downside", () => {
  const r = analyze(); assert.equal(r.maxProfit, 10); assert.equal(r.maxLoss, 90);
  close(r.rewardRiskRatio, 1/9); assert.equal(r.breakEven, 90); assert.equal(r.cashReturnPct, 10);
  assert.equal(scenario(r, -.3), -20); assert.equal(scenario(r, .3), 10);
});
test("buy Put finite reward-risk uses debit", () => {
  const r=analyze({direction:"BUY"}); assert.equal(r.maxProfit,90); assert.equal(r.maxLoss,10);
  assert.equal(r.rewardRiskRatio,9); assert.equal(r.cashReturnPct,null); assert.equal(scenario(r,-.2),10);
});
test("buy Call has unbounded profit without invented numeric ratio", () => {
  const r=analyze({type:"CALL", direction:"BUY"}); assert.equal(r.profitUnbounded,true);
  assert.equal(r.maxProfit,null); assert.equal(r.maxLoss,10); assert.equal(r.rewardRiskRatio,null); assert.equal(r.breakEven,110);
});
test("sell Call explicitly exposes unbounded risk", () => {
  const r=analyze({type:"CALL"}); assert.equal(r.lossUnbounded,true); assert.equal(r.maxLoss,null);
  assert.equal(r.maxProfit,10); assert.equal(r.rewardRiskRatio,null); close(scenario(r,.2),-10);
});
test("ten dollars over ten days is one dollar and one cash-covered percent per day", () => {
  const r=analyze({years:10/365});
  close(r.remainingDays,10); close(r.averageDailyMaxProfit,1); close(r.averageDailyReturnPct,1);
  assert.equal(r.dailyReturnBasis,"cash_secured"); close(r.averageDailyReturnPct,r.cashReturnPct/10);
});
test("short Put daily returns deduct entry and additional fees before averaging", () => {
  const r=analyze({years:10/365,feeEntryRate:.01,additionalFees:2});
  // Receive 10, pay 1 entry fee and 2 total extra fees; set aside strike 100.
  close(r.averageDailyMaxProfit,.7); close(r.averageDailyReturnPct,.7);
  close(r.averageDailyReturnPct,r.cashReturnPct/r.remainingDays);
});
test("long Put daily percentage uses the complete premium and fee outlay", () => {
  const r=analyze({direction:"BUY",years:10/365,feeEntryRate:.01,additionalFees:2});
  // Best expiry payoff is 100 - 10 - 1 - 2 = 87 on an outlay of 13.
  close(r.averageDailyMaxProfit,8.7); close(r.averageDailyReturnPct,87/13/10*100);
  assert.equal(r.dailyReturnBasis,"premium_paid");
});
test("daily averages retain fractional days instead of rounding up to one day", () => {
  const r=analyze({years:.5/365});
  close(r.remainingDays,.5); close(r.averageDailyMaxProfit,20); close(r.averageDailyReturnPct,20);
});
test("contract quantities scale daily money while cash-covered daily percentages stay equal", () => {
  const a=analyze({years:10/365}), b=analyze({years:10/365,quantity:3,unit:.01});
  close(b.averageDailyMaxProfit,a.averageDailyMaxProfit*.03);
  close(b.averageDailyReturnPct,a.averageDailyReturnPct); close(b.remainingDays,a.remainingDays);
});
test("long Put contract quantities scale daily money but preserve the premium-based percentage", () => {
  const a=analyze({direction:"BUY",years:10/365,feeEntryRate:.01,additionalFees:2});
  const b=analyze({direction:"BUY",years:10/365,feeEntryRate:.01,quantity:3,unit:.5,additionalFees:3});
  close(b.averageDailyMaxProfit,a.averageDailyMaxProfit*1.5);
  close(b.averageDailyReturnPct,a.averageDailyReturnPct);
});
test("short Call daily money does not invent a margin or covered-capital percentage", () => {
  const r=analyze({type:"CALL",years:10/365});
  close(r.averageDailyMaxProfit,1); assert.equal(r.averageDailyReturnPct,null); assert.equal(r.dailyReturnBasis,null);
});
test("unbounded long Call profit has no numeric maximum daily return", () => {
  const r=analyze({type:"CALL",direction:"BUY",years:10/365});
  assert.equal(r.averageDailyMaxProfit,null); assert.equal(r.averageDailyReturnPct,null);
  assert.equal(r.dailyReturnBasis,"premium_paid"); close(r.remainingDays,10);
});
test("a zero-cost long Put retains daily money without dividing by a zero outlay", () => {
  const r=analyze({direction:"BUY",premium:0,years:10/365});
  close(r.averageDailyMaxProfit,10); assert.equal(r.averageDailyReturnPct,null);
});
test("daily maximum metrics cannot be confused with a volatility-dependent expected payoff", () => {
  const a=analyze({years:10/365,annualVol:.2}), b=analyze({years:10/365,annualVol:2,annualDrift:-.5});
  assert.notEqual(a.model.expectedPnl,b.model.expectedPnl);
  close(a.averageDailyMaxProfit,b.averageDailyMaxProfit); close(a.averageDailyReturnPct,b.averageDailyReturnPct);
});
test("nonprofitable maximum returns remain zero instead of a negative maximum-profit rate", () => {
  const r=analyze({years:10/365,additionalFees:11});
  assert.ok(r.cashReturnPct<0); assert.equal(r.averageDailyMaxProfit,0); assert.equal(r.averageDailyReturnPct,0);
});
test("tiny positive horizons leave overflowing daily averages unavailable without losing other metrics", () => {
  const r=analyze({years:Number.MIN_VALUE,annualVol:0});
  assert.ok(r.remainingDays>0 && r.remainingDays<1);
  assert.equal(r.averageDailyMaxProfit,null); assert.equal(r.averageDailyReturnPct,null);
  assert.equal(r.maxProfit,10); assert.ok(Number.isFinite(r.model.expectedPnl));
});
test("a duration outside the numeric day range does not emit Infinity", () => {
  const r=analyze({years:Number.MAX_VALUE,annualVol:0});
  assert.equal(r.remainingDays,null); assert.equal(r.averageDailyMaxProfit,null); assert.equal(r.averageDailyReturnPct,null);
  assert.equal(r.maxProfit,10);
});
test("independent Black-Scholes undiscounted ATM golden expectation", () => {
  // E[(S_T-K)+] = S Phi(.1) - K Phi(-.1) for S=K=100,
  // sigma=.2, T=1, arithmetic drift zero; published normal CDF values.
  const intrinsic = 7.965567455405804;
  for (const type of ["CALL","PUT"]) {
    close(analyze({type}).model.expectedPnl,10-intrinsic,1e-12);
    close(analyze({type,direction:"BUY"}).model.expectedPnl,intrinsic-10,1e-12);
  }
});
test("fee-free opposite positions have opposite EV and probabilities", () => {
  for(const type of ["CALL","PUT"]) {
    const a=analyze({type}),b=analyze({type,direction:"BUY"});
    close(a.model.expectedPnl,-b.model.expectedPnl); close(a.model.profitProbability,b.model.lossProbability);
  }
});
test("fees apply to both parties and do not cancel", () => {
  const a=analyze({feeEntryRate:.01,feeExerciseRate:.01});
  const b=analyze({direction:"BUY",feeEntryRate:.01,feeExerciseRate:.01});
  assert.equal(a.entryFee,1); assert.equal(b.entryFee,1);
  assert.ok(a.model.expectedPnl+b.model.expectedPnl < -2);
});
test("entry fee cap uses quoted premium", () => {
  const r=analyze({premium:.01,feeEntryRate:.00024}); close(r.entryFee,.001);
});
test("exercise fee uses cap near the strike", () => {
  const r=analyze({spot:110,strike:100,feeExerciseRate:.01});
  // -10% => 99; fee=min(.99,.1)=.1.
  close(scenario(r,-.1),8.9);
});
test("exercise fee uses spot percentage well inside strike", () => {
  close(scenario(analyze({feeExerciseRate:.01}),-.3),10-30-.7);
});
test("Call exercise fee kink in both regimes", () => {
  close(scenario(analyze({type:"CALL",spot:110/1.1,feeExerciseRate:.01}),.1),10-10-1);
  close(scenario(analyze({type:"CALL",spot:101/1.1,feeExerciseRate:.01}),.1),10-1-.1);
});
test("quantity and contract unit scale every money metric", () => {
  const a=analyze({feeEntryRate:.00024,feeExerciseRate:.00015});
  const b=analyze({feeEntryRate:.00024,feeExerciseRate:.00015,quantity:3,unit:.01});
  for(const key of ["entryFee","premiumTotal","maxProfit","maxLoss"])close(b[key],a[key]*.03);
  for(const key of ["expectedPnl","var95","es95","var99","es99"])close(b.model[key],a.model[key]*.03);
  close(b.model.profitProbability,a.model.profitProbability); close(b.breakEven,a.breakEven);
});
test("additional total fee is deducted once", () => {
  const base=analyze({quantity:2,unit:.5}), fees=analyze({quantity:2,unit:.5,additionalFees:3});
  close(fees.maxProfit,base.maxProfit-3); close(fees.maxLoss,base.maxLoss+3);
  close(fees.model.expectedPnl,base.model.expectedPnl-3); close(scenario(fees,-.3),scenario(base,-.3)-3);
});
test("additional fee does not scale with contract count", () => {
  close(analyze({quantity:3,additionalFees:2}).maxProfit,28);
});
test("fee-aware break even solves direct terminal payoff", () => {
  for(const type of ["CALL","PUT"])for(const direction of ["BUY","SELL"]){
    const r=analyze({type,direction,feeEntryRate:.002,feeExerciseRate:.002});
    const intrinsic=Math.max(type==="CALL"?r.breakEven-100:100-r.breakEven,0);
    close((direction==="BUY"?1:-1)*(intrinsic-10)-.2-Math.min(.002*r.breakEven,.1*intrinsic),0);
  }
});
test("excessively expensive long Put never reports positive probability", () => {
  const r=analyze({direction:"BUY",premium:110}); assert.equal(r.maxProfit,0); assert.equal(r.breakEven,null);
  assert.equal(r.model.profitProbability,0); assert.equal(r.model.lossProbability,1);
});
test("zero-credit Put distinguishes zero plateau from strict profit", () => {
  const r=analyze({premium:0}); assert.equal(r.maxProfit,0); assert.equal(r.model.profitProbability,0);
  close(r.model.lossProbability,.539827837277029); close(r.model.zeroProbability,.460172162722971);
  assert.ok(r.breakEvenRange.some(range=>range.lower===100&&range.upperUnbounded));
});
test("zero-cost Call has positive payoff and zero platform", () => {
  const r=analyze({type:"CALL",direction:"BUY",premium:0}); assert.equal(r.model.lossProbability,0);
  close(r.model.profitProbability,.460172162722971); close(r.model.zeroProbability,.539827837277029);
});
test("deterministic model win/loss/zero split", () => {
  const loss=analyze({annualVol:0,strike:120}),win=analyze({annualVol:0}),zero=analyze({annualVol:0,strike:110});
  assert.equal(loss.model.lossProbability,1); assert.equal(loss.model.var95,10);
  assert.equal(win.model.profitProbability,1); assert.equal(win.model.es95,0);
  assert.equal(zero.model.zeroProbability,1); assert.equal(zero.model.profitProbability,0); assert.equal(zero.model.lossProbability,0);
});
test("drift is arithmetic expectation drift not log-price drift", () => {
  // Zero volatility with mu=log(1.2) implies S_T=120.
  close(analyze({type:"CALL",annualVol:0,annualDrift:Math.log(1.2)}).model.expectedPnl,-10);
});
test("negative expected drift is supported", () => {
  assert.ok(analyze({annualDrift:-.2}).model.expectedPnl < analyze().model.expectedPnl);
});
test("positive-loss ES includes non-losing tail observations", () => {
  const r=analyze({strike:60,premium:.01});
  assert.equal(r.model.var95,0); assert.ok(r.model.es95>0);
  assert.ok(r.model.es95<r.model.es99);
});
test("golden tail risk for standard short Put", () => {
  const m=analyze().model;
  close(m.var95,19.45862193192025,1e-12);close(m.es95,24.941166018276604,1e-12);
  close(m.var99,28.446875731989664,1e-12);close(m.es99,32.372353979569624,1e-12);
});
test("risk bounds and probability mass hold across four directions", () => {
  for(const type of ["CALL","PUT"])for(const direction of ["BUY","SELL"]){
    const r=analyze({type,direction}),m=r.model;
    close(m.profitProbability+m.lossProbability+m.zeroProbability,1);
    assert.ok(m.es95+1e-10>=m.var95);assert.ok(m.es99+1e-10>=m.var99);assert.ok(m.es99+1e-10>=m.es95);
    if(r.maxLoss!==null) assert.ok(m.es99<=r.maxLoss+1e-10);
  }
});
test("remote tails are retained rather than CDF cancellation to zero", () => {
  const r=analyze({type:"CALL",strike:500,premium:1});
  assert.ok(r.model.lossProbability>0 && r.model.lossProbability<1e-12);
  assert.ok(r.model.expectedPnl<1);
});
test("all outputs can round trip through JSON without nonfinite numbers", () => {
  for(const type of ["CALL","PUT"])for(const direction of ["BUY","SELL"]){
    const r=analyze({type,direction});assert.deepEqual(JSON.parse(JSON.stringify(r)),r);
    const walk=value=>{if(typeof value==="number")assert.ok(Number.isFinite(value));else if(value&&typeof value==="object")Object.values(value).forEach(walk);};walk(r);
  }
});
test("browser UMD attaches the same deterministic API", () => {
  const context={};vm.createContext(context);vm.runInContext(fs.readFileSync("dashboard/dist/risk-metrics.js","utf8"),context);
  assert.equal(typeof context.OptionRisk.analyze,"function");assert.equal(context.OptionRisk.analyze({type:"PUT",direction:"SELL",strike:100,premium:10,spot:100,years:1,annualVol:0,feeEntryRate:0}).maxProfit,10);
});
test("invalid identities are rejected", () => {
  for(const input of [null,[],true,"option",{}])assert.throws(()=>Risk.analyze(input));
  for(const type of ["",false,"BTC"," PUT "])assert.throws(()=>analyze({type}));
  for(const direction of ["",false,"BID"," BUY "])assert.throws(()=>analyze({direction}));
});
test("negative and zero size or horizon rejected", () => {
  for(const key of ["quantity","unit","strike","spot","years"])for(const value of [0,-1])assert.throws(()=>analyze({[key]:value}),key);
  for(const key of ["premium","annualVol","additionalFees","feeEntryRate","feeExerciseRate","feeCap"])assert.throws(()=>analyze({[key]:-1}),key);
});
test("strings blanks booleans null nonfinite are never coerced", () => {
  for(const key of ["quantity","unit","strike","premium","spot","years","annualVol","annualDrift","additionalFees","feeEntryRate","feeExerciseRate","feeCap"])
    for(const value of [""," ","10",true,false,null,NaN,Infinity,-Infinity])assert.throws(()=>analyze({[key]:value}),key+":"+value);
});
test("numeric overflow and underflow fail instead of creating rankings", () => {
  for(const overrides of [{quantity:1e308,unit:1e308},{quantity:1e-300,unit:1e-300},{quantity:1e308},{annualVol:1e308},{years:1e308},{annualDrift:1e308},{spot:Number.MAX_VALUE},{quantity:1e-300,additionalFees:1e300}]) assert.throws(()=>analyze(overrides));
  for(const key of ["feeEntryRate","feeExerciseRate","feeCap"])assert.throws(()=>analyze({[key]:1.01}));
});
console.log(`${checks} option risk checks passed`);
