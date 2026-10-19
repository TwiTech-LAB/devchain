import { SessionRowStore } from '../../../storage/sessions/session-row.store';
import Database from 'better-sqlite3';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { EventsService } from '../../../events/services/events.service';
import type { SettingsService } from '../../../settings/services/settings.service';
import { SessionTerminalRuntimeService } from '../../../session-terminal-runtime/session-terminal-runtime.service';
import { TerminalGateway } from '../../gateways/terminal.gateway';
import {
  CliForegroundExecutor,
  FakeProcessExecutor,
} from '../process-executor/fake-process-executor';
import { TerminalIOService } from './terminal-io.service';
import { HumanPromptStateService } from '../human-prompt-state.service';
import { SessionRestorePipeline } from '../../../sessions/services/session-runtime/session-restore-pipeline.service';
import { SessionCoordinatorService } from '../../../sessions/services/session-coordinator.service';
import {
  fakeAgent,
  fakeProfile,
  fakeProfileProviderConfig,
  fakeProject,
  fakeProvider,
} from '../../../sessions/services/session-runtime/__test-utils__/pipeline-harness';
import { buildTmuxSessionName } from '../../../sessions/utils/tmux-naming.util';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

async function settle(): Promise<void> {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
}

function bindCrashListener(db: BetterSQLite3Database, emitter: EventEmitter2) {
  const sessionTerminalRuntime = new SessionTerminalRuntimeService(
    db,
    {} as never,
    { clear: jest.fn() } as never,
    { cleanupSessionSync: jest.fn() } as never,
    { cleanupSession: jest.fn().mockResolvedValue(undefined) } as never,
    new SessionRowStore(db),
  );
  const gateway = Object.create(TerminalGateway.prototype) as TerminalGateway;
  const cleanupSessionLifecycle = jest.fn();
  const emit = jest.fn();
  Object.defineProperties(gateway, {
    sessionTerminalRuntime: { value: sessionTerminalRuntime },
    cleanupSessionLifecycle: { value: cleanupSessionLifecycle },
    server: { value: { to: jest.fn().mockReturnValue({ emit }) } },
  });
  emitter.on('session.crashed', (payload) => gateway.handleSessionCrashed(payload));
  return { cleanupSessionLifecycle, emit };
}

describe('terminal crash publication', () => {
  let sqlite: Database.Database;
  let terminalIO: TerminalIOService;

  beforeEach(() => {
    jest.useFakeTimers();
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        epic_id TEXT,
        tmux_session_id TEXT,
        provider_session_id TEXT DEFAULT 'provider-session-1',
        provider_name_at_launch TEXT DEFAULT 'test-provider',
        transcript_path TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        last_activity_at TEXT,
        created_at TEXT DEFAULT '2026-08-08T18:00:00.000Z',
        updated_at TEXT NOT NULL
      );
      INSERT INTO sessions
        (id, agent_id, tmux_session_id, status, started_at, updated_at)
      VALUES
        ('session-1', 'agent-1', 'tmux-1', 'running', '2026-08-08T18:00:00.000Z',
         '2026-08-08T18:00:00.000Z');
    `);
  });

  afterEach(() => {
    terminalIO?.beforeApplicationShutdown();
    sqlite.close();
    jest.useRealTimers();
  });

  it('retries failed event persistence and reaches TerminalGateway exactly once', async () => {
    const db = drizzle(sqlite) as BetterSQLite3Database;
    const emitter = new EventEmitter2();
    const eventLogService = {
      recordPublished: jest
        .fn()
        .mockRejectedValueOnce(new Error('event store unavailable'))
        .mockResolvedValueOnce({ id: 'event-2' }),
    };
    const events = new EventsService(emitter, eventLogService as never);
    const executor = new FakeProcessExecutor();
    executor.setDefaultResponse({ type: 'failure', stderr: `can't find session: tmux-1` });
    const settings = { getFollowNoteEnabled: () => true } as unknown as SettingsService;
    terminalIO = new TerminalIOService(executor, events, new HumanPromptStateService(), settings);

    const { cleanupSessionLifecycle, emit } = bindCrashListener(db, emitter);

    terminalIO.startHealthCheck('tmux-1', 'session-1', 10);
    jest.advanceTimersByTime(10);
    await settle();

    expect(eventLogService.recordPublished).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare(`SELECT status FROM sessions WHERE id = 'session-1'`).get()).toEqual({
      status: 'running',
    });

    jest.advanceTimersByTime(10);
    await settle();

    expect(eventLogService.recordPublished).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare(`SELECT status FROM sessions WHERE id = 'session-1'`).get()).toEqual({
      status: 'failed',
    });
    expect(cleanupSessionLifecycle).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(100);
    await settle();
    expect(eventLogService.recordPublished).toHaveBeenCalledTimes(2);
  });

  // Real SQLite, event dispatch and restore are needed to prove the persisted lifecycle and name reuse.
  it('marks an exited CLI failed through Gateway and restores the same tmux name', async () => {
    const db = drizzle(sqlite);
    const emitter = new EventEmitter2();
    const events = new EventsService(emitter, {
      recordPublished: jest.fn().mockResolvedValue({ id: 'event-1' }),
    } as never);
    const { cleanupSessionLifecycle } = bindCrashListener(db, emitter);
    const project = fakeProject();
    const agent = fakeAgent();
    const tmuxName = buildTmuxSessionName('testproject', 'independent', agent.id, 'session-1');
    sqlite.prepare('UPDATE sessions SET tmux_session_id = ?').run(tmuxName);
    const liveNames = new Set([tmuxName]);
    const executor = new CliForegroundExecutor();
    const run = executor.run.bind(executor);
    jest.spyOn(executor, 'run').mockImplementation(async (options) => {
      const command = options.argv[1];
      if (
        options.argv[0] !== 'tmux' ||
        !['has-session', 'kill-session', 'new-session'].includes(command)
      ) {
        return run(options);
      }
      executor.calls.push(options);
      const name =
        command === 'new-session'
          ? options.argv[options.argv.indexOf('-s') + 1]
          : options.argv[options.argv.indexOf('-t') + 1].slice(1);
      const success = command === 'new-session' ? !liveNames.has(name) : liveNames.has(name);
      if (success && command === 'new-session') liveNames.add(name);
      if (success && command === 'kill-session') liveNames.delete(name);
      return {
        success,
        exitCode: success ? 0 : 1,
        stdout: '',
        stderr: success ? '' : `can't find session: ${name}`,
        timedOut: false,
        truncated: false,
      };
    });
    terminalIO = new TerminalIOService(executor, events, new HumanPromptStateService(), {
      getFollowNoteEnabled: () => true,
    } as SettingsService);
    const crashed = jest.fn();
    emitter.on('session.crashed', crashed);
    terminalIO.startHealthCheck(tmuxName, 'session-1');
    await jest.advanceTimersByTimeAsync(5000);
    executor.foregroundGroup = '1234';
    await jest.advanceTimersByTimeAsync(10_000);
    expect(sqlite.prepare('SELECT status FROM sessions').get()).toEqual({ status: 'running' });
    await jest.advanceTimersByTimeAsync(5000);
    expect(sqlite.prepare('SELECT status FROM sessions').get()).toEqual({ status: 'failed' });
    expect(liveNames.has(tmuxName)).toBe(false);
    expect(crashed).toHaveBeenCalledTimes(1);
    expect(crashed).toHaveBeenCalledWith({ sessionId: 'session-1', sessionName: tmuxName });
    expect(cleanupSessionLifecycle).toHaveBeenCalledTimes(1);

    const restore = new SessionRestorePipeline(
      db,
      {
        getAgent: jest.fn().mockResolvedValue(agent),
        getProject: jest.fn().mockResolvedValue(project),
        getAgentProfile: jest.fn().mockResolvedValue(fakeProfile()),
        listProfileProviderConfigsByProfile: jest
          .fn()
          .mockResolvedValue([fakeProfileProviderConfig()]),
        getProvider: jest.fn().mockResolvedValue(fakeProvider()),
        getProviderEnvForProject: jest.fn().mockReturnValue(null),
      } as never,
      new SessionCoordinatorService(),
      { getAdapter: jest.fn().mockReturnValue({}) } as never,
      terminalIO,
      { startStreaming: jest.fn().mockResolvedValue(undefined), stopStreaming: jest.fn() } as never,
      { get: jest.fn(), create: jest.fn(), bind: jest.fn(), dispose: jest.fn() } as never,
      events,
      { cancelScheduledClear: jest.fn().mockReturnValue(null) } as never,
      {
        createPlan: jest.fn().mockResolvedValue({}),
        materialize: jest.fn().mockResolvedValue({
          config: { commandArgs: ['test-provider', '--resume', 'provider-session-1'] },
          typedArgs: ['/bin/sh', '/private/launch/restore.sh'],
          rollback: jest.fn(),
          afterCommand: jest.fn().mockResolvedValue(undefined),
        }),
      } as never,
      { runChecks: jest.fn().mockResolvedValue({ overall: 'pass' }) } as never,
      {} as never,
      new SessionRowStore(db),
    );
    executor.foregroundGroup = '2345';
    await expect(restore.restore('session-1', project.id)).resolves.toMatchObject({
      id: 'session-1',
      status: 'running',
      tmuxSessionId: tmuxName,
    });
    expect(liveNames.has(tmuxName)).toBe(true);
    expect(sqlite.prepare('SELECT status, tmux_session_id, ended_at FROM sessions').get()).toEqual({
      status: 'running',
      tmux_session_id: tmuxName,
      ended_at: null,
    });
    expect(crashed).toHaveBeenCalledTimes(1);
  });
});
