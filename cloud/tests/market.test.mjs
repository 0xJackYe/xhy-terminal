import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import { MARKET_SCHEMA, syncMarket, getMarketSnapshot, handleMarket, DEFAULT_MARKET_SETTINGS } from '../market.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const NOW = Date.parse('2026-10-27T02:00:00Z');
const DAY = 86400000, START = Date.parse('2026-10-26T16:00:00Z');

function environment() {
  const sqlite = new DatabaseSync(':memory:');
  const env = { DB: {
    prepare(sql) {
      return {
        sql, values: [],
        bind(...values) { this.values = values; return this; },
        async first(column) { const value = sqlite.prepare(this.sql).get(...this.values); return column ? value?.[column] : value ?? null; },
        async all() { return { success: true, results: sqlite.prepare(this.sql).all(...this.values) }; },
        async run() { const value = sqlite.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(value.changes) } }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } };
  for (const statement of MARKET_SCHEMA) sqlite.exec(statement);
  return { env, sqlite };
}
function marketFetch({ price = 106, high = Math.max(106, price), low = 99, time = NOW - 500, open = 100,
                        badDay = false, fail = false, calls = [] } = {}) {
  return async (address, init) => {
    const url = new URL(address); calls.push({ url, init });
    assert.equal(url.origin, 'https://data-api.binance.vision');
    assert.equal(init.method, 'GET');
    assert.equal(Object.keys(init.headers).some(key => /key|secret|authorization/i.test(key)), false);
    if (fail) return new Response('unavailable', { status: 503 });
    if (url.pathname.endsWith('/aggTrades')) return Response.json([{ a: 1, p: String(price), T: time }]);
    assert.equal(url.pathname, '/api/v3/klines');
    assert.equal(url.searchParams.get('timeZone'), '8');
    assert.equal(url.searchParams.get('startTime'), String(START));
    return Response.json([[badDay ? START + 28800000 : START, String(open), String(high), String(low), String(price), '1', START + DAY - 1]]);
  };
}
async function setKV(env, key, value, at = NOW) {
  await env.DB.prepare('INSERT OR REPLACE INTO market_kv(key,value,updated_ms) VALUES (?,?,?)').bind(key, JSON.stringify(value), at).run();
}
function post(path, value, extra = {}) {
  return new Request('https://xhy.example' + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Terminal-Request': '1', Origin: 'https://xhy.example', ...extra }, body: JSON.stringify(value) });
}

test('fresh public price uses actual trade time and Beijing daily baseline', async () => {
  const { env, sqlite } = environment(), calls = [];
  const result = await syncMarket(env, { now: NOW, fetch: marketFetch({ calls }) });
  assert.equal(result.market.day_start_ms, START);
  assert.equal(result.market.status, 'live');
  assert.equal(result.market.event_ms, NOW - 500);
  assert.equal(result.market.change_pct, 6);
  assert.equal(result.market.range_pct, 7);
  assert.equal(result.history[0].time_ms, START);
  assert.equal(result.history.at(-1).price, 106);
  assert.equal(calls.length, 2);
  assert.equal(result.server_time_ms, NOW);
  sqlite.close();
});

test('three up/down tiers fire once per Beijing day, metric and direction', async () => {
  const { env, sqlite } = environment();
  const first = await syncMarket(env, { now: NOW, fetch: marketFetch() });
  assert.equal(first.newAlerts.length, 3);
  assert.deepEqual(first.newAlerts.map(row => row.sound_level), [1, 2, 3]);
  const repeat = await syncMarket(env, { now: NOW + 6000, force: true, fetch: marketFetch({ time: NOW + 5500 }) });
  assert.equal(repeat.newAlerts.length, 0);
  const down = await syncMarket(env, { now: NOW + 12000, force: true, fetch: marketFetch({ price: 94, low: 94, time: NOW + 11500 }) });
  assert.equal(down.newAlerts.length, 3);
  assert(down.newAlerts.every(row => row.direction === 'down'));
  assert.equal(down.alerts.length, 6);
  sqlite.close();
});

test('imported fired keys and original UUID history prevent migration replay', async () => {
  const { env, sqlite } = environment();
  await setKV(env, 'triggered', [`${START}|daily_change|2.5|up`, `${START}|daily_change|5.0|up`]);
  const old = { id: 'original-uuid', kind: 'market', at_ms: NOW - 1000, threshold_pct: 3.5, metric: 'daily_change', direction: 'up' };
  await env.DB.prepare('INSERT INTO market_alerts(id,at_ms,event_json) VALUES (?,?,?)').bind(old.id, old.at_ms, JSON.stringify(old)).run();
  const result = await syncMarket(env, { now: NOW, fetch: marketFetch() });
  assert.equal(result.newAlerts.length, 0);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].id, 'original-uuid');
  sqlite.close();
});

test('disabled setting and expired prices never trigger market alerts', async () => {
  const { env, sqlite } = environment();
  await setKV(env, 'settings', { ...DEFAULT_MARKET_SETTINGS, enabled: false });
  assert.equal((await syncMarket(env, { now: NOW, fetch: marketFetch() })).newAlerts.length, 0);
  await setKV(env, 'settings', { ...DEFAULT_MARKET_SETTINGS });
  const old = await syncMarket(env, { now: NOW, force: true, fetch: marketFetch({ time: NOW - 20000 }) });
  assert.equal(old.market.status, 'stale');
  assert.equal(old.newAlerts.length, 0);
  sqlite.close();
});

test('wrong UTC daily candle cannot substitute for the Beijing day', async () => {
  const { env, sqlite } = environment();
  const result = await syncMarket(env, { now: NOW, fetch: marketFetch({ badDay: true }) });
  assert.equal(result.market.status, 'connecting');
  assert.equal(result.market.day_open, null);
  assert.equal(result.newAlerts.length, 0);
  sqlite.close();
});

test('provider outage preserves genuine previous values and marks them stale', async () => {
  const { env, sqlite } = environment();
  const first = await syncMarket(env, { now: NOW, fetch: marketFetch() });
  const failed = await syncMarket(env, { now: NOW + 6000, force: true, fetch: marketFetch({ fail: true }) });
  assert.equal(failed.market.price, first.market.price);
  assert.equal(failed.market.event_ms, first.market.event_ms);
  assert.equal(failed.market.status, 'reconnecting');
  assert.equal(failed.newAlerts.length, 0);
  assert.equal((await getMarketSnapshot(env, { now: NOW + 60000 })).market.status, 'reconnecting');
  sqlite.close();
});

test('same-isolate concurrent refreshes share one bounded provider read', async () => {
  const { env, sqlite } = environment(), calls = [];
  await Promise.all([syncMarket(env, { now: NOW, fetch: marketFetch({ calls }) }), syncMarket(env, { now: NOW, fetch: marketFetch({ calls }) })]);
  assert.equal(calls.length, 2);
  await syncMarket(env, { now: NOW + 1000, fetch: marketFetch({ calls }) });
  assert.equal(calls.length, 2);
  sqlite.close();
});

test('settings validate tier order, persist and survive a separate handler read', async () => {
  const { env, sqlite } = environment();
  let response = await handleMarket(post('/api/terminal/settings', { enabled: false, threshold_pct: 1, thresholds_pct: [1, 2, 3], metric: 'day_range' }), env, { marketOptions: { now: NOW } });
  assert.equal(response.status, 200);
  const read = await getMarketSnapshot(env, { now: NOW + 1 });
  assert.deepEqual(read.settings.thresholds_pct, [1, 2, 3]);
  assert.equal(read.settings.metric, 'day_range');
  assert.equal(read.settings.enabled, false);
  response = await handleMarket(post('/api/terminal/settings', { threshold_pct: 3, thresholds_pct: [3, 2] }), env);
  assert.equal(response.status, 400);
  assert.deepEqual((await getMarketSnapshot(env)).settings.thresholds_pct, [1, 2, 3]);
  sqlite.close();
});

test('cross-origin writes, unsupported operations and query injection are rejected', async () => {
  const { env, sqlite } = environment();
  assert.equal((await handleMarket(post('/api/terminal/settings', {}, { Origin: 'https://foreign.invalid' }), env)).status, 403);
  assert.equal((await handleMarket(new Request('https://xhy.example/api/terminal/settings'), env)).status, 405);
  assert.equal((await handleMarket(new Request('https://xhy.example/api/terminal?url=https://foreign.invalid'), env)).status, 400);
  assert.equal(await handleMarket(new Request('https://xhy.example/api/terminal/email'), env), null);
  sqlite.close();
});

test('test and silence affect browser-preview state without enqueueing real mail', async () => {
  const { env, sqlite } = environment();
  let mailCalls = 0;
  const context = { onMarketAlerts() { mailCalls++; }, marketOptions: { now: NOW } };
  const response = await handleMarket(post('/api/terminal/test', { sound_level: 2 }), env, context);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.alerts[0].kind, 'test');
  assert.equal(result.alerts[0].email_enqueued, false);
  assert.equal(result.alerts[0].sound_scope, 'browser');
  assert.equal(mailCalls, 0);
  const stop = await handleMarket(post('/api/terminal/silence', {}), env, context);
  assert.equal((await stop.json()).silenced_at_ms, NOW);
  assert.equal(mailCalls, 0);
  sqlite.close();
});

test('range metric evaluates daily high-low rather than the current price change', async () => {
  const { env, sqlite } = environment();
  await setKV(env, 'settings', { ...DEFAULT_MARKET_SETTINGS, metric: 'day_range' });
  const result = await syncMarket(env, { now: NOW, fetch: marketFetch({ price: 100, high: 104, low: 96 }) });
  assert.equal(result.market.change_pct, 0);
  assert.equal(result.market.range_pct, 8);
  assert.equal(result.newAlerts.length, 3);
  assert(result.newAlerts.every(row => row.direction === 'range'));
  sqlite.close();
});

test('SSE emits valid snapshot events and bounds frames below the free subrequest limit', async () => {
  const { env, sqlite } = environment(), calls = [], jobs = [];
  const response = await handleMarket(new Request('https://xhy.example/api/terminal/events'), env, {
    waitUntil(job) { jobs.push(job); },
    marketOptions: { now: NOW, fetch: marketFetch({ calls }), sleep: async () => {}, streamIntervalMs: 0 },
  });
  assert.match(response.headers.get('Content-Type'), /text\/event-stream/);
  const body = await response.text();
  await Promise.all(jobs);
  const frames = body.trim().split('\n\n');
  assert.equal(frames.length, 3);
  assert(frames.every(frame => frame.startsWith('event: snapshot\ndata: ')));
  for (const frame of frames) {
    const snapshot = JSON.parse(frame.slice(frame.indexOf('data: ') + 6));
    assert.equal(snapshot.market.price, 106);
    assert.equal(snapshot.market.status, 'live');
    assert.equal('newAlerts' in snapshot, false);
  }
  assert.equal(calls.length, 2);
  sqlite.close();
});

test('SSE ?view=market sends the quote, rules and newest alerts without the chart history', async () => {
  const { env, sqlite } = environment(), jobs = [];
  const insert = sqlite.prepare('INSERT INTO market_alerts(id,at_ms,event_json) VALUES (?,?,?)');
  for (let i = 1; i <= 10; i++) insert.run('old-' + i, NOW - i * 60000, JSON.stringify({ id: 'old-' + i, kind: 'threshold', at_ms: NOW - i * 60000 }));
  const response = await handleMarket(new Request('https://xhy.example/api/terminal/events?view=market'), env, {
    waitUntil(job) { jobs.push(job); },
    marketOptions: { now: NOW, fetch: marketFetch(), sleep: async () => {}, streamIntervalMs: 0 },
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  await Promise.all(jobs);
  const frames = body.trim().split('\n\n').map(frame => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)));
  assert.equal(frames.length, 3);
  const stored = await getMarketSnapshot(env, { now: NOW });
  for (const snapshot of frames) {
    assert.deepEqual(Object.keys(snapshot).sort(), ['alerts', 'instance_id', 'market', 'revision', 'server_time_ms', 'settings']);
    assert.equal(snapshot.market.price, 106);
    assert.equal(snapshot.market.status, 'live');
    assert.equal(snapshot.alerts.length, 8);
    assert(snapshot.alerts.every((alert, i) => !i || snapshot.alerts[i - 1].at_ms >= alert.at_ms));
  }
  assert.deepEqual(frames.at(-1).alerts, stored.alerts.slice(0, 8));
  for (const address of ['/api/terminal/events?view=full', '/api/terminal/events?view=market&x=1', '/api/terminal?view=market']) {
    assert.equal((await handleMarket(new Request('https://xhy.example' + address), env, {})).status, 400, address);
  }
  sqlite.close();
});

function fallbackFetch({calls=[],gcp=false,time=NOW-500,badDay=false,badInstrument=false,price=106,high=107,low=99}={}){
  return async(address,init)=>{
    const url=new URL(address);calls.push({url,init});
    assert.equal(init.method,'GET');assert.equal(init.headers['User-Agent'],'XHY-Terminal/1.0');
    assert.equal(Object.keys(init.headers).some(key=>/key|secret|authorization/i.test(key)),false);
    // Workers supports manual redirects; a 3xx response is rejected as !ok.
    assert.equal(init.redirect,'manual');
    const at=typeof time==='function'?time():time;
    if(url.origin==='https://data-api.binance.vision')return new Response('forbidden',{status:403});
    if(url.origin==='https://api-gcp.binance.com'){
      if(!gcp)return new Response('forbidden',{status:403});
      if(url.pathname==='/api/v3/aggTrades')return Response.json([{a:1,p:String(price),T:at}]);
      assert.equal(url.pathname,'/api/v3/klines');assert.equal(url.searchParams.get('timeZone'),'8');
      return Response.json([[START,'100',String(high),String(low),String(price),'1',START+DAY-1]]);
    }
    assert.equal(url.origin,'https://www.okx.com');assert.equal(url.searchParams.get('instId'),'BTC-USDT');
    if(url.pathname==='/api/v5/market/ticker')return Response.json({code:'0',data:[{instType:'SPOT',instId:badInstrument?'BTC-USDT-SWAP':'BTC-USDT',last:String(price),ts:String(at),open24h:'1',high24h:'900',low24h:'1'}]});
    assert.equal(url.pathname,'/api/v5/market/candles');assert.equal(url.searchParams.get('bar'),'1D');assert.equal(url.searchParams.get('limit'),'2');
    return Response.json({code:'0',data:[[String(badDay?START+28800000:START),'100',String(high),String(low),String(price),'1','1','1','0']]});
  };
}

test('a blocked public-only Binance host uses its official GCP endpoint before changing exchange source',async()=>{
  const {env,sqlite}=environment(),calls=[];
  const result=await syncMarket(env,{now:NOW,fetch:fallbackFetch({calls,gcp:true})});
  assert.equal(result.market.status,'live');assert.equal(result.market.source,'Binance Spot');
  assert.equal(result.market.provider_origin,'https://api-gcp.binance.com');assert.equal(result.market.event_ms,NOW-500);
  assert.equal(calls.length,4);assert.equal(calls.some(call=>call.url.origin==='https://www.okx.com'),false);
  assert.equal(result.newAlerts.length,3);sqlite.close();
});

test('two Binance 403 responses fall back to fresh OKX ticker and the exact Beijing daily candle, never rolling 24h statistics',async()=>{
  const {env,sqlite}=environment(),calls=[];
  const result=await syncMarket(env,{now:NOW,fetch:fallbackFetch({calls})});
  assert.equal(result.market.status,'live');assert.equal(result.market.source,'OKX Spot');
  assert.equal(result.market.price_source,'public ticker snapshot');assert.equal(result.market.event_ms,NOW-500);
  assert.equal(result.market.day_start_ms,START);assert.equal(result.market.day_open,100);
  assert.equal(result.market.day_high,107);assert.equal(result.market.day_low,99);
  assert.equal(result.market.change_pct,6);assert.equal(result.market.range_pct,8);
  assert.equal(calls.length,6);assert.equal(result.newAlerts.length,3);
  const repeat=await syncMarket(env,{now:NOW+6000,force:true,fetch:fallbackFetch({time:NOW+5500})});
  assert.equal(repeat.newAlerts.length,0);assert.equal(repeat.alerts.length,3);sqlite.close();
});

test('stale OKX ticker, a UTC daily candle or another instrument never fire fallback alerts',async()=>{
  for(const options of [{time:NOW-20000},{time:NOW+3000},{badDay:true},{badInstrument:true}]){
    const {env,sqlite}=environment();
    const result=await syncMarket(env,{now:NOW,fetch:fallbackFetch(options)});
    assert.notEqual(result.market.status,'live');assert.equal(result.newAlerts.length,0);
    if(options.time)assert.equal(result.market.status,'stale');
    else assert.equal(result.market.day_open,null);
    sqlite.close();
  }
});

test('changing fallback exchange retains daily threshold deduplication',async()=>{
  const {env,sqlite}=environment();
  const first=await syncMarket(env,{now:NOW,fetch:marketFetch()});assert.equal(first.newAlerts.length,3);
  const fallback=await syncMarket(env,{now:NOW+6000,force:true,fetch:fallbackFetch({time:NOW+5500})});
  assert.equal(fallback.market.source,'OKX Spot');assert.equal(fallback.newAlerts.length,0);assert.equal(fallback.alerts.length,3);
  sqlite.close();
});

test('three fully refreshed SSE frames with all fallback hosts stay within the free subrequest budget',async()=>{
  const {env,sqlite}=environment(),calls=[],jobs=[];let at=NOW,d1Calls=0,inBatch=false;
  const prepare=env.DB.prepare.bind(env.DB),batch=env.DB.batch.bind(env.DB);
  env.DB.prepare=sql=>{
    const statement=prepare(sql);
    for(const method of ['first','all','run']){
      const operation=statement[method].bind(statement);
      statement[method]=async(...args)=>{if(!inBatch)d1Calls++;return operation(...args);};
    }
    return statement;
  };
  env.DB.batch=async statements=>{d1Calls++;inBatch=true;try{return await batch(statements);}finally{inBatch=false;}};
  const response=await handleMarket(new Request('https://xhy.example/api/terminal/events'),env,{
    waitUntil(job){jobs.push(job);},
    marketOptions:{now:()=>at,fetch:fallbackFetch({calls,time:()=>at-500}),sleep:async()=>{at+=6000;},streamIntervalMs:0},
  });
  const body=await response.text();await Promise.all(jobs);
  assert.equal(body.trim().split('\n\n').length,3);assert.equal(calls.length,18);
  // Reserve one request for auth and four for the first alert's email outbox.
  assert(calls.length+d1Calls+5<=50,`HTTP ${calls.length} + D1 ${d1Calls} + auth/email reserve 5`);
  sqlite.close();
});

// A provider that serves the trade and daily candle, plus genuine 5-minute
// candles for today (closes follow a visible wave, not a straight line).
function curveFetch({ trade = () => ({ price: 106, time: NOW - 500 }), calls = [], binanceCandles = true, okxCandles = true } = {}) {
  const wave = i => (100 + 5 * Math.sin(i / 6)).toFixed(2);
  return async (address) => {
    const url = new URL(address); calls.push(url);
    if (url.origin === 'https://www.okx.com') {
      if (!okxCandles || url.searchParams.get('bar') !== '5m') return new Response('blocked', { status: 403 });
      const rows = [];
      for (let open = START; open <= NOW; open += 300000) rows.unshift([String(open), '100', '106', '94', wave((open - START) / 300000), '1', '1', '1', open + 300000 <= NOW ? '1' : '0']);
      return Response.json({ code: '0', data: rows.slice(0, 300) });
    }
    if (url.origin !== 'https://data-api.binance.vision') return new Response('blocked', { status: 403 });
    if (url.pathname === '/api/v3/aggTrades') { const { price, time } = trade(); return Response.json([{ a: 1, p: String(price), T: time }]); }
    if (url.searchParams.get('interval') === '1d') return Response.json([[START, '100', '110', '90', '106', '1', START + DAY - 1]]);
    assert.equal(url.searchParams.get('interval'), '5m'); assert.equal(url.searchParams.get('startTime'), String(START));
    if (!binanceCandles) return new Response('unavailable', { status: 503 });
    const rows = [];
    for (let open = START; open <= NOW; open += 300000) rows.push([open, '100', '106', '94', wave((open - START) / 300000), '1', open + 300000 - 1]);
    return Response.json(rows);
  };
}
const distinctPrices = history => new Set(history.map(row => row.price)).size;

test('a late or stale observation never erases newer samples from today\'s curve', async () => {
  const { env, sqlite } = environment();
  const at = [NOW - 30 * 60000, NOW - 20 * 60000, NOW - 10 * 60000], prices = [101, 103, 99];
  for (let i = 0; i < 3; i++) await syncMarket(env, { now: at[i], force: true, fetch: marketFetch({ price: prices[i], time: at[i] - 500 }) });
  // Every source now returns a trade 25 minutes old (a cached or lagging feed).
  const stale = await syncMarket(env, { now: NOW, force: true, fetch: marketFetch({ price: 104, time: NOW - 25 * 60000 }) });
  assert.equal(stale.market.status, 'stale');
  const history = (await getMarketSnapshot(env, { now: NOW })).history;
  for (let i = 0; i < 3; i++) assert.ok(history.some(row => row.time_ms === at[i] - 500 && row.price === prices[i]), 'kept sample ' + i);
  assert.ok(history.some(row => row.time_ms === NOW - 25 * 60000 && row.price === 104), 'the late point fills only its own minute');
  assert.deepEqual(history.map(row => row.time_ms), [...history.map(row => row.time_ms)].sort((a, b) => a - b));
  sqlite.close();
});

test('missing parts of today are filled from genuine 5-minute candles on cron and page loads, at most every five minutes', async () => {
  const { env, sqlite } = environment(), calls = [];
  // Ten hours into the Beijing day with no stored samples: before the fix the
  // chart was a straight line from the 00:00 open to the current price.
  const first = await syncMarket(env, { now: NOW, backfill: true, fetch: curveFetch({ calls }) });
  assert.ok(first.history.length > 100, 'one point per five minutes since 00:00');
  assert.ok(distinctPrices(first.history) > 20, 'the curve follows the real candles');
  assert.equal(first.history[0].time_ms, START);assert.equal(first.history.at(-1).price, 106);
  assert.ok(first.history.every((row, i) => !i || row.time_ms - first.history[i - 1].time_ms <= 10 * 60000), 'no gap is left');
  assert.equal(calls.filter(url => url.searchParams.get('interval') === '5m').length, 1);
  // A new live sample keeps its minute; no candle request while there is no gap.
  await syncMarket(env, { now: NOW + 60000, force: true, backfill: true, fetch: curveFetch({ calls, trade: () => ({ price: 107, time: NOW + 59500 }) }) });
  assert.equal(calls.filter(url => url.searchParams.get('interval') === '5m').length, 1);
  const latest = (await getMarketSnapshot(env, { now: NOW + 60000 })).history;
  assert.equal(latest.at(-1).price, 107);assert.ok(latest.length > 100);
  // Stream frames never request candles.
  const { env: streamEnv, sqlite: streamDb } = environment(), streamCalls = [];
  await syncMarket(streamEnv, { now: NOW, fetch: curveFetch({ calls: streamCalls }) });
  assert.equal(streamCalls.filter(url => url.searchParams.get('interval') === '5m').length, 0);
  streamDb.close();
  sqlite.close();
});

test('candle backfill falls back to OKX, is throttled after a failure, and the page load triggers it', async () => {
  const { env, sqlite } = environment(), calls = [];
  const response = await handleMarket(new Request('https://xhy.example/api/terminal'), env, { marketOptions: { now: NOW, fetch: curveFetch({ calls, binanceCandles: false }) } });
  const body = await response.json();
  assert.ok(body.history.length > 100 && distinctPrices(body.history) > 20, 'OKX 5-minute candles fill the day');
  // When every candle source fails, the next attempt waits five minutes.
  const { env: down, sqlite: downDb } = environment(), tries = [];
  await syncMarket(down, { now: NOW, backfill: true, fetch: curveFetch({ calls: tries, binanceCandles: false, okxCandles: false }) });
  await syncMarket(down, { now: NOW + 60000, force: true, backfill: true, fetch: curveFetch({ calls: tries, binanceCandles: false, okxCandles: false }) });
  assert.equal(tries.filter(url => url.searchParams.get('bar') === '5m').length, 1);
  await syncMarket(down, { now: NOW + 6 * 60000, force: true, backfill: true, fetch: curveFetch({ calls: tries, binanceCandles: false, okxCandles: false }) });
  assert.equal(tries.filter(url => url.searchParams.get('bar') === '5m').length, 2);
  downDb.close();sqlite.close();
});
