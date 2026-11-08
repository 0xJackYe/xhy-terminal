(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.DCADiary = api;
    const start = () => { if (!root.__dcaDiaryController) root.__dcaDiaryController = api.mount({root, document:root.document}); };
    if (root.document && root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start, {once:true});
    else start();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  // 定投日记: one square per Beijing day since the first purchase on
  // 2024-12-14, like a GitHub contribution graph. The more BTC bought that
  // day, the closer the square is to bitcoin orange.
  const START = '2024-12-14', DAY = 86400000, REFRESH_MS = 300000, REQUEST_TIMEOUT_MS = 15000;
  const WEEKDAYS = ['周一','周二','周三','周四','周五','周六','周日'];
  const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

  // Calendar days are UTC midnights, so no time zone or daylight saving can
  // move a day; "today" is the Beijing date.
  function parseDate(value) {
    const match = DATE.exec(typeof value === 'string' ? value : '');
    if (!match) return null;
    const time = Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])), date = new Date(time);
    return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2])-1 && date.getUTCDate() === Number(match[3]) ? time : null;
  }
  function formatDate(time) { return new Date(time).toISOString().slice(0,10); }
  function beijingToday(now) { return Math.floor((now+28800000)/DAY)*DAY; }
  function weekday(time) { return (new Date(time).getUTCDay()+6)%7; }
  function monday(time) { return time-weekday(time)*DAY; }
  function longDate(time) { const date = new Date(time);return date.getUTCFullYear()+'年'+(date.getUTCMonth()+1)+'月'+date.getUTCDate()+'日 '+WEEKDAYS[weekday(time)]; }

  // Amounts stay exact as integers: satoshis for BTC, cents for USDT.
  function units(value, digits) {
    if (typeof value !== 'string' || !new RegExp('^\\d{1,7}(?:\\.\\d{1,'+digits+'})?$').test(value)) return null;
    const [whole, fraction = ''] = value.split('.');
    return Number(whole)*10**digits+Number(fraction.padEnd(digits,'0'));
  }
  const grouped = number => number.toString().replace(/\B(?=(\d{3})+(?!\d))/g,',');
  function btcText(satoshis) {
    if (!Number.isSafeInteger(satoshis) || satoshis < 0) return '—';
    const fraction = String(satoshis%1e8).padStart(8,'0').replace(/0+$/,'');
    return grouped(Math.floor(satoshis/1e8))+(fraction ? '.'+fraction : '');
  }
  function usdtText(cents) { return Number.isSafeInteger(cents) && cents >= 0 ? grouped(Math.floor(cents/100))+'.'+String(cents%100).padStart(2,'0') : '—'; }

  // The server's view, checked field by field; anything malformed is dropped
  // rather than drawn.
  function normalize(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !['fresh','stale','unavailable','loading'].includes(data.status)) return null;
    const fields = Array.isArray(data.fields) && data.fields.length <= 12 ? data.fields : ['date','btc','usdt','buys'];
    const at = name => fields.indexOf(name), date = at('date'), btc = at('btc'), usdt = at('usdt'), buys = at('buys');
    if (date < 0 || btc < 0 || !Array.isArray(data.days)) return null;
    const days = new Map();
    for (const row of data.days.slice(0,20000)) {
      if (!Array.isArray(row)) continue;
      const time = parseDate(row[date]), amount = units(row[btc],8);
      if (time === null || amount === null || amount <= 0) continue;
      const cost = usdt >= 0 ? units(row[usdt],2) : null, count = buys >= 0 && Number.isSafeInteger(row[buys]) && row[buys] > 0 ? row[buys] : null;
      const old = days.get(time);
      days.set(time,old ? {btc:old.btc+amount,usdt:old.usdt === null || cost === null ? null : old.usdt+cost,buys:old.buys === null || count === null ? null : old.buys+count} : {btc:amount,usdt:cost,buys:count});
    }
    const first = days.size ? Math.min(...days.keys()) : null, fixed = parseDate(START);
    const start = parseDate(data.start_date) ?? (first !== null && first < fixed ? first : fixed);
    return {status:data.status,days,first,start:first !== null ? Math.min(start,first) : start,coverage:parseDate(data.coverage_start_date),today:parseDate(data.today),
      venues:Array.isArray(data.venues) ? data.venues.filter(item => item === 'okx' || item === 'binance') : [],
      error:typeof data.error === 'string' && data.error ? data.error.slice(0,200) : null,asOf:typeof data.as_of === 'string' ? data.as_of : null};
  }

  // Four orange levels from the quartiles of every buying day since the
  // start, so a day keeps its colour whichever range is shown. Equal amounts
  // round up: a steady daily buy shows as full orange, not as the palest.
  function thresholds(days) {
    const values = [...days.values()].map(day => day.btc).sort((a,b) => a-b);
    if (!values.length) return null;
    const quantile = share => values[Math.floor(share*(values.length-1))];
    return [quantile(.25),quantile(.5),quantile(.75)];
  }
  function level(amount, limits) {
    if (!amount || amount <= 0) return 0;
    if (!limits) return 4;
    return amount >= limits[2] ? 4 : amount >= limits[1] ? 3 : amount >= limits[0] ? 2 : 1;
  }

  // 近一年 (the 53 weeks ending this week) or one calendar year.
  function ranges(model) {
    const today = model.today, first = new Date(model.start).getUTCFullYear(), last = new Date(today).getUTCFullYear(), list = ['recent'];
    for (let year = last;year >= first && list.length < 30;year--) list.push(String(year));
    return list;
  }
  function bounds(range, model) {
    const today = model.today;
    if (range === 'recent') { const end = monday(today)+6*DAY;return {label:'近一年',from:end-53*7*DAY+DAY,to:today,gridStart:end-53*7*DAY+DAY,gridEnd:end}; }
    const year = Number(range), from = Date.UTC(year,0,1), last = Date.UTC(year,11,31);
    return {label:year+' 年',from,to:Math.min(last,today),gridStart:monday(from),gridEnd:monday(last)+6*DAY};
  }

  // Buying days, BTC, USDT and the longest run of consecutive buying days in
  // [from, to]; days before the start or the ledger's coverage never count.
  function stats(model, from, to) {
    let days = 0, btc = 0, usdt = 0, priced = true, buys = 0, run = 0, longest = 0;
    const begin = Math.max(from,model.start,model.coverage ?? model.start);
    for (let time = begin;time <= to;time += DAY) {
      const day = model.days.get(time);
      if (!day) { run = 0;continue; }
      days++;btc += day.btc;buys += day.buys || 0;run++;longest = Math.max(longest,run);
      if (day.usdt === null) priced = false;else usdt += day.usdt;
    }
    let current = 0;
    if (to === model.today) {
      // A streak survives until the end of a day without a buy yet.
      for (let time = model.days.has(to) ? to : to-DAY;time >= begin && model.days.has(time);time -= DAY) current++;
    }
    return {days,btc,usdt:priced ? usdt : null,buys,longest,current};
  }

  function cellState(time, view, model) {
    if (time < view.from || time > view.to) return 'outside';
    if (time < model.start) return 'before';
    if (model.coverage !== null && time < model.coverage) return 'gap';
    return 'day';
  }
  function describe(time, model) {
    const day = model.days.get(time);
    if (time < model.start) return {title:longDate(time),detail:'首笔买入（'+formatDate(model.start)+'）之前'};
    if (model.coverage !== null && time < model.coverage) return {title:longDate(time),detail:'成本账本未覆盖这一天'};
    if (!day) return {title:longDate(time),detail:time === model.today ? '今天还没有买入' : '没有买入'};
    const parts = ['买入 '+btcText(day.btc)+' BTC'];
    if (day.usdt !== null) parts.push('约 '+usdtText(day.usdt)+' USDT');
    if (day.buys !== null) parts.push(day.buys+' 笔');
    return {title:longDate(time)+(time === model.first ? ' · 首笔买入' : ''),detail:parts.join(' · ')};
  }

  // The grid as one HTML string: weekday labels, month labels, then a square
  // per day placed by week column and weekday row.
  function gridHtml(view, model, limits) {
    const weeks = Math.round((view.gridEnd-view.gridStart+DAY)/(7*DAY));
    let html = '';
    // Every row gets a label cell so the pinned label column stays solid while
    // the weeks scroll beneath it; Monday, Wednesday and Friday are named.
    for (let row = 0;row < 7;row++) html += '<span class="dca-weekday" style="grid-row:'+(row+2)+'" aria-hidden="true">'+(row % 2 || row > 4 ? '' : WEEKDAYS[row].slice(1))+'</span>';
    let lastLabel = -9;
    for (let column = 0;column < weeks;column++) {
      const start = view.gridStart+column*7*DAY, shown = new Date(Math.max(start,view.from));
      // A month is labelled above the first week that starts in it (the first
      // column too, if enough of its month is left), never crowding the last
      // label or running past the grid's right edge.
      const opens = column === 0 ? shown.getUTCDate() <= 21 : shown.getUTCMonth() !== new Date(Math.max(start-7*DAY,view.from)).getUTCMonth();
      if (opens && column-lastLabel >= 3 && column <= weeks-2) { html += '<span class="dca-month" style="grid-column:'+(column+2)+'" aria-hidden="true">'+(shown.getUTCMonth()+1)+'月</span>';lastLabel = column; }
      for (let offset = 0;offset < 7;offset++) {
        const time = start+offset*DAY, state = cellState(time,view,model), position = 'grid-column:'+(column+2)+';grid-row:'+(offset+2);
        if (state === 'outside') { html += '<i class="dca-cell is-outside" style="'+position+'"></i>';continue; }
        const day = model.days.get(time), value = state === 'day' ? level(day && day.btc,limits) : 0;
        html += '<i class="dca-cell'+(state === 'day' ? '' : ' is-'+state)+(time === model.today ? ' is-today' : '')+'" data-level="'+value+'" data-date="'+formatDate(time)+'" style="'+position+'"></i>';
      }
    }
    return {html,weeks};
  }

  const MARKUP = '<div class="dca-diary-heading"><div><h2 id="dcaDiaryTitle">定投日记</h2><small id="dcaDiarySince" class="dca-diary-since"></small></div><div id="dcaDiaryRange" class="dca-diary-range" role="group" aria-label="定投日记范围"></div></div>'+
    '<div class="dca-diary-meta"><p id="dcaDiarySummary" class="dca-diary-summary" title="按北京时间计日"></p><span class="dca-diary-legend" title="越接近比特币橙，当天买入的 BTC 越多" aria-hidden="true">少<i data-level="0"></i><i data-level="1"></i><i data-level="2"></i><i data-level="3"></i><i data-level="4"></i>多</span></div>'+
    '<div id="dcaDiaryScroll" class="dca-diary-scroll"><div id="dcaDiaryGrid" class="dca-diary-grid" role="img" tabindex="0"></div></div>'+
    '<p id="dcaDiaryMessage" class="dca-diary-message" role="status" hidden></p>'+
    '<div id="dcaDiaryTip" class="dca-diary-tip" role="tooltip" hidden><strong></strong><span></span></div><span id="dcaDiaryLive" class="dca-diary-live" aria-live="polite"></span>';

  function mount(options = {}) {
    const root = options.root || globalThis, document = options.document || root.document, panel = document && document.getElementById('dcaDiaryPanel');
    if (!panel) return null;
    if (panel.__dcaDiaryController) return panel.__dcaDiaryController;
    const fetcher = options.fetch || root.fetch.bind(root), setTimer = options.setTimeout || root.setTimeout.bind(root), clearTimer = options.clearTimeout || root.clearTimeout.bind(root), now = options.now || Date.now;
    const node = id => document.getElementById(id);
    panel.classList.add('dca-diary','card');panel.setAttribute('aria-labelledby','dcaDiaryTitle');panel.innerHTML = MARKUP;
    let model = null, range = 'recent', view = null, timer = null, read = null, disposed = false, pageActive = true, failed = false, focused = null, sequence = 0, drawn = '';
    const grid = node('dcaDiaryGrid'), tip = node('dcaDiaryTip'), scroller = node('dcaDiaryScroll');
    function active() { const page = node('walletPage');return !disposed && pageActive && !document.hidden && (!page || !page.hidden); }
    function cancelTimer() { if (timer !== null) clearTimer(timer);timer = null; }
    function schedule() { cancelTimer();if (active()) timer = setTimer(() => { timer = null;load(); },REFRESH_MS); }
    function current() {
      // Without the server's date (or before it loads) today is the Beijing date here.
      const base = model || normalize({status:'loading',days:[],start_date:START});
      if (base.today === null) base.today = beijingToday(now());
      return base;
    }
    function render() {
      const data = current(), choices = ranges(data);
      if (!choices.includes(range)) range = 'recent';
      const buttons = choices.map(value => '<button type="button" data-range="'+value+'" aria-pressed="'+(value === range)+'">'+(value === 'recent' ? '近一年' : value)+'</button>').join('');
      const rangeNode = node('dcaDiaryRange');
      if (rangeNode.innerHTML !== buttons) rangeNode.innerHTML = buttons;
      view = bounds(range,data);
      const limits = thresholds(data.days), signature = [range,data.today,data.start,data.coverage,limits && limits.join(','),[...data.days].map(([time,day]) => time+':'+day.btc).join(';')].join('|');
      if (signature !== drawn) {
        const built = gridHtml(view,data,limits);
        grid.style.setProperty('--weeks',String(built.weeks));grid.innerHTML = built.html;drawn = signature;focused = null;hideTip();
        // The latest weeks are the ones to see first when the grid scrolls.
        if (view.to === data.today && scroller.scrollWidth > scroller.clientWidth) scroller.scrollLeft = scroller.scrollWidth;
      }
      const all = stats(data,data.start,data.today), part = stats(data,view.from,view.to);
      node('dcaDiarySince').textContent = '自 '+formatDate(data.start)+' 起'+(data.first === null ? '' : ' · '+all.days+' 天 · '+btcText(all.btc)+' BTC');
      node('dcaDiarySince').title = node('dcaDiarySince').textContent+(data.first === null ? '' : '\n首笔买入 '+formatDate(data.first)+'；累计买入 '+all.buys+' 笔'+(all.usdt !== null ? '，约 '+usdtText(all.usdt)+' USDT' : ''));
      // One short line: days, BTC and streaks; the USDT spent is in its tooltip.
      const known = data.days.size || data.status === 'fresh' || data.status === 'stale';
      const summary = known
        ? view.label+'买入 '+part.days+' 天 · '+btcText(part.btc)+' BTC · 最长连续 '+part.longest+' 天'+(part.current > 1 ? ' · 当前连续 '+part.current+' 天' : '')
        : data.status === 'loading' ? '正在读取定投记录' : '等待成本账本';
      node('dcaDiarySummary').textContent = summary;
      node('dcaDiarySummary').title = known ? summary+(part.usdt !== null && part.days ? '\n约 '+usdtText(part.usdt)+' USDT' : '')+'\n按北京时间计日' : summary;
      grid.setAttribute('aria-label','定投日记 '+summary+'。用方向键逐日查看。');
      const message = failed ? data.days.size ? '同步暂未完成，保留上次的定投记录。' : '暂时无法读取定投记录，稍后自动重试。'
        : data.status === 'unavailable' ? (data.error || '导入已核对的成本账本后显示每天的定投。')
        : data.coverage !== null && data.coverage > data.start ? '成本账本自 '+formatDate(data.coverage)+' 起，之前的日期未计入。' : '';
      node('dcaDiaryMessage').textContent = message;node('dcaDiaryMessage').hidden = !message;
    }
    function cellFor(time) { return grid.querySelector('[data-date="'+formatDate(time)+'"]'); }
    function hideTip() { tip.hidden = true;const old = grid.querySelector('.is-focused');if (old) old.classList.remove('is-focused'); }
    function showTip(cell) {
      const time = parseDate(cell && cell.dataset.date);
      if (time === null) { hideTip();return; }
      const text = describe(time,current());
      tip.firstChild.textContent = text.title;tip.lastChild.textContent = text.detail;tip.hidden = false;
      // Centred above the square, kept inside the panel.
      // Screen positions are scaled when the page is drawn smaller; the tip is
      // placed in the panel's own units.
      const box = panel.getBoundingClientRect(), rect = cell.getBoundingClientRect(), scale = box.width / (panel.offsetWidth || box.width) || 1;
      const width = tip.offsetWidth, height = tip.offsetHeight, x = (rect.left+rect.width/2-box.left)/scale, above = (rect.top-box.top)/scale-height-6;
      tip.style.left = Math.min(Math.max(x-width/2,4),box.width/scale-width-4)+'px';tip.style.top = (above < 0 ? (rect.bottom-box.top)/scale+6 : above)+'px';
      return text;
    }
    function focusDay(time) {
      time = Math.min(Math.max(time,view.from),view.to);
      const cell = cellFor(time);
      if (!cell) return;
      hideTip();focused = time;cell.classList.add('is-focused');
      const text = showTip(cell);node('dcaDiaryLive').textContent = text ? text.title+'，'+text.detail : '';
      const scrollRect = scroller.getBoundingClientRect(), cellRect = cell.getBoundingClientRect();
      if (cellRect.left < scrollRect.left || cellRect.right > scrollRect.right) scroller.scrollLeft += cellRect.left-scrollRect.left-scrollRect.width/2;
    }
    function keydown(event) {
      const moves = {ArrowLeft:-7,ArrowRight:7,ArrowUp:-1,ArrowDown:1};
      if (event.key === 'Escape') { hideTip();focused = null;return; }
      if (event.key === 'Home' || event.key === 'End') { event.preventDefault();focusDay(event.key === 'Home' ? view.from : view.to);return; }
      if (!(event.key in moves)) return;
      event.preventDefault();focusDay(focused === null ? view.to : focused+moves[event.key]*DAY);
    }
    function pointer(event) { const cell = event.target.closest && event.target.closest('.dca-cell[data-date]');if (cell && grid.contains(cell)) { hideTip();cell.classList.add('is-focused');showTip(cell); } }
    // A finger lifting "leaves" the square; the tip stays until a tap elsewhere.
    function leave(event) { if (event.pointerType === 'touch' || event.pointerType === 'pen') return;if (document.activeElement !== grid || focused === null) hideTip(); }
    function outside(event) { const cell = event.target.closest && event.target.closest('.dca-cell[data-date]');if (!cell || !grid.contains(cell)) hideTip(); }
    function choose(event) {
      const button = event.target.closest && event.target.closest('button[data-range]');
      if (!button || button.dataset.range === range) return;
      range = button.dataset.range;render();
    }
    function cancelRead() {
      if (!read) return;
      const token = read;read = null;sequence++;token.cancelled = true;clearTimer(token.timeout);token.controller.abort();token.cancel();
    }
    async function load() {
      if (!active() || read) return;
      cancelTimer();
      const token = {controller:new root.AbortController(),sequence:++sequence,cancelled:false};read = token;
      const interrupted = new Promise((_,reject) => { token.cancel = () => reject(new Error('cancelled')); });
      token.timeout = setTimer(() => { token.controller.abort();token.cancel(); },REQUEST_TIMEOUT_MS);
      try {
        const request = (async () => { const response = await fetcher('/api/wallet/btc-dca-diary',{method:'GET',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal:token.controller.signal});if (!response.ok) throw new Error('unavailable');const data = normalize(await response.json());if (!data) throw new Error('invalid');return data; })();
        const data = await Promise.race([request,interrupted]);
        if (disposed || token.sequence !== sequence || token.cancelled) return;
        // A failed refresh keeps the last diary instead of blanking it.
        if (model && model.days.size && !data.days.size && data.status !== 'fresh') { failed = true;render();return; }
        model = data;failed = false;render();
      } catch (_) { if (!disposed && token.sequence === sequence && !token.cancelled) { failed = true;render(); } }
      finally { clearTimer(token.timeout);if (read === token) { read = null;schedule(); } }
    }
    function visibility() { if (active()) load();else { cancelTimer();cancelRead();hideTip(); } }
    function pageHide() { pageActive = false;visibility(); }
    function pageShow() { pageActive = true;visibility(); }
    const events = [[node('dcaDiaryRange'),'click',choose],[grid,'pointerover',pointer],[grid,'pointerleave',leave],[grid,'keydown',keydown],[grid,'blur',() => { hideTip();focused = null; }],
      [document,'pointerdown',outside],[document,'visibilitychange',visibility],[root,'hashchange',visibility],[root,'pagehide',pageHide],[root,'pageshow',pageShow]];
    for (const [target,event,handler] of events) target.addEventListener(event,handler);
    function destroy() { disposed = true;cancelTimer();cancelRead();for (const [target,event,handler] of events) target.removeEventListener(event,handler);panel.__dcaDiaryController = null; }
    const controller = {refresh:load,destroy,select:value => { range = String(value);render(); }};
    panel.__dcaDiaryController = controller;render();if (active()) load();return controller;
  }
  return {START,REFRESH_MS,parseDate,formatDate,beijingToday,weekday,monday,units,btcText,usdtText,normalize,thresholds,level,ranges,bounds,stats,cellState,describe,gridHtml,mount};
});
