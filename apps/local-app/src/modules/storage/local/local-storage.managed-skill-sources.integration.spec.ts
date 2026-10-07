import { LocalStorageService } from './local-storage.service';
import { ConflictError, ValidationError, NotFoundError } from '../../../common/errors/error-types';
import Database from 'better-sqlite3';
import { createTestDatabase } from '../../../common/test/test-database.helper';

describe('LocalStorageService skill sources', () => {
  let sqlite: Database.Database;
  let service: LocalStorageService;
  beforeEach(() => {
    const database = createTestDatabase();
    sqlite = database.sqlite;
    service = new LocalStorageService(database.db);
  });
  afterEach(() => sqlite.close());
  describe('LocalStorageService - managed skill source transactions', () => {
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
        sqlite
          .prepare('SELECT id FROM community_skill_sources WHERE name = ?')
          .get('atomic-source'),
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
        details: {
          cause: expect.stringContaining('injected local managed source default failure'),
        },
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

  describe('LocalStorageService - CommunitySkillSources integration', () => {
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

    it('does not treat live built-in names as storage policy', async () => {
      await expect(
        service.createCommunitySkillSource({
          name: 'openai',
          repoOwner: 'someone',
          repoName: 'raw-storage-source',
        }),
      ).resolves.toMatchObject({ name: 'openai' });
    });

    it('rejects community source names that collide with local source names', async () => {
      await service.createLocalSkillSource({
        name: 'shared-source',
        folderPath: '/tmp/shared-source',
      });

      await expect(
        service.createCommunitySkillSource({
          name: 'shared-source',
          repoOwner: 'someone',
          repoName: 'repo',
        }),
      ).rejects.toThrow(ConflictError);
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

    it('deletes related skills and enablement when deleting a community skill source', async () => {
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
        .run(
          'skill-1',
          'jeffallan/code-review',
          'Code Review',
          'Code Review',
          'jeffallan',
          now,
          now,
        );

      sqlite
        .prepare(
          `INSERT INTO skills (id, slug, name, display_name, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('skill-2', 'openai/other', 'Other', 'Other', 'openai', now, now);

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
        .run('spe-community', 'project-1', 'jeffallan', 0, now);

      sqlite
        .prepare(
          `INSERT INTO source_project_enabled (id, project_id, source_name, enabled, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        )
        .run('spe-openai', 'project-1', 'openai', 0, now);

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

      const deletedEnablementCount = sqlite
        .prepare('SELECT COUNT(*) as count FROM source_project_enabled WHERE source_name = ?')
        .get('jeffallan') as { count: number };
      expect(deletedEnablementCount.count).toBe(0);

      const remainingEnablementCount = sqlite
        .prepare('SELECT COUNT(*) as count FROM source_project_enabled WHERE source_name = ?')
        .get('openai') as { count: number };
      expect(remainingEnablementCount.count).toBe(1);
    });
  });

  describe('LocalStorageService - LocalSkillSources integration', () => {
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

    it('looks up local sources deliberately by normalized name', async () => {
      const source = await service.createLocalSkillSource({
        name: 'Local-Lookup',
        folderPath: '/tmp/local-lookup',
      });

      await expect(service.getLocalSkillSourceByName(' LOCAL-LOOKUP ')).resolves.toMatchObject({
        id: source.id,
        name: 'local-lookup',
      });
      await expect(service.getLocalSkillSourceByName('missing-local-source')).resolves.toBeNull();
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

  describe('LocalStorageService - source_project_enabled integration', () => {
    const createProject = async (name: string, rootPath: string) =>
      service.createProject({
        name,
        description: null,
        rootPath,
        isTemplate: false,
      });

    const createCommunitySource = async (name: string, repoName = `${name}-repo`) =>
      service.createCommunitySkillSource({
        name,
        repoOwner: 'owner',
        repoName,
        branch: 'main',
      });

    it('returns null when no entry exists and supports upsert semantics', async () => {
      const project = await createProject('Project A', '/tmp/source-project-enabled-a');

      await expect(service.getSourceProjectEnabled(project.id, 'openai')).resolves.toBeNull();

      await service.setSourceProjectEnabled(project.id, ' OpenAI ', true);
      await expect(service.getSourceProjectEnabled(project.id, 'openai')).resolves.toBe(true);
      await expect(service.listSourceProjectEnabled(project.id)).resolves.toEqual([
        { sourceName: 'openai', enabled: true },
      ]);

      await service.setSourceProjectEnabled(project.id, 'openai', false);
      await expect(service.getSourceProjectEnabled(project.id, 'openai')).resolves.toBe(false);
      await expect(service.listSourceProjectEnabled(project.id)).resolves.toEqual([
        { sourceName: 'openai', enabled: false },
      ]);
    });

    it('seeds an optioned community source disabled for existing projects', async () => {
      const project = await createProject('Project B', '/tmp/source-project-enabled-b');

      await service.createCommunitySkillSource(
        {
          name: 'community-later',
          repoOwner: 'owner',
          repoName: 'community-later-repo',
          branch: 'main',
        },
        { existingProjects: { mode: 'none' } },
      );

      await expect(service.listSourceProjectEnabled(project.id)).resolves.toEqual([
        { sourceName: 'community-later', enabled: false },
      ]);
    });

    it('seeds an optioned local source disabled for existing projects', async () => {
      const project = await createProject(
        'Project Local First',
        '/tmp/source-project-enabled-local',
      );

      await service.createLocalSkillSource(
        {
          name: 'local-later',
          folderPath: '/tmp/local-later',
        },
        { existingProjects: { mode: 'none' } },
      );

      await expect(service.listSourceProjectEnabled(project.id)).resolves.toEqual([
        { sourceName: 'local-later', enabled: false },
      ]);
    });

    it('omitting the create option does not seed existing-project mappings', async () => {
      const project = await createProject('Project Raw Source', '/tmp/source-project-enabled-raw');

      await createCommunitySource('raw-community');

      await expect(service.listSourceProjectEnabled(project.id)).resolves.toEqual([]);
    });

    it('seeds managed sources as enabled when creating a new project', async () => {
      await createCommunitySource('community-one');
      await createCommunitySource('community-two');
      await service.createLocalSkillSource({
        name: 'local-one',
        folderPath: '/tmp/local-one',
      });

      const project = await createProject('Project Seeded', '/tmp/source-project-enabled-seeded');

      await expect(service.listSourceProjectEnabled(project.id)).resolves.toEqual([
        { sourceName: 'community-one', enabled: true },
        { sourceName: 'community-two', enabled: true },
        { sourceName: 'local-one', enabled: true },
      ]);
    });

    it('does not seed built-in sources when creating a new project', async () => {
      const project = await createProject('Project Builtin', '/tmp/source-project-enabled-builtin');

      await expect(service.listSourceProjectEnabled(project.id)).resolves.toEqual([]);
    });

    it('seeds community sources as enabled when creating a project from template', async () => {
      await createCommunitySource('template-source');

      const project = await service.createProjectShell({
        name: 'Project From Template',
        description: null,
        rootPath: '/tmp/source-project-enabled-template',
        isTemplate: false,
      });

      await expect(service.listSourceProjectEnabled(project.id)).resolves.toEqual([
        { sourceName: 'template-source', enabled: true },
      ]);
    });

    it('uses provided projectId when creating a project from template', async () => {
      const deterministicProjectId = '11111111-1111-4111-8111-111111111111';

      const project = await service.createProjectShell(
        {
          name: 'Deterministic Project',
          description: null,
          rootPath: '/tmp/source-project-enabled-deterministic',
          isTemplate: false,
        },
        {
          projectId: deterministicProjectId,
        },
      );

      expect(project.id).toBe(deterministicProjectId);
    });

    it('throws ConflictError when provided projectId already exists', async () => {
      const deterministicProjectId = '22222222-2222-4222-8222-222222222222';
      const now = new Date().toISOString();

      sqlite
        .prepare(
          `
          INSERT INTO projects (id, name, description, root_path, is_template, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          deterministicProjectId,
          'Existing Project',
          null,
          '/tmp/source-project-enabled-deterministic-existing',
          0,
          now,
          now,
        );

      // A client-supplied projectId colliding with an existing row must surface as a domain
      // ConflictError (409), not a raw SQLite unique-constraint error — preserving the mapping the
      // create-core delegate provided before the pipeline cutover.
      const duplicateAttempt = await service
        .createProjectShell(
          {
            name: 'Second Project',
            description: null,
            rootPath: '/tmp/source-project-enabled-deterministic-second',
            isTemplate: false,
          },
          {
            projectId: deterministicProjectId,
          },
        )
        .then(() => null)
        .catch((error: unknown) => error);

      expect(duplicateAttempt).toBeInstanceOf(ConflictError);
      expect((duplicateAttempt as ConflictError).message).toBe(
        `Project ID "${deterministicProjectId}" already exists.`,
      );
      expect((duplicateAttempt as ConflictError).details).toMatchObject({
        field: 'projectId',
        projectId: deterministicProjectId,
      });

      // The pre-existing row is untouched and no second row was inserted.
      const row = sqlite
        .prepare('SELECT COUNT(*) as count FROM projects WHERE id = ?')
        .get(deterministicProjectId) as { count: number };
      expect(row.count).toBe(1);
    });

    it('enforces project foreign key cascade on project deletion', async () => {
      const project = await createProject('Project E', '/tmp/source-project-enabled-e');

      await service.setSourceProjectEnabled(project.id, 'openai', false);
      await service.deleteProject(project.id);

      const row = sqlite
        .prepare('SELECT COUNT(*) as count FROM source_project_enabled WHERE project_id = ?')
        .get(project.id) as { count: number };
      expect(row.count).toBe(0);
    });

    it('validates required projectId/sourceName inputs', async () => {
      await expect(service.setSourceProjectEnabled(' ', 'openai', true)).rejects.toThrow(
        ValidationError,
      );
      await expect(service.setSourceProjectEnabled('project-id', ' ', true)).rejects.toThrow(
        ValidationError,
      );
    });
  });
});
