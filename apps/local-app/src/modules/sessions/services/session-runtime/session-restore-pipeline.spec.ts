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
import { ConflictError, ValidationError } from '../../../../common/errors/error-types';
import { resolve as resolveLaunchConfig } from '../provider-launch-config';

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

  // Per-provider alternate-screen policy — restore matrix.
  // Restore MUST apply the same alt-screen policy as launch (the tmux window is
  // freshly created on restore too). This is GATE 1 of the two-gate invariant;
  // the PTY strip (GATE 2) reads the SAME adapter field — see
  // sessions.service.spec.ts → usesAlternateScreenFor.
  // Layer: pipeline unit test with the shared restore harness.
  describe('per-provider alternate-screen policy (restore matrix)', () => {
    it('enables alternate-screen for a full-screen TUI adapter (usesAlternateScreen: true)', async () => {
      const { pipeline, createTrackedPrepare, mocks } = createRestorePipelineHarness();
      mocks.sqliteMock.prepare.mockImplementation(createTrackedPrepare());
      (
        mocks.adapter as { terminalOutputBehavior?: { usesAlternateScreen: boolean } }
      ).terminalOutputBehavior = { usesAlternateScreen: true };

      await pipeline.restore(sessionId, projectId);

      expect(mocks.terminalIO.setAlternateScreen).toHaveBeenCalledTimes(1);
      expect(mocks.terminalIO.setAlternateScreen).toHaveBeenCalledWith(
        { name: expect.any(String) },
        true,
      );
    });

    it('suppresses alternate-screen by default (adapter has no terminalOutputBehavior)', async () => {
      const { pipeline, createTrackedPrepare, mocks } = createRestorePipelineHarness();
      mocks.sqliteMock.prepare.mockImplementation(createTrackedPrepare());

      await pipeline.restore(sessionId, projectId);

      expect(mocks.terminalIO.setAlternateScreen).toHaveBeenCalledTimes(1);
      expect(mocks.terminalIO.setAlternateScreen).toHaveBeenCalledWith(
        { name: expect.any(String) },
        false,
      );
    });

    it('suppresses alternate-screen when the adapter explicitly opts out (usesAlternateScreen: false)', async () => {
      const { pipeline, createTrackedPrepare, mocks } = createRestorePipelineHarness();
      mocks.sqliteMock.prepare.mockImplementation(createTrackedPrepare());
      (
        mocks.adapter as { terminalOutputBehavior?: { usesAlternateScreen: boolean } }
      ).terminalOutputBehavior = { usesAlternateScreen: false };

      await pipeline.restore(sessionId, projectId);

      expect(mocks.terminalIO.setAlternateScreen).toHaveBeenCalledWith(
        { name: expect.any(String) },
        false,
      );
    });

    it('sets alternate-screen AFTER creating the tmux session (ordering — window option needs a target)', async () => {
      const { pipeline, createTrackedPrepare, mocks } = createRestorePipelineHarness();
      mocks.sqliteMock.prepare.mockImplementation(createTrackedPrepare());

      await pipeline.restore(sessionId, projectId);

      const createOrder = mocks.terminalIO.createEmptySession.mock.invocationCallOrder[0];
      const altOrder = mocks.terminalIO.setAlternateScreen.mock.invocationCallOrder[0];
      expect(altOrder).toBeGreaterThan(createOrder);
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

  describe('provider env scope filtering', () => {
    it('calls getProviderEnvForProject with provider.id and projectId', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();

      mocks.storage.getProviderEnvForProject.mockReturnValue({ FILTERED_KEY: 'filtered-value' });

      await pipeline.restore(sessionId, projectId);

      expect(mocks.storage.getProviderEnvForProject).toHaveBeenCalledWith(
        'provider-1',
        'project-1',
      );
    });

    it('passes filtered env to resolveLaunchConfig instead of raw provider.env', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;

      const filteredEnv = { SCOPED_KEY: 'scoped-value' };
      mocks.storage.getProviderEnvForProject.mockReturnValue(filteredEnv);

      await pipeline.restore(sessionId, projectId);

      expect(resolveMock).toHaveBeenCalledWith(
        expect.objectContaining({ providerEnv: filteredEnv }),
      );
    });
  });

  // Scenario 10: opencode restore — verifies the ses_ provider_session_id
  // threads from the DB row through resolveLaunchConfig into the typed restore
  // command, and that a missing id fails clearly (NO_PROVIDER_SESSION_ID) with
  // zero side effects — never a silent wrong-session attach. The opencode
  // `--session` arg-building itself is covered by opencode.adapter.spec.ts
  // (providerSessionIdRequiredForRestore = true); this block proves the
  // pipeline seam that hands that id to the adapter contract.
  describe('Scenario 10: opencode restore — ses_ threading & missing-id gating', () => {
    it('passes the stored ses_ provider_session_id into resolveLaunchConfig with mode=restore', async () => {
      const { pipeline, stoppedSessionRow } = createRestorePipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;
      resolveMock.mockClear();

      const sesId = 'ses_opencode-abc-123';
      stoppedSessionRow.provider_session_id = sesId;

      await pipeline.restore(sessionId, projectId);

      expect(resolveMock).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'restore', providerSessionId: sesId }),
      );
    });

    it('types the restore command carrying the ses_ id into tmux and completes restore', async () => {
      const { pipeline, stoppedSessionRow, mocks } = createRestorePipelineHarness();
      const sesId = 'ses_opencode-abc-123';
      stoppedSessionRow.provider_session_id = sesId;

      await pipeline.restore(sessionId, projectId);

      // resolve mock yields ['test-provider', '--resume', sesId]; the pipeline
      // types exactly that argv — proving the correct ses_ reaches the command.
      expect(mocks.terminalIO.typeCommand).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([sesId]),
      );
      // argv-includes guard passed → restore completed, correct session reattached
      expect(mocks.eventsService.publish).toHaveBeenCalledWith(
        'session.restored',
        expect.objectContaining({ sessionId }),
      );
    });

    it('throws ConflictError(NO_PROVIDER_SESSION_ID) with zero side effects when the id is missing', async () => {
      const { pipeline, stoppedSessionRow, mocks } = createRestorePipelineHarness();
      stoppedSessionRow.provider_session_id = null;

      let caught: unknown;
      try {
        await pipeline.restore(sessionId, projectId);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(ConflictError);
      expect((caught as ConflictError).details).toMatchObject({
        code: 'NO_PROVIDER_SESSION_ID',
      });

      // Clear failure before any side effect — no wrong session can attach.
      expect(mocks.terminalIO.createEmptySession).not.toHaveBeenCalled();
      expect(mocks.terminalIO.typeCommand).not.toHaveBeenCalled();
      expect(mocks.updateStmt.run).not.toHaveBeenCalled();
      expect(mocks.eventsService.publish).not.toHaveBeenCalledWith(
        'session.restored',
        expect.anything(),
      );
    });

    it('throws ValidationError when restore argv omits the provider_session_id (no silent attach)', async () => {
      const { pipeline, stoppedSessionRow, mocks } = createRestorePipelineHarness();
      stoppedSessionRow.provider_session_id = 'ses_opencode-guard';
      const resolveMock = resolveLaunchConfig as jest.Mock;
      // Adapter/resolve contract violation: argv drops the provider session id.
      resolveMock.mockImplementationOnce(() => ({
        argv: ['opencode'],
        commandArgs: ['opencode'],
        env: null,
      }));

      await expect(pipeline.restore(sessionId, projectId)).rejects.toThrow(ValidationError);

      // The pipeline's own guard (L137-142) fires before flipToRunning — zero side effects.
      expect(mocks.terminalIO.createEmptySession).not.toHaveBeenCalled();
      expect(mocks.terminalIO.typeCommand).not.toHaveBeenCalled();
      expect(mocks.updateStmt.run).not.toHaveBeenCalled();
      expect(mocks.eventsService.publish).not.toHaveBeenCalledWith(
        'session.restored',
        expect.anything(),
      );
    });
  });

  // Scenario 11: restore re-emits providerSessionId in the discovered event.
  // DB-source watchers (agy/opencode) SKIP without it (transcript-watcher.service.ts DB
  // branch), so a restored DB conversation would otherwise never receive live updates.
  // This is the Phase-1 DoD "restore + live-update" seam. The watcher's own consumption of
  // payload.providerSessionId is covered by transcript-watcher specs; this proves the
  // restore pipeline threads the id into the event.
  describe('Scenario 11: discovered event re-emits providerSessionId (DB-source watcher fix)', () => {
    it('includes providerSessionId from the session row in session.transcript.discovered', async () => {
      const { pipeline, stoppedSessionRow, mocks } = createRestorePipelineHarness();
      // A transcript_path is required for the discovered event to fire at all.
      stoppedSessionRow.transcript_path = '/tmp/project/.devchain/transcripts/ses_agy.db';
      const sesId = 'ses_agy-restore-123';
      stoppedSessionRow.provider_session_id = sesId;

      await pipeline.restore(sessionId, projectId);

      expect(mocks.eventsService.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({
          sessionId,
          transcriptPath: '/tmp/project/.devchain/transcripts/ses_agy.db',
          providerSessionId: sesId,
          providerName: 'test-provider',
        }),
      );
    });

    it('does not emit session.transcript.discovered when transcript_path is absent', async () => {
      const { pipeline, stoppedSessionRow, mocks } = createRestorePipelineHarness();
      stoppedSessionRow.transcript_path = null;

      await pipeline.restore(sessionId, projectId);

      expect(mocks.eventsService.publish).not.toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.anything(),
      );
    });
  });
});
