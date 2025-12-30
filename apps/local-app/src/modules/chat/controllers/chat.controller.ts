import { Controller, Get, Post, Param, Body, Query, NotFoundException } from '@nestjs/common';
import { ChatService } from '../services/chat.service';
import { createLogger } from '../../../common/logging/logger';
import {
  CreateDirectThreadSchema,
  CreateGroupThreadSchema,
  ListThreadsQuerySchema,
  CreateMessageSchema,
  ListMessagesQuerySchema,
  type ThreadDto,
  type MessageDto,
  type ThreadsListDto,
  type MessagesListDto,
  InviteThreadMembersSchema,
  ClearThreadHistorySchema,
  PurgeThreadHistorySchema,
} from '../dtos/chat.dto';

const logger = createLogger('ChatController');

@Controller('api/chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  /**
   * List threads
   * GET /api/chat/threads?projectId=xxx&createdByType=agent&limit=50&offset=0
   */
  @Get('threads')
  async listThreads(@Query() query: unknown): Promise<ThreadsListDto> {
    logger.info({ query }, 'GET /api/chat/threads');
    const validatedQuery = ListThreadsQuerySchema.parse(query);
    return this.chatService.listThreads(validatedQuery);
  }

  /**
   * Get a single thread
   * GET /api/chat/threads/:id?projectId=xxx
   */
  @Get('threads/:id')
  async getThread(
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ): Promise<ThreadDto> {
    logger.info({ threadId: id, projectId }, 'GET /api/chat/threads/:id');
    const thread = await this.chatService.getThread(id);
    // Verify thread belongs to the requested project
    if (thread.projectId !== projectId) {
      throw new NotFoundException(`Thread ${id} not found in project ${projectId}`);
    }
    return thread;
  }

  /**
   * Create a direct thread (1:1)
   * POST /api/chat/threads/direct
   */
  @Post('threads/direct')
  async createDirectThread(@Body() body: unknown): Promise<ThreadDto> {
    logger.info('POST /api/chat/threads/direct');
    const data = CreateDirectThreadSchema.parse(body);
    return this.chatService.createDirectThread(data);
  }

  /**
   * Create a group thread
   * POST /api/chat/threads/group
   */
  @Post('threads/group')
  async createGroupThread(@Body() body: unknown): Promise<ThreadDto> {
    logger.info('POST /api/chat/threads/group');
    const data = CreateGroupThreadSchema.parse(body);
    return this.chatService.createGroupThread(data);
  }

  /**
   * List messages in a thread
   * GET /api/chat/threads/:id/messages?projectId=xxx&since=2024-01-01T00:00:00Z&limit=50&offset=0
   */
  @Get('threads/:id/messages')
  async listMessages(
    @Param('id') threadId: string,
    @Query() query: unknown,
  ): Promise<MessagesListDto> {
    logger.info({ threadId, query }, 'GET /api/chat/threads/:id/messages');
    const validatedQuery = ListMessagesQuerySchema.parse(query);
    // Verify thread exists and belongs to the project
    const thread = await this.chatService.getThread(threadId);
    if (validatedQuery.projectId && thread.projectId !== validatedQuery.projectId) {
      throw new NotFoundException(
        `Thread ${threadId} not found in project ${validatedQuery.projectId}`,
      );
    }
    return this.chatService.listMessages(threadId, validatedQuery);
  }

  /**
   * Create a message in a thread
   * POST /api/chat/threads/:id/messages
   */
  @Post('threads/:id/messages')
  async createMessage(@Param('id') threadId: string, @Body() body: unknown): Promise<MessageDto> {
    logger.info({ threadId }, 'POST /api/chat/threads/:id/messages');
    const data = CreateMessageSchema.parse(body);
    return this.chatService.createMessage(threadId, data);
  }

  /**
   * Invite members to an existing thread
   * POST /api/chat/threads/:id/invite
   */
  @Post('threads/:id/invite')
  async inviteMembers(@Param('id') threadId: string, @Body() body: unknown): Promise<ThreadDto> {
    logger.info({ threadId }, 'POST /api/chat/threads/:id/invite');
    const data = InviteThreadMembersSchema.parse(body);
    return this.chatService.inviteMembers(threadId, data);
  }

  /**
   * Clear history for a thread (sets last_user_cleared_at timestamp)
   * POST /api/chat/threads/:id/clear
   */
  @Post('threads/:id/clear')
  async clearHistory(@Param('id') threadId: string, @Body() body: unknown): Promise<ThreadDto> {
    logger.info({ threadId }, 'POST /api/chat/threads/:id/clear');
    const data = ClearThreadHistorySchema.parse(body);
    return this.chatService.clearHistory(threadId, data);
  }

  /**
   * Purge history for a thread by permanently deleting prior messages.
   * POST /api/chat/threads/:id/purge
   */
  @Post('threads/:id/purge')
  async purgeHistory(@Param('id') threadId: string, @Body() body: unknown): Promise<ThreadDto> {
    logger.info({ threadId }, 'POST /api/chat/threads/:id/purge');
    const data = PurgeThreadHistorySchema.parse(body);
    return this.chatService.purgeHistory(threadId, data);
  }
}
