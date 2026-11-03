import test from 'node:test';
import assert from 'node:assert/strict';
import {indexPriceChange,pricePeriods} from '../finance-price-periods.mjs';

// 2026-10-28 11:00 Beijing; that Beijing day began at 2026-10-27T16:00:00Z.
const NOW=Date.parse('2026-10-28T03:00:00Z'),START=Date.parse('2026-10-27T16:00:00Z'),MIN=60000,DAY=86400000;
const snap=(at,btc,price,fx='7')=>({timestamp:new Date(at).toISOString(),btc:String(btc),usd:String(btc*price),cny:fx==null?null:String(btc*price*Number(fx)),price_usd:String(price),fx});
const periods=history=>pricePeriods(indexPriceChange(history),NOW);

test('today counts the price move on the BTC held since Beijing 00:00, in USD and in CNY with the exchange-rate move',()=>{
  const p=periods([snap(START-MIN,1,100),snap(START+6*3600000,1,104),snap(NOW,1,110,'7.1')]).today;
  assert.equal(p.status,'estimated');assert.equal(p.usd,'10');
  // CNY: 110 × 7.1 − 100 × 7 = 81, so the rate move counts too.
  assert.equal(p.cny,'81');assert.equal(p.start_at,new Date(START-MIN).toISOString());assert.equal(p.end_at,new Date(NOW).toISOString());assert.equal(p.reason,'');
});

test('buys, transfers and a newly counted source change the balance but are never profit',()=>{
  const history=[snap(START-MIN,1,100),
    snap(START+3600000,1.5,100),   // bought 0.5 BTC at 100
    snap(START+2*3600000,1.5,108), // price +8 on 1.5 BTC = +12
    snap(START+3*3600000,1.2,108), // sent 0.3 BTC away
    snap(START+4*3600000,1.45,108),// a new source with 0.25 BTC is counted
    snap(NOW,1.45,110)];           // price +2 on 1.45 BTC = +2.9
  const p=periods(history).today;assert.equal(p.usd,'14.9');assert.equal(p.cny,'104.3');
  // Without the price moves there is no profit at all, however the balance changes.
  const flat=periods([snap(START-MIN,1,100),snap(START+MIN,3,100),snap(NOW,0.5,100)]).today;assert.equal(flat.usd,'0');
});

test('periods use the snapshot at or just after their start and say why when history does not reach it',()=>{
  const history=[snap(NOW-8*DAY,2,90),snap(NOW-7*DAY+5*MIN,2,95),snap(START-MIN,2,100),snap(NOW,2,110)];
  const p=periods(history);
  // The week opens at the snapshot 5 minutes after its start (closer than the one a day before).
  assert.equal(p.week.usd,'30');assert.equal(p.week.start_at,new Date(NOW-7*DAY+5*MIN).toISOString());
  assert.equal(p.today.usd,'20');
  assert.equal(p.month.status,'unavailable');assert.equal(p.month.usd,null);assert.match(p.month.reason,/尚未覆盖完整周期/);
  // A first snapshot within 15 minutes after the start still opens the period.
  assert.equal(periods([snap(START+10*MIN,1,100),snap(NOW,1,101)]).today.usd,'1');
  assert.equal(periods([snap(START+20*MIN,1,100),snap(NOW,1,101)]).today.status,'unavailable');
  const none=pricePeriods(indexPriceChange([snap(START-2*DAY,1,100),snap(START-DAY,1,101)]),NOW).today;
  assert.equal(none.status,'unavailable');assert.match(none.reason,/今天还没有余额快照/);
});

test('thinning old snapshots never changes a result because each one keeps its running total',()=>{
  const dense=[];for(let at=NOW-10*DAY,i=0;at<=NOW;at+=10*MIN,i++)dense.push(snap(at,1+(i%7)*0.1,100+10*Math.sin(i/9)));
  const indexed=indexPriceChange(dense),full=pricePeriods(indexed,NOW);
  // Drop four in five snapshots but keep the ones each period opens on: results are identical,
  // although the dropped snapshots carried every balance change and price step in between.
  const kept=new Set(Object.values(full).map(row=>row.start_at));
  const thinned=indexed.filter((row,i)=>i===indexed.length-1||i%5===0||kept.has(row.timestamp)),thin=pricePeriods(thinned,NOW);
  assert.ok(thinned.length<indexed.length/4);
  for(const key of ['today','week'])assert.deepEqual([thin[key].usd,thin[key].cny],[full[key].usd,full[key].cny]);
  // Indexing again keeps stored totals instead of recomputing them.
  assert.deepEqual(indexPriceChange(thinned),thinned);
});

test('a missing exchange rate leaves CNY unavailable without inventing zero; a missing price carries the last one',()=>{
  const p=periods([snap(START-MIN,1,100,null),snap(NOW,1,110,null)]).today;
  assert.equal(p.usd,'10');assert.equal(p.cny,null);assert.match(p.reason,/人民币汇率/);
  const gap=periods([snap(START-MIN,1,100),{timestamp:new Date(START+MIN).toISOString(),btc:'1',usd:null,cny:null},snap(NOW,1,105)]).today;
  assert.equal(gap.usd,'5');
  // Snapshots written before price_usd existed derive the price from value / BTC.
  const legacy=periods([{timestamp:new Date(START-MIN).toISOString(),btc:'2',usd:'200',cny:'1400'},{timestamp:new Date(NOW).toISOString(),btc:'2',usd:'220',cny:'1540'}]).today;
  assert.equal(legacy.usd,'20');assert.equal(legacy.cny,'140');
});
