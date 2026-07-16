/**
 * Terminal history-refresh lifecycle owner.
 *
 * The single owner of every piece of state a scroll-up history refresh depends on, so no
 * handler mutates an independent flag that another handler reads. It is a pure, testable
 * seam (like `scroll-history-detector.ts`) with no React or socket dependency.
 *
 * Two facts that used to be conflated on one `hasHistory` flag are kept apart here:
 *
 * - **refreshable** — the immutable provider capability (line-oriented providers can reload
 *   primary-buffer history; alternate-screen TUIs cannot). Adopted first-non-undefined-wins
 *   from the `subscribed` ack and never flipped by a snapshot. A non-truncated seed can no
 *   longer suppress every later refresh.
 * - **snapshotHasMore** — the per-snapshot has-more (`payload.hasHistory` on seed/full_history).
 *   Informational only; it never gates a refresh and is never pinned true.
 *
 * A refresh is *dirty* — worth requesting — when there is no trusted baseline yet, or when
 * newer output has been observed than the accepted snapshot covers. `acceptedSnapshotSequence`
 * is nullable: `null` means "no trusted baseline"; `0` is a valid established baseline.
 *
 * The active-attempt token correlates a request with its response so a late/superseded
 * `full_history` (from a disconnected socket, or one invalidated by recovery) is dropped
 * before it can touch the write pump or the baseline.
 */

export type HistoryPhase = 'seeding' | 'recovering' | 'settled';

export interface HistoryRequestGateInput {
  /** Whether the socket is currently connected. */
  connected: boolean;
  /** Whether the server has confirmed the subscription. */
  subscribed: boolean;
}

export interface TerminalHistorySync {
  // ── Sequence-domain epoch (server-owned; scopes every replay number) ───────
  /**
   * Adopt the epoch from a `subscribed` ack. Returns `true` only when it REPLACES a
   * different prior epoch — a genuine server-side domain switch, after which the caller must
   * clear old-domain recovery guards and reconnect watermark. First adoption (from none)
   * returns `false`. Either way, a switch drops the baseline, latest-observed, and active
   * attempt so a fresh domain's lower `currentSequence` is accepted, never suppressed as stale.
   */
  reconcileEpoch(epoch: string): boolean;
  getSequenceEpoch(): string | null;

  // ── Provider capability (immutable, first-non-undefined-wins) ──────────────
  adoptRefreshable(value: boolean | undefined): void;
  isRefreshable(): boolean;

  // ── Lifecycle phase / readiness ────────────────────────────────────────────
  beginSeed(): void;
  beginRecovery(): void;
  settle(): void;
  /** Leave the settled state (disconnect) without implying an incoming seed/recovery. */
  suspend(): void;
  getPhase(): HistoryPhase;
  isSettled(): boolean;

  // ── Per-snapshot has-more (never gates refresh, never pinned true) ─────────
  setSnapshotHasMore(value: boolean): void;
  hasMore(): boolean;

  // ── Sequence tracking ──────────────────────────────────────────────────────
  /** Advance the newest-observed live sequence. Runs for every sequenced frame,
   *  including ones buffered during a history load — independent of the reconnect watermark. */
  observeLiveSequence(sequence: number): void;
  getLatestObservedSequence(): number;
  /** Commit the applied capture baseline (accepts 0). Also raises latest-observed to it. */
  commitBaseline(sequence: number): void;
  getAcceptedSnapshotSequence(): number | null;
  isDirty(): boolean;

  // ── Active correlated attempt ──────────────────────────────────────────────
  /** Open a new attempt and return its correlation token; supersedes any prior attempt. */
  beginAttempt(): string;
  isActiveAttempt(token: string | undefined | null): boolean;
  hasActiveAttempt(): boolean;
  invalidateAttempt(): void;

  // ── Composite request gate ─────────────────────────────────────────────────
  isRequestEligible(input: HistoryRequestGateInput): boolean;

  /** Reset all per-session state. Call on sessionId change / disposal. */
  reset(): void;
}

export function createTerminalHistorySync(): TerminalHistorySync {
  let refreshable: boolean | null = null;
  let phase: HistoryPhase = 'seeding';
  let snapshotHasMore = false;
  let latestObservedSequence = 0;
  let acceptedSnapshotSequence: number | null = null;
  let activeAttempt: string | null = null;
  let sequenceEpoch: string | null = null;
  // Monotonic across reset so a token minted before a reset can never collide with a new one.
  let attemptCounter = 0;

  function reconcileEpoch(epoch: string): boolean {
    const isSwitch = sequenceEpoch !== null && sequenceEpoch !== epoch;
    if (sequenceEpoch !== epoch) {
      sequenceEpoch = epoch;
      // A new domain: the old numeric baseline/observed belong to a retired sequence space, so a
      // lower new-domain sequence must not read as unchanged/stale. Drop them and any in-flight
      // attempt. Provider capability (refreshable) and lifecycle phase are session-scoped, not
      // domain-scoped, so they are left intact.
      acceptedSnapshotSequence = null;
      latestObservedSequence = 0;
      activeAttempt = null;
    }
    return isSwitch;
  }

  function getSequenceEpoch(): string | null {
    return sequenceEpoch;
  }

  function adoptRefreshable(value: boolean | undefined): void {
    if (value === undefined || refreshable !== null) return;
    refreshable = value;
  }

  function isRefreshable(): boolean {
    return refreshable === true;
  }

  function beginSeed(): void {
    phase = 'seeding';
    activeAttempt = null;
  }

  function beginRecovery(): void {
    phase = 'recovering';
    activeAttempt = null;
  }

  function settle(): void {
    phase = 'settled';
  }

  function suspend(): void {
    phase = 'seeding';
    activeAttempt = null;
  }

  function getPhase(): HistoryPhase {
    return phase;
  }

  function isSettled(): boolean {
    return phase === 'settled';
  }

  function setSnapshotHasMore(value: boolean): void {
    snapshotHasMore = value;
  }

  function hasMore(): boolean {
    return snapshotHasMore;
  }

  function observeLiveSequence(sequence: number): void {
    if (!Number.isFinite(sequence)) return;
    if (sequence > latestObservedSequence) latestObservedSequence = sequence;
  }

  function getLatestObservedSequence(): number {
    return latestObservedSequence;
  }

  function commitBaseline(sequence: number): void {
    if (!Number.isFinite(sequence)) return;
    acceptedSnapshotSequence = sequence;
    if (sequence > latestObservedSequence) latestObservedSequence = sequence;
  }

  function getAcceptedSnapshotSequence(): number | null {
    return acceptedSnapshotSequence;
  }

  function isDirty(): boolean {
    if (acceptedSnapshotSequence === null) return true;
    return latestObservedSequence > acceptedSnapshotSequence;
  }

  function beginAttempt(): string {
    attemptCounter += 1;
    activeAttempt = String(attemptCounter);
    return activeAttempt;
  }

  function isActiveAttempt(token: string | undefined | null): boolean {
    return token != null && activeAttempt === token;
  }

  function hasActiveAttempt(): boolean {
    return activeAttempt !== null;
  }

  function invalidateAttempt(): void {
    activeAttempt = null;
  }

  function isRequestEligible(input: HistoryRequestGateInput): boolean {
    return (
      input.connected &&
      input.subscribed &&
      phase === 'settled' &&
      refreshable === true &&
      activeAttempt === null &&
      isDirty()
    );
  }

  function reset(): void {
    refreshable = null;
    phase = 'seeding';
    snapshotHasMore = false;
    latestObservedSequence = 0;
    acceptedSnapshotSequence = null;
    activeAttempt = null;
    sequenceEpoch = null;
  }

  return {
    reconcileEpoch,
    getSequenceEpoch,
    adoptRefreshable,
    isRefreshable,
    beginSeed,
    beginRecovery,
    settle,
    suspend,
    getPhase,
    isSettled,
    setSnapshotHasMore,
    hasMore,
    observeLiveSequence,
    getLatestObservedSequence,
    commitBaseline,
    getAcceptedSnapshotSequence,
    isDirty,
    beginAttempt,
    isActiveAttempt,
    hasActiveAttempt,
    invalidateAttempt,
    isRequestEligible,
    reset,
  };
}
