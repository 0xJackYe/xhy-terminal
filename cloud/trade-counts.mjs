// Exact ledger cardinality without scanning every historical trade on each
// one-minute sync. The singleton and triggers are bootstrapped atomically;
// ordinary reads touch one row, and inserts/deletes update it transactionally.
// Ledger writers use INSERT, INSERT OR IGNORE and DELETE. Do not use REPLACE:
// SQLite can hide its implicit deletes from triggers when recursive_triggers
// is off. The production-writer regression test enforces this contract.
const BINANCE_NEW="NEW.id LIKE 'binance:%' OR NEW.id LIKE 'binance-convert:%'";
const BINANCE_OLD="OLD.id LIKE 'binance:%' OR OLD.id LIKE 'binance-convert:%'";
const BINANCE_ROWS="id LIKE 'binance:%' OR id LIKE 'binance-convert:%'";
export const TRADE_COUNTS_INIT_SQL=[
  `CREATE TABLE IF NOT EXISTS finance_trade_counts (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    total INTEGER NOT NULL CHECK(typeof(total)='integer' AND total>=0),
    binance INTEGER NOT NULL CHECK(typeof(binance)='integer' AND binance>=0 AND binance<=total)
  )`,
  `CREATE TRIGGER IF NOT EXISTS finance_trade_counts_insert AFTER INSERT ON finance_trades BEGIN
    UPDATE finance_trade_counts SET total=total+1,binance=binance+CASE WHEN ${BINANCE_NEW} THEN 1 ELSE 0 END WHERE singleton=1;
  END`,
  `CREATE TRIGGER IF NOT EXISTS finance_trade_counts_delete AFTER DELETE ON finance_trades BEGIN
    UPDATE finance_trade_counts SET total=total-1,binance=binance-CASE WHEN ${BINANCE_OLD} THEN 1 ELSE 0 END WHERE singleton=1;
  END`,
  `CREATE TRIGGER IF NOT EXISTS finance_trade_counts_rename AFTER UPDATE OF id ON finance_trades BEGIN
    UPDATE finance_trade_counts SET binance=binance+CASE WHEN ${BINANCE_NEW} THEN 1 ELSE 0 END-CASE WHEN ${BINANCE_OLD} THEN 1 ELSE 0 END WHERE singleton=1;
  END`,
  // The outer WHERE prevents either scalar COUNT from being evaluated when
  // a concurrent initializer already committed the singleton. Two scans are
  // allowed once on an old database, never once per isolate or per request.
  `INSERT OR IGNORE INTO finance_trade_counts(singleton,total,binance)
   SELECT 1,(SELECT COUNT(*) FROM finance_trades),
     (SELECT COUNT(*) FROM finance_trades WHERE ${BINANCE_ROWS})
   WHERE NOT EXISTS(SELECT 1 FROM finance_trade_counts WHERE singleton=1)`
];
const READ='SELECT total,binance FROM finance_trade_counts WHERE singleton=1';
function valid(row){return row&&Number.isSafeInteger(row.total)&&row.total>=0&&Number.isSafeInteger(row.binance)&&row.binance>=0&&row.binance<=row.total;}
export async function initializeTradeCounts(DB){
  await DB.batch(TRADE_COUNTS_INIT_SQL.map(sql=>DB.prepare(sql)));
  const row=await DB.prepare(READ).first();
  if(!valid(row))throw new Error('trade_count_invalid');
  return {total:row.total,binance:row.binance};
}
export async function readTradeCounts(DB){
  let row;
  try{row=await DB.prepare(READ).first();}
  catch(error){
    // Quota/network/permission errors must not be mistaken for an old schema.
    if(!/no such table:\s*(?:main\.)?finance_trade_counts\b/i.test(String(error?.message||error)))throw error;
    return initializeTradeCounts(DB);
  }
  if(row===null||row===undefined)return initializeTradeCounts(DB);
  if(!valid(row))throw new Error('trade_count_invalid');
  return {total:row.total,binance:row.binance};
}
