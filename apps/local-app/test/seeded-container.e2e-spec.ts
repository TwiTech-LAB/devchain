jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');

  return {
    ...actual,
    execFile: (...callArgs: unknown[]) => {
      const file = callArgs[0];
      const callback = callArgs.find((arg) => typeof arg === 'function') as
        | ((error: Error | null, stdout: string, stderr: string) => void)
        | undefined;

      if (file === 'tmux' && callback) {
        callback(null, 'tmux 3.4', '');
        return undefined;
      }

      return (actual.execFile as (...args: unknown[]) => unknown)(...callArgs);
    },
  };
});

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { resetEnvConfig } from '../src/common/config/env.config';
import { SeedPreparationService } from '../src/modules/orchestrator/docker/services/seed-preparation.service';

process.env.SKIP_PREFLIGHT = '1';

const SEEDED_HOST_PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SEEDED_CONTAINER_PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const SEEDED_PROVIDER_ID = '33333333-3333-4333-8333-333333333333';
const SEEDED_PROFILE_ID = '44444444-4444-4444-8444-444444444444';
const SEEDED_PROFILE_CONFIG_ID = '55555555-5555-4555-8555-555555555555';
const SEEDED_SOURCE_ID = '66666666-6666-4666-8666-666666666666';
const SEEDED_SKILL_ID = '77777777-7777-4777-8777-777777777777';

describe('Seeded container integration verification (E2E)', () => {
  let app: NestFastifyApplication;
  let tmpRoot: string;
  let hostHome: string;
  let containerHome: string;
  let hostDataPath: string;
  let containerDataPath: string;
  let seededOtherProjectId: string;
  let scopedProjectId: string;
  let previousEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    previousEnv = {
      HOME: process.env.HOME,
      DB_PATH: process.env.DB_PATH,
      DB_FILENAME: process.env.DB_FILENAME,
      DEVCHAIN_MODE: process.env.DEVCHAIN_MODE,
      CONTAINER_PROJECT_ID: process.env.CONTAINER_PROJECT_ID,
      LOG_LEVEL: process.env.LOG_LEVEL,
    };

    tmpRoot = join(tmpdir(), `devchain-seeded-e2e-${Date.now()}`);
    hostHome = join(tmpRoot, 'host-home');
    containerHome = join(tmpRoot, 'container-home');
    hostDataPath = join(hostHome, '.devchain');
    containerDataPath = join(containerHome, '.devchain');

    mkdirSync(hostDataPath, { recursive: true });
    mkdirSync(containerDataPath, { recursive: true });

    prepareHostSkills(hostDataPath);
    seedHostDatabase({
      hostDbPath: join(hostDataPath, 'devchain.db'),
      containerHome,
    });
    seededOtherProjectId = SEEDED_HOST_PROJECT_ID;

    process.env.HOME = hostHome;
    process.env.DB_PATH = hostDataPath;
    delete process.env.DB_FILENAME;
    process.env.LOG_LEVEL = 'silent';
    delete process.env.CONTAINER_PROJECT_ID;
    process.env.DEVCHAIN_MODE = 'normal';
    resetEnvConfig();

    const seedPreparationService = new SeedPreparationService();
    await seedPreparationService.prepareSeedData(containerDataPath);
    expect(existsSync(join(containerDataPath, 'devchain.db'))).toBe(true);

    process.env.HOME = containerHome;
    process.env.DB_PATH = containerDataPath;
    delete process.env.DB_FILENAME;
    delete process.env.CONTAINER_PROJECT_ID;
    process.env.DEVCHAIN_MODE = 'normal';
    resetEnvConfig();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();

    rmSync(tmpRoot, { recursive: true, force: true });

    restoreEnv(previousEnv);
    resetEnvConfig();
  });

  it('verifies seeded data, project scoping, and writable skills sync flow', async () => {
    const readyRes = await app.inject({
      method: 'GET',
      url: '/health/ready',
    });
    expect(readyRes.statusCode).toBe(200);
    expect(JSON.parse(readyRes.payload)).toEqual({
      ready: true,
      checks: {
        db: 'ok',
        tmux: 'ok',
      },
    });

    const settingsRes = await app.inject({
      method: 'GET',
      url: '/api/settings',
    });
    expect(settingsRes.statusCode).toBe(200);
    const settings = JSON.parse(settingsRes.payload) as {
      registry?: { url?: string };
      terminal?: { scrollbackLines?: number; inputMode?: string };
    };
    expect(settings.registry?.url).toBe('https://registry.seeded.devchain.local');
    expect(settings.terminal?.scrollbackLines).toBe(4200);
    expect(settings.terminal?.inputMode).toBe('form');

    const seededSkillPath = join(
      containerDataPath,
      'skills',
      'seeded-local',
      'existing-skill',
      'SKILL.md',
    );
    expect(existsSync(seededSkillPath)).toBe(true);

    const sourcesRes = await app.inject({
      method: 'GET',
      url: '/api/skills/sources',
    });
    expect(sourcesRes.statusCode).toBe(200);
    const sources = JSON.parse(sourcesRes.payload) as Array<{
      name: string;
      kind: string;
      skillCount: number;
    }>;
    const seededSource = sources.find((source) => source.name === 'seeded-local');
    expect(seededSource).toBeDefined();
    expect(seededSource?.kind).toBe('local');
    expect(seededSource?.skillCount).toBeGreaterThanOrEqual(1);

    const skillsRes = await app.inject({
      method: 'GET',
      url: '/api/skills?source=seeded-local',
    });
    expect(skillsRes.statusCode).toBe(200);
    const seededSkills = JSON.parse(skillsRes.payload) as Array<{ slug: string }>;
    expect(seededSkills.some((skill) => skill.slug === 'seeded-local/existing-skill')).toBe(true);

    const profileConfigsRes = await app.inject({
      method: 'GET',
      url: `/api/profiles/${SEEDED_PROFILE_ID}/provider-configs`,
    });
    expect(profileConfigsRes.statusCode).toBe(200);
    const profileConfigs = JSON.parse(profileConfigsRes.payload) as Array<{
      id: string;
      providerId: string;
      name: string;
    }>;
    expect(profileConfigs).toHaveLength(1);
    expect(profileConfigs[0]).toMatchObject({
      id: SEEDED_PROFILE_CONFIG_ID,
      providerId: SEEDED_PROVIDER_ID,
      name: 'Seeded Anthropic Config',
    });

    const templateRootPath = join(tmpRoot, 'template-created-project');
    const templateFilePath = join(tmpRoot, 'seeded-template.json');
    writeFileSync(
      templateFilePath,
      JSON.stringify(
        {
          version: 1,
          prompts: [],
          profiles: [],
          agents: [],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
          _manifest: {
            name: 'Seeded Template',
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
    const createProjectRes = await app.inject({
      method: 'POST',
      url: '/api/projects/from-template',
      payload: {
        name: 'Scoped Container Project',
        rootPath: templateRootPath,
        templatePath: templateFilePath,
      },
    });
    expect(createProjectRes.statusCode).toBe(201);
    const createdProjectPayload = JSON.parse(createProjectRes.payload) as {
      project: { id: string; name: string };
    };
    scopedProjectId = createdProjectPayload.project.id;
    expect(createdProjectPayload.project.name).toBe('Scoped Container Project');

    const localSourceRoot = join(tmpRoot, 'local-source');
    const localSkillDir = join(localSourceRoot, 'skills', 'fresh-skill');
    mkdirSync(localSkillDir, { recursive: true });
    writeFileSync(
      join(localSkillDir, 'SKILL.md'),
      [
        '---',
        'name: Fresh Skill',
        'description: A synced skill from local source',
        '---',
        '',
        '# Fresh Skill',
        '',
        'Use this for seeded integration verification.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const createLocalSourceRes = await app.inject({
      method: 'POST',
      url: '/api/skills/local-sources',
      payload: {
        name: 'dynamic-local',
        folderPath: localSourceRoot,
      },
    });
    expect(createLocalSourceRes.statusCode).toBe(201);

    const syncRes = await app.inject({
      method: 'POST',
      url: '/api/skills/sync',
      payload: {
        sourceName: 'dynamic-local',
      },
    });
    expect(syncRes.statusCode).toBe(200);
    const syncPayload = JSON.parse(syncRes.payload) as {
      status: string;
      failed: number;
      errors: unknown[];
    };
    expect(syncPayload.status).toBe('completed');
    expect(syncPayload.failed).toBe(0);
    expect(syncPayload.errors).toHaveLength(0);

    const dynamicSkillsRes = await app.inject({
      method: 'GET',
      url: '/api/skills?source=dynamic-local',
    });
    expect(dynamicSkillsRes.statusCode).toBe(200);
    const dynamicSkills = JSON.parse(dynamicSkillsRes.payload) as Array<{
      slug: string;
      contentPath: string | null;
    }>;
    const freshSkill = dynamicSkills.find((skill) => skill.slug === 'dynamic-local/fresh-skill');
    expect(freshSkill).toBeDefined();
    expect(freshSkill?.contentPath).toBeTruthy();
    expect(existsSync(join(freshSkill!.contentPath!, 'SKILL.md'))).toBe(true);

    process.env.CONTAINER_PROJECT_ID = scopedProjectId;
    resetEnvConfig();

    const scopedProjectsRes = await app.inject({
      method: 'GET',
      url: '/api/projects',
    });
    expect(scopedProjectsRes.statusCode).toBe(200);
    const scopedProjects = JSON.parse(scopedProjectsRes.payload) as {
      total: number;
      items: Array<{ id: string; name: string }>;
    };
    expect(scopedProjects.total).toBe(1);
    expect(scopedProjects.items).toHaveLength(1);
    expect(scopedProjects.items[0].id).toBe(scopedProjectId);
    expect(scopedProjects.items[0].name).toBe('Scoped Container Project');

    const blockedUpdateRes = await app.inject({
      method: 'PUT',
      url: `/api/projects/${seededOtherProjectId}`,
      payload: {
        name: 'Forbidden rename',
      },
    });
    expect(blockedUpdateRes.statusCode).toBe(403);
    expect(blockedUpdateRes.payload).toContain('CONTAINER_PROJECT_ID');

    const blockedDeleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${seededOtherProjectId}`,
    });
    expect(blockedDeleteRes.statusCode).toBe(403);
    expect(blockedDeleteRes.payload).toContain('CONTAINER_PROJECT_ID');
  });
});

function prepareHostSkills(hostDataPath: string): void {
  const hostSeededSkillDir = join(hostDataPath, 'skills', 'seeded-local', 'existing-skill');
  mkdirSync(hostSeededSkillDir, { recursive: true });

  writeFileSync(
    join(hostSeededSkillDir, 'SKILL.md'),
    [
      '---',
      'name: Existing Skill',
      'description: Pre-seeded host skill',
      '---',
      '',
      '# Existing Skill',
      '',
      'This skill was copied from host seed data.',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function seedHostDatabase({
  hostDbPath,
  containerHome,
}: {
  hostDbPath: string;
  containerHome: string;
}): void {
  const sqlite = new Database(hostDbPath);
  const db = drizzle(sqlite);

  sqlite.pragma('foreign_keys = OFF');
  migrate(db, { migrationsFolder: resolveMigrationsFolder() });
  sqlite.pragma('foreign_keys = ON');

  const now = new Date().toISOString();

  sqlite
    .prepare(
      `INSERT INTO projects (id, name, description, root_path, is_template, is_private, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      SEEDED_HOST_PROJECT_ID,
      'Seeded Host Project',
      'Represents an existing host project',
      '/tmp/seeded-host-project',
      0,
      0,
      now,
      now,
    );

  sqlite
    .prepare(
      `INSERT INTO projects (id, name, description, root_path, is_template, is_private, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      SEEDED_CONTAINER_PROJECT_ID,
      'Seeded Existing Container Project',
      'Project copied from host DB before new project creation',
      '/tmp/seeded-container-project',
      0,
      0,
      now,
      now,
    );

  sqlite
    .prepare(
      `INSERT INTO providers (id, name, bin_path, mcp_configured, mcp_endpoint, mcp_registered_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(SEEDED_PROVIDER_ID, 'anthropic', null, 0, null, null, now, now);

  sqlite
    .prepare(
      `INSERT INTO agent_profiles (id, project_id, name, family_slug, system_prompt, instructions, temperature, max_tokens, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      SEEDED_PROFILE_ID,
      SEEDED_CONTAINER_PROJECT_ID,
      'Seeded Profile',
      null,
      null,
      'Use seeded profile instructions',
      null,
      null,
      now,
      now,
    );

  sqlite
    .prepare(
      `INSERT INTO profile_provider_configs (id, profile_id, provider_id, name, options, env, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      SEEDED_PROFILE_CONFIG_ID,
      SEEDED_PROFILE_ID,
      SEEDED_PROVIDER_ID,
      'Seeded Anthropic Config',
      JSON.stringify({ model: 'claude-3-7-sonnet' }),
      JSON.stringify({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }),
      0,
      now,
      now,
    );

  sqlite
    .prepare(
      `INSERT INTO local_skill_sources (id, name, folder_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(SEEDED_SOURCE_ID, 'seeded-local', '/tmp/seeded-local-source', now, now);

  sqlite
    .prepare(
      `INSERT INTO skills (
        id, slug, name, display_name, description, short_description, source, source_url, source_commit,
        category, license, compatibility, frontmatter, instruction_content, content_path, resources,
        status, last_synced_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      SEEDED_SKILL_ID,
      'seeded-local/existing-skill',
      'existing-skill',
      'Existing Skill',
      'Existing seeded skill',
      'Seeded',
      'seeded-local',
      'file:///tmp/seeded-local-source/skills/existing-skill',
      'seeded-commit',
      'development',
      'MIT',
      null,
      JSON.stringify({ name: 'Existing Skill' }),
      'Existing seeded skill instructions',
      join(containerHome, '.devchain', 'skills', 'seeded-local', 'existing-skill'),
      JSON.stringify([]),
      'available',
      now,
      now,
      now,
    );

  sqlite
    .prepare(
      `INSERT INTO settings (id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      '88888888-8888-4888-8888-888888888888',
      'registry.url',
      JSON.stringify('https://registry.seeded.devchain.local'),
      now,
      now,
    );
  sqlite
    .prepare(
      `INSERT INTO settings (id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      '99999999-9999-4999-8999-999999999999',
      'terminal.scrollback.lines',
      '4200',
      now,
      now,
    );
  sqlite
    .prepare(
      `INSERT INTO settings (id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'terminal.inputMode',
      JSON.stringify('form'),
      now,
      now,
    );
  sqlite
    .prepare(
      `INSERT INTO settings (id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'skills.syncOnStartup',
      'false',
      now,
      now,
    );

  sqlite.close();
}

function resolveMigrationsFolder(): string {
  const possiblePaths = [join(process.cwd(), 'drizzle'), join(process.cwd(), 'apps/local-app/drizzle')];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  throw new Error('Unable to locate drizzle migrations for seeded container E2E test');
}

function restoreEnv(previousEnv: Record<string, string | undefined>): void {
  const envKeys = Object.keys(previousEnv);
  for (const key of envKeys) {
    const previousValue = previousEnv[key];
    if (previousValue === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = previousValue;
  }
}
