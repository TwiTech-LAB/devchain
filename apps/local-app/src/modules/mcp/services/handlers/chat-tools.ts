import { NotFoundException } from '@nestjs/common';
import { createLogger } from '../../../../common/logging/logger';
import { NotFoundError } from '../../../../common/errors/error-types';
import {
  McpResponse,
  SendMessageParamsSchema,
  SendMessageResponse,
  ChatAckParamsSchema,
  ChatAckResponse,
  ChatListMembersParamsSchema,
  ChatListMembersResponse,
  ChatReadHistoryParamsSchema,
  SessionContext,
} from '../../dtos/mcp.dto';
import type { McpToolContext } from './types';

const logger = createLogger('McpService');

interface ResolvedRecipient {
  type: 'agent' | 'guest';
  id: string;
  name: string;
  tmuxSessionId?: string;
}

function getActorFromContext(
  ctx: SessionContext,
): { id: string; name: string; projectId: string } | null {
  if (ctx.type === 'agent') {
    return ctx.agent;
  }
  if (ctx.type === 'guest') {
    return {
      id: ctx.guest.id,
      name: ctx.guest.name,
      projectId: ctx.guest.projectId,
    };
  }
  return null;
}

function redactSessionId(sessionId: string | undefined): string {
  if (!sessionId) return '(none)';
  return sessionId.slice(0, 4) + '****';
}

function redactParams(params: unknown): unknown {
  if (!params || typeof params !== 'object') return params;
  const obj = params as Record<string, unknown>;
  if ('sessionId' in obj && typeof obj.sessionId === 'string') {
    return { ...obj, sessionId: redactSessionId(obj.sessionId) };
  }
  return params;
}

function missingSessionResolver(): McpResponse {
  return {
    success: false,
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message:
        'Session resolution requires full app context (not available in standalone MCP mode)',
    },
  };
}

async function resolveSessionContext(ctx: McpToolContext, sessionId: string): Promise<McpResponse> {
  if (!ctx.resolveSessionContext) {
    return missingSessionResolver();
  }
  return ctx.resolveSessionContext(sessionId);
}

async function resolveRecipientByName(
  ctx: McpToolContext,
  projectId: string,
  name: string,
): Promise<ResolvedRecipient | null> {
  try {
    const agent = await ctx.storage.getAgentByName(projectId, name);
    return {
      type: 'agent',
      id: agent.id,
      name: agent.name,
    };
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }

  const guest = await ctx.storage.getGuestByName(projectId, name);
  if (guest) {
    return {
      type: 'guest',
      id: guest.id,
      name: guest.name,
      tmuxSessionId: guest.tmuxSessionId,
    };
  }

  return null;
}

async function getAvailableRecipientNames(
  ctx: McpToolContext,
  projectId: string,
): Promise<string[]> {
  const [agentsResult, guests] = await Promise.all([
    ctx.storage.listAgents(projectId, { limit: 100, offset: 0 }),
    ctx.storage.listGuests(projectId),
  ]);

  const agentNames = agentsResult.items.map((a) => a.name);
  const guestNames = guests.map((g) => `${g.name} (guest)`);

  return [...agentNames, ...guestNames];
}

export async function handleSendMessage(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  if (!ctx.sessionsService) {
    return {
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message:
          'Chat functionality requires full app context (not available in standalone MCP mode)',
      },
    };
  }

  const validated = SendMessageParamsSchema.parse(params);

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const sessionCtx = sessionCtxResult.data as SessionContext;
  const sender = getActorFromContext(sessionCtx);
  const project = sessionCtx.project;

  if (!sender) {
    return {
      success: false,
      error: {
        code: 'AGENT_REQUIRED',
        message: 'Session must be associated with an agent or guest to send messages',
      },
    };
  }

  if (!project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

  if (sessionCtx.type === 'guest') {
    if (validated.threadId) {
      return {
        success: false,
        error: {
          code: 'GUEST_THREAD_NOT_ALLOWED',
          message:
            'Guests cannot use threaded messaging. Use recipientAgentNames for direct messaging.',
        },
      };
    }
    if (validated.recipient === 'user') {
      return {
        success: false,
        error: {
          code: 'GUEST_USER_DM_NOT_ALLOWED',
          message: 'Guests cannot send direct messages to users.',
        },
      };
    }
  }

  try {
    const autoLaunchSessions = process.env.NODE_ENV !== 'test';

    const senderId = sender.id;
    const senderName = sender.name;
    const senderType = sessionCtx.type;
    const recipientType = validated.recipient ?? 'agents';

    const resolvedRecipients: ResolvedRecipient[] = [];
    if (validated.recipientAgentNames && validated.recipientAgentNames.length > 0) {
      for (const name of validated.recipientAgentNames) {
        const recipient = await resolveRecipientByName(ctx, project.id, name);
        if (!recipient) {
          const availableNames = await getAvailableRecipientNames(ctx, project.id);
          return {
            success: false,
            error: {
              code: 'RECIPIENT_NOT_FOUND',
              message: `Recipient "${name}" not found. Available: ${availableNames.join(', ') || 'none'}`,
            },
          };
        }
        if (recipient.id !== senderId) {
          resolvedRecipients.push(recipient);
        }
      }
    }
    const uniqueRecipients = resolvedRecipients.filter(
      (r, i, arr) => arr.findIndex((x) => x.id === r.id) === i,
    );

    if (!validated.threadId && senderId && recipientType !== 'user') {
      if (!ctx.messagePoolService || !ctx.settingsService) {
        return {
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message:
              'Message pool functionality requires full app context (not available in standalone MCP mode)',
          },
        };
      }

      if (uniqueRecipients.length === 0) {
        return {
          success: false,
          error: {
            code: 'RECIPIENTS_REQUIRED',
            message: 'Recipients must be provided when sending without threadId.',
          },
        };
      }

      const queued: Array<{
        name: string;
        type: 'agent' | 'guest';
        status: 'queued' | 'launched' | 'delivered' | 'failed';
        error?: string;
      }> = [];
      const poolConfig = ctx.settingsService.getMessagePoolConfigForProject(project.id);

      const activeSessions = ctx.sessionsService
        ? await ctx.sessionsService.listActiveSessions()
        : [];

      for (const recipient of uniqueRecipients) {
        const injectionText = `\n[This message is sent from "${senderName}" ${senderType} use devchain_send_message tool for communication]\n${validated.message}\n`;

        if (recipient.type === 'agent') {
          let session = activeSessions.find((s) => s.agentId === recipient.id);
          let wasLaunched = false;

          if (!session && autoLaunchSessions && ctx.sessionsService) {
            try {
              const launched = await ctx.sessionsService.launchSession({
                projectId: project.id,
                agentId: recipient.id,
                options: { silent: true },
              });
              session = launched;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              activeSessions.push(launched as any);
              wasLaunched = true;
            } catch {
              // Continue with queueing - agent will receive when online
            }
          }

          await ctx.messagePoolService.enqueue(recipient.id, injectionText, {
            source: 'mcp.send_message',
            submitKeys: ['Enter'],
            senderAgentId: senderId,
            projectId: project.id,
            agentName: recipient.name,
          });

          queued.push({
            name: recipient.name,
            type: 'agent',
            status: wasLaunched ? 'launched' : 'queued',
          });
        } else {
          const isOnline = ctx.tmuxService
            ? await ctx.tmuxService.hasSession(recipient.tmuxSessionId!)
            : false;

          if (!isOnline) {
            queued.push({
              name: recipient.name,
              type: 'guest',
              status: 'failed',
              error: 'Recipient offline',
            });
          } else if (ctx.tmuxService) {
            try {
              await ctx.tmuxService.pasteAndSubmit(recipient.tmuxSessionId!, injectionText);
              queued.push({
                name: recipient.name,
                type: 'guest',
                status: 'delivered',
              });
            } catch (error) {
              logger.warn(
                { guestId: recipient.id, tmuxSessionId: recipient.tmuxSessionId, error },
                'Failed to deliver message to guest',
              );
              queued.push({
                name: recipient.name,
                type: 'guest',
                status: 'failed',
                error: error instanceof Error ? error.message : 'Delivery failed',
              });
            }
          } else {
            queued.push({
              name: recipient.name,
              type: 'guest',
              status: 'failed',
              error: 'Tmux service unavailable',
            });
          }
        }
      }

      const response: SendMessageResponse = {
        mode: 'pooled',
        queuedCount: queued.length,
        queued,
        estimatedDeliveryMs: poolConfig.delayMs,
      };

      return { success: true, data: response };
    }

    if (!ctx.chatService) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message:
            'Chat functionality requires full app context (not available in standalone MCP mode)',
        },
      };
    }

    let threadId = validated.threadId;
    if (!threadId && senderId) {
      if (recipientType === 'user') {
        const direct = await ctx.chatService.createDirectThread({
          projectId: project.id,
          agentId: senderId,
        });
        threadId = direct.id;
      }
    }

    if (!threadId) {
      return {
        success: false,
        error: {
          code: 'THREAD_REQUIRED',
          message: 'Unable to determine thread for message delivery',
        },
      };
    }

    const thread = await ctx.chatService.getThread(threadId);

    const message = await ctx.chatService.createMessage(threadId, {
      authorType: 'agent',
      authorAgentId: senderId,
      content: validated.message,
    });

    let targetAgentIds = uniqueRecipients.filter((r) => r.type === 'agent').map((r) => r.id);

    if (senderId && thread.members && thread.members.length > 1 && targetAgentIds.length === 0) {
      targetAgentIds = thread.members.filter((id) => id !== senderId);
    }

    const activeSessions = await ctx.sessionsService.listActiveSessions();
    const delivered: Array<{
      agentName: string;
      agentId: string;
      sessionId: string;
      status: 'delivered' | 'queued';
    }> = [];

    for (const agentId of targetAgentIds) {
      const agent = await ctx.storage.getAgent(agentId);
      let session = activeSessions.find((s) => s.agentId === agentId);

      if (!session && autoLaunchSessions) {
        try {
          const launched = await ctx.sessionsService.launchSession({
            projectId: project.id,
            agentId,
            options: { silent: true },
          });
          session = launched;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          activeSessions.push(launched as any);
        } catch {
          // fall back to queued
        }
      }

      if (!session) {
        delivered.push({ agentId, agentName: agent.name, sessionId: '', status: 'queued' });
        continue;
      }

      const injectionText = `\n[CHAT] From: ${senderName} • Thread: ${threadId}\n${validated.message}\n[ACK] tools/call { name: "devchain_chat_ack", arguments: { sessionId: "${session.id}", thread_id: "${threadId}", message_id: "${message.id}" } }\n`;

      await ctx.sessionsService.injectTextIntoSession(session.id, injectionText);

      delivered.push({
        agentId,
        agentName: agent.name,
        sessionId: session.id,
        status: 'delivered',
      });
    }

    const response: SendMessageResponse = {
      mode: 'thread',
      threadId,
      messageId: message.id,
      deliveryCount: delivered.filter((d) => d.status === 'delivered').length,
      delivered,
    };

    return { success: true, data: response };
  } catch (error) {
    logger.error({ error, params: redactParams(validated) }, 'sendMessage failed');
    return {
      success: false,
      error: {
        code: 'SEND_MESSAGE_FAILED',
        message: error instanceof Error ? error.message : 'Failed to send message',
      },
    };
  }
}

export async function handleChatAck(ctx: McpToolContext, params: unknown): Promise<McpResponse> {
  if (!ctx.chatService || !ctx.terminalGateway) {
    return {
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message:
          'Chat acknowledgment requires full app context (not available in standalone MCP mode)',
      },
    };
  }

  const validated = ChatAckParamsSchema.parse(params);
  const { thread_id: threadId, message_id: messageId } = validated;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const sessionCtx = sessionCtxResult.data as SessionContext;
  const agent = getActorFromContext(sessionCtx);

  if (!agent) {
    return {
      success: false,
      error: {
        code: 'AGENT_NOT_FOUND',
        message: 'No agent associated with this session',
      },
    };
  }

  const agentId = agent.id;

  try {
    const thread = await ctx.chatService.getThread(threadId);
    const memberIds = thread.members ?? [];
    if (!memberIds.includes(agentId)) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_IN_THREAD',
          message: `Agent ${agent.name} is not a member of thread ${threadId}`,
        },
      };
    }

    const now = new Date().toISOString();

    await ctx.storage.markMessageAsRead(messageId, agentId, now);

    if (ctx.sessionsService) {
      const activeSessions = await ctx.sessionsService.listActiveSessions();
      const agentSession = activeSessions.find((s) => s.agentId === agentId);
      if (agentSession && agentSession.tmuxSessionId) {
        await ctx.chatService.acknowledgeInvite(
          threadId,
          messageId,
          agentId,
          agentSession.tmuxSessionId,
        );
      }
    }

    ctx.terminalGateway.broadcastEvent(`chat/${threadId}`, 'message.read', {
      messageId,
      agentId,
      readAt: now,
    });

    const response: ChatAckResponse = {
      threadId,
      messageId,
      agentId,
      agentName: agent.name,
      acknowledged: true,
    };

    return { success: true, data: response };
  } catch (error) {
    logger.error({ error, params: redactParams(validated) }, 'chatAck failed');
    return {
      success: false,
      error: {
        code: 'CHAT_ACK_FAILED',
        message: error instanceof Error ? error.message : 'Failed to acknowledge message',
      },
    };
  }
}

export async function handleChatListMembers(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  if (!ctx.chatService || !ctx.sessionsService) {
    return {
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message:
          'Chat members listing requires full app context (not available in standalone MCP mode)',
      },
    };
  }

  const validated = ChatListMembersParamsSchema.parse(params);

  try {
    const thread = await ctx.chatService.getThread(validated.thread_id);
    const memberIds = thread.members ?? [];

    if (memberIds.length === 0) {
      const emptyResponse: ChatListMembersResponse = {
        thread: {
          id: thread.id,
          title: thread.title,
        },
        members: [],
        total: 0,
      };

      return { success: true, data: emptyResponse };
    }

    const agents = await Promise.all(
      memberIds.map(async (agentId) => {
        try {
          return await ctx.storage.getAgent(agentId);
        } catch (error) {
          logger.error(
            { error, agentId, threadId: thread.id },
            'Failed to resolve agent for chat members',
          );
          throw error;
        }
      }),
    );

    const activeSessions = await ctx.sessionsService.listActiveSessions();
    const onlineAgents = new Set(activeSessions.map((session) => session.agentId));

    const members: ChatListMembersResponse['members'] = agents.map((agent) => ({
      agent_id: agent.id,
      agent_name: agent.name,
      online: onlineAgents.has(agent.id),
    }));

    const response: ChatListMembersResponse = {
      thread: {
        id: thread.id,
        title: thread.title,
      },
      members,
      total: members.length,
    };

    return { success: true, data: response };
  } catch (error) {
    if (error instanceof NotFoundException || error instanceof NotFoundError) {
      return {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Thread ${validated.thread_id} was not found.`,
        },
      };
    }

    logger.error({ error, params }, 'chatListMembers failed');
    return {
      success: false,
      error: {
        code: 'CHAT_LIST_MEMBERS_FAILED',
        message: error instanceof Error ? error.message : 'Failed to list chat members',
      },
    };
  }
}

export async function handleChatReadHistory(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  if (!ctx.chatService) {
    return {
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Chat history requires full app context (not available in standalone MCP mode)',
      },
    };
  }

  const validated = ChatReadHistoryParamsSchema.parse(params);

  try {
    const thread = await ctx.chatService.getThread(validated.thread_id);

    const limit = validated.limit ?? 50;
    const validatedWithExcludeSystem = validated as typeof validated & {
      exclude_system?: boolean;
    };
    const excludeSystem =
      typeof validatedWithExcludeSystem.exclude_system === 'boolean'
        ? validatedWithExcludeSystem.exclude_system
        : true;

    const messagesList = await ctx.chatService.listMessages(validated.thread_id, {
      since: validated.since,
      limit,
      offset: 0,
    });

    const authorIds = new Set<string>();
    const targetIds = new Set<string>();
    for (const message of messagesList.items) {
      if (message.authorAgentId) authorIds.add(message.authorAgentId);
      if (message.targets) {
        for (const target of message.targets) targetIds.add(target);
      }
    }

    const idToName = new Map<string, string>();
    const toLoad = Array.from(new Set([...authorIds, ...targetIds]));
    for (const id of toLoad) {
      try {
        const agent = await ctx.storage.getAgent(id);
        idToName.set(id, agent.name);
      } catch {
        // ignore
      }
    }

    const filteredItems = excludeSystem
      ? messagesList.items.filter((message) => message.authorType !== 'system')
      : messagesList.items;

    const messages = filteredItems.map((message) => {
      const base: Record<string, unknown> = {
        id: message.id,
        author_type: message.authorType,
        author_agent_id: message.authorAgentId ?? null,
        author_agent_name: message.authorAgentId
          ? (idToName.get(message.authorAgentId) ?? null)
          : null,
        content: message.content,
        created_at: message.createdAt,
        targets: message.targets,
      };

      if (message.targets && message.targets.length > 0) {
        const names = message.targets
          .map((targetId) => idToName.get(targetId))
          .filter((name): name is string => typeof name === 'string' && name.length > 0);
        if (names.length > 0) {
          base.target_agent_names = names;
        }
      }

      return base;
    });

    const response = {
      thread: {
        id: thread.id,
        title: thread.title,
      },
      messages,
      has_more: messages.length === limit,
    };

    return { success: true, data: response };
  } catch (error) {
    if (error instanceof NotFoundException || error instanceof NotFoundError) {
      return {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Thread ${validated.thread_id} was not found.`,
        },
      };
    }

    logger.error({ error, params }, 'chatReadHistory failed');
    return {
      success: false,
      error: {
        code: 'CHAT_READ_HISTORY_FAILED',
        message: error instanceof Error ? error.message : 'Failed to read chat history',
      },
    };
  }
}
