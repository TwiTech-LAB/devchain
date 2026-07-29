import { handleListAgents, handleGetAgentByName, handleListStatuses } from './agent-tools';
import {
  handleListEpics,
  handleListAssignedEpicsTasks,
  handleCreateEpic,
  handleGetEpicById,
  handleAddEpicComment,
  handleUpdateEpic,
  handleDeleteEpic,
} from './epic-tools';
import type { EpicToolContext } from './epic-context';
import type { AgentToolContext } from './agent-context';
import type { AgentSessionContext } from '../../dtos/mcp.dto';
import { NotFoundError, ValidationError } from '../../../../common/errors/error-types';
import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

jest.mock('../../../../common/template/agent-recipient-context', () => ({
  loadAgentRecipientContext: jest.fn().mockResolvedValue({}),
}));

jest.mock('../utils/resolve-epic-id', () => ({
  resolveEpicId: jest
    .fn()
    .mockImplementation(async (_storage: unknown, _projectId: string, id: string) => ({
      success: true,
      data: { epicId: id },
    })),
}));

jest.mock('../mappers/dto-mappers', () => ({
  mapStatusSummary: jest.fn().mockImplementation((s) => ({
    id: s.id,
    label: s.label,
    color: s.color,
    position: s.position,
  })),
  mapEpicSummary: jest.fn().mockImplementation((e) => ({
    id: e.id,
    title: e.title,
    parentId: e.parentId,
    agentId: e.agentId,
    agentName: e.agentName,
    version: e.version,
    tags: e.tags || [],
  })),
  mapEpicChild: jest.fn().mockImplementation((e) => ({ id: e.id, title: e.title })),
  mapEpicParent: jest.fn().mockImplementation((e) => ({ id: e.id, title: e.title })),
  mapEpicComment: jest.fn().mockImplementation((c) => ({
    id: c.id,
    content: c.content,
    authorName: c.authorName,
    createdAt: c.createdAt,
  })),
}));

const { resolveEpicId: resolveEpicIdMock } = jest.requireMock('../utils/resolve-epic-id') as {
  resolveEpicId: jest.Mock;
};

const PROJECT_ID = '00000000-0000-0000-0000-000000000001';
const AGENT_ID = '00000000-0000-0000-0000-000000000002';
const AGENT_NAME = 'Agent-A';
const SESSION_ID = '00000000-0000-0000-0000-000000000003';
const EPIC_ID = '00000000-0000-0000-0000-000000000004';
const STATUS_ID = '00000000-0000-0000-0000-000000000005';
const COMMENT_ID = '00000000-0000-0000-0000-000000000006';

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
      profile: { id: 'p1', name: 'Profile', instructions: '' },
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
    listProjectEpics: jest.fn().mockResolvedValue({
      items: [
        {
          id: EPIC_ID,
          title: 'Test Epic',
          statusId: STATUS_ID,
          parentId: null,
          agentId: null,
          agentName: null,
          version: 1,
          tags: [],
        },
      ],
      total: 1,
      limit: 100,
      offset: 0,
    }),
    listAssignedEpics: jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    }),
    findStatusByName: jest.fn().mockImplementation(async (_projectId: string, name: string) => {
      if (name.toLowerCase() === 'new')
        return { id: STATUS_ID, label: 'New', color: '#ccc', position: 0, projectId: PROJECT_ID };
      return null;
    }),
    listSubEpics: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    listSubEpicsForParents: jest.fn().mockResolvedValue(new Map()),
    createEpicComment: jest.fn().mockResolvedValue({
      id: COMMENT_ID,
      epicId: EPIC_ID,
      content: 'Test',
      authorName: AGENT_NAME,
      createdAt: '2024-01-01T00:00:00Z',
    }),
    getEpic: jest.fn().mockResolvedValue({
      id: EPIC_ID,
      projectId: PROJECT_ID,
      title: 'Test Epic',
      description: 'desc',
      statusId: STATUS_ID,
      parentId: null,
      agentId: AGENT_ID,
      version: 1,
      tags: ['tag1'],
      data: null,
      skillsRequired: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }),
    getStatus: jest.fn().mockResolvedValue({
      id: STATUS_ID,
      label: 'New',
      color: '#ccc',
      position: 0,
      projectId: PROJECT_ID,
    }),
    listEpicComments: jest.fn().mockResolvedValue({ items: [] }),
    addEpicComment: jest.fn().mockResolvedValue({
      id: COMMENT_ID,
      epicId: EPIC_ID,
      content: 'Test',
      authorName: AGENT_NAME,
      createdAt: '2024-01-01T00:00:00Z',
    }),
    updateEpic: jest.fn().mockResolvedValue({
      id: EPIC_ID,
      projectId: PROJECT_ID,
      title: 'Updated',
      description: null,
      statusId: STATUS_ID,
      parentId: null,
      agentId: null,
      version: 2,
      tags: [],
      data: null,
      skillsRequired: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:01Z',
    }),
  } as never;
}

function makeEpicsServiceMock() {
  return {
    createEpicForProject: jest.fn().mockResolvedValue({
      id: EPIC_ID,
      projectId: PROJECT_ID,
      title: 'New Epic',
      description: null,
      statusId: STATUS_ID,
      parentId: null,
      agentId: null,
      version: 1,
      tags: [],
      data: null,
      skillsRequired: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }),
    updateEpic: jest.fn().mockResolvedValue({
      id: EPIC_ID,
      projectId: PROJECT_ID,
      title: 'Updated',
      description: null,
      statusId: STATUS_ID,
      parentId: null,
      agentId: null,
      version: 2,
      tags: [],
      data: null,
      skillsRequired: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:01Z',
    }),
    addEpicComment: jest.fn().mockResolvedValue({
      id: COMMENT_ID,
      epicId: EPIC_ID,
      content: 'Test comment',
      authorName: AGENT_NAME,
      createdAt: '2024-01-01T00:00:00Z',
    }),
    updateEpicWithOutcome: jest.fn().mockResolvedValue({
      epic: {
        id: EPIC_ID,
        projectId: PROJECT_ID,
        title: 'Updated',
        description: null,
        statusId: STATUS_ID,
        parentId: null,
        agentId: null,
        version: 2,
        tags: [],
        data: null,
        skillsRequired: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:01Z',
      },
      outcome: { statusChanged: false, agentUnchanged: true, previousAssigneeAgent: null },
    }),
    deleteEpic: jest.fn().mockResolvedValue(undefined),
  } as never;
}

function makeEpicCtx(overrides: Partial<EpicToolContext> = {}): EpicToolContext {
  return {
    storage: makeStorageMock(),
    epicsService: makeEpicsServiceMock(),
    resolveSessionContext: jest.fn().mockResolvedValue({ success: true, data: makeAgentCtx() }),
    ...overrides,
  };
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
      resolve: jest
        .fn()
        .mockResolvedValue({ contentMd: '', bytes: 0, truncated: false, docs: [], prompts: [] }),
    } as never,
    teamsService: {
      listTeamsByAgent: jest.fn().mockResolvedValue([]),
    } as never,
    defaultInlineMaxBytes: 64 * 1024,
    resolveSessionContext: jest.fn().mockResolvedValue({ success: true, data: makeAgentCtx() }),
    ...overrides,
  };
}

describe('epic-tools handlers', () => {
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

      const result = await handleListAgents(ctx, { sessionId: SESSION_ID });
      expect(result.success).toBe(true);
      expect(result.data.agents.map((a: { name: string }) => a.name)).toEqual([
        'Alpha',
        'Beta',
        'Zeta',
      ]);
    });

    it('filters by query parameter', async () => {
      const ctx = makeAgentTestCtx();
      const result = await handleListAgents(ctx, { sessionId: SESSION_ID, q: 'agent' });
      expect(result.success).toBe(true);
      expect(result.data.agents).toHaveLength(1);
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

    it('returns resolved instructions for a self lookup', async () => {
      const ctx = makeAgentTestCtx();
      const result = await handleGetAgentByName(ctx, { sessionId: SESSION_ID, name: AGENT_NAME });

      expect(result.success).toBe(true);
      expect(result.data.agent.name).toBe(AGENT_NAME);
      expect(result.data.agent.profile).toEqual({
        id: 'p1',
        name: 'Profile',
        instructions: '',
        instructionsResolved: {
          contentMd: '',
          bytes: 0,
          truncated: false,
          docs: [],
          prompts: [],
        },
      });
      expect(result.data.agent.assignedEpics).toEqual({ items: [], total: 0 });
      expect(ctx.instructionsResolver.resolve).toHaveBeenCalledTimes(1);
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
      expect(result.data.agent.profile).toHaveProperty('instructions');
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
      expect(result.data.statuses).toHaveLength(1);
    });
  });

  describe('handleListEpics', () => {
    it('returns epics list', async () => {
      const ctx = makeEpicCtx();
      const result = await handleListEpics(ctx, { sessionId: SESSION_ID });
      expect(result.success).toBe(true);
      expect(result.data.epics).toHaveLength(1);
    });
  });

  describe('handleListAssignedEpicsTasks', () => {
    it('returns error when no project associated', async () => {
      const agentCtx = makeAgentCtx();
      (agentCtx as Record<string, unknown>).project = null;
      const ctx = makeEpicCtx();
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({ success: true, data: agentCtx });

      const result = await handleListAssignedEpicsTasks(ctx, {
        sessionId: SESSION_ID,
        agentName: AGENT_NAME,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROJECT_NOT_FOUND');
    });
  });

  describe('handleCreateEpic', () => {
    it('creates epic with title and status', async () => {
      const ctx = makeEpicCtx();
      const result = await handleCreateEpic(ctx, {
        sessionId: SESSION_ID,
        title: 'New Epic',
        statusName: 'New',
      });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: EPIC_ID, version: 1 });
      expect(ctx.epicsService.createEpicForProject).toHaveBeenCalled();
    });

    it('returns error when status not found', async () => {
      const ctx = makeEpicCtx();
      const result = await handleCreateEpic(ctx, {
        sessionId: SESSION_ID,
        title: 'New Epic',
        statusName: 'Nonexistent',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('STATUS_NOT_FOUND');
    });
  });

  describe('handleGetEpicById', () => {
    it('returns epic with children and comments', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.listSubEpics as jest.Mock).mockResolvedValue({ items: [], total: 0 });

      const result = await handleGetEpicById(ctx, { sessionId: SESSION_ID, id: EPIC_ID });
      expect(result.success).toBe(true);
      expect(result.data.epic.id).toBe(EPIC_ID);
    });

    it('returns error when epic not found', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.getEpic as jest.Mock).mockRejectedValue(new NotFoundError('Epic', EPIC_ID));

      const result = await handleGetEpicById(ctx, { sessionId: SESSION_ID, id: EPIC_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EPIC_NOT_FOUND');
    });
  });

  describe('handleAddEpicComment', () => {
    it('adds comment to epic', async () => {
      const ctx = makeEpicCtx();
      const result = await handleAddEpicComment(ctx, {
        sessionId: SESSION_ID,
        epicId: EPIC_ID,
        content: 'Test comment',
      });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: COMMENT_ID });
      expect(ctx.epicsService.addEpicComment).toHaveBeenCalledWith(
        EPIC_ID,
        PROJECT_ID,
        'Test comment',
        AGENT_ID,
        'agent',
      );
    });

    it('returns error when epic not found', async () => {
      const ctx = makeEpicCtx();
      (ctx.epicsService.addEpicComment as jest.Mock).mockRejectedValue(
        new NotFoundError('Epic', EPIC_ID),
      );

      const result = await handleAddEpicComment(ctx, {
        sessionId: SESSION_ID,
        epicId: EPIC_ID,
        content: 'Test',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EPIC_NOT_FOUND');
    });
  });

  describe('handleUpdateEpic', () => {
    it('returns error when epic not found', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.getEpic as jest.Mock).mockRejectedValue(new NotFoundError('Epic', EPIC_ID));

      const result = await handleUpdateEpic(ctx, {
        sessionId: SESSION_ID,
        id: EPIC_ID,
        version: 1,
        title: 'Updated',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EPIC_NOT_FOUND');
    });

    it('returns error when status not found for statusName', async () => {
      const ctx = makeEpicCtx();
      const result = await handleUpdateEpic(ctx, {
        sessionId: SESSION_ID,
        id: EPIC_ID,
        version: 1,
        statusName: 'Nonexistent',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('STATUS_NOT_FOUND');
    });

    it('maps ValidationError from service to HIERARCHY_CONFLICT', async () => {
      const PARENT_B_ID = '00000000-0000-0000-0000-000000000099';
      const ctx = makeEpicCtx();
      (ctx.epicsService.updateEpicWithOutcome as jest.Mock).mockRejectedValue(
        new ValidationError(
          'Cannot move an epic that has sub-epics under another parent (one-level hierarchy).',
          { epicId: EPIC_ID, parentId: PARENT_B_ID },
        ),
      );

      const result = await handleUpdateEpic(ctx, {
        sessionId: SESSION_ID,
        id: EPIC_ID,
        version: 1,
        parentId: PARENT_B_ID,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('HIERARCHY_CONFLICT');
      expect(result.error?.message).toContain('Cannot move an epic that has sub-epics');
    });
  });

  describe('handleDeleteEpic', () => {
    it('returns PROJECT_NOT_FOUND when session has no project', async () => {
      const agentCtx = makeAgentCtx();
      (agentCtx as Record<string, unknown>).project = null;
      const ctx = makeEpicCtx();
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({ success: true, data: agentCtx });

      const result = await handleDeleteEpic(ctx, { sessionId: SESSION_ID, id: EPIC_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROJECT_NOT_FOUND');
    });

    it('resolves short IDs and delegates delete to epicsService with actor context', async () => {
      const ctx = makeEpicCtx();
      resolveEpicIdMock.mockResolvedValueOnce({ success: true, data: { epicId: EPIC_ID } });

      const result = await handleDeleteEpic(ctx, { sessionId: SESSION_ID, id: 'abcd1234' });

      expect(result.success).toBe(true);
      expect(resolveEpicIdMock).toHaveBeenCalledWith(ctx.storage, PROJECT_ID, 'abcd1234');
      expect(ctx.epicsService.deleteEpic).toHaveBeenCalledWith(EPIC_ID, {
        actor: { type: 'agent', id: AGENT_ID },
      });
      expect(result.data).toEqual({ id: EPIC_ID, deleted: true });
    });

    it('returns resolver failure when prefix resolution fails', async () => {
      const ctx = makeEpicCtx();
      resolveEpicIdMock.mockResolvedValueOnce({
        success: false,
        error: {
          code: 'EPIC_NOT_FOUND',
          message: 'No epic matched prefix abcd1234',
        },
      });

      const result = await handleDeleteEpic(ctx, { sessionId: SESSION_ID, id: 'abcd1234' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EPIC_NOT_FOUND');
      expect(ctx.storage.getEpic).not.toHaveBeenCalled();
      expect(ctx.epicsService.deleteEpic).not.toHaveBeenCalled();
    });

    it('returns EPIC_NOT_FOUND when epic lookup fails', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.getEpic as jest.Mock).mockRejectedValue(new NotFoundError('Epic', EPIC_ID));

      const result = await handleDeleteEpic(ctx, { sessionId: SESSION_ID, id: EPIC_ID });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EPIC_NOT_FOUND');
      expect(ctx.epicsService.deleteEpic).not.toHaveBeenCalled();
    });

    it('returns EPIC_NOT_FOUND when resolved epic belongs to another project', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.getEpic as jest.Mock).mockResolvedValue({
        id: EPIC_ID,
        title: 'Wrong project epic',
        projectId: '00000000-0000-0000-0000-000000000099',
        description: null,
        statusId: STATUS_ID,
        parentId: null,
        agentId: null,
        version: 1,
        tags: [],
        data: null,
        skillsRequired: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      const result = await handleDeleteEpic(ctx, { sessionId: SESSION_ID, id: EPIC_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EPIC_NOT_FOUND');
    });
  });
});
