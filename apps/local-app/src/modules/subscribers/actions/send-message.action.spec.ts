import { sendMessageAction } from './send-message.action';
import type { ActionContext } from './action.interface';

describe('SendMessageAction', () => {
  let mockContext: ActionContext;
  let mockAmd: {
    deliver: jest.Mock;
  };
  let mockStorage: {
    getAgentByName: jest.Mock;
  };
  let mockLogger: {
    info: jest.Mock;
    debug: jest.Mock;
    error: jest.Mock;
  };

  beforeEach(() => {
    mockAmd = {
      deliver: jest.fn().mockResolvedValue({
        status: 'queued',
        results: [{ agentId: 'agent-456', status: 'queued' }],
      }),
    };

    mockStorage = {
      getAgentByName: jest.fn().mockResolvedValue({
        id: 'resolved-agent-id',
        name: 'Planner',
        projectId: 'project-789',
      }),
    };

    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    };

    mockContext = {
      terminalIO: {} as ActionContext['terminalIO'],
      sessionsService: {} as ActionContext['sessionsService'],
      sessionRuntime: {} as ActionContext['sessionRuntime'],
      sessionCoordinator: {} as ActionContext['sessionCoordinator'],
      amd: mockAmd as unknown as ActionContext['amd'],
      storage: mockStorage as unknown as ActionContext['storage'],
      teamsService: {} as ActionContext['teamsService'],
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

    it.each([
      {
        name: 'text type',
        inputName: 'text',
        expected: { type: 'textarea', required: true },
        optionsLength: undefined,
        allowedOnly: false,
      },
      {
        name: 'optional agent override',
        inputName: 'agentName',
        expected: { type: 'string', required: false },
        optionsLength: undefined,
        allowedOnly: false,
      },
      {
        name: 'submit key options',
        inputName: 'submitKey',
        expected: { defaultValue: 'Enter' },
        optionsLength: 2,
        allowedOnly: false,
      },
      {
        name: 'custom-only submit key',
        inputName: 'submitKey',
        expected: { allowedSources: ['custom'] },
        optionsLength: undefined,
        allowedOnly: false,
      },
      {
        name: 'delivery mode',
        inputName: 'deliveryMode',
        expected: {
          type: 'select',
          required: false,
          defaultValue: 'default',
          allowedSources: ['custom'],
          options: [
            { value: 'default', label: 'Default (queue)' },
            { value: 'immediate', label: 'Deliver Immediately' },
            { value: 'on_idle', label: 'Delivery on Idle' },
          ],
        },
        optionsLength: undefined,
        allowedOnly: false,
      },
      {
        name: 'text sources',
        inputName: 'text',
        expected: {},
        optionsLength: undefined,
        allowedOnly: true,
      },
    ])('declares $name', ({ inputName, expected, optionsLength, allowedOnly }) => {
      const input = sendMessageAction.inputs.find((i) => i.name === inputName);
      expect(input).toBeDefined();
      expect(input).toMatchObject(expected);
      if (optionsLength !== undefined) expect(input?.options).toHaveLength(optionsLength);
      if (allowedOnly) expect(input?.allowedSources).toBeUndefined();
      if (inputName === 'deliveryMode')
        expect(sendMessageAction.inputs.find((i) => i.name === 'immediate')).toBeUndefined();
    });
  });

  describe('execute', () => {
    it('should resolve a named recipient within the event project', async () => {
      const result = await sendMessageAction.execute(mockContext, {
        agentName: '  Planner  ',
        text: 'Epic completed',
      });

      expect(mockStorage.getAgentByName).toHaveBeenCalledWith('project-789', 'Planner');
      expect(mockAmd.deliver).toHaveBeenCalledWith(
        ['resolved-agent-id'],
        expect.objectContaining({ body: 'Epic completed', projectId: 'project-789' }),
        expect.any(Object),
      );
      expect(result).toMatchObject({
        success: true,
        data: {
          resolvedAgentId: 'resolved-agent-id',
          resolvedBy: 'agentName',
        },
      });
    });

    it.each([
      { name: 'bound text', fields: ['text'], text: 'Imported task title', outsideText: true },
      { name: 'custom text', fields: ['agentName'], text: 'Epic completed', outsideText: false },
    ])('marks $name outside text appropriately', async ({ fields, text, outsideText }) => {
      mockContext.eventFieldInputs = new Set(fields);
      await sendMessageAction.execute(mockContext, { text });
      expect(mockAmd.deliver).toHaveBeenCalledWith(
        ['agent-456'],
        expect.objectContaining({ outsideText }),
        expect.any(Object),
      );
    });

    it('should fail when the named recipient does not exist in the project', async () => {
      mockStorage.getAgentByName.mockRejectedValue(new Error('Agent not found'));

      const result = await sendMessageAction.execute(mockContext, {
        agentName: 'Missing Agent',
        text: 'Epic completed',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent not found: "Missing Agent" in project project-789');
      expect(mockAmd.deliver).not.toHaveBeenCalled();
    });

    it('should reject a named recipient resolved outside the event project', async () => {
      mockStorage.getAgentByName.mockResolvedValue({
        id: 'foreign-agent-id',
        name: 'Planner',
        projectId: 'another-project',
      });

      const result = await sendMessageAction.execute(mockContext, {
        agentName: 'Planner',
        text: 'Epic completed',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Refusing to message agent from a different project');
      expect(mockAmd.deliver).not.toHaveBeenCalled();
    });

    it('should deliver message with Enter key by default (pooled)', async () => {
      const inputs = { text: 'Hello, world!' };

      const result = await sendMessageAction.execute(mockContext, inputs);

      expect(result.success).toBe(true);
      expect(mockAmd.deliver).toHaveBeenCalledWith(
        ['agent-456'],
        {
          kind: 'pooled',
          body: 'Hello, world!',
          source: 'subscriber.action',
          projectId: 'project-789',
          senderName: 'Test Agent',
          outsideText: false,
        },
        {
          submitKeys: ['Enter'],
          deliveryMode: 'default',
        },
      );
      expect(result.data).toMatchObject({
        status: 'queued',
        deliveryMode: 'default',
      });
    });

    it('should deliver message without Enter when submitKey is none', async () => {
      const inputs = { text: 'Paste only', submitKey: 'none' };

      const result = await sendMessageAction.execute(mockContext, inputs);

      expect(result.success).toBe(true);
      expect(mockAmd.deliver).toHaveBeenCalledWith(
        ['agent-456'],
        expect.objectContaining({
          body: 'Paste only',
          source: 'subscriber.action',
          projectId: 'project-789',
        }),
        {
          submitKeys: [],
          deliveryMode: 'default',
        },
      );
    });

    it('should honor an explicit delivery mode', async () => {
      mockAmd.deliver.mockResolvedValue({
        status: 'queued',
        results: [{ agentId: 'agent-456', status: 'queued' }],
      });
      const inputs = { text: 'Wait for idle', deliveryMode: 'on_idle' };

      const result = await sendMessageAction.execute(mockContext, inputs);

      expect(result.success).toBe(true);
      expect(mockAmd.deliver).toHaveBeenCalledWith(
        ['agent-456'],
        expect.objectContaining({
          body: 'Wait for idle',
          source: 'subscriber.action',
          projectId: 'project-789',
        }),
        {
          submitKeys: ['Enter'],
          deliveryMode: 'on_idle',
        },
      );
      expect(result.data).toMatchObject({
        status: 'queued',
        deliveryMode: 'on_idle',
      });
    });

    it.each([true, 'true'])('converts the legacy immediate value %p', async (immediate) => {
      await sendMessageAction.execute(mockContext, { text: 'Urgent command', immediate });

      expect(mockAmd.deliver).toHaveBeenCalledWith(['agent-456'], expect.any(Object), {
        submitKeys: ['Enter'],
        deliveryMode: 'immediate',
      });
    });

    it.each([false])('converts the legacy non-immediate value %p to default', async (immediate) => {
      await sendMessageAction.execute(mockContext, { text: 'Normal message', immediate });

      expect(mockAmd.deliver).toHaveBeenCalledWith(['agent-456'], expect.any(Object), {
        submitKeys: ['Enter'],
        deliveryMode: 'default',
      });
    });

    it('prefers a valid explicit delivery mode over a legacy immediate value', async () => {
      await sendMessageAction.execute(mockContext, {
        text: 'Wait for idle',
        deliveryMode: 'on_idle',
        immediate: true,
      });

      expect(mockAmd.deliver).toHaveBeenCalledWith(['agent-456'], expect.any(Object), {
        submitKeys: ['Enter'],
        deliveryMode: 'on_idle',
      });
    });

    it('rejects an unsupported explicit delivery mode', async () => {
      const result = await sendMessageAction.execute(mockContext, {
        text: 'Invalid mode',
        deliveryMode: 'eventually',
        immediate: true,
      });

      expect(result).toEqual({
        success: false,
        error: 'Unsupported delivery mode: eventually',
      });
      expect(mockAmd.deliver).not.toHaveBeenCalled();
    });

    it('should return error when text is empty', async () => {
      const inputs = { text: '' };

      const result = await sendMessageAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Text is required');
      expect(mockAmd.deliver).not.toHaveBeenCalled();
    });

    it('should return an actionable error when no recipient is available', async () => {
      mockContext.agentId = null;
      const inputs = { text: 'Test message' };

      const result = await sendMessageAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'No recipient specified: provide agentName input, or trigger from an event with agentId',
      );
    });

    it('should handle delivery failure', async () => {
      mockAmd.deliver.mockResolvedValue({
        status: 'failed',
        results: [{ agentId: 'agent-456', status: 'failed', error: 'No active session' }],
      });
      const inputs = { text: 'Test message' };

      const result = await sendMessageAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to send message');
      expect(result.error).toContain('No active session');
    });

    it('should handle delivery throwing error', async () => {
      mockAmd.deliver.mockRejectedValue(new Error('Connection failed'));
      const inputs = { text: 'Test message' };

      const result = await sendMessageAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to send message');
      expect(result.error).toContain('Connection failed');
    });

    it('should return success data with correct fields', async () => {
      const inputs = { text: 'Test message', submitKey: 'Enter', deliveryMode: 'default' };

      const result = await sendMessageAction.execute(mockContext, inputs);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        sessionId: 'session-123',
        resolvedAgentId: 'agent-456',
        resolvedBy: 'event',
        textLength: 12,
        submitKey: 'Enter',
        deliveryMode: 'default',
        status: 'queued',
      });
    });
  });
});
