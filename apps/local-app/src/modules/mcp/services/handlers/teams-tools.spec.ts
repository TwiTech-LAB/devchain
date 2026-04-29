import {
  handleTeamsList,
  handleTeamsMembersList,
  handleTeamsConfigsList,
  handleTeamsCreateAgent,
  handleTeamsDeleteAgent,
  handleDevchainTeam,
} from './teams-tools';
import type { McpToolContext } from './types';
import type { AgentSessionContext, GuestSessionContext } from '../../dtos/mcp.dto';
import { TeamsCreateAgentParamsSchema } from '../../dtos/mcp.dto';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

// ── Helpers ────────────────────────────────────────────

const PROJECT_ID = '00000000-0000-0000-0000-000000000001';
const AGENT_ID = '00000000-0000-0000-0000-000000000010';
const AGENT_NAME = 'Agent-A';
const TEAM_ID = '00000000-0000-0000-0000-000000000100';
const TEAM_NAME = 'Backend Team';
const LEAD_AGENT_ID = AGENT_ID;
const MEMBER_AGENT_ID = '00000000-0000-0000-0000-000000000020';
const MEMBER_AGENT_NAME = 'Agent-B';

function makeAgentSessionContext(): AgentSessionContext {
  return {
    type: 'agent',
    session: {
      id: 'sess-001',
      agentId: AGENT_ID,
      status: 'active',
      startedAt: new Date().toISOString(),
    },
    agent: { id: AGENT_ID, name: AGENT_NAME, projectId: PROJECT_ID },
    project: { id: PROJECT_ID, name: 'Test Project', rootPath: '/tmp/test' },
  };
}

function makeGuestSessionContext(): GuestSessionContext {
  return {
    type: 'guest',
    guest: { id: 'guest-001', name: 'Guest-A', projectId: PROJECT_ID, tmuxSessionId: 'tmux-001' },
    project: { id: PROJECT_ID, name: 'Test Project', rootPath: '/tmp/test' },
  };
}

function makeCtx(overrides: Partial<McpToolContext> = {}): McpToolContext {
  return {
    storage: {
      getAgent: jest.fn().mockImplementation((id: string) => {
        if (id === AGENT_ID)
          return Promise.resolve({ id: AGENT_ID, name: AGENT_NAME, projectId: PROJECT_ID });
        if (id === MEMBER_AGENT_ID)
          return Promise.resolve({
            id: MEMBER_AGENT_ID,
            name: MEMBER_AGENT_NAME,
            projectId: PROJECT_ID,
          });
        return Promise.reject(new Error('Agent not found'));
      }),
    } as never,
    teamsService: {
      listTeams: jest.fn().mockResolvedValue({
        items: [
          {
            id: TEAM_ID,
            name: TEAM_NAME,
            description: 'The backend squad',
            teamLeadAgentId: LEAD_AGENT_ID,
            teamLeadAgentName: AGENT_NAME,
            memberCount: 2,
            projectId: PROJECT_ID,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      }),
      getTeam: jest.fn().mockResolvedValue({
        id: TEAM_ID,
        name: TEAM_NAME,
        description: 'The backend squad',
        teamLeadAgentId: LEAD_AGENT_ID,
        projectId: PROJECT_ID,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        members: [
          { agentId: AGENT_ID, teamId: TEAM_ID, createdAt: new Date().toISOString() },
          { agentId: MEMBER_AGENT_ID, teamId: TEAM_ID, createdAt: new Date().toISOString() },
        ],
      }),
      listTeamsByAgent: jest.fn().mockResolvedValue([
        {
          id: TEAM_ID,
          name: TEAM_NAME,
          description: 'The backend squad',
          teamLeadAgentId: LEAD_AGENT_ID,
          projectId: PROJECT_ID,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
      listConfigsVisibleToLead: jest.fn().mockResolvedValue([
        {
          configName: 'claude-sonnet',
          description: 'Sonnet config',
          profileName: 'Default Profile',
          teamName: TEAM_NAME,
        },
      ]),
      createTeamAgent: jest.fn().mockResolvedValue({
        agent: {
          id: 'new-agent-id',
          name: 'New Agent',
          description: 'Does things',
          profileName: 'Default Profile',
          configName: 'claude-sonnet',
        },
        teamName: TEAM_NAME,
      }),
      deleteTeamAgent: jest.fn().mockResolvedValue({
        result: {
          deletedAgentId: MEMBER_AGENT_ID,
          deletedAgentName: MEMBER_AGENT_NAME,
          teamName: TEAM_NAME,
        },
      }),
    } as never,
    resolveSessionContext: jest.fn().mockResolvedValue({
      success: true,
      data: makeAgentSessionContext(),
    }),
    ...overrides,
  };
}

// ── handleTeamsList ────────────────────────────────────

describe('handleTeamsList', () => {
  it('returns teams for a valid session', async () => {
    const ctx = makeCtx();
    const result = await handleTeamsList(ctx, { sessionId: 'abcd1234' });

    expect(result.success).toBe(true);
    const data = result.data as { teams: unknown[]; total: number; limit: number; offset: number };
    expect(data.teams).toHaveLength(1);
    expect(data.total).toBe(1);
    expect(data.limit).toBe(100);
    expect(data.offset).toBe(0);

    const team = (data.teams as Array<Record<string, unknown>>)[0];
    expect(team.id).toBe(TEAM_ID);
    expect(team.name).toBe(TEAM_NAME);
    expect(team.teamLeadAgentId).toBe(LEAD_AGENT_ID);
    expect(team.teamLeadName).toBe(AGENT_NAME);
    expect(team.memberCount).toBe(2);
  });

  it('passes q parameter to service for server-side filtering', async () => {
    const ctx = makeCtx();
    await handleTeamsList(ctx, { sessionId: 'abcd1234', q: 'backend' });

    expect((ctx.teamsService as { listTeams: jest.Mock }).listTeams).toHaveBeenCalledWith(
      PROJECT_ID,
      { limit: 100, offset: 0, q: 'backend' },
    );
  });

  it('returns correct total from service when q is provided', async () => {
    const ctx = makeCtx();
    // Mock service returning filtered results with correct total
    (ctx.teamsService as { listTeams: jest.Mock }).listTeams.mockResolvedValueOnce({
      items: [
        {
          id: TEAM_ID,
          name: TEAM_NAME,
          description: 'The backend squad',
          teamLeadAgentId: LEAD_AGENT_ID,
          teamLeadAgentName: AGENT_NAME,
          memberCount: 2,
          projectId: PROJECT_ID,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      total: 1,
      limit: 100,
      offset: 0,
    });

    const result = await handleTeamsList(ctx, { sessionId: 'abcd1234', q: 'backend' });

    expect(result.success).toBe(true);
    const data = result.data as { teams: unknown[]; total: number };
    expect(data.teams).toHaveLength(1);
    expect(data.total).toBe(1);
  });

  it('q + pagination: total reflects all matching teams, not just current page', async () => {
    const ctx = makeCtx();
    // Simulate: 5 teams total, q matches 3, limit=2 offset=0 → page has 2, total=3
    (ctx.teamsService as { listTeams: jest.Mock }).listTeams.mockResolvedValueOnce({
      items: [
        {
          id: 'team-a',
          name: 'Alpha Team',
          description: null,
          teamLeadAgentId: LEAD_AGENT_ID,
          teamLeadAgentName: AGENT_NAME,
          memberCount: 1,
          projectId: PROJECT_ID,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'team-b',
          name: 'Beta Team',
          description: null,
          teamLeadAgentId: LEAD_AGENT_ID,
          teamLeadAgentName: AGENT_NAME,
          memberCount: 1,
          projectId: PROJECT_ID,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      total: 3,
      limit: 2,
      offset: 0,
    });

    const result = await handleTeamsList(ctx, {
      sessionId: 'abcd1234',
      q: 'team',
      limit: 2,
      offset: 0,
    });

    expect(result.success).toBe(true);
    const data = result.data as { teams: unknown[]; total: number; limit: number; offset: number };
    expect(data.teams).toHaveLength(2);
    expect(data.total).toBe(3);
    expect(data.limit).toBe(2);
    expect(data.offset).toBe(0);

    expect((ctx.teamsService as { listTeams: jest.Mock }).listTeams).toHaveBeenCalledWith(
      PROJECT_ID,
      { limit: 2, offset: 0, q: 'team' },
    );
  });

  it('respects custom limit and offset', async () => {
    const ctx = makeCtx();
    await handleTeamsList(ctx, { sessionId: 'abcd1234', limit: 5, offset: 10 });

    expect((ctx.teamsService as { listTeams: jest.Mock }).listTeams).toHaveBeenCalledWith(
      PROJECT_ID,
      { limit: 5, offset: 10, q: undefined },
    );
  });

  it('returns SERVICE_UNAVAILABLE when teamsService is undefined', async () => {
    const ctx = makeCtx({ teamsService: undefined });
    const result = await handleTeamsList(ctx, { sessionId: 'abcd1234' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('returns PROJECT_NOT_FOUND when session has no project', async () => {
    const noProjectCtx: AgentSessionContext = {
      ...makeAgentSessionContext(),
      project: null,
    };
    const ctx = makeCtx({
      resolveSessionContext: jest.fn().mockResolvedValue({ success: true, data: noProjectCtx }),
    });
    const result = await handleTeamsList(ctx, { sessionId: 'abcd1234' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PROJECT_NOT_FOUND');
  });

  it('propagates session resolution failure', async () => {
    const ctx = makeCtx({
      resolveSessionContext: jest.fn().mockResolvedValue({
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'Not found' },
      }),
    });
    const result = await handleTeamsList(ctx, { sessionId: 'abcd1234' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SESSION_NOT_FOUND');
  });

  it('throws on invalid params (missing sessionId)', async () => {
    const ctx = makeCtx();
    await expect(handleTeamsList(ctx, {})).rejects.toThrow();
  });

  it('throws on unknown params (strict mode)', async () => {
    const ctx = makeCtx();
    await expect(handleTeamsList(ctx, { sessionId: 'abcd1234', bogus: true })).rejects.toThrow();
  });
});

// ── handleTeamsMembersList ──────────────────────────────

describe('handleTeamsMembersList', () => {
  describe('with teamId', () => {
    it('returns team members for a valid teamId', async () => {
      const ctx = makeCtx();
      const result = await handleTeamsMembersList(ctx, {
        sessionId: 'abcd1234',
        teamId: TEAM_ID,
      });

      expect(result.success).toBe(true);
      const data = result.data as {
        teams: Array<{ teamId: string; teamName: string; members: unknown[] }>;
      };
      expect(data.teams).toHaveLength(1);
      expect(data.teams[0].teamId).toBe(TEAM_ID);
      expect(data.teams[0].teamName).toBe(TEAM_NAME);
      expect(data.teams[0].members).toHaveLength(2);

      const members = data.teams[0].members as Array<{
        agentId: string;
        agentName: string;
        isTeamLead: boolean;
      }>;
      const lead = members.find((m) => m.agentId === AGENT_ID);
      expect(lead?.isTeamLead).toBe(true);
      expect(lead?.agentName).toBe(AGENT_NAME);

      const member = members.find((m) => m.agentId === MEMBER_AGENT_ID);
      expect(member?.isTeamLead).toBe(false);
      expect(member?.agentName).toBe(MEMBER_AGENT_NAME);
    });

    it('returns TEAM_NOT_FOUND when team does not exist', async () => {
      const ctx = makeCtx();
      (ctx.teamsService as { getTeam: jest.Mock }).getTeam.mockResolvedValueOnce(null);

      const result = await handleTeamsMembersList(ctx, {
        sessionId: 'abcd1234',
        teamId: '00000000-0000-0000-0000-000000000099',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TEAM_NOT_FOUND');
    });

    it('returns members with no team lead when teamLeadAgentId is null', async () => {
      const ctx = makeCtx();
      (ctx.teamsService as { getTeam: jest.Mock }).getTeam.mockResolvedValueOnce({
        id: TEAM_ID,
        name: TEAM_NAME,
        description: 'The backend squad',
        teamLeadAgentId: null,
        projectId: PROJECT_ID,
        members: [
          { agentId: AGENT_ID, teamId: TEAM_ID, createdAt: new Date().toISOString() },
          { agentId: MEMBER_AGENT_ID, teamId: TEAM_ID, createdAt: new Date().toISOString() },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = await handleTeamsMembersList(ctx, {
        sessionId: 'abcd1234',
        teamId: TEAM_ID,
      });

      expect(result.success).toBe(true);
      const data = result.data as {
        teams: Array<{ members: Array<{ agentId: string; isTeamLead: boolean }> }>;
      };
      expect(data.teams).toHaveLength(1);
      expect(data.teams[0].members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentId: AGENT_ID, isTeamLead: false }),
          expect.objectContaining({ agentId: MEMBER_AGENT_ID, isTeamLead: false }),
        ]),
      );
    });

    it('blocks cross-project team access (returns TEAM_NOT_FOUND)', async () => {
      const otherTeamId = '00000000-0000-0000-0000-000000000999';
      const crossProjectTeam = {
        id: otherTeamId,
        name: 'Other Team',
        teamLeadAgentId: '00000000-0000-0000-0000-000000000888',
        projectId: '00000000-0000-0000-0000-000000000002', // Different project!
        members: [
          {
            agentId: '00000000-0000-0000-0000-000000000888',
            teamId: otherTeamId,
            createdAt: new Date().toISOString(),
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const ctx = makeCtx();
      (ctx.teamsService as { getTeam: jest.Mock }).getTeam.mockResolvedValueOnce(crossProjectTeam);

      const result = await handleTeamsMembersList(ctx, {
        sessionId: 'abcd1234',
        teamId: otherTeamId,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TEAM_NOT_FOUND');
      expect(result.error?.message).toContain('does not belong to the resolved project');
    });
  });

  describe('without teamId (agent context)', () => {
    it('returns all teams the agent belongs to with members', async () => {
      const ctx = makeCtx();
      const result = await handleTeamsMembersList(ctx, { sessionId: 'abcd1234' });

      expect(result.success).toBe(true);
      const data = result.data as { teams: Array<{ teamId: string; members: unknown[] }> };
      expect(data.teams).toHaveLength(1);
      expect(data.teams[0].teamId).toBe(TEAM_ID);
      expect(data.teams[0].members).toHaveLength(2);

      expect(
        (ctx.teamsService as { listTeamsByAgent: jest.Mock }).listTeamsByAgent,
      ).toHaveBeenCalledWith(AGENT_ID);
    });

    it('returns empty teams array when agent has no team membership', async () => {
      const ctx = makeCtx();
      (ctx.teamsService as { listTeamsByAgent: jest.Mock }).listTeamsByAgent.mockResolvedValueOnce(
        [],
      );

      const result = await handleTeamsMembersList(ctx, { sessionId: 'abcd1234' });

      expect(result.success).toBe(true);
      const data = result.data as { teams: unknown[] };
      expect(data.teams).toHaveLength(0);
    });

    it('returns no team lead flags when an agent team has no lead', async () => {
      const ctx = makeCtx();
      (ctx.teamsService as { listTeamsByAgent: jest.Mock }).listTeamsByAgent.mockResolvedValueOnce([
        {
          id: TEAM_ID,
          name: TEAM_NAME,
          description: 'The backend squad',
          teamLeadAgentId: null,
          projectId: PROJECT_ID,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);
      (ctx.teamsService as { getTeam: jest.Mock }).getTeam.mockResolvedValueOnce({
        id: TEAM_ID,
        name: TEAM_NAME,
        description: 'The backend squad',
        teamLeadAgentId: null,
        projectId: PROJECT_ID,
        members: [
          { agentId: AGENT_ID, teamId: TEAM_ID, createdAt: new Date().toISOString() },
          { agentId: MEMBER_AGENT_ID, teamId: TEAM_ID, createdAt: new Date().toISOString() },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = await handleTeamsMembersList(ctx, { sessionId: 'abcd1234' });

      expect(result.success).toBe(true);
      const data = result.data as {
        teams: Array<{ members: Array<{ agentId: string; isTeamLead: boolean }> }>;
      };
      expect(data.teams).toHaveLength(1);
      expect(data.teams[0].members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentId: AGENT_ID, isTeamLead: false }),
          expect.objectContaining({ agentId: MEMBER_AGENT_ID, isTeamLead: false }),
        ]),
      );
    });
  });

  describe('without teamId (guest context)', () => {
    it('returns AGENT_CONTEXT_REQUIRED error', async () => {
      const ctx = makeCtx({
        resolveSessionContext: jest.fn().mockResolvedValue({
          success: true,
          data: makeGuestSessionContext(),
        }),
      });

      const result = await handleTeamsMembersList(ctx, { sessionId: 'abcd1234' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('AGENT_CONTEXT_REQUIRED');
      expect(result.error?.message).toContain('Guest sessions must provide teamId');
    });

    it('succeeds for guest when teamId is provided', async () => {
      const ctx = makeCtx({
        resolveSessionContext: jest.fn().mockResolvedValue({
          success: true,
          data: makeGuestSessionContext(),
        }),
      });

      const result = await handleTeamsMembersList(ctx, {
        sessionId: 'abcd1234',
        teamId: TEAM_ID,
      });

      expect(result.success).toBe(true);
      const data = result.data as { teams: Array<{ teamId: string }> };
      expect(data.teams[0].teamId).toBe(TEAM_ID);
    });
  });

  describe('error handling', () => {
    it('returns SERVICE_UNAVAILABLE when teamsService is undefined', async () => {
      const ctx = makeCtx({ teamsService: undefined });
      const result = await handleTeamsMembersList(ctx, { sessionId: 'abcd1234' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('returns PROJECT_NOT_FOUND when session has no project', async () => {
      const noProjectCtx: AgentSessionContext = {
        ...makeAgentSessionContext(),
        project: null,
      };
      const ctx = makeCtx({
        resolveSessionContext: jest.fn().mockResolvedValue({ success: true, data: noProjectCtx }),
      });
      const result = await handleTeamsMembersList(ctx, { sessionId: 'abcd1234' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROJECT_NOT_FOUND');
    });

    it('throws on invalid params (missing sessionId)', async () => {
      const ctx = makeCtx();
      await expect(handleTeamsMembersList(ctx, {})).rejects.toThrow();
    });

    it('throws on unknown params (strict mode)', async () => {
      const ctx = makeCtx();
      await expect(
        handleTeamsMembersList(ctx, { sessionId: 'abcd1234', bogusField: 'nope' }),
      ).rejects.toThrow();
    });

    it('falls back to agentId as name when getAgent fails', async () => {
      const unknownAgentId = '00000000-0000-0000-0000-000000000777';
      const ctx = makeCtx();
      (ctx.teamsService as { getTeam: jest.Mock }).getTeam.mockResolvedValueOnce({
        id: TEAM_ID,
        name: TEAM_NAME,
        teamLeadAgentId: unknownAgentId,
        projectId: PROJECT_ID,
        members: [
          { agentId: unknownAgentId, teamId: TEAM_ID, createdAt: new Date().toISOString() },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = await handleTeamsMembersList(ctx, {
        sessionId: 'abcd1234',
        teamId: TEAM_ID,
      });

      expect(result.success).toBe(true);
      const data = result.data as {
        teams: Array<{ members: Array<{ agentId: string; agentName: string }> }>;
      };
      // Name should fall back to the agentId
      expect(data.teams[0].members[0].agentName).toBe(unknownAgentId);
    });
  });
});

// ── handleTeamsConfigsList ────────────────────────────────

describe('handleTeamsConfigsList', () => {
  it('returns configs for a team lead', async () => {
    const ctx = makeCtx();
    const result = await handleTeamsConfigsList(ctx, { sessionId: 'abcd1234' });

    expect(result.success).toBe(true);
    const data = result.data as {
      configs: Array<{
        configName: string;
        description: string;
        profileName: string;
        teamName: string;
      }>;
    };
    expect(data.configs).toHaveLength(1);
    expect(data.configs[0].configName).toBe('claude-sonnet');
    expect(data.configs[0].teamName).toBe(TEAM_NAME);

    expect(
      (ctx.teamsService as { listConfigsVisibleToLead: jest.Mock }).listConfigsVisibleToLead,
    ).toHaveBeenCalledWith(AGENT_ID, PROJECT_ID);
  });

  it('returns AGENT_CONTEXT_REQUIRED for guest sessions', async () => {
    const ctx = makeCtx({
      resolveSessionContext: jest.fn().mockResolvedValue({
        success: true,
        data: makeGuestSessionContext(),
      }),
    });
    const result = await handleTeamsConfigsList(ctx, { sessionId: 'abcd1234' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AGENT_CONTEXT_REQUIRED');
  });

  it('returns FORBIDDEN_NOT_TEAM_LEAD when caller leads no teams', async () => {
    const ctx = makeCtx();
    (
      ctx.teamsService as { listConfigsVisibleToLead: jest.Mock }
    ).listConfigsVisibleToLead.mockResolvedValueOnce({
      error: { code: 'FORBIDDEN_NOT_TEAM_LEAD', message: 'You do not lead any teams' },
    });
    const result = await handleTeamsConfigsList(ctx, { sessionId: 'abcd1234' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN_NOT_TEAM_LEAD');
  });

  it('returns SERVICE_UNAVAILABLE when teamsService undefined', async () => {
    const ctx = makeCtx({ teamsService: undefined });
    const result = await handleTeamsConfigsList(ctx, { sessionId: 'abcd1234' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('returns PROJECT_NOT_FOUND when no project', async () => {
    const noProjectCtx: AgentSessionContext = {
      ...makeAgentSessionContext(),
      project: null,
    };
    const ctx = makeCtx({
      resolveSessionContext: jest.fn().mockResolvedValue({ success: true, data: noProjectCtx }),
    });
    const result = await handleTeamsConfigsList(ctx, { sessionId: 'abcd1234' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PROJECT_NOT_FOUND');
  });

  it('throws on invalid params (strict mode)', async () => {
    const ctx = makeCtx();
    await expect(
      handleTeamsConfigsList(ctx, { sessionId: 'abcd1234', extra: 'nope' }),
    ).rejects.toThrow();
  });
});

// ── handleTeamsCreateAgent ────────────────────────────────

describe('handleTeamsCreateAgent', () => {
  const validParams = {
    sessionId: 'abcd1234',
    name: 'New Agent',
    description: 'Does things',
    configName: 'claude-sonnet',
  };

  it('creates agent successfully with single team', async () => {
    const ctx = makeCtx();
    const result = await handleTeamsCreateAgent(ctx, validParams);

    expect(result.success).toBe(true);
    const data = result.data as {
      agent: {
        id: string;
        name: string;
        description: string;
        profileName: string;
        configName: string;
      };
      teamName: string;
    };
    expect(data.agent.id).toBe('new-agent-id');
    expect(data.agent.name).toBe('New Agent');
    expect(data.teamName).toBe(TEAM_NAME);

    expect(
      (ctx.teamsService as { createTeamAgent: jest.Mock }).createTeamAgent,
    ).toHaveBeenCalledWith({
      leadAgentId: AGENT_ID,
      projectId: PROJECT_ID,
      name: 'New Agent',
      description: 'Does things',
      configName: 'claude-sonnet',
      profileName: undefined,
      teamName: undefined,
    });
  });

  it('returns AGENT_CONTEXT_REQUIRED for guest sessions', async () => {
    const ctx = makeCtx({
      resolveSessionContext: jest.fn().mockResolvedValue({
        success: true,
        data: makeGuestSessionContext(),
      }),
    });
    const result = await handleTeamsCreateAgent(ctx, validParams);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AGENT_CONTEXT_REQUIRED');
  });

  it('returns FORBIDDEN_NOT_TEAM_LEAD when caller leads no teams', async () => {
    const ctx = makeCtx();
    (ctx.teamsService as { createTeamAgent: jest.Mock }).createTeamAgent.mockResolvedValueOnce({
      error: { code: 'FORBIDDEN_NOT_TEAM_LEAD', message: 'You do not lead any teams' },
    });
    const result = await handleTeamsCreateAgent(ctx, validParams);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN_NOT_TEAM_LEAD');
  });

  it('returns AMBIGUOUS_TEAM_LEAD when leading multiple teams without teamName', async () => {
    const ctx = makeCtx();
    (ctx.teamsService as { createTeamAgent: jest.Mock }).createTeamAgent.mockResolvedValueOnce({
      error: {
        code: 'AMBIGUOUS_TEAM_LEAD',
        message: 'You lead multiple teams. Specify teamName to disambiguate.',
        data: { candidates: [{ teamName: 'Team A' }, { teamName: 'Team B' }] },
      },
    });
    const result = await handleTeamsCreateAgent(ctx, validParams);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AMBIGUOUS_TEAM_LEAD');
  });

  it('resolves correct team when teamName provided', async () => {
    const ctx = makeCtx();
    await handleTeamsCreateAgent(ctx, { ...validParams, teamName: TEAM_NAME });

    expect(
      (ctx.teamsService as { createTeamAgent: jest.Mock }).createTeamAgent,
    ).toHaveBeenCalledWith(expect.objectContaining({ teamName: TEAM_NAME }));
  });

  it('returns TEAM_NOT_FOUND_OR_NOT_LED for wrong teamName', async () => {
    const ctx = makeCtx();
    (ctx.teamsService as { createTeamAgent: jest.Mock }).createTeamAgent.mockResolvedValueOnce({
      error: {
        code: 'TEAM_NOT_FOUND_OR_NOT_LED',
        message: 'No team named "Wrong" found among teams you lead',
      },
    });
    const result = await handleTeamsCreateAgent(ctx, { ...validParams, teamName: 'Wrong' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TEAM_NOT_FOUND_OR_NOT_LED');
  });

  it('returns CONFIG_NOT_FOUND when no matching config', async () => {
    const ctx = makeCtx();
    (ctx.teamsService as { createTeamAgent: jest.Mock }).createTeamAgent.mockResolvedValueOnce({
      error: {
        code: 'CONFIG_NOT_FOUND',
        message: 'No provider configuration named "missing" found for this team',
      },
    });
    const result = await handleTeamsCreateAgent(ctx, { ...validParams, configName: 'missing' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CONFIG_NOT_FOUND');
  });

  it('returns AMBIGUOUS_CONFIG_NAME when multiple configs match without profileName', async () => {
    const ctx = makeCtx();
    (ctx.teamsService as { createTeamAgent: jest.Mock }).createTeamAgent.mockResolvedValueOnce({
      error: {
        code: 'AMBIGUOUS_CONFIG_NAME',
        message: 'Multiple configurations found. Specify profileName.',
        data: {
          candidates: [
            { configName: 'claude-sonnet', profileName: 'Profile A' },
            { configName: 'claude-sonnet', profileName: 'Profile B' },
          ],
        },
      },
    });
    const result = await handleTeamsCreateAgent(ctx, validParams);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AMBIGUOUS_CONFIG_NAME');
  });

  it('resolves config with profileName disambiguator', async () => {
    const ctx = makeCtx();
    await handleTeamsCreateAgent(ctx, { ...validParams, profileName: 'Default Profile' });

    expect(
      (ctx.teamsService as { createTeamAgent: jest.Mock }).createTeamAgent,
    ).toHaveBeenCalledWith(expect.objectContaining({ profileName: 'Default Profile' }));
  });

  it('returns AGENT_NAME_EXISTS for duplicate name', async () => {
    const ctx = makeCtx();
    (ctx.teamsService as { createTeamAgent: jest.Mock }).createTeamAgent.mockResolvedValueOnce({
      error: {
        code: 'AGENT_NAME_EXISTS',
        message: 'An agent named "New Agent" already exists in this project',
      },
    });
    const result = await handleTeamsCreateAgent(ctx, validParams);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AGENT_NAME_EXISTS');
  });

  it('returns SERVICE_UNAVAILABLE when teamsService undefined', async () => {
    const ctx = makeCtx({ teamsService: undefined });
    const result = await handleTeamsCreateAgent(ctx, validParams);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('rejects whitespace-only description (Zod validation)', async () => {
    const ctx = makeCtx();
    await expect(
      handleTeamsCreateAgent(ctx, { ...validParams, description: '   ' }),
    ).rejects.toThrow();
  });

  it('throws on unknown params (strict mode)', async () => {
    const ctx = makeCtx();
    await expect(handleTeamsCreateAgent(ctx, { ...validParams, bogus: 'nope' })).rejects.toThrow();
  });

  it('creates agent without description (inherits from config)', async () => {
    const ctx = makeCtx();
    const paramsNoDesc = {
      sessionId: 'abcd1234',
      name: 'No Desc Agent',
      configName: 'claude-sonnet',
    };

    const result = await handleTeamsCreateAgent(ctx, paramsNoDesc);

    expect(result.success).toBe(true);
    expect(ctx.teamsService.createTeamAgent).toHaveBeenCalledWith(
      expect.objectContaining({ description: undefined }),
    );
  });

  it('creates agent with explicit description (no regression)', async () => {
    const ctx = makeCtx();
    const result = await handleTeamsCreateAgent(ctx, validParams);

    expect(result.success).toBe(true);
    expect(ctx.teamsService.createTeamAgent).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Does things' }),
    );
  });
});

describe('TeamsCreateAgentParamsSchema trim-order validation', () => {
  const base = {
    sessionId: 'abcd1234',
    name: 'ValidAgent',
    description: 'Valid description',
    configName: 'claude-config',
  };

  it('rejects whitespace-only name', () => {
    expect(() => TeamsCreateAgentParamsSchema.parse({ ...base, name: '   ' })).toThrow(
      /Name is required/,
    );
  });

  it('rejects whitespace-only configName', () => {
    expect(() => TeamsCreateAgentParamsSchema.parse({ ...base, configName: '   ' })).toThrow(
      /configName is required/,
    );
  });

  it('rejects whitespace-only profileName', () => {
    expect(() => TeamsCreateAgentParamsSchema.parse({ ...base, profileName: '   ' })).toThrow(
      /profileName must not be whitespace-only/,
    );
  });

  it('rejects whitespace-only teamName', () => {
    expect(() => TeamsCreateAgentParamsSchema.parse({ ...base, teamName: '   ' })).toThrow(
      /teamName must not be whitespace-only/,
    );
  });

  it('trims valid non-whitespace strings', () => {
    const result = TeamsCreateAgentParamsSchema.parse({
      ...base,
      name: '  My Agent  ',
      configName: '  claude  ',
      profileName: '  Default  ',
      teamName: '  Backend  ',
    });
    expect(result.name).toBe('My Agent');
    expect(result.configName).toBe('claude');
    expect(result.profileName).toBe('Default');
    expect(result.teamName).toBe('Backend');
  });

  it('accepts valid inputs without optional fields', () => {
    const result = TeamsCreateAgentParamsSchema.parse(base);
    expect(result.name).toBe('ValidAgent');
    expect(result.profileName).toBeUndefined();
    expect(result.teamName).toBeUndefined();
  });
});

describe('handleDevchainTeam', () => {
  const PROFILE_ID = 'profile-001';
  const CONFIG_ID = 'config-001';

  function makeTeamCtx(overrides: Partial<McpToolContext> = {}): McpToolContext {
    return makeCtx({
      storage: {
        getAgent: jest.fn().mockImplementation((id: string) => {
          if (id === AGENT_ID)
            return Promise.resolve({
              id: AGENT_ID,
              name: AGENT_NAME,
              projectId: PROJECT_ID,
              profileId: PROFILE_ID,
              providerConfigId: CONFIG_ID,
            });
          if (id === MEMBER_AGENT_ID)
            return Promise.resolve({
              id: MEMBER_AGENT_ID,
              name: MEMBER_AGENT_NAME,
              projectId: PROJECT_ID,
              profileId: PROFILE_ID,
              providerConfigId: CONFIG_ID,
            });
          return Promise.reject(new Error('Agent not found'));
        }),
        getAgentProfile: jest.fn().mockResolvedValue({ id: PROFILE_ID, name: 'Default Profile' }),
        getProfileProviderConfig: jest
          .fn()
          .mockResolvedValue({ id: CONFIG_ID, name: 'claude-sonnet' }),
      } as never,
      teamsService: {
        ...makeCtx().teamsService!,
        getTeam: jest.fn().mockResolvedValue({
          id: TEAM_ID,
          name: TEAM_NAME,
          description: 'The backend squad',
          teamLeadAgentId: LEAD_AGENT_ID,
          projectId: PROJECT_ID,
          maxMembers: 5,
          maxConcurrentTasks: 5,
          allowTeamLeadCreateAgents: true,
          members: [
            { agentId: AGENT_ID, teamId: TEAM_ID, createdAt: new Date().toISOString() },
            { agentId: MEMBER_AGENT_ID, teamId: TEAM_ID, createdAt: new Date().toISOString() },
          ],
          profileIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        findTeamByExactName: jest.fn().mockResolvedValue({
          id: TEAM_ID,
          name: TEAM_NAME,
          projectId: PROJECT_ID,
        }),
        listTeamsByAgent: jest
          .fn()
          .mockResolvedValue([{ id: TEAM_ID, name: TEAM_NAME, projectId: PROJECT_ID }]),
        countBusyTeamMembers: jest.fn().mockResolvedValue(1),
      } as never,
      ...overrides,
    });
  }

  it('auto-resolves single team for calling agent (lead)', async () => {
    const ctx = makeTeamCtx();
    const result = await handleDevchainTeam(ctx, { sessionId: 'sess-001' });

    expect(result.success).toBe(true);
    const data = result.data as {
      id: string;
      name: string;
      freeSeats: number;
      allowTeamLeadCreateAgents: boolean;
    };
    expect(data.id).toBe(TEAM_ID);
    expect(data.name).toBe(TEAM_NAME);
    expect(data.freeSeats).toBe(4);
    expect(data.allowTeamLeadCreateAgents).toBe(true);
  });

  it('returns team for non-lead member', async () => {
    const memberCtx = makeAgentSessionContext();
    (memberCtx.agent as { id: string }).id = MEMBER_AGENT_ID;
    (memberCtx.agent as { name: string }).name = MEMBER_AGENT_NAME;

    const ctx = makeTeamCtx({
      resolveSessionContext: jest.fn().mockResolvedValue({
        success: true,
        data: memberCtx,
      }),
      teamsService: {
        ...makeTeamCtx().teamsService!,
        listTeamsByAgent: jest
          .fn()
          .mockResolvedValue([{ id: TEAM_ID, name: TEAM_NAME, projectId: PROJECT_ID }]),
        getTeam: (makeTeamCtx().teamsService as { getTeam: jest.Mock }).getTeam,
        countBusyTeamMembers: jest.fn().mockResolvedValue(0),
      } as never,
    });

    const result = await handleDevchainTeam(ctx, { sessionId: 'sess-001' });
    expect(result.success).toBe(true);
  });

  it('resolves team by teamName', async () => {
    const ctx = makeTeamCtx();
    const result = await handleDevchainTeam(ctx, {
      sessionId: 'sess-001',
      teamName: TEAM_NAME,
    });

    expect(result.success).toBe(true);
    const data = result.data as { name: string };
    expect(data.name).toBe(TEAM_NAME);
  });

  it('returns TEAM_NOT_FOUND when teamName not found', async () => {
    const ctx = makeTeamCtx({
      teamsService: {
        ...makeTeamCtx().teamsService!,
        findTeamByExactName: jest.fn().mockResolvedValue(null),
      } as never,
    });

    const result = await handleDevchainTeam(ctx, {
      sessionId: 'sess-001',
      teamName: 'Nonexistent',
    });

    expect(result.success).toBe(false);
    expect((result as { error: { code: string } }).error.code).toBe('TEAM_NOT_FOUND');
  });

  it('returns NOT_A_MEMBER when caller is not in the named team', async () => {
    const ctx = makeTeamCtx({
      teamsService: {
        ...makeTeamCtx().teamsService!,
        getTeam: jest.fn().mockResolvedValue({
          id: TEAM_ID,
          name: TEAM_NAME,
          teamLeadAgentId: 'other-lead',
          projectId: PROJECT_ID,
          maxMembers: 5,
          maxConcurrentTasks: 5,
          allowTeamLeadCreateAgents: true,
          members: [{ agentId: 'other-lead', teamId: TEAM_ID, createdAt: '' }],
          profileIds: [],
          createdAt: '',
          updatedAt: '',
        }),
      } as never,
    });

    const result = await handleDevchainTeam(ctx, {
      sessionId: 'sess-001',
      teamName: TEAM_NAME,
    });

    expect(result.success).toBe(false);
    expect((result as { error: { code: string } }).error.code).toBe('NOT_A_MEMBER');
  });

  it('returns NOT_IN_ANY_TEAM when agent has no teams', async () => {
    const ctx = makeTeamCtx({
      teamsService: {
        ...makeTeamCtx().teamsService!,
        listTeamsByAgent: jest.fn().mockResolvedValue([]),
      } as never,
    });

    const result = await handleDevchainTeam(ctx, { sessionId: 'sess-001' });

    expect(result.success).toBe(false);
    expect((result as { error: { code: string } }).error.code).toBe('NOT_IN_ANY_TEAM');
  });

  it('returns AMBIGUOUS_TEAM with candidates when agent in 2+ teams', async () => {
    const ctx = makeTeamCtx({
      teamsService: {
        ...makeTeamCtx().teamsService!,
        listTeamsByAgent: jest.fn().mockResolvedValue([
          { id: TEAM_ID, name: TEAM_NAME, projectId: PROJECT_ID },
          { id: 'team-2', name: 'Frontend Team', projectId: PROJECT_ID },
        ]),
      } as never,
    });

    const result = await handleDevchainTeam(ctx, { sessionId: 'sess-001' });

    expect(result.success).toBe(false);
    const err = (result as { error: { code: string; data: { candidates: unknown[] } } }).error;
    expect(err.code).toBe('AMBIGUOUS_TEAM');
    expect(err.data.candidates).toHaveLength(2);
  });

  it('clamps freeSeats to 0 when over cap', async () => {
    const ctx = makeTeamCtx({
      teamsService: {
        ...makeTeamCtx().teamsService!,
        getTeam: jest.fn().mockResolvedValue({
          id: TEAM_ID,
          name: TEAM_NAME,
          teamLeadAgentId: LEAD_AGENT_ID,
          projectId: PROJECT_ID,
          maxMembers: 1,
          maxConcurrentTasks: 1,
          allowTeamLeadCreateAgents: false,
          members: [
            { agentId: AGENT_ID, teamId: TEAM_ID, createdAt: '' },
            { agentId: MEMBER_AGENT_ID, teamId: TEAM_ID, createdAt: '' },
          ],
          profileIds: [],
          createdAt: '',
          updatedAt: '',
        }),
        countBusyTeamMembers: jest.fn().mockResolvedValue(2),
      } as never,
    });

    const result = await handleDevchainTeam(ctx, { sessionId: 'sess-001' });

    expect(result.success).toBe(true);
    const data = result.data as { freeSeats: number; freeConcurrentSlots: number };
    expect(data.freeSeats).toBe(0);
    expect(data.freeConcurrentSlots).toBe(0);
  });

  it('includes member profile and config data in response', async () => {
    const ctx = makeTeamCtx();
    const result = await handleDevchainTeam(ctx, { sessionId: 'sess-001' });

    expect(result.success).toBe(true);
    const data = result.data as {
      members: Array<{ profileName: string; providerConfigName: string }>;
    };
    expect(data.members[0].profileName).toBe('Default Profile');
    expect(data.members[0].providerConfigName).toBe('claude-sonnet');
  });
});

// ── handleTeamsDeleteAgent ────────────────────────────────

describe('handleTeamsDeleteAgent', () => {
  const validParams = {
    sessionId: 'abcd1234',
    name: 'Worker',
  };

  it('deletes agent successfully', async () => {
    const ctx = makeCtx();
    const result = await handleTeamsDeleteAgent(ctx, validParams);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      deletedAgentId: MEMBER_AGENT_ID,
      deletedAgentName: MEMBER_AGENT_NAME,
      teamName: TEAM_NAME,
    });

    expect(
      (ctx.teamsService as { deleteTeamAgent: jest.Mock }).deleteTeamAgent,
    ).toHaveBeenCalledWith({
      leadAgentId: AGENT_ID,
      projectId: PROJECT_ID,
      name: 'Worker',
      teamName: undefined,
    });
  });

  it('passes teamName when provided', async () => {
    const ctx = makeCtx();
    await handleTeamsDeleteAgent(ctx, { ...validParams, teamName: 'Backend' });

    expect(
      (ctx.teamsService as { deleteTeamAgent: jest.Mock }).deleteTeamAgent,
    ).toHaveBeenCalledWith(expect.objectContaining({ teamName: 'Backend' }));
  });

  it('returns AGENT_CONTEXT_REQUIRED for guest sessions', async () => {
    const ctx = makeCtx({
      resolveSessionContext: jest.fn().mockResolvedValue({
        success: true,
        data: makeGuestSessionContext(),
      }),
    });
    const result = await handleTeamsDeleteAgent(ctx, validParams);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AGENT_CONTEXT_REQUIRED');
  });

  it.each([
    'FORBIDDEN_NOT_TEAM_LEAD',
    'AMBIGUOUS_TEAM_LEAD',
    'TEAM_NOT_FOUND_OR_NOT_LED',
    'AGENT_NOT_FOUND_IN_TEAM',
    'AMBIGUOUS_AGENT_NAME',
    'CANNOT_DELETE_TEAM_LEAD',
    'TARGET_LEADS_OTHER_TEAM',
    'TARGET_BELONGS_TO_OTHER_TEAM',
    'AGENT_HAS_RUNNING_SESSIONS',
  ])('forwards service error %s as MCP error', async (code) => {
    const ctx = makeCtx();
    (ctx.teamsService as { deleteTeamAgent: jest.Mock }).deleteTeamAgent.mockResolvedValueOnce({
      error: { code, message: `Error: ${code}` },
    });
    const result = await handleTeamsDeleteAgent(ctx, validParams);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(code);
  });

  it('rejects missing name via Zod', async () => {
    const ctx = makeCtx();
    await expect(handleTeamsDeleteAgent(ctx, { sessionId: 'abcd1234' })).rejects.toThrow();
  });

  it('rejects unknown extra fields via strict schema', async () => {
    const ctx = makeCtx();
    await expect(
      handleTeamsDeleteAgent(ctx, { ...validParams, extraField: 'nope' }),
    ).rejects.toThrow();
  });
});
