import {connectionIdentity,sha256,validateCredentials} from './exchange.mjs';
import {PRICE_INDEX_FIELDS} from './finance-price-periods.mjs';

// This namespace is private to the Worker. It is never a public static asset
// or a substitute for the request's normal owner authentication.
export const FINANCE_BACKUP_KEY='finance-snapshots-v1';
export const FINANCE_BACKUP_REVOKED_KEY='finance-snapshots-revoked-v1';
const VERSION=1,INTERVAL=5*60000,MAX_BYTES=4*1024*1024;
const KEYS=['okx','portfolio','combined','btc_cost','btc_pnl','market','dca_diary'];
const pending=new WeakMap(),recent=new WeakMap();
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const decimal=value=>typeof value==='string'&&value.length<=512&&/^-?\d+(?:\.\d+)?$/.test(value);
const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const copy=value=>structuredClone(value);
function observed(value){
  for(const key of ['updated_at','last_success_at','as_of','quote_at'])if(time(value?.[key]))return Date.parse(value[key]);
  return null;
}
function usable(key,value){
  if(!object(value))return false;
  if(key==='combined')return value.ok===true&&object(value.totals)&&decimal(value.totals.btc)&&Array.isArray(value.sources)&&Array.isArray(value.history)&&object(value.pnl)&&time(value.updated_at);
  if(key==='portfolio')return Array.isArray(value.assets)&&Array.isArray(value.locations)&&Array.isArray(value.sources)&&object(value.binance)&&decimal(value.total_usd)&&time(value.updated_at);
  if(key==='okx')return value.configured===true&&typeof value.connection_id==='string'&&Array.isArray(value.assets)&&object(value.summary)&&time(value.last_success_at);
  if(key==='btc_cost')return ['fresh','stale'].includes(value.status)&&object(value.summary)&&typeof value.connection_id==='string'&&time(value.last_success_at);
  if(key==='btc_pnl')return ['fresh','stale'].includes(value.status)&&object(value.metrics)&&typeof value.connection_id==='string'&&observed(value)!==null;
  if(key==='market')return decimal(value.price_usdt)&&time(value.updated_at);
  return Array.isArray(value.days)&&Array.isArray(value.fields)&&object(value.totals);
}

// Match finance.mjs transferConnection exactly, without consulting D1 during
// an outage. A UI-only credential override intentionally fails this check.
export async function financeBackupScope(env){
  try{
    const okx=validateCredentials({api_key:env.OKX_API_KEY,secret_key:env.OKX_SECRET_KEY,passphrase:env.OKX_PASSPHRASE},'okx');
    if(typeof env.WALLET_ADDRESS!=='string'||!env.WALLET_ADDRESS)return null;
    let binance='not_connected';try{binance=await connectionIdentity(validateCredentials({api_key:env.BINANCE_API_KEY,secret_key:env.BINANCE_SECRET_KEY},'binance'));}catch{}
    return await sha256(JSON.stringify([await connectionIdentity(okx),binance,env.WALLET_ADDRESS]));
  }catch{return null;}
}
function binding(env,write=false){const kv=env?.FINANCE_BACKUP;return kv&&typeof kv.get==='function'&&(!write||typeof kv.put==='function')?kv:null;}
async function record(kv,scope){
  if(await kv.get(FINANCE_BACKUP_REVOKED_KEY)===scope)return null;
  const raw=await kv.get(FINANCE_BACKUP_KEY,{type:'json'});
  let value;try{value=typeof raw==='string'?JSON.parse(raw):raw;}catch{return null;}
  if(!object(value)||value.version!==VERSION||value.scope!==scope||!Number.isSafeInteger(value.updated_ms)||value.updated_ms<=0||!object(value.snapshots))return null;
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>MAX_BYTES)return null;
  const snapshots={};for(const key of KEYS)if(usable(key,value.snapshots[key]))snapshots[key]=copy(value.snapshots[key]);
  return Object.keys(snapshots).length?{version:VERSION,scope,updated_ms:value.updated_ms,snapshots}:null;
}
const PRIVATE_FIELDS=new Set(['internal_transfers','transfer_manifest','transfer_connection','internal_transfer_adjustment','transfer_ids','txid','proof','secret_key','api_key','passphrase','access_key','AUTH_SECRET','OWNER_ACCESS_KEY','CONFIG_ENCRYPTION_KEY','BINANCE_API_KEY','BINANCE_SECRET_KEY','OKX_API_KEY','OKX_SECRET_KEY','OKX_PASSPHRASE']);
function publicValue(value){
  if(Array.isArray(value))return value.map(publicValue);
  if(!object(value))return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!PRIVATE_FIELDS.has(key)&&!/^(?:.*(?:api[_-]?key|secret[_-]?key|access[_-]?key)|passphrase|authorization|cookie|auth_secret|config_encryption_key)$/i.test(key)).map(([key,item])=>[key,publicValue(item)]));
}
function staleSnapshot(key,source,saved){
  const value=publicValue(copy(source)),savedAt=new Date(saved).toISOString();
  const original=observed(source)??saved,beijing=new Date(original+8*3600000).toISOString().slice(0,16).replace('T',' ');
  const note='数据库暂不可用，显示只读备份（数据截至 '+beijing+' 北京时间），等待自动恢复。';
  value.stale=true;value.backup={read_only:true,saved_at:savedAt,observed_at:new Date(original).toISOString(),note};
  if(['okx','btc_cost','btc_pnl','dca_diary'].includes(key)){value.status='stale';value.error=note;}
  if(key==='portfolio'){
    value.complete=false;value.scope_note=note;
    value.sources=value.sources.map(row=>object(row)?{...row,status:'stale'}:row);
    value.binance={...value.binance,status:'stale',stale:true,error:note};
  }
  if(key==='combined'){
    value.coverage={...(object(value.coverage)?value.coverage:{}),complete:false,note};
    value.sources=value.sources.map(row=>object(row)?{...row,status:'stale'}:row);
    value.history=value.history.map(point=>{if(!object(point))return point;const row={...point};for(const field of PRICE_INDEX_FIELDS)delete row[field];return row;});
    for(const period of Object.values(value.pnl))if(object(period)){period.stale=true;period.status='stale';period.reason=note;}
    if(usable('btc_pnl',value.lifetime_pnl))value.lifetime_pnl=staleSnapshot('btc_pnl',value.lifetime_pnl,saved);
  }
  if(key==='dca_diary'){delete value.key;delete value.connection;}
  return value;
}

export async function readFinanceBackup(env,key){
  if(!KEYS.includes(key))return null;
  try{
    const kv=binding(env),scope=await financeBackupScope(env);if(!kv||!scope)return null;
    const stored=await record(kv,scope);if(!stored)return null;
    // These two endpoints must describe the same stored position, including
    // its original quote/holding dates, rather than independently timed reads.
    const source=key==='btc_pnl'&&usable('btc_pnl',stored.snapshots.combined?.lifetime_pnl)?stored.snapshots.combined.lifetime_pnl:stored.snapshots[key];
    return usable(key,source)?staleSnapshot(key,source,stored.updated_ms):null;
  }catch{return null;}
}

async function saveOnce(env,bundle,{scope,now=Date.now,force=false}={}){
  const kv=binding(env,true),at=typeof now==='function'?now():now;
  if(!kv)return {saved:false,reason:'unavailable'};
  const runtimeScope=await financeBackupScope(env);
  if(!runtimeScope||scope!==runtimeScope)return {saved:false,reason:'scope_mismatch'};
  if(!object(bundle)||!Number.isSafeInteger(at)||at<=0)return {saved:false,reason:'invalid'};
  try{
    if(await kv.get(FINANCE_BACKUP_REVOKED_KEY)===scope)return {saved:false,reason:'scope_mismatch'};
    const previous=await record(kv,scope),last=recent.get(kv);
    if(previous&&at<previous.updated_ms)return {saved:false,reason:'invalid'};
    if(!force&&(previous&&at-previous.updated_ms<INTERVAL||last?.scope===scope&&at-last.at<INTERVAL))return {saved:false,reason:'throttled'};
    const snapshots={...(previous?.snapshots||{})};let supplied=0;
    for(const key of KEYS){
      const incoming=bundle[key];if(!usable(key,incoming))continue;
      const before=observed(snapshots[key]),after=observed(incoming);
      if(snapshots[key]&&before!==null&&(after===null||after<before))continue;
      snapshots[key]=copy(incoming);supplied++;
    }
    if(!supplied)return {saved:false,reason:'invalid'};
    const position=snapshots.combined?.lifetime_pnl;
    if(usable('btc_pnl',position))snapshots.btc_pnl=copy(position);
    const value={version:VERSION,scope,updated_ms:at,snapshots};
    const raw=JSON.stringify(value);if(new TextEncoder().encode(raw).byteLength>MAX_BYTES)return {saved:false,reason:'invalid'};
    await kv.put(FINANCE_BACKUP_KEY,raw);recent.set(kv,{scope,at});return {saved:true,reason:'saved'};
  }catch{return {saved:false,reason:'write_failed'};}
}
export async function saveFinanceBackup(env,bundle,options={}){
  const kv=binding(env,true);if(!kv)return {saved:false,reason:'unavailable'};
  // Coalesce concurrent callers inside one isolate. The scheduled finance
  // writer's existing D1 lease serializes writers across Worker isolates.
  const before=pending.get(kv)||Promise.resolve();
  const work=before.catch(()=>{}).then(()=>saveOnce(env,bundle,options));pending.set(kv,work);
  try{return await work;}finally{if(pending.get(kv)===work)pending.delete(kv);}
}
