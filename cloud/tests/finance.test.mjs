import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHmac } from 'node:crypto';
import { D, normalizeBills, buildCostBook, appendCostBook, positionView, costView, iso } from '../cost-book.mjs';
import { ExchangeClient, FinanceError, validateOKXPermissions, validateBinancePermissions, encryptConfiguration, decryptConfiguration, connectionIdentity, normalizeBinance } from '../exchange.mjs';
import { syncFinance, handleFinance, aggregatePortfolio } from '../finance.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const NOW=Date.now(),ADDRESS='bc1q'+'a'.repeat(38),KEY='A'.repeat(64),SECRET='B'.repeat(64);
const OKX={api_key:'fixture-okx-key',secret_key:'fixture-okx-secret',passphrase:'fixture-pass'};
function trade(side,qty,cash,id,at=NOW-10000,ccy='USDT'){
  return {id:String(id),bill_id:String(id*2),counter_bill_id:String(id*2+1),at_ms:at+id,side,inst_id:'BTC-'+ccy,trade_id:String(id),order_id:String(id+100),price:new D(cash).div(new D(qty).abs()).toFixed(),btc_gross:new D(qty).abs().toFixed(),btc_net:qty,fee_btc:'0',fee_quote:'0',quote_ccy:ccy,quote_gross:cash,quote_amount:cash,original_price:new D(cash).div(new D(qty).abs()).toFixed()};
}
const original=[trade('buy','2','200',1,NOW-86400000),trade('sell','-1','150',2,NOW-43200000)];
function bills(){const common={instType:'SPOT',instId:'BTC-USDT',tradeId:'3',ordId:'103',ts:String(NOW-60000),fillTime:String(NOW-60000),px:'120'};return [{...common,billId:'6',ccy:'BTC',sz:'.5',fee:'0',balChg:'.5',subType:'1'},{...common,billId:'7',ccy:'USDT',sz:'60',fee:'0',balChg:'-60',subType:'2'}];}
const ok=response=>new Response(JSON.stringify({code:'0',data:response}),{status:200});

test('moving average only describes the remaining position, not past realized proceeds',()=>{
  const book=buildCostBook(original),view=positionView(book,'1','120',{complete:true,as_of_ms:NOW,coverage_start_ms:NOW-86400000},{},NOW,'account');
  assert.equal(book.cost,'100');assert.equal(view.metrics.average_cost,'100');assert.equal(view.metrics.unrealized_net,'20');assert.equal(view.metrics.unrealized_return_pct,'20');
  assert.equal(view.metrics.realized_net,undefined);assert.equal(view.metrics.break_even_price,undefined);
  const changed=structuredClone(original);changed[1].quote_amount='9999';changed[1].quote_gross='9999';
  assert.equal(buildCostBook(changed).cost,'100');
});
test('new daily DCA updates average, quantity, cost and last buy time',()=>{
  const first=buildCostBook(original),next=appendCostBook(first,[trade('buy','.5','60',3,NOW-1000)]);
  assert.equal(next.cost,'160');assert.equal(next.inventory,'1.5');assert.equal(next.buy_count,2);assert.notEqual(next.last_buy_at,first.last_buy_at);
  const view=positionView(next,'1.5','120',{complete:true,as_of_ms:NOW,coverage_start_ms:NOW-86400000},{},NOW,'account');
  assert.equal(view.metrics.unrealized_net,'20');assert.equal(view.metrics.unrealized_return_pct,'12.5');
});
test('fees already included in net quantity and cash are not deducted twice',()=>{
  const row=trade('buy','.999','100.1',1);row.btc_gross='1';row.fee_btc='-.001';
  const book=buildCostBook([row]),p=positionView(book,'.999','120',{},{},NOW,'x');assert.equal(p.metrics.unrealized_net,'19.78');
});
test('known nonspot quantity adjusts total holding basis only once',()=>{
  const p=positionView(buildCostBook(original),'1.1','120',{},{},NOW,'x');assert.equal(p.metrics.unrealized_net,'32');assert.equal(p.metrics.nonspot_btc_adjustment,'.1'.replace(/^\./,'0.'));
});
test('cross currency costs require the exact historical minute rate',()=>{
  const row=trade('buy','1','2',1,NOW-10000,'ETH'),key='ETH:'+(Math.floor(row.at_ms/60000)*60000);
  assert.throws(()=>buildCostBook([row]),/historical_rate_missing/);
  assert.equal(buildCostBook([row],{[key]:{close:'2000'}}).cost,'4000');
});
test('duplicates, overselling and out of order incremental records fail closed',()=>{
  assert.throws(()=>buildCostBook([original[0],original[0]]),/duplicate_trade/);
  assert.throws(()=>buildCostBook([trade('sell','-1','100',1)]),/history_invalid/);
  assert.throws(()=>appendCostBook(buildCostBook(original),[trade('buy','1','20',9,NOW-86400001)]),/out_of_order_trade/);
});
test('full liquidation and zero basis do not divide by zero or invent return percentages',()=>{
  const b=buildCostBook([trade('buy','1','100',1),trade('sell','-1','150',2)]),p=positionView(b,'0','120',{},{},NOW,'x');
  assert.equal(p.metrics.average_cost,null);assert.equal(p.metrics.unrealized_return_pct,null);assert.equal(p.metrics.unrealized_net,'0');
});
test('two leg bills reconcile exact net cash and prevent partial or conflicting updates',()=>{
  const rows=bills(),normalized=normalizeBills(rows);assert.equal(normalized[0].btc_net,'0.5');assert.equal(normalized[0].quote_amount,'60');
  assert.throws(()=>normalizeBills(rows.slice(0,1)),/incomplete_trade_legs/);
  assert.throws(()=>normalizeBills([...rows,{...rows[0],fee:'-.1'}]),/conflicting_bill/);
  assert.throws(()=>normalizeBills([{...rows[0],balChg:'4'},rows[1]]),/balance_change_mismatch/);
});
test('runtime fetch is invoked with the global receiver required by Workers',async()=>{
  const c=new ExchangeClient('okx',OKX,{now:()=>NOW,fetch:async function(url,options){
    assert.equal(this,globalThis);assert.equal(options.headers['User-Agent'],'XHY-Terminal/1.0');return ok([{ts:String(NOW)}]);
  }});
  await c.syncTime();
});

test('read only exchange permissions are verified before account access',()=>{
  assert.deepEqual(validateOKXPermissions([{perm:'read_only'}]),{verified:true,read_only:true});
  assert.throws(()=>validateOKXPermissions([{perm:'read_only,trade'}]),/read_only_required/);
  assert.throws(()=>validateOKXPermissions([{}]),/permissions_unverified/);
  assert.throws(()=>validateBinancePermissions({enableReading:true,enableWithdrawals:true}),/read_only_required/);
  assert.throws(()=>validateBinancePermissions({enableReading:true,enableSpotAndMarginTrading:true}),/read_only_required/);
});
test('credential configuration is authenticated encrypted data and wrong master cannot decrypt',async()=>{
  const secret='fixture-config-encryption-key-123456789';const value=await encryptConfiguration(OKX,secret);
  assert.equal(JSON.stringify(value).includes(OKX.api_key),false);assert.deepEqual(await decryptConfiguration(value,secret),OKX);
  await assert.rejects(()=>decryptConfiguration(value,secret+'x'),/configuration_unavailable/);
});
test('OKX signs exactly the fixed GET path and rejects arbitrary exchange routes',async()=>{
  let captured;
  const c=new ExchangeClient('okx',OKX,{now:()=>NOW,fetch:async(url,options)=>{captured={url,options};return ok([{perm:'read_only'}]);}});
  await c.get('/api/v5/account/config');
  const stamp=new Date(NOW).toISOString(),sign=createHmac('sha256',OKX.secret_key).update(stamp+'GET/api/v5/account/config').digest('base64');
  assert.equal(captured.options.headers['OK-ACCESS-SIGN'],sign);assert.equal(captured.options.method,'GET');assert.equal(captured.options.redirect,'manual');
  await assert.rejects(()=>c.get('/api/v5/trade/order'),/route_rejected/);
  await assert.rejects(()=>c.get('/api/v5/account/config',{redirect:'https://evil.invalid'}),/route_rejected/);
});
test('public market requests do not transmit exchange credentials and provider bodies stay private',async()=>{
  const calls=[];const c=new ExchangeClient('okx',OKX,{fetch:async(url,options)=>{calls.push(options);return new Response(JSON.stringify({code:'50110',msg:'sensitive-provider-body'}),{status:403});}});
  await assert.rejects(()=>c.get('/api/v5/market/ticker',{instId:'BTC-USDT'},false),error=>error.code==='ip_restricted'&&!error.message.includes('sensitive'));
  assert.equal(calls[0].headers['OK-ACCESS-KEY'],undefined);
});
test('binance wallet BTC-equivalent is never counted as actual BTC holdings',()=>{
  const result=normalizeBinance([{walletName:'Spot',activate:true,balance:'.1',assetBalances:[{asset:'USDT',free:'12',locked:'0',freeze:'0',withdrawing:'0',btcValuation:'.1'}]}],'100',NOW);
  assert.equal(result.assets[0].ccy,'USDT');assert.equal(result.assets[0].quantity,'12');assert.equal(result.assets[0].usd_value,'10');
});
test('portfolio excludes only after coin aggregation and keeps unknown valuation unknown',()=>{
  const p=aggregatePortfolio([{ccy:'BTC',quantity:'.02',usd_value:'2',location:'okx'},{ccy:'BTC',quantity:'.04',usd_value:'4',location:'offline'},{ccy:'MISSING',quantity:'1',usd_value:null,location:'binance'}],[{id:'okx',status:'connected'}],'100',{rate:'7',date:'2026-10-26'},NOW,{});
  assert.equal(p.assets.length,1);assert.equal(p.total_usd,'6');assert.equal(p.total_cny,'42');assert.equal(p.complete,false);assert.deepEqual(p.unpriced_currencies,['MISSING']);
});

class FakeDB {
  constructor(){this.kv=new Map();this.trades=new Map();this.failBatch=false;}
  prepare(sql){const db=this;return {sql,args:[],bind(...args){this.args=args;return this;},async first(){const r=db.kv.get(this.args[0]);return r?structuredClone(r):null;},async all(){let rows=[...db.trades.values()];if(sql.includes('WHERE at_ms>='))rows=rows.filter(r=>r.at_ms>=this.args[0]);rows.sort((a,b)=>a.at_ms-b.at_ms||(BigInt(a.bill_id)<BigInt(b.bill_id)?-1:BigInt(a.bill_id)>BigInt(b.bill_id)?1:0));return {results:structuredClone(rows)};},async run(){
    if(sql.includes("VALUES('sync_lock'")){const old=db.kv.get('sync_lock');if(old&&old.updated_ms>=this.args[1])return {meta:{changes:0}};db.kv.set('sync_lock',{value:'true',updated_ms:this.args[0]});return {meta:{changes:1}};}
    if(sql.startsWith('INSERT INTO finance_kv')){db.kv.set(this.args[0],{value:this.args[1],updated_ms:this.args[2]});return {meta:{changes:1}};}
    if(sql.startsWith('INSERT INTO finance_trades')){if(db.trades.has(this.args[0]))throw new Error('duplicate');db.trades.set(this.args[0],{id:this.args[0],bill_id:this.args[1],at_ms:this.args[2],record_json:this.args[3]});return {meta:{changes:1}};}
    throw new Error('unhandled db statement');
  }};}
  async batch(statements){if(this.failBatch)throw new Error('storage failure');const before={kv:structuredClone(this.kv),trades:structuredClone(this.trades)};try{const out=[];for(const s of statements)out.push(await s.run());return out;}catch(error){this.kv=before.kv;this.trades=before.trades;throw error;}}
  set(k,v){this.kv.set(k,{value:JSON.stringify(v),updated_ms:NOW});}
  get(k){const r=this.kv.get(k);return r?JSON.parse(r.value):null;}
}
async function fixture(){
  const DB=new FakeDB(),account=await connectionIdentity(OKX);
  const env={DB,OKX_API_KEY:OKX.api_key,OKX_SECRET_KEY:OKX.secret_key,OKX_PASSPHRASE:OKX.passphrase,BINANCE_API_KEY:KEY,BINANCE_SECRET_KEY:SECRET,WALLET_ADDRESS:ADDRESS,CONFIG_ENCRYPTION_KEY:'fixture-encryption-key-which-is-not-a-real-secret'};
  DB.set('cost_meta',{identity:account,complete:true,coverage_start_ms:NOW-86400000,as_of_ms:NOW-300000});DB.set('cost_book',buildCostBook(original));DB.set('policy',{received_btc:'0',verified_nonspot_adjustment_btc:'0',verified_at:iso(NOW)});
  DB.set('okx',{configured:true,connection_id:account.slice(0,24),status:'connected',last_success_at:iso(NOW),assets:[],summary:{}});
  DB.set('historical_rates',{});
  for(const r of original)DB.trades.set(r.id,{id:r.id,bill_id:r.bill_id,at_ms:r.at_ms,record_json:JSON.stringify(r)});
  const calls=[];let unsafe=false;
  async function fetcher(value,options={}){
    const u=new URL(value);calls.push({url:u,options});assert.equal(options.method,'GET');
    if(u.hostname==='www.okx.com'){
      if(u.pathname==='/api/v5/public/time')return ok([{ts:String(NOW)}]);
      if(u.pathname==='/api/v5/account/config')return ok([{perm:unsafe?'read_only,trade':'read_only'}]);
      if(u.pathname==='/api/v5/account/balance')return ok([{totalEq:'120',details:[{ccy:'BTC',cashBal:'1',eq:'1',liab:'0',availBal:'1'}]}]);
      if(u.pathname==='/api/v5/asset/balances')return ok([]);
      if(u.pathname==='/api/v5/market/tickers')return ok([{instId:'BTC-USDT',last:'120',ts:String(NOW)}]);
      if(u.pathname==='/api/v5/market/index-tickers')return ok([{instId:'BTC-USD',idxPx:'120',ts:String(NOW)}]);
      if(u.pathname==='/api/v5/account/bills-archive')return ok(bills());
    }
    if(u.hostname==='api-gcp.binance.com'){
      if(u.pathname==='/api/v3/time')return new Response(JSON.stringify({serverTime:NOW}));
      if(u.pathname==='/sapi/v1/account/apiRestrictions')return new Response(JSON.stringify({enableReading:true,enableWithdrawals:false,enableSpotAndMarginTrading:false}));
      if(u.pathname==='/sapi/v1/asset/wallet/balance')return new Response(JSON.stringify([{walletName:'Spot',activate:false,balance:'0',assetBalances:[]}]));
    }
    if(u.hostname==='blockstream.info')return new Response(JSON.stringify({address:ADDRESS,chain_stats:{funded_txo_sum:50000000,spent_txo_sum:0,tx_count:1}}));
    if(u.hostname==='api.frankfurter.dev')return new Response(JSON.stringify([{base:'USD',quote:'CNY',date:'2026-10-26',rate:7.2}]));
    throw new Error('unexpected request '+u.hostname+u.pathname);
  }
  return {env,DB,account,fetcher,calls,setUnsafe:value=>{unsafe=value;}};
}
test('scheduled finance sync ingests DCA once, persists cost and serves all existing UI routes',async()=>{
  const f=await fixture(),result=await syncFinance(f.env,{fetch:f.fetcher,now:()=>NOW,force:true});assert.equal(result.ok,true);
  const p=f.DB.get('btc_pnl');assert.equal(p.status,'fresh');assert.equal(p.metrics.remaining_cost,'160');assert.equal(p.metrics.unrealized_net,'20');assert.equal(p.metrics.holdings_btc,'1.5');
  assert.equal(f.DB.trades.size,3);assert.equal(f.DB.get('btc_cost').today.buy_count,1);
  for(const path of ['/api/wallet/okx','/api/wallet/portfolio','/api/wallet/combined','/api/wallet/btc-cost','/api/wallet/btc-pnl']){
    const r=await handleFinance(new Request('https://x.pages.dev'+path),f.env,{});assert.equal(r.status,200,path);const body=await r.json();assert.equal(JSON.stringify(body).includes(OKX.secret_key),false);assert.equal(r.headers.get('cache-control'),'no-store');
  }
  f.DB.kv.delete('sync_lock');await syncFinance(f.env,{fetch:f.fetcher,now:()=>NOW,force:true});assert.equal(f.DB.trades.size,3);assert.equal(f.DB.get('cost_book').cost,'160');
});
test('a non-read-only key fails before balance and leaves the verified book intact',async()=>{
  const f=await fixture();f.setUnsafe(true);const result=await syncFinance(f.env,{fetch:f.fetcher,now:()=>NOW,force:true});assert.equal(result.ok,false);assert.equal(result.code,'read_only_required');assert.equal(f.calls.some(r=>r.url.pathname.endsWith('/balance')),false);assert.equal(f.DB.get('cost_book').cost,'100');
});

test('a fresh DCA and balance sync preserve the last verified price-change period without presenting it as recalculated',async()=>{
  const f=await fixture(),end=NOW-86400000;
  f.DB.set('combined',{history:[],pnl:{week:{btc:null,usd:'12.34567890123456789',cny:'88.88888888888888888',start_at:iso(end-7*86400000),end_at:iso(end),reason:''}}});
  const synced=await syncFinance(f.env,{fetch:f.fetcher,now:()=>NOW,force:true});assert.equal(synced.ok,true);
  const response=await handleFinance(new Request('https://x.pages.dev/api/wallet/combined'),f.env,{}),view=await response.json();
  assert.equal(view.pnl.week.usd,'12.34567890123456789');assert.equal(view.pnl.week.cny,'88.88888888888888888');
  assert.equal(view.pnl.week.end_at,iso(end));assert.equal(view.pnl.week.as_of,iso(end));
  assert.equal(view.pnl.week.status,'stale');assert.match(view.pnl.week.reason,/历史核算截至.*后续流水待核对/);
  assert.equal(view.pnl.today.usd,null);assert.equal(view.pnl.today.end_at,null);
  assert.equal(view.lifetime_pnl.status,'fresh');assert.equal(view.lifetime_pnl.metrics.remaining_cost,'160');
});
test('provider/network failure retains cache with explicit stale state',async()=>{
  const f=await fixture();await syncFinance(f.env,{fetch:f.fetcher,now:()=>NOW,force:true});f.DB.kv.delete('sync_lock');
  const result=await syncFinance(f.env,{fetch:async()=>{throw new Error('private-provider-internals');},now:()=>NOW,force:true});assert.equal(result.ok,false);
  const r=await handleFinance(new Request('https://x.pages.dev/api/wallet/btc-pnl'),f.env,{}),p=await r.json();assert.equal(p.status,'stale');assert.equal(p.metrics.unrealized_net,'20');assert.equal(JSON.stringify(p).includes('private-provider-internals'),false);
});
test('account replacement cannot reveal the previous account cost or holdings cache',async()=>{
  const f=await fixture();await syncFinance(f.env,{fetch:f.fetcher,now:()=>NOW,force:true});f.env.OKX_API_KEY='different-fixture-key';
  const p=await (await handleFinance(new Request('https://x.pages.dev/api/wallet/btc-pnl'),f.env,{})).json();assert.deepEqual(p.metrics,{});
  const c=await (await handleFinance(new Request('https://x.pages.dev/api/wallet/combined'),f.env,{})).json();assert.equal(c.totals.btc,null);assert.deepEqual(c.history,[]);
});
test('mutation/path/query boundaries reject unsupported operations without network calls',async()=>{
  const f=await fixture();
  assert.equal((await handleFinance(new Request('https://x.pages.dev/api/wallet/btc-pnl',{method:'POST'}),f.env,{})).status,405);
  assert.equal((await handleFinance(new Request('https://x.pages.dev/api/wallet/okx?raw=1'),f.env,{})).status,400);
  assert.equal((await handleFinance(new Request('https://x.pages.dev/api/wallet/okx/config',{method:'POST',body:'{}'}),f.env,{})).status,403);
  assert.equal((await handleFinance(new Request('https://x.pages.dev/api/wallet/proxy?resource=address&address=evil'),f.env,{})).status,400);
  assert.equal(await handleFinance(new Request('https://x.pages.dev/api/not-a-wallet'),f.env,{}),null);
});
