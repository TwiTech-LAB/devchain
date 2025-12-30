import { Injectable, Inject, NotFoundException, forwardRef } from '@nestjs/common';
import { ValidationError } from '../../../common/errors/error-types';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, and, inArray, desc, gt } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { createLogger } from '../../../common/logging/logger';
import {
  chatThreads,
  chatMembers,
  chatMessages,
  chatMessageTargets,
  chatThreadSessionInvites,
  chatActivities,
  agents as agentsTable,
} from '../../storage/db/schema';
import type {
  CreateDirectThreadDto,
  CreateGroupThreadDto,
  ListThreadsQueryDto,
  CreateMessageDto,
  ListMessagesQueryDto,
  ThreadDto,
  MessageDto,
  ThreadsListDto,
  MessagesListDto,
  InviteThreadMembersDto,
  ClearThreadHistoryDto,
  PurgeThreadHistoryDto,
} from '../dtos/chat.dto';
import { ChatSettingsService } from './chat-settings.service';
import { renderInviteTemplate } from './invite-template.util';
import { SessionsService } from '../../sessions/services/sessions.service';

const logger = createLogger('ChatService');
const DEFAULT_INVITER_NAME = 'You';

@Injectable()
export class ChatService {
  constructor(
    @Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database,
    private readonly eventEmitter: EventEmitter2,
    private readonly chatSettingsService: ChatSettingsService,
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService: SessionsService,
  ) {
    logger.info('ChatService initialized');
  }

  private deriveThreadTitle(thread: ThreadDto, participantNames: string): string {
    if (thread.title && thread.title.trim().length > 0) {
      return thread.title;
    }
    return participantNames || 'Chat Thread';
  }

  /**
   * Send invite/welcome message to an agent in a thread
   */
  private async sendInviteMessage(
    threadId: string,
    projectId: string,
    agentName: string,
    threadTitle: string,
    participantNames: string,
    inviterName: string = DEFAULT_INVITER_NAME,
  ): Promise<void> {
    const inviteTemplate = await this.chatSettingsService.getInviteTemplate(projectId);
    const inviteMessageId = randomUUID();
    const messageTimestamp = new Date().toISOString();

    const renderedTemplate = renderInviteTemplate(inviteTemplate, {
      threadId,
      threadTitle,
      inviterName,
      participantNames,
      invitedAgentName: agentName,
      createdAt: messageTimestamp,
      messageId: inviteMessageId,
    });

    await this.persistMessage(threadId, {
      messageId: inviteMessageId,
      authorType: 'system',
      content: renderedTemplate,
      createdAt: messageTimestamp,
    });
  }

  private async persistMessage(
    threadId: string,
    data: {
      messageId?: string;
      authorType: 'user' | 'agent' | 'system';
      authorAgentId?: string | null;
      content: string;
      targets?: string[];
      createdAt?: string;
    },
  ): Promise<MessageDto> {
    const createdAt = data.createdAt ?? new Date().toISOString();
    const messageId = data.messageId ?? randomUUID();
    const effectiveTargets =
      data.authorType === 'user' && data.targets && data.targets.length > 0 ? data.targets : [];

    await this.db.insert(chatMessages).values({
      id: messageId,
      threadId,
      authorType: data.authorType,
      authorAgentId: data.authorAgentId ?? null,
      content: data.content,
      createdAt,
    });

    if (effectiveTargets.length > 0) {
      const targetValues = effectiveTargets.map((agentId) => ({
        id: randomUUID(),
        messageId,
        agentId,
        createdAt,
      }));
      await this.db.insert(chatMessageTargets).values(targetValues);
    }

    await this.db
      .update(chatThreads)
      .set({ updatedAt: createdAt })
      .where(eq(chatThreads.id, threadId));

    const message: MessageDto = {
      id: messageId,
      threadId,
      authorType: data.authorType,
      authorAgentId: data.authorAgentId ?? null,
      content: data.content,
      targets: effectiveTargets.length > 0 ? effectiveTargets : undefined,
      createdAt,
    };

    try {
      this.eventEmitter.emit('chat.message.created', {
        threadId,
        message,
      });
    } catch (error) {
      logger.warn({ error, threadId, messageId }, 'Failed to emit chat.message.created event');
    }

    return message;
  }

  /**
   * List threads with optional filtering
   */
  async listThreads(query: ListThreadsQueryDto): Promise<ThreadsListDto> {
    const { projectId, createdByType, limit, offset } = query;

    const conditions = [eq(chatThreads.projectId, projectId)];
    if (createdByType) {
      conditions.push(eq(chatThreads.createdByType, createdByType));
    }

    const whereClause = and(...conditions);

    // Get threads
    const threads = await this.db
      .select()
      .from(chatThreads)
      .where(whereClause)
      .orderBy(desc(chatThreads.updatedAt))
      .limit(limit)
      .offset(offset);

    // Get total count
    const countResult = await this.db
      .select({ count: chatThreads.id })
      .from(chatThreads)
      .where(whereClause);
    const total = countResult.length;

    // Get members for each thread
    const threadIds = threads.map((t) => t.id);
    const membersRows =
      threadIds.length > 0
        ? await this.db.select().from(chatMembers).where(inArray(chatMembers.threadId, threadIds))
        : [];

    const membersByThread = new Map<string, string[]>();
    for (const row of membersRows) {
      if (!membersByThread.has(row.threadId)) {
        membersByThread.set(row.threadId, []);
      }
      membersByThread.get(row.threadId)!.push(row.agentId);
    }

    const items: ThreadDto[] = threads.map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      isGroup: thread.isGroup,
      createdByType: thread.createdByType as 'user' | 'agent' | 'system',
      createdByUserId: thread.createdByUserId,
      createdByAgentId: thread.createdByAgentId,
      members: membersByThread.get(thread.id) ?? [],
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    }));

    return {
      items,
      total,
      limit,
      offset,
    };
  }

  /**
   * Get a single thread by ID
   */
  async getThread(threadId: string): Promise<ThreadDto> {
    const thread = await this.db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .limit(1);

    if (thread.length === 0) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }

    const members = await this.db
      .select()
      .from(chatMembers)
      .where(eq(chatMembers.threadId, threadId));

    return {
      id: thread[0].id,
      projectId: thread[0].projectId,
      title: thread[0].title,
      isGroup: thread[0].isGroup,
      createdByType: thread[0].createdByType as 'user' | 'agent' | 'system',
      createdByUserId: thread[0].createdByUserId,
      createdByAgentId: thread[0].createdByAgentId,
      members: members.map((m) => m.agentId),
      createdAt: thread[0].createdAt,
      updatedAt: thread[0].updatedAt,
    };
  }

  /**
   * Create a direct thread (1:1 between user and agent)
   */
  async createDirectThread(data: CreateDirectThreadDto): Promise<ThreadDto> {
    const now = new Date().toISOString();
    const threadId = randomUUID();

    // Check if direct thread already exists for this project and agent
    const existingThreads = await this.db
      .select()
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.projectId, data.projectId),
          eq(chatThreads.isGroup, false),
          eq(chatThreads.createdByType, 'user'),
        ),
      );

    for (const thread of existingThreads) {
      const members = await this.db
        .select()
        .from(chatMembers)
        .where(eq(chatMembers.threadId, thread.id));

      if (members.length === 1 && members[0].agentId === data.agentId) {
        // Thread already exists, return it
        return this.getThread(thread.id);
      }
    }

    // Create new thread
    await this.db.insert(chatThreads).values({
      id: threadId,
      projectId: data.projectId,
      title: null,
      isGroup: false,
      createdByType: 'user',
      createdByUserId: null,
      createdByAgentId: null,
      createdAt: now,
      updatedAt: now,
    });

    // Add agent as member
    await this.db.insert(chatMembers).values({
      threadId,
      agentId: data.agentId,
      createdAt: now,
    });

    // Get agent details and send welcome message
    const agentRow = await this.db
      .select({
        id: agentsTable.id,
        name: agentsTable.name,
      })
      .from(agentsTable)
      .where(eq(agentsTable.id, data.agentId))
      .limit(1);

    if (agentRow.length > 0) {
      const agent = agentRow[0];
      await this.sendInviteMessage(threadId, data.projectId, agent.name, agent.name, agent.name);
    }

    logger.info({ threadId, agentId: data.agentId }, 'Created direct thread');

    return this.getThread(threadId);
  }

  /**
   * Create a group thread
   */
  async createGroupThread(data: CreateGroupThreadDto): Promise<ThreadDto> {
    const now = new Date().toISOString();
    const threadId = randomUUID();

    if (data.agentIds.length < 2) {
      throw new ValidationError('Group threads require at least 2 agents', {
        provided: data.agentIds.length,
        required: 2,
      });
    }

    // Create thread
    await this.db.insert(chatThreads).values({
      id: threadId,
      projectId: data.projectId,
      title: data.title ?? null,
      isGroup: true,
      createdByType: data.createdByType ?? 'user',
      createdByUserId: null,
      createdByAgentId: data.createdByAgentId ?? null,
      createdAt: now,
      updatedAt: now,
    });

    // Add members
    const memberValues = data.agentIds.map((agentId) => ({
      threadId,
      agentId,
      createdAt: now,
    }));
    await this.db.insert(chatMembers).values(memberValues);

    logger.info({ threadId, agentIds: data.agentIds, title: data.title }, 'Created group thread');

    return this.getThread(threadId);
  }

  /**
   * Invite additional members to an existing group thread.
   * Creates a system message per invited agent and posts the configured invite template.
   */
  async inviteMembers(threadId: string, data: InviteThreadMembersDto): Promise<ThreadDto> {
    const thread = await this.getThread(threadId);

    if (data.projectId && thread.projectId !== data.projectId) {
      throw new ValidationError('Thread does not belong to the specified project', {
        threadId,
        threadProjectId: thread.projectId,
        requestedProjectId: data.projectId,
      });
    }

    if (!thread.isGroup || thread.createdByType !== 'user') {
      throw new ValidationError('Invites are only supported for user-created group threads', {
        threadId,
        isGroup: thread.isGroup,
        createdByType: thread.createdByType,
      });
    }

    const uniqueAgentIds = Array.from(new Set(data.agentIds));
    if (uniqueAgentIds.length === 0) {
      throw new ValidationError('At least one agent must be specified for invitation', {
        threadId,
      });
    }

    const existingMembers = new Set(thread.members ?? []);
    const agentIdsToAdd = uniqueAgentIds.filter((agentId) => !existingMembers.has(agentId));

    if (agentIdsToAdd.length === 0) {
      throw new ValidationError('All selected agents are already participants in this thread', {
        threadId,
        requestedAgents: uniqueAgentIds,
      });
    }

    const inviterName = data.inviterName?.trim().length
      ? data.inviterName.trim()
      : DEFAULT_INVITER_NAME;

    const memberIdsToFetch = Array.from(new Set([...existingMembers, ...agentIdsToAdd]));

    const agentRows =
      memberIdsToFetch.length > 0
        ? await this.db
            .select({
              id: agentsTable.id,
              projectId: agentsTable.projectId,
              name: agentsTable.name,
            })
            .from(agentsTable)
            .where(inArray(agentsTable.id, memberIdsToFetch))
        : [];

    const agentMap = new Map(agentRows.map((row) => [row.id, row]));

    const missingAgents = agentIdsToAdd.filter((agentId) => !agentMap.has(agentId));
    if (missingAgents.length > 0) {
      throw new ValidationError(
        `Agents not found: ${missingAgents
          .map((id) => id.slice(0, 8))
          .join(', ')}. Please verify the selection.`,
        {
          threadId,
          missingAgents,
        },
      );
    }

    const crossProjectAgents = agentIdsToAdd.filter(
      (agentId) => agentMap.get(agentId)!.projectId !== thread.projectId,
    );
    if (crossProjectAgents.length > 0) {
      throw new ValidationError(
        'One or more selected agents belong to a different project and cannot be invited.',
        {
          threadId,
          threadProjectId: thread.projectId,
          crossProjectAgents,
        },
      );
    }

    const membershipInsertedAt = new Date().toISOString();
    await this.db.insert(chatMembers).values(
      agentIdsToAdd.map((agentId) => ({
        threadId,
        agentId,
        createdAt: membershipInsertedAt,
      })),
    );

    agentIdsToAdd.forEach((agentId) => existingMembers.add(agentId));

    const participantNamesList = Array.from(existingMembers)
      .map((agentId) => agentMap.get(agentId)?.name)
      .filter((name): name is string => Boolean(name))
      .sort((a, b) => a.localeCompare(b));
    const participantNames =
      participantNamesList.length > 0
        ? participantNamesList.join(', ')
        : 'Participants unavailable';

    const threadTitle = this.deriveThreadTitle(thread, participantNames);

    for (const agentId of agentIdsToAdd) {
      const invitedAgent = agentMap.get(agentId)!;
      const messageTimestamp = new Date().toISOString();

      await this.persistMessage(threadId, {
        authorType: 'system',
        content: `You invited ${invitedAgent.name}.`,
        createdAt: messageTimestamp,
      });

      await this.sendInviteMessage(
        threadId,
        thread.projectId,
        invitedAgent.name,
        threadTitle,
        participantNames,
        inviterName,
      );
    }

    logger.info(
      { threadId, invitedAgents: agentIdsToAdd, inviterName },
      'Invited agents to chat thread',
    );

    return this.getThread(threadId);
  }

  /**
   * List agent-initiated threads
   */
  async listAgentInitiatedThreads(query: ListThreadsQueryDto): Promise<ThreadsListDto> {
    return this.listThreads({
      ...query,
      createdByType: 'agent',
    });
  }

  /**
   * List messages in a thread
   */
  async listMessages(threadId: string, query: ListMessagesQueryDto): Promise<MessagesListDto> {
    let { since } = query;
    const { limit, offset } = query;

    // Get the raw thread data to access lastUserClearedAt
    const threadRows = await this.db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .limit(1);

    // If no explicit 'since' provided, use last_user_cleared_at as default (if present)
    if (!since && threadRows.length > 0 && threadRows[0].lastUserClearedAt) {
      since = threadRows[0].lastUserClearedAt;
      logger.debug(
        { threadId, defaultSince: since },
        'Using lastUserClearedAt as default since filter',
      );
    }

    const conditions = [eq(chatMessages.threadId, threadId)];
    if (since) {
      conditions.push(gt(chatMessages.createdAt, since));
    }

    const whereClause = and(...conditions);

    // Get messages
    const messages = await this.db
      .select()
      .from(chatMessages)
      .where(whereClause)
      .orderBy(chatMessages.createdAt)
      .limit(limit)
      .offset(offset);

    // Get total count
    const countResult = await this.db
      .select({ count: chatMessages.id })
      .from(chatMessages)
      .where(whereClause);
    const total = countResult.length;

    // Get targets for each message
    const messageIds = messages.map((m) => m.id);
    const targetsRows =
      messageIds.length > 0
        ? await this.db
            .select()
            .from(chatMessageTargets)
            .where(inArray(chatMessageTargets.messageId, messageIds))
        : [];

    const targetsByMessage = new Map<string, string[]>();
    for (const row of targetsRows) {
      if (!targetsByMessage.has(row.messageId)) {
        targetsByMessage.set(row.messageId, []);
      }
      targetsByMessage.get(row.messageId)!.push(row.agentId);
    }

    const items: MessageDto[] = messages.map((message) => ({
      id: message.id,
      threadId: message.threadId,
      authorType: message.authorType as 'user' | 'agent' | 'system',
      authorAgentId: message.authorAgentId,
      content: message.content,
      targets: targetsByMessage.get(message.id),
      createdAt: message.createdAt,
    }));

    return {
      items,
      total,
      limit,
      offset,
    };
  }

  /**
   * Check and send session-aware invites for targeted agents with active sessions
   */
  private async ensureSessionInvites(
    threadId: string,
    projectId: string,
    targetedAgentIds: string[],
  ): Promise<void> {
    if (targetedAgentIds.length === 0) {
      return;
    }

    // Get active sessions for the project
    const activeSessions = await this.sessionsService.listActiveSessions(projectId);
    const sessionsByAgent = new Map<string, string>();
    for (const session of activeSessions) {
      if (session.agentId && session.tmuxSessionId) {
        sessionsByAgent.set(session.agentId, session.tmuxSessionId);
      }
    }

    // For each targeted agent with an active session, ensure invite exists
    for (const agentId of targetedAgentIds) {
      const sessionId = sessionsByAgent.get(agentId);
      if (!sessionId) {
        continue; // Agent has no active session, skip
      }

      // Check if invite already exists for this (thread, agent, session)
      const existingInvites = await this.db
        .select()
        .from(chatThreadSessionInvites)
        .where(
          and(
            eq(chatThreadSessionInvites.threadId, threadId),
            eq(chatThreadSessionInvites.agentId, agentId),
            eq(chatThreadSessionInvites.sessionId, sessionId),
          ),
        )
        .limit(1);

      if (existingInvites.length > 0) {
        logger.debug(
          { threadId, agentId, sessionId },
          'Invite already exists for this session, skipping',
        );
        continue; // Invite already sent for this session
      }

      // Get agent details
      const agentRows = await this.db
        .select({ name: agentsTable.name })
        .from(agentsTable)
        .where(eq(agentsTable.id, agentId))
        .limit(1);

      if (agentRows.length === 0) {
        logger.warn({ agentId }, 'Agent not found, skipping invite');
        continue;
      }

      const agentName = agentRows[0].name;

      // Get thread details for invite template
      const threadRows = await this.db
        .select()
        .from(chatThreads)
        .where(eq(chatThreads.id, threadId))
        .limit(1);

      if (threadRows.length === 0) {
        logger.warn({ threadId }, 'Thread not found during invite creation');
        continue;
      }

      // Get all members for participant names
      const membersRows = await this.db
        .select()
        .from(chatMembers)
        .where(eq(chatMembers.threadId, threadId));

      const memberAgentIds = membersRows.map((m) => m.agentId);
      const memberAgents = await this.db
        .select({ id: agentsTable.id, name: agentsTable.name })
        .from(agentsTable)
        .where(inArray(agentsTable.id, memberAgentIds));

      const participantNames = memberAgents
        .map((a) => a.name)
        .sort()
        .join(', ');
      const threadTitle = this.deriveThreadTitle(
        { ...threadRows[0], members: memberAgentIds } as ThreadDto,
        participantNames,
      );

      // Create invite message
      const inviteTemplate = await this.chatSettingsService.getInviteTemplate(projectId);
      const inviteMessageId = randomUUID();
      const messageTimestamp = new Date().toISOString();

      const renderedTemplate = renderInviteTemplate(inviteTemplate, {
        threadId,
        threadTitle,
        inviterName: DEFAULT_INVITER_NAME,
        participantNames,
        invitedAgentName: agentName,
        createdAt: messageTimestamp,
        messageId: inviteMessageId,
      });

      try {
        // Persist invite message
        await this.persistMessage(threadId, {
          messageId: inviteMessageId,
          authorType: 'system',
          content: renderedTemplate,
          createdAt: messageTimestamp,
        });

        // Store invite record
        await this.db.insert(chatThreadSessionInvites).values({
          id: randomUUID(),
          threadId,
          agentId,
          sessionId,
          inviteMessageId,
          sentAt: messageTimestamp,
          acknowledgedAt: null,
        });

        logger.info({ threadId, agentId, sessionId, inviteMessageId }, 'Sent session-aware invite');
      } catch (error) {
        // Handle unique constraint violation idempotently
        if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
          logger.debug(
            { threadId, agentId, sessionId },
            'Invite already exists (race condition), continuing',
          );
        } else {
          logger.error({ error, threadId, agentId, sessionId }, 'Failed to create session invite');
          throw error;
        }
      }
    }
  }

  /**
   * Create a message in a thread
   */
  async createMessage(threadId: string, data: CreateMessageDto): Promise<MessageDto> {
    // Verify thread exists
    const thread = await this.getThread(threadId);

    if (data.projectId && thread.projectId !== data.projectId) {
      throw new ValidationError('Thread does not belong to the specified project', {
        threadId,
        threadProjectId: thread.projectId,
        requestedProjectId: data.projectId,
      });
    }

    if (data.authorType === 'system') {
      throw new ValidationError('System messages cannot be posted via the public API', {
        threadId,
        authorType: data.authorType,
      });
    }

    logger.info(
      {
        threadId,
        authorType: data.authorType,
        hasTargets: Boolean(data.targets && data.targets.length > 0),
      },
      'Creating chat message',
    );

    // Compute targeted agents (explicit targets or all thread members)
    const targetedAgentIds =
      data.authorType === 'user' && data.targets && data.targets.length > 0
        ? data.targets
        : (thread.members ?? []);

    // Ensure session-aware invites are sent before the user message
    await this.ensureSessionInvites(threadId, thread.projectId, targetedAgentIds);

    // Then deliver the authored message
    return this.persistMessage(threadId, data);
  }

  /**
   * Clear history for a thread by setting last_user_cleared_at timestamp.
   * Optionally inserts a system message announcing the clear.
   */
  async clearHistory(threadId: string, data: ClearThreadHistoryDto): Promise<ThreadDto> {
    // Verify thread exists
    await this.getThread(threadId);

    const now = new Date().toISOString();

    // Update last_user_cleared_at timestamp
    await this.db
      .update(chatThreads)
      .set({ lastUserClearedAt: now, updatedAt: now })
      .where(eq(chatThreads.id, threadId));

    // If announce is true, insert system message
    if (data.announce) {
      await this.persistMessage(threadId, {
        authorType: 'system',
        content: 'History cleared.',
        createdAt: now,
      });
    }

    logger.info({ threadId, announce: data.announce }, 'Cleared thread history');

    return this.getThread(threadId);
  }

  /**
   * Purge history by permanently deleting messages (and cascaded relations) prior to a cutoff.
   * Optionally inserts a system message divider after purge.
   */
  async purgeHistory(threadId: string, data: PurgeThreadHistoryDto): Promise<ThreadDto> {
    // Verify thread exists
    await this.getThread(threadId);

    const cutoff = data.before ?? new Date().toISOString();

    // Determine messages older than cutoff (for logging)
    const idsToDelete = (
      await this.db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.threadId, threadId),
            (await import('drizzle-orm')).lt(chatMessages.createdAt, cutoff),
          ),
        )
    ).map((r) => r.id);

    if (idsToDelete.length > 0) {
      const { lt } = await import('drizzle-orm');
      // Delete targets/reads/invites cascade automatically via FK ON DELETE CASCADE
      await this.db
        .delete(chatMessages)
        .where(and(eq(chatMessages.threadId, threadId), lt(chatMessages.createdAt, cutoff)));

      logger.info({ threadId, cutoff, deletedCount: idsToDelete.length }, 'Purged chat messages');
    } else {
      logger.info({ threadId, cutoff, deletedCount: 0 }, 'No chat messages to purge');
    }

    // Optionally insert a system divider message
    if (data.announce) {
      await this.persistMessage(threadId, {
        authorType: 'system',
        content: `History purged up to ${cutoff}.`,
      });
    }

    return this.getThread(threadId);
  }

  /**
   * Acknowledge an invite message for a specific agent and session.
   * If the message is an invite message, sets the acknowledgedAt timestamp.
   */
  async acknowledgeInvite(
    threadId: string,
    messageId: string,
    agentId: string,
    sessionId: string,
  ): Promise<void> {
    const now = new Date().toISOString();

    // Check if this message is an invite message for this agent/session
    const inviteRows = await this.db
      .select()
      .from(chatThreadSessionInvites)
      .where(
        and(
          eq(chatThreadSessionInvites.threadId, threadId),
          eq(chatThreadSessionInvites.agentId, agentId),
          eq(chatThreadSessionInvites.sessionId, sessionId),
          eq(chatThreadSessionInvites.inviteMessageId, messageId),
        ),
      )
      .limit(1);

    if (inviteRows.length === 0) {
      // Not an invite message, nothing to do
      logger.debug({ threadId, messageId, agentId, sessionId }, 'Message is not an invite');
      return;
    }

    const invite = inviteRows[0];

    // Only update if not already acknowledged
    if (!invite.acknowledgedAt) {
      await this.db
        .update(chatThreadSessionInvites)
        .set({ acknowledgedAt: now })
        .where(eq(chatThreadSessionInvites.id, invite.id));

      logger.info(
        { threadId, messageId, agentId, sessionId, inviteId: invite.id },
        'Acknowledged invite message',
      );
    } else {
      logger.debug({ threadId, messageId, agentId, sessionId }, 'Invite already acknowledged');
    }
  }

  /**
   * Start an activity: auto-finish any running prior, post a system start message, and insert activity row
   */
  async startActivity(
    threadId: string,
    agentId: string,
    title: string,
    options?: { announce?: boolean },
  ): Promise<{
    activityId: string;
    startMessageId: string | null;
    startedAt: string;
    autoFinishedPrior: boolean;
  }> {
    const announce = options?.announce !== false;
    const now = new Date().toISOString();
    let autoFinishedPrior = false;

    // Find the latest running activity and auto-finish it
    const latest = await this.db
      .select()
      .from(chatActivities)
      .where(and(eq(chatActivities.threadId, threadId), eq(chatActivities.agentId, agentId)))
      .orderBy(desc(chatActivities.startedAt))
      .limit(1);

    if (latest.length > 0 && latest[0].status === 'running') {
      await this.db
        .update(chatActivities)
        .set({ status: 'auto_finished', finishedAt: now })
        .where(eq(chatActivities.id, latest[0].id));
      autoFinishedPrior = true;
    }

    // Post system start message
    const startContent = `${title}`;
    let startMessageId: string | null = null;
    if (announce) {
      const startMessage = await this.persistMessage(threadId, {
        authorType: 'system',
        content: startContent,
      });
      startMessageId = startMessage.id;
    }

    // Insert activity row
    const activityId = randomUUID();
    await this.db.insert(chatActivities).values({
      id: activityId,
      threadId,
      agentId,
      title,
      status: 'running',
      startedAt: now,
      finishedAt: null,
      startMessageId,
      finishMessageId: null,
    });

    return {
      activityId,
      startMessageId,
      startedAt: now,
      autoFinishedPrior,
    };
  }

  /**
   * Finish the latest running activity for a thread+agent
   */
  async finishActivity(
    threadId: string,
    agentId: string,
    options?: { message?: string; status?: 'success' | 'failed' | 'canceled' },
  ): Promise<{
    activityId: string;
    finishMessageId: string | null;
    startedAt: string;
    finishedAt: string;
    status: string;
  }> {
    const now = new Date().toISOString();
    const running = await this.db
      .select()
      .from(chatActivities)
      .where(
        and(
          eq(chatActivities.threadId, threadId),
          eq(chatActivities.agentId, agentId),
          eq(chatActivities.status, 'running'),
        ),
      )
      .orderBy(desc(chatActivities.startedAt))
      .limit(1);

    if (running.length === 0) {
      throw new ValidationError('No running activity to finish', {
        threadId,
        agentId,
      });
    }

    const current = running[0];
    const status = options?.status ?? 'success';
    let finishMessageId: string | null = null;
    if (options?.message && options.message.trim().length > 0) {
      const finishMessage = await this.persistMessage(threadId, {
        authorType: 'system',
        content: options.message,
      });
      finishMessageId = finishMessage.id;
    }

    await this.db
      .update(chatActivities)
      .set({ status, finishedAt: now, finishMessageId })
      .where(eq(chatActivities.id, current.id));

    return {
      activityId: current.id,
      finishMessageId,
      startedAt: current.startedAt,
      finishedAt: now,
      status,
    };
  }
}
