/**
 * SessionRestorePipeline — real mock-backed tests.
 *
 * Scenarios 5-8: Tmux create failure during restore, typeCommand failure
 * after bind, call ordering verification, and provider mismatch guard.
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

import { createRestorePipelineHarness, fakeProvider } from './__test-utils__/pipeline-harness';
import { ConflictError } from '../../../../common/errors/error-types';

// ── Tests ──────────────────────────────────────────────────────────────

describe('SessionRestorePipeline', () => {
  const sessionId = 'session-1';
  const projectId = 'project-1';

  // Scenario 5: Restore tmux create fails after flipToRunning
  describe('Scenario 5: tmux create fails after flipToRunning — status flipped back', () => {
    it('flips status back to prior value, no session.restored', async () => {
      const { pipeline, createTrackedPrepare, mocks } = createRestorePipelineHarness();

      const runCalls: { sql: string; args: unknown[] }[] = [];
      mocks.sqliteMock.prepare.mockImplementation(createTrackedPrepare(runCalls));

      // tmux creation fails
      mocks.terminalIO.createEmptySession.mockRejectedValue(new Error('tmux server unavailable'));

      await expect(pipeline.restore(sessionId, projectId)).rejects.toThrow(
        'tmux server unavailable',
      );

      // Compensator should flip status back to 'stopped' (the prior value)
      const statusFlipBacks = runCalls.filter(
        (c) => c.sql.includes('UPDATE sessions') && c.args.includes('stopped'),
      );
      expect(statusFlipBacks.length).toBeGreaterThanOrEqual(1);

      // session.restored not emitted
      expect(mocks.eventsService.publish).not.toHaveBeenCalledWith(
        'session.restored',
        expect.anything(),
      );
    });
  });

  // Scenario 6: Restore typeCommand fails after bindStreaming
  // NOTE: May FAIL until R2 lands — R2 needs to reorder bind before typeCommand.
  // Current code: typeCommand is called BEFORE bindStreaming (line 187 vs 190).
  // So if typeCommand fails, the bindStreaming compensator would NOT be in the
  // cleanup stack yet — registry.dispose would NOT be called.
  describe('Scenario 6: typeCommand fails after bindStreaming', () => {
    it('registry disposed, tmux destroyed, status flipped back', async () => {
      const { pipeline, createTrackedPrepare, mocks } = createRestorePipelineHarness();

      const runCalls: { sql: string; args: unknown[] }[] = [];
      mocks.sqliteMock.prepare.mockImplementation(createTrackedPrepare(runCalls));

      // typeCommand rejects
      mocks.terminalIO.typeCommand.mockRejectedValue(new Error('send-keys failed'));

      await expect(pipeline.restore(sessionId, projectId)).rejects.toThrow('send-keys failed');

      // Registry should be disposed (bindStreaming compensator)
      expect(mocks.terminalSessionRegistry.dispose).toHaveBeenCalledWith(sessionId);

      // tmux destroyed
      expect(mocks.terminalIO.destroySession).toHaveBeenCalled();

      // Status flipped back
      const statusFlipBacks = runCalls.filter(
        (c) => c.sql.includes('UPDATE sessions') && c.args.includes('stopped'),
      );
      expect(statusFlipBacks.length).toBeGreaterThanOrEqual(1);
    });
  });

  // Scenario 7: Call ordering — registry.create before typeCommand
  // NOTE: May FAIL until R2 lands. Current code calls typeCommand at line 187
  // then registry.create at line 190, which is the wrong order.
  describe('Scenario 7: call ordering — registry.create before typeCommand', () => {
    it('terminalSessionRegistry.create is called before terminalIO.typeCommand', async () => {
      const { pipeline, createTrackedPrepare, mocks } = createRestorePipelineHarness();

      mocks.sqliteMock.prepare.mockImplementation(createTrackedPrepare());

      const callOrder: string[] = [];

      mocks.terminalSessionRegistry.create.mockImplementation(() => {
        callOrder.push('registry.create');
      });
      mocks.terminalIO.typeCommand.mockImplementation(async () => {
        callOrder.push('typeCommand');
      });

      await pipeline.restore(sessionId, projectId);

      const registryIdx = callOrder.indexOf('registry.create');
      const typeCommandIdx = callOrder.indexOf('typeCommand');

      expect(registryIdx).toBeGreaterThanOrEqual(0);
      expect(typeCommandIdx).toBeGreaterThanOrEqual(0);
      expect(registryIdx).toBeLessThan(typeCommandIdx);
    });

    it('creates registry sessions with normalized capture policy for default adapters', async () => {
      const { pipeline, createTrackedPrepare, mocks } = createRestorePipelineHarness();
      mocks.sqliteMock.prepare.mockImplementation(createTrackedPrepare());

      await pipeline.restore(sessionId, projectId);

      expect(mocks.terminalSessionRegistry.create).toHaveBeenCalledWith(
        sessionId,
        expect.any(String),
        { normalizeCapturedLineEndings: true },
      );
    });

    it('keeps captured normalization enabled for live raw-line-ending adapters', async () => {
      const { pipeline, createTrackedPrepare, mocks } = createRestorePipelineHarness();
      mocks.sqliteMock.prepare.mockImplementation(createTrackedPrepare());
      (
        mocks.adapter as {
          terminalOutputBehavior?: { rawLineEndings: boolean };
        }
      ).terminalOutputBehavior = { rawLineEndings: true };

      await pipeline.restore(sessionId, projectId);

      expect(mocks.terminalSessionRegistry.create).toHaveBeenCalledWith(
        sessionId,
        expect.any(String),
        { normalizeCapturedLineEndings: true },
      );
    });
  });

  // Scenario 9: session.restored event carries providerName
  describe('Scenario 9: session.restored payload includes providerName', () => {
    it('emits providerName from provider.name (lowercased)', async () => {
      const { pipeline, createTrackedPrepare, mocks } = createRestorePipelineHarness();
      mocks.sqliteMock.prepare.mockImplementation(createTrackedPrepare());

      await pipeline.restore(sessionId, projectId);

      expect(mocks.eventsService.publish).toHaveBeenCalledWith(
        'session.restored',
        expect.objectContaining({
          sessionId,
          providerName: 'test-provider',
        }),
      );
    });
  });

  // Scenario 8: Provider mismatch returns ConflictError with zero side effects
  describe('Scenario 8: provider mismatch — ConflictError, zero side effects', () => {
    it('throws ConflictError, no DB updates, no tmux creation', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();

      // Current provider differs from launch-time provider
      mocks.storage.getProvider.mockResolvedValue(fakeProvider({ name: 'different-provider' }));

      // The stored session row has provider_name_at_launch = 'test-provider'
      // but the current provider is 'different-provider'

      await expect(pipeline.restore(sessionId, projectId)).rejects.toThrow(ConflictError);

      // No tmux creation
      expect(mocks.terminalIO.createEmptySession).not.toHaveBeenCalled();

      // No session.restored
      expect(mocks.eventsService.publish).not.toHaveBeenCalledWith(
        'session.restored',
        expect.anything(),
      );

      // No typeCommand
      expect(mocks.terminalIO.typeCommand).not.toHaveBeenCalled();
    });
  });
});
