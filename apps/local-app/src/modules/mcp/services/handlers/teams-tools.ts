import {
  type McpResponse,
  type ListTeamsResponse,
  type TeamSummary,
  type ListTeamMembersResponse,
  type TeamMembersEntry,
  type TeamMemberSummary,
  type SessionContext,
  type AgentSessionContext,
  type DevchainTeamResponse,
  type DevchainTeamMemberProjection,
  type TeamsListParams,
  type TeamsMembersListParams,
  type TeamsConfigsListParams,
  type TeamsCreateAgentParams,
  type TeamsDeleteAgentParams,
  type DevchainTeamParams,
} from '../../dtos/mcp.dto';
import type { TeamsToolContext } from './teams-context';
import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';
import { resolveSessionContext } from '../utils/session-context-helpers';
import { resolveAgentNames } from '../utils/agent-name-resolver';
import { requireProject } from '../utils/require-project';

function teamsServiceUnavailable(): McpResponse {
  return {
    success: false,
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Teams operations require full app context (not available in standalone MCP mode)',
    },
  };
}

function catchTeamsUnavailable(error: unknown): McpResponse {
  if (error instanceof ServiceUnavailableError) {
    return teamsServiceUnavailable();
  }
  throw error;
}

export async function handleTeamsList(
  ctx: TeamsToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as TeamsListParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  const projectResult = requireProject(sessionCtxResult);
  if (!('project' in projectResult)) return projectResult;
  const { project } = projectResult;

  const limit = validated.limit ?? 100;
  const offset = validated.offset ?? 0;

  try {
    const result = await ctx.teamsService.listTeams(project.id, { limit, offset, q: validated.q });

    const teams: TeamSummary[] = result.items.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      teamLeadAgentId: t.teamLeadAgentId,
      teamLeadName: t.teamLeadAgentName,
      memberCount: t.memberCount,
    }));

    const response: ListTeamsResponse = {
      teams,
      total: result.total,
      limit,
      offset,
    };

    return { success: true, data: response };
  } catch (error) {
    return catchTeamsUnavailable(error);
  }
}

export async function handleTeamsMembersList(
  ctx: TeamsToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as TeamsMembersListParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const sessionCtx = sessionCtxResult.data as SessionContext;

  const { project } = sessionCtx;
  if (!project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

  try {
    if (validated.teamId) {
      const team = await ctx.teamsService.getTeam(validated.teamId);
      if (!team) {
        return {
          success: false,
          error: {
            code: 'TEAM_NOT_FOUND',
            message: `Team ${validated.teamId} was not found.`,
          },
        };
      }

      if (team.projectId !== project.id) {
        return {
          success: false,
          error: {
            code: 'TEAM_NOT_FOUND',
            message: `Team ${validated.teamId} does not belong to the resolved project.`,
          },
        };
      }

      const members = await buildTeamMembers(ctx, team.members, team.teamLeadAgentId);

      const response: ListTeamMembersResponse = {
        teams: [
          {
            teamId: team.id,
            teamName: team.name,
            members,
          },
        ],
      };

      return { success: true, data: response };
    }

    if (sessionCtx.type === 'guest') {
      return {
        success: false,
        error: {
          code: 'AGENT_CONTEXT_REQUIRED',
          message: 'Guest sessions must provide teamId. Guests do not have team membership.',
        },
      };
    }

    const agentCtx = sessionCtx as AgentSessionContext;
    if (!agentCtx.agent) {
      return {
        success: false,
        error: {
          code: 'AGENT_REQUIRED',
          message: 'Session must be associated with an agent to list team membership',
        },
      };
    }

    const agentTeams = await ctx.teamsService.listTeamsByAgent(agentCtx.agent.id);

    const teamsEntries: TeamMembersEntry[] = [];
    for (const team of agentTeams) {
      const fullTeam = await ctx.teamsService.getTeam(team.id);
      if (!fullTeam) continue;

      const members = await buildTeamMembers(ctx, fullTeam.members, fullTeam.teamLeadAgentId);
      teamsEntries.push({
        teamId: fullTeam.id,
        teamName: fullTeam.name,
        members,
      });
    }

    const response: ListTeamMembersResponse = {
      teams: teamsEntries,
    };

    return { success: true, data: response };
  } catch (error) {
    return catchTeamsUnavailable(error);
  }
}

export async function handleTeamsConfigsList(
  ctx: TeamsToolContext,
  params: unknown,
): Promise<McpResponse> {
  const parsed = params as TeamsConfigsListParams;

  const sessionResult = await resolveSessionContext(ctx, parsed.sessionId);
  if (!sessionResult.success) return sessionResult;
  const sessionCtx = sessionResult.data as SessionContext;

  if (sessionCtx.type === 'guest') {
    return {
      success: false,
      error: {
        code: 'AGENT_CONTEXT_REQUIRED',
        message: 'This tool requires an agent session context',
      },
    };
  }

  const agentCtx = sessionCtx as AgentSessionContext;
  if (!agentCtx.agent) {
    return {
      success: false,
      error: {
        code: 'AGENT_REQUIRED',
        message: 'No agent associated with this session',
      },
    };
  }

  if (!agentCtx.project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

  try {
    const result = await ctx.teamsService.listConfigsVisibleToLead(
      agentCtx.agent.id,
      agentCtx.project.id,
    );
    if ('error' in result) return { success: false, error: result.error };
    return { success: true, data: { configs: result } };
  } catch (error) {
    return catchTeamsUnavailable(error);
  }
}

export async function handleTeamsCreateAgent(
  ctx: TeamsToolContext,
  params: unknown,
): Promise<McpResponse> {
  const parsed = params as TeamsCreateAgentParams;

  const sessionResult = await resolveSessionContext(ctx, parsed.sessionId);
  if (!sessionResult.success) return sessionResult;
  const sessionCtx = sessionResult.data as SessionContext;

  if (sessionCtx.type === 'guest') {
    return {
      success: false,
      error: {
        code: 'AGENT_CONTEXT_REQUIRED',
        message: 'This tool requires an agent session context',
      },
    };
  }

  const agentCtx = sessionCtx as AgentSessionContext;
  if (!agentCtx.agent) {
    return {
      success: false,
      error: {
        code: 'AGENT_REQUIRED',
        message: 'No agent associated with this session',
      },
    };
  }

  if (!agentCtx.project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

  try {
    const result = await ctx.teamsService.createTeamAgent({
      leadAgentId: agentCtx.agent.id,
      projectId: agentCtx.project.id,
      name: parsed.name,
      description: parsed.description,
      configName: parsed.configName,
      profileName: parsed.profileName,
      teamName: parsed.teamName,
    });
    if ('error' in result) return { success: false, error: result.error };
    return { success: true, data: { agentId: result.agent.id } };
  } catch (error) {
    return catchTeamsUnavailable(error);
  }
}

export async function handleTeamsDeleteAgent(
  ctx: TeamsToolContext,
  params: unknown,
): Promise<McpResponse> {
  const parsed = params as TeamsDeleteAgentParams;

  const sessionResult = await resolveSessionContext(ctx, parsed.sessionId);
  if (!sessionResult.success) return sessionResult;
  const sessionCtx = sessionResult.data as SessionContext;

  if (sessionCtx.type === 'guest') {
    return {
      success: false,
      error: {
        code: 'AGENT_CONTEXT_REQUIRED',
        message: 'This tool requires an agent session context',
      },
    };
  }

  const agentCtx = sessionCtx as AgentSessionContext;
  if (!agentCtx.agent) {
    return {
      success: false,
      error: {
        code: 'AGENT_REQUIRED',
        message: 'No agent associated with this session',
      },
    };
  }

  if (!agentCtx.project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

  try {
    const result = await ctx.teamsService.deleteTeamAgent({
      leadAgentId: agentCtx.agent.id,
      projectId: agentCtx.project.id,
      name: parsed.name,
      teamName: parsed.teamName,
    });
    if ('error' in result) return { success: false, error: result.error };
    return {
      success: true,
      data: { deletedAgentId: result.result.deletedAgentId, deleted: true },
    };
  } catch (error) {
    return catchTeamsUnavailable(error);
  }
}

async function buildTeamMembers(
  ctx: TeamsToolContext,
  members: Array<{ agentId: string }>,
  teamLeadAgentId: string | null,
): Promise<TeamMemberSummary[]> {
  const agentIds = new Set(members.map((m) => m.agentId));
  const agentNameById = await resolveAgentNames(ctx.storage, agentIds);

  return members.map((member) => ({
    agentId: member.agentId,
    agentName: agentNameById.get(member.agentId) ?? member.agentId,
    isTeamLead: member.agentId === teamLeadAgentId,
  }));
}

export async function handleDevchainTeam(
  ctx: TeamsToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as DevchainTeamParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const sessionCtx = sessionCtxResult.data as SessionContext;

  if (sessionCtx.type === 'guest') {
    return {
      success: false,
      error: { code: 'GUEST_NOT_SUPPORTED', message: 'This tool is only available to agents' },
    };
  }

  const agentCtx = sessionCtx as AgentSessionContext;
  const { project, agent } = agentCtx;
  if (!project || !agent) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project or agent associated with this session',
      },
    };
  }

  try {
    let teamId: string;

    if (validated.teamName) {
      const team = await ctx.teamsService.findTeamByExactName(project.id, validated.teamName);
      if (!team) {
        return {
          success: false,
          error: { code: 'TEAM_NOT_FOUND', message: `Team "${validated.teamName}" not found` },
        };
      }
      const detail = await ctx.teamsService.getTeam(team.id);
      if (!detail) {
        return {
          success: false,
          error: { code: 'TEAM_NOT_FOUND', message: `Team "${validated.teamName}" not found` },
        };
      }
      const isMember = detail.members.some((m) => m.agentId === agent.id);
      if (!isMember) {
        return {
          success: false,
          error: { code: 'NOT_A_MEMBER', message: 'You are not a member of this team' },
        };
      }
      teamId = team.id;
    } else {
      const teams = await ctx.teamsService.listTeamsByAgent(agent.id);
      if (teams.length === 0) {
        return {
          success: false,
          error: { code: 'NOT_IN_ANY_TEAM', message: 'You do not belong to any team' },
        };
      }
      if (teams.length > 1) {
        return {
          success: false,
          error: {
            code: 'AMBIGUOUS_TEAM',
            message: `You belong to ${teams.length} teams. Specify teamName to disambiguate.`,
            data: { candidates: teams.map((t) => ({ teamName: t.name })) },
          },
        };
      }
      teamId = teams[0].id;
    }

    const detail = await ctx.teamsService.getTeam(teamId);
    if (!detail) {
      return {
        success: false,
        error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' },
      };
    }

    const memberAgentIds = new Set(detail.members.map((m) => m.agentId));
    const agentNameById = await resolveAgentNames(ctx.storage, memberAgentIds);

    const members: DevchainTeamMemberProjection[] = [];
    for (const m of detail.members) {
      let agentDescription: string | null = null;
      let profileId: string | null = null;
      let profileName: string | null = null;
      let providerConfigId: string | null = null;
      let providerConfigName: string | null = null;

      const agentName = agentNameById.get(m.agentId) ?? m.agentId;

      try {
        const agentRecord = await ctx.storage.getAgent(m.agentId);
        agentDescription = agentRecord.description;
        profileId = agentRecord.profileId;
        providerConfigId = agentRecord.providerConfigId;

        if (profileId) {
          try {
            const profile = await ctx.storage.getAgentProfile(profileId);
            profileName = profile.name;
          } catch {
            /* best-effort */
          }
        }
        if (providerConfigId) {
          try {
            const config = await ctx.storage.getProfileProviderConfig(providerConfigId);
            providerConfigName = config.name;
          } catch {
            /* best-effort */
          }
        }
      } catch {
        /* agent lookup failed — use agentId as name */
      }

      members.push({
        agentId: m.agentId,
        agentName,
        description: agentDescription,
        isLead: m.agentId === detail.teamLeadAgentId,
        profileId,
        profileName,
        providerConfigId,
        providerConfigName,
      });
    }

    const busyMembersCount = await ctx.teamsService.countBusyTeamMembers(
      teamId,
      detail.teamLeadAgentId,
    );
    const currentMemberCount = members.filter((m) => !m.isLead).length;
    const leadMember = members.find((m) => m.isLead);

    const response: DevchainTeamResponse = {
      id: detail.id,
      name: detail.name,
      description: detail.description,
      teamLeadAgentId: detail.teamLeadAgentId,
      teamLeadAgentName: leadMember?.agentName ?? null,
      members,
      maxMembers: detail.maxMembers,
      maxConcurrentTasks: detail.maxConcurrentTasks,
      allowTeamLeadCreateAgents: detail.allowTeamLeadCreateAgents,
      currentMemberCount,
      busyMembersCount,
      freeSeats: Math.max(0, detail.maxMembers - currentMemberCount),
      freeConcurrentSlots: Math.max(0, detail.maxConcurrentTasks - busyMembersCount),
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
    };

    return { success: true, data: response };
  } catch (error) {
    return catchTeamsUnavailable(error);
  }
}
