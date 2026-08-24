import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFetchFactory } from './useFetchFactory';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import {
  integrationConnectionQueryKeys,
  type IntegrationConnectionState,
  type IntegrationProvider,
} from '@/ui/lib/integration-connections';
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

export function useIntegrationConnections({ enabled = true }: { enabled?: boolean } = {}) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const listKey = integrationConnectionQueryKeys.list();
  const query = useQuery({
    queryKey: listKey,
    queryFn: async ({ signal }): Promise<IntegrationConnectionList> => {
      const response = await apiFetch('/api/integrations/connections', { signal });
      if (!response.ok) {
        return throwIntegrationApiError(response);
      }
      return response.json();
    },
    staleTime: 30_000,
    enabled,
  });

  const applyConnectionIdentity = async (connection: IntegrationConnectionState) => {
    // Remove provider data before publishing the new identity so mounted hooks
    // cannot observe old-account cache entries under a replacement connection.
    const providerKey = externalMyWorkQueryKeys.provider(connection.provider);
    await queryClient.cancelQueries({ queryKey: providerKey });
    queryClient.removeQueries({ queryKey: providerKey });
    await queryClient.cancelQueries({ queryKey: listKey });
    queryClient.setQueryData<IntegrationConnectionList>(listKey, (current) =>
      withConnectionState(current, connection),
    );
    await queryClient.invalidateQueries({
      queryKey: managedSubtaskSyncQueryKeys.provider(connection.provider),
    });
    await queryClient.invalidateQueries({ queryKey: listKey });
  };

  const replaceMutation = useMutation({
    mutationFn: async (input: ReplaceIntegrationConnectionInput) => {
      if (!enabled) throw new IntegrationConnectionApiError('Integrations are unavailable.');
      const response = await apiFetch('/api/integrations/connections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        return throwIntegrationApiError(response);
      }
      return (await response.json()) as IntegrationConnectionState;
    },
    onSuccess: applyConnectionIdentity,
  });

  const disconnectMutation = useMutation({
    mutationFn: async ({
      provider,
      acknowledgeOrphanRisk = false,
    }: DisconnectIntegrationConnectionInput) => {
      if (!enabled) throw new IntegrationConnectionApiError('Integrations are unavailable.');
      const response = await apiFetch(
        `/api/integrations/connections/${provider}${acknowledgeOrphanRisk ? '?acknowledgeOrphanRisk=true' : ''}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        return throwIntegrationApiError(response);
      }
      return (await response.json()) as IntegrationConnectionState;
    },
    onSuccess: applyConnectionIdentity,
  });

  const syncSettingMutation = useMutation({
    mutationFn: async ({
      provider,
      subtaskSyncEnabled,
    }: {
      provider: IntegrationProvider;
      subtaskSyncEnabled: boolean;
    }) => {
      if (!enabled) throw new IntegrationConnectionApiError('Integrations are unavailable.');
      const response = await apiFetch(`/api/integrations/connections/${provider}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subtaskSyncEnabled }),
      });
      if (!response.ok) return throwIntegrationApiError(response);
      return (await response.json()) as IntegrationConnectionState;
    },
    onSuccess: applyConnectionIdentity,
  });

  return {
    connections: enabled ? (query.data?.items ?? []) : [],
    isLoading: enabled && query.isLoading,
    error: enabled ? query.error : null,
    replaceConnection: replaceMutation.mutateAsync,
    disconnectConnection: (provider: IntegrationProvider, acknowledgeOrphanRisk = false) =>
      disconnectMutation.mutateAsync({ provider, acknowledgeOrphanRisk }),
    updateSubtaskSync: (provider: IntegrationProvider, subtaskSyncEnabled: boolean) =>
      syncSettingMutation.mutateAsync({ provider, subtaskSyncEnabled }),
    replacingProvider: replaceMutation.isPending ? replaceMutation.variables?.provider : undefined,
    disconnectingProvider: disconnectMutation.isPending
      ? disconnectMutation.variables?.provider
      : undefined,
    updatingSyncProvider: syncSettingMutation.isPending
      ? syncSettingMutation.variables?.provider
      : undefined,
  };
}
