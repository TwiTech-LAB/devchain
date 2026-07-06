import { useCallback, useMemo, useState } from 'react';
import { SessionApiError } from '@/ui/lib/sessions';

/**
 * Lifecycle thin core (Seam 1). Owns ONLY the parts that are verified-identical
 * across the three session consumers (chat sidebar, agents page, worktree chat
 * controls): the pending-action tracker, SessionApiError classification, and the
 * plain-async operation skeleton. Every divergence between the consumers lives in
 * a typed adapter method, never here — see `docs/ui-session-lifecycle-matrix.md`.
 */

export type LifecycleAction = 'launching' | 'restarting' | 'terminating';

// ============================================
// SessionApiError classification
// ============================================

/** True when the backend rejected the launch/restart because MCP is not configured. */
export function isMcpNotConfigured(error: unknown): error is SessionApiError {
  return error instanceof SessionApiError && error.hasCode('MCP_NOT_CONFIGURED');
}

/**
 * Provider fields carried on an MCP_NOT_CONFIGURED error. Values are only present
 * when the payload actually carried a string — callers apply their own defaults
 * (chat/agents → `'Unknown'`/`''`; worktree → leave undefined).
 */
export function getMcpProviderDetails(error: unknown): {
  providerId?: string;
  providerName?: string;
} {
  const details = error instanceof SessionApiError ? error.payload?.details : undefined;
  return {
    providerId: typeof details?.providerId === 'string' ? details.providerId : undefined,
    providerName: typeof details?.providerName === 'string' ? details.providerName : undefined,
  };
}

/**
 * Toast title for a failed restore, mapping the 409 conflict codes to their
 * specific copy and falling back to the generic title otherwise. Locked by the
 * restore rows of the lifecycle matrix.
 */
export function restoreConflictTitle(error: unknown): string {
  if (error instanceof SessionApiError && error.status === 409) {
    if (error.hasCode('PROVIDER_MISMATCH')) return 'Provider mismatch';
    if (error.hasCode('NO_PROVIDER_SESSION_ID')) return 'Cannot restore';
    if (error.hasCode('INVALID_SESSION_STATE')) return 'Invalid session state';
  }
  return 'Restore failed';
}

// ============================================
// Pending-action tracker
// ============================================

export interface LifecyclePendingTracker {
  /** Raw composite-key → action map (worktree consumes this shape directly). */
  actions: Record<string, LifecycleAction>;
  setAction: (key: string, action: LifecycleAction | null) => void;
  clear: (key: string) => void;
  actionFor: (key: string) => LifecycleAction | undefined;
  /** Projection: `{ key: true }` for every key currently in one of `actions`. */
  recordOf: (...actions: LifecycleAction[]) => Record<string, boolean>;
  /** Projection: the single key currently in `action`, or null (for `string|null` surfaces). */
  singleKeyOf: (action: LifecycleAction) => string | null;
}

/**
 * The unified pending tracker. A single `Record<compositeKey, action>` backs every
 * consumer's pending surface via `recordOf` / `singleKeyOf` projections, so the
 * three hooks no longer each hand-roll their own launching/restarting/terminating
 * state.
 */
export function useLifecyclePendingTracker(): LifecyclePendingTracker {
  const [actions, setActions] = useState<Record<string, LifecycleAction>>({});

  const setAction = useCallback((key: string, action: LifecycleAction | null) => {
    setActions((prev) => {
      if (!action) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      if (prev[key] === action) return prev;
      return { ...prev, [key]: action };
    });
  }, []);

  const clear = useCallback((key: string) => setAction(key, null), [setAction]);

  return useMemo(() => {
    const actionFor = (key: string) => actions[key];
    const recordOf = (...wanted: LifecycleAction[]) => {
      const record: Record<string, boolean> = {};
      for (const [key, action] of Object.entries(actions)) {
        if (wanted.includes(action)) record[key] = true;
      }
      return record;
    };
    const singleKeyOf = (action: LifecycleAction) => {
      for (const [key, current] of Object.entries(actions)) {
        if (current === action) return key;
      }
      return null;
    };
    return { actions, setAction, clear, actionFor, recordOf, singleKeyOf };
  }, [actions, setAction, clear]);
}

// ============================================
// Operation skeleton (plain-async consumers)
// ============================================

/**
 * The guard → set-pending → run → outcome → clear-pending skeleton shared by the
 * plain-async consumers (chat, worktree). The caller runs its own guard BEFORE
 * calling this; `run` performs the fetch plus success side effects and returns the
 * result; `onError` performs the adapter's error dispatch (including any MCP
 * branch). The pending action is always cleared in `finally`.
 */
export async function runTrackedOperation<T>(
  tracker: LifecyclePendingTracker,
  key: string,
  action: LifecycleAction,
  handlers: { run: () => Promise<T>; onError: (error: unknown) => void },
): Promise<T | null> {
  tracker.setAction(key, action);
  try {
    return await handlers.run();
  } catch (error) {
    handlers.onError(error);
    return null;
  } finally {
    tracker.clear(key);
  }
}
