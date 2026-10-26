import { today } from '../site/lib.mjs';
import { ParseError } from './parse-meals.mjs';
import { validateChatInput, runDiaryChat, withDrafts } from './diary-chat.mjs';

const pending = new Map(), quota = new Map();
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin'
} });
const failure = (code, message, status) => response({ error: { code, message } }, status);
const safeError = error => error instanceof ParseError ? failure(error.code, error.message, error.status)
  : failure('STORAGE_UNAVAILABLE', '日记服务暂时不可用，本次修改尚未确认保存。请重试，重复发送不会重复记录。', 503);
async function readJSON(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ParseError('INVALID_CONTENT_TYPE', '请在网站内提交日记。', 415);
  if (Number(request.headers.get('Content-Length')) > 1000000) throw new ParseError('INPUT_TOO_LARGE', '本次数据较大，请分批同步。', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new ParseError('INVALID_INPUT', '请先输入内容。', 400);
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 1000000) { await reader.cancel(); throw new ParseError('INPUT_TOO_LARGE', '本次数据较大，请分批同步。', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const value of chunks) { bytes.set(value, offset); offset += value.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ParseError('INVALID_INPUT', '输入没有读完整，请重新提交。', 400); }
}

/** Optional durable APIs; same handler runs locally and remains safe without a store on Sites. */
export async function handleDiaryAPI(request, env, { diary, diaryStore, catalog, fetchImpl = fetch, chatImpl = runDiaryChat } = {}) {
  const url = new URL(request.url), path = url.pathname;
  if (!['/api/diary', '/api/diary-chat', '/api/diary/sync', '/api/diary/undo'].includes(path)) return null;
  // Sites supplies the existing private access boundary. The local server binds loopback only.
  if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin
    || request.headers.get('Sec-Fetch-Site') === 'cross-site') return failure('ORIGIN_NOT_ALLOWED', '请在自己的饮食日记网站内操作。', 403);
  const owner = request.headers.get('oai-authenticated-user-id') || 'private-site-owner';
  if (path === '/api/diary') {
    if (!['GET', 'HEAD'].includes(request.method)) return failure('METHOD_NOT_ALLOWED', '请通过日记表单保存。', 405);
    try {
      const snapshot = diaryStore ? await diaryStore.load(owner) : { diary, revision: 0 };
      if (!snapshot.diary) return failure('NOT_FOUND', '日记数据暂时不可用。', 503);
      const result = { ...snapshot, persistence: diaryStore?.persistence ?? 'unavailable', apiConfigured: !!env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL || 'deepseek-flash' };
      return request.method === 'HEAD' ? new Response(null, { headers: { 'Cache-Control': 'no-store' } }) : response(result);
    } catch (error) { return safeError(error); }
  }
  if (request.method !== 'POST') return failure('METHOD_NOT_ALLOWED', '请通过日记表单提交。', 405);
  if (!diaryStore) return failure('PERSISTENCE_UNAVAILABLE', '此页面尚未连接日记存储，请从个人总终端打开本机饮食日记。', 503);
  try {
    const raw = await readJSON(request);
    const input = validateChatInput(path !== '/api/diary-chat' ? { ...raw, text: path.endsWith('/undo') ? '撤销最近修改' : '同步本机草稿', recordDate: raw.recordDate || today(), history: [] } : raw);
    const fingerprintBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
    const fingerprint = [...new Uint8Array(fingerprintBytes)].map(value => value.toString(16).padStart(2, '0')).join('');
    const key = `${owner}:${input.requestId}`;
    const existing = await diaryStore.findReceipt(owner, input.requestId);
    if (existing) return existing.fingerprint === fingerprint ? response(existing.result) : failure('REQUEST_CONFLICT', '这次输入已变化，请重新发送。', 409);
    const active = pending.get(key);
    if (active) return active.fingerprint === fingerprint ? (await active.promise).clone() : failure('REQUEST_CONFLICT', '这次输入已变化，请重新发送。', 409);
    const now = Date.now();
    for (const [name, value] of quota) if (value.expires < now) quota.delete(name);
    const rate = quota.get(owner) ?? { count: 0, expires: now + 300000 };
    if (path === '/api/diary-chat' && rate.count >= 20) return failure('TOO_MANY_REQUESTS', '刚刚聊了较多内容，稍等几分钟再试。', 429);
    if (path === '/api/diary-chat') { rate.count++; quota.set(owner, rate); }
    const promise = (async () => {
      try {
        const snapshot = await diaryStore.load(owner);
        if (snapshot.revision !== input.expectedRevision) return failure('REVISION_CONFLICT', '另一处刚刚更新了日记。请点“刷新日记”，保留输入后重新发送。', 409);
        const base = withDrafts(snapshot.diary, input.draftDays);
        if (input.draftDays.length) base.updatedAt = new Date().toISOString();
        let result = path === '/api/diary/sync'
          ? { diary: base, reply: '本机草稿已同步到日记。', changes: [] }
          : path === '/api/diary/undo' ? null : await chatImpl(input, base, { apiKey: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL || 'deepseek-flash', catalog, fetchImpl });
        if (path === '/api/diary/undo') {
          if (input.draftDays.length) return failure('UNSYNCED_DRAFTS', '还有本机草稿，请先同步或导出后再撤销。', 409);
          const undo = await diaryStore.loadUndo?.(owner);
          if (!undo) return failure('NOTHING_TO_UNDO', '没有可以撤销的修改。', 409);
          result = { diary: undo.diary, reply: '已撤销最近一次保存，日记已恢复。', changes: [{ action: '撤销', date: today(), title: '最近一次修改' }] };
        }
        const saved = result.changes.length > 0 || input.draftDays.length > 0;
        const reply = { ...result, revision: snapshot.revision + 1, persistence: diaryStore.persistence,
          requestId: input.requestId, saved, canUndo: path === '/api/diary/undo' ? false : saved || !!snapshot.canUndo };
        const committed = await diaryStore.commit(owner, snapshot.revision, result.diary, { requestId: input.requestId, fingerprint, result: reply,
          undoable: saved && path !== '/api/diary/undo', resetUndo: path === '/api/diary/undo' });
        if (committed.receipt) return committed.receipt.fingerprint === fingerprint ? response(committed.receipt.result) : failure('REQUEST_CONFLICT', '这次输入已变化，请重新发送。', 409);
        if (!committed.committed) return failure('REVISION_CONFLICT', '日记已被另一处更新，本次修改尚未保存。请刷新日记后重新发送。', 409);
        return response(reply);
      } catch (error) { return safeError(error); }
      finally { pending.delete(key); }
    })();
    pending.set(key, { fingerprint, promise });
    // Each caller needs its own Response body, including concurrent retries.
    return (await promise).clone();
  } catch (error) { return safeError(error); }
}
