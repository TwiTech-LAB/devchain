import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { EventsService } from '../../events/services/events.service';
import type { SettingsService } from '../../settings/services/settings.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { ProjectsService } from './projects.service';

describe('ProjectsService relation invalidation on deletion', () => {
  const PROJECT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
  const WORKSPACE_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
  let storage: { getProject: jest.Mock; deleteProject: jest.Mock };
  let settings: {
    clearProjectTemplateMetadata: jest.Mock;
    clearProjectPresets: jest.Mock;
    setProjectActivePreset: jest.Mock;
  };
  let events: { publish: jest.Mock };
  let service: ProjectsService;

  beforeEach(() => {
    storage = {
      getProject: jest.fn().mockResolvedValue({ id: PROJECT_ID, workspaceId: WORKSPACE_ID }),
      deleteProject: jest.fn().mockResolvedValue(undefined),
    };
    settings = {
      clearProjectTemplateMetadata: jest.fn().mockResolvedValue(undefined),
      clearProjectPresets: jest.fn().mockResolvedValue(undefined),
      setProjectActivePreset: jest.fn().mockResolvedValue(undefined),
    };
    events = { publish: jest.fn().mockResolvedValue(null) };
    service = new ProjectsService(
      storage as unknown as StorageService,
      {} as never,
      settings as unknown as SettingsService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { emit: jest.fn() } as unknown as EventEmitter2,
      undefined,
      undefined,
      undefined,
      events as unknown as EventsService,
    );
  });

  it('captures workspace, commits deletion, publishes, then cleans settings', async () => {
    await service.deleteProject(PROJECT_ID);

    expect(storage.getProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(storage.deleteProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(events.publish).toHaveBeenCalledWith('epic.relations.invalidated', {
      workspaceId: WORKSPACE_ID,
    });
    expect(settings.clearProjectTemplateMetadata).toHaveBeenCalledWith(PROJECT_ID);
    expect(settings.clearProjectPresets).toHaveBeenCalledWith(PROJECT_ID);
    expect(settings.setProjectActivePreset).toHaveBeenCalledWith(PROJECT_ID, null);
    expect(storage.deleteProject.mock.invocationCallOrder[0]).toBeLessThan(
      events.publish.mock.invocationCallOrder[0],
    );
    expect(events.publish.mock.invocationCallOrder[0]).toBeLessThan(
      settings.clearProjectTemplateMetadata.mock.invocationCallOrder[0],
    );
  });

  it('publishes before settings cleanup failure so invalidation is not lost', async () => {
    settings.clearProjectTemplateMetadata.mockRejectedValue(new Error('settings cleanup failed'));

    await expect(service.deleteProject(PROJECT_ID)).rejects.toThrow('settings cleanup failed');

    expect(storage.deleteProject).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(settings.clearProjectPresets).not.toHaveBeenCalled();
  });

  it('publishes and cleans nothing when storage deletion fails', async () => {
    storage.deleteProject.mockRejectedValue(new Error('storage delete failed'));

    await expect(service.deleteProject(PROJECT_ID)).rejects.toThrow('storage delete failed');

    expect(events.publish).not.toHaveBeenCalled();
    expect(settings.clearProjectTemplateMetadata).not.toHaveBeenCalled();
    expect(settings.clearProjectPresets).not.toHaveBeenCalled();
    expect(settings.setProjectActivePreset).not.toHaveBeenCalled();
  });
});
