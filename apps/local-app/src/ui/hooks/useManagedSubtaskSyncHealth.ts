import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IntegrationProvider } from '@/ui/lib/integration-connections';
import {
  managedSubtaskSyncQueryKeys,
  type ManagedSubtaskSyncHealth,
} from '@/ui/lib/managed-subtask-sync';
import { throwIntegrationApiError } from './useIntegrationConnections';
import { useFetchFactory } from './useFetchFactory';

interface RecoveryInput {
  action: 'verification' | 'retry';
  id: string;
}

export function useManagedSubtaskSyncHealth(
  provider: IntegrationProvider,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const queryKey = managedSubtaskSyncQueryKeys.provider(provider);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }): Promise<ManagedSubtaskSyncHealth> => {
      const response = await apiFetch(`/api/integrations/connections/${provider}/sync-health`, {
        signal,
      });
      if (!response.ok) return throwIntegrationApiError(response);
      return response.json();
    },
    enabled,
    staleTime: 10_000,
  });

  const recoveryMutation = useMutation({
    mutationFn: async ({ action, id }: RecoveryInput) => {
      if (!enabled) throw new Error('Managed subtask sync is unavailable.');
      const response = await apiFetch(
        `/api/integrations/connections/${provider}/managed-subtasks/${encodeURIComponent(id)}/${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      );
      if (!response.ok) return throwIntegrationApiError(response);
      return response.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  return {
    health: enabled ? query.data : undefined,
    isLoading: enabled && query.isLoading,
    error: enabled ? query.error : null,
    verify: (id: string) => recoveryMutation.mutateAsync({ action: 'verification', id }),
    retry: (id: string) => recoveryMutation.mutateAsync({ action: 'retry', id }),
    pendingAction: recoveryMutation.isPending
      ? `${recoveryMutation.variables?.action}:${recoveryMutation.variables?.id}`
      : undefined,
  };
}
