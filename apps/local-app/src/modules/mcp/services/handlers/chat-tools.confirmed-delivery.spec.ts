import { handleSendMessage } from './chat-tools';
import { NotFoundError } from '../../../../common/errors/error-types';
import type { McpToolContext } from './types';
import type { AgentSessionContext, SessionContext } from '../../dtos/mcp.dto';

// Mock deliverWithConfirmation so we control confirmed/unconfirmed outcomes
jest.mock('../../../terminal/services/confirmed-delivery.helper', () => ({
  deliverWithConfirmation: jest.fn(),
}));

import { deliverWithConfirmation } from '../../../terminal/services/confirmed-delivery.helper';

const mockedDeliverWithConfirmation = deliverWithConfirmation as jest.MockedFunction<
  typeof deliverWithConfirmation
>;

// ------------------------------------------------------------------ helpers --

const SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const THREAD_ID = '00000000-0000-0000-0000-000000000001';
const MSG_ID = '00000000-0000-0000-0000-000000000002';
const AGENT_SESSION_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** Agent-type session context returned by resolveSessionContext */
function makeAgentSessionContext(): AgentSessionContext {
  return {
    type: 'agent',
    session: {
      id: SESSION_ID,
      agentId: 'agent-1',
      status: 'running',
      startedAt: '2024-01-01T00:00:00Z',
    },
    agent: { id: 'agent-1', name: 'SenderAgent', projectId: 'project-1' },
    project: { id: 'project-1', name: 'TestProject', rootPath: '/tmp/test' },
  };
}

/** Build a minimal McpToolContext for the pooled/guest path */
function makeGuestPathCtx(overrides: Partial<McpToolContext> = {}): McpToolContext {
  const sessionsService = {
    listActiveSessions: jest.fn().mockResolvedValue([]),
    injectTextIntoSession: jest.fn(),
    launchSession: jest.fn(),
  };

  const chatService = {
    getThread: jest.fn(),
    createMessage: jest.fn(),
    createDirectThread: jest.fn(),
  };

  const messagePoolService = {
    enqueue: jest.fn().mockResolvedValue({ status: 'queued', poolSize: 1 }),
  };

  const settingsService = {
    getMessagePoolConfigForProject: jest.fn().mockReturnValue({
      enabled: true,
      delayMs: 5000,
      maxWaitMs: 30000,
      maxMessages: 10,
      separator: '\n---\n',
    }),
  };

  const tmuxService = {
    hasSession: jest.fn().mockResolvedValue(true),
    pasteAndSubmit: jest.fn().mockResolvedValue(undefined),
    sendKeys: jest.fn().mockResolvedValue(undefined),
  };

  const storage = {
    getAgentByName: jest.fn().mockRejectedValue(new NotFoundError('agent not found')),
    getGuestByName: jest.fn().mockResolvedValue({
      id: 'guest-1',
      name: 'GuestUser',
      projectId: 'project-1',
      tmuxSessionId: 'tmux-guest-session',
    }),
    listAgents: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    listGuests: jest.fn().mockResolvedValue([]),
    getAgent: jest
      .fn()
      .mockResolvedValue({ id: 'agent-1', name: 'SenderAgent', projectId: 'project-1' }),
  };

  const resolveSessionContext = jest.fn().mockResolvedValue({
    success: true,
    data: makeAgentSessionContext() as SessionContext,
  });

  return {
    storage: storage as unknown as McpToolContext['storage'],
    chatService: chatService as unknown as McpToolContext['chatService'],
    sessionsService: sessionsService as unknown as McpToolContext['sessionsService'],
    messagePoolService: messagePoolService as unknown as McpToolContext['messagePoolService'],
    settingsService: settingsService as unknown as McpToolContext['settingsService'],
    tmuxService: tmuxService as unknown as McpToolContext['tmuxService'],
    resolveSessionContext,
    ...overrides,
  };
}

/** Build a minimal McpToolContext for the thread path */
function makeThreadPathCtx(overrides: Partial<McpToolContext> = {}): McpToolContext {
  const sessionsService = {
    listActiveSessions: jest.fn().mockResolvedValue([
      {
        id: AGENT_SESSION_ID,
        agentId: 'agent-2',
        tmuxSessionId: 'tmux-agent-2',
        status: 'running',
        startedAt: '2024-01-01T00:00:00Z',
      },
    ]),
    injectTextIntoSession: jest.fn(),
    launchSession: jest.fn(),
  };

  const chatService = {
    getThread: jest.fn().mockResolvedValue({
      id: THREAD_ID,
      projectId: 'project-1',
      title: 'Test Thread',
      isGroup: true,
      createdByType: 'user',
      createdByUserId: null,
      createdByAgentId: null,
      members: ['agent-1', 'agent-2'],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }),
    createMessage: jest.fn().mockResolvedValue({
      id: MSG_ID,
      threadId: THREAD_ID,
      authorType: 'agent',
      authorAgentId: 'agent-1',
      content: 'Hello',
      createdAt: '2024-01-01T00:00:00Z',
    }),
    createDirectThread: jest.fn(),
  };

  const storage = {
    getAgent: jest
      .fn()
      .mockResolvedValue({ id: 'agent-2', name: 'RecipientAgent', projectId: 'project-1' }),
    getAgentByName: jest.fn().mockRejectedValue(new NotFoundError('not found')),
    getGuestByName: jest.fn().mockResolvedValue(null),
    listAgents: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    listGuests: jest.fn().mockResolvedValue([]),
  };

  const resolveSessionContext = jest.fn().mockResolvedValue({
    success: true,
    data: makeAgentSessionContext() as SessionContext,
  });

  return {
    storage: storage as unknown as McpToolContext['storage'],
    chatService: chatService as unknown as McpToolContext['chatService'],
    sessionsService: sessionsService as unknown as McpToolContext['sessionsService'],
    resolveSessionContext,
    ...overrides,
  };
}

// ------------------------------------------------------------------- tests ---

describe('handleSendMessage – confirmed-delivery propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Disable auto-launch so tests never hit launchSession
    process.env.NODE_ENV = 'test';
  });

  // ── pooled / guest path ───────────────────────────────────────────────────

  describe('pooled mode (guest delivery)', () => {
    const params = {
      sessionId: SESSION_ID,
      recipientAgentNames: ['GuestUser'],
      message: 'ping',
    };

    it('status is delivered when deliverWithConfirmation returns confirmed: true', async () => {
      mockedDeliverWithConfirmation.mockResolvedValueOnce({
        confirmed: true,
        nonce: 'abc',
        retryCount: 0,
      });

      const ctx = makeGuestPathCtx();
      const result = await handleSendMessage(ctx, params);

      expect(result.success).toBe(true);
      const data = result.data as { mode: string; queued: Array<{ status: string }> };
      expect(data.mode).toBe('pooled');
      expect(data.queued[0].status).toBe('delivered');
    });

    it('status is unconfirmed when deliverWithConfirmation returns confirmed: false', async () => {
      mockedDeliverWithConfirmation.mockResolvedValueOnce({
        confirmed: false,
        nonce: 'abc',
        retryCount: 1,
      });

      const ctx = makeGuestPathCtx();
      const result = await handleSendMessage(ctx, params);

      expect(result.success).toBe(true);
      const data = result.data as { mode: string; queued: Array<{ status: string }> };
      expect(data.mode).toBe('pooled');
      expect(data.queued[0].status).toBe('unconfirmed');
    });
  });

  // ── thread path ───────────────────────────────────────────────────────────

  describe('thread mode', () => {
    const params = {
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      message: 'hello from thread',
    };

    it('status is delivered when injectTextIntoSession returns confirmed: true', async () => {
      const ctx = makeThreadPathCtx();
      (ctx.sessionsService!.injectTextIntoSession as jest.Mock).mockResolvedValueOnce({
        confirmed: true,
        method: 'nonce',
      });

      const result = await handleSendMessage(ctx, params);

      expect(result.success).toBe(true);
      const data = result.data as { mode: string; delivered: Array<{ status: string }> };
      expect(data.mode).toBe('thread');
      expect(data.delivered[0].status).toBe('delivered');
    });

    it('status is unconfirmed when injectTextIntoSession returns confirmed: false', async () => {
      const ctx = makeThreadPathCtx();
      (ctx.sessionsService!.injectTextIntoSession as jest.Mock).mockResolvedValueOnce({
        confirmed: false,
      });

      const result = await handleSendMessage(ctx, params);

      expect(result.success).toBe(true);
      const data = result.data as { mode: string; delivered: Array<{ status: string }> };
      expect(data.mode).toBe('thread');
      expect(data.delivered[0].status).toBe('unconfirmed');
    });
  });
});
