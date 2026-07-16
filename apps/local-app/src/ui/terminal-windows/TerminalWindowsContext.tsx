import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { TerminalHandle } from '@/ui/components/Terminal';
import { useToastHelpers } from '@/ui/lib/toast-helpers';

const STORAGE_KEY = 'devchain:terminalWindows';

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PersistedLayout extends WindowBounds {
  maximized: boolean;
  lastUsedAt?: number;
}

interface PersistedState {
  zCounter: number;
  layouts: Record<string, PersistedLayout>;
}

export interface TerminalWindowDetail {
  label: string;
  value: string;
  title?: string;
  hidden?: boolean;
  interactive?: boolean;
  sessionId?: string;
  isRenaming?: boolean;
  draftName?: string;
  renameInputRef?: React.RefObject<HTMLInputElement | null>;
  onRenameStart?: () => void;
  onDraftChange?: (value: string) => void;
  onRenameKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onRenameBlur?: () => void;
  onCopyId?: () => void;
  copiedId?: boolean;
}

export interface TerminalWindowConfig {
  id: string;
  title: string;
  content: ReactNode;
  sessionId?: string;
  initialBounds?: Partial<WindowBounds>;
  subtitle?: string;
  menuItems?: TerminalWindowMenuItem[];
  details?: TerminalWindowDetail[];
}

export interface TerminalWindowState {
  id: string;
  title: string;
  sessionId?: string;
  subtitle?: string;
  menuItems?: TerminalWindowMenuItem[];
  details?: TerminalWindowDetail[];
  minimized: boolean;
  maximized: boolean;
  zIndex: number;
  bounds: WindowBounds;
  restoredBounds?: WindowBounds;
  content: ReactNode;
  handle?: TerminalHandle;
  autoMinimizedAt?: number;
}

export interface TerminalWindowMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  tone?: 'default' | 'destructive';
  disabled?: boolean;
  shortcut?: string;
}

interface TerminalWindowsContextValue {
  windows: TerminalWindowState[];
  focusedWindowId: string | null;
  openWindow: (config: TerminalWindowConfig) => void;
  closeWindow: (id: string) => void;
  focusWindow: (id: string) => void;
  minimizeWindow: (id: string) => void;
  restoreWindow: (id: string) => void;
  toggleMaximizeWindow: (id: string) => void;
  updateWindowBounds: (id: string, bounds: WindowBounds) => void;
  updateWindowContent: (id: string, content: ReactNode) => void;
  updateWindowMeta: (
    id: string,
    meta: Partial<
      Pick<TerminalWindowState, 'title' | 'subtitle' | 'menuItems' | 'details' | 'sessionId'>
    >,
  ) => void;
  setWindowHandle: (id: string, handle: TerminalHandle | null) => void;
}

const TerminalWindowsContext = createContext<TerminalWindowsContextValue | undefined>(undefined);

const DEFAULT_BOUNDS: WindowBounds = {
  width: 1440,
  height: 840,
  x: 120,
  y: 96,
};

const MIN_WIDTH = 480;
const MIN_HEIGHT = 280;
export const MAX_PERSISTED_TERMINAL_LAYOUTS = 50;
// Five supports a primary session plus several worktree sessions while bounding costly xterm trees.
export const MAX_MOUNTED_TERMINAL_WINDOWS = 5;
const MAX_PERSISTED_LAYOUT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function enforceMountedWindowCap(
  windows: TerminalWindowState[],
  activatedWindowId: string,
  activationSequence: number,
): TerminalWindowState[] {
  const mountedWindows = windows.filter((window) => !window.minimized);
  if (mountedWindows.length <= MAX_MOUNTED_TERMINAL_WINDOWS) {
    return windows;
  }

  const leastRecentlyFocused = mountedWindows
    .filter((window) => window.id !== activatedWindowId)
    .reduce<TerminalWindowState | null>(
      (oldest, window) => (!oldest || window.zIndex < oldest.zIndex ? window : oldest),
      null,
    );

  if (!leastRecentlyFocused) {
    return windows;
  }

  return windows.map((window) =>
    window.id === leastRecentlyFocused.id
      ? { ...window, minimized: true, autoMinimizedAt: activationSequence }
      : window,
  );
}

function pruneLayoutCache(
  layouts: Record<string, PersistedLayout>,
  now = Date.now(),
): Record<string, PersistedLayout> {
  return Object.fromEntries(
    Object.entries(layouts)
      .map(([id, layout]) => [id, { ...layout, lastUsedAt: layout.lastUsedAt ?? now }] as const)
      .filter(([, layout]) => now - layout.lastUsedAt! <= MAX_PERSISTED_LAYOUT_AGE_MS)
      .sort(([, left], [, right]) => right.lastUsedAt! - left.lastUsedAt!)
      .slice(0, MAX_PERSISTED_TERMINAL_LAYOUTS),
  );
}

function readPersistedState(): PersistedState | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as PersistedState;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.zCounter === 'number' &&
      parsed.layouts &&
      typeof parsed.layouts === 'object'
    ) {
      return { ...parsed, layouts: pruneLayoutCache(parsed.layouts) };
    }
  } catch {
    return null;
  }

  return null;
}

function computeInitialBounds(existing?: Partial<WindowBounds>): WindowBounds {
  if (typeof window === 'undefined') {
    return {
      width: existing?.width ?? DEFAULT_BOUNDS.width,
      height: existing?.height ?? DEFAULT_BOUNDS.height,
      x: existing?.x ?? DEFAULT_BOUNDS.x,
      y: existing?.y ?? DEFAULT_BOUNDS.y,
    };
  }

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(
    Math.max(existing?.width ?? DEFAULT_BOUNDS.width, MIN_WIDTH),
    viewportWidth - 48,
  );
  const height = Math.min(
    Math.max(existing?.height ?? DEFAULT_BOUNDS.height, MIN_HEIGHT),
    viewportHeight - 96,
  );
  const x = existing?.x ?? Math.max(24, Math.round((viewportWidth - width) / 2));
  const y = existing?.y ?? Math.max(48, Math.round((viewportHeight - height) / 2));

  return {
    width,
    height,
    x,
    y,
  };
}

export function TerminalWindowsProvider({ children }: { children: ReactNode }) {
  const { toast } = useToastHelpers();
  const persisted = useMemo(() => readPersistedState(), []);
  const [zCounter, setZCounter] = useState<number>(persisted?.zCounter ?? 1000);
  const zCounterRef = useRef(zCounter);
  const [layoutCache, setLayoutCache] = useState<Record<string, PersistedLayout>>(
    persisted?.layouts ?? {},
  );
  const layoutCacheRef = useRef(layoutCache);
  const [windows, setWindows] = useState<TerminalWindowState[]>([]);
  const [focusedWindowId, setFocusedWindowId] = useState<string | null>(null);
  const lastAutoMinimizeNoticeRef = useRef(0);

  useEffect(() => {
    const autoMinimizedWindow = windows.reduce<TerminalWindowState | null>((latest, window) => {
      if (!window.autoMinimizedAt) return latest;
      return !latest || window.autoMinimizedAt > (latest.autoMinimizedAt ?? 0) ? window : latest;
    }, null);
    if (
      !autoMinimizedWindow?.autoMinimizedAt ||
      autoMinimizedWindow.autoMinimizedAt <= lastAutoMinimizeNoticeRef.current
    ) {
      return;
    }

    lastAutoMinimizeNoticeRef.current = autoMinimizedWindow.autoMinimizedAt;
    toast({
      title: 'Terminal window minimized',
      description: `${autoMinimizedWindow.title} was minimized to keep at most ${MAX_MOUNTED_TERMINAL_WINDOWS} terminal windows active.`,
    });
  }, [toast, windows]);

  useEffect(() => {
    zCounterRef.current = zCounter;
  }, [zCounter]);

  useEffect(() => {
    layoutCacheRef.current = layoutCache;
  }, [layoutCache]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const payload: PersistedState = {
      zCounter: zCounterRef.current,
      layouts: layoutCacheRef.current,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [layoutCache, zCounter]);

  const bumpZCounter = useCallback(() => {
    const nextValue = zCounterRef.current + 1;
    zCounterRef.current = nextValue;
    setZCounter(nextValue);
    return nextValue;
  }, []);

  const focusWindow = useCallback(
    (id: string) => {
      setFocusedWindowId(id);
      const nextZ = bumpZCounter();
      setWindows((prev) =>
        prev.map((window) =>
          window.id === id
            ? {
                ...window,
                zIndex: nextZ,
              }
            : window,
        ),
      );
    },
    [bumpZCounter],
  );

  const updateLayoutCache = useCallback((id: string, layout: Partial<PersistedLayout>) => {
    setLayoutCache((prev) => {
      const newestTimestamp = Math.max(
        0,
        ...Object.values(prev).map((entry) => entry.lastUsedAt ?? 0),
      );
      const nextLayout: PersistedLayout = {
        maximized: layout.maximized ?? prev[id]?.maximized ?? false,
        x: layout.x ?? prev[id]?.x ?? DEFAULT_BOUNDS.x,
        y: layout.y ?? prev[id]?.y ?? DEFAULT_BOUNDS.y,
        width: layout.width ?? prev[id]?.width ?? DEFAULT_BOUNDS.width,
        height: layout.height ?? prev[id]?.height ?? DEFAULT_BOUNDS.height,
        lastUsedAt: Math.max(Date.now(), newestTimestamp + 1),
      };

      return pruneLayoutCache({
        ...prev,
        [id]: nextLayout,
      });
    });
  }, []);

  const openWindow = useCallback(
    (config: TerminalWindowConfig) => {
      const layout = layoutCacheRef.current[config.id];
      const initialBounds = computeInitialBounds(layout ?? config.initialBounds);
      const nextZ = bumpZCounter();
      setWindows((prev) => {
        const existing = prev.find((window) => window.id === config.id);

        if (existing) {
          return enforceMountedWindowCap(
            prev.map((window) =>
              window.id === config.id
                ? {
                    ...window,
                    title: config.title,
                    subtitle: config.subtitle ?? window.subtitle,
                    menuItems: config.menuItems ?? window.menuItems,
                    details: config.details ?? window.details,
                    content: config.content,
                    minimized: false,
                    maximized: layout?.maximized ?? window.maximized,
                    bounds: window.maximized
                      ? window.bounds
                      : layout
                        ? {
                            width: layout.width,
                            height: layout.height,
                            x: layout.x,
                            y: layout.y,
                          }
                        : window.bounds,
                    zIndex: nextZ,
                  }
                : window,
            ),
            config.id,
            nextZ,
          );
        }

        return enforceMountedWindowCap(
          [
            ...prev,
            {
              id: config.id,
              sessionId: config.sessionId,
              title: config.title,
              subtitle: config.subtitle,
              menuItems: config.menuItems,
              details: config.details,
              minimized: false,
              maximized: layout?.maximized ?? false,
              zIndex: nextZ,
              bounds: layout
                ? {
                    width: layout.width,
                    height: layout.height,
                    x: layout.x,
                    y: layout.y,
                  }
                : initialBounds,
              restoredBounds: layout
                ? {
                    width: layout.width,
                    height: layout.height,
                    x: layout.x,
                    y: layout.y,
                  }
                : initialBounds,
              content: config.content,
            },
          ],
          config.id,
          nextZ,
        );
      });

      const layoutToPersist = layout ?? {
        ...initialBounds,
        maximized: false,
      };
      updateLayoutCache(config.id, layoutToPersist);
      setFocusedWindowId(config.id);
    },
    [bumpZCounter, updateLayoutCache],
  );

  const closeWindow = useCallback(
    (id: string) => {
      setWindows((prev) => {
        const filtered = prev.filter((window) => window.id !== id);
        if (filtered.length === prev.length) {
          return prev;
        }
        if (focusedWindowId === id) {
          const nextFocused = filtered.reduce<TerminalWindowState | null>((acc, window) => {
            if (!acc || window.zIndex > acc.zIndex) {
              return window;
            }
            return acc;
          }, null);
          setFocusedWindowId(nextFocused?.id ?? null);
        }
        return filtered;
      });
    },
    [focusedWindowId],
  );

  const minimizeWindow = useCallback((id: string) => {
    setWindows((prev) =>
      prev.map((window) =>
        window.id === id
          ? {
              ...window,
              minimized: true,
            }
          : window,
      ),
    );
    setFocusedWindowId((current) => (current === id ? null : current));
  }, []);

  const restoreWindow = useCallback(
    (id: string) => {
      const nextZ = bumpZCounter();
      setWindows((prev) =>
        enforceMountedWindowCap(
          prev.map((window) =>
            window.id === id
              ? {
                  ...window,
                  minimized: false,
                  zIndex: nextZ,
                }
              : window,
          ),
          id,
          nextZ,
        ),
      );
      setFocusedWindowId(id);
    },
    [bumpZCounter],
  );

  const toggleMaximizeWindow = useCallback(
    (id: string) => {
      let nextLayout: PersistedLayout | null = null;

      setWindows((prev) =>
        prev.map((window) => {
          if (window.id !== id) {
            return window;
          }

          if (window.maximized) {
            const restoredBounds = window.restoredBounds ?? window.bounds;
            nextLayout = {
              ...restoredBounds,
              maximized: false,
            };
            return {
              ...window,
              maximized: false,
              bounds: restoredBounds,
            };
          }

          const currentBounds = window.bounds;
          nextLayout = {
            ...currentBounds,
            maximized: true,
          };

          return {
            ...window,
            maximized: true,
            restoredBounds: currentBounds,
          };
        }),
      );

      if (nextLayout) {
        updateLayoutCache(id, nextLayout);
      }
      focusWindow(id);
    },
    [focusWindow, updateLayoutCache],
  );

  const updateWindowBounds = useCallback(
    (id: string, bounds: WindowBounds) => {
      let resizeCallback: (() => void) | undefined;
      const nextBounds: WindowBounds = {
        x: bounds.x,
        y: bounds.y,
        width: Math.max(bounds.width, MIN_WIDTH),
        height: Math.max(bounds.height, MIN_HEIGHT),
      };

      setWindows((prev) =>
        prev.map((window) => {
          if (window.id !== id) {
            return window;
          }

          resizeCallback = window.handle?.fit;

          return {
            ...window,
            bounds: nextBounds,
            restoredBounds: window.maximized ? window.restoredBounds : nextBounds,
          };
        }),
      );

      updateLayoutCache(id, {
        ...nextBounds,
        maximized: layoutCacheRef.current[id]?.maximized ?? false,
      });

      resizeCallback?.();
    },
    [updateLayoutCache],
  );

  const updateWindowContent = useCallback((id: string, content: ReactNode) => {
    setWindows((prev) =>
      prev.map((window) =>
        window.id === id
          ? {
              ...window,
              content,
            }
          : window,
      ),
    );
  }, []);

  const updateWindowMeta = useCallback(
    (
      id: string,
      meta: Partial<
        Pick<TerminalWindowState, 'title' | 'subtitle' | 'menuItems' | 'details' | 'sessionId'>
      >,
    ) => {
      if (!meta.title && !meta.subtitle && !meta.menuItems && !meta.details && !meta.sessionId) {
        return;
      }
      setWindows((prev) => {
        const idx = prev.findIndex((w) => w.id === id);
        if (idx === -1) return prev;
        const w = prev[idx];
        const nextTitle = meta.title ?? w.title;
        const nextSubtitle = meta.subtitle ?? w.subtitle;
        const nextMenuItems = meta.menuItems ?? w.menuItems;
        const nextDetails = meta.details ?? w.details;
        const nextSessionId = meta.sessionId ?? w.sessionId;
        if (
          nextTitle === w.title &&
          nextSubtitle === w.subtitle &&
          nextMenuItems === w.menuItems &&
          nextDetails === w.details &&
          nextSessionId === w.sessionId
        ) {
          return prev;
        }
        const next = [...prev];
        next[idx] = {
          ...w,
          title: nextTitle,
          subtitle: nextSubtitle,
          menuItems: nextMenuItems,
          details: nextDetails,
          sessionId: nextSessionId,
        };
        return next;
      });
    },
    [],
  );

  const setWindowHandle = useCallback((id: string, handle: TerminalHandle | null) => {
    setWindows((prev) =>
      prev.map((window) => {
        if (window.id !== id) {
          return window;
        }
        if (window.handle === handle) {
          return window;
        }
        return {
          ...window,
          handle: handle ?? undefined,
        };
      }),
    );
  }, []);

  const value = useMemo<TerminalWindowsContextValue>(
    () => ({
      windows,
      focusedWindowId,
      openWindow,
      closeWindow,
      focusWindow,
      minimizeWindow,
      restoreWindow,
      toggleMaximizeWindow,
      updateWindowBounds,
      updateWindowContent,
      updateWindowMeta,
      setWindowHandle,
    }),
    [
      windows,
      focusedWindowId,
      openWindow,
      closeWindow,
      focusWindow,
      minimizeWindow,
      restoreWindow,
      toggleMaximizeWindow,
      updateWindowBounds,
      updateWindowContent,
      updateWindowMeta,
      setWindowHandle,
    ],
  );

  return (
    <TerminalWindowsContext.Provider value={value}>{children}</TerminalWindowsContext.Provider>
  );
}

export function useTerminalWindows() {
  const context = useContext(TerminalWindowsContext);
  if (!context) {
    throw new Error('useTerminalWindows must be used within a TerminalWindowsProvider');
  }
  return context;
}
