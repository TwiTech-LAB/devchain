import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';

describe('0067 remove Claude 1M provider state migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE providers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL UNIQUE,
        auto_compact_threshold INTEGER,
        auto_compact_threshold_1m INTEGER,
        one_million_context_enabled INTEGER NOT NULL DEFAULT 0,
        env TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE provider_probe_proofs (
        provider_id TEXT PRIMARY KEY NOT NULL,
        bin_path TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
      );
    `);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('preserves a null ordinary threshold while dropping all retired state', () => {
    sqlite
      .prepare(
        `INSERT INTO providers
         (id, name, auto_compact_threshold, auto_compact_threshold_1m,
          one_million_context_enabled, env, created_at, updated_at)
         VALUES ('claude-id', 'claude', NULL, 50, 1, NULL, ?, ?)`,
      )
      .run('2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z');
    sqlite
      .prepare(
        `INSERT INTO provider_probe_proofs
         (provider_id, bin_path, recorded_at)
         VALUES ('claude-id', '/usr/bin/claude', 1)`,
      )
      .run();

    const migrationSql = readFileSync(
      join(__dirname, '../../../../drizzle/0067_remove_claude_1m_provider_state.sql'),
      'utf8',
    ).replace(/--> statement-breakpoint/g, '');
    sqlite.exec(migrationSql);

    const columns = sqlite.prepare("PRAGMA table_info('providers')").all() as Array<{
      name: string;
    }>;
    expect(columns.map(({ name }) => name)).toContain('auto_compact_threshold');
    expect(columns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(['auto_compact_threshold_1m', 'one_million_context_enabled']),
    );
    expect(
      sqlite.prepare('SELECT auto_compact_threshold FROM providers WHERE id = ?').get('claude-id'),
    ).toEqual({ auto_compact_threshold: null });
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_probe_proofs'",
        )
        .get(),
    ).toBeUndefined();
  });
});
