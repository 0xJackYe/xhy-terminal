import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NUTRIENTS, validDate, estimate, nutritionTotal, dayTotal, validateDay, validateDiary, mergeDays } from '../site/lib.mjs';
import { createDiaryFixture } from './diary-fixture.mjs';

const execFileAsync = promisify(execFile);
const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const diary = createDiaryFixture();
const catalog = await readJson('../data/foods.json');
function baseDay() {
  return {
    date: '2026-10-23', title: '测试日记', note: '',
    meals: ['breakfast', 'lunch', 'dinner'].map((type, index) => ({
      id: `fixture-${type}`, type, status: index === 2 ? 'planned' : 'eaten', title: type,
      items: [{
        id: `fixture-food-${index}`, foodId: null, name: '测试食材', amount: 100, unit: 'g',
        nutrition: { kcal: 100, protein: 10, carbs: 10, fat: 2, fiber: 1, saturatedFat: 0.5 }
      }]
    }))
  };
}

test('计划餐保留估算，但不进入已吃总量', () => {
  const day = baseDay();
  const eatenItems = day.meals.filter(meal => meal.status === 'eaten').flatMap(meal => meal.items);
  const plannedItems = day.meals.filter(meal => meal.status === 'planned').flatMap(meal => meal.items);
  assert.deepEqual(dayTotal(day), nutritionTotal(eatenItems));
  assert.deepEqual(dayTotal(day, 'planned'), nutritionTotal(plannedItems));
  assert.equal(dayTotal(day).kcal, 200);
  assert.equal(dayTotal(day, 'planned').kcal, 100);
  day.meals[2].status = 'eaten';
  assert.equal(dayTotal(day).kcal, 300);
  assert.equal(dayTotal(day, 'planned').kcal, 0);
});

test('缺失营养维持未知，不能在估算或合计时变成零', () => {
  const food = catalog.foods.find(item => item.id === 'shin-ramyun');
  const result = estimate(food, 120);
  assert.equal(result.kcal, 500);
  assert.equal(result.fiber, null);
  assert.equal(result.saturatedFat, null);
  const totals = nutritionTotal([
    { nutrition: result },
    { nutrition: { kcal: 10, protein: 1, carbs: 1, fat: 0, fiber: 2, saturatedFat: 0 } }
  ]);
  assert.equal(totals.kcal, 510);
  assert.equal(totals.fiber, null);
  assert.equal(totals.saturatedFat, null);
});

test('日期拒绝 JavaScript 自动进位及格式错误，接受真正闰日', () => {
  for (const invalid of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-01', '2026-10-00', '2026-1-01', null]) {
    assert.equal(validDate(invalid), false, String(invalid));
  }
  assert.equal(validDate('2024-02-29'), true);
  const invalidDay = baseDay();
  invalidDay.date = '2026-02-30';
  assert.throws(() => validateDay(invalidDay), /日期/);
});

test('同一天相同餐食 ID 会替换，其他餐食和两方输入保持完整', () => {
  const original = baseDay();
  const replacement = structuredClone(original.meals[1]);
  replacement.title = '修正后的午餐';
  replacement.items[0].amount = 180;
  const incoming = { ...structuredClone(original), note: '补充克重', meals: [replacement] };
  const beforeExisting = structuredClone([original]);
  const beforeIncoming = structuredClone([incoming]);
  const merged = mergeDays([original], [incoming]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].meals.length, original.meals.length);
  assert.equal(merged[0].meals.find(meal => meal.id === replacement.id).title, '修正后的午餐');
  assert.deepEqual(merged[0].meals.find(meal => meal.id === original.meals[0].id), original.meals[0]);
  assert.equal(merged[0].note, '补充克重');
  assert.deepEqual([original], beforeExisting);
  assert.deepEqual([incoming], beforeIncoming);
  merged[0].meals[0].items[0].name = '修改返回数据';
  assert.deepEqual([original], beforeExisting);
  assert.deepEqual([incoming], beforeIncoming);
});

test('新日期按日期排序合并，重复导入不会增加同 ID 餐食', () => {
  const early = baseDay();
  const late = baseDay();
  late.date = '2026-10-25';
  const merged = mergeDays([late], [early, early]);
  assert.deepEqual(merged.map(day => day.date), ['2026-10-23', '2026-10-25']);
  assert.equal(merged[0].meals.length, early.meals.length);
});

test('自定义食材可只记录热量，未知宏量继续用 null 保存', () => {
  const day = baseDay();
  const item = day.meals[0].items[0];
  item.foodId = null;
  item.nutrition = { kcal: 250, protein: null, carbs: null, fat: null, fiber: null, saturatedFat: null };
  assert.equal(validateDay(day), day);
  assert.equal(dayTotal(day).kcal, 350);
  assert.equal(dayTotal(day).protein, null);
  assert.equal(dayTotal(day).carbs, null);
});

test('导入拒绝无效热量、非有限数、负营养和缺少营养字段', () => {
  for (const invalid of [null, '123', NaN, Infinity, -1]) {
    const day = baseDay();
    day.meals[0].items[0].nutrition.kcal = invalid;
    assert.throws(() => validateDiary({ schemaVersion: 1, days: [day] }), undefined, `kcal=${String(invalid)}`);
  }
  for (const key of NUTRIENTS.filter(key => key !== 'kcal')) {
    const day = baseDay();
    day.meals[0].items[0].nutrition[key] = -0.1;
    assert.throws(() => validateDay(day), /营养/);
    delete day.meals[0].items[0].nutrition[key];
    assert.throws(() => validateDay(day), /营养/);
  }
});

test('导入拒绝重复日期、餐食 ID 以及零或负份量', () => {
  const day = baseDay();
  assert.throws(() => validateDiary({ schemaVersion: 1, days: [day, structuredClone(day)] }), /日期不可重复/);
  const duplicateMeal = baseDay();
  duplicateMeal.meals[1].id = duplicateMeal.meals[0].id;
  assert.throws(() => validateDay(duplicateMeal), /ID/);
  for (const amount of [0, -1, NaN, Infinity]) {
    const invalidDay = baseDay();
    invalidDay.meals[0].items[0].amount = amount;
    assert.throws(() => validateDay(invalidDay), /份量/);
  }
});

test('合成记录用 250g 生重草饲眼肉计算约 542.5kcal', () => {
  const day = diary.days.find(item => item.date === '2026-10-24');
  const lunch = day.meals.find(meal => meal.type === 'lunch');
  const ribeye = lunch.items.find(item => item.foodId === 'ribeye-raw');
  const reference = catalog.foods.find(food => food.id === 'ribeye-raw');
  assert.equal(lunch.status, 'eaten');
  assert.equal(ribeye.amount, 250);
  assert.equal(ribeye.unit, 'g');
  assert.match(ribeye.basis, /生重/);
  assert.match(reference.basis, /生重/);
  assert.equal(estimate(reference, 250).kcal, 542.5);
  assert.equal(ribeye.nutrition.kcal, 542.5);
});

test('牛奶 250ml 的记录保留体积到重量的近似换算说明', () => {
  const milk = diary.days.find(day => day.date === '2026-10-23').meals
    .flatMap(meal => meal.items).find(item => item.foodId === 'milk-whole');
  const reference = catalog.foods.find(food => food.id === 'milk-whole');
  assert.equal(milk.amount, 250);
  assert.equal(milk.unit, 'ml');
  assert.equal(reference.unit, 'g');
  assert.match(milk.note, /1\s*ml\s*[≈=]\s*1\s*g/);
  assert.equal(milk.nutrition.kcal, 152.5);
});

test('record CLI 在无效输入时退出失败且不改日记文件（独立临时目录）', async t => {
  const root = await mkdtemp(join(tmpdir(), 'diet-invalid-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(['scripts', 'site', 'data'].map(dir => mkdir(join(root, dir))));
  await Promise.all([
    copyFile(new URL('../scripts/record-day.mjs', import.meta.url), join(root, 'scripts', 'record-day.mjs')),
    copyFile(new URL('../site/lib.mjs', import.meta.url), join(root, 'site', 'lib.mjs')),
    writeFile(join(root, 'data', 'diary.json'), JSON.stringify(createDiaryFixture()))
  ]);
  const diaryPath = join(root, 'data', 'diary.json');
  const before = await readFile(diaryPath);
  for (const invalidCalories of [-1, null, 'NaN']) {
    const invalid = baseDay();
    invalid.meals[0].items[0].nutrition.kcal = invalidCalories;
    const input = join(root, 'invalid.json');
    await writeFile(input, JSON.stringify(invalid));
    await assert.rejects(execFileAsync(process.execPath, [join(root, 'scripts', 'record-day.mjs'), '--input', input]),
      error => error.code === 1 && /热量|营养/.test(error.stderr));
    assert.deepEqual(await readFile(diaryPath), before);
    await assert.rejects(readFile(join(root, 'data', 'diary.json.tmp')), error => error.code === 'ENOENT');
  }
});
