import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';

const MIGRATIONS_FOLDER = join(__dirname, '../../../drizzle');

// Layer: backend integration. SQLite is the cheapest reliable proof for generated
// foreign keys, partial indexes, and AUTOINCREMENT persistence.
describe('epic-time migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
  });

  afterEach(() => sqlite.close());

  it('creates all tables, cascades, uniqueness, and read indexes', () => {
    const tables = sqlite
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'epic_time_%'
         ORDER BY name`,
      )
      .all();
    expect(tables).toEqual([
      { name: 'epic_time_buffer_claims' },
      { name: 'epic_time_segments' },
      { name: 'epic_time_session_watermarks' },
      { name: 'epic_time_team_batch_event_barriers' },
      { name: 'epic_time_team_batches' },
    ]);

    const watermarkFks = sqlite
      .prepare(`PRAGMA foreign_key_list('epic_time_session_watermarks')`)
      .all() as Array<Record<string, unknown>>;
    expect(watermarkFks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'sessions', from: 'session_id', on_delete: 'CASCADE' }),
        expect.objectContaining({ table: 'projects', from: 'project_id', on_delete: 'CASCADE' }),
      ]),
    );
    const segmentFks = sqlite
      .prepare(`PRAGMA foreign_key_list('epic_time_segments')`)
      .all() as Array<Record<string, unknown>>;
    expect(segmentFks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'projects', from: 'project_id', on_delete: 'CASCADE' }),
        expect.objectContaining({ table: 'epics', from: 'epic_id', on_delete: 'CASCADE' }),
        expect.objectContaining({
          table: 'epic_time_team_batches',
          from: 'team_batch_id',
          on_delete: 'SET NULL',
        }),
      ]),
    );
    const batchFks = sqlite
      .prepare(`PRAGMA foreign_key_list('epic_time_team_batches')`)
      .all() as Array<Record<string, unknown>>;
    expect(batchFks).toEqual([
      expect.objectContaining({ table: 'projects', from: 'project_id', on_delete: 'CASCADE' }),
    ]);
    const barrierFks = sqlite
      .prepare(`PRAGMA foreign_key_list('epic_time_team_batch_event_barriers')`)
      .all() as Array<Record<string, unknown>>;
    expect(barrierFks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'epic_time_team_batches',
          from: 'team_batch_id',
          on_delete: 'CASCADE',
        }),
        expect.objectContaining({
          table: 'events',
          from: 'committed_event_id',
          on_delete: 'CASCADE',
        }),
      ]),
    );

    const indexes = sqlite
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'index' AND name LIKE 'epic_time_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>;
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'epic_time_buffer_claims_committed_event_id_unique',
        'epic_time_claims_project_agent_published_idx',
        'epic_time_segments_open_session_unique',
        'epic_time_segments_project_agent_idx',
        'epic_time_segments_project_epic_closed_idx',
        'epic_time_segments_team_batch_idx',
        'epic_time_team_barriers_event_idx',
        'epic_time_team_batches_open_unique',
        'epic_time_team_batches_project_sealed_idx',
        'epic_time_watermarks_project_activity_idx',
      ]),
    );
    expect(
      indexes.find((row) => row.name === 'epic_time_segments_open_session_unique')?.sql,
    ).toContain('WHERE');
    expect(indexes.find((row) => row.name === 'epic_time_team_batches_open_unique')?.sql).toContain(
      'WHERE',
    );

    const claimColumns = sqlite
      .prepare(`PRAGMA table_info('epic_time_buffer_claims')`)
      .all() as Array<Record<string, unknown>>;
    expect(claimColumns).toContainEqual(
      expect.objectContaining({ name: 'claim_sequence', type: 'INTEGER', pk: 1 }),
    );
    const claimTable = sqlite
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'table' AND name = 'epic_time_buffer_claims'`,
      )
      .get() as { sql: string };
    expect(claimTable.sql).toContain('AUTOINCREMENT');

    const segmentColumns = sqlite
      .prepare(`PRAGMA table_info('epic_time_segments')`)
      .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    expect(segmentColumns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'team_batch_id', notnull: 0, dflt_value: null }),
        expect.objectContaining({ name: 'attribution_source', notnull: 1, dflt_value: "'direct'" }),
        expect.objectContaining({ name: 'team_id_snapshot', notnull: 0, dflt_value: null }),
        expect.objectContaining({ name: 'team_name_snapshot', notnull: 0, dflt_value: null }),
      ]),
    );

    const barrierColumns = sqlite
      .prepare(`PRAGMA table_info('epic_time_team_batch_event_barriers')`)
      .all() as Array<{ name: string }>;
    expect(barrierColumns.map((column) => column.name)).toEqual([
      'team_batch_id',
      'committed_event_id',
      'created_at',
    ]);
  });

  it('permits sequential sealed batches while rejecting concurrent open batches', () => {
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO projects
          (id, workspace_id, name, root_path, is_template, created_at, updated_at)
         VALUES ('project', '0defa017-0000-4000-8000-000000000001', 'Project', '/tmp/project', 0, ?, ?)`,
      )
      .run(now, now);
    const insertBatch = sqlite.prepare(
      `INSERT INTO epic_time_team_batches
        (id, project_id, team_id_snapshot, team_name_snapshot,
         lead_agent_id_snapshot, lead_agent_name_snapshot, started_at, sealed_at,
         created_at, updated_at)
       VALUES (?, 'project', 'team', 'Builders', 'lead', 'Lead', ?, ?, ?, ?)`,
    );

    insertBatch.run('open-1', now, null, now, now);
    expect(() => insertBatch.run('open-2', now, null, now, now)).toThrow(
      /UNIQUE constraint failed/,
    );
    insertBatch.run('sealed-1', now, now, now, now);
    insertBatch.run('sealed-2', now, now, now, now);

    expect(
      sqlite
        .prepare(
          `SELECT id FROM epic_time_team_batches
           WHERE project_id = 'project' AND team_id_snapshot = 'team' AND sealed_at IS NOT NULL
           ORDER BY id`,
        )
        .all(),
    ).toEqual([{ id: 'sealed-1' }, { id: 'sealed-2' }]);
  });

  it('retains snapshot attribution and cascades coordinator state by immutable event ID', () => {
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO projects
          (id, workspace_id, name, root_path, is_template, created_at, updated_at)
         VALUES ('project', '0defa017-0000-4000-8000-000000000001', 'Project', '/tmp/project', 0, ?, ?)`,
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO epic_time_team_batches
          (id, project_id, team_id_snapshot, team_name_snapshot,
           lead_agent_id_snapshot, lead_agent_name_snapshot, started_at,
           created_at, updated_at)
         VALUES ('batch', 'project', 'deleted-team', 'Builders',
                 'deleted-lead', 'Lead', ?, ?, ?)`,
      )
      .run(now, now, now);
    sqlite
      .prepare(
        `INSERT INTO epic_time_segments
          (id, project_id, team_batch_id, session_id_snapshot, agent_id_snapshot,
           agent_name_snapshot, started_at, last_activity_at, duration_ms, created_at, updated_at)
         VALUES ('segment', 'project', 'batch', 'session', 'agent', 'Coder', ?, ?, 0, ?, ?)`,
      )
      .run(now, now, now, now);
    sqlite
      .prepare(
        `INSERT INTO events (id, name, payload_json, published_at)
         VALUES ('event-uuid', 'epic.updated', '{}', ?)`,
      )
      .run(now);
    sqlite
      .prepare(
        `INSERT INTO epic_time_team_batch_event_barriers
          (team_batch_id, committed_event_id, created_at)
         VALUES ('batch', 'event-uuid', ?)`,
      )
      .run(now);

    expect(
      sqlite
        .prepare(
          `SELECT attribution_source, team_id_snapshot, team_name_snapshot
           FROM epic_time_segments WHERE id = 'segment'`,
        )
        .get(),
    ).toEqual({ attribution_source: 'direct', team_id_snapshot: null, team_name_snapshot: null });
    expect(() =>
      sqlite
        .prepare(
          `UPDATE epic_time_segments SET attribution_source = 'invalid' WHERE id = 'segment'`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(
      sqlite.prepare(`SELECT committed_event_id FROM epic_time_team_batch_event_barriers`).all(),
    ).toEqual([{ committed_event_id: 'event-uuid' }]);

    sqlite.prepare(`DELETE FROM events WHERE id = 'event-uuid'`).run();
    expect(sqlite.prepare(`SELECT * FROM epic_time_team_batch_event_barriers`).all()).toEqual([]);

    sqlite.prepare(`DELETE FROM epic_time_team_batches WHERE id = 'batch'`).run();
    expect(
      sqlite.prepare(`SELECT team_batch_id FROM epic_time_segments WHERE id = 'segment'`).get(),
    ).toEqual({ team_batch_id: null });

    sqlite
      .prepare(
        `INSERT INTO epic_time_team_batches
          (id, project_id, team_id_snapshot, team_name_snapshot,
           lead_agent_id_snapshot, lead_agent_name_snapshot, started_at,
           created_at, updated_at)
         VALUES ('project-cascade-batch', 'project', 'team', 'Builders',
                 'lead', 'Lead', ?, ?, ?)`,
      )
      .run(now, now, now);
    sqlite
      .prepare(
        `INSERT INTO events (id, name, payload_json, published_at)
         VALUES ('project-cascade-event', 'epic.updated', '{}', ?)`,
      )
      .run(now);
    sqlite
      .prepare(
        `INSERT INTO epic_time_team_batch_event_barriers
          (team_batch_id, committed_event_id, created_at)
         VALUES ('project-cascade-batch', 'project-cascade-event', ?)`,
      )
      .run(now);

    sqlite.prepare(`DELETE FROM projects WHERE id = 'project'`).run();
    expect(sqlite.prepare(`SELECT * FROM epic_time_segments`).all()).toEqual([]);
    expect(sqlite.prepare(`SELECT * FROM epic_time_team_batches`).all()).toEqual([]);
    expect(sqlite.prepare(`SELECT * FROM epic_time_team_batch_event_barriers`).all()).toEqual([]);
    expect(sqlite.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
  });
});
