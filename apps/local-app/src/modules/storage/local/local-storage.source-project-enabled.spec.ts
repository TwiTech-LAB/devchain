import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { ValidationError } from '../../../common/errors/error-types';
import { LocalStorageService } from './local-storage.service';

describe('LocalStorageService - source_project_enabled integration', () => {
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

  it('seeds disabled rows in bulk and skips existing rows', async () => {
    const project = await createProject('Project B', '/tmp/source-project-enabled-b');

    await service.setSourceProjectEnabled(project.id, 'openai', true);
    await service.seedSourceProjectDisabled(project.id, [' openai ', 'anthropic', 'anthropic', '']);

    await expect(service.listSourceProjectEnabled(project.id)).resolves.toEqual([
      { sourceName: 'anthropic', enabled: false },
      { sourceName: 'openai', enabled: true },
    ]);
  });

  it('seeds community sources as disabled when creating a new project', async () => {
    await createCommunitySource('community-one');
    await createCommunitySource('community-two');

    const project = await createProject('Project Seeded', '/tmp/source-project-enabled-seeded');

    await expect(service.listSourceProjectEnabled(project.id)).resolves.toEqual([
      { sourceName: 'community-one', enabled: false },
      { sourceName: 'community-two', enabled: false },
    ]);
  });

  it('does not seed built-in sources when creating a new project', async () => {
    const project = await createProject('Project Builtin', '/tmp/source-project-enabled-builtin');

    await expect(service.listSourceProjectEnabled(project.id)).resolves.toEqual([]);
  });

  it('seeds community sources as disabled when creating a project from template', async () => {
    await createCommunitySource('template-source');

    const result = await service.createProjectWithTemplate(
      {
        name: 'Project From Template',
        description: null,
        rootPath: '/tmp/source-project-enabled-template',
        isTemplate: false,
      },
      {
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [{ label: 'Todo', color: '#6c757d', position: 0 }],
        initialPrompt: null,
      },
    );

    await expect(service.listSourceProjectEnabled(result.project.id)).resolves.toEqual([
      { sourceName: 'template-source', enabled: false },
    ]);
  });

  it('deletes rows by source name across projects', async () => {
    const projectA = await createProject('Project C', '/tmp/source-project-enabled-c');
    const projectB = await createProject('Project D', '/tmp/source-project-enabled-d');

    await service.setSourceProjectEnabled(projectA.id, 'openai', false);
    await service.setSourceProjectEnabled(projectA.id, 'anthropic', true);
    await service.setSourceProjectEnabled(projectB.id, 'openai', true);

    await service.deleteSourceProjectEnabledBySource(' OPENAI ');

    await expect(service.listSourceProjectEnabled(projectA.id)).resolves.toEqual([
      { sourceName: 'anthropic', enabled: true },
    ]);
    await expect(service.listSourceProjectEnabled(projectB.id)).resolves.toEqual([]);
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
