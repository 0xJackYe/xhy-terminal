import { today, validDate } from './lib.mjs';

const MAX_LENGTH = 4000;
const EXAMPLES = {
  meal: '今天早餐吃了两个鸡蛋，一杯250毫升牛奶。',
  day: '今天早餐吃了两个鸡蛋和一杯250毫升牛奶，中午吃了一碗米饭、清炒西兰花和鸡胸肉，晚上吃了一碗番茄鸡蛋面。',
};
const MEAL_LABELS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };

function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function speechErrorMessage(code) {
  if (['not-allowed', 'service-not-allowed'].includes(code)) return '没有获得麦克风权限，可以直接打字，或使用手机键盘语音输入。';
  if (code === 'audio-capture') return '暂时无法使用麦克风，可以直接打字，或使用手机键盘语音输入。';
  if (code === 'network') return '浏览器语音服务暂时连不上，已保留文字。可以打字，或改用手机键盘语音输入。';
  if (code === 'no-speech') return '没有听清这次口述，可以再试一次，或直接打字、使用手机键盘语音输入。';
  if (code === 'language-not-supported') return '当前浏览器暂不支持中文口述，可以直接打字，或使用手机键盘语音输入。';
  return '口述暂时不可用，已保留文字。可以直接打字，或使用手机键盘语音输入。';
}

function recordedSummary(days) {
  const meals = days.flatMap(day => day.meals.map(meal => `${day.date.slice(5).replace('-', '月')}日${MEAL_LABELS[meal.type] ?? ''}`));
  return `已填入${[...new Set(meals)].join('、')}。点击“查看记录的日期”即可查看和修改，也可以继续记录。`;
}

/** Connect the natural-language form to the journal's existing storage and rendering. */
export function setupQuickEntry({ apply, undo, onBusy } = {}) {
  const form = document.querySelector('#quick-entry-form');
  if (!form || form.dataset.ready === 'true') return;
  if (typeof apply !== 'function') throw new TypeError('记录功能需要提供 apply 回调。');
  form.dataset.ready = 'true';

  const text = document.querySelector('#quick-text');
  const date = document.querySelector('#quick-date');
  const mealType = document.querySelector('#quick-meal-type');
  const microphone = document.querySelector('#dictate-button');
  const microphoneLabel = microphone.querySelector('span');
  const submit = document.querySelector('#quick-submit');
  const submitLabel = submit.querySelector('.quick-submit-label');
  const status = document.querySelector('#quick-status');
  const count = document.querySelector('#quick-count');
  const hint = document.querySelector('#quick-voice-hint');
  const undoButton = document.querySelector('#quick-undo');
  const exampleButtons = [...form.querySelectorAll('[data-quick-example]')];
  const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  let busy = false;
  let previousBusy = false;
  let speechState = 'idle';
  let activeRecognition = null;
  let activeRequest = null;
  let lastRequest = null;
  let undoToken = null;
  let undoInput = null;
  let navigationCancelled = false;

  date.value = today();
  if (!Recognition) hint.textContent = '当前浏览器不支持直接口述。可以直接打字，或用手机键盘上的语音输入。';

  function setStatus(message, state = '') {
    status.textContent = message;
    status.dataset.state = state;
  }

  function updateCount() {
    count.textContent = `${text.value.length.toLocaleString('en-US')} / 4,000`;
  }

  function invalidateRequest() {
    lastRequest = null;
    updateCount();
  }

  function updateControls() {
    const speechActive = speechState !== 'idle';
    const locked = busy || speechActive;
    form.setAttribute('aria-busy', String(busy));
    text.readOnly = locked;
    date.disabled = locked;
    mealType.disabled = locked;
    submit.disabled = locked;
    microphone.disabled = busy || !Recognition || ['starting', 'stopping'].includes(speechState);
    microphone.setAttribute('aria-pressed', String(speechActive));
    microphone.classList.toggle('is-listening', speechActive);
    microphoneLabel.textContent = speechState === 'stopping' ? '正在结束…' : speechActive ? '结束口述' : '开始口述';
    submitLabel.textContent = busy ? '正在整理…' : '整理并记录';
    undoButton.disabled = locked;
    exampleButtons.forEach(button => { button.disabled = locked; });
    if (locked !== previousBusy) {
      previousBusy = locked;
      onBusy?.(locked);
    }
  }

  function finishSpeech(recognition, message = '', state = '') {
    if (activeRecognition !== recognition) return;
    activeRecognition = null;
    speechState = 'idle';
    updateControls();
    setStatus(message || (text.value.trim() ? '口述已结束。可以修改文字，再点“整理并记录”。' : '可以重新口述，也可以直接打字或使用手机键盘语音输入。'), state);
  }

  function startSpeech() {
    if (busy || speechState !== 'idle' || !Recognition) return;
    if (text.value.length >= MAX_LENGTH) {
      setStatus('已达到4,000字上限，请先整理记录，再继续口述。', 'warning');
      return;
    }
    let recognition;
    try { recognition = new Recognition(); }
    catch { setStatus(speechErrorMessage('unavailable'), 'error'); return; }
    const originalText = text.value;
    const separator = originalText && !/\s$/.test(originalText) ? '\n' : '';
    let endMessage = '';
    let endState = '';
    activeRecognition = recognition;
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      if (activeRecognition !== recognition) return;
      speechState = 'listening';
      updateControls();
      setStatus('正在听，请说出吃了什么和大概分量。说完点“结束口述”。', 'listening');
    };
    recognition.onresult = event => {
      if (activeRecognition !== recognition) return;
      // Every event contains this session's complete results, including revised interim text.
      const words = Array.from(event.results, result => result[0]?.transcript ?? '').join('');
      text.value = `${originalText}${separator}${words}`.slice(0, MAX_LENGTH);
      invalidateRequest();
      if (`${originalText}${separator}${words}`.length > MAX_LENGTH && speechState !== 'stopping') {
        endMessage = '已达到4,000字上限，已保留前面的文字。请先整理记录，再继续添加。';
        endState = 'warning';
        speechState = 'stopping';
        updateControls();
        try { recognition.stop(); } catch { finishSpeech(recognition, endMessage, endState); }
      }
    };
    recognition.onerror = event => {
      if (activeRecognition !== recognition) return;
      endMessage = speechErrorMessage(event.error);
      endState = 'error';
      setStatus(endMessage, endState);
      // A recognition error is followed by end; keep submit locked until it disconnects.
    };
    recognition.onend = () => finishSpeech(recognition, endMessage, endState);
    speechState = 'starting';
    updateControls();
    setStatus('正在打开麦克风，请允许浏览器使用麦克风。', 'listening');
    try { recognition.start(); }
    catch { finishSpeech(recognition, speechErrorMessage('unavailable'), 'error'); }
  }

  microphone.addEventListener('click', () => {
    if (speechState === 'listening' && activeRecognition) {
      speechState = 'stopping';
      updateControls();
      setStatus('正在结束口述并保留文字…', 'listening');
      try { activeRecognition.stop(); }
      catch { finishSpeech(activeRecognition, '口述已结束，可以检查文字后再整理。'); }
    } else startSpeech();
  });

  text.addEventListener('input', invalidateRequest);
  date.addEventListener('input', invalidateRequest);
  mealType.addEventListener('change', invalidateRequest);
  exampleButtons.forEach(button => button.addEventListener('click', () => {
    if (busy || speechState !== 'idle') return;
    const example = EXAMPLES[button.dataset.quickExample];
    text.value = `${text.value.trim()}${text.value.trim() ? '\n' : ''}${example}`.slice(0, MAX_LENGTH);
    invalidateRequest();
    text.focus();
    setStatus('示例已填入，可以改成你实际吃过的食物，再点“整理并记录”。');
  }));

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || speechState !== 'idle') return;
    const input = { text: text.value.trim(), recordDate: date.value, mealType: mealType.value };
    if (!input.text) { setStatus('先说说或写下你吃了什么。', 'warning'); text.focus(); return; }
    if (input.text.length > MAX_LENGTH) { setStatus('一次最多整理4,000字，请分两次记录。', 'warning'); return; }
    if (!validDate(input.recordDate)) { setStatus('请选择实际吃饭的日期。', 'warning'); date.focus(); return; }
    const fingerprint = JSON.stringify(input);
    if (!lastRequest || lastRequest.fingerprint !== fingerprint) lastRequest = { fingerprint, id: requestId() };
    const id = lastRequest.id;
    busy = true;
    navigationCancelled = false;
    updateControls();
    setStatus('正在整理餐次、食材与大概热量，稍等片刻…', 'busy');
    const controller = new AbortController();
    activeRequest = controller;
    const timeout = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(new URL('./api/parse-meals', document.baseURI), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ ...input, requestId: id }),
        signal: controller.signal,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error?.message || '暂时整理失败，文字已保留，请稍后重试。');
      if (!result || typeof result !== 'object') throw new Error('整理服务暂时没有返回有效结果，文字已保留，请稍后重试。');
      const warnings = Array.isArray(result.warnings) ? result.warnings.filter(value => typeof value === 'string') : [];
      if (result.status === 'needs_clarification' || result.code === 'needs_clarification' || result.error?.code === 'needs_clarification' || result.needs_clarification || !Array.isArray(result.days) || result.days.length === 0) {
        setStatus([result.message || result.error?.message || '还需要补充吃了什么、吃饭的日期或餐次，请补充后再试。', ...warnings].join('\n'), 'warning');
        return;
      }
      if (result.requestId && result.requestId !== id) throw new Error('这次返回的记录与输入不一致，文字已保留，请重试。');
      const token = await apply(result.days, { requestId: id });
      undoToken = token;
      undoInput = input;
      undoButton.hidden = typeof undo !== 'function' || token == null;
      text.value = '';
      invalidateRequest();
      setStatus([recordedSummary(result.days), ...warnings].join('\n'), warnings.length ? 'warning' : 'success');
    } catch (error) {
      setStatus(error.name === 'AbortError' ? navigationCancelled ? '已取消整理，输入的文字已保留。' : '这次整理等得有点久，文字已保留，可以重新点“整理并记录”。' : error.message || '暂时无法整理，文字已保留，请稍后重试。', navigationCancelled ? '' : 'error');
    } finally {
      clearTimeout(timeout);
      activeRequest = null;
      busy = false;
      updateControls();
    }
  });

  undoButton.addEventListener('click', async () => {
    if (busy || speechState !== 'idle' || undoToken == null || typeof undo !== 'function') return;
    busy = true;
    updateControls();
    setStatus('正在撤销这次记录…', 'busy');
    try {
      await undo(undoToken);
      if (!text.value.trim() && undoInput) {
        text.value = undoInput.text;
        date.value = undoInput.recordDate;
        mealType.value = undoInput.mealType;
      }
      undoToken = null;
      undoInput = null;
      undoButton.hidden = true;
      invalidateRequest();
      setStatus('已撤销这次记录，之前的日记已恢复。可以修改文字后重新记录。', 'success');
    } catch (error) {
      setStatus(error.message || '暂时无法撤销，请重试。', 'error');
    } finally {
      busy = false;
      updateControls();
    }
  });

  function cancel() {
    if (activeRequest) { navigationCancelled = true; activeRequest.abort(); }
    if (activeRecognition) {
      const recognition = activeRecognition;
      activeRecognition = null;
      speechState = 'idle';
      try { recognition.abort(); } catch { /* The browser may have already disconnected. */ }
      setStatus('口述已结束，输入的文字已保留。');
      updateControls();
    }
  }
  window.addEventListener('pagehide', cancel);

  updateCount();
  updateControls();
  return { focus: () => text.focus(), cancel };
}
