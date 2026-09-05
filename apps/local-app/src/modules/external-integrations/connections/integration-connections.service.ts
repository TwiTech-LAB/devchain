import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConflictError, NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type {
  IntegrationConnection,
  IntegrationCredentials,
  IntegrationProvider,
  Project,
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

export interface IntegrationConnectionDirectoryEntry {
  project: { id: string; name: string };
  workspace: { id: string; name: string };
  provider: IntegrationProvider;
  configured: boolean;
  updatedAt: string | null;
  subtaskSyncEnabled: boolean;
  hasMigratedSharedOrigin: boolean;
}

export interface IntegrationConnectionDirectory {
  items: IntegrationConnectionDirectoryEntry[];
  unassignedConnections: IntegrationConnectionState[];
  truncated: boolean;
}

const CONNECTION_DIRECTORY_PROJECT_LIMIT = 100;

export type ReplaceConnectionInput =
  | {
      projectId: string;
      provider: 'clickup';
      token: string;
      subtaskSyncEnabled?: boolean;
      acknowledgeOrphanRisk?: boolean;
    }
  | {
      projectId: string;
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

  async listConnections(projectId: string): Promise<{ items: IntegrationConnectionState[] }> {
    await this.requireProject(projectId);
    const stored = await this.storage.listIntegrationConnections(projectId);
    for (const connection of stored) {
      this.assertConnectionScope(connection, projectId, connection.provider);
    }
    const byProvider = new Map(stored.map((connection) => [connection.provider, connection]));
    return {
      items: this.providers
        .getSupportedProviders()
        .map((provider) => this.toState(provider, byProvider.get(provider))),
    };
  }

  async listDirectory(): Promise<IntegrationConnectionDirectory> {
    const [projectPage, workspaces, connections] = await Promise.all([
      this.storage.listProjects({ limit: CONNECTION_DIRECTORY_PROJECT_LIMIT, offset: 0 }),
      this.storage.listProjectWorkspaces(),
      this.storage.listIntegrationConnections(),
    ]);
    const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const connectionByProjectProvider = new Map(
      connections
        .filter(
          (connection): connection is IntegrationConnection & { projectId: string } =>
            connection.projectId !== null,
        )
        .map((connection) => [
          this.connectionMapKey(connection.projectId, connection.provider),
          connection,
        ]),
    );
    const projects = [...projectPage.items].sort(
      (a, b) =>
        a.workspaceId.localeCompare(b.workspaceId) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );

    return {
      items: projects.flatMap((project) => {
        const workspace = workspaceById.get(project.workspaceId);
        if (!workspace) {
          throw new ValidationError('Project workspace scope is unavailable.', {
            projectId: project.id,
            workspaceId: project.workspaceId,
          });
        }
        return this.providers.getSupportedProviders().map((provider) => {
          const connection = connectionByProjectProvider.get(
            this.connectionMapKey(project.id, provider),
          );
          return {
            project: { id: project.id, name: project.name },
            workspace: { id: workspace.id, name: workspace.name },
            provider,
            configured: connection !== undefined,
            updatedAt: connection?.updatedAt ?? null,
            subtaskSyncEnabled: connection?.subtaskSyncEnabled ?? false,
            hasMigratedSharedOrigin:
              connection !== undefined && connection.legacySourceConnectionId !== null,
          };
        });
      }),
      unassignedConnections: connections
        .filter((connection) => connection.projectId === null)
        .map((connection) => this.toState(connection.provider, connection)),
      truncated: projectPage.total > projectPage.items.length,
    };
  }

  async assignLegacyConnection(
    connectionId: string,
    projectId: string,
  ): Promise<IntegrationConnectionState> {
    await this.requireProject(projectId);
    const legacy = await this.requireUnassignedConnection(connectionId);
    const occupied = await this.getScopedConnection(projectId, legacy.provider);
    if (occupied) {
      throw new ConflictError('Project already has a connection for this provider.', {
        projectId,
        provider: legacy.provider,
      });
    }
    return this.operationGate.run({ connectionId: legacy.id, provider: legacy.provider }, () =>
      this.operationGate.run({ projectId, provider: legacy.provider }, async () => {
        let prepared: PreparedEvent<'integration.connection.updated'> | null = null;
        const assigned = await this.storage.assignUnassignedIntegrationConnection(
          legacy.id,
          projectId,
          (current, previous) => {
            if (!this.eventsService) {
              return null;
            }
            prepared = this.eventsService.prepareCommitted('integration.connection.updated', {
              connectionId: current.id,
              projectId: this.requireProjectId(current),
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
        this.assertConnectionScope(assigned, projectId, legacy.provider);
        return this.toState(legacy.provider, assigned);
      }),
    );
  }

  async disconnectLegacyConnection(
    connectionId: string,
    acknowledgeOrphanRisk = false,
  ): Promise<IntegrationConnectionState> {
    const legacy = await this.requireUnassignedConnection(connectionId);
    return this.operationGate.run(
      { connectionId: legacy.id, provider: legacy.provider },
      async () => {
        await this.storage.disconnectUnassignedIntegrationConnection(legacy.id, undefined, {
          acknowledgeOrphanRisk,
        });
        this.editSessions.invalidateConnection(legacy.id);
        return this.toState(legacy.provider);
      },
    );
  }

  async replaceConnection(input: ReplaceConnectionInput): Promise<IntegrationConnectionState> {
    await this.requireProject(input.projectId);
    return this.operationGate.run(
      { projectId: input.projectId, provider: input.provider },
      async () => {
        const existing = await this.getScopedConnection(input.projectId, input.provider);
        const credentials = await this.resolveCredentials(input, existing);
        let prepared: PreparedEvent<
          'integration.connection.created' | 'integration.connection.updated'
        > | null = null;
        const connection = await this.storage.replaceIntegrationConnection(
          {
            projectId: input.projectId,
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
                  projectId: this.requireProjectId(current),
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
                  projectId: this.requireProjectId(current),
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
        this.assertConnectionScope(connection, input.projectId, input.provider);
        this.editSessions.invalidateConnection(connection.id);
        return this.toState(input.provider, connection);
      },
    );
  }

  async disconnectConnection(
    projectId: string,
    provider: IntegrationProvider,
    acknowledgeOrphanRisk = false,
  ): Promise<IntegrationConnectionState> {
    await this.requireProject(projectId);
    const existing = await this.requireScopedConnection(projectId, provider);
    return this.operationGate.run({ projectId, provider }, async () => {
      let prepared: PreparedEvent<'integration.connection.deleted'> | null = null;
      await this.storage.disconnectIntegrationConnection(
        { projectId, provider },
        (connection) => {
          this.assertConnectionScope(connection, projectId, provider);
          if (!this.eventsService) {
            return null;
          }
          prepared = this.eventsService.prepareCommitted('integration.connection.deleted', {
            connectionId: connection.id,
            projectId: this.requireProjectId(connection),
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
      this.editSessions.invalidateConnection(existing.id);
      return this.toState(provider);
    });
  }

  async updateSyncSettings(
    projectId: string,
    provider: IntegrationProvider,
    input: { subtaskSyncEnabled: boolean },
  ): Promise<IntegrationConnectionState> {
    await this.requireProject(projectId);
    await this.requireScopedConnection(projectId, provider);
    return this.operationGate.run({ projectId, provider }, async () => {
      let prepared: PreparedEvent<'integration.connection.updated'> | null = null;
      const connection = await this.storage.updateIntegrationConnectionSyncSetting(
        { projectId, provider },
        input.subtaskSyncEnabled,
        (current, previous) => {
          if (!this.eventsService) {
            return null;
          }
          prepared = this.eventsService.prepareCommitted('integration.connection.updated', {
            connectionId: current.id,
            projectId: this.requireProjectId(current),
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
      this.assertConnectionScope(connection, projectId, provider);
      return this.toState(provider, connection);
    });
  }

  private async resolveCredentials(
    input: ReplaceConnectionInput,
    existing: IntegrationConnection | null,
  ): Promise<IntegrationCredentials> {
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

    if (!existing) {
      throw new ValidationError('Jira site URL is required for an initial connection.', {
        field: 'siteUrl',
      });
    }
    const existingCredentials = await this.storage.getIntegrationConnectionCredentials({
      projectId: input.projectId,
      provider: 'jira',
    });
    if (!existingCredentials || existingCredentials.provider !== 'jira') {
      throw new ValidationError('Jira connection credentials are unavailable for this project.', {
        projectId: input.projectId,
        provider: 'jira',
      });
    }
    return {
      provider: 'jira',
      siteUrl: existingCredentials.siteUrl,
      email: existingCredentials.email,
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

  private requireProjectId(connection: IntegrationConnection): string {
    if (!connection.projectId) {
      throw new ValidationError('Project-owned connection event requires project identity.');
    }
    return connection.projectId;
  }

  private requireProject(projectId: string): Promise<Project> {
    return this.storage.getProject(projectId);
  }

  private async getScopedConnection(
    projectId: string,
    provider: IntegrationProvider,
  ): Promise<IntegrationConnection | null> {
    const connection = await this.storage.getIntegrationConnection({ projectId, provider });
    if (connection) {
      this.assertConnectionScope(connection, projectId, provider);
    }
    return connection;
  }

  private async requireScopedConnection(
    projectId: string,
    provider: IntegrationProvider,
  ): Promise<IntegrationConnection> {
    const connection = await this.getScopedConnection(projectId, provider);
    if (!connection) {
      throw new NotFoundError('Integration connection');
    }
    return connection;
  }

  private async requireUnassignedConnection(connectionId: string): Promise<IntegrationConnection> {
    const connection = await this.storage.getIntegrationConnectionById(connectionId);
    if (!connection || connection.projectId !== null) {
      throw new NotFoundError('Unassigned integration connection', connectionId);
    }
    return connection;
  }

  private assertConnectionScope(
    connection: IntegrationConnection,
    projectId: string,
    provider: IntegrationProvider,
  ): void {
    if (connection.projectId !== projectId || connection.provider !== provider) {
      throw new ValidationError('Integration connection does not match the requested project.', {
        projectId,
        provider,
      });
    }
  }

  private connectionMapKey(projectId: string, provider: IntegrationProvider): string {
    return `${projectId}:${provider}`;
  }
}
