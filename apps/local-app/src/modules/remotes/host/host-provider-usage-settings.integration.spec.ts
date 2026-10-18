import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type Database from 'better-sqlite3';
import { PROVIDER_USAGE_SETTINGS_DEFAULTS } from '@devchain/shared';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { ConflictError } from '../../../common/errors/error-types';
import { SettingsService } from '../../settings/services/settings.service';
import { HostHelperService } from './host-helper.service';
import { HostProviderUsageSettingsController } from './host-provider-usage-settings.controller';
import { HostProviderUsageSettingsService } from './host-provider-usage-settings.service';
import { providerUsageSettingsRevision } from './host-provider-usage-revision';

// Layer: VM API integration over the real settings table. Body validation, the
// revision check, the claim gate and the settings write meet only at the route.
const PUSHED = {
  ...PROVIDER_USAGE_SETTINGS_DEFAULTS,
  runningMaxAgeMin: 7,
  tokenCheckMinutes: 0,
};

describe('Host provider usage settings API', () => {
  let sqlite: Database.Database;
  let settings: SettingsService;
  let moduleRef: TestingModule;
  let app: NestFastifyApplication;
  let claimed: boolean;

  beforeEach(async () => {
    claimed = true;
    const database = createTestDatabase();
    sqlite = database.sqlite;
    settings = new SettingsService(database.db, new EventEmitter2());
    const helper = {
      assertClaimedHost: () => {
        if (!claimed) throw new ConflictError('Not a claimed host', { code: 'NOT_A_HOST' });
      },
    };
    moduleRef = await Test.createTestingModule({
      controllers: [HostProviderUsageSettingsController],
      providers: [
        HostProviderUsageSettingsService,
        { provide: SettingsService, useValue: settings },
        { provide: HostHelperService, useValue: helper },
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

  const status = () =>
    app.inject({ method: 'GET', url: '/api/host/provider-usage-settings/status' });
  const put = (body: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: '/api/host/provider-usage-settings', payload: body });

  it('writes a valid push into the providerUsage group and reports its revision', async () => {
    const revision = providerUsageSettingsRevision(PUSHED);

    const response = await put({ revision, settings: PUSHED });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ revision });
    expect(settings.getProviderUsageConfig()).toEqual(PUSHED);
    expect((await status()).json()).toEqual({ appliedRevision: revision });
  });

  it('rejects a body whose revision does not match its settings', async () => {
    const response = await put({
      revision: providerUsageSettingsRevision(PROVIDER_USAGE_SETTINGS_DEFAULTS),
      settings: PUSHED,
    });

    expect(response.statusCode).toBe(400);
    expect(settings.getProviderUsageConfig()).toEqual(PROVIDER_USAGE_SETTINGS_DEFAULTS);
  });

  it('refuses both routes on an unclaimed host', async () => {
    claimed = false;
    const revision = providerUsageSettingsRevision(PUSHED);

    expect((await status()).statusCode).toBe(409);
    expect((await put({ revision, settings: PUSHED })).statusCode).toBe(409);
    expect(settings.getProviderUsageConfig()).toEqual(PROVIDER_USAGE_SETTINGS_DEFAULTS);
  });
});
