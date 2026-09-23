/**
 * API retirement integration test for the Codebase Overview feature removal.
 *
 * Layer: backend-integration (compiled app roots + Fastify injection).
 * Justification: route absence can only be proven against real root route
 * registration — metadata checks cannot catch a controller that is still
 * wired into a shipped app root. The shared bootstrap fixture keeps both
 * app-root graphs on disposable in-memory databases.
 */

import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { STORAGE_SERVICE } from '../modules/storage/interfaces/storage.interface';
import { AppBootstrapFixture, compileAppBootstrapFixture } from './test/app-bootstrap.helper';

jest.setTimeout(120_000);

const PROJECT_ID = 'retirement-check-project';

const EXISTING_PROJECT = {
  id: PROJECT_ID,
  name: 'Retirement Check',
  description: null,
  rootPath: '/tmp/retirement-check',
  isPrivate: false,
  isTemplate: false,
  createdAt: '2026-09-07T00:00:00.000Z',
  updatedAt: '2026-09-07T00:00:00.000Z',
};

const RETIRED_ROUTES: Array<{ method: 'GET' | 'PUT'; url: string }> = [
  { method: 'GET', url: `/api/projects/${PROJECT_ID}/codebase-overview` },
  { method: 'GET', url: `/api/projects/${PROJECT_ID}/codebase-overview/targets/target-1` },
  { method: 'GET', url: `/api/projects/${PROJECT_ID}/codebase-overview/pairs/from-1/to-1` },
  {
    method: 'GET',
    url: `/api/projects/${PROJECT_ID}/codebase-overview/districts/district-1/files`,
  },
  { method: 'GET', url: `/api/projects/${PROJECT_ID}/codebase-overview/scope` },
  { method: 'PUT', url: `/api/projects/${PROJECT_ID}/codebase-overview/scope` },
];

async function bootHttpApp(root: 'normal' | 'main'): Promise<{
  fixture: AppBootstrapFixture;
  app: NestFastifyApplication;
}> {
  const fixture = await compileAppBootstrapFixture(root);
  const storageMock = fixture.moduleRef.get(STORAGE_SERVICE) as Record<
    string,
    { mockResolvedValue: (v: unknown) => void }
  >;
  // The project must resolve so the retired-route 404s below can only mean route absence.
  storageMock.getProject.mockResolvedValue(EXISTING_PROJECT);

  const app = fixture.moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    {
      logger: false,
    },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { fixture, app };
}

describe.each(['normal', 'main'] as const)('codebase overview retirement (%s root)', (root) => {
  let fixture: AppBootstrapFixture | null = null;
  let app: NestFastifyApplication | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    if (fixture) {
      await fixture.close();
      fixture = null;
    }
  });

  it('serves the project through a retained route before proving retirement', async () => {
    ({ fixture, app } = await bootHttpApp(root));

    const response = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: `/api/projects/${PROJECT_ID}`,
      });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toMatchObject({ id: PROJECT_ID });
  });

  it.each(RETIRED_ROUTES)('returns 404 by route absence for $method $url', async (route) => {
    ({ fixture, app } = await bootHttpApp(root));

    const response = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: route.method,
        url: route.url,
        payload: route.method === 'PUT' ? { entries: [] } : undefined,
      });

    expect(response.statusCode).toBe(404);
  });
});
