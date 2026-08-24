import {
  INTEGRATION_PROVIDER_IDS,
  type IntegrationProvider,
} from '@/modules/storage/models/domain.models';

export { INTEGRATION_PROVIDER_IDS };
export type { IntegrationProvider };

export interface IntegrationConnectionState {
  provider: IntegrationProvider;
  connected: boolean;
  connectionId: string | null;
  generation: number | null;
  subtaskSyncEnabled: boolean;
  syncSettingRevision: number | null;
  updatedAt: string | null;
}

export function disconnectedConnectionState(
  provider: IntegrationProvider,
): IntegrationConnectionState {
  return {
    provider,
    connected: false,
    connectionId: null,
    generation: null,
    subtaskSyncEnabled: false,
    syncSettingRevision: null,
    updatedAt: null,
  };
}

export const integrationConnectionQueryKeys = {
  all: ['integration-connections'] as const,
  list: () => [...integrationConnectionQueryKeys.all, 'list'] as const,
};

export type IntegrationConnectionEpoch = string;

export function getIntegrationConnectionEpoch(
  connection: IntegrationConnectionState | undefined,
): IntegrationConnectionEpoch | null {
  if (
    !connection?.connected ||
    connection.connectionId === null ||
    connection.generation === null ||
    connection.updatedAt === null
  ) {
    return null;
  }
  return `${connection.connectionId}:${connection.generation}`;
}
