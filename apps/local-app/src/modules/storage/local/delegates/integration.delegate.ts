import type { ReplicaExternalTaskLinkRow } from '@devchain/shared';
import type {
  DeliveredIntegrationsResult,
  DeliveredLinkSync,
  FactualEventFactory,
  IntegrationStorage,
  VerifyIntegrationCredentials,
} from '../../interfaces/storage.interface';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import {
  AppError,
  ConflictError,
  NotFoundError,
  StorageError,
  ValidationError,
  VaultUnavailableError,
} from '../../../../common/errors/error-types';
import {
  epics,
  externalEstimateLogStates,
  externalManagedSubtaskLinks,
  externalTaskLinks,
  integrationConnections,
  projects,
} from '../../db/schema';
import type {
  CreateExternalTaskLink,
  DeliveredIntegrationConnection,
  CreateEpicWithExternalTaskLink,
  CreateEpicWithExternalTaskLinkResult,
  Epic,
  ExternalEstimateLogIdentity,
  ExternalTaskLink,
  ExternalTaskLinkChangeResult,
  ExternalTaskLinkInput,
  ExternalTaskLinkWriteOptions,
  ImportHostedExternalTask,
  ImportHostedExternalTaskResult,
  IntegrationConnection,
  IntegrationConnectionLookup,
  IntegrationCredentials,
  IntegrationProvider,
  ReplaceIntegrationConnection,
  VaultStoreMigrationResult,
} from '../../models/domain.models';
import { isOrdinaryExternalTaskLink } from '../../models/domain.models';
import { closeLinkReleaseAttempt, openLinkReleaseAttempt } from '../helpers/pending-link-releases';
import { isSqliteUniqueConstraint } from '../helpers/storage-helpers';
import { externalImportIdempotencyKey } from '../helpers/external-import-key';
import {
  assertLinkProjectSeeded,
  markLinkProjectsSeeded,
  readSeededLinkProjects,
  writeLinkReceipt,
} from '../helpers/external-link-receipts';
import {
  INTEGRATION_CREDENTIALS_CONTEXT,
  parseIntegrationCredentials,
} from '../integration-credential-cipher';
import {
  migrateStoredSecrets,
  type StoredSecretBinding,
  type StoredSecretCodec,
} from '../stored-secret-codec';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';
import type { PreparedEvent } from '../../../events/services/durable-event-registry.service';

/** Recognition links belong to managed sync; no unlink removes one. */
function managedLinkRefusal(epicId: string, linkId: string): AppError {
  return new AppError(
    'This link belongs to a managed subtask; managed sync removes it.',
    'EXTERNAL_TASK_LINK_MANAGED',
    409,
    { epicId, linkId },
  );
}

function credentialBinding(connectionId: string): StoredSecretBinding {
  return {
    domain: 'integration-connection',
    recordId: connectionId,
    field: 'credentials',
    legacyContext: INTEGRATION_CREDENTIALS_CONTEXT,
  };
}

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
  createEpicWithinTransaction: (data: CreateEpicWithExternalTaskLink['epic']) => Promise<Epic>;
  getEpic: (id: string) => Promise<Epic>;
  appendEvent: (event: PreparedEvent) => void;
  handleConnectionMutation: (
    connectionId: string,
    provider: IntegrationProvider,
    acknowledgeOrphanRisk: boolean,
  ) => void;
}

export class IntegrationStorageDelegate
  extends BaseStorageDelegate
  implements
    Pick<
      IntegrationStorage,
      | 'replaceIntegrationConnection'
      | 'getIntegrationConnection'
      | 'getIntegrationConnectionById'
      | 'assignUnassignedIntegrationConnection'
      | 'listIntegrationConnectionsByLegacySourceConnectionId'
      | 'listIntegrationConnections'
      | 'replaceDeliveredIntegrationConnections'
      | 'readExternalLinkSyncState'
      | 'listOrdinaryExternalTaskLinkRows'
      | 'listExternalLinkReceiptIds'
      | 'assertExternalLinkReleaseAllowed'
      | 'beginExternalLinkRelease'
      | 'closeExternalLinkReleaseAttempt'
      | 'getIntegrationConnectionCredentials'
      | 'getIntegrationConnectionCredentialsById'
      | 'disconnectIntegrationConnection'
      | 'disconnectIntegrationConnectionById'
      | 'disconnectUnassignedIntegrationConnection'
      | 'updateIntegrationConnectionSyncSetting'
      | 'updateIntegrationConnectionSyncSettingById'
      | 'createExternalTaskLink'
      | 'createRemoteProjectExternalTaskLink'
      | 'setEpicExternalTaskLink'
      | 'deleteExternalTaskLink'
      | 'createEpicWithExternalTaskLink'
      | 'importHostedExternalTask'
      | 'findExternalTaskLink'
      | 'listExternalTaskLinksByRemoteScope'
      | 'listExternalTaskLinksByRemoteTask'
      | 'listExternalTaskLinksForEpic'
      | 'listExternalTaskLinksForEpics'
    >
{
  constructor(
    context: StorageDelegateContext,
    private readonly codec: StoredSecretCodec,
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
    this.codec.assertCanSeal();
    await verify(data.credentials);

    return this.txRunner.runImmediateQueued(() => {
      const identity: IntegrationConnectionLookup =
        projectId === null ? data.provider : { projectId, provider: data.provider };
      const previous = this.getIntegrationConnectionSync(identity);
      const connectionId = previous?.id ?? randomUUID();
      const credentialCiphertext = this.codec.seal(
        credentialBinding(connectionId),
        JSON.stringify(data.credentials),
      );
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
            id: connectionId,
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

  async replaceDeliveredIntegrationConnections(
    connections: readonly DeliveredIntegrationConnection[],
    links: DeliveredLinkSync = {},
  ): Promise<DeliveredIntegrationsResult> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const wanted = new Set(connections.map((connection) => connection.id));
      const current = this.db
        .select({ id: integrationConnections.id })
        .from(integrationConnections)
        .all();
      // Deletes go first: a reconnect at home gives the same project and provider a new
      // id, and the old row would otherwise hit the project/provider unique index.
      for (const row of current) {
        if (!wanted.has(row.id)) {
          this.db.delete(integrationConnections).where(eq(integrationConnections.id, row.id)).run();
        }
      }
      const projectExists = this.rawClient.prepare('SELECT 1 FROM projects WHERE id = ?');
      const now = new Date().toISOString();
      const applied: DeliveredIntegrationConnection[] = [];
      for (const connection of connections) {
        // A detaching project stays in home's push after this VM released it.
        if (!projectExists.get(connection.projectId)) continue;
        applied.push(connection);
        this.db
          .insert(integrationConnections)
          .values({
            id: connection.id,
            projectId: connection.projectId,
            provider: connection.provider,
            legacySourceConnectionId: null,
            credentialCiphertext: '',
            generation: connection.generation,
            subtaskSyncEnabled: false,
            syncSettingRevision: 1,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: integrationConnections.id,
            set: {
              projectId: connection.projectId,
              provider: connection.provider,
              credentialCiphertext: '',
              generation: connection.generation,
              subtaskSyncEnabled: false,
              updatedAt: now,
            },
          })
          .run();
      }
      const deleteReceipt = this.rawClient.prepare(
        'DELETE FROM external_link_receipts WHERE id = ?',
      );
      for (const id of links.ackedReceiptIds ?? []) deleteReceipt.run(id);
      this.seedLinksSync(links.seed ?? []);
      const seededProjectIds = Object.keys(readSeededLinkProjects(this.rawClient))
        .filter((projectId) => projectExists.get(projectId))
        .sort();
      return { connections: applied, seededProjectIds };
    });
  }

  /**
   * First seed of a project only: a later one would bring back links the VM unlinked.
   * Links of epics this VM lacks are skipped, and so is a connection it does not hold.
   */
  private seedLinksSync(seed: NonNullable<DeliveredLinkSync['seed']>): void {
    const seeded = readSeededLinkProjects(this.rawClient);
    const projectExists = this.rawClient.prepare('SELECT 1 FROM projects WHERE id = ?');
    const epicInProject = this.rawClient.prepare(
      'SELECT 1 FROM epics WHERE id = ? AND project_id = ?',
    );
    const connectionInProject = this.rawClient.prepare(
      'SELECT 1 FROM integration_connections WHERE id = ? AND project_id = ?',
    );
    const insert = this.rawClient.prepare(
      `INSERT INTO external_task_links
         (id, epic_id, project_id, connection_id, provider, remote_scope_key, remote_task_id,
          source_snapshot, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    );
    const newlySeeded: string[] = [];
    for (const { projectId, links } of seed) {
      if (projectId in seeded || !projectExists.get(projectId)) continue;
      for (const link of links) {
        if (!epicInProject.get(link.epic_id, projectId)) continue;
        const connectionId =
          link.connection_id && connectionInProject.get(link.connection_id, projectId)
            ? link.connection_id
            : null;
        insert.run(
          link.id,
          link.epic_id,
          projectId,
          connectionId,
          link.provider,
          link.remote_scope_key,
          link.remote_task_id,
          link.source_snapshot,
          link.created_at,
          link.updated_at,
        );
      }
      newlySeeded.push(projectId);
    }
    markLinkProjectsSeeded(this.rawClient, newlySeeded);
  }

  async readExternalLinkSyncState(): Promise<{
    seededProjectIds: string[];
    pendingReceipts: number;
  }> {
    const { pending } = this.rawClient
      .prepare('SELECT COUNT(*) AS pending FROM external_link_receipts')
      .get() as { pending: number };
    return {
      seededProjectIds: Object.keys(readSeededLinkProjects(this.rawClient)).sort(),
      pendingReceipts: pending,
    };
  }

  async listOrdinaryExternalTaskLinkRows(projectId: string): Promise<ReplicaExternalTaskLinkRow[]> {
    return this.rawClient
      .prepare(
        `SELECT id, epic_id, project_id, connection_id, provider, remote_scope_key, remote_task_id,
                source_snapshot, created_at, updated_at
         FROM external_task_links
         WHERE project_id = ? AND json_extract(source_snapshot, '$.managedProjectionId') IS NULL
         ORDER BY id`,
      )
      .all(projectId) as ReplicaExternalTaskLinkRow[];
  }

  async listExternalLinkReceiptIds(projectIds: readonly string[]): Promise<string[]> {
    if (projectIds.length === 0) return [];
    return (
      this.rawClient
        .prepare(
          `SELECT id FROM external_link_receipts WHERE project_id IN (${projectIds
            .map(() => '?')
            .join(', ')}) ORDER BY seq, id`,
        )
        .all(...projectIds) as Array<{ id: string }>
    ).map(({ id }) => id);
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
    const credentials = this.openCredentials(connection.id, row.credentialCiphertext);
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

  async migrateIntegrationCredentialsToVault(): Promise<VaultStoreMigrationResult> {
    return migrateStoredSecrets({
      store: 'integration_connections',
      codec: this.codec,
      txRunner: this.txRunner,
      binding: credentialBinding,
      listEnvelopes: () =>
        this.db
          .select({
            id: integrationConnections.id,
            envelope: integrationConnections.credentialCiphertext,
          })
          .from(integrationConnections)
          .all(),
      readEnvelope: (id) =>
        this.db
          .select({ envelope: integrationConnections.credentialCiphertext })
          .from(integrationConnections)
          .where(eq(integrationConnections.id, id))
          .get()?.envelope,
      replaceEnvelope: (id, next, previous) =>
        this.db
          .update(integrationConnections)
          .set({ credentialCiphertext: next })
          .where(
            and(
              eq(integrationConnections.id, id),
              eq(integrationConnections.credentialCiphertext, previous),
            ),
          )
          .run().changes === 1,
    });
  }

  /** Lets `VaultUnavailableError` through: a locked Vault is not a broken credential. */
  private openCredentials(connectionId: string, envelope: string): IntegrationCredentials {
    try {
      return parseIntegrationCredentials(
        this.codec.open(credentialBinding(connectionId), envelope),
      );
    } catch (error) {
      if (error instanceof VaultUnavailableError) throw error;
      throw new StorageError('Unable to decrypt integration credentials.');
    }
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

  async createRemoteProjectExternalTaskLink(
    data: CreateExternalTaskLink,
  ): Promise<ExternalTaskLink> {
    return this.createExternalTaskLink(data);
  }

  async setEpicExternalTaskLink(
    epicId: string,
    input: ExternalTaskLinkInput,
    eventFactory?: (link: ExternalTaskLink) => PreparedEvent | null,
    options: ExternalTaskLinkWriteOptions = {},
  ): Promise<ExternalTaskLinkChangeResult> {
    const remoteScopeKey = input.remoteScopeKey.trim();
    const remoteTaskId = input.remoteTaskId.trim();
    if (!epicId.trim() || !remoteScopeKey || !remoteTaskId) {
      throw new ValidationError('Epic, remote scope, and remote task identifiers are required.');
    }
    if (
      !input.sourceSnapshot ||
      typeof input.sourceSnapshot !== 'object' ||
      Array.isArray(input.sourceSnapshot)
    ) {
      throw new ValidationError('External task source snapshot must be an object.');
    }
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const epic = this.db
        .select({ projectId: epics.projectId })
        .from(epics)
        .where(eq(epics.id, epicId))
        .get();
      if (!epic) {
        throw new NotFoundError('Epic', epicId);
      }
      if (options.vmHosted) assertLinkProjectSeeded(this.rawClient, epic.projectId);
      const connection = this.db
        .select(CONNECTION_STATE_COLUMNS)
        .from(integrationConnections)
        .where(eq(integrationConnections.id, input.connectionId))
        .get();
      if (
        !connection ||
        connection.projectId !== epic.projectId ||
        connection.provider !== input.provider ||
        connection.generation !== input.connectionGeneration
      ) {
        throw new AppError(
          'The integration connection changed after the remote task was read; try again.',
          'INTEGRATION_CONNECTION_CHANGED',
          409,
          { provider: input.provider, retryable: true },
        );
      }

      const ordinary = this.listEpicLinksSync(epicId).find(isOrdinaryExternalTaskLink);
      if (
        ordinary &&
        ordinary.provider === input.provider &&
        ordinary.remoteScopeKey === remoteScopeKey &&
        ordinary.remoteTaskId === remoteTaskId &&
        this.isDetachedSync(ordinary)
      ) {
        // The link keeps its id, so a pending estimate on this task stays
        // attached and can be resolved through the new connection.
        const rebound: ExternalTaskLink = {
          ...ordinary,
          connectionId: connection.id,
          updatedAt: new Date().toISOString(),
        };
        this.db
          .update(externalTaskLinks)
          .set({ connectionId: rebound.connectionId, updatedAt: rebound.updatedAt })
          .where(eq(externalTaskLinks.id, ordinary.id))
          .run();
        const event = eventFactory?.(rebound);
        if (event) {
          this.dependencies.appendEvent(event);
        }
        return {
          link: rebound,
          releasedManagedLinkIds: [],
          rebound: true,
          ...this.receiptFor(options, 'set', rebound),
        };
      }
      if (ordinary) {
        throw new AppError(
          'This epic is already linked to an external task; unlink it first.',
          'EPIC_ALREADY_LINKED',
          409,
          { epicId, linkId: ordinary.id },
        );
      }
      const { releasedManagedLinkIds, removedLinks } = this.releaseManagedProjectionsSync(
        eq(externalManagedSubtaskLinks.epicIdSnapshot, epicId),
      );
      const taken = this.db
        .select({ id: externalTaskLinks.id, epicId: externalTaskLinks.epicId })
        .from(externalTaskLinks)
        .where(
          and(
            eq(externalTaskLinks.projectId, epic.projectId),
            eq(externalTaskLinks.provider, input.provider),
            eq(externalTaskLinks.remoteScopeKey, remoteScopeKey),
            eq(externalTaskLinks.remoteTaskId, remoteTaskId),
          ),
        )
        .get();
      if (taken) {
        throw new AppError(
          'The external task is already linked to an epic in this project.',
          'EXTERNAL_TASK_ALREADY_LINKED',
          409,
          { epicId: taken.epicId, linkId: taken.id },
        );
      }

      const now = new Date().toISOString();
      const link: ExternalTaskLink = {
        id: randomUUID(),
        epicId,
        projectId: epic.projectId,
        connectionId: connection.id,
        provider: input.provider,
        remoteScopeKey,
        remoteTaskId,
        sourceSnapshot: input.sourceSnapshot,
        createdAt: now,
        updatedAt: now,
      };
      this.db.insert(externalTaskLinks).values(link).run();
      // After the insert: linking the epic to its own managed subtask keeps that task linked.
      this.assertNoPendingEstimateSync(removedLinks);
      const event = eventFactory?.(link);
      if (event) {
        this.dependencies.appendEvent(event);
      }
      return { link, releasedManagedLinkIds, ...this.receiptFor(options, 'set', link) };
    });
  }

  async deleteExternalTaskLink(
    epicId: string,
    linkId: string | null,
    eventFactory?: (link: ExternalTaskLink) => PreparedEvent | null,
    options: ExternalTaskLinkWriteOptions = {},
  ): Promise<ExternalTaskLinkChangeResult> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const epic = this.db
        .select({ projectId: epics.projectId })
        .from(epics)
        .where(eq(epics.id, epicId))
        .get();
      if (!epic) {
        throw new NotFoundError('Epic', epicId);
      }
      if (options.vmHosted) assertLinkProjectSeeded(this.rawClient, epic.projectId);
      const links = this.listEpicLinksSync(epicId);
      const link = linkId
        ? links.find((candidate) => candidate.id === linkId)
        : links.find(isOrdinaryExternalTaskLink);
      if (!link) {
        if (linkId) {
          throw new AppError(
            'This epic is no longer linked to that task; refresh and try again.',
            'EXTERNAL_TASK_LINK_STALE',
            409,
            { epicId, linkId },
          );
        }
        throw new AppError('This epic is not linked to an external task.', 'EPIC_NOT_LINKED', 409, {
          epicId,
        });
      }
      if (!isOrdinaryExternalTaskLink(link)) throw managedLinkRefusal(epicId, link.id);

      const { releasedManagedLinkIds, removedLinks } = this.releaseManagedProjectionsSync(
        eq(externalManagedSubtaskLinks.parentSourceLinkIdSnapshot, link.id),
      );
      this.db.delete(externalTaskLinks).where(eq(externalTaskLinks.id, link.id)).run();
      // An import's key finds an epic it never linked; after an unlink of that task it must
      // not. The key travels with the epic, so an unlink at home retires it too. Only this
      // task's key goes: an unfinished import of another task keeps its own.
      this.rawClient
        .prepare(
          `UPDATE epics SET data = json_remove(data, '$.idempotencyKey'), updated_at = ?
           WHERE id = ? AND json_extract(data, '$.idempotencyKey') = ?`,
        )
        .run(
          new Date().toISOString(),
          epicId,
          externalImportIdempotencyKey(link.provider, link.remoteScopeKey, link.remoteTaskId),
        );
      this.assertNoPendingEstimateSync([link, ...removedLinks]);
      const event = eventFactory?.(link);
      if (event) {
        this.dependencies.appendEvent(event);
      }
      return { link, releasedManagedLinkIds, ...this.receiptFor(options, 'release', link) };
    });
  }

  /** Home replays the receipt to release the managed projections the VM never holds. */
  private receiptFor(
    options: ExternalTaskLinkWriteOptions,
    kind: 'set' | 'release',
    link: ExternalTaskLink,
  ): { receiptId?: string } {
    return options.vmHosted ? { receiptId: writeLinkReceipt(this.rawClient, kind, link) } : {};
  }

  /** A disconnect leaves the link's connection unset; a dangling id counts too. */
  private isDetachedSync(link: ExternalTaskLink): boolean {
    if (link.connectionId === null) {
      return true;
    }
    return !this.db
      .select({ id: integrationConnections.id })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, link.connectionId))
      .get();
  }

  private listEpicLinksSync(epicId: string): ExternalTaskLink[] {
    return this.db
      .select()
      .from(externalTaskLinks)
      .where(eq(externalTaskLinks.epicId, epicId))
      .orderBy(asc(externalTaskLinks.createdAt), asc(externalTaskLinks.id))
      .all() as ExternalTaskLink[];
  }

  /**
   * Refuses a write that leaves a remote task with a pending estimate
   * operation but no link in its project: resolving that operation needs the
   * link. Run it after every link change of the write, inside its transaction.
   * Settled estimate history is never touched.
   */
  private assertNoPendingEstimateSync(
    removedLinks: readonly ExternalTaskLink[],
    /** Links still stored that the caller's write would delete, for a check before it. */
    alsoRemoved: ReadonlySet<string> = new Set(),
  ): void {
    for (const removed of removedLinks) {
      const identity = and(
        eq(externalTaskLinks.projectId, removed.projectId),
        eq(externalTaskLinks.provider, removed.provider),
        eq(externalTaskLinks.remoteScopeKey, removed.remoteScopeKey),
        eq(externalTaskLinks.remoteTaskId, removed.remoteTaskId),
        alsoRemoved.size > 0 ? notInArray(externalTaskLinks.id, [...alsoRemoved]) : undefined,
      );
      if (
        this.db.select({ id: externalTaskLinks.id }).from(externalTaskLinks).where(identity).get()
      ) {
        continue;
      }
      const pending = this.db
        .select({ operationId: externalEstimateLogStates.pendingOperationId })
        .from(externalEstimateLogStates)
        .where(
          and(
            eq(externalEstimateLogStates.projectId, removed.projectId),
            eq(externalEstimateLogStates.provider, removed.provider),
            eq(externalEstimateLogStates.remoteScopeKey, removed.remoteScopeKey),
            eq(externalEstimateLogStates.remoteTaskId, removed.remoteTaskId),
            isNotNull(externalEstimateLogStates.pendingOperationId),
          ),
        )
        .get();
      if (pending?.operationId) {
        const remoteKey =
          typeof removed.sourceSnapshot.remoteKey === 'string' && removed.sourceSnapshot.remoteKey
            ? removed.sourceSnapshot.remoteKey
            : removed.remoteTaskId;
        throw new AppError(
          `Task ${remoteKey} has a pending time estimate. Verify or resolve it on its epic first, then change the link.`,
          'EXTERNAL_TASK_ESTIMATE_PENDING',
          409,
          { epicId: removed.epicId, remoteKey, operationId: pending.operationId },
        );
      }
    }
  }

  /**
   * Forgets managed projections without any vendor call: their remote
   * subtasks stay as they are. Deletes each projection's recognition link
   * with it, so managed sync never sees the subtask again.
   */
  private releaseManagedProjectionsSync(condition: SQL | undefined): {
    releasedManagedLinkIds: string[];
    removedLinks: ExternalTaskLink[];
  } {
    const rows = this.managedProjectionsSync(condition);
    const removedLinks: ExternalTaskLink[] = [];
    for (const row of rows) {
      if (row.remoteTaskId) {
        const recognitionLinks = this.recognitionLinksSync({
          ...row,
          remoteTaskId: row.remoteTaskId,
        });
        for (const recognition of recognitionLinks) {
          this.db.delete(externalTaskLinks).where(eq(externalTaskLinks.id, recognition.id)).run();
        }
        removedLinks.push(...recognitionLinks);
      }
      this.db
        .delete(externalManagedSubtaskLinks)
        .where(eq(externalManagedSubtaskLinks.id, row.id))
        .run();
    }
    return { releasedManagedLinkIds: rows.map((row) => row.id), removedLinks };
  }

  private managedProjectionsSync(condition: SQL | undefined) {
    return this.db
      .select({
        id: externalManagedSubtaskLinks.id,
        epicIdSnapshot: externalManagedSubtaskLinks.epicIdSnapshot,
        provider: externalManagedSubtaskLinks.provider,
        remoteScopeKey: externalManagedSubtaskLinks.remoteScopeKey,
        remoteTaskId: externalManagedSubtaskLinks.remoteTaskId,
      })
      .from(externalManagedSubtaskLinks)
      .where(condition)
      .orderBy(asc(externalManagedSubtaskLinks.id))
      .all();
  }

  /** The recognition links of one managed projection: the projected epic's managed links. */
  private recognitionLinksSync(projection: {
    epicIdSnapshot: string;
    provider: IntegrationProvider;
    remoteScopeKey: string;
    remoteTaskId: string;
  }): ExternalTaskLink[] {
    return this.db
      .select()
      .from(externalTaskLinks)
      .where(
        and(
          eq(externalTaskLinks.epicId, projection.epicIdSnapshot),
          eq(externalTaskLinks.provider, projection.provider),
          eq(externalTaskLinks.remoteScopeKey, projection.remoteScopeKey),
          eq(externalTaskLinks.remoteTaskId, projection.remoteTaskId),
          sql`json_extract(${externalTaskLinks.sourceSnapshot}, '$.managedProjectionId') IS NOT NULL`,
        ),
      )
      .all() as ExternalTaskLink[];
  }

  async beginExternalLinkRelease(epicId: string, linkId: string): Promise<string | null> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const tasks = this.externalLinkReleaseTasksSync(epicId, linkId);
      const projectId = tasks[0]?.projectId;
      return projectId
        ? openLinkReleaseAttempt(this.rawClient, linkId, { projectId, epicId, tasks })
        : null;
    });
  }

  async closeExternalLinkReleaseAttempt(linkId: string, attempt: string | null): Promise<void> {
    return this.txRunner.runImmediateQueuedOrJoin(() =>
      closeLinkReleaseAttempt(this.rawClient, linkId, attempt),
    );
  }

  async assertExternalLinkReleaseAllowed(
    epicId: string,
    linkId: string,
  ): Promise<ExternalEstimateLogIdentity[]> {
    return this.externalLinkReleaseTasksSync(epicId, linkId);
  }

  private externalLinkReleaseTasksSync(
    epicId: string,
    linkId: string,
  ): ExternalEstimateLogIdentity[] {
    const link = this.listEpicLinksSync(epicId).find((candidate) => candidate.id === linkId);
    if (!link) return [];
    // Home owns recognition links; the VM has none to unlink. Refuse before an attempt opens.
    if (!isOrdinaryExternalTaskLink(link)) throw managedLinkRefusal(epicId, linkId);
    const removed = [link];
    for (const projection of this.managedProjectionsSync(
      eq(externalManagedSubtaskLinks.parentSourceLinkIdSnapshot, link.id),
    )) {
      if (projection.remoteTaskId) {
        removed.push(
          ...this.recognitionLinksSync({ ...projection, remoteTaskId: projection.remoteTaskId }),
        );
      }
    }
    this.assertNoPendingEstimateSync(removed, new Set(removed.map((candidate) => candidate.id)));
    return removed.map(({ projectId, provider, remoteScopeKey, remoteTaskId }) => ({
      projectId,
      provider,
      remoteScopeKey,
      remoteTaskId,
    }));
  }

  async importHostedExternalTask(
    data: ImportHostedExternalTask,
    epicCreatedEvent?: (epic: Epic) => PreparedEvent | null,
  ): Promise<ImportHostedExternalTaskResult> {
    const projectId = data.epic.projectId;
    return this.txRunner.runImmediateAsync(async () => {
      assertLinkProjectSeeded(this.rawClient, projectId);
      const existing = await this.findExternalTaskLink(
        projectId,
        data.link.provider,
        data.link.remoteScopeKey.trim(),
        data.link.remoteTaskId.trim(),
      );
      if (existing) return { epicId: existing.epicId, link: existing, created: false };
      const unfinished = this.rawClient
        .prepare(
          `SELECT e.id FROM epics e
           WHERE e.project_id = ? AND json_extract(e.data, '$.idempotencyKey') = ?
             AND NOT EXISTS (SELECT 1 FROM external_task_links l WHERE l.epic_id = e.id)
           ORDER BY e.created_at, e.id LIMIT 1`,
        )
        .get(projectId, data.idempotencyKey) as { id: string } | undefined;
      const createdEpic = unfinished
        ? undefined
        : await this.dependencies.createEpicWithinTransaction(data.epic);
      const epicId = unfinished?.id ?? createdEpic!.id;
      const { link } = await this.setEpicExternalTaskLink(epicId, data.link, undefined, {
        vmHosted: true,
      });
      const event = createdEpic && epicCreatedEvent?.(createdEpic);
      if (event) this.dependencies.appendEvent(event);
      return { epicId, link, created: true, ...(createdEpic && { createdEpic }) };
    });
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
        const epic = await this.dependencies.createEpicWithinTransaction(data.epic);
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
