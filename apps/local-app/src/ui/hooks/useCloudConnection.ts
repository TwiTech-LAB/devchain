import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { useRealtimeDispatch } from './useRealtimeDispatch';
import { exactTopic } from '../lib/realtime-invalidation-registry';
import type { RealtimeInvalidationRegistry } from '../lib/realtime-invalidation-registry';
import type { CloudConnectionStatus } from '@/modules/cloud/types';

export function useCloudConnection() {
  const queryClient = useQueryClient();

  const { data: status, isLoading } = useQuery<CloudConnectionStatus>({
    queryKey: ['cloud', 'status'],
    queryFn: async () => {
      const response = await fetch('/api/auth/cloud/status');
      if (!response.ok) throw new Error('Failed to fetch cloud status');
      return response.json();
    },
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  const registry: RealtimeInvalidationRegistry = useMemo(
    () => [
      {
        match: exactTopic('cloud'),
        type: 'connected',
        entries: [{ kind: 'invalidate' as const, queryKey: ['cloud', 'status'] }],
      },
      {
        match: exactTopic('cloud'),
        type: 'disconnected',
        entries: [{ kind: 'invalidate' as const, queryKey: ['cloud', 'status'] }],
      },
      {
        match: exactTopic('cloud'),
        type: 'egress_disconnected',
        entries: [{ kind: 'invalidate' as const, queryKey: ['cloud', 'status'] }],
      },
    ],
    [],
  );

  useRealtimeDispatch(registry);

  // Listen for the popup/tab callback completing
  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({ queryKey: ['cloud', 'status'] });
    };
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, [queryClient]);

  const disconnect = useCallback(async () => {
    await fetch('/api/auth/cloud/session', { method: 'DELETE' });
    queryClient.invalidateQueries({ queryKey: ['cloud', 'status'] });
  }, [queryClient]);

  return {
    status: status ?? {
      connected: false,
      identityServiceUrl: '',
    },
    isLoading,
    disconnect,
  };
}
