import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {testDatabase} from './auth-mail-fixture.mjs';
import {FINANCE_SCHEMA_SQL,syncFinance} from '../finance.mjs';
import {buildCostBook,beijingDate,iso} from '../cost-book.mjs';
import {buildRemainingCapital} from '../annualized-math.mjs';
import {connectionIdentity} from '../exchange.mjs';
import {buildAnnualizedResponse,warmAnnualBoundaries} from '../annualized.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const NOW=Date.parse('2026-10-28T04:00:00+08:00'),DAY=86400000;
const ADDRESS='bc1q'+'q'.repeat(30);
const ok=rows=>Response.json({code:'0',data:rows});
function trade(id,side,qty,cash,at){return {id:`BTC-USDT:${id}:${100+id}`,bill_id:String(id*2),counter_bill_id:String(id*2+1),at_ms:at,side,inst_id:'BTC-USDT',trade_id:String(id),order_id:String(100+id),price:'100',btc_gross:String(Math.abs(Number(qty))),btc_net:qty,fee_btc:'0',fee_quote:'0',quote_ccy:'USDT',quote_gross:cash,quote_amount:cash,original_price:'100'};}
async function fixture(t){
 const {DB,sqlite}=testDatabase(FINANCE_SCHEMA_SQL);t.after(()=>sqlite.close());
 const env={DB,OKX_API_KEY:'fixture-key',OKX_SECRET_KEY:'fixture-secret',OKX_PASSPHRASE:'fixture-pass',BINANCE_API_KEY:'A'.repeat(64),BINANCE_SECRET_KEY:'B'.repeat(64),WALLET_ADDRESS:ADDRESS};
 const account=await connectionIdentity({api_key:env.OKX_API_KEY,secret_key:env.OKX_SECRET_KEY});
 const records=[trade(1,'buy','1','100',NOW-400*DAY),trade(2,'sell','-0.5','50',NOW-DAY)];
 const put=async(key,value)=>DB.prepare('INSERT OR REPLACE INTO finance_kv(key,value,updated_ms) VALUES(?,?,?)').bind(key,JSON.stringify(value),NOW).run();
 const get=async key=>{const row=await DB.prepare('SELECT value FROM finance_kv WHERE key=?').bind(key).first();return row?JSON.parse(row.value):null;};
 const capital={...buildRemainingCapital(records),identity:account,seed_epoch:'fixture-capital-v1'};
 await put('cost_book',buildCostBook(records));await put('annualized_capital',capital);
 await put('cost_meta',{identity:account,complete:true,coverage_start_ms:records[0].at_ms,as_of_ms:NOW-60000});
 await put('historical_rates',{});await put('policy',{received_btc:'0',verified_nonspot_adjustment_btc:'0'});
 await put('btc_pnl',{connection_id:account.slice(0,24),status:'fresh',as_of:iso(NOW),quote_at:iso(NOW),metrics:{remaining_cost:'50',holdings_btc:'0.5',price_usdt:'120'}});
 await put('annualized_year_prices',{});await put('sync_status',{ok:true});
 for(const r of records)await DB.prepare('INSERT INTO finance_trades(id,bill_id,at_ms,record_json) VALUES(?,?,?,?)').bind(r.id,r.bill_id,r.at_ms,JSON.stringify(r)).run();
 const bills=[{billId:'6',tradeId:'3',ordId:'103',instType:'SPOT',instId:'BTC-USDT',subType:'1',ccy:'BTC',sz:'0.2',px:'100',fee:'0',balChg:'0.2',ts:String(NOW-1000)},{billId:'7',tradeId:'3',ordId:'103',instType:'SPOT',instId:'BTC-USDT',subType:'2',ccy:'USDT',sz:'20',px:'100',fee:'0',balChg:'-20',ts:String(NOW-1000)}];
 const fetcher=async(address,options)=>{
  assert.equal(options.method,'GET');const u=new URL(address);
  if(u.hostname==='www.okx.com'){
   if(u.pathname.endsWith('/public/time'))return ok([{ts:String(NOW)}]);
   if(u.pathname.endsWith('/account/config'))return ok([{perm:'read_only'}]);
   if(u.pathname.endsWith('/account/balance'))return ok([{totalEq:'24',details:[{ccy:'BTC',cashBal:'0.2',eq:'0.2',liab:'0',availBal:'0.2'}]}]);
   if(u.pathname.endsWith('/asset/balances'))return ok([]);
   if(u.pathname.endsWith('/market/tickers'))return ok([{instId:'BTC-USDT',last:'120',ts:String(NOW)}]);
   if(u.pathname.endsWith('/market/index-tickers'))return ok([{instId:'BTC-USD',idxPx:'120',ts:String(NOW)}]);
   if(u.pathname.endsWith('/account/bills-archive'))return ok(bills);
  }
  if(u.hostname==='api-gcp.binance.com'){
   if(u.pathname==='/api/v3/time')return Response.json({serverTime:NOW});
   if(u.pathname==='/sapi/v1/account/apiRestrictions')return Response.json({enableReading:true,enableWithdrawals:false,enableSpotAndMarginTrading:false});
   if(u.pathname==='/sapi/v1/asset/wallet/balance')return Response.json([{walletName:'Spot',activate:false,balance:'0',assetBalances:[]}]);
  }
  if(u.hostname==='blockstream.info')return Response.json({address:ADDRESS,chain_stats:{funded_txo_sum:50000000,spent_txo_sum:0,tx_count:1}});
  if(u.hostname==='api.frankfurter.dev')return Response.json([{base:'USD',quote:'CNY',date:'2026-10-27',rate:7}]);
  throw new Error('Unexpected fixture endpoint');
 };
 return {env,DB,sqlite,put,get,account,capital,fetcher};
}

test('a real finance DCA sync appends dated remaining capital once and publishes matching annualized data',async t=>{
 const f=await fixture(t),before=await buildAnnualizedResponse(f.env,{}, {now:NOW});
 const result=await syncFinance(f.env,{fetch:f.fetcher,now:()=>NOW,force:true});assert.equal(result.ok,true);
 const capital=await f.get('annualized_capital'),book=await f.get('cost_book');assert.equal(capital.identity,f.account);assert.equal(capital.trade_count,3);assert.equal(capital.last_bill_id,'6');assert.equal(capital.cost,book.cost);assert.equal(capital.inventory,book.inventory);assert.equal(capital.cost,'70');assert.equal(capital.seed_epoch,'fixture-capital-v1');
 const after=await buildAnnualizedResponse(f.env,{}, {now:NOW});assert.equal(after.btc.remaining_cost,'70');assert.equal(after.btc.cashflow_count,2);assert.equal(after.btc.status,'estimated');assert.notEqual(after.btc.market_value,before.btc.market_value);
 await f.DB.prepare("DELETE FROM finance_kv WHERE key='sync_lock'").run();await syncFinance(f.env,{fetch:f.fetcher,now:()=>NOW,force:true});
 assert.deepEqual(await f.get('annualized_capital'),capital);assert.equal((await f.DB.prepare('SELECT COUNT(*) AS count FROM finance_trades').first()).count,3);
});

test('a derived capital seed that fell behind a running cost book catches up from verified trades instead of remaining unavailable',async t=>{
 const f=await fixture(t);
 await f.put('annualized_capital',{...buildRemainingCapital([trade(1,'buy','1','100',NOW-400*DAY)]),identity:f.account,seed_epoch:'lagged-seed'});
 const result=await syncFinance(f.env,{fetch:f.fetcher,now:()=>NOW,force:true});assert.equal(result.ok,true);
 const capital=await f.get('annualized_capital'),book=await f.get('cost_book');assert.equal(capital.trade_count,3);assert.equal(capital.cost,'70');assert.equal(capital.cost,book.cost);assert.equal(capital.inventory,book.inventory);assert.equal(capital.seed_epoch,'lagged-seed');
 const view=await buildAnnualizedResponse(f.env,{}, {now:NOW});assert.notEqual(view.btc.annualized_return_pct,null);
});

test('a replaced account cannot append to or reveal prior account capital even when its scalar book matches',async t=>{
 const f=await fixture(t);await buildAnnualizedResponse(f.env,{}, {now:NOW});const previous=await f.get('annualized_capital');
 f.env.OKX_API_KEY='different-account-key';f.env.OKX_SECRET_KEY='different-account-secret';
 const result=await syncFinance(f.env,{fetch:f.fetcher,now:()=>NOW,force:true});assert.equal(result.ok,true);
 assert.deepEqual(await f.get('annualized_capital'),previous);const view=await buildAnnualizedResponse(f.env,{}, {now:NOW});assert.equal(view.btc.annualized_return_pct,null);assert.equal(view.btc.status,'unavailable');
});

test('rederived acquisition dates invalidate a scalar-matching cached result through the seed epoch',async t=>{
 const f=await fixture(t),first=await buildAnnualizedResponse(f.env,{}, {now:NOW});
 const corrected=structuredClone(f.capital);corrected.seed_epoch='fixture-capital-v2';
 for(const cohort of corrected.cohorts){cohort.at_ms-=365*DAY;cohort.date=beijingDate(cohort.at_ms);cohort.first_buy_at=iso(Date.parse(cohort.first_buy_at)-365*DAY);}
 corrected.first_buy_at=iso(Date.parse(corrected.first_buy_at)-365*DAY);corrected.first_remaining_buy_at=corrected.cohorts[0].first_buy_at;
 await f.put('annualized_capital',corrected);const next=await buildAnnualizedResponse(f.env,{}, {now:NOW});
 assert.notEqual(next.btc.annualized_return_pct,first.btc.annualized_return_pct);assert.ok(Number(next.btc.annualized_return_pct)<Number(first.btc.annualized_return_pct));assert.equal(next.btc.first_buy_at,corrected.first_buy_at);
});

test('an existing malformed boundary is treated as missing and replaced only by a confirmed exact-day close',async t=>{
 const f=await fixture(t),year=2026,boundary=Date.UTC(year,0,1)-28800000;
 await f.put('annualized_year_prices',{'2026':{at_ms:boundary+DAY,price_usdt:'0',source:'invalid fixture'}});
 let calls=0;const prices=await warmAnnualBoundaries(f.env,f.capital,NOW,{now:NOW,fetch:async address=>{calls++;const url=new URL(address);assert.equal(url.searchParams.get('after'),String(boundary));return ok([[String(boundary-DAY),'100','130','90','120','0','0','0','1']]);}});
 assert.equal(calls,1);assert.equal(prices[2026].at_ms,boundary);assert.equal(prices[2026].price_usdt,'120');
 const value=await buildAnnualizedResponse(f.env,{}, {now:NOW});assert.notEqual(value.btc.years[0].annualized_return_pct,null);
});

test('a boundary backfill invalidates the cached annual table without changing the all-period price or capital',async t=>{
 const f=await fixture(t),first=await buildAnnualizedResponse(f.env,{}, {now:NOW});assert.equal(first.btc.years[0].annualized_return_pct,null);
 await f.put('annualized_year_prices',{'2026':{at_ms:Date.UTC(2026,0,1)-28800000,price_usdt:'110',source:'confirmed fixture'}});
 const next=await buildAnnualizedResponse(f.env,{}, {now:NOW});assert.equal(next.btc.annualized_return_pct,first.btc.annualized_return_pct);assert.notEqual(next.btc.years[0].annualized_return_pct,null);
});
