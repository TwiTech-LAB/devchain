import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { ProviderStorageDelegate } from './provider.delegate';
import { createStorageDelegateContext } from './base-storage.delegate';
import type { Provider } from '../../models/domain.models';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../../drizzle');

describe('ProviderStorageDelegate — env scopes (integration)', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let delegate: ProviderStorageDelegate;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');

    const context = createStorageDelegateContext(db);
    delegate = new ProviderStorageDelegate(context, {
      updateProvider: async (id, data) => delegate.updateProvider(id, data),
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  function seedProvider(
    env?: Record<string, string>,
    options?: { name?: string; claudeLaunchSettingsJson?: string | null },
  ): Provider {
    const id = randomUUID();
    const now = new Date().toISOString();
    const envJson = env ? JSON.stringify(env) : null;
    const name = options?.name ?? `provider-${id.slice(0, 6)}`;
    const claudeLaunchSettingsJson = options?.claudeLaunchSettingsJson ?? null;
    sqlite
      .prepare(
        `INSERT INTO providers
         (id, name, mcp_configured, claude_launch_settings_json, env, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(id, name, claudeLaunchSettingsJson, envJson, now, now);
    return {
      id,
      name,
      binPath: null,
      mcpConfigured: false,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      autoCompactThreshold: null,
      claudeLaunchSettingsJson,
      env: env ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  function seedProject(name?: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO projects (id, name, root_path, is_template, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
      )
      .run(id, name ?? `project-${id.slice(0, 6)}`, `/tmp/${id}`, now, now);
    return id;
  }

  function insertScopeRow(providerId: string, envKey: string, projectId: string): void {
    const now = new Date().toISOString();
    sqlite
      .prepare(
        'INSERT INTO provider_env_scopes (provider_id, env_key, project_id, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(providerId, envKey, projectId, now);
  }

  function countScopeRows(providerId?: string): number {
    if (providerId) {
      return (
        sqlite
          .prepare('SELECT COUNT(*) as cnt FROM provider_env_scopes WHERE provider_id = ?')
          .get(providerId) as { cnt: number }
      ).cnt;
    }
    return (
      sqlite.prepare('SELECT COUNT(*) as cnt FROM provider_env_scopes').get() as { cnt: number }
    ).cnt;
  }

  // ─── listEnvScopes ───

  describe('listEnvScopes', () => {
    it('returns empty object when no scope rows exist', () => {
      const provider = seedProvider({ API_KEY: 'sk-123' });
      expect(delegate.listEnvScopes(provider.id)).toEqual({});
    });

    it('returns correct map for multi-key multi-project scopes', () => {
      const provider = seedProvider({ KEY_A: 'a', KEY_B: 'b' });
      const p1 = seedProject('P1');
      const p2 = seedProject('P2');

      insertScopeRow(provider.id, 'KEY_A', p1);
      insertScopeRow(provider.id, 'KEY_A', p2);
      insertScopeRow(provider.id, 'KEY_B', p1);

      const scopes = delegate.listEnvScopes(provider.id);
      expect(scopes).toEqual({
        KEY_A: expect.arrayContaining([p1, p2]),
        KEY_B: [p1],
      });
      expect(scopes['KEY_A']).toHaveLength(2);
    });

    it('returns empty object for non-existent provider', () => {
      expect(delegate.listEnvScopes(randomUUID())).toEqual({});
    });
  });

  // ─── listEnvScopesByProviderIds ───

  describe('listEnvScopesByProviderIds', () => {
    it('returns empty map for empty input', () => {
      expect(delegate.listEnvScopesByProviderIds([])).toEqual(new Map());
    });

    it('returns scopes for multiple providers in a single call', () => {
      const prov1 = seedProvider({ KEY_A: 'a' });
      const prov2 = seedProvider({ KEY_B: 'b' });
      const proj = seedProject();

      insertScopeRow(prov1.id, 'KEY_A', proj);
      insertScopeRow(prov2.id, 'KEY_B', proj);

      const result = delegate.listEnvScopesByProviderIds([prov1.id, prov2.id]);
      expect(result.get(prov1.id)).toEqual({ KEY_A: [proj] });
      expect(result.get(prov2.id)).toEqual({ KEY_B: [proj] });
    });

    it('omits providers with no scope rows from the map', () => {
      const prov1 = seedProvider({ KEY_A: 'a' });
      const prov2 = seedProvider({ KEY_B: 'b' });

      const result = delegate.listEnvScopesByProviderIds([prov1.id, prov2.id]);
      expect(result.size).toBe(0);
    });
  });

  // ─── getProviderEnvForProject ───

  describe('getProviderEnvForProject', () => {
    it('returns all env keys when no scopes exist (global)', () => {
      const provider = seedProvider({ API_KEY: 'sk-123', MODEL: 'opus' });
      const projectId = seedProject();

      const result = delegate.getProviderEnvForProject(provider.id, projectId);
      expect(result).toEqual({ API_KEY: 'sk-123', MODEL: 'opus' });
    });

    it('returns null when provider has no env', () => {
      const provider = seedProvider();
      const projectId = seedProject();

      expect(delegate.getProviderEnvForProject(provider.id, projectId)).toBeNull();
    });

    it('filters keys with scopes that exclude the project', () => {
      const provider = seedProvider({ SCOPED_KEY: 'secret', GLOBAL_KEY: 'open' });
      const p1 = seedProject('Allowed');
      const p2 = seedProject('Excluded');

      insertScopeRow(provider.id, 'SCOPED_KEY', p1);

      expect(delegate.getProviderEnvForProject(provider.id, p1)).toEqual({
        SCOPED_KEY: 'secret',
        GLOBAL_KEY: 'open',
      });

      expect(delegate.getProviderEnvForProject(provider.id, p2)).toEqual({
        GLOBAL_KEY: 'open',
      });
    });

    it('returns null when all keys are scoped and project is excluded', () => {
      const provider = seedProvider({ ONLY_KEY: 'val' });
      const p1 = seedProject('Allowed');
      const p2 = seedProject('Excluded');

      insertScopeRow(provider.id, 'ONLY_KEY', p1);

      expect(delegate.getProviderEnvForProject(provider.id, p2)).toBeNull();
    });

    it('throws NotFoundError for non-existent provider', () => {
      const projectId = seedProject();
      expect(() => delegate.getProviderEnvForProject(randomUUID(), projectId)).toThrow('not found');
    });
  });

  // ─── updateProviderWithScopes ───

  describe('updateProviderWithScopes', () => {
    it('returns explicitly mapped camelCase provider fields after an update', () => {
      const original = '{"tui":"default"}';
      const updated = '{\n  "futureSetting": true\n}';
      const provider = seedProvider(undefined, {
        name: 'claude',
        claudeLaunchSettingsJson: original,
      });

      const result = delegate.updateProviderWithScopes(
        provider.id,
        { claudeLaunchSettingsJson: updated },
        undefined,
        [],
      );

      expect(result.claudeLaunchSettingsJson).toBe(updated);
      expect(result).not.toHaveProperty('claude_launch_settings_json');
      expect(result).toMatchObject({
        id: provider.id,
        name: 'claude',
        binPath: null,
        mcpConfigured: false,
        autoCompactThreshold: null,
        env: null,
      });
    });

    it('updates provider and replaces scopes when envScopes is provided', () => {
      const provider = seedProvider({ KEY_A: 'a', KEY_B: 'b' });
      const p1 = seedProject();
      const p2 = seedProject();

      insertScopeRow(provider.id, 'KEY_A', p1);

      const result = delegate.updateProviderWithScopes(
        provider.id,
        { env: { KEY_A: 'a-new', KEY_B: 'b' } },
        { KEY_A: [p2], KEY_B: [p1, p2] },
        ['KEY_A', 'KEY_B'],
      );

      expect(result.env).toEqual({ KEY_A: 'a-new', KEY_B: 'b' });

      const scopes = delegate.listEnvScopes(provider.id);
      expect(scopes['KEY_A']).toEqual([p2]);
      expect(scopes['KEY_B']).toEqual(expect.arrayContaining([p1, p2]));
    });

    it('filters out scope entries for keys not in currentEnvKeys', () => {
      const provider = seedProvider({ KEY_A: 'a' });
      const p1 = seedProject();

      delegate.updateProviderWithScopes(provider.id, {}, { KEY_A: [p1], REMOVED_KEY: [p1] }, [
        'KEY_A',
      ]);

      const scopes = delegate.listEnvScopes(provider.id);
      expect(scopes['KEY_A']).toEqual([p1]);
      expect(scopes['REMOVED_KEY']).toBeUndefined();
    });

    it('prunes orphan scope rows when envScopes is undefined and keys are removed', () => {
      const provider = seedProvider({ KEY_A: 'a', KEY_B: 'b' });
      const p1 = seedProject();

      insertScopeRow(provider.id, 'KEY_A', p1);
      insertScopeRow(provider.id, 'KEY_B', p1);

      delegate.updateProviderWithScopes(provider.id, { env: { KEY_A: 'a' } }, undefined, ['KEY_A']);

      const scopes = delegate.listEnvScopes(provider.id);
      expect(scopes['KEY_A']).toEqual([p1]);
      expect(scopes['KEY_B']).toBeUndefined();
      expect(countScopeRows(provider.id)).toBe(1);
    });

    it('prunes all scope rows when envScopes is undefined and currentEnvKeys is empty', () => {
      const provider = seedProvider({ KEY_A: 'a' });
      const p1 = seedProject();

      insertScopeRow(provider.id, 'KEY_A', p1);

      delegate.updateProviderWithScopes(provider.id, { env: null }, undefined, []);

      expect(countScopeRows(provider.id)).toBe(0);
    });

    it('is atomic: rolls back both provider update and scope changes on failure', async () => {
      const provider = seedProvider({ KEY_A: 'original' });
      const p1 = seedProject();

      insertScopeRow(provider.id, 'KEY_A', p1);

      const badProjectId = randomUUID();

      expect(() =>
        delegate.updateProviderWithScopes(
          provider.id,
          { env: { KEY_A: 'modified' } },
          { KEY_A: [badProjectId] },
          ['KEY_A'],
        ),
      ).toThrow();

      const dbProvider = await delegate.getProvider(provider.id);
      expect(dbProvider.env).toEqual({ KEY_A: 'original' });

      const scopes = delegate.listEnvScopes(provider.id);
      expect(scopes['KEY_A']).toEqual([p1]);
    });

    it('throws NotFoundError when provider does not exist', () => {
      expect(() => delegate.updateProviderWithScopes(randomUUID(), {}, undefined, [])).toThrow(
        'not found',
      );
    });
  });

  // ─── Cascade deletes ───

  describe('cascade deletes', () => {
    it('deletes scope rows when provider is deleted', () => {
      const provider = seedProvider({ KEY: 'v' });
      const p1 = seedProject();
      insertScopeRow(provider.id, 'KEY', p1);

      expect(countScopeRows(provider.id)).toBe(1);
      sqlite.prepare('DELETE FROM providers WHERE id = ?').run(provider.id);
      expect(countScopeRows(provider.id)).toBe(0);
    });

    it('deletes scope rows when project is deleted', () => {
      const provider = seedProvider({ KEY: 'v' });
      const p1 = seedProject();
      const p2 = seedProject();
      insertScopeRow(provider.id, 'KEY', p1);
      insertScopeRow(provider.id, 'KEY', p2);

      expect(countScopeRows(provider.id)).toBe(2);
      sqlite.prepare('DELETE FROM projects WHERE id = ?').run(p1);
      expect(countScopeRows(provider.id)).toBe(1);

      const scopes = delegate.listEnvScopes(provider.id);
      expect(scopes['KEY']).toEqual([p2]);
    });
  });
});
