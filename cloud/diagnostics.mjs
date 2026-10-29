// Owner-only, fixed public endpoints. Never includes account headers or secrets.
import {ExchangeClient} from './exchange.mjs';
const probes={binanceGcp:'https://api-gcp.binance.com/api/v3/time',binance1:'https://api1.binance.com/api/v3/time',binance4:'https://api4.binance.com/api/v3/time',okx:'https://www.okx.com/api/v5/public/time',binance:'https://api.binance.com/api/v3/time',market:'https://data-api.binance.vision/api/v3/aggTrades?symbol=BTCUSDT&limit=1',chain:'https://blockstream.info/api/blocks/tip/height',fx:'https://api.frankfurter.dev/v2/rates?base=USD&quotes=CNY&providers=ecb'};
export async function diagnoseProviders(){
 return Object.fromEntries(await Promise.all(Object.entries(probes).map(async([name,url])=>{
  const start=Date.now();try{const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'XHY-Terminal/1.0'},redirect:'manual',signal:AbortSignal.timeout(12000)});const text=await r.text();let code=null;try{const j=JSON.parse(text);code=j.code??null;}catch{}return [name,{status:r.status,type:r.headers.get('Content-Type'),bytes:text.length,code,elapsedMs:Date.now()-start}];}
  catch(error){return [name,{error:error.name,message:String(error.message).slice(0,200),elapsedMs:Date.now()-start}];}
 })));
}
export async function diagnoseReadOnlyAccounts(env){
 const result={};
 for(const venue of ['okx','binance']){
  let stage='time';try{
   const c=new ExchangeClient(venue,venue==='okx'?{api_key:env.OKX_API_KEY,secret_key:env.OKX_SECRET_KEY,passphrase:env.OKX_PASSPHRASE}:{api_key:env.BINANCE_API_KEY,secret_key:env.BINANCE_SECRET_KEY});
   await c.syncTime();stage='permissions';const permissions=await c.permissions();result[venue]={ok:true,permissions};
  }catch(error){result[venue]={ok:false,stage,code:error.code||error.name};}
 }
 return result;
}
