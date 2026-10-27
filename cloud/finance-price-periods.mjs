import {dec,txt,iso,beijingDate} from './cost-book.mjs';

const keys=['today','week','month','days90'];
const uncalculated='价格变动盈亏尚未完成核算；需要完整 BTC 流水及对应时刻的行情，持仓成本浮盈独立计算。';
const stamp=value=>typeof value==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
function amount(value){try{return value==null?null:txt(dec(value));}catch{return null;}}
function explanation(value){return typeof value==='string'?value.slice(0,600):'';}

// A current balance observation cannot extend a cash-flow-adjusted historical
// calculation. Keep its original verified interval until the full ledger and
// historical market data have been refreshed together.
export function preserveHistoricalPricePeriods(previous,now=Date.now()){
  const result={};
  for(const key of keys){
    const prior=previous&&typeof previous==='object'?previous[key]:null;
    const start=stamp(prior?.start_at),end=stamp(prior?.end_at);
    const validInterval=start!==null&&end!==null&&start<=end&&end<=now;
    const originalReason=explanation(prior?.historical===true?prior.calculation_reason:prior?.reason);
    const empty={btc:null,usd:null,cny:null,status:'unavailable',stale:true,historical:false,as_of:null,
      start_at:validInterval?prior.start_at:null,end_at:validInterval?prior.end_at:null,
      reason:originalReason||uncalculated};
    if(key==='today'&&validInterval&&beijingDate(end)!==beijingDate(now)){
      result[key]={...empty,start_at:iso(Math.floor((now+28800000)/86400000)*86400000-28800000),end_at:null,
        reason:'历史快照不属于今天；今日价格变动盈亏尚未完成核算。'};
      continue;
    }
    const usd=amount(prior?.usd),cny=amount(prior?.cny);
    if(!validInterval||(usd===null&&cny===null)){
      result[key]=empty;
      continue;
    }
    const at=iso(end+28800000).slice(0,19).replace('T',' ');
    result[key]={...empty,usd,cny,status:'stale',historical:true,as_of:prior.end_at,
      calculation_reason:originalReason,
      reason:`历史核算截至 ${at}（北京时间）；云端后续流水待核对。${originalReason?' '+originalReason:''}`};
  }
  return result;
}
