/** Read-only BTC/USDT daily candles. Days begin at 00:00 Asia/Shanghai. */
import {dec,txt} from './cost-book.mjs';

export const DCA_CANDLES_START='2024-07-01';
export const DCA_CANDLES_START_MS=1719763200000;
export const DCA_CANDLES_CACHE_KEY='btc_daily_closed_v1';
const DAY=86400000,BEIJING=28800000,REFRESH_MS=5000,HISTORY_RETRY_MS=300000;
const BINANCE=['https://data-api.binance.vision','https://api-gcp.binance.com'];
const OKX='https://www.okx.com',MAX_DAYS=20000,MAX_RESPONSE=1048576;
const memories=new WeakMap();
const dayStart=now=>Math.floor((now+BEIJING)/DAY)*DAY-BEIJING;
const date=ms=>new Date(ms+BEIJING).toISOString().slice(0,10);
const nowOf=options=>typeof options.now==='function'?options.now():options.now??Date.now();
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const source=provider=>provider==='okx'?'OKX Spot':'Binance Spot';
function amount(raw,zero=false){
  if(typeof raw!=='string'||raw.length>80||!/^\d+(?:\.\d+)?$/.test(raw))throw new Error('invalid_candle');
  const value=dec(raw);if(zero?value.lt(0):!value.gt(0))throw new Error('invalid_candle');
  return txt(value);
}
function candle(at,values,now){
  if(!Number.isSafeInteger(at)||at<DCA_CANDLES_START_MS||(at+BEIJING)%DAY!==0||at>dayStart(now))throw new Error('invalid_candle_day');
  const [open,high,low,close]=values.slice(0,4).map(value=>amount(value)),volume=amount(values[4],true);
  if(dec(low).gt(high)||dec(open).lt(low)||dec(open).gt(high)||dec(close).lt(low)||dec(close).gt(high))throw new Error('invalid_candle_ohlc');
  return {time:date(at),open,high,low,close,volume};
}
function candleStart(row){
  if(typeof row?.time!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(row.time))throw new Error('invalid_candle_date');
  const at=Date.parse(row.time+'T00:00:00+08:00');
  if(!Number.isSafeInteger(at)||date(at)!==row.time)throw new Error('invalid_candle_date');
  return at;
}
function ordered(rows){
  const map=new Map();
  for(const row of rows){const previous=map.get(row.time);if(previous&&JSON.stringify(previous)!==JSON.stringify(row))throw new Error('conflicting_candle');map.set(row.time,row);}
  return [...map.values()].sort((a,b)=>a.time.localeCompare(b.time));
}
export function normalizeBinanceCandles(raw,now){
  if(!Array.isArray(raw)||raw.length>1000)throw new Error('invalid_candles');
  return ordered(raw.map(row=>{
    if(!Array.isArray(row)||row.length<7||!Number.isSafeInteger(row[0])||row[6]!==row[0]+DAY-1)throw new Error('invalid_candle');
    return candle(row[0],row.slice(1,6),now);
  }));
}
export function normalizeOKXCandles(raw,now){
  if(raw?.code!=='0'||!Array.isArray(raw.data)||raw.data.length>300)throw new Error('invalid_candles');
  return ordered(raw.data.map(row=>{
    if(!Array.isArray(row)||row.length<9||typeof row[0]!=='string'||!/^\d+$/.test(row[0])||!['0','1'].includes(row[8]))throw new Error('invalid_candle');
    const at=Number(row[0]);
    if(at<dayStart(now)&&row[8]!=='1')throw new Error('unconfirmed_history');
    return candle(at,row.slice(1,6),now);
  }));
}
function complete(rows,until){
  if(until<DCA_CANDLES_START_MS)return rows.length===0;
  if(rows.length!==(until-DCA_CANDLES_START_MS)/DAY+1)return false;
  return rows.every((row,i)=>row.time===date(DCA_CANDLES_START_MS+i*DAY));
}
async function publicJSON(origin,path,params,options){
  if(options.signal?.aborted)throw new Error('market_timeout');
  if(!(BINANCE.includes(origin)&&path==='/api/v3/klines'||origin===OKX&&['/api/v5/market/history-candles','/api/v5/market/candles'].includes(path)))throw new Error('endpoint_rejected');
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),Math.max(1,Math.min(options.timeoutMs??8000,8000)));
  const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});
  try{
    const response=await (options.fetch??globalThis.fetch).call(globalThis,origin+path+'?'+new URLSearchParams(params),{method:'GET',headers:{Accept:'application/json','User-Agent':'XHY-Terminal/1.0'},redirect:'manual',signal:controller.signal});
    if(!response.ok){const error=new Error('market_unavailable');if(response.status===429||response.status===418)error.retryMs=60000;throw error;}
    const text=await response.text();if(text.length>MAX_RESPONSE)throw new Error('invalid_candles');return JSON.parse(text);
  }finally{clearTimeout(timeout);options.signal?.removeEventListener('abort',abort);}
}
async function binanceHistory(origin,now,options){
  let cursor=DCA_CANDLES_START_MS,rows=[];
  for(let page=0;page<20;page++){
    const next=normalizeBinanceCandles(await publicJSON(origin,'/api/v3/klines',{symbol:'BTCUSDT',interval:'1d',timeZone:'8',startTime:String(cursor),endTime:String(now),limit:'1000'},options),now);
    if(!next.length)break;
    if(candleStart(next[0])<cursor)throw new Error('invalid_pagination');
    rows.push(...next);const last=candleStart(next.at(-1));
    if(last>=dayStart(now))break;
    if(last<cursor)throw new Error('invalid_pagination');cursor=last+DAY;
  }
  rows=ordered(rows);if(!rows.length||rows.length>MAX_DAYS)throw new Error('history_unavailable');return rows;
}
async function okxHistory(now,options){
  let cursor=dayStart(now)+DAY,rows=[];
  for(let page=0;page<67;page++){
    const raw=await publicJSON(OKX,'/api/v5/market/history-candles',{instId:'BTC-USDT',bar:'1D',after:String(cursor),limit:'300'},options);
    // The last page can extend before July 2024; discard it before validation.
    if(raw?.code!=='0'||!Array.isArray(raw.data)||raw.data.length>300)throw new Error('invalid_candles');
    const bounded={...raw,data:raw.data.filter(row=>Array.isArray(row)&&Number(row[0])>=DCA_CANDLES_START_MS)};
    const next=normalizeOKXCandles(bounded,now);
    if(!next.length)break;
    const first=candleStart(next[0]);if(candleStart(next.at(-1))>=cursor)throw new Error('invalid_pagination');
    rows.push(...next);if(first<=DCA_CANDLES_START_MS)break;
    if(first>=cursor)throw new Error('invalid_pagination');cursor=first;
  }
  rows=ordered(rows);if(!rows.length||rows.length>MAX_DAYS)throw new Error('history_unavailable');return rows;
}
async function history(now,options){
  let retryMs=0,partial=null;
  for(const origin of [...BINANCE,'okx'])try{
    const result={rows:origin==='okx'?await okxHistory(now,options):await binanceHistory(origin,now,options),provider:origin==='okx'?'okx':'binance'};
    if(complete(result.rows.filter(row=>candleStart(row)<dayStart(now)),dayStart(now)-DAY))return result;
    if(!partial||result.rows.length>partial.rows.length)partial=result;
  }catch(error){retryMs=Math.max(retryMs,error.retryMs??0);}
  if(partial)return partial;
  const failure=new Error('history_unavailable');failure.retryMs=retryMs;throw failure;
}
async function tail(now,options,preferred){
  const attempts=preferred==='okx'?['okx',...BINANCE]:[...BINANCE,'okx'];let retryMs=0;
  for(const provider of attempts)try{
    const rows=provider==='okx'
      ?normalizeOKXCandles(await publicJSON(OKX,'/api/v5/market/candles',{instId:'BTC-USDT',bar:'1D',limit:'2'},options),now)
      :normalizeBinanceCandles(await publicJSON(provider,'/api/v3/klines',{symbol:'BTCUSDT',interval:'1d',timeZone:'8',startTime:String(Math.max(DCA_CANDLES_START_MS,dayStart(now)-DAY)),endTime:String(now),limit:'2'},options),now);
    if(!rows.some(row=>row.time===date(dayStart(now))))throw new Error('current_candle_missing');
    return {rows,provider:provider==='okx'?'okx':'binance'};
  }catch(error){retryMs=Math.max(retryMs,error.retryMs??0);}
  const error=new Error('tail_unavailable');error.retryMs=retryMs;throw error;
}
async function loadArchive(env,state,now){
  if(state.loaded)return;state.loaded=true;
  try{
    const row=await env.DB.prepare('SELECT value,updated_ms FROM market_kv WHERE key=?').bind(DCA_CANDLES_CACHE_KEY).first();if(!row)return;
    state.archiveValue=row.value;
    const saved=JSON.parse(row.value);if(saved.version!==1||!['binance','okx'].includes(saved.provider)||!Array.isArray(saved.candles)||saved.candles.length>MAX_DAYS)return;
    const rows=ordered(saved.candles.map(row=>candle(candleStart(row),[row.open,row.high,row.low,row.close,row.volume],now)));
    if(rows.some(row=>candleStart(row)>=dayStart(now)))return;
    state.closed=rows;state.provider=saved.provider;state.asOf=typeof saved.as_of==='string'?saved.as_of:null;
    state.persisted=JSON.stringify(rows);
  }catch{/* Damaged public cache is rebuilt from fixed market endpoints. */}
}
async function persist(env,state,now){
  for(let attempt=0;attempt<2;attempt++){
    const serialized=JSON.stringify(state.closed);if(serialized===state.persisted)return;
    const value=JSON.stringify({version:1,provider:state.provider,candles:state.closed,as_of:state.asOf});
    // Another cold isolate may already have stored a more complete archive.
    const result=await env.DB.prepare('INSERT INTO market_kv(key,value,updated_ms) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_ms=excluded.updated_ms WHERE market_kv.value IS ?').bind(DCA_CANDLES_CACHE_KEY,value,now,state.archiveValue??null).run();
    if(result.meta?.changes!==0){state.persisted=serialized;state.archiveValue=value;return;}
    const current=await env.DB.prepare('SELECT value,updated_ms FROM market_kv WHERE key=?').bind(DCA_CANDLES_CACHE_KEY).first();
    state.archiveValue=current?.value??null;if(!current)continue;
    const saved=JSON.parse(current.value);
    if(saved.version!==1||!Array.isArray(saved.candles)||saved.candles.length>MAX_DAYS)continue;
    const merged=new Map(state.closed.map(row=>[row.time,row]));
    for(const raw of saved.candles){const at=candleStart(raw);if(at<dayStart(now))merged.set(raw.time,candle(at,[raw.open,raw.high,raw.low,raw.close,raw.volume],now));}
    state.closed=[...merged.values()].sort((a,b)=>a.time.localeCompare(b.time));
    state.persisted=JSON.stringify(saved.candles);
  }
}
function view(state,now){
  const today=date(dayStart(now));const rows=[...state.closed,...(state.current?.time===today?[state.current]:[])];
  const covered=complete(rows,dayStart(now));
  const current=state.current?.time===today&&state.currentAt!=null&&now-state.currentAt<REFRESH_MS*3;
  const status=rows.length?(current&&!state.error&&covered?'fresh':'stale'):'unavailable';
  const providers=[state.provider,state.liveProvider].filter(Boolean).map(source);
  return {status,timezone:'Asia/Shanghai',symbol:'BTCUSDT',interval:'1d',start_date:DCA_CANDLES_START,as_of:state.asOf,source:[...new Set(providers)].join(' / ')||null,coverage_complete:covered,error:state.error||(covered?null:rows.length?'历史日 K 线尚有缺口，稍后自动补齐。':'日 K 线暂时不可用，稍后自动重试。'),refresh_interval_seconds:5,candles:rows};
}
export async function getDCACandles(env,options={}){
  const now=nowOf(options);if(!Number.isSafeInteger(now)||now<DCA_CANDLES_START_MS||now>4102444800000)throw new Error('invalid_time');
  let state=memories.get(env.DB);if(!state){state={loaded:false,closed:[],current:null,currentAt:null,provider:null,liveProvider:null,asOf:null,persisted:null,pending:null,retryAt:0,historyRetryAt:0,error:null};memories.set(env.DB,state);}
  if(state.pending){await state.pending;return view(state,nowOf(options));}
  if(state.currentAt!=null&&now-state.currentAt<REFRESH_MS&&state.current?.time===date(dayStart(now)))return view(state,now);
  if(now<state.retryAt)return view(state,now);
  state.pending=(async()=>{
    await loadArchive(env,state,now);let result=null;
    try{
      if(!options.tailOnly&&!complete(state.closed,dayStart(now)-DAY)&&now>=state.historyRetryAt){
        state.historyRetryAt=now+HISTORY_RETRY_MS;
        try{result=await history(now,options);state.provider=result.provider;const merged=new Map(state.closed.map(row=>[row.time,row]));for(const row of result.rows)if(candleStart(row)<dayStart(now))merged.set(row.time,row);state.closed=[...merged.values()].sort((a,b)=>a.time.localeCompare(b.time));}catch{/* A missing history must not prevent reading today's real candle. */}
      }
      if(!result?.rows.some(row=>row.time===date(dayStart(now))))result=await tail(now,options,state.provider);
      const byDay=new Map(state.closed.map(row=>[row.time,row]));
      for(const row of result.rows)if(candleStart(row)<dayStart(now))byDay.set(row.time,row);
      state.closed=[...byDay.values()].sort((a,b)=>a.time.localeCompare(b.time));
      state.current=result.rows.find(row=>row.time===date(dayStart(now)))??null;state.liveProvider=result.provider;state.provider ||= result.provider;
      state.currentAt=nowOf(options);state.asOf=new Date(state.currentAt).toISOString();state.error=null;state.retryAt=0;
      try{await persist(env,state,state.currentAt);}catch{/* Public history still serves if D1 has reached its write quota. */}
    }catch(error){state.error='行情源暂时无法读取，保留已同步的真实 K 线。';state.retryAt=now+Math.max(REFRESH_MS,error.retryMs??0);}
  })();
  try{await state.pending;}finally{state.pending=null;}
  return view(state,nowOf(options));
}
export async function handleDCACandles(request,env,context={},options={}){
  const url=new URL(request.url);if(url.pathname!=='/api/wallet/btc-dca-candles')return null;
  if(request.method!=='GET')return json({error:'此接口只支持读取。'},405);
  const tailOnly=url.search==='?tail=1',mode=tailOnly?'tail':'history';
  if(url.search&&!tailOnly)return json({error:'日 K 线接口不接受此查询参数。'},400);
  const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),20000);
  try{const result=await getDCACandles(env,{...(context.candleOptions??{}),...options,tailOnly,signal:controller.signal});return json({...result,mode,candles:tailOnly?result.candles.slice(-2):result.candles});}
  catch{return json({status:'unavailable',mode,timezone:'Asia/Shanghai',symbol:'BTCUSDT',interval:'1d',start_date:DCA_CANDLES_START,as_of:null,source:null,coverage_complete:false,error:'日 K 线暂时不可用，稍后自动重试。',refresh_interval_seconds:5,candles:[]},503);}
  finally{clearTimeout(deadline);}
}
