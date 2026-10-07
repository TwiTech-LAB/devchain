/**
 * Tests for the composite restart-key convention for local agents.
 *
 * pendingRestartAgentIds is a Set<string> keyed by `restartKeyForMain(agentId)`
 * (`:{agentId}`), so a plain agentId never matches and distinct agents stay
 * independent.
 */
import { restartKeyForMain } from '@/ui/lib/restart-keys';

describe('restart composite key (local agents)', () => {
  it('uses the `:agentId` format', () => {
    expect(restartKeyForMain('agent-1')).toBe(':agent-1');
  });
});
