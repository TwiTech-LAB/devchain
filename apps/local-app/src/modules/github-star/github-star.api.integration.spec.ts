import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { EpicsService } from '../epics/services/epics.service';
import { REALTIME_BROADCASTER } from '../realtime/ports/realtime-broadcaster.port';
import { SettingsService } from '../settings/services/settings.service';
import { GithubStarController } from './github-star.controller';
import { GITHUB_STAR_GH, type GithubStarGh } from './github-star-gh.port';
import { GITHUB_STAR_ON_VM, GithubStarService } from './github-star.service';

// Layer: HTTP integration. Routing, body validation and the error filter exist only
// in a running Nest app; the state rules themselves are owned by the service spec.
describe('GitHub star API', () => {
  let sqlite: Database.Database;
  let settings: SettingsService;
  let moduleRef: TestingModule;
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const database = createTestDatabase();
    sqlite = database.sqlite;
    settings = new SettingsService(database.db, new EventEmitter2());
    moduleRef = await Test.createTestingModule({
      controllers: [GithubStarController],
      providers: [
        GithubStarService,
        { provide: SettingsService, useValue: settings },
        { provide: EpicsService, useValue: {} },
        {
          provide: GITHUB_STAR_GH,
          useValue: {
            isAlreadyStarred: async () => 'unknown',
            star: async () => false,
          } satisfies GithubStarGh,
        },
        { provide: REALTIME_BROADCASTER, useValue: { broadcastEvent: jest.fn() } },
        { provide: GITHUB_STAR_ON_VM, useValue: () => false },
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
  });

  const act = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/github-star/action', payload: payload as object });

  it('serves the pending prompt and applies actions only to it', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/github-star' })).json()).toEqual({
      pending: null,
    });

    await settings.updateGithubStarState((state) => ({
      ...state,
      pending: { id: 'prompt-1', reason: 'phase-done', mode: 'gh' },
    }));
    const pending = {
      id: 'prompt-1',
      reason: 'phase-done',
      mode: 'gh',
      url: 'https://github.com/TwiTech-LAB/devchain',
    };
    expect((await app.inject({ method: 'GET', url: '/api/github-star' })).json()).toEqual({
      pending,
    });

    const stale = await act({ promptId: 'prompt-0', action: 'never' });
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toEqual({ pending });

    const later = await act({ promptId: 'prompt-1', action: 'later' });
    expect(later.statusCode).toBe(200);
    expect(later.json()).toEqual({ pending: null });
    expect(settings.getGithubStarState()).toMatchObject({ threshold: 100, pending: null });
  });

  it.each([
    ['an unknown action', { promptId: 'p', action: 'maybe' }],
    ['an unknown field', { promptId: 'p', action: 'later', extra: true }],
    ['a missing promptId', { action: 'later' }],
  ])('rejects %s with 400', async (_name, payload) => {
    expect((await act(payload)).statusCode).toBe(400);
  });
});
