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
        'epic_time_watermarks_project_activity_idx',
      ]),
    );
    expect(
      indexes.find((row) => row.name === 'epic_time_segments_open_session_unique')?.sql,
    ).toContain('WHERE');

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
  });
});
