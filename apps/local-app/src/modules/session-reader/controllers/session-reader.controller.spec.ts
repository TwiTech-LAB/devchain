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
  ChunkedTranscriptResponse,
  TranscriptChunk,
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

const mockService: jest.Mocked<
  Pick<
    SessionReaderService,
    | 'getTranscript'
    | 'getTranscriptSummary'
    | 'getTranscriptChunks'
    | 'getTranscriptChunk'
    | 'getToolResult'
  >
> = {
  getTranscript: jest.fn(),
  getTranscriptSummary: jest.fn(),
  getTranscriptChunks: jest.fn(),
  getTranscriptChunk: jest.fn(),
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
      mockService.getTranscript.mockResolvedValue(session);

      const result = await controller.getTranscript(VALID_UUID);

      expect(result).toBeDefined();
      expect(result!.messages[0].timestamp).toBe('2026-01-01T10:00:00.000Z');
      expect(result!.messages[1].timestamp).toBe('2026-01-01T10:00:05.000Z');
      expect(result!.chunks?.[0].startTime).toBe('2026-01-01T10:00:01.000Z');
      expect(result!.chunks?.[0].endTime).toBe('2026-01-01T10:00:05.000Z');
      expect(result!.chunks?.[0].messages[0].timestamp).toBe('2026-01-01T10:00:05.000Z');
      expect(result!.chunks?.[0].semanticSteps[0].startTime).toBe('2026-01-01T10:00:05.000Z');
      expect(result!.chunks?.[0].turns?.[0].timestamp).toBe('2026-01-01T10:00:05.000Z');
      expect(result!.chunks?.[0].turns?.[0].steps[0].startTime).toBe('2026-01-01T10:00:05.000Z');
      expect(typeof result!.chunks?.[0].startTime).toBe('string');
      expect(typeof result!.chunks?.[0].semanticSteps[0].startTime).toBe('string');
      expect(typeof result!.chunks?.[0].turns?.[0].timestamp).toBe('string');
      expect(typeof result!.chunks?.[0].turns?.[0].steps[0].startTime).toBe('string');
      expect(mockService.getTranscript).toHaveBeenCalledWith(VALID_UUID, {
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
      mockService.getTranscript.mockResolvedValue(session);

      await controller.getTranscript(VALID_UUID, '4096');

      expect(mockService.getTranscript).toHaveBeenCalledWith(VALID_UUID, {
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
      mockService.getTranscript.mockRejectedValue(new NotFoundError('Session', VALID_UUID));

      await expect(controller.getTranscript(VALID_UUID)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for ValidationError', async () => {
      mockService.getTranscript.mockRejectedValue(
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
      mockService.getTranscript.mockResolvedValue(session);

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
      mockService.getTranscript.mockResolvedValue(session);

      const result = await controller.getTranscript(VALID_UUID);

      expect(result).toBeDefined();
      expect(result!.warnings).toBeUndefined();
    });

    it('should throw UnprocessableEntityException for file-access category errors', async () => {
      mockService.getTranscript.mockRejectedValue(
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
      mockService.getTranscript.mockRejectedValue(
        new ValidationError('Some other validation issue', { someDetail: true }),
      );

      await expect(controller.getTranscript(VALID_UUID)).rejects.toThrow(BadRequestException);
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

  describe('GET /api/sessions/:id/transcript/chunks', () => {
    it('should return paginated chunks with ISO timestamps', async () => {
      const response: ChunkedTranscriptResponse = {
        chunks: [
          {
            chunkId: 'chunk-0',
            index: 0,
            messages: [makeMessage('m1', 'user', '2026-01-01T10:00:00.000Z')],
            messageCount: 1,
            startTimestamp: '2026-01-01T10:00:00.000Z',
            endTimestamp: '2026-01-01T10:00:00.000Z',
          },
        ],
        nextCursor: '1',
        hasMore: true,
        totalChunks: 3,
      };
      mockService.getTranscriptChunks.mockResolvedValue(response);

      const result = await controller.getTranscriptChunks(VALID_UUID, undefined, undefined);

      expect(result).toBeDefined();
      expect(result!.chunks[0].messages[0].timestamp).toBe('2026-01-01T10:00:00.000Z');
      expect(result!.hasMore).toBe(true);
    });

    it('should pass cursor and limit to service', async () => {
      mockService.getTranscriptChunks.mockResolvedValue({
        chunks: [],
        nextCursor: null,
        hasMore: false,
        totalChunks: 0,
      });

      await controller.getTranscriptChunks(VALID_UUID, '5', '10');

      expect(mockService.getTranscriptChunks).toHaveBeenCalledWith(VALID_UUID, '5', 10);
    });

    it('should throw BadRequestException for invalid cursor format', async () => {
      await expect(controller.getTranscriptChunks(VALID_UUID, 'abc', undefined)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('GET /api/sessions/:id/transcript/chunks/:chunkId', () => {
    it('should return a single chunk with ISO timestamps', async () => {
      const chunk: TranscriptChunk = {
        chunkId: 'chunk-0',
        index: 0,
        messages: [makeMessage('m1', 'user', '2026-01-01T10:00:00.000Z')],
        messageCount: 1,
        startTimestamp: '2026-01-01T10:00:00.000Z',
        endTimestamp: '2026-01-01T10:00:00.000Z',
      };
      mockService.getTranscriptChunk.mockResolvedValue(chunk);

      const result = await controller.getTranscriptChunk(VALID_UUID, 'chunk-0');

      expect(result).toBeDefined();
      expect(result!.messages[0].timestamp).toBe('2026-01-01T10:00:00.000Z');
    });

    it('should throw BadRequestException for invalid chunkId format', async () => {
      await expect(controller.getTranscriptChunk(VALID_UUID, 'invalid')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException for missing chunk', async () => {
      mockService.getTranscriptChunk.mockRejectedValue(
        new NotFoundError('TranscriptChunk', 'chunk-99'),
      );

      await expect(controller.getTranscriptChunk(VALID_UUID, 'chunk-99')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should pass valid limit to service', async () => {
      const chunk: TranscriptChunk = {
        chunkId: 'chunk-0',
        index: 0,
        messages: [makeMessage('m1', 'user', '2026-01-01T10:00:00.000Z')],
        messageCount: 1,
        startTimestamp: '2026-01-01T10:00:00.000Z',
        endTimestamp: '2026-01-01T10:00:00.000Z',
      };
      mockService.getTranscriptChunk.mockResolvedValue(chunk);

      await controller.getTranscriptChunk(VALID_UUID, 'chunk-0', '50');

      expect(mockService.getTranscriptChunk).toHaveBeenCalledWith(VALID_UUID, 'chunk-0', 50);
    });

    it('should pass undefined limit when not provided', async () => {
      const chunk: TranscriptChunk = {
        chunkId: 'chunk-0',
        index: 0,
        messages: [],
        messageCount: 0,
        startTimestamp: null,
        endTimestamp: null,
      };
      mockService.getTranscriptChunk.mockResolvedValue(chunk);

      await controller.getTranscriptChunk(VALID_UUID, 'chunk-0');

      expect(mockService.getTranscriptChunk).toHaveBeenCalledWith(VALID_UUID, 'chunk-0', undefined);
    });

    it('should throw BadRequestException for non-numeric limit', async () => {
      await expect(controller.getTranscriptChunk(VALID_UUID, 'chunk-0', 'abc')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for limit=0', async () => {
      await expect(controller.getTranscriptChunk(VALID_UUID, 'chunk-0', '0')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for limit exceeding max', async () => {
      await expect(controller.getTranscriptChunk(VALID_UUID, 'chunk-0', '101')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should treat empty string limit as undefined (default)', async () => {
      const chunk: TranscriptChunk = {
        chunkId: 'chunk-0',
        index: 0,
        messages: [],
        messageCount: 0,
        startTimestamp: null,
        endTimestamp: null,
      };
      mockService.getTranscriptChunk.mockResolvedValue(chunk);

      await controller.getTranscriptChunk(VALID_UUID, 'chunk-0', '');

      expect(mockService.getTranscriptChunk).toHaveBeenCalledWith(VALID_UUID, 'chunk-0', undefined);
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
      mockService.getTranscriptChunks.mockResolvedValue({
        chunks: [],
        nextCursor: null,
        hasMore: false,
        totalChunks: 0,
      });

      await controller.getTranscriptChunks(VALID_UUID, undefined, '');

      expect(mockService.getTranscriptChunks).toHaveBeenCalledWith(
        VALID_UUID,
        undefined,
        undefined,
      );
    });
  });
});
