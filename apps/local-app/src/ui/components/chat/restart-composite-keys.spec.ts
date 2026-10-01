/**
 * Tests for the composite restart-key convention for local agents.
 *
 * pendingRestartAgentIds is a Set<string> keyed by `restartKeyForMain(agentId)`
 * (`:{agentId}`), so a plain agentId never matches and distinct agents stay
 * independent.
 */
import { restartKeyForMain } from '@/ui/lib/restart-keys';

describe('restart composite key (local agents)', () => {
  function createRestartSet(keys: string[]): Set<string> {
    return new Set(keys);
  }

  it('uses the `:agentId` format', () => {
    expect(restartKeyForMain('agent-1')).toBe(':agent-1');
  });

  it('does not match a plain agentId (old format)', () => {
    const set = createRestartSet([restartKeyForMain('agent-1')]);
    expect(set.has(restartKeyForMain('agent-1'))).toBe(true);
    expect(set.has('agent-1')).toBe(false);
  });

  it('keeps distinct agents independent', () => {
    const set = createRestartSet([restartKeyForMain('agent-1'), restartKeyForMain('agent-2')]);
    expect(set.size).toBe(2);
  });

  it('preset apply maps online IDs to composite keys', () => {
    const onlineAgentIds = ['agent-1', 'agent-3'];
    expect(onlineAgentIds.map(restartKeyForMain)).toEqual([':agent-1', ':agent-3']);
  });

  it('clearPendingRestart removes only the targeted agent key', () => {
    const set = createRestartSet([restartKeyForMain('agent-1'), restartKeyForMain('agent-2')]);
    set.delete(restartKeyForMain('agent-1'));
    expect(set.has(restartKeyForMain('agent-1'))).toBe(false);
    expect(set.has(restartKeyForMain('agent-2'))).toBe(true);
  });
});
