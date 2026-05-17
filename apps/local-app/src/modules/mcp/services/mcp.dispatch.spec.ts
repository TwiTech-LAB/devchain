import { McpService } from './mcp.service';
import { DEFAULT_FEATURE_FLAGS } from '../../../common/config/feature-flags';
import { NotFoundError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { Agent, Document, Prompt, Project } from '../../storage/models/domain.models';

const TEST_SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
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
  let messagePoolService: jest.Mocked<unknown>;
  let terminalGateway: jest.Mocked<unknown>;
  let epicsService: jest.Mocked<{ updateEpic: jest.Mock; createEpicForProject: jest.Mock }>;
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
    } as { updateEpic: jest.Mock; createEpicForProject: jest.Mock };

    messagePoolService = {
      enqueue: jest.fn().mockResolvedValue({ status: 'queued', poolSize: 1 }),
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

    service = new McpService(
      storage,
      chatService as never,
      sessionsService as never,
      messagePoolService as never,
      terminalGateway as never,
      epicsService as never,
      settingsService as never,
      guestsService as never,
      skillsService as never,
      reviewsService as never,
      teamsService as never,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // --- Param validation (dispatch infrastructure) ---
  it('includes suggestions for misplaced params in validation errors', async () => {
    // Passing agentName at top level instead of assignment.agentName
    const response = await service.handleToolCall('devchain_update_epic', {
      sessionId: TEST_SESSION_ID,
      id: '00000000-0000-0000-0000-000000000001',
      version: 1,
      agentName: 'Epic Manager', // Wrong! Should be assignment.agentName
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('VALIDATION_ERROR');
    // Verify suggestions are included
    const data = response.error?.data as { issues: unknown[]; suggestions?: string[] };
    expect(data.suggestions).toBeDefined();
    expect(data.suggestions).toContain('Did you mean: assignment.agentName?');
  });

  it('does not include suggestions for unknown keys without nested alternatives', async () => {
    // Passing a completely unknown field
    const response = await service.handleToolCall('devchain_update_epic', {
      sessionId: TEST_SESSION_ID,
      id: '00000000-0000-0000-0000-000000000001',
      version: 1,
      totallyUnknownField: 'value',
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('VALIDATION_ERROR');
    // Verify no suggestions for truly unknown keys
    const data = response.error?.data as { issues: unknown[]; suggestions?: string[] };
    expect(data.suggestions).toBeUndefined();
  });

  // --- Resource resolution ---
  it('returns document content for doc:// resource', async () => {
    const document: Document = {
      id: 'doc-1',
      projectId: null,
      title: 'Global Doc',
      slug: 'global-doc',
      contentMd: '# Global',
      archived: false,
      version: 1,
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    };

    storage.getDocument.mockResolvedValue(document);

    const response = await service.handleResourceRequest('doc://global/global-doc');

    expect(response.success).toBe(true);
    const payload = response.data as { content: string; document: { id: string } };
    expect(payload.content).toBe('# Global');
    expect(payload.document.id).toBe('doc-1');
  });

  it('returns prompt content for prompt:// resource', async () => {
    const prompt: Prompt = {
      id: 'prompt-1',
      projectId: null,
      title: 'Welcome Prompt',
      content: 'Hello world',
      tags: ['intro'],
      version: 2,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    };
    const promptSummary = {
      id: prompt.id,
      projectId: prompt.projectId,
      title: prompt.title,
      contentPreview: prompt.content,
      tags: prompt.tags,
      version: prompt.version,
      createdAt: prompt.createdAt,
      updatedAt: prompt.updatedAt,
    };

    storage.listPrompts.mockResolvedValue({
      items: [promptSummary],
      total: 1,
      limit: 50,
      offset: 0,
    });
    storage.getPrompt.mockResolvedValue(prompt);

    const response = await service.handleResourceRequest('prompt://Welcome%20Prompt@2');

    expect(response.success).toBe(true);
    const payload = response.data as { content: string; prompt: { id: string } };
    expect(payload.content).toBe('Hello world');
    expect(payload.prompt.id).toBe('prompt-1');
  });

  it('returns project-not-found error when project slug is unknown', async () => {
    storage.listProjects.mockResolvedValue({
      items: [] as Project[],
      total: 0,
      limit: 1000,
      offset: 0,
    });

    const response = await service.handleResourceRequest('doc://unknown/slug');

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('PROJECT_NOT_FOUND');
  });

  // --- Session context resolution ---
  describe('resolveSessionContext', () => {
    const makeSession = (id: string, agentId: string | null = 'agent-1') => ({
      id,
      agentId,
      tmuxSessionId: 'tmux-1',
      status: 'running' as const,
      startedAt: '2024-01-01T00:00:00Z',
      endedAt: null,
      epicId: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });

    it('resolves session context with full UUID', async () => {
      const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue([
        makeSession(sessionId),
      ]);

      storage.getAgent.mockResolvedValue({
        id: 'agent-1',
        projectId: 'project-1',
        profileId: 'profile-1',
        name: 'Test Agent',
        description: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      (storage as unknown as { getProject: jest.Mock }).getProject = jest.fn().mockResolvedValue({
        id: 'project-1',
        name: 'Test Project',
        description: null,
        rootPath: '/repo/project',
        isTemplate: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      const response = await service.resolveSessionContext(sessionId);

      expect(response.success).toBe(true);
      const data = response.data as {
        session: { id: string; agentId: string | null; status: string };
        agent: { id: string; name: string; projectId: string } | null;
        project: { id: string; name: string; rootPath: string } | null;
      };
      expect(data.session.id).toBe(sessionId);
      expect(data.agent?.name).toBe('Test Agent');
      expect(data.project?.name).toBe('Test Project');
      expect(data.project?.rootPath).toBe('/repo/project');
    });

    it('resolves session context with 8-char prefix', async () => {
      const fullId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const prefix = 'a1b2c3d4';

      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue([
        makeSession(fullId),
        makeSession('b2c3d4e5-f6a7-8901-bcde-f23456789012'), // Different prefix
      ]);

      storage.getAgent.mockResolvedValue({
        id: 'agent-1',
        projectId: 'project-1',
        profileId: 'profile-1',
        name: 'Test Agent',
        description: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      (storage as unknown as { getProject: jest.Mock }).getProject = jest.fn().mockResolvedValue({
        id: 'project-1',
        name: 'Test Project',
        description: null,
        rootPath: '/repo/project',
        isTemplate: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      const response = await service.resolveSessionContext(prefix);

      expect(response.success).toBe(true);
      const data = response.data as { session: { id: string } };
      expect(data.session.id).toBe(fullId);
    });

    it('returns SESSION_NOT_FOUND when no session matches', async () => {
      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue([
        makeSession('b2c3d4e5-f6a7-8901-bcde-f23456789012'),
      ]);

      const response = await service.resolveSessionContext('a1b2c3d4');

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns AMBIGUOUS_SESSION when multiple sessions match prefix', async () => {
      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue([
        makeSession('a1b2c3d4-1111-1111-1111-111111111111'),
        makeSession('a1b2c3d4-2222-2222-2222-222222222222'),
      ]);

      const response = await service.resolveSessionContext('a1b2c3d4');

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('AMBIGUOUS_SESSION');
      const errorData = response.error?.data as { matchingSessionIdPrefixes?: string[] };
      expect(errorData?.matchingSessionIdPrefixes).toHaveLength(2);
      expect(errorData?.matchingSessionIdPrefixes?.[0]).toMatch(/^a1b2c3d4-/);
    });

    it('returns INVALID_SESSION_ID when sessionId is too short', async () => {
      const response = await service.resolveSessionContext('a1b2c3');

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('INVALID_SESSION_ID');
    });

    it('returns INVALID_SESSION_ID when sessionId is empty', async () => {
      const response = await service.resolveSessionContext('');

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('INVALID_SESSION_ID');
    });

    it('handles session with null agentId gracefully', async () => {
      const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue([
        makeSession(sessionId, null),
      ]);

      const response = await service.resolveSessionContext(sessionId);

      expect(response.success).toBe(true);
      const data = response.data as {
        session: { id: string; agentId: string | null };
        agent: null;
        project: null;
      };
      expect(data.session.agentId).toBeNull();
      expect(data.agent).toBeNull();
      expect(data.project).toBeNull();
    });

    it('handles deleted agent gracefully', async () => {
      const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue([
        makeSession(sessionId),
      ]);

      storage.getAgent.mockRejectedValue(new NotFoundError('Agent', 'agent-1'));

      const response = await service.resolveSessionContext(sessionId);

      expect(response.success).toBe(true);
      const data = response.data as { agent: null; project: null };
      expect(data.agent).toBeNull();
      expect(data.project).toBeNull();
    });

    it('handles deleted project gracefully', async () => {
      const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue([
        makeSession(sessionId),
      ]);

      storage.getAgent.mockResolvedValue({
        id: 'agent-1',
        projectId: 'project-1',
        profileId: 'profile-1',
        name: 'Test Agent',
        description: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      (storage as unknown as { getProject: jest.Mock }).getProject = jest
        .fn()
        .mockRejectedValue(new NotFoundError('Project', 'project-1'));

      const response = await service.resolveSessionContext(sessionId);

      expect(response.success).toBe(true);
      const data = response.data as {
        agent: { id: string; name: string };
        project: null;
      };
      expect(data.agent?.name).toBe('Test Agent');
      expect(data.project).toBeNull();
    });
  });
});
