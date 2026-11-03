import {D,dec,txt,iso} from './cost-book.mjs';

// 价格变动盈亏 (price-change profit) of the BTC held, the same basis as the
// local terminal: "剔除转账 · 含汇率变动". Between two balance snapshots, the
// BTC held at the first one gains or loses the price move; in CNY the move
// includes the exchange rate. BTC that arrives or leaves (a buy, a transfer,
// a newly counted source) changes the balance but is never profit.
//
// Every snapshot stores the running total of that profit since the start of
// the history (pnl_usd, pnl_cny), so a period's result is the difference of
// two running totals. Thinning old snapshots therefore never changes a
// result, and each minute only adds one step to the total.
const DAY=86400000;
const PERIODS=[['today',null],['week',7],['month',30],['days90',90]];
// A period may begin at the first snapshot shortly after its start.
const START_TOLERANCE_MS=15*60000;
export const PRICE_INDEX_FIELDS=['price_usd','fx','pnl_usd','pnl_cny'];
const beijingDayStart=ms=>Math.floor((ms+28800000)/DAY)*DAY-28800000;

function amount(value){
  if(value==null||value==='')return null;
  try{const result=dec(value);return result.isFinite()?result:null;}catch{return null;}
}
function stamp(point){
  const at=typeof point?.timestamp==='string'?Date.parse(point.timestamp):NaN;
  return Number.isFinite(at)?at:null;
}

// Adds the running totals to snapshots that do not have them yet (new ones,
// or history saved before this calculation existed). A price or exchange rate
// missing at one snapshot is carried from the previous one; a total starts at
// the first snapshot whose price (and, for CNY, rate) is known.
const knownPrice=point=>{const btc=amount(point?.btc),usd=amount(point?.usd);return amount(point?.price_usd)!==null||btc!==null&&btc.gt(0)&&usd!==null;};
const knownRate=point=>{const usd=amount(point?.usd);return amount(point?.fx)!==null||usd!==null&&usd.gt(0)&&amount(point?.cny)!==null;};
export function indexPriceChange(history){
  const list=Array.isArray(history)?history:[];
  // Resume from the newest snapshot that already carries its totals and the
  // price (and rate) to extend them, so each new minute costs one step.
  let from=0;
  for(let i=list.length-1;i>=0;i--){const point=list[i];if(amount(point?.pnl_usd)!==null&&knownPrice(point)&&(amount(point?.pnl_cny)===null||knownRate(point))){from=i;break;}}
  const result=list.slice(0,from);let state=null;
  for(const point of list.slice(from)){
    const btc=amount(point?.btc);
    if(stamp(point)===null||btc===null||btc.lt(0)){result.push(point);continue;}
    const usd=amount(point.usd),cny=amount(point.cny);
    const price=amount(point.price_usd)??(btc.gt(0)&&usd!==null?usd.div(btc):null)??state?.price??null;
    const rate=amount(point.fx)??(usd!==null&&usd.gt(0)&&cny!==null?cny.div(usd):null)??state?.rate??null;
    let pnlUsd=amount(point.pnl_usd),pnlCny=amount(point.pnl_cny);
    if(pnlUsd===null&&price!==null)pnlUsd=state?.pnlUsd!=null&&state.price!=null?state.pnlUsd.add(state.btc.mul(price.sub(state.price))):new D(0);
    if(pnlCny===null&&price!==null&&rate!==null)pnlCny=state?.pnlCny!=null&&state.price!=null&&state.rate!=null?state.pnlCny.add(state.btc.mul(price.mul(rate).sub(state.price.mul(state.rate)))):new D(0);
    // Eight decimals keep the stored totals short; the rounding stays far
    // below a cent even across a year of minute steps.
    pnlUsd=pnlUsd===null?null:pnlUsd.toDecimalPlaces(8);pnlCny=pnlCny===null?null:pnlCny.toDecimalPlaces(8);
    result.push({...point,pnl_usd:pnlUsd===null?null:txt(pnlUsd),pnl_cny:pnlCny===null?null:txt(pnlCny)});
    state={btc,price,rate,pnlUsd,pnlCny};
  }
  return result;
}

export function pricePeriods(history,now=Date.now()){
  const points=(Array.isArray(history)?history:[]).map(point=>({point,at:stamp(point)}))
    .filter(row=>row.at!==null&&row.at<=now&&(typeof row.point.pnl_usd==='string'||typeof row.point.pnl_cny==='string')).sort((a,b)=>a.at-b.at);
  const closing=points.at(-1),result={};
  for(const [key,days] of PERIODS){
    const start=days===null?beijingDayStart(now):now-days*DAY;
    const empty={btc:null,usd:null,cny:null,status:'unavailable',stale:true,start_at:iso(start),end_at:null,reason:''};
    // The snapshot nearest the start opens the period (old history is thinned);
    // one after the start opens it only if none exists before or it is closer.
    let before=null;for(const row of points){if(row.at<=start)before=row;else break;}
    const after=points.find(row=>row.at>start)||null;
    const opening=before&&after?(after.at-start<start-before.at?after:before):before||(after&&after.at-start<=START_TOLERANCE_MS?after:null);
    if(!closing||closing.at<start){result[key]={...empty,reason:key==='today'?'今天还没有余额快照。':'该周期内没有余额快照。'};continue;}
    if(!opening){result[key]={...empty,reason:'余额历史尚未覆盖完整周期。'};continue;}
    const diff=field=>{const a=amount(opening.point[field]),b=amount(closing.point[field]);return a===null||b===null?null:txt(b.sub(a));};
    const usd=diff('pnl_usd'),cny=diff('pnl_cny');
    result[key]={btc:null,usd,cny,status:usd===null&&cny===null?'unavailable':'estimated',stale:false,
      start_at:iso(opening.at),end_at:iso(closing.at),
      reason:usd===null&&cny===null?'缺少期初或期末行情。':cny===null?'缺少人民币汇率。':usd===null?'缺少美元行情。':''};
  }
  return result;
}
