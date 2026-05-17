import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, and, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { createLogger } from '../../../common/logging/logger';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { TransactionRunner } from '../../storage/db/transaction-runner';
import {
  chatThreads,
  chatMembers,
  chatMessages,
  chatThreadSessionInvites,
  agents as agentsTable,
} from '../../storage/db/schema';
import { ActiveSessionLookup } from '../../sessions/services/active-session-lookup.service';
import { SessionLauncherFacade } from '../../sessions/services/session-launcher-facade.service';
import { ChatSettingsService } from './chat-settings.service';
import { renderInviteTemplate } from './invite-template.util';
import type { ThreadDto } from '../dtos/chat.dto';

const logger = createLogger('ChatSessionInviteService');
const DEFAULT_INVITER_NAME = 'You';

@Injectable()
export class ChatSessionInviteService {
  private readonly txRunner: TransactionRunner;

  constructor(
    @Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database,
    private readonly eventEmitter: EventEmitter2,
    private readonly chatSettingsService: ChatSettingsService,
    private readonly activeSessionLookup: ActiveSessionLookup,
    private readonly sessionLauncherFacade: SessionLauncherFacade,
  ) {
    this.txRunner = new TransactionRunner(getRawSqliteClient(this.db));
  }

  async ensureSessionInvites(
    threadId: string,
    projectId: string,
    targetedAgentIds: string[],
  ): Promise<void> {
    if (targetedAgentIds.length === 0) {
      return;
    }

    const activeSessions = await this.activeSessionLookup.listActiveSessions(projectId);
    const sessionsByAgent = new Map<string, string>();
    for (const session of activeSessions) {
      if (session.agentId && session.tmuxSessionId) {
        sessionsByAgent.set(session.agentId, session.tmuxSessionId);
      }
    }

    for (const agentId of targetedAgentIds) {
      let sessionId = sessionsByAgent.get(agentId);
      if (!sessionId) {
        try {
          const launchedSession = await this.sessionLauncherFacade.ensureActiveSession(
            agentId,
            projectId,
          );
          if (launchedSession.tmuxSessionId) {
            sessionId = launchedSession.tmuxSessionId;
            sessionsByAgent.set(agentId, sessionId);
          } else {
            logger.warn(
              { threadId, projectId, agentId, launchedSessionId: launchedSession.sessionId },
              'Launched session has no tmux session id, skipping invite',
            );
            continue;
          }
        } catch (error) {
          logger.warn(
            { error, threadId, projectId, agentId },
            'Failed to ensure active session for invite, skipping agent',
          );
          continue;
        }
      }

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
        continue;
      }

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

      const threadRows = await this.db
        .select()
        .from(chatThreads)
        .where(eq(chatThreads.id, threadId))
        .limit(1);

      if (threadRows.length === 0) {
        logger.warn({ threadId }, 'Thread not found during invite creation');
        continue;
      }

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
        await this.txRunner.runImmediateAsync(async () => {
          await this.db.insert(chatMessages).values({
            id: inviteMessageId,
            threadId,
            authorType: 'system',
            authorAgentId: null,
            content: renderedTemplate,
            createdAt: messageTimestamp,
          });

          await this.db
            .update(chatThreads)
            .set({ updatedAt: messageTimestamp })
            .where(eq(chatThreads.id, threadId));

          await this.db.insert(chatThreadSessionInvites).values({
            id: randomUUID(),
            threadId,
            agentId,
            sessionId,
            inviteMessageId,
            sentAt: messageTimestamp,
            acknowledgedAt: null,
          });
        });

        try {
          // Phase 7 7E.1 — write-first ordering. Persist invite row before emitting event
          // for consistent listener read model. Verified by 7A.5b characterization: no
          // listener depends on pre-row emit.
          this.eventEmitter.emit('chat.message.created', {
            threadId,
            projectId,
            message: {
              id: inviteMessageId,
              threadId,
              authorType: 'system',
              authorAgentId: null,
              content: renderedTemplate,
              createdAt: messageTimestamp,
            },
          });
        } catch (emitError) {
          logger.warn(
            { emitError, threadId, inviteMessageId },
            'Failed to emit chat.message.created for invite',
          );
        }

        logger.info({ threadId, agentId, sessionId, inviteMessageId }, 'Sent session-aware invite');
      } catch (error) {
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

  private deriveThreadTitle(thread: ThreadDto, participantNames: string): string {
    if (thread.title && thread.title.trim().length > 0) {
      return thread.title;
    }
    return participantNames || 'Chat Thread';
  }
}
