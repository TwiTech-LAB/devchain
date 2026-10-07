import { Scope } from '@nestjs/common';
// Fake engines on both sides; the VM side runs the real host routes behind the real LAN client.
import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Header } from 'tar';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { FakeDockerEngine, type FakeMount } from '../../../common/test/fake-docker-engine.server';
import { fixtureTls, installFixtureTlsFront } from '../../../common/test/tls-fixture';
import { DockerArchiveJournal } from '../../core/controllers/docker-archive-journal';
import { DockerEngineClient, DockerEngineError } from '../../core/controllers/docker-engine.client';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { HostDockerController } from '../host/host-docker.controller';
import { HostDockerService } from '../host/host-docker.service';
import { HOST_IPV4_ROUTES } from '../host/host-ipv4-routes';
import { HostDockerBodyParser } from '../host/host-docker-body.parser';
import { DockerScanRequestSchema } from '../host/host-docker.dto';
import type { DockerImportInventory } from '../operations/docker-import-inventory.store';
import { RemoteHostClient } from '../operations/remote-host.client';
import type { RemoteOperationStepRun } from '../operations/remote-operation.types';
import { DockerHandoff } from './docker-handoff';
import { DockerHandoffStore } from './docker-handoff.store';
import type { DockerTransferDetails } from './docker-plan.dto';
import { DockerPlanService } from './docker-plan.service';
import { DockerPlanSourceService } from './docker-plan-source.service';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { ConnectChoicesStore } from '../connect-choices.store';

const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REMOTE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECRET = 'POSTGRES_PASSWORD=never-leak-this';
const OWNER = 'dev.devchain.project';
const COMPOSE = 'com.docker.compose.project';

let scratch: string;
let fixture: string;
let git: FakeProcessExecutor;
let source: DockerPlanSourceService;
let sourceModule: TestingModule;
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
let host: RemoteHostClient;
let homeJournal: DockerArchiveJournal;
let legacyNetworkScan: boolean;
let choices: ConnectChoicesStore;
let choicesDatabase: ReturnType<typeof createTestDatabase>;
let imageMatchStatus: number | undefined;
let vmRoutes: string[];

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

// Real host routes and fake engines verify that classification controls the actual copy and create steps.
it.each<{
  name: string;
  homeUser: string;
  tmpfs?: boolean;
}>([
  { name: 'uid and gid', homeUser: '1000:1000' },
  { name: 'uid only', homeUser: '1000' },
  { name: 'another explicit gid', homeUser: '1000:0' },
  { name: 'a tmpfs mount', homeUser: '1000:1000', tmpfs: true },
])(
  'creates a VM container with $name while file sync carries its tracked bind',
  async ({ homeUser, tmpfs }) => {
    jest.spyOn(source, 'uid').mockReturnValue(1000);
    jest.spyOn(source, 'gid').mockReturnValue(1000);
    jest.mocked(host.remoteRuntime).mockResolvedValue({
      ...(await host.remoteRuntime(REMOTE)),
      uid: 1000,
      gid: 1000,
    });
    const runner = home.containers.get('runner-id')!;
    runner.Config.User = homeUser;
    runner.HostConfig.GroupAdd = ['0', '42'];
    if (tmpfs) runner.HostConfig.Tmpfs = { '/tmp': 'rw,mode=700' };
    git.setDefaultResponse({ type: 'success', stdout: 'state/main.py\0' });
    details.dockerSelection = { items: [{ id: 'runner-id', mode: 'container-and-data' }] };
    const plan = await plans.plan(PROJECT, {
      remoteId: REMOTE,
      ...(details.dockerSelection as object),
    });
    expect(plan.managedExclusions).toEqual([]);
    await connect();
    expect(exclusions.get(PROJECT)).toEqual([]);
    expect((await store.read(operation().id))?.binds).toEqual([]);
    expect(home.calls.some((call) => call.endsWith('/archive'))).toBe(false);
    expect(vm.calls.some((call) => call.includes('/archive'))).toBe(false);
    expect(vmContainer('runner')?.HostConfig.Binds).toEqual([`${state}:/state`]);
    expect(vmContainer('runner')?.created?.User).toBe(homeUser);
    expect(vmContainer('runner')?.HostConfig.GroupAdd).toEqual(['0', '42']);
    expect(runner.Config.User).toBe(homeUser);
    expect(vmContainer('runner')?.State.Running).toBe(false);
    expect(
      inventory.get(`${PROJECT}/${REMOTE}`)?.items.find((item) => item.name === 'runner')
        ?.bindPaths,
    ).toEqual([]);
  },
);

// The real handoff and host routes must retain both the user and the archive's numeric owners.
it('keeps the home user for a read-only volume containing a 0600 file', async () => {
  jest.spyOn(source, 'uid').mockReturnValue(1000);
  jest.spyOn(source, 'gid').mockReturnValue(1000);
  jest.mocked(host.remoteRuntime).mockResolvedValue({
    ...(await host.remoteRuntime(REMOTE)),
    uid: 1000,
    gid: 1000,
  });
  const header = new Header({
    path: 'private',
    type: 'File',
    uid: 1000,
    gid: 1000,
    mode: 0o600,
    size: 6,
  });
  header.encode();
  const contents = Buffer.alloc(512);
  contents.write('secret');
  const archive = Buffer.concat([header.block!, contents, Buffer.alloc(1024)]);
  home.data.set('app_db', archive);
  const runner = home.containers.get('runner-id')!;
  runner.Config.User = '1000:1000';
  (runner.HostConfig.Binds as string[]).push('app_db:/private:ro');
  runner.Mounts.push({ ...volumeMount('app_db', '/private'), RW: false });
  git.setDefaultResponse({ type: 'success', stdout: 'state/main.py\0' });
  details.dockerSelection = { items: [{ id: 'runner-id', mode: 'container-and-data' }] };
  const plan = await plans.plan(PROJECT, {
    remoteId: REMOTE,
    ...(details.dockerSelection as object),
  });
  expect(
    plan.items.find((entry) => entry.id === 'runner-id')!.mounts.some((mount) => mount.readOnly),
  ).toBe(true);
  await connect();
  expect(vmContainer('runner')?.created?.User).toBe('1000:1000');
  expect(vmContainer('runner')?.Mounts.find((mount) => mount.Name === 'app_db')?.RW).toBe(false);
  expect(vm.data.get('app_db')).toEqual(archive);
  expect(new Header(vm.data.get('app_db')!)).toMatchObject({ uid: 1000, gid: 1000, mode: 0o600 });
});

it('reconnect drops old code exclusions, keeps unselected data, and retains original exclusions on retry', async () => {
  git.setDefaultResponse({ type: 'success', stdout: 'state/main.py\0' });
  const prior: DockerImportInventory = {
    importedAt: '2026-09-01T00:00:00.000Z',
    items: [
      { name: 'runner', imageId: 'sha256:web', volumes: [], bindPaths: ['/state'], sizeBytes: 5 },
      {
        name: 'absent',
        imageId: 'sha256:web',
        volumes: [],
        bindPaths: ['/retired-data'],
        sizeBytes: 5,
      },
    ],
  };
  inventory.set(`${PROJECT}/${REMOTE}`, prior);
  exclusions.set(PROJECT, ['/state', '/retired-data']);
  details.dockerSelection = { items: [{ id: 'runner-id', mode: 'container-and-data' }] };
  git.enqueueResponse(
    { type: 'success', stdout: 'state/main.py\0' },
    { type: 'success', stdout: 'state/main.py\0' },
    { type: 'success' },
  );
  await handoff.preflight(run());
  expect(exclusions.get(PROJECT)).toEqual(['/retired-data']);
  expect(details.managedExclusionsBefore).toEqual(['/state', '/retired-data']);
  git.enqueueResponse(
    { type: 'success', stdout: 'state/main.py\0' },
    { type: 'success', stdout: 'state/main.py\0' },
    { type: 'success' },
  );
  await handoff.preflight(run());
  expect(exclusions.get(PROJECT)).toEqual(['/retired-data']);
  expect(details.managedExclusionsBefore).toEqual(['/state', '/retired-data']);
  await handoff.rollback(operation());
  expect(inventory.get(`${PROJECT}/${REMOTE}`)).toEqual(prior);
});
const vmContainer = (name: string) =>
  [...vm.containers.values()].find((c) => c.Name === `/${name}`);
const docker = () => details.docker as DockerTransferDetails;
/** The networks in the order that the progress reported creating them. */
const networkSteps = () =>
  progress
    .map((patch) => (patch.docker as DockerTransferDetails | undefined)?.item)
    .filter((item) => item?.phase === 'network')
    .map((item) => item!.name);
function fixedRunner(): void {
  home.networks.set('shared-network', {
    labels: {},
    driver: 'bridge',
    internal: false,
    ipam: { Config: [{ Subnet: '172.19.0.0/16', Gateway: '172.19.0.1' }] },
  });
  const runner = home.containers.get('runner-id')!;
  runner.HostConfig.NetworkMode = 'shared-network';
  runner.NetworkSettings = {
    Networks: { 'shared-network': { IPAMConfig: { IPv4Address: '172.19.0.200' } } },
  };
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'docker-handoff-'));
  fixture = await mkdtemp(join(homedir(), '.docker-handoff-test-'));
  root = join(fixture, 'project');
  state = join(root, 'state');
  await mkdir(state, { recursive: true });
  savedDockerHost = process.env.DOCKER_HOST;
  const module = await Test.createTestingModule({
    controllers: [HostDockerController],
    providers: [
      HostDockerService,
      { provide: HOST_IPV4_ROUTES, useValue: async () => vmRoutes },
      HostDockerBodyParser,
      { provide: DockerArchiveJournal, useValue: new DockerArchiveJournal(join(scratch, 'vm')) },
    ],
  }).compile();
  const adapter = new FastifyAdapter({ bodyLimit: 1024, logger: false });
  app = module.createNestApplication<NestFastifyApplication>(adapter);
  adapter.getInstance().addHook('preValidation', async (request, reply) => {
    if (imageMatchStatus && request.url === '/api/host/docker/images/match')
      return reply.code(imageMatchStatus).send({ message: 'Image match unavailable' });
    if (
      legacyNetworkScan &&
      request.url.startsWith('/api/host/docker/scan') &&
      !DockerScanRequestSchema.omit({ networks: true }).safeParse(request.body).success
    )
      await reply.code(400).send({ message: 'Unsupported Docker scan field' });
  });
  app.useGlobalFilters(new AllExceptionsFilter());
  installFixtureTlsFront(app);
  await app.listen(0, '127.0.0.1');
  const baseUrl = (await app.getUrl()).replace(/^http:/, 'https:');
  host = new RemoteHostClient(
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
  git = new FakeProcessExecutor();
  git.setDefaultResponse({ type: 'failure', exitCode: 128 });
  sourceModule = await Test.createTestingModule({
    providers: [
      {
        provide: DockerPlanSourceService,
        useClass: DockerPlanSourceService,
        scope: Scope.TRANSIENT,
      },
      { provide: ProcessExecutor, useValue: git },
    ],
  }).compile();
});

beforeEach(async () => {
  choicesDatabase = createTestDatabase();
  choices = new ConnectChoicesStore(choicesDatabase.db);
  await mkdir(state, { recursive: true });
  git.reset();
  // A scan cache must not survive replacement of the engines between cases.
  source = await sourceModule.resolve(DockerPlanSourceService);
  git.setDefaultResponse({ type: 'failure', exitCode: 128 });
  details = { dockerSelection: selection };
  progress = [];
  inventory = new Map();
  exclusions = new Map();
  legacyNetworkScan = false;
  imageMatchStatus = undefined;
  vmRoutes = [];

  home = new FakeDockerEngine('home-engine');
  vm = new FakeDockerEngine('vm-engine');
  await home.listen(join(scratch, 'home.sock'));
  await vm.listen(join(scratch, 'vm.sock'));
  seedHome();
  process.env.DOCKER_HOST = `unix://${join(scratch, 'home.sock')}`;
  // Only the VM's host service uses connect(); home resolves DOCKER_HOST itself.
  jest
    .spyOn(DockerEngineClient, 'connect')
    .mockImplementation(async () => new DockerEngineClient(join(scratch, 'vm.sock')));

  jest.spyOn(host, 'remoteRuntime').mockResolvedValue({
    homePath: homedir(),
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
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
    host,
    inventoryStore as never,
    choices,
  );
  store = new DockerHandoffStore(join(scratch, 'home'));
  homeJournal = new DockerArchiveJournal(join(scratch, 'home'));
  handoff = new DockerHandoff(
    plans,
    source,
    host,
    store,
    homeJournal,
    {
      set: (p: string, patterns: string[] | null) => exclusions.set(p, patterns ?? []),
      get: (p: string) => exclusions.get(p) ?? [],
    } as never,
    inventoryStore as never,
    choices,
  );
});
afterEach(async () => {
  choicesDatabase.sqlite.close();
  if (savedDockerHost === undefined) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = savedDockerHost;
  jest.restoreAllMocks();
  await home.close();
  await vm.close();
  await Promise.all(
    ['home', 'vm'].map((side) => rm(join(scratch, side), { recursive: true, force: true })),
  );
  await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  await app?.close();
  await sourceModule?.close();
  await rm(scratch, { recursive: true, force: true });
  await rm(fixture, { recursive: true, force: true });
});

it('records preflight inclusion, exclusions and modes without data or privileged acceptance', async () => {
  details.dockerSelection = {
    items: [
      { id: 'db-id', mode: 'without-data', acceptPrivileged: true, dataChoice: 'replace-home' },
    ],
  };
  choices.recordAttach(PROJECT, REMOTE, true);
  await handoff.preflight(run());

  const saved = choices.get(PROJECT)!;
  expect(saved.items).toMatchObject({
    'container:app-db-1': { included: true, mode: 'without-data' },
    'container:runner': { included: false },
  });
  expect(
    Object.values(saved.items).every((entry) =>
      Object.keys(entry).every((key) => ['included', 'mode'].includes(key)),
    ),
  ).toBe(true);
});

it('an older VM refuses networks during preflight before any home stop or VM write', async () => {
  fixedRunner();
  legacyNetworkScan = true;
  await expect(handoff.preflight(run())).rejects.toMatchObject({ code: 'DOCKER_PLAN_REFUSED' });
  expect(home.calls.some((call) => call.startsWith('POST '))).toBe(false);
  expect(vm.calls.some((call) => call.startsWith('POST ') || call.startsWith('PUT '))).toBe(false);
  expect(home.containers.get('runner-id')!.State.Running).toBe(true);
  expect(await store.read(operation().id)).toBeNull();
});

it('creates a privileged VM container after accepting container-and-data and keeps it on retry', async () => {
  const mode = 'container-and-data' as const;
  home.containers.get('db-id')!.HostConfig.Privileged = true;
  details.dockerSelection = { items: [{ id: 'db-id', mode, acceptPrivileged: true }] };
  const plan = await plans.plan(
    PROJECT,
    { remoteId: REMOTE, ...(details.dockerSelection as object) },
    undefined,
    { estimate: false },
  );
  expect(plan.canConnect).toBe(true);
  expect(plan.items.find((i) => i.id === 'db-id')?.blockers).toEqual([]);
  await connect();
  expect(vmContainer('app-db-1')).toMatchObject({
    HostConfig: { Privileged: true },
    created: { HostConfig: { Privileged: true } },
    State: { Running: false },
  });
  expect(home.containers.get('db-id')?.State.Running).toBe(false);
  const createdId = vmContainer('app-db-1')!.Id;
  await handoff.createHost(run());
  expect(vmContainer('app-db-1')!.Id).toBe(createdId);
  expect(vmContainer('app-db-1')!.HostConfig.Privileged).toBe(true);
});

it('refuses unaccepted privileged container-and-data in preflight before any container stops or data moves', async () => {
  const mode = 'container-and-data' as const;
  details.dockerSelection = { items: [{ id: 'db-id', mode }] };
  const initial = await plans.plan(
    PROJECT,
    { remoteId: REMOTE, ...(details.dockerSelection as object) },
    undefined,
    { estimate: false },
  );
  expect(initial.canConnect).toBe(true);
  home.containers.get('db-id')!.HostConfig.Privileged = true;
  await expect(handoff.preflight(run())).rejects.toMatchObject({
    code: 'DOCKER_PLAN_REFUSED',
    message: 'app-db-1: Accept Run privileged for this container, or pick Copy its data only.',
  });
  expect(home.calls.some((call) => call.startsWith('POST '))).toBe(false);
  expect(vm.calls.some((call) => call.startsWith('POST ') || call.startsWith('PUT '))).toBe(false);
  expect([...home.containers.values()].every((c) => c.State.Running)).toBe(true);
  expect(await store.read(operation().id)).toBeNull();
  expect(exclusions.has(PROJECT)).toBe(false);
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
  // Same-store engines give an image the same ID, so no pair is written.
  expect(inventory.get(`${PROJECT}/${REMOTE}`)?.items.some((item) => 'vmImageId' in item)).toBe(
    false,
  );
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
  expect(vm.images.size).toBe(2);
  vm.calls.length = 0;
  await handoff.push(run());
  // Both images of the completed load are present, even when its answer was lost.
  expect(vm.calls.filter((c) => c === 'POST /images/load')).toHaveLength(0);

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

// Real handoff/host routes and fake engines capture writer ordering before actual bind clearing.
it('stops a running project Compose bind holder before clearing its replaced bind', async () => {
  const labels = { [COMPOSE]: 'app', [`${COMPOSE}.working_dir`]: root };
  vm.addContainer({
    Id: 'vm-runner',
    Name: '/runner',
    Image: 'sha256:web',
    Config: { Labels: labels },
    HostConfig: {},
    Mounts: [{ Type: 'bind', Source: state, Destination: '/state', RW: true }],
    running: true,
  });
  vm.addContainer({
    Id: 'vm-extra',
    Name: '/extra-project-writer',
    Image: 'sha256:web',
    Config: { Labels: labels },
    HostConfig: {},
    Mounts: [{ Type: 'bind', Source: state, Destination: '/state', RW: true }],
    running: true,
  });
  await writeFile(join(state, 'vm-only.txt'), 'remove on replacement');
  await handoff.preflight(run());
  expect((await store.read(operation().id))!.binds).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: state, replace: true })]),
  );
  await handoff.stopHome(run());
  await handoff.push(run());
  const clears: boolean[][] = [];
  const prepare = host.dockerPrepareBinds.bind(host);
  jest.spyOn(host, 'dockerPrepareBinds').mockImplementation(async (remote, input, options) => {
    if (input.paths.some((path) => path.path === state && path.replace))
      clears.push(['vm-runner', 'vm-extra'].map((id) => vm.containers.get(id)!.State.Running));
    return prepare(remote, input, options);
  });
  await handoff.createHost(run());

  expect(clears).toEqual([[false, false]]);
  expect(vm.calls).toContain('POST /containers/vm-runner/stop');
  expect(vm.calls).toContain('POST /containers/vm-extra/stop');
  expect(vm.containers.has('vm-runner')).toBe(false);
  expect(vm.containers.get('vm-extra')!.State.Running).toBe(false);
  expect(existsSync(join(state, 'vm-only.txt'))).toBe(false);
  expect(vm.data.get(state)?.toString()).toBe('home-state');
});

it('replaces a VM Compose counterpart with no VM mounts when home has data', async () => {
  vm.addContainer({
    Id: 'vm-stateless',
    Name: '/app-db-1',
    Image: 'sha256:db',
    Config: { Labels: { [COMPOSE]: 'app', [`${COMPOSE}.config_files`]: `${root}/compose.yml` } },
    HostConfig: {},
    Mounts: [],
    running: true,
  });
  await connect();
  expect(vm.containers.has('vm-stateless')).toBe(false);
  expect(vmContainer('app-db-1')!.State.Running).toBe(false);
  expect(vm.data.get('app_db')?.toString()).toBe('home-db-rows');
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

it('moves a bound single file as a file and never puts a folder in its place', async () => {
  git.setDefaultResponse({ type: 'success' });
  // Home and the VM share this disk: a folder made on the "VM" would replace the home file.
  const caddyfile = join(root, 'dev-https', 'Caddyfile');
  await mkdir(join(root, 'dev-https'));
  await writeFile(caddyfile, 'home-caddy');
  home.data.set(caddyfile, Buffer.from('home-caddy'));
  home.addContainer({
    Id: 'proxy-id',
    Name: '/proxy',
    Image: 'sha256:web',
    Config: { Image: 'app-web:latest' },
    HostConfig: { Binds: [`${caddyfile}:/etc/caddy/Caddyfile:ro`] },
    Mounts: [{ Type: 'bind', Source: caddyfile, Destination: '/etc/caddy/Caddyfile', RW: false }],
    running: true,
  });
  details = {
    dockerSelection: {
      items: [
        ...selection.items,
        { id: 'proxy-id', mode: 'container-and-data', dataChoice: 'replace-home' },
      ],
    },
  };
  const prepares = jest.spyOn(host, 'dockerPrepareBinds');
  const archives = jest.spyOn(host, 'dockerWriteArchive');
  await connect();

  expect(prepares.mock.calls.flatMap(([, input]) => input.paths)).toContainEqual(
    expect.objectContaining({ path: caddyfile, replace: true, file: true }),
  );
  expect(archives.mock.calls.map(([, input]) => input)).toContainEqual(
    expect.objectContaining({ mountType: 'file', source: caddyfile }),
  );
  expect(archives.mock.calls.map(([, input]) => input)).toContainEqual(
    expect.objectContaining({ mountType: 'bind', source: state }),
  );
  expect(vm.data.get(caddyfile)?.toString()).toBe('home-caddy');
  expect((await stat(caddyfile)).isFile()).toBe(true);
  expect(vmContainer('proxy')?.State.Running).toBe(false);
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
  handoff.rollbackLimits = { ...handoff.rollbackLimits, homeStartMs: 40 };
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
  handoff.rollbackLimits = { ...handoff.rollbackLimits, vmCleanupMs: 40 };
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

it.each([
  ['another project made it on the VM', { [OWNER]: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }],
  ['it is missing on the VM', null],
] as const)('shares a network made with docker network create when %s', async (_case, vmLabels) => {
  home.networks.set('shared-network', { labels: {}, driver: 'bridge', internal: false });
  if (vmLabels)
    vm.networks.set('shared-network', { labels: vmLabels, driver: 'bridge', internal: false });
  const runner = home.containers.get('runner-id')!;
  runner.HostConfig.NetworkMode = 'shared-network';
  runner.NetworkSettings = { Networks: { 'shared-network': {} } };

  await connect();

  expect(vmContainer('runner')).toBeDefined();
  // No project owns it: the other project's mark stays, and a new one has none.
  expect(vm.networks.get('shared-network')?.labels).toEqual(vmLabels ?? {});
  expect((await store.read(operation().id))?.created.networks).toEqual(['app_default']);
  await handoff.rollback(operation({ docker_push: 'done', docker_create_host: 'done' }));
  expect(vm.networks.has('app_default')).toBe(false);
  expect(vm.networks.has('shared-network')).toBe(true);
});

it.each([false, true])(
  'carries home ranges and fixed IPv4 endpoints (existing VM network: %s)',
  async (existing) => {
    const homeRange = { Config: [{ Subnet: '172.20.0.0/16', Gateway: '172.20.0.1' }] };
    const fixedRange = {
      Config: [{ Subnet: '172.19.0.0/16', Gateway: '172.19.0.1', IPRange: '172.19.0.128/25' }],
    };
    home.networks.get('app_default')!.ipam = homeRange;
    home.networks.set('shared-network', {
      labels: {},
      driver: 'bridge',
      internal: false,
      ipam: {
        Config: [...fixedRange.Config, { Subnet: 'fd00::/64', Gateway: 'fd00::1' }],
      },
    });
    home.containers.get('db-id')!.NetworkSettings!.Networks!['shared-network'] = {};
    const runner = home.containers.get('runner-id')!;
    runner.HostConfig.NetworkMode = 'shared-network';
    runner.NetworkSettings = {
      Networks: {
        'shared-network': { Aliases: ['consumer'], IPAMConfig: { IPv4Address: '172.19.0.200' } },
      },
    };
    home.addContainer({
      Id: 'audit-id',
      Name: '/audit-recovery',
      Image: 'sha256:web',
      Config: {
        Image: 'app-web:latest',
        Labels: { [COMPOSE]: 'app', 'com.docker.compose.project.working_dir': root },
      },
      HostConfig: { NetworkMode: 'shared-network' },
      NetworkSettings: {
        Networks: { 'shared-network': { IPAMConfig: { IPv4Address: '172.19.0.201' } } },
      },
      Mounts: [],
      running: true,
    });
    details.dockerSelection = {
      items: [...selection.items, { id: 'audit-id', mode: 'container-and-data' }],
    };
    const vmNetwork = {
      labels: { [OWNER]: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      driver: 'bridge',
      internal: true,
      ipam: { Config: [{ Subnet: '172.19.0.0/16', Gateway: '172.19.0.254' }] },
    };
    if (existing) vm.networks.set('shared-network', vmNetwork);

    await connect();

    const record = (await store.read(operation().id))!;
    expect(record.networks.map((network) => network.name)).toEqual([
      'app_default',
      'shared-network',
    ]);
    expect(record.networks.map((network) => network.ipam)).toEqual([homeRange, fixedRange]);
    expect(vm.networks.get('app_default')!.ipam).toEqual(homeRange);
    expect(vm.networks.get('shared-network')).toEqual(
      existing ? vmNetwork : { labels: {}, driver: 'bridge', internal: false, ipam: fixedRange },
    );
    expect(networkSteps()).toEqual(['app_default', 'shared-network']);
    expect(vmContainer('runner')!.created!.NetworkingConfig).toEqual({
      EndpointsConfig: {
        'shared-network': { Aliases: ['consumer'], IPAMConfig: { IPv4Address: '172.19.0.200' } },
      },
    });
    expect(vmContainer('audit-recovery')!.created!.NetworkingConfig).toEqual({
      EndpointsConfig: {
        'shared-network': { IPAMConfig: { IPv4Address: '172.19.0.201' } },
      },
    });
    expect(record.created.networks).toEqual(['app_default']);

    const beforeRetry = vm.calls.filter((call) => call === 'POST /networks/create').length;
    await handoff.createHost(run());
    expect(vm.calls.filter((call) => call === 'POST /networks/create')).toHaveLength(beforeRetry);
    await handoff.rollback(operation({ docker_push: 'done', docker_create_host: 'done' }));
    expect(vm.networks.has('shared-network')).toBe(true);
  },
);

it.each([false, true])('uses the saved automatic-range decision: %s', async (automatic) => {
  const range = { Config: [{ Subnet: '172.20.0.0/16', Gateway: '172.20.0.1' }] };
  home.networks.get('app_default')!.ipam = range;
  fixedRunner();
  if (automatic) vmRoutes = ['172.20.0.0/16'];
  await handoff.preflight(run());
  await handoff.stopHome(run());
  const record = (await store.read(operation().id))!;
  expect(record.automaticRangeNetworks).toEqual(automatic ? ['app_default'] : []);
  if (!automatic) {
    delete record.automaticRangeNetworks;
    await store.write(operation().id, record);
  }
  await handoff.push(run());
  const scan = jest.spyOn(host, 'dockerScan');
  progress = [];
  await handoff.createHost(run());
  expect(vm.networks.get('app_default')!.ipam).toEqual(automatic ? undefined : range);
  expect(scan).toHaveBeenCalledWith(REMOTE, [state], expect.any(Object), []);
  expect(networkSteps()).toEqual(
    automatic ? ['shared-network', 'app_default'] : ['app_default', 'shared-network'],
  );
});

it('refuses a new on-link route overlap after preflight before creating the network', async () => {
  home.networks.get('app_default')!.ipam = {
    Config: [{ Subnet: '172.31.0.0/16', Gateway: '172.31.0.1' }],
  };
  await handoff.preflight(run());
  await handoff.stopHome(run());
  await handoff.push(run());
  vmRoutes = ['172.31.0.0/20'];
  await expect(handoff.createHost(run())).rejects.toMatchObject({
    message: expect.stringMatching(/^Network app_default: .*VM on-link route 172\.31\.0\.0\/20/),
  });
  expect(vm.calls).not.toContain('POST /networks/create');
});

it('retries a record without captured network ranges using automatic allocation', async () => {
  home.networks.get('app_default')!.ipam = {
    Config: [{ Subnet: '172.19.0.0/16', Gateway: '172.19.0.1' }],
  };
  home.containers.get('db-id')!.NetworkSettings!.Networks!.app_default.IPAMConfig = {
    IPv4Address: '172.19.0.200',
  };
  await handoff.preflight(run());
  await handoff.stopHome(run());
  const record = (await store.read(operation().id))!;
  for (const network of record.networks) delete network.ipam;
  await store.write(operation().id, record);
  await handoff.push(run());
  await handoff.createHost(run());
  expect(vm.networks.get('app_default')!.ipam).toBeUndefined();
  expect(vmContainer('app-db-1')!.created!.NetworkingConfig).toMatchObject({
    EndpointsConfig: { app_default: { IPAMConfig: { IPv4Address: '172.19.0.200' } } },
  });
});

it('names the network the VM refuses, with the reason it gave', async () => {
  vm.networks.set('app_default', {
    labels: { [COMPOSE]: 'app', [OWNER]: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
    driver: 'bridge',
    internal: false,
  });
  await handoff.preflight(run());
  await handoff.stopHome(run());
  await handoff.push(run());
  await expect(handoff.createHost(run())).rejects.toMatchObject({
    code: 'REMOTE_HOST_REQUEST_FAILED',
    message:
      'Network app_default: Docker host request failed (HTTP 409): Docker resource is not owned by this imported project',
  });
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
    await connect();
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

// The fake engines are the cheapest layer where both image stores and the real host
// routes meet; a containerd-store VM gives a loaded image an ID home never had.
describe('with a containerd-store VM', () => {
  const DB_LAYERS = ['sha256:layer-db-1', 'sha256:layer-db-2'];
  const vmIdOf = (tag: string) => [...vm.images].find(([, image]) => image.tags.includes(tag))?.[0];
  const imageLoads = () => vm.calls.filter((call) => call === 'POST /images/load').length;

  beforeEach(async () => {
    await vm.close();
    vm = new FakeDockerEngine('vm-engine', { imageStore: 'containerd' });
    await vm.listen(join(scratch, 'vm.sock'));
    home.images.get('sha256:db')!.layers = DB_LAYERS;
    home.images.get('sha256:web')!.layers = ['sha256:layer-web-1'];
  });

  it('groups tagged equal-layer images and uses their distinct VM IDs on the VM', async () => {
    home.images.get('sha256:web')!.layers = DB_LAYERS;
    home.images.get('sha256:db')!.tags.push('registry.example/app/db:latest');
    home.images.get('sha256:db')!.metadata = { Config: { Cmd: ['postgres'] } };
    home.images.get('sha256:web')!.metadata = { Config: { Cmd: ['node'] } };
    const homeHelpers = jest.spyOn(homeJournal, 'create');
    const archives = jest.spyOn(host, 'dockerWriteArchive');
    const prepares = jest.spyOn(host, 'dockerPrepareBinds');
    await connect();

    const vmDb = vmIdOf('postgres:17')!;
    const vmWeb = vmIdOf('app-web:latest')!;
    expect(vmDb).not.toBe('sha256:db');
    expect(vmWeb).not.toBe('sha256:web');
    expect(vmWeb).not.toBe(vmDb);
    expect(vmIdOf('registry.example/app/db:latest')).toBe(vmDb);
    expect(imageLoads()).toBe(1);
    expect(home.calls.filter((call) => call === 'GET /images/get')).toHaveLength(1);
    const imageProgress = progress
      .flatMap((patch) => (patch.docker ? [patch.docker as DockerTransferDetails] : []))
      .filter((value) => value.item?.phase === 'image');
    expect([...new Set(imageProgress.map((value) => value.item!.name))]).toEqual(['2 images']);
    expect(Math.max(...imageProgress.map((value) => value.bytesDone))).toBe(130);
    const record = (await store.read(operation().id))!;
    expect(record.images).toEqual([
      expect.objectContaining({ id: 'sha256:db', vmId: vmDb }),
      expect.objectContaining({ id: 'sha256:web', vmId: vmWeb }),
    ]);
    expect(record.verified.images).toEqual(['sha256:db', 'sha256:web']);

    expect(vmContainer('app-db-1')?.created?.Image).toBe(vmDb);
    expect(vmContainer('runner')?.created?.Image).toBe(vmWeb);
    // The captured settings keep the home ID.
    expect((await store.readSettings(operation().id))['db-id'].config.Image).toBe('sha256:db');

    expect(homeHelpers.mock.calls.map((call) => call[1]).sort()).toEqual([
      'sha256:db',
      'sha256:db',
      'sha256:web',
      'sha256:web',
    ]);
    expect(archives.mock.calls.map((call) => call[1].image).sort()).toEqual(
      [vmDb, vmDb, vmWeb, vmWeb].sort(),
    );
    expect(
      prepares.mock.calls.flatMap((call) => call[1].paths).filter((path) => path.replace),
    ).toEqual([{ path: state, replace: true, image: vmWeb }]);
    expect(vm.data.get('app_db')?.toString()).toBe('home-db-rows');
    expect(vm.data.get(state)?.toString()).toBe('home-state');

    expect(inventory.get(`${PROJECT}/${REMOTE}`)?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'app-db-1', imageId: 'sha256:db', vmImageId: vmDb }),
        expect.objectContaining({ name: 'runner', imageId: 'sha256:web', vmImageId: vmWeb }),
        expect.objectContaining({ name: 'tmp-job', imageId: 'sha256:web', vmImageId: vmWeb }),
      ]),
    );
  });

  // The real upload boundary must prove completed groups survive a failure of a later group.
  it('retries only the failed image group', async () => {
    home.images.get('sha256:web')!.layers = DB_LAYERS;
    for (const name of ['worker-a', 'worker-b']) {
      home.images.set(`sha256:${name}`, {
        architecture: 'amd64',
        tags: [`${name}:latest`],
        size: 20,
        layers: ['sha256:worker'],
      });
      home.addContainer({
        Id: name,
        Name: `/${name}`,
        Image: `sha256:${name}`,
        Config: {},
        HostConfig: { Binds: [`${root}:/app`] },
        Mounts: [{ Type: 'bind', Source: root, Destination: '/app', RW: true }],
      });
    }
    details.dockerSelection = {
      items: ['db-id', 'runner-id', 'worker-a', 'worker-b'].map((id) => ({
        id,
        mode: 'container-and-data',
        dataChoice: 'replace-home',
      })),
    };
    await handoff.preflight(run());
    await handoff.stopHome(run());
    const load = host.dockerLoadImage.bind(host);
    let attempts = 0;
    jest.spyOn(host, 'dockerLoadImage').mockImplementation(async (...args) => {
      if (++attempts === 2) {
        for await (const chunk of args[1]) void chunk;
        throw new Error('Second group failed before load');
      }
      return load(...args);
    });
    await expect(handoff.push(run())).rejects.toThrow('The Docker copy failed.');
    expect((await store.read(operation().id))?.verified.images).toEqual([
      'sha256:db',
      'sha256:web',
    ]);
    home.calls.length = 0;
    await handoff.push(run());
    expect(home.calls.filter((call) => call === 'GET /images/get')).toHaveLength(1);
    expect(imageLoads()).toBe(2);
    expect((await store.read(operation().id))?.verified.images).toEqual([
      'sha256:db',
      'sha256:web',
      'sha256:worker-a',
      'sha256:worker-b',
    ]);
  });

  // Only separate real loads can disambiguate equal-layer images in an answer without aliases.
  it('falls back to single-image loads when the VM omits references', async () => {
    home.images.get('sha256:web')!.layers = DB_LAYERS;
    const load = host.dockerLoadImage.bind(host);
    jest.spyOn(host, 'dockerLoadImage').mockImplementation(async (...args) => {
      const result = await load(...args);
      return { images: result.images.map(({ id, layers }) => ({ id, layers })) };
    });
    await connect();
    expect(imageLoads()).toBe(3);
    const db = vmIdOf('postgres:17')!;
    const web = vmIdOf('app-web:latest')!;
    expect(db).not.toBe(web);
    expect(vmContainer('app-db-1')?.created?.Image).toBe(db);
    expect(vmContainer('runner')?.created?.Image).toBe(web);
    expect((await store.read(operation().id))?.images).toEqual([
      expect.objectContaining({ id: 'sha256:db', vmId: db }),
      expect.objectContaining({ id: 'sha256:web', vmId: web }),
    ]);
    expect(docker().bytesDone).toBe(docker().bytesTotal);
  });

  it('finishes a retry of a push whose record has no VM ID', async () => {
    home.images.get('sha256:db')!.tags.push('registry.example/app/db:latest');
    home.images.get('sha256:db')!.metadata = {
      Config: { Cmd: ['postgres'], Volumes: { '/data': {} } },
    };
    const archives = jest.spyOn(host, 'dockerWriteArchive');
    const prepares = jest.spyOn(host, 'dockerPrepareBinds');
    await handoff.preflight(run());
    await handoff.stopHome(run());
    const load = host.dockerLoadImage.bind(host);
    // The image reached the VM, but the push failed before it saved a VM ID.
    jest.spyOn(host, 'dockerLoadImage').mockImplementationOnce(async (...args) => {
      await load(...args);
      throw new Error('The VM did not load an image with the expected ID.');
    });
    await expect(handoff.push(run())).rejects.toBeInstanceOf(Error);
    const failed = (await store.read(operation().id))!;
    expect(failed.images.every((image) => image.vmId === undefined)).toBe(true);
    expect(failed.verified.images).toEqual([]);
    const vmDb = vmIdOf('postgres:17')!;
    vm.calls.length = 0;

    await handoff.push(run());
    await handoff.createHost(run());
    expect(imageLoads()).toBe(1);
    expect(vmIdOf('registry.example/app/db:latest')).toBe(vmDb);
    expect(vmContainer('app-db-1')?.created?.Image).toBe(vmDb);
    expect(vmContainer('runner')?.created?.Image).toBe(vmIdOf('app-web:latest'));
    expect(archives.mock.calls.map((call) => call[1].image)).toContain(vmDb);
    expect(
      prepares.mock.calls.flatMap((call) => call[1].paths).find((path) => path.replace)?.image,
    ).toBe(vmIdOf('app-web:latest'));
    expect((await store.read(operation().id))?.images).toContainEqual(
      expect.objectContaining({ id: 'sha256:db', vmId: vmDb }),
    );
    expect((await store.read(operation().id))?.verified.images).toEqual([
      'sha256:db',
      'sha256:web',
    ]);
    expect(inventory.get(`${PROJECT}/${REMOTE}`)?.items).toContainEqual(
      expect.objectContaining({ name: 'app-db-1', imageId: 'sha256:db', vmImageId: vmDb }),
    );
  });

  it('uploads equal layers when the image config differs', async () => {
    const different = { Cmd: ['other'] };
    const config = {
      Cmd: ['postgres'],
      Env: ['MODE=home'],
      Volumes: { '/data': {} },
      ExposedPorts: { '8080/tcp': {} },
    };
    home.images.get('sha256:db')!.metadata = { Config: config };
    vm.images.set('sha256:other', {
      architecture: 'amd64',
      tags: ['postgres:17'],
      size: 1,
      layers: DB_LAYERS,
      metadata: { Config: { ...config, ...different } },
    });
    await connect();
    const vmDb = vmIdOf('postgres:17')!;
    expect(vmDb).not.toBe('sha256:other');
    expect(vm.images.get(vmDb)?.metadata?.Config).toEqual(config);
    expect(imageLoads()).toBe(2);
  });

  it.each(['missing', 'different content', 'different ID'])(
    'uploads when a second home tag has %s on the VM',
    async (other) => {
      home.images.get('sha256:db')!.tags.push('registry.example/app/db:latest');
      vm.images.set('sha256:vm-db', {
        architecture: 'amd64',
        tags: ['postgres:17'],
        size: 1,
        layers: DB_LAYERS,
      });
      if (other !== 'missing')
        vm.images.set('sha256:vm-other', {
          architecture: 'amd64',
          tags: ['registry.example/app/db:latest'],
          size: 1,
          layers: other === 'different content' ? ['sha256:other'] : DB_LAYERS,
        });
      await connect();
      expect(vmIdOf('postgres:17')).not.toBe('sha256:vm-db');
      expect(vmIdOf('registry.example/app/db:latest')).toBe(vmIdOf('postgres:17'));
      expect(imageLoads()).toBe(2);
    },
  );

  it('uploads an untagged image', async () => {
    home.images.get('sha256:db')!.tags = [];
    home.images.get('sha256:web')!.layers = DB_LAYERS;
    vm.images.set('sha256:vm-db', { architecture: 'amd64', tags: [], size: 1, layers: DB_LAYERS });
    await connect();
    const paired = inventory
      .get(`${PROJECT}/${REMOTE}`)
      ?.items.find((item) => item.name === 'app-db-1')?.vmImageId;
    expect(paired).not.toBe('sha256:vm-db');
    expect(vm.images.get(paired!)?.layers).toEqual(DB_LAYERS);
    expect(imageLoads()).toBe(2);
  });

  it('completes Connect by uploading when an older VM has no match route', async () => {
    imageMatchStatus = 404;
    vm.images.set('sha256:vm-db', {
      architecture: 'amd64',
      tags: ['postgres:17'],
      size: 1,
      layers: DB_LAYERS,
    });
    await connect();
    expect(vmContainer('app-db-1')?.created?.Image).toBe(vmIdOf('postgres:17'));
    expect(vmIdOf('postgres:17')).not.toBe('sha256:vm-db');
    expect(imageLoads()).toBe(2);
  });

  it('does not upload after the match route returns an error other than 404', async () => {
    imageMatchStatus = 400;
    await handoff.preflight(run());
    await handoff.stopHome(run());
    await expect(handoff.push(run())).rejects.toMatchObject({ status: 400 });
    expect(vm.calls).not.toContain('POST /images/load');
    expect((await store.read(operation().id))?.verified.images).toEqual([]);
  });

  it('a reconnect finds the images through the saved pair and does not load them again', async () => {
    await connect();
    await handoff.finish(operation().id);
    vm.calls.length = 0;
    details = {
      dockerSelection: {
        items: [
          { id: 'db-id', mode: 'container-and-data', dataChoice: 'replace-home' },
          { id: 'runner-id', mode: 'container-and-data', dataChoice: 'replace-home' },
        ],
      },
    };
    await connect();
    expect(vm.calls).not.toContain('POST /images/load');
    const vmDb = vmIdOf('postgres:17');
    expect((await store.read(operation().id))?.images).toEqual([
      expect.objectContaining({ id: 'sha256:db', vmId: vmDb }),
      expect.objectContaining({ id: 'sha256:web', vmId: vmIdOf('app-web:latest') }),
    ]);
    expect(vmContainer('app-db-1')?.created?.Image).toBe(vmDb);
  });

  it.each([
    ['keeps the pair of an unchanged home image', 'sha256:db', false],
    ['drops the pair of a changed home image', 'sha256:db-old', true],
  ] as const)('a keep-vm reconnect %s', async (_name, priorImageId, loadsDb) => {
    await seedKeptData(false, false);
    // A changed home image leaves the VM with the old content under the old pair.
    vm.images.set('sha256:vm-db', {
      architecture: 'amd64',
      tags: ['postgres:17'],
      layers: loadsDb ? ['sha256:layer-db-old'] : DB_LAYERS,
      size: 1,
    });
    inventory.get(`${PROJECT}/${REMOTE}`)!.items = [
      {
        name: 'app-db-1',
        imageId: priorImageId,
        vmImageId: 'sha256:vm-db',
        volumes: [{ name: 'app_db', sizeBytes: 12 }],
        bindPaths: [],
        sizeBytes: 12,
      },
    ];
    const loads = jest.spyOn(host, 'dockerLoadImage');
    await handoff.preflight(run());
    expect(
      (await store.read(operation().id))?.keptInventory?.find((i) => i.name === 'app-db-1')
        ?.vmImageId,
    ).toBe(loadsDb ? undefined : 'sha256:vm-db');
    await handoff.stopHome(run());
    await handoff.push(run());
    await handoff.createHost(run());

    // The web image is missing on the VM; the db image is loaded only without a valid pair.
    expect(loads).toHaveBeenCalledTimes(loadsDb ? 2 : 1);
    const item = inventory.get(`${PROJECT}/${REMOTE}`)?.items.find((i) => i.name === 'app-db-1');
    expect(item?.imageId).toBe('sha256:db');
    if (loadsDb) {
      expect(item?.vmImageId).not.toBe('sha256:vm-db');
      expect(vm.images.get(item!.vmImageId!)?.layers).toEqual(DB_LAYERS);
    } else expect(item?.vmImageId).toBe('sha256:vm-db');
    expect(vmContainer('runner')?.created?.Image).toBe(
      inventory.get(`${PROJECT}/${REMOTE}`)?.items.find((i) => i.name === 'runner')?.vmImageId,
    );
  });

  it('fails a load whose reported layers do not match, naming both IDs', async () => {
    home.images.get('sha256:web')!.layers = DB_LAYERS;
    await handoff.preflight(run());
    await handoff.stopHome(run());
    const load = host.dockerLoadImage.bind(host);
    jest.spyOn(host, 'dockerLoadImage').mockImplementationOnce(async (...args) => {
      const result = await load(...args);
      result.images.find((image) => image.references?.includes('postgres:17'))!.layers = [
        'sha256:layer-other',
      ];
      return result;
    });
    const error = await handoff.push(run()).catch((e: Error) => e);
    expect((error as Error).message).toBe(
      `The VM loaded image sha256:db, but none of the images it reported (${vmIdOf('postgres:17')}, ${vmIdOf('app-web:latest')}) has the same layers. The VM engine can store images under its own IDs. Retry the copy.`,
    );
    expect((await store.read(operation().id))?.verified.images).toEqual([]);
  });
});
