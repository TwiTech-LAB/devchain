import * as fsPromises from 'node:fs/promises';
import { SessionCacheService } from './session-cache.service';
import type {
  SessionReaderAdapter,
  IncrementalResult,
} from '../adapters/session-reader-adapter.interface';
import type { UnifiedSession, UnifiedMetrics, UnifiedMessage } from '../dtos/unified-session.types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('node:fs/promises');
const mockedFsStat = fsPromises.stat as jest.MockedFunction<typeof fsPromises.stat>;

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
    phaseBreakdowns: [{ phaseNumber: 1, contribution: 100, peakTokens: 100 }],
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

function makeMessage(
  id: string,
  timestampMs = 1706000000000,
  overrides: Partial<UnifiedMessage> = {},
): UnifiedMessage {
  return {
    id,
    parentId: null,
    role: 'assistant',
    timestamp: new Date(timestampMs),
    content: [{ type: 'text', text: `Message ${id}` }],
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: 'session-1',
    providerName: 'claude',
    filePath: '/tmp/test.jsonl',
    messages: [makeMessage('m1', 1706000000000), makeMessage('m2', 1706000005000)],
    metrics: makeMetrics(),
    isOngoing: false,
    ...overrides,
  };
}

function makeStat(size: number, mtimeMs: number): fsPromises.FileHandle {
  return {
    size,
    mtime: new Date(mtimeMs),
    isFile: () => true,
    isDirectory: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
  } as unknown as fsPromises.FileHandle;
}

function makeAdapter(overrides: Partial<SessionReaderAdapter> = {}): SessionReaderAdapter {
  return {
    providerName: 'claude',
    incrementalMode: 'delta',
    allowedRoots: ['/home/user/.claude/projects/'],
    discoverSessionFile: jest.fn(),
    parseSessionFile: jest.fn(),
    parseIncremental: jest.fn(),
    getWatchPaths: jest.fn(),
    calculateCost: jest.fn(),
    parseFullSession: jest.fn().mockResolvedValue(makeSession()),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionCacheService', () => {
  let service: SessionCacheService;
  let adapter: SessionReaderAdapter;
  let dateSpy: jest.SpyInstance;

  const FILE_PATH = '/tmp/test.jsonl';
  const SESSION_ID = 'session-1';

  beforeEach(() => {
    service = new SessionCacheService();
    adapter = makeAdapter();
    dateSpy = jest.spyOn(Date, 'now').mockReturnValue(1706000000000);

    // Default stat: 1000 bytes, mtime at current time
    mockedFsStat.mockResolvedValue(makeStat(1000, 1706000000000));
  });

  afterEach(() => {
    dateSpy.mockRestore();
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Cache miss (no prior cache)
  // -------------------------------------------------------------------------

  it('should do a full parse on cache miss', async () => {
    const session = makeSession();
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session);

    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    expect(result).toBe(session);
    expect(adapter.parseFullSession).toHaveBeenCalledWith(FILE_PATH);
    expect(adapter.parseIncremental).not.toHaveBeenCalled();
    expect(service.size).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Cache hit (file unchanged, within TTL)
  // -------------------------------------------------------------------------

  it('should return cached session on cache hit (file unchanged, within TTL)', async () => {
    const session = makeSession();
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session);

    // First call: populates cache
    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    // Advance time by 1 minute (within 10-min TTL)
    dateSpy.mockReturnValue(1706000060000);

    // Second call: should hit cache
    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    expect(result).toBe(session);
    expect(adapter.parseFullSession).toHaveBeenCalledTimes(1);
    expect(adapter.parseIncremental).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // TTL expiry
  // -------------------------------------------------------------------------

  it('should do a full reparse when TTL expires', async () => {
    const session1 = makeSession({ id: 'session-v1' });
    const session2 = makeSession({ id: 'session-v2' });
    (adapter.parseFullSession as jest.Mock)
      .mockResolvedValueOnce(session1)
      .mockResolvedValueOnce(session2);

    // First call: populates cache
    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    // Advance time past 10-minute TTL
    dateSpy.mockReturnValue(1706000000000 + 11 * 60 * 1000);

    // Second call: TTL expired → full reparse
    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    expect(result).toBe(session2);
    expect(adapter.parseFullSession).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Incremental parse (file grew)
  // -------------------------------------------------------------------------

  it('should do incremental parse when file grew (append-only)', async () => {
    const existingMessages = [makeMessage('m1', 1706000000000), makeMessage('m2', 1706000005000)];
    const existingMetrics = makeMetrics({ messageCount: 2 });
    const session1 = makeSession({
      messages: existingMessages,
      metrics: existingMetrics,
    });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session1);

    // First call: full parse, file is 1000 bytes
    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    // File grew to 1500 bytes
    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));

    const newMessage = makeMessage('m3', 1706000010000);
    const incrementalMetrics = makeMetrics({
      inputTokens: 50,
      outputTokens: 25,
      cacheReadTokens: 5,
      cacheCreationTokens: 2,
      totalTokens: 82,
      messageCount: 1,
      costUsd: 0.005,
      isOngoing: true,
    });

    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 1,
      entries: [newMessage],
      metrics: incrementalMetrics,
    } satisfies IncrementalResult);

    // Second call: incremental parse
    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    expect(adapter.parseIncremental).toHaveBeenCalledWith(FILE_PATH, {
      byteOffset: 1000, // lastOffset from full parse = file size
      includeToolCalls: true,
    });
    expect(adapter.parseFullSession).toHaveBeenCalledTimes(1); // Not called again
    expect(result.messages).toHaveLength(3);
    expect(result.messages[2].id).toBe('m3');
    expect(result.isOngoing).toBe(true);

    // Verify merged metrics
    expect(result.metrics.inputTokens).toBe(150); // 100 + 50
    expect(result.metrics.outputTokens).toBe(75); // 50 + 25
    expect(result.metrics.costUsd).toBeCloseTo(0.015); // 0.01 + 0.005
    expect(result.metrics.messageCount).toBe(3);
    expect(result.metrics.isOngoing).toBe(true);
  });

  it('should preserve accurate totals across multiple delta incremental updates', async () => {
    const session1 = makeSession({
      metrics: makeMetrics({
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 20,
        cacheCreationTokens: 0,
        totalTokens: 160,
        messageCount: 2,
      }),
      messages: [makeMessage('m1', 1706000000000), makeMessage('m2', 1706000005000)],
    });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session1);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    mockedFsStat.mockResolvedValue(makeStat(1200, 1706000010000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValueOnce({
      hasMore: false,
      nextByteOffset: 1200,
      messageCount: 1,
      entries: [makeMessage('m3', 1706000010000)],
      metrics: makeMetrics({
        inputTokens: 20,
        outputTokens: 10,
        cacheReadTokens: 5,
        cacheCreationTokens: 0,
        totalTokens: 35,
        costUsd: 0.002,
      }),
    } satisfies IncrementalResult);

    const first = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);
    expect(first.metrics.inputTokens).toBe(120);
    expect(first.metrics.outputTokens).toBe(50);
    expect(first.metrics.cacheReadTokens).toBe(25);

    mockedFsStat.mockResolvedValue(makeStat(1400, 1706000020000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValueOnce({
      hasMore: false,
      nextByteOffset: 1400,
      messageCount: 1,
      entries: [makeMessage('m4', 1706000020000)],
      metrics: makeMetrics({
        inputTokens: 30,
        outputTokens: 15,
        cacheReadTokens: 10,
        cacheCreationTokens: 0,
        totalTokens: 55,
        costUsd: 0.003,
      }),
    } satisfies IncrementalResult);

    const second = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);
    expect(second.metrics.inputTokens).toBe(150);
    expect(second.metrics.outputTokens).toBe(65);
    expect(second.metrics.cacheReadTokens).toBe(35);
    expect(second.metrics.totalTokens).toBe(250);
    expect(second.messages).toHaveLength(4);
  });

  it('should replace messages and metrics in snapshot incremental mode', async () => {
    adapter = makeAdapter({
      providerName: 'gemini',
      incrementalMode: 'snapshot',
    });

    const initialSession = makeSession({
      providerName: 'gemini',
      messages: [makeMessage('m1', 1706000000000), makeMessage('m2', 1706000005000)],
      metrics: makeMetrics({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 165,
        costUsd: 0.01,
        messageCount: 2,
        isOngoing: true,
      }),
    });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(initialSession);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 3,
      entries: [
        makeMessage('m1', 1706000000000),
        makeMessage('m2', 1706000005000),
        makeMessage('m3', 1706000010000),
      ],
      metrics: makeMetrics({
        inputTokens: 140,
        outputTokens: 70,
        cacheReadTokens: 12,
        cacheCreationTokens: 6,
        totalTokens: 228,
        costUsd: 0.014,
        messageCount: 3,
        isOngoing: false,
      }),
    } satisfies IncrementalResult);

    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    expect(adapter.parseIncremental).toHaveBeenCalledWith(FILE_PATH, {
      byteOffset: 1000,
      includeToolCalls: true,
    });
    expect(result.messages).toHaveLength(3);
    expect(result.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(result.metrics.inputTokens).toBe(140);
    expect(result.metrics.outputTokens).toBe(70);
    expect(result.metrics.totalTokens).toBe(228);
    expect(result.metrics.costUsd).toBeCloseTo(0.014);
    expect(result.metrics.messageCount).toBe(3);
    expect(result.isOngoing).toBe(false);
  });

  it('should avoid duplicate accumulation across consecutive snapshot incremental updates', async () => {
    adapter = makeAdapter({
      providerName: 'gemini',
      incrementalMode: 'snapshot',
    });

    const initialSession = makeSession({
      providerName: 'gemini',
      messages: [makeMessage('m1', 1706000000000), makeMessage('m2', 1706000005000)],
      metrics: makeMetrics({ messageCount: 2, isOngoing: true }),
    });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(initialSession);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValueOnce({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 3,
      entries: [
        makeMessage('m1', 1706000000000),
        makeMessage('m2', 1706000005000),
        makeMessage('m3', 1706000010000),
      ],
      metrics: makeMetrics({ messageCount: 3, isOngoing: true }),
    } satisfies IncrementalResult);

    const firstIncremental = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);
    expect(firstIncremental.messages).toHaveLength(3);

    mockedFsStat.mockResolvedValue(makeStat(1700, 1706000020000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValueOnce({
      hasMore: false,
      nextByteOffset: 1700,
      messageCount: 4,
      entries: [
        makeMessage('m1', 1706000000000),
        makeMessage('m2', 1706000005000),
        makeMessage('m3', 1706000010000),
        makeMessage('m4', 1706000020000),
      ],
      metrics: makeMetrics({ messageCount: 4, isOngoing: false }),
    } satisfies IncrementalResult);

    const secondIncremental = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    expect((adapter.parseIncremental as jest.Mock).mock.calls[0][1]).toEqual({
      byteOffset: 1000,
      includeToolCalls: true,
    });
    expect((adapter.parseIncremental as jest.Mock).mock.calls[1][1]).toEqual({
      byteOffset: 1500,
      includeToolCalls: true,
    });
    expect(secondIncremental.messages).toHaveLength(4);
    expect(secondIncremental.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(secondIncremental.metrics.messageCount).toBe(4);
  });

  // -------------------------------------------------------------------------
  // Full reparse on truncation (file shrank)
  // -------------------------------------------------------------------------

  it('should do full reparse when file shrank (truncation)', async () => {
    const session1 = makeSession();
    const session2 = makeSession({ id: 'session-v2' });
    (adapter.parseFullSession as jest.Mock)
      .mockResolvedValueOnce(session1)
      .mockResolvedValueOnce(session2);

    // First call: full parse at 1000 bytes
    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    // File shrank to 500 bytes (truncation)
    mockedFsStat.mockResolvedValue(makeStat(500, 1706000010000));

    // Second call: file shrank → full reparse
    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    expect(result).toBe(session2);
    expect(adapter.parseFullSession).toHaveBeenCalledTimes(2);
    expect(adapter.parseIncremental).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // LRU eviction at max capacity
  // -------------------------------------------------------------------------

  it('should evict the oldest entry when cache reaches max capacity', async () => {
    const sessions: UnifiedSession[] = [];

    // Fill cache to max (20 entries)
    for (let i = 0; i < 20; i++) {
      const session = makeSession({ id: `session-${i}` });
      sessions.push(session);
      (adapter.parseFullSession as jest.Mock).mockResolvedValue(session);
      mockedFsStat.mockResolvedValue(makeStat(1000 + i, 1706000000000));
      await service.getOrParse(`session-${i}`, `/tmp/test-${i}.jsonl`, adapter);
    }

    expect(service.size).toBe(20);

    // Add one more — should evict session-0 (oldest)
    const newSession = makeSession({ id: 'session-new' });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(newSession);
    mockedFsStat.mockResolvedValue(makeStat(2000, 1706000000000));
    await service.getOrParse('session-new', '/tmp/test-new.jsonl', adapter);

    expect(service.size).toBe(20);

    // session-0 should have been evicted; fetching it requires a fresh parse
    (adapter.parseFullSession as jest.Mock).mockClear();
    const freshSession = makeSession({ id: 'session-0-fresh' });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(freshSession);
    mockedFsStat.mockResolvedValue(makeStat(1000, 1706000000000));

    const result = await service.getOrParse('session-0', '/tmp/test-0.jsonl', adapter);

    expect(result).toBe(freshSession);
    expect(adapter.parseFullSession).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // LRU touch moves entry to end
  // -------------------------------------------------------------------------

  it('should move accessed entry to end of LRU order on cache hit', async () => {
    // Insert session-a, session-b, session-c
    for (const id of ['a', 'b', 'c']) {
      const session = makeSession({ id: `session-${id}` });
      (adapter.parseFullSession as jest.Mock).mockResolvedValue(session);
      mockedFsStat.mockResolvedValue(makeStat(1000, 1706000000000));
      await service.getOrParse(`session-${id}`, `/tmp/${id}.jsonl`, adapter);
    }

    // Access session-a (moves it to end)
    mockedFsStat.mockResolvedValue(makeStat(1000, 1706000000000));
    await service.getOrParse('session-a', '/tmp/a.jsonl', adapter);

    // Now fill remaining slots (17 more to reach 20)
    for (let i = 0; i < 17; i++) {
      const session = makeSession({ id: `filler-${i}` });
      (adapter.parseFullSession as jest.Mock).mockResolvedValue(session);
      mockedFsStat.mockResolvedValue(makeStat(2000 + i, 1706000000000));
      await service.getOrParse(`filler-${i}`, `/tmp/filler-${i}.jsonl`, adapter);
    }

    expect(service.size).toBe(20);

    // Add one more — should evict session-b (oldest after session-a was touched)
    const newSession = makeSession({ id: 'overflow' });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(newSession);
    mockedFsStat.mockResolvedValue(makeStat(3000, 1706000000000));
    await service.getOrParse('overflow', '/tmp/overflow.jsonl', adapter);

    expect(service.size).toBe(20);

    // session-b should be evicted, session-a should still be cached
    (adapter.parseFullSession as jest.Mock).mockClear();
    mockedFsStat.mockResolvedValue(makeStat(1000, 1706000000000));

    // session-a: should hit cache (not evicted)
    await service.getOrParse('session-a', '/tmp/a.jsonl', adapter);
    expect(adapter.parseFullSession).not.toHaveBeenCalled();

    // session-b: should miss cache (evicted)
    const freshB = makeSession({ id: 'session-b-fresh' });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(freshB);
    const resultB = await service.getOrParse('session-b', '/tmp/b.jsonl', adapter);
    expect(resultB).toBe(freshB);
    expect(adapter.parseFullSession).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // onModuleDestroy clears cache
  // -------------------------------------------------------------------------

  it('should clear cache on module destroy', async () => {
    const session = makeSession();
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);
    expect(service.size).toBe(1);

    service.onModuleDestroy();
    expect(service.size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // invalidate removes specific entry
  // -------------------------------------------------------------------------

  it('should remove specific entry on invalidate', async () => {
    const session = makeSession();
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);
    expect(service.size).toBe(1);

    service.invalidate(SESSION_ID);
    expect(service.size).toBe(0);

    // Next call should trigger full parse
    (adapter.parseFullSession as jest.Mock).mockClear();
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session);
    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);
    expect(adapter.parseFullSession).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // clear removes all entries
  // -------------------------------------------------------------------------

  it('should remove all entries on clear', async () => {
    const session = makeSession();
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session);

    await service.getOrParse('s1', FILE_PATH, adapter);
    mockedFsStat.mockResolvedValue(makeStat(1001, 1706000000000));
    await service.getOrParse('s2', FILE_PATH, adapter);
    expect(service.size).toBe(2);

    service.clear();
    expect(service.size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Metrics merge correctness
  // -------------------------------------------------------------------------

  it('should correctly merge metrics on incremental parse', async () => {
    const existingMetrics = makeMetrics({
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
      totalTokens: 330,
      costUsd: 0.02,
      primaryModel: 'claude-opus-4-6',
      durationMs: 5000,
      messageCount: 2,
      isOngoing: false,
      totalContextConsumption: 200,
      compactionCount: 1,
      phaseBreakdowns: [{ phaseNumber: 1, contribution: 200, peakTokens: 200 }],
    });
    const existingMessages = [makeMessage('m1', 1706000000000), makeMessage('m2', 1706000005000)];
    const session1 = makeSession({ messages: existingMessages, metrics: existingMetrics });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session1);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    // File grew
    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000020000));

    const newMessage = makeMessage('m3', 1706000020000);
    const incrementalMetrics = makeMetrics({
      inputTokens: 80,
      outputTokens: 40,
      cacheReadTokens: 8,
      cacheCreationTokens: 4,
      totalTokens: 132,
      costUsd: 0.008,
      primaryModel: 'claude-sonnet-4-6',
      durationMs: 0,
      messageCount: 1,
      isOngoing: true,
      visibleContextTokens: 300,
      contextWindowTokens: 200_000,
      totalContextConsumption: 80,
      compactionCount: 0,
      phaseBreakdowns: [],
    });

    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 1,
      entries: [newMessage],
      metrics: incrementalMetrics,
    } satisfies IncrementalResult);

    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    // Token totals: additive
    expect(result.metrics.inputTokens).toBe(280);
    expect(result.metrics.outputTokens).toBe(140);
    expect(result.metrics.cacheReadTokens).toBe(28);
    expect(result.metrics.cacheCreationTokens).toBe(14);
    expect(result.metrics.totalTokens).toBe(462);
    expect(result.metrics.costUsd).toBeCloseTo(0.028);

    // Latest-state from incremental (except visible context, which is recomputed)
    expect(result.metrics.primaryModel).toBe('claude-sonnet-4-6');
    expect(result.metrics.isOngoing).toBe(true);
    expect(result.metrics.visibleContextTokens).toBe(9); // merged messages m1+m2+m3

    // Models used: union (both models present)
    expect(result.metrics.modelsUsed).toContain('claude-opus-4-6');
    expect(result.metrics.modelsUsed).toContain('claude-sonnet-4-6');

    // Recalculated
    expect(result.metrics.messageCount).toBe(3);
    expect(result.metrics.durationMs).toBe(20000); // m1→m3

    // Compaction: kept from existing (not merged with incremental)
    expect(result.metrics.compactionCount).toBe(1);
    expect(result.metrics.totalContextConsumption).toBe(200);
    expect(result.metrics.phaseBreakdowns).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Metric merge: nullish coalescing (zero and empty-string preservation)
  // -------------------------------------------------------------------------

  it('should recompute visibleContextTokens from merged messages (not incremental snapshot)', async () => {
    const existingMetrics = makeMetrics({ visibleContextTokens: 5000 });
    const session1 = makeSession({ metrics: existingMetrics });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session1);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    // File grew — incremental provides visibleContextTokens=0, but merge recomputes.
    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 1,
      entries: [makeMessage('m3', 1706000010000)],
      metrics: makeMetrics({ visibleContextTokens: 0 }),
    } satisfies IncrementalResult);

    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    // Recomputed from m1+m2+m3 text content ("Message mX" => 3 each).
    expect(result.metrics.visibleContextTokens).toBe(9);
  });

  it('should preserve existing totalContextTokens when incremental totalContextTokens is 0', async () => {
    const existingMetrics = makeMetrics({ totalContextTokens: 1234 });
    const session1 = makeSession({ metrics: existingMetrics });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session1);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 1,
      entries: [makeMessage('m3', 1706000010000)],
      metrics: makeMetrics({ totalContextTokens: 0 }),
    } satisfies IncrementalResult);

    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);
    expect(result.metrics.totalContextTokens).toBe(1234);
  });

  it('should overwrite existing totalContextTokens when incremental totalContextTokens is > 0', async () => {
    const existingMetrics = makeMetrics({ totalContextTokens: 1234 });
    const session1 = makeSession({ metrics: existingMetrics });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session1);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 1,
      entries: [makeMessage('m3', 1706000010000)],
      metrics: makeMetrics({ totalContextTokens: 321 }),
    } satisfies IncrementalResult);

    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);
    expect(result.metrics.totalContextTokens).toBe(321);
  });

  it('should preserve totalContextTokens when incremental delta has no assistant usage snapshot', async () => {
    const existingMetrics = makeMetrics({ totalContextTokens: 777 });
    const session1 = makeSession({ metrics: existingMetrics });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session1);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 1,
      entries: [
        makeMessage('m3', 1706000010000, {
          role: 'user',
          content: [{ type: 'text', text: 'delta user only' }],
        }),
      ],
      metrics: makeMetrics({ totalContextTokens: 0 }),
    } satisfies IncrementalResult);

    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);
    expect(result.metrics.totalContextTokens).toBe(777);
  });

  it('should recompute visibleContextTokens from merged messages with compaction awareness', async () => {
    const existingMessages = [
      makeMessage('m1', 1706000000000, {
        role: 'user',
        content: [{ type: 'text', text: 'aaaaaaaa' }],
      }),
      makeMessage('m2', 1706000002000, {
        role: 'assistant',
        content: [{ type: 'text', text: 'bbbbbbbb' }],
      }),
      makeMessage('m3', 1706000004000, {
        role: 'user',
        isCompactSummary: true,
        content: [{ type: 'text', text: 'cccc' }],
      }),
    ];
    const existingMetrics = makeMetrics({ visibleContextTokens: 9999 });
    const session1 = makeSession({ metrics: existingMetrics, messages: existingMessages });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session1);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 1,
      entries: [
        makeMessage('m4', 1706000010000, {
          role: 'assistant',
          content: [{ type: 'text', text: 'dddddddd' }],
        }),
      ],
      metrics: makeMetrics({ visibleContextTokens: 12345 }),
    } satisfies IncrementalResult);

    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);
    // Last compaction at m3; utility sums messages AFTER compaction marker.
    expect(result.metrics.visibleContextTokens).toBe(2);
  });

  it('should preserve zero-valued contextWindowTokens from incremental parse', async () => {
    const existingMetrics = makeMetrics({ contextWindowTokens: 200_000 });
    const session1 = makeSession({ metrics: existingMetrics });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session1);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 1,
      entries: [makeMessage('m3', 1706000010000)],
      metrics: makeMetrics({ contextWindowTokens: 0 }),
    } satisfies IncrementalResult);

    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    // Must be 0, NOT 200_000
    expect(result.metrics.contextWindowTokens).toBe(0);
  });

  it('should preserve empty-string primaryModel from incremental parse', async () => {
    const existingMetrics = makeMetrics({ primaryModel: 'claude-opus-4-6' });
    const session1 = makeSession({ metrics: existingMetrics });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session1);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 1,
      entries: [makeMessage('m3', 1706000010000)],
      metrics: makeMetrics({ primaryModel: '' }),
    } satisfies IncrementalResult);

    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    // Must be '' (from incremental), NOT 'claude-opus-4-6' (stale existing)
    expect(result.metrics.primaryModel).toBe('');
  });

  // -------------------------------------------------------------------------
  // Incremental without metrics falls back to existing metrics
  // -------------------------------------------------------------------------

  it('should keep existing metrics when incremental result has no metrics', async () => {
    const existingMetrics = makeMetrics({ isOngoing: false });
    const session1 = makeSession({ metrics: existingMetrics });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session1);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    // File grew but incremental result has no metrics
    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));

    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 1,
      entries: [makeMessage('m3')],
      // metrics: undefined — no metrics
    } satisfies IncrementalResult);

    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    // Should keep existing metrics unchanged
    expect(result.metrics).toBe(existingMetrics);
    expect(result.messages).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // File mtime change triggers reparse even if size unchanged
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Warnings merge
  // -------------------------------------------------------------------------

  it('should merge warnings from existing and incremental results with dedup', async () => {
    const session1 = makeSession({ warnings: ['Warning A'] });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session1);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    // File grew — incremental has overlapping + new warning
    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 1,
      entries: [makeMessage('m3', 1706000010000)],
      metrics: makeMetrics(),
      warnings: ['Warning A', 'Warning B'],
    } satisfies IncrementalResult);

    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    expect(result.warnings).toEqual(['Warning A', 'Warning B']);
  });

  it('should return undefined warnings when neither existing nor incremental have warnings', async () => {
    const session1 = makeSession();
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session1);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 1,
      entries: [makeMessage('m3', 1706000010000)],
      metrics: makeMetrics(),
    } satisfies IncrementalResult);

    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    expect(result.warnings).toBeUndefined();
  });

  it('should merge warnings in snapshot incremental mode', async () => {
    adapter = makeAdapter({
      providerName: 'gemini',
      incrementalMode: 'snapshot',
    });

    const session1 = makeSession({ warnings: ['Warning from full parse'] });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session1);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 2,
      entries: [makeMessage('m1'), makeMessage('m2')],
      metrics: makeMetrics(),
      warnings: ['Warning from snapshot'],
    } satisfies IncrementalResult);

    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    expect(result.warnings).toEqual(['Warning from full parse', 'Warning from snapshot']);
  });

  it('should reparse when file mtime changes even if size is the same', async () => {
    const session1 = makeSession({ id: 'v1' });
    const session2 = makeSession({ id: 'v2' });
    (adapter.parseFullSession as jest.Mock)
      .mockResolvedValueOnce(session1)
      .mockResolvedValueOnce(session2);

    // First call
    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    // Same size, different mtime
    mockedFsStat.mockResolvedValue(makeStat(1000, 1706000010000));

    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    // Same size but different mtime: file size didn't grow → full reparse
    expect(result).toBe(session2);
    expect(adapter.parseFullSession).toHaveBeenCalledTimes(2);
  });
});
