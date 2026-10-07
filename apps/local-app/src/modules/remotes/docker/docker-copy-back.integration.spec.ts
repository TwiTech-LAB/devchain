import { Scope } from '@nestjs/common';
// Fake engines on both sides; the VM side runs the real host routes behind the real LAN client,
// so the archive digest travels as a real HTTP trailer.
import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { FakeDockerEngine, type FakeMount } from '../../../common/test/fake-docker-engine.server';
import { fixtureTls, installFixtureTlsFront } from '../../../common/test/tls-fixture';
import { DockerArchiveJournal } from '../../core/controllers/docker-archive-journal';
import { DockerEngineClient } from '../../core/controllers/docker-engine.client';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { HostDockerController } from '../host/host-docker.controller';
import { HostDockerService } from '../host/host-docker.service';
import { HostDockerBodyParser } from '../host/host-docker-body.parser';
import {
  DockerImportInventorySchema,
  type DockerImportInventory,
} from '../operations/docker-import-inventory.store';
import { DetachOperation } from '../operations/detach.operation';
import { RemoteHostClient } from '../operations/remote-host.client';
import { ResetVmOperation } from '../operations/reset-vm.operation';
import type { RemoteOperationStepRun } from '../operations/remote-operation.types';
import type { RemoteHealthState } from '../ports/remote-health.port';
import { DockerCopyBack } from './docker-copy-back';
import { DockerHandoff } from './docker-handoff';
import { dockerDataGroupKey } from './docker-data-groups';
import type { DockerCopyBackResult } from './docker-copy-back.dto';
import { DockerHandoffStore } from './docker-handoff.store';
import { DockerPlanService } from './docker-plan.service';
import { DockerPlanSourceService } from './docker-plan-source.service';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';

const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REMOTE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OWNER = 'dev.devchain.project';
const COMPOSE = 'com.docker.compose.project';
/** The last Connect's copy; home holders ran before it, VM holders after it. */
const SYNCED = '2026-01-01T00:00:00.000Z';
const BEFORE = '2025-12-01T00:00:00.000Z';
const AFTER = '2026-02-01T00:00:00.000Z';

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
let client: RemoteHostClient;
let copyBack: DockerCopyBack;
let handoff: DockerHandoff;
let plans: DockerPlanService;
let store: DockerHandoffStore;
let inventory: Map<string, DockerImportInventory>;
let details: Record<string, unknown>;
let health: RemoteHealthState;
let savedDockerHost: string | undefined;
let makeCopyBack: () => DockerCopyBack;

const volumeMount = (name: string, destination: string): FakeMount => ({
  Type: 'volume',
  Name: name,
  Source: `/var/lib/docker/volumes/${name}/_data`,
  Destination: destination,
  RW: true,
});
const bindMount = (): FakeMount => ({
  Type: 'bind',
  Source: state,
  Destination: '/state',
  RW: true,
});

function seed(): void {
  for (const engine of [home, vm]) {
    engine.images.set('sha256:db', { architecture: 'amd64', tags: ['postgres:17'], size: 80 });
    engine.images.set('sha256:web', { architecture: 'amd64', tags: ['app-web:latest'], size: 50 });
  }
  home.volumes.set('app_db', {
    labels: { [COMPOSE]: 'app', 'com.docker.compose.volume': 'db' },
    driver: 'local',
  });
  home.data.set('app_db', Buffer.from('home-db-rows'));
  home.data.set(state, Buffer.from('home-state'));
  home.addContainer({
    Id: 'db-id',
    Name: '/app-db-1',
    Image: 'sha256:db',
    Created: BEFORE,
    startedAt: BEFORE,
    Config: {
      Image: 'postgres:17',
      Labels: { [COMPOSE]: 'app', [`${COMPOSE}.working_dir`]: root },
    },
    HostConfig: {},
    Mounts: [volumeMount('app_db', '/var/lib/postgresql/data')],
  });
  home.addContainer({
    Id: 'runner-id',
    Name: '/runner',
    Image: 'sha256:web',
    Created: BEFORE,
    startedAt: BEFORE,
    Config: { Image: 'app-web:latest' },
    HostConfig: { Binds: [`${state}:/state`] },
    Mounts: [bindMount()],
  });

  vm.volumes.set('app_db', {
    labels: { [OWNER]: PROJECT, [COMPOSE]: 'app', 'com.docker.compose.volume': 'db' },
    driver: 'local',
  });
  vm.data.set('app_db', Buffer.from('vm-db-rows'));
  vm.data.set(state, Buffer.from('vm-state'));
  // Recreated by `compose up` on the VM: Compose labels only, and still running.
  vm.addContainer({
    Id: 'vm-db',
    Name: '/app-db-1',
    Image: 'sha256:db',
    Created: AFTER,
    startedAt: AFTER,
    Config: { Labels: { [COMPOSE]: 'app', 'com.docker.compose.service': 'db' } },
    HostConfig: {},
    Mounts: [volumeMount('app_db', '/var/lib/postgresql/data')],
    running: true,
  });
  vm.addContainer({
    Id: 'vm-runner',
    Name: '/runner',
    Image: 'sha256:web',
    Created: AFTER,
    startedAt: AFTER,
    Config: { Labels: { [OWNER]: PROJECT } },
    HostConfig: {},
    Mounts: [bindMount()],
  });
  inventory.set(`${PROJECT}/${REMOTE}`, {
    importedAt: SYNCED,
    items: [
      {
        name: 'app-db-1',
        imageId: 'sha256:db',
        volumes: [{ name: 'app_db', sizeBytes: 12 }],
        bindPaths: [],
        sizeBytes: 12,
      },
      { name: 'runner', imageId: 'sha256:web', volumes: [], bindPaths: ['/state'], sizeBytes: 10 },
    ],
    groups: [
      { volumes: ['app_db'], bindPaths: [], lastSyncedAt: SYNCED, lastSyncDirection: 'to-vm' },
      { volumes: [], bindPaths: [state], lastSyncedAt: SYNCED, lastSyncDirection: 'to-vm' },
    ],
  });
}

const DB_GROUP = () => dockerDataGroupKey({ volumes: ['app_db'], bindPaths: [] });
const STATE_GROUP = () => dockerDataGroupKey({ volumes: [], bindPaths: [state] });

function run(): RemoteOperationStepRun {
  return {
    operation: {
      id: OPERATION,
      kind: 'detach',
      remoteId: REMOTE,
      projectId: PROJECT,
      state: 'running',
      steps: [],
      details: {},
    } as unknown as RemoteOperation,
    details,
    progress: async (patch) => {
      Object.assign(details, structuredClone(patch));
    },
  };
}
const text = (engine: FakeDockerEngine, key: string) => engine.data.get(key)?.toString('utf8');
const records = () => inventory.get(`${PROJECT}/${REMOTE}`)!.groups!;
const result = () => details.dockerCopyBackResult as DockerCopyBackResult;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'docker-copy-back-'));
  fixture = await mkdtemp(join(homedir(), '.docker-copy-back-test-'));
  root = join(fixture, 'project');
  state = join(root, 'state');
  await mkdir(state, { recursive: true });
  savedDockerHost = process.env.DOCKER_HOST;
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
  client = new RemoteHostClient(
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
  await mkdir(state, { recursive: true });
  git.reset();
  // A scan cache must not survive replacement of the engines between cases.
  source = await sourceModule.resolve(DockerPlanSourceService);
  git.setDefaultResponse({ type: 'failure', exitCode: 128 });
  inventory = new Map();
  details = { dockerCopyBack: { choices: {} } };
  health = { online: true, versionMatches: true, version: '1.0.0' } as RemoteHealthState;

  home = new FakeDockerEngine('home-engine');
  vm = new FakeDockerEngine('vm-engine');
  await home.listen(join(scratch, 'home.sock'));
  await vm.listen(join(scratch, 'vm.sock'));
  seed();
  process.env.DOCKER_HOST = `unix://${join(scratch, 'home.sock')}`;
  jest
    .spyOn(DockerEngineClient, 'connect')
    .mockImplementation(async () => new DockerEngineClient(join(scratch, 'vm.sock')));

  jest.spyOn(client, 'remoteRuntime').mockResolvedValue({
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
    set: (p: string, r: string, value: unknown) => {
      const parsed = DockerImportInventorySchema.parse(value);
      inventory.set(`${p}/${r}`, parsed);
      return parsed;
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
    { get: () => null } as never,
  );
  store = new DockerHandoffStore(join(scratch, 'home'));
  handoff = new DockerHandoff(
    plans,
    source,
    client,
    store,
    new DockerArchiveJournal(join(scratch, 'home')),
    { get: () => [], set: () => undefined } as never,
    inventoryStore as never,
    { recordPlan: () => undefined } as never,
  );
  // A new instance over the same directories is a home restart.
  makeCopyBack = () =>
    new DockerCopyBack(
      plans,
      source,
      client,
      new DockerHandoffStore(join(scratch, 'home')),
      new DockerArchiveJournal(join(scratch, 'home')),
      inventoryStore as never,
      { getState: () => health } as never,
    );
  copyBack = makeCopyBack();
});
afterEach(async () => {
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

describe('sync state', () => {
  // Both copy-back plans must retain data that an existing connection excludes, regardless of git.
  it('offers and copies an inventory folder even when git now tracks it', async () => {
    git.setDefaultResponse({ type: 'success', stdout: 'state/main.py\0' });
    const sync = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(sync.groups).toContainEqual(
      expect.objectContaining({ key: STATE_GROUP(), bindPaths: [state], state: 'vm-newer' }),
    );
    await copyBack.copyHome(run());
    expect(text(home, state)).toBe('vm-state');
    expect(result().copied).toContain('runner');
  });
  it('reports each imported group from metadata only', async () => {
    const sync = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(sync.imported).toBe(true);
    expect(sync.availability.available).toBe(true);
    expect(sync.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: DB_GROUP(),
          itemNames: ['app-db-1'],
          state: 'vm-newer',
          needsChoice: false,
        }),
        expect.objectContaining({ key: STATE_GROUP(), itemNames: ['runner'], state: 'vm-newer' }),
      ]),
    );
    expect([...home.calls, ...vm.calls].some((call) => call.endsWith('/archive'))).toBe(false);
  });

  it('is gated on the VM version and offers nothing without an import', async () => {
    health = { ...health, versionMatches: false };
    const gated = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(gated.availability).toMatchObject({ available: false, side: 'remote' });
    expect(vm.calls).toEqual([]);
    inventory.clear();
    expect(await copyBack.syncState(PROJECT, { remoteId: REMOTE })).toMatchObject({
      imported: false,
      groups: [],
    });
  });

  it("is gated when the VM rejects this PC's API key", async () => {
    health = { ...health, apiKeyRejected: true };
    const gated = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(gated.availability).toMatchObject({
      available: false,
      side: 'remote',
      reason: { code: 'remote-unreachable', message: expect.stringContaining('API key') },
    });
    expect(vm.calls).toEqual([]);
  });
});

describe('copy home', () => {
  // Real handoff and copy-back routes are needed to prove the skipped image is never loaded or paired.
  it('copies VM changes back with its holder image after Connect skips a project build', async () => {
    home.containers.delete('runner-id');
    vm.containers.delete('vm-runner');
    const imported = inventory.get(`${PROJECT}/${REMOTE}`)!;
    imported.items = [{ ...imported.items[0], vmImageId: 'sha256:removed' }];
    imported.groups = [imported.groups![0]];
    Object.assign(home.containers.get('db-id')!.Config.Labels!, {
      [`${COMPOSE}.config_files`]: join(root, 'compose.yaml'),
      'com.docker.compose.service': 'db',
    });
    jest.mocked(source.compose).mockResolvedValue({
      name: 'app',
      services: { db: { build: { context: root } } },
    });
    vm.images.delete('sha256:db');
    vm.images.set('sha256:rebuilt', { architecture: 'amd64', tags: ['app-db:latest'], size: 90 });
    vm.containers.get('vm-db')!.Image = 'sha256:rebuilt';
    vm.containers.get('vm-db')!.Config.Labels = { [OWNER]: PROJECT };
    const present = jest.spyOn(client, 'dockerImagesPresent');
    const reads = jest.spyOn(client, 'dockerReadArchive');
    const plan = await plans.plan(PROJECT, { remoteId: REMOTE }, undefined, { estimate: false });
    expect(plan.items[0]).toMatchObject({
      targetAction: 'leave-as-is',
      dataAction: 'keep-vm',
      images: [expect.objectContaining({ notCopied: true })],
      notes: expect.arrayContaining([
        'Image: not copied; the VM builds it from the synced project.',
      ]),
    });
    expect(plan.copySize).toEqual({ bytes: 0, unknown: false });
    expect(plan.filesystems).toEqual([]);
    expect(present).toHaveBeenLastCalledWith(REMOTE, [], expect.anything());

    const connectRun = {
      ...run(),
      operation: {
        ...run().operation,
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        kind: 'attach',
      } as RemoteOperation,
    };
    details.dockerSelection = { items: [{ id: 'db-id', mode: 'container-and-data' }] };
    await handoff.preflight(connectRun);
    await handoff.stopHome(connectRun);
    await handoff.push(connectRun);
    await handoff.createHost(connectRun);
    expect((await store.read(connectRun.operation.id))?.images).toEqual([]);
    expect(vm.calls).not.toContain('POST /images/load');
    expect(home.containers.get('db-id')!.State.Running).toBe(false);
    expect(inventory.get(`${PROJECT}/${REMOTE}`)!.items[0].vmImageId).toBe('sha256:removed');

    vm.data.set('app_db', Buffer.from('changed-after-connect'));
    vm.containers.get('vm-db')!.State = {
      Running: true,
      StartedAt: new Date(Date.now() + 1000).toISOString(),
    };
    await copyBack.copyHome(run());
    expect(text(home, 'app_db')).toBe('changed-after-connect');
    expect(result().copied).toEqual(['app-db-1']);
    expect(reads.mock.calls.map(([, input]) => input.image)).toEqual(['sha256:rebuilt']);
    expect(inventory.get(`${PROJECT}/${REMOTE}`)!.items[0].vmImageId).toBe('sha256:removed');
  });

  it('stops Compose-only VM holders, copies vm-newer groups with a verified digest and stamps them', async () => {
    await copyBack.copyHome(run());

    expect(text(home, 'app_db')).toBe('vm-db-rows');
    expect(text(home, state)).toBe('vm-state');
    // The VM keeps its data; only the running holder stopped.
    expect(text(vm, 'app_db')).toBe('vm-db-rows');
    expect(text(vm, state)).toBe('vm-state');
    expect(vm.containers.get('vm-db')!.State.Running).toBe(false);
    expect(vm.calls).toContain('POST /containers/vm-db/stop');
    // Home containers stay stopped, and nothing at home was deleted but helpers.
    expect(home.containers.get('db-id')!.State.Running).toBe(false);
    expect([...home.containers.keys()].sort()).toEqual(['db-id', 'runner-id']);
    expect(home.volumes.has('app_db')).toBe(true);
    expect(records()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ volumes: ['app_db'], lastSyncDirection: 'to-home' }),
        expect.objectContaining({ bindPaths: [state], lastSyncDirection: 'to-home' }),
      ]),
    );
    expect(result()).toEqual({ copied: ['app-db-1', 'runner'], kept: [], skipped: [] });

    const after = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(after.groups.map((g) => g.state)).toEqual(['in-sync', 'in-sync']);
  });

  // Fake engines and real VM authorization prove label attribution reaches the stop request.
  it.each([
    { location: 'working dir inside root', path: () => root, allowed: true },
    { location: 'shared prefix outside root', path: () => `${root}-other`, allowed: false },
  ])('handles a Compose holder of a hand-made volume with $location', async ({ path, allowed }) => {
    delete vm.volumes.get('app_db')!.labels[COMPOSE];
    vm.containers.get('vm-db')!.Config.Labels = {
      [COMPOSE]: 'app',
      [`${COMPOSE}.working_dir`]: path(),
    };
    if (allowed) {
      await copyBack.copyHome(run());
      expect(vm.containers.get('vm-db')!.State.Running).toBe(false);
      expect(vm.calls).toContain('POST /containers/vm-db/stop');
      expect(text(home, 'app_db')).toBe('vm-db-rows');
    } else {
      await expect(copyBack.copyHome(run())).rejects.toMatchObject({
        message: expect.stringContaining('Running VM containers that are not part of this project'),
      });
      expect(vm.containers.get('vm-db')!.State.Running).toBe(true);
      expect(vm.calls).not.toContain('POST /containers/vm-db/stop');
      expect(text(home, 'app_db')).toBe('home-db-rows');
    }
  });

  it('copies a bound single file back as a file', async () => {
    const caddyfile = join(root, 'dev-https', 'Caddyfile');
    await mkdir(join(root, 'dev-https'));
    await writeFile(caddyfile, 'on-disk');
    home.data.set(caddyfile, Buffer.from('home-caddy'));
    vm.data.set(caddyfile, Buffer.from('vm-caddy'));
    const fileMount: FakeMount = {
      Type: 'bind',
      Source: caddyfile,
      Destination: '/etc/caddy/Caddyfile',
      RW: false,
    };
    home.addContainer({
      Id: 'proxy-id',
      Name: '/proxy',
      Image: 'sha256:web',
      Created: BEFORE,
      startedAt: BEFORE,
      Config: { Image: 'app-web:latest' },
      HostConfig: { Binds: [`${caddyfile}:/etc/caddy/Caddyfile:ro`] },
      Mounts: [fileMount],
    });
    vm.addContainer({
      Id: 'vm-proxy',
      Name: '/proxy',
      Image: 'sha256:web',
      Created: AFTER,
      startedAt: AFTER,
      Config: { Labels: { [OWNER]: PROJECT } },
      HostConfig: {},
      Mounts: [fileMount],
    });
    const imported = inventory.get(`${PROJECT}/${REMOTE}`)!;
    imported.items.push({
      name: 'proxy',
      imageId: 'sha256:web',
      volumes: [],
      bindPaths: ['/dev-https/Caddyfile'],
      sizeBytes: 8,
    });
    imported.groups!.push({
      volumes: [],
      bindPaths: [caddyfile],
      lastSyncedAt: SYNCED,
      lastSyncDirection: 'to-vm',
    });
    const reads = jest.spyOn(client, 'dockerReadArchive');

    await copyBack.copyHome(run());

    expect(reads.mock.calls.map(([, input]) => input)).toContainEqual(
      expect.objectContaining({ mountType: 'file', source: caddyfile }),
    );
    expect(text(home, caddyfile)).toBe('vm-caddy');
    expect(text(home, state)).toBe('vm-state');
    expect((await stat(caddyfile)).isFile()).toBe(true);
    expect(result().copied).toContain('proxy');
  });

  it('uses the VM image ID on the VM and the home ID at home after a containerd-store import', async () => {
    // A fresh containerd-store VM: the same images load under engine-derived IDs.
    await vm.close();
    await rm(join(scratch, 'vm.sock'), { force: true });
    vm = new FakeDockerEngine('vm-engine', { imageStore: 'containerd' });
    await vm.listen(join(scratch, 'vm.sock'));
    seed();
    vm.images.clear();
    const homeClient = new DockerEngineClient(join(scratch, 'home.sock'));
    const loadIntoVm = async (id: string): Promise<string> => {
      const stream = await homeClient.stream('GET', `/images/get?names=${encodeURIComponent(id)}`);
      let archive = '';
      for await (const chunk of stream) archive += chunk.toString('utf8');
      const loaded = await client.dockerLoadImage(REMOTE, Readable.from(archive));
      expect(loaded.images).toHaveLength(1);
      return loaded.images[0]!.id;
    };
    const vmDb = await loadIntoVm('sha256:db');
    const vmWeb = await loadIntoVm('sha256:web');
    expect(vmDb).not.toBe('sha256:db');
    inventory.set(
      `${PROJECT}/${REMOTE}`,
      DockerImportInventorySchema.parse({
        importedAt: SYNCED,
        items: [
          {
            name: 'app-db-1',
            imageId: 'sha256:db',
            vmImageId: vmDb,
            volumes: [{ name: 'app_db', sizeBytes: 12 }],
            bindPaths: [],
            sizeBytes: 12,
          },
          {
            name: 'runner',
            imageId: 'sha256:web',
            vmImageId: vmWeb,
            volumes: [],
            bindPaths: [state],
            sizeBytes: 10,
          },
        ],
        groups: [
          { volumes: ['app_db'], bindPaths: [], lastSyncedAt: SYNCED, lastSyncDirection: 'to-vm' },
          { volumes: [], bindPaths: [state], lastSyncedAt: SYNCED, lastSyncDirection: 'to-vm' },
        ],
      }),
    );

    const readImages: string[] = [];
    const homeHelperImages: string[] = [];
    const vmHelperImages: string[] = [];
    const homeJournal = join(scratch, 'home', 'docker-helper-journal');
    const read = client.dockerReadArchive.bind(client);
    jest.spyOn(client, 'dockerReadArchive').mockImplementation(async (...args) => {
      readImages.push(args[1].image);
      return read(...args);
    });
    const createHelper = DockerArchiveJournal.prototype.create;
    jest.spyOn(DockerArchiveJournal.prototype, 'create').mockImplementation(async function (
      this: DockerArchiveJournal,
      ...args: Parameters<typeof createHelper>
    ) {
      // The home journal runs the copy-back helpers; the VM journal the host route's.
      (this.directory === homeJournal ? homeHelperImages : vmHelperImages).push(String(args[1]));
      return createHelper.apply(this, args);
    });

    await copyBack.copyHome(run());

    expect(text(home, 'app_db')).toBe('vm-db-rows');
    expect(text(home, state)).toBe('vm-state');
    // The VM helpers read and ran with the engine-derived IDs; the home helpers ran the home IDs.
    expect(readImages).toEqual([vmDb, vmWeb]);
    expect([...new Set(vmHelperImages)].sort()).toEqual([vmDb, vmWeb].sort());
    expect([...new Set(homeHelperImages)].sort()).toEqual(['sha256:db', 'sha256:web']);
  });

  it('still copies from a copy-back record written before VM image IDs existed', async () => {
    await store.writeCopyBack(OPERATION, {
      apiVersion: '1.47',
      groups: [
        {
          key: DB_GROUP(),
          label: 'app-db-1',
          state: 'vm-newer',
          action: 'copy-home',
          volumes: ['app_db'],
          bindPaths: [],
          images: ['sha256:db'],
          sizeBytes: 12,
        },
      ],
      projectContainers: ['db-id', 'runner-id'],
      started: [],
      verified: {},
      absent: [],
      decidedAt: BEFORE,
    });
    await copyBack.copyHome(run());
    expect(text(home, 'app_db')).toBe('vm-db-rows');
  });

  it('skips in-sync and home-newer groups', async () => {
    vm.containers.get('vm-db')!.Created = BEFORE;
    vm.containers.get('vm-db')!.State = { Running: false, StartedAt: BEFORE };
    home.containers.get('runner-id')!.State.StartedAt = AFTER;
    vm.containers.get('vm-runner')!.Created = BEFORE;
    vm.containers.get('vm-runner')!.State.StartedAt = BEFORE;

    await copyBack.copyHome(run());

    expect(text(home, 'app_db')).toBe('home-db-rows');
    expect(text(home, state)).toBe('home-state');
    expect(vm.calls.some((call) => call.endsWith('/archive'))).toBe(false);
    expect(result()).toEqual({ copied: [], kept: [], skipped: ['app-db-1', 'runner'] });
  });

  it('follows the choice for both-changed groups and stops the running home project holder', async () => {
    // Running at home counts as a home change: both sides changed.
    home.containers.get('db-id')!.State.Running = true;
    home.containers.get('runner-id')!.State.StartedAt = AFTER;
    details.dockerCopyBack = {
      choices: { [DB_GROUP()]: 'copy-home', [STATE_GROUP()]: 'keep-home' },
    };

    await copyBack.copyHome(run());

    expect(home.containers.get('db-id')!.State.Running).toBe(false);
    expect(home.calls.indexOf('POST /containers/db-id/stop')).toBeLessThan(
      home.calls.findIndex((call) => call.endsWith('/start')),
    );
    expect(text(home, 'app_db')).toBe('vm-db-rows');
    expect(text(home, state)).toBe('home-state');
    expect(records()).toContainEqual({
      volumes: [],
      bindPaths: [state],
      vmDiscardedAt: expect.any(String),
    });
    expect(result()).toEqual({ copied: ['app-db-1'], kept: ['runner'], skipped: [] });

    // Keeping home data acknowledges the VM changes; the next check wants home's copy.
    const after = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(after.groups.find((g) => g.key === STATE_GROUP())!.state).toBe('home-newer');
  });

  it('rechecks a dialog scan and refuses both-changed data before recording or emptying anything', async () => {
    const preview = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(preview.groups.find((g) => g.key === DB_GROUP())!.state).toBe('vm-newer');
    home.containers.get('db-id')!.State.StartedAt = AFTER;
    const refusal = copyBack.copyHome(run());
    await expect(refusal).rejects.toMatchObject({ code: 'DOCKER_COPY_BACK_CHOICE_REQUIRED' });
    await expect(refusal).rejects.toThrow(/app-db-1.*Cancel this Disconnect and start it again/);
    expect(await store.readCopyBack(OPERATION)).toBeNull();
    expect(text(home, 'app_db')).toBe('home-db-rows');
    expect(text(home, state)).toBe('home-state');
    // Retry refuses again while the state stays the same.
    await expect(makeCopyBack().copyHome(run())).rejects.toMatchObject({
      code: 'DOCKER_COPY_BACK_CHOICE_REQUIRED',
    });
  });

  it('does not overwrite home data changed before a Retry without a choice', async () => {
    const image = vm.images.get('sha256:db')!;
    vm.images.delete('sha256:db');
    const scan = client.dockerScan.bind(client);
    jest.spyOn(client, 'dockerScan').mockImplementation(async (...args) => {
      const result = await scan(...args);
      return { ...result, containers: result.containers.map((c) => ({ ...c, image: undefined })) };
    });
    await expect(copyBack.copyHome(run())).rejects.toThrow('none of its images');
    jest.mocked(client.dockerScan).mockRestore();
    expect((await store.readCopyBack(OPERATION))!.started).not.toContain(DB_GROUP());
    vm.images.set('sha256:db', image);
    home.containers.get('db-id')!.State.StartedAt = new Date().toISOString();
    home.data.set('app_db', Buffer.from('new-home-work-while-paused'));
    const current = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(current.groups.find((g) => g.key === DB_GROUP())!.state).toBe('both-changed');

    await expect(makeCopyBack().copyHome(run())).rejects.toMatchObject({
      code: 'DOCKER_COPY_BACK_CHOICE_REQUIRED',
      message: expect.stringContaining('app-db-1'),
    });
    expect(text(home, 'app_db')).toBe('new-home-work-while-paused');
  });

  it('refuses a later group whose home holder starts while an earlier group copies', async () => {
    const read = client.dockerReadArchive.bind(client);
    jest.spyOn(client, 'dockerReadArchive').mockImplementation(async (...args) => {
      if (args[1].mountType === 'volume')
        home.containers.get('runner-id')!.State.StartedAt = new Date().toISOString();
      return read(...args);
    });

    await expect(copyBack.copyHome(run())).rejects.toMatchObject({
      code: 'DOCKER_COPY_BACK_CHOICE_REQUIRED',
      message: expect.stringContaining('runner on this PC used the data of runner'),
    });
    expect(text(home, 'app_db')).toBe('vm-db-rows');
    expect(text(home, state)).toBe('home-state');
    const record = (await store.readCopyBack(OPERATION))!;
    expect(Object.keys(record.verified)).toEqual([DB_GROUP()]);
    expect(record.started).not.toContain(STATE_GROUP());
    expect(home.calls.filter((call) => call.endsWith('/start'))).toHaveLength(1);
  });

  it('refuses a group a running unrelated VM container holds, then stop-and-Retry completes it', async () => {
    vm.addContainer({
      Id: 'vm-other',
      Name: '/backup-job',
      Image: 'sha256:web',
      Created: BEFORE,
      startedAt: BEFORE,
      Config: { Labels: {} },
      HostConfig: {},
      Mounts: [volumeMount('app_db', '/backup')],
      running: true,
    });

    await expect(copyBack.copyHome(run())).rejects.toMatchObject({
      message: expect.stringContaining('backup-job'),
    });
    // Nothing of the refused group stopped or changed; the other group was copied.
    expect(vm.containers.get('vm-db')!.State.Running).toBe(true);
    expect(text(home, 'app_db')).toBe('home-db-rows');
    expect(text(home, state)).toBe('vm-state');

    // The documented recovery: the user stops it on the VM and presses Retry.
    vm.containers.get('vm-other')!.State.Running = false;
    const reads = () => vm.calls.filter((call) => call.endsWith('/archive')).length;
    const before = reads();
    await makeCopyBack().copyHome(run());
    expect(text(home, 'app_db')).toBe('vm-db-rows');
    expect(reads() - before).toBe(1);
    expect(result().copied).toEqual(['app-db-1', 'runner']);
    expect(vm.containers.get('vm-other')!.State.Running).toBe(false);
    expect(vm.calls).not.toContain('POST /containers/vm-other/stop');
  });

  it('passes a stopped Compose bind-only VM holder it does not recognize, and leaves it stopped', async () => {
    vm.containers.get('vm-runner')!.Config.Labels = { [COMPOSE]: 'bind-only-app' };
    expect(vm.containers.get('vm-runner')!.State.Running).toBe(false);
    await copyBack.copyHome(run());
    expect(text(home, state)).toBe('vm-state');
    expect(vm.containers.get('vm-runner')!.State.Running).toBe(false);
    expect(vm.calls).not.toContain('POST /containers/vm-runner/stop');
  });

  it('Keep home data stops a Compose-only VM holder, so the next check reads home-newer', async () => {
    home.containers.get('db-id')!.State.StartedAt = AFTER;
    details.dockerCopyBack = { choices: { [DB_GROUP()]: 'keep-home' } };
    await copyBack.copyHome(run());
    expect(vm.containers.get('vm-db')!.State.Running).toBe(false);
    expect(text(home, 'app_db')).toBe('home-db-rows');
    const after = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(after.groups.find((g) => g.key === DB_GROUP())!.state).toBe('home-newer');
  });

  it('Keep home data never stops an unrelated VM holder; that group can ask again', async () => {
    vm.addContainer({
      Id: 'vm-other',
      Name: '/backup-job',
      Image: 'sha256:web',
      Created: BEFORE,
      startedAt: BEFORE,
      Config: { Labels: {} },
      HostConfig: {},
      Mounts: [volumeMount('app_db', '/backup')],
      running: true,
    });
    home.containers.get('db-id')!.State.StartedAt = AFTER;
    details.dockerCopyBack = { choices: { [DB_GROUP()]: 'keep-home' } };
    await copyBack.copyHome(run());
    expect(vm.containers.get('vm-other')!.State.Running).toBe(true);
    expect(vm.calls).not.toContain('POST /containers/vm-other/stop');
    expect(vm.containers.get('vm-db')!.State.Running).toBe(false);
    expect(result().kept).toEqual(['app-db-1']);
    const after = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(after.groups.find((g) => g.key === DB_GROUP())!.state).toBe('both-changed');
  });

  it('rejects stopping a different project container even with matching Compose labels', async () => {
    vm.containers.get('vm-db')!.Config.Labels![OWNER] = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await expect(client.dockerStopContainer(REMOTE, 'vm-db', PROJECT)).rejects.toMatchObject({
      status: 403,
    });
    expect(vm.containers.get('vm-db')!.State.Running).toBe(true);
  });

  it('verifies a large archive across the raw response and trailer', async () => {
    const bytes = Buffer.alloc(256 * 1024, 'x');
    vm.data.set('app_db', bytes);
    await copyBack.copyHome(run());
    expect(home.data.get('app_db')).toEqual(bytes);
    expect(records()).toContainEqual(
      expect.objectContaining({ volumes: ['app_db'], lastSyncDirection: 'to-home' }),
    );
  });

  it('refuses a running unrelated home holder by name', async () => {
    home.addContainer({
      Id: 'home-other',
      Name: '/pgadmin',
      Image: 'sha256:web',
      Config: { Image: 'app-web:latest' },
      HostConfig: {},
      Mounts: [volumeMount('app_db', '/other')],
      Created: BEFORE,
      startedAt: BEFORE,
      running: true,
    });
    details.dockerCopyBack = { choices: { [DB_GROUP()]: 'copy-home' } };
    await expect(copyBack.copyHome(run())).rejects.toMatchObject({
      message: expect.stringContaining('pgadmin'),
    });
    expect(home.containers.get('home-other')!.State.Running).toBe(true);
    expect(text(home, 'app_db')).toBe('home-db-rows');
  });

  it('fails a group whose digest does not match, and a cancel names it after a restart', async () => {
    const read = client.dockerReadArchive.bind(client);
    jest.spyOn(client, 'dockerReadArchive').mockImplementation(async (...args) => {
      const answer = await read(...args);
      return args[1].mountType === 'volume'
        ? { archive: answer.archive, sha256: () => 'f'.repeat(64) }
        : answer;
    });

    await expect(copyBack.copyHome(run())).rejects.toMatchObject({
      message: expect.stringContaining('did not match'),
    });
    expect(await makeCopyBack().partialGroups(OPERATION)).toEqual(['app-db-1']);
    expect(records()).toContainEqual(
      expect.objectContaining({ volumes: ['app_db'], lastSyncDirection: 'to-vm' }),
    );

    // The emptied, unverified group resumes: this operation's own helpers are no change.
    jest.mocked(client.dockerReadArchive).mockRestore();
    const reads = () => vm.calls.filter((call) => call.endsWith('/archive')).length;
    const before = reads();
    await makeCopyBack().copyHome(run());
    expect(text(home, 'app_db')).toBe('vm-db-rows');
    expect(await copyBack.partialGroups(OPERATION)).toEqual([]);
    // The verified folder group is not copied again.
    expect(reads() - before).toBe(1);
    expect(result().copied).toEqual(['app-db-1', 'runner']);
  });

  it('names a helper image missing on this PC', async () => {
    await store.writeCopyBack(OPERATION, {
      apiVersion: '1.47',
      projectContainers: ['db-id'],
      started: [],
      verified: {},
      absent: [],
      decidedAt: new Date().toISOString(),
      groups: [
        {
          key: DB_GROUP(),
          label: 'app-db-1',
          state: 'vm-newer',
          action: 'copy-home',
          volumes: ['app_db'],
          bindPaths: [],
          images: ['sha256:gone'],
          sizeBytes: 12,
        },
      ],
    });
    vm.images.set('sha256:gone', { architecture: 'amd64', tags: [], size: 1 });
    await expect(copyBack.copyHome(run())).rejects.toMatchObject({
      message: expect.stringContaining('Image sha256:gone is missing on this PC'),
    });
    expect(text(home, 'app_db')).toBe('home-db-rows');
  });

  // Real plan and stored retry decisions prove neither path can reach archive mutation.
  it.each(['initial decision', 'stored retry'])(
    'refuses mismatched user ids before copying or accepting kept data: %s',
    async (attempt) => {
      if (attempt === 'stored retry') {
        await store.writeCopyBack(OPERATION, {
          apiVersion: '1.47',
          projectContainers: ['db-id'],
          started: [],
          verified: {},
          absent: [],
          decidedAt: SYNCED,
          groups: [
            {
              key: DB_GROUP(),
              label: 'app-db-1',
              state: 'vm-newer',
              action: 'keep-home',
              volumes: ['app_db'],
              bindPaths: [],
              images: ['sha256:db'],
              sizeBytes: 12,
            },
          ],
        });
      }
      const previous = await store.readCopyBack(OPERATION);
      jest.spyOn(client, 'remoteRuntime').mockResolvedValue({
        ...(await client.remoteRuntime(REMOTE)),
        uid: (source.uid() ?? 1000) + 1,
      });
      const before = structuredClone(records());

      await expect(copyBack.copyHome(run())).rejects.toMatchObject({
        code: 'DOCKER_COPY_BACK_UNAVAILABLE',
        message: expect.stringContaining('user ids differ'),
      });

      expect(text(home, 'app_db')).toBe('home-db-rows');
      expect(text(vm, 'app_db')).toBe('vm-db-rows');
      expect(vm.containers.get('vm-db')!.State.Running).toBe(true);
      expect(records()).toEqual(before);
      expect(await store.readCopyBack(OPERATION)).toEqual(previous);
      expect(home.calls.some((call) => call.includes('/archive') || call.includes('/stop'))).toBe(
        false,
      );
      expect(vm.calls.some((call) => call.includes('/archive') || call.includes('/stop'))).toBe(
        false,
      );
    },
  );

  it('fails with Retry when the VM Docker engine is down', async () => {
    jest.spyOn(client, 'remoteRuntime').mockResolvedValue({
      docker: { installed: false },
    } as never);
    await expect(copyBack.copyHome(run())).rejects.toMatchObject({
      code: 'DOCKER_COPY_BACK_UNAVAILABLE',
    });
    expect(await store.readCopyBack(OPERATION)).toBeNull();
  });
});

describe('composition', () => {
  // Real DetachOperation and DockerCopyBack; the collaborators of other steps are never reached.
  const unused = {} as never;
  const detachOperation = () =>
    new DetachOperation(
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      copyBack,
      {} as never,
    );

  it('does not copy home during Reset without the optional Disconnect flag', async () => {
    const reset = new ResetVmOperation(
      unused,
      unused,
      unused,
      detachOperation(),
      { steps: [] } as never,
      { steps: [] } as never,
      unused,
    );
    const resetDetails = { projectIds: [PROJECT], force: false };
    const ids = reset.stepsFor(resetDetails).map((step) => step.id);
    expect(ids).toContain(`detach:${PROJECT}:docker_stop_host`);
    expect(ids).not.toContain(`detach:${PROJECT}:docker_copy_home`);
    expect(text(home, 'app_db')).toBe('home-db-rows');
  });

  it('copies through the Disconnect step when asked', async () => {
    const step = detachOperation()
      .stepsFor({ force: false, dockerCopyBack: { choices: {} } })
      .find((s) => s.id === 'docker_copy_home')!;
    await step.run(run());
    expect(text(home, 'app_db')).toBe('vm-db-rows');
  });
});
