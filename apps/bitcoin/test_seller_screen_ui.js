"use strict";

// Run the shipped compact screen, real financial engine and real public-watch
// helper in an isolated DOM. No production API, SMTP, account or order calls.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ui=require('./dashboard/dist/seller-screen-ui.js');
const engine=require('./dashboard/dist/seller-screen-engine.js');
const watchUI=require('./dashboard/dist/sell-put-ui.js');
const source=fs.readFileSync('dashboard/dist/seller-screen-ui.js','utf8');
const NOW=Date.parse('2030-01-01T00:00:00Z'),DAY=86400000;
const quoteFields=['bid_price','ask_price','bid_quantity','ask_quantity','mark_price','mark_iv'];
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
const decode=value=>String(value).replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
function row(strike=62000,side='PUT',premium=65,patch={}){return {
  symbol:`BTC-300116-${strike}-${side==='PUT'?'P':'C'}`,side,strike_price:strike,expiry_ms:NOW+15*DAY,
  status:'TRADING',unit:1,quote_asset:'USDT',min_qty:.01,max_qty:100,quantity_step:.01,quantity_scale:2,
  initial_margin_rate:.15,min_initial_margin_rate:.1,maintenance_margin_rate:.075,min_maintenance_margin_rate:.05,liquidation_fee_rate:.0019,
  bid_price:premium,ask_price:premium+5,bid_quantity:1,ask_quantity:1,mark_price:premium,mark_iv:.6,
  quote_updated_at:NOW,quote_source:'websocket',mark_updated_at:NOW,mark_source:'websocket',
  field_updated_at:Object.fromEntries(quoteFields.map(name=>[name,NOW])),field_source:Object.fromEntries(quoteFields.map(name=>[name,'websocket'])),...patch};}
function snapshot(rows=[row(60000,'PUT',30),row(62000,'PUT',300),row(64000,'PUT',320),row(96000,'CALL'),row(100000,'CALL')]){
  return {options:rows,btc_index_price:80000,index_updated_at:NOW,index_source:'websocket',catalog_updated_at:NOW,exchange_clock_offset_ms:0};
}

function harness(initial=snapshot(),options={}){
  const ids=new Map(),rootListeners=new Map(),requests=[],evaluations=[];
  let snap=initial,clock=NOW,unavailable=false,advancedCalls=0,refreshCalls=0,refreshAction=null;
  const voidTags=new Set(['AREA','BASE','BR','COL','EMBED','HR','IMG','INPUT','LINK','META','PARAM','SOURCE','TRACK','WBR']);
  const camel=name=>name.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());
  let document;
  class Element{
    constructor(tag='div',id=''){
      this.tagName=tag.toUpperCase();this.id=id;this.children=[];this.parentElement=null;this.events=new Map();this.attributes=new Map();this.dataset={};
      this.hidden=this.disabled=this.checked=this.open=false;this.value='';this._text='';this._markup='';this.writes=0;this.style={};
      const classes=new Set();this.classList={toggle(name,value){value?classes.add(name):classes.delete(name);},contains:name=>classes.has(name)};
      if(id)ids.set(id,this);
    }
    setAttribute(name,value){value=String(value);this.attributes.set(name,value);if(name==='id'){this.id=value;ids.set(value,this);}if(name.startsWith('data-'))this.dataset[camel(name.slice(5))]=value;if(name==='value')this.value=value;if(['hidden','disabled','checked','open'].includes(name))this[name]=true;}
    getAttribute(name){return this.attributes.get(name)??null;}
    appendChild(child){child.parentElement=this;this.children.push(child);return child;}
    contains(target){for(let item=target;item;item=item.parentElement)if(item===this)return true;return false;}
    closest(selector){for(let item=this;item;item=item.parentElement)if(item.tagName===selector.toUpperCase())return item;return null;}
    querySelectorAll(selector){const result=[],visit=parent=>parent.children.forEach(child=>{const attr=/^\[([^\]]+)\]$/.exec(selector);if(attr?child.attributes.has(attr[1]):child.tagName===selector.toUpperCase())result.push(child);visit(child);});visit(this);return result;}
    querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
    addEventListener(type,callback){if(!this.events.has(type))this.events.set(type,[]);this.events.get(type).push(callback);}
    async dispatch(type,event={}){
      const path=[];for(let item=this;item;item=item.parentElement)path.push(item);
      let stopped=false;const pending=[],payload={target:this,key:undefined,prevented:false,preventDefault(){this.prevented=true;},stopPropagation(){stopped=true;},...event};
      for(const item of path){for(const callback of item.events.get(type)??[])pending.push(callback(payload));if(stopped||event.bubbles===false)break;}
      await Promise.all(pending);return payload;
    }
    async click(){if(this.disabled)return;return this.dispatch('click');}
    async press(key){this.focus();if(this.tagName==='BUTTON'&&['Enter',' '].includes(key))return this.click();if(this.tagName==='INPUT'&&key==='Enter')return this.closest('form')?.dispatch('submit',{key});return this.dispatch('keydown',{key});}
    focus(){if(document.body.contains(this))document.activeElement=this;}
    set textContent(value){this._text=String(value);this.children=[];}
    get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
    set innerHTML(value){
      const remove=parent=>parent.children.forEach(child=>{remove(child);if(child.id&&ids.get(child.id)===child)ids.delete(child.id);});remove(this);
      this.children=[];this._text='';this._markup=String(value);this.writes++;const stack=[this];
      for(const token of this._markup.matchAll(/<(\/?)([a-z][a-z0-9:-]*)\b([^>]*)>|([^<]+)/gi)){
        if(token[4]!==undefined){stack.at(-1)._text+=decode(token[4]);continue;}
        const tag=token[2].toUpperCase();if(token[1]){const index=stack.findLastIndex(item=>item.tagName===tag);if(index>0)stack.length=index;continue;}
        const node=new Element(tag);for(const attr of token[3].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))node.setAttribute(attr[1],decode(attr[2]??attr[3]??attr[4]??''));
        stack.at(-1).appendChild(node);if(!voidTags.has(tag)&&!token[3].endsWith('/'))stack.push(node);
      }
    }
    get innerHTML(){return this._markup;}
  }
  const body=new Element('body'),container=new Element('main','sellerScreen');body.appendChild(container);
  document={body,hidden:false,activeElement:body,getElementById:id=>ids.get(id)??null,addEventListener:(type,callback)=>rootListeners.set(type,callback)};
  class Clock extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
  const window={SellerScreenEngine:options.missingEngine?undefined:{...engine,evaluate(...args){evaluations.push(args);if(options.throwEngine)throw new Error('internal fixture error');return engine.evaluate(...args);}},
    SellPutUI:{createMarkWatch:(getContext,send)=>watchUI.createMarkWatch(getContext,send,()=>clock)},
    fetch:async(url,init)=>{assert.ok(url.startsWith('/api/mark-watch?symbols='),'Only the public watch route is allowed');requests.push({url,init});return {ok:true};}};
  vm.runInNewContext(source,{window,document,Date:Clock,Intl,console,Promise,
    localStorage:{getItem(){throw new Error('No browser account storage in compact UI');},setItem(){throw new Error('No browser account storage in compact UI');}}});
  const api=window.SellerScreenUI;
  api.initialize({getSnapshot:()=>snap,getUnavailable:()=>unavailable,onAdvanced(){advancedCalls++;container.hidden=true;},async onRefresh(){refreshCalls++;if(refreshAction)return refreshAction();}});
  const node=id=>{assert.ok(ids.has(id),'Missing real UI node '+id);return ids.get(id);};
  const button=(attribute,value)=>container.querySelectorAll(`[${attribute}]`).find(item=>item.getAttribute(attribute)===value);
  return {api,container,document,node,requests,evaluations,
    get snapshot(){return snap;},get clock(){return clock;},get advancedCalls(){return advancedCalls;},get refreshCalls(){return refreshCalls;},
    setSnapshot(value){snap=value;},setUnavailable(value){unavailable=value;},setRefreshAction(callback){refreshAction=callback;},
    async ready(){await flush();},async mode(value,key='Enter'){await button('data-ss-mode',value).press(key);},async side(value){await button('data-ss-side',value).click();},
    async risk(symbol){const target=button('data-ss-risk',symbol);assert.ok(target,'Expected a current risk button');await target.press('Enter');},
    async input(id,value){node(id).value=String(value);node(id).focus();await node(id).dispatch('input');},
    async reset(){const target=button('data-ss-reset','true');assert.ok(target);await target.click();},
    async visibility(hidden){document.hidden=hidden;rootListeners.get('visibilitychange')?.();await flush();},
    advance(ms){clock+=ms;},refreshData(){if(!snap)return;snap.index_updated_at=snap.catalog_updated_at=clock;snap.options.forEach(value=>{value.quote_updated_at=value.mark_updated_at=clock;quoteFields.forEach(field=>{value.field_updated_at[field]=clock;});});},
    symbols(){return node('ssCandidates').querySelectorAll('[data-ss-risk]').map(item=>item.dataset.ssRisk);},
    markup(){return node('ssCandidates').innerHTML;},
  };
}

test('the real screen initializes conservative fixed-size defaults and does not open the legacy tools',async()=>{
  const h=harness();await h.ready();assert.equal(h.node('ssBalance').value,'1000');assert.equal(h.node('ssQuantity').value,'0.1');
  assert.equal(h.node('ssAdvancedFilters').open,false);assert.equal(h.advancedCalls,0);assert.equal(h.evaluations[0][1].mode,'balanced');
  assert.deepEqual(h.symbols(),engine.evaluate(h.snapshot,engine.DEFAULTS,NOW).candidates.map(item=>item.symbol));
  assert.match(h.markup(),/\/天（折算）/);assert.equal(h.node('ssEmpty').hidden,true);
});

test('native button activation changes all three modes without changing quantity or balance',async()=>{
  const h=harness();await h.ready();await h.mode('risk','Enter');assert.equal(h.symbols()[0],'BTC-300116-60000-P');
  await h.mode('balanced',' ');assert.equal(h.symbols()[0],'BTC-300116-62000-P');await h.mode('premium');assert.equal(h.symbols()[0],'BTC-300116-64000-P');
  assert.ok(h.evaluations.every(args=>args[1].quantity===.1&&args[1].balance===1000));
  assert.match(h.node('ssModeNote').textContent,/净权利金\/天/);assert.match(h.node('ssFormula').textContent,/净权利金/);
});

test('balanced and premium can honestly share an identical list while each click recomputes its distinct mode',async()=>{
  const snap=snapshot([row(60000,'PUT',65),row(62000,'PUT',100),row(64000,'PUT',150)]);
  const balanced=engine.evaluate(snap,{...engine.DEFAULTS,mode:'balanced'},NOW);
  const premium=engine.evaluate(snap,{...engine.DEFAULTS,mode:'premium'},NOW);
  const symbols=result=>result.candidates.map(candidate=>candidate.symbol);
  assert.deepEqual(symbols(balanced),symbols(premium));assert.equal(symbols(balanced).length,3);
  assert.equal(balanced.modeComparison.sameContracts,true);assert.equal(balanced.modeComparison.sameOrder,true);
  assert.equal(premium.modeComparison.sameContracts,true);assert.equal(premium.modeComparison.sameOrder,true);
  const h=harness(snap);await h.ready();const first=h.markup(),before=h.evaluations.length;
  assert.match(h.node('ssModeNote').textContent,/本次与权利金优先排序一致/);
  await h.mode('premium');assert.equal(h.evaluations.length,before+1);assert.equal(h.evaluations.at(-1)[1].mode,'premium');
  assert.deepEqual(h.symbols(),symbols(premium));assert.equal(h.markup(),first,'The UI must not invent different quotes or risk values just to distinguish modes');
  assert.equal(h.node('ssFormula').textContent,premium.formula);assert.match(h.node('ssModeNote').textContent,/本次与风险收益平衡排序一致/);
  assert.equal(h.container.querySelectorAll('[data-ss-mode]').find(button=>button.dataset.ssMode==='premium').getAttribute('aria-pressed'),'true');
  await h.mode('balanced');assert.equal(h.evaluations.length,before+2);assert.equal(h.evaluations.at(-1)[1].mode,'balanced');
  assert.deepEqual(h.symbols(),symbols(balanced));assert.equal(h.markup(),first);assert.equal(h.node('ssFormula').textContent,balanced.formula);
  assert.ok(h.evaluations.every(args=>args[1].quantity===.1&&args[1].balance===1000));
});

test('same contracts with a different ordering are identified without presenting the modes as identical',async()=>{
  const h=harness(),balanced=engine.evaluate(h.snapshot,{...engine.DEFAULTS,mode:'balanced'},NOW),premium=engine.evaluate(h.snapshot,{...engine.DEFAULTS,mode:'premium'},NOW);
  const symbols=result=>result.candidates.map(candidate=>candidate.symbol);
  assert.deepEqual([...symbols(balanced)].sort(),[...symbols(premium)].sort());assert.notDeepEqual(symbols(balanced),symbols(premium));
  assert.equal(balanced.modeComparison.sameContracts,true);assert.equal(balanced.modeComparison.sameOrder,false);
  assert.match(h.node('ssModeNote').textContent,/当前候选相同，排序不同/);await h.mode('premium');
  assert.deepEqual(h.symbols(),symbols(premium));assert.match(h.node('ssModeNote').textContent,/当前候选相同，排序不同/);
  assert.doesNotMatch(h.node('ssModeNote').textContent,/本次与风险收益平衡排序一致/);
});

test('an immediate mode click consumes the newest snapshot even if its queued refresh has not run',async()=>{
  const h=harness(snapshot([row(60000,'PUT',65),row(62000,'PUT',100),row(64000,'PUT',150)]));await h.ready();
  const before=h.evaluations.length,newest=snapshot([row(60000,'PUT',200),row(62000,'PUT',100),row(64000,'PUT',65)]);
  h.setSnapshot(newest);h.api.onSnapshot();await h.mode('premium');await flush();
  assert.equal(h.evaluations.length,before+1);assert.equal(h.evaluations.at(-1)[0],newest);assert.equal(h.evaluations.at(-1)[1].mode,'premium');
  assert.deepEqual(h.symbols(),engine.evaluate(newest,{...engine.DEFAULTS,mode:'premium'},NOW).candidates.map(candidate=>candidate.symbol));
  assert.equal(h.symbols()[0],'BTC-300116-60000-P');
});

test('the renamed low-risk label keeps the risk mode API and does not fabricate a balanced comparison',async()=>{
  const h=harness();const riskButton=h.container.querySelectorAll('[data-ss-mode]').find(button=>button.dataset.ssMode==='risk');
  assert.equal(riskButton.textContent,'低风险优先');await riskButton.press('Enter');assert.equal(h.evaluations.at(-1)[1].mode,'risk');
  assert.deepEqual(h.symbols(),engine.evaluate(h.snapshot,{...engine.DEFAULTS,mode:'risk'},NOW).candidates.map(candidate=>candidate.symbol));
  assert.doesNotMatch(h.node('ssModeNote').textContent,/本次与.*排序一致|当前候选相同，排序不同/);
});

test('side buttons use the real Call engine and show unlimited expiry loss in the expanded risk view',async()=>{
  const h=harness();await h.side('CALL');assert.ok(h.symbols().every(symbol=>symbol.endsWith('-C')));
  assert.match(h.node('ssSideNote').textContent,/亏损无上限/);assert.equal(h.node('ssStressLabel').textContent,'上涨 20% 压力亏损');
  await h.risk(h.symbols()[0]);assert.match(h.markup(),/到期最大亏损<\/span><strong>无限/);assert.match(h.markup(),/BTC \+10%/);
  await h.side('PUT');assert.ok(h.symbols().every(symbol=>symbol.endsWith('-P')));assert.doesNotMatch(h.markup(),/ss-risk-detail/);
});

test('blank zero false and nonfinite inputs do not silently restore a valid trade size',async()=>{
  for(const value of ['',0,false,NaN,Infinity])assert.ok(ui.parseSettings({quantity:value}).errors.length);
  const h=harness();await h.ready();const count=h.evaluations.length;await h.input('ssQuantity','');
  assert.equal(h.symbols().length,0);assert.equal(h.evaluations.length,count);assert.equal(h.node('ssQuantity').getAttribute('aria-invalid'),'true');
  assert.equal(h.node('ssInputError').hidden,false);assert.match(h.node('ssEmpty').innerHTML,/请完成试算条件/);
  await h.input('ssQuantity','0.05');assert.ok(h.symbols().length);assert.equal(h.node('ssQuantity').getAttribute('aria-invalid'),'false');
});

test('typing and fast snapshots preserve the input node focus and open advanced controls',async()=>{
  const h=harness();h.node('ssAdvancedFilters').open=true;await h.input('ssBalance','900');const input=h.node('ssBalance');
  for(let i=0;i<20;i++){h.setSnapshot(snapshot());h.api.onSnapshot();}await flush();
  assert.equal(h.node('ssBalance'),input);assert.equal(h.document.activeElement,input);assert.equal(input.value,'900');assert.equal(h.node('ssAdvancedFilters').open,true);
  assert.equal(h.evaluations.at(-1)[1].balance,900);
});

test('a burst of onSnapshot calls evaluates the latest frame once and never an earlier captured snapshot',async()=>{
  const h=harness();await h.ready();const before=h.evaluations.length;
  for(let i=0;i<30;i++){h.setSnapshot(snapshot([row(62000,'PUT',80+i)]));h.api.onSnapshot();}await flush();
  assert.equal(h.evaluations.length,before+1);assert.equal(h.evaluations.at(-1)[0].options[0].bid_price,109);
  assert.match(h.markup(),/9\.81/);
});

test('freshness expiry removes the selected risk view rather than retaining a past recommendation',async()=>{
  const h=harness();await h.risk(h.symbols()[0]);assert.match(h.markup(),/ss-risk-detail/);
  h.advance(31000);h.api.onSnapshot();await flush();assert.equal(h.symbols().length,0);assert.doesNotMatch(h.markup(),/ss-risk-detail/);
  assert.match(h.node('ssEmpty').innerHTML,/同步|时效/);h.refreshData();h.api.onSnapshot();await flush();assert.ok(h.symbols().length);assert.doesNotMatch(h.markup(),/ss-risk-detail/);
});

test('a risk click revalidates stale data immediately even before the scheduled snapshot update',async()=>{
  const h=harness();await h.ready();const selected=h.symbols()[0];h.advance(31000);await h.risk(selected);
  assert.equal(h.symbols().length,0);assert.doesNotMatch(h.markup(),/ss-risk-detail/);
});

test('expired contracts and intervening depth loss remove the selected details on refresh',async()=>{
  const h=harness();const selected=h.symbols()[0];await h.risk(selected);
  h.snapshot.options.find(value=>value.symbol===selected).expiry_ms=NOW-1;h.api.refresh();assert.ok(!h.symbols().includes(selected));assert.doesNotMatch(h.markup(),/ss-risk-detail/);
  const second=h.symbols()[0];await h.risk(second);h.snapshot.options.find(value=>value.symbol===second).bid_quantity=0;h.api.refresh();
  assert.ok(!h.symbols().includes(second));assert.doesNotMatch(h.markup(),/ss-risk-detail/);
});

test('parent unavailable state clears all candidates and manual refresh safely recovers the current screen',async()=>{
  const h=harness();await h.ready();h.setUnavailable(true);h.api.refresh();assert.equal(h.symbols().length,0);assert.equal(h.node('ssSpot').textContent,'—');
  assert.match(h.node('ssEmpty').innerHTML,/不保留过期候选/);h.setRefreshAction(()=>{h.setUnavailable(false);h.refreshData();});
  await h.node('ssRefreshButton').press('Enter');assert.equal(h.refreshCalls,1);assert.equal(h.node('ssRefreshButton').disabled,false);assert.ok(h.symbols().length);
});

test('a pending manual refresh cannot be duplicated and rejected refresh promises release the button',async()=>{
  const h=harness();let reject;h.setRefreshAction(()=>new Promise((_,no)=>{reject=no;}));const pending=h.node('ssRefreshButton').click();await flush();
  assert.equal(h.node('ssRefreshButton').disabled,true);await h.node('ssRefreshButton').click();assert.equal(h.refreshCalls,1);
  reject(new Error('fixture offline'));await pending;assert.equal(h.node('ssRefreshButton').disabled,false);
});

test('reset restores only advanced filters and keeps the chosen mode side balance and quantity',async()=>{
  const h=harness();await h.side('CALL');await h.mode('risk');await h.input('ssBalance','900');await h.input('ssQuantity','.05');
  await h.input('ssMinDays','30');await h.input('ssMaxDays','40');assert.equal(h.symbols().length,0);await h.reset();
  assert.equal(h.node('ssMinDays').value,10);assert.equal(h.node('ssMaxDays').value,20);assert.equal(h.node('ssBalance').value,'900');assert.equal(h.node('ssQuantity').value,'.05');
  assert.equal(h.evaluations.at(-1)[1].side,'CALL');assert.equal(h.evaluations.at(-1)[1].mode,'risk');assert.ok(h.symbols().length);
});

test('a form Enter submission validates advanced ranges and never invokes a form HTTP request',async()=>{
  const h=harness();await h.input('ssMinDays','21');await h.input('ssMaxDays','20');const event=await h.node('ssMaxDays').press('Enter');
  assert.equal(event.prevented,true);assert.equal(h.symbols().length,0);assert.match(h.node('ssInputError').textContent,/最少不大于最多/);
  assert.ok(h.requests.every(request=>request.url.startsWith('/api/mark-watch?symbols=')));
});

test('the real engine list is capped at five and includes an honest eligible total',()=>{
  const rows=Array.from({length:9},(_,index)=>row(60000+500*index,'PUT',50+index));const h=harness(snapshot(rows));
  assert.equal(h.symbols().length,5);assert.equal(h.node('ssCount').textContent,'5');assert.match(h.node('ssScope').textContent,/显示 5 \/ 9 个/);
});

test('spread rejection explains matching contracts without hundreds of irrelevant filter counts',async()=>{
  const h=harness(snapshot([row(96000,'CALL',10,{ask_price:30}),row(100000,'CALL',10,{ask_price:30}),...Array.from({length:20},(_,i)=>row(50000+i*100))]));
  await h.side('CALL');assert.equal(h.symbols().length,0);assert.match(h.node('ssEmpty').innerHTML,/2 个匹配合约价差超过 50% 上限/);
  assert.doesNotMatch(h.node('ssEmpty').innerHTML,/不符合筛选 20/);assert.equal(h.node('ssSpread').value,'50');
});

test('empty depth and balance states identify the actual constraint without increasing leverage',async()=>{
  const depth=harness(snapshot([row(62000,'PUT',65,{bid_quantity:.01})]));assert.match(depth.node('ssEmpty').innerHTML,/买一深度不足/);
  const funds=harness();await funds.input('ssBalance','1');assert.match(funds.node('ssEmpty').innerHTML,/余额不足/);assert.equal(funds.node('ssQuantity').value,'0.1');
});

test('missing data and engine failures are contained and never expose stale financial rows',async()=>{
  for(const initial of [null,{options:[],btc_index_price:80000}]){const h=harness(initial);assert.equal(h.symbols().length,0);assert.equal(h.node('ssEmpty').hidden,false);}
  for(const options of [{missingEngine:true},{throwEngine:true}]){const h=harness(snapshot(),options);assert.equal(h.symbols().length,0);assert.match(h.node('ssEmpty').innerHTML,/暂时无法计算/);assert.doesNotMatch(h.node('ssEmpty').innerHTML,/internal fixture error/);}
});

test('fixture mode is unambiguously labeled and real quotes are not mislabeled as fixtures',()=>{
  const fixture=harness({...snapshot(),fixture:true});assert.equal(fixture.node('ssDatasetBadge').hidden,false);assert.match(fixture.node('ssStatus').textContent,/模拟数据验收.*非实时行情/);
  const labelled=harness({...snapshot(),fixture_label:'isolated acceptance'});assert.equal(labelled.node('ssDatasetBadge').hidden,false);
  const live=harness();assert.equal(live.node('ssDatasetBadge').hidden,true);
});

test('hidden screens do not recalculate or renew watches and returning refreshes current data',async()=>{
  const h=harness();await h.ready();const count=h.evaluations.length,requests=h.requests.length;h.container.hidden=true;h.advance(15000);h.api.onSnapshot();await flush();
  assert.equal(h.evaluations.length,count);assert.equal(h.requests.length,requests);h.container.hidden=false;h.refreshData();h.api.refresh();await flush();assert.equal(h.evaluations.length,count+1);
  await h.visibility(true);h.api.onSnapshot();await flush();assert.equal(h.evaluations.length,count+1);await h.visibility(false);assert.equal(h.evaluations.length,count+2);
});

test('complete-chain access is an explicit secondary action and does not write settings',async()=>{
  const h=harness();await h.node('ssAdvancedButton').press('Enter');assert.equal(h.advancedCalls,1);assert.equal(h.container.hidden,true);
  const before=h.evaluations.length;h.api.onSnapshot();await flush();assert.equal(h.evaluations.length,before);
});

test('public recovery watches include stale matching contracts with selected priority and bounded renewal',async()=>{
  const h=harness(snapshot(Array.from({length:9},(_,index)=>row(60000+index*500,'PUT',65))));await h.ready();assert.equal(h.requests.length,1);
  let symbols=decodeURIComponent(h.requests[0].url.split('symbols=')[1]).split(',');assert.ok(symbols.length<=8);assert.ok(symbols.every(symbol=>symbol.endsWith('-P')));
  const selected=h.symbols().at(-1);await h.risk(selected);await flush();assert.equal(h.requests.length,2);symbols=decodeURIComponent(h.requests.at(-1).url.split('symbols=')[1]).split(',');assert.equal(symbols[0],selected);
  h.advance(1000);h.api.refresh();await flush();assert.equal(h.requests.length,2);h.advance(10000);h.api.refresh();await flush();assert.equal(h.requests.length,3);
  h.snapshot.options.forEach(value=>{value.field_updated_at.bid_quantity=NOW-40000;});h.advance(10000);h.api.refresh();await flush();assert.equal(h.symbols().length,0);assert.ok(h.requests.length>=4);
  assert.ok(h.requests.every(request=>request.init?.method===undefined&&request.url.startsWith('/api/mark-watch?symbols=')));
});

test('20 percent maintenance status is not confused with a harsher 30 percent liquidation scenario',async()=>{
  const h=harness(snapshot([row(62000)]));const candidate=engine.evaluate(h.snapshot,engine.DEFAULTS,NOW).candidates[0];
  await h.risk(candidate.symbol);const markup=h.markup();
  assert.match(markup,/20% 不利情景：/);assert.match(markup,/30% 情景触及强平线/);
  assert.match(markup,new RegExp('20% 情景维持率 '+candidate.primaryStress.marginRatio.toLocaleString('en-US',{style:'percent',maximumFractionDigits:2}).replace('.','\\.')));
  assert.match(markup,/先到期则按结算/);assert.match(markup,/最高 500%/);
});

test('legitimate fractional contract sizes and small positive premiums are never rounded into different trades or zero income',async()=>{
  const h=harness(snapshot([row(62000,'PUT',.1,{ask_price:.11,mark_price:.1,min_qty:.005,quantity_step:.005,quantity_scale:3})]));await h.input('ssQuantity','.005');
  assert.equal(h.symbols().length,1);assert.match(h.markup(),/数量 0\.005 张/);assert.doesNotMatch(h.markup(),/数量 0\.01 张/);
  assert.doesNotMatch(h.markup(),/<span>0 \/天（折算）<\/span>/);assert.doesNotMatch(h.markup(),/<strong>0 <small>USDT<\/small><\/strong><span>/);
});
