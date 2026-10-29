import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {testDatabase} from './auth-mail-fixture.mjs';
import {FINANCE_SCHEMA_SQL} from '../finance.mjs';
import {buildCostBook,iso} from '../cost-book.mjs';
import {buildRemainingCapital} from '../annualized-math.mjs';
import {connectionIdentity} from '../exchange.mjs';
import {buildAnnualizedResponse,fetchAnnualBoundary,handleAnnualized,warmAnnualBoundaries} from '../annualized.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const NOW=Date.parse('2026-10-28T00:00:00+08:00');
const boundary=y=>Date.UTC(y,0,1)-28800000;
function trade(id,at,cash='100',quantity='1') {return {id:String(id),bill_id:String(id*2),counter_bill_id:String(id*2+1),at_ms:Date.parse(at),side:'buy',inst_id:'BTC-USDT',trade_id:String(id),order_id:String(id),price:cash,btc_gross:quantity,btc_net:quantity,fee_btc:'0',fee_quote:'0',quote_ccy:'USDT',quote_gross:cash,quote_amount:cash,original_price:cash};}
async function fixture(){
 const {DB,sqlite}=testDatabase(FINANCE_SCHEMA_SQL),env={DB,OKX_API_KEY:'fixture-key',OKX_SECRET_KEY:'fixture-secret',OKX_PASSPHRASE:'fixture-pass'};
 const identity=await connectionIdentity({api_key:env.OKX_API_KEY,secret_key:env.OKX_SECRET_KEY});
 const records=[trade(1,'2024-12-14T08:00:00+08:00'),trade(2,'2025-06-01T08:00:00+08:00')];
 const put=async(key,value)=>DB.prepare('INSERT OR REPLACE INTO finance_kv(key,value,updated_ms) VALUES(?,?,?)').bind(key,JSON.stringify(value),NOW).run();
 const book=buildCostBook(records),capital={...buildRemainingCapital(records),identity};
 await put('cost_book',book);await put('annualized_capital',capital);await put('btc_pnl',{connection_id:identity.slice(0,24),status:'fresh',as_of:iso(NOW),quote_at:iso(NOW),metrics:{remaining_cost:'200',holdings_btc:'2',price_usdt:'120'}});
 await put('sync_status',{ok:true});await put('annualized_year_prices',{'2025':{at_ms:boundary(2025),price_usdt:'105',source:'fixture'},'2026':{at_ms:boundary(2026),price_usdt:'110',source:'fixture'}});
 return {env,sqlite,put,identity,capital};
}
test('annualized endpoint uses remaining cost dates and honest calendar-year boundaries',async()=>{
 const f=await fixture();try{const v=await buildAnnualizedResponse(f.env,{}, {now:NOW});assert.equal(v.connection_id,f.identity.slice(0,24));assert.equal(v.btc.status,'estimated');assert.ok(Number(v.btc.annualized_return_pct)>0);assert.deepEqual(v.btc.years.map(y=>y.year),[2024,2025,2026]);assert.equal(v.btc.mean_annual_years,1);assert.equal(v.portfolio.status,'needs_cashflows');assert.equal(v.portfolio.annualized_return_pct,null);assert.ok(!JSON.stringify(v).includes(f.env.OKX_SECRET_KEY));}finally{f.sqlite.close();}
});
test('different account and a ledger/cost race never reuse another or inconsistent annualized result',async()=>{
 const f=await fixture();try{await buildAnnualizedResponse(f.env,{}, {now:NOW});await f.put('annualized_capital',{...f.capital,identity:'other'});let v=await buildAnnualizedResponse(f.env,{}, {now:NOW});assert.equal(v.btc.annualized_return_pct,null);await f.put('annualized_capital',{...f.capital,cost:'201'});v=await buildAnnualizedResponse(f.env,{}, {now:NOW});assert.equal(v.btc.annualized_return_pct,null);}finally{f.sqlite.close();}
});
test('provider failure marks the exact cached calculation stale without moving its valuation date',async()=>{
 const f=await fixture();try{const first=await buildAnnualizedResponse(f.env,{}, {now:NOW});await f.put('sync_status',{ok:false});const stale=await buildAnnualizedResponse(f.env,{}, {now:NOW+60000});assert.equal(stale.btc.status,'stale');assert.equal(stale.btc.annualized_return_pct,first.btc.annualized_return_pct);assert.equal(stale.as_of,first.as_of);}finally{f.sqlite.close();}
});
test('missing yearly prices do not fabricate annual rows or prevent the all-period figure',async()=>{
 const f=await fixture();try{await f.put('annualized_year_prices',{});const v=await buildAnnualizedResponse(f.env,{}, {now:NOW});assert.notEqual(v.btc.annualized_return_pct,null);assert.equal(v.btc.years[0].annualized_return_pct,null);assert.equal(v.btc.mean_annual_return_pct,null);}finally{f.sqlite.close();}
});
test('confirmed close of Dec 31 is the exact Beijing Jan 1 boundary; wrong day/confirmation/redirects fail',async()=>{
 const at=boundary(2025),row=[String(at-86400000),'100','120','90','110','0','0','0','1'];
 const mock=(r,status=200)=>async(url,options)=>{const u=new URL(url);assert.equal(u.hostname,'www.okx.com');assert.equal(u.pathname,'/api/v5/market/history-candles');assert.equal(u.searchParams.get('bar'),'1D');assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.ok(!Object.keys(options.headers).some(k=>/key|sign|passphrase/i.test(k)));return Response.json({code:'0',data:[r]},{status});};
 const quote=await fetchAnnualBoundary(2025,{fetch:mock(row)});assert.equal(quote.at_ms,at);assert.equal(quote.price_usdt,'110');
 for(const wrong of [[String(at),...row.slice(1)],[...row.slice(0,8),'0'],[row[0],'100','120','90','125','0','0','0','1']])await assert.rejects(fetchAnnualBoundary(2025,{fetch:mock(wrong)}));
 await assert.rejects(fetchAnnualBoundary(2025,{fetch:async()=>new Response(null,{status:302,headers:{Location:'https://elsewhere.invalid'}})}));
});
test('year-price refresh is bounded and missing/provider-failed prices are not replaced by zero',async()=>{
 const f=await fixture();try{await f.put('annualized_year_prices',{});let calls=0;await warmAnnualBoundaries(f.env,f.capital,NOW,{now:NOW,fetch:async()=>{calls++;throw new Error('fixture failure');}});assert.equal(calls,2);await warmAnnualBoundaries(f.env,f.capital,NOW,{now:NOW+1,fetch:async()=>{calls++;}});assert.equal(calls,2);}finally{f.sqlite.close();}
});
test('annualized route rejects writes and query injection before reading private state',async()=>{
 assert.equal(await handleAnnualized(new Request('https://terminal.example/other'),{}),null);
 assert.equal((await handleAnnualized(new Request('https://terminal.example/api/wallet/annualized',{method:'POST'}),{})).status,405);
 assert.equal((await handleAnnualized(new Request('https://terminal.example/api/wallet/annualized?account=other'),{})).status,400);
});

async function withPortfolio(f){
 f.env.BINANCE_API_KEY='A'.repeat(64);f.env.BINANCE_SECRET_KEY='B'.repeat(64);f.env.WALLET_ADDRESS='bc1qfixture';
 const binance=await connectionIdentity({api_key:f.env.BINANCE_API_KEY,secret_key:f.env.BINANCE_SECRET_KEY});
 await f.put('portfolio_capital_ledger',{identity:f.identity,binance_identity:binance,wallet_address:f.env.WALLET_ADDRESS,scope:'c2c_known_flows',seed_epoch:'fixture',last_checked_ms:NOW,flows:[{id:'fixture-flow',at_ms:NOW-365*86400000,amount_usdt:'-100'}]});
 await f.put('portfolio',{complete:true,stale:false,total_usd:'110',updated_at:iso(NOW)});
 await f.put('market',{price_usdt:'102',btc_usd:'100',updated_at:iso(NOW)});
 await f.put('portfolio_capital_sync',{ok:true,last_success_ms:NOW});
 return binance;
}
test('total portfolio uses dated USDT-equivalent inputs and an observed cross quote rather than assuming USD equals USDT',async()=>{
 const f=await fixture();try{await withPortfolio(f);const result=await buildAnnualizedResponse(f.env,{}, {now:NOW});assert.equal(result.portfolio.currency,'USDT');assert.equal(result.portfolio.method,'cashflow_xirr');assert.equal(result.portfolio.net_invested_usdt,'100');assert.equal(result.portfolio.market_value_usdt,'112.2');assert.ok(Math.abs(Number(result.portfolio.annualized_return_pct)-12.2)<1e-7);assert.equal(result.portfolio.years[0].annualized_return_pct,null);assert.ok(!JSON.stringify(result).includes(f.env.BINANCE_SECRET_KEY));}finally{f.sqlite.close();}
});
test('a replaced Binance key cannot reuse the old total-portfolio cost baseline while BTC remains available',async()=>{
 const f=await fixture();try{await withPortfolio(f);await buildAnnualizedResponse(f.env,{}, {now:NOW});f.env.BINANCE_API_KEY='C'.repeat(64);const result=await buildAnnualizedResponse(f.env,{}, {now:NOW});assert.equal(result.portfolio.annualized_return_pct,null);assert.notEqual(result.btc.annualized_return_pct,null);}finally{f.sqlite.close();}
});
test('incomplete valuations and unsynchronized conversion quotes never become a full-portfolio annualized rate',async()=>{
 const f=await fixture();try{await withPortfolio(f);await f.put('portfolio',{complete:false,total_usd:'1',updated_at:iso(NOW)});let result=await buildAnnualizedResponse(f.env,{}, {now:NOW});assert.equal(result.portfolio.annualized_return_pct,null);await withPortfolio(f);await f.put('market',{price_usdt:'102',btc_usd:'100',updated_at:iso(NOW-300000)});result=await buildAnnualizedResponse(f.env,{}, {now:NOW});assert.equal(result.portfolio.annualized_return_pct,null);}finally{f.sqlite.close();}
});

test('unknown new funding cannot become investment profit, and a provider outage freezes the prior dated result',async()=>{
 const f=await fixture();try{
  await withPortfolio(f);const first=await buildAnnualizedResponse(f.env,{}, {now:NOW});
  await f.put('portfolio',{complete:true,stale:false,total_usd:'1110',updated_at:iso(NOW+60000)});
  await f.put('market',{price_usdt:'102',btc_usd:'100',updated_at:iso(NOW+60000)});
  await f.put('portfolio_capital_sync',{ok:false,status:'needs_review',code:'non_usdt_cost_unknown',error:'新入金成本待核对。'});
  let view=await buildAnnualizedResponse(f.env,{}, {now:NOW+60000});assert.equal(view.portfolio.annualized_return_pct,null);
  await f.put('portfolio_capital_sync',{ok:false,status:'error',code:'provider_unavailable',error:'资金源暂不可用。'});
  view=await buildAnnualizedResponse(f.env,{}, {now:NOW+60000});assert.equal(view.portfolio.status,'stale');assert.equal(view.portfolio.annualized_return_pct,first.portfolio.annualized_return_pct);assert.equal(view.portfolio.as_of,first.portfolio.as_of);assert.equal(view.portfolio.market_value_usdt,'112.2');
 }finally{f.sqlite.close();}
});
