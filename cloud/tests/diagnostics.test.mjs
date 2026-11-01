import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {testDatabase} from './auth-mail-fixture.mjs';
import {FINANCE_SCHEMA_SQL} from '../finance.mjs';
import {encryptConfiguration} from '../exchange.mjs';
import {diagnoseReadOnlyAccounts} from '../diagnostics.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const NOW=Date.parse('2026-10-28T04:00:00+08:00');

test('diagnostics use the keys saved from the page and check the balance and trade-history reads without exposing data',async t=>{
  const {DB,sqlite}=testDatabase(FINANCE_SCHEMA_SQL);t.after(()=>sqlite.close());
  const env={DB,CONFIG_ENCRYPTION_KEY:'fixture-encryption-key-which-is-not-a-real-secret'};
  const okx={api_key:'saved-okx-key',secret_key:'saved-okx-secret',passphrase:'saved-pass'},binance={api_key:'K'.repeat(64),secret_key:'S'.repeat(64)};
  for(const [venue,value] of [['okx',okx],['binance',binance]])await DB.prepare('INSERT INTO finance_kv(key,value,updated_ms) VALUES(?,?,?)').bind('credentials:'+venue,JSON.stringify(await encryptConfiguration(value,env.CONFIG_ENCRYPTION_KEY)),NOW).run();
  await DB.prepare('INSERT INTO finance_kv(key,value,updated_ms) VALUES(?,?,?)').bind('binance_trades_meta',JSON.stringify({complete:true,record_count:3,updated_at:'2026-10-28T00:00:00Z'}),NOW).run();
  const original=globalThis.fetch,seen=[];t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(address,options)=>{
    const u=new URL(address);seen.push({path:u.pathname,headers:options.headers});
    if(u.pathname==='/api/v5/public/time')return Response.json({code:'0',data:[{ts:String(Date.now())}]});
    if(u.pathname==='/api/v5/account/config')return Response.json({code:'0',data:[{perm:'read_only'}]});
    if(u.pathname==='/api/v3/time')return Response.json({serverTime:Date.now()});
    if(u.pathname==='/sapi/v1/account/apiRestrictions')return Response.json({enableReading:true,enableWithdrawals:false});
    if(u.pathname==='/sapi/v1/asset/wallet/balance')return Response.json([{walletName:'Spot',activate:true,balance:'0.01',assetBalances:[{asset:'BTC',free:'0.01',locked:'0',freeze:'0',withdrawing:'0',btcValuation:'0.01'}]}]);
    if(u.pathname==='/api/v3/myTrades')return Response.json([{id:1,orderId:2,price:'1',qty:'1',quoteQty:'1',commission:'0',commissionAsset:'BTC',time:1,isBuyer:true}]);
    throw new Error('unexpected '+u.pathname);
  };
  const result=await diagnoseReadOnlyAccounts(env);
  assert.equal(result.okx.ok,true);assert.equal(result.binance.ok,true);assert.equal(result.binance.balance_detail,true);assert.equal(result.binance.trade_history,true);
  assert.deepEqual(result.binance.trade_import,{complete:true,records:3,updated_at:'2026-10-28T00:00:00Z'});
  assert.ok(seen.some(r=>r.headers['OK-ACCESS-KEY']==='saved-okx-key'),'the saved OKX key is the one tested');
  assert.doesNotMatch(JSON.stringify(result),/saved-okx|KKKK|0\.01/);
  // A missing key reports the stage instead of throwing.
  const empty=testDatabase(FINANCE_SCHEMA_SQL);t.after(()=>empty.sqlite.close());
  const missing=await diagnoseReadOnlyAccounts({DB:empty.DB});
  assert.equal(missing.okx.ok,false);assert.equal(missing.okx.stage,'credentials');assert.equal(missing.binance.trade_import,null);
});
