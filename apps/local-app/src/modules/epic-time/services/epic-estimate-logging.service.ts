import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  BusyError,
  ConflictError,
  NotFoundError,
  OptimisticLockError,
  ValidationError,
} from '../../../common/errors/error-types';
import { ExternalTimeMutationService } from '../../external-integrations/my-work/external-time-mutation.service';
import { MAX_TIME_ENTRY_DURATION_MS } from '../../external-integrations/models/external-provider.models';
import type { ExternalTimeOperationInspection } from '../../external-integrations/models/external-time-mutation.models';
import { timeEntryNoteFingerprint } from '../../external-integrations/sessions/external-time-mutation.store';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type {
  Epic,
  ExternalEstimateLogDailyCheckpoint,
  ExternalEstimateLogIdentity,
  ExternalEstimateLogState,
  ExternalTaskLink,
  IntegrationConnection,
} from '../../storage/models/domain.models';
import {
  EXTERNAL_ESTIMATE_TIME_ENTRY_NOTE,
  type CreateExternalEstimateTimeEntryInput,
  type CreateExternalEstimateTimeEntryResult,
  type EpicTimeDailyTotal,
  type ExternalEstimateLogSnapshot,
  type ExternalEstimateTaskContext,
  type ResolveExternalEstimateOperationInput,
  type ResolveExternalEstimateOperationResult,
  type SetExternalEstimateLoggedMinutesInput,
} from '../models/epic-time.models';
import { allocateDailyEstimateExport } from '../models/epic-time-daily-allocator';
import { isValidActivityDate } from '../models/epic-time-local-day';
import { EpicTimeService } from './epic-time.service';

const MILLIS_PER_MINUTE = 60_000;
/** One request writes at most 10 provider entries; the rest stays for a later click. */
const MAX_ENTRIES_PER_REQUEST = 10;
/** Wire and input bound for daily ledgers: ten years of dates, far inside the Fastify body limit. */
const MAX_DAILY_LEDGER_ENTRIES = 3_660;
const REQUEST_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dailyOperationId(keyHash: string, index: number): string {
  return `daily:${keyHash}:${index}`;
}

interface ResolvedEstimateTaskContext {
  request: ExternalEstimateTaskContext;
  identity: ExternalEstimateLogIdentity;
  link: ExternalTaskLink;
  epic: Epic;
  connection: IntegrationConnection;
}

type EstimateSettlementOutcome = 'logged' | 'not_logged';

interface PendingReconciliation {
  state: ExternalEstimateLogState;
  outcome: EstimateSettlementOutcome | null;
}

interface TerminalReconciliation extends PendingReconciliation {
  outcome: EstimateSettlementOutcome;
}

function settlementOutcomeForPhase(
  phase: ExternalTimeOperationInspection['phase'],
): EstimateSettlementOutcome | null {
  switch (phase) {
    case 'succeeded':
      return 'logged';
    case 'failed':
    case 'not_applied':
      return 'not_logged';
    default:
      return null;
  }
}

function isOperationInProgress(phase: ExternalTimeOperationInspection['phase']): boolean {
  return phase === 'pending' || phase === 'dispatched';
}

@Injectable()
export class EpicEstimateLoggingService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly epicTime: EpicTimeService,
    private readonly timeMutations: ExternalTimeMutationService,
  ) {}

  async getState(input: ExternalEstimateTaskContext): Promise<ExternalEstimateLogSnapshot> {
    const context = await this.resolveContext(input);
    const stored = await this.storage.getExternalEstimateLogState(context.identity);
    const state = stored ? (await this.reconcilePending(context, stored)).state : null;
    return this.snapshot(context, state);
  }

  async setLoggedMinutes(
    input: SetExternalEstimateLoggedMinutesInput,
  ): Promise<ExternalEstimateLogSnapshot> {
    const context = await this.resolveContext(input);
    // Set logged rebuilds the dated baseline from the live projection in the
    // requested zone: the canonical binding and the oldest-first placement
    // of min(logged, current) both ride this one read.
    const projection = this.epicTime.getDailyProjection(context.epic.id, input.timeZone);
    const state = await this.storage.setExternalEstimateLoggedMinutes({
      ...context.identity,
      loggedMinutes: input.loggedMinutes,
      expectedRevision: input.expectedRevision,
      aggregationTimeZone: projection.canonicalTimeZone,
      currentDailyTotals: projection.currentByDate,
    });
    return this.snapshot(context, state);
  }

  async createTimeEntry(
    input: CreateExternalEstimateTimeEntryInput,
  ): Promise<CreateExternalEstimateTimeEntryResult> {
    const context = await this.resolveContext(input);
    const requestKey = this.requireRequestKey(input.requestKey);
    const dailySnapshot = this.requireDailySnapshot(
      input.dailySnapshot,
      input.estimateTotalMinutes,
    );
    this.requireNonnegativeInteger(input.estimateTotalMinutes, 'Estimate total minutes');
    this.requireNonnegativeInteger(input.expectedRevision, 'Expected revision');

    // Deterministic local facts run before the first provider write: the
    // live daily projection and the durable dated ledger decide admission.
    const projection = this.epicTime.getDailyProjection(context.epic.id, input.timeZone);
    const checkpoint = await this.storage.getExternalEstimateLogDailyCheckpoint(context.identity);
    const state = checkpoint?.state ?? null;
    if (state?.pendingOperationId) {
      // Same-key continuation after a settled prefix is unsupported; the
      // client refetches state, resolves the pending item, and clicks fresh.
      throw new BusyError('An estimate operation is pending for this task.', {
        reason: 'estimate_operation_pending',
      });
    }
    if (input.expectedRevision !== (state?.revision ?? 0)) {
      throw new OptimisticLockError('External estimate log state', context.identity.remoteTaskId, {
        expectedRevision: input.expectedRevision,
        actualRevision: state?.revision ?? 0,
      });
    }
    // Best-effort same-key replay detection through the derived
    // process-local receipts; restart or TTL loss stays safe because the
    // durable ledger, not the receipt, is the duplicate guard. Every child
    // this bounded request could derive is checked, so a later child that
    // outlived an expired or evicted earlier one still blocks the key.
    const keyHash = createHash('sha256').update(requestKey).digest('hex');
    for (let index = 0; index < MAX_ENTRIES_PER_REQUEST; index += 1) {
      if (this.timeMutations.inspectOperation(dailyOperationId(keyHash, index))) {
        throw new ConflictError('The request key was already used.', {
          reason: 'request_key_reused',
        });
      }
    }

    // Live growth stays unlogged for a later click, but every captured date
    // must exist in live with at least the captured minutes — the snapshot
    // may never claim time that is not there.
    const liveMinutesByDate = new Map(
      projection.currentByDate.map((day) => [day.activityDate, day.minutes]),
    );
    for (const captured of dailySnapshot) {
      if ((liveMinutesByDate.get(captured.activityDate) ?? 0) < captured.minutes) {
        throw new ValidationError('Estimate snapshot exceeds the current estimate on a date.', {
          reason: 'estimate_snapshot_ahead',
        });
      }
    }

    const allocation = allocateDailyEstimateExport({
      liveByDate: projection.currentByDate,
      capturedByDate: dailySnapshot,
      ledgerByDate:
        checkpoint?.days.map((day) => ({
          activityDate: day.activityDate,
          minutes: day.loggedMinutes,
        })) ?? [],
      unallocatedCreditMinutes: checkpoint?.unallocatedLoggedMinutes ?? 0,
      storedCanonicalTimeZone: state?.aggregationTimeZone ?? null,
      currentCanonicalTimeZone: projection.canonicalTimeZone,
    });
    if (allocation.status === 'zone_rebind_required' || allocation.status === 'real_shrink') {
      // The dated ledger no longer matches reality under any zone: only a
      // Set-logged rebuild can continue, never a smaller dated export.
      throw new ValidationError('The estimate checkpoint requires a Set-logged rebaseline.', {
        reason: 'rebaseline_required',
      });
    }
    if (allocation.status === 'stale_capture') {
      throw new ValidationError('The estimate snapshot is stale; recapture the current estimate.', {
        reason: 'estimate_snapshot_stale',
      });
    }
    if (allocation.entryChunks.length === 0) {
      throw new ValidationError('There is no new estimate time to log.', {
        reason: 'estimate_up_to_date',
      });
    }

    const dispatchChunks = allocation.entryChunks.slice(0, MAX_ENTRIES_PER_REQUEST);
    const hasMore = allocation.entryChunks.length > dispatchChunks.length;
    let entriesLogged = 0;
    let minutesLogged = 0;
    // Exact revision chain: the first prepare is fenced by the admitted
    // revision and every later prepare by the revision the prior confirm
    // actually returned — never an assumed +1.
    let expectedRevision = input.expectedRevision;

    for (const [index, chunk] of dispatchChunks.entries()) {
      const operationId = dailyOperationId(keyHash, index);
      // Day-bounded chunks can never reach the provider duration limit;
      // the check stays as the documented redundant guard.
      if (chunk.durationMs > MAX_TIME_ENTRY_DURATION_MS) {
        throw new ValidationError('Estimate delta exceeds the maximum time-entry duration.', {
          reason: 'duration_limit',
        });
      }
      // Continuity fence: state that moved after admission (or between
      // confirmed entries) stops the loop before the next provider write.
      const current = await this.storage.getExternalEstimateLogState(context.identity);
      if ((current?.revision ?? 0) !== expectedRevision || current?.pendingOperationId) {
        if (entriesLogged > 0) {
          return this.createOutcome(
            'partially_logged',
            entriesLogged,
            minutesLogged,
            true,
            'concurrent_write',
            context,
          );
        }
        if (current?.pendingOperationId) {
          throw new BusyError('An estimate operation is pending for this task.', {
            reason: 'estimate_operation_pending',
          });
        }
        throw new OptimisticLockError(
          'External estimate log state',
          context.identity.remoteTaskId,
          {
            expectedRevision,
            actualRevision: current?.revision ?? 0,
          },
        );
      }
      let prepared: Extract<ExternalEstimateLogState, { pendingOperationId: string }>;
      try {
        prepared = this.requirePendingValue(
          await this.storage.prepareExternalEstimateLogOperation({
            ...context.identity,
            operationId,
            deltaMinutes: chunk.minutes,
            estimateTotalMinutes: input.estimateTotalMinutes,
            startedAt: chunk.startedAt,
            connectionId: context.connection.id,
            connectionGeneration: context.connection.generation,
            expectedRevision,
            activityDate: chunk.activityDate,
            aggregationTimeZone: projection.canonicalTimeZone,
            capturedDailyTotals: dailySnapshot,
          }),
          operationId,
        );
      } catch (error) {
        // A CAS race between the continuity read and this prepare means a
        // competing write landed mid-loop: no provider write happens.
        if (error instanceof OptimisticLockError && entriesLogged > 0) {
          return this.createOutcome(
            'partially_logged',
            entriesLogged,
            minutesLogged,
            true,
            'concurrent_write',
            context,
          );
        }
        throw error;
      }

      let result: Awaited<ReturnType<ExternalTimeMutationService['createEstimateTimeEntry']>>;
      try {
        result = await this.timeMutations.createEstimateTimeEntry(
          input.projectId,
          input.provider,
          input.remoteTaskId,
          {
            durationMs: chunk.durationMs,
            startedAt: chunk.startedAt,
            note: EXTERNAL_ESTIMATE_TIME_ENTRY_NOTE,
          },
          operationId,
          input.expectedEpoch,
        );
      } catch (error) {
        await this.clearKnownFailureFromCurrentCall(context, prepared, operationId);
        if (entriesLogged > 0) {
          // The confirmed prefix stays durable; the fixed safe reason never
          // leaks provider detail.
          return this.createOutcome(
            'partially_logged',
            entriesLogged,
            minutesLogged,
            true,
            'provider_error',
            context,
          );
        }
        throw error;
      }

      const inspection = this.requireMatchingInspection(prepared, operationId);
      if (result.outcome === 'created') {
        if (inspection.phase !== 'succeeded') {
          throw new ConflictError('Provider receipt did not confirm the estimate operation.', {
            reason: 'receipt_phase_mismatch',
          });
        }
        try {
          const confirmed = await this.storage.confirmExternalEstimateLogOperation({
            ...context.identity,
            operationId,
            expectedRevision: prepared.revision,
          });
          // The chain continues from the revision the confirm actually
          // returned, never from an assumed increment.
          expectedRevision = confirmed.revision;
        } catch (error) {
          if (!(error instanceof OptimisticLockError)) throw error;
          // A competing write moved the revision between prepare and
          // confirm: stop after the durable prefix instead of retrying.
          return this.createOutcome(
            'partially_logged',
            entriesLogged,
            minutesLogged,
            true,
            'concurrent_write',
            context,
          );
        }
        entriesLogged += 1;
        minutesLogged += chunk.minutes;
        continue;
      }

      const unknown = await this.markOutcomeUnknown(context, prepared, inspection);
      // An unknown item blocks every later entry; recovery settles exactly
      // this named date and never auto-continues the remainder.
      return this.createOutcome(
        'outcome_unknown',
        entriesLogged,
        minutesLogged,
        true,
        'outcome_unknown',
        context,
        unknown,
      );
    }

    return this.createOutcome(
      'logged',
      entriesLogged,
      minutesLogged,
      hasMore,
      hasMore ? 'entry_cap' : 'completed',
      context,
    );
  }

  private async createOutcome(
    outcome: 'logged' | 'partially_logged' | 'outcome_unknown',
    entriesLogged: number,
    minutesLogged: number,
    hasMore: boolean,
    stoppedReason: CreateExternalEstimateTimeEntryResult['stoppedReason'],
    context: ResolvedEstimateTaskContext,
    state?: ExternalEstimateLogState,
  ): Promise<CreateExternalEstimateTimeEntryResult> {
    const finalState = state ?? (await this.storage.getExternalEstimateLogState(context.identity));
    return {
      outcome,
      entriesLogged,
      minutesLogged,
      hasMore,
      stoppedReason,
      snapshot: await this.snapshot(context, finalState),
    };
  }

  async resolveOperation(
    input: ResolveExternalEstimateOperationInput,
  ): Promise<ResolveExternalEstimateOperationResult> {
    const context = await this.resolveContext(input);
    const state = await this.requirePendingState(context.identity, input.operationId);
    this.assertExpectedRevision(state, input.expectedRevision);

    if (input.action === 'verify') {
      return this.verify(context, state);
    }
    return this.resolveManually(context, state, input.action);
  }

  private async verify(
    context: ResolvedEstimateTaskContext,
    state: Extract<ExternalEstimateLogState, { pendingOperationId: string }>,
  ): Promise<ResolveExternalEstimateOperationResult> {
    if (state.pendingResolution !== null) {
      const resumed = await this.resumeStoredResolution(context, state);
      if (resumed.outcome === null) {
        throw new BusyError('The estimate operation is still in progress.', {
          reason: 'operation_in_progress',
        });
      }
      return {
        outcome: resumed.outcome,
        snapshot: await this.snapshot(context, resumed.state),
      };
    }
    const inspection = this.timeMutations.inspectOperation(state.pendingOperationId);
    if (!inspection) {
      return { outcome: 'unresolved', snapshot: await this.snapshot(context, state) };
    }
    this.assertInspectionMatches(state, inspection);

    const terminalOutcome = settlementOutcomeForPhase(inspection.phase);
    if (terminalOutcome !== null) {
      const reconciled = await this.reconcilePending(context, state);
      return {
        outcome: reconciled.outcome ?? terminalOutcome,
        snapshot: await this.snapshot(context, reconciled.state),
      };
    }
    if (isOperationInProgress(inspection.phase)) {
      throw new BusyError('The estimate operation is still in progress.', {
        reason: 'operation_in_progress',
      });
    }
    if (inspection.phase !== 'outcome_unknown') {
      return { outcome: 'unresolved', snapshot: await this.snapshot(context, state) };
    }
    if (!this.isCurrentPendingEpoch(context, state)) {
      throw new ConflictError(
        'Provider verification is unavailable after connection replacement.',
        {
          reason: 'connection_superseded',
        },
      );
    }

    await this.timeMutations.verifyOperation(
      context.request.projectId,
      context.request.provider,
      state.pendingOperationId,
      context.connection.generation,
    );
    const reconciled = await this.reconcilePending(context, state);
    if (reconciled.state.pendingOperationId === null) {
      const after = this.timeMutations.inspectOperation(state.pendingOperationId);
      return {
        outcome:
          reconciled.outcome ??
          (after ? settlementOutcomeForPhase(after.phase) : null) ??
          'not_logged',
        snapshot: await this.snapshot(context, reconciled.state),
      };
    }
    return { outcome: 'unresolved', snapshot: await this.snapshot(context, reconciled.state) };
  }

  private async resolveManually(
    context: ResolvedEstimateTaskContext,
    state: Extract<ExternalEstimateLogState, { pendingOperationId: string }>,
    resolution: 'logged' | 'not_logged',
  ): Promise<ResolveExternalEstimateOperationResult> {
    const inspection = this.timeMutations.inspectOperation(state.pendingOperationId);
    if (inspection) {
      this.assertInspectionMatches(state, inspection);
      const terminal = await this.settleExactTerminalReceipt(context, state, inspection);
      if (terminal) {
        return {
          outcome: terminal.outcome,
          snapshot: await this.snapshot(context, terminal.state),
        };
      }
      if (isOperationInProgress(inspection.phase)) {
        throw new BusyError('The estimate operation is still in progress.', {
          reason: 'operation_in_progress',
        });
      }
      if (
        inspection.phase !== 'outcome_unknown' &&
        inspection.phase !== 'abandoned_unknown' &&
        this.isCurrentPendingEpoch(context, state)
      ) {
        throw new ConflictError('The estimate operation is not eligible for manual resolution.', {
          reason: 'manual_resolution_unavailable',
        });
      }
    }

    const storedState = await this.storage.storeExternalEstimateLogResolution({
      ...context.identity,
      operationId: state.pendingOperationId,
      resolution,
      expectedRevision: state.revision,
    });
    const stored = this.requirePendingValue(storedState, state.pendingOperationId);
    const applied = await this.resumeStoredResolution(context, stored);
    if (applied.outcome === null) {
      throw new BusyError('The estimate operation is still in progress.', {
        reason: 'operation_in_progress',
      });
    }
    return { outcome: applied.outcome, snapshot: await this.snapshot(context, applied.state) };
  }

  private async reconcilePending(
    context: ResolvedEstimateTaskContext,
    state: ExternalEstimateLogState,
  ): Promise<PendingReconciliation> {
    if (state.pendingOperationId === null) {
      return { state, outcome: null };
    }

    const inspection = this.timeMutations.inspectOperation(state.pendingOperationId);
    if (!inspection) {
      if (state.pendingResolution === null) {
        return { state, outcome: null };
      }
      return this.resumeStoredResolution(context, state);
    }
    this.assertInspectionMatches(state, inspection);
    const terminal = await this.settleExactTerminalReceipt(context, state, inspection);
    if (terminal) {
      return terminal;
    }
    if (inspection.phase === 'outcome_unknown' && state.pendingPhase === 'prepared') {
      const marked = await this.storage.markExternalEstimateLogOperationOutcomeUnknown({
        ...context.identity,
        operationId: state.pendingOperationId,
        expectedRevision: state.revision,
      });
      if (marked.pendingOperationId !== null && marked.pendingResolution !== null) {
        return this.resumeStoredResolution(context, marked);
      }
      return { state: marked, outcome: null };
    }
    if (state.pendingResolution !== null) {
      return this.resumeStoredResolution(context, state);
    }
    return { state, outcome: null };
  }

  private async resumeStoredResolution(
    context: ResolvedEstimateTaskContext,
    state: Extract<ExternalEstimateLogState, { pendingOperationId: string }>,
  ): Promise<PendingReconciliation> {
    const inspection = this.timeMutations.inspectOperation(state.pendingOperationId);
    if (inspection) {
      this.assertInspectionMatches(state, inspection);
      const terminal = await this.settleExactTerminalReceipt(context, state, inspection);
      if (terminal) {
        return terminal;
      }
      if (isOperationInProgress(inspection.phase)) {
        return { state, outcome: null };
      }
      if (inspection.phase === 'outcome_unknown' && this.isCurrentPendingEpoch(context, state)) {
        await this.timeMutations.acknowledgeOperation(
          context.request.projectId,
          context.request.provider,
          state.pendingOperationId,
          context.connection.generation,
        );
        const afterAcknowledgement = this.timeMutations.inspectOperation(state.pendingOperationId);
        if (afterAcknowledgement) {
          this.assertInspectionMatches(state, afterAcknowledgement);
          const terminalAfterAcknowledgement = await this.settleExactTerminalReceipt(
            context,
            state,
            afterAcknowledgement,
          );
          if (terminalAfterAcknowledgement) {
            return terminalAfterAcknowledgement;
          }
          if (isOperationInProgress(afterAcknowledgement.phase)) {
            return { state, outcome: null };
          }
        }
      }
    }
    const applied = await this.storage.applyExternalEstimateLogResolution({
      ...context.identity,
      operationId: state.pendingOperationId,
      expectedRevision: state.revision,
    });
    return { state: applied, outcome: state.pendingResolution };
  }

  private async settleExactTerminalReceipt(
    context: ResolvedEstimateTaskContext,
    state: Extract<ExternalEstimateLogState, { pendingOperationId: string }>,
    inspection: ExternalTimeOperationInspection,
  ): Promise<TerminalReconciliation | null> {
    const outcome = settlementOutcomeForPhase(inspection.phase);
    if (outcome === null) return null;

    let current = state;
    while (true) {
      try {
        let settled: ExternalEstimateLogState;
        if (outcome === 'logged') {
          settled = await this.storage.confirmExternalEstimateLogOperation({
            ...context.identity,
            operationId: state.pendingOperationId,
            expectedRevision: current.revision,
          });
        } else {
          settled = await this.storage.clearExternalEstimateLogOperation({
            ...context.identity,
            operationId: state.pendingOperationId,
            expectedRevision: current.revision,
          });
        }
        return { state: settled, outcome };
      } catch (error) {
        if (!(error instanceof OptimisticLockError)) throw error;
        const refreshed = await this.storage.getExternalEstimateLogState(context.identity);
        if (!refreshed || refreshed.pendingOperationId === null) {
          if (refreshed) return { state: refreshed, outcome };
          throw error;
        }
        if (
          refreshed.pendingOperationId !== state.pendingOperationId ||
          refreshed.revision === current.revision
        ) {
          throw error;
        }
        current = refreshed;
      }
    }
  }

  private async clearKnownFailureFromCurrentCall(
    context: ResolvedEstimateTaskContext,
    prepared: Extract<ExternalEstimateLogState, { pendingOperationId: string }>,
    operationId: string,
  ): Promise<void> {
    const inspection = this.timeMutations.inspectOperation(operationId);
    if (inspection) {
      this.assertInspectionMatches(prepared, inspection);
      if (inspection.phase === 'outcome_unknown') {
        await this.markOutcomeUnknown(context, prepared, inspection);
        return;
      }
      if (inspection.phase !== 'failed' && inspection.phase !== 'not_applied') {
        return;
      }
    }
    await this.storage.clearExternalEstimateLogOperation({
      ...context.identity,
      operationId,
      expectedRevision: prepared.revision,
    });
  }

  private async markOutcomeUnknown(
    context: ResolvedEstimateTaskContext,
    prepared: Extract<ExternalEstimateLogState, { pendingOperationId: string }>,
    inspection: ExternalTimeOperationInspection,
  ): Promise<ExternalEstimateLogState> {
    this.assertInspectionMatches(prepared, inspection);
    if (inspection.phase !== 'outcome_unknown') {
      throw new ConflictError('Provider receipt is not outcome-unknown.', {
        reason: 'receipt_phase_mismatch',
      });
    }
    if (prepared.pendingPhase === 'outcome_unknown') {
      return prepared;
    }
    return this.storage.markExternalEstimateLogOperationOutcomeUnknown({
      ...context.identity,
      operationId: prepared.pendingOperationId,
      expectedRevision: prepared.revision,
    });
  }

  private async snapshot(
    context: ResolvedEstimateTaskContext,
    state: ExternalEstimateLogState | null,
  ): Promise<ExternalEstimateLogSnapshot> {
    if (!state) {
      return {
        state: null,
        initialized: false,
        revision: 0,
        loggedMinutes: 0,
        aggregationTimeZone: null,
        days: [],
        unallocatedLoggedMinutes: 0,
        pendingDisposition: 'none',
        canVerify: false,
        verifyExpiresAt: null,
      };
    }
    // One authoritative revision: the scalar, revision, pending operation,
    // zone, dated rows, and derived credit all come from this single
    // checkpoint read and never mix with the caller's possibly older state.
    // A non-null initial row cannot lose its checkpoint between reads, so a
    // missing checkpoint here is an internal invariant — never a mixed view.
    const checkpoint: ExternalEstimateLogDailyCheckpoint | null =
      await this.storage.getExternalEstimateLogDailyCheckpoint(context.identity);
    if (!checkpoint) {
      throw new NotFoundError('External estimate log state');
    }
    return {
      state: checkpoint.state,
      initialized: true,
      revision: checkpoint.state.revision,
      loggedMinutes: checkpoint.state.loggedMinutes,
      aggregationTimeZone: checkpoint.state.aggregationTimeZone,
      days: checkpoint.days,
      unallocatedLoggedMinutes: checkpoint.unallocatedLoggedMinutes,
      ...this.pendingDispositionFields(context, checkpoint.state),
    };
  }

  private pendingDispositionFields(
    context: ResolvedEstimateTaskContext,
    state: ExternalEstimateLogState,
  ): Pick<ExternalEstimateLogSnapshot, 'pendingDisposition' | 'canVerify' | 'verifyExpiresAt'> {
    if (state.pendingOperationId === null) {
      return {
        pendingDisposition: 'none',
        canVerify: false,
        verifyExpiresAt: null,
      };
    }
    const inspection = this.timeMutations.inspectOperation(state.pendingOperationId);
    if (inspection) {
      this.assertInspectionMatches(state, inspection);
    }
    if (inspection?.phase === 'pending' || inspection?.phase === 'dispatched') {
      return {
        pendingDisposition: 'busy',
        canVerify: false,
        verifyExpiresAt: null,
      };
    }
    if (state.pendingResolution !== null) {
      return {
        pendingDisposition: 'finishing',
        canVerify: false,
        verifyExpiresAt: null,
      };
    }
    const currentEpoch = this.isCurrentPendingEpoch(context, state);
    const disposition =
      inspection?.phase === 'outcome_unknown' && currentEpoch ? 'outcome_unknown' : 'manual_review';
    return {
      pendingDisposition: disposition,
      canVerify: inspection?.canVerify === true && currentEpoch,
      verifyExpiresAt: inspection?.canVerify === true && currentEpoch ? inspection.expiresAt : null,
    };
  }

  private requireMatchingInspection(
    state: Extract<ExternalEstimateLogState, { pendingOperationId: string }>,
    operationId: string,
  ): ExternalTimeOperationInspection {
    const inspection = this.timeMutations.inspectOperation(operationId);
    if (!inspection) {
      throw new ConflictError('Provider receipt is unavailable.', {
        reason: 'receipt_missing',
      });
    }
    this.assertInspectionMatches(state, inspection);
    return inspection;
  }

  private assertInspectionMatches(
    state: Extract<ExternalEstimateLogState, { pendingOperationId: string }>,
    inspection: ExternalTimeOperationInspection,
  ): void {
    const tuple = inspection.tuple;
    if (
      inspection.operationId !== state.pendingOperationId ||
      inspection.kind !== 'create' ||
      tuple.provider !== state.provider ||
      tuple.remoteTaskId !== state.remoteTaskId ||
      tuple.connectionId !== state.pendingConnectionId ||
      tuple.connectionGeneration !== state.pendingConnectionGeneration ||
      tuple.effectiveStartedAt !== state.pendingStartedAt ||
      tuple.durationMs !== state.pendingDeltaMinutes * MILLIS_PER_MINUTE ||
      tuple.noteFingerprint !== timeEntryNoteFingerprint(EXTERNAL_ESTIMATE_TIME_ENTRY_NOTE)
    ) {
      throw new ConflictError('Provider receipt does not match the pending estimate operation.', {
        reason: 'receipt_tuple_mismatch',
      });
    }
  }

  private async requirePendingState(
    identity: ExternalEstimateLogIdentity,
    operationId: string,
  ): Promise<Extract<ExternalEstimateLogState, { pendingOperationId: string }>> {
    const state = await this.storage.getExternalEstimateLogState(identity);
    if (!state || state.pendingOperationId === null) {
      throw new NotFoundError('Pending estimate operation');
    }
    if (state.pendingOperationId !== operationId) {
      throw new ConflictError('A different estimate operation is pending.', {
        reason: 'estimate_operation_mismatch',
      });
    }
    return state;
  }

  private requirePendingValue(
    state: ExternalEstimateLogState,
    operationId: string,
  ): Extract<ExternalEstimateLogState, { pendingOperationId: string }> {
    if (state.pendingOperationId !== operationId) {
      throw new ConflictError('Estimate operation state changed unexpectedly.', {
        reason: 'estimate_operation_mismatch',
      });
    }
    return state;
  }

  private async resolveContext(
    input: ExternalEstimateTaskContext,
  ): Promise<ResolvedEstimateTaskContext> {
    const request = this.normalizeContext(input);
    const identity = {
      provider: request.provider,
      remoteScopeKey: request.remoteScopeKey,
      remoteTaskId: request.remoteTaskId,
    };
    const [link, connection] = await Promise.all([
      this.storage.findExternalTaskLink(
        identity.provider,
        identity.remoteScopeKey,
        identity.remoteTaskId,
      ),
      this.storage.getIntegrationConnection({
        projectId: request.projectId,
        provider: request.provider,
      }),
    ]);
    if (!link) {
      throw new NotFoundError('External task link');
    }
    if (connection?.projectId !== request.projectId || connection.provider !== request.provider) {
      throw new ValidationError('Connect the integration before changing estimate time.', {
        reason: 'not_connected',
      });
    }
    if (connection.generation !== request.expectedEpoch) {
      throw new ConflictError('The connection changed; reload with the current epoch.', {
        reason: 'connection_epoch_mismatch',
      });
    }
    if (link.connectionId !== connection.id) {
      throw new ConflictError('The external task link does not belong to the current connection.', {
        reason: 'link_connection_mismatch',
      });
    }
    const epic = await this.storage.getEpic(link.epicId);
    if (epic.projectId !== request.projectId) {
      throw new NotFoundError('External task link');
    }
    return { request, identity, link, epic, connection };
  }

  private normalizeContext(input: ExternalEstimateTaskContext): ExternalEstimateTaskContext {
    const projectId = this.requireIdentifier(input.projectId, 'Project');
    const remoteScopeKey = this.requireIdentifier(input.remoteScopeKey, 'Remote scope');
    const remoteTaskId = this.requireIdentifier(input.remoteTaskId, 'Remote task');
    if (input.provider !== 'clickup' && input.provider !== 'jira') {
      throw new ValidationError('Integration provider is invalid.');
    }
    if (!Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 1) {
      throw new ValidationError('Connection epoch must be a positive whole number.');
    }
    return {
      projectId,
      provider: input.provider,
      remoteScopeKey,
      remoteTaskId,
      expectedEpoch: input.expectedEpoch,
    };
  }

  private isCurrentPendingEpoch(
    context: ResolvedEstimateTaskContext,
    state: Extract<ExternalEstimateLogState, { pendingOperationId: string }>,
  ): boolean {
    return (
      context.connection.id === state.pendingConnectionId &&
      context.connection.generation === state.pendingConnectionGeneration
    );
  }

  private assertExpectedRevision(state: ExternalEstimateLogState, expectedRevision: number): void {
    this.requireNonnegativeInteger(expectedRevision, 'Expected revision');
    if (state.revision !== expectedRevision) {
      throw this.optimisticLock(state, expectedRevision);
    }
  }

  private optimisticLock(
    state: ExternalEstimateLogState,
    expectedRevision: number,
  ): OptimisticLockError {
    return new OptimisticLockError('External estimate log state', state.remoteTaskId, {
      expectedRevision,
      actualRevision: state.revision,
    });
  }

  private requireRequestKey(value: string): string {
    const normalized = value?.trim();
    if (!normalized || !REQUEST_KEY_PATTERN.test(normalized)) {
      throw new ValidationError('Estimate request key must be a fresh UUID.');
    }
    return normalized.toLowerCase();
  }

  /**
   * Canonical daily snapshot admission: unique calendar dates in strict
   * ascending order, whole nonnegative minutes, bounded at 3,660 entries,
   * summing exactly to the captured estimate total. Everything here is
   * deterministic local validation that runs before the first provider write.
   */
  private requireDailySnapshot(
    entries: ReadonlyArray<EpicTimeDailyTotal>,
    estimateTotalMinutes: number,
  ): EpicTimeDailyTotal[] {
    if (!Array.isArray(entries) || entries.length > MAX_DAILY_LEDGER_ENTRIES) {
      throw new ValidationError(
        `The daily snapshot may carry at most ${MAX_DAILY_LEDGER_ENTRIES} activity dates.`,
      );
    }
    let previousDate: string | null = null;
    let total = 0;
    for (const entry of entries) {
      if (!isValidActivityDate(entry?.activityDate ?? '')) {
        throw new ValidationError('The daily snapshot contains an invalid activity date.');
      }
      if (!Number.isSafeInteger(entry?.minutes) || entry.minutes < 0) {
        throw new ValidationError('Daily snapshot minutes must be nonnegative whole numbers.');
      }
      if (previousDate !== null && entry.activityDate.localeCompare(previousDate) <= 0) {
        throw new ValidationError('Daily snapshot dates must be unique and ascending.');
      }
      previousDate = entry.activityDate;
      total += entry.minutes;
    }
    if (total !== estimateTotalMinutes) {
      throw new ValidationError('The daily snapshot must sum to the estimate total.', {
        reason: 'snapshot_sum_mismatch',
      });
    }
    return [...entries];
  }

  private requireIdentifier(value: string, label: string): string {
    const normalized = value?.trim();
    if (!normalized) {
      throw new ValidationError(`${label} identifier is required.`);
    }
    return normalized;
  }

  private requireNonnegativeInteger(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError(`${label} must be a nonnegative whole number.`);
    }
  }
}
