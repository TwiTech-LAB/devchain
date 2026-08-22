import { Inject, Injectable } from '@nestjs/common';
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

export interface IntegrationConnectionState {
  provider: IntegrationProvider;
  connected: boolean;
  connectionId: string | null;
  generation: number | null;
  updatedAt: string | null;
}

export type ReplaceConnectionInput =
  | { provider: 'clickup'; token: string }
  | { provider: 'jira'; token: string; siteUrl?: string; email?: string };

@Injectable()
export class IntegrationConnectionsService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly providers: ExternalTaskProviderRegistry,
    private readonly operationGate: ProviderOperationGate,
    private readonly editSessions: ExternalEditSessionStore,
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
      const connection = await this.storage.replaceIntegrationConnection(
        { provider: input.provider, credentials },
        async (candidate) => {
          await this.providers.get(candidate.provider).verifyCredentials(candidate);
        },
      );
      this.editSessions.invalidateProvider(input.provider);
      return this.toState(input.provider, connection);
    });
  }

  async disconnectConnection(provider: IntegrationProvider): Promise<IntegrationConnectionState> {
    return this.operationGate.run(provider, async () => {
      await this.storage.disconnectIntegrationConnection(provider);
      this.editSessions.invalidateProvider(provider);
      return this.toState(provider);
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
      updatedAt: connection?.updatedAt ?? null,
    };
  }
}
