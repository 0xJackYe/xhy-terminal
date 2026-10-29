(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else{root.XHYTravel=api;const start=()=>api.mount({root,document:root.document});if(root.document?.readyState==='loading')root.document.addEventListener('DOMContentLoaded',start,{once:true});else if(root.document)start();}})(typeof window!=='undefined'?window:globalThis,function(){
 'use strict';
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const finite=value=>typeof value==='number'&&Number.isFinite(value);
 function safeUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}
 function validIso(value){return typeof value==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));}
 function formattedTime(value,zone='Asia/Shanghai'){
  if(!validIso(value))return {clock:'—',date:'时间待核实',zone:'时区待核实'};
  let timeZone=typeof zone==='string'&&zone?zone:'UTC';
  try{new Intl.DateTimeFormat('zh-CN',{timeZone}).format(0);}catch{timeZone='UTC';}
  const parts=new Intl.DateTimeFormat('sv-SE',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(value));
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return {clock:p.hour+':'+p.minute,date:p.year+'-'+p.month+'-'+p.day,zone:timeZone==='UTC'&&zone!=='UTC'?'UTC · 目的地时区待核实':timeZone};
 }
 function beijingDate(now=Date.now()){return new Date(now+28800000).toISOString().slice(0,10);}
 function haversine(a,b){if(!a||!b||![a.lat,a.lon,b.lat,b.lon].every(finite)||Math.abs(a.lat)>90||Math.abs(b.lat)>90||Math.abs(a.lon)>180||Math.abs(b.lon)>180)return null;const rad=x=>x*Math.PI/180,dLat=rad(b.lat-a.lat),dLon=rad(b.lon-a.lon),v=Math.min(1,Math.max(0,Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2));return 6371*2*Math.atan2(Math.sqrt(v),Math.sqrt(1-v));}
 const entryLabels={visa_free:'免签候选',visa_on_arrival:'落地签候选',visa_required:'需签证',verify:'入境条件待核实'};
 function link(label,value){const url=safeUrl(value);if(!url)return '';return '<a href="'+escape(url)+'" target="_blank" rel="noopener noreferrer">'+escape(label)+' ↗</a>';}
 function numberInput(value,name,min,max){const n=Number(value);if(String(value).trim()===''||!Number.isInteger(n)||n<min||n>max)throw new Error(name+'请填写 '+min+'–'+max+' 的整数分钟。');return n;}
 function searchPayload(values){
  const selected=Array.isArray(values.airports)?values.airports:[];
  if(!selected.length)throw new Error('请先选择至少一个出发机场。');
  if(selected.length>6)throw new Error('一次最多比较 6 个出发机场。');
  const seen=new Set(),airports=selected.map(a=>{const iata=String(a.iata||'').toUpperCase();if(!/^[A-Z]{3}$/.test(iata)||seen.has(iata))throw new Error('出发机场无效或重复。');seen.add(iata);return {iata,travel_minutes:a.travel_minutes===null||a.travel_minutes===undefined||String(a.travel_minutes).trim()===''?null:numberInput(a.travel_minutes,'到机场时间',0,1440)};});
  const passport=String(values.passport_country||'').trim().toUpperCase();if(passport&&!/^[A-Z]{2}$/.test(passport))throw new Error('护照国别请填写两位字母代码。');
  const entry=values.entry_filter==='easy_entry'?'easy_entry':'all';if(entry==='easy_entry'&&!passport)throw new Error('请先选择护照国别，再筛选免签或落地签候选。');
  const date=String(values.departure_date||''),dateStamp=Date.parse(date+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(dateStamp)||new Date(dateStamp).toISOString().slice(0,10)!==date)throw new Error('请选择有效的出发日期。');
  return {airports,ready_minutes:numberInput(values.ready_minutes,'准备时间',0,1440),international_buffer_minutes:numberInput(values.international_buffer_minutes,'提前到机场时间',60,480),passport_country:passport,countries:[...new Set((values.countries||[]).filter(c=>typeof c==='string'&&/^[A-Z]{2}$/.test(c)))],sort:['earliest_departure','earliest_arrival','price'].includes(values.sort)?values.sort:'earliest_departure',departure_date:date,entry_filter:entry};
 }
 function freshSource(flight,now=Date.now()){const stamp=validIso(flight?.source?.checked_at)?Date.parse(flight.source.checked_at):NaN;return Number.isFinite(stamp)&&now-stamp<=900000&&stamp<=now+5000;}
 function confirmedCandidate(flight,live,now=Date.now()){return live&&flight?.nonstop===true&&flight.planning?.disposition==='actionable'&&flight.availability==='confirmed_offer'&&freshSource(flight,now)&&validIso(flight.scheduled_departure)&&Date.parse(flight.scheduled_departure)>now&&validIso(flight.planning.leave_by)&&Date.parse(flight.planning.leave_by)>now;}
 function tentativeCandidate(flight,live,now=Date.now()){const plan=flight?.planning;return live&&flight?.nonstop===true&&flight.availability==='schedule_only'&&['actionable','needs_verification'].includes(plan?.disposition)&&finite(plan.travel_minutes)&&plan.travel_minutes>=0&&finite(plan.slack_minutes)&&plan.slack_minutes>=0&&freshSource(flight,now)&&validIso(flight.scheduled_departure)&&Date.parse(flight.scheduled_departure)>now&&validIso(plan.leave_by)&&Date.parse(plan.leave_by)>now;}
 function priceText(flight,live,now=Date.now()){
  const p=flight?.price;
  if(!live||flight.availability!=='confirmed_offer'||!p||!['string','number'].includes(typeof p.amount)||String(p.amount).trim()===''||!Number.isFinite(Number(p.amount))||Number(p.amount)<0||!/^[A-Z]{3}$/.test(p.currency||'')||!freshSource(flight,now))return '<span class="flight-price">余票待核实<small>以出票前确认的价格为准</small></span>';
  const amount=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(Number(p.amount));return '<span class="flight-price">'+escape(p.currency)+' '+escape(amount)+'<small>已查询报价，出票前复核</small></span>';
 }
 function flightHtml(flight,{live=false,now=Date.now()}={}){
  if(!flight||typeof flight!=='object')return '';
  const plan=flight.planning&&typeof flight.planning==='object'?flight.planning:{},origin=flight.origin||{},destination=flight.destination||{},departure=formattedTime(flight.scheduled_departure,origin.time_zone||'Asia/Shanghai'),arrival=formattedTime(flight.scheduled_arrival,destination.time_zone||null),leave=formattedTime(plan.leave_by,origin.time_zone||'Asia/Shanghai'),arriveBy=formattedTime(plan.arrive_by,origin.time_zone||'Asia/Shanghai');
  const disposition=['actionable','needs_verification','too_late'].includes(plan.disposition)?plan.disposition:'needs_verification';
  const actionable=confirmedCandidate(flight,live,now);
  const label=disposition==='too_late'?'按当前准备时间来不及':actionable?'可继续核实购票':flight.availability==='schedule_only'?'时刻候选 · 余票待核实':'仍需核实';
  const airline=typeof flight.airline==='string'?flight.airline:flight.airline?.name||'航空公司待核实';
  const reasons=(Array.isArray(plan.reasons)?plan.reasons:[]).filter(r=>typeof r==='string').slice(0,4);
  if(!live)reasons.unshift('当前不是实时可售结果，请到官方渠道重新查询。');
  const entry=flight.entry||{},entryLabel=entryLabels[entry.status]||entryLabels.verify;
  const source=flight.source||{},sourceTime=formattedTime(source.checked_at,'Asia/Shanghai');
  return '<article class="flight-row"><div class="flight-heading"><h3>'+escape(flight.flight_number||'航班号待核实')+'<small>'+escape(airline)+'</small></h3><span class="flight-disposition '+(actionable?'actionable':disposition==='too_late'?'too_late':'needs_verification')+'">'+escape(label)+'</span></div><div class="flight-route"><div class="flight-endpoint"><strong>'+escape(departure.clock)+'</strong><span>'+escape(origin.iata||'—')+' · '+escape(origin.city||origin.name||'出发机场待核实')+'</span><small>'+escape(departure.date)+' · '+escape(departure.zone)+'</small></div><span class="flight-arrow" aria-hidden="true">→</span><div class="flight-endpoint"><strong>'+escape(arrival.clock)+'</strong><span>'+escape(destination.iata||'—')+' · '+escape(destination.city||destination.name||'抵达机场待核实')+'</span><small>'+escape(arrival.date)+' · '+escape(arrival.zone)+'</small></div>'+priceText(flight,live,now)+'</div><div class="flight-plan"><span>预计交通 <strong>'+(finite(plan.travel_minutes)?escape(plan.travel_minutes)+' 分钟':'待填写')+'</strong></span><span>最晚出门 <strong>'+escape(leave.clock)+'</strong>'+(validIso(plan.leave_by)?' · '+escape(leave.date):'')+'</span><span>最晚到机场 <strong>'+escape(arriveBy.clock)+'</strong></span><span>准备余量 <strong>'+(finite(plan.slack_minutes)?escape(Math.floor(plan.slack_minutes))+' 分钟':'待核实')+'</strong></span></div>'+(reasons.length?'<p class="flight-reasons">'+reasons.map(escape).join('；')+'</p>':'')+'<div class="flight-footer"><span>'+escape(entryLabel)+' · 按护照核实 · '+(flight.nonstop===true?'直飞':'直飞情况待核实')+'</span><div class="flight-links">'+link('查询 / 购票',flight.booking_url)+link('入境要求',entry.official_url)+link('航班来源',source.url)+'</div></div><p class="field-note">'+escape(source.name||'数据来源待核实')+' · '+escape(sourceTime.date)+' '+escape(sourceTime.clock)+' 北京时间</p></article>';
 }
 function resultHtml(data,{now=Date.now()}={}){
  const live=data?.provider?.status==='live',flights=Array.isArray(data?.flights)?data.flights:[];
  const recommendation=data?.recommendation;
  let summary;
  if(!live)summary='<p class="result-summary"><strong>尚未接通实时航班源。</strong>选择机场后可前往官方查询 / 购票；当前无法确定最快可成行的一班。</p>';
  else if(!flights.length)summary='<p class="result-summary">当前条件下没有可核实的直飞候选。可调整出发日期、准备时间或机场范围后重查。</p>';
  else if(confirmedCandidate(recommendation,live,now))summary='<p class="result-summary">当前较早的可行候选：<strong>'+escape(recommendation.flight_number||'待核实航班')+'</strong>。购票前仍须复核入境、交通和值机条件。</p>';
  else if(tentativeCandidate(data?.earliest_candidate,live,now)){
   const candidate=data.earliest_candidate,departure=formattedTime(candidate.scheduled_departure,candidate.origin?.time_zone||'Asia/Shanghai');
   summary='<p class="result-summary">按当前准备与交通估计，优先核对 <strong>'+escape(candidate.flight_number||'待核实航班')+'</strong> 班（计划起飞 '+escape(departure.date)+' '+escape(departure.clock)+' · '+escape(departure.zone)+'）；<strong>仍须确认余票与入境条件。</strong></p>';
  }
  else summary='<p class="result-summary">找到 '+flights.length+' 条候选时刻。<strong>余票或入境条件尚待核实，不能据此确认可成行。</strong></p>';
  if(validIso(data?.window?.from)&&validIso(data?.window?.to)&&Date.parse(data.window.to)>Date.parse(data.window.from)){
   const from=formattedTime(data.window.from,'Asia/Shanghai'),to=formattedTime(data.window.to,'Asia/Shanghai');
   summary+='<p class="field-note">本次查询时段 · 北京时间 '+escape(from.date)+' '+escape(from.clock)+' — '+escape(to.date)+' '+escape(to.clock)+'</p>';
  }
  const warnings=(Array.isArray(data?.warnings)?data.warnings:[]).filter(x=>typeof x==='string').slice(0,5);
  summary+=warnings.map(w=>'<p class="result-warning">'+escape(w.slice(0,800))+'</p>').join('');
  const group=(title,rows)=>{const links=(Array.isArray(rows)?rows:[]).slice(0,20).map(row=>link(String(row.label||'官方查询'),row.url)).filter(Boolean);return links.length?'<h3>'+title+'</h3><div class="manual-link-list">'+links.join('')+'</div>':'';};
  return {summary,flights:flights.slice(0,50).map(f=>flightHtml(f,{live,now})).join(''),links:group('机场官方航班查询',data?.airport_links)+group('查询和购票',data?.booking_links)};
 }
 function mount({root=globalThis,document=root.document,fetch:fetcher=root.fetch?.bind(root)}={}){
  const form=document?.getElementById('travel-form');
  if(!form||form.__travelController)return form?.__travelController||null;
  const $=id=>document.getElementById(id),selected=new Map();
  let config=null,busy=false,settingsBusy=false,abort=null,sequence=0,disposed=false,position=null,resultActive=false;
  function status(message,error=false){$('travel-form-status').textContent=message;$('travel-form-status').dataset.error=String(error);}
  function settingsStatus(message,error=false){$('travel-settings-status').textContent=message;$('travel-settings-status').dataset.error=String(error);}
  function setBusy(value){
   busy=value;
   for(const control of form.querySelectorAll('button,input,select'))control.disabled=value;
   for(const n of document.querySelectorAll('[data-airport-travel]'))n.disabled=value||!selected.has(n.dataset.airportTravel);
   $('travel-submit').textContent=value?'正在比较…':'比较直飞方案';$('travel-submit').disabled=value||!config;
   $('travel-save-key').disabled=value||settingsBusy;$('travel-api-key').disabled=value||settingsBusy;
  }
  function providerText(provider){
   const state=provider?.status||'needs_credentials';
   $('travel-provider').textContent=state==='live'?'航班时刻源已接通':state==='error'?'数据源暂不可用':provider?.configured?'已配置航班时刻源':'尚未接通实时航班源';
   $('travel-provider').className='provider-state '+(state==='live'?'live':state==='error'?'error':'');
   const attribution=provider?.attribution||config?.provider?.attribution;
   $('travel-attribution').innerHTML=attribution?link(attribution.label||'航班数据来源',attribution.url):'';
  }
  function clearResults(message){
   resultActive=false;$('travel-summary').innerHTML='<p class="empty-inline">'+escape(message)+'</p>';
   $('travel-flight-list').innerHTML='';$('travel-manual-links').innerHTML='';$('travel-manual-links').hidden=true;$('travel-updated').textContent='';
  }
  function changed(){if(resultActive)clearResults('筛选条件已更改，请重新比较直飞方案。');}
  function renderAirports(){
   if(!config)return;
   const term=$('travel-city').value.trim().toLocaleLowerCase();
   let rows=config.airports.filter(a=>!term||[a.iata,a.name,a.city,...(Array.isArray(a.search_cities)?a.search_cities:[])].some(value=>String(value||'').toLocaleLowerCase().includes(term))||selected.has(a.iata));
   rows=[...rows].sort((a,b)=>Number(selected.has(b.iata))-Number(selected.has(a.iata))||(position?(haversine(position,a)??Infinity)-(haversine(position,b)??Infinity):0));
   if(!term&&!position&&!selected.size){$('travel-airports').innerHTML='<p class="empty-inline">输入城市或机场名称后选择出发机场，也可以主动使用当前位置筛选。</p>';return;}
   $('travel-airports').innerHTML=rows.length?rows.slice(0,16).map(a=>{
    const code=String(a.iata||'');if(!/^[A-Z]{3}$/.test(code))return '';
    const distance=position?haversine(position,a):null,value=selected.get(code);
    return '<div class="airport-option"><label class="airport-select"><input type="checkbox" value="'+code+'" data-airport-check="'+code+'" '+(selected.has(code)?'checked':'')+'><span><span class="airport-name">'+escape(a.name||code)+'</span><span class="airport-meta">'+escape(code)+' · '+escape(a.city||'')+(distance!==null?' · 直线约 '+Math.round(distance)+' km':'')+'</span></span></label><label class="airport-travel"><span class="sr-only">前往 '+escape(a.name||code)+' 的预计交通分钟</span><input type="number" min="0" max="1440" step="5" placeholder="待填" data-airport-travel="'+code+'" value="'+escape(value??'')+'" '+(selected.has(code)?'':'disabled')+'><span>分钟</span></label></div>';
   }).join(''):'<p class="empty-inline">没有匹配的机场，请尝试附近城市或三字代码。</p>';
  }
  function passportChange(){$('travel-other-passport-field').hidden=$('travel-passport').value!=='other';}
  function renderConfig(value,{applyDefaults=false}={}){
   const previousCountries=[...form.querySelectorAll('[name=country]:checked')].map(n=>n.value);
   config=value;providerText(value.provider);
   const defaults=applyDefaults&&value.defaults&&typeof value.defaults==='object'?value.defaults:{};
   if(applyDefaults){
    const available=new Set(value.airports.map(a=>a.iata));
    for(const a of Array.isArray(defaults.airports)?defaults.airports:[])if(available.has(a.iata))selected.set(a.iata,finite(a.travel_minutes)&&a.travel_minutes>=0?a.travel_minutes:null);
    if(typeof defaults.city==='string')$('travel-city').value=defaults.city;
    if(finite(defaults.ready_minutes))$('travel-ready').value=defaults.ready_minutes;
    if(finite(defaults.international_buffer_minutes))$('travel-buffer').value=defaults.international_buffer_minutes;
    if(['earliest_departure','earliest_arrival','price'].includes(defaults.sort))$('travel-sort').value=defaults.sort;
    if(/^[A-Z]{2}$/.test(defaults.passport_country||'')){
     $('travel-passport').value=defaults.passport_country==='CN'?'CN':'other';$('travel-other-passport').value=defaults.passport_country==='CN'?'':defaults.passport_country;
    }
    if(['all','easy_entry'].includes(defaults.entry_filter))$('travel-entry').value=defaults.entry_filter;
    $('travel-defaults-status').textContent=Object.keys(defaults).length?'已载入你的私人出发偏好'+(typeof defaults.location_label==='string'?' · '+defaults.location_label:'')+'；交通时间请核实。':'';
   }
   passportChange();
   const cities=[...new Set(value.airports.flatMap(a=>[a.city,a.iata,...(Array.isArray(a.search_cities)?a.search_cities:[])]).filter(Boolean))];
   $('travel-cities').innerHTML=cities.map(c=>'<option value="'+escape(c)+'"></option>').join('');
   const countries=applyDefaults&&Array.isArray(defaults.countries)?defaults.countries:previousCountries;
   $('travel-countries').innerHTML=value.destinations.filter(c=>/^[A-Z]{2}$/.test(c.code||'')).map(c=>'<label class="country-option"><input type="checkbox" name="country" value="'+escape(c.code)+'" '+(countries.includes(c.code)?'checked':'')+'><span>'+escape(c.name||c.code)+'</span><small>条件待核实</small></label>').join('');
   const notes=(Array.isArray(value.entry_notes)?value.entry_notes:[]).slice(0,20).map(n=>'<p><strong>'+escape(n.name||n.country||'目的地')+'</strong> · '+escape(n.note||'请核实入境条件')+' '+link('官方说明',n.official_url)+' '+link('官方入境表',n.form_url)+(validIso(n.checked_at)?' <span class="field-note">核于 '+escape(formattedTime(n.checked_at,'Asia/Shanghai').date)+'</span>':'')+'</p>').join('');
   $('travel-entry-note-list').innerHTML=notes;$('travel-entry-notes').hidden=!notes;
   const today=beijingDate(validIso(value.now)?Date.parse(value.now):Date.now());
   if(!$('travel-date').value)$('travel-date').value=today;$('travel-date').min=today;
   renderAirports();setBusy(busy);
   if(!resultActive){
    const initial=resultHtml({provider:value.provider,booking_links:value.booking_links,airport_links:value.airport_links});
    if(value.provider?.status!=='live')$('travel-summary').innerHTML=initial.summary;
    $('travel-manual-links').innerHTML=initial.links;$('travel-manual-links').hidden=!initial.links;
   }
  }
  async function search(event){
   event?.preventDefault();if(busy||settingsBusy||!config)return;let payload;
   try{payload=searchPayload({airports:[...selected].map(([iata,travel_minutes])=>({iata,travel_minutes})),ready_minutes:$('travel-ready').value,international_buffer_minutes:$('travel-buffer').value,passport_country:$('travel-passport').value==='other'?$('travel-other-passport').value:$('travel-passport').value,entry_filter:$('travel-entry').value,countries:[...form.querySelectorAll('[name=country]:checked')].map(n=>n.value),departure_date:$('travel-date').value,sort:$('travel-sort').value});}
   catch(error){status(error.message,true);return;}
   const current=++sequence;abort?.abort();abort=new root.AbortController();const currentAbort=abort,timer=root.setTimeout(()=>currentAbort.abort(),45000);
   clearResults('正在核对候选航班与准备时间…');setBusy(true);status('正在查询；没有交通时间的机场只显示待核实候选。');
   try{
    const r=await fetcher('/api/travel/search',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','Accept':'application/json','X-Terminal-Request':'1'},body:JSON.stringify(payload),signal:currentAbort.signal});
    const data=await r.json();if(!r.ok)throw new Error(typeof data.error==='string'?data.error:data.error?.message||'航班查询暂不可用。');
    if(disposed||current!==sequence)return;
    if(!data||!Array.isArray(data.flights)||!data.provider)throw new Error('航班数据格式未通过核验。');
    const html=resultHtml(data);$('travel-summary').innerHTML=html.summary;$('travel-flight-list').innerHTML=html.flights;$('travel-manual-links').innerHTML=html.links;$('travel-manual-links').hidden=!html.links;resultActive=true;providerText(data.provider);
    const at=formattedTime(data.generated_at,'Asia/Shanghai');$('travel-updated').textContent=at.clock==='—'?'':'核对于 '+at.date+' '+at.clock+' 北京时间';
    status(data.provider.status==='live'?'已读取候选；请在购票前复核余票与证件条件。':'已整理官方查询 / 购票入口，尚不能确定最快可成行航班。');
    root.XHYMotion?.enter($('travel-results'),{y:4,duration:220});
   }catch(error){
    if(disposed||current!==sequence)return;
    clearResults('本次查询未完成，尚无可用于比较的新结果。');status(error.name==='AbortError'?'查询超时，已保留你的筛选条件。':error.message||'查询失败，请稍后重试。',true);
   }finally{root.clearTimeout(timer);if(!disposed&&current===sequence)setBusy(false);}
  }
  async function saveSettings(event){
   event?.preventDefault();if(settingsBusy||busy)return;
   const key=$('travel-api-key').value.trim();if(!key){settingsStatus('请输入你在 RapidAPI 获得的 AeroDataBox API key。',true);return;}
   settingsBusy=true;$('travel-api-key').value='';setBusy(busy);settingsStatus('正在保存到后台并验证数据源…');
   try{
    const r=await fetcher('/api/travel/config',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','Accept':'application/json','X-Terminal-Request':'1'},body:JSON.stringify({api_key:key})});
    const data=await r.json();if(!r.ok||!Array.isArray(data.airports)||!Array.isArray(data.destinations))throw new Error();
    if(disposed)return;changed();renderConfig(data);settingsStatus('已保存。输入框已清空，现在可以比较直飞方案。');
   }catch{if(!disposed)settingsStatus('保存失败，请检查 API key、套餐订阅或稍后重试；输入框已清空。',true);}
   finally{settingsBusy=false;if(!disposed)setBusy(busy);}
  }
  function airportChange(event){
   const node=event.target;
   if(node.dataset?.airportCheck){if(node.checked)selected.set(node.dataset.airportCheck,null);else selected.delete(node.dataset.airportCheck);renderAirports();}
   else if(node.dataset?.airportTravel&&selected.has(node.dataset.airportTravel))selected.set(node.dataset.airportTravel,node.value.trim()===''?null:node.value);
  }
  function locate(){
   if(!root.navigator?.geolocation){$('travel-location-status').textContent='当前浏览器不支持定位，请手动输入城市。';return;}
   $('travel-location-status').textContent='仅在本页计算附近机场，正在等待定位许可…';
   root.navigator.geolocation.getCurrentPosition(p=>{if(disposed)return;position={lat:p.coords.latitude,lon:p.coords.longitude};$('travel-city').value='';$('travel-location-status').textContent='已按直线距离排列附近机场；交通时间仍需你自行核对。';renderAirports();},()=>{if(!disposed)$('travel-location-status').textContent='未取得位置，请手动输入城市或机场。';},{enableHighAccuracy:false,timeout:10000,maximumAge:300000});
  }
  const events=[[form,'submit',search],[form,'input',changed],[form,'change',changed],[$('travel-city'),'input',renderAirports],[$('travel-airports'),'change',airportChange],[$('travel-passport'),'change',passportChange],[$('travel-locate'),'click',locate],[$('travel-settings-form'),'submit',saveSettings]];
  events.forEach(([target,event,handler])=>target.addEventListener(event,handler));
  fetcher('/api/travel/config',{method:'GET',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}}).then(async r=>{
   const data=await r.json();if(!r.ok||!Array.isArray(data.airports)||!Array.isArray(data.destinations))throw new Error();
   if(!disposed)renderConfig(data,{applyDefaults:true});
  }).catch(()=>{if(!disposed){providerText({status:'error'});status('无法读取机场配置，请刷新页面后重试。',true);$('travel-airports').innerHTML='<p class="empty-inline">机场列表暂时不可用。</p>';}});
  const controller={search,saveSettings,destroy(){disposed=true;sequence++;abort?.abort();$('travel-api-key').value='';events.forEach(([target,event,handler])=>target.removeEventListener(event,handler));form.__travelController=null;}};
  form.__travelController=controller;return controller;
 }
 return {escape,safeUrl,validIso,formattedTime,beijingDate,haversine,searchPayload,freshSource,confirmedCandidate,tentativeCandidate,priceText,flightHtml,resultHtml,mount};
});
