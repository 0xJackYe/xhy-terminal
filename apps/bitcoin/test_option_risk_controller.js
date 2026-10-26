"use strict";

// Exercise the actual browser controller and DOM event listeners. This harness
// supplies only browser boundaries; pricing stays in the production calculator.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Risk = require("./dashboard/dist/risk-metrics.js");
const root = path.join(__dirname, "dashboard", "dist");

function harness() {
  let now = Date.parse("2030-01-01T00:00:00Z"), nextTimer = 0, reads = 0;
  const nodes = new Map(), intervals = new Map(), intervalPeriods = new Map(), timeouts = new Map(), timeoutPeriods = new Map(), analyses = [], downloads = [], blobs = new Map(), revoked = [], created = [], mutations = [];
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  class Element {
    constructor(tag = "div", id = "") {
      this.tagName=tag.toUpperCase();this.id=id;this.listeners={};this.dataset={};this.hidden=false;this.disabled=false;this.checked=false;this.open=false;this._value="";this._html="";this.options=[];this.focusCount=0;this.removed=false;this.attributes=new Map();this.childNodes=[];this.parentNode=null;created.push(this);
      const classes=new Set();this.classList={add:(name)=>classes.add(name),remove:(name)=>classes.delete(name),contains:(name)=>classes.has(name),toggle:(name,enabled)=>{const value=enabled===undefined?!classes.has(name):enabled;value?classes.add(name):classes.delete(name);return value;}};
    }
    addEventListener(type, callback) {(this.listeners[type]??=[]).push(callback);}
    fire(type, event = {}) {const e={target:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...event};for(const callback of this.listeners[type]??[])callback(e);return e;}
    click() {if(this.disabled)return;if(this.tagName==="A")downloads.push({url:this.href,filename:this.download});this.fire("click");}
    focus() {this.focusCount++;document.activeElement=this;}
    showModal() {assert.equal(this.open,false,"native showModal must not be called twice");this.open=true;this.focus();}
    close() {if(!this.open)return;this.open=false;this.fire("close");}
    appendChild(element) {return this.insertBefore(element,null);}
    insertBefore(element,before) {
      assert.ok(before===null||before.parentNode===this,"insertBefore reference belongs to parent");
      mutations.push({kind:"insert",node:element,parent:this});
      if(element.parentNode){const old=element.parentNode;old.childNodes.splice(old.childNodes.indexOf(element),1);}
      const index=before===null?this.childNodes.length:this.childNodes.indexOf(before);this.childNodes.splice(index,0,element);element.parentNode=this;return element;
    }
    remove() {mutations.push({kind:"remove",node:this,parent:this.parentNode});if(this.parentNode){const parent=this.parentNode;parent.childNodes.splice(parent.childNodes.indexOf(this),1);this.parentNode=null;}this.removed=true;}
    setAttribute(name,value) {mutations.push({kind:"attribute",node:this,name,value:String(value)});this.attributes.set(name,String(value));this[name]=String(value);}
    getAttribute(name) {return this.attributes.get(name)??null;}
    get children() {return this.childNodes;}
    get cells() {return this.childNodes.filter(child=>child.tagName==="TH"||child.tagName==="TD");}
    get firstChild() {return this.childNodes[0]??null;}
    get nextSibling() {return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this)+1]??null;}
    set scrollTop(value) {mutations.push({kind:"scroll",node:this,name:"scrollTop",value});this._scrollTop=value;}
    get scrollTop() {return this._scrollTop??0;}
    set scrollLeft(value) {mutations.push({kind:"scroll",node:this,name:"scrollLeft",value});this._scrollLeft=value;}
    get scrollLeft() {return this._scrollLeft??0;}
    querySelectorAll() {return [];}
    getClientRects() {return [{}];}
    contains(element) {return element===this;}
    set value(value) {const text=String(value);this._value=this.tagName==="SELECT"&&!this.options.includes(text)?"":text;}
    get value() {return this._value;}
    set innerHTML(value) {
      mutations.push({kind:"html",node:this});
      for(const child of this.childNodes)child.parentNode=null;this.childNodes=[];
      this._html=String(value);
      if(this.tagName==="SELECT"){
        const before=this._value;this.options=[...this._html.matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)].map(match=>match[1]);
        this._value=this.options.includes(before)?before:this.options[0]??"";
      }
      // Model table parsing and DOM identity independently of the controller.
      // Content inside a cell stays opaque; the browser owns its descendants.
      if(this.tagName==="TBODY"||this.tagName==="TR"){
        const expected=this.tagName==="TBODY"?"TR":null;
        for(const match of this._html.matchAll(/<(tr|th|td)\b([^>]*)>([\s\S]*?)<\/\1>/g)){
          if(expected&&match[1].toUpperCase()!==expected)continue;
          const child=new Element(match[1]);for(const attribute of match[2].matchAll(/([\w-]+)="([^"]*)"/g))child.attributes.set(attribute[1],attribute[2]);child.innerHTML=match[3];this.appendChild(child);
        }
      }
    }
    get innerHTML() {return this.childNodes.length||this.tagName==="TBODY"||this.tagName==="TR"?this.childNodes.map(child=>child.outerHTML).join(""):this._html;}
    get outerHTML() {const escape=value=>String(value).replace(/[&"<>]/g,char=>({"&":"&amp;",'"':"&quot;","<":"&lt;",">":"&gt;"}[char]));return `<${this.tagName.toLowerCase()}${[...this.attributes].map(([name,value])=>` ${name}="${escape(value)}"`).join("")}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;}
  }
  for(const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)){
    const [full,tag,attributes,id]=match,node=new Element(tag,id);node.hidden=/\bhidden\b/.test(attributes);node.disabled=/\bdisabled\b/.test(attributes);node.checked=/\bchecked\b/.test(attributes);
    for(const attribute of attributes.matchAll(/([\w-]+)="([^"]*)"/g))node.attributes.set(attribute[1],attribute[2]);
    if(tag==="select"){
      const end=html.indexOf("</select>",match.index+full.length);node.innerHTML=html.slice(match.index+full.length,end);
    }else node.value=/\bvalue="([^"]*)"/.exec(attributes)?.[1]??"";
    nodes.set(id,node);
  }
  const document={hidden:false,activeElement:null,body:new Element("body"),listeners:{},getElementById:id=>nodes.get(id)??null,createElement:tag=>new Element(tag),
    addEventListener(type,callback){(this.listeners[type]??=[]).push(callback);},fire(type,event){for(const callback of this.listeners[type]??[])callback(event);}};
  const node=id=>{assert.ok(nodes.has(id),"real markup contains #"+id);return nodes.get(id);};
  class ClockDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const window={OptionRisk:{analyze(params){const result=Risk.analyze(params);analyses.push({params,result});return result;}}};
  const context=vm.createContext({window,document,Date:ClockDate,Intl,console,Blob,RangeError,
    URL:{createObjectURL(blob){const url="blob:controlled-risk-"+(blobs.size+1);blobs.set(url,blob);return url;},revokeObjectURL(url){revoked.push(url);}},
    setInterval(fn,period){const id=++nextTimer;intervals.set(id,fn);intervalPeriods.set(id,period);return id;},clearInterval(id){intervals.delete(id);intervalPeriods.delete(id);},
    setTimeout(fn,period){const id=++nextTimer;timeouts.set(id,fn);timeoutPeriods.set(id,period);return id;},clearTimeout(id){timeouts.delete(id);timeoutPeriods.delete(id);}});
  vm.runInContext(fs.readFileSync(path.join(root,"risk-ui.js"),"utf8"),context,{filename:"risk-ui.js"});
  const expiryA=Date.parse("2030-01-10T08:00:00Z"),expiryB=Date.parse("2030-01-17T08:00:00Z");
  function row(strike=64000,side="PUT",expiry=expiryA,overrides={}){
    return Object.assign({symbol:`BTC-${expiry===expiryA?"300110":"300117"}-${strike}-${side==="CALL"?"C":"P"}`,side,status:"TRADING",strike_price:String(strike),unit:"1",quote_asset:"USDT",min_qty:"0.01",max_qty:"100",quantity_scale:2,bid_price:"100",ask_price:"120",bid_quantity:"2",ask_quantity:"2",quote_source:"websocket",quote_updated_at:new Date(now).toISOString(),expiry_ms:expiry,mark_iv:".6",delta:side==="PUT"?"-.1":".1",gamma:".0001",vega:"30",theta:"-2"},overrides);
  }
  function snapshot(options){return {btc_index_price:"80000",index_source:"websocket",index_updated_at:new Date(now).toISOString(),fetched_at:new Date(now).toISOString(),exchange_clock_offset_ms:0,options:options??[row(),row(70000,"PUT",expiryA,{bid_price:"300",ask_price:"320"}),row(90000,"CALL"),row(60000,"PUT",expiryB)]};}
  let latest=snapshot(),expiry="2030-01-10";
  const hooks={getSnapshot(){reads++;return latest;},getExpiry:()=>expiry};
  window.OptionRiskUI.initialize(hooks);
  const keyboardStart=fs.readFileSync(path.join(root,"app.js"),"utf8").indexOf('document.addEventListener("keydown", (event) => {');
  const app=fs.readFileSync(path.join(root,"app.js"),"utf8");
  const keyboardEnd=app.indexOf("\n});",keyboardStart);
  assert.ok(keyboardStart>=0&&keyboardEnd>keyboardStart,"actual parent keyboard handler exists");
  context.$=document.getElementById;context.closeDrawer=()=>{node("detailDrawer").hidden=true;};context.applyQuoteFocus=enabled=>document.body.classList.toggle("quote-focus",enabled);
  vm.runInContext(app.slice(keyboardStart,keyboardEnd+4),context,{filename:"actual-app-keyboard-handler.js"});
  node("detailDrawer").hidden=true;
  function field(id,value,type="change"){node(id).value=value;node(id).fire(type);}
  function symbols(){return [...node("riskRows").innerHTML.matchAll(/data-risk-symbol="([^"]+)"/g)].map(match=>match[1]);}
  function validity(){return [...node("riskRows").innerHTML.matchAll(/data-risk-valid="([^"]+)"/g)].map(match=>match[1]);}
  function renderedRow(symbol){return [...node("riskRows").innerHTML.matchAll(/<tr\b[^>]*data-risk-symbol="([^"]+)"[^>]*>[\s\S]*?<\/tr>/g)].find(match=>match[1]===symbol)?.[0]??"";}
  return {node,window,context,document,intervals,intervalPeriods,timeouts,timeoutPeriods,analyses,downloads,blobs,revoked,created,mutations,hooks,row,snapshot,field,symbols,validity,renderedRow,
    expiryA,expiryB,get latest(){return latest;},set latest(value){latest=value;},get reads(){return reads;},setExpiry:value=>{expiry=value;},
    advance:ms=>{now+=ms;},tick(){for(const fn of [...intervals.values()])fn();},runTimeouts(period=null){for(const [id,fn]of [...timeouts]){if(period!==null&&timeoutPeriods.get(id)!==period)continue;timeouts.delete(id);timeoutPeriods.delete(id);fn();}},
    escape(){const event={key:"Escape",defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};document.fire("keydown",event);if(node("riskDialog").open&&!event.defaultPrevented){const cancel=node("riskDialog").fire("cancel");if(!cancel.defaultPrevented)node("riskDialog").close();}return event;}};
}

let count=0;
async function check(name,fn){await fn();count++;console.log("OK risk controller: "+name);}
function versioned(h, revision, premium=100, instance="risk-events") {
  return {...h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:String(premium),ask_price:String(premium+20)})]),instance_id:instance,revision};
}
function certifiedSnapshot(h,revision,overrides={}) {
  const source=versioned(h,revision),row=source.options[0],at=Date.parse(source.index_updated_at);
  Object.assign(row,{quote_updated_at:"2029-12-31T23:00:00.000Z"},overrides);
  row.quote_verified_at=at;row.quote_verification={verified:true,kind:"bookTicker",connection:"book-0",generation:1,verified_at:at,baseline_at:Date.parse("2029-12-31T23:00:00.000Z"),values:Object.fromEntries(["bid_price","ask_price","bid_quantity","ask_quantity"].map(field=>[field,row[field]]))};
  return source;
}
function tableMutations(h, start) {return h.mutations.slice(start).filter(event=>["TBODY","TR","TH","TD"].includes(event.node.tagName));}
(async()=>{
  await check("normal entry opens native dialog with real markup defaults and selected chain expiry",()=>{
    const h=harness();h.node("riskButton").click();assert.equal(h.node("riskDialog").open,true);
    assert.equal(h.node("riskExpiry").value,"2030-01-10");assert.equal(h.node("riskDirection").value,"SELL");assert.equal(h.node("riskType").value,"PUT");
    assert.equal(h.node("riskQuantity").value,"0.01");assert.equal(h.node("riskVol").value,"60");
    assert.equal(h.reads,1);assert.equal(h.intervals.size,1);assert.deepEqual([...h.intervalPeriods.values()],[2000]);assert.equal(h.symbols().length,2);assert.deepEqual(h.validity(),["true","true"],h.node("riskRows").innerHTML);
    assert.equal(h.node("riskHideUnavailable").checked,true);assert.equal(h.node("riskLive").textContent,"暂停更新");assert.equal(h.node("riskLive").getAttribute("aria-pressed"),"false");
  });
  await check("focus entry opens same dialog and close restores its own trigger focus",()=>{
    const h=harness();h.document.body.classList.add("quote-focus");h.node("focusRiskButton").click();assert.equal(h.node("riskDialog").open,true);
    h.node("riskClose").click();assert.equal(h.node("riskDialog").open,false);assert.equal(h.document.activeElement,h.node("focusRiskButton"));
    assert.equal(h.intervals.size,0);assert.equal(h.document.body.classList.contains("quote-focus"),true);
  });
  await check("initialization is idempotent and repeated open replaces the caption interval",()=>{
    const h=harness();h.window.OptionRiskUI.initialize(h.hooks);h.node("riskButton").click();assert.equal(h.reads,1);
    h.node("riskButton").click();assert.equal(h.reads,2);assert.equal(h.intervals.size,1);
    h.node("riskClose").click();h.node("focusRiskButton").click();assert.equal(h.intervals.size,1);
  });
  await check("quantity input recomputes actual metrics at new size",()=>{
    const h=harness();h.node("riskButton").click();const first=h.analyses[0];h.analyses.length=0;h.field("riskQuantity","0.02","input");
    assert.equal(h.analyses.length,2);assert.ok(h.analyses.every(item=>item.params.quantity===.02));assert.equal(h.analyses[0].result.maxLoss,first.result.maxLoss*2);
  });
  await check("volatility and arithmetic drift inputs reach real calculator as fractions",()=>{
    const h=harness();h.node("riskButton").click();const initial=h.analyses[0].result.model.expectedPnl;
    h.field("riskVol","85","input");h.field("riskDrift","-10","input");
    assert.equal(h.analyses.at(-1).params.annualVol,.85);assert.equal(h.analyses.at(-1).params.annualDrift,-.1);
    assert.notEqual(h.analyses.at(-2).result.model.expectedPnl,initial);
  });
  await check("risk-budget input updates displayed single-leg limit warning without changing payoff",()=>{
    const h=harness();h.node("riskButton").click();const original=h.analyses[0].result.maxLoss;
    h.field("riskBudget","1","input");assert.match(h.node("riskRows").innerHTML,/最大亏损超预算/);assert.equal(h.analyses.at(-2).result.maxLoss,original);
    h.field("riskBudget","1000","input");assert.doesNotMatch(h.node("riskRows").innerHTML,/最大亏损超预算/);
  });
  await check("small nonzero Gamma remains visible in decimal and scientific formats",()=>{
    const h=harness();h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{gamma:"0.00000272"}),h.row(70000,"PUT",h.expiryA,{gamma:"1e-12"})]);h.node("riskButton").click();
    assert.match(h.node("riskRows").innerHTML,/<td>0\.00000272<small>/);assert.match(h.node("riskRows").innerHTML,/<td>1\.0+e-12<small>/);
    assert.doesNotMatch(h.node("riskRows").innerHTML,/<td>0<small>ν/);
  });
  await check("blank and invalid controller settings clear calculations and recover",()=>{
    const h=harness();h.node("riskButton").click();h.field("riskQuantity","","input");
    assert.equal(h.node("riskError").hidden,false);assert.equal(h.symbols().length,0);assert.equal(h.node("riskExport").disabled,true);
    h.field("riskQuantity","0.02","input");assert.equal(h.node("riskError").hidden,true);assert.equal(h.symbols().length,2);
  });
  await check("ordinary quote ticks and source-object mutations cannot replace frozen snapshot",()=>{
    const h=harness();h.node("riskButton").click();h.node("riskLive").click();const before=h.node("riskRows").innerHTML;
    h.latest.btc_index_price="90000";h.latest.options[0].bid_price="999";h.latest.options[0].ask_price="1000";h.tick();
    assert.equal(h.reads,1);assert.equal(h.node("riskRows").innerHTML,before);
    h.analyses.length=0;h.field("riskQuantity","0.02","input");assert.equal(h.analyses[0].params.spot,80000);assert.equal(h.analyses[0].params.premium,100);
    h.node("riskRefresh").click();assert.equal(h.reads,2);assert.equal(h.analyses.at(-2).params.spot,90000);assert.equal(h.analyses.at(-2).params.premium,999);
  });
  await check("manual latest-snapshot refresh preserves all chosen controls",()=>{
    const h=harness();h.node("riskButton").click();
    for(const [id,value]of [["riskExpiry","ALL"],["riskType","CALL"],["riskDirection","BUY"],["riskSort","tail"]])h.field(id,value);
    for(const [id,value]of [["riskQuantity","0.02"],["riskVol","80"],["riskDrift","10"],["riskBudget","123"]])h.field(id,value,"input");
    h.latest=h.snapshot([h.row(90000,"CALL",h.expiryA,{ask_price:"333"}),h.row(95000,"CALL",h.expiryB)]);h.node("riskRefresh").click();
    const expected={riskExpiry:"ALL",riskType:"CALL",riskDirection:"BUY",riskSort:"tail",riskQuantity:"0.02",riskVol:"80",riskDrift:"10",riskBudget:"123"};
    for(const [id,value]of Object.entries(expected))assert.equal(h.node(id).value,value,id);
    assert.ok(h.analyses.slice(-2).some(item=>item.params.premium===333));assert.equal(h.symbols().length,2);
  });
  await check("opening follows newly selected chain expiry while explicit scope exposes all dates",()=>{
    const h=harness();h.setExpiry("2030-01-17");h.node("riskButton").click();assert.equal(h.symbols().length,1);assert.match(h.symbols()[0],/300117/);
    h.field("riskExpiry","ALL");assert.equal(h.symbols().length,3);assert.match(h.node("riskRows").innerHTML,/2030-01-10/);assert.match(h.node("riskRows").innerHTML,/2030-01-17/);
  });
  await check("type direction and sorting changes update visible rows through registered events",()=>{
    const h=harness();h.node("riskButton").click();h.field("riskExpiry","ALL");h.field("riskType","ALL");h.field("riskSort","strike");
    assert.deepEqual(h.symbols().map(symbol=>Number(symbol.split("-")[2])),[60000,64000,70000,90000]);
    h.analyses.length=0;h.field("riskDirection","BUY");assert.ok(h.analyses.every(item=>item.params.direction==="BUY"));
    h.field("riskType","CALL");assert.equal(h.symbols().length,1);assert.match(h.node("riskRows").innerHTML,/盈利无上限/);
  });
  await check("expected-value sort affects rendered order and explains assumption dependence",()=>{
    const h=harness();h.node("riskButton").click();h.field("riskExpiry","ALL");h.analyses.length=0;h.field("riskSort","expected");
    const expected=[...h.analyses].sort((a,b)=>b.result.model.expectedPnl-a.result.model.expectedPnl).map(item=>item.params.strike);
    assert.deepEqual(h.symbols().map(symbol=>Number(symbol.split("-")[2])),expected);assert.match(h.node("riskModelCaption").textContent,/模型.*非预测/);
  });
  await check("paused aging snapshot retains frozen metrics without falsely claiming expiry",()=>{
    const h=harness();h.node("riskButton").click();h.node("riskLive").click();const original=JSON.stringify(h.analyses[0].result),years=h.analyses[0].params.years,calls=h.analyses.length;
    h.advance(21000);h.tick();assert.equal(h.analyses.length,calls,"paused timer paints status without recomputing models");assert.deepEqual(h.validity(),["true","true"]);assert.match(h.node("riskRows").innerHTML,/历史快照|已暂停|已固定/);
    assert.doesNotMatch(h.node("riskRows").innerHTML,/已到期|已成交/);assert.doesNotMatch(h.node("riskFreshness").textContent??"",/已陈旧或已到期/);
    assert.equal([...h.node("riskRows").innerHTML.matchAll(/data-risk-current="false"/g)].length,2);
    assert.equal(JSON.stringify(h.analyses.at(-2).result),original);assert.equal(h.analyses.at(-2).params.years,years);
    h.latest=h.snapshot();h.node("riskRefresh").click();assert.deepEqual(h.validity(),["true","true"]);
    assert.equal(h.node("riskLive").textContent,"恢复实时");assert.doesNotMatch(h.node("riskRows").innerHTML,/已到期/);
  });
  await check("a zero bid is presented as unavailable and is never evaluated as free premium",()=>{
    const h=harness();h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:"0"}),h.row()]);h.node("riskButton").click();
    assert.equal(h.analyses.length,1);assert.deepEqual(h.validity(),["true"]);
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");
    assert.equal(h.validity().filter(value=>value==="false").length,1);assert.match(h.node("riskRows").innerHTML,/暂无买盘/);
  });
  await check("missing market data shows recoverable error without stale calculations",()=>{
    const h=harness();h.latest=null;h.node("riskButton").click();assert.equal(h.node("riskError").hidden,false);assert.equal(h.node("riskExport").disabled,true);assert.equal(h.analyses.length,0);
    h.latest=h.snapshot();h.node("riskRefresh").click();assert.equal(h.node("riskError").hidden,true);assert.ok(h.analyses.length>0);
  });
  await check("first Escape closes native dialog and second Escape leaves quote focus",()=>{
    const h=harness();h.document.body.classList.add("quote-focus");h.node("focusRiskButton").click();
    const first=h.escape();assert.equal(first.defaultPrevented,false);assert.equal(h.node("riskDialog").open,false);assert.equal(h.document.body.classList.contains("quote-focus"),true);assert.equal(h.intervals.size,0);
    const second=h.escape();assert.equal(second.defaultPrevented,true);assert.equal(h.document.body.classList.contains("quote-focus"),false);
  });
  await check("CSV export uses scoped rendered rows and browser blob boundary without actual download",async()=>{
    const h=harness();h.node("riskButton").click();h.field("riskType","CALL");h.node("riskExport").click();assert.equal(h.downloads.length,1);
    const file=h.downloads[0],blob=h.blobs.get(file.url),csv=await blob.text();assert.match(file.filename,/BTC-期权收益风险-.*\.csv$/);assert.equal(blob.type,"text/csv;charset=utf-8");
    assert.match(csv,/BTC-300110-90000-C/);assert.doesNotMatch(csv,/BTC-300110-64000-P/);assert.match(csv,/无限/);assert.doesNotMatch(csv,/Infinity|NaN|undefined/);
    assert.equal(h.revoked.length,0);h.runTimeouts();assert.deepEqual(h.revoked,[file.url]);
  });
  await check("export labels historical snapshot while keeping its exact original modeled values",async()=>{
    const h=harness();h.node("riskButton").click();h.node("riskLive").click();const expected=h.analyses[0].result.model.expectedPnl;h.advance(21000);h.tick();h.node("riskExport").click();
    const csv=await h.blobs.get(h.downloads[0].url).text();assert.match(csv,/历史快照/);assert.match(h.node("riskRows").innerHTML,/data-risk-current="false"/);
    assert.ok(csv.includes(String(expected)),"export retains the original fixed-time expected PnL");assert.deepEqual(h.validity(),["true","true"]);
  });
  await check("already stale data at initial open or refresh cannot create computed historical results",()=>{
    const h=harness();h.advance(21000);h.node("riskButton").click();assert.deepEqual(h.validity(),[]);assert.equal(h.analyses.length,0);
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");assert.deepEqual(h.validity(),["false","false"]);
    h.node("riskRefresh").click();assert.deepEqual(h.validity(),["false","false"]);assert.equal(h.analyses.length,0);
    h.latest=h.snapshot();h.node("riskRefresh").click();assert.deepEqual(h.validity(),["true","true"]);assert.equal(h.analyses.length,2);
  });
  await check("reaching expiry marks history without changing the originally frozen pricing horizon",()=>{
    const h=harness();h.node("riskButton").click();h.node("riskLive").click();const first=JSON.stringify(h.analyses[0].result),calls=h.analyses.length;
    h.advance(9*86400000+8*3600000);h.tick();assert.equal(h.analyses.length,calls);assert.deepEqual(h.validity(),["true","true"]);assert.match(h.node("riskRows").innerHTML,/已到期.*历史快照/);
    assert.equal(JSON.stringify(h.analyses.at(-2).result),first);assert.match(h.node("riskRows").innerHTML,/data-risk-current="false"/);
  });
  await check("invalid settings and empty scopes cannot invoke a browser download",()=>{
    const h=harness();h.node("riskButton").click();h.field("riskVol","","input");h.node("riskExport").click();assert.equal(h.downloads.length,0);
    h.field("riskVol","60","input");h.field("riskExpiry","2030-01-17");h.field("riskType","CALL");assert.equal(h.node("riskEmpty").hidden,false);h.node("riskExport").click();assert.equal(h.downloads.length,0);
  });
  await check("live polling reuses the shared snapshot at two-second intervals and updates model prices",()=>{
    const h=harness();h.latest=h.snapshot([h.row()]);h.node("riskButton").click();const before=h.analyses[0].params.years;
    h.advance(2000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:"199",ask_price:"201"})]);h.tick();
    assert.equal(h.reads,2);assert.equal(h.symbols().length,1);assert.equal(h.analyses.at(-1).params.premium,199);
    assert.ok(h.analyses.at(-1).params.years<before);assert.match(h.node("riskMode").textContent,/实时/);
    assert.doesNotMatch(h.node("riskRows").innerHTML,/历史快照|data-risk-current="false"/);
  });
  await check("pause freezes prices and valuation time; resume immediately adopts latest cache",()=>{
    const h=harness();h.node("riskButton").click();const original=h.analyses[0].params;
    h.node("riskLive").click();assert.equal(h.node("riskLive").textContent,"恢复实时");assert.equal(h.node("riskLive").getAttribute("aria-pressed"),"true");
    h.advance(25000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:"555",ask_price:"556"})]);h.tick();assert.equal(h.reads,1);
    h.field("riskQuantity","0.02","input");assert.equal(h.analyses.at(-2).params.premium,original.premium);assert.equal(h.analyses.at(-2).params.years,original.years);
    h.node("riskLive").click();assert.equal(h.reads,2);assert.equal(h.node("riskLive").textContent,"暂停更新");assert.equal(h.node("riskLive").getAttribute("aria-pressed"),"false");
    const latest=h.analyses.filter(item=>item.params.strike===64000).at(-1).params;
    assert.equal(latest.premium,555);assert.equal(latest.quantity,.02);assert.ok(latest.years<original.years);
  });
  await check("a disconnected live feed holds last valid values and recovers automatically without false expiry",()=>{
    const h=harness();h.node("riskButton").click();const first=h.analyses[0].result.model.expectedPnl;
    h.advance(21000);h.tick();assert.deepEqual(h.validity(),["true","true"]);assert.equal(h.node("riskFreshness").hidden,false);
    assert.match(h.node("riskFreshness").textContent,/保留上次/);assert.match(h.node("riskRows").innerHTML,/历史快照/);
    assert.doesNotMatch(h.node("riskRows").innerHTML,/已到期|已成交/);assert.match(h.node("riskRows").innerHTML,/data-risk-current="false"/);
    assert.equal(h.analyses[0].result.model.expectedPnl,first);
    h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:"222",ask_price:"223"}),h.row(70000,"PUT",h.expiryA,{bid_price:"300",ask_price:"320"})]);h.tick();
    assert.equal(h.node("riskFreshness").hidden,true);assert.equal(h.analyses.filter(item=>item.params.strike===64000).at(-1).params.premium,222);assert.doesNotMatch(h.node("riskRows").innerHTML,/历史快照|data-risk-current="false"/);
  });
  await check("manual refresh preserves pause and retains historical results during transient data loss",()=>{
    const h=harness();h.node("riskButton").click();h.node("riskLive").click();h.advance(21000);h.tick();
    assert.deepEqual(h.validity(),["true","true"]);h.node("riskRefresh").click();assert.equal(h.reads,2);
    assert.equal(h.node("riskLive").textContent,"恢复实时");assert.deepEqual(h.validity(),["true","true"]);assert.equal(h.node("riskEmpty").hidden,true);
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");assert.deepEqual(h.validity(),["true","true"]);
    assert.match(h.node("riskRows").innerHTML,/data-risk-current="false"/);assert.doesNotMatch(h.node("riskRows").innerHTML,/已到期/);
  });
  await check("all-unavailable rows are hidden by default and can be inspected without fabricated values",()=>{
    const h=harness();h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:"0"}),h.row(70000,"PUT",h.expiryA,{bid_quantity:"0"})]);h.node("riskButton").click();
    assert.equal(h.symbols().length,0);assert.equal(h.node("riskEmpty").hidden,false);assert.equal(h.node("riskExport").disabled,true);assert.equal(h.analyses.length,0);
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");assert.equal(h.symbols().length,2);assert.deepEqual(h.validity(),["false","false"]);
    assert.match(h.node("riskRows").innerHTML,/暂无买盘/);assert.match(h.node("riskRows").innerHTML,/深度不足/);assert.equal(h.node("riskEmpty").hidden,true);assert.equal(h.analyses.length,0);
  });
  await check("buying uses available sellers while missing asks remain hidden and explainable",()=>{
    const h=harness();h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:"0",ask_price:"444"}),h.row(70000,"PUT",h.expiryA,{ask_price:"0"})]);h.node("riskButton").click();
    h.field("riskDirection","BUY");assert.deepEqual(h.validity(),["true"]);assert.equal(h.analyses.at(-1).params.premium,444);
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");assert.match(h.node("riskRows").innerHTML,/暂无卖盘/);
    assert.equal(h.validity().filter(value=>value==="false").length,1);
  });
  await check("live ticks preserve chosen filters, assumptions, sort and unavailable visibility",()=>{
    const h=harness();h.node("riskButton").click();
    for(const [id,value]of [["riskExpiry","ALL"],["riskType","ALL"],["riskDirection","BUY"],["riskSort","tail"]])h.field(id,value);
    for(const [id,value]of [["riskQuantity","0.02"],["riskVol","80"],["riskDrift","10"],["riskBudget","123"]])h.field(id,value,"input");
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");h.advance(2000);h.latest=h.snapshot();h.tick();
    for(const [id,value]of Object.entries({riskExpiry:"ALL",riskType:"ALL",riskDirection:"BUY",riskSort:"tail",riskQuantity:"0.02",riskVol:"80",riskDrift:"10",riskBudget:"123"}))assert.equal(h.node(id).value,value,id);
    assert.equal(h.node("riskHideUnavailable").checked,false);assert.equal(h.symbols().length,4);
  });
  await check("live expiry rollover skips expired dates and selects the next available expiry",()=>{
    const h=harness();h.node("riskButton").click();h.advance(9*86400000+8*3600000);h.latest=h.snapshot();h.tick();
    assert.equal(h.node("riskExpiry").value,"2030-01-17");assert.ok(!h.node("riskExpiry").options.includes("2030-01-10"));assert.equal(h.symbols().length,1);assert.match(h.symbols()[0],/300117/);
    assert.ok(h.analyses.at(-1).params.years>0);assert.doesNotMatch(h.node("riskRows").innerHTML,/已到期/);
  });
  await check("ALL expiry scope discovers newly listed dates without resetting the scope or mode",()=>{
    const h=harness();h.node("riskButton").click();h.field("riskExpiry","ALL");h.field("riskType","ALL");
    const expiryC=Date.parse("2030-01-24T08:00:00Z");h.advance(2000);
    h.latest=h.snapshot([...h.snapshot().options,h.row(85000,"CALL",expiryC,{symbol:"BTC-300124-85000-C"})]);h.tick();
    assert.equal(h.node("riskExpiry").value,"ALL");assert.ok(h.node("riskExpiry").options.includes("2030-01-24"));assert.equal(h.symbols().length,5);
    assert.ok(h.symbols().includes("BTC-300124-85000-C"));assert.equal(h.node("riskLive").textContent,"暂停更新");
    h.field("riskExpiry","2030-01-24");assert.deepEqual(h.symbols(),["BTC-300124-85000-C"]);assert.equal(h.analyses.at(-1).params.type,"CALL");
  });
  await check("pausing and resuming a held historical snapshot preserves honest status until data returns",()=>{
    const h=harness();h.node("riskButton").click();h.advance(21000);h.tick();assert.match(h.node("riskMode").textContent,/等待更新/);
    const reads=h.reads;h.node("riskLive").click();assert.equal(h.node("riskLive").textContent,"恢复实时");assert.equal(h.node("riskMode").textContent,"已暂停");assert.doesNotMatch(h.node("riskFreshness").textContent,/已到期/);
    h.advance(2000);h.tick();assert.equal(h.reads,reads);assert.deepEqual(h.validity(),["true","true"]);assert.match(h.node("riskRows").innerHTML,/data-risk-current="false"/);
    h.node("riskLive").click();assert.equal(h.reads,reads+1);assert.equal(h.node("riskMode").textContent,"等待更新");assert.match(h.node("riskRows").innerHTML,/历史快照/);
    h.latest=h.snapshot();h.tick();assert.equal(h.node("riskMode").textContent,"实时");assert.equal(h.node("riskFreshness").hidden,true);assert.doesNotMatch(h.node("riskRows").innerHTML,/历史快照/);
  });
  for(const [name,overrides,reason]of [
    ["zero bids",{bid_price:"0"},/暂无买盘/],
    ["a halted contract",{status:"HALT"},/暂停交易|非可交易状态/],
    ["insufficient displayed depth",{bid_quantity:"0.009"},/深度不足/]
  ])await check(`fresh ${name} replaces old results instead of being disguised as a disconnected feed`,()=>{
    const h=harness();h.latest=h.snapshot([h.row()]);h.node("riskButton").click();assert.deepEqual(h.validity(),["true"]);
    h.advance(2000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,overrides)]);h.tick();
    assert.deepEqual(h.validity(),[]);assert.equal(h.node("riskEmpty").hidden,false);assert.equal(h.node("riskExport").disabled,true);
    assert.doesNotMatch(h.node("riskFreshness").textContent??"",/保留上次/);assert.doesNotMatch(h.node("riskMode").textContent??"",/^实时$/);
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");
    assert.deepEqual(h.validity(),["false"]);assert.match(h.node("riskRows").innerHTML,reason);assert.doesNotMatch(h.node("riskRows").innerHTML,/历史快照/);
  });
  await check("mixed fresh unavailable and transient quotes reject the former while retaining only the latter",()=>{
    const h=harness();h.node("riskButton").click();h.advance(21000);
    h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:"0"}),h.row(70000,"PUT",h.expiryA,{quote_updated_at:new Date(Date.parse("2030-01-01T00:00:00Z")).toISOString()})]);h.tick();
    assert.deepEqual(h.symbols(),["BTC-300110-70000-P"]);assert.deepEqual(h.validity(),["true"]);assert.match(h.node("riskFreshness").textContent??"",/保留上次/);
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");assert.deepEqual(h.validity(),["false","true"]);
    assert.match(h.renderedRow("BTC-300110-64000-P"),/暂无买盘/);assert.doesNotMatch(h.renderedRow("BTC-300110-64000-P"),/历史快照/);
    assert.match(h.renderedRow("BTC-300110-70000-P"),/历史快照/);assert.match(h.renderedRow("BTC-300110-70000-P"),/data-risk-current="false"/);
  });
  await check("a permanently empty sibling bid cannot erase another contract's last valid calculation",()=>{
    const h=harness();h.latest=h.snapshot([h.row(),h.row(48000,"PUT",h.expiryA,{bid_price:"0"})]);h.node("riskButton").click();
    const original=JSON.stringify(h.analyses[0].result),years=h.analyses[0].params.years;
    assert.deepEqual(h.symbols(),["BTC-300110-64000-P"]);h.advance(21000);h.tick();
    assert.deepEqual(h.symbols(),["BTC-300110-64000-P"]);assert.deepEqual(h.validity(),["true"]);assert.equal(JSON.stringify(h.analyses.at(-1).result),original);
    assert.equal(h.analyses.at(-1).params.years,years);assert.match(h.renderedRow("BTC-300110-64000-P"),/历史快照/);assert.match(h.renderedRow("BTC-300110-64000-P"),/data-risk-current="false"/);
    assert.match(h.node("riskFreshness").textContent,/保留上次/);assert.equal(h.node("riskMode").textContent,"等待更新");
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");assert.match(h.renderedRow("BTC-300110-48000-P"),/暂无买盘/);assert.match(h.renderedRow("BTC-300110-48000-P"),/data-risk-valid="false"/);
  });
  await check("fresh and historical contracts coexist without losing their own valuation time or BTC reference",()=>{
    const h=harness();h.node("riskButton").click();const first=h.analyses.find(item=>item.params.strike===70000);
    h.advance(21000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:"333",ask_price:"334"}),h.row(70000,"PUT",h.expiryA,{bid_price:"300",ask_price:"320",quote_updated_at:"2030-01-01T00:00:00.000Z"})]);h.latest.btc_index_price="90000";h.tick();
    assert.deepEqual(h.symbols(),["BTC-300110-64000-P","BTC-300110-70000-P"]);assert.equal(h.node("riskMode").textContent,"部分待更新");
    assert.match(h.renderedRow("BTC-300110-64000-P"),/data-risk-current="true"/);assert.doesNotMatch(h.renderedRow("BTC-300110-64000-P"),/历史快照/);
    assert.match(h.renderedRow("BTC-300110-70000-P"),/data-risk-current="false"/);assert.match(h.renderedRow("BTC-300110-70000-P"),/历史快照/);assert.match(h.renderedRow("BTC-300110-70000-P"),/BTC.*80,000/);
    const fresh=h.analyses.filter(item=>item.params.strike===64000).at(-1),old=h.analyses.filter(item=>item.params.strike===70000).at(-1);
    assert.equal(fresh.params.spot,90000);assert.equal(fresh.params.premium,333);assert.ok(fresh.params.years<first.params.years);
    assert.equal(old.params.spot,80000);assert.equal(old.params.premium,300);assert.equal(old.params.years,first.params.years);assert.deepEqual(old.result,first.result);
  });
  for(const [name,hard]of [["zero bid",{bid_price:"0"}],["halt",{status:"HALT"}],["depth",{bid_quantity:"0"}]])await check(`a fresh ${name} purges cached results so later missing fields cannot resurrect them`,()=>{
    const h=harness();h.latest=h.snapshot([h.row()]);h.node("riskButton").click();assert.equal(h.symbols().length,1);
    h.advance(2000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,hard)]);h.tick();assert.equal(h.symbols().length,0);
    h.advance(21000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:null,bid_quantity:null,quote_updated_at:null})]);h.tick();
    assert.equal(h.symbols().length,0);assert.equal(h.node("riskExport").disabled,true);
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");assert.deepEqual(h.validity(),["false"]);assert.doesNotMatch(h.node("riskRows").innerHTML,/历史快照/);
  });
  for(const [affected,opposite,price,size]of [["SELL","BUY","bid_price","bid_quantity"],["BUY","SELL","ask_price","ask_quantity"]])await check(`a fresh zero ${price} invalidates an unselected ${affected} bundle while preserving the opposite side`,()=>{
    const h=harness();h.latest=h.snapshot([h.row()]);h.node("riskButton").click();h.field("riskDirection",affected);h.field("riskDirection",opposite);
    h.advance(2000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{[price]:"0"})]);h.tick();assert.equal(h.symbols().length,1);
    h.advance(21000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:null,ask_price:null,bid_quantity:null,ask_quantity:null,quote_updated_at:null})]);h.tick();
    assert.equal(h.symbols().length,1,"the opposite-side quote had a valid independent bundle");assert.match(h.node("riskRows").innerHTML,/历史快照/);
    h.field("riskDirection",affected);assert.equal(h.symbols().length,0,"observed zero must tombstone the hidden direction too");assert.equal(h.node("riskExport").disabled,true);
    h.field("riskDirection",opposite);assert.equal(h.symbols().length,1);assert.match(h.node("riskRows").innerHTML,/历史快照/);
  });
  for(const [affected,opposite,size]of [["SELL","BUY","bid_quantity"],["BUY","SELL","ask_quantity"]])await check(`a fresh ${size} reduction invalidates an unselected oversized historical bundle`,()=>{
    const h=harness();h.latest=h.snapshot([h.row()]);h.node("riskButton").click();h.field("riskDirection",affected);h.field("riskDirection",opposite);
    h.advance(2000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{[size]:"0.005"})]);h.tick();assert.equal(h.symbols().length,1);
    h.advance(21000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:null,ask_price:null,bid_quantity:null,ask_quantity:null,quote_updated_at:null})]);h.tick();
    assert.equal(h.symbols().length,1);h.field("riskDirection",affected);assert.equal(h.symbols().length,0,"later unknown depth cannot revive the older larger displayed depth");
  });
  await check("a fresh HALT observed under another option type clears both cached trade directions",()=>{
    const h=harness();h.latest=h.snapshot([h.row(),h.row(90000,"CALL")]);h.node("riskButton").click();h.field("riskDirection","BUY");h.field("riskType","CALL");
    h.advance(2000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{status:"HALT"}),h.row(90000,"CALL")]);h.tick();assert.deepEqual(h.symbols(),["BTC-300110-90000-C"]);
    h.advance(21000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{status:"TRADING",bid_price:null,ask_price:null,bid_quantity:null,ask_quantity:null,quote_updated_at:null}),h.row(90000,"CALL")]);h.tick();
    h.field("riskType","PUT");assert.equal(h.symbols().length,0);h.field("riskDirection","SELL");assert.equal(h.symbols().length,0);assert.equal(h.node("riskExport").disabled,true);
  });
  await check("a fresh HALT observed under another expiry cannot resurrect when its original expiry is revisited",()=>{
    const h=harness();h.node("riskButton").click();h.field("riskExpiry","2030-01-17");
    h.advance(2000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{status:"HALT"}),h.row(70000,"PUT",h.expiryA,{status:"HALT"}),h.row(60000,"PUT",h.expiryB)]);h.tick();assert.equal(h.symbols().length,1);
    h.advance(21000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:null,bid_quantity:null,quote_updated_at:null}),h.row(70000,"PUT",h.expiryA,{bid_price:null,bid_quantity:null,quote_updated_at:null}),h.row(60000,"PUT",h.expiryB)]);h.tick();
    h.field("riskExpiry","2030-01-10");assert.equal(h.symbols().length,0);assert.equal(h.node("riskExport").disabled,true);
  });
  await check("temporary missing quote fields retain the prior bundle but never invent a first quote",()=>{
    const h=harness();h.latest=h.snapshot([h.row()]);h.node("riskButton").click();const original=h.analyses[0].params;
    h.advance(2000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:null,bid_quantity:null,quote_updated_at:null}),h.row(70000,"PUT",h.expiryA,{bid_price:null,bid_quantity:null,quote_updated_at:null})]);h.tick();
    assert.deepEqual(h.symbols(),["BTC-300110-64000-P"]);assert.match(h.node("riskRows").innerHTML,/历史快照/);assert.equal(h.analyses.at(-1).params.premium,original.premium);assert.equal(h.analyses.at(-1).params.years,original.years);
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");assert.match(h.renderedRow("BTC-300110-70000-P"),/data-risk-valid="false"/);assert.doesNotMatch(h.renderedRow("BTC-300110-70000-P"),/历史快照/);
  });
  await check("a missing latest index retains the whole earlier analysis point without mixing a new quote with the old BTC price",()=>{
    const h=harness();h.latest=h.snapshot([h.row()]);h.node("riskButton").click();const first=h.analyses[0];h.advance(2000);
    h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:"333",ask_price:"334"})]);h.latest.btc_index_price=null;h.tick();
    assert.deepEqual(h.validity(),["true"]);const held=h.analyses.at(-1);assert.equal(held.params.premium,100);assert.equal(held.params.spot,80000);assert.equal(held.params.years,first.params.years);
    assert.deepEqual(held.result,first.result);assert.match(h.node("riskRows").innerHTML,/历史快照/);
    h.latest.btc_index_price="90000";h.tick();const fresh=h.analyses.at(-1);assert.equal(fresh.params.premium,333);assert.equal(fresh.params.spot,90000);assert.ok(fresh.params.years<first.params.years);assert.doesNotMatch(h.node("riskRows").innerHTML,/历史快照/);
  });
  for(const [field,missing]of [["status",{status:null}],["unit",{unit:null}],["expiry",{expiry_ms:null}]])await check(`temporarily unknown ${field} preserves a verified earlier analysis instead of asserting a market change`,()=>{
    const h=harness();h.latest=h.snapshot([h.row()]);h.node("riskButton").click();const first=h.analyses[0];
    h.advance(2000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,missing)]);h.tick();
    assert.deepEqual(h.symbols(),["BTC-300110-64000-P"]);assert.deepEqual(h.validity(),["true"]);assert.match(h.node("riskRows").innerHTML,/历史快照/);assert.match(h.node("riskRows").innerHTML,/data-risk-current="false"/);
    const held=h.analyses.at(-1);assert.equal(held.params.spot,first.params.spot);assert.equal(held.params.premium,first.params.premium);assert.equal(held.params.years,first.params.years);assert.deepEqual(held.result,first.result);
    assert.doesNotMatch(h.node("riskRows").innerHTML,/暂停交易|已到期/);
  });
  await check("an explicitly unsupported contract unit removes its bundle and later unknown units do not revive it",()=>{
    const h=harness();h.latest=h.snapshot([h.row()]);h.node("riskButton").click();h.advance(2000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{unit:"2"})]);h.tick();assert.equal(h.symbols().length,0);
    h.advance(2000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{unit:null,bid_price:null,bid_quantity:null,quote_updated_at:null})]);h.tick();
    assert.equal(h.symbols().length,0);h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");assert.deepEqual(h.validity(),["false"]);assert.doesNotMatch(h.node("riskRows").innerHTML,/历史快照/);
  });
  await check("a genuinely expired live contract loses its bundle before a later missing expiry can obscure the boundary",()=>{
    const h=harness();h.latest=h.snapshot([h.row()]);h.node("riskButton").click();h.advance(9*86400000+8*3600000);h.latest=h.snapshot([h.row()]);h.tick();assert.equal(h.symbols().length,0);
    h.advance(2000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{expiry_ms:null,bid_price:null,bid_quantity:null,quote_updated_at:null})]);h.tick();assert.equal(h.symbols().length,0);
    assert.equal(h.node("riskExport").disabled,true);h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");assert.ok(h.validity().every(value=>value==="false"));assert.doesNotMatch(h.node("riskRows").innerHTML,/历史快照/);
  });
  await check("a still-sufficient fresh depth reduction preserves history and limits later quantity changes",()=>{
    const h=harness();h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_quantity:"2"})]);h.node("riskButton").click();const first=h.analyses[0];
    h.advance(2000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_quantity:"1",bid_price:"333",ask_price:"334"})]);h.latest.btc_index_price=null;h.tick();
    assert.deepEqual(h.validity(),["true"]);assert.match(h.node("riskRows").innerHTML,/历史快照/);assert.equal(h.analyses.at(-1).params.premium,100);assert.equal(h.analyses.at(-1).params.spot,80000);
    h.advance(21000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:null,bid_quantity:null,quote_updated_at:null})]);h.latest.btc_index_price=null;h.tick();assert.equal(h.symbols().length,1);
    h.field("riskQuantity","1.5","input");assert.equal(h.symbols().length,0,"the old depth of 2 cannot override the later observed limit of 1");
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");assert.match(h.node("riskRows").innerHTML,/深度不足/);assert.deepEqual(h.validity(),["false"]);
    h.node("riskHideUnavailable").checked=true;h.node("riskHideUnavailable").fire("change");h.field("riskQuantity","0.5","input");assert.deepEqual(h.validity(),["true"]);
    const small=h.analyses.at(-1);assert.equal(small.params.quantity,.5);assert.equal(small.params.premium,100);assert.equal(small.params.spot,80000);assert.equal(small.params.years,first.params.years);assert.ok(Math.abs(small.result.maxLoss-first.result.maxLoss*50)<1e-8);
    assert.match(h.node("riskRows").innerHTML,/历史快照/);assert.match(h.node("riskRows").innerHTML,/data-risk-current="false"/);
  });
  await check("historical bundles are separated by trade direction and assumptions are recomputed",()=>{
    const h=harness();h.latest=h.snapshot([h.row()]);h.node("riskButton").click();const original=h.analyses[0];h.advance(21000);h.tick();
    h.field("riskDirection","BUY");assert.equal(h.symbols().length,0,"a SELL bundle cannot manufacture a BUY analysis");
    h.field("riskDirection","SELL");assert.equal(h.symbols().length,1);assert.match(h.node("riskRows").innerHTML,/历史快照/);
    h.field("riskVol","80","input");h.field("riskDrift","10","input");const changed=h.analyses.at(-1);
    assert.equal(changed.params.direction,"SELL");assert.equal(changed.params.annualVol,.8);assert.equal(changed.params.annualDrift,.1);
    assert.equal(changed.params.years,original.params.years);assert.equal(changed.params.premium,original.params.premium);assert.notEqual(changed.result.model.expectedPnl,original.result.model.expectedPnl);
  });
  await check("historical bundle quantity is revalidated rather than reusing previously computed returns",()=>{
    const h=harness();h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_quantity:"0.02"})]);h.node("riskButton").click();const original=h.analyses[0];
    h.advance(21000);h.tick();h.field("riskQuantity","0.02","input");assert.equal(h.symbols().length,1);assert.equal(h.analyses.at(-1).params.quantity,.02);assert.equal(h.analyses.at(-1).result.maxLoss,original.result.maxLoss*2);
    h.field("riskQuantity","0.03","input");assert.equal(h.symbols().length,0);assert.equal(h.node("riskExport").disabled,true);
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");assert.match(h.node("riskRows").innerHTML,/深度不足/);assert.match(h.node("riskRows").innerHTML,/data-risk-valid="false"/);
  });
  await check("an uncached expiry cannot borrow historical results from another expiry",()=>{
    const h=harness();h.latest=h.snapshot([h.row()]);h.node("riskButton").click();h.advance(21000);
    h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{quote_updated_at:"2030-01-01T00:00:00Z"}),h.row(60000,"PUT",h.expiryB,{bid_price:null,bid_quantity:null,quote_updated_at:null})]);h.tick();assert.equal(h.symbols().length,1);
    h.field("riskExpiry","2030-01-17");assert.equal(h.symbols().length,0);assert.equal(h.node("riskExport").disabled,true);
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");assert.match(h.renderedRow("BTC-300117-60000-P"),/data-risk-valid="false"/);assert.doesNotMatch(h.node("riskRows").innerHTML,/历史快照/);
  });
  await check("pausing a mixed snapshot preserves every leg's own price index and valuation horizon",()=>{
    const h=harness();h.node("riskButton").click();h.advance(21000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:"333",ask_price:"334"}),h.row(70000,"PUT",h.expiryA,{bid_price:"300",ask_price:"320",quote_updated_at:"2030-01-01T00:00:00Z"})]);h.latest.btc_index_price="90000";h.tick();
    const before=h.analyses.slice(-2).map(item=>item.params);h.node("riskLive").click();const reads=h.reads;h.advance(10000);h.latest=h.snapshot();h.tick();h.field("riskQuantity","0.02","input");assert.equal(h.reads,reads);
    for(const original of before){const actual=h.analyses.filter(item=>item.params.strike===original.strike).at(-1).params;assert.equal(actual.spot,original.spot);assert.equal(actual.premium,original.premium);assert.equal(actual.years,original.years);assert.equal(actual.quantity,.02);}
  });
  await check("manual refresh keeps transient historical results beside a genuinely empty bid",()=>{
    const h=harness();h.latest=h.snapshot([h.row(),h.row(48000,"PUT",h.expiryA,{bid_price:"0"})]);h.node("riskButton").click();h.advance(21000);h.node("riskRefresh").click();
    assert.deepEqual(h.symbols(),["BTC-300110-64000-P"]);assert.match(h.node("riskRows").innerHTML,/历史快照/);assert.match(h.node("riskFreshness").textContent,/保留上次/);assert.equal(h.node("riskLive").textContent,"暂停更新");
  });
  await check("mixed CSV exports the source index and model time for each historical and live contract",async()=>{
    const h=harness();h.node("riskButton").click();h.advance(21000);h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:"333",ask_price:"334"}),h.row(70000,"PUT",h.expiryA,{bid_price:"300",ask_price:"320",quote_updated_at:"2030-01-01T00:00:00Z"})]);h.latest.btc_index_price="90000";h.tick();h.node("riskExport").click();
    const csv=await h.blobs.get(h.downloads[0].url).text(),records=csv.replace(/^\uFEFF/,"").split("\r\n").map(line=>[...line.matchAll(/"((?:[^"]|"")*)"/g)].map(match=>match[1].replace(/""/g,'"'))),header=records.shift();
    const column=name=>{const index=header.indexOf(name);assert.ok(index>=0,name);return index;},fresh=records.find(record=>record[0]==="BTC-300110-64000-P"),old=records.find(record=>record[0]==="BTC-300110-70000-P");
    assert.equal(Number(fresh[column("指数参考_USDT")]),90000);assert.equal(Number(old[column("指数参考_USDT")]),80000);
    assert.equal(fresh[column("模型估值时间_UTC")],"2030-01-01T00:00:21.000Z");assert.equal(old[column("模型估值时间_UTC")],"2030-01-01T00:00:00.000Z");
    assert.equal(fresh[column("快照参考时间")],"2030-01-01T00:00:21.000Z");assert.equal(old[column("快照参考时间")],"2030-01-01T00:00:00.000Z");assert.match(old[column("状态")],/历史快照/);
    assert.doesNotMatch(csv,/NaN|Infinity|undefined/);
  });
  await check("first opening without any snapshot is waiting rather than falsely live",()=>{
    const h=harness();h.latest=null;h.node("riskButton").click();assert.doesNotMatch(h.node("riskMode").textContent??"",/^实时$/);
    assert.equal(h.node("riskExport").disabled,true);assert.equal(h.analyses.length,0);assert.doesNotMatch(h.node("riskFreshness").textContent??"",/上次快照|已到期/);
  });
  await check("first opening with an aged future-expiry snapshot is waiting rather than falsely live or expired",()=>{
    const h=harness();h.advance(21000);h.node("riskButton").click();assert.doesNotMatch(h.node("riskMode").textContent??"",/^实时$/);
    assert.equal(h.analyses.length,0);assert.deepEqual(h.validity(),[]);assert.doesNotMatch(h.node("riskEmpty").textContent??"",/已到期/);
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");assert.match(h.node("riskRows").innerHTML,/报价待更新/);assert.doesNotMatch(h.node("riskRows").innerHTML,/已到期|已成交/);
  });
  await check("first opening with only actually expired contracts never labels them live or simulates them",()=>{
    const h=harness();h.advance(18*86400000);h.node("riskButton").click();assert.doesNotMatch(h.node("riskMode").textContent??"",/^实时$/);
    assert.equal(h.analyses.length,0);assert.deepEqual(h.validity(),[]);assert.deepEqual(h.node("riskExpiry").options,["ALL"]);
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");assert.match(h.node("riskRows").innerHTML,/已到期/);assert.doesNotMatch(h.node("riskRows").innerHTML,/历史快照/);
  });
  await check("CSV exports the currently visible live snapshot without a surprise refresh",async()=>{
    const h=harness();h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:"101"}),h.row(70000,"PUT",h.expiryA,{bid_price:"0"})]);h.node("riskButton").click();
    const reads=h.reads;h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:"999",ask_price:"1000"})]);h.node("riskExport").click();
    assert.equal(h.reads,reads);let csv=await h.blobs.get(h.downloads[0].url).text();assert.match(csv,/BTC-300110-64000-P/);assert.doesNotMatch(csv,/BTC-300110-70000-P/);assert.match(csv,/"101"/);assert.doesNotMatch(csv,/"999"/);
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");h.node("riskExport").click();csv=await h.blobs.get(h.downloads[1].url).text();
    assert.match(csv,/BTC-300110-70000-P/);assert.doesNotMatch(csv,/NaN|undefined|Infinity/);
  });
  await check("closing the dialog stops all cache reads and reopening returns to live mode",()=>{
    const h=harness();h.node("riskButton").click();h.node("riskLive").click();h.node("riskClose").click();const reads=h.reads;
    h.advance(21000);h.latest=h.snapshot();h.tick();assert.equal(h.reads,reads);assert.equal(h.intervals.size,0);
    h.node("riskButton").click();assert.equal(h.node("riskLive").textContent,"暂停更新");assert.equal(h.reads,reads+1);assert.equal(h.intervals.size,1);assert.deepEqual([...h.intervalPeriods.values()],[2000]);
  });
  await check("an accepted snapshot recomputes live prices within the 250ms window without waiting for the interval",()=>{
    const h=harness();h.latest=versioned(h,1);h.node("riskButton").click();const calls=h.analyses.length;h.advance(100);h.latest=versioned(h,2,222);h.latest.btc_index_price="90000";
    h.window.OptionRiskUI.onSnapshot(h.latest);assert.equal(h.analyses.length,calls);assert.equal(h.reads,1);assert.deepEqual([...h.timeoutPeriods.values()],[250]);
    h.advance(250);h.runTimeouts(250);assert.equal(h.reads,2);assert.equal(h.analyses.length,calls+1);assert.equal(h.analyses.at(-1).params.premium,222);assert.equal(h.analyses.at(-1).params.spot,90000);assert.match(h.node("riskRows").innerHTML,/data-risk-current="true"/);
  });
  await check("snapshot bursts coalesce into one calculation of the latest accepted data without starving updates",()=>{
    const h=harness();h.latest=versioned(h,1);h.node("riskButton").click();const calls=h.analyses.length;
    for(let revision=2;revision<=4;revision++){h.latest=versioned(h,revision,revision*100);h.window.OptionRiskUI.onSnapshot(h.latest);}
    assert.equal(h.timeouts.size,1);h.tick();assert.equal(h.analyses.length,calls,"the fallback must not race the scheduled snapshot");
    h.advance(250);h.runTimeouts(250);assert.equal(h.reads,2);assert.equal(h.analyses.length,calls+1);assert.equal(h.analyses.at(-1).params.premium,400);
    h.latest=versioned(h,5,500);h.window.OptionRiskUI.onSnapshot(h.latest);assert.equal(h.timeouts.size,1);h.advance(250);h.runTimeouts(250);assert.equal(h.analyses.at(-1).params.premium,500);assert.equal(h.reads,3);
  });
  await check("duplicate instance revisions do not rerun the pricing engine but a server restart can reset revisions",()=>{
    const h=harness();h.latest=versioned(h,10);h.node("riskButton").click();const calls=h.analyses.length;
    h.latest=JSON.parse(JSON.stringify(h.latest));h.window.OptionRiskUI.onSnapshot(h.latest);assert.equal(h.timeouts.size,0);assert.equal(h.reads,1);assert.equal(h.analyses.length,calls);
    h.latest=versioned(h,1,333,"risk-restarted");h.window.OptionRiskUI.onSnapshot(h.latest);assert.equal(h.timeouts.size,1);h.advance(250);h.runTimeouts(250);assert.equal(h.analyses.at(-1).params.premium,333);
  });
  await check("pausing cancels an incoming recalculation and ignores further events until resume",()=>{
    const h=harness();h.latest=versioned(h,1);h.node("riskButton").click();const calls=h.analyses.length;h.latest=versioned(h,2,222);h.window.OptionRiskUI.onSnapshot(h.latest);assert.equal(h.timeouts.size,1);
    h.node("riskLive").click();assert.equal(h.timeouts.size,0);h.latest=versioned(h,3,333);h.window.OptionRiskUI.onSnapshot(h.latest);h.runTimeouts(250);h.tick();assert.equal(h.analyses.length,calls);assert.equal(h.reads,1);
    h.node("riskLive").click();assert.equal(h.reads,2);assert.equal(h.analyses.at(-1).params.premium,333);assert.equal(h.node("riskLive").textContent,"暂停更新");
  });
  await check("hidden pages defer snapshot and interval work then immediately compute the latest data when visible",()=>{
    const h=harness();h.latest=versioned(h,1);h.node("riskButton").click();const calls=h.analyses.length,before=h.node("riskRows").innerHTML;
    h.document.hidden=true;h.document.fire("visibilitychange");h.advance(1000);h.latest=versioned(h,2,222);h.window.OptionRiskUI.onSnapshot(h.latest);h.latest=versioned(h,3,333);h.window.OptionRiskUI.onSnapshot(h.latest);h.tick();h.runTimeouts(250);
    assert.equal(h.timeouts.size,0);assert.equal(h.reads,1);assert.equal(h.analyses.length,calls);assert.equal(h.node("riskRows").innerHTML,before);
    h.document.hidden=false;h.document.fire("visibilitychange");assert.equal(h.reads,2);assert.equal(h.analyses.at(-1).params.premium,333);assert.equal(h.timeouts.size,0);
  });
  await check("becoming hidden cancels scheduled work and visibility restores clock-sensitive state even without a new event",()=>{
    const h=harness();h.latest=versioned(h,1);h.node("riskButton").click();h.latest=versioned(h,2,222);h.window.OptionRiskUI.onSnapshot(h.latest);assert.equal(h.timeouts.size,1);
    h.document.hidden=true;h.document.fire("visibilitychange");assert.equal(h.timeouts.size,0);h.advance(21000);h.tick();assert.equal(h.reads,1);
    h.document.hidden=false;h.document.fire("visibilitychange");assert.equal(h.reads,2);assert.match(h.node("riskRows").innerHTML,/历史快照/);assert.equal(h.analyses.at(-1).params.premium,100,"unseen stale data cannot pretend to have been analyzed fresh");
  });
  await check("closing cancels queued snapshot work and closed or paused visibility changes cannot trigger computation",()=>{
    const h=harness();h.latest=versioned(h,1);h.node("riskButton").click();h.latest=versioned(h,2,222);h.window.OptionRiskUI.onSnapshot(h.latest);h.node("riskClose").click();const calls=h.analyses.length;
    assert.equal(h.timeouts.size,0);h.runTimeouts(250);h.window.OptionRiskUI.onSnapshot(h.latest);h.document.fire("visibilitychange");assert.equal(h.reads,1);assert.equal(h.analyses.length,calls);
    h.node("riskButton").click();h.node("riskLive").click();const pausedReads=h.reads;h.document.hidden=true;h.document.fire("visibilitychange");h.latest=versioned(h,3,333);h.window.OptionRiskUI.onSnapshot(h.latest);h.document.hidden=false;h.document.fire("visibilitychange");assert.equal(h.reads,pausedReads);
  });
  await check("CSV matches the displayed values before and after a coalesced update",async()=>{
    const h=harness();h.latest=versioned(h,1,101);h.node("riskButton").click();h.latest=versioned(h,2,222);h.window.OptionRiskUI.onSnapshot(h.latest);h.node("riskExport").click();
    let csv=await h.blobs.get(h.downloads[0].url).text();assert.match(csv,/"101"/);assert.doesNotMatch(csv,/"222"/);assert.equal(h.reads,1);
    h.advance(250);h.runTimeouts(250);h.node("riskExport").click();csv=await h.blobs.get(h.downloads[1].url).text();assert.match(csv,/"222"/);assert.equal(h.reads,2);assert.equal(h.analyses.at(-1).params.premium,222);
  });
  await check("manual and settings refreshes consume the newest cache and cancel redundant pending event work",()=>{
    const h=harness();h.latest=versioned(h,1);h.node("riskButton").click();h.latest=versioned(h,2,222);h.window.OptionRiskUI.onSnapshot(h.latest);h.field("riskQuantity","0.02","input");
    assert.equal(h.timeouts.size,0);assert.equal(h.analyses.at(-1).params.quantity,.02);assert.equal(h.analyses.at(-1).params.premium,222);const calls=h.analyses.length;h.runTimeouts(250);assert.equal(h.analyses.length,calls);
    h.latest=versioned(h,3,333);h.window.OptionRiskUI.onSnapshot(h.latest);h.node("riskRefresh").click();assert.equal(h.timeouts.size,0);assert.equal(h.analyses.at(-1).params.premium,333);
  });
  await check("certified quiet books keep updating their model horizon and revoked certification returns to history",()=>{
    const h=harness();h.latest=certifiedSnapshot(h,1);h.node("riskButton").click();const first=h.analyses[0];assert.equal(h.node("riskMode").textContent,"实时");
    h.advance(21000);h.latest=certifiedSnapshot(h,2);h.window.OptionRiskUI.onSnapshot(h.latest);h.advance(250);h.runTimeouts(250);
    const current=h.analyses.at(-1);assert.ok(current.params.years<first.params.years);assert.equal(current.params.premium,100);assert.match(h.node("riskRows").innerHTML,/data-risk-current="true"/);assert.doesNotMatch(h.node("riskRows").innerHTML,/历史快照/);
    h.latest=certifiedSnapshot(h,3);h.latest.options[0].quote_verified_at=null;h.latest.options[0].quote_verification=null;h.latest.realtime={connected:true};h.window.OptionRiskUI.onSnapshot(h.latest);h.advance(250);h.runTimeouts(250);
    assert.match(h.node("riskRows").innerHTML,/历史快照/);assert.match(h.node("riskRows").innerHTML,/data-risk-current="false"/);assert.equal(h.analyses.at(-1).params.years,current.params.years);
    h.latest=certifiedSnapshot(h,4);h.window.OptionRiskUI.onSnapshot(h.latest);h.advance(250);h.runTimeouts(250);assert.equal(h.node("riskMode").textContent,"实时");assert.doesNotMatch(h.node("riskRows").innerHTML,/历史快照/);
  });
  for(const [name,overrides]of [["zero bid",{bid_price:"0"}],["insufficient depth",{bid_quantity:"0.005"}]])await check(`a certified ${name} with an old receipt still invalidates cached results`,()=>{
    const h=harness();h.latest=certifiedSnapshot(h,1);h.node("riskButton").click();assert.equal(h.symbols().length,1);h.advance(21000);h.latest=certifiedSnapshot(h,2,overrides);h.window.OptionRiskUI.onSnapshot(h.latest);h.advance(250);h.runTimeouts(250);assert.equal(h.symbols().length,0);
    h.latest=versioned(h,3);h.latest.options[0].bid_price=null;h.latest.options[0].bid_quantity=null;h.latest.options[0].quote_updated_at=null;h.window.OptionRiskUI.onSnapshot(h.latest);h.advance(250);h.runTimeouts(250);assert.equal(h.symbols().length,0,"later missing fields cannot resurrect the invalidated bundle");
  });
  await check("an expired certificate cannot turn stale zero prices into a new market observation",()=>{
    const h=harness();h.latest=certifiedSnapshot(h,1);h.node("riskButton").click();h.advance(21000);h.latest=certifiedSnapshot(h,2,{bid_price:"0"});h.latest.options[0].quote_verified_at-=21000;h.latest.options[0].quote_verification.verified_at-=21000;
    h.window.OptionRiskUI.onSnapshot(h.latest);h.advance(250);h.runTimeouts(250);assert.deepEqual(h.validity(),["true"]);assert.match(h.node("riskRows").innerHTML,/历史快照/);assert.equal(h.analyses.at(-1).params.premium,100);
  });
  await check("fresh inputs with a withdrawn certificate remain calculable and are clearly labeled as cache",async()=>{
    const h=harness();h.latest=versioned(h,1);h.latest.options[0].quote_verified_at=null;h.latest.options[0].quote_verification=null;h.node("riskButton").click();
    assert.deepEqual(h.validity(),["true"]);assert.match(h.node("riskRows").innerHTML,/data-risk-current="true"/);assert.equal(h.node("riskMode").textContent,"缓存计算");assert.match(h.node("riskRows").innerHTML,/缓存参考/);assert.doesNotMatch(h.node("riskRows").innerHTML,/历史快照/);
    h.node("riskExport").click();assert.match(await h.blobs.get(h.downloads[0].url).text(),/缓存参考/);
    h.latest=certifiedSnapshot(h,2);h.window.OptionRiskUI.onSnapshot(h.latest);h.advance(250);h.runTimeouts(250);assert.equal(h.node("riskMode").textContent,"实时");assert.doesNotMatch(h.node("riskRows").innerHTML,/缓存参考|历史快照/);
  });
  await check("one unverified fresh row makes a mixed certified table a cache calculation without hiding either row",()=>{
    const h=harness();h.latest=certifiedSnapshot(h,1);h.latest.options.push(h.row(70000,"PUT",h.expiryA,{quote_verified_at:null,quote_verification:null}));h.node("riskButton").click();
    assert.equal(h.node("riskMode").textContent,"缓存计算");assert.deepEqual(h.validity(),["true","true"]);assert.doesNotMatch(h.renderedRow("BTC-300110-64000-P"),/缓存参考/);assert.match(h.renderedRow("BTC-300110-70000-P"),/缓存参考/);
  });
  await check("unchanged 700-contract ALL snapshots retain every row and cell without DOM writes or scroll assignments",()=>{
    const h=harness();h.setExpiry("ALL");h.node("riskType").value="ALL";
    h.latest={...h.snapshot(Array.from({length:700},(_,index)=>h.row(30000+index*100,index%2?"CALL":"PUT",index%3?h.expiryA:h.expiryB))),instance_id:"large-catalog",revision:1};
    h.node("riskButton").click();const tbody=h.node("riskRows"),rows=[...tbody.children],cells=rows.map(row=>[...row.cells]);assert.equal(rows.length,700);assert.ok(rows.every(row=>row.cells.length===20));
    const scroller=h.node("riskTableScroll");scroller.scrollTop=1200;scroller.scrollLeft=650;
    const created=h.created.length,start=h.mutations.length,calls=h.analyses.length;
    h.latest={...JSON.parse(JSON.stringify(h.latest)),revision:2};h.window.OptionRiskUI.onSnapshot(h.latest);assert.deepEqual([...h.timeoutPeriods.values()],[250]);h.runTimeouts(250);
    assert.equal(h.analyses.length,calls+700,"render optimization must preserve the computation cadence");assert.equal(h.created.length,created);
    rows.forEach((row,index)=>{assert.equal(tbody.children[index],row);assert.deepEqual(row.cells,cells[index]);});
    assert.deepEqual(tableMutations(h,start),[]);assert.deepEqual(h.mutations.slice(start).filter(event=>event.kind==="scroll"),[]);
    assert.equal(scroller.scrollTop,1200);assert.equal(scroller.scrollLeft,650);assert.equal(h.symbols().length,700);
    const changedSymbol=rows[350].getAttribute("data-risk-symbol"),sparseStart=h.mutations.length;
    h.latest={...JSON.parse(JSON.stringify(h.latest)),revision:3};h.latest.options.find(row=>row.symbol===changedSymbol).gamma="0.00000272";h.window.OptionRiskUI.onSnapshot(h.latest);h.runTimeouts(250);
    const sparseWrites=tableMutations(h,sparseStart);assert.equal(sparseWrites.length,1);assert.equal(sparseWrites[0].kind,"html");assert.equal(sparseWrites[0].node,cells[350][3]);assert.equal(h.created.length,created);
    rows.forEach((row,index)=>assert.equal(tbody.children[index],row));assert.deepEqual(h.mutations.slice(sparseStart).filter(event=>event.kind==="scroll"),[]);
  });
  await check("one descriptive Gamma change updates only that cell while preserving row and sibling content nodes",()=>{
    const h=harness();h.latest=versioned(h,1);h.node("riskButton").click();const row=h.node("riskRows").firstChild,cells=[...row.cells],start=h.mutations.length,created=h.created.length;
    h.latest=versioned(h,2);h.latest.options[0].gamma="0.00000272";h.window.OptionRiskUI.onSnapshot(h.latest);h.runTimeouts(250);
    assert.equal(h.node("riskRows").firstChild,row);assert.deepEqual(row.cells,cells);assert.equal(h.created.length,created);
    const writes=tableMutations(h,start);assert.equal(writes.length,1);assert.equal(writes[0].kind,"html");assert.equal(writes[0].node,cells[3]);assert.match(cells[3].innerHTML,/^0\.00000272<small>/);
    assert.equal(h.analyses.at(-1).params.premium,100);
  });
  await check("budget warnings update only changed status content and attributes without replacing numeric cells",()=>{
    const h=harness();h.latest=versioned(h,1);h.node("riskButton").click();const row=h.node("riskRows").firstChild,cells=[...row.cells],maxLoss=cells[6].innerHTML,start=h.mutations.length;
    h.field("riskBudget","1","input");assert.equal(h.node("riskRows").firstChild,row);assert.deepEqual(row.cells,cells);assert.equal(cells[6].innerHTML,maxLoss);assert.equal(cells[6].getAttribute("class"),"risk-negative");
    const writes=tableMutations(h,start);assert.ok(writes.length>0);assert.ok(writes.every(event=>event.kind==="attribute"||event.kind==="html"&&event.node===cells[19]));assert.match(cells[19].innerHTML,/最大亏损超预算/);
    h.field("riskBudget","1000","input");assert.equal(cells[6].getAttribute("class"),"");assert.equal(cells[19].getAttribute("class"),"risk-status ");
  });
  await check("sorting moves existing rows into metric order and repeated order performs no moves",()=>{
    const h=harness();h.node("riskButton").click();h.field("riskExpiry","ALL");const tbody=h.node("riskRows"),rows=new Map(tbody.children.map(row=>[row.getAttribute("data-risk-symbol"),row])),created=h.created.length,scroller=h.node("riskTableScroll");scroller.scrollTop=300;scroller.scrollLeft=800;
    h.analyses.length=0;const start=h.mutations.length;h.field("riskSort","expected");
    const expected=[...h.analyses].sort((a,b)=>b.result.model.expectedPnl-a.result.model.expectedPnl).map(item=>item.params.strike);
    assert.deepEqual(h.symbols().map(symbol=>Number(symbol.split("-")[2])),expected);assert.equal(h.created.length,created);assert.ok(tableMutations(h,start).every(event=>event.kind==="insert"));
    for(const row of tbody.children)assert.equal(row,rows.get(row.getAttribute("data-risk-symbol")));
    assert.equal(scroller.scrollTop,300);assert.equal(scroller.scrollLeft,800);const unchanged=h.mutations.length;h.field("riskSort","expected");assert.deepEqual(tableMutations(h,unchanged),[]);
  });
  await check("catalog additions and removals preserve surviving row identity and create cells only for the newcomer",()=>{
    const h=harness();h.node("riskHideUnavailable").checked=false;h.latest=h.snapshot([h.row(),h.row(70000,"PUT",h.expiryA,{bid_price:"0"})]);h.node("riskButton").click();const tbody=h.node("riskRows"),survivor=tbody.children[0],removed=tbody.children[1],cells=[...survivor.cells],created=h.created.length,start=h.mutations.length;
    h.latest=h.snapshot([h.row(),h.row(80000)]);h.node("riskRefresh").click();assert.deepEqual(h.symbols(),["BTC-300110-64000-P","BTC-300110-80000-P"]);
    assert.equal(tbody.children[0],survivor);assert.deepEqual(survivor.cells,cells);assert.equal(removed.parentNode,null);assert.equal(removed.removed,true);assert.equal(h.created.length-created,21);
    assert.ok(!tableMutations(h,start).some(event=>event.node===survivor||cells.includes(event.node)),"an unchanged survivor needs no writes or movement");
  });
  await check("unavailable visibility filters remove only hidden rows and keep visible calculations in place",()=>{
    const h=harness();h.latest=h.snapshot([h.row(),h.row(70000,"PUT",h.expiryA,{bid_price:"0"})]);h.node("riskButton").click();const tbody=h.node("riskRows"),survivor=tbody.firstChild,cells=[...survivor.cells];
    h.node("riskHideUnavailable").checked=false;h.node("riskHideUnavailable").fire("change");assert.equal(tbody.children.length,2);const unavailable=tbody.children[1];assert.match(unavailable.cells[19].innerHTML,/暂无买盘/);
    const start=h.mutations.length;h.node("riskHideUnavailable").checked=true;h.node("riskHideUnavailable").fire("change");assert.equal(tbody.children.length,1);assert.equal(tbody.firstChild,survivor);assert.deepEqual(survivor.cells,cells);assert.equal(unavailable.parentNode,null);
    const writes=tableMutations(h,start);assert.equal(writes.length,1);assert.equal(writes[0].kind,"remove");assert.equal(writes[0].node,unavailable);
  });
  await check("paused aging changes freshness attributes in place without recomputing or moving frozen rows",()=>{
    const h=harness();h.latest=versioned(h,1);h.node("riskButton").click();h.node("riskLive").click();const row=h.node("riskRows").firstChild,cells=[...row.cells],calls=h.analyses.length,created=h.created.length,start=h.mutations.length;
    h.advance(21000);h.tick();assert.equal(h.analyses.length,calls);assert.equal(h.created.length,created);assert.equal(h.node("riskRows").firstChild,row);assert.deepEqual(row.cells,cells);assert.equal(row.getAttribute("data-risk-current"),"false");assert.equal(cells[19].innerHTML,"已固定");
    assert.ok(tableMutations(h,start).every(event=>event.kind==="attribute"));const unchanged=h.mutations.length;h.advance(2000);h.tick();assert.deepEqual(tableMutations(h,unchanged),[]);
  });
  await check("daily return columns match their headings and show the user's ten-USDT ten-day example",()=>{
    const h=harness(),html=fs.readFileSync(path.join(root,"index.html"),"utf8");
    const table=/<table\b[^>]*id="riskTable"[^>]*>([\s\S]*?)<\/table>/.exec(html)?.[1]??html.slice(html.indexOf('id="riskTableScroll"'));
    assert.match(table,/<th[^>]*>最高平均日收益<\/th>/);assert.match(table,/<th[^>]*>最高平均日收益率<\/th>/);
    h.setExpiry("ALL");h.node("riskQuantity").value="1";
    h.latest=h.snapshot([h.row(100,"PUT",Date.parse("2030-01-11T00:00:00Z"),{bid_price:"10.024",ask_price:"11"})]);h.latest.btc_index_price="100";h.node("riskButton").click();
    const cells=h.node("riskRows").firstChild.cells;assert.equal(cells.length,20);
    assert.match(cells[10].innerHTML,/^1(?:\.0+)?<small>剩余\s*10\s*天<\/small>$/);
    assert.match(cells[11].innerHTML,/^1(?:\.0+)?%<small>现金覆盖<\/small>$/);
    assert.doesNotMatch(cells[10].outerHTML+cells[11].outerHTML,/\btitle=/,"daily metrics must not reintroduce hover tips");
  });
  await check("four directions show finite daily income and a valid capital basis only when defined",()=>{
    const h=harness();h.latest=h.snapshot([h.row(),h.row(90000,"CALL")]);h.node("riskButton").click();
    let cells=h.node("riskRows").firstChild.cells;assert.match(cells[11].innerHTML,/现金覆盖/);
    h.field("riskDirection","BUY");cells=h.node("riskRows").firstChild.cells;assert.match(cells[11].innerHTML,/权利金成本/);assert.doesNotMatch(cells[11].innerHTML,/现金覆盖/);
    h.field("riskType","CALL");cells=h.node("riskRows").firstChild.cells;assert.match(cells[10].innerHTML,/盈利无上限/);assert.doesNotMatch(cells[10].innerHTML,/^0(?:<|$)/);assert.match(cells[11].innerHTML,/^不适用/);
    h.field("riskDirection","SELL");cells=h.node("riskRows").firstChild.cells;assert.match(cells[10].innerHTML,/剩余/);assert.match(cells[11].innerHTML,/未设资金口径/);assert.match(cells[11].innerHTML,/^不适用/);
  });
  await check("small positive daily amounts and rates remain nonzero in scientific notation",()=>{
    const h=harness();h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:"0.0000001",ask_price:"0.0000002"})]);h.node("riskButton").click();
    const m=h.analyses[0].result,cells=h.node("riskRows").firstChild.cells;
    assert.ok(m.averageDailyMaxProfit>0&&m.averageDailyMaxProfit<1e-8);assert.ok(m.averageDailyReturnPct>0&&m.averageDailyReturnPct<1e-8);
    assert.match(cells[10].innerHTML,/^[1-9](?:\.\d+)?e-\d+<small>/);assert.match(cells[11].innerHTML,/^[1-9](?:\.\d+)?e-\d+%<small>/);
    assert.ok(Number(cells[10].innerHTML.split("<")[0])>0);assert.ok(Number(cells[11].innerHTML.split("%",1)[0])>0);
  });
  await check("daily-return sorting uses the registered selector and preserves rows and the scroll position",()=>{
    const h=harness();h.node("riskButton").click();h.field("riskExpiry","ALL");
    const tbody=h.node("riskRows"),rows=new Map(tbody.children.map(row=>[row.getAttribute("data-risk-symbol"),row])),created=h.created.length,scroller=h.node("riskTableScroll");
    scroller.scrollTop=300;scroller.scrollLeft=650;h.analyses.length=0;h.field("riskSort","dailyReturn");
    assert.equal(h.node("riskSort").value,"dailyReturn");
    const expected=[...h.analyses].sort((a,b)=>b.result.averageDailyReturnPct-a.result.averageDailyReturnPct).map(item=>item.params.strike);
    assert.deepEqual(h.symbols().map(symbol=>Number(symbol.split("-")[2])),expected);assert.equal(h.created.length,created);
    for(const row of tbody.children)assert.equal(row,rows.get(row.getAttribute("data-risk-symbol")));
    assert.equal(scroller.scrollTop,300);assert.equal(scroller.scrollLeft,650);
  });
  await check("fresh live pricing updates daily amounts and their remaining time without replacing the row",()=>{
    const h=harness();h.latest=versioned(h,1);h.node("riskButton").click();const first=h.analyses[0].result,row=h.node("riskRows").firstChild,cells=[...row.cells],amount=cells[10].innerHTML;
    h.advance(3600000);h.latest=versioned(h,2,200);h.window.OptionRiskUI.onSnapshot(h.latest);h.runTimeouts(250);
    const latest=h.analyses.at(-1).result;assert.ok(latest.remainingDays<first.remainingDays);assert.ok(latest.averageDailyMaxProfit>first.averageDailyMaxProfit);assert.ok(latest.averageDailyReturnPct>first.averageDailyReturnPct);
    assert.notEqual(cells[10].innerHTML,amount);assert.equal(h.node("riskRows").firstChild,row);assert.deepEqual(row.cells,cells);assert.equal(row.getAttribute("data-risk-current"),"true");
  });
  await check("paused daily values keep their original horizon and quantity changes scale amounts without scaling rates",()=>{
    const h=harness();h.latest=versioned(h,1);h.node("riskButton").click();const first=h.analyses[0].result,cells=h.node("riskRows").firstChild.cells,amount=cells[10].innerHTML,rate=cells[11].innerHTML;
    h.node("riskLive").click();h.advance(86400000);h.latest=versioned(h,2,900);h.tick();assert.equal(cells[10].innerHTML,amount);assert.equal(cells[11].innerHTML,rate);
    h.field("riskQuantity","0.02","input");const fixed=h.analyses.at(-1).result;
    assert.equal(fixed.remainingDays,first.remainingDays);assert.equal(fixed.averageDailyMaxProfit,first.averageDailyMaxProfit*2);assert.equal(fixed.averageDailyReturnPct,first.averageDailyReturnPct);assert.equal(cells[11].innerHTML,rate);
  });
  await check("historical daily values remain fixed through missing feeds and resume with fresh horizon on recovery",()=>{
    const h=harness();h.latest=versioned(h,1);h.node("riskButton").click();const first=h.analyses[0].result,cells=h.node("riskRows").firstChild.cells,amount=cells[10].innerHTML,rate=cells[11].innerHTML;
    h.advance(21000);h.tick();assert.equal(cells[10].innerHTML,amount);assert.equal(cells[11].innerHTML,rate);assert.equal(h.analyses.at(-1).result.remainingDays,first.remainingDays);assert.match(cells[19].innerHTML,/历史快照/);
    h.latest=versioned(h,2,300);h.window.OptionRiskUI.onSnapshot(h.latest);h.runTimeouts(250);
    assert.ok(h.analyses.at(-1).result.remainingDays<first.remainingDays);assert.notEqual(cells[10].innerHTML,amount);assert.equal(h.node("riskRows").firstChild.getAttribute("data-risk-current"),"true");
  });
  await check("unavailable daily cells use blanks rather than a zero return and leave the warning in the final column",()=>{
    const h=harness();h.latest=h.snapshot([h.row(64000,"PUT",h.expiryA,{bid_price:"0"})]);h.node("riskHideUnavailable").checked=false;h.node("riskButton").click();
    const cells=h.node("riskRows").firstChild.cells;assert.equal(cells.length,20);assert.match(cells[10].innerHTML,/^—/);assert.match(cells[11].innerHTML,/^—/);assert.match(cells[19].innerHTML,/暂无买盘/);
  });
  await check("browser CSV export includes exactly the displayed daily values and the actual daily-return basis",async()=>{
    const h=harness();h.latest=versioned(h,1);h.node("riskButton").click();const m=h.analyses[0].result;h.node("riskExport").click();
    const csv=await h.blobs.get(h.downloads[0].url).text(),[header,record]=csv.replace(/^\uFEFF/,"").split("\r\n").map(line=>[...line.matchAll(/"((?:[^"]|"")*)"/g)].map(match=>match[1]));
    assert.equal(Number(record[header.indexOf("剩余天数")]),m.remainingDays);assert.equal(Number(record[header.indexOf("最高平均日收益_USDT")]),m.averageDailyMaxProfit);assert.equal(Number(record[header.indexOf("最高平均日收益率_百分比")]),m.averageDailyReturnPct);assert.equal(record[header.indexOf("日收益率资金口径")],"cash_secured");
  });
  await check("book-frame verification pauses current authority while retaining the exact prior risk reference",()=>{
    const h=harness();h.latest=versioned(h,1);h.node("riskButton").click();const first=h.analyses[0].result,symbol=h.latest.options[0].symbol;
    h.latest=versioned(h,2,400);h.latest.options[0].quote_group_valid=false;
    h.window.OptionRiskUI.onSnapshot(h.latest);h.runTimeouts(250);
    assert.deepEqual(h.validity(),["true"]);const row=h.renderedRow(symbol);
    assert.match(row,/历史快照/);assert.match(row,/data-risk-current="false"/);
    assert.equal(h.analyses.at(-1).result.model.expectedPnl,first.model.expectedPnl);
    h.latest=versioned(h,3,400);h.latest.options[0].quote_group_valid=true;
    h.window.OptionRiskUI.onSnapshot(h.latest);h.runTimeouts(250);
    assert.match(h.renderedRow(symbol),/data-risk-current="true"/);
    assert.notEqual(h.analyses.at(-1).result.model.expectedPnl,first.model.expectedPnl);
  });
  await check("an unverified frame containing observed zero liquidity cannot revive a prior risk reference",()=>{
    const h=harness();h.latest=versioned(h,1);h.node("riskButton").click();
    h.latest=versioned(h,2,0);h.latest.options[0].quote_group_valid=false;
    h.window.OptionRiskUI.onSnapshot(h.latest);h.runTimeouts(250);assert.equal(h.symbols().length,0);
    h.latest=versioned(h,3,400);h.latest.options[0].quote_group_valid=false;
    h.window.OptionRiskUI.onSnapshot(h.latest);h.runTimeouts(250);assert.equal(h.symbols().length,0);
  });
  console.log(`${count} option risk controller checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
