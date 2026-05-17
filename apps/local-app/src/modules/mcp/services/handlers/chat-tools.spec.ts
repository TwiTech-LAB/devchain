import {
  handleSendMessage,
  handleChatAck,
  handleChatListMembers,
  handleChatReadHistory,
} from './chat-tools';
import type { ChatToolContext } from './chat-context';
import type { AgentSessionContext, GuestSessionContext } from '../../dtos/mcp.dto';
import { NotFoundError } from '../../../../common/errors/error-types';
import { createNullAdapter } from './null-adapter';
import type { ChatService } from '../../../chat/services/chat.service';
import type { SessionsService } from '../../../sessions/services/sessions.service';
import type { AgentMessageDeliveryService } from '../../../agent-message-delivery/agent-message-delivery.service';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

const PROJECT_ID = '00000000-0000-0000-0000-000000000001';
const AGENT_ID = '00000000-0000-0000-0000-000000000002';
const AGENT_NAME = 'Agent-A';
const SESSION_ID = '00000000-0000-0000-0000-000000000003';
const THREAD_ID = '00000000-0000-0000-0000-000000000004';
const MESSAGE_ID = '00000000-0000-0000-0000-000000000005';
const GUEST_ID = '00000000-0000-0000-0000-000000000006';
const RECIPIENT_AGENT_ID = '00000000-0000-0000-0000-000000000007';
const TEAM_ID = '00000000-0000-0000-0000-000000000008';

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

function makeGuestCtx(): GuestSessionContext {
  return {
    type: 'guest',
    guest: { id: GUEST_ID, name: 'Guest-A', projectId: PROJECT_ID, tmuxSessionId: 'tmux-001' },
    project: { id: PROJECT_ID, name: 'Test Project', rootPath: '/tmp/test' },
  };
}

function makeCtx(
  sessionCtx: AgentSessionContext | GuestSessionContext | null = null,
  overrides: Partial<ChatToolContext> = {},
): ChatToolContext {
  return {
    storage: {
      getAgent: jest.fn().mockImplementation(async (id: string) => {
        if (id === AGENT_ID) return { id: AGENT_ID, name: AGENT_NAME, projectId: PROJECT_ID };
        if (id === RECIPIENT_AGENT_ID)
          return { id: RECIPIENT_AGENT_ID, name: 'Agent-B', projectId: PROJECT_ID };
        throw new NotFoundError('Agent', id);
      }),
      getAgentByName: jest.fn().mockImplementation(async (_projectId: string, name: string) => {
        if (name === 'Agent-B')
          return { id: RECIPIENT_AGENT_ID, name: 'Agent-B', projectId: PROJECT_ID };
        throw new NotFoundError('Agent', name);
      }),
      getGuestByName: jest.fn().mockResolvedValue(null),
      listAgents: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      listGuests: jest.fn().mockResolvedValue([]),
    } as never,
    sessionsService: {
      listActiveSessions: jest.fn().mockReturnValue([]),
      getActiveSessionsForProject: jest.fn().mockReturnValue([]),
    } as never,
    chatService: {
      createThread: jest.fn().mockResolvedValue({ id: THREAD_ID, title: null, members: [] }),
      getThread: jest
        .fn()
        .mockResolvedValue({ id: THREAD_ID, title: 'Test Thread', members: [AGENT_ID] }),
      addMessage: jest.fn().mockResolvedValue({ id: MESSAGE_ID }),
      markRead: jest.fn().mockResolvedValue(undefined),
      listMessages: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 }),
    } as never,
    teamsService: {
      listTeamsByAgent: jest.fn().mockResolvedValue([]),
      findTeamByExactName: jest.fn().mockResolvedValue(null),
      getTeam: jest.fn().mockResolvedValue(null),
    } as never,
    agentMessageDelivery: createNullAdapter<AgentMessageDeliveryService>(
      'AgentMessageDeliveryService',
    ),
    settingsService: {
      getMessagePoolConfigForProject: jest.fn().mockReturnValue({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      }),
    } as never,
    resolveSessionContext: jest.fn().mockResolvedValue({
      success: true,
      data: sessionCtx ?? makeAgentCtx(),
    }),
    ...overrides,
  };
}

describe('chat-tools handlers', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleSendMessage', () => {
    it('returns error when sessionsService unavailable', async () => {
      const ctx = makeCtx(null, {
        sessionsService: createNullAdapter<SessionsService>('SessionsService'),
      });
      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        message: 'hello',
        recipientAgentNames: ['Agent-B'],
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('returns error when session resolution fails', async () => {
      const ctx = makeCtx();
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'not found' },
      });

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        message: 'hello',
        recipientAgentNames: ['Agent-B'],
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns error when no project associated', async () => {
      const sessionCtx = makeAgentCtx();
      (sessionCtx as Record<string, unknown>).project = null;
      const ctx = makeCtx(sessionCtx);

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        message: 'hello',
        recipientAgentNames: ['Agent-B'],
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROJECT_NOT_FOUND');
    });

    it('blocks guest from using threadId', async () => {
      const ctx = makeCtx(makeGuestCtx());

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        message: 'hello',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GUEST_THREAD_NOT_ALLOWED');
    });

    it('blocks guest from sending user DM without teamName', async () => {
      const ctx = makeCtx(makeGuestCtx());

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        recipient: 'user',
        message: 'hello',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GUEST_USER_DM_NOT_ALLOWED');
    });

    it('returns NO_SELF_TEAM when sender has no teams and no explicit routing', async () => {
      const ctx = makeCtx();
      (ctx.teamsService!.listTeamsByAgent as jest.Mock).mockResolvedValue([]);

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        message: 'hello',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NO_SELF_TEAM');
    });

    it('returns AMBIGUOUS_SELF_TEAM when sender in multiple teams', async () => {
      const ctx = makeCtx();
      (ctx.teamsService!.listTeamsByAgent as jest.Mock).mockResolvedValue([
        { id: TEAM_ID, name: 'Team-A' },
        { id: '00000000-0000-0000-0000-000000000009', name: 'Team-B' },
      ]);

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        message: 'hello',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('AMBIGUOUS_SELF_TEAM');
    });

    it('returns TEAM_NOT_FOUND when explicit team does not exist', async () => {
      const ctx = makeCtx();
      (ctx.teamsService!.findTeamByExactName as jest.Mock).mockResolvedValue(null);

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        teamName: 'nonexistent',
        message: 'hello',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TEAM_NOT_FOUND');
    });

    it('returns RECIPIENT_NOT_FOUND when named agent does not exist', async () => {
      const ctx = makeCtx();
      (ctx.storage.getAgentByName as jest.Mock).mockRejectedValue(
        new NotFoundError('Agent', 'Unknown'),
      );
      (ctx.storage.getGuestByName as jest.Mock).mockResolvedValue(null);

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        recipientAgentNames: ['Unknown'],
        message: 'hello',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RECIPIENT_NOT_FOUND');
    });
  });

  describe('handleChatAck', () => {
    it('returns error when chatService unavailable', async () => {
      const ctx = makeCtx(null, { chatService: createNullAdapter<ChatService>('ChatService') });
      const result = await handleChatAck(ctx, {
        sessionId: SESSION_ID,
        thread_id: THREAD_ID,
        message_id: MESSAGE_ID,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('acknowledges a message successfully', async () => {
      const ctx = makeCtx();
      (ctx.chatService!.markMessageAsRead as jest.Mock) = jest
        .fn()
        .mockResolvedValue({ readAt: '2024-01-01T00:00:00Z' });
      (ctx.chatService!.getThread as jest.Mock).mockResolvedValue({
        id: THREAD_ID,
        title: 'Test',
        members: [AGENT_ID],
      });

      const result = await handleChatAck(ctx, {
        sessionId: SESSION_ID,
        thread_id: THREAD_ID,
        message_id: MESSAGE_ID,
      });
      expect(result.success).toBe(true);
      expect(result.data.acknowledged).toBe(true);
      expect(result.data.agentName).toBe(AGENT_NAME);
    });

    it('calls markMessageAsRead → acknowledgeInvite in order (broadcast via subscriber)', async () => {
      const callOrder: string[] = [];
      const ctx = makeCtx();
      (ctx.chatService!.markMessageAsRead as jest.Mock) = jest.fn().mockImplementation(async () => {
        callOrder.push('markMessageAsRead');
        return { readAt: '2024-01-01T00:00:00Z' };
      });
      (ctx.chatService!.acknowledgeInvite as jest.Mock) = jest.fn().mockImplementation(async () => {
        callOrder.push('acknowledgeInvite');
      });
      (ctx.chatService!.getThread as jest.Mock).mockResolvedValue({
        id: THREAD_ID,
        title: 'Test',
        members: [AGENT_ID],
      });
      (ctx.sessionsService!.listActiveSessions as jest.Mock).mockReturnValue([
        { agentId: AGENT_ID, tmuxSessionId: 'tmux-1' },
      ]);

      await handleChatAck(ctx, {
        sessionId: SESSION_ID,
        thread_id: THREAD_ID,
        message_id: MESSAGE_ID,
      });

      expect(callOrder).toEqual(['markMessageAsRead', 'acknowledgeInvite']);
    });
  });

  describe('handleChatListMembers', () => {
    it('returns error when chatService unavailable', async () => {
      const ctx = makeCtx(null, { chatService: createNullAdapter<ChatService>('ChatService') });
      const result = await handleChatListMembers(ctx, { thread_id: THREAD_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('returns empty members for empty thread', async () => {
      const ctx = makeCtx();
      (ctx.chatService!.getThread as jest.Mock).mockResolvedValue({
        id: THREAD_ID,
        title: null,
        members: [],
      });

      const result = await handleChatListMembers(ctx, { thread_id: THREAD_ID });
      expect(result.success).toBe(true);
      expect(result.data.members).toHaveLength(0);
    });

    it('returns members with online status', async () => {
      const ctx = makeCtx();
      (ctx.chatService!.getThread as jest.Mock).mockResolvedValue({
        id: THREAD_ID,
        title: 'Test',
        members: [AGENT_ID],
      });
      (ctx.sessionsService!.listActiveSessions as jest.Mock).mockReturnValue([
        { agentId: AGENT_ID },
      ]);

      const result = await handleChatListMembers(ctx, { thread_id: THREAD_ID });
      expect(result.success).toBe(true);
      expect(result.data.members).toHaveLength(1);
      expect(result.data.members[0].online).toBe(true);
    });

    it('returns NOT_FOUND for missing thread', async () => {
      const ctx = makeCtx();
      (ctx.chatService!.getThread as jest.Mock).mockRejectedValue(
        new NotFoundError('Thread', THREAD_ID),
      );

      const result = await handleChatListMembers(ctx, { thread_id: THREAD_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NOT_FOUND');
    });
  });

  describe('handleChatReadHistory', () => {
    it('returns error when chatService unavailable', async () => {
      const ctx = makeCtx(null, { chatService: createNullAdapter<ChatService>('ChatService') });
      const result = await handleChatReadHistory(ctx, { thread_id: THREAD_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('returns messages with agent names resolved', async () => {
      const ctx = makeCtx();
      (ctx.chatService!.listMessages as jest.Mock).mockResolvedValue({
        items: [
          {
            id: MESSAGE_ID,
            authorType: 'agent',
            authorAgentId: AGENT_ID,
            content: 'Hello',
            createdAt: '2024-01-01T00:00:00Z',
            targets: null,
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      });

      const result = await handleChatReadHistory(ctx, { thread_id: THREAD_ID });
      expect(result.success).toBe(true);
      expect(result.data.messages).toHaveLength(1);
      expect(result.data.messages[0].author_agent_name).toBe(AGENT_NAME);
    });

    it('filters system messages by default', async () => {
      const ctx = makeCtx();
      (ctx.chatService!.listMessages as jest.Mock).mockResolvedValue({
        items: [
          {
            id: MESSAGE_ID,
            authorType: 'system',
            authorAgentId: null,
            content: 'system',
            createdAt: '2024-01-01T00:00:00Z',
            targets: null,
          },
          {
            id: '00000000-0000-0000-0000-00000000000a',
            authorType: 'agent',
            authorAgentId: AGENT_ID,
            content: 'hi',
            createdAt: '2024-01-01T00:00:01Z',
            targets: null,
          },
        ],
        total: 2,
        limit: 50,
        offset: 0,
      });

      const result = await handleChatReadHistory(ctx, { thread_id: THREAD_ID });
      expect(result.success).toBe(true);
      expect(result.data.messages).toHaveLength(1);
      expect(result.data.messages[0].author_type).toBe('agent');
    });

    it('includes system messages when exclude_system is false', async () => {
      const ctx = makeCtx();
      (ctx.chatService!.listMessages as jest.Mock).mockResolvedValue({
        items: [
          {
            id: MESSAGE_ID,
            authorType: 'system',
            authorAgentId: null,
            content: 'system',
            createdAt: '2024-01-01T00:00:00Z',
            targets: null,
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      });

      const result = await handleChatReadHistory(ctx, {
        thread_id: THREAD_ID,
        exclude_system: false,
      });
      expect(result.success).toBe(true);
      expect(result.data.messages).toHaveLength(1);
    });

    it('returns NOT_FOUND for missing thread', async () => {
      const ctx = makeCtx();
      (ctx.chatService!.getThread as jest.Mock).mockRejectedValue(
        new NotFoundError('Thread', THREAD_ID),
      );

      const result = await handleChatReadHistory(ctx, { thread_id: THREAD_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NOT_FOUND');
    });
  });
});
