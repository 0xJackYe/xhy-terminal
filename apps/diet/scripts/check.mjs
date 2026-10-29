import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NUTRIENTS, validateDiary, estimate, dayTotal, nutritionTotal } from '../site/lib.mjs';

const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const [diary, catalog] = await Promise.all([
  readJson('../data/diary.json'), readJson('../data/foods.json')
]);

validateDiary(diary);
// New diaries record dates on UTC+0; diaries started earlier still carry their Beijing-time label.
assert.ok(['UTC', 'Asia/Shanghai'].includes(diary.timezone), '日记时区应为 UTC（较早的日记为 Asia/Shanghai）');
assert.equal(catalog.schemaVersion, 1, '食材库版本无效');
assert.ok(Array.isArray(catalog.sources) && catalog.sources.length, '食材库需要营养来源');
assert.ok(Array.isArray(catalog.foods) && catalog.foods.length, '食材库不能为空');

function uniqueIds(records, label) {
  const ids = new Set();
  for (const record of records) {
    assert.ok(typeof record.id === 'string' && record.id.trim(), `${label} ID 不能为空`);
    assert.ok(!ids.has(record.id), `${label} ID 重复：${record.id}`);
    ids.add(record.id);
  }
  return ids;
}

const sourceIds = uniqueIds(catalog.sources, '来源');
const foodIds = uniqueIds(catalog.foods, '食材');
for (const source of catalog.sources) {
  assert.ok(typeof source.name === 'string' && source.name.trim(), `来源 ${source.id} 缺少名称`);
  assert.ok(['https:', 'http:'].includes(new URL(source.url).protocol), `来源 ${source.id} URL 无效`);
}
for (const food of catalog.foods) {
  assert.ok(sourceIds.has(food.sourceId), `食材 ${food.id} 引用了不存在的来源`);
  assert.ok(typeof food.name === 'string' && food.name.trim(), `食材 ${food.id} 缺少名称`);
  assert.ok(typeof food.basis === 'string' && food.basis.trim(), `食材 ${food.id} 缺少重量依据`);
  assert.ok(['g', 'ml'].includes(food.unit), `食材 ${food.id} 单位无效`);
  assert.ok(food.per100 && typeof food.per100 === 'object', `食材 ${food.id} 缺少每100单位营养`);
  for (const key of NUTRIENTS) {
    const value = food.per100[key];
    assert.ok(Object.hasOwn(food.per100, key), `食材 ${food.id} 缺少 ${key}`);
    assert.ok(value === null || (Number.isFinite(value) && value >= 0 && value <= 100000),
      `食材 ${food.id} 的 ${key} 必须为非负有限数字或 null`);
  }
}

const foodById = new Map(catalog.foods.map(food => [food.id, food]));
const mealIds = new Set();
for (const day of diary.days) {
  for (const meal of day.meals) {
    assert.ok(!mealIds.has(meal.id), `跨日期餐食 ID 重复：${meal.id}`);
    mealIds.add(meal.id);
    uniqueIds(meal.items, `${day.date} ${meal.id} 的食材`);
    for (const item of meal.items) {
      // 自定义食材只有手工热量估算，未关联参考食材时不做换算比对。
      if (item.foodId == null) continue;
      assert.ok(foodIds.has(item.foodId), `食材 ${item.id} 引用了不存在的 foodId：${item.foodId}`);
      const expected = estimate(foodById.get(item.foodId), item.amount);
      for (const key of NUTRIENTS) {
        const actual = item.nutrition[key];
        assert.ok(expected[key] === null ? actual === null
          : Number.isFinite(actual) && Math.abs(actual - expected[key]) <= 0.020000001,
        `${day.date} ${meal.id} ${item.id} 的 ${key} 与参考估算不符`);
      }
    }
  }
  const eatenItems = day.meals.filter(meal => meal.status === 'eaten').flatMap(meal => meal.items);
  assert.deepEqual(dayTotal(day), nutritionTotal(eatenItems), `${day.date} 的已吃总量包含了计划餐`);
}

console.log(`检查通过：${diary.days.length} 天日记，${mealIds.size} 餐，${catalog.foods.length} 种食材，${catalog.sources.length} 个营养来源。`);
