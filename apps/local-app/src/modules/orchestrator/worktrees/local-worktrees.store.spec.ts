import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { worktrees as sqliteWorktrees } from '../../storage/db/schema';
import { CreateWorktreeRecordInput } from './worktrees.store';
import { LocalWorktreesStore } from './local-worktrees.store';

function createInput(
  overrides: Partial<CreateWorktreeRecordInput> = {},
): CreateWorktreeRecordInput {
  return {
    name: 'feature-auth',
    branchName: 'feature/auth',
    baseBranch: 'main',
    repoPath: '/repo',
    worktreePath: '/repo/worktrees/feature-auth',
    templateSlug: 'default',
    ownerProjectId: 'project-1',
    status: 'creating',
    description: 'Auth worktree',
    ...overrides,
  };
}

describe('LocalWorktreesStore', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let store: LocalWorktreesStore;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    const migrationsFolder = join(__dirname, '../../../../drizzle');
    migrate(db, { migrationsFolder });
    store = new LocalWorktreesStore(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('create() persists row with generated UUID and ISO timestamps', async () => {
    const created = await store.create(createInput());

    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(created.ownerProjectId).toBe('project-1');
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);

    const [raw] = await db.select().from(sqliteWorktrees).where(eq(sqliteWorktrees.id, created.id));
    expect(raw?.createdAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(raw?.updatedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(raw?.ownerProjectId).toBe('project-1');
    expect(raw?.runtimeType).toBe('container');
  });

  it('list() returns all rows', async () => {
    await store.create(createInput({ name: 'feature-a', branchName: 'feature/a' }));
    await store.create(createInput({ name: 'feature-b', branchName: 'feature/b' }));

    const rows = await store.list();

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.name)).toEqual(expect.arrayContaining(['feature-a', 'feature-b']));
  });

  it('listByOwnerProject() returns only rows for the owner project', async () => {
    await store.create(
      createInput({ name: 'feature-a', branchName: 'feature/a', ownerProjectId: 'project-a' }),
    );
    await store.create(
      createInput({ name: 'feature-b', branchName: 'feature/b', ownerProjectId: 'project-b' }),
    );
    await store.create(
      createInput({ name: 'feature-c', branchName: 'feature/c', ownerProjectId: 'project-a' }),
    );

    const rows = await store.listByOwnerProject('project-a');

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.name).sort()).toEqual(['feature-a', 'feature-c']);
  });

  it('getById() returns row when found and null when missing', async () => {
    const created = await store.create(createInput());

    const found = await store.getById(created.id);
    const missing = await store.getById('missing-id');

    expect(found?.id).toBe(created.id);
    expect(missing).toBeNull();
  });

  it('getByName() returns matching row', async () => {
    await store.create(createInput({ name: 'feature-a', branchName: 'feature/a' }));
    await store.create(createInput({ name: 'feature-b', branchName: 'feature/b' }));

    const found = await store.getByName('feature-b');

    expect(found?.name).toBe('feature-b');
  });

  it('getByContainerId() returns matching row', async () => {
    const created = await store.create(createInput());
    await store.update(created.id, { containerId: 'container-123' });

    const found = await store.getByContainerId('container-123');

    expect(found?.id).toBe(created.id);
  });

  it('listMonitored() returns only running and error statuses', async () => {
    const running = await store.create(
      createInput({ name: 'running', branchName: 'branch/running' }),
    );
    const error = await store.create(createInput({ name: 'error', branchName: 'branch/error' }));
    await store.create(createInput({ name: 'stopped', branchName: 'branch/stopped' }));

    await store.update(running.id, { status: 'running' });
    await store.update(error.id, { status: 'error' });

    const monitored = await store.listMonitored();

    expect(monitored.map((row) => row.status).sort()).toEqual(['error', 'running']);
  });

  it('update() patches fields, refreshes updatedAt, and returns null for missing row', async () => {
    const created = await store.create(createInput());

    const updated = await store.update(created.id, {
      status: 'running',
      containerId: 'container-456',
      containerPort: 4012,
      errorMessage: null,
    });

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('running');
    expect(updated?.containerId).toBe('container-456');
    expect(updated?.containerPort).toBe(4012);
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

    const missing = await store.update('missing-id', { status: 'error' });
    expect(missing).toBeNull();
  });

  it('remove() deletes rows', async () => {
    const created = await store.create(createInput());

    await store.remove(created.id);
    const found = await store.getById(created.id);

    expect(found).toBeNull();
  });
});
