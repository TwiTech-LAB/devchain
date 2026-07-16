import { createTerminalHistorySync } from './terminal-history-sync';

const eligibleInput = { connected: true, subscribed: true };

describe('createTerminalHistorySync', () => {
  describe('provider refresh capability', () => {
    it('adopts refreshable first-non-undefined-wins and ignores later values', () => {
      const sync = createTerminalHistorySync();
      expect(sync.isRefreshable()).toBe(false);

      sync.adoptRefreshable(undefined);
      expect(sync.isRefreshable()).toBe(false);

      sync.adoptRefreshable(true);
      expect(sync.isRefreshable()).toBe(true);

      // A later ack cannot flip an already-adopted capability.
      sync.adoptRefreshable(false);
      expect(sync.isRefreshable()).toBe(true);
    });

    it('adopts a first false and holds it', () => {
      const sync = createTerminalHistorySync();
      sync.adoptRefreshable(false);
      sync.adoptRefreshable(true);
      expect(sync.isRefreshable()).toBe(false);
    });

    it('re-adopts after reset (disposal / sessionId change)', () => {
      const sync = createTerminalHistorySync();
      sync.adoptRefreshable(true);
      sync.reset();
      expect(sync.isRefreshable()).toBe(false);
      sync.adoptRefreshable(false);
      expect(sync.isRefreshable()).toBe(false);
    });
  });

  describe('lifecycle phase / readiness', () => {
    it('starts unsettled and becomes settled only after settle()', () => {
      const sync = createTerminalHistorySync();
      expect(sync.isSettled()).toBe(false);
      expect(sync.getPhase()).toBe('seeding');

      sync.beginSeed();
      expect(sync.isSettled()).toBe(false);

      sync.settle();
      expect(sync.isSettled()).toBe(true);
      expect(sync.getPhase()).toBe('settled');
    });

    it('suspend leaves the settled state and drops the active attempt', () => {
      const sync = createTerminalHistorySync();
      sync.settle();
      sync.beginAttempt();
      sync.suspend();
      expect(sync.isSettled()).toBe(false);
      expect(sync.hasActiveAttempt()).toBe(false);
    });

    it('beginRecovery drops the active attempt and unsettles', () => {
      const sync = createTerminalHistorySync();
      sync.settle();
      sync.beginAttempt();
      sync.beginRecovery();
      expect(sync.getPhase()).toBe('recovering');
      expect(sync.hasActiveAttempt()).toBe(false);
    });
  });

  describe('per-snapshot has-more', () => {
    it('tracks snapshotHasMore without affecting refresh eligibility', () => {
      const sync = createTerminalHistorySync();
      sync.adoptRefreshable(true);
      sync.settle();

      sync.setSnapshotHasMore(false);
      expect(sync.hasMore()).toBe(false);
      // A non-truncated snapshot (hasMore=false) must NOT suppress refresh.
      expect(sync.isRequestEligible(eligibleInput)).toBe(true);

      sync.setSnapshotHasMore(true);
      expect(sync.hasMore()).toBe(true);
    });
  });

  describe('sequence tracking and dirtiness', () => {
    it('is dirty before any trusted baseline', () => {
      const sync = createTerminalHistorySync();
      expect(sync.getAcceptedSnapshotSequence()).toBeNull();
      expect(sync.isDirty()).toBe(true);
    });

    it('treats sequence 0 as a valid established baseline', () => {
      const sync = createTerminalHistorySync();
      sync.commitBaseline(0);
      expect(sync.getAcceptedSnapshotSequence()).toBe(0);
      // Unchanged excursion: latestObserved (0) not greater than baseline (0).
      expect(sync.isDirty()).toBe(false);
    });

    it('becomes dirty only when newer output is observed past the baseline', () => {
      const sync = createTerminalHistorySync();
      sync.commitBaseline(5);
      expect(sync.isDirty()).toBe(false);

      sync.observeLiveSequence(5);
      expect(sync.isDirty()).toBe(false);

      sync.observeLiveSequence(6);
      expect(sync.isDirty()).toBe(true);
    });

    it('observeLiveSequence only ever advances and ignores non-finite input', () => {
      const sync = createTerminalHistorySync();
      sync.observeLiveSequence(10);
      sync.observeLiveSequence(4);
      sync.observeLiveSequence(Number.NaN);
      expect(sync.getLatestObservedSequence()).toBe(10);
    });

    it('commitBaseline raises latest-observed so a stale earlier read cannot re-dirty', () => {
      const sync = createTerminalHistorySync();
      sync.commitBaseline(9);
      expect(sync.getLatestObservedSequence()).toBe(9);
      expect(sync.isDirty()).toBe(false);
    });
  });

  describe('active correlated attempt', () => {
    it('mints unique tokens and matches only the current one', () => {
      const sync = createTerminalHistorySync();
      const first = sync.beginAttempt();
      expect(sync.hasActiveAttempt()).toBe(true);
      expect(sync.isActiveAttempt(first)).toBe(true);

      const second = sync.beginAttempt();
      expect(second).not.toBe(first);
      // The superseded token no longer matches.
      expect(sync.isActiveAttempt(first)).toBe(false);
      expect(sync.isActiveAttempt(second)).toBe(true);
    });

    it('rejects null/undefined tokens and invalidated attempts', () => {
      const sync = createTerminalHistorySync();
      const token = sync.beginAttempt();
      expect(sync.isActiveAttempt(undefined)).toBe(false);
      expect(sync.isActiveAttempt(null)).toBe(false);

      sync.invalidateAttempt();
      expect(sync.hasActiveAttempt()).toBe(false);
      expect(sync.isActiveAttempt(token)).toBe(false);
    });

    it('never reuses a token across reset', () => {
      const sync = createTerminalHistorySync();
      const before = sync.beginAttempt();
      sync.reset();
      const after = sync.beginAttempt();
      expect(after).not.toBe(before);
    });
  });

  describe('composite request gate', () => {
    it('requires connected, subscribed, settled, refreshable, dirty, and no active attempt', () => {
      const sync = createTerminalHistorySync();
      sync.adoptRefreshable(true);
      sync.settle();
      expect(sync.isRequestEligible(eligibleInput)).toBe(true);

      expect(sync.isRequestEligible({ connected: false, subscribed: true })).toBe(false);
      expect(sync.isRequestEligible({ connected: true, subscribed: false })).toBe(false);
    });

    it('blocks a non-refreshable (alternate-screen) provider', () => {
      const sync = createTerminalHistorySync();
      sync.adoptRefreshable(false);
      sync.settle();
      expect(sync.isRequestEligible(eligibleInput)).toBe(false);
    });

    it('blocks until the lifecycle settles', () => {
      const sync = createTerminalHistorySync();
      sync.adoptRefreshable(true);
      sync.beginSeed();
      expect(sync.isRequestEligible(eligibleInput)).toBe(false);
      sync.settle();
      expect(sync.isRequestEligible(eligibleInput)).toBe(true);
    });

    it('blocks a clean terminal and re-opens when it goes dirty', () => {
      const sync = createTerminalHistorySync();
      sync.adoptRefreshable(true);
      sync.settle();
      sync.commitBaseline(3);
      expect(sync.isRequestEligible(eligibleInput)).toBe(false);
      sync.observeLiveSequence(4);
      expect(sync.isRequestEligible(eligibleInput)).toBe(true);
    });

    it('admits no second request while one is active', () => {
      const sync = createTerminalHistorySync();
      sync.adoptRefreshable(true);
      sync.settle();
      sync.beginAttempt();
      expect(sync.isRequestEligible(eligibleInput)).toBe(false);
      sync.invalidateAttempt();
      expect(sync.isRequestEligible(eligibleInput)).toBe(true);
    });
  });

  describe('reset', () => {
    it('clears all per-session state', () => {
      const sync = createTerminalHistorySync();
      sync.adoptRefreshable(true);
      sync.settle();
      sync.setSnapshotHasMore(true);
      sync.observeLiveSequence(20);
      sync.commitBaseline(15);
      sync.beginAttempt();

      sync.reset();

      expect(sync.isRefreshable()).toBe(false);
      expect(sync.isSettled()).toBe(false);
      expect(sync.hasMore()).toBe(false);
      expect(sync.getLatestObservedSequence()).toBe(0);
      expect(sync.getAcceptedSnapshotSequence()).toBeNull();
      expect(sync.hasActiveAttempt()).toBe(false);
      expect(sync.isDirty()).toBe(true);
    });

    it('clears the sequence-domain epoch', () => {
      const sync = createTerminalHistorySync();
      sync.reconcileEpoch('epoch-A');
      expect(sync.getSequenceEpoch()).toBe('epoch-A');

      sync.reset();

      expect(sync.getSequenceEpoch()).toBeNull();
    });
  });

  describe('sequence-domain epoch reconciliation', () => {
    it('adopts the first epoch without signalling a switch', () => {
      const sync = createTerminalHistorySync();
      expect(sync.getSequenceEpoch()).toBeNull();

      expect(sync.reconcileEpoch('epoch-A')).toBe(false);
      expect(sync.getSequenceEpoch()).toBe('epoch-A');
    });

    it('is a no-op for the same epoch and retains the baseline (delta-only reconnect)', () => {
      const sync = createTerminalHistorySync();
      sync.reconcileEpoch('epoch-A');
      sync.commitBaseline(30);
      sync.observeLiveSequence(30);
      const attempt = sync.beginAttempt();

      expect(sync.reconcileEpoch('epoch-A')).toBe(false);
      expect(sync.getAcceptedSnapshotSequence()).toBe(30);
      expect(sync.isActiveAttempt(attempt)).toBe(true);
    });

    it('signals a switch and retires the old baseline/observed/attempt so a lower sequence is accepted', () => {
      const sync = createTerminalHistorySync();
      sync.reconcileEpoch('epoch-A');
      sync.commitBaseline(60);
      sync.observeLiveSequence(60);
      sync.beginAttempt();
      expect(sync.isDirty()).toBe(false);

      // A new domain with a much lower current sequence must not read as unchanged/stale.
      expect(sync.reconcileEpoch('epoch-B')).toBe(true);
      expect(sync.getSequenceEpoch()).toBe('epoch-B');
      expect(sync.getAcceptedSnapshotSequence()).toBeNull();
      expect(sync.getLatestObservedSequence()).toBe(0);
      expect(sync.hasActiveAttempt()).toBe(false);
      expect(sync.isDirty()).toBe(true);
    });

    it('leaves provider capability and lifecycle phase intact across a switch (session-scoped)', () => {
      const sync = createTerminalHistorySync();
      sync.adoptRefreshable(true);
      sync.settle();
      sync.reconcileEpoch('epoch-A');

      sync.reconcileEpoch('epoch-B');

      expect(sync.isRefreshable()).toBe(true);
      expect(sync.isSettled()).toBe(true);
    });
  });
});
