/**
 * Sessions with a rollback in progress in this browser tab. A rollback stops the row before it
 * copies the save point, so a list of running sessions from that time omits the session. Views
 * that close a terminal for a session missing from such a list skip a held session, then check a
 * fresh list when the hold ends.
 */
const holds = new Map<string, number>();
const releaseListeners = new Set<(sessionId: string) => void>();

/** Holds the session until the returned function runs. A second call is a no-op. */
export function holdRollback(sessionId: string): () => void {
  holds.set(sessionId, (holds.get(sessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (holds.get(sessionId) ?? 1) - 1;
    if (count > 0) {
      holds.set(sessionId, count);
      return;
    }
    holds.delete(sessionId);
    for (const listener of releaseListeners) listener(sessionId);
  };
}

export function isRollbackHeld(sessionId: string): boolean {
  return holds.has(sessionId);
}

/** Calls `listener` each time the last hold of a session ends. */
export function onRollbackHoldReleased(listener: (sessionId: string) => void): () => void {
  releaseListeners.add(listener);
  return () => releaseListeners.delete(listener);
}
