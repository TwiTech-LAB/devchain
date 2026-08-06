/**
 * SessionLaunchPipeline — real mock-backed tests.
 *
 * Scenarios 1-4: Happy path, preflight failure, tmux create failure,
 * and typeCommand (paste) failure.
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

jest.mock('../provider-launch-config', () => ({
  resolve: jest.fn().mockReturnValue({
    argv: ['test-provider', '--session', 'new'],
    commandArgs: ['test-provider', '--session', 'new'],
    env: null,
    promptHandshake: undefined,
  }),
  ProfileOptionsError: class ProfileOptionsError extends Error {},
}));

// ── Imports ────────────────────────────────────────────────────────────

import {
  createLaunchPipelineHarness,
  fakeAgent,
  fakeProvider,
  fakeProfileProviderConfig,
} from './__test-utils__/pipeline-harness';
import { resolve as resolveLaunchConfig } from '../provider-launch-config';

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Helper that runs the promise while advancing fake timers so the
 * 7-second MIN_LAUNCH_DELAY_MS inside launchCliAndPastePrompt resolves.
 */
async function runWithTimers<T>(promiseFn: () => Promise<T>): Promise<T> {
  const promise = promiseFn();
  // Keep flushing timers until the promise settles
  for (let i = 0; i < 50; i++) {
    jest.advanceTimersByTime(1000);
    // Yield microtasks so the awaiting code can resume
    await Promise.resolve();
  }
  return promise;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('SessionLaunchPipeline', () => {
  const launchDto = {
    projectId: 'project-1',
    agentId: 'agent-1',
    epicId: 'epic-1',
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Scenario 1: Happy path
  describe('Scenario 1: happy path — all deps succeed', () => {
    it('emits session.started and inserts a DB row', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();

      // Ensure no existing running sessions
      mocks.sqliteMock.prepare.mockImplementation((sql: string) => {
        if (sql.includes('SELECT') && sql.includes("status = 'running'")) {
          return {
            run: jest.fn(),
            get: jest.fn().mockReturnValue(undefined),
            all: jest.fn().mockReturnValue([]),
          };
        }
        // INSERT / UPDATE
        return { run: jest.fn().mockReturnValue({ changes: 1 }), get: jest.fn(), all: jest.fn() };
      });

      const result = await runWithTimers(() => pipeline.launch(launchDto));

      // session.started event published
      expect(mocks.eventsService.publish).toHaveBeenCalledWith('session.started', {
        sessionId: expect.any(String),
        projectId: 'project-1',
        epicId: 'epic-1',
        agentId: 'agent-1',
        tmuxSessionName: expect.any(String),
      });

      // DB insert happened (prepare was called with INSERT)
      const insertCalls = mocks.sqliteMock.prepare.mock.calls.filter(([sql]: [string]) =>
        sql.includes('INSERT INTO sessions'),
      );
      expect(insertCalls.length).toBeGreaterThanOrEqual(1);

      // Returns a well-formed session detail
      expect(result).toEqual(
        expect.objectContaining({
          agentId: 'agent-1',
          status: 'running',
        }),
      );
    });

    // Layer: pipeline unit test with mocked terminal/event edges; this is the
    // cheapest layer that observes the launch-prompt and event call ordering.
    it('publishes session.started after prompt handling and before online presence', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      mocks.storage.getInitialSessionPrompt.mockResolvedValue({ content: 'Hello agent' });

      await runWithTimers(() => pipeline.launch(launchDto));

      const publishNames = mocks.eventsService.publish.mock.calls.map(([name]) => name);
      const startedIndex = publishNames.indexOf('session.started');
      const presenceIndex = publishNames.indexOf('session.presence.changed');

      expect(mocks.terminalIO.deliver).toHaveBeenCalled();
      expect(mocks.terminalIO.deliver.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.eventsService.publish.mock.invocationCallOrder[startedIndex],
      );
      expect(mocks.eventsService.publish.mock.invocationCallOrder[startedIndex]).toBeLessThan(
        mocks.eventsService.publish.mock.invocationCallOrder[presenceIndex],
      );
    });

    it('publishes session.starting before the provider command is typed', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      mocks.storage.getInitialSessionPrompt.mockResolvedValue({ content: 'Hello agent' });

      await runWithTimers(() => pipeline.launch(launchDto));

      const publishNames = mocks.eventsService.publish.mock.calls.map(([name]) => name);
      const startingIndex = publishNames.indexOf('session.starting');
      const startedIndex = publishNames.indexOf('session.started');

      expect(startingIndex).toBeGreaterThanOrEqual(0);
      expect(mocks.eventsService.publish).toHaveBeenCalledWith('session.starting', {
        sessionId: expect.any(String),
        projectId: 'project-1',
        agentId: 'agent-1',
      });
      // The whole point of this event: it must land BEFORE the CLI is launched, because
      // session.started only follows provider output plus the minimum launch delay and so
      // arrives seconds after the agent is visibly running.
      expect(mocks.eventsService.publish.mock.invocationCallOrder[startingIndex]).toBeLessThan(
        mocks.terminalIO.typeCommand.mock.invocationCallOrder[0],
      );
      expect(mocks.eventsService.publish.mock.invocationCallOrder[startingIndex]).toBeLessThan(
        mocks.eventsService.publish.mock.invocationCallOrder[startedIndex],
      );
    });

    it('threads the generated sessionId into resolveLaunchConfig for mode:new', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;

      mocks.sqliteMock.prepare.mockImplementation((sql: string) => {
        if (sql.includes('SELECT') && sql.includes("status = 'running'")) {
          return {
            run: jest.fn(),
            get: jest.fn().mockReturnValue(undefined),
            all: jest.fn().mockReturnValue([]),
          };
        }
        return { run: jest.fn().mockReturnValue({ changes: 1 }), get: jest.fn(), all: jest.fn() };
      });

      const result = await runWithTimers(() => pipeline.launch(launchDto));

      // sessionId (devchain sessions.id) is threaded so a binding adapter can
      // emit `--session-id <sessions.id>`; it must equal the persisted row id.
      // Match by value across all calls (the shared resolve mock accumulates
      // calls across tests, so don't index a fixed call position).
      expect(resolveMock).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'new', sessionId: result.id }),
      );
    });

    it('creates registry sessions with normalized capture policy for default adapters', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();

      mocks.sqliteMock.prepare.mockImplementation((sql: string) => {
        if (sql.includes('SELECT') && sql.includes("status = 'running'")) {
          return {
            run: jest.fn(),
            get: jest.fn().mockReturnValue(undefined),
            all: jest.fn().mockReturnValue([]),
          };
        }
        return { run: jest.fn().mockReturnValue({ changes: 1 }), get: jest.fn(), all: jest.fn() };
      });

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(mocks.terminalSessionRegistry.create).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        { normalizeCapturedLineEndings: true },
      );
    });

    it('rotates live context state before launching a fresh process', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();

      const result = await runWithTimers(() => pipeline.launch(launchDto));

      expect(mocks.runtimeContextCapture.rotateEpoch).toHaveBeenCalledWith(result.id, null);
      expect(mocks.runtimeContextCapture.rotateEpoch.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.terminalIO.typeCommand.mock.invocationCallOrder[0],
      );
    });

    it('binds the resolved model-specific configured window to the new session', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;
      resolveMock.mockReturnValueOnce({
        argv: ['test-provider', '--session', 'new'],
        commandArgs: ['test-provider', '--session', 'new'],
        env: null,
        contextWindowOverride: {
          modelId: 'custom/model',
          contextWindowTokens: 640_000,
        },
      });

      const result = await runWithTimers(() => pipeline.launch(launchDto));

      expect(mocks.runtimeContextCapture.rotateEpoch).toHaveBeenCalledWith(result.id, {
        modelId: 'custom/model',
        contextWindowTokens: 640_000,
      });
    });

    it('prepares Claude settings after epoch rotation and re-resolves the fresh launch overlay', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;
      resolveMock.mockClear();
      mocks.storage.getProvider.mockResolvedValue(
        fakeProvider({ name: 'claude', claudeLaunchSettingsJson: '{"tui":"default"}' }),
      );
      mocks.storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        fakeProfileProviderConfig({ options: '--model sonnet' }),
      ]);
      mocks.claudeLaunchSettings.prepare.mockResolvedValue({
        optionArgs: ['--settings', '/private/revision.json'],
        runtimeEnv: { DEVCHAIN_STATUSLINE_LOCATOR: '/private/locator.json' },
        captureEnabled: true,
      });

      const result = await runWithTimers(() => pipeline.launch(launchDto));

      expect(mocks.claudeLaunchSettings.prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          providerName: 'claude',
          settingsJson: '{"tui":"default"}',
          profileOptionArgs: ['--model', 'sonnet'],
          sessionId: result.id,
          epoch: 'capture-epoch',
          projectRootPath: '/tmp/project',
        }),
      );
      expect(resolveMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          mode: 'new',
          providerOptionArgs: ['--settings', '/private/revision.json'],
          runtimeEnv: { DEVCHAIN_STATUSLINE_LOCATOR: '/private/locator.json' },
        }),
      );
      expect(mocks.runtimeContextCapture.rotateEpoch.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.claudeLaunchSettings.prepare.mock.invocationCallOrder[0],
      );
    });

    it('uses the original fresh-launch command unchanged when preparation is inactive', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;
      resolveMock.mockClear();

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(resolveMock).toHaveBeenCalledTimes(1);
      expect(mocks.terminalIO.typeCommand).toHaveBeenCalledWith(expect.any(Object), [
        'test-provider',
        '--session',
        'new',
      ]);
    });

    it('keeps captured normalization enabled for live raw-line-ending adapters', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      (
        mocks.adapter as {
          terminalOutputBehavior?: { rawLineEndings: boolean };
        }
      ).terminalOutputBehavior = { rawLineEndings: true };

      mocks.sqliteMock.prepare.mockImplementation((sql: string) => {
        if (sql.includes('SELECT') && sql.includes("status = 'running'")) {
          return {
            run: jest.fn(),
            get: jest.fn().mockReturnValue(undefined),
            all: jest.fn().mockReturnValue([]),
          };
        }
        return { run: jest.fn().mockReturnValue({ changes: 1 }), get: jest.fn(), all: jest.fn() };
      });

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(mocks.terminalSessionRegistry.create).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        { normalizeCapturedLineEndings: true },
      );
    });
  });

  // Per-provider alternate-screen policy — launch matrix.
  // The pipeline reads `adapter.terminalOutputBehavior?.usesAlternateScreen` and
  // forwards it to tmux via `setAlternateScreen(target, <bool>)`. This is GATE 1
  // of the two-gate invariant; GATE 2 (the PTY strip) reads the SAME adapter
  // field via sessionsService.usesAlternateScreenFor (see sessions.service.spec.ts).
  // Layer: pipeline unit test with the shared harness — cheapest layer that
  // proves the pipeline honors the adapter flag end-to-end through to tmux.
  describe('per-provider alternate-screen policy (launch matrix)', () => {
    const noRunningSelect = (sql: string) => {
      if (sql.includes('SELECT') && sql.includes("status = 'running'")) {
        return {
          run: jest.fn(),
          get: jest.fn().mockReturnValue(undefined),
          all: jest.fn().mockReturnValue([]),
        };
      }
      return { run: jest.fn().mockReturnValue({ changes: 1 }), get: jest.fn(), all: jest.fn() };
    };

    it('enables alternate-screen for a full-screen TUI adapter (usesAlternateScreen: true)', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      (
        mocks.adapter as { terminalOutputBehavior?: { usesAlternateScreen: boolean } }
      ).terminalOutputBehavior = { usesAlternateScreen: true };
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      // setAlternateScreen called exactly once, with enabled=true (tmux alternate-screen on)
      expect(mocks.terminalIO.setAlternateScreen).toHaveBeenCalledTimes(1);
      expect(mocks.terminalIO.setAlternateScreen).toHaveBeenCalledWith(
        { name: expect.any(String) },
        true,
      );
    });

    it('suppresses alternate-screen by default (adapter has no terminalOutputBehavior)', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      // Default mock adapter has NO terminalOutputBehavior → usesAlternateScreen defaults to false
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(mocks.terminalIO.setAlternateScreen).toHaveBeenCalledTimes(1);
      expect(mocks.terminalIO.setAlternateScreen).toHaveBeenCalledWith(
        { name: expect.any(String) },
        false,
      );
    });

    it('suppresses alternate-screen when the adapter explicitly opts out (usesAlternateScreen: false)', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      (
        mocks.adapter as { terminalOutputBehavior?: { usesAlternateScreen: boolean } }
      ).terminalOutputBehavior = { usesAlternateScreen: false };
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(mocks.terminalIO.setAlternateScreen).toHaveBeenCalledWith(
        { name: expect.any(String) },
        false,
      );
    });

    it('sets alternate-screen AFTER creating the tmux session (ordering — window option needs a target)', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      const createOrder = mocks.terminalIO.createEmptySession.mock.invocationCallOrder[0];
      const altOrder = mocks.terminalIO.setAlternateScreen.mock.invocationCallOrder[0];
      expect(altOrder).toBeGreaterThan(createOrder);
    });
  });

  describe('managed provider plugin policy', () => {
    it('re-resolves Codex args, launches one helper command, and validates acknowledgement', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;
      resolveMock.mockClear();
      mocks.storage.getProvider.mockResolvedValue(fakeProvider({ name: 'codex' }));
      mocks.providerPluginPolicy.resolveAll.mockResolvedValue([
        { providerId: 'provider-1', pluginId: 'plugin@market', enabled: true, source: 'default' },
      ]);
      mocks.codexPluginProfiles.prepare.mockImplementation(async (input) => ({
        profileName: 'devchain-profile',
        projectDigest: 'a'.repeat(64),
        policyHash: 'b'.repeat(64),
        sourceRevisionPath: '/private/source.toml',
        helperPath: '/private/helper',
        sessionId: input.sessionId,
        attemptNonce: input.attemptNonce,
        referencePath: '/private/reference.json',
        locatorPath: '/private/locator.json',
        acknowledgementPath: '/private/ack.json',
        providerOptionArgs: ['--profile', 'devchain-profile'],
      }));
      mocks.codexPluginProfiles.buildHelperArgv.mockReturnValue([
        '/private/helper',
        '--',
        '/usr/bin/test-provider',
      ]);

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(resolveMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          providerOptionArgs: ['--profile', 'devchain-profile'],
        }),
      );
      expect(mocks.terminalIO.typeCommand).toHaveBeenCalledWith(expect.anything(), [
        'env',
        '-u',
        'DEVCHAIN_CONTEXT_WINDOW_TOKENS',
        '/private/helper',
        '--',
        '/usr/bin/test-provider',
      ]);
      expect(mocks.codexPluginProfiles.awaitAcknowledgement).toHaveBeenCalled();
      expect(
        mocks.codexPluginProfiles.awaitAcknowledgement.mock.invocationCallOrder[0],
      ).toBeLessThan(mocks.eventsService.publish.mock.invocationCallOrder.at(-2));
    });

    it.each(['-pmanaged', '-p', '--profile', '--profile='])(
      'rejects explicit Codex selector %s before launch argv resolution',
      async (selector) => {
        const { pipeline, mocks } = createLaunchPipelineHarness();
        const resolveMock = resolveLaunchConfig as jest.Mock;
        resolveMock.mockClear();
        mocks.storage.getProvider.mockResolvedValue(fakeProvider({ name: 'codex' }));
        mocks.storage.listProfileProviderConfigsByProfile.mockResolvedValue([
          fakeProfileProviderConfig({ options: selector }),
        ]);
        mocks.providerPluginPolicy.resolveAll.mockResolvedValue([
          { providerId: 'provider-1', pluginId: 'plugin@market', enabled: true, source: 'default' },
        ]);

        await expect(pipeline.launch(launchDto)).rejects.toThrow('conflicts');

        expect(resolveMock).not.toHaveBeenCalled();
        expect(mocks.codexPluginProfiles.prepare).not.toHaveBeenCalled();
      },
    );
  });

  // Scenario 2: Provider verify fails
  describe('Scenario 2: preflight fails — no DB insert, no tmux create', () => {
    it('throws, never inserts a DB row, never creates tmux', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();

      // Make preflight fail
      mocks.preflightService.runChecks.mockResolvedValue({
        overall: 'fail',
        checks: [{ name: 'binary', status: 'fail', message: 'binary not found' }],
        providers: [],
      });

      // No existing running sessions
      mocks.sqliteMock.prepare.mockImplementation((sql: string) => {
        if (sql.includes('SELECT') && sql.includes("status = 'running'")) {
          return { run: jest.fn(), get: jest.fn(), all: jest.fn().mockReturnValue([]) };
        }
        return { run: jest.fn().mockReturnValue({ changes: 1 }), get: jest.fn(), all: jest.fn() };
      });

      await expect(runWithTimers(() => pipeline.launch(launchDto))).rejects.toThrow(
        'Preflight checks failed',
      );

      // No INSERT call
      const insertCalls = mocks.sqliteMock.prepare.mock.calls.filter(([sql]: [string]) =>
        sql.includes('INSERT INTO sessions'),
      );
      expect(insertCalls).toHaveLength(0);

      // No tmux creation
      expect(mocks.terminalIO.createEmptySession).not.toHaveBeenCalled();

      // No session.started event
      expect(mocks.eventsService.publish).not.toHaveBeenCalledWith(
        'session.started',
        expect.anything(),
      );
    });
  });

  // Scenario 3: Tmux create fails after DB write
  describe('Scenario 3: tmux create fails after DB write — DB row updated to failed', () => {
    it('updates DB row to failed, no session.started', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();

      // Track what SQL is executed via run()
      const runCalls: { sql: string; args: unknown[] }[] = [];

      mocks.sqliteMock.prepare.mockImplementation((sql: string) => {
        return {
          run: jest.fn((...args: unknown[]) => {
            runCalls.push({ sql, args });
            return { changes: 1 };
          }),
          get: jest.fn().mockReturnValue(undefined),
          all: jest.fn().mockReturnValue([]),
        };
      });

      // Make tmux creation fail
      mocks.terminalIO.createEmptySession.mockRejectedValue(new Error('tmux: server not found'));

      await expect(runWithTimers(() => pipeline.launch(launchDto))).rejects.toThrow(
        'tmux: server not found',
      );

      // An INSERT should have happened (session row created before tmux)
      const inserts = runCalls.filter((c) => c.sql.includes('INSERT INTO sessions'));
      expect(inserts.length).toBeGreaterThanOrEqual(1);

      // Compensator should have run UPDATE to 'failed'
      const failUpdates = runCalls.filter(
        (c) => c.sql.includes('UPDATE sessions') && c.args.includes('failed'),
      );
      expect(failUpdates.length).toBeGreaterThanOrEqual(1);

      // session.started not emitted
      expect(mocks.eventsService.publish).not.toHaveBeenCalledWith(
        'session.started',
        expect.anything(),
      );
    });

    it('clears a rotated Claude capture epoch during rollback', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      mocks.storage.getProvider.mockResolvedValue(fakeProvider({ name: 'claude' }));
      mocks.terminalIO.createEmptySession.mockRejectedValue(new Error('tmux failed'));

      await expect(runWithTimers(() => pipeline.launch(launchDto))).rejects.toThrow('tmux failed');

      expect(mocks.runtimeContextCapture.rotateEpoch).toHaveBeenCalledWith(
        expect.any(String),
        null,
      );
      expect(mocks.runtimeContextCapture.clear).toHaveBeenCalledWith(expect.any(String));
    });
  });

  // Additional: typeCommand fails after tmux created (phase 8 failure — valid coverage)
  describe('typeCommand fails after tmux created (phase 8)', () => {
    it('tmux destroyed via compensator, DB row marked failed', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();

      const runCalls: { sql: string; args: unknown[] }[] = [];

      mocks.sqliteMock.prepare.mockImplementation((sql: string) => {
        return {
          run: jest.fn((...args: unknown[]) => {
            runCalls.push({ sql, args });
            return { changes: 1 };
          }),
          get: jest.fn().mockReturnValue(undefined),
          all: jest.fn().mockReturnValue([]),
        };
      });

      mocks.terminalIO.typeCommand.mockRejectedValue(
        new Error('send-keys failed: session not responsive'),
      );

      await expect(runWithTimers(() => pipeline.launch(launchDto))).rejects.toThrow(
        'send-keys failed',
      );

      expect(mocks.terminalIO.destroySession).toHaveBeenCalled();

      const failUpdates = runCalls.filter(
        (c) => c.sql.includes('UPDATE sessions') && c.args.includes('failed'),
      );
      expect(failUpdates.length).toBeGreaterThanOrEqual(1);

      expect(mocks.eventsService.publish).not.toHaveBeenCalledWith(
        'session.started',
        expect.anything(),
      );
    });
  });

  // Scenario 4 (R1 regression): deliver (initial prompt paste) fails after flipToRunning
  // NOTE: This scenario should FAIL until R1 lands — R1 fixes the swallowed
  // deliver failure in renderAndPasteInitialPrompt. Currently the pipeline
  // catches the deliver error inside a try/catch and continues, so
  // session.started IS emitted even when paste fails.
  describe('Scenario 4: deliver (paste) fails after flipToRunning — R1 regression', () => {
    it('tmux destroyed, registry disposed, DB failed, no session.started', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();

      const runCalls: { sql: string; args: unknown[] }[] = [];

      mocks.sqliteMock.prepare.mockImplementation((sql: string) => {
        return {
          run: jest.fn((...args: unknown[]) => {
            runCalls.push({ sql, args });
            return { changes: 1 };
          }),
          get: jest.fn().mockReturnValue(undefined),
          all: jest.fn().mockReturnValue([]),
        };
      });

      // All phases succeed EXCEPT deliver (initial prompt paste)
      mocks.terminalIO.deliver.mockRejectedValue(new Error('paste confirmation timed out'));

      // Mock storage for initial prompt so deliver IS called
      mocks.storage.getInitialSessionPrompt.mockResolvedValue({
        content: 'Hello agent',
      });

      await expect(runWithTimers(() => pipeline.launch(launchDto))).rejects.toThrow(
        'paste confirmation timed out',
      );

      // tmux destroyed via createTmuxSession compensator
      expect(mocks.terminalIO.destroySession).toHaveBeenCalled();

      // registry disposed via bindStreaming compensator
      expect(mocks.terminalSessionRegistry.dispose).toHaveBeenCalled();

      // DB row marked failed
      const failUpdates = runCalls.filter(
        (c) => c.sql.includes('UPDATE sessions') && c.args.includes('failed'),
      );
      expect(failUpdates.length).toBeGreaterThanOrEqual(1);

      // session.started NOT emitted
      expect(mocks.eventsService.publish).not.toHaveBeenCalledWith(
        'session.started',
        expect.anything(),
      );
    });
  });

  // ── Regression tests: team-context rendering ─────────────────────────
  describe('renderAndPasteInitialPrompt — team-context rendering', () => {
    it('A: team-lead renders LEAD branch', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      mocks.storage.getInitialSessionPrompt.mockResolvedValue({
        content: '{{#if is_team_lead}}LEAD{{else}}MEMBER{{/if}}',
      });
      mocks.teamsService.listTeamsByAgent.mockResolvedValue([
        {
          id: 't1',
          name: 'Backend',
          teamLeadAgentId: 'agent-1',
          projectId: 'project-1',
          createdAt: '',
          updatedAt: '',
        },
      ]);

      await runWithTimers(() =>
        pipeline.launch({ projectId: 'project-1', agentId: 'agent-1', epicId: 'epic-1' }),
      );

      expect(mocks.terminalIO.deliver).toHaveBeenCalled();
      const deliveredText = mocks.terminalIO.deliver.mock.calls[0][1] as string;
      expect(deliveredText).toContain('LEAD');
      expect(deliveredText).not.toContain('MEMBER');
    });

    it('B: non-lead renders MEMBER branch', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      mocks.storage.getInitialSessionPrompt.mockResolvedValue({
        content: '{{#if is_team_lead}}LEAD{{else}}MEMBER{{/if}}',
      });
      mocks.teamsService.listTeamsByAgent.mockResolvedValue([
        {
          id: 't1',
          name: 'Backend',
          teamLeadAgentId: 'other-agent',
          projectId: 'project-1',
          createdAt: '',
          updatedAt: '',
        },
      ]);

      await runWithTimers(() =>
        pipeline.launch({ projectId: 'project-1', agentId: 'agent-1', epicId: 'epic-1' }),
      );

      expect(mocks.terminalIO.deliver).toHaveBeenCalled();
      const deliveredText = mocks.terminalIO.deliver.mock.calls[0][1] as string;
      expect(deliveredText).toContain('MEMBER');
      expect(deliveredText).not.toContain('LEAD');
    });

    it('C: null prompt guard — no IO performed', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      mocks.storage.getInitialSessionPrompt.mockResolvedValue(null);

      await runWithTimers(() =>
        pipeline.launch({ projectId: 'project-1', agentId: 'agent-1', epicId: 'epic-1' }),
      );

      expect(mocks.teamsService.listTeamsByAgent).not.toHaveBeenCalled();
      expect(mocks.terminalIO.deliver).not.toHaveBeenCalled();
    });

    it('D: team-lookup failure resilience — launch succeeds with empty team context', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      mocks.storage.getInitialSessionPrompt.mockResolvedValue({
        content: '{{#if is_team_lead}}LEAD{{else}}MEMBER{{/if}}',
      });
      mocks.teamsService.listTeamsByAgent.mockRejectedValue(new Error('DB connection lost'));

      await runWithTimers(() =>
        pipeline.launch({ projectId: 'project-1', agentId: 'agent-1', epicId: 'epic-1' }),
      );

      expect(mocks.terminalIO.deliver).toHaveBeenCalled();
      const deliveredText = mocks.terminalIO.deliver.mock.calls[0][1] as string;
      expect(deliveredText).toContain('MEMBER');
      expect(deliveredText).not.toContain('LEAD');
    });

    it('E: variable substitution', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      mocks.storage.getInitialSessionPrompt.mockResolvedValue({
        content: 'agent={{agent_name}} project={{project_name}} session_short={{session_id_short}}',
      });

      await runWithTimers(() =>
        pipeline.launch({ projectId: 'project-1', agentId: 'agent-1', epicId: 'epic-1' }),
      );

      expect(mocks.terminalIO.deliver).toHaveBeenCalled();
      const deliveredText = mocks.terminalIO.deliver.mock.calls[0][1] as string;
      expect(deliveredText).toContain('agent=test-agent');
      expect(deliveredText).toContain('project=TestProject');
      expect(deliveredText).toMatch(/session_short=[a-f0-9]{8}/);
    });
  });

  // ── Opt-in initial-prompt seeding (initialPromptSeedMode) ────────────────
  // For adapters that declare `initialPromptSeedMode`, the prompt is rendered
  // BEFORE resolveLaunchConfig and threaded into buildLaunchArgs (argv) or piped
  // post-launch (stdin) — and the fragile post-launch paste is SKIPPED. Default
  // adapters (no seed mode) keep the existing paste path unchanged.
  describe('initial-prompt seeding (opt-in initialPromptSeedMode)', () => {
    const noRunningSelect = (sql: string) => {
      if (sql.includes('SELECT') && sql.includes("status = 'running'")) {
        return {
          run: jest.fn(),
          get: jest.fn().mockReturnValue(undefined),
          all: jest.fn().mockReturnValue([]),
        };
      }
      return { run: jest.fn().mockReturnValue({ changes: 1 }), get: jest.fn(), all: jest.fn() };
    };

    it('argv mode: renders prompt before resolveLaunchConfig, passes it as initialPrompt, and SKIPS paste', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;
      (mocks.adapter as { initialPromptSeedMode?: 'argv' | 'stdin' }).initialPromptSeedMode =
        'argv';
      mocks.storage.getInitialSessionPrompt.mockResolvedValue({ content: 'Seed {{agent_name}}' });
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      // initialPrompt threaded into resolveLaunchConfig (→ buildLaunchArgs)
      expect(resolveMock).toHaveBeenCalledWith(
        expect.objectContaining({ initialPrompt: expect.stringContaining('Seed test-agent') }),
      );
      // Post-launch paste skipped entirely; argv mode pipes nothing
      expect(mocks.terminalIO.deliver).not.toHaveBeenCalled();
      expect(mocks.terminalIO.deliverImmediate).not.toHaveBeenCalled();
    });

    it('stdin mode: pipes the rendered prompt as literal input (no bracketed paste) and SKIPS paste', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;
      (mocks.adapter as { initialPromptSeedMode?: 'argv' | 'stdin' }).initialPromptSeedMode =
        'stdin';
      mocks.storage.getInitialSessionPrompt.mockResolvedValue({ content: 'Seed {{agent_name}}' });
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(resolveMock).toHaveBeenCalledWith(
        expect.objectContaining({ initialPrompt: expect.stringContaining('Seed test-agent') }),
      );
      // Piped to the process after start, without bracketed-paste markers
      expect(mocks.terminalIO.deliverImmediate).toHaveBeenCalledWith(
        { name: expect.any(String) },
        expect.stringContaining('Seed test-agent'),
        { bracketed: false, confirm: false },
      );
      // Fragile paste path not used
      expect(mocks.terminalIO.deliver).not.toHaveBeenCalled();
    });

    it('seed adapter with NO configured prompt: initialPrompt undefined, no paste, no pipe', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;
      (mocks.adapter as { initialPromptSeedMode?: 'argv' | 'stdin' }).initialPromptSeedMode =
        'stdin';
      mocks.storage.getInitialSessionPrompt.mockResolvedValue(null);
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(resolveMock).toHaveBeenCalledWith(
        expect.objectContaining({ initialPrompt: undefined }),
      );
      expect(mocks.terminalIO.deliver).not.toHaveBeenCalled();
      expect(mocks.terminalIO.deliverImmediate).not.toHaveBeenCalled();
    });

    it('default adapter (no seed mode): paste path preserved, initialPrompt stays undefined (regression)', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;
      // mocks.adapter.initialPromptSeedMode is undefined by default
      mocks.storage.getInitialSessionPrompt.mockResolvedValue({ content: 'Hello {{agent_name}}' });
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      // No launch-time seeding for default providers
      expect(resolveMock).toHaveBeenCalledWith(
        expect.objectContaining({ initialPrompt: undefined }),
      );
      // Existing out-of-band paste still happens
      expect(mocks.terminalIO.deliver).toHaveBeenCalled();
      expect(mocks.terminalIO.deliverImmediate).not.toHaveBeenCalled();
    });
  });

  // ── Effective model/effort resolution (Phase-1 effort levels) ────────────
  // The pipeline folds agent overrides + config structured defaults + raw options
  // into the effective model/effort passed to resolveLaunchConfig. Layer: pipeline
  // unit test with the shared harness (resolve is mocked) — cheapest layer that
  // proves the pipeline computes precedence and passes both values; the actual
  // argv strip/inject is proven at the resolver layer (provider-launch-config.spec).
  describe('effective model/effort resolution', () => {
    const noRunningSelect = (sql: string) => {
      if (sql.includes('SELECT') && sql.includes("status = 'running'")) {
        return {
          run: jest.fn(),
          get: jest.fn().mockReturnValue(undefined),
          all: jest.fn().mockReturnValue([]),
        };
      }
      return { run: jest.fn().mockReturnValue({ changes: 1 }), get: jest.fn(), all: jest.fn() };
    };

    it('passes agent.effortOverride when set (highest precedence, beats config.effort)', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;
      resolveMock.mockClear();
      mocks.storage.getAgent.mockResolvedValue(fakeAgent({ effortOverride: 'high' }));
      mocks.storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        fakeProfileProviderConfig({ effort: 'low' }),
      ]);
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(resolveMock).toHaveBeenCalledWith(expect.objectContaining({ effortOverride: 'high' }));
    });

    it('falls back to config.effort when the agent effort override is null', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;
      resolveMock.mockClear();
      mocks.storage.getAgent.mockResolvedValue(fakeAgent({ effortOverride: null }));
      mocks.storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        fakeProfileProviderConfig({ effort: 'medium' }),
      ]);
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(resolveMock).toHaveBeenCalledWith(
        expect.objectContaining({ effortOverride: 'medium' }),
      );
    });

    it('passes effortOverride null when neither agent nor config sets an effort', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;
      resolveMock.mockClear();
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(resolveMock).toHaveBeenCalledWith(expect.objectContaining({ effortOverride: null }));
    });

    it('BEHAVIOR CHANGE: config.model set + raw --model in options → structured model wins', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;
      resolveMock.mockClear();
      mocks.storage.getAgent.mockResolvedValue(fakeAgent({ modelOverride: null }));
      mocks.storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        fakeProfileProviderConfig({ model: 'opus', options: '--model sonnet' }),
      ]);
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      // Effective model is the structured config.model, not the raw --model text.
      // (The resolver then strips the raw --model — proven in the resolver spec.)
      expect(resolveMock).toHaveBeenCalledWith(expect.objectContaining({ modelOverride: 'opus' }));
    });

    it('agent.modelOverride wins over config.model', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;
      resolveMock.mockClear();
      mocks.storage.getAgent.mockResolvedValue(fakeAgent({ modelOverride: 'haiku' }));
      mocks.storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        fakeProfileProviderConfig({ model: 'opus' }),
      ]);
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(resolveMock).toHaveBeenCalledWith(expect.objectContaining({ modelOverride: 'haiku' }));
    });

    it('folds a raw --model into the effective model when no structured override exists', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;
      resolveMock.mockClear();
      mocks.storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        fakeProfileProviderConfig({ options: '--model sonnet' }),
      ]);
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(resolveMock).toHaveBeenCalledWith(
        expect.objectContaining({ modelOverride: 'sonnet' }),
      );
    });
  });

  describe('provider env scope filtering', () => {
    it('calls getProviderEnvForProject with provider.id and projectId', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();

      mocks.sqliteMock.prepare.mockImplementation((sql: string) => {
        if (sql.includes('SELECT') && sql.includes("status = 'running'")) {
          return {
            run: jest.fn(),
            get: jest.fn().mockReturnValue(undefined),
            all: jest.fn().mockReturnValue([]),
          };
        }
        return { run: jest.fn().mockReturnValue({ changes: 1 }), get: jest.fn(), all: jest.fn() };
      });

      mocks.storage.getProviderEnvForProject.mockReturnValue({ FILTERED_KEY: 'filtered-value' });

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(mocks.storage.getProviderEnvForProject).toHaveBeenCalledWith(
        'provider-1',
        'project-1',
      );
    });

    it('passes filtered env to resolveLaunchConfig instead of raw provider.env', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const resolveMock = resolveLaunchConfig as jest.Mock;

      mocks.sqliteMock.prepare.mockImplementation((sql: string) => {
        if (sql.includes('SELECT') && sql.includes("status = 'running'")) {
          return {
            run: jest.fn(),
            get: jest.fn().mockReturnValue(undefined),
            all: jest.fn().mockReturnValue([]),
          };
        }
        return { run: jest.fn().mockReturnValue({ changes: 1 }), get: jest.fn(), all: jest.fn() };
      });

      const filteredEnv = { SCOPED_KEY: 'scoped-value' };
      mocks.storage.getProviderEnvForProject.mockReturnValue(filteredEnv);

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(resolveMock).toHaveBeenCalledWith(
        expect.objectContaining({ providerEnv: filteredEnv }),
      );
    });
  });
});
