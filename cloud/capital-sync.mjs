/** Incremental C2C capital accounting. Clients are already verified read-only. */
import {dec,txt,iso} from './cost-book.mjs';

const DAY=86400000,LEASE=15*60000,OVERLAP=2*DAY,MAX_CALLS=18;
const KEY='portfolio_capital_ledger',LOCK='portfolio_capital_sync_lock',STATUS='portfolio_capital_sync';
const messages={needs_history:'尚未导入已核对的总入金账本。',identity_changed:'入金账本与当前账户不一致，等待重新核对。',identity_check_required:'入金账户校验尚未配置。',history_gap:'资金记录存在超出接口窗口的缺口，需补齐后重算。',page_limit:'新增资金记录超出单次核对上限，原本金保持不变。',invalid_response:'资金记录未通过校验，原本金保持不变。',conflicting_cashflow:'同一资金记录的内容出现冲突，需核对后重算。',non_usdt_cost_unknown:'发现新的非 USDT 直接买币记录，原始 USDT 等值成本需要核对。',rate_limited:'资金数据源正在限流，稍后自动重试。',provider_unavailable:'资金数据源暂时不可用，保留原本金。',storage_unavailable:'资金账本暂时无法保存，原本金保持不变。',concurrent_change:'资金账本已被另一任务更新，本次未覆盖。'};
class SyncError extends Error{constructor(code,details={}){super(code);this.code=code;this.details=details;}}
const fail=(code,details)=>{throw new SyncError(code,details);};
const valueNow=clock=>typeof clock==='function'?clock():clock;
const validTime=value=>Number.isSafeInteger(value)&&value>1230768000000&&value<4102444800000;
const id=value=>typeof value==='string'&&/^\d{1,50}$/.test(value)?value:fail('invalid_response');
const identity=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function amount(value){try{if(typeof value!=='string'||value.length>180||!/^[-+]?\d+(?:\.\d+)?$/.test(value))fail('invalid_response');const result=dec(value);if(result.abs().gt('1e40'))fail('invalid_response');return result;}catch{fail('invalid_response');}}
async function read(env,key){const row=await env.DB.prepare('SELECT value FROM finance_kv WHERE key=?').bind(key).first();if(!row)return null;try{return {serialized:row.value,value:JSON.parse(row.value)};}catch{fail('storage_unavailable');}}
const statement=(env,key,value,at)=>env.DB.prepare('INSERT INTO finance_kv(key,value,updated_ms) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_ms=excluded.updated_ms').bind(key,JSON.stringify(value),at);
function safeFlow(row){
 if(!row||typeof row!=='object'||!validTime(row.at_ms)||typeof row.id!=='string'||!(/^(?:okx|binance)-c2c:\d{1,50}$/).test(row.id)||typeof row.asset!=='string'||!(/^[A-Z0-9]{1,20}$/).test(row.asset))fail('invalid_response');
 const cash=amount(row.amount_usdt);if(cash.isZero())fail('invalid_response');
 const result={id:row.id,at_ms:row.at_ms,amount_usdt:txt(cash),source:row.id.startsWith('okx-')?'OKX C2C':'Binance C2C',asset:row.asset,method:row.asset==='USDT'?(row.id.startsWith('okx-')?'exact_reported_usdt_balance_change':'exact_reported_usdt_quantity'):'reported_order_fx_usdt_equivalent_estimate'};
 if(row.source_quantity!=null)result.source_quantity=txt(amount(row.source_quantity));
 return result;
}
function matching(previous,candidate,{quantity=false}={}){
 if(previous.asset!==candidate.asset||Math.abs(previous.at_ms-candidate.at_ms)>=1000)fail('conflicting_cashflow');
 if(quantity){if(previous.source_quantity==null||candidate.source_quantity==null||!amount(previous.source_quantity).eq(candidate.source_quantity)||amount(previous.amount_usdt).isNegative()!==amount(candidate.amount_usdt).isNegative())fail('conflicting_cashflow');}
 else if(!amount(previous.amount_usdt).eq(candidate.amount_usdt))fail('conflicting_cashflow');
}
function summary(flows){
 let incoming=dec('0'),outgoing=dec('0');
 for(const row of flows){const value=dec(row.amount_usdt);if(value.isNegative())incoming=incoming.sub(value);else outgoing=outgoing.add(value);}
 return {flow_count:flows.length,deposited_usdt:txt(incoming),withdrawn_usdt:txt(outgoing),net_contributed_usdt:txt(incoming.sub(outgoing)),first_at:flows.length?iso(flows[0].at_ms):null,last_at:flows.length?iso(flows.at(-1).at_ms):null};
}
function sixMonthStart(end){const date=new Date(end),month=date.getUTCMonth()-6;const first=new Date(Date.UTC(date.getUTCFullYear(),month,1,date.getUTCHours(),date.getUTCMinutes(),date.getUTCSeconds(),date.getUTCMilliseconds()));const last=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();first.setUTCDate(Math.min(date.getUTCDate(),last));return first.getTime()+60000;}
function checkedAt(ledger){const raw=ledger.last_checked_ms??ledger.coverage?.last_checked_ms;const result=raw??Date.parse(ledger.coverage?.okx_source_as_of||ledger.source_as_of||'');if(!validTime(result))fail('history_gap');return result;}

/**
 * getCurrentIdentities() must return {identity,binance_identity} from current
 * configuration. It is called before network reads and immediately before CAS.
 * Force skips a completed run's cooldown, never an unexpired running lease.
 */
export async function syncPortfolioCashflows(env,{okxClient,binanceClient,now=Date.now,force=false,expectedIdentity,expectedBinanceIdentity,getCurrentIdentities}={}){
 const at=valueNow(now);let original=null,lockValue=null,token=null,phase='storage',previousStatus=null;
 if(!validTime(at))return {ok:false,status:'error',code:'invalid_response',error:messages.invalid_response};
 const identitiesMatch=actual=>actual?.identity===expectedIdentity&&actual?.binance_identity===expectedBinanceIdentity;
 async function verify(){if(typeof getCurrentIdentities!=='function')fail('identity_check_required');if(!identitiesMatch(await getCurrentIdentities()))fail('identity_changed');}
 async function recordFailure(code,details={}){
  const state=code==='needs_history'||code==='history_gap'||code==='non_usdt_cost_unknown'||code==='identity_changed'||code==='conflicting_cashflow'?'needs_review':'error';
  const result={ok:false,status:state,code,error:messages[code]||messages.provider_unavailable,last_attempt_ms:at,last_success_ms:previousStatus?.last_success_ms??null,...details};
  if(original&&lockValue){
   const guard='(SELECT value FROM finance_kv WHERE key=?)=? AND (SELECT value FROM finance_kv WHERE key=?)=?';
   await env.DB.batch([
    env.DB.prepare('INSERT INTO finance_kv(key,value,updated_ms) SELECT ?,?,? WHERE '+guard+' ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_ms=excluded.updated_ms').bind(STATUS,JSON.stringify(result),at,KEY,original.serialized,LOCK,lockValue),
    env.DB.prepare('UPDATE finance_kv SET value=?,updated_ms=? WHERE key=? AND value=?').bind(JSON.stringify({token,running:false}),at,LOCK,lockValue),
   ]);
  }else if(!original)await statement(env,STATUS,result,at).run();
  return result;
 }
 try{
  original=await read(env,KEY);previousStatus=(await read(env,STATUS))?.value;
  if(!original)fail('needs_history');
  const ledger=original.value;
  if(!identity(expectedIdentity)||!identity(expectedBinanceIdentity)||ledger.identity!==expectedIdentity||ledger.binance_identity!==expectedBinanceIdentity)fail('identity_changed');
  await verify();
  if(!okxClient||typeof okxClient.get!=='function'||!binanceClient||typeof binanceClient.get!=='function')fail('provider_unavailable');
  token=crypto.randomUUID();lockValue=JSON.stringify({token,running:true});
  const acquired=await env.DB.prepare('INSERT INTO finance_kv(key,value,updated_ms) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_ms=excluded.updated_ms WHERE (COALESCE(json_extract(finance_kv.value,\'$.running\'),0)=1 AND finance_kv.updated_ms<=?) OR (COALESCE(json_extract(finance_kv.value,\'$.running\'),0)!=1 AND (?=1 OR finance_kv.updated_ms<=?))').bind(LOCK,lockValue,at,at-LEASE,force?1:0,at-LEASE).run();
  if(!acquired.meta?.changes){lockValue=null;return {ok:true,skipped:true,status:'cooldown'};}
  const last=checkedAt(ledger),end=at,boundary=sixMonthStart(end),begin=Math.max(last-OVERLAP,boundary);
  if(last>end+120000||last<boundary)fail('history_gap');
  const known=new Map();
  if(!Array.isArray(ledger.flows)||ledger.flows.length>10000)fail('invalid_response');
  for(const raw of ledger.flows){const row=safeFlow(raw);if(known.has(row.id))fail('conflicting_cashflow');known.set(row.id,row);}
  const before=known.size,reviewAssets=new Set();let calls=0,ignoredCancelled=0;
  async function get(client,path,params){if(++calls>MAX_CALLS)fail('page_limit');return client.get(path,params);}
  phase='provider';
  for(const type of ['116','117','118']){
   let after;const seen=new Set();
   for(let page=0;page<3;page++){
    const params={type,limit:100,pagingType:'2'};if(after)params.after=after;
    const rows=await get(okxClient,'/api/v5/asset/bills-history',params);
    if(!Array.isArray(rows)||rows.length>100)fail('invalid_response');
    let oldest=end;
    for(const raw of rows){
     const bill=id(raw?.billId),stamp=Number(raw.ts);
     if(raw.type!==type||seen.has(bill)||!validTime(stamp)||stamp>end+120000)fail('invalid_response');seen.add(bill);oldest=Math.min(oldest,stamp);
     if(stamp<begin||stamp>end)continue;
     if(typeof raw.ccy!=='string'||!(/^[A-Z0-9]{1,20}$/).test(raw.ccy))fail('invalid_response');
     const change=amount(raw.balChg);if(change.isZero())continue;
     const row={id:'okx-c2c:'+bill,at_ms:stamp,amount_usdt:txt(change.neg()),asset:raw.ccy,source:'OKX C2C',method:'exact_reported_usdt_balance_change'};
     const old=known.get(row.id);
     if(raw.ccy!=='USDT'){if(!old)reviewAssets.add(raw.ccy);else matching(old,{...row,source_quantity:txt(change.abs())},{quantity:true});continue;}
     if(old)matching(old,row);else known.set(row.id,row);
    }
    if(rows.length<100||oldest<begin)break;
    if(page===2)fail('page_limit');after=id(rows.at(-1).billId);
   }
  }
  for(let start=begin;start<=end;){
   const stop=Math.min(start+30*DAY-1,end);
   for(const side of ['BUY','SELL']){
    const seen=new Set();let expected=null;
    for(let page=1;page<=3;page++){
     const body=await get(binanceClient,'/sapi/v1/c2c/orderMatch/listUserOrderHistory',{tradeType:side,startTimestamp:start,endTimestamp:stop,page,rows:100,recvWindow:5000});
     if(body?.code!=='000000'||body.success!==true||!Array.isArray(body.data)||body.data.length>100||!Number.isSafeInteger(body.total)||body.total<0||expected!==null&&body.total!==expected)fail('invalid_response');
     expected=body.total;
     for(const raw of body.data){
      const order=id(raw?.orderNumber),stamp=raw.createTime;
      if(seen.has(order)||raw.tradeType!==side||!validTime(stamp)||stamp<start||stamp>stop||typeof raw.asset!=='string'||!(/^[A-Z0-9]{1,20}$/).test(raw.asset))fail('invalid_response');seen.add(order);
      if(!['PENDING','TRADING','BUYER_PAYED','DISTRIBUTING','COMPLETED','IN_APPEAL','CANCELLED','CANCELLED_BY_SYSTEM'].includes(raw.orderStatus))fail('invalid_response');
      if(raw.orderStatus!=='COMPLETED'){ignoredCancelled++;continue;}
      const quantity=amount(raw.amount);if(!quantity.gt(0))fail('invalid_response');
      const row={id:'binance-c2c:'+order,at_ms:stamp,amount_usdt:txt(side==='BUY'?quantity.neg():quantity),asset:raw.asset,source:'Binance C2C',method:'exact_reported_usdt_quantity',source_quantity:txt(quantity)};
      const old=known.get(row.id);
      if(raw.asset!=='USDT'){if(!old)reviewAssets.add(raw.asset);else matching(old,row,{quantity:true});continue;}
      if(old)matching(old,row);else known.set(row.id,row);
     }
     if(seen.size===expected)break;
     if(seen.size>expected||body.data.length<100||page===3)fail('page_limit');
    }
   }
   start=stop+1;
  }
  if(reviewAssets.size)fail('non_usdt_cost_unknown',{assets:[...reviewAssets].sort()});
  await verify();phase='storage';
  const flows=[...known.values()].sort((a,b)=>a.at_ms-b.at_ms||a.id.localeCompare(b.id));
  const next={...ledger,flows,last_checked_ms:end,updated_at:iso(end),summary:{...ledger.summary,
   combined_c2c:summary(flows),okx_c2c:summary(flows.filter(r=>r.id.startsWith('okx-'))),binance_c2c:summary(flows.filter(r=>r.id.startsWith('binance-'))),
   binance_exact_usdt:summary(flows.filter(r=>r.id.startsWith('binance-')&&r.asset==='USDT')),all_exact_usdt_quantity_only:summary(flows.filter(r=>r.asset==='USDT')),non_usdt_direct_purchase_equivalents:summary(flows.filter(r=>r.asset!=='USDT'))},coverage:{...ledger.coverage,last_checked_ms:end,dynamic_c2c_checked_until:iso(end)}};
  const serialized=JSON.stringify(next);if(new TextEncoder().encode(serialized).byteLength>1800000)fail('page_limit');
  const status={ok:true,status:'fresh',last_attempt_ms:at,last_success_ms:end,last_checked_ms:end,new_flows:known.size-before,flow_count:known.size,ignored_uncompleted:ignoredCancelled,code:null,error:null};
  const results=await env.DB.batch([
   env.DB.prepare('UPDATE finance_kv SET value=?,updated_ms=? WHERE key=? AND value=? AND (SELECT value FROM finance_kv WHERE key=?)=?').bind(serialized,end,KEY,original.serialized,LOCK,lockValue),
   env.DB.prepare('INSERT INTO finance_kv(key,value,updated_ms) SELECT ?,?,? WHERE (SELECT value FROM finance_kv WHERE key=?)=? AND (SELECT value FROM finance_kv WHERE key=?)=? ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_ms=excluded.updated_ms').bind(STATUS,JSON.stringify(status),end,KEY,serialized,LOCK,lockValue),
   env.DB.prepare('UPDATE finance_kv SET value=?,updated_ms=? WHERE key=? AND value=?').bind(JSON.stringify({token,running:false}),end,LOCK,lockValue),
  ]);
  if(results[0]?.meta?.changes!==1)return {ok:false,status:'error',code:'concurrent_change',error:messages.concurrent_change};
  return status;
 }catch(error){
  const code=error instanceof SyncError?error.code:error?.code==='rate_limited'?'rate_limited':phase==='storage'?'storage_unavailable':'provider_unavailable';
  try{return await recordFailure(code,error instanceof SyncError?error.details:{});}catch{return {ok:false,status:'error',code:'storage_unavailable',error:messages.storage_unavailable};}
 }
}
