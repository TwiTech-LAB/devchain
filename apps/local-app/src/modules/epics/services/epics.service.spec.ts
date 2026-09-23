import { EpicsService } from './epics.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { EventsService } from '../../events/services/events.service';
import type { SettingsService } from '../../settings/services/settings.service';
import type { CreateEpic, Epic } from '../../storage/models/domain.models';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NotFoundError,
  ValidationError,
  DescriptionEditNotFoundError,
} from '../../../common/errors/error-types';

describe('EpicsService', () => {
  let storage: {
    createEpic: jest.Mock;
    createEpicForProject: jest.Mock;
    createEpicWithinTransaction: jest.Mock;
    runInTransaction: jest.Mock;
    setEpicRelation: jest.Mock;
    getWorkspaceEpicsByIdPrefix: jest.Mock;
    getEpic: jest.Mock;
    updateEpic: jest.Mock;
    deleteEpic: jest.Mock;
    getProject: jest.Mock;
    getAgent: jest.Mock;
    getAgentByName: jest.Mock;
    getGuest: jest.Mock;
    getStatus: jest.Mock;
    listStatuses: jest.Mock;
    listSubEpics: jest.Mock;
    createEpicComment: jest.Mock;
    deleteEpicCommentScoped: jest.Mock;
    createEpicWithExternalTaskLink: jest.Mock;
    getIntegrationConnection: jest.Mock;
    listExternalTaskLinksForEpic: jest.Mock;
    listExternalTaskLinksForEpics: jest.Mock;
  };
  let eventsService: {
    publish: jest.Mock;
    prepareCommitted?: jest.Mock;
    emitCommitted?: jest.Mock;
  };
  let settingsService: { getSetting: jest.Mock; getAutoCleanStatusIds: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let service: EpicsService;

  const baseEpic: Epic = {
    id: 'epic-1',
    projectId: 'project-1',
    title: 'Initial Epic',
    description: null,
    statusId: 'status-1',
    parentId: null,
    agentId: null,
    createdBy: null,
    version: 1,
    data: null,
    skillsRequired: null,
    tags: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    storage = {
      createEpic: jest.fn(),
      createEpicForProject: jest.fn(),
      createEpicWithinTransaction: jest.fn(),
      runInTransaction: jest.fn((fn: () => Promise<unknown>) => fn()),
      setEpicRelation: jest.fn(),
      getWorkspaceEpicsByIdPrefix: jest.fn(),
      getEpic: jest.fn(),
      updateEpic: jest.fn(),
      deleteEpic: jest.fn(),
      getProject: jest.fn(),
      getAgent: jest.fn(),
      getAgentByName: jest.fn(),
      getGuest: jest.fn(),
      getStatus: jest.fn(),
      listStatuses: jest.fn(),
      listSubEpics: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      createEpicComment: jest.fn(),
      deleteEpicCommentScoped: jest.fn(),
      createEpicWithExternalTaskLink: jest.fn(),
      getIntegrationConnection: jest.fn(),
      listExternalTaskLinksForEpic: jest.fn(),
      listExternalTaskLinksForEpics: jest.fn(),
    };
    eventsService = {
      publish: jest.fn().mockResolvedValue('event-id'),
      prepareCommitted: jest.fn((name, payload) => ({
        id: 'prepared-event',
        name,
        payload,
        requestId: null,
        publishedAt: '2026-08-24T00:00:00.000Z',
      })),
      emitCommitted: jest.fn((event) => {
        void eventsService.publish(event.name, event.payload).catch(() => undefined);
      }),
    };
    settingsService = {
      getSetting: jest.fn(),
      getAutoCleanStatusIds: jest.fn().mockReturnValue([]),
    };
    eventEmitter = { emit: jest.fn() };
    storage.getProject.mockResolvedValue({
      id: 'project-1',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      name: 'Demo Project',
    });

    const trackCallback = <TArgs extends unknown[], TResult>(
      callback: ((...args: TArgs) => TResult) | undefined,
    ) => {
      let called = false;
      return {
        callback: callback
          ? (...args: TArgs) => {
              called = true;
              return callback(...args);
            }
          : undefined,
        callIfNeeded: (...args: TArgs): void => {
          if (callback && !called) callback(...args);
        },
        wasCalled: (): boolean => called,
      };
    };

    const observedEpics = new Map<string, Epic>();
    const storageAdapter: StorageService = {
      ...(storage as unknown as StorageService),
      getEpic: async (id) => {
        const epic = await storage.getEpic(id);
        observedEpics.set(id, epic);
        return epic;
      },
      createEpic: async (data, eventFactory) => {
        const tracked = trackCallback(eventFactory);
        const epic = await storage.createEpic(data, tracked.callback);
        tracked.callIfNeeded(epic);
        return epic;
      },
      createEpicForProject: async (projectId, input, eventFactory) => {
        const tracked = trackCallback(eventFactory);
        const epic = await storage.createEpicForProject(projectId, input, tracked.callback);
        tracked.callIfNeeded(epic);
        return epic;
      },
      createEpicWithinTransaction: async (data, eventFactory, beforeEventAppend) => {
        const tracked = trackCallback(eventFactory);
        let beforeCalled = false;
        const trackedBeforeEventAppend = beforeEventAppend
          ? async (epic: Epic) => {
              beforeCalled = true;
              await beforeEventAppend(epic);
            }
          : undefined;
        const epic = await storage.createEpicWithinTransaction(
          data,
          tracked.callback,
          trackedBeforeEventAppend,
        );
        if (trackedBeforeEventAppend && !beforeCalled) await trackedBeforeEventAppend(epic);
        tracked.callIfNeeded(epic);
        return epic;
      },
      runInTransaction: async (fn) => storage.runInTransaction(fn),
      createEpicWithExternalTaskLink: async (data, eventFactory) => {
        const tracked = trackCallback(eventFactory);
        const result = await storage.createEpicWithExternalTaskLink(data, tracked.callback);
        if (result.created) tracked.callIfNeeded(result);
        return result;
      },
      updateEpic: async (id, data, expectedVersion, eventFactory) => {
        const previous = observedEpics.get(id);
        const tracked = trackCallback(eventFactory);
        const current = await storage.updateEpic(id, data, expectedVersion, tracked.callback);
        if (eventFactory && !tracked.wasCalled()) {
          if (!previous) throw new Error(`Test storage did not observe Epic ${id} before update.`);
          tracked.callIfNeeded(current, previous);
        }
        observedEpics.set(id, current);
        return current;
      },
      deleteEpic: async (id, eventFactory) => {
        const deleted = observedEpics.get(id);
        const tracked = trackCallback(eventFactory);
        await storage.deleteEpic(id, tracked.callback);
        if (eventFactory && !tracked.wasCalled()) {
          if (!deleted) throw new Error(`Test storage did not observe Epic ${id} before delete.`);
          tracked.callIfNeeded(deleted, '11111111-1111-4111-8111-111111111111');
        }
      },
      createEpicComment: async (data, eventFactory) => {
        const observed = observedEpics.get(data.epicId);
        const tracked = trackCallback(eventFactory);
        const comment = await storage.createEpicComment(data, tracked.callback);
        if (eventFactory && !tracked.wasCalled()) {
          if (!observed) {
            throw new Error(`Test storage did not observe Epic ${data.epicId} before comment.`);
          }
          tracked.callIfNeeded(comment, observed);
        }
        return comment;
      },
    };

    service = new EpicsService(
      storageAdapter,
      eventsService as unknown as EventsService,
      settingsService as unknown as SettingsService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('publishes epic.created domain event on create', async () => {
    storage.createEpic.mockResolvedValue(baseEpic);
    await service.createEpic(baseEpic as unknown as CreateEpic);
    expect(eventsService.publish).toHaveBeenCalledWith(
      'epic.created',
      expect.objectContaining({
        epicId: baseEpic.id,
        projectId: baseEpic.projectId,
        title: baseEpic.title,
      }),
    );
  });

  describe('external task imports and sources', () => {
    const importInput = {
      projectId: 'project-1',
      statusId: 'status-1',
      title: 'Edited title',
      description: 'Edited description',
      remote: {
        provider: 'jira' as const,
        scopeKey: 'acme.atlassian.net',
        taskId: 'ENG-1',
        remoteKey: 'ENG-1',
        title: 'Remote title',
        description: 'Remote description',
        webUrl: 'https://acme.atlassian.net/browse/ENG-1',
        workAreaId: '42',
        workAreaName: 'Delivery',
        statusName: 'In Progress',
      },
    };

    it('validates project status ownership and always creates an unassigned atomic import', async () => {
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Product' });
      storage.getStatus.mockResolvedValue({ id: 'status-1', projectId: 'project-1' });
      storage.getIntegrationConnection.mockResolvedValue({
        id: 'connection-1',
        projectId: 'project-1',
        provider: 'jira',
      });
      storage.createEpicWithExternalTaskLink.mockResolvedValue({
        epic: baseEpic,
        externalTaskLink: { id: 'link-1', epicId: baseEpic.id },
        created: true,
      });

      await service.importExternalTask(importInput);

      expect(storage.getIntegrationConnection).toHaveBeenCalledWith({
        projectId: 'project-1',
        provider: 'jira',
      });
      expect(storage.createEpicWithExternalTaskLink).toHaveBeenCalledWith(
        {
          epic: expect.objectContaining({
            projectId: 'project-1',
            statusId: 'status-1',
            title: 'Edited title',
            description: 'Edited description',
            agentId: null,
            createdBy: null,
          }),
          externalTaskLink: {
            connectionId: 'connection-1',
            provider: 'jira',
            remoteScopeKey: 'acme.atlassian.net',
            remoteTaskId: 'ENG-1',
            sourceSnapshot: {
              remoteKey: 'ENG-1',
              title: 'Remote title',
              description: 'Remote description',
              webUrl: 'https://acme.atlassian.net/browse/ENG-1',
              workAreaId: '42',
              workAreaName: 'Delivery',
              statusName: 'In Progress',
            },
          },
        },
        expect.any(Function),
      );
    });

    it('rejects a status from a different project before creating anything', async () => {
      storage.getProject.mockResolvedValue({ id: 'project-1' });
      storage.getStatus.mockResolvedValue({ id: 'status-other', projectId: 'project-other' });
      storage.getIntegrationConnection.mockResolvedValue({
        id: 'connection-1',
        projectId: 'project-1',
        provider: 'jira',
      });

      await expect(service.importExternalTask(importInput)).rejects.toBeInstanceOf(ValidationError);
      expect(storage.createEpicWithExternalTaskLink).not.toHaveBeenCalled();
    });

    it('publishes an Epic-time scope hint after ordinary link creation', async () => {
      storage.getProject.mockResolvedValue({
        id: 'project-1',
        name: 'Product',
        workspaceId: '11111111-1111-4111-8111-111111111111',
      });
      storage.createEpicWithExternalTaskLink.mockResolvedValue({
        epic: baseEpic,
        externalTaskLink: { id: 'link-1', epicId: baseEpic.id },
        created: true,
      });

      await service.createEpicWithExternalTaskLink({
        epic: {
          projectId: 'project-1',
          title: 'Linked',
          description: null,
          statusId: 'status-1',
          parentId: null,
          agentId: null,
          data: null,
          skillsRequired: null,
          tags: [],
        },
        externalTaskLink: {
          connectionId: 'connection-1',
          provider: 'jira',
          remoteScopeKey: 'acme.atlassian.net',
          remoteTaskId: 'ENG-1',
          sourceSnapshot: {},
        },
      });

      expect(eventsService.publish).toHaveBeenCalledWith('epic.time.scope.invalidated', {
        workspaceId: '11111111-1111-4111-8111-111111111111',
      });
    });

    it('publishes no Epic-time scope hint when link creation fails', async () => {
      storage.getProject.mockResolvedValue({
        id: 'project-1',
        name: 'Product',
        workspaceId: '11111111-1111-4111-8111-111111111111',
      });
      storage.createEpicWithExternalTaskLink.mockRejectedValue(new Error('rolled back'));

      await expect(
        service.createEpicWithExternalTaskLink({
          epic: {
            projectId: 'project-1',
            title: 'Linked',
            description: null,
            statusId: 'status-1',
            parentId: null,
            agentId: null,
            data: null,
            skillsRequired: null,
            tags: [],
          },
          externalTaskLink: {
            connectionId: 'connection-1',
            provider: 'jira',
            remoteScopeKey: 'acme.atlassian.net',
            remoteTaskId: 'ENG-1',
            sourceSnapshot: {},
          },
        }),
      ).rejects.toThrow('rolled back');

      expect(eventsService.publish).not.toHaveBeenCalledWith(
        'epic.time.scope.invalidated',
        expect.anything(),
      );
    });

    it('rejects an import when the chosen project has no provider connection', async () => {
      storage.getProject.mockResolvedValue({ id: 'project-1' });
      storage.getStatus.mockResolvedValue({ id: 'status-1', projectId: 'project-1' });
      storage.getIntegrationConnection.mockResolvedValue(null);

      await expect(service.importExternalTask(importInput)).rejects.toMatchObject<ValidationError>({
        message: 'Connect the integration before importing this task.',
      });

      expect(storage.getIntegrationConnection).toHaveBeenCalledWith({
        projectId: 'project-1',
        provider: 'jira',
      });
      expect(storage.createEpicWithExternalTaskLink).not.toHaveBeenCalled();
    });

    it('projects a bounded allowlisted source after the integration disconnects', async () => {
      storage.listExternalTaskLinksForEpic.mockResolvedValue([
        {
          provider: 'jira',
          remoteTaskId: 'ENG-1',
          sourceSnapshot: {
            remoteKey: 'ENG-1',
            title: 'Remote title',
            workAreaName: 'Delivery',
            statusName: 'Done',
            webUrl: 'https://acme.atlassian.net/browse/ENG-1',
          },
          createdAt: '2026-08-19T10:00:00.000Z',
          connectionId: null,
        },
      ]);

      await expect(service.listExternalTaskSources('epic-1')).resolves.toEqual([
        expect.objectContaining({
          provider: 'jira',
          remoteTaskId: 'ENG-1',
          webUrl: 'https://acme.atlassian.net/browse/ENG-1',
        }),
      ]);
    });

    it('projects a batch through the same bounded projector with epic identity', async () => {
      storage.listExternalTaskLinksForEpics.mockResolvedValue([
        {
          epicId: 'epic-1',
          provider: 'jira',
          remoteTaskId: 'ENG-1',
          sourceSnapshot: {
            remoteKey: 'ENG-1',
            title: 'Remote title',
            workAreaName: 'Delivery',
            statusName: 'Done',
            webUrl: 'https://evil.example/ENG-1',
          },
          createdAt: '2026-08-19T10:00:00.000Z',
          connectionId: 'internal-connection',
          remoteScopeKey: 'internal-scope',
        },
      ]);

      await expect(
        service.listExternalTaskSourcesBatch(['epic-1', 'epic-missing']),
      ).resolves.toEqual([
        expect.objectContaining({
          epicId: 'epic-1',
          provider: 'jira',
          remoteTaskId: 'ENG-1',
          title: 'Remote title',
          // Untrusted stored URLs are still normalized away in batch form.
          webUrl: null,
        }),
      ]);
      expect(JSON.stringify(await service.listExternalTaskSourcesBatch(['epic-1']))).not.toMatch(
        /connectionId|remoteScopeKey|sourceSnapshot/,
      );
    });

    it('deduplicates requested Epic IDs before the storage query', async () => {
      storage.listExternalTaskLinksForEpics.mockResolvedValue([]);

      await expect(
        service.listExternalTaskSourcesBatch(['epic-1', 'epic-1', 'epic-2']),
      ).resolves.toEqual([]);

      expect(storage.listExternalTaskLinksForEpics).toHaveBeenCalledTimes(1);
      expect(storage.listExternalTaskLinksForEpics).toHaveBeenCalledWith(['epic-1', 'epic-2']);
    });

    it('returns an empty batch without a storage query', async () => {
      await expect(service.listExternalTaskSourcesBatch([])).resolves.toEqual([]);
      expect(storage.listExternalTaskLinksForEpics).not.toHaveBeenCalled();
    });
  });

  describe('deleteEpicComment (project-scoped, mobile board)', () => {
    it('deletes a comment scoped to its epic when the epic is in the project', async () => {
      storage.getEpic.mockResolvedValue(baseEpic);
      storage.deleteEpicCommentScoped.mockResolvedValue(true);

      await expect(
        service.deleteEpicComment('project-1', 'epic-1', 'comment-1'),
      ).resolves.toBeUndefined();

      expect(storage.deleteEpicCommentScoped).toHaveBeenCalledWith('epic-1', 'comment-1');
    });

    it('rejects a cross-project epic with a clean not-found (no scoped delete)', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, projectId: 'other-project' });

      await expect(
        service.deleteEpicComment('project-1', 'epic-1', 'comment-1'),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(storage.deleteEpicCommentScoped).not.toHaveBeenCalled();
    });

    it('refuses a comment that belongs to another epic (scoped delete matched no row)', async () => {
      storage.getEpic.mockResolvedValue(baseEpic);
      storage.deleteEpicCommentScoped.mockResolvedValue(false);

      await expect(
        service.deleteEpicComment('project-1', 'epic-1', 'comment-from-other-epic'),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('epic.created event', () => {
    it('publishes epic.created on createEpic() with correct payload', async () => {
      storage.createEpic.mockResolvedValue(baseEpic);
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Test Project' });
      storage.getStatus.mockResolvedValue({ id: 'status-1', label: 'New' });
      await service.createEpic(baseEpic as unknown as CreateEpic);
      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.created',
        expect.objectContaining({
          epicId: baseEpic.id,
          projectId: baseEpic.projectId,
          title: baseEpic.title,
          statusId: baseEpic.statusId,
          agentId: null,
          parentId: null,
        }),
      );
    });

    it('publishes epic.created on createEpicForProject() with correct payload', async () => {
      storage.createEpicForProject.mockResolvedValue(baseEpic);
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Test Project' });
      storage.getStatus.mockResolvedValue({ id: 'status-1', label: 'New' });
      await service.createEpicForProject(baseEpic.projectId, {
        title: baseEpic.title,
      } as unknown as CreateEpic);
      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.created',
        expect.objectContaining({
          epicId: baseEpic.id,
          projectId: baseEpic.projectId,
          title: baseEpic.title,
          statusId: baseEpic.statusId,
        }),
      );
    });

    it('passes skillsRequired through createEpicForProject to storage', async () => {
      storage.createEpicForProject.mockResolvedValue({
        ...baseEpic,
        skillsRequired: ['openai/review'],
      });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Test Project' });
      storage.getStatus.mockResolvedValue({ id: 'status-1', label: 'New' });
      await service.createEpicForProject(baseEpic.projectId, {
        title: baseEpic.title,
        skillsRequired: ['openai/review'],
      });
      expect(storage.createEpicForProject).toHaveBeenCalledWith(
        baseEpic.projectId,
        expect.objectContaining({ title: baseEpic.title, skillsRequired: ['openai/review'] }),
        expect.any(Function),
      );
    });

    it('creates an initial relation before appending and announcing the Epic fact', async () => {
      const relatedEpicId = 'related-epic';
      storage.createEpicWithinTransaction.mockResolvedValue(baseEpic);
      storage.getStatus.mockResolvedValue({
        id: 'status-1',
        label: 'New',
        projectId: baseEpic.projectId,
      });
      storage.getWorkspaceEpicsByIdPrefix.mockResolvedValue([
        {
          id: relatedEpicId,
          projectId: baseEpic.projectId,
          projectName: 'Demo Project',
          title: 'Related',
          statusId: 'status-1',
          statusLabel: 'New',
          statusColor: '#ccc',
          statusMcpHidden: false,
          parentId: null,
        },
      ]);
      storage.setEpicRelation.mockResolvedValue({
        changed: true,
        workspaceId: '11111111-1111-4111-8111-111111111111',
      });

      await service.createEpicForProject(
        baseEpic.projectId,
        {
          title: baseEpic.title,
          statusId: 'status-1',
          relation: { relatedEpicId, relation: 'blocked_by' },
        },
        { actor: { type: 'agent', id: 'agent-1' }, creatorAgentName: 'Creator' },
      );

      expect(storage.runInTransaction).toHaveBeenCalledTimes(1);
      expect(storage.createEpicWithinTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: baseEpic.projectId, title: baseEpic.title }),
        expect.any(Function),
        expect.any(Function),
      );
      expect(storage.setEpicRelation).toHaveBeenCalledWith(
        expect.objectContaining({
          epicId: baseEpic.id,
          relatedEpicId,
          type: 'blocked_by',
          createdBy: 'agent',
          createdByAgentId: 'agent-1',
        }),
        { actor: { type: 'agent', id: 'agent-1' } },
      );
      expect(storage.setEpicRelation.mock.invocationCallOrder[0]).toBeLessThan(
        eventsService.prepareCommitted!.mock.invocationCallOrder[0],
      );
      expect(eventsService.emitCommitted).toHaveBeenCalledTimes(1);
      expect(eventsService.publish).toHaveBeenCalledWith('epic.relations.invalidated', {
        workspaceId: '11111111-1111-4111-8111-111111111111',
      });
    });

    it('announces nothing when an initial relation transaction fails', async () => {
      storage.createEpicWithinTransaction.mockResolvedValue(baseEpic);
      storage.getStatus.mockResolvedValue({
        id: 'status-1',
        label: 'New',
        projectId: baseEpic.projectId,
      });
      storage.getWorkspaceEpicsByIdPrefix.mockResolvedValue([
        {
          id: 'related-epic',
          projectId: baseEpic.projectId,
          projectName: 'Demo Project',
          title: 'Related',
          statusId: 'status-1',
          statusLabel: 'New',
          statusColor: '#ccc',
          statusMcpHidden: false,
          parentId: null,
        },
      ]);
      storage.setEpicRelation.mockRejectedValue(new Error('injected relation insert failure'));

      await expect(
        service.createEpicForProject(baseEpic.projectId, {
          title: baseEpic.title,
          statusId: 'status-1',
          relation: { relatedEpicId: 'related-epic', relation: 'related' },
        }),
      ).rejects.toThrow('injected relation insert failure');

      expect(eventsService.prepareCommitted).not.toHaveBeenCalled();
      expect(eventsService.emitCommitted).not.toHaveBeenCalled();
      expect(eventsService.publish).not.toHaveBeenCalled();
    });

    it('persists the trusted agent-name snapshot through createEpic', async () => {
      const persisted = {
        ...baseEpic,
        agentId: 'creator-agent',
        createdBy: 'Creator Snapshot',
      };
      storage.createEpic.mockResolvedValue(persisted);
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Test Project' });
      storage.getStatus.mockResolvedValue({ id: 'status-1', label: 'New' });
      storage.getAgent.mockRejectedValue(new Error('Agent was deleted after insert'));

      await service.createEpic(
        {
          ...baseEpic,
          agentId: 'creator-agent',
          createdBy: 'Spoofed Input',
        } as unknown as CreateEpic,
        {
          actor: { type: 'agent', id: 'creator-agent' },
          creatorAgentName: 'Creator Snapshot',
        },
      );

      expect(storage.createEpic).toHaveBeenCalledWith(
        expect.objectContaining({ createdBy: 'Creator Snapshot' }),
        expect.any(Function),
      );
      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.created',
        expect.objectContaining({ creatorName: 'Creator Snapshot' }),
      );
      expect(storage.getAgent).toHaveBeenCalledWith('creator-agent');
    });

    it('persists the trusted agent-name snapshot through createEpicForProject', async () => {
      const persisted = {
        ...baseEpic,
        agentId: 'creator-agent',
        createdBy: 'Creator Snapshot',
      };
      storage.createEpicForProject.mockResolvedValue(persisted);
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Test Project' });
      storage.getStatus.mockResolvedValue({ id: 'status-1', label: 'New' });
      storage.getAgent.mockResolvedValue({ id: 'creator-agent', name: 'Renamed Creator' });

      await service.createEpicForProject(
        baseEpic.projectId,
        { title: baseEpic.title, agentId: 'creator-agent', createdBy: 'Spoofed Input' },
        {
          actor: { type: 'agent', id: 'creator-agent' },
          creatorAgentName: 'Creator Snapshot',
        },
      );

      expect(storage.createEpicForProject).toHaveBeenCalledWith(
        baseEpic.projectId,
        expect.objectContaining({ createdBy: 'Creator Snapshot' }),
        expect.any(Function),
      );
      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.created',
        expect.objectContaining({
          agentName: 'Renamed Creator',
          creatorName: 'Creator Snapshot',
        }),
      );
      expect(storage.getAgent).toHaveBeenCalledWith('creator-agent');
    });

    it('persists null attribution while retaining readable guest event attribution', async () => {
      storage.createEpic.mockResolvedValue(baseEpic);
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Test Project' });
      storage.getStatus.mockResolvedValue({ id: 'status-1', label: 'New' });
      storage.getGuest.mockResolvedValue({ id: 'guest-1', name: 'Guest' });

      await service.createEpic(
        { ...baseEpic, createdBy: 'Spoofed Input' } as unknown as CreateEpic,
        { actor: { type: 'guest', id: 'guest-1' } },
      );

      expect(storage.createEpic).toHaveBeenCalledWith(
        expect.objectContaining({ createdBy: null }),
        expect.any(Function),
      );
      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.created',
        expect.objectContaining({ creatorName: 'Guest' }),
      );
    });

    it.each([
      [
        'an agent actor without a trusted name',
        { actor: { type: 'agent' as const, id: 'agent-1' } },
      ],
      ['unknown/system creation', undefined],
    ])('persists null attribution for %s', async (_label, context) => {
      storage.createEpic.mockResolvedValue(baseEpic);
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Test Project' });
      storage.getStatus.mockResolvedValue({ id: 'status-1', label: 'New' });
      storage.getAgent.mockResolvedValue({ id: 'agent-1', name: 'Legacy Agent' });

      await service.createEpic(
        { ...baseEpic, createdBy: 'Spoofed Input' } as unknown as CreateEpic,
        context,
      );

      expect(storage.createEpic).toHaveBeenCalledWith(
        expect.objectContaining({ createdBy: null }),
        expect.any(Function),
      );
      if (context?.actor.type === 'agent') {
        expect(eventsService.publish).toHaveBeenCalledWith(
          'epic.created',
          expect.objectContaining({ creatorName: 'Legacy Agent' }),
        );
      }
    });

    it('includes resolved names in epic.created payload', async () => {
      const epicWithAgent: Epic = { ...baseEpic, agentId: 'agent-1', parentId: 'parent-1' };
      storage.createEpic.mockResolvedValue(epicWithAgent);
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'My Project' });
      storage.getStatus.mockResolvedValue({ id: 'status-1', label: 'New' });
      storage.getAgent.mockResolvedValue({ id: 'agent-1', name: 'Coder' });
      storage.getEpic.mockResolvedValue({ id: 'parent-1', title: 'Parent Epic' });
      await service.createEpic(epicWithAgent as unknown as CreateEpic);
      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.created',
        expect.objectContaining({
          epicId: epicWithAgent.id,
          agentId: 'agent-1',
          parentId: 'parent-1',
          projectName: 'My Project',
          statusName: 'New',
          agentName: 'Coder',
          parentTitle: 'Parent Epic',
        }),
      );
    });

    it('adds explicit assignment and sub-epic recipient fields to epic.created payload', async () => {
      const epicWithParent: Epic = { ...baseEpic, agentId: 'agent-1', parentId: 'parent-1' };
      storage.createEpic.mockResolvedValue(epicWithParent);
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'My Project' });
      storage.getStatus.mockResolvedValue({ id: 'status-1', label: 'New' });
      storage.getEpic.mockResolvedValue({
        ...baseEpic,
        id: 'parent-1',
        title: 'Parent Epic',
        agentId: 'parent-agent',
      });
      storage.getAgent.mockImplementation(async (id: string) => {
        const names: Record<string, string> = {
          'agent-1': 'Assignee',
          'parent-agent': 'Parent Owner',
          'creator-agent': 'Creator',
        };
        return { id, name: names[id], projectId: 'project-1' };
      });

      await service.createEpic(epicWithParent as unknown as CreateEpic, {
        actor: { type: 'agent', id: 'creator-agent' },
      });

      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.created',
        expect.objectContaining({
          epicTitle: 'Initial Epic',
          assignmentRecipientIds: ['agent-1'],
          parentAgentId: 'parent-agent',
          parentAgentName: 'Parent Owner',
          creatorName: 'Creator',
          subEpicRecipientIds: ['parent-agent'],
        }),
      );
    });

    it('publishes epic.created even when name resolution fails', async () => {
      storage.createEpic.mockResolvedValue(baseEpic);
      storage.getProject.mockRejectedValue(new Error('Not found'));
      storage.getStatus.mockRejectedValue(new Error('Not found'));
      await service.createEpic(baseEpic as unknown as CreateEpic);
      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.created',
        expect.objectContaining({ epicId: baseEpic.id }),
      );
      const publishCall = eventsService.publish.mock.calls[0];
      expect(publishCall[1].projectName).toBeUndefined();
      expect(publishCall[1].statusName).toBeUndefined();
    });
  });

  describe('epic.updated event', () => {
    it('publishes epic.updated with status change and resolved names', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, statusId: 'status-old' });
      storage.updateEpic.mockResolvedValue({ ...baseEpic, statusId: 'status-new', version: 2 });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
      storage.getStatus
        .mockResolvedValueOnce({ id: 'status-old', label: 'Backlog' })
        .mockResolvedValueOnce({ id: 'status-new', label: 'In Progress' });
      await service.updateEpic(baseEpic.id, { statusId: 'status-new' }, baseEpic.version);
      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.updated',
        expect.objectContaining({
          epicId: baseEpic.id,
          parentId: null,
          changes: expect.objectContaining({
            statusId: expect.objectContaining({
              previous: 'status-old',
              current: 'status-new',
              previousName: 'Backlog',
              currentName: 'In Progress',
            }),
          }),
        }),
      );
    });

    it('publishes epic.updated with agent change and resolved names', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-A' });
      storage.updateEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-B', version: 2 });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
      storage.getAgent
        .mockResolvedValueOnce({ id: 'agent-A', name: 'Coder' })
        .mockResolvedValueOnce({ id: 'agent-B', name: 'Reviewer' });
      await service.updateEpic(baseEpic.id, { agentId: 'agent-B' }, baseEpic.version);
      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.updated',
        expect.objectContaining({
          epicId: baseEpic.id,
          parentId: null,
          changes: expect.objectContaining({
            agentId: expect.objectContaining({
              previous: 'agent-A',
              current: 'agent-B',
              previousName: 'Coder',
              currentName: 'Reviewer',
            }),
          }),
          recipientIds: ['agent-B'],
        }),
      );
    });

    it('publishes epic.updated with parent change and resolved titles', async () => {
      storage.getEpic
        .mockResolvedValueOnce({ ...baseEpic, parentId: 'parent-A' })
        .mockResolvedValueOnce({ id: 'parent-A', title: 'Old Parent' })
        .mockResolvedValueOnce({ id: 'parent-B', title: 'New Parent' });
      storage.updateEpic.mockResolvedValue({ ...baseEpic, parentId: 'parent-B', version: 2 });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
      await service.updateEpic(baseEpic.id, { parentId: 'parent-B' }, baseEpic.version);
      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.updated',
        expect.objectContaining({
          epicId: baseEpic.id,
          parentId: 'parent-B',
          changes: expect.objectContaining({
            parentId: expect.objectContaining({
              previous: 'parent-A',
              current: 'parent-B',
              previousTitle: 'Old Parent',
              currentTitle: 'New Parent',
            }),
          }),
        }),
      );
    });

    it('publishes an Epic-time scope hint after a committed parent change', async () => {
      storage.getEpic
        .mockResolvedValueOnce({ ...baseEpic, parentId: 'parent-A' })
        .mockResolvedValueOnce({ id: 'parent-A', title: 'Old Parent' })
        .mockResolvedValueOnce({ id: 'parent-B', title: 'New Parent' });
      storage.updateEpic.mockResolvedValue({ ...baseEpic, parentId: 'parent-B', version: 2 });
      storage.getProject.mockResolvedValue({
        id: 'project-1',
        name: 'Demo Project',
        workspaceId: '11111111-1111-4111-8111-111111111111',
      });

      await service.updateEpic(baseEpic.id, { parentId: 'parent-B' }, baseEpic.version);

      expect(eventsService.publish).toHaveBeenCalledWith('epic.time.scope.invalidated', {
        workspaceId: '11111111-1111-4111-8111-111111111111',
      });
    });

    it('skips the Epic-time scope hint when the parent stays unchanged', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, parentId: null });
      storage.updateEpic.mockResolvedValue({ ...baseEpic, title: 'Retitled', version: 2 });
      storage.getProject.mockResolvedValue({
        id: 'project-1',
        name: 'Demo Project',
        workspaceId: '11111111-1111-4111-8111-111111111111',
      });
      storage.getStatus.mockResolvedValue({ id: 'status-1', label: 'New' });

      await service.updateEpic(baseEpic.id, { title: 'Retitled' }, baseEpic.version);

      expect(eventsService.publish).not.toHaveBeenCalledWith(
        'epic.time.scope.invalidated',
        expect.anything(),
      );
    });

    it('publishes no Epic-time scope hint when the update fails', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, parentId: 'parent-A' });
      storage.getProject.mockResolvedValue({
        id: 'project-1',
        name: 'Demo Project',
        workspaceId: '11111111-1111-4111-8111-111111111111',
      });
      storage.updateEpic.mockRejectedValue(new Error('rolled back'));

      await expect(
        service.updateEpic(baseEpic.id, { parentId: 'parent-B' }, baseEpic.version),
      ).rejects.toThrow('rolled back');

      expect(eventsService.publish).not.toHaveBeenCalledWith(
        'epic.time.scope.invalidated',
        expect.anything(),
      );
    });

    it('publishes epic.updated with multiple fields changed', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, statusId: 'status-old', agentId: null });
      storage.updateEpic.mockResolvedValue({
        ...baseEpic,
        title: 'New Title',
        statusId: 'status-new',
        agentId: 'agent-1',
        version: 2,
      });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
      storage.getStatus
        .mockResolvedValueOnce({ id: 'status-old', label: 'Backlog' })
        .mockResolvedValueOnce({ id: 'status-new', label: 'In Progress' });
      storage.getAgent.mockResolvedValue({ id: 'agent-1', name: 'Coder' });
      await service.updateEpic(
        baseEpic.id,
        { title: 'New Title', statusId: 'status-new', agentId: 'agent-1' },
        baseEpic.version,
      );
      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.updated',
        expect.objectContaining({
          epicId: baseEpic.id,
          parentId: null,
          changes: expect.objectContaining({
            title: { previous: baseEpic.title, current: 'New Title' },
            statusId: expect.objectContaining({ previous: 'status-old', current: 'status-new' }),
            agentId: expect.objectContaining({ previous: null, current: 'agent-1' }),
          }),
        }),
      );
    });

    it('includes stable parentId for sub-epic status updates', async () => {
      storage.getEpic.mockResolvedValue({
        ...baseEpic,
        id: 'sub-epic-1',
        parentId: 'parent-epic-1',
        statusId: 'status-old',
      });
      storage.updateEpic.mockResolvedValue({
        ...baseEpic,
        id: 'sub-epic-1',
        parentId: 'parent-epic-1',
        statusId: 'status-new',
        version: 2,
      });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
      storage.getStatus
        .mockResolvedValueOnce({ id: 'status-old', label: 'Backlog' })
        .mockResolvedValueOnce({ id: 'status-new', label: 'In Progress' });

      await service.updateEpic('sub-epic-1', { statusId: 'status-new' }, baseEpic.version);

      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.updated',
        expect.objectContaining({
          epicId: 'sub-epic-1',
          parentId: 'parent-epic-1',
          changes: expect.objectContaining({
            statusId: expect.objectContaining({ previous: 'status-old', current: 'status-new' }),
          }),
        }),
      );
    });

    it('includes stable parentId for sub-epic assignment updates', async () => {
      storage.getEpic.mockResolvedValue({
        ...baseEpic,
        id: 'sub-epic-1',
        parentId: 'parent-epic-1',
        agentId: null,
      });
      storage.updateEpic.mockResolvedValue({
        ...baseEpic,
        id: 'sub-epic-1',
        parentId: 'parent-epic-1',
        agentId: 'agent-2',
        version: 2,
      });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
      storage.getAgent.mockResolvedValue({ id: 'agent-2', name: 'Reviewer' });

      await service.updateEpic('sub-epic-1', { agentId: 'agent-2' }, baseEpic.version);

      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.updated',
        expect.objectContaining({
          epicId: 'sub-epic-1',
          parentId: 'parent-epic-1',
          recipientIds: ['agent-2'],
          changes: expect.objectContaining({
            agentId: expect.objectContaining({ previous: null, current: 'agent-2' }),
          }),
        }),
      );
    });

    it('does NOT publish epic.updated for no-op status change', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, statusId: 'status-1' });
      storage.updateEpic.mockResolvedValue({ ...baseEpic, statusId: 'status-1', version: 2 });
      await service.updateEpic(baseEpic.id, { statusId: 'status-1' }, baseEpic.version);
      expect(eventsService.publish).not.toHaveBeenCalled();
    });

    it('prepares a description-only fact inside the versioned storage mutation', async () => {
      const updated = { ...baseEpic, description: 'New description', version: 2 };
      const prepared = {
        id: 'description-event',
        name: 'epic.updated',
        payload: {},
        requestId: null,
        publishedAt: '2026-08-23T00:00:00.000Z',
      };
      eventsService.prepareCommitted = jest.fn().mockReturnValue(prepared);
      eventsService.emitCommitted = jest.fn();
      storage.getEpic.mockResolvedValue(baseEpic);
      storage.getProject.mockResolvedValue({ id: baseEpic.projectId, name: 'Project' });
      storage.updateEpic.mockImplementation(async (_id, _data, _version, eventFactory) => {
        eventFactory(updated, baseEpic);
        return updated;
      });

      await service.updateEpic(baseEpic.id, { description: 'New description' }, baseEpic.version);

      expect(eventsService.prepareCommitted).toHaveBeenCalledWith(
        'epic.updated',
        expect.objectContaining({
          changes: {
            description: { previous: null, current: 'New description' },
          },
        }),
      );
      expect(eventsService.emitCommitted).toHaveBeenCalledWith(prepared);
      expect(eventsService.publish).not.toHaveBeenCalled();
    });

    it('publishes epic.updated with empty changes when the stored tag set changes', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, tags: ['Alpha'] });
      storage.updateEpic.mockResolvedValue({
        ...baseEpic,
        tags: ['Alpha', 'beta'],
        version: 2,
      });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });

      await service.updateEpic(baseEpic.id, { tags: ['Alpha', 'beta'] }, baseEpic.version);

      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.updated',
        expect.objectContaining({
          epicId: baseEpic.id,
          changes: {},
        }),
      );
    });

    it('does not publish when stored tags only change order', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, tags: ['Alpha', 'beta'] });
      storage.updateEpic.mockResolvedValue({
        ...baseEpic,
        tags: ['beta', 'Alpha'],
        version: 2,
      });

      await service.updateEpic(baseEpic.id, { tags: ['beta', 'Alpha'] }, baseEpic.version);

      expect(eventsService.publish).not.toHaveBeenCalled();
    });

    it('treats tag identity as case-sensitive when deciding to publish', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, tags: ['Alpha'] });
      storage.updateEpic.mockResolvedValue({ ...baseEpic, tags: ['alpha'], version: 2 });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });

      await service.updateEpic(baseEpic.id, { tags: ['alpha'] }, baseEpic.version);

      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.updated',
        expect.objectContaining({ changes: {} }),
      );
    });

    it('does NOT publish epic.updated when only skillsRequired changes', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, skillsRequired: ['openai/review'] });
      storage.updateEpic.mockResolvedValue({
        ...baseEpic,
        skillsRequired: ['openai/review', 'anthropic/pdf'],
        version: 2,
      });
      await service.updateEpic(
        baseEpic.id,
        { skillsRequired: ['openai/review', 'anthropic/pdf'] },
        baseEpic.version,
      );
      expect(eventsService.publish).not.toHaveBeenCalled();
    });

    it('changes object only includes changed fields', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-1', statusId: 'status-1' });
      storage.updateEpic.mockResolvedValue({
        ...baseEpic,
        agentId: 'agent-1',
        statusId: 'status-2',
        version: 2,
      });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
      storage.getStatus
        .mockResolvedValueOnce({ id: 'status-1', label: 'Backlog' })
        .mockResolvedValueOnce({ id: 'status-2', label: 'In Progress' });
      await service.updateEpic(baseEpic.id, { statusId: 'status-2' }, baseEpic.version);
      const changes = eventsService.publish.mock.calls[0][1].changes;
      expect(changes.statusId).toBeDefined();
      expect(changes.agentId).toBeUndefined();
      expect(changes.title).toBeUndefined();
      expect(changes.parentId).toBeUndefined();
    });

    it('does NOT publish epic.updated for cascade clears (auto-clean sub-epics)', async () => {
      const parentEpic: Epic = { ...baseEpic, id: 'parent-epic', statusId: 'status-old' };
      const subEpic: Epic = {
        ...baseEpic,
        id: 'sub-epic',
        parentId: 'parent-epic',
        agentId: 'agent-1',
      };
      storage.getEpic
        .mockResolvedValueOnce(parentEpic)
        .mockResolvedValueOnce({ ...subEpic, agentId: null });
      storage.updateEpic
        .mockResolvedValueOnce({ ...parentEpic, statusId: 'auto-clean-status', version: 2 })
        .mockResolvedValueOnce({ ...subEpic, agentId: null, version: 2 });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
      storage.getStatus
        .mockResolvedValueOnce({ id: 'status-old', label: 'Backlog' })
        .mockResolvedValueOnce({ id: 'auto-clean-status', label: 'Done' });
      storage.listSubEpics
        .mockResolvedValueOnce({ items: [subEpic], total: 1 })
        .mockResolvedValue({ items: [], total: 0 });
      settingsService.getAutoCleanStatusIds.mockReturnValue(['auto-clean-status']);
      await service.updateEpic(
        parentEpic.id,
        { statusId: 'auto-clean-status' },
        parentEpic.version,
      );
      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.updated',
        expect.objectContaining({ epicId: 'parent-epic' }),
      );
      expect(eventsService.publish).not.toHaveBeenCalledWith(
        'epic.updated',
        expect.objectContaining({ epicId: 'sub-epic' }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'epic.broadcast',
        expect.objectContaining({
          projectId: subEpic.projectId,
          type: 'updated',
          data: expect.objectContaining({
            epic: expect.objectContaining({ id: 'sub-epic', agentId: null }),
          }),
        }),
      );
    });
  });

  it('publishes epic.updated when agent changes', async () => {
    storage.getEpic.mockResolvedValue(baseEpic);
    storage.updateEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-9', version: 2 });
    storage.getProject.mockResolvedValue({ id: baseEpic.projectId, name: 'Demo Project' });
    storage.getAgent.mockResolvedValue({
      id: 'agent-9',
      name: 'Helper Agent',
      projectId: baseEpic.projectId,
    });
    await service.updateEpic(baseEpic.id, { agentId: 'agent-9' }, baseEpic.version);
    expect(eventsService.publish).toHaveBeenCalledWith(
      'epic.updated',
      expect.objectContaining({
        epicId: baseEpic.id,
        changes: expect.objectContaining({
          agentId: expect.objectContaining({ previous: null, current: 'agent-9' }),
        }),
      }),
    );
  });

  it('does not publish epic.assigned when agentId is unchanged', async () => {
    storage.getEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-7' });
    storage.updateEpic.mockResolvedValue({
      ...baseEpic,
      agentId: 'agent-7',
      title: 'Updated Title',
      version: 2,
    });
    storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
    await service.updateEpic(baseEpic.id, { title: 'Updated Title' }, baseEpic.version);
    expect(eventsService.publish).toHaveBeenCalledWith(
      'epic.updated',
      expect.objectContaining({
        epicId: baseEpic.id,
        changes: expect.objectContaining({
          title: { previous: baseEpic.title, current: 'Updated Title' },
        }),
      }),
    );
    expect(eventsService.publish).not.toHaveBeenCalledWith('epic.assigned', expect.anything());
  });

  it('publishes epic.updated on re-assignment to same agent', async () => {
    storage.getEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-7' });
    storage.updateEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-7', version: 2 });
    storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
    storage.getAgent.mockResolvedValue({ id: 'agent-7', name: 'Agent Seven' });
    await service.updateEpic(baseEpic.id, { agentId: 'agent-7' }, baseEpic.version);
    expect(eventsService.publish).toHaveBeenCalledWith(
      'epic.updated',
      expect.objectContaining({
        changes: expect.objectContaining({
          agentId: expect.objectContaining({ previous: 'agent-7', current: 'agent-7' }),
        }),
      }),
    );
  });

  it('does not include agentId in changes when agentId not in update data', async () => {
    storage.getEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-7', statusId: 'status-1' });
    storage.updateEpic.mockResolvedValue({
      ...baseEpic,
      agentId: 'agent-7',
      statusId: 'status-2',
      version: 2,
    });
    storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
    storage.getStatus
      .mockResolvedValueOnce({ id: 'status-1', label: 'Backlog' })
      .mockResolvedValueOnce({ id: 'status-2', label: 'In Progress' });
    await service.updateEpic(baseEpic.id, { statusId: 'status-2' }, baseEpic.version);
    const changes = eventsService.publish.mock.calls[0][1].changes;
    expect(changes.statusId).toBeDefined();
    expect(changes.agentId).toBeUndefined();
  });

  it('includes actor context in re-assignment event', async () => {
    storage.getEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-7' });
    storage.updateEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-7', version: 2 });
    storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
    storage.getAgent.mockResolvedValue({ id: 'agent-7', name: 'Agent Seven' });
    const actor = { type: 'agent' as const, id: 'agent-2' };
    await service.updateEpic(baseEpic.id, { agentId: 'agent-7' }, baseEpic.version, { actor });
    expect(eventsService.publish).toHaveBeenCalledWith(
      'epic.updated',
      expect.objectContaining({ actor }),
    );
  });

  it('publishes epic.updated on reassignment from A to B', async () => {
    storage.getEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-A' });
    storage.updateEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-B', version: 2 });
    storage.getProject.mockResolvedValue({ id: baseEpic.projectId, name: 'Demo Project' });
    storage.getAgent.mockResolvedValue({
      id: 'agent-B',
      name: 'Agent B',
      projectId: baseEpic.projectId,
    });
    await service.updateEpic(baseEpic.id, { agentId: 'agent-B' }, baseEpic.version);
    expect(eventsService.publish).toHaveBeenCalledWith(
      'epic.updated',
      expect.objectContaining({
        changes: expect.objectContaining({
          agentId: expect.objectContaining({ previous: 'agent-A', current: 'agent-B' }),
        }),
      }),
    );
  });

  it('does not publish epic.assigned when agent is removed', async () => {
    storage.getEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-7' });
    storage.updateEpic.mockResolvedValue({ ...baseEpic, agentId: null, version: 2 });
    storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
    storage.getAgent.mockResolvedValue({ id: 'agent-7', name: 'Agent 7' });
    await service.updateEpic(baseEpic.id, { agentId: null }, baseEpic.version);
    expect(eventsService.publish).toHaveBeenCalledWith(
      'epic.updated',
      expect.objectContaining({
        changes: expect.objectContaining({
          agentId: expect.objectContaining({ previous: 'agent-7', current: null }),
        }),
      }),
    );
    expect(eventsService.publish).not.toHaveBeenCalledWith('epic.assigned', expect.anything());
  });

  it('publishes epic.deleted event on delete', async () => {
    storage.getEpic.mockResolvedValue(baseEpic);
    storage.deleteEpic.mockResolvedValue(undefined);
    await service.deleteEpic(baseEpic.id);
    expect(storage.deleteEpic).toHaveBeenCalledWith(baseEpic.id, expect.any(Function));
    expect(eventsService.publish).toHaveBeenCalledWith(
      'epic.deleted',
      expect.objectContaining({
        epicId: baseEpic.id,
        projectId: baseEpic.projectId,
        title: baseEpic.title,
        parentId: baseEpic.parentId ?? null,
        actor: null,
      }),
    );
    expect(eventsService.publish).toHaveBeenCalledWith('epic.relations.invalidated', {
      workspaceId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('publishes epic.deleted actor from operation context when provided', async () => {
    storage.getEpic.mockResolvedValue(baseEpic);
    storage.deleteEpic.mockResolvedValue(undefined);
    const actor = { type: 'agent' as const, id: 'agent-2' };

    await service.deleteEpic(baseEpic.id, { actor });

    expect(eventsService.publish).toHaveBeenCalledWith(
      'epic.deleted',
      expect.objectContaining({
        epicId: baseEpic.id,
        actor,
      }),
    );
  });

  it('does not invalidate relations when Epic deletion fails', async () => {
    storage.getEpic.mockResolvedValue(baseEpic);
    storage.deleteEpic.mockRejectedValue(new Error('delete rolled back'));

    await expect(service.deleteEpic(baseEpic.id)).rejects.toThrow('delete rolled back');

    expect(eventsService.publish).not.toHaveBeenCalledWith(
      'epic.relations.invalidated',
      expect.anything(),
    );
  });

  it('publishes epic.created domain event on createEpicForProject', async () => {
    storage.createEpicForProject.mockResolvedValue(baseEpic);
    await service.createEpicForProject(baseEpic.projectId, {
      title: baseEpic.title,
    } as unknown as CreateEpic);
    expect(eventsService.publish).toHaveBeenCalledWith(
      'epic.created',
      expect.objectContaining({ epicId: baseEpic.id, projectId: baseEpic.projectId }),
    );
  });

  describe('bulkUpdateEpics', () => {
    const parentEpic: Epic = {
      ...baseEpic,
      id: 'parent-1',
      parentId: null,
      statusId: 'status-parent',
      agentId: null,
    };
    const childEpic: Epic = {
      ...baseEpic,
      id: 'child-1',
      parentId: 'parent-1',
      statusId: 'status-child',
      agentId: 'agent-1',
    };

    it('updates only changed epics and skips no-op entries', async () => {
      storage.getEpic.mockResolvedValueOnce(parentEpic).mockResolvedValueOnce(childEpic);
      const updateSpy = jest
        .spyOn(service, 'updateEpic')
        .mockImplementation(async (id, data, version) => {
          const base = id === parentEpic.id ? parentEpic : childEpic;
          return { ...base, ...data, version: version + 1 } as Epic;
        });
      const result = await service.bulkUpdateEpics(
        [
          { id: parentEpic.id, version: parentEpic.version },
          {
            id: childEpic.id,
            statusId: 'status-updated',
            agentId: null,
            version: childEpic.version,
          },
        ],
        parentEpic.id,
      );
      expect(storage.getEpic).toHaveBeenCalledTimes(2);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: childEpic.id,
        statusId: 'status-updated',
        agentId: null,
      });
    });

    it('throws when epics span multiple projects', async () => {
      storage.getEpic
        .mockResolvedValueOnce(parentEpic)
        .mockResolvedValueOnce({ ...childEpic, projectId: 'other-project' });
      jest.spyOn(service, 'updateEpic').mockResolvedValue(parentEpic);
      await expect(
        service.bulkUpdateEpics(
          [
            { id: parentEpic.id, statusId: 'status-2', version: parentEpic.version },
            { id: childEpic.id, statusId: 'status-3', version: childEpic.version },
          ],
          parentEpic.id,
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('throws when an epic is outside the expected parent hierarchy', async () => {
      storage.getEpic
        .mockResolvedValueOnce(parentEpic)
        .mockResolvedValueOnce({ ...childEpic, parentId: 'other-parent' });
      jest.spyOn(service, 'updateEpic').mockResolvedValue(parentEpic);
      await expect(
        service.bulkUpdateEpics(
          [
            { id: parentEpic.id, statusId: 'status-2', version: parentEpic.version },
            { id: childEpic.id, statusId: 'status-3', version: childEpic.version },
          ],
          parentEpic.id,
        ),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('hierarchy validation', () => {
    it('throws ValidationError when moving an epic that has sub-epics under another parent', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, id: 'epic-A', title: 'Child A' });
      storage.listSubEpics.mockResolvedValue({
        items: [{ id: 'sub-A1' }, { id: 'sub-A2' }],
        total: 2,
      });
      await expect(service.updateEpic('epic-A', { parentId: 'epic-B' }, 1)).rejects.toThrow(
        ValidationError,
      );
      expect(storage.updateEpic).not.toHaveBeenCalled();
    });

    it('allows moving a childless epic under a parent', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, id: 'epic-A' });
      storage.listSubEpics.mockResolvedValue({ items: [], total: 0 });
      storage.updateEpic.mockResolvedValue({
        ...baseEpic,
        id: 'epic-A',
        parentId: 'epic-B',
        version: 2,
      });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo' });
      const result = await service.updateEpic('epic-A', { parentId: 'epic-B' }, 1);
      expect(result.parentId).toBe('epic-B');
    });

    it('allows clearing parentId even when epic has sub-epics', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, id: 'epic-A', parentId: 'epic-B' });
      storage.listSubEpics.mockResolvedValue({ items: [{ id: 'sub-A1' }], total: 1 });
      storage.updateEpic.mockResolvedValue({
        ...baseEpic,
        id: 'epic-A',
        parentId: null,
        version: 2,
      });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo' });
      const result = await service.updateEpic('epic-A', { parentId: null }, 1);
      expect(result.parentId).toBeNull();
    });
  });

  describe('description edits', () => {
    it('resolves edits against the read epic and writes the final text as a plain description', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, description: 'alpha beta gamma' });
      storage.updateEpic.mockImplementation(
        async (_id: string, data: { description?: string }) => ({
          ...baseEpic,
          description: data.description ?? null,
          version: 2,
        }),
      );

      const result = await service.updateEpicWithOutcome(
        baseEpic.id,
        {
          descriptionEdits: [
            { find: 'beta', replace: 'BETA' },
            { find: 'gamma', replace: 'delta' },
          ],
        },
        baseEpic.version,
      );

      expect(storage.updateEpic).toHaveBeenCalledWith(
        baseEpic.id,
        expect.objectContaining({ description: 'alpha BETA delta' }),
        baseEpic.version,
        expect.any(Function),
      );
      const payload = (storage.updateEpic as jest.Mock).mock.calls[0][1] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('descriptionEdits');
      expect(payload).not.toHaveProperty('appendDescription');

      expect(result.epic.description).toBe('alpha BETA delta');
      expect(result.outcome.descriptionEdit).toMatchObject({
        text: 'alpha BETA delta',
        descriptionLength: 16,
      });
      expect(result.outcome.descriptionEdit?.descriptionEdits).toEqual([
        { index: 0, context: 'alpha BETA delta' },
        { index: 1, context: 'alpha BETA delta' },
      ]);
      expect(result.outcome.descriptionEdit?.appended).toBeUndefined();
    });

    it('appends after edits and reports the append junction', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, description: 'alpha beta' });
      storage.updateEpic.mockImplementation(
        async (_id: string, data: { description?: string }) => ({
          ...baseEpic,
          description: data.description ?? null,
          version: 2,
        }),
      );

      const result = await service.updateEpic(
        baseEpic.id,
        {
          descriptionEdits: [{ find: 'beta', replace: 'gamma' }],
          appendDescription: 'tail',
        },
        baseEpic.version,
      );

      expect(result.description).toBe('alpha gamma\n\ntail');
    });

    it('makes an append on a null description the full text', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, description: null });
      storage.updateEpic.mockImplementation(
        async (_id: string, data: { description?: string }) => ({
          ...baseEpic,
          description: data.description ?? null,
          version: 2,
        }),
      );

      const result = await service.updateEpicWithOutcome(
        baseEpic.id,
        { appendDescription: 'first text' },
        baseEpic.version,
      );

      expect(result.outcome.descriptionEdit?.text).toBe('first text');
      expect(result.outcome.descriptionEdit?.appended).toEqual({ context: 'first text' });
      expect(result.outcome.descriptionEdit?.descriptionEdits).toBeUndefined();
    });

    it('throws the edit error before any storage write', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, description: 'alpha' });

      await expect(
        service.updateEpic(baseEpic.id, { descriptionEdits: [{ find: 'zeta', replace: 'X' }] }, 1),
      ).rejects.toThrow(DescriptionEditNotFoundError);
      expect(storage.updateEpic).not.toHaveBeenCalled();
    });

    it('keeps a full description replace free of edit outcomes', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, description: 'old' });
      storage.updateEpic.mockResolvedValue({ ...baseEpic, description: 'new', version: 2 });

      const result = await service.updateEpicWithOutcome(
        baseEpic.id,
        { description: 'new' },
        baseEpic.version,
      );

      expect(result.outcome.descriptionEdit).toBeUndefined();
    });
  });

  describe('addEpicComment', () => {
    const storedAgentComment = {
      id: 'comment-1',
      epicId: 'epic-1',
      authorName: 'Test Agent',
      content: 'Hello world',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    it('prepares the exact-agent comment fact inside the storage transaction and emits it after commit', async () => {
      storage.getEpic.mockResolvedValue(baseEpic);
      storage.getAgent.mockResolvedValue({ id: 'agent-1', name: 'Test Agent' });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Test Project' });
      storage.createEpicComment.mockResolvedValue(storedAgentComment);
      const result = await service.addEpicComment(
        'epic-1',
        'project-1',
        'Hello world',
        'agent-1',
        'agent',
      );
      expect(result.id).toBe('comment-1');
      expect(storage.createEpicComment).toHaveBeenCalledWith(
        { epicId: 'epic-1', authorName: 'Test Agent', content: 'Hello world' },
        expect.any(Function),
      );
      expect(eventsService.prepareCommitted).toHaveBeenCalledWith(
        'epic.comment.created',
        expect.objectContaining({
          commentId: 'comment-1',
          epicId: 'epic-1',
          projectId: 'project-1',
          parentId: null,
          authorName: 'Test Agent',
          content: 'Hello world',
          actor: { type: 'agent', id: 'agent-1' },
          projectName: 'Test Project',
          epicTitle: 'Initial Epic',
          agentName: 'Test Agent',
          recipientIds: [],
        }),
      );
      expect(eventsService.emitCommitted).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'prepared-event', name: 'epic.comment.created' }),
      );
    });

    it('emits the committed comment fact only after the storage call resolves', async () => {
      storage.getEpic.mockResolvedValue(baseEpic);
      storage.getAgent.mockResolvedValue({ id: 'agent-1', name: 'Test Agent' });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Test Project' });
      const order: string[] = [];
      storage.createEpicComment.mockImplementation(async () => {
        order.push('storage-resolved');
        return storedAgentComment;
      });
      const innerEmit = eventsService.emitCommitted;
      eventsService.emitCommitted = jest.fn((event) => {
        order.push('emit');
        innerEmit(event);
      });

      await service.addEpicComment('epic-1', 'project-1', 'Hello world', 'agent-1', 'agent');

      expect(order).toEqual(['storage-resolved', 'emit']);
    });

    it('rejects the exact-agent comment when event validation fails inside the transaction', async () => {
      storage.getEpic.mockResolvedValue(baseEpic);
      storage.getAgent.mockResolvedValue({ id: 'agent-1', name: 'Test Agent' });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Test Project' });
      storage.createEpicComment.mockResolvedValue(storedAgentComment);
      eventsService.prepareCommitted.mockImplementation(() => {
        throw new Error('event payload rejected');
      });

      await expect(
        service.addEpicComment('epic-1', 'project-1', 'Hello world', 'agent-1', 'agent'),
      ).rejects.toThrow('event payload rejected');
      expect(eventsService.emitCommitted).not.toHaveBeenCalled();
    });

    it('keeps the project-name lookup non-fatal for the exact-agent comment fact', async () => {
      storage.getEpic.mockResolvedValue(baseEpic);
      storage.getAgent.mockResolvedValue({ id: 'agent-1', name: 'Test Agent' });
      storage.getProject.mockRejectedValue(new Error('project row missing'));
      storage.createEpicComment.mockResolvedValue(storedAgentComment);

      const result = await service.addEpicComment(
        'epic-1',
        'project-1',
        'Hello world',
        'agent-1',
        'agent',
      );

      expect(result.id).toBe('comment-1');
      const payload = eventsService.prepareCommitted.mock.calls[0]![1] as Record<string, unknown>;
      expect(payload.projectName).toBeUndefined();
      expect(eventsService.emitCommitted).toHaveBeenCalled();
    });

    it('throws ValidationError on project-boundary mismatch', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, projectId: 'other-project' });
      await expect(
        service.addEpicComment('epic-1', 'project-1', 'Hello', 'agent-1', 'agent'),
      ).rejects.toThrow(ValidationError);
      expect(storage.createEpicComment).not.toHaveBeenCalled();
    });

    it('resolves guest author name correctly and publishes best-effort', async () => {
      storage.getEpic.mockResolvedValue(baseEpic);
      storage.getGuest.mockResolvedValue({ id: 'guest-1', name: 'Test Guest' });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Test Project' });
      storage.createEpicComment.mockResolvedValue({
        id: 'comment-2',
        epicId: 'epic-1',
        authorName: 'Test Guest',
        content: 'Guest comment',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      const result = await service.addEpicComment(
        'epic-1',
        'project-1',
        'Guest comment',
        'guest-1',
        'guest',
      );
      expect(result.authorName).toBe('Test Guest');
      expect(storage.getGuest).toHaveBeenCalledWith('guest-1');
      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.comment.created',
        expect.objectContaining({
          commentId: 'comment-2',
          actor: { type: 'guest', id: 'guest-1' },
        }),
      );
      expect(eventsService.prepareCommitted).not.toHaveBeenCalledWith(
        'epic.comment.created',
        expect.anything(),
      );
    });

    it('still returns the guest comment when the best-effort publish fails', async () => {
      storage.getEpic.mockResolvedValue(baseEpic);
      storage.getGuest.mockResolvedValue({ id: 'guest-1', name: 'Test Guest' });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Test Project' });
      storage.createEpicComment.mockResolvedValue({
        id: 'comment-3',
        epicId: 'epic-1',
        authorName: 'Test Guest',
        content: 'Resilient',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      eventsService.publish.mockRejectedValue(new Error('event broker down'));
      const result = await service.addEpicComment(
        'epic-1',
        'project-1',
        'Resilient',
        'guest-1',
        'guest',
      );
      expect(result.id).toBe('comment-3');
    });
  });

  describe('addEpicCommentFromRest', () => {
    it('persists REST comment and publishes epic.comment.created with parentId context', async () => {
      storage.getEpic.mockResolvedValue({
        ...baseEpic,
        id: 'sub-epic-1',
        parentId: 'parent-1',
        title: 'Sub Epic',
        projectId: 'project-1',
      });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Test Project' });
      storage.createEpicComment.mockResolvedValue({
        id: 'comment-rest-1',
        epicId: 'sub-epic-1',
        authorName: 'REST User',
        content: 'REST comment',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });

      const result = await service.addEpicCommentFromRest(
        'sub-epic-1',
        'REST User',
        'REST comment',
      );

      expect(result.id).toBe('comment-rest-1');
      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.comment.created',
        expect.objectContaining({
          commentId: 'comment-rest-1',
          epicId: 'sub-epic-1',
          projectId: 'project-1',
          parentId: 'parent-1',
          authorName: 'REST User',
          content: 'REST comment',
          actor: null,
        }),
      );
    });

    it('returns REST comment even when event publish fails', async () => {
      storage.getEpic.mockResolvedValue(baseEpic);
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Test Project' });
      storage.createEpicComment.mockResolvedValue({
        id: 'comment-rest-2',
        epicId: 'epic-1',
        authorName: 'REST User',
        content: 'Resilient REST path',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      eventsService.publish.mockRejectedValue(new Error('event broker down'));

      const result = await service.addEpicCommentFromRest(
        'epic-1',
        'REST User',
        'Resilient REST path',
      );

      expect(result.id).toBe('comment-rest-2');
    });
  });

  describe('updateEpicWithOutcome', () => {
    const agentEpic: Epic = { ...baseEpic, agentId: 'agent-1' };
    beforeEach(() => {
      storage.getAgent.mockResolvedValue({ id: 'agent-1', name: 'Test Agent' });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Test Project' });
      storage.getStatus.mockResolvedValue({ id: 'status-2', label: 'Done' });
    });

    it('status change with no agent change', async () => {
      storage.getEpic.mockResolvedValue({ ...agentEpic, statusId: 'status-1' });
      storage.updateEpic.mockResolvedValue({ ...agentEpic, statusId: 'status-2', version: 2 });
      const result = await service.updateEpicWithOutcome('epic-1', { statusId: 'status-2' }, 1);
      expect(result.outcome.statusChanged).toBe(true);
      expect(result.outcome.agentUnchanged).toBe(true);
      expect(result.outcome.previousAssigneeAgent).toEqual({ id: 'agent-1', name: 'Test Agent' });
    });

    it('status change with auto-clean', async () => {
      storage.getEpic.mockResolvedValue({ ...agentEpic, statusId: 'status-1' });
      storage.updateEpic.mockResolvedValue({ ...baseEpic, statusId: 'status-2', version: 2 });
      settingsService.getAutoCleanStatusIds.mockReturnValue(['status-2']);
      const result = await service.updateEpicWithOutcome('epic-1', { statusId: 'status-2' }, 1);
      expect(result.outcome.statusChanged).toBe(true);
      expect(result.outcome.agentUnchanged).toBe(false);
    });

    it('status change with explicit agent change', async () => {
      storage.getEpic.mockResolvedValue({ ...agentEpic, statusId: 'status-1' });
      storage.updateEpic.mockResolvedValue({
        ...baseEpic,
        agentId: 'agent-2',
        statusId: 'status-2',
        version: 2,
      });
      const result = await service.updateEpicWithOutcome(
        'epic-1',
        { statusId: 'status-2', agentId: 'agent-2' },
        1,
      );
      expect(result.outcome.statusChanged).toBe(true);
      expect(result.outcome.agentUnchanged).toBe(false);
    });

    it('no status change', async () => {
      storage.getEpic.mockResolvedValue({ ...agentEpic });
      storage.updateEpic.mockResolvedValue({ ...agentEpic, title: 'Updated Title', version: 2 });
      const result = await service.updateEpicWithOutcome('epic-1', { title: 'Updated Title' }, 1);
      expect(result.outcome.statusChanged).toBe(false);
      expect(result.outcome.agentUnchanged).toBe(true);
    });

    it('previousAssigneeAgent is null when before had no agent', async () => {
      storage.getEpic.mockResolvedValue(baseEpic);
      storage.updateEpic.mockResolvedValue({ ...baseEpic, statusId: 'status-2', version: 2 });
      const result = await service.updateEpicWithOutcome('epic-1', { statusId: 'status-2' }, 1);
      expect(result.outcome.previousAssigneeAgent).toBeNull();
    });
  });
});
