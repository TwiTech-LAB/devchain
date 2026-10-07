import { createTestDatabase } from '../../../common/test/test-database.helper';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { SettingsService } from '../../settings/services/settings.service';
import type { SkillSourceRegistryService } from './skill-source-registry.service';
import { SkillsService } from './skills.service';

const now = '2026-01-01T00:00:00.000Z';

describe('SkillsService search semantics', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let settingsService: { getSkillSourcesEnabled: jest.Mock };
  let registryService: {
    listRegisteredSources: jest.Mock;
    getBuiltInSourceNames: jest.Mock;
  };
  let service: SkillsService;

  beforeEach(() => {
    ({ sqlite, db } = createTestDatabase());

    settingsService = {
      getSkillSourcesEnabled: jest.fn().mockReturnValue({}),
    };
    registryService = {
      listRegisteredSources: jest.fn().mockResolvedValue([
        { name: 'openai', repoUrl: 'https://example.test/openai', kind: 'builtin' },
        { name: 'anthropic', repoUrl: 'https://example.test/anthropic', kind: 'builtin' },
      ]),
      getBuiltInSourceNames: jest.fn().mockReturnValue(['openai', 'anthropic']),
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

  const insertSkill = (params: {
    id: string;
    slug: string;
    name: string;
    displayName?: string;
    description?: string | null;
    source: string;
    category?: string | null;
  }): void => {
    sqlite
      .prepare(
        `INSERT INTO skills (id, slug, name, display_name, description, source, category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.slug,
        params.name,
        params.displayName ?? params.name,
        params.description ?? null,
        params.source,
        params.category ?? null,
        now,
        now,
      );
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

  // ── listSkills (global) ───────────────────────────────────────────────────

  describe('listSkills (global)', () => {
    it('matches a single-term query across slug, name, and description', async () => {
      insertSkill({
        id: 'a',
        slug: 'openai/typescript-sdk',
        name: 'TypeScript SDK',
        source: 'openai',
      });
      insertSkill({ id: 'b', slug: 'openai/react-hooks', name: 'React Hooks', source: 'openai' });
      insertSkill({
        id: 'c',
        slug: 'openai/helper',
        name: 'Helper Lib',
        description: 'a typescript utility',
        source: 'openai',
      });

      const results = await service.listSkills({ q: 'typescript' });
      const slugs = results.map((s) => s.slug).sort();
      expect(slugs).toEqual(['openai/helper', 'openai/typescript-sdk']);
    });

    it('multi-term query uses OR semantics — skills matching any individual term are included', async () => {
      insertSkill({ id: 'a', slug: 'openai/react-lib', name: 'React Library', source: 'openai' });
      insertSkill({
        id: 'b',
        slug: 'openai/typescript-sdk',
        name: 'TypeScript SDK',
        source: 'openai',
      });
      insertSkill({ id: 'c', slug: 'openai/unrelated', name: 'Unrelated Skill', source: 'openai' });

      const results = await service.listSkills({ q: 'react typescript' });
      const slugs = results.map((s) => s.slug).sort();
      expect(slugs).toEqual(['openai/react-lib', 'openai/typescript-sdk']);
    });

    it.each([
      {
        label: '%',
        query: '100%',
        slug: 'openai/rate-limiter',
        name: '100% rate limited',
        otherSlug: 'openai/other',
        otherName: 'Other Skill',
      },
      {
        label: '_',
        query: 'task_runner',
        slug: 'openai/task-runner',
        name: 'task_runner helper',
        otherSlug: 'openai/taskxrunner',
        otherName: 'taskxrunner helper',
      },
    ])(
      'treats $label as a literal SQL character',
      async ({ query, slug, name, otherSlug, otherName }) => {
        insertSkill({ id: 'a', slug, name, source: 'openai' });
        insertSkill({ id: 'b', slug: otherSlug, name: otherName, source: 'openai' });
        const results = await service.listSkills({ q: query });
        expect(results).toHaveLength(1);
        expect(results[0]?.slug).toBe(slug);
      },
    );

    it('combines source filter with multi-term search', async () => {
      insertSkill({ id: 'a', slug: 'openai/react-lib', name: 'React Library', source: 'openai' });
      insertSkill({
        id: 'b',
        slug: 'anthropic/react-lib',
        name: 'React Library',
        source: 'anthropic',
      });
      insertSkill({
        id: 'c',
        slug: 'openai/typescript-sdk',
        name: 'TypeScript SDK',
        source: 'openai',
      });

      const results = await service.listSkills({ q: 'react typescript', source: 'openai' });
      const slugs = results.map((s) => s.slug).sort();
      expect(slugs).toEqual(['openai/react-lib', 'openai/typescript-sdk']);
    });

    it('ranks slug/name/displayName matches before description-only matches', async () => {
      insertSkill({
        id: 'a',
        slug: 'openai/typescript-sdk',
        name: 'TypeScript SDK',
        source: 'openai',
      });
      insertSkill({
        id: 'b',
        slug: 'openai/code-helper',
        name: 'Code Helper',
        description: 'a typescript utility library',
        source: 'openai',
      });

      const results = await service.listSkills({ q: 'typescript' });
      expect(results[0]?.slug).toBe('openai/typescript-sdk');
      expect(results[1]?.slug).toBe('openai/code-helper');
    });

    it('returns all enabled skills in name/slug alphabetical order when no query given', async () => {
      insertSkill({ id: 'a', slug: 'openai/zebra', name: 'Zebra Tool', source: 'openai' });
      insertSkill({ id: 'b', slug: 'openai/alpha', name: 'Alpha Tool', source: 'openai' });
      insertSkill({ id: 'c', slug: 'openai/middle', name: 'Middle Tool', source: 'openai' });

      const results = await service.listSkills();
      expect(results.map((s) => s.slug)).toEqual(['openai/alpha', 'openai/middle', 'openai/zebra']);
    });
  });

  // ── listDiscoverable (project) ────────────────────────────────────────────

  describe('listDiscoverable (project)', () => {
    it('excludes project-disabled skills even when they match a multi-term query', async () => {
      insertProject('proj-a');
      insertSkill({ id: 'a', slug: 'openai/react-lib', name: 'React Library', source: 'openai' });
      insertSkill({
        id: 'b',
        slug: 'openai/typescript-sdk',
        name: 'TypeScript SDK',
        source: 'openai',
      });

      sqlite
        .prepare(
          `INSERT INTO skill_project_disabled (id, project_id, skill_id, created_at) VALUES (?, ?, ?, ?)`,
        )
        .run('spd-1', 'proj-a', 'a', now);

      const results = await service.listDiscoverable('proj-a', { q: 'react typescript' });
      expect(results.map((s) => s.slug)).toEqual(['openai/typescript-sdk']);
    });

    it('excludes skills from globally-disabled sources even when they match a multi-term query', async () => {
      insertProject('proj-b');
      insertSkill({ id: 'a', slug: 'openai/react-lib', name: 'React Library', source: 'openai' });
      insertSkill({
        id: 'b',
        slug: 'anthropic/typescript-sdk',
        name: 'TypeScript SDK',
        source: 'anthropic',
      });

      settingsService.getSkillSourcesEnabled.mockReturnValue({ openai: false });

      const results = await service.listDiscoverable('proj-b', { q: 'react typescript' });
      expect(results.map((s) => s.slug)).toEqual(['anthropic/typescript-sdk']);
    });

    it('excludes skills from per-project disabled source with multi-term search', async () => {
      insertProject('proj-c');
      insertSkill({ id: 'a', slug: 'openai/react-lib', name: 'React Library', source: 'openai' });
      insertSkill({
        id: 'b',
        slug: 'anthropic/typescript-sdk',
        name: 'TypeScript SDK',
        source: 'anthropic',
      });
      insertSourceProjectEnabled('proj-c', 'openai', false);

      const results = await service.listDiscoverable('proj-c', { q: 'react typescript' });
      expect(results.map((s) => s.slug)).toEqual(['anthropic/typescript-sdk']);
    });

    it('combines source filter with multi-term search in listDiscoverable', async () => {
      insertProject('proj-d');
      insertSkill({ id: 'a', slug: 'openai/react-lib', name: 'React Library', source: 'openai' });
      insertSkill({
        id: 'b',
        slug: 'anthropic/react-lib',
        name: 'React Library',
        source: 'anthropic',
      });
      insertSkill({
        id: 'c',
        slug: 'openai/typescript-sdk',
        name: 'TypeScript SDK',
        source: 'openai',
      });

      const results = await service.listDiscoverable('proj-d', {
        q: 'react typescript',
        source: 'openai',
      });
      const slugs = results.map((s) => s.slug).sort();
      expect(slugs).toEqual(['openai/react-lib', 'openai/typescript-sdk']);
    });

    it('combines category filter with multi-term search in listDiscoverable', async () => {
      insertProject('proj-e');
      insertSkill({
        id: 'a',
        slug: 'openai/react-review',
        name: 'React Review',
        source: 'openai',
        category: 'quality',
      });
      insertSkill({
        id: 'b',
        slug: 'openai/typescript-util',
        name: 'TypeScript Util',
        source: 'openai',
        category: 'utility',
      });
      insertSkill({
        id: 'c',
        slug: 'openai/react-dev',
        name: 'React Dev',
        source: 'openai',
        category: 'utility',
      });

      const results = await service.listDiscoverable('proj-e', {
        q: 'react typescript',
        category: 'utility',
      });
      const slugs = results.map((s) => s.slug).sort();
      expect(slugs).toEqual(['openai/react-dev', 'openai/typescript-util']);
    });

    it('returns discoverable skills in name/slug order when no query given', async () => {
      insertProject('proj-f');
      insertSkill({ id: 'a', slug: 'openai/zebra', name: 'Zebra Tool', source: 'openai' });
      insertSkill({ id: 'b', slug: 'openai/alpha', name: 'Alpha Tool', source: 'openai' });
      insertSkill({ id: 'c', slug: 'openai/middle', name: 'Middle Tool', source: 'openai' });

      const results = await service.listDiscoverable('proj-f');
      expect(results.map((s) => s.slug)).toEqual(['openai/alpha', 'openai/middle', 'openai/zebra']);
    });
  });

  // ── listAllForProject (project with disabled flags) ───────────────────────

  describe('listAllForProject (project with disabled flags)', () => {
    it('returns matching skills with correct disabled flag under multi-term search', async () => {
      insertProject('proj-g');
      insertSkill({ id: 'a', slug: 'openai/react-lib', name: 'React Library', source: 'openai' });
      insertSkill({
        id: 'b',
        slug: 'openai/typescript-sdk',
        name: 'TypeScript SDK',
        source: 'openai',
      });

      sqlite
        .prepare(
          `INSERT INTO skill_project_disabled (id, project_id, skill_id, created_at) VALUES (?, ?, ?, ?)`,
        )
        .run('spd-g1', 'proj-g', 'a', now);

      const results = await service.listAllForProject('proj-g', { q: 'react typescript' });
      const bySlug = new Map(results.map((s) => [s.slug, s]));

      expect(bySlug.get('openai/react-lib')?.disabled).toBe(true);
      expect(bySlug.get('openai/typescript-sdk')?.disabled).toBe(false);
    });
  });
});
