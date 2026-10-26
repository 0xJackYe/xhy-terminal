/** Accept a newer server snapshot only while the page is still safe to refresh. */
export function createSnapshotRefresh({ read, apply, getRevision, isSafe } = {}) {
  let pending = false;
  return async function refresh() {
    if (pending || !isSafe()) return false;
    pending = true;
    const before = getRevision();
    try {
      const snapshot = await read();
      // A meal edit or AI response may have started while the GET was in flight.
      if (!isSafe() || getRevision() !== before || !Number.isSafeInteger(snapshot.revision) || snapshot.revision <= before) return false;
      await apply(snapshot);
      return true;
    } finally { pending = false; }
  };
}
