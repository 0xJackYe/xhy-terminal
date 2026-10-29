/** Test-only D1 facade backed by Python's real SQLite transaction engine. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const PYTHON = `
import sqlite3,json,sys
data=json.load(sys.stdin)
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
try:
 if data['mode']=='exec':
  db.executescript(data['sql']);result={'count':1,'duration':0}
 else:
  output=[]
  db.execute('BEGIN IMMEDIATE')
  for index,item in enumerate(data['queries']):
   cursor=db.execute(item['sql'],item.get('params',[]))
   rows=[dict(r) for r in cursor.fetchall()] if cursor.description else []
   output.append({'success':True,'results':rows,'meta':{'changes':max(0,cursor.rowcount)}})
   if data.get('fail_at')==index:db.execute('SELECT * FROM intentionally_missing_test_table')
  db.commit()
  result=output
 print(json.dumps({'ok':True,'result':result}))
except Exception:
 db.rollback();print(json.dumps({'ok':False,'error':'SQLite fixture transaction failed'}))
finally:db.close()
`;

export async function sqliteD1Fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'xhy-diet-d1-'));
  const path = join(directory, 'test.sqlite3');
  const invoke = input => {
    const response = JSON.parse(execFileSync(process.env.PYTHON || 'python', ['-c', PYTHON, path], {
      input: JSON.stringify(input), encoding: 'utf8', windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    }));
    if (!response.ok) throw new Error(response.error);
    return response.result;
  };
  const db = {
    failBatchAt: null,
    sessions: [],
    withSession(mode) { this.sessions.push(mode); return this; },
    async exec(sql) { return invoke({ mode: 'exec', sql }); },
    prepare(sql) {
      const statement = {
        sql, params: [],
        bind(...params) { return { ...statement, params }; },
        async first() { return invoke({ mode: 'queries', queries: [this] })[0].results[0] ?? null; },
        async all() { return invoke({ mode: 'queries', queries: [this] })[0]; },
        async run() { return invoke({ mode: 'queries', queries: [this] })[0]; }
      };
      return statement;
    },
    async batch(queries) {
      const failAt = this.failBatchAt;
      this.failBatchAt = null;
      return invoke({ mode: 'queries', queries, ...(failAt === null ? {} : { fail_at: failAt }) });
    },
    async close() {
      if (!resolve(directory).startsWith(resolve(tmpdir()) + sep + 'xhy-diet-d1-')) throw new Error('Unexpected fixture path');
      await rm(directory, { recursive: true, force: true });
    }
  };
  return db;
}
