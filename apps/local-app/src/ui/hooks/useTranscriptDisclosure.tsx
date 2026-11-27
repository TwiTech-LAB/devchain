import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

/** Open keys of one scope. Each block subscribes to its own key, so a toggle re-renders only it. */
interface DisclosureStore {
  has: (key: string) => boolean;
  set: (key: string, open: boolean) => void;
  subscribe: (listener: () => void) => () => void;
}

function createDisclosureStore(): DisclosureStore {
  const openKeys = new Set<string>();
  const listeners = new Set<() => void>();
  return {
    has: (key) => openKeys.has(key),
    set: (key, open) => {
      if (openKeys.has(key) === open) return;
      if (open) openKeys.add(key);
      else openKeys.delete(key);
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

interface TranscriptDisclosureContextValue {
  store: DisclosureStore;
  readerResize?: (rowId: string | null) => void;
}

const TranscriptDisclosureContext = createContext<TranscriptDisclosureContextValue | null>(null);

/** The id of the virtualized row a block renders in; null outside a row. */
export const TranscriptRowContext = createContext<string | null>(null);

const subscribeToNothing = () => () => {};

/**
 * Keeps transcript expand/collapse state above the virtualized rows, so a block
 * stays open after its row unmounts and mounts again. All state is dropped when
 * `scope` changes. Keys must be unique across the whole scope.
 */
export function TranscriptDisclosureProvider({
  scope,
  onReaderResize,
  children,
}: {
  scope: string;
  /**
   * Called just before a change the reader asked for resizes a row: a block opens
   * or closes, or the full result it requested replaces its preview.
   */
  onReaderResize?: (rowId: string | null) => void;
  children: React.ReactNode;
}) {
  // A setter captured under an earlier scope writes into that scope's store only.
  const [state, setState] = useState(() => ({ scope, store: createDisclosureStore() }));
  if (state.scope !== scope) {
    setState({ scope, store: createDisclosureStore() });
  }

  const value = useMemo<TranscriptDisclosureContextValue>(
    () => ({ store: state.store, readerResize: onReaderResize }),
    [state.store, onReaderResize],
  );

  return (
    <TranscriptDisclosureContext.Provider value={value}>
      {children}
    </TranscriptDisclosureContext.Provider>
  );
}

/** Without a provider, the state is local to the calling component. */
export function useTranscriptDisclosure(key: string): [boolean, (open: boolean) => void] {
  const context = useContext(TranscriptDisclosureContext);
  const rowId = useContext(TranscriptRowContext);
  const [localOpen, setLocalOpen] = useState(false);
  const store = context?.store;
  const readerResize = context?.readerResize;
  const sharedOpen = useSyncExternalStore(store?.subscribe ?? subscribeToNothing, () =>
    store ? store.has(key) : false,
  );

  const setOpen = useCallback(
    (open: boolean) => {
      if (!store) {
        setLocalOpen(open);
        return;
      }
      readerResize?.(rowId);
      store.set(key, open);
    },
    [store, readerResize, key, rowId],
  );

  return [store ? sharedOpen : localOpen, setOpen];
}

/**
 * Returns a callback that tells the list the reader's own request is about to resize
 * this block's row, such as a full result replacing its preview. A no-op outside a list.
 */
export function useTranscriptReaderResize(): () => void {
  const readerResize = useContext(TranscriptDisclosureContext)?.readerResize;
  const rowId = useContext(TranscriptRowContext);
  return useCallback(() => readerResize?.(rowId), [readerResize, rowId]);
}
