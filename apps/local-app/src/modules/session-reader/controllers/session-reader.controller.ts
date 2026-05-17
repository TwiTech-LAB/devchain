import {
  Controller,
  Get,
  Param,
  Query,
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionReaderService } from '../services/session-reader.service';
import { encodeCursor } from '../services/transcript-cursor';
import { DEFAULT_MAX_TOOL_RESULT_LENGTH } from '../services/transcript-truncation';
import {
  serializeChunk as serializeChunkToWire,
  serializeMessage as serializeMessageToWire,
} from '../services/transcript-serialization';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { UnifiedSession } from '../dtos/unified-session.types';

const logger = createLogger('SessionReaderController');

// ---------------------------------------------------------------------------
// Zod schemas for route/query param validation
// ---------------------------------------------------------------------------

const SessionIdParamSchema = z.string().uuid('Session ID must be a valid UUID');
const ToolCallIdParamSchema = z.string().min(1, 'toolCallId is required');

/** Shared limit schema — reused by both /chunks and /chunks/:chunkId endpoints.
 *  Empty string ("") treated as absent (undefined); non-numeric strings rejected with 400. */
const LimitSchema = z.union([
  z.literal('').transform(() => undefined),
  z
    .string()
    .regex(/^\d+$/, 'limit must be a positive integer')
    .transform((val) => parseInt(val, 10))
    .pipe(
      z.number().int().min(1, 'limit must be at least 1').max(100, 'limit must be at most 100'),
    ),
]);

const ChunksQuerySchema = z.object({
  cursor: z
    .string()
    .regex(/^chunk-\d+$/, 'cursor must match format "chunk-N"')
    .optional(),
  limit: LimitSchema.optional(),
  direction: z.enum(['forward', 'backward']).optional(),
});

const ChunkIdParamSchema = z.string().regex(/^chunk-\d+$/, 'chunkId must match format "chunk-N"');

const TranscriptQuerySchema = z.object({
  maxToolResultLength: z
    .union([
      z.literal('').transform(() => undefined),
      z
        .string()
        .regex(/^\d+$/, 'maxToolResultLength must be a positive integer')
        .transform((val) => parseInt(val, 10))
        .pipe(z.number().int().min(1, 'maxToolResultLength must be at least 1')),
    ])
    .optional(),
});

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

const DTO_CACHE_MAX_ENTRIES = 20;

interface DtoCacheEntry {
  result: Record<string, unknown>;
  responseBytes: number;
  lastSize: number;
  lastMtime: number;
  maxToolResultLength: number;
  enrichmentFingerprint: string;
}

function enrichmentFingerprint(session: UnifiedSession): string {
  return `${session.providerName}:${session.metrics.contextWindowTokens ?? 0}`;
}

@Controller('api/sessions')
export class SessionReaderController {
  private readonly dtoCache = new Map<string, DtoCacheEntry>();

  constructor(private readonly sessionReaderService: SessionReaderService) {}

  /**
   * GET /api/sessions/:id/transcript
   * Returns full parsed session (messages + metrics).
   */
  @Get(':id/transcript')
  async getTranscript(@Param('id') id: string, @Query('maxToolResultLength') maxLen?: string) {
    logger.info({ sessionId: id, maxToolResultLength: maxLen }, 'GET /api/sessions/:id/transcript');

    const sessionId = this.validateSessionId(id);

    try {
      const query = TranscriptQuerySchema.parse({ maxToolResultLength: maxLen });
      const maxToolResultLength = query.maxToolResultLength ?? DEFAULT_MAX_TOOL_RESULT_LENGTH;
      const tTotal = performance.now();

      const { session, timing } = await this.sessionReaderService.getTranscriptWithTimings(
        sessionId,
        { maxToolResultLength },
      );

      const fingerprint = enrichmentFingerprint(session);
      const dtoCached = this.dtoCache.get(sessionId);
      if (
        dtoCached &&
        dtoCached.lastSize === timing.fileSizeBytes &&
        dtoCached.lastMtime === timing.fileMtimeMs &&
        dtoCached.maxToolResultLength === maxToolResultLength &&
        dtoCached.enrichmentFingerprint === fingerprint
      ) {
        const totalMs = performance.now() - tTotal;
        logger.info(
          {
            sessionId,
            provider: timing.providerName,
            durationMs: {
              resolve: round2(timing.resolveMs),
              parseOrCacheHit: round2(timing.parseOrCacheHitMs),
              buildChunks: round2(timing.buildChunksMs),
              applyToolResultTruncation: round2(timing.applyToolResultTruncationMs),
              serializeTranscript: 0,
              total: round2(totalMs),
            },
            cacheHit: timing.cacheHit,
            dtoCacheHit: true,
            fileSizeBytes: timing.fileSizeBytes,
            responseBytes: dtoCached.responseBytes,
            messageCount: session.messages.length,
            chunkCount: (session.chunks ?? []).length,
            semanticStepCount: 0,
            truncationApplied: false,
          },
          'transcript.timing',
        );
        return dtoCached.result;
      }

      const tSerialize = performance.now();
      const chunks = session.chunks ?? [];
      const cursor = encodeCursor(timing.fileSizeBytes, session.messages.length, chunks.length);
      const result = { ...this.serializeTranscript(session), cursor };
      const serializeTranscriptMs = performance.now() - tSerialize;

      const serializedJson = JSON.stringify(result);
      const responseBytes = Buffer.byteLength(serializedJson, 'utf8');
      const totalMs = performance.now() - tTotal;

      this.dtoCache.set(sessionId, {
        result: result as Record<string, unknown>,
        responseBytes,
        lastSize: timing.fileSizeBytes,
        lastMtime: timing.fileMtimeMs,
        maxToolResultLength,
        enrichmentFingerprint: fingerprint,
      });
      if (this.dtoCache.size > DTO_CACHE_MAX_ENTRIES) {
        const oldest = this.dtoCache.keys().next().value;
        if (oldest !== undefined) this.dtoCache.delete(oldest);
      }

      const semanticStepCount = chunks.reduce((sum, chunk) => {
        if (chunk.type === 'ai' && 'semanticSteps' in chunk) {
          return sum + chunk.semanticSteps.length;
        }
        return sum;
      }, 0);

      const truncationApplied = session.messages.some((m) =>
        m.toolResults.some((tr) => tr.isTruncated),
      );

      logger.info(
        {
          sessionId,
          provider: timing.providerName,
          durationMs: {
            resolve: round2(timing.resolveMs),
            parseOrCacheHit: round2(timing.parseOrCacheHitMs),
            buildChunks: round2(timing.buildChunksMs),
            applyToolResultTruncation: round2(timing.applyToolResultTruncationMs),
            serializeTranscript: round2(serializeTranscriptMs),
            total: round2(totalMs),
          },
          cacheHit: timing.cacheHit,
          dtoCacheHit: false,
          fileSizeBytes: timing.fileSizeBytes,
          responseBytes,
          messageCount: session.messages.length,
          chunkCount: chunks.length,
          semanticStepCount,
          truncationApplied,
        },
        'transcript.timing',
      );

      return result;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new BadRequestException(error.errors.map((e) => e.message).join(', '));
      }
      this.handleServiceError(error);
    }
  }

  /**
   * GET /api/sessions/:id/transcript/summary
   * Returns metrics only.
   */
  @Get(':id/transcript/summary')
  async getTranscriptSummary(@Param('id') id: string) {
    logger.info({ sessionId: id }, 'GET /api/sessions/:id/transcript/summary');

    const sessionId = this.validateSessionId(id);

    try {
      return await this.sessionReaderService.getTranscriptSummary(sessionId);
    } catch (error) {
      this.handleServiceError(error);
    }
  }

  /**
   * GET /api/sessions/:id/transcript/index
   * Returns lightweight metadata for initial-load summary + virtualizer total count.
   */
  @Get(':id/transcript/index')
  async getTranscriptIndex(@Param('id') id: string) {
    logger.info({ sessionId: id }, 'GET /api/sessions/:id/transcript/index');

    const sessionId = this.validateSessionId(id);

    try {
      return await this.sessionReaderService.getTranscriptIndex(sessionId);
    } catch (error) {
      this.handleServiceError(error);
    }
  }

  /**
   * GET /api/sessions/:id/transcript/chunks
   * Returns paginated UnifiedChunk[] with cursor-stable chunk IDs.
   */
  @Get(':id/transcript/chunks')
  async getTranscriptChunks(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('direction') direction?: string,
  ) {
    logger.info(
      { sessionId: id, cursor, limit, direction },
      'GET /api/sessions/:id/transcript/chunks',
    );

    const sessionId = this.validateSessionId(id);

    try {
      const query = ChunksQuerySchema.parse({ cursor, limit, direction });
      const response = await this.sessionReaderService.getUnifiedTranscriptChunks(
        sessionId,
        query.cursor,
        query.limit,
        (query.direction as 'forward' | 'backward') ?? 'forward',
      );

      return {
        ...response,
        chunks: response.chunks.map((chunk) => serializeChunkToWire(chunk)),
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new BadRequestException(error.errors.map((e) => e.message).join(', '));
      }
      this.handleServiceError(error);
    }
  }

  /**
   * GET /api/sessions/:id/transcript/chunks/:chunkId
   * Returns a single UnifiedChunk by chunk ID.
   */
  @Get(':id/transcript/chunks/:chunkId')
  async getTranscriptChunk(@Param('id') id: string, @Param('chunkId') chunkId: string) {
    logger.info({ sessionId: id, chunkId }, 'GET /api/sessions/:id/transcript/chunks/:chunkId');

    const sessionId = this.validateSessionId(id);

    try {
      ChunkIdParamSchema.parse(chunkId);
      const chunk = await this.sessionReaderService.getUnifiedTranscriptChunk(sessionId, chunkId);
      return serializeChunkToWire(chunk);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new BadRequestException(error.errors.map((e) => e.message).join(', '));
      }
      this.handleServiceError(error);
    }
  }

  /**
   * GET /api/sessions/:id/transcript/tail?since=<cursor>
   * Returns chunks and messages after the cursor position.
   * Used for cursor-mismatch recovery in the WS push-delta protocol.
   */
  @Get(':id/transcript/tail')
  async getTranscriptTail(@Param('id') id: string, @Query('since') since?: string) {
    logger.info({ sessionId: id, since }, 'GET /api/sessions/:id/transcript/tail');

    const sessionId = this.validateSessionId(id);

    if (!since) {
      throw new BadRequestException('Query parameter "since" is required');
    }

    try {
      const result = await this.sessionReaderService.getTranscriptTail(sessionId, since);

      if (result === null) {
        throw new NotFoundException('Cursor expired — full transcript fetch required');
      }

      return {
        ...result,
        deltaChunks: result.deltaChunks.map((chunk) => serializeChunkToWire(chunk)),
        deltaMessages: result.deltaMessages.map((msg) => serializeMessageToWire(msg)),
      };
    } catch (error) {
      this.handleServiceError(error);
    }
  }

  /**
   * GET /api/sessions/:id/transcript/tool-result/:toolCallId
   * Returns the full, untruncated tool result for a specific tool call.
   */
  @Get(':id/transcript/tool-result/:toolCallId')
  async getTranscriptToolResult(@Param('id') id: string, @Param('toolCallId') toolCallId: string) {
    logger.info(
      { sessionId: id, toolCallId },
      'GET /api/sessions/:id/transcript/tool-result/:toolCallId',
    );

    const sessionId = this.validateSessionId(id);

    try {
      const parsedToolCallId = ToolCallIdParamSchema.parse(toolCallId);
      return await this.sessionReaderService.getToolResult(sessionId, parsedToolCallId);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new BadRequestException(error.errors.map((e) => e.message).join(', '));
      }
      this.handleServiceError(error);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private validateSessionId(id: string): string {
    const result = SessionIdParamSchema.safeParse(id);
    if (!result.success) {
      throw new BadRequestException('Session ID must be a valid UUID');
    }
    return result.data;
  }

  /**
   * Map domain exceptions to HTTP exceptions.
   */
  private handleServiceError(error: unknown): never {
    if (error instanceof NotFoundException) {
      throw error;
    }
    if (error instanceof NotFoundError) {
      throw new NotFoundException(error.message);
    }
    if (error instanceof ValidationError) {
      if (error.details?.category === 'file-access') {
        throw new UnprocessableEntityException(error.message);
      }
      throw new BadRequestException(error.message);
    }
    throw error;
  }

  private serializeTranscript(session: UnifiedSession) {
    return {
      ...session,
      messages: session.messages.map(serializeMessageToWire),
      chunks: session.chunks?.map(serializeChunkToWire),
    };
  }
}

function round2(ms: number): number {
  return Math.round(ms * 100) / 100;
}
