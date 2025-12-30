import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestDb, teardownTestDb, resetTestDb } from './helpers/test-db';
import { resetEnvConfig } from '../src/common/config/env.config';

process.env.SKIP_PREFLIGHT = '1';

describe('Create Project from Template (E2E)', () => {
  let app: NestFastifyApplication;
  let templatesDir: string;
  let previousTemplatesDir: string | undefined;

  beforeAll(async () => {
    setupTestDb();

    previousTemplatesDir = process.env.TEMPLATES_DIR;
    templatesDir = mkdtempSync(join(tmpdir(), 'devchain-templates-'));
    process.env.TEMPLATES_DIR = templatesDir;
    resetEnvConfig();

    // A deterministic set of templates for this suite.
    // - test-rollback-template: valid schema but fails during agent creation (missing profile mapping)
    // - test-success-template: minimal valid template with a resolvable provider
    // - test-missing-provider-template: requires a provider name that won't exist
    writeFileSync(
      join(templatesDir, 'test-rollback-template.json'),
      JSON.stringify(
        {
          version: 1,
          prompts: [],
          profiles: [],
          agents: [
            {
              name: 'Rollback Agent',
              profileId: '11111111-1111-1111-1111-111111111111',
              description: 'References a missing profileId to force rollback',
            },
          ],
          statuses: [{ label: 'Proposed', color: '#6c757d', position: 0 }],
        },
        null,
        2,
      ),
      'utf-8',
    );

    writeFileSync(
      join(templatesDir, 'test-success-template.json'),
      JSON.stringify(
        {
          version: 1,
          prompts: [{ title: 'Welcome', content: 'Hello', tags: [] }],
          profiles: [
            {
              id: '22222222-2222-2222-2222-222222222222',
              name: 'Default Profile',
              provider: { name: 'anthropic' },
              options: null,
              instructions: null,
              temperature: null,
              maxTokens: null,
            },
          ],
          agents: [
            {
              id: '44444444-4444-4444-4444-444444444444',
              name: 'Default Agent',
              profileId: '22222222-2222-2222-2222-222222222222',
              description: null,
            },
          ],
          statuses: [
            { label: 'To Do', color: '#3b82f6', position: 0 },
            { label: 'Done', color: '#10b981', position: 1 },
          ],
          watchers: [
            {
              name: 'Test Watcher All Scope',
              description: 'Watcher with scope: all',
              enabled: false, // Disabled to avoid poller flakiness
              scope: 'all',
              scopeFilterName: null,
              pollIntervalMs: 5000,
              viewportLines: 100,
              condition: { type: 'contains', pattern: 'test-pattern' },
              cooldownMs: 10000,
              cooldownMode: 'time',
              eventName: 'test-event-all',
            },
            {
              name: 'Test Watcher Agent Scope',
              description: 'Watcher with scope: agent',
              enabled: false,
              scope: 'agent',
              scopeFilterName: 'Default Agent', // Should resolve to created agent
              pollIntervalMs: 5000,
              viewportLines: 100,
              condition: { type: 'contains', pattern: 'agent-pattern' },
              cooldownMs: 10000,
              cooldownMode: 'time',
              eventName: 'test-event-agent',
            },
            {
              name: 'Test Watcher Profile Scope',
              description: 'Watcher with scope: profile',
              enabled: false,
              scope: 'profile',
              scopeFilterName: 'Default Profile', // Should resolve to created profile
              pollIntervalMs: 5000,
              viewportLines: 100,
              condition: { type: 'regex', pattern: 'profile-.*' },
              cooldownMs: 10000,
              cooldownMode: 'until_clear',
              eventName: 'test-event-profile',
            },
          ],
          subscribers: [
            {
              name: 'Test Subscriber',
              description: 'Test subscriber for template creation',
              enabled: false,
              eventName: 'test-event-all',
              eventFilter: null,
              actionType: 'webhook',
              actionInputs: {
                url: { source: 'custom', customValue: 'https://example.com/webhook' },
              },
              delayMs: 0,
              cooldownMs: 5000,
              retryOnError: false,
              groupName: null,
              position: 0,
              priority: 0,
            },
            {
              name: 'Test Subscriber 2',
              description: 'Second test subscriber',
              enabled: false,
              eventName: 'test-event-agent',
              eventFilter: { field: 'status', operator: 'equals', value: 'active' },
              actionType: 'webhook',
              actionInputs: {
                url: { source: 'custom', customValue: 'https://example.com/webhook2' },
              },
              delayMs: 1000,
              cooldownMs: 10000,
              retryOnError: true,
              groupName: 'test-group',
              position: 1,
              priority: 10,
            },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    );

    writeFileSync(
      join(templatesDir, 'test-missing-provider-template.json'),
      JSON.stringify(
        {
          version: 1,
          prompts: [],
          profiles: [
            {
              id: '33333333-3333-3333-3333-333333333333',
              name: 'Needs Missing Provider',
              provider: { name: 'missing-provider' },
              options: null,
              instructions: null,
              temperature: null,
              maxTokens: null,
            },
          ],
          agents: [
            {
              name: 'Agent Needs Missing Provider',
              profileId: '33333333-3333-3333-3333-333333333333',
              description: null,
            },
          ],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        },
        null,
        2,
      ),
      'utf-8',
    );

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    teardownTestDb();
    if (templatesDir) {
      rmSync(templatesDir, { recursive: true, force: true });
    }
    if (previousTemplatesDir) {
      process.env.TEMPLATES_DIR = previousTemplatesDir;
    } else {
      delete process.env.TEMPLATES_DIR;
    }
    resetEnvConfig();
  });

  beforeEach(() => {
    resetTestDb();
  });

  async function createProvider(name: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: { name },
    });
    expect([200, 201]).toContain(res.statusCode);
    return JSON.parse(res.payload);
  }

  it('rolls back transaction when agent references missing profile (failure test)', async () => {
    // Setup: Create a provider so the precheck passes
    await createProvider('claude');

    // Get initial project count
    const beforeRes = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(beforeRes.statusCode).toBe(200);
    const beforeProjects = JSON.parse(beforeRes.payload);
    const beforeCount = beforeProjects.items?.length || 0;

    // Attempt to create project from test-rollback-template
    // This template has an agent that references a profileId not in the profiles array
    // This will cause the transaction to fail during agent creation
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/projects/from-template',
      payload: {
        name: 'Rollback Test Project',
        rootPath: '/tmp/rollback-test',
        templateId: 'test-rollback-template',
      },
    });

    // Expect 4xx/5xx error due to profile mapping failure
    // The error can be 400 (validation) or 500 (internal error during transaction)
    expect(createRes.statusCode).toBeGreaterThanOrEqual(400);
    const errorBody = JSON.parse(createRes.payload);
    // The error should mention profile mapping or be a validation error
    expect(errorBody.message || errorBody.statusCode).toBeDefined();

    // Get project count after failed attempt
    const afterRes = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(afterRes.statusCode).toBe(200);
    const afterProjects = JSON.parse(afterRes.payload);
    const afterCount = afterProjects.items?.length || 0;

    // Verify the project name doesn't exist in the list (primary rollback check)
    const projectNames = afterProjects.items?.map((p: any) => p.name) || [];
    expect(projectNames).not.toContain('Rollback Test Project');

    // Verify that no NEW project was created (transaction rolled back)
    expect(afterCount).toBe(beforeCount);
  });

  it('successfully creates project from template with all entities (success test)', async () => {
    // Setup: Create required provider
    await createProvider('anthropic');

    // Get initial project count
    const beforeRes = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(beforeRes.statusCode).toBe(200);
    const beforeProjects = JSON.parse(beforeRes.payload);
    const beforeCount = beforeProjects.items?.length || 0;

    // Create project from template
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/projects/from-template',
      payload: {
        name: 'Success Test Project',
        rootPath: '/tmp/success-test',
        description: 'Created from template for E2E test',
        templateId: 'test-success-template',
      },
    });

    expect(createRes.statusCode).toBe(201);
    const createBody = JSON.parse(createRes.payload);

    // Verify response structure
    expect(createBody.success).toBe(true);
    expect(createBody.project).toBeDefined();
    expect(createBody.project.id).toBeDefined();
    expect(createBody.project.name).toBe('Success Test Project');
    expect(createBody.project.rootPath).toBe('/tmp/success-test');

    // Verify imported counts
    expect(createBody.imported).toBeDefined();
    expect(createBody.imported.prompts).toBeGreaterThanOrEqual(0);
    expect(createBody.imported.profiles).toBeGreaterThanOrEqual(0);
    expect(createBody.imported.agents).toBeGreaterThanOrEqual(0);
    expect(createBody.imported.statuses).toBeGreaterThan(0); // Should have at least one status
    expect(createBody.imported.watchers).toBe(3); // 3 watchers in template
    expect(createBody.imported.subscribers).toBe(2); // 2 subscribers in template

    // Verify mappings exist
    expect(createBody.mappings).toBeDefined();
    expect(createBody.mappings.promptIdMap).toBeDefined();
    expect(createBody.mappings.profileIdMap).toBeDefined();
    expect(createBody.mappings.agentIdMap).toBeDefined();
    expect(createBody.mappings.statusIdMap).toBeDefined();

    // Verify project was actually created in the database
    const afterRes = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(afterRes.statusCode).toBe(200);
    const afterProjects = JSON.parse(afterRes.payload);
    const afterCount = afterProjects.items?.length || 0;
    expect(afterCount).toBe(beforeCount + 1);

    // Verify project exists by ID
    const getProjectRes = await app.inject({
      method: 'GET',
      url: `/api/projects/${createBody.project.id}`,
    });
    expect(getProjectRes.statusCode).toBe(200);
    const project = JSON.parse(getProjectRes.payload);
    expect(project.name).toBe('Success Test Project');

    // Verify entities were imported by exporting and checking counts
    const exportRes = await app.inject({
      method: 'GET',
      url: `/api/projects/${createBody.project.id}/export`,
    });
    expect(exportRes.statusCode).toBe(200);
    const exportData = JSON.parse(exportRes.payload);

    // Verify counts match what was reported during creation
    expect(exportData.prompts.length).toBe(createBody.imported.prompts);
    expect(exportData.profiles.length).toBe(createBody.imported.profiles);
    expect(exportData.agents.length).toBe(createBody.imported.agents);
    expect(exportData.statuses.length).toBe(createBody.imported.statuses);
    expect(exportData.watchers.length).toBe(createBody.imported.watchers);
    expect(exportData.subscribers.length).toBe(createBody.imported.subscribers);

    // Verify watcher scope resolution worked correctly
    // Export uses scopeFilterName (derived from scopeFilterId) for portability
    const agentScopeWatcher = exportData.watchers.find(
      (w: any) => w.eventName === 'test-event-agent',
    );
    expect(agentScopeWatcher).toBeDefined();
    expect(agentScopeWatcher.scope).toBe('agent');
    expect(agentScopeWatcher.scopeFilterName).toBe('Default Agent'); // Resolved correctly

    const profileScopeWatcher = exportData.watchers.find(
      (w: any) => w.eventName === 'test-event-profile',
    );
    expect(profileScopeWatcher).toBeDefined();
    expect(profileScopeWatcher.scope).toBe('profile');
    expect(profileScopeWatcher.scopeFilterName).toBe('Default Profile'); // Resolved correctly

    const allScopeWatcher = exportData.watchers.find(
      (w: any) => w.eventName === 'test-event-all',
    );
    expect(allScopeWatcher).toBeDefined();
    expect(allScopeWatcher.scope).toBe('all');
    expect(allScopeWatcher.scopeFilterName).toBeNull(); // scope: all has no filter

    // Verify subscribers were created with correct fields
    const subscriber1 = exportData.subscribers.find((s: any) => s.name === 'Test Subscriber');
    expect(subscriber1).toBeDefined();
    expect(subscriber1.eventName).toBe('test-event-all');
    expect(subscriber1.actionType).toBe('webhook');

    const subscriber2 = exportData.subscribers.find((s: any) => s.name === 'Test Subscriber 2');
    expect(subscriber2).toBeDefined();
    expect(subscriber2.eventName).toBe('test-event-agent');
    expect(subscriber2.groupName).toBe('test-group');
    expect(subscriber2.priority).toBe(10);

    // Verify initial prompt was set if specified
    if (createBody.initialPromptSet) {
      expect(exportData.initialPrompt).toBeDefined();
    }
  });

  it('returns 404 when template does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/from-template',
      payload: {
        name: 'Test Project',
        rootPath: '/tmp/test',
        templateId: 'nonexistent-template',
      },
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.payload);
    expect(String(body.message)).toMatch(/template.*not found/i);
  });

  it('returns 400 when required providers are missing', async () => {
    // Don't create any providers

    const templateId = 'test-missing-provider-template';

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/from-template',
      payload: {
        name: 'Missing Provider Test',
        rootPath: '/tmp/missing-provider',
        templateId,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.message).toContain('missing providers');
    const missingProviders = body.missingProviders ?? body.details?.missingProviders ?? [];
    expect(missingProviders).toContain('missing-provider');
  });
});
