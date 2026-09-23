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
        { name: 'devchain-local', repoUrl: 'https://example.test/devchain-local', kind: 'local' },
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

  const insertSkill = (id: string, slug: string, source: string, name?: string): void => {
    sqlite
      .prepare(
        `INSERT INTO skills (id, slug, name, display_name, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, slug, name ?? slug.split('/')[1] ?? slug, slug, source, now, now);
  };

  const insertSkillProjectDisabled = (id: string, projectId: string, skillId: string): void => {
    sqlite
      .prepare(
        `INSERT INTO skill_project_disabled (id, project_id, skill_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, projectId, skillId, now);
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

  describe('resolveDiscoverableSkill', () => {
    it('resolves a discoverable full slug and trims and lowercases the input', async () => {
      insertProject('project-a');
      insertSkill('skill-anthropic-a', 'anthropic/review', 'anthropic');

      const result = await service.resolveDiscoverableSkill('project-a', ' ANTHROPIC/REVIEW ');

      expect(result).toEqual({
        status: 'resolved',
        skill: expect.objectContaining({ slug: 'anthropic/review' }),
      });
    });

    it('reports a full slug whose source is disabled globally with enabled alternatives', async () => {
      insertProject('project-b');
      insertSkill('skill-community-b', 'community/check', 'community');
      insertSkill('skill-openai-b', 'openai/check', 'openai');
      settingsService.getSkillSourcesEnabled.mockReturnValue({ community: false });

      const result = await service.resolveDiscoverableSkill('project-b', 'community/check');

      expect(result).toEqual({ status: 'disabled', enabledAlternatives: ['openai/check'] });
    });

    it('reports a full slug whose source is disabled for the project', async () => {
      insertProject('project-c');
      insertSkill('skill-community-c', 'community/check', 'community');
      insertSourceProjectEnabled('project-c', 'community', false);

      const result = await service.resolveDiscoverableSkill('project-c', 'community/check');

      expect(result).toEqual({ status: 'disabled', enabledAlternatives: [] });
    });

    it('reports a full slug the project disabled with enabled alternatives', async () => {
      insertProject('project-d');
      insertSkill('skill-openai-d', 'openai/check', 'openai');
      insertSkill('skill-anthropic-d', 'anthropic/check', 'anthropic');
      insertSkillProjectDisabled('spd-d', 'project-d', 'skill-openai-d');

      const result = await service.resolveDiscoverableSkill('project-d', 'openai/check');

      expect(result).toEqual({ status: 'disabled', enabledAlternatives: ['anthropic/check'] });
    });

    it('reports not_found for a full slug that no skill row has', async () => {
      insertProject('project-e');

      const result = await service.resolveDiscoverableSkill('project-e', 'anthropic/missing');

      expect(result).toEqual({ status: 'not_found' });
    });

    it('resolves a bare name with a single discoverable match and normalizes the input', async () => {
      insertProject('project-f');
      insertSkill('skill-anthropic-f', 'anthropic/review', 'anthropic');

      const result = await service.resolveDiscoverableSkill('project-f', ' Review ');

      expect(result).toEqual({
        status: 'resolved',
        skill: expect.objectContaining({ slug: 'anthropic/review' }),
      });
    });

    it('prefers the single enabled local match for a bare name', async () => {
      insertProject('project-g');
      insertSkill('skill-local-g', 'devchain-local/ste', 'devchain-local');
      insertSkill('skill-openai-g', 'openai/ste', 'openai');

      const result = await service.resolveDiscoverableSkill('project-g', 'ste');

      expect(result).toEqual({
        status: 'resolved',
        skill: expect.objectContaining({ slug: 'devchain-local/ste' }),
      });
    });

    it('does not let a disabled local match win over an enabled non-local match', async () => {
      insertProject('project-h');
      insertSkill('skill-local-h', 'devchain-local/ste', 'devchain-local');
      insertSkill('skill-openai-h', 'openai/ste', 'openai');
      insertSourceProjectEnabled('project-h', 'devchain-local', false);

      const result = await service.resolveDiscoverableSkill('project-h', 'ste');

      expect(result).toEqual({
        status: 'resolved',
        skill: expect.objectContaining({ slug: 'openai/ste' }),
      });
    });

    it('reports ambiguous for two enabled local matches with both slugs as candidates', async () => {
      insertProject('project-i');
      registryService.listRegisteredSources.mockResolvedValue([
        { name: 'anthropic', repoUrl: 'https://example.test/anthropic', kind: 'builtin' },
        { name: 'openai', repoUrl: 'https://example.test/openai', kind: 'builtin' },
        { name: 'devchain-local', repoUrl: 'https://example.test/devchain-local', kind: 'local' },
        { name: 'team-local', repoUrl: 'https://example.test/team-local', kind: 'local' },
      ]);
      insertSkill('skill-local-i', 'devchain-local/ste', 'devchain-local');
      insertSkill('skill-team-local-i', 'team-local/ste', 'team-local');

      const result = await service.resolveDiscoverableSkill('project-i', 'ste');

      expect(result).toEqual({
        status: 'ambiguous',
        candidates: ['devchain-local/ste', 'team-local/ste'],
      });
    });

    it('reports ambiguous for two enabled non-local matches', async () => {
      insertProject('project-j');
      insertSkill('skill-openai-j', 'openai/ste', 'openai');
      insertSkill('skill-anthropic-j', 'anthropic/ste', 'anthropic');

      const result = await service.resolveDiscoverableSkill('project-j', 'ste');

      expect(result).toEqual({ status: 'ambiguous', candidates: ['anthropic/ste', 'openai/ste'] });
    });

    it('reports a bare name that only matches non-discoverable skills as disabled', async () => {
      insertProject('project-k');
      insertSkill('skill-community-k', 'community/ste', 'community');
      insertSourceProjectEnabled('project-k', 'community', false);

      const result = await service.resolveDiscoverableSkill('project-k', 'ste');

      expect(result).toEqual({ status: 'disabled', enabledAlternatives: [] });
    });

    it('reports not_found for a bare name with no skill row match at all', async () => {
      insertProject('project-l');

      const result = await service.resolveDiscoverableSkill('project-l', 'missing');

      expect(result).toEqual({ status: 'not_found' });
    });

    it('matches a bare name by the slug name segment, not the stored skill name', async () => {
      insertProject('project-m');
      insertSkill('skill-openai-m', 'openai/asd-ste100-skill', 'openai', 'STE Simplifier');

      const bySegment = await service.resolveDiscoverableSkill('project-m', 'asd-ste100-skill');
      expect(bySegment).toEqual({
        status: 'resolved',
        skill: expect.objectContaining({ slug: 'openai/asd-ste100-skill' }),
      });

      const byName = await service.resolveDiscoverableSkill('project-m', 'STE Simplifier');
      expect(byName).toEqual({ status: 'not_found' });
    });
  });

  describe('listAllStoredForProject', () => {
    it('returns skills of project-disabled and globally disabled sources with correct flags', async () => {
      insertProject('project-s1');
      insertSkill('skill-openai-s1', 'openai/review', 'openai');
      insertSkill('skill-community-s1', 'community/check', 'community');
      insertSkill('skill-anthropic-s1', 'anthropic/guide', 'anthropic');
      insertSourceProjectEnabled('project-s1', 'community', false);
      settingsService.getSkillSourcesEnabled.mockReturnValue({ anthropic: false });

      const result = await service.listAllStoredForProject('project-s1');
      const bySlug = new Map(result.map((skill) => [skill.slug, skill]));

      expect(result).toHaveLength(3);
      expect(bySlug.get('openai/review')).toMatchObject({
        skillDisabled: false,
        sourceProjectEnabled: true,
        sourceGloballyEnabled: true,
        disabled: false,
      });
      expect(bySlug.get('community/check')).toMatchObject({
        skillDisabled: false,
        sourceProjectEnabled: false,
        sourceGloballyEnabled: true,
        disabled: true,
      });
      expect(bySlug.get('anthropic/guide')).toMatchObject({
        skillDisabled: false,
        sourceProjectEnabled: true,
        sourceGloballyEnabled: false,
        disabled: true,
      });
    });

    it('shows a skill-level disable and a source-level disable together', async () => {
      insertProject('project-s2');
      insertSkill('skill-openai-s2', 'openai/assist', 'openai');
      insertSkill('skill-community-s2', 'community/helper', 'community');
      insertSourceProjectEnabled('project-s2', 'community', false);
      insertSkillProjectDisabled('spd-s2', 'project-s2', 'skill-community-s2');

      const result = await service.listAllStoredForProject('project-s2');
      const bySlug = new Map(result.map((skill) => [skill.slug, skill]));

      expect(bySlug.get('community/helper')).toMatchObject({
        skillDisabled: true,
        sourceProjectEnabled: false,
        sourceGloballyEnabled: true,
        disabled: true,
      });
      expect(bySlug.get('openai/assist')).toMatchObject({
        skillDisabled: false,
        sourceProjectEnabled: true,
        sourceGloballyEnabled: true,
        disabled: false,
      });
    });

    it('defaults both source flags to enabled when no rows or settings exist', async () => {
      insertProject('project-s3');
      insertSkill('skill-openai-s3', 'openai/chat', 'openai');

      const result = await service.listAllStoredForProject('project-s3');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        slug: 'openai/chat',
        skillDisabled: false,
        sourceProjectEnabled: true,
        sourceGloballyEnabled: true,
        disabled: false,
      });
    });

    it('applies the q filter to the stored catalog', async () => {
      insertProject('project-s4');
      insertSkill('skill-openai-s4a', 'openai/react-hooks', 'openai');
      insertSkill('skill-openai-s4b', 'openai/sql-pro', 'openai');

      const result = await service.listAllStoredForProject('project-s4', { q: 'react' });

      expect(result.map((skill) => skill.slug)).toEqual(['openai/react-hooks']);
    });
  });
});
