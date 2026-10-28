import {D,dec,txt,iso,beijingDate} from './cost-book.mjs';
const DAY=86400000,YEAR=365*DAY;
const day=ms=>Math.floor((ms+28800000)/DAY)*DAY-28800000;
const changes=terms=>{let count=0,last=0;for(const t of terms){if(last&&last!==t.sign)count++;last=t.sign;}return count;};

function evaluate(terms,z){
 let peak=-Infinity;for(const t of terms)peak=Math.max(peak,t.log-t.years*z);
 let sum=0,absolute=0;for(const t of terms){const w=Math.exp(t.log-t.years*z-peak);sum+=t.sign*w;absolute+=w;}
 return {value:sum/absolute,peak};
}
function bisect(terms,left,right){
 let a=left,b=right,fa=evaluate(terms,a).value;
 for(let i=0;i<85;i++){const mid=(a+b)/2,f=evaluate(terms,mid).value;if(Math.abs(f)<1e-13)return mid;if(Math.sign(f)===Math.sign(fa)){a=mid;fa=f;}else b=mid;}
 return (a+b)/2;
}
function certifiedUnique(terms,z){
 if(changes(terms)===1)return true;
 // At a candidate root, discounted coefficients sum to zero. If every
 // intermediate cumulative sum has one strict sign, summation by parts
 // fixes the sign of NPV on each side of that root, excluding another root.
 const {peak}=evaluate(terms,z);let total=0,absolute=0,sign=0;
 for(let i=0;i<terms.length;i++){
  const t=terms[i],weight=Math.exp(t.log-t.years*z-peak);total+=t.sign*weight;absolute+=weight;
  if(i===terms.length-1)continue;
  if(Math.abs(total)<=Math.max(1,absolute)*2e-12)return false;
  const current=Math.sign(total);if(sign&&sign!==current)return false;sign=current;
 }
 return sign!==0;
}
function finiteRate(z){
 const rate=Math.abs(z)<1e-13?0:Math.expm1(z);
 if(!Number.isFinite(rate)||rate<=-1||Math.abs(rate)>1e100)return {status:'unavailable',reason:'年化结果接近 -100% 或超出可稳定显示范围。',rate:null};
 return {status:'estimated',reason:null,rate,root_count:1};
}
function solveSigned(terms){
 if(terms.length<2||!terms.some(t=>t.sign<0)||!terms.some(t=>t.sign>0))return {status:'unavailable',reason:'现金流与期末净值未形成可求解的正负现金流。',rate:null};
 // Most personal portfolios retain unrecovered contributed capital at every
 // interim date. A certified candidate excludes every other real root, so
 // those ordinary cases need no exhaustive scan and stay cheap on Workers.
 const zero=evaluate(terms,0).value;
 if(Math.abs(zero)<1e-13&&certifiedUnique(terms,0))return finiteRate(0);
 for(const width of [0.25,1,4,16,64]){
  const left=evaluate(terms,-width).value,right=evaluate(terms,width).value;
  if(Math.sign(left)!==Math.sign(right)){const candidate=bisect(terms,-width,width);if(certifiedUnique(terms,candidate))return finiteRate(candidate);break;}
 }
 const grid=[0];for(let i=1;i<=160;i++)grid.push(i/40,-i/40);
 // Log-rate wings include rates arbitrarily close to -100% and very high
 // rates without overflowing cash-flow exponentials.
 for(let x=4.5;x<=16384;x*=1.5)grid.push(x,-x);
 grid.sort((a,b)=>a-b);const roots=[];
 const add=z=>{if(!roots.some(r=>Math.abs(r-z)<1e-7))roots.push(z);};
 let previous=grid[0],prior=evaluate(terms,previous).value;
 for(let i=1;i<grid.length;i++){
  const z=grid[i],value=evaluate(terms,z).value;
  if(Math.abs(value)<1e-13)add(z);
  if(Math.sign(value)!==Math.sign(prior)&&Math.abs(value)>=1e-13&&Math.abs(prior)>=1e-13)add(bisect(terms,previous,z));
  previous=z;prior=value;
 }
 if(roots.length>1)return {status:'ambiguous',reason:'这组投入和提出存在多个年化解，暂不选取其中一个。',rate:null,root_count:roots.length};
 if(!roots.length)return {status:'unavailable',reason:'没有找到可稳定求解的年化收益率。',rate:null,root_count:0};
 if(!certifiedUnique(terms,roots[0]))return {status:'ambiguous',reason:'无法确认这组投入和提出的年化解唯一，暂不展示单一数字。',rate:null,root_count:roots.length};
 return finiteRate(roots[0]);
}

export function calculatePortfolioAnnualized({ledger,marketValueUsdt,asOfMs}){
 if(!Number.isSafeInteger(asOfMs))throw new Error('invalid_valuation');
 const value=dec(marketValueUsdt);if(value.lt(0))throw new Error('invalid_valuation');
 const base={status:'needs_cashflows',method:'cashflow_xirr',currency:'USDT',annualized_return_pct:null,mean_annual_return_pct:null,first_investment_at:null,first_flow_at:null,as_of:iso(asOfMs),cashflow_count:0,contributed_usdt:null,withdrawn_usdt:null,net_invested_usdt:null,market_value_usdt:txt(value),years:[],cashflow_date_convention:'beijing_calendar_day',year_basis_days:365,
  method_note:'按已核对 C2C 外部现金流日期和当前资产市值核算资金加权年化；非现货资金或来源缺口以覆盖说明为准。',
  assumptions:['投入记负现金流，提出记正现金流，当前加密资产总市值作为期末正现金流。','现金流按北京时间自然日归并，以 365 日为一年；币币兑换和内部账户转账不重复记为外部投入。','C2C 已知渠道估算不代表所有渠道已完成审计；转入已有资产、其他渠道资金及非 USDT 汇率估值可能影响结果。','各日历年缺少完整组合年初、年末净值时不回填收益，也不把当前币种配置当成过去配置。']};
 if(!ledger||!Array.isArray(ledger.flows)||(!ledger.complete&&ledger.scope!=='c2c_known_flows'))return {...base,reason:'尚未提供可核对覆盖范围的外部投入、提出流水。'};
 if(ledger.flows.length>50000)throw new Error('invalid_cashflows');
 const seen=new Set(),groups=new Map();let contributed=new D(0),withdrawn=new D(0),firstBuy=null,firstFlow=null;
 for(const row of [...ledger.flows].sort((a,b)=>a.at_ms-b.at_ms)){
  if(!row||typeof row.id!=='string'||!row.id||row.id.length>250||seen.has(row.id)||!Number.isSafeInteger(row.at_ms)||row.at_ms<1230768000000||row.at_ms>asOfMs)throw new Error('invalid_cashflows');seen.add(row.id);
  const cash=dec(row.amount_usdt);if(cash.isZero())continue;
  firstFlow ??=row.at_ms;
  if(cash.lt(0)){contributed=contributed.sub(cash);firstBuy ??=row.at_ms;}else withdrawn=withdrawn.add(cash);
  const at=day(row.at_ms);groups.set(at,(groups.get(at)||new D(0)).add(cash));
 }
 base.cashflow_count=seen.size;base.contributed_usdt=txt(contributed);base.withdrawn_usdt=txt(withdrawn);base.net_invested_usdt=txt(contributed.sub(withdrawn));base.market_value_usdt=txt(value);base.profit_usdt=txt(value.add(withdrawn).sub(contributed));base.first_flow_at=firstFlow===null?null:iso(firstFlow);base.first_investment_at=firstBuy===null?null:iso(firstBuy);base.scope=ledger.scope||'provided_external_cashflows';
 if(!contributed.gt(0)||firstBuy===null)return {...base,status:'unavailable',reason:'没有可核实的外部投入，不能计算投资年化。'};
 const end=day(asOfMs),start=day(firstFlow);base.period_days=(end-start)/DAY;
 if(end<=start)return {...base,status:'unavailable',reason:'流水时间不足一个北京时间自然日，暂不折算年化。'};
 const from=new Date(firstBuy+28800000).getUTCFullYear(),to=new Date(asOfMs+28800000).getUTCFullYear();
 for(let year=from;year<=to;year++){
  const begin=Date.UTC(year,0,1)-28800000,finish=Date.UTC(year+1,0,1)-28800000,start=Math.max(begin,day(firstBuy)),end=Math.min(finish,asOfMs);
  base.years.push({year,start_at:iso(start),end_at:iso(end),status:'needs_valuations',annualized_return_pct:null,period_return_pct:null,partial_year:start>begin||end<finish,reason:'缺少该年度完整组合的年初、年末净值，暂不能核算年度回报。'});
 }
 groups.set(end,(groups.get(end)||new D(0)).add(value));
 const terms=[...groups].filter(([,amount])=>!amount.isZero()).sort(([a],[b])=>a-b).map(([at,amount])=>({at_ms:at,sign:amount.isNegative()?-1:1,log:Math.log(amount.abs().toNumber()),years:(at-start)/YEAR}));
 base.daily_cashflow_count=groups.size;
 const result=solveSigned(terms);base.status=result.status;base.reason=result.reason;base.root_count=result.root_count??null;
 if(result.rate!==null)base.annualized_return_pct=txt(new D(result.rate).mul(100));
 return base;
}
