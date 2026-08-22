import { randomUUID } from 'node:crypto';
import {
  EDIT_SESSION_ABSOLUTE_LIMIT_MS,
  EDIT_SESSION_IDLE_LIMIT_MS,
  EDIT_SESSION_MAX_BASELINE_BYTES,
  EDIT_SESSION_MAX_ENTRIES,
  EDIT_SESSION_MAX_TOTAL_BYTES,
  type ExternalEditSession,
  type ExternalEditSessionState,
  type ExternalEditSessionView,
} from '../models/external-edit-session.models';

export type SessionStoreLimits = {
  idleLimitMs: number;
  absoluteLimitMs: number;
  maxEntries: number;
  maxTotalBytes: number;
  maxBaselineBytes: number;
};

export const DEFAULT_SESSION_STORE_LIMITS: SessionStoreLimits = {
  idleLimitMs: EDIT_SESSION_IDLE_LIMIT_MS,
  absoluteLimitMs: EDIT_SESSION_ABSOLUTE_LIMIT_MS,
  maxEntries: EDIT_SESSION_MAX_ENTRIES,
  maxTotalBytes: EDIT_SESSION_MAX_TOTAL_BYTES,
  maxBaselineBytes: EDIT_SESSION_MAX_BASELINE_BYTES,
};

export interface CreateSessionInput {
  kind: ExternalEditSession['kind'];
  provider: ExternalEditSession['provider'];
  connectionId: string;
  connectionGeneration: number;
  scopeKey: string;
  remoteTaskId: string;
  remoteCommentId: string | null;
  baseline: ExternalEditSession['baseline'];
  providerMetadata: ExternalEditSession['providerMetadata'];
}

export type StoreResult<T> = { ok: true; value: T } | { ok: false; reason: StoreFailure };

export type StoreFailure =
  | 'baseline_too_large'
  | 'limit_exceeded_after_eviction'
  | 'session_not_found'
  | 'session_not_editable'
  | 'session_expired'
  | 'revision_conflict'
  | 'invalid_state_for_operation'
  | 'fingerprint_mismatch';

function sessionBytes(session: ExternalEditSession): number {
  return JSON.stringify(session).length;
}

/**
 * Bounded LRU store plus the edit-session state machine. Every accessor
 * first applies idle and absolute expiry, so an expired session can never be
 * written through even if it is still resident.
 *
 * State rules:
 * - Only `editable` accepts dispatch of a new payload.
 * - `outcome_unknown` permits exactly Verify and a retry of the same payload
 *   fingerprint; seeing the old baseline after it never re-arms writes.
 * - A verified save advances the baseline and revision exactly once.
 * - `diverged`, `invalidated`, and `expired` are terminal for writes.
 */
export class ExternalEditSessionStore {
  private readonly entries = new Map<string, ExternalEditSession>();
  private totalBytes = 0;
  private readonly now: () => number;

  constructor(
    private readonly limits: SessionStoreLimits = DEFAULT_SESSION_STORE_LIMITS,
    now: () => number = () => Date.now(),
  ) {
    this.now = now;
  }

  create(input: CreateSessionInput): StoreResult<ExternalEditSession> {
    if (input.baseline && JSON.stringify(input.baseline).length > this.limits.maxBaselineBytes) {
      return { ok: false, reason: 'baseline_too_large' };
    }
    const timestamp = this.now();
    const session: ExternalEditSession = {
      sessionId: randomUUID(),
      kind: input.kind,
      provider: input.provider,
      connectionId: input.connectionId,
      connectionGeneration: input.connectionGeneration,
      scopeKey: input.scopeKey,
      remoteTaskId: input.remoteTaskId,
      remoteCommentId: input.remoteCommentId,
      baseline: input.baseline,
      providerMetadata: input.providerMetadata,
      revision: 0,
      state: 'editable',
      pendingWrite: null,
      createdAt: timestamp,
      lastActivityAt: timestamp,
    };
    const bytes = sessionBytes(session);
    if (bytes > this.limits.maxTotalBytes) {
      return { ok: false, reason: 'limit_exceeded_after_eviction' };
    }
    this.evictForBytes(bytes);
    this.entries.set(session.sessionId, session);
    this.totalBytes += bytes;
    this.evictForEntries();
    return { ok: true, value: this.clone(session) };
  }

  get(sessionId: string): StoreResult<ExternalEditSession> {
    const session = this.applyExpiry(sessionId);
    if (!session) {
      return { ok: false, reason: 'session_not_found' };
    }
    return { ok: true, value: this.clone(session) };
  }

  /** Lightweight activity touch; performs no provider interaction. */
  touch(sessionId: string): StoreResult<ExternalEditSession> {
    const session = this.applyExpiry(sessionId);
    if (!session) {
      return { ok: false, reason: 'session_not_found' };
    }
    session.lastActivityAt = this.now();
    this.moveToMostRecent(session);
    return { ok: true, value: this.clone(session) };
  }

  /**
   * Marks dispatch of a payload. Requires `editable` and a matching expected
   * revision. The pending fingerprint recorded here is the only payload a
   * retry may repeat while the outcome is unknown.
   */
  beginDispatch(
    sessionId: string,
    payloadFingerprint: string,
    expectedRevision: number,
  ): StoreResult<ExternalEditSession> {
    const session = this.requireEditable(sessionId);
    if (!session.ok) {
      return session;
    }
    if (session.value.revision !== expectedRevision) {
      return { ok: false, reason: 'revision_conflict' };
    }
    const stored = this.entries.get(sessionId)!;
    stored.state = 'outcome_unknown';
    stored.pendingWrite = { fingerprint: payloadFingerprint, dispatchedAt: this.now() };
    stored.lastActivityAt = this.now();
    this.moveToMostRecent(stored);
    return { ok: true, value: this.clone(stored) };
  }

  /**
   * Retry of the exact same payload while the outcome is unknown. Any other
   * payload, or a non-`outcome_unknown`/`editable` state, is rejected.
   */
  beginRetryDispatch(
    sessionId: string,
    payloadFingerprint: string,
    expectedRevision: number,
  ): StoreResult<ExternalEditSession> {
    const session = this.entries.get(sessionId);
    if (!session || this.applyExpiry(sessionId) === null) {
      return { ok: false, reason: 'session_not_found' };
    }
    if (session.state === 'outcome_unknown') {
      if (session.pendingWrite?.fingerprint !== payloadFingerprint) {
        return { ok: false, reason: 'fingerprint_mismatch' };
      }
      if (session.revision !== expectedRevision) {
        return { ok: false, reason: 'revision_conflict' };
      }
      session.lastActivityAt = this.now();
      this.moveToMostRecent(session);
      return { ok: true, value: this.clone(session) };
    }
    if (session.state === 'editable') {
      return this.beginDispatch(sessionId, payloadFingerprint, expectedRevision);
    }
    return { ok: false, reason: 'session_not_editable' };
  }

  /** The vendor acknowledged the mutation but it is not yet verified. */
  markSavedUnverified(sessionId: string): StoreResult<ExternalEditSession> {
    const session = this.entries.get(sessionId);
    if (!session || this.applyExpiry(sessionId) === null) {
      return { ok: false, reason: 'session_not_found' };
    }
    if (session.state !== 'outcome_unknown') {
      return { ok: false, reason: 'invalid_state_for_operation' };
    }
    session.state = 'saved_unverified';
    session.lastActivityAt = this.now();
    this.moveToMostRecent(session);
    return { ok: true, value: this.clone(session) };
  }

  /**
   * Restores `editable` after a failure proven to happen before dispatch —
   * nothing reached the vendor, so any payload remains acceptable. Only
   * valid from `outcome_unknown`; a dispatched attempt can never revert.
   */
  revertDispatch(sessionId: string): StoreResult<ExternalEditSession> {
    const session = this.entries.get(sessionId);
    if (!session || this.applyExpiry(sessionId) === null) {
      return { ok: false, reason: 'session_not_found' };
    }
    if (session.state !== 'outcome_unknown') {
      return { ok: false, reason: 'invalid_state_for_operation' };
    }
    session.state = 'editable';
    session.pendingWrite = null;
    session.lastActivityAt = this.now();
    this.moveToMostRecent(session);
    return { ok: true, value: this.clone(session) };
  }

  /**
   * A verified save advances the writable baseline and revision exactly once.
   * Only reachable from `saved_unverified` or `outcome_unknown` with a
   * pending write; idempotent repetition is impossible because the state
   * moves to `editable` and the pending write is cleared.
   */
  commitVerifiedSave(
    sessionId: string,
    newBaseline: ExternalEditSession['baseline'],
  ): StoreResult<ExternalEditSession> {
    const session = this.entries.get(sessionId);
    if (!session || this.applyExpiry(sessionId) === null) {
      return { ok: false, reason: 'session_not_found' };
    }
    if (
      session.state !== 'saved_unverified' &&
      !(session.state === 'outcome_unknown' && session.pendingWrite !== null)
    ) {
      return { ok: false, reason: 'invalid_state_for_operation' };
    }
    if (newBaseline && JSON.stringify(newBaseline).length > this.limits.maxBaselineBytes) {
      return { ok: false, reason: 'baseline_too_large' };
    }
    const previousBytes = sessionBytes(session);
    session.state = 'editable';
    session.baseline = newBaseline;
    session.revision += 1;
    session.pendingWrite = null;
    session.lastActivityAt = this.now();
    this.totalBytes -= previousBytes;
    this.totalBytes += sessionBytes(session);
    this.moveToMostRecent(session);
    return { ok: true, value: this.clone(session) };
  }

  /**
   * Verification outcome handling. `old_baseline` keeps the session locked in
   * `outcome_unknown` — writes are never re-armed for a fresh payload;
   * `new_payload` commits the pending save exactly once; any other remote
   * content is divergence, which is terminal.
   */
  applyVerifyOutcome(
    sessionId: string,
    remoteState: 'new_payload' | 'old_baseline' | 'diverged',
    newBaseline?: ExternalEditSession['baseline'],
  ): StoreResult<ExternalEditSession> {
    const session = this.entries.get(sessionId);
    if (!session || this.applyExpiry(sessionId) === null) {
      return { ok: false, reason: 'session_not_found' };
    }
    if (remoteState === 'diverged') {
      session.state = 'diverged';
      session.pendingWrite = null;
      session.lastActivityAt = this.now();
      this.moveToMostRecent(session);
      return { ok: true, value: this.clone(session) };
    }
    if (remoteState === 'old_baseline') {
      if (session.state === 'saved_unverified') {
        // The vendor acknowledged but the content never landed; treat like an
        // unknown outcome so only same-payload retry or verify remains.
        session.state = 'outcome_unknown';
      }
      session.lastActivityAt = this.now();
      this.moveToMostRecent(session);
      return { ok: true, value: this.clone(session) };
    }
    return this.commitVerifiedSave(sessionId, newBaseline ?? session.baseline);
  }

  /**
   * Re-baselines an `editable` session from a fresh provider read (explicit
   * reload). The revision advances so an editor holding the stale revision
   * gets a revision_conflict instead of writing against a moved baseline.
   * Only reachable from `editable` — a session with a pending unknown write
   * must Verify or retry, never reload.
   */
  commitReload(
    sessionId: string,
    newBaseline: ExternalEditSession['baseline'],
  ): StoreResult<ExternalEditSession> {
    const session = this.entries.get(sessionId);
    if (!session || this.applyExpiry(sessionId) === null) {
      return { ok: false, reason: 'session_not_found' };
    }
    if (session.state !== 'editable') {
      return { ok: false, reason: 'session_not_editable' };
    }
    if (newBaseline && JSON.stringify(newBaseline).length > this.limits.maxBaselineBytes) {
      return { ok: false, reason: 'baseline_too_large' };
    }
    const previousBytes = sessionBytes(session);
    session.baseline = newBaseline;
    session.revision += 1;
    session.lastActivityAt = this.now();
    this.totalBytes -= previousBytes;
    this.totalBytes += sessionBytes(session);
    this.moveToMostRecent(session);
    return { ok: true, value: this.clone(session) };
  }

  /** A delete session whose comment is confirmed gone; terminal success. */
  markDeleted(sessionId: string): StoreResult<ExternalEditSession> {
    const session = this.entries.get(sessionId);
    if (!session || this.applyExpiry(sessionId) === null) {
      return { ok: false, reason: 'session_not_found' };
    }
    session.state = 'invalidated';
    session.lastActivityAt = this.now();
    this.moveToMostRecent(session);
    return { ok: true, value: this.clone(session) };
  }

  invalidate(sessionId: string): void {
    const session = this.entries.get(sessionId);
    if (!session) {
      return;
    }
    session.state = 'invalidated';
    session.pendingWrite = null;
    session.lastActivityAt = this.now();
    this.moveToMostRecent(session);
  }

  invalidateProvider(provider: ExternalEditSession['provider']): number {
    let invalidated = 0;
    for (const session of [...this.entries.values()]) {
      if (session.provider === provider) {
        this.invalidate(session.sessionId);
        invalidated += 1;
      }
    }
    return invalidated;
  }

  size(): number {
    return this.entries.size;
  }

  totalSerializedBytes(): number {
    return this.totalBytes;
  }

  view(session: ExternalEditSession): ExternalEditSessionView {
    return {
      sessionId: session.sessionId,
      kind: session.kind,
      provider: session.provider,
      remoteTaskId: session.remoteTaskId,
      remoteCommentId: session.remoteCommentId,
      state: session.state,
      revision: session.revision,
      baselineFingerprint: session.baseline?.fingerprint ?? null,
      createdAt: new Date(session.createdAt).toISOString(),
      lastActivityAt: new Date(session.lastActivityAt).toISOString(),
      idleExpiresAt: new Date(session.lastActivityAt + this.limits.idleLimitMs).toISOString(),
      absoluteExpiresAt: new Date(session.createdAt + this.limits.absoluteLimitMs).toISOString(),
    };
  }

  private requireEditable(sessionId: string): StoreResult<ExternalEditSession> {
    const session = this.applyExpiry(sessionId);
    if (!session) {
      return { ok: false, reason: 'session_not_found' };
    }
    if (session.state !== 'editable') {
      return { ok: false, reason: 'session_not_editable' };
    }
    return { ok: true, value: session };
  }

  /** Applies idle and absolute expiry; returns null once expired. */
  private applyExpiry(sessionId: string): ExternalEditSession | null {
    const session = this.entries.get(sessionId);
    if (!session) {
      return null;
    }
    const now = this.now();
    const idleExpired = now - session.lastActivityAt > this.limits.idleLimitMs;
    const absoluteExpired = now - session.createdAt > this.limits.absoluteLimitMs;
    if (idleExpired || absoluteExpired) {
      session.state = 'expired';
      this.entries.delete(sessionId);
      this.totalBytes -= sessionBytes(session);
      // The expired session is dropped, not retained: it can never be written.
      return null;
    }
    this.moveToMostRecent(session);
    return this.clone(session);
  }

  private moveToMostRecent(session: ExternalEditSession): void {
    this.entries.delete(session.sessionId);
    this.entries.set(session.sessionId, session);
  }

  private evictForBytes(incomingBytes: number): void {
    while (this.totalBytes + incomingBytes > this.limits.maxTotalBytes && this.entries.size > 0) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.drop(oldest);
    }
  }

  private evictForEntries(): void {
    while (this.entries.size > this.limits.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.drop(oldest);
    }
  }

  private drop(sessionId: string): void {
    const session = this.entries.get(sessionId);
    if (!session) {
      return;
    }
    this.entries.delete(sessionId);
    this.totalBytes -= sessionBytes(session);
  }

  private clone(session: ExternalEditSession): ExternalEditSession {
    return {
      ...session,
      baseline: session.baseline
        ? {
            fingerprint: session.baseline.fingerprint,
            document: JSON.parse(JSON.stringify(session.baseline.document)),
          }
        : null,
      providerMetadata: { ...session.providerMetadata },
      pendingWrite: session.pendingWrite ? { ...session.pendingWrite } : null,
    };
  }
}

export function isWritableSessionState(state: ExternalEditSessionState): boolean {
  return state === 'editable';
}
