import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { validateSnapshot, buildHistory } from './core.mjs';

const html = readFileSync(new URL('./wallet.html', import.meta.url), 'utf8');
const snapshot = JSON.parse(/<script id="snapshot" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .find(match => !match[0].includes('application/json'))[1];

class Element {
  constructor(dataset = {}) {
    this.dataset = dataset; this.style = {}; this.listeners = {}; this.attributes = {};
    this.textContent = ''; this.innerHTML = ''; this.value = ''; this.hidden = false;
    this.clientWidth = 1024; this.clientHeight = 345; this.offsetWidth = 220;
  }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  removeAttribute(key) { delete this.attributes[key]; }
  hasAttribute(key) { return Object.hasOwn(this.attributes, key); }
  getBoundingClientRect() { return { width: this.clientWidth, height: this.clientHeight, left: 0 }; }
  async emit(type, event = {}) { return this.listeners[type]?.(event); }
}

function mount(protocol = 'http:', options = {}) {
  const html=options.sourceHtml??readFileSync(new URL('./wallet.html',import.meta.url),'utf8');
  const script=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].find(match=>!match[0].includes('application/json'))[1];
  const embeddedSnapshot=JSON.parse(/<script id="snapshot" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  for (const id of ['crosshair', 'cross-line', 'cross-dot']) elements.set(id, new Element());
  elements.get('snapshot').textContent = JSON.stringify(embeddedSnapshot);
  const modes = ['cny', 'usd', 'btc'].map(mode => new Element({ mode }));
  const ranges = ['30', '90', 'all'].map(range => new Element({ range }));
  const main = new Element(); main.clientHeight = 900;
  const root = new Element();
  if (options.privateEmbed) root.setAttribute('data-private-embed', '');
  const documentListeners = new Map(), rootListeners=new Map(), blobs = [], downloads = [], urls = new Map(), revoked = [], clones = [], timers = new Map();
  let timerNow = 0, nextTimer = 0;
  root.cloneNode = deep => {
    assert.equal(deep, true);
    const cloned = new Map([...elements].map(([id, element]) => {
      const copy = new Element({...element.dataset});
      Object.assign(copy, {textContent:element.textContent,innerHTML:element.innerHTML,hidden:element.hidden,disabled:element.disabled});
      copy.attributes = {...element.attributes};
      return [id, copy];
    }));
    const clone = new Element({...root.dataset});
    clone.attributes = {...root.attributes};
    clone.querySelector = selector => {
      const id = selector.replace(/^#/, '');
      assert.ok(cloned.has(id), `Unknown cloned export element ${selector}`);
      return cloned.get(id);
    };
    Object.defineProperty(clone, 'outerHTML', {get() {
      let output = html.replace(/<html\b[^>]*>/, original => {
        const attributes = [...Object.entries(clone.attributes),...Object.entries(clone.dataset).map(([key,value]) => ['data-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()),value])];
        return original.slice(0,-1) + attributes.map(([key,value]) => ' ' + key + '="' + String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;') + '"').join('') + '>';
      }).replace(/(<script id="snapshot" type="application\/json">)[\s\S]*?(<\/script>)/, (_,start,end) => start + cloned.get('snapshot').textContent + end);
      for (const id of ['tooltip','toast','refresh']) {
        output = output.replace(new RegExp('<[^>]+id="' + id + '"[^>]*>'), original => {
          let tag = original.replace(/\s(?:hidden|disabled)(?:="[^"]*")?/g, '');
          if (cloned.get(id).hidden) tag = tag.slice(0,-1) + ' hidden>';
          if (cloned.get(id).disabled) tag = tag.slice(0,-1) + ' disabled>';
          return tag;
        });
      }
      return output;
    }});
    clones.push(clone);
    return clone;
  };
  class ExportBlob {
    constructor(parts, metadata) {this.parts=parts;this.type=metadata.type;blobs.push(this);}
    async text() {return this.parts.join('');}
  }
  class LocalURL extends URL {
    static createObjectURL(blob) {const value='blob:wallet-export-' + urls.size;urls.set(value,blob);return value;}
    static revokeObjectURL(value) {assert.ok(urls.has(value), 'Only a created local blob URL may be revoked');revoked.push(value);}
  }
  const document = {
    documentElement: root, hidden: false,
    getElementById(id) { assert.ok(elements.has(id), `Missing actual page element: ${id}`); return elements.get(id); },
    querySelector(selector) { assert.equal(selector, 'main'); return main; },
    querySelectorAll(selector) { return selector === '[data-mode]' ? modes : selector === '[data-range]' ? ranges : []; },
    addEventListener(type, handler) { documentListeners.set(type, handler); },
    createElement(tag) {assert.equal(tag,'a');return {click() {downloads.push({href:this.href,download:this.download});}};},
  };
  const rawTransactions = snapshot.transactions.map(tx => ({ txid: tx.txid, fee: tx.fee,
    status: { confirmed: true, block_time: tx.time, block_height: tx.height },
    vin: tx.spent ? [{ prevout: { scriptpubkey_address: snapshot.address, value: tx.spent } }] : [],
    vout: tx.received ? [{ scriptpubkey_address: snapshot.address, value: tx.received }] : [],
  })).reverse();
  const requests = [], messages = [], observers = [], frames = [], cache = new Map(), storageCalls = [], resourceOverrides = new Map(), intervals = [], pendingBodies = new Map();
  if (options.cachedSnapshot) cache.set('bitcoin-balance-v1-' + snapshot.address, JSON.stringify(options.cachedSnapshot));
  let failSummary = false;
  let clockNow=Date.parse(snapshot.fetchedAt)+120000;
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [TestDate.now()])); }
    static now() { return clockNow; }
  }
  const sandbox = {
    document, location: { protocol, origin: protocol === 'file:' ? 'null' : 'http://127.0.0.1:8765' },
    Date: TestDate, Intl, URL: LocalURL, URLSearchParams, AbortController, Blob: ExportBlob,
    localStorage: { getItem: key => {storageCalls.push({kind:'read',key});if(options.storageBlocked)throw new Error('Storage blocked');return cache.get(key) ?? null;}, setItem: (key, value) => {storageCalls.push({kind:'write',key});if(options.storageBlocked)throw new Error('Storage blocked');cache.set(key, value);} },
    navigator: { clipboard: { async writeText() {} } },
    setTimeout(callback,delay) {const id=++nextTimer;timers.set(id,{callback,at:timerNow+delay});return id;}, clearTimeout(id) {timers.delete(id);}, setInterval(callback,delay) {intervals.push({callback,delay});},
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
    ResizeObserver: class { constructor(fn) { observers.push(fn); this.fn = fn; } observe() { this.fn(); } },
    parent: { postMessage: (message, origin) => messages.push({ message, origin }) },
    addEventListener(type,callback) {if(!rootListeners.has(type))rootListeners.set(type,[]);rootListeners.get(type).push(callback);},
    async fetch(path) {
      requests.push(path);
      const url = new URL(path, 'http://127.0.0.1:8765');
      const resource = url.searchParams.get('resource');
      let data;
      if (resource === 'address' || url.pathname.includes('/api/address/') && !url.pathname.includes('/txs/')) {
        if (failSummary) return { ok: false, status: 503 };
        data = snapshot.summary;
      } else if (resource === 'transactions' || url.pathname.includes('/txs/chain')) data = rawTransactions;
      else if (resource === 'history' || url.pathname.endsWith('/historical-price')) data = { prices: snapshot.prices };
      else if (resource === 'quote' || url.pathname.endsWith('/prices')) data = snapshot.quote;
      else if (resource === 'fx' || url.pathname.endsWith('/rates')) {
        data = snapshot.fx.rates.map(rate => ({ ...rate, base: 'USD', quote: 'CNY' }));
      } else throw new Error('Unexpected wallet fetch ' + path);
      if (resourceOverrides.has(resource)) data = resourceOverrides.get(resource);
      return { ok: true, status: 200, async json() { if(pendingBodies.has(resource))return pendingBodies.get(resource);return structuredClone(data); } };
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(script, sandbox);
  return { elements, modes, ranges, requests, messages, observers, main, storageCalls, output:{blobs,downloads,urls,revoked,clones},
    emitDocument(type, event) { return documentListeners.get(type)?.(event); },
    async emitRoot(type,event={}) {for(const callback of rootListeners.get(type)??[])callback(event);for(let i=0;i<6;i++)await new Promise(setImmediate);},
    failSummary(value) { failSummary = value; },
    overrideResource(resource, value) { if (value === undefined) resourceOverrides.delete(resource);else resourceOverrides.set(resource, value); },
    deferBody(resource) {let release;const result=new Promise(resolve=>{release=resolve;});pendingBodies.set(resource,result);return value=>{pendingBodies.delete(resource);release(structuredClone(value));};},
    flushFrames() { while (frames.length) frames.shift()(); },
    advanceClock(elapsed) {clockNow+=elapsed;},
    setHidden(hidden) {document.hidden=hidden;},
    async runIntervals() {for(const interval of intervals)interval.callback();for(let i=0;i<6;i++)await new Promise(setImmediate);},
    runTimers(elapsed) {timerNow+=elapsed;for(const [id,timer] of [...timers].sort((a,b)=>a[1].at-b[1].at)){if(timer.at<=timerNow&&timers.delete(id))timer.callback();}},
  };
}

test('wallet renders real confirmed holdings and switches currency, period and curve without losing amounts', async () => {
  const view = mount();
  const balance = (snapshot.summary.chain_stats.funded_txo_sum - snapshot.summary.chain_stats.spent_txo_sum) / 1e8;
  assert.match(view.elements.get('total-btc').innerHTML, new RegExp(balance.toFixed(8).replace('.', '\\.')));
  assert.match(view.elements.get('quote-currency').textContent, /CNY/);
  assert.ok(view.elements.get('chart').innerHTML.includes('<path'));
  await view.modes[1].emit('click');
  assert.equal(view.elements.get('quote-currency').textContent, 'BTC / USD');
  assert.match(view.elements.get('total-usd').textContent, /\$/);
  await view.modes[2].emit('click');
  assert.equal(view.elements.get('chart-title').textContent, '比特币数量走势');
  assert.equal(view.elements.get('quote-currency').textContent, 'BTC / USD');
  view.elements.get('pnl-period').value = '7';
  await view.elements.get('pnl-period').emit('change');
  assert.equal(view.elements.get('pnl-label').textContent, '近一周盈亏');
  await view.ranges[0].emit('click');
  assert.match(view.elements.get('chart-period').textContent, /BTC · UTC$/);
});

test('wallet refresh uses only fixed local proxy resources and preserves valid data through failure then recovers', async () => {
  const view = mount();
  const originalBalance = view.elements.get('total-btc').innerHTML;
  view.failSummary(true);
  await view.elements.get('refresh').emit('click');
  assert.equal(view.elements.get('total-btc').innerHTML, originalBalance);
  assert.equal(view.elements.get('status-text').dataset.state, 'error');
  assert.equal(view.elements.get('refresh').disabled, false);
  view.failSummary(false);
  await view.elements.get('refresh').emit('click');
  assert.match(view.elements.get('status-text').textContent, /^已同步/);
  assert.equal(view.elements.get('total-btc').innerHTML, originalBalance);
  assert.ok(view.requests.every(path => path.startsWith('/api/wallet/proxy?')));
  assert.deepEqual([...new Set(view.requests.map(path => new URL(path, 'http://localhost').searchParams.get('resource')))].sort(),
    ['address', 'fx', 'history', 'quote', 'transactions']);
  for (const path of view.requests) {
    const params = new URL(path, 'http://localhost').searchParams;
    if (['address', 'transactions'].includes(params.get('resource'))) assert.equal(params.get('address'), snapshot.address);
  }
});

test('wallet reports content height only to its own origin and file exports retain provider access', async () => {
  const view = mount();
  view.flushFrames();
  assert.equal(view.messages.length, 1);
  assert.equal(view.messages[0].origin, 'http://127.0.0.1:8765');
  assert.equal(view.messages[0].message.type, 'wallet-height');
  assert.equal(view.messages[0].message.height, 902);
  view.main.clientHeight = 700;
  view.observers.at(-1)(); view.flushFrames();
  assert.equal(view.messages.at(-1).message.height, 702);
  const exported = mount('file:');
  await exported.elements.get('refresh').emit('click');
  assert.ok(exported.requests.every(path => /^https:\/\/(mempool\.space|api\.frankfurter\.dev)\//.test(path)));
  exported.flushFrames(); assert.equal(exported.messages.length, 0);
});

test('Escape from an embedded wallet reaches only its own origin and leaves file exports independent', () => {
  const view = mount();
  view.emitDocument('keydown', { key: 'Enter' });
  assert.equal(view.messages.length, 0);
  view.emitDocument('keydown', { key: 'Escape' });
  assert.equal(view.messages.length, 1);
  assert.equal(view.messages[0].message.type, 'wallet-escape');
  assert.equal(view.messages[0].origin, 'http://127.0.0.1:8765');
  const exported = mount('file:');
  exported.emitDocument('keydown', { key: 'Escape' });
  assert.equal(exported.messages.length, 0);
});

test('private embedded wallets never read or store wallet snapshots and period preferences in browser storage', async () => {
  const view = mount('http:', {privateEmbed:true});
  view.elements.get('pnl-period').value = '30';
  await view.elements.get('pnl-period').emit('change');
  await view.elements.get('refresh').emit('click');
  assert.match(view.elements.get('status-text').textContent, /^已同步/);
  assert.equal(view.elements.get('pnl-label').textContent, '近一个月盈亏');
  assert.deepEqual(view.storageCalls, []);
});

test('incomplete or foreign address refreshes never replace a reconciled wallet and remain recoverable', async () => {
  const view = mount();
  const originalBalance = view.elements.get('total-btc').innerHTML;
  const originalChart = view.elements.get('chart').innerHTML;
  view.overrideResource('address', {...snapshot.summary,address:'different-address'});
  await view.elements.get('refresh').emit('click');
  assert.equal(view.elements.get('status-text').dataset.state, 'error');
  assert.equal(view.elements.get('total-btc').innerHTML, originalBalance);
  assert.equal(view.elements.get('chart').innerHTML, originalChart);
  view.overrideResource('address', undefined);
  view.overrideResource('transactions', []);
  await view.elements.get('refresh').emit('click');
  assert.equal(view.elements.get('status-text').dataset.state, 'error');
  assert.equal(view.elements.get('total-btc').innerHTML, originalBalance);
  view.overrideResource('transactions', undefined);
  await view.elements.get('refresh').emit('click');
  assert.match(view.elements.get('status-text').textContent, /^已同步/);
  assert.equal(view.elements.get('refresh').disabled, false);
});

test('future or duplicated prices reject the entire refresh while retaining actual holdings and valuation', async () => {
  const view = mount();
  const originalBalance = view.elements.get('total-btc').innerHTML;
  const originalValue = view.elements.get('total-usd').textContent;
  view.overrideResource('quote', {time:Math.floor(Date.parse(snapshot.fetchedAt)/1000)+3600,USD:1});
  await view.elements.get('refresh').emit('click');
  assert.equal(view.elements.get('status-text').dataset.state, 'error');
  assert.equal(view.elements.get('total-btc').innerHTML, originalBalance);
  assert.equal(view.elements.get('total-usd').textContent, originalValue);
  view.overrideResource('quote', undefined);
  view.overrideResource('history', {prices:[...snapshot.prices,snapshot.prices.at(-1)]});
  await view.elements.get('refresh').emit('click');
  assert.equal(view.elements.get('status-text').dataset.state, 'error');
  assert.equal(view.elements.get('total-usd').textContent, originalValue);
  assert.equal(view.elements.get('refresh').disabled, false);
});

test('a newer cached snapshot from a different wallet is ignored before it can change the displayed address', () => {
  const cachedSnapshot = structuredClone(snapshot);
  cachedSnapshot.fetchedAt = new Date(Date.parse(snapshot.fetchedAt)+60000).toISOString();
  cachedSnapshot.address = 'another-address';cachedSnapshot.summary.address = 'another-address';
  const view = mount('http:', {cachedSnapshot});
  assert.equal(view.elements.get('address-link').textContent, snapshot.address);
  const balance = (snapshot.summary.chain_stats.funded_txo_sum-snapshot.summary.chain_stats.spent_txo_sum)/1e8;
  assert.match(view.elements.get('total-btc').innerHTML, new RegExp(balance.toFixed(8).replace('.', '\\.')));
  assert.match(view.elements.get('status-text').textContent, /^内置快照/);
});

test('real export handler creates only a local HTML file with the latest validated data, clean controls and deferred blob cleanup', async () => {
  const view = mount();
  const latestQuote = {...snapshot.quote,USD:snapshot.quote.USD+123};
  view.overrideResource('quote',latestQuote);
  await view.elements.get('refresh').emit('click');
  const requestsBeforeExport=view.requests.length;
  view.elements.get('tooltip').hidden=false;view.elements.get('toast').hidden=false;view.elements.get('refresh').disabled=true;
  await view.elements.get('save').emit('click');
  assert.equal(view.output.downloads.length,1);assert.equal(view.output.blobs.length,1);assert.equal(view.requests.length,requestsBeforeExport);
  const blob=view.output.blobs[0],download=view.output.downloads[0];
  assert.equal(blob.type,'text/html;charset=utf-8');assert.match(download.href,/^blob:wallet-export-/);
  assert.match(download.download,/^bitcoin-balance-\d{4}-\d{2}-\d{2}\.html$/);assert.equal(view.output.urls.get(download.href),blob);
  const exportedHtml=await blob.text();assert.match(exportedHtml,/^<!doctype html>\n/);
  const exportedSnapshot=JSON.parse(/<script id="snapshot" type="application\/json">([\s\S]*?)<\/script>/.exec(exportedHtml)[1]);
  validateSnapshot(exportedSnapshot,snapshot.address);
  assert.deepEqual(exportedSnapshot.quote,latestQuote);assert.ok(Date.parse(exportedSnapshot.fetchedAt)>Date.parse(snapshot.fetchedAt));
  const replay=buildHistory(exportedSnapshot,snapshot.address);assert.equal(replay.balanceSats,snapshot.summary.chain_stats.funded_txo_sum-snapshot.summary.chain_stats.spent_txo_sum);
  assert.ok(/<[^>]+id="tooltip"[^>]*\bhidden\b/.test(exportedHtml));assert.ok(/<[^>]+id="toast"[^>]*\bhidden\b/.test(exportedHtml));
  assert.ok(!/<[^>]+id="refresh"[^>]*\bdisabled\b/.test(exportedHtml));assert.ok(!/<html\b[^>]*data-private-embed/.test(exportedHtml));
  assert.equal(view.elements.get('tooltip').hidden,false);assert.equal(view.elements.get('refresh').disabled,true);
  assert.match(view.elements.get('toast').textContent,/已保存/);assert.deepEqual(view.output.revoked,[]);
  view.runTimers(999);assert.deepEqual(view.output.revoked,[]);view.runTimers(1);assert.deepEqual(view.output.revoked,[download.href]);
  view.runTimers(2000);assert.equal(view.elements.get('toast').hidden,true);
});

test('a failed refresh export retains the last reconciled snapshot, escapes script delimiters and keeps isolated embeds isolated', async () => {
  const cachedSnapshot=structuredClone(snapshot);
  cachedSnapshot.fetchedAt=new Date(Date.parse(snapshot.fetchedAt)+60000).toISOString();
  cachedSnapshot.sources={...cachedSnapshot.sources,note:'</script><script>unexpected()</script>'};
  const view=mount('http:',{cachedSnapshot});view.failSummary(true);
  await view.elements.get('refresh').emit('click');assert.equal(view.elements.get('status-text').dataset.state,'error');
  await view.elements.get('save').emit('click');
  const text=await view.output.blobs[0].text(),encoded=/<script id="snapshot" type="application\/json">([\s\S]*?)<\/script>/.exec(text)[1];
  assert.ok(!encoded.includes('<'));const data=JSON.parse(encoded);validateSnapshot(data,snapshot.address);
  assert.equal(data.fetchedAt,cachedSnapshot.fetchedAt);assert.equal(data.sources.note,cachedSnapshot.sources.note);
  const isolated=mount('http:',{privateEmbed:true});await isolated.elements.get('save').emit('click');
  assert.match(await isolated.output.blobs[0].text(),/<html\b[^>]*data-private-embed/);
  assert.deepEqual(isolated.storageCalls,[]);
});

test('a same-day wallet refreshes automatically after five minutes and resumes a due refresh when visible', async () => {
  const view=mount();assert.equal(view.requests.length,0);
  view.advanceClock(3*60000-1);await view.runIntervals();assert.equal(view.requests.length,0);
  view.advanceClock(1);await view.runIntervals();assert.match(view.elements.get('status-text').textContent,/^已同步/);
  const firstCount=view.requests.length;assert.ok(firstCount>0);
  view.advanceClock(5*60000);view.setHidden(true);await view.runIntervals();assert.equal(view.requests.length,firstCount);
  view.setHidden(false);await view.emitDocument('visibilitychange');for(let i=0;i<6;i++)await new Promise(setImmediate);
  assert.ok(view.requests.length>firstCount);assert.match(view.elements.get('status-text').textContent,/^已同步/);
});

test('automatic refresh backs off after failure and recovers without replacing valid holdings', async () => {
  const view=mount();const original=view.elements.get('total-btc').innerHTML;view.failSummary(true);
  await view.elements.get('refresh').emit('click');assert.match(view.elements.get('status-text').textContent,/将自动重试/);
  const firstCount=view.requests.length;view.advanceClock(29999);await view.runIntervals();assert.equal(view.requests.length,firstCount);
  view.advanceClock(1);await view.runIntervals();assert.ok(view.requests.length>firstCount);assert.equal(view.elements.get('total-btc').innerHTML,original);
  const secondCount=view.requests.length;view.failSummary(false);view.advanceClock(59999);await view.runIntervals();assert.equal(view.requests.length,secondCount);
  view.advanceClock(1);await view.runIntervals();assert.ok(view.requests.length>secondCount);assert.match(view.elements.get('status-text').textContent,/^已同步/);
  assert.equal(view.elements.get('refresh').disabled,false);assert.equal(view.elements.get('total-btc').innerHTML,original);
});

test('blocked browser storage does not prevent valuation, period changes or future refreshes', async () => {
  const view=mount('http:',{storageBlocked:true});const original=view.elements.get('total-btc').innerHTML;
  view.elements.get('pnl-period').value='30';await view.elements.get('pnl-period').emit('change');
  await view.elements.get('refresh').emit('click');assert.equal(view.elements.get('total-btc').innerHTML,original);
  assert.match(view.elements.get('status-text').textContent,/已同步.*本地缓存不可用/);assert.equal(view.elements.get('refresh').disabled,false);
  view.advanceClock(5*60000);await view.runIntervals();assert.match(view.elements.get('status-text').textContent,/已同步.*本地缓存不可用/);
});

test('a malformed newer FX cache is discarded without breaking the original wallet', () => {
  const cachedSnapshot=structuredClone(snapshot);cachedSnapshot.fetchedAt=new Date(Date.parse(snapshot.fetchedAt)+60000).toISOString();
  cachedSnapshot.fx={rates:[{date:'2026-02-30',rate:7}]};const view=mount('http:',{cachedSnapshot});
  assert.match(view.elements.get('status-text').textContent,/^内置快照/);assert.notEqual(view.elements.get('total-usd').textContent,'—');
});

test('a failed refresh cancels delayed pagination before it can overwrite the failure state or start more requests', async () => {
  const view=mount(),release=view.deferBody('transactions');view.failSummary(true);
  await view.elements.get('refresh').emit('click');assert.equal(view.elements.get('status-text').dataset.state,'error');
  const requestsAfterFailure=view.requests.length,status=view.elements.get('status-text').textContent;
  release(Array.from({length:25},(_,i)=>({txid:i.toString(16).padStart(64,'0')})));
  for(let i=0;i<6;i++)await new Promise(setImmediate);
  assert.equal(view.elements.get('status-text').textContent,status);
  assert.equal(view.requests.length,requestsAfterFailure);
});

test('a hung JSON body times out and its late result cannot replace a later recovered wallet', async () => {
  const view=mount(),release=view.deferBody('quote'),original=view.elements.get('total-usd').textContent;
  const pending=view.elements.get('refresh').emit('click');for(let i=0;i<6;i++)await new Promise(setImmediate);
  assert.equal(view.elements.get('refresh').disabled,true);view.runTimers(22000);await pending;
  assert.equal(view.elements.get('refresh').disabled,false);assert.equal(view.elements.get('status-text').dataset.state,'error');
  assert.equal(view.elements.get('total-usd').textContent,original);
  release({...snapshot.quote,USD:1});const fresh={...snapshot.quote,USD:snapshot.quote.USD+321};view.overrideResource('quote',fresh);
  await view.elements.get('refresh').emit('click');await view.elements.get('save').emit('click');
  const exported=await view.output.blobs.at(-1).text(),data=JSON.parse(/<script id="snapshot" type="application\/json">([\s\S]*?)<\/script>/.exec(exported)[1]);
  assert.deepEqual(data.quote,fresh);assert.match(view.elements.get('status-text').textContent,/^已同步/);
});

test('a failed wallet transaction retains its original FX and exported snapshot as one reconciled frame', async () => {
  const view=mount();view.failSummary(true);view.overrideResource('fx',snapshot.fx.rates.map(rate=>({...rate,rate:rate.rate+1,base:'USD',quote:'CNY'})));
  await view.elements.get('refresh').emit('click');await view.elements.get('save').emit('click');
  const exported=await view.output.blobs.at(-1).text(),data=JSON.parse(/<script id="snapshot" type="application\/json">([\s\S]*?)<\/script>/.exec(exported)[1]);
  assert.deepEqual(data.fx,snapshot.fx);assert.equal(data.fetchedAt,snapshot.fetchedAt);validateSnapshot(data,snapshot.address);
  const reopened=mount('file:',{sourceHtml:exported});assert.equal(reopened.elements.get('total-usd').textContent,view.elements.get('total-usd').textContent);
  assert.match(reopened.elements.get('status-text').textContent,/^内置快照/);
});

test('pagehide cancels a pending wallet refresh and backcache restoration resumes without accepting the abandoned body', async () => {
  const view=mount(),release=view.deferBody('quote');const pending=view.elements.get('refresh').emit('click');
  for(let i=0;i<6;i++)await new Promise(setImmediate);await view.emitRoot('pagehide',{persisted:true});await pending;
  assert.equal(view.elements.get('refresh').disabled,false);assert.match(view.elements.get('status-text').textContent,/同步已暂停/);
  const count=view.requests.length;view.advanceClock(10*60000);await view.runIntervals();assert.equal(view.requests.length,count);
  release({...snapshot.quote,USD:1});const fresh={...snapshot.quote,USD:snapshot.quote.USD+123};view.overrideResource('quote',fresh);
  await view.emitRoot('pageshow',{persisted:true});assert.match(view.elements.get('status-text').textContent,/^已同步/);
  assert.ok(view.requests.length>count);await view.elements.get('save').emit('click');
  const exported=await view.output.blobs.at(-1).text(),data=JSON.parse(/<script id="snapshot" type="application\/json">([\s\S]*?)<\/script>/.exec(exported)[1]);
  assert.deepEqual(data.quote,fresh);
});
