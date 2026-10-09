import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { fetchRuntimeInfo, type RuntimeInfo } from '@/ui/lib/runtime';
import { useHomeSocket } from './useHomeSocket';

export interface RuntimeContextValue {
  runtimeInfo: RuntimeInfo | undefined;
  runtimeLoading: boolean;
  runtimeError: boolean;
  cloudUiEnabled: boolean;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export const runtimeInfoQueryKey = ['runtime-info'] as const;

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const {
    data: runtimeInfo,
    isLoading: runtimeLoading,
    isError: runtimeError,
  } = useQuery({
    queryKey: runtimeInfoQueryKey,
    queryFn: fetchRuntimeInfo,
    staleTime: Infinity,
  });

  const value = useMemo<RuntimeContextValue>(
    () => ({
      runtimeInfo,
      runtimeLoading,
      runtimeError,
      cloudUiEnabled: runtimeInfo?.features?.cloudUi === true,
    }),
    [runtimeInfo, runtimeLoading, runtimeError],
  );

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useRuntimeSync(): void {
  // Layout mounts this under BackendBoundary; the runtime query lives in the home cache.
  const queryClient = useHomeQueryClient();
  const disconnectedAtRef = useRef(0);
  const markDisconnected = useCallback(() => {
    disconnectedAtRef.current = Date.now();
  }, []);
  // A new boot ID only arrives across a disconnect. A remote browser's first handshake lands
  // after RuntimeProvider's own fetch, so refetch only when the cached info predates the
  // last disconnect; that skips a second request and a route-tree re-render on page load.
  const refreshRuntime = useCallback(() => {
    const fetchedAt = queryClient.getQueryState(runtimeInfoQueryKey)?.dataUpdatedAt ?? 0;
    if (fetchedAt > disconnectedAtRef.current) return;
    void queryClient.invalidateQueries({ queryKey: runtimeInfoQueryKey });
  }, [queryClient]);

  const socket = useHomeSocket({ connect: refreshRuntime, disconnect: markDisconnected }, [
    refreshRuntime,
    markDisconnected,
  ]);
  useEffect(() => {
    // Not connected at mount means a handshake or an outage is in progress: count it as one.
    if (!socket.connected) markDisconnected();
  }, [socket, markDisconnected]);
}

export function useRuntime(): RuntimeContextValue {
  const context = useContext(RuntimeContext);
  if (!context) {
    throw new Error('useRuntime must be used within RuntimeProvider');
  }
  return context;
}
