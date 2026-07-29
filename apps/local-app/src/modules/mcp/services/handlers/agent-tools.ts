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
  const isSelfLookup = callerAgentId === agentWithProfile.id;

  let providerConfigName: string | null = null;
  if (agentWithProfile.providerConfigId) {
    try {
      const providerConfig = await ctx.storage.getProfileProviderConfig(
        agentWithProfile.providerConfigId,
      );
      providerConfigName = providerConfig.name;
    } catch (error) {
      logger.warn(
        {
          agentId: agentWithProfile.id,
          providerConfigId: agentWithProfile.providerConfigId,
          error,
        },
        'Provider config name lookup failed for agent directory card',
      );
    }
  }

  let teams: GetAgentByNameResponse['agent']['teams'] = [];
  try {
    const targetTeams = await ctx.teamsService.listTeamsByAgent(agentWithProfile.id);
    teams = targetTeams
      .filter((team) => team.projectId === project.id)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((team) => ({
        teamId: team.id,
        teamName: team.name,
        isLead: team.teamLeadAgentId === agentWithProfile.id,
      }));
  } catch (error) {
    if (!(error instanceof ServiceUnavailableError)) throw error;
  }

  let presence: GetAgentByNameResponse['agent']['presence'] = null;
  try {
    const entry = (await ctx.sessionsService.getAgentPresence(project.id)).get(agentWithProfile.id);
    if (entry) {
      const activityState = entry.online ? (entry.activityState ?? null) : null;
      presence = {
        online: entry.online,
        activityState,
        lastActivityAt: entry.online ? (entry.lastActivityAt ?? null) : null,
        busySince: entry.online && activityState === 'busy' ? (entry.busySince ?? null) : null,
        idleSince: entry.online && activityState === 'idle' ? (entry.idleSince ?? null) : null,
        currentActivityTitle: entry.online ? (entry.currentActivityTitle ?? null) : null,
      };
    }
  } catch (error) {
    if (!(error instanceof ServiceUnavailableError)) throw error;
  }

  let assignedEpics: GetAgentByNameResponse['agent']['assignedEpics'] = {
    items: [],
    total: 0,
  };
  try {
    const [assignedResult, statusesResult] = await Promise.all([
      ctx.storage.listAssignedEpics(project.id, {
        agentName: agentWithProfile.name,
        excludeMcpHidden: true,
        limit: 100,
        offset: 0,
      }),
      ctx.storage.listStatuses(project.id, { limit: 1000, offset: 0 }),
    ]);
    const statusById = new Map(statusesResult.items.map((status) => [status.id, status.label]));
    const openEpics = assignedResult.items
      .map((epic) => ({ epic, status: statusById.get(epic.statusId) ?? 'Unknown' }))
      .filter(({ status }) => status.toLowerCase() !== 'done')
      .sort((a, b) => b.epic.updatedAt.localeCompare(a.epic.updatedAt));

    assignedEpics = {
      items: openEpics.slice(0, 20).map(({ epic, status }) => ({
        id: epic.id,
        parentId: epic.parentId,
        title: epic.title,
        status,
      })),
      total: openEpics.length,
    };
  } catch {
    assignedEpics = { items: [], total: 0 };
  }

  let resolvedInstructions: Awaited<ReturnType<InstructionsResolver['resolve']>> | null = null;
  if (profile && isSelfLookup) {
    let teamCtx = { team_name: '', team_names: '', is_team_lead: false };
    try {
      teamCtx = await loadAgentRecipientContext(ctx.teamsService, agentWithProfile.id);
    } catch (error) {
      if (!(error instanceof ServiceUnavailableError)) throw error;
    }
    const renderVars: Record<string, unknown> = {
      agent_name: sessionContext.type === 'agent' ? (sessionContext.agent?.name ?? '') : '',
      project_name: project.name,
      ...teamCtx,
    };
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
      providerConfigId: agentWithProfile.providerConfigId ?? null,
      providerConfigName,
      teams,
      presence,
      assignedEpics,
      profile: profile
        ? isSelfLookup
          ? {
              id: profile.id,
              name: profile.name,
              instructions: profile.instructions ?? null,
              instructionsResolved: resolvedInstructions ?? undefined,
            }
          : { id: profile.id, name: profile.name }
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
