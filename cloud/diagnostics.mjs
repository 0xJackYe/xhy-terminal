// Owner-only, fixed public endpoints. Never includes account headers or secrets.
import {ExchangeClient} from './exchange.mjs';
import {readFinanceCredentials,getFinanceSnapshot} from './finance.mjs';
import {BINANCE_TRADES_META} from './binance-trades.mjs';
const probes={binanceGcp:'https://api-gcp.binance.com/api/v3/time',binance1:'https://api1.binance.com/api/v3/time',binance4:'https://api4.binance.com/api/v3/time',okx:'https://www.okx.com/api/v5/public/time',binance:'https://api.binance.com/api/v3/time',market:'https://data-api.binance.vision/api/v3/aggTrades?symbol=BTCUSDT&limit=1',chain:'https://blockstream.info/api/blocks/tip/height',fx:'https://api.frankfurter.dev/v2/rates?base=USD&quotes=CNY&providers=ecb'};
export async function diagnoseProviders(){
 return Object.fromEntries(await Promise.all(Object.entries(probes).map(async([name,url])=>{
  const start=Date.now();try{const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'XHY-Terminal/1.0'},redirect:'manual',signal:AbortSignal.timeout(12000)});const text=await r.text();let code=null;try{const j=JSON.parse(text);code=j.code??null;}catch{}return [name,{status:r.status,type:r.headers.get('Content-Type'),bytes:text.length,code,elapsedMs:Date.now()-start}];}
  catch(error){return [name,{error:error.name,message:String(error.message).slice(0,200),elapsedMs:Date.now()-start}];}
 })));
}
// Uses the same credentials as the sync (keys saved from the page win over
// Worker secrets) and checks the reads the wallet depends on. Reports only
// stages, counts and booleans: no balances, ids or keys.
export async function diagnoseReadOnlyAccounts(env){
 const result={};
 for(const venue of ['okx','binance']){
  let stage='credentials';result[venue]={ok:false};
  try{
   const c=new ExchangeClient(venue,await readFinanceCredentials(env,venue));
   stage='time';await c.syncTime();stage='permissions';result[venue]={ok:true,permissions:await c.permissions()};
   if(venue==='binance'){
    stage='wallet_balance';const wallets=await c.get('/sapi/v1/asset/wallet/balance',{needBalanceDetail:'true',quoteAsset:'BTC',recvWindow:5000});
    result.binance.wallets=Array.isArray(wallets)?wallets.length:null;result.binance.balance_detail=Array.isArray(wallets)&&wallets.some(w=>Array.isArray(w?.assetBalances));
    stage='trade_history';result.binance.trade_history=Array.isArray(await c.get('/api/v3/myTrades',{symbol:'BTCUSDT',fromId:0,limit:1,recvWindow:5000}));
   }
  }catch(error){result[venue]={...result[venue],ok:false,stage,code:error.code||error.name};}
 }
 const meta=await getFinanceSnapshot(env,BINANCE_TRADES_META).catch(()=>null);
 result.binance.trade_import=meta?{complete:meta.complete===true,records:meta.record_count||0,updated_at:meta.updated_at||null}:null;
 return result;
}
