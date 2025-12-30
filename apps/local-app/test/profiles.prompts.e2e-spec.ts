import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { setupTestDb, teardownTestDb, resetTestDb, seedTestData } from './helpers/test-db';

process.env.SKIP_PREFLIGHT = '1';

describe('Profiles API — prompt assignment E2E', () => {
  let app: NestFastifyApplication;
  let projectId: string;
  let providerId: string;

  beforeAll(async () => {
    setupTestDb();

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
  });

  beforeEach(() => {
    resetTestDb();
    const fixtures = seedTestData();
    projectId = fixtures.projectId;
    providerId = fixtures.providerId;
  });

  async function createPrompt(title: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompts',
      payload: { projectId, title, content: `Content for ${title}` },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.payload);
  }

  async function createProfile(name = 'Runner') {
    // provider is seeded by seedTestData
    const res = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: {
        projectId,
        name,
        providerId,
        options: null,
      },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.payload);
  }

  it('PUT /api/profiles/:id/prompts — happy path 200 and ordered response', async () => {
    const p1 = await createPrompt('P1');
    const p2 = await createPrompt('P2');
    const profile = await createProfile();

    const replace = await app.inject({
      method: 'PUT',
      url: `/api/profiles/${profile.id}/prompts`,
      payload: { promptIds: [p1.id, p2.id] },
    });

    expect(replace.statusCode).toBe(200);
    const body = JSON.parse(replace.payload);
    expect(body.profileId).toBe(profile.id);
    expect(body.prompts.map((x: any) => x.promptId)).toEqual([p1.id, p2.id]);
    expect(body.prompts[0].order).toBe(1);
    expect(body.prompts[1].order).toBe(2);
  });

  it('PUT /api/profiles/:id/prompts — 400 on unknown promptIds', async () => {
    const profile = await createProfile('Runner2');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/profiles/${profile.id}/prompts`,
      payload: { promptIds: ['missing-id'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /api/profiles/:id/prompts — 400 on cross-project prompt', async () => {
    const profile = await createProfile('Runner3');

    // Create another project and a prompt there
    const proj2 = await app.inject({
      method: 'POST',
      url: '/api/projects/from-template',
      payload: { name: 'Other', rootPath: '/tmp/other', templateId: 'empty-project' },
    });
    expect(proj2.statusCode).toBe(201);
    const proj2Obj = JSON.parse(proj2.payload);

    const pOther = await app.inject({
      method: 'POST',
      url: '/api/prompts',
      payload: { projectId: proj2Obj.project.id, title: 'OtherPrompt', content: 'X' },
    });
    expect(pOther.statusCode).toBe(201);
    const p2 = JSON.parse(pOther.payload);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/profiles/${profile.id}/prompts`,
      payload: { promptIds: [p2.id] },
    });
    expect(res.statusCode).toBe(400);
  });
});
