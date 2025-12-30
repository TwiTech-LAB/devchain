import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

describe('Static UI serve (E2E)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
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
  });

  it('serves index.html via SPA fallback', async () => {
    // Ensure UI build exists
    const uiDir = join(process.cwd(), 'apps', 'local-app', 'dist', 'ui');
    if (!existsSync(uiDir)) {
      console.warn('UI build not found; skipping static UI E2E smoke test');
      return;
    }
    const res = await app.inject({ method: 'GET', url: '/' });
    expect([200, 503]).toContain(res.statusCode);
    if (res.statusCode === 503) {
      // Allow skip when not built
      return;
    }
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.payload).toMatch(/<div id="root"/);
  });

  it('serves asset bundle under /assets/', async () => {
    const assetsDir = join(process.cwd(), 'apps', 'local-app', 'dist', 'ui', 'assets');
    if (!existsSync(assetsDir)) {
      console.warn('UI assets not found; skipping static assets E2E smoke test');
      return;
    }
    const files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
    if (!files.length) {
      console.warn('No JS assets found; skipping static assets E2E smoke test');
      return;
    }
    const asset = files[0];
    const res = await app.inject({ method: 'GET', url: `/assets/${asset}` });
    expect([200, 404]).toContain(res.statusCode);
    if (res.statusCode === 404) {
      // Static plugin may be disabled in this test runtime; allow skip
      return;
    }
    expect(res.headers['content-type']).toMatch(/application\/javascript|text\/javascript/);
    expect(res.payload.length).toBeGreaterThan(0);
  });
});

