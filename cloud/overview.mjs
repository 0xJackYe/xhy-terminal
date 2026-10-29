import {createD1DiaryStore} from './diary-store.mjs';
import {getFinanceSnapshot,syncFinance} from './finance.mjs';
import {getMarketSnapshot,syncMarket} from './market.mjs';
const nutrients=['kcal','protein','carbs','fat','fiber','saturatedFat'],DAY=86400000;
const total=(items,k)=>{const values=items.map(x=>x.nutrition?.[k]);return values.length&&values.every(x=>typeof x==='number'&&Number.isFinite(x))?Math.round(values.reduce((a,b)=>a+b,0)*10)/10:null;};
function summarize(day,date){const meals=(day?.meals||[]).filter(x=>x.status==='eaten'),items=meals.flatMap(x=>x.items||[]);return {date,recorded:meals.length>0,mealCount:meals.length,itemCount:items.length,totals:Object.fromEntries(nutrients.map(k=>[k,total(items,k)])),meals:meals.map(({id,type,title,status,items:eaten})=>({id,type,title,status,kcal:total(eaten||[],'kcal')}))};}
// Long-term BTC position: moving-average cost against the current price (USDT).
function lifetimeSummary(lifetime){const m=lifetime?.metrics;if(!m||typeof m!=='object'||!Object.keys(m).length)return null;return {status:lifetime.status,averageCost:m.average_cost,price:m.price_usdt,unrealized:m.unrealized_net,returnPct:m.unrealized_return_pct,cost:m.remaining_cost};}
// The overview's intraday line: the per-minute history as at most ~120 [time_ms, price] points, ending on the latest.
export function priceChart(history,limit=120){const points=(Array.isArray(history)?history:[]).filter(p=>p&&Number.isFinite(p.time_ms)&&Number.isFinite(p.price)&&p.price>0).map(p=>[p.time_ms,p.price]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);const step=Math.max(1,Math.ceil(points.length/limit)),sampled=points.filter((_,i)=>i%step===0);if(points.length&&sampled.at(-1)!==points.at(-1))sampled.push(points.at(-1));return sampled;}
export async function buildOverview(env,ctx,now=Date.now()){
  // Diary days run on UTC+0 (北京时间 08:00 换日), like the diet app; market days stay on Beijing time.
  const currentDay=Math.floor(now/DAY)*DAY;
  const today=new Date(currentDay).toISOString().slice(0,10);
  const [stored,portfolio,combined,terminal]=await Promise.all([
    createD1DiaryStore({db:env.DB}).load('terminal-owner').catch(()=>null),
    getFinanceSnapshot(env,'portfolio').catch(()=>null),getFinanceSnapshot(env,'combined').catch(()=>null),
    syncMarket(env).catch(()=>getMarketSnapshot(env).catch(()=>null))]);
  ctx?.waitUntil?.(syncFinance(env).catch(()=>{}));
  if(terminal?.newAlerts?.length&&ctx?.onMarketAlerts)ctx.waitUntil(Promise.resolve(ctx.onMarketAlerts(terminal.newAlerts)).catch(()=>{}));
  const diary=stored?.diary,byDate=new Map((diary?.days||[]).map(d=>[d.date,d]));
  if(portfolio&&(!Number.isFinite(Date.parse(portfolio.updated_at))||now-Date.parse(portfolio.updated_at)>180000))portfolio.stale=true;
  if(combined&&(!Number.isFinite(Date.parse(combined.updated_at))||now-Date.parse(combined.updated_at)>180000))combined.stale=true;
  const days=Array.from({length:7},(_,i)=>{const date=new Date(currentDay-(6-i)*DAY).toISOString().slice(0,10);return summarize(byDate.get(date),date);});
  const current=days[6],weekItems=days.filter(d=>d.recorded);
  const diet=diary?{status:current.recorded?'online':'empty',error:null,updatedAt:diary.updatedAt,date:today,recorded:current.recorded,today:current,week:{startDate:days[0].date,endDate:today,recordedDays:weekItems.length,days,totals:Object.fromEntries(nutrients.map(k=>[k,weekItems.length&&weekItems.every(d=>d.totals[k]!=null)?Math.round(weekItems.reduce((n,d)=>n+d.totals[k],0)*10)/10:null]))}}:{status:'offline',error:'云端日记尚未读取。',recorded:false,date:today,today:null,week:null};
  const wallet=portfolio?{status:portfolio.stale||!portfolio.complete?'stale':'online',error:null,updatedAt:portfolio.updated_at,stale:portfolio.stale,complete:portfolio.complete,totalUsd:portfolio.total_usd,totalCny:portfolio.total_cny,totalBtc:portfolio.total_btc,btcHoldings:combined?.totals?.btc,btcHoldingsStale:combined?.stale??true,assets:portfolio.assets||[],locations:portfolio.locations||[],sources:portfolio.sources||[],scopeNote:portfolio.scope_note,thresholdUsd:portfolio.threshold_usd,excludedUsd:portfolio.excluded_usd,unpricedCurrencies:portfolio.unpriced_currencies||[],liabilitiesUsd:portfolio.liabilities_usd,conversionQuotes:portfolio.conversion_quotes||{},pnl:lifetimeSummary(combined?.lifetime_pnl)}:{status:'offline',stale:true,complete:false,totalUsd:null,totalCny:null,totalBtc:null,btcHoldings:null,assets:[],locations:[],sources:[]};
  const market=terminal?.market||{},settings=terminal?.settings||{},live=market.status==='live'&&now-(market.event_ms||0)<15000;
  const alerts={status:live?'online':terminal?'stale':'offline',stale:!live,error:market.error,updatedAt:market.event_ms?new Date(market.event_ms).toISOString():null,price:market.price,priceCurrency:'USDT',changePct:market.change_pct,rangePct:market.range_pct,changePeriod:'北京时间今日',dayOpen:market.day_open,dayHigh:market.day_high,dayLow:market.day_low,connectionStatus:market.status||'offline',connected:market.connected||false,enabled:settings.enabled,thresholds:settings.thresholds_pct||[],metric:settings.metric,settings,recent:(terminal?.alerts||[]).slice(0,8),chart:priceChart(terminal?.history)};
  return {updatedAt:new Date(now).toISOString(),timezone:'Asia/Shanghai',links:{diet:'/diet/',wallet:'/btc/#wallet',alerts:'/btc/#alerts'},services:{diet:{status:diary?'online':'offline',url:'/diet/'},btc:{status:terminal?'online':'offline',url:'/btc/'}},diet,wallet,alerts};
}
