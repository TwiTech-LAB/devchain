import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { ConflictError, ValidationError } from '../../../common/errors/error-types';
import { LocalStorageService } from './local-storage.service';

describe('LocalStorageService - CommunitySkillSources integration', () => {
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

  it('creates, normalizes, lists, and reads community skill sources', async () => {
    const created = await service.createCommunitySkillSource({
      name: 'Jeff-Allan',
      repoOwner: 'JeffAllan',
      repoName: 'Claude-Skills',
      branch: 'main',
    });

    expect(created.name).toBe('jeff-allan');
    expect(created.repoOwner).toBe('jeffallan');
    expect(created.repoName).toBe('claude-skills');
    expect(created.branch).toBe('main');

    const listed = await service.listCommunitySkillSources();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(created.id);

    const byId = await service.getCommunitySkillSource(created.id);
    expect(byId.name).toBe('jeff-allan');

    const byName = await service.getCommunitySkillSourceByName('JEFF-ALLAN');
    expect(byName?.id).toBe(created.id);
  });

  it('returns null when community source is not found by name', async () => {
    await expect(service.getCommunitySkillSourceByName('missing-source')).resolves.toBeNull();
  });

  it('rejects invalid community source name format', async () => {
    await expect(
      service.createCommunitySkillSource({
        name: 'bad_name',
        repoOwner: 'someone',
        repoName: 'repo',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects community source names that conflict with built-in names', async () => {
    await expect(
      service.createCommunitySkillSource({
        name: 'openai',
        repoOwner: 'someone',
        repoName: 'repo',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('enforces unique repo pair regardless of input casing', async () => {
    await service.createCommunitySkillSource({
      name: 'jeffallan',
      repoOwner: 'JeffAllan',
      repoName: 'Claude-Skills',
    });

    await expect(
      service.createCommunitySkillSource({
        name: 'another-source',
        repoOwner: 'jeffallan',
        repoName: 'claude-skills',
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('deletes related skills when deleting a community skill source', async () => {
    const source = await service.createCommunitySkillSource({
      name: 'jeffallan',
      repoOwner: 'JeffAllan',
      repoName: 'Claude-Skills',
    });
    const now = new Date().toISOString();

    sqlite
      .prepare(
        `INSERT INTO skills (id, slug, name, display_name, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('skill-1', 'jeffallan/code-review', 'Code Review', 'Code Review', 'jeffallan', now, now);

    sqlite
      .prepare(
        `INSERT INTO skills (id, slug, name, display_name, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('skill-2', 'openai/other', 'Other', 'Other', 'openai', now, now);

    await service.deleteCommunitySkillSource(source.id);

    const sourceCount = sqlite
      .prepare('SELECT COUNT(*) as count FROM community_skill_sources WHERE id = ?')
      .get(source.id) as { count: number };
    expect(sourceCount.count).toBe(0);

    const deletedSkillCount = sqlite
      .prepare('SELECT COUNT(*) as count FROM skills WHERE source = ?')
      .get('jeffallan') as { count: number };
    expect(deletedSkillCount.count).toBe(0);

    const remainingSkillCount = sqlite
      .prepare('SELECT COUNT(*) as count FROM skills WHERE source = ?')
      .get('openai') as { count: number };
    expect(remainingSkillCount.count).toBe(1);
  });
});
