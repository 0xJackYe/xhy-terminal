import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.mjs';
import { buildCommit } from '../generated.mjs';
import { schemaSQL } from '../schema.mjs';
import { createD1DiaryStore } from '../diary-store.mjs';
import { encryptJson } from '../crypto.mjs';
import { testDatabase, post } from './auth-mail-fixture.mjs';

const ORIGIN = 'https://terminal.example';
const diary = title => ({ schemaVersion: 1, timezone: 'Asia/Shanghai', updatedAt: '2026-10-28T00:00:00Z', days: [{ date: '2026-10-28', title, note: '', meals: [] }] });
function context() {
  const pending = [];
  return { pending, waitUntil(value) { pending.push(value); }, async drain() { while (pending.length) await Promise.all(pending.splice(0)); } };
}
async function environment(t) {
  const fixture = testDatabase(schemaSQL), assets = [];
  const env = { ...fixture, OWNER_ACCESS_KEY: 'test-access-key-'.repeat(3), AUTH_SECRET: 'test-auth-secret-'.repeat(3),
    DEEPSEEK_API_KEY: 'fixture-private-key-not-a-real-credential',
    ASSETS: { async fetch(request) { assets.push(new URL(request.url).pathname); return new Response('asset:' + new URL(request.url).pathname); } } };
  t.after(() => fixture.sqlite.close());
  const ctx = context();
  const login = await worker.fetch(post('/auth/login', { accessKey: env.OWNER_ACCESS_KEY }), env, ctx);
  assert.equal(login.status, 200);
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  const request = (path, options = {}) => new Request(ORIGIN + path, { ...options, headers: { Cookie: cookie, ...options.headers } });
  return { env, ctx, request, assets };
}

test('all personal namespaces require the signed session despite forged owner headers', async t => {
  const { env, ctx, assets } = await environment(t);
  const protectedRoutes = ['/api/overview', '/diet/api/diary', '/diet/data/diary.json', '/btc/api/terminal', '/btc/api/terminal/email', '/btc/api/wallet/combined'];
  for (const path of protectedRoutes) {
    const response = await worker.fetch(new Request(ORIGIN + path, { headers: { 'oai-authenticated-user-id': 'terminal-owner' } }), env, ctx);
    assert.equal(response.status, 401, path); assert.equal((await response.json()).code, 'AUTH_REQUIRED');
  }
  for (const path of ['/', '/diet/', '/diet/app.mjs', '/btc/', '/btc/wallet.html']) {
    const response = await worker.fetch(new Request(ORIGIN + path), env, ctx);
    assert.equal(response.status, 302, path); assert(response.headers.get('Location').startsWith('/auth/login?'));
  }
  assert.equal(assets.length, 0); assert.equal(ctx.pending.length, 0);
});

test('public health reports the actual built source commit and never configuration values', async t => {
  const { env, ctx } = await environment(t);
  const response = await worker.fetch(new Request(ORIGIN + '/api/health'), { ...env, BUILD_COMMIT: 'untrusted-runtime-override' }, ctx);
  assert.equal(response.status, 200); const text = await response.text(), data = JSON.parse(text);
  assert.equal(data.build, buildCommit); assert.match(data.build, /^[a-f0-9]{40}$/);
  assert.equal(data.cloud, true); assert.equal(data.timezone, 'Asia/Shanghai');
  for (const secret of [env.OWNER_ACCESS_KEY, env.AUTH_SECRET, env.DEEPSEEK_API_KEY]) assert(!text.includes(secret));
});

test('authenticated static assets retain namespace paths and security headers', async t => {
  const { env, ctx, request, assets } = await environment(t);
  for (const [path, expected] of [['/', '/'], ['/diet/', '/diet/index.html'], ['/diet/styles.css', '/diet/styles.css'], ['/btc/', '/btc/'], ['/theme-bridge.js', '/theme-bridge.js']]) {
    const response = await worker.fetch(request(path), env, ctx);
    assert.equal(response.status, 200, path); assert.equal(await response.text(), 'asset:' + expected);
    assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('X-Frame-Options'), 'SAMEORIGIN');
  }
  assert.deepEqual(assets, ['/', '/diet/index.html', '/diet/styles.css', '/btc/', '/theme-bridge.js']);
});

test('diary is read dynamically for the trusted owner instead of spoofed owner or static seed', async t => {
  const { env, ctx, request, assets } = await environment(t);
  const store = createD1DiaryStore({ db: env.DB });
  await store.initialize('terminal-owner', { revision: 4, diary: diary('Trusted cloud diary'), receipts: [] });
  await store.initialize('forged-owner', { revision: 99, diary: diary('Other owner diary'), receipts: [] });
  for (const path of ['/diet/api/diary', '/diet/data/diary.json']) {
    const response = await worker.fetch(request(path, { headers: { 'oai-authenticated-user-id': 'forged-owner' } }), env, ctx);
    assert.equal(response.status, 200); const data = await response.json(), current = data.diary || data;
    assert.equal(current.days[0].title, 'Trusted cloud diary');
    assert(!JSON.stringify(data).includes(env.DEEPSEEK_API_KEY));
    if (path.includes('/api/')) { assert.equal(data.revision, 4); assert.equal(data.persistence, 'cloud'); }
  }
  assert.equal(assets.length, 0);
  const head = await worker.fetch(request('/diet/data/diary.json', { method: 'HEAD' }), env, ctx);
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
});

test('wallet page injects the current D1 snapshot with script-safe JSON and no static/private file exposure', async t => {
  const { env, ctx, request, assets } = await environment(t);
  assert.equal((await worker.fetch(request('/btc/wallet.html'), env, ctx)).status, 503);
  const snapshot = { fixture: '</script><script>unsafe-fixture()</script>', balance_btc: '0.125' };
  env.sqlite.prepare('INSERT INTO finance_kv(key,value,updated_ms) VALUES(?,?,?)').run('chain_snapshot', JSON.stringify(snapshot), Date.now());
  const response = await worker.fetch(request('/btc/wallet.html'), env, ctx), html = await response.text();
  assert.equal(response.status, 200); assert(!html.includes('__SNAPSHOT_JSON__')); assert(!html.includes(snapshot.fixture));
  const embedded = /<script id="snapshot" type="application\/json">([^]*?)<\/script>/.exec(html);
  assert(embedded); assert.deepEqual(JSON.parse(embedded[1]), snapshot); assert.equal(assets.length, 0);
  const head = await worker.fetch(request('/btc/wallet.html', { method: 'HEAD' }), env, ctx);
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  for (const path of ['/configs/api-credentials.json', '/cloud/worker.mjs', '/.env', '/btc/.secrets']) {
    const denied = await worker.fetch(request(path), env, ctx);
    assert.equal(denied.status, 404, path); assert(!(await denied.text()).includes(env.DEEPSEEK_API_KEY));
  }
  assert.equal(assets.length, 0);
});

test('same-origin write protection runs before every namespace and never calls a model', async t => {
  const { env, ctx, request } = await environment(t);
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error('Unexpected model/network call'); };
  t.after(() => { globalThis.fetch = original; });
  for (const path of ['/api/services/ensure', '/diet/api/diary-chat', '/diet/api/diary/sync', '/btc/api/terminal/settings', '/btc/api/terminal/email/settings', '/btc/api/wallet/okx/config']) {
    for (const headers of [{ Origin: 'https://attacker.example' }, {}, { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' }]) {
      const response = await worker.fetch(request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' }), env, ctx);
      assert.equal(response.status, 403, path);
    }
  }
  assert.equal(calls, 0); assert.equal(env.sqlite.prepare('SELECT count(*) AS count FROM diet_state').get().count, 0);
  const allowed = await worker.fetch(request('/api/services/ensure', { method: 'POST', headers: { Origin: ORIGIN }, body: '{}' }), env, ctx);
  assert.equal(allowed.status, 200); assert.deepEqual(await allowed.json(), { started: false, cloud: true });
  const tooBig = await worker.fetch(request('/api/services/ensure', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Length': '1000001' }, body: '{}' }), env, ctx);
  assert.equal(tooBig.status, 413);
});

test('removed options redirect to alerts and unknown APIs never fall through to static files', async t => {
  const { env, ctx, request, assets } = await environment(t);
  const options = await worker.fetch(request('/btc/options.html'), env, ctx);
  assert.equal(options.status, 308); assert.equal(options.headers.get('Location'), '/btc/#alerts');
  assert.equal((await worker.fetch(request('/btc/api/unknown'), env, ctx)).status, 404);
  assert.equal((await worker.fetch(request('/diet/api/unknown'), env, ctx)).status, 404);
  assert.equal(assets.length, 0);
});

test('authenticated homepage refresh durably queues new price alerts without sending real mail or dropping the first alert', async t => {
  const { env, ctx, request } = await environment(t), now = Date.now(), day = 86400000;
  env.CONFIG_ENCRYPTION_KEY = 'fixture-config-key-'.repeat(3); env.SMTP_RECIPIENT = 'owner@example.com';
  const encrypted = await encryptJson({ email: 'fixture@qq.com', authorization_code: 'fixtureAuthorization123', enabled: true, enabled_at: now - 60000, epoch: 'fixture-mail-epoch' }, env.CONFIG_ENCRYPTION_KEY);
  env.sqlite.prepare('INSERT INTO mail_kv(key,value,updated_ms) VALUES(?,?,?)').run('config', encrypted, now);
  env.sqlite.prepare('INSERT INTO finance_kv(key,value,updated_ms) VALUES(?,?,?)').run('sync_lock', 'true', now + 60000);
  const original = globalThis.fetch, paths = [];
  globalThis.fetch = async (address, init) => {
    const url = new URL(address); paths.push(url.pathname); assert.equal(url.origin, 'https://data-api.binance.vision'); assert.equal(init.method, 'GET');
    const at = Date.now(), start = Math.floor((at + 28800000) / day) * day - 28800000;
    if (url.pathname === '/api/v3/aggTrades') return Response.json([{ p: '106', T: at }]);
    assert.equal(url.pathname, '/api/v3/klines');
    return Response.json([[start, '100', '106', '99', '106', '1', start + day - 1]]);
  };
  t.after(() => { globalThis.fetch = original; });
  const first = await worker.fetch(request('/api/overview'), env, ctx); assert.equal(first.status, 200); await ctx.drain();
  assert.equal(env.sqlite.prepare('SELECT count(*) AS count FROM market_alerts').get().count, 3);
  assert.equal(env.sqlite.prepare("SELECT count(*) AS count FROM mail_jobs WHERE state='queued'").get().count, 3);
  const second = await worker.fetch(request('/api/overview'), env, ctx); assert.equal(second.status, 200); await ctx.drain();
  assert.equal(env.sqlite.prepare('SELECT count(*) AS count FROM mail_jobs').get().count, 3);
  assert.deepEqual(paths.sort(), ['/api/v3/aggTrades', '/api/v3/klines']);
});
