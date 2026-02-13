import { rm } from 'node:fs/promises';
import {
  ConflictError,
  NotFoundError,
  StorageError,
  ValidationError,
} from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { CommunitySourcesService } from './community-sources.service';
import type { SkillsService } from './skills.service';

jest.mock('node:fs/promises', () => ({
  rm: jest.fn(),
}));

describe('CommunitySourcesService', () => {
  let storage: {
    listCommunitySkillSources: jest.Mock;
    listLocalSkillSources: jest.Mock;
    createCommunitySkillSource: jest.Mock;
    getCommunitySkillSource: jest.Mock;
    deleteCommunitySkillSource: jest.Mock;
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
    jest.mocked(rm).mockReset();
    storage = {
      listCommunitySkillSources: jest.fn().mockResolvedValue([]),
      listLocalSkillSources: jest.fn().mockResolvedValue([]),
      createCommunitySkillSource: jest.fn(),
      getCommunitySkillSource: jest.fn(),
      deleteCommunitySkillSource: jest.fn().mockResolvedValue(undefined),
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

  it('creates a community source through storage', async () => {
    const service = new CommunitySourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );
    storage.createCommunitySkillSource.mockResolvedValue({
      id: 'id-1',
      name: 'source',
      repoOwner: 'owner',
      repoName: 'repo',
      branch: 'main',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await service.createCommunitySource({
      name: 'source',
      repoOwner: 'owner',
      repoName: 'repo',
      branch: 'main',
    });

    expect(storage.createCommunitySkillSource).toHaveBeenCalledWith({
      name: 'source',
      repoOwner: 'owner',
      repoName: 'repo',
      branch: 'main',
    });
    expect(storage.seedSourceProjectDisabled).not.toHaveBeenCalled();
    expect(skillSyncService.syncSource).toHaveBeenCalledWith('source');
    expect(result.name).toBe('source');
  });

  it('seeds new source as disabled for every existing project', async () => {
    const service = new CommunitySourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );
    storage.createCommunitySkillSource.mockResolvedValue({
      id: 'id-2',
      name: 'source-two',
      repoOwner: 'owner',
      repoName: 'repo',
      branch: 'main',
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

    await service.createCommunitySource({
      name: 'source-two',
      repoOwner: 'owner',
      repoName: 'repo',
      branch: 'main',
    });

    expect(storage.seedSourceProjectDisabled).toHaveBeenCalledTimes(2);
    expect(storage.seedSourceProjectDisabled).toHaveBeenNthCalledWith(1, 'project-1', [
      'source-two',
    ]);
    expect(storage.seedSourceProjectDisabled).toHaveBeenNthCalledWith(2, 'project-2', [
      'source-two',
    ]);
    expect(skillSyncService.syncSource).toHaveBeenCalledWith('source-two');
  });

  it('creates source even when initial sync throws', async () => {
    const service = new CommunitySourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );
    storage.createCommunitySkillSource.mockResolvedValue({
      id: 'id-sync-fail',
      name: 'sync-fail-source',
      repoOwner: 'owner',
      repoName: 'repo',
      branch: 'main',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    skillSyncService.syncSource.mockRejectedValue(new Error('sync failed'));

    await expect(
      service.createCommunitySource({
        name: 'sync-fail-source',
        repoOwner: 'owner',
        repoName: 'repo',
        branch: 'main',
      }),
    ).resolves.toMatchObject({ name: 'sync-fail-source' });
    expect(storage.createCommunitySkillSource).toHaveBeenCalled();
    expect(skillSyncService.syncSource).toHaveBeenCalledWith('sync-fail-source');
  });

  it('deletes source and removes local skill directory', async () => {
    const service = new CommunitySourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );
    storage.getCommunitySkillSource.mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000001',
      name: 'source',
      repoOwner: 'owner',
      repoName: 'repo',
      branch: 'main',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    jest.mocked(rm).mockResolvedValue(undefined);

    await service.deleteCommunitySource('00000000-0000-0000-0000-000000000001');

    expect(storage.deleteCommunitySkillSource).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
    );
    expect(rm).toHaveBeenCalledWith(
      expect.stringContaining('.devchain/skills/source'),
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('rethrows storage errors from create', async () => {
    const service = new CommunitySourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );
    storage.createCommunitySkillSource.mockRejectedValue(
      new ConflictError('Community skill source name already exists.', { name: 'source' }),
    );

    await expect(
      service.createCommunitySource({
        name: 'source',
        repoOwner: 'owner',
        repoName: 'repo',
        branch: 'main',
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('throws storage error if local directory cleanup fails', async () => {
    const service = new CommunitySourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );
    storage.getCommunitySkillSource.mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000001',
      name: 'source',
      repoOwner: 'owner',
      repoName: 'repo',
      branch: 'main',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    jest.mocked(rm).mockRejectedValue(new Error('permission denied'));

    await expect(
      service.deleteCommunitySource('00000000-0000-0000-0000-000000000001'),
    ).rejects.toThrow(StorageError);
  });

  it('propagates not found errors on delete', async () => {
    const service = new CommunitySourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );
    storage.getCommunitySkillSource.mockRejectedValue(
      new NotFoundError('Community skill source', 'missing'),
    );

    await expect(service.deleteCommunitySource('missing')).rejects.toThrow(NotFoundError);
    expect(storage.deleteCommunitySkillSource).not.toHaveBeenCalled();
  });

  it('rejects reserved built-in source names with validation error', async () => {
    const service = new CommunitySourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );

    await expect(
      service.createCommunitySource({
        name: 'openai',
        repoOwner: 'owner',
        repoName: 'repo',
        branch: 'main',
      }),
    ).rejects.toThrow(ValidationError);
    expect(storage.createCommunitySkillSource).not.toHaveBeenCalled();
  });

  it('rejects names that conflict with existing local sources', async () => {
    const service = new CommunitySourcesService(
      storage as unknown as StorageService,
      skillsService as unknown as SkillsService,
      skillSyncService as never,
    );
    storage.listLocalSkillSources.mockResolvedValue([
      {
        id: 'local-1',
        name: 'local-source',
        folderPath: '/tmp/local-source',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    await expect(
      service.createCommunitySource({
        name: 'LOCAL-SOURCE',
        repoOwner: 'owner',
        repoName: 'repo',
        branch: 'main',
      }),
    ).rejects.toThrow(ValidationError);
    expect(storage.createCommunitySkillSource).not.toHaveBeenCalled();
  });
});
