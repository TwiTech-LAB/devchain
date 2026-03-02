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
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { UnifiedMessage, UnifiedSession } from '../dtos/unified-session.types';
import type { UnifiedChunk, UnifiedSemanticStep, UnifiedTurn } from '../dtos/unified-chunk.types';

const logger = createLogger('SessionReaderController');

// ---------------------------------------------------------------------------
// Zod schemas for route/query param validation
// ---------------------------------------------------------------------------

const SessionIdParamSchema = z.string().uuid('Session ID must be a valid UUID');
const ToolCallIdParamSchema = z.string().min(1, 'toolCallId is required');
const DEFAULT_MAX_TOOL_RESULT_LENGTH = 2_000;

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
  cursor: z.string().regex(/^\d+$/, 'cursor must be a non-negative integer').optional(),
  limit: LimitSchema.optional(),
});

const ChunkIdParamSchema = z.string().regex(/^chunk-\d+$/, 'chunkId must match format "chunk-N"');

const ChunkIdQuerySchema = z.object({
  limit: LimitSchema.optional(),
});

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

@Controller('api/sessions')
export class SessionReaderController {
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
      const session = await this.sessionReaderService.getTranscript(sessionId, {
        maxToolResultLength: query.maxToolResultLength ?? DEFAULT_MAX_TOOL_RESULT_LENGTH,
      });

      return this.serializeTranscript(session);
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
   * GET /api/sessions/:id/transcript/chunks
   * Returns paginated chunks with cursor-based pagination.
   */
  @Get(':id/transcript/chunks')
  async getTranscriptChunks(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    logger.info({ sessionId: id, cursor, limit }, 'GET /api/sessions/:id/transcript/chunks');

    const sessionId = this.validateSessionId(id);

    try {
      const query = ChunksQuerySchema.parse({ cursor, limit });
      const response = await this.sessionReaderService.getTranscriptChunks(
        sessionId,
        query.cursor,
        query.limit,
      );

      // Serialize Date objects in chunk messages
      return {
        ...response,
        chunks: response.chunks.map((chunk) => ({
          ...chunk,
          messages: chunk.messages.map((msg) => ({
            ...msg,
            timestamp: msg.timestamp.toISOString(),
          })),
        })),
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
   * Returns a single chunk with messages.
   */
  @Get(':id/transcript/chunks/:chunkId')
  async getTranscriptChunk(
    @Param('id') id: string,
    @Param('chunkId') chunkId: string,
    @Query('limit') limit?: string,
  ) {
    logger.info({ sessionId: id, chunkId }, 'GET /api/sessions/:id/transcript/chunks/:chunkId');

    const sessionId = this.validateSessionId(id);

    try {
      ChunkIdParamSchema.parse(chunkId);
      const query = ChunkIdQuerySchema.parse({ limit });

      const chunk = await this.sessionReaderService.getTranscriptChunk(
        sessionId,
        chunkId,
        query.limit,
      );

      return {
        ...chunk,
        messages: chunk.messages.map((msg) => ({
          ...msg,
          timestamp: msg.timestamp.toISOString(),
        })),
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new BadRequestException(error.errors.map((e) => e.message).join(', '));
      }
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
      messages: session.messages.map((message) => this.serializeMessage(message)),
      chunks: session.chunks?.map((chunk) => this.serializeChunk(chunk)),
    };
  }

  private serializeMessage(message: UnifiedMessage) {
    return {
      ...message,
      timestamp: message.timestamp.toISOString(),
    };
  }

  private serializeSemanticStep(step: UnifiedSemanticStep) {
    return {
      ...step,
      startTime: step.startTime.toISOString(),
    };
  }

  private serializeTurn(turn: UnifiedTurn) {
    return {
      ...turn,
      timestamp: turn.timestamp.toISOString(),
      steps: turn.steps.map((step) => this.serializeSemanticStep(step)),
    };
  }

  private serializeChunk(chunk: UnifiedChunk) {
    const base = {
      ...chunk,
      startTime: chunk.startTime.toISOString(),
      endTime: chunk.endTime.toISOString(),
      messages: chunk.messages.map((message) => this.serializeMessage(message)),
    };

    if (chunk.type !== 'ai') {
      return base;
    }

    return {
      ...base,
      semanticSteps: chunk.semanticSteps.map((step) => this.serializeSemanticStep(step)),
      turns: chunk.turns.map((turn) => this.serializeTurn(turn)),
    };
  }
}
