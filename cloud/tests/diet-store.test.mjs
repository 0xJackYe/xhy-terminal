import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DIET_SCHEMA, createD1DiaryStore, importD1DiaryState } from '../diary-store.mjs';
import { sqliteD1Fixture } from './diet-sqlite-fixture.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const seed = () => ({ schemaVersion: 1, timezone: 'Asia/Shanghai', updatedAt: '2026-01-01T00:00:00Z', days: [] });
const changed = n => ({ ...seed(), updatedAt: `2026-01-${String(n).padStart(2, '0')}T00:00:00Z` });
const receipt = (id, diary, revision, extra = {}) => ({ requestId: id, fingerprint: 'a'.repeat(64),
  result: { diary, revision, saved: true, reply: 'fixture', changes: [] }, undoable: true, ...extra });
async function fixture(t, options = {}) {
  const db = await sqliteD1Fixture();
  t.after(() => db.close());
  await db.exec(DIET_SCHEMA);
  return { db, store: createD1DiaryStore({ db, seed: seed(), ...options }) };
}

test('cloud store starts from explicit seed without exposing mutable shared objects', async t => {
  const { db, store } = await fixture(t);
  const initial = await store.load('owner');
  assert.deepEqual(initial, { diary: seed(), revision: 0, canUndo: false });
  initial.diary.days.push('client mutation');
  assert.deepEqual((await store.load('owner')).diary.days, []);
  assert.equal(store.persistence, 'cloud');
  assert.ok(db.sessions.every(value => value === 'first-primary'));
});

test('missing migration is an error instead of silently inventing an empty diary', async t => {
  const { db } = await fixture(t);
  await assert.rejects(createD1DiaryStore({ db }).load('uninitialized'), /not initialized/);
});

test('CAS commits persist across independent store instances, retain undo and durable receipts', async t => {
  const { db, store } = await fixture(t);
  await store.load('owner');
  const next = changed(2), item = receipt('edit-1', next, 1);
  assert.deepEqual(await store.commit('owner', 0, next, item), { committed: true });
  const separate = createD1DiaryStore({ db });
  assert.deepEqual(await separate.load('owner'), { diary: next, revision: 1, canUndo: true });
  assert.deepEqual(await separate.loadUndo('owner'), { diary: seed() });
  assert.deepEqual(await separate.findReceipt('owner', 'edit-1'), item);
  assert.deepEqual(await separate.commit('owner', 0, changed(3), item), { committed: false, receipt: item });
  assert.equal((await separate.load('owner')).revision, 1);
});

test('stale revision cannot overwrite another client or append its receipt', async t => {
  const { store } = await fixture(t);
  await store.load('owner');
  await store.commit('owner', 0, changed(2), receipt('winner', changed(2), 1));
  assert.deepEqual(await store.commit('owner', 0, changed(3), receipt('stale', changed(3), 1)), { committed: false });
  assert.equal((await store.load('owner')).diary.updatedAt, changed(2).updatedAt);
  assert.equal(await store.findReceipt('owner', 'stale'), null);
});

test('concurrent writers are serialized by real SQLite CAS transaction semantics', async t => {
  const { db, store } = await fixture(t);
  await store.load('owner');
  const second = createD1DiaryStore({ db });
  const results = await Promise.all([
    store.commit('owner', 0, changed(2), receipt('one', changed(2), 1)),
    second.commit('owner', 0, changed(3), receipt('two', changed(3), 1))
  ]);
  assert.equal(results.filter(result => result.committed).length, 1);
  assert.equal((await store.load('owner')).revision, 1);
  assert.equal((await store.listBackups('owner')).length, 1);
});

test('same request retried concurrently saves exactly one revision', async t => {
  const { db, store } = await fixture(t);
  await store.load('owner');
  const item = receipt('same', changed(2), 1), second = createD1DiaryStore({ db });
  const results = await Promise.all([store.commit('owner', 0, changed(2), item), second.commit('owner', 0, changed(2), item)]);
  assert.equal(results.filter(result => result.committed).length, 1);
  assert.equal((await store.load('owner')).revision, 1);
  assert.deepEqual(await store.findReceipt('owner', 'same'), item);
});

test('backup or receipt statement failure rolls back state and every partial write', async t => {
  const { db, store } = await fixture(t);
  await store.load('owner');
  for (const failAt of [0, 1, 2, 3]) {
    db.failBatchAt = failAt;
    await assert.rejects(store.commit('owner', 0, changed(2), receipt(`failure-${failAt}`, changed(2), 1)), /transaction failed/);
    assert.deepEqual(await store.load('owner'), { diary: seed(), revision: 0, canUndo: false });
    assert.deepEqual(await store.listBackups('owner'), []);
    assert.equal(await store.findReceipt('owner', `failure-${failAt}`), null);
  }
});

test('undo reset is durable while read-only chat keeps the previous undo point', async t => {
  const { store } = await fixture(t);
  await store.load('owner');
  await store.commit('owner', 0, changed(2), receipt('edit', changed(2), 1));
  await store.commit('owner', 1, changed(2), receipt('query', changed(2), 2, { undoable: false }));
  assert.deepEqual(await store.loadUndo('owner'), { diary: seed() });
  await store.commit('owner', 2, seed(), receipt('undo', seed(), 3, { resetUndo: true, undoable: false }));
  assert.equal(await store.loadUndo('owner'), null);
  assert.equal((await store.load('owner')).canUndo, false);
});

test('bounded backups and receipts remain isolated by owner', async t => {
  const { store } = await fixture(t, { backupLimit: 2, receiptLimit: 3 });
  await store.load('owner-a');
  await store.load('owner-b');
  for (let i = 0; i < 5; i++) await store.commit('owner-a', i, changed(i + 2), receipt(`r-${i}`, changed(i + 2), i + 1));
  assert.deepEqual((await store.listBackups('owner-a')).map(row => row.revision), [4, 3]);
  assert.equal(await store.findReceipt('owner-a', 'r-0'), null);
  assert.ok(await store.findReceipt('owner-a', 'r-4'));
  assert.equal(await store.findReceipt('owner-b', 'r-4'), null);
  assert.deepEqual(await store.load('owner-b'), { diary: seed(), revision: 0, canUndo: false });
});

test('restore creates a new CAS revision and remains undoable without rewinding history', async t => {
  const { store } = await fixture(t);
  await store.load('owner');
  await store.commit('owner', 0, changed(2), receipt('edit', changed(2), 1));
  assert.deepEqual(await store.restoreBackup('owner', 1, 0, receipt('restore', seed(), 2)), { committed: true });
  assert.equal((await store.load('owner')).revision, 2);
  assert.deepEqual((await store.load('owner')).diary, seed());
  assert.deepEqual(await store.loadUndo('owner'), { diary: changed(2) });
});

test('one-time import preserves original revision, receipts, undo and backup envelopes', async t => {
  const { db } = await fixture(t);
  const item = receipt('imported-request', changed(3), 7);
  const input = { revision: 7, diary: changed(3), undo: { diary: changed(2) }, receipts: [item] };
  assert.deepEqual(await importD1DiaryState(db, 'owner', input, { backups: [{ revision: 6, diary: changed(2) }] }), { imported: true });
  const store = createD1DiaryStore({ db });
  assert.deepEqual(await store.load('owner'), { revision: 7, diary: changed(3), canUndo: true });
  assert.deepEqual(await store.loadUndo('owner'), input.undo);
  assert.deepEqual(await store.findReceipt('owner', item.requestId), item);
  assert.deepEqual((await store.loadBackup('owner', 6)).diary, changed(2));
  assert.deepEqual(await importD1DiaryState(db, 'owner', { revision: 0, diary: seed(), receipts: [] }), { imported: false });
  assert.equal((await store.load('owner')).revision, 7);
});

test('invalid import and oversized revision cannot corrupt existing cloud data', async t => {
  const { db, store } = await fixture(t);
  await store.load('owner');
  await assert.rejects(importD1DiaryState(db, 'owner', { revision: 1, diary: { days: [] } }));
  await assert.rejects(store.commit('owner', Number.MAX_SAFE_INTEGER, seed(), receipt('overflow', seed(), 1)));
  await assert.rejects(store.commit('owner', 0, { schemaVersion: 1, days: ['invalid'] }, receipt('invalid', seed(), 1)));
  assert.equal((await store.load('owner')).revision, 0);
});
