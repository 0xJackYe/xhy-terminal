import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDays } from '../site/lib.mjs';
import { applyParsedMeals, undoParsedMeals } from '../site/quick-merge.mjs';

const item = (name, id = name) => ({ id, name, unit: 'g', amount: 100, nutrition: { kcal: 100, protein: 2, carbs: 10, fat: 4, fiber: null, saturatedFat: null } });
const meal = (id, type, name, overrides = {}) => ({ id, type, title: name, status: 'eaten', note: '', items: [item(name)], ...overrides });
const day = (date, meals, overrides = {}) => ({ date, title: '原来的日记', note: '原来的备注', source: { reportedAt: '2026-10-25' }, meals, ...overrides });
const canonical = () => [day('2026-10-23', [meal('2026-10-23-breakfast', 'breakfast', '鸡蛋')]), day('2026-10-24', [meal('2026-10-25-breakfast', 'breakfast', '燕麦'), meal('2026-10-25-lunch', 'lunch', '米饭'), meal('2026-10-25-dinner', 'dinner', '牛排', { status: 'planned' })])];

test('single meal appends to the original breakfast card and preserves other meals and metadata', () => {
  const saved = canonical();
  const before = structuredClone(saved);
  const incoming = [day('2026-10-24', [meal('request-one-breakfast', 'breakfast', '牛奶')], { title: '新标题', note: '新备注', source: 'AI' })];
  const result = applyParsedMeals(saved, [], incoming);
  const merged = mergeDays(saved, result.drafts);
  assert.equal(merged[1].meals.length, 3);
  assert.equal(merged[1].meals[0].id, '2026-10-25-breakfast');
  assert.deepEqual(merged[1].meals[0].items.map(food => food.name), ['燕麦', '牛奶']);
  assert.equal(merged[1].meals[0].title, '燕麦');
  assert.equal(merged[1].title, '原来的日记');
  assert.equal(merged[1].note, '原来的备注');
  assert.deepEqual(merged[1].source, before[1].source);
  assert.deepEqual(merged[1].meals.slice(1), before[1].meals.slice(1));
  assert.deepEqual(saved, before);
  assert.deepEqual(result.dates, ['2026-10-24']);
  assert.equal(result.mealCount, 1);
});

test('full day fills three separate cards and keeps original dates', () => {
  const saved = canonical();
  const incoming = [day('2026-10-26', [meal('r-b', 'breakfast', '面包'), meal('r-l', 'lunch', '米饭'), meal('r-d', 'dinner', '鱼')])];
  const result = applyParsedMeals(saved, [], incoming);
  const merged = mergeDays(saved, result.drafts);
  assert.deepEqual(merged.map(entry => entry.date), ['2026-10-23', '2026-10-24', '2026-10-26']);
  assert.deepEqual(merged.slice(0, 2), saved);
  assert.deepEqual(merged[2].meals.map(entry => entry.type), ['breakfast', 'lunch', 'dinner']);
  assert.equal(result.mealCount, 3);
});

test('request scoped ingestion IDs make retries idempotent and item IDs remain unique', () => {
  const incoming = [day('2026-10-24', [meal('arbitrary-request-uuid', 'breakfast', '燕麦')])];
  const first = applyParsedMeals(canonical(), [], incoming);
  const second = applyParsedMeals(canonical(), first.drafts, incoming);
  assert.deepEqual(second.drafts, first.drafts);
  assert.equal(second.alreadyApplied, true);
  assert.equal(second.mealCount, 0);
  const breakfast = first.drafts[0].meals[0];
  assert.equal(new Set(breakfast.items.map(food => food.id)).size, 2);
  assert.deepEqual(breakfast.ingestionIds, ['arbitrary-request-uuid']);
});

test('undo restores canonical card, and leaves unrelated new meal intact', () => {
  const saved = canonical();
  const applied = applyParsedMeals(saved, [], [day('2026-10-24', [meal('r-b', 'breakfast', '牛奶')])]);
  const after = structuredClone(applied.drafts);
  after[0].meals.push(meal('manual-snack', 'snack', '苹果'));
  const undone = undoParsedMeals(saved, after, applied.undoToken);
  const merged = mergeDays(saved, undone.drafts);
  assert.deepEqual(merged[1].meals[0], saved[1].meals[0]);
  assert.equal(merged[1].meals.at(-1).id, 'manual-snack');
  assert.equal(undone.removedCount, 1);
  assert.equal(undone.preservedCount, 0);
});

test('undo preserves later manual changes while reverting untouched cards to previous draft', () => {
  const saved = canonical();
  const previous = [day('2026-10-24', [meal('2026-10-25-breakfast', 'breakfast', '自定义早餐')])];
  const applied = applyParsedMeals(saved, previous, [day('2026-10-24', [meal('r-b', 'breakfast', '牛奶'), meal('r-l', 'lunch', '青菜')])]);
  const changed = structuredClone(applied.drafts);
  changed[0].meals.find(entry => entry.type === 'lunch').title = '后续手动修改';
  const undone = undoParsedMeals(saved, changed, applied.undoToken);
  assert.deepEqual(undone.drafts[0].meals[0], previous[0].meals[0]);
  assert.equal(undone.drafts[0].meals[1].title, '后续手动修改');
  assert.equal(undone.removedCount, 1);
  assert.equal(undone.preservedCount, 1);
  assert.equal(changed[0].meals[0].items.length, 2);
});

test('eaten meal does not consume a planned meal and undo removes empty new draft day', () => {
  const saved = canonical();
  const applied = applyParsedMeals(saved, [], [day('2026-10-24', [meal('r-d', 'dinner', '鱼')])]);
  const merged = mergeDays(saved, applied.drafts);
  assert.equal(merged[1].meals.length, 4);
  assert.deepEqual(merged[1].meals[2], saved[1].meals[2]);
  assert.equal(merged[1].meals[3].status, 'eaten');
  const undone = undoParsedMeals(saved, applied.drafts, applied.undoToken);
  assert.deepEqual(undone.drafts, []);
  assert.deepEqual(mergeDays(saved, undone.drafts), saved);
});

test('rejects malformed parsed diary before creating any overlay', () => {
  assert.throws(() => applyParsedMeals(canonical(), [], [day('2026-02-30', [])]), /日期/);
});
