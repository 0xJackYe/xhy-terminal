import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatDateSessions } from '../site/diary-chat-sessions.mjs';

const emptySession = () => ({ history: [], retry: null, input: '', nodes: [], status: '', state: null });

test('跨日期打开 AI 不带入旧日草稿、历史和重试；返回原日完整恢复', () => {
  const sessions = createChatDateSessions('2026-10-23', emptySession);
  const first = { history: [{ role: 'user', content: '晚餐的米饭改成 100 克' }],
    input: '那顿牛排是生重', retry: { payload: { requestId: 'retry-on-23', recordDate: '2026-10-23' } },
    nodes: [{ text: '23 日对话' }], status: '等待重试', state: 'error' };
  const to24 = sessions.switchDate('2026-10-24', first);
  assert.equal(to24.accepted, true); assert.equal(to24.changed, true);
  assert.deepEqual(to24.session, emptySession());
  assert.notEqual(to24.session.history, first.history);
  assert.notEqual(to24.session.nodes, first.nodes);
  const second = { ...to24.session, input: '早餐牛奶 200 毫升',
    history: [{ role: 'assistant', content: '请确认份量' }], nodes: [{ text: '24 日对话' }] };
  const back23 = sessions.switchDate('2026-10-23', second);
  assert.strictEqual(back23.session, first);
  assert.equal(back23.session.retry.payload.recordDate, '2026-10-23');
  assert.strictEqual(sessions.switchDate('2026-10-24', first).session, second);
});

test('同一日期继续现有会话，不创建空会话或清掉输入', () => {
  let created = 0;
  const sessions = createChatDateSessions('2026-10-23', () => { created++; return emptySession(); });
  const current = { input: '尚未发送', history: [{ role: 'user', content: '上一句' }] };
  assert.deepEqual(sessions.switchDate('2026-10-23', current), { accepted: true, changed: false, date: '2026-10-23' });
  assert.equal(created, 0);
  sessions.switchDate('2026-10-24', current);
  assert.strictEqual(sessions.switchDate('2026-10-23', emptySession()).session, current);
});

test('请求处理中和非法日期不能更换上下文或覆盖已保存的会话', () => {
  const sessions = createChatDateSessions('2026-10-23', emptySession);
  const current = { ...emptySession(), input: '原日草稿' };
  for (const [value, options] of [['2026-10-24', { busy: true }], ['', {}], ['2026-02-30', {}]]) {
    assert.deepEqual(sessions.switchDate(value, { input: '不能保存的状态' }, options),
      { accepted: false, changed: false, date: '2026-10-23' });
  }
  sessions.switchDate('2026-10-24', current);
  assert.strictEqual(sessions.switchDate('2026-10-23', emptySession()).session, current);
});
