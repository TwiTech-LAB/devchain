import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { HOME_BACKEND, apiFetch, type BackendId } from '@/ui/lib/api-transport';
import { useRealtimeDispatch } from './useRealtimeDispatch';
import { exactTopic } from '../lib/realtime-invalidation-registry';
import type { RealtimeInvalidationRegistry } from '../lib/realtime-invalidation-registry';
import type { CloudConnectionStatus } from '@/modules/cloud/types';

/**
 * Connection status of one backend. The backend id leads the query key so
 * switching the Cloud page target never shows another instance's cached status.
 */
export function useCloudConnection(backend: BackendId = HOME_BACKEND) {
  const queryClient = useQueryClient();

  const statusKey = useMemo(() => [backend, 'cloud', 'status'] as const, [backend]);

  const { data: status, isLoading } = useQuery<CloudConnectionStatus>({
    queryKey: statusKey,
    queryFn: async () => {
      const response = await apiFetch('/api/auth/cloud/status', undefined, { backend });
      if (!response.ok) throw new Error('Failed to fetch cloud status');
      return response.json();
    },
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  // Home's cloud broadcasts describe this PC only, so they invalidate the home
  // key only. A remote target refetches on focus and after its own mutations.
  const registry: RealtimeInvalidationRegistry = useMemo(
    () =>
      backend === HOME_BACKEND
        ? [
            {
              match: exactTopic('cloud'),
              type: 'connected',
              entries: [
                { kind: 'invalidate' as const, queryKey: [HOME_BACKEND, 'cloud', 'status'] },
              ],
            },
            {
              match: exactTopic('cloud'),
              type: 'disconnected',
              entries: [
                { kind: 'invalidate' as const, queryKey: [HOME_BACKEND, 'cloud', 'status'] },
              ],
            },
            {
              match: exactTopic('cloud'),
              type: 'egress_disconnected',
              entries: [
                { kind: 'invalidate' as const, queryKey: [HOME_BACKEND, 'cloud', 'status'] },
              ],
            },
          ]
        : [],
    [backend],
  );

  useRealtimeDispatch(registry, { socket: 'home' });

  // Listen for the popup/tab callback completing
  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({ queryKey: statusKey });
    };
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, [queryClient, statusKey]);

  const disconnect = useCallback(async () => {
    await apiFetch('/api/auth/cloud/session', { method: 'DELETE' }, { backend });
    queryClient.invalidateQueries({ queryKey: statusKey });
  }, [backend, queryClient, statusKey]);

  return {
    status: status ?? {
      connected: false,
      identityServiceUrl: '',
    },
    isLoading,
    disconnect,
  };
}
