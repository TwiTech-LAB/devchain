import {
  DEFAULT_SESSION_STORE_LIMITS,
  ExternalEditSessionStore,
  type CreateSessionInput,
} from './external-edit-session.store';

// Pure store/state-machine contract — the cheapest reliable layer: no I/O,
// no DI, deterministic clock injection for the time-based limits.

function baseInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    kind: 'description_edit',
    provider: 'jira',
    projectId: 'project-1',
    connectionId: 'connection-1',
    connectionGeneration: 2,
    scopeKey: 'connection-1',
    remoteTaskId: 'KAN-1',
    remoteCommentId: null,
    baseline: { document: { version: 1, blocks: [] }, fingerprint: 'fp-0' },
    providerMetadata: { lookupToken: null, ownerRemoteId: '' },
    ...overrides,
  };
}

function smallStore(
  overrides: Partial<typeof DEFAULT_SESSION_STORE_LIMITS> = {},
  now?: () => number,
): ExternalEditSessionStore {
  return new ExternalEditSessionStore({ ...DEFAULT_SESSION_STORE_LIMITS, ...overrides }, now);
}

describe('ExternalEditSessionStore', () => {
  let nowMs: number;

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
  });

  const clock = () => nowMs;

  describe('bounded LRU', () => {
    it('enforces the entry limit by evicting least-recently-used entries', () => {
      const store = smallStore({ maxEntries: 2 });
      const first = store.create(baseInput())!;
      const second = store.create(baseInput())!;
      const third = store.create(baseInput())!;
      expect(store.size()).toBe(2);
      expect(store.get((first as { value: { sessionId: string } }).value.sessionId).ok).toBe(false);
      expect(store.get((second as { value: { sessionId: string } }).value.sessionId).ok).toBe(true);
      expect(store.get((third as { value: { sessionId: string } }).value.sessionId).ok).toBe(true);
    });

    it('refreshes LRU position on access and touch', () => {
      const store = smallStore({ maxEntries: 2 });
      const first = (store.create(baseInput()) as { value: { sessionId: string } }).value;
      const second = (store.create(baseInput()) as { value: { sessionId: string } }).value;
      store.touch(first.sessionId);
      store.create(baseInput()); // evicts the LRU entry (second)
      expect(store.get(second.sessionId).ok).toBe(false);
      expect(store.get(first.sessionId).ok).toBe(true);
    });

    it('enforces the byte budget by evicting oldest sessions first', () => {
      const bigBaseline = {
        document: 'x'.repeat(2_000),
        fingerprint: 'fp',
      };
      const store = smallStore({ maxTotalBytes: 6_000, maxBaselineBytes: 8_000 });
      const first = (
        store.create(baseInput({ baseline: bigBaseline })) as { value: { sessionId: string } }
      ).value;
      store.create(baseInput({ baseline: bigBaseline }));
      store.create(baseInput({ baseline: bigBaseline }));
      expect(store.totalSerializedBytes()).toBeLessThanOrEqual(6_000 + 3_000);
      expect(store.get(first.sessionId).ok).toBe(false);
      expect(store.size()).toBe(2);
    });

    it('rejects a single oversized baseline', () => {
      const store = smallStore({ maxBaselineBytes: 100 });
      const result = store.create(
        baseInput({ baseline: { document: 'x'.repeat(500), fingerprint: 'fp' } }),
      );
      expect(result).toEqual({ ok: false, reason: 'baseline_too_large' });
    });

    it('expires sessions after the idle limit and drops them', () => {
      const store = smallStore({ idleLimitMs: 1_000 }, clock);
      const created = (store.create(baseInput()) as { value: { sessionId: string } }).value;
      nowMs += 1_001;
      expect(store.get(created.sessionId)).toEqual({ ok: false, reason: 'session_not_found' });
      expect(store.size()).toBe(0);
    });

    it('a touch extends the idle window without exceeding the absolute limit', () => {
      const store = smallStore({ idleLimitMs: 1_000, absoluteLimitMs: 10_000 }, clock);
      const created = (store.create(baseInput()) as { value: { sessionId: string } }).value;
      for (let tick = 0; tick < 12; tick += 1) {
        nowMs += 900;
        const touched = store.touch(created.sessionId);
        if (tick < 10) {
          expect(touched.ok).toBe(true);
        }
      }
      // Absolute limit reached: no touch keeps it alive.
      expect(store.touch(created.sessionId).ok).toBe(false);
      expect(store.size()).toBe(0);
    });

    it('expires by absolute age even when constantly touched', () => {
      const store = smallStore({ idleLimitMs: 10_000, absoluteLimitMs: 5_000 }, clock);
      const created = (store.create(baseInput()) as { value: { sessionId: string } }).value;
      nowMs += 4_000;
      expect(store.touch(created.sessionId).ok).toBe(true);
      // Idle has not elapsed, but the absolute limit has.
      nowMs += 1_100;
      expect(store.get(created.sessionId).ok).toBe(false);
    });
  });

  describe('state machine', () => {
    it('moves editable → outcome_unknown → saved_unverified → editable with revision advanced once', () => {
      const store = smallStore({}, clock);
      const created = (store.create(baseInput()) as { value: { sessionId: string } }).value;
      const id = created.sessionId;

      expect((store.get(id) as { value: { state: string } }).value.state).toBe('editable');
      expect((store.beginDispatch(id, 'fp-1', 0) as { value: { state: string } }).value.state).toBe(
        'outcome_unknown',
      );
      expect((store.markSavedUnverified(id) as { value: { state: string } }).value.state).toBe(
        'saved_unverified',
      );

      const committed = store.commitVerifiedSave(id, {
        document: { version: 1, blocks: [] },
        fingerprint: 'fp-1',
      }) as { value: { state: string; revision: number; baseline: { fingerprint: string } } };
      expect(committed.value.state).toBe('editable');
      expect(committed.value.revision).toBe(1);
      expect(committed.value.baseline.fingerprint).toBe('fp-1');

      // Committing again is impossible: the state already left saved_unverified.
      expect(
        store.commitVerifiedSave(id, {
          document: { version: 1, blocks: [] },
          fingerprint: 'fp-1',
        }),
      ).toEqual({ ok: false, reason: 'invalid_state_for_operation' });
    });

    it('only editable accepts a new payload dispatch', () => {
      const store = smallStore({}, clock);
      const id = (store.create(baseInput()) as { value: { sessionId: string } }).value.sessionId;
      store.beginDispatch(id, 'fp-1', 0);
      expect(store.beginDispatch(id, 'fp-2', 0)).toEqual({
        ok: false,
        reason: 'session_not_editable',
      });
    });

    it('rejects dispatch on a stale revision with revision_conflict', () => {
      const store = smallStore({}, clock);
      const id = (store.create(baseInput()) as { value: { sessionId: string } }).value.sessionId;
      expect(store.beginDispatch(id, 'fp-1', 7)).toEqual({
        ok: false,
        reason: 'revision_conflict',
      });
    });

    it('outcome_unknown permits only the exact same payload on retry', () => {
      const store = smallStore({}, clock);
      const id = (store.create(baseInput()) as { value: { sessionId: string } }).value.sessionId;
      store.beginDispatch(id, 'fp-1', 0);
      expect(store.beginRetryDispatch(id, 'fp-other', 0)).toEqual({
        ok: false,
        reason: 'fingerprint_mismatch',
      });
      const retried = store.beginRetryDispatch(id, 'fp-1', 0) as { value: { state: string } };
      expect(retried.value.state).toBe('outcome_unknown');
    });

    it('seeing the old baseline after outcome_unknown never re-arms writes', () => {
      const store = smallStore({}, clock);
      const id = (store.create(baseInput()) as { value: { sessionId: string } }).value.sessionId;
      store.beginDispatch(id, 'fp-1', 0);
      const afterOld = store.applyVerifyOutcome(id, 'old_baseline') as {
        value: { state: string; revision: number };
      };
      expect(afterOld.value.state).toBe('outcome_unknown');
      expect(afterOld.value.revision).toBe(0);
      // A different payload is still refused.
      expect(store.beginDispatch(id, 'fp-2', 0)).toEqual({
        ok: false,
        reason: 'session_not_editable',
      });
    });

    it('a verified save after outcome_unknown commits exactly once', () => {
      const store = smallStore({}, clock);
      const id = (store.create(baseInput()) as { value: { sessionId: string } }).value.sessionId;
      store.beginDispatch(id, 'fp-1', 0);
      const committed = store.applyVerifyOutcome(id, 'new_payload', {
        document: { version: 1, blocks: [] },
        fingerprint: 'fp-1',
      }) as { value: { state: string; revision: number } };
      expect(committed.value.state).toBe('editable');
      expect(committed.value.revision).toBe(1);
    });

    it('divergence is terminal and never issues a writable revision', () => {
      const store = smallStore({}, clock);
      const id = (store.create(baseInput()) as { value: { sessionId: string } }).value.sessionId;
      store.beginDispatch(id, 'fp-1', 0);
      const diverged = store.applyVerifyOutcome(id, 'diverged') as {
        value: { state: string; revision: number };
      };
      expect(diverged.value.state).toBe('diverged');
      expect(store.beginDispatch(id, 'fp-1', diverged.value.revision)).toEqual({
        ok: false,
        reason: 'session_not_editable',
      });
    });

    it('revertDispatch restores editable only from outcome_unknown', () => {
      const store = smallStore({}, clock);
      const id = (store.create(baseInput()) as { value: { sessionId: string } }).value.sessionId;
      store.beginDispatch(id, 'fp-1', 0);
      const reverted = store.revertDispatch(id) as { value: { state: string } };
      expect(reverted.value.state).toBe('editable');
      expect(store.markSavedUnverified(id)).toEqual({
        ok: false,
        reason: 'invalid_state_for_operation',
      });
    });
  });

  it('invalidates sessions for only the replaced project connection', () => {
    const store = smallStore({}, clock);
    const first = (
      store.create(baseInput({ connectionId: 'project-1-jira' })) as {
        value: { sessionId: string };
      }
    ).value;
    const second = (
      store.create(baseInput({ connectionId: 'project-2-jira' })) as {
        value: { sessionId: string };
      }
    ).value;

    expect(store.invalidateConnection('project-1-jira')).toBe(1);
    expect(store.get(first.sessionId)).toMatchObject({ value: { state: 'invalidated' } });
    expect(store.get(second.sessionId)).toMatchObject({ value: { state: 'editable' } });
  });
});
