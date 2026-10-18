// Real SQLite is the cheapest reliable layer for migration upgrades, constraints,
// transaction admission and foreign-key deletion behavior through the storage API.
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  ConflictError,
  NotFoundError,
  ProjectFrozenError,
  ValidationError,
  WorktreeCapReachedError,
} from '../../../common/errors/error-types';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import type { CreateWorktree } from '../models/domain.models';
import { ProjectWriteGate } from '../write-gate/project-write-gate';
import { LocalStorageService } from './local-storage.service';

const migrationsFolder = join(__dirname, '../../../../drizzle');

describe('LocalStorageService worktrees', () => {
  let database: ReturnType<typeof createTestDatabase>;
  let storage: LocalStorageService;
  let gate: ProjectWriteGate;
  let projectId: string;

  async function createProject(name: string): Promise<string> {
    return (
      await storage.createProject({
        name,
        rootPath: `/tmp/${name}`,
        description: null,
        isTemplate: false,
      })
    ).id;
  }

  function lane(name: string, overrides: Partial<CreateWorktree> = {}): CreateWorktree {
    const id = randomUUID();
    return {
      id,
      projectId,
      name,
      path: `/tmp/worktrees/${projectId}/${name}`,
      branch: `devchain/${name}-${id.slice(0, 6)}`,
      baseBranch: 'master',
      baseSha: 'a'.repeat(40),
      createdByType: 'user',
      ...overrides,
    };
  }

  beforeEach(async () => {
    database = createTestDatabase();
    gate = new ProjectWriteGate();
    storage = new LocalStorageService(database.db, undefined, undefined, gate);
    projectId = await createProject('worktree-project');
  });

  afterEach(() => database.sqlite.close());

  it('persists lane identity and configuration and generates missing identity fields', async () => {
    const data = lane('storage');
    delete data.id;
    const row = await storage.createWorktree(data);

    expect(row).toEqual({
      ...data,
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      epicId: null,
      createdByAgentId: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(row.updatedAt).toBe(row.createdAt);
    expect(await storage.getWorktree(row.id)).toEqual(row);
  });

  it('looks up names case-insensitively within the requested project', async () => {
    const row = await storage.createWorktree(lane('Storage'));
    expect(await storage.getWorktreeByName(projectId, 'sToRaGe')).toEqual(row);
    expect(await storage.getWorktreeByName(await createProject('other'), 'Storage')).toBeNull();
    expect(await storage.getWorktreeByName(projectId, 'missing')).toBeNull();
    await expect(storage.getWorktree(randomUUID())).rejects.toThrow(NotFoundError);
  });

  it('enforces case-insensitive name uniqueness in both the API and the database', async () => {
    const row = await storage.createWorktree(lane('Storage'));
    await expect(storage.createWorktree(lane('storage'))).rejects.toThrow(ConflictError);
    expect(() =>
      database.sqlite
        .prepare(
          `INSERT INTO worktrees
           (id, project_id, name, path, branch, base_branch, base_sha, created_by_type, created_at, updated_at)
           SELECT ?, project_id, 'STORAGE', path, branch, base_branch, base_sha, created_by_type, created_at, updated_at
           FROM worktrees WHERE id = ?`,
        )
        .run(randomUUID(), row.id),
    ).toThrow(/UNIQUE constraint failed/);
    expect(await storage.listWorktrees(projectId)).toEqual([row]);
  });

  it('lists only the project lanes in name order and allows names in another project', async () => {
    const beta = await storage.createWorktree(lane('beta'));
    const alpha = await storage.createWorktree(lane('alpha'));
    const otherId = await createProject('other');
    const other = await storage.createWorktree(lane('alpha', { projectId: otherId }));
    expect(await storage.listWorktrees(projectId)).toEqual([alpha, beta]);
    expect(await storage.listWorktrees(otherId)).toEqual([other]);
  });

  it('deletes the lane, frees its name and refuses a missing id', async () => {
    const row = await storage.createWorktree(lane('Storage'));
    await storage.deleteWorktree(row.id);
    await expect(storage.deleteWorktree(row.id)).rejects.toThrow(NotFoundError);
    await expect(storage.getWorktree(row.id)).rejects.toThrow(NotFoundError);
    const replacement = await storage.createWorktree(lane('storage'));
    expect(await storage.listWorktrees(projectId)).toEqual([replacement]);
  });

  it('admits exactly one of two concurrent inserts at cap minus one across storage instances', async () => {
    for (let i = 0; i < 4; i++) await storage.createWorktree(lane(`existing-${i}`));
    await storage.createWorktree(lane('other', { projectId: await createProject('other') }));
    const secondStorage = new LocalStorageService(database.db);
    const results = await Promise.allSettled([
      storage.createWorktreeAtomicCapped(lane('first'), 5),
      secondStorage.createWorktreeAtomicCapped(lane('second'), 5),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(WorktreeCapReachedError);
    expect(rejected[0].reason.details).toEqual({ maxWorktrees: 5, currentCount: 5 });
    const rows = await storage.listWorktrees(projectId);
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => ['first', 'second'].includes(row.name))).toHaveLength(1);
  });

  it('rolls back a failed capped insert and leaves capacity available', async () => {
    await expect(
      storage.createWorktreeAtomicCapped(lane('invalid', { path: 'relative/path' }), 1),
    ).rejects.toThrow(ValidationError);
    const row = await storage.createWorktreeAtomicCapped(lane('valid'), 1);
    expect(await storage.listWorktrees(projectId)).toEqual([row]);
  });

  it.each([-1, 1.5, NaN])('refuses an invalid cap %s without inserting', async (cap) => {
    await expect(storage.createWorktreeAtomicCapped(lane('invalid'), cap)).rejects.toThrow(
      ValidationError,
    );
    expect(await storage.listWorktrees(projectId)).toEqual([]);
  });

  it('deletes lane records when their project is deleted', async () => {
    await storage.createWorktree(lane('storage'));
    await storage.deleteProject(projectId);
    expect(await storage.listWorktrees(projectId)).toEqual([]);
    expect(database.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('preserves the lane and nulls its links when its epic and creator agent are deleted', async () => {
    const status = (await storage.listStatuses(projectId)).items[0];
    const epic = await storage.createEpic({
      projectId,
      title: 'Linked lane',
      description: null,
      statusId: status.id,
      data: null,
      tags: [],
    });
    const profile = await storage.createAgentProfile({ projectId, name: 'creator' });
    const provider = await storage.createProvider({ name: 'test-provider' });
    const config = await storage.createProfileProviderConfig({
      profileId: profile.id,
      providerId: provider.id,
      name: 'default',
      options: null,
      env: null,
    });
    const agent = await storage.createAgent({
      projectId,
      profileId: profile.id,
      providerConfigId: config.id,
      name: 'creator',
    });
    const row = await storage.createWorktree(
      lane('linked', { epicId: epic.id, createdByType: 'agent', createdByAgentId: agent.id }),
    );
    expect(await storage.getWorktree(row.id)).toEqual(row);
    await storage.deleteEpic(epic.id);
    expect(await storage.getWorktree(row.id)).toEqual({ ...row, epicId: null });
    await storage.deleteAgent(agent.id);
    expect(await storage.getWorktree(row.id)).toEqual({
      ...row,
      epicId: null,
      createdByAgentId: null,
    });
    expect(database.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('rejects nonexistent project references and invalid creator types at the database boundary', async () => {
    await expect(
      storage.createWorktree(lane('missing-project', { projectId: randomUUID() })),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    const row = await storage.createWorktree(lane('valid'));
    expect(() =>
      database.sqlite
        .prepare('UPDATE worktrees SET created_by_type = ? WHERE id = ?')
        .run('bot', row.id),
    ).toThrow(/CHECK constraint failed/);
    expect(await storage.getWorktree(row.id)).toEqual(row);
  });

  it('blocks worktree writes to frozen projects while keeping reads available', async () => {
    const row = await storage.createWorktree(lane('existing'));
    gate.markFrozen(projectId, new Date().toISOString());
    await expect(storage.createWorktree(lane('new'))).rejects.toThrow(ProjectFrozenError);
    await expect(storage.createWorktreeAtomicCapped(lane('capped'), 5)).rejects.toThrow(
      ProjectFrozenError,
    );
    await expect(storage.deleteWorktree(row.id)).rejects.toThrow(ProjectFrozenError);
    expect(await storage.listWorktrees(projectId)).toEqual([row]);
    expect(await storage.getWorktree(row.id)).toEqual(row);
  });

  it('upgrades the preceding schema while preserving existing project data', async () => {
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
    ) as {
      entries: Array<{ tag: string }>;
    };
    const migrationIndex = journal.entries.findIndex(
      (entry) => entry.tag === '0094_agent_worktree_lanes',
    );
    expect(migrationIndex).toBeGreaterThan(0);
    const entries = journal.entries.slice(0, migrationIndex);
    const previousFolder = mkdtempSync(join(tmpdir(), 'devchain-before-lanes-'));
    const sqlite = new Database(':memory:');
    try {
      mkdirSync(join(previousFolder, 'meta'));
      for (const entry of entries) {
        copyFileSync(
          join(migrationsFolder, `${entry.tag}.sql`),
          join(previousFolder, `${entry.tag}.sql`),
        );
      }
      writeFileSync(
        join(previousFolder, 'meta/_journal.json'),
        JSON.stringify({ ...journal, entries }),
      );
      migrate(drizzle(sqlite), { migrationsFolder: previousFolder });
      sqlite.pragma('foreign_keys = ON');
      const upgraded = new LocalStorageService(drizzle(sqlite));
      const project = await upgraded.createProject({
        name: 'before-lanes',
        rootPath: '/tmp/before-lanes',
        description: null,
        isTemplate: false,
      });
      migrate(drizzle(sqlite), { migrationsFolder });
      expect(await upgraded.getProject(project.id)).toEqual(project);
      const row = await upgraded.createWorktree(lane('upgraded', { projectId: project.id }));
      expect(await upgraded.getWorktree(row.id)).toEqual(row);
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      sqlite.close();
      rmSync(previousFolder, { recursive: true, force: true });
    }
  });
});
