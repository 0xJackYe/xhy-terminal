import { validDate } from './lib.mjs';

/** Keep each day's unfinished conversation separate, including its retry receipt. */
export function createChatDateSessions(initialDate, createSession) {
  if (!validDate(initialDate) || typeof createSession !== 'function') throw new TypeError('Invalid chat session');
  const sessions = new Map();
  let currentDate = initialDate;
  return {
    switchDate(nextDate, snapshot, { busy = false } = {}) {
      if (busy || !validDate(nextDate)) return { accepted: false, changed: false, date: currentDate };
      if (nextDate === currentDate) return { accepted: true, changed: false, date: currentDate };
      sessions.set(currentDate, snapshot);
      if (!sessions.has(nextDate)) sessions.set(nextDate, createSession(nextDate));
      currentDate = nextDate;
      return { accepted: true, changed: true, date: currentDate, session: sessions.get(currentDate) };
    }
  };
}
