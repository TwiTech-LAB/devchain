import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SessionsMessagePoolService } from '../../sessions/services/sessions-message-pool.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { TmuxService } from '../../terminal/services/tmux.service';
import { ChatService } from '../../chat/services/chat.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';

interface ChatMessageCreatedPayload {
  threadId: string;
  message: {
    id: string;
    threadId: string;
    authorType: 'user' | 'agent' | 'system';
    authorAgentId: string | null;
    content: string;
    targets?: string[];
    createdAt: string;
  };
}

/**
 * Subscriber that delivers chat messages into active agent sessions (tmux)
 *
 * Rules implemented (Phase 2 delivery semantics):
 * - User-authored messages: with @mentions → targeted; without → broadcast to all members.
 * - Agent-authored messages: handled by MCP service; we skip here to avoid double-injection.
 * - System messages: never injected.
 */
@Injectable()
export class ChatMessageDeliverySubscriber {
  private readonly logger = new Logger(ChatMessageDeliverySubscriber.name);

  constructor(
    @Inject(forwardRef(() => SessionsMessagePoolService))
    private readonly messagePoolService: SessionsMessagePoolService,
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService: SessionsService,
    @Inject(forwardRef(() => TmuxService))
    private readonly tmuxService: TmuxService,
    private readonly chatService: ChatService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  @OnEvent('chat.message.created', { async: true })
  async handleChatMessageCreated(payload: ChatMessageCreatedPayload): Promise<void> {
    const { threadId, message } = payload;

    // Skip agent-authored messages (handled by MCP service to avoid double-injection)
    if (message.authorType === 'agent') {
      return;
    }

    // System messages are intentionally not injected into agent sessions.
    if (message.authorType === 'system') {
      return;
    }

    try {
      const thread = await this.chatService.getThread(threadId);

      // Determine recipients
      const recipients =
        message.targets && message.targets.length > 0
          ? Array.from(new Set(message.targets))
          : Array.from(new Set(thread.members ?? []));

      if (recipients.length === 0) {
        this.logger.debug(
          { threadId, messageId: message.id },
          'No recipients resolved for message',
        );
        return;
      }

      // Enqueue message to pool for each recipient
      for (const agentId of recipients) {
        try {
          const agent = await this.storage.getAgent(agentId);

          // Check if agent has an active session (DB check)
          const dbSession = this.sessionsService.getActiveSessionForAgent(agentId);

          // Verify session liveness if DB shows active session
          let sessionIsAlive = false;
          if (dbSession && dbSession.tmuxSessionId) {
            try {
              sessionIsAlive = await this.tmuxService.hasSession(dbSession.tmuxSessionId);
              if (!sessionIsAlive) {
                this.logger.warn(
                  `DB shows active session for agent ${agentId} but tmux session is dead, will auto-launch`,
                );
              }
            } catch (livenessError) {
              this.logger.debug(
                `Session liveness check failed for agent ${agentId}: ${livenessError}`,
              );
              sessionIsAlive = false;
            }
          }

          if (!sessionIsAlive) {
            // Auto-launch session for the agent
            this.logger.log(
              `No active session for agent ${agentId}, auto-launching session for message delivery`,
            );

            try {
              await this.sessionsService.launchSession({
                agentId,
                projectId: thread.projectId,
                options: { silent: true },
              });

              this.logger.log(`Auto-launched session successfully for agent ${agentId}`);
            } catch (launchError) {
              this.logger.error(
                `Failed to auto-launch session for message delivery: ${launchError}`,
                undefined,
                { threadId, agentId, messageId: message.id },
              );
              // Continue to next recipient - message will not be delivered to this agent
              continue;
            }
          }

          const injectionText = `\n[CHAT] From: User • Thread: ${threadId}\n${message.content}\n[ACK] tools/call { name: "devchain_chat_ack", arguments: { thread_id: "${threadId}", message_id: "${message.id}", agent_name: "${agent.name}" } }\n`;

          await this.messagePoolService.enqueue(agentId, injectionText, {
            source: 'chat.message',
            submitKeys: ['Enter'],
            senderAgentId: message.authorAgentId ?? undefined,
            projectId: thread.projectId,
            agentName: agent.name,
          });

          this.logger.debug(
            { threadId, agentId, messageId: message.id },
            'Enqueued chat message to pool',
          );
        } catch (enqueueError) {
          this.logger.debug(
            { threadId, agentId, messageId: message.id, error: enqueueError },
            'Failed to enqueue chat message to pool',
          );
        }
      }
    } catch (error) {
      this.logger.error(
        { error, threadId, messageId: message.id },
        'Failed to deliver chat message to sessions',
      );
    }
  }
}
