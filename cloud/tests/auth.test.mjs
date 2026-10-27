import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_SCHEMA, handleAuth, isAuthenticated, assertSameOrigin } from '../auth.mjs';
import { encryptJson, decryptJson, fromBase64Url, toBase64Url } from '../crypto.mjs';
import { testDatabase, NOW, post } from './auth-mail-fixture.mjs';

function environment() { return { ...testDatabase(AUTH_SCHEMA), AUTH_SECRET: 'test-auth-secret-'.repeat(3), OWNER_ACCESS_KEY: 'test-access-code-'.repeat(3) }; }
const authenticatedRequest = cookie => new Request('https://terminal.example/', { headers: { Cookie: cookie.split(';')[0] } });

test('successful login creates a protected seven-day cookie and logout clears it', async () => {
  const env = environment();
  const login = await handleAuth(post('/auth/login', { accessKey: env.OWNER_ACCESS_KEY, returnTo: '/#diet' }), env, { now: NOW });
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), { ok: true, redirect: '/#diet' });
  const cookie = login.headers.get('Set-Cookie');
  for (const flag of ['__Host-xhy-session=', 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Max-Age=604800']) assert(cookie.includes(flag));
  assert(await isAuthenticated(authenticatedRequest(cookie), env, { now: NOW + 1 }));
  assert(!await isAuthenticated(authenticatedRequest(cookie), env, { now: NOW + 604800000 }));
  assert(!await isAuthenticated(authenticatedRequest(cookie), { ...env, OWNER_ACCESS_KEY: 'rotated-'.repeat(8) }, { now: NOW }));
  assert(!await isAuthenticated(authenticatedRequest(cookie.replace('v1.', 'v2.')), env, { now: NOW }));
  const logout = await handleAuth(post('/auth/logout', {}), env, { now: NOW });
  assert.equal(logout.status, 200); assert(logout.headers.get('Set-Cookie').includes('Max-Age=0'));
  env.sqlite.close();
});

test('login limits failed attempts durably and rejects cross-origin requests before storage', async () => {
  const env = environment();
  assert.equal((await handleAuth(post('/auth/login', { accessKey: env.OWNER_ACCESS_KEY }, { Origin: 'https://attacker.example' }), env, { now: NOW })).status, 403);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS count FROM auth_attempts').get().count, 0);
  for (let i = 0; i < 10; i++) assert.equal((await handleAuth(post('/auth/login', { accessKey: 'incorrect' }), env, { now: NOW })).status, 401);
  assert.equal((await handleAuth(post('/auth/login', { accessKey: env.OWNER_ACCESS_KEY }), env, { now: NOW + 1 })).status, 429);
  assert.equal((await handleAuth(post('/auth/login', { accessKey: env.OWNER_ACCESS_KEY }), env, { now: NOW + 900000 })).status, 200);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS count FROM auth_attempts').get().count, 0);
  env.sqlite.close();
});

test('return locations cannot escape the origin and login HTML never includes secrets', async () => {
  const env = environment();
  for (const returnTo of ['//attacker.example', '/\\attacker.example', '/auth/login', '/\r\nLocation:evil', '/\t/attacker.example', 'https://attacker.example']) {
    const login = await handleAuth(post('/auth/login', { accessKey: env.OWNER_ACCESS_KEY, returnTo }), env, { now: NOW });
    assert.equal((await login.json()).redirect, '/');
  }
  const html = await (await handleAuth(new Request('https://terminal.example/auth/login'), env)).text();
  assert(!html.includes(env.OWNER_ACCESS_KEY)); assert(!html.includes(env.AUTH_SECRET));
  assert.equal((await handleAuth(post('/auth/login', { accessKey: env.OWNER_ACCESS_KEY }), { ...env, DB: { prepare() { throw Error('private database error'); } } })).status, 503);
  assert.equal((await handleAuth(new Request('https://terminal.example/auth/login'), {})).status, 503);
  assert(!assertSameOrigin(post('/auth/login', {}, { 'Sec-Fetch-Site': 'cross-site' })));
  assert(!assertSameOrigin(new Request('https://terminal.example/auth/login', { method: 'POST' })));
  env.sqlite.close();
});

test('encrypted configuration is randomized and rejects tampering or the wrong key', async () => {
  const secret = 'test-only-encryption-secret-'.repeat(2), value = { code: 'private-test-fixture', unicode: '日记' };
  const a = await encryptJson(value, secret), b = await encryptJson(value, secret);
  assert.notEqual(a, b); assert(!a.includes(value.code));
  assert.deepEqual(await decryptJson(a, secret), value);
  await assert.rejects(decryptJson(a, secret + 'different'));
  const parts = a.split('.'), bytes = fromBase64Url(parts[2]); bytes[0] ^= 1; parts[2] = toBase64Url(bytes);
  await assert.rejects(decryptJson(parts.join('.'), secret));
  await assert.rejects(encryptJson(value, 'short'));
});
