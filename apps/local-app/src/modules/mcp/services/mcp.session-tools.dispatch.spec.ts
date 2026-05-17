import { McpService } from './mcp.service';
import { DEFAULT_FEATURE_FLAGS } from '../../../common/config/feature-flags';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { Agent, Project } from '../../storage/models/domain.models';

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
  let terminalGateway: jest.Mocked<unknown>;
  let terminalIO: jest.Mocked<unknown>;
  let epicsService: jest.Mocked<{ updateEpic: jest.Mock; createEpicForProject: jest.Mock }>;
  let settingsService: jest.Mocked<unknown>;
  let guestsService: jest.Mocked<unknown>;
  let skillsService: jest.Mocked<unknown>;
  let reviewsService: jest.Mocked<unknown>;
  let teamsService: jest.Mocked<unknown>;
  let agentMessageDelivery: jest.Mocked<unknown>;

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

    terminalIO = {
      deliver: jest.fn().mockResolvedValue({ confirmed: true, nonce: 'abc', retryCount: 0 }),
      deliverImmediate: jest
        .fn()
        .mockResolvedValue({ confirmed: true, nonce: 'abc', retryCount: 0 }),
      sendControl: jest.fn().mockResolvedValue(undefined),
      sessionExists: jest.fn().mockResolvedValue(false),
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

    agentMessageDelivery = {
      deliver: jest.fn().mockResolvedValue({
        status: 'queued',
        results: [{ agentId: TEST_AGENT.id, status: 'queued' }],
      }),
      ack: jest.fn().mockResolvedValue(undefined),
      formatMessage: jest
        .fn()
        .mockImplementation((msg: { body: string }) => `[formatted] ${msg.body}`),
      deliverToGuest: jest.fn().mockResolvedValue({ delivered: true }),
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
      agentMessageDelivery as never,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // TODO(P3.2): migrate handler-internal session tests to session-tools handler spec
  describe('devchain_list_sessions', () => {
    it('returns active sessions with resolved names', async () => {
      const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue([
        {
          id: sessionId,
          agentId: 'agent-1',
          tmuxSessionId: 'tmux-1',
          status: 'running',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: null,
          epicId: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
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

      const response = await service.handleToolCall('devchain_list_sessions', {});

      expect(response.success).toBe(true);
      const data = response.data as {
        sessions: Array<{
          sessionIdShort: string;
          agentName: string;
          projectName: string;
          status: string;
          startedAt: string;
        }>;
      };
      expect(data.sessions).toHaveLength(1);
      expect(data.sessions[0]).toEqual({
        sessionIdShort: 'a1b2c3d4', // Only short ID exposed for security
        agentName: 'Test Agent',
        projectName: 'Test Project',
        status: 'running',
        startedAt: '2024-01-01T00:00:00Z',
      });
      // Verify full sessionId is NOT exposed
      expect(data.sessions[0]).not.toHaveProperty('sessionId');
    });

    it('returns empty sessions array when no active sessions', async () => {
      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue(
        [],
      );

      const response = await service.handleToolCall('devchain_list_sessions', {});

      expect(response.success).toBe(true);
      const data = response.data as { sessions: unknown[] };
      expect(data.sessions).toHaveLength(0);
    });

    it('handles agent resolution failure gracefully', async () => {
      const sessionId = 'b2c3d4e5-f6a7-8901-bcde-f23456789012';
      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue([
        {
          id: sessionId,
          agentId: 'agent-1',
          tmuxSessionId: 'tmux-1',
          status: 'running',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: null,
          epicId: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ]);

      storage.getAgent.mockRejectedValue(new NotFoundError('Agent', 'agent-1'));

      const response = await service.handleToolCall('devchain_list_sessions', {});

      expect(response.success).toBe(true);
      const data = response.data as {
        sessions: Array<{ agentName: string; projectName: string }>;
      };
      // When agent resolution fails, both names become empty/unknown
      expect(data.sessions[0].agentName).toBe('Unknown');
      expect(data.sessions[0].projectName).toBe('');
    });

    it('handles project resolution failure gracefully', async () => {
      const sessionId = 'c3d4e5f6-a7b8-9012-cdef-345678901234';
      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue([
        {
          id: sessionId,
          agentId: 'agent-1',
          tmuxSessionId: 'tmux-1',
          status: 'running',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: null,
          epicId: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
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

      const response = await service.handleToolCall('devchain_list_sessions', {});

      expect(response.success).toBe(true);
      const data = response.data as {
        sessions: Array<{ agentName: string; projectName: string }>;
      };
      expect(data.sessions[0].agentName).toBe('Test Agent');
      expect(data.sessions[0].projectName).toBe('Unknown');
    });

    it('rejects unknown params with VALIDATION_ERROR and unrecognized_keys', async () => {
      const response = await service.handleToolCall('devchain_list_sessions', {
        unknownParam: 'value',
        anotherExtra: 123,
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('VALIDATION_ERROR');
      const data = response.error?.data as { issues: Array<{ code: string; keys?: string[] }> };
      const unrecognizedIssue = data.issues.find((issue) => issue.code === 'unrecognized_keys');
      expect(unrecognizedIssue).toBeDefined();
      expect(unrecognizedIssue?.keys).toContain('unknownParam');
      expect(unrecognizedIssue?.keys).toContain('anotherExtra');
    });

    it('handles undefined params same as empty object', async () => {
      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue(
        [],
      );

      const response = await service.handleToolCall('devchain_list_sessions', undefined);

      expect(response.success).toBe(true);
      const data = response.data as { sessions: unknown[] };
      expect(data.sessions).toHaveLength(0);
    });

    it('handles null params same as empty object', async () => {
      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue(
        [],
      );

      const response = await service.handleToolCall('devchain_list_sessions', null);

      expect(response.success).toBe(true);
      const data = response.data as { sessions: unknown[] };
      expect(data.sessions).toHaveLength(0);
    });
  });

  // TODO(P3.2): migrate handler-internal guest tests to session-tools handler spec
  describe('devchain_register_guest', () => {
    const TEST_TMUX_SESSION_ID = 'my-tmux-session';
    const TEST_REGISTER_RESULT = {
      guestId: 'guest-1',
      projectId: 'project-1',
      projectName: 'Test Project',
      isSandbox: false,
    };

    it('registers a guest successfully', async () => {
      (guestsService as { register: jest.Mock }).register.mockResolvedValue(TEST_REGISTER_RESULT);

      const response = await service.handleToolCall('devchain_register_guest', {
        tmuxSessionId: TEST_TMUX_SESSION_ID,
        name: 'MyGuest',
      });

      expect(response.success).toBe(true);
      const data = response.data as {
        guestId: string;
      };
      expect(data.guestId).toBe('guest-1');

      // Verify description is passed (undefined when not provided)
      expect((guestsService as { register: jest.Mock }).register).toHaveBeenCalledWith({
        name: 'MyGuest',
        tmuxSessionId: TEST_TMUX_SESSION_ID,
        description: undefined,
      });
    });

    it('passes description to guestsService.register()', async () => {
      (guestsService as { register: jest.Mock }).register.mockResolvedValue(TEST_REGISTER_RESULT);

      const response = await service.handleToolCall('devchain_register_guest', {
        tmuxSessionId: TEST_TMUX_SESSION_ID,
        name: 'MyGuest',
        description: 'A helpful bot for testing',
      });

      expect(response.success).toBe(true);

      // Verify description is forwarded to register()
      expect((guestsService as { register: jest.Mock }).register).toHaveBeenCalledWith({
        name: 'MyGuest',
        tmuxSessionId: TEST_TMUX_SESSION_ID,
        description: 'A helpful bot for testing',
      });
    });

    it('returns error when guests service is unavailable', async () => {
      // Create service without guestsService
      const serviceNoGuests = new McpService(
        storage,
        chatService as never,
        sessionsService as never,
        terminalGateway as never,
        epicsService as never,
        settingsService as never,
        undefined, // No guestsService
      );

      const response = await serviceNoGuests.handleToolCall('devchain_register_guest', {
        tmuxSessionId: TEST_TMUX_SESSION_ID,
        name: 'MyGuest',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('returns error when guest registration fails with ValidationError', async () => {
      (guestsService as { register: jest.Mock }).register.mockRejectedValue(
        new ValidationError('Tmux session not found'),
      );

      const response = await service.handleToolCall('devchain_register_guest', {
        tmuxSessionId: TEST_TMUX_SESSION_ID,
        name: 'MyGuest',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('VALIDATION_ERROR');
      expect(response.error?.message).toBe('Tmux session not found');
    });

    it('returns internal error for unexpected failures', async () => {
      (guestsService as { register: jest.Mock }).register.mockRejectedValue(
        new Error('Unexpected error'),
      );

      const response = await service.handleToolCall('devchain_register_guest', {
        tmuxSessionId: TEST_TMUX_SESSION_ID,
        name: 'MyGuest',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('INTERNAL_ERROR');
      expect(response.error?.message).toBe('Unexpected error');
    });
  });

  describe('guest restrictions - block thread-backed operations', () => {
    const GUEST_ID = 'guest-00000000-0000-0000-0000-000000000001';
    const GUEST_PROJECT = {
      id: 'project-1',
      name: 'GuestProject',
      rootPath: '/tmp/guest-project',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };
    const GUEST_RECORD = {
      id: GUEST_ID,
      projectId: 'project-1',
      name: 'GuestBot',
      tmuxSessionId: 'guest-tmux-session',
      lastSeenAt: '2024-01-01T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    beforeEach(() => {
      // Mock guest context resolution
      (storage as unknown as { getGuest: jest.Mock }).getGuest = jest
        .fn()
        .mockResolvedValue(GUEST_RECORD);
      // Use getGuestsByIdPrefix for prefix-based lookup (optimized query)
      (storage as unknown as { getGuestsByIdPrefix: jest.Mock }).getGuestsByIdPrefix = jest
        .fn()
        .mockResolvedValue([GUEST_RECORD]);
      (storage as unknown as { getProject: jest.Mock }).getProject.mockResolvedValue(GUEST_PROJECT);
      (terminalIO as { sessionExists: jest.Mock }).sessionExists.mockResolvedValue(true);
    });

    it('blocks guest from using threadId in send_message', async () => {
      const response = await service.handleToolCall('devchain_send_message', {
        sessionId: GUEST_ID,
        threadId: '00000000-0000-0000-0000-000000000001',
        message: 'Hello',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('GUEST_THREAD_NOT_ALLOWED');
      expect(response.error?.message).toContain('Guests cannot use threaded messaging');
      expect(response.error?.message).toContain('recipientAgentNames');
    });

    it('blocks guest from sending DM to user (recipient=user)', async () => {
      const response = await service.handleToolCall('devchain_send_message', {
        sessionId: GUEST_ID,
        recipient: 'user',
        message: 'Hello user',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('GUEST_USER_DM_NOT_ALLOWED');
      expect(response.error?.message).toContain('Guests cannot send direct messages to users');
    });

    it('self-team fallback: guest sender returns NO_SELF_TEAM', async () => {
      const response = await service.handleToolCall('devchain_send_message', {
        sessionId: GUEST_ID,
        message: 'Hello team',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('NO_SELF_TEAM');
    });

    it('blocks guest from using devchain_activity_start', async () => {
      const response = await service.handleToolCall('devchain_activity_start', {
        sessionId: GUEST_ID,
        title: 'Working on task',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('GUEST_ACTIVITY_NOT_ALLOWED');
      expect(response.error?.message).toContain('Guests cannot use activity tools');
    });

    it('blocks guest from using devchain_activity_finish', async () => {
      // Use valid params for ActivityFinishParamsSchema (sessionId, threadId?, message?, status?)
      const response = await service.handleToolCall('devchain_activity_finish', {
        sessionId: GUEST_ID,
        message: 'Done',
        status: 'success',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('GUEST_ACTIVITY_NOT_ALLOWED');
      expect(response.error?.message).toContain('Guests cannot use activity tools');
    });

    it('allows guest to use pooled messaging with recipientAgentNames', async () => {
      // Mock agent lookup for recipient
      storage.getAgentByName.mockResolvedValue(TEST_AGENT);

      const response = await service.handleToolCall('devchain_send_message', {
        sessionId: GUEST_ID,
        recipientAgentNames: [TEST_AGENT.name],
        message: 'Hello from guest',
      });

      expect(response.success).toBe(true);
      const data = response.data as { mode: string };
      expect(data.mode).toBe('pooled');
    });
  });
});
