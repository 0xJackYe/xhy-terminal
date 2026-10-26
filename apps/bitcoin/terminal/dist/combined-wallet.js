(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.CombinedWallet = api;
    const start = () => { if (!root.__combinedWalletController) root.__combinedWalletController = api.mount({root,document:root.document}); };
    if (root.document && root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded',start,{once:true});
    else start();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const REFRESH_MS = 30000, REQUEST_TIMEOUT_MS = 12000, MAX_CHART_POINTS = 360;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function decimal(value) {
    if (typeof value !== 'string' || value.length > 180) return null;
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) return null;
    const whole = match[2].replace(/^0+(?=\d)/,''), fraction = match[3] || '';
    return {negative:match[1] === '-' && /[1-9]/.test(whole+fraction),whole,fraction};
  }
  function exact(value, digits = 16, fixed = false) {
    const parts = decimal(value);
    if (!parts || !Number.isInteger(digits) || digits < 0 || digits > 16) return '—';
    let scaled = BigInt(parts.whole + parts.fraction.slice(0,digits).padEnd(digits,'0'));
    if (parts.fraction.length > digits && parts.fraction[digits] >= '5') scaled += 1n;
    const padded = scaled.toString().padStart(digits+1,'0');
    const whole = (digits ? padded.slice(0,-digits) : padded).replace(/\B(?=(\d{3})+(?!\d))/g,',');
    let fraction = digits ? padded.slice(-digits) : '';
    if (!fixed) fraction = fraction.replace(/0+$/,'');
    return (parts.negative && scaled !== 0n ? '-' : '') + whole + (fraction ? '.' + fraction : '');
  }
  function chartNumber(value) { return decimal(value) && finite(Number(value)) ? Number(value) : null; }
  function money(value, mode = 'cny', signed = false) {
    const text = exact(value,2,true);
    if (text === '—') return text;
    const negative = text[0] === '-', magnitude = negative ? text.slice(1) : text;
    const sign = negative ? '−' : signed && /[1-9]/.test(magnitude) ? '+' : '';
    return sign + (mode === 'usd' ? '$' : '¥') + magnitude;
  }
  function timestamp(value) {
    const time = typeof value === 'string' ? Date.parse(value) : finite(value) ? value : NaN;
    return finite(time) && time > 0 && time <= 8640000000000000 ? time : null;
  }
  function beijing(value, includeTime = true) {
    const time = timestamp(value);
    if (time === null) return '—';
    const d = new Date(time + 8*3600000), pad = n => String(n).padStart(2,'0');
    return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate())+(includeTime ? ' '+pad(d.getUTCHours())+':'+pad(d.getUTCMinutes()) : '');
  }
  function formatValue(value, mode) { return mode === 'btc' ? exact(value)+' BTC' : money(value,mode); }
  function points(history, mode = 'cny', range = 'all', now = Date.now()) {
    const map = new Map(), cutoff = range==='today'?Math.floor((now+28800000)/86400000)*86400000-28800000:range === '30' || range === '90' ? now-Number(range)*86400000 : -Infinity;
    for (const point of Array.isArray(history) ? history : []) {
      if (!point || typeof point !== 'object' || Array.isArray(point)) continue;
      const time = timestamp(point.timestamp), value = chartNumber(point[mode]);
      if (time !== null && value !== null && time <= now && time >= cutoff) map.set(time,{time,value,exact:point[mode]});
    }
    const result = [...map.values()].sort((a,b)=>a.time-b.time);
    if (result.length <= MAX_CHART_POINTS) return result;
    return Array.from({length:MAX_CHART_POINTS},(_,i)=>result[Math.round(i*(result.length-1)/(MAX_CHART_POINTS-1))]);
  }
  function geometry(history, mode, range, now) {
    const samples = points(history,mode,range,now);
    if (samples.length < 2) return null;
    const first = samples[0], last = samples[samples.length-1];
    let min = Math.min(...samples.map(p=>p.value)), max = Math.max(...samples.map(p=>p.value));
    const pad = Math.max((max-min)*.12,Math.abs(max)*.000001,mode === 'btc' ? 1e-12 : .01);
    min -= pad; max += pad;
    if (!finite(min) || !finite(max) || max <= min || !finite(last.time-first.time)) return null;
    const data = samples.map(p=>({...p,x:14+(p.time-first.time)/(last.time-first.time)*892,y:190-(p.value-min)/(max-min)*172}));
    if (data.some(p=>!finite(p.x)||!finite(p.y))) return null;
    return {samples:data,first,last,min,max,path:data.map((p,i)=>(i?'L':'M')+p.x.toFixed(2)+','+p.y.toFixed(2)).join(' ')};
  }
  function renderChart(history, mode, range, now) {
    const chart = geometry(history,mode,range,now);
    if (!chart) return '<p class="combined-empty">该范围内暂无两个可核实的合计快照；不会用当前余额回填历史。</p>';
    return '<svg viewBox="0 0 920 214" role="img" aria-label="'+(mode === 'btc'?'BTC 数量':'余额市值')+'合计走势"><path class="combined-axis" d="M14,190H906"/><path class="combined-chart-line" d="'+chart.path+'"/><text x="14" y="210">'+escape(beijing(chart.first.time,false))+'</text><text x="906" y="210" text-anchor="end">'+escape(beijing(chart.last.time,false))+'</text></svg>';
  }
  function goal(value) {
    const parts = decimal(value);
    if (!parts) return null;
    const held = BigInt(parts.whole+parts.fraction.slice(0,16).padEnd(16,'0'))*(parts.negative?-1n:1n), unit = 10000000000000000n;
    const nonnegative = held < 0n ? 0n : held, remaining = unit > held ? unit-held : 0n;
    const toBTC = number => (number/unit).toString()+'.'+(number%unit).toString().padStart(16,'0');
    const stages = [{value:'0.1',units:1000000000000000n},{value:'0.25',units:2500000000000000n},{value:'0.5',units:5000000000000000n},{value:'1',units:unit}];
    const next = stages.find(stage=>stage.units>held);
    return {percent:Number(nonnegative>unit?unit:nonnegative)/1e14,remaining:exact(toBTC(remaining)),next:next?{value:next.value,remaining:exact(toBTC(next.units-held))}:null,
      stages:stages.map(stage=>({value:stage.value,state:held>=stage.units?'achieved':stage===next?'next':'future'}))};
  }
  function renderGoal(value) {
    const data = goal(value);
    if (!data) return '<p class="combined-empty">合计余额完整后显示目标进度。</p>';
    return '<div class="combined-goal-head"><h3>攒到 1 BTC</h3><span>'+data.percent.toFixed(2)+'%</span></div><div class="combined-goal-track" role="progressbar" aria-label="攒到 1 BTC" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+data.percent.toFixed(2)+'"><i style="width:'+data.percent+'%"></i></div><ol class="combined-milestones" aria-label="当前合计 BTC 的里程碑">'+data.stages.map(stage=>'<li data-state="'+stage.state+'"><strong>'+stage.value+' BTC</strong><span>'+(stage.state==='achieved'?'已达成':stage.state==='next'?'下一阶段':'未达成')+'</span></li>').join('')+'</ol><p class="combined-goal-note">'+(data.next?'下一阶段 '+data.next.value+' BTC · 还差 '+data.next.remaining+' BTC':'1 BTC 目标已达成')+'</p>';
  }
  function renderSources(sources) {
    const rows = Array.isArray(sources) ? sources.filter(source=>source && ['offline','okx'].includes(source.id)).slice(0,2) : [];
    return rows.map(source=>'<div class="combined-source"><div><span>'+(source.id==='offline'?'离线钱包 BTC':'欧易 BTC 净持有')+'</span><strong>'+exact(source.btc)+' <small>BTC</small></strong></div><div class="combined-source-state '+(['fresh','stale','unavailable'].includes(source.status)?source.status:'unavailable')+'">'+(source.status==='fresh'?'已更新':source.status==='stale'?'缓存快照':'暂不可用')+'<time>'+escape(beijing(source.updated_at))+' · 北京时间</time></div></div>').join('');
  }
  function health(state, now = Date.now(), failed = false) {
    if (!state) return {kind:failed?'stale':'waiting',text:failed?'暂时无法连接':'正在汇总'};
    const updated = timestamp(state.updated_at);
    const stale = failed || state.stale === true || updated === null || now-updated>90000 || !state.totals || decimal(state.totals.btc)===null;
    return {kind:stale?'stale':'fresh',text:stale?'数据待更新':'已同步 · 只读'};
  }
  function lifetimeAmount(value) {
    const text = exact(value,2,true);
    if (text === '—') return text;
    const negative = text[0] === '-', magnitude = negative ? text.slice(1) : text;
    return (/[1-9]/.test(magnitude) ? negative ? '−' : '+' : '') + magnitude;
  }
  function lifetimePercent(value) {
    const text = lifetimeAmount(value);
    return text === '—' ? text : text + '%';
  }
  function validLifetime(data) {
    return !!(data && typeof data === 'object' && !Array.isArray(data) && ['fresh','stale','loading','unavailable'].includes(data.status) &&
      data.currency === 'USDT' && data.method === 'moving_weighted_average' &&
      (data.metrics && typeof data.metrics === 'object' && !Array.isArray(data.metrics) || ['loading','unavailable'].includes(data.status)));
  }
  function hasLifetimeMetrics(data) {
    return !!(data && data.metrics && ['average_cost','price_usdt','unrealized_net','unrealized_return_pct'].some(key=>decimal(data.metrics[key])));
  }
  function lifetimeDetails(data) {
    const metrics = data && data.metrics || {}, assumptions = data && Array.isArray(data.assumptions) ? data.assumptions.filter(value=>typeof value === 'string'&&!/已实现|累计净盈亏|回本价/.test(value)).slice(0,8).map(value=>value.slice(0,600)) : [];
    if (!assumptions.some(value=>/移动加权平均/.test(value))) assumptions.push('按移动加权平均计算持仓买入均价；新增定投买入后自动更新。');
    if (!assumptions.some(value=>/净到账/.test(value))) assumptions.push('买入按扣除 BTC 手续费后的净到账数量计入成本。');
    if (!assumptions.some(value=>/卖出/.test(value))) assumptions.push('历史卖出仅按当时均价扣减剩余持仓成本。');
    if (!assumptions.some(value=>/Received|收款|零.*成本/.test(value))) assumptions.push('忽略两笔小额 Received 的原始成本，不追加买入成本。');
    if (!assumptions.some(value=>/ETH/.test(value)&&/USDC/.test(value)&&/分钟/.test(value))) assumptions.push('ETH / USDC 成交按成交分钟行情折算为 USDT，结果为估算。');
    const field = (label,value) => '<div><dt>'+label+'</dt><dd>'+escape(exact(value,2,true))+'</dd></div>';
    const date = (label,value) => timestamp(value) === null ? '' : '<span>'+label+' '+escape(beijing(value))+' · 北京时间</span>';
    const known = metrics.known_net_bought_btc || metrics.spot_inventory_btc;
    return '<dl class="combined-lifetime-costs">'+field('持仓成本 · USDT',metrics.remaining_cost)+'</dl>'+ 
      '<dl class="combined-lifetime-buy-prices">'+field('首笔净买入价 · USDT/BTC',metrics.first_net_buy_price)+field('最近净买入价 · USDT/BTC',metrics.last_net_buy_price)+'</dl>'+
      '<p class="combined-lifetime-formula">持仓浮盈 = BTC 净持有量 ×（当前价格 − 持仓平均买入价）；收益率 = 持仓浮盈 ÷ 持仓成本 × 100%。</p>'+
      (decimal(known)?'<p class="combined-lifetime-quantity">成本账本净买入 '+escape(exact(known))+' BTC。</p>':'')+
      '<ul class="combined-lifetime-assumptions">'+assumptions.map(value=>'<li>'+escape(value)+'</li>').join('')+'</ul>'+ 
      '<p class="combined-lifetime-dates">'+date('首笔净买入',data&&(data.first_buy_at||data.first_trade_at))+date('最近净买入',data&&(data.last_buy_at||data.last_trade_at))+date('估值行情',data&&(data.quote_at||data.as_of))+'</p>';
  }
  const MARKUP = '<div class="combined-heading"><div><h2 id="combinedTitle">比特币总持有</h2><span id="combinedState" class="combined-state" role="status">正在汇总</span></div><button id="combinedRefresh" type="button" class="text-button">刷新</button></div>'+
    '<p id="combinedMessage" class="combined-message" role="status" hidden></p><div class="combined-overview"><div class="combined-total"><span>欧易 + 离线钱包</span><strong id="combinedBTC">—</strong><small>BTC</small><p><span id="combinedCNY">—</span><span id="combinedUSD">—</span></p></div><div id="combinedSources" class="combined-sources"></div><div class="combined-pnl"><label for="combinedPnlPeriod">价格变动盈亏</label><select id="combinedPnlPeriod" aria-label="合计盈亏时间范围"><option value="today">今日</option><option value="week">近一周</option><option value="month">近一个月</option><option value="days90">近三个月</option></select><strong id="combinedPnl">—</strong><small id="combinedPnlNote">剔除转账 · 含汇率变动</small><small id="combinedPnlDates"></small></div></div>'+
    '<section id="combinedLifetime" class="combined-lifetime" aria-labelledby="combinedLifetimeTitle"><div class="combined-lifetime-heading"><h3 id="combinedLifetimeTitle">长期持仓浮盈</h3><span class="combined-lifetime-method">USDT · 移动加权平均估算</span><span id="combinedLifetimeState" class="combined-lifetime-state" role="status">正在核算</span></div><dl class="combined-lifetime-metrics"><div><dt>持仓平均买入价</dt><dd id="combinedAverageCost">—</dd></div><div><dt>当前价格</dt><dd id="combinedSpotPrice">—</dd></div><div class="combined-lifetime-profit"><dt>持仓浮盈</dt><dd id="combinedUnrealizedNet">—</dd></div><div><dt>收益率</dt><dd id="combinedUnrealizedReturn">—</dd></div></dl><details class="combined-lifetime-details"><summary><span>计算说明</span><span id="combinedLifetimeCoverage"></span></summary><div id="combinedLifetimeDetails"></div></details></section>'+
    '<div id="combinedGoal" class="combined-goal"></div><div class="combined-chart-head"><div><h3>合计余额走势</h3><div class="combined-day-pnl"><span>今日当前盈亏</span><strong id="combinedDayPnl">—</strong><small id="combinedDayPnlAt"></small></div></div><div class="combined-controls"><div role="group" aria-label="合计曲线计价"><button id="combinedModeCny" type="button" aria-pressed="true">人民币 CNY</button><button id="combinedModeUsd" type="button" aria-pressed="false">美元 USD</button><button id="combinedModeBtc" type="button" aria-pressed="false">比特币 BTC</button></div><div role="group" aria-label="合计曲线时间范围"><button id="combinedRangeToday" type="button" aria-pressed="false">今日</button><button id="combinedRange30" type="button" aria-pressed="false">30D</button><button id="combinedRange90" type="button" aria-pressed="false">90D</button><button id="combinedRangeAll" type="button" aria-pressed="true">全部</button></div></div></div>'+
    '<div id="combinedChart" class="combined-chart" tabindex="0" aria-label="合计走势，可用左右方向键查看快照"></div><p id="combinedChartReadout" class="combined-readout" aria-live="polite"></p><div class="combined-footer"><span id="combinedCoverage">等待可核实历史</span><span id="combinedUpdated">北京时间</span></div>';
  function mount(options = {}) {
    const root = options.root || globalThis, document = options.document || root.document, panel = document && document.getElementById('combinedWalletPanel');
    if (!panel) return null;
    if (panel.__combinedController) return panel.__combinedController;
    const fetcher = options.fetch || root.fetch.bind(root), setTimer = options.setTimeout || root.setTimeout.bind(root), clearTimer = options.clearTimeout || root.clearTimeout.bind(root), now = options.now || Date.now;
    const node = id=>document.getElementById(id);
    panel.classList.add('combined-wallet','card');panel.setAttribute('aria-labelledby','combinedTitle');panel.innerHTML=MARKUP;
    let state=null,lifetime=null,lifetimeFailed=false,timer=null,read=null,disposed=false,pageActive=true,failed=false,mode='cny',range='all',selected=-1,sequence=0;
    function active(){const page=node('walletPage');return !disposed&&pageActive&&!document.hidden&&(!page||!page.hidden);}
    function cancelTimer(){if(timer!==null)clearTimer(timer);timer=null;}
    function schedule(){cancelTimer();if(active())timer=setTimer(()=>{timer=null;load();},REFRESH_MS);}
    function drawReadout(){
      const data=points(state&&state.history,mode,range,now());
      if(!data.length){node('combinedChartReadout').textContent='';return;}
      selected=selected<0?data.length-1:Math.min(selected,data.length-1);
      const point=data[selected];node('combinedChartReadout').textContent=beijing(point.time)+' · '+formatValue(point.exact,mode)+' · 北京时间';
    }
    function renderPnl(){
      const today=state&&state.pnl&&state.pnl.today,unit=mode==='usd'?'usd':'cny',daily=today&&today[unit],dailyNumber=chartNumber(daily);
      node('combinedDayPnl').textContent=money(daily,unit,true);
      node('combinedDayPnl').className=dailyNumber===null?'':dailyNumber<0?'negative':'positive';
      node('combinedDayPnlAt').textContent=today&&today.reason?today.reason:today&&timestamp(today.end_at)!==null?'截至 '+beijing(today.end_at)+' · 北京时间':'';
      const period=node('combinedPnlPeriod').value||'today',pnl=state&&state.pnl&&state.pnl[period];
      const raw=pnl&&pnl[mode],number=chartNumber(raw);
      node('combinedPnl').textContent=mode==='btc'?'—':money(raw,mode,true);
      node('combinedPnl').className=mode==='btc'||number===null?'':number<0?'negative':'positive';
      node('combinedPnlNote').textContent=mode==='btc'?'价差盈亏不以 BTC 计价':pnl&&pnl.reason||'剔除转账 · 含汇率变动';
      node('combinedPnlDates').textContent=pnl&&timestamp(pnl.start_at)!==null&&timestamp(pnl.end_at)!==null?beijing(pnl.start_at)+' — '+beijing(pnl.end_at)+' · 北京时间':'';
    }
    function renderLifetime(){
      const metrics=lifetime&&lifetime.metrics||{},kind=failed||lifetimeFailed?(hasLifetimeMetrics(lifetime)?'stale':'unavailable'):lifetime?lifetime.status:'loading';
      node('combinedLifetimeState').textContent={fresh:'已核对 · 估算',stale:'缓存结果 · 待更新',loading:'正在核算',unavailable:'暂不可用'}[kind];
      node('combinedLifetimeState').className='combined-lifetime-state '+kind;
      for(const[id,key,format]of[['combinedAverageCost','average_cost','price'],['combinedSpotPrice','price_usdt','price'],['combinedUnrealizedNet','unrealized_net','amount'],['combinedUnrealizedReturn','unrealized_return_pct','percent']]){
        const value=node(id),number=chartNumber(metrics[key]);value.textContent=format==='price'?exact(metrics[key],2,true):format==='percent'?lifetimePercent(metrics[key]):lifetimeAmount(metrics[key]);
        value.className=format==='price'||number===null||number===0?'':number<0?'negative':'positive';
      }
      const count=lifetime&&lifetime.buy_count,first=lifetime&&(lifetime.first_buy_at||lifetime.first_trade_at),last=lifetime&&(lifetime.last_buy_at||lifetime.last_trade_at);
      node('combinedLifetimeCoverage').textContent=Number.isSafeInteger(count)&&count>=0?count.toLocaleString('zh-CN')+' 笔净买入'+(timestamp(first)!==null?' · '+beijing(first,false)+(timestamp(last)!==null?' 至 '+beijing(last,false):' 起'):''):kind==='loading'?'读取净买入账本中':kind==='unavailable'?'历史核算暂不可用，稍后自动重试':'';
      node('combinedLifetimeDetails').innerHTML=lifetimeDetails(lifetime);
    }
    function render(){
      const status=health(state,now(),failed);node('combinedState').textContent=status.text;node('combinedState').className='combined-state '+status.kind;
      const total=state&&state.totals||{};
      node('combinedBTC').textContent=exact(total.btc);node('combinedCNY').textContent=money(total.cny,'cny');node('combinedUSD').textContent=money(total.usd,'usd');
      node('combinedSources').innerHTML=renderSources(state&&state.sources);
      const message=failed?(state?'刷新失败，保留上次合计快照。':'暂时无法连接本机后端，稍后自动重试。'):state&&decimal(total.btc)===null?'来源尚未完整读取，暂不展示合计。':status.kind==='stale'?'含缓存或未更新的来源，请留意各来源时间。':'';
      node('combinedMessage').textContent=message;node('combinedMessage').hidden=!message;
      node('combinedGoal').innerHTML=renderGoal(total.btc);
      for(const [name,value]of[['Cny','cny'],['Usd','usd'],['Btc','btc']])node('combinedMode'+name).setAttribute('aria-pressed',String(mode===value));
      for(const [name,value]of[['Today','today'],['30','30'],['90','90'],['All','all']])node('combinedRange'+name).setAttribute('aria-pressed',String(range===value));
      node('combinedChart').innerHTML=renderChart(state&&state.history,mode,range,now());drawReadout();renderPnl();renderLifetime();
      const coverage=state&&state.coverage;
      node('combinedCoverage').textContent=coverage&&typeof coverage.note==='string'?coverage.note:'仅展示可核实的合计历史；余额变化不等于收益。';
      node('combinedUpdated').textContent=state&&timestamp(state.updated_at)!==null?'合计快照 '+beijing(state.updated_at)+' · 北京时间':'等待首个完整快照';
      node('combinedRefresh').disabled=!!read;
    }
    function valid(data){return data&&typeof data==='object'&&!Array.isArray(data)&&data.ok===true&&data.totals&&typeof data.totals==='object'&&Array.isArray(data.sources)&&Array.isArray(data.history)&&data.pnl&&typeof data.pnl==='object';}
    function acceptLifetime(data){
      const sameConnection=typeof data.connection_id==='string'&&data.connection_id.length>0&&lifetime&&lifetime.connection_id===data.connection_id;
      lifetime=sameConnection&&hasLifetimeMetrics(lifetime)&&!hasLifetimeMetrics(data)&&data.status!=='fresh'?{...lifetime,status:'stale'}:data;
      lifetimeFailed=false;
    }
    async function load(){
      if(!active()||read)return;
      cancelTimer();const token={controller:new root.AbortController(),sequence:++sequence};read=token;node('combinedRefresh').disabled=true;
      const timeout=setTimer(()=>token.controller.abort(),REQUEST_TIMEOUT_MS);
      try{
        const response=await fetcher('/api/wallet/combined',{method:'GET',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal:token.controller.signal});
        const data=await response.json();if(!response.ok||!valid(data))throw new Error('invalid-status');
        if(!disposed&&token.sequence===sequence){
          state=data;failed=false;selected=-1;
          if(validLifetime(data.lifetime_pnl))acceptLifetime(data.lifetime_pnl);
          render();
          if(!validLifetime(data.lifetime_pnl)){
            try{
              const pnlResponse=await fetcher('/api/wallet/btc-pnl',{method:'GET',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal:token.controller.signal});
              const pnlData=await pnlResponse.json();if(!pnlResponse.ok||!validLifetime(pnlData))throw new Error('invalid-pnl-status');
              if(!disposed&&token.sequence===sequence){acceptLifetime(pnlData);renderLifetime();}
            }catch(_){if(!disposed&&token.sequence===sequence){lifetimeFailed=true;renderLifetime();}}
          }
        }
      }catch(_){if(!disposed&&token.sequence===sequence){failed=true;render();}}
      finally{clearTimer(timeout);if(read===token)read=null;if(!disposed)node('combinedRefresh').disabled=false;schedule();}
    }
    function visibility(){if(active())load();else cancelTimer();}
    function pageHide(){pageActive=false;cancelTimer();}
    function pageShow(){pageActive=true;visibility();}
    function pickMode(value){mode=value;selected=-1;render();}
    function pickRange(value){range=value;selected=-1;render();}
    function keyboard(event){
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      const samples=points(state&&state.history,mode,range,now());if(!samples.length)return;
      event.preventDefault();selected=selected<0?samples.length-1:selected;
      selected=event.key==='Home'?0:event.key==='End'?samples.length-1:Math.max(0,Math.min(samples.length-1,selected+(event.key==='ArrowLeft'?-1:1)));drawReadout();
    }
    function pointer(event){
      const samples=points(state&&state.history,mode,range,now()),chart=node('combinedChart');
      if(!samples.length||!finite(event.clientX)||typeof chart.getBoundingClientRect!=='function')return;
      const rect=chart.getBoundingClientRect();if(!finite(rect.width)||rect.width<=0)return;
      const fraction=Math.max(0,Math.min(1,((event.clientX-rect.left)/rect.width*920-14)/892));
      const target=samples[0].time+(samples[samples.length-1].time-samples[0].time)*fraction;
      let closest=0;for(let i=1;i<samples.length;i++)if(Math.abs(samples[i].time-target)<Math.abs(samples[closest].time-target))closest=i;
      selected=closest;drawReadout();
    }
    function pointerLeave(){selected=-1;drawReadout();}
    const events=[[node('combinedRefresh'),'click',load],[node('combinedPnlPeriod'),'change',renderPnl],[node('combinedChart'),'keydown',keyboard],[node('combinedChart'),'pointermove',pointer],[node('combinedChart'),'pointerleave',pointerLeave],
      [document,'visibilitychange',visibility],[root,'hashchange',visibility],[root,'pagehide',pageHide],[root,'pageshow',pageShow]];
    for(const [name,value]of[['Cny','cny'],['Usd','usd'],['Btc','btc']])events.push([node('combinedMode'+name),'click',()=>pickMode(value)]);
    for(const [name,value]of[['Today','today'],['30','30'],['90','90'],['All','all']])events.push([node('combinedRange'+name),'click',()=>pickRange(value)]);
    for(const[target,event,handler]of events)target.addEventListener(event,handler);
    function destroy(){disposed=true;sequence++;cancelTimer();if(read)read.controller.abort();for(const[target,event,handler]of events)target.removeEventListener(event,handler);panel.__combinedController=null;}
    const controller={refresh:load,destroy};panel.__combinedController=controller;render();if(active())load();return controller;
  }
  return {REFRESH_MS,REQUEST_TIMEOUT_MS,MAX_CHART_POINTS,decimal,exact,chartNumber,money,timestamp,beijing,points,geometry,renderChart,goal,renderGoal,renderSources,health,lifetimeAmount,lifetimePercent,validLifetime,lifetimeDetails,mount};
});
