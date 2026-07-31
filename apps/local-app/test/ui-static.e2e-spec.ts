import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { request as httpRequest } from 'http';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { normalizeFastifyFrameworkError } from '../src/common/http/runtime-route-classification';
import { configureSwagger } from '../src/common/http/swagger';
import {
  AppBootstrapFixture,
  compileAppBootstrapFixture,
} from '../src/common/test/app-bootstrap.helper';
import { UiModule } from '../src/modules/ui/ui.module';
import { UI_ASSET_SERVING_ENABLED, UI_ROOT } from '../src/modules/ui/ui.tokens';

jest.setTimeout(120_000);

describe('UI and Swagger serving (E2E)', () => {
  let app: NestFastifyApplication;
  let fixtureRoot: string;
  let uiRoot: string;

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'devchain-ui-serving-'));
    uiRoot = join(fixtureRoot, 'ui');
    await mkdir(join(uiRoot, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(uiRoot, 'index.html'), '<div id="root">fixture shell</div>', 'utf8'),
      writeFile(join(uiRoot, 'assets', 'app-123.js'), 'console.log("fixture");', 'utf8'),
      writeFile(join(uiRoot, 'assets', 'app-123.css'), 'body { color: black; }', 'utf8'),
      writeFile(
        join(uiRoot, 'favicon.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        'utf8',
      ),
    ]);
    app = await createUiApp(uiRoot, true);
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it.each(['/', '/projects/example'])('serves the SPA fallback at %s', async (url) => {
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.payload).toContain('fixture shell');
  });

  it.each([
    ['/assets/app-123.js', /application\/javascript|text\/javascript/],
    ['/assets/app-123.css', /^text\/css/],
    ['/favicon.svg', /^image\/svg\+xml/],
  ])('serves the allowlisted UI file %s', async (url, contentType) => {
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(contentType);
    expect(response.headers.etag).toBeDefined();
    expect(response.headers['last-modified']).toBeDefined();
    expect(response.headers['cache-control']).toBe('public, max-age=0');
    expect(response.headers['cache-control']).not.toContain('immutable');
  });

  it('supports conditional requests and byte ranges through @fastify/send', async () => {
    const initial = await app.inject({ method: 'GET', url: '/assets/app-123.js' });
    const conditional = await app.inject({
      method: 'GET',
      url: '/assets/app-123.js',
      headers: { 'if-none-match': initial.headers.etag! },
    });
    const range = await app.inject({
      method: 'GET',
      url: '/assets/app-123.js',
      headers: { range: 'bytes=0-6' },
    });

    expect(conditional.statusCode).toBe(304);
    expect(conditional.payload).toBe('');
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-range']).toMatch(/^bytes 0-6\//);
    expect(range.payload).toBe('console');
  });

  it.each([
    '/assets/missing.js',
    '/assets',
    '/assets/',
    '/assets/app-123.js/',
    '/assets/%252e%252e%252findex.html',
    '/assets/%00.js',
    '/assets/%ZZ.js',
    '/assets%2fapp-123.js',
    '/assets/app%5c.js',
    '/assets/app\\name.js',
    '/assets/.secret',
    '/favicon.svg/',
    '/favicon.svg%00',
    '/favicon.svg%ZZ',
    '/favicon.svg%5cfile',
  ])('returns 404 without SPA fallback for rejected asset path %s', async (url) => {
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(404);
    expect(response.payload).not.toContain('fixture shell');
  });

  it.each(['/assets/../index.html', '/assets/%2e%2e/index.html', '/assets\\app-123.js'])(
    'rejects the original unsafe path on the HTTP wire: %s',
    async (url) => {
      const response = await requestRawPath(app, url);

      expect(response.statusCode).toBe(404);
      expect(response.payload).not.toContain('fixture shell');
    },
  );

  it('returns 404 for a missing favicon without falling back to the SPA', async () => {
    const rootWithoutFavicon = join(fixtureRoot, 'ui-without-favicon');
    await mkdir(rootWithoutFavicon, { recursive: true });
    await writeFile(join(rootWithoutFavicon, 'index.html'), 'favicon fixture shell', 'utf8');
    const missingFaviconApp = await createUiApp(rootWithoutFavicon, true);

    try {
      const response = await missingFaviconApp.inject({ method: 'GET', url: '/favicon.svg' });
      expect(response.statusCode).toBe(404);
      expect(response.payload).not.toContain('favicon fixture shell');
    } finally {
      await missingFaviconApp.close();
    }
  });

  it('keeps unknown API routes as JSON 404 responses', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/unknown' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual({ statusCode: 404, message: 'Not Found' });
  });

  it('returns the build hint when the production UI build is absent', async () => {
    const missingRoot = join(fixtureRoot, 'missing-ui');
    const missingApp = await createUiApp(missingRoot, true);

    try {
      for (const url of ['/nested/route', '/assets/app-123.js']) {
        const response = await missingApp.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
          statusCode: 503,
          message: 'UI not built. Run `pnpm --filter local-app build` first.',
        });
      }
    } finally {
      await missingApp.close();
    }
  });

  it('does not serve UI assets in development mode', async () => {
    const developmentApp = await createUiApp(uiRoot, false);

    try {
      for (const url of ['/assets/app-123.js', '/favicon.svg']) {
        const response = await developmentApp.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(404);
      }
      expect((await developmentApp.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);
    } finally {
      await developmentApp.close();
    }
  });

  it.each(['/api/docs', '/api/docs/'])(
    'serves the application-owned Swagger shell at %s',
    async (url) => {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/html/);
      expect(response.payload).toContain("url: '/api/docs-json'");
      expect(response.payload).toContain('/api/docs/swagger-ui.css');
      expect(response.payload).toContain('/api/docs/favicon-32x32.png');
    },
  );

  it.each([
    ['/api/docs/swagger-ui.css', /^text\/css/],
    ['/api/docs/swagger-ui-bundle.js', /application\/javascript|text\/javascript/],
    ['/api/docs/swagger-ui-standalone-preset.js', /application\/javascript|text\/javascript/],
    ['/api/docs/favicon-32x32.png', /^image\/png/],
  ])('serves the fixed Swagger distribution asset %s', async (url, contentType) => {
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(contentType);
  });

  it('preserves Swagger JSON and YAML while rejecting unallowlisted assets', async () => {
    const json = await app.inject({ method: 'GET', url: '/api/docs-json' });
    const yaml = await app.inject({ method: 'GET', url: '/api/docs-yaml' });
    const missing = await app.inject({ method: 'GET', url: '/api/docs/swagger-ui.js' });

    expect(json.statusCode).toBe(200);
    expect(json.json()).toMatchObject({ openapi: '3.0.0' });
    expect(yaml.statusCode).toBe(200);
    expect(yaml.headers['content-type']).toMatch(/^text\/yaml/);
    expect(missing.statusCode).toBe(404);
  });

  it('relies on Fastify auto-exposed HEAD routes', async () => {
    const docsHead = await app.inject({ method: 'HEAD', url: '/api/docs' });
    const assetHead = await app.inject({
      method: 'HEAD',
      url: '/api/docs/swagger-ui.css',
    });

    expect(docsHead.statusCode).toBe(200);
    expect(assetHead.statusCode).toBe(200);
  });
});

describe.each(['normal', 'main'] as const)('%s root runtime route composition', (mode) => {
  let app: NestFastifyApplication;
  let fixture: AppBootstrapFixture;

  beforeAll(async () => {
    fixture = await compileAppBootstrapFixture(mode);
    app = fixture.moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(), {
      logger: false,
    });
    configureSwagger(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await fixture.moduleRef.close();
    if (fixture.sqlite.open) {
      fixture.sqlite.close();
    }
  });

  it('boots without duplicate routes and exposes Swagger definitions', async () => {
    const shell = await app.inject({ method: 'GET', url: '/api/docs' });
    const definition = await app.inject({ method: 'GET', url: '/api/docs-json' });

    expect(shell.statusCode).toBe(200);
    expect(definition.statusCode).toBe(200);
  });
});

async function createUiApp(
  root: string,
  assetServingEnabled: boolean,
): Promise<NestFastifyApplication> {
  const moduleFixture = await Test.createTestingModule({ imports: [UiModule] })
    .overrideProvider(UI_ROOT)
    .useValue(root)
    .overrideProvider(UI_ASSET_SERVING_ENABLED)
    .useValue(assetServingEnabled)
    .compile();

  const app = moduleFixture.createNestApplication<NestFastifyApplication>(createFastifyAdapter(), {
    logger: false,
  });
  configureSwagger(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

function createFastifyAdapter(): FastifyAdapter {
  return new FastifyAdapter({ frameworkErrors: normalizeFastifyFrameworkError });
}

async function requestRawPath(
  app: NestFastifyApplication,
  path: string,
): Promise<{ payload: string; statusCode: number }> {
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected the test application to listen on a TCP port');
  }

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port: address.port, method: 'GET', path },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            payload: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}
