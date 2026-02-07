import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { CreateWatcher, Project, Provider, Watcher } from '../../storage/models/domain.models';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { WatchersService } from '../../watchers/services/watchers.service';
import type { SeederContext } from '../services/data-seeder.service';
import { runSeedCompactOnIdleWatcher } from './0001_seed_compact_on_idle_watcher';

function createProject(id: string, name: string): Project {
  return {
    id,
    name,
    description: null,
    rootPath: `/tmp/${name}`,
    isTemplate: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function createWatcher(projectId: string, name: string): Watcher {
  return {
    id: `watcher-${projectId}`,
    projectId,
    name,
    description: null,
    enabled: true,
    scope: 'all',
    scopeFilterId: null,
    pollIntervalMs: 1000,
    viewportLines: 50,
    idleAfterSeconds: 0,
    condition: { type: 'contains', pattern: 'example' },
    cooldownMs: 1000,
    cooldownMode: 'time',
    eventName: 'watcher.example',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function createProvider(id: string, name = 'claude'): Provider {
  return {
    id,
    name,
    binPath: null,
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

describe('0001_seed_compact_on_idle_watcher', () => {
  function createContext(overrides?: {
    listProviders?: jest.Mock;
    listProjects?: jest.Mock;
    listWatchers?: jest.Mock;
    createWatcher?: jest.Mock;
    updateWatcher?: jest.Mock;
    info?: jest.Mock;
    warn?: jest.Mock;
  }): SeederContext {
    const storage = {
      listProviders:
        overrides?.listProviders ??
        jest.fn().mockResolvedValue({
          items: [createProvider('provider-claude')],
          total: 1,
          limit: 100,
          offset: 0,
        }),
      listProjects:
        overrides?.listProjects ??
        jest.fn().mockResolvedValue({
          items: [],
          total: 0,
          limit: 1000,
          offset: 0,
        }),
      listWatchers: overrides?.listWatchers ?? jest.fn().mockResolvedValue([]),
    } as unknown as StorageService;

    const watchersService = {
      createWatcher: overrides?.createWatcher ?? jest.fn().mockResolvedValue(undefined),
      updateWatcher: overrides?.updateWatcher ?? jest.fn().mockResolvedValue(undefined),
    } as unknown as WatchersService;

    return {
      storage,
      watchersService,
      db: {} as BetterSQLite3Database,
      logger: {
        info: overrides?.info ?? jest.fn(),
        warn: overrides?.warn ?? jest.fn(),
      } as unknown as SeederContext['logger'],
    };
  }

  it('creates compact-on-idle watcher with resolved provider id for projects that do not have one', async () => {
    const projects = [createProject('project-1', 'one'), createProject('project-2', 'two')];
    const listProviders = jest.fn().mockResolvedValue({
      items: [createProvider('provider-uuid-1')],
      total: 1,
      limit: 100,
      offset: 0,
    });
    const listProjects = jest.fn().mockResolvedValue({
      items: projects,
      total: projects.length,
      limit: 1000,
      offset: 0,
    });
    const listWatchers = jest.fn().mockResolvedValue([]);
    const createWatcherMock = jest.fn().mockResolvedValue(undefined);
    const updateWatcherMock = jest.fn().mockResolvedValue(undefined);

    const ctx = createContext({
      listProviders,
      listProjects,
      listWatchers,
      createWatcher: createWatcherMock,
      updateWatcher: updateWatcherMock,
    });

    await runSeedCompactOnIdleWatcher(ctx);

    expect(listProviders).toHaveBeenCalledTimes(1);
    expect(createWatcherMock).toHaveBeenCalledTimes(2);
    expect(createWatcherMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        projectId: 'project-1',
        name: 'Compact on idle',
        idleAfterSeconds: 20,
        cooldownMs: 180000,
        cooldownMode: 'until_clear',
        scope: 'provider',
        scopeFilterId: 'provider-uuid-1',
        condition: {
          type: 'regex',
          pattern: 'Context low \\(0% remaining\\)',
        },
        eventName: 'watcher.conversation.compact_request',
      }),
    );
    expect(updateWatcherMock).not.toHaveBeenCalled();
    expect(createWatcherMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        projectId: 'project-2',
        scopeFilterId: 'provider-uuid-1',
      }),
    );
  });

  it('updates existing compact-on-idle watcher when scopeFilterId does not match resolved provider id', async () => {
    const projects = [createProject('project-1', 'one')];
    const listProviders = jest.fn().mockResolvedValue({
      items: [createProvider('provider-uuid-2')],
      total: 1,
      limit: 100,
      offset: 0,
    });
    const listProjects = jest.fn().mockResolvedValue({
      items: projects,
      total: projects.length,
      limit: 1000,
      offset: 0,
    });
    const listWatchers = jest.fn().mockResolvedValue([
      {
        ...createWatcher('project-1', 'Compact on idle'),
        id: 'watcher-existing',
        scope: 'provider',
        scopeFilterId: 'provider-claude',
      },
    ]);
    const createWatcherMock = jest.fn().mockResolvedValue(undefined);
    const updateWatcherMock = jest.fn().mockResolvedValue(undefined);
    const info = jest.fn();

    const ctx = createContext({
      listProviders,
      listProjects,
      listWatchers,
      createWatcher: createWatcherMock,
      updateWatcher: updateWatcherMock,
      info,
    });

    await runSeedCompactOnIdleWatcher(ctx);

    expect(createWatcherMock).not.toHaveBeenCalled();
    expect(updateWatcherMock).toHaveBeenCalledTimes(1);
    expect(updateWatcherMock).toHaveBeenCalledWith('watcher-existing', {
      scopeFilterId: 'provider-uuid-2',
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        created: 0,
        updated: 1,
        skipped: 0,
        totalProjects: 1,
      }),
      'Compact-on-idle watcher seeder completed',
    );
  });

  it('skips projects that already have a compact-on-idle watcher with matching provider id', async () => {
    const projects = [createProject('project-1', 'one')];
    const listProviders = jest.fn().mockResolvedValue({
      items: [createProvider('provider-uuid-3')],
      total: 1,
      limit: 100,
      offset: 0,
    });
    const listProjects = jest.fn().mockResolvedValue({
      items: projects,
      total: projects.length,
      limit: 1000,
      offset: 0,
    });
    const listWatchers = jest.fn().mockResolvedValue([
      {
        ...createWatcher('project-1', 'Compact on idle'),
        scope: 'provider',
        scopeFilterId: 'provider-uuid-3',
      },
    ]);
    const createWatcherMock = jest.fn().mockResolvedValue(undefined);
    const updateWatcherMock = jest.fn().mockResolvedValue(undefined);

    const ctx = createContext({
      listProviders,
      listProjects,
      listWatchers,
      createWatcher: createWatcherMock,
      updateWatcher: updateWatcherMock,
    });

    await runSeedCompactOnIdleWatcher(ctx);

    expect(createWatcherMock).not.toHaveBeenCalled();
    expect(updateWatcherMock).not.toHaveBeenCalled();
  });

  it('gracefully skips when claude provider is not found', async () => {
    const listProviders = jest.fn().mockResolvedValue({
      items: [createProvider('provider-codex', 'codex')],
      total: 1,
      limit: 100,
      offset: 0,
    });
    const listProjects = jest.fn();
    const listWatchers = jest.fn().mockResolvedValue([]);
    const createWatcherMock = jest.fn().mockResolvedValue(undefined);
    const updateWatcherMock = jest.fn().mockResolvedValue(undefined);
    const warn = jest.fn();

    const ctx = createContext({
      listProviders,
      listProjects,
      listWatchers,
      createWatcher: createWatcherMock,
      updateWatcher: updateWatcherMock,
      warn,
    });

    await runSeedCompactOnIdleWatcher(ctx);

    expect(listProviders).toHaveBeenCalledTimes(1);
    expect(listProjects).not.toHaveBeenCalled();
    expect(listWatchers).not.toHaveBeenCalled();
    expect(createWatcherMock).not.toHaveBeenCalled();
    expect(updateWatcherMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        seederName: '0001_seed_compact_on_idle_watcher',
        seederVersion: 2,
      }),
      'Claude provider not found; skipping compact-on-idle watcher seeder',
    );
  });

  it('is idempotent across reruns after initial creation', async () => {
    const projects = [createProject('project-1', 'one')];
    const listProviders = jest.fn().mockResolvedValue({
      items: [createProvider('provider-uuid-4')],
      total: 1,
      limit: 100,
      offset: 0,
    });
    const listProjects = jest.fn().mockResolvedValue({
      items: projects,
      total: projects.length,
      limit: 1000,
      offset: 0,
    });

    const projectWatchers = new Map<string, Watcher[]>();
    const listWatchers = jest
      .fn()
      .mockImplementation(async (projectId: string) => projectWatchers.get(projectId) ?? []);

    const createWatcherMock = jest.fn().mockImplementation(async (data: CreateWatcher) => {
      const seededWatcher = createWatcher(data.projectId, data.name);
      projectWatchers.set(data.projectId, [
        {
          ...seededWatcher,
          scope: data.scope,
          scopeFilterId: data.scopeFilterId,
          pollIntervalMs: data.pollIntervalMs,
          viewportLines: data.viewportLines,
          idleAfterSeconds: data.idleAfterSeconds,
          condition: data.condition,
          cooldownMs: data.cooldownMs,
          cooldownMode: data.cooldownMode,
          eventName: data.eventName,
        },
      ]);
    });
    const updateWatcherMock = jest.fn().mockResolvedValue(undefined);

    const ctx = createContext({
      listProviders,
      listProjects,
      listWatchers,
      createWatcher: createWatcherMock,
      updateWatcher: updateWatcherMock,
    });

    await runSeedCompactOnIdleWatcher(ctx);
    await runSeedCompactOnIdleWatcher(ctx);

    expect(createWatcherMock).toHaveBeenCalledTimes(1);
    expect(updateWatcherMock).not.toHaveBeenCalled();
  });
});
