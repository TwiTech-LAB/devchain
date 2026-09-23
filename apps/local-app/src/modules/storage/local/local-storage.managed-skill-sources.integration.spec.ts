import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { ConflictError } from '../../../common/errors/error-types';
import { LocalStorageService } from './local-storage.service';

describe('LocalStorageService - managed skill source transactions', () => {
  let sqlite: Database.Database;
  let service: LocalStorageService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: join(__dirname, '../../../../drizzle') });
    sqlite.pragma('foreign_keys = ON');
    service = new LocalStorageService(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  function holdTransaction(): { held: Promise<void>; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      held: service.runInTransaction(async () => gate),
      release,
    };
  }

  it('serializes concurrent cross-kind names with exactly one durable winner', async () => {
    const community = service.createCommunitySkillSource({
      name: 'shared-name',
      repoOwner: 'owner',
      repoName: 'shared-repo',
      branch: 'main',
    });
    const local = service.createLocalSkillSource({
      name: 'SHARED-NAME',
      folderPath: '/tmp/shared-name',
    });

    const results = await Promise.allSettled([community, local]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejection?.reason).toBeInstanceOf(ConflictError);

    const persisted = sqlite
      .prepare(
        `SELECT name, 'community' AS kind FROM community_skill_sources
         UNION ALL
         SELECT name, 'local' AS kind FROM local_skill_sources`,
      )
      .all() as Array<{ name: string; kind: string }>;
    expect(persisted).toEqual([{ name: 'shared-name', kind: 'community' }]);
  });

  it('rolls back an optioned source when existing-project default insertion fails', async () => {
    const project = await service.createProject({
      name: 'Existing Project',
      description: null,
      rootPath: '/tmp/existing-project',
      isTemplate: false,
    });
    sqlite.exec(`
      CREATE TRIGGER fail_managed_source_default
      BEFORE INSERT ON source_project_enabled
      WHEN NEW.source_name = 'atomic-source'
      BEGIN
        SELECT RAISE(FAIL, 'injected managed source default failure');
      END;
    `);

    await expect(
      service.createCommunitySkillSource(
        {
          name: 'atomic-source',
          repoOwner: 'owner',
          repoName: 'atomic-repo',
          branch: 'main',
        },
        { existingProjects: { mode: 'none' } },
      ),
    ).rejects.toMatchObject({
      details: { cause: expect.stringContaining('injected managed source default failure') },
    });

    expect(
      sqlite.prepare('SELECT id FROM community_skill_sources WHERE name = ?').get('atomic-source'),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare('SELECT id FROM source_project_enabled WHERE project_id = ? AND source_name = ?')
        .get(project.id, 'atomic-source'),
    ).toBeUndefined();
  });

  it('rolls back an optioned local source when existing-project default insertion fails', async () => {
    const project = await service.createProject({
      name: 'Existing Local Project',
      description: null,
      rootPath: '/tmp/existing-local-project',
      isTemplate: false,
    });
    sqlite.exec(`
      CREATE TRIGGER fail_local_managed_source_default
      BEFORE INSERT ON source_project_enabled
      WHEN NEW.source_name = 'atomic-local'
      BEGIN
        SELECT RAISE(FAIL, 'injected local managed source default failure');
      END;
    `);

    await expect(
      service.createLocalSkillSource(
        {
          name: 'atomic-local',
          folderPath: '/tmp/atomic-local',
        },
        { existingProjects: { mode: 'none' } },
      ),
    ).rejects.toMatchObject({
      details: { cause: expect.stringContaining('injected local managed source default failure') },
    });

    expect(
      sqlite.prepare('SELECT id FROM local_skill_sources WHERE name = ?').get('atomic-local'),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare('SELECT id FROM source_project_enabled WHERE project_id = ? AND source_name = ?')
        .get(project.id, 'atomic-local'),
    ).toBeUndefined();
  });

  it('keeps project-first ordering disabled behind a held async transaction', async () => {
    const blocker = holdTransaction();
    const project = service.createProject({
      name: 'Project First',
      description: null,
      rootPath: '/tmp/project-first',
      isTemplate: false,
    });
    const source = service.createCommunitySkillSource(
      {
        name: 'community-second',
        repoOwner: 'owner',
        repoName: 'community-second-repo',
        branch: 'main',
      },
      { existingProjects: { mode: 'none' } },
    );

    blocker.release();
    const [createdProject] = await Promise.all([project, source, blocker.held]);

    await expect(
      service.getSourceProjectEnabled(createdProject.id, 'community-second'),
    ).resolves.toBe(false);
  });

  it('keeps source-first ordering enabled behind a held async transaction', async () => {
    const blocker = holdTransaction();
    const source = service.createLocalSkillSource(
      {
        name: 'local-first',
        folderPath: '/tmp/local-first',
      },
      { existingProjects: { mode: 'none' } },
    );
    const project = service.createProject({
      name: 'Project Second',
      description: null,
      rootPath: '/tmp/project-second',
      isTemplate: false,
    });

    blocker.release();
    const [, createdProject] = await Promise.all([source, project, blocker.held]);

    await expect(service.getSourceProjectEnabled(createdProject.id, 'local-first')).resolves.toBe(
      true,
    );
  });

  it('admits template project creation through its outer async transaction', async () => {
    let releaseTemplate!: () => void;
    const templateGate = new Promise<void>((resolve) => {
      releaseTemplate = resolve;
    });
    const templateProject = service.runInTransaction(async () => {
      await templateGate;
      return service.createProjectShell({
        name: 'Template Project First',
        description: null,
        rootPath: '/tmp/template-project-first',
        isTemplate: false,
      });
    });
    const source = service.createCommunitySkillSource(
      {
        name: 'template-later-source',
        repoOwner: 'owner',
        repoName: 'template-later-repo',
        branch: 'main',
      },
      { existingProjects: { mode: 'none' } },
    );

    releaseTemplate();
    const [project] = await Promise.all([templateProject, source]);

    await expect(
      service.getSourceProjectEnabled(project.id, 'template-later-source'),
    ).resolves.toBe(false);
  });

  describe('existing-project enablement choice', () => {
    const enablementRows = (
      sqlite: Database.Database,
      sourceName: string,
    ): Array<{ project_id: string; enabled: number }> =>
      sqlite
        .prepare(
          'SELECT project_id, enabled FROM source_project_enabled WHERE source_name = ? ORDER BY project_id',
        )
        .all(sourceName) as Array<{ project_id: string; enabled: number }>;

    it('enables every existing project for mode all', async () => {
      const first = await service.createProject({
        name: 'All First',
        description: null,
        rootPath: '/tmp/all-first',
        isTemplate: false,
      });
      const second = await service.createProject({
        name: 'All Second',
        description: null,
        rootPath: '/tmp/all-second',
        isTemplate: false,
      });

      await service.createLocalSkillSource(
        { name: 'all-mode', folderPath: '/tmp/all-mode' },
        { existingProjects: { mode: 'all' } },
      );

      expect(enablementRows(sqlite, 'all-mode')).toEqual(
        [
          { project_id: first.id, enabled: 1 },
          { project_id: second.id, enabled: 1 },
        ].sort((left, right) => left.project_id.localeCompare(right.project_id)),
      );
    });

    it('enables selected projects and disables the other existing ones', async () => {
      const chosen = await service.createProject({
        name: 'Chosen Project',
        description: null,
        rootPath: '/tmp/chosen-project',
        isTemplate: false,
      });
      const other = await service.createProject({
        name: 'Other Project',
        description: null,
        rootPath: '/tmp/other-project',
        isTemplate: false,
      });

      await service.createCommunitySkillSource(
        {
          name: 'selected-mode',
          repoOwner: 'owner',
          repoName: 'selected-repo',
          branch: 'main',
        },
        { existingProjects: { mode: 'selected', projectIds: [chosen.id] } },
      );

      expect(enablementRows(sqlite, 'selected-mode')).toEqual(
        [
          { project_id: chosen.id, enabled: 1 },
          { project_id: other.id, enabled: 0 },
        ].sort((left, right) => left.project_id.localeCompare(right.project_id)),
      );
    });

    it('rejects unknown selected project ids and rolls back source and enablement rows', async () => {
      const known = await service.createProject({
        name: 'Known Project',
        description: null,
        rootPath: '/tmp/known-project',
        isTemplate: false,
      });

      await expect(
        service.createLocalSkillSource(
          { name: 'unknown-target', folderPath: '/tmp/unknown-target' },
          {
            existingProjects: {
              mode: 'selected',
              projectIds: [known.id, '00000000-0000-0000-0000-0000000000aa'],
            },
          },
        ),
      ).rejects.toMatchObject({
        code: 'validation_error',
        details: { unknownProjectIds: ['00000000-0000-0000-0000-0000000000aa'] },
      });

      expect(
        sqlite.prepare('SELECT id FROM local_skill_sources WHERE name = ?').get('unknown-target'),
      ).toBeUndefined();
      expect(enablementRows(sqlite, 'unknown-target')).toEqual([]);
    });
  });
});
