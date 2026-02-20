import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { resetEnvConfig } from '../../../../common/config/env.config';
import { OrchestratorDatabase } from '../../orchestrator-storage/db/orchestrator.provider';
import { mergedAgents, mergedEpics } from '../../../storage/db/schema';
import { LocalStorageService } from '../../../storage/local/local-storage.service';
import { WorktreeRecord, WorktreesStore } from '../../worktrees/worktrees.store';
import { TaskMergeService } from './task-merge.service';
import * as sqliteRaw from '../../../storage/db/sqlite-raw';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

describe('TaskMergeService', () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env;
  let getRawSqliteClientSpy: jest.SpiedFunction<typeof sqliteRaw.getRawSqliteClient>;

  let store: jest.Mocked<Pick<WorktreesStore, 'getById'>>;
  let insertedEpics: Array<typeof mergedEpics.$inferInsert>;
  let insertedAgents: Array<typeof mergedAgents.$inferInsert>;
  let epicConflictArgs: unknown[] = [];
  let agentConflictArgs: unknown[] = [];
  let db: OrchestratorDatabase;
  let service: TaskMergeService;

  function createWorktree(input: Partial<WorktreeRecord> = {}): WorktreeRecord {
    const now = new Date('2026-02-15T10:00:00.000Z');
    return {
      id: input.id ?? 'wt-1',
      name: input.name ?? 'feature-auth',
      branchName: input.branchName ?? 'feature/auth',
      baseBranch: input.baseBranch ?? 'main',
      repoPath: input.repoPath ?? '/repo',
      worktreePath: input.worktreePath ?? '/repo/worktrees/feature-auth',
      containerId: input.containerId ?? 'container-1',
      containerPort: input.containerPort ?? 41001,
      templateSlug: input.templateSlug ?? '3-agent-dev',
      ownerProjectId: input.ownerProjectId ?? 'project-1',
      status: input.status ?? 'running',
      description: input.description ?? null,
      devchainProjectId: input.devchainProjectId ?? 'project-1',
      mergeCommit: input.mergeCommit ?? null,
      mergeConflicts: input.mergeConflicts ?? null,
      errorMessage: input.errorMessage ?? null,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DEVCHAIN_MODE;
    delete process.env.DATABASE_URL;
    delete process.env.REPO_ROOT;
    resetEnvConfig();

    store = {
      getById: jest.fn(),
    };
    insertedEpics = [];
    insertedAgents = [];
    epicConflictArgs = [];
    agentConflictArgs = [];

    const tx = {
      insert: jest.fn((table: unknown) => ({
        values: jest.fn((values: unknown) => ({
          onConflictDoNothing: jest.fn(async (args?: unknown) => {
            const rows = Array.isArray(values) ? values : [values];
            if (table === mergedEpics) {
              insertedEpics.push(...(rows as Array<typeof mergedEpics.$inferInsert>));
              epicConflictArgs.push(args);
            } else if (table === mergedAgents) {
              insertedAgents.push(...(rows as Array<typeof mergedAgents.$inferInsert>));
              agentConflictArgs.push(args);
            }
          }),
        })),
      })),
    };

    db = {
      transaction: jest.fn(async (callback: (trx: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as OrchestratorDatabase;

    service = new TaskMergeService(store as unknown as WorktreesStore, db);
    getRawSqliteClientSpy = jest.spyOn(sqliteRaw, 'getRawSqliteClient');
  });

  afterEach(() => {
    process.env = originalEnv;
    resetEnvConfig();
    global.fetch = originalFetch;
    getRawSqliteClientSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('extracts epics/agents from container and persists to merged tables in one transaction', async () => {
    store.getById.mockResolvedValue(createWorktree());

    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/epics')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'epic-root',
                title: 'Root epic',
                description: 'root desc',
                statusId: 'done-status',
                parentId: null,
                agentId: 'agent-1',
                tags: ['phase:4', 'task:2'],
                createdAt: '2026-02-14T00:00:00.000Z',
              },
              {
                id: 'epic-child',
                title: 'Child epic',
                description: null,
                statusId: 'in-progress-status',
                parentId: 'epic-root',
                agentId: 'agent-2',
                tags: [],
              },
            ],
          }),
        } as Response;
      }

      if (url.includes('/api/agents')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'agent-1', name: 'Coder', profileId: 'coder-profile', epicsCompleted: 5 },
              { id: 'agent-2', name: 'Reviewer', profileId: 'reviewer-profile' },
            ],
          }),
        } as Response;
      }

      if (url.includes('/api/statuses')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'done-status', label: 'Done', color: '#28a745' },
              { id: 'in-progress-status', label: 'In Progress', color: '#007bff' },
            ],
          }),
        } as Response;
      }

      if (url.includes('/api/agent-profiles')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'coder-profile', name: 'Coder Profile' },
              { id: 'reviewer-profile', name: 'Reviewer Profile' },
            ],
          }),
        } as Response;
      }

      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      } as Response;
    }) as unknown as typeof fetch;

    const result = await service.mergeTasksFromContainer('wt-1');

    expect(result).toEqual({
      worktreeId: 'wt-1',
      epicsMerged: 2,
      agentsMerged: 2,
    });
    expect(insertedEpics).toHaveLength(2);
    expect(insertedAgents).toHaveLength(2);

    const root = insertedEpics.find((row) => row.devchainEpicId === 'epic-root');
    const child = insertedEpics.find((row) => row.devchainEpicId === 'epic-child');
    expect(root?.agentName).toBe('Coder');
    expect(root?.parentEpicId).toBeNull();
    expect(root?.tags).toEqual(['phase:4', 'task:2']);
    expect(root?.statusName).toBe('Done');
    expect(root?.statusColor).toBe('#28a745');
    expect(child?.parentEpicId).toBe('epic-root');
    expect(child?.statusName).toBe('In Progress');
    expect(child?.statusColor).toBe('#007bff');

    const reviewer = insertedAgents.find((row) => row.devchainAgentId === 'agent-2');
    expect(reviewer?.epicsCompleted).toBe(1);
    expect(reviewer?.profileName).toBe('Reviewer Profile');
  });

  it('imports merged epics into main SQLite project with hierarchy, status mapping, and attribution tags', async () => {
    const repoRoot = process.cwd();
    process.env.DEVCHAIN_MODE = 'main';
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/devchain';
    process.env.REPO_ROOT = repoRoot;
    resetEnvConfig();

    store.getById.mockResolvedValue(createWorktree());

    const createdStatuses: Array<{ label: string; color: string; position: number }> = [];
    const createdEpics: Array<{
      title: string;
      parentId: string | null;
      statusId: string;
      agentId: string | null;
      tags: string[];
      data: Record<string, unknown> | null;
    }> = [];
    const createdEpicIds: string[] = [];

    const storage = {
      findProjectByPath: jest.fn().mockResolvedValue({
        id: 'main-project',
        name: 'devchain',
        description: null,
        rootPath: repoRoot,
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      listProjects: jest.fn(),
      createProject: jest.fn(),
      listStatuses: jest
        .fn()
        .mockResolvedValueOnce({ items: [], total: 0, limit: 500, offset: 0 })
        .mockResolvedValue({ items: createdStatuses as never[], total: 2, limit: 500, offset: 0 }),
      createStatus: jest.fn(async (data: { label: string; color: string; position: number }) => {
        createdStatuses.push(data);
        return {
          id: `status-${createdStatuses.length}`,
          projectId: 'main-project',
          label: data.label,
          color: data.color,
          position: data.position,
          mcpHidden: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }),
      listAgents: jest.fn().mockResolvedValue({
        items: [{ id: 'main-agent-1', name: 'Coder' }],
        total: 1,
        limit: 500,
        offset: 0,
      }),
      listProjectEpics: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        limit: 500,
        offset: 0,
      }),
      createEpic: jest.fn(
        async (data: {
          title: string;
          parentId: string | null;
          statusId: string;
          agentId: string | null;
          tags: string[];
          data: Record<string, unknown> | null;
        }) => {
          createdEpics.push(data);
          const id = `main-epic-${createdEpics.length}`;
          createdEpicIds.push(id);
          return {
            id,
            projectId: 'main-project',
            title: data.title,
            description: null,
            statusId: data.statusId,
            parentId: data.parentId,
            agentId: data.agentId,
            version: 1,
            data: data.data,
            skillsRequired: null,
            tags: data.tags,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        },
      ),
    };

    service = new TaskMergeService(store as unknown as WorktreesStore, db, storage as never);

    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/epics')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'epic-root',
                title: 'Root epic',
                description: 'root desc',
                statusId: 'done-status',
                parentId: null,
                agentId: 'agent-1',
                tags: ['phase:4', 'task:2'],
              },
              {
                id: 'epic-child',
                title: 'Child epic',
                description: null,
                statusId: 'in-progress-status',
                parentId: 'epic-root',
                agentId: 'agent-2',
                tags: [],
              },
            ],
          }),
        } as Response;
      }
      if (url.includes('/api/agents')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'agent-1', name: 'Coder', profileId: 'coder-profile' },
              { id: 'agent-2', name: 'Reviewer', profileId: 'reviewer-profile' },
            ],
          }),
        } as Response;
      }
      if (url.includes('/api/statuses')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'done-status', label: 'Done', color: '#28a745' },
              { id: 'in-progress-status', label: 'In Progress', color: '#007bff' },
            ],
          }),
        } as Response;
      }
      if (url.includes('/api/agent-profiles')) {
        return {
          ok: true,
          json: async () => ({ items: [] }),
        } as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      } as Response;
    }) as unknown as typeof fetch;

    await service.mergeTasksFromContainer('wt-1');

    expect(storage.createStatus).toHaveBeenCalledTimes(2);
    expect(storage.createEpic).toHaveBeenCalledTimes(2);
    expect(createdEpics[0]?.parentId).toBeNull();
    expect(createdEpics[0]?.agentId).toBe('main-agent-1');
    expect(createdEpics[0]?.tags).toEqual(
      expect.arrayContaining(['phase:4', 'task:2', 'merged:feature-auth']),
    );
    expect(createdEpics[1]?.parentId).toBe(createdEpicIds[0]);
    expect(createdEpics[1]?.agentId).toBeNull();
    expect(createdEpics[1]?.tags).toEqual(expect.arrayContaining(['merged:feature-auth']));
  });

  it('delegates main project resolution to MainProjectBootstrapService when available', async () => {
    const repoRoot = process.cwd();
    process.env.DEVCHAIN_MODE = 'main';
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/devchain';
    process.env.REPO_ROOT = repoRoot;
    resetEnvConfig();

    store.getById.mockResolvedValue(createWorktree());

    const storage = {
      findProjectByPath: jest.fn(),
      listProjects: jest.fn(),
      createProject: jest.fn(),
      listStatuses: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        limit: 500,
        offset: 0,
      }),
      createStatus: jest.fn(),
      listAgents: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        limit: 500,
        offset: 0,
      }),
      listProjectEpics: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        limit: 500,
        offset: 0,
      }),
      createEpic: jest.fn(),
    };

    const mainProjectBootstrap = {
      getMainProjectId: jest.fn().mockReturnValue('main-project-from-bootstrap'),
    };

    service = new TaskMergeService(
      store as unknown as WorktreesStore,
      db,
      storage as never,
      mainProjectBootstrap as never,
    );

    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/epics')) {
        return {
          ok: true,
          json: async () => ({ items: [] }),
        } as Response;
      }
      if (url.includes('/api/agents')) {
        return {
          ok: true,
          json: async () => ({ items: [] }),
        } as Response;
      }
      if (url.includes('/api/statuses')) {
        return {
          ok: true,
          json: async () => ({ items: [] }),
        } as Response;
      }
      if (url.includes('/api/agent-profiles')) {
        return {
          ok: true,
          json: async () => ({ items: [] }),
        } as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      } as Response;
    }) as unknown as typeof fetch;

    await service.mergeTasksFromContainer('wt-1');

    expect(mainProjectBootstrap.getMainProjectId).toHaveBeenCalledTimes(1);
    expect(storage.findProjectByPath).not.toHaveBeenCalled();
    expect(storage.listProjects).not.toHaveBeenCalled();
    expect(storage.createProject).not.toHaveBeenCalled();
    expect(storage.listStatuses).toHaveBeenCalledWith('main-project-from-bootstrap', {
      limit: 500,
      offset: 0,
    });
  });

  it('falls back to storage-based main project resolution when bootstrap service has no project id', async () => {
    const repoRoot = process.cwd();
    process.env.DEVCHAIN_MODE = 'main';
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/devchain';
    process.env.REPO_ROOT = repoRoot;
    resetEnvConfig();

    store.getById.mockResolvedValue(createWorktree());

    const storage = {
      findProjectByPath: jest.fn().mockResolvedValue({
        id: 'main-project-by-path',
        name: 'devchain',
        description: null,
        rootPath: repoRoot,
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      listProjects: jest.fn(),
      createProject: jest.fn(),
      listStatuses: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        limit: 500,
        offset: 0,
      }),
      createStatus: jest.fn(),
      listAgents: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        limit: 500,
        offset: 0,
      }),
      listProjectEpics: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        limit: 500,
        offset: 0,
      }),
      createEpic: jest.fn(),
    };

    const mainProjectBootstrap = {
      getMainProjectId: jest.fn().mockReturnValue(null),
    };

    service = new TaskMergeService(
      store as unknown as WorktreesStore,
      db,
      storage as never,
      mainProjectBootstrap as never,
    );

    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/epics')) {
        return {
          ok: true,
          json: async () => ({ items: [] }),
        } as Response;
      }
      if (url.includes('/api/agents')) {
        return {
          ok: true,
          json: async () => ({ items: [] }),
        } as Response;
      }
      if (url.includes('/api/statuses')) {
        return {
          ok: true,
          json: async () => ({ items: [] }),
        } as Response;
      }
      if (url.includes('/api/agent-profiles')) {
        return {
          ok: true,
          json: async () => ({ items: [] }),
        } as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      } as Response;
    }) as unknown as typeof fetch;

    await service.mergeTasksFromContainer('wt-1');

    expect(mainProjectBootstrap.getMainProjectId).toHaveBeenCalledTimes(1);
    expect(storage.findProjectByPath).toHaveBeenCalledWith(repoRoot);
    expect(storage.listProjects).not.toHaveBeenCalled();
    expect(storage.createProject).not.toHaveBeenCalled();
    expect(storage.listStatuses).toHaveBeenCalledWith('main-project-by-path', {
      limit: 500,
      offset: 0,
    });
  });

  it('prevents duplicate SQLite epic imports during concurrent merges', async () => {
    const repoRoot = process.cwd();
    process.env.DEVCHAIN_MODE = 'main';
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/devchain';
    process.env.REPO_ROOT = repoRoot;
    resetEnvConfig();

    store.getById.mockResolvedValue(createWorktree());

    const sqlite = new Database(':memory:');
    const sqliteDb = drizzle(sqlite);
    const migrationsFolder = join(__dirname, '../../../../../drizzle');
    migrate(sqliteDb, { migrationsFolder });
    const storage = new LocalStorageService(sqliteDb);

    try {
      const project = await storage.createProject({
        name: 'Main Project',
        description: null,
        rootPath: repoRoot,
        isTemplate: false,
      });

      const mainProjectBootstrap = {
        getMainProjectId: jest.fn().mockReturnValue(project.id),
      };

      service = new TaskMergeService(
        store as unknown as WorktreesStore,
        db,
        storage as never,
        mainProjectBootstrap as never,
      );

      let epicRequests = 0;
      let releaseEpicsBarrier!: () => void;
      const epicsBarrier = new Promise<void>((resolve) => {
        releaseEpicsBarrier = resolve;
      });

      global.fetch = jest.fn(async (url: string) => {
        if (url.includes('/api/epics')) {
          epicRequests += 1;
          if (epicRequests === 2) {
            releaseEpicsBarrier();
          }
          await epicsBarrier;
          return {
            ok: true,
            json: async () => ({
              items: [
                {
                  id: 'epic-root',
                  title: 'Root epic',
                  description: null,
                  statusId: 'done-status',
                  parentId: null,
                  agentId: null,
                  tags: ['phase:4'],
                },
              ],
            }),
          } as Response;
        }

        if (url.includes('/api/agents')) {
          return {
            ok: true,
            json: async () => ({ items: [] }),
          } as Response;
        }

        if (url.includes('/api/statuses')) {
          return {
            ok: true,
            json: async () => ({ items: [{ id: 'done-status', label: 'Done', color: '#28a745' }] }),
          } as Response;
        }

        if (url.includes('/api/agent-profiles')) {
          return {
            ok: true,
            json: async () => ({ items: [] }),
          } as Response;
        }

        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        } as Response;
      }) as unknown as typeof fetch;

      await Promise.all([
        service.mergeTasksFromContainer('wt-1'),
        service.mergeTasksFromContainer('wt-1'),
      ]);

      const importedEpics = await storage.listProjectEpics(project.id, {
        type: 'all',
        limit: 100,
        offset: 0,
      });

      expect(mainProjectBootstrap.getMainProjectId).toHaveBeenCalled();
      expect(importedEpics.total).toBe(1);
      expect(importedEpics.items).toHaveLength(1);
      expect(importedEpics.items[0]?.tags).toEqual(expect.arrayContaining(['merged:feature-auth']));
    } finally {
      sqlite.close();
    }
  });

  it('skips SQLite re-import when mergedFrom data already exists for worktreeId+devchainEpicId', async () => {
    const repoRoot = process.cwd();
    process.env.DEVCHAIN_MODE = 'main';
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/devchain';
    process.env.REPO_ROOT = repoRoot;
    resetEnvConfig();

    store.getById.mockResolvedValue(createWorktree());

    const storage = {
      findProjectByPath: jest.fn().mockResolvedValue({
        id: 'main-project',
        name: 'devchain',
        description: null,
        rootPath: repoRoot,
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      listStatuses: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'status-done',
            projectId: 'main-project',
            label: 'Done',
            color: '#28a745',
            position: 0,
            mcpHidden: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        total: 1,
        limit: 500,
        offset: 0,
      }),
      createStatus: jest.fn(),
      listAgents: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        limit: 500,
        offset: 0,
      }),
      listProjectEpics: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'existing-main-epic',
            projectId: 'main-project',
            title: 'Root epic',
            description: null,
            statusId: 'status-done',
            parentId: null,
            agentId: null,
            version: 1,
            data: {
              mergedFrom: {
                worktreeId: 'wt-1',
                sourceEpicId: 'epic-root',
              },
            },
            skillsRequired: null,
            tags: ['merged:feature-auth'],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        total: 1,
        limit: 500,
        offset: 0,
      }),
      createEpic: jest.fn(),
    };

    service = new TaskMergeService(store as unknown as WorktreesStore, db, storage as never);

    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/epics')) {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'epic-root', title: 'Root epic', statusId: 'done-status' }],
          }),
        } as Response;
      }
      if (url.includes('/api/agents')) {
        return {
          ok: true,
          json: async () => ({ items: [] }),
        } as Response;
      }
      if (url.includes('/api/statuses')) {
        return {
          ok: true,
          json: async () => ({ items: [{ id: 'done-status', label: 'Done', color: '#28a745' }] }),
        } as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      } as Response;
    }) as unknown as typeof fetch;

    await service.mergeTasksFromContainer('wt-1');

    expect(storage.createEpic).not.toHaveBeenCalled();
  });

  it('uses conflict guards for unique merged_epics and merged_agents keys', async () => {
    store.getById.mockResolvedValue(createWorktree());
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/epics')) {
        return {
          ok: true,
          json: async () => ({ items: [{ id: 'epic-1', title: 'Epic 1' }] }),
        } as Response;
      }
      if (url.includes('/api/agents')) {
        return {
          ok: true,
          json: async () => ({ items: [{ id: 'agent-1', name: 'Coder' }] }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    await service.mergeTasksFromContainer('wt-1');

    expect(epicConflictArgs).toHaveLength(1);
    expect(agentConflictArgs).toHaveLength(1);
    expect(epicConflictArgs[0]).toEqual({
      target: [mergedEpics.worktreeId, mergedEpics.devchainEpicId],
    });
    expect(agentConflictArgs[0]).toEqual({
      target: [mergedAgents.worktreeId, mergedAgents.devchainAgentId],
    });
  });

  it('uses BEGIN IMMEDIATE + COMMIT when raw sqlite client is available', async () => {
    store.getById.mockResolvedValue(createWorktree());
    const execMock = jest.fn();
    getRawSqliteClientSpy.mockReturnValue({
      exec: execMock,
    } as unknown as ReturnType<typeof sqliteRaw.getRawSqliteClient>);

    const insertMock = jest.fn((table: unknown) => ({
      values: jest.fn((values: unknown) => ({
        onConflictDoNothing: jest.fn(async (args?: unknown) => {
          const rows = Array.isArray(values) ? values : [values];
          if (table === mergedEpics) {
            insertedEpics.push(...(rows as Array<typeof mergedEpics.$inferInsert>));
            epicConflictArgs.push(args);
          } else if (table === mergedAgents) {
            insertedAgents.push(...(rows as Array<typeof mergedAgents.$inferInsert>));
            agentConflictArgs.push(args);
          }
        }),
      })),
    }));

    const dbWithInsert = {
      insert: insertMock,
      transaction: jest.fn(),
    } as unknown as OrchestratorDatabase;
    service = new TaskMergeService(store as unknown as WorktreesStore, dbWithInsert);

    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/epics')) {
        return {
          ok: true,
          json: async () => ({ items: [{ id: 'epic-1', title: 'Epic 1' }] }),
        } as Response;
      }
      if (url.includes('/api/agents')) {
        return {
          ok: true,
          json: async () => ({ items: [{ id: 'agent-1', name: 'Coder' }] }),
        } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    await service.mergeTasksFromContainer('wt-1');

    expect(execMock).toHaveBeenNthCalledWith(1, 'BEGIN IMMEDIATE TRANSACTION');
    expect(execMock).toHaveBeenNthCalledWith(2, 'COMMIT');
    expect(execMock).not.toHaveBeenCalledWith('ROLLBACK');
    expect((dbWithInsert.transaction as unknown as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('rolls back sqlite transaction when merge row persistence fails under lock', async () => {
    store.getById.mockResolvedValue(createWorktree());
    const execMock = jest.fn();
    getRawSqliteClientSpy.mockReturnValue({
      exec: execMock,
    } as unknown as ReturnType<typeof sqliteRaw.getRawSqliteClient>);

    const dbWithFailingInsert = {
      insert: jest.fn(() => ({
        values: jest.fn(() => ({
          onConflictDoNothing: jest.fn(async () => {
            throw new Error('sqlite write failed');
          }),
        })),
      })),
      transaction: jest.fn(),
    } as unknown as OrchestratorDatabase;
    service = new TaskMergeService(store as unknown as WorktreesStore, dbWithFailingInsert);

    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/epics')) {
        return {
          ok: true,
          json: async () => ({ items: [{ id: 'epic-1', title: 'Epic 1' }] }),
        } as Response;
      }
      if (url.includes('/api/agents')) {
        return {
          ok: true,
          json: async () => ({ items: [{ id: 'agent-1', name: 'Coder' }] }),
        } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    await expect(service.mergeTasksFromContainer('wt-1')).rejects.toThrow('sqlite write failed');
    expect(execMock).toHaveBeenNthCalledWith(1, 'BEGIN IMMEDIATE TRANSACTION');
    expect(execMock).toHaveBeenNthCalledWith(2, 'ROLLBACK');
    expect(execMock).not.toHaveBeenCalledWith('COMMIT');
    expect((dbWithFailingInsert.transaction as unknown as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('stores Unknown (id) fallback values when status/profile lookup does not resolve ids', async () => {
    store.getById.mockResolvedValue(createWorktree());

    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/epics')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'epic-1', title: 'Epic 1', statusId: 'missing-status', agentId: 'agent-1' },
            ],
          }),
        } as Response;
      }
      if (url.includes('/api/agents')) {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'agent-1', name: 'Coder', profileId: 'missing-profile' }],
          }),
        } as Response;
      }
      if (url.includes('/api/statuses')) {
        return {
          ok: true,
          json: async () => ({ items: [{ id: 'done-status', label: 'Done', color: '#28a745' }] }),
        } as Response;
      }
      if (url.includes('/api/agent-profiles')) {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'coder-profile', name: 'Architect/Planner' }],
          }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    await service.mergeTasksFromContainer('wt-1');

    expect(insertedEpics).toHaveLength(1);
    expect(insertedAgents).toHaveLength(1);
    expect(insertedEpics[0]?.statusName).toBe('Unknown (missing-status)');
    expect(insertedEpics[0]?.statusColor).toBe('#6c757d');
    expect(insertedAgents[0]?.profileName).toBe('Unknown (missing-profile)');
  });

  it('fails when container is unreachable so merge flow can abort', async () => {
    store.getById.mockResolvedValue(createWorktree());
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(service.mergeTasksFromContainer('wt-1')).rejects.toThrow(BadRequestException);
    await expect(service.mergeTasksFromContainer('wt-1')).rejects.toThrow(/ECONNREFUSED/);
    expect((db.transaction as unknown as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('fails when worktree container endpoint metadata is missing', async () => {
    store.getById.mockResolvedValue(
      createWorktree({
        containerPort: null,
      }),
    );

    await expect(service.mergeTasksFromContainer('wt-1')).rejects.toThrow(BadRequestException);
    expect(global.fetch).toBe(originalFetch);
  });

  it('throws not found for unknown worktree ids', async () => {
    store.getById.mockResolvedValue(null);
    await expect(service.mergeTasksFromContainer('missing')).rejects.toThrow(NotFoundException);
  });
});
