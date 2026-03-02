import { SubagentResolver } from './subagent-resolver.service';
import type { SubagentLocator, SubagentFileInfo } from './subagent-locator.service';
import type { SessionCacheService } from './session-cache.service';
import type { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import type { SessionReaderAdapter } from '../adapters/session-reader-adapter.interface';
import type { UnifiedSession, UnifiedMessage, UnifiedMetrics } from '../dtos/unified-session.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetrics(overrides: Partial<UnifiedMetrics> = {}): UnifiedMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    totalContextConsumption: 0,
    compactionCount: 0,
    phaseBreakdowns: [],
    visibleContextTokens: 0,
    totalContextTokens: 0,
    contextWindowTokens: 200_000,
    costUsd: 0,
    primaryModel: 'claude-sonnet-4-6',
    durationMs: 0,
    messageCount: 0,
    isOngoing: false,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: 'msg-1',
    parentId: null,
    role: 'assistant',
    timestamp: new Date('2024-01-01T00:00:00Z'),
    content: [],
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
    ...overrides,
  };
}

function makeSession(
  id: string,
  messages: UnifiedMessage[] = [],
  overrides: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    providerName: 'claude',
    filePath: `/tmp/${id}.jsonl`,
    messages,
    metrics: makeMetrics({ messageCount: messages.length }),
    isOngoing: false,
    ...overrides,
  };
}

function makeFileInfo(agentId: string, dirType: 'new' | 'legacy' = 'new'): SubagentFileInfo {
  return {
    filePath: `/tmp/subagents/${agentId}.jsonl`,
    agentId,
    directoryType: dirType,
  };
}

function makeTaskToolCall(
  toolCallId: string,
  description?: string,
  subagentType?: string,
): UnifiedMessage {
  return makeMessage({
    id: `msg-${toolCallId}`,
    role: 'assistant',
    toolCalls: [
      {
        id: toolCallId,
        name: 'Task',
        input: { description, subagent_type: subagentType },
        isTask: true,
        taskDescription: description,
        taskSubagentType: subagentType,
      },
    ],
    content: [
      {
        type: 'tool_call',
        toolCallId,
        toolName: 'Task',
        input: { description },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubagentResolver', () => {
  let resolver: SubagentResolver;
  let mockLocator: jest.Mocked<Pick<SubagentLocator, 'locate'>>;
  let mockCacheService: jest.Mocked<Pick<SessionCacheService, 'getOrParse'>>;
  let mockAdapterFactory: jest.Mocked<Pick<SessionReaderAdapterFactory, 'getAdapter'>>;
  let mockAdapter: jest.Mocked<Pick<SessionReaderAdapter, 'parseFullSession'>>;

  const parentFilePath = '/home/user/.claude/projects/-home-user-repo/abc123.jsonl';
  const providerName = 'claude';

  beforeEach(() => {
    jest.resetAllMocks();

    mockLocator = { locate: jest.fn().mockResolvedValue([]) };
    mockCacheService = { getOrParse: jest.fn() };
    mockAdapter = { parseFullSession: jest.fn() };
    mockAdapterFactory = {
      getAdapter: jest.fn().mockReturnValue(mockAdapter),
    };

    resolver = new SubagentResolver(
      mockLocator as unknown as SubagentLocator,
      mockCacheService as unknown as SessionCacheService,
      mockAdapterFactory as unknown as SessionReaderAdapterFactory,
    );
  });

  // -------------------------------------------------------------------------
  // No subagent files
  // -------------------------------------------------------------------------

  it('should return empty array when no subagent files found', async () => {
    mockLocator.locate.mockResolvedValue([]);
    const parent = makeSession('abc123', [makeTaskToolCall('toolu_1', 'do stuff')]);

    const result = await resolver.resolve(parent, parentFilePath, providerName);
    expect(result).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // No adapter
  // -------------------------------------------------------------------------

  it('should return empty array when no adapter found', async () => {
    mockLocator.locate.mockResolvedValue([makeFileInfo('agent-0')]);
    mockAdapterFactory.getAdapter.mockReturnValue(undefined);
    const parent = makeSession('abc123', [makeTaskToolCall('toolu_1')]);

    const result = await resolver.resolve(parent, parentFilePath, providerName);
    expect(result).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // No Task tool calls
  // -------------------------------------------------------------------------

  it('should return empty array when parent has no Task tool calls', async () => {
    mockLocator.locate.mockResolvedValue([makeFileInfo('agent-0')]);
    const subSession = makeSession('agent-0', [
      makeMessage({ role: 'user', content: [{ type: 'text', text: 'hello' }] }),
    ]);
    mockCacheService.getOrParse.mockResolvedValue(subSession);
    const parent = makeSession('abc123', [makeMessage()]);

    const result = await resolver.resolve(parent, parentFilePath, providerName);
    expect(result).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Tier 1: Result-based matching
  // -------------------------------------------------------------------------

  describe('Tier 1: result-based matching', () => {
    it('should match via sourceToolUseId', async () => {
      const fileInfo = makeFileInfo('agent-0');
      mockLocator.locate.mockResolvedValue([fileInfo]);

      const subSession = makeSession('agent-0', [
        makeMessage({
          role: 'user',
          sourceToolUseId: 'toolu_1',
          content: [{ type: 'text', text: 'do something' }],
        }),
        makeMessage({ role: 'assistant' }),
      ]);
      mockCacheService.getOrParse.mockResolvedValue(subSession);

      const parent = makeSession('abc123', [makeTaskToolCall('toolu_1', 'run tests', 'Bash')]);

      const result = await resolver.resolve(parent, parentFilePath, providerName);

      expect(result).toHaveLength(1);
      expect(result[0].toolCallId).toBe('toolu_1');
      expect(result[0].matchMethod).toBe('result');
      expect(result[0].description).toBe('run tests');
      expect(result[0].subagentType).toBe('Bash');
      expect(result[0].filePath).toBe(fileInfo.filePath);
      expect(result[0].session).toBe(subSession);
    });

    it('should match multiple subagents via sourceToolUseId', async () => {
      const file0 = makeFileInfo('agent-0');
      const file1 = makeFileInfo('agent-1');
      mockLocator.locate.mockResolvedValue([file0, file1]);

      mockCacheService.getOrParse
        .mockResolvedValueOnce(
          makeSession('agent-0', [
            makeMessage({
              role: 'user',
              sourceToolUseId: 'toolu_1',
              content: [{ type: 'text', text: 'task 1' }],
            }),
          ]),
        )
        .mockResolvedValueOnce(
          makeSession('agent-1', [
            makeMessage({
              role: 'user',
              sourceToolUseId: 'toolu_2',
              content: [{ type: 'text', text: 'task 2' }],
            }),
          ]),
        );

      const parent = makeSession('abc123', [
        makeTaskToolCall('toolu_1', 'first task'),
        makeTaskToolCall('toolu_2', 'second task'),
      ]);

      const result = await resolver.resolve(parent, parentFilePath, providerName);
      expect(result).toHaveLength(2);
      expect(result[0].toolCallId).toBe('toolu_1');
      expect(result[1].toolCallId).toBe('toolu_2');
      expect(result.every((r) => r.matchMethod === 'result')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tier 2: Description-based matching
  // -------------------------------------------------------------------------

  describe('Tier 2: description-based matching', () => {
    it('should match via agent ID in task description', async () => {
      const fileInfo = makeFileInfo('agent-0');
      mockLocator.locate.mockResolvedValue([fileInfo]);

      const subSession = makeSession('agent-0', [
        makeMessage({ role: 'user', content: [{ type: 'text', text: 'search code' }] }),
      ]);
      mockCacheService.getOrParse.mockResolvedValue(subSession);

      const parent = makeSession('abc123', [
        makeTaskToolCall('toolu_1', 'Dispatch agent-0 to search code'),
      ]);

      const result = await resolver.resolve(parent, parentFilePath, providerName);
      expect(result).toHaveLength(1);
      expect(result[0].matchMethod).toBe('description');
      expect(result[0].toolCallId).toBe('toolu_1');
    });
  });

  // -------------------------------------------------------------------------
  // Tier 3: Positional fallback
  // -------------------------------------------------------------------------

  describe('Tier 3: positional fallback', () => {
    it('should match sequentially without wrap-around', async () => {
      const file0 = makeFileInfo('agent-0');
      const file1 = makeFileInfo('agent-1');
      mockLocator.locate.mockResolvedValue([file0, file1]);

      // No sourceToolUseId, no matching description
      mockCacheService.getOrParse
        .mockResolvedValueOnce(
          makeSession('agent-0', [
            makeMessage({ role: 'user', content: [{ type: 'text', text: 'first' }] }),
          ]),
        )
        .mockResolvedValueOnce(
          makeSession('agent-1', [
            makeMessage({ role: 'user', content: [{ type: 'text', text: 'second' }] }),
          ]),
        );

      const parent = makeSession('abc123', [
        makeTaskToolCall('toolu_1', 'do task A'),
        makeTaskToolCall('toolu_2', 'do task B'),
      ]);

      const result = await resolver.resolve(parent, parentFilePath, providerName);
      expect(result).toHaveLength(2);
      expect(result[0].matchMethod).toBe('positional');
      expect(result[0].toolCallId).toBe('toolu_1');
      expect(result[1].matchMethod).toBe('positional');
      expect(result[1].toolCallId).toBe('toolu_2');
    });

    it('should not wrap around (more subagents than tasks)', async () => {
      const file0 = makeFileInfo('agent-0');
      const file1 = makeFileInfo('agent-1');
      const file2 = makeFileInfo('agent-2');
      mockLocator.locate.mockResolvedValue([file0, file1, file2]);

      mockCacheService.getOrParse
        .mockResolvedValueOnce(
          makeSession('agent-0', [
            makeMessage({ role: 'user', content: [{ type: 'text', text: 'x' }] }),
          ]),
        )
        .mockResolvedValueOnce(
          makeSession('agent-1', [
            makeMessage({ role: 'user', content: [{ type: 'text', text: 'y' }] }),
          ]),
        )
        .mockResolvedValueOnce(
          makeSession('agent-2', [
            makeMessage({ role: 'user', content: [{ type: 'text', text: 'z' }] }),
          ]),
        );

      const parent = makeSession('abc123', [makeTaskToolCall('toolu_1', 'only task')]);

      const result = await resolver.resolve(parent, parentFilePath, providerName);
      // Only 1 task available, so only 1 match
      expect(result).toHaveLength(1);
      expect(result[0].toolCallId).toBe('toolu_1');
    });
  });

  // -------------------------------------------------------------------------
  // Mixed-tier matching
  // -------------------------------------------------------------------------

  describe('mixed-tier matching', () => {
    it('should use tier 1 first, then fall back to tier 3 for unmatched', async () => {
      const file0 = makeFileInfo('agent-0');
      const file1 = makeFileInfo('agent-1');
      mockLocator.locate.mockResolvedValue([file0, file1]);

      mockCacheService.getOrParse
        .mockResolvedValueOnce(
          makeSession('agent-0', [
            makeMessage({
              role: 'user',
              sourceToolUseId: 'toolu_2',
              content: [{ type: 'text', text: 'second' }],
            }),
          ]),
        )
        .mockResolvedValueOnce(
          makeSession('agent-1', [
            makeMessage({ role: 'user', content: [{ type: 'text', text: 'first' }] }),
          ]),
        );

      const parent = makeSession('abc123', [
        makeTaskToolCall('toolu_1', 'task A'),
        makeTaskToolCall('toolu_2', 'task B'),
      ]);

      const result = await resolver.resolve(parent, parentFilePath, providerName);
      expect(result).toHaveLength(2);

      // agent-0 matched via sourceToolUseId to toolu_2
      const resultMatch = result.find((r) => r.toolCallId === 'toolu_2');
      expect(resultMatch?.matchMethod).toBe('result');

      // agent-1 matched positionally to remaining toolu_1
      const positionalMatch = result.find((r) => r.toolCallId === 'toolu_1');
      expect(positionalMatch?.matchMethod).toBe('positional');
    });
  });

  // -------------------------------------------------------------------------
  // Warmup filtering
  // -------------------------------------------------------------------------

  describe('warmup filtering', () => {
    it('should filter out warmup agents (first user message = "Warmup")', async () => {
      const file0 = makeFileInfo('agent-0');
      const file1 = makeFileInfo('agent-1');
      mockLocator.locate.mockResolvedValue([file0, file1]);

      // agent-0 is warmup
      mockCacheService.getOrParse
        .mockResolvedValueOnce(
          makeSession('agent-0', [
            makeMessage({
              role: 'user',
              content: [{ type: 'text', text: 'Warmup' }],
            }),
          ]),
        )
        .mockResolvedValueOnce(
          makeSession('agent-1', [
            makeMessage({
              role: 'user',
              sourceToolUseId: 'toolu_1',
              content: [{ type: 'text', text: 'real work' }],
            }),
          ]),
        );

      const parent = makeSession('abc123', [makeTaskToolCall('toolu_1', 'do stuff')]);

      const result = await resolver.resolve(parent, parentFilePath, providerName);
      expect(result).toHaveLength(1);
      expect(result[0].toolCallId).toBe('toolu_1');
      // The warmup agent (agent-0) should not appear
      expect(result.every((r) => r.filePath !== file0.filePath)).toBe(true);
    });

    it('should not filter agents with "Warmup" in longer text', async () => {
      const fileInfo = makeFileInfo('agent-0');
      mockLocator.locate.mockResolvedValue([fileInfo]);

      mockCacheService.getOrParse.mockResolvedValue(
        makeSession('agent-0', [
          makeMessage({
            role: 'user',
            sourceToolUseId: 'toolu_1',
            content: [{ type: 'text', text: 'Warmup the cache and then proceed' }],
          }),
        ]),
      );

      const parent = makeSession('abc123', [makeTaskToolCall('toolu_1', 'warm up cache')]);

      const result = await resolver.resolve(parent, parentFilePath, providerName);
      expect(result).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Parallel execution detection
  // -------------------------------------------------------------------------

  describe('parallel execution detection', () => {
    it('should detect parallel execution (>100ms overlap)', async () => {
      const file0 = makeFileInfo('agent-0');
      const file1 = makeFileInfo('agent-1');
      mockLocator.locate.mockResolvedValue([file0, file1]);

      // Overlapping sessions: agent-0 runs 0-500ms, agent-1 runs 200-700ms
      const t0 = new Date('2024-01-01T00:00:00.000Z');
      const t1 = new Date('2024-01-01T00:00:00.200Z');
      const t2 = new Date('2024-01-01T00:00:00.500Z');
      const t3 = new Date('2024-01-01T00:00:00.700Z');

      mockCacheService.getOrParse
        .mockResolvedValueOnce(
          makeSession('agent-0', [
            makeMessage({
              role: 'user',
              timestamp: t0,
              sourceToolUseId: 'toolu_1',
              content: [{ type: 'text', text: 'a' }],
            }),
            makeMessage({ role: 'assistant', timestamp: t2 }),
          ]),
        )
        .mockResolvedValueOnce(
          makeSession('agent-1', [
            makeMessage({
              role: 'user',
              timestamp: t1,
              sourceToolUseId: 'toolu_2',
              content: [{ type: 'text', text: 'b' }],
            }),
            makeMessage({ role: 'assistant', timestamp: t3 }),
          ]),
        );

      const parent = makeSession('abc123', [
        makeTaskToolCall('toolu_1', 'task A'),
        makeTaskToolCall('toolu_2', 'task B'),
      ]);

      const result = await resolver.resolve(parent, parentFilePath, providerName);
      expect(result).toHaveLength(2);
      expect(result[0].isParallel).toBe(true);
      expect(result[1].isParallel).toBe(true);
    });

    it('should not mark as parallel with <100ms overlap', async () => {
      const file0 = makeFileInfo('agent-0');
      const file1 = makeFileInfo('agent-1');
      mockLocator.locate.mockResolvedValue([file0, file1]);

      // Non-overlapping: agent-0 runs 0-100ms, agent-1 starts at 150ms
      const t0 = new Date('2024-01-01T00:00:00.000Z');
      const t1 = new Date('2024-01-01T00:00:00.100Z');
      const t2 = new Date('2024-01-01T00:00:00.150Z');
      const t3 = new Date('2024-01-01T00:00:00.300Z');

      mockCacheService.getOrParse
        .mockResolvedValueOnce(
          makeSession('agent-0', [
            makeMessage({
              role: 'user',
              timestamp: t0,
              sourceToolUseId: 'toolu_1',
              content: [{ type: 'text', text: 'a' }],
            }),
            makeMessage({ role: 'assistant', timestamp: t1 }),
          ]),
        )
        .mockResolvedValueOnce(
          makeSession('agent-1', [
            makeMessage({
              role: 'user',
              timestamp: t2,
              sourceToolUseId: 'toolu_2',
              content: [{ type: 'text', text: 'b' }],
            }),
            makeMessage({ role: 'assistant', timestamp: t3 }),
          ]),
        );

      const parent = makeSession('abc123', [
        makeTaskToolCall('toolu_1', 'task A'),
        makeTaskToolCall('toolu_2', 'task B'),
      ]);

      const result = await resolver.resolve(parent, parentFilePath, providerName);
      expect(result).toHaveLength(2);
      expect(result[0].isParallel).toBe(false);
      expect(result[1].isParallel).toBe(false);
    });

    it('should not mark single process as parallel', async () => {
      const fileInfo = makeFileInfo('agent-0');
      mockLocator.locate.mockResolvedValue([fileInfo]);

      mockCacheService.getOrParse.mockResolvedValue(
        makeSession('agent-0', [
          makeMessage({
            role: 'user',
            sourceToolUseId: 'toolu_1',
            content: [{ type: 'text', text: 'a' }],
          }),
        ]),
      );

      const parent = makeSession('abc123', [makeTaskToolCall('toolu_1', 'task')]);

      const result = await resolver.resolve(parent, parentFilePath, providerName);
      expect(result).toHaveLength(1);
      expect(result[0].isParallel).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Cache key: filePath (not agentId) to avoid cross-parent collisions
  // -------------------------------------------------------------------------

  describe('cache key uses filePath (not agentId)', () => {
    it('should pass filePath as the cache key to getOrParse', async () => {
      const fileInfo = makeFileInfo('agent-0');
      mockLocator.locate.mockResolvedValue([fileInfo]);

      const subSession = makeSession('agent-0', [
        makeMessage({
          role: 'user',
          sourceToolUseId: 'toolu_1',
          content: [{ type: 'text', text: 'work' }],
        }),
      ]);
      mockCacheService.getOrParse.mockResolvedValue(subSession);

      const parent = makeSession('abc123', [makeTaskToolCall('toolu_1', 'task')]);

      await resolver.resolve(parent, parentFilePath, providerName);

      // Cache key (first arg) must be filePath, not agentId
      expect(mockCacheService.getOrParse).toHaveBeenCalledWith(
        fileInfo.filePath,
        fileInfo.filePath,
        expect.anything(),
      );
    });

    it('should use distinct cache keys for same agentId at different file paths', async () => {
      // Simulate two subagents both named "agent-0" but at different paths
      // (e.g., from different parent session directories)
      const file0: SubagentFileInfo = {
        filePath: '/home/user/.claude/projects/proj-a/subagents/agent-0.jsonl',
        agentId: 'agent-0',
        directoryType: 'new',
      };
      const file1: SubagentFileInfo = {
        filePath: '/home/user/.claude/projects/proj-b/subagents/agent-0.jsonl',
        agentId: 'agent-0',
        directoryType: 'new',
      };
      mockLocator.locate.mockResolvedValue([file0, file1]);

      const sessionA = makeSession('agent-0-a', [
        makeMessage({
          role: 'user',
          sourceToolUseId: 'toolu_1',
          content: [{ type: 'text', text: 'task A' }],
        }),
      ]);
      const sessionB = makeSession('agent-0-b', [
        makeMessage({
          role: 'user',
          sourceToolUseId: 'toolu_2',
          content: [{ type: 'text', text: 'task B' }],
        }),
      ]);

      mockCacheService.getOrParse.mockResolvedValueOnce(sessionA).mockResolvedValueOnce(sessionB);

      const parent = makeSession('abc123', [
        makeTaskToolCall('toolu_1', 'first'),
        makeTaskToolCall('toolu_2', 'second'),
      ]);

      const result = await resolver.resolve(parent, parentFilePath, providerName);

      // Both should resolve — distinct cache keys despite same agentId
      expect(result).toHaveLength(2);
      expect(mockCacheService.getOrParse).toHaveBeenCalledTimes(2);

      // First call: proj-a path
      expect(mockCacheService.getOrParse).toHaveBeenNthCalledWith(
        1,
        file0.filePath,
        file0.filePath,
        expect.anything(),
      );
      // Second call: proj-b path
      expect(mockCacheService.getOrParse).toHaveBeenNthCalledWith(
        2,
        file1.filePath,
        file1.filePath,
        expect.anything(),
      );

      // Each process should reference its own session and file
      expect(result[0].session).toBe(sessionA);
      expect(result[0].filePath).toBe(file0.filePath);
      expect(result[1].session).toBe(sessionB);
      expect(result[1].filePath).toBe(file1.filePath);
    });
  });

  // -------------------------------------------------------------------------
  // Graceful error handling
  // -------------------------------------------------------------------------

  describe('graceful error handling', () => {
    it('should skip corrupt subagent files', async () => {
      const file0 = makeFileInfo('agent-0');
      const file1 = makeFileInfo('agent-1');
      mockLocator.locate.mockResolvedValue([file0, file1]);

      // agent-0 fails to parse
      mockCacheService.getOrParse
        .mockRejectedValueOnce(new Error('corrupt JSONL'))
        .mockResolvedValueOnce(
          makeSession('agent-1', [
            makeMessage({
              role: 'user',
              sourceToolUseId: 'toolu_1',
              content: [{ type: 'text', text: 'ok' }],
            }),
          ]),
        );

      const parent = makeSession('abc123', [makeTaskToolCall('toolu_1', 'task')]);

      const result = await resolver.resolve(parent, parentFilePath, providerName);
      expect(result).toHaveLength(1);
      expect(result[0].toolCallId).toBe('toolu_1');
    });

    it('should handle all subagent files failing to parse', async () => {
      mockLocator.locate.mockResolvedValue([makeFileInfo('agent-0')]);
      mockCacheService.getOrParse.mockRejectedValue(new Error('fs error'));

      const parent = makeSession('abc123', [makeTaskToolCall('toolu_1', 'task')]);

      const result = await resolver.resolve(parent, parentFilePath, providerName);
      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Process IDs
  // -------------------------------------------------------------------------

  describe('process IDs', () => {
    it('should assign sequential process IDs', async () => {
      const file0 = makeFileInfo('agent-0');
      const file1 = makeFileInfo('agent-1');
      mockLocator.locate.mockResolvedValue([file0, file1]);

      mockCacheService.getOrParse
        .mockResolvedValueOnce(
          makeSession('agent-0', [
            makeMessage({
              role: 'user',
              sourceToolUseId: 'toolu_1',
              content: [{ type: 'text', text: 'a' }],
            }),
          ]),
        )
        .mockResolvedValueOnce(
          makeSession('agent-1', [
            makeMessage({
              role: 'user',
              sourceToolUseId: 'toolu_2',
              content: [{ type: 'text', text: 'b' }],
            }),
          ]),
        );

      const parent = makeSession('abc123', [
        makeTaskToolCall('toolu_1', 'task A'),
        makeTaskToolCall('toolu_2', 'task B'),
      ]);

      const result = await resolver.resolve(parent, parentFilePath, providerName);
      expect(result[0].id).toBe('process-0');
      expect(result[1].id).toBe('process-1');
    });
  });
});
