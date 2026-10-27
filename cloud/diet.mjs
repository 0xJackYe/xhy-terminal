import { handleRequest } from '../apps/diet/server/handler.mjs';
import { createD1DiaryStore } from './diary-store.mjs';

const MIME_JSON = 'application/json; charset=utf-8';
const responseJSON = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': MIME_JSON, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }
});

function recipesFromDiary(diary) {
  const unique = new Map();
  for (const day of diary.days) {
    for (const meal of day.meals) {
      const items = meal.items.filter(item => item.foodId !== 'egg-boiled' || !meal.title.includes('燕麦'));
      const title = meal.title.includes('燕麦') ? '燕麦水果坚果牛奶碗（不含另吃的鸡蛋）' : meal.title;
      const signature = JSON.stringify(items.map(({ foodId, amount, unit }) => ({ foodId, amount, unit })));
      unique.set(signature, { title, items });
    }
  }
  return [...unique.values()];
}

/**
 * Root Worker authenticates the owner before calling this namespace handler.
 * Static assets supplied by the root build are already prefixed/theme-bridged.
 */
export async function handleDiet(request, env, context = {}) {
  const original = new URL(request.url);
  if (original.pathname !== '/diet' && !original.pathname.startsWith('/diet/')) return null;
  if (original.pathname === '/diet') return new Response(null, { status: 308, headers: { Location: '/diet/' + original.search } });
  const normalized = new URL(original);
  normalized.pathname = original.pathname.slice('/diet'.length);
  const headers = new Headers(request.headers);
  headers.delete('oai-authenticated-user-id');
  headers.set('oai-authenticated-user-id', context.owner || 'terminal-owner');
  const forwarded = new Request(normalized, { method: request.method, headers,
    ...(!['GET', 'HEAD'].includes(request.method) ? { body: request.body, duplex: 'half' } : {}) });
  const assets = typeof context.assets === 'function' ? context.assets : context.assets
    ? async path => context.assets[path] : async path => {
    if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') throw new Error('Assets unavailable');
    const url = new URL('/diet' + path, original.origin);
    const response = await env.ASSETS.fetch(new Request(url, { method: 'GET' }));
    return response.ok ? response.text() : undefined;
  };
  try {
    const store = context.diaryStore || createD1DiaryStore({ db: env.DB, seed: context.seed });
    const owner = headers.get('oai-authenticated-user-id');
    if (normalized.pathname === '/data/diary.json') {
      if (!['GET', 'HEAD'].includes(request.method)) return responseJSON({ error: { code: 'METHOD_NOT_ALLOWED', message: '此数据接口仅支持读取。' } }, 405);
      const snapshot = await store.load(owner);
      return request.method === 'HEAD' ? new Response(null, { headers: { 'Content-Type': MIME_JSON, 'Cache-Control': 'no-store' } })
        : responseJSON(snapshot.diary);
    }
    // Ordinary HTML/CSS/JS never needs a DB or model call. This also keeps a
    // storage outage from obscuring the app's retry/export controls.
    if (!normalized.pathname.startsWith('/api/')) return await handleRequest(forwarded, env, { assets });
    if (!['/api/diary-chat', '/api/parse-meals'].includes(normalized.pathname)) {
      return await handleRequest(forwarded, env, { assets, diaryStore: store });
    }
    let catalog = context.catalog;
    if (!catalog) {
      const raw = await assets('/data/foods.json');
      if (typeof raw !== 'string') throw new Error('Food catalog unavailable');
      catalog = JSON.parse(raw);
    }
    const snapshot = normalized.pathname === '/api/parse-meals' ? await store.load(owner) : null;
    return await handleRequest(forwarded, env, {
      assets, catalog, ...(snapshot ? { diary: snapshot.diary } : {}), diaryStore: store,
      recipes: snapshot ? recipesFromDiary(snapshot.diary) : [],
      ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
      ...(context.chatImpl ? { chatImpl: context.chatImpl } : {})
    });
  } catch {
    return responseJSON({ error: { code: 'STORAGE_UNAVAILABLE',
      message: '云端日记暂时不可用，本次修改尚未确认保存。请重试，原有记录不会被空数据覆盖。' } }, 503);
  }
}
