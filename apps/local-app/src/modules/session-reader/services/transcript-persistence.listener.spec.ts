import { Logger } from '@nestjs/common';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {
  TranscriptPersistenceListener,
  type PersistOutcome,
} from './transcript-persistence.listener';
import { TranscriptPathValidator } from './transcript-path-validator.service';
import { EventsService } from '../../events/services/events.service';
import { ValidationError } from '../../../common/errors/error-types';
import type { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type {
  SessionReaderAdapter,
  SessionFileInfo,
} from '../adapters/session-reader-adapter.interface';
import { readFileHead } from '../adapters/utils/file-search.util';
import type { ClaudeHooksSessionStartedEventPayload } from '../../events/catalog/claude.hooks.session.started';
import type { SessionStartedEventPayload } from '../../events/catalog/session.started';

jest.mock('../adapters/utils/file-search.util', () => ({
  readFileHead: jest.fn(),
}));

jest.mock('node:fs/promises', () => ({
  realpath: jest.fn(),
}));

const mockReadFileHead = readFileHead as jest.MockedFunction<typeof readFileHead>;
const mockRealpath = fsPromises.realpath as jest.MockedFunction<
  (filePath: string) => Promise<string>
>;
const DISCOVERY_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000] as const;

async function advanceDiscoveryRetryDelay(delayIndex: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(DISCOVERY_BACKOFF_MS[delayIndex]);
}

async function advanceAllDiscoveryRetries(): Promise<void> {
  for (const delayMs of DISCOVERY_BACKOFF_MS) {
    await jest.advanceTimersByTimeAsync(delayMs);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDb() {
  const mockGetTranscriptPath = jest.fn();
  const mockGetPersistRow = jest.fn();
  const mockGetStartedAt = jest.fn();
  const mockAllAssignedTranscriptPaths = jest.fn().mockReturnValue([]);
  const mockRun = jest.fn().mockReturnValue({ changes: 1 });
  const mockBeginRun = jest.fn().mockReturnValue({ changes: 0 });
  const mockCommitRun = jest.fn().mockReturnValue({ changes: 0 });
  const mockRollbackRun = jest.fn().mockReturnValue({ changes: 0 });
  const mockPrepare = jest.fn((sql: string) => {
    if (sql === 'BEGIN') {
      return { run: mockBeginRun };
    }
    if (sql === 'COMMIT') {
      return { run: mockCommitRun };
    }
    if (sql === 'ROLLBACK') {
      return { run: mockRollbackRun };
    }
    if (sql.includes('SELECT transcript_path, provider_session_id, provider_name_at_launch')) {
      return { get: mockGetPersistRow };
    }
    if (sql.includes('SELECT id, transcript_path FROM sessions')) {
      return { all: mockAllAssignedTranscriptPaths };
    }
    if (sql.includes('SELECT transcript_path, provider_session_id')) {
      return { get: mockGetTranscriptPath };
    }
    if (sql.includes('SELECT started_at')) {
      return { get: mockGetStartedAt };
    }
    if (sql.includes('UPDATE sessions')) {
      return { run: mockRun };
    }
    return { get: jest.fn(), run: jest.fn() };
  });

  const mockDb = {
    session: { client: { prepare: mockPrepare } },
  } as unknown as BetterSQLite3Database;

  return {
    mockDb,
    mockPrepare,
    mockRun,
    mockBeginRun,
    mockCommitRun,
    mockRollbackRun,
    mockGetTranscriptPath,
    mockGetPersistRow,
    mockGetStartedAt,
    mockAllAssignedTranscriptPaths,
  };
}

function createMockStorage(): jest.Mocked<
  Pick<StorageService, 'getAgent' | 'getProfileProviderConfig' | 'getProvider' | 'getProject'>
> {
  return {
    getAgent: jest.fn().mockResolvedValue({
      id: 'agent-1',
      projectId: 'project-1',
      profileId: 'profile-1',
      providerConfigId: 'config-1',
      name: 'TestAgent',
      description: null,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    }),
    getProfileProviderConfig: jest.fn().mockResolvedValue({
      id: 'config-1',
      profileId: 'profile-1',
      providerId: 'provider-1',
      name: 'Claude Config',
      options: null,
      env: null,
      position: 0,
    }),
    getProvider: jest.fn().mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: null,
      mcpConfigured: false,
    }),
    getProject: jest.fn().mockResolvedValue({
      id: 'project-1',
      name: 'TestProject',
      rootPath: '/home/user/my-project',
      isTemplate: false,
    }),
  };
}

function createMockAdapterFactory(
  adapter?: SessionReaderAdapter,
): jest.Mocked<Pick<SessionReaderAdapterFactory, 'getAdapter'>> {
  return {
    getAdapter: jest.fn().mockReturnValue(adapter ?? null),
  };
}

function createMockAdapter(): jest.Mocked<Pick<SessionReaderAdapter, 'discoverSessionFile'>> {
  return {
    discoverSessionFile: jest.fn().mockResolvedValue([]),
  };
}

function makeFileInfo(overrides: Partial<SessionFileInfo> = {}): SessionFileInfo {
  return {
    filePath: '/home/user/.claude/projects/-home-user-my-project/abc123.jsonl',
    providerName: 'claude',
    sizeBytes: 1024,
    lastModified: new Date().toISOString(),
    ...overrides,
  };
}

function codexSessionMetaContent(overrides: {
  providerSessionId?: string;
  timestamp?: string;
  cwd?: string;
  body?: string;
}): string {
  return `${JSON.stringify({
    timestamp: overrides.timestamp ?? '2026-02-25T10:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: overrides.providerSessionId ?? 'codex-session-1',
      timestamp: overrides.timestamp ?? '2026-02-25T10:00:00.000Z',
      cwd: overrides.cwd ?? '/home/user/my-project',
    },
  })}\n${overrides.body ?? ''}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TranscriptPersistenceListener', () => {
  let listener: TranscriptPersistenceListener;
  let mockValidator: jest.Mocked<Pick<TranscriptPathValidator, 'validateShape'>>;
  let mockEvents: jest.Mocked<Pick<EventsService, 'publish'>>;
  let mockRun: jest.Mock;
  let mockGetTranscriptPath: jest.Mock;
  let mockGetPersistRow: jest.Mock;
  let mockGetStartedAt: jest.Mock;
  let mockAllAssignedTranscriptPaths: jest.Mock;
  let mockPrepare: jest.Mock;
  let mockStorage: ReturnType<typeof createMockStorage>;
  let mockAdapterFactory: ReturnType<typeof createMockAdapterFactory>;

  const hookPayload: ClaudeHooksSessionStartedEventPayload = {
    claudeSessionId: 'claude-sess-123',
    source: 'startup',
    model: 'claude-sonnet-4-6',
    transcriptPath: '/home/user/.claude/projects/my-proj/session.jsonl',
    tmuxSessionName: 'agent-session',
    projectId: '11111111-1111-1111-1111-111111111111',
    agentId: '22222222-2222-2222-2222-222222222222',
    sessionId: '33333333-3333-3333-3333-333333333333',
  };

  const sessionStartedPayload: SessionStartedEventPayload = {
    sessionId: '33333333-3333-3333-3333-333333333333',
    epicId: null,
    agentId: '22222222-2222-2222-2222-222222222222',
    tmuxSessionName: 'agent-session',
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetAllMocks();
    mockReadFileHead.mockResolvedValue('');

    const db = createMockDb();
    mockPrepare = db.mockPrepare;
    mockRun = db.mockRun;
    mockGetTranscriptPath = db.mockGetTranscriptPath;
    mockGetPersistRow = db.mockGetPersistRow;
    mockGetStartedAt = db.mockGetStartedAt;
    mockAllAssignedTranscriptPaths = db.mockAllAssignedTranscriptPaths;
    mockRealpath.mockImplementation(async (filePath: string) => filePath);

    mockValidator = {
      validateShape: jest.fn().mockReturnValue('/normalized/path/session.jsonl'),
    };

    mockEvents = {
      publish: jest.fn().mockResolvedValue('event-id'),
    };

    mockGetTranscriptPath.mockReturnValue({
      transcript_path: null,
      provider_session_id: null,
    });
    mockGetPersistRow.mockReturnValue({
      transcript_path: null,
      provider_session_id: null,
      provider_name_at_launch: 'claude',
    });

    mockStorage = createMockStorage();
    mockAdapterFactory = createMockAdapterFactory();

    const mockProviderAdapterFactory = {
      getAdapter: jest.fn().mockImplementation((name: string) => {
        if (name === 'claude') {
          return {
            providerName: 'claude',
            transcriptDiscoveryStrategy: 'first',
            transcriptContentSearchMaxBytes: 16_384,
            providerSessionIdRequiredForRestore: false,
          };
        }
        if (name === 'codex') {
          return {
            providerName: 'codex',
            transcriptDiscoveryStrategy: 'all',
            transcriptContentSearchMaxBytes: 65_536,
            contentMatchMaxCandidates: 200,
            providerSessionIdRequiredForRestore: true,
          };
        }
        if (name === 'gemini') {
          return {
            providerName: 'gemini',
            transcriptDiscoveryStrategy: 'all',
            transcriptContentSearchMaxBytes: 32_768,
            providerSessionIdRequiredForRestore: true,
          };
        }
        return { providerName: name };
      }),
    };

    listener = new TranscriptPersistenceListener(
      db.mockDb,
      mockValidator as unknown as TranscriptPathValidator,
      mockEvents as unknown as EventsService,
      mockAdapterFactory as unknown as SessionReaderAdapterFactory,
      mockStorage as unknown as StorageService,
      mockProviderAdapterFactory as unknown as never,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Hook-based discovery (existing tests, updated method name)
  // -------------------------------------------------------------------------

  describe('handleHookSessionStarted', () => {
    it('should persist transcript path and publish discovery event', async () => {
      await listener.handleHookSessionStarted(hookPayload);

      expect(mockValidator.validateShape).toHaveBeenCalledWith(
        hookPayload.transcriptPath,
        'claude',
      );
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE sessions'));
      expect(mockRun).toHaveBeenCalledWith(
        '/normalized/path/session.jsonl',
        'claude-sess-123',
        expect.any(String), // updated_at
        '33333333-3333-3333-3333-333333333333',
      );
      expect(mockEvents.publish).toHaveBeenCalledWith('session.transcript.discovered', {
        sessionId: '33333333-3333-3333-3333-333333333333',
        agentId: '22222222-2222-2222-2222-222222222222',
        projectId: '11111111-1111-1111-1111-111111111111',
        transcriptPath: '/normalized/path/session.jsonl',
        providerName: 'claude',
      });
    });

    it('should skip when transcriptPath is missing', async () => {
      const payload = { ...hookPayload, transcriptPath: undefined };

      await listener.handleHookSessionStarted(payload);

      expect(mockValidator.validateShape).not.toHaveBeenCalled();
      expect(mockPrepare).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should skip when sessionId is null', async () => {
      const payload = { ...hookPayload, sessionId: null };

      await listener.handleHookSessionStarted(payload);

      expect(mockValidator.validateShape).not.toHaveBeenCalled();
      expect(mockPrepare).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should skip persistence when path validation fails', async () => {
      mockValidator.validateShape.mockImplementation(() => {
        throw new ValidationError('path outside allowed root');
      });

      await listener.handleHookSessionStarted(hookPayload);

      expect(mockValidator.validateShape).toHaveBeenCalled();
      expect(mockPrepare).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should handle session not found gracefully (0 changes)', async () => {
      mockRun.mockReturnValue({ changes: 0 });

      await listener.handleHookSessionStarted(hookPayload);

      expect(mockPrepare).toHaveBeenCalled();
      expect(mockRun).toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should skip discovery event when agentId is null', async () => {
      const payload = { ...hookPayload, agentId: null };

      await listener.handleHookSessionStarted(payload);

      expect(mockPrepare).toHaveBeenCalled();
      expect(mockRun).toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should not propagate errors from DB update', async () => {
      mockRun.mockImplementation(() => {
        throw new Error('SQLITE_BUSY');
      });

      await expect(listener.handleHookSessionStarted(hookPayload)).resolves.not.toThrow();
    });

    it('should not propagate errors from event publishing', async () => {
      mockEvents.publish.mockRejectedValue(new Error('Event bus down'));

      await expect(listener.handleHookSessionStarted(hookPayload)).resolves.not.toThrow();
    });
  });

  describe('persistDiscoveredPath outcomes', () => {
    async function persistDiscoveredPath(
      fileOverrides: Partial<SessionFileInfo>,
      providerName = 'codex',
    ): Promise<PersistOutcome> {
      return (
        listener as unknown as {
          persistDiscoveredPath: (
            sessionId: string,
            agentId: string,
            projectId: string,
            file: SessionFileInfo,
            providerName: string,
          ) => Promise<PersistOutcome>;
        }
      ).persistDiscoveredPath(
        sessionStartedPayload.sessionId,
        sessionStartedPayload.agentId,
        'project-1',
        makeFileInfo({ providerName, ...fileOverrides }),
        providerName,
      );
    }

    it('returns persisted when Case A writes transcript path and provider id', async () => {
      mockGetPersistRow.mockReturnValue({
        transcript_path: null,
        provider_session_id: null,
        provider_name_at_launch: 'codex',
      });

      const outcome = await persistDiscoveredPath({ providerSessionId: 'codex-session-1' });

      expect(outcome).toEqual({ kind: 'persisted', sessionId: sessionStartedPayload.sessionId });
      expect(mockRun).toHaveBeenCalledWith(
        '/normalized/path/session.jsonl',
        'codex-session-1',
        expect.any(String),
        sessionStartedPayload.sessionId,
      );
      expect(mockEvents.publish).toHaveBeenCalledWith('session.transcript.discovered', {
        sessionId: sessionStartedPayload.sessionId,
        agentId: sessionStartedPayload.agentId,
        projectId: 'project-1',
        transcriptPath: '/normalized/path/session.jsonl',
        providerName: 'codex',
      });
    });

    it('returns persistedPathOnly when Case A writes a Codex path before the id is available', async () => {
      mockGetPersistRow.mockReturnValue({
        transcript_path: null,
        provider_session_id: null,
        provider_name_at_launch: 'codex',
      });

      const outcome = await persistDiscoveredPath({});

      expect(outcome).toEqual({
        kind: 'persistedPathOnly',
        sessionId: sessionStartedPayload.sessionId,
      });
      expect(mockRun).toHaveBeenCalledWith(
        '/normalized/path/session.jsonl',
        null,
        expect.any(String),
        sessionStartedPayload.sessionId,
      );
      expect(mockEvents.publish).toHaveBeenCalledWith('session.transcript.discovered', {
        sessionId: sessionStartedPayload.sessionId,
        agentId: sessionStartedPayload.agentId,
        projectId: 'project-1',
        transcriptPath: '/normalized/path/session.jsonl',
        providerName: 'codex',
      });
      expect(mockEvents.publish).not.toHaveBeenCalledWith(
        'session.providerSessionId.discovered',
        expect.anything(),
      );
    });

    it('returns backfilledId and emits providerSessionId.discovered for Case B id repair', async () => {
      mockGetPersistRow.mockReturnValue({
        transcript_path: '/normalized/path/session.jsonl',
        provider_session_id: null,
        provider_name_at_launch: 'codex',
      });

      const outcome = await persistDiscoveredPath({ providerSessionId: 'codex-session-1' });

      expect(outcome).toEqual({
        kind: 'backfilledId',
        sessionId: sessionStartedPayload.sessionId,
      });
      expect(mockRun).toHaveBeenCalledWith(
        'codex-session-1',
        expect.any(String),
        sessionStartedPayload.sessionId,
      );
      expect(mockEvents.publish).toHaveBeenCalledWith('session.providerSessionId.discovered', {
        sessionId: sessionStartedPayload.sessionId,
        providerSessionId: 'codex-session-1',
        providerName: 'codex',
      });
    });

    it('supports silent Case B id repair without emitting providerSessionId.discovered', async () => {
      mockGetPersistRow.mockReturnValue({
        transcript_path: '/normalized/path/session.jsonl',
        provider_session_id: null,
        provider_name_at_launch: 'codex',
      });

      const outcome = await listener.backfillProviderSessionIdForTranscriptPath({
        sessionId: sessionStartedPayload.sessionId,
        providerName: 'codex',
        transcriptPath: '/normalized/path/session.jsonl',
        providerSessionId: 'codex-session-1',
        emitEvent: false,
      });

      expect(outcome).toEqual({
        kind: 'backfilledId',
        sessionId: sessionStartedPayload.sessionId,
      });
      expect(mockRun).toHaveBeenCalledWith(
        'codex-session-1',
        expect.any(String),
        sessionStartedPayload.sessionId,
      );
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('returns alreadyComplete when the matching row already has both fields', async () => {
      mockGetPersistRow.mockReturnValue({
        transcript_path: '/normalized/path/session.jsonl',
        provider_session_id: 'codex-session-1',
        provider_name_at_launch: 'codex',
      });

      const outcome = await persistDiscoveredPath({ providerSessionId: 'codex-session-1' });

      expect(outcome).toEqual({
        kind: 'alreadyComplete',
        sessionId: sessionStartedPayload.sessionId,
      });
      expect(mockRun).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('returns pathMismatch when the existing path differs after normalization', async () => {
      mockGetPersistRow.mockReturnValue({
        transcript_path: '/different/path/session.jsonl',
        provider_session_id: null,
        provider_name_at_launch: 'codex',
      });

      const outcome = await persistDiscoveredPath({ providerSessionId: 'codex-session-1' });

      expect(outcome).toEqual({
        kind: 'pathMismatch',
        sessionId: sessionStartedPayload.sessionId,
        existing: '/different/path/session.jsonl',
        incoming: '/normalized/path/session.jsonl',
      });
      expect(mockRun).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('returns skipped providerMismatch instead of cross-provider id backfill', async () => {
      mockGetPersistRow.mockReturnValue({
        transcript_path: '/normalized/path/session.jsonl',
        provider_session_id: null,
        provider_name_at_launch: 'claude',
      });

      const outcome = await persistDiscoveredPath({ providerSessionId: 'codex-session-1' });

      expect(outcome).toEqual({
        kind: 'skipped',
        sessionId: sessionStartedPayload.sessionId,
        reason: 'providerMismatch',
      });
      expect(mockRun).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('documents Claude Case B as skipped because Claude ids come from hook payloads', async () => {
      mockGetPersistRow.mockReturnValue({
        transcript_path: '/normalized/path/session.jsonl',
        provider_session_id: null,
        provider_name_at_launch: 'claude',
      });

      const outcome = await persistDiscoveredPath({}, 'claude');

      expect(outcome).toEqual({
        kind: 'skipped',
        sessionId: sessionStartedPayload.sessionId,
        reason: 'noIdAvailable',
      });
      expect(mockRun).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Auto-discovery on session launch
  // -------------------------------------------------------------------------

  describe('handleSessionStarted (auto-discovery)', () => {
    let mockAdapter: ReturnType<typeof createMockAdapter>;

    beforeEach(() => {
      mockAdapter = createMockAdapter();
      mockAdapterFactory.getAdapter.mockReturnValue(mockAdapter as unknown as SessionReaderAdapter);
      // By default: session has no transcript_path yet
      mockGetTranscriptPath.mockReturnValue({
        transcript_path: null,
        provider_session_id: null,
      });
      mockGetStartedAt.mockReturnValue({ started_at: null });
    });

    it('should discover transcript and persist on first attempt', async () => {
      mockAdapter.discoverSessionFile.mockResolvedValue([makeFileInfo()]);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockStorage.getAgent).toHaveBeenCalledWith(sessionStartedPayload.agentId);
      expect(mockStorage.getProfileProviderConfig).toHaveBeenCalledWith('config-1');
      expect(mockStorage.getProvider).toHaveBeenCalledWith('provider-1');
      expect(mockStorage.getProject).toHaveBeenCalledWith('project-1');

      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledWith({
        projectRoot: '/home/user/my-project',
      });
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);

      expect(mockValidator.validateShape).toHaveBeenCalledWith(
        '/home/user/.claude/projects/-home-user-my-project/abc123.jsonl',
        'claude',
      );

      expect(mockPrepare).toHaveBeenCalledWith('BEGIN');
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('provider_name_at_launch'));
      expect(mockRun).toHaveBeenCalledWith(
        '/normalized/path/session.jsonl',
        null,
        expect.any(String),
        sessionStartedPayload.sessionId,
      );

      // Should emit discovery event
      expect(mockEvents.publish).toHaveBeenCalledWith('session.transcript.discovered', {
        sessionId: sessionStartedPayload.sessionId,
        agentId: sessionStartedPayload.agentId,
        projectId: 'project-1',
        transcriptPath: '/normalized/path/session.jsonl',
        providerName: 'claude',
      });
      expect(mockReadFileHead).not.toHaveBeenCalled();
    });

    it('should match non-Claude transcript by full session UUID content', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });

      const codexFile = makeFileInfo({
        filePath: '/home/user/.codex/sessions/2026/02/25/rollout-a.jsonl',
        providerName: 'codex',
        providerSessionId: 'codex-session-1',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([codexFile]);
      mockReadFileHead.mockResolvedValue(
        `{"type":"session_meta","payload":{"id":"abc"},"session":"${sessionStartedPayload.sessionId}"}`,
      );

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockReadFileHead).toHaveBeenCalledWith(codexFile.filePath, 65_536);
      expect(mockValidator.validateShape).toHaveBeenCalledWith(codexFile.filePath, 'codex');
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({
          providerName: 'codex',
        }),
      );
    });

    it('should capture Codex rollout that appears after a 12s cold start', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const startedAtMs = Date.now();
      const codexFile = makeFileInfo({
        filePath: '/home/user/.codex/sessions/2026/02/25/rollout-cold-start.jsonl',
        providerName: 'codex',
        providerSessionId: 'codex-session-1',
      });
      mockAdapter.discoverSessionFile.mockImplementation(async () =>
        Date.now() - startedAtMs >= 12_000 ? [codexFile] : [],
      );
      mockReadFileHead.mockResolvedValue(`session=${sessionStartedPayload.sessionId}`);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(6);
      expect(mockValidator.validateShape).toHaveBeenCalledWith(codexFile.filePath, 'codex');
    });

    it('should content-match Codex session IDs beyond 16KB but within the 64KB head', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const codexFile = makeFileInfo({
        filePath: '/home/user/.codex/sessions/2026/02/25/rollout-large-head.jsonl',
        providerName: 'codex',
        providerSessionId: 'codex-session-1',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([codexFile]);
      mockReadFileHead.mockResolvedValue(`${'x'.repeat(40_000)}${sessionStartedPayload.sessionId}`);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockReadFileHead).toHaveBeenCalledWith(codexFile.filePath, 65_536);
      expect(mockValidator.validateShape).toHaveBeenCalledWith(codexFile.filePath, 'codex');
    });

    it('should scan up to the Codex 200-candidate cap', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const files = Array.from({ length: 150 }, (_, index) =>
        makeFileInfo({
          filePath: `/tmp/codex-${index}.jsonl`,
          providerName: 'codex',
          providerSessionId: `codex-session-${index}`,
        }),
      );
      mockAdapter.discoverSessionFile.mockResolvedValue(files);
      mockReadFileHead.mockImplementation(async (filePath: string) =>
        filePath === '/tmp/codex-149.jsonl'
          ? `session=${sessionStartedPayload.sessionId}`
          : 'different session',
      );

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockReadFileHead).toHaveBeenCalledTimes(150);
      expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/codex-149.jsonl', 'codex');
    });

    it('should use the 200-candidate fallback when a provider has no candidate cap override', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'custom',
        binPath: null,
        mcpConfigured: false,
      });
      const files = Array.from({ length: 201 }, (_, index) =>
        makeFileInfo({
          filePath: `/tmp/custom-${index}.jsonl`,
          providerName: 'custom',
        }),
      );
      mockAdapter.discoverSessionFile.mockResolvedValue(files);
      mockReadFileHead.mockImplementation(async (filePath: string) =>
        filePath === '/tmp/custom-199.jsonl'
          ? `session=${sessionStartedPayload.sessionId}`
          : 'different session',
      );

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockReadFileHead).toHaveBeenCalledTimes(200);
      expect(mockReadFileHead).not.toHaveBeenCalledWith('/tmp/custom-200.jsonl', expect.anything());
      expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/custom-199.jsonl', 'custom');
    });

    it('should log full UUID content matches with matchType content', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const codexFile = makeFileInfo({
        filePath: '/home/user/.codex/sessions/2026/02/25/rollout-match.jsonl',
        providerName: 'codex',
        providerSessionId: 'codex-session-1',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([codexFile]);
      mockReadFileHead.mockResolvedValue(`session=${sessionStartedPayload.sessionId}`);

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await promise;

        expect(logSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: sessionStartedPayload.sessionId,
            providerName: 'codex',
            filePath: codexFile.filePath,
            matchType: 'content',
          }),
          'Auto-discovered transcript via content match',
        );
      } finally {
        logSpy.mockRestore();
      }
    });

    it('should discover Codex transcript by session_meta metadata without session UUID content', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockGetPersistRow.mockReturnValue({
        transcript_path: null,
        provider_session_id: null,
        provider_name_at_launch: 'codex',
      });
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:05.000Z' });
      const codexFile = makeFileInfo({
        filePath: '/home/user/.codex/sessions/2026/02/25/rollout-metadata.jsonl',
        providerName: 'codex',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([codexFile]);
      mockReadFileHead.mockResolvedValue(
        codexSessionMetaContent({
          providerSessionId: 'codex-session-from-meta',
          timestamp: '2026-02-25T10:00:00.000Z',
        }),
      );

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockValidator.validateShape).toHaveBeenCalledWith(codexFile.filePath, 'codex');
      expect(mockRun).toHaveBeenCalledWith(
        '/normalized/path/session.jsonl',
        'codex-session-from-meta',
        expect.any(String),
        sessionStartedPayload.sessionId,
      );
      expect(mockReadFileHead).toHaveBeenCalledTimes(1);
    });

    it('should use content to break ambiguous Codex metadata matches', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });
      const files = [
        makeFileInfo({
          filePath: '/tmp/codex-a.jsonl',
          providerName: 'codex',
        }),
        makeFileInfo({
          filePath: '/tmp/codex-b.jsonl',
          providerName: 'codex',
        }),
      ];
      mockAdapter.discoverSessionFile.mockResolvedValue(files);
      mockReadFileHead.mockImplementation(async (filePath: string) =>
        filePath === '/tmp/codex-a.jsonl'
          ? codexSessionMetaContent({
              providerSessionId: 'codex-a',
              timestamp: '2026-02-25T10:00:01.000Z',
            })
          : codexSessionMetaContent({
              providerSessionId: 'codex-b',
              timestamp: '2026-02-25T10:00:02.000Z',
              body: `session=${sessionStartedPayload.sessionId}`,
            }),
      );

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await promise;

        expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/codex-b.jsonl', 'codex');
        expect(logSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filePath: '/tmp/codex-b.jsonl',
            matchType: 'metadata+content',
          }),
          'Auto-discovered transcript via Codex metadata match',
        );
      } finally {
        logSpy.mockRestore();
      }
    });

    it('should fall through to content match when Codex metadata cwd misses project root', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });
      const codexFile = makeFileInfo({
        filePath: '/tmp/codex-content.jsonl',
        providerName: 'codex',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([codexFile]);
      mockReadFileHead.mockResolvedValue(
        codexSessionMetaContent({
          providerSessionId: 'codex-content',
          timestamp: '2026-02-25T10:00:01.000Z',
          cwd: '/home/user/other-project',
          body: `session=${sessionStartedPayload.sessionId}`,
        }),
      );

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await promise;

        expect(mockValidator.validateShape).toHaveBeenCalledWith(codexFile.filePath, 'codex');
        expect(logSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filePath: codexFile.filePath,
            matchType: 'content',
          }),
          'Auto-discovered transcript via content match',
        );
      } finally {
        logSpy.mockRestore();
      }
    });

    it('should disambiguate Codex agents in different project roots by realpath cwd', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });
      const files = [
        makeFileInfo({
          filePath: '/tmp/wrong-project.jsonl',
          providerName: 'codex',
        }),
        makeFileInfo({
          filePath: '/tmp/right-project.jsonl',
          providerName: 'codex',
        }),
      ];
      mockAdapter.discoverSessionFile.mockResolvedValue(files);
      mockReadFileHead.mockImplementation(async (filePath: string) =>
        filePath === '/tmp/wrong-project.jsonl'
          ? codexSessionMetaContent({
              providerSessionId: 'codex-wrong',
              timestamp: '2026-02-25T10:00:01.000Z',
              cwd: '/home/user/other-project',
            })
          : codexSessionMetaContent({
              providerSessionId: 'codex-right',
              timestamp: '2026-02-25T10:00:02.000Z',
              cwd: '/home/user/my-project',
            }),
      );

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/right-project.jsonl', 'codex');
      expect(mockValidator.validateShape).not.toHaveBeenCalledWith(
        '/tmp/wrong-project.jsonl',
        'codex',
      );
    });

    it('should not metadata-match partially flushed Codex candidates without providerSessionId', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });
      mockAdapter.discoverSessionFile.mockResolvedValue([
        makeFileInfo({ filePath: '/tmp/partial.jsonl', providerName: 'codex' }),
      ]);
      mockReadFileHead.mockResolvedValue('{"type":"session_meta","payload":{"cwd":');

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockEvents.publish).not.toHaveBeenCalled();
      expect(mockValidator.validateShape).not.toHaveBeenCalled();
    });

    it('should exclude Codex candidates already assigned to another session', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });
      mockAllAssignedTranscriptPaths.mockReturnValue([
        { id: 'other-session', transcript_path: '/tmp/already-assigned.jsonl' },
      ]);
      mockAdapter.discoverSessionFile.mockResolvedValue([
        makeFileInfo({
          filePath: '/tmp/already-assigned.jsonl',
          providerName: 'codex',
        }),
      ]);
      mockReadFileHead.mockResolvedValue(
        codexSessionMetaContent({
          providerSessionId: 'codex-already-assigned',
          timestamp: '2026-02-25T10:00:00.000Z',
          body: `session=${sessionStartedPayload.sessionId}`,
        }),
      );

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockEvents.publish).not.toHaveBeenCalled();
      expect(mockValidator.validateShape).not.toHaveBeenCalled();
    });

    it('should use cwd-filtered timestamp fallback to pick the closest Codex rollout', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });
      const files = [
        makeFileInfo({ filePath: '/tmp/far.jsonl', providerName: 'codex' }),
        makeFileInfo({ filePath: '/tmp/close.jsonl', providerName: 'codex' }),
      ];
      mockAdapter.discoverSessionFile.mockResolvedValue(files);
      mockReadFileHead.mockImplementation(async (filePath: string) =>
        filePath === '/tmp/far.jsonl'
          ? codexSessionMetaContent({
              providerSessionId: 'codex-far',
              timestamp: '2026-02-25T10:00:20.000Z',
            })
          : codexSessionMetaContent({
              providerSessionId: 'codex-close',
              timestamp: '2026-02-25T10:00:05.000Z',
            }),
      );

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await advanceAllDiscoveryRetries();
        await promise;

        expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/close.jsonl', 'codex');
        expect(
          mockRealpath.mock.calls.filter((call) => call[0] === '/home/user/my-project'),
        ).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filePath: '/tmp/close.jsonl',
            matchType: 'timestamp-fallback',
          }),
          'Auto-discovered transcript via timestamp heuristic fallback',
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('safeRealpath should fall back to a normalized absolute path without throwing', async () => {
      mockRealpath.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));

      await expect(
        (
          listener as unknown as {
            safeRealpath: (filePath: string) => Promise<string>;
          }
        ).safeRealpath('relative/missing.jsonl'),
      ).resolves.toBe(path.normalize(path.resolve('relative/missing.jsonl')));
    });

    it('should use short-id matching and 32KB search window for Gemini', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'gemini',
        binPath: null,
        mcpConfigured: false,
      });

      const geminiFile = makeFileInfo({
        filePath: '/home/user/.gemini/tmp/proj/chats/session-2026-02-25T10-00-00-abcdef01.json',
        providerName: 'gemini',
        providerSessionId: 'gemini-session-1',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([geminiFile]);

      const shortId = sessionStartedPayload.sessionId.slice(0, 8);
      mockReadFileHead.mockResolvedValue(
        `{"startTime":"2026-02-25T10:00:00.000Z","title":"Session ${shortId}"}`,
      );

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockReadFileHead).toHaveBeenCalledWith(geminiFile.filePath, 32_768);
      expect(mockValidator.validateShape).toHaveBeenCalledWith(geminiFile.filePath, 'gemini');
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({
          providerName: 'gemini',
        }),
      );
    });

    it('should match non-Claude transcript by bare short prefix content', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });

      const codexFile = makeFileInfo({
        filePath: '/home/user/.codex/sessions/2026/02/25/rollout-short.jsonl',
        providerName: 'codex',
        providerSessionId: 'codex-session-1',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([codexFile]);
      mockReadFileHead.mockResolvedValue(`id=${sessionStartedPayload.sessionId.slice(0, 8)}`);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockValidator.validateShape).toHaveBeenCalledWith(codexFile.filePath, 'codex');
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({
          providerName: 'codex',
        }),
      );
    });

    it('should call readFileHead once per scanned file', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const files = [
        makeFileInfo({ filePath: '/tmp/a.jsonl', providerName: 'codex' }),
        makeFileInfo({ filePath: '/tmp/b.jsonl', providerName: 'codex' }),
        makeFileInfo({
          filePath: '/tmp/c.jsonl',
          providerName: 'codex',
          providerSessionId: 'codex-session-1',
        }),
      ];
      mockAdapter.discoverSessionFile.mockResolvedValue(files);
      mockReadFileHead
        .mockResolvedValueOnce('nothing')
        .mockResolvedValueOnce('still nothing')
        .mockResolvedValueOnce(`Session ${sessionStartedPayload.sessionId.slice(0, 8)}`);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockReadFileHead).toHaveBeenCalledTimes(3);
      const calledPaths = mockReadFileHead.mock.calls.map((call) => call[0]);
      expect(new Set(calledPaths).size).toBe(3);
      expect(calledPaths).toEqual(['/tmp/a.jsonl', '/tmp/b.jsonl', '/tmp/c.jsonl']);
    });

    it('should stop scanning remaining files when first candidate contains full UUID', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const files = [
        makeFileInfo({
          filePath: '/tmp/first.jsonl',
          providerName: 'codex',
          providerSessionId: 'codex-session-1',
        }),
        makeFileInfo({ filePath: '/tmp/second.jsonl', providerName: 'codex' }),
        makeFileInfo({ filePath: '/tmp/third.jsonl', providerName: 'codex' }),
      ];
      mockAdapter.discoverSessionFile.mockResolvedValue(files);
      mockReadFileHead.mockResolvedValue(`session=${sessionStartedPayload.sessionId}`);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockReadFileHead).toHaveBeenCalledTimes(1);
      expect(mockReadFileHead).toHaveBeenCalledWith('/tmp/first.jsonl', 65_536);
    });

    it('should refuse ambiguous short-id matches for non-Claude providers', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });

      const shortId = sessionStartedPayload.sessionId.slice(0, 8);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      mockAdapter.discoverSessionFile.mockResolvedValue([
        makeFileInfo({ filePath: '/home/user/.codex/sessions/2026/02/25/rollout-a.jsonl' }),
        makeFileInfo({ filePath: '/home/user/.codex/sessions/2026/02/25/rollout-b.jsonl' }),
      ]);
      mockReadFileHead.mockResolvedValue(`{"prompt":"Session ${shortId}"}`);

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await advanceAllDiscoveryRetries();
        await promise;
        expect(mockEvents.publish).not.toHaveBeenCalled();
        expect(mockValidator.validateShape).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ shortMatchCount: 2 }),
          expect.stringContaining('Short session prefix matched multiple transcript candidates'),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should apply timestamp heuristic only on final retry for non-Claude providers', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });

      const codexFile = makeFileInfo({
        filePath: '/home/user/.codex/sessions/2026/02/25/rollout-a.jsonl',
        providerName: 'codex',
        providerSessionId: 'codex-session-1',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([codexFile]);
      mockReadFileHead.mockResolvedValue(`{"timestamp":"2026-02-25T10:00:30.000Z"}`);
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null, provider_session_id: null })
        .mockReturnValueOnce({ transcript_path: null, provider_session_id: null })
        .mockReturnValueOnce({ transcript_path: null, provider_session_id: null });
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(7);
      expect(mockReadFileHead).toHaveBeenCalledTimes(7);
      expect(mockValidator.validateShape).toHaveBeenCalledWith(codexFile.filePath, 'codex');
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({
          providerName: 'codex',
        }),
      );
    });

    it('should not run timestamp heuristic on non-final retries', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'gemini',
        binPath: null,
        mcpConfigured: false,
      });
      mockAdapter.discoverSessionFile
        .mockResolvedValue([])
        .mockResolvedValueOnce([makeFileInfo({ providerName: 'gemini' })])
        .mockResolvedValueOnce([makeFileInfo({ providerName: 'gemini' })]);
      mockReadFileHead.mockResolvedValue('no id no timestamp');

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceDiscoveryRetryDelay(0);
      await advanceDiscoveryRetryDelay(1);

      expect(mockGetStartedAt).toHaveBeenCalledTimes(0);

      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockGetStartedAt).toHaveBeenCalledTimes(0);
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should refuse timestamp heuristic when multiple candidates are tied for closest', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([
        makeFileInfo({ filePath: '/tmp/a.jsonl', providerName: 'codex' }),
        makeFileInfo({ filePath: '/tmp/b.jsonl', providerName: 'codex' }),
      ]);
      mockReadFileHead.mockImplementation(async (filePath: string) =>
        filePath === '/tmp/a.jsonl'
          ? `{"timestamp":"2026-02-25T09:59:30.000Z"}`
          : `{"timestamp":"2026-02-25T10:00:30.000Z"}`,
      );
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null });
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockEvents.publish).not.toHaveBeenCalled();
      expect(mockValidator.validateShape).not.toHaveBeenCalledWith('/tmp/a.jsonl', 'codex');
      expect(mockValidator.validateShape).not.toHaveBeenCalledWith('/tmp/b.jsonl', 'codex');
    });

    it('should exclude candidates without content timestamps from timestamp heuristic', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([
        makeFileInfo({ filePath: '/tmp/no-ts.jsonl', providerName: 'codex' }),
      ]);
      mockReadFileHead.mockResolvedValue(`{"type":"assistant","text":"no timestamp field"}`);
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null });
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should parse Gemini startTime timestamps for final-attempt heuristic', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'gemini',
        binPath: null,
        mcpConfigured: false,
      });
      const geminiFile = makeFileInfo({
        filePath: '/home/user/.gemini/tmp/proj/chats/session-one.json',
        providerName: 'gemini',
        providerSessionId: 'gemini-session-1',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([geminiFile]);
      mockReadFileHead.mockResolvedValue(`{"startTime":"2026-01-29T11:50:56.120Z","title":"x"}`);
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null });
      mockGetStartedAt.mockReturnValueOnce({ started_at: '2026-01-29T11:49:56.120Z' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockValidator.validateShape).toHaveBeenCalledWith(geminiFile.filePath, 'gemini');
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({ providerName: 'gemini' }),
      );
    });

    it('should skip unreadable files (readFileHead=null) and continue discovery safely', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const files = [
        makeFileInfo({ filePath: '/tmp/unreadable.jsonl', providerName: 'codex' }),
        makeFileInfo({
          filePath: '/tmp/readable.jsonl',
          providerName: 'codex',
          providerSessionId: 'codex-session-1',
        }),
      ];
      mockAdapter.discoverSessionFile.mockResolvedValue(files);
      mockReadFileHead
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(`session=${sessionStartedPayload.sessionId}`);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockReadFileHead).toHaveBeenCalledTimes(2);
      expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/readable.jsonl', 'codex');
      expect(mockEvents.publish).toHaveBeenCalled();
    });

    it('should not persist unrelated transcripts with different content', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([
        makeFileInfo({
          filePath: '/tmp/unrelated-recent.jsonl',
          providerName: 'codex',
          lastModified: '2026-02-25T10:00:59.000Z',
        }),
      ]);
      mockReadFileHead.mockResolvedValue(
        '{"timestamp":"2026-02-24T08:00:00.000Z","content":"different session"}',
      );
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null });
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockEvents.publish).not.toHaveBeenCalled();
      expect(mockValidator.validateShape).not.toHaveBeenCalled();
    });

    it('should treat empty read content as non-match and continue retries', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([
        makeFileInfo({ filePath: '/tmp/empty.jsonl', providerName: 'codex' }),
      ]);
      mockReadFileHead.mockResolvedValue('');
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should warn when discovered transcript exceeds 10MB', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const largeFile = makeFileInfo({ sizeBytes: 10 * 1024 * 1024 + 1 });
      mockAdapter.discoverSessionFile.mockResolvedValue([largeFile]);

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await promise;
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filePath: largeFile.filePath,
            sizeBytes: largeFile.sizeBytes,
          }),
          'Discovered transcript exceeds 10MB',
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should use debug logs for non-final misses and warn on final miss', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      mockAdapter.discoverSessionFile.mockResolvedValue([]);

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await advanceAllDiscoveryRetries();
        await promise;

        const retryDebugCalls = debugSpy.mock.calls.filter(
          (call) => call[1] === 'Transcript file not found — will retry',
        );
        const finalWarnCalls = warnSpy.mock.calls.filter(
          (call) => call[1] === 'Transcript not found after all discovery retries',
        );

        expect(retryDebugCalls).toHaveLength(6);
        expect(finalWarnCalls).toHaveLength(1);
        expect(mockEvents.publish).not.toHaveBeenCalled();
      } finally {
        debugSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('should retry with exponential backoff and persist on third attempt', async () => {
      // File not found on first two attempts, found on third
      mockAdapter.discoverSessionFile
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeFileInfo()]);

      const promise = listener.handleSessionStarted(sessionStartedPayload);

      // First attempt: no file
      await jest.advanceTimersByTimeAsync(0);
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);

      // Wait for first retry delay (500ms)
      await advanceDiscoveryRetryDelay(0);
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(2);

      // Wait for second retry delay (1000ms)
      await advanceDiscoveryRetryDelay(1);
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(3);

      await promise;

      // Should have found file on third attempt and persisted
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({
          sessionId: sessionStartedPayload.sessionId,
        }),
      );
    });

    it('should retry after a Codex path-only write and backfill id when it becomes available', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const firstFile = makeFileInfo({
        filePath: '/tmp/match.jsonl',
        providerName: 'codex',
      });
      const secondFile = makeFileInfo({
        filePath: '/tmp/match.jsonl',
        providerName: 'codex',
        providerSessionId: 'codex-session-1',
      });
      mockAdapter.discoverSessionFile
        .mockResolvedValueOnce([firstFile])
        .mockResolvedValueOnce([secondFile]);
      mockReadFileHead.mockResolvedValue(`session=${sessionStartedPayload.sessionId}`);
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null, provider_session_id: null })
        .mockReturnValueOnce({
          transcript_path: '/normalized/path/session.jsonl',
          provider_session_id: null,
        });
      mockGetPersistRow
        .mockReturnValueOnce({
          transcript_path: null,
          provider_session_id: null,
          provider_name_at_launch: 'codex',
        })
        .mockReturnValueOnce({
          transcript_path: '/normalized/path/session.jsonl',
          provider_session_id: null,
          provider_name_at_launch: 'codex',
        })
        .mockReturnValueOnce({
          transcript_path: '/normalized/path/session.jsonl',
          provider_session_id: null,
          provider_name_at_launch: 'codex',
        });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);
      await advanceDiscoveryRetryDelay(0);
      await promise;

      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(2);
      expect(mockEvents.publish).toHaveBeenCalledTimes(2);
      expect(mockEvents.publish).toHaveBeenNthCalledWith(1, 'session.transcript.discovered', {
        sessionId: sessionStartedPayload.sessionId,
        agentId: sessionStartedPayload.agentId,
        projectId: 'project-1',
        transcriptPath: '/normalized/path/session.jsonl',
        providerName: 'codex',
      });
      expect(mockEvents.publish).toHaveBeenNthCalledWith(
        2,
        'session.providerSessionId.discovered',
        {
          sessionId: sessionStartedPayload.sessionId,
          providerSessionId: 'codex-session-1',
          providerName: 'codex',
        },
      );
    });

    it('should warn on final retry when Codex provider id never flushes after path-only writes', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const file = makeFileInfo({
        filePath: '/tmp/match.jsonl',
        providerName: 'codex',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([file]);
      mockReadFileHead.mockResolvedValue(`session=${sessionStartedPayload.sessionId}`);
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null, provider_session_id: null })
        .mockReturnValueOnce({
          transcript_path: '/normalized/path/session.jsonl',
          provider_session_id: null,
        })
        .mockReturnValueOnce({
          transcript_path: '/normalized/path/session.jsonl',
          provider_session_id: null,
        });
      mockGetPersistRow
        .mockReturnValue({
          transcript_path: '/normalized/path/session.jsonl',
          provider_session_id: null,
          provider_name_at_launch: 'codex',
        })
        .mockReturnValueOnce({
          transcript_path: null,
          provider_session_id: null,
          provider_name_at_launch: 'codex',
        });

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await advanceAllDiscoveryRetries();
        await promise;

        expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(7);
        expect(mockEvents.publish).toHaveBeenCalledTimes(1);
        expect(mockEvents.publish).toHaveBeenCalledWith('session.transcript.discovered', {
          sessionId: sessionStartedPayload.sessionId,
          agentId: sessionStartedPayload.agentId,
          projectId: 'project-1',
          transcriptPath: '/normalized/path/session.jsonl',
          providerName: 'codex',
        });
        expect(mockEvents.publish).not.toHaveBeenCalledWith(
          'session.providerSessionId.discovered',
          expect.anything(),
        );
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: sessionStartedPayload.sessionId,
            reason: 'providerSessionIdNotFlushed',
            attempt: 7,
            maxRetries: 6,
          }),
          'Provider session id not available after final discovery attempt',
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should persist on attempt 2 when attempt 1 has no files', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockAdapter.discoverSessionFile.mockResolvedValueOnce([]).mockResolvedValueOnce([
        makeFileInfo({
          filePath: '/tmp/match-2.jsonl',
          providerName: 'codex',
          providerSessionId: 'codex-session-1',
        }),
      ]);
      mockReadFileHead.mockResolvedValue(`session=${sessionStartedPayload.sessionId}`);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);
      await advanceDiscoveryRetryDelay(0);
      await promise;

      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(2);
      expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/match-2.jsonl', 'codex');
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({
          providerName: 'codex',
          sessionId: sessionStartedPayload.sessionId,
        }),
      );
    });

    it('should not persist if file never found after all retries', async () => {
      mockAdapter.discoverSessionFile.mockResolvedValue([]);

      const promise = listener.handleSessionStarted(sessionStartedPayload);

      // Advance through all retries
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(7);
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should skip if transcript already discovered via hooks (deduplication)', async () => {
      // Hooks already set complete transcript metadata.
      mockGetTranscriptPath.mockReturnValue({
        transcript_path: '/already/set.jsonl',
        provider_session_id: 'claude-session-1',
      });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockAdapter.discoverSessionFile).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should stop retrying if hooks complete metadata between retries', async () => {
      mockAdapter.discoverSessionFile.mockResolvedValue([]);

      // First attempt: no transcript_path, no file found
      // Before second attempt: hooks have set complete metadata
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null, provider_session_id: null })
        .mockReturnValueOnce({
          transcript_path: '/hook/set.jsonl',
          provider_session_id: 'claude-session-1',
        });

      const promise = listener.handleSessionStarted(sessionStartedPayload);

      await jest.advanceTimersByTimeAsync(0);
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);

      await advanceDiscoveryRetryDelay(0);
      await promise;

      // Should have stopped after detecting hook-set path
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should skip if no adapter found for provider', async () => {
      mockAdapterFactory.getAdapter.mockReturnValue(undefined);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockAdapter.discoverSessionFile).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should skip if provider chain resolution fails', async () => {
      mockStorage.getAgent.mockRejectedValue(new Error('Agent not found'));

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockAdapter.discoverSessionFile).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should skip persist if validation fails on discovered path', async () => {
      mockAdapter.discoverSessionFile.mockResolvedValue([makeFileInfo()]);
      mockValidator.validateShape.mockImplementation(() => {
        throw new ValidationError('path outside allowed root');
      });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should not overwrite an existing different transcript path', async () => {
      mockAdapter.discoverSessionFile.mockResolvedValue([makeFileInfo()]);
      mockGetPersistRow.mockReturnValue({
        transcript_path: '/hook/set.jsonl',
        provider_session_id: null,
        provider_name_at_launch: 'claude',
      });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockRun).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should not propagate errors from auto-discovery', async () => {
      mockAdapter.discoverSessionFile.mockRejectedValue(new Error('fs error'));

      await expect(
        (async () => {
          const promise = listener.handleSessionStarted(sessionStartedPayload);
          await jest.advanceTimersByTimeAsync(0);
          await promise;
        })(),
      ).resolves.not.toThrow();
    });
  });
});
