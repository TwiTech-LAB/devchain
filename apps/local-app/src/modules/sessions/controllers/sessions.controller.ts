import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  Param,
  Query,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionsService } from '../services/sessions.service';
import {
  SessionsMessagePoolService,
  type MessageLogEntry,
  type PoolDetails,
} from '../services/sessions-message-pool.service';
import {
  LaunchSessionSchema,
  SessionDetailDto,
  SessionDto,
  AgentPresenceResponseDto,
} from '../dtos/sessions.dto';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('SessionsController');

/** Query params for GET /messages */
const MessagesQuerySchema = z.object({
  projectId: z.string().uuid('projectId must be a valid UUID').optional(),
  agentId: z.string().uuid('agentId must be a valid UUID').optional(),
  status: z.enum(['queued', 'delivered', 'failed']).optional(),
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

/** Query params for GET /sessions and GET /sessions/agents/presence */
const ProjectIdQuerySchema = z.object({
  projectId: z.string().uuid('projectId must be a valid UUID').optional(),
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
  status: 'queued' | 'delivered' | 'failed';
  batchId?: string;
  deliveredAt?: number;
  error?: string;
  immediate: boolean;
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
  ) {}

  /**
   * Launch a new session
   */
  @Post('launch')
  async launchSession(@Body() body: unknown): Promise<SessionDetailDto> {
    logger.info('POST /api/sessions/launch');
    const data = LaunchSessionSchema.parse(body);
    return this.sessionsService.launchSession(data);
  }

  /**
   * Terminate a session
   */
  @Delete(':id')
  async terminateSession(@Param('id') id: string): Promise<{ message: string }> {
    logger.info({ sessionId: id }, 'DELETE /api/sessions/:id');
    await this.sessionsService.terminateSession(id);
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

  /**
   * Get session by ID
   */
  @Get(':id')
  getSession(@Param('id') id: string): SessionDto | null {
    logger.info({ sessionId: id }, 'GET /api/sessions/:id');
    return this.sessionsService.getSession(id);
  }
}
