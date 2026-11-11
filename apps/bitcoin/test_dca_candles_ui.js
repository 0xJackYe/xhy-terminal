'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const api=require('./terminal/dist/dca-candles.js');
const DAY=86400000,D=date=>Date.parse(date+'T00:00:00Z'),NOW=D('2026-11-11')+3600000;
const rows=Array.from({length:Math.round((D('2026-11-11')-D(api.START))/DAY)+1},(_,i)=>({time:new Date(D(api.START)+i*DAY).toISOString().slice(0,10),open:String(100+i),high:String(105+i),low:String(98+i),close:String(101+i),volume:'12.4'}));
const SNAPSHOT={status:'fresh',timezone:'Asia/Shanghai',symbol:'BTCUSDT',interval:'1d',start_date:api.START,as_of:new Date(NOW).toISOString(),source:'Binance Spot',coverage_complete:true,candles:rows};
function buys(){return {connectionId:'account-a',days:new Map([[D('2024-12-14'),{btc:100000,usdt:2000,buys:2,exactBTC:'0.0010000049',exactUSDT:'20.005501'}],[D('2026-11-10'),{btc:200000,usdt:10000,buys:1}]])};}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(setImmediate);};
function harness(options={}){
  const nodes=new Map(),timers=new Map(),requests=[],responses=[...(options.responses||[])],observers=[];let nextTimer=0,chartCount=0;
  class Node{
    constructor(id){this.id=id;this.listeners={};this.attrs={};this.dataset={};this.style={};this.hidden=false;this.textContent='';this.clientWidth=900;this.clientHeight=460;this.offsetWidth=190;this.offsetHeight=90;this.value='';this.isConnected=true;this.tagName='DIV';}
    set innerHTML(value){this._html=value;for(const match of value.matchAll(/\bid="([^"]+)"/g))if(!nodes.has(match[1]))nodes.set(match[1],new Node(match[1]));for(const match of value.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)){const item=nodes.get(match[1]);if(item)item.hidden=/\bhidden(?:[ >])/.test(match[0]);}this.firstElementChild=nodes.get('dcaCandleSheet');}
    get innerHTML(){return this._html||'';}
    append(child){child.parentElement=this;child.parentNode=this;}
    remove(){this.isConnected=false;nodes.delete(this.id);}
    focus(){document.activeElement=this;}
    setAttribute(key,value){this.attrs[key]=String(value);}
    querySelectorAll(selector){if(this.id==='dcaCandleRanges')return ['year','all','first','latest'].map(view=>({dataset:{view},setAttribute:(key,value)=>{this.attrs[view+':'+key]=String(value);}}));return ['dcaCandleClose','dcaCandleJump','dcaCandleZoomIn','dcaCandleZoomOut','dcaCandleChart'].map(id=>nodes.get(id));}
    addEventListener(event,handler){(this.listeners[event]??=[]).push(handler);}
    removeEventListener(event,handler){this.listeners[event]=(this.listeners[event]||[]).filter(item=>item!==handler);}
    async fire(event,detail={}){for(const fn of this.listeners[event]||[])fn({target:this,preventDefault(){},...detail});await settle();}
  }
  const document=new Node('document');document.hidden=false;document.body=new Node('body');document.documentElement=new Node('html');document.getElementById=id=>nodes.get(id)||null;document.createElement=()=>new Node('host');
  const opener=new Node('opener');document.activeElement=opener;
  const colors={'--card':'#faf8f2','--text':'#292923','--muted':'#7b7b6c','--line':'#dedbd1','--accent':'#bd694d','--green':'#38775a','--red':'#ad5847'};
  const root=new Node('root');root.document=document;root.parent=root;root.getComputedStyle=()=>({getPropertyValue:key=>colors[key]||''});root.AbortController=class{constructor(){this.signal={aborted:false};}abort(){this.signal.aborted=true;}};
  root.ResizeObserver=class{constructor(fn){this.fn=fn;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}};
  root.MutationObserver=root.ResizeObserver;
  let range={from:0,to:100};const rangeCalls=[];
  const scale={fitContent(){range={from:0,to:rows.length};rangeCalls.push({...range});},setVisibleLogicalRange(value){range={...value};rangeCalls.push({...range});},getVisibleLogicalRange:()=>({...range})};
  const series={sets:[],updates:[],options:[],setData(value){this.sets.push(value);if(options.mutateInput)for(const row of value){const [year,month,day]=row.time.split('-').map(Number);row.time={year,month,day};}},update(value){this.updates.push(value);},applyOptions(value){this.options.push(value);}};
  const marker={sets:[],setMarkers(value){this.sets.push(value);},detach(){this.detached=true;}};
  const chart={options:[],applyOptions(value){this.options.push(value);},addSeries:()=>series,timeScale:()=>scale,subscribeCrosshairMove(fn){this.crosshair=fn;},subscribeClick(fn){this.click=fn;},remove(){this.removed=true;}};
  const library={CandlestickSeries:{type:'candlestick'},createChart(node,config){chartCount++;chart.config=config;return chart;},createSeriesMarkers:()=>marker};
  const setTimeout=(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,delay});return id;},clearTimeout=id=>timers.delete(id);
  async function fetch(url,init){requests.push({url,init});let value=responses.length?responses.shift():SNAPSHOT;value=await value;if(value instanceof Error)throw value;return {ok:!value.http_status||value.http_status<400,json:async()=>value};}
  const args={root,document,fetch,setTimeout,clearTimeout,now:()=>NOW,charts:options.noLibrary?{}:library},controller=api.mount(args);
  async function tick(delay=api.REFRESH_MS){const next=[...timers].find(([,value])=>value.delay===delay);assert.ok(next,'Expected timer '+delay);timers.delete(next[0]);next[1].fn();await settle();}
  async function click(id,view){const button=nodes.get(id)||{id,dataset:{}};if(view)button.dataset.view=view;await nodes.get('dcaCandleSheet').fire('click',{target:{closest:()=>button}});}
  return {root,document,node:id=>nodes.get(id),nodes,timers,requests,responses,chart,series,marker,rangeCalls,range:()=>range,colors,observers,opener,controller,args,tick,click,settle,chartCount:()=>chartCount};
}
let count=0;async function check(name,fn){await fn();count++;console.log('OK '+name);}
(async()=>{
  await check('daily times are Beijing business dates, not browser-local timestamps',()=>{
    assert.equal(api.START,'2024-07-01');assert.equal(api.dateKey({year:2024,month:12,day:14}),'2024-12-14');assert.equal(api.dateKey('2024-12-14'),'2024-12-14');
    for(const invalid of ['2025-02-29','2024-7-01','bad',1719763200,null])assert.equal(api.dateKey(invalid),null);
  });
  await check('OHLC payloads reject malformed days prices duplicate rows and wrong day boundaries',()=>{
    assert.equal(api.normalized(SNAPSHOT).candles.length,rows.length);
    for(const data of [{...SNAPSHOT,timezone:'UTC'},{...SNAPSHOT,interval:'1h'},{...SNAPSHOT,symbol:'ETHUSDT'},{...SNAPSHOT,candles:[rows[0],rows[0]]},{...SNAPSHOT,candles:[{...rows[0],low:'9999'}]},{...SNAPSHOT,candles:[{...rows[0],open:'NaN'}]},{...SNAPSHOT,candles:[{...rows[0],time:'2024-06-30'}]}])assert.equal(api.normalized(data),null);
    assert.deepEqual(api.normalized({...SNAPSHOT,candles:[rows[1],rows[0]]}).candles.map(row=>row.time),[rows[0].time,rows[1].time]);
  });
  await check('buy labels use exact net amounts, aggregate one B per buying day, and preserve missing valuation',()=>{
    const data=buys();data.days.set(D('2026-11-11'),{btc:123,usdt:null,buys:1});const map=api.purchases(data),markers=api.markerRows(map,api.normalized(SNAPSHOT).candles,'#f7931a');
    assert.equal(markers.length,3);assert.ok(markers.every(marker=>marker.text==='B'&&marker.position==='belowBar'));assert.equal(map.get('2024-12-14').usdt,'20.005501');assert.equal(map.get('2026-11-11').usdt,null);
    assert.equal(api.markerRows(map,[rows[0]],'#fff').length,0,'a missing candle never moves a purchase onto a different day');
    assert.equal(api.amount('20.005501'),'20.01');assert.equal(api.amount('9007199254740993.995'),'9,007,199,254,740,994.00');assert.equal(api.amount(null),'—');
  });
  await check('initial mount is dormant and the chart loads only when its popup opens',async()=>{
    const h=harness();assert.equal(h.node('dcaCandleSheet').hidden,true);assert.equal(h.requests.length,0);assert.equal(h.chartCount(),0);assert.equal(h.timers.size,0);
    h.controller.open(buys());await h.settle();assert.equal(h.chartCount(),1);assert.equal(h.requests.length,1);assert.equal(h.requests[0].url,'/api/wallet/btc-dca-candles');assert.equal(h.requests[0].init.method,'GET');assert.equal(h.requests[0].init.credentials,'same-origin');assert.equal(h.series.sets[0].length,rows.length);
    assert.equal(h.node('dcaCandleSheet').parentElement,h.document.body);assert.equal(h.node('dcaCandleEmpty').hidden,true);assert.match(h.node('dcaCandleState').textContent,/实时同步/);
    assert.equal(api.mount(h.args),h.controller);h.controller.destroy();
  });
  await check('hovering B shows that Beijing day USDT BTC and fill count; unknown USDT is explicit',async()=>{
    const h=harness(),model=buys();model.days.set(D('2026-11-11'),{btc:123,usdt:null,buys:1});h.controller.open(model);await h.settle();
    h.chart.crosshair({time:{year:2024,month:12,day:14},hoveredObjectId:'buy-2024-12-14',point:{x:240,y:320}});
    assert.equal(h.node('dcaCandleTip').hidden,false);assert.equal(h.node('dcaCandleTipDate').textContent,'2024-12-14 · B 买入');assert.equal(h.node('dcaCandleTipUSDT').textContent,'20.01 USDT');assert.match(h.node('dcaCandleTipDetail').textContent,/0.00100000 BTC · 2 笔成交/);
    h.chart.crosshair({time:'2026-11-11',hoveredObjectId:'buy-2026-11-11',point:{x:800,y:420}});assert.equal(h.node('dcaCandleTipUSDT').textContent,'USDT 金额待核对');
    h.chart.crosshair({time:'2024-07-01',point:{x:5,y:6}});assert.equal(h.node('dcaCandleTip').hidden,true);h.controller.destroy();
  });
  await check('tail polling updates candles in place and preserves the user pan and zoom',async()=>{
    const h=harness();h.controller.open(buys());await h.settle();h.chart.timeScale().setVisibleLogicalRange({from:20,to:80});
    h.responses.push({...SNAPSHOT,mode:'tail',as_of:new Date(NOW+5000).toISOString(),candles:[rows.at(-2),{...rows.at(-1),close:String(Number(rows.at(-1).close)+1)}]});await h.tick();
    assert.equal(h.requests[1].url,'/api/wallet/btc-dca-candles?tail=1');assert.equal(h.series.sets.length,1);assert.ok(h.series.updates.length>=1);assert.equal(h.series.updates.at(-1).close,Number(rows.at(-1).close)+1);assert.deepEqual(h.range(),{from:20,to:80});h.controller.destroy();
  });
  await check('chart-library input normalization cannot mutate application dates or erase B markers',async()=>{
    const h=harness({mutateInput:true});h.controller.open(buys());await h.settle();
    assert.match(h.node('dcaCandleCoverage').textContent,/2024-07-01 — 2026-11-11/);assert.doesNotMatch(h.node('dcaCandleCoverage').textContent,/object Object/);
    assert.equal(h.marker.sets.at(-1).length,2);await h.click('range','first');assert.equal(h.node('dcaCandleDay').textContent,'2024-12-14 · 北京时间');
    h.responses.push({...SNAPSHOT,mode:'tail',as_of:new Date(NOW+5000).toISOString(),candles:rows.slice(-2)});await h.tick();
    assert.equal(h.requests[1].url,'/api/wallet/btc-dca-candles?tail=1');assert.equal(h.marker.sets.at(-1).length,2);h.controller.destroy();
  });
  await check('reopening after a multi-day interruption requests missing full history instead of joining a gap',async()=>{
    const h=harness({responses:[{...SNAPSHOT,candles:rows.slice(0,3)},{...SNAPSHOT,mode:'tail',candles:rows.slice(6,8)},SNAPSHOT]});h.controller.open(buys());await h.settle();await h.tick();assert.match(h.node('dcaCandleState').textContent,/补齐/);await h.tick(0);
    assert.equal(h.requests[2].url,'/api/wallet/btc-dca-candles');assert.equal(new Set([...h.series.sets.at(-1),...h.series.updates].map(row=>row.time)).size,rows.length);h.controller.destroy();
  });
  await check('quick ranges date jumps zoom buttons and arrow keys retain every historical bar',async()=>{
    const h=harness();h.controller.open(buys(),'2024-12-14');await h.settle();assert.equal(h.node('dcaCandleDate').value,'2024-12-14');
    await h.click('range','all');assert.equal(h.range().to,rows.length);await h.click('range','first');assert.equal(h.node('dcaCandleDay').textContent,'2024-12-14 · 北京时间');
    const before=h.range().to-h.range().from;await h.click('dcaCandleZoomIn');assert.ok(h.range().to-h.range().from<before);
    h.node('dcaCandleDate').value='2025-06-01';await h.click('dcaCandleJump');assert.equal(h.node('dcaCandleDay').textContent,'2025-06-01 · 北京时间');
    const left=h.range().from;await h.node('dcaCandleSheet').fire('keydown',{key:'ArrowLeft'});assert.ok(h.range().from<left);assert.equal(h.series.sets[0].length,rows.length);h.controller.destroy();
  });
  await check('failed or invalid refresh retains genuine candles and schedules recovery',async()=>{
    const h=harness();h.controller.open(buys());await h.settle();for(const invalid of [new Error('private-upstream-message'),{...SNAPSHOT,candles:[]},{...SNAPSHOT,candles:[{...rows[0],high:'-1'}]}]){
      h.responses.push(invalid);await h.tick();assert.equal(h.series.sets.length,1);assert.match(h.node('dcaCandleState').textContent,/保留历史/);assert.doesNotMatch(h.node('dcaCandleState').textContent,/private/);
    }h.controller.destroy();
  });
  await check('a partial recovery cannot erase known history and diary polling preserves the inspected day',async()=>{
    const h=harness();h.controller.open(buys(),'2024-12-14');await h.settle();h.controller.updateBuys(buys());
    assert.equal(h.node('dcaCandleDay').textContent,'2024-12-14 · 北京时间');
    h.responses.push({...SNAPSHOT,status:'stale',coverage_complete:false,candles:rows.slice(-2)});await h.tick();
    const rendered=new Set([...h.series.sets.flat(),...h.series.updates].map(row=>row.time));assert.equal(rendered.size,rows.length);
    assert.match(h.node('dcaCandleCoverage').textContent,/2024-07-01 — 2026-11-11/);assert.equal(h.node('dcaCandleDay').textContent,'2024-12-14 · 北京时间');h.controller.destroy();
  });
  await check('an old quote cannot be labeled live even if its response status says fresh',async()=>{
    const h=harness({responses:[{...SNAPSHOT,as_of:new Date(NOW-60000).toISOString()}]});h.controller.open(buys());await h.settle();
    assert.equal(h.node('dcaCandleDot').dataset.state,'stale');assert.match(h.node('dcaCandleState').textContent,/保留历史/);assert.equal(h.series.sets[0].length,rows.length);h.controller.destroy();
  });
  await check('new diary buys update markers while an account replacement removes all previous B records',async()=>{
    const h=harness();h.controller.open(buys());await h.settle();const changed=buys();changed.days.set(D('2026-11-11'),{btc:400000,usdt:3000,buys:3});h.controller.updateBuys(changed);assert.equal(h.marker.sets.at(-1).length,3);
    h.controller.updateBuys({connectionId:'account-b',days:new Map()});assert.deepEqual(h.marker.sets.at(-1),[]);assert.equal(h.requests.length,1);h.controller.destroy();
  });
  await check('hidden pages stop polling, Escape closes and restores focus, closed dialogs do no work',async()=>{
    const h=harness();h.controller.open(buys());await h.settle();h.document.hidden=true;await h.document.fire('visibilitychange');assert.equal(h.timers.size,0);h.document.hidden=false;await h.document.fire('visibilitychange');assert.equal(h.requests.length,2);
    await h.node('dcaCandleSheet').fire('keydown',{key:'Escape'});assert.equal(h.controller.isOpen(),false);assert.equal(h.node('dcaCandleSheet').hidden,true);assert.equal(h.timers.size,0);assert.equal(h.document.activeElement,h.opener);await h.document.fire('visibilitychange');assert.equal(h.requests.length,2);h.controller.destroy();
  });
  await check('closing and destruction abort pending requests and prevent late repaint',async()=>{
    const pending=deferred(),h=harness({responses:[pending.promise]});h.controller.open(buys());await h.settle();h.controller.close();assert.equal(h.requests[0].init.signal.aborted,true);pending.resolve(SNAPSHOT);await h.settle();assert.equal(h.series.sets.length,0);assert.equal(h.timers.size,0);
    h.controller.destroy();assert.equal(h.chart.removed,true);assert.equal(h.marker.detached,true);assert.ok(h.observers.every(observer=>observer.disconnected));for(const node of [h.root,h.document])for(const listeners of Object.values(node.listeners))assert.equal(listeners.length,0);
  });
  await check('theme changes reuse the chart and update both candles and B colors',async()=>{
    const h=harness();h.controller.open(buys());await h.settle();h.colors['--card']='#171715';h.colors['--text']='#f1efe8';h.colors['--dca-marker']='#f7931a';h.colors['--green']='#93ba9c';h.observers.find(observer=>observer===h.observers[1]).fn();
    assert.equal(h.chart.options.at(-1).layout.background.color,'#171715');assert.equal(h.chart.options.at(-1).layout.attributionLogo,true);assert.equal(h.series.options.at(-1).upColor,'#93ba9c');assert.ok(h.marker.sets.at(-1).every(marker=>marker.color==='#f7931a'));assert.equal(h.chartCount(),1);h.controller.destroy();
  });
  await check('the candle popup is bounded and contains no account mutation or browser balance persistence',()=>{
    const source=fs.readFileSync('./terminal/dist/dca-candles.js','utf8'),css=fs.readFileSync('./terminal/dist/dca-candles.css','utf8');
    assert.match(css,/\.dca-candle-sheet\{position:fixed;inset:0/);assert.match(css,/\.dca-candle-stage\{[^}]*min-height:100px[^}]*overflow:hidden/);assert.match(css,/@media\(max-width:700px\)/);
    assert.match(source,/https:\/\/www\.tradingview\.com\//);assert.doesNotMatch(source,/localStorage|sessionStorage|document\.cookie|api_key|secret_key|\/withdrawal|\/transfer/);
  });
  console.log(count+' DCA candle UI checks passed');
})().catch(error=>{console.error(error);process.exit(1);});
