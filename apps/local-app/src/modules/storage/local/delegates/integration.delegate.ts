import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  StorageError,
  ValidationError,
} from '../../../../common/errors/error-types';
import { externalTaskLinks, integrationConnections, projects } from '../../db/schema';
import type {
  CreateExternalTaskLink,
  CreateEpicWithExternalTaskLink,
  CreateEpicWithExternalTaskLinkResult,
  Epic,
  ExternalTaskLink,
  IntegrationConnection,
  IntegrationConnectionLookup,
  IntegrationCredentials,
  IntegrationProvider,
  ReplaceIntegrationConnection,
} from '../../models/domain.models';
import { isSqliteUniqueConstraint } from '../helpers/storage-helpers';
import { IntegrationCredentialCipher } from '../integration-credential-cipher';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';
import type { PreparedEvent } from '../../../events/services/durable-event-registry.service';
import type { FactualEventFactory } from '../../interfaces/storage.interface';

export type VerifyIntegrationCredentials = (credentials: IntegrationCredentials) => Promise<void>;

const CONNECTION_STATE_COLUMNS = {
  id: integrationConnections.id,
  projectId: integrationConnections.projectId,
  provider: integrationConnections.provider,
  legacySourceConnectionId: integrationConnections.legacySourceConnectionId,
  generation: integrationConnections.generation,
  subtaskSyncEnabled: integrationConnections.subtaskSyncEnabled,
  syncSettingRevision: integrationConnections.syncSettingRevision,
  createdAt: integrationConnections.createdAt,
  updatedAt: integrationConnections.updatedAt,
};

export interface IntegrationStorageDelegateDependencies {
  createEpicInCurrentTransaction: (data: CreateEpicWithExternalTaskLink['epic']) => Promise<Epic>;
  getEpic: (id: string) => Promise<Epic>;
  appendEvent: (event: PreparedEvent) => void;
  handleConnectionMutation: (
    connectionId: string,
    provider: IntegrationProvider,
    acknowledgeOrphanRisk: boolean,
  ) => void;
}

export class IntegrationStorageDelegate extends BaseStorageDelegate {
  constructor(
    context: StorageDelegateContext,
    private readonly credentialCipher: IntegrationCredentialCipher,
    private readonly dependencies: IntegrationStorageDelegateDependencies,
  ) {
    super(context);
  }

  async replaceIntegrationConnection(
    data: ReplaceIntegrationConnection,
    verify: VerifyIntegrationCredentials,
    eventFactory?: FactualEventFactory<IntegrationConnection, IntegrationConnection | null>,
  ): Promise<IntegrationConnection> {
    this.validateReplacement(data);
    const projectId = this.resolveReplacementProjectId(data);
    await verify(data.credentials);

    const credentialCiphertext = this.credentialCipher.encrypt(data.credentials);
    return this.txRunner.runImmediateQueued(() => {
      const identity: IntegrationConnectionLookup =
        projectId === null ? data.provider : { projectId, provider: data.provider };
      const previous = this.getIntegrationConnectionSync(identity);
      if (previous) {
        this.dependencies.handleConnectionMutation(
          previous.id,
          previous.provider,
          data.acknowledgeOrphanRisk === true,
        );
      }
      const now = new Date().toISOString();
      if (previous) {
        const settingChanged =
          data.subtaskSyncEnabled !== undefined &&
          data.subtaskSyncEnabled !== previous.subtaskSyncEnabled;
        this.db
          .update(integrationConnections)
          .set({
            credentialCiphertext,
            generation: sql`${integrationConnections.generation} + 1`,
            subtaskSyncEnabled: data.subtaskSyncEnabled ?? previous.subtaskSyncEnabled,
            syncSettingRevision: settingChanged
              ? previous.syncSettingRevision + 1
              : previous.syncSettingRevision,
            updatedAt: now,
          })
          .where(eq(integrationConnections.id, previous.id))
          .run();
      } else {
        this.db
          .insert(integrationConnections)
          .values({
            id: randomUUID(),
            projectId,
            provider: data.provider,
            legacySourceConnectionId: null,
            credentialCiphertext,
            generation: 1,
            subtaskSyncEnabled: data.subtaskSyncEnabled ?? false,
            syncSettingRevision: 1,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }

      const stored = this.getIntegrationConnectionSync(identity);
      if (!stored) {
        throw new StorageError('Integration connection replacement did not persist a row.');
      }
      const event = eventFactory?.(stored, previous);
      if (event) {
        this.dependencies.appendEvent(event);
      }
      return stored;
    });
  }

  async getIntegrationConnection(
    identity: IntegrationConnectionLookup,
  ): Promise<IntegrationConnection | null> {
    return this.getIntegrationConnectionSync(identity);
  }

  private getIntegrationConnectionSync(
    identity: IntegrationConnectionLookup,
  ): IntegrationConnection | null {
    if (typeof identity === 'string') {
      // Provider-only identity is valid only while exactly one row exists;
      // multiple project owners must never be resolved by row order.
      const rows = this.db
        .select(CONNECTION_STATE_COLUMNS)
        .from(integrationConnections)
        .where(eq(integrationConnections.provider, identity))
        .limit(2)
        .all();
      return rows.length === 1 ? rows[0]! : null;
    }
    const predicate =
      'connectionId' in identity
        ? eq(integrationConnections.id, identity.connectionId)
        : and(
            eq(integrationConnections.projectId, identity.projectId),
            eq(integrationConnections.provider, identity.provider),
          );
    const row = this.db
      .select(CONNECTION_STATE_COLUMNS)
      .from(integrationConnections)
      .where(predicate)
      .limit(1)
      .get();
    return row ?? null;
  }

  async getIntegrationConnectionById(connectionId: string): Promise<IntegrationConnection | null> {
    return this.getIntegrationConnectionSync({ connectionId });
  }

  async assignUnassignedIntegrationConnection(
    connectionId: string,
    projectId: string,
    eventFactory?: FactualEventFactory<IntegrationConnection, IntegrationConnection>,
  ): Promise<IntegrationConnection> {
    return this.txRunner.runImmediateQueued(() => {
      const normalizedConnectionId = this.requireIdentifier(connectionId, 'Connection');
      const normalizedProjectId = this.requireIdentifier(projectId, 'Project');
      this.assertProjectExists(normalizedProjectId);
      const previous = this.getIntegrationConnectionSync({ connectionId: normalizedConnectionId });
      if (!previous) {
        throw new NotFoundError('Integration connection', normalizedConnectionId);
      }
      if (previous.projectId !== null) {
        throw new ValidationError('Connection is not an unassigned legacy connection.');
      }
      const occupied = this.getIntegrationConnectionSync({
        projectId: normalizedProjectId,
        provider: previous.provider,
      });
      if (occupied) {
        throw new ConflictError('Project already has a connection for this provider.', {
          projectId: normalizedProjectId,
          provider: previous.provider,
        });
      }
      const result = this.db
        .update(integrationConnections)
        .set({
          projectId: normalizedProjectId,
          legacySourceConnectionId: previous.legacySourceConnectionId ?? previous.id,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(integrationConnections.id, normalizedConnectionId),
            isNull(integrationConnections.projectId),
          ),
        )
        .run();
      if (result.changes !== 1) {
        throw new ConflictError('Legacy connection assignment raced with another mutation.', {
          connectionId: normalizedConnectionId,
        });
      }
      const current = this.getIntegrationConnectionSync({ connectionId: normalizedConnectionId });
      if (!current) {
        throw new StorageError('Assigned integration connection could not be reloaded.');
      }
      const event = eventFactory?.(current, previous);
      if (event) {
        this.dependencies.appendEvent(event);
      }
      return current;
    });
  }

  async listIntegrationConnectionsByLegacySourceConnectionId(
    legacySourceConnectionId: string,
  ): Promise<IntegrationConnection[]> {
    return this.db
      .select(CONNECTION_STATE_COLUMNS)
      .from(integrationConnections)
      .where(
        eq(
          integrationConnections.legacySourceConnectionId,
          this.requireIdentifier(legacySourceConnectionId, 'Legacy source connection'),
        ),
      )
      .orderBy(asc(integrationConnections.projectId), asc(integrationConnections.id));
  }

  async listIntegrationConnections(projectId?: string): Promise<IntegrationConnection[]> {
    if (projectId === undefined) {
      return this.db
        .select(CONNECTION_STATE_COLUMNS)
        .from(integrationConnections)
        .orderBy(asc(integrationConnections.projectId), asc(integrationConnections.provider));
    }
    return this.db
      .select(CONNECTION_STATE_COLUMNS)
      .from(integrationConnections)
      .where(eq(integrationConnections.projectId, this.requireIdentifier(projectId, 'Project')))
      .orderBy(asc(integrationConnections.provider));
  }

  async getIntegrationConnectionCredentials(
    identity: IntegrationConnectionLookup,
  ): Promise<IntegrationCredentials | null> {
    const connection = this.getIntegrationConnectionSync(identity);
    if (!connection) {
      return null;
    }
    const rows = await this.db
      .select({ credentialCiphertext: integrationConnections.credentialCiphertext })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connection.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    const credentials = this.credentialCipher.decrypt(row.credentialCiphertext);
    if (credentials.provider !== connection.provider) {
      throw new StorageError('Stored integration credentials do not match their provider.');
    }
    return credentials;
  }

  async getIntegrationConnectionCredentialsById(
    connectionId: string,
  ): Promise<IntegrationCredentials | null> {
    return this.getIntegrationConnectionCredentials({ connectionId });
  }

  async disconnectIntegrationConnection(
    identity: IntegrationConnectionLookup,
    eventFactory?: (connection: IntegrationConnection) => PreparedEvent | null,
    options?: { acknowledgeOrphanRisk?: boolean },
  ): Promise<boolean> {
    return this.txRunner.runImmediateQueued(() => {
      const previous = this.getIntegrationConnectionSync(identity);
      if (!previous) {
        return false;
      }
      this.dependencies.handleConnectionMutation(
        previous.id,
        previous.provider,
        options?.acknowledgeOrphanRisk === true,
      );
      const result = this.db
        .delete(integrationConnections)
        .where(eq(integrationConnections.id, previous.id))
        .run();
      if (result.changes > 0) {
        const event = eventFactory?.(previous);
        if (event) {
          this.dependencies.appendEvent(event);
        }
      }
      return result.changes > 0;
    });
  }

  async disconnectIntegrationConnectionById(
    connectionId: string,
    eventFactory?: (connection: IntegrationConnection) => PreparedEvent | null,
    options?: { acknowledgeOrphanRisk?: boolean },
  ): Promise<boolean> {
    return this.disconnectIntegrationConnection({ connectionId }, eventFactory, options);
  }

  async disconnectUnassignedIntegrationConnection(
    connectionId: string,
    eventFactory?: (connection: IntegrationConnection) => PreparedEvent | null,
    options?: { acknowledgeOrphanRisk?: boolean },
  ): Promise<boolean> {
    return this.txRunner.runImmediateQueued(() => {
      const normalizedConnectionId = this.requireIdentifier(connectionId, 'Connection');
      const previous = this.getIntegrationConnectionSync({ connectionId: normalizedConnectionId });
      if (!previous) {
        throw new NotFoundError('Integration connection', normalizedConnectionId);
      }
      if (previous.projectId !== null) {
        throw new ValidationError('Connection is not an unassigned legacy connection.');
      }
      this.dependencies.handleConnectionMutation(
        previous.id,
        previous.provider,
        options?.acknowledgeOrphanRisk === true,
      );
      const result = this.db
        .delete(integrationConnections)
        .where(
          and(
            eq(integrationConnections.id, normalizedConnectionId),
            isNull(integrationConnections.projectId),
          ),
        )
        .run();
      if (result.changes !== 1) {
        throw new ConflictError('Legacy connection disconnect raced with another mutation.', {
          connectionId: normalizedConnectionId,
        });
      }
      const event = eventFactory?.(previous);
      if (event) {
        this.dependencies.appendEvent(event);
      }
      return true;
    });
  }

  async updateIntegrationConnectionSyncSetting(
    identity: IntegrationConnectionLookup,
    subtaskSyncEnabled: boolean,
    eventFactory?: FactualEventFactory<IntegrationConnection, IntegrationConnection>,
  ): Promise<IntegrationConnection> {
    return this.txRunner.runImmediateQueued(() => {
      const previous = this.getIntegrationConnectionSync(identity);
      if (!previous) {
        throw new NotFoundError('Integration connection', this.describeIdentity(identity));
      }
      if (previous.subtaskSyncEnabled === subtaskSyncEnabled) {
        return previous;
      }
      this.db
        .update(integrationConnections)
        .set({
          subtaskSyncEnabled,
          syncSettingRevision: previous.syncSettingRevision + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(integrationConnections.id, previous.id))
        .run();
      const current = this.getIntegrationConnectionSync({ connectionId: previous.id });
      if (!current) {
        throw new StorageError('Integration sync setting update lost its connection row.');
      }
      const event = eventFactory?.(current, previous);
      if (event) {
        this.dependencies.appendEvent(event);
      }
      return current;
    });
  }

  async updateIntegrationConnectionSyncSettingById(
    connectionId: string,
    subtaskSyncEnabled: boolean,
    eventFactory?: FactualEventFactory<IntegrationConnection, IntegrationConnection>,
  ): Promise<IntegrationConnection> {
    return this.updateIntegrationConnectionSyncSetting(
      { connectionId },
      subtaskSyncEnabled,
      eventFactory,
    );
  }

  async createExternalTaskLink(data: CreateExternalTaskLink): Promise<ExternalTaskLink> {
    const normalized = await this.normalizeLinkInput(data);
    const link: ExternalTaskLink = {
      ...normalized,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.db.insert(externalTaskLinks).values(link);
    } catch (error) {
      if (isSqliteUniqueConstraint(error)) {
        throw new ConflictError('External task is already linked to this project.', {
          projectId: link.projectId,
          provider: link.provider,
          remoteScopeKey: link.remoteScopeKey,
          remoteTaskId: link.remoteTaskId,
        });
      }
      throw error;
    }
    return link;
  }

  async createEpicWithExternalTaskLink(
    data: CreateEpicWithExternalTaskLink,
    eventFactory?: (result: CreateEpicWithExternalTaskLinkResult) => PreparedEvent | null,
  ): Promise<CreateEpicWithExternalTaskLinkResult> {
    const remoteScopeKey = data.externalTaskLink.remoteScopeKey.trim();
    const remoteTaskId = data.externalTaskLink.remoteTaskId.trim();
    if (!remoteScopeKey || !remoteTaskId) {
      throw new ValidationError('Remote scope and remote task identifiers are required.');
    }
    const projectId = data.epic.projectId.trim();
    if (!projectId) {
      throw new ValidationError('Project identity is required to link an external task.');
    }

    const existing = await this.findExternalTaskLink(
      projectId,
      data.externalTaskLink.provider,
      remoteScopeKey,
      remoteTaskId,
    );
    if (existing) {
      return this.loadExistingImport(existing);
    }

    let uniquenessConflict: ConflictError | null = null;
    try {
      return await this.txRunner.runImmediateAsync(async () => {
        const epic = await this.dependencies.createEpicInCurrentTransaction(data.epic);
        const externalTaskLink = await this.createExternalTaskLink({
          ...data.externalTaskLink,
          epicId: epic.id,
          remoteScopeKey,
          remoteTaskId,
        });
        const result = { epic, externalTaskLink, created: true };
        const event = eventFactory?.(result);
        if (event) {
          this.dependencies.appendEvent(event);
        }
        return result;
      });
    } catch (error) {
      if (
        !this.isMatchingExternalTaskLinkConflict(
          error,
          projectId,
          data.externalTaskLink.provider,
          remoteScopeKey,
          remoteTaskId,
        )
      ) {
        throw error;
      }
      uniquenessConflict = error;
    }

    const winner = await this.findExternalTaskLink(
      projectId,
      data.externalTaskLink.provider,
      remoteScopeKey,
      remoteTaskId,
    );
    if (!winner) {
      throw uniquenessConflict;
    }
    return this.loadExistingImport(winner);
  }

  async findExternalTaskLink(
    projectId: string,
    provider: IntegrationProvider,
    remoteScopeKey: string,
    remoteTaskId: string,
  ): Promise<ExternalTaskLink | null> {
    const rows = await this.db
      .select()
      .from(externalTaskLinks)
      .where(
        and(
          eq(externalTaskLinks.projectId, projectId),
          eq(externalTaskLinks.provider, provider),
          eq(externalTaskLinks.remoteScopeKey, remoteScopeKey),
          eq(externalTaskLinks.remoteTaskId, remoteTaskId),
        ),
      )
      .limit(1);
    return (rows[0] as ExternalTaskLink | undefined) ?? null;
  }

  async listExternalTaskLinksByRemoteScope(
    provider: IntegrationProvider,
    remoteScopeKey: string,
  ): Promise<ExternalTaskLink[]> {
    return this.db
      .select()
      .from(externalTaskLinks)
      .where(
        and(
          eq(externalTaskLinks.provider, provider),
          eq(externalTaskLinks.remoteScopeKey, remoteScopeKey),
        ),
      )
      .orderBy(asc(externalTaskLinks.remoteTaskId)) as Promise<ExternalTaskLink[]>;
  }

  async listExternalTaskLinksByRemoteTask(
    provider: IntegrationProvider,
    remoteTaskId: string,
  ): Promise<ExternalTaskLink[]> {
    return this.db
      .select()
      .from(externalTaskLinks)
      .where(
        and(
          eq(externalTaskLinks.provider, provider),
          eq(externalTaskLinks.remoteTaskId, remoteTaskId),
        ),
      )
      .orderBy(asc(externalTaskLinks.remoteScopeKey)) as Promise<ExternalTaskLink[]>;
  }

  async listExternalTaskLinksForEpic(epicId: string): Promise<ExternalTaskLink[]> {
    return this.db
      .select()
      .from(externalTaskLinks)
      .where(eq(externalTaskLinks.epicId, epicId))
      .orderBy(asc(externalTaskLinks.createdAt)) as Promise<ExternalTaskLink[]>;
  }

  /**
   * One IN query for a bounded Epic batch. The API limit (1,000 IDs) stays
   * below the bundled SQLite bind-variable limit, so no chunking is needed.
   */
  async listExternalTaskLinksForEpics(epicIds: string[]): Promise<ExternalTaskLink[]> {
    return this.db
      .select()
      .from(externalTaskLinks)
      .where(inArray(externalTaskLinks.epicId, epicIds))
      .orderBy(asc(externalTaskLinks.epicId), asc(externalTaskLinks.createdAt)) as Promise<
      ExternalTaskLink[]
    >;
  }

  private assertProjectExists(projectId: string): void {
    const project = this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
      .get();
    if (!project) {
      throw new NotFoundError('Project', projectId);
    }
  }

  private resolveReplacementProjectId(data: ReplaceIntegrationConnection): string | null {
    const requestedProjectId = data.projectId?.trim();
    if (requestedProjectId) {
      this.assertProjectExists(requestedProjectId);
      return requestedProjectId;
    }

    // Missing ownership is accepted only when both the provider row and the
    // project directory identify one unambiguous owner.
    const providerRows = this.db
      .select(CONNECTION_STATE_COLUMNS)
      .from(integrationConnections)
      .where(eq(integrationConnections.provider, data.provider))
      .limit(2)
      .all();
    if (providerRows.length === 1) {
      return providerRows[0]!.projectId;
    }
    if (providerRows.length > 1) {
      throw new ValidationError('Project identity is required for an ambiguous provider.');
    }

    const projectsInStore = this.db.select({ id: projects.id }).from(projects).limit(2).all();
    if (projectsInStore.length === 1) {
      return projectsInStore[0]!.id;
    }
    throw new ValidationError(
      'Project identity is required when creating an integration connection.',
    );
  }

  private requireIdentifier(value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new ValidationError(`${label} identifier is required.`);
    }
    return normalized;
  }

  private describeIdentity(identity: IntegrationConnectionLookup): string {
    if (typeof identity === 'string') {
      return identity;
    }
    return 'connectionId' in identity
      ? identity.connectionId
      : `${identity.projectId}/${identity.provider}`;
  }

  private validateReplacement(data: ReplaceIntegrationConnection): void {
    if (data.projectId !== undefined && !data.projectId.trim()) {
      throw new ValidationError('Project identifier is required.');
    }
    if (data.credentials.provider !== data.provider) {
      throw new ValidationError('Integration credentials must match the selected provider.');
    }
    if (!data.credentials.token.trim()) {
      throw new ValidationError('Integration credential token is required.');
    }
    if (
      data.credentials.provider === 'jira' &&
      (!data.credentials.siteUrl.trim() || !data.credentials.email.trim())
    ) {
      throw new ValidationError('Jira site URL and email are required.');
    }
  }

  private async normalizeLinkInput(
    data: CreateExternalTaskLink,
  ): Promise<CreateExternalTaskLink & { projectId: string }> {
    const remoteScopeKey = data.remoteScopeKey.trim();
    const remoteTaskId = data.remoteTaskId.trim();
    if (!data.epicId.trim() || !remoteScopeKey || !remoteTaskId) {
      throw new ValidationError('Epic, remote scope, and remote task identifiers are required.');
    }
    if (
      !data.sourceSnapshot ||
      typeof data.sourceSnapshot !== 'object' ||
      Array.isArray(data.sourceSnapshot)
    ) {
      throw new ValidationError('External task source snapshot must be an object.');
    }
    const epic = await this.dependencies.getEpic(data.epicId);
    if (data.connectionId) {
      const connection = await this.getIntegrationConnectionById(data.connectionId);
      if (!connection) {
        throw new NotFoundError('Integration connection', data.connectionId);
      }
      if (connection.provider !== data.provider) {
        throw new ValidationError('External task link provider must match its connection.');
      }
      if (connection.projectId === null || connection.projectId !== epic.projectId) {
        throw new ValidationError('External task link project must match its connection.');
      }
    }
    // Project ownership is derived from the owning Epic — never trusted
    // from the caller — and rides the link as durable task identity.
    return { ...data, projectId: epic.projectId, remoteScopeKey, remoteTaskId };
  }

  private async loadExistingImport(
    externalTaskLink: ExternalTaskLink,
  ): Promise<CreateEpicWithExternalTaskLinkResult> {
    return {
      epic: await this.dependencies.getEpic(externalTaskLink.epicId),
      externalTaskLink,
      created: false,
    };
  }

  private isMatchingExternalTaskLinkConflict(
    error: unknown,
    projectId: string,
    provider: IntegrationProvider,
    remoteScopeKey: string,
    remoteTaskId: string,
  ): error is ConflictError {
    if (!(error instanceof ConflictError)) {
      return false;
    }
    return (
      error.details?.projectId === projectId &&
      error.details?.provider === provider &&
      error.details.remoteScopeKey === remoteScopeKey &&
      error.details.remoteTaskId === remoteTaskId
    );
  }
}
