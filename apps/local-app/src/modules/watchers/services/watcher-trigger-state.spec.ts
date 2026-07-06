import { WatcherTriggerState } from './watcher-trigger-state';
import type { Watcher } from '../../storage/models/domain.models';

describe('WatcherTriggerState', () => {
  let state: WatcherTriggerState;

  const createTestWatcher = (overrides: Partial<Watcher> = {}): Watcher => ({
    id: 'watcher-1',
    projectId: 'project-1',
    name: 'Test Watcher',
    description: null,
    enabled: true,
    scope: 'all',
    scopeFilterId: null,
    pollIntervalMs: 1000,
    viewportLines: 50,
    idleAfterSeconds: 0,
    condition: { type: 'contains', pattern: 'error' },
    cooldownMs: 5000,
    cooldownMode: 'time',
    eventName: 'test.event',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  });

  beforeEach(() => {
    state = new WatcherTriggerState();
  });

  describe('computeViewportHash', () => {
    it('should return a 16-character hex string', () => {
      const hash = state.computeViewportHash('test content');
      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('should return consistent hash for same content', () => {
      const hash1 = state.computeViewportHash('same content');
      const hash2 = state.computeViewportHash('same content');
      expect(hash1).toBe(hash2);
    });

    it('should return different hash for different content', () => {
      const hash1 = state.computeViewportHash('content A');
      const hash2 = state.computeViewportHash('content B');
      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty string', () => {
      const hash = state.computeViewportHash('');
      expect(hash).toHaveLength(16);
    });

    it('should handle unicode content', () => {
      const hash = state.computeViewportHash('中文内容');
      expect(hash).toHaveLength(16);
    });
  });

  describe('evaluate', () => {
    describe('hash-based deduplication', () => {
      it('should trigger on first match', () => {
        const watcher = createTestWatcher();
        const result = state.evaluate(watcher, 'session-1', 'error content', true);
        expect(result.shouldTrigger).toBe(true);
      });

      it('should NOT trigger when viewport hash unchanged', () => {
        const watcher = createTestWatcher();
        // First trigger
        state.evaluate(watcher, 'session-1', 'error content', true);
        // Second call with same content - should skip
        const result = state.evaluate(watcher, 'session-1', 'error content', true);
        expect(result.shouldTrigger).toBe(false);
      });

      it('should trigger when viewport hash changes', () => {
        const watcher = createTestWatcher({ cooldownMs: 0 }); // Disable time-based cooldown
        // First trigger
        state.evaluate(watcher, 'session-1', 'error content 1', true);
        // Second call with different content - should trigger
        const result = state.evaluate(watcher, 'session-1', 'error content 2', true);
        expect(result.shouldTrigger).toBe(true);
      });
    });

    describe('time-based cooldown', () => {
      it('should NOT trigger during cooldown period', () => {
        const watcher = createTestWatcher({ cooldownMs: 10000 }); // 10s cooldown
        // First trigger
        state.evaluate(watcher, 'session-1', 'error 1', true);
        // Second call with different content but within cooldown
        const result = state.evaluate(watcher, 'session-1', 'error 2', true);
        expect(result.shouldTrigger).toBe(false);
      });

      it('should trigger after cooldown expires', async () => {
        const watcher = createTestWatcher({ cooldownMs: 10 }); // 10ms cooldown
        // First trigger
        state.evaluate(watcher, 'session-1', 'error 1', true);
        // Wait for cooldown to expire
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Should trigger again even if viewport unchanged (cooldown already throttles)
        const result = state.evaluate(watcher, 'session-1', 'error 1', true);
        expect(result.shouldTrigger).toBe(true);
      });
    });

    describe('until_clear cooldown mode', () => {
      it('should trigger on first false->true transition', () => {
        const watcher = createTestWatcher({ cooldownMode: 'until_clear' });
        const result = state.evaluate(watcher, 'session-1', 'error content', true);
        expect(result.shouldTrigger).toBe(true);
      });

      it('should NOT trigger when condition stays true', () => {
        const watcher = createTestWatcher({ cooldownMode: 'until_clear' });
        // First trigger (false -> true)
        state.evaluate(watcher, 'session-1', 'error 1', true);
        // Second call with condition still true (different content)
        const result = state.evaluate(watcher, 'session-1', 'error 2', true);
        expect(result.shouldTrigger).toBe(false);
      });

      it('should trigger again after condition clears (true->false->true)', () => {
        const watcher = createTestWatcher({ cooldownMode: 'until_clear', cooldownMs: 0 });
        // First trigger (false -> true)
        state.evaluate(watcher, 'session-1', 'error 1', true);
        // Condition becomes false - clears cooldown
        state.evaluate(watcher, 'session-1', 'no error', false);
        // Condition becomes true again - should trigger
        const result = state.evaluate(watcher, 'session-1', 'error 2', true);
        expect(result.shouldTrigger).toBe(true);
      });

      it('should clear cooldown when condition becomes false', () => {
        const watcher = createTestWatcher({ cooldownMode: 'until_clear', cooldownMs: 0 });
        // Trigger
        state.evaluate(watcher, 'session-1', 'error', true);
        // Verify cooldown is set
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((state as any).cooldowns.has('watcher-1:session-1')).toBe(true);
        // Condition becomes false
        state.evaluate(watcher, 'session-1', 'no error', false);
        // Cooldown should be cleared
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((state as any).cooldowns.has('watcher-1:session-1')).toBe(false);
      });

      it('should not clear cooldown during the until_clear hold window', () => {
        const watcher = createTestWatcher({ cooldownMode: 'until_clear', cooldownMs: 30000 });

        state.evaluate(watcher, 'session-1', 'Context compacted', true);
        state.evaluate(watcher, 'session-1', 'terminal redraw without match', false);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((state as any).cooldowns.has('watcher-1:session-1')).toBe(true);

        const result = state.evaluate(watcher, 'session-1', 'Context compacted', true);
        expect(result.shouldTrigger).toBe(false);
      });

      it('should not retrigger the identical viewport after a clear', () => {
        const watcher = createTestWatcher({ cooldownMode: 'until_clear', cooldownMs: 0 });

        state.evaluate(watcher, 'session-1', 'Context compacted', true);
        state.evaluate(watcher, 'session-1', 'terminal redraw without match', false);

        const result = state.evaluate(watcher, 'session-1', 'Context compacted', true);

        expect(result.shouldTrigger).toBe(false);
      });
    });

    describe('condition state tracking', () => {
      it('should update lastConditionState on each check', () => {
        const watcher = createTestWatcher();
        // Check with true
        state.evaluate(watcher, 'session-1', 'error', true);
        expect(state.getLastConditionState('watcher-1', 'session-1')).toBe(true);
        // Check with false
        state.evaluate(watcher, 'session-1', 'no error', false);
        expect(state.getLastConditionState('watcher-1', 'session-1')).toBe(false);
      });

      it('should return viewportHash in result', () => {
        const watcher = createTestWatcher();
        const result = state.evaluate(watcher, 'session-1', 'test content', true);
        expect(result.viewportHash).toHaveLength(16);
      });

      it('should set lastTriggeredHash when triggering', () => {
        const watcher = createTestWatcher();
        const result = state.evaluate(watcher, 'session-1', 'error', true);
        expect(state.getLastTriggeredHash('watcher-1', 'session-1')).toBe(result.viewportHash);
      });
    });

    describe('condition not matched', () => {
      it('should return shouldTrigger=false when condition not matched', () => {
        const watcher = createTestWatcher();
        const result = state.evaluate(watcher, 'session-1', 'no match', false);
        expect(result.shouldTrigger).toBe(false);
      });

      it('should still return viewportHash even when not triggering', () => {
        const watcher = createTestWatcher();
        const result = state.evaluate(watcher, 'session-1', 'no match', false);
        expect(result.viewportHash).toHaveLength(16);
      });
    });

    describe('isolation between sessions', () => {
      it('should maintain separate state for different sessions', () => {
        const watcher = createTestWatcher({ cooldownMode: 'until_clear' });
        // Trigger for session-1
        state.evaluate(watcher, 'session-1', 'error', true);
        // Trigger for session-2 should work independently
        const result = state.evaluate(watcher, 'session-2', 'error', true);
        expect(result.shouldTrigger).toBe(true);
      });
    });
  });

  describe('lastConditionState state-ordering (edge characterization)', () => {
    it('updates lastConditionState on a cooldown-suppressed evaluation (time mode)', () => {
      const watcher = createTestWatcher({ cooldownMode: 'time', cooldownMs: 100000 });

      state.evaluate(watcher, 'session-1', 'error', true);
      expect(state.getLastConditionState('watcher-1', 'session-1')).toBe(true);

      // Within cooldown: no trigger fires, but the false condition is still
      // recorded — the state write precedes the trigger decision branch.
      const result = state.evaluate(watcher, 'session-1', 'all clear', false);
      expect(result.shouldTrigger).toBe(false);
      expect(state.getLastConditionState('watcher-1', 'session-1')).toBe(false);
    });

    it('updates lastConditionState on a hold-window-suppressed evaluation (until_clear mode)', () => {
      const watcher = createTestWatcher({ cooldownMode: 'until_clear', cooldownMs: 100000 });

      // eval1: false->true triggers; state flips to true and the hold window opens.
      state.evaluate(watcher, 'session-1', 'error one', true);
      expect(state.getLastConditionState('watcher-1', 'session-1')).toBe(true);

      // eval2: condition false, but the hold window is still active so the cooldown
      // is NOT cleared and no trigger fires. lastConditionState must still flip to
      // false — proving the unconditional write at the top of every evaluation.
      const result = state.evaluate(watcher, 'session-1', 'clear', false);
      expect(result.shouldTrigger).toBe(false);
      expect(state.getLastConditionState('watcher-1', 'session-1')).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((state as any).cooldowns.has('watcher-1:session-1')).toBe(true);
    });
  });

  describe('incrementTriggerCount ordering', () => {
    it('evaluate does not increment the trigger count (increment stays the caller responsibility)', () => {
      const watcher = createTestWatcher();
      const result = state.evaluate(watcher, 'session-1', 'error content', true);

      // evaluate approved the trigger but must NOT bump the count — the runner
      // increments only after shouldTrigger=true and before publishing the event.
      expect(result.shouldTrigger).toBe(true);
      expect(state.getTriggerCount('watcher-1', 'session-1')).toBe(0);
    });

    it('incrementTriggerCount bumps the count and returns the new value', () => {
      expect(state.incrementTriggerCount('watcher-1', 'session-1')).toBe(1);
      expect(state.incrementTriggerCount('watcher-1', 'session-1')).toBe(2);
      expect(state.getTriggerCount('watcher-1', 'session-1')).toBe(2);
    });
  });

  describe('clearForWatcher', () => {
    it('removes only the state for the given watcher (prefix match)', () => {
      const w1 = createTestWatcher({ id: 'watcher-1' });
      const w2 = createTestWatcher({ id: 'watcher-2' });

      state.evaluate(w1, 'session-1', 'error', true);
      state.evaluate(w2, 'session-1', 'error', true);
      state.incrementTriggerCount('watcher-1', 'session-1');
      state.incrementTriggerCount('watcher-2', 'session-1');

      expect(state.getLastConditionState('watcher-1', 'session-1')).toBe(true);
      expect(state.getLastConditionState('watcher-2', 'session-1')).toBe(true);

      state.clearForWatcher('watcher-1');

      expect(state.getLastConditionState('watcher-1', 'session-1')).toBeUndefined();
      expect(state.getLastTriggeredHash('watcher-1', 'session-1')).toBeUndefined();
      expect(state.getTriggerCount('watcher-1', 'session-1')).toBe(0);
      expect(state.isOnCooldown('watcher-1', 'session-1')).toBe(false);

      // watcher-2 state is untouched
      expect(state.getLastConditionState('watcher-2', 'session-1')).toBe(true);
      expect(state.getTriggerCount('watcher-2', 'session-1')).toBe(1);
    });

    it('clears state for every session of the watcher', () => {
      const watcher = createTestWatcher();
      state.evaluate(watcher, 'session-1', 'error', true);
      state.evaluate(watcher, 'session-2', 'error', true);

      state.clearForWatcher('watcher-1');

      expect(state.getLastConditionState('watcher-1', 'session-1')).toBeUndefined();
      expect(state.getLastConditionState('watcher-1', 'session-2')).toBeUndefined();
    });

    it('is a no-op for an unknown watcher', () => {
      expect(() => state.clearForWatcher('never-seen')).not.toThrow();
    });
  });
});
