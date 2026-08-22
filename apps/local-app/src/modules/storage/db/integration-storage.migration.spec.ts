import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_PATH = join(__dirname, '../../../../drizzle/0073_integration_storage.sql');

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, 'utf8').replace(/--> statement-breakpoint/g, '');
}

describe('0073 integration storage migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec('CREATE TABLE epics (id TEXT PRIMARY KEY NOT NULL);');
    sqlite.exec(readMigration());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('creates provider-unique connections and remote-scope-unique task links', () => {
    sqlite.exec(`
      INSERT INTO epics (id) VALUES ('epic-1'), ('epic-2');
      INSERT INTO integration_connections
        (id, provider, credential_ciphertext, generation, created_at, updated_at)
      VALUES
        ('connection-clickup', 'clickup', 'encrypted-clickup', 1, 'created', 'updated'),
        ('connection-jira', 'jira', 'encrypted-jira', 1, 'created', 'updated');
      INSERT INTO external_task_links
        (id, epic_id, connection_id, provider, remote_scope_key, remote_task_id,
         source_snapshot, created_at, updated_at)
      VALUES
        ('link-1', 'epic-1', 'connection-clickup', 'clickup', 'workspace-1', 'task-1',
         '{"title":"Task one"}', 'created', 'updated');
    `);

    expect(() =>
      sqlite.exec(`
        INSERT INTO integration_connections
          (id, provider, credential_ciphertext, generation, created_at, updated_at)
        VALUES ('connection-clickup-2', 'clickup', 'other', 1, 'created', 'updated');
      `),
    ).toThrow(/UNIQUE constraint failed/);

    expect(() =>
      sqlite.exec(`
        INSERT INTO external_task_links
          (id, epic_id, connection_id, provider, remote_scope_key, remote_task_id,
           source_snapshot, created_at, updated_at)
        VALUES ('link-duplicate', 'epic-2', NULL, 'clickup', 'workspace-1', 'task-1',
          '{}', 'created', 'updated');
      `),
    ).toThrow(/UNIQUE constraint failed/);

    expect(() =>
      sqlite.exec(`
        INSERT INTO external_task_links
          (id, epic_id, connection_id, provider, remote_scope_key, remote_task_id,
           source_snapshot, created_at, updated_at)
        VALUES
          ('link-other-scope', 'epic-2', NULL, 'clickup', 'workspace-2', 'task-1',
           '{}', 'created', 'updated'),
          ('link-other-provider', 'epic-2', 'connection-jira', 'jira', 'workspace-1', 'task-1',
           '{}', 'created', 'updated');
      `),
    ).not.toThrow();

    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('preserves source snapshots and nulls only the connection reference on disconnect', () => {
    sqlite.exec(`
      INSERT INTO epics (id) VALUES ('epic-1');
      INSERT INTO integration_connections
        (id, provider, credential_ciphertext, generation, created_at, updated_at)
      VALUES ('connection-1', 'jira', 'encrypted', 1, 'created', 'updated');
      INSERT INTO external_task_links
        (id, epic_id, connection_id, provider, remote_scope_key, remote_task_id,
         source_snapshot, created_at, updated_at)
      VALUES ('link-1', 'epic-1', 'connection-1', 'jira', 'acme.example', 'issue-10001',
        '{"title":"Persisted source"}', 'created', 'updated');
      DELETE FROM integration_connections WHERE id = 'connection-1';
    `);

    expect(
      sqlite
        .prepare(
          `SELECT epic_id, connection_id, provider, remote_scope_key, remote_task_id,
                  source_snapshot
           FROM external_task_links WHERE id = 'link-1'`,
        )
        .get(),
    ).toEqual({
      epic_id: 'epic-1',
      connection_id: null,
      provider: 'jira',
      remote_scope_key: 'acme.example',
      remote_task_id: 'issue-10001',
      source_snapshot: '{"title":"Persisted source"}',
    });

    sqlite.exec("DELETE FROM epics WHERE id = 'epic-1'");
    expect(sqlite.prepare('SELECT * FROM external_task_links').all()).toEqual([]);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
