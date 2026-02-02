import { restartAgentAction, type RestartAgentResultData } from './restart-agent.action';
import type { ActionContext } from './action.interface';

describe('RestartAgentAction', () => {
  let mockContext: ActionContext;
  let mockSessionsService: {
    listActiveSessions: jest.Mock;
    terminateSession: jest.Mock;
    launchSession: jest.Mock;
  };
  let mockSessionCoordinator: {
    withAgentLock: jest.Mock;
  };
  let mockStorage: {
    getAgentByName: jest.Mock;
    getAgent: jest.Mock;
  };
  let mockLogger: {
    info: jest.Mock;
    debug: jest.Mock;
    error: jest.Mock;
  };

  beforeEach(() => {
    mockSessionsService = {
      listActiveSessions: jest.fn().mockResolvedValue([]),
      terminateSession: jest.fn().mockResolvedValue(undefined),
      launchSession: jest.fn().mockResolvedValue({ id: 'new-session-123' }),
    };

    mockSessionCoordinator = {
      withAgentLock: jest.fn().mockImplementation(async (_agentId, fn) => fn()),
    };

    mockStorage = {
      getAgentByName: jest.fn().mockResolvedValue({
        id: 'resolved-agent-id',
        name: 'Test Agent',
        projectId: 'project-789',
      }),
      getAgent: jest.fn().mockImplementation(async (id: string) => ({
        id,
        projectId: 'project-789',
      })),
    };

    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    };

    mockContext = {
      tmuxService: {} as ActionContext['tmuxService'],
      sessionsService: mockSessionsService as unknown as ActionContext['sessionsService'],
      sessionCoordinator: mockSessionCoordinator as unknown as ActionContext['sessionCoordinator'],
      sendCoordinator: {} as ActionContext['sendCoordinator'],
      messagePoolService: {} as ActionContext['messagePoolService'],
      storage: mockStorage as unknown as ActionContext['storage'],
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
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('action definition', () => {
    it('should have correct type', () => {
      expect(restartAgentAction.type).toBe('restart_agent');
    });

    it('should have correct category', () => {
      expect(restartAgentAction.category).toBe('session');
    });

    it('should have agentName input', () => {
      const agentNameInput = restartAgentAction.inputs.find((i) => i.name === 'agentName');
      expect(agentNameInput).toBeDefined();
      expect(agentNameInput?.type).toBe('string');
      expect(agentNameInput?.required).toBe(false);
    });

    it('should not define agentId input', () => {
      const agentIdInput = restartAgentAction.inputs.find((i) => i.name === 'agentId');
      expect(agentIdInput).toBeUndefined();
    });
  });

  describe('execute - agent resolution', () => {
    describe('resolution by agentName (highest priority)', () => {
      it('should resolve agent by name when agentName input is provided', async () => {
        const inputs = { agentName: 'MyAgent' };

        const result = await restartAgentAction.execute(mockContext, inputs);

        expect(mockStorage.getAgentByName).toHaveBeenCalledWith('project-789', 'MyAgent');
        expect(result.success).toBe(true);
        const data = result.data as RestartAgentResultData;
        expect(data.resolvedAgentId).toBe('resolved-agent-id');
        expect(data.resolvedBy).toBe('agentName');
      });

      it('should return error when agent name is not found', async () => {
        mockStorage.getAgentByName.mockRejectedValue(new Error('Agent not found'));
        const inputs = { agentName: 'NonExistentAgent' };

        const result = await restartAgentAction.execute(mockContext, inputs);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Agent not found');
        expect(result.error).toContain('NonExistentAgent');
      });

      it('should trim whitespace from agentName', async () => {
        const inputs = { agentName: '  MyAgent  ' };

        await restartAgentAction.execute(mockContext, inputs);

        expect(mockStorage.getAgentByName).toHaveBeenCalledWith('project-789', 'MyAgent');
      });
    });

    describe('legacy agentId input (ignored)', () => {
      it('should ignore agentId input and fall back to context agentId', async () => {
        const inputs = { agentId: 'direct-agent-id' };

        const result = await restartAgentAction.execute(mockContext, inputs);

        expect(mockStorage.getAgentByName).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        const data = result.data as RestartAgentResultData;
        expect(data.resolvedAgentId).toBe('agent-456');
        expect(data.resolvedBy).toBe('event');
      });
    });

    describe('resolution from event context (fallback)', () => {
      it('should use context agentId when no inputs provided', async () => {
        const inputs = {};

        const result = await restartAgentAction.execute(mockContext, inputs);

        expect(result.success).toBe(true);
        const data = result.data as RestartAgentResultData;
        expect(data.resolvedAgentId).toBe('agent-456');
        expect(data.resolvedBy).toBe('event');
      });

      it('should return error when no agent can be resolved', async () => {
        mockContext.agentId = null;
        const inputs = {};

        const result = await restartAgentAction.execute(mockContext, inputs);

        expect(result.success).toBe(false);
        expect(result.error).toContain('No agent specified');
      });
    });
  });

  describe('execute - restart behavior', () => {
    it('should not use outer withAgentLock (launchSession handles locking internally)', async () => {
      const inputs = {};

      await restartAgentAction.execute(mockContext, inputs);

      // Action no longer wraps with withAgentLock - launchSession() has internal locking
      // This prevents deadlock from nested non-reentrant locks
      expect(mockSessionCoordinator.withAgentLock).not.toHaveBeenCalled();
    });

    it('should terminate existing session if one exists', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([
        { id: 'existing-session', agentId: 'agent-456' },
      ]);
      const inputs = {};

      const result = await restartAgentAction.execute(mockContext, inputs);

      expect(mockSessionsService.terminateSession).toHaveBeenCalledWith('existing-session');
      expect(result.success).toBe(true);
      const data = result.data as RestartAgentResultData;
      expect(data.previousSessionId).toBe('existing-session');
    });

    it('should not terminate when no existing session', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([]);
      const inputs = {};

      const result = await restartAgentAction.execute(mockContext, inputs);

      expect(mockSessionsService.terminateSession).not.toHaveBeenCalled();
      const data = result.data as RestartAgentResultData;
      expect(data.previousSessionId).toBeUndefined();
    });

    it('should launch new independent session without epicId', async () => {
      const inputs = {};

      await restartAgentAction.execute(mockContext, inputs);

      expect(mockSessionsService.launchSession).toHaveBeenCalledWith({
        agentId: 'agent-456',
        projectId: 'project-789',
        // epicId intentionally omitted
      });
    });

    it('should return newSessionId from launched session', async () => {
      mockSessionsService.launchSession.mockResolvedValue({ id: 'brand-new-session' });
      const inputs = {};

      const result = await restartAgentAction.execute(mockContext, inputs);

      const data = result.data as RestartAgentResultData;
      expect(data.newSessionId).toBe('brand-new-session');
    });
  });

  describe('execute - error handling', () => {
    it('should handle listActiveSessions errors', async () => {
      mockSessionsService.listActiveSessions.mockRejectedValue(new Error('DB connection lost'));
      const inputs = {};

      const result = await restartAgentAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to restart agent');
      expect(result.error).toContain('DB connection lost');
    });

    it('should handle terminateSession errors', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([
        { id: 'existing-session', agentId: 'agent-456' },
      ]);
      mockSessionsService.terminateSession.mockRejectedValue(new Error('Cannot terminate'));
      const inputs = {};

      const result = await restartAgentAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to restart agent');
    });

    it('should handle launchSession errors', async () => {
      mockSessionsService.launchSession.mockRejectedValue(new Error('Failed to launch'));
      const inputs = {};

      const result = await restartAgentAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to restart agent');
      expect(result.error).toContain('Failed to launch');
    });

    it('should log errors on failure', async () => {
      mockSessionsService.launchSession.mockRejectedValue(new Error('Launch failed'));
      const inputs = {};

      await restartAgentAction.execute(mockContext, inputs);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Launch failed' }),
        'Failed to restart agent',
      );
    });
  });

  describe('execute - result structure', () => {
    it('should return success with message when session was terminated', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([
        { id: 'old-session', agentId: 'agent-456' },
      ]);
      mockSessionsService.launchSession.mockResolvedValue({ id: 'new-session' });
      const inputs = {};

      const result = await restartAgentAction.execute(mockContext, inputs);

      expect(result.success).toBe(true);
      expect(result.message).toContain('terminated session old-session');
      expect(result.message).toContain('launched new-session');
    });

    it('should return success with message when no previous session', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([]);
      mockSessionsService.launchSession.mockResolvedValue({ id: 'new-session' });
      const inputs = {};

      const result = await restartAgentAction.execute(mockContext, inputs);

      expect(result.success).toBe(true);
      expect(result.message).toContain('launched session new-session');
      expect(result.message).not.toContain('terminated');
    });

    it('should return complete result data structure', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([
        { id: 'prev-session', agentId: 'agent-456' },
      ]);
      mockSessionsService.launchSession.mockResolvedValue({ id: 'new-session' });
      const inputs = {};

      const result = await restartAgentAction.execute(mockContext, inputs);

      const data = result.data as RestartAgentResultData;
      expect(data).toEqual({
        resolvedAgentId: 'agent-456',
        previousSessionId: 'prev-session',
        newSessionId: 'new-session',
        resolvedBy: 'event',
      });
    });

    it('should log successful restart', async () => {
      mockSessionsService.launchSession.mockResolvedValue({ id: 'new-session-id' });
      const inputs = {};

      await restartAgentAction.execute(mockContext, inputs);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          resolvedAgentId: 'agent-456',
          newSessionId: 'new-session-id',
          resolvedBy: 'event',
        }),
        'Agent restarted successfully',
      );
    });
  });

  describe('execute - edge cases', () => {
    it('should only terminate session for the target agent', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([
        { id: 'session-other', agentId: 'other-agent' },
        { id: 'session-target', agentId: 'agent-456' },
        { id: 'session-another', agentId: 'another-agent' },
      ]);
      const inputs = {};

      await restartAgentAction.execute(mockContext, inputs);

      expect(mockSessionsService.terminateSession).toHaveBeenCalledTimes(1);
      expect(mockSessionsService.terminateSession).toHaveBeenCalledWith('session-target');
    });

    it('should handle empty agentName input', async () => {
      const inputs = { agentName: '' };

      const result = await restartAgentAction.execute(mockContext, inputs);

      // Falls back to context agentId
      expect(result.success).toBe(true);
      const data = result.data as RestartAgentResultData;
      expect(data.resolvedBy).toBe('event');
    });

    it('should handle whitespace-only agentName input', async () => {
      const inputs = { agentName: '   ' };

      const result = await restartAgentAction.execute(mockContext, inputs);

      // Falls back to context agentId since trimmed string is empty
      expect(result.success).toBe(true);
      const data = result.data as RestartAgentResultData;
      expect(data.resolvedBy).toBe('event');
    });
  });

  describe('execute - project safety', () => {
    it('should refuse cross-project target from event context', async () => {
      mockContext.agentId = 'foreign-agent';
      mockStorage.getAgent.mockResolvedValue({ id: 'foreign-agent', projectId: 'other-project' });
      const inputs = {};

      const result = await restartAgentAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Refusing to restart agent from a different project');
      expect(mockSessionsService.terminateSession).not.toHaveBeenCalled();
      expect(mockSessionsService.launchSession).not.toHaveBeenCalled();
    });
  });
});
