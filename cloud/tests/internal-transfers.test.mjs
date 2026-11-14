import test from 'node:test';
import assert from 'node:assert/strict';
import {D,txt} from '../cost-book.mjs';
import {indexPriceChange} from '../finance-price-periods.mjs';
import {reconcileInternalTransfers as reconcile} from '../internal-transfers.mjs';

const START=Date.parse('2026-11-14T21:09:50Z'),MIN=60000;
const txid=n=>n.toString(16).padStart(64,'0');
const transfer=(overrides={})=>({verified:true,id:'withdrawal-1',venue:'binance',txid:txid(1),started_ms:START,ended_ms:START+30*MIN,amount_btc:'0.1',fee_btc:'0.0001',...overrides});
const snap=(at,btc,price='100',fx='7')=>({timestamp:new Date(at).toISOString(),btc,usd:txt(new D(btc).mul(price)),cny:fx==null?null:txt(new D(btc).mul(price).mul(fx)),price_usd:price,fx});
const run=(history,rows=[transfer()],trades=[])=>reconcile(history,rows,trades);

test('the verified live withdrawal repairs only debit-without-receipt snapshots, including receipt before completion time',()=>{
  const t=transfer({amount_btc:'0.01058938',fee_btc:'0.00002',ended_ms:Date.parse('2026-11-14T21:32:33Z')});
  const history=[snap(Date.parse('2026-11-14T21:09:21Z'),'0.0919965742056301'),
    snap(Date.parse('2026-11-14T21:12:00Z'),'0.0813871942056301'),
    snap(Date.parse('2026-11-14T21:14:00Z'),'0.0813871942056301'),
    snap(Date.parse('2026-11-14T21:17:00Z'),'0.0813871942056301'),
    snap(Date.parse('2026-11-14T21:21:00Z'),'0.0919765742056301')];
  const original=structuredClone(history),out=run(history,[t]);
  assert.deepEqual(out.history.map(point=>point.btc),['0.0919965742056301',...Array(4).fill('0.0919765742056301')]);
  assert.equal(out.corrections.length,3);assert.equal(out.corrections[0].by_venue.binance,'0.01058938');assert.equal(out.corrections[0].by_venue.okx,'0');
  assert.equal(out.history.at(-1).internal_transfer_adjustment,undefined,'already reflected receipt is not counted twice, even before complete/block time');
  assert.deepEqual(history,original,'never mutate stored input');assert.deepEqual(out.unresolved_points,[]);
});

test('untouched, debited, credited and settled states preserve fees and distinguish both read orderings',()=>{
  const history=[snap(START-MIN,'1'),snap(START,'1'),snap(START+MIN,'0.8999'),snap(START+3*MIN,'0.9999')];
  const out=run(history);assert.deepEqual(out.history.map(p=>p.btc),['1','1','0.9999','0.9999']);
  assert.deepEqual(out.corrections.map(c=>c.adjustment_btc),['0.1']);
  const receiptFirst=run([snap(START-MIN,'1'),snap(START+MIN,'1.1'),snap(START+2*MIN,'0.9999')]);
  assert.deepEqual(receiptFirst.history.map(p=>p.btc),['1','1','0.9999']);assert.equal(receiptFirst.corrections[0].adjustment_btc,'-0.1');
});

test('signed BTC buys and sales are incorporated exactly once between the actual anchor and each point',()=>{
  const trades=[{id:'buy',side:'buy',at_ms:START+MIN,btc_net:'0.01'},{id:'sell',side:'sell',at_ms:START+2*MIN,btc_net:'-0.02'}];
  const history=[snap(START-MIN,'1'),snap(START+MIN,'0.9099'),snap(START+2*MIN,'0.8899'),snap(START+3*MIN,'0.9899')];
  const out=run(history,[transfer()],trades);assert.deepEqual(out.history.map(p=>p.btc),['1','1.0099','0.9899','0.9899']);
  assert.equal(run(history).corrections.length,0,'missing known buy/sell evidence cannot be guessed');
  assert.deepEqual(run(history,[transfer()],[...trades,trades[0]]).history,out.history,'duplicate identical trade ID is not counted twice');
  const conflict=run(history,[transfer()],[...trades,{...trades[0],btc_net:'0.02'}]);assert.equal(conflict.corrections.length,0);assert.equal(conflict.unresolved_points[0].reason,'trade_history_invalid');
});

test('external withdrawals and unrecognized balance changes remain visible; actual price crashes are never smoothed',()=>{
  const external=run([snap(START-MIN,'1'),snap(START+MIN,'0.7')]);assert.equal(external.history[1].btc,'0.7');assert.equal(external.unresolved_points[0].reason,'unmatched_balance');
  const crash=run([snap(START-MIN,'1','100'),snap(START+MIN,'0.8999','25','8')]);
  assert.equal(crash.history[1].btc,'0.9999');assert.equal(crash.history[1].price_usd,'25');assert.equal(crash.history[1].fx,'8');assert.equal(crash.history[1].usd,'24.9975');assert.equal(crash.history[1].cny,'199.98');
  assert.ok(new D(crash.history[1].usd).lt(30),'the real 75% market drop remains');
  const priceOnly=run([snap(START-MIN,'1','100'),snap(START+MIN,'1','25')]);assert.equal(priceOnly.corrections.length,0);assert.equal(priceOnly.history[1].usd,'25');
});

test('missing anchors, invalid or unverified evidence and reused batch outputs never invent holdings',()=>{
  const original=[snap(START+MIN,'0.8999')];assert.equal(run(original).corrections.length,0);assert.equal(run(original).unresolved_points[0].reason,'anchor_unavailable');
  const rows=[snap(START-MIN,'1'),snap(START+MIN,'0.8999')];
  for(const t of [transfer({verified:false}),transfer({amount_btc:'NaN'}),transfer({txid:'not-a-transaction'}),transfer({ended_ms:START-1})])assert.deepEqual(run(rows,[t]).history,rows);
  assert.equal(run([snap(START-16*MIN,'1'),rows[1]]).corrections.length,0,'a distant stale anchor is not evidence');
  const duplicate=transfer({id:'other',txid:txid(1)});assert.equal(run(rows,[transfer(),duplicate]).corrections.length,0,'same tx output cannot be assigned to two withdrawals');
  const overlap=[transfer({output_indices:[0,1]}),transfer({id:'other',output_indices:[1,2]})];assert.equal(run(rows,overlap).corrections.length,0);
});

test('verified batch outputs with distinct allocations and concurrent different venues preserve exact totals',()=>{
  const a=transfer({output_index:0}),b=transfer({id:'other',venue:'okx',output_index:1,amount_btc:'0.03',fee_btc:'0.00002'});
  const out=run([snap(START-MIN,'1'),snap(START+MIN,'0.86988')],[a,b]);
  assert.equal(out.history[1].btc,'0.99988');assert.deepEqual(out.corrections[0].by_venue,{okx:'0.03',binance:'0.1'});assert.equal(out.corrections[0].transfer_ids.length,2);
  const later={...b,txid:txid(2),started_ms:START+2*MIN};
  const staged=run([snap(START-MIN,'1'),snap(START+MIN,'0.8999'),snap(START+3*MIN,'0.86988')],[transfer(),later]);
  assert.deepEqual(staged.history.map(p=>p.btc),['1','0.9999','0.99988']);
});

test('same aggregate change with different venue corrections is ambiguous and remains unmodified',()=>{
  const a=transfer({fee_btc:'0'}),b=transfer({id:'other',venue:'okx',txid:txid(2),fee_btc:'0'});
  const history=[snap(START-MIN,'1'),snap(START+MIN,'0.9')],out=run(history,[a,b]);
  assert.deepEqual(out.history,history);assert.equal(out.corrections.length,0);assert.deepEqual(out.ambiguous_points,[{timestamp:history[1].timestamp,reason:'ambiguous_states'}]);
});

test('an observed completion closes the transfer before provider completeTime and cannot hide a later equal external withdrawal',()=>{
  const history=[snap(START-MIN,'1'),snap(START+MIN,'0.8999'),snap(START+2*MIN,'0.9999'),snap(START+3*MIN,'0.8999')];
  const out=run(history);assert.deepEqual(out.history.map(p=>p.btc),['1','0.9999','0.9999','0.8999']);
  assert.equal(out.corrections.length,1);assert.deepEqual(out.unresolved_points,[{timestamp:history[3].timestamp,reason:'unmatched_balance'}]);
});

test('correction candidates stop at the supplied window and do not force settlement at ended_ms',()=>{
  const t=transfer({ended_ms:START+2*MIN});
  const out=run([snap(START-MIN,'1'),snap(START+MIN,'1'),snap(START+2*MIN,'0.8999'),snap(START+3*MIN,'0.8999')],[t]);
  assert.deepEqual(out.history.map(p=>p.btc),['1','1','0.9999','0.8999']);assert.equal(out.corrections.length,1);
});

test('the first existing cumulative P&L anchor survives while every affected later total is rebuilt',()=>{
  const history=indexPriceChange([snap(START-2*MIN,'1','90'),snap(START-MIN,'1','100'),snap(START+MIN,'0.8999','110'),snap(START+2*MIN,'0.9999','120')]);
  history[0].pnl_usd='123.45';history[0].pnl_cny='864.15';history[1].pnl_usd='133.45';history[1].pnl_cny='934.15';
  const out=run(history);assert.deepEqual(out.history.slice(0,2),history.slice(0,2));
  assert.equal(out.history[2].pnl_usd,'143.45');assert.equal(out.history[3].pnl_usd,'153.449');
  assert.equal(out.history[3].pnl_cny,'1074.143');
});

test('repeated reconciliation is byte-for-byte idempotent and expired manifests retain audited history',()=>{
  const first=run(indexPriceChange([snap(START-MIN,'1','100'),snap(START+MIN,'0.8999','110'),snap(START+2*MIN,'0.9999','120')]));
  const second=run(first.history);assert.deepEqual(second.history,first.history);assert.deepEqual(second.corrections,first.corrections);
  assert.equal(second.history[1].internal_transfer_adjustment.raw_btc,'0.8999');
  assert.deepEqual(run(second.history,[]).history,first.history,'do not resurrect an old V after its provider history window expires');
  const nextStart=START+40*MIN,next=transfer({id:'next',txid:txid(3),started_ms:nextStart,ended_ms:nextStart+MIN});
  const extended=[...first.history,snap(nextStart-MIN,'0.9999'),snap(nextStart,'0.8998')];
  assert.equal(run(extended,[next]).history.at(-1).btc,'0.9998','a later transfer anchors on actual corrected economics');
});

test('legacy valuation fields keep their original observed unit price, and absent FX stays unknown',()=>{
  const rows=[snap(START-MIN,'1'),snap(START+MIN,'0.8999','110',null)];delete rows[1].price_usd;
  const out=run(rows);assert.equal(out.history[1].usd,'109.989');assert.equal(out.history[1].cny,null);assert.equal(out.history[1].price_usd,undefined);
});

test('one-satoshi tolerance remains bounded and greater unknown changes cannot be filled',()=>{
  const close=run([snap(START-MIN,'1'),snap(START+MIN,'0.89990001')]);assert.equal(close.history[1].btc,'0.99990001');
  const far=run([snap(START-MIN,'1'),snap(START+MIN,'0.89990002')]);assert.equal(far.corrections.length,0);assert.equal(far.unresolved_points.length,1);
});
