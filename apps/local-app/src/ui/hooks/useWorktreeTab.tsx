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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listWorktrees } from '@/modules/orchestrator/ui/app/lib/worktrees';
import {
  installWorktreeFetchInterceptor,
  MAIN_INSTANCE_API_PREFIXES,
} from '@/ui/lib/worktree-fetch-interceptor';
import { getAppSocket, releaseAppSocket, type WsEnvelope } from '@/ui/lib/socket';

const WORKTREE_QUERY_PARAM = 'wt';
const WORKTREE_TAB_REFRESH_MS = 15_000;

export interface ActiveWorktreeTab {
  id: string;
  name: string;
  devchainProjectId: string | null;
  status: string;
}

export interface WorktreeTabContextValue {
  activeWorktree: ActiveWorktreeTab | null;
  setActiveWorktree: (worktree: ActiveWorktreeTab | null) => void;
  apiBase: string;
  worktrees: ActiveWorktreeTab[];
  worktreesLoading: boolean;
}

const WorktreeTabContext = createContext<WorktreeTabContextValue | null>(null);
const noopSetActiveWorktree = () => undefined;
const fallbackWorktreeTabContext: WorktreeTabContextValue = {
  activeWorktree: null,
  setActiveWorktree: noopSetActiveWorktree,
  apiBase: '',
  worktrees: [],
  worktreesLoading: false,
};

function readWorktreeNameFromUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const value = new URLSearchParams(window.location.search).get(WORKTREE_QUERY_PARAM);
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}

function persistWorktreeNameToUrl(worktreeName: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }

  const nextUrl = new URL(window.location.href);
  if (worktreeName) {
    nextUrl.searchParams.set(WORKTREE_QUERY_PARAM, worktreeName);
  } else {
    nextUrl.searchParams.delete(WORKTREE_QUERY_PARAM);
  }
  window.history.replaceState(
    window.history.state,
    '',
    `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
  );
}

async function detectMainMode(): Promise<boolean> {
  const response = await fetch('/api/runtime', {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    return false;
  }

  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  return (payload as { mode?: unknown }).mode === 'main';
}

export function WorktreeTabProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [isMainMode, setIsMainMode] = useState(false);
  const [runtimeResolved, setRuntimeResolved] = useState(false);
  const [activeWorktreeName, setActiveWorktreeName] = useState<string | null>(() =>
    readWorktreeNameFromUrl(),
  );
  const {
    data: worktreeSummaries = [],
    isLoading: worktreesLoading,
    isError: worktreesError,
    isFetched: worktreesFetched,
  } = useQuery({
    queryKey: ['worktree-tabs-worktrees'],
    queryFn: () => listWorktrees(),
    enabled: isMainMode,
    refetchInterval: isMainMode ? WORKTREE_TAB_REFRESH_MS : false,
    refetchOnWindowFocus: true,
  });
  const worktrees = useMemo<ActiveWorktreeTab[]>(
    () =>
      worktreeSummaries.map((worktree) => ({
        id: worktree.id,
        name: worktree.name,
        devchainProjectId: worktree.devchainProjectId ?? null,
        status: worktree.status,
      })),
    [worktreeSummaries],
  );

  const activeWorktree = useMemo<ActiveWorktreeTab | null>(() => {
    if (!isMainMode || !activeWorktreeName) {
      return null;
    }
    return worktrees.find((worktree) => worktree.name === activeWorktreeName) ?? null;
  }, [activeWorktreeName, isMainMode, worktrees]);

  const apiBase = useMemo(() => {
    if (!isMainMode || !activeWorktreeName) {
      return '';
    }
    return `/wt/${encodeURIComponent(activeWorktreeName)}`;
  }, [activeWorktreeName, isMainMode]);
  const tabCacheScope = useMemo(() => {
    if (!runtimeResolved) {
      return null;
    }
    if (!isMainMode) {
      return 'normal';
    }
    return activeWorktreeName ? `worktree:${activeWorktreeName}` : 'main';
  }, [activeWorktreeName, isMainMode, runtimeResolved]);
  const previousTabCacheScopeRef = useRef<string | null>(null);

  const apiBaseRef = useRef(apiBase);
  useEffect(() => {
    apiBaseRef.current = apiBase;
  }, [apiBase]);

  useEffect(() => {
    return installWorktreeFetchInterceptor({
      getApiBase: () => apiBaseRef.current,
      mainInstanceApiPrefixes: MAIN_INSTANCE_API_PREFIXES,
    });
  }, []);

  useEffect(() => {
    if (!tabCacheScope) {
      return;
    }

    const previousScope = previousTabCacheScopeRef.current;
    previousTabCacheScopeRef.current = tabCacheScope;

    const isInitialWorktreeScope = previousScope === null && tabCacheScope.startsWith('worktree:');
    if ((previousScope !== null && previousScope !== tabCacheScope) || isInitialWorktreeScope) {
      // Cancel in-flight projects fetch to prevent cross-scope race
      queryClient.cancelQueries({ queryKey: ['projects'] });

      queryClient.removeQueries({
        predicate: (query) => {
          const key = query.queryKey[0];
          return key !== 'worktree-tabs-worktrees' && key !== 'providers' && key !== 'projects';
        },
      });

      // Invalidate (not remove) projects — keeps cached data visible, triggers background refetch
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    }
  }, [queryClient, tabCacheScope]);

  useEffect(() => {
    let cancelled = false;

    const loadWorktreeContext = async () => {
      let mainMode = false;
      try {
        mainMode = await detectMainMode();
      } catch {
        mainMode = false;
      }

      if (cancelled) {
        return;
      }

      setIsMainMode(mainMode);
      setRuntimeResolved(true);

      if (!mainMode) {
        setActiveWorktreeName(null);
      }
    };

    void loadWorktreeContext();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isMainMode) return;
    const socket = getAppSocket();
    const handler = (envelope: WsEnvelope) => {
      if (envelope.topic === 'worktrees') {
        queryClient.invalidateQueries({ queryKey: ['worktree-tabs-worktrees'] });
        queryClient.invalidateQueries({ queryKey: ['chat-worktree-agent-groups'] });
        queryClient.invalidateQueries({ queryKey: ['orchestrator-worktrees'] });
        queryClient.invalidateQueries({ queryKey: ['orchestrator-worktree-overview'] });
        queryClient.invalidateQueries({ queryKey: ['orchestrator-worktree-activity'] });
      }
    };
    socket.on('message', handler);
    return () => {
      socket.off('message', handler);
      releaseAppSocket();
    };
  }, [isMainMode, queryClient]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const onPopState = () => {
      setActiveWorktreeName(readWorktreeNameFromUrl());
    };

    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  useEffect(() => {
    if (!runtimeResolved) {
      return;
    }

    if (!isMainMode) {
      if (activeWorktreeName !== null) {
        setActiveWorktreeName(null);
      }
      persistWorktreeNameToUrl(null);
      return;
    }

    if (activeWorktreeName === null) {
      persistWorktreeNameToUrl(null);
      return;
    }

    const exists = worktrees.some((worktree) => worktree.name === activeWorktreeName);
    if (!exists && worktreesFetched && !worktreesLoading && !worktreesError) {
      setActiveWorktreeName(null);
      return;
    }

    if (exists) {
      persistWorktreeNameToUrl(activeWorktreeName);
    }
  }, [
    activeWorktreeName,
    isMainMode,
    runtimeResolved,
    worktrees,
    worktreesFetched,
    worktreesLoading,
  ]);

  const setActiveWorktree = useCallback((worktree: ActiveWorktreeTab | null) => {
    setActiveWorktreeName(worktree?.name ?? null);
  }, []);

  const contextValue = useMemo<WorktreeTabContextValue>(
    () => ({
      activeWorktree,
      setActiveWorktree,
      apiBase,
      worktrees,
      worktreesLoading,
    }),
    [activeWorktree, apiBase, setActiveWorktree, worktrees, worktreesLoading],
  );

  return <WorktreeTabContext.Provider value={contextValue}>{children}</WorktreeTabContext.Provider>;
}

export function useWorktreeTab(): WorktreeTabContextValue {
  const context = useContext(WorktreeTabContext);
  if (!context) {
    throw new Error('useWorktreeTab must be used within WorktreeTabProvider');
  }
  return context;
}

export function useOptionalWorktreeTab(): WorktreeTabContextValue {
  return useContext(WorktreeTabContext) ?? fallbackWorktreeTabContext;
}

export function useApiBase(): string {
  return useWorktreeTab().apiBase;
}
