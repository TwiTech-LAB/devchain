import Database from 'better-sqlite3';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { EventsService } from '../../../events/services/events.service';
import { SessionTerminalRuntimeService } from '../../../session-terminal-runtime/session-terminal-runtime.service';
import { TerminalGateway } from '../../gateways/terminal.gateway';
import { FakeProcessExecutor } from '../process-executor/fake-process-executor';
import { TerminalIOService } from './terminal-io.service';
import { HumanPromptStateService } from '../human-prompt-state.service';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

async function settle(): Promise<void> {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
}

describe('terminal crash publication retry', () => {
  let sqlite: Database.Database;
  let terminalIO: TerminalIOService;

  beforeEach(() => {
    jest.useFakeTimers();
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        tmux_session_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
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
    terminalIO = new TerminalIOService(executor, events, new HumanPromptStateService());

    const sessionTerminalRuntime = new SessionTerminalRuntimeService(
      db,
      {} as never,
      { clear: jest.fn() } as never,
      { cleanupSessionSync: jest.fn() } as never,
      { cleanupSession: jest.fn().mockResolvedValue(undefined) } as never,
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
});
