import {D,dec,txt,iso,beijingDate,validateTrade,compareTrades,rateFor} from './cost-book.mjs';

const DAY=86400000,YEAR=365*DAY;
const startOfDay=ms=>Math.floor((ms+28800000)/DAY)*DAY-28800000;
const yearStart=year=>Date.UTC(year,0,1)-28800000;
const positive=(value)=>{const n=dec(value);if(!n.gt(0))throw new Error('invalid_valuation');return n;};
const freshCapital=()=>({version:1,inventory:'0',cost:'0',cohorts:[],first_buy_at:null,first_remaining_buy_at:null,last_at_ms:0,last_bill_id:'0',trade_count:0,buy_count:0,sell_count:0});
function scalarNumber(value){if(!['string','number'].includes(typeof value)||String(value).length>512||!/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(String(value)))throw new Error('invalid_amount');const n=Number(value);if(!Number.isFinite(n)||n<0||n>1e100)throw new Error('invalid_amount');return n;}

function checkCapital(value){
 if(!value||value.version!==1||!Array.isArray(value.cohorts)||value.cohorts.length>15000||!Number.isSafeInteger(value.last_at_ms)||!Number.isSafeInteger(value.trade_count)||dec(value.inventory).lt(0)||dec(value.cost).lt(0))throw new Error('invalid_capital');
 const dates=new Set();
 for(const row of value.cohorts){if(!row||!Number.isSafeInteger(row.at_ms)||row.at_ms!==startOfDay(row.at_ms)||row.date!==beijingDate(row.at_ms)||dates.has(row.date))throw new Error('invalid_capital');scalarNumber(row.quantity);scalarNumber(row.cost);dates.add(row.date);}
 return value;
}

// Proportional reductions describe the same moving-average remaining position
// as cost-book.mjs. A common scale makes each sell O(1), rather than visiting
// every old purchase. Only the final daily cohorts are materialized.
export function appendRemainingCapital(original,updates,rates={}){
 const state=structuredClone(checkCapital(original||freshCapital()));
 const cohorts=new Map(state.cohorts.map(row=>[row.date,{...row,quantity:dec(row.quantity),cost:dec(row.cost)}]));
 let scale=new D(1),inventory=dec(state.inventory),cost=dec(state.cost);
 for(const row of [...updates].sort(compareTrades)){
  validateTrade(row);
  if(state.trade_count&&(row.at_ms<state.last_at_ms||row.at_ms===state.last_at_ms&&BigInt(row.bill_id)<=BigInt(state.last_bill_id)))throw new Error('out_of_order_trade');
  const quantity=dec(row.btc_net);
  if(row.side==='buy'){
   const cash=dec(row.quote_amount).mul(rateFor(row,rates)),date=beijingDate(row.at_ms);
   const cohort=cohorts.get(date)||{date,at_ms:startOfDay(row.at_ms),first_buy_at:iso(row.at_ms),quantity:new D(0),cost:new D(0)};
   cohort.quantity=cohort.quantity.add(quantity.div(scale));cohort.cost=cohort.cost.add(cash.div(scale));cohorts.set(date,cohort);
   inventory=inventory.add(quantity);cost=cost.add(cash);state.buy_count++;state.first_buy_at ||= iso(row.at_ms);
  }else{
   const sold=quantity.neg();if(!sold.gt(0)||sold.gt(inventory))throw new Error('history_invalid');
   if(sold.eq(inventory)){inventory=new D(0);cost=new D(0);scale=new D(1);cohorts.clear();}
   else{cost=cost.sub(cost.mul(sold).div(inventory));scale=scale.mul(inventory.sub(sold)).div(inventory);inventory=inventory.sub(sold);}
   state.sell_count++;
  }
  state.trade_count++;state.last_at_ms=row.at_ms;state.last_bill_id=row.bill_id;
 }
 const rows=[...cohorts.values()].sort((a,b)=>a.at_ms-b.at_ms).map(row=>({...row,quantity:row.quantity.mul(scale).toDecimalPlaces(40),cost:row.cost.mul(scale).toDecimalPlaces(40)}));
 // Keep complete scalar precision and an exact aggregate after bounded daily
 // allocation rounding. The final cohort absorbs the tiny allocation residue.
 if(rows.length){const last=rows.at(-1),prior=rows.slice(0,-1);last.quantity=inventory.sub(prior.reduce((n,r)=>n.add(r.quantity),new D(0)));last.cost=cost.sub(prior.reduce((n,r)=>n.add(r.cost),new D(0)));if(last.quantity.lt(0)||last.cost.lt(0))throw new Error('capital_rounding_invalid');}
 state.inventory=txt(inventory);state.cost=txt(cost);state.cohorts=rows.map(row=>({...row,quantity:txt(row.quantity),cost:txt(row.cost)}));
 state.first_remaining_buy_at=state.cohorts[0]?.first_buy_at||null;
 return state;
}

export function buildRemainingCapital(records,rates={}){
 const seen=new Set(),bills=new Set();
 for(const row of records){validateTrade(row);if(seen.has(row.id)||bills.has(row.bill_id)||bills.has(row.counter_bill_id))throw new Error('duplicate_trade');seen.add(row.id);bills.add(row.bill_id);bills.add(row.counter_bill_id);}
 return appendRemainingCapital(freshCapital(),records,rates);
}

// All negatives precede the single terminal positive, so the future-value
// equation is monotone in z=log(1+r). This construction has at most one root.
// Daily dates use Beijing calendar days, as the UI and daily DCA ledger do;
// one financial year is 365 actual days, including across leap years.
export function solveRemainingXirr(flows,terminalValue,terminalMs){
 if(!Number.isSafeInteger(terminalMs))throw new Error('invalid_valuation');
 const end=startOfDay(terminalMs),value=dec(terminalValue);
 if(value.lt(0))throw new Error('invalid_valuation');
 const terms=[];let sameDay=0,maxAge=0;
 for(const flow of flows){const amount=scalarNumber(flow.cost),date=startOfDay(flow.at_ms);if(!Number.isSafeInteger(flow.at_ms)||date>end)throw new Error('invalid_cashflow');if(!amount)continue;const age=(end-date)/YEAR;terms.push({log:Math.log(amount),age});maxAge=Math.max(maxAge,age);if(!age)sameDay+=amount;}
 const unavailable=reason=>({annualized_return_pct:null,reason,days:maxAge*365,cashflow_count:terms.length});
 if(!terms.length)return unavailable('现存持仓没有可核实的投入成本。');
 if(!maxAge)return unavailable('持有时间不足一个北京时间自然日，暂不折算年化。');
 if(!value.gt(0))return unavailable('期末市值为零，无法求出有限的 XIRR。');
 if(value.toNumber()<=sameDay)return unavailable('期末市值不高于同日投入，当前日期口径下没有有限的 XIRR。');
 const target=Math.log(value.toNumber());
 const evaluate=z=>{let peak=-Infinity;for(const term of terms)peak=Math.max(peak,term.log+term.age*z);let sum=0,slope=0;for(const term of terms){const weight=Math.exp(term.log+term.age*z-peak);sum+=weight;slope+=weight*term.age;}return {f:peak+Math.log(sum)-target,derivative:slope/sum};};
 let lo=-1,hi=1;
 for(let i=0;i<20&&evaluate(lo).f>0;i++)lo*=2;
 for(let i=0;i<20&&evaluate(hi).f<0;i++)hi*=2;
 if(evaluate(lo).f>0||evaluate(hi).f<0)return unavailable('年化根超出可稳定求解范围。');
 let z=0;
 // Safeguarded Newton converges in a few evaluations for normal portfolios;
 // the maintained bracket supplies a deterministic bisection fallback.
 for(let i=0;i<64;i++){const {f,derivative}=evaluate(z);if(Math.abs(f)<2e-13)break;if(f>0)hi=z;else lo=z;const next=z-f/derivative;z=Number.isFinite(next)&&next>lo&&next<hi?next:(lo+hi)/2;}
 const r=Math.abs(z)<2e-13?0:Math.expm1(z);
 if(!Number.isFinite(r)||r<=-1)return unavailable('年化结果接近 -100% 或超出可稳定显示范围。');
 return {annualized_return_pct:txt(new D(r).mul(100)),reason:null,days:maxAge*365,cashflow_count:terms.length};
}

function boundaryPrice(year,prices){
 const row=prices?.[String(year)];
 if(!row||row.at_ms!==yearStart(year)||typeof row.source!=='string'||!row.source)return null;
 try{return {price:positive(row.price_usdt),source:row.source};}catch{return null;}
}

export function calculatePositionAnnualized({capital,records,rates={},holdingsBtc,priceUsdt,asOfMs,yearPrices={}}){
 const state=checkCapital(capital||buildRemainingCapital(records||[],rates));
 if(!Number.isSafeInteger(asOfMs)||asOfMs<state.last_at_ms)throw new Error('invalid_valuation');
 const holdings=dec(holdingsBtc),price=positive(priceUsdt);if(holdings.lt(0))throw new Error('invalid_valuation');
 const inventory=dec(state.inventory),market=holdings.mul(price),base={status:'unavailable',annualized_return_pct:null,method:'remaining_position_xirr',currency:'USDT',first_buy_at:state.first_buy_at,first_remaining_buy_at:state.first_remaining_buy_at,as_of:iso(asOfMs),cashflow_date_convention:'beijing_calendar_day',year_basis_days:365,cashflow_count:0,holdings_btc:txt(holdings),spot_inventory_btc:state.inventory,remaining_cost:state.cost,market_value:txt(market),years:[],assumptions:[
  '此处只回看当前剩余持仓：每次历史卖出按移动平均存量比例缩减原买入批次，保留各批次买入日期，不计已实现回款。',
  '年化采用现存成本负现金流与当前市值正现金流的 XIRR；现金流按北京时间自然日归并，以 365 日为一年。',
  '当前实际持仓与现货账本的数量差异按持仓比例回配，因此小额 Received、链上费用等非现货调整属于估算。',
  '分年数据是当前持仓批次的回溯估算，不是当年真实全部账户的已实现加未实现投资回报。',
  '年度回报使用经核实的北京时间年初边界行情；缺失时不以最近价格或零填补。'
 ]};
 if(!inventory.gt(0)||!dec(state.cost).gt(0)){base.reason='当前没有可核实的剩余持仓成本，不能计算年化。';return base;}
 const solved=solveRemainingXirr(state.cohorts,market,asOfMs);Object.assign(base,solved);base.status=solved.annualized_return_pct===null?'unavailable':'estimated';
 const adjustment=holdings.div(inventory),firstYear=new Date(Date.parse(state.first_buy_at)+28800000).getUTCFullYear(),currentYear=new Date(asOfMs+28800000).getUTCFullYear();
 for(let year=firstYear;year<=currentYear;year++){
  let start=Math.max(yearStart(year),startOfDay(Date.parse(state.first_buy_at)));const end=Math.min(yearStart(year+1),asOfMs),endDay=startOfDay(end);
  const before=state.cohorts.filter(r=>r.at_ms<start),during=state.cohorts.filter(r=>r.at_ms>=start&&r.at_ms<yearStart(year+1)&&r.at_ms<=endDay);
  const closing=state.cohorts.filter(r=>r.at_ms<yearStart(year+1)&&r.at_ms<=endDay),openingQty=before.reduce((n,r)=>n.add(r.quantity),new D(0)),closingQty=closing.reduce((n,r)=>n.add(r.quantity),new D(0));
  if(!openingQty.gt(0)&&during.length)start=during[0].at_ms;
  const partial=start!==yearStart(year)||end!==yearStart(year+1),row={year,start_at:iso(start),end_at:iso(end),partial_year:partial,status:'unavailable',annualized_return_pct:null,period_return_pct:null,reason:null};
  if(!closingQty.gt(0)){row.reason='该年度没有延续到当前的持仓买入批次。';base.years.push(row);continue;}
  const opening=openingQty.gt(0)?boundaryPrice(year,yearPrices):null,ending=year===currentYear?{price,source:'current_position_quote'}:boundaryPrice(year+1,yearPrices);
  if(openingQty.gt(0)&&!opening||!ending){row.reason='该年度缺少可核实的北京时间年初或年末价格。';base.years.push(row);continue;}
  const flows=[...(opening?[{at_ms:start,cost:txt(openingQty.mul(adjustment).mul(opening.price))}]:[]),...during.map(r=>({at_ms:r.at_ms,cost:r.cost}))],terminal=closingQty.mul(adjustment).mul(ending.price),annual=solveRemainingXirr(flows,terminal,end);
  row.annualized_return_pct=annual.annualized_return_pct;row.reason=annual.reason;row.opening_value=opening?txt(openingQty.mul(adjustment).mul(opening.price)):'0';row.closing_value=txt(terminal);row.price_sources={opening:opening?.source||null,closing:ending.source};
  if(annual.annualized_return_pct!==null){const years=(endDay-startOfDay(start))/YEAR,rate=Number(annual.annualized_return_pct)/100;row.period_return_pct=txt(new D(Math.expm1(Math.log1p(rate)*years)).mul(100));row.status='estimated';}
  base.years.push(row);
 }
 return base;
}
