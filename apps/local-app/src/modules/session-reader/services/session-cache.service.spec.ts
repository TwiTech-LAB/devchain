import * as fsPromises from 'node:fs/promises';
import { SessionCacheService } from './session-cache.service';
import type {
  SessionReaderAdapter,
  IncrementalResult,
} from '../adapters/session-reader-adapter.interface';
import type { UnifiedSession, UnifiedMetrics, UnifiedMessage } from '../dtos/unified-session.types';
import type { UnifiedChunk } from '../dtos/unified-chunk.types';
import { MetricsService } from '../../metrics/services/metrics.service';

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
  const msg: UnifiedMessage = {
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
  // Default a synthetic assistant to a COMPLETED turn so generic consecutive-assistant
  // appends stay distinct messages (the cache-boundary continuation fold only coalesces a
  // tail whose stopReason !== 'end_turn'). Boundary-fold tests override this with 'tool_use'.
  if (msg.role === 'assistant' && msg.stopReason === undefined) {
    msg.stopReason = 'end_turn';
  }
  return msg;
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

function makeStat(size: number, mtimeMs: number, ino = 12345, dev = 1): fsPromises.FileHandle {
  return {
    size,
    ino,
    dev,
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

const mockMetricsService = {
  registerCacheStatsProvider: jest.fn(),
  registerStatsProvider: jest.fn(),
} as never;

describe('SessionCacheService', () => {
  let service: SessionCacheService;
  let adapter: SessionReaderAdapter;
  let dateSpy: jest.SpyInstance;

  const FILE_PATH = '/tmp/test.jsonl';
  const SESSION_ID = 'session-1';

  beforeEach(() => {
    jest
      .spyOn(
        SessionCacheService.prototype as unknown as {
          tryHashFileContent: () => Promise<{ prefixDigest: string; fullDigest: string }>;
        },
        'tryHashFileContent',
      )
      .mockResolvedValue({ prefixDigest: 'stable-prefix', fullDigest: 'stable-prefix' });
    service = new SessionCacheService(mockMetricsService);
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

  it('module-unit: strips adapter-provided derived chunks from the parsed cache root', async () => {
    const adapterSession = makeSession({ chunks: [] });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(adapterSession);

    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    expect(result).not.toBe(adapterSession);
    expect(result.chunks).toBeUndefined();
    expect(service.getEntry(SESSION_ID)?.session.chunks).toBeUndefined();
    expect(adapterSession.chunks).toEqual([]);
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

  describe('getFreshSession', () => {
    it('module-unit: returns a fresh cached session without invoking an adapter parse', async () => {
      const session = makeSession();
      (adapter.parseFullSession as jest.Mock).mockResolvedValue(session);
      await service.getOrParse(SESSION_ID, FILE_PATH, adapter);
      jest.clearAllMocks();
      mockedFsStat.mockResolvedValue(makeStat(1000, 1706000000000));

      const result = await service.getFreshSession(SESSION_ID, FILE_PATH, adapter);

      expect(result).toBe(session);
      expect(adapter.parseFullSession).not.toHaveBeenCalled();
      expect(adapter.parseIncremental).not.toHaveBeenCalled();
    });

    it('module-unit: returns undefined when cached source freshness has changed', async () => {
      await service.getOrParse(SESSION_ID, FILE_PATH, adapter);
      mockedFsStat.mockResolvedValue(makeStat(1200, 1706000001000));

      const result = await service.getFreshSession(SESSION_ID, FILE_PATH, adapter);

      expect(result).toBeUndefined();
      expect(adapter.parseIncremental).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Idle retention
  // -------------------------------------------------------------------------

  it('module-unit: does not reparse a fresh source due to entry age alone', async () => {
    const session1 = makeSession({ id: 'session-v1' });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session1);

    // First call: populates cache
    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    // Advance time past the former 10-minute absolute TTL without running the idle sweep.
    dateSpy.mockReturnValue(1706000000000 + 11 * 60 * 1000);

    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    expect(result).toBe(session1);
    expect(adapter.parseFullSession).toHaveBeenCalledTimes(1);
  });

  it('module-unit: idle sweep evicts an untouched composite entry', async () => {
    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    const swept = service.sweepIdleEntries(1706000000000 + 10 * 60 * 1000);

    expect(swept).toBe(1);
    expect(service.getEntry(SESSION_ID)).toBeUndefined();
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

  // -------------------------------------------------------------------------
  // Cache-boundary tool_result fold (Remediation 9)
  // -------------------------------------------------------------------------

  /** An assistant tail PAUSED on a tool_use (stopReason 'tool_use'), awaiting continuation. */
  function makeToolUseTail(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
    return makeMessage('a-tool', 1706000005000, {
      role: 'assistant',
      content: [{ type: 'tool_call', toolCallId: 'tool-1', toolName: 'Bash', input: {} }],
      toolCalls: [{ id: 'tool-1', name: 'Bash', input: {}, isTask: false }],
      stopReason: 'tool_use',
      ...overrides,
    });
  }

  /** A continuation assistant (the resumed turn) arriving in a later slice. */
  function makeContinuationAssistant(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
    return makeMessage('a-cont', 1706000012000, {
      role: 'assistant',
      content: [{ type: 'text', text: 'continuing the answer' }],
      stopReason: 'end_turn',
      usage: { input: 30, output: 15, cacheRead: 0, cacheCreation: 0 },
      ...overrides,
    });
  }

  /** A standalone tool-result-only user(meta) entry (the leading message of a later slice). */
  function makeToolResultEntry(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
    return makeMessage('u-toolresult', 1706000010000, {
      role: 'user',
      isMeta: true,
      content: [{ type: 'tool_result', toolCallId: 'tool-1', content: 'ok', isError: false }],
      toolResults: [{ toolCallId: 'tool-1', content: 'ok', isError: false }],
      ...overrides,
    });
  }

  function seedSession(tail: UnifiedMessage): UnifiedSession {
    return makeSession({
      messages: [
        makeMessage('u-1', 1706000000000, {
          role: 'user',
          content: [{ type: 'text', text: 'do a thing' }],
        }),
        tail,
      ],
      metrics: makeMetrics({ messageCount: 2 }),
    });
  }

  it('folds a leading tool_result-only slice onto the cached tail assistant (count parity at the boundary)', async () => {
    const tail = makeToolUseTail();
    const session1 = seedSession(tail);
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session1);
    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    // Next slice begins with the tool_result whose tool_use was in the prior slice.
    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 1,
      entries: [makeToolResultEntry()],
      metrics: makeMetrics({ messageCount: 1, inputTokens: 0, outputTokens: 0 }),
    } satisfies IncrementalResult);

    const { session, boundaryFold } = await service.getOrParseWithMeta(
      SESSION_ID,
      FILE_PATH,
      adapter,
    );

    expect(boundaryFold).toBe(true);
    // Folded, not merged as a standalone message — count stays at the folded 2.
    expect(session.messages).toHaveLength(2);
    expect(session.metrics.messageCount).toBe(2);
    expect(session.metrics.messageCount).toBe(session.messages.length);
    // No standalone user-role tool_result remains.
    expect(session.messages.some((m) => m.role === 'user' && m.toolResults.length > 0)).toBe(false);
    // The cached tail assistant now carries the tool result (content block + toolResults).
    const mergedTail = session.messages[1];
    expect(mergedTail.role).toBe('assistant');
    expect(mergedTail.toolResults).toHaveLength(1);
    expect(mergedTail.toolResults[0].toolCallId).toBe('tool-1');
    expect(mergedTail.content.some((b) => b.type === 'tool_result')).toBe(true);
    // The ORIGINAL cached tail object is not mutated (the fold clones it).
    expect(tail.toolResults).toHaveLength(0);
    expect(tail.content.some((b) => b.type === 'tool_result')).toBe(false);
  });

  it('does NOT fold a sidechain tool_result onto a main-thread tail assistant (sidechain guard)', async () => {
    const tail = makeToolUseTail({ isSidechain: false });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(seedSession(tail));
    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 1,
      entries: [makeToolResultEntry({ isSidechain: true })],
      metrics: makeMetrics({ messageCount: 1 }),
    } satisfies IncrementalResult);

    const { session, boundaryFold } = await service.getOrParseWithMeta(
      SESSION_ID,
      FILE_PATH,
      adapter,
    );

    expect(boundaryFold).toBe(false);
    // Cross-thread fold is forbidden → the tool_result stays a standalone message.
    expect(session.messages).toHaveLength(3);
    expect(session.metrics.messageCount).toBe(3);
    expect(session.metrics.messageCount).toBe(session.messages.length);
  });

  it('Case A: folds a leading [tool_result, continuation assistant] run onto the cached tail (count unchanged)', async () => {
    const tail = makeToolUseTail();
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(seedSession(tail));
    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    // Slice: the tool_result THEN the resumed assistant — both belong to the tail's turn.
    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 2,
      entries: [makeToolResultEntry(), makeContinuationAssistant({ id: 'a-final' })],
      metrics: makeMetrics({ messageCount: 2 }),
    } satisfies IncrementalResult);

    const { session, boundaryFold } = await service.getOrParseWithMeta(
      SESSION_ID,
      FILE_PATH,
      adapter,
    );

    // The whole run folds onto the tail → zero net new messages → in-place tail replacement.
    expect(boundaryFold).toBe(true);
    expect(session.messages).toHaveLength(2);
    expect(session.metrics.messageCount).toBe(2);
    expect(session.metrics.messageCount).toBe(session.messages.length);
    const mergedTail = session.messages[1];
    expect(mergedTail.toolResults).toHaveLength(1); // tool_result folded
    expect(mergedTail.content.some((b) => b.type === 'tool_result')).toBe(true);
    // The continuation text + its usage are merged onto the tail.
    expect(
      mergedTail.content.some((b) => b.type === 'text' && b.text === 'continuing the answer'),
    ).toBe(true);
    expect(mergedTail.stopReason).toBe('end_turn'); // advanced to the continuation's completion
    expect(session.messages.some((m) => m.role === 'user' && m.toolResults.length > 0)).toBe(false);
  });

  it('Case B: folds a slice that begins DIRECTLY with the continuation assistant (no leading tool_result)', async () => {
    const tail = makeToolUseTail();
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(seedSession(tail));
    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    // The tool_result was consumed in the PRIOR slice; this slice starts with the resumed
    // assistant alone — the parser has no fold target so it arrives standalone.
    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 1,
      entries: [makeContinuationAssistant()],
      metrics: makeMetrics({ messageCount: 1 }),
    } satisfies IncrementalResult);

    const { session, boundaryFold } = await service.getOrParseWithMeta(
      SESSION_ID,
      FILE_PATH,
      adapter,
    );

    expect(boundaryFold).toBe(true);
    expect(session.messages).toHaveLength(2); // continuation merged, not appended
    expect(session.metrics.messageCount).toBe(2);
    expect(session.metrics.messageCount).toBe(session.messages.length);
    const mergedTail = session.messages[1];
    expect(
      mergedTail.content.some((b) => b.type === 'text' && b.text === 'continuing the answer'),
    ).toBe(true);
    // Usage summed onto the tail so per-chunk token metrics don't undercount the merged turn.
    expect(mergedTail.usage?.input).toBe(30);
    // The ORIGINAL cached tail object is not mutated (clone).
    expect(tail.content.some((b) => b.type === 'text')).toBe(false);
  });

  it('over-merge guard: a continuation assistant does NOT fold onto a tail that already end_turn-ed', async () => {
    // A completed turn (stopReason end_turn) followed by another assistant with no user
    // between is a NEW turn (retry/continuation), not a tool continuation — must stay separate.
    const tail = makeToolUseTail({ stopReason: 'end_turn' });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(seedSession(tail));
    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 1,
      entries: [makeContinuationAssistant()],
      metrics: makeMetrics({ messageCount: 1 }),
    } satisfies IncrementalResult);

    const { session, boundaryFold } = await service.getOrParseWithMeta(
      SESSION_ID,
      FILE_PATH,
      adapter,
    );

    expect(boundaryFold).toBe(false);
    expect(session.messages).toHaveLength(3); // appended as a new turn
    expect(session.metrics.messageCount).toBe(3);
    expect(session.metrics.messageCount).toBe(session.messages.length);
  });

  it('over-merge guard: a real user prompt leading the slice stops the run (new turn, no fold)', async () => {
    const tail = makeToolUseTail();
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(seedSession(tail));
    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
    const userPrompt = makeMessage('u-2', 1706000011000, {
      role: 'user',
      content: [{ type: 'text', text: 'another question' }],
    });
    (adapter.parseIncremental as jest.Mock).mockResolvedValue({
      hasMore: false,
      nextByteOffset: 1500,
      messageCount: 2,
      entries: [userPrompt, makeContinuationAssistant()],
      metrics: makeMetrics({ messageCount: 2 }),
    } satisfies IncrementalResult);

    const { session, boundaryFold } = await service.getOrParseWithMeta(
      SESSION_ID,
      FILE_PATH,
      adapter,
    );

    // The user prompt breaks the run immediately → nothing folds; both append.
    expect(boundaryFold).toBe(false);
    expect(session.messages).toHaveLength(4);
    expect(session.metrics.messageCount).toBe(4);
    expect(session.messages.map((m) => m.id)).toEqual(['u-1', 'a-tool', 'u-2', 'a-cont']);
  });

  it('should replace messages and metrics in snapshot incremental mode', async () => {
    adapter = makeAdapter({
      providerName: 'copilot',
      incrementalMode: 'snapshot',
    });

    const initialSession = makeSession({
      providerName: 'copilot',
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
      providerName: 'copilot',
      incrementalMode: 'snapshot',
    });

    const initialSession = makeSession({
      providerName: 'copilot',
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
  // Composite byte-budget eviction
  // -------------------------------------------------------------------------

  it('invalidates only the derived transcript DTO for runtime metrics changes', async () => {
    const session = makeSession({ id: 'session-a' });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(session);
    mockedFsStat.mockResolvedValue(makeStat(1_000, 1706000000000));
    await service.getOrParse('session-a', '/tmp/a.jsonl', adapter);
    const sourceVersion = service.getEntry('session-a')!.sourceVersion;
    const chunks: UnifiedChunk[] = [];
    service.setChunks('session-a', sourceVersion, chunks);
    service.setDto('session-a', {
      result: { messages: session.messages },
      responseBytes: 1_500,
      maxToolResultLength: 2_000,
      enrichmentFingerprint: 'claude:200000',
    });

    service.invalidateDto('session-a');

    expect(service.getEntry('session-a')?.session).toBe(session);
    expect(service.getChunks('session-a', sourceVersion)).toBe(chunks);
    expect(service.getDto('session-a', 2_000, 'claude:200000')).toBeUndefined();
  });

  it('module-unit: evicts every representation of the oldest session when over budget', async () => {
    service = new SessionCacheService(mockMetricsService, {
      budgetBytes: 5_000,
      idleTtlMs: 10 * 60 * 1_000,
      sweepIntervalMs: 60_000,
    });
    const first = makeSession({ id: 'session-a' });
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(first);
    mockedFsStat.mockResolvedValue(makeStat(1_000, 1706000000000));
    await service.getOrParse('session-a', '/tmp/a.jsonl', adapter);
    const firstSourceVersion = service.getEntry('session-a')!.sourceVersion;
    const chunks: UnifiedChunk[] = [];
    service.setChunks('session-a', firstSourceVersion, chunks);
    service.setDto('session-a', {
      result: { messages: first.messages },
      responseBytes: 1_500,
      maxToolResultLength: 2_000,
      enrichmentFingerprint: 'claude:200000',
    });

    (adapter.parseFullSession as jest.Mock).mockResolvedValue(makeSession({ id: 'session-b' }));
    await service.getOrParse('session-b', '/tmp/b.jsonl', adapter);

    expect(service.getEntry('session-a')).toBeUndefined();
    expect(service.getChunks('session-a', firstSourceVersion)).toBeUndefined();
    expect(service.getDto('session-a', 2_000, 'claude:200000')).toBeUndefined();
    expect(Array.from(service.getChunksRetainedRoots())).not.toContain(chunks);
    expect(service.getCacheStats()).toMatchObject({
      budgetUsedBytes: 2_000,
      budgetBytes: 5_000,
      evictions: 1,
    });
  });

  it('module-unit heap: leaves no strong chunk root after whole-session eviction', async () => {
    service = new SessionCacheService(mockMetricsService, {
      budgetBytes: 2_500,
      idleTtlMs: 10 * 60 * 1_000,
      sweepIntervalMs: 60_000,
    });
    mockedFsStat.mockResolvedValue(makeStat(1_000, 1706000000000));
    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);
    const sourceVersion = service.getEntry(SESSION_ID)!.sourceVersion;

    const weakChunks = (() => {
      const chunks: UnifiedChunk[] = [];
      const weak = new WeakRef(chunks);
      service.setChunks(SESSION_ID, sourceVersion, chunks);
      return weak;
    })();

    expect(service.getEntry(SESSION_ID)).toBeUndefined();
    expect(Array.from(service.getChunksRetainedRoots())).toEqual([]);

    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!gc) {
      throw new Error(
        'This heap assertion requires --expose-gc; run it through the local-app test script.',
      );
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      gc();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(weakChunks.deref()).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Composite LRU touch
  // -------------------------------------------------------------------------

  it('module-unit: protects a recently accessed session during budget eviction', async () => {
    service = new SessionCacheService(mockMetricsService, {
      budgetBytes: 4_500,
      idleTtlMs: 10 * 60 * 1_000,
      sweepIntervalMs: 60_000,
    });
    mockedFsStat.mockResolvedValue(makeStat(1_000, 1706000000000));
    for (const id of ['a', 'b']) {
      (adapter.parseFullSession as jest.Mock).mockResolvedValue(makeSession({ id }));
      await service.getOrParse(`session-${id}`, `/tmp/${id}.jsonl`, adapter);
    }

    await service.getOrParse('session-a', '/tmp/a.jsonl', adapter);
    (adapter.parseFullSession as jest.Mock).mockResolvedValue(makeSession({ id: 'c' }));
    await service.getOrParse('session-c', '/tmp/c.jsonl', adapter);

    expect(service.getEntry('session-a')).toBeDefined();
    expect(service.getEntry('session-b')).toBeUndefined();
    expect(service.getEntry('session-c')).toBeDefined();
  });

  it('module-unit: exposes bounded composite usage across a churn scenario', async () => {
    const metricsService = new MetricsService();
    service = new SessionCacheService(metricsService, {
      budgetBytes: 5_000,
      idleTtlMs: 10 * 60 * 1_000,
      sweepIntervalMs: 60_000,
    });
    service.onModuleInit();
    metricsService.registerCacheStatsProvider(
      'dto',
      () => service.getDtoCacheStats(),
      () => service.getDtoRetainedRoots(),
    );
    mockedFsStat.mockResolvedValue(makeStat(1_000, 1706000000000));

    try {
      for (let i = 0; i < 5; i += 1) {
        const sessionId = `session-${i}`;
        (adapter.parseFullSession as jest.Mock).mockResolvedValue(makeSession({ id: sessionId }));
        await service.getOrParse(sessionId, `/tmp/${sessionId}.jsonl`, adapter);
        service.setChunks(sessionId, service.getEntry(sessionId)!.sourceVersion, []);
        service.setDto(sessionId, {
          result: { sessionId },
          responseBytes: 1_000,
          maxToolResultLength: 2_000,
          enrichmentFingerprint: 'claude:200000',
        });
        expect(service.getCacheStats().budgetUsedBytes).toBeLessThanOrEqual(5_000);
      }

      const snapshot = metricsService.getMetrics();
      expect(snapshot.caches).toEqual(
        expect.objectContaining({
          parsed: expect.objectContaining({ entries: 1 }),
          chunks: expect.objectContaining({ entries: 1 }),
          dto: expect.objectContaining({ entries: 1 }),
        }),
      );
      expect(snapshot.caches.aggregate).toEqual(
        expect.objectContaining({
          budgetUsedBytes: 4_000,
          budgetBytes: 5_000,
          evictions: 4,
        }),
      );
    } finally {
      service.onModuleDestroy();
    }
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
      providerName: 'copilot',
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

  it('should fully reparse when an inode replacement grows', async () => {
    const session1 = makeSession({ id: 'old-generation' });
    const session2 = makeSession({ id: 'new-generation' });
    (adapter.parseFullSession as jest.Mock)
      .mockResolvedValueOnce(session1)
      .mockResolvedValueOnce(session2);

    await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000, 67890));
    const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

    expect(result).toBe(session2);
    expect(adapter.parseFullSession).toHaveBeenCalledTimes(2);
    expect(adapter.parseIncremental).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // getOrParseWithMeta
  // -------------------------------------------------------------------------

  describe('getOrParseWithMeta', () => {
    it('should return cacheHit=false on first call', async () => {
      const result = await service.getOrParseWithMeta(SESSION_ID, FILE_PATH, adapter);

      expect(result.cacheHit).toBe(false);
      expect(result.sourceChangeKind).toBe('unknown-full-parse');
      expect(result.lastSize).toBe(1000);
      expect(result.lastMtime).toBe(1706000000000);
      expect(result.lastOffset).toBe(1000);
      expect(result.session).toBeDefined();
    });

    it('should return cacheHit=true when file unchanged and TTL valid', async () => {
      await service.getOrParseWithMeta(SESSION_ID, FILE_PATH, adapter);
      const result = await service.getOrParseWithMeta(SESSION_ID, FILE_PATH, adapter);

      expect(result.cacheHit).toBe(true);
      expect(result.sourceChangeKind).toBe('cache-hit');
      expect(adapter.parseFullSession).toHaveBeenCalledTimes(1);
    });

    it('should return cacheHit=false when file grew (incremental parse)', async () => {
      const incResult: IncrementalResult = {
        entries: [makeMessage('m3', 1706000010000)],
        nextByteOffset: 1500,
        metrics: makeMetrics({ messageCount: 3 }),
      };
      (adapter.parseIncremental as jest.Mock).mockResolvedValue(incResult);

      await service.getOrParseWithMeta(SESSION_ID, FILE_PATH, adapter);

      mockedFsStat.mockResolvedValue(makeStat(1500, 1706000005000));
      const result = await service.getOrParseWithMeta(SESSION_ID, FILE_PATH, adapter);

      expect(result.cacheHit).toBe(false);
      expect(result.sourceChangeKind).toBe('same-file-append');
      expect(result.lastOffset).toBe(1500);
      expect(result.lastSize).toBe(1500);
    });

    it.each([
      {
        label: 'post-parse proof is unavailable',
        postParseProof: undefined,
      },
      {
        label: 'post-parse digest differs from the proven revision',
        postParseProof: { prefixDigest: 'rotated-generation', fullDigest: 'rotated-generation' },
      },
    ])('discards a tentative incremental result when the $label', async ({ postParseProof }) => {
      const hashFileContent = (
        service as unknown as {
          tryHashFileContent: jest.MockedFunction<
            () => Promise<{ prefixDigest: string; fullDigest: string } | undefined>
          >;
        }
      ).tryHashFileContent;
      hashFileContent
        .mockReset()
        .mockResolvedValueOnce({ prefixDigest: 'cached-prefix', fullDigest: 'cached-prefix' })
        .mockResolvedValueOnce({
          prefixDigest: 'cached-prefix',
          fullDigest: 'proven-appended-revision',
        })
        .mockResolvedValueOnce(postParseProof)
        .mockResolvedValue({
          prefixDigest: 'canonical-current-revision',
          fullDigest: 'canonical-current-revision',
        });

      const tentativeMessage = makeMessage('tentative-mixed-suffix', 1706000010000);
      (adapter.parseIncremental as jest.Mock).mockResolvedValue({
        entries: [tentativeMessage],
        nextByteOffset: 1500,
        metrics: makeMetrics({ messageCount: 3 }),
      } satisfies IncrementalResult);
      const canonicalSession = makeSession({
        messages: [makeMessage('canonical-current-generation')],
        metrics: makeMetrics({ messageCount: 1 }),
      });
      (adapter.parseFullSession as jest.Mock)
        .mockResolvedValueOnce(makeSession())
        .mockResolvedValueOnce(canonicalSession);

      await service.getOrParseWithMeta(SESSION_ID, FILE_PATH, adapter);
      mockedFsStat.mockResolvedValue(makeStat(1500, 1706000005000));

      const result = await service.getOrParseWithMeta(SESSION_ID, FILE_PATH, adapter);

      expect(adapter.parseIncremental).toHaveBeenCalledTimes(1);
      expect(adapter.parseFullSession).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        cacheHit: false,
        sourceChangeKind: 'same-file-rewrite',
        session: canonicalSession,
      });
      expect(result.session.messages).not.toContain(tentativeMessage);
      expect(service.getEntry(SESSION_ID)?.session).toBe(canonicalSession);
    });

    it.each([
      {
        label: 'prefix mismatch',
        growthProof: { prefixDigest: 'changed-prefix', fullDigest: 'new-generation' },
      },
      { label: 'proof unavailable', growthProof: undefined },
    ])('fails closed on growing same-inode content when the $label', async ({ growthProof }) => {
      const hashFileContent = (
        service as unknown as {
          tryHashFileContent: jest.MockedFunction<
            () => Promise<{ prefixDigest: string; fullDigest: string } | undefined>
          >;
        }
      ).tryHashFileContent;
      hashFileContent
        .mockReset()
        .mockResolvedValueOnce({ prefixDigest: 'cached-prefix', fullDigest: 'cached-prefix' })
        .mockResolvedValueOnce(growthProof)
        .mockResolvedValue({ prefixDigest: 'new-generation', fullDigest: 'new-generation' });

      await service.getOrParseWithMeta(SESSION_ID, FILE_PATH, adapter);
      mockedFsStat.mockResolvedValue(makeStat(1500, 1706000005000));

      const result = await service.getOrParseWithMeta(SESSION_ID, FILE_PATH, adapter);

      expect(result.sourceChangeKind).toBe('same-file-rewrite');
      expect(adapter.parseFullSession).toHaveBeenCalledTimes(2);
      expect(adapter.parseIncremental).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getEntry
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Source-ref + freshness abstraction (shared infra)
  // -------------------------------------------------------------------------

  describe('source-ref + freshness abstraction', () => {
    it('keeps a safe file revision stable until filesystem identity or freshness changes', async () => {
      const original = makeStat(4096, 1706000000000, 111, 7);
      const refreshed = makeStat(4096, 1706000000001, 111, 7);
      const replacement = makeStat(4096, 1706000000001, 222, 7);
      mockedFsStat
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(refreshed)
        .mockResolvedValueOnce(replacement);

      const first = await service.getOrParseWithMeta(SESSION_ID, FILE_PATH, adapter);
      const unchanged = await service.getOrParseWithMeta(SESSION_ID, FILE_PATH, adapter);
      const freshnessChanged = await service.getOrParseWithMeta(SESSION_ID, FILE_PATH, adapter);
      const replaced = await service.getOrParseWithMeta(SESSION_ID, FILE_PATH, adapter);

      expect(Number.isSafeInteger(first.sourceVersion)).toBe(true);
      expect(unchanged).toMatchObject({ cacheHit: true, sourceVersion: first.sourceVersion });
      expect(freshnessChanged.sourceVersion).not.toBe(first.sourceVersion);
      expect(replaced.cacheHit).toBe(false);
      expect(replaced.sourceVersion).not.toBe(freshnessChanged.sourceVersion);
      expect(service.getEntry(SESSION_ID)!.sourceVersion).toBe(replaced.sourceVersion);
      expect(adapter.parseFullSession).toHaveBeenCalledTimes(3);
    });

    // ⭐ KEYSTONE (deferred from P1-3): for a DB source (agy/opencode), `sourceVersion`
    // keys on the freshness token's `maxUpdated` (dbSourceVersion), NOT the container file
    // size. So a same-byte-size in-place edit (constant size, advancing maxUpdated) ADVANCES
    // sourceVersion = the transcript cursor's first component. A size-keyed version would
    // freeze here → a stale read on exactly the in-place-rewrite case the watcher must surface.
    it('⭐ for a DB source, sourceVersion tracks the token maxUpdated (advances on a same-size rewrite)', async () => {
      const getFreshnessToken = jest
        .fn()
        .mockResolvedValueOnce({ maxUpdated: 1_700_000_000 })
        .mockResolvedValueOnce({ maxUpdated: 1_700_000_060 });
      adapter = makeAdapter({ sourceKind: 'db', getFreshnessToken });
      (adapter.parseFullSession as jest.Mock).mockResolvedValue(makeSession());
      const sourceRef = {
        filePath: FILE_PATH,
        providerName: 'agy',
        providerSessionId: 'conv-1',
        kind: 'db' as const,
      };
      // CONSTANT file size across both reads — the rewrite changes no bytes.
      mockedFsStat.mockResolvedValue(makeStat(4096, 1706000000000));
      dateSpy.mockReturnValue(1706000000000);

      const first = await service.getOrParseWithMeta(SESSION_ID, sourceRef, adapter);
      expect(first.sourceVersion).toBe(1_700_000_000);

      dateSpy.mockReturnValue(1706000010000); // 10s later — within TTL; only the token changed
      const second = await service.getOrParseWithMeta(SESSION_ID, sourceRef, adapter);
      expect(second.sourceVersion).toBe(1_700_000_060); // advances with maxUpdated, not size
      expect(second.sourceChangeKind).toBe('db-update');
      expect(service.getEntry(SESSION_ID)!.sourceVersion).toBe(1_700_000_060);
    });

    it('should use adapter.getFreshnessToken for staleness when provided', async () => {
      // Constant token → cache stays warm even when mtime/size change.
      const getFreshnessToken = jest.fn().mockResolvedValue({ token: 'constant' });
      adapter = makeAdapter({ getFreshnessToken });
      (adapter.parseFullSession as jest.Mock).mockResolvedValue(makeSession());

      await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

      // File grew AND mtime changed, but the opaque token is unchanged → cache hit.
      mockedFsStat.mockResolvedValue(makeStat(9999, 1706000099999));
      dateSpy.mockReturnValue(1706000060000); // within TTL

      await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

      expect(adapter.parseFullSession).toHaveBeenCalledTimes(1);
      expect(adapter.parseIncremental).not.toHaveBeenCalled();
      expect(getFreshnessToken).toHaveBeenCalled();
    });

    it('should reparse when adapter.getFreshnessToken value changes', async () => {
      const getFreshnessToken = jest
        .fn()
        .mockResolvedValueOnce({ v: 1 })
        .mockResolvedValueOnce({ v: 2 });
      adapter = makeAdapter({ getFreshnessToken });
      (adapter.parseFullSession as jest.Mock).mockResolvedValue(makeSession());

      await service.getOrParse(SESSION_ID, FILE_PATH, adapter);
      // Same size/mtime, but token changed → not a cache hit.
      dateSpy.mockReturnValue(1706000060000);
      await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

      expect(adapter.parseFullSession).toHaveBeenCalledTimes(2);
    });

    it('should thread a SessionSourceRef into parseFullSession', async () => {
      const sourceRef = {
        filePath: FILE_PATH,
        providerName: 'claude',
        providerSessionId: 'ses_123',
        kind: 'file' as const,
      };
      (adapter.parseFullSession as jest.Mock).mockResolvedValue(makeSession());

      await service.getOrParse(SESSION_ID, sourceRef, adapter);

      expect(adapter.parseFullSession).toHaveBeenCalledWith(FILE_PATH, sourceRef);
    });

    it('should thread a SessionSourceRef into parseIncremental on append', async () => {
      const sourceRef = {
        filePath: FILE_PATH,
        providerName: 'claude',
        providerSessionId: 'ses_123',
        kind: 'file' as const,
      };
      (adapter.parseFullSession as jest.Mock).mockResolvedValue(makeSession());
      await service.getOrParse(SESSION_ID, sourceRef, adapter);

      mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
      (adapter.parseIncremental as jest.Mock).mockResolvedValue({
        hasMore: false,
        nextByteOffset: 1500,
        messageCount: 1,
        entries: [makeMessage('m3', 1706000010000)],
        metrics: makeMetrics(),
      } satisfies IncrementalResult);

      await service.getOrParse(SESSION_ID, sourceRef, adapter);

      expect(adapter.parseIncremental).toHaveBeenCalledWith(
        FILE_PATH,
        { byteOffset: 1000, includeToolCalls: true },
        sourceRef,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Central assistant-turn coalescing (the unified choke-point, Phase:1 Task:1)
  // -------------------------------------------------------------------------
  describe('central assistant-turn coalescing', () => {
    it('deflates consecutive open (tool_use) assistants on the FULL-parse path + corrects messageCount', async () => {
      // A provider whose parser did NOT coalesce: one user + two tool_use steps + a final
      // assistant, all consecutive. The choke-point collapses them to [user, assistant].
      const inflated = makeSession({
        messages: [
          makeMessage('u-1', 1706000000000, { role: 'user', stopReason: undefined }),
          makeMessage('a-1', 1706000001000, { stopReason: 'tool_use' }),
          makeMessage('a-2', 1706000002000, { stopReason: 'tool_use' }),
          makeMessage('a-3', 1706000003000, { stopReason: 'end_turn' }),
        ],
        metrics: makeMetrics({ messageCount: 4 }),
      });
      (adapter.parseFullSession as jest.Mock).mockResolvedValue(inflated);

      const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

      expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(result.messages.map((m) => m.id)).toEqual(['u-1', 'a-1']);
      expect(result.metrics.messageCount).toBe(2); // recomputed === messages.length
      expect(result.metrics.messageCount).toBe(result.messages.length);
    });

    it('updates snapshotMetrics.messageCount on the SNAPSHOT incremental path', async () => {
      adapter = makeAdapter({ providerName: 'opencode', incrementalMode: 'snapshot' });
      (adapter.parseFullSession as jest.Mock).mockResolvedValue(
        makeSession({
          providerName: 'opencode',
          messages: [makeMessage('m1')],
          metrics: makeMetrics({ messageCount: 1 }),
        }),
      );
      await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

      // Snapshot delta returns the FULL state with inflated consecutive tool_use steps and a
      // raw (un-coalesced) messageCount of 4.
      mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
      (adapter.parseIncremental as jest.Mock).mockResolvedValue({
        hasMore: false,
        nextByteOffset: 1500,
        entries: [
          makeMessage('u-1', 1706000000000, { role: 'user', stopReason: undefined }),
          makeMessage('a-1', 1706000001000, { stopReason: 'tool_use' }),
          makeMessage('a-2', 1706000002000, { stopReason: 'tool_use' }),
          makeMessage('a-3', 1706000003000, { stopReason: 'end_turn' }),
        ],
        metrics: makeMetrics({ messageCount: 4 }),
      } satisfies IncrementalResult);

      const result = await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

      expect(result.messages.map((m) => m.id)).toEqual(['u-1', 'a-1']);
      expect(result.metrics.messageCount).toBe(2); // snapshot count corrected at the choke-point
    });

    it('is a NO-OP on the DELTA path that the cache fold already coalesced (no double-merge)', async () => {
      // Cached tail PAUSED on a tool_use; the next slice is its continuation. The cache fold
      // merges it onto the tail; the central full-array pass must then change nothing.
      const cachedSession = makeSession({
        messages: [
          makeMessage('u-1', 1706000000000, { role: 'user', stopReason: undefined }),
          makeMessage('a-tool', 1706000001000, { stopReason: 'tool_use' }),
        ],
        metrics: makeMetrics({ messageCount: 2 }),
      });
      (adapter.parseFullSession as jest.Mock).mockResolvedValue(cachedSession);
      await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

      mockedFsStat.mockResolvedValue(makeStat(1500, 1706000010000));
      (adapter.parseIncremental as jest.Mock).mockResolvedValue({
        hasMore: false,
        nextByteOffset: 1500,
        entries: [makeMessage('a-cont', 1706000002000, { stopReason: 'end_turn' })],
      } satisfies IncrementalResult);

      const { session, boundaryFold } = await service.getOrParseWithMeta(
        SESSION_ID,
        FILE_PATH,
        adapter,
      );

      // The continuation folded onto the cached tail (one message, not two) — and the central
      // pass left that result intact.
      expect(session.messages.map((m) => m.id)).toEqual(['u-1', 'a-tool']);
      expect(session.metrics.messageCount).toBe(2);
      expect(boundaryFold).toBe(true);
    });
  });

  describe('getEntry', () => {
    it('should return undefined for unknown session', () => {
      expect(service.getEntry('unknown')).toBeUndefined();
    });

    it('should return cache entry after getOrParse', async () => {
      await service.getOrParse(SESSION_ID, FILE_PATH, adapter);

      const entry = service.getEntry(SESSION_ID);
      expect(entry).toBeDefined();
      expect(entry!.lastSize).toBe(1000);
      expect(entry!.lastMtime).toBe(1706000000000);
      expect(entry!.lastOffset).toBe(1000);
    });
  });
});
