import { MEALS, NUTRIENTS, today, validDate, estimate, nutritionTotal, dayTotal, validateDiary, validateDay, mergeDays } from './lib.mjs';
import { setupQuickEntry } from './quick-entry.js';
import { applyParsedMeals, undoParsedMeals } from './quick-merge.mjs';
import { writeDrafts } from './draft-storage.mjs';
import { setupDiaryChat } from './diary-chat.js';
import { createSnapshotRefresh } from './diary-refresh.mjs';

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n, digits = 0) => n == null ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: digits });
const dateObj = d => new Date(d + 'T12:00:00+08:00');
const dateLabel = d => dateObj(d).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Shanghai' });
const shift = (d, n) => { const x = dateObj(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const storageKey = 'shiguang-drafts-v1';
let canonical, catalog, drafts = [], days = [], selected = today(), view = 'diary', editing = null, editingDate = null;
let calendarMonth = today().slice(0, 7), detailOpen = false, quickController;
let formSession = false, formDirty = false, recordedDate = null;
let draftReadError = false, rawDraftBackup = null, rawBackupExported = false;
let remote = { revision: 0, persistence: 'unavailable', canUndo: false, apiConfigured: false }, chatController, persistentBusy = false, syncRetry = null;
let dayChatDate = null, dayChatFocusObserver = null;
let daySearchOpen = false;
const expandedMeals = new Map();
const viewScroll = new Map();
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
const activeMotions = new Map();
function animateIn(element, { x = 0, y = 6 } = {}) {
  if (window.XHYMotion) return window.XHYMotion.enter(element, { x, y });
  activeMotions.get(element)?.cancel();
  if (motionPreference.matches || !element?.animate || element.hidden) return;
  const animation = element.animate([
    { opacity: .94, transform: `translate(${x}px, ${y}px)` },
    { opacity: 1, transform: 'translate(0, 0)' }
  ], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' });
  activeMotions.set(element, animation);
  animation.finished.catch(() => {}).finally(() => { if (activeMotions.get(element) === animation) activeMotions.delete(element); });
}
motionPreference.addEventListener?.('change', () => { if (motionPreference.matches) activeMotions.forEach(animation => animation.cancel()); });
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').classList.remove('show'); $('#toast').hidden = true; }, 4500); }
function commitDrafts(next, { recover = false } = {}) {
  if (persistentBusy) throw new Error('正在保存或与 AI 对话，请完成后再修改。');
  if (draftReadError && (!recover || (rawDraftBackup !== null && !rawBackupExported))) throw new Error('原始草稿尚未恢复。请先导出原始草稿，再导入有效的日记备份。');
  const saved = writeDrafts(canonical.days, next, { storage: localStorage, key: storageKey, baseRevision: remote.persistence === 'unavailable' ? undefined : remote.revision });
  drafts = saved.drafts; days = saved.days;
  if (recover) { draftReadError = false; rawDraftBackup = null; $('#draft-recovery').hidden = true; }
}
function setPersistentBusy(value) {
  persistentBusy = value;
  $('#day-ai-toggle').disabled = value;
  document.querySelectorAll('[data-record-method], #save-meal, [data-confirm]').forEach(button => { button.disabled = value; });
}
function updateSyncNote() {
  $('#sync-note').textContent = remote.persistence === 'local'
    ? drafts.length ? `${drafts.length} 天本机草稿待同步。继续与 AI 对话或点“同步本机草稿”会写入日记。` : '日记已保存到本机文件。AI 对话与表格修改使用同一本日记，最近一次保存可以撤销。'
    : '当前页面新增内容保存在浏览器草稿。完整 AI 对话请从个人总终端打开。';
  chatController?.update();
}
async function applyServerSnapshot(result) {
  const next = validateDiary(result.diary);
  let cacheFailure = false;
  try { writeDrafts(next.days, [], { storage: localStorage, key: storageKey, baseRevision: result.revision }); }
  catch {
    cacheFailure = true; draftReadError = true;
    try { rawDraftBackup = localStorage.getItem(storageKey); } catch { rawDraftBackup = null; }
    $('#draft-recovery').hidden = false; $('#export-raw-drafts').hidden = rawDraftBackup === null;
    $('#draft-recovery-message').textContent = '日记已写入本机文件，但浏览器草稿缓存未能清理。请导出原始草稿备份后恢复存储权限，避免旧草稿覆盖最新日记。';
  }
  canonical = next; drafts = []; days = structuredClone(next.days);
  remote = { ...remote, revision: result.revision, persistence: result.persistence, canUndo: result.canUndo };
  if (result.changes?.length) {
    // A reply updates the diary without undoing navigation performed while the
    // request was pending. Opening a date is always a user navigation action.
    recordedDate = result.changes.at(-1).date; $('#record-view-day').hidden = false;
  }
  render(); updateSyncNote();
  if (view === 'diary' && detailOpen && result.changes?.length) history.replaceState({ view: 'diary' }, '', `#day/${selected}`);
  if (result.saved && window.parent !== window) window.parent.postMessage({ type: 'xhy:diary-updated' }, window.location.origin);
  if (cacheFailure) toast('日记已保存，浏览器草稿缓存需要恢复；请查看页面提示。');
}
async function storeRequest(path, payload) {
  const response = await fetch(new URL(`./api/${path}`, document.baseURI), { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.diary) throw new Error(result?.error?.message || '本机保存暂时失败，浏览器草稿已保留，请重试。');
  return result;
}
async function syncDrafts({ alreadyBusy = false } = {}) {
  if (!drafts.length || remote.persistence === 'unavailable') return;
  if (draftReadError) throw new Error('请先导出并恢复原始草稿。');
  if (persistentBusy && !alreadyBusy) throw new Error('正在处理其他修改，请稍后同步。');
  if (!alreadyBusy) setPersistentBusy(true);
  try {
    const payload = { draftDays: drafts, expectedRevision: remote.revision, recordDate: selected };
    const fingerprint = JSON.stringify(payload);
    if (!syncRetry || syncRetry.fingerprint !== fingerprint) syncRetry = { fingerprint, payload: { ...payload, requestId: crypto.randomUUID() } };
    const result = await storeRequest('diary/sync', syncRetry.payload);
    await applyServerSnapshot(result); syncRetry = null;
  } finally { if (!alreadyBusy) setPersistentBusy(false); updateSyncNote(); }
}
async function readServerDiary() {
  const response = await fetch(new URL('./api/diary', document.baseURI), { cache: 'no-store', credentials: 'same-origin' });
  const result = await response.json();
  if (!response.ok || !result.diary) throw new Error(result?.error?.message || '暂时无法读取最新日记。');
  validateDiary(result.diary);
  return result;
}
async function refreshServerDiary() {
  const result = await readServerDiary();
  if (drafts.length && result.revision !== remote.revision) {
    rawDraftBackup = localStorage.getItem(storageKey); draftReadError = true; drafts = [];
    $('#draft-recovery').hidden = false; $('#export-raw-drafts').hidden = rawDraftBackup === null;
    $('#draft-recovery-message').textContent = '日记已在另一处更新，本机草稿已保留但暂停合并。请先导出原始草稿，再检查并导入要保留的记录，防止旧数据覆盖新修改。';
  }
  canonical = result.diary; remote = { ...remote, ...result }; days = mergeDays(canonical.days, drafts); render(); updateSyncNote();
}
function selectedDay() { return days.find(d => d.date === selected); }
function isDraft(id, date = selected) { return drafts.some(d => d.date === date && d.meals.some(m => m.id === id)); }
function weekDates() { const dow = dateObj(selected).getUTCDay(); const monday = shift(selected, -(dow === 0 ? 6 : dow - 1)); return Array.from({ length: 7 }, (_, i) => shift(monday, i)); }
function eatenDays(list) { return list.filter(d => d.meals.some(m => m.status === 'eaten')); }
function setDate(date) {
  if (!validDate(date)) return;
  const changed = selected !== date || !detailOpen;
  selected = date; calendarMonth = date.slice(0, 7); detailOpen = true;
  if (changed) { expandedMeals.delete(date); daySearchOpen = false; $('#search-input').value = ''; }
  switchView('diary');
  showDayDetail();
}
function returnToCalendar({ history = true } = {}) {
  detailOpen = false;
  daySearchOpen = false;
  $('#search-input').value = '';
  switchView('diary', { history });
  scrollToPageStart();
  $(`[data-calendar-date="${selected}"]`)?.focus({ preventScroll: true });
}
function scrollToPageStart() {
  window.scrollTo({ top: 0, behavior: 'auto' });
  try {
    if (window.frameElement && window.parent.location.origin === location.origin) window.parent.scrollTo({ top: 0, behavior: 'auto' });
  } catch { /* Standalone and foreign-hosted diaries keep their own scrolling. */ }
}
function restoreRoute() {
  const route = location.hash.slice(1) || 'diary';
  const dayRoute = /^day\/(\d{4}-\d{2}-\d{2})$/.exec(route);
  if (dayRoute && validDate(dayRoute[1])) {
    if (selected !== dayRoute[1]) $('#search-input').value = '';
    selected = dayRoute[1]; calendarMonth = selected.slice(0, 7); detailOpen = true;
    switchView('diary', { history: false }); showDayDetail();
  } else if (['trends', 'foods', 'record'].includes(route)) switchView(route, { history: false });
  else returnToCalendar({ history: false });
}
function switchView(next, { history = true, replace = false } = {}) {
  if (!['diary', 'trends', 'foods', 'record'].includes(next)) next = 'diary';
  const changed = next !== view;
  const focusInPreviousView = document.activeElement?.closest(`#view-${view}`);
  if (changed) { viewScroll.set(view, window.scrollY); activeMotions.forEach(animation => animation.cancel()); }
  if (changed && (next === 'foods' || view === 'foods')) $('#search-input').value = '';
  if (view === 'record' && next !== 'record') quickController?.cancel();
  view = next;
  for (const v of ['diary', 'trends', 'foods', 'record']) $(`#view-${v}`).hidden = v !== view;
  document.body.classList.toggle('is-record-view', view === 'record');
  document.querySelector('.hero').hidden = view === 'record' || (view === 'diary' && detailOpen);
  const route = view === 'diary' && detailOpen ? `day/${selected}` : view;
  if (history && location.hash !== `#${route}`) window.history[replace ? 'replaceState' : 'pushState']({ view: next }, '', `#${route}`);
  document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === view); if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  render();
  if (changed) {
    window.scrollTo({ top: viewScroll.get(next) ?? 0, behavior: 'auto' });
    if (focusInPreviousView || document.activeElement?.closest('[hidden]')) {
      const candidate = $(`#view-${next} h2`);
      const heading = candidate && !candidate.closest('[hidden]') ? candidate : $('#add-meal-button');
      heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true });
    }
  }
}
function setRecordMethod(method) {
  const changed = $(`#record-method-${method}`).getAttribute('aria-selected') !== 'true';
  for (const mode of ['natural', 'form']) {
    $(`#record-${mode}-panel`).hidden = mode !== method;
    const button = $(`#record-method-${mode}`);
    button.classList.toggle('active', mode === method);
    button.setAttribute('aria-selected', String(mode === method));
    button.tabIndex = mode === method ? 0 : -1;
  }
  if (changed && view === 'record') animateIn($(`#record-${method}-panel`), { x: method === 'form' ? 8 : -8, y: 0 });
}
function openRecord(method) {
  if (persistentBusy) { toast('正在处理日记，请稍后再打开新的记录。'); return; }
  closeDayAi();
  const recordDate = detailOpen ? selected : today();
  chatController?.setDate(recordDate);
  if (!formSession || (!formDirty && !editing)) { prepareMealForm(); $('#entry-date').value = recordDate; }
  if (!$('#quick-text').value.trim()) {
    $('#quick-date').value = recordDate;
    $('#quick-date').dispatchEvent(new Event('input', { bubbles: true }));
  }
  setRecordMethod(method ?? (formDirty || editing ? 'form' : 'natural'));
  switchView('record');
  $('#record-back').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'auto' });
}
function closeDayAi() {
  dayChatFocusObserver?.disconnect(); dayChatFocusObserver = null;
  if (!dayChatDate) return;
  dayChatDate = null;
  $('#day-ai-panel').hidden = true;
  $('#day-ai-toggle').setAttribute('aria-expanded', 'false');
  $('#day-ai-toggle').innerHTML = '用 AI 修改这一天 <span aria-hidden="true">↗</span>';
  const chat = $('.diary-chat');
  $('#record-natural-panel').insertBefore(chat, $('.legacy-quick'));
  $('#diary-chat-title').textContent = '和食光聊聊';
}
function toggleDayAi() {
  if (persistentBusy || !chatController) return;
  if (dayChatDate) { closeDayAi(); $('#day-ai-toggle').focus(); return; }
  if (chatController.setDate(selected) === false) return;
  dayChatDate = selected;
  $('#day-ai-panel').append($('.diary-chat'));
  $('#diary-chat-title').textContent = `修改 ${selected} 的饮食`;
  $('#day-ai-panel').hidden = false;
  $('#day-ai-toggle').setAttribute('aria-expanded', 'true');
  $('#day-ai-toggle').textContent = '收起 AI 对话';
  animateIn($('#day-ai-panel'), { y: 4 });
  // Let the embedded document announce its expanded height before focusing.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!dayChatDate) return;
    chatController.focus();
    const input = $('#diary-chat-text');
    try {
      // The personal terminal owns scrolling when this diary is embedded.
      // Center the composer in that viewport, rather than the tall iframe.
      if (window.frameElement && window.parent.location.origin === location.origin) {
        const frameElement = window.frameElement;
        const centerComposer = () => {
          if (!dayChatDate) { dayChatFocusObserver?.disconnect(); return; }
          const field = input.getBoundingClientRect();
          // Wait for the terminal to apply the expanded content height first;
          // otherwise its old scroll limit would cut this movement short.
          if (frameElement.clientHeight + 1 < field.bottom) return;
          dayChatFocusObserver?.disconnect(); dayChatFocusObserver = null;
          const frame = frameElement.getBoundingClientRect();
          window.parent.scrollBy({ top: frame.top + field.top - (window.parent.innerHeight - field.height) / 2, behavior: 'auto' });
        };
        dayChatFocusObserver = new ResizeObserver(centerComposer);
        dayChatFocusObserver.observe(frameElement);
        centerComposer();
      } else input.scrollIntoView({ block: 'center', behavior: 'auto' });
    } catch { input.scrollIntoView({ block: 'center', behavior: 'auto' }); }
  }));
}
function statsMarkup(day) {
  const total = dayTotal(day), planned = dayTotal(day, 'planned');
  const count = day?.meals.filter(m => m.status === 'eaten').length ?? 0;
  return [
    ['已记录热量', total.kcal, 'kcal', `${count ? `${count} 餐已吃` : '尚无已吃记录'}${planned.kcal ? ` · 计划另约 ${fmt(planned.kcal)} kcal` : ''}`],
    ['蛋白质', total.protein, 'g', '来自已吃的餐食'],
    ['碳水化合物', total.carbs, 'g', '按食材份量估算'],
    ['总脂肪', total.fat, 'g', '包括已记录的用油']
  ].map(([label, value, unit, detail]) => `<div class="stat-card"><div class="stat-label">${label}</div><div><span class="stat-value">${count ? fmt(value, unit === 'g' ? 1 : 0) : '—'}</span><span class="stat-unit">${unit}</span></div><div class="stat-detail">${detail}</div></div>`).join('');
}
function mealMarkup(meal) {
  const total = nutritionTotal(meal.items);
  return `<details class="meal-card meal-disclosure" name="day-meals" data-meal-id="${esc(meal.id)}"${expandedMeals.get(selected) === meal.id ? ' open' : ''}><summary class="meal-summary"><span class="meal-summary-type">${MEALS[meal.type]}</span><span class="meal-summary-name">${esc(meal.title)}</span><span class="meal-summary-status">${meal.status === 'planned' ? '计划' : '已吃'}${isDraft(meal.id) ? ' · 草稿' : ''}</span><span class="meal-summary-kcal">${fmt(total.kcal)} <small>kcal</small></span><span class="meal-disclosure-mark" aria-hidden="true">+</span></summary><div class="meal-detail-content">
  <div class="food-table-wrap"><table class="food-table"><thead><tr><th>食材</th><th>份量与依据</th><th>热量</th></tr></thead><tbody>${meal.items.map(item => `<tr><td>${item.note ? `<details class="item-detail"><summary class="food-name">${esc(item.name)}</summary><p>${esc(item.note)}</p></details>` : `<span class="food-name">${esc(item.name)}</span>`}</td><td>${fmt(item.amount, 1)} ${esc(item.unit)} <span class="weight-basis">${esc(item.basis ?? '')}</span>${item.estimatedPortion ? '<span class="portion-estimate">份量估算</span>' : ''}</td><td>${fmt(item.nutrition.kcal)} <small>kcal</small></td></tr>`).join('')}</tbody></table></div>
  <div class="meal-footer"><span>蛋白质 ${fmt(total.protein, 1)}g <span class="footer-separator">·</span> 膳食纤维 ${fmt(total.fiber, 1)}g <span class="footer-separator">·</span> 饱和脂肪 ${fmt(total.saturatedFat, 1)}g</span><div class="meal-actions">${meal.status === 'planned' ? `<button data-confirm="${esc(meal.id)}">确认已吃</button>` : ''}<button data-edit="${esc(meal.id)}" aria-label="编辑${esc(meal.title)}">编辑</button></div></div>${meal.note ? `<p class="meal-note">${esc(meal.note)}</p>` : ''}</div></details>`;
}
function chartMarkup(dates) {
  const values = dates.map(date => { const d = days.find(d => d.date === date); return d?.meals.some(m => m.status === 'eaten') ? dayTotal(d).kcal : null; });
  const max = Math.max(1, ...values.filter(v => v != null));
  return `<div class="chart-bars">${dates.map((date, i) => `<button class="chart-column" data-date="${date}" aria-label="${date} ${values[i] == null ? '未记录' : `已吃约${fmt(values[i])}千卡`}"><span class="chart-value">${values[i] == null ? '—' : fmt(values[i])}</span><span class="chart-bar ${date === selected ? 'is-current' : ''} ${values[i] == null ? 'is-missing' : ''}" style="height:${values[i] == null ? 5 : Math.max(6, values[i] / max * 100)}%"></span><span class="chart-day">${['日', '一', '二', '三', '四', '五', '六'][dateObj(date).getUTCDay()]}</span></button>`).join('')}</div>`;
}
function render() {
  const page = view === 'diary' ? detailOpen ? `day/${selected}` : 'calendar' : view;
  const pageChanged = document.body.dataset.diaryPage !== page;
  if (dayChatDate && (view !== 'diary' || !detailOpen || dayChatDate !== selected)) closeDayAi();
  const day = selectedDay();
  $('#selected-date-title').textContent = dateLabel(selected);
  $('#selected-date-subtitle').textContent = day?.title || '每一餐，都值得好好记录';
  $('#selected-date-subtitle').hidden = !day?.title || day.title === '饮食记录';
  renderCalendar();
  document.body.classList.toggle('is-day-view', view === 'diary' && detailOpen);
  $('.month-calendar').hidden = detailOpen;
  $('#day-detail').hidden = !detailOpen;
  document.querySelector('.hero').hidden = view === 'record' || (view === 'diary' && detailOpen);
  $('#record-back').textContent = detailOpen ? '← 返回当天' : '← 返回日历';
  const searchVisible = view === 'foods' || (view === 'diary' && detailOpen && daySearchOpen);
  $('.topbar').hidden = view === 'diary' && detailOpen && !daySearchOpen;
  $('#day-search-toggle').setAttribute('aria-expanded', String(daySearchOpen));
  $('.search-box').hidden = !searchVisible;
  $('#search-input').placeholder = view === 'foods' ? '搜索食材…' : '搜索当天餐食…';
  $('#search-input').setAttribute('aria-label', view === 'foods' ? '搜索食材' : '搜索当天餐食');
  $('#daily-stats').innerHTML = statsMarkup(day);
  const query = $('#search-input').value.trim().toLowerCase();
  const order = Object.keys(MEALS);
  const matched = (day?.meals.filter(m => `${m.title} ${m.note ?? ''} ${m.items.map(i => i.name).join(' ')}`.toLowerCase().includes(query)) ?? []).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  $('#meal-list').innerHTML = matched.length ? matched.map(mealMarkup).join('') : `<div class="empty-state"><span>◡</span><h3>${query ? '没有找到这道食物' : '这一天还没有记录'}</h3><p>${query ? '试试其他食材名称。' : '记录吃过的一餐，食材和估算会出现在这里。'}</p>${query ? '' : '<button class="button button-primary" data-new-meal>＋ 记录饮食</button>'}</div>`;
  $('#day-ai-hint').textContent = '描述要改的内容，发送后保存到这一天。';
  const total = day?.meals.some(m => m.status === 'eaten') ? dayTotal(day) : Object.fromEntries(NUTRIENTS.map(n => [n, null])), energy = total.kcal || 1;
  $('#daily-macros').innerHTML = [['蛋白质', total.protein, 4, 'protein'], ['碳水化合物', total.carbs, 4, 'carbs'], ['脂肪', total.fat, 9, 'fat']].map(([label, n, factor, cls]) => `<div class="macro-row"><span class="macro-label">${label}</span><span class="macro-track"><span class="${cls}" style="width:${Math.min(100, (n || 0) * factor / energy * 100)}%"></span></span><span class="macro-value">${fmt(n, 1)}g</span></div>`).join('') + `<div class="nutrition-extra"><span>膳食纤维 <strong>${fmt(total.fiber, 1)}g</strong></span><span>饱和脂肪 <strong>${fmt(total.saturatedFat, 1)}g</strong></span></div><p class="source-note">色条为估算供能占比；“—”表示数据不完整。</p>`;
  $('#weekly-chart').innerHTML = chartMarkup(weekDates());
  const count = eatenDays(days.filter(d => weekDates().includes(d.date))).length;
  $('#coverage-note').textContent = `本周 ${count} 天有已吃记录 · 空白日期不计入均值`;
  if (view === 'trends') renderTrends();
  if (view === 'foods') renderFoods();
  updateSyncNote();
  if (pageChanged) {
    document.body.dataset.diaryPage = page;
    window.XHYMotion?.cancelAll();
    activeMotions.forEach(animation => animation.cancel());
    animateIn(view === 'diary' ? detailOpen ? $('#day-detail') : $('.month-calendar') : $(`#view-${view}`));
  }
}
function renderTrends() {
  const week = days.filter(d => weekDates().includes(d.date)), eaten = eatenDays(week);
  const avg = eaten.length ? eaten.reduce((s, d) => s + dayTotal(d).kcal, 0) / eaten.length : null;
  $('#trend-content').innerHTML = `<div class="trend-grid"><div class="trend-card"><span class="stat-label">本周已记录</span><div class="stat-value">${eaten.length}<small> 天</small></div><p>仅统计有已吃餐食的日期</p></div><div class="trend-card"><span class="stat-label">已记录日均热量</span><div class="stat-value">${fmt(avg)}<small> kcal</small></div><p>部分天尚未记全，均值仅作记录参考</p></div></div><div class="trend-card"><h3>这一周的记录</h3>${chartMarkup(weekDates())}</div><div class="history-list">${[...days].reverse().map(day => `<button class="history-day" data-history-date="${day.date}"><span>${dateLabel(day.date)}<small>${esc(day.title)}</small></span><span>${fmt(dayTotal(day).kcal)} kcal <small>已吃 ${day.meals.filter(m => m.status === 'eaten').length} 餐 · 计划 ${day.meals.filter(m => m.status === 'planned').length} 餐</small></span><span>↗</span></button>`).join('') || '<p class="empty-state">还没有饮食记录。</p>'}</div>`;
}
function renderFoods() {
  const query = $('#search-input').value.trim().toLowerCase();
  const filtered = catalog.foods.filter(f => `${f.name} ${f.basis}`.toLowerCase().includes(query));
  $('#food-reference').innerHTML = `<p class="source-note">每 100g 可食部的参考营养；牛奶按 1ml ≈ 1g 估算。包装食品以手中的标签为准，烹调用油单独计算。数值用于日记估算。</p><div class="reference-grid">${filtered.map(f => `<article class="reference-card"><div class="reference-heading"><h3>${esc(f.name)}</h3><strong>${fmt(f.per100.kcal)}<small> kcal / 100${esc(f.unit)}</small></strong></div><p>${esc(f.basis)}</p><div class="reference-nutrients">蛋白质 ${fmt(f.per100.protein, 1)}g · 碳水 ${fmt(f.per100.carbs, 1)}g · 脂肪 ${fmt(f.per100.fat, 1)}g</div><p class="source-note">${esc(f.note ?? '')}</p><a href="${esc(catalog.sources.find(s => s.id === f.sourceId)?.url || 'https://fdc.nal.usda.gov/download-datasets/')}" target="_blank" rel="noreferrer">${esc(catalog.sources.find(s => s.id === f.sourceId)?.name || '营养参考来源')} ↗</a></article>`).join('') || '<p class="empty-state" role="status">没有找到这种食材，试试其他名称。</p>'}</div>`;
}
async function saveDraft(day) {
  validateDay(day); commitDrafts(mergeDays(drafts, [day])); render();
  await syncDrafts();
}
function commitQuickDrafts(next) {
  commitDrafts(next);
}
function applyQuickEntry(incoming) {
  const result = applyParsedMeals(canonical.days, drafts, incoming);
  if (!result.alreadyApplied) commitQuickDrafts(result.drafts);
  selected = incoming.at(-1)?.date ?? selected;
  recordedDate = selected;
  calendarMonth = selected.slice(0, 7); detailOpen = true;
  $('#search-input').value = '';
  $('#record-view-day').hidden = false;
  render();
  return result.alreadyApplied ? null : result.undoToken;
}
function undoQuickEntry(token) {
  const result = undoParsedMeals(canonical.days, drafts, token);
  if (result.preservedCount) throw new Error('这次记录里有餐食后来被编辑过，已保留这些修改。请直接在对应卡片里调整。');
  commitQuickDrafts(result.drafts);
  $('#record-view-day').hidden = true;
  render();
}
function prepareMealForm(meal = null) {
  formSession = true; formDirty = false;
  editing = meal;
  editingDate = meal ? selected : null;
  $('#meal-form').reset();
  $('#entry-date').value = selected;
  $('#entry-date').readOnly = !!meal;
  $('#entry-type').value = meal?.type ?? 'breakfast';
  $('#entry-status').value = meal?.status ?? 'eaten';
  $('#entry-title').value = meal?.title ?? '';
  $('#entry-note').value = meal?.note ?? '';
  $('#food-rows').replaceChildren();
  (meal?.items ?? [null]).forEach(addFoodRow);
  $('#meal-dialog-title').textContent = meal ? '编辑这顿饭' : '填写餐食';
}
function openMeal(meal = null) {
  prepareMealForm(meal);
  setRecordMethod('form');
  switchView('record');
  $('#entry-title').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'auto' });
}
function addFoodRow(item = null) {
  const row = document.createElement('div'); row.className = 'food-row';
  const food = catalog.foods.find(f => f.id === item?.foodId);
  row.innerHTML = `<div class="food-row-top"><label>参考食材<select class="row-food">${catalog.foods.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}<option value="custom">其他食物 · 手动估算</option></select></label><button class="remove-row" type="button" aria-label="移除此食材">×</button></div><div class="food-row-fields"><label>食材名称<input class="row-name" maxlength="100" required></label><label>份量<input class="row-amount" type="number" min="0.1" max="10000" step="0.1" required></label><label>单位<select class="row-unit"><option value="g">g</option><option value="ml">ml</option></select></label><label>本份热量 kcal<input class="row-kcal" type="number" min="0" max="100000" step="0.1" required></label></div><p class="row-estimate"></p>`;
  const get = s => row.querySelector(s);
  get('.row-food').value = item ? food?.id ?? 'custom' : catalog.foods[0].id;
  get('.row-name').value = item?.name ?? catalog.foods[0].name;
  get('.row-amount').value = item?.amount ?? 100;
  get('.row-unit').value = item?.unit ?? 'g';
  get('.row-kcal').value = item?.nutrition.kcal ?? catalog.foods[0].per100.kcal;
  const update = (resetName = false) => {
    const f = catalog.foods.find(f => f.id === get('.row-food').value);
    get('.row-kcal').readOnly = !!f;
    if (f) {
      if (resetName) { get('.row-name').value = f.name; get('.row-unit').value = f.unit; }
      get('.row-kcal').value = estimate(f, Number(get('.row-amount').value)).kcal;
    }
    get('.row-estimate').textContent = f ? `${f.basis}；${f.note ?? '按参考食材估算，实际以品牌与烹调方式为准。'}` : '填写这一份的总热量。其他营养素记为未知，不当作零。';
  };
  get('.row-food').addEventListener('change', () => update(true));
  get('.row-amount').addEventListener('input', () => update());
  get('.row-unit').addEventListener('change', () => update());
  get('.remove-row').addEventListener('click', () => { if ($('#food-rows').children.length > 1) { row.remove(); formDirty = true; } else toast('每餐至少保留一种食材。'); });
  row.originalItem = item; update(); $('#food-rows').append(row);
}
async function saveMeal(event) {
  event.preventDefault();
  try {
    const date = $('#entry-date').value;
    if (editing && date !== editingDate) { toast('编辑餐食时保留原日期；其他日期请新增餐食。'); return; }
    const latestMeal = editing && days.find(day => day.date === editingDate)?.meals.find(meal => meal.id === editing.id);
    if (editing && JSON.stringify(latestMeal) !== JSON.stringify(editing)) { toast('这餐已更新，请返回日历重新打开编辑，以保留最新食材。'); return; }
    const items = [...$('#food-rows').children].map((row, i) => {
      const get = s => row.querySelector(s).value;
      const food = catalog.foods.find(f => f.id === get('.row-food'));
      const amount = Number(get('.row-amount'));
      const old = row.originalItem;
      const sameFood = old && old.foodId === (food?.id ?? null);
      const sameQuantity = sameFood && old.amount === amount && old.unit === get('.row-unit');
      const conversionNote = food?.unit === 'g' && get('.row-unit') === 'ml' ? '体积暂按 1ml≈1g 估算。' : '';
      const note = sameQuantity ? old.note ?? '' : `${old && sameFood ? `网页更正为 ${amount}${get('.row-unit')}。原记录：${old.note ?? ''} ` : ''}${conversionNote}`;
      return { id: old?.id ?? `item-${crypto.randomUUID()}`, foodId: food?.id ?? null, name: get('.row-name').trim(), amount, unit: get('.row-unit'), basis: sameFood ? old.basis : food?.basis ?? '手动记录', estimatedPortion: sameQuantity ? old.estimatedPortion : true, nutrition: food ? estimate(food, amount) : { ...Object.fromEntries(NUTRIENTS.map(n => [n, null])), kcal: Number(get('.row-kcal')) }, note };
    });
    const confirmed = editing?.status === 'planned' && $('#entry-status').value === 'eaten';
    const meal = { ...editing, id: editing?.id ?? `meal-${crypto.randomUUID()}`, type: $('#entry-type').value, status: $('#entry-status').value, title: $('#entry-title').value.trim(), note: `${$('#entry-note').value.trim()}${confirmed ? '（后续已在网站确认吃过。）' : ''}`, modifiedAt: new Date().toISOString(), items };
    const previous = days.find(d => d.date === date);
    await saveDraft({ date, title: previous?.title ?? '认真吃饭的一天', note: `${previous?.note ?? ''}${confirmed ? ` 补充：${MEALS[meal.type]}已在网站确认为吃过。` : ''}`, source: previous?.source ?? { label: '网站手动记录' }, meals: [meal] });
    formSession = false; formDirty = false;
    selected = date; calendarMonth = date.slice(0, 7); detailOpen = true;
    switchView('diary', { replace: true }); showDayDetail(); toast(remote.persistence === 'local' ? '已保存到本机日记。' : '已保存到本机草稿。');
  } catch (error) { toast(error.message); }
}
function renderCalendar() {
  const month = calendarMonth;
  $('#calendar-month').value = month;
  if (!/^\d{4}-\d{2}$/.test(month)) return;
  const first = month + '-01', count = Number(shift(shift(first, 32).slice(0, 7) + '-01', -1).slice(-2));
  const pad = (dateObj(first).getUTCDay() + 6) % 7;
  $('#calendar-grid').innerHTML = ['一', '二', '三', '四', '五', '六', '日'].map(x => `<span class="month-weekday">周${x}</span>`).join('') + '<span class="month-pad" aria-hidden="true"></span>'.repeat(pad) + Array.from({ length: count }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, '0')}`;
    const day = days.find(d => d.date === date);
    const eaten = day?.meals.filter(m => m.status === 'eaten').length ?? 0;
    const planned = day?.meals.filter(m => m.status === 'planned').length ?? 0;
    const active = detailOpen && date === selected;
    const description = [eaten ? `${eaten}餐已吃` : '', planned ? `${planned}餐计划` : ''].filter(Boolean).join('，') || '未记录';
    return `<button type="button" class="month-day ${active ? 'is-selected' : ''} ${eaten || planned ? 'has-record' : ''} ${date === today() ? 'is-today' : ''}" data-calendar-date="${date}" aria-controls="day-detail" aria-label="${date} ${description}"><span class="month-day-number">${i + 1}</span><span class="month-day-meta">${eaten ? `${eaten}餐已吃` : planned ? `${planned}餐计划` : ''}</span>${eaten && dayTotal(day).kcal != null ? `<span class="month-day-kcal">${fmt(dayTotal(day).kcal)}<small> kcal</small></span>` : ''}</button>`;
  }).join('');
}
function changeMonth(offset) {
  const date = dateObj(calendarMonth + '-01');
  date.setUTCMonth(date.getUTCMonth() + offset);
  const next = date.toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(next) || next < '0001-01' || next > '9999-12') return;
  calendarMonth = next; detailOpen = false; render();
  animateIn($('#calendar-grid'), { x: offset > 0 ? 8 : -8, y: 0 });
}
function showDayDetail() {
  $('#selected-date-title').setAttribute('tabindex', '-1');
  $('#selected-date-title').focus({ preventScroll: true });
  scrollToPageStart();
}
function returnFromRecord() {
  switchView('diary', { replace: true });
  if (detailOpen) showDayDetail(); else scrollToPageStart();
  $(detailOpen ? '#day-add-meal' : '#add-meal-button').focus({ preventScroll: true });
}
function exportDiary() {
  const payload = { ...canonical, updatedAt: new Date().toISOString(), days };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `食光-饮食日记-${today()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); toast('日记已导出，包含仓库记录与本机草稿。');
}
async function importDiary(event) {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('请导入 10MB 以内的日记文件。');
    const incoming = validateDiary(JSON.parse(await file.text()));
    commitDrafts(mergeDays(drafts, incoming.days), { recover: true }); await syncDrafts(); setDate(days.at(-1)?.date ?? today()); switchView('diary'); showDayDetail(); toast(`已合并 ${incoming.days.length} 天${remote.persistence === 'local' ? '到本机日记' : '到本机草稿'}，同 ID 餐食更新，其余保留。`);
  } catch (error) { toast(`导入未完成：${error.message}`); }
  event.target.value = '';
}
function wire() {
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => b.dataset.view === 'diary' ? returnToCalendar() : switchView(b.dataset.view)));
  $('#today-button').addEventListener('click', () => setDate(today()));
  $('#search-input').addEventListener('input', render);
  $('#day-search-toggle').addEventListener('click', () => {
    daySearchOpen = !daySearchOpen;
    if (!daySearchOpen) $('#search-input').value = '';
    render();
    $(daySearchOpen ? '#search-input' : '#day-search-toggle').focus({ preventScroll: true });
  });
  $('#add-meal-button').addEventListener('click', () => openRecord());
  $('#day-add-meal').addEventListener('click', () => openRecord());
  $('#day-ai-toggle').addEventListener('click', toggleDayAi);
  $('#diary-chat-date').addEventListener('change', event => {
    if (!dayChatDate || !validDate(event.target.value) || chatController.setDate(event.target.value) === false) return;
    dayChatDate = event.target.value;
    selected = dayChatDate; calendarMonth = selected.slice(0, 7); detailOpen = true;
    $('#diary-chat-title').textContent = `修改 ${dayChatDate} 的饮食`;
    render();
    history.replaceState({ view: 'diary' }, '', `#day/${selected}`);
  });
  $('#add-food-row').addEventListener('click', () => { addFoodRow(); formDirty = true; });
  $('#meal-form').addEventListener('input', () => { formDirty = true; });
  $('#meal-form').addEventListener('change', () => { formDirty = true; });
  $('#meal-form').addEventListener('submit', saveMeal);
  $('#cancel-meal').addEventListener('click', () => { formSession = false; formDirty = false; editing = null; returnFromRecord(); });
  $('#record-back').addEventListener('click', returnFromRecord);
  $('#record-view-day').addEventListener('click', () => { if (recordedDate) setDate(recordedDate); switchView('diary', { replace: true }); showDayDetail(); });
  document.querySelectorAll('[data-record-method]').forEach(button => {
    button.addEventListener('click', () => setRecordMethod(button.dataset.recordMethod));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const method = event.key === 'Home' ? 'natural' : event.key === 'End' ? 'form' : button.dataset.recordMethod === 'natural' ? 'form' : 'natural';
      setRecordMethod(method); $(`#record-method-${method}`).focus();
    });
  });
  $('#calendar-prev').addEventListener('click', () => changeMonth(-1));
  $('#calendar-next').addEventListener('click', () => changeMonth(1));
  $('#calendar-month').addEventListener('change', event => { if (event.target.validity.valid && /^\d{4}-\d{2}$/.test(event.target.value)) { calendarMonth = event.target.value; detailOpen = false; render(); animateIn($('#calendar-grid'), { x: 8, y: 0 }); } else event.target.value = calendarMonth; });
  $('#close-day-detail').addEventListener('click', () => returnToCalendar());
  window.addEventListener('popstate', restoreRoute);
  $('#meal-list').addEventListener('toggle', event => {
    const meal = event.target;
    if (!meal.matches('details.meal-disclosure') || !meal.isConnected) return;
    if (meal.open) {
      expandedMeals.set(selected, meal.dataset.mealId);
      $('#meal-list').querySelectorAll('details.meal-disclosure[open]').forEach(other => { if (other !== meal) other.open = false; });
    } else if (expandedMeals.get(selected) === meal.dataset.mealId) expandedMeals.delete(selected);
  }, true);
  $('#export-button').addEventListener('click', exportDiary);
  $('#export-raw-drafts').addEventListener('click', () => {
    if (rawDraftBackup === null) return;
    const url = URL.createObjectURL(new Blob([rawDraftBackup], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `食光-原始草稿-${today()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000); rawBackupExported = true;
    $('#draft-recovery-message').textContent = '原始草稿已导出。现在可以导入一份有效日记备份，恢复本机保存。';
  });
  $('#import-input').addEventListener('change', importDiary);
  document.addEventListener('click', async event => {
    const b = event.target.closest('button'); if (!b) return;
    if (b.dataset.date) setDate(b.dataset.date);
    if (b.dataset.historyDate) setDate(b.dataset.historyDate);
    if (b.dataset.calendarDate) setDate(b.dataset.calendarDate);
    if (b.hasAttribute('data-new-meal')) openRecord();
    if (b.dataset.edit) openMeal(selectedDay().meals.find(m => m.id === b.dataset.edit));
    if (b.dataset.confirm) {
      try {
      const day = selectedDay(), meal = day.meals.find(m => m.id === b.dataset.confirm);
      await saveDraft({ ...day, note: `${day.note} 补充：${MEALS[meal.type]}已在网站确认为吃过。`, meals: [{ ...meal, status: 'eaten', note: `${meal.note ?? ''}（后续已在网站确认吃过。）`, modifiedAt: new Date().toISOString() }] });
      toast('这餐已确认为吃过，已保存并加入当日统计。');
      } catch (error) { toast(error.message); }
    }
  });
}
async function init() {
  try {
    const responses = await Promise.all([fetch('./data/diary.json', { cache: 'no-cache' }), fetch('./data/foods.json', { cache: 'no-cache' })]);
    if (responses.some(r => !r.ok)) throw new Error('数据文件读取失败');
    canonical = validateDiary(await responses[0].json()); catalog = await responses[1].json();
    try {
      const response = await fetch(new URL('./api/diary', document.baseURI), { cache: 'no-store', credentials: 'same-origin' });
      if (response.ok) { const snapshot = await response.json(); canonical = validateDiary(snapshot.diary); remote = { ...remote, ...snapshot }; }
    } catch { /* Existing hosted diary keeps its browser-draft workflow when no durable API exists. */ }
    try {
      rawDraftBackup = localStorage.getItem(storageKey);
      if (rawDraftBackup) {
        const saved = validateDiary(JSON.parse(rawDraftBackup));
        if (saved.days.length && Number.isSafeInteger(saved.baseRevision) && remote.persistence !== 'unavailable' && saved.baseRevision !== remote.revision) throw new Error('草稿基于旧版本');
        validateDiary({ schemaVersion: 1, days: mergeDays(canonical.days, saved.days) });
        drafts = saved.days;
      }
      rawDraftBackup = null;
    } catch {
      draftReadError = true; $('#draft-recovery').hidden = false;
      $('#export-raw-drafts').hidden = rawDraftBackup === null;
      $('#draft-recovery-message').textContent = rawDraftBackup === null ? '浏览器暂时无法读取本机草稿，已暂停保存。请检查浏览器存储权限后刷新，或导入有效日记备份重试。' : '为保护原记录，已暂停保存。请先导出原始草稿，再导入一份有效日记备份恢复。';
    }
    days = mergeDays(canonical.days, drafts); selected = today();
    wire(); render();
    chatController = setupDiaryChat({ getState: () => ({ ...remote, draftDays: structuredClone(drafts), blocked: draftReadError }), applySnapshot: applyServerSnapshot,
      setBusy: setPersistentBusy, refresh: refreshServerDiary, syncDrafts, undo: async () => {
        const result = await storeRequest('diary/undo', { requestId: crypto.randomUUID(), expectedRevision: remote.revision, draftDays: [], recordDate: selected });
        await applyServerSnapshot(result); return result;
      } });
    quickController = setupQuickEntry({ apply: async incoming => {
      const token = applyQuickEntry(incoming); await syncDrafts(); return remote.persistence === 'unavailable' ? token : null;
    }, undo: undoQuickEntry, onBusy: busy => document.querySelectorAll('[data-record-method]').forEach(button => { button.disabled = busy; }) });
    prepareMealForm(); formSession = false; setRecordMethod('natural');
    restoreRoute();
    $('#load-status').hidden = true;
    const refreshLatest = createSnapshotRefresh({
      read: readServerDiary,
      getRevision: () => remote.revision,
      isSafe: () => remote.persistence === 'local' && document.visibilityState === 'visible'
        && !persistentBusy && !draftReadError && !drafts.length && view !== 'record' && !formDirty,
      apply: async result => {
        canonical = result.diary; remote = { ...remote, ...result }; days = structuredClone(canonical.days);
        render(); updateSyncNote();
      }
    });
    const checkLatest = () => refreshLatest().catch(() => {});
    window.addEventListener('focus', checkLatest);
    document.addEventListener('visibilitychange', checkLatest);
    setInterval(checkLatest, 15000);
  } catch (error) { $('#load-status').textContent = `日记暂时没有打开：${error.message}，请刷新重试。`; }
}
init();
