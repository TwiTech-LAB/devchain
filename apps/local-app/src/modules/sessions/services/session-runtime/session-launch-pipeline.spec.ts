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
  isContextWindowCapable: () => false,
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

import { createLaunchPipelineHarness } from './__test-utils__/pipeline-harness';

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
      expect(mocks.eventsService.publish).toHaveBeenCalledWith(
        'session.started',
        expect.objectContaining({ agentId: 'agent-1' }),
      );

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
});
