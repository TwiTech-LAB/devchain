import {
  type McpResponse,
  TeamsListParamsSchema,
  type ListTeamsResponse,
  type TeamSummary,
  TeamsMembersListParamsSchema,
  type ListTeamMembersResponse,
  type TeamMembersEntry,
  type TeamMemberSummary,
  type SessionContext,
  type AgentSessionContext,
  TeamsConfigsListParamsSchema,
  TeamsCreateAgentParamsSchema,
  TeamsDeleteAgentParamsSchema,
  DevchainTeamParamsSchema,
  type DevchainTeamResponse,
  type DevchainTeamMemberProjection,
} from '../../dtos/mcp.dto';
import type { McpToolContext } from './types';

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

function teamsServiceUnavailable(): McpResponse {
  return {
    success: false,
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Teams operations require full app context (not available in standalone MCP mode)',
    },
  };
}

export async function handleTeamsList(ctx: McpToolContext, params: unknown): Promise<McpResponse> {
  if (!ctx.teamsService) {
    return teamsServiceUnavailable();
  }

  const validated = TeamsListParamsSchema.parse(params);

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const { project } = sessionCtxResult.data as SessionContext;

  if (!project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

  const limit = validated.limit ?? 100;
  const offset = validated.offset ?? 0;

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
}

export async function handleTeamsMembersList(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  if (!ctx.teamsService) {
    return teamsServiceUnavailable();
  }

  const validated = TeamsMembersListParamsSchema.parse(params);

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

  if (validated.teamId) {
    // Explicit team lookup — validate project boundary
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

  // No teamId — behavior depends on session context type
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
}

export async function handleTeamsConfigsList(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  if (!ctx.teamsService) {
    return teamsServiceUnavailable();
  }

  const parsed = TeamsConfigsListParamsSchema.parse(params);

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

  const result = await ctx.teamsService.listConfigsVisibleToLead(
    agentCtx.agent.id,
    agentCtx.project.id,
  );
  if ('error' in result) return { success: false, error: result.error };
  return { success: true, data: { configs: result } };
}

export async function handleTeamsCreateAgent(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  if (!ctx.teamsService) {
    return teamsServiceUnavailable();
  }

  const parsed = TeamsCreateAgentParamsSchema.parse(params);

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
  return { success: true, data: result };
}

export async function handleTeamsDeleteAgent(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  if (!ctx.teamsService) {
    return teamsServiceUnavailable();
  }

  const parsed = TeamsDeleteAgentParamsSchema.parse(params);

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

  const result = await ctx.teamsService.deleteTeamAgent({
    leadAgentId: agentCtx.agent.id,
    projectId: agentCtx.project.id,
    name: parsed.name,
    teamName: parsed.teamName,
  });
  if ('error' in result) return { success: false, error: result.error };
  return { success: true, data: result.result };
}

async function buildTeamMembers(
  ctx: McpToolContext,
  members: Array<{ agentId: string }>,
  teamLeadAgentId: string | null,
): Promise<TeamMemberSummary[]> {
  const result: TeamMemberSummary[] = [];

  for (const member of members) {
    let agentName = member.agentId;
    try {
      const agent = await ctx.storage.getAgent(member.agentId);
      agentName = agent.name;
    } catch {
      // Agent may have been deleted; use ID as fallback
    }

    result.push({
      agentId: member.agentId,
      agentName,
      isTeamLead: member.agentId === teamLeadAgentId,
    });
  }

  return result;
}

export async function handleDevchainTeam(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  if (!ctx.teamsService) {
    return teamsServiceUnavailable();
  }

  const validated = DevchainTeamParamsSchema.parse(params);

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

  const members: DevchainTeamMemberProjection[] = [];
  for (const m of detail.members) {
    let agentName = m.agentId;
    let profileId: string | null = null;
    let profileName: string | null = null;
    let providerConfigId: string | null = null;
    let providerConfigName: string | null = null;

    try {
      const agentRecord = await ctx.storage.getAgent(m.agentId);
      agentName = agentRecord.name;
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
}
