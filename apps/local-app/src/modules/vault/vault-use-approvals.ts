import { Injectable } from '@nestjs/common';
import type { EventPayload } from '../events/catalog';
import { OnCatalogEvent } from '../events/catalog/on-catalog-event';
import type { VaultEntryStorage } from '../storage/interfaces/storage.interface';
import { SessionRowStore } from '../storage/sessions/session-row.store';
import { vaultRequestSessionEnded } from '../vault-requests/vault-request-session-value';

export type VaultUseStanding = 'approved' | 'denied' | 'none';

/**
 * The one order of the use-approval rule, per entry: no flag passes; a session denial
 * refuses over every approval; a family or session approval admits. The gate and
 * `devchain_vault_request` both decide with it, so they cannot disagree.
 */
export function useStanding(
  approvals: VaultUseApprovalStore,
  sessionId: string,
  entry: { id: string; approvalRequired: boolean },
  familyApproved: boolean,
): VaultUseStanding {
  if (!entry.approvalRequired) return 'approved';
  if (approvals.isDenied(sessionId, entry.id)) return 'denied';
  if (familyApproved) return 'approved';
  if (approvals.hasSessionApproval(sessionId, entry.id)) return 'approved';
  return 'none';
}

/** Whether a stored family approval covers the entry for this family in this project. */
export async function hasVaultFamilyApproval(
  storage: Pick<VaultEntryStorage, 'listVaultUseFamilyApprovals'>,
  entryId: string,
  projectId: string,
  familySlug: string,
): Promise<boolean> {
  const rows = await storage.listVaultUseFamilyApprovals({ entryId, projectId });
  return rows.some((row) => row.familySlug === familySlug);
}

/** Tokens a resolve took; give them back on failure, spend them after delivery. */
export interface VaultUseReservation {
  /** Entry ids that got a token. */
  readonly entryIds: ReadonlySet<string>;
  /** Spends the tokens. Later calls of either method do nothing. */
  commit(): void;
  /** Gives the tokens back. Later calls of either method do nothing. */
  release(): void;
}

interface SessionState {
  readonly approved: Set<string>;
  readonly denied: Set<string>;
  /** Unreserved one-shot tokens by entry id. */
  readonly tokens: Map<string, number>;
}

/**
 * The user's answers to use asks for one running session, in memory only, on the
 * instance that runs the session: a session approval, one-shot tokens and a denial,
 * each per entry. Gone when the session stops or crashes or DevChain restarts.
 * Family approvals are stored rows, not kept here.
 */
@Injectable()
export class VaultUseApprovalStore {
  private readonly bySession = new Map<string, SessionState>();

  constructor(private readonly sessionRows: SessionRowStore) {}

  /** The session may use the entry until it ends. Lifts a denial of the entry. */
  approveSession(sessionId: string, entryId: string): void {
    const state = this.writable(sessionId);
    state.denied.delete(entryId);
    state.approved.add(entryId);
  }

  /** One more delivery of the entry to the session. Lifts a denial of the entry. */
  approveOnce(sessionId: string, entryId: string): void {
    const state = this.writable(sessionId);
    state.denied.delete(entryId);
    state.tokens.set(entryId, (state.tokens.get(entryId) ?? 0) + 1);
  }

  /** Refuses the entry to the session until it ends, over every approval kind. */
  deny(sessionId: string, entryId: string): void {
    this.writable(sessionId).denied.add(entryId);
  }

  /** Lifts a denial without approving; a later use asks again. */
  clearDenial(sessionId: string, entryId: string): void {
    this.bySession.get(sessionId)?.denied.delete(entryId);
  }

  isDenied(sessionId: string, entryId: string): boolean {
    return this.bySession.get(sessionId)?.denied.has(entryId) ?? false;
  }

  hasSessionApproval(sessionId: string, entryId: string): boolean {
    return this.bySession.get(sessionId)?.approved.has(entryId) ?? false;
  }

  /**
   * Takes one token for each of `entryIds` that has one. Synchronous, so two
   * overlapping resolves never get the same token.
   */
  reserveOnce(sessionId: string, entryIds: readonly string[]): VaultUseReservation {
    const tokens = this.bySession.get(sessionId)?.tokens;
    const taken = new Set<string>();
    for (const entryId of entryIds) {
      const available = tokens?.get(entryId) ?? 0;
      if (available === 0 || taken.has(entryId)) continue;
      if (available === 1) tokens!.delete(entryId);
      else tokens!.set(entryId, available - 1);
      taken.add(entryId);
    }
    let settled = taken.size === 0;
    return {
      entryIds: taken,
      commit: () => {
        settled = true;
      },
      release: () => {
        if (settled) return;
        settled = true;
        // A session that ended meanwhile keeps nothing.
        const state = this.bySession.get(sessionId);
        if (!state) return;
        for (const entryId of taken) {
          state.tokens.set(entryId, (state.tokens.get(entryId) ?? 0) + 1);
        }
      },
    };
  }

  @OnCatalogEvent('session.stopped')
  onSessionStopped(payload: EventPayload<'session.stopped'>): void {
    this.bySession.delete(payload.sessionId);
  }

  @OnCatalogEvent('session.crashed')
  onSessionCrashed(payload: EventPayload<'session.crashed'>): void {
    this.bySession.delete(payload.sessionId);
  }

  /** 409 `VAULT_REQUEST_SESSION_ENDED` when the session is not running: nothing is stored. */
  private writable(sessionId: string): SessionState {
    if (this.sessionRows.getSession(sessionId)?.status !== 'running') {
      throw vaultRequestSessionEnded();
    }
    let state = this.bySession.get(sessionId);
    if (!state) {
      state = { approved: new Set(), denied: new Set(), tokens: new Map() };
      this.bySession.set(sessionId, state);
    }
    return state;
  }
}
