import test from 'node:test';
import assert from 'node:assert/strict';
import {preserveHistoricalPricePeriods} from '../finance-price-periods.mjs';

const NOW=Date.parse('2026-10-28T03:00:00Z');
const cached={btc:null,usd:'123.456789012345678901',cny:'864.197523086419752307',start_at:'2026-10-20T03:00:00Z',end_at:'2026-10-27T03:00:00Z',reason:''};

test('verified historical amounts keep their exact values and calculation dates rather than advancing with the live balance',()=>{
  const input={week:structuredClone(cached)},before=structuredClone(input);
  const periods=preserveHistoricalPricePeriods(input,NOW),row=periods.week;
  assert.equal(row.usd,cached.usd);assert.equal(row.cny,cached.cny);
  assert.equal(row.start_at,cached.start_at);assert.equal(row.end_at,cached.end_at);
  assert.equal(row.as_of,cached.end_at);assert.equal(row.status,'stale');assert.equal(row.historical,true);assert.equal(row.stale,true);
  assert.match(row.reason,/2026-10-27 11:00:00.*北京时间.*后续流水待核对/);
  assert.deepEqual(input,before);assert.equal(row.btc,null);
});

test('Beijing midnight invalidates yesterday today result even when the UTC date has not changed',()=>{
  const yesterday={...cached,start_at:'2026-10-26T16:00:00Z',end_at:'2026-10-27T15:59:59Z'};
  const p=preserveHistoricalPricePeriods({today:yesterday,week:cached},Date.parse('2026-10-27T16:00:00Z'));
  assert.equal(p.today.usd,null);assert.equal(p.today.cny,null);assert.equal(p.today.status,'unavailable');
  assert.equal(p.today.end_at,null);assert.equal(p.today.as_of,null);assert.equal(p.today.start_at,'2026-10-27T16:00:00.000Z');
  assert.match(p.today.reason,/不属于今天/);assert.equal(p.week.usd,cached.usd);
});

test('same Beijing day keeps a genuine zero and one-currency calculation without filling unavailable currency',()=>{
  const row={usd:'0',cny:null,start_at:'2026-10-27T16:00:00Z',end_at:'2026-10-28T02:30:00Z',reason:'缺少人民币汇率。'};
  const p=preserveHistoricalPricePeriods({today:row},NOW).today;
  assert.equal(p.usd,'0');assert.equal(p.cny,null);assert.equal(p.status,'stale');
  assert.match(p.reason,/缺少人民币汇率/);
});

test('missing and uncalculated periods retain honest reasons and do not invent a current end time or zero',()=>{
  const p=preserveHistoricalPricePeriods({week:{...cached,usd:null,cny:null,reason:'周期边界存在未结清内部划转。'}},NOW);
  assert.equal(p.week.reason,'周期边界存在未结清内部划转。');assert.equal(p.week.usd,null);
  assert.equal(p.month.usd,null);assert.equal(p.month.end_at,null);assert.equal(p.month.status,'unavailable');
  assert.match(p.month.reason,/尚未完成核算/);
});

test('future, reversed, invalid or timezone-less intervals never promote cached money to a verified result',()=>{
  for(const row of [{...cached,end_at:'2027-01-01T00:00:00Z'}, {...cached,start_at:cached.end_at,end_at:cached.start_at}, {...cached,end_at:'invalid'}, {...cached,end_at:'2026-10-27T03:00:00'}]){
    const p=preserveHistoricalPricePeriods({week:row},NOW).week;
    assert.equal(p.usd,null);assert.equal(p.cny,null);assert.equal(p.end_at,null);assert.equal(p.status,'unavailable');
  }
});

test('malformed financial values remain unavailable and repeated live syncs do not duplicate the historical notice',()=>{
  const invalid=preserveHistoricalPricePeriods({week:{...cached,usd:'NaN',cny:'Infinity'}},NOW).week;
  assert.equal(invalid.usd,null);assert.equal(invalid.cny,null);
  const first=preserveHistoricalPricePeriods({week:cached},NOW);
  const second=preserveHistoricalPricePeriods(first,NOW+60000);
  assert.deepEqual(second.week,first.week);
});
