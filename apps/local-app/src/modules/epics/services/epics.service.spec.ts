import { EpicsService } from './epics.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { EventsService } from '../../events/services/events.service';
import type { SettingsService } from '../../settings/services/settings.service';
import type { CreateEpic, Epic } from '../../storage/models/domain.models';
import type { EventEmitter2 } from '@nestjs/event-emitter';
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
    getGuest: jest.Mock;
    getStatus: jest.Mock;
    listSubEpics: jest.Mock;
    createEpicComment: jest.Mock;
  };
  let eventsService: { publish: jest.Mock };
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
      getEpic: jest.fn(),
      updateEpic: jest.fn(),
      deleteEpic: jest.fn(),
      getProject: jest.fn(),
      getAgent: jest.fn(),
      getGuest: jest.fn(),
      getStatus: jest.fn(),
      listSubEpics: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      createEpicComment: jest.fn(),
    };
    eventsService = { publish: jest.fn().mockResolvedValue('event-id') };
    settingsService = {
      getSetting: jest.fn(),
      getAutoCleanStatusIds: jest.fn().mockReturnValue([]),
    };
    eventEmitter = { emit: jest.fn() };

    service = new EpicsService(
      storage as unknown as StorageService,
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
      );
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
    expect(storage.deleteEpic).toHaveBeenCalledWith(baseEpic.id);
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

  describe('addEpicComment', () => {
    it('persists comment and publishes epic.comment.created event', async () => {
      storage.getEpic.mockResolvedValue(baseEpic);
      storage.getAgent.mockResolvedValue({ id: 'agent-1', name: 'Test Agent' });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Test Project' });
      storage.createEpicComment.mockResolvedValue({
        id: 'comment-1',
        epicId: 'epic-1',
        authorName: 'Test Agent',
        content: 'Hello world',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      const result = await service.addEpicComment(
        'epic-1',
        'project-1',
        'Hello world',
        'agent-1',
        'agent',
      );
      expect(result.id).toBe('comment-1');
      expect(eventsService.publish).toHaveBeenCalledWith(
        'epic.comment.created',
        expect.objectContaining({
          commentId: 'comment-1',
          epicId: 'epic-1',
          projectId: 'project-1',
          parentId: null,
          authorName: 'Test Agent',
          content: 'Hello world',
          actor: { type: 'agent', id: 'agent-1' },
        }),
      );
    });

    it('throws ValidationError on project-boundary mismatch', async () => {
      storage.getEpic.mockResolvedValue({ ...baseEpic, projectId: 'other-project' });
      await expect(
        service.addEpicComment('epic-1', 'project-1', 'Hello', 'agent-1', 'agent'),
      ).rejects.toThrow(ValidationError);
      expect(storage.createEpicComment).not.toHaveBeenCalled();
    });

    it('resolves guest author name correctly', async () => {
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
    });

    it('still returns comment when event publish fails', async () => {
      storage.getEpic.mockResolvedValue(baseEpic);
      storage.getAgent.mockResolvedValue({ id: 'agent-1', name: 'Test Agent' });
      storage.getProject.mockResolvedValue({ id: 'project-1', name: 'Test Project' });
      storage.createEpicComment.mockResolvedValue({
        id: 'comment-3',
        epicId: 'epic-1',
        authorName: 'Test Agent',
        content: 'Resilient',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      eventsService.publish.mockRejectedValue(new Error('event broker down'));
      const result = await service.addEpicComment(
        'epic-1',
        'project-1',
        'Resilient',
        'agent-1',
        'agent',
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
