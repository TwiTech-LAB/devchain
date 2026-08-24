import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_PATH = join(__dirname, '../../../../drizzle/0075_misty_franklin_richards.sql');

// Layer: backend integration. SQLite must prove defaults, uniqueness, and
// ON DELETE SET NULL while immutable ownership snapshots remain intact.
describe('0075 managed subtask storage migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE epics (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE integration_connections (
        id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        credential_ciphertext TEXT NOT NULL,
        generation INTEGER DEFAULT 1 NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO epics (id) VALUES ('child-1');
      INSERT INTO integration_connections
        (id, provider, credential_ciphertext, generation, created_at, updated_at)
      VALUES ('connection-1', 'clickup', 'encrypted', 1, 'created', 'updated');
    `);
    sqlite.exec(readFileSync(MIGRATION_PATH, 'utf8').replace(/--> statement-breakpoint/g, ''));
  });

  afterEach(() => sqlite.close());

  it('defaults connection settings and preserves managed snapshots after Epic deletion', () => {
    expect(
      sqlite
        .prepare('SELECT subtask_sync_enabled, sync_setting_revision FROM integration_connections')
        .get(),
    ).toEqual({ subtask_sync_enabled: 0, sync_setting_revision: 1 });

    const insert = sqlite.prepare(`
      INSERT INTO external_managed_subtask_links (
        id, epic_id, epic_id_snapshot, parent_epic_id_snapshot,
        parent_source_link_id_snapshot, connection_id_snapshot, provider,
        remote_scope_key, work_area_remote_id, parent_remote_task_id,
        connection_generation, sync_setting_revision, ownership_token,
        desired_version, desired_fingerprint, created_at, updated_at
      ) VALUES (?, 'child-1', 'child-1', 'parent-1', 'source-1', 'connection-1',
        'clickup', 'workspace-1', 'list-1', 'parent-task', 1, 1, ?, 1,
        'fingerprint', 'created', 'updated')
    `);
    insert.run('managed-1', 'ownership-1');
    expect(() => insert.run('managed-2', 'ownership-2')).toThrow(/UNIQUE constraint failed/);

    sqlite.exec("DELETE FROM epics WHERE id = 'child-1'");
    expect(
      sqlite
        .prepare(
          `SELECT epic_id, epic_id_snapshot, parent_epic_id_snapshot,
                  parent_source_link_id_snapshot, ownership_token
           FROM external_managed_subtask_links`,
        )
        .get(),
    ).toEqual({
      epic_id: null,
      epic_id_snapshot: 'child-1',
      parent_epic_id_snapshot: 'parent-1',
      parent_source_link_id_snapshot: 'source-1',
      ownership_token: 'ownership-1',
    });
  });
});
