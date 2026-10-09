/**
 * Unit tests for terminateSession — size_bytes best-effort population.
 * Isolated from the full sessions.service.spec.ts to keep stat() mocking clean.
 */

jest.mock('../utils/claude-config', () => ({
  checkAutoCompactConfig: jest.fn(),
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
import type { PtyService } from '../../terminal/services/pty.service';
import type { PreflightService } from '../../core/services/preflight.service';
import type { ProviderMcpEnsureService } from '../../providers/services/provider-mcp-ensure.service';
import type { EventsService } from '../../events/services/events.service';
import type { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import type { TerminalSessionRegistry } from '../../terminal/services/terminal-session/terminal-session-registry';
import type { HooksConfigService } from '../../hooks/services/hooks-config.service';
import type { ProviderAdapterFactory } from '../../providers/adapters/provider-adapter.factory';
import { SessionCoordinatorService } from './session-coordinator.service';
import { DEFAULT_FEATURE_FLAGS } from '../../../common/config/feature-flags';
import type { SessionTerminalRuntimeService } from '../../session-terminal-runtime/session-terminal-runtime.service';
import type { EpicTimeStore } from '../../epic-time/services/epic-time.store';

const mockStat = stat as jest.MockedFunction<typeof stat>;

const SESSION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TRANSCRIPT_PATH = '/tmp/test-session.jsonl';
const TEST_TERMINATION = { source: 'web-api' as const, reason: 'user-requested' as const };

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

    const sqlitePrepare = jest.fn().mockImplementation((sql: string) => {
      if (sql.trim().toUpperCase().startsWith('SELECT')) {
        return { get: selectGetMock, all: jest.fn().mockReturnValue([]) };
      }
      return { run: updateRunMock, get: jest.fn(), all: jest.fn().mockReturnValue([]) };
    });

    selectGetMock.mockReturnValue(RUNNING_SESSION_ROW);

    const dbMock = {
      session: { client: { prepare: sqlitePrepare, exec: jest.fn() } },
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

    const ptyService = { startStreaming: jest.fn(), stopStreaming: jest.fn() };
    const preflightService = { runChecks: jest.fn() };
    const mcpEnsureService = { ensureMcp: jest.fn() };
    const terminalIO = {
      sessionExists: jest.fn().mockResolvedValue(false),
      destroySession: jest.fn().mockResolvedValue(undefined),
      destroyExpectedSession: jest.fn().mockResolvedValue({ outcome: 'destroyed' }),
    } as unknown as TerminalIOService;
    const sessionCoordinator = {
      withAgentLock: jest
        .fn()
        .mockImplementation((_id: string, fn: () => Promise<unknown>) => fn()),
    } as unknown as SessionCoordinatorService;
    const hooksConfigService = { ensureHooksConfig: jest.fn() };

    const eventsService: { publish: jest.Mock } = { publish: jest.fn().mockResolvedValue('evt') };

    const terminalSessionRegistry = {
      dispose: jest.fn(),
      create: jest.fn(),
      bind: jest.fn(),
      get: jest.fn(),
    } as unknown as TerminalSessionRegistry;

    service = new SessionsService(
      dbMock,
      storage as unknown as StorageService,
      terminalIO,
      ptyService as unknown as PtyService,
      preflightService as unknown as PreflightService,
      mcpEnsureService as unknown as ProviderMcpEnsureService,
      sessionCoordinator,
      hooksConfigService as unknown as HooksConfigService,
      {
        getAdapter: jest.fn().mockReturnValue({ providerName: 'claude' }),
      } as unknown as ProviderAdapterFactory,
      eventsService as unknown as EventsService,
      terminalSessionRegistry,
      {
        releaseProviderArtifacts: jest.fn().mockResolvedValue(undefined),
      } as unknown as SessionTerminalRuntimeService,
      {
        readActivationSettings: jest
          .fn()
          .mockReturnValue({ trackingStartedAt: null, idleTimeoutMs: 30_000 }),
        runTerminationResetSync: jest.fn(),
      } as unknown as EpicTimeStore,
      { listRemoteOwnedProjectIds: () => [] } as never,
    );
  });

  it.each([
    {
      label: 'stat success',
      transcriptPath: TRANSCRIPT_PATH,
      statFails: false,
      expectedSize: 4096,
    },
    { label: 'stat failure', transcriptPath: TRANSCRIPT_PATH, statFails: true, expectedSize: null },
    { label: 'no transcript', transcriptPath: null, statFails: false, expectedSize: null },
  ])('accounts transcript size for $label', async ({ transcriptPath, statFails, expectedSize }) => {
    selectGetMock.mockReturnValue({ ...RUNNING_SESSION_ROW, transcript_path: transcriptPath });
    if (statFails) mockStat.mockRejectedValue(new Error('ENOENT: no such file'));
    else mockStat.mockResolvedValue({ size: 4096 } as Awaited<ReturnType<typeof stat>>);
    await service.terminateSession(SESSION_ID, TEST_TERMINATION);
    if (transcriptPath) expect(mockStat).toHaveBeenCalledWith(transcriptPath);
    else expect(mockStat).not.toHaveBeenCalled();
    expect(updateRunMock).toHaveBeenCalledWith(
      'stopped',
      expect.any(String),
      expectedSize,
      expect.any(String),
      SESSION_ID,
    );
  });
});
