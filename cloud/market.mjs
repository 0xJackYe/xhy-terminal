/** Public BTC market monitoring for Cloudflare. No account/trading endpoints. */
export const MARKET_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS market_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_ms INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS market_alerts (id TEXT PRIMARY KEY, at_ms INTEGER NOT NULL, event_json TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS market_alerts_at ON market_alerts(at_ms)',
];

export const DEFAULT_MARKET_SETTINGS = Object.freeze({
  enabled: true, threshold_pct: 2.5, thresholds_pct: Object.freeze([2.5, 3.5, 5]),
  metric: 'daily_change', sound: true,
});
const BINANCE_ORIGINS = ['https://data-api.binance.vision','https://api-gcp.binance.com'];
const OKX_ORIGIN = 'https://www.okx.com';
const DAY = 86400000, BEIJING = 28800000, FRESH_MS = 10000, REFRESH_MS = 5000;
const pending = new WeakMap();
const clone = value => JSON.parse(JSON.stringify(value));
const nowOf = options => typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
const dayStart = at => Math.floor((at + BEIJING) / DAY) * DAY - BEIJING;
const positive = value => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value) || value.length > 80) throw new Error('invalid-market');
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error('invalid-market');
  return result;
};
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
const failure = (message, status = 503) => json({ error: message }, status);

async function readKV(env, key) {
  const row = await env.DB.prepare('SELECT value, updated_ms FROM market_kv WHERE key = ?').bind(key).first();
  if (!row) return null;
  try { return { value: JSON.parse(row.value), serialized: row.value, updated_ms: row.updated_ms }; }
  catch { return null; }
}
function writeKV(env, key, value, at) {
  return env.DB.prepare('INSERT INTO market_kv(key,value,updated_ms) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_ms=excluded.updated_ms')
    .bind(key, JSON.stringify(value), at);
}
function cleanSettings(raw, previous = DEFAULT_MARKET_SETTINGS, strict = false) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid-settings');
  const allowed = ['enabled', 'sound', 'threshold_pct', 'thresholds_pct', 'metric'];
  if (strict && Object.keys(raw).some(key => !allowed.includes(key))) throw new Error('invalid-settings');
  const result = { enabled: previous.enabled, sound: previous.sound, threshold_pct: previous.threshold_pct,
    thresholds_pct: [...previous.thresholds_pct], metric: previous.metric };
  for (const key of ['enabled', 'sound']) if (key in raw) {
    if (typeof raw[key] !== 'boolean') throw new Error('invalid-settings');
    result[key] = raw[key];
  }
  if ('metric' in raw) {
    if (!['daily_change', 'day_range'].includes(raw.metric)) throw new Error('invalid-settings');
    result.metric = raw.metric;
  }
  if ('thresholds_pct' in raw) {
    if (!Array.isArray(raw.thresholds_pct) || !raw.thresholds_pct.length || raw.thresholds_pct.length > 3) throw new Error('invalid-settings');
    const values = raw.thresholds_pct;
    if (values.some((v, i) => typeof v !== 'number' || !Number.isFinite(v) || v < .1 || v > 50 || i && v <= values[i - 1])) throw new Error('invalid-settings');
    if ('threshold_pct' in raw && raw.threshold_pct !== values[0]) throw new Error('invalid-settings');
    result.thresholds_pct = [...values]; result.threshold_pct = values[0];
  } else if ('threshold_pct' in raw) {
    if (typeof raw.threshold_pct !== 'number' || !Number.isFinite(raw.threshold_pct) || raw.threshold_pct < .1 || raw.threshold_pct > 50) throw new Error('invalid-settings');
    result.threshold_pct = raw.threshold_pct; result.thresholds_pct = [raw.threshold_pct];
  }
  return result;
}
async function settings(env) {
  const stored = await readKV(env, 'settings');
  let value;
  try { value = cleanSettings(stored?.value ?? {}); }
  catch { value = clone(DEFAULT_MARKET_SETTINGS); }
  return { value, stored };
}
function emptyRuntime(now) {
  return { revision: 0, instance_id: 'cloud-market-v1', last_sync_ms: 0, history: [],
    market: { symbol: 'BTCUSDT', source: 'Binance Spot', price_source: 'public aggregate trade', timezone: 'Asia/Shanghai',
      price: null, day_start_ms: dayStart(now), day_open: null, day_high: null, day_low: null,
      change_pct: null, range_pct: null, event_ms: null, received_ms: null, status: 'connecting', connected: false,
      clock_status: 'cloud', clock_offset_ms: 0, error: null, clock_error: null, rest_error: null,
      monitor_interval_seconds: 60, active_refresh_interval_seconds: 5 } };
}

export async function getMarketSnapshot(env, options = {}) {
  const now = nowOf(options);
  const [config, stored, events] = await Promise.all([
    settings(env), readKV(env, 'runtime'),
    env.DB.prepare('SELECT event_json FROM market_alerts ORDER BY at_ms DESC, id DESC LIMIT 100').all(),
  ]);
  const runtime = stored?.value?.market ? stored.value : emptyRuntime(now);
  const market = { ...runtime.market };
  if (market.day_start_ms !== dayStart(now)) {
    Object.assign(market, { day_start_ms: dayStart(now), day_open: null, day_high: null, day_low: null,
      change_pct: null, range_pct: null, status: 'waiting_baseline', connected: false });
  } else if (market.status === 'live' && (!Number.isFinite(market.event_ms) || now - market.event_ms > FRESH_MS
      || !Number.isFinite(market.received_ms) || now - market.received_ms > FRESH_MS)) {
    market.status = 'stale'; market.connected = false;
  }
  const alerts = [];
  for (const row of events.results ?? []) {
    try { alerts.push(JSON.parse(row.event_json)); } catch { /* Never invent a damaged event. */ }
  }
  return { settings: config.value, market,
    history: Array.isArray(runtime.history) ? runtime.history : [], alerts,
    revision: Math.max(runtime.revision ?? 0, config.stored?.updated_ms ?? 0),
    instance_id: runtime.instance_id || 'cloud-market-v1', server_time_ms: now,
    storage_error: null, email_queue_error: null, silenced_at_ms: runtime.silenced_at_ms ?? null,
    monitor_mode: 'cloud-minute-background-five-second-active' };
}

async function publicJSON(origin, path, options) {
  // Callers construct these fixed public paths; authentication headers never exist.
  const allowed=BINANCE_ORIGINS.includes(origin)
    ? path.startsWith('/api/v3/aggTrades?symbol=BTCUSDT&') || path.startsWith('/api/v3/klines?symbol=BTCUSDT&')
    : origin===OKX_ORIGIN && ['/api/v5/market/ticker?instId=BTC-USDT','/api/v5/market/candles?instId=BTC-USDT&bar=1D&limit=2','/api/v5/market/candles?instId=BTC-USDT&bar=5m&limit=300'].includes(path);
  if (!allowed) throw new Error('endpoint-rejected');
  const control = new AbortController();
  const timeout = setTimeout(() => control.abort(), Math.max(1, Math.min(options.timeoutMs ?? 8000, 8000)));
  const abort = () => control.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await (options.fetch ?? fetch)(origin + path, {
      method: 'GET', headers: { Accept: 'application/json','User-Agent':'XHY-Terminal/1.0' }, redirect: 'manual', signal: control.signal,
    });
    if (!response.ok) throw new Error('market-unavailable');
    const text = await response.text();
    if (text.length > 65536) throw new Error('market-unavailable');
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout); options.signal?.removeEventListener('abort', abort);
  }
}
function validateObservation(observation,start){
  const {open,high,low,event_ms}=observation;
  if (!Number.isSafeInteger(event_ms)||event_ms<start||event_ms>=start+DAY||low>high||open<low||open>high) throw new Error('invalid-market');
  return observation;
}
const observationFresh=(observation,received)=>observation.event_ms<=received+2000&&received-observation.event_ms<=FRESH_MS;
async function binanceObservation(origin,start,options){
  const [trades,candles]=await Promise.all([
    publicJSON(origin,'/api/v3/aggTrades?symbol=BTCUSDT&limit=1',options),
    publicJSON(origin,'/api/v3/klines?symbol=BTCUSDT&interval=1d&timeZone=8&startTime='+start+'&limit=1',options),
  ]);
  if(!Array.isArray(trades)||trades.length!==1||!Array.isArray(candles)||candles.length!==1)throw new Error('invalid-market');
  const trade=trades[0],candle=candles[0];
  if(!Array.isArray(candle)||candle.length<7||candle[0]!==start||candle[6]!==start+DAY-1)throw new Error('invalid-baseline');
  return validateObservation({source:'Binance Spot',price_source:'public aggregate trade',provider_origin:origin,
    price:positive(trade.p),open:positive(candle[1]),high:positive(candle[2]),low:positive(candle[3]),event_ms:trade.T},start);
}
async function okxObservation(start,options){
  // OKX 1D is the UTC+8 daily candle; 1Dutc and the ticker's rolling
  // open24h/high24h/low24h are deliberately not used as the daily baseline.
  const [tickerResult,candleResult]=await Promise.all([
    publicJSON(OKX_ORIGIN,'/api/v5/market/ticker?instId=BTC-USDT',options),
    publicJSON(OKX_ORIGIN,'/api/v5/market/candles?instId=BTC-USDT&bar=1D&limit=2',options),
  ]);
  if(tickerResult?.code!=='0'||candleResult?.code!=='0'||!Array.isArray(tickerResult.data)||tickerResult.data.length!==1
    ||!Array.isArray(candleResult.data)||!candleResult.data.length||candleResult.data.length>2)throw new Error('invalid-market');
  const ticker=tickerResult.data[0],matching=candleResult.data.filter(row=>Array.isArray(row)&&row[0]===String(start));
  if(ticker.instId!=='BTC-USDT'||ticker.instType!=='SPOT'||typeof ticker.ts!=='string'||!/^\d{13}$/.test(ticker.ts)||matching.length!==1)throw new Error('invalid-market');
  const candle=matching[0];
  if(candle.length<9||candle[8]!=='0')throw new Error('invalid-baseline');
  const high=positive(candle[2]),low=positive(candle[3]),close=positive(candle[4]);
  if(close<low||close>high)throw new Error('invalid-baseline');
  return validateObservation({source:'OKX Spot',price_source:'public ticker snapshot',provider_origin:OKX_ORIGIN,
    price:positive(ticker.last),open:positive(candle[1]),high,low,event_ms:Number(ticker.ts)},start);
}
async function marketObservation(start,options){
  let stale=null;
  // The public-only Binance host remains preferred. Each fixed origin is
  // queried at most once; a complete refresh uses at most six HTTP calls.
  for(const origin of BINANCE_ORIGINS){
    try{
      const observation=await binanceObservation(origin,start,options);
      if(observationFresh(observation,nowOf(options)))return observation;
      if(!stale||observation.event_ms>stale.event_ms)stale=observation;
    }catch{ /* Try the next fixed official public endpoint. */ }
    if(options.signal?.aborted)throw new Error('aborted');
  }
  try{
    const observation=await okxObservation(start,options);
    if(observationFresh(observation,nowOf(options))||!stale||observation.event_ms>stale.event_ms)return observation;
  }catch{ /* Retain a genuinely timestamped stale observation if available. */ }
  if(stale)return stale;
  throw new Error('market-unavailable');
}
// Today's chart: one genuine price per minute. A late or stale observation
// fills only its own minute and never removes newer samples (removing them
// used to leave a straight line across the lost part of the day).
const SLOT_MS = 4 * 60000, GAP_MS = 10 * 60000, BACKFILL_MS = 5 * 60000, KLINE_MS = 5 * 60000;
function todayRows(previous, start) {
  const bucket = new Map();
  for (const row of Array.isArray(previous) ? previous : []) {
    if (!row || !Number.isFinite(row.time_ms) || row.time_ms < start || row.time_ms >= start + DAY || !Number.isFinite(row.price) || row.price <= 0) continue;
    const key = Math.floor(row.time_ms / 60000), old = bucket.get(key);
    if (!old || row.time_ms >= old.time_ms) bucket.set(key, row);
  }
  return bucket;
}
// At most one point per four minutes (360 a day), the newest in each slot,
// plus the day's opening point and the latest one. Stable across appends.
function thinHistory(bucket) {
  const rows = [...bucket.values()].sort((a, b) => a.time_ms - b.time_ms);
  if (rows.length <= 360) return rows;
  const slots = new Map();
  for (const row of rows.slice(1, -1)) slots.set(Math.floor(row.time_ms / SLOT_MS), row);
  return [rows[0], ...slots.values(), rows.at(-1)];
}
function appendHistory(previous, point, open) {
  const start = dayStart(point.time_ms), bucket = todayRows(previous, start);
  bucket.set(Math.floor(start / 60000), { time_ms: start, price: open });
  const key = Math.floor(point.time_ms / 60000), old = bucket.get(key);
  if (!old || point.time_ms >= old.time_ms || old.time_ms === start) bucket.set(key, point);
  return thinHistory(bucket);
}
// Fills minutes that have no live sample with the closes of real 5-minute
// candles (a missed sync, a new day or a deploy). Live samples always win.
function mergeCandles(previous, points, start) {
  const bucket = todayRows(previous, start);
  for (const point of points) { const key = Math.floor(point.time_ms / 60000); if (!bucket.has(key)) bucket.set(key, point); }
  return thinHistory(bucket);
}
function historyGap(history, start, now) {
  const times = [start, ...(Array.isArray(history) ? history : []).filter(row => row && row.time_ms >= start && row.time_ms <= now).map(row => row.time_ms).sort((a, b) => a - b), now];
  return times.some((time, i) => i && time - times[i - 1] > GAP_MS);
}
function binanceCandles(rows, start, now) {
  if (!Array.isArray(rows) || rows.length > 300) return [];
  const points = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const open = Number(row[0]), close = Number(row[6]);
    if (!Number.isSafeInteger(open) || close !== open + KLINE_MS - 1 || open < start || open > now) continue;
    try { points.push({ time_ms: Math.min(close, now), price: positive(row[4]) }); } catch { /* skip a malformed candle */ }
  }
  return points;
}
function okxCandles(body, start, now) {
  if (body?.code !== '0' || !Array.isArray(body.data) || body.data.length > 300) return [];
  const points = [];
  for (const row of body.data) {
    if (!Array.isArray(row) || row.length < 9) continue;
    const open = Number(row[0]);
    if (!Number.isSafeInteger(open) || open < start || open > now) continue;
    try { points.push({ time_ms: Math.min(open + KLINE_MS - 1, now), price: positive(row[4]) }); } catch { /* skip */ }
  }
  return points;
}
async function intradayCandles(start, now, options, preferred) {
  const origins = [...new Set([preferred, ...BINANCE_ORIGINS])].filter(origin => BINANCE_ORIGINS.includes(origin));
  for (const origin of origins) {
    try {
      const points = binanceCandles(await publicJSON(origin, '/api/v3/klines?symbol=BTCUSDT&interval=5m&timeZone=8&startTime=' + start + '&limit=288', options), start, now);
      if (points.length) return points;
    } catch { /* try the next fixed public endpoint */ }
    if (options.signal?.aborted) return [];
  }
  try { return okxCandles(await publicJSON(OKX_ORIGIN, '/api/v5/market/candles?instId=BTC-USDT&bar=5m&limit=300', options), start, now); }
  catch { return []; }
}

function ruleKey(at, metric, threshold, direction) {
  return [dayStart(at), metric, Number(threshold), direction].join('|');
}
async function firedRules(env, start) {
  const [stored, rows] = await Promise.all([
    readKV(env, 'triggered'),
    env.DB.prepare('SELECT event_json FROM market_alerts WHERE at_ms >= ? AND at_ms < ?').bind(start, start + DAY).all(),
  ]);
  const result = new Set();
  for (const raw of Array.isArray(stored?.value) ? stored.value : []) {
    const parts = typeof raw === 'string' ? raw.split('|') : [];
    if (parts.length === 4 && Number(parts[0]) === start && ['daily_change', 'day_range'].includes(parts[1])
        && Number.isFinite(Number(parts[2])) && ['up', 'down', 'range'].includes(parts[3])) {
      result.add([start, parts[1], Number(parts[2]), parts[3]].join('|'));
    }
  }
  for (const row of rows.results ?? []) {
    try {
      const event = JSON.parse(row.event_json);
      if (event.kind === 'market' && ['daily_change', 'day_range'].includes(event.metric)
          && Number.isFinite(event.threshold_pct) && ['up', 'down', 'range'].includes(event.direction)) {
        result.add(ruleKey(event.at_ms, event.metric, event.threshold_pct, event.direction));
      }
    } catch { /* Existing malformed events do not turn into new alerts. */ }
  }
  return result;
}

export async function syncMarket(env, options = {}) {
  if (!env.DB) throw new Error('market-storage-unavailable');
  if (pending.has(env.DB)) return pending.get(env.DB);
  const task = (async () => {
    const now = nowOf(options);
    const stored = await readKV(env, 'runtime');
    if (!options.force && stored?.value?.last_sync_ms && now - stored.value.last_sync_ms < REFRESH_MS) {
      return { ...await getMarketSnapshot(env, options), newAlerts: [] };
    }
    const old = stored?.value?.market ? stored.value : emptyRuntime(now);
    let market, history = old.history ?? [], backfill = {};
    try {
      const start = dayStart(now);
      const observation=await marketObservation(start,options);
      const {price,open,high,low}=observation;
      const received = nowOf(options);
      if(dayStart(received)!==start)throw new Error('invalid-baseline');
      const fresh = observationFresh(observation,received);
      market = { ...old.market, symbol: 'BTCUSDT', source: observation.source, price_source: observation.price_source, provider_origin:observation.provider_origin, timezone: 'Asia/Shanghai',
        price, day_start_ms: start, day_open: open, day_high: Math.max(high, price), day_low: Math.min(low, price),
        change_pct: (price - open) * 100 / open, range_pct: (Math.max(high, price) - Math.min(low, price)) * 100 / open,
        event_ms: observation.event_ms, received_ms: received, status: fresh ? 'live' : 'stale', connected: fresh,
        error: fresh ? null : '行情数据时间已过期，警报暂停。', rest_error: null,
        clock_status: 'cloud', clock_offset_ms: 0, clock_error: null, clock_warning: null,
        monitor_interval_seconds: 60, active_refresh_interval_seconds: 5 };
      history = appendHistory(history, { time_ms: observation.event_ms, price }, open);
      // The cron and page loads (not every stream frame) repair gaps, at most
      // once every five minutes.
      if (options.backfill && historyGap(history, start, received) && !(old.backfill_ms >= received - BACKFILL_MS && old.backfill_day === start)) {
        backfill = { backfill_ms: received, backfill_day: start };
        // Candles stop at the live sample, so the curve still ends on it.
        const candles = await intradayCandles(start, observation.event_ms, options, observation.provider_origin);
        if (candles.length) history = mergeCandles(history, candles, start);
      }
    } catch {
      market = { ...old.market, status: old.market.price ? 'reconnecting' : 'connecting', connected: false,
        error: '云端行情源暂时无法读取，保留原快照，警报暂停。', rest_error: '行情请求失败，正在重试。' };
    }
    let config = await settings(env);
    if (!config.stored) {
      await env.DB.prepare('INSERT OR IGNORE INTO market_kv(key,value,updated_ms) VALUES (?,?,?)')
        .bind('settings', JSON.stringify(config.value), now).run();
      config = await settings(env);
    }
    const serialized = config.stored.serialized;
    const fired = await firedRules(env, market.day_start_ms);
    const runtime = { ...old, ...backfill, market, history, last_sync_ms: nowOf(options), revision: Math.max(nowOf(options), (old.revision ?? 0) + 1) };
    const commands = [writeKV(env, 'runtime', runtime, nowOf(options))], candidates = [];
    if (config.value.enabled && market.status === 'live') {
      const direction = config.value.metric === 'day_range' ? 'range' : market.price >= market.day_open ? 'up' : 'down';
      const movement = direction === 'range' ? market.range_pct : Math.abs(market.change_pct);
      config.value.thresholds_pct.forEach((threshold, index) => {
        if (movement < threshold || fired.has(ruleKey(market.event_ms, config.value.metric, threshold, direction))) return;
        const id = 'cloud-' + market.day_start_ms + '-' + config.value.metric + '-' + direction + '-' + String(threshold).replace('.', '_');
        const event = { id, kind: 'market', direction, metric: config.value.metric, threshold_pct: threshold,
          at_ms: market.event_ms, local_at_ms: nowOf(options), price: market.price,
          change_pct: market.change_pct, range_pct: market.range_pct, sound_level: index + 1,
          sound_status: config.value.sound ? 'unsupported' : 'disabled', sound_scope: 'browser',
          monitor_mode: 'cloud-minute-background-five-second-active' };
        candidates.push(event);
        commands.push(env.DB.prepare("INSERT OR IGNORE INTO market_alerts(id,at_ms,event_json) SELECT ?,?,? WHERE (SELECT value FROM market_kv WHERE key='settings')=?")
          .bind(id, event.at_ms, JSON.stringify(event), serialized));
      });
    }
    const committed = await env.DB.batch(commands);
    const newAlerts = candidates.filter((_, i) => committed[i + 1]?.meta?.changes === 1);
    return { ...await getMarketSnapshot(env, options), newAlerts };
  })();
  pending.set(env.DB, task);
  try { return await task; }
  finally { if (pending.get(env.DB) === task) pending.delete(env.DB); }
}

async function bodyJSON(request) {
  const url = new URL(request.url);
  if ((request.headers.get('Origin') && request.headers.get('Origin') !== url.origin)
      || request.headers.get('Sec-Fetch-Site') === 'cross-site'
      || request.headers.get('X-Terminal-Request') !== '1') throw new Error('forbidden');
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error('invalid');
  const text = await request.text();
  if (text.length > 4096) throw new Error('invalid');
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid');
  return data;
}
// The portal overview's live card reads only these fields (?view=market, as on
// the local terminal): the quote, alert rules and newest alerts, without the
// chart history that otherwise fills every frame.
function marketView(snapshot) {
  return { market: snapshot.market, settings: snapshot.settings, revision: snapshot.revision, instance_id: snapshot.instance_id,
    server_time_ms: snapshot.server_time_ms, alerts: (snapshot.alerts ?? []).slice(0, 8) };
}
function notify(ctx, events) {
  if (!events.length || typeof ctx?.onMarketAlerts !== 'function') return;
  const promise = Promise.resolve().then(() => ctx.onMarketAlerts(events));
  if (ctx.waitUntil) ctx.waitUntil(promise);
  else promise.catch(() => {});
}

export async function handleMarket(request, env, ctx = {}) {
  const url = new URL(request.url), path = url.pathname;
  const paths = ['/api/terminal', '/api/terminal/settings', '/api/terminal/test', '/api/terminal/silence', '/api/terminal/events'];
  if (!paths.includes(path)) return null;
  const lean = path === '/api/terminal/events' && url.search === '?view=market';
  if (url.search && !lean) return failure('行情接口不接受查询参数。', 400);
  const options = ctx.marketOptions ?? {};
  try {
    if (path === '/api/terminal' && ['GET', 'HEAD'].includes(request.method)) {
      const result = await syncMarket(env, { ...options, backfill: true }); notify(ctx, result.newAlerts);
      const { newAlerts, ...snapshot } = result;
      return request.method === 'HEAD' ? new Response(null, { headers }) : json(snapshot);
    }
    if (path === '/api/terminal/events' && request.method === 'GET') {
      const control = new AbortController(), encoder = new TextEncoder();
      let closed = false;
      const started = Date.now(), duration = Math.min(25000, options.streamDurationMs ?? 25000);
      const interval = Math.max(0, options.streamIntervalMs ?? 5000);
      const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
      const stream = new ReadableStream({
        start(controller) {
          const task = (async () => {
            try {
              // Each refresh includes D1 subrequests and at most six public
              // provider calls. Three frames leave room under the 50-call
              // request budget for auth and transactional email enqueueing.
              for (let frame = 0; frame < 3 && !closed; frame++) {
                if (frame) await sleep(interval);
                const remaining = duration - (Date.now() - started);
                if (remaining <= 0 || closed) break;
                const result = await syncMarket(env, { ...options, signal: control.signal, timeoutMs: Math.min(8000, remaining) });
                notify(ctx, result.newAlerts);
                const { newAlerts, ...snapshot } = result;
                if (closed) break;
                controller.enqueue(encoder.encode('event: snapshot\ndata: ' + JSON.stringify(lean ? marketView(snapshot) : snapshot) + '\n\n'));
              }
            } catch {
              // EventSource reconnects after closing; never emit fake live data.
            } finally { if (!closed) { closed = true; controller.close(); } }
          })();
          ctx.waitUntil?.(task);
        },
        cancel() { closed = true; control.abort(); },
      });
      return new Response(stream, { headers: { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' } });
    }
    if (request.method !== 'POST' || ['/api/terminal', '/api/terminal/events'].includes(path)) return failure('此行情接口不支持该操作。', 405);
    let input;
    try { input = await bodyJSON(request); }
    catch (error) { return failure(error.message === 'forbidden' ? '请在自己的终端内提交请求。' : '请求格式无效。', error.message === 'forbidden' ? 403 : 400); }
    const now = nowOf(options);
    if (path.endsWith('/settings')) {
      let value;
      try { value = cleanSettings(input, (await settings(env)).value, true); }
      catch { return failure('阈值须递增且在 0.1% 到 50% 内，设置字段必须有效。', 400); }
      await writeKV(env, 'settings', value, now).run();
      return json(await getMarketSnapshot(env, options));
    }
    if (path.endsWith('/silence')) {
      if (Object.keys(input).length) return failure('停止响铃请求格式无效。', 400);
      const runtime = (await readKV(env, 'runtime'))?.value ?? emptyRuntime(now);
      await writeKV(env, 'runtime', { ...runtime, silenced_at_ms: now, revision: Math.max(now, (runtime.revision ?? 0) + 1) }, now).run();
      return json(await getMarketSnapshot(env, options));
    }
    const level = input.sound_level ?? 1;
    if (Object.keys(input).some(key => key !== 'sound_level') || !Number.isInteger(level) || level < 1 || level > 3) return failure('请选择一至三级测试声音。', 400);
    const snapshot = await getMarketSnapshot(env, options);
    const event = { id: 'cloud-test-' + crypto.randomUUID(), kind: 'test', direction: 'test', metric: snapshot.settings.metric,
      threshold_pct: snapshot.settings.threshold_pct, at_ms: now, local_at_ms: now, price: snapshot.market.price,
      change_pct: snapshot.market.change_pct, range_pct: snapshot.market.range_pct, sound_level: level,
      sound_status: 'unsupported', sound_scope: 'browser', email_enqueued: false };
    await env.DB.prepare('INSERT INTO market_alerts(id,at_ms,event_json) VALUES (?,?,?)').bind(event.id, now, JSON.stringify(event)).run();
    return json(await getMarketSnapshot(env, options));
  } catch { return failure('云端行情或设置存储暂不可用，请稍后重试。'); }
}
