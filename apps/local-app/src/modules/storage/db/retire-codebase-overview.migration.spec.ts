/**
 * Migration tests for 0084_retire_codebase_overview.
 *
 * Layer: backend-unit (real SQLite, disposable :memory: databases).
 * Justification: the contract is pure storage behavior — one exact-key DELETE
 * applied through the Drizzle journal — which real SQLite proves more cheaply
 * and reliably than a booted app.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { copyFileSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');
const MIGRATION_TAG = '0084_retire_codebase_overview';
const LEGACY_KEY = 'codebaseScope.projects';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

function readJournal(): { entries: JournalEntry[] } {
  return JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
}

/** Builds a disposable migration chain bounded before or through 0084. */
async function createRetirementFolder(boundary: 'before' | 'through'): Promise<string> {
  const journal = readJournal();
  const retirementIndex = journal.entries.findIndex((entry) => entry.tag === MIGRATION_TAG);
  if (retirementIndex === -1) {
    throw new Error(`journal is missing ${MIGRATION_TAG}`);
  }
  const entries = journal.entries.slice(0, retirementIndex + (boundary === 'through' ? 1 : 0));

  const folder = await mkdtemp(join(tmpdir(), `devchain-${boundary}-0084-`));
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const truncated = {
    ...journal,
    entries,
  };
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(truncated));
  return folder;
}

function schemaFingerprint(sqlite: Database.Database): unknown {
  return sqlite
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
}

function seedRetirementState(sqlite: Database.Database): void {
  const now = '2026-09-07T00:00:00.000Z';
  sqlite
    .prepare(
      `INSERT INTO projects (id, name, description, root_path, is_private, created_at, updated_at)
       VALUES ('project-1', 'Keeper', NULL, '/tmp/keeper', 0, ?, ?)`,
    )
    .run(now, now);

  const insertSetting = sqlite.prepare(
    'INSERT INTO settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  insertSetting.run(
    'setting-legacy',
    LEGACY_KEY,
    JSON.stringify({ 'project-1': [{ folder: 'src', purpose: 'included', origin: 'user' }] }),
    now,
    now,
  );
  insertSetting.run('setting-nearby', `${LEGACY_KEY}.backup`, '{"kept":true}', now, now);
  insertSetting.run('setting-unrelated', 'autoClean.statusIds', '["status-1"]', now, now);
}

describe('0084 retire codebase overview migration', () => {
  it('deletes only the legacy scope key on upgrade while preserving settings, project data, and schema', async () => {
    const preFolder = await createRetirementFolder('before');
    const retirementFolder = await createRetirementFolder('through');
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    try {
      migrate(drizzle(sqlite), { migrationsFolder: preFolder });
      seedRetirementState(sqlite);
      const schemaBefore = schemaFingerprint(sqlite);

      migrate(drizzle(sqlite), { migrationsFolder: retirementFolder });

      const remainingKeys = (
        sqlite.prepare('SELECT key, value FROM settings ORDER BY key').all() as Array<{
          key: string;
          value: string;
        }>
      ).map(({ key, value }) => [key, value]);
      expect(remainingKeys).toEqual([
        ['autoClean.statusIds', '["status-1"]'],
        ['codebaseScope.projects.backup', '{"kept":true}'],
      ]);

      expect(sqlite.prepare('SELECT id FROM projects').get()).toMatchObject({ id: 'project-1' });
      expect(schemaFingerprint(sqlite)).toEqual(schemaBefore);
      expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      const applied = sqlite
        .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')
        .get() as { created_at: number };
      const retirementEntry = readJournal().entries.find((entry) => entry.tag === MIGRATION_TAG);
      expect(Number(applied.created_at)).toBe(retirementEntry?.when);
    } finally {
      sqlite.close();
      await rm(preFolder, { recursive: true, force: true });
      await rm(retirementFolder, { recursive: true, force: true });
    }
  });

  it('creates a fresh database through the full migration chain without the legacy key or schema changes', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    try {
      migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });

      expect(
        sqlite.prepare('SELECT count(*) AS n FROM settings WHERE key = ?').get(LEGACY_KEY),
      ).toEqual({ n: 0 });
      expect(
        sqlite
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
          )
          .get(),
      ).toEqual({ n: 1 });
      expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      const appliedCount = sqlite
        .prepare('SELECT count(*) AS n FROM __drizzle_migrations')
        .get() as {
        n: number;
      };
      expect(appliedCount.n).toBe(readJournal().entries.length);

      const migrationSql = readFileSync(join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`), 'utf8');
      expect(migrationSql.replace(/--> statement-breakpoint/g, '').trim()).toBe(
        `DELETE FROM settings WHERE key = '${LEGACY_KEY}';`,
      );
    } finally {
      sqlite.close();
    }
  });

  it('keeps the journal and snapshot chain valid for the retirement entry', () => {
    const journal = readJournal();
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
    const retirementIdx = entries.findIndex((entry) => entry.tag === MIGRATION_TAG);
    expect(retirementIdx).toBe(84);
    const earlierMaxWhen = Math.max(...entries.slice(0, retirementIdx).map((entry) => entry.when));
    expect(entries[retirementIdx].when).toBeGreaterThan(earlierMaxWhen);

    const readSnapshot = (name: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', name), 'utf8'));
    const previous = readSnapshot('0083_snapshot.json');
    const current = readSnapshot('0084_snapshot.json');

    expect(current.prevId).toBe(previous.id);
    expect(current.id).not.toBe(current.prevId);
    const { id: _currId, prevId: _currPrevId, ...currentSchema } = current;
    const { id: _prevId, prevId: _prevPrevId, ...previousSchema } = previous;
    expect(currentSchema).toEqual(previousSchema);
  });
});
