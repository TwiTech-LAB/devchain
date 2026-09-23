import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../../common/errors/error-types';
import {
  epics,
  externalManagedSubtaskLinks,
  externalTaskLinks,
  integrationConnections,
} from '../../db/schema';
import type {
  ConfirmExternalManagedSubtaskLink,
  ConfirmExternalManagedSubtaskLinkResult,
  CreateExternalManagedSubtaskLink,
  ExternalManagedSubtaskLink,
  IntegrationProvider,
  UpdateExternalManagedSubtaskLink,
} from '../../models/domain.models';
import { isSqliteUniqueConstraint } from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

export class ExternalManagedSubtaskStorageDelegate extends BaseStorageDelegate {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async create(data: CreateExternalManagedSubtaskLink): Promise<ExternalManagedSubtaskLink> {
    return this.txRunner.runImmediateQueued(() => {
      const normalized = this.validateCreateSync(data);
      const now = new Date().toISOString();
      const row: ExternalManagedSubtaskLink = {
        ...normalized,
        id: randomUUID(),
        remoteTaskId: null,
        remoteKey: null,
        confirmedVersion: null,
        confirmedFingerprint: null,
        operationPhase: normalized.operationPhase ?? 'pre_dispatch',
        safeErrorCode: null,
        retryAt: null,
        tombstoneState: normalized.tombstoneState ?? 'active',
        tombstonedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      try {
        this.db.insert(externalManagedSubtaskLinks).values(row).run();
      } catch (error) {
        if (isSqliteUniqueConstraint(error)) {
          throw new ConflictError('Managed subtask projection already exists.', {
            epicIdSnapshot: row.epicIdSnapshot,
            parentSourceLinkIdSnapshot: row.parentSourceLinkIdSnapshot,
          });
        }
        throw error;
      }
      return row;
    });
  }

  async get(id: string): Promise<ExternalManagedSubtaskLink> {
    return this.getSync(id);
  }

  async listByProvider(provider: IntegrationProvider): Promise<ExternalManagedSubtaskLink[]> {
    return this.db
      .select()
      .from(externalManagedSubtaskLinks)
      .where(eq(externalManagedSubtaskLinks.provider, provider))
      .orderBy(
        asc(externalManagedSubtaskLinks.createdAt),
        asc(externalManagedSubtaskLinks.id),
      ) as Promise<ExternalManagedSubtaskLink[]>;
  }

  async listByConnection(connectionId: string): Promise<ExternalManagedSubtaskLink[]> {
    return this.db
      .select()
      .from(externalManagedSubtaskLinks)
      .where(eq(externalManagedSubtaskLinks.connectionIdSnapshot, connectionId.trim()))
      .orderBy(
        asc(externalManagedSubtaskLinks.createdAt),
        asc(externalManagedSubtaskLinks.id),
      ) as Promise<ExternalManagedSubtaskLink[]>;
  }

  async listForEpicSnapshot(epicIdSnapshot: string): Promise<ExternalManagedSubtaskLink[]> {
    return this.db
      .select()
      .from(externalManagedSubtaskLinks)
      .where(eq(externalManagedSubtaskLinks.epicIdSnapshot, epicIdSnapshot))
      .orderBy(
        asc(externalManagedSubtaskLinks.createdAt),
        asc(externalManagedSubtaskLinks.id),
      ) as Promise<ExternalManagedSubtaskLink[]>;
  }

  async update(
    id: string,
    data: UpdateExternalManagedSubtaskLink,
  ): Promise<ExternalManagedSubtaskLink> {
    return this.txRunner.runImmediateQueued(() => {
      this.getSync(id);
      const update = this.normalizeUpdate(data);
      this.db
        .update(externalManagedSubtaskLinks)
        .set({ ...update, updatedAt: new Date().toISOString() })
        .where(eq(externalManagedSubtaskLinks.id, id))
        .run();
      return this.getSync(id);
    });
  }

  async findRecognition(
    epicId: string,
    provider: IntegrationProvider,
    remoteScopeKey: string,
    remoteTaskId: string,
  ): Promise<ExternalManagedSubtaskLink | null> {
    const row = this.db
      .select({ managed: externalManagedSubtaskLinks })
      .from(externalTaskLinks)
      .innerJoin(
        externalManagedSubtaskLinks,
        and(
          eq(externalManagedSubtaskLinks.epicIdSnapshot, externalTaskLinks.epicId),
          eq(externalManagedSubtaskLinks.provider, externalTaskLinks.provider),
          eq(externalManagedSubtaskLinks.remoteScopeKey, externalTaskLinks.remoteScopeKey),
          eq(externalManagedSubtaskLinks.remoteTaskId, externalTaskLinks.remoteTaskId),
        ),
      )
      .where(
        and(
          eq(externalTaskLinks.epicId, epicId),
          eq(externalTaskLinks.provider, provider),
          eq(externalTaskLinks.remoteScopeKey, remoteScopeKey),
          eq(externalTaskLinks.remoteTaskId, remoteTaskId),
          eq(externalManagedSubtaskLinks.epicId, epicId),
          eq(externalManagedSubtaskLinks.operationPhase, 'confirmed'),
          eq(externalManagedSubtaskLinks.tombstoneState, 'active'),
        ),
      )
      .limit(1)
      .get();
    return (row?.managed as ExternalManagedSubtaskLink | undefined) ?? null;
  }

  async confirm(
    data: ConfirmExternalManagedSubtaskLink,
  ): Promise<ConfirmExternalManagedSubtaskLinkResult> {
    return this.txRunner.runImmediateQueued(() => {
      const managed = this.getSync(data.managedLinkId);
      if (!managed.epicId || managed.tombstoneState !== 'active') {
        throw new ConflictError('Managed subtask no longer has a live local Epic.', {
          managedLinkId: managed.id,
          tombstoneState: managed.tombstoneState,
        });
      }
      const remoteTaskId = data.remoteTaskId.trim();
      const remoteKey = data.remoteKey.trim();
      const confirmedFingerprint = data.confirmedFingerprint.trim();
      if (
        !remoteTaskId ||
        !remoteKey ||
        !confirmedFingerprint ||
        data.confirmedVersion < 1 ||
        !data.sourceSnapshot ||
        typeof data.sourceSnapshot !== 'object' ||
        Array.isArray(data.sourceSnapshot)
      ) {
        throw new ValidationError('Confirmed remote identity and version are required.');
      }
      this.assertExactOwnershipProof(managed, data.sourceSnapshot);

      const ownedEpic = this.db
        .select({ projectId: epics.projectId })
        .from(epics)
        .where(eq(epics.id, managed.epicIdSnapshot))
        .limit(1)
        .get();
      if (!ownedEpic) {
        throw new NotFoundError('Epic', managed.epicIdSnapshot);
      }

      // The ordinary link is scoped to the managed subtask's local project:
      // another project linking the same remote child never blocks this
      // confirmation, and only a same-project link to a different Epic is a
      // conflict.
      let externalTaskLink = this.db
        .select()
        .from(externalTaskLinks)
        .where(
          and(
            eq(externalTaskLinks.projectId, ownedEpic.projectId),
            eq(externalTaskLinks.provider, managed.provider),
            eq(externalTaskLinks.remoteScopeKey, managed.remoteScopeKey),
            eq(externalTaskLinks.remoteTaskId, remoteTaskId),
          ),
        )
        .limit(1)
        .get();
      if (externalTaskLink && externalTaskLink.epicId !== managed.epicIdSnapshot) {
        throw new ConflictError('Remote task identity is already linked to another Epic.', {
          managedLinkId: managed.id,
          linkedEpicId: externalTaskLink.epicId,
        });
      }

      const now = new Date().toISOString();
      if (!externalTaskLink) {
        externalTaskLink = {
          id: randomUUID(),
          epicId: managed.epicIdSnapshot,
          projectId: ownedEpic.projectId,
          connectionId: managed.connectionIdSnapshot,
          provider: managed.provider,
          remoteScopeKey: managed.remoteScopeKey,
          remoteTaskId,
          sourceSnapshot: {
            ...data.sourceSnapshot,
            managedProjectionId: managed.id,
            ownershipToken: managed.ownershipToken,
          },
          createdAt: now,
          updatedAt: now,
        };
        this.db.insert(externalTaskLinks).values(externalTaskLink).run();
      }

      this.db
        .update(externalManagedSubtaskLinks)
        .set({
          remoteTaskId,
          remoteKey,
          confirmedVersion: data.confirmedVersion,
          confirmedFingerprint,
          operationPhase: 'confirmed',
          safeErrorCode: null,
          retryAt: null,
          updatedAt: now,
        })
        .where(eq(externalManagedSubtaskLinks.id, managed.id))
        .run();
      return {
        managedLink: this.getSync(managed.id),
        externalTaskLink:
          externalTaskLink as ConfirmExternalManagedSubtaskLinkResult['externalTaskLink'],
      };
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.txRunner.runImmediateQueued(() => {
      const managed = this.db
        .select()
        .from(externalManagedSubtaskLinks)
        .where(eq(externalManagedSubtaskLinks.id, id))
        .limit(1)
        .get() as ExternalManagedSubtaskLink | undefined;
      if (!managed) {
        return false;
      }
      if (managed.remoteTaskId) {
        this.db
          .delete(externalTaskLinks)
          .where(
            and(
              eq(externalTaskLinks.epicId, managed.epicIdSnapshot),
              eq(externalTaskLinks.provider, managed.provider),
              eq(externalTaskLinks.remoteScopeKey, managed.remoteScopeKey),
              eq(externalTaskLinks.remoteTaskId, managed.remoteTaskId),
            ),
          )
          .run();
      }
      this.db
        .delete(externalManagedSubtaskLinks)
        .where(eq(externalManagedSubtaskLinks.id, managed.id))
        .run();
      return true;
    });
  }

  handleConnectionMutationSync(
    connectionId: string,
    provider: IntegrationProvider,
    acknowledgeOrphanRisk: boolean,
  ): void {
    const risky = this.db
      .select({ id: externalManagedSubtaskLinks.id })
      .from(externalManagedSubtaskLinks)
      .where(
        and(
          eq(externalManagedSubtaskLinks.connectionIdSnapshot, connectionId),
          eq(externalManagedSubtaskLinks.provider, provider),
          inArray(externalManagedSubtaskLinks.operationPhase, [
            'dispatch_admitted',
            'outcome_unknown',
          ]),
        ),
      )
      .all();
    if (risky.length === 0) {
      return;
    }
    if (!acknowledgeOrphanRisk) {
      throw new ConflictError(
        'Connection change requires acknowledgement of unresolved managed-subtask outcomes.',
        {
          connectionId,
          provider,
          reason: 'orphan_risk_ack_required',
          affectedCount: risky.length,
        },
      );
    }
    const now = new Date().toISOString();
    this.db
      .update(externalManagedSubtaskLinks)
      .set({
        tombstoneState: 'orphan_risk',
        tombstonedAt: now,
        safeErrorCode: 'connection_changed_with_unresolved_outcome',
        updatedAt: now,
      })
      .where(
        inArray(
          externalManagedSubtaskLinks.id,
          risky.map((row) => row.id),
        ),
      )
      .run();
  }

  private getSync(id: string): ExternalManagedSubtaskLink {
    const row = this.db
      .select()
      .from(externalManagedSubtaskLinks)
      .where(eq(externalManagedSubtaskLinks.id, id))
      .limit(1)
      .get();
    if (!row) {
      throw new NotFoundError('Managed subtask link', id);
    }
    return row as ExternalManagedSubtaskLink;
  }

  private validateCreateSync(
    data: CreateExternalManagedSubtaskLink,
  ): CreateExternalManagedSubtaskLink {
    const required = {
      epicId: data.epicId.trim(),
      epicIdSnapshot: data.epicIdSnapshot.trim(),
      parentEpicIdSnapshot: data.parentEpicIdSnapshot.trim(),
      parentSourceLinkIdSnapshot: data.parentSourceLinkIdSnapshot.trim(),
      connectionIdSnapshot: data.connectionIdSnapshot.trim(),
      remoteScopeKey: data.remoteScopeKey.trim(),
      workAreaRemoteId: data.workAreaRemoteId.trim(),
      parentRemoteTaskId: data.parentRemoteTaskId.trim(),
      ownershipToken: data.ownershipToken.trim(),
      desiredFingerprint: data.desiredFingerprint.trim(),
    };
    if (Object.values(required).some((value) => !value)) {
      throw new ValidationError('Managed subtask ownership and desired-state fields are required.');
    }
    if (required.epicId !== required.epicIdSnapshot) {
      throw new ValidationError('Managed subtask Epic identity snapshot must match its live Epic.');
    }
    if (data.connectionGeneration < 1 || data.syncSettingRevision < 1 || data.desiredVersion < 1) {
      throw new ValidationError('Managed subtask generations and versions must be positive.');
    }

    const epic = this.db
      .select({ id: epics.id, parentId: epics.parentId, projectId: epics.projectId })
      .from(epics)
      .where(eq(epics.id, required.epicId))
      .get();
    if (!epic) {
      throw new NotFoundError('Epic', required.epicId);
    }
    if (epic.parentId !== required.parentEpicIdSnapshot) {
      throw new ValidationError('Managed subtask parent Epic proof does not match current state.');
    }
    const parentLink = this.db
      .select()
      .from(externalTaskLinks)
      .where(eq(externalTaskLinks.id, required.parentSourceLinkIdSnapshot))
      .get();
    if (
      !parentLink ||
      parentLink.epicId !== required.parentEpicIdSnapshot ||
      parentLink.provider !== data.provider ||
      parentLink.remoteScopeKey !== required.remoteScopeKey ||
      parentLink.remoteTaskId !== required.parentRemoteTaskId ||
      (parentLink.sourceSnapshot as Record<string, unknown>).workAreaId !==
        required.workAreaRemoteId
    ) {
      throw new ValidationError(
        'Managed subtask parent source proof does not match the stored link.',
      );
    }
    const connection = this.db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, required.connectionIdSnapshot))
      .get();
    if (
      !connection ||
      connection.projectId !== epic.projectId ||
      connection.provider !== data.provider ||
      connection.generation !== data.connectionGeneration ||
      connection.syncSettingRevision !== data.syncSettingRevision ||
      !connection.subtaskSyncEnabled
    ) {
      throw new ValidationError('Managed subtask connection fence does not match current state.');
    }
    return { ...data, ...required };
  }

  private normalizeUpdate(
    data: UpdateExternalManagedSubtaskLink,
  ): UpdateExternalManagedSubtaskLink {
    const update = { ...data };
    for (const key of [
      'connectionIdSnapshot',
      'remoteTaskId',
      'remoteKey',
      'desiredFingerprint',
      'confirmedFingerprint',
      'safeErrorCode',
    ] as const) {
      if (typeof update[key] === 'string') {
        const value = update[key].trim();
        if (!value) {
          throw new ValidationError(`Managed subtask ${key} cannot be empty.`);
        }
        (update as Record<string, unknown>)[key] = value;
      }
    }
    if (
      typeof update.safeErrorCode === 'string' &&
      !/^[a-z0-9_]{1,128}$/.test(update.safeErrorCode)
    ) {
      throw new ValidationError('Managed subtask safeErrorCode must be a bounded error code.');
    }
    return update;
  }

  private assertExactOwnershipProof(
    managed: ExternalManagedSubtaskLink,
    sourceSnapshot: Record<string, unknown>,
  ): void {
    if (
      sourceSnapshot.ownershipToken !== managed.ownershipToken ||
      sourceSnapshot.parentRemoteTaskId !== managed.parentRemoteTaskId ||
      sourceSnapshot.workAreaRemoteId !== managed.workAreaRemoteId
    ) {
      throw new ConflictError('Remote subtask ownership proof does not match managed state.', {
        managedLinkId: managed.id,
        reason: 'ownership_mismatch',
      });
    }
  }
}
