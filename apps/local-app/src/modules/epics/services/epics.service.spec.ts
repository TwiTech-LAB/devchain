import { EpicsService } from './epics.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { EventsService } from '../../events/services/events.service';
import type { SettingsService } from '../../settings/services/settings.service';
import type { CreateEpic, Epic } from '../../storage/models/domain.models';
import type { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import { ValidationError } from '../../../common/errors/error-types';

describe('EpicsService', () => {
  let storage: {
    createEpic: jest.Mock;
    createEpicForProject: jest.Mock;
    getEpic: jest.Mock;
    updateEpic: jest.Mock;
    deleteEpic: jest.Mock;
    getProject: jest.Mock;
    getAgent: jest.Mock;
    getStatus: jest.Mock;
    listSubEpics: jest.Mock;
  };
  let eventsService: { publish: jest.Mock };
  let settingsService: { getSetting: jest.Mock; getAutoCleanStatusIds: jest.Mock };
  let terminalGateway: { broadcastEvent: jest.Mock };
  let service: EpicsService;

  const baseEpic: Epic = {
    id: 'epic-1',
    projectId: 'project-1',
    title: 'Initial Epic',
    description: null,
    statusId: 'status-1',
    parentId: null,
    agentId: null,
    version: 1,
    data: null,
    tags: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    storage = {
      createEpic: jest.fn(),
      createEpicForProject: jest.fn(),
      getEpic: jest.fn(),
      updateEpic: jest.fn(),
      deleteEpic: jest.fn(),
      getProject: jest.fn(),
      getAgent: jest.fn(),
      getStatus: jest.fn(),
      listSubEpics: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    };

    eventsService = {
      publish: jest.fn().mockResolvedValue('event-id'),
    };

    settingsService = {
      getSetting: jest.fn(),
      getAutoCleanStatusIds: jest.fn().mockReturnValue([]),
    };

    terminalGateway = {
      broadcastEvent: jest.fn(),
    };

    service = new EpicsService(
      storage as unknown as StorageService,
      eventsService as unknown as EventsService,
      settingsService as unknown as SettingsService,
      terminalGateway as unknown as TerminalGateway,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('broadcasts created epic snapshot on create', async () => {
    storage.createEpic.mockResolvedValue(baseEpic);

    await service.createEpic(baseEpic as unknown as CreateEpic);

    expect(terminalGateway.broadcastEvent).toHaveBeenCalledWith(
      `project/${baseEpic.projectId}/epics`,
      'created',
      expect.objectContaining({
        epic: expect.objectContaining({
          id: baseEpic.id,
          title: baseEpic.title,
          statusId: baseEpic.statusId,
        }),
      }),
    );
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

    it('includes resolved names in epic.created payload', async () => {
      const epicWithAgent: Epic = {
        ...baseEpic,
        agentId: 'agent-1',
        parentId: 'parent-1',
      };
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
          projectId: epicWithAgent.projectId,
          title: epicWithAgent.title,
          statusId: epicWithAgent.statusId,
          agentId: 'agent-1',
          parentId: 'parent-1',
          projectName: 'My Project',
          statusName: 'New',
          agentName: 'Coder',
          parentTitle: 'Parent Epic',
        }),
      );
    });

    it('publishes epic.created even when name resolution fails (graceful degradation)', async () => {
      storage.createEpic.mockResolvedValue(baseEpic);
      storage.getProject.mockRejectedValue(new Error('Not found'));
      storage.getStatus.mockRejectedValue(new Error('Not found'));

      await service.createEpic(baseEpic as unknown as CreateEpic);

      // Event should still be published with IDs, but without resolved names
      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.created',
        expect.objectContaining({
          epicId: baseEpic.id,
          projectId: baseEpic.projectId,
          title: baseEpic.title,
          statusId: baseEpic.statusId,
        }),
      );
      // Verify resolved names are NOT included when lookup fails
      const publishCall = eventsService.publish.mock.calls[0];
      expect(publishCall[1].projectName).toBeUndefined();
      expect(publishCall[1].statusName).toBeUndefined();
    });
  });

  describe('epic.updated event', () => {
    it('publishes epic.updated with status change and resolved names', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, statusId: 'status-old' });
      storage.updateEpic.mockResolvedValue({
        ...baseEpic,
        statusId: 'status-new',
        version: baseEpic.version + 1,
      });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
      storage.getStatus
        .mockResolvedValueOnce({ id: 'status-old', label: 'Backlog' })
        .mockResolvedValueOnce({ id: 'status-new', label: 'In Progress' });

      await service.updateEpic(baseEpic.id, { statusId: 'status-new' }, baseEpic.version);

      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.updated',
        expect.objectContaining({
          epicId: baseEpic.id,
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
      storage.updateEpic.mockResolvedValue({
        ...baseEpic,
        agentId: 'agent-B',
        version: baseEpic.version + 1,
      });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
      storage.getAgent
        .mockResolvedValueOnce({ id: 'agent-A', name: 'Coder' })
        .mockResolvedValueOnce({ id: 'agent-B', name: 'Reviewer' });

      await service.updateEpic(baseEpic.id, { agentId: 'agent-B' }, baseEpic.version);

      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.updated',
        expect.objectContaining({
          epicId: baseEpic.id,
          changes: expect.objectContaining({
            agentId: expect.objectContaining({
              previous: 'agent-A',
              current: 'agent-B',
              previousName: 'Coder',
              currentName: 'Reviewer',
            }),
          }),
        }),
      );
    });

    it('publishes epic.updated with parent change and resolved titles', async () => {
      storage.getEpic
        .mockResolvedValueOnce({ ...baseEpic, parentId: 'parent-A' }) // before
        .mockResolvedValueOnce({ id: 'parent-A', title: 'Old Parent' }) // previous parent
        .mockResolvedValueOnce({ id: 'parent-B', title: 'New Parent' }); // current parent
      storage.updateEpic.mockResolvedValue({
        ...baseEpic,
        parentId: 'parent-B',
        version: baseEpic.version + 1,
      });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });

      await service.updateEpic(baseEpic.id, { parentId: 'parent-B' }, baseEpic.version);

      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.updated',
        expect.objectContaining({
          epicId: baseEpic.id,
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

    it('publishes epic.updated with multiple fields changed', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, statusId: 'status-old', agentId: null });
      storage.updateEpic.mockResolvedValue({
        ...baseEpic,
        title: 'New Title',
        statusId: 'status-new',
        agentId: 'agent-1',
        version: baseEpic.version + 1,
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
          changes: expect.objectContaining({
            title: { previous: baseEpic.title, current: 'New Title' },
            statusId: expect.objectContaining({
              previous: 'status-old',
              current: 'status-new',
            }),
            agentId: expect.objectContaining({
              previous: null,
              current: 'agent-1',
            }),
          }),
        }),
      );
    });

    it('does NOT publish epic.updated for no-op status change', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, statusId: 'status-1' });
      storage.updateEpic.mockResolvedValue({
        ...baseEpic,
        statusId: 'status-1',
        version: baseEpic.version + 1,
      });

      await service.updateEpic(baseEpic.id, { statusId: 'status-1' }, baseEpic.version);

      expect(eventsService.publish).not.toHaveBeenCalled();
    });

    it('changes object only includes changed fields, not unchanged ones', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-1', statusId: 'status-1' });
      storage.updateEpic.mockResolvedValue({
        ...baseEpic,
        agentId: 'agent-1', // unchanged
        statusId: 'status-2', // changed
        version: baseEpic.version + 1,
      });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
      storage.getStatus
        .mockResolvedValueOnce({ id: 'status-1', label: 'Backlog' })
        .mockResolvedValueOnce({ id: 'status-2', label: 'In Progress' });

      await service.updateEpic(baseEpic.id, { statusId: 'status-2' }, baseEpic.version);

      const publishCall = eventsService.publish.mock.calls[0];
      const changes = publishCall[1].changes;

      // statusId should be present
      expect(changes.statusId).toBeDefined();
      // agentId should NOT be present (unchanged)
      expect(changes.agentId).toBeUndefined();
      // title should NOT be present (unchanged)
      expect(changes.title).toBeUndefined();
      // parentId should NOT be present (unchanged)
      expect(changes.parentId).toBeUndefined();
    });

    it('does NOT publish epic.updated for cascade clears (auto-clean sub-epics)', async () => {
      const parentEpic: Epic = {
        ...baseEpic,
        id: 'parent-epic',
        statusId: 'status-old',
      };
      const subEpic: Epic = {
        ...baseEpic,
        id: 'sub-epic',
        parentId: 'parent-epic',
        agentId: 'agent-1',
      };

      // Parent epic update: moving to auto-clean status
      storage.getEpic
        .mockResolvedValueOnce(parentEpic) // before check
        .mockResolvedValueOnce({ ...subEpic, agentId: null }); // after cascade clear (for broadcast)
      storage.updateEpic
        .mockResolvedValueOnce({ ...parentEpic, statusId: 'auto-clean-status', version: 2 }) // parent update
        .mockResolvedValueOnce({ ...subEpic, agentId: null, version: 2 }); // cascade clear (direct storage call)
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
      storage.getStatus
        .mockResolvedValueOnce({ id: 'status-old', label: 'Backlog' })
        .mockResolvedValueOnce({ id: 'auto-clean-status', label: 'Done' });
      storage.listSubEpics
        .mockResolvedValueOnce({ items: [subEpic], total: 1 }) // First call returns subEpic
        .mockResolvedValue({ items: [], total: 0 }); // Subsequent calls return empty (no nested sub-epics)
      settingsService.getAutoCleanStatusIds.mockReturnValue(['auto-clean-status']);

      await service.updateEpic(
        parentEpic.id,
        { statusId: 'auto-clean-status' },
        parentEpic.version,
      );

      // epic.updated should be published for the PARENT status change
      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.updated',
        expect.objectContaining({
          epicId: 'parent-epic',
          changes: expect.objectContaining({
            statusId: expect.anything(),
          }),
        }),
      );

      // epic.updated should NOT be published for the sub-epic cascade clear
      // (cascade uses direct storage.updateEpic, not service.updateEpic)
      expect(eventsService.publish).not.toHaveBeenCalledWith(
        'epic.updated',
        expect.objectContaining({
          epicId: 'sub-epic',
        }),
      );

      // But WS broadcast SHOULD happen for sub-epic (UI sync only)
      expect(terminalGateway.broadcastEvent).toHaveBeenCalledWith(
        `project/${subEpic.projectId}/epics`,
        'updated',
        expect.objectContaining({
          epic: expect.objectContaining({ id: 'sub-epic', agentId: null }),
        }),
      );
    });
  });

  it('publishes epic.updated when agent changes to a new value', async () => {
    storage.getEpic.mockResolvedValue(baseEpic);
    storage.updateEpic.mockResolvedValue({
      ...baseEpic,
      agentId: 'agent-9',
      version: baseEpic.version + 1,
    });
    storage.getProject.mockResolvedValue({
      id: baseEpic.projectId,
      name: 'Demo Project',
      description: null,
      rootPath: '/tmp',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getAgent.mockResolvedValue({
      id: 'agent-9',
      name: 'Helper Agent',
      projectId: baseEpic.projectId,
      profileId: 'profile-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    await service.updateEpic(baseEpic.id, { agentId: 'agent-9' }, baseEpic.version);

    expect(eventsService.publish).toHaveBeenCalledWith(
      'epic.updated',
      expect.objectContaining({
        epicId: baseEpic.id,
        projectId: baseEpic.projectId,
        changes: expect.objectContaining({
          agentId: expect.objectContaining({
            previous: null,
            current: 'agent-9',
          }),
        }),
      }),
    );

    expect(terminalGateway.broadcastEvent).toHaveBeenCalledWith(
      `project/${baseEpic.projectId}/epics`,
      'updated',
      expect.objectContaining({
        epic: expect.objectContaining({
          id: baseEpic.id,
          agentId: 'agent-9',
        }),
        changes: expect.objectContaining({
          agentId: { previous: null, current: 'agent-9' },
        }),
      }),
    );
  });

  it('does not publish epic.assigned when agentId is unchanged (but publishes epic.updated for title)', async () => {
    storage.getEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-7' });
    storage.updateEpic.mockResolvedValue({
      ...baseEpic,
      agentId: 'agent-7',
      title: 'Updated Title',
      version: baseEpic.version + 1,
    });
    storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });

    await service.updateEpic(baseEpic.id, { title: 'Updated Title' }, baseEpic.version);

    // epic.updated IS published for the title change
    expect(eventsService.publish).toHaveBeenCalledWith(
      'epic.updated',
      expect.objectContaining({
        epicId: baseEpic.id,
        changes: expect.objectContaining({
          title: { previous: baseEpic.title, current: 'Updated Title' },
        }),
      }),
    );
    // epic.assigned is NOT published when agentId is unchanged
    expect(eventsService.publish).not.toHaveBeenCalledWith('epic.assigned', expect.anything());
    expect(terminalGateway.broadcastEvent).toHaveBeenCalledWith(
      `project/${baseEpic.projectId}/epics`,
      'updated',
      expect.objectContaining({
        epic: expect.objectContaining({ title: 'Updated Title' }),
        changes: expect.objectContaining({
          title: { previous: baseEpic.title, current: 'Updated Title' },
        }),
      }),
    );
  });

  it('does not publish when explicit agentId equals current (no-op)', async () => {
    storage.getEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-7' });
    storage.updateEpic.mockResolvedValue({
      ...baseEpic,
      agentId: 'agent-7',
      version: baseEpic.version + 1,
    });

    // Explicitly pass the same agentId - should be a no-op
    await service.updateEpic(baseEpic.id, { agentId: 'agent-7' }, baseEpic.version);

    expect(eventsService.publish).not.toHaveBeenCalled();
  });

  it('publishes epic.updated on reassignment from A to B with previousAgentId', async () => {
    storage.getEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-A' });
    storage.updateEpic.mockResolvedValue({
      ...baseEpic,
      agentId: 'agent-B',
      version: baseEpic.version + 1,
    });
    storage.getProject.mockResolvedValue({
      id: baseEpic.projectId,
      name: 'Demo Project',
      description: null,
      rootPath: '/tmp',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getAgent.mockResolvedValue({
      id: 'agent-B',
      name: 'Agent B',
      projectId: baseEpic.projectId,
      profileId: 'profile-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    await service.updateEpic(baseEpic.id, { agentId: 'agent-B' }, baseEpic.version);

    expect(eventsService.publish).toHaveBeenCalledWith(
      'epic.updated',
      expect.objectContaining({
        epicId: baseEpic.id,
        projectId: baseEpic.projectId,
        changes: expect.objectContaining({
          agentId: expect.objectContaining({
            previous: 'agent-A',
            current: 'agent-B',
          }),
        }),
      }),
    );
  });

  it('does not publish epic.assigned when agent is removed (but publishes epic.updated)', async () => {
    storage.getEpic.mockResolvedValue({ ...baseEpic, agentId: 'agent-7' });
    storage.updateEpic.mockResolvedValue({
      ...baseEpic,
      agentId: null,
      version: baseEpic.version + 1,
    });
    storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Demo Project' });
    storage.getAgent.mockResolvedValue({ id: 'agent-7', name: 'Agent 7' });

    await service.updateEpic(baseEpic.id, { agentId: null }, baseEpic.version);

    // epic.updated IS published for the agent change
    expect(eventsService.publish).toHaveBeenCalledWith(
      'epic.updated',
      expect.objectContaining({
        epicId: baseEpic.id,
        changes: expect.objectContaining({
          agentId: expect.objectContaining({
            previous: 'agent-7',
            current: null,
          }),
        }),
      }),
    );
    // epic.assigned is NOT published when agent is removed
    expect(eventsService.publish).not.toHaveBeenCalledWith('epic.assigned', expect.anything());
    expect(terminalGateway.broadcastEvent).toHaveBeenCalledWith(
      `project/${baseEpic.projectId}/epics`,
      'updated',
      expect.objectContaining({
        epic: expect.objectContaining({ agentId: null }),
      }),
    );
  });

  it('broadcasts deleted event with project scope', async () => {
    storage.getEpic.mockResolvedValue(baseEpic);
    storage.deleteEpic.mockResolvedValue(undefined);

    await service.deleteEpic(baseEpic.id);

    expect(storage.deleteEpic).toHaveBeenCalledWith(baseEpic.id);
    expect(terminalGateway.broadcastEvent).toHaveBeenCalledWith(
      `project/${baseEpic.projectId}/epics`,
      'deleted',
      expect.objectContaining({
        epicId: baseEpic.id,
        projectId: baseEpic.projectId,
      }),
    );
  });

  it('broadcasts created epic snapshot on createEpicForProject', async () => {
    storage.createEpicForProject.mockResolvedValue(baseEpic);

    await service.createEpicForProject(baseEpic.projectId, {
      title: baseEpic.title,
    } as unknown as CreateEpic);

    expect(terminalGateway.broadcastEvent).toHaveBeenCalledWith(
      `project/${baseEpic.projectId}/epics`,
      'created',
      expect.objectContaining({
        epic: expect.objectContaining({ id: baseEpic.id }),
      }),
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
          { id: parentEpic.id, version: parentEpic.version }, // no-op
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

      let error: unknown;
      try {
        await service.bulkUpdateEpics(
          [
            { id: parentEpic.id, statusId: 'status-2', version: parentEpic.version },
            { id: childEpic.id, statusId: 'status-3', version: childEpic.version },
          ],
          parentEpic.id,
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(ValidationError);
      expect(storage.getEpic).toHaveBeenCalledTimes(2);
    });

    it('throws when an epic is outside the expected parent hierarchy', async () => {
      storage.getEpic
        .mockResolvedValueOnce(parentEpic)
        .mockResolvedValueOnce({ ...childEpic, parentId: 'other-parent' });
      jest.spyOn(service, 'updateEpic').mockResolvedValue(parentEpic);

      let error: unknown;
      try {
        await service.bulkUpdateEpics(
          [
            { id: parentEpic.id, statusId: 'status-2', version: parentEpic.version },
            { id: childEpic.id, statusId: 'status-3', version: childEpic.version },
          ],
          parentEpic.id,
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(ValidationError);
    });
  });
});
jest.mock('../../terminal/gateways/terminal.gateway', () => ({
  TerminalGateway: class {},
}));
