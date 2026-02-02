import { McpService } from './mcp.service';
import { DEFAULT_FEATURE_FLAGS } from '../../../common/config/feature-flags';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { NotFoundException } from '@nestjs/common';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type {
  Agent,
  AgentProfile,
  Document,
  Prompt,
  Project,
  Epic,
  EpicComment,
  Status,
} from '../../storage/models/domain.models';
import type { ThreadDto } from '../../chat/dtos/chat.dto';
import type { ChatListMembersResponse } from '../dtos/mcp.dto';

// Standard test session ID for session-based auth
const TEST_SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
// Non-existent session ID for testing SESSION_NOT_FOUND errors
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
  let messagePoolService: jest.Mocked<unknown>;
  let terminalGateway: jest.Mocked<unknown>;
  let tmuxService: jest.Mocked<unknown>;
  let epicsService: jest.Mocked<{ updateEpic: jest.Mock; createEpicForProject: jest.Mock }>;
  let settingsService: jest.Mocked<unknown>;
  let guestsService: jest.Mocked<unknown>;

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
      injectTextIntoSession: jest.fn(),
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

    tmuxService = {
      getSessionCwd: jest.fn(),
      hasSession: jest.fn().mockResolvedValue(false),
      pasteAndSubmit: jest.fn().mockResolvedValue(undefined),
      listAllSessionNames: jest.fn().mockResolvedValue(new Set<string>()),
    };

    guestsService = {
      register: jest.fn(),
    };

    service = new McpService(
      storage,
      chatService as never,
      sessionsService as never,
      messagePoolService as never,
      terminalGateway as never,
      tmuxService as never,
      epicsService as never,
      settingsService as never,
      guestsService as never,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('chat tools', () => {
    const makeThread = (overrides: Partial<ThreadDto> = {}): ThreadDto => ({
      id: '00000000-0000-0000-0000-000000000123',
      projectId: 'project-1',
      title: 'Squad Chat',
      isGroup: true,
      createdByType: 'user',
      createdByUserId: null,
      createdByAgentId: null,
      members: ['agent-1', 'agent-2'],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      ...overrides,
    });

    const makeAgent = (id: string, name: string): Agent => ({
      id,
      projectId: 'project-1',
      profileId: 'profile-1',
      name,
      description: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });

    it('returns members with online status', async () => {
      const thread = makeThread();
      (chatService as { getThread: jest.Mock }).getThread.mockResolvedValue(thread);
      storage.getAgent.mockImplementation(async (agentId: string) => {
        if (agentId === 'agent-1') {
          return makeAgent(agentId, 'Alpha Agent');
        }
        if (agentId === 'agent-2') {
          return makeAgent(agentId, 'Beta Agent');
        }
        throw new NotFoundError('Agent', agentId);
      });

      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue([
        {
          id: 'session-1',
          agentId: 'agent-1',
          projectId: 'project-1',
          status: 'running',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: null,
          epicId: null,
          profileId: 'profile-1',
          providerId: 'provider-1',
        },
      ]);

      const response = await service.handleToolCall('devchain_chat_list_members', {
        thread_id: thread.id,
      });

      expect(response.success).toBe(true);
      const data = response.data as ChatListMembersResponse;
      expect(data.total).toBe(2);
      expect(data.members).toEqual([
        expect.objectContaining({ agent_id: 'agent-1', agent_name: 'Alpha Agent', online: true }),
        expect.objectContaining({ agent_id: 'agent-2', agent_name: 'Beta Agent', online: false }),
      ]);
    });

    it('returns NOT_FOUND when thread does not exist', async () => {
      (chatService as { getThread: jest.Mock }).getThread.mockRejectedValue(
        new NotFoundException('thread not found'),
      );

      const response = await service.handleToolCall('devchain_chat_list_members', {
        thread_id: '00000000-0000-0000-0000-000000000999',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('NOT_FOUND');
    });

    it('chat_read_history excludes system messages by default', async () => {
      const thread = makeThread();
      (chatService as { getThread: jest.Mock }).getThread.mockResolvedValue(thread);
      // messages: system + user
      const items = [
        {
          id: 'm1',
          threadId: thread.id,
          authorType: 'system',
          authorAgentId: null,
          content: 'system',
          createdAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'm2',
          threadId: thread.id,
          authorType: 'user',
          authorAgentId: null,
          content: 'hi',
          createdAt: '2024-01-01T00:00:01Z',
        },
      ];
      (chatService as { listMessages: jest.Mock }).listMessages.mockResolvedValue({
        items,
        total: items.length,
        limit: 50,
        offset: 0,
      });

      const response = await service.handleToolCall('devchain_chat_read_history', {
        thread_id: thread.id,
        limit: 50,
      });

      expect(response.success).toBe(true);
      const data = response.data as { messages: Array<{ author_type: string }> };
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].author_type).toBe('user');
    });

    it('send_message creates DM to user when recipient is user', async () => {
      const project = {
        id: 'project-1',
        name: 'Demo',
        description: 'Demo project',
        rootPath: '/tmp/demo-project',
        isPrivate: false,
        ownerUserId: null,
        isTemplate: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      } as Project;
      storage.findProjectByPath.mockResolvedValue(project);
      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Alpha',
            projectId: project.id,
            profileId: 'profile-1',
            description: null,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      (chatService as { createDirectThread: jest.Mock }).createDirectThread.mockResolvedValue(
        makeThread({ isGroup: false, members: ['agent-1'] }),
      );
      (chatService as { getThread: jest.Mock }).getThread.mockResolvedValue(
        makeThread({ isGroup: false, members: ['agent-1'] }),
      );
      (chatService as { createMessage: jest.Mock }).createMessage.mockResolvedValue({
        id: 'msg-1',
        threadId: 't1',
        authorType: 'agent',
        authorAgentId: 'agent-1',
        content: 'hello',
        createdAt: '2024-01-01T00:00:02Z',
      });

      // Sender identity now comes from session context (TEST_AGENT)
      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        recipient: 'user',
        message: 'hello',
      });

      expect(result.success).toBe(true);
      expect(
        (chatService as { createDirectThread: jest.Mock }).createDirectThread,
      ).toHaveBeenCalled();
      expect((chatService as { createMessage: jest.Mock }).createMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ authorType: 'agent' }),
      );
    });

    it('send_message enqueues to pool when recipientAgentNames without threadId', async () => {
      const project = {
        id: 'project-1',
        name: 'Demo',
        description: 'Demo project',
        rootPath: '/tmp/demo-project',
        isPrivate: false,
        ownerUserId: null,
        isTemplate: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      } as Project;
      storage.findProjectByPath.mockResolvedValue(project);

      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Alpha',
            projectId: project.id,
            profileId: 'profile-1',
            description: null,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
          {
            id: 'agent-2',
            name: 'Beta',
            projectId: project.id,
            profileId: 'profile-1',
            description: null,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
        total: 2,
        limit: 1000,
        offset: 0,
      });

      storage.getAgentByName.mockImplementation(async (_projectId: string, name: string) => {
        if (name.toLowerCase() === 'beta') return makeAgent('agent-2', 'Beta');
        throw new NotFoundError('Agent', name);
      });

      storage.getAgent.mockImplementation(async (agentId: string) => {
        if (agentId === 'agent-1') return makeAgent('agent-1', 'Alpha');
        if (agentId === 'agent-2') return makeAgent('agent-2', 'Beta');
        throw new NotFoundError('Agent', agentId);
      });

      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue([
        {
          id: TEST_SESSION_ID,
          agentId: 'agent-1',
          status: 'running',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: null,
          epicId: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'session-2',
          agentId: 'agent-2',
          status: 'running',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: null,
          epicId: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ]);

      // Sender identity now comes from session context (agent-1 = Alpha)
      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        recipientAgentNames: ['Beta'],
        message: 'hello beta',
      });

      expect(result.success).toBe(true);
      const data = (
        result as {
          success: true;
          data: {
            mode: string;
            queued: unknown[];
            queuedCount: number;
            estimatedDeliveryMs: number;
          };
        }
      ).data;
      expect(data.mode).toBe('pooled');
      expect(data.queued).toEqual([{ name: 'Beta', type: 'agent', status: 'queued' }]);
      expect(data.queuedCount).toBe(1);
      expect(data.estimatedDeliveryMs).toBe(10000);
      expect(
        (chatService as { createGroupThread: jest.Mock }).createGroupThread,
      ).not.toHaveBeenCalled();
      expect((chatService as { createMessage: jest.Mock }).createMessage).not.toHaveBeenCalled();

      expect((messagePoolService as { enqueue: jest.Mock }).enqueue).toHaveBeenCalledWith(
        'agent-2',
        expect.stringContaining(
          '[This message is sent from "Alpha" agent use devchain_send_message tool for communication]',
        ),
        expect.objectContaining({
          source: 'mcp.send_message',
          submitKeys: ['Enter'],
          senderAgentId: 'agent-1',
        }),
      );
    });

    it('send_message pooled mode auto-launches offline recipient agents when NODE_ENV is not test', async () => {
      // Temporarily change NODE_ENV to enable auto-launch
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      // Clear mocks to ensure clean state
      (sessionsService as { launchSession: jest.Mock }).launchSession.mockClear();

      try {
        const project: Project = {
          id: 'project-1',
          name: 'Test Project',
          description: 'Demo project',
          rootPath: '/tmp/demo-project',
          isPrivate: false,
          ownerUserId: null,
          isTemplate: false,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        } as Project;
        storage.findProjectByPath.mockResolvedValue(project);

        storage.listAgents.mockResolvedValue({
          items: [
            {
              id: 'agent-1',
              name: 'Alpha',
              projectId: project.id,
              profileId: 'profile-1',
              description: null,
              createdAt: '2024-01-01T00:00:00Z',
              updatedAt: '2024-01-01T00:00:00Z',
            },
            {
              id: 'agent-2',
              name: 'Beta',
              projectId: project.id,
              profileId: 'profile-1',
              description: null,
              createdAt: '2024-01-01T00:00:00Z',
              updatedAt: '2024-01-01T00:00:00Z',
            },
          ],
          total: 2,
          limit: 1000,
          offset: 0,
        });

        storage.getAgentByName.mockImplementation(async (_projectId: string, name: string) => {
          if (name.toLowerCase() === 'beta') return makeAgent('agent-2', 'Beta');
          throw new NotFoundError('Agent', name);
        });

        storage.getAgent.mockImplementation(async (agentId: string) => {
          if (agentId === 'agent-1') return makeAgent('agent-1', 'Alpha');
          if (agentId === 'agent-2') return makeAgent('agent-2', 'Beta');
          throw new NotFoundError('Agent', agentId);
        });

        // Only sender (agent-1) has active session; recipient (agent-2) is offline
        (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue(
          [
            {
              id: TEST_SESSION_ID,
              agentId: 'agent-1',
              status: 'running',
              startedAt: '2024-01-01T00:00:00Z',
              endedAt: null,
              epicId: null,
              createdAt: '2024-01-01T00:00:00Z',
              updatedAt: '2024-01-01T00:00:00Z',
            },
            // agent-2 has NO active session
          ],
        );

        // Mock launchSession to return new session for agent-2
        const launchedSession = {
          id: 'launched-session-2',
          agentId: 'agent-2',
          status: 'running',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: null,
          epicId: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        };
        (sessionsService as { launchSession: jest.Mock }).launchSession.mockResolvedValue(
          launchedSession,
        );

        const result = await service.handleToolCall('devchain_send_message', {
          sessionId: TEST_SESSION_ID,
          recipientAgentNames: ['Beta'],
          message: 'hello beta',
        });

        expect(result.success).toBe(true);
        const data = (
          result as {
            success: true;
            data: {
              mode: string;
              queued: Array<{ agentName: string; status: string }>;
              queuedCount: number;
              estimatedDeliveryMs: number;
            };
          }
        ).data;

        expect(data.mode).toBe('pooled');
        // Status should be 'launched' because agent was auto-launched
        expect(data.queued).toEqual([{ name: 'Beta', type: 'agent', status: 'launched' }]);
        expect(data.queuedCount).toBe(1);

        // Verify launchSession was called for offline agent
        expect(
          (sessionsService as { launchSession: jest.Mock }).launchSession,
        ).toHaveBeenCalledWith({
          projectId: project.id,
          agentId: 'agent-2',
        });

        // Message should still be enqueued
        expect((messagePoolService as { enqueue: jest.Mock }).enqueue).toHaveBeenCalledWith(
          'agent-2',
          expect.stringContaining('hello beta'),
          expect.objectContaining({
            source: 'mcp.send_message',
          }),
        );
      } finally {
        // Restore NODE_ENV
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('send_message pooled mode does not auto-launch when NODE_ENV is test', async () => {
      // Ensure NODE_ENV is 'test' and clear mocks
      process.env.NODE_ENV = 'test';
      (sessionsService as { launchSession: jest.Mock }).launchSession.mockClear();

      const project: Project = {
        id: 'project-1',
        name: 'Test Project',
        description: 'Demo project',
        rootPath: '/tmp/demo-project',
        isPrivate: false,
        ownerUserId: null,
        isTemplate: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      } as Project;
      storage.findProjectByPath.mockResolvedValue(project);

      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Alpha',
            projectId: project.id,
            profileId: 'profile-1',
            description: null,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
          {
            id: 'agent-2',
            name: 'Beta',
            projectId: project.id,
            profileId: 'profile-1',
            description: null,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
        total: 2,
        limit: 1000,
        offset: 0,
      });

      storage.getAgentByName.mockImplementation(async (_projectId: string, name: string) => {
        if (name.toLowerCase() === 'beta') return makeAgent('agent-2', 'Beta');
        throw new NotFoundError('Agent', name);
      });

      storage.getAgent.mockImplementation(async (agentId: string) => {
        if (agentId === 'agent-1') return makeAgent('agent-1', 'Alpha');
        if (agentId === 'agent-2') return makeAgent('agent-2', 'Beta');
        throw new NotFoundError('Agent', agentId);
      });

      // Only sender has active session; recipient is offline
      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue([
        {
          id: TEST_SESSION_ID,
          agentId: 'agent-1',
          status: 'running',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: null,
          epicId: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        recipientAgentNames: ['Beta'],
        message: 'hello beta',
      });

      expect(result.success).toBe(true);
      const data = (
        result as {
          success: true;
          data: {
            mode: string;
            queued: Array<{ agentName: string; status: string }>;
            queuedCount: number;
          };
        }
      ).data;

      expect(data.mode).toBe('pooled');
      // Status should be 'queued' (not 'launched') because NODE_ENV is 'test'
      expect(data.queued).toEqual([{ name: 'Beta', type: 'agent', status: 'queued' }]);

      // launchSession should NOT be called in test environment
      expect(
        (sessionsService as { launchSession: jest.Mock }).launchSession,
      ).not.toHaveBeenCalled();
    });

    it('send_message thread mode injects devchain_chat_ack with sessionId identity', async () => {
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
          },
          {
            id: 'agent-2',
            projectId: 'project-1',
            profileId: 'profile-1',
            name: 'Beta',
            description: null,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
        total: 2,
        limit: 1000,
        offset: 0,
      });

      storage.getAgent.mockImplementation(async (agentId: string) => {
        if (agentId === 'agent-1') return makeAgent('agent-1', 'Alpha');
        if (agentId === 'agent-2') return makeAgent('agent-2', 'Beta');
        throw new NotFoundError('Agent', agentId);
      });

      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue([
        {
          id: TEST_SESSION_ID,
          agentId: 'agent-1',
          status: 'running',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: null,
          epicId: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'session-2',
          agentId: 'agent-2',
          status: 'running',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: null,
          epicId: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ]);

      (chatService as { getThread: jest.Mock }).getThread.mockResolvedValue({
        id: '00000000-0000-0000-0000-000000000001',
        title: 't',
        members: ['agent-1', 'agent-2'],
      } as unknown as ThreadDto);

      (chatService as { createMessage: jest.Mock }).createMessage.mockResolvedValue({
        id: '00000000-0000-0000-0000-000000000002',
      } as unknown as { id: string });

      // Sender identity now comes from session context (agent-1 = Alpha)
      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        threadId: '00000000-0000-0000-0000-000000000001',
        message: 'hello',
      });

      expect(result.success).toBe(true);
      expect(
        (sessionsService as { injectTextIntoSession: jest.Mock }).injectTextIntoSession,
      ).toHaveBeenCalledWith('session-2', expect.stringContaining('name: "devchain_chat_ack"'));
      expect(
        (sessionsService as { injectTextIntoSession: jest.Mock }).injectTextIntoSession,
      ).toHaveBeenCalledWith('session-2', expect.stringContaining('sessionId: "session-2"'));
    });

    it('send_message enqueues to pool for offline agent (pool handles delivery at flush)', async () => {
      const project = {
        id: 'project-1',
        name: 'Demo',
        description: 'Demo project',
        rootPath: '/tmp/demo-project',
        isPrivate: false,
        ownerUserId: null,
        isTemplate: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      } as Project;
      storage.findProjectByPath.mockResolvedValue(project);

      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Alpha',
            projectId: project.id,
            profileId: 'profile-1',
            description: null,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
          {
            id: 'agent-2',
            name: 'Beta',
            projectId: project.id,
            profileId: 'profile-1',
            description: null,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
        total: 2,
        limit: 1000,
        offset: 0,
      });

      storage.getAgentByName.mockImplementation(async (_projectId: string, name: string) => {
        if (name.toLowerCase() === 'beta') return makeAgent('agent-2', 'Beta');
        throw new NotFoundError('Agent', name);
      });
      storage.getAgent.mockImplementation(async (agentId: string) => {
        if (agentId === 'agent-1') return makeAgent('agent-1', 'Alpha');
        if (agentId === 'agent-2') return makeAgent('agent-2', 'Beta');
        throw new NotFoundError('Agent', agentId);
      });

      // Include sender's session (TEST_SESSION_ID for Alpha), but not recipient's (Beta is offline)
      (sessionsService as { listActiveSessions: jest.Mock }).listActiveSessions.mockResolvedValue([
        {
          id: TEST_SESSION_ID,
          agentId: 'agent-1',
          status: 'running',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: null,
          epicId: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ]);

      // Sender identity now comes from session context (agent-1 = Alpha)
      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        recipientAgentNames: ['Beta'],
        message: 'ping',
      });

      expect(result.success).toBe(true);
      // Pool handles delivery - no session launch from MCP service
      expect(
        (sessionsService as { launchSession: jest.Mock }).launchSession,
      ).not.toHaveBeenCalled();
      // Message is enqueued to pool
      expect((messagePoolService as { enqueue: jest.Mock }).enqueue).toHaveBeenCalledWith(
        'agent-2',
        expect.stringContaining('ping'),
        expect.objectContaining({ source: 'mcp.send_message', senderAgentId: 'agent-1' }),
      );
    });

    it('send_message returns AGENT_REQUIRED when session has no agent', async () => {
      const project = {
        id: 'project-1',
        name: 'Demo',
        description: 'Demo project',
        rootPath: '/tmp/demo-project',
        isPrivate: false,
        ownerUserId: null,
        isTemplate: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      } as Project;
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

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId,
        recipient: 'user',
        message: 'hello',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('AGENT_REQUIRED');
    });

    it('send_message delivers to guest recipient via tmux', async () => {
      const project = {
        id: 'project-1',
        name: 'Demo',
        description: 'Demo project',
        rootPath: '/tmp/demo-project',
        isPrivate: false,
        ownerUserId: null,
        isTemplate: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      } as Project;
      storage.findProjectByPath.mockResolvedValue(project);

      // Mock sender agent
      storage.getAgentByName.mockRejectedValue(new NotFoundError('Agent', 'GuestBot'));

      // Mock guest lookup
      (storage as unknown as { getGuestByName: jest.Mock }).getGuestByName.mockResolvedValue({
        id: 'guest-1',
        projectId: 'project-1',
        name: 'GuestBot',
        tmuxSessionId: 'guest-tmux-session',
        lastSeenAt: '2024-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      // Guest is online
      (tmuxService as { hasSession: jest.Mock }).hasSession.mockResolvedValue(true);

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        recipientAgentNames: ['GuestBot'],
        message: 'Hello guest!',
      });

      expect(result.success).toBe(true);
      const data = result.data as {
        mode: string;
        queued: Array<{ name: string; type: 'agent' | 'guest'; status: string; error?: string }>;
      };
      expect(data.mode).toBe('pooled');
      expect(data.queued).toHaveLength(1);
      expect(data.queued[0]).toMatchObject({
        name: 'GuestBot',
        type: 'guest',
        status: 'delivered', // Accurate status when tmux delivery succeeds
      });
      expect(data.queued[0].error).toBeUndefined();

      // Verify tmux delivery was called
      expect((tmuxService as { pasteAndSubmit: jest.Mock }).pasteAndSubmit).toHaveBeenCalledWith(
        'guest-tmux-session',
        expect.stringContaining('Hello guest!'),
      );
    });

    it('send_message returns failed status when guest is offline', async () => {
      const project = {
        id: 'project-1',
        name: 'Demo',
        description: 'Demo project',
        rootPath: '/tmp/demo-project',
        isPrivate: false,
        ownerUserId: null,
        isTemplate: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      } as Project;
      storage.findProjectByPath.mockResolvedValue(project);

      // Mock sender agent
      storage.getAgentByName.mockRejectedValue(new NotFoundError('Agent', 'GuestBot'));

      // Mock guest lookup
      (storage as unknown as { getGuestByName: jest.Mock }).getGuestByName.mockResolvedValue({
        id: 'guest-1',
        projectId: 'project-1',
        name: 'GuestBot',
        tmuxSessionId: 'guest-tmux-session',
        lastSeenAt: '2024-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      // Guest is offline
      (tmuxService as { hasSession: jest.Mock }).hasSession.mockResolvedValue(false);

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        recipientAgentNames: ['GuestBot'],
        message: 'Hello guest!',
      });

      expect(result.success).toBe(true);
      const data = result.data as {
        mode: string;
        queued: Array<{ name: string; type: 'agent' | 'guest'; status: string; error?: string }>;
      };
      expect(data.mode).toBe('pooled');
      expect(data.queued).toHaveLength(1);
      expect(data.queued[0]).toMatchObject({
        name: 'GuestBot',
        type: 'guest',
        status: 'failed',
        error: 'Recipient offline',
      });

      // Verify tmux delivery was NOT called (guest offline)
      expect((tmuxService as { pasteAndSubmit: jest.Mock }).pasteAndSubmit).not.toHaveBeenCalled();
    });

    it('send_message returns failed status when guest tmux delivery fails', async () => {
      const project = {
        id: 'project-1',
        name: 'Demo',
        description: 'Demo project',
        rootPath: '/tmp/demo-project',
        isPrivate: false,
        ownerUserId: null,
        isTemplate: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      } as Project;
      storage.findProjectByPath.mockResolvedValue(project);

      // Mock sender agent
      storage.getAgentByName.mockRejectedValue(new NotFoundError('Agent', 'GuestBot'));

      // Mock guest lookup
      (storage as unknown as { getGuestByName: jest.Mock }).getGuestByName.mockResolvedValue({
        id: 'guest-1',
        projectId: 'project-1',
        name: 'GuestBot',
        tmuxSessionId: 'guest-tmux-session',
        lastSeenAt: '2024-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      // Guest is online
      (tmuxService as { hasSession: jest.Mock }).hasSession.mockResolvedValue(true);
      // But tmux delivery fails
      (tmuxService as { pasteAndSubmit: jest.Mock }).pasteAndSubmit.mockRejectedValue(
        new Error('Tmux pane not responding'),
      );

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        recipientAgentNames: ['GuestBot'],
        message: 'Hello guest!',
      });

      expect(result.success).toBe(true);
      const data = result.data as {
        mode: string;
        queued: Array<{ name: string; type: 'agent' | 'guest'; status: string; error?: string }>;
      };
      expect(data.mode).toBe('pooled');
      expect(data.queued).toHaveLength(1);
      expect(data.queued[0]).toMatchObject({
        name: 'GuestBot',
        type: 'guest',
        status: 'failed',
        error: 'Tmux pane not responding',
      });
    });

    it('send_message returns RECIPIENT_NOT_FOUND with available names', async () => {
      const project = {
        id: 'project-1',
        name: 'Demo',
        description: 'Demo project',
        rootPath: '/tmp/demo-project',
        isPrivate: false,
        ownerUserId: null,
        isTemplate: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      } as Project;
      storage.findProjectByPath.mockResolvedValue(project);

      // Agent not found
      storage.getAgentByName.mockRejectedValue(new NotFoundError('Agent', 'Unknown'));
      // Guest not found
      (storage as unknown as { getGuestByName: jest.Mock }).getGuestByName.mockResolvedValue(null);

      // Available agents and guests for error message
      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Alpha',
            projectId: 'project-1',
            profileId: 'profile-1',
            description: null,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
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

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        recipientAgentNames: ['Unknown'],
        message: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RECIPIENT_NOT_FOUND');
      expect(result.error?.message).toContain('Alpha');
      expect(result.error?.message).toContain('GuestBot (guest)');
    });

    it('propagates storage errors from agent lookup (not masked as NotFound)', async () => {
      const project = {
        id: 'project-1',
        name: 'Demo',
        description: null,
        rootPath: '/tmp/demo',
        isTemplate: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      storage.findProjectByPath.mockResolvedValue(project);
      // Simulate a real storage error (not NotFoundError)
      storage.getAgentByName.mockRejectedValue(new Error('Database connection failed'));

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        recipientAgentNames: ['SomeAgent'],
        message: 'Hello',
      });

      // The storage error should propagate, not be masked
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SEND_MESSAGE_FAILED');
      expect(result.error?.message).toContain('Database connection failed');
    });

    it('falls back to guest lookup only when agent NotFoundError occurs', async () => {
      const project = {
        id: 'project-1',
        name: 'Demo',
        description: null,
        rootPath: '/tmp/demo',
        isTemplate: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      storage.findProjectByPath.mockResolvedValue(project);
      // Agent lookup throws NotFoundError - should proceed to guest lookup
      storage.getAgentByName.mockRejectedValue(new NotFoundError('Agent', 'GuestBot'));
      // Guest lookup succeeds
      (storage as unknown as { getGuestByName: jest.Mock }).getGuestByName.mockResolvedValue({
        id: 'guest-1',
        projectId: 'project-1',
        name: 'GuestBot',
        tmuxSessionId: 'guest-tmux',
        lastSeenAt: '2024-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      (tmuxService as { hasSession: jest.Mock }).hasSession.mockResolvedValue(true);

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        recipientAgentNames: ['GuestBot'],
        message: 'Hello guest!',
      });

      expect(result.success).toBe(true);
      // Verify guest lookup was called after agent NotFoundError
      expect(storage.getAgentByName).toHaveBeenCalledWith('project-1', 'GuestBot');
      expect(
        (storage as unknown as { getGuestByName: jest.Mock }).getGuestByName,
      ).toHaveBeenCalledWith('project-1', 'GuestBot');
    });
  });

  it('inlines linked documents when includeLinks is inline', async () => {
    const rootDocument: Document = {
      id: '00000000-0000-0000-0000-000000000001',
      projectId: 'project-1',
      title: 'Root Doc',
      slug: 'root',
      contentMd: 'Hello [[child]] world',
      archived: false,
      version: 1,
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    };

    const childDocument: Document = {
      id: '00000000-0000-0000-0000-000000000002',
      projectId: 'project-1',
      title: 'Child Doc',
      slug: 'child',
      contentMd: 'Child content',
      archived: false,
      version: 1,
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    };

    storage.getDocument.mockImplementation(async (identifier) => {
      if ('id' in identifier && identifier.id === rootDocument.id) {
        return rootDocument;
      }
      if ('slug' in identifier && identifier.slug === 'child') {
        return childDocument;
      }
      throw new Error('not found');
    });

    const response = await service.handleToolCall('devchain.get_document', {
      id: rootDocument.id,
      includeLinks: 'inline',
    });

    expect(response.success).toBe(true);
    const payload = response.data as {
      document: { id: string };
      links: Array<{ slug: string; exists: boolean }>;
      resolved?: { contentMd: string };
    };

    expect(payload.document.id).toBe(rootDocument.id);
    expect(payload.links).toHaveLength(1);
    expect(payload.links[0]).toMatchObject({ slug: 'child', exists: true });
    expect(payload.resolved?.contentMd).toContain('Child content');
  });

  it('lists documents with filters', async () => {
    const listResult = {
      items: [
        {
          id: '00000000-0000-0000-0000-000000000010',
          projectId: 'project-1',
          title: 'Doc One',
          slug: 'doc-one',
          contentMd: 'Content',
          archived: false,
          version: 1,
          tags: ['ref'],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
    };

    storage.listDocuments.mockResolvedValue(
      listResult as unknown as Awaited<ReturnType<typeof storage.listDocuments>>,
    );
    storage.findProjectByPath.mockResolvedValue({
      id: 'project-1',
      name: 'Test Project',
      description: null,
      rootPath: '/repo/project',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    } as Project);

    const response = await service.handleToolCall('devchain.list_documents', {
      sessionId: TEST_SESSION_ID,
      q: 'Doc',
      tags: ['ref'],
      limit: 10,
      offset: 0,
    });

    expect(response.success).toBe(true);
    const data = response.data as {
      documents: Array<{ id: string; title: string }>;
      total: number;
      limit: number;
      offset: number;
    };
    expect(data.documents).toHaveLength(1);
    expect(data.documents[0].title).toBe('Doc One');
    expect(data.total).toBe(1);
  });

  it('rejects list documents when sessionId is too short', async () => {
    const response = await service.handleToolCall('devchain.list_documents', {
      sessionId: 'short',
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('VALIDATION_ERROR');
  });

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

  it('devchain_list_prompts requires valid sessionId and resolves project', async () => {
    storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 0, offset: 0 });

    const ok = await service.handleToolCall('devchain_list_prompts', {
      sessionId: TEST_SESSION_ID,
    });
    expect(ok.success).toBe(true);
    expect(storage.listPrompts).toHaveBeenCalledWith({ projectId: 'project-1', q: undefined });

    // Short sessionId fails validation
    const bad = await service.handleToolCall('devchain_list_prompts', { sessionId: 'short' });
    expect(bad.success).toBe(false);
    expect(bad.error?.code).toBe('VALIDATION_ERROR');
  });

  it('devchain_get_prompt by name requires sessionId to resolve project', async () => {
    storage.findProjectByPath.mockResolvedValue({
      id: 'project-1',
      name: 'Demo',
      description: null,
      rootPath: '/abs/demo',
      isTemplate: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    } as Project);
    const prompt: Prompt = {
      id: 'p1',
      projectId: 'project-1',
      title: 'Welcome',
      content: 'Hello',
      version: 1,
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };
    const promptSummary = {
      id: prompt.id,
      projectId: prompt.projectId,
      title: prompt.title,
      contentPreview: prompt.content,
      version: prompt.version,
      tags: prompt.tags,
      createdAt: prompt.createdAt,
      updatedAt: prompt.updatedAt,
    };
    storage.listPrompts.mockResolvedValue({
      items: [promptSummary],
      total: 1,
      limit: 1,
      offset: 0,
    });
    storage.getPrompt.mockResolvedValue(prompt);

    const byName = await service.handleToolCall('devchain_get_prompt', {
      name: 'Welcome',
      sessionId: TEST_SESSION_ID,
    });
    expect(byName.success).toBe(true);
    expect((byName.data as { prompt: { id: string } }).prompt.id).toBe('p1');

    // sessionId is now required at DTO level when querying by name
    const missing = await service.handleToolCall('devchain_get_prompt', { name: 'Welcome' });
    expect(missing.success).toBe(false);
    expect(missing.error?.code).toBe('VALIDATION_ERROR');
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
    (tmuxService as { listAllSessionNames: jest.Mock }).listAllSessionNames.mockResolvedValue(
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
      (tmuxService as { listAllSessionNames: jest.Mock }).listAllSessionNames,
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
      (tmuxService as { hasSession: jest.Mock }).hasSession.mockResolvedValue(false);
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
          statusId: string;
          title: string;
          tags: string[];
          subEpics?: Array<{ id: string; title: string; statusId: string }>;
        }>;
        total: number;
      };
      expect(payload.epics[0].id).toBe(epic.id);
      expect(payload.epics[0].statusId).toBe(epic.statusId);
      expect(payload.epics[0].subEpics).toHaveLength(1);
      expect(payload.epics[0].subEpics?.[0].id).toBe(childEpic.id);
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

      const payload = response.data as { epic: { id: string; title: string } };
      expect(payload.epic.id).toBe(epic.id);
      expect(payload.epic.title).toBe(epic.title);
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
        epic: { id: string; tags: string[] };
        comments: Array<{ id: string }>;
        subEpics: Array<{ id: string }>;
        parent?: { id: string };
      };
      expect(payload.epic.id).toBe(epic.id);
      expect(payload.comments[0].id).toBe(comment.id);
      expect(payload.subEpics[0].id).toBe(childEpic.id);
      expect(payload.parent?.id).toBe(parentEpic.id);
      // tags should always be present
      expect(payload.epic.tags).toEqual([]);
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
      storage.createEpicComment.mockResolvedValue(comment);

      // Author identity now comes from session context (TEST_AGENT.name)
      const response = await service.handleToolCall('devchain_add_epic_comment', {
        sessionId: TEST_SESSION_ID,
        epicId: epic.id,
        content: 'Ship it',
      });

      expect(response.success).toBe(true);
      expect(storage.createEpicComment).toHaveBeenCalledWith({
        epicId: epic.id,
        authorName: 'Test Agent', // Derived from session's agent
        content: 'Ship it',
      });

      const payload = response.data as { comment: { id: string; content: string } };
      expect(payload.comment.id).toBe(comment.id);
      expect(payload.comment.content).toBe('Ship it');
    });

    it('returns epic-not-found when adding a comment to unknown epic', async () => {
      const project = makeProject();
      storage.findProjectByPath.mockResolvedValue(project);
      storage.getEpic.mockRejectedValue(
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

    it('returns epic-not-found when commenting on epic from another project', async () => {
      const project = makeProject();
      const epic = makeEpic({ projectId: 'different-project' });

      storage.findProjectByPath.mockResolvedValue(project);
      storage.getEpic.mockResolvedValue(epic);

      const response = await service.handleToolCall('devchain_add_epic_comment', {
        sessionId: TEST_SESSION_ID,
        epicId: epic.id,
        content: 'Looks good',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('EPIC_NOT_FOUND');
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
        epicsService.updateEpic = jest.fn();
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
        epicsService.updateEpic.mockResolvedValue(updatedEpic);

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          title: 'New Title',
          description: 'New description',
        });

        expect(response.success).toBe(true);
        expect(epicsService.updateEpic).toHaveBeenCalledWith(
          epic.id,
          expect.objectContaining({
            title: 'New Title',
            description: 'New description',
          }),
          1,
          expect.any(Object),
        );

        const payload = response.data as { epic: { id: string; title: string } };
        expect(payload.epic.title).toBe('New Title');
      });

      it('updates status by name (case-insensitive)', async () => {
        const project = makeProject();
        const status = makeStatus({ label: 'In Progress' });
        const epic = makeEpic({ version: 1 });
        const updatedEpic = makeEpic({ statusId: status.id, version: 2 });

        storage.findProjectByPath.mockResolvedValue(project);
        storage.getEpic.mockResolvedValue(epic);
        storage.findStatusByName.mockResolvedValue(status);
        epicsService.updateEpic.mockResolvedValue(updatedEpic);

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          statusName: 'in progress',
        });

        expect(response.success).toBe(true);
        expect(storage.findStatusByName).toHaveBeenCalledWith(project.id, 'in progress');
        expect(epicsService.updateEpic).toHaveBeenCalledWith(
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
        epicsService.updateEpic.mockResolvedValue(updatedEpic);

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          assignment: { agentName: 'worker' },
        });

        expect(response.success).toBe(true);
        expect(storage.getAgentByName).toHaveBeenCalledWith(project.id, 'worker');
        expect(epicsService.updateEpic).toHaveBeenCalledWith(
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
        epicsService.updateEpic.mockResolvedValue(updatedEpic);

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          assignment: { clear: true },
        });

        expect(response.success).toBe(true);
        expect(epicsService.updateEpic).toHaveBeenCalledWith(
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
        epicsService.updateEpic.mockResolvedValue(updatedEpic);

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          setTags: ['new', 'fresh'],
        });

        expect(response.success).toBe(true);
        expect(epicsService.updateEpic).toHaveBeenCalledWith(
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
        epicsService.updateEpic.mockResolvedValue(updatedEpic);

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          addTags: ['reviewed', 'ready'],
          removeTags: ['priority:high'],
        });

        expect(response.success).toBe(true);
        expect(epicsService.updateEpic).toHaveBeenCalledWith(
          epic.id,
          expect.objectContaining({
            tags: expect.arrayContaining(['feature', 'reviewed', 'ready']),
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
        epicsService.updateEpic.mockResolvedValue(updatedEpic);

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          parentId: parentEpic.id,
        });

        expect(response.success).toBe(true);
        expect(epicsService.updateEpic).toHaveBeenCalledWith(
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
        epicsService.updateEpic.mockResolvedValue(updatedEpic);

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          clearParent: true,
        });

        expect(response.success).toBe(true);
        expect(epicsService.updateEpic).toHaveBeenCalledWith(
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

        const response = await service.handleToolCall('devchain_update_epic', {
          sessionId: TEST_SESSION_ID,
          id: epic.id,
          version: 1,
          parentId: parent.id,
        });

        expect(response.success).toBe(false);
        expect(response.error?.code).toBe('HIERARCHY_CONFLICT');
        expect(response.error?.message).toContain('one level');
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
        epicsService.updateEpic.mockRejectedValue(
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
    });
  });

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
        name: string;
        projectId: string;
        projectName: string;
        isSandbox: boolean;
        registeredAt: string;
      };
      expect(data.guestId).toBe('guest-1');
      expect(data.name).toBe('MyGuest');
      expect(data.projectId).toBe('project-1');
      expect(data.projectName).toBe('Test Project');
      expect(data.isSandbox).toBe(false);
      expect(data.registeredAt).toBeDefined();

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
        messagePoolService as never,
        terminalGateway as never,
        tmuxService as never,
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
      (tmuxService as { hasSession: jest.Mock }).hasSession.mockResolvedValue(true);
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
