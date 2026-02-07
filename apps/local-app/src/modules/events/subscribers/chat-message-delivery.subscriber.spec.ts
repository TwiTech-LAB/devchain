import { ChatMessageDeliverySubscriber } from './chat-message-delivery.subscriber';
import type { SessionsMessagePoolService } from '../../sessions/services/sessions-message-pool.service';
import type { SessionsService } from '../../sessions/services/sessions.service';
import type { TmuxService } from '../../terminal/services/tmux.service';
import type { ChatService } from '../../chat/services/chat.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';

describe('ChatMessageDeliverySubscriber', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  function buildSubscriber(options?: {
    hasActiveSession?: boolean;
    tmuxSessionAlive?: boolean;
    launchSessionFails?: boolean;
  }) {
    const enqueue = jest.fn().mockResolvedValue({ status: 'queued', poolSize: 1 });

    const messagePoolService = {
      enqueue,
    } as unknown as SessionsMessagePoolService;

    const getActiveSessionForAgent = jest
      .fn()
      .mockReturnValue(
        options?.hasActiveSession !== false
          ? { id: 'session-1', agentId: 'agent-1', tmuxSessionId: 'tmux-1', status: 'running' }
          : null,
      );
    const launchSession = options?.launchSessionFails
      ? jest.fn().mockRejectedValue(new Error('Launch failed'))
      : jest.fn().mockResolvedValue({ id: 'session-new', agentId: 'agent-1', status: 'running' });

    const sessionsService = {
      getActiveSessionForAgent,
      launchSession,
    } as unknown as SessionsService;

    // Default: tmux session is alive if hasActiveSession is true
    const hasSession = jest.fn().mockResolvedValue(options?.tmuxSessionAlive !== false);

    const tmuxService = {
      hasSession,
    } as unknown as TmuxService;

    const getThread = jest.fn().mockResolvedValue({
      id: 'thread-1',
      projectId: 'project-1',
      title: null,
      isGroup: false,
      createdByType: 'user',
      createdByUserId: null,
      createdByAgentId: null,
      members: ['agent-1'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const chatService = {
      getThread,
    } as unknown as ChatService;

    const getAgent = jest.fn().mockResolvedValue({ id: 'agent-1', name: 'Alpha' });

    const storage = {
      getAgent,
    } as unknown as StorageService;

    const subscriber = new ChatMessageDeliverySubscriber(
      messagePoolService,
      sessionsService,
      tmuxService,
      chatService,
      storage,
    );

    return {
      subscriber,
      messagePoolService: { enqueue },
      sessionsService: { getActiveSessionForAgent, launchSession },
      tmuxService: { hasSession },
      chatService: { getThread },
      storage: { getAgent },
    };
  }

  it('does not enqueue for system messages', async () => {
    const { subscriber, messagePoolService, chatService, storage } = buildSubscriber();

    await subscriber.handleChatMessageCreated({
      threadId: 'thread-1',
      message: {
        id: 'message-1',
        threadId: 'thread-1',
        authorType: 'system',
        authorAgentId: null,
        content: 'tools/call { name: "devchain_chat_read_history", arguments: { thread_id: "x" } }',
        createdAt: new Date().toISOString(),
      },
    });

    expect(chatService.getThread).not.toHaveBeenCalled();
    expect(storage.getAgent).not.toHaveBeenCalled();
    expect(messagePoolService.enqueue).not.toHaveBeenCalled();
  });

  it('does not enqueue for agent-authored messages', async () => {
    const { subscriber, messagePoolService, chatService, storage } = buildSubscriber();

    await subscriber.handleChatMessageCreated({
      threadId: 'thread-1',
      message: {
        id: 'message-1',
        threadId: 'thread-1',
        authorType: 'agent',
        authorAgentId: 'agent-2',
        content: 'Hello from agent',
        createdAt: new Date().toISOString(),
      },
    });

    expect(chatService.getThread).not.toHaveBeenCalled();
    expect(storage.getAgent).not.toHaveBeenCalled();
    expect(messagePoolService.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues user messages to message pool with correct options', async () => {
    const { subscriber, messagePoolService } = buildSubscriber();

    await subscriber.handleChatMessageCreated({
      threadId: 'thread-1',
      message: {
        id: 'message-1',
        threadId: 'thread-1',
        authorType: 'user',
        authorAgentId: null,
        content: 'Hello',
        createdAt: new Date().toISOString(),
      },
    });

    expect(messagePoolService.enqueue).toHaveBeenCalledTimes(1);
    expect(messagePoolService.enqueue).toHaveBeenCalledWith(
      'agent-1',
      expect.stringContaining('Hello'),
      expect.objectContaining({
        source: 'chat.message',
        submitKeys: ['Enter'],
        senderAgentId: undefined,
      }),
    );
  });

  it('includes ACK hint in enqueued message', async () => {
    const { subscriber, messagePoolService } = buildSubscriber();

    await subscriber.handleChatMessageCreated({
      threadId: 'thread-1',
      message: {
        id: 'message-1',
        threadId: 'thread-1',
        authorType: 'user',
        authorAgentId: null,
        content: 'Hello',
        createdAt: new Date().toISOString(),
      },
    });

    expect(messagePoolService.enqueue).toHaveBeenCalledWith(
      'agent-1',
      expect.stringContaining('devchain_chat_ack'),
      expect.any(Object),
    );
    expect(messagePoolService.enqueue).toHaveBeenCalledWith(
      'agent-1',
      expect.stringContaining('agent_name: "Alpha"'),
      expect.any(Object),
    );
  });

  it('enqueues to targeted agents when @mentions present', async () => {
    const { subscriber, messagePoolService, storage, sessionsService } = buildSubscriber();
    sessionsService.getActiveSessionForAgent.mockReturnValue({
      id: 'session-2',
      agentId: 'agent-2',
      tmuxSessionId: 'tmux-2',
      status: 'running',
    });
    storage.getAgent.mockImplementation(async (id: string) => {
      if (id === 'agent-2') return { id: 'agent-2', name: 'Beta' };
      return { id: 'agent-1', name: 'Alpha' };
    });

    await subscriber.handleChatMessageCreated({
      threadId: 'thread-1',
      message: {
        id: 'message-1',
        threadId: 'thread-1',
        authorType: 'user',
        authorAgentId: null,
        content: 'Hello @Beta',
        targets: ['agent-2'],
        createdAt: new Date().toISOString(),
      },
    });

    expect(messagePoolService.enqueue).toHaveBeenCalledTimes(1);
    expect(messagePoolService.enqueue).toHaveBeenCalledWith(
      'agent-2',
      expect.stringContaining('Hello @Beta'),
      expect.objectContaining({
        source: 'chat.message',
      }),
    );
  });

  describe('auto-launch session', () => {
    it('auto-launches session when agent has no active session', async () => {
      const { subscriber, sessionsService, messagePoolService } = buildSubscriber({
        hasActiveSession: false,
      });

      await subscriber.handleChatMessageCreated({
        threadId: 'thread-1',
        message: {
          id: 'message-1',
          threadId: 'thread-1',
          authorType: 'user',
          authorAgentId: null,
          content: 'Hello',
          createdAt: new Date().toISOString(),
        },
      });

      expect(sessionsService.getActiveSessionForAgent).toHaveBeenCalledWith('agent-1');
      expect(sessionsService.launchSession).toHaveBeenCalledWith({
        agentId: 'agent-1',
        projectId: 'project-1',
        options: { silent: true },
      });
      expect(messagePoolService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('does not launch session when agent already has active session', async () => {
      const { subscriber, sessionsService, messagePoolService } = buildSubscriber({
        hasActiveSession: true,
      });

      await subscriber.handleChatMessageCreated({
        threadId: 'thread-1',
        message: {
          id: 'message-1',
          threadId: 'thread-1',
          authorType: 'user',
          authorAgentId: null,
          content: 'Hello',
          createdAt: new Date().toISOString(),
        },
      });

      expect(sessionsService.getActiveSessionForAgent).toHaveBeenCalledWith('agent-1');
      expect(sessionsService.launchSession).not.toHaveBeenCalled();
      expect(messagePoolService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('skips enqueue when session launch fails', async () => {
      const { subscriber, sessionsService, messagePoolService } = buildSubscriber({
        hasActiveSession: false,
        launchSessionFails: true,
      });

      await subscriber.handleChatMessageCreated({
        threadId: 'thread-1',
        message: {
          id: 'message-1',
          threadId: 'thread-1',
          authorType: 'user',
          authorAgentId: null,
          content: 'Hello',
          createdAt: new Date().toISOString(),
        },
      });

      expect(sessionsService.getActiveSessionForAgent).toHaveBeenCalledWith('agent-1');
      expect(sessionsService.launchSession).toHaveBeenCalled();
      expect(messagePoolService.enqueue).not.toHaveBeenCalled();
    });

    it('continues to next recipient if launch fails for one agent', async () => {
      const { subscriber, sessionsService, messagePoolService, chatService, storage, tmuxService } =
        buildSubscriber({
          hasActiveSession: false,
        });

      // Set up thread with two members
      chatService.getThread.mockResolvedValue({
        id: 'thread-1',
        projectId: 'project-1',
        title: null,
        isGroup: true,
        createdByType: 'user',
        createdByUserId: null,
        createdByAgentId: null,
        members: ['agent-1', 'agent-2'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // First agent has no session and launch fails, second agent has active session
      sessionsService.getActiveSessionForAgent.mockImplementation((agentId: string) => {
        if (agentId === 'agent-2') {
          return {
            id: 'session-2',
            agentId: 'agent-2',
            tmuxSessionId: 'tmux-2',
            status: 'running',
          };
        }
        return null;
      });
      sessionsService.launchSession.mockRejectedValue(new Error('Launch failed for agent-1'));
      tmuxService.hasSession.mockResolvedValue(true);

      storage.getAgent.mockImplementation(async (id: string) => {
        if (id === 'agent-2') return { id: 'agent-2', name: 'Beta' };
        return { id: 'agent-1', name: 'Alpha' };
      });

      await subscriber.handleChatMessageCreated({
        threadId: 'thread-1',
        message: {
          id: 'message-1',
          threadId: 'thread-1',
          authorType: 'user',
          authorAgentId: null,
          content: 'Hello everyone',
          createdAt: new Date().toISOString(),
        },
      });

      // Should still enqueue for agent-2 even though agent-1 launch failed
      expect(messagePoolService.enqueue).toHaveBeenCalledTimes(1);
      expect(messagePoolService.enqueue).toHaveBeenCalledWith(
        'agent-2',
        expect.stringContaining('Hello everyone'),
        expect.any(Object),
      );
    });
  });

  describe('session liveness check', () => {
    it('verifies tmux session exists before skipping auto-launch', async () => {
      const { subscriber, tmuxService, sessionsService, messagePoolService } = buildSubscriber({
        hasActiveSession: true,
        tmuxSessionAlive: true,
      });

      await subscriber.handleChatMessageCreated({
        threadId: 'thread-1',
        message: {
          id: 'message-1',
          threadId: 'thread-1',
          authorType: 'user',
          authorAgentId: null,
          content: 'Hello',
          createdAt: new Date().toISOString(),
        },
      });

      // Should have checked tmux liveness
      expect(tmuxService.hasSession).toHaveBeenCalledWith('tmux-1');
      // Should NOT launch new session since tmux is alive
      expect(sessionsService.launchSession).not.toHaveBeenCalled();
      // Should enqueue message
      expect(messagePoolService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('auto-launches session when DB shows active but tmux is dead', async () => {
      const { subscriber, tmuxService, sessionsService, messagePoolService } = buildSubscriber({
        hasActiveSession: true,
        tmuxSessionAlive: false,
      });

      await subscriber.handleChatMessageCreated({
        threadId: 'thread-1',
        message: {
          id: 'message-1',
          threadId: 'thread-1',
          authorType: 'user',
          authorAgentId: null,
          content: 'Hello',
          createdAt: new Date().toISOString(),
        },
      });

      // Should have checked tmux liveness and found it dead
      expect(tmuxService.hasSession).toHaveBeenCalledWith('tmux-1');
      // Should launch new session since tmux was dead
      expect(sessionsService.launchSession).toHaveBeenCalledWith({
        agentId: 'agent-1',
        projectId: 'project-1',
        options: { silent: true },
      });
      // Should enqueue message
      expect(messagePoolService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('treats liveness check error as dead session and auto-launches', async () => {
      const { subscriber, tmuxService, sessionsService, messagePoolService } = buildSubscriber({
        hasActiveSession: true,
      });

      // Make liveness check throw
      tmuxService.hasSession.mockRejectedValue(new Error('tmux command failed'));

      await subscriber.handleChatMessageCreated({
        threadId: 'thread-1',
        message: {
          id: 'message-1',
          threadId: 'thread-1',
          authorType: 'user',
          authorAgentId: null,
          content: 'Hello',
          createdAt: new Date().toISOString(),
        },
      });

      // Should have tried liveness check
      expect(tmuxService.hasSession).toHaveBeenCalledWith('tmux-1');
      // Should launch new session since liveness check failed
      expect(sessionsService.launchSession).toHaveBeenCalledWith({
        agentId: 'agent-1',
        projectId: 'project-1',
        options: { silent: true },
      });
      // Should enqueue message
      expect(messagePoolService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('skips liveness check when DB shows no session', async () => {
      const { subscriber, tmuxService, sessionsService, messagePoolService } = buildSubscriber({
        hasActiveSession: false,
      });

      await subscriber.handleChatMessageCreated({
        threadId: 'thread-1',
        message: {
          id: 'message-1',
          threadId: 'thread-1',
          authorType: 'user',
          authorAgentId: null,
          content: 'Hello',
          createdAt: new Date().toISOString(),
        },
      });

      // Should NOT check tmux since DB already shows no session
      expect(tmuxService.hasSession).not.toHaveBeenCalled();
      // Should launch new session
      expect(sessionsService.launchSession).toHaveBeenCalled();
      // Should enqueue message
      expect(messagePoolService.enqueue).toHaveBeenCalledTimes(1);
    });
  });
});
