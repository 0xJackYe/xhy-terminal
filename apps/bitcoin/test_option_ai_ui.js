"use strict";

// Real dialog listeners with an in-memory local relay. No network, credentials,
// browser storage, timers that sleep, or exchange/order operations are used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync("dashboard/dist/option-ai-ui.js", "utf8");
const html = fs.readFileSync("dashboard/dist/index.html", "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const MODELS = [{id:"deepseek-flash", label:"V4.1 Flash"}, {id:"deepseek-v4-pro", label:"V4 Pro"}];
const STATUS = {configured:true, models:MODELS, default_model:"deepseek-flash"};
const RESULT = {answer:"找到符合条件的合约。", criteria:{direction:"SELL",type:"PUT",quantity:.01},
  candidates:[{symbol:"BTC-301011-60000-P", type:"PUT", direction:"SELL", expiry:"2030-10-11",strike:60000,
    quantity:.01,quote_price:100,premium_total:1,daily_premium:.1,remaining_days:10}],
  snapshot:{instance_id:"market-1", revision:13,evaluated_at_ms:1917907200000},warnings:[]};
const settle = async () => {for (let i=0;i<15;i++) await Promise.resolve();};
function deferred() {let resolve, reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

function harness(options = {}) {
  let now=Date.parse("2030-10-01T00:00:00Z"), nextTimer=0;
  const timers=new Map(), requests=[], queues=new Map(), nodes=new Map();
  class Node {
    constructor(id) {this.id=id;this.value="";this.textContent="";this.innerHTML="";this.hidden=false;this.open=false;this.disabled=false;this.listeners={};this.attributes={};this.focuses=0;}
    addEventListener(type, fn) {(this.listeners[type]??=[]).push(fn);}
    async fire(type, event={}) {for(const fn of this.listeners[type]??[]) await fn({target:this,preventDefault(){},...event});}
    setAttribute(name,value) {this.attributes[name]=value;}
    showModal() {this.open=true;}
    close() {this.open=false;for(const fn of this.listeners.close??[])fn();}
    focus() {this.focuses++;}
  }
  for(const id of ids) nodes.set(id,new Node(id));
  nodes.get("aiCustomCriteria").open=true;
  const node=id=>nodes.get(id)??null;
  class Controller {constructor(){this.signal={aborted:false};} abort(){this.signal.aborted=true;}}
  class ClockDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  function queue(method,path,value) {const key=method+" "+path;const list=queues.get(key)??[];list.push(value);queues.set(key,list);}
  async function fetchFake(url, config={}) {
    const method=config.method??"GET",path=url.replace("/api/option-ai",""),key=method+" "+path;
    const request={url,path,method,config,body:config.body?JSON.parse(config.body):null};requests.push(request);
    let response;
    if(queues.get(key)?.length) response=queues.get(key).shift();
    else if(path==="/status") response=STATUS;
    else if(method==="POST"&&path==="/jobs") response={job_id:"job-1",status:"queued"};
    else if(method==="DELETE") response={status:"cancelled"};
    else if(path.endsWith("/revalidate")) response={status:"complete",result:RESULT};
    else if(method==="GET"&&path.startsWith("/jobs/")) response={status:"complete",result:RESULT};
    else response={configured:true};
    if(typeof response==="function") response=response(request);
    response=await response;
    if(response instanceof Error) throw response;
    return {ok:!response?.http_status||response.http_status<400,status:response?.http_status??200,
      json:async()=>response?.http_status?response.data:response};
  }
  const document={getElementById:node,activeElement:node("aiButton"),querySelector:selector=>selector==="dialog[open]"?[...nodes.values()].find(value=>value.id.endsWith("Dialog")&&value.open)??null:null};
  const context=vm.createContext({window:{},document,fetch:fetchFake,AbortController:Controller,Date:ClockDate,
    Intl,JSON,Number,String,Object,Map,Set,Error,encodeURIComponent,
    setTimeout:(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(source,context);
  const callback=options.onOpenCandidate??(async()=>true);
  context.window.OptionAIUI.initialize({onOpenCandidate:callback,getSnapshot:options.getSnapshot??(()=>({revision:20})),getExpiry:options.getExpiry});
  async function open(id="aiButton") {await node(id).fire("click");await settle();}
  async function send(question="找十天左右到期的卖 Put") {node("aiQuestion").value=question;await node("aiForm").fire("submit");await settle();}
  async function poll() {const entry=[...timers].find(([,value])=>[700,1500].includes(value.delay));assert.ok(entry,"a bounded next poll must be scheduled");timers.delete(entry[0]);entry[1].fn();await settle();}
  return {node,context,requests,timers,queue,open,send,poll,advance:ms=>{now+=ms;},settle};
}

let count=0;
async function check(name,fn){await fn();count++;console.log("OK "+name);}
(async()=>{
  await check("the normal and quote-focus entries share one local dialog and assets load before the app",()=>{
    assert.ok(html.indexOf('src="/option-ai-ui.js"')<html.indexOf('src="/app.js"'));
    assert.ok(html.includes('href="/option-ai.css"'));
    for(const id of ["aiButton","focusAIButton","aiDialog","aiQuestion","aiCandidates","aiKey"])assert.equal(ids.filter(value=>value===id).length,1);
    assert.match(html,/<input id="aiKey" type="password" autocomplete="off"/);
    assert.doesNotMatch(source,/localStorage|sessionStorage|document\.cookie/);
  });
  await check("only available provider-reported model IDs are offered and the actual default is selected",async()=>{
    const h=harness();h.queue("GET","/status",{...STATUS,models:[...MODELS,MODELS[0],{id:"bad\"id",label:"bad"},{id:"disabled",available:false}],default_model:"deepseek-v4-pro"});
    await h.open();assert.equal(h.node("aiDialog").open,true);assert.equal(h.node("aiModel").value,"deepseek-v4-pro");
    assert.equal((h.node("aiModel").innerHTML.match(/<option/g)??[]).length,2);assert.equal(h.node("aiSend").disabled,false);
    assert.match(h.node("aiConnection").textContent,/已配置/);
  });
  await check("the focus button opens the same accessible dialog without requiring quote rendering",async()=>{
    const h=harness();await h.open("focusAIButton");assert.equal(h.node("aiDialog").open,true);assert.equal(h.node("aiQuestion").focuses,1);
    h.node("aiDialog").close();assert.equal(h.node("focusAIButton").focuses,1);
  });
  await check("missing key or models disables screening and reveals only the local connection form",async()=>{
    const h=harness();h.queue("GET","/status",{configured:false,models:[]});await h.open();
    assert.equal(h.node("aiSettings").open,true);assert.equal(h.node("aiSend").disabled,true);
    await h.send();assert.equal(h.requests.filter(r=>r.path==="/jobs").length,0);
  });
  await check("question bounds and accidental pasted credentials are rejected before any model request",async()=>{
    const h=harness();await h.open();
    for(const input of [" ","x".repeat(3001),"use sk-unit-test-placeholder-value"]){await h.send(input);assert.equal(h.node("aiError").hidden,false);}
    assert.equal(h.requests.filter(r=>r.path==="/jobs").length,0);assert.doesNotMatch(h.node("aiError").textContent,/sk-unit/);
  });
  await check("a completed job renders exact deterministic candidate fields and snapshot reference",async()=>{
    const h=harness();await h.open();await h.send();
    const request=h.requests.find(r=>r.path==="/jobs");assert.equal(request.method,"POST");assert.equal(request.body.model,"deepseek-flash");assert.equal(request.body.question,"找十天左右到期的卖 Put");assert.deepEqual(request.body.history,[]);
    assert.equal(h.node("aiResult").hidden,false);assert.match(h.node("aiCandidates").innerHTML,/BTC-301011-60000-P/);assert.match(h.node("aiCandidates").innerHTML,/0\.1 USDT\/日/);assert.match(h.node("aiSnapshot").textContent,/版本 13/);
    assert.equal(h.node("aiSend").disabled,false);assert.equal(h.node("aiRevalidate").disabled,false);assert.equal(h.node("aiDialog").attributes["aria-busy"],"false");
  });
  await check("model text and candidate reasons cannot insert HTML or expose echoed credentials",async()=>{
    const h=harness();h.queue("GET","/jobs/job-1",{status:"complete",result:{...RESULT,answer:'<img src=x onerror=alert(1)> sk-redacted-test-secret',candidates:[{...RESULT.candidates[0],reason:'<script>alert(1)</script> sk-redacted-test-secret'}]}});
    await h.open();await h.send();assert.match(h.node("aiAnswer").textContent,/<img/);assert.doesNotMatch(h.node("aiAnswer").textContent,/sk-redacted/);
    assert.match(h.node("aiCandidates").innerHTML,/&lt;script&gt;/);assert.doesNotMatch(h.node("aiCandidates").innerHTML,/<script>|sk-redacted/);
  });
  await check("results contain at most twenty valid known-shape BTC records and invalid symbols or directions are excluded",async()=>{
    const h=harness();const candidates=Array.from({length:30},(_,i)=>({...RESULT.candidates[0],symbol:`BTC-301011-${60000+i}-P`}));
    candidates.unshift({...RESULT.candidates[0],symbol:'<svg onload=x>'},{...RESULT.candidates[0],direction:"ORDER"});
    h.queue("GET","/jobs/job-1",{status:"complete",result:{...RESULT,candidates}});await h.open();await h.send();
    assert.equal((h.node("aiCandidates").innerHTML.match(/<article/g)??[]).length,20);assert.doesNotMatch(h.node("aiCandidates").innerHTML,/onload|ORDER/);
  });
  await check("clarification and empty-match outcomes remain explicit without manufactured candidates",async()=>{
    const h=harness();h.queue("GET","/jobs/job-1",{status:"complete",result:{...RESULT,candidates:[],needs_clarification:true,answer:"请说明到期日。"}});await h.open();await h.send();
    assert.match(h.node("aiEmpty").textContent,/补充/);assert.equal(h.node("aiEmpty").hidden,false);assert.equal(h.node("aiCandidates").innerHTML,"");
  });
  await check("running jobs poll only the local job endpoint and reject repeated submits",async()=>{
    const h=harness();h.queue("GET","/jobs/job-1",{status:"running"});await h.open();await h.send();
    assert.equal(h.node("aiSend").disabled,true);assert.equal(h.node("aiCancel").hidden,false);
    await h.send("second");assert.equal(h.requests.filter(r=>r.method==="POST"&&r.path==="/jobs").length,1);
    await h.poll();assert.equal(h.node("aiResult").hidden,false);assert.equal(h.requests.filter(r=>r.path==="/jobs/job-1").length,2);
    assert.ok(h.requests.every(r=>r.url.startsWith("/api/option-ai/")));
  });
  await check("stop cancels the job and removes its scheduled polling without touching market data",async()=>{
    const h=harness();h.queue("GET","/jobs/job-1",{status:"queued"});await h.open();await h.send();await h.node("aiCancel").fire("click");await settle();
    assert.equal(h.node("aiSend").disabled,false);assert.ok(h.requests.some(r=>r.method==="DELETE"&&r.path==="/jobs/job-1"));
    assert.ok(![...h.timers.values()].some(timer=>[700,1500].includes(timer.delay)));assert.match(h.node("aiProgress").textContent,/停止/);
  });
  await check("closing during an in-flight poll aborts it and its late answer cannot reopen or update results",async()=>{
    const h=harness(),late=deferred();h.queue("GET","/jobs/job-1",()=>late.promise);await h.open();
    const submitted=h.send();await settle();const request=h.requests.find(r=>r.path==="/jobs/job-1");h.node("aiDialog").close();
    assert.equal(request.config.signal.aborted,true);late.resolve({status:"complete",result:RESULT});await submitted;await settle();
    assert.equal(h.node("aiDialog").open,false);assert.equal(h.node("aiResult").hidden,true);assert.notEqual(h.node("aiAnswer").textContent,RESULT.answer);
  });
  await check("a late submitted job ID is cancelled when its owning dialog has already closed",async()=>{
    const h=harness(),late=deferred();h.queue("POST","/jobs",()=>late.promise);await h.open();const submitted=h.send();await settle();h.node("aiDialog").close();late.resolve({job_id:"late-job"});await submitted;await settle();
    assert.ok(h.requests.some(r=>r.method==="DELETE"&&r.path==="/jobs/late-job"));assert.equal(h.node("aiResult").hidden,true);
  });
  await check("invalid job IDs cannot become arbitrary URLs",async()=>{
    const h=harness();h.queue("POST","/jobs",{job_id:"../../api/order"});await h.open();await h.send();assert.match(h.node("aiError").textContent,/任务编号/);assert.ok(!h.requests.some(r=>r.path.includes("order")));
  });
  await check("server failures are sanitized and restore controls without generating fictional results",async()=>{
    const h=harness();h.queue("GET","/jobs/job-1",{status:"failed",error:"provider refused sk-unit-test-error-token"});await h.open();await h.send();
    assert.equal(h.node("aiError").hidden,false);assert.doesNotMatch(h.node("aiError").textContent,/sk-unit/);assert.equal(h.node("aiSend").disabled,false);assert.equal(h.node("aiResult").hidden,true);
  });
  await check("a failed local poll cancels unfinished work instead of leaving a hidden active job",async()=>{
    const h=harness();h.queue("GET","/jobs/job-1",new Error("local connection lost"));await h.open();await h.send();
    assert.match(h.node("aiError").textContent,/local connection/);assert.ok(h.requests.some(r=>r.method==="DELETE"));assert.equal(h.node("aiRevalidate").disabled,true);
  });
  await check("total waiting time is bounded even if the relay stays running forever",async()=>{
    const h=harness();h.queue("GET","/jobs/job-1",{status:"running"});await h.open();await h.send();h.advance(180001);await h.poll();
    assert.match(h.node("aiError").textContent,/超时/);assert.equal(h.node("aiSend").disabled,false);assert.ok(h.requests.some(r=>r.method==="DELETE"));
  });
  await check("updating quotes revalidates the existing criteria without making another model job",async()=>{
    const h=harness();await h.open();await h.send();h.queue("POST","/jobs/job-1/revalidate",{status:"complete",result:{...RESULT,snapshot:{...RESULT.snapshot,revision:14},candidates:[{...RESULT.candidates[0],quote_price:120,daily_premium:.12}]}});
    await h.node("aiRevalidate").fire("click");await settle();assert.equal(h.requests.filter(r=>r.path==="/jobs"&&r.method==="POST").length,1);assert.match(h.node("aiSnapshot").textContent,/版本 14/);assert.match(h.node("aiCandidates").innerHTML,/0\.12 USDT\/日/);
  });
  await check("all local AI writes include the terminal same-origin protection header",async()=>{
    const h=harness();await h.open();h.node("aiKey").value="sk-unit-test-local-placeholder";await h.node("aiKeyForm").fire("submit");await h.send();
    await h.node("aiRevalidate").fire("click");await settle();h.queue("GET","/jobs/job-1",{status:"running"});await h.send("another request");await h.node("aiCancel").fire("click");await settle();
    for(const request of h.requests.filter(r=>r.method!=="GET"))assert.equal(request.config.headers["X-Terminal-Request"],"1",request.method+" "+request.path);
    for(const methodPath of ["POST /config","POST /jobs","POST /jobs/job-1/revalidate","DELETE /jobs/job-1"])assert.ok(h.requests.some(r=>r.method+" "+r.path===methodPath),methodPath);
    assert.equal(h.requests.find(r=>r.path==="/status").config.headers["X-Terminal-Request"],undefined);
  });
  await check("only the last three completed turns are sent as context and history remains bounded in memory",async()=>{
    const h=harness();await h.open();for(let i=0;i<6;i++)await h.send("需求"+i);
    const posts=h.requests.filter(r=>r.path==="/jobs"&&r.method==="POST");assert.equal(posts.length,6);assert.equal(posts[5].body.history.length,6);assert.equal(posts[5].body.history[0].content,"需求2");
    assert.equal((h.node("aiHistory").innerHTML.match(/<details/g)??[]).length,3);
  });
  await check("long earlier questions and model answers stay within the client's history limit",async()=>{
    const h=harness();await h.open();h.queue("GET","/jobs/job-1",{status:"complete",result:{...RESULT,answer:"a".repeat(3000)}});await h.send("q".repeat(3000));await h.send("follow up");
    const history=h.requests.filter(r=>r.method==="POST"&&r.path==="/jobs")[1].body.history;assert.equal(history.length,2);assert.equal(history[0].content.length,2000);assert.equal(history[1].content.length,2000);
  });
  await check("saving a local key clears the password immediately and never includes it in job history",async()=>{
    const h=harness(),key="sk-unit-test-local-placeholder";await h.open();h.node("aiKey").value=key;await h.node("aiKeyForm").fire("submit");await settle();
    assert.equal(h.node("aiKey").value,"");assert.equal(h.requests.find(r=>r.path==="/config").body.api_key,key);await h.send();
    assert.doesNotMatch(JSON.stringify(h.requests.filter(r=>r.path==="/jobs").map(r=>r.body)),/sk-unit/);assert.doesNotMatch(h.node("aiHistory").innerHTML,/sk-unit/);
  });
  await check("candidate selection forwards verified data and snapshot to the current-quote callback",async()=>{
    const calls=[],h=harness({onOpenCandidate:async(...args)=>{calls.push(args);return true;}});await h.open();await h.send();
    const button={dataset:{aiCandidate:"0"},disabled:false};await h.node("aiCandidates").fire("click",{target:{closest:()=>button}});
    assert.equal(calls.length,1);assert.equal(calls[0][0].symbol,RESULT.candidates[0].symbol);assert.equal(calls[0][1].snapshot.revision,13);assert.equal(h.node("aiDialog").open,false);
  });
  await check("a candidate rejected by current data leaves the dialog open with a useful error",async()=>{
    const h=harness({onOpenCandidate:async()=>false});await h.open();await h.send();await h.node("aiCandidates").fire("click",{target:{closest:()=>({dataset:{aiCandidate:"0"}})}});
    assert.equal(h.node("aiDialog").open,true);assert.match(h.node("aiError").textContent,/当前报价/);
  });
  await check("a late candidate callback cannot close a newly reopened AI dialog",async()=>{
    const late=deferred(),h=harness({onOpenCandidate:()=>late.promise});await h.open();await h.send();const click=h.node("aiCandidates").fire("click",{target:{closest:()=>({dataset:{aiCandidate:"0"}})}});await settle();h.node("aiDialog").close();await h.open();late.resolve(true);await click;
    assert.equal(h.node("aiDialog").open,true);
  });
  await check("candidate selection blocks duplicates and invalidates the application's side-effect guard on close",async()=>{
    const late=deferred();let calls=0,sideEffects=0,context;const h=harness({onOpenCandidate:async(item,guard)=>{calls++;context=guard;await late.promise;if(!guard.isCurrent())return false;sideEffects++;return true;}});
    await h.open();await h.send();const button={dataset:{aiCandidate:"0"}},event={target:{closest:()=>button}};
    const pending=h.node("aiCandidates").fire("click",event);await settle();assert.equal(context.isCurrent(),true);assert.equal(h.node("aiSend").disabled,true);assert.equal(h.node("aiCancel").hidden,false);
    await h.node("aiCandidates").fire("click",event);await h.send("while checking");await h.node("aiRevalidate").fire("click");assert.equal(calls,1);assert.equal(h.requests.filter(r=>r.method==="POST"&&r.path==="/jobs").length,1);
    h.node("aiDialog").close();await h.open();assert.equal(context.isCurrent(),false);late.resolve();await pending;assert.equal(sideEffects,0);assert.equal(h.node("aiDialog").open,true);
  });
  await check("stopping a candidate check invalidates its guard and retains the completed job for quote refresh",async()=>{
    const late=deferred();let context;const h=harness({onOpenCandidate:async(item,guard)=>{context=guard;await late.promise;return guard.isCurrent();}});await h.open();await h.send();
    const pending=h.node("aiCandidates").fire("click",{target:{closest:()=>({dataset:{aiCandidate:"0"}})}});await settle();await h.node("aiCancel").fire("click");assert.equal(context.isCurrent(),false);assert.equal(h.node("aiSend").disabled,false);assert.equal(h.node("aiRevalidate").disabled,false);late.resolve();await pending;assert.equal(h.node("aiDialog").open,true);
  });
  await check("Escape is contained by the AI dialog and closing does not steal focus from a new payoff dialog",async()=>{
    const h=harness();await h.open();let stopped=false;await h.node("aiDialog").fire("keydown",{key:"Escape",stopPropagation(){stopped=true;}});assert.equal(stopped,true);
    h.node("payoffDialog").open=true;h.node("aiDialog").close();assert.equal(h.node("aiButton").focuses,0);
  });
  await check("later dialogue preserves complete validated criteria after old natural-language turns fall away", async()=>{
    const h=harness(); await h.open();
    const criteria={...RESULT.criteria,expiry:"2030-10-11",quantity:.03,min_otm_pct:10};
    for(let i=0;i<5;i++){
      h.queue("GET","/jobs/job-1",{status:"complete",result:{...RESULT,criteria}});
      await h.send("追加条件第"+i+"轮");
    }
    const requests=h.requests.filter(r=>r.method==="POST"&&r.path==="/jobs");
    assert.equal(requests[0].body.previous_criteria,undefined);
    assert.deepEqual(requests.at(-1).body.previous_criteria,criteria);
    assert.equal(requests.at(-1).body.history.length,6);
  });
  await check("clarification and failed followups do not erase the last complete criteria", async()=>{
    const h=harness();await h.open();await h.send("先卖Put");
    h.queue("GET","/jobs/job-1",{status:"complete",result:{needs_clarification:true,criteria:{},answer:"请说明收益标准。",candidates:[]}});
    await h.send("要更安全");
    h.queue("GET","/jobs/job-1",{status:"failed",error:"fixture temporary failure"});await h.send("再次尝试");
    await h.send("Delta不超过0.2");
    assert.deepEqual(h.requests.filter(r=>r.method==="POST"&&r.path==="/jobs").at(-1).body.previous_criteria,RESULT.criteria);
  });
  await check("risk comparison fields use decimal IV and distinguish missing metrics from zero", async()=>{
    const h=harness();h.queue("GET","/jobs/job-1",{status:"complete",result:{...RESULT,candidates:[{...RESULT.candidates[0],otm_pct:12.5,abs_delta:0,iv:.6,spread_pct:2}]}});
    await h.open();await h.send();const cards=h.node("aiCandidates").innerHTML;
    assert.match(cards,/虚值率 <b>12.5%/);assert.match(cards,/\|Delta\| <b>0/);assert.match(cards,/IV <b>60%/);assert.match(cards,/买卖价差 <b>2%/);
    assert.match(h.node("aiWarnings").textContent,/不等于每日盈利/);
  });
  await check("risk shortcut buttons expose their scope and explicit relative cash-secured Put basis",async()=>{
    for(const id of ["aiRiskLow","aiRiskMedium","aiRiskHigh","aiRiskExpiry","aiRiskQuantity","aiRiskResult","aiExplanation","aiExplanationText"])assert.equal(ids.filter(value=>value===id).length,1,id);
    for(const label of ["低风险","中风险","高风险","足额现金卖 Put · 相对风险分档","Delta 不是真实胜率","不适用于买方或裸卖 Call"])assert.ok(html.includes(label),label);
    const h=harness();await h.open();assert.equal(h.node("aiRiskExpiry").value,"ALL");assert.equal(h.node("aiRiskQuantity").value,"0.01");
    for(const id of ["aiRiskLow","aiRiskMedium","aiRiskHigh"])assert.equal(h.node(id).disabled,false);
  });
  await check("risk expiry choices use official times and the calibrated clock, omitting expired or inactive contracts",async()=>{
    const now=Date.parse("2030-10-01T00:00:00Z");
    const h=harness({getExpiry:()=>"2030-10-02",getSnapshot:()=>({exchange_clock_offset_ms:600000,options:[
      {status:"TRADING",expiry_ms:now+86400000,expiry_beijing:"2040-01-01T00:00:00+08:00"},
      {status:"TRADING",expiry_ms:now+300000},
      {status:"EXPIRED",expiry_ms:now+10*86400000},
      {status:"TRADING",expiry_ms:"broken"},
      {status:"TRADING",expiry_beijing:"2030-11-11T00:00:00"},
    ]})});
    await h.open();const choices=h.node("aiRiskExpiry").innerHTML;
    assert.equal(h.node("aiRiskExpiry").value,"ALL");assert.match(choices,/2030-10-02/);assert.doesNotMatch(choices,/2040|2030-10-01|2030-10-11|2030-11-11/);
  });
  await check("each risk button posts only its fixed profile, selected expiry, quantity and selected model",async()=>{
    const h=harness({getExpiry:()=>"2030-10-11",getSnapshot:()=>({options:[{status:"TRADING",expiry_ms:Date.parse("2030-10-11T08:00:00Z")} ]})});await h.open();await h.send("卖Put 0.03BTC");
    h.node("aiRiskQuantity").value="0.07";h.node("aiModel").value="deepseek-v4-pro";
    for(const [profile,id]of [["low","aiRiskLow"],["medium","aiRiskMedium"],["high","aiRiskHigh"]]){
      await h.node(id).fire("click");await settle();const body=h.requests.filter(r=>r.method==="POST"&&r.path==="/jobs").at(-1).body;
      assert.deepEqual(body,{model:"deepseek-v4-pro",risk_profile:profile,expiry:"2030-10-11",quantity:.07});
    }
    assert.equal(h.requests.filter(r=>r.method==="POST"&&r.path==="/jobs").length,4);
  });
  await check("risk scope rejects unsupported expiry and nonpositive or nonfinite quantity before creating a job",async()=>{
    const h=harness();await h.open();
    h.node("aiRiskExpiry").value="../../api/order";await h.node("aiRiskLow").fire("click");assert.match(h.node("aiError").textContent,/到期日/);
    h.node("aiRiskExpiry").value="ALL";
    for(const value of ["",0,"-1","NaN","Infinity"]){h.node("aiRiskQuantity").value=value;await h.node("aiRiskMedium").fire("click");assert.match(h.node("aiError").textContent,/正数/);}
    assert.equal(h.requests.filter(r=>r.path==="/jobs").length,0);
  });
  await check("missing configuration and running risk jobs disable all shortcuts and cannot double-submit through custom input",async()=>{
    const missing=harness();missing.queue("GET","/status",{configured:false,models:MODELS});await missing.open();
    for(const id of ["aiRiskLow","aiRiskMedium","aiRiskHigh"])assert.equal(missing.node(id).disabled,true);
    await missing.node("aiRiskHigh").fire("click");assert.equal(missing.requests.filter(r=>r.path==="/jobs").length,0);
    const h=harness();await h.open();h.queue("GET","/jobs/job-1",{status:"running"});await h.node("aiRiskLow").fire("click");await settle();
    for(const id of ["aiRiskLow","aiRiskMedium","aiRiskHigh","aiRiskExpiry","aiRiskQuantity","aiQuestion"])assert.equal(h.node(id).disabled,true,id);
    await h.node("aiRiskMedium").fire("click");await h.send("custom while profile running");assert.equal(h.requests.filter(r=>r.path==="/jobs").length,1);
    await h.node("aiCancel").fire("click");await settle();assert.ok(h.requests.some(r=>r.method==="DELETE"));assert.equal(h.node("aiRiskHigh").disabled,false);
  });
  await check("a late shortcut submission after closing is cancelled and cannot display risk results",async()=>{
    const h=harness(),late=deferred();await h.open();h.queue("POST","/jobs",()=>late.promise);
    const submitted=h.node("aiRiskHigh").fire("click");await settle();h.node("aiDialog").close();await h.open();
    late.resolve({job_id:"risk-late-job"});await submitted;await settle();
    assert.ok(h.requests.some(r=>r.method==="DELETE"&&r.path==="/jobs/risk-late-job"));assert.equal(h.node("aiResult").hidden,true);
  });
  await check("risk results show cash premium, downside stress, maximum loss and matched AI explanations as plain text",async()=>{
    const result={...RESULT,risk_profile:{id:"low",label:"低风险",definition:"0 < |Delta| ≤ 0.15"},
      ai_explanation:{status:"complete",overview:"风险较低仍可能亏损。<img src=x> sk-unit-test-model-echo",candidates:[
        {symbol:RESULT.candidates[0].symbol,text:"<script>bad()</script> 尾部亏损仍大。"},
        {symbol:"BTC-UNKNOWN",text:"不应出现的陌生合约"}]},
      candidates:[{...RESULT.candidates[0],cash_required:600,max_loss_gross:599,max_profit_gross:1,break_even:59900,break_even_drop_pct:20,
        stress_scenarios:[{move_pct:-20,settlement:56000,pnl_gross:-39}],risk_summary:"Delta 较小，满额现金仍有尾部亏损。"}]};
    const h=harness();h.queue("GET","/jobs/job-1",{status:"complete",result});await h.open();await h.node("aiRiskLow").fire("click");await settle();
    const card=h.node("aiCandidates").innerHTML;
    for(const value of ["整笔权利金 <b>1 USDT","足额现金 <b>600 USDT","最大亏损（未扣费） <b>599 USDT","盈亏平衡价 <b>59,900 USDT","到期指数跌 20% 损益 <b>-39 USDT","Delta 较小","尾部亏损仍大"] )assert.ok(card.includes(value),value);
    assert.match(h.node("aiRiskResult").textContent,/低风险/);assert.equal(h.node("aiExplanation").hidden,false);
    assert.match(h.node("aiExplanationText").textContent,/<img/);assert.doesNotMatch(h.node("aiExplanationText").textContent,/sk-unit/);
    assert.match(card,/&lt;script&gt;/);assert.doesNotMatch(card,/<script>|陌生合约/);
    assert.equal(h.node("aiAnswer").hidden,true,"profile rules should not be repeated as another paragraph");
    await h.send("自定义条件"); assert.equal(h.node("aiAnswer").hidden,false);
  });
  await check("a break-even above the index describes the required rise rather than a negative decline",async()=>{
    const h=harness();h.queue("GET","/jobs/job-1",{status:"complete",result:{...RESULT,risk_profile:{id:"high",label:"高风险"},
      candidates:[{...RESULT.candidates[0],break_even_drop_pct:-.5}]}});
    await h.open();await h.node("aiRiskHigh").fire("click");await settle();
    assert.match(h.node("aiCandidates").innerHTML,/回到平衡需上涨 <b>0.5%/);
    assert.doesNotMatch(h.node("aiCandidates").innerHTML,/跌至盈亏平衡 <b>-0.5/);
  });
  await check("AI explanation failures retain factual candidates and absent stress remains explicitly unknown",async()=>{
    const h=harness();h.queue("GET","/jobs/job-1",{status:"complete",result:{...RESULT,risk_profile:{id:"medium",label:"中风险"},ai_explanation:{status:"unavailable",error:"sk-must-not-surface"}}});
    await h.open();await h.node("aiRiskMedium").fire("click");await settle();
    assert.match(h.node("aiExplanationText").textContent,/保留本地计算/);assert.doesNotMatch(h.node("aiExplanationText").textContent,/sk-must/);
    assert.match(h.node("aiCandidates").innerHTML,/BTC-301011-60000-P/);assert.match(h.node("aiCandidates").innerHTML,/到期指数跌 20% 损益 <b>—/);
  });
  await check("risk refresh discards prior-snapshot AI text while retaining the profile and does not create another model job",async()=>{
    const h=harness(),profile={id:"high",label:"高风险"};
    h.queue("GET","/jobs/job-1",{status:"complete",result:{...RESULT,risk_profile:profile,ai_explanation:{status:"complete",overview:"旧快照解读",candidates:[{symbol:RESULT.candidates[0].symbol,text:"旧合约解读"}]}}});
    await h.open();await h.node("aiRiskHigh").fire("click");await settle();assert.match(h.node("aiCandidates").innerHTML,/旧合约解读/);
    h.queue("POST","/jobs/job-1/revalidate",{status:"complete",result:{...RESULT,risk_profile:profile,snapshot:{...RESULT.snapshot,revision:90},ai_explanation:{status:"outdated",overview:"旧快照解读",candidates:[{symbol:RESULT.candidates[0].symbol,text:"旧合约解读"}]}}});
    await h.node("aiRevalidate").fire("click");await settle();
    assert.equal(h.requests.filter(r=>r.method==="POST"&&r.path==="/jobs").length,1);assert.match(h.node("aiRiskResult").textContent,/高风险/);
    assert.match(h.node("aiExplanationText").textContent,/旧的 AI 解读已隐藏/);assert.doesNotMatch(h.node("aiCandidates").innerHTML,/旧合约解读/);
  });
  await check("a profile's current-quote callback preserves its profile for independent server-side band verification",async()=>{
    const calls=[],profile={id:"low",label:"低风险"},h=harness({onOpenCandidate:async(...args)=>{calls.push(args);return true;}});
    h.queue("GET","/jobs/job-1",{status:"complete",result:{...RESULT,risk_profile:profile}});await h.open();await h.node("aiRiskLow").fire("click");await settle();
    await h.node("aiCandidates").fire("click",{target:{closest:()=>({dataset:{aiCandidate:"0"}})}});
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1].risk_profile)),profile);assert.equal(typeof calls[0][1].isCurrent,"function");
  });
  await check("a nearest expiry outside 2–60 days visibly defaults to all while both inclusive boundaries retain the current date",async()=>{
    const now=Date.parse("2030-10-01T00:00:00Z");
    for(const days of [1.5,2,60,60.01]){
      const expiry=now+days*86400000,date=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(expiry));
      const h=harness({getExpiry:()=>date,getSnapshot:()=>({options:[{status:"TRADING",expiry_ms:expiry}]})});await h.open();
      assert.equal(h.node("aiRiskExpiry").value,days>=2&&days<=60?date:"ALL",String(days));
      assert.ok(h.node("aiRiskExpiry").innerHTML.includes(date),"out-of-band dates remain available for an explicit selection");
    }
    assert.ok(html.includes("相对风险分档 · 剩余 2–60 天"));
  });
  await check("an explicitly chosen near expiry is sent unchanged and empty results never silently broaden the request",async()=>{
    const h=harness({getExpiry:()=>"2030-10-02",getSnapshot:()=>({options:[{status:"TRADING",expiry_ms:Date.parse("2030-10-02T08:00:00Z")} ]})});await h.open();assert.equal(h.node("aiRiskExpiry").value,"ALL");
    h.node("aiRiskExpiry").value="2030-10-02";
    h.queue("GET","/jobs/job-1",{status:"complete",result:{...RESULT,risk_profile:{id:"low",label:"低风险"},candidates:[]}});
    await h.node("aiRiskLow").fire("click");await settle();
    const requests=h.requests.filter(r=>r.path==="/jobs");assert.equal(requests.length,1);assert.equal(requests[0].body.expiry,"2030-10-02");
    assert.match(h.node("aiEmpty").textContent,/2–60 天/);assert.match(h.node("aiEmpty").textContent,/未放宽/);
  });
  await check("risk shortcuts collapse only the custom textarea while model, cancel and progress remain outside it",async()=>{
    assert.match(html,/<details id="aiCustomCriteria"[^>]* open>/);
    const custom=html.slice(html.indexOf('<details id="aiCustomCriteria"'),html.indexOf('</details>',html.indexOf('<details id="aiCustomCriteria"')));
    assert.match(custom,/id="aiQuestion"/);
    for(const id of ["aiModel","aiSend","aiCancel","aiProgress"])assert.ok(!custom.includes('id="'+id+'"'),id);
    const h=harness();await h.open();assert.equal(h.node("aiCustomCriteria").open,true);
    h.queue("GET","/jobs/job-1",{status:"running"});await h.node("aiRiskLow").fire("click");await settle();
    assert.equal(h.node("aiCustomCriteria").open,false);assert.equal(h.node("aiCancel").hidden,false);assert.equal(h.node("aiProgress").textContent.length>0,true);
    await h.node("aiCancel").fire("click");await settle();await h.send("custom again");assert.equal(h.node("aiCustomCriteria").open,true);
  });
  await check("submitting a collapsed empty custom request expands and focuses its validation error",async()=>{
    assert.match(html,/<form id="aiForm"[^>]* novalidate>/);
    const h=harness();await h.open();h.node("aiCustomCriteria").open=false;const initial=h.node("aiQuestion").focuses;
    await h.send("");assert.equal(h.node("aiCustomCriteria").open,true);assert.equal(h.node("aiQuestion").focuses,initial+1);
    assert.match(h.node("aiError").textContent,/1–3000/);assert.equal(h.requests.filter(r=>r.path==="/jobs").length,0);
  });
  await check("verbose repeated local risk prose is folded while numeric facts and the AI assessment stay visible",async()=>{
    const h=harness();h.queue("GET","/jobs/job-1",{status:"complete",result:{...RESULT,risk_profile:{id:"low",label:"低风险"},
      candidates:[{...RESULT.candidates[0],max_loss_gross:599,cash_required:600,risk_summary:"完整本地风险事实"}],
      ai_explanation:{status:"complete",overview:"总览",candidates:[{symbol:RESULT.candidates[0].symbol,text:"AI风险评估"}]}}});
    await h.open();await h.node("aiRiskLow").fire("click");await settle();const card=h.node("aiCandidates").innerHTML;
    assert.match(card,/<details class="ai-local-risk"><summary>风险明细<\/summary><p>完整本地风险事实<\/p><\/details>/);
    assert.match(card,/最大亏损（未扣费） <b>599 USDT/);assert.match(card,/<\/details><p class="ai-candidate-analysis">/);assert.match(card,/AI风险评估/);
  });
  console.log(`${count} option AI UI checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
