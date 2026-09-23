import type { AgentSessionContext } from '../../dtos/mcp.dto';
import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';
import type { AgentToolContext } from './agent-context';
import { handleGetAgentByName, handleListAgents, handleListStatuses } from './agent-tools';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

jest.mock('../../../../common/template/agent-recipient-context', () => ({
  loadAgentRecipientContext: jest.fn().mockResolvedValue({}),
}));

const PROJECT_ID = '00000000-0000-0000-0000-000000000001';
const AGENT_ID = '00000000-0000-0000-0000-000000000002';
const AGENT_NAME = 'Agent-A';
const SESSION_ID = '00000000-0000-0000-0000-000000000003';
const STATUS_ID = '00000000-0000-0000-0000-000000000005';

function makeAgentCtx(): AgentSessionContext {
  return {
    type: 'agent',
    session: {
      id: SESSION_ID,
      agentId: AGENT_ID,
      status: 'active',
      startedAt: '2024-01-01T00:00:00Z',
    },
    agent: { id: AGENT_ID, name: AGENT_NAME, projectId: PROJECT_ID },
    project: { id: PROJECT_ID, name: 'Test Project', rootPath: '/tmp/test' },
  };
}

function makeStorageMock() {
  return {
    listAgents: jest.fn().mockResolvedValue({
      items: [
        {
          id: AGENT_ID,
          name: AGENT_NAME,
          profileId: 'p1',
          providerConfigId: 'config-1',
          description: null,
        },
      ],
      total: 1,
    }),
    listGuests: jest.fn().mockResolvedValue([]),
    getAgent: jest
      .fn()
      .mockResolvedValue({ id: AGENT_ID, name: AGENT_NAME, projectId: PROJECT_ID }),
    getAgentByName: jest.fn().mockResolvedValue({
      id: AGENT_ID,
      name: AGENT_NAME,
      projectId: PROJECT_ID,
      profileId: 'p1',
      providerConfigId: 'config-1',
      description: null,
      profile: { id: 'p1', name: 'Profile', instructions: 'Run tasks step by step.' },
    }),
    getProfileProviderConfig: jest.fn().mockResolvedValue({
      id: 'config-1',
      name: 'Claude Sonnet',
    }),
    listAssignedEpics: jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    }),
    listStatuses: jest.fn().mockResolvedValue({
      items: [{ id: STATUS_ID, label: 'New', color: '#ccc', position: 0, projectId: PROJECT_ID }],
    }),
  } as never;
}

function makeAgentTestCtx(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
  return {
    storage: makeStorageMock(),
    sessionsService: {
      getAgentPresence: jest.fn().mockResolvedValue(new Map()),
    } as never,
    terminalIO: {
      listAllSessionNames: jest.fn().mockResolvedValue(new Set()),
    } as never,
    instructionsResolver: {
      resolve: jest.fn().mockResolvedValue({
        contentMd: 'Run tasks step by step.',
        bytes: 21,
        truncated: false,
        prompts: [],
      }),
    } as never,
    teamsService: {
      listTeamsByAgent: jest.fn().mockResolvedValue([]),
    } as never,
    defaultInlineMaxBytes: 64 * 1024,
    resolveSessionContext: jest.fn().mockResolvedValue({ success: true, data: makeAgentCtx() }),
    ...overrides,
  };
}

describe('agent-tools handlers', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleListAgents', () => {
    it('returns error when no project associated', async () => {
      const agentCtx = makeAgentCtx();
      (agentCtx as Record<string, unknown>).project = null;
      const ctx = makeAgentTestCtx();
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({ success: true, data: agentCtx });

      const result = await handleListAgents(ctx, { sessionId: SESSION_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROJECT_NOT_FOUND');
    });

    it('returns agents and guests combined, sorted by name', async () => {
      const ctx = makeAgentTestCtx();
      (ctx.storage.listAgents as jest.Mock).mockResolvedValue({
        items: [
          { id: AGENT_ID, name: 'Zeta', profileId: 'p1', description: null },
          {
            id: '00000000-0000-0000-0000-000000000099',
            name: 'Alpha',
            profileId: 'p2',
            description: null,
          },
        ],
        total: 2,
      });
      (ctx.storage.listGuests as jest.Mock).mockResolvedValue([
        {
          id: '00000000-0000-0000-0000-000000000098',
          name: 'Beta',
          description: null,
          tmuxSessionId: 'tmux-1',
        },
      ]);
      (ctx.terminalIO.listAllSessionNames as jest.Mock).mockResolvedValue(new Set(['tmux-1']));

      const result = await handleListAgents(ctx, { sessionId: SESSION_ID });
      expect(result.success).toBe(true);
      expect(result.data.agents).toEqual([
        expect.objectContaining({ name: 'Alpha', type: 'agent' }),
        expect.objectContaining({ name: 'Beta', type: 'guest', online: true }),
        expect.objectContaining({ name: 'Zeta', type: 'agent' }),
      ]);
    });

    it('filters before applying combined pagination', async () => {
      const ctx = makeAgentTestCtx();
      const result = await handleListAgents(ctx, {
        sessionId: SESSION_ID,
        q: 'agent',
        limit: 1,
        offset: 0,
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        agents: [{ name: AGENT_NAME }],
        total: 1,
        limit: 1,
        offset: 0,
      });
    });

    it('returns the resolver error without querying storage', async () => {
      const ctx = makeAgentTestCtx();
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'missing' },
      });

      await expect(handleListAgents(ctx, { sessionId: SESSION_ID })).resolves.toMatchObject({
        success: false,
        error: { code: 'SESSION_NOT_FOUND' },
      });
      expect(ctx.storage.listAgents).not.toHaveBeenCalled();
    });
  });

  describe('handleGetAgentByName', () => {
    function useCrossAgentCaller(ctx: AgentToolContext): void {
      const sessionContext = makeAgentCtx();
      sessionContext.agent = {
        id: '00000000-0000-0000-0000-000000000099',
        name: 'Agent-B',
        projectId: PROJECT_ID,
      };
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({
        success: true,
        data: sessionContext,
      });
    }

    it('returns resolved instructions for a case-insensitive self lookup', async () => {
      const ctx = makeAgentTestCtx();
      const result = await handleGetAgentByName(ctx, {
        sessionId: SESSION_ID,
        name: AGENT_NAME.toLowerCase(),
      });

      expect(result.success).toBe(true);
      expect(result.data.agent.name).toBe(AGENT_NAME);
      expect(ctx.storage.getAgentByName).toHaveBeenCalledWith(PROJECT_ID, AGENT_NAME);
      expect(result.data.agent.profile).toEqual({
        id: 'p1',
        name: 'Profile',
        instructionsResolved: {
          contentMd: 'Run tasks step by step.',
          bytes: 21,
          truncated: false,
          prompts: [],
        },
      });
      expect(result.data.agent.profile).not.toHaveProperty('instructions');
      expect(result.data.agent.assignedEpics).toEqual({ items: [], total: 0 });
      expect(ctx.instructionsResolver.resolve).toHaveBeenCalledTimes(1);
    });

    it('omits the redundant raw instructions for a plain-text profile', async () => {
      const ctx = makeAgentTestCtx();

      const result = await handleGetAgentByName(ctx, { sessionId: SESSION_ID, name: AGENT_NAME });

      expect(result.success).toBe(true);
      expect(result.data.agent.profile).not.toHaveProperty('instructions');
      expect(result.data.agent.profile?.instructionsResolved).toMatchObject({
        contentMd: 'Run tasks step by step.',
        truncated: false,
      });
    });

    it('keeps the raw instructions when the resolution is truncated', async () => {
      const ctx = makeAgentTestCtx();
      (ctx.instructionsResolver.resolve as jest.Mock).mockResolvedValue({
        contentMd: 'Run tasks step…',
        bytes: 13,
        truncated: true,
        prompts: [],
      });

      const result = await handleGetAgentByName(ctx, { sessionId: SESSION_ID, name: AGENT_NAME });

      expect(result.data.agent.profile?.instructions).toBe('Run tasks step by step.');
      expect(result.data.agent.profile?.instructionsResolved).toMatchObject({ truncated: true });
    });

    it('keeps the raw instructions when a prompt reference drops surrounding prose', async () => {
      const ctx = makeAgentTestCtx();
      const instructions = 'Intro prose [[prompt:Worker SOP]] tail prose';
      (ctx.storage.getAgentByName as jest.Mock).mockResolvedValue({
        id: AGENT_ID,
        name: AGENT_NAME,
        projectId: PROJECT_ID,
        profileId: 'p1',
        providerConfigId: 'config-1',
        description: null,
        profile: { id: 'p1', name: 'Profile', instructions },
      });
      (ctx.instructionsResolver.resolve as jest.Mock).mockResolvedValue({
        contentMd: '## Prompt: Worker SOP\n\nSOP body\n',
        bytes: 27,
        truncated: false,
        prompts: [{ id: 'prompt-1', title: 'Worker SOP' }],
      });

      const result = await handleGetAgentByName(ctx, { sessionId: SESSION_ID, name: AGENT_NAME });

      expect(result.data.agent.profile?.instructions).toBe(instructions);
      expect(result.data.agent.profile?.instructionsResolved).toMatchObject({ truncated: false });
    });

    it('returns null instructions and no resolved text for a profile without instructions', async () => {
      const ctx = makeAgentTestCtx();
      (ctx.storage.getAgentByName as jest.Mock).mockResolvedValue({
        id: AGENT_ID,
        name: AGENT_NAME,
        projectId: PROJECT_ID,
        profileId: 'p1',
        providerConfigId: 'config-1',
        description: null,
        profile: { id: 'p1', name: 'Profile', instructions: null },
      });
      (ctx.instructionsResolver.resolve as jest.Mock).mockResolvedValue(null);

      const result = await handleGetAgentByName(ctx, { sessionId: SESSION_ID, name: AGENT_NAME });

      expect(result.data.agent.profile?.instructions).toBeNull();
      expect(result.data.agent.profile?.instructionsResolved).toBeUndefined();
    });

    it('returns newest open assigned epics with status and a pre-cap total', async () => {
      const ctx = makeAgentTestCtx();
      const openEpics = Array.from({ length: 22 }, (_, index) => {
        const number = index + 1;
        return {
          id: `epic-${number.toString().padStart(2, '0')}`,
          parentId: number % 2 === 0 ? 'parent-1' : null,
          title: `Open epic ${number}`,
          statusId: STATUS_ID,
          updatedAt: `2026-07-${number.toString().padStart(2, '0')}T10:00:00.000Z`,
        };
      });
      (ctx.storage.listAssignedEpics as jest.Mock).mockResolvedValue({
        items: [
          ...openEpics,
          {
            id: 'epic-done',
            parentId: null,
            title: 'Completed epic',
            statusId: 'status-done',
            updatedAt: '2026-07-31T10:00:00.000Z',
          },
        ],
        total: 23,
        limit: 100,
        offset: 0,
      });
      (ctx.storage.listStatuses as jest.Mock).mockResolvedValue({
        items: [
          { id: STATUS_ID, label: 'New' },
          { id: 'status-done', label: 'Done' },
        ],
      });

      const result = await handleGetAgentByName(ctx, { sessionId: SESSION_ID, name: AGENT_NAME });

      expect(result.data.agent.assignedEpics.total).toBe(22);
      expect(result.data.agent.assignedEpics.items).toHaveLength(20);
      expect(result.data.agent.assignedEpics.items[0]).toEqual({
        id: 'epic-22',
        parentId: 'parent-1',
        title: 'Open epic 22',
        status: 'New',
      });
      expect(result.data.agent.assignedEpics.items[19].id).toBe('epic-03');
      expect(ctx.storage.listAssignedEpics).toHaveBeenCalledWith(PROJECT_ID, {
        agentName: AGENT_NAME,
        excludeMcpHidden: true,
        limit: 100,
        offset: 0,
      });
    });

    it('returns a cross-agent directory card without instruction keys', async () => {
      const ctx = makeAgentTestCtx();
      useCrossAgentCaller(ctx);
      (ctx.teamsService.listTeamsByAgent as jest.Mock).mockResolvedValue([
        {
          id: 'team-z',
          projectId: PROJECT_ID,
          name: 'Zulu',
          teamLeadAgentId: null,
        },
        {
          id: 'team-a',
          projectId: PROJECT_ID,
          name: 'Alpha',
          teamLeadAgentId: AGENT_ID,
        },
        {
          id: 'team-other',
          projectId: 'other-project',
          name: 'Ignored',
          teamLeadAgentId: AGENT_ID,
        },
      ]);
      (ctx.sessionsService.getAgentPresence as jest.Mock).mockResolvedValue(
        new Map([
          [
            AGENT_ID,
            {
              online: true,
              activityState: 'busy',
              lastActivityAt: '2026-07-18T10:05:00.000Z',
              busySince: '2026-07-18T10:00:00.000Z',
              idleSince: '2026-07-18T09:00:00.000Z',
              currentActivityTitle: 'Implement directory card',
            },
          ],
        ]),
      );
      (ctx.storage.listAssignedEpics as jest.Mock).mockResolvedValue({
        items: [
          {
            id: 'epic-cross',
            parentId: 'parent-cross',
            title: 'Cross-agent work',
            statusId: STATUS_ID,
            updatedAt: '2026-07-18T10:06:00.000Z',
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await handleGetAgentByName(ctx, { sessionId: SESSION_ID, name: AGENT_NAME });

      expect(result.success).toBe(true);
      expect(result.data.agent).toMatchObject({
        providerConfigId: 'config-1',
        providerConfigName: 'Claude Sonnet',
        teams: [
          { teamId: 'team-a', teamName: 'Alpha', isLead: true },
          { teamId: 'team-z', teamName: 'Zulu', isLead: false },
        ],
        presence: {
          online: true,
          activityState: 'busy',
          lastActivityAt: '2026-07-18T10:05:00.000Z',
          busySince: '2026-07-18T10:00:00.000Z',
          idleSince: null,
          currentActivityTitle: 'Implement directory card',
        },
        assignedEpics: {
          items: [
            {
              id: 'epic-cross',
              parentId: 'parent-cross',
              title: 'Cross-agent work',
              status: 'New',
            },
          ],
          total: 1,
        },
        profile: { id: 'p1', name: 'Profile' },
      });
      expect(result.data.agent.profile).not.toHaveProperty('instructions');
      expect(result.data.agent.profile).not.toHaveProperty('instructionsResolved');
      expect(ctx.instructionsResolver.resolve).not.toHaveBeenCalled();
    });

    it('omits instruction keys and skips resolution for a guest caller', async () => {
      const ctx = makeAgentTestCtx();
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({
        success: true,
        data: {
          type: 'guest',
          guest: {
            id: 'guest-1',
            name: 'Guest',
            projectId: PROJECT_ID,
            tmuxSessionId: 'guest-tmux',
          },
          project: { id: PROJECT_ID, name: 'Test Project', rootPath: '/tmp/test' },
        },
      });

      const result = await handleGetAgentByName(ctx, { sessionId: SESSION_ID, name: AGENT_NAME });

      expect(result.success).toBe(true);
      expect(result.data.agent.profile).toEqual({ id: 'p1', name: 'Profile' });
      expect(ctx.instructionsResolver.resolve).not.toHaveBeenCalled();
    });

    it('normalizes idle presence and clears stale busySince', async () => {
      const ctx = makeAgentTestCtx();
      useCrossAgentCaller(ctx);
      (ctx.sessionsService.getAgentPresence as jest.Mock).mockResolvedValue(
        new Map([
          [
            AGENT_ID,
            {
              online: true,
              activityState: 'idle',
              busySince: '2026-07-18T09:00:00.000Z',
              idleSince: '2026-07-18T10:00:00.000Z',
            },
          ],
        ]),
      );

      const result = await handleGetAgentByName(ctx, { sessionId: SESSION_ID, name: AGENT_NAME });

      expect(result.data.agent.presence).toEqual({
        online: true,
        activityState: 'idle',
        lastActivityAt: null,
        busySince: null,
        idleSince: '2026-07-18T10:00:00.000Z',
        currentActivityTitle: null,
      });
    });

    it('normalizes offline presence with all activity fields null', async () => {
      const ctx = makeAgentTestCtx();
      useCrossAgentCaller(ctx);
      (ctx.sessionsService.getAgentPresence as jest.Mock).mockResolvedValue(
        new Map([[AGENT_ID, { online: false }]]),
      );

      const result = await handleGetAgentByName(ctx, { sessionId: SESSION_ID, name: AGENT_NAME });

      expect(result.data.agent.presence).toEqual({
        online: false,
        activityState: null,
        lastActivityAt: null,
        busySince: null,
        idleSince: null,
        currentActivityTitle: null,
      });
    });

    it('degrades unavailable presence independently to null', async () => {
      const ctx = makeAgentTestCtx();
      useCrossAgentCaller(ctx);
      (ctx.sessionsService.getAgentPresence as jest.Mock).mockRejectedValue(
        new ServiceUnavailableError('SessionsService'),
      );

      const result = await handleGetAgentByName(ctx, { sessionId: SESSION_ID, name: AGENT_NAME });

      expect(result.success).toBe(true);
      expect(result.data.agent.presence).toBeNull();
      expect(result.data.agent.providerConfigName).toBe('Claude Sonnet');
    });

    it('degrades unavailable teams without discarding presence or config', async () => {
      const ctx = makeAgentTestCtx();
      useCrossAgentCaller(ctx);
      (ctx.teamsService.listTeamsByAgent as jest.Mock).mockRejectedValue(
        new ServiceUnavailableError('TeamsService'),
      );
      (ctx.sessionsService.getAgentPresence as jest.Mock).mockResolvedValue(
        new Map([[AGENT_ID, { online: false }]]),
      );

      const result = await handleGetAgentByName(ctx, { sessionId: SESSION_ID, name: AGENT_NAME });

      expect(result.success).toBe(true);
      expect(result.data.agent.teams).toEqual([]);
      expect(result.data.agent.providerConfigName).toBe('Claude Sonnet');
      expect(result.data.agent.presence.online).toBe(false);
    });

    it('preserves provider config id when its name lookup fails', async () => {
      const ctx = makeAgentTestCtx();
      useCrossAgentCaller(ctx);
      (ctx.storage.getProfileProviderConfig as jest.Mock).mockRejectedValue(
        new Error('config unavailable'),
      );

      const result = await handleGetAgentByName(ctx, { sessionId: SESSION_ID, name: AGENT_NAME });

      expect(result.success).toBe(true);
      expect(result.data.agent.providerConfigId).toBe('config-1');
      expect(result.data.agent.providerConfigName).toBeNull();
    });

    it('degrades assigned epic lookup without changing other card fields', async () => {
      const ctx = makeAgentTestCtx();
      (ctx.storage.listAssignedEpics as jest.Mock).mockRejectedValue(
        new ServiceUnavailableError('EpicStorage'),
      );

      const result = await handleGetAgentByName(ctx, { sessionId: SESSION_ID, name: AGENT_NAME });

      expect(result.success).toBe(true);
      expect(result.data.agent.assignedEpics).toEqual({ items: [], total: 0 });
      expect(result.data.agent.providerConfigName).toBe('Claude Sonnet');
      expect(result.data.agent.teams).toEqual([]);
      expect(result.data.agent.presence).toBeNull();
      expect(result.data.agent.profile).toHaveProperty('instructionsResolved');
      expect(ctx.instructionsResolver.resolve).toHaveBeenCalledTimes(1);
    });

    it('returns AGENT_NOT_FOUND with available names when not found', async () => {
      const ctx = makeAgentTestCtx();
      const result = await handleGetAgentByName(ctx, { sessionId: SESSION_ID, name: 'Unknown' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('AGENT_NOT_FOUND');
      expect(result.error?.data?.availableNames).toContain(AGENT_NAME);
    });
  });

  describe('handleListStatuses', () => {
    it('returns statuses for the project', async () => {
      const ctx = makeAgentTestCtx();
      const result = await handleListStatuses(ctx, { sessionId: SESSION_ID });
      expect(result.success).toBe(true);
      expect(result.data.statuses).toEqual([
        expect.objectContaining({ id: STATUS_ID, name: 'New' }),
      ]);
      expect(ctx.storage.listStatuses).toHaveBeenCalledWith(PROJECT_ID, {
        limit: 1000,
        offset: 0,
      });
    });
  });
});
