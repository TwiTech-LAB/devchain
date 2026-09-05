import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { BusyError, ConflictError, NotFoundError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { CommittedEvent } from '../../events/services/durable-event-registry.service';
import { EventsService } from '../../events/services/events.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type {
  Epic,
  ExternalManagedSubtaskLink,
  ExternalTaskLink,
  IntegrationConnection,
  IntegrationCredentials,
  IntegrationProvider,
} from '../../storage/models/domain.models';
import { ExternalProviderError } from '../errors/external-provider.errors';
import { ExternalTaskProviderRegistry } from '../external-task-provider.registry';
import type {
  ExternalProviderConnectionContext,
  ExternalSubtaskSnapshot,
  ExternalSubtaskSyncCapability,
} from '../models/external-provider.models';
import { normalizeExternalTaskSourceUrl } from '../models/external-task-source';
import { ProviderOperationGate } from '../sessions/provider-operation-gate';
import { managedSubtaskRetryDecision } from './managed-subtask-recovery-policy';
import {
  managedSubtaskContentMatches,
  type ManagedSubtaskContent,
  redactManagedSubtaskContent,
} from './managed-subtask-content';

const logger = createLogger('ExternalSubtaskSyncSubscriber');
export const MANAGED_SUBTASK_DELIVERY_KEY = 'managed-subtask-sync';
const RETRY_DELAY_MS = 30_000;

export type ManagedSubtaskReconcileOutcome =
  | 'confirmed'
  | 'deleted'
  | 'unchanged'
  | 'paused'
  | 'retry'
  | 'needs_attention'
  | 'already_remote_unmanaged';

export interface ManagedSubtaskReconcileResult {
  epicId: string;
  provider: IntegrationProvider | null;
  managedLinkId: string | null;
  outcome: ManagedSubtaskReconcileOutcome;
  reason?: string;
}

interface DesiredProjection {
  epic: Epic;
  content: ManagedSubtaskContent;
  parentSource: ExternalTaskLink;
  connection: IntegrationConnection;
  workAreaRemoteId: string;
  desiredFingerprint: string;
}

interface ProviderAccess {
  connection: IntegrationConnection;
  credentials: IntegrationCredentials;
  capability: ExternalSubtaskSyncCapability;
  context: ExternalProviderConnectionContext;
}

interface MutationFailure {
  phase: 'pre_dispatch' | 'outcome_unknown' | 'needs_attention';
  safeErrorCode: string;
  retryAt: string | null;
  retry: boolean;
}

@Injectable()
export class ExternalSubtaskSyncSubscriber implements OnModuleInit, OnModuleDestroy {
  private unregister?: () => void;
  private readonly projectionTails = new Map<string, Promise<void>>();

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly events: EventsService,
    private readonly providers: ExternalTaskProviderRegistry,
    private readonly providerGate: ProviderOperationGate,
  ) {}

  onModuleInit(): void {
    this.unregister = this.events.registerDurableSubscriber({
      deliveryKey: MANAGED_SUBTASK_DELIVERY_KEY,
      ordered: false,
      eventNames: [
        'epic.created',
        'epic.updated',
        'epic.deleted',
        'integration.connection.created',
        'integration.connection.updated',
        'integration.connection.deleted',
      ],
      handle: (event) => this.handleCommittedEvent(event),
    });
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = undefined;
  }

  async handleCommittedEvent(event: CommittedEvent): Promise<void> {
    let results: ManagedSubtaskReconcileResult[] = [];
    if (
      event.name === 'epic.created' ||
      event.name === 'epic.updated' ||
      event.name === 'epic.deleted'
    ) {
      const epicId = (event.payload as { epicId: string }).epicId;
      results = await this.reconcileEpic(epicId);
    } else if (
      event.name === 'integration.connection.created' ||
      event.name === 'integration.connection.updated'
    ) {
      results =
        'projectId' in event.payload
          ? await this.reconcileProjectConnection(event.payload)
          : await this.reconcileLegacyConnection(
              event.payload.connectionId,
              event.payload.provider,
            );
    } else if (event.name === 'integration.connection.deleted') {
      results = await this.connectionDisconnected(
        event.payload.provider,
        event.payload.connectionId,
      );
    }

    const retryCount = results.filter((result) => result.outcome === 'retry').length;
    if (retryCount > 0) {
      throw new Error(`Managed subtask reconciliation has ${retryCount} retryable projection(s).`);
    }
  }

  async reconcileEpic(
    epicId: string,
    providerFilter?: IntegrationProvider,
    connectionFilter?: IntegrationConnection,
  ): Promise<ManagedSubtaskReconcileResult[]> {
    const allExisting = await this.storage.listExternalManagedSubtaskLinksForEpicSnapshot(epicId);
    const existing = allExisting.filter(
      (row) =>
        (!providerFilter || row.provider === providerFilter) &&
        (!connectionFilter || row.connectionIdSnapshot === connectionFilter.id),
    );
    const epic = await this.loadEpicOrNull(epicId);
    const desired = epic?.parentId
      ? await this.desiredProjections(epic, providerFilter, connectionFilter)
      : new Map<string, DesiredProjection>();
    const results: ManagedSubtaskReconcileResult[] = [];
    const obsolete = existing.filter((row) => !desired.has(row.parentSourceLinkIdSnapshot));
    const current = existing.filter((row) => desired.has(row.parentSourceLinkIdSnapshot));
    const obsoleteIds = new Set(obsolete.map((row) => row.id));
    const replacementBlockedProviders = new Set<IntegrationProvider>();

    for (const row of [...obsolete, ...current]) {
      const result = await this.withProjectionLock(row.id, () =>
        this.reconcileExisting(row, epic, desired.get(row.parentSourceLinkIdSnapshot) ?? null),
      );
      results.push(result);
      if (
        obsoleteIds.has(row.id) &&
        (result.outcome === 'retry' || result.outcome === 'needs_attention')
      ) {
        replacementBlockedProviders.add(row.provider);
      }
    }

    if (!epic?.parentId) {
      return results;
    }

    const ordinaryLinks = await this.storage.listExternalTaskLinksForEpic(epic.id);
    for (const link of ordinaryLinks) {
      const belongsToExistingManagedProjection = allExisting.some(
        (row) =>
          row.epicIdSnapshot === epic.id &&
          row.provider === link.provider &&
          row.remoteScopeKey === link.remoteScopeKey &&
          row.remoteTaskId === link.remoteTaskId,
      );
      if (belongsToExistingManagedProjection) {
        continue;
      }
      const result: ManagedSubtaskReconcileResult = {
        epicId: epic.id,
        provider: link.provider,
        managedLinkId: null,
        outcome: 'already_remote_unmanaged',
        reason: 'ordinary_link_is_not_managed',
      };
      logger.info(result, 'Skipped managed projection for an imported remote task');
      results.push(result);
      return results;
    }

    const existingSourceIds = new Set(existing.map((row) => row.parentSourceLinkIdSnapshot));
    for (const projection of desired.values()) {
      if (existingSourceIds.has(projection.parentSource.id)) {
        continue;
      }
      if (replacementBlockedProviders.has(projection.parentSource.provider)) {
        continue;
      }
      const created = await this.createManagedProjection(projection);
      results.push(
        await this.withProjectionLock(created.id, () =>
          this.reconcileExisting(created, epic, projection),
        ),
      );
    }
    return results;
  }

  async reconcileProvider(provider: IntegrationProvider): Promise<ManagedSubtaskReconcileResult[]> {
    const results: ManagedSubtaskReconcileResult[] = [];
    const existing = await this.storage.listExternalManagedSubtaskLinksByProvider(provider);
    const processedEpicIds = new Set<string>();
    for (const row of existing) {
      if (processedEpicIds.has(row.epicIdSnapshot)) {
        continue;
      }
      processedEpicIds.add(row.epicIdSnapshot);
      results.push(...(await this.reconcileEpic(row.epicIdSnapshot, provider)));
    }

    let projectOffset = 0;
    while (true) {
      const projects = await this.storage.listProjects({ limit: 500, offset: projectOffset });
      for (const project of projects.items) {
        if (project.isTemplate) {
          continue;
        }
        let offset = 0;
        while (true) {
          const page = await this.storage.listProjectEpics(project.id, {
            type: 'all',
            limit: 500,
            offset,
          });
          for (const epic of page.items) {
            if (epic.parentId && !processedEpicIds.has(epic.id)) {
              processedEpicIds.add(epic.id);
              results.push(...(await this.reconcileEpic(epic.id, provider)));
            }
          }
          offset += page.items.length;
          if (page.items.length === 0 || offset >= page.total) {
            break;
          }
        }
      }
      projectOffset += projects.items.length;
      if (projects.items.length === 0 || projectOffset >= projects.total) {
        break;
      }
    }
    return results;
  }

  private async reconcileProjectConnection(input: {
    connectionId: string;
    projectId: string;
    provider: IntegrationProvider;
  }): Promise<ManagedSubtaskReconcileResult[]> {
    const connection = await this.storage.getIntegrationConnectionById(input.connectionId);
    if (
      !connection ||
      connection.projectId !== input.projectId ||
      connection.provider !== input.provider
    ) {
      return [];
    }
    return this.reconcileConnection(connection);
  }

  private async reconcileLegacyConnection(
    legacySourceConnectionId: string,
    provider: IntegrationProvider,
  ): Promise<ManagedSubtaskReconcileResult[]> {
    const connections = (
      await this.storage.listIntegrationConnectionsByLegacySourceConnectionId(
        legacySourceConnectionId,
      )
    ).filter((connection) => connection.provider === provider);
    const results: ManagedSubtaskReconcileResult[] = [];
    for (const connection of connections) {
      results.push(...(await this.reconcileConnection(connection)));
    }
    return results;
  }

  private async reconcileConnection(
    connection: IntegrationConnection,
  ): Promise<ManagedSubtaskReconcileResult[]> {
    const results: ManagedSubtaskReconcileResult[] = [];
    const existing = (
      await this.storage.listExternalManagedSubtaskLinksByConnection(connection.id)
    ).filter((row) => row.provider === connection.provider);
    const processedEpicIds = new Set<string>();
    for (const row of existing) {
      if (processedEpicIds.has(row.epicIdSnapshot)) {
        continue;
      }
      processedEpicIds.add(row.epicIdSnapshot);
      results.push(
        ...(await this.reconcileEpic(row.epicIdSnapshot, connection.provider, connection)),
      );
    }

    if (!connection.projectId) {
      return results;
    }
    let offset = 0;
    while (true) {
      const page = await this.storage.listProjectEpics(connection.projectId, {
        type: 'all',
        limit: 500,
        offset,
      });
      for (const epic of page.items) {
        if (epic.parentId && !processedEpicIds.has(epic.id)) {
          processedEpicIds.add(epic.id);
          results.push(...(await this.reconcileEpic(epic.id, connection.provider, connection)));
        }
      }
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) {
        break;
      }
    }
    return results;
  }

  async reconcileManagedLink(
    id: string,
    expectedConnectionId?: string,
  ): Promise<ManagedSubtaskReconcileResult> {
    return this.withProjectionLock(id, () =>
      this.reconcileManagedLinkUnlocked(id, expectedConnectionId),
    );
  }

  async verifyManagedLink(
    id: string,
    expectedConnectionId?: string,
  ): Promise<ManagedSubtaskReconcileResult> {
    return this.withProjectionLock(id, async () => {
      const row = await this.storage.getExternalManagedSubtaskLink(id);
      this.assertExpectedConnection(row, expectedConnectionId);
      if (
        row.operationPhase === 'dispatch_admitted' ||
        row.operationPhase === 'outcome_unknown' ||
        row.operationPhase === 'needs_attention'
      ) {
        await this.storage.updateExternalManagedSubtaskLink(id, {
          operationPhase: 'outcome_unknown',
          retryAt: null,
        });
      }
      return this.reconcileManagedLinkUnlocked(id, expectedConnectionId);
    });
  }

  async retryManagedLink(
    id: string,
    expectedConnectionId?: string,
  ): Promise<ManagedSubtaskReconcileResult> {
    return this.withProjectionLock(id, async () => {
      const row = await this.storage.getExternalManagedSubtaskLink(id);
      this.assertExpectedConnection(row, expectedConnectionId);
      const decision = managedSubtaskRetryDecision(row);
      if (!decision.allowed) {
        throw new ConflictError(
          decision.reason === 'verification_required'
            ? 'Unknown managed-subtask outcomes must be verified before retry.'
            : 'Managed-subtask state does not allow Retry.',
          {
            managedLinkId: id,
            reason: decision.reason,
          },
        );
      }
      await this.storage.updateExternalManagedSubtaskLink(id, {
        operationPhase: 'pre_dispatch',
        safeErrorCode: null,
        retryAt: null,
      });
      return this.reconcileManagedLinkUnlocked(id, expectedConnectionId);
    });
  }

  private async reconcileManagedLinkUnlocked(
    id: string,
    expectedConnectionId?: string,
  ): Promise<ManagedSubtaskReconcileResult> {
    const row = await this.storage.getExternalManagedSubtaskLink(id);
    this.assertExpectedConnection(row, expectedConnectionId);
    const [epic, connection] = await Promise.all([
      this.loadEpicOrNull(row.epicIdSnapshot),
      this.storage.getIntegrationConnectionById(row.connectionIdSnapshot),
    ]);
    const allowUnassignedConnection = Boolean(expectedConnectionId && !connection?.projectId);
    const desired =
      epic?.parentId && connection
        ? await this.desiredProjections(epic, row.provider, connection, allowUnassignedConnection)
        : new Map<string, DesiredProjection>();
    return this.reconcileExisting(
      row,
      epic,
      desired.get(row.parentSourceLinkIdSnapshot) ?? null,
      allowUnassignedConnection,
    );
  }

  private async reconcileExisting(
    original: ExternalManagedSubtaskLink,
    epic: Epic | null,
    desired: DesiredProjection | null,
    allowUnassignedConnection = false,
  ): Promise<ManagedSubtaskReconcileResult> {
    let row = await this.storage.getExternalManagedSubtaskLink(original.id);
    const connection = await this.storage.getIntegrationConnectionById(row.connectionIdSnapshot);
    if (
      !connection ||
      connection.provider !== row.provider ||
      (epic &&
        connection.projectId !== epic.projectId &&
        !(allowUnassignedConnection && connection.projectId === null)) ||
      !connection.subtaskSyncEnabled
    ) {
      return this.result(row, 'paused', connection ? 'sync_disabled' : 'connection_missing');
    }

    row = await this.refreshConnectionFence(row, connection);
    const safeAbsentProjection =
      !row.remoteTaskId &&
      (row.operationPhase === 'pre_dispatch' ||
        (row.operationPhase === 'needs_attention' &&
          row.safeErrorCode?.startsWith('provider_') === true));
    if ((!epic || !desired) && safeAbsentProjection) {
      await this.storage.removeExternalManagedSubtaskLink(row.id);
      await this.publishEpicTimeScopeHint(row.epicIdSnapshot);
      return this.result(row, 'deleted');
    }
    if (row.operationPhase === 'needs_attention' || row.tombstoneState === 'orphan_risk') {
      return this.result(row, 'needs_attention', row.safeErrorCode ?? 'needs_attention');
    }
    if (this.retryIsInFuture(row.retryAt)) {
      return this.result(row, 'retry', row.safeErrorCode ?? 'retry_scheduled');
    }

    if (row.operationPhase === 'dispatch_admitted') {
      row = await this.storage.updateExternalManagedSubtaskLink(row.id, {
        operationPhase: 'outcome_unknown',
        safeErrorCode: 'recovered_dispatched_operation',
      });
    }

    if (!epic || !desired) {
      const tombstoneState = epic ? 'move_out' : 'local_deleted';
      if (row.operationPhase === 'outcome_unknown' && !row.remoteTaskId) {
        return this.resolveUnknownCreateForRemoval(row, tombstoneState);
      }
      row = await this.storage.updateExternalManagedSubtaskLink(row.id, {
        tombstoneState,
        tombstonedAt: row.tombstonedAt ?? new Date().toISOString(),
      });
      return this.deleteProjection(row);
    }

    const versionOnlyChange =
      row.operationPhase === 'confirmed' &&
      row.remoteTaskId !== null &&
      row.confirmedFingerprint === desired.desiredFingerprint &&
      row.desiredFingerprint === desired.desiredFingerprint;
    let confirmationUpdate: {
      operationPhase?: 'pre_dispatch';
      confirmedVersion?: number;
      confirmedFingerprint?: string;
    } = {};
    if (versionOnlyChange) {
      confirmationUpdate = {
        confirmedVersion: epic.version,
        confirmedFingerprint: desired.desiredFingerprint,
      };
    } else if (row.operationPhase === 'confirmed') {
      confirmationUpdate = { operationPhase: 'pre_dispatch' };
    }
    const desiredChanged =
      row.desiredVersion !== epic.version ||
      row.desiredFingerprint !== desired.desiredFingerprint ||
      row.connectionIdSnapshot !== connection.id ||
      row.connectionGeneration !== connection.generation ||
      row.syncSettingRevision !== connection.syncSettingRevision;
    if (desiredChanged) {
      row = await this.storage.updateExternalManagedSubtaskLink(row.id, {
        connectionIdSnapshot: connection.id,
        connectionGeneration: connection.generation,
        syncSettingRevision: connection.syncSettingRevision,
        desiredVersion: epic.version,
        desiredFingerprint: desired.desiredFingerprint,
        ...confirmationUpdate,
        safeErrorCode: null,
        retryAt: null,
      });
    }

    if (row.operationPhase === 'outcome_unknown') {
      return this.resolveUnknown(row, epic, desired);
    }
    if (!row.remoteTaskId) {
      return this.createProjection(row, epic, desired);
    }

    if (
      row.operationPhase === 'confirmed' &&
      row.confirmedVersion === row.desiredVersion &&
      row.confirmedFingerprint === row.desiredFingerprint
    ) {
      const recognized = await this.storage.findRecognizedManagedSubtask(
        row.epicIdSnapshot,
        row.provider,
        row.remoteScopeKey,
        row.remoteTaskId,
      );
      if (recognized) {
        return this.result(row, 'unchanged');
      }
      return this.repairRecognition(row, epic, desired);
    }
    return this.updateProjection(row, epic, desired);
  }

  /**
   * Best-effort cache hint after a managed link boundary change. A vanished
   * Epic means its own queries are already gone, so resolution failure is not
   * an error — the hint only matters for Epics that still exist.
   */
  private async publishEpicTimeScopeHint(epicId: string | null): Promise<void> {
    if (!epicId) return;
    try {
      const epic = await this.storage.getEpic(epicId);
      const project = await this.storage.getProject(epic.projectId);
      await this.events.publish('epic.time.scope.invalidated', {
        workspaceId: project.workspaceId,
      });
    } catch {
      // Scope hints never block reconciliation.
    }
  }

  private async createProjection(
    row: ExternalManagedSubtaskLink,
    epic: Epic,
    desired: DesiredProjection,
  ): Promise<ManagedSubtaskReconcileResult> {
    const admission = await this.admitMutation(row);
    if (!admission) {
      return this.result(row, 'retry', 'admission_changed');
    }
    try {
      const snapshot = await admission.capability.create(admission.credentials, admission.context, {
        parentRemoteTaskId: row.parentRemoteTaskId,
        ownershipToken: row.ownershipToken,
        title: desired.content.title,
        description: desired.content.description,
      });
      if (!(await this.fenceStillCurrent(admission.connection))) {
        await this.markUnknown(row, 'connection_changed_after_dispatch');
        return this.result(row, 'retry', 'connection_changed_after_dispatch');
      }
      this.assertOwnedSnapshot(row, snapshot);
      const confirmed = await this.storage.confirmExternalManagedSubtaskLink({
        managedLinkId: row.id,
        remoteTaskId: snapshot.remoteTaskId,
        remoteKey: snapshot.remoteKey,
        confirmedVersion: row.desiredVersion,
        confirmedFingerprint: row.desiredFingerprint,
        sourceSnapshot: this.sourceSnapshot(row, desired, snapshot, admission.credentials),
      });
      await this.publishEpicTimeScopeHint(confirmed.managedLink.epicIdSnapshot);
      return this.result(confirmed.managedLink, 'confirmed');
    } catch (error) {
      return this.persistPostAdmissionFailure(row, error);
    }
  }

  private async updateProjection(
    row: ExternalManagedSubtaskLink,
    epic: Epic,
    desired: DesiredProjection,
  ): Promise<ManagedSubtaskReconcileResult> {
    if (!row.remoteTaskId) {
      return this.createProjection(row, epic, desired);
    }
    const ownershipFailure = await this.verifyOwnershipBeforeMutation(row);
    if (ownershipFailure) {
      return ownershipFailure;
    }
    const admission = await this.admitMutation(row);
    if (!admission) {
      return this.result(row, 'retry', 'admission_changed');
    }
    try {
      await admission.capability.update(admission.credentials, admission.context, {
        remoteTaskId: row.remoteTaskId,
        expectedParentRemoteTaskId: row.parentRemoteTaskId,
        ownershipToken: row.ownershipToken,
        title: desired.content.title,
        description: desired.content.description,
      });
      const snapshot = await admission.capability.readExact(
        admission.credentials,
        admission.context,
        row.remoteTaskId,
      );
      if (!(await this.fenceStillCurrent(admission.connection))) {
        await this.markUnknown(row, 'connection_changed_after_dispatch');
        return this.result(row, 'retry', 'connection_changed_after_dispatch');
      }
      if (!snapshot) {
        return this.keepUnknownForRetry(row, 'remote_task_missing_after_update');
      }
      this.assertOwnedSnapshot(row, snapshot);
      if (!managedSubtaskContentMatches(row.provider, snapshot, desired.content)) {
        return this.keepUnknownForRetry(row, 'remote_verification_mismatch');
      }
      const confirmed = await this.storage.confirmExternalManagedSubtaskLink({
        managedLinkId: row.id,
        remoteTaskId: snapshot.remoteTaskId,
        remoteKey: snapshot.remoteKey,
        confirmedVersion: row.desiredVersion,
        confirmedFingerprint: row.desiredFingerprint,
        sourceSnapshot: this.sourceSnapshot(row, desired, snapshot, admission.credentials),
      });
      await this.publishEpicTimeScopeHint(confirmed.managedLink.epicIdSnapshot);
      return this.result(confirmed.managedLink, 'confirmed');
    } catch (error) {
      return this.persistPostAdmissionFailure(row, error);
    }
  }

  private async deleteProjection(
    row: ExternalManagedSubtaskLink,
  ): Promise<ManagedSubtaskReconcileResult> {
    if (!row.remoteTaskId) {
      await this.storage.removeExternalManagedSubtaskLink(row.id);
      await this.publishEpicTimeScopeHint(row.epicIdSnapshot);
      return this.result(row, 'deleted');
    }
    const remoteTaskId = row.remoteTaskId;
    if (row.operationPhase === 'dispatch_admitted') {
      row = await this.storage.updateExternalManagedSubtaskLink(row.id, {
        operationPhase: 'outcome_unknown',
        safeErrorCode: 'recovered_dispatched_operation',
      });
    }
    if (row.operationPhase === 'outcome_unknown') {
      return this.resolveUnknownDelete(row);
    }
    const ownershipFailure = await this.verifyOwnershipBeforeMutation(row);
    if (ownershipFailure) {
      return ownershipFailure;
    }
    const admission = await this.admitMutation(row);
    if (!admission) {
      return this.result(row, 'retry', 'admission_changed');
    }
    try {
      await admission.capability.delete(admission.credentials, admission.context, {
        remoteTaskId,
        expectedParentRemoteTaskId: row.parentRemoteTaskId,
        ownershipToken: row.ownershipToken,
      });
      if (!(await this.fenceStillCurrent(admission.connection))) {
        await this.markUnknown(row, 'connection_changed_after_dispatch');
        return this.result(row, 'retry', 'connection_changed_after_dispatch');
      }
      await this.storage.removeExternalManagedSubtaskLink(row.id);
      await this.publishEpicTimeScopeHint(row.epicIdSnapshot);
      return this.result(row, 'deleted');
    } catch (error) {
      return this.persistPostAdmissionFailure(row, error);
    }
  }

  private async resolveUnknown(
    row: ExternalManagedSubtaskLink,
    epic: Epic,
    desired: DesiredProjection,
  ): Promise<ManagedSubtaskReconcileResult> {
    if (!row.remoteTaskId) {
      return this.resolveUnknownCreate(row, epic, desired);
    }
    const access = await this.captureReadAccess(row);
    if (!access) {
      return this.result(row, 'retry', 'verification_unavailable');
    }
    try {
      const snapshot = await access.capability.readExact(
        access.credentials,
        access.context,
        row.remoteTaskId,
      );
      if (!(await this.fenceStillCurrent(access.connection))) {
        return this.keepUnknownForRetry(row, 'connection_changed_during_verification');
      }
      if (!snapshot) {
        return this.markNeedsAttention(row, 'remote_task_missing_after_unknown_update');
      }
      this.assertOwnedSnapshot(row, snapshot);
      if (managedSubtaskContentMatches(row.provider, snapshot, desired.content)) {
        const confirmed = await this.storage.confirmExternalManagedSubtaskLink({
          managedLinkId: row.id,
          remoteTaskId: snapshot.remoteTaskId,
          remoteKey: snapshot.remoteKey,
          confirmedVersion: row.desiredVersion,
          confirmedFingerprint: row.desiredFingerprint,
          sourceSnapshot: this.sourceSnapshot(row, desired, snapshot, access.credentials),
        });
        await this.publishEpicTimeScopeHint(confirmed.managedLink.epicIdSnapshot);
        return this.result(confirmed.managedLink, 'confirmed');
      }
      const retryable = await this.storage.updateExternalManagedSubtaskLink(row.id, {
        operationPhase: 'pre_dispatch',
        safeErrorCode: null,
        retryAt: null,
      });
      return this.updateProjection(retryable, epic, desired);
    } catch (error) {
      if (this.isOwnershipFailure(error)) {
        return this.markNeedsAttention(row, this.ownershipFailureCode(error));
      }
      return this.persistVerificationFailure(row, error);
    }
  }

  private async resolveUnknownCreate(
    row: ExternalManagedSubtaskLink,
    epic: Epic,
    desired: DesiredProjection,
  ): Promise<ManagedSubtaskReconcileResult> {
    const access = await this.captureReadAccess(row);
    if (!access) {
      return this.result(row, 'retry', 'verification_unavailable');
    }
    let adopted: ExternalManagedSubtaskLink | null = null;
    let adoptedFingerprint: string | null = null;
    let adoptedMatchesDesired = false;
    try {
      const children = await access.capability.listOwnedDirectChildren(
        access.credentials,
        access.context,
        row.parentRemoteTaskId,
        row.ownershipToken,
      );
      if (!(await this.fenceStillCurrent(access.connection))) {
        return this.keepUnknownForRetry(row, 'connection_changed_during_verification');
      }
      const matches = children.items.filter(
        (item) =>
          item.ownershipToken === row.ownershipToken &&
          item.parentRemoteTaskId === row.parentRemoteTaskId,
      );
      if (matches.length === 1) {
        const snapshot = matches[0];
        this.assertOwnedSnapshot(row, snapshot);
        adoptedMatchesDesired = managedSubtaskContentMatches(
          row.provider,
          snapshot,
          desired.content,
        );
        adoptedFingerprint = adoptedMatchesDesired
          ? row.desiredFingerprint
          : this.projectionFingerprint(
              snapshot.title,
              snapshot.description,
              row.parentSourceLinkIdSnapshot,
              row.parentRemoteTaskId,
            );
        const confirmed = await this.storage.confirmExternalManagedSubtaskLink({
          managedLinkId: row.id,
          remoteTaskId: snapshot.remoteTaskId,
          remoteKey: snapshot.remoteKey,
          confirmedVersion: row.desiredVersion,
          confirmedFingerprint: adoptedFingerprint,
          sourceSnapshot: this.sourceSnapshot(row, desired, snapshot, access.credentials),
        });
        await this.publishEpicTimeScopeHint(confirmed.managedLink.epicIdSnapshot);
        adopted = confirmed.managedLink;
      }
      if (!adopted && matches.length === 0 && children.complete) {
        const retryable = await this.storage.updateExternalManagedSubtaskLink(row.id, {
          operationPhase: 'pre_dispatch',
          safeErrorCode: null,
          retryAt: null,
        });
        return this.createProjection(retryable, epic, desired);
      }
      if (!adopted) {
        return this.markNeedsAttention(
          row,
          matches.length > 1 ? 'multiple_owned_children' : 'ownership_scan_incomplete',
        );
      }
    } catch (error) {
      return this.persistVerificationFailure(row, error);
    }
    if (adoptedMatchesDesired) {
      return this.result(adopted, 'confirmed');
    }
    return this.updateProjection(adopted, epic, desired);
  }

  private async resolveUnknownCreateForRemoval(
    row: ExternalManagedSubtaskLink,
    tombstoneState: 'local_deleted' | 'move_out',
  ): Promise<ManagedSubtaskReconcileResult> {
    const access = await this.captureReadAccess(row);
    if (!access) {
      return this.result(row, 'retry', 'verification_unavailable');
    }
    try {
      const children = await access.capability.listOwnedDirectChildren(
        access.credentials,
        access.context,
        row.parentRemoteTaskId,
        row.ownershipToken,
      );
      if (!(await this.fenceStillCurrent(access.connection))) {
        return this.keepUnknownForRetry(row, 'connection_changed_during_verification');
      }
      const matches = children.items.filter(
        (item) =>
          item.ownershipToken === row.ownershipToken &&
          item.parentRemoteTaskId === row.parentRemoteTaskId,
      );
      if (matches.length === 0 && children.complete) {
        await this.storage.removeExternalManagedSubtaskLink(row.id);
        await this.publishEpicTimeScopeHint(row.epicIdSnapshot);
        return this.result(row, 'deleted');
      }
      if (matches.length !== 1) {
        return this.markNeedsAttention(
          row,
          matches.length > 1 ? 'multiple_owned_children' : 'ownership_scan_incomplete',
        );
      }
      const snapshot = matches[0];
      this.assertOwnedSnapshot(row, snapshot);
      const adopted = await this.storage.updateExternalManagedSubtaskLink(row.id, {
        remoteTaskId: snapshot.remoteTaskId,
        remoteKey: snapshot.remoteKey,
        operationPhase: 'pre_dispatch',
        safeErrorCode: null,
        retryAt: null,
        tombstoneState,
        tombstonedAt: row.tombstonedAt ?? new Date().toISOString(),
      });
      return this.deleteProjection(adopted);
    } catch (error) {
      if (this.isOwnershipFailure(error)) {
        return this.markNeedsAttention(row, this.ownershipFailureCode(error));
      }
      return this.persistVerificationFailure(row, error);
    }
  }

  private async resolveUnknownDelete(
    row: ExternalManagedSubtaskLink,
  ): Promise<ManagedSubtaskReconcileResult> {
    if (!row.remoteTaskId) {
      await this.storage.removeExternalManagedSubtaskLink(row.id);
      await this.publishEpicTimeScopeHint(row.epicIdSnapshot);
      return this.result(row, 'deleted');
    }
    const access = await this.captureReadAccess(row);
    if (!access) {
      return this.result(row, 'retry', 'verification_unavailable');
    }
    try {
      const snapshot = await access.capability.readExact(
        access.credentials,
        access.context,
        row.remoteTaskId,
      );
      if (!(await this.fenceStillCurrent(access.connection))) {
        return this.keepUnknownForRetry(row, 'connection_changed_during_verification');
      }
      if (!snapshot) {
        await this.storage.removeExternalManagedSubtaskLink(row.id);
        await this.publishEpicTimeScopeHint(row.epicIdSnapshot);
        return this.result(row, 'deleted');
      }
      this.assertOwnedSnapshot(row, snapshot);
      const retryable = await this.storage.updateExternalManagedSubtaskLink(row.id, {
        operationPhase: 'pre_dispatch',
        safeErrorCode: null,
        retryAt: null,
      });
      return this.deleteProjection(retryable);
    } catch (error) {
      if (this.isOwnershipFailure(error)) {
        return this.markNeedsAttention(row, this.ownershipFailureCode(error));
      }
      return this.persistVerificationFailure(row, error);
    }
  }

  private async repairRecognition(
    row: ExternalManagedSubtaskLink,
    epic: Epic,
    desired: DesiredProjection,
  ): Promise<ManagedSubtaskReconcileResult> {
    if (!row.remoteTaskId) {
      return this.createProjection(row, epic, desired);
    }
    const access = await this.captureReadAccess(row);
    if (!access) {
      return this.result(row, 'retry', 'verification_unavailable');
    }
    try {
      const snapshot = await access.capability.readExact(
        access.credentials,
        access.context,
        row.remoteTaskId,
      );
      if (!(await this.fenceStillCurrent(access.connection))) {
        return this.keepUnknownForRetry(row, 'connection_changed_during_verification');
      }
      if (!snapshot) {
        return this.markNeedsAttention(row, 'remote_task_missing');
      }
      this.assertOwnedSnapshot(row, snapshot);
      const repaired = await this.storage.confirmExternalManagedSubtaskLink({
        managedLinkId: row.id,
        remoteTaskId: snapshot.remoteTaskId,
        remoteKey: snapshot.remoteKey,
        confirmedVersion: row.desiredVersion,
        confirmedFingerprint: row.desiredFingerprint,
        sourceSnapshot: this.sourceSnapshot(row, desired, snapshot, access.credentials),
      });
      await this.publishEpicTimeScopeHint(repaired.managedLink.epicIdSnapshot);
      return this.result(repaired.managedLink, 'confirmed', 'recognition_repaired');
    } catch (error) {
      if (this.isOwnershipFailure(error)) {
        return this.markNeedsAttention(row, this.ownershipFailureCode(error));
      }
      return this.persistVerificationFailure(row, error);
    }
  }

  private async verifyOwnershipBeforeMutation(
    row: ExternalManagedSubtaskLink,
  ): Promise<ManagedSubtaskReconcileResult | null> {
    if (!row.remoteTaskId) {
      return this.markNeedsAttention(row, 'remote_identity_missing');
    }
    const access = await this.captureReadAccess(row);
    if (!access) {
      return this.result(row, 'retry', 'ownership_verification_unavailable');
    }
    try {
      const snapshot = await access.capability.readExact(
        access.credentials,
        access.context,
        row.remoteTaskId,
      );
      if (!(await this.fenceStillCurrent(access.connection))) {
        return this.keepUnknownForRetry(row, 'connection_changed_during_verification');
      }
      if (!snapshot) {
        return this.markNeedsAttention(row, 'remote_task_missing');
      }
      this.assertOwnedSnapshot(row, snapshot);
      return null;
    } catch (error) {
      if (this.isOwnershipFailure(error)) {
        return this.markNeedsAttention(row, this.ownershipFailureCode(error));
      }
      return this.persistVerificationFailure(row, error);
    }
  }

  private async admitMutation(row: ExternalManagedSubtaskLink): Promise<ProviderAccess | null> {
    const scopedConnection = await this.storage.getIntegrationConnectionById(
      row.connectionIdSnapshot,
    );
    if (!scopedConnection || scopedConnection.provider !== row.provider) {
      return null;
    }
    try {
      return await this.providerGate.run(
        this.connectionOperationScope(scopedConnection),
        async () => {
          const connection = await this.storage.getIntegrationConnectionById(
            row.connectionIdSnapshot,
          );
          if (
            !connection?.subtaskSyncEnabled ||
            connection.projectId !== scopedConnection.projectId ||
            connection.id !== row.connectionIdSnapshot ||
            connection.generation !== row.connectionGeneration ||
            connection.syncSettingRevision !== row.syncSettingRevision
          ) {
            return null;
          }
          const adapter = this.providers.get(row.provider);
          const credentials = await this.storage.getIntegrationConnectionCredentialsById(
            row.connectionIdSnapshot,
          );
          const rechecked = await this.storage.getIntegrationConnectionById(
            row.connectionIdSnapshot,
          );
          if (
            !adapter.subtaskSync ||
            !credentials ||
            credentials.provider !== row.provider ||
            !rechecked?.subtaskSyncEnabled ||
            rechecked.projectId !== connection.projectId ||
            rechecked.provider !== row.provider ||
            rechecked.id !== connection.id ||
            rechecked.generation !== connection.generation ||
            rechecked.syncSettingRevision !== connection.syncSettingRevision
          ) {
            return null;
          }
          await this.storage.updateExternalManagedSubtaskLink(row.id, {
            operationPhase: 'dispatch_admitted',
            safeErrorCode: null,
            retryAt: null,
          });
          return {
            connection,
            credentials,
            capability: adapter.subtaskSync,
            context: this.context(connection),
          };
        },
      );
    } catch (error) {
      if (error instanceof BusyError) {
        await this.storage.updateExternalManagedSubtaskLink(row.id, {
          operationPhase: 'pre_dispatch',
          safeErrorCode: 'provider_operation_busy',
          retryAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
        });
        return null;
      }
      throw error;
    }
  }

  private async captureReadAccess(row: ExternalManagedSubtaskLink): Promise<ProviderAccess | null> {
    const scopedConnection = await this.storage.getIntegrationConnectionById(
      row.connectionIdSnapshot,
    );
    if (!scopedConnection || scopedConnection.provider !== row.provider) {
      return null;
    }
    try {
      return await this.providerGate.run(
        this.connectionOperationScope(scopedConnection),
        async () => {
          const connection = await this.storage.getIntegrationConnectionById(
            row.connectionIdSnapshot,
          );
          const adapter = this.providers.get(row.provider);
          const credentials = await this.storage.getIntegrationConnectionCredentialsById(
            row.connectionIdSnapshot,
          );
          const rechecked = await this.storage.getIntegrationConnectionById(
            row.connectionIdSnapshot,
          );
          if (
            connection?.provider !== row.provider ||
            connection.projectId !== scopedConnection.projectId ||
            !connection.subtaskSyncEnabled ||
            !adapter.subtaskSync ||
            !credentials ||
            credentials.provider !== row.provider ||
            !rechecked?.subtaskSyncEnabled ||
            rechecked.projectId !== connection.projectId ||
            rechecked.provider !== row.provider ||
            rechecked.id !== connection.id ||
            rechecked.generation !== connection.generation ||
            rechecked.syncSettingRevision !== connection.syncSettingRevision
          ) {
            return null;
          }
          return {
            connection,
            credentials,
            capability: adapter.subtaskSync,
            context: this.context(connection),
          };
        },
      );
    } catch (error) {
      if (error instanceof BusyError) {
        return null;
      }
      throw error;
    }
  }

  private async refreshConnectionFence(
    row: ExternalManagedSubtaskLink,
    connection: IntegrationConnection,
  ): Promise<ExternalManagedSubtaskLink> {
    if (
      row.connectionIdSnapshot === connection.id &&
      row.connectionGeneration === connection.generation &&
      row.syncSettingRevision === connection.syncSettingRevision
    ) {
      return row;
    }
    if (!row.remoteTaskId) {
      return this.storage.updateExternalManagedSubtaskLink(row.id, {
        connectionIdSnapshot: connection.id,
        connectionGeneration: connection.generation,
        syncSettingRevision: connection.syncSettingRevision,
      });
    }

    const access = await this.captureReadAccess(row);
    if (!access) {
      return this.storage.updateExternalManagedSubtaskLink(row.id, {
        operationPhase: 'pre_dispatch',
        safeErrorCode: 'connection_fence_verification_pending',
        retryAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
      });
    }
    try {
      const snapshot = await access.capability.readExact(
        access.credentials,
        access.context,
        row.remoteTaskId,
      );
      if (!(await this.fenceStillCurrent(access.connection))) {
        return this.storage.updateExternalManagedSubtaskLink(row.id, {
          operationPhase: 'pre_dispatch',
          safeErrorCode: 'connection_fence_verification_pending',
          retryAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
        });
      }
      if (!snapshot) {
        return this.storage.updateExternalManagedSubtaskLink(row.id, {
          operationPhase: 'needs_attention',
          safeErrorCode: 'connection_generation_changed',
          retryAt: null,
        });
      }
      this.assertOwnedSnapshot(row, snapshot);
      return this.storage.updateExternalManagedSubtaskLink(row.id, {
        connectionIdSnapshot: connection.id,
        connectionGeneration: connection.generation,
        syncSettingRevision: connection.syncSettingRevision,
        safeErrorCode: null,
        retryAt: null,
      });
    } catch (error) {
      if (this.isOwnershipFailure(error)) {
        return this.storage.updateExternalManagedSubtaskLink(row.id, {
          operationPhase: 'needs_attention',
          safeErrorCode: this.ownershipFailureCode(error),
          retryAt: null,
        });
      }
      const failure = this.classifyFailure(error);
      return this.storage.updateExternalManagedSubtaskLink(row.id, {
        operationPhase: failure.retry ? 'pre_dispatch' : 'needs_attention',
        safeErrorCode: failure.safeErrorCode,
        retryAt: failure.retryAt,
      });
    }
  }

  private async desiredProjections(
    epic: Epic,
    providerFilter?: IntegrationProvider,
    connectionFilter?: IntegrationConnection,
    allowUnassignedConnection = false,
  ): Promise<Map<string, DesiredProjection>> {
    const result = new Map<string, DesiredProjection>();
    if (!epic.parentId) {
      return result;
    }
    const workspaceProjects = await this.storage.getProjectWorkspaceSnapshot(epic.projectId);
    const project = workspaceProjects.find((candidate) => candidate.id === epic.projectId);
    if (!project) {
      throw new NotFoundError('Project', epic.projectId);
    }
    const content = redactManagedSubtaskContent(epic, project.rootPath, undefined, {
      owningProjectId: project.id,
      projects: workspaceProjects,
    });
    const sources = await this.storage.listExternalTaskLinksForEpic(epic.parentId);
    for (const source of sources) {
      if (providerFilter && source.provider !== providerFilter) {
        continue;
      }
      if (connectionFilter && source.connectionId !== connectionFilter.id) {
        continue;
      }
      let connection = connectionFilter ?? null;
      if (!connection && source.connectionId) {
        connection = await this.storage.getIntegrationConnectionById(source.connectionId);
      }
      if (
        !connection?.subtaskSyncEnabled ||
        (connection.projectId !== epic.projectId &&
          !(allowUnassignedConnection && connection.projectId === null)) ||
        source.connectionId !== connection.id ||
        !this.providers.get(source.provider).subtaskSync
      ) {
        continue;
      }
      const workAreaRemoteId = this.sourceText(source.sourceSnapshot, 'workAreaId');
      if (!workAreaRemoteId) {
        continue;
      }
      result.set(source.id, {
        epic,
        content,
        parentSource: source,
        connection,
        workAreaRemoteId,
        desiredFingerprint: this.desiredFingerprint(content, source),
      });
    }
    return result;
  }

  private async createManagedProjection(
    desired: DesiredProjection,
  ): Promise<ExternalManagedSubtaskLink> {
    try {
      return await this.storage.createExternalManagedSubtaskLink({
        epicId: desired.epic.id,
        epicIdSnapshot: desired.epic.id,
        parentEpicIdSnapshot: desired.parentSource.epicId,
        parentSourceLinkIdSnapshot: desired.parentSource.id,
        connectionIdSnapshot: desired.connection.id,
        provider: desired.parentSource.provider,
        remoteScopeKey: desired.parentSource.remoteScopeKey,
        workAreaRemoteId: desired.workAreaRemoteId,
        parentRemoteTaskId: desired.parentSource.remoteTaskId,
        connectionGeneration: desired.connection.generation,
        syncSettingRevision: desired.connection.syncSettingRevision,
        ownershipToken: randomUUID().slice(0, 8),
        desiredVersion: desired.epic.version,
        desiredFingerprint: desired.desiredFingerprint,
      });
    } catch (error) {
      const existing = (
        await this.storage.listExternalManagedSubtaskLinksForEpicSnapshot(desired.epic.id)
      ).find((row) => row.parentSourceLinkIdSnapshot === desired.parentSource.id);
      if (existing) {
        return existing;
      }
      throw error;
    }
  }

  private async connectionDisconnected(
    provider: IntegrationProvider,
    connectionIdSnapshot: string,
  ): Promise<ManagedSubtaskReconcileResult[]> {
    const rows = (
      await this.storage.listExternalManagedSubtaskLinksByConnection(connectionIdSnapshot)
    ).filter((row) => row.provider === provider);
    return Promise.all(
      rows.map(async (row) => {
        const updated = await this.storage.updateExternalManagedSubtaskLink(row.id, {
          safeErrorCode: 'connection_missing',
          retryAt: null,
        });
        return this.result(updated, 'paused', 'connection_missing');
      }),
    );
  }

  private async persistPostAdmissionFailure(
    row: ExternalManagedSubtaskLink,
    error: unknown,
  ): Promise<ManagedSubtaskReconcileResult> {
    const failure = this.classifyFailure(error);
    const safeErrorCode = this.isOwnershipFailure(error)
      ? this.ownershipFailureCode(error)
      : failure.safeErrorCode === 'unexpected_provider_failure'
        ? 'post_dispatch_local_failure'
        : failure.safeErrorCode;
    const updated = await this.storage.updateExternalManagedSubtaskLink(row.id, {
      operationPhase: 'outcome_unknown',
      safeErrorCode,
      retryAt: failure.retryAt ?? new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
    });
    return this.result(updated, 'retry', safeErrorCode);
  }

  private async persistVerificationFailure(
    row: ExternalManagedSubtaskLink,
    error: unknown,
  ): Promise<ManagedSubtaskReconcileResult> {
    const failure = this.classifyFailure(error);
    if (!failure.retry) {
      return this.markNeedsAttention(row, failure.safeErrorCode);
    }
    const updated = await this.storage.updateExternalManagedSubtaskLink(row.id, {
      operationPhase: 'outcome_unknown',
      safeErrorCode: failure.safeErrorCode,
      retryAt: failure.retryAt,
    });
    return this.result(updated, 'retry', failure.safeErrorCode);
  }

  private classifyFailure(error: unknown): MutationFailure {
    if (error instanceof ExternalProviderError) {
      const reason =
        typeof error.details?.reason === 'string' ? error.details.reason : 'provider_error';
      const retryAt =
        typeof error.details?.retryAt === 'string'
          ? error.details.retryAt
          : new Date(Date.now() + RETRY_DELAY_MS).toISOString();
      if (error.details?.dispatched === true) {
        return {
          phase: 'outcome_unknown',
          safeErrorCode: `provider_${reason}`,
          retryAt,
          retry: true,
        };
      }
      if (error.details?.retryable === true) {
        return {
          phase: 'pre_dispatch',
          safeErrorCode: `provider_${reason}`,
          retryAt,
          retry: true,
        };
      }
      return {
        phase: 'needs_attention',
        safeErrorCode: `provider_${reason}`,
        retryAt: null,
        retry: false,
      };
    }
    return {
      phase: 'needs_attention',
      safeErrorCode: 'unexpected_provider_failure',
      retryAt: null,
      retry: false,
    };
  }

  private async markNeedsAttention(
    row: ExternalManagedSubtaskLink,
    reason: string,
  ): Promise<ManagedSubtaskReconcileResult> {
    const updated = await this.storage.updateExternalManagedSubtaskLink(row.id, {
      operationPhase: 'needs_attention',
      safeErrorCode: reason,
      retryAt: null,
    });
    return this.result(updated, 'needs_attention', reason);
  }

  private async markUnknown(row: ExternalManagedSubtaskLink, reason: string): Promise<void> {
    await this.storage.updateExternalManagedSubtaskLink(row.id, {
      operationPhase: 'outcome_unknown',
      safeErrorCode: reason,
      retryAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
    });
  }

  private async keepUnknownForRetry(
    row: ExternalManagedSubtaskLink,
    reason: string,
  ): Promise<ManagedSubtaskReconcileResult> {
    const updated = await this.storage.updateExternalManagedSubtaskLink(row.id, {
      operationPhase: 'outcome_unknown',
      safeErrorCode: reason,
      retryAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
    });
    return this.result(updated, 'retry', reason);
  }

  private assertOwnedSnapshot(
    row: ExternalManagedSubtaskLink,
    snapshot: ExternalSubtaskSnapshot,
  ): void {
    if (!snapshot.ownershipToken) {
      throw new Error('ownership_marker_missing');
    }
    if (snapshot.ownershipToken !== row.ownershipToken) {
      throw new Error('ownership_mismatch');
    }
    if (snapshot.parentRemoteTaskId !== row.parentRemoteTaskId) {
      throw new Error('parent_mismatch');
    }
    if (snapshot.workAreaRemoteId !== row.workAreaRemoteId) {
      throw new Error('work_area_mismatch');
    }
  }

  private isOwnershipFailure(error: unknown): boolean {
    if (
      error instanceof ExternalProviderError &&
      (error.details?.reason === 'ownership_mismatch' ||
        error.details?.reason === 'parent_mismatch')
    ) {
      return true;
    }
    return (
      error instanceof Error &&
      [
        'ownership_marker_missing',
        'ownership_mismatch',
        'parent_mismatch',
        'work_area_mismatch',
      ].includes(error.message)
    );
  }

  private ownershipFailureCode(error: unknown): string {
    if (
      error instanceof ExternalProviderError &&
      (error.details?.reason === 'ownership_mismatch' ||
        error.details?.reason === 'parent_mismatch')
    ) {
      return error.details.reason;
    }
    return error instanceof Error && this.isOwnershipFailure(error)
      ? error.message
      : 'ownership_mismatch';
  }

  private async fenceStillCurrent(expected: IntegrationConnection): Promise<boolean> {
    const current = await this.storage.getIntegrationConnectionById(expected.id);
    return (
      current?.subtaskSyncEnabled === true &&
      current.id === expected.id &&
      current.generation === expected.generation &&
      current.syncSettingRevision === expected.syncSettingRevision
    );
  }

  private sourceSnapshot(
    row: ExternalManagedSubtaskLink,
    desired: DesiredProjection,
    snapshot: ExternalSubtaskSnapshot,
    credentials: IntegrationCredentials,
  ): Record<string, unknown> {
    const parentSnapshot = desired.parentSource.sourceSnapshot;
    return {
      remoteKey: snapshot.remoteKey,
      title: snapshot.title,
      description: snapshot.description,
      webUrl: this.remoteWebUrl(row.provider, snapshot, credentials),
      workAreaId: row.workAreaRemoteId,
      workAreaName: this.sourceText(parentSnapshot, 'workAreaName') ?? row.workAreaRemoteId,
      statusName: 'Managed by DevChain',
      ownershipToken: row.ownershipToken,
      parentRemoteTaskId: row.parentRemoteTaskId,
      workAreaRemoteId: row.workAreaRemoteId,
    };
  }

  private remoteWebUrl(
    provider: IntegrationProvider,
    snapshot: ExternalSubtaskSnapshot,
    credentials: IntegrationCredentials,
  ): string | null {
    if (provider === 'clickup') {
      const candidate = `https://app.clickup.com/t/${encodeURIComponent(snapshot.remoteTaskId)}`;
      return normalizeExternalTaskSourceUrl(provider, candidate);
    }
    if (credentials.provider !== 'jira') {
      return null;
    }
    const candidate = `${new URL(credentials.siteUrl).origin}/browse/${encodeURIComponent(snapshot.remoteKey)}`;
    return normalizeExternalTaskSourceUrl(provider, candidate);
  }

  private desiredFingerprint(
    content: ManagedSubtaskContent,
    parentSource: ExternalTaskLink,
  ): string {
    return this.projectionFingerprint(
      content.title,
      content.description,
      parentSource.id,
      parentSource.remoteTaskId,
    );
  }

  private projectionFingerprint(
    title: string,
    description: string | null,
    parentSourceLinkId: string,
    parentRemoteTaskId: string,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          title,
          description,
          parentSourceLinkId,
          parentRemoteTaskId,
        }),
      )
      .digest('hex');
  }

  private sourceText(snapshot: Record<string, unknown>, key: string): string | null {
    const value = snapshot[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private context(connection: IntegrationConnection): ExternalProviderConnectionContext {
    return {
      connectionId: connection.id,
      connectionGeneration: connection.generation,
    };
  }

  private connectionOperationScope(connection: IntegrationConnection) {
    return connection.projectId
      ? { projectId: connection.projectId, provider: connection.provider }
      : { connectionId: connection.id, provider: connection.provider };
  }

  private retryIsInFuture(retryAt: string | null): boolean {
    return Boolean(retryAt && Date.parse(retryAt) > Date.now());
  }

  private assertExpectedConnection(
    row: ExternalManagedSubtaskLink,
    expectedConnectionId?: string,
  ): void {
    if (expectedConnectionId && row.connectionIdSnapshot !== expectedConnectionId) {
      throw new NotFoundError('Managed subtask link', row.id);
    }
  }

  private async loadEpicOrNull(id: string): Promise<Epic | null> {
    try {
      return await this.storage.getEpic(id);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return null;
      }
      throw error;
    }
  }

  private result(
    row: ExternalManagedSubtaskLink,
    outcome: ManagedSubtaskReconcileOutcome,
    reason?: string,
  ): ManagedSubtaskReconcileResult {
    return {
      epicId: row.epicIdSnapshot,
      provider: row.provider,
      managedLinkId: row.id,
      outcome,
      ...(reason ? { reason } : {}),
    };
  }

  private async withProjectionLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.projectionTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => tail);
    this.projectionTails.set(id, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.projectionTails.get(id) === queued) {
        this.projectionTails.delete(id);
      }
    }
  }
}
