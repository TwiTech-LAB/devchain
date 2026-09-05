import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');

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
            (provider, remote_scope_key, remote_task_id, logged_minutes, revision,
             pending_operation_id, pending_delta_minutes, pending_estimate_total_minutes,
             pending_started_at, pending_connection_id, pending_connection_generation,
             pending_phase, pending_resolution, created_at, updated_at)
           VALUES ('jira', 'acme.atlassian.net', 'ENG-legacy', 90, 1,
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
            (provider, remote_scope_key, remote_task_id, created_at, updated_at)
           VALUES ('jira', 'acme.atlassian.net', 'ENG-idle', 'created', 'updated')`,
        )
        .run(),
    ).not.toThrow();
  });

  it('keys day rows by identity and date with no foreign key or extra index', () => {
    const insertDay = sqlite.prepare(
      `INSERT INTO external_estimate_log_days
        (provider, remote_scope_key, remote_task_id, activity_date,
         logged_minutes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'created', 'updated')`,
    );
    insertDay.run('jira', 'acme.atlassian.net', 'ENG-1', '2026-08-30', 45);
    // The composite primary key rejects a second row for one identity+date.
    expect(() => insertDay.run('jira', 'acme.atlassian.net', 'ENG-1', '2026-08-30', 15)).toThrow(
      /UNIQUE constraint failed/,
    );
    insertDay.run('jira', 'acme.atlassian.net', 'ENG-1', '2026-08-31', 15);
    insertDay.run('clickup', 'acme.atlassian.net', 'ENG-1', '2026-08-30', 15);

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

  it('keys durable state by remote identity without a replaceable link foreign key', () => {
    const indexes = sqlite
      .prepare("PRAGMA index_list('external_estimate_log_states')")
      .all() as Array<{
      name: string;
      unique: number;
    }>;

    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'external_estimate_log_states_remote_identity_idx',
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

    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO external_estimate_log_states
            (provider, remote_scope_key, remote_task_id, logged_minutes, revision,
             created_at, updated_at)
           VALUES ('jira', 'acme.atlassian.net', 'ENG-1', 90, 1, 'created', 'updated')`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO external_estimate_log_states
            (provider, remote_scope_key, remote_task_id, logged_minutes, revision,
             created_at, updated_at)
           VALUES ('jira', 'acme.atlassian.net', 'ENG-1', 0, 1, 'created', 'updated')`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('accepts only a complete pending field set and one live use of an operation ID', () => {
    const insertPending = sqlite.prepare(
      `INSERT INTO external_estimate_log_states
        (provider, remote_scope_key, remote_task_id, logged_minutes, revision,
         pending_operation_id, pending_delta_minutes, pending_estimate_total_minutes,
         pending_started_at, pending_connection_id, pending_connection_generation,
         pending_phase, pending_resolution, created_at, updated_at)
       VALUES (?, ?, ?, 0, 1, ?, 30, 120, '2026-08-30T10:00:00.000Z',
               'connection-1', 2, 'prepared', NULL, 'created', 'updated')`,
    );

    insertPending.run('jira', 'acme.atlassian.net', 'ENG-1', 'operation-1');
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
    expect(() => insertPending.run('clickup', 'workspace-1', 'task-1', 'operation-1')).toThrow(
      /UNIQUE constraint failed/,
    );
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO external_estimate_log_states
            (provider, remote_scope_key, remote_task_id, logged_minutes, revision,
             pending_operation_id, pending_delta_minutes, created_at, updated_at)
           VALUES ('jira', 'acme.atlassian.net', 'ENG-2', 0, 1,
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
