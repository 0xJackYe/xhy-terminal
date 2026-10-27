import { validateDiary } from '../apps/diet/site/lib.mjs';

/** D1 schema. State, retry receipts and backups are separate bounded rows. */
export const DIET_SCHEMA = `
CREATE TABLE IF NOT EXISTS diet_state (
  owner TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  diary_json TEXT NOT NULL,
  undo_json TEXT,
  last_request_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS diet_receipts (
  owner TEXT NOT NULL,
  request_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  committed_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner, request_id)
);
CREATE INDEX IF NOT EXISTS diet_receipts_revision ON diet_receipts(owner, committed_revision DESC);
CREATE TABLE IF NOT EXISTS diet_backups (
  owner TEXT NOT NULL,
  revision INTEGER NOT NULL,
  diary_json TEXT NOT NULL,
  undo_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner, revision)
);
`;

const DEFAULT_OWNER = 'terminal-owner';
const clone = value => structuredClone(value);

function ownerName(owner = DEFAULT_OWNER) {
  if (typeof owner !== 'string' || !owner || owner.length > 160 || /[\u0000-\u001f\u007f]/u.test(owner)) {
    throw new Error('Invalid diary owner');
  }
  return owner;
}

function revisionNumber(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid diary revision');
  return value;
}

function boundedLimit(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error('Invalid retention limit');
  return value;
}

function receiptValue(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || typeof receipt.requestId !== 'string' || !receipt.requestId || receipt.requestId.length > 128
      || /[\u0000-\u001f\u007f]/u.test(receipt.requestId)
      || typeof receipt.fingerprint !== 'string' || !receipt.fingerprint || receipt.fingerprint.length > 256
      || !receipt.result || typeof receipt.result !== 'object' || Array.isArray(receipt.result)) {
    throw new Error('Invalid diary receipt');
  }
  // Serialize before entering the write batch, so cyclic/invalid input cannot
  // cause a partially applied commit. The diary API owns response semantics.
  return JSON.stringify(receipt);
}

function undoValue(undo) {
  if (undo == null) return null;
  if (!undo || typeof undo !== 'object' || Array.isArray(undo)) throw new Error('Invalid diary undo');
  validateDiary(undo.diary);
  return JSON.stringify({ diary: undo.diary });
}

function readState(row) {
  if (!row) throw new Error('Diary state is not initialized');
  const diary = JSON.parse(row.diary_json), undo = row.undo_json == null ? null : JSON.parse(row.undo_json);
  validateDiary(diary);
  revisionNumber(row.revision);
  if (undo) validateDiary(undo.diary);
  return { diary, revision: row.revision, undo };
}

function databaseSession(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') throw new Error('D1 binding is unavailable');
  // Use primary-first reads even if a deployment later enables read replicas.
  return typeof db.withSession === 'function' ? db.withSession('first-primary') : db;
}

function changes(result) {
  if (result?.success === false) throw new Error('D1 operation failed');
  return Number(result?.meta?.changes ?? 0);
}

/**
 * Import an existing local envelope once, without replacing any live cloud data.
 * Accepts {revision, diary, undo?, receipts?}; backup envelopes are optional.
 */
export async function importD1DiaryState(database, owner, state, { backups = [], now = () => new Date().toISOString() } = {}) {
  owner = ownerName(owner);
  const db = databaseSession(database);
  validateDiary(state?.diary);
  const revision = revisionNumber(state.revision);
  const receipts = state.receipts ?? [];
  if (!Array.isArray(receipts) || !Array.isArray(backups)) throw new Error('Invalid diary import');
  const receiptRows = receipts.slice(-64).map(receipt => ({ value: receipt, json: receiptValue(receipt) }));
  if (new Set(receiptRows.map(row => row.value.requestId)).size !== receiptRows.length) throw new Error('Duplicate diary receipts');
  const backupRows = backups.slice(-20).map(backup => {
    validateDiary(backup?.diary);
    const older = revisionNumber(backup.revision);
    if (older >= revision) throw new Error('Backup is not older than imported state');
    return { revision: older, diary: JSON.stringify(backup.diary), undo: undoValue(backup.undo) };
  });
  if (new Set(backupRows.map(row => row.revision)).size !== backupRows.length) throw new Error('Duplicate diary backups');
  const marker = `import-${crypto.randomUUID()}`, timestamp = now();
  const statements = [db.prepare(`INSERT OR IGNORE INTO diet_state
    (owner, revision, diary_json, undo_json, last_request_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(owner, revision, JSON.stringify(state.diary), undoValue(state.undo), marker, timestamp)];
  for (const { value, json } of receiptRows) {
    const receiptRevision = Number.isSafeInteger(value.result?.revision) && value.result.revision >= 0
      ? value.result.revision : revision;
    statements.push(db.prepare(`INSERT OR IGNORE INTO diet_receipts
      (owner, request_id, receipt_json, committed_revision, created_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS
      (SELECT 1 FROM diet_state WHERE owner = ? AND revision = ? AND last_request_id = ?)`)
      .bind(owner, value.requestId, json, receiptRevision, timestamp, owner, revision, marker));
  }
  for (const backup of backupRows) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO diet_backups
      (owner, revision, diary_json, undo_json, created_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS
      (SELECT 1 FROM diet_state WHERE owner = ? AND revision = ? AND last_request_id = ?)`)
      .bind(owner, backup.revision, backup.diary, backup.undo, timestamp, owner, revision, marker));
  }
  const result = await db.batch(statements);
  return { imported: changes(result[0]) === 1 };
}

/** Cloud counterpart to createFileDiaryStore. All commits use an atomic CAS batch. */
export function createD1DiaryStore({ db: database, seed, backupLimit = 20, receiptLimit = 64,
  now = () => new Date().toISOString() } = {}) {
  boundedLimit(backupLimit, 100);
  boundedLimit(receiptLimit, 256);
  if (receiptLimit === 0) throw new Error('Retry receipts cannot be disabled');
  if (seed !== undefined) validateDiary(seed);

  async function stateRow(db, owner) {
    let row = await db.prepare('SELECT revision, diary_json, undo_json FROM diet_state WHERE owner = ?').bind(owner).first();
    if (!row && seed !== undefined) {
      await db.prepare(`INSERT OR IGNORE INTO diet_state
        (owner, revision, diary_json, undo_json, last_request_id, updated_at) VALUES (?, 0, ?, NULL, NULL, ?)`)
        .bind(owner, JSON.stringify(seed), now()).run();
      row = await db.prepare('SELECT revision, diary_json, undo_json FROM diet_state WHERE owner = ?').bind(owner).first();
    }
    return row;
  }

  async function findReceipt(db, owner, requestId) {
    const row = await db.prepare('SELECT receipt_json FROM diet_receipts WHERE owner = ? AND request_id = ?')
      .bind(owner, requestId).first();
    if (!row) return null;
    const receipt = JSON.parse(row.receipt_json);
    receiptValue(receipt);
    return receipt;
  }

  const store = {
    persistence: 'cloud',
    async load(owner) {
      owner = ownerName(owner);
      const state = readState(await stateRow(databaseSession(database), owner));
      return { diary: state.diary, revision: state.revision, canUndo: !!state.undo };
    },
    async loadUndo(owner) {
      owner = ownerName(owner);
      return readState(await stateRow(databaseSession(database), owner)).undo;
    },
    async findReceipt(owner, requestId) {
      owner = ownerName(owner);
      if (typeof requestId !== 'string' || !requestId || requestId.length > 128) throw new Error('Invalid request ID');
      return findReceipt(databaseSession(database), owner, requestId);
    },
    async commit(owner, expectedRevision, diary, receipt) {
      owner = ownerName(owner);
      revisionNumber(expectedRevision);
      if (expectedRevision === Number.MAX_SAFE_INTEGER) throw new Error('Invalid diary revision');
      validateDiary(diary);
      const receiptJSON = receiptValue(receipt), diaryJSON = JSON.stringify(diary);
      const db = databaseSession(database);
      const prior = await findReceipt(db, owner, receipt.requestId);
      if (prior) return { committed: false, receipt: prior };
      const state = readState(await stateRow(db, owner));
      if (state.revision !== expectedRevision) return { committed: false };
      const undo = receipt.resetUndo ? null : receipt.undoable ? { diary: state.diary } : state.undo;
      const timestamp = now(), nextRevision = expectedRevision + 1;
      const statements = [
        db.prepare(`INSERT OR IGNORE INTO diet_backups (owner, revision, diary_json, undo_json, created_at)
          SELECT owner, revision, diary_json, undo_json, ? FROM diet_state WHERE owner = ? AND revision = ?`)
          .bind(timestamp, owner, expectedRevision),
        db.prepare(`UPDATE diet_state SET revision = ?, diary_json = ?, undo_json = ?, last_request_id = ?, updated_at = ?
          WHERE owner = ? AND revision = ?`)
          .bind(nextRevision, diaryJSON, undoValue(undo), receipt.requestId, timestamp, owner, expectedRevision),
        db.prepare(`INSERT OR IGNORE INTO diet_receipts (owner, request_id, receipt_json, committed_revision, created_at)
          SELECT ?, ?, ?, ?, ? WHERE EXISTS
          (SELECT 1 FROM diet_state WHERE owner = ? AND revision = ? AND last_request_id = ?)`)
          .bind(owner, receipt.requestId, receiptJSON, nextRevision, timestamp, owner, nextRevision, receipt.requestId),
        db.prepare(`DELETE FROM diet_receipts WHERE owner = ? AND request_id NOT IN
          (SELECT request_id FROM diet_receipts WHERE owner = ? ORDER BY committed_revision DESC, request_id DESC LIMIT ?)`)
          .bind(owner, owner, receiptLimit),
        db.prepare(`DELETE FROM diet_backups WHERE owner = ? AND revision NOT IN
          (SELECT revision FROM diet_backups WHERE owner = ? ORDER BY revision DESC LIMIT ?)`)
          .bind(owner, owner, backupLimit)
      ];
      // D1 batches are one transaction: a receipt or backup failure rolls back
      // the state write too. A failed CAS cannot append a receipt for that write.
      const result = await db.batch(statements);
      for (const row of result) changes(row);
      if (changes(result[1]) === 1) return { committed: true };
      const raced = await findReceipt(db, owner, receipt.requestId);
      return raced ? { committed: false, receipt: raced } : { committed: false };
    },
    async listBackups(owner) {
      owner = ownerName(owner);
      const result = await databaseSession(database).prepare(
        'SELECT revision, created_at FROM diet_backups WHERE owner = ? ORDER BY revision DESC LIMIT ?')
        .bind(owner, backupLimit).all();
      if (result.success === false) throw new Error('D1 operation failed');
      return result.results ?? [];
    },
    async loadBackup(owner, revision) {
      owner = ownerName(owner);
      revisionNumber(revision);
      const row = await databaseSession(database).prepare(
        'SELECT revision, diary_json, undo_json FROM diet_backups WHERE owner = ? AND revision = ?')
        .bind(owner, revision).first();
      return row ? readState(row) : null;
    },
    async restoreBackup(owner, expectedRevision, backupRevision, receipt) {
      const backup = await store.loadBackup(owner, backupRevision);
      if (!backup) return { committed: false, missing: true };
      // Restore as a new revision; never rewind the CAS counter or retry log.
      return store.commit(owner, expectedRevision, backup.diary, { ...receipt, undoable: true, resetUndo: false });
    },
    async initialize(owner, state, options = {}) {
      return importD1DiaryState(database, owner, clone(state), { ...options, now });
    }
  };
  return store;
}
