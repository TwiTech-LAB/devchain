import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { TranscriptWatcherService } from './transcript-watcher.service';
import type { SessionCacheService, GetOrParseResult } from './session-cache.service';
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

function makeStat(size: number, ino = 12345, dev = 1): fs.Stats {
  return {
    size,
    ino,
    dev,
    mtime: new Date(1706000000000),
    isFile: () => true,
    isDirectory: () => false,
  } as unknown as fs.Stats;
}

function makeParseResult(overrides: Partial<GetOrParseResult> = {}): GetOrParseResult {
  return {
    session: makeSession(),
    sourceVersion: 1000,
    cacheHit: false,
    sourceChangeKind: 'same-file-append',
    lastOffset: 1000,
    lastSize: 1000,
    lastMtime: 1706000000000,
    boundaryFold: false,
    ...overrides,
  };
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
  const getOrParse = jest.fn().mockResolvedValue(makeSession());
  const getOrParseWithMeta = jest.fn(async (...args: unknown[]) => ({
    session: await getOrParse(...args),
    sourceVersion: 1000,
    cacheHit: false,
    sourceChangeKind: 'same-file-append',
    lastOffset: 1000,
    lastSize: 1000,
    lastMtime: 1706000000000,
    boundaryFold: false,
  }));
  // Default: a cache entry is present, so file+delta sessions take the body path (the lane is
  // exercised by dedicated tests that make this report `present: false`).
  const refreshIfPresent = jest.fn(async (...args: unknown[]) => ({
    present: true,
    preParse: { sourceVersion: 1000, messageCount: 0, chunkCount: 0 },
    result: await getOrParseWithMeta(...args),
  }));

  const mockCacheService = {
    getOrParse,
    getOrParseWithMeta,
    refreshIfPresent,
    getEntry: jest.fn().mockReturnValue({}),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

    it('module-unit: exposes the complete last parsed metrics snapshot', async () => {
      const session = makeSession({ metrics: makeMetrics({ totalContextTokens: 321 }) });
      mockCacheService.getOrParse.mockResolvedValue(session);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      expect(service.getLastKnownSummaryMetrics(SESSION_ID)).toBe(session.metrics);
      expect(service.getLastKnownSummaryMetrics('missing')).toBeNull();
    });

    it('should skip if watcher already exists for session', async () => {
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockedFsWatch.mockClear();

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      expect(service.activeWatcherCount).toBe(1);
      expect(mockedFsWatch).not.toHaveBeenCalled();
    });

    it('should keep a poll-only watcher while a file transcript is not created yet', async () => {
      mockedFsPromisesStat.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      expect(service.activeWatcherCount).toBe(1);
      expect(mockedFsWatch).not.toHaveBeenCalled();
      expect(service.getLastKnownMessageCount(SESSION_ID)).toBe(0);
    });

    it('activates and publishes a canonical refetch when the pending file materializes', async () => {
      mockedFsPromisesStat.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      mockedFsPromisesStat.mockResolvedValue(makeStat(1000));
      const session = makeSession({ metrics: makeMetrics({ messageCount: 1 }) });
      mockCacheService.getOrParseWithMeta.mockResolvedValue({
        session,
        sourceVersion: 1000,
        cacheHit: false,
        sourceChangeKind: 'unknown-full-parse',
        lastOffset: 1000,
        lastSize: 1000,
        lastMtime: 1706000000000,
        boundaryFold: false,
      });

      await jest.advanceTimersByTimeAsync(3000);
      expect(mockedFsWatch).toHaveBeenCalledWith(FILE_PATH, expect.any(Function));

      await jest.advanceTimersByTimeAsync(150);

      expect(mockCacheService.getOrParseWithMeta).toHaveBeenCalledWith(
        SESSION_ID,
        FILE_PATH,
        expect.anything(),
      );
      expect(mockEvents.publish).toHaveBeenCalledWith('session.transcript.updated', {
        kind: 'full-refetch-required',
        sessionId: SESSION_ID,
        transcriptPath: FILE_PATH,
        sourceChangeKind: 'unknown-full-parse',
      });
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
    // Module-unit fake clocks and deferred cache reads expose scheduler interleavings.
    it('module-unit: continued events cannot postpone the first 100ms refresh', async () => {
      const watcher = createMockFsWatcher();
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockCacheService.getOrParse.mockClear();
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));
      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(90);
      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(10);
      expect(mockCacheService.getOrParse).toHaveBeenCalledTimes(1);
    });

    it('module-unit: events and polls during an active refresh coalesce into one later pass', async () => {
      const watcher = createMockFsWatcher();
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockCacheService.getOrParse.mockClear();
      const parse = deferred<UnifiedSession>();
      mockCacheService.getOrParse.mockReturnValueOnce(parse.promise);
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));
      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(100);
      for (let i = 0; i < 10; i += 1) watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(3000);
      expect(mockCacheService.getOrParse).toHaveBeenCalledTimes(1);
      parse.resolve(makeSession());
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(1999);
      expect(mockCacheService.getOrParse).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockCacheService.getOrParse).toHaveBeenCalledTimes(2);
    });

    it('should debounce rapid file changes (100ms)', async () => {
      const session = makeSession({ metrics: makeMetrics({ messageCount: 5 }) });
      mockCacheService.getOrParse.mockResolvedValue(session);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockCacheService.getOrParse.mockClear();

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

  describe('bounded file refresh scheduling', () => {
    // Module-unit fake time measures the actual coordinator, including awaited work.
    it('module-unit: sustained 150ms appends stay serialized and deliver the final snapshot', async () => {
      const watcher = createMockFsWatcher();
      mockCacheService.getOrParse.mockResolvedValue(
        makeSession({ metrics: makeMetrics({ messageCount: 0 }) }),
      );
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      let count = 0;
      let active = 0;
      let maxActive = 0;
      mockedFsPromisesStat.mockImplementation(async () => makeStat(1000 + count * 100));
      mockCacheService.getOrParseWithMeta.mockClear().mockImplementation(() => {
        const snapshotCount = count;
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise((resolve) =>
          setTimeout(() => {
            active -= 1;
            resolve(
              makeParseResult({
                sourceVersion: snapshotCount,
                session: makeSession({ metrics: makeMetrics({ messageCount: snapshotCount }) }),
              }),
            );
          }, 50),
        );
      });
      for (count = 1; count <= 30; count += 1) {
        watcher.triggerChange('change');
        await jest.advanceTimersByTimeAsync(150);
        expect(jest.getTimerCount()).toBeLessThanOrEqual(2);
      }
      count = 30;
      await jest.advanceTimersByTimeAsync(2300);
      expect(maxActive).toBe(1);
      expect(active).toBe(0);
      expect(mockCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(4);
      expect(service.getLastKnownMessageCount(SESSION_ID)).toBe(30);
      expect(mockEvents.publish).toHaveBeenLastCalledWith(
        'session.transcript.updated',
        expect.objectContaining({
          metrics: expect.objectContaining({ messageCount: 30 }),
        }),
      );
    });

    it.each([49, 50, 51])(
      'module-unit: paces a %i ms handler from completion',
      async (duration) => {
        const watcher = createMockFsWatcher();
        await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
        const parse = deferred<GetOrParseResult>();
        mockCacheService.getOrParseWithMeta.mockClear().mockReturnValueOnce(parse.promise);
        watcher.triggerChange('change');
        await jest.advanceTimersByTimeAsync(100);
        for (let i = 0; i < 100; i += 1) watcher.triggerChange('change');
        expect(jest.getTimerCount()).toBe(1);
        await jest.advanceTimersByTimeAsync(duration);
        parse.resolve(makeParseResult());
        await jest.advanceTimersByTimeAsync(0);
        expect(jest.getTimerCount()).toBe(2);
        const delay = duration < 50 ? 100 : 2000;
        await jest.advanceTimersByTimeAsync(delay - 1);
        expect(mockCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(mockCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(2);
        expect(jest.getTimerCount()).toBe(1);
      },
    );

    it('module-unit: polls and cooldown events share the deadline, then a fast cycle clears pacing', async () => {
      const watcher = createMockFsWatcher();
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      const parse = deferred<GetOrParseResult>();
      mockCacheService.getOrParseWithMeta.mockClear().mockReturnValueOnce(parse.promise);
      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(2000);
      parse.resolve(makeParseResult());
      await jest.advanceTimersByTimeAsync(0);
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(900);
      expect(mockCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(2);
      await jest.advanceTimersByTimeAsync(1050);
      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(49);
      expect(mockCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(2);
      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(99);
      expect(mockCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(3);
    });

    it('module-unit: measures the complete handler through publication', async () => {
      const watcher = createMockFsWatcher();
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      const publication = deferred<string>();
      mockEvents.publish.mockReturnValueOnce(publication.promise);
      mockCacheService.getOrParseWithMeta.mockClear().mockResolvedValue(
        makeParseResult({
          sourceChangeKind: 'same-file-rewrite',
          sourceVersion: 2000,
        }),
      );
      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(100);
      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(50);
      publication.resolve('event-id');
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(1999);
      expect(mockCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(2);
    });

    it('module-unit: pending same-size rewrites publish after active parsing completes', async () => {
      const watcher = createMockFsWatcher();
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      const parse = deferred<GetOrParseResult>();
      mockCacheService.getOrParseWithMeta
        .mockClear()
        .mockReturnValueOnce(parse.promise)
        .mockResolvedValue(
          makeParseResult({ sourceVersion: 3000, sourceChangeKind: 'same-file-rewrite' }),
        );
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));
      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(100);
      watcher.triggerChange('change');
      parse.resolve(makeParseResult({ sourceVersion: 2000 }));
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(100);
      expect(mockCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(2);
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.updated',
        expect.objectContaining({
          kind: 'full-refetch-required',
          sourceChangeKind: 'same-file-rewrite',
        }),
      );
    });

    it('module-unit: cooldown changes eventually publish their latest message count', async () => {
      const watcher = createMockFsWatcher();
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      const parse = deferred<GetOrParseResult>();
      mockCacheService.getOrParseWithMeta.mockReturnValueOnce(parse.promise);
      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(150);
      parse.resolve(makeParseResult());
      await jest.advanceTimersByTimeAsync(0);
      mockCacheService.getOrParseWithMeta.mockResolvedValue(
        makeParseResult({
          session: makeSession({ metrics: makeMetrics({ messageCount: 8 }) }),
          sourceVersion: 2000,
        }),
      );
      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(1999);
      expect(mockEvents.publish).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(service.getLastKnownMessageCount(SESSION_ID)).toBe(8);
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.updated',
        expect.objectContaining({
          newMessageCount: 5,
        }),
      );
    });
  });

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
      await service.handleSessionStopped({
        sessionId: SESSION_ID,
        source: 'web-api',
        reason: 'user-requested',
      });

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

  describe('refresh ownership and cleanup', () => {
    // Module-unit deferred boundaries reproduce cleanup/replacement without real watchers.
    it.each(['stop', 'destroy', 'replacement'])(
      'module-unit: %s cancels a cooldown timer and clears pending work',
      async (action) => {
        const watcher = createMockFsWatcher();
        await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
        const state = (
          service as unknown as {
            watchers: Map<
              string,
              {
                pending: boolean;
                debounceTimer: unknown;
              }
            >;
          }
        ).watchers.get(SESSION_ID)!;
        const parse = deferred<GetOrParseResult>();
        mockCacheService.getOrParseWithMeta.mockReturnValueOnce(parse.promise);
        watcher.triggerChange('change');
        await jest.advanceTimersByTimeAsync(150);
        watcher.triggerChange('change');
        parse.resolve(makeParseResult());
        await jest.advanceTimersByTimeAsync(0);
        expect(state.pending).toBe(true);
        expect(state.debounceTimer).not.toBeNull();
        if (action === 'stop') {
          mockCacheService.getOrParse.mockClear();
          await service.stopWatching(SESSION_ID);
          expect(mockCacheService.getOrParse).toHaveBeenCalledTimes(1);
          expect(mockEvents.publish).toHaveBeenCalledWith(
            'session.transcript.ended',
            expect.anything(),
          );
        } else {
          service.onModuleDestroy();
        }
        expect(state.pending).toBe(false);
        expect(state.debounceTimer).toBeNull();
        expect(jest.getTimerCount()).toBe(0);
        let replacement: MockFsWatcher | undefined;
        if (action === 'replacement') {
          replacement = createMockFsWatcher();
          await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
        }
        mockCacheService.getOrParseWithMeta.mockClear();
        watcher.triggerChange('change');
        watcher.triggerError(new Error('late fs error'));
        await jest.advanceTimersByTimeAsync(2200);
        expect(mockCacheService.getOrParseWithMeta).not.toHaveBeenCalled();
        if (replacement) expect(replacement.close).not.toHaveBeenCalled();
      },
    );

    it.each(['stop', 'replacement'])(
      'module-unit: an active parse cannot publish or change state after %s',
      async (action) => {
        const watcher = createMockFsWatcher();
        await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
        const parse = deferred<GetOrParseResult>();
        mockCacheService.getOrParseWithMeta.mockReturnValueOnce(parse.promise);
        watcher.triggerChange('change');
        await jest.advanceTimersByTimeAsync(100);
        watcher.triggerChange('change');
        await service.stopWatching(SESSION_ID);
        if (action === 'replacement') {
          createMockFsWatcher();
          mockCacheService.getOrParse.mockResolvedValue(
            makeSession({ metrics: makeMetrics({ messageCount: 20 }) }),
          );
          await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
        }
        mockEvents.publish.mockClear();
        parse.resolve(
          makeParseResult({ session: makeSession({ metrics: makeMetrics({ messageCount: 99 }) }) }),
        );
        await jest.advanceTimersByTimeAsync(2500);
        expect(mockEvents.publish).not.toHaveBeenCalled();
        expect(service.getLastKnownMessageCount(SESSION_ID)).toBe(
          action === 'replacement' ? 20 : null,
        );
      },
    );

    it.each(['rotation', 'deletion'])(
      'module-unit: obsolete poll %s cannot reopen or stop a replacement',
      async (change) => {
        createMockFsWatcher();
        await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
        const stat = deferred<fs.Stats>();
        mockedFsPromisesStat.mockReturnValueOnce(stat.promise);
        await jest.advanceTimersByTimeAsync(3000);
        await service.stopWatching(SESSION_ID);
        const replacement = createMockFsWatcher();
        await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
        mockedFsWatch.mockClear();
        mockEvents.publish.mockClear();
        if (change === 'rotation') stat.resolve(makeStat(2000, 9999));
        else stat.reject(Object.assign(new Error('removed'), { code: 'ENOENT' }));
        await jest.advanceTimersByTimeAsync(200);
        expect(service.activeWatcherCount).toBe(1);
        expect(replacement.close).not.toHaveBeenCalled();
        expect(mockedFsWatch).not.toHaveBeenCalled();
        expect(mockEvents.publish).not.toHaveBeenCalled();
      },
    );

    it.each(['stat', 'seed'])(
      'module-unit: a stopped startup cannot regain ownership after its %s completes',
      async (stage) => {
        const stat = deferred<fs.Stats>();
        const seed = deferred<GetOrParseResult>();
        if (stage === 'stat') mockedFsPromisesStat.mockReturnValueOnce(stat.promise);
        else mockCacheService.getOrParseWithMeta.mockReturnValueOnce(seed.promise);
        const starting = service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
        await jest.advanceTimersByTimeAsync(0);
        await service.stopWatching(SESSION_ID);
        createMockFsWatcher();
        await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
        mockedFsWatch.mockClear();
        if (stage === 'stat') stat.resolve(makeStat(2000, 9999));
        else
          seed.resolve(
            makeParseResult({
              session: makeSession({ metrics: makeMetrics({ messageCount: 99 }) }),
            }),
          );
        await starting;
        expect(service.getLastKnownMessageCount(SESSION_ID)).toBe(3);
        expect(jest.getTimerCount()).toBe(1);
        expect(mockedFsWatch).not.toHaveBeenCalled();
      },
    );

    it('module-unit: a stale final metrics read cannot end a replacement watcher', async () => {
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      const final = deferred<UnifiedSession>();
      mockCacheService.getOrParse.mockReturnValueOnce(final.promise);
      const stopping = service.stopWatching(SESSION_ID);
      createMockFsWatcher();
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      final.resolve(makeSession());
      await stopping;
      expect(mockEvents.publish).not.toHaveBeenCalled();
      expect(service.activeWatcherCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // File change detection → publish event
  // -------------------------------------------------------------------------

  describe('file change detection', () => {
    it.each([1000, 2000])(
      'module-unit: handles a file cache hit at revision %i without replaying a fold',
      async (sourceVersion) => {
        const watcher = createMockFsWatcher();
        await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
        // Ignore the lane-seed presence check during startWatching; the assertion below is that
        // the CHANGE handler resolves the fold from the parse result, never from getEntry.
        mockCacheService.getEntry.mockClear();
        mockCacheService.getEntry.mockReturnValue({ boundaryFold: true } as never);
        mockCacheService.getOrParseWithMeta.mockResolvedValue(
          makeParseResult({
            sourceVersion,
            sourceChangeKind: 'cache-hit',
            cacheHit: true,
            boundaryFold: false,
          }),
        );
        watcher.triggerChange('change');
        await jest.advanceTimersByTimeAsync(100);
        if (sourceVersion === 1000) {
          expect(mockEvents.publish).not.toHaveBeenCalled();
        } else {
          expect(mockEvents.publish).toHaveBeenCalledWith('session.transcript.updated', {
            kind: 'full-refetch-required',
            sessionId: SESSION_ID,
            transcriptPath: FILE_PATH,
            sourceChangeKind: 'cache-hit',
          });
        }
        expect(mockCacheService.getEntry).not.toHaveBeenCalled();
      },
    );
    it('publishes only a cursor-free refetch action when the file generation is replaced', async () => {
      const oldSession = makeSession({ metrics: makeMetrics({ messageCount: 2 }) });
      const replacement = makeSession({ metrics: makeMetrics({ messageCount: 3 }) });
      mockCacheService.getOrParse.mockResolvedValue(oldSession);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      (mockCacheService.getOrParseWithMeta as jest.Mock).mockResolvedValue({
        session: replacement,
        sourceVersion: 2000,
        cacheHit: false,
        sourceChangeKind: 'file-replacement',
        lastOffset: 1500,
        lastSize: 1500,
        lastMtime: 1706000001000,
      });
      mockedFsPromisesStat.mockResolvedValue(makeStat(1500, 99999));

      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(200);

      const call = mockEvents.publish.mock.calls.find(
        ([eventName]) => eventName === 'session.transcript.updated',
      );
      expect(call?.[1]).toEqual({
        kind: 'full-refetch-required',
        sessionId: SESSION_ID,
        transcriptPath: FILE_PATH,
        sourceChangeKind: 'file-replacement',
      });
      expect(call?.[1]).not.toHaveProperty('cursor');
      expect(call?.[1]).not.toHaveProperty('deltaChunks');
      expect(call?.[1]).not.toHaveProperty('deltaMessages');
    });

    it('should publish transcript.updated when new messages are found', async () => {
      const session = makeSession({
        metrics: makeMetrics({ messageCount: 5, totalTokens: 500, costUsd: 0.05 }),
      });
      // Seed returns empty session; file-change returns session with 5 messages
      mockCacheService.getOrParse
        .mockResolvedValueOnce(makeSession({ metrics: makeMetrics({ messageCount: 0 }) }))
        .mockResolvedValue(session);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // File grew
      mockedFsPromisesStat.mockResolvedValue(makeStat(1500));

      // Trigger stat-poll → detects size change → schedules debounce
      await jest.advanceTimersByTimeAsync(3000);
      // Wait for debounce to fire + async handler
      await jest.advanceTimersByTimeAsync(200);

      expect(mockEvents.publish).toHaveBeenCalledWith('session.transcript.updated', {
        kind: 'delta',
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
        cursor: expect.any(String),
        prevCursor: expect.any(String),
        replaceFromChunkIndex: 0,
        newChunkIds: expect.any(Array),
        totalChunkCount: expect.any(Number),
        deltaChunks: expect.any(Array),
        deltaMessages: expect.any(Array),
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

    it('M1: emits a full refresh (no negative delta, replaceFromChunkIndex 0) when messageCount deflates', async () => {
      // Seed a stale, inflated count of 8 (pre-fold cached session), then the re-parse
      // returns the folded, lower count of 6 even though the file grew.
      mockCacheService.getOrParse
        .mockResolvedValueOnce(makeSession({ metrics: makeMetrics({ messageCount: 8 }) }))
        .mockResolvedValue(
          makeSession({ metrics: makeMetrics({ messageCount: 6, totalTokens: 600 }) }),
        );

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // File grew (new content) but the parser folds away phantom tool_result entries.
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));

      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(200);

      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.updated',
        expect.objectContaining({
          sessionId: SESSION_ID,
          // Clamped to ≥0 — never a negative delta on the wire.
          newMessageCount: 0,
          // Full refresh replaces the window from the start.
          replaceFromChunkIndex: 0,
          metrics: expect.objectContaining({ messageCount: 6 }),
        }),
      );

      // Sanity: the published newMessageCount is never negative.
      const call = mockEvents.publish.mock.calls.find(
        ([eventName]) => eventName === 'session.transcript.updated',
      );
      expect(call).toBeDefined();
      expect((call![1] as { newMessageCount: number }).newMessageCount).toBeGreaterThanOrEqual(0);
    });

    it('publishes a zero-count in-place tail replacement on a cache-boundary fold (no new messages)', async () => {
      // Seed count 5; the boundary fold appends a tool_result onto the cached tail →
      // count stays 5 (no new message) but the tail chunk changed.
      mockCacheService.getOrParse
        .mockResolvedValueOnce(makeSession({ metrics: makeMetrics({ messageCount: 5 }) }))
        .mockResolvedValue(makeSession({ metrics: makeMetrics({ messageCount: 5 }) }));
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockCacheService.getOrParseWithMeta.mockResolvedValue(
        makeParseResult({
          session: makeSession({ metrics: makeMetrics({ messageCount: 5 }) }),
          boundaryFold: true,
        }),
      );
      // A self-evicted entry cannot supply the fold metadata.
      mockCacheService.getEntry.mockReturnValue(undefined);

      // File grew (the tool_result was appended) but messageCount did not increase.
      mockedFsPromisesStat.mockResolvedValue(makeStat(1800));

      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(200);

      const call = mockEvents.publish.mock.calls.find(
        ([eventName]) => eventName === 'session.transcript.updated',
      );
      expect(call).toBeDefined();
      const payload = call![1] as {
        newMessageCount: number;
        replaceFromChunkIndex: number;
        deltaChunks: unknown[];
      };
      // Zero-count in-place tail replacement — NOT a positive unread delta.
      expect(payload.newMessageCount).toBe(0);
      expect(payload.replaceFromChunkIndex).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(payload.deltaChunks)).toBe(true);
    });

    it('does NOT publish when messageCount is unchanged and no boundary fold occurred', async () => {
      // Appended content produced no new messages and no fold (e.g. filtered/noise lines).
      mockCacheService.getOrParse
        .mockResolvedValueOnce(makeSession({ metrics: makeMetrics({ messageCount: 5 }) }))
        .mockResolvedValue(makeSession({ metrics: makeMetrics({ messageCount: 5 }) }));
      (mockCacheService.getEntry as jest.Mock).mockReturnValue({ boundaryFold: false });

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      mockedFsPromisesStat.mockResolvedValue(makeStat(1800));

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

      // Stat returns different inode but same size.
      mockedFsPromisesStat.mockResolvedValue(makeStat(1000, 99999));

      await jest.advanceTimersByTimeAsync(3000);

      // Old watcher should have been closed and a new one created
      expect(mockWatcher.close).toHaveBeenCalled();
      expect(service.activeWatcherCount).toBe(1);
    });

    it('treats a same-size inode rotation as a cursor-free canonical refetch', async () => {
      const session = makeSession({ metrics: makeMetrics({ messageCount: 5 }) });
      (mockCacheService.getOrParseWithMeta as jest.Mock)
        .mockResolvedValueOnce({
          session,
          sourceVersion: 111,
          sourceChangeKind: 'unknown-full-parse',
        })
        .mockResolvedValueOnce({
          session,
          sourceVersion: 222,
          sourceChangeKind: 'file-replacement',
        });
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockCacheService.getOrParseWithMeta.mockClear();

      mockedFsPromisesStat.mockResolvedValue(makeStat(1000, 99999));
      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(200);

      expect(mockCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(1);
      expect(mockEvents.publish).toHaveBeenCalledWith('session.transcript.updated', {
        kind: 'full-refetch-required',
        sessionId: SESSION_ID,
        transcriptPath: FILE_PATH,
        sourceChangeKind: 'file-replacement',
      });
      const update = mockEvents.publish.mock.calls.find(
        ([eventName]) => eventName === 'session.transcript.updated',
      )?.[1];
      expect(update).not.toHaveProperty('cursor');
      expect(update).not.toHaveProperty('prevCursor');
    });

    it('should not schedule debounce when size is unchanged in stat-poll', async () => {
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockCacheService.getOrParse.mockClear();

      // Stat returns same size and same inode
      mockedFsPromisesStat.mockResolvedValue(makeStat(1000));

      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(200);

      // No parse should have been triggered (beyond seed)
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

    it('rechecks freshness when a pending change returns to the original byte size', async () => {
      const session = makeSession({ metrics: makeMetrics({ messageCount: 5 }) });
      mockCacheService.getOrParse.mockResolvedValue(session);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockCacheService.getOrParse.mockClear();

      // First stat-poll: file grew → schedules debounce
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));
      await jest.advanceTimersByTimeAsync(3000);

      // By the time debounce fires, stat returns original size
      mockedFsPromisesStat.mockResolvedValue(makeStat(1000));
      await jest.advanceTimersByTimeAsync(200);

      expect(mockCacheService.getOrParse).toHaveBeenCalledTimes(1);
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
          // Seeded from initial parse during startWatching
          finalMetrics: expect.objectContaining({ messageCount: expect.any(Number) }),
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
      mockCacheService.getOrParse.mockClear();

      // Trigger an unrecognized event type
      mockWatcher.triggerChange('access');

      await jest.advanceTimersByTimeAsync(200);

      // No parse triggered (beyond seed)
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
  // Fixed coalescing deadline
  // -------------------------------------------------------------------------

  describe('fixed coalescing deadline', () => {
    it('shares the scheduled debounce timer when a new change arrives', async () => {
      const mockWatcher = createMockFsWatcher();
      const session = makeSession({ metrics: makeMetrics({ messageCount: 5 }) });
      mockCacheService.getOrParse.mockResolvedValue(session);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockCacheService.getOrParse.mockClear();

      // File changed
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));

      // First change event → schedules debounce
      mockWatcher.triggerChange('change');

      // The second change shares the first event's deadline.
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
      mockCacheService.getOrParse.mockClear();

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
    it('ignores queued filesystem callbacks when watcher ownership is removed', async () => {
      const mockWatcher = createMockFsWatcher();

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockCacheService.getOrParse.mockClear();

      // Stop watching (removes state from map)
      const session = makeSession({ metrics: makeMetrics({ messageCount: 0 }) });
      mockCacheService.getOrParse.mockResolvedValue(session);
      await service.stopWatching(SESSION_ID, 'session.stopped');

      expect(service.activeWatcherCount).toBe(0);

      // A queued callback from the closed handle no longer owns this watcher.
      mockWatcher.triggerChange('change');

      // Advance past debounce — nothing should happen
      await jest.advanceTimersByTimeAsync(200);

      // getOrParse should only have been called once (during stopWatching's final parse)
      expect(mockCacheService.getOrParse).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // R2: Watcher state seeding (no first-update flood)
  // -------------------------------------------------------------------------

  describe('watcher state seeding', () => {
    it('should seed lastMessageCount from current session during startWatching', async () => {
      // Seed with 3 messages already in the transcript
      const existingSession = makeSession({ metrics: makeMetrics({ messageCount: 3 }) });
      mockCacheService.getOrParse.mockResolvedValue(existingSession);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockCacheService.getOrParse.mockClear();

      // File grows — session now has 4 messages
      const grownSession = makeSession({ metrics: makeMetrics({ messageCount: 4 }) });
      mockCacheService.getOrParse.mockResolvedValue(grownSession);

      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));
      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(200);

      // Should publish with newMessageCount=1 (4-3), NOT newMessageCount=4 (4-0)
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.updated',
        expect.objectContaining({
          newMessageCount: 1,
        }),
      );
    });

    it('should gracefully handle seed parse failure and start from zero', async () => {
      mockCacheService.getOrParse.mockRejectedValueOnce(new Error('Parse failed'));

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      expect(service.activeWatcherCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // newChunkIds and totalChunkCount in published event (4c.1)
  // -------------------------------------------------------------------------

  describe('newChunkIds and totalChunkCount', () => {
    it('should include newChunkIds and totalChunkCount in transcript.updated event', async () => {
      const aiMessage = {
        id: 'ai-msg',
        parentId: null,
        role: 'assistant' as const,
        timestamp: new Date('2026-01-01T10:00:05.000Z'),
        content: [{ type: 'text', text: 'response' }],
        toolCalls: [],
        toolResults: [],
        isMeta: false,
        isSidechain: false,
        usage: { input: 100, output: 200, cacheRead: 0, cacheCreation: 0 },
      };

      const sessionWithAI = makeSession({
        messages: [aiMessage] as never[],
        metrics: makeMetrics({ messageCount: 1 }),
      });

      mockCacheService.getOrParse
        .mockResolvedValueOnce(makeSession({ metrics: makeMetrics({ messageCount: 0 }) }))
        .mockResolvedValue(sessionWithAI);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockCacheService.getOrParse.mockClear();
      mockCacheService.getOrParse.mockResolvedValue(sessionWithAI);

      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));
      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(200);

      const publishCall = mockEvents.publish.mock.calls.find(
        ([name]) => name === 'session.transcript.updated',
      );
      expect(publishCall).toBeDefined();

      const payload = publishCall![1] as {
        newChunkIds: string[];
        totalChunkCount: number;
        replaceFromChunkIndex: number;
      };

      expect(payload.newChunkIds).toEqual(expect.any(Array));
      expect(payload.newChunkIds.length).toBeGreaterThan(0);
      expect(payload.totalChunkCount).toBe(1);
      expect(payload.newChunkIds).toEqual(['chunk-0']);
    });

    it('should compute newChunkIds from replaceFromChunkIndex to end of chunks', async () => {
      const userMsg = {
        id: 'user-msg',
        parentId: null,
        role: 'user' as const,
        timestamp: new Date('2026-01-01T10:00:00.000Z'),
        content: [{ type: 'text', text: 'hello' }],
        toolCalls: [],
        toolResults: [],
        isMeta: false,
        isSidechain: false,
      };
      const aiMsg = {
        id: 'ai-msg',
        parentId: null,
        role: 'assistant' as const,
        timestamp: new Date('2026-01-01T10:00:05.000Z'),
        content: [{ type: 'text', text: 'hi' }],
        toolCalls: [],
        toolResults: [],
        isMeta: false,
        isSidechain: false,
        usage: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
      };
      const aiMsg2 = {
        id: 'ai-msg-2',
        parentId: null,
        role: 'assistant' as const,
        timestamp: new Date('2026-01-01T10:00:10.000Z'),
        content: [{ type: 'text', text: 'more' }],
        toolCalls: [],
        toolResults: [],
        isMeta: false,
        isSidechain: false,
        usage: { input: 200, output: 100, cacheRead: 0, cacheCreation: 0 },
      };

      // Seed with 2 messages (user + ai → 2 chunks: user, ai)
      const seedSession = makeSession({
        messages: [userMsg, aiMsg] as never[],
        metrics: makeMetrics({ messageCount: 2 }),
      });
      mockCacheService.getOrParse.mockResolvedValueOnce(seedSession);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockCacheService.getOrParse.mockClear();

      // File grows: 3 messages now (user + ai + ai → 2 chunks: user, ai(both))
      const grownSession = makeSession({
        messages: [userMsg, aiMsg, aiMsg2] as never[],
        metrics: makeMetrics({ messageCount: 3 }),
      });
      mockCacheService.getOrParse.mockResolvedValue(grownSession);

      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));
      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(200);

      const publishCall = mockEvents.publish.mock.calls.find(
        ([name]) => name === 'session.transcript.updated',
      );
      expect(publishCall).toBeDefined();

      const payload = publishCall![1] as {
        newChunkIds: string[];
        totalChunkCount: number;
        replaceFromChunkIndex: number;
      };

      // replaceFromChunkIndex = max(0, lastChunkCount - 1) = max(0, 2 - 1) = 1
      expect(payload.replaceFromChunkIndex).toBe(1);
      // newChunkIds = chunks.slice(1) = ['chunk-1'] (the AI chunk that was extended)
      expect(payload.newChunkIds).toEqual(['chunk-1']);
      expect(payload.totalChunkCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Wire serialization: deltaChunks must not contain deprecated `turns`
  // -------------------------------------------------------------------------

  describe('deltaChunks wire shape', () => {
    it('should not include turns field in deltaChunks (T1.3 contract)', async () => {
      const aiMessage = {
        id: 'ai-msg',
        parentId: null,
        role: 'assistant' as const,
        timestamp: new Date('2026-01-01T10:00:05.000Z'),
        content: [{ type: 'text', text: 'response' }],
        toolCalls: [],
        toolResults: [],
        isMeta: false,
        isSidechain: false,
        usage: { input: 100, output: 200, cacheRead: 0, cacheCreation: 0 },
      };

      const sessionWithAI = makeSession({
        messages: [aiMessage] as never[],
        metrics: makeMetrics({ messageCount: 1 }),
      });

      mockCacheService.getOrParse
        .mockResolvedValueOnce(makeSession({ metrics: makeMetrics({ messageCount: 0 }) }))
        .mockResolvedValue(sessionWithAI);

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockCacheService.getOrParse.mockClear();
      mockCacheService.getOrParse.mockResolvedValue(sessionWithAI);

      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));
      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(200);

      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.updated',
        expect.objectContaining({ sessionId: SESSION_ID }),
      );

      const publishCall = mockEvents.publish.mock.calls.find(
        ([name]) => name === 'session.transcript.updated',
      );
      const payload = publishCall![1] as { deltaChunks: Record<string, unknown>[] };

      for (const chunk of payload.deltaChunks) {
        expect(chunk).not.toHaveProperty('turns');
      }
    });
  });

  // -------------------------------------------------------------------------
  // getLastKnownMessageCount: O(1) cached read (feeds chat.listAgents enrichment)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // DB-backed sources (OpenCode): freshness-poll, -wal hint, in-place updates
  // -------------------------------------------------------------------------

  describe('DB-backed sources', () => {
    const DB_PATH = '/home/user/.local/share/opencode/opencode.db';
    const SES = 'ses_abc';

    function makeDbAdapter(getFreshnessToken: jest.Mock): SessionReaderAdapter {
      return {
        providerName: 'opencode',
        incrementalMode: 'snapshot',
        sourceKind: 'db',
        allowedRoots: [],
        discoverSessionFile: jest.fn(),
        parseSessionFile: jest.fn(),
        parseIncremental: jest.fn(),
        getWatchPaths: jest.fn(),
        calculateCost: jest.fn(),
        parseFullSession: jest.fn(),
        getFreshnessToken,
      } as unknown as SessionReaderAdapter;
    }

    function dbSession(messageCount: number): UnifiedSession {
      const messages = [
        {
          id: 'u1',
          parentId: null,
          role: 'user' as const,
          timestamp: new Date('2026-01-01T10:00:00.000Z'),
          content: [{ type: 'text', text: 'hi' }],
          toolCalls: [],
          toolResults: [],
          isMeta: false,
          isSidechain: false,
        },
        {
          id: 'a1',
          parentId: null,
          role: 'assistant' as const,
          timestamp: new Date('2026-01-01T10:00:05.000Z'),
          content: [{ type: 'text', text: 'response' }],
          toolCalls: [],
          toolResults: [],
          isMeta: false,
          isSidechain: false,
          usage: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
        },
      ].slice(0, messageCount);
      return makeSession({
        providerName: 'opencode',
        filePath: DB_PATH,
        messages: messages as never[],
        metrics: makeMetrics({ messageCount }),
      });
    }

    // Module-unit clocks exercise the DB branch without requiring a SQLite/WAL fixture.
    it('module-unit: keeps 100ms WAL coalescing and 3s polling after a costly DB refresh', async () => {
      const watcher = createMockFsWatcher();
      let token = 1;
      const freshness = jest.fn(async () => ({ maxUpdated: token }));
      mockAdapterFactory.getAdapter.mockReturnValue(makeDbAdapter(freshness));
      await service.startWatching(SES, DB_PATH, 'opencode', SES);
      const parse = deferred<GetOrParseResult>();
      mockCacheService.getOrParseWithMeta.mockClear().mockReturnValueOnce(parse.promise);
      token = 2;
      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(99);
      expect(mockCacheService.getOrParseWithMeta).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await jest.advanceTimersByTimeAsync(50);
      watcher.triggerChange('change');
      token = 3;
      parse.resolve(makeParseResult({ sourceVersion: 2 }));
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(99);
      expect(mockCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(2);
      freshness.mockClear();
      token = 4;
      await jest.advanceTimersByTimeAsync(2749);
      expect(freshness).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(freshness).toHaveBeenCalledTimes(1);
      expect(mockCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(100);
      expect(mockCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(3);
    });

    it.each(['token', 'parse'])(
      'module-unit: ignores obsolete DB %s results after replacement',
      async (stage) => {
        const watcher = createMockFsWatcher();
        const freshness = jest.fn().mockResolvedValue({ maxUpdated: 1 });
        mockAdapterFactory.getAdapter.mockReturnValue(makeDbAdapter(freshness));
        await service.startWatching(SES, DB_PATH, 'opencode', SES);
        const token = deferred<unknown>();
        const parse = deferred<GetOrParseResult>();
        if (stage === 'token') freshness.mockReturnValueOnce(token.promise);
        else {
          freshness.mockResolvedValue({ maxUpdated: 2 });
          mockCacheService.getOrParseWithMeta.mockReturnValueOnce(parse.promise);
        }
        watcher.triggerChange('change');
        await jest.advanceTimersByTimeAsync(100);
        await service.stopWatching(SES);
        createMockFsWatcher();
        await service.startWatching(SES, DB_PATH, 'opencode', SES);
        mockCacheService.getOrParseWithMeta.mockClear();
        mockEvents.publish.mockClear();
        if (stage === 'token') token.resolve({ maxUpdated: 3 });
        else parse.resolve(makeParseResult({ session: dbSession(20) }));
        await jest.advanceTimersByTimeAsync(200);
        expect(mockCacheService.getOrParseWithMeta).not.toHaveBeenCalled();
        expect(mockEvents.publish).not.toHaveBeenCalled();
        expect(service.getLastKnownMessageCount(SES)).toBe(3);
      },
    );

    it('skips the watcher when a DB source has no providerSessionId', async () => {
      const adapter = makeDbAdapter(jest.fn().mockResolvedValue({ count: 1, maxUpdated: 1 }));
      mockAdapterFactory.getAdapter.mockReturnValue(adapter);

      await service.startWatching(SES, DB_PATH, 'opencode'); // no providerSessionId

      expect(service.activeWatcherCount).toBe(0);
    });

    it('watches the -wal sidecar (hint) and seeds via getFreshnessToken', async () => {
      const getFreshnessToken = jest.fn().mockResolvedValue({ count: 5, maxUpdated: 100 });
      const adapter = makeDbAdapter(getFreshnessToken);
      mockAdapterFactory.getAdapter.mockReturnValue(adapter);
      (mockCacheService.getOrParseWithMeta as jest.Mock).mockResolvedValue({
        session: dbSession(2),
        sourceVersion: 5,
        cacheHit: false,
        lastOffset: 5,
        lastSize: 5,
        lastMtime: 0,
      });

      await service.startWatching(SES, DB_PATH, 'opencode', 'ses_abc');

      expect(service.activeWatcherCount).toBe(1);
      expect(mockedFsWatch).toHaveBeenCalledWith(`${DB_PATH}-wal`, expect.any(Function));
      expect(getFreshnessToken).toHaveBeenCalledWith(
        expect.objectContaining({ providerSessionId: 'ses_abc', kind: 'db' }),
      );
    });

    it('stays active when fs.watch on -wal throws ENOENT (poll is authoritative)', async () => {
      mockedFsWatch.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      const adapter = makeDbAdapter(jest.fn().mockResolvedValue({ count: 1, maxUpdated: 1 }));
      mockAdapterFactory.getAdapter.mockReturnValue(adapter);
      (mockCacheService.getOrParseWithMeta as jest.Mock).mockResolvedValue({
        session: dbSession(2),
        sourceVersion: 1,
        cacheHit: false,
        lastOffset: 1,
        lastSize: 1,
        lastMtime: 0,
      });

      await service.startWatching(SES, DB_PATH, 'opencode', 'ses_abc');

      expect(service.activeWatcherCount).toBe(1);
    });

    it('emits transcript.updated on in-place revision change (newMessageCount=0)', async () => {
      // Seed token, then poll token, then confirm token (handler) — all differ from seed.
      const getFreshnessToken = jest
        .fn()
        .mockResolvedValueOnce({ count: 5, maxUpdated: 100 }) // seed
        .mockResolvedValue({ count: 7, maxUpdated: 200 }); // poll + handler (parts added, same msgs)
      const adapter = makeDbAdapter(getFreshnessToken);
      mockAdapterFactory.getAdapter.mockReturnValue(adapter);

      (mockCacheService.getOrParseWithMeta as jest.Mock)
        .mockResolvedValueOnce({
          session: dbSession(2),
          sourceVersion: 5,
          cacheHit: false,
          lastOffset: 5,
          lastSize: 5,
          lastMtime: 0,
        })
        .mockResolvedValue({
          session: dbSession(2), // SAME message count — only parts changed in place
          sourceVersion: 7,
          cacheHit: false,
          lastOffset: 7,
          lastSize: 7,
          lastMtime: 0,
        });

      await service.startWatching(SES, DB_PATH, 'opencode', 'ses_abc');

      await jest.advanceTimersByTimeAsync(3000); // poll → token changed → debounce
      await jest.advanceTimersByTimeAsync(200); // debounce → handleDbChanged

      const call = mockEvents.publish.mock.calls.find(
        ([name]) => name === 'session.transcript.updated',
      );
      expect(call).toBeDefined();
      const payload = call![1] as { newMessageCount: number; deltaChunks: unknown[] };
      expect(payload.newMessageCount).toBe(0); // in-place: no new messages
      expect(payload.deltaChunks.length).toBeGreaterThan(0); // last chunk replaced
    });

    it('M1: emits a full refresh (replaceFromChunkIndex 0, no negative delta) when messageCount deflates', async () => {
      // The coalescer shrinks an OpenCode count on the first refresh (e.g. 85→~10).
      // Without the deflation guard the client would receive replaceFromChunkIndex
      // beyond the new (smaller) chunk set — an out-of-range splice anchor.
      const getFreshnessToken = jest
        .fn()
        .mockResolvedValueOnce({ count: 85, maxUpdated: 100 }) // seed (inflated)
        .mockResolvedValue({ count: 90, maxUpdated: 200 }); // poll + handler (changed)
      const adapter = makeDbAdapter(getFreshnessToken);
      mockAdapterFactory.getAdapter.mockReturnValue(adapter);

      (mockCacheService.getOrParseWithMeta as jest.Mock)
        .mockResolvedValueOnce({
          session: dbSession(85), // inflated pre-coalesce count
          sourceVersion: 5,
          cacheHit: false,
          lastOffset: 5,
          lastSize: 5,
          lastMtime: 0,
        })
        .mockResolvedValue({
          session: dbSession(10), // deflated post-coalesce count
          sourceVersion: 7,
          cacheHit: false,
          lastOffset: 7,
          lastSize: 7,
          lastMtime: 0,
        });

      await service.startWatching(SES, DB_PATH, 'opencode', 'ses_abc');

      await jest.advanceTimersByTimeAsync(3000); // poll → token changed → debounce
      await jest.advanceTimersByTimeAsync(200); // debounce → handleDbChanged

      const call = mockEvents.publish.mock.calls.find(
        ([name]) => name === 'session.transcript.updated',
      );
      expect(call).toBeDefined();
      const payload = call![1] as {
        newMessageCount: number;
        replaceFromChunkIndex: number;
        deltaChunks: unknown[];
        deltaMessages: unknown[];
        totalChunkCount: number;
        metrics: { messageCount: number };
      };
      // Full refresh replaces the window from the start — never an out-of-range splice.
      expect(payload.replaceFromChunkIndex).toBe(0);
      // Clamped to ≥0 — never a negative delta on the wire.
      expect(payload.newMessageCount).toBe(0);
      // Full-window replacement: the whole current transcript is published.
      expect(payload.deltaChunks.length).toBeGreaterThan(0);
      expect(payload.deltaMessages.length).toBeGreaterThan(0);
      expect(payload.totalChunkCount).toBe(payload.deltaChunks.length);
      // Cursor/metrics encode the NEW (deflated) count.
      expect(payload.metrics.messageCount).toBe(10);
    });

    it('does NOT emit when the freshness token is unchanged', async () => {
      const getFreshnessToken = jest.fn().mockResolvedValue({ count: 5, maxUpdated: 100 });
      const adapter = makeDbAdapter(getFreshnessToken);
      mockAdapterFactory.getAdapter.mockReturnValue(adapter);
      (mockCacheService.getOrParseWithMeta as jest.Mock).mockResolvedValue({
        session: dbSession(2),
        sourceVersion: 5,
        cacheHit: false,
        lastOffset: 5,
        lastSize: 5,
        lastMtime: 0,
      });

      await service.startWatching(SES, DB_PATH, 'opencode', 'ses_abc');
      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(200);

      expect(mockEvents.publish).not.toHaveBeenCalledWith(
        'session.transcript.updated',
        expect.anything(),
      );
    });
  });

  describe('getLastKnownMessageCount', () => {
    it('returns the seeded message count for a watched session', async () => {
      mockCacheService.getOrParse.mockResolvedValue(
        makeSession({ metrics: makeMetrics({ messageCount: 7 }) }),
      );

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      expect(service.getLastKnownMessageCount(SESSION_ID)).toBe(7);
    });

    it('returns the seeded 0 count (NOT null) for a watched empty transcript', async () => {
      mockCacheService.getOrParse.mockResolvedValue(
        makeSession({ metrics: makeMetrics({ messageCount: 0 }) }),
      );

      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);

      // A genuine 0 must round-trip as 0 (drives latestMessageCount: 0 on the
      // agent item), not be collapsed to null (which would omit the badge).
      expect(service.getLastKnownMessageCount(SESSION_ID)).toBe(0);
    });

    it('returns null when no watcher is active for the session', () => {
      expect(service.getLastKnownMessageCount('never-watched-session')).toBeNull();
    });

    it('tracks the count as the watcher observes new messages', async () => {
      mockCacheService.getOrParse.mockResolvedValue(
        makeSession({ metrics: makeMetrics({ messageCount: 3 }) }),
      );
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      expect(service.getLastKnownMessageCount(SESSION_ID)).toBe(3);

      // File grows → the watcher now sees 6 messages.
      mockCacheService.getOrParse.mockResolvedValue(
        makeSession({ metrics: makeMetrics({ messageCount: 6 }) }),
      );
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));

      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(200);

      expect(service.getLastKnownMessageCount(SESSION_ID)).toBe(6);
    });
  });

  // -------------------------------------------------------------------------
  // Lane cost cooldown
  //
  // A viewed session whose parsed weight exceeds the byte budget self-evicts, so
  // every refresh serves it through the cheap metrics-only lane. That lane pass
  // never trips the >= COSTLY_REFRESH_MS cost cooldown on its own, so the refresh
  // throttle (present before the lane existed) would stop engaging and the reader
  // would pay a full parse on every change. These tests pin the re-arm rule: a
  // publishing lane pass that answered a reader's NEW costly full parse re-arms the
  // 2 s file-refresh cooldown; nothing else does.
  //
  // Service constants: DEBOUNCE_MS = 100, COSTLY_REFRESH_MS = 50,
  // FILE_REFRESH_COOLDOWN_MS = 2000.
  // -------------------------------------------------------------------------
  describe('module-unit: lane pass re-arms the costly-refresh cooldown', () => {
    let adapter: SessionReaderAdapter & { getSummary: jest.Mock };

    function laneSummary(endOffset = 1000) {
      return {
        metrics: makeMetrics(),
        exactFields: [],
        laneSeed: {
          endOffset,
          visibleContextTokens: 100,
          messageCount: 3,
          firstMessageTimestamp: 1706000000000,
          lastMessageTimestamp: 1706000000000,
        },
      };
    }

    beforeEach(() => {
      adapter = mockAdapterFactory.getAdapter(PROVIDER_NAME) as typeof adapter;
      adapter.getSummary = jest.fn().mockResolvedValue(laneSummary());
      // No cache entry: the change handler stays on the metrics-only lane path.
      mockCacheService.getEntry.mockReturnValue(undefined);
    });

    it('holds the next refresh for the cooldown after a publishing pass answers a NEW costly full parse', async () => {
      const watcher = createMockFsWatcher();
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockCacheService.refreshIfPresent.mockClear().mockResolvedValue({
        present: false,
        lastFullParse: { seq: 7, durationMs: 60 },
      });
      mockEvents.publish.mockClear();
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));

      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(100);
      expect(mockCacheService.refreshIfPresent).toHaveBeenCalledTimes(1);
      expect(mockEvents.publish).toHaveBeenCalledTimes(1);

      // The reader paid a new full parse >= 50 ms; the cheap lane pass inherits that cost.
      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(1999);
      expect(mockCacheService.refreshIfPresent).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockCacheService.refreshIfPresent).toHaveBeenCalledTimes(2);
    });

    it('does not re-arm the cooldown for a pass with no NEW full parse since the previous one', async () => {
      const watcher = createMockFsWatcher();
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      // Same {seq} on every pass: only the first pass observes a new full parse.
      mockCacheService.refreshIfPresent.mockClear().mockResolvedValue({
        present: false,
        lastFullParse: { seq: 7, durationMs: 60 },
      });
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));

      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(100); // pass 1: new seq -> costly -> 2 s cooldown
      expect(mockCacheService.refreshIfPresent).toHaveBeenCalledTimes(1);

      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(2000); // pass 2 after the cooldown: same seq -> not costly
      expect(mockCacheService.refreshIfPresent).toHaveBeenCalledTimes(2);

      // Pass 2 armed no cooldown, so the next change is only debounced, not throttled.
      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(99);
      expect(mockCacheService.refreshIfPresent).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockCacheService.refreshIfPresent).toHaveBeenCalledTimes(3);
    });

    it('does not re-arm the cooldown when the reader full parse was below the costly threshold', async () => {
      const watcher = createMockFsWatcher();
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      mockCacheService.refreshIfPresent.mockClear().mockResolvedValue({
        present: false,
        lastFullParse: { seq: 7, durationMs: 20 }, // < COSTLY_REFRESH_MS
      });
      mockEvents.publish.mockClear();
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));

      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(100);
      expect(mockCacheService.refreshIfPresent).toHaveBeenCalledTimes(1);
      expect(mockEvents.publish).toHaveBeenCalledTimes(1);

      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(99);
      expect(mockCacheService.refreshIfPresent).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockCacheService.refreshIfPresent).toHaveBeenCalledTimes(2);
    });

    it('does not re-arm the cooldown when a costly reader parse meets a pass that publishes nothing', async () => {
      const watcher = createMockFsWatcher();
      await service.startWatching(SESSION_ID, FILE_PATH, PROVIDER_NAME);
      // A costly reader parse, but the pass cannot advance or reseed -> it publishes nothing.
      adapter.getSummary.mockResolvedValue(null);
      mockCacheService.refreshIfPresent.mockClear().mockResolvedValue({
        present: false,
        lastFullParse: { seq: 7, durationMs: 60 },
      });
      mockEvents.publish.mockClear();
      mockedFsPromisesStat.mockResolvedValue(makeStat(2000));

      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(100);
      expect(mockCacheService.refreshIfPresent).toHaveBeenCalledTimes(1);
      expect(mockEvents.publish).not.toHaveBeenCalled();

      watcher.triggerChange('change');
      await jest.advanceTimersByTimeAsync(99);
      expect(mockCacheService.refreshIfPresent).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockCacheService.refreshIfPresent).toHaveBeenCalledTimes(2);
    });
  });
});
