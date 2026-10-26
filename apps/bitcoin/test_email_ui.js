"use strict";

// Execute the shipped email controller against a fake local API. These tests
// never contact an SMTP server, read credentials or call the production API.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'terminal/dist/terminal.js'),'utf8');
const marker='// Email preferences use their own form';
assert.ok(source.includes(marker));
const script=source.slice(source.indexOf(marker));
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
const emptyState=()=>({enabled:false,configured:false,counts:{},recent:[]});
const activeState=()=>({enabled:true,configured:true,counts:{},recent:[]});

function mount(initial=emptyState(),options={}){
  const ids=['emailForm','emailSender','emailAuthorization','emailEnabled','emailSave','emailTest','emailRefresh','emailState','emailStatus','emailDelivery'];
  const elements=new Map(ids.map(id=>{
    const classes=new Set();
    return [id,{id,value:id==='emailSender'?'oxjackye@qq.com':'',checked:false,disabled:false,textContent:'',events:{},
      classList:{toggle(name,enabled){if(enabled)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name)},
      addEventListener(type,callback){this.events[type]=callback;},
      async emit(type){return this.events[type]?.({preventDefault(){}});}}];
  }));
  elements.get('emailForm').elements={};
  const requests=[],timers=new Map(),intervals=[],rootListeners=new Map(),documentListeners=new Map();
  let timerId=0,state=structuredClone(initial),responder=options.responder||null;
  const document={hidden:false,getElementById:id=>elements.get(id),addEventListener:(type,fn)=>documentListeners.set(type,fn)};
  const window={location:{hash:'#alerts'},addEventListener:(type,fn)=>rootListeners.set(type,fn)};
  const sandbox={window,document,AbortController,
    setInterval(callback,delay){intervals.push({callback,delay});},
    setTimeout(callback,delay){const id=++timerId;timers.set(id,{callback,delay});return id;},clearTimeout(id){timers.delete(id);},
    localStorage:{getItem(){throw new Error('Email credentials must not use browser storage');},setItem(){throw new Error('Email credentials must not use browser storage');}},
    async fetch(url,init={}){
      assert.ok(['/api/terminal/email','/api/terminal/email/settings','/api/terminal/email/test'].includes(url),'Unexpected real network target');
      requests.push({url,init});
      if(responder){const response=responder(url,init);if(response!==undefined)return await response;}
      if(url.endsWith('/settings')){state={...state,configured:true,enabled:JSON.parse(init.body).enabled};}
      const data=url.endsWith('/test')?{id:'fake-test-id',state:'queued'}:structuredClone(state);
      return {ok:true,status:200,json:async()=>data};
    }};
  vm.runInNewContext(script,sandbox);
  return {elements,requests,document,window,intervals,
    async ready(){await flush();},responder(fn){responder=fn;},
    state(value){state=structuredClone(value);},
    async expire(){for(const [id,timer]of [...timers])if(timers.delete(id))timer.callback();await flush();},
    async rootEvent(type,event={}){rootListeners.get(type)?.(event);await flush();},
    async documentEvent(type){documentListeners.get(type)?.();await flush();},
    async poll(){for(const timer of intervals)timer.callback();await flush();}};
}

test('email bootstrap reads public status only, with explicit sender default and no automatic test mail',async()=>{
  const view=mount();await view.ready();
  assert.equal(view.requests.length,1);assert.equal(view.requests[0].url,'/api/terminal/email');
  assert.equal(view.requests[0].init.method,undefined);
  assert.equal(view.elements.get('emailSender').value,'oxjackye@qq.com');
  assert.equal(view.elements.get('emailTest').disabled,true);
  assert.equal(view.elements.get('emailSave').disabled,false);
});

test('first configuration requires an SMTP authorization code before any write',async()=>{
  const view=mount();await view.ready();view.elements.get('emailEnabled').checked=true;
  await view.elements.get('emailForm').emit('input');await view.elements.get('emailForm').emit('submit');
  assert.equal(view.requests.length,1);assert.match(view.elements.get('emailStatus').textContent,/首次配置/);
});

test('saving uses the same-origin JSON header and clears the fake code immediately without testing mail',async()=>{
  const view=mount();await view.ready();let complete;
  view.responder(()=>new Promise(resolve=>{complete=resolve;}));
  view.elements.get('emailAuthorization').value='FIXTURE_AUTH_CODE';view.elements.get('emailEnabled').checked=true;
  const pending=view.elements.get('emailForm').emit('submit');
  assert.equal(view.elements.get('emailAuthorization').value,'');
  const request=view.requests.at(-1);
  assert.equal(request.url,'/api/terminal/email/settings');assert.equal(request.init.method,'POST');
  assert.equal(request.init.headers['X-Terminal-Request'],'1');assert.equal(request.init.headers['Content-Type'],'application/json');
  assert.deepEqual(JSON.parse(request.init.body),{email:'oxjackye@qq.com',enabled:true,authorization_code:'FIXTURE_AUTH_CODE'});
  assert.equal([...view.elements.values()].some(element=>element.value==='FIXTURE_AUTH_CODE'),false);
  complete({ok:true,status:200,json:async()=>activeState()});await pending;
  assert.equal(view.elements.get('emailSender').value,'');assert.equal(view.elements.get('emailTest').disabled,false);
  assert.equal(view.requests.some(item=>item.url.endsWith('/test')),false);
});

test('only an explicit test click submits one mail request and describes queueing without claiming delivery',async()=>{
  const view=mount(activeState());await view.ready();await view.elements.get('emailTest').emit('click');await flush();
  assert.equal(view.requests.filter(item=>item.url.endsWith('/test')).length,1);
  assert.deepEqual(JSON.parse(view.requests.find(item=>item.url.endsWith('/test')).init.body),{});
  assert.match(view.elements.get('emailStatus').textContent,/入队不代表已送达/);
});

test('configured senders can disable mail with blank credentials and cannot send disabled tests',async()=>{
  const view=mount(activeState());await view.ready();view.elements.get('emailEnabled').checked=false;
  await view.elements.get('emailForm').emit('input');await view.elements.get('emailForm').emit('submit');
  assert.deepEqual(JSON.parse(view.requests.at(-1).init.body),{email:'',enabled:false});
  assert.equal(view.elements.get('emailTest').disabled,true);await view.elements.get('emailTest').emit('click');
  assert.equal(view.requests.some(item=>item.url.endsWith('/test')),false);
});

test('invalid sender domains and changed sender without a new code are rejected before writing',async()=>{
  const view=mount(activeState());await view.ready();view.elements.get('emailSender').value='user@example.com';
  await view.elements.get('emailForm').emit('submit');assert.equal(view.requests.length,1);
  view.elements.get('emailSender').value='another@qq.com';await view.elements.get('emailForm').emit('submit');
  assert.equal(view.requests.length,1);assert.match(view.elements.get('emailStatus').textContent,/同时填写授权码/);
});

test('server errors never reflect raw credential-shaped response text into the page',async()=>{
  const view=mount();await view.ready();view.responder(async()=>({ok:false,status:400,json:async()=>({error:'FIXTURE_AUTH_CODE'})}));
  view.elements.get('emailAuthorization').value='FIXTURE_AUTH_CODE';view.elements.get('emailEnabled').checked=true;
  await view.elements.get('emailForm').emit('submit');
  assert.equal(view.elements.get('emailAuthorization').value,'');
  assert.equal([...view.elements.values()].some(element=>element.textContent.includes('FIXTURE_AUTH_CODE')),false);
  assert.equal(view.elements.get('emailSave').disabled,false);
});

test('a hung settings response times out, aborts and restores controls without automatically repeating the write',async()=>{
  const view=mount();await view.ready();view.responder(()=>new Promise(()=>{}));
  view.elements.get('emailAuthorization').value='FIXTURE_AUTH_CODE';view.elements.get('emailEnabled').checked=true;
  const pending=view.elements.get('emailForm').emit('submit');await view.expire();await pending;
  assert.match(view.elements.get('emailStatus').textContent,/结果尚未确认/);
  assert.equal(view.elements.get('emailSave').disabled,false);assert.equal(view.requests.at(-1).init.signal.aborted,true);
  assert.equal(view.requests.filter(item=>item.init.method==='POST').length,1);
});

test('a code entered after submission survives its older save response and remains unsaved',async()=>{
  const view=mount(activeState());await view.ready();let complete;
  view.responder(()=>new Promise(resolve=>{complete=resolve;}));view.elements.get('emailAuthorization').value='FIRST_FIXTURE_CODE';
  const pending=view.elements.get('emailForm').emit('submit');view.elements.get('emailAuthorization').value='SECOND_FIXTURE_CODE';
  await view.elements.get('emailForm').emit('input');complete({ok:true,status:200,json:async()=>activeState()});await pending;
  assert.equal(view.elements.get('emailAuthorization').value,'SECOND_FIXTURE_CODE');
  assert.match(view.elements.get('emailStatus').textContent,/后续修改/);
  await view.elements.get('emailTest').emit('click');assert.equal(view.requests.some(item=>item.url.endsWith('/test')),false);
});

test('a public read started before a save cannot roll the newly saved mail state backwards',async()=>{
  const view=mount({enabled:false,configured:true,counts:{},recent:[]});await view.ready();let finishRead;
  view.responder((url,init)=>init.method?undefined:new Promise(resolve=>{finishRead=resolve;}));
  const reading=view.elements.get('emailRefresh').emit('click');await flush();view.elements.get('emailEnabled').checked=true;
  await view.elements.get('emailForm').emit('input');await view.elements.get('emailForm').emit('submit');
  finishRead({ok:true,status:200,json:async()=>({enabled:false,configured:true,counts:{},recent:[]})});await reading;
  assert.equal(view.elements.get('emailEnabled').checked,true);assert.equal(view.elements.get('emailState').textContent,'已启用');
});

test('status refresh never sends mail and pauses when the page is hidden or left',async()=>{
  const view=mount(activeState());await view.ready();await view.poll();assert.equal(view.requests.length,2);
  view.document.hidden=true;await view.poll();assert.equal(view.requests.length,2);
  view.document.hidden=false;await view.rootEvent('pagehide');await view.poll();assert.equal(view.requests.length,2);
  await view.rootEvent('pageshow');assert.equal(view.requests.length,3);
  assert.ok(view.requests.every(item=>item.init.method===undefined));
});

test('failed initial state reads remain recoverable and display only safe availability guidance',async()=>{
  const view=mount(emptyState(),{responder:async()=>({ok:false,status:503})});await view.ready();
  assert.equal(view.elements.get('emailSave').disabled,true);assert.equal(view.elements.get('emailTest').disabled,true);
  assert.equal(view.elements.get('emailRefresh').disabled,false);assert.match(view.elements.get('emailStatus').textContent,/暂不可用/);
  view.responder(null);await view.elements.get('emailRefresh').emit('click');
  assert.equal(view.elements.get('emailState').textContent,'待配置');assert.equal(view.elements.get('emailSave').disabled,false);
});

test('a hanging JSON body is bounded by the same deadline and cannot duplicate a test request',async()=>{
  const view=mount(activeState());await view.ready();
  view.responder((url)=>url.endsWith('/test')?{ok:true,status:200,json:()=>new Promise(()=>{})}:undefined);
  const pending=view.elements.get('emailTest').emit('click');await view.expire();await pending;await flush();
  assert.match(view.elements.get('emailStatus').textContent,/结果尚未确认/);
  assert.equal(view.elements.get('emailTest').disabled,false);
  assert.equal(view.requests.filter(item=>item.url.endsWith('/test')).length,1);
});

test('the shipped authorization control is a non-autocompleting password input with explicit user-only test action',()=>{
  const html=fs.readFileSync(path.join(__dirname,'terminal/dist/index.html'),'utf8');
  const input=html.match(/<input\b[^>]*id="emailAuthorization"[^>]*>/)?.[0];
  assert.ok(input);assert.match(input,/type="password"/);assert.match(input,/autocomplete="off"/);
  assert.match(html,/<button\b[^>]*id="emailTest"[^>]*type="button"[^>]*>发送测试邮件<\/button>/);
});
