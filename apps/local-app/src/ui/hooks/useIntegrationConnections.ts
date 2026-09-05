import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFetchFactory } from './useFetchFactory';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import {
  getIntegrationConnectionEpoch,
  integrationConnectionQueryKeys,
  type IntegrationConnectionState,
  type IntegrationProvider,
} from '@/ui/lib/integration-connections';
import {
  validIntegrationProjectId,
  withIntegrationProjectId,
} from '@/ui/lib/integration-project-scope';
import { managedSubtaskSyncQueryKeys } from '@/ui/lib/managed-subtask-sync';

export type {
  IntegrationConnectionState,
  IntegrationProvider,
} from '@/ui/lib/integration-connections';

export type ReplaceIntegrationConnectionInput =
  | {
      provider: 'clickup';
      token: string;
      subtaskSyncEnabled?: boolean;
      acknowledgeOrphanRisk?: boolean;
    }
  | {
      provider: 'jira';
      token: string;
      siteUrl?: string;
      email?: string;
      subtaskSyncEnabled?: boolean;
      acknowledgeOrphanRisk?: boolean;
    };

export interface DisconnectIntegrationConnectionInput {
  provider: IntegrationProvider;
  acknowledgeOrphanRisk?: boolean;
}

interface IntegrationConnectionErrorOptions {
  code?: string;
  field?: string;
  providerReason?: string;
}

export class IntegrationConnectionApiError extends Error {
  readonly code?: string;
  readonly field?: string;
  readonly providerReason?: string;

  constructor(message: string, options: IntegrationConnectionErrorOptions = {}) {
    super(message);
    this.name = 'IntegrationConnectionApiError';
    this.code = options.code;
    this.field = options.field;
    this.providerReason = options.providerReason;
  }
}

interface ErrorPayload {
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

interface IntegrationConnectionList {
  items: IntegrationConnectionState[];
}

function withConnectionState(
  current: IntegrationConnectionList | undefined,
  connection: IntegrationConnectionState,
): IntegrationConnectionList {
  const items = current?.items ?? [];
  const existingIndex = items.findIndex((item) => item.provider === connection.provider);
  if (existingIndex === -1) return { items: [...items, connection] };
  return {
    items: items.map((item, index) => (index === existingIndex ? connection : item)),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function throwIntegrationApiError(response: Response): Promise<never> {
  const payload = (await response.json().catch(() => null)) as ErrorPayload | null;
  const details = asRecord(payload?.details);
  const code = typeof payload?.code === 'string' ? payload.code : undefined;
  const providerReason = typeof details?.reason === 'string' ? details.reason : undefined;
  const provider = typeof details?.provider === 'string' ? details.provider : undefined;
  const explicitField = typeof details?.field === 'string' ? details.field : undefined;
  const field =
    explicitField ??
    (providerReason === 'authentication_failed'
      ? 'token'
      : providerReason === 'request_rejected'
        ? provider === 'jira'
          ? 'siteUrl'
          : 'token'
        : undefined);
  throw new IntegrationConnectionApiError(
    typeof payload?.message === 'string' ? payload.message : 'Integration request failed.',
    { code, field, providerReason },
  );
}

export function useIntegrationConnections({
  projectId,
  enabled = true,
}: {
  projectId: string | null;
  enabled?: boolean;
}) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const scopedProjectId = validIntegrationProjectId(projectId);
  const admitted = enabled && scopedProjectId !== null;
  const listKey = integrationConnectionQueryKeys.list(scopedProjectId ?? 'no-project');
  const query = useQuery({
    queryKey: listKey,
    queryFn: async ({ signal }): Promise<IntegrationConnectionList> => {
      const response = await apiFetch(
        withIntegrationProjectId('/api/integrations/connections', scopedProjectId),
        { signal },
      );
      if (!response.ok) {
        return throwIntegrationApiError(response);
      }
      return response.json();
    },
    staleTime: 30_000,
    enabled: admitted,
  });

  const previousConnectionEpoch = (mutationProjectId: string, provider: IntegrationProvider) => {
    const current = queryClient.getQueryData<IntegrationConnectionList>(
      integrationConnectionQueryKeys.list(mutationProjectId),
    );
    return getIntegrationConnectionEpoch(
      current?.items.find((connection) => connection.provider === provider),
    );
  };

  const applyConnectionIdentity = async (
    mutationProjectId: string,
    connection: IntegrationConnectionState,
    previousEpoch: string | null,
  ) => {
    // Remove the prior connection epoch before publishing the new identity so
    // mounted hooks cannot observe old-account data during replacement.
    if (previousEpoch !== null) {
      const epochKey = externalMyWorkQueryKeys.epoch(connection.provider, previousEpoch);
      await queryClient.cancelQueries({ queryKey: epochKey });
      queryClient.removeQueries({ queryKey: epochKey });
    }
    const mutationListKey = integrationConnectionQueryKeys.list(mutationProjectId);
    await queryClient.cancelQueries({ queryKey: mutationListKey });
    queryClient.setQueryData<IntegrationConnectionList>(mutationListKey, (current) =>
      withConnectionState(current, connection),
    );
    await queryClient.invalidateQueries({
      queryKey: managedSubtaskSyncQueryKeys.provider(mutationProjectId, connection.provider),
    });
    await queryClient.invalidateQueries({ queryKey: mutationListKey });
  };

  const replaceMutation = useMutation({
    mutationFn: async ({
      mutationProjectId,
      input,
    }: {
      mutationProjectId: string;
      input: ReplaceIntegrationConnectionInput;
      previousEpoch: string | null;
    }) => {
      const response = await apiFetch('/api/integrations/connections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, projectId: mutationProjectId }),
      });
      if (!response.ok) {
        return throwIntegrationApiError(response);
      }
      return (await response.json()) as IntegrationConnectionState;
    },
    onSuccess: (connection, request) =>
      applyConnectionIdentity(request.mutationProjectId, connection, request.previousEpoch),
  });

  const disconnectMutation = useMutation({
    mutationFn: async ({
      mutationProjectId,
      provider,
      acknowledgeOrphanRisk = false,
    }: DisconnectIntegrationConnectionInput & {
      mutationProjectId: string;
      previousEpoch: string | null;
    }) => {
      const response = await apiFetch(
        withIntegrationProjectId(
          `/api/integrations/connections/${provider}${acknowledgeOrphanRisk ? '?acknowledgeOrphanRisk=true' : ''}`,
          mutationProjectId,
        ),
        { method: 'DELETE' },
      );
      if (!response.ok) {
        return throwIntegrationApiError(response);
      }
      return (await response.json()) as IntegrationConnectionState;
    },
    onSuccess: (connection, request) =>
      applyConnectionIdentity(request.mutationProjectId, connection, request.previousEpoch),
  });

  const syncSettingMutation = useMutation({
    mutationFn: async ({
      mutationProjectId,
      provider,
      subtaskSyncEnabled,
    }: {
      mutationProjectId: string;
      provider: IntegrationProvider;
      subtaskSyncEnabled: boolean;
      previousEpoch: string | null;
    }) => {
      const response = await apiFetch(`/api/integrations/connections/${provider}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: mutationProjectId, subtaskSyncEnabled }),
      });
      if (!response.ok) return throwIntegrationApiError(response);
      return (await response.json()) as IntegrationConnectionState;
    },
    onSuccess: (connection, request) =>
      applyConnectionIdentity(request.mutationProjectId, connection, request.previousEpoch),
  });

  const requireAdmittedProject = (): string => {
    if (!admitted || scopedProjectId === null) {
      throw new IntegrationConnectionApiError('Integrations are unavailable.');
    }
    return scopedProjectId;
  };

  return {
    connections: admitted ? (query.data?.items ?? []) : [],
    isLoading: admitted && query.isLoading,
    error: admitted ? query.error : null,
    replaceConnection: (input: ReplaceIntegrationConnectionInput) => {
      const mutationProjectId = requireAdmittedProject();
      return replaceMutation.mutateAsync({
        mutationProjectId,
        input,
        previousEpoch: previousConnectionEpoch(mutationProjectId, input.provider),
      });
    },
    disconnectConnection: (provider: IntegrationProvider, acknowledgeOrphanRisk = false) => {
      const mutationProjectId = requireAdmittedProject();
      return disconnectMutation.mutateAsync({
        mutationProjectId,
        provider,
        acknowledgeOrphanRisk,
        previousEpoch: previousConnectionEpoch(mutationProjectId, provider),
      });
    },
    updateSubtaskSync: (provider: IntegrationProvider, subtaskSyncEnabled: boolean) => {
      const mutationProjectId = requireAdmittedProject();
      return syncSettingMutation.mutateAsync({
        mutationProjectId,
        provider,
        subtaskSyncEnabled,
        previousEpoch: previousConnectionEpoch(mutationProjectId, provider),
      });
    },
    replacingProvider: replaceMutation.isPending
      ? replaceMutation.variables?.input.provider
      : undefined,
    disconnectingProvider: disconnectMutation.isPending
      ? disconnectMutation.variables?.provider
      : undefined,
    updatingSyncProvider: syncSettingMutation.isPending
      ? syncSettingMutation.variables?.provider
      : undefined,
  };
}
