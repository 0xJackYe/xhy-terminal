import {encryptJson,decryptJson,sha256Hex} from './crypto.mjs';
import {normalizeSearchInput,rankDepartures,FlightInputError} from './flights-core.mjs';
import {fetchAirportDepartures} from './flights-provider.mjs';
import {AIRPORTS,ENTRY_POLICIES,BOOKING_LINKS,enrichFlight} from './flights-catalog.mjs';
import {DESTINATION_AIRPORTS_BY_IATA} from './flights-airports.mjs';

export const TRAVEL_SCHEMA=[
 'CREATE TABLE IF NOT EXISTS travel_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_ms INTEGER NOT NULL)',
 'CREATE TABLE IF NOT EXISTS travel_cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_ms INTEGER NOT NULL)',
 'CREATE TABLE IF NOT EXISTS travel_usage(month TEXT PRIMARY KEY,requests INTEGER NOT NULL)',
 'CREATE TABLE IF NOT EXISTS travel_locks(name TEXT PRIMARY KEY,until_ms INTEGER NOT NULL)'
];
const MONTH_LIMIT=180,CACHE_MS=15*60000;
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const nowOf=o=>typeof o.now==='function'?o.now():o.now??Date.now();
async function initialize(env){for(const sql of TRAVEL_SCHEMA)await env.DB.prepare(sql).run();}
async function readPrivate(env){
 const row=await env.DB.prepare("SELECT value FROM travel_kv WHERE key='config'").first();
 if(!row)return {};
 if(!env.CONFIG_ENCRYPTION_KEY)throw new Error('Travel configuration unavailable');
 return await decryptJson(row.value,env.CONFIG_ENCRYPTION_KEY);
}
function keyOf(env,config){return config.api_key||env.AERODATABOX_API_KEY||null;}
function provider(key,status){return {name:'AeroDataBox',configured:!!key,status:status||(key?'configured':'needs_credentials'),attribution:{label:'航班数据来源 AeroDataBox',url:'https://aerodatabox.com/'},pricing_url:'https://aerodatabox.com/pricing',scope:'计划航班，不提供可售余票；每次查询未来12小时。'};}
function publicConfig(env,config,now){
 return {now:new Date(now).toISOString(),airports:AIRPORTS,destinations:ENTRY_POLICIES.map(({code,name,entry_status,official_url})=>({code,name,entry_status,official_url})),entry_notes:ENTRY_POLICIES,booking_links:BOOKING_LINKS,defaults:config.defaults||{},provider:provider(keyOf(env,config)),quota:{monthly_request_limit:MONTH_LIMIT,units_per_airport_query:2,note:'本终端每月最多180个机场请求，约360 API units。仅统计本终端；供应商剩余额度以你的账户为准。'}};
}
async function bodyOf(request){const text=await request.text();if(text.length>16000)throw new FlightInputError('BODY_TOO_LARGE','请求内容过大。');try{return JSON.parse(text);}catch{throw new FlightInputError('INVALID_JSON','请求内容格式无效。');}}
async function airportFlights(env,airport,key,from,to,now,options){
 const epoch=(await sha256Hex(key)).slice(0,16),cacheKey=['v2',epoch,airport.iata,from,to].join(':');
 const cached=await env.DB.prepare('SELECT value,updated_ms FROM travel_cache WHERE key=?').bind(cacheKey).first();
 if(cached&&now>=cached.updated_ms&&now-cached.updated_ms<CACHE_MS)return {...JSON.parse(cached.value),cached:true};
 const month=new Date(now).toISOString().slice(0,7);
 const charge=await env.DB.prepare('INSERT INTO travel_usage(month,requests) VALUES(?,1) ON CONFLICT(month) DO UPDATE SET requests=requests+1 WHERE requests<? RETURNING requests').bind(month,MONTH_LIMIT).first();
 if(!charge)throw new FlightInputError('LOCAL_QUOTA','本终端本月航班查询上限已到；请使用航空公司官网查询。');
 const result=await fetchAirportDepartures({airport,airportsByIata:DESTINATION_AIRPORTS_BY_IATA,apiKey:key,from,to,now,timeoutMs:options.providerTimeoutMs??8000,fetchImpl:options.fetchImpl||fetch});
 if(result.metadata?.status!=='ok')throw new Error('Provider not configured');
 await env.DB.prepare('INSERT INTO travel_cache(key,value,updated_ms) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_ms=excluded.updated_ms').bind(cacheKey,JSON.stringify(result),now).run();
 return {...result,cached:false};
}
export async function handleTravel(request,env,options={}){
 const path=new URL(request.url).pathname;if(!path.startsWith('/api/travel/'))return null;
 if(!['/api/travel/config','/api/travel/search'].includes(path))return json({error:'航班接口不存在。'},404);
 if(path.endsWith('/config')&&!['GET','POST'].includes(request.method)||path.endsWith('/search')&&request.method!=='POST')return json({error:'请求方法不支持。'},405);
 try{
  const now=nowOf(options);await initialize(env);let config=await readPrivate(env);
  if(path.endsWith('/config')){
   if(request.method==='POST'){
    const input=await bodyOf(request),key=input?.api_key;
    if(typeof key!=='string'||!/^[A-Za-z0-9._-]{16,250}$/.test(key))return json({error:'请填写有效的 RapidAPI Key。'},400);
    if(!env.CONFIG_ENCRYPTION_KEY)return json({error:'云端私密配置尚未就绪。'},503);
    config={...config,api_key:key};
    await env.DB.prepare("INSERT INTO travel_kv(key,value,updated_ms) VALUES('config',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_ms=excluded.updated_ms").bind(await encryptJson(config,env.CONFIG_ENCRYPTION_KEY),now).run();
   }
   return json(publicConfig(env,config,now));
  }
  const input=await bodyOf(request);
  // Date controls are Beijing calendar dates; core rejects invalid dates.
  const query=normalizeSearchInput({...input,earliest_departure:input.departure_date??input.earliest_departure,sort:input.sort==='price'?'cost':input.sort},{now});
  if(input.departure_date&&input.departure_date<new Date(now+8*3600000).toISOString().slice(0,10))return json({error:'请选择今天或之后的出发日期。'},400);
  if(!query.airports.length||query.airports.length>6)return json({error:'请一次选择1至6个出发机场。'},400);
  if(query.airports.some(a=>!AIRPORTS.some(b=>b.iata===a.iata)))return json({error:'请选择机场列表中的出发机场。'},400);
  if(Date.parse(query.earliest_departure)>now+30*86400000)return json({error:'请查询未来30日以内的出发日期。'},400);
  const key=keyOf(env,config),base={generated_at:new Date(now).toISOString(),provider:provider(key),flights:[],recommendation:null,earliest_candidate:null,warnings:[],booking_links:BOOKING_LINKS,airport_links:[]};
  if(!key){base.warnings=['尚未配置航班 API Key；这里没有使用演示航班。请先在“航班数据设置”填写 Key，再查询真实时刻。'];return json(base);}
  const lock=await env.DB.prepare("INSERT INTO travel_locks(name,until_ms) VALUES('search',?) ON CONFLICT(name) DO UPDATE SET until_ms=excluded.until_ms WHERE until_ms<=? RETURNING name").bind(now+45000,now).first();
  if(!lock)return json({error:'另一个航班查询正在进行，请稍后再试。'},429);
  try{
   const from=new Date(Math.floor(Math.max(now,Date.parse(query.earliest_departure))/1800000)*1800000).toISOString(),to=new Date(Date.parse(from)+12*3600000).toISOString();
   const raw=[],errors=[],providerErrors=[];let successful=0,cacheCount=0,retryAfter=null;
   const wallNow=options.wallNow||Date.now,deadline=wallNow()+30000;
   for(const [index,chosen] of query.airports.entries()){
    if(deadline-wallNow()<2000){errors.push('查询时间已到，剩余机场未查询；请缩小机场范围后重试。');break;}
    if(index)await (options.pause||((ms)=>new Promise(resolve=>setTimeout(resolve,ms))))(1100);
    const remaining=deadline-wallNow();if(remaining<2000){errors.push('查询时间已到，剩余机场未查询；请缩小机场范围后重试。');break;}
    try{const data=await airportFlights(env,AIRPORTS.find(a=>a.iata===chosen.iata),key,from,to,now,{...options,providerTimeoutMs:Math.min(8000,remaining-1000)});raw.push(...data.flights.map(f=>enrichFlight(f,query.passport_country)));successful++;if(data.cached)cacheCount++;}
    catch(error){
     const code=typeof error.code==='string'&&/^[A-Z_]{1,48}$/.test(error.code)?error.code:'LOCAL_PROCESSING_ERROR';
     providerErrors.push({airport:chosen.iata,code,upstream_status:Number.isInteger(error.upstream_status)?error.upstream_status:null,error_name:/^[A-Za-z]{1,32}$/.test(error.name||'')?error.name:'Error',detail:code==='LOCAL_PROCESSING_ERROR'?String(error.message||'').split(key).join('[redacted]').replace(/[A-Za-z0-9._-]{40,}/g,'[redacted]').slice(0,180):null});
     errors.push(chosen.iata+'：'+(error.code==='LOCAL_QUOTA'?error.message:error.code==='PROVIDER_RATE_LIMITED'?'航班服务额度或频率受限，已停止其余机场查询。':error.code==='PROVIDER_TIMEOUT'?'航班源响应超时，请稍后重试。':'航班源未能返回可核实数据，请检查 Key、套餐权限或稍后重试。'));if(['LOCAL_QUOTA','PROVIDER_RATE_LIMITED','PROVIDER_AUTH_FAILED'].includes(error.code)){retryAfter=error.retry_after_seconds??null;break;}
    }
   }
   const ranked=rankDepartures(raw,query,{now});
   return json({...base,provider:provider(key,successful?'live':'error'),flights:ranked.results,recommendation:ranked.results.find(f=>f.planning.disposition==='actionable')||null,earliest_candidate:ranked.results.find(f=>f.planning.disposition!=='too_late')||null,window:{from,to},summary:ranked.summary,cached_airports:cacheCount,provider_errors:providerErrors,retry_after_seconds:retryAfter,warnings:[...errors,...ranked.summary.notices,'仅覆盖上述12小时时段和所选机场；数据源可能缺漏。没有候选不代表没有航班。','排序使用计划起飞时间，已加入准备、交通和提前到场时间。时刻表不代表余票；下单前到航空公司核实。','免签仍需满足入境条件并完成相关申报；政策链接提供官方核验入口。']});
  }finally{await env.DB.prepare("DELETE FROM travel_locks WHERE name='search' AND until_ms=?").bind(now+45000).run();await env.DB.prepare('DELETE FROM travel_cache WHERE updated_ms<?').bind(now-86400000).run();}
 }catch(error){return json({error:error instanceof FlightInputError?error.message:'航班服务暂时不可用，请稍后重试。'},error instanceof FlightInputError?400:503);}
}
