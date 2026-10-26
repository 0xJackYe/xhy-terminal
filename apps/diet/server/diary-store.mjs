import { mkdir, readFile, rename, writeFile, copyFile, readdir, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { validateDiary } from '../site/lib.mjs';

/** A local, atomic snapshot store. Runtime edits never overwrite the source diary. */
export function createFileDiaryStore({ path, seed, backupLimit = 20 }) {
  let queue = Promise.resolve();
  const exclusive = action => { const pending = queue.then(action, action); queue = pending.catch(() => {}); return pending; };
  async function read() {
    let state;
    try { state = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = { revision: 0, diary: structuredClone(seed), receipts: [] };
    }
    validateDiary(state.diary);
    if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.receipts)) throw new Error('Invalid diary store');
    return state;
  }
  return {
    persistence: 'local',
    load: () => exclusive(async () => { const state = await read(); return { diary: state.diary, revision: state.revision, canUndo: !!state.undo }; }),
    loadUndo: () => exclusive(async () => (await read()).undo ?? null),
    findReceipt: (_owner, requestId) => exclusive(async () => (await read()).receipts.find(entry => entry.requestId === requestId) ?? null),
    commit: (_owner, expectedRevision, diary, receipt) => exclusive(async () => {
      validateDiary(diary);
      const state = await read();
      const prior = state.receipts.find(entry => entry.requestId === receipt.requestId);
      if (prior) return { committed: false, receipt: prior };
      if (state.revision !== expectedRevision) return { committed: false };
      const folder = dirname(path), backups = join(folder, `${basename(path)}.backups`);
      await mkdir(backups, { recursive: true });
      try { await copyFile(path, join(backups, `${String(state.revision).padStart(10, '0')}.json`)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
      const undo = receipt.resetUndo ? null : receipt.undoable ? { diary: state.diary } : state.undo ?? null;
      const next = { revision: expectedRevision + 1, diary, undo, receipts: [...state.receipts, receipt].slice(-64) };
      await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      try { await rename(temporary, path); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
      const files = (await readdir(backups)).filter(name => /^\d{10}\.json$/.test(name)).sort();
      await Promise.all(files.slice(0, Math.max(0, files.length - backupLimit)).map(name => unlink(join(backups, name)).catch(() => {})));
      return { committed: true };
    })
  };
}
