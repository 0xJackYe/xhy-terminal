import { today, validDate } from './lib.mjs';
import { createChatDateSessions } from './diary-chat-sessions.mjs';

const $ = selector => document.querySelector(selector);
export const hasPersistentDiary = persistence => persistence === 'local' || persistence === 'cloud';
export const diaryStorageLabel = persistence => persistence === 'cloud' ? '云端日记' : persistence === 'local' ? '本机日记' : '浏览器草稿';

/** Chat messages are plain text; only validated server snapshots reach the diary. */
export function setupDiaryChat({ getState, applySnapshot, setBusy, refresh, syncDrafts, undo } = {}) {
  const form = $('#diary-chat-form'), input = $('#diary-chat-text'), date = $('#diary-chat-date');
  const log = $('#diary-chat-log'), status = $('#diary-chat-status'), submit = $('#diary-chat-submit');
  let history = [], busy = false, retry = null;
  date.value = today();
  const sessions = createChatDateSessions(date.value, () => ({
    history: [], retry: null, input: '', nodes: [], status: '', state: null,
    selectionStart: 0, selectionEnd: 0, logScroll: 0
  }));
  function updateDatePrompts() {
    const examples = [
      `帮我看看${date.value}吃了什么`,
      `把${date.value}早餐的牛奶改成200毫升，其他不变`,
      `${date.value}晚餐计划吃150克熟米饭`
    ];
    document.querySelectorAll('[data-chat-example]').forEach((button, index) => {
      if (examples[index]) button.dataset.chatExample = examples[index];
    });
    input.placeholder = `例如：把 ${date.value} 早餐的牛奶改成 200 毫升，其他不变。`;
  }
  const greeting = () => `正在查看 ${date.value} 的日记。告诉我这一天需要新增、查询或更正什么；如果要修改其他日期，请直接说明。`;
  function message(role, content, changes = []) {
    const article = document.createElement('article'); article.className = `chat-message chat-${role}`;
    const label = document.createElement('strong'); label.textContent = role === 'user' ? '你' : '食光 AI';
    const paragraph = document.createElement('p'); paragraph.textContent = content;
    article.append(label, paragraph);
    if (changes.length) {
      const details = document.createElement('ul'); details.className = 'chat-changes';
      changes.forEach(change => { const item = document.createElement('li'); item.textContent = `${change.date} · ${change.action} · ${change.title}`; details.append(item); });
      article.append(details);
    }
    log.append(article); log.scrollTop = log.scrollHeight; return article;
  }
  function controls() {
    const state = getState();
    const persistent = hasPersistentDiary(state.persistence);
    submit.disabled = busy || !persistent;
    date.disabled = busy;
    submit.textContent = busy ? '正在处理…' : '发送';
    $('#diary-chat-refresh').disabled = busy;
    $('#diary-chat-sync').disabled = busy || !state.draftDays.length || !persistent;
    $('#diary-chat-sync').hidden = !state.draftDays.length;
    $('#diary-chat-undo').disabled = busy || !state.canUndo || !!state.draftDays.length;
    $('#diary-chat-clear').disabled = busy;
    $('#diary-chat-storage').textContent = persistent
      ? `${state.persistence === 'cloud' ? '云端日记' : '日记保存在本机'} · ${state.draftDays.length ? `${state.draftDays.length} 天草稿待同步` : `已同步，版本 ${state.revision}`}`
      : '当前页面为浏览器草稿模式，请从个人总终端打开完整 AI 对话。';
    const privacy = $('.chat-privacy');
    if (privacy) privacy.textContent = persistent
      ? `点击发送后，当前饮食记录、对话和食材参考会交由 DeepSeek 处理。修改通过校验后写入${diaryStorageLabel(state.persistence)}，可撤销最近一次保存。`
      : '当前修改仅保存在浏览器草稿中。连接日记服务后可使用完整 AI 对话。';
  }
  async function action(callback) {
    if (busy) return;
    busy = true; setBusy(true); controls();
    try { await callback(); }
    catch (error) { status.textContent = error.message || '暂时未能完成，输入和草稿已保留。'; status.dataset.state = 'error'; }
    finally { busy = false; setBusy(false); controls(); }
  }
  function setDate(value) {
    const result = sessions.switchDate(value, {
      history, retry, input: input.value, nodes: [...log.childNodes], status: status.textContent,
      state: status.getAttribute('data-state'), selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd, logScroll: log.scrollTop
    }, { busy });
    date.value = result.date;
    if (!result.accepted) return false;
    updateDatePrompts();
    if (!result.changed) return true;
    const session = result.session;
    history = session.history; retry = session.retry; input.value = session.input;
    input.setSelectionRange(session.selectionStart, session.selectionEnd);
    log.replaceChildren(...session.nodes);
    status.textContent = session.status;
    if (session.state === null) status.removeAttribute('data-state'); else status.dataset.state = session.state;
    if (!session.nodes.length) message('assistant', greeting());
    else log.scrollTop = session.logScroll;
    controls();
    return true;
  }
  date.addEventListener('change', () => setDate(date.value));
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!input.value.trim()) return;
    if (!validDate(date.value)) { status.textContent = '请选择有效的默认记录日期。'; return; }
    action(async () => {
      const state = getState();
      if (state.blocked) throw new Error('浏览器草稿需要恢复，请先导出原始草稿，再导入有效备份。');
      const content = input.value.trim();
      const payload = { text: content, recordDate: date.value, expectedRevision: state.revision,
        history: history.slice(-24), draftDays: state.draftDays };
      const fingerprint = JSON.stringify(payload);
      if (!retry || retry.fingerprint !== fingerprint) retry = { fingerprint, payload: { ...payload, requestId: crypto.randomUUID() } };
      status.textContent = '正在理解你的描述并处理日记…'; status.dataset.state = 'busy';
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 70000);
      try {
        const response = await fetch(new URL('./api/diary-chat', document.baseURI), { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(retry.payload), signal: controller.signal });
        const result = await response.json().catch(() => null);
        if (!response.ok || !result?.diary) throw new Error(result?.error?.message || 'AI 暂时没有返回有效结果，请重试。');
        await applySnapshot(result);
        message('user', content); message('assistant', result.reply, result.changes);
        history.push({ role: 'user', content }, { role: 'assistant', content: result.reply });
        history = history.slice(-24); retry = null;
        if (input.value.trim() === content) input.value = '';
        status.textContent = result.saved ? `已保存到${diaryStorageLabel(result.persistence ?? getState().persistence)}${result.changes.length ? ` · ${result.changes.length} 项变更` : ''}。` : '已回复，日记内容未改动。';
        status.dataset.state = 'success';
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('等待 AI 超时，输入已保留。可直接重新发送，系统会避免重复记录。');
        throw error;
      } finally { clearTimeout(timeout); }
    });
  });
  input.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') form.requestSubmit(); });
  document.querySelectorAll('[data-chat-example]').forEach(button => button.addEventListener('click', () => {
    input.value = button.dataset.chatExample; input.focus();
  }));
  $('#diary-chat-refresh').addEventListener('click', () => action(async () => { await refresh(); retry = null; status.textContent = '已读取最新日记，输入和对话已保留。'; }));
  $('#diary-chat-sync').addEventListener('click', () => action(async () => { await syncDrafts({ alreadyBusy: true }); status.textContent = getState().persistence === 'cloud' ? '浏览器草稿已同步到云端日记。' : '本机草稿已同步到日记。'; }));
  $('#diary-chat-undo').addEventListener('click', () => action(async () => {
    const result = await undo(); message('assistant', result.reply); history = []; retry = null; status.textContent = '已恢复最近一次修改前的日记。';
  }));
  $('#diary-chat-clear').addEventListener('click', () => { history = []; retry = null; log.replaceChildren(); message('assistant', `新对话已开始。${greeting()}`); status.textContent = ''; input.focus(); });
  updateDatePrompts();
  message('assistant', greeting());
  controls();
  return { update: controls, setDate, focus: () => input.focus({ preventScroll: true }) };
}
