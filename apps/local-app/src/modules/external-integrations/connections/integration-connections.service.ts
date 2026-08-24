import { Inject, Injectable, Optional } from '@nestjs/common';
import { ValidationError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type {
  IntegrationConnection,
  IntegrationCredentials,
  IntegrationProvider,
} from '../../storage/models/domain.models';
import { ExternalTaskProviderRegistry } from '../external-task-provider.registry';
import { ExternalEditSessionStore } from '../sessions/external-edit-session.store';
import { ProviderOperationGate } from '../sessions/provider-operation-gate';
import { EventsService } from '../../events/services/events.service';
import type { PreparedEvent } from '../../events/services/durable-event-registry.service';

export interface IntegrationConnectionState {
  provider: IntegrationProvider;
  connected: boolean;
  connectionId: string | null;
  generation: number | null;
  subtaskSyncEnabled: boolean;
  syncSettingRevision: number | null;
  updatedAt: string | null;
}

export type ReplaceConnectionInput =
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

@Injectable()
export class IntegrationConnectionsService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly providers: ExternalTaskProviderRegistry,
    private readonly operationGate: ProviderOperationGate,
    private readonly editSessions: ExternalEditSessionStore,
    @Optional() private readonly eventsService?: EventsService,
  ) {}

  async listConnections(): Promise<{ items: IntegrationConnectionState[] }> {
    const stored = await this.storage.listIntegrationConnections();
    const byProvider = new Map(stored.map((connection) => [connection.provider, connection]));
    return {
      items: this.providers
        .getSupportedProviders()
        .map((provider) => this.toState(provider, byProvider.get(provider))),
    };
  }

  async replaceConnection(input: ReplaceConnectionInput): Promise<IntegrationConnectionState> {
    // Credential replacement shares the provider operation gate with vendor
    // mutations, so a session write can never interleave with a token swap.
    return this.operationGate.run(input.provider, async () => {
      const credentials = await this.resolveCredentials(input);
      let prepared: PreparedEvent<
        'integration.connection.created' | 'integration.connection.updated'
      > | null = null;
      const connection = await this.storage.replaceIntegrationConnection(
        {
          provider: input.provider,
          credentials,
          ...(input.subtaskSyncEnabled !== undefined
            ? { subtaskSyncEnabled: input.subtaskSyncEnabled }
            : {}),
          ...(input.acknowledgeOrphanRisk !== undefined
            ? { acknowledgeOrphanRisk: input.acknowledgeOrphanRisk }
            : {}),
        },
        async (candidate) => {
          await this.providers.get(candidate.provider).verifyCredentials(candidate);
        },
        (current, previous) => {
          if (!this.eventsService) {
            return null;
          }
          prepared = previous
            ? this.eventsService.prepareCommitted('integration.connection.updated', {
                connectionId: current.id,
                provider: current.provider,
                previousGeneration: previous.generation,
                generation: current.generation,
                previousSubtaskSyncEnabled: previous.subtaskSyncEnabled,
                subtaskSyncEnabled: current.subtaskSyncEnabled,
                previousSyncSettingRevision: previous.syncSettingRevision,
                syncSettingRevision: current.syncSettingRevision,
                createdAt: current.createdAt,
                updatedAt: current.updatedAt,
              })
            : this.eventsService.prepareCommitted('integration.connection.created', {
                connectionId: current.id,
                provider: current.provider,
                generation: current.generation,
                subtaskSyncEnabled: current.subtaskSyncEnabled,
                syncSettingRevision: current.syncSettingRevision,
                createdAt: current.createdAt,
                updatedAt: current.updatedAt,
              });
          return prepared;
        },
      );
      if (prepared) {
        this.eventsService?.emitCommitted(prepared);
      }
      this.editSessions.invalidateProvider(input.provider);
      return this.toState(input.provider, connection);
    });
  }

  async disconnectConnection(
    provider: IntegrationProvider,
    acknowledgeOrphanRisk = false,
  ): Promise<IntegrationConnectionState> {
    return this.operationGate.run(provider, async () => {
      let prepared: PreparedEvent<'integration.connection.deleted'> | null = null;
      await this.storage.disconnectIntegrationConnection(
        provider,
        (connection) => {
          if (!this.eventsService) {
            return null;
          }
          prepared = this.eventsService.prepareCommitted('integration.connection.deleted', {
            connectionId: connection.id,
            provider: connection.provider,
            generation: connection.generation,
            subtaskSyncEnabled: connection.subtaskSyncEnabled,
            syncSettingRevision: connection.syncSettingRevision,
            deletedAt: new Date().toISOString(),
          });
          return prepared;
        },
        { acknowledgeOrphanRisk },
      );
      if (prepared) {
        this.eventsService?.emitCommitted(prepared);
      }
      this.editSessions.invalidateProvider(provider);
      return this.toState(provider);
    });
  }

  async updateSyncSettings(
    provider: IntegrationProvider,
    input: { subtaskSyncEnabled: boolean },
  ): Promise<IntegrationConnectionState> {
    return this.operationGate.run(provider, async () => {
      let prepared: PreparedEvent<'integration.connection.updated'> | null = null;
      const connection = await this.storage.updateIntegrationConnectionSyncSetting(
        provider,
        input.subtaskSyncEnabled,
        (current, previous) => {
          if (!this.eventsService) {
            return null;
          }
          prepared = this.eventsService.prepareCommitted('integration.connection.updated', {
            connectionId: current.id,
            provider: current.provider,
            previousGeneration: previous.generation,
            generation: current.generation,
            previousSubtaskSyncEnabled: previous.subtaskSyncEnabled,
            subtaskSyncEnabled: current.subtaskSyncEnabled,
            previousSyncSettingRevision: previous.syncSettingRevision,
            syncSettingRevision: current.syncSettingRevision,
            createdAt: current.createdAt,
            updatedAt: current.updatedAt,
          });
          return prepared;
        },
      );
      if (prepared) {
        this.eventsService?.emitCommitted(prepared);
      }
      return this.toState(provider, connection);
    });
  }

  private async resolveCredentials(input: ReplaceConnectionInput): Promise<IntegrationCredentials> {
    if (input.provider === 'clickup') {
      return { provider: 'clickup', token: input.token };
    }
    if (input.siteUrl && input.email) {
      return {
        provider: 'jira',
        siteUrl: input.siteUrl,
        email: input.email,
        token: input.token,
      };
    }

    const existing = await this.storage.getIntegrationConnectionCredentials('jira');
    if (!existing || existing.provider !== 'jira') {
      throw new ValidationError('Jira site URL is required for an initial connection.', {
        field: 'siteUrl',
      });
    }
    return {
      provider: 'jira',
      siteUrl: existing.siteUrl,
      email: existing.email,
      token: input.token,
    };
  }

  private toState(
    provider: IntegrationProvider,
    connection?: IntegrationConnection,
  ): IntegrationConnectionState {
    return {
      provider,
      connected: connection !== undefined,
      connectionId: connection?.id ?? null,
      generation: connection?.generation ?? null,
      subtaskSyncEnabled: connection?.subtaskSyncEnabled ?? false,
      syncSettingRevision: connection?.syncSettingRevision ?? null,
      updatedAt: connection?.updatedAt ?? null,
    };
  }
}
