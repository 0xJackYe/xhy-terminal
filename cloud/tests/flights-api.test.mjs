import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTravel, TRAVEL_SCHEMA } from '../flights.mjs';
import { AIRPORTS, ENTRY_POLICIES, enrichFlight } from '../flights-catalog.mjs';
import { decryptJson, encryptJson } from '../crypto.mjs';
import worker from '../worker.mjs';
import { schemaSQL } from '../schema.mjs';
import { post, testDatabase } from './auth-mail-fixture.mjs';

const NOW = Date.parse('2026-10-29T00:05:00Z');
const KEY = 'mock-flight-api-key-only-not-real';
const ROTATED_KEY = 'mock-flight-api-key-rotated-not-real';
const SECRET = 'fixture-travel-encryption-secret-'.repeat(2);
const ORIGIN = 'https://terminal.example';
const request = (path, init) => new Request(ORIGIN + path, init);
const query = extra => ({ airports: [{ iata: 'NKG', travel_minutes: 60 }],
  ready_minutes: 120, passport_country: 'CN', entry_filter: 'easy_entry', ...extra });
const options = extra => ({ now: NOW, pause: async () => {}, ...extra });
const search = (env, input = query(), extra = {}) => handleTravel(post('/api/travel/search', input), env, options(extra));
function environment(t, { key = KEY, fullSchema = false } = {}) {
  const fixture = testDatabase(fullSchema ? schemaSQL : TRAVEL_SCHEMA);
  t.after(() => fixture.sqlite.close());
  return { ...fixture, CONFIG_ENCRYPTION_KEY: SECRET, ...(key ? { AERODATABOX_API_KEY: key } : {}) };
}
// Synthetic FIDS response, never fetched from a live source.
function row(extra = {}) {
  return { number: 'MU 1001', status: 'Expected', codeshareStatus: 'IsOperator', isCargo: false,
    airline: { name: 'Synthetic airline', iata: 'MU' },
    departure: { scheduledTime: { utc: '2026-10-29T08:00:00Z' } },
    arrival: { airport: { iata: 'BKK', name: 'Synthetic destination', municipalityName: 'Test city',
      countryCode: 'TH', timeZone: 'Asia/Bangkok' }, scheduledTime: { utc: '2026-10-29T11:00:00Z' } },
    ...extra };
}
function mockProvider(rows = [row()], calls = []) {
  return async (url, init) => { calls.push({ url, init }); return Response.json({ departures: rows }); };
}
async function saveConfig(env, config) {
  env.sqlite.prepare("INSERT INTO travel_kv(key,value,updated_ms) VALUES('config',?,?)").run(
    await encryptJson(config, SECRET), NOW);
}

test('private provider key is encrypted at rest, never returned, and existing defaults survive updates', async t => {
  const env = environment(t, { key: null });
  const defaults = { city: 'synthetic city', airports: [{ iata: 'NKG', travel_minutes: null }] };
  await saveConfig(env, { defaults });
  const result = await handleTravel(post('/api/travel/config', { api_key: KEY }), env, options());
  assert.equal(result.status, 200);
  const text = await result.text(), data = JSON.parse(text);
  assert(!text.includes(KEY)); assert(!text.includes(SECRET)); assert(!text.includes('api_key'));
  assert.equal(data.provider.configured, true);
  assert.equal(data.provider.status, 'configured');
  assert.deepEqual(data.defaults, defaults);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  const stored = env.sqlite.prepare("SELECT value FROM travel_kv WHERE key='config'").get().value;
  assert.match(stored, /^v1\./); assert(!stored.includes(KEY));
  assert.deepEqual(await decryptJson(stored, SECRET), { defaults, api_key: KEY });
  const config = await handleTravel(request('/api/travel/config'), env, options());
  assert.equal(config.status, 200); assert(!(await config.text()).includes(KEY));
  const bad = await handleTravel(post('/api/travel/config', { api_key: 'invalid short key' }), env, options());
  assert.equal(bad.status, 400);
  assert.equal(env.sqlite.prepare("SELECT value FROM travel_kv WHERE key='config'").get().value, stored);
});

test('unconfigured provider makes no network request and returns no fabricated flight or recommendation', async t => {
  const env = environment(t, { key: null }); let calls = 0;
  const response = await search(env, query(), { fetchImpl: async () => { calls++; throw Error('Unexpected network'); } });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.provider.configured, false);
  assert.equal(data.provider.status, 'needs_credentials');
  assert.deepEqual(data.flights, []); assert.equal(data.recommendation, null); assert.equal(data.earliest_candidate, null);
  assert.match(data.warnings.join(' '), /没有使用演示航班/); assert.equal(calls, 0);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM travel_usage').get().n, 0);
});

test('invalid encrypted configuration fails closed without reflecting keys or private database details', async t => {
  const env = environment(t, { key: null }); await saveConfig(env, { api_key: KEY });
  env.CONFIG_ENCRYPTION_KEY = 'incorrect-fixture-encryption-key-'.repeat(2);
  const response = await handleTravel(request('/api/travel/config'), env, options());
  assert.equal(response.status, 503);
  const text = await response.text(); assert(!text.includes(KEY)); assert(!text.includes(SECRET));
  assert.match(text, /暂时不可用/);
});

test('real adapter output survives query normalization twice, remains a schedule and scopes entry to CN', async t => {
  const env = environment(t), calls = [];
  const response = await search(env, query({ departure_date: '2026-10-29', sort: 'price', ready_minutes: '120' }),
    { fetchImpl: mockProvider([row({ airline: { name: 'Synthetic ' + KEY, iata: 'MU' } })], calls) });
  assert.equal(response.status, 200);
  const text = await response.text(), data = JSON.parse(text), f = data.flights[0];
  assert.equal(calls.length, 1); assert.equal(calls[0].init.headers['X-RapidAPI-Key'], KEY);
  assert(!calls[0].url.includes(KEY)); assert(!text.includes(KEY)); assert(!text.includes(SECRET));
  assert.equal(f.availability, 'schedule_only'); assert.equal(f.price, null);
  assert.equal(f.entry.status, 'visa_free'); assert.equal(f.entry.passport_country, 'CN');
  assert.equal(f.planning.disposition, 'needs_verification'); assert.equal(f.planning.travel_minutes, 60);
  assert.equal(f.planning.ready_at, '2026-10-29T02:05:00.000Z');
  assert.equal(data.recommendation, null); assert.equal(data.earliest_candidate.id, f.id);
  assert.match(f.airline.name, /redacted/); assert.match(data.summary.notices.join(' '), /CNY/);
  assert.equal(new URL(calls[0].url).pathname, '/flights/airports/iata/NKG/2026-10-29T08:00/2026-10-29T20:00');
  const changedPassport = await search(env, query({ passport_country: 'JP' }), { fetchImpl: mockProvider([], calls) });
  const changed = await changedPassport.json();
  assert.deepEqual(changed.flights, []); assert.equal(calls.length, 1);
});

test('unfiltered non-CN passports get verify policies, and official JP/KR policy links remain allowed', async t => {
  const env = environment(t);
  const response = await search(env, query({ passport_country: 'JP', entry_filter: 'all' }), { fetchImpl: mockProvider() });
  const data = await response.json(); assert.equal(data.flights[0].entry.status, 'verify');
  assert.equal(data.flights[0].entry.passport_country, 'JP'); assert.equal(data.flights[0].entry.official_url, null);
  for (const code of ['JP', 'KR']) {
    const policy = ENTRY_POLICIES.find(p => p.code === code);
    const enriched = enrichFlight({ flight_number: 'MU 1002', airline: { iata: 'MU' }, destination: { country_code: code } }, 'CN');
    assert.equal(enriched.entry.official_url, policy.official_url);
    assert.equal(enriched.entry.status, 'visa_required');
  }
});

test('cache reuses source within a stable half-hour bucket and reranks for fresh preparation input', async t => {
  const env = environment(t), calls = [], fetchImpl = mockProvider(undefined, calls);
  const first = await (await search(env, query(), { fetchImpl })).json();
  const second = await (await search(env, query({ ready_minutes: 240 }), { fetchImpl, now: NOW + 5 * 60000 })).json();
  assert.equal(calls.length, 1); assert.equal(first.cached_airports, 0); assert.equal(second.cached_airports, 1);
  assert.equal(first.window.from, second.window.from);
  assert.equal(second.flights[0].planning.ready_at, '2026-10-29T04:10:00.000Z');
  assert.equal(env.sqlite.prepare('SELECT requests FROM travel_usage').get().requests, 1);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM travel_locks').get().n, 0);
  const third = await (await search(env, query(), { fetchImpl, now: NOW + 15 * 60000 })).json();
  assert.equal(calls.length, 2); assert.equal(third.cached_airports, 0);
  const fourth = await (await search(env, query(), { fetchImpl, now: NOW + 30 * 60000 })).json();
  assert.equal(calls.length, 3); assert.notEqual(fourth.window.from, first.window.from);
});

test('key rotation invalidates cached provider data without publishing old or new secrets', async t => {
  const env = environment(t, { key: null }), calls = [], fetchImpl = mockProvider(undefined, calls);
  await saveConfig(env, { api_key: KEY });
  assert.equal((await search(env, query(), { fetchImpl })).status, 200);
  const updated = await handleTravel(post('/api/travel/config', { api_key: ROTATED_KEY }), env, options());
  assert.equal(updated.status, 200); assert(!(await updated.text()).includes(ROTATED_KEY));
  const response = await search(env, query(), { fetchImpl }), text = await response.text();
  assert.equal(calls.length, 2); assert.equal(calls[1].init.headers['X-RapidAPI-Key'], ROTATED_KEY);
  assert(!text.includes(KEY)); assert(!text.includes(ROTATED_KEY));
  for (const row of env.sqlite.prepare('SELECT key,value FROM travel_cache').all()) {
    assert(!JSON.stringify(row).includes(KEY)); assert(!JSON.stringify(row).includes(ROTATED_KEY));
  }
});

test('monthly query ceiling is atomic, does not bill cache hits, and rolls over by UTC month', async t => {
  const env = environment(t), calls = [], fetchImpl = mockProvider([], calls);
  env.sqlite.prepare('INSERT INTO travel_usage(month,requests) VALUES(?,?)').run('2026-10', 179);
  const last = await (await search(env, query(), { fetchImpl })).json();
  assert.equal(last.provider.status, 'live'); assert.equal(calls.length, 1);
  assert.equal(env.sqlite.prepare("SELECT requests FROM travel_usage WHERE month='2026-10'").get().requests, 180);
  await search(env, query(), { fetchImpl }); assert.equal(calls.length, 1);
  const denied = await (await search(env, query({ airports: [{ iata: 'PVG', travel_minutes: 240 }] }), { fetchImpl })).json();
  assert.equal(calls.length, 1); assert.deepEqual(denied.flights, []); assert.match(denied.warnings.join(' '), /本月航班查询上限/);
  assert.equal(env.sqlite.prepare("SELECT requests FROM travel_usage WHERE month='2026-10'").get().requests, 180);
  await search(env, query(), { fetchImpl, now: Date.parse('2026-11-01T00:05:00Z') });
  assert.equal(calls.length, 2);
  assert.equal(env.sqlite.prepare("SELECT requests FROM travel_usage WHERE month='2026-11'").get().requests, 1);
});

test('overlapping searches are locked and completion always releases the lock', async t => {
  const env = environment(t); let begin, release;
  const started = new Promise(resolve => { begin = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const first = search(env, query(), { fetchImpl: async () => { begin(); await held; return Response.json({ departures: [] }); } });
  await started;
  const overlap = await search(env, query(), { fetchImpl: async () => { throw Error('Overlapping provider call'); } });
  assert.equal(overlap.status, 429); assert.match((await overlap.json()).error, /另一个航班查询/);
  release(); assert.equal((await first).status, 200);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM travel_locks').get().n, 0);
  env.sqlite.prepare("INSERT INTO travel_locks(name,until_ms) VALUES('search',?)").run(NOW - 1);
  assert.equal((await search(env, query(), { fetchImpl: mockProvider([]) })).status, 200);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM travel_locks').get().n, 0);
});

test('provider errors release locks, remain secret-safe and cannot be cached as a successful empty response', async t => {
  const env = environment(t); let calls = 0;
  const failed = await search(env, query(), { fetchImpl: async () => { calls++; throw Error(KEY); } });
  const text = await failed.text(), data = JSON.parse(text);
  assert.equal(data.provider.status, 'error'); assert.deepEqual(data.flights, []); assert.equal(data.recommendation, null);
  assert(!text.includes(KEY)); assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM travel_cache').get().n, 0);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM travel_locks').get().n, 0);
  await search(env, query(), { fetchImpl: async () => { calls++; return Response.json({ departures: [] }); } });
  assert.equal(calls, 2);
});

test('provider 429 stops remaining airports and returns a bounded retry interval without private details', async t => {
  const env = environment(t); let calls = 0;
  const response = await search(env, query({ airports: [{ iata: 'NKG', travel_minutes: 60 }, { iata: 'PVG', travel_minutes: 240 }] }),
    { fetchImpl: async () => { calls++; return new Response(KEY, { status: 429, headers: { 'Retry-After': '120' } }); } });
  const text = await response.text(), data = JSON.parse(text);
  assert.equal(calls, 1); assert.equal(data.retry_after_seconds, 120);
  assert.equal(data.provider.status, 'error'); assert.deepEqual(data.flights, []); assert(!text.includes(KEY));
  assert.match(data.warnings.join(' '), /频率|额度/);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM travel_locks').get().n, 0);
});

test('whole-search budget retains partial airport results and shortens the last provider timeout', async t => {
  const env = environment(t), calls = [], pauses = [], timeouts = [];
  const selected = AIRPORTS.slice(0, 6).map(a => ({ iata: a.iata, travel_minutes: 60 }));
  let wall = NOW;
  const durations = [7000, 7000, 7000, 4700];
  const nativeTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    timeouts.push(delay); return nativeTimeout(callback, delay, ...args);
  };
  t.after(() => { globalThis.setTimeout = nativeTimeout; });
  const response = await search(env, query({ airports: selected }), {
    wallNow: () => wall,
    pause: async ms => { pauses.push(ms); wall += ms; },
    fetchImpl: async (url, init) => {
      const index = calls.length;
      calls.push({ url, init });
      assert.ok(index < durations.length, 'remaining airports must not consume requests after the budget');
      wall += durations[index];
      return Response.json({ departures: [row()] });
    },
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(c => new URL(c.url).pathname.split('/')[4]), selected.slice(0, 4).map(a => a.iata));
  assert.deepEqual(timeouts, [8000, 8000, 8000, 4700]);
  assert.deepEqual(pauses, [1100, 1100, 1100]);
  assert.equal(wall - NOW, 29000);
  assert.equal(data.provider.status, 'live');
  assert.equal(data.flights.length, 4);
  assert.deepEqual(new Set(data.flights.map(f => f.origin.iata)), new Set(selected.slice(0, 4).map(a => a.iata)));
  assert.equal(data.recommendation, null);
  assert.ok(data.earliest_candidate);
  assert.match(data.warnings.join(' '), /查询时间已到.*剩余机场未查询/);
  assert.equal(env.sqlite.prepare('SELECT requests FROM travel_usage').get().requests, 4);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM travel_cache').get().n, 4);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM travel_locks').get().n, 0);
});

test('a delayed inter-airport pause rechecks the budget before billing or starting another request', async t => {
  const env = environment(t), calls = [], pauses = [];
  let wall = NOW;
  const response = await search(env, query({ airports: [{ iata: 'NKG', travel_minutes: 60 }, { iata: 'PVG', travel_minutes: 240 }] }), {
    wallNow: () => wall,
    // A stalled scheduler may resume much later than its requested delay.
    pause: async ms => { pauses.push(ms); wall += 22000; },
    fetchImpl: async (url, init) => {
      calls.push({ url, init }); wall += 7000;
      return Response.json({ departures: [row()] });
    },
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(pauses, [1100]);
  assert.equal(wall - NOW, 29000);
  assert.equal(data.provider.status, 'live');
  assert.equal(data.flights.length, 1); assert.equal(data.flights[0].origin.iata, 'NKG');
  assert.match(data.warnings.join(' '), /查询时间已到.*剩余机场未查询/);
  assert.equal(env.sqlite.prepare('SELECT requests FROM travel_usage').get().requests, 1);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM travel_locks').get().n, 0);
});

test('request validation runs before network and rejects unsupported routes, dates, airports and huge bodies', async t => {
  const env = environment(t); let calls = 0;
  const fetchImpl = async () => { calls++; throw Error('Unexpected network'); };
  for (const input of [query({ airports: [] }), query({ airports: ['LAX'] }),
    query({ departure_date: '2026-02-30' }), query({ departure_date: '2026-12-01' }), query({ departure_date: '2026-10-28' }),
    query({ earliest_departure: '2026-10-29T12:00 CST' }),
    query({ airports: AIRPORTS.slice(0, 7).map(a => a.iata) }),
  ]) assert.equal((await search(env, input, { fetchImpl })).status, 400, JSON.stringify(input));
  const huge = await handleTravel(post('/api/travel/config', { api_key: 'a'.repeat(17000) }), env, options());
  assert.equal(huge.status, 400);
  assert.equal((await handleTravel(request('/api/travel/search'), env, options())).status, 405);
  assert.equal((await handleTravel(request('/api/travel/unknown'), env, options())).status, 404);
  assert.equal(await handleTravel(request('/api/unrelated'), env, options()), null);
  assert.equal(calls, 0);
});

test('worker protects travel config, search and unknown endpoints and applies same-origin write checks', async t => {
  const env = environment(t, { key: null, fullSchema: true });
  env.OWNER_ACCESS_KEY = 'fixture-owner-access-key-'.repeat(2); env.AUTH_SECRET = 'fixture-owner-auth-secret-'.repeat(2);
  let assets = 0; env.ASSETS = { async fetch() { assets++; throw Error('Unexpected static fallback'); } };
  const ctx = { waitUntil() { throw Error('Unexpected background task'); } };
  for (const path of ['/api/travel/config', '/api/travel/search', '/api/travel/unknown']) {
    const response = await worker.fetch(request(path, { headers: { 'oai-authenticated-user-id': 'terminal-owner' } }), env, ctx);
    assert.equal(response.status, 401); assert.equal((await response.json()).code, 'AUTH_REQUIRED');
  }
  const login = await worker.fetch(post('/auth/login', { accessKey: env.OWNER_ACCESS_KEY }), env, ctx);
  assert.equal(login.status, 200); const cookie = login.headers.get('Set-Cookie').split(';')[0];
  const config = await worker.fetch(request('/api/travel/config', { headers: { Cookie: cookie } }), env, ctx);
  assert.equal(config.status, 200); assert.equal((await config.json()).provider.configured, false);
  assert.equal(config.headers.get('X-Content-Type-Options'), 'nosniff');
  for (const path of ['/api/travel/config', '/api/travel/search']) {
    const denied = await worker.fetch(post(path, {}, { Cookie: cookie, Origin: 'https://attacker.example' }), env, ctx);
    assert.equal(denied.status, 403);
  }
  const allowed = await worker.fetch(post('/api/travel/search', query(), { Cookie: cookie }), env, ctx);
  assert.equal(allowed.status, 200); assert.deepEqual((await allowed.json()).flights, []);
  const unknown = await worker.fetch(request('/api/travel/unknown', { headers: { Cookie: cookie } }), env, ctx);
  assert.equal(unknown.status, 404); assert.equal(assets, 0);
});
