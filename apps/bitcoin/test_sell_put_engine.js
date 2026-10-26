"use strict";
const assert = require("node:assert/strict");
const engine = require("./dashboard/dist/sell-put-engine.js");
const now=1792253428000,DAY=86400000;
let checks=0;
function test(name,run){run();checks++;console.log("OK sell-put: "+name);}
function close(a,b,tol=1e-7){assert.ok(Number.isFinite(a));assert.ok(Math.abs(a-b)<=tol,`${a} != ${b}`);}
function fixture(overrides={}) {
  const row={symbol:"BTC-261030-65000-P",side:"PUT",unit:1,quote_asset:"USDT",status:"TRADING",
    expiry_ms:now+15*DAY,strike_price:"65000",min_qty:"0.01",max_qty:"200",quantity_step:"0.01",quantity_scale:2,
    initial_margin_rate:"0.15",min_initial_margin_rate:"0.1",maintenance_margin_rate:"0.075",min_maintenance_margin_rate:"0.05",liquidation_fee_rate:"0.0019",
    bid_price:"65",ask_price:"70",bid_quantity:"10",ask_quantity:"10",mark_price:"65",mark_iv:"0.6",
    delta:"-0.02",gamma:"0.000005",vega:"7",theta:"-17",quote_updated_at:now,quote_source:"websocket",mark_updated_at:now,mark_source:"websocket",...overrides};
  return {btc_index_price:"81400",index_updated_at:now,index_source:"websocket",exchange_clock_offset_ms:0,catalog_updated_at:now,options:[row]};
}
function entry(snap=fixture(),settings={}){return engine.evaluate(snap,settings,now).rows[0];}
test("empty or invalid balance never produces a maximum quantity",()=>{
  for(const balance of ["",null,NaN,0,-1,Infinity])assert.ok(engine.evaluate(fixture(),{balance},now).issues.length);
});
test("1000 margin balance permits .12, not .13",()=>{
  const e=entry();assert.equal(e.issue,null);close(e.metrics.quantity,.12);
  close(e.metrics.grossPremium,7.8);close(e.metrics.entryFee,.78);close(e.metrics.netPremium,7.02);
  close(e.metrics.orderMargin,977.58);close(e.metrics.positionMargin,984.6);
  close(e.metrics.adjustedEquity,1007.02);close(e.metrics.equity,999.22);
});
test("maintenance uses wallet-based AE and includes liquidation reserve once",()=>{
  const m=entry().metrics;const expected=(81400*.05+65+81400*.0019)*.12;
  close(m.maintenanceMargin,expected);close(m.marginRatio,expected/1007.02);
  assert.notEqual(m.marginRatio,expected/m.equity);
});
test("same premium has three explicit capital denominators",()=>{
  const m=entry().metrics;close(m.accountAnnualPct,7.02/1000/15*365*100);
  close(m.orderAnnualPct,7.02/m.orderMargin/15*365*100);
  close(m.cashAnnualPct,7.02/(65000*.12)/15*365*100);
});
test("a distinct mark affects admission, not the premium collected",()=>{
  const m=entry(fixture({mark_price:"69.582"})).metrics;
  close(m.orderMargin,(8140+69.582-65+6.5)*.12);close(m.netPremium,7.02);
});
test("manual quantity above available margin is not called affordable",()=>{
  assert.match(entry(fixture(),{quantityMode:"manual",quantity:.13}).issue,/保证金不足/);
});
test("a valid naked-margin trade is not rejected for Kq exceeding cash",()=>{
  const e=entry();assert.ok(e.metrics.maxExpiryLoss>1000);assert.equal(e.issue,null);
  assert.ok(e.warnings.some(w=>w.includes("最大损失")));
});
test("cash secured mode stays separate",()=>{
  const m=entry(fixture(),{quantityMode:"cashSecured"}).metrics;close(m.quantity,.01);close(m.cashSecuredQuantity,.01);
});
test("reserve changes admission without pretending the account shrank",()=>{
  const m=entry(fixture(),{reserve:200}).metrics;close(m.quantity,.09);close(m.accountAnnualPct,m.netPremium/1000/15*365*100);
});
test("buy-one depth caps the actual modeled quantity",()=>{
  const e=entry(fixture({bid_quantity:"0.035"}));close(e.metrics.quantity,.03);
  close(e.metrics.maxMarginQuantity,.12);assert.ok(e.warnings.some(w=>w.includes("深度")));
});
test("LOT_SIZE step, not quantity decimal places, determines size",()=>{
  const e=entry(fixture({quantity_step:"0.05",min_qty:"0.05"}));close(e.metrics.quantity,.1);
  assert.match(entry(fixture({quantity_step:"0.05",min_qty:"0.05"}),{quantityMode:"manual",quantity:.12}).issue,/步长/);
});
test("metadata missing is not silently replaced with a familiar rate",()=>{
  for(const field of ["min_initial_margin_rate","maintenance_margin_rate","quantity_step","max_qty","liquidation_fee_rate"]){
    const s=fixture();delete s.options[0][field];assert.match(entry(s).issue,/规则缺失/);
  }
});
test("current quotes cannot make a stale mark usable for margin",()=>{
  assert.match(entry(fixture({mark_updated_at:now-21000})).issue,/陈旧/);
});
test("stale index, missing depth and crossed markets are unavailable",()=>{
  const s=fixture();s.index_updated_at=now-21000;assert.match(entry(s).issue,/指数/);
  assert.match(entry(fixture({bid_quantity:null})).issue,/深度/);
  assert.match(entry(fixture({ask_price:"60"})).issue,/交叉/);
});
test("old rule catalog and unsupported multiplier are rejected",()=>{
  const s=fixture();s.catalog_updated_at=now-600001;assert.match(entry(s).issue,/核验过旧/);
  assert.match(entry(fixture({unit:.1})).issue,/乘数/);
});
test("no disturbance anchors the observed mark and retains actual entry costs",()=>{
  const e=entry(fixture({mark_price:"69.582"}),{stressElapsedDays:0,stressMoves:[0],stressVols:[.6]});
  close(e.stress[0].mark,69.582);close(e.stress[0].equity,e.metrics.equity);
  const expected=e.metrics.netPremium-69.582*.12-Math.min(.00024*81400,.1*69.582)*.12;
  close(e.stress[0].pnl,expected);
});
test("larger IV increases short-put close cost in an unchanged-price model",()=>{
  const e=entry(fixture(),{stressElapsedDays:0,stressMoves:[0],stressVols:[.6,1.2]});
  assert.ok(e.stress[1].mark>e.stress[0].mark);assert.ok(e.stress[1].pnl<e.stress[0].pnl);
});
test("price can remain above strike while stress touches liquidation condition",()=>{
  const e=entry(fixture(),{stressElapsedDays:0,stressMoves:[68000/81400-1],stressVols:[3]});
  assert.ok(e.stress[0].spot>e.strike);assert.equal(e.stress[0].state,"liquidation");
});
test("after expiry, settle intrinsic and release margin without asserting survival",()=>{
  const e=entry(fixture(),{stressElapsedDays:20,stressMoves:[60000/81400-1],stressVols:[1.2]});
  const p=e.stress[0];assert.equal(p.state,"settled");close(p.maintenanceMargin,0);close(p.marginRatio,0);
  close(p.pnl,7.02-5000*.12-Math.min(.00015*60000,.1*5000)*.12);
  assert.match(p.note,/不保证/);
});
test("expiry OTM means no exercise fee",()=>{
  const e=entry(fixture(),{stressElapsedDays:15,stressMoves:[0],stressVols:[.8]});
  close(e.stress[0].closingFee,0);close(e.stress[0].pnl,7.02);
});
test("break-even includes the exercise-fee rule",()=>{
  const e=entry();close(engine.expiryCash(e,e.metrics.breakEven).pnl,0,1e-8);
});
test("seller Greek direction reverses contract Greeks and scales quantity",()=>{
  const m=entry().metrics;close(m.entryDelta,.02*.12);close(m.entryGamma,-.000005*.12);
  close(m.entryVega,-7*.12);close(m.entryTheta,17*.12);
});
test("default screening is 10-20 days and strike 75-80 percent",()=>{
  assert.equal(engine.evaluate(fixture({strike_price:"60000"}),{},now).rows.length,0);
  assert.equal(engine.evaluate(fixture({expiry_ms:now+30*DAY}),{},now).rows.length,0);
});
test("default ordering does not optimize highest advertised annualization",()=>{
  const s=fixture();s.options.push({...s.options[0],symbol:"BTC-261031-64000-P",strike_price:"64000",expiry_ms:now+16*DAY,bid_price:"100",ask_price:"105"});
  const r=engine.evaluate(s,{},now);assert.equal(r.rows[0].symbol,"BTC-261030-65000-P");
});
test("known Black-Scholes references and expiry limits",()=>{
  close(engine.putPrice(100,100,1,.2),7.965567455405804,1e-10);
  close(engine.putPrice(1,.75,15/365,.6),.0003176282009523905,1e-14);
  close(engine.putPrice(1,.8,15/365,.6),.0014209471540199761,1e-14);
  close(engine.putPrice(100,110,0,.8),10);close(engine.putPrice(100,110,1,0),10);
});
test("no silent zero or infinite setting inputs",()=>{
  for(const config of [{minStrikeRatio:0},{reserve:1000},{stressVols:[NaN]},{stressMoves:[-1]},{stressElapsedDays:-1},{feeRate:2}])assert.ok(engine.evaluate(fixture(),config,now).issues.length);
});
console.log(`${checks} sell-put engine checks passed.`);
