import { useSyncExternalStore } from 'react';

/**
 * A per-session counter for terminal views to use in their React key. A view subscribes once per
 * mount, so a session that restarts on the same ID (a rollback or a Restore) needs a new mount to
 * attach again. The server tells each attached view with a `restarted` state change.
 */
const revisions = new Map<string, number>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function bumpTerminalAttachRevision(sessionId: string): void {
  revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1);
  for (const listener of listeners) listener();
}

export function useTerminalAttachRevision(sessionId: string | null | undefined): number {
  return useSyncExternalStore(subscribe, () => (sessionId ? (revisions.get(sessionId) ?? 0) : 0));
}
