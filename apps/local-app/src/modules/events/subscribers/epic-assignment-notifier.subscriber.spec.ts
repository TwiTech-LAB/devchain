import { EpicAssignmentNotifierSubscriber } from './epic-assignment-notifier.subscriber';
import type { EventLogService } from '../services/event-log.service';
import type { SettingsService } from '../../settings/services/settings.service';
import type { SessionsService } from '../../sessions/services/sessions.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { SessionCoordinatorService } from '../../sessions/services/session-coordinator.service';
import type { SessionsMessagePoolService } from '../../sessions/services/sessions-message-pool.service';
import type { ModuleRef } from '@nestjs/core';

const getEventMetadataMock = jest.fn();

jest.mock('../services/events.service', () => ({
  getEventMetadata: (...args: unknown[]) => getEventMetadataMock(...args),
}));

describe('EpicAssignmentNotifierSubscriber', () => {
  let eventLogService: {
    recordHandledOk: jest.Mock;
    recordHandledFail: jest.Mock;
  };
  let settingsService: { getSetting: jest.Mock };
  let listActiveSessionsMock: jest.Mock;
  let launchSessionMock: jest.Mock;
  let sessionsService: SessionsService;
  let moduleRef: ModuleRef;
  let enqueueMock: jest.Mock;
  let messagePoolService: SessionsMessagePoolService;
  let getAgentMock: jest.Mock;
  let getProjectMock: jest.Mock;
  let getEpicMock: jest.Mock;
  let storageService: StorageService;
  let sessionCoordinator: SessionCoordinatorService;
  let subscriber: EpicAssignmentNotifierSubscriber;

  // New epic.updated payload structure with agentId change
  const basePayload = {
    epicId: 'epic-1',
    projectId: 'project-1',
    version: 2,
    epicTitle: 'Add Feature',
    projectName: 'Demo Project',
    changes: {
      agentId: {
        previous: null,
        current: 'agent-1',
        currentName: 'Helper Agent',
      },
    },
  } as const;

  beforeEach(() => {
    eventLogService = {
      recordHandledOk: jest.fn().mockResolvedValue({ id: 'handler-ok' }),
      recordHandledFail: jest.fn().mockResolvedValue({ id: 'handler-fail' }),
    };

    settingsService = {
      getSetting: jest.fn().mockReturnValue('[Epic Assignment]\n{epic_title} -> {agent_name}'),
    };

    listActiveSessionsMock = jest.fn().mockResolvedValue([]);
    launchSessionMock = jest
      .fn()
      .mockResolvedValue({ id: 'session-2', tmuxSessionId: 'tmux-session' });
    sessionsService = {
      listActiveSessions: listActiveSessionsMock,
      launchSession: launchSessionMock,
    } as unknown as SessionsService;
    moduleRef = {
      get: jest.fn().mockReturnValue(sessionsService),
    } as unknown as ModuleRef;

    enqueueMock = jest.fn().mockResolvedValue({ status: 'queued', poolSize: 1 });
    messagePoolService = {
      enqueue: enqueueMock,
    } as unknown as SessionsMessagePoolService;

    sessionCoordinator = {
      withAgentLock: jest.fn().mockImplementation(async (_agentId, callback) => {
        // Simulate getting/launching a session
        return callback();
      }),
    } as unknown as SessionCoordinatorService;

    getAgentMock = jest.fn();
    getProjectMock = jest.fn();
    getEpicMock = jest.fn();
    storageService = {
      getAgent: getAgentMock,
      getProject: getProjectMock,
      getEpic: getEpicMock,
    } as unknown as StorageService;

    getEventMetadataMock.mockReturnValue({ id: 'event-1' });

    subscriber = new EpicAssignmentNotifierSubscriber(
      eventLogService as unknown as EventLogService,
      settingsService as unknown as SettingsService,
      moduleRef,
      sessionCoordinator,
      messagePoolService,
      storageService,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('renders template placeholders and enqueues to pool for existing session', async () => {
    listActiveSessionsMock.mockResolvedValue([
      {
        id: 'session-1',
        agentId: 'agent-1',
        epicId: basePayload.epicId,
        tmuxSessionId: 'tmux-session',
        status: 'running',
        startedAt: new Date().toISOString(),
        endedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    await subscriber.handleEpicUpdated(basePayload);

    expect(launchSessionMock).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [agentId, message, options] = enqueueMock.mock.calls[0];
    expect(agentId).toBe('agent-1');
    expect(message).toContain(basePayload.epicTitle);
    expect(message).toContain('Helper Agent');
    expect(options).toEqual({
      source: 'epic.assigned',
      submitKeys: ['Enter'],
      projectId: basePayload.projectId,
      agentName: 'Helper Agent',
    });
    expect(eventLogService.recordHandledOk).toHaveBeenCalledWith(
      expect.objectContaining({ handler: 'EpicAssignmentNotifier', eventId: 'event-1' }),
    );
  });

  it('launches session when none exist and enqueues message', async () => {
    await subscriber.handleEpicUpdated(basePayload);

    expect(launchSessionMock).toHaveBeenCalledWith({
      projectId: basePayload.projectId,
      agentId: 'agent-1',
      epicId: basePayload.epicId,
      options: { silent: true },
    });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      'agent-1',
      expect.any(String),
      expect.objectContaining({
        source: 'epic.assigned',
        submitKeys: ['Enter'],
        projectId: basePayload.projectId,
        agentName: 'Helper Agent',
      }),
    );
  });

  it('logs failure when enqueue throws', async () => {
    enqueueMock.mockRejectedValue(new Error('pool failure'));

    await subscriber.handleEpicUpdated(basePayload);

    expect(eventLogService.recordHandledFail).toHaveBeenCalledWith(
      expect.objectContaining({ handler: 'EpicAssignmentNotifier', eventId: 'event-1' }),
    );
    expect(eventLogService.recordHandledOk).not.toHaveBeenCalled();
  });

  it('fills missing names from storage when payload lacks context', async () => {
    settingsService.getSetting.mockReturnValue('{epic_title} -> {agent_name} ({project_name})');
    getAgentMock.mockResolvedValue({ name: 'Storage Agent' });
    getProjectMock.mockResolvedValue({ name: 'Storage Project' });
    getEpicMock.mockResolvedValue({ title: 'Storage Epic' });
    getEventMetadataMock.mockReturnValue(null);

    await subscriber.handleEpicUpdated({
      epicId: 'epic-1',
      projectId: 'project-1',
      version: 2,
      epicTitle: 'Add Feature', // epicTitle is always present in epic.updated
      projectName: undefined,
      changes: {
        agentId: {
          previous: null,
          current: 'agent-1',
          // No currentName - should resolve from storage
        },
      },
    });

    expect(getAgentMock).toHaveBeenCalled();
    expect(getProjectMock).toHaveBeenCalled();
    // epicTitle is always present in payload, so getEpic should not be called
    expect(enqueueMock).toHaveBeenCalledWith(
      'agent-1',
      expect.stringContaining('Add Feature'),
      expect.any(Object),
    );
  });

  it('ignores events without agentId changes', async () => {
    await subscriber.handleEpicUpdated({
      epicId: 'epic-1',
      projectId: 'project-1',
      version: 2,
      epicTitle: 'Updated Title',
      changes: {
        title: { previous: 'Old Title', current: 'Updated Title' },
      },
    });

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(launchSessionMock).not.toHaveBeenCalled();
  });

  it('ignores unassignments (agent removed)', async () => {
    await subscriber.handleEpicUpdated({
      epicId: 'epic-1',
      projectId: 'project-1',
      version: 2,
      epicTitle: 'Add Feature',
      changes: {
        agentId: {
          previous: 'agent-1',
          current: null,
          previousName: 'Helper Agent',
        },
      },
    });

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(launchSessionMock).not.toHaveBeenCalled();
  });

  describe('self-assignment detection', () => {
    describe('epic.updated', () => {
      it('skips enqueue when agent assigns epic to themselves', async () => {
        const payload = {
          epicId: 'epic-1',
          projectId: 'project-1',
          version: 2,
          epicTitle: 'Self Assignment',
          projectName: 'Demo Project',
          actor: { type: 'agent' as const, id: 'agent-1' },
          changes: {
            agentId: {
              previous: null,
              current: 'agent-1',
              currentName: 'Helper Agent',
            },
          },
        };

        await subscriber.handleEpicUpdated(payload);

        expect(enqueueMock).not.toHaveBeenCalled();
        expect(launchSessionMock).not.toHaveBeenCalled();
      });

      it('proceeds with enqueue when different agent assigns epic', async () => {
        const payload = {
          epicId: 'epic-1',
          projectId: 'project-1',
          version: 2,
          epicTitle: 'Cross Assignment',
          projectName: 'Demo Project',
          actor: { type: 'agent' as const, id: 'agent-2' },
          changes: {
            agentId: {
              previous: null,
              current: 'agent-1',
              currentName: 'Helper Agent',
            },
          },
        };

        await subscriber.handleEpicUpdated(payload);

        expect(enqueueMock).toHaveBeenCalledTimes(1);
        expect(enqueueMock).toHaveBeenCalledWith(
          'agent-1',
          expect.any(String),
          expect.objectContaining({
            source: 'epic.assigned',
            submitKeys: ['Enter'],
            projectId: 'project-1',
            agentName: 'Helper Agent',
          }),
        );
      });

      it('proceeds with enqueue when actor is null (HTTP/API path)', async () => {
        const payload = {
          epicId: 'epic-1',
          projectId: 'project-1',
          version: 2,
          epicTitle: 'System Assignment',
          projectName: 'Demo Project',
          actor: null,
          changes: {
            agentId: {
              previous: null,
              current: 'agent-1',
              currentName: 'Helper Agent',
            },
          },
        };

        await subscriber.handleEpicUpdated(payload);

        expect(enqueueMock).toHaveBeenCalledTimes(1);
        expect(enqueueMock).toHaveBeenCalledWith(
          'agent-1',
          expect.any(String),
          expect.objectContaining({
            source: 'epic.assigned',
          }),
        );
      });
    });

    describe('epic.created', () => {
      const createdPayload = {
        epicId: 'epic-1',
        projectId: 'project-1',
        title: 'New Epic',
        statusId: 'status-1',
        agentId: 'agent-1',
        parentId: null,
        projectName: 'Demo Project',
        statusName: 'New',
        agentName: 'Helper Agent',
        parentTitle: null,
      };

      it('skips enqueue when agent creates epic assigned to themselves', async () => {
        const payload = {
          ...createdPayload,
          actor: { type: 'agent' as const, id: 'agent-1' },
        };

        await subscriber.handleEpicCreated(payload);

        expect(enqueueMock).not.toHaveBeenCalled();
        expect(launchSessionMock).not.toHaveBeenCalled();
      });

      it('proceeds with enqueue when different agent creates epic with assignment', async () => {
        const payload = {
          ...createdPayload,
          actor: { type: 'agent' as const, id: 'agent-2' },
        };

        await subscriber.handleEpicCreated(payload);

        expect(enqueueMock).toHaveBeenCalledTimes(1);
        expect(enqueueMock).toHaveBeenCalledWith(
          'agent-1',
          expect.any(String),
          expect.objectContaining({
            source: 'epic.created',
            submitKeys: ['Enter'],
            projectId: 'project-1',
            agentName: 'Helper Agent',
          }),
        );
      });
    });
  });
});
