// Internal reconciliation evidence only. This manifest must never be returned
// by a public wallet endpoint; it intentionally contains withdrawal txids.
const DAY=86400000,WINDOW=7*DAY,GRACE=600000,MAX_TX_REQUESTS=8,MAX_BYTES=262144;
const SATOSHIS=100000000n,MAX_MONEY=21000000n*SATOSHIS;
const ADDRESS=/^(?:bc1[a-z0-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;
const TXID=/^[a-fA-F0-9]{64}$/;
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const fail=code=>{const error=new Error(code);error.code=code;throw error;};
function sats(value,positive=false){
  if(typeof value!=='string'||! /^(?:0|[1-9]\d{0,7})(?:\.\d{1,18})?$/.test(value))return null;
  const [whole,fraction='']=value.split('.');if(/[1-9]/.test(fraction.slice(8)))return null;
  const result=BigInt(whole)*SATOSHIS+BigInt(fraction.slice(0,8).padEnd(8,'0'));
  return result>MAX_MONEY||positive&&result===0n?null:result;
}
function btc(value){const whole=value/SATOSHIS,fraction=(value%SATOSHIS).toString().padStart(8,'0').replace(/0+$/,'');return whole+(fraction?'.'+fraction:'');}
function utc(value){
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z)?$/.test(value))return null;
  const normalized=value.replace(' ','T').replace(/Z$/,'')+'Z',result=Date.parse(normalized);
  return integer(result)&&new Date(result).toISOString().slice(0,19)===normalized.slice(0,19)?result:null;
}
function retained(row,at){return row?.settled_ms===null||row?.proof?.confirmed===false||integer(row?.settled_ms)&&row.settled_ms>=at-WINDOW;}
function validCached(row,at){
  return row&&['okx','binance'].includes(row.venue)&&typeof row.id==='string'&&row.id.startsWith(row.venue+':')&&row.id.length<=160&&
    integer(row.started_ms)&&row.started_ms<=at+GRACE&&(row.settled_ms===null||integer(row.settled_ms)&&row.settled_ms<=at+GRACE)&&
    sats(row.amount_btc,true)!==null&&sats(row.fee_btc)!==null&&TXID.test(row.txid)&&row.verified===true&&
    typeof row.proof?.confirmed==='boolean'&&row.proof?.amount_sats===sats(row.amount_btc,true).toString()&&
    integer(row.proof.verified_ms)&&Array.isArray(row.proof.output_indices)&&row.proof.output_indices.length>0&&
    row.proof.output_indices.every(integer)&&new Set(row.proof.output_indices).size===row.proof.output_indices.length&&retained(row,at);
}
async function timed(call){let timer;try{return await Promise.race([call(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),12000);})]);}finally{clearTimeout(timer);}}
async function publicTx(txid,fetcher){
  const response=await fetcher('https://blockstream.info/api/tx/'+txid,{method:'GET',headers:{Accept:'application/json','User-Agent':'XHY-Terminal/1.0'},redirect:'manual',signal:AbortSignal.timeout(10000)});
  if(!response?.ok||response.status>=300)fail('proof_unavailable');
  const declared=response.headers?.get?.('content-length');if(declared&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BYTES))fail('proof_too_large');
  let raw;
  if(response.body?.getReader){
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES)fail('proof_too_large');chunks.push(value);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }else{raw=await response.text();if(new TextEncoder().encode(raw).byteLength>MAX_BYTES)fail('proof_too_large');}
  const tx=JSON.parse(raw);if(tx?.txid?.toLowerCase()!==txid||typeof tx.status?.confirmed!=='boolean'||!Array.isArray(tx.vout)||!Array.isArray(tx.vin)||tx.vout.length>5000||tx.vin.length>5000)fail('proof_invalid');
  if(tx.status.confirmed&&(!integer(tx.status.block_time)||tx.status.block_time<=0))fail('proof_invalid');
  return tx;
}
function normalize(row,venue,address,at){
  if(!row||typeof row!=='object'||Array.isArray(row))fail('records_invalid');
  if((venue==='okx'?row.ccy:row.coin)!=='BTC')return null;
  const destination=venue==='okx'?row.to:row.address;if(typeof destination!=='string')fail('records_invalid');if(destination!==address)return null;
  if((venue==='okx'?row.chain:row.network)!==(venue==='okx'?'BTC-Bitcoin':'BTC'))fail('network_unverified');
  if(venue==='binance'&&row.transferType!==0&&row.transferType!=='0')fail('network_unverified');
  const rawID=venue==='okx'?row.wdId:row.id;if(typeof rawID!=='string'||! /^[A-Za-z0-9_-]{1,120}$/.test(rawID))fail('records_invalid');
  const started=venue==='okx'?(/^\d{10,16}$/.test(String(row.ts))?Number(row.ts):null):utc(row.applyTime);
  if(!integer(started)||started<=0||started>at+GRACE)fail('records_invalid');if(started<at-WINDOW)return null;
  const state=venue==='okx'?String(row.state):String(row.status),cancelled=venue==='okx'?['-4','-3','-2','-1'].includes(state):['1','3','5'].includes(state);
  const id=venue+':'+rawID;if(cancelled)return {id,venue,cancelled:true};
  const amount=sats(venue==='okx'?row.amt:row.amount,true),fee=sats(venue==='okx'?row.fee:row.transactionFee);
  if(amount===null||fee===null||amount+fee>MAX_MONEY||venue==='okx'&&row.feeCcy!=='BTC')fail('amount_unverified');
  const complete=venue==='okx'?state==='2':state==='6';
  const known=venue==='okx'?['0','1','2','4','5','6','7','8','9','10','12','15','16','17','19'].includes(state):['0','2','4','6'].includes(state);
  if(!known)fail('state_unverified');
  let settled=venue==='binance'&&row.completeTime?utc(row.completeTime):null;
  if(settled!==null&&(settled<started||settled>at+GRACE)||venue==='binance'&&row.completeTime&&settled===null)fail('records_invalid');
  const hash=typeof row.txId==='string'?row.txId.trim():'';
  return {id,venue,started_ms:started,settled_ms:complete?settled:null,amount_btc:btc(amount),fee_btc:btc(fee),txid:TXID.test(hash)?hash.toLowerCase():null,complete,unbroadcast:!hash,invalid_txid:!!hash&&!TXID.test(hash)};
}
function waiting(row,at,reason,status='unknown'){return {id:row.id,venue:row.venue,started_ms:row.started_ms,ended_ms:at+GRACE,amount_btc:row.amount_btc,fee_btc:row.fee_btc,status,reason,verified:false};}

export async function readInternalTransfers({okxClient=null,binanceClient=null,binanceExpected=false,address,fetch:fetcher=globalThis.fetch,now=Date.now,cached=null,connection,force=false}={}){
  const at=typeof now==='function'?now():now;
  if(!integer(at)||typeof connection!=='string'||!connection||connection.length>256||!ADDRESS.test(address||''))fail('configuration_invalid');
  const prior=cached?.version===1&&cached.connection===connection?cached:null;
  const previous=(Array.isArray(prior?.transfers)?prior.transfers:[]).filter(row=>validCached(row,at));
  const previousAwaiting=Array.isArray(prior?.awaiting)?prior.awaiting.filter(row=>row&&['okx','binance'].includes(row.venue)&&integer(row.started_ms)&&sats(row.amount_btc,true)!==null&&sats(row.fee_btc)!==null):[];
  const hasPending=previous.some(row=>!row.proof.confirmed||row.settled_ms===null)||previousAwaiting.length>0||prior?.status==='stale';
  if(!force&&integer(prior?.checked_ms)&&at>=prior.checked_ms&&at-prior.checked_ms<(hasPending?60000:300000)){
    return {...structuredClone(prior),transfers:previous.map(row=>({...row,ended_ms:!row.proof.confirmed||row.settled_ms===null?at+GRACE:row.settled_ms+GRACE})),awaiting:previousAwaiting.map(row=>({...row,ended_ms:at+GRACE}))};
  }
  const transfers=new Map(previous.map(row=>[row.id,structuredClone(row)])),awaiting=new Map(previousAwaiting.map(row=>[row.id,{...row,ended_ms:at+GRACE}])),venues={},candidates=[],clients={okx:okxClient,binance:binanceClient};
  let stale=false;
  const issue=(venue,reason)=>{stale=true;venues[venue]={status:'stale',reason};};
  await Promise.all(['okx','binance'].map(async venue=>{
    const client=clients[venue];if(!client){
      if(venue==='binance'&&binanceExpected||previous.some(row=>row.venue===venue)||previousAwaiting.some(row=>row.venue===venue))issue(venue,'client_unavailable');else venues[venue]={status:'not_connected'};return;
    }
    try{
      const rows=await timed(()=>client.get(venue==='okx'?'/api/v5/asset/withdrawal-history':'/sapi/v1/capital/withdraw/history',venue==='okx'?{ccy:'BTC',type:4,limit:100}:{coin:'BTC',startTime:at-WINDOW,endTime:at,limit:1000,recvWindow:5000}));
      const limit=venue==='okx'?100:1000;if(!Array.isArray(rows)||rows.length>=limit||new TextEncoder().encode(JSON.stringify(rows)).byteLength>2*MAX_BYTES)fail('records_incomplete');
      const seen=new Set(),parsed=[];
      for(const row of rows){const value=normalize(row,venue,address,at);if(!value)continue;if(seen.has(value.id))fail('duplicate_withdrawal');seen.add(value.id);parsed.push(value);}
      venues[venue]={status:'fresh'};
      for(const row of parsed){
        awaiting.delete(row.id);
        if(row.cancelled){transfers.delete(row.id);continue;}
        const before=transfers.get(row.id);
        if(before&&(before.txid!==row.txid||before.amount_btc!==row.amount_btc||before.fee_btc!==row.fee_btc||before.started_ms!==row.started_ms))transfers.delete(row.id);
        candidates.push(row);
      }
    }catch{issue(venue,'withdrawals_unavailable');}
  }));
  // A previously broadcast pending withdrawal may fall outside the seven-day
  // provider window. Keep following its proof instead of silently expiring it.
  for(const row of previous)if((!row.proof.confirmed||row.settled_ms===null)&&!candidates.some(value=>value.id===row.id)&&transfers.has(row.id)&&venues[row.venue]?.status==='fresh')candidates.push({...row,complete:row.settled_ms!==null});
  const groups=new Map();
  for(const row of candidates){
    if(!row.txid){awaiting.set(row.id,waiting(row,at,row.unbroadcast?'not_broadcast':'txid_invalid',row.unbroadcast?'pending':'unknown'));if(row.invalid_txid)issue(row.venue,'proof_unverified');continue;}
    if(!groups.has(row.txid))groups.set(row.txid,[]);groups.get(row.txid).push(row);
  }
  let budget=MAX_TX_REQUESTS;
  await Promise.all([...groups].map(async([hash,rows])=>{
    try{
      const reuse=rows.every(row=>{const before=transfers.get(row.id);return before?.proof?.confirmed===true&&row.complete&&before.txid===hash&&before.amount_btc===row.amount_btc;});
      if(reuse){
        // A transaction can confirm before the exchange reports completion.
        // Reused chain proof must still advance that later exchange state.
        for(const row of rows){
          const before=transfers.get(row.id),settled=row.settled_ms??before.settled_ms??at;
          transfers.set(row.id,{...before,settled_ms:settled,ended_ms:settled+GRACE});
          awaiting.delete(row.id);
        }
        return;
      }
      if(budget--<=0)fail('proof_budget');
      const tx=await publicTx(hash,fetcher);
      if(tx.vin.some(input=>input?.prevout?.scriptpubkey_address===address))fail('wallet_spending_transaction');
      const outputs=tx.vout.map((output,index)=>({index,address:output?.scriptpubkey_address,value:output?.value})).filter(output=>output.address===address);
      if(outputs.some(output=>!integer(output.value)||BigInt(output.value)>MAX_MONEY))fail('proof_invalid');
      const used=new Set(),allocation=[];
      // One concrete output per actual exchange withdrawal; indices cannot be
      // reused by a second record or by a cached withdrawal in this tx.
      for(const before of transfers.values())if(before.txid===hash&&!rows.some(row=>row.id===before.id))for(const index of before.proof.output_indices)used.add(index);
      for(const row of rows){const output=outputs.find(value=>!used.has(value.index)&&BigInt(value.value)===sats(row.amount_btc,true));if(!output)fail('output_not_matched');used.add(output.index);allocation.push([row,output]);}
      for(const [row,output]of allocation){
        const before=transfers.get(row.id),settled=row.complete?(row.settled_ms??before?.settled_ms??at):null;
        transfers.set(row.id,{id:row.id,venue:row.venue,started_ms:row.started_ms,settled_ms:settled,ended_ms:!tx.status.confirmed||settled===null?at+GRACE:settled+GRACE,amount_btc:row.amount_btc,fee_btc:row.fee_btc,txid:hash,verified:true,proof:{confirmed:tx.status.confirmed,verified_ms:at,amount_sats:String(output.value),output_indices:[output.index],block_time_ms:tx.status.confirmed?tx.status.block_time*1000:null}});
        awaiting.delete(row.id);
      }
    }catch{for(const row of rows){issue(row.venue,'proof_unverified');awaiting.set(row.id,waiting(row,at,'proof_unverified'));}}
  }));
  const verified=[...transfers.values()].filter(row=>retained(row,at)).map(row=>({...row,ended_ms:!row.proof.confirmed||row.settled_ms===null?at+GRACE:row.settled_ms+GRACE})).sort((a,b)=>a.started_ms-b.started_ms||a.id.localeCompare(b.id));
  const uncertain=[...awaiting.values()].sort((a,b)=>a.started_ms-b.started_ms||a.id.localeCompare(b.id));
  return {version:1,connection,checked_ms:at,status:stale?'stale':uncertain.length||verified.some(row=>row.settled_ms===null||!row.proof.confirmed)?'pending':'fresh',transfers:verified,awaiting:uncertain,venues};
}
