import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Exercise the shipped function itself without installing the rest of the
// bridge's theme, navigation or same-origin frame machinery.
const source=readFileSync(new URL('../../frontend/theme-bridge.js',import.meta.url),'utf8');
const start=source.indexOf('  function connectFit(doc) {');
const end=source.indexOf('\n  function connectShortcuts(',start);
if(start<0||end<start)throw new Error('Unable to isolate the embedded fitting controller');
const connectFit=runInNewContext(source.slice(start,end)+'\nconnectFit;',{}, {filename:'theme-bridge-fit.js'});

function harness({embedded=true,naturalHeight=750,height=600,bodyPresent=true}={}){
  const styles=()=>({values:new Map(),setProperty(name,value,priority){this.values.set(name,{value:String(value),priority});},getPropertyValue(name){return this.values.get(name)?.value||'';}});
  const pending=new Map(),listeners=new Map(),resizeObservers=[],mutationObservers=[];
  const body={style:styles()},sheet={hidden:true},root={style:styles()};
  let frame=0,pageHeight=naturalHeight,modalOverflow=1400;
  const win={innerHeight:height,requestAnimationFrame(callback){const id=++frame;pending.set(id,callback);return id;},addEventListener(name,callback){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(callback);}};
  win.parent=embedded?{}:win;
  win.ResizeObserver=class{constructor(callback){this.callback=callback;resizeObservers.push(this);}observe(target){this.target=target;}};
  win.MutationObserver=class{constructor(callback){this.callback=callback;mutationObservers.push(this);}observe(target,options){this.target=target;this.options=options;}};
  Object.defineProperty(root,'scrollHeight',{get(){return Math.max(win.innerHeight,Math.ceil(pageHeight*Number(body.style.zoom||1)),sheet.hidden?0:modalOverflow);}});
  const doc={defaultView:win,body:bodyPresent?body:null,documentElement:root,
    getElementById(id){return id==='dcaCandleSheet'?sheet:null;},
    querySelector(selector){return selector==='#dcaCandleSheet'?sheet:selector==='#dcaCandleSheet:not([hidden])'&&!sheet.hidden?sheet:null;},
    querySelectorAll(){return [];}};
  function flush(){let executed=0;while(pending.size){assert.ok(executed++<25,'fitting must settle without an animation-frame loop');const [id,callback]=pending.entries().next().value;pending.delete(id);callback();}return executed;}
  function mutate(){for(const observer of mutationObservers)observer.callback([{type:'attributes',attributeName:'hidden',target:sheet}]);}
  function resize(){for(const observer of resizeObservers)observer.callback();}
  function fire(name){for(const callback of listeners.get(name)||[])callback();}
  return {doc,win,body,sheet,root,pending,resizeObservers,mutationObservers,flush,mutate,resize,fire,
    zoom:()=>Number(body.style.zoom||1),setPageHeight(value){pageHeight=value;},setModalOverflow(value){modalOverflow=value;},
    install(){connectFit(doc);}};
}

test('ordinary embedded content shrinks to fit and still respects the minimum scale',()=>{
  const h=harness();h.install();h.flush();assert.equal(h.zoom(),.8);assert.equal(h.root.style.getPropertyValue('--xhy-fit'),'0.8');
  assert.equal(h.root.style.getPropertyValue('overflow'),'hidden');assert.equal(h.body.style.getPropertyValue('overflow'),'visible');
  h.setPageHeight(3000);h.fire('resize');h.flush();assert.equal(h.zoom(),.7);
  h.setPageHeight(450);h.fire('resize');h.flush();assert.equal(h.zoom(),1);assert.equal(h.root.style.getPropertyValue('--xhy-fit'),'1');
});

test('opening the candle sheet restores full scale and overflowing overlays do not shrink it again',()=>{
  const h=harness();h.install();h.flush();assert.equal(h.zoom(),.8);
  h.sheet.hidden=false;h.mutate();h.flush();assert.equal(h.zoom(),1);assert.equal(h.root.style.getPropertyValue('--xhy-fit'),'1');
  h.setModalOverflow(6000);h.resize();h.mutate();h.flush();assert.equal(h.zoom(),1);assert.equal(h.pending.size,0);
});

test('closing the candle sheet resumes automatic fitting of the ordinary page',()=>{
  const h=harness();h.install();h.flush();h.sheet.hidden=false;h.mutate();h.flush();assert.equal(h.zoom(),1);
  h.sheet.hidden=true;h.mutate();h.flush();assert.equal(h.zoom(),.8);assert.equal(h.root.style.getPropertyValue('--xhy-fit'),'0.8');
  h.sheet.hidden=false;h.mutate();h.flush();assert.equal(h.zoom(),1,'reopening also exits a previously fitted page');
});

test('window resizes and fit resets preserve full scale while the candle sheet is open',()=>{
  const h=harness();h.sheet.hidden=false;h.install();h.flush();assert.equal(h.zoom(),1);
  h.win.innerHeight=320;h.fire('resize');h.flush();assert.equal(h.zoom(),1);
  h.win.__xhyFitReset();h.flush();assert.equal(h.zoom(),1);
  h.fire('hashchange');h.flush();assert.equal(h.zoom(),1);
  h.sheet.hidden=true;h.mutate();h.flush();assert.equal(h.zoom(),.7,'normal fitting resumes against the smaller viewport');
});

test('standalone documents and documents without a body do not install embedded fitting',()=>{
  for(const options of [{embedded:false},{bodyPresent:false}]){
    const h=harness(options);h.install();assert.equal(h.win.__xhyFit,undefined);assert.equal(h.pending.size,0);assert.equal(h.resizeObservers.length,0);assert.equal(h.mutationObservers.length,0);assert.equal(h.body.style.zoom,undefined);
  }
});

test('installing the controller twice leaves only one pair of observers',()=>{
  const h=harness();h.install();h.install();h.flush();assert.equal(h.resizeObservers.length,1);assert.equal(h.mutationObservers.length,1);assert.equal(h.zoom(),.8);
});
