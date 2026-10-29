import {D,dec,txt,iso} from './cost-book.mjs';

export class FinanceError extends Error {
  constructor(code='network_error',status=502){super(code);this.code=code;this.status=status;}
}
const enc=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const hex=bytes=>[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
export async function sha256(value){return hex(await crypto.subtle.digest('SHA-256',enc.encode(value)));}
async function hmac(secret,message,format='base64'){
  const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const result=await crypto.subtle.sign('HMAC',key,enc.encode(message));return format==='hex'?hex(result):b64(result);
}
export const connectionIdentity=credentials=>sha256((credentials?.api_key||'')+':'+(credentials?.secret_key||''));
export function validateCredentials(value,venue='okx',complete=true){
  const fields=venue==='okx'?['api_key','secret_key','passphrase']:['api_key','secret_key'];
  if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!fields.includes(k)))throw new FinanceError('credentials_invalid',400);
  for(const [k,v] of Object.entries(value))if(typeof v!=='string'||!v||v.length>256||/[^\x21-\x7e]/.test(v)||venue==='binance'&&!/^[A-Za-z0-9]{64}$/.test(v))throw new FinanceError('credentials_invalid',400);
  if(complete&&fields.some(k=>!value[k]))throw new FinanceError('needs_credentials',400);
  return {...value};
}
export function validateOKXPermissions(rows){
  if(!Array.isArray(rows)||rows.length!==1||typeof rows[0]?.perm!=='string')throw new FinanceError('permissions_unverified',403);
  if(new Set(rows[0].perm.split(',').map(x=>x.trim())).size!==1||rows[0].perm.trim()!=='read_only')throw new FinanceError('read_only_required',403);
  return {verified:true,read_only:true};
}
export function validateBinancePermissions(payload){
  if(!payload||payload.enableReading!==true)throw new FinanceError('read_only_required',403);
  for(const [key,value] of Object.entries(payload))if(/trad(?:e|ing)|withdraw|transfer|enableMargin|enableFutures|enableVanillaOptions|enablePortfolioMargin/i.test(key)){
    if(typeof value!=='boolean'||value)throw new FinanceError('read_only_required',403);
  }
  return {verified:true,read_only:true};
}
const okxPrivate=new Set(['/api/v5/account/config','/api/v5/account/balance','/api/v5/asset/balances','/api/v5/account/bills-archive','/api/v5/asset/bills-history']);
const okxPublic=new Set(['/api/v5/public/time','/api/v5/market/ticker','/api/v5/market/tickers','/api/v5/market/index-tickers','/api/v5/market/history-candles']);
const binancePrivate=new Set(['/sapi/v1/account/apiRestrictions','/sapi/v1/asset/wallet/balance','/sapi/v1/c2c/orderMatch/listUserOrderHistory']);
const binancePublic=new Set(['/api/v3/time']);
function approvedParams(venue,path,params){
  if(Object.values(params).some(v=>!['string','number'].includes(typeof v)||String(v).length>100))return false;
  const allowed=venue==='okx'?{
    '/api/v5/account/config':[], '/api/v5/account/balance':[], '/api/v5/asset/balances':[],
    '/api/v5/account/bills-archive':['instType','begin','end','limit','after'],
    '/api/v5/asset/bills-history':['type','limit','pagingType','after'],
    '/api/v5/public/time':[], '/api/v5/market/ticker':['instId'], '/api/v5/market/tickers':['instType'],
    '/api/v5/market/index-tickers':['instId'], '/api/v5/market/history-candles':['instId','bar','after','before','limit']
  }:{'/api/v3/time':[],'/sapi/v1/account/apiRestrictions':['recvWindow'],'/sapi/v1/asset/wallet/balance':['needBalanceDetail','quoteAsset','recvWindow'],'/sapi/v1/c2c/orderMatch/listUserOrderHistory':['tradeType','startTimestamp','endTimestamp','page','rows','recvWindow']};
  if(!allowed[path]||Object.keys(params).some(k=>!allowed[path].includes(k)))return false;
  if(params.instId&&!/^[A-Z0-9]{1,20}-[A-Z0-9]{1,20}$/.test(params.instId))return false;
  if(params.instType&&params.instType!=='SPOT')return false;
  if(params.bar&&params.bar!=='1m')return false;
  if(params.tradeType&&!['BUY','SELL'].includes(params.tradeType))return false;
  if(path==='/api/v5/asset/bills-history'&&(!['116','117','118'].includes(String(params.type))||String(params.pagingType)!=='2'))return false;
  for(const k of ['begin','end','after','before','limit','recvWindow','startTimestamp','endTimestamp','page','rows','pagingType'])if(params[k]!=null&&!/^\d{1,20}$/.test(String(params[k])))return false;
  return true;
}
export class ExchangeClient {
  constructor(venue,credentials,{fetch:fetcher=globalThis.fetch,now=Date.now}={}){
    if(!['okx','binance'].includes(venue))throw new FinanceError('route_rejected',400);
    this.venue=venue;this.credentials=validateCredentials(credentials,venue);this.fetcher=fetcher.bind(globalThis);this.now=now;this.offset=0;
  }
  async get(path,params={},authenticated=true){
    const valid=this.venue==='okx'?(authenticated?okxPrivate:okxPublic):(authenticated?binancePrivate:binancePublic);
    if(!valid.has(path)||!approvedParams(this.venue,path,params))throw new FinanceError('route_rejected',400);
    const origin=this.venue==='okx'?'https://www.okx.com':'https://api-gcp.binance.com';
    const headers={'Accept':'application/json','User-Agent':'XHY-Terminal/1.0'}, values={...params};
    if(this.venue==='binance'&&authenticated)values.timestamp=Math.round(this.now()+this.offset);
    const query=new URLSearchParams(Object.entries(values).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,String(v)]));
    let full=path+(query.size?'?'+query:'');
    if(authenticated&&this.venue==='okx'){
      const stamp=new Date(this.now()+this.offset).toISOString();
      headers['OK-ACCESS-KEY']=this.credentials.api_key;headers['OK-ACCESS-PASSPHRASE']=this.credentials.passphrase;
      headers['OK-ACCESS-TIMESTAMP']=stamp;headers['OK-ACCESS-SIGN']=await hmac(this.credentials.secret_key,stamp+'GET'+full);
    }else if(authenticated){
      full+='&signature='+await hmac(this.credentials.secret_key,query.toString(),'hex');headers['X-MBX-APIKEY']=this.credentials.api_key;
    }
    let response,payload;
    try{
      response=await this.fetcher(origin+full,{method:'GET',headers,redirect:'manual',signal:AbortSignal.timeout(12000)});
      if(response.status>=300&&response.status<400)throw new FinanceError('redirect_rejected');
      const raw=await response.text();if(raw.length>4*1024*1024)throw new FinanceError('invalid_response');payload=JSON.parse(raw);
    }catch(error){if(error instanceof FinanceError)throw error;throw new FinanceError('network_error');}
    if(response.status===429||response.status===418)throw new FinanceError('rate_limited',429);
    if(response.status===451)throw new FinanceError('region_restricted',451);
    if(this.venue==='okx'){
      if(payload?.code!=='0'){
        const code={'50110':'ip_restricted','50102':'clock_error','50112':'clock_error','50105':'passphrase_invalid','50011':'rate_limited','50040':'rate_limited'}[payload?.code]||'provider_error';
        throw new FinanceError(code,code==='ip_restricted'?403:code==='rate_limited'?429:502);
      }
      if(!response.ok||!Array.isArray(payload.data))throw new FinanceError('invalid_response');return payload.data;
    }
    if(!response.ok||payload&&typeof payload.code==='number'&&payload.code<0)throw new FinanceError(payload?.code===-1021?'clock_error':response.status===401||response.status===403?'permission_denied':'provider_error',response.status===401||response.status===403?403:502);
    return payload;
  }
  async syncTime(){
    const start=this.now(),result=await this.get(this.venue==='okx'?'/api/v5/public/time':'/api/v3/time',{},false),end=this.now();
    const value=this.venue==='okx'?Number(result[0]?.ts):result.serverTime;
    if(!Number.isSafeInteger(value)||value<=0||end-start>20000)throw new FinanceError('clock_error');
    this.offset=value-(start+end)/2;return this.offset;
  }
  async permissions(){return this.venue==='okx'?validateOKXPermissions(await this.get('/api/v5/account/config')):validateBinancePermissions(await this.get('/sapi/v1/account/apiRestrictions',{recvWindow:5000}));}
  async spotBills(begin,end){
    if(this.venue!=='okx'||!Number.isSafeInteger(begin)||!Number.isSafeInteger(end)||begin>end||end-begin>86*86400000)throw new FinanceError('history_gap');
    let after,all=[],seen=new Set();
    for(let page=0;page<40;page++){
      const params={instType:'SPOT',begin,end,limit:100};if(after)params.after=after;
      const rows=await this.get('/api/v5/account/bills-archive',params);
      if(rows.length>100)throw new FinanceError('invalid_response');
      for(const row of rows){if(!/^\d+$/.test(row?.billId)||seen.has(row.billId)||!Number.isSafeInteger(Number(row.ts)))throw new FinanceError('invalid_response');seen.add(row.billId);all.push(row);}
      if(rows.length<100)return all;
      const next=rows.at(-1).billId;if(after&&BigInt(next)>=BigInt(after))throw new FinanceError('invalid_response');after=next;
      await new Promise(resolve=>setTimeout(resolve,430));
    }
    throw new FinanceError('page_limit');
  }
}

export async function encryptConfiguration(value,secret){
  if(typeof secret!=='string'||secret.length<24)throw new FinanceError('configuration_unavailable',503);
  const key=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',enc.encode(secret)),{name:'AES-GCM'},false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12)),data=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(JSON.stringify(value)));
  return {version:1,iv:b64(iv),data:b64(data)};
}
export async function decryptConfiguration(value,secret){
  if(!value||value.version!==1||typeof secret!=='string'||secret.length<24)throw new FinanceError('configuration_unavailable',503);
  try{const key=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',enc.encode(secret)),{name:'AES-GCM'},false,['decrypt']);const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(value.iv)},key,unb64(value.data));return JSON.parse(new TextDecoder().decode(raw));}catch{throw new FinanceError('configuration_unavailable',503);}
}

export function normalizeOKX(trading,funding,tickers,btcUSD,now,connection){
  if(!Array.isArray(trading)||trading.length!==1||!Array.isArray(trading[0]?.details)||!Array.isArray(funding))throw new FinanceError('invalid_response');
  const quotes=new Map(tickers.map(row=>[row.instId,dec(row.last||'0')]));
  const btcUSDT=quotes.get('BTC-USDT');if(!btcUSDT?.gt(0)||!dec(btcUSD).gt(0))throw new FinanceError('market_unavailable');
  const usdtUSD=dec(btcUSD).div(btcUSDT),priceFor=ccy=>ccy==='BTC'?dec(btcUSD):ccy==='USD'?new D(1):ccy==='USDT'?usdtUSD:quotes.get(ccy+'-USDT')?.mul(usdtUSD)??(quotes.get(ccy+'-BTC')?.mul(btcUSD)??null);
  const assets=new Map();
  for(const r of trading[0].details){
    if(!/^[A-Z0-9._-]{1,30}$/.test(r.ccy))throw new FinanceError('invalid_response');
    const cash=dec(r.cashBal),debt=dec(r.liab||'0'),quantity=cash.sub(debt),price=priceFor(r.ccy);
    assets.set(r.ccy,{ccy:r.ccy,trading_equity:txt(dec(r.eq)),trading_cash_balance:txt(cash),trading_available:txt(dec(r.availBal||'0')),funding_balance:'0',funding_available:'0',debt:txt(debt),quantity:txt(quantity),usd_value:price?txt(quantity.mul(price)):null,valuation_status:price?'priced':'unpriced'});
  }
  for(const r of funding){
    if(!/^[A-Z0-9._-]{1,30}$/.test(r.ccy))throw new FinanceError('invalid_response');
    const item=assets.get(r.ccy)||{ccy:r.ccy,trading_equity:'0',trading_cash_balance:'0',trading_available:'0',debt:'0',quantity:'0'};
    item.funding_balance=txt(dec(r.bal));item.funding_available=txt(dec(r.availBal||'0'));item.quantity=txt(dec(item.quantity).add(r.bal));
    const price=priceFor(r.ccy);item.usd_value=price?txt(dec(item.quantity).mul(price)):null;item.valuation_status=price?'priced':'unpriced';assets.set(r.ccy,item);
  }
  const rows=[...assets.values()].sort((a,b)=>a.ccy.localeCompare(b.ccy));const btc=assets.get('BTC');
  const fundingValue=rows.reduce((sum,r)=>{const price=priceFor(r.ccy);return price?sum.add(dec(r.funding_balance||'0').mul(price)):sum;},new D(0));
  const complete=rows.every(r=>r.usd_value!==null||dec(r.quantity).isZero());
  const tradingUSD=trading[0].totalEq==null?null:txt(dec(trading[0].totalEq));
  return {configured:true,pending_credentials:false,missing_fields:[],refreshing:false,last_success_at:iso(now),error:null,error_code:null,status:'connected',assets:rows,summary:{trading_usd:tradingUSD,funding_usd:complete?txt(fundingValue):null,total_usd:complete&&tradingUSD!=null?txt(dec(tradingUSD).add(fundingValue)):null,valuation_complete:complete,btc_total:txt(dec(btc?.trading_equity||'0').add(btc?.funding_balance||'0')),btc_holdings_total:btc?.quantity||'0',scope_label:'交易账户与资金账户；不含赚币及子账户'},permissions:{verified:true,read_only:true},observed_at:iso(now),history:[],cash_valuation:{assets:rows.map(r=>({ccy:r.ccy,quantity:r.quantity,usd_value:r.usd_value})),complete},refresh_interval_seconds:60,retry_in_seconds:0,consecutive_failures:0,history_error:null,connection_id:connection};
}
export function normalizeBinance(payload,btcUSD,now){
  if(!Array.isArray(payload)||!payload.length||payload.length>64)throw new FinanceError('invalid_response');
  const assets=[],missing=new Set(),names=new Set();
  for(const wallet of payload){
    if(typeof wallet.walletName!=='string'||names.has(wallet.walletName)||typeof wallet.activate!=='boolean')throw new FinanceError('invalid_response');names.add(wallet.walletName);
    const details=wallet.assetBalances;
    if(!Array.isArray(details)){if(wallet.activate||!dec(wallet.balance||'0').isZero())missing.add(wallet.walletName);continue;}
    if(!details.length&&!dec(wallet.balance||'0').isZero())missing.add(wallet.walletName);
    const seen=new Set();
    for(const item of details){
      if(!/^[A-Z0-9._-]{1,32}$/.test(item.asset)||seen.has(item.asset))throw new FinanceError('invalid_response');seen.add(item.asset);
      const fields={};let incomplete=false;
      for(const key of ['free','locked','freeze','withdrawing']){if(item[key]==null){fields[key]=null;incomplete=true;}else fields[key]=txt(dec(item[key]));}
      const ambiguous=fields.freeze!=null&&!dec(fields.freeze).isZero()||fields.withdrawing!=null&&!dec(fields.withdrawing).isZero();
      const quantity=incomplete||ambiguous?null:dec(fields.free).add(fields.locked),btc=item.btcValuation==null?null:dec(item.btcValuation);
      if(incomplete||ambiguous||btc==null)missing.add(wallet.walletName);
      assets.push({ccy:item.asset,wallet:wallet.walletName,quantity:txt(quantity),btc_value:txt(btc),usd_value:btc==null?null:txt(btc.mul(btcUSD)),components:fields,quantity_complete:quantity!=null,quantity_note:ambiguous?'冻结字段归属不明确，数量暂不估算。':incomplete?'数量字段不完整。':null});
    }
  }
  return {assets,complete:missing.size===0,missing_wallets:[...missing],wallets_count:payload.length,observed_at:iso(now),scope:'API 返回的主账户钱包；不承诺覆盖全部产品与子账户。'};
}
