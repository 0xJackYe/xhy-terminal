import { mergeDays, validateDiary } from './lib.mjs';

/** Persist a validated overlay before exposing it as the next in-memory state. */
export function writeDrafts(canonicalDays, nextDrafts, { storage, key = 'shiguang-drafts-v1', baseRevision } = {}) {
  const drafts = structuredClone(nextDrafts);
  validateDiary({ schemaVersion: 1, days: drafts });
  const days = mergeDays(canonicalDays, drafts);
  validateDiary({ schemaVersion: 1, days });
  try {
    storage.setItem(key, JSON.stringify({ schemaVersion: 1, days: drafts, ...(Number.isSafeInteger(baseRevision) ? { baseRevision } : {}) }));
  } catch {
    throw new Error('浏览器未能保存本机草稿，请导出备份并释放存储空间后重试；本次修改尚未保存。');
  }
  return { drafts, days };
}
