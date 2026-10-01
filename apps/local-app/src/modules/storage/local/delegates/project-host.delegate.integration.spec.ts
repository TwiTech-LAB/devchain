import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { ProjectHostStorageDelegate } from './project-host.delegate';
import { ProviderStorageDelegate } from './provider.delegate';
import { createStorageDelegateContext } from './base-storage.delegate';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../../drizzle');

describe('ProjectHostStorageDelegate — release keeps scoped provider env scoped (integration)', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let delegate: ProjectHostStorageDelegate;
  let providers: ProviderStorageDelegate;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');

    const context = createStorageDelegateContext(db);
    delegate = new ProjectHostStorageDelegate(context);
    providers = new ProviderStorageDelegate(context, {
      updateProvider: async () => {
        throw new Error('not used in this spec');
      },
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  function seedProvider(env: Record<string, string>): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO providers
         (id, name, mcp_configured, env, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?)`,
      )
      .run(id, `provider-${id.slice(0, 6)}`, JSON.stringify(env), now, now);
    return id;
  }

  function seedProject(name: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO projects (id, name, root_path, is_template, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
      )
      .run(id, name, `/tmp/${id}`, now, now);
    return id;
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

  async function seedFrozenProject(name: string): Promise<string> {
    const projectId = seedProject(name);
    await delegate.setProjectFrozen(projectId, new Date().toISOString());
    return projectId;
  }

  it('drops a key scoped only to the released project and keeps a shared key, its other row and a global key', async () => {
    const providerId = seedProvider({
      SOLO_KEY: 'solo-value',
      SHARED_KEY: 'shared-value',
      GLOBAL_KEY: 'global-value',
    });
    const released = await seedFrozenProject('Released');
    const survivor = seedProject('Survivor');
    const unrelated = seedProject('Unrelated');
    insertScopeRow(providerId, 'SOLO_KEY', released);
    insertScopeRow(providerId, 'SHARED_KEY', released);
    insertScopeRow(providerId, 'SHARED_KEY', survivor);

    await delegate.releaseProject(released);

    expect(providerEnvKeys(providerId)).toEqual(['GLOBAL_KEY', 'SHARED_KEY']);
    expect(scopeRows(providerId)).toEqual([{ env_key: 'SHARED_KEY', project_id: survivor }]);
    expect(
      Object.keys(providers.getProviderEnvForProject(providerId, survivor) ?? {}).sort(),
    ).toEqual(['GLOBAL_KEY', 'SHARED_KEY']);
    // The key that only the released project held no longer applies anywhere.
    expect(
      Object.keys(providers.getProviderEnvForProject(providerId, unrelated) ?? {}).sort(),
    ).toEqual(['GLOBAL_KEY']);
  });

  it('keeps a global key and an empty-scope provider env untouched when the released project had no scope rows', async () => {
    const providerId = seedProvider({ GLOBAL_KEY: 'global-value' });
    const otherProviderId = seedProvider({});
    const released = await seedFrozenProject('Released without scopes');

    await delegate.releaseProject(released);

    expect(providerEnvKeys(providerId)).toEqual(['GLOBAL_KEY']);
    expect(providerEnvKeys(otherProviderId)).toEqual([]);
    expect(scopeRows(providerId)).toEqual([]);
  });

  it('rolls back the env change and the scope rows together when the release fails after the env change', async () => {
    const providerId = seedProvider({ SOLO_KEY: 'solo-value', GLOBAL_KEY: 'global-value' });
    const released = await seedFrozenProject('Rollback release');
    insertScopeRow(providerId, 'SOLO_KEY', released);
    sqlite.exec(`
      CREATE TRIGGER reject_release_project_delete
      BEFORE DELETE ON projects
      WHEN OLD.id = '${released}'
      BEGIN
        SELECT RAISE(ABORT, 'forced release failure');
      END;
    `);

    await expect(delegate.releaseProject(released)).rejects.toThrow('forced release failure');

    expect(providerEnvKeys(providerId)).toEqual(['GLOBAL_KEY', 'SOLO_KEY']);
    expect(scopeRows(providerId)).toEqual([{ env_key: 'SOLO_KEY', project_id: released }]);
    expect(sqlite.prepare('SELECT id FROM projects WHERE id = ?').get(released)).toBeDefined();
  });
});
