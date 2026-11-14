import test from 'node:test';
import assert from 'node:assert/strict';
import {readInternalTransfers} from '../transfer-reader.mjs';
const NOW=Date.parse('2026-11-14T21:40:00Z'),ADDRESS='bc1q'+'a'.repeat(38),OTHER='bc1q'+'b'.repeat(38),HASH='a'.repeat(64);
function binance(extra={}){return {coin:'BTC',network:'BTC',address:ADDRESS,id:'wd-1',applyTime:'2026-11-14 21:09:50',completeTime:'2026-11-14 21:22:33',amount:'0.01058938',transactionFee:'0.00002',status:6,transferType:0,txId:HASH,...extra};}
function okx(extra={}){return {ccy:'BTC',chain:'BTC-Bitcoin',to:ADDRESS,wdId:'99',ts:String(NOW-1800000),amt:'0.01',fee:'0.00002',feeCcy:'BTC',state:'2',txId:HASH,...extra};}
function tx(extra={}){return {txid:HASH,status:{confirmed:true,block_time:Math.floor((NOW-1000000)/1000)},vin:[{prevout:{scriptpubkey_address:OTHER,value:1200000}}],vout:[{scriptpubkey_address:ADDRESS,value:1058938}],...extra};}
function harness({okxRows=null,binanceRows=[binance()],proof=tx(),failRead=false,fetcher}={}){
 const calls=[],client=venue=>({async get(path,params){calls.push({venue,path,params});if(failRead===true||failRead===venue)throw new Error('do not echo private credentials');return venue==='okx'?okxRows:binanceRows;}});
 const input={connection:'wallet-scope-A',address:ADDRESS,now:NOW,okxClient:okxRows===null?null:client('okx'),binanceClient:binanceRows===null?null:client('binance'),fetch:async(url,options)=>{calls.push({url,options});return fetcher?fetcher(url,options):new Response(JSON.stringify(proof),{headers:{'Content-Type':'application/json'}});}};
 return {input,calls,read:extra=>readInternalTransfers({...input,...extra})};
}
test('a real-shaped Binance withdrawal proves exact net receipt, fee, UTC dates and distinct output',async()=>{
 const h=harness(),result=await h.read(),row=result.transfers[0];assert.equal(result.status,'fresh');assert.equal(row.amount_btc,'0.01058938');assert.equal(row.fee_btc,'0.00002');assert.equal(row.started_ms,Date.parse('2026-11-14T21:09:50Z'));assert.equal(row.settled_ms,Date.parse('2026-11-14T21:22:33Z'));assert.equal(row.ended_ms,row.settled_ms+600000);assert.equal(row.id,'binance:wd-1');assert.deepEqual(row.proof.output_indices,[0]);assert.equal(row.proof.amount_sats,'1058938');
 assert.deepEqual(h.calls[0],{venue:'binance',path:'/sapi/v1/capital/withdraw/history',params:{coin:'BTC',startTime:NOW-7*86400000,endTime:NOW,limit:1000,recvWindow:5000}});
 assert.equal(h.calls[1].url,'https://blockstream.info/api/tx/'+HASH);assert.equal(h.calls[1].options.method,'GET');assert.equal(h.calls[1].options.redirect,'manual');assert.ok(h.calls[1].options.signal);assert.ok(!JSON.stringify(result).includes(ADDRESS));
});
test('OKX uses its read-only seven-day mainnet query and first observed success time',async()=>{
 const h=harness({okxRows:[okx()],binanceRows:null,proof:tx({vout:[{scriptpubkey_address:ADDRESS,value:1000000}]})}),result=await h.read();assert.equal(result.transfers[0].id,'okx:99');assert.equal(result.transfers[0].settled_ms,NOW);assert.deepEqual(h.calls[0],{venue:'okx',path:'/api/v5/asset/withdrawal-history',params:{ccy:'BTC',type:4,limit:100}});
});
test('other recipients, currencies, expired successful rows and cancelled withdrawals do not become assets',async()=>{
 const h=harness({binanceRows:[binance({id:'other',address:OTHER}),binance({id:'othercoin',coin:'USDT'}),binance({id:'old',applyTime:'2026-11-01 00:00:00'}),binance({id:'cancel',status:1})]}),result=await h.read();assert.equal(result.status,'fresh');assert.equal(result.transfers.length,0);assert.equal(result.awaiting.length,0);assert.equal(h.calls.length,1);
});
test('missing transaction id stays explicitly pending and cannot prove money by amount alone',async()=>{
 const h=harness({binanceRows:[binance({status:4,completeTime:'',txId:''})]}),result=await h.read();assert.equal(result.status,'pending');assert.equal(result.transfers.length,0);assert.equal(result.awaiting[0].status,'pending');assert.equal(result.awaiting[0].amount_btc,'0.01058938');assert.equal(result.awaiting[0].fee_btc,'0.00002');assert.equal(result.awaiting[0].verified,false);assert.equal(result.awaiting[0].ended_ms,NOW+600000);assert.equal(h.calls.length,1);
});
test('malformed transaction ids stay unknown and make the venue stale',async()=>{
 const result=await harness({binanceRows:[binance({txId:'not-a-tx'})]}).read();assert.equal(result.status,'stale');assert.equal(result.transfers.length,0);assert.equal(result.awaiting[0].status,'unknown');
});
test('malformed network, amount, timestamp, fee, duplicate ID and full pages fail closed',async()=>{
 for(const extra of [{network:'BSC'},{amount:'0.000000001'},{amount:'1e-2'},{transactionFee:'-1'},{applyTime:'2026-02-30 00:00:00'},{completeTime:'2026-11-14 20:00:00'},{transferType:1}]){const result=await harness({binanceRows:[binance(extra)]}).read();assert.equal(result.status,'stale',JSON.stringify(extra));assert.equal(result.transfers.length,0);}
 for(const rows of [[binance(),binance()],Array.from({length:1000},(_,i)=>binance({id:String(i)})),{}]){const result=await harness({binanceRows:rows}).read();assert.equal(result.status,'stale');assert.equal(result.transfers.length,0);}
 const nonBTCFee=await harness({okxRows:[okx({feeCcy:'USDT'})],binanceRows:null}).read();assert.equal(nonBTCFee.status,'stale');
});
test('proof txid, target output amount and self-spending inputs are all checked',async()=>{
 for(const proof of [tx({txid:'b'.repeat(64)}),tx({vout:[{scriptpubkey_address:ADDRESS,value:1058939}]}),tx({vout:[{scriptpubkey_address:OTHER,value:1058938}]}),tx({vin:[{prevout:{scriptpubkey_address:ADDRESS,value:1200000}}]}),tx({status:{confirmed:true}}),tx({vout:[{scriptpubkey_address:ADDRESS,value:-1}]})]){const result=await harness({proof}).read();assert.equal(result.status,'stale');assert.equal(result.transfers.length,0);assert.equal(result.awaiting[0].verified,false);}
});
test('two withdrawals in the same batch allocate separate outputs, never the entire address total twice',async()=>{
 const rows=[binance({id:'a',amount:'0.001'}),binance({id:'b',amount:'0.002'})],proof=tx({vout:[{scriptpubkey_address:ADDRESS,value:100000},{scriptpubkey_address:ADDRESS,value:200000}]});
 const good=await harness({binanceRows:rows,proof}).read();assert.equal(good.transfers.length,2);assert.deepEqual(good.transfers.map(row=>row.proof.output_indices),[[0],[1]]);
 const duplicate=await harness({binanceRows:[binance({id:'a'}),binance({id:'b'})]}).read();assert.equal(duplicate.status,'stale');assert.equal(duplicate.transfers.length,0);assert.equal(duplicate.awaiting.length,2);
});
test('pending proof refreshes every minute and extends its reconciliation window until settled',async()=>{
 const h=harness({binanceRows:[binance({status:4,completeTime:''})],proof:tx({status:{confirmed:false}})}),first=await h.read();assert.equal(first.status,'pending');assert.equal(first.transfers[0].settled_ms,null);assert.equal(first.transfers[0].ended_ms,NOW+600000);
 const before=h.calls.length,cached=await h.read({cached:first,now:NOW+59000});assert.equal(h.calls.length,before);assert.equal(cached.transfers[0].ended_ms,NOW+659000);
 await h.read({cached:first,now:NOW+60000});assert.equal(h.calls.length,before+2);
});
test('empty and settled manifests use five-minute TTL, while force bypasses a new empty cache',async()=>{
 const h=harness({binanceRows:[]}),first=await h.read();await h.read({cached:first,now:NOW+299999});assert.equal(h.calls.length,1);await h.read({cached:first,now:NOW+300000});assert.equal(h.calls.length,2);await h.read({cached:first,now:NOW+1000,force:true});assert.equal(h.calls.length,3);
 const complete=harness(),settled=await complete.read();await complete.read({cached:settled,now:NOW+300000});assert.equal(complete.calls.filter(row=>row.url).length,1,'confirmed proof survives the next successful provider refresh');
});
test('confirmed chain proof advances exchange completion without staying pending or fetching it twice',async()=>{
 const first=await harness({binanceRows:[binance({status:4,completeTime:''})]}).read();assert.equal(first.transfers[0].proof.confirmed,true);assert.equal(first.transfers[0].settled_ms,null);
 const h=harness(),next=await h.read({cached:first,now:NOW+60000});assert.equal(next.status,'fresh');assert.equal(next.transfers[0].settled_ms,Date.parse('2026-11-14T21:22:33Z'));assert.equal(h.calls.filter(row=>row.url).length,0);
});
test('failed source reads preserve same-account proof with stale status and do not leak upstream messages',async()=>{
 const first=await harness().read(),bad=harness({failRead:true}),result=await bad.read({cached:first,now:NOW+300000});assert.equal(result.status,'stale');assert.equal(result.transfers.length,1);assert.equal(result.transfers[0].verified,true);assert.ok(!JSON.stringify(result).includes('private credentials'));
 const replaced=await bad.read({cached:first,now:NOW+300000,connection:'account-B'});assert.equal(replaced.transfers.length,0);
});
test('one unavailable exchange does not block verified evidence from the other',async()=>{
 const h=harness({okxRows:[],binanceRows:[binance()],failRead:'okx'}),result=await h.read();assert.equal(result.status,'stale');assert.equal(result.venues.okx.status,'stale');assert.equal(result.transfers[0].venue,'binance');
});
test('a configured but unreachable exchange is stale rather than falsely not connected',async()=>{
 const h=harness({okxRows:[],binanceRows:null}),result=await h.read({binanceExpected:true});assert.equal(result.status,'stale');assert.equal(result.venues.binance.status,'stale');assert.equal(result.venues.okx.status,'fresh');
});
test('a cancelled or failed withdrawal revokes previously pending cached proof',async()=>{
 const first=await harness({binanceRows:[binance({status:4,completeTime:''})],proof:tx({status:{confirmed:false}})}).read();
 const result=await harness({binanceRows:[binance({status:5})]}).read({cached:first,now:NOW+60000});assert.equal(result.status,'fresh');assert.equal(result.transfers.length,0);assert.equal(result.awaiting.length,0);
});
test('lost public proof keeps previously verified evidence but explicitly marks it stale',async()=>{
 const h=harness({binanceRows:[binance({status:4,completeTime:''})],proof:tx({status:{confirmed:false}})}),first=await h.read();
 const next=await harness({binanceRows:[binance({status:4,completeTime:''})],fetcher:()=>new Response('not found',{status:404})}).read({cached:first,now:NOW+60000});assert.equal(next.status,'stale');assert.equal(next.transfers.length,1);assert.equal(next.awaiting[0].status,'unknown');
});
test('successful proof is retained for seven days; pending evidence is not silently discarded after a day',async()=>{
 const first=await harness().read(),next=await harness({binanceRows:[]}).read({cached:first,now:NOW+8*86400000});assert.equal(next.transfers.length,0);
 const h=harness({binanceRows:[binance({status:4,completeTime:''})],proof:tx({status:{confirmed:false}})}),pending=await h.read();
 const renewed=await h.read({cached:pending,now:NOW+2*86400000});assert.equal(renewed.transfers.length,1);assert.equal(renewed.transfers[0].ended_ms,NOW+2*86400000+600000);
});
test('public proof requests are bounded, redirects fail, and response size is limited',async()=>{
 const rows=Array.from({length:10},(_,i)=>binance({id:String(i),txId:i.toString(16).padStart(64,'0')}));
 const h=harness({binanceRows:rows,fetcher:url=>new Response(JSON.stringify(tx({txid:url.split('/').at(-1)})))}),result=await h.read();assert.equal(h.calls.filter(row=>row.url).length,8);assert.equal(result.status,'stale');assert.equal(result.transfers.length,8);assert.equal(result.awaiting.length,2);
 for(const fetcher of [()=>new Response('',{status:302,headers:{Location:'https://evil.invalid'}}),()=>new Response('x'.repeat(262145)),()=>new Response('{}',{headers:{'Content-Length':'262145'}})]){const result=await harness({fetcher}).read();assert.equal(result.status,'stale');assert.equal(result.transfers.length,0);}
});
