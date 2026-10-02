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
  isAutoCompactCapable: () => false,
  isHookCapable: () => false,
  isProjectProvisioningCapable: () => false,
}));

jest.mock('../../utils/tmux-naming.util', () => ({
  buildTmuxSessionName: (...args: string[]) => `tmux-${args.join('-')}`,
}));

// ── Imports ────────────────────────────────────────────────────────────

import {
  createRestorePipelineHarness,
  fakeProfileProviderConfig,
  fakeProvider,
} from './__test-utils__/pipeline-harness';
import { ConflictError, ValidationError } from '../../../../common/errors/error-types';
import { TerminalStreamService } from '../../../terminal/services/terminal-stream.service';
import type { MetricsService } from '../../../metrics/services/metrics.service';

// ── Tests ──────────────────────────────────────────────────────────────

describe('SessionRestorePipeline', () => {
  const sessionId = 'session-1';
  const projectId = 'project-1';

  describe('prepared provider runtime', () => {
    it('plans before flip and materializes after flip but before tmux creation', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();

      await pipeline.restore(sessionId, projectId);

      expect(mocks.providerRuntimePreparation.createPlan.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.updateStmt.run.mock.invocationCallOrder[0],
      );
      expect(mocks.updateStmt.run.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.providerRuntimePreparation.materialize.mock.invocationCallOrder[0],
      );
      expect(mocks.providerRuntimePreparation.materialize.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.terminalIO.createEmptySession.mock.invocationCallOrder[0],
      );
    });

    it('runs acknowledgement after the command and before session.restored', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();

      await pipeline.restore(sessionId, projectId);

      const restoredCall = mocks.eventsService.publish.mock.calls.findIndex(
        ([event]: [string]) => event === 'session.restored',
      );
      expect(mocks.terminalIO.typeCommand.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.preparedProviderRuntime.afterCommand.mock.invocationCallOrder[0],
      );
      expect(mocks.preparedProviderRuntime.afterCommand.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.eventsService.publish.mock.invocationCallOrder[restoredCall],
      );
    });

    it('destroys tmux before provider-runtime rollback when acknowledgement fails', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();
      mocks.preparedProviderRuntime.afterCommand.mockRejectedValue(new Error('foreign ack'));

      await expect(pipeline.restore(sessionId, projectId)).rejects.toThrow('foreign ack');

      expect(mocks.terminalIO.destroyExpectedSession).toHaveBeenCalled();
      expect(mocks.preparedProviderRuntime.rollback).toHaveBeenCalled();
      expect(mocks.terminalIO.destroyExpectedSession.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.preparedProviderRuntime.rollback.mock.invocationCallOrder[0],
      );
    });

    it('does not flip, create tmux, or publish success when planning fails', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();
      mocks.providerRuntimePreparation.createPlan.mockRejectedValue(new Error('planning failed'));

      await expect(pipeline.restore(sessionId, projectId)).rejects.toThrow('planning failed');

      expect(mocks.updateStmt.run).not.toHaveBeenCalled();
      expect(mocks.providerRuntimePreparation.materialize).not.toHaveBeenCalled();
      expect(mocks.terminalIO.createEmptySession).not.toHaveBeenCalled();
      expect(mocks.eventsService.publish).not.toHaveBeenCalledWith(
        'session.restored',
        expect.anything(),
      );
    });

    it('restores the prior row without creating tmux when materialization fails', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();
      mocks.providerRuntimePreparation.materialize.mockRejectedValue(
        new Error('materialization failed'),
      );

      await expect(pipeline.restore(sessionId, projectId)).rejects.toThrow(
        'materialization failed',
      );

      expect(mocks.updateStmt.run).toHaveBeenCalledTimes(2);
      expect(mocks.updateStmt.run).toHaveBeenLastCalledWith(
        'stopped',
        '2025-01-01T01:00:00Z',
        null,
        expect.any(String),
        sessionId,
      );
      expect(mocks.terminalIO.createEmptySession).not.toHaveBeenCalled();
      expect(mocks.eventsService.publish).not.toHaveBeenCalledWith(
        'session.restored',
        expect.anything(),
      );
    });
  });

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
      expect(mocks.terminalIO.destroyExpectedSession).toHaveBeenCalledWith(expect.any(Object), {
        onUnknownError: 'retire',
      });

      // Status flipped back
      const statusFlipBacks = runCalls.filter(
        (c) => c.sql.includes('UPDATE sessions') && c.args.includes('stopped'),
      );
      expect(statusFlipBacks.length).toBeGreaterThanOrEqual(1);
    });

    it('rolls back registry, tmux, provider runtime, durable row, then replay retention', async () => {
      const { pipeline, createTrackedPrepare, mocks } = createRestorePipelineHarness();
      const order: string[] = [];
      const trackedPrepare = createTrackedPrepare();
      mocks.sqliteMock.prepare.mockImplementation((sql: string) => {
        const statement = trackedPrepare(sql);
        const run = statement.run;
        return {
          ...statement,
          run: jest.fn((...args: unknown[]) => {
            if (args.includes('stopped')) order.push('durable');
            return run(...args);
          }),
        };
      });
      mocks.streamService.cancelScheduledClear.mockReturnValue(60_000);
      mocks.streamService.scheduleClear.mockImplementation(() => order.push('retention'));
      mocks.terminalSessionRegistry.dispose.mockImplementation(() => order.push('registry'));
      mocks.terminalIO.destroyExpectedSession.mockImplementation(async () => {
        order.push('tmux');
        return { outcome: 'destroyed' };
      });
      mocks.preparedProviderRuntime.rollback.mockImplementation(async () => {
        order.push('provider');
      });
      mocks.terminalIO.typeCommand.mockRejectedValue(new Error('send-keys failed'));

      await expect(pipeline.restore(sessionId, projectId)).rejects.toThrow('send-keys failed');

      expect(order).toEqual(['registry', 'tmux', 'provider', 'durable', 'retention']);
    });
  });

  // Scenario 7: Call ordering — registry.create before typeCommand
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
  // session-terminal-runtime.service.spec.ts → getDescriptor.
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

  // Scenario 10: opencode restore — verifies the ses_ provider_session_id
  // threads from the DB row through provider runtime planning into the typed restore
  // command, and that a missing id fails clearly (NO_PROVIDER_SESSION_ID) with
  // zero side effects — never a silent wrong-session attach. The opencode
  // `--session` arg-building itself is covered by opencode.adapter.spec.ts
  // (providerSessionIdRequiredForRestore = true); this block proves the
  // pipeline seam that hands that id to the adapter contract.
  describe('Scenario 10: opencode restore — ses_ threading & missing-id gating', () => {
    it('passes the stored ses_ provider_session_id into planning with mode=restore', async () => {
      const { pipeline, stoppedSessionRow, mocks } = createRestorePipelineHarness();

      const sesId = 'ses_opencode-abc-123';
      stoppedSessionRow.provider_session_id = sesId;

      await pipeline.restore(sessionId, projectId);

      expect(mocks.providerRuntimePreparation.createPlan).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'restore', providerSessionId: sesId }),
      );
    });

    it('types the restore command carrying the ses_ id into tmux and completes restore', async () => {
      const { pipeline, stoppedSessionRow, mocks } = createRestorePipelineHarness();
      const sesId = 'ses_opencode-abc-123';
      stoppedSessionRow.provider_session_id = sesId;
      mocks.preparedProviderRuntime.config.commandArgs = ['test-provider', '--resume', sesId];

      await pipeline.restore(sessionId, projectId);

      // The prepared runtime supplies the exact command, including the stored identity.
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
      mocks.providerRuntimePreparation.createPlan.mockRejectedValueOnce(
        new ValidationError(
          'Restore argv does not include provider session ID — adapter contract violation',
        ),
      );

      await expect(pipeline.restore(sessionId, projectId)).rejects.toThrow(ValidationError);

      // Planning rejects the adapter contract before flipToRunning — zero side effects.
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
  // The watcher's own consumption of payload.providerSessionId is covered by
  // transcript-watcher specs; this proves the
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

  // Scenario 12: a stale registry entry (tmux died but the entry was never
  // disposed — e.g. flipped to stopped by the orphan reconciler) must not
  // block restore with "TerminalSession already exists".
  describe('Scenario 12: stale registry entry — disposed, restore proceeds', () => {
    it('disposes the stale entry (and its streaming) before creating a fresh one', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();
      mocks.terminalSessionRegistry.get.mockReturnValue({ sessionId });

      const callOrder: string[] = [];
      mocks.terminalSessionRegistry.dispose.mockImplementation(() => callOrder.push('dispose'));
      mocks.terminalSessionRegistry.create.mockImplementation(() => callOrder.push('create'));

      await pipeline.restore(sessionId, projectId);

      expect(mocks.ptyService.stopStreaming).toHaveBeenCalledWith(sessionId);
      expect(mocks.terminalSessionRegistry.dispose).toHaveBeenCalledWith(sessionId);
      expect(callOrder).toEqual(['dispose', 'create']);
    });

    it('does not dispose anything when no stale entry exists', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();

      await pipeline.restore(sessionId, projectId);

      expect(mocks.terminalSessionRegistry.dispose).not.toHaveBeenCalled();
      expect(mocks.ptyService.stopStreaming).not.toHaveBeenCalled();
    });
  });

  // Scenario 9: stopped-session replay retention is cancelled SYNCHRONOUSLY at restore start.
  describe('Scenario 9: replay retention cancelled synchronously at restore start', () => {
    function realStreamService() {
      const metricsService = { registerStatsProvider: jest.fn() } as unknown as MetricsService;
      return new TerminalStreamService(metricsService);
    }

    it('cancels the replay clear before the first buffer-producing await', async () => {
      const streamService = {
        scheduleClear: jest.fn(),
        cancelScheduledClear: jest.fn().mockReturnValue(60000),
        setClearExpiryHandler: jest.fn(),
      };
      const { pipeline, mocks } = createRestorePipelineHarness({ streamService });

      await pipeline.restore(sessionId, projectId);

      expect(streamService.cancelScheduledClear).toHaveBeenCalledWith(sessionId);
      // The cancel must precede createEmptySession (the first buffer-producing await): the whole
      // point is that no awaited/buffer work runs while the retention timer is still armed.
      const cancelOrder = streamService.cancelScheduledClear.mock.invocationCallOrder[0];
      const createOrder = mocks.terminalIO.createEmptySession.mock.invocationCallOrder[0];
      expect(cancelOrder).toBeLessThan(createOrder);
    });

    it('holds the restore across the retention deadline with early output and keeps the active buffer/epoch', async () => {
      jest.useFakeTimers();
      try {
        const streamService = realStreamService();
        // A stopped session in the retention window: early PTY output was buffered under epoch A and
        // the stop armed a 60s clear.
        streamService.initializeBuffer(sessionId);
        streamService.addFrame(sessionId, 'early-pty-output');
        const epochBefore = streamService.getSequenceEpoch(sessionId);
        streamService.scheduleClear(sessionId, 60000);

        const { pipeline, mocks } = createRestorePipelineHarness({ streamService });
        // Hold the pipeline across the deadline: the first buffer-producing await elapses past 60s.
        mocks.terminalIO.createEmptySession.mockImplementation(async () => {
          jest.advanceTimersByTime(60001);
        });

        await pipeline.restore(sessionId, projectId);

        // The delayed cleanup must NOT have cleared the domain we restored into: same epoch retained,
        // buffer intact, and no clear still pending.
        expect(streamService.getSequenceEpoch(sessionId)).toBe(epochBefore);
        expect(streamService.getBufferStats(sessionId)).not.toBeNull();
        expect(streamService.hasScheduledClear(sessionId)).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it('re-arms the replay retention when the restore fails after cancelling it', async () => {
      jest.useFakeTimers();
      try {
        const streamService = realStreamService();
        streamService.initializeBuffer(sessionId);
        streamService.addFrame(sessionId, 'early-pty-output');
        streamService.scheduleClear(sessionId, 60000);

        const { pipeline, mocks } = createRestorePipelineHarness({ streamService });
        mocks.terminalIO.createEmptySession.mockRejectedValue(new Error('tmux server unavailable'));

        await expect(pipeline.restore(sessionId, projectId)).rejects.toThrow(
          'tmux server unavailable',
        );

        // Cancellation was undone on rollback (via the cleanup stack): retention is armed again and
        // still clears the buffer, so a failed restore does not retain the domain indefinitely.
        expect(streamService.hasScheduledClear(sessionId)).toBe(true);
        jest.advanceTimersByTime(60000);
        expect(streamService.getBufferStats(sessionId)).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // Restore shares launch's MCP drift repair (ensureMcpReadiness).
  describe('MCP registration check (shared with launch)', () => {
    const preflightWithMcp = (mcpStatus: 'pass' | 'fail', mcpMessage?: string) => ({
      overall: 'pass',
      checks: [],
      providers: [{ id: 'provider-1', mcpStatus, ...(mcpMessage ? { mcpMessage } : {}) }],
    });

    it('repairs drift through the full ensureMcp with the merged provider and config env, then completes', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();
      mocks.storage.getProviderEnvForProject.mockReturnValue({
        PROVIDER_ONLY: 'provider',
        SHARED: 'provider',
      });
      mocks.storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        fakeProfileProviderConfig({
          env: { CONFIG_ONLY: 'config', SHARED: 'config' },
        }),
      ]);
      mocks.preflightService.runChecks
        .mockResolvedValueOnce(preflightWithMcp('fail', 'not registered'))
        .mockResolvedValue(preflightWithMcp('pass'));

      await pipeline.restore(sessionId, projectId);

      const provider = await mocks.storage.getProvider.mock.results[0].value;
      expect(mocks.mcpEnsureService.ensureMcp).toHaveBeenCalledTimes(1);
      expect(mocks.mcpEnsureService.ensureMcp).toHaveBeenCalledWith(provider, '/tmp/project', {
        env: { PROVIDER_ONLY: 'provider', CONFIG_ONLY: 'config', SHARED: 'config' },
      });
      expect(mocks.mcpEnsureService.ensureProjectProvisioning).not.toHaveBeenCalled();
      expect(mocks.eventsService.publish).toHaveBeenCalledWith(
        'session.restored',
        expect.objectContaining({ sessionId }),
      );
    });

    it('makes no repair when preflight reports mcpStatus pass', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();

      await pipeline.restore(sessionId, projectId);

      expect(mocks.preflightService.runChecks).toHaveBeenCalledTimes(1);
      expect(mocks.mcpEnsureService.ensureMcp).not.toHaveBeenCalled();
      expect(mocks.mcpEnsureService.ensureProjectProvisioning).not.toHaveBeenCalled();
      expect(mocks.eventsService.publish).toHaveBeenCalledWith(
        'session.restored',
        expect.objectContaining({ sessionId }),
      );
    });

    it('stops with ValidationError, no tmux, unchanged row, and re-armed replay retention when the repair fails', async () => {
      const streamService = {
        scheduleClear: jest.fn(),
        cancelScheduledClear: jest.fn().mockReturnValue(60_000),
        setClearExpiryHandler: jest.fn(),
      };
      const { pipeline, mocks } = createRestorePipelineHarness({ streamService });
      mocks.preflightService.runChecks.mockResolvedValue(
        preflightWithMcp('fail', 'still not registered'),
      );

      await expect(pipeline.restore(sessionId, projectId)).rejects.toThrow(
        'MCP configuration failed after auto-ensure',
      );

      expect(mocks.mcpEnsureService.ensureMcp).toHaveBeenCalledTimes(1);
      expect(mocks.terminalIO.createEmptySession).not.toHaveBeenCalled();
      expect(mocks.terminalIO.typeCommand).not.toHaveBeenCalled();
      expect(mocks.updateStmt.run).not.toHaveBeenCalled();
      expect(mocks.eventsService.publish).not.toHaveBeenCalledWith(
        'session.restored',
        expect.anything(),
      );
      expect(streamService.scheduleClear).toHaveBeenCalledWith(sessionId, 60_000);
    });

    it('runs the MCP repair before createPlan and before the session row update', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();
      mocks.preflightService.runChecks
        .mockResolvedValueOnce(preflightWithMcp('fail', 'not registered'))
        .mockResolvedValue(preflightWithMcp('pass'));

      await pipeline.restore(sessionId, projectId);

      const repairOrder = mocks.mcpEnsureService.ensureMcp.mock.invocationCallOrder[0];
      expect(repairOrder).toBeLessThan(
        mocks.providerRuntimePreparation.createPlan.mock.invocationCallOrder[0],
      );
      expect(repairOrder).toBeLessThan(mocks.updateStmt.run.mock.invocationCallOrder[0]);
    });
  });
});
