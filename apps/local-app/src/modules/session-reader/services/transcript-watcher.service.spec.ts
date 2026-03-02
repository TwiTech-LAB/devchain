import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { TranscriptWatcherService } from './transcript-watcher.service';
import type { SessionCacheService } from './session-cache.service';
import type { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import type { EventsService } from '../../events/services/events.service';
import type { SessionReaderAdapter } from '../adapters/session-reader-adapter.interface';
import type { UnifiedSession, UnifiedMetrics } from '../dtos/unified-session.types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('node:fs');
jest.mock('node:fs/promises');

const mockedFsWatch = fs.watch as jest.MockedFunction<typeof fs.watch>;
const mockedFsPromisesStat = fsPromises.stat as jest.MockedFunction<typeof fsPromises.stat>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetrics(overrides: Partial<UnifiedMetrics> = {}): UnifiedMetrics {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheCreationTokens: 5,
    totalTokens: 165,
    totalContextConsumption: 100,
    compactionCount: 0,
    phaseBreakdowns: [],
    visibleContextTokens: 100,
    totalContextTokens: 0,
    contextWindowTokens: 200_000,
    costUsd: 0.01,
    primaryModel: 'claude-opus-4-6',
    durationMs: 5000,
    messageCount: 3,
    isOngoing: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: 'session-1',
    providerName: 'claude',
    filePath: '/tmp/test.jsonl',
    messages: [],
    metrics: makeMetrics(),
    isOngoing: false,
    ...overrides,
  };
}

function makeStat(size: number, ino = 12345): fs.Stats {
  return {
    size,
    ino,
    mtime: new Date(1706000000000),
    isFile: () => true,
    isDirectory: () => false,
  } as unknown as fs.Stats;
}

type MockFsWatcher = fs.FSWatcher & {
  triggerChange: (eventType: string) => void;
  triggerError: (err: Error) => void;
};

function createMockFsWatcher(): MockFsWatcher {
  type AnyHandler = (...args: unknown[]) => void;
  const handlers = new Map<string, AnyHandler[]>();
  let changeCallback: ((eventType: string, filename: string | null) => void) | null = null;

  const watcher = {
    close: jest.fn(),
    on: jest.fn((event: string, handler: AnyHandler) => {
      const existing = handlers.get(event) || [];
      existing.push(handler);
      handlers.set(event, existing);
      return watcher;
    }),
    once: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    removeAllListeners: jest.fn(),
    setMaxListeners: jest.fn(),
    getMaxListeners: jest.fn(),
    listeners: jest.fn(),
    rawListeners: jest.fn(),
    listenerCount: jest.fn(),
    prependListener: jest.fn(),
    prependOnceListener: jest.fn(),
    eventNames: jest.fn(),
    ref: jest.fn().mockReturnThis(),
    unref: jest.fn().mockReturnThis(),
    [Symbol.dispose]: jest.fn(),
    triggerChange(eventType: string) {
      if (changeCallback) changeCallback(eventType, null);
    },
    triggerError(err: Error) {
      const errorHandlers = handlers.get('error') || [];
      for (const handler of errorHandlers) handler(err);
    },
  };

  mockedFsWatch.mockImplementation((_path: fs.PathLike, callback: fs.WatchListener<string>) => {
    changeCallback = callback as (eventType: string, filename: string | null) => void;
    return watcher as unknown as fs.FSWatcher;
  });

  return watcher as unknown as MockFsWatcher;
}

function createMockAdapter(): SessionReaderAdapter {
  return {
    providerName: 'claude',
    incrementalMode: 'delta',
    allowedRoots: [],
    discoverSessionFile: jest.fn(),
    parseSessionFile: jest.fn(),
    parseIncremental: jest.fn(),
    getWatchPaths: jest.fn(),
    calculateCost: jest.fn(),
    parseFullSession: jest.fn(),
  };
}

function createMocks() {
  const mockAdapter = createMockAdapter();

  const mockCacheService = {
    getOrParse: jest.fn().mockResolvedValue(makeSession()),
    invalidate: jest.fn(),
    clear: jest.fn(),
    onModuleDestroy: jest.fn(),
    size: 0,
  } as unknown as jest.Mocked<SessionCacheService>;

  const mockAdapterFactory = {
    getAdapter: jest.fn().mockReturnValue(mockAdapter),
    registerAdapter: jest.fn(),
    getSupportedProviders: jest.fn(),
  } as unknown as jest.Mocked<SessionReaderAdapterFactory>;

  const mockEvents = {
    publish: jest.fn().mockResolvedValue('event-id'),
  } as unknown as jest.Mocked<EventsService>;

  return { mockCacheService, mockAdapterFactory, mockEvents, mockAdapter };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TranscriptWatcherService', () => {
  let service: TranscriptWatcherService;
  let mockCacheService: ReturnType<typeof createMocks>['mockCacheService'];
  let mockAdapterFactory: ReturnType<typeof createMocks>['mockAdapterFactory'];
  let mockEvents: ReturnType<typeof createMocks>['mockEvents'];

  const SESSION_ID = 'session-1';
  const FILE_PATH = '/tmp/test.jsonl';
  const PROVIDER_NAME = 'claude';

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    const mocks = createMocks();
    mockCacheService = mocks.mockCacheService;
    mockAdapterFactory = mocks.mockAdapterFactory;
    mockEvents = mocks.mockEvents;

    service = new TranscriptWatcherService(mockCacheService, mockAdapterFactory, mockEvents);

    mockedFsPromisesStat.mockResolvedValue(makeStat(1000));
    createMockFsWatcher();
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // startWatching / stopWatching lifecycle
  // -------------------------------------------------------------------------

  describe('startWatching', () => {
    it('should create a watcher and register it', async () => {
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      expect(service.activeWatcherCount).toBe(1);
      expect(mockedFsWatch).toHaveBeenCalledWith(FILE_PATH, expect.any(Function));
    });

    it('should skip if watcher already exists for session', async () => {
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockedFsWatch.mockClear();

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      expect(service.activeWatcherCount).toBe(1);
      expect(mockedFsWatch).not.toHaveBeenCalled();
    });

    it('should skip if file cannot be statted', async () => {
      mockedFsPromisesStat.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      expect(service.activeWatcherCount).toBe(0);
    });

    it('should fall back to stat-poll only if fs.watch fails', async () => {
      mockedFsWatch.mockImplementation(() => {
        throw new Error('fs.watch not supported');
      });

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // Still registers — using stat-poll only
      expect(service.activeWatcherCount).toBe(1);
    });
  });

  describe('stopWatching', () => {
    it('should cleanup watcher and emit ended event', async () => {
      const session = makeSession({ metrics: makeMetrics({ messageCount: 10 }) });
      mockCacheService.getOrParse.mockResolvedValue(session);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      await service.stopWatching(SESSION_ID, 'session.stopped');

      expect(service.activeWatcherCount).toBe(0);
      expect(mockEvents.publish).toHaveBeenCalledWith('session.transcript.ended', {
        sessionId: SESSION_ID,
        transcriptPath: FILE_PATH,
        finalMetrics: {
          totalTokens: session.metrics.totalTokens,
          inputTokens: session.metrics.inputTokens,
          outputTokens: session.metrics.outputTokens,
          costUsd: session.metrics.costUsd,
          messageCount: session.metrics.messageCount,
        },
        endReason: 'session.stopped',
      });
    });

    it('should be a no-op for unknown session', async () => {
      await service.stopWatching('unknown-session');

      expect(service.activeWatcherCount).toBe(0);
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should use last known metrics if final parse fails', async () => {
      mockCacheService.getOrParse.mockRejectedValue(new Error('File not found'));

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      await service.stopWatching(SESSION_ID, 'file.deleted');

      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.ended',
        expect.objectContaining({
          sessionId: SESSION_ID,
          endReason: 'file.deleted',
          finalMetrics: expect.objectContaining({ messageCount: 0 }),
        }),
      );
    });

    it('should prevent double-stop', async () => {
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      await Promise.all([
        service.stopWatching(SESSION_ID, 'session.stopped'),
        service.stopWatching(SESSION_ID, 'session.stopped'),
      ]);

      // Only one ended event (second stopWatching finds no state)
      expect(mockEvents.publish).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Debounce behavior
  // -------------------------------------------------------------------------

  describe('debounce', () => {
    it('should debounce rapid file changes (100ms)', async () => {
      const session = makeSession({ metrics: makeMetrics({ messageCount: 5 }) });
      mockCacheService.getOrParse.mockResolvedValue(session);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // File grew
      mockedFsPromisesStat.mockResolvedValue(makeStat(1500));

      // Trigger stat-poll → detects size change → schedules debounce
      await jest.advanceTimersByTimeAsync(3000);

      // Debounce hasn't fired yet (only 0ms of debounce elapsed)
      expect(mockCacheService.getOrParse).not.toHaveBeenCalled();

      // Advance past debounce (100ms)
      await jest.advanceTimersByTimeAsync(150);

      // Should have been called exactly once (debounced)
      expect(mockCacheService.getOrParse).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Event-driven triggers
  // -------------------------------------------------------------------------

  describe('event handlers', () => {
    it('should start watching on transcript.discovered event', async () => {
      await service.handleTranscriptDiscovered({
        sessionId: SESSION_ID,
        agentId: 'agent-1',
        projectId: 'project-1',
        transcriptPath: FILE_PATH,
        providerName: PROVIDER_NAME,
      });

      expect(service.activeWatcherCount).toBe(1);
    });

    it('should stop watching on session.stopped event', async () => {
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      await service.handleSessionStopped({ sessionId: SESSION_ID });

      expect(service.activeWatcherCount).toBe(0);
    });

    it('should stop watching on session.crashed event with crash end reason', async () => {
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      await service.handleSessionCrashed({ sessionId: SESSION_ID, sessionName: 'test' });

      expect(service.activeWatcherCount).toBe(0);
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.ended',
        expect.objectContaining({
          sessionId: SESSION_ID,
          endReason: 'session.crashed',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // File change detection → publish event
  // -------------------------------------------------------------------------

  describe('file change detection', () => {
    it('should publish transcript.updated when new messages are found', async () => {
      const session = makeSession({
        metrics: makeMetrics({ messageCount: 5, totalTokens: 500, costUsd: 0.05 }),
      });
      mockCacheService.getOrParse.mockResolvedValue(session);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // File grew
      mockedFsPromisesStat.mockResolvedValue(makeStat(1500));

      // Trigger stat-poll → detects size change → schedules debounce
      await jest.advanceTimersByTimeAsync(3000);
      // Wait for debounce to fire + async handler
      await jest.advanceTimersByTimeAsync(200);

      expect(mockEvents.publish).toHaveBeenCalledWith('session.transcript.updated', {
        sessionId: SESSION_ID,
        transcriptPath: FILE_PATH,
        newMessageCount: 5,
        metrics: {
          totalTokens: 500,
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.05,
          messageCount: 5,
        },
      });
    });

    it('should NOT publish when no new messages found', async () => {
      const session = makeSession({ metrics: makeMetrics({ messageCount: 0 }) });
      mockCacheService.getOrParse.mockResolvedValue(session);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      mockedFsPromisesStat.mockResolvedValue(makeStat(1500));

      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(200);

      expect(mockEvents.publish).not.toHaveBeenCalledWith(
        'session.transcript.updated',
        expect.anything(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Error isolation
  // -------------------------------------------------------------------------

  describe('error isolation', () => {
    it('should not crash other watchers when one fails', async () => {
      // Start two watchers
      await service.startWatching('session-a', '/tmp/a.jsonl', PROVIDER_NAME);
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000, 99999));
      createMockFsWatcher();
      await service.startWatching('session-b', '/tmp/b.jsonl', PROVIDER_NAME);

      expect(service.activeWatcherCount).toBe(2);

      // Make parse fail
      mockCacheService.getOrParse.mockRejectedValueOnce(new Error('Parse failed'));

      // Trigger change via stat-poll
      mockedFsPromisesStat.mockResolvedValue(makeStat(3000));
      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(200);

      // Both watchers should still be active
      expect(service.activeWatcherCount).toBe(2);
    });

    it('should handle fs.watch error gracefully', async () => {
      const mockWatcher = createMockFsWatcher();

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // Trigger fs.watch error
      mockWatcher.triggerError(new Error('inotify limit'));

      // Watcher should still be active (falls back to stat-poll)
      expect(service.activeWatcherCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // onModuleDestroy
  // -------------------------------------------------------------------------

  describe('onModuleDestroy', () => {
    it('should cleanup all watchers without emitting events', async () => {
      await service.startWatching('s1', '/tmp/1.jsonl', PROVIDER_NAME);
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000, 99999));
      createMockFsWatcher();
      await service.startWatching('s2', '/tmp/2.jsonl', PROVIDER_NAME);

      expect(service.activeWatcherCount).toBe(2);

      service.onModuleDestroy();

      expect(service.activeWatcherCount).toBe(0);
      // onModuleDestroy uses cleanupResources, not stopWatching — no events
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // File deleted via stat-poll
  // -------------------------------------------------------------------------

  describe('file deletion', () => {
    it('should stop watching and emit ended when file is deleted', async () => {
      const session = makeSession({ metrics: makeMetrics({ messageCount: 10 }) });
      mockCacheService.getOrParse.mockResolvedValue(session);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // File deleted on next stat-poll
      mockedFsPromisesStat.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      await jest.advanceTimersByTimeAsync(3000);

      expect(service.activeWatcherCount).toBe(0);
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.ended',
        expect.objectContaining({
          sessionId: SESSION_ID,
          endReason: 'file.deleted',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // checkStatPoll branch coverage
  // -------------------------------------------------------------------------

  describe('checkStatPoll branches', () => {
    it('should detect inode rotation via stat-poll and reopen fs.watch', async () => {
      const mockWatcher = createMockFsWatcher();

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // Stat returns different inode but same size (no debounce triggered)
      mockedFsPromisesStat.mockResolvedValue(makeStat(1000, 99999));

      await jest.advanceTimersByTimeAsync(3000);

      // Old watcher should have been closed and a new one created
      expect(mockWatcher.close).toHaveBeenCalled();
      expect(service.activeWatcherCount).toBe(1);
    });

    it('should not schedule debounce when size is unchanged in stat-poll', async () => {
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // Stat returns same size and same inode
      mockedFsPromisesStat.mockResolvedValue(makeStat(1000));

      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(200);

      // No parse should have been triggered
      expect(mockCacheService.getOrParse).not.toHaveBeenCalled();
    });

    it('should propagate non-ENOENT stat errors in stat-poll', async () => {
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // Stat fails with EACCES (non-ENOENT)
      mockedFsPromisesStat.mockRejectedValue(
        Object.assign(new Error('EACCES'), { code: 'EACCES' }),
      );

      // Advance to trigger poll — error is caught by poll's .catch handler
      await jest.advanceTimersByTimeAsync(3000);

      // Watcher should still be active (error caught by .catch in setInterval)
      expect(service.activeWatcherCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // handleFileChanged branch coverage
  // -------------------------------------------------------------------------

  describe('handleFileChanged branches', () => {
    it('should stop watching when file is deleted during change handling', async () => {
      const session = makeSession({ metrics: makeMetrics({ messageCount: 5 }) });
      mockCacheService.getOrParse.mockResolvedValue(session);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // First stat-poll: file grew → schedules debounce
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));
      await jest.advanceTimersByTimeAsync(3000);

      // Now during debounced handler, stat returns ENOENT
      mockedFsPromisesStat.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
      await jest.advanceTimersByTimeAsync(200);

      expect(service.activeWatcherCount).toBe(0);
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.ended',
        expect.objectContaining({ endReason: 'file.deleted' }),
      );
    });

    it('should handle non-ENOENT stat error in change handler gracefully', async () => {
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // First stat-poll: file grew → schedules debounce
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));
      await jest.advanceTimersByTimeAsync(3000);

      // Now during debounced handler, stat returns EACCES
      mockedFsPromisesStat.mockRejectedValue(
        Object.assign(new Error('EACCES'), { code: 'EACCES' }),
      );
      await jest.advanceTimersByTimeAsync(200);

      // Watcher should remain active (error caught by outer try/catch)
      expect(service.activeWatcherCount).toBe(1);
    });

    it('should detect inode rotation in change handler and reopen fs.watch', async () => {
      const mockWatcher = createMockFsWatcher();
      const session = makeSession({ metrics: makeMetrics({ messageCount: 5 }) });
      mockCacheService.getOrParse.mockResolvedValue(session);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // File grew AND inode changed
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000, 99999));
      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(200);

      // Old watcher should have been closed
      expect(mockWatcher.close).toHaveBeenCalled();
      expect(mockCacheService.getOrParse).toHaveBeenCalled();
    });

    it('should skip parse when size has not changed in change handler', async () => {
      const session = makeSession({ metrics: makeMetrics({ messageCount: 5 }) });
      mockCacheService.getOrParse.mockResolvedValue(session);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // First stat-poll: file grew → schedules debounce
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));
      await jest.advanceTimersByTimeAsync(3000);

      // By the time debounce fires, stat returns original size
      mockedFsPromisesStat.mockResolvedValue(makeStat(1000));
      await jest.advanceTimersByTimeAsync(200);

      // getOrParse should NOT have been called (size unchanged in handler)
      expect(mockCacheService.getOrParse).not.toHaveBeenCalled();
    });

    it('should log warning when incremental delta exceeds 10MB', async () => {
      const session = makeSession({ metrics: makeMetrics({ messageCount: 5 }) });
      mockCacheService.getOrParse.mockResolvedValue(session);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // File grew by more than 10MB
      const largeSize = 1000 + 11 * 1024 * 1024;
      mockedFsPromisesStat.mockResolvedValue(makeStat(largeSize));
      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(200);

      // Should still parse despite the warning
      expect(mockCacheService.getOrParse).toHaveBeenCalled();
    });

    it('should return early when no adapter is found during change handling', async () => {
      mockAdapterFactory.getAdapter.mockReturnValue(null as never);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));
      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(200);

      // No parse should occur since adapter is null
      expect(mockCacheService.getOrParse).not.toHaveBeenCalled();
      expect(service.activeWatcherCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // reopenFsWatcher branch coverage
  // -------------------------------------------------------------------------

  describe('reopenFsWatcher branches', () => {
    it('should handle fs.watch failure during reopen after inode rotation', async () => {
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // Make fs.watch throw on next call (reopen attempt)
      mockedFsWatch.mockImplementation(() => {
        throw new Error('inotify limit reached');
      });

      // Trigger inode rotation via stat-poll
      mockedFsPromisesStat.mockResolvedValue(makeStat(1000, 99999));
      await jest.advanceTimersByTimeAsync(3000);

      // Watcher should still be active (falls back to stat-poll only)
      expect(service.activeWatcherCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // stopWatching edge cases
  // -------------------------------------------------------------------------

  describe('stopWatching edge cases', () => {
    it('should use last known metrics when no adapter is found during final parse', async () => {
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // Remove adapter after start
      mockAdapterFactory.getAdapter.mockReturnValue(null as never);

      await service.stopWatching(SESSION_ID, 'session.stopped');

      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.ended',
        expect.objectContaining({
          sessionId: SESSION_ID,
          finalMetrics: expect.objectContaining({ messageCount: 0 }),
        }),
      );
    });

    it('should handle publish error during stopWatching gracefully', async () => {
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockEvents.publish.mockRejectedValueOnce(new Error('EventBus down'));

      // Should not throw — error is caught internally
      await expect(service.stopWatching(SESSION_ID, 'session.stopped')).resolves.not.toThrow();
      expect(service.activeWatcherCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // fs.watch event type coverage
  // -------------------------------------------------------------------------

  describe('fs.watch event types', () => {
    it('should schedule debounce on rename event', async () => {
      const mockWatcher = createMockFsWatcher();
      const session = makeSession({ metrics: makeMetrics({ messageCount: 5 }) });
      mockCacheService.getOrParse.mockResolvedValue(session);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // Trigger rename event via fs.watch (not change)
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));
      mockWatcher.triggerChange('rename');

      await jest.advanceTimersByTimeAsync(200);

      expect(mockCacheService.getOrParse).toHaveBeenCalled();
    });

    it('should ignore non-change/rename events', async () => {
      const mockWatcher = createMockFsWatcher();

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // Trigger an unrecognized event type
      mockWatcher.triggerChange('access');

      await jest.advanceTimersByTimeAsync(200);

      // No parse triggered
      expect(mockCacheService.getOrParse).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // handleTranscriptDiscovered error coverage
  // -------------------------------------------------------------------------

  describe('handleTranscriptDiscovered error handling', () => {
    it('should catch and log errors from startWatching', async () => {
      // Spy on startWatching to force an unhandled throw
      jest.spyOn(service, 'startWatching').mockRejectedValue(new Error('Unexpected crash'));

      // Should not throw — caught by handleTranscriptDiscovered's try/catch (line 71)
      await expect(
        service.handleTranscriptDiscovered({
          sessionId: SESSION_ID,
          agentId: 'agent-1',
          projectId: 'project-1',
          transcriptPath: FILE_PATH,
          providerName: PROVIDER_NAME,
        }),
      ).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Debounce timer reset branch (line 193)
  // -------------------------------------------------------------------------

  describe('debounce timer reset', () => {
    it('should clear existing debounce timer when a new change arrives', async () => {
      const mockWatcher = createMockFsWatcher();
      const session = makeSession({ metrics: makeMetrics({ messageCount: 5 }) });
      mockCacheService.getOrParse.mockResolvedValue(session);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // File changed
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));

      // First change event → schedules debounce
      mockWatcher.triggerChange('change');

      // Second change event BEFORE debounce fires → clears old + schedules new (line 193)
      mockWatcher.triggerChange('change');

      // Advance past debounce
      await jest.advanceTimersByTimeAsync(200);

      // Should only be called once (debounced)
      expect(mockCacheService.getOrParse).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // handleFileChanged inode rotation (lines 252-254)
  // -------------------------------------------------------------------------

  describe('handleFileChanged inode rotation', () => {
    it('should detect inode rotation in handleFileChanged when inode changes between poll and debounce', async () => {
      const mockWatcher = createMockFsWatcher();
      const session = makeSession({ metrics: makeMetrics({ messageCount: 5 }) });
      mockCacheService.getOrParse.mockResolvedValue(session);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // During stat-poll: same inode but size changed → schedules debounce
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000, 12345));
      await jest.advanceTimersByTimeAsync(3000);

      // Between stat-poll and debounce: inode changes (file rotated)
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000, 77777));

      // Fire debounce → handleFileChanged sees new inode (lines 251-254)
      await jest.advanceTimersByTimeAsync(200);

      // Watcher should have been closed and reopened due to inode rotation
      expect(mockWatcher.close).toHaveBeenCalled();
      expect(mockCacheService.getOrParse).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup with active debounce timer (branch: debounceTimer truthy in cleanup)
  // -------------------------------------------------------------------------

  describe('cleanup with active debounce', () => {
    it('should clear pending debounce timer during cleanup', async () => {
      const mockWatcher = createMockFsWatcher();

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // Trigger change → schedules debounce (100ms)
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));
      mockWatcher.triggerChange('change');

      // Destroy before debounce fires — cleanupResources should clear the debounce timer
      service.onModuleDestroy();

      expect(service.activeWatcherCount).toBe(0);

      // Advance past debounce — handler should NOT fire since timer was cleared
      await jest.advanceTimersByTimeAsync(200);

      expect(mockCacheService.getOrParse).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Defensive !state branches (race condition guards)
  // -------------------------------------------------------------------------

  describe('race condition guards', () => {
    it('should handle scheduleDebounce when watcher is already removed', async () => {
      const mockWatcher = createMockFsWatcher();

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // Stop watching (removes state from map)
      const session = makeSession({ metrics: makeMetrics({ messageCount: 0 }) });
      mockCacheService.getOrParse.mockResolvedValue(session);
      await service.stopWatching(SESSION_ID, 'session.stopped');

      expect(service.activeWatcherCount).toBe(0);

      // Trigger fs.watch event AFTER watcher was stopped — scheduleDebounce finds no state
      mockWatcher.triggerChange('change');

      // Advance past debounce — nothing should happen
      await jest.advanceTimersByTimeAsync(200);

      // getOrParse should only have been called once (during stopWatching's final parse)
      expect(mockCacheService.getOrParse).toHaveBeenCalledTimes(1);
    });
  });
});
