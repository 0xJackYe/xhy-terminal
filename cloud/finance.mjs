import {D,dec,txt,iso,beijingDate,normalizeBills,compareTrades,buildCostBook,appendCostBook,costView,positionView} from './cost-book.mjs';
import {FinanceError,ExchangeClient,connectionIdentity,validateCredentials,encryptConfiguration,decryptConfiguration,normalizeOKX,normalizeBinance,binanceDetailFallbacks,COIN_CODE} from './exchange.mjs';
import {preserveHistoricalPricePeriods} from './finance-price-periods.mjs';
import {appendRemainingCapital,buildRemainingCapital} from './annualized-math.mjs';
import {syncBinanceTrades,BINANCE_TRADES_META} from './binance-trades.mjs';

export const FINANCE_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS finance_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS finance_trades (id TEXT PRIMARY KEY, bill_id TEXT UNIQUE NOT NULL, at_ms INTEGER NOT NULL, record_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS finance_trades_at ON finance_trades(at_ms);
`;
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers});
export async function getFinanceSnapshot(env,key,fallback=null){const row=await env.DB.prepare('SELECT value,updated_ms FROM finance_kv WHERE key=?').bind(key).first();if(!row)return fallback;try{return JSON.parse(row.value);}catch{return fallback;}}
async function put(env,key,value,now){return env.DB.prepare('INSERT INTO finance_kv(key,value,updated_ms) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_ms=excluded.updated_ms').bind(key,JSON.stringify(value),now).run();}
const putStatement=(env,key,value,now)=>env.DB.prepare('INSERT INTO finance_kv(key,value,updated_ms) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_ms=excluded.updated_ms').bind(key,JSON.stringify(value),now);
const publicMessages={binance_history_invalid:'币安成交与已核对的欧易账本无法衔接（例如卖出了没有买入记录的 BTC），暂不并入成本。',holdings_unavailable:'持仓数量暂不可核实，显示上次估算。',network_error:'云端暂时无法连接数据源，保留上次快照。',region_restricted:'数据提供方限制了当前云端地区访问，暂不能更新。',ip_restricted:'当前云端地址不在 API IP 白名单内，请调整该只读 API 的允许地址。',read_only_required:'请使用仅含读取权限的 API，不启用交易、划转或提现。',permissions_unverified:'读取权限尚未完成核验，暂不查询账户余额。',credentials_invalid:'API 凭据校验失败，请检查配置。',needs_credentials:'请先配置完整的只读 API 凭据。',history_gap:'成本账本存在超出接口窗口的历史缺口，请补齐账本。',needs_history:'此账户尚未导入完整的历史成本。',historical_rate_missing:'跨币种买入的历史行情尚未完整读取，暂不重算成本。',page_limit:'交易记录超出单次查询上限，保留上次账本。',configuration_unavailable:'云端凭据存储尚未配置完成。',rate_limited:'数据提供方正在限流，稍后自动重试。',provider_error:'数据提供方暂时不能完成请求。',clock_error:'数据提供方时间校验失败，稍后自动重试。',passphrase_invalid:'欧易 Passphrase 不匹配。',permission_denied:'接口拒绝访问，请核对读取权限和 IP 允许范围。',invalid_response:'数据源格式校验未通过，保留上次数据。',market_unavailable:'统一计价行情暂不可用。',invalid_request:'请求格式不正确。',method:'此路径不支持该操作。'};
const errorCode=error=>error instanceof FinanceError?error.code:String(error?.message)==='historical_rate_missing'?'historical_rate_missing':String(error?.message)==='out_of_order_trade'?'history_gap':'network_error';
function safeError(error){const code=errorCode(error);return {code,error:publicMessages[code]||publicMessages.network_error};}

async function credentials(env,venue){
  const encrypted=await getFinanceSnapshot(env,'credentials:'+venue);
  if(encrypted)return validateCredentials(await decryptConfiguration(encrypted,env.CONFIG_ENCRYPTION_KEY),venue);
  return validateCredentials(venue==='okx'?{api_key:env.OKX_API_KEY,secret_key:env.OKX_SECRET_KEY,passphrase:env.OKX_PASSPHRASE}:{api_key:env.BINANCE_API_KEY,secret_key:env.BINANCE_SECRET_KEY},venue);
}
export {credentials as readFinanceCredentials};
function emptyOKX(connection=null,configured=false,error=null){return {configured,pending_credentials:false,missing_fields:configured?[]:['api_key','secret_key','passphrase'],refreshing:false,last_success_at:null,error,error_code:error?'needs_credentials':null,status:configured?'connecting':'needs_credentials',assets:[],summary:{},cash_valuation:null,history:[],connection_id:connection,permissions:{verified:false,read_only:null},refresh_interval_seconds:60,retry_in_seconds:0,consecutive_failures:0,history_error:null};}
const emptyCost=(connection=null,error=publicMessages.needs_history)=>({status:'unavailable',refreshing:false,last_success_at:null,error,error_code:'needs_history',plan_daily_usdt:'20',coverage_complete:false,summary:null,today:null,recent_trades:[],connection_id:connection,refresh_interval_seconds:60,retry_in_seconds:0});
const emptyPnL=(connection=null,error=publicMessages.needs_history)=>({status:'unavailable',estimated:true,currency:'USDT',method:'moving_weighted_average',focus:'long_term_unrealized',metrics:{},connection_id:connection,error,refresh_interval_seconds:60});
const emptyCombined=pnl=>({ok:true,stale:true,updated_at:null,goal_btc:'1',totals:{btc:null,usd:null,cny:null},sources:[],history:[],pnl:{},quotes:{},coverage:{complete:false,note:'正在核对云端账户和链上余额。'},lifetime_pnl:pnl||emptyPnL()});
const emptyPortfolio=()=>({updated_at:null,complete:false,stale:true,total_usd:null,total_cny:null,total_btc:null,threshold_usd:'5',excluded_usd:'0',assets:[],locations:[],sources:[],unpriced_currencies:[],liabilities_usd:'0',excluded_liabilities_usd:'0',location_allocation_complete:false,scope_note:'等待已连接账户的可核实估值。',binance:{configured:false,pending_credentials:false,missing_fields:['api_key','secret_key'],last_success_at:null,status:'needs_credentials',error_code:null,retry_in_seconds:0}});

async function publicGET(url,fetcher,bytes=4*1024*1024){
  let r;
  try{r=await fetcher(url,{method:'GET',headers:{Accept:'application/json','User-Agent':'XHY-Terminal/1.0'},redirect:'manual',signal:AbortSignal.timeout(12000),cf:{cacheTtl:45,cacheEverything:false}});if(!r.ok)throw new Error();const raw=await r.text();if(raw.length>bytes)throw new Error();return JSON.parse(raw);}catch{throw new FinanceError('network_error');}
}
export async function readConfirmedBalance(address,{fetch:fetcher=globalThis.fetch,now=Date.now}={}){
  if(typeof address!=='string'||!/^(?:bc1[a-z0-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(address))throw new FinanceError('invalid_request',400);
  const data=await publicGET('https://blockstream.info/api/address/'+address,fetcher,65536);
  if(data.address!==address)throw new FinanceError('invalid_response');
  const s=data.chain_stats;if(!s||[s.funded_txo_sum,s.spent_txo_sum,s.tx_count].some(x=>!Number.isSafeInteger(x)||x<0)||s.spent_txo_sum>s.funded_txo_sum)throw new FinanceError('invalid_response');
  return {btc:txt(new D(s.funded_txo_sum).sub(s.spent_txo_sum).div(1e8)),summary:data,updated_at:iso(now()),provider:'Blockstream/confirmed'};
}
async function foreignRate(client,row,rates){
  if(row.quote_ccy==='USDT')return;
  const minute=Math.floor(row.at_ms/60000)*60000,key=row.quote_ccy+':'+minute;
  if(rates[key]&&dec(typeof rates[key]==='object'?rates[key].close:rates[key]).gt(0))return;
  if(!/^[A-Z0-9]{1,20}$/.test(row.quote_ccy))throw new FinanceError('historical_rate_missing');
  const rows=await client.get('/api/v5/market/history-candles',{instId:row.quote_ccy+'-USDT',bar:'1m',after:minute+60000,before:minute-1,limit:3},false);
  const found=rows.filter(r=>Array.isArray(r)&&r.length>=9&&r[0]===String(minute)&&r[8]==='1');
  if(found.length!==1)throw new FinanceError('historical_rate_missing');const r=found[0];
  if(!dec(r[3]).gt(0)||dec(r[4]).lt(r[3])||dec(r[4]).gt(r[2]))throw new FinanceError('historical_rate_missing');
  rates[key]={currency:row.quote_ccy,minute_ms:minute,close:txt(r[4]),low:txt(r[3]),high:txt(r[2]),source:'OKX/1m-close'};
}
function statusBinance(configured,data,error,at){return {configured,pending_credentials:false,missing_fields:configured?[]:['api_key','secret_key'],error_code:error?.code||null,last_success_at:data?.observed_at||null,status:!configured?'needs_credentials':error?data?'stale':'error':data?'connected':'connecting',retry_in_seconds:error?60:0};}

export function aggregatePortfolio(rows,sources,btcUSD,fx,now,binance){
  const coins=new Map(),locations={okx:new D(0),binance:new D(0),offline:new D(0)},unpriced=new Set();
  let liabilities=new D(0),excluded=new D(0),excludedLiabilities=new D(0),negativeLeg=false;
  for(const r of rows){
    if(typeof r.ccy!=='string'||!COIN_CODE.test(r.ccy)||!Object.hasOwn(locations,r.location))throw new FinanceError('invalid_response');
    if(r.quantity==='0'&&(r.usd_value==null||r.usd_value==='0'))continue;
    const coin=coins.get(r.ccy)||{quantity:new D(0),complete:true,legs:[],label:typeof r.label==='string'?r.label.slice(0,40):null};
    if(r.quantity==null)coin.complete=false;else coin.quantity=coin.quantity.add(r.quantity);
    if(r.usd_value==null)unpriced.add(r.ccy);else coin.legs.push({location:r.location,value:dec(r.usd_value)});
    coins.set(r.ccy,coin);
  }
  const assets=[];
  for(const [ccy,coin]of coins){
    if(unpriced.has(ccy))continue;const value=coin.legs.reduce((a,r)=>a.add(r.value),new D(0));
    if(value.lt(0)){if(value.abs().lt(5))excludedLiabilities=excludedLiabilities.add(value.abs());else liabilities=liabilities.add(value.abs());continue;}
    if(value.lt(5)){excluded=excluded.add(value);continue;}
    assets.push({ccy,...(coin.label?{label:coin.label}:{}),quantity:coin.complete?txt(coin.quantity):null,usd_value:txt(value)});
    for(const leg of coin.legs){locations[leg.location]=locations[leg.location].add(leg.value);if(leg.value.lt(0)){negativeLeg=true;liabilities=liabilities.add(leg.value.abs());}}
  }
  assets.sort((a,b)=>dec(b.usd_value).cmp(a.usd_value)||a.ccy.localeCompare(b.ccy));const total=assets.reduce((n,r)=>n.add(r.usd_value),new D(0));
  for(const r of assets)r.percentage=total.gt(0)?dec(r.usd_value).div(total).mul(100).toNumber():0;
  const venueRows=negativeLeg?[]:Object.entries(locations).filter(([,v])=>v.gt(0)).map(([id,v])=>({id,label:{okx:'欧易',binance:'币安',offline:'离线钱包'}[id],usd_value:txt(v),percentage:total.gt(0)?v.div(total).mul(100).toNumber():0}));
  return {updated_at:iso(now),complete:sources.every(r=>r.status==='connected')&&!unpriced.size&&liabilities.isZero(),stale:sources.some(r=>['stale','error'].includes(r.status)),total_usd:txt(total),total_cny:fx?.rate?txt(total.mul(fx.rate)):null,total_btc:btcUSD?txt(total.div(btcUSD)):null,conversion_quotes:{btc_usd:btcUSD?txt(btcUSD):null,usd_cny:fx?.rate||null,fx_date:fx?.date||null},excluded_usd:txt(excluded),threshold_usd:'5',assets,locations:venueRows,sources,unpriced_currencies:[...unpriced].sort(),liabilities_usd:txt(liabilities),excluded_liabilities_usd:txt(excludedLiabilities),location_allocation_complete:!negativeLeg,scope_note:'欧易统计交易与资金账户；币安统计现货、资金及其他钱包。不含欧易赚币、子账户及衍生品浮盈。',binance};
}
function quoteValid(rows,now,field){if(!Array.isArray(rows)||rows.length!==1||!dec(rows[0]?.[field]||'0').gt(0)||!Number.isSafeInteger(Number(rows[0].ts))||Math.abs(now-Number(rows[0].ts))>180000)throw new FinanceError('market_unavailable');return txt(rows[0][field]);}
const isBinance=row=>row?.venue==='binance';
async function syncCost(env,client,account,now){
  let meta=await getFinanceSnapshot(env,'cost_meta'),book=await getFinanceSnapshot(env,'cost_book');
  // Binance fills join the book only once their whole history is imported,
  // so the book never holds part of an account's purchases.
  const binanceMeta=await getFinanceSnapshot(env,BINANCE_TRADES_META),includeBinance=binanceMeta?.complete===true;
  const previousCapital=await getFinanceSnapshot(env,'annualized_capital');
  if(!meta?.complete||meta.identity!==account)return {book:null,meta,error:{code:'needs_history',error:publicMessages.needs_history},recent:[]};
  if(now-meta.as_of_ms>85*86400000)return {book:null,meta,error:{code:'history_gap',error:publicMessages.history_gap},recent:[]};
  const start=Math.max(meta.coverage_start_ms,meta.as_of_ms-2*86400000),end=Math.floor(client.now()+client.offset);
  let rates=await getFinanceSnapshot(env,'historical_rates',{});
  const updates=normalizeBills(await client.spotBills(start,end));
  const old=(await env.DB.prepare('SELECT id,record_json FROM finance_trades WHERE at_ms>=?').bind(start-1000).all()).results||[],known=new Map(old.map(r=>[r.id,JSON.parse(r.record_json)]));
  const fresh=[];
  for(const row of updates){
    const before=known.get(row.id);
    if(before){if(Object.keys(row).some(k=>k!=='at_ms'&&before[k]!==row[k])||Math.floor(before.at_ms/1000)!==Math.floor(row.at_ms/1000))throw new FinanceError('history_gap');}
    else{fresh.push(row);if(row.side==='buy')await foreignRate(client,row,rates);}
  }
  // Every stored trade is either in the book or deliberately left out of it;
  // a different count means rows were added elsewhere (Binance) or lost.
  const stored=Number((await env.DB.prepare('SELECT COUNT(*) AS count FROM finance_trades').first())?.count);
  const binanceStale=book&&(includeBinance?(book.excluded_binance||0)>0&&book.binance_failed_at!==stored:(book.binance_count||0)>0);
  let rebuild=!book||book.invested_usdt==null||stored!==book.trade_count+(book.excluded_binance||0)||binanceStale||old.some(r=>{const row=JSON.parse(r.record_json);if(isBinance(row)&&!book.binance_included)return false;return row.at_ms>book.last_at_ms||row.at_ms===book.last_at_ms&&BigInt(row.bill_id)>BigInt(book.last_bill_id);})||fresh.some(r=>r.at_ms<book.last_at_ms||r.at_ms===book.last_at_ms&&BigInt(r.bill_id)<=BigInt(book.last_bill_id));
  let used=null,binanceIssue=null;
  if(rebuild){
    const all=(await env.DB.prepare('SELECT record_json FROM finance_trades ORDER BY at_ms, length(bill_id), bill_id').all()).results||[];
    const records=all.map(r=>JSON.parse(r.record_json));records.push(...fresh);
    const okxOnly=records.filter(r=>!isBinance(r));used=includeBinance?records:okxOnly;
    // Binance rows carry the Binance minute rates they were imported with.
    for(const row of okxOnly)if(row.side==='buy'&&row.quote_ccy!=='USDT')await foreignRate(client,row,rates);
    try{book=buildCostBook(used,rates);}
    catch(error){
      // Binance fills that cannot join the verified OKX history (for example
      // a sale of BTC with no recorded purchase) never break the OKX book.
      if(used===okxOnly)throw error;used=okxOnly;book=buildCostBook(used,rates);
      binanceIssue={code:'binance_history_invalid',error:publicMessages.binance_history_invalid};book.binance_failed_at=stored+fresh.length;
    }
    book.binance_count=used.length-okxOnly.length;book.excluded_binance=records.length-used.length;book.binance_included=includeBinance&&book.excluded_binance===0;
  }else book=appendCostBook(book,fresh,rates);
  meta={...meta,as_of_ms:end};
  const latestCredentials=await credentials(env,'okx');if(await connectionIdentity(latestCredentials)!==account)throw new FinanceError('account_changed');
  const statements=fresh.map(r=>env.DB.prepare('INSERT INTO finance_trades(id,bill_id,at_ms,record_json) VALUES(?,?,?,?)').bind(r.id,r.bill_id,r.at_ms,JSON.stringify(r)));
  // Keep a large reconnect within D1's bounded statement batches. The public
  // coverage/book anchor advances only after every insert succeeds; a partial
  // insert is detected above and reconstructed on the next retry.
  for(let i=0;i<statements.length;i+=90)await env.DB.batch(statements.slice(i,i+90));
  const anchors=[putStatement(env,'cost_meta',meta,now),putStatement(env,'cost_book',book,now),putStatement(env,'historical_rates',rates,now)];
  if(used&&previousCapital?.identity===account){
    // A rebuilt book (Binance history added, removed or reordered) rebuilds
    // the dated remaining capital from the very same trades.
    try{const capital=buildRemainingCapital(used,rates);if(capital.trade_count===book.trade_count&&capital.last_bill_id===book.last_bill_id&&dec(capital.cost).eq(book.cost)&&dec(capital.inventory).eq(book.inventory))anchors.push(putStatement(env,'annualized_capital',{...capital,identity:account,seed_epoch:previousCapital.seed_epoch||null},now));}
    catch{/* A cost-date mismatch cannot change the verified cost book. */}
  }else if(previousCapital?.identity===account&&previousCapital.trade_count<book.trade_count){
    try{
      let capitalUpdates=fresh;
      if(previousCapital.trade_count!==book.trade_count-fresh.length){
        const lagged=(await env.DB.prepare('SELECT record_json FROM finance_trades WHERE at_ms>=? ORDER BY at_ms, length(bill_id), bill_id LIMIT 1001').bind(previousCapital.last_at_ms).all()).results||[];
        if(lagged.length>1000)throw new Error('dated_capital_needs_rebuild');
        capitalUpdates=lagged.map(r=>JSON.parse(r.record_json)).filter(r=>r.at_ms>previousCapital.last_at_ms||r.at_ms===previousCapital.last_at_ms&&BigInt(r.bill_id)>BigInt(previousCapital.last_bill_id));
      }
      const capital=appendRemainingCapital(previousCapital,capitalUpdates,rates);
      if(capital.trade_count===book.trade_count&&capital.last_bill_id===book.last_bill_id&&dec(capital.cost).eq(book.cost)&&dec(capital.inventory).eq(book.inventory))anchors.push(putStatement(env,'annualized_capital',{...capital,identity:account},now));
    }catch{/* A cost-date mismatch cannot change the verified cost book. */}
  }
  await env.DB.batch(anchors);
  const recentRows=(await env.DB.prepare('SELECT record_json FROM finance_trades WHERE at_ms>=? ORDER BY at_ms, length(bill_id), bill_id').bind(Math.min(now-2*86400000,start)).all()).results||[];
  const recent=recentRows.map(r=>JSON.parse(r.record_json)).filter(r=>!isBinance(r)||book.binance_included);
  return {book,meta,recent,error:null,rates,binance_issue:binanceIssue};
}

export async function syncFinance(env,{fetch:fetcher=globalThis.fetch,now:clock=Date.now,force=false}={}){
  const now=clock();
  const lease=await env.DB.prepare("INSERT INTO finance_kv(key,value,updated_ms) VALUES('sync_lock','true',?) ON CONFLICT(key) DO UPDATE SET updated_ms=excluded.updated_ms WHERE finance_kv.updated_ms<?").bind(now,now-(force?5000:55000)).run();
  if(!lease.meta?.changes)return {ok:true,skipped:true};
  let okxCreds,account,client;
  try{okxCreds=await credentials(env,'okx');account=await connectionIdentity(okxCreds);client=new ExchangeClient('okx',okxCreds,{fetch:fetcher,now:clock});await client.syncTime();await client.permissions();}
  catch(error){const e=safeError(error);await put(env,'sync_status',{ok:false,...e,last_attempt_ms:now},now);return {ok:false,...e};}
  try{
    const [trading,funding,tickers,index]=await Promise.all([client.get('/api/v5/account/balance'),client.get('/api/v5/asset/balances'),client.get('/api/v5/market/tickers',{instType:'SPOT'},false),client.get('/api/v5/market/index-tickers',{instId:'BTC-USD'},false)]);
    const btcUSD=quoteValid(index,clock(),'idxPx');
    const btcTicker=tickers.find(r=>r.instId==='BTC-USDT');const price=quoteValid([btcTicker],clock(),'last');
    const okx=normalizeOKX(trading,funding,tickers,btcUSD,clock(),account.slice(0,24));
    // One verified read-only Binance client serves both the balance and the
    // trade-history reads in this run.
    const binanceReady=(async()=>{const c=await credentials(env,'binance'),b=new ExchangeClient('binance',c,{fetch:fetcher,now:clock});await b.syncTime();await b.permissions();return {client:b,identity:await connectionIdentity(c)};})();
    binanceReady.catch(()=>{});
    const outcomes=await Promise.allSettled([
      (async()=>{
        // Binance fills are stored first, so this run's cost book sees them.
        let trades=null;const costMeta=await getFinanceSnapshot(env,'cost_meta');
        if(costMeta?.complete&&costMeta.identity===account){
          try{const {client:b,identity}=await binanceReady;trades=await syncBinanceTrades(env,b,{identity,coverageStartMs:costMeta.coverage_start_ms,rates:await getFinanceSnapshot(env,'historical_rates',{}),now:clock()});}
          catch(error){trades={error:safeError(error)};}
        }
        return {...await syncCost(env,client,account,clock()),binance_trades:trades};
      })(),
      readConfirmedBalance(env.WALLET_ADDRESS,{fetch:fetcher,now:clock}),
      publicGET('https://api.frankfurter.dev/v2/rates?base=USD&quotes=CNY&providers=ecb',fetcher,65536),
      (async()=>{
        const {client:b}=await binanceReady;
        const wallets=await b.get('/sapi/v1/asset/wallet/balance',{needBalanceDetail:'true',quoteAsset:'BTC',recvWindow:5000}),fallback=binanceDetailFallbacks(wallets);
        const [spot,funding]=await Promise.all([fallback.includes('Spot')?b.post('/sapi/v3/asset/getUserAsset',{needBtcValuation:'true',recvWindow:5000}):null,fallback.includes('Funding')?b.post('/sapi/v1/asset/get-funding-asset',{needBtcValuation:'true',recvWindow:5000}):null]);
        return normalizeBinance({wallets,spot,funding},btcUSD,clock());
      })()
    ]);
    let [cost,chain,fx,binance]=outcomes.map((r,i)=>r.status==='fulfilled'?r.value:null);
    const costError=outcomes[0].status==='rejected'?safeError(outcomes[0].reason):cost?.error;
    const chainError=outcomes[1].status==='rejected'?safeError(outcomes[1].reason):null;
    const binanceError=outcomes[3].status==='rejected'?safeError(outcomes[3].reason):null;
    if(!chain)chain=await getFinanceSnapshot(env,'chain_balance');
    if(!binance)binance=await getFinanceSnapshot(env,'binance');
    if(Array.isArray(fx)){
      const row=fx.find(r=>r.base==='USD'&&r.quote==='CNY'&&/^\d{4}-\d{2}-\d{2}$/.test(r.date)&&dec(r.rate).gt(0));
      fx=row?{rate:txt(row.rate),date:row.date,observed_at:iso(clock())}:null;
    }else fx=null;
    if(!fx)fx=await getFinanceSnapshot(env,'fx');
    if(!fx){const imported=await getFinanceSnapshot(env,'combined');if(imported?.quotes?.usd_cny)fx={rate:imported.quotes.usd_cny,date:null,observed_at:imported.updated_at};}
    const walletConfigured=!!env.BINANCE_API_KEY&&!!env.BINANCE_SECRET_KEY||!!await getFinanceSnapshot(env,'credentials:binance');
    const binanceStatus=statusBinance(walletConfigured,binance,binanceError,clock());
    const sources=[{id:'okx',status:okx.cash_valuation.complete?'connected':'partial',note:'已核对只读账户与统一 USD 行情'},{id:'binance',status:binanceStatus.status,note:binanceError?.error||'只读钱包资产'},{id:'offline',status:chain?chainError?'stale':'connected':'error',note:chainError?.error||'已确认链上余额'}];
    const rows=okx.cash_valuation.assets.map(r=>({...r,location:'okx'}));
    if(binance)rows.push(...binance.assets.map(r=>({...r,location:'binance'})));
    if(chain)rows.push({ccy:'BTC',quantity:chain.btc,usd_value:txt(dec(chain.btc).mul(btcUSD)),location:'offline'});
    const portfolio=aggregatePortfolio(rows,sources,btcUSD,fx,clock(),binanceStatus);
    const policy=await getFinanceSnapshot(env,'policy',{}),oldCombined=await getFinanceSnapshot(env,'combined',emptyCombined());
    const holdings=chain?txt(dec(chain.btc).add(okx.summary.btc_holdings_total)):null;
    const binanceBTC=binance&&typeof binance.btc_holdings==='string'?binance.btc_holdings:null;
    const totalBTC=holdings&&binanceBTC!=null?txt(dec(holdings).add(binanceBTC)):holdings;
    // The long-term P&L counts Binance BTC once the book holds Binance's
    // purchase history; until then it stays on OKX and the offline wallet.
    const binanceInBook=cost?.book?.binance_included===true;
    const pnlHoldings=!holdings?null:!binanceInBook?holdings:binanceBTC!=null?totalBTC:null;
    // A Binance merge that failed keeps its reason on the book until a later
    // rebuild succeeds; an account without Binance keys is simply not connected.
    const binanceTrades=cost?.binance_trades||null,tradeError=binanceTrades?.error?.code==='needs_credentials'?null:binanceTrades?.error||null;
    const binanceTradesError=tradeError||cost?.binance_issue||(cost?.book?.binance_failed_at!=null?{code:'binance_history_invalid',error:publicMessages.binance_history_invalid}:null);
    let pnl=emptyPnL(account.slice(0,24),costError?.error||publicMessages.needs_history);
    let costPublic=emptyCost(account.slice(0,24),costError?.error||publicMessages.needs_history);
    if(cost?.book){
      costPublic=costView(cost.book,cost.recent,cost.meta,clock(),account.slice(0,24),costError?'stale':'fresh',costError?.error||null,cost.rates||{});
      costPublic.venues=binanceInBook?['okx','binance']:['okx'];
      costPublic.binance_history={status:binanceInBook?'included':binanceTradesError?'error':binanceTrades?.meta?'importing':'not_connected',records:cost.book.binance_count||0,error:binanceTradesError?.error||null};
      if(pnlHoldings){
        const unverified=policy.verified_nonspot_adjustment_btc!=null&&dec(pnlHoldings).sub(cost.book.inventory).sub(policy.verified_nonspot_adjustment_btc).abs().gte('0.00000001');
        pnl=positionView(cost.book,pnlHoldings,price,cost.meta,policy,clock(),account.slice(0,24),chainError||unverified?'stale':'fresh',chainError?.error||(unverified?'存在新的非现货持仓数量调整待核对。':null));
        pnl.reconciliation={verified_at:policy.verified_at||null,verified_adjustment_btc:policy.verified_nonspot_adjustment_btc||null,change_since_verification_btc:policy.verified_nonspot_adjustment_btc?txt(dec(pnlHoldings).sub(cost.book.inventory).sub(policy.verified_nonspot_adjustment_btc)):null,matched:!unverified};
        pnl.venues=costPublic.venues;
      }else{
        // Holdings that cannot be confirmed (a missing balance source) keep the
        // account-matching previous estimate, marked stale, never a partial one.
        const previousPnl=await getFinanceSnapshot(env,'btc_pnl');
        if(previousPnl?.connection_id===account.slice(0,24))pnl={...previousPnl,status:'stale',error:publicMessages.holdings_unavailable};
      }
    }else{
      // A transient cost query failure preserves the account-matching previous
      // estimate, with an explicit stale flag, never a synthetic zero cost.
      const previousPnl=await getFinanceSnapshot(env,'btc_pnl'),previousCost=await getFinanceSnapshot(env,'btc_cost');
      if(previousPnl?.connection_id===account.slice(0,24)&&costError?.code!=='needs_history'){pnl={...previousPnl,status:'stale',error:costError?.error||publicMessages.network_error};}
      if(previousCost?.connection_id===account.slice(0,24)&&costError?.code!=='needs_history'){costPublic={...previousCost,status:'stale',error:costError?.error||publicMessages.network_error};}
    }
    let combined=emptyCombined(pnl);
    if(holdings){
      const usd=dec(totalBTC).mul(btcUSD),point={timestamp:iso(clock()),btc:totalBTC,usd:txt(usd),cny:fx?txt(usd.mul(fx.rate)):null};
      const prior=Array.isArray(oldCombined.history)?oldCombined.history.filter(p=>Number.isFinite(Date.parse(p.timestamp))&&Date.parse(p.timestamp)>=clock()-365*86400000):[];
      // Preserve verified imported history, appending actual new observations.
      const history=[...prior];if(!history.length||clock()-Date.parse(history.at(-1).timestamp)>=60000)history.push(point);else history[history.length-1]=point;
      const trimmed=history.length>2500?history.filter((_,i)=>i===history.length-1||i%Math.ceil(history.length/2400)===0):history;
      const periods=preserveHistoricalPricePeriods(oldCombined.pnl,clock());
      const sourcesBTC=[{id:'offline',label:'离线钱包',btc:chain.btc,status:chainError?'stale':'fresh',updated_at:chain.updated_at},{id:'okx',label:'欧易',btc:okx.summary.btc_holdings_total,status:'fresh',updated_at:okx.last_success_at}];
      if(binanceBTC!=null)sourcesBTC.push({id:'binance',label:'币安',btc:binanceBTC,status:binanceError?'stale':'fresh',updated_at:binance.observed_at});
      combined={ok:true,stale:!!chainError||!!binanceError,updated_at:iso(clock()),goal_btc:'1',totals:{btc:totalBTC,usd:txt(usd),cny:fx?txt(usd.mul(fx.rate)):null},sources:sourcesBTC,quotes:{btc_usd:btcUSD,usd_cny:fx?.rate||null},history:trimmed,pnl:periods,coverage:{complete:false,note:'已保留迁移前的真实余额历史；云端持续追加新快照。价格变动盈亏保留原核算区间，并注明历史截止时间。'},lifetime_pnl:pnl};
    }
    const currentCredentials=await credentials(env,'okx');if(await connectionIdentity(currentCredentials)!==account)throw new FinanceError('account_changed');
    const write=[['okx',okx],['portfolio',portfolio],['combined',combined],['btc_cost',costPublic],['btc_pnl',pnl],['market',{price_usdt:price,btc_usd:btcUSD,usd_cny:fx?.rate||null,updated_at:iso(clock())}],['sync_status',{ok:true,last_success_ms:clock(),last_attempt_ms:now,cost_error:costError||null,chain_error:chainError,binance_error:binanceError,binance_trades_error:binanceTradesError}]];
    if(chain&&!chainError)write.push(['chain_balance',chain]);if(binance&&!binanceError)write.push(['binance',binance]);if(fx)write.push(['fx',fx]);
    await env.DB.batch(write.map(([k,v])=>putStatement(env,k,v,clock())));
    return {ok:true,updated_at:iso(clock()),cost_error:costError?.code||null,chain_error:chainError?.code||null,binance_error:binanceError?.code||null,binance_trades_error:binanceTradesError?.code||null};
  }catch(error){const e=safeError(error);await put(env,'sync_status',{ok:false,...e,last_attempt_ms:now},now);return {ok:false,...e};}
}

async function schedule(env,ctx,force=false){
  if(!ctx?.waitUntil)return;
  const status=await getFinanceSnapshot(env,'sync_status');
  if(force||!status||Date.now()-(status.last_attempt_ms||0)>55000)ctx.waitUntil(syncFinance(env,{force}).catch(()=>undefined));
}
async function activeOKX(env){try{const c=await credentials(env,'okx');return {configured:true,connection:(await connectionIdentity(c)).slice(0,24)};}catch{return {configured:false,connection:null};}}
async function cachedPublic(env,key){
  const current=await activeOKX(env),snapshot=await getFinanceSnapshot(env,key),status=await getFinanceSnapshot(env,'sync_status');
  const okx=key==='okx'?snapshot:await getFinanceSnapshot(env,'okx');
  if(!current.configured||okx?.connection_id!==current.connection){
    if(key==='okx')return emptyOKX(current.connection,current.configured);
    if(key==='btc_cost')return emptyCost(current.connection);
    if(key==='btc_pnl')return emptyPnL(current.connection);
    if(key==='combined')return emptyCombined(emptyPnL(current.connection));
    return emptyPortfolio();
  }
  if(!snapshot){if(key==='okx')return emptyOKX(current.connection,true);if(key==='btc_cost')return emptyCost(current.connection);if(key==='btc_pnl')return emptyPnL(current.connection);if(key==='combined')return emptyCombined(emptyPnL(current.connection));return emptyPortfolio();}
  const value=structuredClone(snapshot),stamp=Date.parse(value.last_success_at||value.as_of||value.updated_at||'');
  if(!Number.isFinite(stamp)||Date.now()-stamp>180000||status?.ok===false){
    if(key==='okx'){value.status=value.last_success_at?'stale':'error';value.error=status?.error||'云端账户快照待更新。';value.error_code=status?.code||'refresh_failed';}
    else if(key==='btc_cost'||key==='btc_pnl'){value.status='stale';value.error=status?.error||'云端持仓快照待更新。';}
    else value.stale=true;
  }
  if(key==='combined')value.lifetime_pnl=await cachedPublic(env,'btc_pnl');
  return value;
}

async function configure(request,env,venue,ctx){
  if(request.headers.get('X-Terminal-Request')!=='1'||request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')return json({error:'请通过钱包配置页面操作。'},403);
  let body;try{const raw=await request.text();if(raw.length>4096)throw new Error();body=JSON.parse(raw);validateCredentials(body,venue,false);if(!Object.keys(body).length)throw new Error();}catch{return json({error:publicMessages.invalid_request,code:'invalid_request'},400);}
  let existing={};try{existing=await credentials(env,venue);}catch{}
  const candidate=validateCredentials({...existing,...body},venue),client=new ExchangeClient(venue,candidate);await client.syncTime();await client.permissions();
  const value=await encryptConfiguration(candidate,env.CONFIG_ENCRYPTION_KEY),now=Date.now(),connection=venue==='okx'?(await connectionIdentity(candidate)).slice(0,24):null;
  const invalidations=[putStatement(env,'credentials:'+venue,value,now),putStatement(env,'portfolio',null,now),putStatement(env,'sync_status',{ok:false,last_attempt_ms:0,code:'connecting',error:'新账户正在同步。'},now)];
  if(venue==='okx')for(const [k,v] of [['okx',emptyOKX(connection,true)],['combined',emptyCombined(emptyPnL(connection))],['btc_cost',emptyCost(connection)],['btc_pnl',emptyPnL(connection)]])invalidations.push(putStatement(env,k,v,now));
  else invalidations.push(putStatement(env,'binance',null,now));
  await env.DB.batch(invalidations);await schedule(env,ctx,true);
  return venue==='okx'?json(emptyOKX(connection,true)):json({binance:statusBinance(true,null,null,now)});
}

async function publicProxy(request,env){
  const url=new URL(request.url),pairs=[...url.searchParams],query=Object.fromEntries(pairs);
  if(pairs.length!==Object.keys(query).length)throw new FinanceError('invalid_request',400);
  const allowed={address:['resource','address'],transactions:['resource','address','cursor'],history:['resource'],quote:['resource'],fx:['resource','from','to']};
  if(!allowed[query.resource]||Object.keys(query).some(k=>!allowed[query.resource].includes(k)))throw new FinanceError('invalid_request',400);
  if(['address','transactions'].includes(query.resource)){
    if(!env.WALLET_ADDRESS||query.address!==env.WALLET_ADDRESS||query.cursor&&!/^[a-fA-F0-9]{64}$/.test(query.cursor))throw new FinanceError('invalid_request',400);
    const tail=query.resource==='address'?'':'/txs/chain'+(query.cursor?'/'+query.cursor:'');
    try{return json(await publicGET('https://mempool.space/api/address/'+env.WALLET_ADDRESS+tail,globalThis.fetch));}catch{return json(await publicGET('https://blockstream.info/api/address/'+env.WALLET_ADDRESS+tail,globalThis.fetch));}
  }
  if(query.resource==='quote'){
    try{return json(await publicGET('https://mempool.space/api/v1/prices',globalThis.fetch));}catch{const market=await getFinanceSnapshot(env,'market');if(!market?.btc_usd)throw new FinanceError('market_unavailable');return json({time:Math.floor(Date.parse(market.updated_at)/1000),USD:Number(market.btc_usd)});}
  }
  if(query.resource==='history'){
    try{return json(await publicGET('https://mempool.space/api/v1/historical-price?currency=USD',globalThis.fetch));}catch{const seed=await getFinanceSnapshot(env,'chain_snapshot');if(!Array.isArray(seed?.prices))throw new FinanceError('network_error');return json({prices:seed.prices});}
  }
  if(!/^\d{4}-\d{2}-\d{2}$/.test(query.from||'')||!/^\d{4}-\d{2}-\d{2}$/.test(query.to||'')||!Number.isFinite(Date.parse(query.from))||!Number.isFinite(Date.parse(query.to))||Date.parse(query.to)<Date.parse(query.from)||Date.parse(query.to)-Date.parse(query.from)>3660*86400000)throw new FinanceError('invalid_request',400);
  return json(await publicGET('https://api.frankfurter.dev/v2/rates?'+new URLSearchParams({from:query.from,to:query.to,base:'USD',quotes:'CNY',providers:'ecb'}),globalThis.fetch));
}
export async function handleFinance(request,env,ctx){
  const url=new URL(request.url),path=url.pathname;
  const known=['/api/wallet/okx','/api/wallet/okx/config','/api/wallet/okx/refresh','/api/wallet/binance','/api/wallet/binance/config','/api/wallet/portfolio','/api/wallet/combined','/api/wallet/btc-cost','/api/wallet/btc-pnl','/api/wallet/proxy'];
  if(!known.includes(path))return null;
  try{
    if(path==='/api/wallet/proxy'){if(request.method!=='GET')return json({error:publicMessages.method},405);return await publicProxy(request,env);}
    if(url.search)return json({error:'此接口不接受查询参数。'},400);
    if(path.endsWith('/config')){if(request.method!=='POST')return json({error:publicMessages.method},405);return await configure(request,env,path.includes('binance')?'binance':'okx',ctx);}
    if(path==='/api/wallet/okx/refresh'){
      if(request.method!=='POST')return json({error:publicMessages.method},405);
      if(request.headers.get('X-Terminal-Request')!=='1'||request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')return json({error:'请从钱包页面操作。'},403);
      let body;try{const raw=await request.text();if(raw.length>64)throw new Error();body=JSON.parse(raw);if(!body||Array.isArray(body)||Object.keys(body).length)throw new Error();}catch{return json({error:publicMessages.invalid_request},400);}
      await schedule(env,ctx,true);return json(await cachedPublic(env,'okx'),202);
    }
    if(request.method!=='GET')return json({error:publicMessages.method},405);
    await schedule(env,ctx);
    if(path==='/api/wallet/binance'){const portfolio=await cachedPublic(env,'portfolio');return json(portfolio.binance);}
    const key={'/api/wallet/okx':'okx','/api/wallet/portfolio':'portfolio','/api/wallet/combined':'combined','/api/wallet/btc-cost':'btc_cost','/api/wallet/btc-pnl':'btc_pnl'}[path];
    return json(await cachedPublic(env,key));
  }catch(error){const e=safeError(error);return json(e,error instanceof FinanceError?error.status:503);}
}
