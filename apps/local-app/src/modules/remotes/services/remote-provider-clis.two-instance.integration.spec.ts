import { RemoteApiKeyService } from '../auth/remote-api-key.service';
import { Controller, Get, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  PROVIDER_CLI_NAMES,
  PROVIDER_CLI_NPM_PACKAGES,
  type HostProviderCliSettings,
} from '@devchain/shared';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { SettingsService } from '../../settings/services/settings.service';
import { ActiveSessionLookup } from '../../sessions/services/active-session-lookup.service';
import { ProviderCliInstallStateService } from '../../providers/services/provider-cli-install-state.service';
import { ProviderCliInstallerService } from '../../providers/services/provider-cli-installer.service';
import {
  ProviderCliVersionsService,
  PROVIDER_CLI_CHECK_INTERVAL_MS,
} from '../../providers/services/provider-cli-versions.service';
import { ProviderCliNpmLookupService } from '../../providers/services/provider-cli-npm-lookup.service';
import { ProviderClisController } from '../../providers/controllers/provider-clis.controller';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import type {
  ProcessExecutor,
  ProcessExecutorOptions,
} from '../../terminal/services/process-executor/process-executor.port';
import { HostProviderCliSettingsService } from '../host/host-provider-cli-settings.service';
import { HostProviderCliSettingsController } from '../host/host-provider-cli-settings.controller';
import { HostHelperService } from '../host/host-helper.service';
import { RuntimeController } from '../../core/controllers/runtime.controller';
import { SyncthingManager } from '../../file-sync/syncthing-manager.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import { RemoteProviderCliSettingsService } from './remote-provider-cli-settings.service';
import { RemoteHealthService } from './remote-health.service';
import { REMOTE_HEALTH_PORT } from '../ports/remote-health.port';
import { RemotesController } from '../controllers/remotes.controller';
import { RemotesService } from './remotes.service';
import { RemoteFileSyncService } from '../sync/remote-file-sync.service';
import { resetEnvConfig } from '../../../common/config/env.config';
import { fixtureTls, installFixtureTlsFront } from '../../../common/test/tls-fixture';
import { providerCliPolicyRevision } from '../host/host-provider-cli-policy';

jest.mock('../../core/controllers/docker-runtime', () => ({
  ...jest.requireActual('../../core/controllers/docker-runtime'),
  readDockerRuntime: async () => undefined,
}));
jest.mock('../../core/controllers/host-cli-versions', () => ({
  readHostCliVersions: () => ({ claude: 'baseline' }),
}));

@Controller('api/host/stats')
class StatsController {
  @Get() get() {
    return { cpuPercent: 0 };
  }
}

interface Instance {
  app: NestFastifyApplication;
  url: string;
  sqlite: Database.Database;
  storage: LocalStorageService;
  settings: SettingsService;
  installer: ProviderCliInstallerService;
  versions: ProviderCliVersionsService;
  hostPolicy: HostProviderCliSettingsService;
  health: RemoteHealthService;
  closed: boolean;
}

// Two real HTTP apps, durable SQLite/settings, registry HTTP and filesystem activation.
// Only platform claiming, telemetry and downloading CLI bytes are fixture boundaries.
describe('provider CLI policy across home and VM', () => {
  let root: string;
  let registry: Server;
  let registryUrl: string;
  let home: Instance;
  let host: Instance;
  let remoteId: string;
  let latest: Record<'home' | 'host', string>;
  let failed: Set<string>;
  let claimed: boolean;
  let savedEnv: NodeJS.ProcessEnv;
  let broadcaster: { broadcastEvent: jest.Mock };
  let intervals: jest.SpyInstance;
  const instances: Instance[] = [];

  async function boot(name: 'home' | 'host', port = 0): Promise<Instance> {
    const directory = join(root, name);
    await mkdir(directory, { recursive: true });
    const sqlite = new Database(join(directory, 'devchain.db'));
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: join(__dirname, '../../../../drizzle') });
    const storage = new LocalStorageService(db);
    const settings = new SettingsService(db, new EventEmitter2());
    const local = new ProviderCliInstallStateService(join(directory, 'provider-clis'));
    const child = new ChildProcessExecutor();
    const executor = {
      run: async (options: ProcessExecutorOptions) => {
        if (options.argv[1] !== 'install') return child.run(options);
        const spec = options.argv.at(-1)!;
        const provider = PROVIDER_CLI_NAMES.find((provider) =>
          spec.startsWith(`${PROVIDER_CLI_NPM_PACKAGES[provider]}@`),
        )!;
        const version = spec.slice(spec.lastIndexOf('@') + 1);
        if (failed.has(`${name}:${provider}`))
          return {
            success: false,
            exitCode: 1,
            stdout: '',
            stderr: 'fixture offline',
            timedOut: false,
            truncated: false,
          };
        const prefix = options.cwd!;
        const packageDir = join(prefix, 'lib/node_modules', PROVIDER_CLI_NPM_PACKAGES[provider]);
        await mkdir(packageDir, { recursive: true });
        await writeFile(join(packageDir, 'package.json'), JSON.stringify({ version }));
        await mkdir(join(prefix, 'bin'), { recursive: true });
        await writeFile(join(prefix, 'bin', provider), `#!/bin/sh\necho '${version}'\n`);
        await chmod(join(prefix, 'bin', provider), 0o755);
        return {
          success: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
          truncated: false,
        };
      },
    } as ProcessExecutor;
    const installer = new ProviderCliInstallerService(
      local,
      settings,
      executor,
      storage,
      new ActiveSessionLookup(db),
      { seedForProvider: async () => undefined } as never,
      { syncProviderToAllProjects: async () => undefined } as never,
    );
    jest
      .spyOn(installer as unknown as { isHost(): boolean }, 'isHost')
      .mockImplementation(() => name === 'host');
    const versions = new ProviderCliVersionsService(
      new ProviderCliNpmLookupService(`${registryUrl}/${name}`),
      settings,
      installer,
    );
    const helper = {
      isClaimedHost: () => name === 'host' && claimed,
      assertClaimedHost: () => {
        if (name !== 'host' || !claimed) throw new ForbiddenException('Not a claimed host');
      },
    };
    const hostPolicy = new HostProviderCliSettingsService(
      helper as HostHelperService,
      local,
      settings,
      versions,
      installer,
    );
    const push = new RemoteProviderCliSettingsService(
      settings,
      new RemoteHostClient(storage, new RemoteApiKeyService(storage)),
    );
    const health = new RemoteHealthService(
      storage,
      broadcaster,
      { pullIfChanged: async () => undefined } as never,
      {} as never,
      {
        createPollCycle: () => () => Promise.resolve(null),
        prune: () => undefined,
        pushIfChanged: async () => undefined,
      } as never,
      push,
      versions,
      new RemoteApiKeyService(storage),
    );
    const module = await Test.createTestingModule({
      controllers: [
        HostProviderCliSettingsController,
        RuntimeController,
        StatsController,
        ProviderClisController,
        RemotesController,
      ],
      providers: [
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: HostHelperService, useValue: helper },
        { provide: HostProviderCliSettingsService, useValue: hostPolicy },
        { provide: ProviderCliInstallStateService, useValue: local },
        { provide: ProviderCliInstallerService, useValue: installer },
        { provide: ProviderCliVersionsService, useValue: versions },
        { provide: RemoteProviderCliSettingsService, useValue: push },
        { provide: REMOTE_HEALTH_PORT, useValue: health },
        { provide: SyncthingManager, useValue: { getState: () => null } },
        { provide: RemotesService, useValue: {} },
        { provide: RemoteFileSyncService, useValue: {} },
      ],
    }).compile();
    const app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false, forceCloseConnections: true }),
      { logger: false },
    );
    installFixtureTlsFront(app);
    await app.listen(port, '127.0.0.1');
    const instance = {
      app,
      url: await app.getUrl(),
      sqlite,
      storage,
      settings,
      installer,
      versions,
      hostPolicy,
      health,
      closed: false,
    };
    instances.push(instance);
    return instance;
  }

  async function close(instance: Instance) {
    if (instance.closed) return;
    await instance.app.close();
    // Finish fixture subprocesses before closing the SQLite connection they used.
    await eventually(() =>
      PROVIDER_CLI_NAMES.every(
        (provider) => instance.installer.getStatus(provider).state !== 'installing',
      ),
    );
    instance.sqlite.close();
    instance.closed = true;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'provider-clis-two-'));
    latest = { home: '9.0.0', host: '1.0.0' };
    failed = new Set();
    claimed = true;
    broadcaster = { broadcastEvent: jest.fn() };
    savedEnv = { ...process.env };
    process.env.REMOTES_HEALTH_INTERVAL_MS = '600000';
    // Both machines check the fake registry at start; the backend test setup turns that off.
    process.env.PROVIDER_CLI_CHECKS_ENABLED = 'true';
    resetEnvConfig();
    intervals = jest.spyOn(global, 'setInterval');
    registry = createServer((request, response) => {
      const machine = request.url!.split('/')[1] as 'home' | 'host';
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          request.url!.endsWith('/latest')
            ? { version: latest[machine] }
            : { versions: { '1.0.0': {}, '2.0.0': {}, '9.0.0': {} } },
        ),
      );
    });
    await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
    registryUrl = `http://127.0.0.1:${(registry.address() as { port: number }).port}`;
    host = await boot('host');
    home = await boot('home');
    remoteId = (
      await home.storage.createRemote({
        kind: 'address',
        name: 'fixture VM',
        baseUrl: host.url.replace(/^http:/, 'https:'),
        tlsCertificate: fixtureTls.cert,
      })
    ).id;
    await eventually(() =>
      PROVIDER_CLI_NAMES.every(
        (provider) => host.installer.getStatus(provider).installedVersion === '1.0.0',
      ),
    );
  });

  afterEach(async () => {
    for (const instance of instances.splice(0).reverse()) await close(instance);
    registry.closeAllConnections();
    await new Promise<void>((resolve) => registry.close(() => resolve()));
    intervals.mockRestore();
    process.env = savedEnv;
    resetEnvConfig();
    await rm(root, { recursive: true, force: true });
  });

  it('pushes a pin, installs on the VM and reports it through runtime, remotes and version-only broadcasts', async () => {
    await home.versions.setVersion('claude', { version: '2.0.0', homeManaged: false });
    const accepts = jest.spyOn(host.hostPolicy, 'accept');
    await home.health.refresh(remoteId);
    await eventually(() => host.installer.getStatus('claude').installedVersion === '2.0.0');
    await home.health.refresh(remoteId);
    const list = await (await fetch(`${home.url}/api/remotes`)).json();
    expect(list.items[0].cliVersions).toEqual({ claude: 'baseline' });
    expect(list.items[0].providerClis.claude).toMatchObject({
      installedVersion: '2.0.0',
      desiredVersion: '2.0.0',
      state: 'idle',
    });
    expect(accepts).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(accepts.mock.calls[0][0])).not.toMatch(
      /homeManaged|binPath|installedVersion/,
    );
    const runtime = await (await fetch(`${host.url}/api/runtime`)).json();
    expect(runtime.cliVersions).toEqual({ claude: 'baseline' });
    expect(runtime.providerClis.claude.installedVersion).toBe('2.0.0');
    expect(
      broadcaster.broadcastEvent.mock.calls
        .filter(([topic]) => topic === 'remotes')
        .some(([, , payload]) => payload.providerClis?.claude.installedVersion === '2.0.0'),
    ).toBe(true);
    const before = home.health.getState(remoteId).providerClis;
    await close(host);
    await home.health.refresh(remoteId);
    expect(home.health.getState(remoteId)).toMatchObject({ online: false, providerClis: before });
  });

  it('uses the VM registry for Latest, retries a failed install without a new policy, and fans out Check now', async () => {
    await home.health.refresh(remoteId);
    await eventually(() => host.hostPolicy.status().acceptedRevision !== null);
    const revision = host.hostPolicy.status().acceptedRevision;
    const lookup = jest.spyOn(host.versions, 'getLookup').mockReturnValue(null);
    const install = jest.spyOn(host.installer, 'getStatus').mockReturnValue({
      ...host.installer.getStatus('claude'),
      state: 'idle',
      error: null,
    });
    try {
      expect(host.hostPolicy.status().providers.claude.state).toBe('accepted');
    } finally {
      lookup.mockRestore();
      install.mockRestore();
    }
    latest.host = '2.0.0';
    failed.add('host:codex');
    expect((await fetch(`${home.url}/api/provider-clis/check`, { method: 'POST' })).status).toBe(
      201,
    );
    await eventually(() => host.installer.getStatus('codex').state === 'failed');
    await eventually(() => host.installer.getStatus('claude').installedVersion === '2.0.0');
    expect(host.hostPolicy.status().providers.codex.state).toBe('failed');
    expect(host.installer.getStatus('claude').installedVersion).not.toBe(latest.home);
    failed.clear();
    expect(
      (await fetch(`${host.url}/api/host/provider-clis/check`, { method: 'POST' })).status,
    ).toBe(202);
    await eventually(() => host.installer.getStatus('codex').installedVersion === '2.0.0');
    expect(host.hostPolicy.status()).toMatchObject({
      acceptedRevision: revision,
      appliedRevision: revision,
    });
  });

  it('recovers the durable pin on VM restart and keeps scheduling when home is off', async () => {
    await home.versions.setVersion('claude', { version: '2.0.0', homeManaged: false });
    await home.health.refresh(remoteId);
    await eventually(() => host.installer.getStatus('claude').installedVersion === '2.0.0');
    const accepted = JSON.parse(
      await readFile(join(root, 'host/provider-clis/host-policy.json'), 'utf8'),
    );
    await close(home);
    await close(host);
    host = await boot('host');
    expect(host.hostPolicy.status().acceptedRevision).toBe(accepted.revision);
    expect(host.settings.getProviderCliVersions().claude.version).toBe('2.0.0');
    await host.versions.checkNow();
    latest.host = '3.0.0';
    // Invoke the registered six-hour timer, without advancing HTTP/socket timers.
    const checks = intervals.mock.calls.filter(
      ([, delay]) => delay === PROVIDER_CLI_CHECK_INTERVAL_MS,
    );
    (checks.at(-1)![0] as () => void)();
    await eventually(() => host.installer.getStatus('codex').installedVersion === '3.0.0');
    expect(host.installer.getStatus('claude').installedVersion).toBe('2.0.0');
  });

  it('rejects invalid provider/version/package/revision bodies and guards every host route', async () => {
    const providers = Object.fromEntries(
      PROVIDER_CLI_NAMES.map((provider) => [
        provider,
        { package: PROVIDER_CLI_NPM_PACKAGES[provider], version: 'latest' },
      ]),
    ) as HostProviderCliSettings['providers'];
    const body = { providers, revision: providerCliPolicyRevision(providers) };
    for (const invalid of [
      { ...body, providers: { ...providers, evil: { package: 'evil', version: 'latest' } } },
      { ...body, providers: { ...providers, claude: { package: 'evil', version: 'latest' } } },
      {
        ...body,
        providers: { ...providers, claude: { ...providers.claude, version: '1.0.0-beta' } },
      },
      { ...body, revision: '0'.repeat(64) },
    ])
      expect(
        (
          await fetch(`${host.url}/api/host/provider-clis`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(invalid),
          })
        ).status,
      ).toBe(400);
    claimed = false;
    for (const [method, path] of [
      ['GET', '/status'],
      ['PUT', ''],
      ['POST', '/check'],
    ]) {
      expect(
        (
          await fetch(`${host.url}/api/host/provider-clis${path}`, {
            method,
            ...(method === 'PUT'
              ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
              : {}),
          })
        ).status,
      ).toBe(403);
    }
  });
});

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for convergence');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
