import { Logger } from '@nestjs/common';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { TranscriptPersistenceListener } from './transcript-persistence.listener';
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

const mockReadFileHead = readFileHead as jest.MockedFunction<typeof readFileHead>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDb() {
  const mockGetTranscriptPath = jest.fn();
  const mockGetStartedAt = jest.fn();
  const mockRun = jest.fn().mockReturnValue({ changes: 1 });
  const mockPrepare = jest.fn((sql: string) => {
    if (sql.includes('SELECT transcript_path')) {
      return { get: mockGetTranscriptPath, run: mockRun };
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

  return { mockDb, mockPrepare, mockRun, mockGetTranscriptPath, mockGetStartedAt };
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TranscriptPersistenceListener', () => {
  let listener: TranscriptPersistenceListener;
  let mockValidator: jest.Mocked<Pick<TranscriptPathValidator, 'validateShape'>>;
  let mockEvents: jest.Mocked<Pick<EventsService, 'publish'>>;
  let mockRun: jest.Mock;
  let mockGetTranscriptPath: jest.Mock;
  let mockGetStartedAt: jest.Mock;
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
    mockGetStartedAt = db.mockGetStartedAt;

    mockValidator = {
      validateShape: jest.fn().mockReturnValue('/normalized/path/session.jsonl'),
    };

    mockEvents = {
      publish: jest.fn().mockResolvedValue('event-id'),
    };

    mockStorage = createMockStorage();
    mockAdapterFactory = createMockAdapterFactory();

    listener = new TranscriptPersistenceListener(
      db.mockDb,
      mockValidator as unknown as TranscriptPathValidator,
      mockEvents as unknown as EventsService,
      mockAdapterFactory as unknown as SessionReaderAdapterFactory,
      mockStorage as unknown as StorageService,
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

  // -------------------------------------------------------------------------
  // Auto-discovery on session launch
  // -------------------------------------------------------------------------

  describe('handleSessionStarted (auto-discovery)', () => {
    let mockAdapter: ReturnType<typeof createMockAdapter>;

    beforeEach(() => {
      mockAdapter = createMockAdapter();
      mockAdapterFactory.getAdapter.mockReturnValue(mockAdapter as unknown as SessionReaderAdapter);
      // By default: session has no transcript_path yet
      mockGetTranscriptPath.mockReturnValue({ transcript_path: null });
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

      // Should persist (UPDATE with transcript_path IS NULL condition)
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('transcript_path IS NULL'));

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
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([codexFile]);
      mockReadFileHead.mockResolvedValue(
        `{"type":"session_meta","payload":{"id":"abc"},"session":"${sessionStartedPayload.sessionId}"}`,
      );

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockReadFileHead).toHaveBeenCalledWith(codexFile.filePath, 16_384);
      expect(mockValidator.validateShape).toHaveBeenCalledWith(codexFile.filePath, 'codex');
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({
          providerName: 'codex',
        }),
      );
    });

    it('should log full UUID content matches with matchType full', async () => {
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
            matchType: 'full',
          }),
          'Auto-discovered transcript via content match',
        );
      } finally {
        logSpy.mockRestore();
      }
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
        makeFileInfo({ filePath: '/tmp/c.jsonl', providerName: 'codex' }),
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
        makeFileInfo({ filePath: '/tmp/first.jsonl', providerName: 'codex' }),
        makeFileInfo({ filePath: '/tmp/second.jsonl', providerName: 'codex' }),
        makeFileInfo({ filePath: '/tmp/third.jsonl', providerName: 'codex' }),
      ];
      mockAdapter.discoverSessionFile.mockResolvedValue(files);
      mockReadFileHead.mockResolvedValue(`session=${sessionStartedPayload.sessionId}`);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockReadFileHead).toHaveBeenCalledTimes(1);
      expect(mockReadFileHead).toHaveBeenCalledWith('/tmp/first.jsonl', 16_384);
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
        await jest.advanceTimersByTimeAsync(2000);
        await jest.advanceTimersByTimeAsync(2000);
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
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([codexFile]);
      mockReadFileHead.mockResolvedValue(`{"timestamp":"2026-02-25T10:00:30.000Z"}`);
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null });
      mockGetStartedAt.mockReturnValueOnce({ started_at: '2026-02-25T10:00:00.000Z' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(2000);
      await promise;

      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(3);
      expect(mockReadFileHead).toHaveBeenCalledTimes(3);
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
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockAdapter.discoverSessionFile
        .mockResolvedValueOnce([makeFileInfo({ providerName: 'codex' })])
        .mockResolvedValueOnce([makeFileInfo({ providerName: 'codex' })])
        .mockResolvedValueOnce([]);
      mockReadFileHead.mockResolvedValue('no id no timestamp');

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(2000);
      await promise;

      expect(mockGetStartedAt).toHaveBeenCalledTimes(0);
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should refuse timestamp heuristic when multiple candidates are in window', async () => {
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
      mockReadFileHead
        .mockResolvedValueOnce(`{"timestamp":"2026-02-25T10:00:30.000Z"}`)
        .mockResolvedValueOnce(`{"timestamp":"2026-02-25T10:00:40.000Z"}`);
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null });
      mockGetStartedAt.mockReturnValueOnce({ started_at: '2026-02-25T10:00:00.000Z' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(2000);
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
      mockGetStartedAt.mockReturnValueOnce({ started_at: '2026-02-25T10:00:00.000Z' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(2000);
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
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(2000);
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
        makeFileInfo({ filePath: '/tmp/readable.jsonl', providerName: 'codex' }),
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
      mockGetStartedAt.mockReturnValueOnce({ started_at: '2026-02-25T10:00:00.000Z' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(2000);
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
      mockGetStartedAt.mockReturnValueOnce({ started_at: '2026-02-25T10:00:00.000Z' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(2000);
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
        await jest.advanceTimersByTimeAsync(2000);
        await jest.advanceTimersByTimeAsync(2000);
        await promise;

        const retryDebugCalls = debugSpy.mock.calls.filter(
          (call) => call[1] === 'Transcript file not found — will retry',
        );
        const finalWarnCalls = warnSpy.mock.calls.filter(
          (call) => call[1] === 'Transcript not found after all discovery retries',
        );

        expect(retryDebugCalls).toHaveLength(2);
        expect(finalWarnCalls).toHaveLength(1);
        expect(mockEvents.publish).not.toHaveBeenCalled();
      } finally {
        debugSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('should retry up to 3 times with 2s delay', async () => {
      // File not found on first two attempts, found on third
      mockAdapter.discoverSessionFile
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeFileInfo()]);

      const promise = listener.handleSessionStarted(sessionStartedPayload);

      // First attempt: no file
      await jest.advanceTimersByTimeAsync(0);
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);

      // Wait for first retry delay (2s)
      await jest.advanceTimersByTimeAsync(2000);
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(2);

      // Wait for second retry delay (2s)
      await jest.advanceTimersByTimeAsync(2000);
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

    it('should persist on attempt 2 when attempt 1 has no files', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockAdapter.discoverSessionFile
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          makeFileInfo({ filePath: '/tmp/match-2.jsonl', providerName: 'codex' }),
        ]);
      mockReadFileHead.mockResolvedValue(`session=${sessionStartedPayload.sessionId}`);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2000);
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
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(2000);
      await promise;

      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(3);
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should skip if transcript already discovered via hooks (deduplication)', async () => {
      // Hooks already set the transcript_path
      mockGetTranscriptPath.mockReturnValue({ transcript_path: '/already/set.jsonl' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockAdapter.discoverSessionFile).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should stop retrying if hooks set path between retries', async () => {
      mockAdapter.discoverSessionFile.mockResolvedValue([]);

      // First attempt: no transcript_path, no file found
      // Before second attempt: hooks have set transcript_path
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: '/hook/set.jsonl' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);

      await jest.advanceTimersByTimeAsync(0);
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(2000);
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

    it('should not overwrite hook-set path (SQL WHERE transcript_path IS NULL)', async () => {
      mockAdapter.discoverSessionFile.mockResolvedValue([makeFileInfo()]);
      // The UPDATE with IS NULL condition returns 0 changes (hook already wrote)
      mockRun.mockReturnValue({ changes: 0 });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('transcript_path IS NULL'));
      // Should not publish since persist returned 0 changes
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
