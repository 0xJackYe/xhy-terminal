import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverview } from '../overview.mjs';
import { schemaSQL } from '../schema.mjs';
import { createD1DiaryStore } from '../diary-store.mjs';
import { testDatabase } from './auth-mail-fixture.mjs';

const DAY = 86400000, OFFSET = 28800000;
const startOfDay = now => Math.floor((now + OFFSET) / DAY) * DAY - OFFSET;
const dayString = now => new Date(startOfDay(now) + OFFSET).toISOString().slice(0, 10);
function kv(env, table, key, value, now) { env.sqlite.prepare(`INSERT OR REPLACE INTO ${table}(key,value,updated_ms) VALUES(?,?,?)`).run(key, JSON.stringify(value), now); }
function context(callback = () => {}) {
  const pending = [];
  return { pending, onMarketAlerts: callback, waitUntil(value) { pending.push(value); }, async drain() { while (pending.length) await Promise.all(pending.splice(0)); } };
}
function cachedMarket(env, now) {
  kv(env, 'market_kv', 'settings', { enabled: true, threshold_pct: 2.5, thresholds_pct: [2.5, 3.5, 5], metric: 'daily_change', sound: false }, now);
  kv(env, 'market_kv', 'runtime', { revision: now, last_sync_ms: now, market: { status: 'live', connected: true, price: 106, event_ms: now, received_ms: now, day_start_ms: startOfDay(now), day_open: 100, day_high: 106, day_low: 99, change_pct: 6, range_pct: 7 }, history: [] }, now);
  kv(env, 'finance_kv', 'sync_lock', true, now + 60000);
}

test('overview reads the cloud diary and financial cache with unknown nutrients preserved', async t => {
  const env = testDatabase(schemaSQL), now = Date.now(), ctx = context(); t.after(() => env.sqlite.close()); cachedMarket(env, now);
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw Error('Cached overview must not request a model or exchange'); }; t.after(() => { globalThis.fetch = original; });
  const meal = { id: 'fixture-meal', type: 'dinner', title: 'Fixture meal', status: 'eaten', items: [{ name: 'Fixture food', amount: 100, unit: 'g', nutrition: { kcal: 200, protein: 10, carbs: 20, fat: 5, fiber: null, saturatedFat: 1 } }] };
  const diary = { schemaVersion: 1, timezone: 'Asia/Shanghai', updatedAt: new Date(now).toISOString(), days: [{ date: dayString(now), title: 'Today', note: '', meals: [meal] }] };
  await createD1DiaryStore({ db: env.DB }).initialize('terminal-owner', { revision: 3, diary, receipts: [] });
  kv(env, 'finance_kv', 'portfolio', { complete: true, stale: false, updated_at: new Date(now).toISOString(), total_usd: '15000', total_cny: '100000', total_btc: '0.2', assets: [{ ccy: 'BTC', quantity: '0.2' }], sources: [] }, now);
  kv(env, 'finance_kv', 'combined', { totals: { btc: '0.175' }, stale: false }, now);
  const result = await buildOverview(env, ctx, now); await ctx.drain();
  assert.equal(result.diet.status, 'online'); assert.equal(result.diet.today.totals.kcal, 200); assert.equal(result.diet.today.totals.fiber, null);
  assert.equal(result.diet.week.recordedDays, 1); assert.equal(result.diet.week.totals.fiber, null); assert.equal(result.diet.week.totals.protein, 10);
  assert.equal(result.wallet.totalBtc, '0.2'); assert.equal(result.wallet.btcHoldings, '0.175'); assert.equal(result.wallet.status, 'online');
  assert.equal(result.alerts.status, 'online'); assert.equal(result.alerts.price, 106);
  assert.deepEqual(result.links, { diet: '/diet/', wallet: '/btc/#wallet', alerts: '/btc/#alerts' });
});

test('overview shows the newest eight alerts rather than the oldest eight', async t => {
  const env = testDatabase(schemaSQL), now = Date.now(), ctx = context(); t.after(() => env.sqlite.close()); cachedMarket(env, now);
  for (let i = 0; i < 12; i++) env.sqlite.prepare('INSERT INTO market_alerts(id,at_ms,event_json) VALUES(?,?,?)').run('fixture-' + i, now - 12000 + i * 1000, JSON.stringify({ id: 'fixture-' + i, at_ms: now - 12000 + i * 1000 }));
  const result = await buildOverview(env, ctx, now); await ctx.drain();
  assert.deepEqual(result.alerts.recent.map(value => value.id), [11, 10, 9, 8, 7, 6, 5, 4].map(i => 'fixture-' + i));
});

test('homepage market refresh forwards every newly committed alert to the durable notification callback once', async t => {
  const env = testDatabase(schemaSQL), now = Date.now(), forwarded = [], ctx = context(events => forwarded.push(...events));
  t.after(() => env.sqlite.close()); kv(env, 'finance_kv', 'sync_lock', true, now + 60000);
  const original = globalThis.fetch, paths = [];
  globalThis.fetch = async (address, init) => {
    const url = new URL(address); paths.push(url.pathname); assert.equal(url.origin, 'https://data-api.binance.vision'); assert.equal(init.method, 'GET');
    const at = Date.now(), start = startOfDay(at);
    if (url.pathname === '/api/v3/aggTrades') return Response.json([{ p: '106', T: at }]);
    assert.equal(url.pathname, '/api/v3/klines');
    return Response.json([[start, '100', '106', '99', '106', '1', start + DAY - 1]]);
  };
  t.after(() => { globalThis.fetch = original; });
  const first = await buildOverview(env, ctx, now); await ctx.drain();
  assert.equal(first.alerts.recent.length, 3); assert.equal(forwarded.length, 3);
  assert.equal(new Set(forwarded.map(event => event.id)).size, 3); assert(forwarded.every(event => event.kind === 'market'));
  await buildOverview(env, ctx, now + 1); await ctx.drain();
  assert.equal(forwarded.length, 3); assert.deepEqual(paths.sort(), ['/api/v3/aggTrades', '/api/v3/klines']);
});
