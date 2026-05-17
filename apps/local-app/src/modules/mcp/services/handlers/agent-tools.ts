import { createLogger } from '../../../../common/logging/logger';
import { NotFoundError } from '../../../../common/errors/error-types';
import { loadAgentRecipientContext } from '../../../../common/template/agent-recipient-context';
import {
  McpResponse,
  ListAgentsResponse,
  AgentSummary,
  GetAgentByNameResponse,
  ListStatusesResponse,
  SessionContext,
  type ListAgentsParams,
  type GetAgentByNameParams,
  type ListStatusesParams,
} from '../../dtos/mcp.dto';
import { mapStatusSummary } from '../mappers/dto-mappers';
import type { AgentToolContext } from './agent-context';
import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';
import type { InstructionsResolver } from '../instructions-resolver';
import { resolveSessionContext } from '../utils/session-context-helpers';
import { requireProject } from '../utils/require-project';

const logger = createLogger('McpService');

export async function handleListAgents(
  ctx: AgentToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as ListAgentsParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  const projectResult = requireProject(sessionCtxResult);
  if (!('project' in projectResult)) return projectResult;
  const { project } = projectResult;

  const limit = validated.limit ?? 100;
  const offset = validated.offset ?? 0;
  const normalizedQuery = validated.q?.toLowerCase();

  const MAX_COMBINED_FETCH = 1000;
  const [agentsResult, guests] = await Promise.all([
    ctx.storage.listAgents(project.id, { limit: MAX_COMBINED_FETCH, offset: 0 }),
    ctx.storage.listGuests(project.id),
  ]);

  let agentPresence = new Map<string, { online: boolean }>();
  let tmuxSessions = new Set<string>();
  try {
    [agentPresence, tmuxSessions] = await Promise.all([
      ctx.sessionsService.getAgentPresence(project.id),
      ctx.terminalIO.listAllSessionNames(),
    ]);
  } catch (error) {
    if (!(error instanceof ServiceUnavailableError)) throw error;
  }

  const agentItems: AgentSummary[] = agentsResult.items.map((agent) => ({
    id: agent.id,
    name: agent.name,
    profileId: agent.profileId,
    description: agent.description,
    type: 'agent' as const,
    online: agentPresence.get(agent.id)?.online ?? false,
  }));

  const guestItems: AgentSummary[] = guests.map((guest) => ({
    id: guest.id,
    name: guest.name,
    profileId: null,
    description: guest.description,
    type: 'guest' as const,
    online: tmuxSessions.has(guest.tmuxSessionId),
  }));

  let allItems = [...agentItems, ...guestItems].sort((a, b) => {
    const nameCompare = a.name.localeCompare(b.name);
    if (nameCompare !== 0) return nameCompare;
    return a.type === 'agent' ? -1 : 1;
  });

  if (normalizedQuery) {
    allItems = allItems.filter((item) => item.name.toLowerCase().includes(normalizedQuery));
  }

  const total = allItems.length;
  const paginatedItems = allItems.slice(offset, offset + limit);

  const response: ListAgentsResponse = {
    agents: paginatedItems,
    total,
    limit,
    offset,
  };

  return { success: true, data: response };
}

export async function handleGetAgentByName(
  ctx: AgentToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as GetAgentByNameParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  const projectResult = requireProject(sessionCtxResult);
  if (!('project' in projectResult)) return projectResult;
  const { project } = projectResult;

  const normalizedName = validated.name.trim().toLowerCase();
  const agentsList = await ctx.storage.listAgents(project.id, { limit: 1000, offset: 0 });

  const candidate = agentsList.items.find((agent) => agent.name.toLowerCase() === normalizedName);

  if (!candidate) {
    return {
      success: false,
      error: {
        code: 'AGENT_NOT_FOUND',
        message: `Agent "${validated.name}" not found in project`,
        data: {
          availableNames: agentsList.items.map((agent) => agent.name),
        },
      },
    };
  }

  let agentWithProfile;
  try {
    agentWithProfile = await ctx.storage.getAgentByName(project.id, candidate.name);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_FOUND',
          message: `Agent "${validated.name}" not found in project`,
          data: {
            availableNames: agentsList.items.map((agent) => agent.name),
          },
        },
      };
    }
    logger.warn(
      { projectId: project.id, name: candidate.name, error },
      'Agent lookup failed after matching by name',
    );
    throw error;
  }

  const profile = agentWithProfile.profile;
  const sessionContext = sessionCtxResult.data as SessionContext;
  const callerAgentId = sessionContext.type === 'agent' ? sessionContext.agent?.id : undefined;
  let teamCtx = { team_name: '', team_names: '', is_team_lead: false };
  if (callerAgentId) {
    try {
      teamCtx = await loadAgentRecipientContext(ctx.teamsService, callerAgentId);
    } catch (error) {
      if (!(error instanceof ServiceUnavailableError)) throw error;
    }
  }
  const renderVars: Record<string, unknown> = {
    agent_name: sessionContext.type === 'agent' ? (sessionContext.agent?.name ?? '') : '',
    project_name: project.name,
    ...teamCtx,
  };

  let resolvedInstructions: Awaited<ReturnType<InstructionsResolver['resolve']>> | null = null;
  if (profile) {
    try {
      resolvedInstructions = await ctx.instructionsResolver.resolve(
        project.id,
        profile.instructions ?? null,
        {
          maxBytes: ctx.defaultInlineMaxBytes,
          render: {
            vars: renderVars,
            legacyVariables: Object.keys(renderVars),
          },
        },
      );
    } catch (error) {
      if (error instanceof ServiceUnavailableError) {
        return {
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message:
              'Instructions resolver requires full app context (not available in standalone MCP mode)',
          },
        };
      }
      throw error;
    }
  }

  const response: GetAgentByNameResponse = {
    agent: {
      id: agentWithProfile.id,
      name: agentWithProfile.name,
      profileId: agentWithProfile.profileId,
      description: agentWithProfile.description,
      profile: profile
        ? {
            id: profile.id,
            name: profile.name,
            instructions: profile.instructions ?? null,
            instructionsResolved: resolvedInstructions ?? undefined,
          }
        : undefined,
    },
  };

  return { success: true, data: response };
}

export async function handleListStatuses(
  ctx: AgentToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as ListStatusesParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  const projectResult = requireProject(sessionCtxResult);
  if (!('project' in projectResult)) return projectResult;
  const { project } = projectResult;

  const result = await ctx.storage.listStatuses(project.id, {
    limit: 1000,
    offset: 0,
  });
  const response: ListStatusesResponse = {
    statuses: result.items.map((status) => mapStatusSummary(status)),
  };

  return { success: true, data: response };
}
