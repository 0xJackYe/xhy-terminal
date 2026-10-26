"use strict";

// Run the shared workbench controller and real option engine. All data, storage,
// downloads and public-watch requests are isolated fixtures, never live orders.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ui=require('./dashboard/dist/sell-put-ui.js');
const engine=require('./dashboard/dist/sell-put-engine.js');
const source=fs.readFileSync('dashboard/dist/sell-put-ui.js','utf8');
const html=fs.readFileSync('dashboard/dist/index.html','utf8');
const at=Date.parse('2030-01-01T00:00:00Z'),DAY=86400000;
const fields=['bid_price','ask_price','bid_quantity','ask_quantity','mark_price','mark_iv'];
function row(side,strike,days=15){return {symbol:`BTC-${days===16?'300117':'300116'}-${strike}-${side==='CALL'?'C':'P'}`,side,status:'TRADING',unit:1,quote_asset:'USDT',
  strike_price:strike,expiry_ms:at+days*DAY,bid_price:65,ask_price:70,bid_quantity:1,ask_quantity:2,mark_price:65,mark_iv:.6,
  quote_updated_at:at,quote_source:'websocket',mark_updated_at:at,mark_source:'websocket',
  field_updated_at:Object.fromEntries(fields.map(name=>[name,at])),field_source:Object.fromEntries(fields.map(name=>[name,'websocket'])),
  initial_margin_rate:.15,min_initial_margin_rate:.1,maintenance_margin_rate:.075,min_maintenance_margin_rate:.05,liquidation_fee_rate:.0019,
  quantity_step:.01,min_qty:.01,max_qty:1000};}
function snapshot(rows=[row('PUT',60000),row('PUT',62000),row('CALL',96000),row('CALL',100000)]){return {options:rows,btc_index_price:80000,index_updated_at:at,index_source:'websocket',catalog_updated_at:at};}
function harness(initial=snapshot()){
  const nodes=new Map(),intervals=new Map(),timeouts=new Map(),storage=new Map(),downloads=[],blobs=new Map(),watches=[],evaluations=[],listeners=new Map();
  let snap=initial,clock=at,sequence=0,chainExpiry='2030-01-16';
  class Element{
    constructor(id='',tag='div'){this.id=id;this.tagName=tag.toUpperCase();this._value='';this.checked=this.disabled=this.hidden=this.open=false;this.events={};this.dataset={};this.textContent='';this.markup='';this.scrollLeft=this.scrollTop=0;this.attrs={};this.classList={toggle(){}};this.options=id==='sellPutExpiry'?['ALL','CHAIN']:null;}
    set value(value){this._value=this.options&&!this.options.includes(String(value))?'':String(value);}get value(){return this._value;}
    set innerHTML(value){this.markup=value;if(this.options){this.options=[...value.matchAll(/<option value="([^"]+)"/g)].map(match=>match[1]);if(!this.options.includes(this._value))this._value=this.options[0]??'';}const details=value.match(/<details class="sp-source-details"([^>]*)>/);this.sourceDetails=details?{open:/\bopen\b/.test(details[1])}:null;}
    get innerHTML(){return this.markup;}
    querySelector(selector){return selector==='details.sp-source-details'?this.sourceDetails:null;}querySelectorAll(){return [];}
    addEventListener(type,callback){this.events[type]=callback;}setAttribute(name,value){this.attrs[name]=String(value);}
    fire(type,event={}){this.events[type]?.({preventDefault(){},stopPropagation(){},...event});}
    focus(){document.activeElement=this;}showModal(){this.open=true;}close(){this.open=false;this.fire('close');}
    appendChild(){}remove(){}click(){if(this.tagName==='A')downloads.push({url:this.href,filename:this.download});else this.fire('click');}
  }
  const node=id=>{if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id);};
  const document={hidden:false,activeElement:null,body:new Element('body'),getElementById:node,createElement:tag=>new Element('',tag),addEventListener:(type,callback)=>listeners.set(type,callback)};
  class Clock extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
  class LocalBlob{constructor(parts){this.content=parts.join('');}}
  const window={SellPutEngine:{...engine,evaluate(...args){evaluations.push(args);return engine.evaluate(...args);}},
    fetch(url){assert.ok(url.startsWith('/api/mark-watch?symbols='));watches.push(url);return Promise.resolve({ok:true});}};
  vm.runInNewContext(source,{window,document,Date:Clock,Intl,console,Blob:LocalBlob,URL:{createObjectURL(blob){const url='blob:fixture-'+blobs.size;blobs.set(url,blob);return url;},revokeObjectURL(){}},
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},
    setTimeout(fn,delay){const id=++sequence;timeouts.set(id,{fn,delay});return id;},clearTimeout:id=>timeouts.delete(id),
    setInterval(fn){const id=++sequence;intervals.set(id,fn);return id;},clearInterval:id=>intervals.delete(id)});
  const percent=new Set(['minStrikeRatio','maxStrikeRatio','feeRate','exerciseFeeRate','feeCap']);
  for(const [key,value]of Object.entries(ui.DEFAULTS))node('sellPut'+key[0].toUpperCase()+key.slice(1)).value=percent.has(key)?value*100:value;
  node('sellPutExpiry').value='ALL';window.SellPutUI.initialize({getSnapshot:()=>snap,getExpiry:()=>chainExpiry});
  return {node,document,controller:window.SellPutUI,storage,downloads,blobs,watches,evaluations,intervals,
    snapshot:()=>snap,setSnapshot:value=>{snap=value;},setChainExpiry:value=>{chainExpiry=value;},
    choose(side){node('sellPutSide').value=side;node('sellPutSide').fire('change');},
    select(symbol){node('sellPutRows').fire('click',{target:{closest:()=>({dataset:{spSymbol:symbol}})}});},
    tick(ms=1000){clock+=ms;for(const fn of intervals.values())fn();},
    refresh(){snap.index_updated_at=snap.catalog_updated_at=clock;snap.options.forEach(value=>{value.quote_updated_at=value.mark_updated_at=clock;fields.forEach(field=>{value.field_updated_at[field]=clock;});});for(const fn of intervals.values())fn();},
    debounce(){for(const [id,task]of [...timeouts])if(task.delay===120&&timeouts.delete(id))task.fn();}};
}

test('Call default strike is 120–125 percent of spot, and Put defaults remain unchanged',()=>{
  const call=ui.parseSettings({},'CALL'),put=ui.parseSettings({});
  assert.deepEqual(call.errors,[]);assert.equal(call.settings.minStrikeRatio,1.2);assert.equal(call.settings.maxStrikeRatio,1.25);assert.equal(call.settings.side,'CALL');
  assert.equal(put.settings.minStrikeRatio,.75);assert.equal(put.settings.maxStrikeRatio,.8);assert.equal(put.settings.side,'PUT');
  assert.equal(ui.parseSettings({minStrikeRatio:100,maxStrikeRatio:1000},'CALL').errors.length,0);
  assert.ok(ui.parseSettings({minStrikeRatio:99},'CALL').errors.length);
  assert.ok(ui.parseSettings({quantityMode:'cashSecured'},'CALL').errors.some(value=>/无有限足额赔付模式/.test(value)));
});

test('normal and focused Call entries open the shared dialog with real Call candidates only',()=>{
  for(const id of ['sellCallButton','focusSellCallButton']){
    const h=harness();h.node(id).fire('click');assert.equal(h.node('sellPutDialog').open,true);assert.equal(h.controller.getSide(),'CALL');
    assert.equal(h.node('sellPutHeading').textContent,'卖 Call 工作台');assert.equal(h.evaluations.at(-1)[3],'CALL');
    assert.match(h.node('sellPutRows').innerHTML,/BTC-300116-96000-C/);assert.doesNotMatch(h.node('sellPutRows').innerHTML,/-60000-P/);
    assert.equal(h.node('sellPutCashMode').disabled,true);assert.equal(h.node('sellPutCashMode').hidden,true);
  }
});

test('Call detail uses upward pressure, unlimited loss and spot-notional reference without a cash-coverage yield',()=>{
  const h=harness();h.controller.openCall();const detail=h.node('sellPutDetail').innerHTML;
  assert.match(detail,/\+10%/);assert.match(detail,/\+20%/);assert.match(detail,/\+30%/);assert.match(detail,/到期最大损失<\/dt><dd>无限/);
  assert.match(detail,/现货名义金额参考/);assert.match(detail,/不是有限赔付覆盖，也不是 USDT 保证金信用/);
  assert.doesNotMatch(detail,/足额赔付资金 · 基数/);assert.match(detail,/不适用（亏损无上限）/);
});

test('Call and Put input values, quantity modes, selection and expiry are independent',()=>{
  const h=harness(snapshot([row('PUT',60000),row('PUT',62000),row('CALL',96000,16),row('CALL',100000,16)]));h.controller.open();
  h.node('sellPutBalance').value='900';h.node('sellPutQuantityMode').value='manual';h.node('sellPutQuantity').value='.02';h.node('sellPutForm').fire('change');h.select('BTC-300116-62000-P');
  h.node('sellPutExpiry').value='2030-01-16';h.node('sellPutForm').fire('change');h.choose('CALL');
  assert.equal(h.node('sellPutBalance').value,'1000');assert.equal(h.node('sellPutMinStrikeRatio').value,'120');
  h.node('sellPutBalance').value='700';h.node('sellPutExpiry').value='2030-01-17';h.node('sellPutForm').fire('change');h.select('BTC-300117-100000-C');
  h.choose('PUT');assert.equal(h.node('sellPutBalance').value,'900');assert.equal(h.node('sellPutQuantityMode').value,'manual');assert.equal(h.node('sellPutQuantity').value,'.02');
  assert.equal(h.node('sellPutExpiry').value,'2030-01-16');assert.match(h.node('sellPutDetail').innerHTML,/BTC-300116-62000-P/);
  h.choose('CALL');assert.equal(h.node('sellPutBalance').value,'700');assert.equal(h.node('sellPutExpiry').value,'2030-01-17');assert.match(h.node('sellPutDetail').innerHTML,/BTC-300117-100000-C/);
});

test('a fixed Put frame and live Call frame keep separate clocks through repeated side switches',()=>{
  const h=harness();h.controller.open();h.node('sellPutPause').fire('click');const fixed=h.evaluations.at(-1)[2];
  h.choose('CALL');h.tick(5000);assert.ok(h.evaluations.at(-1)[2]>fixed);assert.equal(h.node('sellPutMode').textContent,'自动跟随行情');
  h.choose('PUT');assert.equal(h.evaluations.at(-1)[2],fixed);assert.equal(h.node('sellPutMode').textContent,'固定历史试算');
  h.choose('CALL');h.node('sellPutPause').fire('click');const callFixed=h.evaluations.at(-1)[2];h.choose('PUT');h.tick();h.choose('CALL');assert.equal(h.evaluations.at(-1)[2],callFixed);
  assert.equal(h.intervals.size,1);
});

test('reset changes only the active side and restores its own default strike range',()=>{
  const h=harness();h.controller.open();h.node('sellPutBalance').value='800';h.node('sellPutForm').fire('change');h.choose('CALL');
  h.node('sellPutMinStrikeRatio').value='130';h.node('sellPutMaxStrikeRatio').value='140';h.node('sellPutForm').fire('change');h.node('sellPutReset').fire('click');
  assert.equal(h.node('sellPutMinStrikeRatio').value,'120');assert.equal(h.node('sellPutMaxStrikeRatio').value,'125');
  h.choose('PUT');assert.equal(h.node('sellPutBalance').value,'800');assert.equal(h.node('sellPutMinStrikeRatio').value,'75');
});

test('temporary Call recovery retains only Call references and preserves unlimited-loss semantics after JSON cloning',()=>{
  const h=harness();h.controller.openCall();const symbol='BTC-300116-100000-C';h.select(symbol);
  h.snapshot().options.filter(value=>value.side==='CALL').forEach(value=>{value.field_updated_at.bid_quantity=at-30000;});h.tick();
  assert.match(h.node('sellPutDetail').innerHTML,/参考快照，等待最新行情/);assert.match(h.node('sellPutDetail').innerHTML,/到期最大损失<\/dt><dd>无限/);assert.equal(h.node('sellPutRecord').disabled,true);
  h.choose('PUT');assert.doesNotMatch(h.node('sellPutDetail').innerHTML,/-C/);h.choose('CALL');assert.match(h.node('sellPutDetail').innerHTML,new RegExp(symbol));assert.match(h.node('sellPutDetail').innerHTML,/参考快照，等待最新行情/);
  h.refresh();assert.doesNotMatch(h.node('sellPutDetail').innerHTML,/参考快照，等待最新行情/);assert.equal(h.node('sellPutRecord').disabled,false);
});

test('Call hard depth failure and invalid quantity never regain current recording authority from references',()=>{
  const h=harness();h.controller.openCall();h.snapshot().options.filter(value=>value.side==='CALL').forEach(value=>{value.bid_quantity=0;});h.tick();
  assert.equal(h.node('sellPutRecord').disabled,true);assert.doesNotMatch(h.node('sellPutDetail').innerHTML,/sp-yields/);
  h.refresh();h.node('sellPutQuantityMode').value='manual';h.node('sellPutQuantity').value='';h.node('sellPutForm').fire('change');assert.equal(h.node('sellPutError').hidden,false);
});

test('Call CSV identifies side, notional basis and unlimited loss without leaking a Put cash yield',()=>{
  const h=harness();h.controller.openCall();h.node('sellPutExport').fire('click');assert.equal(h.downloads.length,1);
  assert.match(h.downloads[0].filename,/卖Call/);const csv=h.blobs.get(h.downloads[0].url).content;
  assert.match(csv,/期权方向/);assert.match(csv,/"CALL"/);assert.match(csv,/现货名义参考单利年化%/);assert.match(csv,/"无限"/);
  assert.match(csv,/不是有限赔付覆盖，也不是USDT保证金信用/);assert.doesNotMatch(csv,/足额赔付日化%/);
});

test('Call and Put records use separate keys and persist the explicit unbounded-loss flag',()=>{
  const h=harness();h.controller.openCall();h.node('sellPutRecord').fire('click');
  const call=JSON.parse(h.storage.get('btc-options-sell-call-trials-v1'));assert.equal(call.length,1);assert.equal(call[0].side,'CALL');assert.equal(call[0].entry.metrics.lossUnbounded,true);
  assert.equal(call[0].entry.metrics.maxExpiryLoss,null);assert.equal(h.storage.has('btc-options-sell-put-trials-v1'),false);
  h.choose('PUT');h.node('sellPutRecord').fire('click');const put=JSON.parse(h.storage.get('btc-options-sell-put-trials-v1'));assert.equal(put[0].side,'PUT');assert.equal(call[0].entry.row.side,'CALL');
});

test('Call exports and records revalidate pending edits before their debounce fires',()=>{
  const h=harness();h.controller.openCall();h.node('sellPutQuantityMode').value='manual';h.node('sellPutQuantity').value='';h.node('sellPutForm').fire('input');
  h.node('sellPutExport').fire('click');h.node('sellPutRecord').fire('click');assert.equal(h.downloads.length,0);assert.equal(h.storage.size,0);
  h.choose('PUT');h.debounce();assert.equal(h.node('sellPutError').hidden,true);assert.equal(h.controller.getSide(),'PUT');
});

test('chain-following, calculated-only, sorting and advanced fees remain available on Call',()=>{
  const h=harness(snapshot([row('PUT',60000),row('CALL',96000),row('CALL',100000,16)]));h.controller.openCall();
  h.node('sellPutExpiry').value='CHAIN';h.node('sellPutSort').value='accountAnnual';h.node('sellPutFeeRate').value='.02';h.node('sellPutForm').fire('change');
  assert.match(h.node('sellPutRows').innerHTML,/96000-C/);assert.doesNotMatch(h.node('sellPutRows').innerHTML,/100000-C/);
  assert.equal(h.evaluations.at(-1)[1].feeRate,.0002);h.setChainExpiry('2030-01-17');h.tick();assert.match(h.node('sellPutRows').innerHTML,/100000-C/);
  h.snapshot().options.filter(value=>value.side==='CALL').forEach(value=>{value.bid_quantity=0;});h.tick();h.node('sellPutOnlyCalculated').checked=true;h.node('sellPutOnlyCalculated').fire('change');assert.equal(h.node('sellPutRows').innerHTML,'');
});

test('focused Call close restores its own trigger and stops rendering, while watch interests are Call symbols',()=>{
  const h=harness(),trigger=h.node('focusSellCallButton');trigger.fire('click');assert.ok(h.watches.some(url=>decodeURIComponent(url).includes('-C')));
  h.node('sellPutDialog').fire('cancel');assert.equal(h.document.activeElement,trigger);assert.equal(h.intervals.size,0);const count=h.evaluations.length;h.tick();assert.equal(h.evaluations.length,count);
});

test('retired Call workbench stays isolated from the active quote page',()=>{
  for(const id of ['sellCallButton','focusSellCallButton','callRuleButton','sellPutSide','sellPutDialog'])assert.doesNotMatch(html,new RegExp('id="'+id+'"'));
  for(const file of ['sell-put-ui.js','sell-put-engine.js','sell-put.css'])assert.ok(!html.includes('"/'+file+'"'));
  assert.doesNotMatch(source,/apiKey|secretKey|XMLHttpRequest/);
});
