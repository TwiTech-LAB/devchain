import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import type { WorktreeRecord, WorktreesStore } from '../../worktrees/worktrees.store';
import { TaskMergeService } from './task-merge.service';

describe('TaskMergeService - SQLite persistence atomicity', () => {
  const originalFetch = global.fetch;
  const now = new Date('2026-02-15T10:00:00.000Z');
  const worktree: WorktreeRecord = {
    id: 'wt-1',
    name: 'feature-auth',
    branchName: 'feature/auth',
    baseBranch: 'main',
    repoPath: '/repo',
    worktreePath: '/repo/worktrees/feature-auth',
    containerId: 'container-1',
    containerPort: 41001,
    templateSlug: '3-agent-dev',
    ownerProjectId: 'project-1',
    status: 'running',
    description: null,
    devchainProjectId: 'project-1',
    mergeCommit: null,
    mergeConflicts: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  };

  let sqlite: Database.Database;
  let service: TaskMergeService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: join(__dirname, '../../../../../drizzle') });
    sqlite
      .prepare(
        `INSERT INTO worktrees (
           id, name, branch_name, base_branch, repo_path, worktree_path, container_id,
           container_port, template_slug, owner_project_id, status, devchain_project_id,
           runtime_type, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        worktree.id,
        worktree.name,
        worktree.branchName,
        worktree.baseBranch,
        worktree.repoPath,
        worktree.worktreePath,
        worktree.containerId,
        worktree.containerPort,
        worktree.templateSlug,
        worktree.ownerProjectId,
        worktree.status,
        worktree.devchainProjectId,
        'container',
        worktree.createdAt.toISOString(),
        worktree.updatedAt.toISOString(),
      );

    const store = {
      getById: jest.fn().mockResolvedValue(worktree),
    };
    service = new TaskMergeService(store as unknown as WorktreesStore, db);

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
  });

  afterEach(() => {
    global.fetch = originalFetch;
    sqlite.close();
  });

  it('persists epic and agent rows in one real-database transaction', async () => {
    await service.mergeTasksFromContainer(worktree.id);

    expect(
      (sqlite.prepare('SELECT COUNT(*) AS count FROM merged_epics').get() as { count: number })
        .count,
    ).toBe(1);
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS count FROM merged_agents').get() as { count: number })
        .count,
    ).toBe(1);
  });

  it('rolls back epic rows when agent persistence fails', async () => {
    sqlite.exec('DROP TABLE merged_agents');

    await expect(service.mergeTasksFromContainer(worktree.id)).rejects.toThrow(
      'no such table: merged_agents',
    );
    expect(sqlite.prepare('SELECT * FROM merged_epics').all()).toEqual([]);
  });
});
