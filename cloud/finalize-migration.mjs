// Materialize the full cost book locally and prepare bounded D1 SQL statements.
// Outputs contain private data and remain under the ignored .local directory.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildCostBook,compareTrades,dec} from './cost-book.mjs';
import {validateDiary} from '../apps/diet/site/lib.mjs';
import {schemaSQL} from './schema.mjs';

const here=dirname(fileURLToPath(import.meta.url)),local=resolve(here,'.local');
const source=JSON.parse(await readFile(resolve(local,'migration.json'),'utf8'));
const now=Date.parse(source.exported_at),timestamp=source.exported_at,owner='terminal-owner';
const ledger=source.cost_ledger,records=[...ledger.records].sort(compareTrades);
validateDiary(source.diary.diary);
for(const backup of source.diary_backups)validateDiary(backup.diary);
const book=buildCostBook(records,source.historical_rates);
if(book.trade_count!==records.length||!dec(book.inventory).eq(source.snapshots.btc_cost.summary.net_bought_btc))throw new Error('The migrated cost book does not match the verified local cost quantity');
const statements=[schemaSQL,'CREATE TABLE migration_payloads (key TEXT NOT NULL,part INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(key,part));'];
const literal=value=>value==null?'NULL':typeof value==='number'?String(value):"'"+String(value).replaceAll("'","''")+"'";
let serial=0;
function valueSQL(value){
 const raw=typeof value==='string'?value:JSON.stringify(value);
 if(Buffer.byteLength(raw,'utf8')<24000)return literal(raw);
 const key='payload-'+(++serial);let part=0,chunk='',bytes=0;
 for(const character of raw){const size=Buffer.byteLength(character,'utf8');if(bytes+size>24000){statements.push(`INSERT INTO migration_payloads(key,part,value) VALUES(${literal(key)},${part++},${literal(chunk)});`);chunk='';bytes=0;}chunk+=character;bytes+=size;}
 if(chunk)statements.push(`INSERT INTO migration_payloads(key,part,value) VALUES(${literal(key)},${part},${literal(chunk)});`);
 return `(SELECT group_concat(value,'') FROM (SELECT value FROM migration_payloads WHERE key=${literal(key)} ORDER BY part))`;
}
function insert(table,values){const cols=Object.keys(values),expressions=cols.map(k=>{const v=values[k];return v&&typeof v==='object'?valueSQL(v):typeof v==='string'&&Buffer.byteLength(v,'utf8')>=24000?valueSQL(v):literal(v);});statements.push(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${expressions.join(',')});`);}
const undo=state=>state?.undo?{diary:state.undo.diary}:null;
insert('diet_state',{owner,revision:source.diary.revision,diary_json:source.diary.diary,undo_json:undo(source.diary),last_request_id:'cloud-initial-migration',updated_at:timestamp});
for(const receipt of source.diary.receipts.slice(-64))insert('diet_receipts',{owner,request_id:receipt.requestId,receipt_json:receipt,committed_revision:receipt.result?.revision??source.diary.revision,created_at:timestamp});
for(const backup of source.diary_backups)insert('diet_backups',{owner,revision:backup.revision,diary_json:backup.diary,undo_json:undo(backup),created_at:timestamp});
for(const row of records)insert('finance_trades',{id:row.id,bill_id:row.bill_id,at_ms:row.at_ms,record_json:row});
const finance={cost_meta:{identity:ledger.identity,complete:ledger.complete,coverage_start_ms:ledger.coverage_start_ms,as_of_ms:ledger.as_of_ms},cost_book:book,historical_rates:source.historical_rates,policy:source.policy,chain_snapshot:source.chain_snapshot,price_ledger:source.price_ledger};
for(const key of ['okx','combined','portfolio','btc_cost','btc_pnl'])finance[key]=source.snapshots[key];
const c=source.snapshots.combined,q=c.quotes;
if(q?.usd_cny)finance.fx={rate:q.usd_cny,date:null,observed_at:c.updated_at};
if(q?.btc_usd)finance.market={price_usdt:source.snapshots.btc_pnl.metrics.price_usdt,btc_usd:q.btc_usd,usd_cny:q.usd_cny,updated_at:c.updated_at};
for(const [key,value]of Object.entries(finance))if(value!=null)insert('finance_kv',{key,value,updated_ms:now});
const terminal=source.snapshots.terminal,settings=source.alert_state.settings||terminal.settings;
insert('market_kv',{key:'settings',value:settings,updated_ms:now});
insert('market_kv',{key:'runtime',value:{...terminal,last_sync_ms:0},updated_ms:now});
insert('market_kv',{key:'triggered',value:source.alert_state.fired||[],updated_ms:now});
const alerts=new Map([...(source.alert_state.alerts||[]),...(terminal.alerts||[])].map(e=>[e.id,e]));
for(const e of alerts.values())insert('market_alerts',{id:e.id,at_ms:e.at_ms,event_json:e});
statements.push('DROP TABLE migration_payloads;');
for(const statement of statements)if(Buffer.byteLength(statement,'utf8')>90000)throw new Error('SQL statement exceeds the bounded import size');
await writeFile(resolve(local,'migration.sql'),statements.join('\n')+'\n');
await writeFile(resolve(local,'migration-verification.json'),JSON.stringify({diaryRevision:source.diary.revision,diaryDates:source.diary.diary.days.map(d=>d.date),receipts:source.diary.receipts.length,backups:source.diary_backups.length,trades:records.length,netBtc:book.inventory,cost:book.cost,buyCount:book.buy_count,sellCount:book.sell_count,alerts:alerts.size,sqlStatements:statements.length},null,2));
console.log(JSON.stringify({ready:true,trades:records.length,diaryRevision:source.diary.revision,diaryDays:source.diary.diary.days.length,sqlStatements:statements.length,maxStatementBytes:Math.max(...statements.map(s=>Buffer.byteLength(s,'utf8')))}));
