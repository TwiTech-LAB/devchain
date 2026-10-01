import { createLogger } from '../../../../common/logging/logger';
import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';
import {
  McpResponse,
  SendMessageResponse,
  SessionContext,
  type SendMessageParams,
} from '../../dtos/mcp.dto';
import type { ChatToolContext } from './chat-context';
import { resolveSessionContext, getActorFromContext } from '../utils/session-context-helpers';
import { redactParams } from '../utils/redact';
import { toProjectAdmissionErrorResponse } from '../utils/project-admission-error';
import {
  resolveRecipientByName,
  getAvailableRecipientNames,
  type ResolvedRecipient,
} from './chat-tools/recipient-resolution';
import type {
  AgentDescriptor,
  AgentMessageRouting,
  TeamDeliveryMode,
} from '../../../agent-message-delivery/dtos/delivery.types';

const logger = createLogger('McpService');

function resolveAgentMessageRouting(
  resolvedRecipientCount: number,
  teamRouting:
    | {
        teamId: string;
        teamName: string;
        teamDeliveryMode: TeamDeliveryMode;
      }
    | undefined,
): AgentMessageRouting {
  if (teamRouting) {
    return {
      routingKind: 'group',
      groupKind: 'team',
      ...teamRouting,
    };
  }

  return resolvedRecipientCount === 1
    ? { routingKind: 'direct' }
    : { routingKind: 'group', groupKind: 'explicit' };
}

export async function handleSendMessage(
  ctx: ChatToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as SendMessageParams;

  try {
    const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
    if (!sessionCtxResult.success) return sessionCtxResult;
    const sessionCtx = sessionCtxResult.data as SessionContext;

    if (validated.recipientProjectId) {
      const outcome = await ctx.projectCommunicationService.sendToProject({
        callerAgentId: sessionCtx.type === 'agent' ? (sessionCtx.agent?.id ?? null) : null,
        recipientProjectId: validated.recipientProjectId,
        message: validated.message,
      });

      return 'error' in outcome
        ? { success: false, error: outcome.error }
        : { success: true, data: outcome.result };
    }

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
    ctx.projectWriteAdmission?.assertWritable(project.id);

    const senderId = sender.id;
    const senderName = sender.name;
    const senderType = sessionCtx.type;

    let effectiveTeamName = validated.teamName;

    if (!validated.teamName && !validated.recipientAgentNames) {
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
              'Sender is not in any team; provide teamName or recipientAgentNames explicitly.',
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

    const recipientCandidates: ResolvedRecipient[] = [];
    let teamDelivery:
      | {
          teamName: string;
          recipientCount: number;
          routedToLead: boolean;
          summary: string;
        }
      | undefined;
    let teamRouting:
      | {
          teamId: string;
          teamName: string;
          teamDeliveryMode: TeamDeliveryMode;
        }
      | undefined;

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
        recipientCandidates.push({
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
      teamRouting = {
        teamId: fullTeam.id,
        teamName: fullTeam.name,
        teamDeliveryMode: routedToLead ? 'lead' : teamHasLead ? 'lead_excluded' : 'no_lead',
      };
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
          recipientCandidates.push(recipient);
        }
      }
    }
    const resolvedRecipients = recipientCandidates.filter(
      (r, i, arr) => arr.findIndex((x) => x.id === r.id) === i,
    );

    if (effectiveTeamName && resolvedRecipients.length === 0) {
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
        recipientCount: resolvedRecipients.length,
        summary:
          teamRouting?.teamDeliveryMode === 'lead'
            ? 'Delivered to 1 agent (team lead)'
            : teamRouting?.teamDeliveryMode === 'lead_excluded'
              ? `Delivered to ${resolvedRecipients.length} agent(s) (team lead excluded)`
              : `Delivered to ${resolvedRecipients.length} agent(s) (no lead assigned)`,
      };
    }

    if (resolvedRecipients.length === 0) {
      return {
        success: false,
        error: {
          code: 'RECIPIENTS_REQUIRED',
          message: 'Recipients must be provided for terminal delivery.',
        },
      };
    }

    const queued: Array<{
      name: string;
      type: 'agent' | 'guest';
      status: 'queued' | 'launched' | 'delivered' | 'unconfirmed' | 'failed';
      error?: string;
    }> = [];

    const agentDescriptors: AgentDescriptor[] = resolvedRecipients
      .filter((recipient) => recipient.type === 'agent')
      .map((recipient) => ({
        agentId: recipient.id,
        agentName: recipient.name,
      }));
    const guestRecipients = resolvedRecipients.filter((recipient) => recipient.type === 'guest');

    if (agentDescriptors.length > 0) {
      const message = {
        kind: 'mcp.direct' as const,
        body: validated.message,
        source: 'mcp.send_message',
        projectId: project.id,
        senderName,
        senderType: senderType as 'agent' | 'guest',
        senderAgentId: senderId,
      };
      const policy = { submitKeys: ['Enter'] as const };

      const outcome =
        senderType === 'agent'
          ? await ctx.agentMessageDelivery.deliverAgentMessage(
              agentDescriptors,
              resolveAgentMessageRouting(resolvedRecipients.length, teamRouting),
              message,
              policy,
            )
          : await ctx.agentMessageDelivery.deliver(
              agentDescriptors.map((descriptor) => descriptor.agentId),
              message,
              policy,
            );

      for (const result of outcome.results) {
        const recipient = agentDescriptors.find(
          (descriptor) => descriptor.agentId === result.agentId,
        );
        queued.push({
          name: recipient?.agentName ?? result.agentId,
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
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return { success: false, error: { code: 'SERVICE_UNAVAILABLE', message: error.message } };
    }
    const refused = toProjectAdmissionErrorResponse(error);
    if (refused) return refused;
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
