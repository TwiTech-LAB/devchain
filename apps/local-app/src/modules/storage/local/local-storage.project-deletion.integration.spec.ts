import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
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
        isTemplate: false,
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

  function seedProviderEnv(env: Record<string, string>): string {
    const providerId = randomUUID();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO providers (id, name, mcp_configured, env, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?)`,
      )
      .run(providerId, `provider-${providerId.slice(0, 6)}`, JSON.stringify(env), now, now);
    return providerId;
  }

  function insertScopeRow(providerId: string, envKey: string, projectId: string): void {
    sqlite
      .prepare(
        'INSERT INTO provider_env_scopes (provider_id, env_key, project_id, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(providerId, envKey, projectId, new Date().toISOString());
  }

  function providerEnvKeys(providerId: string): string[] {
    const row = sqlite.prepare('SELECT env FROM providers WHERE id = ?').get(providerId) as {
      env: string | null;
    };
    return Object.keys(JSON.parse(row.env ?? '{}')).sort();
  }

  function scopeRows(providerId: string): Array<{ env_key: string; project_id: string }> {
    return sqlite
      .prepare(
        'SELECT env_key, project_id FROM provider_env_scopes WHERE provider_id = ? ORDER BY env_key, project_id',
      )
      .all(providerId) as Array<{ env_key: string; project_id: string }>;
  }

  it('drops a provider env key whose last scope row belonged to the deleted project', async () => {
    const providerId = seedProviderEnv({
      SOLO_KEY: 'solo-value',
      SHARED_KEY: 'shared-value',
      GLOBAL_KEY: 'global-value',
    });
    const deleted = await seedProject('Env scoped deleted');
    const survivor = await seedProject('Env scoped survivor');
    const unrelated = await seedProject('Env unrelated survivor');
    insertScopeRow(providerId, 'SOLO_KEY', deleted);
    insertScopeRow(providerId, 'SHARED_KEY', deleted);
    insertScopeRow(providerId, 'SHARED_KEY', survivor);

    await service.deleteProject(deleted);

    expect(providerEnvKeys(providerId)).toEqual(['GLOBAL_KEY', 'SHARED_KEY']);
    expect(scopeRows(providerId)).toEqual([{ env_key: 'SHARED_KEY', project_id: survivor }]);
    const survivorEnv = service.getProviderEnvForProject(providerId, survivor);
    expect(Object.keys(survivorEnv ?? {}).sort()).toEqual(['GLOBAL_KEY', 'SHARED_KEY']);
    expect(survivorEnv?.SHARED_KEY === 'shared-value').toBe(true);
    expect(survivorEnv?.GLOBAL_KEY === 'global-value').toBe(true);
    const unrelatedEnv = service.getProviderEnvForProject(providerId, unrelated);
    expect(Object.keys(unrelatedEnv ?? {})).toEqual(['GLOBAL_KEY']);
    expect(unrelatedEnv?.GLOBAL_KEY === 'global-value').toBe(true);
  });

  it('leaves a provider env key global on purpose when the deleted project had no scope rows', async () => {
    const providerId = seedProviderEnv({ GLOBAL_KEY: 'global-value' });
    const deleted = await seedProject('Env global deleted');

    await service.deleteProject(deleted);

    expect(providerEnvKeys(providerId)).toEqual(['GLOBAL_KEY']);
    expect(scopeRows(providerId)).toEqual([]);
  });

  it('rolls back the provider env change and the scope rows when the project delete fails after it', async () => {
    const providerId = seedProviderEnv({ SOLO_KEY: 'solo-value', GLOBAL_KEY: 'global-value' });
    const deleted = await seedProject('Env scoped rollback');
    insertScopeRow(providerId, 'SOLO_KEY', deleted);
    sqlite.exec(`
      CREATE TRIGGER reject_env_project_delete
      BEFORE DELETE ON projects
      WHEN OLD.id = '${deleted}'
      BEGIN
        SELECT RAISE(ABORT, 'forced env rollback failure');
      END;
    `);

    await expect(service.deleteProject(deleted)).rejects.toThrow('forced env rollback failure');

    expect(providerEnvKeys(providerId)).toEqual(['GLOBAL_KEY', 'SOLO_KEY']);
    expect(scopeRows(providerId)).toEqual([{ env_key: 'SOLO_KEY', project_id: deleted }]);
    expect(sqlite.prepare('SELECT id FROM projects WHERE id = ?').get(deleted)).toBeDefined();
  });
});
