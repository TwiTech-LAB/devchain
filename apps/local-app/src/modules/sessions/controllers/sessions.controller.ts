import {
  Controller,
  Post,
  Patch,
  Delete,
  Get,
  Inject,
  Body,
  Param,
  Query,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionsService } from '../services/sessions.service';
import { SessionRuntime } from '../services/session-runtime';
import {
  SessionsMessagePoolService,
  type ForceDeferredResult,
  type MessageLogEntry,
  type PoolDetails,
} from '../services/sessions-message-pool.service';
import {
  LaunchSessionSchema,
  RestoreSessionSchema,
  SessionDetailDto,
  SessionDto,
  AgentPresenceResponseDto,
  SessionHistoryResponseDto,
} from '../dtos/sessions.dto';
import { STORAGE_SERVICE, StorageService } from '../../storage/interfaces/storage.interface';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('SessionsController');

/** Query params for GET /messages */
const MessagesQuerySchema = z.object({
  projectId: z.string().uuid('projectId must be a valid UUID').optional(),
  agentId: z.string().uuid('agentId must be a valid UUID').optional(),
  status: z.enum(['queued', 'delivered', 'failed', 'unconfirmed']).optional(),
  source: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return 100; // Default
      const num = parseInt(val, 10);
      if (isNaN(num) || num < 1) return 100;
      return Math.min(num, 500); // Max 500
    }),
});

/** Query params for GET /pools */
const PoolsQuerySchema = z.object({
  projectId: z.string().uuid('projectId must be a valid UUID').optional(),
});

const ReleaseHumanHoldSchema = z.object({
  projectId: z.string().uuid('projectId must be a valid UUID'),
});

const ForceDeferredSchema = z.object({
  projectId: z.string().uuid('projectId must be a valid UUID'),
  sessionId: z.string().uuid('sessionId must be a valid UUID'),
  messageIds: z.array(z.string().uuid('Each messageId must be a valid UUID')).min(1),
});

/** Query params for GET /sessions and GET /sessions/agents/presence */
const ProjectIdQuerySchema = z.object({
  projectId: z.string().uuid('projectId must be a valid UUID').optional(),
});

/** Body schema for PATCH /sessions/:id (rename) */
const RenameSessionSchema = z.object({
  projectId: z.string().uuid('projectId must be a valid UUID'),
  name: z.string().trim().max(120).nullable(),
});

/** Query params for DELETE /sessions/:id/record */
const DeleteRecordQuerySchema = z.object({
  projectId: z.string().uuid('projectId must be a valid UUID'),
});

/** Query params for GET /sessions/agents/:agentId/history */
const AgentHistoryQuerySchema = z.object({
  projectId: z.string().uuid('projectId must be a valid UUID'),
  cursor: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return 20;
      const num = parseInt(val, 10);
      if (isNaN(num) || num < 1) return 20;
      return Math.min(num, 100);
    }),
});

/** Preview of a message log entry (omits full text for list performance) */
interface MessageLogPreview {
  id: string;
  timestamp: number;
  projectId: string;
  agentId: string;
  agentName: string;
  /** First 100 characters of message text */
  preview: string;
  source: string;
  senderAgentId?: string;
  status: 'queued' | 'delivered' | 'failed' | 'unconfirmed';
  batchId?: string;
  deliveredAt?: number;
  error?: string;
  immediate: boolean;
  nonce?: string;
  confirmedAt?: number;
  retryCount?: number;
  failureCode?: string;
}

/** Response type for messages list endpoint */
interface MessagesResponse {
  messages: MessageLogPreview[];
  total: number;
}

/** Response type for single message endpoint */
interface MessageDetailResponse {
  message: MessageLogEntry;
}

/** Response type for pools endpoint */
interface PoolsResponse {
  pools: PoolDetails[];
}

@Controller('api/sessions')
export class SessionsController {
  constructor(
    private readonly sessionsService: SessionsService,
    private readonly messagePoolService: SessionsMessagePoolService,
    private readonly sessionRuntime: SessionRuntime,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  /**
   * Launch a new session
   */
  @Post('launch')
  async launchSession(@Body() body: unknown): Promise<SessionDetailDto> {
    logger.info('POST /api/sessions/launch');
    const data = LaunchSessionSchema.parse(body);
    return this.sessionRuntime.launch(data);
  }

  /**
   * Rename a session.
   */
  @Patch(':id')
  async renameSession(@Param('id') id: string, @Body() body: unknown): Promise<SessionDto> {
    logger.info({ sessionId: id }, 'PATCH /api/sessions/:id');

    const parsed = RenameSessionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.errors.map((e) => e.message).join(', '));
    }

    // Shared ownership guard (NotFound / Forbidden) — same helper the cloud-tunnel
    // chat.renameSession RPC uses, so the two transports cannot drift.
    await this.sessionsService.validateSessionInProject(id, parsed.data.projectId);

    return this.sessionsService.updateName(id, parsed.data.name);
  }

  /**
   * Delete a session history record (DB row only — transcript files stay on disk).
   * MUST be declared before DELETE ':id' to avoid route shadowing.
   */
  @Delete(':id/record')
  async deleteSessionRecord(
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
  ): Promise<{ deleted: boolean }> {
    logger.info({ sessionId: id }, 'DELETE /api/sessions/:id/record');

    const query = DeleteRecordQuerySchema.safeParse({ projectId });
    if (!query.success) {
      throw new BadRequestException(query.error.errors.map((e) => e.message).join(', '));
    }

    // Shared ownership guard (NotFound / Forbidden) — same helper the cloud-tunnel
    // chat.deleteSessionRecord RPC uses. Running-status check layered on top.
    const session = await this.sessionsService.validateSessionInProject(id, query.data.projectId);

    if (session.status === 'running') {
      throw new ConflictException('STATUS_RUNNING');
    }

    return this.sessionsService.hardDeleteRecord(id);
  }

  /**
   * Terminate a session
   */
  @Delete(':id')
  async terminateSession(@Param('id') id: string): Promise<{ message: string }> {
    logger.info({ sessionId: id }, 'DELETE /api/sessions/:id');
    await this.sessionsService.terminateSession(id, {
      source: 'web-api',
      reason: 'user-requested',
    });
    return { message: 'Session terminated successfully' };
  }

  /**
   * List all active sessions
   */
  @Get()
  async listActiveSessions(@Query('projectId') projectId?: string): Promise<SessionDto[]> {
    logger.info({ projectId }, 'GET /api/sessions');

    try {
      const query = ProjectIdQuerySchema.parse({ projectId });
      return this.sessionsService.listActiveSessions(query.projectId);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new BadRequestException(error.errors.map((e) => e.message).join(', '));
      }
      throw error;
    }
  }

  /**
   * Get agent presence (online status and session ID)
   */
  @Get('agents/presence')
  async getAgentPresence(
    @Query('projectId') projectId?: string,
  ): Promise<AgentPresenceResponseDto> {
    logger.info({ projectId }, 'GET /api/sessions/agents/presence');

    try {
      const query = ProjectIdQuerySchema.parse({ projectId });
      const presenceMap = await this.sessionsService.getAgentPresence(query.projectId);
      const response: AgentPresenceResponseDto = {};

      for (const [agentId, presence] of presenceMap.entries()) {
        response[agentId] = presence;
      }

      return response;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new BadRequestException(error.errors.map((e) => e.message).join(', '));
      }
      throw error;
    }
  }

  /**
   * Get message activity log (previews only)
   * Supports filtering by projectId, agentId, status, source
   * Returns newest messages first with text truncated to 100 chars
   * Use GET /messages/:id for full message content
   */
  @Get('messages')
  getMessages(
    @Query('projectId') projectId?: string,
    @Query('agentId') agentId?: string,
    @Query('status') status?: string,
    @Query('source') source?: string,
    @Query('limit') limit?: string,
  ): MessagesResponse {
    logger.info({ projectId, agentId, status, source, limit }, 'GET /api/sessions/messages');

    try {
      const query = MessagesQuerySchema.parse({
        projectId,
        agentId,
        status: status?.toLowerCase(),
        source,
        limit,
      });

      // Get all messages matching filters (without limit) to get total count
      const allMessages = this.messagePoolService.getMessageLog({
        projectId: query.projectId,
        agentId: query.agentId,
        status: query.status,
        source: query.source,
      });

      // Apply limit for response
      const limitedMessages = allMessages.slice(0, query.limit);

      // Convert to previews (truncate text to 100 chars for performance)
      const PREVIEW_LENGTH = 100;
      const messages: MessageLogPreview[] = limitedMessages.map((msg) => ({
        id: msg.id,
        timestamp: msg.timestamp,
        projectId: msg.projectId,
        agentId: msg.agentId,
        agentName: msg.agentName,
        preview:
          msg.text.length > PREVIEW_LENGTH ? msg.text.slice(0, PREVIEW_LENGTH) + '...' : msg.text,
        source: msg.source,
        senderAgentId: msg.senderAgentId,
        status: msg.status,
        batchId: msg.batchId,
        deliveredAt: msg.deliveredAt,
        error: msg.error,
        immediate: msg.immediate,
        nonce: msg.nonce,
        confirmedAt: msg.confirmedAt,
        retryCount: msg.retryCount,
        failureCode: msg.failureCode,
      }));

      return {
        messages,
        total: allMessages.length,
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new BadRequestException(error.errors.map((e) => e.message).join(', '));
      }
      throw error;
    }
  }

  /**
   * Get a single message by ID with full content
   */
  @Get('messages/:id')
  getMessage(@Param('id') id: string): MessageDetailResponse {
    logger.info({ messageId: id }, 'GET /api/sessions/messages/:id');

    // Validate UUID format
    const uuidSchema = z.string().uuid('Message ID must be a valid UUID');
    const parseResult = uuidSchema.safeParse(id);
    if (!parseResult.success) {
      throw new BadRequestException('Message ID must be a valid UUID');
    }

    const message = this.messagePoolService.getMessageById(id);
    if (!message) {
      throw new NotFoundException(`Message with ID ${id} not found`);
    }

    return { message };
  }

  /**
   * Get current message pool details
   * Shows pending messages per agent with previews
   */
  @Get('pools')
  getPools(@Query('projectId') projectId?: string): PoolsResponse {
    logger.info({ projectId }, 'GET /api/sessions/pools');

    try {
      const query = PoolsQuerySchema.parse({ projectId });
      const pools = this.messagePoolService.getPoolDetails(query.projectId);
      return { pools };
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new BadRequestException(error.errors.map((e) => e.message).join(', '));
      }
      throw error;
    }
  }

  @Post('pools/:agentId/release-human-hold')
  async releaseHumanHold(
    @Param('agentId') agentId: string,
    @Body() body: unknown,
  ): Promise<{ released: true }> {
    const parsedAgentId = z.string().uuid('agentId must be a valid UUID').safeParse(agentId);
    const parsedBody = ReleaseHumanHoldSchema.safeParse(body);
    if (!parsedAgentId.success || !parsedBody.success) {
      const errors = [
        ...(parsedAgentId.success ? [] : parsedAgentId.error.errors),
        ...(parsedBody.success ? [] : parsedBody.error.errors),
      ];
      throw new BadRequestException(errors.map((error) => error.message).join(', '));
    }

    const result = await this.messagePoolService.releaseHumanHeldMessages(
      parsedAgentId.data,
      parsedBody.data.projectId,
    );
    if (result.status === 'not_found') {
      throw new NotFoundException('No human-held messages exist for this agent and project');
    }
    if (result.status === 'not_ready') {
      throw new ConflictException('Human input must remain idle for 30 seconds before release');
    }
    return { released: true };
  }

  @Post('pools/:agentId/force-deferred')
  async forceDeferred(
    @Param('agentId') agentId: string,
    @Body() body: unknown,
  ): Promise<Exclude<ForceDeferredResult, { status: 'not_found' | 'conflict' }>> {
    const parsedAgentId = z.string().uuid('agentId must be a valid UUID').safeParse(agentId);
    const parsedBody = ForceDeferredSchema.safeParse(body);
    if (!parsedAgentId.success || !parsedBody.success) {
      const errors = [
        ...(parsedAgentId.success ? [] : parsedAgentId.error.errors),
        ...(parsedBody.success ? [] : parsedBody.error.errors),
      ];
      throw new BadRequestException(errors.map((error) => error.message).join(', '));
    }

    const result = await this.messagePoolService.forceDeferredDelivery(
      parsedAgentId.data,
      parsedBody.data.projectId,
      parsedBody.data.sessionId,
      parsedBody.data.messageIds,
    );
    if (result.status === 'not_found') {
      throw new NotFoundException('No eligible deferred messages found for this agent and session');
    }
    if (result.status === 'conflict') {
      throw new ConflictException(result.reason);
    }
    return result;
  }

  /**
   * Get paginated history of stopped/failed sessions for an agent.
   * MUST remain declared before @Get(':id') — NestJS evaluates routes in declaration order.
   */
  @Get('agents/:agentId/history')
  async getAgentSessionHistory(
    @Param('agentId') agentId: string,
    @Query('projectId') projectId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<SessionHistoryResponseDto> {
    logger.info({ agentId }, 'GET /api/sessions/agents/:agentId/history');

    try {
      const query = AgentHistoryQuerySchema.parse({ projectId, cursor, limit });
      return this.sessionsService.getAgentSessionHistory(
        agentId,
        query.projectId,
        query.cursor,
        query.limit,
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new BadRequestException(error.errors.map((e) => e.message).join(', '));
      }
      if (error instanceof ForbiddenException) {
        throw error;
      }
      throw error;
    }
  }

  /**
   * Restore a previously stopped/failed session.
   * MUST remain declared before @Get(':id') — NestJS evaluates routes in declaration order.
   */
  @Post(':id/restore')
  async restoreSession(@Param('id') id: string, @Body() body: unknown): Promise<SessionDetailDto> {
    logger.info({ sessionId: id }, 'POST /api/sessions/:id/restore');

    const parsed = RestoreSessionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.errors.map((e) => e.message).join(', '));
    }

    return this.sessionRuntime.restore(id, parsed.data.projectId);
  }

  /**
   * Get session by ID
   */
  @Get(':id')
  getSession(@Param('id') id: string): SessionDto | null {
    logger.info({ sessionId: id }, 'GET /api/sessions/:id');
    return this.sessionsService.getSession(id);
  }
}
