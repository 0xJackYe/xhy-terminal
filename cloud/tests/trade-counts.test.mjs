import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {testDatabase} from './auth-mail-fixture.mjs';
import {FINANCE_SCHEMA_SQL} from '../finance.mjs';
import {initializeTradeCounts,readTradeCounts} from '../trade-counts.mjs';

function fixture(t){const f=testDatabase(FINANCE_SCHEMA_SQL);t.after(()=>f.sqlite.close());return f;}
function insert(DB,id,bill=id,verb='INSERT'){return DB.prepare(`${verb} INTO finance_trades(id,bill_id,at_ms,record_json) VALUES(?,?,?,?)`).bind(id,bill,1,'{}');}
const actual=sqlite=>({...sqlite.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN id LIKE 'binance:%' OR id LIKE 'binance-convert:%' THEN 1 ELSE 0 END),0) AS binance FROM finance_trades").get()});

test('a legacy populated ledger initializes exact total and original Binance-prefix semantics once',async t=>{
 const {DB,sqlite}=fixture(t);
 for(const id of ['okx:1','binance:2','binance-convert:3','BINANCE:4','binance-other:5'])await insert(DB,id).run();
 assert.deepEqual(await readTradeCounts(DB),{total:5,binance:3});assert.deepEqual(await readTradeCounts(DB),actual(sqlite));
 const statements=[],readDB={prepare(sql){statements.push(sql);return DB.prepare(sql);},batch:statements=>DB.batch(statements)};
 for(let i=0;i<20;i++)assert.deepEqual(await readTradeCounts(readDB),{total:5,binance:3});
 assert.equal(statements.length,20);assert.ok(statements.every(sql=>!sql.includes('finance_trades')&&!/\b(?:COUNT|SUM)\s*\(/i.test(sql)),'warm reads never scan historical fills or re-run schema');
});

test('concurrent first reads initialize one singleton and triggers do not double-count old rows',async t=>{
 const {DB,sqlite}=fixture(t);await insert(DB,'binance:1').run();
 const results=await Promise.all([readTradeCounts(DB),readTradeCounts(DB),readTradeCounts(DB)]);
 assert.deepEqual(results,[{total:1,binance:1},{total:1,binance:1},{total:1,binance:1}]);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM finance_trade_counts').get().n,1);
 await insert(DB,'okx:2').run();assert.deepEqual(await initializeTradeCounts(DB),{total:2,binance:1},'an explicit repeated bootstrap preserves transactionally updated counters');
});

test('new inserts, ignored duplicates and failed batches keep exact committed cardinality',async t=>{
 const {DB,sqlite}=fixture(t);await readTradeCounts(DB);
 await insert(DB,'okx:1').run();await insert(DB,'binance:2').run();await insert(DB,'binance:2','binance:2','INSERT OR IGNORE').run();
 await insert(DB,'binance:ignored-bill','binance:2','INSERT OR IGNORE').run();
 assert.deepEqual(await readTradeCounts(DB),{total:2,binance:1});
 await assert.rejects(()=>DB.batch([insert(DB,'binance-convert:3'),insert(DB,'okx:conflict','okx:1')]));
 assert.deepEqual(await readTradeCounts(DB),{total:2,binance:1});assert.deepEqual(await readTradeCounts(DB),actual(sqlite));
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM finance_trades WHERE id='binance-convert:3'").get().n,0);
 await assert.rejects(()=>DB.batch([DB.prepare("DELETE FROM finance_trades WHERE id='binance:2'"),insert(DB,'conflict-after-delete','okx:1')]));
 assert.deepEqual(await readTradeCounts(DB),{total:2,binance:1});assert.deepEqual(await readTradeCounts(DB),actual(sqlite));
});

test('replacing a Binance account deletes just its old rows and new rows have no rowid assumptions',async t=>{
 const {DB,sqlite}=fixture(t);await readTradeCounts(DB);
 for(const id of ['okx:1','binance:2','okx:3','binance-convert:4'])await insert(DB,id).run();
 await DB.prepare("DELETE FROM finance_trades WHERE id LIKE 'binance:%' OR id LIKE 'binance-convert:%'").run();
 assert.deepEqual(await readTradeCounts(DB),{total:2,binance:0});
 await insert(DB,'binance:replacement').run();assert.deepEqual(await readTradeCounts(DB),{total:3,binance:1});assert.deepEqual(await readTradeCounts(DB),actual(sqlite));
 await DB.prepare('DELETE FROM finance_trades').run();assert.deepEqual(await readTradeCounts(DB),{total:0,binance:0});
});

test('renamed trade ids maintain exactly the same case-insensitive prefix rule without changing total',async t=>{
 const {DB,sqlite}=fixture(t);await readTradeCounts(DB);await insert(DB,'okx:1').run();
 await DB.prepare('UPDATE finance_trades SET id=? WHERE id=?').bind('BINANCE-CONVERT:1','okx:1').run();assert.deepEqual(await readTradeCounts(DB),{total:1,binance:1});
 await DB.prepare('UPDATE finance_trades SET id=? WHERE id=?').bind('not-binance:1','BINANCE-CONVERT:1').run();assert.deepEqual(await readTradeCounts(DB),{total:1,binance:0});assert.deepEqual(await readTradeCounts(DB),actual(sqlite));
});

test('failed bootstrap rolls schema back and can safely retry without losing committed trades',async t=>{
 const {DB,sqlite}=fixture(t);await insert(DB,'okx:old').run();
 const broken={prepare:sql=>DB.prepare(sql),batch:statements=>DB.batch([...statements,DB.prepare('INSERT INTO nonexistent_table VALUES(1)')])};
 await assert.rejects(()=>initializeTradeCounts(broken));assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='finance_trade_counts'").get().n,0);
 assert.deepEqual(await readTradeCounts(DB),{total:1,binance:0});
});

test('quota and connection errors propagate instead of triggering another full-table initialization',async()=>{
 const quota=new Error('D1_ERROR: account exceeded daily row read limit'),calls=[];
 const DB={prepare(sql){calls.push(sql);return {first:async()=>{throw quota;}};},async batch(){assert.fail('must not initialize for a quota failure');}};
 await assert.rejects(()=>readTradeCounts(DB),error=>error===quota);assert.equal(calls.length,1);
});

test('malformed counters fail closed and a missing singleton is rebuilt from actual ledger rows',async t=>{
 const {DB}=fixture(t);await readTradeCounts(DB);await insert(DB,'binance:1').run();await DB.prepare('DELETE FROM finance_trade_counts').run();
 assert.deepEqual(await readTradeCounts(DB),{total:1,binance:1});
 await assert.rejects(()=>readTradeCounts({prepare(){return {first:async()=>({total:1.5,binance:1})};}}),/trade_count_invalid/);
});

test('production trade writers cannot silently introduce SQLite REPLACE implicit deletes',async()=>{
 const directory=new URL('../',import.meta.url);
 for(const name of await readdir(directory))if(name.endsWith('.mjs')&&name!=='generated.mjs'){
   const source=await readFile(new URL(name,directory),'utf8');
   assert.doesNotMatch(source,/INSERT\s+OR\s+REPLACE\s+INTO\s+finance_trades\b/i,name+' must use explicit DELETE + INSERT so count triggers observe every change');
 }
});
