import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { ConflictError } from '../../../common/errors/error-types';
import { TransactionRunner } from '../db/transaction-runner';
import { IntegrationCredentialCipher } from './integration-credential-cipher';
import { LocalStorageService } from './local-storage.service';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for the storage transaction to start.');
}

describe('LocalStorageService project deletion transactions', () => {
  let sqlite: Database.Database;
  let service: LocalStorageService;
  let secretDirectory: string;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    secretDirectory = mkdtempSync(join(tmpdir(), 'devchain-project-deletion-'));
    service = new LocalStorageService(
      drizzle(sqlite),
      new IntegrationCredentialCipher({
        secretDirectory,
        machineIdentity: 'test-host:test-user',
      }),
    );
  });

  afterEach(() => {
    sqlite.close();
    rmSync(secretDirectory, { recursive: true, force: true });
  });

  async function seedProject(name: string): Promise<string> {
    return (
      await service.createProject({
        name,
        description: null,
        rootPath: `/tmp/${name.toLowerCase().replaceAll(' ', '-')}`,
      })
    ).id;
  }

  async function connectProject(projectId: string): Promise<void> {
    await service.replaceIntegrationConnection(
      {
        projectId,
        provider: 'clickup',
        credentials: { provider: 'clickup', token: 'test-token' },
      },
      async () => undefined,
    );
  }

  it('rejects a connected project before deleting any children', async () => {
    const projectId = await seedProject('Connected project');
    const tag = await service.createTag({ projectId, name: 'retained-child' });
    await connectProject(projectId);

    await expect(service.deleteProject(projectId)).rejects.toMatchObject<Partial<ConflictError>>({
      code: 'conflict',
      details: {
        code: 'PROJECT_HAS_INTEGRATION_CONNECTIONS',
        projectId,
      },
    });

    expect(sqlite.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)).toBeDefined();
    expect(sqlite.prepare('SELECT id FROM tags WHERE id = ?').get(tag.id)).toBeDefined();
    expect(
      sqlite.prepare('SELECT id FROM integration_connections WHERE project_id = ?').get(projectId),
    ).toBeDefined();
  });

  it('rolls back earlier cascade deletes when a later child deletion fails', async () => {
    const projectId = await seedProject('Rollback project');
    const tag = await service.createTag({ projectId, name: 'must-survive' });
    sqlite.exec(`
      CREATE TRIGGER reject_status_delete
      BEFORE DELETE ON statuses
      WHEN OLD.project_id = '${projectId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced cascade failure');
      END;
    `);

    await expect(service.deleteProject(projectId)).rejects.toThrow('forced cascade failure');

    expect(sqlite.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)).toBeDefined();
    expect(sqlite.prepare('SELECT id FROM tags WHERE id = ?').get(tag.id)).toBeDefined();
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM statuses WHERE project_id = ?').get(projectId),
    ).toEqual({ count: 5 });
  });

  it('serializes connect-first so deletion observes and preserves the connection', async () => {
    const projectId = await seedProject('Connect first');
    const blocker = deferred();
    const held = new TransactionRunner(sqlite).runImmediateAsync(async () => {
      await blocker.promise;
    });
    await waitUntil(() => sqlite.inTransaction);

    const verified = deferred();
    const connection = service.replaceIntegrationConnection(
      {
        projectId,
        provider: 'clickup',
        credentials: { provider: 'clickup', token: 'connect-first-token' },
      },
      async () => {
        verified.resolve();
      },
    );
    await verified.promise;
    await Promise.resolve();
    const deletion = service.deleteProject(projectId);

    blocker.resolve();
    await held;
    await expect(connection).resolves.toMatchObject({ projectId, provider: 'clickup' });
    await expect(deletion).rejects.toMatchObject({
      details: { code: 'PROJECT_HAS_INTEGRATION_CONNECTIONS', projectId },
    });
    expect(sqlite.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)).toBeDefined();
  });

  it('serializes delete-first so the later connection insert fails its project foreign key', async () => {
    const projectId = await seedProject('Delete first');
    const deletion = service.deleteProject(projectId);
    await waitUntil(() => sqlite.inTransaction);

    const verify = jest.fn().mockResolvedValue(undefined);
    const connection = service.replaceIntegrationConnection(
      {
        projectId,
        provider: 'clickup',
        credentials: { provider: 'clickup', token: 'delete-first-token' },
      },
      verify,
    );

    await expect(deletion).resolves.toBeUndefined();
    await expect(connection).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)).toBeUndefined();
    expect(sqlite.prepare('SELECT id FROM integration_connections').all()).toEqual([]);
  });
});
