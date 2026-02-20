import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { CreateSubscriber, Project, Subscriber } from '../../storage/models/domain.models';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { WatchersService } from '../../watchers/services/watchers.service';
import type { SeederContext } from '../services/data-seeder.service';
import { runSeedRenewInstructionsSubscriber } from './0005_seed_renew_instructions_subscriber';

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

function createSubscriber(projectId: string, name: string, eventName: string): Subscriber {
  return {
    id: `sub-${projectId}-${name}`,
    projectId,
    name,
    description: null,
    enabled: true,
    eventName,
    eventFilter: null,
    actionType: 'send_agent_message',
    actionInputs: {},
    delayMs: 0,
    cooldownMs: 0,
    retryOnError: false,
    groupName: null,
    position: 0,
    priority: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

describe('0005_seed_renew_instructions_subscriber', () => {
  function createContext(overrides?: {
    listProjects?: jest.Mock;
    findSubscribersByEventName?: jest.Mock;
    createSubscriber?: jest.Mock;
    info?: jest.Mock;
  }): SeederContext {
    const storage = {
      listProjects:
        overrides?.listProjects ??
        jest.fn().mockResolvedValue({
          items: [],
          total: 0,
          limit: 1000,
          offset: 0,
        }),
      findSubscribersByEventName:
        overrides?.findSubscribersByEventName ?? jest.fn().mockResolvedValue([]),
      createSubscriber: overrides?.createSubscriber ?? jest.fn().mockResolvedValue(undefined),
    } as unknown as StorageService;

    return {
      storage,
      watchersService: {} as unknown as WatchersService,
      db: {} as BetterSQLite3Database,
      logger: {
        info: overrides?.info ?? jest.fn(),
      } as unknown as SeederContext['logger'],
    };
  }

  it('creates subscriber for projects that do not have one', async () => {
    const projects = [createProject('project-1', 'one'), createProject('project-2', 'two')];
    const listProjects = jest.fn().mockResolvedValue({
      items: projects,
      total: projects.length,
      limit: 1000,
      offset: 0,
    });
    const findSubscribersByEventName = jest.fn().mockResolvedValue([]);
    const createSubscriberMock = jest.fn().mockResolvedValue(undefined);

    const ctx = createContext({
      listProjects,
      findSubscribersByEventName,
      createSubscriber: createSubscriberMock,
    });

    await runSeedRenewInstructionsSubscriber(ctx);

    expect(createSubscriberMock).toHaveBeenCalledTimes(2);
    expect(createSubscriberMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        projectId: 'project-1',
        name: 'Renew instructions',
        eventName: 'claude.hooks.session.started',
        eventFilter: {
          field: 'source',
          operator: 'regex',
          value: 'resume|clear|compact',
        },
        actionType: 'send_agent_message',
        actionInputs: expect.objectContaining({
          text: expect.objectContaining({
            source: 'custom',
            customValue: expect.stringContaining('Re-load your agent profile'),
          }),
          immediate: { source: 'custom', customValue: 'true' },
        }),
        delayMs: 1000,
        cooldownMs: 5000,
        retryOnError: false,
        description: null,
        groupName: null,
        position: 0,
        priority: 0,
      }),
    );
    expect(createSubscriberMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        projectId: 'project-2',
        name: 'Renew instructions',
      }),
    );
  });

  it('skips projects that already have the subscriber', async () => {
    const projects = [createProject('project-1', 'one')];
    const listProjects = jest.fn().mockResolvedValue({
      items: projects,
      total: projects.length,
      limit: 1000,
      offset: 0,
    });
    const findSubscribersByEventName = jest
      .fn()
      .mockResolvedValue([
        createSubscriber('project-1', 'Renew instructions', 'claude.hooks.session.started'),
      ]);
    const createSubscriberMock = jest.fn().mockResolvedValue(undefined);

    const ctx = createContext({
      listProjects,
      findSubscribersByEventName,
      createSubscriber: createSubscriberMock,
    });

    await runSeedRenewInstructionsSubscriber(ctx);

    expect(createSubscriberMock).not.toHaveBeenCalled();
  });

  it('does not skip when a different subscriber exists for the same event', async () => {
    const projects = [createProject('project-1', 'one')];
    const listProjects = jest.fn().mockResolvedValue({
      items: projects,
      total: projects.length,
      limit: 1000,
      offset: 0,
    });
    const findSubscribersByEventName = jest
      .fn()
      .mockResolvedValue([
        createSubscriber('project-1', 'Different subscriber', 'claude.hooks.session.started'),
      ]);
    const createSubscriberMock = jest.fn().mockResolvedValue(undefined);

    const ctx = createContext({
      listProjects,
      findSubscribersByEventName,
      createSubscriber: createSubscriberMock,
    });

    await runSeedRenewInstructionsSubscriber(ctx);

    expect(createSubscriberMock).toHaveBeenCalledTimes(1);
  });

  it('logs correct counts on completion', async () => {
    const projects = [
      createProject('project-1', 'one'),
      createProject('project-2', 'two'),
      createProject('project-3', 'three'),
    ];
    const listProjects = jest.fn().mockResolvedValue({
      items: projects,
      total: projects.length,
      limit: 1000,
      offset: 0,
    });
    const findSubscribersByEventName = jest.fn().mockImplementation(async (projectId: string) => {
      if (projectId === 'project-2') {
        return [
          createSubscriber('project-2', 'Renew instructions', 'claude.hooks.session.started'),
        ];
      }
      return [];
    });
    const createSubscriberMock = jest.fn().mockResolvedValue(undefined);
    const info = jest.fn();

    const ctx = createContext({
      listProjects,
      findSubscribersByEventName,
      createSubscriber: createSubscriberMock,
      info,
    });

    await runSeedRenewInstructionsSubscriber(ctx);

    expect(createSubscriberMock).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        seederName: '0005_seed_renew_instructions_subscriber',
        seederVersion: 1,
        created: 2,
        skipped: 1,
        totalProjects: 3,
      }),
      'Renew-instructions subscriber seeder completed',
    );
  });

  it('is idempotent across reruns after initial creation', async () => {
    const projects = [createProject('project-1', 'one')];
    const listProjects = jest.fn().mockResolvedValue({
      items: projects,
      total: projects.length,
      limit: 1000,
      offset: 0,
    });

    const projectSubscribers = new Map<string, Subscriber[]>();
    const findSubscribersByEventName = jest
      .fn()
      .mockImplementation(async (projectId: string) => projectSubscribers.get(projectId) ?? []);

    const createSubscriberMock = jest.fn().mockImplementation(async (data: CreateSubscriber) => {
      const sub = createSubscriber(data.projectId, data.name, data.eventName);
      projectSubscribers.set(data.projectId, [
        ...(projectSubscribers.get(data.projectId) ?? []),
        sub,
      ]);
    });

    const ctx = createContext({
      listProjects,
      findSubscribersByEventName,
      createSubscriber: createSubscriberMock,
    });

    await runSeedRenewInstructionsSubscriber(ctx);
    await runSeedRenewInstructionsSubscriber(ctx);

    expect(createSubscriberMock).toHaveBeenCalledTimes(1);
  });

  it('handles empty project list gracefully', async () => {
    const listProjects = jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 1000,
      offset: 0,
    });
    const createSubscriberMock = jest.fn().mockResolvedValue(undefined);
    const info = jest.fn();

    const ctx = createContext({
      listProjects,
      createSubscriber: createSubscriberMock,
      info,
    });

    await runSeedRenewInstructionsSubscriber(ctx);

    expect(createSubscriberMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        created: 0,
        skipped: 0,
        totalProjects: 0,
      }),
      'Renew-instructions subscriber seeder completed',
    );
  });
});
