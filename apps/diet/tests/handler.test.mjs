import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { handleRequest } from '../server/handler.mjs';

const catalog = JSON.parse(await readFile(new URL('../data/foods.json', import.meta.url), 'utf8'));
const origin = 'https://diary.example.test';
const secret = 'test-secret-must-never-be-returned';
const input = () => ({ text: '早餐吃了两个水煮鸡蛋', recordDate: '2026-10-25', mealType: 'auto', requestId: randomUUID() });
const modelPayload = {
  meals: [{ date: '2026-10-25', type: 'breakfast', status: 'eaten', title: '水煮鸡蛋', note: '', items: [{ foodId: 'egg-boiled', name: '水煮鸡蛋2个', amount: 100, unit: 'g', basis: '去壳可食部，熟重', estimatedPortion: true, note: '两个鸡蛋可食部暂按100g。' }] }],
  warnings: []
};
const modelResponse = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(modelPayload) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
function context(fetchImpl = async () => modelResponse()) {
  return { catalog, fetchImpl, assets: { '/index.html': '<!doctype html><title>食光</title>', '/app.mjs': 'export const app = true;', '/data/foods.json': '{"foods":[]}' } };
}
function request(body, options = {}) {
  const { owner = randomUUID(), headers = {}, ...rest } = options;
  return new Request(`${origin}/api/parse-meals`, {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: origin, 'oai-authenticated-user-id': owner, ...headers },
    ...rest
  });
}
async function assertFailure(response, status, code) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('Content-Type'), /^application\/json/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const result = await response.json();
  assert.equal(result.error.code, code);
  return result;
}

test('parse API accepts only POST and blocks cross-origin requests before upstream calls', async () => {
  let calls = 0;
  const dependencies = context(async () => { calls++; return modelResponse(); });
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
    await assertFailure(await handleRequest(new Request(`${origin}/api/parse-meals`, { method }), { DEEPSEEK_API_KEY: secret }, dependencies), 405, 'METHOD_NOT_ALLOWED');
  }
  for (const unsafeOrigin of ['https://other.example.test', 'null', `${origin}.attacker.test`]) {
    await assertFailure(await handleRequest(request(input(), { headers: { Origin: unsafeOrigin } }), { DEEPSEEK_API_KEY: secret }, dependencies), 403, 'ORIGIN_NOT_ALLOWED');
  }
  assert.equal(calls, 0);
});

test('parse API requires the actual application/json MIME type', async () => {
  let calls = 0;
  const dependencies = context(async () => { calls++; return modelResponse(); });
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonp']) {
    await assertFailure(await handleRequest(request(input(), { headers: { 'Content-Type': contentType } }), { DEEPSEEK_API_KEY: secret }, dependencies), 415, 'INVALID_CONTENT_TYPE');
  }
  assert.equal(calls, 0);
});

test('valid JSON content type with charset is accepted', async () => {
  const response = await handleRequest(request(input(), { headers: { 'Content-Type': 'application/json; charset=utf-8' } }), { DEEPSEEK_API_KEY: secret }, context());
  assert.equal(response.status, 200);
});

test('oversized declared bodies and oversized streamed bodies are rejected before upstream calls', async () => {
  let calls = 0;
  const dependencies = context(async () => { calls++; return modelResponse(); });
  await assertFailure(await handleRequest(request(input(), { headers: { 'Content-Length': '24001' } }), { DEEPSEEK_API_KEY: secret }, dependencies), 413, 'INPUT_TOO_LARGE');
  // No Content-Length: the handler must enforce the limit while consuming bytes.
  await assertFailure(await handleRequest(request(JSON.stringify({ ...input(), text: '食'.repeat(9000) })), { DEEPSEEK_API_KEY: secret }, dependencies), 413, 'INPUT_TOO_LARGE');
  assert.equal(calls, 0);
});

test('malformed JSON and invalid request IDs do not reach upstream', async () => {
  let calls = 0;
  const dependencies = context(async () => { calls++; return modelResponse(); });
  for (const badBody of ['{"text":', 'null', '[]', JSON.stringify({ ...input(), requestId: 'not-a-uuid' })]) {
    await assertFailure(await handleRequest(request(badBody), { DEEPSEEK_API_KEY: secret }, dependencies), 400, 'INVALID_INPUT');
  }
  assert.equal(calls, 0);
});

test('static routes serve only explicit assets and never server files or environment files', async () => {
  const dependencies = context();
  for (const path of ['/server/handler.mjs', '/server/parse-meals.mjs', '/.env', '/.env.local', '/package.json', '/unknown.html', '/%2eenv', '/server/../.env']) {
    const response = await handleRequest(new Request(`${origin}${path}`), { DEEPSEEK_API_KEY: secret }, dependencies);
    assert.equal(response.status, 404, path);
    assert.equal((await response.text()).includes(secret), false);
  }
  const index = await handleRequest(new Request(`${origin}/`), {}, dependencies);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('Content-Type'), /^text\/html/);
  assert.match(await index.text(), /食光/);
  const script = await handleRequest(new Request(`${origin}/app.mjs`), {}, dependencies);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('Content-Type'), /^text\/javascript/);
  const head = await handleRequest(new Request(`${origin}/app.mjs`, { method: 'HEAD' }), {}, dependencies);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  await assertFailure(await handleRequest(new Request(`${origin}/api/nonexistent`), {}, dependencies), 404, 'NOT_FOUND');
  await assertFailure(await handleRequest(new Request(`${origin}/index.html`, { method: 'POST' }), {}, dependencies), 405, 'METHOD_NOT_ALLOWED');
});

test('key is sent only as upstream Authorization and never appears in a successful response', async () => {
  let upstream;
  const payload = input();
  const response = await handleRequest(request(payload), { DEEPSEEK_API_KEY: secret }, context(async (url, options) => {
    upstream = { url, ...options };
    return modelResponse();
  }));
  assert.equal(response.status, 200);
  assert.equal(upstream.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(upstream.headers.Authorization, `Bearer ${secret}`);
  assert.equal(upstream.body.includes(secret), false);
  assert.equal(upstream.url.includes(secret), false);
  const body = await response.text();
  assert.equal(body.includes(secret), false);
  assert.equal(JSON.stringify([...response.headers]).includes(secret), false);
  assert.equal(JSON.parse(body).requestId, payload.requestId);
  assert.equal(JSON.parse(body).days[0].meals[0].type, 'breakfast');
});

test('completed retries with the same request ID call the upstream only once', async () => {
  let calls = 0;
  const payload = input();
  const owner = randomUUID();
  const dependencies = context(async () => { calls++; return modelResponse(); });
  const first = await handleRequest(request(payload, { owner }), { DEEPSEEK_API_KEY: secret }, dependencies);
  const second = await handleRequest(request(payload, { owner }), { DEEPSEEK_API_KEY: secret }, dependencies);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), await first.json());
  assert.equal(calls, 1);
});

test('concurrent retries join the same pending upstream request', async () => {
  let calls = 0;
  let release;
  let announceStarted;
  const started = new Promise(resolve => { announceStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const dependencies = context(async () => { calls++; announceStarted(); await gate; return modelResponse(); });
  const payload = input();
  const owner = randomUUID();
  const first = handleRequest(request(payload, { owner }), { DEEPSEEK_API_KEY: secret }, dependencies);
  await started;
  const second = handleRequest(request(payload, { owner }), { DEEPSEEK_API_KEY: secret }, dependencies);
  // Let the second request finish reading JSON while the first upstream is held.
  // Releasing immediately could accidentally test only the completed cache path.
  try { await setImmediate(); assert.equal(calls, 1); }
  finally { release(); }
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.deepEqual(await firstResponse.json(), await secondResponse.json());
  assert.equal(calls, 1);
});

test('same request ID with changed payload returns conflict after success', async () => {
  let calls = 0;
  const dependencies = context(async () => { calls++; return modelResponse(); });
  const payload = input();
  const owner = randomUUID();
  assert.equal((await handleRequest(request(payload, { owner }), { DEEPSEEK_API_KEY: secret }, dependencies)).status, 200);
  await assertFailure(await handleRequest(request({ ...payload, text: '早餐又吃了一个鸡蛋' }, { owner }), { DEEPSEEK_API_KEY: secret }, dependencies), 409, 'REQUEST_CONFLICT');
  assert.equal(calls, 1);
});

test('same request ID with changed payload conflicts while the first request is pending', async () => {
  let release;
  let announceStarted;
  let calls = 0;
  const started = new Promise(resolve => { announceStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const dependencies = context(async () => { calls++; announceStarted(); await gate; return modelResponse(); });
  const payload = input();
  const owner = randomUUID();
  const first = handleRequest(request(payload, { owner }), { DEEPSEEK_API_KEY: secret }, dependencies);
  await started;
  try {
    await assertFailure(await handleRequest(request({ ...payload, text: '早餐又吃了一个鸡蛋' }, { owner }), { DEEPSEEK_API_KEY: secret }, dependencies), 409, 'REQUEST_CONFLICT');
  } finally { release(); }
  assert.equal((await first).status, 200);
  assert.equal(calls, 1);
});

test('upstream errors never echo their response body or secret', async () => {
  for (const [status, expectedStatus, code] of [[401, 503, 'API_AUTH'], [402, 503, 'API_BALANCE'], [429, 429, 'API_RATE_LIMIT'], [500, 502, 'API_UNAVAILABLE']]) {
    let readBody = false;
    const response = await handleRequest(request(input()), { DEEPSEEK_API_KEY: secret }, context(async () => ({
      ok: false, status,
      json: async () => { readBody = true; return { secret, message: 'private-upstream-body-marker' }; },
      text: async () => { readBody = true; return `${secret} private-upstream-body-marker`; }
    })));
    const data = await assertFailure(response, expectedStatus, code);
    assert.equal(JSON.stringify(data).includes(secret), false);
    assert.equal(JSON.stringify(data).includes('private-upstream-body-marker'), false);
    assert.equal(readBody, false);
  }
  const networkError = await handleRequest(request(input()), { DEEPSEEK_API_KEY: secret }, context(async () => { throw new Error(`${secret} private-network-error`); }));
  const data = await assertFailure(networkError, 502, 'API_UNAVAILABLE');
  assert.equal(JSON.stringify(data).includes(secret), false);
  assert.equal(JSON.stringify(data).includes('private-network-error'), false);
});

test('missing server key returns a safe 503 without attempting an upstream request', async () => {
  let calls = 0;
  const response = await handleRequest(request(input()), {}, context(async () => { calls++; return modelResponse(); }));
  await assertFailure(response, 503, 'NOT_CONFIGURED');
  assert.equal(calls, 0);
});
