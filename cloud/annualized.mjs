import {calculatePositionAnnualized} from './annualized-math.mjs';
import {connectionIdentity,validateCredentials,decryptConfiguration,ExchangeClient} from './exchange.mjs';
import {dec,txt} from './cost-book.mjs';
import {calculatePortfolioAnnualized} from './portfolio-annualized.mjs';
import {readFinanceCredentials} from './finance.mjs';
import {syncPortfolioCashflows} from './capital-sync.mjs';

const DAY=86400000;
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
async function read(env,key,fallback=null){const row=await env.DB.prepare('SELECT value FROM finance_kv WHERE key=?').bind(key).first();return row?JSON.parse(row.value):fallback;}
const write=(env,key,value,now)=>env.DB.prepare('INSERT INTO finance_kv(key,value,updated_ms) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_ms=excluded.updated_ms').bind(key,JSON.stringify(value),now);
async function identity(env){
 const encrypted=await read(env,'credentials:okx');
 const c=encrypted?await decryptConfiguration(encrypted,env.CONFIG_ENCRYPTION_KEY):{api_key:env.OKX_API_KEY,secret_key:env.OKX_SECRET_KEY,passphrase:env.OKX_PASSPHRASE};
 return connectionIdentity(validateCredentials(c));
}
const portfolioMissing=()=>({status:'needs_cashflows',annualized_return_pct:null,mean_annual_return_pct:null,currency:'USDT',years:[],reason:'缺少完整历史外部入金、出金及转入资产成本，暂不能核算总加密资产年化。',required_data:['从首次投入起的全部外部入金和出金日期、金额及币种','转入已有加密资产的原始投入日期和成本','核对交易所与个人钱包间的内部转账，避免重复计入本金'],scope:'欧易交易和资金账户、币安接口返回的钱包、已连接离线钱包'});
const unavailable=reason=>({status:'unavailable',method:'remaining_position_xirr',annualized_return_pct:null,mean_annual_return_pct:null,currency:'USDT',years:[],reason});
export function annualBoundaryYears(capital,asOfMs){
 const first=Date.parse(capital?.first_buy_at||'');if(!Number.isFinite(first)||!Number.isFinite(asOfMs)||first>asOfMs)return [];
 const from=new Date(first+28800000).getUTCFullYear(),to=new Date(asOfMs+28800000).getUTCFullYear();
 if(to-from>30)throw new Error('invalid_annual_range');
 return Array.from({length:Math.max(0,to-from)},(_,i)=>from+i+1);
}
export function validAnnualBoundary(year,row){try{return row?.at_ms===Date.UTC(Number(year),0,1)-28800000&&typeof row.source==='string'&&!!row.source&&dec(row.price_usdt).gt(0);}catch{return false;}}
export async function fetchAnnualBoundary(year,{fetch:fetcher=globalThis.fetch}={}){
 if(!Number.isInteger(year)||year<2009||year>2100)throw new Error('invalid_year');
 const at=Date.UTC(year,0,1)-28800000,start=at-DAY;
 const params=new URLSearchParams({instId:'BTC-USDT',bar:'1D',after:String(at),before:String(start-1),limit:'3'});
 const response=await fetcher('https://www.okx.com/api/v5/market/history-candles?'+params,{method:'GET',headers:{Accept:'application/json','User-Agent':'XHY-Terminal/1.0'},redirect:'manual',signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw new Error('year_price_unavailable');
 const raw=await response.text();if(raw.length>65536)throw new Error('year_price_invalid');const body=JSON.parse(raw);
 if(body.code!=='0'||!Array.isArray(body.data)||body.data.length>3)throw new Error('year_price_invalid');
 const rows=body.data.filter(row=>Array.isArray(row)&&row[0]===String(start));
 if(rows.length!==1||rows[0].length<9||rows[0][8]!=='1')throw new Error('year_price_unconfirmed');
 const row=rows[0],low=dec(row[3]),high=dec(row[2]),close=dec(row[4]);
 if(!low.gt(0)||low.gt(high)||close.lt(low)||close.gt(high))throw new Error('year_price_invalid');
 return {at_ms:at,price_usdt:txt(close),source:'OKX BTC-USDT / confirmed 1D UTC+8 close'};
}
export async function warmAnnualBoundaries(env,capital,asOfMs,{fetch:fetcher=globalThis.fetch,now=Date.now()}={}){
 const prices=await read(env,'annualized_year_prices',{}),years=annualBoundaryYears(capital,asOfMs).filter(y=>!validAnnualBoundary(y,prices[y]));
 if(!years.length)return prices;
 const lease=await env.DB.prepare("INSERT INTO finance_kv(key,value,updated_ms) VALUES('annualized_price_lock','true',?) ON CONFLICT(key) DO UPDATE SET updated_ms=excluded.updated_ms WHERE finance_kv.updated_ms<?").bind(now,now-900000).run();
 if(!lease.meta?.changes)return prices;
 let changed=false;
 for(const year of years.slice(0,4))try{prices[year]=await fetchAnnualBoundary(year,{fetch:fetcher});changed=true;}catch{/* Missing confirmed prices remain unavailable. */}
 if(changed)await write(env,'annualized_year_prices',prices,now).run();return prices;
}
export async function buildAnnualizedResponse(env,ctx={},options={}){
 const now=options.now??Date.now(),account=await identity(env);
 const [capital,book,pnl,prices,sync,cache]=await Promise.all(['annualized_capital','cost_book','btc_pnl','annualized_year_prices','sync_status','annualized_result'].map(key=>read(env,key,key==='annualized_year_prices'?{}:null)));
 const base={connection_id:account.slice(0,24),as_of:pnl?.as_of||null,btc:unavailable('当前账户的持仓成本日期正在同步，稍后自动重试。'),portfolio:await portfolioResponse(env,account,now)};
 if(!capital||capital.identity!==account||pnl?.connection_id!==base.connection_id||!pnl.metrics||!book)return base;
 if(capital.trade_count!==book.trade_count||capital.last_bill_id!==book.last_bill_id||!dec(capital.cost).eq(book.cost)||!dec(capital.inventory).eq(book.inventory)||!dec(pnl.metrics?.remaining_cost).eq(capital.cost))return base;
 const asOfMs=Date.parse(pnl.quote_at||pnl.as_of||'');if(!Number.isFinite(asOfMs)||asOfMs>now+5000)return base;
 const anchor=JSON.stringify(['remaining_position_xirr_v1',account,capital.version,capital.seed_epoch||0,capital.last_bill_id,capital.cost,pnl.metrics.holdings_btc,pnl.metrics.price_usdt,asOfMs,prices]);
 let btc;
 if(cache?.identity===account&&cache.anchor===anchor)btc=structuredClone(cache.btc);
 else{
  btc=calculatePositionAnnualized({capital,holdingsBtc:pnl.metrics.holdings_btc,priceUsdt:pnl.metrics.price_usdt,asOfMs,yearPrices:prices});
  const completed=btc.years.filter(y=>!y.partial_year&&y.period_return_pct!=null);
  btc.mean_annual_return_pct=completed.length?txt(completed.reduce((sum,y)=>sum.add(y.period_return_pct),dec('0')).div(completed.length)):null;
  btc.mean_annual_years=completed.length;btc.currency='USDT';
  btc.scope='欧易已导入买入账本对应的当前 BTC 持仓估算；不含已实现回款。';
  await write(env,'annualized_result',{identity:account,anchor,btc},now).run();
 }
 const stale=pnl.status!=='fresh'||sync?.ok===false||now-asOfMs>180000;
 if(stale&&btc.annualized_return_pct!=null){btc.status='stale';btc.reason='使用最近一次已核对的持仓与价格，等待数据源更新。';}
 if(annualBoundaryYears(capital,asOfMs).some(year=>!validAnnualBoundary(year,prices[year]))&&ctx.waitUntil)ctx.waitUntil(warmAnnualBoundaries(env,capital,asOfMs,options).catch(()=>{}));
 return {...base,as_of:new Date(asOfMs).toISOString(),btc};
}
async function currentIdentities(env){return {identity:await connectionIdentity(await readFinanceCredentials(env,'okx')),binance_identity:await connectionIdentity(await readFinanceCredentials(env,'binance'))};}
export async function syncCapitalAccounts(env,{fetch:fetcher=globalThis.fetch,now=Date.now(),force=false}={}){
 const previous=await read(env,'portfolio_capital_sync');
 if(!force&&previous?.last_attempt_ms&&now-previous.last_attempt_ms<900000)return {skipped:true};
 const ledger=await read(env,'portfolio_capital_ledger');if(!ledger)return {skipped:true};
 try{
  const [okx,binance]=await Promise.all([readFinanceCredentials(env,'okx'),readFinanceCredentials(env,'binance')]);
  const ids={identity:await connectionIdentity(okx),binance_identity:await connectionIdentity(binance)};
  if(ledger.identity!==ids.identity||ledger.binance_identity!==ids.binance_identity||ledger.wallet_address!==env.WALLET_ADDRESS)return {skipped:true,code:'account_changed'};
  const okxClient=new ExchangeClient('okx',okx,{fetch:fetcher}),binanceClient=new ExchangeClient('binance',binance,{fetch:fetcher});
  await Promise.all([okxClient.syncTime(),binanceClient.syncTime()]);await Promise.all([okxClient.permissions(),binanceClient.permissions()]);
  return await syncPortfolioCashflows(env,{okxClient,binanceClient,now,force,expectedIdentity:ids.identity,expectedBinanceIdentity:ids.binance_identity,getCurrentIdentities:()=>currentIdentities(env)});
 }catch{
  await write(env,'portfolio_capital_sync',{ok:false,code:'provider_unavailable',last_attempt_ms:now},now).run();return {ok:false,code:'provider_unavailable'};
 }
}
async function portfolioResponse(env,account,now){
 const missing=portfolioMissing();
 try{
  const [ledger,portfolio,market,sync,cached]=await Promise.all(['portfolio_capital_ledger','portfolio','market','portfolio_capital_sync','portfolio_annualized_result'].map(key=>read(env,key)));
  if(!ledger||ledger.identity!==account||ledger.wallet_address!==env.WALLET_ADDRESS)return missing;
  if(ledger.binance_identity!==await connectionIdentity(await readFinanceCredentials(env,'binance')))return {...missing,reason:'账户配置已变更，需要重新核对总资产入金范围。'};
  const reason=sync?.error||'外部入金流水尚未核对到当前，等待后台更新。';
  if(sync?.status==='needs_review')return {...missing,status:'unavailable',reason};
  if(sync?.ok===false||!ledger.last_checked_ms||now-ledger.last_checked_ms>1800000){
   if(cached?.identity===account&&cached.seed_epoch===ledger.seed_epoch&&cached.binance_identity===ledger.binance_identity)return {...cached.result,status:'stale',reason};
   return {...missing,status:'unavailable',reason};
  }
  if(portfolio?.complete!==true||!market)return {...missing,status:'unavailable',reason:'总资产估值来源尚不完整，暂不计算年化。'};
  const asOfMs=Date.parse(portfolio.updated_at||''),quoteMs=Date.parse(market.updated_at||'');
  if(!Number.isSafeInteger(asOfMs)||asOfMs>now+5000||!Number.isSafeInteger(quoteMs)||Math.abs(asOfMs-quoteMs)>180000)return {...missing,status:'unavailable',reason:'总资产估值和计价行情尚未同步。'};
  const ratio=dec(market.price_usdt).div(market.btc_usd);if(!ratio.gt(0))throw new Error('invalid_quote');
  const value=dec(portfolio.total_usd).mul(ratio),anchor=JSON.stringify(['cashflow_xirr_v1',account,ledger.binance_identity,ledger.seed_epoch||0,ledger.last_checked_ms||0,ledger.flows,value.toFixed(),asOfMs]);
  let result;
  if(cached?.identity===account&&cached.anchor===anchor)result=structuredClone(cached.result);
  else{
   result=calculatePortfolioAnnualized({ledger,marketValueUsdt:txt(value),asOfMs});
   if(result.status==='ambiguous')result.status='unavailable';
   result.cost_basis_note='已找回两所 C2C 净投入；三笔直接购买 BTC/BNB 依据原订单汇率折为 USDT 等值，属于估算。';
   result.valuation_conversion={usd_to_usdt:txt(ratio),source:'同一快照 BTC-USDT / BTC-USD 交叉计价',at:market.updated_at};
   result.capital_checked_at=ledger.last_checked_ms?new Date(ledger.last_checked_ms).toISOString():null;
   await write(env,'portfolio_annualized_result',{identity:account,binance_identity:ledger.binance_identity,seed_epoch:ledger.seed_epoch,anchor,result},now).run();
  }
  if(result.annualized_return_pct!=null&&(portfolio.stale||now-asOfMs>180000||!ledger.last_checked_ms||now-ledger.last_checked_ms>1800000||sync?.ok===false)){
   result.status='stale';result.reason=sync?.status==='needs_review'&&sync.error?sync.error:'使用最近一次已核对的资金流水与估值，等待数据源更新。';
  }
  return result;
 }catch{return {...missing,status:'unavailable',reason:'总资产资金流水或计价数据正在核对，稍后自动重试。'};}
}
export async function handleAnnualized(request,env,ctx={}){
 const url=new URL(request.url);if(url.pathname!=='/api/wallet/annualized')return null;
 if(!['GET','HEAD'].includes(request.method))return json({error:'年化回测接口仅支持读取。'},405);
 if(url.search)return json({error:'年化回测接口不接受查询参数。'},400);
 try{const result=await buildAnnualizedResponse(env,ctx);return request.method==='HEAD'?new Response(null,{headers:{'Cache-Control':'no-store'}}):json(result);}
 catch{return json({connection_id:null,as_of:null,btc:unavailable('年化回测暂不可用，原持仓浮盈不受影响。'),portfolio:portfolioMissing()},503);}
}
