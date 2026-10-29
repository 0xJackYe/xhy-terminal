import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { handleDiet } from '../diet.mjs';
import { createD1DiaryStore, DIET_SCHEMA } from '../diary-store.mjs';
import { sqliteD1Fixture } from './diet-sqlite-fixture.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const origin = 'https://fixture.pages.dev';
const fakeKey = 'fixture-model-key-not-a-real-credential';
const diary = () => ({ schemaVersion: 1, timezone: 'Asia/Shanghai', updatedAt: '2026-01-02T00:00:00Z',
  days: [{ date: '2026-01-02', title: 'Fixture day', note: '', meals: [] }] });
const catalog = { schemaVersion: 1, sources: [], foods: [] };
const input = (overrides = {}) => ({ text: 'fixture edit', requestId: randomUUID(), recordDate: '2026-01-02',
  expectedRevision: 0, history: [], draftDays: [], ...overrides });
const request = (path, body, headers = {}) => new Request(origin + '/diet' + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

async function fixture(t) {
  const db = await sqliteD1Fixture();
  t.after(() => db.close());
  await db.exec(DIET_SCHEMA);
  const owner = 'fixture-' + randomUUID();
  const store = createD1DiaryStore({ db, seed: diary() });
  await store.load(owner);
  return { db, owner, store, env: { DB: db, DEEPSEEK_API_KEY: fakeKey, DEEPSEEK_MODEL: 'fixture-model' },
    context: { owner, catalog, diaryStore: store } };
}

test('diet namespace serves the prefixed static asset binding without a DB dependency', async () => {
  const seen = [];
  const env = { ASSETS: { async fetch(req) { seen.push(new URL(req.url).pathname); return new Response('<html>fixture</html>'); } } };
  const response = await handleDiet(new Request(origin + '/diet/'), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<html>fixture</html>');
  assert.deepEqual(seen, ['/diet/index.html']);
  const redirect = await handleDiet(new Request(origin + '/diet?view=calendar'), env);
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('Location'), '/diet/?view=calendar');
  assert.equal(await handleDiet(new Request(origin + '/dietish/'), env), null);
  const missing = await handleDiet(request('/api/not-found'), {});
  assert.equal(missing.status, 404);
});

test('GET API and compatibility data URL use the current cloud diary and safe configuration metadata', async t => {
  const { store, owner, env, context } = await fixture(t);
  const updated = diary(); updated.days[0].note = 'Cloud saved note';
  await store.commit(owner, 0, updated, { requestId: 'fixture-receipt', fingerprint: 'f'.repeat(64),
    result: { diary: updated, revision: 1 }, undoable: true });
  const api = await handleDiet(request('/api/diary'), env, context);
  assert.equal(api.status, 200);
  assert.equal(api.headers.get('Cache-Control'), 'no-store');
  const state = await api.json();
  assert.equal(state.revision, 1);
  assert.equal(state.persistence, 'cloud');
  assert.equal(state.apiConfigured, true);
  assert.equal(state.diary.days[0].note, 'Cloud saved note');
  assert.equal(state.model, 'fixture-model');
  assert.ok(!JSON.stringify(state).includes(fakeKey));
  const asset = await handleDiet(request('/data/diary.json'), env, context);
  assert.deepEqual(await asset.json(), updated);
  const head = await handleDiet(new Request(origin + '/diet/data/diary.json', { method: 'HEAD' }), env, context);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('visitor owner headers cannot select another cloud diary', async t => {
  const { store, env, context } = await fixture(t);
  await store.initialize('forged-visitor-owner', { revision: 19, diary: { ...diary(), updatedAt: '1999-01-01T00:00:00Z' }, receipts: [] });
  const response = await handleDiet(request('/api/diary', undefined, { 'oai-authenticated-user-id': 'forged-visitor-owner' }), env, context);
  const state = await response.json();
  assert.equal(state.revision, 0);
  assert.equal(state.diary.updatedAt, diary().updatedAt);
});

test('sync, retry, changed retry, revision conflict and undo preserve durable API semantics', async t => {
  const { store, owner, env, context } = await fixture(t);
  const changedDay = { ...diary().days[0], note: 'Fixture draft' };
  const body = input({ draftDays: [changedDay] });
  const response = await handleDiet(request('/api/diary/sync', body), env, context);
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.revision, 1);
  assert.equal(saved.diary.days[0].note, 'Fixture draft');
  assert.equal(saved.canUndo, true);
  const retried = await handleDiet(request('/api/diary/sync', body), env, context);
  assert.deepEqual(await retried.json(), saved);
  assert.equal((await store.load(owner)).revision, 1);
  const conflict = await handleDiet(request('/api/diary/sync', { ...body, draftDays: [] }), env, context);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'REQUEST_CONFLICT');
  const stale = await handleDiet(request('/api/diary/sync', input()), env, context);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'REVISION_CONFLICT');
  const undoInput = input({ expectedRevision: 1 });
  const undo = await handleDiet(request('/api/diary/undo', undoInput), env, context);
  assert.equal(undo.status, 200);
  const reverted = await undo.json();
  assert.equal(reverted.revision, 2);
  assert.equal(reverted.canUndo, false);
  assert.deepEqual(reverted.diary, diary());
});

test('real AI adapter with a mocked upstream edits only the validated requested day and caches retry', async t => {
  const { store, owner, env, context } = await fixture(t);
  const body = input({ text: '把 2026-01-02 的随记改成 fixture note' });
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer ' + fakeKey);
    assert.equal(JSON.parse(options.body).model, 'fixture-model');
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      reply: 'Fixture note changed', operations: [{ action: 'update_day_note', date: '2026-01-02', note: 'fixture note' }]
    }) } }] }), { headers: { 'Content-Type': 'application/json' } });
  };
  const result = await handleDiet(request('/api/diary-chat', body), env, { ...context, fetchImpl });
  assert.equal(result.status, 200);
  const saved = await result.json();
  assert.equal(saved.diary.days[0].note, 'fixture note');
  assert.equal((await store.load(owner)).revision, 1);
  const repeated = await handleDiet(request('/api/diary-chat', body), env, { ...context, fetchImpl });
  assert.deepEqual(await repeated.json(), saved);
  assert.equal(calls, 1);
});

test('cross-origin or unsupported API writes never invoke the upstream model or mutate data', async t => {
  const { store, owner, env, context } = await fixture(t);
  let calls = 0;
  const options = { ...context, fetchImpl: async () => { calls++; throw new Error('must not run'); } };
  const foreign = await handleDiet(request('/api/diary-chat', input(), { Origin: 'https://foreign.invalid' }), env, options);
  assert.equal(foreign.status, 403);
  const crossSite = await handleDiet(request('/api/diary/sync', input(), { 'Sec-Fetch-Site': 'cross-site' }), env, options);
  assert.equal(crossSite.status, 403);
  const method = await handleDiet(new Request(origin + '/diet/api/diary', { method: 'DELETE' }), env, options);
  assert.equal(method.status, 405);
  assert.equal(calls, 0);
  assert.equal((await store.load(owner)).revision, 0);
});

test('storage/model failures keep prior records and never return the secret or raw provider error', async t => {
  const { db, store, owner, env, context } = await fixture(t);
  const changedDay = { ...diary().days[0], note: 'must roll back' };
  db.failBatchAt = 2;
  const failed = await handleDiet(request('/api/diary/sync', input({ draftDays: [changedDay] })), env, context);
  assert.equal(failed.status, 503);
  assert.equal((await store.load(owner)).revision, 0);
  assert.deepEqual((await store.load(owner)).diary, diary());
  const raw = await handleDiet(request('/api/diary-chat', input()), env, {
    ...context, fetchImpl: async () => { throw new Error('private upstream ' + fakeKey); }
  });
  assert.equal(raw.status, 502);
  assert.ok(!(await raw.text()).includes(fakeKey));
  assert.equal((await store.load(owner)).revision, 0);
});

test('parse-meals HTTP request uses the original validated natural language parser and remains non-persistent', async t => {
  const { store, owner, env, context } = await fixture(t);
  let calls = 0;
  const body = { text: 'Fixture snack 100g', recordDate: '2026-01-02', mealType: 'snack', requestId: randomUUID() };
  const fetchImpl = async () => {
    calls++;
    const payload = { meals: [{ date: '2026-01-02', type: 'snack', status: 'eaten', title: 'Fixture snack', note: '',
      items: [{ foodId: null, name: 'Fixture snack', amount: 100, unit: 'g', basis: 'fixture', estimatedPortion: false,
        note: '', nutrition: { kcal: 100, protein: 10, carbs: 10, fat: 2, fiber: null, saturatedFat: null } }] }], warnings: [] };
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] }),
      { headers: { 'Content-Type': 'application/json' } });
  };
  const result = await handleDiet(request('/api/parse-meals', body), env, { ...context, fetchImpl });
  assert.equal(result.status, 200);
  const parsed = await result.json();
  assert.equal(parsed.days[0].date, '2026-01-02');
  assert.equal(parsed.days[0].meals[0].items[0].nutrition.fiber, null);
  assert.equal(calls, 1);
  assert.equal((await store.load(owner)).revision, 0);
});

test('uninitialized cloud data stays unavailable while static recovery UI remains reachable', async t => {
  const db = await sqliteD1Fixture();
  t.after(() => db.close());
  await db.exec(DIET_SCHEMA);
  const missing = await handleDiet(request('/api/diary'), { DB: db }, { owner: 'new-unimported-owner' });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error.code, 'STORAGE_UNAVAILABLE');
  const html = await handleDiet(new Request(origin + '/diet/'), {}, { assets: { '/index.html': '<title>Recovery fixture</title>' } });
  assert.equal(html.status, 200);
  assert.equal(await html.text(), '<title>Recovery fixture</title>');
});
