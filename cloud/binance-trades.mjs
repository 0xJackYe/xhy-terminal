/** Binance spot and Convert BTC trades for the shared cost book. Read-only:
 * the client only reaches the approved history, kline and balance routes. */
import {D,dec,txt,iso,validateTrade} from './cost-book.mjs';
import {FinanceError} from './exchange.mjs';

// BTC bought or sold against a USD stablecoin on Binance spot. Each symbol is
// read from trade id 0, so its full account history is covered.
export const BINANCE_SPOT_MARKETS=[{symbol:'BTCUSDT',quote:'USDT',code:'01'},{symbol:'BTCUSDC',quote:'USDC',code:'02'},{symbol:'BTCFDUSD',quote:'FDUSD',code:'03'}];
export const BINANCE_TRADES_META='binance_trades_meta';
const MINUTE=60000,DAY=86400000,CONVERT_WINDOW=30*DAY-1,CONVERT_OVERLAP=DAY;
const SPOT_INTERVAL=5*MINUTE,CONVERT_INTERVAL=30*MINUTE;
// Workers on the free plan allow 50 outbound requests per invocation; the
// trade import uses at most this many per run and resumes on the next one.
const REQUEST_BUDGET=12;
// A slow provider pauses the import (it resumes next run) well inside the
// one-minute sync lease, so two syncs never overlap.
const TIME_BUDGET=20000;
const ASSET=/^[A-Z0-9]{1,20}$/;
const invalid=()=>new FinanceError('invalid_response');

function digits(value){
  const text=typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?String(value):typeof value==='string'&&/^\d{1,24}$/.test(value)?value:null;
  if(text===null)throw invalid();
  return text.replace(/^0+(?=\d)/,'');
}
// Binance ids get their own 25-digit range so they can never collide with
// OKX bill ids in the shared trade table (kind 1 = spot, 2 = Convert).
export function binanceBillId(kind,code,id,leg){return '7'+kind+code+digits(id).padStart(20,'0')+leg;}

function knownRate(rates,ccy,at){
  if(ccy==='USDT')return new D(1);
  const value=rates[ccy+':'+Math.floor(at/MINUTE)*MINUTE];
  const close=value&&typeof value==='object'?value.close:value;
  if(close==null||!dec(close).gt(0))throw new Error('historical_rate_missing');
  return dec(close);
}
// A confirmed (already closed) Binance 1-minute close in USDT, shared with the
// OKX rates under the same CCY:minute key the cost book reads.
export async function binanceMinuteRate(client,ccy,at,rates,serverNow){
  if(ccy==='USDT')return new D(1);
  const minute=Math.floor(at/MINUTE)*MINUTE;
  try{return knownRate(rates,ccy,at);}catch{/* fetch below */}
  if(!ASSET.test(ccy))throw new Error('historical_rate_missing');
  const rows=await client.get('/api/v3/klines',{symbol:ccy+'USDT',interval:'1m',startTime:minute,limit:1},false);
  const row=Array.isArray(rows)&&rows.length===1&&Array.isArray(rows[0])?rows[0]:null;
  if(!row||Number(row[0])!==minute||!(Number(row[6])<serverNow))throw new Error('historical_rate_missing');
  const low=dec(row[3]),high=dec(row[2]),close=dec(row[4]);
  if(!low.gt(0)||close.lt(low)||close.gt(high))throw new Error('historical_rate_missing');
  rates[ccy+':'+minute]={currency:ccy,minute_ms:minute,close:txt(close),low:txt(low),high:txt(high),source:'Binance/1m-close'};
  return close;
}

// Currencies whose minute rate a spot fill needs: a non-USDT quote (for the
// cost book) and a fee paid in a third asset such as BNB (valued into cost).
export function spotRateNeeds(raw,market){
  const needs=new Set();if(market.quote!=='USDT')needs.add(market.quote);
  const fee=String(raw?.commissionAsset||'');
  if(raw&&dec(raw.commission||'0').gt(0)&&fee!=='BTC'&&fee!==market.quote&&fee!=='USDT')needs.add(fee);
  return [...needs];
}
export function normalizeSpotTrade(raw,market,rates={}){
  if(!raw||typeof raw!=='object'||raw.symbol!=null&&raw.symbol!==market.symbol||typeof raw.isBuyer!=='boolean')throw invalid();
  const id=digits(raw.id),order=digits(raw.orderId),at=Number(raw.time);
  if(!Number.isSafeInteger(at)||at<1230768000000)throw invalid();
  let qty,quoteQty,price,fee;try{qty=dec(raw.qty);quoteQty=dec(raw.quoteQty);price=dec(raw.price);fee=dec(raw.commission??'0');}catch{throw invalid();}
  if(!qty.gt(0)||!quoteQty.gt(0)||!price.gt(0)||fee.lt(0))throw invalid();
  const buy=raw.isBuyer,feeAsset=String(raw.commissionAsset||'');
  let feeBTC=new D(0),feeQuote=new D(0),feeOther=new D(0);
  if(fee.gt(0)){
    if(feeAsset==='BTC')feeBTC=fee;
    else if(feeAsset===market.quote)feeQuote=fee;
    else{if(!ASSET.test(feeAsset))throw invalid();feeOther=fee.mul(knownRate(rates,feeAsset,at)).div(knownRate(rates,market.quote,at));}
  }
  if(market.quote!=='USDT')knownRate(rates,market.quote,at);
  const btcNet=qty.mul(buy?1:-1).sub(feeBTC),cash=buy?quoteQty.add(feeQuote).add(feeOther):quoteQty.sub(feeQuote).sub(feeOther);
  if(buy&&!btcNet.gt(0)||!buy&&!btcNet.lt(0)||cash.lt(0))throw invalid();
  return validateTrade({id:'binance:'+market.symbol+':'+id,venue:'binance',source:'币安现货',at_ms:at,side:buy?'buy':'sell',inst_id:'BTC-'+market.quote,trade_id:id,order_id:order,
    bill_id:binanceBillId('1',market.code,id,'1'),counter_bill_id:binanceBillId('1',market.code,id,'2'),price:txt(price),btc_gross:txt(qty),btc_net:txt(btcNet),
    fee_btc:txt(feeBTC.neg()),fee_quote:txt(feeQuote.neg()),quote_ccy:market.quote,quote_gross:txt(quoteQty),quote_amount:txt(cash),original_price:txt(price),
    ...(feeOther.gt(0)?{fee_asset:feeAsset,fee_amount:txt(fee),fee_value_quote:txt(feeOther)}:{})});
}

// Convert orders where BTC is one side. The spread is inside the quoted
// amounts, so there is no separate fee. Returns null for other orders.
export function convertSide(raw){
  if(!raw||typeof raw!=='object'||raw.orderStatus!=='SUCCESS')return null;
  const from=String(raw.fromAsset||''),to=String(raw.toAsset||'');
  if((from==='BTC')===(to==='BTC'))return null;
  const other=to==='BTC'?from:to;if(!ASSET.test(other))throw invalid();
  return {buy:to==='BTC',other};
}
export function normalizeConvert(raw,rates={}){
  const side=convertSide(raw);if(!side)return null;
  const order=digits(raw.orderId),at=Number(raw.createTime);
  if(!Number.isSafeInteger(at)||at<1230768000000)throw invalid();
  let btc,cash;try{btc=dec(side.buy?raw.toAmount:raw.fromAmount);cash=dec(side.buy?raw.fromAmount:raw.toAmount);}catch{throw invalid();}
  if(!btc.gt(0)||!cash.gt(0))throw invalid();
  knownRate(rates,side.other,at);
  const price=txt(cash.div(btc));
  return validateTrade({id:'binance-convert:'+order,venue:'binance',source:'币安闪兑',at_ms:at,side:side.buy?'buy':'sell',inst_id:'BTC-'+side.other+'-CONVERT',trade_id:order,order_id:order,
    bill_id:binanceBillId('2','00',order,'1'),counter_bill_id:binanceBillId('2','00',order,'2'),price,btc_gross:txt(btc),btc_net:txt(side.buy?btc:btc.neg()),
    fee_btc:'0',fee_quote:'0',quote_ccy:side.other,quote_gross:txt(cash),quote_amount:txt(cash),original_price:price});
}

const freshMeta=(identity,coverage)=>({version:1,identity,coverage_start_ms:coverage,spot:{},convert:{checked_until_ms:null},last_spot_ms:0,last_convert_ms:0,complete:false,record_count:0,updated_ms:0});
const binanceRows="id LIKE 'binance:%' OR id LIKE 'binance-convert:%'";

/**
 * Reads new Binance BTC fills and Convert orders since the cost book's
 * coverage start and stores them next to the OKX trades. Each stream keeps a
 * cursor, so a missing minute rate or the request budget only pauses it.
 * A different Binance account (key identity) replaces the previous account's
 * Binance rows. Returns {inserted, reset, meta}.
 */
export async function syncBinanceTrades(env,client,{identity,coverageStartMs,rates,now=Date.now(),force=false}){
  if(typeof identity!=='string'||!/^[a-f0-9]{64}$/.test(identity)||!Number.isSafeInteger(coverageStartMs))throw new FinanceError('needs_history');
  const stored=await env.DB.prepare('SELECT value FROM finance_kv WHERE key=?').bind(BINANCE_TRADES_META).first();
  let meta=null;try{meta=stored?JSON.parse(stored.value):null;}catch{meta=null;}
  let reset=false;
  if(!meta||meta.version!==1||meta.identity!==identity||meta.coverage_start_ms!==coverageStartMs){
    await env.DB.prepare('DELETE FROM finance_trades WHERE '+binanceRows).run();
    meta=freshMeta(identity,coverageStartMs);reset=true;
  }
  const dueSpot=force||!meta.complete||now-meta.last_spot_ms>=SPOT_INTERVAL,dueConvert=force||!meta.complete||now-meta.last_convert_ms>=CONVERT_INTERVAL;
  if(!dueSpot&&!dueConvert&&!reset)return {inserted:0,reset,meta,skipped:true};
  let budget=REQUEST_BUDGET,paused=false;const fresh=[],serverNow=Math.floor(client.now()+client.offset),rateCount=Object.keys(rates).length,started=Date.now();
  const spent=()=>budget<=0||Date.now()-started>TIME_BUDGET;
  const call=async(path,params,authenticated=true)=>{if(spent()){paused=true;return null;}budget--;return client.get(path,params,authenticated);};
  const rate=async(ccy,at)=>{try{return knownRate(rates,ccy,at);}catch{/* fetch */}if(spent()){paused=true;throw new Error('historical_rate_missing');}budget--;return binanceMinuteRate(client,ccy,at,rates,serverNow);};
  if(dueSpot){
    let spotDone=true;
    for(const market of BINANCE_SPOT_MARKETS){
      const state={next_from_id:'0',...meta.spot[market.symbol]};
      let open=true;
      while(open){
        const rows=await call('/api/v3/myTrades',{symbol:market.symbol,fromId:state.next_from_id,limit:1000,recvWindow:5000});
        if(rows===null){spotDone=false;break;}
        if(!Array.isArray(rows)||rows.length>1000)throw invalid();
        let previous=BigInt(state.next_from_id)-1n;
        for(const raw of rows){
          const id=BigInt(digits(raw?.id));if(id<=previous)throw invalid();previous=id;
          const at=Number(raw.time);
          if(Number.isSafeInteger(at)&&at>=coverageStartMs){
            try{for(const ccy of spotRateNeeds(raw,market))await rate(ccy,at);}catch(error){if(String(error?.message)!=='historical_rate_missing')throw error;open=false;spotDone=false;break;}
            fresh.push(normalizeSpotTrade(raw,market,rates));
          }
          state.next_from_id=String(id+1n);
        }
        if(open&&rows.length<1000)open=false;
      }
      meta.spot[market.symbol]=state;
    }
    if(spotDone)meta.last_spot_ms=now;
  }
  if(dueConvert&&!paused){
    let start=meta.convert.checked_until_ms==null?coverageStartMs:Math.max(coverageStartMs,meta.convert.checked_until_ms-CONVERT_OVERLAP),convertDone=true;
    const end=serverNow;
    windows:while(start<=end){
      const queue=[[start,Math.min(start+CONVERT_WINDOW,end)]];
      while(queue.length){
        const [from,to]=queue.shift();
        const body=await call('/sapi/v1/convert/tradeFlow',{startTime:from,endTime:to,limit:1000,recvWindow:5000});
        if(body===null){convertDone=false;break windows;}
        if(!body||!Array.isArray(body.list)||body.list.length>1000)throw invalid();
        if(body.moreData===true){if(to-from<2*MINUTE)throw new FinanceError('page_limit');const mid=from+Math.floor((to-from)/2);queue.unshift([from,mid],[mid+1,to]);continue;}
        for(const raw of body.list){
          const side=convertSide(raw);if(!side)continue;
          const at=Number(raw.createTime);if(!Number.isSafeInteger(at)||at<from||at>to)throw invalid();
          if(at<coverageStartMs)continue;
          try{await rate(side.other,at);}catch(error){if(String(error?.message)!=='historical_rate_missing')throw error;convertDone=false;break windows;}
          fresh.push(normalizeConvert(raw,rates));
        }
        meta.convert.checked_until_ms=to;
      }
      start=meta.convert.checked_until_ms+1;
    }
    if(convertDone)meta.last_convert_ms=now;
  }
  // Complete once every stream has reached the present; it stays complete
  // (later reads only add new fills) until the account or coverage changes.
  meta.complete=meta.complete===true||BINANCE_SPOT_MARKETS.every(m=>meta.spot[m.symbol])&&meta.last_spot_ms>0&&meta.convert.checked_until_ms!=null&&meta.convert.checked_until_ms>=serverNow-CONVERT_INTERVAL-MINUTE;
  // Overlapping Convert windows return known orders again; ids are stable.
  const statements=fresh.map(r=>env.DB.prepare('INSERT OR IGNORE INTO finance_trades(id,bill_id,at_ms,record_json) VALUES(?,?,?,?)').bind(r.id,r.bill_id,r.at_ms,JSON.stringify(r)));
  for(let i=0;i<statements.length;i+=90)await env.DB.batch(statements.slice(i,i+90));
  const count=await env.DB.prepare('SELECT COUNT(*) AS count FROM finance_trades WHERE '+binanceRows).first();
  meta.record_count=Number(count?.count)||0;meta.updated_ms=now;meta.updated_at=iso(now);
  const save=(key,value)=>env.DB.prepare('INSERT INTO finance_kv(key,value,updated_ms) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_ms=excluded.updated_ms').bind(key,JSON.stringify(value),now);
  // Imported rows rely on these minute rates when the book is rebuilt.
  await env.DB.batch([save(BINANCE_TRADES_META,meta),...(Object.keys(rates).length!==rateCount?[save('historical_rates',rates)]:[])]);
  return {inserted:fresh.length,reset,meta};
}
