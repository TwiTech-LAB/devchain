/**
 * Unit tests for terminateSession — size_bytes best-effort population.
 * Isolated from the full sessions.service.spec.ts to keep stat() mocking clean.
 */

jest.mock('../utils/claude-config', () => ({
  checkClaudeAutoCompact: jest.fn(),
}));

jest.mock('../../../common/logging/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

jest.mock('fs/promises', () => ({
  stat: jest.fn(),
}));

import { stat } from 'fs/promises';
import { SessionsService } from './sessions.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { TmuxService } from '../../terminal/services/tmux.service';
import type { PtyService } from '../../terminal/services/pty.service';
import type { PreflightService } from '../../core/services/preflight.service';
import type { ProviderMcpEnsureService } from '../../core/services/provider-mcp-ensure.service';
import type { EventsService } from '../../events/services/events.service';
import type { TerminalSendCoordinatorService } from '../../terminal/services/terminal-send-coordinator.service';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import type { ModuleRef } from '@nestjs/core';
import type { HooksConfigService } from '../../hooks/services/hooks-config.service';
import type { ProviderAdapterFactory } from '../../providers/adapters/provider-adapter.factory';
import { SessionCoordinatorService } from './session-coordinator.service';
import { DEFAULT_FEATURE_FLAGS } from '../../../common/config/feature-flags';

const mockStat = stat as jest.MockedFunction<typeof stat>;

const SESSION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TRANSCRIPT_PATH = '/tmp/test-session.jsonl';

/** A minimal running SessionDto row as returned by getSession() */
const RUNNING_SESSION_ROW = {
  id: SESSION_ID,
  agent_id: 'agent-1',
  epic_id: null,
  tmux_session_id: 'tmux-1',
  status: 'running',
  started_at: '2026-01-01T00:00:00.000Z',
  ended_at: null,
  last_activity_at: null,
  activity_state: null,
  busy_since: null,
  transcript_path: TRANSCRIPT_PATH,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('SessionsService.terminateSession — size_bytes', () => {
  let service: SessionsService;
  let updateRunMock: jest.Mock;
  let selectGetMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    updateRunMock = jest.fn();
    selectGetMock = jest.fn();

    // First prepare() call in terminateSession is getSession() SELECT → returns a row
    // Subsequent prepare() calls are UPDATE → returns run mock
    const sqlitePrepare = jest
      .fn()
      .mockReturnValueOnce({ get: selectGetMock })
      .mockReturnValue({ run: updateRunMock, get: jest.fn(), all: jest.fn().mockReturnValue([]) });

    selectGetMock.mockReturnValue(RUNNING_SESSION_ROW);

    const dbMock = {
      session: { client: { prepare: sqlitePrepare } },
    } as unknown as BetterSQLite3Database;

    const storage = {
      getAgent: jest.fn(),
      getProject: jest.fn(),
      getEpic: jest.fn(),
      getAgentProfile: jest.fn(),
      getProvider: jest.fn(),
      getPrompt: jest.fn(),
      getInitialSessionPrompt: jest.fn().mockResolvedValue(null),
      getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
      listProfileProviderConfigsByProfile: jest.fn().mockResolvedValue([]),
      getProfileProviderConfig: jest.fn(),
    };

    const tmuxService = {
      createSessionName: jest.fn(),
      createSession: jest.fn(),
      startHealthCheck: jest.fn(),
      sendCommand: jest.fn(),
      sendCommandArgs: jest.fn(),
      waitForOutput: jest.fn(),
      pasteAndSubmit: jest.fn(),
      setAlternateScreenOff: jest.fn(),
      destroySession: jest.fn().mockResolvedValue(undefined),
      hasSession: jest.fn().mockResolvedValue(true),
    };

    const ptyService = { startStreaming: jest.fn(), stopStreaming: jest.fn() };
    const preflightService = { runChecks: jest.fn() };
    const mcpEnsureService = { ensureMcp: jest.fn() };
    const sendCoordinator = {
      ensureAgentGap: jest.fn(),
    } as unknown as TerminalSendCoordinatorService;
    const sessionCoordinator = { withAgentLock: jest.fn() } as unknown as SessionCoordinatorService;
    const hooksConfigService = { ensureHooksConfig: jest.fn() };

    const eventsService: { publish: jest.Mock } = { publish: jest.fn().mockResolvedValue('evt') };
    const terminalGateway = { broadcastEvent: jest.fn() };

    const moduleRef = {
      get: jest.fn().mockImplementation((token: unknown) => {
        const name = (token as { name?: string })?.name;
        if (name === 'TerminalGateway') return terminalGateway as unknown as TerminalGateway;
        if (name === 'EventsService') return eventsService as unknown as EventsService;
        return null;
      }),
    } as unknown as ModuleRef;

    service = new SessionsService(
      dbMock,
      storage as unknown as StorageService,
      tmuxService as unknown as TmuxService,
      sendCoordinator,
      ptyService as unknown as PtyService,
      preflightService as unknown as PreflightService,
      mcpEnsureService as unknown as ProviderMcpEnsureService,
      sessionCoordinator,
      hooksConfigService as unknown as HooksConfigService,
      {
        getAdapter: jest.fn().mockReturnValue({ providerName: 'claude' }),
      } as unknown as ProviderAdapterFactory,
      moduleRef,
    );
  });

  it('writes the file size to size_bytes when transcript_path is set and stat succeeds', async () => {
    mockStat.mockResolvedValue({ size: 4096 } as Awaited<ReturnType<typeof stat>>);

    await service.terminateSession(SESSION_ID);

    expect(mockStat).toHaveBeenCalledWith(TRANSCRIPT_PATH);
    expect(updateRunMock).toHaveBeenCalledWith(
      'stopped',
      expect.any(String), // ended_at
      4096, // size_bytes
      expect.any(String), // updated_at
      SESSION_ID,
    );
  });

  it('writes NULL to size_bytes when stat throws (best-effort)', async () => {
    mockStat.mockRejectedValue(new Error('ENOENT: no such file'));

    await service.terminateSession(SESSION_ID);

    expect(updateRunMock).toHaveBeenCalledWith(
      'stopped',
      expect.any(String),
      null, // size_bytes remains NULL
      expect.any(String),
      SESSION_ID,
    );
  });

  it('writes NULL to size_bytes when transcript_path is null', async () => {
    // Override selectGetMock to return a session without transcript_path
    selectGetMock.mockReturnValue({ ...RUNNING_SESSION_ROW, transcript_path: null });

    await service.terminateSession(SESSION_ID);

    expect(mockStat).not.toHaveBeenCalled();
    expect(updateRunMock).toHaveBeenCalledWith(
      'stopped',
      expect.any(String),
      null,
      expect.any(String),
      SESSION_ID,
    );
  });
});
