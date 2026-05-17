import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SessionReaderController } from './session-reader.controller';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import type { UnifiedMessage, UnifiedMetrics, UnifiedSession } from '../dtos/unified-session.types';
import type { UnifiedChunk } from '../dtos/unified-chunk.types';
import type {
  SessionReaderService,
  TranscriptSummary,
  UnifiedChunkedResponse,
  TranscriptIndex,
  TranscriptTimingData,
} from '../services/session-reader.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
  fileSizeBytes: 1024,
  fileMtimeMs: 1700000000000,
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
    | 'getToolResult'
  >
> = {
  getTranscript: jest.fn(),
  getTranscriptWithTimings: jest.fn(),
  getTranscriptSummary: jest.fn(),
  getUnifiedTranscriptChunks: jest.fn(),
  getUnifiedTranscriptChunk: jest.fn(),
  getTranscriptIndex: jest.fn(),
  getToolResult: jest.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionReaderController', () => {
  let controller: SessionReaderController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new SessionReaderController(mockService as unknown as SessionReaderService);
  });

  describe('GET /api/sessions/:id/transcript', () => {
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
