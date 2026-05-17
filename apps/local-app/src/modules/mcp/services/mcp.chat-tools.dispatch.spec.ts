import { McpService } from './mcp.service';
import { DEFAULT_FEATURE_FLAGS } from '../../../common/config/feature-flags';
import { NotFoundError } from '../../../common/errors/error-types';
import { NotFoundException } from '@nestjs/common';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { Agent, Project } from '../../storage/models/domain.models';
import type { ThreadDto } from '../../chat/dtos/chat.dto';
import type { ChatListMembersResponse } from '../dtos/mcp.dto';

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
  let agentMessageDelivery: jest.Mocked<unknown>;
  let terminalIO: jest.Mocked<unknown>;
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
      getAgentPresence: jest.fn().mockResolvedValue(new Map()),
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

  // TODO(P3.2): migrate handler-internal tests to chat-tools handler spec
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

      // Override deliver mock to return result for agent-2
      (agentMessageDelivery as { deliver: jest.Mock }).deliver.mockResolvedValue({
        status: 'queued',
        results: [{ agentId: 'agent-2', status: 'queued' }],
      });

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

      expect((agentMessageDelivery as { deliver: jest.Mock }).deliver).toHaveBeenCalledWith(
        ['agent-2'],
        expect.objectContaining({
          kind: 'mcp.direct',
          body: 'hello beta',
          source: 'mcp.send_message',
          senderName: expect.any(String),
          senderAgentId: 'agent-1',
        }),
        expect.objectContaining({ submitKeys: ['Enter'] }),
      );
    });

    it('send_message routes teamName to the team lead when present', async () => {
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

      (teamsService as { findTeamByExactName: jest.Mock }).findTeamByExactName.mockResolvedValue({
        id: 'team-1',
        projectId: project.id,
        name: 'Platform',
        description: null,
        teamLeadAgentId: 'agent-2',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      (teamsService as { getTeam: jest.Mock }).getTeam.mockResolvedValue({
        id: 'team-1',
        projectId: project.id,
        name: 'Platform',
        description: null,
        teamLeadAgentId: 'agent-2',
        members: [
          { teamId: 'team-1', agentId: 'agent-1', createdAt: '2024-01-01T00:00:00Z' },
          { teamId: 'team-1', agentId: 'agent-2', createdAt: '2024-01-01T00:00:00Z' },
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
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

      // Override deliver mock to return result for agent-2
      (agentMessageDelivery as { deliver: jest.Mock }).deliver.mockResolvedValue({
        status: 'queued',
        results: [{ agentId: 'agent-2', status: 'queued' }],
      });

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        teamName: 'platform',
        message: 'hello team',
      });

      expect(result.success).toBe(true);
      const data = (
        result as {
          success: true;
          data: {
            mode: string;
            queued: unknown[];
            queuedCount: number;
            teamDelivery?: {
              teamName: string;
              recipientCount: number;
              routedToLead: boolean;
              summary: string;
            };
          };
        }
      ).data;
      expect(data.mode).toBe('pooled');
      expect(data.queued).toEqual([{ name: 'Beta', type: 'agent', status: 'queued' }]);
      expect(data.queuedCount).toBe(1);
      expect(data.teamDelivery).toEqual({
        teamName: 'Platform',
        recipientCount: 1,
        routedToLead: true,
        summary: 'Delivered to 1 agent (team lead)',
      });
      expect((agentMessageDelivery as { deliver: jest.Mock }).deliver).toHaveBeenCalledWith(
        ['agent-2'],
        expect.objectContaining({
          source: 'mcp.send_message',
          senderAgentId: 'agent-1',
        }),
        expect.objectContaining({ submitKeys: ['Enter'] }),
      );
    });

    it('send_message routes teamName to the other members when the sender is the team lead', async () => {
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

      (teamsService as { findTeamByExactName: jest.Mock }).findTeamByExactName.mockResolvedValue({
        id: 'team-1',
        projectId: project.id,
        name: 'Platform',
        description: null,
        teamLeadAgentId: 'agent-1',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      (teamsService as { getTeam: jest.Mock }).getTeam.mockResolvedValue({
        id: 'team-1',
        projectId: project.id,
        name: 'Platform',
        description: null,
        teamLeadAgentId: 'agent-1',
        members: [
          { teamId: 'team-1', agentId: 'agent-1', createdAt: '2024-01-01T00:00:00Z' },
          { teamId: 'team-1', agentId: 'agent-2', createdAt: '2024-01-01T00:00:00Z' },
          { teamId: 'team-1', agentId: 'agent-3', createdAt: '2024-01-01T00:00:00Z' },
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      storage.getAgent.mockImplementation(async (agentId: string) => {
        if (agentId === 'agent-1') return makeAgent('agent-1', 'Alpha');
        if (agentId === 'agent-2') return makeAgent('agent-2', 'Beta');
        if (agentId === 'agent-3') return makeAgent('agent-3', 'Gamma');
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
        {
          id: 'session-3',
          agentId: 'agent-3',
          status: 'running',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: null,
          epicId: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ]);

      // Override deliver mock to return results for agent-2 and agent-3
      (agentMessageDelivery as { deliver: jest.Mock }).deliver.mockResolvedValue({
        status: 'queued',
        results: [
          { agentId: 'agent-2', status: 'queued' },
          { agentId: 'agent-3', status: 'queued' },
        ],
      });

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        teamName: 'Platform',
        message: 'hello team',
      });

      expect(result.success).toBe(true);
      const data = (
        result as {
          success: true;
          data: {
            queued: Array<{ name: string }>;
            queuedCount: number;
            teamDelivery?: {
              teamName: string;
              recipientCount: number;
              routedToLead: boolean;
              summary: string;
            };
          };
        }
      ).data;
      expect(data.queued).toEqual([
        { name: 'Beta', type: 'agent', status: 'queued' },
        { name: 'Gamma', type: 'agent', status: 'queued' },
      ]);
      expect(data.queuedCount).toBe(2);
      expect(data.teamDelivery).toEqual({
        teamName: 'Platform',
        recipientCount: 2,
        routedToLead: false,
        summary: 'Delivered to 2 agent(s) (team lead excluded)',
      });
    });

    it('send_message routes teamName to all members when no lead is assigned', async () => {
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

      (teamsService as { findTeamByExactName: jest.Mock }).findTeamByExactName.mockResolvedValue({
        id: 'team-1',
        projectId: project.id,
        name: 'Platform',
        description: null,
        teamLeadAgentId: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      (teamsService as { getTeam: jest.Mock }).getTeam.mockResolvedValue({
        id: 'team-1',
        projectId: project.id,
        name: 'Platform',
        description: null,
        teamLeadAgentId: null,
        members: [
          { teamId: 'team-1', agentId: 'agent-1', createdAt: '2024-01-01T00:00:00Z' },
          { teamId: 'team-1', agentId: 'agent-2', createdAt: '2024-01-01T00:00:00Z' },
          { teamId: 'team-1', agentId: 'agent-3', createdAt: '2024-01-01T00:00:00Z' },
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      storage.getAgent.mockImplementation(async (agentId: string) => {
        if (agentId === 'agent-1') return makeAgent('agent-1', 'Alpha');
        if (agentId === 'agent-2') return makeAgent('agent-2', 'Beta');
        if (agentId === 'agent-3') return makeAgent('agent-3', 'Gamma');
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
        {
          id: 'session-3',
          agentId: 'agent-3',
          status: 'running',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: null,
          epicId: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ]);

      // Override deliver mock to return results for agent-2 and agent-3
      (agentMessageDelivery as { deliver: jest.Mock }).deliver.mockResolvedValue({
        status: 'queued',
        results: [
          { agentId: 'agent-2', status: 'queued' },
          { agentId: 'agent-3', status: 'queued' },
        ],
      });

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        teamName: 'Platform',
        message: 'hello team',
      });

      expect(result.success).toBe(true);
      const data = (
        result as {
          success: true;
          data: {
            queued: Array<{ name: string }>;
            queuedCount: number;
            teamDelivery?: {
              teamName: string;
              recipientCount: number;
              routedToLead: boolean;
              summary: string;
            };
          };
        }
      ).data;
      expect(data.queued).toEqual([
        { name: 'Beta', type: 'agent', status: 'queued' },
        { name: 'Gamma', type: 'agent', status: 'queued' },
      ]);
      expect(data.queuedCount).toBe(2);
      expect(data.teamDelivery).toEqual({
        teamName: 'Platform',
        recipientCount: 2,
        routedToLead: false,
        summary: 'Delivered to 2 agent(s) (no lead assigned)',
      });
      // deliver is called once with both recipient IDs in a single batch
      expect((agentMessageDelivery as { deliver: jest.Mock }).deliver).toHaveBeenCalledTimes(1);
      expect((agentMessageDelivery as { deliver: jest.Mock }).deliver).toHaveBeenCalledWith(
        ['agent-2', 'agent-3'],
        expect.objectContaining({
          source: 'mcp.send_message',
          senderAgentId: 'agent-1',
        }),
        expect.objectContaining({ submitKeys: ['Enter'] }),
      );
    });

    it('send_message returns TEAM_NOT_FOUND when no exact project-scoped team name exists', async () => {
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

      (teamsService as { findTeamByExactName: jest.Mock }).findTeamByExactName.mockResolvedValue(
        null,
      );

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        teamName: 'Missing Team',
        message: 'hello',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TEAM_NOT_FOUND');
      expect(result.error?.message).toContain('Team "Missing Team" not found in project');
    });

    it('send_message resolves teamName through exact lookup instead of fuzzy first-page results', async () => {
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

      (teamsService as { listTeams: jest.Mock }).listTeams.mockResolvedValue({
        items: [
          {
            id: 'team-a',
            name: 'Alpha Team',
            description: null,
            teamLeadAgentId: 'agent-3',
            teamLeadAgentName: 'Gamma',
            memberCount: 1,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
        total: 3,
        limit: 1,
        offset: 0,
      });
      (teamsService as { findTeamByExactName: jest.Mock }).findTeamByExactName.mockResolvedValue({
        id: 'team-platform',
        projectId: project.id,
        name: 'Platform',
        description: null,
        teamLeadAgentId: 'agent-2',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      (teamsService as { getTeam: jest.Mock }).getTeam.mockResolvedValue({
        id: 'team-platform',
        projectId: project.id,
        name: 'Platform',
        description: null,
        teamLeadAgentId: 'agent-2',
        members: [
          { teamId: 'team-platform', agentId: 'agent-1', createdAt: '2024-01-01T00:00:00Z' },
          { teamId: 'team-platform', agentId: 'agent-2', createdAt: '2024-01-01T00:00:00Z' },
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
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

      // Override deliver mock to return result for agent-2
      (agentMessageDelivery as { deliver: jest.Mock }).deliver.mockResolvedValue({
        status: 'queued',
        results: [{ agentId: 'agent-2', status: 'queued' }],
      });

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        teamName: 'Platform',
        message: 'hello platform',
      });

      expect(result.success).toBe(true);
      expect(
        (teamsService as { findTeamByExactName: jest.Mock }).findTeamByExactName,
      ).toHaveBeenCalledWith(project.id, 'Platform');
      expect((teamsService as { listTeams: jest.Mock }).listTeams).not.toHaveBeenCalled();
      expect((agentMessageDelivery as { deliver: jest.Mock }).deliver).toHaveBeenCalledWith(
        ['agent-2'],
        expect.objectContaining({
          source: 'mcp.send_message',
          senderAgentId: 'agent-1',
        }),
        expect.objectContaining({ submitKeys: ['Enter'] }),
      );
    });

    it('send_message returns NO_RECIPIENTS when sender is the only team member or lead', async () => {
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

      (teamsService as { findTeamByExactName: jest.Mock }).findTeamByExactName.mockResolvedValue({
        id: 'team-1',
        projectId: project.id,
        name: 'Platform',
        description: null,
        teamLeadAgentId: 'agent-1',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      (teamsService as { getTeam: jest.Mock }).getTeam.mockResolvedValue({
        id: 'team-1',
        projectId: project.id,
        name: 'Platform',
        description: null,
        teamLeadAgentId: 'agent-1',
        members: [{ teamId: 'team-1', agentId: 'agent-1', createdAt: '2024-01-01T00:00:00Z' }],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        teamName: 'Platform',
        message: 'hello',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NO_RECIPIENTS');
      expect(result.error?.message).toBe('No recipients — sender is the only team member/lead');
    });

    it('send_message returns NO_RECIPIENTS when sender is the only team member and no lead is assigned', async () => {
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

      (teamsService as { findTeamByExactName: jest.Mock }).findTeamByExactName.mockResolvedValue({
        id: 'team-1',
        projectId: project.id,
        name: 'Platform',
        description: null,
        teamLeadAgentId: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      (teamsService as { getTeam: jest.Mock }).getTeam.mockResolvedValue({
        id: 'team-1',
        projectId: project.id,
        name: 'Platform',
        description: null,
        teamLeadAgentId: null,
        members: [{ teamId: 'team-1', agentId: 'agent-1', createdAt: '2024-01-01T00:00:00Z' }],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        teamName: 'Platform',
        message: 'hello',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NO_RECIPIENTS');
      expect(result.error?.message).toBe('No recipients — sender is the only team member/lead');
    });

    it('self-team fallback: teamless sender returns NO_SELF_TEAM', async () => {
      (teamsService as { listTeamsByAgent: jest.Mock }).listTeamsByAgent.mockResolvedValue([]);

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        message: 'Hello team',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({ code: 'NO_SELF_TEAM' });
    });

    it('self-team fallback: sender in 2 teams returns AMBIGUOUS_SELF_TEAM', async () => {
      (teamsService as { listTeamsByAgent: jest.Mock }).listTeamsByAgent.mockResolvedValue([
        { id: 't1', name: 'Team A', teamLeadAgentId: TEST_AGENT.id },
        { id: 't2', name: 'Team B', teamLeadAgentId: 'other' },
      ]);

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        message: 'Hello team',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({ code: 'AMBIGUOUS_SELF_TEAM' });
    });

    it('self-team fallback: single-team sender resolves effectiveTeamName', async () => {
      (teamsService as { listTeamsByAgent: jest.Mock }).listTeamsByAgent.mockResolvedValue([
        { id: 'team-1', name: 'Platform', teamLeadAgentId: TEST_AGENT.id },
      ]);

      (teamsService as { findTeamByExactName: jest.Mock }).findTeamByExactName.mockResolvedValue({
        id: 'team-1',
        projectId: 'project-1',
        name: 'Platform',
        description: null,
        teamLeadAgentId: TEST_AGENT.id,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      (teamsService as { getTeam: jest.Mock }).getTeam.mockResolvedValue({
        id: 'team-1',
        projectId: 'project-1',
        name: 'Platform',
        description: null,
        teamLeadAgentId: TEST_AGENT.id,
        members: [{ teamId: 'team-1', agentId: TEST_AGENT.id, createdAt: '2024-01-01T00:00:00Z' }],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        message: 'Hello team',
      });

      // Single member (self) → NO_RECIPIENTS (sender excluded), but team was resolved
      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({ code: 'NO_RECIPIENTS' });
      // Verify self-team resolution triggered the team lookup
      expect(
        (teamsService as { listTeamsByAgent: jest.Mock }).listTeamsByAgent,
      ).toHaveBeenCalledWith(TEST_AGENT.id);
      expect(
        (teamsService as { findTeamByExactName: jest.Mock }).findTeamByExactName,
      ).toHaveBeenCalledWith('project-1', 'Platform');
    });

    it('self-team fallback: empty recipientAgentNames rejected at schema layer', async () => {
      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        recipientAgentNames: [],
        message: 'Hello',
      });

      expect(result.success).toBe(false);
    });

    it('self-team fallback: non-lead member routes to lead', async () => {
      (teamsService as { listTeamsByAgent: jest.Mock }).listTeamsByAgent.mockResolvedValue([
        { id: 'team-1', name: 'Platform', teamLeadAgentId: 'agent-lead' },
      ]);

      (teamsService as { findTeamByExactName: jest.Mock }).findTeamByExactName.mockResolvedValue({
        id: 'team-1',
        projectId: 'project-1',
        name: 'Platform',
        description: null,
        teamLeadAgentId: 'agent-lead',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      (teamsService as { getTeam: jest.Mock }).getTeam.mockResolvedValue({
        id: 'team-1',
        projectId: 'project-1',
        name: 'Platform',
        description: null,
        teamLeadAgentId: 'agent-lead',
        members: [
          { teamId: 'team-1', agentId: TEST_AGENT.id, createdAt: '2024-01-01T00:00:00Z' },
          { teamId: 'team-1', agentId: 'agent-lead', createdAt: '2024-01-01T00:00:00Z' },
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      storage.getAgent.mockImplementation(async (agentId: string) => {
        if (agentId === TEST_AGENT.id) return TEST_AGENT;
        if (agentId === 'agent-lead') return makeAgent('agent-lead', 'Lead Agent');
        throw new NotFoundError('Agent', agentId);
      });

      // Override deliver mock to return result for agent-lead
      (agentMessageDelivery as { deliver: jest.Mock }).deliver.mockResolvedValue({
        status: 'queued',
        results: [{ agentId: 'agent-lead', status: 'queued' }],
      });

      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        message: 'Hello lead',
      });

      expect(result.success).toBe(true);
      const data = result.data as {
        queued: Array<{ name: string }>;
        teamDelivery?: { teamName: string; routedToLead: boolean };
      };
      expect(data.queued).toHaveLength(1);
      expect(data.queued[0].name).toBe('Lead Agent');
      expect(data.teamDelivery?.routedToLead).toBe(true);
    });

    it('self-team fallback: lead sender resolves team and routes to members', async () => {
      (teamsService as { listTeamsByAgent: jest.Mock }).listTeamsByAgent.mockResolvedValue([
        { id: 'team-1', name: 'Platform', teamLeadAgentId: TEST_AGENT.id },
      ]);

      (teamsService as { findTeamByExactName: jest.Mock }).findTeamByExactName.mockResolvedValue({
        id: 'team-1',
        projectId: 'project-1',
        name: 'Platform',
        description: null,
        teamLeadAgentId: TEST_AGENT.id,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      (teamsService as { getTeam: jest.Mock }).getTeam.mockResolvedValue({
        id: 'team-1',
        projectId: 'project-1',
        name: 'Platform',
        description: null,
        teamLeadAgentId: TEST_AGENT.id,
        members: [
          { teamId: 'team-1', agentId: TEST_AGENT.id, createdAt: '2024-01-01T00:00:00Z' },
          { teamId: 'team-1', agentId: 'agent-2', createdAt: '2024-01-01T00:00:00Z' },
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      storage.getAgent.mockImplementation(async (agentId: string) => {
        if (agentId === TEST_AGENT.id) return TEST_AGENT;
        if (agentId === 'agent-2') return makeAgent('agent-2', 'Beta');
        throw new NotFoundError('Agent', agentId);
      });

      await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        message: 'Hello team',
      });

      // Verify self-team resolution path was taken
      expect(
        (teamsService as { listTeamsByAgent: jest.Mock }).listTeamsByAgent,
      ).toHaveBeenCalledWith(TEST_AGENT.id);
      expect(
        (teamsService as { findTeamByExactName: jest.Mock }).findTeamByExactName,
      ).toHaveBeenCalledWith('project-1', 'Platform');
      expect((teamsService as { getTeam: jest.Mock }).getTeam).toHaveBeenCalledWith('team-1');
      // Agent-2 was resolved as recipient (sender excluded)
      expect(storage.getAgent).toHaveBeenCalledWith('agent-2');
    });

    it('send_message pooled mode auto-launches offline recipient agents when NODE_ENV is not test', async () => {
      // Auto-launch is now internal to the delivery facade.
      // The handler just calls deliver() and returns the facade's result.
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
        // agent-2 has NO active session
      ]);

      // Facade returns 'queued' status (launch is internal to the facade)
      (agentMessageDelivery as { deliver: jest.Mock }).deliver.mockResolvedValue({
        status: 'queued',
        results: [{ agentId: 'agent-2', status: 'queued' }],
      });

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
            queued: Array<{ name: string; status: string }>;
            queuedCount: number;
            estimatedDeliveryMs: number;
          };
        }
      ).data;

      expect(data.mode).toBe('pooled');
      // Status is 'queued' because the facade handles launch internally
      expect(data.queued).toEqual([{ name: 'Beta', type: 'agent', status: 'queued' }]);
      expect(data.queuedCount).toBe(1);

      // Verify deliver was called with the correct recipients
      expect((agentMessageDelivery as { deliver: jest.Mock }).deliver).toHaveBeenCalledWith(
        ['agent-2'],
        expect.objectContaining({
          kind: 'mcp.direct',
          body: 'hello beta',
          source: 'mcp.send_message',
          senderName: expect.any(String),
          senderAgentId: 'agent-1',
        }),
        expect.objectContaining({ submitKeys: ['Enter'] }),
      );
    });

    it('send_message pooled mode does not auto-launch when NODE_ENV is test', async () => {
      // Auto-launch is now internal to the delivery facade.
      // The handler always calls deliver(); the facade decides whether to launch.
      process.env.NODE_ENV = 'test';
      (agentMessageDelivery as { deliver: jest.Mock }).deliver.mockClear();

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

      // Override deliver mock to return result for agent-2
      (agentMessageDelivery as { deliver: jest.Mock }).deliver.mockResolvedValue({
        status: 'queued',
        results: [{ agentId: 'agent-2', status: 'queued' }],
      });

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
            queued: Array<{ name: string; status: string }>;
            queuedCount: number;
          };
        }
      ).data;

      expect(data.mode).toBe('pooled');
      // Status is 'queued' — the facade decides whether to launch internally
      expect(data.queued).toEqual([{ name: 'Beta', type: 'agent', status: 'queued' }]);

      // deliver is called — the facade handles launch decisions internally
      expect((agentMessageDelivery as { deliver: jest.Mock }).deliver).toHaveBeenCalledWith(
        ['agent-2'],
        expect.objectContaining({
          kind: 'mcp.direct',
          body: 'hello beta',
          source: 'mcp.send_message',
          senderName: expect.any(String),
          senderAgentId: 'agent-1',
        }),
        expect.objectContaining({ submitKeys: ['Enter'] }),
      );
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

      // Override deliver mock to return result for agent-2
      (agentMessageDelivery as { deliver: jest.Mock }).deliver.mockResolvedValue({
        status: 'delivered',
        results: [{ agentId: 'agent-2', status: 'delivered' }],
      });

      // Sender identity now comes from session context (agent-1 = Alpha)
      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        threadId: '00000000-0000-0000-0000-000000000001',
        message: 'hello',
      });

      expect(result.success).toBe(true);
      // Thread mode now uses agentMessageDelivery.deliver with immediate: true
      expect((agentMessageDelivery as { deliver: jest.Mock }).deliver).toHaveBeenCalledWith(
        ['agent-2'],
        expect.objectContaining({
          kind: 'mcp.thread',
          body: 'hello',
          source: 'mcp.chat_thread',
          senderName: expect.any(String),
          senderAgentId: 'agent-1',
          threadId: '00000000-0000-0000-0000-000000000001',
          messageId: '00000000-0000-0000-0000-000000000002',
        }),
        expect.objectContaining({ submitKeys: ['Enter'], immediate: true }),
      );
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

      // Override deliver mock to return result for agent-2
      (agentMessageDelivery as { deliver: jest.Mock }).deliver.mockResolvedValue({
        status: 'queued',
        results: [{ agentId: 'agent-2', status: 'queued' }],
      });

      // Sender identity now comes from session context (agent-1 = Alpha)
      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: TEST_SESSION_ID,
        recipientAgentNames: ['Beta'],
        message: 'ping',
      });

      expect(result.success).toBe(true);
      // Message is delivered via the facade (which handles pool/flush internally)
      expect((agentMessageDelivery as { deliver: jest.Mock }).deliver).toHaveBeenCalledWith(
        ['agent-2'],
        expect.objectContaining({
          kind: 'mcp.direct',
          body: 'ping',
          source: 'mcp.send_message',
          senderName: expect.any(String),
          senderAgentId: 'agent-1',
        }),
        expect.objectContaining({ submitKeys: ['Enter'] }),
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

      (agentMessageDelivery as { deliverToGuest: jest.Mock }).deliverToGuest.mockResolvedValue({
        delivered: true,
      });

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
        status: 'delivered',
      });
      expect(data.queued[0].error).toBeUndefined();

      expect(
        (agentMessageDelivery as { deliverToGuest: jest.Mock }).deliverToGuest,
      ).toHaveBeenCalledWith(
        'guest-tmux-session',
        expect.stringContaining('[formatted] Hello guest!'),
        ['Enter'],
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

      // Guest delivery returns failure (offline)
      (agentMessageDelivery as { deliverToGuest: jest.Mock }).deliverToGuest.mockResolvedValue({
        delivered: false,
        error: 'Recipient offline',
      });

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

      expect(
        (agentMessageDelivery as { deliverToGuest: jest.Mock }).deliverToGuest,
      ).toHaveBeenCalledWith(
        'guest-tmux-session',
        expect.stringContaining('[formatted] Hello guest!'),
        ['Enter'],
      );
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

      // Guest delivery returns failure (tmux error)
      (agentMessageDelivery as { deliverToGuest: jest.Mock }).deliverToGuest.mockResolvedValue({
        delivered: false,
        error: 'Tmux pane not responding',
      });

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
      (terminalIO as { sessionExists: jest.Mock }).sessionExists.mockResolvedValue(true);

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
});
