/** Durable QQ SMTP outbox. Secrets never enter public status or queued payloads. */
import { encryptJson, decryptJson } from './crypto.mjs';

export const MAIL_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS mail_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_ms INTEGER NOT NULL)',
  `CREATE TABLE IF NOT EXISTS mail_jobs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
    state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER NOT NULL,
    payload TEXT NOT NULL, claim_token TEXT, claimed_ms INTEGER, config_epoch TEXT NOT NULL, error TEXT)`,
  'CREATE INDEX IF NOT EXISTS mail_jobs_pending ON mail_jobs(state,next_ms,created_ms)',
];
const STATES = ['queued', 'sending', 'accepted', 'failed', 'unknown', 'expired', 'cancelled'];
const TTL = 900000, LEASE = 120000;
const ERROR_TEXT = {
  authentication: 'SMTP 授权验证失败，请检查发件邮箱及授权码。', recipient: '邮件服务器拒绝了收件地址。',
  sender: '邮件服务器拒绝了发件地址。', rejected: '邮件服务器拒绝了本次邮件。',
  protocol: '邮件服务器回复格式无效。', transport: 'SMTP 连接暂不可用，正在有限重试。',
  unknown: '邮件提交结果待确认，请先查看收件箱，系统不会自动重复发送。',
  expired: '提醒已过期，不再补发。', cancelled: '设置已变更或邮件已停用，旧任务已取消。',
  configuration: '云端邮件配置尚未就绪。',
};
const nowOf = options => typeof options?.now === 'function' ? options.now() : options?.now ?? Date.now();
const encode = text => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const responseHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: responseHeaders });
const failure = (value, status = 503) => json({ error: value }, status);
const senderOK = value => typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+\-=?^_`{|}~]+@(qq\.com|foxmail\.com)$/i.test(value);
const recipientOK = value => typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+\-=?^_`{|}~]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(value);
const codeOK = value => typeof value === 'string' && /^[A-Za-z0-9]{8,128}$/.test(value);
const configOK = value => value && senderOK(value.email) && codeOK(value.authorization_code)
  && typeof value.enabled === 'boolean' && Number.isSafeInteger(value.enabled_at) && value.enabled_at >= 0
  && typeof value.epoch === 'string' && value.epoch.length <= 100;

async function readConfig(env, options = {}) {
  if (!env.CONFIG_ENCRYPTION_KEY) return { config: null, row: null, error: 'configuration' };
  let row = await env.DB.prepare("SELECT value,updated_ms FROM mail_kv WHERE key='config'").first();
  if (!row && senderOK(env.SMTP_SENDER) && codeOK(env.SMTP_QQ_AUTH_CODE)) {
    const now = nowOf(options), initial = { email: env.SMTP_SENDER, authorization_code: env.SMTP_QQ_AUTH_CODE,
      enabled: env.SMTP_ENABLED === 'true', enabled_at: now, epoch: crypto.randomUUID() };
    const encrypted = await encryptJson(initial, env.CONFIG_ENCRYPTION_KEY);
    await env.DB.prepare('INSERT OR IGNORE INTO mail_kv(key,value,updated_ms) VALUES (?,?,?)').bind('config', encrypted, now).run();
    row = await env.DB.prepare("SELECT value,updated_ms FROM mail_kv WHERE key='config'").first();
  }
  if (!row) return { config: null, row: null, error: null };
  try {
    const config = await decryptJson(row.value, env.CONFIG_ENCRYPTION_KEY);
    if (!configOK(config)) return { config: null, row, error: 'configuration' };
    return { config, row, error: null };
  } catch { return { config: null, row, error: 'configuration' }; }
}
function ready(env, config) { return !!(configOK(config) && recipientOK(env.SMTP_RECIPIENT)); }
function safePayload(value) {
  const result = {};
  for (const key of ['price', 'threshold_pct', 'change_pct', 'range_pct', 'at_ms']) {
    if (typeof value?.[key] === 'number' && Number.isFinite(value[key])) result[key] = value[key];
  }
  if (['daily_change', 'day_range'].includes(value?.metric)) result.metric = value.metric;
  if (['up', 'down', 'range', 'test'].includes(value?.direction)) result.direction = value.direction;
  return result;
}
async function status(env, options = {}) {
  const [current, grouped, recent] = await Promise.all([
    readConfig(env, options), env.DB.prepare('SELECT state,count(*) AS count FROM mail_jobs GROUP BY state').all(),
    env.DB.prepare('SELECT id,kind,state,created_ms,updated_ms,attempts,error FROM mail_jobs ORDER BY updated_ms DESC,id DESC LIMIT 20').all(),
  ]);
  const counts = Object.fromEntries(STATES.map(state => [state, 0]));
  for (const row of grouped.results ?? []) if (STATES.includes(row.state)) counts[row.state] = row.count;
  const rows = (recent.results ?? []).map(row => ({ id: row.id, kind: row.kind, state: row.state,
    created_at_ms: row.created_ms, updated_at_ms: row.updated_ms, attempts: row.attempts,
    error: ERROR_TEXT[row.error] ?? null }));
  const recipient = recipientOK(env.SMTP_RECIPIENT) ? env.SMTP_RECIPIENT.split('@') : null;
  const lastError = current.error || (recent.results ?? []).find(row => row.error && ['failed', 'unknown', 'queued'].includes(row.state))?.error;
  return { enabled: !!current.config?.enabled, configured: ready(env, current.config),
    recipient_masked: recipient ? recipient[0].slice(0, 2) + '***@' + recipient[1] : null,
    enabled_at: current.config?.enabled_at ?? null, last_error: ERROR_TEXT[lastError] ?? null, counts, recent: rows };
}

export async function enqueueAlertMail(env, events, options = {}) {
  const { config } = await readConfig(env, options);
  if (!ready(env, config) || !config.enabled || !Array.isArray(events)) return { queued: 0 };
  const now = nowOf(options), commands = [];
  for (const event of events.slice(0, 10)) {
    if (!event || event.kind !== 'market' || typeof event.id !== 'string' || !/^cloud-(?!test)[A-Za-z0-9_-]{1,110}$/.test(event.id)) continue;
    const at = event.local_at_ms ?? event.at_ms;
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(event.at_ms) || at < config.enabled_at
        || at > now + 2000 || event.at_ms > now + 2000 || now - at > TTL || now - event.at_ms > TTL) continue;
    const payload = safePayload(event);
    commands.push(env.DB.prepare(`INSERT OR IGNORE INTO mail_jobs(id,kind,created_ms,updated_ms,state,attempts,next_ms,payload,config_epoch)
      VALUES (?,?,?,?,'queued',0,?,?,?)`).bind(event.id, 'market', at, now, now, JSON.stringify(payload), config.epoch));
  }
  if (!commands.length) return { queued: 0 };
  const results = await env.DB.batch(commands);
  return { queued: results.reduce((sum, row) => sum + (row.meta?.changes === 1 ? 1 : 0), 0) };
}

class SMTPError extends Error {
  constructor(code, phase) { super(code); this.code = code; this.phase = phase; }
}
function buildMessage(job, sender, recipient, env, now) {
  const payload = JSON.parse(job.payload);
  const type = job.kind === 'test' ? '测试邮件' : payload.direction === 'range' ? '当日振幅提醒' : payload.direction === 'down' ? '下跌提醒' : '上涨提醒';
  const subject = 'BTC ' + type;
  const at = Number.isSafeInteger(payload.at_ms) ? payload.at_ms : now;
  const beijing = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(at);
  const body = ['BTC ' + type, '北京时间：' + beijing];
  for (const [key, label] of [['price', 'BTC 价格（USDT）'], ['threshold_pct', '提醒阈值（%）'], ['change_pct', '当日涨跌幅（%）'], ['range_pct', '当日振幅（%）']]) {
    if (typeof payload[key] === 'number' && Number.isFinite(payload[key])) body.push(label + '：' + payload[key]);
  }
  body.push('请打开你的个人终端查看最新行情。邮件可能延迟。');
  const encoded = encode(body.join('\n')).match(/.{1,76}/g).join('\r\n');
  return ['From: <' + sender + '>', 'To: <' + recipient + '>', 'Subject: =?UTF-8?B?' + encode(subject) + '?=',
    'Message-ID: <btc-alert-' + job.id + '@xhy-terminal.invalid>', 'Date: ' + new Date(now).toUTCString(),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encoded].join('\r\n');
}

async function sendSMTP(env, job, config, options) {
  let socket, writer, reader, phase = 'connect', accepted = false;
  let buffer = '';
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  async function line() {
    for (;;) {
      const boundary = buffer.indexOf('\n');
      if (boundary >= 0) { const value = buffer.slice(0, boundary + 1); buffer = buffer.slice(boundary + 1); return value; }
      const result = await reader.read();
      if (result.done) throw new SMTPError('transport', phase);
      buffer += decoder.decode(result.value, { stream: true });
      if (buffer.length > 65536) throw new SMTPError('protocol', phase);
    }
  }
  async function reply(expected, error) {
    let previous = null;
    for (let count = 0; count < 64; count++) {
      const match = /^(\d{3})([- ])[^\r\n]*\r?\n$/.exec(await line());
      if (!match || previous !== null && previous !== Number(match[1])) throw new SMTPError('protocol', phase);
      const code = Number(match[1]); previous = code;
      if (match[2] === '-') continue;
      if (!expected.includes(code)) throw new SMTPError(error, phase);
      return code;
    }
    throw new SMTPError('protocol', phase);
  }
  const write = value => writer.write(encoder.encode(value + '\r\n'));
  let rejectTimeout;
  const timeoutFailure = new Promise((_, reject) => { rejectTimeout = reject; });
  const timeout = setTimeout(() => {
    try { socket?.close(); } catch { /* Deadline remains authoritative. */ }
    rejectTimeout(new SMTPError(phase === 'data' ? 'unknown' : 'transport', phase));
  }, Math.max(1, Math.min(options.timeoutMs ?? 20000, 25000)));
  const operation = (async () => {
    const connector = options.connect ?? (await import('cloudflare:sockets')).connect;
    socket = connector({ hostname: 'smtp.qq.com', port: 465 }, { secureTransport: 'on', allowHalfOpen: false });
    await socket.opened;
    reader = socket.readable.getReader(); writer = socket.writable.getWriter();
    await reply([220], 'protocol');
    await write('EHLO xhy-terminal'); await reply([250], 'protocol');
    phase = 'login';
    await write('AUTH LOGIN'); await reply([334], 'authentication');
    await write(encode(config.email)); await reply([334], 'authentication');
    await write(encode(config.authorization_code)); await reply([235], 'authentication');
    // A setting change or disable cancels the task before any message body is sent.
    const active = await readConfig(env, options);
    if (!active.config?.enabled || active.config.epoch !== config.epoch) throw new SMTPError('cancelled', phase);
    phase = 'envelope';
    await write('MAIL FROM:<' + config.email + '>'); await reply([250], 'sender');
    await write('RCPT TO:<' + env.SMTP_RECIPIENT + '>'); await reply([250, 251], 'recipient');
    await write('DATA'); await reply([354], 'rejected');
    phase = 'data';
    await write(buildMessage(job, config.email, env.SMTP_RECIPIENT, env, nowOf(options)) + '\r\n.');
    await reply([250], 'rejected'); accepted = true;
    try { await write('QUIT'); } catch { /* SMTP already accepted the message. */ }
    return 'accepted';
  })();
  try { return await Promise.race([operation, timeoutFailure]); }
  catch (error) {
    if (accepted) return 'accepted';
    if (error instanceof SMTPError) throw error;
    throw new SMTPError(phase === 'data' ? 'unknown' : 'transport', phase);
  } finally {
    clearTimeout(timeout);
    try { await reader?.cancel(); } catch { /* Best effort socket cleanup. */ }
    try { writer?.releaseLock(); } catch { /* Best effort socket cleanup. */ }
    try { await socket?.close(); } catch { /* No delivery claims from QUIT/close. */ }
  }
}

export async function processMailQueue(env, options = {}) {
  const now = nowOf(options);
  // A crashed request may have passed SMTP DATA; never reclaim it for resending.
  await env.DB.batch([
    env.DB.prepare("UPDATE mail_jobs SET state='unknown',error='unknown',updated_ms=? WHERE state='sending' AND claimed_ms<?").bind(now, now - LEASE),
    env.DB.prepare("UPDATE mail_jobs SET state='expired',error='expired',updated_ms=? WHERE state='queued' AND created_ms<?").bind(now, now - TTL),
  ]);
  const { config } = await readConfig(env, options);
  if (!ready(env, config) || !config.enabled) {
    if (config && !config.enabled) await env.DB.prepare("UPDATE mail_jobs SET state='cancelled',error='cancelled',updated_ms=? WHERE state='queued'").bind(now).run();
    return { processed: 0, state: 'idle' };
  }
  await env.DB.prepare("UPDATE mail_jobs SET state='cancelled',error='cancelled',updated_ms=? WHERE state='queued' AND config_epoch<>?").bind(now, config.epoch).run();
  const job = await env.DB.prepare("SELECT * FROM mail_jobs WHERE state='queued' AND next_ms<=? AND config_epoch=? ORDER BY created_ms,id LIMIT 1").bind(now, config.epoch).first();
  if (!job) return { processed: 0, state: 'idle' };
  const token = crypto.randomUUID();
  const claim = await env.DB.prepare("UPDATE mail_jobs SET state='sending',attempts=attempts+1,claim_token=?,claimed_ms=?,updated_ms=? WHERE id=? AND state='queued' AND config_epoch=?")
    .bind(token, now, now, job.id, config.epoch).run();
  if (claim.meta?.changes !== 1) return { processed: 0, state: 'busy' };
  job.attempts += 1;
  let state, code = null, next = now;
  try { state = await sendSMTP(env, job, config, options); }
  catch (error) {
    code = error instanceof SMTPError ? error.code : 'transport';
    if (code === 'cancelled') state = 'cancelled';
    else if (code === 'unknown' || error.phase === 'data' && !['rejected', 'recipient', 'sender', 'authentication'].includes(code)) { state = 'unknown'; code = 'unknown'; }
    else if (code === 'transport' && job.attempts < 2) { state = 'queued'; next = now + 10000 * 2 ** job.attempts; }
    else state = 'failed';
  }
  const finished = await env.DB.prepare("UPDATE mail_jobs SET state=?,error=?,next_ms=?,updated_ms=? WHERE id=? AND state='sending' AND claim_token=?")
    .bind(state, code, next, nowOf(options), job.id, token).run();
  if (finished.meta?.changes !== 1) return { processed: 1, id: job.id, state: 'unknown' };
  return { processed: 1, id: job.id, state };
}

async function inputJSON(request) {
  const url = new URL(request.url);
  if ((request.headers.get('Origin') && request.headers.get('Origin') !== url.origin)
      || request.headers.get('Sec-Fetch-Site') === 'cross-site' || request.headers.get('X-Terminal-Request') !== '1') throw new Error('forbidden');
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error('invalid');
  const text = await request.text(); if (text.length > 4096) throw new Error('invalid');
  const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
  return value;
}

export async function handleMail(request, env, ctx = {}) {
  const url = new URL(request.url), path = url.pathname;
  if (!['/api/terminal/email', '/api/terminal/email/settings', '/api/terminal/email/test'].includes(path)) return null;
  if (url.search) return failure('邮件接口不接受查询参数。', 400);
  const options = ctx.mailOptions ?? {};
  try {
    if (path === '/api/terminal/email' && request.method === 'GET') return json(await status(env, options));
    if (request.method !== 'POST' || path === '/api/terminal/email') return failure('此邮件接口不支持该操作。', 405);
    let input;
    try { input = await inputJSON(request); }
    catch (error) { return failure(error.message === 'forbidden' ? '请在自己的终端内提交请求。' : '邮件请求格式无效。', error.message === 'forbidden' ? 403 : 400); }
    const current = await readConfig(env, options), old = current.config, now = nowOf(options);
    if (path.endsWith('/settings')) {
      if (!env.CONFIG_ENCRYPTION_KEY || !recipientOK(env.SMTP_RECIPIENT)) return failure('请先配置云端收件地址和加密密钥。', 409);
      if (Object.keys(input).some(key => !['email', 'authorization_code', 'enabled'].includes(key))) return failure('邮件设置字段无效。', 400);
      if ('email' in input && typeof input.email !== 'string' || 'authorization_code' in input && typeof input.authorization_code !== 'string'
          || 'enabled' in input && typeof input.enabled !== 'boolean') return failure('邮件设置格式无效。', 400);
      const email = input.email?.trim() || old?.email;
      const authorization_code = input.authorization_code?.trim() || old?.authorization_code;
      if (!senderOK(email) || !codeOK(authorization_code) || email !== old?.email && !input.authorization_code?.trim()) return failure('请填写 QQ/foxmail 发件邮箱及配套 SMTP 授权码。', 400);
      const enabled = input.enabled ?? old?.enabled ?? false;
      const reset = !old || email !== old.email || !!input.authorization_code?.trim() || enabled && !old.enabled;
      const config = { email, authorization_code, enabled, enabled_at: reset ? now : old.enabled_at, epoch: reset ? crypto.randomUUID() : old.epoch };
      const encrypted = await encryptJson(config, env.CONFIG_ENCRYPTION_KEY);
      const change = env.DB.prepare("INSERT INTO mail_kv(key,value,updated_ms) VALUES ('config',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_ms=excluded.updated_ms WHERE mail_kv.value=?")
        .bind(encrypted, now, current.row?.value ?? null);
      const commands = [change];
      if (reset || !enabled) commands.push(env.DB.prepare("UPDATE mail_jobs SET state='cancelled',error='cancelled',updated_ms=? WHERE state='queued' AND (SELECT value FROM mail_kv WHERE key='config')=?").bind(now, encrypted));
      const result = await env.DB.batch(commands);
      if (result[0].meta?.changes !== 1) return failure('邮件设置刚刚在另一处修改，请刷新后重试。', 409);
      return json(await status(env, options));
    }
    if (Object.keys(input).length) return failure('测试邮件请求格式无效。', 400);
    if (!ready(env, old) || !old.enabled) return failure('请先配置并启用邮件通知。', 409);
    const recent = await env.DB.prepare("SELECT id,state FROM mail_jobs WHERE kind='test' AND config_epoch=? AND created_ms>=? ORDER BY created_ms DESC LIMIT 1")
      .bind(old.epoch, now - 60000).first();
    if (recent) return json(recent, 202);
    const id = 'cloud-mail-test-' + crypto.randomUUID();
    await env.DB.prepare("INSERT INTO mail_jobs(id,kind,created_ms,updated_ms,state,attempts,next_ms,payload,config_epoch) VALUES (?,'test',?,?,'queued',0,?,?,?)")
      .bind(id, now, now, now, JSON.stringify({ at_ms: now, direction: 'test' }), old.epoch).run();
    if (ctx.waitUntil) ctx.waitUntil(processMailQueue(env, options));
    return json({ id, state: 'queued' }, 202);
  } catch { return failure('云端邮件服务暂不可用，请稍后重试。'); }
}
