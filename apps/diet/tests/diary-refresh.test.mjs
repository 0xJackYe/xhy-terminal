import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotRefresh } from '../site/diary-refresh.mjs';

test('读取到其他窗口的新版本后更新；同版本不重复重绘', async () => {
  let revision = 1, reads = 0, applied = 0;
  const refresh = createSnapshotRefresh({
    read: async () => { reads++; return { revision: 2 }; },
    apply: async snapshot => { applied++; revision = snapshot.revision; },
    getRevision: () => revision, isSafe: () => true
  });
  assert.equal(await refresh(), true);
  assert.equal(await refresh(), false);
  assert.equal(reads, 2); assert.equal(applied, 1); assert.equal(revision, 2);
});

test('未保存输入、后台页面或正在保存时不开始读取', async () => {
  let safe = false, reads = 0;
  const refresh = createSnapshotRefresh({ read: async () => { reads++; return { revision: 2 }; },
    apply: () => {}, getRevision: () => 1, isSafe: () => safe });
  assert.equal(await refresh(), false); assert.equal(reads, 0);
});

test('旧版本响应不能覆盖当前日记', async () => {
  let applied = false;
  const refresh = createSnapshotRefresh({ read: async () => ({ revision: 1 }),
    apply: () => { applied = true; }, getRevision: () => 3, isSafe: () => true });
  assert.equal(await refresh(), false); assert.equal(applied, false);
});

test('读取过程中用户开始修改或本机已保存新版本，丢弃过期响应', async () => {
  for (const changed of ['editing', 'revision']) {
    let safe = true, revision = 1, finish, applied = false;
    const refresh = createSnapshotRefresh({ read: () => new Promise(resolve => { finish = resolve; }),
      apply: () => { applied = true; }, getRevision: () => revision, isSafe: () => safe });
    const pending = refresh();
    if (changed === 'editing') safe = false; else revision = 3;
    finish({ revision: 2 });
    assert.equal(await pending, false); assert.equal(applied, false);
  }
});

test('合并并发读取，读取失败后允许下次重试', async () => {
  let finish, reads = 0;
  const refresh = createSnapshotRefresh({ read: () => { reads++; return new Promise((_, reject) => { finish = reject; }); },
    apply: () => {}, getRevision: () => 1, isSafe: () => true });
  const first = refresh();
  assert.equal(await refresh(), false); assert.equal(reads, 1);
  finish(new Error('offline')); await assert.rejects(first, /offline/);
  const retry = refresh(); assert.equal(reads, 2);
  finish(new Error('offline')); await assert.rejects(retry, /offline/);
});
