import { Inject, Injectable } from '@nestjs/common';
import {
  BusyError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors/error-types';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { LEGACY_UNASSIGNED_PROJECT_ID } from '../../storage/models/domain.models';
import type {
  IntegrationConnection,
  IntegrationCredentials,
  IntegrationProvider,
} from '../../storage/models/domain.models';
import { ExternalProviderError } from '../errors/external-provider.errors';
import { ExternalTaskProviderRegistry } from '../external-task-provider.registry';
import type {
  ExternalTaskTimeEntryInput,
  ExternalTimeEntryMutationsCapability,
} from '../models/external-provider.models';
import {
  TIME_CREATE_BASELINE_WINDOW_MS,
  TIME_ENTRY_START_TOLERANCE_MS,
  timeOperationCanVerify,
  type ExternalTimeEntryCreateResult,
  type ExternalTimeEntryUpdateResult,
  type ExternalTimeMutationReceipt,
  type ExternalTimeEntryDeleteResult,
  type ExternalTimeMutationTuple,
  type ExternalTimeOperationReceiptView,
  type ExternalTimeOperationInspection,
  type ExternalTimeOperationVerifyResult,
} from '../models/external-time-mutation.models';
import { timeEntryNoteFingerprint } from '../sessions/external-time-mutation.store';
import { ExternalTimeMutationStore } from '../sessions/external-time-mutation.store';
import { ProviderOperationGate } from '../sessions/provider-operation-gate';

/**
 * A failure whose outcome at the vendor is unknown: the request had been
 * dispatched, and timeout, network loss, an unusable 5xx, or an unreadable
 * response cannot prove the mutation did not land.
 */
function isUnknownOutcome(error: unknown): boolean {
  return (
    error instanceof ExternalProviderError &&
    error.details?.dispatched === true &&
    (error.details?.reason === 'timeout' ||
      error.details?.reason === 'unavailable' ||
      error.details?.reason === 'invalid_response')
  );
}

function isProviderNotFound(error: unknown): boolean {
  return error instanceof ExternalProviderError && error.details?.reason === 'not_found';
}

/**
 * Epoch-fenced, receipt-bound time-entry mutations. Every write validates the
 * caller's expected connection epoch before credentials load, rechecks the
 * epoch inside the shared provider operation gate, and records a bounded
 * in-memory receipt so one operation id can never dispatch twice. Dispatched
 * ambiguity resolves only from exact provider proof; DevChain never retries
 * a time mutation automatically.
 */
@Injectable()
export class ExternalTimeMutationService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly providers: ExternalTaskProviderRegistry,
    private readonly gate: ProviderOperationGate,
    private readonly store: ExternalTimeMutationStore,
  ) {}

  inspectOperation(operationId: string): ExternalTimeOperationInspection | null {
    const receipt = this.store.get(operationId);
    if (!receipt) {
      return null;
    }
    const view = this.store.view(receipt);
    return {
      operationId: receipt.operationId,
      kind: receipt.kind,
      tuple: { ...receipt.tuple },
      phase: receipt.phase,
      canVerify: view.canVerify,
      expiresAt: view.expiresAt,
    };
  }

  async createTimeEntry(
    projectId: string,
    provider: IntegrationProvider,
    remoteTaskId: string,
    input: ExternalTaskTimeEntryInput,
    operationId: string,
    expectedEpoch: number,
    remoteScopeKey: string,
  ): Promise<ExternalTimeEntryCreateResult> {
    return this.createTimeEntryInternal(
      projectId,
      provider,
      remoteTaskId,
      input,
      operationId,
      expectedEpoch,
      this.requireRemoteScopeKey(remoteScopeKey),
    );
  }

  /** Estimate-only dispatch after EpicEstimateLoggingService has prepared the
   * exact durable pending operation; ordinary callers must use createTimeEntry. */
  async createEstimateTimeEntry(
    projectId: string,
    provider: IntegrationProvider,
    remoteTaskId: string,
    input: ExternalTaskTimeEntryInput,
    operationId: string,
    expectedEpoch: number,
  ): Promise<ExternalTimeEntryCreateResult> {
    return this.createTimeEntryInternal(
      projectId,
      provider,
      remoteTaskId,
      input,
      operationId,
      expectedEpoch,
      null,
    );
  }

  private async createTimeEntryInternal(
    projectId: string,
    provider: IntegrationProvider,
    remoteTaskId: string,
    input: ExternalTaskTimeEntryInput,
    operationId: string,
    expectedEpoch: number,
    remoteScopeKey: string | null,
  ): Promise<ExternalTimeEntryCreateResult> {
    const connection = await this.precheckEpoch(projectId, provider, expectedEpoch);
    const capability = this.requireCapability(provider);
    const credentials = await this.loadCredentials(projectId, provider);
    const tuple: ExternalTimeMutationTuple = {
      provider,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      remoteTaskId,
      remoteEntryId: null,
      effectiveStartedAt: input.startedAt,
      durationMs: input.durationMs,
      noteFingerprint: timeEntryNoteFingerprint(input.note),
    };
    const context = { connectionId: connection.id, connectionGeneration: connection.generation };
    const startedAtMs = Date.parse(input.startedAt);
    const windowFrom = startedAtMs - TIME_CREATE_BASELINE_WINDOW_MS;
    const windowTo = startedAtMs + TIME_CREATE_BASELINE_WINDOW_MS;

    return this.gate.run({ projectId, provider }, async () => {
      await this.recheckEpoch(projectId, provider, connection);
      if (remoteScopeKey !== null) {
        await this.assertNoPendingEstimate(connection, provider, remoteScopeKey, remoteTaskId);
      } else {
        this.assertNoLiveTaskMutation(tuple, operationId);
      }

      // Baseline before dispatch: own-entry ids near the effective start.
      const baseline = await capability.listOwnTimeEntryIdsInRange(
        credentials,
        context,
        remoteTaskId,
        windowFrom,
        windowTo,
      );

      const admitted = this.store.admit({
        operationId,
        kind: 'create',
        tuple,
        baseline: { matchingIds: baseline.ids, complete: baseline.complete },
      });
      if (!admitted.ok) {
        if (
          (admitted.reason === 'duplicate_live' || admitted.reason === 'duplicate_terminal') &&
          admitted.receipt?.kind === 'create'
        ) {
          const replay = this.replayCreate(admitted.receipt);
          if (replay !== null) {
            return replay;
          }
        }
        throw this.admitFailure(operationId, admitted.reason, admitted.receipt?.phase);
      }

      try {
        this.store.markDispatched(operationId);
        const proof = await capability.createTimeEntry(credentials, context, remoteTaskId, input);
        this.store.markTerminal(operationId, 'succeeded', proof.remoteEntryId);
        return {
          outcome: 'created',
          remoteEntryId: proof.remoteEntryId,
          refresh: ['task_detail'],
          receipt: this.requireView(operationId),
        };
      } catch (error) {
        if (isUnknownOutcome(error)) {
          this.store.markUnknown(operationId);
          return { outcome: 'outcome_unknown', receipt: this.requireView(operationId) };
        }
        this.store.markTerminal(operationId, 'failed');
        throw error;
      }
    });
  }

  async deleteTimeEntry(
    projectId: string,
    provider: IntegrationProvider,
    remoteTaskId: string,
    remoteEntryId: string,
    operationId: string,
    expectedEpoch: number,
    remoteScopeKey: string,
  ): Promise<ExternalTimeEntryDeleteResult> {
    const normalizedScopeKey = this.requireRemoteScopeKey(remoteScopeKey);
    const connection = await this.precheckEpoch(projectId, provider, expectedEpoch);
    const capability = this.requireCapability(provider);
    const credentials = await this.loadCredentials(projectId, provider);
    const tuple: ExternalTimeMutationTuple = {
      provider,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      remoteTaskId,
      remoteEntryId,
      effectiveStartedAt: null,
      durationMs: null,
      noteFingerprint: null,
    };
    const context = { connectionId: connection.id, connectionGeneration: connection.generation };

    return this.gate.run({ projectId, provider }, async () => {
      await this.recheckEpoch(projectId, provider, connection);
      await this.assertNoPendingEstimate(connection, provider, normalizedScopeKey, remoteTaskId);

      // Provider-specific preflight: presence and ownership proof before any
      // mutation is dispatched.
      await capability.assertTimeEntryDeletable(credentials, context, remoteTaskId, remoteEntryId);

      const admitted = this.store.admit({
        operationId,
        kind: 'delete',
        tuple,
        baseline: null,
      });
      if (!admitted.ok) {
        if (
          (admitted.reason === 'duplicate_live' || admitted.reason === 'duplicate_terminal') &&
          admitted.receipt?.kind === 'delete'
        ) {
          const replay = this.replayDelete(admitted.receipt);
          if (replay !== null) {
            return replay;
          }
        }
        throw this.admitFailure(operationId, admitted.reason, admitted.receipt?.phase);
      }

      try {
        this.store.markDispatched(operationId);
        await capability.deleteTimeEntry(credentials, context, remoteTaskId, remoteEntryId);
        this.store.markTerminal(operationId, 'succeeded', remoteEntryId);
        return { outcome: 'deleted', receipt: this.requireView(operationId) };
      } catch (error) {
        if (isProviderNotFound(error)) {
          // The exact resource was already gone at delete time.
          this.store.markTerminal(operationId, 'already_deleted');
          return { outcome: 'already_deleted', receipt: this.requireView(operationId) };
        }
        if (isUnknownOutcome(error)) {
          this.store.markUnknown(operationId);
          return { outcome: 'outcome_unknown', receipt: this.requireView(operationId) };
        }
        this.store.markTerminal(operationId, 'failed');
        throw error;
      }
    });
  }

  async updateTimeEntry(
    projectId: string,
    provider: IntegrationProvider,
    remoteTaskId: string,
    remoteEntryId: string,
    input: ExternalTaskTimeEntryInput,
    operationId: string,
    expectedEpoch: number,
    remoteScopeKey: string,
  ): Promise<ExternalTimeEntryUpdateResult> {
    const normalizedScopeKey = this.requireRemoteScopeKey(remoteScopeKey);
    const connection = await this.precheckEpoch(projectId, provider, expectedEpoch);
    const capability = this.requireCapability(provider);
    const credentials = await this.loadCredentials(projectId, provider);
    const tuple: ExternalTimeMutationTuple = {
      provider,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      remoteTaskId,
      remoteEntryId,
      effectiveStartedAt: input.startedAt,
      durationMs: input.durationMs,
      noteFingerprint: timeEntryNoteFingerprint(input.note),
    };
    const context = { connectionId: connection.id, connectionGeneration: connection.generation };

    return this.gate.run({ projectId, provider }, async () => {
      await this.recheckEpoch(projectId, provider, connection);
      await this.assertNoPendingEstimate(connection, provider, normalizedScopeKey, remoteTaskId);
      const baseline = await capability.assertTimeEntryEditable(
        credentials,
        context,
        remoteTaskId,
        remoteEntryId,
      );
      const updateBaseline = {
        startedAt: baseline.startedAt,
        durationMs: baseline.durationMs,
        noteFingerprint: timeEntryNoteFingerprint(baseline.note),
      };
      const admitted = this.store.admit({
        operationId,
        kind: 'update',
        tuple,
        baseline: null,
        updateBaseline,
      });
      if (!admitted.ok) {
        if (
          (admitted.reason === 'duplicate_live' || admitted.reason === 'duplicate_terminal') &&
          admitted.receipt?.kind === 'update'
        ) {
          const replay = this.replayUpdate(admitted.receipt);
          if (replay !== null) {
            return replay;
          }
        }
        throw this.admitFailure(operationId, admitted.reason, admitted.receipt?.phase);
      }
      if (this.exactMatchesTuple(baseline, tuple)) {
        this.store.markTerminal(operationId, 'not_applied', remoteEntryId);
        return { outcome: 'not_applied', receipt: this.requireView(operationId) };
      }

      try {
        this.store.markDispatched(operationId);
        await capability.updateTimeEntry(credentials, context, remoteTaskId, remoteEntryId, input);
        let exact: Awaited<ReturnType<ExternalTimeEntryMutationsCapability['readTimeEntryExact']>>;
        try {
          exact = await capability.readTimeEntryExact(
            credentials,
            context,
            remoteTaskId,
            remoteEntryId,
          );
        } catch {
          this.store.markUnknown(operationId);
          return { outcome: 'outcome_unknown', receipt: this.requireView(operationId) };
        }
        if (exact !== null && this.exactMatchesTuple(exact, tuple)) {
          this.store.markTerminal(operationId, 'succeeded', remoteEntryId);
          return { outcome: 'updated', receipt: this.requireView(operationId) };
        }
        if (exact !== null && this.exactMatchesUpdateBaseline(exact, updateBaseline)) {
          this.store.markTerminal(operationId, 'not_applied', remoteEntryId);
          return { outcome: 'not_applied', receipt: this.requireView(operationId) };
        }
        this.store.markUnknown(operationId);
        return { outcome: 'outcome_unknown', receipt: this.requireView(operationId) };
      } catch (error) {
        if (isUnknownOutcome(error)) {
          this.store.markUnknown(operationId);
          return { outcome: 'outcome_unknown', receipt: this.requireView(operationId) };
        }
        this.store.markTerminal(operationId, 'failed');
        throw error;
      }
    });
  }

  async getOperation(
    projectId: string,
    provider: IntegrationProvider,
    operationId: string,
    expectedEpoch: number,
  ): Promise<ExternalTimeOperationReceiptView> {
    const connection = await this.precheckEpoch(projectId, provider, expectedEpoch);
    const receipt = this.store.get(operationId);
    if (!receipt || receipt.tuple.provider !== provider) {
      throw new NotFoundError('Time entry operation', operationId);
    }
    this.assertReceiptConnection(receipt, connection);
    return this.store.view(receipt);
  }

  /**
   * Resolves an unknown receipt from exact provider proof only: a create
   * needs complete before/after id sets and exactly one new matching entry;
   * a delete needs the exact-resource GET (404 proves deletion, presence
   * proves it never landed). Collection absence never resolves anything. An
   * unknown create whose stored baseline was incomplete returns
   * completeness_not_provable before credentials load and before any
   * provider call.
   */
  async verifyOperation(
    projectId: string,
    provider: IntegrationProvider,
    operationId: string,
    expectedEpoch: number,
  ): Promise<ExternalTimeOperationVerifyResult> {
    const connection = await this.precheckEpoch(projectId, provider, expectedEpoch);
    const receipt = this.store.get(operationId);
    if (!receipt) {
      throw new NotFoundError('Time entry operation', operationId);
    }
    if (
      receipt.tuple.provider !== provider ||
      receipt.tuple.connectionId !== connection.id ||
      receipt.tuple.connectionGeneration !== connection.generation
    ) {
      throw new ConflictError('The operation belongs to a different connection epoch.', {
        reason: 'connection_superseded',
      });
    }
    if (receipt.phase !== 'outcome_unknown') {
      return {
        receipt: this.store.view(receipt),
        resolved: false,
        resolution: 'already_terminal',
      };
    }
    return this.gate.run({ projectId, provider }, async () => {
      await this.recheckEpoch(projectId, provider, connection);
      const current = this.store.get(operationId);
      if (!current) {
        throw new NotFoundError('Time entry operation', operationId);
      }
      this.assertReceiptConnection(current, connection);
      if (current.phase !== 'outcome_unknown') {
        return {
          receipt: this.store.view(current),
          resolved: false,
          resolution: 'already_terminal',
        };
      }
      if (!timeOperationCanVerify(current)) {
        return {
          receipt: this.store.view(current),
          resolved: false,
          resolution: 'completeness_not_provable',
        };
      }
      const credentials = await this.loadReceiptCredentials(projectId, provider, connection);
      return this.verifyUnknownOperation(
        projectId,
        provider,
        operationId,
        connection,
        current,
        credentials,
      );
    });
  }

  private async verifyUnknownOperation(
    projectId: string,
    provider: IntegrationProvider,
    operationId: string,
    connection: IntegrationConnection,
    receipt: ExternalTimeMutationReceipt,
    credentials: IntegrationCredentials,
  ): Promise<ExternalTimeOperationVerifyResult> {
    const capability = this.requireCapability(provider);
    const context = {
      connectionId: receipt.tuple.connectionId,
      connectionGeneration: receipt.tuple.connectionGeneration,
    };

    if (receipt.kind === 'update') {
      const entryId = receipt.tuple.remoteEntryId!;
      let exact: Awaited<ReturnType<ExternalTimeEntryMutationsCapability['readTimeEntryExact']>>;
      try {
        exact = await capability.readTimeEntryExact(
          credentials,
          context,
          receipt.tuple.remoteTaskId,
          entryId,
        );
      } catch {
        return {
          receipt: this.requireView(operationId),
          resolved: false,
          resolution: 'verify_failed',
        };
      }
      await this.recheckEpoch(projectId, provider, connection);
      if (exact !== null && this.exactMatchesTuple(exact, receipt.tuple)) {
        this.store.markTerminal(operationId, 'succeeded', entryId);
        return {
          receipt: this.requireView(operationId),
          resolved: true,
          resolution: 'updated',
        };
      }
      if (
        exact !== null &&
        receipt.updateBaseline !== null &&
        this.exactMatchesUpdateBaseline(exact, receipt.updateBaseline)
      ) {
        this.store.markTerminal(operationId, 'not_applied', entryId);
        return {
          receipt: this.requireView(operationId),
          resolved: true,
          resolution: 'not_applied',
        };
      }
      return {
        receipt: this.requireView(operationId),
        resolved: false,
        resolution: 'unresolved',
      };
    }

    if (receipt.kind === 'delete') {
      const entryId = receipt.tuple.remoteEntryId!;
      let exact: Awaited<ReturnType<ExternalTimeEntryMutationsCapability['readTimeEntryExact']>>;
      try {
        exact = await capability.readTimeEntryExact(
          credentials,
          context,
          receipt.tuple.remoteTaskId,
          entryId,
        );
      } catch {
        return {
          receipt: this.requireView(operationId),
          resolved: false,
          resolution: 'verify_failed',
        };
      }
      await this.recheckEpoch(projectId, provider, connection);
      if (exact === null) {
        this.store.markTerminal(operationId, 'already_deleted', entryId);
        return {
          receipt: this.requireView(operationId),
          resolved: true,
          resolution: 'already_deleted',
        };
      }
      this.store.markTerminal(operationId, 'not_applied', entryId);
      return {
        receipt: this.requireView(operationId),
        resolved: true,
        resolution: 'not_applied',
      };
    }

    // Create verification: complete before/after id sets, then exactly one
    // new matching entry.
    const baseline = receipt.baseline;
    const startedAtMs = Date.parse(receipt.tuple.effectiveStartedAt!);
    const windowFrom = startedAtMs - TIME_CREATE_BASELINE_WINDOW_MS;
    const windowTo = startedAtMs + TIME_CREATE_BASELINE_WINDOW_MS;
    let after: { ids: string[]; complete: boolean };
    try {
      after = await capability.listOwnTimeEntryIdsInRange(
        credentials,
        context,
        receipt.tuple.remoteTaskId,
        windowFrom,
        windowTo,
      );
    } catch {
      return {
        receipt: this.requireView(operationId),
        resolved: false,
        resolution: 'verify_failed',
      };
    }
    if (!baseline?.complete || !after.complete) {
      return {
        receipt: this.requireView(operationId),
        resolved: false,
        resolution: 'completeness_not_provable',
      };
    }
    const baselineIds = new Set(baseline.matchingIds);
    const newIds = after.ids.filter((id) => !baselineIds.has(id));
    if (newIds.length === 0) {
      await this.recheckEpoch(projectId, provider, connection);
      this.store.markTerminal(operationId, 'not_applied');
      return { receipt: this.requireView(operationId), resolved: true, resolution: 'not_applied' };
    }
    const matches: string[] = [];
    for (const candidateId of newIds) {
      let candidate: Awaited<
        ReturnType<ExternalTimeEntryMutationsCapability['readTimeEntryExact']>
      >;
      try {
        candidate = await capability.readTimeEntryExact(
          credentials,
          context,
          receipt.tuple.remoteTaskId,
          candidateId,
        );
      } catch {
        return {
          receipt: this.requireView(operationId),
          resolved: false,
          resolution: 'verify_failed',
        };
      }
      if (candidate === null) {
        continue;
      }
      const startDelta = Math.abs(Date.parse(candidate.startedAt) - startedAtMs);
      if (
        candidate.owned &&
        candidate.durationMs === receipt.tuple.durationMs &&
        startDelta <= TIME_ENTRY_START_TOLERANCE_MS
      ) {
        matches.push(candidateId);
      }
    }
    if (matches.length === 1) {
      await this.recheckEpoch(projectId, provider, connection);
      this.store.markTerminal(operationId, 'succeeded', matches[0]!);
      return { receipt: this.requireView(operationId), resolved: true, resolution: 'created' };
    }
    return { receipt: this.requireView(operationId), resolved: false, resolution: 'unresolved' };
  }

  /**
   * Duplicate-risk acknowledgement: the caller accepts the ambiguity of an
   * unknown receipt and the receipt becomes terminal abandoned_unknown.
   */
  async acknowledgeOperation(
    projectId: string,
    provider: IntegrationProvider,
    operationId: string,
    expectedEpoch: number,
  ): Promise<ExternalTimeOperationReceiptView> {
    const connection = await this.precheckEpoch(projectId, provider, expectedEpoch);
    return this.gate.run({ projectId, provider }, async () => {
      await this.recheckEpoch(projectId, provider, connection);
      const existing = this.store.get(operationId);
      if (!existing || existing.tuple.provider !== provider) {
        throw new NotFoundError('Time entry operation', operationId);
      }
      this.assertReceiptConnection(existing, connection);
      const acked = this.store.acknowledgeUnknown(operationId);
      if (!acked.ok) {
        if (acked.reason === 'not_found') {
          throw new NotFoundError('Time entry operation', operationId);
        }
        throw new ConflictError('Only an unresolved operation can be acknowledged.', {
          reason: 'operation_not_unknown',
        });
      }
      return this.store.view(acked.receipt);
    });
  }

  /**
   * Replay semantics for a reused operation id with the same tuple: recorded
   * outcomes return idempotently and never re-dispatch; ambiguity returns
   * unknown again. Returns null when the caller must raise an error instead.
   */
  private replayCreate(receipt: ExternalTimeMutationReceipt): ExternalTimeEntryCreateResult | null {
    const view = this.store.view(receipt);
    if (receipt.phase === 'outcome_unknown') {
      return { outcome: 'outcome_unknown', receipt: view };
    }
    if (receipt.phase === 'succeeded') {
      return {
        outcome: 'created',
        remoteEntryId: receipt.remoteEntryId,
        refresh: ['task_detail'],
        receipt: view,
      };
    }
    return null;
  }

  private replayDelete(receipt: ExternalTimeMutationReceipt): ExternalTimeEntryDeleteResult | null {
    const view = this.store.view(receipt);
    if (receipt.phase === 'outcome_unknown') {
      return { outcome: 'outcome_unknown', receipt: view };
    }
    if (receipt.phase === 'succeeded') {
      return { outcome: 'deleted', receipt: view };
    }
    if (receipt.phase === 'already_deleted') {
      return { outcome: 'already_deleted', receipt: view };
    }
    return null;
  }

  private replayUpdate(receipt: ExternalTimeMutationReceipt): ExternalTimeEntryUpdateResult | null {
    const view = this.store.view(receipt);
    if (receipt.phase === 'outcome_unknown') {
      return { outcome: 'outcome_unknown', receipt: view };
    }
    if (receipt.phase === 'succeeded') {
      return { outcome: 'updated', receipt: view };
    }
    if (receipt.phase === 'not_applied') {
      return { outcome: 'not_applied', receipt: view };
    }
    return null;
  }

  private exactMatchesTuple(
    exact: {
      startedAt: string;
      durationMs: number;
      note: string | null;
    },
    tuple: ExternalTimeMutationTuple,
  ): boolean {
    return (
      exact.startedAt === tuple.effectiveStartedAt &&
      exact.durationMs === tuple.durationMs &&
      timeEntryNoteFingerprint(exact.note) === tuple.noteFingerprint
    );
  }

  private exactMatchesUpdateBaseline(
    exact: {
      startedAt: string;
      durationMs: number;
      note: string | null;
    },
    baseline: NonNullable<ExternalTimeMutationReceipt['updateBaseline']>,
  ): boolean {
    return (
      exact.startedAt === baseline.startedAt &&
      exact.durationMs === baseline.durationMs &&
      timeEntryNoteFingerprint(exact.note) === baseline.noteFingerprint
    );
  }

  /** Validates the caller's expected epoch before any credentials load. */
  private async precheckEpoch(
    projectId: string,
    provider: IntegrationProvider,
    expectedEpoch: number,
  ): Promise<IntegrationConnection> {
    await this.storage.getProject(projectId);
    const connection = await this.storage.getIntegrationConnection({ projectId, provider });
    if (connection?.projectId !== projectId || connection.provider !== provider) {
      throw new ValidationError('Connect the integration before changing time entries.', {
        provider,
        projectId,
        reason: 'not_connected',
      });
    }
    if (connection.generation !== expectedEpoch) {
      throw new ConflictError('The connection changed; reload and retry with the current epoch.', {
        provider,
        projectId,
        reason: 'connection_epoch_mismatch',
        expectedEpoch,
        currentEpoch: connection.generation,
      });
    }
    return connection;
  }

  /** Second epoch check inside the gate, against the live connection. */
  private async recheckEpoch(
    projectId: string,
    provider: IntegrationProvider,
    expected: IntegrationConnection,
  ): Promise<void> {
    const current = await this.storage.getIntegrationConnection({ projectId, provider });
    if (
      !current ||
      current.projectId !== projectId ||
      current.provider !== provider ||
      current.id !== expected.id ||
      current.generation !== expected.generation
    ) {
      throw new ConflictError('The connection changed; the operation was not dispatched.', {
        provider,
        projectId,
        reason: 'connection_superseded',
      });
    }
  }

  private async loadCredentials(
    projectId: string,
    provider: IntegrationProvider,
  ): Promise<IntegrationCredentials> {
    const credentials = await this.storage.getIntegrationConnectionCredentials({
      projectId,
      provider,
    });
    if (!credentials || credentials.provider !== provider) {
      throw new ValidationError('Connect the integration before changing time entries.', {
        provider,
        projectId,
        reason: 'not_connected',
      });
    }
    return credentials;
  }

  private async loadReceiptCredentials(
    projectId: string,
    provider: IntegrationProvider,
    connection: IntegrationConnection,
  ): Promise<IntegrationCredentials> {
    const credentials = await this.storage.getIntegrationConnectionCredentialsById(connection.id);
    await this.recheckEpoch(projectId, provider, connection);
    if (!credentials || credentials.provider !== provider) {
      throw new ValidationError('Connect the integration before changing time entries.', {
        provider,
        projectId,
        reason: 'not_connected',
      });
    }
    return credentials;
  }

  private assertReceiptConnection(
    receipt: ExternalTimeMutationReceipt,
    connection: IntegrationConnection,
  ): void {
    if (
      receipt.tuple.connectionId !== connection.id ||
      receipt.tuple.connectionGeneration !== connection.generation
    ) {
      throw new ConflictError('The operation belongs to a different connection epoch.', {
        reason: 'connection_superseded',
      });
    }
  }

  private requireCapability(provider: IntegrationProvider): ExternalTimeEntryMutationsCapability {
    const adapter = this.providers.get(provider);
    if (!adapter.timeEntryMutations) {
      throw new ValidationError('The provider does not support time-entry mutations.', {
        provider,
        reason: 'unsupported_capability',
      });
    }
    return adapter.timeEntryMutations;
  }

  private admitFailure(
    operationId: string,
    reason: string,
    phase: string | undefined,
  ): BusyError | ConflictError {
    if (reason === 'operation_id_conflict') {
      return new ConflictError('The operation id was already used for a different operation.', {
        reason: 'operation_id_conflict',
        operationId,
      });
    }
    if (reason === 'receipt_capacity') {
      return new BusyError('Too many time-entry operations are unresolved.', {
        reason: 'receipt_capacity',
      });
    }
    if (reason === 'duplicate_live') {
      return new BusyError('The time-entry operation is still in progress.', {
        reason: 'operation_in_progress',
        operationId,
        phase,
      });
    }
    return new ConflictError('The operation id is terminal; start a new operation.', {
      reason: 'operation_terminal',
      operationId,
      phase,
    });
  }

  private requireView(operationId: string): ExternalTimeOperationReceiptView {
    const receipt = this.store.get(operationId);
    if (!receipt) {
      throw new NotFoundError('Time entry operation', operationId);
    }
    return this.store.view(receipt);
  }

  private assertNoLiveTaskMutation(tuple: ExternalTimeMutationTuple, operationId: string): void {
    const blocking = this.store.findLiveTaskReceipt({
      provider: tuple.provider,
      connectionId: tuple.connectionId,
      connectionGeneration: tuple.connectionGeneration,
      remoteTaskId: tuple.remoteTaskId,
      excludeOperationId: operationId,
    });
    if (blocking) {
      throw new BusyError('The time-entry operation is still in progress.', {
        reason: 'operation_in_progress',
        operationId: blocking.operationId,
        phase: blocking.phase,
      });
    }
  }

  private async assertNoPendingEstimate(
    connection: IntegrationConnection,
    provider: IntegrationProvider,
    requestedScopeKey: string,
    remoteTaskId: string,
  ): Promise<void> {
    const [links, states] = await Promise.all([
      this.storage.listExternalTaskLinksByRemoteTask(provider, remoteTaskId),
      this.storage.listExternalEstimateLogStatesByRemoteTask(provider, remoteTaskId),
    ]);
    const currentLinks = links.filter((link) => link.connectionId === connection.id);
    const requestedLink = currentLinks.find((link) => link.remoteScopeKey === requestedScopeKey);
    let authoritativeScopeKey = requestedScopeKey;
    let linkedIdentity = requestedLink !== undefined;

    if (currentLinks.length > 0 && !requestedLink) {
      // Altered-scope anti-bypass: only a pending state this project owns in
      // a currently linked scope re-anchors the authoritative identity; any
      // other unlinked scope stays a hard mismatch.
      const currentScopes = new Set(currentLinks.map((link) => link.remoteScopeKey));
      const pending = states.find(
        (state) =>
          state.pendingOperationId !== null &&
          state.projectId === connection.projectId &&
          currentScopes.has(state.remoteScopeKey),
      );
      if (pending) {
        authoritativeScopeKey = pending.remoteScopeKey;
        linkedIdentity = true;
      } else {
        throw new ConflictError('The remote scope does not match the current task link.', {
          reason: 'remote_scope_mismatch',
        });
      }
    } else if (currentLinks.length === 0) {
      // No current-connection link anchors the identity, and the provider
      // call still targets the same task under the same credentials, so a
      // changed client scope must not bypass the pending guard. Anchor from
      // durable ownership evidence in priority order: a pending row this
      // project admitted through the current connection (any scope of this
      // task), then a pending row for the exact requested identity, then a
      // pending row whose scope a retained same-project link still
      // snapshots — disconnect preserves that link, so its scope stays
      // authoritative for this project even after reconnect.
      const currentConnectionPending = states.find(
        (state) =>
          state.pendingOperationId !== null &&
          state.projectId === connection.projectId &&
          state.pendingConnectionId === connection.id,
      );
      const retainedProjectScopes = new Set(
        links
          .filter((link) => link.projectId === connection.projectId)
          .map((link) => link.remoteScopeKey),
      );
      const ownedPending =
        currentConnectionPending ??
        states.find(
          (state) =>
            state.pendingOperationId !== null &&
            (state.projectId === connection.projectId ||
              state.projectId === LEGACY_UNASSIGNED_PROJECT_ID) &&
            (state.remoteScopeKey === requestedScopeKey ||
              retainedProjectScopes.has(state.remoteScopeKey)),
        );
      if (ownedPending) {
        authoritativeScopeKey = ownedPending.remoteScopeKey;
        linkedIdentity = true;
      }
    }

    // Pending protection for the authoritative remote identity, by durable
    // ownership: an unassigned pending blocks every project's writes while
    // ownership is unresolved; an owned pending blocks only its owning
    // project — including after disconnect/reconnect, when the pending row
    // keeps a retired connection id. Pending history of other scopes or
    // projects never blocks this write, and settled unassigned history never
    // activates the manual-write guard.
    const authoritativePending = states.find(
      (state) =>
        state.pendingOperationId !== null &&
        state.remoteScopeKey === authoritativeScopeKey &&
        (state.projectId === connection.projectId ||
          state.projectId === LEGACY_UNASSIGNED_PROJECT_ID),
    );
    if (authoritativePending) {
      throw new BusyError('An estimate operation is pending for this task.', {
        reason: 'estimate_operation_pending',
        operationId: authoritativePending.pendingOperationId,
      });
    }
    if (currentLinks.length > 0 && !requestedLink && !linkedIdentity) {
      throw new ConflictError('The remote scope does not match the current task link.', {
        reason: 'remote_scope_mismatch',
      });
    }
  }

  private requireRemoteScopeKey(value: string): string {
    const normalized = value?.trim();
    if (!normalized) {
      throw new ValidationError('Remote scope identifier is required.');
    }
    return normalized;
  }
}
