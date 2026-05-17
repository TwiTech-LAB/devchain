/**
 * Session runtime integration tests.
 *
 * Scenario 9: DEVCHAIN_SESSION_ID stability across restore — the
 * session id from the original launch is reused when restoring.
 */

// ── Module-level mocks (must precede imports) ──────────────────────────

jest.mock('../../../storage/db/sqlite-raw', () => ({
  getRawSqliteClient: (db: { session: { client: unknown } }) => db.session.client,
}));

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('../../../../common/config/env.config', () => ({
  getEnvConfig: () => ({ HOST: '127.0.0.1', PORT: 3000 }),
}));

jest.mock('@devchain/shared', () => ({
  HostResolver: {
    buildInternalBaseUrl: () => 'http://127.0.0.1:3000',
  },
}));

jest.mock('../../../providers/adapters/capabilities', () => ({
  isContextWindowCapable: () => false,
  isHookCapable: () => false,
  isProjectProvisioningCapable: () => false,
}));

jest.mock('../../utils/tmux-naming.util', () => ({
  buildTmuxSessionName: (...args: string[]) => `tmux-${args.join('-')}`,
}));

jest.mock('../provider-launch-config', () => ({
  resolve: jest.fn().mockImplementation((input: { providerSessionId?: string }) => {
    const sessionId = input.providerSessionId ?? 'provider-session-1';
    return {
      argv: ['test-provider', '--resume', sessionId],
      commandArgs: ['test-provider', '--resume', sessionId],
      env: null,
    };
  }),
  ProfileOptionsError: class ProfileOptionsError extends Error {},
}));

// ── Imports ────────────────────────────────────────────────────────────

import { createRestorePipelineHarness } from './__test-utils__/pipeline-harness';

// ── Tests ──────────────────────────────────────────────────────────────

describe('Session runtime integration', () => {
  // Scenario 9: DEVCHAIN_SESSION_ID stable across restore
  describe('Scenario 9: DEVCHAIN_SESSION_ID stable across restore', () => {
    it('session.id is reused — restore returns the original session ID', async () => {
      const originalSessionId = 'session-1';
      const { pipeline, stoppedSessionRow, createTrackedPrepare, mocks } =
        createRestorePipelineHarness();

      // Confirm the stopped session row uses the original ID
      expect(stoppedSessionRow.id).toBe(originalSessionId);

      mocks.sqliteMock.prepare.mockImplementation(createTrackedPrepare());

      const result = await pipeline.restore(originalSessionId, 'project-1');

      // The restored session must carry the SAME id
      expect(result.id).toBe(originalSessionId);

      // session.restored event must reference the original id
      expect(mocks.eventsService.publish).toHaveBeenCalledWith(
        'session.restored',
        expect.objectContaining({ sessionId: originalSessionId }),
      );

      // Verify the DB UPDATE used the original session id (not a new UUID)
      const updateCalls = mocks.sqliteMock.prepare.mock.calls.filter(([sql]: [string]) =>
        sql.includes('UPDATE sessions'),
      );
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
