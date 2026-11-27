import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  BusyError,
  ConflictError,
  NotFoundError,
  ValidationError,
  VaultUnavailableError,
} from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { EpicExternalLinkChangedEventPayload } from '../../events/catalog/epic.external_link.changed';
import type { RemoteProjectSyncedEventPayload } from '../../events/catalog/remote.project.synced';
import type { CommittedEvent } from '../../events/services/durable-event-registry.service';
import { EventsService } from '../../events/services/events.service';
import {
  STORAGE_SERVICE,
  type StorageService,
  type IntegrationStorage,
  type ProjectStorage,
} from '../../storage/interfaces/storage.interface';
import type {
  Epic,
  ExternalManagedSubtaskLink,
  ExternalTaskLink,
  IntegrationConnection,
  IntegrationCredentials,
  IntegrationProvider,
} from '../../storage/models/domain.models';
import {
  isOrdinaryExternalTaskLink,
  MANAGED_PROJECTION_SOURCE_CHANGED,
} from '../../storage/models/domain.models';
import { ExternalProviderError } from '../errors/external-provider.errors';
import { ExternalTaskProviderRegistry } from '../external-task-provider.registry';
import type {
  ExternalProviderConnectionContext,
  ExternalSubtaskSnapshot,
  ExternalSubtaskSyncCapability,
} from '../models/external-provider.models';
import { jiraSiteHostname, normalizeExternalTaskSourceUrl } from '../models/external-task-source';
import { ProviderOperationGate } from '../sessions/provider-operation-gate';
import {
  isManagedSubtaskRetryBlockedReason,
  isOutcomeUnknownPhase,
  managedSubtaskRetryDecision,
} from './managed-subtask-recovery-policy';
import { ManagedProjectionLock } from './managed-projection-lock';
import { IntegrationVmCacheService } from '../vm-cache/integration-vm-cache.service';
import {
  managedSubtaskContentMatches,
  type ManagedSubtaskContent,
  redactManagedSubtaskContent,
} from './managed-subtask-content';

const logger = createLogger('ExternalSubtaskSyncSubscriber');
export const MANAGED_SUBTASK_DELIVERY_KEY = 'managed-subtask-sync';
const RETRY_DELAY_MS = 30_000;
/** Safe error code of a projection whose connection now serves another remote scope. */
export const REMOTE_SCOPE_MISMATCH = 'remote_scope_mismatch';

/** Unwinds a reconcile before any vendor call; `reconcileExisting` records it on the row. */
class RemoteScopeMismatchError extends Error {}

/**
 * The remote scope a set of credentials serves, or null when the provider's
 * scope is not bound to the credentials. A Jira scope key is the site
 * hostname, and replacing the site keeps the connection id. ClickUp task ids
 * are global, so a ClickUp token never resolves a parent in another scope.
 */
function credentialRemoteScope(credentials: IntegrationCredentials): string | null {
  if (credentials.provider !== 'jira') {
    return null;
  }
  return jiraSiteHostname(credentials.siteUrl) ?? '';
}

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
  /**
   * The connection now serves another remote scope than the parent link. The
   * projection stays desired, so its row is kept as a diagnostic instead of
   * being removed as obsolete, but nothing is dispatched for it.
   */
  scopeMismatch: boolean;
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

  constructor(
    @Inject(STORAGE_SERVICE)
    private readonly storage: IntegrationStorage &
      ProjectStorage &
      Pick<StorageService, 'getEpic' | 'listProjectEpics' | 'listDirectChildEpicIds'>,
    private readonly events: EventsService,
    private readonly providers: ExternalTaskProviderRegistry,
    private readonly providerGate: ProviderOperationGate,
    private readonly projectionLock: ManagedProjectionLock,
    @Inject(IntegrationVmCacheService)
    private readonly host: Pick<IntegrationVmCacheService, 'isClaimedHost'>,
  ) {}

  onModuleInit(): void {
    this.unregister = this.events.registerDurableSubscriber({
      deliveryKey: MANAGED_SUBTASK_DELIVERY_KEY,
      ordered: false,
      eventNames: [
        'epic.created',
        'epic.updated',
        'epic.deleted',
        'epic.external_link.changed',
        'integration.connection.created',
        'integration.connection.updated',
        'integration.connection.deleted',
        'remote.project.synced',
      ],
      handle: (event) => this.handleCommittedEvent(event),
    });
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = undefined;
  }

  async handleCommittedEvent(event: CommittedEvent): Promise<void> {
    // Managed sync is home-only: a claimed VM holds delivered connections but never
    // projects sub-epics to the vendor.
    if (this.host.isClaimedHost()) return;
    let results: ManagedSubtaskReconcileResult[] = [];
    if (
      event.name === 'epic.created' ||
      event.name === 'epic.updated' ||
      event.name === 'epic.deleted'
    ) {
      const epicId = (event.payload as { epicId: string }).epicId;
      results = await this.reconcileEpic(epicId);
    } else if (event.name === 'epic.external_link.changed') {
      // The link write already released any projection it replaced; the
      // children now converge on the parent's current links.
      const { epicId } = event.payload as EpicExternalLinkChangedEventPayload;
      // One consistent read; each child then reconciles to its current state,
      // so a child deleted or moved since the read cannot end the loop.
      for (const childId of await this.storage.listDirectChildEpicIds(epicId)) {
        results.push(...(await this.reconcileEpic(childId)));
      }
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
    } else if (event.name === 'remote.project.synced') {
      // Mirror writes publish no `epic.*` events, so this is the only wake-up
      // for mirrored sub-epic changes. A null remoteId means this instance is
      // the host receiving an attach import: connections live at home only,
      // so there is nothing to reconcile here.
      const payload = event.payload as RemoteProjectSyncedEventPayload;
      if (payload.remoteId !== null) {
        for (const epicId of [...payload.changedEpicIds, ...payload.deletedEpicIds]) {
          results.push(...(await this.reconcileEpic(epicId)));
        }
        // A VM link change moves no child: its children converge on the parent's links.
        for (const epicId of payload.linkChangedEpicIds ?? []) {
          for (const childId of await this.storage.listDirectChildEpicIds(epicId)) {
            results.push(...(await this.reconcileEpic(childId)));
          }
        }
      }
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
      const result = await this.reconcileLocked(
        row,
        epic,
        desired.get(row.parentSourceLinkIdSnapshot) ?? null,
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
      if (!created) {
        results.push({
          epicId: epic.id,
          provider: projection.parentSource.provider,
          managedLinkId: null,
          outcome: 'unchanged',
          reason: 'projection_source_changed',
        });
        continue;
      }
      results.push(await this.reconcileLocked(created, epic, projection));
    }
    return results;
  }

  /**
   * An epic link change can release a projection while it is queued or in
   * flight here. Its next write then finds the row gone: that ends the
   * reconcile as a no-op, never as a retry, and nothing is recreated.
   */
  private async reconcileLocked(
    row: ExternalManagedSubtaskLink,
    epic: Epic | null,
    desired: DesiredProjection | null,
  ): Promise<ManagedSubtaskReconcileResult> {
    return this.withProjectionLock(row.id, async () => {
      try {
        return await this.reconcileExisting(row, epic, desired);
      } catch (error) {
        if (error instanceof NotFoundError && !(await this.projectionExists(row))) {
          logger.info(
            { epicId: row.epicIdSnapshot, managedLinkId: row.id },
            'Managed projection was released during reconciliation',
          );
          return this.result(row, 'unchanged', 'projection_released');
        }
        throw error;
      }
    });
  }

  private async projectionExists(row: ExternalManagedSubtaskLink): Promise<boolean> {
    const rows = await this.storage.listExternalManagedSubtaskLinksForEpicSnapshot(
      row.epicIdSnapshot,
    );
    return rows.some((candidate) => candidate.id === row.id);
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
      // A locked Vault throws here, before the row loses its state and error code.
      await this.storage.getIntegrationConnectionCredentialsById(row.connectionIdSnapshot);
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
      this.servingConnection(row),
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

  /**
   * A projection whose connection now serves another remote scope (a Jira
   * site replaced under the same connection id) is not dispatchable: it gets
   * `remote_scope_mismatch` with no vendor call, no retry, no delete and the
   * tombstone it had when this pass began, and its remote subtask stays where
   * it is. Retry or Verify resumes it once the connection serves the link's
   * scope again. A row whose reason already refuses Retry keeps that reason.
   */
  private async reconcileExisting(
    original: ExternalManagedSubtaskLink,
    epic: Epic | null,
    desired: DesiredProjection | null,
    allowUnassignedConnection = false,
  ): Promise<ManagedSubtaskReconcileResult> {
    const before = await this.storage.getExternalManagedSubtaskLink(original.id);
    if (desired?.scopeMismatch) {
      return this.markRemoteScopeMismatch(before);
    }
    try {
      return await this.reconcileExistingInScope(before, epic, desired, allowUnassignedConnection);
    } catch (error) {
      if (!(error instanceof RemoteScopeMismatchError)) {
        throw error;
      }
      return this.markRemoteScopeMismatch(before);
    }
  }

  private async markRemoteScopeMismatch(
    before: ExternalManagedSubtaskLink,
  ): Promise<ManagedSubtaskReconcileResult> {
    const row = await this.storage.getExternalManagedSubtaskLink(before.id);
    // An unknown outcome stays unknown: only a verification may settle it.
    const operationPhase = isOutcomeUnknownPhase(row.operationPhase)
      ? 'outcome_unknown'
      : 'needs_attention';
    // A reason that already refuses Retry (an incomplete ownership scan, for
    // example) stays: once the site is restored, Retry must still need proof
    // that another create is safe.
    const safeErrorCode = isManagedSubtaskRetryBlockedReason(row.safeErrorCode)
      ? row.safeErrorCode
      : REMOTE_SCOPE_MISMATCH;
    if (
      row.operationPhase === operationPhase &&
      row.safeErrorCode === safeErrorCode &&
      row.retryAt === null &&
      row.tombstoneState === before.tombstoneState
    ) {
      return this.result(row, 'needs_attention', REMOTE_SCOPE_MISMATCH);
    }
    // A removal found during this pass may already have tombstoned the row
    // before a fence saw the replaced site; that removal never dispatched.
    const updated = await this.storage.updateExternalManagedSubtaskLink(row.id, {
      operationPhase,
      safeErrorCode,
      retryAt: null,
      tombstoneState: before.tombstoneState,
      tombstonedAt: before.tombstonedAt,
    });
    logger.warn(
      { epicId: row.epicIdSnapshot, managedLinkId: row.id, provider: row.provider },
      'Managed subtask connection serves another remote scope; dispatch stopped',
    );
    return this.result(updated, 'needs_attention', REMOTE_SCOPE_MISMATCH);
  }

  /** Throws `RemoteScopeMismatchError` when the credentials serving a call left the row's scope. */
  private assertCredentialScope(
    row: ExternalManagedSubtaskLink,
    credentials: IntegrationCredentials,
  ): void {
    const scope = credentialRemoteScope(credentials);
    if (scope !== null && scope !== row.remoteScopeKey) {
      throw new RemoteScopeMismatchError();
    }
  }

  private async reconcileExistingInScope(
    current: ExternalManagedSubtaskLink,
    epic: Epic | null,
    desired: DesiredProjection | null,
    allowUnassignedConnection: boolean,
  ): Promise<ManagedSubtaskReconcileResult> {
    let row = current;
    const connection = await this.servingConnection(row);
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

    const fence = await this.refreshConnectionFence(row, connection);
    row = fence.row;
    if (!fence.current) {
      // The row stays on its prior connection with its state; nothing below
      // may run until a later pass verifies the remote child on this one.
      return this.result(
        row,
        row.operationPhase === 'needs_attention' ||
          row.tombstoneState === 'orphan_risk' ||
          !row.retryAt
          ? 'needs_attention'
          : 'retry',
        row.safeErrorCode ?? 'connection_fence_verification_pending',
      );
    }
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
    // The connection epoch belongs to the fence above; this records only the desired content.
    const desiredChanged =
      row.desiredVersion !== epic.version || row.desiredFingerprint !== desired.desiredFingerprint;
    if (desiredChanged) {
      row = await this.storage.updateExternalManagedSubtaskLink(row.id, {
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
        externalLinks: true,
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
          this.assertCredentialScope(row, credentials);
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

  /** `connectionId` is the connection that serves the read; the fence passes the one it verifies. */
  private async captureReadAccess(
    row: ExternalManagedSubtaskLink,
    connectionId = row.connectionIdSnapshot,
  ): Promise<ProviderAccess | null> {
    const scopedConnection = await this.storage.getIntegrationConnectionById(connectionId);
    if (!scopedConnection || scopedConnection.provider !== row.provider) {
      return null;
    }
    try {
      return await this.providerGate.run(
        this.connectionOperationScope(scopedConnection),
        async () => {
          const connection = await this.storage.getIntegrationConnectionById(connectionId);
          const adapter = this.providers.get(row.provider);
          const credentials =
            await this.storage.getIntegrationConnectionCredentialsById(connectionId);
          const rechecked = await this.storage.getIntegrationConnectionById(connectionId);
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
          this.assertCredentialScope(row, credentials);
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

  /**
   * The row's own connection, or, once that connection is gone, the current
   * connection of its parent link (a disconnect, then the parent linked to
   * the same task again). The connection fence verifies the remote child on
   * it before the row moves there.
   */
  private async servingConnection(
    row: ExternalManagedSubtaskLink,
  ): Promise<IntegrationConnection | null> {
    const stored = await this.storage.getIntegrationConnectionById(row.connectionIdSnapshot);
    if (stored) {
      return stored;
    }
    const parentLink = (
      await this.storage.listExternalTaskLinksForEpic(row.parentEpicIdSnapshot)
    ).find((link) => link.id === row.parentSourceLinkIdSnapshot);
    if (!parentLink?.connectionId || !isOrdinaryExternalTaskLink(parentLink)) {
      return null;
    }
    const connection = await this.storage.getIntegrationConnectionById(parentLink.connectionId);
    if (
      connection?.provider !== row.provider ||
      connection.projectId !== parentLink.projectId ||
      !connection.subtaskSyncEnabled
    ) {
      return null;
    }
    return connection;
  }

  private async refreshConnectionFence(
    row: ExternalManagedSubtaskLink,
    connection: IntegrationConnection,
  ): Promise<{ row: ExternalManagedSubtaskLink; current: boolean }> {
    if (
      row.connectionIdSnapshot === connection.id &&
      row.connectionGeneration === connection.generation &&
      row.syncSettingRevision === connection.syncSettingRevision
    ) {
      return { row, current: true };
    }
    if (!row.remoteTaskId) {
      const moved = await this.storage.updateExternalManagedSubtaskLink(row.id, {
        connectionIdSnapshot: connection.id,
        connectionGeneration: connection.generation,
        syncSettingRevision: connection.syncSettingRevision,
      });
      return { row: moved, current: true };
    }

    const access = await this.captureReadAccess(row, connection.id);
    if (!access) {
      return this.deferConnectionFence(row, {
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
        return this.deferConnectionFence(row, {
          operationPhase: 'pre_dispatch',
          safeErrorCode: 'connection_fence_verification_pending',
          retryAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
        });
      }
      if (!snapshot) {
        return this.stopConnectionFence(row, 'connection_generation_changed');
      }
      this.assertOwnedSnapshot(row, snapshot);
      const moved = await this.storage.updateExternalManagedSubtaskLink(row.id, {
        connectionIdSnapshot: access.connection.id,
        connectionGeneration: access.connection.generation,
        syncSettingRevision: access.connection.syncSettingRevision,
        // A row that needs attention keeps its reason: it decides whether Retry is allowed.
        ...(row.operationPhase === 'needs_attention' ? {} : { safeErrorCode: null, retryAt: null }),
      });
      return { row: moved, current: true };
    } catch (error) {
      if (this.isOwnershipFailure(error)) {
        return this.stopConnectionFence(row, this.ownershipFailureCode(error));
      }
      const failure = this.classifyFailure(error);
      return this.deferConnectionFence(row, {
        operationPhase: failure.retry ? 'pre_dispatch' : 'needs_attention',
        safeErrorCode: failure.safeErrorCode,
        retryAt: failure.retryAt,
      });
    }
  }

  /** The remote child failed the check on this connection; the row stays on its own. */
  private async stopConnectionFence(
    row: ExternalManagedSubtaskLink,
    safeErrorCode: string,
  ): Promise<{ row: ExternalManagedSubtaskLink; current: false }> {
    const stopped = await this.storage.updateExternalManagedSubtaskLink(row.id, {
      operationPhase: 'needs_attention',
      safeErrorCode,
      retryAt: null,
    });
    return { row: stopped, current: false };
  }

  /**
   * Records a connection fence that could not verify the remote child. The
   * row stays on its connection. A row that needs attention keeps its phase
   * and reason, and an unknown outcome stays unknown, so verification still
   * comes before any write when a later pass checks the fence again.
   */
  private async deferConnectionFence(
    row: ExternalManagedSubtaskLink,
    failure: {
      operationPhase: 'pre_dispatch' | 'needs_attention';
      safeErrorCode: string;
      retryAt: string | null;
    },
  ): Promise<{ row: ExternalManagedSubtaskLink; current: false }> {
    if (row.operationPhase === 'needs_attention') {
      return { row, current: false };
    }
    const deferred = await this.storage.updateExternalManagedSubtaskLink(
      row.id,
      isOutcomeUnknownPhase(row.operationPhase)
        ? { ...failure, operationPhase: 'outcome_unknown' }
        : failure,
    );
    return { row: deferred, current: false };
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
    const credentialScopes = new Map<string, Promise<string | null | undefined>>();
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
      if (!credentialScopes.has(connection.id)) {
        credentialScopes.set(connection.id, this.readCredentialScope(connection));
      }
      const credentialScope = await credentialScopes.get(connection.id);
      result.set(source.id, {
        epic,
        content,
        parentSource: source,
        connection,
        workAreaRemoteId,
        desiredFingerprint: this.desiredFingerprint(content, source),
        scopeMismatch:
          typeof credentialScope === 'string' && credentialScope !== source.remoteScopeKey,
      });
    }
    return result;
  }

  /**
   * The remote scope the connection's credentials serve now; undefined when
   * that cannot be read. Read and write admission check again on the
   * credentials that serve the call, so undefined only defers the decision.
   */
  private async readCredentialScope(
    connection: IntegrationConnection,
  ): Promise<string | null | undefined> {
    if (connection.provider !== 'jira') {
      return null;
    }
    try {
      const credentials = await this.storage.getIntegrationConnectionCredentialsById(connection.id);
      return credentials ? credentialRemoteScope(credentials) : undefined;
    } catch (error) {
      if (error instanceof VaultUnavailableError) {
        return undefined;
      }
      throw error;
    }
  }

  /** Null when the desired source changed after it was read; that change has its own wake-up. */
  private async createManagedProjection(
    desired: DesiredProjection,
  ): Promise<ExternalManagedSubtaskLink | null> {
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
      if (
        error instanceof ValidationError &&
        error.details?.reason === MANAGED_PROJECTION_SOURCE_CHANGED
      ) {
        return null;
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
        // A reason that already refuses Retry stays: after a reconnect and a
        // rebind, Retry must still need proof that another create is safe.
        const safeErrorCode = isManagedSubtaskRetryBlockedReason(row.safeErrorCode)
          ? row.safeErrorCode
          : 'connection_missing';
        const updated = await this.storage.updateExternalManagedSubtaskLink(row.id, {
          safeErrorCode,
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

  private withProjectionLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.projectionLock.run(id, operation);
  }
}
