import { ForbiddenError, NotFoundError } from '../../../common/errors/error-types';
import {
  terminateSessionAction,
  type TerminateSessionFamilyResultData,
  type TerminateSessionResultData,
} from './terminate-session.action';
import type { ActionContext } from './action.interface';
import type { SessionDto } from '../../sessions/dtos/sessions.dto';
import type { Status } from '../../storage/models/domain.models';

const PROJECT_ID = 'project-789';

function makeStatus(id: string, label: string): Status {
  return {
    id,
    projectId: PROJECT_ID,
    label,
    color: '#123456',
    position: 1,
    mcpHidden: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeSession(overrides: Partial<SessionDto> = {}): SessionDto {
  return {
    id: 'session-123',
    epicId: null,
    agentId: 'agent-456',
    tmuxSessionId: 'tmux-session-1',
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('TerminateSessionAction', () => {
  let mockContext: ActionContext;
  let mockSessionsService: {
    getActiveSessionForAgent: jest.Mock;
    listActiveSessions: jest.Mock;
    validateSessionInProject: jest.Mock;
    terminateSession: jest.Mock;
  };
  let mockStorage: {
    getAgentByName: jest.Mock;
    listAgentProfiles: jest.Mock;
    listAgents: jest.Mock;
    listStatuses: jest.Mock;
    listProjectEpics: jest.Mock;
  };
  let mockLogger: {
    info: jest.Mock;
    debug: jest.Mock;
    error: jest.Mock;
  };

  beforeEach(() => {
    mockSessionsService = {
      getActiveSessionForAgent: jest
        .fn()
        .mockReturnValue(makeSession({ id: 'named-session', agentId: 'resolved-agent-id' })),
      listActiveSessions: jest.fn().mockResolvedValue([]),
      validateSessionInProject: jest
        .fn()
        .mockResolvedValue(makeSession({ id: 'session-123', status: 'running' })),
      terminateSession: jest.fn().mockResolvedValue(undefined),
    };

    mockStorage = {
      getAgentByName: jest.fn().mockResolvedValue({
        id: 'resolved-agent-id',
        name: 'Test Agent',
        projectId: 'project-789',
      }),
      listAgentProfiles: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      listAgents: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      listStatuses: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      listProjectEpics: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    };

    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    };

    mockContext = {
      terminalIO: {} as ActionContext['terminalIO'],
      sessionsService: mockSessionsService as unknown as ActionContext['sessionsService'],
      sessionRuntime: {} as ActionContext['sessionRuntime'],
      sessionCoordinator: {} as ActionContext['sessionCoordinator'],
      amd: {} as ActionContext['amd'],
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
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('action definition', () => {
    it('should have correct type', () => {
      expect(terminateSessionAction.type).toBe('terminate_session');
    });

    it('should have correct display name', () => {
      expect(terminateSessionAction.name).toBe('Terminate Session');
    });

    it('should have correct category', () => {
      expect(terminateSessionAction.category).toBe('session');
    });

    it('should expose Agent Name before Profile Family Slug with family policy copy', () => {
      expect(terminateSessionAction.inputs).toHaveLength(3);
      const agentNameInput = terminateSessionAction.inputs.find((i) => i.name === 'agentName');
      const familySlugInput = terminateSessionAction.inputs.find((i) => i.name === 'familySlug');
      const guardInput = terminateSessionAction.inputs.find(
        (i) => i.name === 'skipWhileEpicsInStatuses',
      );
      expect(agentNameInput).toBeDefined();
      expect(agentNameInput?.type).toBe('string');
      expect(agentNameInput?.required).toBe(false);
      expect(agentNameInput?.label).toBe('Agent Name (Override)');
      expect(terminateSessionAction.inputs.map((input) => input.name)).toEqual([
        'agentName',
        'familySlug',
        'skipWhileEpicsInStatuses',
      ]);
      expect(familySlugInput).toMatchObject({
        label: 'Profile Family Slug',
        type: 'string',
        required: false,
      });
      expect(familySlugInput?.description).toContain('Inactive agents are reported, not failed');
      expect(familySlugInput?.description).toContain(
        'Family failures are not automatically retried, even when Retry on error is enabled.',
      );
      expect(guardInput).toMatchObject({
        label: 'Skip while epics are in statuses',
        type: 'select',
        multiple: true,
        optionsSource: 'project_statuses',
        allowedSources: ['custom'],
        required: false,
      });
    });

    it('should not disable subscriber retry', () => {
      expect(terminateSessionAction.supportsRetry).toBeUndefined();
    });
  });

  describe('execute - status guard', () => {
    function mockBlockingGuard(): void {
      mockStorage.listStatuses.mockResolvedValue({
        items: [makeStatus('status-ip', 'In Progress'), makeStatus('status-review', 'Review')],
        total: 2,
      });
      mockStorage.listProjectEpics.mockImplementation(
        (_projectId: string, options: { statusId: string }) =>
          Promise.resolve({ items: [], total: options.statusId === 'status-ip' ? 2 : 1 }),
      );
    }

    it('skips with success before resolving the agentName path', async () => {
      mockBlockingGuard();

      const result = await terminateSessionAction.execute(mockContext, {
        agentName: 'MyAgent',
        skipWhileEpicsInStatuses: 'In Progress, Review',
      });

      expect(result).toMatchObject({
        success: true,
        retryable: false,
        message: 'Skipped: 3 epic(s) still in In Progress, Review',
        data: {
          skipped: true,
          blocking: [
            { statusId: 'status-ip', label: 'In Progress', count: 2 },
            { statusId: 'status-review', label: 'Review', count: 1 },
          ],
        },
      });
      expect(mockStorage.getAgentByName).not.toHaveBeenCalled();
      expect(mockSessionsService.terminateSession).not.toHaveBeenCalled();
    });

    it('skips with success before resolving the familySlug path', async () => {
      mockBlockingGuard();

      const result = await terminateSessionAction.execute(mockContext, {
        familySlug: 'engineering',
        skipWhileEpicsInStatuses: 'In Progress',
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe('Skipped: 2 epic(s) still in In Progress');
      expect(mockStorage.listAgentProfiles).not.toHaveBeenCalled();
      expect(mockStorage.listAgents).not.toHaveBeenCalled();
      expect(mockSessionsService.terminateSession).not.toHaveBeenCalled();
    });

    it('skips with success before resolving the event path', async () => {
      mockBlockingGuard();

      const result = await terminateSessionAction.execute(mockContext, {
        skipWhileEpicsInStatuses: 'Review',
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe('Skipped: 1 epic(s) still in Review');
      expect(mockSessionsService.validateSessionInProject).not.toHaveBeenCalled();
      expect(mockSessionsService.terminateSession).not.toHaveBeenCalled();
    });

    it('fails closed without mutation when a label matches no status', async () => {
      mockStorage.listStatuses.mockResolvedValue({
        items: [makeStatus('status-review', 'Review')],
        total: 1,
      });

      const result = await terminateSessionAction.execute(mockContext, {
        agentName: 'MyAgent',
        skipWhileEpicsInStatuses: 'Review, Missing',
      });

      expect(result).toMatchObject({ success: false, retryable: false });
      expect(result.error).toContain(
        `Unknown status label(s) in project ${PROJECT_ID}: Missing. Nothing changed.`,
      );
      expect(mockStorage.listProjectEpics).not.toHaveBeenCalled();
      expect(mockStorage.getAgentByName).not.toHaveBeenCalled();
      expect(mockSessionsService.validateSessionInProject).not.toHaveBeenCalled();
      expect(mockSessionsService.terminateSession).not.toHaveBeenCalled();
    });

    it('ignores the guard when the input is absent or empty', async () => {
      for (const inputs of [
        {},
        { skipWhileEpicsInStatuses: '' },
        { skipWhileEpicsInStatuses: ' ' },
      ]) {
        const result = await terminateSessionAction.execute(mockContext, inputs);

        expect(result.success).toBe(true);
        expect((result.data as TerminateSessionResultData).resolvedBy).toBe('event');
      }
      expect(mockStorage.listStatuses).not.toHaveBeenCalled();
      expect(mockStorage.listProjectEpics).not.toHaveBeenCalled();
      expect(mockSessionsService.terminateSession).toHaveBeenCalledTimes(3);
    });
  });

  describe('execute - target resolution by agentName', () => {
    it('should resolve the named agent and terminate its active session', async () => {
      const inputs = { agentName: 'MyAgent' };

      const result = await terminateSessionAction.execute(mockContext, inputs);

      expect(mockStorage.getAgentByName).toHaveBeenCalledWith('project-789', 'MyAgent');
      expect(mockSessionsService.getActiveSessionForAgent).toHaveBeenCalledWith(
        'resolved-agent-id',
      );
      expect(mockSessionsService.validateSessionInProject).not.toHaveBeenCalled();
      expect(mockSessionsService.terminateSession).toHaveBeenCalledWith('named-session', {
        source: 'subscriber',
        reason: 'user-requested',
      });
      expect(result.success).toBe(true);
      const data = result.data as TerminateSessionResultData;
      expect(data).toEqual({
        resolvedBy: 'agentName',
        sessionId: 'named-session',
        resolvedAgentId: 'resolved-agent-id',
        previousStatus: 'running',
      });
    });

    it('should trim whitespace from agentName', async () => {
      const inputs = { agentName: '  MyAgent  ' };

      await terminateSessionAction.execute(mockContext, inputs);

      expect(mockStorage.getAgentByName).toHaveBeenCalledWith('project-789', 'MyAgent');
    });

    it('should prefer agentName over familySlug', async () => {
      await terminateSessionAction.execute(mockContext, {
        agentName: 'MyAgent',
        familySlug: 'engineering',
      });

      expect(mockStorage.getAgentByName).toHaveBeenCalledWith('project-789', 'MyAgent');
      expect(mockStorage.listAgentProfiles).not.toHaveBeenCalled();
    });

    it('should return a distinct error when the agent does not exist', async () => {
      mockStorage.getAgentByName.mockRejectedValue(new Error('Agent not found'));
      const inputs = { agentName: 'NonExistentAgent' };

      const result = await terminateSessionAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Agent not found');
      expect(result.error).toContain('NonExistentAgent');
      expect(result.error).not.toContain('no active session');
      expect(mockSessionsService.terminateSession).not.toHaveBeenCalled();
    });

    it('should return a distinct error when the agent has no active session', async () => {
      mockSessionsService.getActiveSessionForAgent.mockReturnValue(null);
      const inputs = { agentName: 'IdleAgent' };

      const result = await terminateSessionAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('no active session');
      expect(result.error).toContain('IdleAgent');
      expect(result.error).not.toContain('Agent not found');
      expect(mockSessionsService.terminateSession).not.toHaveBeenCalled();
    });

    it('should refuse an agent resolved outside the project', async () => {
      mockStorage.getAgentByName.mockResolvedValue({
        id: 'foreign-agent',
        name: 'Foreign Agent',
        projectId: 'other-project',
      });
      const inputs = { agentName: 'ForeignAgent' };

      const result = await terminateSessionAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        'Refusing to terminate session of agent from a different project',
      );
      expect(mockSessionsService.getActiveSessionForAgent).not.toHaveBeenCalled();
      expect(mockSessionsService.terminateSession).not.toHaveBeenCalled();
    });

    it('should terminate an owner-flagged agent session without a role guard', async () => {
      mockStorage.getAgentByName.mockResolvedValue({
        id: 'owner-agent',
        name: 'Owner Agent',
        projectId: 'project-789',
        isProjectOwner: true,
      });
      mockSessionsService.getActiveSessionForAgent.mockReturnValue(
        makeSession({ id: 'owner-session', agentId: 'owner-agent' }),
      );
      const inputs = { agentName: 'Owner Agent' };

      const result = await terminateSessionAction.execute(mockContext, inputs);

      expect(result.success).toBe(true);
      expect(mockSessionsService.terminateSession).toHaveBeenCalledWith('owner-session', {
        source: 'subscriber',
        reason: 'user-requested',
      });
      const data = result.data as TerminateSessionResultData;
      expect(data.resolvedAgentId).toBe('owner-agent');
    });
  });

  describe('execute - target resolution by familySlug', () => {
    beforeEach(() => {
      mockStorage.listAgentProfiles.mockResolvedValue({
        items: [
          { id: 'profile-upper', familySlug: ' Engineering ' },
          { id: 'profile-lower', familySlug: 'engineering' },
          { id: 'profile-other', familySlug: 'other' },
        ],
        total: 3,
      });
      mockStorage.listAgents.mockResolvedValue({
        items: [
          { id: 'agent-b', name: 'beta', profileId: 'profile-upper' },
          { id: 'agent-a', name: 'Alpha', profileId: 'profile-lower', isProjectOwner: true },
          { id: 'agent-x', name: 'Excluded', profileId: 'profile-other' },
        ],
        total: 3,
      });
    });

    it('should use the shared project-scoped resolver and terminate deterministic targets', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([
        makeSession({ id: 'session-b', agentId: 'agent-b' }),
        makeSession({ id: 'session-a', agentId: 'agent-a' }),
      ]);

      const result = await terminateSessionAction.execute(mockContext, {
        familySlug: ' ENGINEERING ',
      });

      expect(mockStorage.listAgentProfiles).toHaveBeenCalledWith({
        projectId: 'project-789',
        limit: 10_000,
        offset: 0,
      });
      expect(mockStorage.listAgents).toHaveBeenCalledWith('project-789', {
        limit: 10_000,
        offset: 0,
      });
      expect(mockSessionsService.listActiveSessions).toHaveBeenCalledTimes(1);
      expect(mockSessionsService.listActiveSessions).toHaveBeenCalledWith(
        'project-789',
        new Set(['agent-a', 'agent-b']),
      );
      expect(mockSessionsService.terminateSession.mock.calls).toEqual([
        ['session-a', { source: 'subscriber', reason: 'user-requested' }],
        ['session-b', { source: 'subscriber', reason: 'user-requested' }],
      ]);
      expect(result.success).toBe(true);
      expect(result.retryable).toBe(false);
      expect(result.data).toMatchObject({
        resolvedBy: 'familySlug',
        matched: [
          { id: 'agent-a', name: 'Alpha' },
          { id: 'agent-b', name: 'beta' },
        ],
        inactive: [],
        failed: [],
      });
    });

    it('should succeed as a convergent no-op and persist inactive names and IDs', async () => {
      const result = await terminateSessionAction.execute(mockContext, {
        familySlug: 'engineering',
      });

      expect(result.success).toBe(true);
      expect(mockSessionsService.terminateSession).not.toHaveBeenCalled();
      const data = result.data as TerminateSessionFamilyResultData;
      expect(data.terminated).toEqual([]);
      expect(data.inactive).toEqual([
        { id: 'agent-a', name: 'Alpha' },
        { id: 'agent-b', name: 'beta' },
      ]);
      expect(result.message).toContain('"Alpha" [agent-a]');
      expect(result.message).toContain('"beta" [agent-b]');
    });

    it('should continue after a failure and preserve successful terminations', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([
        makeSession({ id: 'session-a', agentId: 'agent-a' }),
        makeSession({ id: 'session-b', agentId: 'agent-b' }),
      ]);
      mockSessionsService.terminateSession
        .mockRejectedValueOnce(new Error('tmux failed'))
        .mockResolvedValueOnce(undefined);

      const result = await terminateSessionAction.execute(mockContext, {
        familySlug: 'engineering',
      });

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(false);
      expect(mockSessionsService.terminateSession).toHaveBeenCalledTimes(2);
      const data = result.data as TerminateSessionFamilyResultData;
      expect(data.terminated).toEqual([
        expect.objectContaining({ id: 'agent-b', sessionId: 'session-b' }),
      ]);
      expect(data.failed).toEqual([
        expect.objectContaining({
          id: 'agent-a',
          sessionId: 'session-a',
          error: 'tmux failed',
        }),
      ]);
    });

    it('should make no-match and helper failures non-retryable', async () => {
      mockStorage.listAgentProfiles.mockResolvedValueOnce({ items: [], total: 0 });
      const noMatch = await terminateSessionAction.execute(mockContext, {
        familySlug: 'missing',
      });
      expect(noMatch).toMatchObject({ success: false, retryable: false });

      mockStorage.listAgentProfiles.mockRejectedValueOnce(new Error('profile query failed'));
      const helperFailure = await terminateSessionAction.execute(mockContext, {
        familySlug: 'engineering',
      });
      expect(helperFailure).toMatchObject({ success: false, retryable: false });
      expect(helperFailure.error).toContain('profile query failed');
    });
  });

  describe('execute - target resolution from event context', () => {
    it('should validate and terminate the event session when agentName is absent', async () => {
      const inputs = {};

      const result = await terminateSessionAction.execute(mockContext, inputs);

      expect(mockStorage.getAgentByName).not.toHaveBeenCalled();
      expect(mockSessionsService.validateSessionInProject).toHaveBeenCalledWith(
        'session-123',
        'project-789',
      );
      expect(mockSessionsService.terminateSession).toHaveBeenCalledWith('session-123', {
        source: 'subscriber',
        reason: 'user-requested',
      });
      expect(result.success).toBe(true);
      const data = result.data as TerminateSessionResultData;
      expect(data).toEqual({
        resolvedBy: 'event',
        sessionId: 'session-123',
        resolvedAgentId: 'agent-456',
        previousStatus: 'running',
      });
    });

    it('should select the event session for blank agentName', async () => {
      const inputs = { agentName: '' };

      const result = await terminateSessionAction.execute(mockContext, inputs);

      expect(mockStorage.getAgentByName).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect((result.data as TerminateSessionResultData).resolvedBy).toBe('event');
    });

    it('should select the event session for whitespace-only agentName', async () => {
      const inputs = { agentName: '   ' };

      const result = await terminateSessionAction.execute(mockContext, inputs);

      expect(mockStorage.getAgentByName).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect((result.data as TerminateSessionResultData).resolvedBy).toBe('event');
    });

    it('should select the event session when both selectors are whitespace-only', async () => {
      const result = await terminateSessionAction.execute(mockContext, {
        agentName: '   ',
        familySlug: '   ',
      });

      expect(mockStorage.listAgentProfiles).not.toHaveBeenCalled();
      expect(mockSessionsService.validateSessionInProject).toHaveBeenCalledWith(
        'session-123',
        'project-789',
      );
      expect((result.data as TerminateSessionResultData).resolvedBy).toBe('event');
    });

    it('should reject a missing event session', async () => {
      mockSessionsService.validateSessionInProject.mockRejectedValue(
        new NotFoundError('Session', 'session-123'),
      );
      const inputs = {};

      const result = await terminateSessionAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Event session rejected');
      expect(result.error).toContain('not found');
      expect(mockSessionsService.terminateSession).not.toHaveBeenCalled();
    });

    it('should reject a session outside the project', async () => {
      mockSessionsService.validateSessionInProject.mockRejectedValue(
        new ForbiddenError('PROJECT_MISMATCH', { code: 'SESSION_PROJECT_MISMATCH' }),
      );
      const inputs = {};

      const result = await terminateSessionAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Event session rejected');
      expect(result.error).toContain('PROJECT_MISMATCH');
      expect(mockSessionsService.terminateSession).not.toHaveBeenCalled();
    });

    it('should reject when the event context has no sessionId', async () => {
      mockContext.sessionId = '';
      const inputs = {};

      const result = await terminateSessionAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No session to terminate');
      expect(mockSessionsService.validateSessionInProject).not.toHaveBeenCalled();
      expect(mockSessionsService.terminateSession).not.toHaveBeenCalled();
    });

    it('should still terminate and succeed when the event session is already stopped', async () => {
      mockSessionsService.validateSessionInProject.mockResolvedValue(
        makeSession({ id: 'session-123', status: 'stopped' }),
      );
      const inputs = {};

      const result = await terminateSessionAction.execute(mockContext, inputs);

      expect(mockSessionsService.terminateSession).toHaveBeenCalledWith('session-123', {
        source: 'subscriber',
        reason: 'user-requested',
      });
      expect(result.success).toBe(true);
      const data = result.data as TerminateSessionResultData;
      expect(data.previousStatus).toBe('stopped');
      expect(result.message).toContain('previous status: stopped');
    });
  });

  describe('execute - retry semantics', () => {
    it('should not mark failures as non-retryable', async () => {
      mockSessionsService.getActiveSessionForAgent.mockReturnValue(null);
      const inputs = { agentName: 'IdleAgent' };

      const result = await terminateSessionAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.retryable).toBeUndefined();
    });

    it('should not mark termination errors as non-retryable', async () => {
      mockSessionsService.terminateSession.mockRejectedValue(new Error('tmux destroy failed'));
      const inputs = {};

      const result = await terminateSessionAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.retryable).toBeUndefined();
    });
  });

  describe('execute - error handling', () => {
    it('should handle terminateSession errors', async () => {
      mockSessionsService.terminateSession.mockRejectedValue(new Error('Cannot terminate'));
      const inputs = {};

      const result = await terminateSessionAction.execute(mockContext, inputs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to terminate session');
      expect(result.error).toContain('Cannot terminate');
    });

    it('should log errors on failure', async () => {
      mockSessionsService.terminateSession.mockRejectedValue(new Error('Cannot terminate'));
      const inputs = {};

      await terminateSessionAction.execute(mockContext, inputs);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Cannot terminate' }),
        'Failed to terminate session',
      );
    });

    it('should log a successful termination', async () => {
      const inputs = {};

      await terminateSessionAction.execute(mockContext, inputs);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-123',
          resolvedAgentId: 'agent-456',
          resolvedBy: 'event',
          previousStatus: 'running',
        }),
        'Session terminated successfully',
      );
    });
  });
});
