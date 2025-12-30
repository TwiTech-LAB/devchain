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

const STORAGE_KEY = 'devchain:terminalWindows';

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PersistedLayout extends WindowBounds {
  maximized: boolean;
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
      return parsed;
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
  const persisted = useMemo(() => readPersistedState(), []);
  const [zCounter, setZCounter] = useState<number>(persisted?.zCounter ?? 1000);
  const zCounterRef = useRef(zCounter);
  const [layoutCache, setLayoutCache] = useState<Record<string, PersistedLayout>>(
    persisted?.layouts ?? {},
  );
  const layoutCacheRef = useRef(layoutCache);
  const [windows, setWindows] = useState<TerminalWindowState[]>([]);
  const [focusedWindowId, setFocusedWindowId] = useState<string | null>(null);

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
    let nextValue = zCounterRef.current + 1;
    setZCounter((prev) => {
      nextValue = prev + 1;
      return nextValue;
    });
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
      const nextLayout: PersistedLayout = {
        maximized: layout.maximized ?? prev[id]?.maximized ?? false,
        x: layout.x ?? prev[id]?.x ?? DEFAULT_BOUNDS.x,
        y: layout.y ?? prev[id]?.y ?? DEFAULT_BOUNDS.y,
        width: layout.width ?? prev[id]?.width ?? DEFAULT_BOUNDS.width,
        height: layout.height ?? prev[id]?.height ?? DEFAULT_BOUNDS.height,
      };

      return {
        ...prev,
        [id]: nextLayout,
      };
    });
  }, []);

  const openWindow = useCallback(
    (config: TerminalWindowConfig) => {
      const layout = layoutCacheRef.current[config.id];
      const initialBounds = computeInitialBounds(layout ?? config.initialBounds);
      setWindows((prev) => {
        const existing = prev.find((window) => window.id === config.id);
        const nextZ = bumpZCounter();

        if (existing) {
          return prev.map((window) =>
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
          );
        }

        return [
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
        ];
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
      setWindows((prev) =>
        prev.map((window) =>
          window.id === id
            ? {
                ...window,
                minimized: false,
              }
            : window,
        ),
      );
      focusWindow(id);
    },
    [focusWindow],
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
      let nextLayout: PersistedLayout | null = null;
      let resizeCallback: (() => void) | undefined;

      setWindows((prev) =>
        prev.map((window) => {
          if (window.id !== id) {
            return window;
          }

          const nextBounds: WindowBounds = {
            x: bounds.x,
            y: bounds.y,
            width: Math.max(bounds.width, MIN_WIDTH),
            height: Math.max(bounds.height, MIN_HEIGHT),
          };

          resizeCallback = window.handle?.fit;

          nextLayout = {
            ...nextBounds,
            maximized: window.maximized,
          };

          return {
            ...window,
            bounds: nextBounds,
            restoredBounds: window.maximized ? window.restoredBounds : nextBounds,
          };
        }),
      );

      if (nextLayout) {
        updateLayoutCache(id, nextLayout);
      }

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
      setWindows((prev) =>
        prev.map((window) =>
          window.id === id
            ? {
                ...window,
                title: meta.title ?? window.title,
                subtitle: meta.subtitle ?? window.subtitle,
                menuItems: meta.menuItems ?? window.menuItems,
                details: meta.details ?? window.details,
                sessionId: meta.sessionId ?? window.sessionId,
              }
            : window,
        ),
      );
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
