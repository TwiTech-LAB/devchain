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
  createLogger: () => mockLogger,
}));

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../../../common/config/env.config', () => ({
  getEnvConfig: () => ({ HOST: '127.0.0.1', PORT: 3000 }),
}));

jest.mock('@devchain/shared', () => ({
  HostResolver: {
    buildInternalBaseUrl: () => 'http://127.0.0.1:3000',
  },
}));

jest.mock('../../../providers/adapters/capabilities', () => ({
  isAutoCompactCapable: jest.fn(() => false),
  isHookCapable: jest.fn(() => false),
  isProjectProvisioningCapable: jest.fn(() => false),
}));

jest.mock('../../utils/tmux-naming.util', () => ({
  buildTmuxSessionName: (...args: string[]) => `tmux-${args.join('-')}`,
}));

// ── Imports ────────────────────────────────────────────────────────────

import { createLaunchPipelineHarness } from './__test-utils__/pipeline-harness';
import { isProjectProvisioningCapable } from '../../../providers/adapters/capabilities';

const mockIsProjectProvisioningCapable = isProjectProvisioningCapable as unknown as jest.Mock;

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

    it('threads the generated sessionId into provider runtime planning for mode:new', async () => {
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

      const result = await runWithTimers(() => pipeline.launch(launchDto));

      expect(mocks.providerRuntimePreparation.createPlan).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'new', sessionId: result.id }),
      );
    });

    it('plans before insert and materializes after insert but before tmux creation', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const insertRun = jest.fn().mockReturnValue({ changes: 1 });
      mocks.sqliteMock.prepare.mockImplementation((sql: string) => {
        if (sql.includes('SELECT') && sql.includes("status = 'running'")) {
          return { run: jest.fn(), get: jest.fn(), all: jest.fn().mockReturnValue([]) };
        }
        if (sql.includes('INSERT INTO sessions')) {
          return { run: insertRun, get: jest.fn(), all: jest.fn() };
        }
        return { run: jest.fn(), get: jest.fn(), all: jest.fn() };
      });

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(mocks.providerRuntimePreparation.createPlan.mock.invocationCallOrder[0]).toBeLessThan(
        insertRun.mock.invocationCallOrder[0],
      );
      expect(insertRun.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.providerRuntimePreparation.materialize.mock.invocationCallOrder[0],
      );
      expect(mocks.providerRuntimePreparation.materialize.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.terminalIO.createEmptySession.mock.invocationCallOrder[0],
      );
    });

    it('runs provider readiness after typeCommand and before output wait and success publication', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();

      await runWithTimers(() => pipeline.launch(launchDto));

      const startedCall = mocks.eventsService.publish.mock.calls.findIndex(
        ([event]: [string]) => event === 'session.started',
      );
      expect(mocks.terminalIO.typeCommand.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.preparedProviderRuntime.afterCommand.mock.invocationCallOrder[0],
      );
      expect(mocks.preparedProviderRuntime.afterCommand.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.terminalIO.waitForOutput.mock.invocationCallOrder[0],
      );
      expect(mocks.preparedProviderRuntime.afterCommand.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.eventsService.publish.mock.invocationCallOrder[startedCall],
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
  // field via SessionTerminalRuntimeService.getDescriptor (see
  // session-terminal-runtime.service.spec.ts).
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

    it('creates no durable row, tmux session, or success event when planning fails', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      mocks.providerRuntimePreparation.createPlan.mockRejectedValue(new Error('planning failed'));

      await expect(runWithTimers(() => pipeline.launch(launchDto))).rejects.toThrow(
        'planning failed',
      );

      expect(
        mocks.sqliteMock.prepare.mock.calls.some(([sql]: [string]) =>
          sql.includes('INSERT INTO sessions'),
        ),
      ).toBe(false);
      expect(mocks.providerRuntimePreparation.materialize).not.toHaveBeenCalled();
      expect(mocks.terminalIO.createEmptySession).not.toHaveBeenCalled();
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

    it('runs the prepared provider-runtime rollback when tmux creation fails', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      mocks.terminalIO.createEmptySession.mockRejectedValue(new Error('tmux failed'));

      await expect(runWithTimers(() => pipeline.launch(launchDto))).rejects.toThrow('tmux failed');

      expect(mocks.preparedProviderRuntime.rollback).toHaveBeenCalledTimes(1);
    });

    it('marks the row failed without creating tmux when materialization fails', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const runCalls: { sql: string; args: unknown[] }[] = [];
      mocks.sqliteMock.prepare.mockImplementation((sql: string) => ({
        run: jest.fn((...args: unknown[]) => {
          runCalls.push({ sql, args });
          return { changes: 1 };
        }),
        get: jest.fn(),
        all: jest.fn().mockReturnValue([]),
      }));
      mocks.providerRuntimePreparation.materialize.mockRejectedValue(
        new Error('materialization failed'),
      );

      await expect(runWithTimers(() => pipeline.launch(launchDto))).rejects.toThrow(
        'materialization failed',
      );

      expect(runCalls.some(({ sql }) => sql.includes('INSERT INTO sessions'))).toBe(true);
      expect(
        runCalls.some(
          ({ sql, args }) => sql.includes('UPDATE sessions') && args.includes('failed'),
        ),
      ).toBe(true);
      expect(mocks.terminalIO.createEmptySession).not.toHaveBeenCalled();
      expect(mocks.eventsService.publish).not.toHaveBeenCalledWith(
        'session.started',
        expect.anything(),
      );
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

      expect(mocks.terminalIO.destroyExpectedSession).toHaveBeenCalledWith(expect.any(Object), {
        onUnknownError: 'retire',
      });

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

  // Scenario 4: deliver (initial prompt paste) fails after flipToRunning
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
      expect(mocks.terminalIO.destroyExpectedSession).toHaveBeenCalledWith(expect.any(Object), {
        onUnknownError: 'retire',
      });

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
  // BEFORE provider runtime planning and threaded into buildLaunchArgs (argv) or piped
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

    it('argv mode: renders prompt before planning, passes it as initialPrompt, and SKIPS paste', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      (mocks.adapter as { initialPromptSeedMode?: 'argv' | 'stdin' }).initialPromptSeedMode =
        'argv';
      mocks.storage.getInitialSessionPrompt.mockResolvedValue({ content: 'Seed {{agent_name}}' });
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(mocks.providerRuntimePreparation.createPlan).toHaveBeenCalledWith(
        expect.objectContaining({ initialPrompt: expect.stringContaining('Seed test-agent') }),
      );
      // Post-launch paste skipped entirely; argv mode pipes nothing
      expect(mocks.terminalIO.deliver).not.toHaveBeenCalled();
      expect(mocks.terminalIO.deliverImmediate).not.toHaveBeenCalled();
    });

    it('stdin mode: pipes the rendered prompt as literal input (no bracketed paste) and SKIPS paste', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      (mocks.adapter as { initialPromptSeedMode?: 'argv' | 'stdin' }).initialPromptSeedMode =
        'stdin';
      mocks.storage.getInitialSessionPrompt.mockResolvedValue({ content: 'Seed {{agent_name}}' });
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(mocks.providerRuntimePreparation.createPlan).toHaveBeenCalledWith(
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
      (mocks.adapter as { initialPromptSeedMode?: 'argv' | 'stdin' }).initialPromptSeedMode =
        'stdin';
      mocks.storage.getInitialSessionPrompt.mockResolvedValue(null);
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(mocks.providerRuntimePreparation.createPlan).toHaveBeenCalledWith(
        expect.objectContaining({ initialPrompt: undefined }),
      );
      expect(mocks.terminalIO.deliver).not.toHaveBeenCalled();
      expect(mocks.terminalIO.deliverImmediate).not.toHaveBeenCalled();
    });

    it('default adapter (no seed mode): paste path preserved, initialPrompt stays undefined (regression)', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      // mocks.adapter.initialPromptSeedMode is undefined by default
      mocks.storage.getInitialSessionPrompt.mockResolvedValue({ content: 'Hello {{agent_name}}' });
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      // No launch-time seeding for default providers
      expect(mocks.providerRuntimePreparation.createPlan).toHaveBeenCalledWith(
        expect.objectContaining({ initialPrompt: undefined }),
      );
      // Existing out-of-band paste still happens
      expect(mocks.terminalIO.deliver).toHaveBeenCalled();
      expect(mocks.terminalIO.deliverImmediate).not.toHaveBeenCalled();
    });
  });

  // ── Trust-only project provisioning + MCP drift repair ────────────────
  describe('verifyProvider: project provisioning and MCP drift', () => {
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

    afterEach(() => {
      mockIsProjectProvisioningCapable.mockReturnValue(false);
    });

    it('provisioning-capable provider runs the trust-only path instead of a second full ensureMcp', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      mockIsProjectProvisioningCapable.mockReturnValue(true);
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      const provider = await mocks.storage.getProvider.mock.results[0].value;
      expect(mocks.mcpEnsureService.ensureProjectProvisioning).toHaveBeenCalledWith(
        provider,
        '/tmp/project',
      );
      // No MCP drift (preflight mcpStatus pass): the full ensureMcp must not run.
      expect(mocks.mcpEnsureService.ensureMcp).not.toHaveBeenCalled();
    });

    it('completes provisioning before runtime planning and before the provider command is typed', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      mockIsProjectProvisioningCapable.mockReturnValue(true);
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);

      await runWithTimers(() => pipeline.launch(launchDto));

      const provisionOrder =
        mocks.mcpEnsureService.ensureProjectProvisioning.mock.invocationCallOrder[0];
      expect(provisionOrder).toBeLessThan(
        mocks.providerRuntimePreparation.createPlan.mock.invocationCallOrder[0],
      );
      expect(provisionOrder).toBeLessThan(mocks.terminalIO.typeCommand.mock.invocationCallOrder[0]);
    });

    it('logs provisioning warnings with their fixed code and startup continues', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      const secretSentinel = 'FAKE_SECRET_SENTINEL';
      mockIsProjectProvisioningCapable.mockReturnValue(true);
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);
      mocks.mcpEnsureService.ensureProjectProvisioning.mockResolvedValue({
        success: false,
        warnings: [
          {
            source: 'claude_project_trust',
            level: 'warn',
            message: `Unexpected token near ${secretSentinel}`,
            code: 'CLAUDE_TRUST_PROVISION_FAILED',
          },
        ],
      });

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'CLAUDE_TRUST_PROVISION_FAILED',
          source: 'claude_project_trust',
        }),
        'Project provisioning warning (non-fatal)',
      );
      expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(secretSentinel);
      // Non-fatal: the session still starts and the CLI command is typed.
      expect(mocks.terminalIO.typeCommand).toHaveBeenCalled();
      expect(mocks.eventsService.publish).toHaveBeenCalledWith(
        'session.started',
        expect.objectContaining({ agentId: 'agent-1' }),
      );
    });

    it('a provisioning rejection stays non-fatal and startup continues', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      mockIsProjectProvisioningCapable.mockReturnValue(true);
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);
      mocks.mcpEnsureService.ensureProjectProvisioning.mockRejectedValue(
        new Error('provisioning exploded'),
      );

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ providerName: 'test-provider' }),
        'Project provisioning failed (non-fatal)',
      );
      expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('provisioning exploded');
      expect(mocks.terminalIO.typeCommand).toHaveBeenCalled();
    });

    it('MCP drift still triggers the full ensureMcp and a recheck that clears the drift', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);
      mocks.preflightService.runChecks
        .mockResolvedValueOnce({
          overall: 'pass',
          checks: [],
          providers: [{ id: 'provider-1', mcpStatus: 'fail', mcpMessage: 'not registered' }],
        })
        .mockResolvedValue({
          overall: 'pass',
          checks: [],
          providers: [{ id: 'provider-1', mcpStatus: 'pass' }],
        });

      await runWithTimers(() => pipeline.launch(launchDto));

      expect(mocks.mcpEnsureService.ensureMcp).toHaveBeenCalledTimes(1);
      expect(mocks.preflightService.runChecks).toHaveBeenCalledTimes(2);
      expect(mocks.eventsService.publish).toHaveBeenCalledWith(
        'session.started',
        expect.objectContaining({ agentId: 'agent-1' }),
      );
    });

    it('unresolved MCP drift blocks the launch after the ensure-and-recheck retry', async () => {
      const { pipeline, mocks } = createLaunchPipelineHarness();
      mocks.sqliteMock.prepare.mockImplementation(noRunningSelect);
      mocks.preflightService.runChecks.mockResolvedValue({
        overall: 'pass',
        checks: [],
        providers: [{ id: 'provider-1', mcpStatus: 'fail', mcpMessage: 'still not registered' }],
      });

      await expect(runWithTimers(() => pipeline.launch(launchDto))).rejects.toThrow(
        'MCP configuration failed after auto-ensure',
      );

      expect(mocks.mcpEnsureService.ensureMcp).toHaveBeenCalledTimes(1);
      expect(mocks.preflightService.runChecks).toHaveBeenCalledTimes(2);
      expect(mocks.terminalIO.typeCommand).not.toHaveBeenCalled();
      const insertCalls = mocks.sqliteMock.prepare.mock.calls.filter(([sql]: [string]) =>
        sql.includes('INSERT INTO sessions'),
      );
      expect(insertCalls).toHaveLength(0);
    });
  });
});
