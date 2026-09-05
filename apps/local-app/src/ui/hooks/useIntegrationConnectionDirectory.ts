import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { throwIntegrationApiError } from './useIntegrationConnections';
import { useFetchFactory } from './useFetchFactory';
import {
  integrationConnectionQueryKeys,
  type IntegrationConnectionDirectory,
  type IntegrationConnectionState,
} from '@/ui/lib/integration-connections';
import {
  managedSubtaskSyncQueryKeys,
  type ManagedSubtaskSyncHealth,
} from '@/ui/lib/managed-subtask-sync';

export function useIntegrationConnectionDirectory({ enabled = true }: { enabled?: boolean } = {}) {
  const apiFetch = useFetchFactory();
  const query = useQuery({
    queryKey: integrationConnectionQueryKeys.directory(),
    queryFn: async ({ signal }): Promise<IntegrationConnectionDirectory> => {
      const response = await apiFetch('/api/integrations/connections/directory', { signal });
      if (!response.ok) return throwIntegrationApiError(response);
      return response.json();
    },
    staleTime: 10_000,
    enabled,
  });

  return {
    directory: enabled ? query.data : undefined,
    isLoading: enabled && query.isLoading,
    error: enabled ? query.error : null,
  };
}

async function invalidateDirectoryCaches(queryClient: ReturnType<typeof useQueryClient>) {
  await queryClient.invalidateQueries({ queryKey: integrationConnectionQueryKeys.directory() });
  await queryClient.invalidateQueries({ queryKey: integrationConnectionQueryKeys.all });
}

export function useLegacyIntegrationConnectionActions() {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();

  const assignMutation = useMutation({
    mutationFn: async ({
      connectionId,
      projectId,
    }: {
      connectionId: string;
      projectId: string;
    }) => {
      const response = await apiFetch(
        `/api/integrations/connections/legacy/${encodeURIComponent(connectionId)}/assign`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId }),
        },
      );
      if (!response.ok) return throwIntegrationApiError(response);
      return (await response.json()) as IntegrationConnectionState;
    },
    onSuccess: async (_connection, request) => {
      await queryClient.removeQueries({
        queryKey: managedSubtaskSyncQueryKeys.legacy(request.connectionId),
      });
      await invalidateDirectoryCaches(queryClient);
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async ({
      connectionId,
      acknowledgeOrphanRisk = false,
    }: {
      connectionId: string;
      acknowledgeOrphanRisk?: boolean;
    }) => {
      const response = await apiFetch(
        `/api/integrations/connections/legacy/${encodeURIComponent(connectionId)}${
          acknowledgeOrphanRisk ? '?acknowledgeOrphanRisk=true' : ''
        }`,
        { method: 'DELETE' },
      );
      if (!response.ok) return throwIntegrationApiError(response);
      return (await response.json()) as IntegrationConnectionState;
    },
    onSuccess: async (_connection, request) => {
      await queryClient.removeQueries({
        queryKey: managedSubtaskSyncQueryKeys.legacy(request.connectionId),
      });
      await invalidateDirectoryCaches(queryClient);
    },
  });

  return {
    assign: (connectionId: string, projectId: string) =>
      assignMutation.mutateAsync({ connectionId, projectId }),
    disconnect: (connectionId: string, acknowledgeOrphanRisk = false) =>
      disconnectMutation.mutateAsync({ connectionId, acknowledgeOrphanRisk }),
    assigningConnectionId: assignMutation.isPending
      ? (assignMutation.variables?.connectionId ?? null)
      : null,
    disconnectingConnectionId: disconnectMutation.isPending
      ? (disconnectMutation.variables?.connectionId ?? null)
      : null,
  };
}

interface LegacyRecoveryInput {
  action: 'verification' | 'retry';
  id: string;
}

export function useLegacyManagedSubtaskSyncHealth(
  connectionId: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const queryKey = managedSubtaskSyncQueryKeys.legacy(connectionId);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }): Promise<ManagedSubtaskSyncHealth> => {
      const response = await apiFetch(
        `/api/integrations/connections/legacy/${encodeURIComponent(connectionId)}/sync-health`,
        { signal },
      );
      if (!response.ok) return throwIntegrationApiError(response);
      return response.json();
    },
    enabled,
    staleTime: 10_000,
  });

  const recoveryMutation = useMutation({
    mutationFn: async ({ action, id }: LegacyRecoveryInput) => {
      const response = await apiFetch(
        `/api/integrations/connections/legacy/${encodeURIComponent(
          connectionId,
        )}/managed-subtasks/${encodeURIComponent(id)}/${action}`,
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
