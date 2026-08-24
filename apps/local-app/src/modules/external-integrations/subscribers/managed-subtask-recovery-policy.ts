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

export interface ManagedSubtaskRetryDecision {
  allowed: boolean;
  reason: string | null;
}

export function managedSubtaskRetryDecision(
  row: Pick<ExternalManagedSubtaskLink, 'operationPhase' | 'safeErrorCode'>,
): ManagedSubtaskRetryDecision {
  if (row.operationPhase === 'outcome_unknown' || row.operationPhase === 'dispatch_admitted') {
    return { allowed: false, reason: 'verification_required' };
  }
  if (row.safeErrorCode && blockedRetryReasons.has(row.safeErrorCode)) {
    return { allowed: false, reason: row.safeErrorCode };
  }
  if (row.operationPhase !== 'pre_dispatch' && row.operationPhase !== 'needs_attention') {
    return { allowed: false, reason: 'retry_not_available' };
  }
  return { allowed: true, reason: null };
}
