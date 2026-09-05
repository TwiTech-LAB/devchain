import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IntegrationProvider } from '@/ui/lib/integration-connections';
import {
  managedSubtaskSyncQueryKeys,
  type ManagedSubtaskSyncHealth,
} from '@/ui/lib/managed-subtask-sync';
import { throwIntegrationApiError } from './useIntegrationConnections';
import { useFetchFactory } from './useFetchFactory';
import {
  validIntegrationProjectId,
  withIntegrationProjectId,
} from '@/ui/lib/integration-project-scope';

interface RecoveryInput {
  action: 'verification' | 'retry';
  id: string;
}

export function useManagedSubtaskSyncHealth(
  provider: IntegrationProvider,
  { projectId, enabled = true }: { projectId: string | null; enabled?: boolean },
) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const scopedProjectId = validIntegrationProjectId(projectId);
  const admitted = enabled && scopedProjectId !== null;
  const queryKey = managedSubtaskSyncQueryKeys.provider(scopedProjectId ?? 'no-project', provider);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }): Promise<ManagedSubtaskSyncHealth> => {
      const response = await apiFetch(
        withIntegrationProjectId(
          `/api/integrations/connections/${provider}/sync-health`,
          scopedProjectId,
        ),
        { signal },
      );
      if (!response.ok) return throwIntegrationApiError(response);
      return response.json();
    },
    enabled: admitted,
    staleTime: 10_000,
  });

  const recoveryMutation = useMutation({
    mutationFn: async ({ action, id }: RecoveryInput) => {
      if (!admitted) throw new Error('Managed subtask sync is unavailable.');
      const response = await apiFetch(
        withIntegrationProjectId(
          `/api/integrations/connections/${provider}/managed-subtasks/${encodeURIComponent(id)}/${action}`,
          scopedProjectId,
        ),
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
    health: admitted ? query.data : undefined,
    isLoading: admitted && query.isLoading,
    error: admitted ? query.error : null,
    verify: (id: string) => recoveryMutation.mutateAsync({ action: 'verification', id }),
    retry: (id: string) => recoveryMutation.mutateAsync({ action: 'retry', id }),
    pendingAction: recoveryMutation.isPending
      ? `${recoveryMutation.variables?.action}:${recoveryMutation.variables?.id}`
      : undefined,
  };
}
