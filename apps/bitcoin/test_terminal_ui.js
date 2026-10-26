"use strict";

// Run the shipped controller and real event handlers without network, audio,
// permission prompts, or edits to the user's saved settings.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const html = fs.readFileSync("terminal/dist/index.html", "utf8");
const script = fs.readFileSync("terminal/dist/terminal.js", "utf8");
const now = Date.UTC(2030, 0, 1, 8);
const flush = async () => {for (let i = 0; i < 4; i++) await new Promise(setImmediate);};
function snapshot(overrides = {}) {
  return {instance_id:"process-A",revision:100,server_time_ms:now,
    settings:{threshold_pct:2.5,metric:"daily_change",sound:true,enabled:true},
    market:{price:80000,event_ms:now,received_ms:now,status:"live",day_open:79000,day_high:80100,day_low:78900},
    history:[{time_ms:now,price:80000}],alerts:[],...overrides};
}
function mount(initial = snapshot(), options = {}) {
  const roots = new Map(), elements = new Map(), requests = [], streams = [], notifications = [], audio = [], storage = new Map();
  const timers = new Map();let nextTimer = 0;
  if (options.notifications) storage.set("bitcoin-terminal-notifications", "true");
  const document = {hidden:false,title:"",activeElement:null};
  class Element {
    constructor(id = "") {
      this.id=id;this.textContent="";this.innerHTML="";this.hidden=false;this.disabled=false;this.value="";this.checked=false;
      this.dataset={};this.attributes={};this.children=[];this.style={};this.events=new Map();this.assignments=[];
      const classes = new Set();this.classList={toggle:(name,force)=>{if(force === undefined ? !classes.has(name) : force) classes.add(name);else classes.delete(name);},contains:name=>classes.has(name),add:name=>classes.add(name),remove:name=>classes.delete(name)};
      this.contentWindow={messages:[],postMessage(message,origin){this.messages.push({message,origin});}};
    }
    set src(value) {this._src=value;this.assignments.push(value);} get src() {return this._src;}
    addEventListener(type,fn) {if(!this.events.has(type))this.events.set(type,[]);this.events.get(type).push(fn);}
    async emit(type,event={}) {for(const fn of this.events.get(type)||[])await fn({target:this,preventDefault(){},...event});await flush();}
    setAttribute(name,value) {this.attributes[name]=String(value);} removeAttribute(name) {delete this.attributes[name];}
    querySelector(selector) {if(selector==="span")return this.label || (this.label=new Element());throw new Error("Unexpected element selector: "+selector);}
    querySelectorAll(selector) {assert.equal(selector,".nav-link");return links;}
    replaceChildren(...nodes) {this.children=nodes;} append(node) {this.children.push(node);} focus() {document.activeElement=this;}
    scrollIntoView() {} click() {if(this.dataset.page) {window.location.hash="#"+this.dataset.page;emitRoot("hashchange");}}
  }
  for(const match of html.matchAll(/id="([^"]+)"/g))elements.set(match[1],new Element(match[1]));
  const links=["alerts","options","wallet"].map(page=>{const link=new Element();link.dataset.page=page;return link;});
  document.body=new Element("body");document.getElementById=id=>{assert.ok(elements.has(id),"Unknown actual DOM id "+id);return elements.get(id);};
  document.createElement=()=>new Element();document.querySelector=selector=>links.find(link=>selector===`.nav-link[data-page="${link.dataset.page}"]`);
  document.addEventListener=(type,fn)=>{if(!roots.has("document:"+type))roots.set("document:"+type,[]);roots.get("document:"+type).push(fn);};
  async function emitRoot(type,event={}) {for(const fn of roots.get(type)||[])await fn(event);await flush();}
  let responder = options.responder || (async () => ({ok:true,status:200,json:async()=>structuredClone(initial)}));
  class ClockDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  class Stream {
    constructor(path){this.path=path;this.listeners=new Map();this.closed=false;streams.push(this);}
    addEventListener(type,fn){this.listeners.set(type,fn);} close(){this.closed=true;}
    receive(data){this.listeners.get("snapshot")({data:JSON.stringify(data)});}
  }
  class Notification {
    static permission="granted";
    static async requestPermission(){return "granted";}
    constructor(title,details){notifications.push({title,details});} close(){}
  }
  const window={document,Notification,location:{hash:options.hash||"",origin:"http://127.0.0.1:8766"},scrollTo(){},focus(){},
    setTimeout(fn,delay){const id=++nextTimer;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);},
    addEventListener(type,fn){if(!roots.has(type))roots.set(type,[]);roots.get(type).push(fn);},
    Audio:class {constructor(src){this.src=src;this.pauses=0;audio.push(this);}addEventListener(){}play(){return Promise.resolve();}pause(){this.pauses++;}}};
  const sandbox={window,document,Notification,EventSource:Stream,Date:ClockDate,Intl,console,URL,AbortController,
    setInterval(){},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    fetch:async(path,init={})=>{requests.push({path,init});return responder(path,init);}};
  vm.runInNewContext(script,sandbox);
  return {elements,links,document,window,requests,streams,notifications,audio,emitRoot,
    async timeoutRequests(){for(const [id,timer] of [...timers])if(timers.delete(id))timer.fn();await flush();},
    responder(fn){responder=fn;},async ready(){await flush();},async navigate(hash){window.location.hash=hash;await emitRoot("hashchange");},
    async emitDocument(type,event){await emitRoot("document:"+type,event);}};
}

test("real navigation handles deep links, aliases, keyboard wrap and one persistent options iframe",async()=>{
  const view=mount(snapshot(),{hash:"#options"});await view.ready();
  assert.equal(view.elements.get("optionsPage").hidden,false);assert.equal(view.elements.get("walletPage").hidden,true);
  assert.deepEqual(view.elements.get("optionsFrame").assignments,["/options.html"]);
  await view.navigate("#wallet-panel");assert.equal(view.elements.get("walletPage").hidden,false);
  await view.navigate("#options");assert.deepEqual(view.elements.get("optionsFrame").assignments,["/options.html"]);
  let prevented=false;await view.elements.get("pageNavigation").emit("keydown",{key:"ArrowRight",target:view.links[2],preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(view.window.location.hash,"#alerts");assert.equal(view.document.activeElement,view.links[0]);
  assert.equal(view.elements.get("alertsPage").hidden,false);
});
test("actual parent controller quarantines iframe focus by origin, source, active page and boolean state",async()=>{
  const view=mount();await view.ready();await view.navigate("#options");
  const event={origin:view.window.location.origin,source:view.elements.get("optionsFrame").contentWindow,data:{type:"options-focus",focused:true}};
  await view.emitRoot("message",{...event,origin:"https://foreign.example"});assert.equal(view.document.body.classList.contains("focus-options"),false);
  await view.emitRoot("message",{...event,source:view.elements.get("walletFrame").contentWindow});assert.equal(view.document.body.classList.contains("focus-options"),false);
  await view.emitRoot("message",event);assert.equal(view.document.body.classList.contains("focus-options"),true);
  await view.navigate("#wallet");assert.equal(view.document.body.classList.contains("focus-options"),false);
  await view.emitRoot("message",event);assert.equal(view.document.body.classList.contains("focus-options"),false);
  await view.navigate("#options");assert.equal(view.document.body.classList.contains("focus-options"),true);
  await view.emitRoot("message",{...event,data:{type:"options-focus",focused:false}});assert.equal(view.document.body.classList.contains("focus-options"),false);
});
test("actual wallet focus exits from its own iframe Escape and on navigation, preserving frame instance",async()=>{
  const view=mount();await view.ready();await view.navigate("#wallet");
  const frame=view.elements.get("walletFrame");await view.elements.get("focusWallet").emit("click");assert.equal(view.document.body.classList.contains("focus-wallet"),true);
  await view.emitRoot("message",{origin:view.window.location.origin,source:frame.contentWindow,data:{type:"wallet-escape"}});assert.equal(view.document.body.classList.contains("focus-wallet"),false);
  await view.elements.get("focusWallet").emit("click");await view.navigate("#alerts");assert.equal(view.document.body.classList.contains("focus-wallet"),false);
  assert.equal(view.elements.get("walletFrame"),frame);
});
test("real settings controller retains unsaved inputs through realtime snapshots and monitoring changes",async()=>{
  const view=mount();await view.ready();view.elements.get("thresholdInput").value="3.1";await view.elements.get("alarmForm").emit("input");
  view.streams[0].receive(snapshot({revision:101}));assert.equal(view.elements.get("thresholdInput").value,"3.1");
  view.responder(async()=>({ok:true,status:200,json:async()=>snapshot({revision:102,settings:{...snapshot().settings,enabled:false}})}));
  await view.elements.get("monitorButton").emit("click");assert.equal(view.elements.get("thresholdInput").value,"3.1");assert.equal(view.elements.get("monitorPill").textContent,"监测已暂停");
  assert.deepEqual(JSON.parse(view.requests.at(-1).init.body),{enabled:false});
});

test("three-tier settings are rendered, saved and confirmed by value through the real controller",async()=>{
  const tiers=[2.5,3.5,5],settings={...snapshot().settings,thresholds_pct:tiers};
  const view=mount(snapshot({settings}));await view.ready();
  assert.equal(view.elements.get("threshold2Input").value,"3.5");assert.equal(view.elements.get("threshold3Input").value,"5");
  await view.elements.get("alarmForm").emit("input");
  view.responder(async()=>({ok:true,status:200,json:async()=>snapshot({revision:101,settings})}));
  await view.elements.get("alarmForm").emit("submit");
  assert.deepEqual(JSON.parse(view.requests.at(-1).init.body),{threshold_pct:2.5,thresholds_pct:tiers,metric:"daily_change",sound:true});
  assert.equal(view.elements.get("settingsStatus").textContent,"设置已保存。");
  const count=view.requests.length;view.elements.get("threshold2Input").value="";
  await view.elements.get("alarmForm").emit("submit");assert.equal(view.requests.length,count);assert.match(view.elements.get("settingsStatus").textContent,/第二档/);
});

test("sound selection controls browser and backend previews and records identify their threshold",async()=>{
  const view=mount();await view.ready();
  for(const level of [2,3]){view.elements.get("alarmSoundLevel").value=String(level);await view.elements.get("previewAlarm").emit("click");assert.equal(view.audio.at(-1).src,`/audio/alert-${level}.wav`);await view.elements.get("testAlarm").emit("click");assert.deepEqual(JSON.parse(view.requests.at(-1).init.body),{sound_level:level});}
  view.streams[0].receive(snapshot({revision:101,alerts:[{id:"tier-two",kind:"market",direction:"down",threshold_pct:3.5,at_ms:now,change_pct:-3.6,price:79000}]}));
  assert.match(view.elements.get("latestAlert").textContent,/3.5%档/);
});
test("invalid form submits never write and rejected backend writes leave inputs and buttons recoverable",async()=>{
  const view=mount();await view.ready();const start=view.requests.length;
  view.elements.get("thresholdInput").value="0";await view.elements.get("alarmForm").emit("submit");assert.equal(view.requests.length,start);
  view.elements.get("thresholdInput").value="4";await view.elements.get("alarmForm").emit("input");
  view.responder(async()=>({ok:false,status:503,json:async()=>({error:"local backend unavailable"})}));await view.elements.get("alarmForm").emit("submit");
  assert.equal(view.elements.get("thresholdInput").value,"4");assert.equal(view.elements.get("saveSettings").disabled,false);assert.equal(view.elements.get("testAlarm").disabled,false);
  assert.match(view.elements.get("settingsStatus").textContent,/local backend unavailable/);
});
test("a pending save cannot discard edits made after submission",async()=>{
  const view=mount();await view.ready();view.elements.get("thresholdInput").value="3";await view.elements.get("alarmForm").emit("input");
  let complete;view.responder(()=>new Promise(resolve=>{complete=resolve;}));await view.elements.get("alarmForm").emit("submit");
  view.elements.get("thresholdInput").value="4";await view.elements.get("alarmForm").emit("input");
  complete({ok:true,status:200,json:async()=>snapshot({revision:101,settings:{...snapshot().settings,threshold_pct:3}})});await flush();
  assert.equal(view.elements.get("thresholdInput").value,"4");assert.match(view.elements.get("settingsStatus").textContent,/仍需保存|尚未保存/);
});
test("a process restart accepts its new lower revision while same-process older updates stay ignored",async()=>{
  const view=mount();await view.ready();view.streams[0].receive(snapshot({revision:99,market:{...snapshot().market,price:70000}}));assert.equal(view.elements.get("priceValue").textContent,"80,000.00");
  view.streams[0].receive(snapshot({instance_id:"process-B",revision:1,market:{...snapshot().market,price:81000}}));assert.equal(view.elements.get("priceValue").textContent,"81,000.00");
  view.streams[0].receive(snapshot({instance_id:"process-B",revision:0,market:{...snapshot().market,price:72000}}));assert.equal(view.elements.get("priceValue").textContent,"81,000.00");
  view.streams[0].receive(snapshot({revision:105,market:{...snapshot().market,price:71000}}));assert.equal(view.elements.get("priceValue").textContent,"81,000.00");
});
test("SSE disconnect marks cached data, and browser backcache restoration reconnects without reloading frames",async()=>{
  const view=mount(snapshot(),{hash:"#options"});await view.ready();view.streams[0].onerror();assert.equal(view.elements.get("feedBadge").label.textContent,"连接已中断");
  await view.emitRoot("pagehide",{persisted:true});assert.equal(view.streams[0].closed,true);
  await view.emitRoot("pageshow",{persisted:true});assert.equal(view.streams.length,2);assert.equal(view.streams[1].closed,false);
  view.streams[1].receive(snapshot({revision:101}));assert.equal(view.elements.get("feedBadge").label.textContent,"实时行情");
  view.streams[0].onerror();assert.equal(view.elements.get("feedBadge").label.textContent,"实时行情");
  assert.deepEqual(view.elements.get("optionsFrame").assignments,["/options.html"]);
});
test("actual notification controller suppresses hydration, duplicates, old, test and malformed alerts",async()=>{
  const initialAlert={id:"existing",kind:"market",at_ms:now,direction:"up",price:80000,change_pct:2.5};
  const view=mount(snapshot({alerts:[initialAlert]}),{notifications:true});await view.ready();assert.equal(view.notifications.length,0);
  const alerts=[initialAlert,{...initialAlert,id:"new"},{...initialAlert,id:"old",at_ms:now-31000},{...initialAlert,id:"test",kind:"test"},{...initialAlert,id:"invalid",at_ms:"today"}];
  view.streams[0].receive(snapshot({revision:101,alerts}));assert.equal(view.notifications.length,1);
  view.streams[0].receive(snapshot({revision:102,alerts}));assert.equal(view.notifications.length,1);
  assert.match(view.notifications[0].details.body,/2.50%/);
});
test("navigation and stop action cancel browser preview even if backend silence is unavailable",async()=>{
  const view=mount();await view.ready();await view.elements.get("previewAlarm").emit("click");assert.equal(view.audio.length,1);
  await view.navigate("#wallet");assert.equal(view.audio[0].pauses,1);await view.navigate("#alerts");
  await view.elements.get("previewAlarm").emit("click");view.responder(async()=>({ok:false,status:500,json:async()=>({error:"no service"})}));await view.elements.get("silenceAlarm").emit("click");
  assert.equal(view.audio[1].pauses,1);assert.match(view.elements.get("settingsStatus").textContent,/网页试听已停止/);
});
test("failed bootstrap and malformed stream data remain visibly unavailable until a valid live snapshot recovers",async()=>{
  const view=mount(snapshot(),{responder:async()=>({ok:false,status:503})});await view.ready();
  assert.equal(view.streams.length,1);assert.equal(view.elements.get("connectionNotice").hidden,false);assert.match(view.elements.get("connectionNotice").textContent,/503/);
  view.streams[0].receive({revision:100});assert.equal(view.elements.get("priceValue").textContent,"");assert.match(view.elements.get("settingsStatus").textContent,/结构不完整/);
  view.streams[0].receive(snapshot());assert.equal(view.elements.get("priceValue").textContent,"80,000.00");assert.equal(view.elements.get("feedBadge").label.textContent,"实时行情");assert.equal(view.elements.get("connectionNotice").hidden,true);
  assert.equal(view.elements.get("settingsStatus").textContent,"行情连接已恢复。");assert.equal(view.elements.get("settingsStatus").classList.contains("error"),false);
});
test("stream recovery does not overwrite an unsaved settings message entered after a malformed event",async()=>{
  const view=mount();await view.ready();view.streams[0].receive({revision:101});
  view.elements.get("thresholdInput").value="4";await view.elements.get("alarmForm").emit("input");
  view.streams[0].receive(snapshot({revision:102}));assert.equal(view.elements.get("settingsStatus").textContent,"设置未保存。");
  assert.equal(view.elements.get("thresholdInput").value,"4");
});
test("turning off desktop notifications takes effect immediately for later market alarms without changing monitoring",async()=>{
  const view=mount(snapshot(),{notifications:true});await view.ready();assert.equal(view.elements.get("desktopNotifications").textContent,"关闭桌面通知");
  await view.elements.get("desktopNotifications").emit("click");assert.equal(view.elements.get("desktopNotifications").textContent,"开启桌面通知");
  view.streams[0].receive(snapshot({revision:101,alerts:[{id:"silent-new",kind:"market",at_ms:now,direction:"up",price:80000,change_pct:2.5}]}));
  assert.equal(view.notifications.length,0);assert.equal(view.elements.get("monitorPill").textContent,"监测已启用");assert.equal(view.requests.length,1);
});
test("a hanging bootstrap never blocks the live stream and its late timeout cannot overwrite recovered data",async()=>{
  const view=mount(snapshot(),{responder:()=>new Promise(()=>{})});await view.ready();
  assert.equal(view.streams.length,1);assert.equal(view.requests[0].init.signal.aborted,false);
  view.streams[0].receive(snapshot({revision:101}));assert.equal(view.elements.get("feedBadge").label.textContent,"实时行情");
  await view.timeoutRequests();assert.equal(view.requests[0].init.signal.aborted,true);
  assert.equal(view.elements.get("feedBadge").label.textContent,"实时行情");assert.equal(view.elements.get("connectionNotice").hidden,true);
});
test("a hanging settings response body times out, restores controls and preserves unsaved input without retrying the write",async()=>{
  const view=mount();await view.ready();view.elements.get("thresholdInput").value="3.5";await view.elements.get("alarmForm").emit("input");
  view.responder(async()=>({ok:true,status:200,json:()=>new Promise(()=>{})}));await view.elements.get("alarmForm").emit("submit");
  assert.equal(view.elements.get("saveSettings").disabled,true);const count=view.requests.length;
  await view.timeoutRequests();assert.equal(view.elements.get("saveSettings").disabled,false);assert.equal(view.elements.get("testAlarm").disabled,false);
  assert.equal(view.elements.get("thresholdInput").value,"3.5");assert.match(view.elements.get("settingsStatus").textContent,/超时.*尚未确认/);
  assert.equal(view.requests.length,count);assert.equal(view.requests.at(-1).init.signal.aborted,true);
});
test("a save reply from a retired process cannot claim success or discard the user's still-unconfirmed settings",async()=>{
  const view=mount();await view.ready();view.elements.get("thresholdInput").value="3.5";await view.elements.get("alarmForm").emit("input");
  let complete;view.responder(()=>new Promise(resolve=>{complete=resolve;}));await view.elements.get("alarmForm").emit("submit");
  await view.emitRoot("pagehide",{persisted:true});view.responder(async()=>({ok:true,status:200,json:async()=>snapshot({instance_id:"process-B",revision:1})}));
  await view.emitRoot("pageshow",{persisted:true});view.streams[1].receive(snapshot({instance_id:"process-B",revision:1}));
  complete({ok:true,status:200,json:async()=>snapshot({revision:101,settings:{...snapshot().settings,threshold_pct:3.5}})});await flush();
  assert.equal(view.elements.get("thresholdInput").value,"3.5");assert.match(view.elements.get("settingsStatus").textContent,/尚未确认/);
  assert.equal(view.elements.get("saveSettings").disabled,false);
});
test("a newer conflicting same-process setting cannot be overwritten or reported as a confirmed older save",async()=>{
  const view=mount();await view.ready();view.elements.get("thresholdInput").value="3";await view.elements.get("alarmForm").emit("input");
  let complete;view.responder(()=>new Promise(resolve=>{complete=resolve;}));await view.elements.get("alarmForm").emit("submit");
  view.streams[0].receive(snapshot({revision:103,settings:{...snapshot().settings,threshold_pct:4}}));
  complete({ok:true,status:200,json:async()=>snapshot({revision:102,settings:{...snapshot().settings,threshold_pct:3}})});await flush();
  assert.equal(view.elements.get("thresholdInput").value,"3");assert.match(view.elements.get("settingsStatus").textContent,/尚未确认/);
  view.responder(async()=>({ok:true,status:200,json:async()=>snapshot({revision:104,settings:{...snapshot().settings,threshold_pct:3}})}));
  await view.elements.get("alarmForm").emit("submit");assert.equal(view.elements.get("settingsStatus").textContent,"设置已保存。");
});
