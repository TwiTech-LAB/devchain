import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');
const PROJECT_OWNERSHIP_MIGRATION_PATH = join(
  __dirname,
  '../../../../drizzle/0085_clumsy_zodiak.sql',
);

const LEGACY_UNASSIGNED = '00000000-0000-0000-0000-000000000000';

function readSql(path: string): string {
  return readFileSync(path, 'utf8').replace(/--> statement-breakpoint/g, '');
}

describe('0085 project ownership migration', () => {
  let sqlite: Database.Database;

  function buildPreMigrationSchema(): void {
    sqlite.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL
      );
      CREATE TABLE epics (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE integration_connections (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT REFERENCES projects(id),
        provider TEXT NOT NULL,
        credential_ciphertext TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE external_task_links (
        id TEXT PRIMARY KEY NOT NULL,
        epic_id TEXT NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
        connection_id TEXT REFERENCES integration_connections(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        remote_scope_key TEXT NOT NULL,
        remote_task_id TEXT NOT NULL,
        source_snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX external_task_links_remote_identity_unique
        ON external_task_links (provider, remote_scope_key, remote_task_id);
      CREATE TABLE external_estimate_log_states (
        provider TEXT NOT NULL,
        remote_scope_key TEXT NOT NULL,
        remote_task_id TEXT NOT NULL,
        logged_minutes INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        pending_operation_id TEXT,
        pending_delta_minutes INTEGER,
        pending_estimate_total_minutes INTEGER,
        pending_started_at TEXT,
        pending_connection_id TEXT,
        pending_connection_generation INTEGER,
        pending_phase TEXT,
        pending_resolution TEXT,
        aggregation_time_zone TEXT,
        pending_activity_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX external_estimate_log_states_remote_identity_idx
        ON external_estimate_log_states (provider, remote_scope_key, remote_task_id);
      CREATE UNIQUE INDEX external_estimate_log_states_pending_operation_idx
        ON external_estimate_log_states (pending_operation_id)
        WHERE pending_operation_id IS NOT NULL;
      CREATE TABLE external_estimate_log_days (
        provider TEXT NOT NULL,
        remote_scope_key TEXT NOT NULL,
        remote_task_id TEXT NOT NULL,
        activity_date TEXT NOT NULL,
        logged_minutes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, remote_scope_key, remote_task_id, activity_date)
      );
    `);
  }

  function insertProject(id: string): void {
    sqlite.prepare('INSERT INTO projects (id) VALUES (?)').run(id);
  }

  function insertEpic(id: string, projectId: string): void {
    sqlite.prepare('INSERT INTO epics (id, project_id) VALUES (?, ?)').run(id, projectId);
  }

  function insertConnection(id: string, projectId: string | null): void {
    sqlite
      .prepare(
        `INSERT INTO integration_connections
          (id, project_id, provider, credential_ciphertext, generation, created_at, updated_at)
         VALUES (?, ?, 'jira', 'opaque', 1, 'created', 'updated')`,
      )
      .run(id, projectId);
  }

  function insertLink(id: string, epicId: string, scopeKey: string, taskId: string): void {
    sqlite
      .prepare(
        `INSERT INTO external_task_links
          (id, epic_id, connection_id, provider, remote_scope_key, remote_task_id,
           source_snapshot, created_at, updated_at)
         VALUES (?, ?, NULL, 'jira', ?, ?, '{"title":"Snapshot"}', 'created', 'updated')`,
      )
      .run(id, epicId, scopeKey, taskId);
  }

  function insertState(input: {
    scopeKey: string;
    taskId: string;
    loggedMinutes?: number;
    pendingOperationId?: string;
    pendingConnectionId?: string;
  }): void {
    sqlite
      .prepare(
        `INSERT INTO external_estimate_log_states
          (provider, remote_scope_key, remote_task_id, logged_minutes, revision,
           pending_operation_id, pending_delta_minutes, pending_estimate_total_minutes,
           pending_started_at, pending_connection_id, pending_connection_generation,
           pending_phase, pending_resolution, aggregation_time_zone,
           pending_activity_date, created_at, updated_at)
         VALUES ('jira', ?, ?, ?, 3, ?, ?, ?, ?, ?, ?, ?, ?, 'Europe/Berlin', ?, 'created', 'updated')`,
      )
      .run(
        input.scopeKey,
        input.taskId,
        input.loggedMinutes ?? 90,
        input.pendingOperationId ?? null,
        input.pendingOperationId ? 30 : null,
        input.pendingOperationId ? 120 : null,
        input.pendingOperationId ? '2026-09-01T10:00:00.000Z' : null,
        input.pendingConnectionId ?? null,
        input.pendingConnectionId ? 2 : null,
        input.pendingOperationId ? 'prepared' : null,
        null,
        input.pendingOperationId ? '2026-09-01' : null,
      );
  }

  function insertDay(scopeKey: string, taskId: string, date: string, minutes: number): void {
    sqlite
      .prepare(
        `INSERT INTO external_estimate_log_days
          (provider, remote_scope_key, remote_task_id, activity_date,
           logged_minutes, created_at, updated_at)
         VALUES ('jira', ?, ?, ?, ?, 'created', 'updated')`,
      )
      .run(scopeKey, taskId, date, minutes);
  }

  function stateOwner(scopeKey: string, taskId: string): string | undefined {
    return (
      sqlite
        .prepare(
          `SELECT project_id AS owner FROM external_estimate_log_states
           WHERE remote_scope_key = ? AND remote_task_id = ?`,
        )
        .get(scopeKey, taskId) as { owner: string | undefined } | undefined
    )?.owner;
  }

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    buildPreMigrationSchema();
  });

  afterEach(() => sqlite.close());

  it('backfills link project ids from their Epics and keeps snapshots and cascades', () => {
    insertProject('project-a');
    insertProject('project-b');
    insertEpic('epic-a', 'project-a');
    insertEpic('epic-b', 'project-b');
    insertLink('link-a', 'epic-a', 'acme.example', 'ENG-1');
    insertLink('link-b', 'epic-b', 'acme.example', 'ENG-2');

    sqlite.exec(readSql(PROJECT_OWNERSHIP_MIGRATION_PATH));

    expect(
      sqlite
        .prepare(
          `SELECT id, epic_id, project_id, connection_id, provider, remote_scope_key,
                  remote_task_id, source_snapshot
           FROM external_task_links ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: 'link-a',
        epic_id: 'epic-a',
        project_id: 'project-a',
        connection_id: null,
        provider: 'jira',
        remote_scope_key: 'acme.example',
        remote_task_id: 'ENG-1',
        source_snapshot: '{"title":"Snapshot"}',
      },
      {
        id: 'link-b',
        epic_id: 'epic-b',
        project_id: 'project-b',
        connection_id: null,
        provider: 'jira',
        remote_scope_key: 'acme.example',
        remote_task_id: 'ENG-2',
        source_snapshot: '{"title":"Snapshot"}',
      },
    ]);

    // Same remote identity may now link in two projects; a second link in
    // one project is rejected.
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO external_task_links
            (id, epic_id, project_id, connection_id, provider, remote_scope_key,
             remote_task_id, source_snapshot, created_at, updated_at)
           VALUES ('link-dup', 'epic-a', 'project-a', NULL, 'jira', 'acme.example',
             'ENG-1', '{}', 'created', 'updated')`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO external_task_links
            (id, epic_id, project_id, connection_id, provider, remote_scope_key,
             remote_task_id, source_snapshot, created_at, updated_at)
           VALUES ('link-other-project', 'epic-b', 'project-b', NULL, 'jira', 'acme.example',
             'ENG-1', '{}', 'created', 'updated')`,
        )
        .run(),
    ).not.toThrow();

    sqlite.exec("DELETE FROM epics WHERE id = 'epic-a'");
    expect(
      sqlite
        .prepare('SELECT id FROM external_task_links WHERE project_id = ' + "'project-a'")
        .all(),
    ).toEqual([]);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('attributes settled and pending checkpoints by compatible evidence', () => {
    insertProject('project-a');
    insertProject('project-b');
    insertEpic('epic-a', 'project-a');
    insertEpic('epic-b', 'project-b');
    insertConnection('conn-a', 'project-a');
    insertConnection('conn-b', 'project-b');
    insertConnection('conn-dead', 'project-a');
    insertConnection('conn-unassigned', null);

    // Settled checkpoint with a live link → the link's project.
    insertLink('link-a', 'epic-a', 'acme.example', 'ENG-settled');
    insertState({ scopeKey: 'acme.example', taskId: 'ENG-settled' });
    // Pending checkpoint whose extant pending connection matches the link.
    insertLink('link-a2', 'epic-a', 'acme.example', 'ENG-pending-own');
    insertState({
      scopeKey: 'acme.example',
      taskId: 'ENG-pending-own',
      pendingOperationId: 'op-own',
      pendingConnectionId: 'conn-a',
    });
    // Pending checkpoint with a deleted pending connection: the pending
    // operation's owner is unproven even beside a live link.
    insertLink('link-a3', 'epic-a', 'acme.example', 'ENG-pending-dead-conn');
    insertState({
      scopeKey: 'acme.example',
      taskId: 'ENG-pending-dead-conn',
      pendingOperationId: 'op-dead',
      pendingConnectionId: 'conn-dead',
    });
    // Pending checkpoint whose extant pending connection carries no project:
    // same unproven-owner outcome beside a live link.
    insertLink('link-a4', 'epic-a', 'acme.example', 'ENG-pending-projectless-conn');
    insertState({
      scopeKey: 'acme.example',
      taskId: 'ENG-pending-projectless-conn',
      pendingOperationId: 'op-projectless',
      pendingConnectionId: 'conn-unassigned',
    });
    // Linkless pending checkpoint with an extant pending connection.
    insertState({
      scopeKey: 'acme.example',
      taskId: 'ENG-pending-no-link',
      pendingOperationId: 'op-no-link',
      pendingConnectionId: 'conn-b',
    });
    // Linkless pending checkpoint whose pending connection has no project.
    insertState({
      scopeKey: 'acme.example',
      taskId: 'ENG-pending-unassigned',
      pendingOperationId: 'op-unassigned',
      pendingConnectionId: 'conn-unassigned',
    });

    sqlite.exec("DELETE FROM integration_connections WHERE id = 'conn-dead'");
    sqlite.exec(readSql(PROJECT_OWNERSHIP_MIGRATION_PATH));

    expect(stateOwner('acme.example', 'ENG-settled')).toBe('project-a');
    expect(stateOwner('acme.example', 'ENG-pending-own')).toBe('project-a');
    expect(stateOwner('acme.example', 'ENG-pending-dead-conn')).toBe(LEGACY_UNASSIGNED);
    expect(stateOwner('acme.example', 'ENG-pending-projectless-conn')).toBe(LEGACY_UNASSIGNED);
    expect(stateOwner('acme.example', 'ENG-pending-no-link')).toBe('project-b');
    expect(stateOwner('acme.example', 'ENG-pending-unassigned')).toBe(LEGACY_UNASSIGNED);
  });

  it('keeps conflicting or evidence-less history under the reserved legacy identity intact', () => {
    insertProject('project-a');
    insertProject('project-b');
    insertEpic('epic-a', 'project-a');
    insertConnection('conn-a', 'project-a');
    insertConnection('conn-b', 'project-b');

    // Link in project A while the pending operation came through project
    // B's connection: contradictory evidence requires explicit recovery.
    insertLink('link-a', 'epic-a', 'acme.example', 'ENG-conflict');
    insertState({
      scopeKey: 'acme.example',
      taskId: 'ENG-conflict',
      loggedMinutes: 75,
      pendingOperationId: 'op-conflict',
      pendingConnectionId: 'conn-b',
    });
    // No link, no pending evidence at all.
    insertState({ scopeKey: 'acme.example', taskId: 'ENG-orphan', loggedMinutes: 40 });
    insertDay('acme.example', 'ENG-orphan', '2026-08-30', 25);
    insertDay('acme.example', 'ENG-orphan', '2026-08-31', 15);

    sqlite.exec(readSql(PROJECT_OWNERSHIP_MIGRATION_PATH));

    expect(stateOwner('acme.example', 'ENG-conflict')).toBe(LEGACY_UNASSIGNED);
    expect(stateOwner('acme.example', 'ENG-orphan')).toBe(LEGACY_UNASSIGNED);
    // The complete scalar state and dated ledger survive unchanged.
    expect(
      sqlite
        .prepare(
          `SELECT logged_minutes, revision, pending_operation_id, pending_delta_minutes,
                  pending_phase, aggregation_time_zone, created_at, updated_at
           FROM external_estimate_log_states
           WHERE remote_task_id = 'ENG-conflict'`,
        )
        .get(),
    ).toEqual({
      logged_minutes: 75,
      revision: 3,
      pending_operation_id: 'op-conflict',
      pending_delta_minutes: 30,
      pending_phase: 'prepared',
      aggregation_time_zone: 'Europe/Berlin',
      created_at: 'created',
      updated_at: 'updated',
    });
    expect(
      sqlite
        .prepare(
          `SELECT project_id, activity_date, logged_minutes, created_at, updated_at
           FROM external_estimate_log_days ORDER BY activity_date`,
        )
        .all(),
    ).toEqual([
      {
        project_id: LEGACY_UNASSIGNED,
        activity_date: '2026-08-30',
        logged_minutes: 25,
        created_at: 'created',
        updated_at: 'updated',
      },
      {
        project_id: LEGACY_UNASSIGNED,
        activity_date: '2026-08-31',
        logged_minutes: 15,
        created_at: 'created',
        updated_at: 'updated',
      },
    ]);
  });

  it('replaces the global indexes with project-qualified ones and preserves checks', () => {
    insertProject('project-a');
    sqlite.exec(readSql(PROJECT_OWNERSHIP_MIGRATION_PATH));

    const stateIndexes = sqlite
      .prepare("PRAGMA index_list('external_estimate_log_states')")
      .all() as Array<{ name: string; unique: number }>;
    expect(stateIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'external_estimate_log_states_project_remote_identity_idx',
          unique: 1,
        }),
        expect.objectContaining({
          name: 'external_estimate_log_states_pending_operation_idx',
          unique: 1,
        }),
      ]),
    );
    expect(stateIndexes.map((index) => index.name)).not.toContain(
      'external_estimate_log_states_remote_identity_idx',
    );

    const insertState = sqlite.prepare(
      `INSERT INTO external_estimate_log_states
        (project_id, provider, remote_scope_key, remote_task_id, logged_minutes, revision,
         created_at, updated_at)
       VALUES (?, 'jira', 'acme.example', 'ENG-1', 90, 1, 'created', 'updated')`,
    );
    insertState.run('project-a');
    // Same remote identity is now per-project: a second project owns its own row.
    expect(() => insertState.run(LEGACY_UNASSIGNED)).not.toThrow();
    expect(() => insertState.run('project-a')).toThrow(/UNIQUE constraint failed/);

    // Validation constraints survive the rebuild.
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO external_estimate_log_states
            (project_id, provider, remote_scope_key, remote_task_id, logged_minutes, revision,
             created_at, updated_at)
           VALUES ('project-a', 'jira', 'acme.example', 'ENG-2', -1, 1, 'created', 'updated')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO external_estimate_log_states
            (project_id, provider, remote_scope_key, remote_task_id, logged_minutes, revision,
             created_at, updated_at)
           VALUES ('project-a', 'jira', 'acme.example', 'ENG-3', 0, 0, 'created', 'updated')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO external_estimate_log_states
            (project_id, provider, remote_scope_key, remote_task_id, logged_minutes, revision,
             pending_operation_id, pending_delta_minutes, created_at, updated_at)
           VALUES ('project-a', 'jira', 'acme.example', 'ENG-4', 0, 1, 'op-incomplete', 30,
             'created', 'updated')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    // Global pending-operation uniqueness survives.
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO external_estimate_log_states
            (project_id, provider, remote_scope_key, remote_task_id, logged_minutes, revision,
             pending_operation_id, pending_delta_minutes, pending_estimate_total_minutes,
             pending_started_at, pending_connection_id, pending_connection_generation,
             pending_phase, created_at, updated_at)
           VALUES ('project-a', 'jira', 'acme.example', 'ENG-5', 0, 1, 'op-incomplete', 30, 120,
             '2026-09-01T10:00:00.000Z', 'conn-a', 1, 'prepared', 'created', 'updated')`,
        )
        .run(),
    ).not.toThrow();

    expect(sqlite.prepare("PRAGMA foreign_key_list('external_estimate_log_states')").all()).toEqual(
      [],
    );
    expect(sqlite.prepare("PRAGMA foreign_key_list('external_estimate_log_days')").all()).toEqual(
      [],
    );

    const dayIndexes = sqlite
      .prepare("PRAGMA index_list('external_estimate_log_days')")
      .all() as Array<{ name: string; origin: string }>;
    expect(dayIndexes.filter((index) => index.origin !== 'pk')).toEqual([]);
  });

  it('rebuilds the dated ledger primary key with project identity', () => {
    insertProject('project-a');
    insertProject('project-b');
    insertEpic('epic-a', 'project-a');
    insertEpic('epic-b', 'project-b');
    // The pre-migration global uniqueness allows only one link for this
    // remote identity; project B links the same identity after the rebuild.
    insertLink('link-a', 'epic-a', 'acme.example', 'ENG-shared');
    insertState({ scopeKey: 'acme.example', taskId: 'ENG-shared', loggedMinutes: 30 });
    insertDay('acme.example', 'ENG-shared', '2026-08-30', 30);

    sqlite.exec(readSql(PROJECT_OWNERSHIP_MIGRATION_PATH));

    // The one pre-migration state row followed its link into project A.
    expect(stateOwner('acme.example', 'ENG-shared')).toBe('project-a');
    expect(
      sqlite
        .prepare(
          `SELECT project_id, provider, remote_scope_key, remote_task_id, activity_date,
                  logged_minutes
           FROM external_estimate_log_days`,
        )
        .all(),
    ).toEqual([
      {
        project_id: 'project-a',
        provider: 'jira',
        remote_scope_key: 'acme.example',
        remote_task_id: 'ENG-shared',
        activity_date: '2026-08-30',
        logged_minutes: 30,
      },
    ]);

    // Project B now links the same remote identity and logs the same date
    // as an independent per-project contribution.
    sqlite
      .prepare(
        `INSERT INTO external_task_links
          (id, epic_id, project_id, connection_id, provider, remote_scope_key, remote_task_id,
           source_snapshot, created_at, updated_at)
         VALUES ('link-b', 'epic-b', 'project-b', NULL, 'jira', 'acme.example', 'ENG-shared',
           '{}', 'created', 'updated')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO external_estimate_log_states
          (project_id, provider, remote_scope_key, remote_task_id, logged_minutes, revision,
           created_at, updated_at)
         VALUES ('project-b', 'jira', 'acme.example', 'ENG-shared', 20, 1, 'created', 'updated')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO external_estimate_log_days
          (project_id, provider, remote_scope_key, remote_task_id, activity_date,
           logged_minutes, created_at, updated_at)
         VALUES ('project-b', 'jira', 'acme.example', 'ENG-shared', '2026-08-30', 20,
           'created', 'updated')`,
      )
      .run();
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO external_estimate_log_days
            (project_id, provider, remote_scope_key, remote_task_id, activity_date,
             logged_minutes, created_at, updated_at)
           VALUES ('project-b', 'jira', 'acme.example', 'ENG-shared', '2026-08-30', 5,
             'created', 'updated')`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      sqlite
        .prepare(
          `UPDATE external_estimate_log_days SET logged_minutes = -1
           WHERE project_id = 'project-b'`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(
      sqlite
        .prepare(
          `SELECT project_id, logged_minutes FROM external_estimate_log_days
           WHERE remote_task_id = 'ENG-shared' ORDER BY project_id`,
        )
        .all(),
    ).toEqual([
      { project_id: 'project-a', logged_minutes: 30 },
      { project_id: 'project-b', logged_minutes: 20 },
    ]);
  });

  it('rolls the whole rebuild back when a later statement fails', () => {
    insertProject('project-a');
    insertEpic('epic-a', 'project-a');
    insertLink('link-a', 'epic-a', 'acme.example', 'ENG-1');
    insertState({ scopeKey: 'acme.example', taskId: 'ENG-1' });

    const migrateInTransaction = sqlite.transaction(() =>
      sqlite.exec(
        `${readSql(PROJECT_OWNERSHIP_MIGRATION_PATH)};\nSELECT * FROM __missing_table__;`,
      ),
    );
    expect(() => migrateInTransaction()).toThrow(/no such table: __missing_table__/);

    // The failed rebuild leaves the old tables exactly as they were.
    expect(
      sqlite
        .prepare("PRAGMA table_info('external_task_links')")
        .all()
        .map((column) => (column as { name: string }).name),
    ).not.toContain('project_id');
    expect(sqlite.prepare('SELECT id FROM external_task_links').all()).toEqual([{ id: 'link-a' }]);
    expect(sqlite.prepare('SELECT remote_task_id FROM external_estimate_log_states').all()).toEqual(
      [{ remote_task_id: 'ENG-1' }],
    );
    expect(
      sqlite.prepare(`SELECT name FROM sqlite_master WHERE name LIKE '__new_external_%'`).all(),
    ).toEqual([]);
  });
});

describe('0082 daily estimate checkpoint migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterEach(() => sqlite.close());

  it('adds nullable zone and pending-date columns without touching legacy rows', () => {
    const columns = sqlite
      .prepare("PRAGMA table_info('external_estimate_log_states')")
      .all() as Array<{ name: string; notnull: number }>;
    const zone = columns.find((column) => column.name === 'aggregation_time_zone');
    const pendingDate = columns.find((column) => column.name === 'pending_activity_date');
    expect(zone).toMatchObject({ notnull: 0 });
    expect(pendingDate).toMatchObject({ notnull: 0 });

    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO external_estimate_log_states
            (project_id, provider, remote_scope_key, remote_task_id, logged_minutes, revision,
             pending_operation_id, pending_delta_minutes, pending_estimate_total_minutes,
             pending_started_at, pending_connection_id, pending_connection_generation,
             pending_phase, pending_resolution, created_at, updated_at)
           VALUES ('project-1', 'jira', 'acme.atlassian.net', 'ENG-legacy', 90, 1,
                   'legacy-operation', 30, 120, '2026-08-30T10:00:00.000Z',
                   'connection-1', 2, 'prepared', NULL, 'created', 'updated')`,
        )
        .run(),
    ).not.toThrow();

    // The pending date sits outside the all-or-none pending CHECK on purpose:
    // a migrated null and a new dated value are both valid pending rows.
    expect(() =>
      sqlite
        .prepare(
          `UPDATE external_estimate_log_states SET pending_activity_date = '2026-08-30'
           WHERE pending_operation_id = 'legacy-operation'`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO external_estimate_log_states
            (project_id, provider, remote_scope_key, remote_task_id, created_at, updated_at)
           VALUES ('project-1', 'jira', 'acme.atlassian.net', 'ENG-idle', 'created', 'updated')`,
        )
        .run(),
    ).not.toThrow();
  });

  it('keys day rows by project, identity, and date with no foreign key or extra index', () => {
    const insertDay = sqlite.prepare(
      `INSERT INTO external_estimate_log_days
        (project_id, provider, remote_scope_key, remote_task_id, activity_date,
         logged_minutes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'created', 'updated')`,
    );
    insertDay.run('project-1', 'jira', 'acme.atlassian.net', 'ENG-1', '2026-08-30', 45);
    // The composite primary key rejects a second row for one project identity+date.
    expect(() =>
      insertDay.run('project-1', 'jira', 'acme.atlassian.net', 'ENG-1', '2026-08-30', 15),
    ).toThrow(/UNIQUE constraint failed/);
    insertDay.run('project-1', 'jira', 'acme.atlassian.net', 'ENG-1', '2026-08-31', 15);
    insertDay.run('project-1', 'clickup', 'acme.atlassian.net', 'ENG-1', '2026-08-30', 15);
    // Another project owns an independent row for the same remote identity+date.
    insertDay.run('project-2', 'jira', 'acme.atlassian.net', 'ENG-1', '2026-08-30', 20);

    expect(() =>
      sqlite
        .prepare(
          `UPDATE external_estimate_log_days SET logged_minutes = -1
           WHERE activity_date = '2026-08-30'`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);

    expect(sqlite.prepare("PRAGMA foreign_key_list('external_estimate_log_days')").all()).toEqual(
      [],
    );
    const indexes = sqlite
      .prepare("PRAGMA index_list('external_estimate_log_days')")
      .all() as Array<{ name: string; origin: string }>;
    // The composite primary key is the only key: identity prefix probes ride
    // it, so a separate identity index would be redundant.
    expect(indexes.filter((index) => index.origin !== 'pk')).toEqual([]);
  });
});

describe('0080 external estimate log state migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterEach(() => sqlite.close());

  it('keys durable state by project and remote identity without a replaceable link foreign key', () => {
    const indexes = sqlite
      .prepare("PRAGMA index_list('external_estimate_log_states')")
      .all() as Array<{
      name: string;
      unique: number;
    }>;

    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'external_estimate_log_states_project_remote_identity_idx',
          unique: 1,
        }),
        expect.objectContaining({
          name: 'external_estimate_log_states_pending_operation_idx',
          unique: 1,
        }),
      ]),
    );
    expect(sqlite.prepare("PRAGMA foreign_key_list('external_estimate_log_states')").all()).toEqual(
      [],
    );

    const insertState = sqlite.prepare(
      `INSERT INTO external_estimate_log_states
        (project_id, provider, remote_scope_key, remote_task_id, logged_minutes, revision,
         created_at, updated_at)
       VALUES (?, 'jira', 'acme.atlassian.net', 'ENG-1', ?, 1, 'created', 'updated')`,
    );
    insertState.run('project-1', 90);
    // One remote identity per project: a second project keeps its own checkpoint.
    expect(() => insertState.run('project-2', 0)).not.toThrow();
    expect(() => insertState.run('project-1', 0)).toThrow(/UNIQUE constraint failed/);
  });

  it('accepts only a complete pending field set and one live use of an operation ID', () => {
    const insertPending = sqlite.prepare(
      `INSERT INTO external_estimate_log_states
        (project_id, provider, remote_scope_key, remote_task_id, logged_minutes, revision,
         pending_operation_id, pending_delta_minutes, pending_estimate_total_minutes,
         pending_started_at, pending_connection_id, pending_connection_generation,
         pending_phase, pending_resolution, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 1, ?, 30, 120, '2026-08-30T10:00:00.000Z',
               'connection-1', 2, 'prepared', NULL, 'created', 'updated')`,
    );

    insertPending.run('project-1', 'jira', 'acme.atlassian.net', 'ENG-1', 'operation-1');
    expect(() =>
      sqlite
        .prepare(
          `UPDATE external_estimate_log_states
           SET pending_delta_minutes = NULL
           WHERE pending_operation_id = 'operation-1'`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      sqlite
        .prepare(
          `UPDATE external_estimate_log_states
           SET pending_phase = NULL
           WHERE pending_operation_id = 'operation-1'`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    // The pending operation ID stays globally unique across projects.
    expect(() =>
      insertPending.run('project-2', 'clickup', 'workspace-1', 'task-1', 'operation-1'),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO external_estimate_log_states
            (project_id, provider, remote_scope_key, remote_task_id, logged_minutes, revision,
             pending_operation_id, pending_delta_minutes, created_at, updated_at)
           VALUES ('project-1', 'jira', 'acme.atlassian.net', 'ENG-2', 0, 1,
                   'operation-2', 30, 'created', 'updated')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      sqlite
        .prepare(
          `UPDATE external_estimate_log_states
           SET pending_delta_minutes = 10081
           WHERE pending_operation_id = 'operation-1'`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });
});
