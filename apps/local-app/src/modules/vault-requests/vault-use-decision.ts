import type { HostVaultUseDecision } from '@devchain/shared';
import { ConflictError, ValidationError } from '../../common/errors/error-types';
import type { VaultUseApprovalStore } from '../vault/vault-use-approvals';
import type { VaultRequest } from './vault-request.store';

/** How long an approved `use` lasts: this session, one delivery, or the agent's family. */
export type VaultUseDecision = HostVaultUseDecision;

/** A `use` request always carries the id of the existing entry it asks about. */
export type VaultUseRequest = VaultRequest & { type: 'use'; entryId: string };

export function isUseRequest(request: VaultRequest): request is VaultUseRequest {
  return request.type === 'use';
}

function wrongAnswer(message: string): ValidationError {
  return new ValidationError(message, { code: 'VAULT_REQUEST_ANSWER_TYPE_MISMATCH' });
}

export function notAUseRequest(): ValidationError {
  return wrongAnswer('Only a use request is approved. Fulfill or deny this request.');
}

export function useRequestNotFulfillable(): ValidationError {
  return wrongAnswer('A use request has no value to fulfill. Approve or deny it.');
}

/**
 * The approve answer's checks. Home runs them before its store claim; a VM runs them
 * again on home's answer, so neither ends a request with a decision it cannot honor.
 */
export function assertUseDecision(
  request: VaultRequest,
  decision: VaultUseDecision,
): asserts request is VaultUseRequest {
  if (!isUseRequest(request)) throw notAUseRequest();
  if (decision === 'family' && request.familySlug === null) {
    throw new ValidationError('The agent has no family, so approve it for this session or once.', {
      code: 'VAULT_REQUEST_FAMILY_NONE',
    });
  }
  if (decision === 'once' && request.kind === 'file') {
    // The delivered file stays on disk until the session ends, so one use cannot be enforced.
    throw new ValidationError('A file entry cannot be approved once. Approve it for the session.', {
      code: 'VAULT_REQUEST_ONCE_FILE',
    });
  }
}

/**
 * Applies an approval. `session` and `once` go to the approvals of the instance that
 * runs the session (409 `VAULT_REQUEST_SESSION_ENDED` when it is not running). `family`
 * runs `familyStep` first — home writes the stored row, a VM checks the row arrived —
 * and then lifts the session's denial, because the gate checks a denial before family
 * approvals.
 */
export async function applyUseDecision(
  approvals: VaultUseApprovalStore,
  request: VaultUseRequest,
  decision: VaultUseDecision,
  familyStep: (request: VaultUseRequest) => Promise<void>,
): Promise<void> {
  if (decision === 'session') return approvals.approveSession(request.sessionId, request.entryId);
  if (decision === 'once') return approvals.approveOnce(request.sessionId, request.entryId);
  await familyStep(request);
  approvals.clearDenial(request.sessionId, request.entryId);
}

/** A denied `use` lasts the session. A stopped session keeps no answers, so it still ends. */
export function recordUseDenial(approvals: VaultUseApprovalStore, request: VaultUseRequest): void {
  try {
    approvals.deny(request.sessionId, request.entryId);
  } catch (error) {
    if (error instanceof ConflictError && error.details?.code === 'VAULT_REQUEST_SESSION_ENDED') {
      return;
    }
    throw error;
  }
}
