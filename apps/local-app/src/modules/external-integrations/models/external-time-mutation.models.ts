import type { IntegrationProvider } from '../../storage/models/domain.models';

/** Receipt lifetime: unknown guarantees end when the receipt expires. */
export const TIME_OPERATION_RECEIPT_TTL_MS = 24 * 60 * 60 * 1_000;
export const TIME_OPERATION_MAX_LIVE_RECEIPTS = 32;
export const TIME_OPERATION_MAX_RECEIPTS = 256;
export const MAX_TIME_OPERATION_ID_LENGTH = 128;
export const TIME_OPERATION_ID_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;

/** Half-width of the create-baseline window around the effective start. */
export const TIME_CREATE_BASELINE_WINDOW_MS = 10 * 60_000;
/** Tolerance when matching a candidate entry's start against the effective
 * start (Jira rounds worklog starts). */
export const TIME_ENTRY_START_TOLERANCE_MS = 90_000;

export type ExternalTimeMutationKind = 'create' | 'delete';

/**
 * Receipt phases. `pending` and `dispatched` exist only while the request is
 * in flight; `outcome_unknown` survives until verification, duplicate-risk
 * acknowledgement, or expiry. Everything else is terminal.
 */
export type ExternalTimeMutationPhase =
  | 'pending'
  | 'dispatched'
  | 'outcome_unknown'
  | 'succeeded'
  | 'failed'
  | 'already_deleted'
  | 'not_applied'
  | 'abandoned_unknown'
  | 'superseded';

export const TERMINAL_TIME_MUTATION_PHASES: ReadonlySet<ExternalTimeMutationPhase> = new Set([
  'succeeded',
  'failed',
  'already_deleted',
  'not_applied',
  'abandoned_unknown',
  'superseded',
]);

/**
 * The exact tuple a receipt binds. A reused operation id with any differing
 * component is a conflict, never a re-dispatch.
 */
export interface ExternalTimeMutationTuple {
  provider: IntegrationProvider;
  connectionId: string;
  connectionGeneration: number;
  remoteTaskId: string;
  remoteEntryId: string | null;
  effectiveStartedAt: string | null;
  durationMs: number | null;
  noteFingerprint: string | null;
}

/** Create baseline: matching remote ids and window completeness at preflight. */
export interface ExternalTimeCreateBaseline {
  matchingIds: string[];
  complete: boolean;
}

export interface ExternalTimeMutationReceipt {
  operationId: string;
  kind: ExternalTimeMutationKind;
  tuple: ExternalTimeMutationTuple;
  phase: ExternalTimeMutationPhase;
  /** Provider proof: the created/deleted remote entry id once known. */
  remoteEntryId: string | null;
  baseline: ExternalTimeCreateBaseline | null;
  createdAt: number;
  updatedAt: number;
}

/** Public (wire) shape of a receipt; the tuple fingerprint stays internal. */
export interface ExternalTimeOperationReceiptView {
  operationId: string;
  kind: ExternalTimeMutationKind;
  provider: IntegrationProvider;
  remoteTaskId: string;
  remoteEntryId: string | null;
  phase: ExternalTimeMutationPhase;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export type ExternalTimeEntryCreateResult =
  | {
      outcome: 'created';
      /** Null when the provider's documented create response confirms the
       * write without naming the created entry. */
      remoteEntryId: string | null;
      /** A time create only changes the task detail; the landing is untouched. */
      refresh: ['task_detail'];
      receipt: ExternalTimeOperationReceiptView;
    }
  | { outcome: 'outcome_unknown'; receipt: ExternalTimeOperationReceiptView };

export type ExternalTimeEntryDeleteResult =
  | { outcome: 'deleted'; receipt: ExternalTimeOperationReceiptView }
  | { outcome: 'already_deleted'; receipt: ExternalTimeOperationReceiptView }
  | { outcome: 'not_applied'; receipt: ExternalTimeOperationReceiptView }
  | { outcome: 'outcome_unknown'; receipt: ExternalTimeOperationReceiptView };

export type ExternalTimeOperationVerifyResolution =
  | 'created'
  | 'deleted'
  | 'already_deleted'
  | 'not_applied'
  | 'completeness_not_provable'
  | 'unresolved'
  | 'connection_superseded'
  | 'verify_failed'
  | 'already_terminal';

export interface ExternalTimeOperationVerifyResult {
  receipt: ExternalTimeOperationReceiptView;
  resolved: boolean;
  resolution: ExternalTimeOperationVerifyResolution;
}
