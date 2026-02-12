import { rm } from 'node:fs/promises';
import { ConflictError, NotFoundError, StorageError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { CommunitySourcesService } from './community-sources.service';

jest.mock('node:fs/promises', () => ({
  rm: jest.fn(),
}));

describe('CommunitySourcesService', () => {
  let storage: {
    listCommunitySkillSources: jest.Mock;
    createCommunitySkillSource: jest.Mock;
    getCommunitySkillSource: jest.Mock;
    deleteCommunitySkillSource: jest.Mock;
  };

  beforeEach(() => {
    jest.mocked(rm).mockReset();
    storage = {
      listCommunitySkillSources: jest.fn().mockResolvedValue([]),
      createCommunitySkillSource: jest.fn(),
      getCommunitySkillSource: jest.fn(),
      deleteCommunitySkillSource: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('creates a community source through storage', async () => {
    const service = new CommunitySourcesService(storage as unknown as StorageService);
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
    expect(result.name).toBe('source');
  });

  it('deletes source and removes local skill directory', async () => {
    const service = new CommunitySourcesService(storage as unknown as StorageService);
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
    const service = new CommunitySourcesService(storage as unknown as StorageService);
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
    const service = new CommunitySourcesService(storage as unknown as StorageService);
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
    const service = new CommunitySourcesService(storage as unknown as StorageService);
    storage.getCommunitySkillSource.mockRejectedValue(
      new NotFoundError('Community skill source', 'missing'),
    );

    await expect(service.deleteCommunitySource('missing')).rejects.toThrow(NotFoundError);
    expect(storage.deleteCommunitySkillSource).not.toHaveBeenCalled();
  });
});
