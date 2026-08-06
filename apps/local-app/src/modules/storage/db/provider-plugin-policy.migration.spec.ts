import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('0071 provider plugin policy migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE providers (id TEXT PRIMARY KEY NOT NULL);
    `);

    const migration = readFileSync(
      join(__dirname, '../../../../drizzle/0071_special_avengers.sql'),
      'utf8',
    ).replace(/--> statement-breakpoint/g, '');
    sqlite.exec(migration);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('creates both tables with composite uniqueness and required columns', () => {
    const tableNames = sqlite
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (?, ?)
         ORDER BY name`,
      )
      .all('provider_plugin_defaults', 'project_provider_plugin_overrides');
    expect(tableNames).toEqual([
      { name: 'project_provider_plugin_overrides' },
      { name: 'provider_plugin_defaults' },
    ]);

    sqlite.exec(`
      INSERT INTO projects (id) VALUES ('project-1');
      INSERT INTO providers (id) VALUES ('provider-1');
      INSERT INTO provider_plugin_defaults
        (provider_id, plugin_id, enabled, created_at, updated_at)
      VALUES ('provider-1', 'plugin@market', 1, 'created', 'updated');
      INSERT INTO project_provider_plugin_overrides
        (project_id, provider_id, plugin_id, enabled, created_at, updated_at)
      VALUES ('project-1', 'provider-1', 'plugin@market', 0, 'created', 'updated');
    `);

    expect(() =>
      sqlite.exec(`
        INSERT INTO provider_plugin_defaults
          (provider_id, plugin_id, enabled, created_at, updated_at)
        VALUES ('provider-1', 'plugin@market', 0, 'created-2', 'updated-2');
      `),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      sqlite.exec(`
        INSERT INTO project_provider_plugin_overrides
          (project_id, provider_id, plugin_id, enabled, created_at, updated_at)
        VALUES ('project-1', 'provider-1', 'plugin@market', 1, 'created-2', 'updated-2');
      `),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('cascades project and provider deletion to their policy rows', () => {
    sqlite.exec(`
      INSERT INTO projects (id) VALUES ('project-1'), ('project-2');
      INSERT INTO providers (id) VALUES ('provider-1'), ('provider-2');
      INSERT INTO provider_plugin_defaults
        (provider_id, plugin_id, enabled, created_at, updated_at)
      VALUES
        ('provider-1', 'one@market', 1, 'created', 'updated'),
        ('provider-2', 'two@market', 1, 'created', 'updated');
      INSERT INTO project_provider_plugin_overrides
        (project_id, provider_id, plugin_id, enabled, created_at, updated_at)
      VALUES
        ('project-1', 'provider-1', 'one@market', 0, 'created', 'updated'),
        ('project-2', 'provider-2', 'two@market', 0, 'created', 'updated');
      DELETE FROM projects WHERE id = 'project-1';
    `);

    expect(
      sqlite.prepare('SELECT project_id FROM project_provider_plugin_overrides').all(),
    ).toEqual([{ project_id: 'project-2' }]);
    expect(sqlite.prepare('SELECT provider_id FROM provider_plugin_defaults').all()).toHaveLength(
      2,
    );

    sqlite.prepare('DELETE FROM providers WHERE id = ?').run('provider-2');
    expect(sqlite.prepare('SELECT * FROM project_provider_plugin_overrides').all()).toEqual([]);
    expect(sqlite.prepare('SELECT provider_id FROM provider_plugin_defaults').all()).toEqual([
      { provider_id: 'provider-1' },
    ]);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
