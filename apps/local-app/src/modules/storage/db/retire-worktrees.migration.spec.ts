/**
 * Migration tests for 0086_retire_worktrees.
 *
 * Layer: backend-unit (real SQLite, disposable :memory: databases).
 * The retirement drops three leaf history tables. merged_agents and merged_epics
 * both carry a foreign key to worktrees, so they must be dropped before it; the
 * generated SQL encodes that order and these tests pin it. The contract is pure
 * storage behavior, proven more cheaply and reliably against real SQLite than a
 * booted app.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { copyFileSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { LocalStorageService } from '../local/local-storage.service';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');
const MIGRATION_TAG = '0086_retire_worktrees';
const RETIRED_TABLES = ['worktrees', 'merged_epics', 'merged_agents'];

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

function tableNames(sqlite: Database.Database): string[] {
  return (
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map(({ name }) => name);
}

/** Builds a disposable migration chain bounded before or through the retirement. */
async function createRetirementFolder(boundary: 'before' | 'through'): Promise<string> {
  const journal = readJournal();
  const retirementIndex = journal.entries.findIndex((entry) => entry.tag === MIGRATION_TAG);
  if (retirementIndex === -1) {
    throw new Error(`journal is missing ${MIGRATION_TAG}`);
  }
  const entries = journal.entries.slice(0, retirementIndex + (boundary === 'through' ? 1 : 0));

  const folder = await mkdtemp(join(tmpdir(), `devchain-${boundary}-0086-`));
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  mkdirSync(join(folder, 'meta'), { recursive: true });
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  return folder;
}

/** Schema of every table except the retired ones, plus their indexes. */
function keptSchemaFingerprint(sqlite: Database.Database): unknown {
  return (
    sqlite
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>
  ).filter((row) => !RETIRED_TABLES.includes(row.tbl_name));
}

function seedRetirementState(sqlite: Database.Database): void {
  const now = '2026-09-21T00:00:00.000Z';
  sqlite
    .prepare(
      `INSERT INTO projects (id, name, description, root_path, is_private, owner_user_id, created_at, updated_at)
       VALUES ('project-1', 'Keeper', NULL, '/tmp/keeper', 0, NULL, ?, ?)`,
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO statuses (id, project_id, label, color, position, mcp_hidden, created_at, updated_at)
       VALUES ('status-1', 'project-1', 'New', '#6c757d', 0, 0, ?, ?)`,
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO epics (id, project_id, title, description, status_id, parent_id, agent_id, created_by, version, data, skills_required, created_at, updated_at)
       VALUES ('epic-1', 'project-1', 'Kept epic', NULL, 'status-1', NULL, NULL, NULL, 1, NULL, NULL, ?, ?)`,
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO settings (id, key, value, created_at, updated_at)
       VALUES ('setting-1', 'autoClean.statusIds', '["status-1"]', ?, ?)`,
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO tags (id, project_id, name, created_at, updated_at)
       VALUES ('tag-1', 'project-1', 'shared', ?, ?)`,
    )
    .run(now, now);

  // Retired feature data: a worktree with one merged epic and one merged agent.
  sqlite
    .prepare(
      `INSERT INTO worktrees (id, name, branch_name, base_branch, repo_path, template_slug, owner_project_id, status, runtime_type, created_at, updated_at)
       VALUES ('wt-1', 'feature', 'feature', 'main', '/tmp/repo', 'tmpl', 'project-1', 'running', 'container', ?, ?)`,
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO merged_epics (id, worktree_id, devchain_epic_id, title, merged_at)
       VALUES ('me-1', 'wt-1', 'epic-1', 'Merged epic', ?)`,
    )
    .run(now);
  sqlite
    .prepare(
      `INSERT INTO merged_agents (id, worktree_id, devchain_agent_id, merged_at)
       VALUES ('ma-1', 'wt-1', 'agent-1', ?)`,
    )
    .run(now);
}

describe('0086 retire worktrees migration', () => {
  it('drops merged_agents and merged_epics before worktrees while preserving unrelated data and foreign keys', async () => {
    const beforeFolder = await createRetirementFolder('before');
    const throughFolder = await createRetirementFolder('through');
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    try {
      migrate(drizzle(sqlite), { migrationsFolder: beforeFolder });
      seedRetirementState(sqlite);
      const keptBefore = keptSchemaFingerprint(sqlite);

      const migrationSql = readFileSync(join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`), 'utf8');
      const worktreesDrop = migrationSql.indexOf('DROP TABLE `worktrees`');
      expect(migrationSql.indexOf('DROP TABLE `merged_agents`')).toBeLessThan(worktreesDrop);
      expect(migrationSql.indexOf('DROP TABLE `merged_epics`')).toBeLessThan(worktreesDrop);

      migrate(drizzle(sqlite), { migrationsFolder: throughFolder });

      const tables = tableNames(sqlite);
      for (const table of RETIRED_TABLES) {
        expect(tables).not.toContain(table);
      }

      // Representative retained rows survive untouched.
      expect(sqlite.prepare('SELECT id FROM projects').get()).toMatchObject({ id: 'project-1' });
      expect(sqlite.prepare('SELECT id, title FROM epics').get()).toMatchObject({
        id: 'epic-1',
        title: 'Kept epic',
      });
      expect(sqlite.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 1 });
      expect(sqlite.prepare('SELECT count(*) AS n FROM tags').get()).toEqual({ n: 1 });

      // Nothing but the retired tables changed shape.
      expect(keptSchemaFingerprint(sqlite)).toEqual(keptBefore);
      expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      sqlite.close();
      await rm(beforeFolder, { recursive: true, force: true });
      await rm(throughFolder, { recursive: true, force: true });
    }
  });

  it('creates a fresh database through the full migration chain without the retired tables', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    try {
      migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });

      const tables = tableNames(sqlite);
      for (const table of RETIRED_TABLES) {
        expect(tables).not.toContain(table);
      }
      expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      const appliedCount = sqlite
        .prepare('SELECT count(*) AS n FROM __drizzle_migrations')
        .get() as {
        n: number;
      };
      expect(appliedCount.n).toBe(readJournal().entries.length);

      const migrationSql = readFileSync(join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`), 'utf8');
      expect(migrationSql.replace(/--> statement-breakpoint/g, '').trim()).toBe(
        'DROP TABLE `merged_agents`;\nDROP TABLE `merged_epics`;\nDROP TABLE `worktrees`;',
      );
    } finally {
      sqlite.close();
    }
  });

  it('keeps the journal and snapshot chain valid for the retirement entry', () => {
    const journal = readJournal();
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
    const retirementIdx = entries.findIndex((entry) => entry.tag === MIGRATION_TAG);
    // Chain integrity, not "nothing was ever added after it": later migrations (e.g. 0087
    // remotes/remote_project_bindings) legitimately follow the retirement entry.
    expect(entries[retirementIdx].idx).toBe(86);
    const earlierMaxWhen = Math.max(...entries.slice(0, retirementIdx).map((entry) => entry.when));
    expect(entries[retirementIdx].when).toBeGreaterThan(earlierMaxWhen);

    const readSnapshot = (name: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', name), 'utf8'));
    const previous = readSnapshot('0085_snapshot.json');
    const current = readSnapshot('0086_snapshot.json');

    expect(current.prevId).toBe(previous.id);
    expect(current.id).not.toBe(current.prevId);
    for (const table of RETIRED_TABLES) {
      expect(previous.tables[table]).toBeDefined();
      expect(current.tables[table]).toBeUndefined();
    }
  });

  it('supports normal project creation and deletion after the retired tables are gone', async () => {
    const sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    const service = new LocalStorageService(drizzle(sqlite));

    const project = await service.createProject({
      name: 'Post-retirement',
      description: null,
      rootPath: '/tmp/post-retirement',
      isTemplate: false,
    });
    await service.createPrompt({
      projectId: project.id,
      title: 'Prompt',
      content: 'content',
      tags: ['kept'],
    });

    await service.deleteProject(project.id);

    await expect(service.getProject(project.id)).rejects.toThrow();
    expect((await service.listPrompts({ projectId: project.id })).items).toHaveLength(0);

    sqlite.close();
  });
});
