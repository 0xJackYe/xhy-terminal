(function (root) {
  'use strict';
  const FRESH_MS = 10000;
  const BEIJING_OFFSET_MS = 8 * 3600000;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const number = value => finite(value) ? value : null;
  const fmtPrice = value => finite(value) ? value.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2}) : '—';
  const fmtPct = (value, signed = true) => finite(value) ? (signed && value > 0 ? '+' : '') + value.toFixed(2) + '%' : '—';
  function beijingTime(ms, includeDate = false) {
    if (!finite(ms)) return '—';
    const date = new Date(ms + BEIJING_OFFSET_MS);
    if (!Number.isFinite(date.getTime())) return '—';
    const pad = n => String(n).padStart(2, '0');
    const time = pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes()) + ':' + pad(date.getUTCSeconds());
    return includeDate ? date.getUTCFullYear() + '-' + pad(date.getUTCMonth()+1) + '-' + pad(date.getUTCDate()) + ' ' + time : time;
  }
  function marketHealth(market, nowMs, transportConnected) {
    const error = market && (market.clock_error || market.error);
    if (!market || !finite(market.price) || market.price <= 0) return {status:market && market.status === 'error' ? 'error' : 'connecting', text:market && market.status === 'waiting_time' ? '正在校准行情时间' : market && market.status === 'waiting_live' ? '等待实时行情' : '等待行情', note:error || (market && market.status === 'waiting_live' ? '等待实时行情，警报未启动。' : market && market.status === 'waiting_time' ? '正在校准时间，警报暂停。' : '正在连接行情。')};
    const lastEvent = number(market.event_ms);
    const lastReceipt = number(market.received_ms);
    const fresh = lastEvent !== null && lastReceipt !== null && nowMs - lastEvent <= FRESH_MS && nowMs - lastReceipt <= FRESH_MS && lastEvent <= nowMs + 5000 && lastReceipt <= nowMs + 5000;
    if (!transportConnected) return {status:'stale',text:'连接已中断',note:'正在重连后台，当前为缓存价格。'};
    if (market.status === 'waiting_time') return {status:'connecting',text:'正在校准行情时间',note:error || '正在校准时间，警报暂停。'};
    if (market.status === 'waiting_baseline') return {status:'connecting',text:'正在载入当日基准',note:error || '当日基准待载入，警报未启动。'};
    if (market.status === 'waiting_live') return {status:'connecting',text:'等待实时行情',note:error || '当前为初始快照，警报未启动。'};
    if (market.status === 'stopped') return {status:'error',text:'后台已停止',note:'当前为缓存价格，请重启后台。'};
    if (market.status === 'reconnecting') return {status:'stale',text:'正在重连行情',note:error || '正在重连，当前为缓存价格。'};
    if (market.status !== 'live' || !fresh) return {status:market.status === 'error' ? 'error' : 'stale',text:'行情暂未更新',note:error || '当前为缓存价格，警报暂停。'};
    return {status:'live',text:'实时行情',note:''};
  }
  function clockPresentation(market) {
    if (!market) return {text:'',note:''};
    const status = market.clock_status;
    if (['calibrated','injected'].includes(status) && finite(market.clock_offset_ms)) {
      const offset = market.clock_offset_ms;
      const difference = Math.abs(offset) < 50 ? '偏差 < 0.1 秒' : '本机' + (offset > 0 ? '慢 ' : '快 ') + (Math.abs(offset)/1000).toFixed(1) + ' 秒';
      return {text:'时间已校准 · ' + difference,note:market.clock_warning || ''};
    }
    if (['expired','error','stale'].includes(status)) return {text:'时间校准待恢复',note:market.clock_error || '时间校准已失效，警报暂停。'};
    return {text:'',note:''};
  }
  function chartPoints(history, maxPoints = 1000) {
    const values = (Array.isArray(history) ? history : []).filter(p => p && finite(p.time_ms) && finite(p.price) && p.price > 0).sort((a,b) => a.time_ms - b.time_ms);
    const unique = [];
    values.forEach(point => { if (unique.length && unique[unique.length-1].time_ms === point.time_ms) unique[unique.length-1] = point; else unique.push(point); });
    if (unique.length <= maxPoints) return unique;
    const result = [];
    for (let i = 0; i < maxPoints; i++) result.push(unique[Math.round(i * (unique.length - 1) / (maxPoints - 1))]);
    return result;
  }
  // Live stream snapshots after the first carry only history_tail: the newest
  // per-minute points, starting with the minute being updated. Everything from
  // that minute on is replaced; earlier minutes are kept as they are.
  function mergeHistoryTail(history, tail) {
    const base = Array.isArray(history) ? history : [];
    const points = Array.isArray(tail) ? tail.filter(p => p && finite(p.time_ms)) : [];
    if (!points.length) return base.slice();
    const from = Math.floor(points[0].time_ms / 60000);
    return base.filter(p => p && finite(p.time_ms) && Math.floor(p.time_ms / 60000) < from).concat(points);
  }
  function chartGeometry(history) {
    const points = chartPoints(history);
    if (!points.length) return null;
    const xStart = points[0].time_ms;
    const xEnd = Math.max(xStart + 1000, points[points.length-1].time_ms);
    let min = Math.min(...points.map(p => p.price));
    let max = Math.max(...points.map(p => p.price));
    const padding = Math.max((max-min) * .18, max * .00008, .1);
    min -= padding; max += padding;
    const left = 5, right = 585, top = 9, bottom = 172;
    const xy = points.map(p => ({x:left + (p.time_ms-xStart)/(xEnd-xStart)*(right-left), y:bottom-(p.price-min)/(max-min)*(bottom-top)}));
    const path = xy.map((p,i) => (i ? 'L' : 'M') + p.x.toFixed(2) + ',' + p.y.toFixed(2)).join(' ');
    return {points,xy,path,xStart,xEnd,min,max,left,right,top,bottom};
  }
  function validateSettings(values) {
    const threshold = Number(values.threshold_pct);
    if (!Number.isFinite(threshold) || threshold < .1 || threshold > 50) throw new Error('阈值请填写 0.1% 到 50% 之间的数字。');
    if (!['daily_change','day_range'].includes(values.metric)) throw new Error('请选择有效的监测指标。');
    const result={threshold_pct:threshold,metric:values.metric,sound:!!values.sound};
    if(values.thresholds_pct!==undefined){
      if(!Array.isArray(values.thresholds_pct)||values.thresholds_pct.length<1||values.thresholds_pct.length>3)throw new Error('请设置一至三个递增阈值。');
      const tiers=values.thresholds_pct.map(value=>Number(value));
      if(tiers.some((value,index)=>!Number.isFinite(value)||value<.1||value>50||index>0&&value<=tiers[index-1])||tiers[0]!==threshold)throw new Error('三个阈值需从小到大，范围为 0.1% 到 50%。');
      if(tiers.length>1)result.thresholds_pct=tiers;
    }
    return result;
  }
  function eligibleNotifications(alerts, seen, nowMs) {
    const result = [];
    (Array.isArray(alerts) ? alerts : []).forEach(alert => {
      if (!alert || typeof alert.id !== 'string' || seen.has(alert.id)) return;
      seen.add(alert.id);
      if (alert.kind === 'market' && finite(alert.at_ms) && alert.at_ms <= nowMs + 5000 && nowMs - alert.at_ms < 30000) result.push(alert);
    });
    return result;
  }
  function walletMessageAction(event, origin, frameWindow, focused) {
    if (!event || event.origin !== origin || event.source !== frameWindow || !event.data || typeof event.data !== 'object') return null;
    if (event.data.type === 'wallet-escape') return focused ? {type:'escape'} : null;
    if (event.data.type !== 'wallet-height' || !finite(event.data.height)) return null;
    return {type:'height',height:Math.min(5000,Math.max(700,event.data.height))};
  }
  function pageFromHash(hash) {
    const page = String(hash || '').replace(/^#/, '');
    if (page === 'options') return 'options';
    if (page === 'wallet' || page === 'wallet-panel') return 'wallet';
    return 'alerts';
  }
  function createPageRouter() {
    let current = null, optionsLoaded = false;
    return {
      change(hash) {
        const page = pageFromHash(hash), previous = current;
        const changed = previous !== page;
        const loadOptions = changed && page === 'options' && !optionsLoaded;
        if (loadOptions) optionsLoaded = true;
        current = page;
        return {page,previous,changed,loadOptions,requestOptionsState:changed && page === 'options',stopPreview:changed && previous === 'alerts'};
      }
    };
  }
  function optionsMessageAction(event, origin, frameWindow, page) {
    if (!event || event.origin !== origin || event.source !== frameWindow || !event.data || typeof event.data !== 'object') return null;
    if (event.data.type === 'options-focus') return page === 'options' && typeof event.data.focused === 'boolean' ? {type:'focus',focused:event.data.focused} : null;
    // The options chain uses viewport-relative scrolling. Reported content height
    // must never resize its viewport, which would create a feedback loop.
    return null;
  }
  function soundLabel(alert) {
    const status = alert.sound_status;
    if (status === 'played') return '播放调用完成';
    if (status === 'playing' || status === 'ringing' || status === 'started') return '正在响铃';
    if (status === 'queued') return '等待响铃';
    if (status === 'disabled' || status === 'off') return '声音已关闭';
    if (status === 'silenced' || status === 'stopped') return '已停止';
    if (status === 'interrupted') return '响铃已中断';
    if (status === 'skipped_busy') return '已有警报响铃';
    if (status === 'unsupported') return '本机不支持声音';
    if (status === 'error' || status === 'failed' || status === 'unavailable') return '声音不可用';
    return '—';
  }
  function createAudioPreview(createAudio, report) {
    let currentAudio = null, generation = 0;
    function stop() {
      generation++;
      const audio = currentAudio;
      currentAudio = null;
      if (!audio) return;
      try {audio.pause();} catch (_) {}
      try {audio.currentTime = 0;} catch (_) {}
    }
    function start(level=1) {
      stop();
      const token = generation;
      let audio;
      const isCurrent = () => token === generation && currentAudio === audio;
      const fail = () => {
        if (!isCurrent()) return;
        stop();
        report('试听失败：请取消静音或允许网页播放声音。',true);
      };
      try {
        audio = createAudio(level===2?'/audio/alert-2.wav':level===3?'/audio/alert-3.wav':'/audio/alert.wav');
        currentAudio = audio;
        audio.volume = 1;
        audio.addEventListener('ended',()=>{if(!isCurrent())return;currentAudio=null;report('试听已结束。');},{once:true});
        audio.addEventListener('error',fail,{once:true});
        report('正在准备浏览器试听…');
        // Keep play() in the click call stack so the browser retains the user gesture.
        const playing = audio.play();
        Promise.resolve(playing).then(()=>{if(isCurrent())report('正在试听。');},fail);
      } catch (_) {
        if (currentAudio === audio) fail();
        else report('试听失败：请取消静音或允许网页播放声音。',true);
      }
    }
    return {start,stop};
  }
  function createJSONRequester(fetchImpl, timeoutMs = 10000, timers = root) {
    return async function requestJSON(path, init = {}) {
      const control = new AbortController();
      let timer;
      const timedOut = new Error(init.method === 'POST' ? '本机后台响应超时，操作结果尚未确认，请检查当前设置后重试。' : '本机后台响应超时，请稍后重试。');
      try {
        return await Promise.race([
          (async () => {
            const response = await fetchImpl(path,{...init,signal:control.signal});
            let data;
            try { data = await response.json(); }
            catch (_) { if (response.ok) throw new Error('本机后台返回无效响应。'); }
            return {ok:response.ok,status:response.status,data};
          })(),
          new Promise((_,reject) => {timer=timers.setTimeout(()=>{reject(timedOut);control.abort();},timeoutMs);})
        ]);
      } finally {timers.clearTimeout(timer);}
    };
  }
  const helpers = {beijingTime,marketHealth,clockPresentation,chartPoints,mergeHistoryTail,chartGeometry,validateSettings,eligibleNotifications,walletMessageAction,pageFromHash,createPageRouter,optionsMessageAction,soundLabel,createAudioPreview,createJSONRequester,fmtPrice,fmtPct};
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id);
  let snapshot = null, offsetMs = 0, transportConnected = false, hydrated = false;
  let formDirty = false, formRevision = 0, busy = false, lastChartAt = 0, pendingChart = false, lastAlertsSignature = null;
  let currentStream = null, pageActive = true, streamErrorMessage = null;
  const retiredInstances = new Set();
  let walletFocused = false, currentPage = 'alerts', optionsChildFocused = false;
  const pageRouter = createPageRouter();
  const seenAlerts = new Set();
  let notificationsEnabled = false;
  function storedGet(key) {try{return localStorage.getItem(key);}catch(_){return null;}}
  function storedSet(key,value) {try{localStorage.setItem(key,value);}catch(_){}}
  notificationsEnabled = storedGet('bitcoin-terminal-notifications') === 'true';
  const serverNow = () => Date.now() + offsetMs;
  function setText(id, value) {$(id).textContent = value;}
  function polarity(id,value) {$(id).classList.toggle('up',finite(value)&&value>0);$(id).classList.toggle('down',finite(value)&&value<0);}
  function showStatus(message, error = false) {setText('settingsStatus',message);$('settingsStatus').classList.toggle('error',error);}
  const browserPreview = createAudioPreview(src=>new root.Audio(src),showStatus);
  const requestJSON = createJSONRequester((path,init)=>fetch(path,init));
  function renderNotificationButton() {
    const available = 'Notification' in root;
    const permission = available ? Notification.permission : 'unavailable';
    const enabled = available && permission === 'granted' && notificationsEnabled;
    setText('desktopNotifications',enabled ? '关闭桌面通知' : permission === 'denied' ? '桌面通知已被浏览器阻止' : permission === 'unavailable' ? '浏览器不支持桌面通知' : '开启桌面通知');
    $('desktopNotifications').disabled = permission === 'denied' || permission === 'unavailable';
    $('desktopNotifications').setAttribute('aria-pressed',String(enabled));
  }
  function updateClockAndHealth() {
    setText('clock','北京时间 ' + beijingTime(serverNow(),true));
    const health = marketHealth(snapshot && snapshot.market,serverNow(),transportConnected);
    $('feedBadge').className = 'status-badge ' + health.status;
    $('feedBadge').querySelector('span').textContent = health.text;
    const storageError = snapshot && snapshot.storage_error ? '设置或记录保存失败，请重新保存。' : '';
    const clockNote = clockPresentation(snapshot && snapshot.market).note;
    const notices = [...new Set([health.note,clockNote,storageError].filter(Boolean))];
    $('connectionNotice').hidden = !clockNote && !storageError && (health.status === 'live' || !snapshot && health.status === 'connecting');
    $('connectionNotice').textContent = notices.join(' ');
  }
  function ruleText() {
    const tiers=[$('thresholdInput').value,$('threshold2Input').value,$('threshold3Input').value].filter(value=>value!=='').map(Number);
    const label=tiers.length&&tiers.every(value=>Number.isFinite(value)&&value>=.1&&value<=50)?tiers.map(value=>value.toLocaleString('zh-CN',{maximumFractionDigits:4})+'%').join(' / '):'所设阈值';
    setText('ruleNote',$('metricInput').value === 'day_range' ? '北京时间当日（最高 − 最低）/ 开盘 ≥' + label + '；每档每日一次。' : '北京时间 00:00 开盘价 ±' + label + '；每方向每档每日一次。');
  }
  function renderSettings() {
    if (!snapshot || !snapshot.settings) return;
    const settings = snapshot.settings;
    if (!formDirty) {
      $('thresholdInput').value = finite(settings.threshold_pct) ? String(settings.threshold_pct) : '2.5';
      const tiers=Array.isArray(settings.thresholds_pct)?settings.thresholds_pct:[settings.threshold_pct];
      $('threshold2Input').value=finite(tiers[1])?String(tiers[1]):'';
      $('threshold3Input').value=finite(tiers[2])?String(tiers[2]):'';
      $('metricInput').value = ['daily_change','day_range'].includes(settings.metric) ? settings.metric : 'daily_change';
      $('soundInput').checked = !!settings.sound;
    }
    setText('monitorPill',settings.enabled ? '监测已启用' : '监测已暂停');
    $('monitorPill').classList.toggle('enabled',!!settings.enabled);
    setText('monitorButton',settings.enabled ? '暂停监测' : '启用监测');
    $('monitorButton').disabled = busy;
    $('saveSettings').disabled = busy;
    ruleText();
  }
  function renderMarket() {
    const market = snapshot && snapshot.market || {};
    setText('priceValue',fmtPrice(market.price));
    setText('changeValue',fmtPct(market.change_pct));
    setText('rangeValue',fmtPct(market.range_pct,false));
    setText('openValue',fmtPrice(market.day_open));
    setText('highValue',fmtPrice(market.day_high));
    setText('lowValue',fmtPrice(market.day_low));
    polarity('changeValue',market.change_pct);
    setText('priceTime',finite(market.event_ms) ? '行情时间 ' + beijingTime(market.event_ms) : '等待首次行情');
    setText('chartDate',finite(market.day_start_ms) ? beijingTime(market.day_start_ms,true).slice(0,10) + ' · 北京时间' : '北京时间 · 今日');
    updateClockAndHealth();
  }
  function renderChart() {
    pendingChart = false;
    lastChartAt = Date.now();
    const geometry = chartGeometry(snapshot && snapshot.history);
    if (!geometry) {const node = document.createElement('div');node.className='chart-empty';node.textContent='等待行情';$('priceChart').replaceChildren(node);return;}
    const g = geometry;
    const labelRows = Array.from({length:4},(_,i) => ({y:g.top+i/3*(g.bottom-g.top),price:g.max-i/3*(g.max-g.min)}));
    const grids = labelRows.map(row => '<line class="chart-gridline" x1="' + g.left + '" x2="' + g.right + '" y1="' + row.y.toFixed(2) + '" y2="' + row.y.toFixed(2) + '"/><text x="598" y="' + (row.y+3).toFixed(2) + '">' + Math.round(row.price).toLocaleString('en-US') + '</text>').join('');
    const last = g.xy[g.xy.length-1];
    const fill = g.path + ' L' + last.x.toFixed(2) + ',' + g.bottom + ' L' + g.left + ',' + g.bottom + ' Z';
    const title = '比特币实时价格，从 ' + beijingTime(g.xStart) + ' 到 ' + beijingTime(g.points[g.points.length-1].time_ms) + '，最新 ' + fmtPrice(g.points[g.points.length-1].price) + ' USDT';
    $('priceChart').innerHTML = '<svg viewBox="0 0 680 203" preserveAspectRatio="none" role="img" aria-label="' + title + '"><defs><linearGradient id="priceFade" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="var(--accent)" stop-opacity=".12"/><stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>' + grids + '<path class="chart-fill" d="' + fill + '"/><path class="chart-line" d="' + g.path + '"/><circle class="chart-end-dot" cx="' + last.x.toFixed(2) + '" cy="' + last.y.toFixed(2) + '" r="3.5"/><text x="5" y="198">' + beijingTime(g.xStart).slice(0,5) + '</text><text x="290" y="198" text-anchor="middle">' + beijingTime((g.xStart+g.xEnd)/2).slice(0,5) + '</text><text x="585" y="198" text-anchor="end">' + beijingTime(g.points[g.points.length-1].time_ms).slice(0,5) + '</text></svg>';
    setText('chartCoverage',beijingTime(g.xStart).slice(0,5) + ' — ' + beijingTime(g.points[g.points.length-1].time_ms).slice(0,5) + (snapshot && snapshot.market.rest_error ? ' · 历史数据暂缺' : ''));
  }
  function queueChart() {if (Date.now()-lastChartAt >= 1000) renderChart(); else pendingChart = true;}
  function eventName(alert) {if(alert.kind==='test') return '本机测试';const name=alert.direction==='up' ? '上涨警报' : alert.direction==='down' ? '下跌警报' : '振幅警报';return name+(finite(alert.threshold_pct)?' · '+alert.threshold_pct+'%档':'');}
  function renderAlerts() {
    const alerts = (snapshot && Array.isArray(snapshot.alerts) ? snapshot.alerts : []).filter(a => a && typeof a.id === 'string').slice().sort((a,b) => (number(b.at_ms)||0)-(number(a.at_ms)||0));
    const signature = JSON.stringify(alerts);
    if (signature === lastAlertsSignature) return;
    lastAlertsSignature = signature;
    setText('historyCount',String(alerts.length));
    const latest = alerts[0];
    $('latestAlert').classList.toggle('triggered',!!latest);
    setText('latestAlert',latest ? beijingTime(latest.at_ms,true) + ' · ' + eventName(latest) + (latest.kind === 'test' ? '' : ' ' + fmtPct(latest.change_pct,latest.direction!=='range') + ' · ' + fmtPrice(latest.price) + ' USDT') + ' · ' + soundLabel(latest) : '暂无警报');
    const body = $('historyRows');body.replaceChildren();
    if (!alerts.length) {const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=5;cell.className='empty-row';cell.textContent='暂无记录';row.append(cell);body.append(row);return;}
    alerts.forEach(alert => {const row=document.createElement('tr');const values=[beijingTime(alert.at_ms,true),eventName(alert),alert.kind==='test'?'测试':fmtPct(alert.change_pct,alert.direction!=='range'),fmtPrice(alert.price),soundLabel(alert)];values.forEach((value,index)=>{const cell=document.createElement('td');cell.textContent=value;if(index===1)cell.className=alert.kind==='test'?'event-label test-tag':'event-label';row.append(cell);});body.append(row);});
  }
  function notify(alert) {
    if (!notificationsEnabled || !('Notification' in root) || Notification.permission !== 'granted') return;
    try {const notification = new Notification('Bitcoin · ' + eventName(alert),{body:fmtPct(alert.change_pct,alert.direction!=='range') + ' · ' + fmtPrice(alert.price) + ' USDT\n北京时间 ' + beijingTime(alert.at_ms),tag:'bitcoin-alert-'+alert.id,silent:true});notification.onclick=()=>{root.focus();notification.close();};}catch(_) {showStatus('桌面通知暂不可用。',true);}
  }
  function acceptSnapshot(data) {
    if (!data || typeof data !== 'object' || !data.settings || !data.market) throw new Error('后台返回的行情结构不完整。');
    const incomingInstance = typeof data.instance_id === 'string' ? data.instance_id : null;
    const previousInstance = snapshot && typeof snapshot.instance_id === 'string' ? snapshot.instance_id : null;
    if (incomingInstance && retiredInstances.has(incomingInstance)) return;
    const restarted = incomingInstance && previousInstance && incomingInstance !== previousInstance;
    if (!restarted && snapshot && finite(data.revision) && finite(snapshot.revision) && data.revision < snapshot.revision) return;
    if (restarted) {
      retiredInstances.add(previousInstance);
      if (retiredInstances.size > 16) retiredInstances.delete(retiredInstances.values().next().value);
    }
    if (!Array.isArray(data.history) && Array.isArray(data.history_tail)) data = {...data, history: mergeHistoryTail(snapshot && snapshot.history, data.history_tail)};
    if (finite(data.server_time_ms)) offsetMs = data.server_time_ms - Date.now();
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];
    if (!hydrated) {alerts.forEach(a=>{if(a&&typeof a.id==='string')seenAlerts.add(a.id);});hydrated=true;} else eligibleNotifications(alerts,seenAlerts,serverNow()).forEach(notify);
    if (seenAlerts.size > 1000) {const keep=Array.from(seenAlerts).slice(-500);seenAlerts.clear();keep.forEach(id=>seenAlerts.add(id));}
    snapshot=data;transportConnected=true;renderMarket();renderSettings();renderAlerts();queueChart();
    if(streamErrorMessage&&$('settingsStatus').textContent===streamErrorMessage)showStatus('行情连接已恢复。');
    streamErrorMessage=null;
  }
  async function getSnapshot() {
    const response=await requestJSON('/api/terminal',{cache:'no-store'});
    if(!response.ok)throw new Error('本机后台暂不可用（'+response.status+'）。');
    acceptSnapshot(response.data);
  }
  async function post(endpoint, values) {
    const response=await requestJSON(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Terminal-Request':'1'},body:JSON.stringify(values)});
    const result=response.data;
    if(!response.ok)throw new Error(result&&result.error||'设置未保存（'+response.status+'）。');
    if(!result||typeof result!=='object')throw new Error('本机后台返回无效响应。');
    if(result.settings&&result.market){
      acceptSnapshot(result);
      if(typeof result.instance_id==='string'&&snapshot&&typeof snapshot.instance_id==='string'&&result.instance_id!==snapshot.instance_id)throw new Error('后台已重新启动，本次操作结果尚未确认，请检查后重试。');
    }else await getSnapshot();
    return result;
  }
  async function runAction(action, success) {
    if(busy)return;
    busy=true;renderSettings();$('testAlarm').disabled=true;showStatus('正在处理…');
    try{await action();showStatus(typeof success === 'function' ? success() : success);}catch(error){showStatus(error.message||'操作失败，请重试。',true);}finally{busy=false;renderSettings();$('testAlarm').disabled=false;}
  }
  $('alarmForm').addEventListener('input',()=>{formDirty=true;formRevision++;ruleText();showStatus('设置未保存。');});
  $('alarmForm').addEventListener('submit',event=>{event.preventDefault();let values;try{if($('threshold2Input').value===''&&$('threshold3Input').value!=='')throw new Error('请先填写第二档阈值。');values=validateSettings({threshold_pct:$('thresholdInput').value,thresholds_pct:[$('thresholdInput').value,$('threshold2Input').value,$('threshold3Input').value].filter(value=>value!==''),metric:$('metricInput').value,sound:$('soundInput').checked});}catch(error){showStatus(error.message,true);return;}const submittedRevision=formRevision;formDirty=true;runAction(async()=>{
    await post('/api/terminal/settings',values);
    if(!snapshot||!Object.entries(values).every(([key,value])=>JSON.stringify(snapshot.settings[key])===JSON.stringify(value)))throw new Error('后台设置已变化，本次保存尚未确认；已保留当前输入，请检查后重试。');
    if(formRevision===submittedRevision)formDirty=false;
    renderSettings();
  },()=>formDirty?'提交的设置已保存；后续修改仍需保存。':'设置已保存。');});
  $('monitorButton').addEventListener('click',()=>{if(!snapshot)return;const next=!snapshot.settings.enabled;runAction(async()=>{
    await post('/api/terminal/settings',{enabled:next});
    if(!snapshot||snapshot.settings.enabled!==next)throw new Error('后台监测状态已变化，本次操作尚未确认，请检查后重试。');
  },next?'已启用监测。':'已暂停监测。');});
  $('testAlarm').addEventListener('click',()=>{const level=Number($('alarmSoundLevel').value)||1;runAction(()=>post('/api/terminal/test',level===1?{}:{sound_level:level}),'测试已发送。');});
  $('previewAlarm').addEventListener('click',()=>browserPreview.start(Number($('alarmSoundLevel').value)||1));
  let silenceBusy = false;
  $('silenceAlarm').addEventListener('click',()=>{
    browserPreview.stop();
    if(silenceBusy)return;
    silenceBusy=true;showStatus('正在停止响铃…');
    post('/api/terminal/silence',{}).then(()=>showStatus('已停止响铃。'),error=>showStatus('网页试听已停止。'+(error.message||'后台停止请求失败，请重试。'),true)).finally(()=>{silenceBusy=false;});
  });
  root.addEventListener('pagehide',()=>{pageActive=false;browserPreview.stop();if(currentStream){currentStream.close();currentStream=null;}transportConnected=false;});
  root.addEventListener('pageshow',event=>{pageActive=true;if(event.persisted){updateClockAndHealth();connect();getSnapshot().catch(()=>{if(!transportConnected)updateClockAndHealth();});}});
  $('desktopNotifications').addEventListener('click',async()=>{if(!('Notification' in root))return;if(notificationsEnabled&&Notification.permission==='granted'){notificationsEnabled=false;storedSet('bitcoin-terminal-notifications','false');renderNotificationButton();return;}try{const permission=Notification.permission==='granted'?'granted':await Notification.requestPermission();notificationsEnabled=permission==='granted';storedSet('bitcoin-terminal-notifications',String(notificationsEnabled));renderNotificationButton();showStatus(notificationsEnabled?'桌面通知已开启。':'桌面通知未开启。');}catch(_){showStatus('浏览器暂时无法开启桌面通知。',true);}});
  $('toggleHistory').addEventListener('click',()=>{const expanded=$('historyBody').hidden;$('historyBody').hidden=!expanded;$('toggleHistory').setAttribute('aria-expanded',String(expanded));$('toggleHistory').innerHTML=expanded?'收起记录 <span aria-hidden="true">↑</span>':'展开记录 <span aria-hidden="true">↓</span>';});
  $('toggleWallet').addEventListener('click',()=>{const expanded=$('walletFrameWrap').hidden;$('walletFrameWrap').hidden=!expanded;$('toggleWallet').setAttribute('aria-expanded',String(expanded));setText('toggleWallet',expanded?'收起余额走势':'展开余额走势');});
  function setWalletFocus(focused, restoreFocus = true) {walletFocused=focused;document.body.classList.toggle('focus-wallet',focused);$('focusWallet').setAttribute('aria-pressed',String(focused));setText('focusWallet',focused?'退出专注 · Esc':'专注余额');if(focused){$('walletFrameWrap').hidden=false;$('toggleWallet').setAttribute('aria-expanded','true');setText('toggleWallet','收起余额走势');$('toggleWallet').hidden=true;root.scrollTo({top:0,behavior:'instant'});}else{$('toggleWallet').hidden=false;if(restoreFocus){$('focusWallet').focus();$('wallet-panel').scrollIntoView({block:'start'});}}}
  $('focusWallet').addEventListener('click',()=>setWalletFocus(!walletFocused));
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&walletFocused){event.preventDefault();setWalletFocus(false);}});
  function requestOptionsState() {
    const frame = $('optionsFrame');
    if (currentPage === 'options' && frame.contentWindow) frame.contentWindow.postMessage({type:'options-request-state'},root.location.origin);
  }
  function applyOptionsFocus() {
    document.body.classList.toggle('focus-options',currentPage === 'options' && optionsChildFocused);
  }
  // The on-chain balance page loads on the first visit to the wallet page, and
  // not inside the portal, whose simplified wallet tab does not show it.
  function loadWalletFrame() {
    const frame = $('walletFrame');
    let framed = true;try { framed = root.self !== root.top; } catch (_) { framed = true; }
    if (!frame || frame.src || framed) return;
    frame.src = (frame.dataset && frame.dataset.src) || '/wallet.html';
  }
  function showPage() {
    const transition = pageRouter.change(root.location.hash);
    if (!transition.changed) return;
    if (transition.stopPreview) browserPreview.stop();
    if (walletFocused && transition.page !== 'wallet') setWalletFocus(false,false);
    currentPage = transition.page;
    ['alerts','options','wallet'].forEach(page => {
      $(page+'Page').hidden = page !== currentPage;
      const link = document.querySelector('.nav-link[data-page="'+page+'"]');
      if (page === currentPage) link.setAttribute('aria-current','page');
      else link.removeAttribute('aria-current');
    });
    document.body.setAttribute('data-page',currentPage);
    document.title = 'Bitcoin · ' + {alerts:'价格警报',options:'期权看板',wallet:'钱包走势'}[currentPage];
    applyOptionsFocus();
    if (transition.loadOptions) $('optionsFrame').src = '/options.html';
    if (currentPage === 'wallet') loadWalletFrame();
    if (transition.requestOptionsState) requestOptionsState();
    root.scrollTo({top:0,behavior:'instant'});
  }
  root.addEventListener('hashchange',showPage);
  $('optionsFrame').addEventListener('load',requestOptionsState);
  $('pageNavigation').addEventListener('keydown',event => {
    const links = Array.from($('pageNavigation').querySelectorAll('.nav-link'));
    const index = links.indexOf(event.target);
    if (index < 0) return;
    const target = event.key === 'ArrowRight' ? (index+1)%links.length : event.key === 'ArrowLeft' ? (index+links.length-1)%links.length : event.key === 'Home' ? 0 : event.key === 'End' ? links.length-1 : null;
    if (target === null) return;
    event.preventDefault();links[target].focus();links[target].click();
  });
  root.addEventListener('message',event=>{
    const walletAction=walletMessageAction(event,root.location.origin,$('walletFrame').contentWindow,currentPage === 'wallet' && walletFocused);
    if(walletAction){if(walletAction.type==='escape')setWalletFocus(false);else if(walletAction.type==='height')$('walletFrame').style.height=walletAction.height+'px';return;}
    const action=optionsMessageAction(event,root.location.origin,$('optionsFrame').contentWindow,currentPage);
    if(!action)return;
    if(action.type==='focus'){optionsChildFocused=action.focused;applyOptionsFocus();}
  });
  function connect() {
    if (!pageActive || currentStream) return;
    const stream = new EventSource('/api/terminal/events');
    currentStream=stream;
    const receive=event=>{if(currentStream!==stream)return;try{acceptSnapshot(JSON.parse(event.data));}catch(error){transportConnected=false;streamErrorMessage=error.message;showStatus(streamErrorMessage,true);updateClockAndHealth();}};
    stream.addEventListener('snapshot',receive);stream.onmessage=receive;
    stream.onerror=()=>{if(currentStream!==stream)return;transportConnected=false;updateClockAndHealth();};
  }
  showPage();renderNotificationButton();ruleText();updateClockAndHealth();
  // The stream must not depend on a bootstrap request completing. A delayed
  // bootstrap failure also must not erase a newer live stream's healthy state.
  connect();
  getSnapshot().catch(error=>{if(transportConnected)return;$('connectionNotice').hidden=false;$('connectionNotice').textContent=error.message;});
  setInterval(()=>{updateClockAndHealth();if(pendingChart)renderChart();},1000);
})(typeof window !== 'undefined' ? window : globalThis);

// Email preferences use their own form and never alter the price alarm settings.
(function (root) {
  'use strict';
  if(typeof document==='undefined')return;
  const form=document.getElementById('emailForm');
  if(!form||!form.elements)return;
  const ids=['emailSender','emailAuthorization','emailEnabled','emailSave','emailTest','emailRefresh','emailState','emailStatus','emailDelivery'];
  const nodes=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)]));
  if(ids.some(id=>!nodes[id]))return;
  const DEFAULT_EMAIL='oxjackye@qq.com';
  let status=null,loaded=false,busy=false,reading=false,dirty=false,revision=0,stateGeneration=0,pageActive=true;
  function message(value,error=false){nodes.emailStatus.textContent=value;nodes.emailStatus.classList.toggle('error',error);}
  function buttons(){nodes.emailSave.disabled=busy||!loaded;nodes.emailTest.disabled=busy||!loaded||!status?.configured||!status?.enabled;nodes.emailRefresh.disabled=busy||reading;}
  function delivery(data){
    const counts=data.counts||{},parts=[];
    if(Number.isSafeInteger(counts.accepted)&&counts.accepted>0)parts.push('已交给邮件服务器 '+counts.accepted+' 封');
    const pending=(Number(counts.queued)||0)+(Number(counts.sending)||0);
    if(pending>0)parts.push('发送中 '+pending+' 封');
    if(Number(counts.unknown)>0)parts.push('有发送结果待确认，请先查看收件箱');
    if(data.last_error||Number(counts.failed)>0)parts.push('有发送失败记录，请检查 QQ 授权码及网络');
    const latest=Array.isArray(data.recent)?data.recent[0]:null;
    const names={queued:'等待发送',sending:'正在提交',accepted:'已交给邮件服务器',failed:'发送失败',unknown:'发送结果待确认',expired:'已过期，未发送',cancelled:'已取消'};
    if(latest&&names[latest.state])parts.push('最近一次：'+names[latest.state]);
    if(parts.length)return parts.join(' · ');
    return data.configured?(data.enabled?'尚无发送记录；可点击“发送测试邮件”验证。':'已保存授权；启用并保存后可发送测试邮件。'):'尚未配置。首次启用请填写 QQ 邮箱及 SMTP 授权码。';
  }
  function applyStatus(data,hydrate=false){
    if(!data||typeof data!=='object'||typeof data.enabled!=='boolean'||typeof data.configured!=='boolean')throw new Error('invalid-status');
    status=data;loaded=true;
    if(hydrate&&!dirty){nodes.emailSender.value=data.configured?'':DEFAULT_EMAIL;nodes.emailSender.placeholder=data.configured?'留空沿用已保存的发件邮箱':DEFAULT_EMAIL;nodes.emailEnabled.checked=data.enabled;}
    nodes.emailState.textContent=data.configured?(data.enabled?'已启用':'已配置 · 未启用'):'待配置';
    nodes.emailState.classList.toggle('enabled',data.configured&&data.enabled);
    nodes.emailDelivery.textContent=delivery(data);buttons();
  }
  async function request(path,values){
    const control=new AbortController();let timeout;
    const init={cache:'no-store',signal:control.signal};
    if(values!==undefined){init.method='POST';init.headers={'Content-Type':'application/json','X-Terminal-Request':'1'};init.body=JSON.stringify(values);}
    try {
      return await Promise.race([(async()=>{
        const response=await fetch(path,init);
        if(!response.ok){const error=new Error('http');error.status=response.status;throw error;}
        return await response.json();
      })(),new Promise((_,reject)=>{timeout=setTimeout(()=>{const error=new Error('timeout');error.timedOut=true;reject(error);control.abort();},10000);})]);
    } finally {clearTimeout(timeout);}
  }
  function failure(error,write=false){
    if(error?.timedOut)return write?'本机后台响应超时，操作结果尚未确认；请刷新状态后检查，避免重复发送。':'读取邮件状态超时，请稍后刷新。';
    const known={400:'请检查 QQ 发件邮箱和 SMTP 授权码；更换邮箱时需同时填写新授权码。',403:'本机请求校验未通过，请刷新页面后重试。',409:'请先配置并启用邮件提醒，再发送测试邮件。',429:'操作过于频繁，请稍后重试。',503:'邮件服务暂不可用，请稍后重试。'};
    return known[error?.status]||'邮件操作未完成，请检查设置及本机网络后重试。';
  }
  async function readState(manual=false){
    if(reading||busy||!pageActive)return;
    reading=true;buttons();const generation=stateGeneration;
    try {const data=await request('/api/terminal/email');if(generation!==stateGeneration)return;applyStatus(data,!loaded);if(manual)message('邮件状态已更新。');}
    catch(error){if(generation!==stateGeneration)return;nodes.emailState.textContent='状态暂未更新';nodes.emailState.classList.toggle('enabled',false);if(manual||!loaded)message(failure(error),true);if(!loaded)nodes.emailDelivery.textContent='暂时无法读取邮件设置，请点击“刷新状态”。';}
    finally{reading=false;buttons();}
  }
  form.addEventListener('input',()=>{dirty=true;revision++;message('邮件设置未保存。');});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!loaded)return;
    const email=nodes.emailSender.value.trim(),code=nodes.emailAuthorization.value.trim(),enabled=nodes.emailEnabled.checked;
    if(email&&!/^[^\s@]+@(qq\.com|foxmail\.com)$/i.test(email)){message('请填写 QQ 或 foxmail 发件邮箱。',true);return;}
    if(!status.configured&&(!email||!code)){message('首次配置请填写 QQ 发件邮箱及 SMTP 授权码。',true);return;}
    if(email&&!code){message('填写发件邮箱时，请同时填写授权码；沿用已保存设置可将两项留空。',true);return;}
    if(code&&/\s/.test(code)){message('授权码中不能包含空格或换行，请重新粘贴。',true);return;}
    const values={email,enabled};if(code)values.authorization_code=code;
    const submittedRevision=revision;stateGeneration++;busy=true;buttons();message('正在保存邮件设置…');
    try {
      const pending=request('/api/terminal/email/settings',values);
      nodes.emailAuthorization.value='';
      const data=await pending;
      applyStatus(data);
      if(revision===submittedRevision){dirty=false;applyStatus(data,true);}
      message(dirty?'提交的邮件设置已保存；后续修改仍需保存。':'邮件设置已保存。');
    } catch(error){message(failure(error,true),true);}
    finally{busy=false;buttons();}
  });
  nodes.emailTest.addEventListener('click',async()=>{
    if(busy||!status?.configured||!status?.enabled)return;
    if(dirty||nodes.emailAuthorization.value){message('请先保存当前邮件设置，再发送测试邮件。',true);return;}
    stateGeneration++;busy=true;buttons();message('正在提交测试邮件…');
    try {
      const result=await request('/api/terminal/email/test',{});
      message(result?.state==='unknown'?'测试邮件提交结果待确认，请先查看收件箱，避免重复发送。':result?.state==='accepted'?'测试邮件已交给邮件服务器，请检查收件箱及垃圾邮件。':'测试邮件已加入发送队列，请稍后查看收件箱；入队不代表已送达。');
    } catch(error){message(failure(error,true),true);}
    finally{busy=false;buttons();readState();}
  });
  nodes.emailRefresh.addEventListener('click',()=>readState(true));
  root.addEventListener('pagehide',()=>{pageActive=false;});
  root.addEventListener('pageshow',()=>{pageActive=true;readState();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)readState();});
  setInterval(()=>{if(!document.hidden&&['','#alerts','#price-alert'].includes(root.location.hash))readState();},15000);
  readState();
})(typeof window!=='undefined'?window:globalThis);
