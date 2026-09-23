import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import type { SettingsService } from '../../settings/services/settings.service';
import type { SkillSourceRegistryService } from './skill-source-registry.service';
import { SkillsService } from './skills.service';

const now = '2026-01-01T00:00:00.000Z';

describe('SkillsService setSkillsEnabled', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let settingsService: { getSkillSourcesEnabled: jest.Mock };
  let service: SkillsService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    const migrationsFolder = join(__dirname, '../../../../drizzle');
    migrate(db, { migrationsFolder });

    settingsService = {
      getSkillSourcesEnabled: jest.fn().mockReturnValue({}),
    };
    service = new SkillsService(
      db,
      settingsService as unknown as SettingsService,
      {
        listRegisteredSources: jest.fn().mockResolvedValue([
          { name: 'src', repoUrl: 'https://example.test/src', kind: 'builtin' },
          { name: 'other-src', repoUrl: 'https://example.test/other', kind: 'builtin' },
        ]),
        getBuiltInSourceNames: jest.fn().mockReturnValue(['src', 'other-src']),
      } as unknown as SkillSourceRegistryService,
    );
  });

  afterEach(() => {
    sqlite.close();
  });

  const insertProject = (id: string): void => {
    sqlite
      .prepare(
        `INSERT INTO projects (id, name, description, root_path, is_template, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, `Project ${id}`, null, `/tmp/${id}`, 0, now, now);
  };

  const insertSkill = (id: string, slug: string, source = 'src'): void => {
    sqlite
      .prepare(
        `INSERT INTO skills (id, slug, name, display_name, description, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        slug,
        slug.split('/')[1] ?? slug,
        slug.split('/')[1] ?? slug,
        null,
        source,
        now,
        now,
      );
  };

  const disabledRows = (projectId: string): { skill_id: string }[] =>
    sqlite
      .prepare(`SELECT skill_id FROM skill_project_disabled WHERE project_id = ?`)
      .all(projectId) as { skill_id: string }[];

  const disableSkillInDb = (projectId: string, skillId: string): void => {
    sqlite
      .prepare(
        `INSERT INTO skill_project_disabled (id, project_id, skill_id, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(`${projectId}-${skillId}`, projectId, skillId, now);
  };

  it('disables the listed skills for the session project only', async () => {
    insertProject('proj-a');
    insertProject('proj-b');
    insertSkill('skill-a', 'src/alpha');
    insertSkill('skill-b', 'src/beta');

    const result = await service.setSkillsEnabled('proj-a', ['src/alpha', 'src/beta'], false);

    expect(result).toEqual({ updated: ['src/alpha', 'src/beta'], unchanged: [], notFound: [] });
    expect(
      disabledRows('proj-a')
        .map((row) => row.skill_id)
        .sort(),
    ).toEqual(['skill-a', 'skill-b']);
    expect(disabledRows('proj-b')).toEqual([]);
  });

  it('enables previously disabled skills again', async () => {
    insertProject('proj-c');
    insertSkill('skill-a', 'src/alpha');
    disableSkillInDb('proj-c', 'skill-a');

    const result = await service.setSkillsEnabled('proj-c', ['src/alpha'], true);

    expect(result).toEqual({ updated: ['src/alpha'], unchanged: [], notFound: [] });
    expect(disabledRows('proj-c')).toEqual([]);
  });

  it('partitions slugs into updated, unchanged, and notFound', async () => {
    insertProject('proj-d');
    insertSkill('skill-a', 'src/alpha');
    insertSkill('skill-b', 'src/beta');
    insertSkill('skill-c', 'src/gamma');
    disableSkillInDb('proj-d', 'skill-b');
    disableSkillInDb('proj-d', 'skill-c');

    const result = await service.setSkillsEnabled(
      'proj-d',
      ['src/alpha', 'src/beta', 'src/gamma', 'src/missing'],
      false,
    );

    expect(result).toEqual({
      updated: ['src/alpha'],
      unchanged: ['src/beta', 'src/gamma'],
      notFound: ['src/missing'],
    });
    expect(
      disabledRows('proj-d')
        .map((row) => row.skill_id)
        .sort(),
    ).toEqual(['skill-a', 'skill-b', 'skill-c']);
  });

  it('returns repeated slugs in unchanged on a second identical call', async () => {
    insertProject('proj-e');
    insertSkill('skill-a', 'src/alpha');

    await service.setSkillsEnabled('proj-e', ['src/alpha'], false);
    const result = await service.setSkillsEnabled('proj-e', ['src/alpha'], false);

    expect(result).toEqual({ updated: [], unchanged: ['src/alpha'], notFound: [] });
  });

  it('resolves duplicate and mixed-case slugs once', async () => {
    insertProject('proj-f');
    insertSkill('skill-a', 'src/alpha');

    const result = await service.setSkillsEnabled(
      'proj-f',
      ['SRC/ALPHA', ' src/alpha ', 'src/Alpha'],
      false,
    );

    expect(result).toEqual({ updated: ['src/alpha'], unchanged: [], notFound: [] });
    expect(disabledRows('proj-f')).toHaveLength(1);
  });

  it('reports slugs from globally disabled sources as notFound instead of toggling them', async () => {
    insertProject('proj-g');
    insertSkill('skill-a', 'src/alpha');
    insertSkill('skill-b', 'other-src/beta', 'other-src');
    settingsService.getSkillSourcesEnabled.mockReturnValue({ 'other-src': false });

    const result = await service.setSkillsEnabled('proj-g', ['src/alpha', 'other-src/beta'], false);

    expect(result).toEqual({
      updated: ['src/alpha'],
      unchanged: [],
      notFound: ['other-src/beta'],
    });
    expect(disabledRows('proj-g').map((row) => row.skill_id)).toEqual(['skill-a']);
  });

  it('disables a skill of a project-disabled source and leaves the source disabled', async () => {
    insertProject('proj-h');
    insertSkill('skill-a', 'src/alpha');
    sqlite
      .prepare(
        `INSERT INTO source_project_enabled (id, project_id, source_name, enabled, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('spe-h', 'proj-h', 'src', 0, now);

    const result = await service.setSkillsEnabled('proj-h', ['src/alpha'], false);

    expect(result).toEqual({ updated: ['src/alpha'], unchanged: [], notFound: [] });
    expect(disabledRows('proj-h').map((row) => row.skill_id)).toEqual(['skill-a']);
    const sourceRow = sqlite
      .prepare(
        `SELECT enabled FROM source_project_enabled WHERE project_id = ? AND source_name = ?`,
      )
      .get('proj-h', 'src') as { enabled: number };
    expect(sourceRow.enabled).toBe(0);
  });

  it('compares the skill-level state, not the effective state', async () => {
    insertProject('proj-i');
    insertSkill('skill-a', 'src/alpha');
    sqlite
      .prepare(
        `INSERT INTO source_project_enabled (id, project_id, source_name, enabled, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('spe-i', 'proj-i', 'src', 0, now);

    // The skill has no skill_project_disabled row: enabling it is a skill-level
    // no-op even though the project-disabled source keeps it undiscoverable.
    const enable = await service.setSkillsEnabled('proj-i', ['src/alpha'], true);
    expect(enable).toEqual({ updated: [], unchanged: ['src/alpha'], notFound: [] });
    expect(disabledRows('proj-i')).toEqual([]);

    const disable = await service.setSkillsEnabled('proj-i', ['src/alpha'], false);
    expect(disable).toEqual({ updated: ['src/alpha'], unchanged: [], notFound: [] });
    expect(disabledRows('proj-i').map((row) => row.skill_id)).toEqual(['skill-a']);
  });

  describe('setSourceProjectEnabledForMcp', () => {
    const sourceRows = (projectId: string): { source_name: string; enabled: number }[] =>
      sqlite
        .prepare(`SELECT source_name, enabled FROM source_project_enabled WHERE project_id = ?`)
        .all(projectId) as { source_name: string; enabled: number }[];

    it('enables a source for the session project only', async () => {
      insertProject('proj-j1');
      insertProject('proj-j2');

      const result = await service.setSourceProjectEnabledForMcp('proj-j1', ' Src ', true);

      expect(result).toEqual({
        status: 'ok',
        name: 'src',
        projectId: 'proj-j1',
        projectEnabled: true,
      });
      expect(sourceRows('proj-j1')).toEqual([{ source_name: 'src', enabled: 1 }]);
      expect(sourceRows('proj-j2')).toEqual([]);

      const disabled = await service.setSourceProjectEnabledForMcp('proj-j1', 'src', false);
      expect(disabled).toEqual({
        status: 'ok',
        name: 'src',
        projectId: 'proj-j1',
        projectEnabled: false,
      });
      expect(sourceRows('proj-j1')).toEqual([{ source_name: 'src', enabled: 0 }]);
    });

    it('returns source_not_found for an unknown source and writes nothing', async () => {
      insertProject('proj-k');

      const result = await service.setSourceProjectEnabledForMcp('proj-k', 'nope', true);

      expect(result).toEqual({ status: 'source_not_found', name: 'nope' });
      expect(sourceRows('proj-k')).toEqual([]);
    });

    it('returns source_disabled_globally for a globally disabled source and writes nothing', async () => {
      insertProject('proj-l');
      settingsService.getSkillSourcesEnabled.mockReturnValue({ 'other-src': false });

      const result = await service.setSourceProjectEnabledForMcp('proj-l', 'other-src', true);

      expect(result).toEqual({ status: 'source_disabled_globally', name: 'other-src' });
      expect(sourceRows('proj-l')).toEqual([]);
    });
  });
});
