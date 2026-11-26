import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {connectionIdentity,sha256} from '../exchange.mjs';
import {FINANCE_BACKUP_KEY,FINANCE_BACKUP_REVOKED_KEY,financeBackupScope,readFinanceBackup,saveFinanceBackup} from '../finance-backup.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const NOW=Date.parse('2026-11-14T23:20:00Z'),AT='2026-11-14T23:10:00.000Z';
function fixture(){
  const kv={raw:null,revoked:null,reads:0,writes:[],failGet:false,failPut:false,async get(key){this.reads++;if(this.failGet)throw new Error('private store error');if(key===FINANCE_BACKUP_REVOKED_KEY)return this.revoked;assert.equal(key,FINANCE_BACKUP_KEY);return this.raw;},async put(key,raw){if(this.failPut)throw new Error('private put error');if(key===FINANCE_BACKUP_REVOKED_KEY){this.revoked=raw;return;}assert.equal(key,FINANCE_BACKUP_KEY);this.writes.push(raw);this.raw=raw;}};
  const env={FINANCE_BACKUP:kv,OKX_API_KEY:'fixture-okx',OKX_SECRET_KEY:'fixture-secret',OKX_PASSPHRASE:'fixture-pass',BINANCE_API_KEY:'A'.repeat(64),BINANCE_SECRET_KEY:'B'.repeat(64),WALLET_ADDRESS:'bc1q'+'a'.repeat(38)};
  // If the implementation accidentally touches D1, the outage test must fail.
  Object.defineProperty(env,'DB',{get(){throw new Error('D1 must not be read');}});
  return {env,kv};
}
function bundle(){
  const pnl={status:'fresh',connection_id:'account-a',as_of:AT,metrics:{holdings_btc:'0.1',remaining_cost:'6000',unrealized_net:'-10'}};
  return {
    okx:{configured:true,connection_id:'account-a',status:'connected',last_success_at:AT,assets:[],summary:{btc_holdings_total:'0.02'}},
    portfolio:{updated_at:AT,complete:true,stale:false,total_usd:'5990',assets:[],locations:[],sources:[],binance:{configured:true}},
    combined:{ok:true,stale:false,updated_at:AT,totals:{btc:'0.1',usd:'5990',cny:'41930'},sources:[{id:'offline',btc:'0.08',status:'fresh',updated_at:AT}],history:[{timestamp:AT,btc:'0.1',usd:'5990',cny:'41930',price_usd:'59900',fx:'7',pnl_usd:'-10',pnl_cny:'-70',internal_transfer_adjustment:{raw_btc:'0.08',transfer_ids:['private-withdrawal-id']}}],pnl:{today:{usd:'-10',cny:'-70',status:'estimated',start_at:AT,end_at:AT}},lifetime_pnl:pnl,transfer_connection:'private-fingerprint'},
    btc_cost:{status:'fresh',last_success_at:AT,connection_id:'account-a',summary:{invested_usdt:'6000'}},
    btc_pnl:pnl,
    market:{price_usdt:'59900',updated_at:AT},
    dca_diary:{status:'fresh',as_of:AT,connection_id:'account-a',fields:['date','btc','usdt','buys'],days:[['2026-11-14','0.001','60',1]],totals:{btc:'0.001',usdt:'60',buys:1,days:1},key:'private-derived-cache-key',connection:'private-fingerprint'},
  };
}
async function seed(f,data=bundle(),at=NOW){const scope=await financeBackupScope(f.env);const result=await saveFinanceBackup(f.env,data,{scope,now:at});assert.equal(result.saved,true);return scope;}

test('runtime scope matches the validated two-exchange and cold-wallet scope without D1',async()=>{
  const {env}=fixture();
  const a=await connectionIdentity({api_key:env.OKX_API_KEY,secret_key:env.OKX_SECRET_KEY});
  const b=await connectionIdentity({api_key:env.BINANCE_API_KEY,secret_key:env.BINANCE_SECRET_KEY});
  assert.equal(await financeBackupScope(env),await sha256(JSON.stringify([a,b,env.WALLET_ADDRESS])));
  const without={...env};delete without.BINANCE_API_KEY;delete without.BINANCE_SECRET_KEY;
  assert.equal(await financeBackupScope(without),await sha256(JSON.stringify([a,'not_connected',env.WALLET_ADDRESS])));
  assert.equal(await financeBackupScope({...env,OKX_SECRET_KEY:null}),null);
});
test('persisted revocation blocks an older in-flight writer from resurrecting an account backup',async()=>{
 const f=fixture(),scope=await seed(f);await f.kv.put(FINANCE_BACKUP_REVOKED_KEY,scope);
 assert.equal(await readFinanceBackup(f.env,'combined'),null);
 assert.equal((await saveFinanceBackup(f.env,bundle(),{scope,force:true,now:NOW+600000})).saved,false);assert.equal(f.kv.writes.length,1);
});

test('a private dated snapshot restores every supported view, marks it stale and strips transfer evidence',async()=>{
  const f=fixture(),source=bundle();await seed(f,source);
  for(const key of Object.keys(source)){
    const result=await readFinanceBackup(f.env,key);assert.ok(result,key);assert.equal(result.stale,true,key);assert.equal(result.backup.read_only,true);assert.equal(result.backup.saved_at,new Date(NOW).toISOString());assert.match(result.backup.note,/2026-11-15 07:10 北京时间/);assert.equal(result.backup.observed_at,AT);
    for(const field of ['updated_at','last_success_at','as_of'])if(field in source[key])assert.equal(result[field],source[key][field],'never label a stored observation as current');
  }
  const combined=await readFinanceBackup(f.env,'combined');assert.equal(combined.totals.btc,'0.1');assert.equal(combined.lifetime_pnl.status,'stale');assert.equal(combined.sources[0].status,'stale');assert.equal(combined.pnl.today.status,'stale');
  assert.deepEqual(combined.history,[{timestamp:AT,btc:'0.1',usd:'5990',cny:'41930'}]);assert.equal('transfer_connection'in combined,false);assert.doesNotMatch(JSON.stringify(combined),/private-withdrawal-id|private-fingerprint/);
  const diary=await readFinanceBackup(f.env,'dca_diary');assert.equal(diary.status,'stale');assert.deepEqual(diary.days,source.dca_diary.days);assert.deepEqual(diary.holding_cost_history,[]);assert.equal('key'in diary,false);assert.equal('connection'in diary,false);
  assert.equal(source.combined.stale,false,'input is not mutated');
});

test('account or wallet changes and unavailable configuration never expose another snapshot',async()=>{
  const f=fixture();await seed(f);
  for(const update of [{OKX_API_KEY:'other-owner'},{BINANCE_API_KEY:'C'.repeat(64)},{WALLET_ADDRESS:'bc1q'+'b'.repeat(38)},{OKX_SECRET_KEY:null}])assert.equal(await readFinanceBackup({...f.env,...update},'combined'),null);
  assert.equal(await readFinanceBackup({...f.env,FINANCE_BACKUP:null},'combined'),null);assert.equal(await readFinanceBackup(f.env,'internal_transfers'),null);
  const before=f.kv.raw;const result=await saveFinanceBackup(f.env,bundle(),{scope:'different-current-DB-account',now:NOW+600000,force:true});assert.equal(result.reason,'scope_mismatch');assert.equal(f.kv.raw,before);
});

test('five-minute throttling and concurrent callers keep a single aggregate KV write',async()=>{
  const f=fixture(),scope=await seed(f);
  assert.equal(f.kv.writes.length,1);
  const results=await Promise.all(Array.from({length:12},()=>saveFinanceBackup(f.env,bundle(),{scope,now:NOW+299999})));
  assert.ok(results.every(row=>row.reason==='throttled'));assert.equal(f.kv.writes.length,1);
  await saveFinanceBackup(f.env,bundle(),{scope,now:NOW+300000});assert.equal(f.kv.writes.length,2);
  await saveFinanceBackup(f.env,bundle(),{scope,now:NOW+300001,force:true});assert.equal(f.kv.writes.length,3,'explicit administrative force can seed an outage backup');
});

test('null, failed, missing and older observations cannot erase an existing valid backup',async()=>{
  const f=fixture(),scope=await seed(f),old=JSON.parse(f.kv.raw);
  const next={...bundle(),combined:null,btc_cost:{status:'unavailable'},btc_pnl:null,market:{price_usdt:'59800',updated_at:'2026-11-14T23:15:00Z'}};
  await saveFinanceBackup(f.env,next,{scope,now:NOW+300000});const stored=JSON.parse(f.kv.raw);
  assert.deepEqual(stored.snapshots.combined,old.snapshots.combined);assert.deepEqual(stored.snapshots.btc_cost,old.snapshots.btc_cost);assert.deepEqual(stored.snapshots.btc_pnl,old.snapshots.btc_pnl);assert.equal(stored.snapshots.market.price_usdt,'59800');
  await saveFinanceBackup(f.env,{market:{price_usdt:'1',updated_at:'2026-11-14T20:00:00Z'}},{scope,now:NOW+600000});assert.equal(JSON.parse(f.kv.raw).snapshots.market.price_usdt,'59800');
  const before=f.kv.raw;assert.equal((await saveFinanceBackup(f.env,{combined:null},{scope,now:NOW+900000})).saved,false);assert.equal(f.kv.raw,before);
});

test('KV errors preserve the old record and malformed records fail closed',async()=>{
  const f=fixture(),scope=await seed(f),before=f.kv.raw;f.kv.failPut=true;
  assert.equal((await saveFinanceBackup(f.env,bundle(),{scope,now:NOW+300000})).reason,'write_failed');assert.equal(f.kv.raw,before);
  f.kv.failGet=true;assert.equal(await readFinanceBackup(f.env,'combined'),null);assert.equal((await saveFinanceBackup(f.env,bundle(),{scope,now:NOW+600000})).saved,false);assert.equal(f.kv.raw,before);
  f.kv.failGet=false;
  for(const raw of ['not-json','null',JSON.stringify({version:2,scope,updated_ms:NOW,snapshots:bundle()}),JSON.stringify({version:1,scope,updated_ms:NOW,snapshots:{combined:{totals:{btc:'0.1'}}}})]){f.kv.raw=raw;assert.equal(await readFinanceBackup(f.env,'combined'),null);}
});

test('returned objects are independent and the standalone P&L uses the aggregate position',async()=>{
  const f=fixture(),data=bundle();data.btc_pnl={...data.btc_pnl,metrics:{holdings_btc:'999',remaining_cost:'1'}};await seed(f,data);
  const first=await readFinanceBackup(f.env,'combined');first.history[0].btc='999';first.lifetime_pnl.metrics.remaining_cost='1';first.sources[0].btc='999';
  const second=await readFinanceBackup(f.env,'combined'),pnl=await readFinanceBackup(f.env,'btc_pnl');
  assert.equal(second.history[0].btc,'0.1');assert.equal(second.sources[0].btc,'0.08');assert.equal(pnl.metrics.holdings_btc,'0.1');assert.deepEqual(pnl.metrics,second.lifetime_pnl.metrics);
});

test('backups never publish supplied credentials or private chain proof fields',async()=>{
  const f=fixture(),data=bundle();data.combined.sources[0].api_key='private-key';data.combined.sources[0].proof={txid:'private-chain-tx'};data.btc_pnl.secret_key='private-secret';data.combined.lifetime_pnl.passphrase='private-pass';await seed(f,data);
  assert.doesNotMatch(JSON.stringify(await readFinanceBackup(f.env,'combined')),/private-key|private-chain-tx|private-pass/);assert.doesNotMatch(JSON.stringify(await readFinanceBackup(f.env,'btc_pnl')),/private-secret|private-pass/);
});
