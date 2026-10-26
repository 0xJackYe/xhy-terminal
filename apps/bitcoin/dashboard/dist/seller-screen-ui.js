/* Public quotes and manual assumptions only. This screen never submits orders. */
(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.SellerScreenUI=api;
})(typeof window!=='undefined'?window:globalThis,function(root){
  'use strict';
  const DEFAULTS=Object.freeze({side:'PUT',mode:'balanced',balance:1000,quantity:.1,minDays:10,maxDays:20,minOtmPct:20,maxOtmPct:25,maxSpreadPct:50,limit:5});
  const INPUTS={balance:'ssBalance',quantity:'ssQuantity',minDays:'ssMinDays',maxDays:'ssMaxDays',minOtmPct:'ssMinOtm',maxOtmPct:'ssMaxOtm',maxSpreadPct:'ssSpread'};
  const MODES={risk:{label:'低风险优先',note:'按最大不利压力亏损从低到高；仅为候选间相对排序。'},balanced:{label:'风险收益平衡',note:'排序：净权利金/天 ÷（最大压力亏损＋净权利金），从高到低。'},premium:{label:'权利金优先',note:'排序：净权利金/天，从高到低，不做风险调整。'}};
  const CATEGORY={freshness:'行情同步',depth:'深度不足',spread:'价差超限',balance:'余额不足',filter:'不符合筛选',metadata:'合约资料待核验',invalid:'计算条件不足'};
  const STATES={normal:'未触及预警条件','margin-call':'情景触及预警线',liquidation:'情景触及强平线',settled:'到期现金结算',unknown:'维持率无法判断'};
  const number=value=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'&&value.trim()!==''&&Number.isFinite(Number(value))?Number(value):null;
  const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const formatter=new Intl.NumberFormat('en-US',{maximumFractionDigits:2});
  const preciseFormatter=new Intl.NumberFormat('en-US',{maximumFractionDigits:8});
  const quantityFormatter=new Intl.NumberFormat('en-US',{maximumFractionDigits:12});
  const amount=value=>{const n=number(value);return n===null?'—':n!==0&&Math.abs(n)<1e-8?n.toExponential(2):Math.abs(n)<.01?preciseFormatter.format(n):formatter.format(n);};
  const quantityAmount=value=>number(value)===null?'—':quantityFormatter.format(number(value));
  const signed=value=>number(value)===null?'—':(number(value)>0?'+':'')+amount(value);
  const percent=value=>number(value)===null?'—':amount(number(value))+'%';
  const ratio=value=>number(value)===null?'—':percent(number(value)*100);
  function modeNote(mode,result){
    let note=MODES[mode]?.note??'';
    const comparison=result?.modeComparison;
    if(!result?.candidates?.length||!comparison||!MODES[comparison.mode])return note;
    if(comparison.sameOrder===true)note+=` 本次与${MODES[comparison.mode].label}排序一致。`;
    else if(comparison.sameContracts===true)note+=' 当前候选相同，排序不同。';
    return note;
  }
  const dateFormatter=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  const date=value=>number(value)!==null&&Number.isFinite(new Date(number(value)).getTime())?dateFormatter.format(new Date(number(value))):'时间未知';
  function worstPressure(candidate){return (candidate.adverseStress??[]).reduce((worst,point)=>!worst||(number(point.marginRatio)??-1)>(number(worst.marginRatio)??-1)?point:worst,null);}
  function parseSettings(raw={},side=raw.side??'PUT',mode=raw.mode??'balanced'){
    const settings={...DEFAULTS,side,mode},errors=[],invalidFields=[];
    const invalid=(key,message)=>{errors.push(message);invalidFields.push(key);};
    if(!['PUT','CALL'].includes(side))errors.push('请选择 Put 或 Call。');
    if(!Object.hasOwn(MODES,mode))errors.push('请选择有效的比较模式。');
    for(const key of Object.keys(INPUTS)){
      settings[key]=raw[key]===undefined?DEFAULTS[key]:number(raw[key]);
      if(settings[key]===null)invalid(key,({balance:'试算余额',quantity:'数量',minDays:'最少天数',maxDays:'最多天数',minOtmPct:'最少价外比例',maxOtmPct:'最多价外比例',maxSpreadPct:'价差上限'})[key]+'需要填写有效数字。');
    }
    if(settings.balance!==null&&!(settings.balance>0&&settings.balance<=1e12))invalid('balance','试算余额需大于 0 且不超过 1 万亿 USDT。');
    if(settings.quantity!==null&&!(settings.quantity>0))invalid('quantity','数量需要大于 0 张。');
    if(settings.minDays!==null&&settings.maxDays!==null&&!(settings.minDays>=0&&settings.maxDays>0&&settings.maxDays<=730&&settings.minDays<=settings.maxDays))invalid('minDays','期限需在 0–730 天内，且最少不大于最多。');
    if(settings.minOtmPct!==null&&settings.maxOtmPct!==null&&!(settings.minOtmPct>=0&&settings.maxOtmPct>=settings.minOtmPct&&(side==='CALL'||settings.maxOtmPct<100)))invalid('minOtmPct',side==='CALL'?'价外比例需非负，且最少不大于最多。':'Put 价外比例需在 0%–100% 之间，且最少不大于最多。');
    if(settings.maxSpreadPct!==null&&!(settings.maxSpreadPct>=0&&settings.maxSpreadPct<=10000))invalid('maxSpreadPct','价差上限需在 0%–10000% 之间。');
    return {settings,errors,invalidFields};
  }
  function emptyState(result={},unavailable=false){
    if(unavailable)return {title:'行情正在同步',note:'恢复有效行情后会自动重算，当前不保留过期候选。',reasons:[]};
    const counts=result.summary?.reasonCounts??{};
    const active=Object.keys(CATEGORY).filter(key=>key!=='filter'&&Number(counts[key])>0);
    const reasons=Object.entries(CATEGORY).filter(([key])=>(key!=='filter'||!active.length)&&Number(counts[key])>0).map(([key,label])=>`${label} ${counts[key]} 个`);
    if(result.issues?.length)return {title:'暂时没有可比较候选',note:result.issues.slice(0,2).map(item=>typeof item==='string'?item:item?.message??'等待有效行情').join('；'),reasons};
    if(active.length===1&&active[0]==='freshness')return {title:'候选行情正在同步',note:'当前合约没有通过时效校验。有效报价恢复后会自动显示。',reasons};
    if(active.length===1&&active[0]==='balance')return {title:'当前余额不足以试算这个数量',note:'可以减少数量，或调整手工试算余额；系统不会自动加杠杆。',reasons};
    if(active.length===1&&active[0]==='depth')return {title:'当前买一深度不足',note:'没有足够深度承接所填卖出数量；可以减少数量或等待盘口更新。',reasons};
    if(active.length===1&&active[0]==='spread')return {title:'当前价差超过上限',note:`${counts.spread} 个匹配合约价差超过 ${amount(result.settings?.maxSpreadPct??50)}% 上限。等待报价改善，或检查高级筛选。`,reasons};
    return {title:'当前筛选下没有可比较候选',note:'请检查期限、价外比例和数量，或等待新报价。',reasons};
  }
  function watchCandidates(snapshot,settings,candidates=[],now=Date.now()){
    const spot=number(snapshot?.btc_index_price),clock=now+(number(snapshot?.exchange_clock_offset_ms)??0);
    if(!(spot>0)||!Array.isArray(snapshot.options))return candidates;
    const matches=snapshot.options.filter(row=>{
      if(row.side!==settings.side)return false;
      const expiry=number(row.expiry_ms)??Date.parse(row.expiry_beijing),days=(expiry-clock)/86400000,strike=number(row.strike_price);
      const otm=row.side==='CALL'?(strike/spot-1)*100:(1-strike/spot)*100;
      return days>0&&days>=settings.minDays-1e-8&&days<=settings.maxDays+1e-8&&otm>=settings.minOtmPct-1e-8&&otm<=settings.maxOtmPct+1e-8;
    });
    const seen=new Set();return [...candidates,...matches].filter(row=>{if(typeof row.symbol!=='string'||seen.has(row.symbol))return false;seen.add(row.symbol);return true;}).slice(0,8);
  }
  function pressureMarkup(candidate){
    const points=Array.isArray(candidate.adverseStress)?candidate.adverseStress:[],primary=candidate.primaryStress??{};
    const maximum=candidate.lossUnbounded?'无限':amount(candidate.maxExpiryLoss)+' USDT';
    const primaryState=STATES[primary.state]??STATES.unknown;
    return `<section class="ss-risk-detail" id="ss-risk-${escape(candidate.symbol)}" aria-label="${escape(candidate.symbol)} 量化风险"><div class="ss-risk-heading"><h3>不利方向压力情景</h3><span>1 天后（先到期则按结算）· IV +20 个百分点（最高 500%）</span></div><div class="ss-risk-facts"><div><span>到期盈亏平衡</span><strong>${amount(candidate.breakEven)} <small>USDT</small></strong></div><div><span>到期最大亏损</span><strong>${maximum}</strong></div><div><span>当前 MM / 调整后权益</span><strong>${ratio(candidate.marginRatio)}</strong></div></div><div class="ss-scenarios">${points.map(point=>`<div class="ss-scenario${point.state==='liquidation'||point.state==='margin-call'?' ss-scenario-alert':''}"><h4>BTC ${number(point.movePct)>0?'+':''}${ratio(point.movePct)}</h4><strong class="${number(point.pnl)<0?'ss-negative':'ss-positive'}">${signed(point.pnl)} <small>USDT</small></strong><p>MM / 调整后权益 ${ratio(point.marginRatio)}</p><span>${escape(STATES[point.state]??STATES.unknown)}</span></div>`).join('')}</div><p class="ss-risk-line${primary.state==='liquidation'||primary.state==='margin-call'?' ss-risk-alert':''}">20% 不利情景：${escape(primaryState)} · 维持率 ${ratio(primary.marginRatio)}${number(primary.maintenanceMargin)!==null?' · MM '+amount(primary.maintenanceMargin)+' USDT':''}</p><p class="ss-risk-note">${candidate.lossUnbounded?'裸卖 Call 亏损无上限；保证金与所填余额不构成损失上限。':'保证金可开仓不代表能承受最大亏损，情景触线后不保证可持有到期。'} 情景是假设估值，不能当作发生概率、可成交回购价或精确强平价。</p></section>`;
  }
  let initialized=false,hooks=null,container=null,side='PUT',mode='balanced',selected=null,scheduled=false,queueVersion=0,refreshing=false,lastHtml='',markWatch=null,watchEntries=[];
  const $=id=>document.getElementById(id);
  function text(id,value){const node=$(id);if(node&&node.textContent!==String(value))node.textContent=String(value);}
  function skeleton(){return `<div class="ss-page"><header class="ss-header"><div><span id="ssDatasetBadge" class="ss-fixture" hidden></span><span class="ss-eyebrow">BTC OPTIONS · 手工试算</span><h1>卖方候选</h1><p>相同数量，先看压力损失，再比较权利金。</p></div><button id="ssAdvancedButton" class="ss-advanced-link" type="button">完整期权链 <span aria-hidden="true">↗</span></button></header><div class="ss-market"><div><span>BTC 指数</span><strong id="ssSpot">—</strong><small>USDT</small></div><div class="ss-feed"><span id="ssStatus" role="status">等待有效行情</span><button id="ssRefreshButton" type="button">刷新</button></div></div><section class="ss-settings" aria-label="比较条件"><div class="ss-choice-row"><div class="ss-side" role="group" aria-label="卖出方向"><button type="button" data-ss-side="PUT" aria-pressed="true">卖 Put</button><button type="button" data-ss-side="CALL" aria-pressed="false">卖 Call</button></div><div class="ss-modes" role="group" aria-label="候选比较模式">${Object.entries(MODES).map(([key,value])=>`<button type="button" data-ss-mode="${key}" aria-pressed="${key==='balanced'}">${value.label}</button>`).join('')}</div></div><p id="ssModeNote" class="ss-mode-note"></p><form id="ssForm" novalidate><div class="ss-inputs"><label>试算余额 <span>USDT</span><input id="ssBalance" type="number" min="0" step="any" inputmode="decimal" value="1000" aria-describedby="ssInputError"></label><label>卖出数量 <span>张</span><input id="ssQuantity" type="number" min="0" step="any" inputmode="decimal" value="0.1" aria-describedby="ssInputError"></label><details id="ssAdvancedFilters" class="ss-filter-details"><summary>高级筛选 <span id="ssFilterSummary">10–20 天 · 价外 20%–25%</span></summary><div class="ss-filter-fields"><label>期限最少（天）<input id="ssMinDays" type="number" min="0" max="730" step="any" value="10" inputmode="decimal"></label><label>最多（天）<input id="ssMaxDays" type="number" min="0" max="730" step="any" value="20" inputmode="decimal"></label><label>价外最少（%）<input id="ssMinOtm" type="number" min="0" step="any" value="20" inputmode="decimal"></label><label>最多（%）<input id="ssMaxOtm" type="number" min="0" step="any" value="25" inputmode="decimal"></label><label>价差上限（%）<input id="ssSpread" type="number" min="0" max="10000" step="any" value="50" inputmode="decimal"></label></div><p>价差 =（卖一 − 买一）÷ 买一。所有候选使用同一个所填数量。</p></details></div><p id="ssInputError" class="ss-input-error" role="status" hidden></p></form><p id="ssSideNote" class="ss-side-note"></p></section><section class="ss-results" aria-labelledby="ssCandidatesTitle"><div class="ss-results-heading"><h2 id="ssCandidatesTitle">可比较候选 <span id="ssCount">0</span></h2><span id="ssScope">最多显示 5 个</span></div><div class="ss-list-head" aria-hidden="true"><span>合约 / 到期</span><span>净权利金</span><span>下单 IM</span><span id="ssStressLabel" title="1天后（先到期则按结算）· IV+20个百分点（最高500%）">下跌 20% 压力亏损</span><span>风险</span></div><div id="ssCandidates" class="ss-candidates" role="list"></div><div id="ssEmpty" class="ss-empty" role="status"></div></section><footer class="ss-footer"><p>候选不等于交易推荐。公开行情、手工余额、空仓单笔试算；未读取已有仓位。净权利金/天仅为到期前简单折算，并非每日到账。</p><details class="ss-method"><summary>排序与计算口径</summary><p id="ssFormula"></p><p>净权利金已扣假设开仓费。压力情景包含理论回购或到期结算费用，费用与实际账户可能不同。维持率 = MM ÷ 调整后权益，触线情景不能当成可继续持有。</p><p><a href="https://www.binance.com/en/support/faq/detail/1ceb77f837344e3085ecf98d9a6a8097" target="_blank" rel="noopener noreferrer">币安公开期权保证金说明</a></p></details></footer></div>`;}
  function rawSettings(){return Object.fromEntries(Object.entries(INPUTS).map(([key,id])=>[key,$(id).value]));}
  function showRows(rows){
    if(!rows.some(candidate=>candidate.symbol===selected))selected=null;
    const html=rows.map(candidate=>{const point=candidate.primaryStress??{},worst=worstPressure(candidate),alertPoint=point.state==='liquidation'||point.state==='margin-call'?point:worst&&(worst.state==='liquidation'||worst.state==='margin-call')?worst:null;
      return `<article class="ss-candidate${candidate.symbol===selected?' ss-selected':''}" role="listitem"><div class="ss-contract"><strong>${escape(candidate.symbol)}</strong><span>${date(candidate.expiryMs)}（北京） · ${amount(candidate.days)} 天</span><small>行权价 ${amount(candidate.strike)} · 价外 ${percent(candidate.otmPct)}</small></div><div class="ss-cell"><span class="ss-mobile-label">净权利金</span><strong>${amount(candidate.netPremium)} <small>USDT</small></strong><span>${amount(candidate.dailyPremium)} /天（折算）</span></div><div class="ss-cell"><span class="ss-mobile-label">下单 IM</span><strong>${amount(candidate.orderMargin)} <small>USDT</small></strong><span>数量 ${quantityAmount(candidate.quantity)} 张</span></div><div class="ss-cell ss-loss"><span class="ss-mobile-label">${side==='CALL'?'上涨':'下跌'} 20% 压力亏损</span><strong>${amount(point.loss)} <small>USDT</small></strong><span>占余额 ${percent(point.lossPct)} · 20% 情景维持率 ${ratio(point.marginRatio)}</span>${alertPoint?`<b class="ss-pressure-alert">${ratio(Math.abs(alertPoint.movePct))} ${escape(STATES[alertPoint.state])}</b>`:''}</div><div class="ss-risk-action"><button type="button" data-ss-risk="${escape(candidate.symbol)}" aria-expanded="${candidate.symbol===selected}" aria-controls="ss-risk-${escape(candidate.symbol)}">${candidate.symbol===selected?'收起风险':'查看风险'} <span aria-hidden="true">${candidate.symbol===selected?'−':'+'}</span></button></div>${candidate.symbol===selected?pressureMarkup(candidate):''}</article>`;
    }).join('');
    if(html!==lastHtml){const focused=document.activeElement?.dataset?.ssRisk;$('ssCandidates').innerHTML=html;lastHtml=html;if(focused)[...$('ssCandidates').querySelectorAll('[data-ss-risk]')].find(button=>button.dataset.ssRisk===focused)?.focus({preventScroll:true});}
  }
  function showEmpty(value){const target=$('ssEmpty');target.hidden=!value;if(value)target.innerHTML=`<strong>${escape(value.title)}</strong><p>${escape(value.note)}</p>${value.reasons.length?`<div class="ss-empty-reasons">${value.reasons.slice(0,4).map(reason=>`<span>${escape(reason)}</span>`).join('')}</div>`:''}<button type="button" data-ss-reset="true">恢复默认筛选</button>`;}
  function refresh(){
    scheduled=false;queueVersion++;
    if(!initialized||container.hidden||document.hidden)return;
    const parsed=parseSettings(rawSettings(),side,mode);
    for(const [key,id]of Object.entries(INPUTS))$(id).setAttribute('aria-invalid',String(parsed.invalidFields.includes(key)));
    $('ssInputError').hidden=!parsed.errors.length;text('ssInputError',parsed.errors.slice(0,2).join(' '));
    text('ssModeNote',MODES[mode].note);text('ssStressLabel',(side==='CALL'?'上涨':'下跌')+' 20% 压力亏损');
    text('ssSideNote',side==='CALL'?'裸卖 Call 最大亏损无上限；保证金与试算余额不构成赔付上限。':'卖 Put 的最大到期赔付由行权价决定；保证金可开仓不代表能承担该损失。');
    $('ssSideNote').hidden=side!=='CALL';
    text('ssFilterSummary',parsed.invalidFields.some(key=>['minDays','maxDays','minOtmPct','maxOtmPct','maxSpreadPct'].includes(key))?'请检查筛选条件':`${amount(parsed.settings.minDays)}–${amount(parsed.settings.maxDays)} 天 · 价外 ${percent(parsed.settings.minOtmPct)}–${percent(parsed.settings.maxOtmPct)}`);
    for(const button of container.querySelectorAll('[data-ss-side]'))button.setAttribute('aria-pressed',String(button.dataset.ssSide===side));
    for(const button of container.querySelectorAll('[data-ss-mode]'))button.setAttribute('aria-pressed',String(button.dataset.ssMode===mode));
    let result=null,snapshot=null,unavailable=false,error=null;watchEntries=[];
    if(!parsed.errors.length){
      try{snapshot=hooks.getSnapshot();unavailable=Boolean(hooks.getUnavailable?.());if(!unavailable){if(typeof root.SellerScreenEngine?.evaluate!=='function')error='计算模块尚未就绪，请刷新页面。';else result=root.SellerScreenEngine.evaluate(snapshot,parsed.settings,Date.now());}}
      catch{error='试算暂不可用，请稍后刷新。';}
    }
    const rows=!error&&!unavailable&&!parsed.errors.length&&Array.isArray(result?.candidates)?result.candidates.slice(0,5):[];
    text('ssModeNote',modeNote(mode,result));
    showRows(rows);watchEntries=watchCandidates(snapshot,parsed.settings,rows);markWatch?.poll();
    const fixture=snapshot?.fixture===true||Boolean(snapshot?.fixture_label);
    $('ssDatasetBadge').hidden=!fixture;text('ssDatasetBadge','模拟数据验收 · 非实时行情');
    text('ssCount',rows.length);text('ssSpot',!unavailable&&!error&&!(result?.issues?.length)&&number(result?.spot)>0?amount(result.spot):'—');
    text('ssScope',rows.length?`显示 ${rows.length} / ${amount(result?.summary?.eligibleCount??rows.length)} 个 · 1天后/先到期结算 · IV+20个百分点`:'最多显示 5 个');
    text('ssStatus',fixture?'模拟数据验收 · 非实时行情':rows.length?'已按字段核验 · 自动更新':unavailable?'行情同步中':parsed.errors.length?'等待有效输入':error?'等待计算恢复':'暂无可比较候选');
    text('ssFormula',typeof result?.formula==='string'?result.formula:MODES[mode].note);
    showEmpty(rows.length?null:parsed.errors.length?{title:'请完成试算条件',note:parsed.errors.slice(0,2).join(' '),reasons:[]}:error?{title:'暂时无法计算',note:error,reasons:[]}:emptyState(result??{},unavailable));
  }
  function onSnapshot(){if(!initialized||container.hidden||document.hidden||scheduled)return;scheduled=true;const version=++queueVersion;Promise.resolve().then(()=>{if(version===queueVersion)refresh();});}
  function resetFilters(){for(const key of ['minDays','maxDays','minOtmPct','maxOtmPct','maxSpreadPct'])$(INPUTS[key]).value=DEFAULTS[key];refresh();}
  function initialize(options){
    if(initialized||typeof document==='undefined'||typeof options?.getSnapshot!=='function')return;
    container=$('sellerScreen');if(!container)return;initialized=true;hooks=options;container.innerHTML=skeleton();
    if(typeof root.SellPutUI?.createMarkWatch==='function'&&typeof root.fetch==='function')markWatch=root.SellPutUI.createMarkWatch(()=>({active:!container.hidden,hidden:document.hidden,paused:false,selectedSymbol:selected,entries:watchEntries}),(url,request)=>root.fetch(url,request));
    container.addEventListener('click',event=>{
      const button=event.target.closest?.('button');if(!button||!container.contains(button))return;
      if(button.dataset.ssSide&&['PUT','CALL'].includes(button.dataset.ssSide)){side=button.dataset.ssSide;selected=null;refresh();}
      else if(button.dataset.ssMode&&Object.hasOwn(MODES,button.dataset.ssMode)){mode=button.dataset.ssMode;refresh();}
      else if(button.dataset.ssRisk){selected=selected===button.dataset.ssRisk?null:button.dataset.ssRisk;refresh();}
      else if(button.dataset.ssReset)resetFilters();
    });
    $('ssForm').addEventListener('submit',event=>{event.preventDefault();refresh();});$('ssForm').addEventListener('input',refresh);$('ssForm').addEventListener('change',refresh);
    $('ssAdvancedButton').addEventListener('click',()=>hooks.onAdvanced?.());
    $('ssRefreshButton').addEventListener('click',async()=>{if(refreshing)return;refreshing=true;$('ssRefreshButton').disabled=true;try{await hooks.onRefresh?.();}catch{}finally{refreshing=false;$('ssRefreshButton').disabled=false;refresh();}});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});refresh();
  }
  return {initialize,onSnapshot,refresh,parseSettings,emptyState,pressureMarkup,watchCandidates,modeNote,DEFAULTS};
});
