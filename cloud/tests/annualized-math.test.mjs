import test from 'node:test';
import assert from 'node:assert/strict';
import {D,buildCostBook} from '../cost-book.mjs';
import {buildRemainingCapital,appendRemainingCapital,solveRemainingXirr,calculatePositionAnnualized} from '../annualized-math.mjs';

const at=s=>Date.parse(s),NOW=at('2026-01-01T04:00:00Z');
function trade(side,qty,cost,id,date,ccy='USDT'){
 const q=new D(qty),cash=new D(cost),price=cash.div(q.abs()).toFixed();
 return {id:'trade-'+id,bill_id:String(id*2),counter_bill_id:String(id*2+1),at_ms:at(date),side,inst_id:'BTC-'+ccy,trade_id:String(id),order_id:String(id),price,btc_gross:q.abs().toFixed(),btc_net:q.toFixed(),fee_btc:'0',fee_quote:'0',quote_ccy:ccy,quote_gross:cash.toFixed(),quote_amount:cash.toFixed(),original_price:price};
}
const original=[trade('buy','2','200',1,'2024-01-01T02:00:00Z'),trade('buy','1','200',2,'2024-07-01T02:00:00Z'),trade('sell','-1.5','9999',3,'2024-10-01T02:00:00Z'),trade('buy','.5','75',4,'2025-01-01T02:00:00Z')];
const sum=(rows,key)=>rows.reduce((n,r)=>n.add(r[key]),new D(0)).toFixed();
const close=(actual,expected,tolerance=1e-8)=>assert.ok(Math.abs(Number(actual)-expected)<tolerance,`${actual} != ${expected}`);

test('remaining capital matches moving-average costs and scales original dates, excluding realized proceeds',()=>{
 const state=buildRemainingCapital(original),book=buildCostBook(original);
 assert.equal(state.inventory,book.inventory);assert.equal(state.cost,book.cost);assert.equal(sum(state.cohorts,'quantity'),book.inventory);assert.equal(sum(state.cohorts,'cost'),book.cost);
 assert.deepEqual(state.cohorts.map(x=>[x.date,x.cost,x.quantity]),[['2024-01-01','100','1'],['2024-07-01','100','0.5'],['2025-01-01','75','0.5']]);
 const changed=structuredClone(original);changed[2].quote_amount='123';changed[2].quote_gross='123';
 assert.deepEqual(buildRemainingCapital(changed),state);
});

test('incremental daily DCA and a sale retain exactly the independently computed book scalar',()=>{
 let capital=buildRemainingCapital(original.slice(0,2));
 capital=appendRemainingCapital(capital,original.slice(2));
 assert.deepEqual(capital,buildRemainingCapital(original));
 const update=trade('buy','.25','30',5,'2025-01-01T13:00:00Z'),next=appendRemainingCapital(capital,[update]),book=buildCostBook([...original,update]);
 assert.equal(next.cohorts.length,3);assert.equal(next.cohorts.at(-1).cost,'105');assert.equal(next.cost,book.cost);assert.equal(next.inventory,book.inventory);
 assert.equal(capital.cohorts.at(-1).cost,'75');
});

test('liquidation clears old capital cohorts without rewinding the original first buy metadata',()=>{
 const records=[original[0],trade('sell','-2','500',2,'2024-05-01T01:00:00Z'),trade('buy','1','80',3,'2025-01-01T01:00:00Z')],state=buildRemainingCapital(records);
 assert.equal(state.cost,'80');assert.equal(state.cohorts.length,1);assert.equal(state.first_buy_at,'2024-01-01T02:00:00.000Z');assert.equal(state.first_remaining_buy_at,'2025-01-01T01:00:00.000Z');
 const empty=appendRemainingCapital(state,[trade('sell','-1','500',4,'2025-03-01T01:00:00Z')]);
 assert.equal(empty.cost,'0');assert.deepEqual(empty.cohorts,[]);
 assert.equal(calculatePositionAnnualized({capital:empty,holdingsBtc:'0',priceUsdt:'100',asOfMs:NOW}).annualized_return_pct,null);
});

test('historical non-USDT purchase cost requires and uses the original exact minute rate',()=>{
 const row=trade('buy','.02','2',1,'2024-01-01T00:00:00Z','ETH');
 assert.throws(()=>buildRemainingCapital([row]),/historical_rate_missing/);
 const rates={['ETH:'+row.at_ms]:{close:'2000'}};
 const result=buildRemainingCapital([row],rates);assert.equal(result.cost,'4000');assert.equal(result.cost,buildCostBook([row],rates).cost);
});

test('invalid duplicates, out of order append and overselling cannot corrupt a durable capital state',()=>{
 assert.throws(()=>buildRemainingCapital([original[0],original[0]]),/duplicate_trade/);
 assert.throws(()=>buildRemainingCapital([trade('sell','-1','50',1,'2024-01-01T00:00:00Z')]),/history_invalid/);
 const state=buildRemainingCapital(original);
 assert.throws(()=>appendRemainingCapital(state,[original[0]]),/out_of_order_trade/);
 assert.equal(state.cost,'275');
});

test('single dated investment gives the known 10 percent annual rate using a 365-day year',()=>{
 const start=at('2025-01-01T00:00:00+08:00'),end=start+365*86400000;
 close(solveRemainingXirr([{at_ms:start,cost:'100'}],'110',end).annualized_return_pct,10);
 close(solveRemainingXirr([{at_ms:start,cost:'100'}],'90',end).annualized_return_pct,-10);
 assert.equal(solveRemainingXirr([{at_ms:start,cost:'100'}],'100',end).annualized_return_pct,'0');
});

test('dated DCA has its own money-weighted rate rather than treating the later purchase as invested on day one',()=>{
 const start=at('2024-01-01T00:00:00+08:00'),end=start+730*86400000;
 const result=solveRemainingXirr([{at_ms:start,cost:'100'},{at_ms:start+365*86400000,cost:'100'}],'231',end);
 close(result.annualized_return_pct,10);
 assert.ok(Math.abs(Number(result.annualized_return_pct)-((231/200)**.5-1)*100)>2);
});

test('daily cashflow dates use Beijing days and a leap-year span remains 366/365 financial years',()=>{
 const start=at('2024-01-01T00:00:00+08:00'),end=at('2025-01-01T00:00:00+08:00');
 close(solveRemainingXirr([{at_ms:start+13*3600000,cost:'100'}],'110',end+7*3600000).annualized_return_pct,((1.1)**(365/366)-1)*100);
 const same=solveRemainingXirr([{at_ms:start+13*3600000,cost:'100'}],'110',start+22*3600000);
 assert.equal(same.annualized_return_pct,null);assert.match(same.reason,/不足一个/);
});

test('zero basis, zero valuation, near-total loss and same-day terminal contradictions stay honest',()=>{
 const start=at('2024-01-01T00:00:00+08:00'),end=start+365*86400000;
 assert.equal(solveRemainingXirr([],'1',end).annualized_return_pct,null);
 assert.equal(solveRemainingXirr([{at_ms:start,cost:'1'}],'0',end).annualized_return_pct,null);
 close(solveRemainingXirr([{at_ms:start,cost:'100'}],'0.0001',end).annualized_return_pct,-99.9999,1e-9);
 assert.equal(solveRemainingXirr([{at_ms:start,cost:'100'},{at_ms:end,cost:'100'}],'80',end).annualized_return_pct,null);
 assert.throws(()=>solveRemainingXirr([{at_ms:end+86400000,cost:'100'}],'200',end),/invalid_cashflow/);
});

test('headline values use actual holdings and unchanged remaining cost with the explicit retrospective method',()=>{
 const view=calculatePositionAnnualized({records:[trade('buy','1','100',1,'2025-01-01T02:00:00Z')],holdingsBtc:'1.1',priceUsdt:'100',asOfMs:NOW});
 close(view.annualized_return_pct,10);assert.equal(view.remaining_cost,'100');assert.equal(view.market_value,'110');assert.equal(view.method,'remaining_position_xirr');assert.equal(view.status,'estimated');
 assert.equal(view.cashflow_date_convention,'beijing_calendar_day');assert.ok(view.assumptions.some(x=>/Received/.test(x)));
});

test('calendar years use exact boundary values and report partial periods without substituting missing prices',()=>{
 const start='2024-07-01T04:00:00Z',rows=[trade('buy','1','100',1,start)],asOf=at('2026-07-01T04:00:00Z');
 const p={2025:{at_ms:at('2025-01-01T00:00:00+08:00'),price_usdt:'110',source:'fixture/daily-boundary'},2026:{at_ms:at('2026-01-01T00:00:00+08:00'),price_usdt:'121',source:'fixture/daily-boundary'}};
 const view=calculatePositionAnnualized({records:rows,holdingsBtc:'1',priceUsdt:'130',asOfMs:asOf,yearPrices:p});
 assert.equal(view.years.length,3);assert.equal(view.years[0].partial_year,true);assert.equal(view.years[1].partial_year,false);assert.equal(view.years[2].partial_year,true);
 close(view.years[0].period_return_pct,10);close(view.years[1].annualized_return_pct,10);close(view.years[1].period_return_pct,10);close(view.years[2].period_return_pct,(130/121-1)*100);
 const bad=calculatePositionAnnualized({records:rows,holdingsBtc:'1',priceUsdt:'130',asOfMs:asOf,yearPrices:{2025:{...p[2025],at_ms:p[2025].at_ms+86400000}}});
 assert.notEqual(bad.annualized_return_pct,null);assert.ok(bad.years.every(x=>x.annualized_return_pct===null));assert.ok(bad.years.every(x=>/缺少/.test(x.reason)));
});

test('the current-year DCA negative is dated when it was invested and a historical ending never includes next-year buys',()=>{
 const rows=[trade('buy','1','100',1,'2024-01-01T04:00:00Z'),trade('buy','1','150',2,'2025-01-01T04:00:00Z')];
 const view=calculatePositionAnnualized({records:rows,holdingsBtc:'2',priceUsdt:'200',asOfMs:NOW,yearPrices:{2025:{at_ms:at('2025-01-01T00:00:00+08:00'),price_usdt:'150',source:'fixture'},2026:{at_ms:at('2026-01-01T00:00:00+08:00'),price_usdt:'200',source:'fixture'}}});
 assert.equal(view.years[0].closing_value,'150');assert.equal(view.years[1].opening_value,'150');assert.equal(view.years[1].closing_value,'400');close(view.years[1].annualized_return_pct,100/3);
 assert.equal(view.years[2].annualized_return_pct,null);
});

test('many irregular partial sales keep scalar cost and cohort sums reconciled exactly',()=>{
 const records=[];let inventory=new D(0),id=0;
 for(let i=0;i<300;i++){
  const date=new Date(at('2024-01-01T00:00:00Z')+i*86400000).toISOString();
  const row=trade('buy','0.001234567891','19.8765432198',++id,date);records.push(row);inventory=inventory.add(row.btc_net);
  if(i%3===0){const sold=inventory.div(7).toDecimalPlaces(12);records.push(trade('sell',sold.neg().toFixed(),'1',++id,date));inventory=inventory.sub(sold);}
 }
 const state=buildRemainingCapital(records),book=buildCostBook(records);
 assert.equal(state.cost,book.cost);assert.equal(state.inventory,book.inventory);assert.equal(sum(state.cohorts,'cost'),state.cost);assert.equal(sum(state.cohorts,'quantity'),state.inventory);
});

test('a repurchased position starts its yearly active period on the first surviving buy, not on old liquidated capital',()=>{
 const rows=[trade('buy','1','100',1,'2024-02-01T04:00:00Z'),trade('sell','-1','120',2,'2024-04-01T04:00:00Z'),trade('buy','1','100',3,'2025-07-01T04:00:00Z')];
 const view=calculatePositionAnnualized({records:rows,holdingsBtc:'1',priceUsdt:'110',asOfMs:at('2025-10-01T04:00:00Z')});
 assert.equal(view.years[0].status,'unavailable');assert.equal(view.years[1].start_at,'2025-06-30T16:00:00.000Z');assert.equal(view.years[1].partial_year,true);close(view.years[1].period_return_pct,10);
});
