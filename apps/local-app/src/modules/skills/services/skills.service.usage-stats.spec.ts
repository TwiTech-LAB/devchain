import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import type { SettingsService } from '../../settings/services/settings.service';
import type { SkillSourceRegistryService } from './skill-source-registry.service';
import { SkillsService } from './skills.service';

const now = '2026-01-01T00:00:00.000Z';

describe('SkillsService usage stats (complete) and epic references', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let service: SkillsService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    const migrationsFolder = join(__dirname, '../../../../drizzle');
    migrate(db, { migrationsFolder });

    service = new SkillsService(
      db,
      { getSkillSourcesEnabled: jest.fn().mockReturnValue({}) } as unknown as SettingsService,
      {
        listRegisteredSources: jest.fn().mockResolvedValue([]),
        getBuiltInSourceNames: jest.fn().mockReturnValue([]),
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

  const insertStatus = (params: {
    id: string;
    projectId: string;
    label: string;
    position?: number;
    mcpHidden?: boolean;
  }): void => {
    sqlite
      .prepare(
        `INSERT INTO statuses (id, project_id, label, color, position, mcp_hidden, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.projectId,
        params.label,
        '#000000',
        params.position ?? 0,
        params.mcpHidden ? 1 : 0,
        now,
        now,
      );
  };

  const insertEpic = (params: {
    id: string;
    projectId: string;
    statusId: string;
    parentId?: string | null;
    skillsRequired?: string[] | null;
  }): void => {
    sqlite
      .prepare(
        `INSERT INTO epics (id, project_id, title, description, status_id, parent_id, skills_required, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.projectId,
        `Epic ${params.id}`,
        null,
        params.statusId,
        params.parentId ?? null,
        params.skillsRequired ? JSON.stringify(params.skillsRequired) : null,
        now,
        now,
      );
  };

  const insertSkill = (id: string, slug: string): void => {
    sqlite
      .prepare(
        `INSERT INTO skills (id, slug, name, display_name, description, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, slug, slug.split('/')[1] ?? slug, slug.split('/')[1] ?? slug, null, 'src', now, now);
  };

  const insertUsage = (params: {
    id: string;
    skillId: string;
    skillSlug: string;
    projectId: string;
    accessedAt: string;
  }): void => {
    sqlite
      .prepare(
        `INSERT INTO skill_usage_log (id, skill_id, skill_slug, project_id, agent_id, agent_name_snapshot, accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.skillId,
        params.skillSlug,
        params.projectId,
        null,
        null,
        params.accessedAt,
      );
  };

  describe('getCompleteUsageStats', () => {
    it('returns every used skill without paging, also beyond the REST default limit of 100', async () => {
      insertProject('proj-a');
      const skillCount = 105;
      for (let i = 0; i < skillCount; i += 1) {
        const id = `skill-${i}`;
        insertSkill(id, `src/skill-${i}`);
        insertUsage({
          id: `usage-${i}`,
          skillId: id,
          skillSlug: `src/skill-${i}`,
          projectId: 'proj-a',
          accessedAt: now,
        });
      }

      const result = await service.getCompleteUsageStats({ projectId: 'proj-a' });

      expect(result.skills).toHaveLength(skillCount);
      expect(new Set(result.skills.map((row) => row.skillSlug)).size).toBe(skillCount);
    });

    it('summary matches the rows: distinctSkills equals the row count and totalEvents equals the usageCount sum', async () => {
      insertProject('proj-b');
      insertSkill('skill-a', 'src/alpha');
      insertSkill('skill-b', 'src/beta');
      insertUsage({
        id: 'u1',
        skillId: 'skill-a',
        skillSlug: 'src/alpha',
        projectId: 'proj-b',
        accessedAt: '2026-01-01T00:00:00.000Z',
      });
      insertUsage({
        id: 'u2',
        skillId: 'skill-a',
        skillSlug: 'src/alpha',
        projectId: 'proj-b',
        accessedAt: '2026-03-01T00:00:00.000Z',
      });
      insertUsage({
        id: 'u3',
        skillId: 'skill-b',
        skillSlug: 'src/beta',
        projectId: 'proj-b',
        accessedAt: '2026-02-01T00:00:00.000Z',
      });

      const result = await service.getCompleteUsageStats({ projectId: 'proj-b' });

      expect(result.summary).toEqual({
        totalEvents: 3,
        distinctSkills: 2,
        firstEventAt: '2026-01-01T00:00:00.000Z',
        lastEventAt: '2026-03-01T00:00:00.000Z',
      });
      expect(result.skills).toHaveLength(result.summary.distinctSkills);
      expect(result.skills.reduce((sum, row) => sum + row.usageCount, 0)).toBe(
        result.summary.totalEvents,
      );
    });

    it('applies the from/to window to the summary and the rows', async () => {
      insertProject('proj-c');
      insertSkill('skill-a', 'src/alpha');
      insertSkill('skill-b', 'src/beta');
      insertUsage({
        id: 'u1',
        skillId: 'skill-a',
        skillSlug: 'src/alpha',
        projectId: 'proj-c',
        accessedAt: '2026-01-01T00:00:00.000Z',
      });
      insertUsage({
        id: 'u2',
        skillId: 'skill-b',
        skillSlug: 'src/beta',
        projectId: 'proj-c',
        accessedAt: '2026-02-01T00:00:00.000Z',
      });
      insertUsage({
        id: 'u3',
        skillId: 'skill-b',
        skillSlug: 'src/beta',
        projectId: 'proj-c',
        accessedAt: '2026-03-01T00:00:00.000Z',
      });

      const result = await service.getCompleteUsageStats({
        projectId: 'proj-c',
        from: '2026-01-15T00:00:00.000Z',
        to: '2026-02-15T00:00:00.000Z',
      });

      expect(result.summary).toEqual({
        totalEvents: 1,
        distinctSkills: 1,
        firstEventAt: '2026-02-01T00:00:00.000Z',
        lastEventAt: '2026-02-01T00:00:00.000Z',
      });
      expect(result.skills.map((row) => row.skillSlug)).toEqual(['src/beta']);
    });

    it('excludes usage of other projects', async () => {
      insertProject('proj-d');
      insertProject('proj-other');
      insertSkill('skill-a', 'src/alpha');
      insertUsage({
        id: 'u1',
        skillId: 'skill-a',
        skillSlug: 'src/alpha',
        projectId: 'proj-d',
        accessedAt: now,
      });
      insertUsage({
        id: 'u2',
        skillId: 'skill-a',
        skillSlug: 'src/alpha',
        projectId: 'proj-other',
        accessedAt: now,
      });

      const result = await service.getCompleteUsageStats({ projectId: 'proj-d' });

      expect(result.summary.totalEvents).toBe(1);
      expect(result.skills).toHaveLength(1);
    });

    it('returns zeroed summary and empty rows for a project without usage', async () => {
      insertProject('proj-empty');

      const result = await service.getCompleteUsageStats({ projectId: 'proj-empty' });

      expect(result).toEqual({
        summary: {
          totalEvents: 0,
          distinctSkills: 0,
          firstEventAt: null,
          lastEventAt: null,
        },
        skills: [],
      });
    });
  });

  describe('getSkillsEpicReferences', () => {
    it('counts parent and child epics once per slug, grouped by status label', async () => {
      insertProject('proj-e');
      insertStatus({ id: 'st-open', projectId: 'proj-e', label: 'In Progress', position: 0 });
      insertStatus({ id: 'st-done', projectId: 'proj-e', label: 'Done', position: 1 });
      insertEpic({
        id: 'parent-1',
        projectId: 'proj-e',
        statusId: 'st-open',
        skillsRequired: ['src/alpha', 'src/beta'],
      });
      insertEpic({
        id: 'child-1',
        projectId: 'proj-e',
        statusId: 'st-open',
        parentId: 'parent-1',
        // Duplicated slug in one epic row still counts that epic once.
        skillsRequired: ['src/alpha', 'src/alpha'],
      });
      insertEpic({
        id: 'parent-2',
        projectId: 'proj-e',
        statusId: 'st-done',
        skillsRequired: ['src/alpha'],
      });
      insertEpic({
        id: 'parent-3',
        projectId: 'proj-e',
        statusId: 'st-open',
        skillsRequired: null,
      });

      const references = await service.getSkillsEpicReferences('proj-e');

      expect(references).toEqual([
        { slug: 'src/alpha', total: 3, byStatus: { 'In Progress': 2, Done: 1 } },
        { slug: 'src/beta', total: 1, byStatus: { 'In Progress': 1 } },
      ]);
    });

    it('includes epics with MCP-hidden statuses under their status label', async () => {
      insertProject('proj-f');
      insertStatus({
        id: 'st-hidden',
        projectId: 'proj-f',
        label: 'Archived',
        mcpHidden: true,
      });
      insertEpic({
        id: 'parent-1',
        projectId: 'proj-f',
        statusId: 'st-hidden',
        skillsRequired: ['src/alpha'],
      });

      const references = await service.getSkillsEpicReferences('proj-f');

      expect(references).toEqual([{ slug: 'src/alpha', total: 1, byStatus: { Archived: 1 } }]);
    });

    it('excludes epics of other projects', async () => {
      insertProject('proj-g');
      insertProject('proj-other');
      insertStatus({ id: 'st-open-g', projectId: 'proj-g', label: 'In Progress' });
      insertStatus({ id: 'st-open-o', projectId: 'proj-other', label: 'In Progress' });
      insertEpic({
        id: 'epic-g',
        projectId: 'proj-g',
        statusId: 'st-open-g',
        skillsRequired: ['src/alpha'],
      });
      insertEpic({
        id: 'epic-o',
        projectId: 'proj-other',
        statusId: 'st-open-o',
        skillsRequired: ['src/alpha'],
      });

      const references = await service.getSkillsEpicReferences('proj-g');

      expect(references).toEqual([{ slug: 'src/alpha', total: 1, byStatus: { 'In Progress': 1 } }]);
    });
  });
});
