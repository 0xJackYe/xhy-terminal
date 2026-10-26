import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDiary } from '../site/lib.mjs';
import { writeDrafts } from '../site/draft-storage.mjs';

const key = 'test-drafts';
const meal = id => ({
  id, type: 'snack', status: 'eaten', title: id,
  items: [{ name: '测试食材', amount: 100, unit: 'g', nutrition: { kcal: 100, protein: null, carbs: null, fat: null, fiber: null, saturatedFat: null } }]
});
const day = meals => ({ date: '2026-10-25', title: '测试日记', note: '', meals });
function memoryStorage(initial) {
  const values = new Map([[key, initial]]);
  return {
    writes: 0,
    getItem: name => values.get(name) ?? null,
    setItem(name, value) { this.writes++; values.set(name, value); }
  };
}

test('成功写入草稿后返回完整合并状态，存储内容可重新验证读取', () => {
  const canonical = [day([meal('canonical')])];
  const incoming = [day([meal('draft')])];
  const before = structuredClone({ canonical, incoming });
  const storage = memoryStorage(null);
  const saved = writeDrafts(canonical, incoming, { storage, key });
  const reloaded = validateDiary(JSON.parse(storage.getItem(key)));
  assert.deepEqual(reloaded.days, incoming);
  assert.deepEqual(saved.drafts, incoming);
  assert.deepEqual(saved.days[0].meals.map(entry => entry.id), ['canonical', 'draft']);
  assert.equal(storage.writes, 1);
  assert.deepEqual({ canonical, incoming }, before);
  saved.drafts[0].meals[0].title = '返回草稿的修改';
  saved.days[0].meals[0].title = '返回合并结果的修改';
  assert.deepEqual({ canonical, incoming }, before);
  assert.deepEqual(JSON.parse(storage.getItem(key)), reloaded);
});

test('存储配额失败抛出明确错误，原数组与已有存储内容保持完整', () => {
  const canonical = [day([meal('canonical')])];
  const existing = [day([meal('existing')])];
  const incoming = [day([...existing[0].meals, meal('new')])];
  const before = structuredClone({ canonical, existing, incoming });
  const previous = JSON.stringify({ schemaVersion: 1, days: existing });
  const storage = memoryStorage(previous);
  storage.setItem = () => { throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); };
  assert.throws(() => writeDrafts(canonical, incoming, { storage, key }), /未能保存.*本次修改尚未保存/);
  assert.deepEqual({ canonical, existing, incoming }, before);
  assert.equal(storage.getItem(key), previous);
});

test('分别有效的输入合并后超过每日30餐时，拒绝写入任何草稿', () => {
  const canonical = [day(Array.from({ length: 30 }, (_, index) => meal(`saved-${index}`)))];
  const incoming = [day([meal('new')])];
  const before = structuredClone({ canonical, incoming });
  const storage = memoryStorage('previous-value');
  assert.throws(() => writeDrafts(canonical, incoming, { storage, key }), /餐食数据无效/);
  assert.equal(storage.writes, 0);
  assert.equal(storage.getItem(key), 'previous-value');
  assert.deepEqual({ canonical, incoming }, before);
});
