import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDiaryChat, hasPersistentDiary, diaryStorageLabel } from '../site/diary-chat.js';
import { createSnapshotRefresh } from '../site/diary-refresh.mjs';

function chatDOM(t) {
  class Node {
    constructor() { this.value = ''; this.textContent = ''; this.dataset = {}; this.childNodes = []; this.handlers = {}; this.selectionStart = this.selectionEnd = 0; }
    append(...children) { this.childNodes.push(...children); }
    replaceChildren(...children) { this.childNodes = children; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    getAttribute(name) { return name === 'data-state' ? this.dataset.state ?? null : null; }
    removeAttribute(name) { if (name === 'data-state') delete this.dataset.state; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    focus() {}
    emit(type) { this.handlers[type]?.({ preventDefault() {} }); }
  }
  const nodes = new Map(), old = globalThis.document;
  const get = selector => { if (!nodes.has(selector)) nodes.set(selector, new Node()); return nodes.get(selector); };
  globalThis.document = { baseURI: 'https://fixture.example/diet/', querySelector: get, querySelectorAll: () => [], createElement: () => new Node() };
  t.after(() => { if (old === undefined) delete globalThis.document; else globalThis.document = old; });
  return get;
}
const waitFor = async predicate => {
  for (let count = 0; count < 50; count++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('UI action did not complete');
};

test('cloud and local chat show durable storage while unavailable API remains browser draft mode', t => {
  const get = chatDOM(t);
  const state = { persistence: 'cloud', revision: 8, draftDays: [], canUndo: true };
  const chat = setupDiaryChat({ getState: () => state, setBusy() {} });
  assert.equal(get('#diary-chat-submit').disabled, false);
  assert.equal(get('#diary-chat-storage').textContent, '云端日记 · 已同步，版本 8');
  assert.match(get('.chat-privacy').textContent, /写入云端日记/);
  assert(!get('#diary-chat-storage').textContent.includes('草稿模式'));
  state.draftDays = [{ date: '2026-10-28' }]; chat.update();
  assert.equal(get('#diary-chat-sync').disabled, false); assert.equal(get('#diary-chat-sync').hidden, false);
  assert.match(get('#diary-chat-storage').textContent, /1 天草稿待同步/);
  state.persistence = 'local'; state.draftDays = []; chat.update();
  assert.equal(get('#diary-chat-storage').textContent, '日记保存在本机 · 已同步，版本 8');
  assert.match(get('.chat-privacy').textContent, /写入本机日记/);
  state.persistence = 'unavailable'; state.draftDays = [{ date: '2026-10-28' }]; chat.update();
  assert.equal(get('#diary-chat-submit').disabled, true); assert.equal(get('#diary-chat-sync').disabled, true);
  assert.match(get('#diary-chat-storage').textContent, /浏览器草稿模式/);
  assert(!get('.chat-privacy').textContent.includes('写入本机日记'));
});

test('saved cloud AI response updates the status and revision without claiming local storage', async t => {
  const get = chatDOM(t), oldFetch = globalThis.fetch;
  const state = { persistence: 'cloud', revision: 8, draftDays: [], canUndo: false };
  let applied = 0, requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++; assert.equal(new URL(url).pathname, '/diet/api/diary-chat'); assert.equal(init.method, 'POST');
    return Response.json({ diary: { days: [] }, persistence: 'cloud', revision: 9, canUndo: true, saved: true, reply: '已更正。', changes: [{ date: '2026-10-28', action: '修改', title: '晚餐' }] });
  };
  t.after(() => { globalThis.fetch = oldFetch; });
  setupDiaryChat({ getState: () => state, setBusy() {}, applySnapshot: async result => { applied++; Object.assign(state, result); } });
  get('#diary-chat-text').value = '把今天晚餐改成两份'; get('#diary-chat-form').emit('submit');
  await waitFor(() => get('#diary-chat-status').dataset.state === 'success');
  assert.equal(requests, 1); assert.equal(applied, 1);
  assert.equal(get('#diary-chat-status').textContent, '已保存到云端日记 · 1 项变更。');
  assert.equal(get('#diary-chat-storage').textContent, '云端日记 · 已同步，版本 9');
  assert.equal(get('#diary-chat-text').value, ''); assert.equal(get('#diary-chat-undo').disabled, false);
});

test('syncing a browser draft to cloud shows the real destination', async t => {
  const get = chatDOM(t), state = { persistence: 'cloud', revision: 2, draftDays: [{ date: '2026-10-28' }], canUndo: false };
  setupDiaryChat({ getState: () => state, setBusy() {}, syncDrafts: async () => { state.draftDays = []; state.revision++; } });
  get('#diary-chat-sync').emit('click');
  await waitFor(() => get('#diary-chat-status').textContent === '浏览器草稿已同步到云端日记。');
  assert.equal(get('#diary-chat-storage').textContent, '云端日记 · 已同步，版本 3');
  assert.equal(get('#diary-chat-sync').hidden, true);
});

test('both durable backends can auto-refresh newer snapshots while browser drafts cannot', async () => {
  for (const persistence of ['cloud', 'local', 'unavailable']) {
    let revision = 1, reads = 0;
    const refresh = createSnapshotRefresh({
      isSafe: () => hasPersistentDiary(persistence), getRevision: () => revision,
      read: async () => { reads++; return { revision: 2, persistence }; }, apply: async snapshot => { revision = snapshot.revision; },
    });
    assert.equal(await refresh(), persistence !== 'unavailable');
    assert.equal(reads, persistence === 'unavailable' ? 0 : 1);
    assert.equal(revision, persistence === 'unavailable' ? 1 : 2);
  }
  assert.equal(diaryStorageLabel('cloud'), '云端日记');
  assert.equal(diaryStorageLabel('local'), '本机日记');
  assert.equal(diaryStorageLabel('unavailable'), '浏览器草稿');
  assert.equal(hasPersistentDiary(undefined), false);
});
