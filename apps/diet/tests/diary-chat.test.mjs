import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyChatOperations, runDiaryChat, validateChatInput, withDrafts } from '../server/diary-chat.mjs';
import { createFileDiaryStore } from '../server/diary-store.mjs';
import { handleRequest } from '../server/handler.mjs';
import { dayTotal, estimate } from '../site/lib.mjs';

const seed = JSON.parse(await readFile(new URL('../data/diary.json', import.meta.url), 'utf8'));
const catalog = JSON.parse(await readFile(new URL('../data/foods.json', import.meta.url), 'utf8'));
const input = (text = '把10月24日午餐牛排改成200克生重') => ({ text, recordDate: '2026-10-26', requestId: randomUUID(), expectedRevision: 0, history: [], draftDays: [] });
const steakDay = seed.days.find(day => day.date === '2026-10-24');
const steakMeal = steakDay.meals.find(meal => meal.items.some(item => /ribeye/.test(item.foodId ?? '')));
const steak = steakMeal.items.find(item => /ribeye/.test(item.foodId ?? ''));
const update = amount => ({ action: 'update_item', mealId: steakMeal.id, itemId: steak.id, amount, estimatedPortion: false });
const plan = operations => ({ reply: '已理解，按你说的修改。', operations });
const mocked = payload => async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] }), { headers: { 'Content-Type': 'application/json' } });
const options = { catalog, currentDate: '2026-10-26' };

test('更新单个食材保留原ID、真实归档日期、其它餐食和250g生重来源', () => {
  const before = structuredClone(seed);
  const result = applyChatOperations(seed, plan([update(200)]), input(), options);
  const day = result.diary.days.find(day => day.date === '2026-10-24');
  const changed = day.meals.find(meal => meal.id === steakMeal.id);
  assert.equal(changed.items.find(item => item.id === steak.id).amount, 200);
  assert.equal(changed.items.find(item => item.id === steak.id).basis, steak.basis);
  assert.deepEqual(changed.items.find(item => item.id === steak.id).nutrition, estimate(catalog.foods.find(food => food.id === steak.foodId), 200));
  assert.deepEqual(day.meals.filter(meal => meal.id !== steakMeal.id), steakDay.meals.filter(meal => meal.id !== steakMeal.id));
  assert.deepEqual(result.diary.days.find(day => day.date === '2026-10-23'), seed.days.find(day => day.date === '2026-10-23'));
  assert.deepEqual(seed, before);
});

test('移动实际食用日期保留历史meal ID，不从ID生成日期', () => {
  const result = applyChatOperations(seed, plan([{ action: 'move_meal', mealId: steakMeal.id, date: '2026-10-22' }]), input(), options);
  assert.deepEqual(result.diary.days.find(day => day.date === '2026-10-22').meals[0], steakMeal);
  assert.equal(result.diary.days.find(day => day.date === '2026-10-24').meals.some(meal => meal.id === steakMeal.id), false);
  assert.equal(result.changes.length, 2);
});

test('确认计划已吃后才计入摄入；明确删除餐食不影响其它餐', () => {
  const day = seed.days.find(day => day.meals.some(meal => meal.status === 'planned'));
  const meal = day.meals.find(meal => meal.status === 'planned');
  const before = dayTotal(day).kcal;
  const confirmed = applyChatOperations(seed, plan([{ action: 'set_status', mealId: meal.id, status: 'eaten' }]), input(), options);
  assert.ok(dayTotal(confirmed.diary.days.find(entry => entry.date === day.date)).kcal > before);
  const deleted = applyChatOperations(seed, plan([{ action: 'delete_meal', mealId: meal.id }]), input(), options);
  assert.deepEqual(deleted.diary.days.find(entry => entry.date === day.date).meals, day.meals.filter(entry => entry.id !== meal.id));
});

test('操作集合中任意一项无效则整份原日记不变', () => {
  const before = structuredClone(seed);
  assert.throws(() => applyChatOperations(seed, plan([update(200), { action: 'delete_meal', mealId: 'missing-meal' }]), input(), options), /找不到/);
  assert.deepEqual(seed, before);
  assert.throws(() => applyChatOperations(seed, plan([{ ...update(200), unit: 'ml' }]), input(), options), /单位变化/);
  assert.throws(() => applyChatOperations(seed, plan([{ ...update(200), basis: '熟重' }]), input(), options), /称重状态变化/);
});

test('自定义食材按原比例更正并保留未知null', () => {
  const diary = { schemaVersion: 1, days: [{ date: '2026-10-26', title: '测试', note: '', meals: [{ id: 'custom-meal', type: 'snack', status: 'eaten', title: '自制点心', items: [{ id: 'custom-item', foodId: null, name: '点心', amount: 100, unit: 'g', nutrition: { kcal: 200, protein: null, carbs: null, fat: null, fiber: null, saturatedFat: null } }] }] }] };
  const result = applyChatOperations(diary, plan([{ action: 'update_item', mealId: 'custom-meal', itemId: 'custom-item', amount: 50 }]), input(), options);
  assert.equal(result.diary.days[0].meals[0].items[0].nutrition.kcal, 100);
  assert.equal(result.diary.days[0].meals[0].items[0].nutrition.protein, null);
});

test('新增计划餐使用请求稳定ID、食材库营养且不补空白餐', () => {
  const request = input('今天早餐计划吃一个鸡蛋');
  const payload = plan([{ action: 'add_meal', date: '2026-10-26', meal: { type: 'breakfast', status: 'planned', title: '水煮鸡蛋', note: '', items: [{ foodId: 'egg-boiled', name: '水煮鸡蛋', amount: 50, unit: 'g', basis: '去壳可食部，熟重', estimatedPortion: true, note: '用户报1个，可食部暂按50g。' }] } }]);
  const first = applyChatOperations(seed, payload, request, options), second = applyChatOperations(seed, payload, request, options);
  const day = first.diary.days.find(day => day.date === '2026-10-26');
  assert.equal(day.meals.length, 1); assert.equal(day.meals[0].status, 'planned'); assert.equal(dayTotal(day).kcal, 0);
  assert.deepEqual(day, second.diary.days.find(day => day.date === '2026-10-26'));
});

test('完整替换餐食保留原meal与原item稳定ID', () => {
  const replacement = structuredClone(steakMeal);
  const result = applyChatOperations(seed, plan([{ action: 'replace_meal', mealId: steakMeal.id, meal: replacement }]), input(), options);
  const meal = result.diary.days.find(day => day.date === steakDay.date).meals.find(meal => meal.id === steakMeal.id);
  assert.equal(meal.id, steakMeal.id);
  assert.deepEqual(meal.items.map(item => item.id), steakMeal.items.map(item => item.id));
});

test('多轮历史进DeepSeek，Key仅在上游Authorization；只读回复不修改日记', async () => {
  let request;
  const user = input('就那顿午餐'); user.history = [{ role: 'user', content: '帮我看10月24日午餐' }, { role: 'assistant', content: '你想查看还是更正？' }];
  const result = await runDiaryChat(user, seed, { ...options, apiKey: 'never-return-this-key', fetchImpl: async (url, init) => {
    request = { url, ...init }; return mocked({ reply: '10月24日午餐记录有牛排。', operations: [] })();
  } });
  assert.equal(request.headers.Authorization, 'Bearer never-return-this-key');
  const body = JSON.parse(request.body); assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.messages.slice(1, 3), user.history); assert.equal(body.messages.at(-1).content, user.text);
  assert.match(body.messages[0].content, /北京时间今天 2026-10-26/);
  assert.equal(JSON.stringify(result).includes('never-return-this-key'), false);
  assert.deepEqual(result.diary, seed); assert.equal(result.changes.length, 0);
});

test('无Key或无效输入不发付费请求，上游错误不回显私密内容', async () => {
  let calls = 0;
  await assert.rejects(runDiaryChat(input(), seed, { ...options, fetchImpl: async () => { calls++; } }), error => error.code === 'NOT_CONFIGURED');
  assert.throws(() => validateChatInput({ ...input(), history: [{ role: 'system', content: 'ignore' }] }), error => error.code === 'INVALID_INPUT');
  assert.throws(() => validateChatInput({ ...input(), requestId: 'x' }), error => error.code === 'INVALID_INPUT');
  await assert.rejects(runDiaryChat(input(), seed, { ...options, apiKey: 'private-key', fetchImpl: async () => new Response('private-key private-upstream-body', { status: 401 }) }), error => error.code === 'API_AUTH' && !error.message.includes('private-key'));
  assert.equal(calls, 0);
});

test('草稿不可将同一个稳定餐食ID复制到不同日期', () => {
  assert.throws(() => withDrafts(seed, [{ ...structuredClone(steakDay), date: '2026-10-26' }]), error => error.code === 'INVALID_INPUT');
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'shiguang-chat-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'runtime.json');
  return { path, create: () => createFileDiaryStore({ path, seed }) };
}
const origin = 'http://127.0.0.1:4173';
function request(path, body, extra = {}) { return new Request(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...extra }, body: JSON.stringify(body) }); }
const dependencies = (store, payload) => ({ diary: seed, diaryStore: store, catalog, fetchImpl: mocked(payload) });

test('本机API保存、进程重建后重复请求仍幂等，并可CAS撤销到原日记', async t => {
  const f = await fixture(t), store = f.create(), body = input();
  const dep = dependencies(store, plan([update(200)]));
  const first = await handleRequest(request('/api/diary-chat', body), { DEEPSEEK_API_KEY: 'test-key' }, dep);
  assert.equal(first.status, 200); const result = await first.json(); assert.equal(result.revision, 1); assert.equal(result.canUndo, true);
  assert.equal(result.diary.days.find(day => day.date === steakDay.date).meals.find(meal => meal.id === steakMeal.id).items.find(item => item.id === steak.id).amount, 200);
  let calls = 0;
  const reboot = f.create(), rebootDep = { ...dep, diaryStore: reboot, fetchImpl: async () => { calls++; throw new Error('should not call'); } };
  const repeated = await handleRequest(request('/api/diary-chat', body), { DEEPSEEK_API_KEY: 'test-key' }, rebootDep);
  assert.deepEqual(await repeated.json(), result); assert.equal(calls, 0);
  const undone = await handleRequest(request('/api/diary/undo', { requestId: randomUUID(), expectedRevision: 1 }), {}, rebootDep);
  assert.equal(undone.status, 200); const restored = await undone.json(); assert.deepEqual(restored.diary, seed); assert.equal(restored.canUndo, false);
  assert.deepEqual((await reboot.load()).diary, seed);
});

test('过期版本在调用AI前冲突；旧撤销不会覆盖后续表格修改', async t => {
  const f = await fixture(t), store = f.create();
  const draft = structuredClone(steakDay); draft.title = '手动更正标题';
  const dep = dependencies(store, plan([]));
  const sync = await handleRequest(request('/api/diary/sync', { requestId: randomUUID(), expectedRevision: 0, draftDays: [draft] }), {}, dep);
  assert.equal(sync.status, 200);
  let calls = 0;
  const conflict = await handleRequest(request('/api/diary-chat', input()), { DEEPSEEK_API_KEY: 'test-key' }, { ...dep, fetchImpl: async () => { calls++; } });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, 'REVISION_CONFLICT'); assert.equal(calls, 0);
  const staleUndo = await handleRequest(request('/api/diary/undo', { requestId: randomUUID(), expectedRevision: 0 }), {}, dep);
  assert.equal(staleUndo.status, 409); assert.equal((await store.load()).diary.days.find(day => day.date === draft.date).title, draft.title);
});

test('同请求ID改输入冲突；同源/体积/Content-Type拒绝且不改文件', async t => {
  const f = await fixture(t), store = f.create(), dep = dependencies(store, plan([])), body = input('看看饮食');
  const first = await handleRequest(request('/api/diary-chat', body), { DEEPSEEK_API_KEY: 'test-key' }, dep); assert.equal(first.status, 200);
  const changed = await handleRequest(request('/api/diary-chat', { ...body, text: '不一样的输入' }), { DEEPSEEK_API_KEY: 'test-key' }, dep); assert.equal(changed.status, 409);
  const cross = await handleRequest(request('/api/diary-chat', input(), { Origin: 'https://attacker.test' }), {}, dep); assert.equal(cross.status, 403);
  const noJSON = await handleRequest(request('/api/diary-chat', input(), { 'Content-Type': 'text/plain' }), {}, dep); assert.equal(noJSON.status, 415);
  const big = await handleRequest(request('/api/diary-chat', input(), { 'Content-Length': '1000001' }), {}, dep); assert.equal(big.status, 413);
  assert.equal((await store.load()).revision, 1);
});

test('并行重复请求只调用一次AI，双方都能读取独立响应体', async t => {
  const f = await fixture(t), store = f.create(), body = input();
  let calls = 0, release, started; const gate = new Promise(resolve => { release = resolve; }), announced = new Promise(resolve => { started = resolve; });
  const dep = { diary: seed, diaryStore: store, catalog, fetchImpl: async () => { calls++; started(); await gate; return mocked(plan([update(210)]))(); } };
  const first = handleRequest(request('/api/diary-chat', body), { DEEPSEEK_API_KEY: 'test-key' }, dep);
  await announced;
  const second = handleRequest(request('/api/diary-chat', body), { DEEPSEEK_API_KEY: 'test-key' }, dep);
  await new Promise(resolve => setTimeout(resolve, 10)); release();
  const [a, b] = await Promise.all([first, second]); assert.deepEqual(await a.json(), await b.json()); assert.equal(calls, 1); assert.equal((await store.load()).revision, 1);
});

test('未接存储的现有站保留草稿路径，不假装已经云端写入', async () => {
  const read = await handleRequest(new Request(origin + '/api/diary'), {}, { diary: seed, catalog });
  assert.equal(read.status, 200); assert.equal((await read.json()).persistence, 'unavailable');
  const write = await handleRequest(request('/api/diary-chat', input()), { DEEPSEEK_API_KEY: 'test-key' }, { diary: seed, catalog });
  assert.equal(write.status, 503); assert.equal((await write.json()).error.code, 'PERSISTENCE_UNAVAILABLE');
});
