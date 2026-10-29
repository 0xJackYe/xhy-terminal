import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';

const require=createRequire(import.meta.url);
const ui=require('../../frontend/travel.js');
const now=Date.parse('2026-10-29T00:00:00Z');
const clone=value=>structuredClone(value);
const fixture=()=>({
 id:'test-flight',flight_number:'TEST123',airline:{name:'测试航空',iata:'XX'},
 origin:{iata:'XMN',name:'测试出发机场',city:'厦门',time_zone:'Asia/Shanghai'},
 destination:{iata:'NRT',name:'测试到达机场',city:'东京',time_zone:'Asia/Tokyo'},
 scheduled_departure:'2026-10-29T06:00:00Z',scheduled_arrival:'2026-10-29T09:00:00Z',
 availability:'confirmed_offer',nonstop:true,price:{amount:'1234.50',currency:'CNY'},booking_url:'https://www.example.com/booking',
 source:{name:'测试数据源',url:'https://www.example.com/flights',checked_at:'2026-10-28T23:59:00Z'},
 entry:{status:'visa_required',official_url:'https://www.example.com/entry'},
 planning:{disposition:'actionable',ready_at:'2026-10-29T01:00:00Z',leave_by:'2026-10-29T02:00:00Z',arrive_by:'2026-10-29T03:00:00Z',travel_minutes:60,slack_minutes:60,reasons:[]}
});
const values=()=>({airports:[{iata:'XMN',travel_minutes:'60'}],ready_minutes:'120',international_buffer_minutes:'180',passport_country:'',countries:[],entry_filter:'all',sort:'earliest_departure',departure_date:'2026-10-29'});

test('missing credentials never produce a fastest-flight or availability claim',()=>{
 const flight=fixture();
 const html=ui.resultHtml({provider:{status:'needs_credentials'},flights:[flight],recommendation:flight},{now});
 assert.match(html.summary,/尚未接通实时航班源/);
 assert.match(html.summary,/无法确定最快/);
 assert.doesNotMatch(html.summary,/当前较早的可行候选/);
 assert.doesNotMatch(html.flights,/可继续核实购票|CNY 1,234/);
 assert.match(html.flights,/当前不是实时可售结果/);
});

test('schedule-only candidates do not display supplied prices or imply seats',()=>{
 const flight=fixture();flight.availability='schedule_only';
 const html=ui.resultHtml({provider:{status:'live'},flights:[flight],recommendation:flight},{now});
 assert.match(html.flights,/时刻候选 · 余票待核实/);
 assert.doesNotMatch(html.flights,/CNY 1,234|可继续核实购票/);
 assert.match(html.summary,/不能据此确认可成行/);
});

test('results state the actual queried window in Beijing time across midnight',()=>{
 const html=ui.resultHtml({provider:{status:'live'},flights:[],window:{from:'2026-10-29T12:00:00Z',to:'2026-10-30T00:00:00Z'}},{now});
 assert.match(html.summary,/本次查询时段 · 北京时间 2026-10-29 20:00 — 2026-10-30 08:00/);
 const invalid=ui.resultHtml({provider:{status:'live'},flights:[],window:{from:'not a date',to:null}},{now});
 assert.doesNotMatch(invalid.summary,/本次查询时段|Invalid Date/);
});

test('fresh earliest schedule with known commute is presented only as a candidate to verify',()=>{
 const flight=fixture();flight.availability='schedule_only';flight.planning.disposition='needs_verification';
 const html=ui.resultHtml({provider:{status:'live'},flights:[flight],earliest_candidate:flight,recommendation:null},{now});
 assert.match(html.summary,/按当前准备与交通估计，优先核对 <strong>TEST123<\/strong> 班/);
 assert.match(html.summary,/计划起飞 2026-10-29 14:00 · Asia\/Shanghai/);
 assert.match(html.summary,/仍须确认余票与入境条件/);
 assert.doesNotMatch(html.summary,/可成行|可买|可行候选/);
 assert.match(html.flights,/时刻候选 · 余票待核实/);
 assert.doesNotMatch(html.flights,/可继续核实购票|CNY 1,234/);
});

test('late, unknown-commute, stale and offline schedules are never highlighted as earliest candidates',()=>{
 const mutations=[
  flight=>{flight.planning.disposition='too_late';},
  flight=>{flight.planning.travel_minutes=null;},
  flight=>{flight.planning.slack_minutes=null;},
  flight=>{flight.planning.slack_minutes=-1;},
  flight=>{flight.source.checked_at='2026-10-28T22:00:00Z';},
  flight=>{flight.source.checked_at='2026-10-29T01:00:00Z';},
  flight=>{flight.nonstop=false;}
 ];
 for(const mutate of mutations){
  const flight=fixture();flight.availability='schedule_only';flight.planning.disposition='needs_verification';mutate(flight);
  const html=ui.resultHtml({provider:{status:'live'},flights:[flight],earliest_candidate:flight},{now});
  assert.doesNotMatch(html.summary,/优先核对|当前较早的可行候选/);
 }
 const flight=fixture();flight.availability='schedule_only';
 assert.doesNotMatch(ui.resultHtml({provider:{status:'needs_credentials'},flights:[flight],earliest_candidate:flight},{now}).summary,/优先核对/);
});

test('confirmed fresh flights use both airport time zones and conservative leave time',()=>{
 const flight=fixture(),html=ui.flightHtml(flight,{live:true,now});
 assert.match(html,/>14:00</);assert.match(html,/>18:00</);
 assert.match(html,/Asia\/Shanghai/);assert.match(html,/Asia\/Tokyo/);
 assert.match(html,/最晚出门 <strong>10:00/);assert.match(html,/最晚到机场 <strong>11:00/);
 assert.match(html,/CNY 1,234.5/);assert.match(html,/可继续核实购票/);
});

test('expired, future-dated, indirect or already missed flights cannot be actionable',()=>{
 for(const mutate of [f=>{f.source.checked_at='2026-10-28T22:00:00Z';},f=>{f.source.checked_at='2026-10-29T01:00:00Z';},f=>{f.nonstop=false;},f=>{f.planning.leave_by='2026-10-28T23:00:00Z';}]){
  const flight=fixture();mutate(flight);
  assert.equal(ui.confirmedCandidate(flight,true,now),false);
  assert.doesNotMatch(ui.resultHtml({provider:{status:'live'},flights:[flight],recommendation:flight},{now}).summary,/当前较早的可行候选/);
 }
 const expired=fixture();expired.source.checked_at='2026-10-28T22:00:00Z';
 assert.doesNotMatch(ui.priceText(expired,true,now),/CNY/);
});

test('missing arrival and commute stay unknown instead of becoming zero or Beijing arrival',()=>{
 const flight=fixture();flight.scheduled_arrival=null;flight.destination.time_zone=null;flight.planning.travel_minutes=null;flight.planning.leave_by=null;flight.planning.slack_minutes=null;
 const html=ui.flightHtml(flight,{live:true,now});
 assert.doesNotMatch(html,/1970|Invalid Date|预计交通 <strong>0 分钟/);
 assert.match(html,/时间待核实/);assert.match(html,/预计交通 <strong>待填写/);
 const unknownZone=ui.formattedTime('2026-10-29T09:00:00Z',null);
 assert.equal(unknownZone.clock,'09:00');assert.match(unknownZone.zone,/UTC.*待核实/);
});

test('flight and warning content is escaped and active or credential-bearing URLs are rejected',()=>{
 const flight=fixture();flight.flight_number='<img src=x onerror=alert(1)>';flight.airline.name='"<script>alert(1)</script>';
 flight.booking_url='javascript:alert(1)';flight.entry.official_url='https://user:secret@example.com/';
 flight.source.url='http://example.com/';flight.planning.reasons=['<svg onload=alert(1)>'];
 const html=ui.resultHtml({provider:{status:'live'},flights:[flight],warnings:['<script>bad</script>'],airport_links:[{label:'<b>机场</b>',url:'https://www.example.com/?q=%22'}],booking_links:[{label:'坏链接',url:'data:text/html,bad'}]},{now});
 assert.doesNotMatch(html.flights,/<img|<script|<svg|href="javascript|user:secret/);
 assert.match(html.flights,/&lt;img/);assert.match(html.summary,/&lt;script/);
 assert.match(html.links,/&lt;b&gt;机场/);assert.doesNotMatch(html.links,/坏链接/);
 assert.equal(ui.safeUrl('https://name:pass@example.com/'),null);
 assert.equal(ui.safeUrl('http://example.com/'),null);
});

test('payload accepts unknown commute and passport without silently assuming them',()=>{
 const input=values();input.airports[0].travel_minutes='';
 const payload=ui.searchPayload({...input,lat:30,lon:120,address:'not sent'});
 assert.equal(payload.airports[0].travel_minutes,null);assert.equal(payload.passport_country,'');
 assert.equal(Object.hasOwn(payload,'lat'),false);assert.equal(Object.hasOwn(payload,'address'),false);
 input.airports[0].travel_minutes='0';assert.equal(ui.searchPayload(input).airports[0].travel_minutes,0);
});

test('payload requires sensible airports, dates, timing and a passport for easy-entry filter',()=>{
 const cases=[
  {...values(),airports:[]},
  {...values(),airports:[{iata:'XMN',travel_minutes:60},{iata:'xmn',travel_minutes:60}]},
  {...values(),airports:[{iata:'XMN',travel_minutes:-1}]},
  {...values(),ready_minutes:'0.5'},
  {...values(),international_buffer_minutes:'0'},
  {...values(),departure_date:'2026-02-30'},
  {...values(),departure_date:'2026-99-01'},
  {...values(),entry_filter:'easy_entry'},
  {...values(),passport_country:'CHN'}
 ];
 for(const input of cases)assert.throws(()=>ui.searchPayload(input),Error);
 assert.throws(()=>ui.searchPayload({...values(),airports:['AAA','AAB','AAC','AAD','AAE','AAF','AAG'].map(iata=>({iata,travel_minutes:null}))}),/最多比较 6 个/);
 assert.equal(ui.searchPayload({...values(),airports:['AAA','AAB','AAC','AAD','AAE','AAF'].map(iata=>({iata,travel_minutes:null}))}).airports.length,6);
 assert.equal(ui.searchPayload({...values(),passport_country:'cn',entry_filter:'easy_entry'}).passport_country,'CN');
});

test('proximity sorting uses finite coordinates within valid ranges',()=>{
 assert.equal(ui.haversine({lat:0,lon:0},{lat:0,lon:0}),0);
 assert.ok(Math.abs(ui.haversine({lat:0,lon:0},{lat:0,lon:1})-111.195)<0.01);
 assert.equal(ui.haversine({lat:91,lon:0},{lat:0,lon:0}),null);
 assert.equal(ui.haversine({lat:0,lon:NaN},{lat:0,lon:0}),null);
});

test('all normal text and status colors retain AA contrast in light and dark palettes',async()=>{
 const css=await readFile(new URL('../../frontend/travel.css',import.meta.url),'utf8');
 const palettes=[css.match(/^:root\{([^}]+)\}/)?.[1],css.match(/:root\[data-xhy-theme="dark"\]\{([^}]+)\}/)?.[1]];
 function luminance(hex){
  let text=hex.slice(1);if(text.length===3)text=[...text].map(c=>c+c).join('');
  const linear=[0,2,4].map(i=>parseInt(text.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
  return linear[0]*.2126+linear[1]*.7152+linear[2]*.0722;
 }
 for(const raw of palettes){
  assert.ok(raw,'both explicit palettes exist');
  const color=Object.fromEntries([...raw.matchAll(/--([a-z]+):(#(?:[a-f\d]{6}|[a-f\d]{3}))(?=;|$)/gi)].map(([,name,value])=>[name,value]));
  for(const ink of ['text','muted','positive','negative'])for(const surface of ['bg','panel','soft']){
   const a=luminance(color[ink]),b=luminance(color[surface]),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
   assert.ok(ratio>=4.5,`${ink} on ${surface}: ${ratio.toFixed(2)}:1`);
  }
 }
});

class Element {
 constructor(id){this.id=id;this.dataset={};this.hidden=false;this.disabled=false;this.innerHTML='';this.textContent='';this.listeners=new Map();this._value='';}
 get value(){return this._value;}set value(value){this._value=String(value);}
 addEventListener(type,handler){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(handler);}
 removeEventListener(type,handler){this.listeners.get(type)?.delete(handler);}
 emit(type,event={}){for(const handler of this.listeners.get(type)||[])handler({preventDefault(){},target:this,...event});}
 querySelectorAll(){return [];}
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function mounted(responder){
 const html=await readFile(new URL('../../frontend/travel.html',import.meta.url),'utf8');
 const nodes=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([,id])=>[id,new Element(id)]));
 nodes.get('travel-ready').value=60;nodes.get('travel-buffer').value=180;nodes.get('travel-sort').value='earliest_departure';nodes.get('travel-entry').value='all';
 const calls=[];let locationCalls=0;
 const document={getElementById:id=>nodes.get(id),querySelectorAll:()=>[]};
 const root={document,AbortController,setTimeout,clearTimeout,navigator:{geolocation:{getCurrentPosition(callback){locationCalls++;callback({coords:{latitude:24.5,longitude:118.1}});}}}};
 const fetch=async(url,options)=>{calls.push({url,options});return responder(url,options,calls.length);};
 const controller=ui.mount({root,document,fetch});await flush();await flush();
 return {controller,nodes,calls,get locationCalls(){return locationCalls;}};
}
const configFixture=()=>({
 now:'2026-10-29T00:00:00Z',provider:{name:'AeroDataBox',status:'needs_credentials',configured:false,attribution:{label:'Data source',url:'https://aerodatabox.com/'}},
 airports:[{iata:'XMN',name:'测试出发机场',city:'厦门',lat:24.5,lon:118.1},{iata:'JJN',name:'测试附近机场',city:'泉州',search_cities:['厦门'],lat:24.8,lon:118.6}],
 destinations:[{code:'TH',name:'泰国',entry_status:'visa_free'}],booking_links:[{label:'航空公司官网',url:'https://www.example.com/booking'}],
 defaults:{city:'厦门',airports:[{iata:'XMN',travel_minutes:null}],ready_minutes:120,passport_country:'CN',entry_filter:'easy_entry',sort:'earliest_departure'},
 entry_notes:[{country:'TH',name:'泰国',note:'测试说明，不代表入境承诺',official_url:'https://www.example.com/entry'}]
});
const response=(data,ok=true)=>({ok,json:async()=>clone(data)});

test('mount loads private defaults without geolocation, assumptions or invented commute',async()=>{
 const state=await mounted(()=>response(configFixture()));
 assert.equal(state.calls.length,1);assert.equal(state.calls[0].options.method,'GET');assert.equal(state.locationCalls,0);
 assert.equal(state.nodes.get('travel-city').value,'厦门');assert.equal(state.nodes.get('travel-ready').value,'120');
 assert.equal(state.nodes.get('travel-passport').value,'CN');assert.equal(state.nodes.get('travel-entry').value,'easy_entry');
 assert.match(state.nodes.get('travel-airports').innerHTML,/测试附近机场/);
 assert.match(state.nodes.get('travel-airports').innerHTML,/data-airport-travel="XMN" value=""/);
 assert.doesNotMatch(state.nodes.get('travel-countries').innerHTML,/免签候选/);
 assert.match(state.nodes.get('travel-attribution').innerHTML,/aerodatabox\.com/);
 assert.match(state.nodes.get('travel-manual-links').innerHTML,/航空公司官网/);assert.equal(state.nodes.get('travel-manual-links').hidden,false);
 state.controller.destroy();
});

test('search transmits only planning values and failed requery clears prior flight recommendations',async()=>{
 let searches=0;
 const state=await mounted((url)=>url.endsWith('/config')?response(configFixture()):++searches===1?response({provider:{status:'live'},generated_at:'2026-10-29T00:00:00Z',flights:[fixture()],recommendation:fixture()}):response({error:'暂不可用'},false));
 await state.controller.search();
 assert.match(state.nodes.get('travel-flight-list').innerHTML,/TEST123/);
 const payload=JSON.parse(state.calls[1].options.body);
 assert.deepEqual(payload.airports,[{iata:'XMN',travel_minutes:null}]);assert.equal(payload.ready_minutes,120);
 assert.equal(payload.entry_filter,'easy_entry');assert.equal(payload.passport_country,'CN');assert.equal(Object.hasOwn(payload,'city'),false);
 await state.controller.search();
 assert.equal(state.nodes.get('travel-flight-list').innerHTML,'');assert.match(state.nodes.get('travel-summary').innerHTML,/本次查询未完成/);
 state.controller.destroy();
});

test('API key submits directly to backend, clears immediately and preserves edited filters',async()=>{
 const state=await mounted((url,options)=>{
  if(options.method==='POST'){const updated=configFixture();updated.provider.configured=true;return response(updated);}
  return response(configFixture());
 });
 state.nodes.get('travel-city').value='自选机场';state.nodes.get('travel-ready').value='240';state.nodes.get('travel-api-key').value='test-key-not-real';
 const saving=state.controller.saveSettings();assert.equal(state.nodes.get('travel-api-key').value,'');await saving;
 const request=state.calls[1];assert.equal(request.url,'/api/travel/config');assert.equal(request.options.method,'POST');assert.equal(request.options.credentials,'same-origin');
 assert.deepEqual(JSON.parse(request.options.body),{api_key:'test-key-not-real'});
 assert.equal(state.nodes.get('travel-city').value,'自选机场');assert.equal(state.nodes.get('travel-ready').value,'240');
 assert.doesNotMatch(state.nodes.get('travel-settings-status').textContent,/test-key-not-real/);
 assert.match(state.nodes.get('travel-settings-status').textContent,/已保存/);
 state.controller.destroy();
});

test('configuration save errors never echo credential-bearing server error text',async()=>{
 const state=await mounted((url,options)=>options.method==='POST'?response({error:'token secret-key-rejected'},false):response(configFixture()));
 state.nodes.get('travel-api-key').value='secret-key-rejected';await state.controller.saveSettings();
 assert.equal(state.nodes.get('travel-api-key').value,'');assert.match(state.nodes.get('travel-settings-status').textContent,/保存失败/);
 assert.doesNotMatch(state.nodes.get('travel-settings-status').textContent,/secret-key-rejected/);state.controller.destroy();
});
