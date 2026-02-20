import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchRuntimeInfo, type RuntimeInfo } from '@/ui/lib/runtime';

export interface RuntimeContextValue {
  runtimeInfo: RuntimeInfo | undefined;
  runtimeLoading: boolean;
  isMainMode: boolean;
  dockerAvailable: boolean;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const { data: runtimeInfo, isLoading: runtimeLoading } = useQuery({
    queryKey: ['runtime-info'],
    queryFn: fetchRuntimeInfo,
    staleTime: Infinity,
  });

  const value = useMemo<RuntimeContextValue>(
    () => ({
      runtimeInfo,
      runtimeLoading,
      isMainMode: runtimeInfo?.mode === 'main',
      dockerAvailable: runtimeInfo?.dockerAvailable === true,
    }),
    [runtimeInfo, runtimeLoading],
  );

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): RuntimeContextValue {
  const context = useContext(RuntimeContext);
  if (!context) {
    throw new Error('useRuntime must be used within RuntimeProvider');
  }
  return context;
}
