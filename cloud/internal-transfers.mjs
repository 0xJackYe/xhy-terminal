import {D,dec,txt} from './cost-book.mjs';
import {indexPriceChange} from './finance-price-periods.mjs';

// This module accepts already verified exchange/address/transaction matches.
// It never infers ownership from a V-shaped price chart or matching amounts.
const VENUES=['okx','binance'],SAT=new D('0.00000001'),MAX_STATES=4096;
const stamp=point=>typeof point?.timestamp==='string'?Date.parse(point.timestamp):NaN;
const millis=value=>Number.isSafeInteger(value)&&value>0;
const amount=value=>{try{return typeof value==='string'&&value.length<=160?dec(value):null;}catch{return null;}};
const zeroVenue=()=>({okx:new D(0),binance:new D(0)});
const venueText=values=>Object.fromEntries(VENUES.map(venue=>[venue,txt(values[venue])]));

function verifiedTransfers(input){
  const ids=new Map(),conflicts=new Set();
  for(const row of Array.isArray(input)?input:[]){
    if(row?.verified!==true||typeof row.id!=='string'||!row.id||row.id.length>200||!VENUES.includes(row.venue)||!/^\w{64}$/.test(row.txid||'')||!/^[a-fA-F0-9]{64}$/.test(row.txid))continue;
    const net=amount(row.amount_btc),fee=amount(row.fee_btc),end=row.ended_ms??row.settled_ms??row.started_ms+86400000;
    if(!net?.gt(0)||net.gt(21000000)||!fee?.gte(0)||fee.gt(21000000)||!millis(row.started_ms)||!millis(end)||end<row.started_ms)continue;
    const indices=Array.isArray(row.output_indices)?row.output_indices:Array.isArray(row.proof?.output_indices)?row.proof.output_indices:row.output_index==null?[]:[row.output_index];
    if(indices.some(value=>!Number.isSafeInteger(value)||value<0)||new Set(indices).size!==indices.length)continue;
    const transfer={id:row.id.startsWith(row.venue+':')?row.id:row.venue+':'+row.id,venue:row.venue,txid:row.txid.toLowerCase(),start:row.started_ms,end,net,fee,indices:[...indices].sort((a,b)=>a-b)};
    const previous=ids.get(transfer.id);
    if(previous&&JSON.stringify(previous)!==JSON.stringify(transfer))conflicts.add(transfer.id);
    else ids.set(transfer.id,transfer);
  }
  const rows=[...ids.values()].filter(row=>!conflicts.has(row.id)),transactions=new Map();
  for(const row of rows){if(!transactions.has(row.txid))transactions.set(row.txid,[]);transactions.get(row.txid).push(row);}
  const reused=new Set();
  for(const group of transactions.values())if(group.length>1){
    const seen=new Set();let valid=true;
    for(const row of group){if(!row.indices.length)valid=false;for(const index of row.indices){if(seen.has(index))valid=false;seen.add(index);}}
    if(!valid)for(const row of group)reused.add(row.id);
  }
  return rows.filter(row=>!reused.has(row.id)).sort((a,b)=>a.start-b.start||a.id.localeCompare(b.id));
}

function tradeIndex(input){
  if(!Array.isArray(input))return null;
  const rows=[],ids=new Map();
  for(const row of input){
    const value=amount(row?.btc_net);
    if(!millis(row?.at_ms)||value===null||row.side==='buy'&&!value.gt(0)||row.side==='sell'&&!value.lt(0))return null;
    if(typeof row.id==='string'){
      const prior=ids.get(row.id),key=row.at_ms+'|'+txt(value);
      if(prior){if(prior!==key)return null;continue;}ids.set(row.id,key);
    }
    rows.push({at:row.at_ms,value});
  }
  rows.sort((a,b)=>a.at-b.at);const totals=[new D(0)];
  for(const row of rows)totals.push(totals.at(-1).add(row.value));
  const through=at=>{let lo=0,hi=rows.length;while(lo<hi){const mid=(lo+hi)>>>1;if(rows[mid].at<=at)lo=mid+1;else hi=mid;}return totals[lo];};
  return (from,to)=>through(to).sub(through(from));
}

function groups(rows){
  const result=[];
  for(const row of rows){const last=result.at(-1);if(last&&row.start<=last.end){last.rows.push(row);last.end=Math.max(last.end,row.end);}else result.push({start:row.start,end:row.end,rows:[row]});}
  return result;
}

function stateTable(rows,at,paths){
  // An observed completion is absorbing: a later external withdrawal of the
  // same size cannot be mistaken for this already settled own-wallet transfer.
  const onward=[[0,1,2,3],[1,3],[2,3],[3]],states=new Map();let exceeded=false,visits=0;
  for(const path of paths){
    const visit=(index,pattern,delta,by,ids)=>{
      if(exceeded)return;
      if(++visits>MAX_STATES*4){exceeded=true;return;}
      if(index===rows.length){states.set(pattern,{pattern,delta,by,ids});if(states.size>MAX_STATES)exceeded=true;return;}
      const row=rows[index],previous=Number(path[index]);
      // End times only restrict eligibility; they do not assert actual arrival.
      const choices=onward[previous].filter(state=>at<row.start?state===0:at>row.end?state===0||state===3:true);
      for(const state of choices){
        const change=state===1?row.net.add(row.fee).neg():state===2?row.net:state===3?row.fee.neg():new D(0);
        const adjustment=state===1?row.net:state===2?row.net.neg():new D(0),identifiers=new Set(ids);
        if(!adjustment.isZero())identifiers.add(row.id);
        visit(index+1,pattern+state,delta.add(change),{...by,[row.venue]:by[row.venue].add(adjustment)},identifiers);
      }
    };
    visit(0,'',new D(0),zeroVenue(),new Set());if(exceeded)return null;
  }
  return [...states.values()].sort((a,b)=>a.delta.cmp(b.delta)||a.pattern.localeCompare(b.pattern));
}

function matchingStates(table,residual,tolerance){
  const lower=residual.sub(tolerance),upper=residual.add(tolerance);let lo=0,hi=table.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(table[mid].delta.lt(lower))lo=mid+1;else hi=mid;}
  const matches=[];for(let index=lo;index<table.length&&table[index].delta.lte(upper);index++)matches.push(table[index]);
  const exact=matches.filter(state=>state.delta.eq(residual));return exact.length?exact:matches;
}

function original(point){
  const meta=point?.internal_transfer_adjustment,raw=amount(meta?.raw_btc),adjustment=amount(meta?.adjustment_btc),btc=amount(point?.btc);
  const valid=meta?.version===1&&raw?.gte(0)&&adjustment!==null&&btc!==null&&raw.add(adjustment).eq(btc)&&Array.isArray(meta.transfer_ids);
  return {btc:valid?raw:btc,usd:valid?meta.raw_usd:point?.usd,cny:valid?meta.raw_cny:point?.cny};
}

function valued(point,raw,btc){
  let price=amount(point.price_usd),fx=amount(point.fx);const usd=amount(raw.usd),cny=amount(raw.cny);
  if(!price?.gt(0))price=raw.btc?.gt(0)&&usd?.gte(0)?usd.div(raw.btc):null;
  if(!fx?.gt(0))fx=usd?.gt(0)&&cny?.gte(0)?cny.div(usd):null;
  return {usd:price===null?null:txt(btc.mul(price)),cny:price===null||fx===null?null:txt(btc.mul(price).mul(fx))};
}

/**
 * Reconcile verified own-wallet transfers against actual BTC observations.
 * tradeRows must cover all buys/sells between each pre-transfer anchor and the
 * candidate point. Fees remain a real loss. Unexplained changes remain intact.
 * Existing audited corrections survive an expired/temporarily absent manifest.
 */
export function reconcileInternalTransfers(history,transfers,tradeRows=[],options={}){
  const result={history:Array.isArray(history)?history:[],corrections:[],ambiguous_points:[],unresolved_points:[]};
  if(!Array.isArray(history)||!history.length)return result;
  const candidates=verifiedTransfers(transfers);if(!candidates.length)return result;
  const indexed=history.map((point,index)=>({point,index,at:stamp(point)})).filter(row=>Number.isFinite(row.at)&&amount(row.point?.btc)?.gte(0));
  if(indexed.some((row,index)=>index>0&&row.at<=indexed[index-1].at))return result;
  const netTrades=tradeIndex(tradeRows),maxAge=options.maxAnchorAgeMs??15*60000,tolerance=SAT;
  const output=history.map(point=>point&&typeof point==='object'?{...point}:point);let firstChanged=Infinity;
  for(const group of groups(candidates)){
    const before=indexed.filter(row=>row.at<group.start).at(-1),anchor=before?amount(output[before.index]?.btc):null;
    const points=indexed.filter(row=>row.at>=group.start&&row.at<=group.end);
    if(!before||anchor===null||!Number.isSafeInteger(maxAge)||maxAge<0||group.start-before.at>maxAge||!netTrades){
      for(const row of points)result.unresolved_points.push({timestamp:row.point.timestamp,reason:!netTrades?'trade_history_invalid':'anchor_unavailable'});
      continue;
    }
    const tables=new Map();let paths=['0'.repeat(group.rows.length)];
    for(const row of points){
      const raw=original(row.point);if(raw.btc===null)continue;
      const signature=group.rows.map(t=>row.at<t.start?'0':row.at>t.end?'2':'1').join('')+'|'+paths.join(',');
      if(!tables.has(signature))tables.set(signature,stateTable(group.rows,row.at,paths));const table=tables.get(signature);
      if(table===null){result.ambiguous_points.push({timestamp:row.point.timestamp,reason:'state_limit'});continue;}
      const residual=raw.btc.sub(anchor.add(netTrades(before.at,row.at))),matches=new Map();
      const matched=matchingStates(table,residual,tolerance);
      for(const state of matched){
        const key=VENUES.map(venue=>txt(state.by[venue])).join('|'),prior=matches.get(key);
        if(prior)for(const id of state.ids)prior.ids.add(id);else matches.set(key,{by:state.by,ids:new Set(state.ids)});
      }
      if(!matches.size){result.unresolved_points.push({timestamp:row.point.timestamp,reason:'unmatched_balance'});continue;}
      paths=matched.map(state=>state.pattern).sort();
      if(matches.size>1){result.ambiguous_points.push({timestamp:row.point.timestamp,reason:'ambiguous_states'});continue;}
      const match=matches.values().next().value;if(VENUES.every(venue=>match.by[venue].isZero()))continue;
      const adjustment=match.by.okx.add(match.by.binance),btc=raw.btc.add(adjustment);if(btc.lt(0))continue;
      const values=valued(row.point,raw,btc),metadata={version:1,raw_btc:txt(raw.btc),raw_usd:raw.usd??null,raw_cny:raw.cny??null,adjustment_btc:txt(adjustment),by_venue:venueText(match.by),transfer_ids:[...match.ids].sort()};
      const point={...row.point,btc:txt(btc),...values,internal_transfer_adjustment:metadata};
      if(JSON.stringify(point)!==JSON.stringify(output[row.index]))firstChanged=Math.min(firstChanged,row.index);
      output[row.index]=point;result.corrections.push({timestamp:point.timestamp,raw_btc:metadata.raw_btc,btc:point.btc,adjustment_btc:metadata.adjustment_btc,by_venue:metadata.by_venue,transfer_ids:metadata.transfer_ids});
    }
  }
  if(Number.isFinite(firstChanged)){
    // Keep the last untouched cumulative anchor. indexPriceChange normally
    // resumes at the newest existing total, so invalidate only this suffix.
    for(let index=firstChanged;index<output.length;index++)if(output[index]&&typeof output[index]==='object'){
      delete output[index].pnl_usd;delete output[index].pnl_cny;
    }
    result.history=indexPriceChange(output);
  }else result.history=output;
  return result;
}
