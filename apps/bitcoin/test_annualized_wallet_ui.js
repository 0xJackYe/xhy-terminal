'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const api=require('./terminal/dist/combined-wallet.js');
const NOW=Date.parse('2026-10-28T04:00:00Z');
const lifetime={status:'fresh',currency:'USDT',method:'moving_weighted_average',connection_id:'account-a',metrics:{average_cost:'70000',price_usdt:'80000',unrealized_net:'100',unrealized_return_pct:'14.285714'}};
const snapshot={ok:true,updated_at:new Date(NOW).toISOString(),totals:{btc:'0.01',usd:'800',cny:'5600'},sources:[],history:[],pnl:{},lifetime_pnl:lifetime};
const annual={connection_id:'account-a',as_of:new Date(NOW).toISOString(),btc:{status:'estimated',annualized_return_pct:'12.345',first_buy_at:'2024-12-13T16:07:50Z',first_remaining_buy_at:'2024-12-13T16:07:50Z',cashflow_count:20,years:[{year:2024,start_at:'2024-12-13T16:07:50Z',end_at:'2024-12-31T15:59:59Z',partial_year:true,annualized_return_pct:'5.125',period_return_pct:'0.1',status:'estimated'},{year:2025,start_at:'2024-12-31T16:00:00Z',end_at:'2025-12-31T15:59:59Z',partial_year:false,annualized_return_pct:null,period_return_pct:null,status:'unavailable',reason:'该年年末行情尚未核实'}],assumptions:['卖出按移动平均成本比例减少剩余成本，并保留原投入日期。']},portfolio:{status:'needs_cashflows',annualized_return_pct:null,years:[],reason:'缺少完整历史出入金，暂不能核算'}};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
async function settle(){for(let i=0;i<32;i++)await Promise.resolve();}
function harness(){
 const nodes=new Map(),timers=new Map(),requests=[],combinedQueue=[],annualQueue=[];let next=0;
 class Node{
  constructor(id){this.id=id;this.hidden=false;this.disabled=false;this.value='';this.textContent='';this.className='';this.listeners={};this.attrs={};this.classList={add(){}};}
  set innerHTML(value){this._html=value;for(const match of value.matchAll(/\bid="([^"]+)"/g))if(!nodes.has(match[1]))nodes.set(match[1],new Node(match[1]));}
  get innerHTML(){return this._html||'';}
  setAttribute(key,value){this.attrs[key]=value;}
  addEventListener(key,fn){(this.listeners[key]??=[]).push(fn);}
  removeEventListener(key,fn){this.listeners[key]=(this.listeners[key]||[]).filter(x=>x!==fn);}
 }
 nodes.set('combinedWalletPanel',new Node('combinedWalletPanel'));nodes.set('walletPage',new Node('walletPage'));
 const document=new Node('document');document.hidden=false;document.getElementById=id=>nodes.get(id)||null;
 const root=new Node('root');root.AbortController=AbortController;
 async function fetch(url,init){
  requests.push({url,init});assert.ok(['/api/wallet/combined','/api/wallet/annualized'].includes(url));
  const queue=url.endsWith('/annualized')?annualQueue:combinedQueue;
  const data=await (queue.length?queue.shift():structuredClone(url.endsWith('/annualized')?annual:snapshot));
  if(data instanceof Error)throw data;
  return {ok:!data?.http_status||data.http_status<400,json:async()=>data?.http_status?data.body:data};
 }
 const args={root,document,fetch,now:()=>NOW,setTimeout:(fn,delay)=>{const id=++next;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id)};
 const controller=api.mount(args);
 return {node:id=>nodes.get(id),nodes,requests,combinedQueue,annualQueue,timers,controller,settle};
}
test('annualized values live within the holding strip and use their own authenticated read with the same cancellation signal',async t=>{
 const h=harness();t.after(()=>h.controller.destroy());await h.settle();
 assert.deepEqual(h.requests.map(r=>r.url),['/api/wallet/combined','/api/wallet/annualized']);
 assert.equal(h.requests[0].init.signal,h.requests[1].init.signal);
 for(const r of h.requests){assert.equal(r.init.method,'GET');assert.equal(r.init.credentials,'same-origin');assert.equal(r.init.cache,'no-store');}
 assert.equal(h.node('combinedBtcAnnualized').textContent,'+12.35%');assert.equal(h.node('combinedBtcAnnualized').className,'positive');
 assert.equal(h.node('combinedPortfolioAnnualized').textContent,'—');assert.match(h.node('combinedPortfolioAnnualizedNote').textContent,/缺少完整历史出入金/);
 const markup=h.node('combinedWalletPanel').innerHTML;
 const strip=markup.slice(markup.indexOf('<section id="combinedLifetime"'),markup.indexOf('</section>'));
 assert.match(strip,/combinedBtcAnnualized/);assert.match(strip,/combinedPortfolioAnnualized/);assert.match(strip,/逐年回测/);
 assert.equal((markup.match(/<section/g)||[]).length,1);assert.equal(h.node('combinedUnrealizedNet').textContent,'+100.00');
});
test('calendar rows show partial years, preserve missing values and keep unverified periods separate from valid zero',async t=>{
 const h=harness();t.after(()=>h.controller.destroy());await h.settle();
 const html=h.node('combinedAnnualizedDetails').innerHTML;
 assert.match(html,/2024<small>未满年/);assert.match(html,/\+0.10%/);assert.match(html,/\+5.13%/);assert.match(html,/该年年末行情尚未核实/);assert.match(html,/<td>—<\/td><td>—<\/td>/);
 assert.match(html,/按每笔定投的投入日期/);assert.match(html,/不计已实现回款/);
 h.annualQueue.push({...annual,btc:{...annual.btc,annualized_return_pct:'0'},portfolio:{...annual.portfolio,status:'estimated',annualized_return_pct:'-2.5'}});
 await h.controller.refresh();assert.equal(h.node('combinedBtcAnnualized').textContent,'0.00%');assert.equal(h.node('combinedBtcAnnualized').className,'');assert.equal(h.node('combinedPortfolioAnnualized').textContent,'−2.50%');assert.equal(h.node('combinedPortfolioAnnualized').className,'negative');
});
test('annualized refresh failures retain only same-account cached values without changing holding gains or healthy wallet status',async t=>{
 const h=harness();t.after(()=>h.controller.destroy());await h.settle();
 h.annualQueue.push(new Error('private-upstream-error'));await h.controller.refresh();
 assert.equal(h.node('combinedBtcAnnualized').textContent,'+12.35%');assert.match(h.node('combinedBtcAnnualizedNote').textContent,/缓存/);
 assert.equal(h.node('combinedUnrealizedNet').textContent,'+100.00');assert.equal(h.node('combinedState').textContent,'已同步 · 只读');assert.equal(h.node('combinedLifetimeState').textContent,'已核对 · 估算');
 assert.doesNotMatch(h.node('combinedAnnualizedDetails').innerHTML,/private-upstream/);
 h.annualQueue.push({...annual,btc:{...annual.btc,annualized_return_pct:'-4.005'}});await h.controller.refresh();assert.equal(h.node('combinedBtcAnnualized').textContent,'−4.01%');assert.doesNotMatch(h.node('combinedBtcAnnualizedNote').textContent,/缓存/);
});
test('portfolio inception-cost CAGR is visibly distinguished from the BTC remaining-position XIRR even when it has a numeric rate',async t=>{
 const h=harness();t.after(()=>h.controller.destroy());await h.settle();
 const methodNote='按首笔日期及用户提供总本金统一起算的年化估算，并非分笔入金 XIRR。';
 h.annualQueue.push({...annual,portfolio:{status:'estimated',annualized_return_pct:'4.22',method:'inception_cost_cagr_estimate',method_note:methodNote,reason:'历史入金日期不完整',currency:'USDT',years:[{year:2025,status:'unavailable',annualized_return_pct:null,period_return_pct:null,reason:'缺少年末估值'}]}});
 await h.controller.refresh();
 assert.equal(h.node('combinedPortfolioAnnualized').textContent,'+4.22%');assert.equal(h.node('combinedPortfolioAnnualizedNote').textContent,'起点估算');assert.equal(h.node('combinedBtcAnnualizedNote').textContent,'现持仓 XIRR');
 const html=h.node('combinedAnnualizedDetails').innerHTML;
 assert.match(html,/总加密资产 · 起点估算/);assert.ok(html.includes(methodNote));assert.match(html,/缺少年末估值/);assert.doesNotMatch(html,/精确 XIRR/);
 h.annualQueue.push({...annual,portfolio:{status:'estimated',annualized_return_pct:'4.22',method:'inception_cost_cagr_estimate',reason:methodNote,years:[]}});await h.controller.refresh();assert.ok(h.node('combinedAnnualizedDetails').innerHTML.includes(methodNote));
 const escaped=api.annualDetails({...annual,portfolio:{...annual.portfolio,method_note:'<img src=x onerror=alert(1)>',years:annual.btc.years}},false);assert.match(escaped,/&lt;img/);assert.doesNotMatch(escaped,/<img/);
});
test('verified C2C cashflow XIRR names its method and ambiguous portfolio roots cannot hide the valid BTC rate',async t=>{
 const h=harness();t.after(()=>h.controller.destroy());await h.settle();
 h.annualQueue.push({...annual,portfolio:{status:'estimated',annualized_return_pct:'-1.12',method:'cashflow_xirr',method_note:'按已核对 C2C 外部现金流日期核算，未知年末估值不回填。',net_invested_usdt:'1234.56',first_investment_at:'2024-11-28T10:16:48Z',cost_basis_note:'来源备注 <img src=x onerror=alert(1)>',years:[]}});await h.controller.refresh();
 assert.equal(h.node('combinedPortfolioAnnualizedNote').textContent,'资金加权 XIRR');assert.equal(h.node('combinedPortfolioAnnualized').textContent,'−1.12%');assert.match(h.node('combinedAnnualizedDetails').innerHTML,/已核对 C2C 外部现金流/);assert.match(h.node('combinedAnnualizedDetails').innerHTML,/已核对净投入 1,234.56 USDT/);assert.match(h.node('combinedAnnualizedDetails').innerHTML,/首次投入 2024-11-28/);assert.match(h.node('combinedAnnualizedDetails').innerHTML,/&lt;img/);assert.doesNotMatch(h.node('combinedAnnualizedDetails').innerHTML,/<img/);
 h.annualQueue.push({...annual,portfolio:{status:'ambiguous',annualized_return_pct:'999',method:'cashflow_xirr',reason:'多个年化解，暂不选取。',years:[]}});await h.controller.refresh();
 assert.equal(h.node('combinedBtcAnnualized').textContent,'+12.35%');assert.equal(h.node('combinedPortfolioAnnualized').textContent,'—');assert.equal(h.node('combinedPortfolioAnnualizedNote').textContent,'多个年化解，暂不选取。');
});
test('account replacement clears cached rates even if the new annualized request fails',async t=>{
 const h=harness();t.after(()=>h.controller.destroy());await h.settle();
 h.combinedQueue.push({...snapshot,lifetime_pnl:{...lifetime,connection_id:'account-b'}});h.annualQueue.push(new Error('offline'));await h.controller.refresh();
 assert.equal(h.node('combinedBtcAnnualized').textContent,'—');assert.equal(h.node('combinedPortfolioAnnualized').textContent,'—');assert.doesNotMatch(h.node('combinedAnnualizedDetails').innerHTML,/12\.345|2024/);
 h.combinedQueue.push({...snapshot,lifetime_pnl:{...lifetime,connection_id:'account-b'}});h.annualQueue.push({...annual,connection_id:'account-a'});await h.controller.refresh();assert.equal(h.node('combinedBtcAnnualized').textContent,'—');
});
test('a missing or mismatched annualized identity never paints or preserves the prior account rate',async t=>{
 for(const connection_id of [undefined,null,'','account-b']){
  const h=harness();await h.settle();h.annualQueue.push({...annual,connection_id});await h.controller.refresh();assert.equal(h.node('combinedBtcAnnualized').textContent,'—');h.controller.destroy();
 }
});
test('legacy annualized 404, unavailable data and null values cannot fabricate zero or interfere with other wallet data',async t=>{
 const h=harness();t.after(()=>h.controller.destroy());await h.settle();
 h.annualQueue.push({http_status:404,body:{error:'not found'}});h.combinedQueue.push({...snapshot,lifetime_pnl:{...lifetime,connection_id:'account-b'}});await h.controller.refresh();
 assert.equal(h.node('combinedBtcAnnualized').textContent,'—');assert.equal(h.node('combinedUnrealizedNet').textContent,'+100.00');assert.equal(h.node('combinedState').textContent,'已同步 · 只读');
 h.annualQueue.push({...annual,btc:{status:'unavailable',annualized_return_pct:'0',reason:'缺少剩余持仓'}});await h.controller.refresh();assert.equal(h.node('combinedBtcAnnualized').textContent,'—');
});
test('annualized reasons, assumptions and year explanations are escaped, with no executable markup or arbitrary year injection',()=>{
 const bad='<img src=x onerror=alert(1)>';
 const html=api.annualDetails({...annual,btc:{...annual.btc,assumptions:[bad],years:[{year:2024,status:'unavailable',reason:bad},{year:bad,status:'estimated',annualized_return_pct:'2'}]},portfolio:{...annual.portfolio,reason:bad}},false);
 assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|<script|year=/);assert.match(html,/<th scope="row">2024/);
 assert.equal(api.annualValue({status:'needs_cashflows',annualized_return_pct:'99'}),null);assert.equal(api.annualValue({status:'estimated',annualized_return_pct:null}),null);
});
test('destroying a pending annualized request cancels it and prevents late repaint or timers',async()=>{
 const h=harness();await h.settle();const pending=deferred();h.annualQueue.push(pending.promise);const task=h.controller.refresh();await h.settle();
 const before=h.node('combinedBtcAnnualized').textContent,signal=h.requests.at(-1).init.signal;h.controller.destroy();assert.equal(signal.aborted,true);pending.resolve({...annual,btc:{...annual.btc,annualized_return_pct:'99'}});await task;
 assert.equal(h.node('combinedBtcAnnualized').textContent,before);assert.equal(h.timers.size,0);
});
test('the additional metrics share theme variables and collapse to two columns on phones without a second large card',()=>{
 const css=fs.readFileSync(require('node:path').join(__dirname,'terminal/dist/combined-wallet.css'),'utf8');
 assert.match(css,/\.combined-annual-metric small\{[^}]*color:var\(--muted\)/);
 assert.match(css,/@media\(max-width:740px\)\{\.combined-lifetime-metrics\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
 assert.doesNotMatch(css,/\.combined-annual[^}]*#[0-9a-f]{3}/i);
});

test('total profit shows realized plus unrealized portfolio result with its sign, or the reason it is missing',async t=>{
 const h=harness();t.after(()=>h.controller.destroy());
 h.annualQueue.push({...structuredClone(annual),portfolio:{status:'estimated',method:'cashflow_xirr',annualized_return_pct:'-8.1',profit_usdt:'-123.45',contributed_usdt:'1000',withdrawn_usdt:'200',market_value_usdt:'676.55',years:[]}});
 await h.settle();
 assert.equal(h.node('combinedTotalProfit').textContent,'−123.45');assert.equal(h.node('combinedTotalProfit').className,'negative');
 assert.equal(h.node('combinedTotalProfitNote').textContent,'收益率 −12.35%');
 assert.equal(h.node('combinedTotalProfitNote').title,'累计盈亏 = 当前市值 676.55 + 已提出 200.00 − 累计投入 1,000.00 USDT');assert.equal(h.node('combinedTotalProfitCell').title,h.node('combinedTotalProfitNote').title);
 assert.deepEqual(api.totalProfit({profit_usdt:'50',contributed_usdt:'0'}),{profit:'50',percent:null,contributed:'0',withdrawn:null,value:null});
 assert.equal(api.totalProfit({profit_usdt:null}),null);
 const missing=harness();t.after(()=>missing.controller.destroy());
 missing.annualQueue.push({...structuredClone(annual),portfolio:{status:'unavailable',reason:'总资产估值来源尚不完整，暂不计算年化。',years:[]}});
 await missing.settle();
 assert.equal(missing.node('combinedTotalProfit').textContent,'—');assert.equal(missing.node('combinedTotalProfitNote').textContent,'总资产估值来源尚不完整，暂不计算年化。');
});
test('the BTC total names every place it adds up, Binance included',()=>{
 assert.equal(api.sourceScope([{id:'offline'},{id:'binance'},{id:'okx'}]),'欧易 + 币安 + 离线钱包');
 assert.equal(api.sourceScope([{id:'offline'},{id:'okx'}]),'欧易 + 离线钱包');
 assert.equal(api.sourceScope([]),'欧易 + 离线钱包');
 const html=api.renderSources([{id:'okx',btc:'1',status:'fresh'},{id:'binance',btc:'0.25',status:'stale'},{id:'offline',btc:'0.5',status:'fresh'},{id:'evil',btc:'9'}]);
 assert.match(html,/币安 BTC/);assert.match(html,/0\.25/);assert.doesNotMatch(html,/evil/);assert.equal((html.match(/class="combined-source"/g)||[]).length,3);
});

