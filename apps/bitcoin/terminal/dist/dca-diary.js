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
  // 2024-12-14, like a GitHub contribution graph. The more that went in that
  // day, the deeper its orange; its heading opens the daily candlestick chart.
  const START = '2024-12-14', DAY = 86400000, REFRESH_MS = 30000, REQUEST_TIMEOUT_MS = 15000;
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

  // Summaries arrive before rounding individual calendar days. Keep their
  // decimals as strings and round once for display, without Number conversion.
  function decimalAmount(value) { return typeof value === 'string' && value.length <= 512 && /^\d+(?:\.\d+)?$/.test(value); }
  function exactText(value, digits, fixed = false) {
    if (!decimalAmount(value) || !Number.isInteger(digits) || digits < 0 || digits > 8) return '—';
    const [whole,fraction = ''] = value.split('.');
    let amount = BigInt(whole+fraction.slice(0,digits).padEnd(digits,'0'));
    if (fraction.length > digits && fraction[digits] >= '5') amount++;
    const text = amount.toString().padStart(digits+1,'0');
    let tail = digits ? text.slice(-digits) : '';
    if (!fixed) tail = tail.replace(/0+$/,'');
    return grouped(digits ? text.slice(0,-digits) : text)+(tail ? '.'+tail : '');
  }
  function exactSummary(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !decimalAmount(value.btc) ||
        !(value.usdt === null || decimalAmount(value.usdt)) || !(value.average_buy_price === null || decimalAmount(value.average_buy_price)) ||
        !Number.isSafeInteger(value.buys) || value.buys < 0 || !Number.isSafeInteger(value.days) || value.days < 0) return null;
    return {btc:value.btc,usdt:value.usdt,average_buy_price:value.usdt === null ? null : value.average_buy_price,buys:value.buys,days:value.days};
  }
  function priceDistribution(value) {
    if(!value||value.bucket_usdt!=='5000'||!decimalAmount(value.priced_btc)||!decimalAmount(value.unpriced_btc)||!Array.isArray(value.bins)||value.bins.length>20000)return null;
    const bins=[];let previous=-1;
    for(const row of value.bins){
      if(!row||typeof row.from!=='string'||typeof row.to!=='string'||!/^\d{1,12}$/.test(row.from)||!/^\d{1,12}$/.test(row.to)||!decimalAmount(row.btc)||!/[1-9]/.test(row.btc))return null;
      const from=Number(row.from),to=Number(row.to);
      if(from<=previous||from%5000!==0||to-from!==5000)return null;
      bins.push({from:row.from,to:row.to,btc:row.btc});previous=from;
    }
    return {bucket_usdt:'5000',priced_btc:value.priced_btc,unpriced_btc:value.unpriced_btc,bins};
  }

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
    // Exact per-day fills feed B-marker tooltips; the heatmap keeps its existing units.
    if (data.exact_days && typeof data.exact_days === 'object' && !Array.isArray(data.exact_days)) {
      for (const [date,exact] of Object.entries(data.exact_days)) {
        const day = days.get(parseDate(date));if (!day || !exact || typeof exact !== 'object') continue;
        if (decimalAmount(exact.btc)) day.exactBTC = exact.btc;
        if (exact.usdt === null || decimalAmount(exact.usdt)) day.exactUSDT = exact.usdt;
      }
    }
    const first = days.size ? Math.min(...days.keys()) : null, fixed = parseDate(START);
    const start = parseDate(data.start_date) ?? (first !== null && first < fixed ? first : fixed);
    const periods = {};
    if (data.exact_periods && typeof data.exact_periods === 'object' && !Array.isArray(data.exact_periods)) {
      for (const [year,value] of Object.entries(data.exact_periods)) if (/^\d{4}$/.test(year)) {
        const summary = exactSummary(value);if (summary) periods[year] = summary;
      }
    }
    return {status:data.status,connectionId:typeof data.connection_id === 'string' ? data.connection_id : null,days,first,start:first !== null ? Math.min(start,first) : start,coverage:parseDate(data.coverage_start_date),today:parseDate(data.today),
      exactTotals:exactSummary(data.exact_totals),exactPeriods:periods,buyPriceDistribution:priceDistribution(data.buy_price_distribution),
      venues:Array.isArray(data.venues) ? data.venues.filter(item => item === 'okx' || item === 'binance') : [],
      error:typeof data.error === 'string' && data.error ? data.error.slice(0,200) : null,asOf:typeof data.as_of === 'string' ? data.as_of : null};
  }

  // Six orange levels for what went in that day, in USDT, measured against
  // the usual daily buy (the median buying day): under half of it is the
  // palest, the usual buy sits in the middle (level 3), and bigger days keep
  // getting deeper up to six times the usual and beyond. Every buying day
  // since the start sets the scale, so a day keeps its colour whichever range
  // is shown. A day bought without a USDT price is valued at the median price
  // of the priced days; with no priced day at all, BTC amounts are compared.
  const STEPS = [.5,.9,1.5,3,6];
  function scale(days) {
    const list = [...days.values()].filter(day => day.btc > 0);
    if (!list.length) return null;
    const median = values => values.sort((a,b) => a-b)[Math.floor((values.length-1)/2)];
    const prices = list.filter(day => day.usdt !== null && day.usdt > 0).map(day => day.usdt/day.btc);
    const price = prices.length ? median(prices) : null;
    let unit = 'usdt', value = day => day.usdt !== null ? day.usdt : Math.round(day.btc*price), usual = price === null ? 0 : median(list.map(value));
    if (!(usual > 0)) { unit = 'btc';value = day => day.btc;usual = median(list.map(value)); }
    return {unit,usual,value,limits:STEPS.map(step => usual*step)};
  }
  function level(day, measure) {
    if (!day || !(day.btc > 0)) return 0;
    if (!measure) return 3;
    const amount = measure.value(day);
    return 1+measure.limits.filter(limit => amount >= limit).length;
  }
  // The legend's hover text gives the bounds in whole USDT.
  function legendText(measure) {
    if (!measure) return '颜色越深，当天投入越多';
    if (measure.unit === 'btc') return '颜色越深，当天买入的 BTC 越多；通常一天的买入量为中间色';
    const cut = measure.limits.map(limit => grouped(Math.round(limit/100)));
    return '颜色越深，当天投入越多（USDT）：'+cut[0]+' 以下 · '+cut[0]+'–'+cut[1]+' · '+cut[1]+'–'+cut[2]+' · '+cut[2]+'–'+cut[3]+' · '+cut[3]+'–'+cut[4]+' · '+cut[4]+' 以上';
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
  function gridHtml(view, model, measure) {
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
        const day = model.days.get(time), value = state === 'day' ? level(day,measure) : 0;
        html += '<i class="dca-cell'+(state === 'day' ? '' : ' is-'+state)+(time === model.today ? ' is-today' : '')+'" data-level="'+value+'" data-date="'+formatDate(time)+'" style="'+position+'"></i>';
      }
    }
    return {html,weeks};
  }

  // 定投记录: every buying day, newest first, for one year or all of them.
  function records(model, year) {
    const list = [];
    for (const [time,day] of model.days) if (year === 'all' || new Date(time).getUTCFullYear() === Number(year)) list.push({time,...day});
    return list.sort((a,b) => b.time-a.time);
  }
  // USDT paid per BTC that day, to the whole USDT.
  function priceText(day) { return day.usdt !== null && day.btc > 0 ? grouped(Math.round(day.usdt*1e6/day.btc)) : '—'; }
  function recordsSummary(list, label, exact = null) {
    const summary = exactSummary(exact);
    if (summary) return summary.days ? [label,summary.days+' 天',summary.buys+' 笔','累计买入 '+exactText(summary.btc,8)+' BTC',summary.usdt !== null ? '约 '+exactText(summary.usdt,2,true)+' USDT' : '',summary.average_buy_price !== null ? '历史买入均价 '+exactText(summary.average_buy_price,0) : ''].filter(Boolean).join(' · ') : label+' · 暂无定投记录';
    if (!list.length) return label+' · 暂无定投记录';
    let btc = 0, usdt = 0, priced = true, buys = 0, counted = true;
    for (const day of list) { btc += day.btc;if (day.usdt === null) priced = false;else usdt += day.usdt;if (day.buys === null) counted = false;else buys += day.buys; }
    return [label,list.length+' 天',counted ? buys+' 笔' : '','累计买入 '+btcText(btc)+' BTC',priced ? '约 '+usdtText(usdt)+' USDT' : '',priced && btc ? '历史买入均价 '+grouped(Math.round(usdt*1e6/btc)) : ''].filter(Boolean).join(' · ');
  }
  function recordRows(list, measure, selected) {
    return list.map(day => '<tr data-date="'+formatDate(day.time)+'"'+(day.time === selected ? ' class="is-selected"' : '')+'><td><i class="dca-swatch" data-level="'+level(day,measure)+'"></i>'+formatDate(day.time)+'<small>'+WEEKDAYS[weekday(day.time)]+'</small></td><td>'+btcText(day.btc)+'</td><td>'+usdtText(day.usdt)+'</td><td>'+priceText(day)+'</td><td>'+(day.buys === null ? '—' : day.buys)+'</td></tr>').join('');
  }

  const MARKUP = '<div class="dca-diary-heading"><div><h2 id="dcaDiaryTitle"><button id="dcaDiaryOpen" class="dca-diary-open" type="button" title="查看日 K 线与买入标记" aria-haspopup="dialog">定投日记</button></h2><small id="dcaDiarySince" class="dca-diary-since"></small></div><div id="dcaDiaryRange" class="dca-diary-range" role="group" aria-label="定投日记范围"></div></div>'+
    '<div class="dca-diary-meta"><p id="dcaDiarySummary" class="dca-diary-summary" title="按北京时间计日"></p><span id="dcaDiaryLegend" class="dca-diary-legend" title="颜色越深，当天投入越多" aria-hidden="true">少<i data-level="0"></i><i data-level="1"></i><i data-level="2"></i><i data-level="3"></i><i data-level="4"></i><i data-level="5"></i><i data-level="6"></i>多</span></div>'+
    '<div id="dcaDiaryScroll" class="dca-diary-scroll"><div id="dcaDiaryGrid" class="dca-diary-grid" role="img" tabindex="0"></div></div>'+
    '<p id="dcaDiaryMessage" class="dca-diary-message" role="status" hidden></p>'+
    '<div id="dcaDiaryTip" class="dca-diary-tip" role="tooltip" hidden><strong></strong><span></span></div><span id="dcaDiaryLive" class="dca-diary-live" aria-live="polite"></span>'+
    '';

  function mount(options = {}) {
    const root = options.root || globalThis, document = options.document || root.document, panel = document && document.getElementById('dcaDiaryPanel');
    if (!panel) return null;
    if (panel.__dcaDiaryController) return panel.__dcaDiaryController;
    const fetcher = options.fetch || root.fetch.bind(root), setTimer = options.setTimeout || root.setTimeout.bind(root), clearTimer = options.clearTimeout || root.clearTimeout.bind(root), now = options.now || Date.now;
    const node = id => document.getElementById(id);
    panel.classList.add('dca-diary','card');panel.setAttribute('aria-labelledby','dcaDiaryTitle');panel.innerHTML = MARKUP;
    let model = null, range = 'recent', view = null, timer = null, read = null, disposed = false, pageActive = true, failed = false, focused = null, sequence = 0, drawn = '';
    const grid = node('dcaDiaryGrid'), tip = node('dcaDiaryTip'), scroller = node('dcaDiaryScroll');
    const candles = options.candles || (root.DCACandles && root.DCACandles.mount({root,document,fetch:fetcher,setTimeout:setTimer,clearTimeout:clearTimer,now}));
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
      const measure = scale(data.days), signature = [range,data.today,data.start,data.coverage,measure && measure.limits.join(','),[...data.days].map(([time,day]) => time+':'+day.btc+':'+day.usdt).join(';')].join('|');
      node('dcaDiaryLegend').title = legendText(measure);
      if (signature !== drawn) {
        const built = gridHtml(view,data,measure);
        grid.style.setProperty('--weeks',String(built.weeks));grid.innerHTML = built.html;drawn = signature;focused = null;hideTip();
        // The latest weeks are the ones to see first when the grid scrolls.
        if (view.to === data.today && scroller.scrollWidth > scroller.clientWidth) scroller.scrollLeft = scroller.scrollWidth;
      }
      const all = stats(data,data.start,data.today), part = stats(data,view.from,view.to);
      const venueLabel = data.venues.includes('binance') ? ['okx','binance'].filter(venue => data.venues.includes(venue)).map(venue => venue === 'okx' ? '欧易' : '币安').join(' + ')+' · ' : '';
      const totals = data.exactTotals, allBTC = totals ? exactText(totals.btc,8) : btcText(all.btc), allUSDT = totals ? totals.usdt === null ? null : exactText(totals.usdt,2,true) : all.usdt === null ? null : usdtText(all.usdt);
      node('dcaDiarySince').textContent = venueLabel+'自 '+formatDate(data.start)+' 起'+(data.first === null ? '' : ' · '+(totals ? totals.days : all.days)+' 天 · 累计买入 '+allBTC+' BTC');
      node('dcaDiarySince').title = node('dcaDiarySince').textContent+(data.first === null ? '' : '\n首笔买入 '+formatDate(data.first)+'；累计买入 '+(totals ? totals.buys : all.buys)+' 笔'+(allUSDT !== null ? '，约 '+allUSDT+' USDT' : ''))+'\n累计买入按净到账 BTC 统计，不扣历史卖出，也不包含转入或理财收益。';
      // One short line: days, BTC and streaks; the USDT spent is in its tooltip.
      const known = data.days.size || data.status === 'fresh' || data.status === 'stale';
      const period = range === 'recent' ? null : data.exactPeriods[range], periodBTC = period ? exactText(period.btc,8) : btcText(part.btc), periodUSDT = period ? period.usdt === null ? null : exactText(period.usdt,2,true) : part.usdt === null ? null : usdtText(part.usdt);
      const summary = known
        ? view.label+'买入 '+(period ? period.days : part.days)+' 天 · '+periodBTC+' BTC · 最长连续 '+part.longest+' 天'+(part.current > 1 ? ' · 当前连续 '+part.current+' 天' : '')
        : data.status === 'loading' ? '正在读取定投记录' : '等待成本账本';
      node('dcaDiarySummary').textContent = summary;node('dcaDiarySummary').dataset.state = known ? 'known' : 'pending';
      node('dcaDiarySummary').title = known ? summary+(periodUSDT !== null && part.days ? '\n约 '+periodUSDT+' USDT' : '')+'\n按北京时间计日' : summary;
      grid.setAttribute('aria-label','定投日记 '+summary+'。用方向键逐日查看，回车打开日 K 线。');
      const message = failed ? data.days.size ? '同步暂未完成，保留上次的定投记录。' : '暂时无法读取定投记录，稍后自动重试。'
        : data.status === 'unavailable' ? (data.error || '导入已核对的成本账本后显示每天的定投。')
        : data.coverage !== null && data.coverage > data.start ? '成本账本自 '+formatDate(data.coverage)+' 起，之前的日期未计入。' : '';
      node('dcaDiaryMessage').textContent = message;node('dcaDiaryMessage').hidden = !message;
      candles?.updateBuys(data);
    }
    function openRecords(time) {
      hideTip();
      if (candles) candles.open(current(),Number.isFinite(time) ? formatDate(time) : null);
      else { node('dcaDiaryMessage').textContent = '图表组件暂不可用，请重新载入页面。';node('dcaDiaryMessage').hidden = false; }
    }
    function closeRecords() { candles?.close(); }
    function openFrom(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      if (target.closest('#dcaDiaryOpen')) { openRecords(null);return; }
      if (target.closest('button, a, input, select')) return;
      const cell = target.closest('.dca-cell[data-date]');
      if (cell) openRecords(parseDate(cell.dataset.date));
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
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault();openRecords(focused);return; }
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
        if (model && model.connectionId === data.connectionId && model.days.size && !data.days.size && data.status !== 'fresh') { failed = true;render();return; }
        model = data;failed = false;render();
      } catch (_) { if (!disposed && token.sequence === sequence && !token.cancelled) { failed = true;render(); } }
      finally { clearTimer(token.timeout);if (read === token) { read = null;schedule(); } }
    }
    function visibility() { if (active()) load();else { cancelTimer();cancelRead();hideTip();closeRecords(); } }
    function pageHide() { pageActive = false;visibility(); }
    function pageShow() { pageActive = true;visibility(); }
    const events = [[node('dcaDiaryRange'),'click',choose],[grid,'pointerover',pointer],[grid,'pointerleave',leave],[grid,'keydown',keydown],[grid,'blur',() => { if (!candles?.isOpen()) { hideTip();focused = null; } }],
      [panel,'click',openFrom],[document,'pointerdown',outside],[document,'visibilitychange',visibility],[root,'hashchange',visibility],[root,'pagehide',pageHide],[root,'pageshow',pageShow]];
    for (const [target,event,handler,options] of events) target.addEventListener(event,handler,options);
    function destroy() {
      disposed = true;closeRecords();cancelTimer();cancelRead();for (const [target,event,handler,options] of events) target.removeEventListener(event,handler,options);
      candles?.destroy();
      panel.__dcaDiaryController = null;
    }
    const controller = {refresh:load,destroy,select:value => { range = String(value);render(); },open:openRecords,close:closeRecords};
    panel.__dcaDiaryController = controller;render();if (active()) load();return controller;
  }
  return {START,REFRESH_MS,STEPS,parseDate,formatDate,beijingToday,weekday,monday,units,btcText,usdtText,exactText,exactSummary,priceDistribution,normalize,scale,level,legendText,ranges,bounds,stats,cellState,describe,gridHtml,records,priceText,recordsSummary,recordRows,mount};
});
