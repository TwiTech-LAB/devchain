import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('0068 Claude launch settings migration', () => {
  it('adds one nullable TEXT column without changing existing provider data', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        auto_compact_threshold INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO providers
        (id, name, auto_compact_threshold, created_at, updated_at)
      VALUES
        ('claude-1', 'claude', 85, '2026-07-27', '2026-07-27');
    `);

    const migration = readFileSync(
      join(__dirname, '../../../../drizzle/0068_claude_launch_settings_json.sql'),
      'utf8',
    );
    sqlite.exec(migration.replace(/--> statement-breakpoint/g, ''));

    const columns = sqlite.prepare("PRAGMA table_info('providers')").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'claude_launch_settings_json',
          type: 'TEXT',
          notnull: 0,
        }),
      ]),
    );
    expect(
      sqlite
        .prepare(
          'SELECT auto_compact_threshold, claude_launch_settings_json FROM providers WHERE id = ?',
        )
        .get('claude-1'),
    ).toEqual({
      auto_compact_threshold: 85,
      claude_launch_settings_json: null,
    });

    sqlite.close();
  });
});
