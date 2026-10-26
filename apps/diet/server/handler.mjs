import { parseMeals, ParseError } from './parse-meals.mjs';
import { today } from '../site/lib.mjs';
import { handleDiaryAPI } from './diary-api.mjs';

const inflight = new Map();
const recent = new Map();
const rate = new Map();
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml' };
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': MIME.json } });
}
function failure(code, message, status) { return json({ error: { code, message } }, status); }

export async function handleRequest(request, env = {}, { assets = {}, catalog, recipes = [], diary, diaryStore, fetchImpl = fetch, chatImpl } = {}) {
  const url = new URL(request.url);
  const diaryResponse = await handleDiaryAPI(request, env, { diary, diaryStore, catalog, fetchImpl, chatImpl });
  if (diaryResponse) return diaryResponse;
  if (url.pathname === '/api/parse-meals') {
    // Hosted behind the existing owner-only Sites sign-in gate.
    if (request.method !== 'POST') return failure('METHOD_NOT_ALLOWED', '请通过记录表单提交。', 405);
    if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return failure('ORIGIN_NOT_ALLOWED', '请在饮食日记网站内提交记录。', 403);
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return failure('INVALID_CONTENT_TYPE', '请使用记录表单提交文字。', 415);
    if (Number(request.headers.get('Content-Length')) > 24000) return failure('INPUT_TOO_LARGE', '一次最多输入4,000字，请分次记录。', 413);
    let input;
    try {
      const reader = request.body?.getReader();
      if (!reader) return failure('INVALID_INPUT', '请先输入食物描述。', 400);
      let size = 0; const chunks = [];
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 24000) { await reader.cancel(); return failure('INPUT_TOO_LARGE', '一次最多输入4,000字，请分次记录。', 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      input = JSON.parse(new TextDecoder().decode(bytes));
      if (!input || typeof input !== 'object' || typeof input.requestId !== 'string' || input.requestId.length > 64) return failure('INVALID_INPUT', '这次记录编号无效，请刷新后重试。', 400);
    } catch { return failure('INVALID_INPUT', '这次输入没有读完整，请重新提交。', 400); }
    const now = Date.now();
    for (const [key, value] of recent) if (value.expires < now) recent.delete(key);
    for (const [key, value] of rate) if (value.expires < now) rate.delete(key);
    const owner = request.headers.get('oai-authenticated-user-id') || 'private-site-owner';
    const cacheKey = owner + ':' + input.requestId;
    const fingerprint = JSON.stringify(input);
    const cached = recent.get(cacheKey);
    if (cached) return cached.fingerprint === fingerprint ? json(cached.result) : failure('REQUEST_CONFLICT', '输入已变化，请重新提交这次记录。', 409);
    const active = inflight.get(cacheKey);
    if (active) {
      if (active.fingerprint !== fingerprint) return failure('REQUEST_CONFLICT', '输入已变化，请重新提交这次记录。', 409);
      return active.promise.then(result => json(result)).catch(error => errorResponse(error));
    }
    const quota = rate.get(owner) || { count: 0, expires: now + 300000 };
    if (quota.count >= 20) return failure('TOO_MANY_REQUESTS', '刚刚整理的记录较多，稍等几分钟再试。', 429);
    quota.count++; rate.set(owner, quota);
    const promise = parseMeals(input, { apiKey: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL || 'deepseek-flash', catalog, recipes, currentDate: today(), fetchImpl });
    inflight.set(cacheKey, { fingerprint, promise });
    try {
      const result = await promise;
      if (recent.size >= 64) recent.delete(recent.keys().next().value);
      recent.set(cacheKey, { fingerprint, result, expires: Date.now() + 300000 });
      return json(result);
    } catch (error) { return errorResponse(error); }
    finally { inflight.delete(cacheKey); }
  }
  if (url.pathname.startsWith('/api/')) return failure('NOT_FOUND', '接口不存在。', 404);
  if (!['GET', 'HEAD'].includes(request.method)) return failure('METHOD_NOT_ALLOWED', '此页面不支持该操作。', 405);
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  const asset = typeof assets === 'function' ? await assets(path) : assets[path];
  if (typeof asset !== 'string') return new Response('Not found', { status: 404, headers });
  const type = MIME[path.split('.').pop()] || 'application/octet-stream';
  return new Response(request.method === 'HEAD' ? null : asset, { headers: { ...headers, 'Content-Type': type } });
}
function errorResponse(error) {
  return error instanceof ParseError ? failure(error.code, error.message, error.status) : failure('INTERNAL_ERROR', '暂时无法整理，文字已保留，请稍后重试。', 500);
}
