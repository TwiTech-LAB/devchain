// Backend integration: real in-memory SQLite is the cheapest layer that proves
// lifecycle publication windows and persisted row cardinality under contention.
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { SessionCoordinatorService } from './session-coordinator.service';
import { SessionsService } from './sessions.service';
import { SessionLaunchPipeline } from './session-runtime/session-launch-pipeline.service';
import { SessionRestorePipeline } from './session-runtime/session-restore-pipeline.service';
import { SessionRuntime } from './session-runtime';
import { SessionLifecycleFacade } from './session-lifecycle-facade.service';
import { EpicTimeStore } from '../../epic-time/services/epic-time.store';
import { TransactionRunner } from '../../storage/db/transaction-runner';
import {
  fakeAgent,
  fakeProfile,
  fakeProfileProviderConfig,
  fakeProject,
  fakeProvider,
} from './session-runtime/__test-utils__/pipeline-harness';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for lifecycle checkpoint');
}

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const RESTORE_SESSION_ID = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-08-08T18:00:00.000Z';
const TEST_TERMINATION = { source: 'web-api' as const, reason: 'user-requested' as const };
const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');

describe('session lifecycle race serialization', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let coordinator: SessionCoordinatorService;
  let store: EpicTimeStore;
  let sessionsService: SessionsService;
  let sessionRuntime: SessionRuntime;
  let facade: SessionLifecycleFacade;
  let createGate: Deferred | null;
  let nowMs: number;
  let liveTmux: Set<string>;

  let terminalIO: {
    createEmptySession: jest.Mock;
    destroySession: jest.Mock;
    destroyExpectedSession: jest.Mock;
    setAlternateScreen: jest.Mock;
    typeCommand: jest.Mock;
    waitForOutput: jest.Mock;
    deliver: jest.Mock;
    deliverImmediate: jest.Mock;
    sessionExists: jest.Mock;
    startHealthCheck: jest.Mock;
  };
  let ptyService: { startStreaming: jest.Mock; stopStreaming: jest.Mock };
  let terminalSessionRegistry: {
    create: jest.Mock;
    bind: jest.Mock;
    dispose: jest.Mock;
    get: jest.Mock;
  };
  let eventsService: { publish: jest.Mock };
  let runtimeContextCapture: {
    rotateEpoch: jest.Mock;
    clear: jest.Mock;
    snapshot: jest.Mock;
    restoreSnapshot: jest.Mock;
  };
  let claudeLaunchSettings: {
    prepare: jest.Mock;
    cleanupSession: jest.Mock;
    cleanupSessionSync: jest.Mock;
  };
  let codexPluginProfiles: {
    prepare: jest.Mock;
    buildHelperArgv: jest.Mock;
    awaitAcknowledgement: jest.Mock;
    cleanupPrepared: jest.Mock;
    cleanupSession: jest.Mock;
  };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    db = drizzle(sqlite);
    coordinator = new SessionCoordinatorService();
    store = new EpicTimeStore(db);
    createGate = null;
    nowMs = Date.parse(NOW);
    liveTmux = new Set<string>();
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);

    terminalIO = {
      createEmptySession: jest.fn().mockImplementation(async (name: string) => {
        const gate = createGate;
        createGate = null;
        if (gate) await gate.promise;
        liveTmux.add(name);
        return { name };
      }),
      destroySession: jest.fn().mockImplementation(async ({ name }: { name: string }) => {
        liveTmux.delete(name);
      }),
      destroyExpectedSession: jest.fn().mockImplementation(async ({ name }: { name: string }) => {
        if (!liveTmux.delete(name)) return { outcome: 'known-absent' };
        return { outcome: 'destroyed' };
      }),
      setAlternateScreen: jest.fn().mockResolvedValue(undefined),
      typeCommand: jest.fn().mockResolvedValue(undefined),
      waitForOutput: jest.fn().mockImplementation(async () => {
        nowMs += 7_000;
        return true;
      }),
      deliver: jest.fn().mockResolvedValue(undefined),
      deliverImmediate: jest.fn().mockResolvedValue(undefined),
      sessionExists: jest
        .fn()
        .mockImplementation(async ({ name }: { name: string }) => liveTmux.has(name)),
      startHealthCheck: jest.fn(),
    };
    ptyService = {
      startStreaming: jest.fn().mockResolvedValue(undefined),
      stopStreaming: jest.fn(),
    };
    terminalSessionRegistry = {
      create: jest.fn(),
      bind: jest.fn(),
      dispose: jest.fn(),
      get: jest.fn().mockReturnValue(undefined),
    };
    eventsService = { publish: jest.fn().mockResolvedValue(undefined) };
    runtimeContextCapture = {
      rotateEpoch: jest.fn().mockReturnValue('epoch-1'),
      clear: jest.fn(),
      snapshot: jest.fn().mockReturnValue(null),
      restoreSnapshot: jest.fn(),
    };
    claudeLaunchSettings = {
      prepare: jest.fn().mockResolvedValue({
        optionArgs: [],
        runtimeEnv: {},
        captureEnabled: false,
      }),
      cleanupSession: jest.fn().mockResolvedValue(undefined),
      cleanupSessionSync: jest.fn(),
    };
    codexPluginProfiles = {
      prepare: jest.fn().mockResolvedValue(null),
      buildHelperArgv: jest.fn(),
      awaitAcknowledgement: jest.fn().mockResolvedValue('/tmp/codex-profile'),
      cleanupPrepared: jest.fn().mockResolvedValue(undefined),
      cleanupSession: jest.fn().mockResolvedValue(undefined),
    };

    const agent = fakeAgent({ id: AGENT_ID, projectId: PROJECT_ID, epicId: null });
    const project = fakeProject({ id: PROJECT_ID });
    const profile = fakeProfile();
    const provider = fakeProvider({ name: 'test-provider' });
    const config = fakeProfileProviderConfig();
    const storage = {
      getAgent: jest.fn().mockResolvedValue(agent),
      getProject: jest.fn().mockResolvedValue(project),
      getEpic: jest.fn().mockRejectedValue(new Error('no epic')),
      getAgentProfile: jest.fn().mockResolvedValue(profile),
      getProvider: jest.fn().mockResolvedValue(provider),
      getProviderEnvForProject: jest.fn().mockReturnValue(null),
      getInitialSessionPrompt: jest.fn().mockResolvedValue(null),
      listProfileProviderConfigsByProfile: jest.fn().mockResolvedValue([config]),
      listAgents: jest.fn().mockResolvedValue({ items: [agent], total: 1, limit: 100, offset: 0 }),
    };
    const adapter = {
      providerName: 'test-provider',
      buildLaunchArgs: jest
        .fn()
        .mockImplementation((input: { mode: 'new' | 'restore'; providerSessionId?: string }) => ({
          argv:
            input.mode === 'restore'
              ? ['--resume', input.providerSessionId!]
              : ['--session', 'new'],
        })),
    };
    const providerAdapterFactory = { getAdapter: jest.fn().mockReturnValue(adapter) };
    const hooksConfigService = { ensureHooksConfig: jest.fn().mockResolvedValue(undefined) };
    const copilotHooksConfigService = {
      providerName: 'copilot',
      ensureHooksConfig: jest.fn().mockResolvedValue(undefined),
    };
    const preflightService = {
      runChecks: jest.fn().mockResolvedValue({ overall: 'pass', checks: [], providers: [] }),
    };
    const mcpEnsureService = { ensureMcp: jest.fn().mockResolvedValue(undefined) };
    const teamsStore = { listTeamsByAgent: jest.fn().mockResolvedValue([]) };
    const streamService = {
      cancelScheduledClear: jest.fn().mockReturnValue(null),
      scheduleClear: jest.fn(),
    };
    const providerRuntimePreparation = {
      createPlan: jest.fn().mockImplementation(async (input) => input),
      materialize: jest.fn().mockImplementation(async (plan) => ({
        config: {
          argv:
            plan.mode === 'restore' ? ['--resume', plan.providerSessionId] : ['--session', 'new'],
          commandArgs:
            plan.mode === 'restore' ? ['--resume', plan.providerSessionId] : ['--session', 'new'],
          env: null,
          contextWindowOverride: null,
        },
        afterCommand: jest.fn().mockResolvedValue(undefined),
        rollback: jest.fn().mockResolvedValue(undefined),
      })),
    };

    const launchPipeline = new SessionLaunchPipeline(
      db,
      storage as never,
      coordinator,
      providerAdapterFactory as never,
      terminalIO as never,
      ptyService as never,
      terminalSessionRegistry as never,
      hooksConfigService as never,
      copilotHooksConfigService as never,
      preflightService as never,
      mcpEnsureService as never,
      eventsService as never,
      teamsStore as never,
      runtimeContextCapture as never,
      codexPluginProfiles as never,
      providerRuntimePreparation as never,
    );
    const restorePipeline = new SessionRestorePipeline(
      db,
      storage as never,
      coordinator,
      providerAdapterFactory as never,
      terminalIO as never,
      ptyService as never,
      terminalSessionRegistry as never,
      eventsService as never,
      streamService as never,
      providerRuntimePreparation as never,
    );
    sessionRuntime = new SessionRuntime(launchPipeline, restorePipeline);
    sessionsService = new SessionsService(
      db,
      storage as never,
      terminalIO as never,
      ptyService as never,
      preflightService as never,
      mcpEnsureService as never,
      coordinator,
      hooksConfigService as never,
      providerAdapterFactory as never,
      eventsService as never,
      terminalSessionRegistry as never,
      runtimeContextCapture as never,
      claudeLaunchSettings as never,
      codexPluginProfiles as never,
      store,
    );
    facade = new SessionLifecycleFacade(sessionRuntime, sessionsService);
    seedAgentFixtures();
  });

  /**
   * The migrated schema enforces foreign keys, so the agent/project fixture
   * chain behind every session row in this suite must really exist.
   */
  function seedAgentFixtures(): void {
    const createdAt = '2026-01-01T00:00:00.000Z';
    sqlite
      .prepare(
        `INSERT INTO projects
           (id, workspace_id, name, root_path, is_template, is_private, created_at, updated_at)
         VALUES (?, '0defa017-0000-4000-8000-000000000001', 'Race', '/tmp/race', 0, 0, ?, ?)`,
      )
      .run(PROJECT_ID, createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO providers (id, name, mcp_configured, created_at, updated_at)
         VALUES ('provider-race', 'test-provider', 0, ?, ?)`,
      )
      .run(createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, project_id, name, created_at, updated_at)
         VALUES ('profile-race', ?, 'Race profile', ?, ?)`,
      )
      .run(PROJECT_ID, createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO profile_provider_configs
           (id, profile_id, provider_id, name, position, created_at, updated_at)
         VALUES ('config-race', 'profile-race', 'provider-race', 'Race config', 0, ?, ?)`,
      )
      .run(createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO agents
           (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
         VALUES (?, ?, 'profile-race', 'config-race', 'Coder', ?, ?)`,
      )
      .run(AGENT_ID, PROJECT_ID, createdAt, createdAt);
  }

  afterEach(() => {
    jest.restoreAllMocks();
    sqlite.close();
  });

  function seedRestorableSession(): void {
    sqlite
      .prepare(
        `INSERT INTO sessions
          (id, agent_id, status, provider_session_id, provider_name_at_launch,
           started_at, ended_at, created_at, updated_at)
         VALUES (?, ?, 'stopped', ?, 'test-provider', ?, ?, ?, ?)`,
      )
      .run(RESTORE_SESSION_ID, AGENT_ID, 'provider-session-1', NOW, NOW, NOW, NOW);
  }

  function readRows(): Array<{ id: string; tmux_session_id: string; status: string }> {
    return sqlite
      .prepare(
        `SELECT id, tmux_session_id, status FROM sessions
         WHERE agent_id = ? ORDER BY started_at DESC, id DESC`,
      )
      .all(AGENT_ID) as Array<{ id: string; tmux_session_id: string; status: string }>;
  }

  it('keeps parallel active-session reads pure during a fresh launch publication window', async () => {
    const gate = deferred();
    createGate = gate;
    const launch = sessionRuntime.launch({ agentId: AGENT_ID, projectId: PROJECT_ID });
    await waitFor(() => terminalIO.createEmptySession.mock.calls.length === 1);
    const exactTmux = terminalIO.createEmptySession.mock.calls[0][0] as string;

    const reads = await Promise.all([
      sessionsService.listActiveSessions(),
      sessionsService.listActiveSessions(),
      sessionsService.listActiveSessions(),
    ]);

    for (const result of reads) {
      expect(result).toEqual([
        expect.objectContaining({ agentId: AGENT_ID, status: 'running', tmuxSessionId: exactTmux }),
      ]);
    }
    expect(terminalIO.sessionExists).not.toHaveBeenCalled();
    expect(ptyService.stopStreaming).not.toHaveBeenCalled();
    expect(terminalSessionRegistry.dispose).not.toHaveBeenCalled();
    expect(runtimeContextCapture.clear).not.toHaveBeenCalled();
    expect(claudeLaunchSettings.cleanupSessionSync).not.toHaveBeenCalled();
    expect(codexPluginProfiles.cleanupSession).not.toHaveBeenCalled();

    gate.resolve();
    const launched = await launch;
    expect(readRows()).toEqual([
      { id: launched.id, tmux_session_id: exactTmux, status: 'running' },
    ]);
    expect(liveTmux).toEqual(new Set([exactTmux]));
  });

  it('keeps active-session reads pure during restore and preserves the exact replacement tmux', async () => {
    seedRestorableSession();
    const gate = deferred();
    createGate = gate;
    const restore = sessionRuntime.restore(RESTORE_SESSION_ID, PROJECT_ID);
    await waitFor(() => terminalIO.createEmptySession.mock.calls.length === 1);
    const exactTmux = terminalIO.createEmptySession.mock.calls[0][0] as string;

    const reads = await Promise.all([
      sessionsService.listActiveSessions(),
      sessionsService.listActiveSessions(),
    ]);
    for (const result of reads) {
      expect(result).toEqual([
        expect.objectContaining({
          id: RESTORE_SESSION_ID,
          status: 'running',
          tmuxSessionId: exactTmux,
        }),
      ]);
    }
    expect(terminalIO.sessionExists).not.toHaveBeenCalled();
    expect(runtimeContextCapture.clear).not.toHaveBeenCalled();

    gate.resolve();
    await restore;
    expect(readRows()).toEqual([
      { id: RESTORE_SESSION_ID, tmux_session_id: exactTmux, status: 'running' },
    ]);
    expect(liveTmux).toEqual(new Set([exactTmux]));
  });

  it('queues termination behind launch and never publishes started after stopped', async () => {
    const gate = deferred();
    createGate = gate;
    const launch = sessionRuntime.launch({ agentId: AGENT_ID, projectId: PROJECT_ID });
    await waitFor(() => terminalIO.createEmptySession.mock.calls.length === 1);
    const exactTmux = terminalIO.createEmptySession.mock.calls[0][0] as string;
    const sessionId = readRows()[0].id;

    const terminate = sessionsService.terminateSession(sessionId, TEST_TERMINATION);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminalIO.sessionExists).not.toHaveBeenCalled();
    expect(ptyService.stopStreaming).not.toHaveBeenCalled();
    expect(runtimeContextCapture.clear).not.toHaveBeenCalled();

    gate.resolve();
    await launch;
    await terminate;

    expect(terminalIO.destroyExpectedSession).toHaveBeenCalledWith(
      { name: exactTmux },
      { onUnknownError: 'rearm', sessionId },
    );
    expect(liveTmux).not.toContain(exactTmux);
    expect(readRows()).toEqual([{ id: sessionId, tmux_session_id: exactTmux, status: 'stopped' }]);
    const eventNames = eventsService.publish.mock.calls.map(([name]) => name);
    expect(eventNames.indexOf('session.started')).toBeLessThan(
      eventNames.indexOf('session.stopped'),
    );
  });

  it('queues every termination artifact cleanup behind a held restore lock', async () => {
    seedRestorableSession();
    const gate = deferred();
    createGate = gate;
    const restore = sessionRuntime.restore(RESTORE_SESSION_ID, PROJECT_ID);
    await waitFor(() => terminalIO.createEmptySession.mock.calls.length === 1);
    const exactTmux = terminalIO.createEmptySession.mock.calls[0][0] as string;

    const terminate = sessionsService.terminateSession(RESTORE_SESSION_ID, TEST_TERMINATION);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminalIO.sessionExists).not.toHaveBeenCalled();
    expect(ptyService.stopStreaming).not.toHaveBeenCalled();
    expect(terminalSessionRegistry.dispose).not.toHaveBeenCalled();
    expect(runtimeContextCapture.clear).not.toHaveBeenCalled();
    expect(claudeLaunchSettings.cleanupSessionSync).not.toHaveBeenCalled();
    expect(codexPluginProfiles.cleanupSession).not.toHaveBeenCalled();

    gate.resolve();
    await restore;
    await terminate;

    expect(terminalIO.destroyExpectedSession).toHaveBeenCalledWith(
      { name: exactTmux },
      { onUnknownError: 'rearm', sessionId: RESTORE_SESSION_ID },
    );
    expect(readRows()).toEqual([
      { id: RESTORE_SESSION_ID, tmux_session_id: exactTmux, status: 'stopped' },
    ]);
  });

  it('uses sequential terminate and launch acquisitions for restart during launch', async () => {
    const gate = deferred();
    createGate = gate;
    const firstLaunch = sessionRuntime.launch({ agentId: AGENT_ID, projectId: PROJECT_ID });
    await waitFor(() => terminalIO.createEmptySession.mock.calls.length === 1);
    const oldTmux = terminalIO.createEmptySession.mock.calls[0][0] as string;
    const oldSessionId = readRows()[0].id;

    const restart = facade.restart(AGENT_ID, PROJECT_ID);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminalIO.destroyExpectedSession).not.toHaveBeenCalled();

    gate.resolve();
    await firstLaunch;
    const replacement = await restart;
    const replacementTmux = terminalIO.createEmptySession.mock.calls[1][0] as string;

    expect(replacement.id).not.toBe(oldSessionId);
    expect(terminalIO.destroyExpectedSession).toHaveBeenCalledWith(
      { name: oldTmux },
      { onUnknownError: 'rearm', sessionId: oldSessionId },
    );
    expect(liveTmux.has(oldTmux)).toBe(false);
    expect(liveTmux).toEqual(new Set([replacementTmux]));
    expect(readRows()).toEqual(
      expect.arrayContaining([
        { id: replacement.id, tmux_session_id: replacementTmux, status: 'running' },
        { id: oldSessionId, tmux_session_id: oldTmux, status: 'stopped' },
      ]),
    );
  });

  it('keeps the durable row and runtime/provider artifacts intact on unknown destroy failure', async () => {
    sqlite
      .prepare(
        `INSERT INTO sessions
          (id, agent_id, tmux_session_id, status, provider_name_at_launch,
           started_at, created_at, updated_at)
         VALUES (?, ?, ?, 'running', 'test-provider', ?, ?, ?)`,
      )
      .run(RESTORE_SESSION_ID, AGENT_ID, 'tmux-unknown', NOW, NOW, NOW);
    liveTmux.add('tmux-unknown');
    terminalIO.destroyExpectedSession.mockResolvedValueOnce({
      outcome: 'unknown-error',
      error: new Error('unknown destroy failure'),
    });

    await expect(
      sessionsService.terminateSession(RESTORE_SESSION_ID, TEST_TERMINATION),
    ).rejects.toThrow('unknown destroy failure');

    expect(readRows()).toEqual([
      { id: RESTORE_SESSION_ID, tmux_session_id: 'tmux-unknown', status: 'running' },
    ]);
    expect(liveTmux).toEqual(new Set(['tmux-unknown']));
    expect(ptyService.stopStreaming).not.toHaveBeenCalled();
    expect(terminalSessionRegistry.dispose).not.toHaveBeenCalled();
    expect(runtimeContextCapture.clear).not.toHaveBeenCalled();
    expect(claudeLaunchSettings.cleanupSessionSync).not.toHaveBeenCalled();
    expect(codexPluginProfiles.cleanupSession).not.toHaveBeenCalled();
  });

  it('blocks a same-agent restart behind the queued stop/reset transaction and preserves replacement time', async () => {
    // A running session with tracked activity: the termination must
    // reconcile its final activity and clear the agent's settled balance.
    sqlite
      .prepare(
        `INSERT INTO sessions
           (id, agent_id, tmux_session_id, status, started_at, last_activity_at,
            activity_state, busy_since, created_at, updated_at)
         VALUES ('session-race', ?, 'tmux-race', 'running', ?, ?, 'busy', ?, ?, ?)`,
      )
      .run(
        AGENT_ID,
        '2026-01-01T00:00:10.000Z',
        '2026-01-01T00:00:12.000Z',
        '2026-01-01T00:00:11.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
    liveTmux.add('tmux-race');

    const activation = await store.activate(new Date('2026-01-01T00:00:10.000Z'));
    await store.reconcileSession(
      'session-race',
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date('2026-01-01T00:00:12.000Z'),
    );
    // Final activity at T2 is only reconciled by termination itself, and one
    // settled row rounds out the balance the reset must clear.
    sqlite
      .prepare(`UPDATE sessions SET last_activity_at = ?, updated_at = ? WHERE id = ?`)
      .run('2026-01-01T00:00:16.000Z', '2026-01-01T00:00:16.000Z', 'session-race');
    sqlite
      .prepare(
        `INSERT INTO epic_time_segments
           (id, project_id, epic_id, session_id_snapshot, agent_id_snapshot,
            agent_name_snapshot, started_at, last_activity_at, closed_at,
            duration_ms, created_at, updated_at)
         VALUES ('race-settled', ?, NULL, 'session-race-older', ?, 'Coder',
                 '2026-01-01T00:01:00.000Z', '2026-01-01T00:02:30.000Z',
                 '2026-01-01T00:02:30.000Z', 90000, '2026-01-01T00:02:30.000Z',
                 '2026-01-01T00:02:30.000Z')`,
      )
      .run(PROJECT_ID, AGENT_ID);

    // Hold the shared per-client transaction queue so termination parks with
    // the agent lock held, its stop/reset transaction not yet committed.
    const queueGate = deferred();
    const hold = new TransactionRunner(sqlite).runImmediateAsync(async () => {
      await queueGate.promise;
      return true;
    });

    const terminate = sessionsService.terminateSession('session-race', TEST_TERMINATION);
    await waitFor(() => terminalIO.destroyExpectedSession.mock.calls.length === 1);

    let restartSettled = false;
    const restart = facade.restart(AGENT_ID, PROJECT_ID).then((result) => {
      restartSettled = true;
      return result;
    });
    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // While the stop/reset transaction is parked, the restart replacement is
    // blocked behind the agent lock: no replacement terminal, no durable row
    // change, and no lifecycle event from either operation.
    expect(restartSettled).toBe(false);
    expect(terminalIO.createEmptySession).not.toHaveBeenCalled();
    expect(readRows()).toEqual([
      { id: 'session-race', tmux_session_id: 'tmux-race', status: 'running' },
    ]);
    expect(eventsService.publish).not.toHaveBeenCalled();

    queueGate.resolve();
    await hold;
    await terminate;
    const replacement = await restart;

    // The parked reset committed with the stop before the replacement could
    // start: the old row is stopped, the agent's settled unlogged rows are
    // gone, and the replacement is running on a fresh terminal.
    expect(replacement.id).not.toBe('session-race');
    expect(readRows()).toEqual(
      expect.arrayContaining([
        { id: 'session-race', tmux_session_id: 'tmux-race', status: 'stopped' },
        { id: replacement.id, tmux_session_id: expect.any(String), status: 'running' },
      ]),
    );
    expect(sqlite.prepare(`SELECT id FROM epic_time_segments ORDER BY id`).all()).toEqual([]);
    expect(
      sqlite
        .prepare(`SELECT last_activity_at FROM epic_time_session_watermarks WHERE session_id = ?`)
        .get('session-race'),
    ).toEqual({ last_activity_at: '2026-01-01T00:00:16.000Z' });
    const eventNames = eventsService.publish.mock.calls.map(([name]) => name);
    expect(eventNames.indexOf('session.stopped')).toBeLessThan(
      eventNames.indexOf('session.started'),
    );

    // Fresh activity on the replacement accumulates normally and survives a
    // full sweep: the completed reset can never touch the new time.
    const T3 = '2026-01-01T00:01:20.000Z';
    const T4 = '2026-01-01T00:01:22.000Z';
    sqlite
      .prepare(
        `UPDATE sessions
         SET started_at = ?, last_activity_at = ?, busy_since = ?, activity_state = 'busy',
             updated_at = ?
         WHERE id = ?`,
      )
      .run('2026-01-01T00:00:10.000Z', T4, T3, T4, replacement.id);
    await store.reconcileSession(
      replacement.id,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date(T4),
    );
    for (const sessionId of store.listReconciliationSessionIds(activation.trackingStartedAt)) {
      await store.reconcileSession(
        sessionId,
        activation.trackingStartedAt,
        activation.idleTimeoutMs,
        new Date(T4),
      );
    }
    await store.processTeamBatches('epic-time-accounting', activation.idleTimeoutMs, new Date(T4));

    expect(
      sqlite
        .prepare(
          `SELECT agent_id_snapshot, epic_id, closed_at, duration_ms FROM epic_time_segments`,
        )
        .all(),
    ).toEqual([{ agent_id_snapshot: AGENT_ID, epic_id: null, closed_at: null, duration_ms: 2000 }]);
    expect(
      sqlite
        .prepare(`SELECT last_activity_at FROM epic_time_session_watermarks WHERE session_id = ?`)
        .get('session-race'),
    ).toEqual({ last_activity_at: '2026-01-01T00:00:16.000Z' });
  });
});
