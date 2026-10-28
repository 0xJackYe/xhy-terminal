import test from 'node:test';
import assert from 'node:assert/strict';
import {syncPortfolioCashflows} from '../capital-sync.mjs';
import {testDatabase,NOW} from './auth-mail-fixture.mjs';
const DAY=86400000,A='a'.repeat(64),B='b'.repeat(64),schema='CREATE TABLE finance_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_ms INTEGER NOT NULL)';
const seed=()=>({identity:A,binance_identity:B,last_checked_ms:NOW-3*DAY,flows:[{id:'okx-c2c:100',at_ms:NOW-20*DAY,amount_usdt:'-100',source:'OKX C2C',asset:'USDT',method:'exact_reported_usdt_balance_change'}],coverage:{okx_source_as_of:new Date(NOW-3*DAY).toISOString(),all_funding_channels_verified:false},summary:{combined_c2c:{net_contributed_usdt:'100'}}});
const bill=(number,type,change,at=NOW-3600000,ccy='USDT')=>({billId:String(number),type,balChg:change,ts:String(at),ccy,notes:'private-person-name-not-to-store'});
const order=(number,tradeType,amount,at=NOW-1800000,extra={})=>({orderNumber:String(number),tradeType,amount,createTime:at,asset:'USDT',orderStatus:'COMPLETED',counterparty:'private-counterparty-not-to-store',...extra});
function environment(t,ledger=seed()){
 const {DB,sqlite}=testDatabase(schema);t.after(()=>sqlite.close());
 const env={DB},calls=[];
 const set=(key,value)=>DB.prepare('INSERT INTO finance_kv(key,value,updated_ms) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,JSON.stringify(value),NOW).run();
 const get=async key=>{const row=await DB.prepare('SELECT value FROM finance_kv WHERE key=?').bind(key).first();return row?JSON.parse(row.value):null;};
 const okx=async()=>[],binance=async()=>({code:'000000',success:true,data:[],total:0});
 const handlers={okx,binance};
 const opts={now:NOW,expectedIdentity:A,expectedBinanceIdentity:B,getCurrentIdentities:async()=>({identity:A,binance_identity:B}),okxClient:{get:async(path,params)=>{calls.push({venue:'okx',path,params});return handlers.okx(path,params);}},binanceClient:{get:async(path,params)=>{calls.push({venue:'binance',path,params});return handlers.binance(path,params);}}};
 return {env,calls,handlers,opts,set,get,ready:set('portfolio_capital_ledger',ledger),sqlite};
}
test('new C2C USDT deposits and withdrawals update principal once and persist only normalized money fields',async t=>{
 const f=environment(t);await f.ready;
 f.handlers.okx=async(path,p)=>p.type==='117'?[bill(101,'117','10')]:p.type==='116'?[bill(102,'116','-3')]:[];
 f.handlers.binance=async(path,p)=>({code:'000000',success:true,data:p.tradeType==='BUY'?[order(201,'BUY','5')]:[],total:p.tradeType==='BUY'?1:0});
 const result=await syncPortfolioCashflows(f.env,f.opts);assert.equal(result.ok,true);assert.equal(result.new_flows,3);
 let ledger=await f.get('portfolio_capital_ledger');assert.equal(ledger.summary.combined_c2c.net_contributed_usdt,'112');assert.equal(ledger.flows.length,4);assert.equal(ledger.last_checked_ms,NOW);
 assert.equal(ledger.flows.find(x=>x.id==='okx-c2c:101').amount_usdt,'-10');assert.equal(ledger.flows.find(x=>x.id==='okx-c2c:102').amount_usdt,'3');
 assert.doesNotMatch(JSON.stringify(ledger),/private-person|counterparty|notes|orderNumber/);
 const second=await syncPortfolioCashflows(f.env,{...f.opts,now:NOW+60000,force:true});assert.equal(second.ok,true);assert.equal(second.new_flows,0);ledger=await f.get('portfolio_capital_ledger');assert.equal(ledger.flows.length,4);assert.equal(ledger.summary.combined_c2c.net_contributed_usdt,'112');
 for(const call of f.calls){assert.equal(call.path,call.venue==='okx'?'/api/v5/asset/bills-history':'/sapi/v1/c2c/orderMatch/listUserOrderHistory');assert.ok(!/withdraw|order\/|transfer/.test(call.path));}
});
test('all uncompleted Binance orders are excluded while completed USDT rows retain exact amounts',async t=>{
 const f=environment(t);await f.ready;
 f.handlers.binance=async(path,p)=>{const data=p.tradeType==='BUY'?[order(201,'BUY','3.00000001'),order(202,'BUY','999',NOW-1800000,{orderStatus:'CANCELLED'})]:[];return{code:'000000',success:true,data,total:data.length};};
 const result=await syncPortfolioCashflows(f.env,f.opts);assert.equal(result.ok,true);assert.equal(result.ignored_uncompleted,1);const ledger=await f.get('portfolio_capital_ledger');assert.equal(ledger.flows.length,2);assert.equal(ledger.summary.combined_c2c.net_contributed_usdt,'103.00000001');
});
test('saved PDF USDT timestamps deduplicate millisecond API timestamps without replacing the source cost date',async t=>{
 const ledger=seed(),at=NOW-3600000;ledger.flows.push({id:'binance-c2c:201',at_ms:at,amount_usdt:'-300.3',asset:'USDT',source:'Original PDF',method:'exact_reported_usdt_quantity',source_quantity:'300.3'});
 const f=environment(t,ledger);await f.ready;f.handlers.binance=async(path,p)=>({code:'000000',success:true,data:p.tradeType==='BUY'?[order(201,'BUY','300.30000000',at+801)]:[],total:p.tradeType==='BUY'?1:0});
 const result=await syncPortfolioCashflows(f.env,f.opts);assert.equal(result.ok,true);assert.equal(result.new_flows,0);assert.equal((await f.get('portfolio_capital_ledger')).flows.find(x=>x.id==='binance-c2c:201').at_ms,at);
});
test('a known direct BTC PDF valuation is retained instead of being mistaken for new USDT investment',async t=>{
 const ledger=seed();ledger.flows.push({id:'binance-c2c:201',at_ms:NOW-3600000,amount_usdt:'-25',asset:'BTC',method:'reported_order_fx_usdt_equivalent_estimate',source_quantity:'0.0002'});
 const f=environment(t,ledger);await f.ready;f.handlers.binance=async(path,p)=>({code:'000000',success:true,data:p.tradeType==='BUY'?[order(201,'BUY','0.0002',NOW-3600000,{asset:'BTC'})]:[],total:p.tradeType==='BUY'?1:0});
 const result=await syncPortfolioCashflows(f.env,f.opts);assert.equal(result.ok,true);assert.equal(result.new_flows,0);assert.equal((await f.get('portfolio_capital_ledger')).summary.combined_c2c.net_contributed_usdt,'125');
});
test('a new non-USDT order needs review and cannot commit other partially collected deposits or advance coverage',async t=>{
 const f=environment(t);await f.ready;const before=await f.get('portfolio_capital_ledger');
 f.handlers.okx=async(path,p)=>p.type==='117'?[bill(101,'117','10')]:[];
 f.handlers.binance=async(path,p)=>({code:'000000',success:true,data:p.tradeType==='BUY'?[order(201,'BUY','0.0002',NOW-3600000,{asset:'BTC'})]:[],total:p.tradeType==='BUY'?1:0});
 const result=await syncPortfolioCashflows(f.env,f.opts);assert.equal(result.status,'needs_review');assert.equal(result.code,'non_usdt_cost_unknown');assert.deepEqual(result.assets,['BTC']);assert.deepEqual(await f.get('portfolio_capital_ledger'),before);assert.equal((await f.get('portfolio_capital_sync')).status,'needs_review');
});
test('fifteen-minute distributed cooldown and running lease coalesce concurrent invocations, including forced attempts',async t=>{
 const f=environment(t);await f.ready;let release;const pending=new Promise(resolve=>{release=resolve;});let initial=true;
 f.handlers.okx=async()=>{if(initial){initial=false;await pending;}return [];};
 const running=syncPortfolioCashflows(f.env,f.opts);for(let i=0;i<20;i++)await Promise.resolve();
 const concurrent=await syncPortfolioCashflows(f.env,{...f.opts,force:true});assert.equal(concurrent.skipped,true);release();assert.equal((await running).ok,true);
 const calls=f.calls.length;assert.equal((await syncPortfolioCashflows(f.env,{...f.opts,now:NOW+60000})).skipped,true);assert.equal(f.calls.length,calls);
 assert.equal((await syncPortfolioCashflows(f.env,{...f.opts,now:NOW+15*60000})).ok,true);
});
test('three full OKX pages, incomplete Binance pages and repeated IDs all fail without committing a partial history',async t=>{
 for(const scenario of ['okx_limit','binance_limit','duplicate']){
  const f=environment(t);await f.ready;const before=await f.get('portfolio_capital_ledger');
  if(scenario==='okx_limit')f.handlers.okx=async(path,p)=>Array.from({length:100},(_,i)=>bill(1000+Number(p.after||0)+i,p.type,'1'));
  else f.handlers.binance=async(path,p)=>{const data=p.tradeType==='BUY'?scenario==='duplicate'?[order(201,'BUY','1'),order(201,'BUY','1')]:Array.from({length:100},(_,i)=>order(p.page*1000+i,'BUY','1')):[];return{code:'000000',success:true,data,total:p.tradeType==='BUY'?scenario==='duplicate'?2:301:0};};
  const result=await syncPortfolioCashflows(f.env,f.opts);assert.equal(result.ok,false);assert.ok(['page_limit','invalid_response'].includes(result.code));assert.deepEqual(await f.get('portfolio_capital_ledger'),before);
 }
});
test('provider errors stay sanitized and do not overwrite verified principal',async t=>{
 const f=environment(t);await f.ready;const before=await f.get('portfolio_capital_ledger');f.handlers.okx=async()=>{const e=new Error('secret-key-and-private-provider-response');e.code='rate_limited';throw e;};
 const result=await syncPortfolioCashflows(f.env,f.opts);assert.equal(result.code,'rate_limited');assert.doesNotMatch(JSON.stringify(result),/secret-key|private-provider/);assert.deepEqual(await f.get('portfolio_capital_ledger'),before);
});
test('initial identity mismatch prevents network calls and a mid-read account switch prevents every ledger write',async t=>{
 const f=environment(t);await f.ready;const before=await f.get('portfolio_capital_ledger');
 assert.equal((await syncPortfolioCashflows(f.env,{...f.opts,expectedIdentity:'c'.repeat(64)})).code,'identity_changed');assert.equal(f.calls.length,0);
 let checks=0;const result=await syncPortfolioCashflows(f.env,{...f.opts,getCurrentIdentities:async()=>({identity:++checks===1?A:'c'.repeat(64),binance_identity:B})});
 assert.equal(result.code,'identity_changed');assert.deepEqual(await f.get('portfolio_capital_ledger'),before);
});
test('optimistic CAS never overwrites a concurrently imported ledger and atomic storage failures roll back all money changes',async t=>{
 const f=environment(t);await f.ready;let changed=false;f.handlers.okx=async()=>{if(!changed){changed=true;await f.set('portfolio_capital_ledger',{...seed(),import_note:'new verified import'});}return [];};
 assert.equal((await syncPortfolioCashflows(f.env,f.opts)).code,'concurrent_change');assert.equal((await f.get('portfolio_capital_ledger')).import_note,'new verified import');
 const g=environment(t);await g.ready;const before=await g.get('portfolio_capital_ledger'),batch=g.env.DB.batch.bind(g.env.DB);let inject=true;
 g.env.DB.batch=async statements=>{if(inject&&statements[0].sql.startsWith('UPDATE finance_kv SET value=')){inject=false;statements[1]=g.env.DB.prepare('INSERT INTO absent_test_table VALUES(1)');}return batch(statements);};
 const result=await syncPortfolioCashflows(g.env,g.opts);assert.equal(result.code,'storage_unavailable');assert.deepEqual(await g.get('portfolio_capital_ledger'),before);
});
test('requests use bounded thirty-day windows, with six-month gaps refusing silent truncation',async t=>{
 const f=environment(t,{...seed(),last_checked_ms:NOW-70*DAY});await f.ready;
 assert.equal((await syncPortfolioCashflows(f.env,f.opts)).ok,true);
 for(const {venue,params}of f.calls)if(venue==='binance'){assert.ok(params.endTimestamp-params.startTimestamp<30*DAY);assert.equal(params.rows,100);assert.equal(params.recvWindow,5000);}
 const g=environment(t,{...seed(),last_checked_ms:NOW-200*DAY});await g.ready;const result=await syncPortfolioCashflows(g.env,g.opts);assert.equal(result.code,'history_gap');assert.equal(g.calls.length,0);
});
