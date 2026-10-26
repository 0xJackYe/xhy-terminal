import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeMealResponse, parseMeals, ParseError } from '../server/parse-meals.mjs';
import { estimate } from '../site/lib.mjs';

const catalog = JSON.parse(await readFile(new URL('../data/foods.json', import.meta.url), 'utf8'));
const input = { text: '今天早上吃了两个鸡蛋', recordDate: '2026-10-25', mealType: 'auto', requestId: '458bc173-f66f-4e77-8eb4-f3bac47f7d12' };
const nutrition = { kcal: 155, protein: 12.58, carbs: 1.12, fat: 10.61, fiber: 0, saturatedFat: 3.267 };
const item = (overrides = {}) => ({ foodId: 'egg-boiled', name: '鸡蛋 2个', amount: 100, unit: 'g', basis: '去壳可食部，熟重', estimatedPortion: true, note: '用户报2个，每个可食部暂按50g。', nutrition, ...overrides });
const meal = (overrides = {}) => ({ date: '2026-10-25', type: 'breakfast', status: 'eaten', title: '水煮鸡蛋', note: '', items: [item()], ...overrides });
const payload = (meals = [meal()], warnings = []) => ({ meals, warnings });
function mockFetch(value, { finish = 'stop', status = 200, raw = false } = {}) {
  return async (_url, _options) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => raw ? value : ({ choices: [{ finish_reason: finish, message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] })
  });
}
const parse = (data, request = input, extra = {}) => parseMeals(request, { apiKey: 'test-only-placeholder', catalog, fetchImpl: mockFetch(data), currentDate: '2026-10-25', ...extra });

test('single spoken breakfast creates only breakfast, deterministic catalog nutrition and estimate notes', async () => {
  const data = await parse(payload([meal({ items: [item({ nutrition: { kcal: 999999 } })] })]));
  assert.equal(data.days.length, 1);
  assert.equal(data.days[0].meals.length, 1);
  const breakfast = data.days[0].meals[0];
  assert.equal(breakfast.type, 'breakfast');
  assert.deepEqual(breakfast.items[0].nutrition, estimate(catalog.foods.find(food => food.id === 'egg-boiled'), 100));
  assert.equal(breakfast.items[0].estimatedPortion, true);
  assert.equal(breakfast.items[0].estimatedNutrition, true);
  assert.match(breakfast.items[0].note, /估算/);
});

test('whole day keeps only mentioned breakfast and dinner and retains planned state', async () => {
  const result = await parse(payload([meal(), meal({ type: 'dinner', status: 'planned' })]), { ...input, text: '早饭两个鸡蛋，晚饭打算也吃两个鸡蛋' });
  assert.deepEqual(result.days[0].meals.map(value => [value.type, value.status]), [['breakfast', 'eaten'], ['dinner', 'planned']]);
  assert.equal(result.days[0].meals.some(value => value.type === 'lunch'), false);
});

test('one yesterday anchor covers breakfast, lunch and planned dinner despite a wrong model dinner date', async () => {
  const meals = [meal({ date: '2026-10-24' }), meal({ date: '2026-10-24', type: 'lunch' }), meal({ date: '2026-10-25', type: 'dinner', status: 'planned' })];
  const result = await parse(payload(meals), { ...input, text: '昨天早餐吃了两个鸡蛋。中午吃了两个鸡蛋。晚餐准备吃两个鸡蛋。' });
  assert.equal(result.days.length, 1);
  assert.equal(result.days[0].date, '2026-10-24');
  assert.deepEqual(result.days[0].meals.map(value => [value.type, value.status]), [['breakfast', 'eaten'], ['lunch', 'eaten'], ['dinner', 'planned']]);
});

test('no spoken date always uses selected record date, ignoring invented model dates', async () => {
  const result = await parse(payload([meal({ date: '2026-10-21' }), meal({ date: '2026-10-22', type: 'dinner' })]), { ...input, text: '早餐吃两个鸡蛋，晚餐也吃两个鸡蛋', recordDate: '2026-10-23' });
  assert.equal(result.days.length, 1);
  assert.equal(result.days[0].date, '2026-10-23');
});

test('mixed yesterday and today accept only explicitly mentioned dates', async () => {
  const request = { ...input, text: '昨天早餐吃两个鸡蛋，今天早餐也吃两个鸡蛋' };
  const result = await parse(payload([meal({ date: '2026-10-24' }), meal({ date: '2026-10-25' })]), request);
  assert.deepEqual(result.days.map(day => day.date), ['2026-10-24', '2026-10-25']);
  await assert.rejects(parse(payload([meal({ date: '2026-10-23' })]), request), { code: 'NEEDS_CLARIFICATION' });
});

test('absolute Chinese dates, ISO dates and bare day numbers anchor all mentioned meals', async () => {
  for (const [dateWords, expected] of [['2026年9月24日', '2026-09-24'], ['2026-09-24', '2026-09-24'], ['9月24号', '2026-09-24'], ['24号', '2026-10-24'], ['前天', '2026-10-23'], ['明天', '2026-10-26'], ['后天', '2026-10-27']]) {
    const result = await parse(payload(), { ...input, text: `${dateWords}早餐吃了两个鸡蛋` });
    assert.equal(result.days[0].date, expected);
  }
  await assert.rejects(parse(payload(), { ...input, text: '2026年2月30日早餐吃两个鸡蛋' }), { code: 'NEEDS_CLARIFICATION' });
});

test('prompt anchors relative dates to real Beijing date, and sends only dietary recipe fields', async () => {
  let request;
  const result = await parse(payload([meal({ date: '2026-10-24' })]), { ...input, text: '昨天早餐吃了两个鸡蛋', recordDate: '2026-10-21' }, {
    recipes: [{ title: '燕麦碗', source: { unrelated: 'private-excluded-field' }, items: [item()] }],
    fetchImpl: async (url, options) => {
      request = { url, ...options, body: JSON.parse(options.body) };
      return mockFetch(payload([meal({ date: '2026-10-24' })]))();
    }
  });
  assert.equal(result.days[0].date, '2026-10-24');
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.body.model, 'deepseek-flash');
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  assert.equal(request.body.temperature, 0.1);
  assert.match(request.body.messages[0].content, /北京时间今天是 2026-10-25/);
  assert.match(request.body.messages[0].content, /记录日期 2026-10-21/);
  assert.match(request.body.messages[0].content, /未提到/);
  assert.match(request.body.messages[0].content, /不要自行增加油、酱料、鸡蛋/);
  assert.match(request.body.messages[0].content, /燕麦碗不含另外吃的鸡蛋，除非这次也提到鸡蛋/);
  assert.equal(request.body.messages[0].content.includes('private-excluded-field'), false);
  assert.deepEqual(JSON.parse(request.body.messages[1].content), { transcript: '昨天早餐吃了两个鸡蛋' });
  assert.equal(request.signal.aborted, false);
});

test('unknown meal type or absent meal wording never guesses lunch', async () => {
  await assert.rejects(parse(payload([meal({ type: 'unknown' })])), { code: 'NEEDS_CLARIFICATION', status: 422 });
  await assert.rejects(parse(payload([meal({ type: 'lunch' })]), { ...input, text: '我吃了两个鸡蛋' }), { code: 'NEEDS_CLARIFICATION' });
  await assert.rejects(parse({ needsClarification: '是哪一餐？', meals: [], warnings: [] }), { code: 'NEEDS_CLARIFICATION' });
  const explicit = await parse(payload([meal({ type: 'lunch' })]), { ...input, text: '两个鸡蛋', mealType: 'lunch' });
  assert.equal(explicit.days[0].meals[0].type, 'lunch');
});

test('same recipe instruction does not independently add extra foods', async () => {
  const data = await parse(payload([meal({ title: '燕麦', items: [item({ foodId: 'oats-dry', name: '燕麦', amount: 100, basis: '暂按干重' })] })]), { ...input, text: '早餐吃燕麦碗，和之前一样' }, { recipes: [{ name: '燕麦碗', items: [item({ name: '燕麦', foodId: 'oats-dry' })] }] });
  assert.equal(data.days[0].meals[0].items.length, 1);
  assert.equal(data.days[0].meals[0].items[0].foodId, 'oats-dry');
  await assert.rejects(parse({ meals: [], warnings: [] }, { ...input, text: '早上没吃东西' }), { code: 'NO_FOOD_FOUND' });
});

test('unknown food allows approximate nutrition and preserves unknown nutrient nulls', async () => {
  const data = await parse(payload([meal({ items: [item({ foodId: null, name: '品牌面包', amount: 80, nutrition: { kcal: 190, protein: 5, carbs: 32, fat: 4, fiber: null } })] })]));
  const food = data.days[0].meals[0].items[0];
  assert.equal(food.nutrition.fiber, null);
  assert.equal(food.nutrition.saturatedFat, null);
  assert.match(food.note, /AI 粗估/);
});

test('milk millilitres use approximate density, solid food millilitres are rejected', async () => {
  const data = await parse(payload([meal({ items: [item({ foodId: 'milk-whole', name: '牛奶', amount: 250, unit: 'ml', basis: '体积' })] })]));
  assert.equal(data.days[0].meals[0].items[0].nutrition.kcal, 152.5);
  assert.match(data.days[0].meals[0].items[0].note, /1ml≈1g/);
  await assert.rejects(parse(payload([meal({ items: [item({ unit: 'ml' })] })])), { code: 'INVALID_MODEL_OUTPUT' });
});

test('raw steak cannot silently use a cooked weight and dry oats cannot use cooked weight', async () => {
  for (const foodId of ['ribeye-raw', 'oats-dry']) {
    await assert.rejects(parse(payload([meal({ items: [item({ foodId, basis: '熟重' })] })])), { code: 'NEEDS_CLARIFICATION' });
  }
  await assert.rejects(parse(payload([meal({ items: [item({ foodId: 'chicken-breast-cooked', basis: '生重' })] })])), { code: 'NEEDS_CLARIFICATION' });
});

test('unknown alternative weighing states in notes or basis do not create false mismatches', async () => {
  const variants = [
    { foodId: 'ribeye-raw', basis: '生重', note: '用户报250g生重；熟重尚未确认。' },
    { foodId: 'chicken-breast-cooked', basis: '暂按熟重', note: '生重待确认，暂按熟重估算。' },
    { foodId: 'oats-dry', basis: '暂按干重；熟重未知', note: '用户没有提供煮好后的重量。' },
    { foodId: 'ribeye-raw', basis: '生重；不是熟重', note: '' }
  ];
  for (const variant of variants) {
    const data = await parse(payload([meal({ items: [item(variant)] })]));
    assert.equal(data.days[0].meals[0].items[0].foodId, variant.foodId);
    assert.ok(data.warnings.includes('营养均为粗略估算，可在餐食卡片中调整份量。'));
  }
});

test('input rejects invalid dates, text limits, meal enum and malformed request IDs before fetch', async () => {
  let called = false;
  for (const override of [{ text: '' }, { text: '食'.repeat(4001) }, { recordDate: '2026-02-30' }, { mealType: 'brunch' }, { requestId: '../invalid' }]) {
    await assert.rejects(parse(payload(), { ...input, ...override }, { fetchImpl: async () => { called = true; } }), { code: 'INVALID_INPUT', status: 400 });
  }
  assert.equal(called, false);
});

test('normalizer rejects NaN, negative or excessive nutrition and amounts, huge output and invalid dates', () => {
  const broken = [
    meal({ title: '字'.repeat(161) }),
    meal({ items: [item({ amount: NaN })] }), meal({ items: [item({ amount: 10001 })] }),
    meal({ items: [item({ unit: '碗' })] }), meal({ items: [item({ foodId: 'unknown-food' })] }),
    meal({ items: [item({ foodId: null, nutrition: { kcal: NaN } })] }),
    meal({ items: [item({ foodId: null, nutrition: { kcal: -1 } })] }),
    meal({ items: [item({ foodId: null, nutrition: { kcal: 2000 } })] }),
    meal({ items: Array.from({ length: 31 }, () => item()) })
  ];
  for (const value of broken) assert.throws(() => normalizeMealResponse(payload([value]), input, { catalog }), ParseError);
  assert.throws(() => normalizeMealResponse(payload(Array.from({ length: 9 }, () => meal())), input, { catalog }), { code: 'INVALID_MODEL_OUTPUT' });
  const fiveDatesInput = { ...input, text: '2026-10-21早餐、2026-10-22早餐、2026-10-23早餐、2026-10-24早餐、2026-10-25早餐都吃了两个鸡蛋' };
  assert.throws(() => normalizeMealResponse(payload(['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'].map(date => meal({ date }))), fiveDatesInput, { catalog }), { code: 'INVALID_MODEL_OUTPUT' });
  assert.throws(() => normalizeMealResponse(payload([meal({ date: '2026-02-30' })]), { ...input, text: '昨天早餐两个鸡蛋，今天早餐两个鸡蛋' }, { catalog, currentDate: '2026-10-25' }), { code: 'INVALID_MODEL_OUTPUT' });
});

test('empty, malformed and token-truncated provider responses have safe errors', async () => {
  for (const value of ['', '   ', '{', { choices: [] }]) {
    await assert.rejects(parse(value, input, { fetchImpl: mockFetch(value, { raw: typeof value === 'object' }) }), { code: 'INVALID_MODEL_OUTPUT' });
  }
  await assert.rejects(parse(payload(), input, { fetchImpl: mockFetch(payload(), { finish: 'length' }) }), { code: 'OUTPUT_TRUNCATED' });
});

test('API failures map auth, balance, rate limit and timeout without exposing upstream body', async () => {
  for (const [status, code, clientStatus] of [[401, 'API_AUTH', 503], [402, 'API_BALANCE', 503], [429, 'API_RATE_LIMIT', 429], [500, 'API_UNAVAILABLE', 502]]) {
    await assert.rejects(parse(payload(), input, { fetchImpl: async () => ({ ok: false, status, json: () => { throw new Error('sensitive upstream body'); } }) }), error => {
      assert.equal(error.code, code);
      assert.equal(error.status, clientStatus);
      assert.equal(error.message.includes('sensitive upstream body'), false);
      assert.equal(error.message.includes('test-only-placeholder'), false);
      return true;
    });
  }
  await assert.rejects(parse(payload(), input, { fetchImpl: async () => { throw new DOMException('Timed out', 'AbortError'); } }), { code: 'API_TIMEOUT', status: 504 });
  await assert.rejects(parse(payload(), input, { apiKey: '' }), { code: 'NOT_CONFIGURED', status: 503 });
});

test('retrying the same request yields the same meal and item IDs', async () => {
  const a = await parse(payload());
  const b = await parse(payload());
  assert.deepEqual(a.days[0].meals.map(meal => meal.id), b.days[0].meals.map(meal => meal.id));
  assert.equal(a.days[0].meals[0].items[0].id, b.days[0].meals[0].items[0].id);
  const c = await parse(payload(), { ...input, requestId: 'acb3e451-dffa-4f8b-a609-32174d63f036' });
  assert.notEqual(a.days[0].meals[0].id, c.days[0].meals[0].id);
});
