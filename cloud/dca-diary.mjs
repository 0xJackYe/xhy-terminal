import {D,dec,txt,beijingDate,rateFor} from './cost-book.mjs';

// 定投日记 (the DCA diary): the BTC bought on each Beijing day, from the same
// trades as the cost book. It starts on the owner's first purchase,
// 2024-12-14; a recorded buy before that date would move the start back,
// never be hidden. Each day lists the BTC received (net of BTC fees, as the
// cost book counts it), what it cost in USDT at each fill's minute and the
// number of fills. Sales are not purchases and are left out.
export const DCA_DIARY_START='2024-12-14';
export const DCA_FIELDS=['date','btc','usdt','buys'];

export function dcaDiary(rows,{rates={},start=DCA_DIARY_START,coverageStartMs=null}={}){
  const days=new Map();
  for(const row of Array.isArray(rows)?rows:[]){
    if(row?.side!=='buy'||!Number.isSafeInteger(row.at_ms))continue;
    let btc;try{btc=dec(row.btc_net);}catch{continue;}
    if(!btc.gt(0))continue;
    const date=beijingDate(row.at_ms),day=days.get(date)||{btc:new D(0),usdt:new D(0),priced:true,buys:0};
    day.btc=day.btc.add(btc);day.buys++;
    // A fill without its minute rate leaves that day's USDT value unknown
    // rather than counting it as zero.
    if(day.priced)try{day.usdt=day.usdt.add(dec(row.quote_amount).mul(rateFor(row,rates)));}catch{day.priced=false;}
    days.set(date,day);
  }
  const dates=[...days.keys()].sort(),first=dates[0]||null;
  let btc=new D(0),usdt=new D(0),priced=true,buys=0;
  const periods=new Map();
  const list=dates.map(date=>{
    const day=days.get(date);btc=btc.add(day.btc);buys+=day.buys;if(day.priced)usdt=usdt.add(day.usdt);else priced=false;
    const year=date.slice(0,4),period=periods.get(year)||{btc:new D(0),usdt:new D(0),priced:true,buys:0,days:0};
    period.btc=period.btc.add(day.btc);period.buys+=day.buys;period.days++;
    if(day.priced)period.usdt=period.usdt.add(day.usdt);else period.priced=false;
    periods.set(year,period);
    return [date,txt(day.btc.toDecimalPlaces(8)),day.priced?txt(day.usdt.toDecimalPlaces(2)):null,day.buys];
  });
  // The calendar keeps display-rounded days for compatibility. Summaries
  // must use ledger precision, never add those rounded BTC/USDT cells.
  const exact=period=>({days:period.days,buys:period.buys,btc:txt(period.btc),usdt:period.priced?txt(period.usdt):null,
    average_buy_price:period.priced&&period.btc.gt(0)?txt(period.usdt.div(period.btc)):null});
  return {start_date:first&&first<start?first:start,first_buy_date:first,
    coverage_start_date:Number.isSafeInteger(coverageStartMs)?beijingDate(coverageStartMs):null,
    fields:DCA_FIELDS,days:list,
    totals:{days:list.length,buys,btc:txt(btc.toDecimalPlaces(8)),usdt:priced?txt(usdt.toDecimalPlaces(2)):null},
    exact_totals:exact({days:list.length,buys,btc,usdt,priced}),
    exact_periods:Object.fromEntries([...periods].map(([year,period])=>[year,exact(period)]))};
}
