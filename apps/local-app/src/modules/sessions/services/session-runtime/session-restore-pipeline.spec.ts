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
  ...jest.requireActual('@devchain/shared'),
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
import { beforeRollbackRecordId } from '../../../storage/sessions/session-row.store';

// ── Tests ──────────────────────────────────────────────────────────────

/** True for a row write that sets the status back to stopped, with positional or named params. */
function setsStopped(args: unknown[]): boolean {
  return args.some(
    (arg) => arg === 'stopped' || (arg as { status?: unknown } | null)?.status === 'stopped',
  );
}

describe('SessionRestorePipeline', () => {
  const sessionId = 'session-1';
  const projectId = 'project-1';
  const restoreRequest = {
    sessionId,
    projectId,
    admit: () => undefined,
    stopReplacement: async () => undefined,
  };

  // The pipeline owns the conflict response for both transports.
  it('rejects restore of a save point before starting a runtime', async () => {
    const { pipeline, stoppedSessionRow, mocks } = createRestorePipelineHarness();
    stoppedSessionRow.kind = 'save_point';

    await expect(pipeline.restore(restoreRequest)).rejects.toMatchObject({
      statusCode: 409,
      details: { code: 'SAVE_POINT_NOT_RESTORABLE' },
    });
    expect(mocks.terminalIO.createEmptySession).not.toHaveBeenCalled();
  });

  describe('prepared provider runtime', () => {
    it('plans before flip and materializes after flip but before tmux creation', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();

      await pipeline.restore(restoreRequest);

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

      await pipeline.restore(restoreRequest);

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

      await expect(pipeline.restore(restoreRequest)).rejects.toThrow('foreign ack');

      expect(mocks.terminalIO.destroyExpectedSession).toHaveBeenCalled();
      expect(mocks.preparedProviderRuntime.rollback).toHaveBeenCalled();
      expect(mocks.terminalIO.destroyExpectedSession.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.preparedProviderRuntime.rollback.mock.invocationCallOrder[0],
      );
    });

    it('does not flip, create tmux, or publish success when planning fails', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();
      mocks.providerRuntimePreparation.createPlan.mockRejectedValue(new Error('planning failed'));

      await expect(pipeline.restore(restoreRequest)).rejects.toThrow('planning failed');

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

      await expect(pipeline.restore(restoreRequest)).rejects.toThrow('materialization failed');

      expect(mocks.updateStmt.run).toHaveBeenCalledTimes(2);
      expect(mocks.updateStmt.run).toHaveBeenLastCalledWith(
        expect.objectContaining({
          owner: 'agent-1',
          status: 'stopped',
          endedAt: '2025-01-01T01:00:00Z',
          tmux: null,
          provider: 'test-provider',
          id: sessionId,
        }),
      );
      expect(mocks.terminalIO.createEmptySession).not.toHaveBeenCalled();
      expect(mocks.eventsService.publish).not.toHaveBeenCalledWith(
        'session.restored',
        expect.anything(),
      );
    });
  });

  // Scenario 5: Restore tmux create fails after flipToRunning
  describe('Vault', () => {
    it('restores with no Vault value in the runtime plan', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();

      await pipeline.restore(restoreRequest);

      const [planInput] = mocks.providerRuntimePreparation.createPlan.mock.calls[0];
      expect(planInput.mode).toBe('restore');
      expect(Object.keys(planInput).filter((key) => /vault/i.test(key))).toEqual([]);
    });
  });

  describe('Scenario 5: tmux create fails after flipToRunning — status flipped back', () => {
    it('flips status back to prior value, no session.restored', async () => {
      const { pipeline, createTrackedPrepare, mocks } = createRestorePipelineHarness();

      const runCalls: { sql: string; args: unknown[] }[] = [];
      mocks.sqliteMock.prepare.mockImplementation(createTrackedPrepare(runCalls));

      // tmux creation fails
      mocks.terminalIO.createEmptySession.mockRejectedValue(new Error('tmux server unavailable'));

      await expect(pipeline.restore(restoreRequest)).rejects.toThrow('tmux server unavailable');

      // Compensator should flip status back to 'stopped' (the prior value)
      const statusFlipBacks = runCalls.filter(
        (c) => c.sql.includes('UPDATE sessions') && setsStopped(c.args),
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

      await expect(pipeline.restore(restoreRequest)).rejects.toThrow('send-keys failed');

      // Registry should be disposed (bindStreaming compensator)
      expect(mocks.terminalSessionRegistry.dispose).toHaveBeenCalledWith(sessionId);

      // tmux destroyed
      expect(mocks.terminalIO.destroyExpectedSession).toHaveBeenCalledWith(expect.any(Object), {
        onUnknownError: 'retire',
      });

      // Status flipped back
      const statusFlipBacks = runCalls.filter(
        (c) => c.sql.includes('UPDATE sessions') && setsStopped(c.args),
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
            if (setsStopped(args)) order.push('durable');
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

      await expect(pipeline.restore(restoreRequest)).rejects.toThrow('send-keys failed');

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

      await pipeline.restore(restoreRequest);

      const registryIdx = callOrder.indexOf('registry.create');
      const typeCommandIdx = callOrder.indexOf('typeCommand');

      expect(registryIdx).toBeGreaterThanOrEqual(0);
      expect(typeCommandIdx).toBeGreaterThanOrEqual(0);
      expect(registryIdx).toBeLessThan(typeCommandIdx);
    });

    it('creates registry sessions with normalized capture policy for default adapters', async () => {
      const { pipeline, createTrackedPrepare, mocks } = createRestorePipelineHarness();
      mocks.sqliteMock.prepare.mockImplementation(createTrackedPrepare());

      await pipeline.restore(restoreRequest);

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

      await pipeline.restore(restoreRequest);

      expect(mocks.terminalIO.setAlternateScreen).toHaveBeenCalledTimes(1);
      expect(mocks.terminalIO.setAlternateScreen).toHaveBeenCalledWith(
        { name: expect.any(String) },
        true,
      );
    });

    it('suppresses alternate-screen by default (adapter has no terminalOutputBehavior)', async () => {
      const { pipeline, createTrackedPrepare, mocks } = createRestorePipelineHarness();
      mocks.sqliteMock.prepare.mockImplementation(createTrackedPrepare());

      await pipeline.restore(restoreRequest);

      expect(mocks.terminalIO.setAlternateScreen).toHaveBeenCalledTimes(1);
      expect(mocks.terminalIO.setAlternateScreen).toHaveBeenCalledWith(
        { name: expect.any(String) },
        false,
      );
    });

    it('sets alternate-screen AFTER creating the tmux session (ordering — window option needs a target)', async () => {
      const { pipeline, createTrackedPrepare, mocks } = createRestorePipelineHarness();
      mocks.sqliteMock.prepare.mockImplementation(createTrackedPrepare());

      await pipeline.restore(restoreRequest);

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

      await pipeline.restore(restoreRequest);

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

      await expect(pipeline.restore(restoreRequest)).rejects.toThrow(ConflictError);

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

      await pipeline.restore(restoreRequest);

      expect(mocks.providerRuntimePreparation.createPlan).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'restore', providerSessionId: sesId }),
      );
    });

    it('types the prepared launch line for the ses_ restore and completes restore', async () => {
      const { pipeline, stoppedSessionRow, mocks } = createRestorePipelineHarness();
      const sesId = 'ses_opencode-abc-123';
      stoppedSessionRow.provider_session_id = sesId;
      mocks.preparedProviderRuntime.config.commandArgs = ['test-provider', '--resume', sesId];

      await pipeline.restore(restoreRequest);

      // The prepared runtime's launch script carries the command with the stored identity.
      expect(mocks.terminalIO.typeCommand).toHaveBeenCalledWith(
        expect.anything(),
        mocks.preparedProviderRuntime.typedArgs,
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
        await pipeline.restore(restoreRequest);
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

      await expect(pipeline.restore(restoreRequest)).rejects.toThrow(ValidationError);

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

      await pipeline.restore(restoreRequest);

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

      await pipeline.restore(restoreRequest);

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

      await pipeline.restore(restoreRequest);

      expect(mocks.ptyService.stopStreaming).toHaveBeenCalledWith(sessionId);
      expect(mocks.terminalSessionRegistry.dispose).toHaveBeenCalledWith(sessionId);
      expect(callOrder).toEqual(['dispose', 'create']);
    });

    it('does not dispose anything when no stale entry exists', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();

      await pipeline.restore(restoreRequest);

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

    it('cancels the replay clear after the claim and before the first buffer-producing await', async () => {
      const streamService = {
        scheduleClear: jest.fn(),
        cancelScheduledClear: jest.fn().mockReturnValue(60000),
        setClearExpiryHandler: jest.fn(),
      };
      const { pipeline, mocks } = createRestorePipelineHarness({ streamService });

      await pipeline.restore(restoreRequest);

      expect(streamService.cancelScheduledClear).toHaveBeenCalledWith(sessionId);
      // The cancel must precede createEmptySession (the first buffer-producing await): the whole
      // point is that no awaited/buffer work runs while the retention timer is still armed.
      const cancelOrder = streamService.cancelScheduledClear.mock.invocationCallOrder[0];
      const createOrder = mocks.terminalIO.createEmptySession.mock.invocationCallOrder[0];
      expect(cancelOrder).toBeLessThan(createOrder);
      // Only a won claim may touch the buffer: a lost one belongs to the winner.
      expect(mocks.updateStmt.run.mock.invocationCallOrder[0]).toBeLessThan(cancelOrder);
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

        await pipeline.restore(restoreRequest);

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

        await expect(pipeline.restore(restoreRequest)).rejects.toThrow('tmux server unavailable');

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

      await pipeline.restore(restoreRequest);

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

      await pipeline.restore(restoreRequest);

      expect(mocks.preflightService.runChecks).toHaveBeenCalledTimes(1);
      expect(mocks.mcpEnsureService.ensureMcp).not.toHaveBeenCalled();
      expect(mocks.mcpEnsureService.ensureProjectProvisioning).not.toHaveBeenCalled();
      expect(mocks.eventsService.publish).toHaveBeenCalledWith(
        'session.restored',
        expect.objectContaining({ sessionId }),
      );
    });

    it('stops with ValidationError, no tmux, unchanged row, and an untouched replay clear when the repair fails', async () => {
      const streamService = {
        scheduleClear: jest.fn(),
        cancelScheduledClear: jest.fn().mockReturnValue(60_000),
        setClearExpiryHandler: jest.fn(),
      };
      const { pipeline, mocks } = createRestorePipelineHarness({ streamService });
      mocks.preflightService.runChecks.mockResolvedValue(
        preflightWithMcp('fail', 'still not registered'),
      );

      await expect(pipeline.restore(restoreRequest)).rejects.toThrow(
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
      // The clear is cancelled only after the claim, so a failure before it leaves the clear armed.
      expect(streamService.cancelScheduledClear).not.toHaveBeenCalled();
      expect(streamService.scheduleClear).not.toHaveBeenCalled();
    });

    it('runs the MCP repair before createPlan and before the session row update', async () => {
      const { pipeline, mocks } = createRestorePipelineHarness();
      mocks.preflightService.runChecks
        .mockResolvedValueOnce(preflightWithMcp('fail', 'not registered'))
        .mockResolvedValue(preflightWithMcp('pass'));

      await pipeline.restore(restoreRequest);

      const repairOrder = mocks.mcpEnsureService.ensureMcp.mock.invocationCallOrder[0];
      expect(repairOrder).toBeLessThan(
        mocks.providerRuntimePreparation.createPlan.mock.invocationCallOrder[0],
      );
      expect(repairOrder).toBeLessThan(mocks.updateStmt.run.mock.invocationCallOrder[0]);
    });
  });
  // Module unit layer: the pipeline owns the step order and the commit boundary; mocked
  // collaborators show which steps run on each side of it without a provider or tmux.
  describe('rollback', () => {
    const savePointId = 'save-point-1';
    const copy = { providerSessionId: 'copy-native', transcriptPath: '/test/copy.jsonl' };
    const request = (keepCurrent = true) => ({
      sessionId,
      projectId,
      savePointId,
      keepCurrent,
      admit: jest.fn(),
    });

    function rollbackHarness<TStream>(opts?: { streamService?: TStream }) {
      const harness = createRestorePipelineHarness(opts);
      const plan = {
        mode: 'fork',
        fork: copy,
        commitBoundTranscript: jest.fn().mockResolvedValue(undefined),
        discardUnboundTranscript: jest.fn().mockResolvedValue(undefined),
      };
      harness.mocks.providerRuntimePreparation.createPlan.mockResolvedValue(plan);
      harness.stoppedSessionRow.transcript_path = '/test/current.jsonl';
      const commit = jest
        .spyOn(harness.mocks.sessionRows, 'commitRollback')
        .mockResolvedValue({ outcome: 'committed' });
      return { ...harness, plan, commit };
    }

    it('keeps the current conversation before the fork plan and types only the launch line', async () => {
      const { pipeline, mocks, commit } = rollbackHarness();

      const result = await pipeline.rollback(request());

      const { createSavePoint } = mocks.forkAdapter;
      const { createPlan } = mocks.providerRuntimePreparation;
      expect(createSavePoint).toHaveBeenCalledWith(
        expect.objectContaining({
          providerSessionId: 'provider-session-1',
          transcriptPath: '/test/current.jsonl',
        }),
      );
      const [{ sessionId: recordCopyId }] = createSavePoint.mock.calls[0];
      expect(recordCopyId).toMatch(/^[0-9a-f-]{36}$/);
      expect(recordCopyId).not.toBe(beforeRollbackRecordId(sessionId));
      expect(createSavePoint.mock.invocationCallOrder[0]).toBeLessThan(
        createPlan.mock.invocationCallOrder[0],
      );
      // The runtime preparation spec shows that mode 'fork' sets the hook start source 'fork'.
      expect(createPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'fork',
          sessionId,
          savePoint: {
            providerSessionId: 'save-point-native',
            transcriptPath: '/test/save-point.jsonl',
          },
        }),
      );
      expect(commit).toHaveBeenCalledWith(
        expect.objectContaining({
          ...copy,
          sessionId,
          record: {
            providerSessionId: 'record-native',
            transcriptPath: '/test/record.jsonl',
            sizeBytes: null,
          },
        }),
      );
      expect(mocks.hooks.fenceRuntime).toHaveBeenCalledWith(sessionId);
      expect(mocks.hooks.fenceRuntime.mock.invocationCallOrder[0]).toBeLessThan(
        commit.mock.invocationCallOrder[0],
      );
      expect(mocks.terminalIO.typeCommand).toHaveBeenCalledTimes(1);
      expect(mocks.terminalIO.typeCommand).toHaveBeenCalledWith(
        expect.anything(),
        mocks.preparedProviderRuntime.typedArgs,
      );
      expect(mocks.eventsService.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({ sessionId, ...copy }),
      );
      expect(result).toMatchObject({ id: sessionId, transcriptPath: copy.transcriptPath });
    });

    it.each([
      { failure: 'the re-resolved target is not ready', step: 'readiness', copies: false },
      { failure: 'the plan fails', step: 'plan', copies: true },
    ] as const)(
      'writes nothing and re-arms the replay clear when $failure before the commit',
      async ({ step, copies }) => {
        const streamService = {
          scheduleClear: jest.fn(),
          cancelScheduledClear: jest.fn().mockReturnValue(60000),
          retireReplay: jest.fn(),
        };
        const { pipeline, mocks, commit } = rollbackHarness({ streamService });
        const failing =
          step === 'readiness'
            ? mocks.launchPipeline.verifyProvider
            : mocks.providerRuntimePreparation.createPlan;
        failing.mockRejectedValue(new Error(`${step} failed`));
        // The agent switched to another config of the same provider after the preflight.
        const switched = fakeProfileProviderConfig({ id: 'ppc-2', env: { SWITCHED: '1' } });
        mocks.storage.listProfileProviderConfigsByProfile.mockResolvedValue([switched]);

        await expect(pipeline.rollback(request())).rejects.toThrow(`${step} failed`);

        expect(mocks.forkAdapter.createSavePoint).toHaveBeenCalledTimes(copies ? 1 : 0);
        if (step === 'readiness') {
          expect(mocks.launchPipeline.verifyProvider).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'test-provider', binPath: '/usr/bin/test-provider' }),
            expect.any(String),
            projectId,
            switched.env,
          );
          expect(mocks.providerRuntimePreparation.createPlan).not.toHaveBeenCalled();
        }
        expect(commit).not.toHaveBeenCalled();
        expect(mocks.updateStmt.run).not.toHaveBeenCalled();
        expect(streamService.retireReplay).not.toHaveBeenCalled();
        expect(streamService.scheduleClear).toHaveBeenCalledWith(sessionId, 60000);
        expect(mocks.terminalIO.createEmptySession).not.toHaveBeenCalled();
      },
    );

    it('keeps SESSION_LINEAGE_RUNNING and discards the record copy when the runtime discard fails', async () => {
      const { pipeline, mocks, plan, commit } = rollbackHarness();
      const discardRecord = jest.fn().mockResolvedValue(undefined);
      mocks.forkAdapter.createSavePoint.mockResolvedValueOnce({
        providerSessionId: 'record-native',
        transcriptPath: '/test/record.jsonl',
        discardUnboundTranscript: discardRecord,
      });
      const running = { sessionId: 'related', agentId: 'agent-2', agentName: 'Clone' };
      commit.mockResolvedValueOnce({ outcome: 'lineageRunning', running });
      plan.discardUnboundTranscript.mockRejectedValueOnce(new Error('discard failed'));

      await expect(pipeline.rollback(request())).rejects.toMatchObject({
        statusCode: 409,
        details: { code: 'SESSION_LINEAGE_RUNNING', sessionId: 'related' },
      });

      expect(plan.discardUnboundTranscript).toHaveBeenCalledTimes(1);
      expect(discardRecord).toHaveBeenCalledTimes(1);
      expect(plan.commitBoundTranscript).not.toHaveBeenCalled();
      expect(mocks.terminalIO.createEmptySession).not.toHaveBeenCalled();
    });

    it('reports ROLLBACK_START_FAILED after the commit and leaves the row restorable', async () => {
      const { pipeline, mocks, plan, commit, stoppedSessionRow } = rollbackHarness();
      mocks.terminalIO.createEmptySession.mockRejectedValueOnce(new Error('tmux unavailable'));
      // Both copies are bound by the commit, so a later start failure must keep them.
      const discardRecord = jest.fn().mockResolvedValue(undefined);
      mocks.forkAdapter.createSavePoint.mockResolvedValueOnce({
        providerSessionId: 'record-native',
        transcriptPath: '/test/record.jsonl',
        discardUnboundTranscript: discardRecord,
      });

      await expect(pipeline.rollback(request())).rejects.toMatchObject({
        details: { code: 'ROLLBACK_START_FAILED' },
      });

      expect(commit).toHaveBeenCalledWith(
        expect.objectContaining({ ...copy, record: expect.anything() }),
      );
      expect(plan.commitBoundTranscript).toHaveBeenCalledTimes(1);
      expect(plan.discardUnboundTranscript).not.toHaveBeenCalled();
      expect(discardRecord).not.toHaveBeenCalled();
      // The compensator restores the lifecycle fields and owner; the binding stays on the copy.
      expect(mocks.updateStmt.run).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'agent-1',
          status: 'stopped',
          endedAt: '2025-01-01T01:00:00Z',
          tmux: null,
          provider: 'test-provider',
          id: sessionId,
        }),
      );
      expect(mocks.eventsService.publish).not.toHaveBeenCalledWith(
        'session.restored',
        expect.anything(),
      );

      Object.assign(stoppedSessionRow, {
        provider_session_id: copy.providerSessionId,
        transcript_path: copy.transcriptPath,
      });
      await expect(pipeline.restore(restoreRequest)).resolves.toMatchObject({
        id: sessionId,
        status: 'running',
        transcriptPath: copy.transcriptPath,
      });
    });

    it('starts a new replay epoch and refreshes the hook config after the commit', async () => {
      const metricsService = { registerStatsProvider: jest.fn() } as unknown as MetricsService;
      const streamService = new TerminalStreamService(metricsService);
      streamService.initializeBuffer(sessionId);
      streamService.addFrame(sessionId, 'old conversation');
      const oldEpoch = streamService.getSequenceEpoch(sessionId);
      const { pipeline, mocks, commit } = rollbackHarness({ streamService });

      await pipeline.rollback(request(false));

      expect(streamService.getFramesSince(sessionId)).toMatchObject({ frames: [] });
      streamService.initializeBuffer(sessionId);
      expect(streamService.getSequenceEpoch(sessionId)).not.toBe(oldEpoch);
      const { setupHooksConfig } = mocks.launchPipeline;
      expect(setupHooksConfig).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'test-provider' }),
        expect.any(String),
      );
      expect(commit.mock.invocationCallOrder[0]).toBeLessThan(
        setupHooksConfig.mock.invocationCallOrder[0],
      );
      expect(mocks.forkAdapter.createSavePoint).not.toHaveBeenCalled();
    });
  });
});
