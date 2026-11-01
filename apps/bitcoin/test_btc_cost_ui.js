'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const api = require('./terminal/dist/btc-cost.js');
const source = fs.readFileSync('terminal/dist/btc-cost.js','utf8');
const css = fs.readFileSync('terminal/dist/btc-cost.css','utf8');
const html = fs.readFileSync('terminal/dist/index.html','utf8');
const NOW = Date.parse('2026-10-26T00:20:00+08:00');
const SNAPSHOT = {
  status:'fresh',connection_id:'account-A',refreshing:false,last_success_at:'2026-10-26T00:20:00+08:00',error:null,plan_daily_usdt:'20',coverage_complete:true,
  summary:{buy_count:2715,sell_count:526,bought_btc:'0.0752144095130917',sold_btc:'0.00671622',net_bought_btc:'0.0684981895130917',by_currency:[
    {currency:'USDT',buy_spent:'6006.106642188',sell_received:'579.286659293834',net_invested:'5426.819982894166'},
    {currency:'USDC',buy_spent:'4.2799999999966037',sell_received:'0',net_invested:'4.2799999999966037'},
    {currency:'ETH',buy_spent:'0.00392211',sell_received:'0',net_invested:'0.00392211'}]},
  today:{date_beijing:'2026-10-26',buy_count:3,buy_spent_usdt:'5.9999',bought_btc:'0.000075',remaining_plan_usdt:'14.0001'},
  recent_trades:[{id:'123',time_beijing:'2026-10-26T00:10:12.500+08:00',side:'buy',price:'80367.6',quote_ccy:'USDT',quote_amount:'1.999545888',btc_net:'0.00002485512',fee_btc:'-0.00000002488'},
    {id:'124',time_beijing:'2026-10-25T23:10:00+08:00',side:'sell',price:'80000',quote_ccy:'USDT',quote_amount:'10',btc_net:'-0.000125',fee_btc:'0'}]
};
function deferred() { let resolve,reject;const promise = new Promise((yes,no)=>{resolve=yes;reject=no;});return {resolve,reject,promise}; }
async function settle() { for(let i=0;i<5;i++) await new Promise(setImmediate); }
function harness(options={}) {
  const nodes = new Map(),timers = new Map(),requests = [],responses = [...(options.responses || [])];let nextTimer=0,now=options.now || NOW;
  class Node {
    constructor(id) { this.id=id;this.hidden=false;this.disabled=false;this.textContent='';this._innerHTML='';this.listeners={};this.attrs={};this.style={};this.className='';this.open=false;this.classList={add(){}}; }
    set innerHTML(value) { this._innerHTML=value;for(const match of value.matchAll(/\bid="([^"]+)"/g)) if(!nodes.has(match[1])) nodes.set(match[1],new Node(match[1])); }
    get innerHTML() { return this._innerHTML; }
    setAttribute(key,value) { this.attrs[key]=String(value); }
    removeAttribute(key) { delete this.attrs[key]; }
    addEventListener(event,handler) { (this.listeners[event] ??= []).push(handler); }
    removeEventListener(event,handler) { this.listeners[event]=(this.listeners[event] || []).filter(fn=>fn!==handler); }
    async fire(event,detail={}) { for(const handler of this.listeners[event] || []) handler({target:this,...detail});await settle(); }
  }
  nodes.set('btcCostPanel',new Node('btcCostPanel'));nodes.set('walletPage',new Node('walletPage'));nodes.get('walletPage').hidden=!!options.hidden;
  const document=new Node('document');document.hidden=false;document.getElementById=id=>nodes.get(id) || null;
  const root=new Node('root');root.document=document;root.AbortController=class { constructor(){this.signal={aborted:false};}abort(){this.signal.aborted=true;} };
  const setTimeout=(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,delay});return id;},clearTimeout=id=>timers.delete(id);
  async function fetch(url,init) { requests.push({url,init});let value=responses.length?responses.shift():structuredClone(SNAPSHOT);if(typeof value==='function')value=value(requests.at(-1));value=await value;if(value instanceof Error)throw value;return {ok:!(value && value.http_status>=400),json:async()=>value && value.http_status?value.data:value}; }
  const args={root,document,fetch,setTimeout,clearTimeout,now:()=>now},controller=api.mount(args);
  async function tick(delay=api.REFRESH_MS) { const timer=[...timers].find(([,value])=>value.delay===delay);assert.ok(timer,'expected timer '+delay);timers.delete(timer[0]);timer[1].fn();await settle(); }
  return {node:id=>nodes.get(id),nodes,root,document,requests,responses,timers,args,controller,tick,settle,setNow:value=>{now=value;}};
}
let checks=0;
async function check(name,fn) { await fn();checks++;console.log('OK '+name); }
(async()=>{
  await check('the ledger names its exchanges and totals net investment across quote currencies',async()=>{
    const both={...SNAPSHOT,venues:['okx','binance'],binance_history:{status:'included',records:3,error:null},summary:{...SNAPSHOT.summary,net_invested_usdt:'5500.5'}};
    let h=harness({responses:[both]});await h.settle();
    assert.equal(h.node('btcCostVenues').textContent,'欧易 + 币安');assert.equal(h.node('btcCostNetUSDT').textContent,'5,500.50');assert.match(h.node('btcCostNetUSDT').title,/全部 BTC/);
    h=harness({responses:[{...SNAPSHOT,venues:['okx'],binance_history:{status:'error',records:0,error:'币安成交与已核对的欧易账本无法衔接 <b>'}}]});await h.settle();
    assert.equal(h.node('btcCostVenues').textContent,'欧易 · 币安未并入');assert.match(h.node('btcCostVenues').title,/无法衔接/);assert.equal(h.node('btcCostNetUSDT').textContent,'5,426.82');
    h=harness({responses:[{...SNAPSHOT,venues:['okx'],binance_history:{status:'importing',records:0,error:null}}]});await h.settle();
    assert.equal(h.node('btcCostVenues').textContent,'欧易 · 币安导入中');
  });
  await check('absent mount target has no side effects',()=>assert.equal(api.mount({root:{},document:{getElementById:()=>null}}),null));
  await check('fixed decimal strings retain exact BTC and large integer values',()=>{
    assert.equal(api.exact('0.0684981895130917'),'0.0684981895130917');
    assert.equal(api.exact('9007199254740993.0000000000000001'),'9,007,199,254,740,993.0000000000000001');
    assert.equal(api.exact('999.995',2,true),'1,000.00');assert.equal(api.exact('-0.005',2,true),'−0.01');assert.equal(api.exact('-0.000',2,true),'0.00');
  });
  await check('missing malformed and numeric values never become zero',()=>{
    for(const value of [null,undefined,0,false,{},[],'',' ','NaN','Infinity','1e3','.2','--1','<script>','9'.repeat(181)]) { assert.equal(api.decimal(value),null);assert.equal(api.exact(value),'—'); }
    assert.equal(api.exact('0'),'0');assert.equal(api.exact('1',17),'—');assert.equal(api.count(null),'—');assert.equal(api.count('2'),'—');assert.equal(api.count(0),'0');
  });
  await check('daily percentage uses exact integer arithmetic and clamps only its display',()=>{
    assert.equal(api.progress('5','20'),25);assert.equal(api.progress('40','20'),100);assert.equal(api.progress('0','20'),0);assert.equal(api.progress('19.99999999999999999','20'),99.99);
    for(const pair of [[null,'20'],['-1','20'],['1','0'],['1','-20']])assert.equal(api.progress(...pair),null);
  });
  await check('Beijing times and day boundary are independent of machine timezone',()=>{
    assert.equal(api.beijing('2026-10-25T16:10:12Z'),'2026-10-26 00:10:12');assert.equal(api.todayDate(NOW),'2026-10-26');assert.equal(api.beijing('bad'),'—');
    assert.equal(api.currentToday({...SNAPSHOT,today:{...SNAPSHOT.today,date_beijing:'2026-10-25'}},NOW),null);
  });
  await check('net investment uses only its labeled USDT currency and keeps exact BTC quantity',async()=>{
    const data=structuredClone(SNAPSHOT);data.summary.by_currency.reverse();const h=harness({responses:[data]});await h.settle();
    assert.equal(h.node('btcCostNetUSDT').textContent,'5,426.82');assert.equal(h.node('btcCostNetBTC').textContent,'0.06849819');assert.equal(h.node('btcCostNetBTC').title,'0.0684981895130917 BTC');assert.match(h.node('btcCostPanel').innerHTML,/USDT 实际支出减卖出回款/);
  });
  await check('malformed amount count date and server error fields cannot inject HTML or CSS',async()=>{
    const attack='<img src=x onerror=alert(1)>',data=structuredClone(SNAPSHOT);data.summary.net_bought_btc=attack;data.summary.buy_count=attack;data.summary.by_currency[0].net_invested=attack;data.last_success_at=attack;data.error=attack;data.today.buy_spent_usdt=attack;data.today.remaining_plan_usdt=attack;data.recent_trades=[{side:attack}];
    const h=harness({responses:[data]});await h.settle();assert.equal(h.node('btcCostNetUSDT').textContent,'—');assert.equal(h.node('btcCostNetBTC').textContent,'—');assert.equal(h.node('btcCostTodaySpent').textContent,'—');assert.equal(h.node('btcCostProgressFill').style.width,'0%');
    for(const node of h.nodes.values()) { assert.doesNotMatch(node.innerHTML,/<img|onerror|alert\(/);assert.doesNotMatch(node.textContent,/<img|onerror|alert\(/); }
  });
  await check('visible panel loads only local read API and displays actual plan progress',async()=>{
    const h=harness();await h.settle();assert.equal(h.requests.length,1);assert.equal(h.requests[0].url,'/api/wallet/btc-cost');assert.equal(h.requests[0].init.method,'GET');assert.equal(h.requests[0].init.cache,'no-store');assert.equal(h.requests[0].init.credentials,'same-origin');
    assert.equal(h.node('btcCostNetUSDT').textContent,'5,426.82');assert.equal(h.node('btcCostNetBTC').textContent,'0.06849819');assert.equal(h.node('btcCostNetBTC').title,'0.0684981895130917 BTC');assert.equal(h.node('btcCostTodaySpent').textContent,'6.00');assert.match(h.node('btcCostDailyDetail').textContent,/3 笔 · 距计划 14.00 USDT/);assert.equal(h.node('btcCostProgressFill').style.width,'29.99%');assert.equal(h.node('btcCostState').textContent,'已同步 · 只读');
  });
  await check('removed payment table recent fills and explanation stay absent through refreshes',async()=>{
    const h=harness();await h.settle();await h.tick();assert.equal(h.requests.length,2);assert.equal(h.node('btcCostState').textContent,'已同步 · 只读');
    for(const id of ['btcCostCurrencyRows','btcCostDetails','btcCostRecentCount','btcCostTradeRows'])assert.equal(h.node(id),undefined);
    assert.doesNotMatch(h.node('btcCostPanel').innerHTML,/<table|<details|最近成交|其他支付币分别列于下表|净投入＝/);assert.match(h.node('btcCostUpdated').textContent,/最近同步/);
  });
  await check('zero actual fills show zero while absent fields stay unavailable',async()=>{
    const data=structuredClone(SNAPSHOT);data.today={date_beijing:'2026-10-26',buy_count:0,buy_spent_usdt:'0',bought_btc:'0',remaining_plan_usdt:'20'};data.summary.net_bought_btc=null;data.summary.by_currency[0].net_invested=null;
    const h=harness({responses:[data]});await h.settle();assert.equal(h.node('btcCostTodaySpent').textContent,'0.00');assert.equal(h.node('btcCostNetBTC').textContent,'—');assert.equal(h.node('btcCostNetUSDT').textContent,'—');assert.match(h.node('btcCostDailyDetail').textContent,/0 笔/);
  });
  await check('spending beyond the daily plan is never hidden or counted as a future order',async()=>{
    const data={...SNAPSHOT,today:{...SNAPSHOT.today,buy_spent_usdt:'22.5',remaining_plan_usdt:'-2.5'}};const h=harness({responses:[data]});await h.settle();assert.equal(h.node('btcCostTodaySpent').textContent,'22.50');assert.equal(h.node('btcCostProgressFill').style.width,'100%');assert.match(h.node('btcCostDailyDetail').textContent,/超出计划 2.50 USDT/);
  });
  await check('stale daily data cannot masquerade as current day actual purchases',async()=>{
    const data={...SNAPSHOT,today:{...SNAPSHOT.today,date_beijing:'2026-10-25'}};const h=harness({responses:[data]});await h.settle();assert.equal(h.node('btcCostTodaySpent').textContent,'—');assert.match(h.node('btcCostDailyDetail').textContent,/等待今日/);assert.equal(h.node('btcCostProgress').attrs['aria-valuenow'],undefined);assert.equal(h.node('btcCostNetUSDT').textContent,'5,426.82');
  });
  await check('first-time loading and unavailable states do not invent historic cost',async()=>{
    const h=harness({responses:[{status:'loading',connection_id:'account-A',refreshing:true,last_success_at:null,plan_daily_usdt:'20',coverage_complete:false,summary:null,today:null,recent_trades:[]}]});await h.settle();assert.equal(h.node('btcCostNetUSDT').textContent,'—');assert.equal(h.node('btcCostTodaySpent').textContent,'—');assert.equal(h.node('btcCostState').textContent,'正在补齐记录');assert.match(h.node('btcCostMessage').textContent,/历史记录补齐/);assert.equal(h.node('btcCostUpdated').textContent,'等待首次同步');
  });
  await check('refresh and HTTP authorization errors retain known costs without exposing private errors',async()=>{
    const h=harness();await h.settle();for(const value of [new Error('sk-private-token'),{http_status:401,data:{error:'private-secret'}},{http_status:503,data:null}]) { h.responses.push(value);await h.tick();assert.equal(h.node('btcCostNetUSDT').textContent,'5,426.82');assert.equal(h.node('btcCostState').textContent,'待同步 · 保留记录');assert.match(h.node('btcCostMessage').textContent,/保留上次/);assert.doesNotMatch(h.node('btcCostMessage').textContent,/private|token|secret/);assert.match(h.node('btcCostUpdated').textContent,/2026-10-26 00:20:00/); }
  });
  await check('malformed or absent snapshots cannot clear last valid balances',async()=>{
    const h=harness();await h.settle();for(const bad of [null,[],{},false,{...SNAPSHOT,summary:[]},{...SNAPSHOT,recent_trades:null},{...SNAPSHOT,status:'oops'},{...SNAPSHOT,summary:null,today:null,status:'loading'}]) { h.responses.push(bad);await h.tick();assert.equal(h.node('btcCostNetBTC').textContent,'0.06849819');assert.equal(h.node('btcCostNetBTC').title,'0.0684981895130917 BTC');assert.equal(h.node('btcCostState').textContent,'待同步 · 保留记录'); }
  });
  await check('older successful snapshots cannot roll accumulated cost backwards',async()=>{
    const h=harness();await h.settle();const data=structuredClone(SNAPSHOT);data.last_success_at='2026-10-25T00:00:00+08:00';data.summary.by_currency[0].net_invested='1';h.responses.push(data);await h.tick();assert.equal(h.node('btcCostNetUSDT').textContent,'5,426.82');assert.equal(h.node('btcCostState').textContent,'待同步 · 保留记录');
  });
  await check('switching account removes old cost even when the new account has no history',async()=>{
    const h=harness();await h.settle();h.responses.push({...SNAPSHOT,connection_id:'account-B',status:'unavailable',summary:null,today:null,recent_trades:[],last_success_at:null,error:'needs_history'});await h.tick();
    assert.equal(h.node('btcCostNetUSDT').textContent,'—');assert.equal(h.node('btcCostNetBTC').textContent,'—');assert.equal(h.node('btcCostTodaySpent').textContent,'—');assert.equal(h.node('btcCostCounts').textContent,'—');assert.equal(h.node('btcCostUpdated').textContent,'等待首次同步');
  });
  await check('switching account accepts its independent older successful history',async()=>{
    const h=harness();await h.settle();const data=structuredClone(SNAPSHOT);data.connection_id='account-B';data.last_success_at='2026-10-25T00:00:00+08:00';data.summary.by_currency[0].net_invested='1';h.responses.push(data);await h.tick();assert.equal(h.node('btcCostNetUSDT').textContent,'1.00');
  });
  await check('removing the configured account clears all former account data',async()=>{
    const h=harness();await h.settle();h.responses.push({...SNAPSHOT,connection_id:null,status:'unavailable',summary:null,today:null,recent_trades:[],last_success_at:null});await h.tick();assert.equal(h.node('btcCostNetUSDT').textContent,'—');assert.equal(h.node('btcCostNetBTC').textContent,'—');assert.equal(h.node('btcCostUpdated').textContent,'等待首次同步');
  });
  await check('missing or malformed account identity cannot clear a valid account cache',async()=>{
    const h=harness();await h.settle();for(const connection_id of [undefined,{},[],false,'a'.repeat(129)]) { h.responses.push({...SNAPSHOT,connection_id,summary:null,today:null,recent_trades:[]});await h.tick();assert.equal(h.node('btcCostNetUSDT').textContent,'5,426.82');assert.equal(h.node('btcCostState').textContent,'待同步 · 保留记录'); }
  });
  await check('first failure and later recovery display honest unavailable then verified states',async()=>{
    const h=harness({responses:[new Error('network')]});await h.settle();assert.equal(h.node('btcCostNetUSDT').textContent,'—');assert.equal(h.node('btcCostState').textContent,'暂时无法连接');await h.tick();assert.equal(h.node('btcCostState').textContent,'已同步 · 只读');assert.equal(h.node('btcCostMessage').hidden,true);
  });
  await check('stale backend status and old timestamps remain visible',async()=>{
    const h=harness({responses:[{...SNAPSHOT,status:'stale',error:'raw secret'}]});await h.settle();assert.equal(h.node('btcCostState').textContent,'待同步 · 保留记录');assert.doesNotMatch(h.node('btcCostMessage').textContent,/secret/);h.setNow(NOW+90001);h.responses.push(SNAPSHOT);await h.tick();assert.equal(h.node('btcCostState').textContent,'待同步 · 保留记录');
  });
  await check('hidden wallet never polls and navigation starts exactly one chain',async()=>{
    const h=harness({hidden:true});await h.settle();assert.equal(h.requests.length,0);assert.equal(h.timers.size,0);h.node('walletPage').hidden=false;await h.root.fire('hashchange');assert.equal(h.requests.length,1);h.node('walletPage').hidden=true;await h.root.fire('hashchange');assert.equal(h.timers.size,0);
  });
  await check('visibility and page lifecycle suspend reads and preserve existing values',async()=>{
    const h=harness();await h.settle();h.document.hidden=true;await h.document.fire('visibilitychange');assert.equal(h.timers.size,0);h.document.hidden=false;await h.document.fire('visibilitychange');assert.equal(h.requests.length,2);await h.root.fire('pagehide');assert.equal(h.timers.size,0);await h.root.fire('pageshow');assert.equal(h.requests.length,3);assert.equal(h.timers.size,1);
  });
  await check('concurrent clicks and navigation coalesce to one in-flight request',async()=>{
    const h=harness();await h.settle();const pending=deferred();h.responses.push(pending.promise);const read=h.controller.refresh();await h.settle();await h.node('btcCostRefresh').fire('click');await h.root.fire('hashchange');await h.document.fire('visibilitychange');assert.equal(h.requests.length,2);assert.equal(h.node('btcCostRefresh').disabled,true);pending.resolve(SNAPSHOT);await read;assert.equal(h.timers.size,1);
  });
  await check('timeouts recover even when an aborted upstream fetch never settles',async()=>{
    const h=harness();await h.settle();const pending=deferred();h.responses.push(pending.promise);const read=h.controller.refresh();await h.settle();await h.tick(api.REQUEST_TIMEOUT_MS);await read;assert.equal(h.requests[1].init.signal.aborted,true);assert.equal(h.node('btcCostRefresh').disabled,false);assert.equal(h.node('btcCostNetUSDT').textContent,'5,426.82');assert.equal(h.node('btcCostState').textContent,'待同步 · 保留记录');await h.tick();assert.equal(h.requests.length,3);pending.resolve({...SNAPSHOT,summary:null});await h.settle();assert.equal(h.node('btcCostNetUSDT').textContent,'5,426.82');
  });
  await check('hiding the tab aborts requests and late replies cannot redraw or restart polling',async()=>{
    const h=harness();await h.settle();const pending=deferred();h.responses.push(pending.promise);h.controller.refresh();await h.settle();h.node('walletPage').hidden=true;await h.root.fire('hashchange');assert.equal(h.requests[1].init.signal.aborted,true);assert.equal(h.timers.size,0);const changed=structuredClone(SNAPSHOT);changed.summary.by_currency[0].net_invested='1';pending.resolve(changed);await h.settle();assert.equal(h.node('btcCostNetUSDT').textContent,'5,426.82');assert.equal(h.timers.size,0);h.node('walletPage').hidden=false;await h.root.fire('hashchange');assert.equal(h.requests.length,3);
  });
  await check('destroy aborts pending reads and duplicate mount creates no extra controller',async()=>{
    const pending=deferred(),h=harness({responses:[pending.promise]});await h.settle();assert.equal(api.mount(h.args),h.controller);assert.equal(h.requests.length,1);h.controller.destroy();assert.equal(h.requests[0].init.signal.aborted,true);assert.equal(h.timers.size,0);pending.resolve(SNAPSHOT);await h.settle();assert.equal(h.node('btcCostNetUSDT').textContent,'—');await h.root.fire('hashchange');assert.equal(h.requests.length,1);
  });
  await check('historical activity labels fills explicitly instead of implying submitted orders',async()=>{
    const h=harness();await h.settle();assert.equal(h.node('btcCostCounts').textContent,'买入 2715 条成交 · 卖出 526 条成交');assert.doesNotMatch(h.node('btcCostCounts').textContent,/订单|526 笔/);
    const data=structuredClone(SNAPSHOT);data.summary.buy_count=-1;data.summary.sell_count='526';h.responses.push(data);await h.tick();assert.equal(h.node('btcCostCounts').textContent,'买入 — 条成交 · 卖出 — 条成交');
  });
  await check('new assets are connected to the wallet panel without writes or credential persistence',()=>{
    assert.match(html,/href="\/btc-cost\.css"/);assert.match(html,/src="\/btc-cost\.js" defer/);assert.match(html,/id="combinedWalletPanel"[\s\S]*id="btcCostPanel"[\s\S]*id="cryptoPortfolioPanel"/);
    assert.doesNotMatch(source,/localStorage|sessionStorage|document\.cookie|console\.(?:log|error)|api_key|secret_key|passphrase|method:\s*['"](?:POST|PUT|DELETE)|\/trade\/|\/withdrawal|\/transfer/);
    assert.match(css,/@media\(max-width:740px\)/);assert.match(css,/\.focus-wallet \.btc-cost\{display:none!important\}/);assert.doesNotMatch(css,/btc-cost-currenc|btc-cost-trades|btc-cost-details/);assert.doesNotMatch(source,/btcCostCurrencyRows|btcCostTradeRows|btcCostDetails|btcCostRecentCount/);
  });
  console.log(checks+' BTC cost UI checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
