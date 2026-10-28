// Read the private D1 JSON exports from .local; never copy personal data to Git.
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildRemainingCapital} from './annualized-math.mjs';
import {annualBoundaryYears,fetchAnnualBoundary} from './annualized.mjs';
import {dec} from './cost-book.mjs';
const local=resolve(dirname(fileURLToPath(import.meta.url)),'.local');
const read=async name=>JSON.parse((await readFile(resolve(local,name),'utf8')).replace(/^\uFEFF/,''));
const records=(await read('annualized-trades.json'))[0].results.map(row=>JSON.parse(row.record_json));
const context=Object.fromEntries((await read('annualized-seed-context.json'))[0].results.map(row=>[row.key,JSON.parse(row.value)]));
const capital={...buildRemainingCapital(records,context.historical_rates),identity:context.cost_meta.identity,seed_epoch:crypto.randomUUID()};
if(capital.trade_count!==context.cost_book.trade_count||capital.last_bill_id!==context.cost_book.last_bill_id||!dec(capital.cost).eq(context.cost_book.cost)||!dec(capital.inventory).eq(context.cost_book.inventory))throw new Error('Remote ledger and cost book changed; export a consistent snapshot again.');
let prices={};try{prices=await read('annualized-boundaries.json');}catch{}
for(const year of annualBoundaryYears(capital,Date.parse(context.btc_pnl.as_of))){
 if(!prices[year]){prices[year]=await fetchAnnualBoundary(year);console.log('Confirmed year boundary '+year);}
}
await writeFile(resolve(local,'annualized-capital.json'),JSON.stringify(capital));
await writeFile(resolve(local,'annualized-boundaries.json'),JSON.stringify(prices));
const literal=s=>"'"+String(s).replaceAll("'","''")+"'",statements=['CREATE TABLE annualized_seed_parts (part INTEGER PRIMARY KEY,value TEXT NOT NULL);'];
const payload=JSON.stringify(capital),parts=[];for(let i=0;i<payload.length;i+=12000)parts.push(payload.slice(i,i+12000));
parts.forEach((part,i)=>statements.push(`INSERT INTO annualized_seed_parts(part,value) VALUES(${i},${literal(part)});`));
const stamp=Date.now();
const consistent=`EXISTS(SELECT 1 FROM finance_kv WHERE key='cost_book' AND json_extract(value,'$.last_bill_id')=${literal(capital.last_bill_id)} AND json_extract(value,'$.trade_count')=${capital.trade_count} AND json_extract(value,'$.cost')=${literal(capital.cost)} AND json_extract(value,'$.inventory')=${literal(capital.inventory)})`;
statements.push(`INSERT INTO finance_kv(key,value,updated_ms) SELECT 'annualized_capital',(SELECT group_concat(value,'') FROM (SELECT value FROM annualized_seed_parts ORDER BY part)),${stamp} WHERE ${consistent} ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_ms=excluded.updated_ms;`);
statements.push(`INSERT INTO finance_kv(key,value,updated_ms) VALUES('annualized_year_prices',${literal(JSON.stringify(prices))},${stamp}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_ms=excluded.updated_ms;`);
statements.push('DROP TABLE annualized_seed_parts;');
if(statements.some(sql=>Buffer.byteLength(sql)>90000))throw new Error('Derived state SQL is too large');
await writeFile(resolve(local,'annualized-seed.sql'),statements.join('\n'));
console.log(JSON.stringify({prepared:true,trades:capital.trade_count,cohorts:capital.cohorts.length,firstBuy:capital.first_buy_at,yearBoundaries:Object.keys(prices)}));
