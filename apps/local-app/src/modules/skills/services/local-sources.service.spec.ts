import { access, rm, stat } from 'node:fs/promises';
import { NotFoundError, StorageError, ValidationError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { LocalSourcesService } from './local-sources.service';
import type { SkillsService } from './skills.service';

jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
  stat: jest.fn(),
  rm: jest.fn(),
}));

describe('LocalSourcesService', () => {
  let storage: {
    listLocalSkillSources: jest.Mock;
    createLocalSkillSource: jest.Mock;
    getLocalSkillSource: jest.Mock;
    deleteLocalSkillSource: jest.Mock;
    listProjects: jest.Mock;
    seedSourceProjectDisabled: jest.Mock;
  };
  let skillsService: {
    getReservedSourceNames: jest.Mock;
  };
  let skillSyncService: {
    syncSource: jest.Mock;
  };

  beforeEach(() => {
    jest.mocked(access).mockReset();
    jest.mocked(stat).mockReset();
    jest.mocked(rm).mockReset();

    storage = {
      listLocalSkillSources: jest.fn().mockResolvedValue([]),
      createLocalSkillSource: jest.fn(),
      getLocalSkillSource: jest.fn(),
      deleteLocalSkillSource: jest.fn().mockResolvedValue(undefined),
      listProjects: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        limit: 200,
        offset: 0,
      }),
      seedSourceProjectDisabled: jest.fn().mockResolvedValue(undefined),
    };
    skillsService = {
      getReservedSourceNames: jest.fn().mockReturnValue(['anthropic', 'microsoft', 'openai']),
    };
    skillSyncService = {
      syncSource: jest.fn().mockResolvedValue({
        status: 'completed',
        added: 0,
        updated: 0,
        removed: 0,
        failed: 0,
        unchanged: 0,
        errors: [],
      }),
    };
  });

  const mockReadableDirectoryChecks = (): void => {
    jest
      .mocked(stat)
      .mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof stat>>);
    jest.mocked(access).mockResolvedValue(undefined);
  };

  it('lists local sources from storage', async () => {
    storage.listLocalSkillSources.mockResolvedValue([
      {
        id: 'source-1',
        name: 'local-source',
        folderPath: '/tmp/local-source',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const service = new LocalSourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );

    const result = await service.listLocalSources();

    expect(result).toHaveLength(1);
    expect(storage.listLocalSkillSources).toHaveBeenCalledWith();
  });

  it('creates a local source through storage and seeds project source disablement', async () => {
    mockReadableDirectoryChecks();
    const service = new LocalSourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );
    storage.createLocalSkillSource.mockResolvedValue({
      id: 'id-1',
      name: 'local-source',
      folderPath: '/tmp/local-source',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    storage.listProjects
      .mockResolvedValueOnce({
        items: [{ id: 'project-1' }, { id: 'project-2' }],
        total: 2,
        limit: 200,
        offset: 0,
      })
      .mockResolvedValueOnce({
        items: [],
        total: 2,
        limit: 200,
        offset: 2,
      });

    const result = await service.createLocalSource({
      name: 'local-source',
      folderPath: '/tmp/local-source/../local-source/',
    });

    expect(storage.createLocalSkillSource).toHaveBeenCalledWith({
      name: 'local-source',
      folderPath: '/tmp/local-source',
    });
    expect(storage.seedSourceProjectDisabled).toHaveBeenCalledTimes(2);
    expect(storage.seedSourceProjectDisabled).toHaveBeenNthCalledWith(1, 'project-1', [
      'local-source',
    ]);
    expect(storage.seedSourceProjectDisabled).toHaveBeenNthCalledWith(2, 'project-2', [
      'local-source',
    ]);
    expect(skillSyncService.syncSource).toHaveBeenCalledWith('local-source');
    expect(result.name).toBe('local-source');
  });

  it('creates local source even when initial sync throws', async () => {
    mockReadableDirectoryChecks();
    const service = new LocalSourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );
    storage.createLocalSkillSource.mockResolvedValue({
      id: 'id-sync-fail',
      name: 'local-sync-fail',
      folderPath: '/tmp/local-sync-fail',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    skillSyncService.syncSource.mockRejectedValue(new Error('sync failed'));

    await expect(
      service.createLocalSource({
        name: 'local-sync-fail',
        folderPath: '/tmp/local-sync-fail',
      }),
    ).resolves.toMatchObject({ name: 'local-sync-fail' });
    expect(storage.createLocalSkillSource).toHaveBeenCalled();
    expect(skillSyncService.syncSource).toHaveBeenCalledWith('local-sync-fail');
  });

  it('rejects reserved built-in source names with validation error', async () => {
    mockReadableDirectoryChecks();
    const service = new LocalSourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );

    await expect(
      service.createLocalSource({
        name: 'openai',
        folderPath: '/tmp/local-source',
      }),
    ).rejects.toThrow(ValidationError);
    expect(storage.createLocalSkillSource).not.toHaveBeenCalled();
  });

  it('rejects relative folder paths', async () => {
    const service = new LocalSourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );

    await expect(
      service.createLocalSource({
        name: 'local-source',
        folderPath: './relative/path',
      }),
    ).rejects.toThrow(ValidationError);
    expect(storage.createLocalSkillSource).not.toHaveBeenCalled();
  });

  it('rejects paths missing skills directory', async () => {
    const service = new LocalSourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );

    const enoentError = Object.assign(new Error('not found'), { code: 'ENOENT' });
    jest
      .mocked(stat)
      .mockResolvedValueOnce({ isDirectory: () => true } as Awaited<ReturnType<typeof stat>>)
      .mockRejectedValueOnce(enoentError);
    jest.mocked(access).mockResolvedValue(undefined);

    await expect(
      service.createLocalSource({
        name: 'local-source',
        folderPath: '/tmp/local-source',
      }),
    ).rejects.toThrow(ValidationError);
    expect(storage.createLocalSkillSource).not.toHaveBeenCalled();
  });

  it('deletes source and removes local synced skills directory', async () => {
    const service = new LocalSourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );
    storage.getLocalSkillSource.mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000999',
      name: 'local-source',
      folderPath: '/tmp/local-source',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    jest.mocked(rm).mockResolvedValue(undefined);

    await service.deleteLocalSource('00000000-0000-0000-0000-000000000999');

    expect(storage.deleteLocalSkillSource).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000999',
    );
    expect(rm).toHaveBeenCalledWith(
      expect.stringContaining('.devchain/skills/local-source'),
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('throws when local synced skills directory cleanup fails', async () => {
    const service = new LocalSourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );
    storage.getLocalSkillSource.mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000999',
      name: 'local-source',
      folderPath: '/tmp/local-source',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    jest.mocked(rm).mockRejectedValue(new Error('permission denied'));

    await expect(service.deleteLocalSource('00000000-0000-0000-0000-000000000999')).rejects.toThrow(
      StorageError,
    );
  });

  it('throws NotFoundError when deleting missing local source', async () => {
    const service = new LocalSourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );
    storage.getLocalSkillSource.mockResolvedValue(null);

    await expect(service.deleteLocalSource('missing')).rejects.toThrow(NotFoundError);
    expect(storage.deleteLocalSkillSource).not.toHaveBeenCalled();
  });
});
