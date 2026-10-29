/** Pure planning rules. Provider adapters must supply genuine source evidence. */
export const OFFER_FRESH_MS=15*60000;
export const SCHEDULE_FRESH_MS=30*60000;
export const ENTRY_FRESH_MS=24*3600000;
const MINUTE=60000,DAY=86400000;
const AIRLINES=['airchina.com.cn','airchina.com','ceair.com','csair.com','hnair.com','shenzhenair.com','scal.com.cn','juneyaoair.com','ch.com','airasia.com','thaiairways.com','lionairthai.com','vietjetair.com','vietnamairlines.com','ana.co.jp','jal.co.jp','jal.com','flypeach.com','jetstar.com','koreanair.com','flyasiana.com','jejuair.net','twayair.com','jinair.com','malaysiaairlines.com','batikair.com.my','singaporeair.com','flyscoot.com','cathaypacific.com','hkexpress.com','hongkongairlines.com','airmacau.com.mo','emirates.com','qatarairways.com','etihad.com','turkishairlines.com'];
const BOOKING=[...AIRLINES,'trip.com','ctrip.com','flights.ctrip.com','skyscanner.net','skyscanner.com','skyscanner.com.cn','qunar.com','google.com'];
const SOURCES=[...AIRLINES,'amadeus.com','api.amadeus.com','test.api.amadeus.com','developers.amadeus.com','aviationstack.com','api.aviationstack.com','airlabs.co','aerodatabox.com','aerodatabox.p.rapidapi.com','aerodatabox-lowcost.p.rapidapi.com','flightaware.com','aeroapi.flightaware.com','nkgairport.com','njairport.com','shairport.com','hangzhouairport.com','hzairport.com','szairport.com','bcia.com.cn','baiyunairport.com','airport-gz.com','ourairports.com'];
const ENTRY_HOSTS=['mfa.gov.cn','gov.cn','mofa.go.jp','emb-japan.go.jp','mofa.go.kr','visa.go.kr','mfa.go.th','immigration.go.th','imi.gov.my','kln.gov.my','ica.gov.sg','mfa.gov.sg','imigrasi.go.id','evisa.gov.vn','evisa.gov.kh','gov.kz','gov.uz','u.ae','mfa.gov.rs','geoconsul.gov.ge','iata.org','iatatravelcentre.com'];
const suffix=(host,list)=>list.some(root=>host===root||host.endsWith('.'+root));
const text=(value,limit=160)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,limit):'';
const iso=value=>new Date(value).toISOString();
export class FlightInputError extends Error{constructor(code,message){super(message);this.name='FlightInputError';this.code=code;this.status=400;}}
const invalid=(code,message)=>{throw new FlightInputError(code,message);};
function nowOf(options={}){const value=typeof options.now==='function'?options.now():options.now??Date.now();if(!Number.isSafeInteger(value)||value<1230768000000||value>4133980800000)invalid('INVALID_TIME','当前时间无效。');return value;}
function integer(value,fallback,min,max,name){if(value===undefined||value===null||value==='')return fallback;const n=typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;if(!Number.isSafeInteger(n)||n<min||n>max)invalid('INVALID_INPUT',`${name}超出可用范围。`);return n;}
const country=value=>typeof value==='string'&&/^[A-Za-z]{2}$/.test(value)?value.toUpperCase():null;
const iata=value=>typeof value==='string'&&/^[A-Za-z]{3}$/.test(value)?value.toUpperCase():null;
function validDateParts(year,month,date){const d=new Date(Date.UTC(year,month-1,date));return year>=2009&&year<=2100&&d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===date;}
export function timestampWithOffset(value){
 if(typeof value!=='string'||value.length>40)return null;
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
 if(!m||!validDateParts(+m[1],+m[2],+m[3])||+m[4]>23||+m[5]>59||+(m[6]||0)>59||m[8]!=='Z'&&(+m[10]>14||+m[11]>59||+m[10]===14&&+m[11]!==0))return null;
 const result=Date.parse(value);return Number.isSafeInteger(result)?result:null;
}
function inputDeparture(value,now){
 if(value==null||value===''||value==='now')return now;
 if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)){const [y,m,d]=value.split('-').map(Number);if(!validDateParts(y,m,d))invalid('INVALID_DATE','出发日期无效。');return Date.UTC(y,m-1,d)-8*3600000;}
 const result=timestampWithOffset(value);if(result===null)invalid('INVALID_DATE','出发时间需要有效日期及明确时区。');return result;
}
function coordinates(value){if(value==null)return null;if(typeof value!=='object'||Array.isArray(value)||typeof value.lat!=='number'||typeof value.lon!=='number'||!Number.isFinite(value.lat)||!Number.isFinite(value.lon)||Math.abs(value.lat)>90||Math.abs(value.lon)>180)invalid('INVALID_ORIGIN','位置坐标无效。');return {lat:value.lat,lon:value.lon};}
function countries(value,name){if(value==null)return [];if(!Array.isArray(value)||value.length>100)invalid('INVALID_INPUT',`${name}格式无效。`);const result=value.map(country);if(result.some(c=>!c))invalid('INVALID_INPUT',`${name}需使用两位国家代码。`);return [...new Set(result)];}
function timezone(value,fallback=null){try{if(typeof value!=='string'||value.length>64||value!=='UTC'&&!/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value))return fallback;new Intl.DateTimeFormat('en',{timeZone:value}).format(0);return value;}catch{return fallback;}}
export function normalizeSearchInput(input,options={}){
 const now=nowOf(options);if(!input||typeof input!=='object'||Array.isArray(input))invalid('INVALID_INPUT','请填写出发位置或机场。');
 const origin=coordinates(input.origin),raw=input.airports??[];
 if(!Array.isArray(raw)||raw.length>12)invalid('INVALID_AIRPORTS','一次最多选择 12 个出发机场。');
 const airports=[],seen=new Map();
 for(const item of raw){const code=iata(typeof item==='string'?item:item?.iata);if(!code)invalid('INVALID_AIRPORTS','机场需使用三位 IATA 代码。');const travel=integer(typeof item==='object'?item.travel_minutes:undefined,null,0,1440,'机场通勤时间');if(seen.has(code)){if(seen.get(code)!==travel)invalid('INVALID_AIRPORTS','同一机场的通勤时间有冲突。');continue;}seen.set(code,travel);airports.push({iata:code,travel_minutes:travel});}
 if(!origin&&!airports.length)invalid('ORIGIN_REQUIRED','请先选择出发位置或机场。');
 const passport=input.passport_country==null||input.passport_country===''?null:country(input.passport_country);if(input.passport_country&& !passport)invalid('INVALID_PASSPORT','护照国籍需使用两位国家代码。');
 const sort=input.sort??'earliest_departure';if(!['earliest_departure','earliest_arrival','cost'].includes(sort))invalid('INVALID_SORT','排序方式无效。');
 const entryFilter=input.entry_filter??'all';if(!['all','easy_entry'].includes(entryFilter))invalid('INVALID_ENTRY_FILTER','入境筛选方式无效。');
 const currency=input.currency??'CNY';if(typeof currency!=='string'||!/^[A-Za-z]{3}$/.test(currency))invalid('INVALID_CURRENCY','计价币种无效。');
 return {origin,airports,ready_minutes:integer(input.ready_minutes,0,0,10080,'准备时间'),international_buffer_minutes:integer(input.international_buffer_minutes,180,60,720,'国际航班提前到机场时间'),earliest_departure:iso(inputDeparture(input.earliest_departure,now)),sort,countries:countries(input.countries,'目的地国家'),passport_country:passport,document_countries:countries(input.document_countries,'已有入境证件国家'),entry_filter:entryFilter,max_distance_km:integer(input.max_distance_km,300,1,2000,'附近机场距离'),currency:currency.toUpperCase(),limit:integer(input.limit,50,1,100,'返回航班数量')};
}
export function haversineKm(a,b){const x=coordinates(a),y=coordinates(b);if(!x||!y)return null;const radians=n=>n*Math.PI/180,dlat=radians(y.lat-x.lat),dlon=radians(y.lon-x.lon),v=Math.sin(dlat/2)**2+Math.cos(radians(x.lat))*Math.cos(radians(y.lat))*Math.sin(dlon/2)**2;return 6371.0088*2*Math.atan2(Math.sqrt(Math.min(1,v)),Math.sqrt(Math.max(0,1-v)));}
export function safeFlightUrl(value,kind='source'){
 if(typeof value!=='string'||value.length>2048||/[\u0000-\u0020\u007f]/.test(value))return null;
 try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||u.hostname.endsWith('.')||!suffix(u.hostname,kind==='booking'?BOOKING:kind==='entry'?ENTRY_HOSTS:SOURCES))return null;
  for(const key of u.searchParams.keys())if(/^(?:access_?key|api_?key|client_?secret|token|access_?token|signature|authorization|password|credential|session_?id)$/i.test(key))return null;
  if(kind==='booking'&&(u.hostname==='google.com'||u.hostname.endsWith('.google.com'))&&!/^\/travel\/flights(?:\/|$)/.test(u.pathname))return null;
  return u.toString();
 }catch{return null;}
}
const fresh=(value,now,age)=>{const t=timestampWithOffset(value);return t!==null&&t<=now+60000&&now-t<=age;};
function airport(value,{destination=false}={}){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;const code=iata(value.iata);if(!code)return null;
 const result={iata:code,name:text(value.name,120)||code,city:text(value.city,80),time_zone:timezone(value.time_zone,destination?null:'Asia/Shanghai')};
 if(typeof value.lat==='number'&&typeof value.lon==='number'&&Number.isFinite(value.lat)&&Number.isFinite(value.lon)&&Math.abs(value.lat)<=90&&Math.abs(value.lon)<=180){result.lat=value.lat;result.lon=value.lon;}
 if(destination){const nation=country(value.country_code);if(!nation)return null;result.country_code=nation;result.country_name=text(value.country_name,80)||nation;}
 return result;
}
function validPrice(raw,availability,source,now){if(availability!=='confirmed_offer'||!source.url||!fresh(source.checked_at,now,OFFER_FRESH_MS)||!raw||typeof raw!=='object')return null;const amount=typeof raw.amount==='number'?String(raw.amount):raw.amount;if(typeof amount!=='string'||!/^\d{1,12}(?:\.\d{1,6})?$/.test(amount)||!Number.isFinite(Number(amount))||Number(amount)<=0||typeof raw.currency!=='string'||!/^[A-Za-z]{3}$/.test(raw.currency)||raw.checked_at&&!fresh(raw.checked_at,now,OFFER_FRESH_MS))return null;return {amount,currency:raw.currency.toUpperCase()};}
function normalizedFlight(raw,query,now){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return {exclude:'航班记录格式无效。',code:'invalid_flight'};
 const origin=airport(raw.origin),destination=airport(raw.destination,{destination:true}),departure=timestampWithOffset(raw.scheduled_departure),arrival=timestampWithOffset(raw.scheduled_arrival);
 const arrivalMissing=raw.scheduled_arrival==null||raw.scheduled_arrival==='';
 if(!origin||!destination||departure===null||!arrivalMissing&&arrival===null||arrival!==null&&(arrival<=departure||arrival-departure>2*DAY))return {exclude:'航班机场或时刻缺少可核实的日期、时区。',code:'invalid_schedule'};
 if(raw.nonstop!==true)return {exclude:'不是已明确标示的直飞航班。',code:'not_nonstop'};
 if(destination.country_code==='CN')return {exclude:'目的地为中国大陆。',code:'domestic'};
 if(query.airports.length&&!query.airports.some(a=>a.iata===origin.iata))return {exclude:'不在选择的出发机场中。',code:'origin_filtered'};
 if(query.countries.length&&!query.countries.includes(destination.country_code))return {exclude:'不在选择的目的地国家中。',code:'country_filtered'};
 const status=text(raw.status,40).toLowerCase()||'unknown';
 if(['cancelled','canceled','departed','active','enroute','en_route','airborne','landed','arrived','diverted'].includes(status)||departure<=now)return {exclude:'航班已取消、已出发或计划起飞时间已过。',code:'not_departing'};
 if(departure<Date.parse(query.earliest_departure))return {exclude:'早于选择的出发时间。',code:'before_window'};
 const distance=query.origin&&origin.lat!==undefined?haversineKm(query.origin,origin):null;
 if(query.origin&&distance!==null&&distance>query.max_distance_km)return {exclude:'超出选择的机场距离范围。',code:'outside_radius'};
 const source={name:text(raw.source?.name,100)||'来源待核实',url:safeFlightUrl(raw.source?.url),checked_at:timestampWithOffset(raw.source?.checked_at)!==null?iso(timestampWithOffset(raw.source.checked_at)):null,environment:['test','sandbox','demo'].includes(raw.source?.environment)?raw.source.environment:'production'};
 if(source.url&&new URL(source.url).hostname==='test.api.amadeus.com')source.environment='test';
 let availability=['confirmed_offer','schedule_only','unknown'].includes(raw.availability)?raw.availability:'unknown';
 if(source.environment!=='production'||raw.demo===true)availability='unknown';
 const booking=safeFlightUrl(raw.booking_url,'booking'),entryStatus=['visa_free','visa_on_arrival','visa_required','verify'].includes(raw.entry?.status)?raw.entry.status:'verify';
 const entry={status:entryStatus,official_url:safeFlightUrl(raw.entry?.official_url,'entry'),checked_at:timestampWithOffset(raw.entry?.checked_at)!==null?iso(timestampWithOffset(raw.entry.checked_at)):null,passport_country:country(raw.entry?.passport_country),note:text(raw.entry?.note,600)};
 if(query.entry_filter==='easy_entry'&&(!query.passport_country||entry.passport_country!==query.passport_country||!['visa_free','visa_on_arrival'].includes(entry.status)))return {exclude:'未能确认适用于该护照的免签或落地签候选。',code:'entry_filtered'};
 const travel=query.airports.find(a=>a.iata===origin.iata)?.travel_minutes??null,ready=now+query.ready_minutes*MINUTE,arriveBy=departure-query.international_buffer_minutes*MINUTE,airportArrival=travel===null?null:ready+travel*MINUTE,leaveBy=travel===null?null:arriveBy-travel*MINUTE,slack=airportArrival===null?null:(arriveBy-airportArrival)/MINUTE,reasons=[];
 const knownSource=!!source.url&&fresh(source.checked_at,now,SCHEDULE_FRESH_MS);
 const knownEntry=!!query.passport_country&&entry.passport_country===query.passport_country&&!!entry.official_url&&fresh(entry.checked_at,now,ENTRY_FRESH_MS)&&(['visa_free','visa_on_arrival'].includes(entry.status)||entry.status==='visa_required'&&query.document_countries.includes(destination.country_code));
 if(travel===null)reasons.push('尚未填写到该机场的实际通勤时间；直线距离不能代替道路时间。');
 if(arrival===null)reasons.push('到达时刻待核实；目前只能比较起飞时间。');
 if(!destination.time_zone)reasons.push('目的地时区待核实。');
 if(!/^[A-Z0-9]{2,3}\s?\d{1,4}[A-Z]?$/.test(text(raw.flight_number,24)))reasons.push('航班号待核实。');
 if(query.origin&&distance===null)reasons.push('该机场缺少坐标，无法核实是否位于附近。');
 if(!knownSource)reasons.push('航班来源或更新时间待核实。');
 if(!['scheduled','delayed','check_in','boarding'].includes(status))reasons.push('当前航班运行状态待核实。');
 if(availability!=='confirmed_offer'||!fresh(source.checked_at,now,OFFER_FRESH_MS))reasons.push('只有时刻或未确认报价，需进入航空公司核实余票与当前售价。');
 if(!booking)reasons.push('缺少可核实的官方或票务购票入口。');
 if(!knownEntry)reasons.push('需按你的护照、签证及出行材料重新核实入境条件。');
 if(source.environment!=='production'||raw.demo===true)reasons.push('来源为测试或演示数据，不能作为真实出行依据。');
 let disposition=reasons.length?'needs_verification':'actionable';
 if(slack!==null&&slack<0){disposition='too_late';reasons.unshift('按计划起飞时刻、准备时间和机场通勤，已赶不上预留的国际航班提前到场时间。');}
 const airline=typeof raw.airline==='string'?{name:text(raw.airline,100),iata:null}:{name:text(raw.airline?.name,100),iata:typeof raw.airline?.iata==='string'&&/^[A-Za-z0-9]{2}$/.test(raw.airline.iata)?raw.airline.iata.toUpperCase():null};
 return {flight:{id:text(raw.id,160)||`${origin.iata}-${destination.iata}-${departure}-${text(raw.flight_number,20)}`,flight_number:text(raw.flight_number,24)||'待核实',airline,origin,destination,scheduled_departure:iso(departure),scheduled_arrival:arrival===null?null:iso(arrival),estimated_departure:timestampWithOffset(raw.estimated_departure)!==null?iso(timestampWithOffset(raw.estimated_departure)):null,status,nonstop:true,booking_url:booking,source,availability,price:validPrice(raw.price,availability,source,now),entry,planning:{disposition,ready_at:iso(ready),arrive_by:iso(arriveBy),leave_by:leaveBy===null?null:iso(leaveBy),airport_arrival:airportArrival===null?null:iso(airportArrival),slack_minutes:slack===null?null:Math.floor(slack*10)/10,travel_minutes:travel,distance_km:distance===null?null:Math.round(distance*10)/10,reasons}}};
}
export function rankDepartures(flights,input,options={}){
 const now=nowOf(options),query=normalizeSearchInput(input,{now});if(!Array.isArray(flights)||flights.length>5000)invalid('INVALID_FLIGHTS','航班数据超过单次可核实范围。');
 const priority=f=>f.planning.disposition==='actionable'?0:f.planning.disposition==='too_late'?3:f.planning.travel_minutes===null?2:1;
 const results=[],excluded=[],seen=new Map();
 for(const raw of flights){
  const parsed=normalizedFlight(raw,query,now);
  if(parsed.exclude){excluded.push({id:text(raw?.id,160)||null,code:parsed.code,reason:parsed.exclude});continue;}
  const f=parsed.flight,key=[f.origin.iata,f.destination.iata,f.flight_number.replace(/\s/g,''),f.scheduled_departure].join('|');
  if(seen.has(key)){
   const index=seen.get(key),previous=results[index];
   // Keep the duplicate with better evidence, independent of provider order.
   const quality=priority(f)-priority(previous)||f.planning.reasons.length-previous.planning.reasons.length||(Date.parse(previous.source.checked_at)||0)-(Date.parse(f.source.checked_at)||0);
   const discarded=quality<0?previous:f;
   if(quality<0)results[index]=f;
   excluded.push({id:discarded.id,code:'duplicate',reason:'同一班次与时刻已列出，保留核实依据较完整的记录。'});continue;
  }
  seen.set(key,results.length);results.push(f);
 }
 const metric=f=>query.sort==='earliest_arrival'?f.scheduled_arrival===null?Infinity:Date.parse(f.scheduled_arrival):query.sort==='cost'?f.price&&f.price.currency===query.currency?Number(f.price.amount):Infinity:Date.parse(f.scheduled_departure);
 results.sort((a,b)=>priority(a)-priority(b)||(metric(a)-metric(b)||0)||Date.parse(a.scheduled_departure)-Date.parse(b.scheduled_departure)||a.flight_number.localeCompare(b.flight_number));
 const notices=[];if(query.entry_filter==='easy_entry'&&!query.passport_country)notices.push('筛选免签或落地签候选前，请先选择护照国籍。');if(query.sort==='cost')notices.push(`费用仅比较已核实报价且币种为 ${query.currency} 的航班；未核实或不同币种的价格不会当作零。`);
 return {checked_at:iso(now),query,results:results.slice(0,query.limit),excluded,summary:{total_received:flights.length,matched:results.length,returned:Math.min(results.length,query.limit),excluded_count:excluded.length,actionable:results.filter(f=>f.planning.disposition==='actionable').length,needs_verification:results.filter(f=>f.planning.disposition==='needs_verification').length,too_late:results.filter(f=>f.planning.disposition==='too_late').length,recommendation_id:results.find(f=>f.planning.disposition!=='too_late')?.id??null,notices}};
}
