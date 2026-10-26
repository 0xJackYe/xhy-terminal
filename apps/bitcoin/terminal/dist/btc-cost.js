(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.BTCCost = api;
    const start = () => { if (!root.__btcCostController) root.__btcCostController = api.mount({root, document:root.document}); };
    if (root.document && root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start, {once:true});
    else start();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const REFRESH_MS = 30000, REQUEST_TIMEOUT_MS = 12000;
  function decimal(value) {
    if (typeof value !== 'string' || value.length > 180) return null;
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) return null;
    return {negative:match[1] === '-' && /[1-9]/.test(match[2] + (match[3] || '')), whole:match[2].replace(/^0+(?=\d)/,''), fraction:match[3] || ''};
  }
  function exact(value, digits = 16, fixed = false) {
    const data = decimal(value);
    if (!data || !Number.isInteger(digits) || digits < 0 || digits > 16) return '—';
    let scaled = BigInt(data.whole + data.fraction.slice(0,digits).padEnd(digits,'0'));
    if (data.fraction.length > digits && data.fraction[digits] >= '5') scaled += 1n;
    const text = scaled.toString().padStart(digits+1,'0');
    const whole = (digits ? text.slice(0,-digits) : text).replace(/\B(?=(\d{3})+(?!\d))/g,',');
    let fraction = digits ? text.slice(-digits) : '';
    if (!fixed) fraction = fraction.replace(/0+$/,'');
    return (data.negative && scaled !== 0n ? '−' : '') + whole + (fraction ? '.' + fraction : '');
  }
  function count(value) { return Number.isSafeInteger(value) && value >= 0 ? String(value) : '—'; }
  function timestamp(value) {
    const time = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(time) && time > 0 && time <= 8640000000000000 ? time : null;
  }
  function beijing(value, dateOnly = false) {
    const time = timestamp(value);
    if (time === null) return '—';
    const data = new Date(time + 28800000), pad = number => String(number).padStart(2,'0');
    return data.getUTCFullYear()+'-'+pad(data.getUTCMonth()+1)+'-'+pad(data.getUTCDate())+(dateOnly ? '' : ' '+pad(data.getUTCHours())+':'+pad(data.getUTCMinutes())+':'+pad(data.getUTCSeconds()));
  }
  function todayDate(now) { return beijing(new Date(now).toISOString(),true); }
  function currentToday(data, now) { return data && data.today && data.today.date_beijing === todayDate(now) ? data.today : null; }
  function progress(spent, plan) {
    const amount = decimal(spent), target = decimal(plan);
    if (!amount || !target || amount.negative || target.negative) return null;
    const scale = Math.max(amount.fraction.length,target.fraction.length);
    const integer = data => BigInt(data.whole + data.fraction.padEnd(scale,'0'));
    const denominator = integer(target);
    if (denominator === 0n) return null;
    const percent = integer(amount)*10000n/denominator;
    return Number(percent > 10000n ? 10000n : percent)/100;
  }
  function valid(data) {
    return data && typeof data === 'object' && !Array.isArray(data) && ['loading','fresh','stale','unavailable'].includes(data.status) &&
      (data.connection_id === null || typeof data.connection_id === 'string' && data.connection_id.length <= 128) &&
      (data.summary === null || data.summary && typeof data.summary === 'object' && !Array.isArray(data.summary) && Array.isArray(data.summary.by_currency)) &&
      (data.today === null || data.today && typeof data.today === 'object' && !Array.isArray(data.today)) && Array.isArray(data.recent_trades);
  }
  const MARKUP = '<div class="btc-cost-heading"><div><h2 id="btcCostTitle">BTC 定投与成本</h2><span id="btcCostState" class="btc-cost-state" role="status" aria-live="polite">正在读取</span></div><button id="btcCostRefresh" class="secondary-button" type="button">刷新</button></div>'+
    '<div class="btc-cost-overview"><div class="btc-cost-total"><span>累计净投入 · USDT</span><strong id="btcCostNetUSDT">—</strong><small>USDT 实际支出减卖出回款</small></div><div class="btc-cost-quantity"><span>现货净买入 · BTC</span><strong id="btcCostNetBTC">—</strong><small id="btcCostCounts">—</small></div><div class="btc-cost-daily"><div class="btc-cost-daily-head"><span>今日 BTC 买入</span><small id="btcCostDailyDate"></small></div><strong><span id="btcCostTodaySpent">—</span><small> USDT · 每日计划 <span id="btcCostDailyPlan">20.00</span></small></strong><div class="btc-cost-track" id="btcCostProgress" role="progressbar" aria-label="今日实际买入占每日计划" aria-valuemin="0" aria-valuemax="100"><i id="btcCostProgressFill"></i></div><small id="btcCostDailyDetail">等待今日成交</small></div></div>'+
    '<p id="btcCostMessage" class="btc-cost-message" role="status" hidden></p><div class="btc-cost-footer"><time id="btcCostUpdated">等待首次同步</time></div>';
  function mount(options = {}) {
    const root = options.root || globalThis, document = options.document || root.document, panel = document && document.getElementById('btcCostPanel');
    if (!panel) return null;
    if (panel.__btcCostController) return panel.__btcCostController;
    const fetcher = options.fetch || root.fetch.bind(root), setTimer = options.setTimeout || root.setTimeout.bind(root), clearTimer = options.clearTimeout || root.clearTimeout.bind(root), now = options.now || Date.now;
    const node = id => document.getElementById(id);
    panel.classList.add('btc-cost','card');panel.setAttribute('aria-labelledby','btcCostTitle');panel.innerHTML = MARKUP;
    let state = null, read = null, timer = null, disposed = false, pageActive = true, failed = false, sequence = 0;
    function active() { const page = node('walletPage'); return !disposed && pageActive && !document.hidden && (!page || !page.hidden); }
    function cancelTimer() { if (timer !== null) clearTimer(timer); timer = null; }
    function schedule() { cancelTimer();if (active()) timer = setTimer(() => { timer = null;load(); },REFRESH_MS); }
    function render() {
      const summary = state && state.summary, today = currentToday(state,now());
      const hasData = !!summary, age = state && timestamp(state.last_success_at);
      const stale = failed || hasData && (state.status !== 'fresh' || age === null || now()-age > 90000 || age-now() > 60000);
      const status = failed ? hasData ? '待同步 · 保留记录' : '暂时无法连接' : state && state.status === 'loading' ? '正在补齐记录' : hasData ? stale ? '待同步 · 保留记录' : '已同步 · 只读' : '等待成本记录';
      node('btcCostState').textContent = status;node('btcCostState').className = 'btc-cost-state '+(hasData ? stale ? 'stale' : 'fresh' : 'unavailable');
      const usdt = summary && summary.by_currency.find(row => row && row.currency === 'USDT');
      node('btcCostNetUSDT').textContent = exact(usdt && usdt.net_invested,2,true);
      node('btcCostNetBTC').textContent = exact(summary && summary.net_bought_btc);
      node('btcCostCounts').textContent = summary ? '买入 '+count(summary.buy_count)+' 条成交 · 卖出 '+count(summary.sell_count)+' 条成交' : '—';
      node('btcCostDailyDate').textContent = todayDate(now());
      node('btcCostDailyPlan').textContent = exact(state && state.plan_daily_usdt || '20',2,true);
      node('btcCostTodaySpent').textContent = exact(today && today.buy_spent_usdt,2,true);
      const remaining = today && decimal(today.remaining_plan_usdt), ratio = progress(today && today.buy_spent_usdt,state && state.plan_daily_usdt || '20');
      node('btcCostDailyDetail').textContent = today ? count(today.buy_count)+' 笔'+(remaining ? ' · '+(remaining.negative ? '超出计划 '+exact(today.remaining_plan_usdt,2,true).replace(/^−/,'') : '距计划 '+exact(today.remaining_plan_usdt,2,true))+' USDT' : '') : '等待今日成交同步';
      node('btcCostProgressFill').style.width = (ratio === null ? 0 : ratio)+'%';
      if (ratio === null) node('btcCostProgress').removeAttribute('aria-valuenow');else node('btcCostProgress').setAttribute('aria-valuenow',String(ratio));
      const message = failed ? hasData ? '同步暂未完成，保留上次记录。' : '暂时无法连接，稍后自动重试。' : state && state.coverage_complete === false ? '历史记录补齐中。' : stale ? '保留最近一次成功同步的数据。' : '';
      node('btcCostMessage').textContent = message;node('btcCostMessage').hidden = !message;
      node('btcCostUpdated').textContent = age === null || !state ? '等待首次同步' : '最近同步 '+beijing(state.last_success_at)+' · 北京时间';
      node('btcCostRefresh').disabled = !!read;
    }
    function cancelRead() {
      if (!read) return;
      const token = read;read = null;sequence++;token.cancelled = true;clearTimer(token.timeout);token.controller.abort();token.cancel();
      if (!disposed) node('btcCostRefresh').disabled = false;
    }
    async function load() {
      if (!active() || read) return;
      cancelTimer();
      const token = {controller:new root.AbortController(),sequence:++sequence,cancelled:false};read = token;node('btcCostRefresh').disabled = true;
      const interrupted = new Promise((_,reject) => { token.cancel = () => reject(new Error('cancelled')); });
      token.timeout = setTimer(() => { token.controller.abort();token.cancel(); },REQUEST_TIMEOUT_MS);
      try {
        const request = (async () => { const response = await fetcher('/api/wallet/btc-cost',{method:'GET',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal:token.controller.signal});if (!response.ok) throw new Error('unavailable');const data = await response.json();if (!valid(data)) throw new Error('invalid');return data; })();
        const data = await Promise.race([request,interrupted]);
        if (disposed || token.sequence !== sequence || token.cancelled) return;
        const oldTime = state && timestamp(state.last_success_at), nextTime = timestamp(data.last_success_at);
        const sameConnection = state && state.connection_id === data.connection_id;
        if (sameConnection && state.summary && (!data.summary || oldTime !== null && (nextTime === null || nextTime < oldTime))) { failed = true;render();return; }
        state = data;failed = false;render();
      } catch (_) { if (!disposed && token.sequence === sequence && !token.cancelled) { failed = true;render(); } }
      finally { clearTimer(token.timeout);if (read === token) { read = null;if (!disposed) node('btcCostRefresh').disabled = false;schedule(); } }
    }
    function visibility() { if (active()) load();else { cancelTimer();cancelRead(); } }
    function pageHide() { pageActive = false;visibility(); }
    function pageShow() { pageActive = true;visibility(); }
    const events = [[node('btcCostRefresh'),'click',load],[document,'visibilitychange',visibility],[root,'hashchange',visibility],[root,'pagehide',pageHide],[root,'pageshow',pageShow]];
    for (const [target,event,handler] of events) target.addEventListener(event,handler);
    function destroy() { disposed = true;cancelTimer();cancelRead();for (const [target,event,handler] of events) target.removeEventListener(event,handler);panel.__btcCostController = null; }
    const controller = {refresh:load,destroy};panel.__btcCostController = controller;render();if (active()) load();return controller;
  }
  return {REFRESH_MS,REQUEST_TIMEOUT_MS,decimal,exact,count,timestamp,beijing,todayDate,currentToday,progress,valid,mount};
});
