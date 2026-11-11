import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, ForbiddenError } from '../../common/errors/error-types';
import { STORAGE_SERVICE, type VaultEntryStorage } from '../storage/interfaces/storage.interface';
import type { Agent, VaultResolvedEntry } from '../storage/models/domain.models';
import { VaultRequestStore } from '../vault-requests/vault-request.store';
import {
  useStanding,
  VaultUseApprovalStore,
  type VaultUseReservation,
} from './vault-use-approvals';

type GateStorage = Pick<VaultEntryStorage, 'listVaultUseFamilyApprovals'>;

export interface VaultUseGateInput {
  readonly sessionId: string;
  readonly agent: Agent;
  /** The agent profile's normalized family; null never matches a family approval. */
  readonly familySlug: string | null;
  /** Every stored entry granted to the session. */
  readonly granted: readonly VaultResolvedEntry[];
  /** The granted stored entries the call wants. */
  readonly wanted: readonly VaultResolvedEntry[];
  /** True when the caller named the entries (`--only`): only then the gate asks the user. */
  readonly explicit: boolean;
}

export interface VaultUseGateDecision {
  /** Wanted entries the session may receive now. */
  readonly allowed: readonly VaultResolvedEntry[];
  /** Names left out because they wait for the user's approval (calls without names only). */
  readonly needsApproval: readonly string[];
  /** Gated entries whose files must not stay on disk: denied or without a standing approval. */
  readonly withheldFileNames: ReadonlySet<string>;
  /** One-shot tokens `allowed` uses: commit after delivery, release on any failure. */
  readonly reservation: VaultUseReservation;
}

/**
 * Decides which gated entries a resolve may hand out. Per entry, in order: a session
 * denial refuses; a family approval, a session approval or a one-shot token admits.
 * Entries without `approvalRequired` always pass.
 */
@Injectable()
export class VaultUseGate {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: GateStorage,
    private readonly approvals: VaultUseApprovalStore,
    private readonly store: VaultRequestStore,
  ) {}

  /**
   * Explicit calls throw 403 `VAULT_USE_DENIED` for a denied name, else 409
   * `VAULT_USE_APPROVAL_PENDING` after asking the user once per name; both carry the
   * names in `details.names`. Holds no token when it throws.
   */
  async decide(input: VaultUseGateInput): Promise<VaultUseGateDecision> {
    const { sessionId, agent, familySlug } = input;
    // The family rows matter only when a granted entry is gated: the resolve hot path
    // of an ungated project pays no query.
    const familyApproved =
      familySlug && input.granted.some((entry) => entry.approvalRequired)
        ? new Set(
            (await this.storage.listVaultUseFamilyApprovals({ projectId: agent.projectId }))
              .filter((row) => row.familySlug === familySlug)
              .map((row) => row.entryId),
          )
        : new Set<string>();

    // From here to the reservation there is no await, so no other resolve sees the same tokens.
    const standing = (entry: VaultResolvedEntry) =>
      useStanding(this.approvals, sessionId, entry, familyApproved.has(entry.id));
    const denied = input.wanted.filter((entry) => standing(entry) === 'denied');
    const unapproved = input.wanted.filter((entry) => standing(entry) === 'none');
    const reservation = this.approvals.reserveOnce(
      sessionId,
      unapproved.map((entry) => entry.id),
    );
    const pending = unapproved.filter((entry) => !reservation.entryIds.has(entry.id));

    if (input.explicit && (denied.length > 0 || pending.length > 0)) {
      reservation.release();
      if (denied.length > 0) {
        throw new ForbiddenError('The user denied this session the use of a requested entry.', {
          code: 'VAULT_USE_DENIED',
          names: denied.map((entry) => entry.name),
        });
      }
      for (const entry of pending) {
        await this.store.add({
          projectId: agent.projectId,
          sessionId,
          agentId: agent.id,
          agentName: agent.name,
          familySlug,
          entryId: entry.id,
          name: entry.name,
          kind: entry.kind,
          type: 'use',
          description: '',
        });
      }
      throw new ConflictError('The user must approve the use of a requested entry.', {
        code: 'VAULT_USE_APPROVAL_PENDING',
        names: pending.map((entry) => entry.name),
      });
    }

    const admitted = (entry: VaultResolvedEntry) =>
      standing(entry) === 'approved' || reservation.entryIds.has(entry.id);
    return {
      allowed: input.wanted.filter(admitted),
      needsApproval: pending.map((entry) => entry.name),
      withheldFileNames: new Set(
        input.granted
          .filter((entry) => entry.kind === 'file' && !admitted(entry))
          .map((entry) => entry.name),
      ),
      reservation,
    };
  }
}
