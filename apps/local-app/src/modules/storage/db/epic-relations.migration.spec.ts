import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_PATH = join(__dirname, '../../../../drizzle/0079_premium_forgotten_one.sql');
const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');

describe('0079 Epic relations migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterEach(() => sqlite.close());

  it('creates the canonical pair table with only the approved indexes', () => {
    const migration = readFileSync(MIGRATION_PATH, 'utf8');
    const relationIndexes = sqlite.prepare("PRAGMA index_list('epic_relations')").all() as Array<{
      name: string;
      unique: number;
    }>;

    expect(relationIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'epic_relations_pair_idx', unique: 1 }),
        expect.objectContaining({ name: 'epic_relations_right_epic_id_idx', unique: 0 }),
      ]),
    );
    expect(relationIndexes.map((index) => index.name)).not.toContain(
      'epic_relations_left_epic_id_idx',
    );
    expect(
      (sqlite.prepare("PRAGMA index_list('epics')").all() as Array<{ name: string }>).map(
        (index) => index.name,
      ),
    ).toContain('epics_project_id_idx');
    expect(migration).not.toMatch(/\bCHECK\s*\(/i);
  });

  it('enforces one row per pair and cascades either Epic deletion', () => {
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO projects
          (id, workspace_id, name, root_path, is_template, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      )
      .run('project', '0defa017-0000-4000-8000-000000000001', 'Project', '/tmp/project', now, now);
    sqlite
      .prepare(
        `INSERT INTO statuses (id, project_id, label, color, position, mcp_hidden, created_at, updated_at)
         VALUES ('status', 'project', 'New', '#000000', 0, 0, ?, ?)`,
      )
      .run(now, now);
    const insertEpic = sqlite.prepare(
      `INSERT INTO epics
        (id, project_id, title, status_id, version, created_at, updated_at)
       VALUES (?, 'project', ?, 'status', 1, ?, ?)`,
    );
    insertEpic.run('aaaaaaaa-0000-4000-8000-000000000001', 'Left', now, now);
    insertEpic.run('bbbbbbbb-0000-4000-8000-000000000002', 'Right', now, now);
    const insertRelation = sqlite.prepare(
      `INSERT INTO epic_relations
        (id, left_epic_id, right_epic_id, type, direction, created_at, updated_at)
       VALUES (?, ?, ?, 'related', 'none', ?, ?)`,
    );
    insertRelation.run(
      'relation-1',
      'aaaaaaaa-0000-4000-8000-000000000001',
      'bbbbbbbb-0000-4000-8000-000000000002',
      now,
      now,
    );
    expect(() =>
      insertRelation.run(
        'relation-2',
        'aaaaaaaa-0000-4000-8000-000000000001',
        'bbbbbbbb-0000-4000-8000-000000000002',
        now,
        now,
      ),
    ).toThrow(/UNIQUE constraint failed/);

    sqlite.prepare('DELETE FROM epics WHERE id = ?').run('bbbbbbbb-0000-4000-8000-000000000002');
    expect(sqlite.prepare('SELECT * FROM epic_relations').all()).toEqual([]);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
