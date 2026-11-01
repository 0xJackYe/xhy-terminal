import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {testDatabase} from './auth-mail-fixture.mjs';
import {FINANCE_SCHEMA_SQL,syncFinance} from '../finance.mjs';
import {buildCostBook,iso,dec} from '../cost-book.mjs';
import {buildRemainingCapital} from '../annualized-math.mjs';
import {connectionIdentity,ExchangeClient} from '../exchange.mjs';
import {buildAnnualizedResponse} from '../annualized.mjs';
import {normalizeSpotTrade,normalizeConvert,binanceBillId,BINANCE_SPOT_MARKETS} from '../binance-trades.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const NOW=Date.parse('2026-10-28T04:00:00+08:00'),DAY=86400000,MIN=60000;
const ADDRESS='bc1q'+'q'.repeat(30);
const [USDT,USDC]=BINANCE_SPOT_MARKETS;
const minute=at=>Math.floor(at/MIN)*MIN;
const ok=rows=>Response.json({code:'0',data:rows});
const fill=(id,at,extra={})=>({symbol:'BTCUSDT',id,orderId:id+1000,price:'120',qty:'0.05',quoteQty:'6',commission:'0.00005',commissionAsset:'BTC',time:at,isBuyer:true,isMaker:false,isBestMatch:true,...extra});

test('Binance fills become cost-book trades with every fee in the cost and BTC net of BTC fees',()=>{
  const at=NOW-3*3600000;
  const btcFee=normalizeSpotTrade(fill(7,at),USDT);
  assert.deepEqual([btcFee.side,btcFee.btc_gross,btcFee.btc_net,btcFee.fee_btc,btcFee.quote_amount,btcFee.quote_ccy],['buy','0.05','0.04995','-0.00005','6','USDT']);
  assert.equal(btcFee.id,'binance:BTCUSDT:7');assert.equal(btcFee.venue,'binance');
  const usdtFee=normalizeSpotTrade(fill(8,at,{commission:'0.006',commissionAsset:'USDT'}),USDT);
  assert.deepEqual([usdtFee.btc_net,usdtFee.fee_quote,usdtFee.quote_amount],['0.05','-0.006','6.006']);
  const sale=normalizeSpotTrade(fill(9,at,{isBuyer:false,commission:'0.006',commissionAsset:'USDT'}),USDT);
  assert.deepEqual([sale.side,sale.btc_net,sale.quote_amount],['sell','-0.05','5.994']);
  const rates={['USDC:'+minute(at)]:{close:'0.999'},['BNB:'+minute(at)]:{close:'600'}};
  const bnb=normalizeSpotTrade(fill(10,at,{symbol:'BTCUSDC',quoteQty:'1.2',qty:'0.01',commission:'0.001',commissionAsset:'BNB'}),USDC,rates);
  assert.equal(bnb.quote_ccy,'USDC');assert.equal(bnb.fee_asset,'BNB');assert.equal(dec(bnb.quote_amount).sub('1.2').toFixed(6),'0.600601');
  assert.throws(()=>normalizeSpotTrade(fill(11,at,{symbol:'BTCUSDC',commissionAsset:'BNB',commission:'0.001'}),USDC,{}),/historical_rate_missing/);
  for(const bad of [{qty:'0'},{price:'-1'},{isBuyer:'yes'},{id:'x'},{symbol:'ETHUSDT'},{time:5}])assert.throws(()=>normalizeSpotTrade(fill(12,at,bad),USDT),error=>error.code==='invalid_response');
});

test('Binance Convert orders with BTC become trades; other or unfinished orders are skipped; ids stay exact',()=>{
  const at=NOW-30*DAY;
  const buy=normalizeConvert({quoteId:'q',orderId:'940708407462087195',orderStatus:'SUCCESS',fromAsset:'USDT',fromAmount:'12',toAsset:'BTC',toAmount:'0.1',createTime:at});
  assert.deepEqual([buy.id,buy.side,buy.btc_net,buy.quote_amount,buy.price,buy.inst_id],['binance-convert:940708407462087195','buy','0.1','12','120','BTC-USDT-CONVERT']);
  assert.equal(buy.bill_id,binanceBillId('2','00','940708407462087195','1'));assert.equal(buy.bill_id.length,25);
  const sale=normalizeConvert({orderId:'5',orderStatus:'SUCCESS',fromAsset:'BTC',fromAmount:'0.01',toAsset:'USDC',toAmount:'1.19',createTime:at},{['USDC:'+minute(at)]:{close:'1.001'}});
  assert.deepEqual([sale.side,sale.btc_net,sale.quote_ccy],['sell','-0.01','USDC']);
  assert.equal(normalizeConvert({orderId:'6',orderStatus:'SUCCESS',fromAsset:'ETH',fromAmount:'1',toAsset:'USDT',toAmount:'2000',createTime:at}),null);
  assert.equal(normalizeConvert({orderId:'7',orderStatus:'PROCESS',fromAsset:'USDT',fromAmount:'1',toAsset:'BTC',toAmount:'0.00001',createTime:at}),null);
  // Binance ids live in a 25-digit range apart from OKX bill ids.
  assert.match(binanceBillId('1','01','7','1'),/^71010{19}71$/);assert.notEqual(binanceBillId('1','01','7','1'),binanceBillId('1','02','7','1'));
});

test('large Binance ids parse exactly and history routes accept only BTC stablecoin reads',async()=>{
  const calls=[];const client=new ExchangeClient('binance',{api_key:'A'.repeat(64),secret_key:'B'.repeat(64)},{now:()=>NOW,fetch:async url=>{calls.push(new URL(url));return new Response('{"list":[{"orderId":940708407462087195,"createTime":1}],"moreData":false}');}});
  const body=await client.get('/sapi/v1/convert/tradeFlow',{startTime:NOW-DAY,endTime:NOW,limit:1000,recvWindow:5000});
  assert.equal(body.list[0].orderId,'940708407462087195');assert.equal(body.list[0].createTime,1);
  await client.get('/api/v3/myTrades',{symbol:'BTCUSDT',fromId:0,limit:1000,recvWindow:5000});
  await client.get('/api/v3/klines',{symbol:'BNBUSDT',interval:'1m',startTime:minute(NOW),limit:1},false);
  for(const attempt of [()=>client.get('/api/v3/myTrades',{symbol:'ETHUSDT',fromId:0}),()=>client.get('/api/v3/myTrades',{symbol:'BTCUSDT',limit:5000}),()=>client.get('/api/v3/klines',{symbol:'BTCUSDT',interval:'1d',startTime:0,limit:1},false),()=>client.get('/api/v3/order',{symbol:'BTCUSDT'}),()=>client.get('/sapi/v1/convert/tradeFlow',{startTime:'x',endTime:NOW})])
    await assert.rejects(attempt,error=>error.code==='route_rejected');
  assert.equal(calls.length,3);assert.equal(calls[2].searchParams.get('signature'),null);
});

function trade(id,side,qty,cash,at){return {id:`BTC-USDT:${id}:${100+id}`,bill_id:String(id*2),counter_bill_id:String(id*2+1),at_ms:at,side,inst_id:'BTC-USDT',trade_id:String(id),order_id:String(100+id),price:'100',btc_gross:String(Math.abs(Number(qty))),btc_net:qty,fee_btc:'0',fee_quote:'0',quote_ccy:'USDT',quote_gross:cash,quote_amount:cash,original_price:'100'};}
async function fixture(t,{fills=null,converts=null,binanceBTC='0.15995'}={}){
  const {DB,sqlite}=testDatabase(FINANCE_SCHEMA_SQL);t.after(()=>sqlite.close());
  const env={DB,OKX_API_KEY:'fixture-key',OKX_SECRET_KEY:'fixture-secret',OKX_PASSPHRASE:'fixture-pass',BINANCE_API_KEY:'A'.repeat(64),BINANCE_SECRET_KEY:'B'.repeat(64),WALLET_ADDRESS:ADDRESS};
  const account=await connectionIdentity({api_key:env.OKX_API_KEY,secret_key:env.OKX_SECRET_KEY});
  const records=[trade(1,'buy','1','100',NOW-400*DAY),trade(2,'sell','-0.5','50',NOW-DAY)];
  const put=async(key,value)=>DB.prepare('INSERT OR REPLACE INTO finance_kv(key,value,updated_ms) VALUES(?,?,?)').bind(key,JSON.stringify(value),NOW).run();
  const get=async key=>{const row=await DB.prepare('SELECT value FROM finance_kv WHERE key=?').bind(key).first();return row?JSON.parse(row.value):null;};
  await put('cost_book',buildCostBook(records));await put('annualized_capital',{...buildRemainingCapital(records),identity:account,seed_epoch:'fixture-seed'});
  await put('cost_meta',{identity:account,complete:true,coverage_start_ms:records[0].at_ms,as_of_ms:NOW-60000});
  await put('historical_rates',{});await put('policy',{received_btc:'0',verified_nonspot_adjustment_btc:'0'});await put('annualized_year_prices',{});
  for(const r of records)await DB.prepare('INSERT INTO finance_trades(id,bill_id,at_ms,record_json) VALUES(?,?,?,?)').bind(r.id,r.bill_id,r.at_ms,JSON.stringify(r)).run();
  const bills=[{billId:'6',tradeId:'3',ordId:'103',instType:'SPOT',instId:'BTC-USDT',subType:'1',ccy:'BTC',sz:'0.2',px:'100',fee:'0',balChg:'0.2',ts:String(NOW-1000)},{billId:'7',tradeId:'3',ordId:'103',instType:'SPOT',instId:'BTC-USDT',subType:'2',ccy:'USDT',sz:'20',px:'100',fee:'0',balChg:'-20',ts:String(NOW-1000)}];
  const spot={BTCUSDT:fills?.BTCUSDT??[fill(7,NOW-3*3600000)],BTCUSDC:fills?.BTCUSDC??[fill(10,NOW-2*3600000,{symbol:'BTCUSDC',qty:'0.01',quoteQty:'1.2',commission:'0.001',commissionAsset:'BNB'})],BTCFDUSD:[]};
  const orders=converts??[{quoteId:'q1',orderId:'940708407462087195',orderStatus:'SUCCESS',fromAsset:'USDT',fromAmount:'12',toAsset:'BTC',toAmount:'0.1',createTime:NOW-30*DAY},{orderId:'2',orderStatus:'SUCCESS',fromAsset:'ETH',fromAmount:'1',toAsset:'USDT',toAmount:'2000',createTime:NOW-20*DAY},{orderId:'3',orderStatus:'FAIL',fromAsset:'USDT',fromAmount:'5',toAsset:'BTC',toAmount:'0.04',createTime:NOW-10*DAY}];
  const audit=[];
  const fetcher=async(address,options)=>{
    const u=new URL(address);audit.push({path:u.pathname,params:Object.fromEntries(u.searchParams),method:options.method});
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
      const q=u.searchParams;
      if(u.pathname==='/api/v3/time')return Response.json({serverTime:NOW});
      if(u.pathname==='/sapi/v1/account/apiRestrictions')return Response.json({enableReading:true,enableWithdrawals:false,enableSpotAndMarginTrading:false});
      if(u.pathname==='/sapi/v1/asset/wallet/balance')return Response.json([{walletName:'Spot',activate:true,balance:binanceBTC,assetBalances:[{asset:'BTC',free:binanceBTC,locked:'0',freeze:'0',withdrawing:'0',btcValuation:binanceBTC}]}]);
      if(u.pathname==='/api/v3/myTrades')return Response.json(spot[q.get('symbol')].filter(r=>r.id>=Number(q.get('fromId'))));
      if(u.pathname==='/sapi/v1/convert/tradeFlow'){
        const from=Number(q.get('startTime')),to=Number(q.get('endTime'));assert.ok(to-from<30*DAY,'Convert windows stay within 30 days');
        // Raw JSON keeps the large order id as a number, as Binance sends it.
        const list=orders.filter(o=>o.createTime>=from&&o.createTime<=to).map(o=>JSON.stringify(o).replace(/"orderId":"(\d+)"/,'"orderId":$1'));
        return new Response('{"list":['+list.join(',')+'],"startTime":'+from+',"endTime":'+to+',"limit":1000,"moreData":false}');
      }
      if(u.pathname==='/api/v3/klines'){const start=Number(q.get('startTime')),close={USDCUSDT:'0.999',BNBUSDT:'600'}[q.get('symbol')];return Response.json([[start,close,close,close,close,'1',start+MIN-1,'1',1,'1','1','0']]);}
    }
    if(u.hostname==='blockstream.info')return Response.json({address:ADDRESS,chain_stats:{funded_txo_sum:50000000,spent_txo_sum:0,tx_count:1}});
    if(u.hostname==='api.frankfurter.dev')return Response.json([{base:'USD',quote:'CNY',date:'2026-10-27',rate:7}]);
    throw new Error('Unexpected fixture endpoint '+u.pathname);
  };
  const run=async()=>{await DB.prepare("DELETE FROM finance_kv WHERE key='sync_lock'").run();const before=audit.length;const result=await syncFinance(env,{fetch:fetcher,now:()=>NOW,force:true});return {result,calls:audit.slice(before)};};
  return {env,DB,put,get,account,run,audit};
}
const historyCalls=calls=>calls.filter(c=>['/api/v3/myTrades','/sapi/v1/convert/tradeFlow','/api/v3/klines'].includes(c.path));

test('Binance spot, BNB-fee and Convert purchases join the cost book, P&L and dated capital once fully imported',async t=>{
  const f=await fixture(t);
  const first=await f.run();assert.equal(first.result.ok,true);
  assert.ok(historyCalls(first.calls).length<=12,'one run stays within its request budget');
  assert.ok(first.calls.every(c=>c.method==='GET'),'trade history is read with GET only');
  let meta=await f.get('binance_trades_meta');assert.equal(meta.complete,false);
  let book=await f.get('cost_book');assert.equal(book.trade_count,3);assert.equal(book.binance_included,false);assert.equal(book.excluded_binance,2);
  let pnl=await f.get('btc_pnl');assert.equal(pnl.metrics.holdings_btc,'0.7');
  assert.equal((await f.get('btc_cost')).binance_history.status,'importing');
  const second=await f.run();assert.equal(second.result.ok,true);assert.equal(second.result.binance_trades_error,null);
  meta=await f.get('binance_trades_meta');assert.equal(meta.complete,true);assert.equal(meta.record_count,3);
  book=await f.get('cost_book');assert.equal(book.trade_count,6);assert.equal(book.binance_count,3);assert.equal(book.binance_included,true);
  // 0.7 BTC from OKX + 0.04995 (BTC fee) + 0.01 (BNB fee) + 0.1 (Convert).
  assert.equal(book.inventory,'0.85995');
  const usdcCost=dec('1.2').add(dec('0.001').mul('600').div('0.999')).mul('0.999');
  // Moving average in time order: the Convert buy precedes the OKX sale of 0.5 BTC.
  const afterSale=dec('112').sub(dec('112').mul('0.5').div('1.1'));
  assert.equal(book.cost,afterSale.add('6').add(usdcCost).add('20').toFixed());
  pnl=await f.get('btc_pnl');assert.equal(pnl.metrics.holdings_btc,'0.85995');assert.equal(pnl.status,'fresh');assert.equal(pnl.reconciliation.matched,true);assert.deepEqual(pnl.venues,['okx','binance']);
  assert.equal(pnl.metrics.remaining_cost,book.cost);
  const cost=await f.get('btc_cost');assert.deepEqual(cost.venues,['okx','binance']);assert.equal(cost.binance_history.status,'included');assert.equal(cost.today.buy_count,3);assert.equal(cost.today.buy_spent_usdt,dec('26').add(usdcCost).toFixed());
  // Net invested across both exchanges and all quote currencies, in USDT.
  assert.equal(cost.summary.net_invested_usdt,dec('70').add('6').add(usdcCost).add('12').toFixed());
  const ids=(await f.DB.prepare("SELECT id FROM finance_trades WHERE id LIKE 'binance%' ORDER BY at_ms").all()).results.map(r=>r.id);
  assert.deepEqual(ids,['binance-convert:940708407462087195','binance:BTCUSDT:7','binance:BTCUSDC:10']);
  const rates=await f.get('historical_rates');assert.equal(Object.values(rates).filter(r=>r.source==='Binance/1m-close').length,2);
  const capital=await f.get('annualized_capital');assert.equal(capital.trade_count,6);assert.equal(capital.cost,book.cost);assert.equal(capital.seed_epoch,'fixture-seed');
  const view=await buildAnnualizedResponse(f.env,{}, {now:NOW});assert.equal(view.btc.remaining_cost,book.cost);assert.match(view.btc.scope,/币安/);
  // A later run reads only new fills (none) and leaves the book unchanged.
  const third=await f.run();assert.equal(third.result.ok,true);assert.deepEqual(await f.get('cost_book'),book);
});

test('a different Binance account replaces the previous account rows instead of mixing them',async t=>{
  const f=await fixture(t);await f.run();await f.run();assert.equal((await f.get('cost_book')).binance_included,true);
  f.env.BINANCE_API_KEY='C'.repeat(64);
  await f.run();
  const meta=await f.get('binance_trades_meta');assert.equal(meta.identity,await connectionIdentity({api_key:'C'.repeat(64),secret_key:'B'.repeat(64)}));
  const book=await f.get('cost_book');assert.equal(book.binance_included,false);assert.equal(book.trade_count,3);
  assert.equal((await f.get('btc_pnl')).metrics.holdings_btc,'0.7');
});

test('Binance sales without recorded purchases never break the verified OKX book',async t=>{
  const f=await fixture(t,{fills:{BTCUSDT:[fill(7,NOW-2*3600000,{isBuyer:false,qty:'5',quoteQty:'600',commission:'0.6',commissionAsset:'USDT'})],BTCUSDC:[]},converts:[]});
  await f.run();const second=await f.run();assert.equal(second.result.ok,true);assert.equal(second.result.binance_trades_error,'binance_history_invalid');
  const book=await f.get('cost_book');assert.equal(book.trade_count,3);assert.equal(book.binance_included,false);assert.equal(book.inventory,'0.7');
  const cost=await f.get('btc_cost');assert.equal(cost.binance_history.status,'error');assert.match(cost.binance_history.error,/无法衔接/);
  assert.equal((await f.get('btc_pnl')).metrics.holdings_btc,'0.7');
  // The failed combination is not retried every minute until a trade changes.
  const third=await f.run();assert.equal(third.result.ok,true);assert.deepEqual(await f.get('cost_book'),book);
  assert.equal((await f.get('btc_cost')).binance_history.status,'error','the reason stays visible on later runs');
});
