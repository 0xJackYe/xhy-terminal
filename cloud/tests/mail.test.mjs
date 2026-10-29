import test from 'node:test';
import assert from 'node:assert/strict';
import { MAIL_SCHEMA, handleMail, enqueueAlertMail, processMailQueue } from '../mail.mjs';
import { decryptJson } from '../crypto.mjs';
import { testDatabase, NOW, post } from './auth-mail-fixture.mjs';

function environment() {
  return { ...testDatabase(MAIL_SCHEMA), CONFIG_ENCRYPTION_KEY: 'test-config-encryption-secret-'.repeat(2),
    SMTP_SENDER: 'fixture@qq.com', SMTP_QQ_AUTH_CODE: 'fixtureAuthCode123', SMTP_ENABLED: 'true', SMTP_RECIPIENT: 'owner@example.com' };
}
const event = (id = 'cloud-fixture-event', at = NOW) => ({ id, kind: 'market', at_ms: at, local_at_ms: at, price: 70000, threshold_pct: 5, change_pct: 5.1, direction: 'up', metric: 'daily_change' });
const getStatus = (env, now = NOW) => handleMail(new Request('https://terminal.example/api/terminal/email'), env, { mailOptions: { now } });

function smtp({ rejectAuth = false, transportBeforeData = false, unknownAfterData = false, rejectAfterData = false, quitFails = false } = {}) {
  const writes = [], connections = [];
  const connect = (address, options) => {
    connections.push({ address, options });
    let controller, finished = false;
    const encoder = new TextEncoder();
    const enqueue = value => { if (!finished) controller.enqueue(encoder.encode(value + '\r\n')); };
    const fail = () => { if (!finished) { finished = true; controller.error(Error('private SMTP diagnostic fixture')); } };
    const readable = new ReadableStream({ start(value) { controller = value; enqueue('220 fixture SMTP'); }, cancel() { finished = true; } });
    const writable = new WritableStream({
      write(bytes) {
        const value = new TextDecoder().decode(bytes).replace(/\r\n$/, ''); writes.push(value);
        if (value === 'EHLO xhy-terminal') { if (transportBeforeData) fail(); else enqueue('250-fixture\r\n250 AUTH LOGIN'); }
        else if (value === 'AUTH LOGIN') enqueue('334 VXNlcm5hbWU6');
        else if (value === btoa('fixture@qq.com')) enqueue('334 UGFzc3dvcmQ6');
        else if (value === btoa('fixtureAuthCode123')) enqueue(rejectAuth ? '535 rejected' : '235 accepted');
        else if (value.startsWith('MAIL FROM:')) enqueue('250 sender OK');
        else if (value.startsWith('RCPT TO:')) enqueue('250 recipient OK');
        else if (value === 'DATA') enqueue('354 submit message');
        else if (value.startsWith('From:')) { if (unknownAfterData) fail(); else enqueue(rejectAfterData ? '550 rejected' : '250 queued'); }
        else if (value === 'QUIT') { if (quitFails) throw Error('fixture quit failure'); else enqueue('221 bye'); }
        else throw Error('Unexpected fixture SMTP command');
      },
    });
    return { readable, writable, opened: Promise.resolve(), close() { if (!finished) { finished = true; controller.close(); } } };
  };
  return { connect, writes, connections };
}

test('mail status migrates config encrypted and exposes neither sender nor authorization code', async () => {
  const env = environment(), result = await getStatus(env), text = await result.text(), data = JSON.parse(text);
  assert.equal(result.status, 200); assert.equal(data.enabled, true); assert.equal(data.configured, true);
  assert.equal(data.recipient_masked, 'ow***@example.com');
  assert(!text.includes(env.SMTP_QQ_AUTH_CODE)); assert(!text.includes(env.SMTP_SENDER));
  const row = env.sqlite.prepare("SELECT value FROM mail_kv WHERE key='config'").get();
  assert(!row.value.includes(env.SMTP_QQ_AUTH_CODE));
  assert.equal((await decryptJson(row.value, env.CONFIG_ENCRYPTION_KEY)).authorization_code, env.SMTP_QQ_AUTH_CODE);
  env.sqlite.close();
});

test('enqueue accepts new real market events exactly once and rejects stale, imported, test or future events', async () => {
  const env = environment(); await getStatus(env);
  const events = [event(), event(), { ...event('cloud-test-fixture'), kind: 'test' }, event('old-imported-uuid'), event('cloud-too-old', NOW - 900001), event('cloud-too-new', NOW + 2001), { ...event('cloud-missing-time'), at_ms: null }];
  assert.deepEqual(await enqueueAlertMail(env, events, { now: NOW }), { queued: 1 });
  assert.deepEqual(await enqueueAlertMail(env, [event()], { now: NOW }), { queued: 0 });
  const job = env.sqlite.prepare('SELECT * FROM mail_jobs').get();
  assert.equal(job.state, 'queued'); assert(!job.payload.includes(env.SMTP_QQ_AUTH_CODE));
  assert.equal(env.sqlite.prepare('SELECT count(*) AS count FROM mail_jobs').get().count, 1);
  env.sqlite.close();
});

test('SMTP uses fixed TLS endpoint and persists acceptance only after the final DATA reply', async () => {
  const env = environment(), transport = smtp({ quitFails: true }); await getStatus(env);
  await enqueueAlertMail(env, [event()], { now: NOW });
  const result = await processMailQueue(env, { now: NOW, connect: transport.connect });
  assert.equal(result.state, 'accepted');
  assert.deepEqual(transport.connections, [{ address: { hostname: 'smtp.qq.com', port: 465 }, options: { secureTransport: 'on', allowHalfOpen: false } }]);
  const message = transport.writes.find(value => value.startsWith('From:'));
  assert(message.includes('Content-Transfer-Encoding: base64')); assert(message.endsWith('\r\n.'));
  assert.equal(env.sqlite.prepare('SELECT state,attempts FROM mail_jobs').get().attempts, 1);
  assert.equal((await processMailQueue(env, { now: NOW + 1000, connect: transport.connect })).processed, 0);
  assert.equal(transport.connections.length, 1);
  env.sqlite.close();
});

test('transport failures retry at most twice while authentication and DATA rejection fail permanently', async () => {
  for (const [fault, expected] of [[{ transportBeforeData: true }, 'queued'], [{ rejectAuth: true }, 'failed'], [{ rejectAfterData: true }, 'failed']]) {
    const env = environment(), transport = smtp(fault); await getStatus(env);
    await enqueueAlertMail(env, [event()], { now: NOW });
    assert.equal((await processMailQueue(env, { now: NOW, connect: transport.connect })).state, expected);
    if (expected === 'queued') {
      assert.equal((await processMailQueue(env, { now: NOW + 19999, connect: transport.connect })).processed, 0);
      assert.equal((await processMailQueue(env, { now: NOW + 20000, connect: transport.connect })).state, 'failed');
      assert.equal(env.sqlite.prepare('SELECT attempts FROM mail_jobs').get().attempts, 2);
    }
    const publicStatus = await (await getStatus(env)).text(); assert(!publicStatus.includes('private SMTP diagnostic'));
    env.sqlite.close();
  }
});

test('uncertain DATA outcome and abandoned sending claims never resend a possibly accepted email', async () => {
  const env = environment(), transport = smtp({ unknownAfterData: true }); await getStatus(env);
  await enqueueAlertMail(env, [event()], { now: NOW });
  assert.equal((await processMailQueue(env, { now: NOW, connect: transport.connect })).state, 'unknown');
  assert.equal((await processMailQueue(env, { now: NOW + 60000, connect: transport.connect })).processed, 0);
  await enqueueAlertMail(env, [event('cloud-crashed-job', NOW + 1000)], { now: NOW + 1000 });
  env.sqlite.prepare("UPDATE mail_jobs SET state='sending',claimed_ms=?,attempts=1 WHERE id='cloud-crashed-job'").run(NOW - 120001);
  assert.equal((await processMailQueue(env, { now: NOW, connect: transport.connect })).processed, 0);
  assert.equal(env.sqlite.prepare("SELECT state FROM mail_jobs WHERE id='cloud-crashed-job'").get().state, 'unknown');
  assert.equal(transport.connections.length, 1);
  env.sqlite.close();
});

test('settings persist, disable cancels queued jobs and re-enable never replays old events', async () => {
  const env = environment(); await getStatus(env); await enqueueAlertMail(env, [event()], { now: NOW });
  assert.equal((await handleMail(post('/api/terminal/email/settings', { enabled: false, email: '' }), env, { mailOptions: { now: NOW + 1000 } })).status, 200);
  assert.equal(env.sqlite.prepare('SELECT state FROM mail_jobs').get().state, 'cancelled');
  assert.equal((await processMailQueue(env, { now: NOW + 1000, connect() { throw Error('Must not connect'); } })).processed, 0);
  assert.equal((await handleMail(post('/api/terminal/email/settings', { enabled: true }), env, { mailOptions: { now: NOW + 2000 } })).status, 200);
  assert.equal((await enqueueAlertMail(env, [event('cloud-pre-enable', NOW + 1000)], { now: NOW + 2000 })).queued, 0);
  assert.equal((await enqueueAlertMail(env, [event('cloud-post-enable', NOW + 2000)], { now: NOW + 2000 })).queued, 1);
  env.sqlite.close();
});

test('mail API enforces request boundaries and queues a rate-limited test without claiming delivery', async () => {
  const env = environment();
  assert.equal((await handleMail(post('/api/terminal/email/settings', { enabled: true }, { Origin: 'https://attacker.example' }), env)).status, 403);
  assert.equal((await handleMail(post('/api/terminal/email/settings', { enabled: 'true' }), env)).status, 400);
  assert.equal((await handleMail(post('/api/terminal/email/settings', { email: 'other@qq.com' }), env)).status, 400);
  assert.equal((await handleMail(new Request('https://terminal.example/api/terminal/email?secret=bad'), env)).status, 400);
  const first = await handleMail(post('/api/terminal/email/test', {}), env, { mailOptions: { now: NOW } });
  assert.equal(first.status, 202); const a = await first.json(); assert.equal(a.state, 'queued');
  const b = await (await handleMail(post('/api/terminal/email/test', {}), env, { mailOptions: { now: NOW + 1 } })).json();
  assert.equal(a.id, b.id); assert.equal(env.sqlite.prepare('SELECT count(*) AS count FROM mail_jobs').get().count, 1);
  env.sqlite.close();
});

test('concurrent queue workers claim one message once and expired queued reminders never connect', async () => {
  const env = environment(), transport = smtp(); await getStatus(env);
  await enqueueAlertMail(env, [event()], { now: NOW });
  const results = await Promise.all([
    processMailQueue(env, { now: NOW, connect: transport.connect }),
    processMailQueue(env, { now: NOW, connect: transport.connect }),
  ]);
  assert.equal(results.filter(value => value.state === 'accepted').length, 1);
  assert.equal(transport.connections.length, 1);
  await enqueueAlertMail(env, [event('cloud-will-expire')], { now: NOW });
  assert.equal((await processMailQueue(env, { now: NOW + 900001, connect: transport.connect })).processed, 0);
  assert.equal(env.sqlite.prepare("SELECT state FROM mail_jobs WHERE id='cloud-will-expire'").get().state, 'expired');
  assert.equal(transport.connections.length, 1);
  env.sqlite.close();
});
