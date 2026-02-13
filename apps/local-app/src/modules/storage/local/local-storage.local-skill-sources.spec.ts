import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { ConflictError, NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { LocalStorageService } from './local-storage.service';

describe('LocalStorageService - LocalSkillSources integration', () => {
  let sqlite: Database.Database;
  let service: LocalStorageService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    const migrationsFolder = join(__dirname, '../../../../drizzle');
    migrate(db, { migrationsFolder });
    service = new LocalStorageService(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('creates, normalizes, lists, and reads local skill sources', async () => {
    const created = await service.createLocalSkillSource({
      name: 'My-Local-Source',
      folderPath: '/tmp/local-skills',
    });

    expect(created.name).toBe('my-local-source');
    expect(created.folderPath).toBe('/tmp/local-skills');

    const listed = await service.listLocalSkillSources();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(created.id);

    const byId = await service.getLocalSkillSource(created.id);
    expect(byId?.name).toBe('my-local-source');
  });

  it('returns null when local source is not found by id', async () => {
    await expect(service.getLocalSkillSource('missing-id')).resolves.toBeNull();
  });

  it('rejects built-in source names for local sources', async () => {
    await expect(
      service.createLocalSkillSource({
        name: 'openai',
        folderPath: '/tmp/openai-local',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects local source names that collide with community source names', async () => {
    await service.createCommunitySkillSource({
      name: 'source-one',
      repoOwner: 'owner',
      repoName: 'repo',
      branch: 'main',
    });

    await expect(
      service.createLocalSkillSource({
        name: 'source-one',
        folderPath: '/tmp/source-one',
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('enforces unique local folder paths', async () => {
    await service.createLocalSkillSource({
      name: 'local-source-a',
      folderPath: '/tmp/shared-folder',
    });

    await expect(
      service.createLocalSkillSource({
        name: 'local-source-b',
        folderPath: '/tmp/shared-folder',
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('deletes related skills and source enablement rows for a local source', async () => {
    const source = await service.createLocalSkillSource({
      name: 'local-source-a',
      folderPath: '/tmp/local-source-a',
    });
    const now = new Date().toISOString();

    sqlite
      .prepare(
        `INSERT INTO skills (id, slug, name, display_name, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'skill-local',
        'local-source-a/code-review',
        'Code Review',
        'Code Review',
        'local-source-a',
        now,
        now,
      );

    sqlite
      .prepare(
        `INSERT INTO skills (id, slug, name, display_name, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('skill-other', 'openai/other', 'Other', 'Other', 'openai', now, now);

    sqlite
      .prepare(
        `INSERT INTO projects (id, name, description, root_path, is_template, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('project-1', 'Project 1', null, '/tmp/project-1', 0, now, now);

    sqlite
      .prepare(
        `INSERT INTO source_project_enabled (id, project_id, source_name, enabled, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('spe-local', 'project-1', 'local-source-a', 0, now);

    sqlite
      .prepare(
        `INSERT INTO source_project_enabled (id, project_id, source_name, enabled, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('spe-openai', 'project-1', 'openai', 0, now);

    await service.deleteLocalSkillSource(source.id);

    const sourceCount = sqlite
      .prepare('SELECT COUNT(*) as count FROM local_skill_sources WHERE id = ?')
      .get(source.id) as { count: number };
    expect(sourceCount.count).toBe(0);

    const deletedSkillCount = sqlite
      .prepare('SELECT COUNT(*) as count FROM skills WHERE source = ?')
      .get('local-source-a') as { count: number };
    expect(deletedSkillCount.count).toBe(0);

    const remainingSkillCount = sqlite
      .prepare('SELECT COUNT(*) as count FROM skills WHERE source = ?')
      .get('openai') as { count: number };
    expect(remainingSkillCount.count).toBe(1);

    const deletedEnablementCount = sqlite
      .prepare('SELECT COUNT(*) as count FROM source_project_enabled WHERE source_name = ?')
      .get('local-source-a') as { count: number };
    expect(deletedEnablementCount.count).toBe(0);

    const remainingEnablementCount = sqlite
      .prepare('SELECT COUNT(*) as count FROM source_project_enabled WHERE source_name = ?')
      .get('openai') as { count: number };
    expect(remainingEnablementCount.count).toBe(1);
  });

  it('throws NotFoundError when deleting a missing local source', async () => {
    await expect(service.deleteLocalSkillSource('missing-local-source')).rejects.toThrow(
      NotFoundError,
    );
  });
});
