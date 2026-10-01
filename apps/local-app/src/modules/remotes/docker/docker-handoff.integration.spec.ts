// Fake engines on both sides; the VM side runs the real host routes behind the real LAN client.
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { FakeDockerEngine, type FakeMount } from '../../../common/test/fake-docker-engine.server';
import { fixtureTls, installFixtureTlsFront } from '../../../common/test/tls-fixture';
import { DockerArchiveJournal } from '../../core/controllers/docker-archive-journal';
import { DockerEngineClient, DockerEngineError } from '../../core/controllers/docker-engine.client';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { HostDockerController } from '../host/host-docker.controller';
import { HostDockerService } from '../host/host-docker.service';
import { HostDockerBodyParser } from '../host/host-docker-body.parser';
import type { DockerImportInventory } from '../operations/docker-import-inventory.store';
import { RemoteHostClient } from '../operations/remote-host.client';
import type { RemoteOperationStepRun } from '../operations/remote-operation.types';
import { DockerHandoff } from './docker-handoff';
import { DockerHandoffStore } from './docker-handoff.store';
import type { DockerTransferDetails } from './docker-plan.dto';
import { DockerPlanService } from './docker-plan.service';
import { DockerPlanSourceService } from './docker-plan-source.service';

const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REMOTE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECRET = 'POSTGRES_PASSWORD=never-leak-this';
const OWNER = 'dev.devchain.project';
const COMPOSE = 'com.docker.compose.project';

let scratch: string;
let fixture: string;
let root: string;
let state: string;
let home: FakeDockerEngine;
let vm: FakeDockerEngine;
let app: NestFastifyApplication;
let handoff: DockerHandoff;
let plans: DockerPlanService;
let store: DockerHandoffStore;
let inventory: Map<string, DockerImportInventory>;
let exclusions: Map<string, string[]>;
let savedDockerHost: string | undefined;
let progress: Array<Record<string, unknown>>;

const volumeMount = (name: string, destination: string): FakeMount => ({
  Type: 'volume',
  Name: name,
  Source: `/var/lib/docker/volumes/${name}/_data`,
  Destination: destination,
  RW: true,
});

function seedHome(): void {
  home.images.set('sha256:db', { architecture: 'amd64', tags: ['postgres:17'], size: 80 });
  home.images.set('sha256:web', { architecture: 'amd64', tags: ['app-web:latest'], size: 50 });
  home.volumes.set('app_db', {
    labels: { [COMPOSE]: 'app', 'com.docker.compose.volume': 'db' },
    driver: 'local',
  });
  home.volumes.set('anon0123', { labels: {}, driver: 'local' });
  home.volumes.set('cache', { labels: {}, driver: 'local' });
  home.networks.set('app_default', {
    labels: { [COMPOSE]: 'app', 'com.docker.compose.network': 'default' },
    driver: 'bridge',
    internal: false,
  });
  home.data.set('app_db', Buffer.from('home-db-rows'));
  home.data.set('anon0123', Buffer.from('home-anonymous'));
  home.data.set('cache', Buffer.from('home-cache'));
  home.data.set(state, Buffer.from('home-state'));
  home.addContainer({
    Id: 'db-id',
    Name: '/app-db-1',
    Image: 'sha256:db',
    Config: {
      Image: 'postgres:17',
      Env: [SECRET],
      Labels: {
        [COMPOSE]: 'app',
        'com.docker.compose.service': 'db',
        'com.docker.compose.project.working_dir': root,
      },
    },
    HostConfig: {
      NetworkMode: 'app_default',
      Mounts: [{ Type: 'volume', Source: 'app_db', Target: '/var/lib/postgresql/data' }],
    },
    NetworkSettings: { Networks: { app_default: { Aliases: ['db'] } } },
    Mounts: [
      volumeMount('app_db', '/var/lib/postgresql/data'),
      volumeMount('anon0123', '/scratch'),
    ],
    running: true,
  });
  home.addContainer({
    Id: 'runner-id',
    Name: '/runner',
    Image: 'sha256:web',
    Config: { Image: 'app-web:latest', Env: [SECRET] },
    HostConfig: { Binds: [`${state}:/state`] },
    Mounts: [{ Type: 'bind', Source: state, Destination: '/state', RW: true }],
    running: true,
  });
  home.addContainer({
    Id: 'tmp-id',
    Name: '/tmp-job',
    Image: 'sha256:web',
    Config: { Image: 'app-web:latest' },
    HostConfig: { AutoRemove: true, Binds: ['cache:/cache'] },
    Mounts: [volumeMount('cache', '/cache')],
    running: true,
  });
  home.addContainer({
    Id: 'other-id',
    Name: '/unrelated',
    Image: 'sha256:web',
    Config: { Image: 'app-web:latest' },
    HostConfig: {},
    Mounts: [],
    running: true,
  });
}

const selection = {
  items: [
    { id: 'db-id', mode: 'container-and-data' as const, dataChoice: 'replace-home' as const },
    { id: 'runner-id', mode: 'container-and-data' as const, dataChoice: 'replace-home' as const },
    { id: 'tmp-id', mode: 'data-only' as const, dataChoice: 'replace-home' as const },
  ],
};

function operation(stepStates: Record<string, string> = {}): RemoteOperation {
  return {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    kind: 'attach',
    remoteId: REMOTE,
    projectId: PROJECT,
    state: 'running',
    steps: Object.entries(stepStates).map(([id, s]) => ({ id, state: s })),
    details: {},
  } as unknown as RemoteOperation;
}
let details: Record<string, unknown>;
function run(stepStates: Record<string, string> = {}): RemoteOperationStepRun {
  return {
    operation: operation(stepStates),
    details,
    progress: async (patch) => {
      progress.push(structuredClone(patch));
      Object.assign(details, patch);
    },
  };
}
async function connect(): Promise<void> {
  await handoff.preflight(run());
  await handoff.stopHome(run());
  await handoff.push(run());
  await handoff.createHost(run());
}
const vmContainer = (name: string) =>
  [...vm.containers.values()].find((c) => c.Name === `/${name}`);
const docker = () => details.docker as DockerTransferDetails;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'docker-handoff-'));
  fixture = await mkdtemp(join(homedir(), '.docker-handoff-test-'));
  root = join(fixture, 'project');
  state = join(root, 'state');
  await mkdir(state, { recursive: true });
  details = { dockerSelection: selection };
  progress = [];
  inventory = new Map();
  exclusions = new Map();

  home = new FakeDockerEngine('home-engine');
  vm = new FakeDockerEngine('vm-engine');
  await home.listen(join(scratch, 'home.sock'));
  await vm.listen(join(scratch, 'vm.sock'));
  seedHome();
  savedDockerHost = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = `unix://${join(scratch, 'home.sock')}`;
  // Only the VM's host service uses connect(); home resolves DOCKER_HOST itself.
  jest
    .spyOn(DockerEngineClient, 'connect')
    .mockImplementation(async () => new DockerEngineClient(join(scratch, 'vm.sock')));

  const module = await Test.createTestingModule({
    controllers: [HostDockerController],
    providers: [
      HostDockerService,
      HostDockerBodyParser,
      { provide: DockerArchiveJournal, useValue: new DockerArchiveJournal(join(scratch, 'vm')) },
    ],
  }).compile();
  app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ bodyLimit: 1024, logger: false }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  installFixtureTlsFront(app);
  await app.listen(0, '127.0.0.1');
  const baseUrl = (await app.getUrl()).replace(/^http:/, 'https:');
  const client = new RemoteHostClient(
    {
      getRemote: async () => ({
        id: REMOTE,
        name: 'vm',
        baseUrl,
        tlsCertificate: fixtureTls.cert,
      }),
    } as never,
    { get: async () => null, headers: async () => ({}) } as never,
  );
  jest.spyOn(client, 'remoteRuntime').mockResolvedValue({
    homePath: homedir(),
    uid: process.getuid?.() ?? 1000,
    docker: {
      installed: true,
      engineVersion: '29.7.2',
      composeVersion: '5.5.1',
      userInGroup: true,
      dataRootFreeBytes: 1e12,
      capacity: {
        dockerRoot: { path: '/var/lib/docker', filesystemId: 'root', freeBytes: 1e12 },
        imageStore: { path: '/var/lib/docker', filesystemId: 'root', freeBytes: 1e12 },
        home: { path: homedir(), filesystemId: 'home', freeBytes: 1e12 },
      },
    },
  });
  const source = new DockerPlanSourceService();
  jest.spyOn(source, 'compose').mockResolvedValue(null);
  const inventoryStore = {
    delete: (p: string, r: string) => inventory.delete(`${p}/${r}`),
    get: (p: string, r: string) => inventory.get(`${p}/${r}`) ?? null,
    set: (p: string, r: string, value: DockerImportInventory) => {
      inventory.set(`${p}/${r}`, value);
      return value;
    },
  };
  plans = new DockerPlanService(
    {
      getProject: async () => ({ id: PROJECT, rootPath: root }),
      getRemote: async () => ({ id: REMOTE }),
    } as never,
    source,
    client,
    inventoryStore as never,
  );
  store = new DockerHandoffStore(join(scratch, 'home'));
  handoff = new DockerHandoff(
    plans,
    source,
    client,
    store,
    new DockerArchiveJournal(join(scratch, 'home')),
    {
      set: (p: string, patterns: string[] | null) => exclusions.set(p, patterns ?? []),
      get: (p: string) => exclusions.get(p) ?? [],
    } as never,
    inventoryStore as never,
  );
});
afterEach(async () => {
  if (savedDockerHost === undefined) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = savedDockerHost;
  jest.restoreAllMocks();
  await app?.close();
  await home.close();
  await vm.close();
  await rm(scratch, { recursive: true, force: true });
  await rm(fixture, { recursive: true, force: true });
});

it('copies Compose and docker run items, keeps --rm data only, and creates everything stopped', async () => {
  await writeFile(join(state, 'vm-only.txt'), 'left on the VM');
  await connect();

  expect(new Set(vm.images.keys())).toEqual(new Set(['sha256:db', 'sha256:web']));
  expect(vm.images.get('sha256:db')?.tags).toEqual(['postgres:17']);
  for (const [name, data] of [
    ['app_db', 'home-db-rows'],
    ['anon0123', 'home-anonymous'],
    ['cache', 'home-cache'],
  ])
    expect(vm.data.get(name)?.toString()).toBe(data);
  expect(vm.volumes.get('app_db')?.labels).toEqual({
    [COMPOSE]: 'app',
    'com.docker.compose.volume': 'db',
    [OWNER]: PROJECT,
  });
  expect(vm.data.get(state)?.toString()).toBe('home-state');
  expect(existsSync(join(state, 'vm-only.txt'))).toBe(false);
  expect(vm.networks.get('app_default')?.labels).toMatchObject({
    [COMPOSE]: 'app',
    [OWNER]: PROJECT,
  });

  const db = vmContainer('app-db-1')!;
  expect(db.State.Running).toBe(false);
  expect(db.Image).toBe('sha256:db');
  expect(db.Config.Labels).toMatchObject({ [COMPOSE]: 'app', [OWNER]: PROJECT });
  expect((db.created!.HostConfig as { Mounts: unknown[] }).Mounts).toEqual([
    expect.objectContaining({ Source: 'app_db', VolumeOptions: { NoCopy: true } }),
    expect.objectContaining({
      Source: 'anon0123',
      Target: '/scratch',
      VolumeOptions: { NoCopy: true },
    }),
  ]);
  expect(vmContainer('runner')?.State.Running).toBe(false);
  expect(vmContainer('tmp-job')).toBeUndefined();
  expect([...vm.containers.values()].filter((c) => c.Name.startsWith('/devchain-archive'))).toEqual(
    [],
  );

  expect(home.containers.get('db-id')?.State.Running).toBe(false);
  expect(home.containers.get('runner-id')?.State.Running).toBe(false);
  expect(home.containers.has('tmp-id')).toBe(false);
  expect(home.containers.get('other-id')?.State.Running).toBe(true);
  expect(home.volumes.has('cache')).toBe(true);

  expect(exclusions.get(PROJECT)).toEqual(['/state']);
  expect(inventory.get(`${PROJECT}/${REMOTE}`)).toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({ name: 'runner', bindPaths: ['/state'] }),
      expect.objectContaining({
        name: 'app-db-1',
        volumes: expect.arrayContaining([{ name: 'app_db', sizeBytes: 12 }]),
      }),
      expect.objectContaining({ name: 'tmp-job', volumes: [{ name: 'cache', sizeBytes: 10 }] }),
    ]),
  });
  expect(docker()).toMatchObject({
    bytesDone: docker().bytesTotal,
    result: { withoutData: [], dataOnly: ['tmp-job'] },
    item: null,
  });
  expect(
    progress.some((p) => (p.docker as DockerTransferDetails | undefined)?.item?.phase === 'bind'),
  ).toBe(true);

  const settings = join(scratch, 'home', 'docker-operations', `${operation().id}.settings.json`);
  expect((await stat(settings)).mode & 0o777).toBe(0o600);
  const record = await store.read(operation().id);
  expect(JSON.stringify([details, progress, record])).not.toContain('never-leak-this');
  await handoff.finish(operation().id);
  expect(await readdir(join(scratch, 'home', 'docker-operations'))).toEqual([]);
});

it('refuses in docker_preflight before anything is stopped', async () => {
  vm.addContainer({
    Id: 'vm-runner',
    Name: '/runner',
    Image: 'x',
    Config: { Labels: {} },
    HostConfig: {},
    Mounts: [],
  });
  await expect(handoff.preflight(run())).rejects.toMatchObject({
    code: 'DOCKER_PLAN_REFUSED',
    message: expect.stringContaining('runner'),
  });
  expect(home.calls.filter((c) => c.endsWith('/stop'))).toEqual([]);
  expect([...home.containers.values()].every((c) => c.State.Running)).toBe(true);
  expect(await store.read(operation().id)).toBeNull();
  expect(exclusions.has(PROJECT)).toBe(false);
});

it('recreates a partially restored volume on retry instead of overlaying it', async () => {
  await handoff.preflight(run());
  await handoff.stopHome(run());
  let failed = false;
  vm.intercept = (method, path, res) => {
    const helper = [...vm.containers.values()].find((c) =>
      c.Mounts.some((m) => m.Destination === '/data' && m.Name === 'app_db'),
    );
    if (!failed && method === 'PUT' && helper && path === `/containers/${helper.Id}/archive`) {
      failed = true;
      vm.data.set('app_db', Buffer.from('PARTIAL'));
      res.statusCode = 500;
      res.end('{"message":"disk full: ' + SECRET + '"}');
      return true;
    }
    return false;
  };
  const error = await handoff.push(run()).catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect(String((error as Error).message)).not.toContain('never-leak-this');
  expect(vm.data.get('app_db')?.toString()).toBe('PARTIAL');

  vm.calls.length = 0;
  await handoff.push(run());
  const deleted = vm.calls.indexOf('DELETE /volumes/app_db');
  expect(deleted).toBeGreaterThanOrEqual(0);
  expect(vm.calls.indexOf('POST /volumes/create')).toBeGreaterThan(deleted);
  expect(vm.data.get('app_db')?.toString()).toBe('home-db-rows');
  // Verified items are not copied again.
  expect(vm.calls).not.toContain('POST /images/load');
});

it('reconciles lost image-load and container-create answers on retry', async () => {
  await handoff.preflight(run());
  await handoff.stopHome(run());
  let loadLost = false;
  vm.loseResponse = (method, path) => {
    if (!loadLost && path === '/images/load') return (loadLost = true);
    return false;
  };
  await expect(handoff.push(run())).rejects.toBeInstanceOf(Error);
  expect(vm.images.size).toBe(1);
  vm.calls.length = 0;
  await handoff.push(run());
  // The loaded image is verified by ID rather than sent again.
  expect(vm.calls.filter((c) => c === 'POST /images/load')).toHaveLength(1);

  let createLost = false;
  vm.loseResponse = (method, path, search) => {
    if (createLost || path !== '/containers/create' || search.get('name') !== 'runner')
      return false;
    return (createLost = true);
  };
  await expect(handoff.createHost(run())).rejects.toBeInstanceOf(Error);
  vm.loseResponse = undefined;
  await handoff.createHost(run());
  const named = [...vm.containers.values()].filter((c) => !c.Name.startsWith('/devchain-archive'));
  expect(named.map((c) => c.Name).sort()).toEqual(['/app-db-1', '/runner']);
});

it('cancel removes only attempt items and restarts only the running non --rm sources it stopped', async () => {
  home.containers.get('runner-id')!.State.Running = false;
  vm.volumes.set('kept', { labels: { [OWNER]: PROJECT }, driver: 'local' });
  await handoff.preflight(run());
  await handoff.stopHome(run());
  await handoff.push(run());
  vm.intercept = (method, path, res) => {
    if (method === 'POST' && path === '/containers/create' && vm.containers.size > 0) {
      res.statusCode = 500;
      res.end('{}');
      return true;
    }
    return false;
  };
  await handoff.createHost(run()).catch(() => undefined);
  vm.intercept = undefined;

  const result = await handoff.rollback(
    operation({ docker_push: 'done', docker_create_host: 'failed' }),
  );
  expect(result).toEqual({});
  expect([...vm.volumes.keys()]).toEqual(['kept']);
  expect(
    [...vm.containers.values()].filter((c) => !c.Name.startsWith('/devchain-archive')),
  ).toEqual([]);
  expect(home.containers.get('db-id')?.State.Running).toBe(true);
  // It was stopped before the operation, and `--rm` sources are never restarted.
  expect(home.containers.get('runner-id')?.State.Running).toBe(false);
  expect(home.calls).not.toContain('POST /containers/tmp-id/start');
  expect(await store.read(operation().id)).toBeNull();
});

it('reconnect replaces labelled volumes and the owned subtree and removes the Compose holder', async () => {
  vm.volumes.set('app_db', { labels: { [OWNER]: PROJECT, [COMPOSE]: 'app' }, driver: 'local' });
  vm.data.set('app_db', Buffer.from('vm-only-rows'));
  vm.addContainer({
    Id: 'vm-db',
    Name: '/app-db-1',
    Image: 'sha256:db',
    Config: { Labels: { [COMPOSE]: 'app' } },
    HostConfig: {},
    Mounts: [volumeMount('app_db', '/var/lib/postgresql/data')],
    running: true,
  });
  await writeFile(join(state, 'vm-only.txt'), 'VM change never copied back');
  inventory.set(`${PROJECT}/${REMOTE}`, {
    importedAt: '2026-09-01T00:00:00.000Z',
    items: [
      {
        name: 'app-db-1',
        imageId: 'sha256:db',
        volumes: [{ name: 'app_db', sizeBytes: 12 }],
        bindPaths: [],
        sizeBytes: 12,
      },
      { name: 'runner', imageId: 'sha256:web', volumes: [], bindPaths: ['/state'], sizeBytes: 5 },
    ],
  });
  await handoff.preflight(run());
  expect(docker().replaced.sort()).toEqual(['app-db-1', 'runner']);
  await handoff.stopHome(run());
  await handoff.push(run());
  await handoff.createHost(run());

  expect(vm.containers.has('vm-db')).toBe(false);
  expect(vmContainer('app-db-1')?.State.Running).toBe(false);
  expect(vm.data.get('app_db')?.toString()).toBe('home-db-rows');
  expect(existsSync(join(state, 'vm-only.txt'))).toBe(false);
  expect((await store.read(operation().id))?.replaced).toEqual(['app_db']);
});

it('a folder the clear helper cannot empty fails the step before any restore, naming the folder', async () => {
  await writeFile(join(state, 'vm-only.txt'), 'VM change never copied back');
  vm.clearExitCode = 1;
  await handoff.preflight(run());
  await handoff.stopHome(run());
  await handoff.push(run());
  const before = vm.calls.length;
  await expect(handoff.createHost(run())).rejects.toMatchObject({
    code: 'DOCKER_BIND_CLEAR_FAILED',
    message: expect.stringContaining(`The VM folder ${state} could not be emptied`),
  });
  const during = vm.calls.slice(before);
  expect(during.some((call) => call.startsWith('PUT') && call.includes('/archive'))).toBe(false);
  expect(vmContainer('app-db-1')).toBeUndefined();
  expect(vmContainer('runner')).toBeUndefined();
  expect(vm.data.has(state)).toBe(false);
  expect(existsSync(join(state, 'vm-only.txt'))).toBe(true);
  expect([...vm.containers.values()].filter((c) => c.Name.startsWith('/devchain-archive'))).toEqual(
    [],
  );
  expect((await store.read(operation().id))?.verified.binds).toEqual([]);
});

it('a reconnect of a subset keeps an earlier item folder excluded and in the inventory', async () => {
  const earlier = {
    name: 'runner',
    imageId: 'sha256:web',
    volumes: [],
    bindPaths: ['/state'],
    sizeBytes: 5,
  };
  inventory.set(`${PROJECT}/${REMOTE}`, {
    importedAt: '2026-09-01T00:00:00.000Z',
    items: [earlier],
  });
  details = { dockerSelection: { items: [{ id: 'db-id', mode: 'container-and-data' }] } };
  await handoff.preflight(run());
  expect(exclusions.get(PROJECT)).toEqual(['/state']);
  await handoff.stopHome(run());
  await handoff.push(run());
  await handoff.createHost(run());
  expect(
    inventory
      .get(`${PROJECT}/${REMOTE}`)
      ?.items.map((i) => i.name)
      .sort(),
  ).toEqual(['app-db-1', 'runner']);
  expect(inventory.get(`${PROJECT}/${REMOTE}`)?.items.find((i) => i.name === 'runner')).toEqual(
    earlier,
  );
});

it('records the exclusions an attempt replaces once, and refuses too many before stopping', async () => {
  exclusions.set(PROJECT, ['/live-data']);
  await handoff.preflight(run());
  expect(details.managedExclusionsBefore).toEqual(['/live-data']);
  expect(exclusions.get(PROJECT)).toEqual(['/state']);
  // A retried preflight must not take the attempt's own set for the previous one.
  await handoff.preflight(run());
  expect(details.managedExclusionsBefore).toEqual(['/live-data']);

  inventory.set(`${PROJECT}/${REMOTE}`, {
    importedAt: '2026-09-01T00:00:00.000Z',
    items: [
      {
        name: 'many',
        imageId: 'sha256:web',
        volumes: [],
        bindPaths: Array.from({ length: 200 }, (_, i) => `/data-${i}`),
        sizeBytes: 0,
      },
    ],
  });
  await expect(handoff.preflight(run())).rejects.toMatchObject({
    code: 'DOCKER_TOO_MANY_DATA_FOLDERS',
  });
  expect(home.containers.get('db-id')?.State.Running).toBe(true);
});

it('cancel names a home container that cannot start and still removes the attempt items', async () => {
  await handoff.preflight(run());
  await handoff.stopHome(run());
  await handoff.push(run());
  home.intercept = (method, path, res) => {
    if (method === 'POST' && path === '/containers/db-id/start') {
      res.statusCode = 500;
      res.end('{}');
      return true;
    }
    return false;
  };
  const result = await handoff.rollback(operation({ docker_push: 'failed' }));
  home.intercept = undefined;
  expect(result).toEqual({ dockerNotRestarted: ['app-db-1'] });
  expect([...vm.volumes.keys()]).toEqual([]);
  expect(await store.read(operation().id)).toBeNull();
});

it('cancel gives up on a start that never answers, names it, and starts the others', async () => {
  await handoff.preflight(run());
  await handoff.stopHome(run());
  await handoff.push(run());
  handoff.rollbackLimits = { ...handoff.rollbackLimits, homeStartMs: 300 };
  // The start request is accepted but never answered, like a stuck container start.
  home.intercept = (method, path) => method === 'POST' && path === '/containers/db-id/start';
  const result = await handoff.rollback(operation({ docker_push: 'failed' }));
  home.intercept = undefined;
  expect(result).toEqual({ dockerNotRestarted: ['app-db-1'] });
  // One stuck start does not keep the other stopped containers from starting.
  expect(home.containers.get('runner-id')?.State.Running).toBe(true);
  expect([...vm.volumes.keys()]).toEqual([]);
  expect(await store.read(operation().id)).toBeNull();
});

it('cancel reports a VM cleanup that does not finish in time and still restarts home', async () => {
  await handoff.preflight(run());
  await handoff.stopHome(run());
  await handoff.push(run());
  handoff.rollbackLimits = { ...handoff.rollbackLimits, vmCleanupMs: 300 };
  vm.intercept = (method, path) => method === 'DELETE' && path.startsWith('/volumes/');
  const result = await handoff.rollback(operation({ docker_push: 'failed' }));
  vm.intercept = undefined;
  expect(result).toEqual({
    dockerCleanupError:
      'The VM Docker cleanup did not finish in time. Remove the remaining Docker items of this project on the VM.',
  });
  expect(home.containers.get('db-id')?.State.Running).toBe(true);
  expect(await store.read(operation().id)).toBeNull();
});

it('a cancelled reconnect keeps a network an earlier import created', async () => {
  vm.networks.set('app_default', {
    labels: { [COMPOSE]: 'app', [OWNER]: PROJECT },
    driver: 'bridge',
    internal: false,
  });
  await handoff.preflight(run());
  await handoff.stopHome(run());
  await handoff.push(run());
  await handoff.createHost(run());
  expect((await store.read(operation().id))?.created.networks).toEqual([]);
  await handoff.rollback(operation({ docker_push: 'done', docker_create_host: 'done' }));
  expect(vm.networks.has('app_default')).toBe(true);

  // A network this attempt created is its own and goes with the cancel. The first
  // cycle's stop removed the --rm source, so it is no longer selectable.
  vm.networks.delete('app_default');
  details = {
    dockerSelection: {
      items: [
        { id: 'db-id', mode: 'container-and-data' },
        { id: 'runner-id', mode: 'container-and-data', dataChoice: 'replace-home' },
      ],
    },
  };
  await handoff.preflight(run());
  await handoff.stopHome(run());
  await handoff.push(run());
  await handoff.createHost(run());
  expect((await store.read(operation().id))?.created.networks).toEqual(['app_default']);
  await handoff.rollback(operation({ docker_push: 'done', docker_create_host: 'done' }));
  expect(vm.networks.has('app_default')).toBe(false);
});

it('docker_stop_host stops only the project DevChain containers on the VM', async () => {
  vm.addContainer({
    Id: 'vm-owned',
    Name: '/owned',
    Image: 'x',
    Config: { Labels: { [OWNER]: PROJECT } },
    HostConfig: {},
    Mounts: [],
    running: true,
  });
  vm.addContainer({
    Id: 'vm-other',
    Name: '/other',
    Image: 'x',
    Config: { Labels: {} },
    HostConfig: {},
    Mounts: [],
    running: true,
  });
  await handoff.stopHost(run());
  expect(vm.containers.get('vm-owned')?.State.Running).toBe(true);

  inventory.set(`${PROJECT}/${REMOTE}`, { importedAt: '2026-09-01T00:00:00.000Z', items: [] });
  await handoff.stopHost(run());
  expect(vm.containers.get('vm-owned')?.State.Running).toBe(false);
  expect(vm.containers.get('vm-other')?.State.Running).toBe(true);
});

it('docker_stop_host lets the Disconnect continue when the VM engine is down', async () => {
  inventory.set(`${PROJECT}/${REMOTE}`, { importedAt: '2026-09-01T00:00:00.000Z', items: [] });
  jest
    .mocked(DockerEngineClient.connect)
    .mockRejectedValue(new DockerEngineError('unavailable', 'Docker engine connection failed'));
  await handoff.stopHost(run());
  expect(details.dockerStopSkipped).toEqual(expect.any(String));
});

// Existing fake-engine integration is the cheapest layer proving verified copies and durable rollback together.
it('stamps only after create, keeps the retry baseline, and restores the prior inventory on cancel', async () => {
  const previous: DockerImportInventory = {
    importedAt: '2026-09-01T00:00:00.000Z',
    items: [],
    groups: [],
  };
  inventory.set(`${PROJECT}/${REMOTE}`, previous);
  await handoff.preflight(run());
  await handoff.stopHome(run());
  await handoff.push(run());
  expect(inventory.get(`${PROJECT}/${REMOTE}`)).toEqual(previous);
  await handoff.createHost(run());
  const synced = structuredClone(inventory.get(`${PROJECT}/${REMOTE}`)!);
  expect(synced.groups).toHaveLength(3);
  expect(synced.groups?.every((g) => g.lastSyncDirection === 'to-vm')).toBe(true);
  await handoff.createHost(run());
  expect(inventory.get(`${PROJECT}/${REMOTE}`)?.groups).toEqual(synced.groups);
  await handoff.rollback(operation({ docker_push: 'done', docker_create_host: 'done' }));
  expect(inventory.get(`${PROJECT}/${REMOTE}`)).toEqual(previous);
});
it('does not stamp fresh empty volumes copied without data', async () => {
  details.dockerSelection = { items: [{ id: 'db-id', mode: 'without-data' }] };
  await connect();
  expect(inventory.get(`${PROJECT}/${REMOTE}`)?.groups).toEqual([]);
});

it('keeps earlier baselines for without-data and unselected groups', async () => {
  const groups = [
    {
      volumes: ['app_db', 'anon0123'],
      bindPaths: [],
      lastSyncedAt: '2026-09-01T00:00:00.000Z',
      lastSyncDirection: 'to-home' as const,
    },
    {
      volumes: [],
      bindPaths: [state],
      lastSyncedAt: '2026-09-02T00:00:00.000Z',
      lastSyncDirection: 'to-vm' as const,
    },
  ];
  inventory.set(`${PROJECT}/${REMOTE}`, {
    items: [],
    groups,
    importedAt: '2026-09-02T00:00:00.000Z',
  });
  details.dockerSelection = { items: [{ id: 'db-id', mode: 'without-data' }] };
  await connect();
  expect(inventory.get(`${PROJECT}/${REMOTE}`)?.groups).toEqual(groups);
});

async function seedKeptData(homeRunning: boolean, vmRunning: boolean, known = true): Promise<void> {
  const old = '2026-08-01T00:00:00.000Z';
  for (const c of home.containers.values())
    Object.assign(c, { Created: old, State: { Running: homeRunning, StartedAt: old } });
  for (const name of ['app_db', 'anon0123']) {
    vm.volumes.set(name, { labels: { [OWNER]: PROJECT, [COMPOSE]: 'app' }, driver: 'local' });
    vm.data.set(name, Buffer.from(`vm-preserved-${name}`));
  }
  vm.data.set(state, Buffer.from('vm-preserved-state'));
  await writeFile(join(state, 'vm-only.txt'), 'preserved');
  vm.addContainer({
    Id: 'vm-db',
    Name: '/app-db-1',
    Image: 'sha256:db',
    Config: { Labels: { [OWNER]: PROJECT } },
    HostConfig: {},
    Mounts: [
      volumeMount('app_db', '/db'),
      volumeMount('anon0123', '/scratch'),
      { Type: 'bind', Source: state, Destination: '/state', RW: true },
    ],
    Created: old,
    running: vmRunning,
    startedAt: old,
  });
  const lastSyncedAt = '2026-09-01T00:00:00.000Z';
  inventory.set(`${PROJECT}/${REMOTE}`, {
    importedAt: lastSyncedAt,
    items: [],
    ...(known && {
      groups: [
        {
          volumes: ['app_db', 'anon0123'],
          bindPaths: [],
          lastSyncedAt,
          lastSyncDirection: 'to-vm' as const,
        },
        { volumes: [], bindPaths: [state], lastSyncedAt, lastSyncDirection: 'to-vm' as const },
      ],
    }),
  });
  details.dockerSelection = {
    items: [
      { id: 'db-id', mode: 'container-and-data' },
      { id: 'runner-id', mode: 'container-and-data' },
    ],
  };
}

it.each(['in-sync', 'vm-newer'] as const)(
  'keeps %s data by default while loading missing images and creating a missing container',
  async (expected) => {
    await seedKeptData(false, expected === 'vm-newer');
    const plan = await plans.plan(
      PROJECT,
      { remoteId: REMOTE, ...(details.dockerSelection as object) },
      undefined,
      { estimate: false },
    );
    expect(
      plan.dataGroups
        ?.filter((g) => g.itemIds.includes('db-id') || g.itemIds.includes('runner-id'))
        .map((g) => g.state),
    ).toEqual([expected, expected]);
    await connect();
    const record = (await store.read(operation().id))!;
    expect(record.volumes).toEqual([]);
    expect(record.binds).toEqual([]);
    expect(record.items.every((i) => !i.volumes.length && !i.binds.length)).toBe(true);
    expect(record.stopIds).toEqual(expect.arrayContaining(['db-id', 'runner-id']));
    expect(vm.data.get('app_db')?.toString()).toBe('vm-preserved-app_db');
    expect(vm.data.get('anon0123')?.toString()).toBe('vm-preserved-anon0123');
    expect(vm.data.get(state)?.toString()).toBe('vm-preserved-state');
    expect(existsSync(join(state, 'vm-only.txt'))).toBe(true);
    expect(vm.containers.has('vm-db')).toBe(true);
    expect(vmContainer('runner')).toBeDefined();
    expect(vm.images.has('sha256:web')).toBe(true);
    expect(vm.calls.some((c) => c.startsWith('PUT') && c.includes('/archive'))).toBe(false);
    expect(
      vm.calls.some(
        (c) => c.startsWith('DELETE') && (c.includes('/volumes/') || c.includes('vm-db')),
      ),
    ).toBe(false);
  },
);

it.each(['both-changed', 'unknown'] as const)(
  'blocks %s data until a choice and records Keep without inventing a copy stamp',
  async (state) => {
    await seedKeptData(true, true, state !== 'unknown');
    await expect(handoff.preflight(run())).rejects.toMatchObject({ code: 'DOCKER_PLAN_REFUSED' });
    details.dockerSelection = {
      items: [
        { id: 'db-id', mode: 'container-and-data', dataChoice: 'keep-vm' },
        { id: 'runner-id', mode: 'container-and-data', dataChoice: 'keep-vm' },
      ],
    };
    await connect();
    const groups = inventory.get(`${PROJECT}/${REMOTE}`)?.groups ?? [];
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => Boolean(g.homeDiscardedAt))).toBe(true);
    expect(groups.map((g) => g.lastSyncedAt)).toEqual(
      state === 'unknown'
        ? [undefined, undefined]
        : ['2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    );
    expect(home.containers.get('db-id')?.State.Running).toBe(false);
    expect(home.containers.get('runner-id')?.State.Running).toBe(false);
    const next = await plans.plan(
      PROJECT,
      {
        remoteId: REMOTE,
        items: [
          { id: 'db-id', mode: 'container-and-data' },
          { id: 'runner-id', mode: 'container-and-data' },
        ],
      },
      undefined,
      { estimate: false },
    );
    expect(next.canConnect).toBe(true);
    expect(
      next.dataGroups
        ?.filter((g) => g.itemIds.includes('db-id') || g.itemIds.includes('runner-id'))
        .every((g) => ['in-sync', 'vm-newer'].includes(g.state)),
    ).toBe(true);
    expect(vm.data.get('app_db')?.toString()).toBe('vm-preserved-app_db');
  },
);

it('creates a missing kept volume empty without replacing the surviving volume', async () => {
  await seedKeptData(false, true);
  vm.volumes.delete('anon0123');
  vm.data.delete('anon0123');
  const existing = vm.containers.get('vm-db')!;
  existing.Mounts = existing.Mounts.filter((m) => m.Name !== 'anon0123');
  await connect();
  const record = (await store.read(operation().id))!;
  expect(record.ensureVolumes).toEqual(['anon0123']);
  expect(record.volumes).toEqual([]);
  expect(vm.volumes.get('anon0123')?.labels[OWNER]).toBe(PROJECT);
  expect(vm.data.get('anon0123')).toBeUndefined();
  expect(vm.data.get('app_db')?.toString()).toBe('vm-preserved-app_db');
  await handoff.rollback(operation({ docker_push: 'done', docker_create_host: 'done' }));
  expect(vm.volumes.has('anon0123')).toBe(false);
  expect(vm.data.get('app_db')?.toString()).toBe('vm-preserved-app_db');
});

it.each(['home-newer', 'both-changed', 'unknown'] as const)(
  'replaces %s data with the required authorization',
  async (dataState) => {
    await seedKeptData(true, dataState !== 'home-newer', dataState !== 'unknown');
    if (dataState !== 'home-newer')
      details.dockerSelection = {
        items: [
          { id: 'db-id', mode: 'container-and-data', dataChoice: 'replace-home' },
          { id: 'runner-id', mode: 'container-and-data', dataChoice: 'replace-home' },
        ],
      };
    await connect();
    expect(vm.data.get('app_db')?.toString()).toBe('home-db-rows');
    expect(existsSync(join(state, 'vm-only.txt'))).toBe(false);
  },
);
