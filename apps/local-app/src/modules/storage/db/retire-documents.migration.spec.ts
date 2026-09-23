import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { LocalStorageService } from '../local/local-storage.service';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');

function tableNames(sqlite: Database.Database): string[] {
  return (
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map(({ name }) => name);
}

describe('0083 retire documents migration', () => {
  it('drops document_tags before documents while preserving unrelated data and foreign keys', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        root_path TEXT NOT NULL,
        is_private INTEGER DEFAULT 0 NOT NULL,
        owner_user_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE tags (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade
      );

      CREATE TABLE prompts (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        version INTEGER DEFAULT 1 NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade
      );

      CREATE TABLE agent_profiles (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT,
        name TEXT NOT NULL,
        family_slug TEXT,
        system_prompt TEXT,
        instructions TEXT,
        temperature INTEGER,
        max_tokens INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade
      );

      CREATE TABLE documents (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        content_md TEXT NOT NULL,
        version INTEGER DEFAULT 1 NOT NULL,
        archived INTEGER DEFAULT false NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade
      );

      CREATE TABLE document_tags (
        document_id TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON UPDATE no action ON DELETE cascade,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON UPDATE no action ON DELETE cascade
      );

      CREATE UNIQUE INDEX documents_project_slug_unique ON documents (project_id, slug);
    `);

    const now = '2026-09-05T00:00:00.000Z';
    sqlite
      .prepare(
        `INSERT INTO projects (id, name, description, root_path, is_private, owner_user_id, created_at, updated_at)
         VALUES ('project-1', 'Keeper', NULL, '/tmp/keeper', 0, NULL, ?, ?)`,
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO tags (id, project_id, name, created_at, updated_at)
         VALUES ('tag-1', 'project-1', 'shared', ?, ?)`,
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO prompts (id, project_id, title, content, version, created_at, updated_at)
         VALUES ('prompt-1', 'project-1', 'Keeper prompt', 'content', 1, ?, ?)`,
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, project_id, name, family_slug, system_prompt, instructions, temperature, max_tokens, created_at, updated_at)
         VALUES ('profile-1', 'project-1', 'Keeper profile', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO documents (id, project_id, title, slug, content_md, version, archived, created_at, updated_at)
         VALUES ('doc-1', 'project-1', 'Retired', 'retired', '# Retired', 1, 0, ?, ?)`,
      )
      .run(now, now);
    sqlite
      .prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)')
      .run('doc-1', 'tag-1');

    const migrationSql = readFileSync(join(MIGRATIONS_FOLDER, '0083_retire_documents.sql'), 'utf8')
      .replace(/--> statement-breakpoint/g, '')
      .trim();
    expect(migrationSql.indexOf('DROP TABLE `document_tags`')).toBeLessThan(
      migrationSql.indexOf('DROP TABLE `documents`'),
    );
    sqlite.exec(migrationSql);

    const tables = tableNames(sqlite);
    expect(tables).not.toContain('documents');
    expect(tables).not.toContain('document_tags');
    expect(tables).toContain('projects');
    expect(tables).toContain('tags');
    expect(tables).toContain('prompts');
    expect(tables).toContain('agent_profiles');

    expect(sqlite.prepare('SELECT id FROM projects').get()).toMatchObject({ id: 'project-1' });
    expect(sqlite.prepare('SELECT id FROM tags').get()).toMatchObject({ id: 'tag-1' });
    expect(sqlite.prepare('SELECT id FROM prompts').get()).toMatchObject({ id: 'prompt-1' });
    expect(sqlite.prepare('SELECT id FROM agent_profiles').get()).toMatchObject({
      id: 'profile-1',
    });
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    sqlite.close();
  });

  it('creates a fresh database through the full migration chain without documents tables', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });

    const tables = tableNames(sqlite);
    expect(tables).not.toContain('documents');
    expect(tables).not.toContain('document_tags');
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    sqlite.close();
  });

  it('deletes a project with related rows after the documents tables are gone', async () => {
    const sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    const service = new LocalStorageService(drizzle(sqlite));

    const project = await service.createProject({
      name: 'Post-retirement deletion',
      description: null,
      rootPath: '/tmp/post-retirement',
    });
    await service.createPrompt({
      projectId: project.id,
      title: 'Prompt',
      content: 'content',
      tags: ['kept'],
    });
    await service.createAgentProfile({ projectId: project.id, name: 'Profile' });

    await service.deleteProject(project.id);

    await expect(service.getProject(project.id)).rejects.toThrow();
    expect((await service.listPrompts({ projectId: project.id })).items).toHaveLength(0);
    expect((await service.listTags(project.id)).items).toHaveLength(0);

    sqlite.close();
  });
});
