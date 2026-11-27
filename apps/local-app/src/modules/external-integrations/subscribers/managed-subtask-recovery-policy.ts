import type { ExternalManagedSubtaskLink } from '../../storage/models/domain.models';

export const MANAGED_SUBTASK_RETRY_BLOCKED_REASONS = [
  'ownership_marker_missing',
  'ownership_mismatch',
  'parent_mismatch',
  'work_area_mismatch',
  'multiple_owned_children',
  'ownership_scan_incomplete',
  'connection_generation_changed',
  'remote_task_missing',
  'remote_task_missing_after_update',
  'remote_task_missing_after_unknown_update',
] as const;

const blockedRetryReasons = new Set<string>(MANAGED_SUBTASK_RETRY_BLOCKED_REASONS);

/** Whether `code` keeps Retry refused until verification or manual recovery clears it. */
export function isManagedSubtaskRetryBlockedReason(code: string | null): boolean {
  return code !== null && blockedRetryReasons.has(code);
}

/** A phase whose vendor outcome is not known yet: only a verification may settle it. */
export function isOutcomeUnknownPhase(
  phase: ExternalManagedSubtaskLink['operationPhase'],
): boolean {
  return phase === 'outcome_unknown' || phase === 'dispatch_admitted';
}

export interface ManagedSubtaskRetryDecision {
  allowed: boolean;
  reason: string | null;
}

export function managedSubtaskRetryDecision(
  row: Pick<ExternalManagedSubtaskLink, 'operationPhase' | 'safeErrorCode'>,
): ManagedSubtaskRetryDecision {
  if (isOutcomeUnknownPhase(row.operationPhase)) {
    return { allowed: false, reason: 'verification_required' };
  }
  if (isManagedSubtaskRetryBlockedReason(row.safeErrorCode)) {
    return { allowed: false, reason: row.safeErrorCode };
  }
  if (row.operationPhase !== 'pre_dispatch' && row.operationPhase !== 'needs_attention') {
    return { allowed: false, reason: 'retry_not_available' };
  }
  return { allowed: true, reason: null };
}
