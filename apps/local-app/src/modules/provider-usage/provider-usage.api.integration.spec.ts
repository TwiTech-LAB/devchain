import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type Database from 'better-sqlite3';
import type { ProviderUsageResponse } from '@devchain/shared';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { EventsService } from '../events/services/events.service';
import { SettingsService } from '../settings/services/settings.service';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { LocalStorageService } from '../storage/local/local-storage.service';
import { SessionRowStore } from '../storage/sessions/session-row.store';
import { ProviderUsageController } from './controllers/provider-usage.controller';
import { PROVIDER_USAGE_CHECKERS } from './provider-usage.types';
import { ProviderUsageAccountsService } from './services/provider-usage-accounts.service';
import { ProviderUsageService } from './services/provider-usage.service';

// Layer: backend API integration over the real migrated schema. The project's
// accounts come from agents, profile configs and project-scoped provider env rows,
// so only real storage proves the scoping, the dedupe and the order end to end.
const FAKE_TOKEN = 'sk-ant-oat01-FAKE-TOKEN-VALUE';
const HOME = '/home/dev';
const ACCOUNT_ENV_KEYS = [
  'HOME',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_BASE_URL',
];

describe('Provider usage API', () => {
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let moduleRef: TestingModule;
  let app: NestFastifyApplication;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of ACCOUNT_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.HOME = HOME;

    const database = createTestDatabase();
    sqlite = database.sqlite;
    storage = new LocalStorageService(database.db);
    moduleRef = await Test.createTestingModule({
      controllers: [ProviderUsageController],
      providers: [
        ProviderUsageService,
        ProviderUsageAccountsService,
        { provide: STORAGE_SERVICE, useValue: storage },
        {
          provide: SettingsService,
          useValue: new SettingsService(database.db, new EventEmitter2()),
        },
        { provide: SessionRowStore, useValue: new SessionRowStore(database.db) },
        { provide: EventsService, useValue: { publish: jest.fn().mockResolvedValue(null) } },
        { provide: PROVIDER_USAGE_CHECKERS, useValue: [] },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    await moduleRef.close();
    sqlite.close();
    for (const key of ACCOUNT_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  async function seed() {
    const projectA = await storage.createProject(projectInput('A'));
    const projectB = await storage.createProject(projectInput('B'));
    const claude = await storage.createProvider({ name: 'claude', binPath: '/usr/bin/claude' });
    await storage.updateProviderWithScopes(
      claude.id,
      { env: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN } },
      { CLAUDE_CODE_OAUTH_TOKEN: [projectB.id] },
      ['CLAUDE_CODE_OAUTH_TOKEN'],
    );
    const codex = await storage.createProvider({ name: 'codex' });
    const agy = await storage.createProvider({ name: 'agy' });
    const opencode = await storage.createProvider({ name: 'opencode' });
    const profileA = await storage.createAgentProfile({ name: 'Coder', projectId: projectA.id });
    const profileB = await storage.createAgentProfile({ name: 'Coder', projectId: projectB.id });
    const config = (
      profileId: string,
      name: string,
      providerId: string,
      env: Record<string, string> | null = null,
    ) => storage.createProfileProviderConfig({ profileId, providerId, name, options: null, env });
    const agent = async (
      projectId: string,
      profileId: string,
      name: string,
      configName: string,
      providerId: string,
      env: Record<string, string> | null = null,
    ) => {
      const { id } = await config(profileId, configName, providerId, env);
      return storage.createAgent({ projectId, profileId, providerConfigId: id, name });
    };
    const claudeA = await config(profileA.id, 'claude', claude.id);
    await agent(projectA.id, profileA.id, 'agy', 'agy', agy.id);
    await agent(projectA.id, profileA.id, 'codex', 'codex', codex.id);
    for (const name of ['claude-1', 'claude-2']) {
      await storage.createAgent({
        projectId: projectA.id,
        profileId: profileA.id,
        providerConfigId: claudeA.id,
        name,
      });
    }
    await agent(projectA.id, profileA.id, 'claude-second', 'claude-second', claude.id, {
      CLAUDE_CONFIG_DIR: '/data/second',
    });
    await agent(projectA.id, profileA.id, 'opencode', 'opencode', opencode.id);
    await agent(projectB.id, profileB.id, 'claude', 'claude', claude.id);
    return { projectA, projectB };
  }

  async function getUsage(query: string) {
    return app.inject({ method: 'GET', url: `/api/provider-usage?${query}` });
  }

  it('returns one entry per account of the project, ordered claude, codex, agy', async () => {
    const { projectA } = await seed();

    const response = await getUsage(`projectId=${projectA.id}&maxAgeSec=60`);

    expect(response.statusCode).toBe(200);
    const body = response.json<ProviderUsageResponse>();
    expect(body.accounts.map((a) => a.accountKey)).toEqual([
      `claude:login:${HOME}/.claude`,
      'claude:login:/data/second',
      `codex:${HOME}/.codex:none`,
      `agy:${HOME}`,
    ]);
    expect(body.accounts.every((a) => a.state === 'unsupported')).toBe(true);
  });

  it('uses the scoped token only in its own project and never returns the token', async () => {
    const { projectB } = await seed();

    const response = await getUsage(`projectId=${projectB.id}`);

    const body = response.json<ProviderUsageResponse>();
    expect(body.accounts.map((a) => a.accountKey)).toEqual([
      expect.stringMatching(/^claude:token:[0-9a-f]{12}$/),
    ]);
    expect(response.body).not.toContain(FAKE_TOKEN);
  });

  it.each([
    ['a missing projectId', '', 400],
    ['a maxAgeSec under the minimum', 'projectId=p&maxAgeSec=1', 400],
    ['an unknown project', 'projectId=unknown-project', 404],
  ])('rejects %s', async (_case, query, status) => {
    expect((await getUsage(query)).statusCode).toBe(status);
  });
});

function projectInput(name: string) {
  return { name, description: null, rootPath: `/tmp/${name}`, isTemplate: false };
}
