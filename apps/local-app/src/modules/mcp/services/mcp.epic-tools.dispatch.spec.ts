import { McpService } from './mcp.service';
import { DEFAULT_FEATURE_FLAGS } from '../../../common/config/feature-flags';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type {
  Agent,
  AgentProfile,
  Document,
  Project,
  Epic,
  EpicComment,
  Status,
} from '../../storage/models/domain.models';

const TEST_SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const MISSING_SESSION_ID = 'deadbeef-dead-beef-dead-beefdeadbeef';
const TEST_PROJECT: Project = {
  id: 'project-1',
  name: 'Test Project',
  description: null,
  rootPath: '/test/project',
  isTemplate: false,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};
const TEST_AGENT: Agent = {
  id: 'agent-1',
  projectId: 'project-1',
  profileId: 'profile-1',
  name: 'Test Agent',
  description: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('McpService', () => {
  let service: McpService;
  let storage: jest.Mocked<StorageService>;
  let chatService: jest.Mocked<unknown>;
  let sessionsService: jest.Mocked<unknown>;
  let terminalGateway: jest.Mocked<unknown>;
  let terminalIO: jest.Mocked<unknown>;
  let epicsService: jest.Mocked<{
    updateEpic: jest.Mock;
    createEpicForProject: jest.Mock;
    addEpicComment: jest.Mock;
    updateEpicWithOutcome: jest.Mock;
    deleteEpic: jest.Mock;
  }>;
  let settingsService: jest.Mocked<unknown>;
  let guestsService: jest.Mocked<unknown>;
  let skillsService: jest.Mocked<unknown>;
  let reviewsService: jest.Mocked<unknown>;
  let teamsService: jest.Mocked<unknown>;

  beforeEach(() => {
    storage = {
      getDocument: jest.fn(),
      listDocuments: jest.fn(),
      createDocument: jest.fn(),
      updateDocument: jest.fn(),
      listPrompts: jest.fn(),
      getPrompt: jest.fn(),
      listProjects: jest.fn(),
      createRecord: jest.fn(),
      updateRecord: jest.fn(),
      getRecord: jest.fn(),
      listRecords: jest.fn(),
      addTags: jest.fn(),
      removeTags: jest.fn(),
      findProjectByPath: jest.fn(), // Legacy - kept for existing test mocks
      listAgents: jest.fn(),
      getAgent: jest.fn(),
      getAgentByName: jest.fn(),
      getProject: jest.fn(),
      listStatuses: jest.fn(),
      findStatusByName: jest.fn(),
      listProjectEpics: jest.fn(),
      listAssignedEpics: jest.fn(),
      createEpicForProject: jest.fn(),
      listEpicComments: jest.fn(),
      listSubEpics: jest.fn(),
      listSubEpicsForParents: jest.fn(),
      getEpic: jest.fn(),
      createEpicComment: jest.fn(),
      getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
      listGuests: jest.fn().mockResolvedValue([]),
      getGuestByName: jest.fn().mockResolvedValue(null),
      getGuestsByIdPrefix: jest.fn().mockResolvedValue([]),
      getEpicsByIdPrefix: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<StorageService>;

    chatService = {
      createGroupThread: jest.fn(),
      getThread: jest.fn(),
      createMessage: jest.fn(),
      listMessages: jest.fn(),
      createDirectThread: jest.fn(),
    };

    sessionsService = {
      getAgentSession: jest.fn(),
      listActiveSessions: jest.fn().mockResolvedValue([
        {
          id: TEST_SESSION_ID,
          agentId: TEST_AGENT.id,
          tmuxSessionId: 'tmux-1',
          status: 'running',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: null,
          epicId: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ]),
      injectTextIntoSession: jest.fn().mockResolvedValue({ confirmed: true }),
      launchSession: jest.fn(),
      getAgentPresence: jest.fn().mockResolvedValue(new Map()),
    };

    // Default session context mocks (can be overridden in individual tests)
    storage.getAgent.mockResolvedValue(TEST_AGENT);
    (storage as unknown as { getProject: jest.Mock }).getProject.mockResolvedValue(TEST_PROJECT);

    terminalGateway = {
      sendTextToSession: jest.fn(),
      broadcastEvent: jest.fn(),
    };

    epicsService = {
      updateEpic: jest.fn(),
      createEpicForProject: jest.fn(),
      addEpicComment: jest.fn(),
      updateEpicWithOutcome: jest.fn(),
      deleteEpic: jest.fn(),
    } as {
      updateEpic: jest.Mock;
      createEpicForProject: jest.Mock;
      addEpicComment: jest.Mock;
      updateEpicWithOutcome: jest.Mock;
      deleteEpic: jest.Mock;
    };

    settingsService = {
      // T3-FIX: Method name is getMessagePoolConfigForProject (not getMessagePoolConfig)
      getMessagePoolConfigForProject: jest.fn().mockReturnValue({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      }),
    };

    guestsService = {
      register: jest.fn(),
    };

    skillsService = {
      listDiscoverable: jest.fn(),
      getSkillBySlug: jest.fn(),
      logUsage: jest.fn(),
    };

    reviewsService = {};

    teamsService = {
      listTeams: jest.fn(),
      findTeamByExactName: jest.fn(),
      getTeam: jest.fn(),
      listTeamsByAgent: jest.fn().mockResolvedValue([]),
    };

    terminalIO = {
      deliver: jest.fn().mockResolvedValue({ confirmed: true, nonce: 'abc', retryCount: 0 }),
      deliverImmediate: jest
        .fn()
        .mockResolvedValue({ confirmed: true, nonce: 'abc', retryCount: 0 }),
      sendControl: jest.fn().mockResolvedValue(undefined),
      sessionExists: jest.fn().mockResolvedValue(false),
      listAllSessionNames: jest.fn().mockResolvedValue(new Set<string>()),
    };

    service = new McpService(
      storage,
      chatService as never,
      sessionsService as never,
      terminalGateway as never,
      epicsService as never,
      settingsService as never,
      guestsService as never,
      skillsService as never,
      reviewsService as never,
      undefined as never,
      teamsService as never,
      terminalIO as never,
      undefined as never,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // --- Agent dispatch tests ---
  // TODO(P3.2): migrate handler-internal agent tests to epic-tools handler spec
  it('lists agents for a resolved session', async () => {
    const project: Project = {
      id: 'project-1',
      name: 'Sample',
      description: null,
      rootPath: '/repo/project',
      isTemplate: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    storage.findProjectByPath.mockResolvedValue(project);
    storage.listAgents.mockResolvedValue({
      items: [
        {
          id: 'agent-1',
          projectId: 'project-1',
          profileId: 'profile-1',
          name: 'Alpha',
          description: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        } satisfies Agent,
      ],
      total: 1,
      limit: 1,
      offset: 0,
    });

    const response = await service.handleToolCall('devchain_list_agents', {
      sessionId: TEST_SESSION_ID,
      limit: 5,
      offset: 0,
    });

    expect(response.success).toBe(true);
    const payload = response.data as {
      agents: Array<{ id: string; name: string; profileId: string }>;
    };
    expect(payload.agents).toHaveLength(1);
    expect(payload.agents[0]).toMatchObject({
      id: 'agent-1',
      name: 'Alpha',
      profileId: 'profile-1',
      type: 'agent',
      online: false,
    });
    // With combined pagination, we fetch all agents (MAX_COMBINED_FETCH=1000) and paginate in memory
    expect(storage.listAgents).toHaveBeenCalledWith('project-1', { limit: 1000, offset: 0 });
  });

  it('includes guests in list_agents response with type marker', async () => {
    const project: Project = {
      id: 'project-1',
      name: 'Sample',
      description: null,
      rootPath: '/repo/project',
      isTemplate: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    storage.findProjectByPath.mockResolvedValue(project);
    storage.listAgents.mockResolvedValue({
      items: [
        {
          id: 'agent-1',
          projectId: 'project-1',
          profileId: 'profile-1',
          name: 'Alpha',
          description: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        } satisfies Agent,
      ],
      total: 1,
      limit: 100,
      offset: 0,
    });

    (storage as unknown as { listGuests: jest.Mock }).listGuests.mockResolvedValue([
      {
        id: 'guest-1',
        projectId: 'project-1',
        name: 'GuestBot',
        tmuxSessionId: 'guest-tmux-1',
        lastSeenAt: '2024-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ]);

    const response = await service.handleToolCall('devchain_list_agents', {
      sessionId: TEST_SESSION_ID,
    });

    expect(response.success).toBe(true);
    const payload = response.data as {
      agents: Array<{
        id: string;
        name: string;
        profileId: string | null;
        type: 'agent' | 'guest';
        online: boolean;
      }>;
      total: number;
    };
    expect(payload.agents).toHaveLength(2);
    expect(payload.total).toBe(2);

    // Verify agent
    const agentItem = payload.agents.find((a) => a.id === 'agent-1');
    expect(agentItem).toMatchObject({
      id: 'agent-1',
      name: 'Alpha',
      profileId: 'profile-1',
      type: 'agent',
    });

    // Verify guest
    const guestItem = payload.agents.find((a) => a.id === 'guest-1');
    expect(guestItem).toMatchObject({
      id: 'guest-1',
      name: 'GuestBot',
      profileId: null,
      type: 'guest',
    });
  });

  it('includes online status for agents and guests', async () => {
    const project: Project = {
      id: 'project-1',
      name: 'Sample',
      description: null,
      rootPath: '/repo/project',
      isTemplate: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    storage.findProjectByPath.mockResolvedValue(project);
    storage.listAgents.mockResolvedValue({
      items: [
        {
          id: 'agent-1',
          projectId: 'project-1',
          profileId: 'profile-1',
          name: 'Alpha',
          description: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        } satisfies Agent,
      ],
      total: 1,
      limit: 100,
      offset: 0,
    });

    // Agent is online
    (sessionsService as { getAgentPresence: jest.Mock }).getAgentPresence.mockResolvedValue(
      new Map([['agent-1', { online: true }]]),
    );

    (storage as unknown as { listGuests: jest.Mock }).listGuests.mockResolvedValue([
      {
        id: 'guest-1',
        projectId: 'project-1',
        name: 'GuestBot',
        tmuxSessionId: 'guest-tmux-1',
        lastSeenAt: '2024-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ]);

    // Guest tmux session is alive - use batch listAllSessionNames for O(1) lookup
    (terminalIO as { listAllSessionNames: jest.Mock }).listAllSessionNames.mockResolvedValue(
      new Set(['guest-tmux-1', 'other-session']),
    );

    const response = await service.handleToolCall('devchain_list_agents', {
      sessionId: TEST_SESSION_ID,
    });

    expect(response.success).toBe(true);
    const payload = response.data as {
      agents: Array<{ id: string; type: 'agent' | 'guest'; online: boolean }>;
    };

    const agentItem = payload.agents.find((a) => a.id === 'agent-1');
    expect(agentItem?.online).toBe(true);

    const guestItem = payload.agents.find((a) => a.id === 'guest-1');
    expect(guestItem?.online).toBe(true);

    // Verify batch lookup was used instead of N individual hasSession calls
    expect(
      (terminalIO as { listAllSessionNames: jest.Mock }).listAllSessionNames,
    ).toHaveBeenCalled();
  });

  describe('list_agents pagination', () => {
    const project: Project = {
      id: 'project-1',
      name: 'Sample',
      description: null,
      rootPath: '/repo/project',
      isTemplate: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    const makeAgent = (id: string, name: string): Agent => ({
      id,
      projectId: 'project-1',
      profileId: 'profile-1',
      name,
      description: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });

    const makeGuest = (id: string, name: string) => ({
      id,
      projectId: 'project-1',
      name,
      tmuxSessionId: `tmux-${id}`,
      lastSeenAt: '2024-01-01T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });

    beforeEach(() => {
      storage.findProjectByPath.mockResolvedValue(project);
      (sessionsService as { getAgentPresence: jest.Mock }).getAgentPresence.mockResolvedValue(
        new Map(),
      );
      (terminalIO as { sessionExists: jest.Mock }).sessionExists.mockResolvedValue(false);
    });

    it('applies offset and limit to combined agents+guests list', async () => {
      // 3 agents + 2 guests = 5 total, sorted by name
      storage.listAgents.mockResolvedValue({
        items: [makeAgent('a1', 'Charlie'), makeAgent('a2', 'Alpha'), makeAgent('a3', 'Echo')],
        total: 3,
        limit: 1000,
        offset: 0,
      });
      (storage as unknown as { listGuests: jest.Mock }).listGuests.mockResolvedValue([
        makeGuest('g1', 'Bravo'),
        makeGuest('g2', 'Delta'),
      ]);

      // Request offset=1, limit=2 - should get items 2 and 3 (Bravo, Charlie)
      const response = await service.handleToolCall('devchain_list_agents', {
        sessionId: TEST_SESSION_ID,
        offset: 1,
        limit: 2,
      });

      expect(response.success).toBe(true);
      const payload = response.data as {
        agents: Array<{ name: string; type: 'agent' | 'guest' }>;
        total: number;
        offset: number;
        limit: number;
      };

      expect(payload.total).toBe(5);
      expect(payload.offset).toBe(1);
      expect(payload.limit).toBe(2);
      expect(payload.agents).toHaveLength(2);
      // Sorted order: Alpha, Bravo, Charlie, Delta, Echo
      // offset=1 skips Alpha, limit=2 returns Bravo, Charlie
      expect(payload.agents[0].name).toBe('Bravo');
      expect(payload.agents[0].type).toBe('guest');
      expect(payload.agents[1].name).toBe('Charlie');
      expect(payload.agents[1].type).toBe('agent');
    });

    it('returns correct total for combined list', async () => {
      storage.listAgents.mockResolvedValue({
        items: [makeAgent('a1', 'Agent1'), makeAgent('a2', 'Agent2')],
        total: 2,
        limit: 1000,
        offset: 0,
      });
      (storage as unknown as { listGuests: jest.Mock }).listGuests.mockResolvedValue([
        makeGuest('g1', 'Guest1'),
        makeGuest('g2', 'Guest2'),
        makeGuest('g3', 'Guest3'),
      ]);

      const response = await service.handleToolCall('devchain_list_agents', {
        sessionId: TEST_SESSION_ID,
        limit: 2,
      });

      expect(response.success).toBe(true);
      const payload = response.data as { total: number; agents: unknown[] };
      expect(payload.total).toBe(5); // 2 agents + 3 guests
      expect(payload.agents).toHaveLength(2); // Limited to 2
    });

    it('sorts agents before guests when names are equal', async () => {
      storage.listAgents.mockResolvedValue({
        items: [makeAgent('a1', 'SameName')],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      (storage as unknown as { listGuests: jest.Mock }).listGuests.mockResolvedValue([
        makeGuest('g1', 'SameName'),
      ]);

      const response = await service.handleToolCall('devchain_list_agents', {
        sessionId: TEST_SESSION_ID,
      });

      expect(response.success).toBe(true);
      const payload = response.data as {
        agents: Array<{ name: string; type: 'agent' | 'guest' }>;
      };

      expect(payload.agents).toHaveLength(2);
      // Agent should come before guest with same name
      expect(payload.agents[0].type).toBe('agent');
      expect(payload.agents[1].type).toBe('guest');
    });

    it('handles offset beyond total items gracefully', async () => {
      storage.listAgents.mockResolvedValue({
        items: [makeAgent('a1', 'Alpha')],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      (storage as unknown as { listGuests: jest.Mock }).listGuests.mockResolvedValue([
        makeGuest('g1', 'Beta'),
      ]);

      const response = await service.handleToolCall('devchain_list_agents', {
        sessionId: TEST_SESSION_ID,
        offset: 100,
        limit: 10,
      });

      expect(response.success).toBe(true);
      const payload = response.data as { agents: unknown[]; total: number };
      expect(payload.agents).toHaveLength(0);
      expect(payload.total).toBe(2);
    });

    it('applies query filter before pagination', async () => {
      storage.listAgents.mockResolvedValue({
        items: [makeAgent('a1', 'AlphaBot'), makeAgent('a2', 'BetaBot')],
        total: 2,
        limit: 1000,
        offset: 0,
      });
      (storage as unknown as { listGuests: jest.Mock }).listGuests.mockResolvedValue([
        makeGuest('g1', 'GammaBot'),
        makeGuest('g2', 'AlphaGuest'),
      ]);

      const response = await service.handleToolCall('devchain_list_agents', {
        sessionId: TEST_SESSION_ID,
        q: 'alpha',
        offset: 0,
        limit: 10,
      });

      expect(response.success).toBe(true);
      const payload = response.data as {
        agents: Array<{ name: string }>;
        total: number;
      };

      // Only AlphaBot and AlphaGuest match
      expect(payload.total).toBe(2);
      expect(payload.agents).toHaveLength(2);
      expect(payload.agents.map((a) => a.name).sort()).toEqual(['AlphaBot', 'AlphaGuest']);
    });
  });

  it('rejects agent listing when sessionId is too short', async () => {
    const response = await service.handleToolCall('devchain_list_agents', {
      sessionId: 'short',
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('VALIDATION_ERROR');
  });

  it('returns an agent with resolved instructions by name', async () => {
    const project: Project = {
      id: 'project-1',
      name: 'Sample',
      description: null,
      rootPath: '/repo/project',
      isTemplate: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    const profile: AgentProfile = {
      id: 'profile-1',
      name: 'Alpha Profile',
      providerId: 'provider-1',
      options: null,
      systemPrompt: null,
      instructions: '[[playbook]]',
      temperature: null,
      maxTokens: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    const agent: Agent = {
      id: 'agent-1',
      projectId: 'project-1',
      profileId: 'profile-1',
      name: 'Alpha',
      description: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    storage.findProjectByPath.mockResolvedValue(project);
    storage.listAgents.mockResolvedValue({
      items: [agent],
      total: 1,
      limit: 1,
      offset: 0,
    });
    storage.getAgentByName.mockResolvedValue({ ...agent, profile });

    const document: Document = {
      id: 'doc-1',
      projectId: 'project-1',
      title: 'Playbook',
      slug: 'playbook',
      contentMd: '# Steps',
      archived: false,
      version: 1,
      tags: ['role:worker'],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    storage.getDocument.mockResolvedValue(document);

    const response = await service.handleToolCall('devchain_get_agent_by_name', {
      sessionId: TEST_SESSION_ID,
      name: 'Alpha',
    });

    expect(response.success).toBe(true);
    const payload = response.data as {
      agent: {
        id: string;
        profile?: {
          instructions?: string | null;
          instructionsResolved?: { contentMd: string; docs: Array<{ slug: string }> };
        };
      };
    };

    expect(payload.agent.id).toBe('agent-1');
    expect(payload.agent.profile?.instructions).toBe('[[playbook]]');
    expect(payload.agent.profile?.instructionsResolved?.contentMd).toContain('# Steps');
    expect(payload.agent.profile?.instructionsResolved?.docs[0]?.slug).toBe('playbook');
  });

  it('matches agent names case-insensitively', async () => {
    const project: Project = {
      id: 'project-1',
      name: 'Sample',
      description: null,
      rootPath: '/repo/project',
      isTemplate: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    const agent: Agent = {
      id: 'agent-1',
      projectId: 'project-1',
      profileId: 'profile-1',
      name: 'Alpha',
      description: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    storage.findProjectByPath.mockResolvedValue(project);
    storage.listAgents.mockResolvedValue({
      items: [agent],
      total: 1,
      limit: 1,
      offset: 0,
    });
    storage.getAgentByName.mockResolvedValue({ ...agent, profile: undefined });

    const response = await service.handleToolCall('devchain_get_agent_by_name', {
      sessionId: TEST_SESSION_ID,
      name: 'ALPHA',
    });

    expect(response.success).toBe(true);
    expect(storage.getAgentByName).toHaveBeenCalledWith('project-1', 'Alpha');
  });

  it('rejects get agent by name when sessionId is too short', async () => {
    const response = await service.handleToolCall('devchain_get_agent_by_name', {
      sessionId: 'short',
      name: 'Alpha',
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('VALIDATION_ERROR');
  });

  it('returns SESSION_NOT_FOUND when session is unknown', async () => {
    const response = await service.handleToolCall('devchain_list_agents', {
      sessionId: MISSING_SESSION_ID,
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns SESSION_NOT_FOUND when resolving agent by name for unknown session', async () => {
    const response = await service.handleToolCall('devchain_get_agent_by_name', {
      sessionId: MISSING_SESSION_ID,
      name: 'Alpha',
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns agent-not-found error when agent lookup fails', async () => {
    const project: Project = {
      id: 'project-1',
      name: 'Sample',
      description: null,
      rootPath: '/repo/project',
      isTemplate: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    storage.findProjectByPath.mockResolvedValue(project);
    storage.listAgents.mockResolvedValue({
      items: [
        {
          id: 'agent-1',
          projectId: 'project-1',
          profileId: 'profile-1',
          name: 'Worker',
          description: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
      total: 1,
      limit: 1,
      offset: 0,
    });

    const response = await service.handleToolCall('devchain_get_agent_by_name', {
      sessionId: TEST_SESSION_ID,
      name: 'Missing',
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('AGENT_NOT_FOUND');
    const errorData = response.error?.data as { availableNames?: string[] } | undefined;
    expect(errorData?.availableNames).toEqual(['Worker']);
  });

  // TODO(P3.2): migrate handler-internal epic tests to epic-tools handler spec
  describe('epic tools', () => {
    const makeProject = (): Project => ({
      id: 'project-1',
      name: 'Sample Project',
      description: null,
      rootPath: '/repo/project',
      isTemplate: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });

    const makeStatus = (overrides: Partial<Status> = {}): Status => ({
      id: '11111111-1111-1111-1111-111111111111',
      projectId: 'project-1',
      label: 'Backlog',
      color: '#111111',
      position: 0,
      mcpHidden: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      ...overrides,
    });

    const makeEpic = (overrides: Partial<Epic> = {}): Epic => ({
      id: '22222222-2222-2222-2222-222222222222',
      projectId: 'project-1',
      title: 'Epic Title',
      description: 'Epic description',
      statusId: '11111111-1111-1111-1111-111111111111',
      parentId: null,
      agentId: null,
      version: 1,
      data: null,
      skillsRequired: null,
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      ...overrides,
    });

    const makeComment = (overrides: Partial<EpicComment> = {}): EpicComment => ({
      id: '33333333-3333-3333-3333-333333333333',
      epicId: '22222222-2222-2222-2222-222222222222',
      authorName: 'Reviewer',
      content: 'Looks good',
      createdAt: '2024-01-05T00:00:00Z',
      updatedAt: '2024-01-05T00:00:00Z',
      ...overrides,
    });

    const withOutcome = (
      epic: Epic,
      overrides: Partial<{
        statusChanged: boolean;
        agentUnchanged: boolean;
        previousAssigneeAgent: { id: string; name: string } | null;
      }> = {},
    ) => ({
      epic,
      outcome: {
        statusChanged: false,
        agentUnchanged: true,
        previousAssigneeAgent: null,
        ...overrides,
      },
    });

    it('lists statuses for a resolved session', async () => {
      const project = makeProject();
      const statuses = [makeStatus()];

      storage.findProjectByPath.mockResolvedValue(project);
      storage.listStatuses.mockResolvedValue({
        items: statuses,
        total: statuses.length,
        limit: 1000,
        offset: 0,
      });

      const response = await service.handleToolCall('devchain_list_statuses', {
        sessionId: TEST_SESSION_ID,
      });

      expect(response.success).toBe(true);
      const payload = response.data as {
        statuses: Array<{ id: string; name: string; position: number; color: string }>;
      };

      expect(payload.statuses).toEqual([
        {
          id: statuses[0].id,
          name: statuses[0].label,
          position: statuses[0].position,
          color: statuses[0].color,
        },
      ]);
      expect(storage.listStatuses).toHaveBeenCalledWith(project.id, { limit: 1000, offset: 0 });
    });

    it('returns session-not-found when listing statuses for unknown session', async () => {
      const response = await service.handleToolCall('devchain_list_statuses', {
        sessionId: MISSING_SESSION_ID,
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('SESSION_NOT_FOUND');
    });

    it('rejects status listing for short sessionId', async () => {
      const response = await service.handleToolCall('devchain_list_statuses', {
        sessionId: 'short',
      });
      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('VALIDATION_ERROR');
    });

    it('lists epics with optional filters', async () => {
      const project = makeProject();
      const status = makeStatus();
      const epic = makeEpic();
      const childEpic = makeEpic({ id: 'child-epic-1', title: 'Child Epic', parentId: epic.id });

      storage.findProjectByPath.mockResolvedValue(project);
      storage.findStatusByName.mockResolvedValue(status);
      storage.listProjectEpics.mockResolvedValue({
        items: [epic],
        total: 1,
        limit: 25,
        offset: 0,
      });
      storage.listStatuses.mockResolvedValue({
        items: [status],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      // Mock batch sub-epic fetch returning child epic for parent
      storage.listSubEpicsForParents.mockResolvedValue(new Map([[epic.id, [childEpic]]]));

      const response = await service.handleToolCall('devchain_list_epics', {
        sessionId: TEST_SESSION_ID,
        statusName: status.label,
        q: 'Epic',
        limit: 25,
        offset: 0,
      });

      expect(response.success).toBe(true);
      expect(storage.findStatusByName).toHaveBeenCalledWith(project.id, status.label);
      expect(storage.listProjectEpics).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          statusId: status.id,
          q: 'Epic',
          limit: 25,
          offset: 0,
          parentOnly: true,
        }),
      );
      expect(storage.listSubEpicsForParents).toHaveBeenCalledWith(
        project.id,
        [epic.id],
        expect.objectContaining({
          excludeMcpHidden: true,
          type: 'active',
          limitPerParent: 50,
        }),
      );

      const payload = response.data as {
        epics: Array<{
          id: string;
          status?: string;
          title: string;
          tags: string[];
          subEpics?: Array<{ id: string; title: string; status?: string }>;
        }>;
        total: number;
      };
      expect(payload.epics[0].id).toBe(epic.id);
      expect(payload.epics[0].status).toBe(status.label);
      expect(payload.epics[0].subEpics).toHaveLength(1);
      expect(payload.epics[0].subEpics?.[0].id).toBe(childEpic.id);
      expect(payload.epics[0].subEpics?.[0].status).toBe(status.label);
      expect(payload.total).toBe(1);
      // tags should always be present (empty array if none)
      expect(payload.epics[0].tags).toEqual([]);
    });

    it('always returns tags array (populated when epic has tags)', async () => {
      const project = makeProject();
      const status = makeStatus();
      const epicWithTags = makeEpic({ tags: ['feature', 'priority:high'] });

      storage.findProjectByPath.mockResolvedValue(project);
      storage.listProjectEpics.mockResolvedValue({
        items: [epicWithTags],
        total: 1,
        limit: 25,
        offset: 0,
      });
      storage.listStatuses.mockResolvedValue({
        items: [status],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listSubEpicsForParents.mockResolvedValue(new Map());

      const response = await service.handleToolCall('devchain_list_epics', {
        sessionId: TEST_SESSION_ID,
      });

      expect(response.success).toBe(true);
      const payload = response.data as {
        epics: Array<{ id: string; tags: string[] }>;
      };
      expect(payload.epics[0].tags).toEqual(['feature', 'priority:high']);
    });

    it('returns status-not-found when filter name does not match', async () => {
      const project = makeProject();
      storage.findProjectByPath.mockResolvedValue(project);
      storage.findStatusByName.mockResolvedValue(null);

      const response = await service.handleToolCall('devchain_list_epics', {
        sessionId: TEST_SESSION_ID,
        statusName: 'Unknown',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('STATUS_NOT_FOUND');
      expect(storage.listProjectEpics).not.toHaveBeenCalled();
    });

    it('returns session-not-found when listing epics for unknown session', async () => {
      const response = await service.handleToolCall('devchain_list_epics', {
        sessionId: MISSING_SESSION_ID,
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('SESSION_NOT_FOUND');
    });

    it('lists epics assigned to a specific agent', async () => {
      const project = makeProject();
      const epic = makeEpic();
      const status = makeStatus();

      storage.findProjectByPath.mockResolvedValue(project);
      storage.listAssignedEpics.mockResolvedValue({
        items: [epic],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listStatuses.mockResolvedValue({
        items: [status],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      const response = await service.handleToolCall('devchain_list_assigned_epics_tasks', {
        sessionId: TEST_SESSION_ID,
        agentName: 'Alpha',
        limit: 100,
        offset: 0,
      });

      expect(response.success).toBe(true);
      expect(storage.listAssignedEpics).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({ agentName: 'Alpha', limit: 100, offset: 0 }),
      );

      const payload = response.data as { epics: Array<{ id: string }>; total: number };
      expect(payload.epics[0].id).toBe(epic.id);
      expect(payload.total).toBe(1);
    });

    it('returns agent-not-found when assigned epics lookup fails', async () => {
      const project = makeProject();

      storage.findProjectByPath.mockResolvedValue(project);
      storage.listAssignedEpics.mockRejectedValue(new NotFoundError('Agent', 'project-1:Alpha'));

      const response = await service.handleToolCall('devchain_list_assigned_epics_tasks', {
        sessionId: TEST_SESSION_ID,
        agentName: 'Alpha',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('AGENT_NOT_FOUND');
    });

    it('returns session-not-found when listing assigned epics for unknown session', async () => {
      const response = await service.handleToolCall('devchain_list_assigned_epics_tasks', {
        sessionId: MISSING_SESSION_ID,
        agentName: 'Alpha',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('SESSION_NOT_FOUND');
    });

    it('creates an epic with defaults and optional assignment', async () => {
      const project = makeProject();
      const epic = makeEpic();

      storage.findProjectByPath.mockResolvedValue(project);
      epicsService.createEpicForProject.mockResolvedValue(epic);

      const response = await service.handleToolCall('devchain_create_epic', {
        sessionId: TEST_SESSION_ID,
        title: 'New Epic',
        description: 'Work',
        tags: ['feature'],
        agentName: 'Alpha',
      });

      expect(response.success).toBe(true);
      expect(epicsService.createEpicForProject).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          title: 'New Epic',
          description: 'Work',
          tags: ['feature'],
          agentName: 'Alpha',
          parentId: null,
        }),
        expect.any(Object),
      );

      expect(response.data).toEqual({ id: epic.id, version: epic.version });
    });

    it('returns agent-not-found when create epic fails to resolve agent', async () => {
      const project = makeProject();
      storage.findProjectByPath.mockResolvedValue(project);
      epicsService.createEpicForProject.mockRejectedValue(
        new NotFoundError('Agent', 'project-1:Alpha'),
      );

      const response = await service.handleToolCall('devchain_create_epic', {
        sessionId: TEST_SESSION_ID,
        title: 'New Epic',
        agentName: 'Alpha',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('AGENT_NOT_FOUND');
    });

    it('passes parentId through when provided', async () => {
      const project = makeProject();
      const epic = makeEpic();

      storage.findProjectByPath.mockResolvedValue(project);
      epicsService.createEpicForProject.mockResolvedValue(epic);

      const response = await service.handleToolCall('devchain_create_epic', {
        sessionId: TEST_SESSION_ID,
        title: 'Child Epic',
        parentId: '6e5ef0d0-0c4b-4d5d-bfce-5fdf52a5b890',
      });

      expect(response.success).toBe(true);
      expect(epicsService.createEpicForProject).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          title: 'Child Epic',
          parentId: '6e5ef0d0-0c4b-4d5d-bfce-5fdf52a5b890',
        }),
        expect.any(Object),
      );
    });

    it('passes skillsRequired through when provided', async () => {
      const project = makeProject();
      const epic = makeEpic({ skillsRequired: ['openai/review'] });

      storage.findProjectByPath.mockResolvedValue(project);
      epicsService.createEpicForProject.mockResolvedValue(epic);

      const response = await service.handleToolCall('devchain_create_epic', {
        sessionId: TEST_SESSION_ID,
        title: 'Skill-gated Epic',
        skillsRequired: ['openai/review'],
      });

      expect(response.success).toBe(true);
      expect(epicsService.createEpicForProject).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          title: 'Skill-gated Epic',
          skillsRequired: ['openai/review'],
        }),
        expect.any(Object),
      );
    });

    it('returns validation error when create epic fails validation', async () => {
      const project = makeProject();
      storage.findProjectByPath.mockResolvedValue(project);
      epicsService.createEpicForProject.mockRejectedValue(new ValidationError('invalid'));

      const response = await service.handleToolCall('devchain_create_epic', {
        sessionId: TEST_SESSION_ID,
        title: 'Invalid Epic',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('VALIDATION_ERROR');
    });

    it('returns session-not-found when creating an epic for unknown session', async () => {
      const response = await service.handleToolCall('devchain_create_epic', {
        sessionId: MISSING_SESSION_ID,
        title: 'New Epic',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns epic details with comments and hierarchy', async () => {
      const project = makeProject();
      const parentEpic = makeEpic({
        id: '44444444-4444-4444-4444-444444444444',
        title: 'Parent Epic',
      });
      const childEpic = makeEpic({
        id: '55555555-5555-5555-5555-555555555555',
        title: 'Child Epic',
        parentId: null,
      });
      const epic = makeEpic({
        id: '66666666-6666-6666-6666-666666666666',
        parentId: parentEpic.id,
      });
      const comment = makeComment({ epicId: epic.id });

      storage.findProjectByPath.mockResolvedValue(project);
      storage.getEpic.mockImplementation(async (id: string) => {
        if (id === epic.id) {
          return epic;
        }
        if (id === parentEpic.id) {
          return parentEpic;
        }
        if (id === childEpic.id) {
          return childEpic;
        }
        throw new NotFoundError('Epic', id);
      });
      storage.listEpicComments.mockResolvedValue({
        items: [comment],
        total: 1,
        limit: 250,
        offset: 0,
      });
      storage.listSubEpics.mockResolvedValue({
        items: [childEpic],
        total: 1,
        limit: 250,
        offset: 0,
      });
      const status = makeStatus();
      storage.listStatuses.mockResolvedValue({
        items: [status],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      const response = await service.handleToolCall('devchain_get_epic_by_id', {
        sessionId: TEST_SESSION_ID,
        id: epic.id,
      });

      expect(response.success).toBe(true);
      const payload = response.data as {
        epic: { id: string; tags: string[]; skillsRequired: string[]; status?: string };
        comments: Array<{ id: string }>;
        subEpics: Array<{ id: string; status?: string }>;
        parent?: { id: string };
      };
      expect(payload.epic.id).toBe(epic.id);
      expect(payload.epic.status).toBe(status.label);
      expect(payload.comments[0].id).toBe(comment.id);
      expect(payload.subEpics[0].id).toBe(childEpic.id);
      expect(payload.subEpics[0].status).toBe(status.label);
      expect(payload.parent?.id).toBe(parentEpic.id);
      // tags should always be present
      expect(payload.epic.tags).toEqual([]);
      // skillsRequired should always be present
      expect(payload.epic.skillsRequired).toEqual([]);
    });

    it('returns epic-not-found when epic lookup fails', async () => {
      const project = makeProject();
      storage.findProjectByPath.mockResolvedValue(project);
      storage.getEpic.mockRejectedValue(
        new NotFoundError('Epic', '77777777-7777-7777-7777-777777777777'),
      );

      const response = await service.handleToolCall('devchain_get_epic_by_id', {
        sessionId: TEST_SESSION_ID,
        id: '77777777-7777-7777-7777-777777777777',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('EPIC_NOT_FOUND');
    });

    it('returns epic-not-found when epic belongs to another project', async () => {
      const project = makeProject();
      const epic = makeEpic({ projectId: 'other-project' });

      storage.findProjectByPath.mockResolvedValue(project);
      storage.getEpic.mockResolvedValue(epic);

      const response = await service.handleToolCall('devchain_get_epic_by_id', {
        sessionId: TEST_SESSION_ID,
        id: epic.id,
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('EPIC_NOT_FOUND');
    });

    it('returns session-not-found when fetching epic for unknown session', async () => {
      const response = await service.handleToolCall('devchain_get_epic_by_id', {
        sessionId: MISSING_SESSION_ID,
        id: '88888888-8888-8888-8888-888888888888',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('SESSION_NOT_FOUND');
    });

    it('includes parent.agentName when parent has assigned agent', async () => {
      const project = makeProject();
      const parentAgentId = 'parent-agent-id';
      const parentEpic = makeEpic({
        id: '44444444-4444-4444-4444-444444444444',
        title: 'Parent Epic',
        agentId: parentAgentId,
      });
      const epic = makeEpic({
        id: '66666666-6666-6666-6666-666666666666',
        parentId: parentEpic.id,
      });

      storage.findProjectByPath.mockResolvedValue(project);
      storage.getEpic.mockImplementation(async (id: string) => {
        if (id === epic.id) return epic;
        if (id === parentEpic.id) return parentEpic;
        throw new NotFoundError('Epic', id);
      });
      // Override getAgent to handle both session agent and parent agent
      storage.getAgent.mockImplementation(async (id: string) => {
        if (id === TEST_AGENT.id) return TEST_AGENT;
        if (id === parentAgentId) {
          return {
            id: parentAgentId,
            name: 'Parent Agent',
            profileId: 'profile-1',
            projectId: project.id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        }
        throw new NotFoundError('Agent', id);
      });
      storage.listEpicComments.mockResolvedValue({
        items: [],
        total: 0,
        limit: 250,
        offset: 0,
      });
      storage.listSubEpics.mockResolvedValue({
        items: [],
        total: 0,
        limit: 250,
        offset: 0,
      });
      storage.listStatuses.mockResolvedValue({
        items: [],
        total: 0,
        limit: 1000,
        offset: 0,
      });

      const response = await service.handleToolCall('devchain_get_epic_by_id', {
        sessionId: TEST_SESSION_ID,
        id: epic.id,
      });

      expect(response.success).toBe(true);
      const payload = response.data as {
        epic: { id: string };
        parent?: { id: string; agentName?: string | null };
      };
      expect(payload.parent?.id).toBe(parentEpic.id);
      expect(payload.parent?.agentName).toBe('Parent Agent');
    });

    it('includes parent.agentName as null when parent has no agent', async () => {
      const project = makeProject();
      const parentEpic = makeEpic({
        id: '44444444-4444-4444-4444-444444444444',
        title: 'Parent Epic',
        agentId: null, // No agent assigned
      });
      const epic = makeEpic({
        id: '66666666-6666-6666-6666-666666666666',
        parentId: parentEpic.id,
      });

      storage.findProjectByPath.mockResolvedValue(project);
      storage.getEpic.mockImplementation(async (id: string) => {
        if (id === epic.id) return epic;
        if (id === parentEpic.id) return parentEpic;
        throw new NotFoundError('Epic', id);
      });
      storage.listEpicComments.mockResolvedValue({
        items: [],
        total: 0,
        limit: 250,
        offset: 0,
      });
      storage.listSubEpics.mockResolvedValue({
        items: [],
        total: 0,
        limit: 250,
        offset: 0,
      });
      storage.listStatuses.mockResolvedValue({
        items: [],
        total: 0,
        limit: 1000,
        offset: 0,
      });

      const response = await service.handleToolCall('devchain_get_epic_by_id', {
        sessionId: TEST_SESSION_ID,
        id: epic.id,
      });

      expect(response.success).toBe(true);
      const payload = response.data as {
        epic: { id: string };
        parent?: { id: string; agentName?: string | null };
      };
      expect(payload.parent?.id).toBe(parentEpic.id);
      expect(payload.parent?.agentName).toBeNull();
    });

    it('adds a comment to an epic', async () => {
      const project = makeProject();
      const epic = makeEpic();
      const comment = makeComment({ epicId: epic.id, content: 'Ship it' });

      storage.findProjectByPath.mockResolvedValue(project);
      storage.getEpic.mockResolvedValue(epic);
      epicsService.addEpicComment.mockResolvedValue(comment);

      // Author identity now comes from session context (TEST_AGENT.name)
      const response = await service.handleToolCall('devchain_add_epic_comment', {
        sessionId: TEST_SESSION_ID,
        epicId: epic.id,
        content: 'Ship it',
      });

      expect(response.success).toBe(true);
      expect(epicsService.addEpicComment).toHaveBeenCalledWith(
        epic.id,
        project.id,
        'Ship it',
        TEST_AGENT.id,
        'agent',
      );

      expect(response.data).toEqual({ id: comment.id });
    });

    it('returns epic-not-found when adding a comment to unknown epic', async () => {
      const project = makeProject();
      storage.findProjectByPath.mockResolvedValue(project);
      epicsService.addEpicComment.mockRejectedValue(
        new NotFoundError('Epic', '77777777-7777-7777-7777-777777777777'),
      );

      const response = await service.handleToolCall('devchain_add_epic_comment', {
        sessionId: TEST_SESSION_ID,
        epicId: '77777777-7777-7777-7777-777777777777',
        content: 'Looks good',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('EPIC_NOT_FOUND');
    });

    it('returns validation-error when commenting on epic from another project', async () => {
      const project = makeProject();

      storage.findProjectByPath.mockResolvedValue(project);
      epicsService.addEpicComment.mockRejectedValue(
        new ValidationError('Epic does not belong to project', {
          epicId: '22222222-2222-2222-2222-222222222222',
          projectId: project.id,
        }),
      );

      const response = await service.handleToolCall('devchain_add_epic_comment', {
        sessionId: TEST_SESSION_ID,
        epicId: '22222222-2222-2222-2222-222222222222',
        content: 'Looks good',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('VALIDATION_ERROR');
    });

    it('returns session-not-found when adding comment for unknown session', async () => {
      const response = await service.handleToolCall('devchain_add_epic_comment', {
        sessionId: MISSING_SESSION_ID,
        epicId: '88888888-8888-8888-8888-888888888888',
        content: 'Looks good',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns AGENT_REQUIRED when adding comment from session without agent', async () => {
      const project = makeProject();
      storage.findProjectByPath.mockResolvedValue(project);
      (storage as unknown as { getProject: jest.Mock }).getProject.mockResolvedValue(project);

      // Session with null agentId
      const sessionId = 'null-agent-session-id-00000000000000';
      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue([
        {
          id: sessionId,
          agentId: null,
          tmuxSessionId: 'tmux-1',
          status: 'running',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: null,
          epicId: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ]);

      const response = await service.handleToolCall('devchain_add_epic_comment', {
        sessionId,
        epicId: '88888888-8888-8888-8888-888888888888',
        content: 'Looks good',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('AGENT_REQUIRED');
    });

    describe('devchain_update_epic', () => {
      const makeAgent = (overrides: Partial<Agent> = {}): Agent => ({
        id: 'agent-1',
        projectId: 'project-1',
        profileId: 'profile-1',
        name: 'Alpha',
        description: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        ...overrides,
      });

      beforeEach(() => {
        epicsService.updateEpicWithOutcome = jest.fn();
      });

      it('updates title and description successfully', async () => {
        const project = makeProject();
        const epic = makeEpic({ version: 1 });
        const updatedEpic = makeEpic({
          title: 'New Title',
          description: 'New description',
          version: 2,
        });

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockResolvedValue(epic);
        epicsService.updateEpicWithOutcome.mockResolvedValue(withOutcome(updatedEpic));

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          title: 'New Title',
          description: 'New description',
        });

        expect(response.success).toBe(true);
        expect(epicsService.updateEpicWithOutcome).toHaveBeenCalledWith(
          epic.id,
          expect.objectContaining({
            title: 'New Title',
            description: 'New description',
          }),
          1,
          expect.any(Object),
        );

        expect(response.data).toEqual({ id: epic.id, version: 2 });
      });

      it('updates status by name (case-insensitive)', async () => {
        const project = makeProject();
        const status = makeStatus({ label: 'In Progress' });
        const epic = makeEpic({ version: 1 });
        const updatedEpic = makeEpic({ statusId: status.id, version: 2 });

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockResolvedValue(epic);
        storage.findStatusByName.mockResolvedValue(status);
        epicsService.updateEpicWithOutcome.mockResolvedValue(withOutcome(updatedEpic));

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          statusName: 'in progress',
        });

        expect(response.success).toBe(true);
        expect(storage.findStatusByName).toHaveBeenCalledWith(project.id, 'in progress');
        expect(epicsService.updateEpicWithOutcome).toHaveBeenCalledWith(
          epic.id,
          expect.objectContaining({
            statusId: status.id,
          }),
          1,
          expect.any(Object),
        );
      });

      it('returns STATUS_NOT_FOUND with availableStatuses when status name does not match', async () => {
        const project = makeProject();
        const epic = makeEpic({ version: 1 });
        const status1 = makeStatus({ label: 'Backlog' });
        const status2 = makeStatus({ id: 'status-2', label: 'In Progress' });

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockResolvedValue(epic);
        storage.findStatusByName.mockResolvedValue(null);
        storage.listStatuses.mockResolvedValue({
          items: [status1, status2],
          total: 2,
          limit: 1000,
          offset: 0,
        });

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          statusName: 'Unknown',
        });

        expect(response.success).toBe(false);
        expect(response.error?.code).toBe('STATUS_NOT_FOUND');
        const errorData = response.error?.data as {
          availableStatuses?: Array<{ id: string; name: string }>;
        };
        expect(errorData?.availableStatuses).toEqual([
          { id: status1.id, name: status1.label },
          { id: status2.id, name: status2.label },
        ]);
      });

      it('assigns agent by name (case-insensitive)', async () => {
        const project = makeProject();
        const epic = makeEpic({ version: 1 });
        const agent = makeAgent({ name: 'Worker' });
        const updatedEpic = makeEpic({ agentId: agent.id, version: 2 });

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockResolvedValue(epic);
        storage.getAgentByName.mockResolvedValue(agent);
        epicsService.updateEpicWithOutcome.mockResolvedValue(withOutcome(updatedEpic));

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          assignment: { agentName: 'worker' },
        });

        expect(response.success).toBe(true);
        expect(storage.getAgentByName).toHaveBeenCalledWith(project.id, 'worker');
        expect(epicsService.updateEpicWithOutcome).toHaveBeenCalledWith(
          epic.id,
          expect.objectContaining({
            agentId: agent.id,
          }),
          1,
          expect.any(Object),
        );
      });

      it('clears assignment when clear: true is provided', async () => {
        const project = makeProject();
        const epic = makeEpic({ agentId: 'agent-1', version: 1 });
        const updatedEpic = makeEpic({ agentId: null, version: 2 });

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockResolvedValue(epic);
        epicsService.updateEpicWithOutcome.mockResolvedValue(withOutcome(updatedEpic));

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          assignment: { clear: true },
        });

        expect(response.success).toBe(true);
        expect(epicsService.updateEpicWithOutcome).toHaveBeenCalledWith(
          epic.id,
          expect.objectContaining({
            agentId: null,
          }),
          1,
          expect.any(Object),
        );
      });

      it('returns AGENT_NOT_FOUND with availableAgents when agent name does not match', async () => {
        const project = makeProject();
        const epic = makeEpic({ version: 1 });
        const agent1 = makeAgent({ name: 'Alpha' });
        const agent2 = makeAgent({ id: 'agent-2', name: 'Beta' });

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockResolvedValue(epic);
        storage.getAgentByName.mockRejectedValue(new NotFoundError('Agent', 'Unknown'));
        storage.listAgents.mockResolvedValue({
          items: [agent1, agent2],
          total: 2,
          limit: 1000,
          offset: 0,
        });

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          assignment: { agentName: 'Unknown' },
        });

        expect(response.success).toBe(false);
        expect(response.error?.code).toBe('AGENT_NOT_FOUND');
        const errorData = response.error?.data as {
          availableAgents?: Array<{ id: string; name: string }>;
        };
        expect(errorData?.availableAgents).toEqual([
          { id: agent1.id, name: agent1.name },
          { id: agent2.id, name: agent2.name },
        ]);
      });

      it('sets tags completely with setTags', async () => {
        const project = makeProject();
        const epic = makeEpic({ tags: ['old', 'existing'], version: 1 });
        const updatedEpic = makeEpic({ tags: ['new', 'fresh'], version: 2 });

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockResolvedValue(epic);
        epicsService.updateEpicWithOutcome.mockResolvedValue(withOutcome(updatedEpic));

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          setTags: ['new', 'fresh'],
        });

        expect(response.success).toBe(true);
        expect(epicsService.updateEpicWithOutcome).toHaveBeenCalledWith(
          epic.id,
          expect.objectContaining({
            tags: ['new', 'fresh'],
          }),
          1,
          expect.any(Object),
        );
      });

      it('adds and removes tags incrementally', async () => {
        const project = makeProject();
        const epic = makeEpic({ tags: ['feature', 'priority:high'], version: 1 });
        const updatedEpic = makeEpic({ tags: ['feature', 'reviewed', 'ready'], version: 2 });

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockResolvedValue(epic);
        epicsService.updateEpicWithOutcome.mockResolvedValue(withOutcome(updatedEpic));

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          addTags: ['reviewed', 'ready'],
          removeTags: ['priority:high'],
        });

        expect(response.success).toBe(true);
        expect(epicsService.updateEpicWithOutcome).toHaveBeenCalledWith(
          epic.id,
          expect.objectContaining({
            tags: expect.arrayContaining(['feature', 'reviewed', 'ready']),
          }),
          1,
          expect.any(Object),
        );
      });

      it('replaces skillsRequired when provided', async () => {
        const project = makeProject();
        const epic = makeEpic({ skillsRequired: ['openai/review'], version: 1 });
        const updatedEpic = makeEpic({
          skillsRequired: ['openai/review', 'anthropic/pdf'],
          version: 2,
        });

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockResolvedValue(epic);
        epicsService.updateEpicWithOutcome.mockResolvedValue(withOutcome(updatedEpic));

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          skillsRequired: ['openai/review', 'anthropic/pdf'],
        });

        expect(response.success).toBe(true);
        expect(epicsService.updateEpicWithOutcome).toHaveBeenCalledWith(
          epic.id,
          expect.objectContaining({
            skillsRequired: ['openai/review', 'anthropic/pdf'],
          }),
          1,
          expect.any(Object),
        );
      });

      it('sets parent epic successfully', async () => {
        const project = makeProject();
        const parentEpic = makeEpic({
          id: '99999999-9999-9999-9999-999999999999',
          parentId: null,
        });
        const epic = makeEpic({ version: 1 });
        const updatedEpic = makeEpic({ parentId: parentEpic.id, version: 2 });

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockImplementation(async (id: string) => {
          if (id === epic.id) {
            return epic;
          }
          if (id === parentEpic.id) {
            return parentEpic;
          }
          throw new NotFoundError('Epic', id);
        });
        epicsService.updateEpicWithOutcome.mockResolvedValue(withOutcome(updatedEpic));

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          parentId: parentEpic.id,
        });

        expect(response.success).toBe(true);
        expect(epicsService.updateEpicWithOutcome).toHaveBeenCalledWith(
          epic.id,
          expect.objectContaining({
            parentId: parentEpic.id,
          }),
          1,
          expect.any(Object),
        );
      });

      it('clears parent with clearParent: true', async () => {
        const project = makeProject();
        const epic = makeEpic({
          parentId: '99999999-9999-9999-9999-999999999999',
          version: 1,
        });
        const updatedEpic = makeEpic({ parentId: null, version: 2 });

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockResolvedValue(epic);
        epicsService.updateEpicWithOutcome.mockResolvedValue(withOutcome(updatedEpic));

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          clearParent: true,
        });

        expect(response.success).toBe(true);
        expect(epicsService.updateEpicWithOutcome).toHaveBeenCalledWith(
          epic.id,
          expect.objectContaining({
            parentId: null,
          }),
          1,
          expect.any(Object),
        );
      });

      it('rejects self-parenting', async () => {
        const project = makeProject();
        const epic = makeEpic({ version: 1 });

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockResolvedValue(epic);

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          parentId: epic.id,
        });

        expect(response.success).toBe(false);
        expect(response.error?.code).toBe('PARENT_INVALID');
        expect(response.error?.message).toContain('cannot be its own parent');
      });

      it('rejects multi-level hierarchy (parent already has a parent)', async () => {
        const project = makeProject();
        const grandparent = makeEpic({
          id: '88888888-8888-8888-8888-888888888888',
          parentId: null,
        });
        const parent = makeEpic({
          id: '99999999-9999-9999-9999-999999999999',
          parentId: grandparent.id,
        });
        const epic = makeEpic({ version: 1 });

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockImplementation(async (id: string) => {
          if (id === epic.id) {
            return epic;
          }
          if (id === parent.id) {
            return parent;
          }
          throw new NotFoundError('Epic', id);
        });
        // Storage delegate's ensureValidEpicParent throws ValidationError for sub-epic parent
        epicsService.updateEpicWithOutcome.mockRejectedValue(
          new ValidationError('Cannot assign a sub-epic as a parent (one-level hierarchy).', {
            parentId: parent.id,
          }),
        );

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          parentId: parent.id,
        });

        expect(response.success).toBe(false);
        expect(response.error?.code).toBe('HIERARCHY_CONFLICT');
        expect(response.error?.message).toContain('one-level');
      });

      it('returns PARENT_INVALID when parent epic not found', async () => {
        const project = makeProject();
        const epic = makeEpic({ version: 1 });

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockImplementation(async (id: string) => {
          if (id === epic.id) {
            return epic;
          }
          throw new NotFoundError('Epic', id);
        });

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          parentId: '77777777-7777-7777-7777-777777777777',
        });

        expect(response.success).toBe(false);
        expect(response.error?.code).toBe('PARENT_INVALID');
        expect(response.error?.message).toContain('not found');
      });

      it('returns VERSION_CONFLICT with currentVersion on optimistic lock failure', async () => {
        const project = makeProject();
        const epic = makeEpic({ version: 1 });
        const currentEpic = makeEpic({ version: 3 });

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockResolvedValueOnce(epic).mockResolvedValueOnce(currentEpic);
        epicsService.updateEpicWithOutcome.mockRejectedValue(
          new Error('Epic epic-id was modified by another operation'),
        );

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          title: 'New Title',
        });

        expect(response.success).toBe(false);
        expect(response.error?.code).toBe('VERSION_CONFLICT');
        const errorData = response.error?.data as { currentVersion?: number };
        expect(errorData?.currentVersion).toBe(3);
      });

      it('returns EPIC_NOT_FOUND when epic does not exist', async () => {
        const project = makeProject();

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockRejectedValue(
          new NotFoundError('Epic', '77777777-7777-7777-7777-777777777777'),
        );

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: '77777777-7777-7777-7777-777777777777',
          version: 1,
          title: 'New Title',
        });

        expect(response.success).toBe(false);
        expect(response.error?.code).toBe('EPIC_NOT_FOUND');
      });

      it('returns EPIC_NOT_FOUND when epic belongs to different project', async () => {
        const project = makeProject();
        const epic = makeEpic({ projectId: 'other-project', version: 1 });

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockResolvedValue(epic);

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          title: 'New Title',
        });

        expect(response.success).toBe(false);
        expect(response.error?.code).toBe('EPIC_NOT_FOUND');
        expect(response.error?.message).toContain('does not belong');
      });

      it('returns SESSION_NOT_FOUND when session is unknown', async () => {
        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: MISSING_SESSION_ID,
          id: '88888888-8888-8888-8888-888888888888',
          version: 1,
          title: 'New Title',
        });

        expect(response.success).toBe(false);
        expect(response.error?.code).toBe('SESSION_NOT_FOUND');
      });

      describe('self-assignment hint', () => {
        const STATUS_B_ID = '11111111-1111-1111-1111-11111111bbbb';
        const CALLER_ID = TEST_AGENT.id;
        const CALLER_NAME = TEST_AGENT.name;

        it('emits hint when status changes and epic stays self-assigned with no assignment field', async () => {
          const project = makeProject();
          const statusB = makeStatus({ id: STATUS_B_ID, label: 'In Review' });
          const epic = makeEpic({ agentId: CALLER_ID, version: 1 });
          const updatedEpic = makeEpic({
            agentId: CALLER_ID,
            statusId: statusB.id,
            version: 2,
          });

          storage.findProjectByPath.mockResolvedValue(project);
          storage.getEpic.mockResolvedValue(epic);
          storage.findStatusByName.mockResolvedValue(statusB);
          epicsService.updateEpicWithOutcome.mockResolvedValue(
            withOutcome(updatedEpic, {
              statusChanged: true,
              agentUnchanged: true,
              previousAssigneeAgent: { id: CALLER_ID, name: CALLER_NAME },
            }),
          );

          const response = await service.handleToolCall('devchain_update_epic', {
            sessionId: TEST_SESSION_ID,
            id: epic.id,
            version: 1,
            statusName: 'In Review',
          });

          expect(response.success).toBe(true);
          const payload = response.data as { epic: unknown; hint?: string };
          expect(typeof payload.hint).toBe('string');
          expect(payload.hint!.length).toBeGreaterThan(0);
          expect(payload.hint).toContain(CALLER_NAME);
          expect(payload.hint).toContain('assignment: { agentName');
        });

        it('does not emit hint when caller hands off to a different agent', async () => {
          const project = makeProject();
          const statusB = makeStatus({ id: STATUS_B_ID, label: 'In Review' });
          const otherAgent = makeAgent({ id: 'agent-2', name: 'OtherAgent' });
          const epic = makeEpic({ agentId: CALLER_ID, version: 1 });
          const updatedEpic = makeEpic({
            agentId: otherAgent.id,
            statusId: statusB.id,
            version: 2,
          });

          storage.findProjectByPath.mockResolvedValue(project);
          storage.getEpic.mockResolvedValue(epic);
          storage.findStatusByName.mockResolvedValue(statusB);
          storage.getAgentByName.mockResolvedValue(otherAgent);
          epicsService.updateEpicWithOutcome.mockResolvedValue(withOutcome(updatedEpic));

          const response = await service.handleToolCall('devchain_update_epic', {
            sessionId: TEST_SESSION_ID,
            id: epic.id,
            version: 1,
            statusName: 'In Review',
            assignment: { agentName: otherAgent.name },
          });

          expect(response.success).toBe(true);
          expect((response.data as { hint?: string }).hint).toBeUndefined();
        });

        it('does not emit hint for guest sessions', async () => {
          // Guest context mirrors the setup in the `guest restrictions` describe
          // block (~line 4165): sessionId does not match an active agent session,
          // so `resolveSessionContext` falls through to guest resolution.
          const GUEST_ID = 'guest-00000000-0000-0000-0000-000000000001';
          const guestRecord = {
            id: GUEST_ID,
            projectId: 'project-1',
            name: 'GuestBot',
            tmuxSessionId: 'guest-tmux-session',
            lastSeenAt: '2024-01-01T00:00:00Z',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          };
          const project = makeProject();
          const statusB = makeStatus({ id: STATUS_B_ID, label: 'In Review' });
          const epic = makeEpic({ agentId: null, version: 1 });
          const updatedEpic = makeEpic({
            agentId: null,
            statusId: statusB.id,
            version: 2,
          });

          (storage as unknown as { getGuest: jest.Mock }).getGuest = jest
            .fn()
            .mockResolvedValue(guestRecord);
          (storage as unknown as { getGuestsByIdPrefix: jest.Mock }).getGuestsByIdPrefix = jest
            .fn()
            .mockResolvedValue([guestRecord]);
          (storage as unknown as { getProject: jest.Mock }).getProject.mockResolvedValue(project);
          (terminalIO as { sessionExists: jest.Mock }).sessionExists.mockResolvedValue(true);

          storage.getEpic.mockResolvedValue(epic);
          storage.findStatusByName.mockResolvedValue(statusB);
          epicsService.updateEpicWithOutcome.mockResolvedValue(withOutcome(updatedEpic));

          const response = await service.handleToolCall('devchain_update_epic', {
            sessionId: GUEST_ID,
            id: epic.id,
            version: 1,
            statusName: 'In Review',
          });

          // Whether the guest path succeeds or is rejected upstream, no hint
          // must surface on either branch.
          if (response.success) {
            expect((response.data as { hint?: string }).hint).toBeUndefined();
          } else {
            expect(response.data).toBeUndefined();
          }
        });

        it('does not emit hint when status is unchanged (title-only edit)', async () => {
          const project = makeProject();
          const epic = makeEpic({ agentId: CALLER_ID, version: 1 });
          const updatedEpic = makeEpic({
            agentId: CALLER_ID,
            title: 'New title',
            version: 2,
          });

          storage.findProjectByPath.mockResolvedValue(project);
          storage.getEpic.mockResolvedValue(epic);
          epicsService.updateEpicWithOutcome.mockResolvedValue(withOutcome(updatedEpic));

          const response = await service.handleToolCall('devchain_update_epic', {
            sessionId: TEST_SESSION_ID,
            id: epic.id,
            version: 1,
            title: 'New title',
          });

          expect(response.success).toBe(true);
          expect((response.data as { hint?: string }).hint).toBeUndefined();
        });

        it('does not emit hint when status changes but epic is unassigned via clear: true', async () => {
          const project = makeProject();
          const statusB = makeStatus({ id: STATUS_B_ID, label: 'In Review' });
          const epic = makeEpic({ agentId: CALLER_ID, version: 1 });
          const updatedEpic = makeEpic({
            agentId: null,
            statusId: statusB.id,
            version: 2,
          });

          storage.findProjectByPath.mockResolvedValue(project);
          storage.getEpic.mockResolvedValue(epic);
          storage.findStatusByName.mockResolvedValue(statusB);
          epicsService.updateEpicWithOutcome.mockResolvedValue(withOutcome(updatedEpic));

          const response = await service.handleToolCall('devchain_update_epic', {
            sessionId: TEST_SESSION_ID,
            id: epic.id,
            version: 1,
            statusName: 'In Review',
            assignment: { clear: true },
          });

          expect(response.success).toBe(true);
          expect((response.data as { hint?: string }).hint).toBeUndefined();
        });

        it('does not emit hint when caller explicitly self-assigns via assignment.agentName', async () => {
          const project = makeProject();
          const statusB = makeStatus({ id: STATUS_B_ID, label: 'In Review' });
          const epic = makeEpic({ agentId: CALLER_ID, version: 1 });
          const updatedEpic = makeEpic({
            agentId: CALLER_ID,
            statusId: statusB.id,
            version: 2,
          });

          storage.findProjectByPath.mockResolvedValue(project);
          storage.getEpic.mockResolvedValue(epic);
          storage.findStatusByName.mockResolvedValue(statusB);
          storage.getAgentByName.mockResolvedValue(TEST_AGENT);
          epicsService.updateEpicWithOutcome.mockResolvedValue(withOutcome(updatedEpic));

          const response = await service.handleToolCall('devchain_update_epic', {
            sessionId: TEST_SESSION_ID,
            id: epic.id,
            version: 1,
            statusName: 'In Review',
            assignment: { agentName: CALLER_NAME },
          });

          expect(response.success).toBe(true);
          expect((response.data as { hint?: string }).hint).toBeUndefined();
        });

        it('does not emit hint when caller self-assigns a previously unassigned epic on status change', async () => {
          const project = makeProject();
          const statusB = makeStatus({ id: STATUS_B_ID, label: 'In Review' });
          const epic = makeEpic({ agentId: null, version: 1 });
          const updatedEpic = makeEpic({
            agentId: CALLER_ID,
            statusId: statusB.id,
            version: 2,
          });

          storage.findProjectByPath.mockResolvedValue(project);
          storage.getEpic.mockResolvedValue(epic);
          storage.findStatusByName.mockResolvedValue(statusB);
          storage.getAgentByName.mockResolvedValue(TEST_AGENT);
          epicsService.updateEpicWithOutcome.mockResolvedValue(withOutcome(updatedEpic));

          const response = await service.handleToolCall('devchain_update_epic', {
            sessionId: TEST_SESSION_ID,
            id: epic.id,
            version: 1,
            statusName: 'In Review',
            assignment: { agentName: CALLER_NAME },
          });

          expect(response.success).toBe(true);
          expect((response.data as { hint?: string }).hint).toBeUndefined();
        });
      });
    });

    describe('epic ID prefix resolution', () => {
      it('devchain_get_epic_by_id resolves 8-char prefix and returns epic', async () => {
        const project = makeProject();
        const epic = makeEpic();
        const comment = makeComment({ epicId: epic.id });

        storage.findProjectByPath.mockResolvedValue(project);
        (
          storage as unknown as { getEpicsByIdPrefix: jest.Mock }
        ).getEpicsByIdPrefix.mockResolvedValue([{ id: epic.id, title: epic.title }]);
        storage.getEpic.mockResolvedValue(epic);
        storage.listEpicComments.mockResolvedValue({
          items: [comment],
          total: 1,
          limit: 250,
          offset: 0,
        });
        storage.listSubEpics.mockResolvedValue({
          items: [],
          total: 0,
          limit: 250,
          offset: 0,
        });
        storage.listStatuses.mockResolvedValue({
          items: [],
          total: 0,
          limit: 1000,
          offset: 0,
        });

        const prefix = epic.id.substring(0, 8);
        const response = await service.handleToolCall('devchain_get_epic_by_id', {
          sessionId: TEST_SESSION_ID,
          id: prefix,
        });

        expect(response.success).toBe(true);
        const payload = response.data as { epic: { id: string } };
        expect(payload.epic.id).toBe(epic.id);
        // Verify storage.getEpic was called with the RESOLVED full UUID, not the prefix
        expect(storage.getEpic).toHaveBeenCalledWith(epic.id);
      });

      it('devchain_get_epic_by_id returns AMBIGUOUS_EPIC for ambiguous prefix', async () => {
        const project = makeProject();
        storage.findProjectByPath.mockResolvedValue(project);
        (
          storage as unknown as { getEpicsByIdPrefix: jest.Mock }
        ).getEpicsByIdPrefix.mockResolvedValue([
          { id: 'aabbccdd-1111-1111-1111-111111111111', title: 'Epic A' },
          { id: 'aabbccdd-2222-2222-2222-222222222222', title: 'Epic B' },
        ]);

        const response = await service.handleToolCall('devchain_get_epic_by_id', {
          sessionId: TEST_SESSION_ID,
          id: 'aabbccdd',
        });

        expect(response.success).toBe(false);
        expect(response.error?.code).toBe('AMBIGUOUS_EPIC');
      });

      it('devchain_update_epic resolves prefix and updates correct epic', async () => {
        const project = makeProject();
        const epic = makeEpic({ version: 1 });
        const updatedEpic = makeEpic({ title: 'Updated', version: 2 });

        storage.findProjectByPath.mockResolvedValue(project);
        (
          storage as unknown as { getEpicsByIdPrefix: jest.Mock }
        ).getEpicsByIdPrefix.mockResolvedValue([{ id: epic.id, title: epic.title }]);
        storage.getEpic.mockResolvedValue(epic);
        epicsService.updateEpicWithOutcome.mockResolvedValue(withOutcome(updatedEpic));

        const prefix = epic.id.substring(0, 8);
        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: prefix,
          version: 1,
          title: 'Updated',
        });

        expect(response.success).toBe(true);
        // Verify epicsService.updateEpicWithOutcome called with RESOLVED full UUID
        expect(epicsService.updateEpicWithOutcome).toHaveBeenCalledWith(
          epic.id,
          expect.objectContaining({ title: 'Updated' }),
          1,
          expect.any(Object),
        );
      });

      it('devchain_add_epic_comment resolves prefix and adds comment to correct epic', async () => {
        const project = makeProject();
        const epic = makeEpic();
        const comment = makeComment({ epicId: epic.id, content: 'New comment' });

        storage.findProjectByPath.mockResolvedValue(project);
        (
          storage as unknown as { getEpicsByIdPrefix: jest.Mock }
        ).getEpicsByIdPrefix.mockResolvedValue([{ id: epic.id, title: epic.title }]);
        storage.getEpic.mockResolvedValue(epic);
        epicsService.addEpicComment.mockResolvedValue(comment);

        const prefix = epic.id.substring(0, 8);
        const response = await service.handleToolCall('devchain_add_epic_comment', {
          sessionId: TEST_SESSION_ID,
          epicId: prefix,
          content: 'New comment',
        });

        expect(response.success).toBe(true);
        // Verify addEpicComment called with RESOLVED full UUID
        expect(epicsService.addEpicComment).toHaveBeenCalledWith(
          epic.id,
          project.id,
          'New comment',
          TEST_AGENT.id,
          'agent',
        );
      });

      it('full UUID still works without calling getEpicsByIdPrefix', async () => {
        const project = makeProject();
        const epic = makeEpic();

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockResolvedValue(epic);
        storage.listEpicComments.mockResolvedValue({
          items: [],
          total: 0,
          limit: 250,
          offset: 0,
        });
        storage.listSubEpics.mockResolvedValue({
          items: [],
          total: 0,
          limit: 250,
          offset: 0,
        });
        storage.listStatuses.mockResolvedValue({
          items: [],
          total: 0,
          limit: 1000,
          offset: 0,
        });

        const response = await service.handleToolCall('devchain_get_epic_by_id', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
        });

        expect(response.success).toBe(true);
        // Full UUID should bypass prefix resolution entirely
        expect(
          (storage as unknown as { getEpicsByIdPrefix: jest.Mock }).getEpicsByIdPrefix,
        ).not.toHaveBeenCalled();
      });

      it('devchain_get_epic_by_id rejects wildcard characters at schema level', async () => {
        const response = await service.handleToolCall('devchain_get_epic_by_id', {
          sessionId: TEST_SESSION_ID,
          id: 'abcd1234%_',
        });

        expect(response.success).toBe(false);
        expect(response.error?.code).toBe('VALIDATION_ERROR');
      });

      it('devchain_update_epic rejects wildcard characters at schema level', async () => {
        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: 'abcd1234%_',
          version: 1,
          title: 'Updated',
        });

        expect(response.success).toBe(false);
        expect(response.error?.code).toBe('VALIDATION_ERROR');
      });

      it('devchain_add_epic_comment rejects wildcard characters at schema level', async () => {
        const response = await service.handleToolCall('devchain_add_epic_comment', {
          sessionId: TEST_SESSION_ID,
          epicId: 'abcd1234%_',
          content: 'hello',
        });

        expect(response.success).toBe(false);
        expect(response.error?.code).toBe('VALIDATION_ERROR');
      });

      it('devchain_delete_epic resolves prefix and routes through epicsService.deleteEpic', async () => {
        const project = makeProject();
        const epic = makeEpic({
          id: 'aaaaaaaa-2222-3333-4444-bbbbbbbbbbbb',
          title: 'Delete Target',
          parentId: '99999999-9999-9999-9999-999999999999',
          version: 7,
        });

        storage.findProjectByPath.mockResolvedValue(project);
        (
          storage as unknown as { getEpicsByIdPrefix: jest.Mock }
        ).getEpicsByIdPrefix.mockResolvedValue([{ id: epic.id, title: epic.title }]);
        storage.getEpic.mockResolvedValue(epic);
        epicsService.deleteEpic.mockResolvedValue(undefined);

        const response = await service.handleToolCall('devchain_delete_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id.substring(0, 8),
        });

        expect(response.success).toBe(true);
        expect(epicsService.deleteEpic).toHaveBeenCalledWith(
          epic.id,
          expect.objectContaining({
            actor: expect.objectContaining({
              type: 'agent',
              id: TEST_AGENT.id,
            }),
          }),
        );
        expect(response.data).toEqual({
          id: epic.id,
          deleted: true,
        });
      });
    });
  });
});
