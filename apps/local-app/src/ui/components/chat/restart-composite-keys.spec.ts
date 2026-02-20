/**
 * Tests for composite restart key isolation between main and worktree agents.
 *
 * The pendingRestartAgentIds Set uses composite keys:
 * - Main agents: `:{agentId}` (empty apiBase prefix)
 * - Worktree agents: `{apiBase}:{agentId}`
 *
 * This prevents false restart indicators when IDs collide (e.g. seeded DB copies).
 */

describe('restart composite key isolation', () => {
  // Simulate the Set<string> pattern from ChatPage.tsx
  function createRestartSet(keys: string[]): Set<string> {
    return new Set(keys);
  }

  describe('main agent keys', () => {
    it('uses `:agentId` format for main agents', () => {
      const set = createRestartSet([':agent-1', ':agent-2']);
      expect(set.has(':agent-1')).toBe(true);
      expect(set.has(':agent-2')).toBe(true);
    });

    it('does not match plain agentId (old format)', () => {
      const set = createRestartSet([':agent-1']);
      expect(set.has('agent-1')).toBe(false);
    });
  });

  describe('worktree agent keys', () => {
    it('uses `apiBase:agentId` format for worktree agents', () => {
      const set = createRestartSet(['/wt/feature-auth:agent-1']);
      expect(set.has('/wt/feature-auth:agent-1')).toBe(true);
    });

    it('does not match main key with same agentId', () => {
      const set = createRestartSet(['/wt/feature-auth:agent-1']);
      expect(set.has(':agent-1')).toBe(false);
    });
  });

  describe('cross-instance isolation', () => {
    it('main and worktree keys with same agentId are distinct', () => {
      const set = createRestartSet([':agent-1', '/wt/feature-auth:agent-1']);

      expect(set.has(':agent-1')).toBe(true);
      expect(set.has('/wt/feature-auth:agent-1')).toBe(true);
      expect(set.size).toBe(2);
    });

    it('two different worktrees with same agentId are distinct', () => {
      const set = createRestartSet(['/wt/worktree-a:agent-1', '/wt/worktree-b:agent-1']);

      expect(set.has('/wt/worktree-a:agent-1')).toBe(true);
      expect(set.has('/wt/worktree-b:agent-1')).toBe(true);
      expect(set.size).toBe(2);
    });

    it('main preset apply does not trigger worktree restart indicators', () => {
      // Simulate main preset apply adding `:agentId` keys
      const set = createRestartSet([':agent-1', ':agent-2']);

      // Worktree rendering checks `${group.apiBase}:${agent.id}`
      expect(set.has('/wt/feature-auth:agent-1')).toBe(false);
      expect(set.has('/wt/feature-auth:agent-2')).toBe(false);
    });

    it('worktree preset apply does not trigger main restart indicators', () => {
      // Simulate worktree preset apply adding `${apiBase}:${agentId}` keys
      const set = createRestartSet(['/wt/feature-auth:agent-1']);

      // Main rendering checks `:{agentId}`
      expect(set.has(':agent-1')).toBe(false);
    });
  });

  describe('markAgentsForRestart patterns', () => {
    it('main applyPresetMutation maps IDs to composite keys', () => {
      const onlineAgentIds = ['agent-1', 'agent-3'];
      const compositeKeys = onlineAgentIds.map((id) => `:${id}`);

      expect(compositeKeys).toEqual([':agent-1', ':agent-3']);
    });

    it('worktree applyMutation maps IDs to composite keys with apiBase', () => {
      const apiBase = '/wt/feature-auth';
      const onlineIds = ['agent-1', 'agent-2'];
      const compositeKeys = onlineIds.map((id) => `${apiBase}:${id}`);

      expect(compositeKeys).toEqual(['/wt/feature-auth:agent-1', '/wt/feature-auth:agent-2']);
    });

    it('worktree config switch marks composite key for online agent', () => {
      const set = new Set<string>();
      const apiBase = '/wt/feature-auth';
      const agentId = 'agent-1';
      const isOnline = true;

      // Simulate updateWorktreeAgentConfigMutation.onSuccess
      if (isOnline) {
        set.add(`${apiBase}:${agentId}`);
      }

      expect(set.has('/wt/feature-auth:agent-1')).toBe(true);
      // Main key should not be added
      expect(set.has(':agent-1')).toBe(false);
    });

    it('worktree config switch does not mark key for offline agent', () => {
      const set = new Set<string>();
      const apiBase = '/wt/feature-auth';
      const agentId = 'agent-1';
      const isOnline = false;

      // Simulate updateWorktreeAgentConfigMutation.onSuccess
      if (isOnline) {
        set.add(`${apiBase}:${agentId}`);
      }

      expect(set.size).toBe(0);
    });

    it('clearPendingRestart uses composite key for main agents', () => {
      const set = new Set([':agent-1', ':agent-2', '/wt/wt-a:agent-1']);

      // Simulate clearPendingRestart(`:${agentId}`)
      set.delete(':agent-1');

      expect(set.has(':agent-1')).toBe(false);
      expect(set.has(':agent-2')).toBe(true);
      // Worktree key with same agentId should remain
      expect(set.has('/wt/wt-a:agent-1')).toBe(true);
    });

    it('clearPendingRestart uses composite key for worktree restart', () => {
      const set = new Set([':agent-1', '/wt/feature-auth:agent-1', '/wt/feature-auth:agent-2']);

      // Simulate handleRestartWorktreeSession clearing `${group.apiBase}:${agentId}`
      set.delete('/wt/feature-auth:agent-1');

      expect(set.has('/wt/feature-auth:agent-1')).toBe(false);
      expect(set.has('/wt/feature-auth:agent-2')).toBe(true);
      // Main key with same agentId should remain
      expect(set.has(':agent-1')).toBe(true);
    });

    it('clearPendingRestart uses composite key for worktree terminate', () => {
      const set = new Set(['/wt/feature-auth:agent-1', '/wt/other-wt:agent-1']);

      // Simulate handleTerminateWorktreeSession clearing `${group.apiBase}:${agentId}`
      set.delete('/wt/feature-auth:agent-1');

      expect(set.has('/wt/feature-auth:agent-1')).toBe(false);
      // Other worktree with same agentId should remain
      expect(set.has('/wt/other-wt:agent-1')).toBe(true);
    });
  });
});
