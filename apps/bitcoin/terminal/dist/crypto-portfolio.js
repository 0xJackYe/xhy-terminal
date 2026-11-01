(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.CryptoPortfolio = api;
    const start = () => { if (!root.__cryptoPortfolioController) root.__cryptoPortfolioController = api.mount({root,document:root.document}); };
    if (root.document && root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded',start,{once:true});
    else start();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const REFRESH_MS=30000, REQUEST_TIMEOUT_MS=12000, MAX_ROWS=500;
  const COLORS=['#b8795d','#69795e','#d2ac6f','#657f91','#99849b','#a39c6a','#8b6c5e','#88a49d','#b88d9c','#7f8798'];
  const LABELS={okx:'欧易',binance:'币安',offline:'离线钱包'};
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  function decimal(value) {
    if(typeof value!=='string'||value.length>512)return null;
    const match=/^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
    if(!match)return null;
    return {negative:match[1]==='-'&&/[1-9]/.test(match[2]+(match[3]||'')),whole:match[2].replace(/^0+(?=\d)/,''),fraction:match[3]||''};
  }
  function exact(value,digits=16,fixed=false) {
    const parts=decimal(value);
    if(!parts||!Number.isInteger(digits)||digits<0||digits>16)return '—';
    let scaled=BigInt(parts.whole+parts.fraction.slice(0,digits).padEnd(digits,'0'));
    if(parts.fraction.length>digits&&parts.fraction[digits]>='5')scaled+=1n;
    const padded=scaled.toString().padStart(digits+1,'0'),whole=(digits?padded.slice(0,-digits):padded).replace(/\B(?=(\d{3})+(?!\d))/g,',');
    let fraction=digits?padded.slice(-digits):'';if(!fixed)fraction=fraction.replace(/0+$/,'');
    return(parts.negative&&scaled!==0n?'-':'')+whole+(fraction?'.'+fraction:'');
  }
  function money(value,unit='usd'){const text=exact(value,2,true);return text==='—'?text:(unit==='cny'?'¥':'$')+text;}
  function quantity(value){const parts=decimal(value);if(parts&&parts.whole==='0'&&!/[1-9]/.test(parts.fraction.slice(0,16))&&/[1-9]/.test(parts.fraction.slice(16)))return(parts.negative?'>−':'<')+'0.0000000000000001';return exact(value);}
  function positive(value){const parts=decimal(value);return !!parts&&!parts.negative&&/[1-9]/.test(parts.whole+parts.fraction);}
  function percentage(value){return finite(value)&&value>=0&&value<=100?value>0&&value<.01?'<0.01%':value.toFixed(2)+'%':'—';}
  function timestamp(value){const number=typeof value==='string'?Date.parse(value):finite(value)?value:NaN;return finite(number)&&number>0&&number<=8640000000000000?number:null;}
  function beijing(value){const time=timestamp(value);if(time===null)return '—';const d=new Date(time+28800000),pad=n=>String(n).padStart(2,'0');return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate())+' '+pad(d.getUTCHours())+':'+pad(d.getUTCMinutes());}
  // Upper-case A–Z/0–9 tickers, plus caseless scripts used by a few listings
  // (for example Chinese names); lower-case Latin never poses as a ticker.
  const COIN_CODE=/^[A-Z0-9\p{Lo}][A-Z0-9._\-\p{Lo}\p{N}]{0,31}$/u;
  function rows(state,mode='currency') {
    const raw=state&&(mode==='location'?state.locations:state.assets);
    return (Array.isArray(raw)?raw:[]).slice(0,MAX_ROWS).filter(row=>row&&typeof row==='object'&&!Array.isArray(row)&&
      (mode==='location'?Object.prototype.hasOwnProperty.call(LABELS,row.id):typeof row.ccy==='string'&&COIN_CODE.test(row.ccy))&&
      positive(row.usd_value)&&finite(row.percentage)&&row.percentage>0&&row.percentage<=100).map((row,index)=>({
        id:mode==='location'?row.id:row.ccy,label:mode==='location'?LABELS[row.id]:typeof row.label==='string'&&row.label?row.label.slice(0,40):row.ccy,
        quantity:mode==='location'?null:row.quantity,value:row.usd_value,percentage:row.percentage,color:COLORS[index%COLORS.length]}));
  }
  function geometry(state,mode='currency') {
    const items=rows(state,mode),sum=items.reduce((total,row)=>total+row.percentage,0);
    if(!items.length||!finite(sum)||Math.abs(sum-100)>.05||new Set(items.map(row=>row.id)).size!==items.length)return null;
    const circumference=2*Math.PI*76;let offset=0;
    return items.map(row=>{const length=row.percentage/100*circumference,item={...row,length,offset,circumference};offset+=length;return item;});
  }
  function renderChart(state,mode='currency') {
    if(mode==='location'&&state&&state.location_allocation_complete===false)return '<p class="portfolio-empty">存在跨来源负债，存放位置扇形图暂不适用。</p>';
    const data=geometry(state,mode);
    if(!data)return '<p class="portfolio-empty">暂无可核实的资产分布。</p>';
    const label=mode==='location'?'按存放位置的资产价值占比':'按币种的资产价值占比';
    return '<svg viewBox="0 0 220 220" role="img" aria-label="'+label+'"><circle class="portfolio-donut-base" cx="110" cy="110" r="76"/>'+data.map(row=>'<circle cx="110" cy="110" r="76" fill="none" stroke="'+row.color+'" stroke-width="26" stroke-dasharray="'+row.length.toFixed(6)+' '+row.circumference.toFixed(6)+'" stroke-dashoffset="'+(-row.offset).toFixed(6)+'" transform="rotate(-90 110 110)" aria-label="'+escape(row.label)+' '+escape(percentage(row.percentage))+'"/>').join('')+'</svg>';
  }
  function renderLegend(state,mode='currency') {
    if(mode==='location'&&state&&state.location_allocation_complete===false)return '';
    const data=rows(state,mode);
    if(!data.length)return '';
    return '<table><caption class="visually-hidden">'+(mode==='location'?'资产存放位置':'币种资产分布')+'</caption><thead><tr><th scope="col">'+(mode==='location'?'存放位置':'币种')+'</th><th scope="col">'+(mode==='location'?'':'数量')+'</th><th scope="col">美元价值</th><th scope="col">占比</th></tr></thead><tbody>'+data.map(row=>'<tr><th scope="row"><i class="portfolio-swatch" style="background:'+row.color+'" aria-hidden="true"></i>'+escape(row.label)+'</th><td>'+escape(mode==='location'?'':quantity(row.quantity))+'</td><td>'+money(row.value)+'</td><td>'+escape(percentage(row.percentage))+'</td></tr>').join('')+'</tbody></table>';
  }
  function renderSources(state) {
    const raw=state&&Array.isArray(state.sources)?state.sources:[],byId=new Map(raw.filter(row=>row&&Object.prototype.hasOwnProperty.call(LABELS,row.id)).map(row=>[row.id,row]));
    return ['okx','binance','offline'].map(id=>{const source=byId.get(id),status=source&&['connected','partial','needs_credentials','error','stale','connecting'].includes(source.status)?source.status:'connecting';
      const reason=status!=='connected'&&source&&typeof source.note==='string'&&source.note?' title="'+escape(source.note.slice(0,200))+'"':'';
      return '<span class="portfolio-source '+status+'"'+reason+'>'+LABELS[id]+'<small>'+(status==='connected'?'已连接':status==='partial'?'已连接 · 部分数据':status==='needs_credentials'?'未连接':status==='connecting'?'同步中':status==='stale'?'缓存快照':'连接待恢复')+'</small></span>';}).join('');
  }
  function health(state,now=Date.now(),failed=false) {
    if(!state)return{kind:failed?'stale':'waiting',text:failed?'连接待恢复':'正在汇总'};
    const at=timestamp(state.updated_at),stale=failed||state.stale===true||at===null||now-at>90000;
    return{kind:stale?'stale':state.complete===true?'connected':'partial',text:stale?'缓存数据':state.complete===true?'已连接来源已完整估值':'部分来源'};
  }
  function connectionMessage(code) {
    return ({credentials_invalid:'币安 API 校验失败，请检查连接设置。',secret_invalid:'币安 Secret Key 不匹配，请重新填写。',
      read_only_required:'请使用只有读取权限的币安 API。',ip_restricted:'当前网络地址不在币安 API 的 IP 白名单内。',
      permission_denied:'币安 API 尚无资产读取权限。',network_error:'暂时无法连接币安，稍后自动重试。',timeout:'币安查询超时，稍后自动重试。',
      rate_limited:'币安接口限流，稍后自动重试。',clock_error:'请求时间校验失败，请检查本机时间。'})[code]||'币安连接尚未验证成功，请检查 API 凭据和读取权限。';
  }
  const MARKUP='<div class="portfolio-heading"><div><h2 id="portfolioTitle">资产分布</h2><span id="portfolioState" class="portfolio-state" role="status">正在汇总</span></div><div class="portfolio-actions"><button id="portfolioRefresh" type="button" class="text-button">刷新</button><button id="portfolioBinanceSettings" type="button" class="text-button" aria-expanded="false" aria-controls="portfolioSettings">币安连接</button></div></div>'+
    '<p id="portfolioMessage" class="portfolio-message" role="status" aria-live="polite" hidden></p><div id="portfolioSources" class="portfolio-sources"></div>'+
    '<div id="portfolioSettings" class="portfolio-settings" hidden><form id="portfolioConfigForm" autocomplete="off"><p id="portfolioCredentialHelp" class="portfolio-help"></p><div class="portfolio-fields"><div id="portfolioKeyField"><label for="portfolioApiKey">API Key</label><input id="portfolioApiKey" type="password" name="api_key" autocomplete="off" spellcheck="false" autocapitalize="none" maxlength="256"></div><div><label for="portfolioSecretKey">Secret Key</label><input id="portfolioSecretKey" type="password" name="secret_key" autocomplete="off" spellcheck="false" autocapitalize="none" maxlength="256"></div></div><div class="portfolio-config-actions"><button id="portfolioSave" class="secondary-button" type="submit">保存并连接</button><small>仅提交本机后端，保存后清空。</small></div></form></div>'+
    '<div class="portfolio-chart-head"><div class="portfolio-totals" role="group" aria-label="资产总额三种计价"><div class="portfolio-total-unit"><span id="portfolioTotalLabel">已纳入资产 · USD</span><strong id="portfolioTotal">—</strong></div><div class="portfolio-total-unit"><span>人民币 CNY</span><strong id="portfolioTotalCny">—</strong></div><div class="portfolio-total-unit"><span>比特币等值 BTC</span><strong id="portfolioTotalBtc">—</strong></div></div><div class="portfolio-tabs" role="group" aria-label="资产分布维度"><button id="portfolioByCurrency" type="button" aria-pressed="true">按币种</button><button id="portfolioByLocation" type="button" aria-pressed="false">按存放位置</button></div></div>'+
    '<div class="portfolio-content"><div id="portfolioChart" class="portfolio-chart"></div><div id="portfolioLegend" class="portfolio-legend"></div></div><p id="portfolioValuationNote" class="portfolio-help" hidden></p><div class="portfolio-footer"><span id="portfolioExcluded"></span><time id="portfolioUpdated">等待首个快照</time></div>';
  function mount(options={}) {
    const root=options.root||globalThis,document=options.document||root.document,panel=document&&document.getElementById('cryptoPortfolioPanel');
    if(!root||!panel)return null;if(panel.__portfolioController)return panel.__portfolioController;
    const node=id=>document.getElementById(id),fetcher=options.fetch||root.fetch.bind(root),setTimer=options.setTimeout||root.setTimeout.bind(root),clearTimer=options.clearTimeout||root.clearTimeout.bind(root),now=options.now||Date.now;
    panel.classList.add('crypto-portfolio','card');panel.setAttribute('aria-labelledby','portfolioTitle');panel.innerHTML=MARKUP;
    let state=null,timer=null,read=null,writing=false,disposed=false,pageActive=true,failed=false,mode='currency',generation=0,feedback=null;
    const controllers=new Set();
    function active(){const page=node('walletPage');return !disposed&&pageActive&&!document.hidden&&(!page||!page.hidden);}
    function cancelTimer(){if(timer!==null)clearTimer(timer);timer=null;}
    function schedule(){cancelTimer();if(active()&&!writing)timer=setTimer(()=>{timer=null;load();},REFRESH_MS);}
    function clearInputs(){node('portfolioApiKey').value='';node('portfolioSecretKey').value='';}
    function busy(){node('portfolioSave').disabled=writing;node('portfolioRefresh').disabled=writing||!!read;node('portfolioSave').textContent=writing?'正在保存…':'保存并连接';}
    function settings(open){node('portfolioSettings').hidden=!open;node('portfolioBinanceSettings').setAttribute('aria-expanded',String(open));if(!open)clearInputs();else node(state&&state.binance&&state.binance.pending_credentials?'portfolioSecretKey':'portfolioApiKey').focus();}
    function message(text,error=false){node('portfolioMessage').textContent=text;node('portfolioMessage').hidden=!text;node('portfolioMessage').className='portfolio-message'+(error?' error':'');}
    function render(){
      const status=health(state,now(),failed);node('portfolioState').textContent=status.text;node('portfolioState').className='portfolio-state '+status.kind;
      node('portfolioTotal').textContent=money(state&&state.total_usd);node('portfolioTotalLabel').textContent=state&&state.complete===true?'已纳入资产 · USD':'已连接来源 · USD';
      const hasTotal=decimal(state&&state.total_usd)!==null;
      node('portfolioTotalCny').textContent=money(hasTotal?state.total_cny:null,'cny');
      node('portfolioTotalBtc').textContent=exact(hasTotal?state.total_btc:null,8,true);
      node('portfolioSources').innerHTML=renderSources(state);node('portfolioChart').innerHTML=renderChart(state,mode);node('portfolioLegend').innerHTML=renderLegend(state,mode);
      const unpriced=state&&Array.isArray(state.unpriced_currencies)?state.unpriced_currencies.filter(ccy=>typeof ccy==='string'&&COIN_CODE.test(ccy)):[],notes=[];
      if(unpriced.length)notes.push('暂无可靠美元估值：'+unpriced.slice(0,30).join('、')+(unpriced.length>30?'等 '+unpriced.length+' 个币种':''));
      if(state&&positive(state.liabilities_usd))notes.push('负债另列 '+money(state.liabilities_usd)+'，未计入饼图');
      if(state&&typeof state.location_note==='string'&&state.location_note)notes.push(state.location_note.slice(0,300));
      if(state&&typeof state.scope_note==='string'&&state.scope_note)notes.push(state.scope_note.slice(0,300));
      node('portfolioValuationNote').textContent=notes.join('；');node('portfolioValuationNote').hidden=!notes.length;
      node('portfolioByCurrency').setAttribute('aria-pressed',String(mode==='currency'));node('portfolioByLocation').setAttribute('aria-pressed',String(mode==='location'));
      const threshold=state&&exact(state.threshold_usd,2),excluded=state&&money(state.excluded_usd);
      node('portfolioExcluded').textContent=threshold&&threshold!=='—'?'每个币种合计低于 $'+threshold+' 不纳入'+(excluded&&excluded!=='—'?' · 已排除 '+excluded:''):'';
      node('portfolioUpdated').textContent=state&&timestamp(state.updated_at)!==null?'快照 '+beijing(state.updated_at)+' · 北京时间':'等待首个快照';
      const binance=state&&state.binance||{},pending=binance.pending_credentials===true&&!binance.configured;
      node('portfolioKeyField').hidden=pending;node('portfolioCredentialHelp').textContent=pending?'API Key 已保存在本机，请补充对应的 Secret Key。':binance.configured?'API Key 留空沿用；更换账户时同时填写 Key 和 Secret。':'使用仅有读取权限的币安 API Key 和 Secret Key。';
      const text=feedback&&feedback.text?feedback.text:failed?'刷新失败，保留上次已核实的资产快照。':binance.error_code?connectionMessage(binance.error_code):state&&state.complete!==true?'当前仅展示已连接且可估值的来源，未连接或未估值资产不计作零。':status.kind==='stale'?'当前含缓存数据，请留意更新时间。':'';
      message(text,failed||!!(feedback&&feedback.error));busy();
    }
    async function request(path,method='GET',body,token){
      const controller=new root.AbortController();controllers.add(controller);if(token)token.controller=controller;
      const timeout=setTimer(()=>controller.abort(),REQUEST_TIMEOUT_MS);
      try{const response=await fetcher(path,{method,credentials:'same-origin',cache:'no-store',signal:controller.signal,
        headers:method==='POST'?{'Content-Type':'application/json','X-Terminal-Request':'1'}:{Accept:'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})});
        const data=await response.json();if(!response.ok||!data||typeof data!=='object'||Array.isArray(data))throw new Error('request_failed');return data;
      }finally{clearTimer(timeout);controllers.delete(controller);}
    }
    function apply(data){if(typeof data.complete!=='boolean'||!Array.isArray(data.assets)||!Array.isArray(data.locations)||!Array.isArray(data.sources)||!data.binance||typeof data.binance!=='object'||Array.isArray(data.binance))throw new Error('invalid_state');state=data;failed=false;if(feedback&&!feedback.error&&data.sources.some(source=>source&&source.id==='binance'&&source.status==='connected'))feedback=null;render();}
    async function load(){
      if(!active()||read||writing)return;cancelTimer();const token={generation};read=token;busy();
      try{const data=await request('/api/wallet/portfolio','GET',null,token);if(!disposed&&token.generation===generation)apply(data);}
      catch(_){if(!disposed&&token.generation===generation){failed=true;render();}}
      finally{if(read===token)read=null;if(!disposed)busy();schedule();}
    }
    async function save(event){
      event.preventDefault();if(disposed||writing)return;
      const binance=state&&state.binance||{},pending=binance.pending_credentials===true&&!binance.configured;
      const values={secret_key:node('portfolioSecretKey').value};if(!pending&&node('portfolioApiKey').value.trim())values.api_key=node('portfolioApiKey').value.trim();clearInputs();
      if(!values.secret_key||(!pending&&!binance.configured&&!values.api_key)){message('请填写对应的 API Key 和 Secret Key。',true);return;}
      if(Object.values(values).some(value=>typeof value!=='string'||value.length>256||/[^\x21-\x7e]/.test(value))){message('凭据格式无效，请重新填写。',true);return;}
      cancelTimer();generation++;if(read&&read.controller)read.controller.abort();read=null;writing=true;feedback=null;busy();message('正在保存并验证币安连接…');
      try{const result=await request('/api/wallet/binance/config','POST',values);if(!disposed){const config=result.binance&&typeof result.binance==='object'?result.binance:result;
        if(state)state={...state,complete:false,stale:true,total_usd:null,total_cny:null,total_btc:null,conversion_quotes:{},assets:[],locations:[],sources:state.sources.map(source=>source.id==='binance'?{...source,status:'connecting'}:source),binance:{...(state.binance||{}),...config}};
        feedback={text:'币安凭据已保存，正在同步资产。',error:false};settings(false);render();}}
      catch(_){if(!disposed){feedback={text:'币安凭据未能保存，请检查本机连接和凭据后重试。',error:true};render();}}
      finally{for(const key of Object.keys(values))values[key]='';writing=false;if(!disposed){busy();await load();}}
    }
    function visibility(){if(active())load();else cancelTimer();}
    function pageHide(){pageActive=false;cancelTimer();clearInputs();}
    function pageShow(){pageActive=true;visibility();}
    const events=[[node('portfolioRefresh'),'click',load],[node('portfolioBinanceSettings'),'click',()=>settings(node('portfolioSettings').hidden)],
      [node('portfolioConfigForm'),'submit',save],[node('portfolioByCurrency'),'click',()=>{mode='currency';render();}],
      [node('portfolioByLocation'),'click',()=>{mode='location';render();}],[document,'visibilitychange',visibility],[root,'hashchange',visibility],[root,'pagehide',pageHide],[root,'pageshow',pageShow]];
    for(const[target,event,handler]of events)target.addEventListener(event,handler);
    function destroy(){disposed=true;generation++;cancelTimer();for(const controller of controllers)controller.abort();clearInputs();for(const[target,event,handler]of events)target.removeEventListener(event,handler);panel.__portfolioController=null;}
    const controller={refresh:load,destroy};panel.__portfolioController=controller;render();if(active())load();return controller;
  }
  return{REFRESH_MS,REQUEST_TIMEOUT_MS,MAX_ROWS,COLORS,decimal,exact,money,quantity,percentage,timestamp,beijing,rows,geometry,renderChart,renderLegend,renderSources,health,connectionMessage,mount};
});
