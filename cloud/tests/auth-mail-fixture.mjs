import { DatabaseSync } from 'node:sqlite';

export function testDatabase(schema) {
  const sqlite = new DatabaseSync(':memory:');
  for (const sql of Array.isArray(schema) ? schema : [schema]) sqlite.exec(sql);
  const DB = {
    prepare(sql) {
      return {
        sql, values: [],
        bind(...values) { this.values = values; return this; },
        async first(column) { const row = sqlite.prepare(this.sql).get(...this.values); return column ? row?.[column] : row ?? null; },
        async all() { return { success: true, results: sqlite.prepare(this.sql).all(...this.values) }; },
        async run() { const row = sqlite.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(row.changes) } }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map(statement => {
          const row = sqlite.prepare(statement.sql).run(...statement.values);
          return { success: true, meta: { changes: Number(row.changes) } };
        });
        sqlite.exec('COMMIT'); return result;
      }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { DB, sqlite };
}

export const NOW = Date.parse('2026-10-28T02:00:00Z');
export function post(path, input, headers = {}) {
  return new Request('https://terminal.example' + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://terminal.example', 'X-Terminal-Request': '1', ...headers },
    body: JSON.stringify(input),
  });
}
