import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_PATH = join(__dirname, '../../../../drizzle/0073_integration_storage.sql');
const MANAGED_SUBTASK_MIGRATION_PATH = join(
  __dirname,
  '../../../../drizzle/0075_misty_franklin_richards.sql',
);
const PROJECT_OWNERSHIP_SCHEMA_MIGRATION_PATH = join(
  __dirname,
  '../../../../drizzle/0077_familiar_morbius.sql',
);
const PROJECT_OWNERSHIP_MIGRATION_PATH = join(
  __dirname,
  '../../../../drizzle/0078_preserve_legacy_connection_ownership.sql',
);

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, 'utf8').replace(/--> statement-breakpoint/g, '');
}

function readSql(path: string): string {
  return readFileSync(path, 'utf8').replace(/--> statement-breakpoint/g, '');
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

describe('0078 legacy integration connection ownership migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        is_template INTEGER DEFAULT 0 NOT NULL
      );
      CREATE TABLE epics (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
      );
    `);
    sqlite.exec(readMigration());
    sqlite.exec(readSql(MANAGED_SUBTASK_MIGRATION_PATH));
    sqlite.exec(readSql(PROJECT_OWNERSHIP_SCHEMA_MIGRATION_PATH));
  });

  afterEach(() => {
    sqlite.close();
  });

  function insertProject(id: string, isTemplate = 0): void {
    sqlite.prepare('INSERT INTO projects (id, is_template) VALUES (?, ?)').run(id, isTemplate);
  }

  function insertConnection(
    id: string,
    provider: 'clickup' | 'jira',
    ciphertextMarker: string,
  ): void {
    sqlite
      .prepare(
        `INSERT INTO integration_connections (
          id, provider, credential_ciphertext, generation, subtask_sync_enabled,
          sync_setting_revision, created_at, updated_at
        ) VALUES (?, ?, ?, 7, 1, 4, 'created-at', 'updated-at')`,
      )
      .run(id, provider, ciphertextMarker);
  }

  function insertManagedLink(input: {
    id: string;
    epicId: string | null;
    epicIdSnapshot: string;
    parentSourceLinkId: string;
    connectionId: string;
    provider: 'clickup' | 'jira';
  }): void {
    sqlite
      .prepare(
        `INSERT INTO external_managed_subtask_links (
          id, epic_id, epic_id_snapshot, parent_epic_id_snapshot,
          parent_source_link_id_snapshot, connection_id_snapshot, provider,
          remote_scope_key, work_area_remote_id, parent_remote_task_id,
          connection_generation, sync_setting_revision, ownership_token,
          desired_version, desired_fingerprint, created_at, updated_at
        ) VALUES (?, ?, ?, 'parent-epic', ?, ?, ?, 'scope', 'work-area',
          'parent-task', 7, 4, ?, 1, 'fingerprint', 'created-at', 'updated-at')`,
      )
      .run(
        input.id,
        input.epicId,
        input.epicIdSnapshot,
        input.parentSourceLinkId,
        input.connectionId,
        input.provider,
        `ownership-${input.id}`,
      );
  }

  function applyOwnershipMigration(): void {
    sqlite.exec(readSql(PROJECT_OWNERSHIP_MIGRATION_PATH));
  }

  function expectCiphertextCopies(marker: string, count: number): void {
    expect(
      sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM integration_connections WHERE credential_ciphertext = ?',
        )
        .get(marker),
    ).toEqual({ count });
  }

  it('keeps a zero-project credential as one explicit unassigned row', () => {
    insertConnection('legacy-clickup', 'clickup', 'opaque-zero-project');

    applyOwnershipMigration();

    expect(
      sqlite
        .prepare(
          `SELECT id, project_id, provider, legacy_source_connection_id, generation,
                  subtask_sync_enabled, sync_setting_revision, created_at, updated_at
           FROM integration_connections`,
        )
        .all(),
    ).toEqual([
      {
        id: 'legacy-clickup',
        project_id: null,
        provider: 'clickup',
        legacy_source_connection_id: null,
        generation: 7,
        subtask_sync_enabled: 1,
        sync_setting_revision: 4,
        created_at: 'created-at',
        updated_at: 'updated-at',
      },
    ]);
    expectCiphertextCopies('opaque-zero-project', 1);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('uses the sole non-template project only when no stronger evidence exists', () => {
    insertProject('project-only');
    insertProject('template-project', 1);
    insertConnection('legacy-jira', 'jira', 'opaque-sole-project');

    applyOwnershipMigration();

    const migrated = sqlite
      .prepare(
        `SELECT id, project_id, provider, legacy_source_connection_id, generation,
                subtask_sync_enabled, sync_setting_revision, created_at, updated_at
         FROM integration_connections`,
      )
      .get() as Record<string, unknown>;
    expect(migrated).toEqual({
      id: 'dc000000-0000-4000-8000-000000000001',
      project_id: 'project-only',
      provider: 'jira',
      legacy_source_connection_id: 'legacy-jira',
      generation: 7,
      subtask_sync_enabled: 1,
      sync_setting_revision: 4,
      created_at: 'created-at',
      updated_at: 'updated-at',
    });
    expectCiphertextCopies('opaque-sole-project', 1);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('keeps a no-evidence credential unassigned when several projects exist', () => {
    insertProject('project-a');
    insertProject('project-b');
    insertConnection('legacy-clickup', 'clickup', 'opaque-multi-no-evidence');

    applyOwnershipMigration();

    expect(
      sqlite
        .prepare(
          `SELECT id, project_id, legacy_source_connection_id
           FROM integration_connections`,
        )
        .all(),
    ).toEqual([
      {
        id: 'legacy-clickup',
        project_id: null,
        legacy_source_connection_id: null,
      },
    ]);
    expectCiphertextCopies('opaque-multi-no-evidence', 1);
  });

  it('skips a pre-existing deterministic target identity without changing ownership', () => {
    insertProject('project-only');
    insertConnection('dc000000-0000-4000-8000-000000000001', 'clickup', 'opaque-id-collision');

    applyOwnershipMigration();

    expect(
      sqlite
        .prepare(
          `SELECT id, project_id, legacy_source_connection_id
           FROM integration_connections`,
        )
        .get(),
    ).toEqual({
      id: 'dc000000-0000-4000-8000-000000000002',
      project_id: 'project-only',
      legacy_source_connection_id: 'dc000000-0000-4000-8000-000000000001',
    });
    expectCiphertextCopies('opaque-id-collision', 1);
  });

  it('copies only proven projects and remaps task and managed-subtask fences', () => {
    insertProject('project-a');
    insertProject('project-b');
    insertProject('project-unused');
    sqlite.exec(`
      INSERT INTO epics (id, project_id) VALUES
        ('epic-a', 'project-a'),
        ('epic-b', 'project-b');
    `);
    insertConnection('legacy-clickup', 'clickup', 'opaque-proven-projects');
    sqlite.exec(`
      INSERT INTO external_task_links (
        id, epic_id, connection_id, provider, remote_scope_key, remote_task_id,
        source_snapshot, created_at, updated_at
      ) VALUES
        ('source-a', 'epic-a', 'legacy-clickup', 'clickup', 'scope-a', 'task-a',
         '{}', 'created-at', 'updated-at'),
        ('source-b', 'epic-b', 'legacy-clickup', 'clickup', 'scope-b', 'task-b',
         '{}', 'created-at', 'updated-at');
    `);
    insertManagedLink({
      id: 'managed-parent-evidence',
      epicId: null,
      epicIdSnapshot: 'deleted-child-a',
      parentSourceLinkId: 'source-a',
      connectionId: 'legacy-clickup',
      provider: 'clickup',
    });
    insertManagedLink({
      id: 'managed-child-evidence',
      epicId: 'epic-b',
      epicIdSnapshot: 'epic-b',
      parentSourceLinkId: 'source-a',
      connectionId: 'legacy-clickup',
      provider: 'clickup',
    });

    applyOwnershipMigration();

    const connections = sqlite
      .prepare(
        `SELECT id, project_id, provider, legacy_source_connection_id, generation,
                subtask_sync_enabled, sync_setting_revision, created_at, updated_at
         FROM integration_connections ORDER BY project_id`,
      )
      .all() as Array<Record<string, unknown>>;
    expect(connections).toHaveLength(2);
    expect(connections.map((row) => row.project_id)).toEqual(['project-a', 'project-b']);
    expect(connections.map((row) => row.id)).toEqual([
      'dc000000-0000-4000-8000-000000000001',
      'dc000000-0000-4000-8000-000000000002',
    ]);
    expect(connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          project_id: 'project-a',
          provider: 'clickup',
          legacy_source_connection_id: 'legacy-clickup',
          generation: 7,
          subtask_sync_enabled: 1,
          sync_setting_revision: 4,
          created_at: 'created-at',
          updated_at: 'updated-at',
        }),
        expect.objectContaining({
          project_id: 'project-b',
          provider: 'clickup',
          legacy_source_connection_id: 'legacy-clickup',
          generation: 7,
          subtask_sync_enabled: 1,
          sync_setting_revision: 4,
          created_at: 'created-at',
          updated_at: 'updated-at',
        }),
      ]),
    );
    expect(connections.every((row) => row.project_id !== 'project-unused')).toBe(true);
    expect(connections.every((row) => row.id !== 'legacy-clickup')).toBe(true);
    expectCiphertextCopies('opaque-proven-projects', 2);

    const idByProject = new Map(
      connections.map((connection) => [connection.project_id, connection.id]),
    );
    expect(
      sqlite.prepare('SELECT id, connection_id FROM external_task_links ORDER BY id').all(),
    ).toEqual([
      { id: 'source-a', connection_id: idByProject.get('project-a') },
      { id: 'source-b', connection_id: idByProject.get('project-b') },
    ]);
    expect(
      sqlite
        .prepare(
          `SELECT id, connection_id_snapshot, connection_generation, sync_setting_revision
           FROM external_managed_subtask_links ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: 'managed-child-evidence',
        connection_id_snapshot: idByProject.get('project-b'),
        connection_generation: 7,
        sync_setting_revision: 4,
      },
      {
        id: 'managed-parent-evidence',
        connection_id_snapshot: idByProject.get('project-a'),
        connection_generation: 7,
        sync_setting_revision: 4,
      },
    ]);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('retains one unassigned source for unprovable managed state', () => {
    insertProject('project-a');
    insertProject('project-b');
    sqlite.exec("INSERT INTO epics (id, project_id) VALUES ('epic-a', 'project-a');");
    insertConnection('legacy-jira', 'jira', 'opaque-recoverable-state');
    sqlite.exec(`
      INSERT INTO external_task_links (
        id, epic_id, connection_id, provider, remote_scope_key, remote_task_id,
        source_snapshot, created_at, updated_at
      ) VALUES ('source-a', 'epic-a', 'legacy-jira', 'jira', 'scope-a', 'task-a',
        '{}', 'created-at', 'updated-at');
    `);
    insertManagedLink({
      id: 'managed-unproven',
      epicId: null,
      epicIdSnapshot: 'deleted-child',
      parentSourceLinkId: 'deleted-parent-source',
      connectionId: 'legacy-jira',
      provider: 'jira',
    });

    applyOwnershipMigration();

    const rows = sqlite
      .prepare(
        `SELECT id, project_id, legacy_source_connection_id
         FROM integration_connections ORDER BY project_id`,
      )
      .all();
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          id: 'legacy-jira',
          project_id: null,
          legacy_source_connection_id: null,
        },
        expect.objectContaining({
          project_id: 'project-a',
          legacy_source_connection_id: 'legacy-jira',
        }),
      ]),
    );
    expect(rows).toHaveLength(2);
    const projectConnection = rows.find(
      (row) => (row as { project_id: string | null }).project_id === 'project-a',
    ) as { id: string };
    expect(
      sqlite.prepare("SELECT connection_id FROM external_task_links WHERE id = 'source-a'").get(),
    ).toEqual({ connection_id: projectConnection.id });
    expect(
      sqlite
        .prepare(
          `SELECT connection_id_snapshot, connection_generation, sync_setting_revision
           FROM external_managed_subtask_links WHERE id = 'managed-unproven'`,
        )
        .get(),
    ).toEqual({
      connection_id_snapshot: 'legacy-jira',
      connection_generation: 7,
      sync_setting_revision: 4,
    });
    expectCiphertextCopies('opaque-recoverable-state', 2);

    expect(() =>
      sqlite.exec(`
        INSERT INTO integration_connections (
          id, project_id, provider, credential_ciphertext, generation,
          subtask_sync_enabled, sync_setting_revision, created_at, updated_at
        ) VALUES ('second-unassigned', NULL, 'jira', 'other', 1, 0, 1, 'c', 'u');
      `),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      sqlite.exec(`
        INSERT INTO integration_connections (
          id, project_id, provider, credential_ciphertext, generation,
          subtask_sync_enabled, sync_setting_revision, created_at, updated_at
        ) VALUES ('missing-project', 'missing', 'clickup', 'other', 1, 0, 1, 'c', 'u');
      `),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rolls back copies and remaps when copy insertion fails', () => {
    insertProject('project-a');
    sqlite.exec("INSERT INTO epics (id, project_id) VALUES ('epic-a', 'project-a');");
    insertConnection('legacy-clickup', 'clickup', 'opaque-rollback');
    sqlite.exec(`
      INSERT INTO external_task_links (
        id, epic_id, connection_id, provider, remote_scope_key, remote_task_id,
        source_snapshot, created_at, updated_at
      ) VALUES ('source-a', 'epic-a', 'legacy-clickup', 'clickup', 'scope-a', 'task-a',
        '{}', 'created-at', 'updated-at');
      CREATE TRIGGER fail_project_connection_copy
      BEFORE INSERT ON integration_connections
      WHEN NEW.id <> 'legacy-clickup'
      BEGIN
        SELECT RAISE(ABORT, 'forced copy failure');
      END;
    `);

    const migrateInTransaction = sqlite.transaction(() => applyOwnershipMigration());
    expect(() => migrateInTransaction()).toThrow(/forced copy failure/);

    expect(
      sqlite
        .prepare("PRAGMA table_info('integration_connections')")
        .all()
        .map((column) => (column as { name: string }).name),
    ).toContain('project_id');
    expect(
      sqlite
        .prepare("PRAGMA index_list('integration_connections')")
        .all()
        .map((index) => (index as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        'integration_connections_legacy_provider_unique',
        'integration_connections_project_provider_unique',
      ]),
    );
    expect(sqlite.prepare('SELECT id, project_id FROM integration_connections').all()).toEqual([
      { id: 'legacy-clickup', project_id: null },
    ]);
    expect(
      sqlite.prepare("SELECT connection_id FROM external_task_links WHERE id = 'source-a'").get(),
    ).toEqual({ connection_id: 'legacy-clickup' });
    expect(
      sqlite
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE name LIKE '__integration_connection_project_%'`,
        )
        .all(),
    ).toEqual([]);
    expectCiphertextCopies('opaque-rollback', 1);
  });
});
