import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { LocalStorageService } from './local-storage.service';

// Backend integration (real :memory: SQLite). This is the cheapest layer that proves
// the composite upsert targets, boolean mapping, and delete result contract together.
describe('LocalStorageService - provider plugin policy integration', () => {
  let sqlite: Database.Database;
  let service: LocalStorageService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: join(__dirname, '../../../../drizzle') });
    service = new LocalStorageService(db);

    sqlite
      .prepare(
        `INSERT INTO projects
          (id, name, root_path, is_template, is_private, created_at, updated_at)
         VALUES (?, ?, ?, 0, 0, ?, ?)`,
      )
      .run('project-1', 'Project One', '/tmp/project-one', 'created', 'updated');
  });

  afterEach(() => {
    sqlite.close();
  });

  it('upserts one default row and one project override per composite key', async () => {
    const provider = await service.createProvider({ name: 'claude' });

    const initialDefault = await service.upsertProviderPluginDefault({
      providerId: provider.id,
      pluginId: 'alpha@marketplace',
      enabled: true,
    });
    const updatedDefault = await service.upsertProviderPluginDefault({
      providerId: provider.id,
      pluginId: 'alpha@marketplace',
      enabled: false,
    });
    await service.upsertProjectProviderPluginOverride({
      projectId: 'project-1',
      providerId: provider.id,
      pluginId: 'alpha@marketplace',
      enabled: true,
    });
    const updatedOverride = await service.upsertProjectProviderPluginOverride({
      projectId: 'project-1',
      providerId: provider.id,
      pluginId: 'alpha@marketplace',
      enabled: false,
    });

    expect(updatedDefault).toMatchObject({
      providerId: provider.id,
      pluginId: 'alpha@marketplace',
      enabled: false,
      createdAt: initialDefault.createdAt,
    });
    expect(updatedOverride).toMatchObject({
      projectId: 'project-1',
      providerId: provider.id,
      pluginId: 'alpha@marketplace',
      enabled: false,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM provider_plugin_defaults').get()).toEqual({
      count: 1,
    });
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM project_provider_plugin_overrides').get(),
    ).toEqual({ count: 1 });
  });

  it('lists exact case-sensitive plugin IDs and resets rows idempotently', async () => {
    const provider = await service.createProvider({ name: 'codex' });
    await service.upsertProviderPluginDefault({
      providerId: provider.id,
      pluginId: 'Alpha@marketplace',
      enabled: true,
    });
    await service.upsertProviderPluginDefault({
      providerId: provider.id,
      pluginId: 'alpha@marketplace',
      enabled: false,
    });
    await service.upsertProjectProviderPluginOverride({
      projectId: 'project-1',
      providerId: provider.id,
      pluginId: 'stale-plugin@removed-marketplace',
      enabled: true,
    });

    await expect(service.listProviderPluginDefaults(provider.id)).resolves.toEqual([
      expect.objectContaining({ pluginId: 'Alpha@marketplace', enabled: true }),
      expect.objectContaining({ pluginId: 'alpha@marketplace', enabled: false }),
    ]);
    await expect(
      service.deleteProjectProviderPluginOverride(
        'project-1',
        provider.id,
        'stale-plugin@removed-marketplace',
      ),
    ).resolves.toBe(true);
    await expect(
      service.deleteProjectProviderPluginOverride(
        'project-1',
        provider.id,
        'stale-plugin@removed-marketplace',
      ),
    ).resolves.toBe(false);
  });
});
