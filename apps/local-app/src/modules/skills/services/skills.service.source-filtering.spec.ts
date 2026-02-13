import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import type { SettingsService } from '../../settings/services/settings.service';
import type { SkillSourceRegistryService } from './skill-source-registry.service';
import { SkillsService } from './skills.service';

const now = '2026-01-01T00:00:00.000Z';

describe('SkillsService source filtering', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let settingsService: { getSkillSourcesEnabled: jest.Mock };
  let registryService: {
    listRegisteredSources: jest.Mock;
    getBuiltInSourceNames: jest.Mock;
  };
  let service: SkillsService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    const migrationsFolder = join(__dirname, '../../../../drizzle');
    migrate(db, { migrationsFolder });

    settingsService = {
      getSkillSourcesEnabled: jest.fn().mockReturnValue({}),
    };
    registryService = {
      listRegisteredSources: jest.fn().mockResolvedValue([
        { name: 'anthropic', repoUrl: 'https://example.test/anthropic', kind: 'builtin' },
        { name: 'community', repoUrl: 'https://example.test/community', kind: 'community' },
        { name: 'openai', repoUrl: 'https://example.test/openai', kind: 'builtin' },
      ]),
      getBuiltInSourceNames: jest.fn().mockReturnValue(['anthropic', 'openai']),
    };

    service = new SkillsService(
      db,
      settingsService as unknown as SettingsService,
      registryService as unknown as SkillSourceRegistryService,
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

  const insertSkill = (id: string, slug: string, source: string): void => {
    sqlite
      .prepare(
        `INSERT INTO skills (id, slug, name, display_name, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, slug, slug.split('/')[1] ?? slug, slug, source, now, now);
  };

  const insertSourceProjectEnabled = (
    projectId: string,
    sourceName: string,
    enabled: boolean,
  ): void => {
    sqlite
      .prepare(
        `INSERT INTO source_project_enabled (id, project_id, source_name, enabled, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(`${projectId}-${sourceName}`, projectId, sourceName, enabled ? 1 : 0, now);
  };

  it('filters discoverable skills using global and per-project source state', async () => {
    insertProject('project-1');
    insertSkill('skill-openai', 'openai/review', 'openai');
    insertSkill('skill-community', 'community/check', 'community');
    insertSourceProjectEnabled('project-1', 'community', false);

    const discoverable = await service.listDiscoverable('project-1');
    expect(discoverable.map((skill) => skill.slug)).toEqual(['openai/review']);

    settingsService.getSkillSourcesEnabled.mockReturnValue({ openai: false, community: true });
    const globallyDisabled = await service.listDiscoverable('project-1');
    expect(globallyDisabled).toEqual([]);
  });

  it('filters listAllForProject by per-project source state and keeps skill disabled flags', async () => {
    insertProject('project-2');
    insertSkill('skill-openai-2', 'openai/assist', 'openai');
    insertSkill('skill-community-2', 'community/helper', 'community');
    insertSourceProjectEnabled('project-2', 'community', false);
    sqlite
      .prepare(
        `INSERT INTO skill_project_disabled (id, project_id, skill_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('spd-1', 'project-2', 'skill-openai-2', now);

    const skills = await service.listAllForProject('project-2');
    expect(skills).toHaveLength(1);
    expect(skills[0]?.slug).toBe('openai/assist');
    expect(skills[0]?.disabled).toBe(true);
  });

  it('returns projectEnabled metadata when listing sources for a project', async () => {
    insertProject('project-3');
    insertSkill('skill-openai-3', 'openai/chat', 'openai');
    insertSkill('skill-community-3', 'community/sync', 'community');
    insertSourceProjectEnabled('project-3', 'openai', false);
    insertSourceProjectEnabled('project-3', 'community', true);

    settingsService.getSkillSourcesEnabled.mockReturnValue({ community: false });
    const withProject = await service.listSources('project-3');
    const byName = new Map(withProject.map((source) => [source.name, source]));

    expect(byName.get('openai')).toEqual(
      expect.objectContaining({
        enabled: true,
        projectEnabled: false,
        skillCount: 1,
      }),
    );
    expect(byName.get('community')).toEqual(
      expect.objectContaining({
        enabled: false,
        projectEnabled: false,
        skillCount: 1,
      }),
    );
    expect(byName.get('anthropic')).toEqual(
      expect.objectContaining({
        enabled: true,
        projectEnabled: true,
        skillCount: 0,
      }),
    );

    const withoutProject = await service.listSources();
    expect(withoutProject.some((source) => 'projectEnabled' in source)).toBe(false);
  });
});
