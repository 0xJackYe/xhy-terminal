import test from 'node:test';
import assert from 'node:assert/strict';
import { DIARY_TIMEZONE, today } from '../site/lib.mjs';

test('日记按 UTC+0 换日：跨北京时间零点的夜班仍属同一天', () => {
  assert.equal(DIARY_TIMEZONE, 'UTC');
  // 北京时间 10-27 23:30、10-28 01:30 和 07:59 都在同一个 UTC 日内。
  assert.equal(today(new Date('2026-10-27T15:30:00Z')), '2026-10-27');
  assert.equal(today(new Date('2026-10-27T17:30:00Z')), '2026-10-27');
  assert.equal(today(new Date('2026-10-27T23:59:00Z')), '2026-10-27');
  // 北京时间 08:00 起才是新的一天。
  assert.equal(today(new Date('2026-10-28T00:00:00Z')), '2026-10-28');
});
