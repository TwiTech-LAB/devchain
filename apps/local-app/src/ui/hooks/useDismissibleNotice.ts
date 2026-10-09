import { useCallback, useSyncExternalStore } from 'react';
import { useRuntime } from './useRuntime';

interface NoticeState {
  closedBootId?: string;
  acknowledgedKeys?: string[];
  closedForPage?: boolean;
}

const emptyState: NoticeState = {};
const noticeStores = new Map<string, ReturnType<typeof createNoticeStore>>();

function createNoticeStore(storageKey: string) {
  let state: NoticeState = emptyState;
  const listeners = new Set<() => void>();
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    if (parsed && typeof parsed === 'object') {
      const fields = parsed as Record<string, unknown>;
      state = {
        closedBootId: typeof fields.closedBootId === 'string' ? fields.closedBootId : undefined,
        acknowledgedKeys:
          Array.isArray(fields.acknowledgedKeys) &&
          fields.acknowledgedKeys.every((key) => typeof key === 'string')
            ? fields.acknowledgedKeys
            : undefined,
      };
    }
  } catch {
    // Browser storage can be unavailable; this store survives route remounts.
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (changes: Partial<NoticeState>) => {
      state = { ...state, ...changes };
      try {
        const { closedBootId, acknowledgedKeys } = state;
        localStorage.setItem(storageKey, JSON.stringify({ closedBootId, acknowledgedKeys }));
      } catch {
        // The in-memory snapshot remains authoritative for this page lifetime.
      }
      listeners.forEach((listener) => listener());
    },
  };
}

function getNoticeStore(noticeId: string) {
  const storageKey = `devchain.notice.${noticeId}`;
  if (typeof window === 'undefined') return createNoticeStore(storageKey);
  let store = noticeStores.get(storageKey);
  if (!store) {
    store = createNoticeStore(storageKey);
    noticeStores.set(storageKey, store);
  }
  return store;
}

export function useDismissibleNotice({
  noticeId,
  itemKeys,
}: {
  noticeId: string;
  itemKeys: readonly string[];
}) {
  const { runtimeInfo, runtimeLoading, runtimeError } = useRuntime();
  const bootId = runtimeError ? undefined : runtimeInfo?.bootId;
  // In the browser `getNoticeStore` caches one store per notice id, so the reference is stable.
  const store = getNoticeStore(noticeId);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, () => emptyState);

  const closeUntilRestart = useCallback(() => {
    store.update(bootId ? { closedBootId: bootId } : { closedForPage: true });
  }, [store, bootId]);
  const dismissUntilNewItems = useCallback(() => {
    store.update({ acknowledgedKeys: [...new Set(itemKeys)] });
  }, [store, itemKeys]);

  const visible =
    !runtimeLoading &&
    !state.closedForPage &&
    !(bootId && state.closedBootId === bootId) &&
    itemKeys.some((key) => !state.acknowledgedKeys?.includes(key));

  return { visible, closeUntilRestart, dismissUntilNewItems };
}
