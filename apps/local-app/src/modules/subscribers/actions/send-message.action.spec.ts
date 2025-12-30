import { sendMessageAction } from './send-message.action';
import type { ActionContext } from './action.interface';

describe('SendMessageAction', () => {
  let mockContext: ActionContext;
  let mockMessagePoolService: {
    enqueue: jest.Mock;
  };
  let mockLogger: {
    info: jest.Mock;
    debug: jest.Mock;
    error: jest.Mock;
  };

  beforeEach(() => {
    mockMessagePoolService = {
      enqueue: jest.fn().mockResolvedValue({ status: 'queued', poolSize: 1 }),
    };

    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    };

    mockContext = {
      tmuxService: {} as ActionContext['tmuxService'],
      sessionsService: {} as ActionContext['sessionsService'],
      sessionCoordinator: {} as ActionContext['sessionCoordinator'],
      sendCoordinator: {} as ActionContext['sendCoordinator'],
      messagePoolService: mockMessagePoolService as unknown as ActionContext['messagePoolService'],
      storage: {} as ActionContext['storage'],
      sessionId: 'session-123',
      agentId: 'agent-456',
      projectId: 'project-789',
      tmuxSessionName: 'tmux-session-1',
      event: {
        eventName: 'terminal.watcher.triggered',
        projectId: 'project-789',
        agentId: 'agent-456',
        sessionId: 'session-123',
        occurredAt: new Date().toISOString(),
        payload: {
          watcherId: 'watcher-1',
          watcherName: 'Test Watcher',
          customEventName: 'test.event',
          sessionId: 'session-123',
          agentId: 'agent-456',
          agentName: 'Test Agent',
          projectId: 'project-789',
          viewportSnippet: 'test viewport',
          viewportHash: 'hash123',
          triggerCount: 1,
          triggeredAt: new Date().toISOString(),
        },
      },
      logger: mockLogger as unknown as ActionContext['logger'],
    };

    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('action definition', () => {
    it('should have correct type', () => {
      expect(sendMessageAction.type).toBe('send_agent_message');
    });

    it('should have correct category', () => {
      expect(sendMessageAction.category).toBe('terminal');
    });

    it('should have text input', () => {
      const textInput = sendMessageAction.inputs.find((i) => i.name === 'text');
      expect(textInput).toBeDefined();
      expect(textInput?.type).toBe('textarea');
      expect(textInput?.required).toBe(true);
    });

    it('should have submitKey input with options', () => {
      const submitKeyInput = sendMessageAction.inputs.find((i) => i.name === 'submitKey');
      expect(submitKeyInput).toBeDefined();
      expect(submitKeyInput?.type).toBe('select');
      expect(submitKeyInput?.defaultValue).toBe('Enter');
      expect(submitKeyInput?.options).toHaveLength(2);
    });

    it('should have submitKey as custom-only (no event_field mapping)', () => {
      const submitKeyInput = sendMessageAction.inputs.find((i) => i.name === 'submitKey');
      expect(submitKeyInput).toBeDefined();
      expect(submitKeyInput?.allowedSources).toEqual(['custom']);
    });

    it('should not have allowedSources restriction on text input', () => {
      const textInput = sendMessageAction.inputs.find((i) => i.name === 'text');
      expect(textInput).toBeDefined();
      // text input should allow all sources (undefined = default to both)
      expect(textInput?.allowedSources).toBeUndefined();
    });

    it('should have immediate checkbox input', () => {
      const immediateInput = sendMessageAction.inputs.find((i) => i.name === 'immediate');
      expect(immediateInput).toBeDefined();
      expect(immediateInput?.type).toBe('boolean');
      expect(immediateInput?.required).toBe(false);
      expect(immediateInput?.defaultValue).toBe(false);
      expect(immediateInput?.allowedSources).toEqual(['custom']);
    });
  });

  describe('execute', () => {
    it('should enqueue message with Enter key by default (pooled)', async () => {
      const inputs = { text: 'Hello, world!' };

      const result = await sendMessageAction.execute(mockContext, inputs);

      expect(result.success).toBe(true);
      expect(mockMessagePoolService.enqueue).toHaveBeenCalledWith('agent-456', 'Hello, world!', {
        source: 'subscriber.action',
        submitKeys: ['Enter'],
        immediate: false,
        projectId: 'project-789',
        agentName: 'Test Agent',
      });
      expect(result.data).toMatchObject({
        status: 'queued',
        immediate: false,
      });
    });

    it('should enqueue message without Enter when submitKey is none', async () => {
      const inputs = { text: 'Paste only', submitKey: 'none' };

      const result = await sendMessageAction.execute(mockContext, inputs);

      expect(result.success).toBe(true);
      expect(mockMessagePoolService.enqueue).toHaveBeenCalledWith('agent-456', 'Paste only', {
        source: 'subscriber.action',
        submitKeys: [],
        immediate: false,
        projectId: 'project-789',
        agentName: 'Test Agent',
      });
    });

    it('should deliver immediately when immediate flag is true', async () => {
      mockMessagePoolService.enqueue.mockResolvedValue({ status: 'delivered' });
      const inputs = { text: 'Urgent command', immediate: true };

      const result = await sendMessageAction.execute(mockContext, inputs);

      expect(result.success).toBe(true);
      expect(mockMessagePoolService.enqueue).toHaveBeenCalledWith('agent-456', 'Urgent command', {
        source: 'subscriber.action',
        submitKeys: ['Enter'],
        immediate: true,
        projectId: 'project-789',
        agentName: 'Test Agent',
      });
      expect(result.data).toMatchObject({
        status: 'delivered',
        immediate: true,
      });
    });

    it('should return error when text is empty', async () => {
      const inputs = { text: '' };

      const result = await sendMessageAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Text is required');
      expect(mockMessagePoolService.enqueue).not.toHaveBeenCalled();
    });

    it('should return error when text is whitespace only', async () => {
      const inputs = { text: '   ' };

      const result = await sendMessageAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Text is required');
    });

    it('should return error when agentId is not available', async () => {
      mockContext.agentId = null;
      const inputs = { text: 'Test message' };

      const result = await sendMessageAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No agent ID available');
    });

    it('should handle enqueue failure', async () => {
      mockMessagePoolService.enqueue.mockResolvedValue({
        status: 'failed',
        error: 'No active session',
      });
      const inputs = { text: 'Test message' };

      const result = await sendMessageAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to send message');
      expect(result.error).toContain('No active session');
    });

    it('should handle enqueue throwing error', async () => {
      mockMessagePoolService.enqueue.mockRejectedValue(new Error('Connection failed'));
      const inputs = { text: 'Test message' };

      const result = await sendMessageAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to send message');
      expect(result.error).toContain('Connection failed');
    });

    it('should return success data with correct fields', async () => {
      const inputs = { text: 'Test message', submitKey: 'Enter', immediate: false };

      const result = await sendMessageAction.execute(mockContext, inputs);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        sessionId: 'session-123',
        textLength: 12,
        submitKey: 'Enter',
        immediate: false,
        status: 'queued',
      });
    });

    it('should log successful execution with queued status', async () => {
      const inputs = { text: 'Test message' };

      await sendMessageAction.execute(mockContext, inputs);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-123',
          textLength: 12,
          status: 'queued',
        }),
        'Message enqueued to pool',
      );
    });

    it('should log successful execution with delivered status', async () => {
      mockMessagePoolService.enqueue.mockResolvedValue({ status: 'delivered' });
      const inputs = { text: 'Test message', immediate: true };

      await sendMessageAction.execute(mockContext, inputs);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-123',
          textLength: 12,
          status: 'delivered',
        }),
        'Message sent to terminal',
      );
    });

    it('should log errors on failure', async () => {
      mockMessagePoolService.enqueue.mockRejectedValue(new Error('Connection failed'));
      const inputs = { text: 'Test message' };

      await sendMessageAction.execute(mockContext, inputs);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-123' }),
        'Failed to send message',
      );
    });

    it('should set source to subscriber.action', async () => {
      const inputs = { text: 'Test' };

      await sendMessageAction.execute(mockContext, inputs);

      expect(mockMessagePoolService.enqueue).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ source: 'subscriber.action' }),
      );
    });
  });
});
