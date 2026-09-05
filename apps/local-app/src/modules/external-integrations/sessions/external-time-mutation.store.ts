import { createHash } from 'node:crypto';
import {
  TERMINAL_TIME_MUTATION_PHASES,
  TIME_OPERATION_MAX_LIVE_RECEIPTS,
  TIME_OPERATION_MAX_RECEIPTS,
  TIME_OPERATION_RECEIPT_TTL_MS,
  timeOperationCanVerify,
  type ExternalTimeCreateBaseline,
  type ExternalTimeMutationKind,
  type ExternalTimeMutationPhase,
  type ExternalTimeMutationReceipt,
  type ExternalTimeMutationTuple,
  type ExternalTimeUpdateBaseline,
  type ExternalTimeOperationReceiptView,
} from '../models/external-time-mutation.models';

export type TimeMutationStoreFailure =
  | 'operation_id_conflict'
  | 'duplicate_live'
  | 'duplicate_terminal'
  | 'receipt_capacity';

export type TimeMutationAdmitResult =
  | { ok: true; receipt: ExternalTimeMutationReceipt }
  | { ok: false; reason: TimeMutationStoreFailure; receipt?: ExternalTimeMutationReceipt };

export type TimeMutationAckResult =
  | { ok: true; receipt: ExternalTimeMutationReceipt }
  | { ok: false; reason: 'not_found' | 'not_unknown' };

export type LiveTaskReceiptIdentity = Pick<
  ExternalTimeMutationTuple,
  'provider' | 'connectionId' | 'connectionGeneration' | 'remoteTaskId'
> & {
  excludeOperationId?: string;
};

/** Stable content fingerprint of a time-entry create payload. */
export function timeEntryNoteFingerprint(note: string | null): string {
  return createHash('sha256')
    .update(note ?? '')
    .digest('hex');
}

/**
 * Bounded in-memory receipt store for time-entry mutations. Live receipts
 * (pending/dispatched/outcome_unknown) are never evicted by capacity — only
 * terminal receipts recycle, and every receipt expires after the absolute
 * TTL, which is the documented end of any unknown guarantee. Receipts are
 * process-local by design: loss on restart never triggers an automatic
 * re-dispatch.
 */
export class ExternalTimeMutationStore {
  private readonly receipts = new Map<string, ExternalTimeMutationReceipt>();

  constructor(
    private readonly maxLive = TIME_OPERATION_MAX_LIVE_RECEIPTS,
    private readonly maxReceipts = TIME_OPERATION_MAX_RECEIPTS,
    private readonly ttlMs = TIME_OPERATION_RECEIPT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  admit(input: {
    operationId: string;
    kind: ExternalTimeMutationKind;
    tuple: ExternalTimeMutationTuple;
    baseline: ExternalTimeCreateBaseline | null;
    updateBaseline?: ExternalTimeUpdateBaseline | null;
  }): TimeMutationAdmitResult {
    const existing = this.get(input.operationId);
    if (existing) {
      if (!this.sameTuple(existing.tuple, input.tuple)) {
        return { ok: false, reason: 'operation_id_conflict', receipt: existing };
      }
      return {
        ok: false,
        reason: TERMINAL_TIME_MUTATION_PHASES.has(existing.phase)
          ? 'duplicate_terminal'
          : 'duplicate_live',
        receipt: existing,
      };
    }
    if (this.liveCount() >= this.maxLive) {
      return { ok: false, reason: 'receipt_capacity' };
    }
    if (!this.ensureCapacity()) {
      return { ok: false, reason: 'receipt_capacity' };
    }
    const timestamp = this.now();
    const receipt: ExternalTimeMutationReceipt = {
      operationId: input.operationId,
      kind: input.kind,
      tuple: input.tuple,
      phase: 'pending',
      remoteEntryId: null,
      baseline: input.baseline,
      updateBaseline: input.updateBaseline ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.receipts.set(input.operationId, receipt);
    return { ok: true, receipt };
  }

  get(operationId: string): ExternalTimeMutationReceipt | null {
    const receipt = this.receipts.get(operationId);
    if (!receipt) {
      return null;
    }
    if (this.now() - receipt.createdAt > this.ttlMs) {
      this.receipts.delete(operationId);
      return null;
    }
    return receipt;
  }

  findLiveTaskReceipt(identity: LiveTaskReceiptIdentity): ExternalTimeMutationReceipt | null {
    for (const operationId of this.receipts.keys()) {
      if (operationId === identity.excludeOperationId) {
        continue;
      }
      const receipt = this.get(operationId);
      if (
        receipt &&
        !TERMINAL_TIME_MUTATION_PHASES.has(receipt.phase) &&
        receipt.tuple.provider === identity.provider &&
        receipt.tuple.connectionId === identity.connectionId &&
        receipt.tuple.connectionGeneration === identity.connectionGeneration &&
        receipt.tuple.remoteTaskId === identity.remoteTaskId
      ) {
        return receipt;
      }
    }
    return null;
  }

  markDispatched(operationId: string): ExternalTimeMutationReceipt | null {
    return this.transition(operationId, 'dispatched');
  }

  markUnknown(operationId: string): ExternalTimeMutationReceipt | null {
    return this.transition(operationId, 'outcome_unknown');
  }

  /** `undefined` leaves the recorded id unchanged; `null` records a
   * confirmed create whose provider response named no entry id. */
  markTerminal(
    operationId: string,
    phase: Extract<
      ExternalTimeMutationPhase,
      | 'succeeded'
      | 'failed'
      | 'already_deleted'
      | 'not_applied'
      | 'abandoned_unknown'
      | 'superseded'
    >,
    remoteEntryId?: string | null,
  ): ExternalTimeMutationReceipt | null {
    const receipt = this.get(operationId);
    if (!receipt) {
      return null;
    }
    receipt.phase = phase;
    receipt.updatedAt = this.now();
    if (remoteEntryId !== undefined) {
      receipt.remoteEntryId = remoteEntryId;
    }
    return receipt;
  }

  /** Duplicate-risk acknowledgement: unknown → terminal abandoned_unknown. */
  acknowledgeUnknown(operationId: string): TimeMutationAckResult {
    const receipt = this.get(operationId);
    if (!receipt) {
      return { ok: false, reason: 'not_found' };
    }
    if (receipt.phase !== 'outcome_unknown') {
      return { ok: false, reason: 'not_unknown' };
    }
    receipt.phase = 'abandoned_unknown';
    receipt.updatedAt = this.now();
    return { ok: true, receipt };
  }

  view(receipt: ExternalTimeMutationReceipt): ExternalTimeOperationReceiptView {
    return {
      operationId: receipt.operationId,
      kind: receipt.kind,
      provider: receipt.tuple.provider,
      remoteTaskId: receipt.tuple.remoteTaskId,
      remoteEntryId: receipt.remoteEntryId,
      phase: receipt.phase,
      canVerify: timeOperationCanVerify(receipt),
      createdAt: new Date(receipt.createdAt).toISOString(),
      updatedAt: new Date(receipt.updatedAt).toISOString(),
      expiresAt: new Date(receipt.createdAt + this.ttlMs).toISOString(),
    };
  }

  size(): number {
    return this.receipts.size;
  }

  private liveCount(): number {
    let live = 0;
    for (const receipt of this.receipts.values()) {
      if (!TERMINAL_TIME_MUTATION_PHASES.has(receipt.phase)) {
        live += 1;
      }
    }
    return live;
  }

  private transition(
    operationId: string,
    phase: ExternalTimeMutationPhase,
  ): ExternalTimeMutationReceipt | null {
    const receipt = this.get(operationId);
    if (!receipt) {
      return null;
    }
    receipt.phase = phase;
    receipt.updatedAt = this.now();
    return receipt;
  }

  /**
   * Recycles expired receipts, then oldest terminal receipts. Returns false
   * when the store is full of live receipts — callers must fail busy rather
   * than evict a guarantee.
   */
  private ensureCapacity(): boolean {
    if (this.receipts.size < this.maxReceipts) {
      return true;
    }
    for (const [operationId, receipt] of this.receipts) {
      if (this.now() - receipt.createdAt > this.ttlMs) {
        this.receipts.delete(operationId);
      }
    }
    while (this.receipts.size >= this.maxReceipts) {
      const evictable = this.oldestTerminal();
      if (!evictable) {
        return false;
      }
      this.receipts.delete(evictable);
    }
    return true;
  }

  private oldestTerminal(): string | null {
    for (const [operationId, receipt] of this.receipts) {
      if (TERMINAL_TIME_MUTATION_PHASES.has(receipt.phase)) {
        return operationId;
      }
    }
    return null;
  }

  private sameTuple(left: ExternalTimeMutationTuple, right: ExternalTimeMutationTuple): boolean {
    return (
      left.provider === right.provider &&
      left.connectionId === right.connectionId &&
      left.connectionGeneration === right.connectionGeneration &&
      left.remoteTaskId === right.remoteTaskId &&
      left.remoteEntryId === right.remoteEntryId &&
      left.effectiveStartedAt === right.effectiveStartedAt &&
      left.durationMs === right.durationMs &&
      left.noteFingerprint === right.noteFingerprint
    );
  }
}
