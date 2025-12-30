import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { setupTestDb, teardownTestDb } from './helpers/test-db';

process.env.SKIP_PREFLIGHT = '1';

describe('Export/Import Round-Trip (E2E)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    setupTestDb();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    teardownTestDb();
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

  async function createProjectFromTemplate(name: string, rootPath: string, templateId = 'empty-project') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/from-template',
      payload: { name, description: null, rootPath, templateId },
    });
    expect([200, 201]).toContain(res.statusCode);
    const body = JSON.parse(res.payload);
    return body.project;
  }

  it('dryRun import returns missingProviders when provider not installed', async () => {
    const target = await createProjectFromTemplate('Target Project', '/tmp/target', 'empty-project');

    const dryRun = await app.inject({
      method: 'POST',
      url: `/api/projects/${target.id}/import?dryRun=true`,
      payload: {
        version: 1,
        profiles: [
          {
            name: 'Some Profile',
            provider: { name: 'openai' },
            instructions: null,
            options: null,
            temperature: null,
            maxTokens: null,
          },
        ],
      },
    });
    expect([200, 201]).toContain(dryRun.statusCode);
    const body = JSON.parse(dryRun.payload);
    expect(body.dryRun).toBe(true);
    expect(body.missingProviders).toContain('openai');
  });

  it('exports from Project A and imports into Project B (round-trip)', async () => {
    // Ensure provider exists
    const provider = await createProvider('claude');

    // Create source project and seed entities
    const source = await createProjectFromTemplate('Source Project', '/tmp/source', 'empty-project');

    // Create prompt in source
    const pRes = await app.inject({
      method: 'POST',
      url: '/api/prompts',
      payload: { projectId: source.id, title: 'Init Prompt', content: 'Hello', tags: ['seed'] },
    });
    expect([200, 201]).toContain(pRes.statusCode);
    const prompt = JSON.parse(pRes.payload);

    // Create profile in source (with provider)
    const profRes = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: {
        projectId: source.id,
        name: 'Runner',
        providerId: provider.id,
        options: '--model claude-3-5-sonnet',
        systemPrompt: null,
        instructions: 'do work',
        temperature: 0.1,
        maxTokens: 1000,
      },
    });
    expect([200, 201]).toContain(profRes.statusCode);
    const profile = JSON.parse(profRes.payload);

    // Create agent in source
    const agentRes = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { projectId: source.id, profileId: profile.id, name: 'CC2' },
    });
    expect([200, 201]).toContain(agentRes.statusCode);

    // Set per-project initial prompt mapping
    const settingsRes = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { projectId: source.id, initialSessionPromptId: prompt.id },
    });
    expect([200, 201]).toContain(settingsRes.statusCode);

    // Export from source
    const exportRes = await app.inject({ method: 'GET', url: `/api/projects/${source.id}/export` });
    expect(exportRes.statusCode).toBe(200);
    const exportPayload = JSON.parse(exportRes.payload);
    expect(Array.isArray(exportPayload.prompts)).toBe(true);
    expect(Array.isArray(exportPayload.profiles)).toBe(true);
    expect(Array.isArray(exportPayload.agents)).toBe(true);
    expect(Array.isArray(exportPayload.statuses)).toBe(true);
    expect(exportPayload.initialPrompt?.title).toBe('Init Prompt');

    // Create target project and import
    const target = await createProjectFromTemplate('Target Project 2', '/tmp/target2', 'empty-project');

    const dry = await app.inject({
      method: 'POST',
      url: `/api/projects/${target.id}/import?dryRun=true`,
      payload: exportPayload,
    });
    expect([200, 201]).toContain(dry.statusCode);
    const dryBody = JSON.parse(dry.payload);
    expect(dryBody.missingProviders).toEqual([]);

    const importRes = await app.inject({
      method: 'POST',
      url: `/api/projects/${target.id}/import`,
      payload: exportPayload,
    });
    expect([200, 201]).toContain(importRes.statusCode);
    const importBody = JSON.parse(importRes.payload);
    expect(importBody.success).toBe(true);
    expect(importBody.counts.imported.prompts).toBe(exportPayload.prompts.length);
    expect(importBody.counts.imported.profiles).toBe(exportPayload.profiles.length);
    expect(importBody.counts.imported.agents).toBe(exportPayload.agents.length);
    expect(importBody.counts.imported.statuses).toBe(exportPayload.statuses.length);

    // Verify target export reflects imported data and initial prompt mapping
    const verifyRes = await app.inject({ method: 'GET', url: `/api/projects/${target.id}/export` });
    expect(verifyRes.statusCode).toBe(200);
    const verify = JSON.parse(verifyRes.payload);
    expect(verify.prompts.length).toBe(exportPayload.prompts.length);
    expect(verify.profiles.length).toBe(exportPayload.profiles.length);
    expect(verify.agents.length).toBe(exportPayload.agents.length);
    expect(verify.statuses.length).toBe(exportPayload.statuses.length);
    expect(verify.initialPrompt?.title).toBe('Init Prompt');
  });
});
