import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SessionReaderController } from './session-reader.controller';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { estimateObjectBytes } from '../../metrics/helpers/byte-accounting.helper';
import { MetricsService } from '../../metrics/services/metrics.service';
import type { UnifiedMessage, UnifiedMetrics, UnifiedSession } from '../dtos/unified-session.types';
import type { UnifiedChunk } from '../dtos/unified-chunk.types';
import type {
  SessionReaderService,
  TranscriptSummary,
  UnifiedChunkedResponse,
  TranscriptIndex,
  TranscriptTimingData,
} from '../services/session-reader.service';
import type { CachedTranscriptDto, SessionCacheService } from '../services/session-cache.service';
import { decodeCursor } from '../services/transcript-cursor';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockMetricsService = {
  registerCacheStatsProvider: jest.fn(),
  registerStatsProvider: jest.fn(),
} as never;

const dtoEntries = new Map<string, CachedTranscriptDto>();
let dtoHits = 0;
let dtoMisses = 0;
const mockSessionCacheService = {
  getDto: jest.fn((sessionId: string, maxToolResultLength: number, fingerprint: string) => {
    const entry = dtoEntries.get(sessionId);
    if (
      entry?.maxToolResultLength === maxToolResultLength &&
      entry.enrichmentFingerprint === fingerprint
    ) {
      dtoHits += 1;
      return entry;
    }
    dtoMisses += 1;
    return undefined;
  }),
  setDto: jest.fn((sessionId: string, entry: CachedTranscriptDto) => {
    dtoEntries.set(sessionId, entry);
  }),
  getDtoCacheStats: jest.fn(() => {
    const bytesEstimated = Array.from(dtoEntries.values()).reduce(
      (total, entry) => total + entry.responseBytes,
      0,
    );
    return {
      entries: dtoEntries.size,
      bytesEstimated,
      hits: dtoHits,
      misses: dtoMisses,
      hitRate: dtoHits + dtoMisses > 0 ? dtoHits / (dtoHits + dtoMisses) : 0,
      bytesMethod: 'json-stringify-length' as const,
    };
  }),
  getDtoRetainedRoots: jest.fn(() => Array.from(dtoEntries.values(), (entry) => entry.result)),
};

const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';

function makeMessage(id: string, role: 'user' | 'assistant', tsIso: string): UnifiedMessage {
  return {
    id,
    parentId: null,
    role,
    timestamp: new Date(tsIso),
    content: [{ type: 'text', text: `Message ${id}` }],
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
  };
}

function makeMetrics(overrides?: Partial<UnifiedMetrics>): UnifiedMetrics {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 150,
    totalContextConsumption: 150,
    compactionCount: 0,
    phaseBreakdowns: [],
    visibleContextTokens: 100,
    totalContextTokens: 0,
    contextWindowTokens: 200_000,
    costUsd: 0,
    primaryModel: 'claude-sonnet-4-6',
    durationMs: 5000,
    messageCount: 2,
    isOngoing: false,
    ...overrides,
  };
}

function makeAiChunk(id: string, messages: UnifiedMessage[]): UnifiedChunk {
  return {
    id,
    type: 'ai',
    startTime: messages[0]?.timestamp ?? new Date('2026-01-01T10:00:00.000Z'),
    endTime: messages[messages.length - 1]?.timestamp ?? new Date('2026-01-01T10:00:00.000Z'),
    messages,
    metrics: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 150,
      messageCount: messages.length,
      durationMs: 0,
      costUsd: 0,
    },
    semanticSteps: [
      {
        id: `step-${id}`,
        type: 'output',
        startTime: messages[0]?.timestamp ?? new Date('2026-01-01T10:00:00.000Z'),
        durationMs: 0,
        content: { outputText: 'test output' },
        context: 'main',
      },
    ],
    turns: [],
  };
}

const DEFAULT_TIMING: TranscriptTimingData = {
  resolveMs: 1,
  parseOrCacheHitMs: 10,
  buildChunksMs: 2,
  applyToolResultTruncationMs: 0.5,
  cacheHit: false,
  sourceChangeKind: 'unknown-full-parse',
  fileSizeBytes: 1024,
  fileMtimeMs: 1700000000000,
  sourceVersion: 654_321,
  providerName: 'claude',
};

const mockService: jest.Mocked<
  Pick<
    SessionReaderService,
    | 'getTranscript'
    | 'getTranscriptWithTimings'
    | 'getTranscriptSummary'
    | 'getUnifiedTranscriptChunks'
    | 'getUnifiedTranscriptChunk'
    | 'getTranscriptIndex'
    | 'getTranscriptTail'
    | 'getToolResult'
  >
> = {
  getTranscript: jest.fn(),
  getTranscriptWithTimings: jest.fn(),
  getTranscriptSummary: jest.fn(),
  getUnifiedTranscriptChunks: jest.fn(),
  getUnifiedTranscriptChunk: jest.fn(),
  getTranscriptIndex: jest.fn(),
  getTranscriptTail: jest.fn(),
  getToolResult: jest.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionReaderController', () => {
  let controller: SessionReaderController;

  beforeEach(() => {
    jest.clearAllMocks();
    dtoEntries.clear();
    dtoHits = 0;
    dtoMisses = 0;
    controller = new SessionReaderController(
      mockService as unknown as SessionReaderService,
      mockMetricsService,
      mockSessionCacheService as unknown as SessionCacheService,
    );
  });

  describe('GET /api/sessions/:id/transcript', () => {
    it('counts the real cached DTO serialization graph once with parsed and chunks roots', async () => {
      const metricsService = new MetricsService();
      const controllerWithMetrics = new SessionReaderController(
        mockService as unknown as SessionReaderService,
        metricsService,
        mockSessionCacheService as unknown as SessionCacheService,
      );
      const message = makeMessage('m1', 'assistant', '2026-01-01T10:00:00.000Z');
      const chunks = [makeAiChunk('chunk-0', [message])];
      const session: UnifiedSession = {
        id: 'test',
        providerName: 'claude',
        filePath: '/some/path.jsonl',
        messages: [message],
        chunks,
        metrics: makeMetrics(),
        isOngoing: false,
        warnings: ['shared warning'],
      };
      mockService.getTranscriptWithTimings.mockResolvedValue({
        session,
        timing: DEFAULT_TIMING,
      });
      metricsService.registerCacheStatsProvider(
        'parsed',
        () => ({
          entries: 1,
          bytesEstimated: estimateObjectBytes(session),
          hits: 0,
          misses: 1,
          hitRate: 0,
        }),
        () => [session],
      );
      metricsService.registerCacheStatsProvider(
        'chunks',
        () => ({
          entries: 1,
          bytesEstimated: estimateObjectBytes(chunks),
          hits: 0,
          misses: 1,
          hitRate: 0,
        }),
        () => [chunks],
      );
      controllerWithMetrics.onModuleInit();

      const dtoResult = await controllerWithMetrics.getTranscript(VALID_UUID);
      const independentWalks =
        estimateObjectBytes(session) + estimateObjectBytes(chunks) + estimateObjectBytes(dtoResult);
      const seen = new WeakSet<object>();
      const expectedUniqueBytes =
        estimateObjectBytes(session, seen) +
        estimateObjectBytes(chunks, seen) +
        estimateObjectBytes(dtoResult, seen);

      const snapshot = metricsService.getMetrics();

      expect(expectedUniqueBytes).toBeGreaterThan(0);
      expect(snapshot.caches.aggregate.bytesEstimated).toBe(expectedUniqueBytes);
      expect(snapshot.caches.aggregate.bytesEstimated).toBeLessThan(independentWalks);
      // DTO per-cache view retains its independent wire-size stat
      expect(snapshot.caches.dto.bytesEstimated).toBe(
        Buffer.byteLength(JSON.stringify(dtoResult), 'utf8'),
      );
      expect(snapshot.caches.dto.bytesMethod).toBe('json-stringify-length');
    });

    it('failure isolation: healed provider is re-included after the metrics cache expires', async () => {
      const metricsService = new MetricsService();
      let now = 1_000;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      const controllerWithMetrics = new SessionReaderController(
        mockService as unknown as SessionReaderService,
        metricsService,
        mockSessionCacheService as unknown as SessionCacheService,
      );
      const message = makeMessage('m1', 'assistant', '2026-01-01T10:00:00.000Z');
      const session1: UnifiedSession = {
        id: 'fail-test',
        providerName: 'claude',
        filePath: '/some/path.jsonl',
        messages: [message],
        metrics: makeMetrics(),
        isOngoing: false,
      };
      mockService.getTranscriptWithTimings.mockResolvedValue({
        session: session1,
        timing: DEFAULT_TIMING,
      });

      let parsedShouldFail = true;
      metricsService.registerCacheStatsProvider(
        'parsed',
        () => {
          if (parsedShouldFail) throw new Error('provider unavailable');
          return {
            entries: 1,
            bytesEstimated: 0,
            hits: 0,
            misses: 1,
            hitRate: 0,
            bytesMethod: 'deferred-to-aggregate' as const,
          };
        },
        () => [session1],
      );
      controllerWithMetrics.onModuleInit();

      // Call 1: provider throws → excluded entirely
      const snap1 = metricsService.getMetrics();
      expect(snap1.caches.parsed.entries).toBe(0);
      expect(snap1.caches.parsed.bytesEstimated).toBe(0);
      expect(snap1.caches.aggregate.providersFailed).toBe(1);
      expect(snap1.caches.aggregate.bytesEstimated).toBe(0);

      // Heal the provider
      parsedShouldFail = false;

      // A warm snapshot preserves the original failed-provider attribution.
      const snap2 = metricsService.getMetrics();
      expect(snap2.caches.parsed.entries).toBe(0);
      expect(snap2.caches.aggregate.providersFailed).toBe(1);

      now += 10_000;
      const snap3 = metricsService.getMetrics();
      expect(snap3.caches.parsed.entries).toBe(1);
      expect(snap3.caches.parsed.bytesEstimated).toBeGreaterThan(0);
      expect(snap3.caches.aggregate.providersFailed).toBe(0);
      expect(snap3.caches.aggregate.bytesEstimated).toBe(snap3.caches.parsed.bytesEstimated);
      nowSpy.mockRestore();
    });

    it('should return full session with serialized transcript/chunk/step timestamps', async () => {
      const aiChunk: UnifiedChunk = {
        id: 'chunk-1',
        type: 'ai',
        startTime: new Date('2026-01-01T10:00:01.000Z'),
        endTime: new Date('2026-01-01T10:00:05.000Z'),
        messages: [makeMessage('m2', 'assistant', '2026-01-01T10:00:05.000Z')],
        metrics: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 150,
          messageCount: 1,
          durationMs: 4000,
          costUsd: 0,
        },
        semanticSteps: [
          {
            id: 'step-1',
            type: 'output',
            startTime: new Date('2026-01-01T10:00:05.000Z'),
            durationMs: 0,
            content: { outputText: 'Message m2' },
            context: 'main',
          },
        ],
        turns: [
          {
            id: 'turn-m2',
            assistantMessageId: 'm2',
            model: 'claude-sonnet-4-6',
            timestamp: new Date('2026-01-01T10:00:05.000Z'),
            steps: [
              {
                id: 'turn-step-1',
                type: 'output',
                startTime: new Date('2026-01-01T10:00:05.000Z'),
                durationMs: 0,
                content: { outputText: 'Message m2' },
                context: 'main',
              },
            ],
            summary: {
              thinkingCount: 0,
              toolCallCount: 0,
              subagentCount: 0,
              outputCount: 1,
            },
            durationMs: 0,
          },
        ],
      };

      const session: UnifiedSession = {
        id: 'test',
        providerName: 'claude',
        filePath: '/some/path.jsonl',
        messages: [
          makeMessage('m1', 'user', '2026-01-01T10:00:00.000Z'),
          makeMessage('m2', 'assistant', '2026-01-01T10:00:05.000Z'),
        ],
        chunks: [aiChunk],
        metrics: makeMetrics(),
        isOngoing: false,
      };
      mockService.getTranscriptWithTimings.mockResolvedValue({
        session,
        timing: DEFAULT_TIMING,
      });

      const result = await controller.getTranscript(VALID_UUID);

      expect(result).toBeDefined();
      expect(result!.messages[0].timestamp).toBe('2026-01-01T10:00:00.000Z');
      expect(result!.messages[1].timestamp).toBe('2026-01-01T10:00:05.000Z');
      expect(result!.chunks?.[0].startTime).toBe('2026-01-01T10:00:01.000Z');
      expect(result!.chunks?.[0].endTime).toBe('2026-01-01T10:00:05.000Z');
      expect(result!.chunks?.[0].messages[0].timestamp).toBe('2026-01-01T10:00:05.000Z');
      expect(result!.chunks?.[0].semanticSteps[0].startTime).toBe('2026-01-01T10:00:05.000Z');
      expect(typeof result!.chunks?.[0].startTime).toBe('string');
      expect(typeof result!.chunks?.[0].semanticSteps[0].startTime).toBe('string');
      expect(decodeCursor(result!.cursor)?.fileSize).toBe(654_321);
      expect(mockService.getTranscriptWithTimings).toHaveBeenCalledWith(VALID_UUID, {
        maxToolResultLength: 2000,
      });
    });

    it('should pass maxToolResultLength query to service', async () => {
      const session: UnifiedSession = {
        id: 'test',
        providerName: 'claude',
        filePath: '/some/path.jsonl',
        messages: [makeMessage('m1', 'assistant', '2026-01-01T10:00:00.000Z')],
        metrics: makeMetrics(),
        isOngoing: false,
      };
      mockService.getTranscriptWithTimings.mockResolvedValue({
        session,
        timing: DEFAULT_TIMING,
      });

      await controller.getTranscript(VALID_UUID, '4096');

      expect(mockService.getTranscriptWithTimings).toHaveBeenCalledWith(VALID_UUID, {
        maxToolResultLength: 4096,
      });
    });

    it('should throw BadRequestException for invalid maxToolResultLength', async () => {
      await expect(controller.getTranscript(VALID_UUID, 'abc')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for invalid UUID', async () => {
      await expect(controller.getTranscript('not-a-uuid')).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException when session not found', async () => {
      mockService.getTranscriptWithTimings.mockRejectedValue(
        new NotFoundError('Session', VALID_UUID),
      );

      await expect(controller.getTranscript(VALID_UUID)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for ValidationError', async () => {
      mockService.getTranscriptWithTimings.mockRejectedValue(
        new ValidationError('Session does not have a transcript path'),
      );

      await expect(controller.getTranscript(VALID_UUID)).rejects.toThrow(BadRequestException);
    });

    it('should include warnings in the transcript response when present', async () => {
      const session: UnifiedSession = {
        id: 'test',
        providerName: 'claude',
        filePath: '/some/path.jsonl',
        messages: [makeMessage('m1', 'user', '2026-01-01T10:00:00.000Z')],
        metrics: makeMetrics(),
        isOngoing: false,
        warnings: ['Skipped 2 oversized lines (>10MB each)'],
      };
      mockService.getTranscriptWithTimings.mockResolvedValue({
        session,
        timing: DEFAULT_TIMING,
      });

      const result = await controller.getTranscript(VALID_UUID);

      expect(result).toBeDefined();
      expect(result!.warnings).toEqual(['Skipped 2 oversized lines (>10MB each)']);
    });

    it('should not include warnings field when session has no warnings', async () => {
      const session: UnifiedSession = {
        id: 'test',
        providerName: 'claude',
        filePath: '/some/path.jsonl',
        messages: [makeMessage('m1', 'user', '2026-01-01T10:00:00.000Z')],
        metrics: makeMetrics(),
        isOngoing: false,
      };
      mockService.getTranscriptWithTimings.mockResolvedValue({
        session,
        timing: DEFAULT_TIMING,
      });

      const result = await controller.getTranscript(VALID_UUID);

      expect(result).toBeDefined();
      expect(result!.warnings).toBeUndefined();
    });

    it('should throw UnprocessableEntityException for file-access category errors', async () => {
      mockService.getTranscriptWithTimings.mockRejectedValue(
        new ValidationError('Transcript file does not exist or is not accessible', {
          category: 'file-access',
          path: '/some/path',
        }),
      );

      await expect(controller.getTranscript(VALID_UUID)).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('should throw BadRequestException for ValidationError without file-access category', async () => {
      mockService.getTranscriptWithTimings.mockRejectedValue(
        new ValidationError('Some other validation issue', { someDetail: true }),
      );

      await expect(controller.getTranscript(VALID_UUID)).rejects.toThrow(BadRequestException);
    });

    it('should invalidate DTO cache when contextWindowTokens changes (1M toggle)', async () => {
      const session200k: UnifiedSession = {
        id: 'test',
        providerName: 'claude',
        filePath: '/some/path.jsonl',
        messages: [makeMessage('m1', 'user', '2026-01-01T10:00:00.000Z')],
        metrics: makeMetrics({ contextWindowTokens: 200_000 }),
        isOngoing: false,
      };
      const session1M: UnifiedSession = {
        id: 'test',
        providerName: 'claude',
        filePath: '/some/path.jsonl',
        messages: [makeMessage('m1', 'user', '2026-01-01T10:00:00.000Z')],
        metrics: makeMetrics({ contextWindowTokens: 1_000_000 }),
        isOngoing: false,
      };

      mockService.getTranscriptWithTimings.mockResolvedValueOnce({
        session: session200k,
        timing: DEFAULT_TIMING,
      });
      const result1 = await controller.getTranscript(VALID_UUID);
      expect(result1!.metrics.contextWindowTokens).toBe(200_000);

      mockService.getTranscriptWithTimings.mockResolvedValueOnce({
        session: session1M,
        timing: DEFAULT_TIMING,
      });
      const result2 = await controller.getTranscript(VALID_UUID);
      expect(result2!.metrics.contextWindowTokens).toBe(1_000_000);
    });
  });

  describe('GET /api/sessions/:id/transcript/tool-result/:toolCallId', () => {
    it('should return a full tool result payload', async () => {
      mockService.getToolResult.mockResolvedValue({
        sessionId: VALID_UUID,
        toolCallId: 'tc-1',
        content: 'full tool result content',
        isError: false,
        fullLength: 24,
      });

      const result = await controller.getTranscriptToolResult(VALID_UUID, 'tc-1');

      expect(result).toEqual({
        sessionId: VALID_UUID,
        toolCallId: 'tc-1',
        content: 'full tool result content',
        isError: false,
        fullLength: 24,
      });
      expect(mockService.getToolResult).toHaveBeenCalledWith(VALID_UUID, 'tc-1');
    });

    it('should throw BadRequestException for empty toolCallId', async () => {
      await expect(controller.getTranscriptToolResult(VALID_UUID, '')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('GET /api/sessions/:id/transcript/summary', () => {
    it('should return transcript summary', async () => {
      const summary: TranscriptSummary = {
        sessionId: VALID_UUID,
        providerName: 'claude',
        metrics: makeMetrics(),
        messageCount: 2,
        isOngoing: false,
      };
      mockService.getTranscriptSummary.mockResolvedValue(summary);

      const result = await controller.getTranscriptSummary(VALID_UUID);

      expect(result).toBe(summary);
      expect(mockService.getTranscriptSummary).toHaveBeenCalledWith(VALID_UUID);
      expect(result.metrics.visibleContextTokens).toBe(100);
      expect(result.metrics.totalContextTokens).toBe(0);
      expect(result.metrics.contextWindowTokens).toBe(200_000);
    });

    it('should throw BadRequestException for invalid UUID', async () => {
      await expect(controller.getTranscriptSummary('bad')).rejects.toThrow(BadRequestException);
    });
  });

  describe('GET /api/sessions/:id/transcript/index', () => {
    it('should return transcript index', async () => {
      const index: TranscriptIndex = {
        cursor: 'opaque-cursor',
        totals: { messageCount: 10, chunkCount: 3 },
        chunkIds: ['chunk-0', 'chunk-1', 'chunk-2'],
        latestOutputPreview: 'test output',
        providerName: 'claude',
        isOngoing: false,
      };
      mockService.getTranscriptIndex.mockResolvedValue(index);

      const result = await controller.getTranscriptIndex(VALID_UUID);

      expect(result).toBe(index);
      expect(mockService.getTranscriptIndex).toHaveBeenCalledWith(VALID_UUID);
    });

    it('should throw BadRequestException for invalid UUID', async () => {
      await expect(controller.getTranscriptIndex('bad')).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException when session not found', async () => {
      mockService.getTranscriptIndex.mockRejectedValue(new NotFoundError('Session', VALID_UUID));

      await expect(controller.getTranscriptIndex(VALID_UUID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('GET /api/sessions/:id/transcript/chunks', () => {
    it('should return paginated UnifiedChunks with serialized dates', async () => {
      const msg = makeMessage('m1', 'assistant', '2026-01-01T10:00:00.000Z');
      const response: UnifiedChunkedResponse = {
        chunks: [makeAiChunk('chunk-0', [msg])],
        nextCursor: 'chunk-1',
        prevCursor: null,
        totalCount: 3,
      };
      mockService.getUnifiedTranscriptChunks.mockResolvedValue(response);

      const result = await controller.getTranscriptChunks(VALID_UUID);

      expect(result).toBeDefined();
      expect(result!.chunks[0].messages[0].timestamp).toBe('2026-01-01T10:00:00.000Z');
      expect(result!.chunks[0].startTime).toBe('2026-01-01T10:00:00.000Z');
      expect(result!.nextCursor).toBe('chunk-1');
      expect(result!.prevCursor).toBeNull();
      expect(result!.totalCount).toBe(3);
    });

    it('should pass cursor, limit, and direction to service', async () => {
      mockService.getUnifiedTranscriptChunks.mockResolvedValue({
        chunks: [],
        nextCursor: null,
        prevCursor: null,
        totalCount: 0,
      });

      await controller.getTranscriptChunks(VALID_UUID, 'chunk-5', '10', 'backward');

      expect(mockService.getUnifiedTranscriptChunks).toHaveBeenCalledWith(
        VALID_UUID,
        'chunk-5',
        10,
        'backward',
      );
    });

    it('should default direction to forward', async () => {
      mockService.getUnifiedTranscriptChunks.mockResolvedValue({
        chunks: [],
        nextCursor: null,
        prevCursor: null,
        totalCount: 0,
      });

      await controller.getTranscriptChunks(VALID_UUID);

      expect(mockService.getUnifiedTranscriptChunks).toHaveBeenCalledWith(
        VALID_UUID,
        undefined,
        undefined,
        'forward',
      );
    });

    it('should throw BadRequestException for invalid cursor format', async () => {
      await expect(controller.getTranscriptChunks(VALID_UUID, 'abc')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for invalid direction', async () => {
      await expect(
        controller.getTranscriptChunks(VALID_UUID, undefined, undefined, 'sideways'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('GET /api/sessions/:id/transcript/chunks/:chunkId', () => {
    it('should return a single UnifiedChunk with serialized dates', async () => {
      const msg = makeMessage('m1', 'assistant', '2026-01-01T10:00:05.000Z');
      const chunk = makeAiChunk('chunk-0', [msg]);
      mockService.getUnifiedTranscriptChunk.mockResolvedValue(chunk);

      const result = await controller.getTranscriptChunk(VALID_UUID, 'chunk-0');

      expect(result).toBeDefined();
      expect(result!.messages[0].timestamp).toBe('2026-01-01T10:00:05.000Z');
      expect(result!.startTime).toBe('2026-01-01T10:00:05.000Z');
      expect(result!.semanticSteps[0].startTime).toBe('2026-01-01T10:00:05.000Z');
    });

    it('should throw BadRequestException for invalid chunkId format', async () => {
      await expect(controller.getTranscriptChunk(VALID_UUID, 'invalid')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException for missing chunk', async () => {
      mockService.getUnifiedTranscriptChunk.mockRejectedValue(
        new NotFoundError('TranscriptChunk', 'chunk-99'),
      );

      await expect(controller.getTranscriptChunk(VALID_UUID, 'chunk-99')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('GET /api/sessions/:id/transcript/tail', () => {
    it('serializes a safe delta response', async () => {
      const message = makeMessage('m1', 'assistant', '2026-01-01T10:00:05.000Z');
      mockService.getTranscriptTail.mockResolvedValue({
        kind: 'delta',
        cursor: 'next-cursor',
        replaceFromChunkId: 'chunk-0',
        replaceFromChunkIndex: 0,
        deltaChunks: [makeAiChunk('chunk-0', [message])],
        deltaMessages: [message],
        metrics: makeMetrics({ messageCount: 1 }),
        totalChunkCount: 1,
        totalMessageCount: 1,
      });

      const result = await controller.getTranscriptTail(VALID_UUID, 'prior-cursor');

      expect(result).toMatchObject({
        kind: 'delta',
        cursor: 'next-cursor',
        deltaMessages: [{ timestamp: '2026-01-01T10:00:05.000Z' }],
        deltaChunks: [{ startTime: '2026-01-01T10:00:05.000Z' }],
      });
    });

    it('returns the cursor-free full-refetch discriminator without serializing a delta', async () => {
      mockService.getTranscriptTail.mockResolvedValue({
        kind: 'full-refetch-required',
        sourceChangeKind: 'file-replacement',
      });

      const result = await controller.getTranscriptTail(VALID_UUID, 'prior-cursor');

      expect(result).toEqual({
        kind: 'full-refetch-required',
        sourceChangeKind: 'file-replacement',
      });
      expect(result).not.toHaveProperty('cursor');
      expect(result).not.toHaveProperty('deltaChunks');
    });
  });

  describe('GET /api/sessions/:id/transcript/chunks (limit validation)', () => {
    it('should throw BadRequestException for non-numeric limit', async () => {
      await expect(controller.getTranscriptChunks(VALID_UUID, undefined, 'abc')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for limit=0', async () => {
      await expect(controller.getTranscriptChunks(VALID_UUID, undefined, '0')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for limit exceeding max', async () => {
      await expect(controller.getTranscriptChunks(VALID_UUID, undefined, '101')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should treat empty string limit as undefined (default)', async () => {
      mockService.getUnifiedTranscriptChunks.mockResolvedValue({
        chunks: [],
        nextCursor: null,
        prevCursor: null,
        totalCount: 0,
      });

      await controller.getTranscriptChunks(VALID_UUID, undefined, '');

      expect(mockService.getUnifiedTranscriptChunks).toHaveBeenCalledWith(
        VALID_UUID,
        undefined,
        undefined,
        'forward',
      );
    });
  });
});
