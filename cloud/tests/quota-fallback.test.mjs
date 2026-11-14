import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.mjs';
import {handleFinance} from '../finance.mjs';
import {buildOverview} from '../overview.mjs';
import {handleAuth} from '../auth.mjs';
import {saveFinanceBackup,financeBackupScope} from '../finance-backup.mjs';
const NOW=Date.now(),at=new Date(NOW-3600000).toISOString();
const QUOTA=()=>new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. [7500]");
function fixture(){
 let value=null;const env={OKX_API_KEY:'fixture-okx',OKX_SECRET_KEY:'fixture-secret',OKX_PASSPHRASE:'fixture-pass',BINANCE_API_KEY:'A'.repeat(64),BINANCE_SECRET_KEY:'B'.repeat(64),WALLET_ADDRESS:'bc1q'+'a'.repeat(38),AUTH_SECRET:'auth-fixture-secret-that-is-long-enough',OWNER_ACCESS_KEY:'owner-fixture-access-key-is-long-enough',DB:{prepare(){return {bind(){return this;},async first(){throw QUOTA();},async all(){throw QUOTA();},async run(){throw QUOTA();}};}},FINANCE_BACKUP:{async get(){return value;},async put(_,raw){value=JSON.parse(raw);}}};
 const position={status:'fresh',connection_id:'fixture-account',as_of:at,metrics:{holdings_btc:'0.1',remaining_cost:'9000',average_cost:'90000'}};
 const snapshots={combined:{ok:true,updated_at:at,totals:{btc:'0.1',usd:'10000',cny:'70000'},sources:[],history:[{timestamp:at,btc:'0.1',usd:'10000',cny:'70000'}],pnl:{},lifetime_pnl:position},btc_pnl:position,btc_cost:{status:'fresh',connection_id:'fixture-account',last_success_at:at,summary:{by_currency:[],net_bought_btc:'0.1'},today:null},portfolio:{updated_at:at,complete:true,total_usd:'10000',assets:[],locations:[],sources:[],binance:{configured:true}},okx:{configured:true,status:'connected',connection_id:'fixture-account',last_success_at:at,assets:[],summary:{}},market:{updated_at:at,price_usdt:'100000'},dca_diary:{as_of:at,connection_id:'fixture-account',fields:['date','btc','usdt','buys'],days:[['2026-11-14','0.001','100',1]],totals:{btc:'0.001',usdt:'100',buys:1,days:1}}};
 return {env,snapshots};
}
test('quota exhaustion serves authenticated dated backups for balance, cost and diary without exposing credentials',async()=>{
 const {env,snapshots}=fixture();assert.equal((await saveFinanceBackup(env,snapshots,{scope:await financeBackupScope(env),now:NOW})).saved,true);
 for(const name of ['combined','btc-cost','btc-pnl','portfolio','okx','btc-dca-diary']){
  const response=await handleFinance(new Request('https://fixture.test/api/wallet/'+name),env,{}),body=await response.json();assert.equal(response.status,200,name);assert.equal(body.stale,true);assert.equal(body.backup.read_only,true);assert.equal(body.backup.observed_at,at);assert.equal(JSON.stringify(body).includes(env.OKX_SECRET_KEY),false);
 }
 const overview=await buildOverview(env,{});assert.equal(overview.wallet.status,'stale');assert.equal(overview.wallet.btcHoldings,'0.1');assert.equal(overview.alerts.status,'stale');
});
test('fallback never opens a private endpoint, bypasses request validation or fabricates a missing snapshot',async()=>{
 const {env,snapshots}=fixture();await saveFinanceBackup(env,snapshots,{scope:await financeBackupScope(env),now:NOW});const ctx={waitUntil(){}};
 const unauth=await worker.fetch(new Request('https://fixture.test/btc/api/wallet/combined'),env,ctx);assert.equal(unauth.status,401);
 const invalid=await handleFinance(new Request('https://fixture.test/api/wallet/combined?unexpected=1'),env,ctx);assert.equal(invalid.status,400);
 const wrongMethod=await handleFinance(new Request('https://fixture.test/api/wallet/combined',{method:'POST'}),env,ctx);assert.equal(wrongMethod.status,405);
 delete env.FINANCE_BACKUP;assert.equal((await handleFinance(new Request('https://fixture.test/api/wallet/combined'),env,ctx)).status,503);
});
test('a correct owner login during the quota outage reaches the backup through the real protected Worker',async()=>{
 const {env,snapshots}=fixture();await saveFinanceBackup(env,snapshots,{scope:await financeBackupScope(env),now:NOW});
 const request=new Request('https://fixture.test/auth/login',{method:'POST',headers:{Origin:'https://fixture.test','Content-Type':'application/json'},body:JSON.stringify({accessKey:env.OWNER_ACCESS_KEY})});
 const login=await handleAuth(request,env);assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const response=await worker.fetch(new Request('https://fixture.test/btc/api/wallet/combined',{headers:{Cookie:cookie}}),env,{waitUntil(){}});assert.equal(response.status,200);assert.equal((await response.json()).totals.btc,'0.1');
});
