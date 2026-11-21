import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { ConflictError } from '../../../common/errors/error-types';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';
import {
  STORAGE_SERVICE,
  type ReplicaProviderSettingsRow,
} from '../../storage/interfaces/storage.interface';
import { HostHelperService } from './host-helper.service';
import { HostProviderSettingsController } from './host-provider-settings.controller';
import { HostProviderSettingsService } from './host-provider-settings.service';
import { providerSettingsRevision } from './host-provider-settings-revision';

// Layer: VM API integration over real storage. Body validation, the revision check,
// the claim gate, the Connect rule and the fingerprint meet only at the route.
const SECRET = 'sk-home-secret-value';
const frozenAt = '2026-09-22T10:00:00.000Z';

describe('Host provider settings API', () => {
  let database: ReturnType<typeof createTestDatabase>;
  let storage: LocalStorageService;
  let gate: ProjectWriteGate;
  let moduleRef: TestingModule;
  let app: NestFastifyApplication;
  let claimed: boolean;
  let onVm: string;
  let providerId: string;

  const homeOnlyProject = randomUUID();

  beforeEach(async () => {
    claimed = true;
    database = createTestDatabase();
    gate = new ProjectWriteGate();
    storage = new LocalStorageService(database.db, undefined, undefined, gate);
    gate.bindStorage(storage);
    await gate.onModuleInit();
    onVm = (await createProject('on-vm')).id;
    const provider = await storage.createProvider({ name: 'claude' });
    providerId = provider.id;
    await storage.updateProviderWithScopes(
      providerId,
      { env: { VM_ONLY: 'local', SHARED: 'vm' }, autoCompactThreshold: 10 },
      { VM_ONLY: [onVm] },
      ['VM_ONLY', 'SHARED'],
    );

    const helper = {
      assertClaimedHost: () => {
        if (!claimed) throw new ConflictError('Not a claimed host', { code: 'NOT_A_HOST' });
      },
    };
    moduleRef = await Test.createTestingModule({
      controllers: [HostProviderSettingsController],
      providers: [
        HostProviderSettingsService,
        { provide: STORAGE_SERVICE, useValue: storage },
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
    database.sqlite.close();
  });

  const createProject = (name: string) =>
    storage.createProject({
      name,
      rootPath: `/tmp/${name}-${randomUUID()}`,
      description: null,
      isTemplate: false,
    });

  const homeRows = (): ReplicaProviderSettingsRow[] => [
    {
      providerName: 'claude',
      env: { GLOBAL: SECRET, SCOPED: 'on-vm', ELSEWHERE: 'home-only', SHARED: 'home' },
      envScopes: { SCOPED: [homeOnlyProject, onVm], ELSEWHERE: [homeOnlyProject] },
      auto_compact_threshold: 80,
      claude_launch_settings_json: '{"model":"opus"}',
    },
    {
      providerName: 'not-on-vm',
      env: { A: 'b' },
      envScopes: {},
      auto_compact_threshold: null,
      claude_launch_settings_json: null,
    },
  ];

  const status = async () =>
    (await app.inject({ method: 'GET', url: '/api/host/provider-settings/status' })).json() as {
      appliedRevision: string | null;
    };
  const put = (body: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: '/api/host/provider-settings', payload: body });
  const pushHome = async () => {
    const providers = homeRows();
    const revision = providerSettingsRevision(providers);
    const response = await put({ revision, providers });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ revision });
    return revision;
  };
  const vmSettings = async () => {
    const provider = await storage.getProvider(providerId);
    return {
      env: provider.env,
      envScopes: storage.listEnvScopesByProviderIds([providerId]).get(providerId) ?? {},
      autoCompactThreshold: provider.autoCompactThreshold,
      claudeLaunchSettingsJson: provider.claudeLaunchSettingsJson,
    };
  };
  const HOME_ON_VM = {
    env: { GLOBAL: SECRET, SCOPED: 'on-vm', SHARED: 'home' },
    envScopes: { SCOPED: [expect.any(String)] },
    autoCompactThreshold: 80,
    claudeLaunchSettingsJson: '{"model":"opus"}',
  };

  it("makes the VM's provider settings equal home's by the Connect rule", async () => {
    expect((await status()).appliedRevision).toBeNull();

    const revision = await pushHome();

    expect(await vmSettings()).toEqual(HOME_ON_VM);
    expect((await vmSettings()).envScopes).toEqual({ SCOPED: [onVm] });
    expect((await status()).appliedRevision).toBe(revision);
  });

  it.each([
    [
      'a local env edit',
      async () => {
        await storage.updateProvider(providerId, {
          env: { GLOBAL: 'local', SCOPED: 'on-vm', SHARED: 'home' },
        });
      },
    ],
    [
      'a scope-only edit',
      async () => {
        await storage.updateProviderWithScopes(providerId, {}, { SCOPED: [onVm], SHARED: [onVm] }, [
          'GLOBAL',
          'SCOPED',
          'SHARED',
        ]);
      },
    ],
    [
      'a new provider row',
      async () => {
        await storage.createProvider({ name: 'codex' });
      },
    ],
    [
      'a new project row',
      async () => {
        await createProject('another');
      },
    ],
    [
      'a project release',
      async () => {
        await storage.setProjectFrozen(onVm, frozenAt);
        gate.markFrozen(onVm, frozenAt);
        await storage.releaseProject(onVm);
      },
    ],
  ])('reports no applied revision after %s', async (_name, change) => {
    await pushHome();
    await change();
    expect((await status()).appliedRevision).toBeNull();
  });

  it("applies the same revision again and restores home's values after a local edit", async () => {
    const revision = await pushHome();
    await storage.updateProviderWithScopes(
      providerId,
      { env: { GLOBAL: 'local' }, autoCompactThreshold: 5 },
      {},
      ['GLOBAL'],
    );

    expect(await pushHome()).toBe(revision);

    expect(await vmSettings()).toEqual(HOME_ON_VM);
    expect((await status()).appliedRevision).toBe(revision);
  });

  it('applies a push while a project is frozen', async () => {
    await storage.setProjectFrozen(onVm, frozenAt);
    gate.markFrozen(onVm, frozenAt);

    const revision = await pushHome();

    expect(await vmSettings()).toEqual(HOME_ON_VM);
    expect((await status()).appliedRevision).toBe(revision);
  });

  it('rejects a body whose revision does not match and never echoes it', async () => {
    const before = await vmSettings();
    const providers = homeRows();

    const response = await put({ revision: providerSettingsRevision([]), providers });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(SECRET);
    expect(await vmSettings()).toEqual(before);
    expect((await status()).appliedRevision).toBeNull();
  });

  it('rejects an invalid body without echoing it', async () => {
    const response = await put({
      revision: 'x',
      providers: [{ providerName: 'claude', env: { GLOBAL: SECRET } }],
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(SECRET);
  });

  it('refuses both routes on an unclaimed host', async () => {
    claimed = false;
    const providers = homeRows();
    const before = await vmSettings();

    expect(
      (await app.inject({ method: 'GET', url: '/api/host/provider-settings/status' })).statusCode,
    ).toBe(409);
    expect(
      (await put({ revision: providerSettingsRevision(providers), providers })).statusCode,
    ).toBe(409);
    expect(await vmSettings()).toEqual(before);
  });
});
