import test from 'node:test';
import assert from 'node:assert/strict';
import {calculatePortfolioAnnualized} from '../portfolio-annualized.mjs';
const DAY=86400000,START=Date.parse('2024-01-01T00:00:00+08:00');
const flow=(id,amount,days)=>({id,amount_usdt:String(amount),at_ms:START+days*DAY});
const run=(flows,value,days=730,extra={})=>calculatePortfolioAnnualized({ledger:{scope:'c2c_known_flows',flows,...extra},marketValueUsdt:String(value),asOfMs:START+days*DAY});
const close=(value,expected,tolerance=1e-7)=>assert.ok(Math.abs(Number(value)-expected)<tolerance,`${value} != ${expected}`);

test('one investment and the terminal value produce the expected compound annual rate',()=>{
 const result=run([flow('a',-100,0)],121);close(result.annualized_return_pct,10);assert.equal(result.status,'estimated');assert.equal(result.net_invested_usdt,'100');assert.equal(result.contributed_usdt,'100');assert.equal(result.withdrawn_usdt,'0');
});

test('dated contributions and a real withdrawal are valued at their own dates',()=>{
 // -100 at t0, +20 and -100 at t1, terminal 209 at t2:
 // 100*1.1^2 + (100-20)*1.1 = 209.
 const result=run([flow('a',-100,0),flow('b',20,365),flow('c',-100,365)],209);
 close(result.annualized_return_pct,10);assert.equal(result.net_invested_usdt,'180');assert.equal(result.withdrawn_usdt,'20');assert.equal(result.cashflow_count,3);assert.equal(result.profit_usdt,'29');
});

test('interspersed positive withdrawals with still-outstanding contributions have a certified unique solution',()=>{
 const result=run([flow('a',-100,0),flow('b',10,180),flow('c',-100,365)],210);
 assert.equal(result.status,'estimated');assert.equal(result.root_count,1);assert.notEqual(result.annualized_return_pct,null);
});

test('the classic two-root stream is reported as ambiguous, never selected using a Newton guess',()=>{
 // The +1 terminal is added to a -133 final-day contribution, yielding
 // the classic -100, +230, -132 polynomial with roots 10% and 20%.
 const result=run([flow('a',-100,0),flow('b',230,365),flow('c',-133,730)],1);
 assert.equal(result.status,'ambiguous');assert.equal(result.annualized_return_pct,null);assert.ok(result.root_count>=2);
});

test('a tangential double root cannot be mislabeled as a unique estimated return',()=>{
 const result=run([flow('a',-100,0),flow('b',220,365),flow('c',-122,730)],1);
 assert.equal(result.annualized_return_pct,null);assert.notEqual(result.status,'estimated');
});

test('known-channel coverage remains an estimate and unknown/incomplete ledger coverage stays unavailable',()=>{
 const known=run([flow('a',-100,0)],121,730,{complete:false});assert.equal(known.status,'estimated');assert.match(known.method_note,/C2C/);
 const missing=run([flow('a',-100,0)],121,730,{scope:'unknown',complete:false});assert.equal(missing.status,'needs_cashflows');assert.equal(missing.annualized_return_pct,null);
});

test('net investment preserves full decimal precision and does not round money before solving',()=>{
 const result=run([flow('a','-8017.87',0),flow('b','474.72',300),flow('c','-208.9519991088767',365)],8000);
 assert.equal(result.net_invested_usdt,'7752.1019991088767');assert.equal(result.contributed_usdt,'8226.8219991088767');assert.equal(result.withdrawn_usdt,'474.72');
});

test('same-day netting is idempotent by date while duplicate source identifiers are rejected',()=>{
 const one=run([flow('a',-100,0)],121),split=run([flow('a',-40,0),flow('b',-60,0)],121);close(split.annualized_return_pct,Number(one.annualized_return_pct));
 assert.throws(()=>run([flow('a',-100,0),flow('a',-100,1)],200),/invalid_cashflows/);
});

test('same-day-only activity, no contributed capital and unsolvable total loss do not invent returns',()=>{
 assert.equal(run([flow('a',-100,0)],110,0).annualized_return_pct,null);
 assert.equal(run([flow('a',100,0)],110).annualized_return_pct,null);
 assert.equal(run([flow('a',-100,0)],0).annualized_return_pct,null);
 close(run([flow('a',-100,0)],1,365).annualized_return_pct,-99);
});

test('yearly total-portfolio returns remain unavailable without actual historical whole-portfolio valuations',()=>{
 const result=run([flow('a',-100,0)],121);assert.deepEqual(result.years.map(x=>x.year),[2024,2025]);assert.ok(result.years.every(x=>x.status==='needs_valuations'&&x.period_return_pct===null));assert.equal(result.mean_annual_return_pct,null);
});

test('future cash flows and invalid or negative terminal values are rejected before a numerical estimate',()=>{
 assert.throws(()=>run([flow('a',-100,731)],121),/invalid_cashflows/);
 assert.throws(()=>run([flow('a',-100,0)],-1),/invalid_valuation/);
 assert.throws(()=>run([flow('a','NaN',0)],121),/invalid_amount/);
});

test('currency scaling does not change the annual rate and a no-profit stream has a genuine zero rate',()=>{
 const source=[flow('a',-100,0),flow('b',20,180),flow('c',-100,365)],small=run(source,210),large=run(source.map(r=>({...r,amount_usdt:String(Number(r.amount_usdt)*1e8)})),210e8);
 close(large.annualized_return_pct,Number(small.annualized_return_pct));assert.equal(run(source,180).annualized_return_pct,'0');
 const years=run([flow('a',-100,0)],121).years;assert.equal(years[0].partial_year,false);assert.equal(years[1].partial_year,true);
});
