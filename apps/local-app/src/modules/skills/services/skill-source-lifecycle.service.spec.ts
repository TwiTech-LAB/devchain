import { access, rm, stat } from 'node:fs/promises';
import { NotFoundError, StorageError, ValidationError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { CommunitySkillSource, LocalSkillSource } from '../../storage/models/domain.models';
import { SkillSourceLifecycleService } from './skill-source-lifecycle.service';
import type { SyncResult } from './skill-sync.types';

jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
  rm: jest.fn(),
  stat: jest.fn(),
}));

jest.mock('../../../common/logging/logger', () => ({
  __mockLogger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
  createLogger: jest.fn(() => jest.requireMock('../../../common/logging/logger').__mockLogger),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function completedResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    status: 'completed',
    added: 0,
    updated: 0,
    removed: 0,
    failed: 0,
    unchanged: 0,
    errors: [],
    ...overrides,
  };
}

function communitySource(name = 'community-source'): CommunitySkillSource {
  return {
    id: `community-${name}`,
    name,
    repoOwner: 'owner',
    repoName: `${name}-repo`,
    branch: 'main',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function localSource(name = 'local-source'): LocalSkillSource {
  return {
    id: `local-${name}`,
    name,
    folderPath: `/tmp/${name}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('SkillSourceLifecycleService', () => {
  let storage: {
    listCommunitySkillSources: jest.Mock;
    createCommunitySkillSource: jest.Mock;
    getCommunitySkillSource: jest.Mock;
    deleteCommunitySkillSource: jest.Mock;
    listLocalSkillSources: jest.Mock;
    createLocalSkillSource: jest.Mock;
    getLocalSkillSource: jest.Mock;
    deleteLocalSkillSource: jest.Mock;
  };
  let registry: { getBuiltInSourceNames: jest.Mock };
  let syncExecutor: { syncAll: jest.Mock; syncSource: jest.Mock };
  let settings: { getSkillsSyncOnStartup: jest.Mock };
  let service: SkillSourceLifecycleService;
  let logger: { debug: jest.Mock; error: jest.Mock; info: jest.Mock; warn: jest.Mock };

  beforeEach(() => {
    storage = {
      listCommunitySkillSources: jest.fn().mockResolvedValue([]),
      createCommunitySkillSource: jest
        .fn()
        .mockImplementation(async ({ name }: { name: string }) => communitySource(name)),
      getCommunitySkillSource: jest.fn().mockResolvedValue(communitySource()),
      deleteCommunitySkillSource: jest.fn().mockResolvedValue(undefined),
      listLocalSkillSources: jest.fn().mockResolvedValue([]),
      createLocalSkillSource: jest
        .fn()
        .mockImplementation(async ({ name }: { name: string }) => localSource(name)),
      getLocalSkillSource: jest.fn().mockResolvedValue(localSource()),
      deleteLocalSkillSource: jest.fn().mockResolvedValue(undefined),
    };
    registry = { getBuiltInSourceNames: jest.fn().mockReturnValue([]) };
    syncExecutor = {
      syncAll: jest.fn().mockResolvedValue(completedResult()),
      syncSource: jest.fn().mockResolvedValue(completedResult()),
    };
    settings = { getSkillsSyncOnStartup: jest.fn().mockReturnValue(false) };
    logger = jest.requireMock('../../../common/logging/logger').__mockLogger;
    for (const method of Object.values(logger)) {
      method.mockReset();
    }
    jest.mocked(access).mockReset().mockResolvedValue(undefined);
    jest
      .mocked(stat)
      .mockReset()
      .mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof stat>>);
    jest.mocked(rm).mockReset().mockResolvedValue(undefined);

    service = new SkillSourceLifecycleService(
      storage as unknown as StorageService,
      registry as never,
      syncExecutor as never,
      settings as never,
    );
  });

  it('delegates community and local listing through the lifecycle seam', async () => {
    storage.listCommunitySkillSources.mockResolvedValue([communitySource()]);
    storage.listLocalSkillSources.mockResolvedValue([localSource()]);

    await expect(service.listCommunitySources()).resolves.toHaveLength(1);
    await expect(service.listLocalSources()).resolves.toHaveLength(1);
  });

  it.each(['community', 'local'] as const)(
    'rejects a registry-owned built-in name for %s before persistence',
    async (kind) => {
      registry.getBuiltInSourceNames.mockReturnValue(['devchain']);

      const operation =
        kind === 'community'
          ? service.createCommunitySource({
              name: 'devchain',
              repoOwner: 'owner',
              repoName: 'repo',
              branch: 'main',
            })
          : service.createLocalSource({ name: 'devchain', folderPath: '/tmp/local-source' });

      await expect(operation).rejects.toThrow(ValidationError);
      expect(storage.createCommunitySkillSource).not.toHaveBeenCalled();
      expect(storage.createLocalSkillSource).not.toHaveBeenCalled();
    },
  );

  it('persists both source kinds with atomic defaults and awaits idle initial sync', async () => {
    await service.createCommunitySource({
      name: 'community-source',
      repoOwner: 'owner',
      repoName: 'repo',
      branch: 'main',
    });
    await service.createLocalSource({
      name: 'local-source',
      folderPath: '/tmp/local-source/../local-source',
    });

    expect(storage.createCommunitySkillSource).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'community-source' }),
      { existingProjects: { mode: 'none' } },
    );
    expect(storage.createLocalSkillSource).toHaveBeenCalledWith(
      { name: 'local-source', folderPath: '/tmp/local-source' },
      { existingProjects: { mode: 'none' } },
    );
    expect(syncExecutor.syncSource.mock.calls.map(([name]) => name)).toEqual([
      'community-source',
      'local-source',
    ]);
  });

  it('passes the existingProjects choice through to storage for both source kinds', async () => {
    const choice = {
      mode: 'selected' as const,
      projectIds: ['00000000-0000-0000-0000-000000000003'],
    };

    await service.createCommunitySource({
      name: 'choice-community',
      repoOwner: 'owner',
      repoName: 'repo',
      branch: 'main',
      existingProjects: choice,
    });
    await service.createLocalSource({
      name: 'choice-local',
      folderPath: '/tmp/choice-local',
      existingProjects: choice,
    });

    expect(storage.createCommunitySkillSource).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'choice-community' }),
      { existingProjects: choice },
    );
    expect(storage.createLocalSkillSource).toHaveBeenCalledWith(
      { name: 'choice-local', folderPath: '/tmp/choice-local' },
      { existingProjects: choice },
    );
  });

  it('retains a created source when idle initial sync throws', async () => {
    syncExecutor.syncSource.mockRejectedValue(new Error('sync failed'));

    await expect(
      service.createCommunitySource({
        name: 'created-source',
        repoOwner: 'owner',
        repoName: 'repo',
        branch: 'main',
      }),
    ).resolves.toMatchObject({ name: 'created-source' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sourceName: 'created-source', error: 'sync failed' }),
      'Initial community source sync failed after source creation',
    );
  });

  it('keeps an idle create pending until its best-effort initial sync finishes', async () => {
    const initialSync = deferred<SyncResult>();
    syncExecutor.syncSource.mockReturnValue(initialSync.promise);
    let settled = false;

    const creation = service
      .createCommunitySource({
        name: 'awaited-source',
        repoOwner: 'owner',
        repoName: 'repo',
        branch: 'main',
      })
      .finally(() => {
        settled = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(syncExecutor.syncSource).toHaveBeenCalledWith('awaited-source');
    expect(settled).toBe(false);

    initialSync.resolve(completedResult());
    await expect(creation).resolves.toMatchObject({ name: 'awaited-source' });
  });

  it('logs partial initial-sync failures without rejecting creation', async () => {
    syncExecutor.syncSource.mockResolvedValue(
      completedResult({ failed: 1, errors: [{ sourceName: 'local-source', message: 'bad' }] }),
    );

    await expect(
      service.createLocalSource({ name: 'local-source', folderPath: '/tmp/local-source' }),
    ).resolves.toMatchObject({ name: 'local-source' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sourceName: 'local-source', failed: 1 }),
      'Initial local source sync completed with errors',
    );
  });

  it('validates local absolute and readable root plus skills directory', async () => {
    await expect(
      service.createLocalSource({ name: 'local-source', folderPath: './relative' }),
    ).rejects.toThrow('folderPath must be an absolute path.');

    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    jest
      .mocked(stat)
      .mockResolvedValueOnce({ isDirectory: () => true } as never)
      .mockRejectedValueOnce(missing);
    await expect(
      service.createLocalSource({ name: 'local-source', folderPath: '/tmp/local-source' }),
    ).rejects.toThrow('skillsPath does not exist.');
    expect(storage.createLocalSkillSource).not.toHaveBeenCalled();
  });

  it('reserves public sync before executor lookup and returns exact busy result', async () => {
    const active = deferred<SyncResult>();
    syncExecutor.syncAll.mockReturnValueOnce(active.promise);
    const first = service.syncAll();

    const busyUnknown = await service.syncSource('unknown');
    const busyDisabled = await service.syncSource('disabled');

    expect(busyUnknown).toEqual({
      status: 'already_running',
      added: 0,
      updated: 0,
      removed: 0,
      failed: 0,
      unchanged: 0,
      errors: [],
    });
    expect(busyDisabled).toEqual(busyUnknown);
    expect(syncExecutor.syncSource).not.toHaveBeenCalled();

    active.resolve(completedResult());
    await first;
  });

  it('preserves idle unknown-source executor behavior', async () => {
    syncExecutor.syncSource.mockRejectedValue(
      new ValidationError('Unknown skill source: unknown', { sourceName: 'unknown' }),
    );

    await expect(service.syncSource('unknown')).rejects.toThrow('Unknown skill source: unknown');
    await expect(service.syncAll()).resolves.toEqual(completedResult());
  });

  it('returns a busy create after persistence and runs its deferred initial sync', async () => {
    const active = deferred<SyncResult>();
    syncExecutor.syncAll.mockReturnValueOnce(active.promise);
    const publicSync = service.syncAll();

    await expect(
      service.createCommunitySource({
        name: 'deferred-source',
        repoOwner: 'owner',
        repoName: 'repo',
        branch: 'main',
      }),
    ).resolves.toMatchObject({ name: 'deferred-source' });
    expect(syncExecutor.syncSource).not.toHaveBeenCalled();

    active.resolve(completedResult());
    await publicSync;
    await Promise.resolve();
    expect(syncExecutor.syncSource).toHaveBeenCalledWith('deferred-source');
  });

  it('drains a second create added while the first deferred sync is running', async () => {
    const active = deferred<SyncResult>();
    const firstDeferred = deferred<SyncResult>();
    syncExecutor.syncAll.mockReturnValueOnce(active.promise);
    syncExecutor.syncSource.mockImplementation((name: string) =>
      name === 'source-a' ? firstDeferred.promise : Promise.resolve(completedResult()),
    );
    const publicSync = service.syncAll();

    await service.createCommunitySource({
      name: 'source-a',
      repoOwner: 'owner',
      repoName: 'repo-a',
      branch: 'main',
    });
    active.resolve(completedResult());
    await publicSync;
    await Promise.resolve();
    expect(syncExecutor.syncSource).toHaveBeenCalledWith('source-a');

    await service.createLocalSource({ name: 'source-b', folderPath: '/tmp/source-b' });
    firstDeferred.resolve(completedResult());
    await Promise.resolve();
    await Promise.resolve();
    expect(syncExecutor.syncSource.mock.calls.map(([name]) => name)).toEqual([
      'source-a',
      'source-b',
    ]);
  });

  it('keeps an earlier queued delete ahead of a later deferred create', async () => {
    const order: string[] = [];
    const active = deferred<SyncResult>();
    syncExecutor.syncAll.mockReturnValueOnce(active.promise);
    storage.getCommunitySkillSource.mockImplementation(async () => {
      order.push('delete:lookup');
      return communitySource('delete-source');
    });
    storage.deleteCommunitySkillSource.mockImplementation(async () => {
      order.push('delete:storage');
    });
    syncExecutor.syncSource.mockImplementation(async (name: string) => {
      order.push(`sync:${name}`);
      return completedResult();
    });
    const publicSync = service.syncAll();
    const deletion = service.deleteCommunitySource('delete-id');
    await service.createLocalSource({ name: 'later-source', folderPath: '/tmp/later-source' });

    active.resolve(completedResult());
    await publicSync;
    await deletion;
    await Promise.resolve();

    expect(order).toEqual(['delete:lookup', 'delete:storage', 'sync:later-source']);
  });

  it('isolates deferred rejection, continues the live queue, and releases for later sync', async () => {
    const order: string[] = [];
    const active = deferred<SyncResult>();
    syncExecutor.syncAll.mockReturnValueOnce(active.promise);
    syncExecutor.syncSource.mockImplementation(async (name: string) => {
      order.push(`sync:${name}`);
      if (name === 'source-a') {
        throw new Error('source A failed');
      }
      return completedResult();
    });
    storage.getLocalSkillSource.mockImplementation(async () => {
      order.push('delete');
      return localSource('delete-source');
    });
    const firstPublic = service.syncAll();
    await service.createCommunitySource({
      name: 'source-a',
      repoOwner: 'owner',
      repoName: 'repo-a',
      branch: 'main',
    });
    await service.createCommunitySource({
      name: 'source-b',
      repoOwner: 'owner',
      repoName: 'repo-b',
      branch: 'main',
    });
    const deletion = service.deleteLocalSource('delete-id');

    active.resolve(completedResult());
    await firstPublic;
    await deletion;
    await Promise.resolve();
    await expect(service.syncAll()).resolves.toEqual(completedResult());

    expect(order).toEqual(['sync:source-a', 'sync:source-b', 'delete']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sourceName: 'source-a', error: 'source A failed' }),
      'Initial community source sync failed after source creation',
    );
  });

  it('defensively deduplicates pending deferred initial syncs by normalized name', async () => {
    const active = deferred<SyncResult>();
    syncExecutor.syncAll.mockReturnValueOnce(active.promise);
    const publicSync = service.syncAll();

    await service.createCommunitySource({
      name: 'same-source',
      repoOwner: 'owner',
      repoName: 'repo-a',
      branch: 'main',
    });
    await service.createCommunitySource({
      name: 'SAME-SOURCE',
      repoOwner: 'owner',
      repoName: 'repo-b',
      branch: 'main',
    });
    active.resolve(completedResult());
    await publicSync;
    await Promise.resolve();

    expect(syncExecutor.syncSource).toHaveBeenCalledTimes(1);
    expect(syncExecutor.syncSource).toHaveBeenCalledWith('same-source');
  });

  it('runs filesystem cleanup before atomic delete and never overlaps active sync', async () => {
    const order: string[] = [];
    const active = deferred<SyncResult>();
    syncExecutor.syncAll.mockReturnValueOnce(active.promise);
    storage.getCommunitySkillSource.mockImplementation(async () => {
      order.push('lookup');
      return communitySource('delete-source');
    });
    jest.mocked(rm).mockImplementation(async () => {
      order.push('filesystem');
    });
    storage.deleteCommunitySkillSource.mockImplementation(async () => {
      order.push('storage');
    });
    const publicSync = service.syncAll();
    const deletion = service.deleteCommunitySource('delete-id');

    expect(order).toEqual([]);
    active.resolve(completedResult());
    await publicSync;
    await deletion;
    expect(order).toEqual(['lookup', 'filesystem', 'storage']);
  });

  it('keeps the source registered when filesystem cleanup fails and allows retry', async () => {
    jest.mocked(rm).mockRejectedValueOnce(new Error('permission denied'));

    await expect(service.deleteLocalSource('local-id')).rejects.toThrow(StorageError);
    expect(storage.deleteLocalSkillSource).not.toHaveBeenCalled();

    await expect(service.deleteLocalSource('local-id')).resolves.toBeUndefined();
    expect(storage.deleteLocalSkillSource).toHaveBeenCalledWith('local-id');
  });

  it('leaves the registered source retryable when database deletion fails after cleanup', async () => {
    storage.deleteCommunitySkillSource.mockRejectedValueOnce(new Error('database failed'));

    await expect(service.deleteCommunitySource('community-id')).rejects.toThrow('database failed');
    expect(rm).toHaveBeenCalledTimes(1);
    expect(storage.getCommunitySkillSource).toHaveBeenCalledTimes(1);

    await expect(service.deleteCommunitySource('community-id')).resolves.toBeUndefined();
    expect(rm).toHaveBeenCalledTimes(2);
    expect(storage.getCommunitySkillSource).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing local source without filesystem or storage deletion', async () => {
    storage.getLocalSkillSource.mockResolvedValue(null);

    await expect(service.deleteLocalSource('missing')).rejects.toThrow(NotFoundError);
    expect(rm).not.toHaveBeenCalled();
    expect(storage.deleteLocalSkillSource).not.toHaveBeenCalled();
  });

  it('isolates a queued delete rejection and releases the scheduler', async () => {
    storage.getCommunitySkillSource.mockRejectedValue(new Error('lookup failed'));

    await expect(service.deleteCommunitySource('bad-id')).rejects.toThrow('lookup failed');
    await expect(service.syncAll()).resolves.toEqual(completedResult());
  });

  it('preserves startup disabled, enabled, and fire-and-forget failure behavior', async () => {
    const syncSpy = jest.spyOn(service, 'syncAll');
    service.onApplicationBootstrap();
    expect(syncSpy).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Startup skills sync disabled via settings');

    settings.getSkillsSyncOnStartup.mockReturnValue(true);
    syncSpy.mockResolvedValueOnce(completedResult());
    service.onApplicationBootstrap();
    expect(syncSpy).toHaveBeenCalledTimes(1);

    syncSpy.mockRejectedValueOnce(new Error('startup failed'));
    service.onApplicationBootstrap();
    await Promise.resolve();
    await Promise.resolve();
    expect(logger.error).toHaveBeenCalledWith(
      { error: 'startup failed' },
      'Startup skills sync failed',
    );
  });
});
