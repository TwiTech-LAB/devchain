// HTTP integration is the cheapest layer that retains socket-based admission,
// own-key identity and persistent inbox/abandonment; peer HTTP calls use a fake transport.
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetEnvConfig } from '../../../common/config/env.config';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { createReplicaDb, replicaSeeder } from '../replica/__fixtures__/replica-seed';
import { HostSharedVmController } from './host-shared-vm.controller';
import { HostSharedVmService } from './host-shared-vm.service';
import { HostSharedVmStore } from './host-shared-vm.store';
import { HostHelperService } from './host-helper.service';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { HostApiKeyModule } from './host-api-key.module';

const KEY = `dck_${'a'.repeat(43)}`;
const OTHER_KEY = `dck_${'b'.repeat(43)}`;
const AUTH = { authorization: `Bearer ${KEY}` };
const BASE = '/api/host/shared-vm';

describe('Shared VM host API', () => {
  let app: NestFastifyApplication;
  let root: string;
  let db: ReturnType<typeof createReplicaDb>;
  let savedEtc: string | undefined;
  let peers: jest.SpyInstance;
  const run = jest.fn();

  function claim(user: string, port: number, version?: string): string {
    const etc = user === 'alice' ? root : join(root, 'instances', user);
    const home = join(root, 'homes', user);
    mkdirSync(etc, { recursive: true });
    mkdirSync(join(home, '.devchain'), { recursive: true });
    writeFileSync(
      join(etc, 'claim.json'),
      JSON.stringify({ userName: user, port, version, homePath: home }),
    );
    writeFileSync(
      join(home, '.devchain', 'host-api-key'),
      `${createHash('sha256')
        .update(user === 'alice' ? KEY : OTHER_KEY)
        .digest('hex')}\n`,
    );
    return etc;
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'shared-vm-'));
    savedEtc = process.env.DEVCHAIN_HOST_ETC_DIR;
    process.env.DEVCHAIN_HOST_ETC_DIR = claim('alice', 3000, '0.25.0');
    resetEnvConfig();
    db = createReplicaDb();
    replicaSeeder(db.sqlite).seedProject('hosted');
    peers = jest.spyOn(globalThis, 'fetch');
    run.mockReset();
    const module = await Test.createTestingModule({
      imports: [HostApiKeyModule],
      controllers: [HostSharedVmController],
      providers: [
        HostSharedVmService,
        HostSharedVmStore,
        HostHelperService,
        { provide: DB_CONNECTION, useValue: db.db },
        { provide: ProcessExecutor, useValue: { run } },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    db.sqlite.close();
    rmSync(root, { force: true, recursive: true });
    if (savedEtc === undefined) delete process.env.DEVCHAIN_HOST_ETC_DIR;
    else process.env.DEVCHAIN_HOST_ETC_DIR = savedEtc;
    resetEnvConfig();
    jest.restoreAllMocks();
  });

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'admits loopback %s for count and notice delivery without a key',
    async (remoteAddress) => {
      const count = await app.inject({ url: `${BASE}/connected-count`, remoteAddress });
      expect(count.statusCode).toBe(200);
      expect(count.json()).toEqual({ connectedCount: 1, connectedProjectIds: ['hosted'] });
      const delivery = await app.inject({
        method: 'POST',
        url: `${BASE}/inbox`,
        remoteAddress,
        payload: { fromUser: 'alice', action: 'reset', at: '2026-10-12T15:00:00Z' },
      });
      expect(delivery.statusCode).toBe(204);
      const notices = await app.inject({ url: `${BASE}/notices`, headers: AUTH });
      expect(notices.json().notices).toEqual([
        expect.objectContaining({ fromUser: 'alice', action: 'reset' }),
      ]);
    },
  );

  it.each([
    ['GET', 'connected-count', undefined],
    ['POST', 'inbox', { fromUser: 'alice', action: 'destroy', at: '2026-10-12T15:00:00Z' }],
  ] as const)(
    'refuses a non-loopback caller with a valid key for %s %s',
    async (method, route, payload) => {
      const response = await app.inject({
        method,
        url: `${BASE}/${route}`,
        remoteAddress: '10.1.2.3',
        headers: AUTH,
        payload,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ details: { code: 'HOST_LOOPBACK_REQUIRED' } });
      expect(app.get(HostSharedVmStore).notices()).toEqual([]);
    },
  );

  it.each([
    ['GET', 'roster', undefined],
    ['POST', 'notify', { action: 'reset' }],
    ['GET', 'notices', undefined],
    ['POST', 'dismiss', { id: 'f6ba14db-fcd5-43f5-b568-02fc81490107' }],
    ['POST', 'abandon', { projectId: 'hosted' }],
    ['POST', 'fence', { mode: 'set', operationId: 'destroy-1' }],
  ] as const)('requires an instance key on loopback for %s %s', async (method, route, payload) => {
    const response = await app.inject({
      method,
      url: `${BASE}/${route}`,
      remoteAddress: '127.0.0.1',
      payload,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'HOST_API_KEY_REJECTED' });
    expect(run).not.toHaveBeenCalled();
    expect(peers).not.toHaveBeenCalled();
  });

  it('lists the legacy and every joined claim, reporting unavailable or invalid counts as unknown', async () => {
    claim('bob', 3001, '0.24.0');
    claim('carol', 3002);
    claim('dave', 3003, '0.25.0');
    mkdirSync(join(root, 'instances', 'pending'), { recursive: true });
    peers.mockImplementation(async (url: string) => {
      const port = new URL(url).port;
      if (port === '3002') throw new Error('offline');
      return new Response(
        JSON.stringify({
          connectedCount: port === '3000' ? 1 : port === '3001' ? 2 : -1,
          connectedProjectIds: port === '3000' ? ['hosted'] : port === '3001' ? ['b1', 'b2'] : [],
        }),
      );
    });
    const response = await app.inject({
      url: `${BASE}/roster`,
      headers: AUTH,
      remoteAddress: '10.1.2.3',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      instances: [
        {
          user: 'alice',
          port: 3000,
          version: '0.25.0',
          connectedCount: 1,
          connectedProjectIds: ['hosted'],
        },
        {
          user: 'bob',
          port: 3001,
          version: '0.24.0',
          connectedCount: 2,
          connectedProjectIds: ['b1', 'b2'],
        },
        {
          user: 'carol',
          port: 3002,
          version: null,
          connectedCount: 'unknown',
          connectedProjectIds: 'unknown',
        },
        {
          user: 'dave',
          port: 3003,
          version: '0.25.0',
          connectedCount: 'unknown',
          connectedProjectIds: 'unknown',
        },
      ],
    });
    expect(peers).toHaveBeenCalledTimes(4);
    expect(
      peers.mock.calls.every(
        ([url, options]) =>
          new URL(url).hostname === '127.0.0.1' && options.redirect === 'error' && options.signal,
      ),
    ).toBe(true);
  });

  it('does not report a legacy count-only peer as empty occupancy', async () => {
    claim('bob', 3001);
    peers.mockResolvedValue(new Response(JSON.stringify({ connectedCount: 0 })));
    const response = await app.inject({ url: `${BASE}/roster`, headers: AUTH });
    expect(
      response.json().instances.find((item: { user: string }) => item.user === 'bob'),
    ).toMatchObject({ connectedCount: 'unknown', connectedProjectIds: 'unknown' });
  });

  it('notifies every other instance once and returns per-user results after transport and HTTP failures', async () => {
    claim('bob', 3001, '0.25.0');
    claim('carol', 3002);
    claim('dave', 3003);
    peers.mockImplementation(async (url: string) => {
      if (new URL(url).port === '3002') throw new Error('offline');
      return new Response(null, { status: new URL(url).port === '3001' ? 204 : 503 });
    });
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/notify`,
      headers: AUTH,
      payload: { action: 'forced', message: 'Please disconnect' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      results: [
        { user: 'bob', delivered: true },
        { user: 'carol', delivered: false },
        { user: 'dave', delivered: false },
      ],
    });
    expect(peers).toHaveBeenCalledTimes(3);
    for (const [url, options] of peers.mock.calls) {
      expect(new URL(url).port).not.toBe('3000');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({
        fromUser: 'alice',
        action: 'forced',
        message: 'Please disconnect',
        at: expect.any(String),
      });
    }
  });

  it('persists received notices and supports idempotent own-key dismissal', async () => {
    const notice = {
      fromUser: 'alice',
      action: 'destroy',
      message: 'Tomorrow',
      at: '2026-10-12T15:00:00Z',
    };
    expect(
      (await app.inject({ method: 'POST', url: `${BASE}/inbox`, payload: notice })).statusCode,
    ).toBe(204);
    const notices = (await app.inject({ url: `${BASE}/notices`, headers: AUTH })).json().notices;
    expect(notices).toEqual([{ ...notice, id: expect.any(String) }]);
    expect(new HostSharedVmStore(db.db).notices()).toEqual(notices);
    for (let i = 0; i < 2; i++) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${BASE}/dismiss`,
            headers: AUTH,
            payload: { id: notices[0].id },
          })
        ).statusCode,
      ).toBe(204);
    }
    expect((await app.inject({ url: `${BASE}/notices`, headers: AUTH })).json()).toEqual({
      notices: [],
    });
  });

  it('records abandonment without deleting project rows', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/abandon`,
      headers: AUTH,
      payload: { projectId: 'hosted' },
    });
    expect(response.statusCode).toBe(204);
    expect((await app.inject({ url: `${BASE}/connected-count` })).json()).toEqual({
      connectedCount: 0,
      connectedProjectIds: [],
    });
    expect(db.sqlite.prepare('SELECT id FROM projects').all()).toEqual([{ id: 'hosted' }]);
  });

  it('joined instances read the global registry and admit only their own key; owner actions are refused', async () => {
    process.env.DEVCHAIN_HOST_ETC_DIR = claim('bob', 3001, '0.25.0');
    resetEnvConfig();
    peers.mockImplementation(async () => new Response(JSON.stringify({ connectedCount: 0 })));
    const ownAuth = { authorization: `Bearer ${OTHER_KEY}` };
    expect((await app.inject({ url: `${BASE}/notices`, headers: AUTH })).statusCode).toBe(401);
    const roster = await app.inject({ url: `${BASE}/roster`, headers: ownAuth });
    expect(roster.statusCode).toBe(200);
    expect(roster.json().instances.map(({ user }: { user: string }) => user)).toEqual([
      'alice',
      'bob',
    ]);
    peers.mockClear();
    for (const [route, payload] of [
      ['notify', { action: 'destroy' }],
      ['fence', { mode: 'set', operationId: 'destroy-1' }],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `${BASE}/${route}`,
        headers: ownAuth,
        payload,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ details: { code: 'VM_OWNER_REQUIRED' } });
    }
    expect(peers).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('invokes the owner helper with the validated operation ID', async () => {
    const fence = {
      ownerUser: 'alice',
      operationId: 'destroy-1',
      expiresAt: '2026-10-12T15:30:00Z',
    };
    run.mockResolvedValue({ success: true, timedOut: false, stdout: JSON.stringify({ fence }) });
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/fence`,
      headers: AUTH,
      payload: { mode: 'set', operationId: 'destroy-1' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ fence });
    expect(run.mock.calls[0][0].argv.slice(-3)).toEqual(['--fence', 'set', 'destroy-1']);
  });
});
