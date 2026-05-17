const mockSessionsLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../../common/logging/logger', () => ({
  createLogger: jest.fn(() => mockSessionsLogger),
}));

import { SessionsService } from './sessions.service';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { PtyService } from '../../terminal/services/pty.service';
import type { PreflightService } from '../../core/services/preflight.service';
import type { ProviderMcpEnsureService } from '../../providers/services/provider-mcp-ensure.service';
import type { EventsService } from '../../events/services/events.service';
import type { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import type { HooksConfigService } from '../../hooks/services/hooks-config.service';
import type { ProviderAdapterFactory } from '../../providers/adapters/provider-adapter.factory';
import { SessionCoordinatorService } from './session-coordinator.service';
import { TerminalSessionRegistry } from '../../terminal/services/terminal-session/terminal-session-registry';

describe('SessionsService', () => {
  let storage: {
    getAgent: jest.Mock;
    getProject: jest.Mock;
    getEpic: jest.Mock;
    getAgentProfile: jest.Mock;
    getProvider: jest.Mock;
    getPrompt: jest.Mock;
    getInitialSessionPrompt: jest.Mock;
    getFeatureFlags: jest.Mock;
    listProfileProviderConfigsByProfile: jest.Mock;
    getProfileProviderConfig: jest.Mock;
    listAgents: jest.Mock;
  };
  let ptyService: { startStreaming: jest.Mock; stopStreaming: jest.Mock };
  let eventsService: { publish: jest.Mock };
  let mockTerminalIO: {
    sessionExists: jest.Mock;
    createEmptySession: jest.Mock;
    disableAlternateScreen: jest.Mock;
    destroySession: jest.Mock;
    typeCommand: jest.Mock;
    waitForOutput: jest.Mock;
    deliver: jest.Mock;
    deliverImmediate: jest.Mock;
    sendControl: jest.Mock;
  };
  let sqlitePrepare: jest.Mock;
  let sqliteExec: jest.Mock;
  let insertRunMock: jest.Mock;
  let providerAdapterFactory: { getAdapter: jest.Mock; getPostPasteDelayMsForAgent: jest.Mock };
  let terminalSessionRegistry: {
    create: jest.Mock;
    bind: jest.Mock;
    dispose: jest.Mock;
    get: jest.Mock;
  };
  let service: SessionsService;

  beforeEach(() => {
    jest.clearAllMocks();

    storage = {
      getAgent: jest.fn(),
      getProject: jest.fn(),
      getEpic: jest.fn(),
      getAgentProfile: jest.fn(),
      getProvider: jest.fn(),
      getPrompt: jest.fn(),
      getInitialSessionPrompt: jest.fn().mockResolvedValue(null),
      getFeatureFlags: jest.fn().mockReturnValue({}),
      listProfileProviderConfigsByProfile: jest.fn().mockResolvedValue([]),
      getProfileProviderConfig: jest.fn(),
      listAgents: jest.fn().mockResolvedValue({ items: [] }),
    };

    ptyService = {
      startStreaming: jest.fn().mockResolvedValue(undefined),
      stopStreaming: jest.fn(),
    };

    eventsService = {
      publish: jest.fn().mockResolvedValue('event-log-id'),
    };

    mockTerminalIO = {
      sessionExists: jest.fn().mockResolvedValue(false),
      createEmptySession: jest.fn().mockResolvedValue({ name: 'tmux-session' }),
      disableAlternateScreen: jest.fn().mockResolvedValue(undefined),
      destroySession: jest.fn().mockResolvedValue(undefined),
      typeCommand: jest.fn().mockResolvedValue(undefined),
      waitForOutput: jest.fn().mockResolvedValue(true),
      deliver: jest.fn().mockResolvedValue({ confirmed: true, nonce: 'abc1234', retryCount: 0 }),
      deliverImmediate: jest
        .fn()
        .mockResolvedValue({ confirmed: true, nonce: 'abc1234', retryCount: 0 }),
      sendControl: jest.fn().mockResolvedValue(undefined),
    };

    insertRunMock = jest.fn();
    sqlitePrepare = jest
      .fn()
      .mockReturnValue({ run: insertRunMock, get: jest.fn(), all: jest.fn().mockReturnValue([]) });
    sqliteExec = jest.fn();

    const dbMock = {
      session: {
        client: {
          prepare: sqlitePrepare,
          exec: sqliteExec,
        },
      },
    } as unknown as BetterSQLite3Database;

    providerAdapterFactory = {
      getAdapter: jest.fn().mockReturnValue({ providerName: 'claude' }),
      getPostPasteDelayMsForAgent: jest.fn().mockResolvedValue(undefined),
    };

    terminalSessionRegistry = {
      create: jest.fn().mockReturnValue({}),
      bind: jest.fn(),
      dispose: jest.fn(),
      get: jest.fn().mockReturnValue(undefined),
    };

    service = new SessionsService(
      dbMock,
      storage as unknown as StorageService,
      mockTerminalIO as unknown as TerminalIOService,
      ptyService as unknown as PtyService,
      {} as unknown as PreflightService,
      {} as unknown as ProviderMcpEnsureService,
      {
        withAgentLock: jest.fn().mockImplementation((_id: string, fn: () => unknown) => fn()),
      } as unknown as SessionCoordinatorService,
      {} as unknown as HooksConfigService,
      providerAdapterFactory as unknown as ProviderAdapterFactory,
      eventsService as unknown as EventsService,
      terminalSessionRegistry as unknown as TerminalSessionRegistry,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('terminateSession', () => {
    it('terminates a running session and broadcasts events', async () => {
      const runningRow = {
        id: 'session-1',
        epic_id: null,
        agent_id: 'agent-1',
        tmux_session_id: 'tmux-session',
        status: 'running',
        started_at: '2024-01-01T00:00:00.000Z',
        ended_at: null,
        last_activity_at: null,
        activity_state: null,
        busy_since: null,
        transcript_path: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn().mockReturnValue(runningRow),
        all: jest.fn().mockReturnValue([]),
      });

      mockTerminalIO.sessionExists.mockResolvedValue(true);

      await service.terminateSession('session-1');

      expect(ptyService.stopStreaming).toHaveBeenCalledWith('session-1');
      expect(terminalSessionRegistry.dispose).toHaveBeenCalledWith('session-1');
      expect(mockTerminalIO.destroySession).toHaveBeenCalledWith({ name: 'tmux-session' });
      expect(eventsService.publish).toHaveBeenCalledWith('session.stopped', {
        sessionId: 'session-1',
      });
      expect(eventsService.publish).toHaveBeenCalledWith(
        'session.presence.changed',
        expect.objectContaining({ agentId: 'agent-1', online: false, sessionId: null }),
      );
    });

    it('treats missing session as already terminated', async () => {
      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn().mockReturnValue(undefined),
        all: jest.fn().mockReturnValue([]),
      });

      await service.terminateSession('nonexistent');
      expect(mockTerminalIO.destroySession).not.toHaveBeenCalled();
    });

    it('treats stopped session as success', async () => {
      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn().mockReturnValue({
          id: 'session-1',
          status: 'stopped',
          agent_id: null,
          tmux_session_id: null,
        }),
        all: jest.fn().mockReturnValue([]),
      });

      await service.terminateSession('session-1');
      expect(ptyService.stopStreaming).not.toHaveBeenCalled();
    });

    it('disposes registry entry in terminateSession', async () => {
      const runningRow = {
        id: 'session-x',
        epic_id: null,
        agent_id: 'agent-1',
        tmux_session_id: 'tmux-session',
        status: 'running',
        started_at: '2024-01-01T00:00:00.000Z',
        ended_at: null,
        last_activity_at: null,
        activity_state: null,
        busy_since: null,
        transcript_path: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn().mockReturnValue(runningRow),
        all: jest.fn().mockReturnValue([]),
      });

      mockTerminalIO.sessionExists.mockResolvedValue(false);

      await service.terminateSession('session-x');

      expect(ptyService.stopStreaming).toHaveBeenCalledWith('session-x');
      expect(terminalSessionRegistry.dispose).toHaveBeenCalledWith('session-x');
    });

    it('dispose is called after stopStreaming in terminateSession', async () => {
      const runningRow = {
        id: 'session-y',
        epic_id: null,
        agent_id: null,
        tmux_session_id: null,
        status: 'running',
        started_at: '2024-01-01T00:00:00.000Z',
        ended_at: null,
        last_activity_at: null,
        activity_state: null,
        busy_since: null,
        transcript_path: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn().mockReturnValue(runningRow),
        all: jest.fn().mockReturnValue([]),
      });

      const callOrder: string[] = [];
      ptyService.stopStreaming.mockImplementation(() => {
        callOrder.push('stopStreaming');
      });
      terminalSessionRegistry.dispose.mockImplementation(() => {
        callOrder.push('dispose');
      });

      await service.terminateSession('session-y');

      expect(callOrder).toEqual(['stopStreaming', 'dispose']);
    });
  });

  describe('getSession', () => {
    it('returns session when found', () => {
      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn().mockReturnValue({
          id: 'session-1',
          epic_id: 'epic-1',
          agent_id: 'agent-1',
          tmux_session_id: 'tmux-1',
          status: 'running',
          started_at: '2024-01-01T00:00:00.000Z',
          ended_at: null,
          last_activity_at: null,
          activity_state: null,
          busy_since: null,
          transcript_path: null,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        }),
        all: jest.fn().mockReturnValue([]),
      });

      const session = service.getSession('session-1');
      expect(session).not.toBeNull();
      expect(session!.id).toBe('session-1');
      expect(session!.epicId).toBe('epic-1');
      expect(session!.agentId).toBe('agent-1');
      expect(session!.status).toBe('running');
    });

    it('returns null when session not found', () => {
      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn().mockReturnValue(undefined),
        all: jest.fn().mockReturnValue([]),
      });

      const session = service.getSession('nonexistent');
      expect(session).toBeNull();
    });
  });

  describe('injectTextIntoSession', () => {
    function mockSessionRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'session-1',
        epic_id: null,
        agent_id: 'agent-1',
        tmux_session_id: 'tmux-1',
        status: 'running',
        started_at: '2024-01-01T00:00:00Z',
        ended_at: null,
        last_activity_at: null,
        activity_state: null,
        busy_since: null,
        transcript_path: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        ...overrides,
      };
    }

    it('throws NotFoundException when session not found', async () => {
      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn().mockReturnValue(undefined),
        all: jest.fn().mockReturnValue([]),
      });

      await expect(service.injectTextIntoSession('nonexistent', 'hello')).rejects.toThrow(
        'Session not found',
      );
    });

    it('throws ValidationError when session not running', async () => {
      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn().mockReturnValue(mockSessionRow({ status: 'stopped' })),
        all: jest.fn().mockReturnValue([]),
      });

      await expect(service.injectTextIntoSession('session-1', 'hello')).rejects.toThrow(
        ValidationError,
      );
    });

    it('throws ValidationError when session has no tmux session', async () => {
      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn().mockReturnValue(mockSessionRow({ tmux_session_id: null })),
        all: jest.fn().mockReturnValue([]),
      });

      await expect(service.injectTextIntoSession('session-1', 'hello')).rejects.toThrow(
        ValidationError,
      );
    });

    it('resolves postPasteDelayMs for Gemini agent and passes to delivery helper', async () => {
      providerAdapterFactory.getPostPasteDelayMsForAgent.mockResolvedValue(1500);
      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn().mockReturnValue(mockSessionRow()),
      });

      await service.injectTextIntoSession('session-1', 'hello');

      expect(providerAdapterFactory.getPostPasteDelayMsForAgent).toHaveBeenCalledWith('agent-1');
      const pasteCall = mockTerminalIO.deliver.mock.calls[0];
      expect(pasteCall[2]).toHaveProperty('postPasteDelayMs', 1500);
    });

    it('passes undefined postPasteDelayMs for Claude agent', async () => {
      providerAdapterFactory.getPostPasteDelayMsForAgent.mockResolvedValue(undefined);
      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn().mockReturnValue(mockSessionRow()),
      });

      await service.injectTextIntoSession('session-1', 'hello');

      const pasteCall = mockTerminalIO.deliver.mock.calls[0];
      expect(pasteCall[2]?.postPasteDelayMs).toBeUndefined();
    });

    it('skips factory call when session has no agentId', async () => {
      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn().mockReturnValue(mockSessionRow({ agent_id: null })),
      });

      await service.injectTextIntoSession('session-1', 'hello');

      expect(providerAdapterFactory.getPostPasteDelayMsForAgent).not.toHaveBeenCalled();
      const pasteCall = mockTerminalIO.deliverImmediate.mock.calls[0];
      expect(pasteCall[2]?.postPasteDelayMs).toBeUndefined();
    });
  });

  describe('getAgentPresence', () => {
    it('returns presence map for agents with sessions', async () => {
      storage.listAgents.mockResolvedValue({
        items: [
          { id: 'agent-1', name: 'Agent 1' },
          { id: 'agent-2', name: 'Agent 2' },
        ],
      });

      // No running sessions
      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn().mockReturnValue(undefined),
        all: jest.fn().mockReturnValue([]),
      });

      const presenceMap = await service.getAgentPresence('project-1');

      expect(presenceMap.get('agent-1')).toEqual({ online: false });
      expect(presenceMap.get('agent-2')).toEqual({ online: false });
    });
  });

  describe('listActiveSessions', () => {
    it('returns empty array when no running sessions', async () => {
      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn().mockReturnValue(undefined),
        all: jest.fn().mockReturnValue([]),
      });

      const sessions = await service.listActiveSessions();
      expect(sessions).toEqual([]);
    });

    it('marks orphaned sessions as stopped', async () => {
      const orphanedRow = {
        id: 'session-1',
        epic_id: null,
        agent_id: 'agent-1',
        tmux_session_id: 'tmux-gone',
        status: 'running',
        started_at: '2024-01-01T00:00:00.000Z',
        ended_at: null,
        last_activity_at: null,
        activity_state: null,
        busy_since: null,
        transcript_path: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn(),
        all: jest.fn().mockReturnValue([orphanedRow]),
      });

      // tmux session doesn't exist
      mockTerminalIO.sessionExists.mockResolvedValue(false);

      const sessions = await service.listActiveSessions();
      expect(sessions).toEqual([]);
      expect(insertRunMock).toHaveBeenCalled();
    });
  });

  describe('getActiveSessionForAgent', () => {
    it('returns session when agent has a running session', () => {
      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn().mockReturnValue({
          id: 'session-1',
          epic_id: null,
          agent_id: 'agent-1',
          tmux_session_id: 'tmux-1',
          status: 'running',
          started_at: '2024-01-01T00:00:00.000Z',
          ended_at: null,
          last_activity_at: null,
          activity_state: null,
          busy_since: null,
          transcript_path: null,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        }),
        all: jest.fn().mockReturnValue([]),
      });

      const session = service.getActiveSessionForAgent('agent-1');
      expect(session).not.toBeNull();
      expect(session!.id).toBe('session-1');
    });

    it('returns null when agent has no running session', () => {
      sqlitePrepare.mockReturnValue({
        run: insertRunMock,
        get: jest.fn().mockReturnValue(undefined),
        all: jest.fn().mockReturnValue([]),
      });

      const session = service.getActiveSessionForAgent('agent-1');
      expect(session).toBeNull();
    });
  });

  describe('updateName', () => {
    function mockForUpdateName(updatedRow: Record<string, unknown> | undefined, changes = 1) {
      const getMock = jest.fn().mockReturnValue(updatedRow);
      const runMock = jest.fn().mockReturnValue({ changes });
      sqlitePrepare.mockReturnValue({
        run: runMock,
        get: getMock,
        all: jest.fn().mockReturnValue([]),
      });
      return { runMock, getMock };
    }

    const baseRow = {
      id: 'session-1',
      epic_id: null,
      agent_id: 'agent-1',
      tmux_session_id: null,
      status: 'stopped',
      started_at: '2024-01-01T00:00:00.000Z',
      ended_at: '2024-01-01T01:00:00.000Z',
      last_activity_at: null,
      activity_state: null,
      busy_since: null,
      transcript_path: null,
      name: null,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    };

    it('updates name and returns updated row with bumped updated_at', () => {
      const updatedRow = { ...baseRow, name: 'My Session', updated_at: '2024-06-01T00:00:00.000Z' };
      const { runMock } = mockForUpdateName(updatedRow);

      const result = service.updateName('session-1', 'My Session');

      expect(runMock).toHaveBeenCalled();
      expect(result.id).toBe('session-1');
      expect(result.name).toBe('My Session');
    });

    it('trims whitespace and stores trimmed name', () => {
      const updatedRow = { ...baseRow, name: 'My Session', updated_at: '2024-06-01T00:00:00.000Z' };
      const { runMock } = mockForUpdateName(updatedRow);

      service.updateName('session-1', '  My Session  ');

      const updateCall = runMock.mock.calls[0];
      expect(updateCall[0]).toBe('My Session');
    });

    it('stores NULL when name is whitespace-only', () => {
      const updatedRow = { ...baseRow, name: null, updated_at: '2024-06-01T00:00:00.000Z' };
      let callCount = 0;
      const getMock = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return baseRow;
        return updatedRow;
      });
      const runMock = jest.fn().mockReturnValue({ changes: 1 });
      sqlitePrepare.mockReturnValue({
        run: runMock,
        get: getMock,
        all: jest.fn().mockReturnValue([]),
      });

      const result = service.updateName('session-1', '   ');

      const updateCall = runMock.mock.calls[0];
      expect(updateCall[0]).toBeNull();
      expect(result.name).toBeNull();
    });

    it('stores NULL when name is null', () => {
      const updatedRow = { ...baseRow, name: null, updated_at: '2024-06-01T00:00:00.000Z' };
      let callCount = 0;
      const getMock = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return baseRow;
        return updatedRow;
      });
      const runMock = jest.fn().mockReturnValue({ changes: 1 });
      sqlitePrepare.mockReturnValue({
        run: runMock,
        get: getMock,
        all: jest.fn().mockReturnValue([]),
      });

      const result = service.updateName('session-1', null);

      const updateCall = runMock.mock.calls[0];
      expect(updateCall[0]).toBeNull();
      expect(result.name).toBeNull();
    });

    it('throws ValidationError when name exceeds 120 chars', () => {
      mockForUpdateName(baseRow);
      const longName = 'a'.repeat(121);

      expect(() => service.updateName('session-1', longName)).toThrow(ValidationError);
    });

    it('accepts exactly 120 chars', () => {
      const updatedRow = { ...baseRow, name: 'a'.repeat(120) };
      mockForUpdateName(updatedRow);
      const name120 = 'a'.repeat(120);

      expect(() => service.updateName('session-1', name120)).not.toThrow();
    });

    it('throws NotFoundError when session does not exist', () => {
      const runMock = jest.fn().mockReturnValue({ changes: 0 });
      sqlitePrepare.mockReturnValue({
        run: runMock,
        get: jest.fn().mockReturnValue(undefined),
        all: jest.fn().mockReturnValue([]),
      });

      expect(() => service.updateName('nonexistent', 'Name')).toThrow(NotFoundError);
    });
  });

  describe('hardDeleteRecord', () => {
    const stoppedRow = {
      id: 'session-1',
      epic_id: null,
      agent_id: 'agent-1',
      tmux_session_id: null,
      status: 'stopped',
      started_at: '2024-01-01T00:00:00.000Z',
      ended_at: '2024-01-01T01:00:00.000Z',
      last_activity_at: null,
      activity_state: null,
      busy_since: null,
      transcript_path: null,
      name: null,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    };

    it('deletes session and invite rows in a transaction', () => {
      const runMock = jest
        .fn()
        .mockReturnValueOnce(undefined) // DELETE invites
        .mockReturnValueOnce({ changes: 1 }); // DELETE sessions
      sqlitePrepare.mockReturnValue({
        run: runMock,
        get: jest.fn().mockReturnValue(stoppedRow),
        all: jest.fn().mockReturnValue([]),
      });

      const result = service.hardDeleteRecord('session-1');

      expect(result).toEqual({ deleted: true });
      expect(sqliteExec).toHaveBeenCalledWith('BEGIN IMMEDIATE');
      expect(sqliteExec).toHaveBeenCalledWith('COMMIT');
      const preparedSqls = sqlitePrepare.mock.calls.map((c: unknown[]) => c[0]);
      expect(preparedSqls).toContain(
        'DELETE FROM chat_thread_session_invites WHERE session_id = ?',
      );
      expect(preparedSqls).toContain('DELETE FROM sessions WHERE id = ?');
    });

    it('returns { deleted: false } when session does not exist', () => {
      const runMock = jest
        .fn()
        .mockReturnValueOnce(undefined) // DELETE invites
        .mockReturnValueOnce({ changes: 0 }); // DELETE sessions (no row)
      sqlitePrepare.mockReturnValue({
        run: runMock,
        get: jest.fn().mockReturnValue(undefined),
        all: jest.fn().mockReturnValue([]),
      });

      const result = service.hardDeleteRecord('nonexistent');

      expect(result).toEqual({ deleted: false });
    });

    it('throws ValidationError when session is running', () => {
      const runningRow = { ...stoppedRow, status: 'running' };
      sqlitePrepare.mockReturnValue({
        run: jest.fn(),
        get: jest.fn().mockReturnValue(runningRow),
        all: jest.fn().mockReturnValue([]),
      });

      expect(() => service.hardDeleteRecord('session-1')).toThrow(ValidationError);
    });

    it('rolls back on error', () => {
      sqlitePrepare.mockImplementation((sql: string) => {
        if (sql.includes('chat_thread_session_invites')) {
          return {
            run: jest.fn().mockImplementation(() => {
              throw new Error('DB error');
            }),
            get: jest.fn().mockReturnValue(stoppedRow),
            all: jest.fn().mockReturnValue([]),
          };
        }
        return {
          run: jest.fn(),
          get: jest.fn().mockReturnValue(stoppedRow),
          all: jest.fn().mockReturnValue([]),
        };
      });

      expect(() => service.hardDeleteRecord('session-1')).toThrow('DB error');
      expect(sqliteExec).toHaveBeenCalledWith('BEGIN IMMEDIATE');
      expect(sqliteExec).toHaveBeenCalledWith('ROLLBACK');
      expect(sqliteExec).not.toHaveBeenCalledWith('COMMIT');
    });
  });
});

/**
 * Regression tests for nested lock deadlock prevention.
 *
 * These tests use a REAL SessionCoordinatorService (not mocked) to verify
 * that the lock behavior works correctly and doesn't cause deadlocks.
 *
 * Background: launchSession() wraps itself in withAgentLock(). Previously,
 * some callers also wrapped launchSession() with withAgentLock(), causing
 * nested non-reentrant locks -> deadlock. The fix removed outer locks from callers.
 */
describe('SessionCoordinatorService - nested lock deadlock regression', () => {
  it('single lock completes without deadlock', async () => {
    const realCoordinator = new SessionCoordinatorService();
    const agentId = 'agent-single-lock';

    // This simulates what launchSession does - single lock around the operation
    const result = await realCoordinator.withAgentLock(agentId, async () => {
      // Simulate some async work
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'completed';
    });

    expect(result).toBe('completed');
  });

  it('demonstrates that nested locks on same agent cause deadlock (timeout test)', async () => {
    const realCoordinator = new SessionCoordinatorService();
    const agentId = 'agent-deadlock-test';

    // Simulate what would happen if launchSession() has internal lock
    // AND the caller also wraps with lock (the old buggy pattern)
    const innerOperation = async () => {
      // This simulates launchSession's internal withAgentLock
      return realCoordinator.withAgentLock(agentId, async () => {
        return 'inner-completed';
      });
    };

    // This is the problematic pattern: outer lock wrapping inner lock on same agent
    const nestedLockPromise = realCoordinator.withAgentLock(agentId, async () => {
      // The inner lock will wait for outer lock to release (which never happens)
      return innerOperation();
    });

    // Use Promise.race with a timeout to detect deadlock
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), 500); // 500ms should be enough for non-deadlock
    });

    const result = await Promise.race([nestedLockPromise, timeoutPromise]);

    // This SHOULD timeout because nested locks deadlock
    expect(result).toBe('timeout');
  }, 2000);

  it('sequential locks on same agent work correctly (no deadlock)', async () => {
    const realCoordinator = new SessionCoordinatorService();
    const agentId = 'agent-sequential-test';
    const results: string[] = [];

    // First lock
    await realCoordinator.withAgentLock(agentId, async () => {
      results.push('first');
    });

    // Second lock (after first completes) - should work fine
    await realCoordinator.withAgentLock(agentId, async () => {
      results.push('second');
    });

    expect(results).toEqual(['first', 'second']);
  });

  it('concurrent locks on different agents work correctly (no blocking)', async () => {
    const realCoordinator = new SessionCoordinatorService();
    const results: string[] = [];

    // Concurrent operations on different agents should not block each other
    await Promise.all([
      realCoordinator.withAgentLock('agent-a', async () => {
        await new Promise((r) => setTimeout(r, 50));
        results.push('agent-a');
      }),
      realCoordinator.withAgentLock('agent-b', async () => {
        results.push('agent-b');
      }),
    ]);

    // agent-b should complete before agent-a (no blocking between different agents)
    expect(results).toEqual(['agent-b', 'agent-a']);
  });

  it('concurrent locks on same agent serialize correctly', async () => {
    const realCoordinator = new SessionCoordinatorService();
    const agentId = 'agent-concurrent-test';
    const results: string[] = [];

    // Two concurrent operations on same agent should serialize
    await Promise.all([
      realCoordinator.withAgentLock(agentId, async () => {
        await new Promise((r) => setTimeout(r, 50));
        results.push('first');
      }),
      realCoordinator.withAgentLock(agentId, async () => {
        results.push('second');
      }),
    ]);

    // Even though second was started later, first should complete first due to serialization
    expect(results).toEqual(['first', 'second']);
  });
});
