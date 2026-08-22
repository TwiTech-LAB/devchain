import { Inject, Injectable } from '@nestjs/common';
import {
  BusyError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors/error-types';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
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
  type ExternalTimeEntryCreateResult,
  type ExternalTimeMutationReceipt,
  type ExternalTimeEntryDeleteResult,
  type ExternalTimeMutationTuple,
  type ExternalTimeOperationReceiptView,
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

  async createTimeEntry(
    provider: IntegrationProvider,
    remoteTaskId: string,
    input: ExternalTaskTimeEntryInput,
    operationId: string,
    expectedEpoch: number,
  ): Promise<ExternalTimeEntryCreateResult> {
    const connection = await this.precheckEpoch(provider, expectedEpoch);
    const capability = this.requireCapability(provider);
    const credentials = await this.loadCredentials(provider);
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

    return this.gate.run(provider, async () => {
      await this.recheckEpoch(provider, connection);

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
    provider: IntegrationProvider,
    remoteTaskId: string,
    remoteEntryId: string,
    operationId: string,
    expectedEpoch: number,
  ): Promise<ExternalTimeEntryDeleteResult> {
    const connection = await this.precheckEpoch(provider, expectedEpoch);
    const capability = this.requireCapability(provider);
    const credentials = await this.loadCredentials(provider);
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

    return this.gate.run(provider, async () => {
      await this.recheckEpoch(provider, connection);

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

  async getOperation(
    provider: IntegrationProvider,
    operationId: string,
    expectedEpoch: number,
  ): Promise<ExternalTimeOperationReceiptView> {
    await this.precheckEpoch(provider, expectedEpoch);
    const receipt = this.store.get(operationId);
    if (!receipt || receipt.tuple.provider !== provider) {
      throw new NotFoundError('Time entry operation', operationId);
    }
    return this.store.view(receipt);
  }

  /**
   * Resolves an unknown receipt from exact provider proof only: a create
   * needs complete before/after id sets and exactly one new matching entry;
   * a delete needs the exact-resource GET (404 proves deletion, presence
   * proves it never landed). Collection absence never resolves anything.
   */
  async verifyOperation(
    provider: IntegrationProvider,
    operationId: string,
    expectedEpoch: number,
  ): Promise<ExternalTimeOperationVerifyResult> {
    const connection = await this.precheckEpoch(provider, expectedEpoch);
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
    const capability = this.requireCapability(provider);
    const credentials = await this.loadCredentials(provider);
    const context = {
      connectionId: receipt.tuple.connectionId,
      connectionGeneration: receipt.tuple.connectionGeneration,
    };

    if (receipt.kind === 'delete') {
      const entryId = receipt.tuple.remoteEntryId!;
      try {
        const exact = await capability.readTimeEntryExact(
          credentials,
          context,
          receipt.tuple.remoteTaskId,
          entryId,
        );
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
      } catch {
        return {
          receipt: this.requireView(operationId),
          resolved: false,
          resolution: 'verify_failed',
        };
      }
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
    provider: IntegrationProvider,
    operationId: string,
    expectedEpoch: number,
  ): Promise<ExternalTimeOperationReceiptView> {
    await this.precheckEpoch(provider, expectedEpoch);
    const existing = this.store.get(operationId);
    if (!existing || existing.tuple.provider !== provider) {
      throw new NotFoundError('Time entry operation', operationId);
    }
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

  /** Validates the caller's expected epoch before any credentials load. */
  private async precheckEpoch(
    provider: IntegrationProvider,
    expectedEpoch: number,
  ): Promise<IntegrationConnection> {
    const connection = await this.storage.getIntegrationConnection(provider);
    if (!connection || connection.provider !== provider) {
      throw new ValidationError('Connect the integration before changing time entries.', {
        provider,
        reason: 'not_connected',
      });
    }
    if (connection.generation !== expectedEpoch) {
      throw new ConflictError('The connection changed; reload and retry with the current epoch.', {
        provider,
        reason: 'connection_epoch_mismatch',
        expectedEpoch,
        currentEpoch: connection.generation,
      });
    }
    return connection;
  }

  /** Second epoch check inside the gate, against the live connection. */
  private async recheckEpoch(
    provider: IntegrationProvider,
    expected: IntegrationConnection,
  ): Promise<void> {
    const current = await this.storage.getIntegrationConnection(provider);
    if (
      !current ||
      current.provider !== provider ||
      current.id !== expected.id ||
      current.generation !== expected.generation
    ) {
      throw new ConflictError('The connection changed; the operation was not dispatched.', {
        provider,
        reason: 'connection_superseded',
      });
    }
  }

  private async loadCredentials(provider: IntegrationProvider): Promise<IntegrationCredentials> {
    const credentials = await this.storage.getIntegrationConnectionCredentials(provider);
    if (!credentials || credentials.provider !== provider) {
      throw new ValidationError('Connect the integration before changing time entries.', {
        provider,
        reason: 'not_connected',
      });
    }
    return credentials;
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
}
