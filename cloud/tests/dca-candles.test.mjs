import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {getDCACandles,handleDCACandles,normalizeBinanceCandles,normalizeOKXCandles,DCA_CANDLES_START_MS as START,DCA_CANDLES_CACHE_KEY as KEY} from '../dca-candles.mjs';

const DAY=86400000,NOW=START+2*DAY+3600000;
const bar=(at,close='105')=>[at,'100',String(Math.max(110,Number(close))),'90',close,'12.345',at+DAY-1];
const okxBar=(at,confirm='1',close='105')=>[String(at),'100',String(Math.max(110,Number(close))),'90',close,'12.345','1200','1200',confirm];
function environment(t){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE market_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_ms INTEGER NOT NULL)');let writes=0,reads=0;
  const env={DB:{prepare(sql){return {sql,values:[],bind(...values){this.values=values;return this;},async first(){reads++;return sqlite.prepare(this.sql).get(...this.values)??null;},async run(){writes++;const result=sqlite.prepare(this.sql).run(...this.values);return {meta:{changes:Number(result.changes)}};}};}}};
  t.after(()=>sqlite.close());
  return {env,sqlite,get writes(){return writes;},get reads(){return reads;}};
}
function provider(options={}){
  const calls=[];
  const fetcher=async function(address,init){
    const url=new URL(address);calls.push({url,init});assert.equal(this,globalThis);assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');
    assert.deepEqual(Object.keys(init.headers).sort(),['Accept','User-Agent']);assert.equal('body' in init,false);
    if(options.fail||options.binanceFail&&url.origin!=='https://www.okx.com')return new Response('unavailable',{status:options.status??503});
    if(options.handler)return options.handler(url,init,calls);
    const now=options.now??NOW,today=Math.floor((now+28800000)/DAY)*DAY-28800000;
    if(url.origin==='https://www.okx.com'){
      assert.equal(url.searchParams.get('bar'),'1D');assert.equal(url.searchParams.get('instId'),'BTC-USDT');
      const cursor=Number(url.searchParams.get('after')??today+DAY),limit=Number(url.searchParams.get('limit'));
      const rows=[];for(let at=Math.min(today,cursor-DAY);at>=START&&rows.length<limit;at-=DAY)rows.push(okxBar(at,at===today?'0':'1',at===today?options.close??'105':'105'));
      return Response.json({code:'0',data:rows});
    }
    assert.ok(['https://data-api.binance.vision','https://api-gcp.binance.com'].includes(url.origin));assert.equal(url.pathname,'/api/v3/klines');assert.equal(url.searchParams.get('interval'),'1d');assert.equal(url.searchParams.get('timeZone'),'8');assert.equal(url.searchParams.get('symbol'),'BTCUSDT');
    const rows=[],limit=Number(url.searchParams.get('limit'));
    for(let at=Number(url.searchParams.get('startTime'));at<=today&&rows.length<limit;at+=DAY)rows.push(bar(at,at===today?options.close??'105':'105'));
    return Response.json(rows);
  };
  return {calls,fetcher};
}
const request=(suffix='',method='GET')=>new Request('https://terminal.example/api/wallet/btc-dca-candles'+suffix,{method});

test('full candles use Beijing day boundaries, preserve OHLC decimals and store only closed history',async t=>{
  const f=environment(t),p=provider();const result=await getDCACandles(f.env,{now:NOW,fetch:p.fetcher});
  assert.equal(result.status,'fresh');assert.equal(result.timezone,'Asia/Shanghai');assert.equal(result.source,'Binance Spot');assert.equal(result.coverage_complete,true);assert.equal(result.start_date,'2024-07-01');
  assert.deepEqual(result.candles.map(row=>row.time),['2024-07-01','2024-07-02','2024-07-03']);assert.equal(result.candles[0].volume,'12.345');assert.equal(p.calls.length,1);
  assert.equal(p.calls[0].url.searchParams.get('startTime'),String(START));assert.equal(p.calls[0].url.searchParams.get('limit'),'1000');
  const stored=JSON.parse(f.sqlite.prepare('SELECT value FROM market_kv WHERE key=?').get(KEY).value);assert.deepEqual(stored.candles.map(row=>row.time),['2024-07-01','2024-07-02']);assert.equal(f.writes,1);
});
test('fresh five-second cache coalesces concurrent requests and tail updates never rewrite the archive',async t=>{
  const f=environment(t),p=provider();
  const [a,b]=await Promise.all([getDCACandles(f.env,{now:NOW,fetch:p.fetcher}),getDCACandles(f.env,{now:NOW,fetch:p.fetcher})]);assert.deepEqual(a,b);assert.equal(p.calls.length,1);
  await getDCACandles(f.env,{now:NOW+4999,fetch:p.fetcher});assert.equal(p.calls.length,1);
  const next=provider({close:'109',now:NOW+5000});const updated=await getDCACandles(f.env,{now:NOW+5000,fetch:next.fetcher});
  assert.equal(updated.candles.at(-1).close,'109');assert.equal(next.calls.length,1);assert.equal(next.calls[0].url.searchParams.get('limit'),'2');assert.equal(f.writes,1);assert.equal(f.reads,1);
});
test('cold isolate reads the persistent closed archive and requests only current tail',async t=>{
  const f=environment(t),p=provider();await getDCACandles(f.env,{now:NOW,fetch:p.fetcher});
  // A distinct binding object represents a fresh Worker isolate on the same D1.
  const other={DB:{prepare:sql=>f.env.DB.prepare(sql)}},next=provider();const result=await getDCACandles(other,{now:NOW+5000,fetch:next.fetcher});
  assert.equal(result.coverage_complete,true);assert.equal(next.calls.length,1);assert.equal(next.calls[0].url.searchParams.get('limit'),'2');assert.equal(f.writes,1);
});
test('Binance history paginates beyond a thousand days without duplicating the boundary',async t=>{
  const f=environment(t),now=START+1002*DAY+3600000,p=provider({now});const result=await getDCACandles(f.env,{now,fetch:p.fetcher});
  assert.equal(result.candles.length,1003);assert.equal(result.coverage_complete,true);assert.equal(p.calls.length,2);
  assert.equal(p.calls[1].url.searchParams.get('startTime'),String(START+1000*DAY));assert.equal(new Set(result.candles.map(row=>row.time)).size,1003);
});
test('OKX fallback uses UTC+8 1D, backward pagination and confirmed past days',async t=>{
  const f=environment(t),now=START+602*DAY+3600000,p=provider({now,binanceFail:true});const result=await getDCACandles(f.env,{now,fetch:p.fetcher});
  assert.equal(result.source,'OKX Spot');assert.equal(result.coverage_complete,true);assert.equal(result.candles.length,603);
  const okx=p.calls.filter(row=>row.url.origin==='https://www.okx.com');assert.equal(okx.length,3);assert.equal(okx[0].url.searchParams.get('limit'),'300');assert.ok(Number(okx[1].url.searchParams.get('after'))<Number(okx[0].url.searchParams.get('after')));
});
test('outage retains dated real candles and rate limiting backs off rather than repainting live',async t=>{
  const f=environment(t),p=provider();const previous=await getDCACandles(f.env,{now:NOW,fetch:p.fetcher});
  const bad=provider({fail:true,status:429});const stale=await getDCACandles(f.env,{now:NOW+5000,fetch:bad.fetcher});assert.equal(stale.status,'stale');assert.deepEqual(stale.candles,previous.candles);assert.equal(stale.as_of,previous.as_of);assert.ok(stale.error);
  const count=bad.calls.length;await getDCACandles(f.env,{now:NOW+10000,fetch:bad.fetcher});assert.equal(bad.calls.length,count);assert.equal(f.writes,1);
});
test('a failed provider with no cache gives unavailable values, never zero-price or synthetic candles',async t=>{
  const f=environment(t),p=provider({fail:true});const result=await getDCACandles(f.env,{now:NOW,fetch:p.fetcher});assert.equal(result.status,'unavailable');assert.deepEqual(result.candles,[]);assert.equal(result.coverage_complete,false);assert.equal(result.as_of,null);assert.equal(f.writes,0);
});
test('Beijing midnight promotes only confirmed market data and appends the new live day',async t=>{
  const f=environment(t),before=START+3*DAY-1,p=provider({now:before});await getDCACandles(f.env,{now:before,fetch:p.fetcher});
  const after=START+3*DAY+1000,q=provider({now:after,close:'108'}),result=await getDCACandles(f.env,{now:after,fetch:q.fetcher});
  assert.equal(result.candles.at(-1).time,'2024-07-04');assert.equal(result.candles.at(-2).close,'105');assert.equal(result.candles.at(-1).close,'108');assert.equal(result.coverage_complete,true);assert.equal(f.writes,2);
  const saved=JSON.parse(f.sqlite.prepare('SELECT value FROM market_kv WHERE key=?').get(KEY).value);assert.equal(saved.candles.at(-1).time,'2024-07-03');
});
test('a request crossing Beijing midnight never freezes its still-open candle as closed history',async t=>{
  const f=environment(t),before=START+3*DAY-1,after=START+3*DAY+1000,p=provider({now:before});let clock=before;
  const crossed=await getDCACandles(f.env,{now:()=>clock,fetch:async(...args)=>{clock=after;return p.fetcher.call(globalThis,...args);}});
  assert.equal(crossed.status,'stale');assert.equal(crossed.coverage_complete,false);
  const saved=JSON.parse(f.sqlite.prepare('SELECT value FROM market_kv WHERE key=?').get(KEY).value);assert.equal(saved.candles.at(-1).time,'2024-07-02');
  const next=provider({now:after});const refreshed=await getDCACandles(f.env,{now:after,fetch:next.fetcher});
  assert.equal(refreshed.status,'fresh');assert.equal(refreshed.candles.at(-2).time,'2024-07-03');assert.equal(refreshed.candles.at(-1).time,'2024-07-04');
});
test('wrong day, invalid OHLC, inconsistent duplicates and unconfirmed historical candles are rejected atomically',()=>{
  assert.throws(()=>normalizeBinanceCandles([bar(START+28800000)],NOW),/day/);
  assert.throws(()=>normalizeBinanceCandles([[START,'100','90','110','105','1',START+DAY-1]],NOW),/ohlc/);
  assert.throws(()=>normalizeBinanceCandles([bar(START),bar(START,'106')],NOW),/conflicting/);
  assert.throws(()=>normalizeBinanceCandles([bar(START+3*DAY)],NOW),/day/);
  assert.throws(()=>normalizeOKXCandles({code:'0',data:[okxBar(START,'0')]},NOW),/unconfirmed/);
  assert.equal(normalizeBinanceCandles([bar(START),bar(START)],NOW).length,1);
});
test('history gaps remain explicit and are never filled with adjacent prices',async t=>{
  const f=environment(t),p=provider({handler:async url=>url.origin==='https://www.okx.com'?new Response('offline',{status:503}):Response.json([bar(START),bar(START+2*DAY)])});
  const result=await getDCACandles(f.env,{now:NOW,fetch:p.fetcher});assert.equal(result.status,'stale');assert.equal(result.coverage_complete,false);assert.deepEqual(result.candles.map(row=>row.time),['2024-07-01','2024-07-03']);assert.match(result.error,/缺口/);
});
test('invalid persistent history is replaced rather than trusted',async t=>{
  const f=environment(t);f.sqlite.prepare('INSERT INTO market_kv VALUES(?,?,?)').run(KEY,JSON.stringify({version:1,provider:'binance',candles:[{time:'2024-07-01',open:'100',high:'1',low:'200',close:'10',volume:'1'}]}),NOW);
  const result=await getDCACandles(f.env,{now:NOW,fetch:provider().fetcher});assert.equal(result.status,'fresh');assert.equal(result.candles[0].high,'110');
});
test('a missing historical provider does not prevent a true current candle from loading',async t=>{
  const f=environment(t),p=provider({handler:async url=>url.searchParams.get('limit')==='2'?Response.json([bar(START+DAY),bar(START+2*DAY)]):new Response('offline',{status:503})});
  const result=await getDCACandles(f.env,{now:NOW,fetch:p.fetcher});assert.equal(result.status,'stale');assert.equal(result.candles.at(-1).time,'2024-07-03');assert.equal(result.coverage_complete,false);
});
test('the fixed authenticated route rejects query injection and writes without calling providers',async t=>{
  const f=environment(t),p=provider();assert.equal(await handleDCACandles(new Request('https://terminal.example/api/unrelated'),f.env),null);
  assert.equal((await handleDCACandles(request('?url=https://evil.invalid'),f.env,{}, {now:NOW,fetch:p.fetcher})).status,400);
  assert.equal((await handleDCACandles(request('','POST'),f.env,{}, {now:NOW,fetch:p.fetcher})).status,405);assert.equal(p.calls.length,0);
  const response=await handleDCACandles(request(),f.env,{candleOptions:{now:NOW,fetch:p.fetcher}});assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');const body=await response.json();assert.equal(body.timezone,'Asia/Shanghai');assert.equal(body.mode,'history');
});
test('the five-second tail response sends only the last two genuine candles while preserving history coverage',async t=>{
  const f=environment(t),p=provider(),options={now:NOW,fetch:p.fetcher};
  await handleDCACandles(request(),f.env,{},options);
  const response=await handleDCACandles(request('?tail=1'),f.env,{},options),body=await response.json();
  assert.equal(body.mode,'tail');assert.equal(body.coverage_complete,true);assert.deepEqual(body.candles.map(row=>row.time),['2024-07-02','2024-07-03']);assert.equal(p.calls.length,1);
  assert.equal((await handleDCACandles(request('?tail=1&url=https://evil.invalid'),f.env,{},options)).status,400);
});
test('a cold tail request does not bootstrap or invent the unrequested full history',async t=>{
  const f=environment(t),p=provider();const body=await (await handleDCACandles(request('?tail=1'),f.env,{}, {now:NOW,fetch:p.fetcher})).json();
  assert.equal(body.mode,'tail');assert.equal(body.coverage_complete,false);assert.equal(body.candles.length,2);assert.equal(p.calls.length,1);assert.equal(p.calls[0].url.searchParams.get('limit'),'2');
});

test('partial provider history cannot discard previously cached genuine days',async t=>{
  const f=environment(t),saved={version:1,provider:'binance',as_of:new Date(NOW-10000).toISOString(),candles:normalizeBinanceCandles([bar(START)],NOW)};
  f.sqlite.prepare('INSERT INTO market_kv VALUES(?,?,?)').run(KEY,JSON.stringify(saved),NOW-10000);
  const p=provider({handler:async url=>url.origin==='https://www.okx.com'?new Response('offline',{status:503}):Response.json([bar(START+DAY),bar(START+2*DAY)])});
  const result=await getDCACandles(f.env,{now:NOW,fetch:p.fetcher});
  assert.equal(result.coverage_complete,true);assert.deepEqual(result.candles.map(row=>row.time),['2024-07-01','2024-07-02','2024-07-03']);
});

test('a slow cold isolate cannot overwrite another isolate with a shorter history archive',async t=>{
  const f=environment(t),other={DB:{prepare:sql=>f.env.DB.prepare(sql)}};
  let release,started;const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{started=resolve;});
  const slow=provider({handler:async url=>{if(url.origin==='https://www.okx.com')return new Response('offline',{status:503});started();await gate;return Response.json([bar(START+DAY),bar(START+2*DAY)]);}});
  const delayed=getDCACandles(other,{now:NOW,fetch:slow.fetcher});await ready;
  await getDCACandles(f.env,{now:NOW,fetch:provider().fetcher});release();
  const result=await delayed,saved=JSON.parse(f.sqlite.prepare('SELECT value FROM market_kv WHERE key=?').get(KEY).value);
  assert.deepEqual(saved.candles.map(row=>row.time),['2024-07-01','2024-07-02']);assert.equal(result.coverage_complete,true);
});
