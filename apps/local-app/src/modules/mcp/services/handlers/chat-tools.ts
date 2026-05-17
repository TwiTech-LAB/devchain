import { NotFoundException } from '@nestjs/common';
import { createLogger } from '../../../../common/logging/logger';
import { NotFoundError } from '../../../../common/errors/error-types';
import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';
import {
  McpResponse,
  SendMessageResponse,
  ChatAckResponse,
  ChatListMembersResponse,
  SessionContext,
  type SendMessageParams,
  type ChatAckParams,
  type ChatListMembersParams,
  type ChatReadHistoryParams,
} from '../../dtos/mcp.dto';
import type { ChatToolContext } from './chat-context';
import { resolveSessionContext, getActorFromContext } from '../utils/session-context-helpers';
import { redactParams } from '../utils/redact';
import {
  resolveRecipientByName,
  getAvailableRecipientNames,
  type ResolvedRecipient,
} from './chat-tools/recipient-resolution';

const logger = createLogger('McpService');

export async function handleSendMessage(
  ctx: ChatToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as SendMessageParams;

  try {
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
      if (validated.recipient === 'user' && !validated.teamName) {
        return {
          success: false,
          error: {
            code: 'GUEST_USER_DM_NOT_ALLOWED',
            message: 'Guests cannot send direct messages to users.',
          },
        };
      }
    }

    const senderId = sender.id;
    const senderName = sender.name;
    const senderType = sessionCtx.type;

    let effectiveTeamName = validated.teamName;

    if (
      !validated.teamName &&
      !validated.recipientAgentNames &&
      !validated.threadId &&
      validated.recipient !== 'user'
    ) {
      const senderAgentId = sessionCtx.type === 'agent' ? sessionCtx.agent?.id : undefined;
      if (!senderAgentId) {
        return {
          success: false,
          error: {
            code: 'NO_SELF_TEAM',
            message: 'Sender has no agent context; cannot resolve self-team.',
          },
        };
      }
      const teams = await ctx.teamsService.listTeamsByAgent(senderAgentId);
      if (teams.length === 0) {
        return {
          success: false,
          error: {
            code: 'NO_SELF_TEAM',
            message:
              'Sender is not in any team; provide teamName, recipientAgentNames, or threadId explicitly.',
          },
        };
      }
      if (teams.length > 1) {
        return {
          success: false,
          error: {
            code: 'AMBIGUOUS_SELF_TEAM',
            message: 'Sender is in multiple teams; provide teamName explicitly.',
          },
        };
      }
      effectiveTeamName = teams[0].name;
    }

    const recipientType = effectiveTeamName ? 'agents' : (validated.recipient ?? 'agents');

    const resolvedRecipients: ResolvedRecipient[] = [];
    let teamDelivery:
      | {
          teamName: string;
          recipientCount: number;
          routedToLead: boolean;
          summary: string;
        }
      | undefined;
    let teamDeliveryMode: 'lead' | 'lead_excluded' | 'no_lead' | undefined;

    if (effectiveTeamName) {
      const matchedTeam = await ctx.teamsService.findTeamByExactName(project.id, effectiveTeamName);

      if (!matchedTeam) {
        return {
          success: false,
          error: {
            code: 'TEAM_NOT_FOUND',
            message: `Team "${effectiveTeamName}" not found in project`,
          },
        };
      }

      const fullTeam = await ctx.teamsService.getTeam(matchedTeam.id);
      if (!fullTeam) {
        return {
          success: false,
          error: {
            code: 'TEAM_NOT_FOUND',
            message: `Team "${matchedTeam.name}" not found in project`,
          },
        };
      }

      const teamLeadAgentId = fullTeam.teamLeadAgentId;
      const teamHasLead = teamLeadAgentId !== null;
      const routedToLead = teamHasLead && teamLeadAgentId !== senderId;
      const recipientAgentIds = routedToLead
        ? [teamLeadAgentId]
        : fullTeam.members.map((member) => member.agentId);

      for (const agentId of recipientAgentIds) {
        if (agentId === senderId) {
          continue;
        }

        const agent = await ctx.storage.getAgent(agentId);
        resolvedRecipients.push({
          type: 'agent',
          id: agent.id,
          name: agent.name,
        });
      }

      teamDelivery = {
        teamName: fullTeam.name,
        recipientCount: 0,
        routedToLead,
        summary: '',
      };
      teamDeliveryMode = routedToLead ? 'lead' : teamHasLead ? 'lead_excluded' : 'no_lead';
    } else if (validated.recipientAgentNames && validated.recipientAgentNames.length > 0) {
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

    if (effectiveTeamName && uniqueRecipients.length === 0) {
      return {
        success: false,
        error: {
          code: 'NO_RECIPIENTS',
          message: 'No recipients — sender is the only team member/lead',
        },
      };
    }

    if (teamDelivery) {
      teamDelivery = {
        ...teamDelivery,
        recipientCount: uniqueRecipients.length,
        summary:
          teamDeliveryMode === 'lead'
            ? 'Delivered to 1 agent (team lead)'
            : teamDeliveryMode === 'lead_excluded'
              ? `Delivered to ${uniqueRecipients.length} agent(s) (team lead excluded)`
              : `Delivered to ${uniqueRecipients.length} agent(s) (no lead assigned)`,
      };
    }

    if (!validated.threadId && senderId && recipientType !== 'user') {
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
        status: 'queued' | 'launched' | 'delivered' | 'unconfirmed' | 'failed';
        error?: string;
      }> = [];

      const agentRecipients = uniqueRecipients.filter((r) => r.type === 'agent');
      const guestRecipients = uniqueRecipients.filter((r) => r.type === 'guest');

      if (agentRecipients.length > 0) {
        const outcome = await ctx.agentMessageDelivery.deliver(
          agentRecipients.map((r) => r.id),
          {
            kind: 'mcp.direct',
            body: validated.message,
            source: 'mcp.send_message',
            projectId: project.id,
            senderName,
            senderType: senderType as 'agent' | 'guest',
            senderAgentId: senderId,
          },
          { submitKeys: ['Enter'] },
        );

        for (const result of outcome.results) {
          const recipient = agentRecipients.find((r) => r.id === result.agentId);
          queued.push({
            name: recipient?.name ?? result.agentId,
            type: 'agent',
            status: result.status === 'failed' ? 'failed' : 'queued',
            error: result.error,
          });
        }
      }

      for (const recipient of guestRecipients) {
        if (!recipient.tmuxSessionId) {
          queued.push({
            name: recipient.name,
            type: 'guest',
            status: 'failed',
            error: 'No session',
          });
          continue;
        }

        try {
          const guestText = ctx.agentMessageDelivery.formatMessage({
            kind: 'mcp.direct',
            body: validated.message,
            source: 'mcp.send_message',
            projectId: project.id,
            senderName,
            senderType: senderType as 'agent' | 'guest',
          });
          const result = await ctx.agentMessageDelivery.deliverToGuest(
            recipient.tmuxSessionId,
            guestText,
            ['Enter'],
          );
          queued.push({
            name: recipient.name,
            type: 'guest',
            status: result.delivered ? 'delivered' : 'failed',
            error: result.error,
          });
        } catch (error) {
          if (error instanceof ServiceUnavailableError) {
            queued.push({
              name: recipient.name,
              type: 'guest',
              status: 'failed',
              error: 'Delivery service unavailable',
            });
            continue;
          }
          throw error;
        }
      }

      const estimatedDeliveryMs = ctx.settingsService.getMessagePoolConfigForProject(
        project.id,
      ).delayMs;

      const response: SendMessageResponse = {
        mode: 'pooled',
        queuedCount: queued.length,
        queued,
        estimatedDeliveryMs,
        ...(teamDelivery ? { teamDelivery } : {}),
      };

      return { success: true, data: response };
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

    const delivered: Array<{
      agentName: string;
      agentId: string;
      sessionId: string;
      status: 'delivered' | 'queued' | 'unconfirmed';
    }> = [];

    if (targetAgentIds.length > 0) {
      const outcome = await ctx.agentMessageDelivery.deliver(
        targetAgentIds,
        {
          kind: 'mcp.thread',
          body: validated.message,
          source: 'mcp.chat_thread',
          projectId: project.id,
          senderName,
          senderType: 'agent',
          threadId,
          messageId: message.id,
          senderAgentId: senderId,
        },
        { submitKeys: ['Enter'], immediate: true },
      );

      for (const result of outcome.results) {
        const agent = await ctx.storage.getAgent(result.agentId);
        delivered.push({
          agentId: result.agentId,
          agentName: agent.name,
          sessionId: '',
          status:
            result.status === 'failed'
              ? 'queued'
              : (result.status as 'delivered' | 'queued' | 'unconfirmed'),
        });
      }
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
    if (error instanceof ServiceUnavailableError) {
      return { success: false, error: { code: 'SERVICE_UNAVAILABLE', message: error.message } };
    }
    logger.error(
      { error, params: redactParams(params as SendMessageParams) },
      'sendMessage failed',
    );
    return {
      success: false,
      error: {
        code: 'SEND_MESSAGE_FAILED',
        message: error instanceof Error ? error.message : 'Failed to send message',
      },
    };
  }
}

export async function handleChatAck(ctx: ChatToolContext, params: unknown): Promise<McpResponse> {
  const validated = params as ChatAckParams;
  const { thread_id: threadId, message_id: messageId } = validated;

  try {
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

    await ctx.chatService.markMessageAsRead(messageId, agentId);

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

    const response: ChatAckResponse = {
      threadId,
      messageId,
      agentId,
      agentName: agent.name,
      acknowledged: true,
    };

    return { success: true, data: response };
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return { success: false, error: { code: 'SERVICE_UNAVAILABLE', message: error.message } };
    }
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
  ctx: ChatToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as ChatListMembersParams;

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
    if (error instanceof ServiceUnavailableError) {
      return { success: false, error: { code: 'SERVICE_UNAVAILABLE', message: error.message } };
    }
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
  ctx: ChatToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as ChatReadHistoryParams;

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
    if (error instanceof ServiceUnavailableError) {
      return { success: false, error: { code: 'SERVICE_UNAVAILABLE', message: error.message } };
    }
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
