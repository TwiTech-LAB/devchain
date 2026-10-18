import { sharedVmGuardStub } from '../../../common/test/shared-vm.stub';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { HostDockerVolumeAssociationsStore } from '../host/host-docker-volume-associations.store';
import { ProjectFreezeService } from '../host/project-freeze.service';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';
import { Scope } from '@nestjs/common';
// Fake engines on both sides; the VM side runs the real host routes behind the real LAN client,
// so the archive digest travels as a real HTTP trailer.
import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { parse, stringify } from 'yaml';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { tarArchive, tarEntries } from '../../../common/test/docker-tar.fixture';
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
  connectExclusions,
  type DockerImportInventory,
} from '../operations/docker-import-inventory.store';
import { DetachOperation } from '../operations/detach.operation';
import { RemoteHostClient } from '../operations/remote-host.client';
import { ResetVmOperation } from '../operations/reset-vm.operation';
import type { RemoteOperationStepRun } from '../operations/remote-operation.types';
import type { RemoteHealthState } from '../ports/remote-health.port';
import { DockerCopyBack } from './docker-copy-back';
import { DockerCopyBackExclusions } from './docker-copy-back-exclusions';
import { DockerHandoff } from './docker-handoff';
import { dockerDataGroupKey } from './docker-data-groups';
import type { DockerCopyBackResult, DockerSyncState } from './docker-copy-back.dto';
import { DockerHandoffStore } from './docker-handoff.store';
import { DockerPlanService } from './docker-plan.service';
import { DockerPlanController } from './docker-plan.controller';
import { DockerPlanSourceService, type ComposeConfig } from './docker-plan-source.service';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { codeIgnores } from '../../file-sync/file-sync.dto';

const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REMOTE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OWNER = 'dev.devchain.project';
const COMPOSE = 'com.docker.compose.project';
/** The last Connect's copy; home holders ran before it, VM holders after it. */
const SYNCED = '2026-01-01T00:00:00.000Z';
const BEFORE = '2025-12-01T00:00:00.000Z';
const AFTER = '2026-02-01T00:00:00.000Z';

function ownerArchive(uid = 1001, gid = 1002): Buffer {
  return tarArchive([
    { path: 'data/', type: 'Directory', uid, gid, mode: 0o700, contents: '' },
    { path: 'data/private', type: 'File', uid, gid, mode: 0o600, contents: 'secret' },
    { path: 'data/root', type: 'File', uid: 0, gid: 0, mode: 0o600, contents: 'root' },
    { path: 'data/service', type: 'File', uid: 999, gid: 999, mode: 0o600, contents: 'db' },
    { path: 'data/home', type: 'File', uid: 1000, gid: 1000, mode: 0o600, contents: 'home' },
    { path: 'data/mixed', type: 'File', uid: 1000, gid, mode: 0o600, contents: 'mixed' },
  ]);
}

function archiveEntries(archive: Buffer) {
  return tarEntries(archive).map(({ contents: _contents, ...entry }) => entry);
}

/** Home runs as 1000:1000; the VM reports the given ids. */
async function differentIds(vmIds = { uid: 1001, gid: 1002 }): Promise<void> {
  jest.spyOn(source, 'uid').mockReturnValue(1000);
  jest.spyOn(source, 'gid').mockReturnValue(1000);
  jest.mocked(client.remoteRuntime).mockResolvedValue({
    ...(await client.remoteRuntime(REMOTE)),
    ...vmIds,
  });
}

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
let associationsDatabase: ReturnType<typeof createTestDatabase>;
const vmGate = new ProjectWriteGate();
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
let exclusions: {
  prepare: jest.Mock;
  preview: jest.Mock;
  confirm: jest.Mock;
};

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
  associationsDatabase = createTestDatabase();
  vmGate.bindStorage({
    listRemoteProjectBindings: async () => [],
    getRemote: async () => {
      throw new Error('The VM has no remotes.');
    },
    listFrozenProjects: async () => [],
  });
  const module = await Test.createTestingModule({
    controllers: [HostDockerController],
    providers: [
      HostDockerService,
      // The VM's own gate, so a freeze in a test reaches anything that consults it.
      { provide: ProjectWriteGate, useValue: vmGate },
      { provide: DB_CONNECTION, useValue: associationsDatabase.db },
      HostDockerVolumeAssociationsStore,
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
  associationsDatabase.sqlite
    .prepare('DELETE FROM settings WHERE key = ?')
    .run('host.dockerVolumeAssociations');
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
  let managedExclusions: string[] = [];
  const installedIgnores = async () => ({ ignore: codeIgnores(managedExclusions, []) });
  jest.spyOn(client, 'syncFolderIgnores').mockImplementation(installedIgnores);
  handoff = new DockerHandoff(
    plans,
    source,
    client,
    store,
    new DockerArchiveJournal(join(scratch, 'home')),
    {
      get: () => managedExclusions,
      set: (_project: string, paths: string[]) => {
        managedExclusions = paths;
      },
    } as never,
    inventoryStore as never,
    { recordPlan: () => undefined } as never,
    { installedIgnores } as never,
  );
  // A new instance over the same directories is a home restart.
  exclusions = {
    preview: jest.fn(
      async (_project: string, _remote: string, _root: string, targets: string[]) => targets,
    ),
    prepare: jest.fn(
      async (_project: string, _remote: string, _root: string, targets: string[]) => ({
        revision: 0,
        confirmed: targets,
        pending: true,
      }),
    ),
    confirm: jest.fn(
      async (_project: string, _remote: string, _root: string, targets: string[]) => targets,
    ),
  };
  makeCopyBack = () =>
    new DockerCopyBack(
      plans,
      source,
      client,
      new DockerHandoffStore(join(scratch, 'home')),
      new DockerArchiveJournal(join(scratch, 'home')),
      inventoryStore as never,
      { getState: () => health } as never,
      exclusions as never,
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
  associationsDatabase.sqlite.close();
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

  it('is gated on the VM version before Docker discovery', async () => {
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
    expect(exclusions.confirm.mock.calls.map((call) => call[3])).toEqual([
      [state],
      [state],
      [state],
    ]);

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
    expect(result()).toEqual({
      copied: ['app-db-1', 'runner'],
      kept: [],
      skipped: [],
      alreadyTargetEntries: 0,
    });

    const after = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(after.groups.map((g) => g.state)).toEqual(['in-sync', 'in-sync']);
  });

  it('copies volume-only groups without ownership scans or installed-bind readbacks', async () => {
    vm.containers.delete('vm-runner');
    home.containers.delete('runner-id');
    const imported = inventory.get(`${PROJECT}/${REMOTE}`)!;
    imported.items = imported.items.filter((item) => item.name !== 'runner');
    imported.groups = imported.groups!.filter((group) => !group.bindPaths.length);
    await copyBack.prepareHomeCopy(run());
    await copyBack.copyHome(run());
    expect(text(home, 'app_db')).toBe('vm-db-rows');
    expect(result()).toEqual({
      copied: ['app-db-1'],
      kept: [],
      skipped: [],
      alreadyTargetEntries: 0,
    });
    expect(exclusions.prepare).not.toHaveBeenCalled();
    expect(exclusions.confirm).not.toHaveBeenCalled();
    expect(records()).toContainEqual(
      expect.objectContaining({ volumes: ['app_db'], lastSyncDirection: 'to-home' }),
    );
  });

  it('refuses legacy inventoried data inside the Git share without clearing, copying or stamping it', async () => {
    const target = join(root, '.git', 'runtime');
    await mkdir(target, { recursive: true });
    home.containers.get('runner-id')!.Mounts[0].Source = target;
    vm.containers.get('vm-runner')!.Mounts[0].Source = target;
    home.data.set(target, Buffer.from('home Git data'));
    vm.data.set(target, Buffer.from('VM Git data'));
    const imported = inventory.get(`${PROJECT}/${REMOTE}`)!;
    imported.items.find((item) => item.name === 'runner')!.bindPaths = ['/.git/runtime'];
    imported.groups!.find((group) => group.bindPaths.length)!.bindPaths = [target];
    const barrier = new DockerCopyBackExclusions(
      {
        getIgnoresRevision: () => 0,
        getIgnores: () => [],
        updateFolder: async () => undefined,
        installedIgnores: async () => ({ ignore: ['/.git'] }),
      } as never,
      {
        syncFolderType: async () => undefined,
        syncFolderIgnores: async () => ({ ignore: ['/.git'] }),
      } as never,
      { vmSuggestions: async () => ({ groups: [] }) } as never,
      { get: () => [] } as never,
      { get: async () => ({ remoteId: REMOTE, state: 'detaching' }) } as never,
    );
    exclusions.prepare.mockImplementation(barrier.prepare.bind(barrier));
    exclusions.confirm.mockImplementation(barrier.confirm.bind(barrier));
    const clear = jest.spyOn(DockerArchiveJournal.prototype, 'clear');
    const read = jest.spyOn(client, 'dockerReadArchive');
    await copyBack.prepareHomeCopy(run());
    await copyBack.copyHome(run());
    expect(text(home, target)).toBe('home Git data');
    expect(text(vm, target)).toBe('VM Git data');
    expect(clear.mock.calls.map((call) => call[3])).not.toContain(target);
    expect(read.mock.calls.map(([, request]) => request.source)).not.toContain(target);
    const key = dockerDataGroupKey({ volumes: [], bindPaths: [target] });
    const record = (await store.readCopyBack(OPERATION))!;
    expect(record.started).not.toContain(key);
    expect(record.verified[key]).toBeUndefined();
    expect(records()).toContainEqual(
      expect.objectContaining({ bindPaths: [target], lastSyncDirection: 'to-vm' }),
    );
    expect(details.dockerCopyBackSkipped).toEqual([
      { path: target, reason: 'still synced by file sync' },
    ]);
    expect(result()).toEqual({
      copied: ['app-db-1'],
      kept: [],
      skipped: ['runner'],
      alreadyTargetEntries: 0,
    });
  });

  it('leaves an unconfirmed bind group intact and names it without stamping its data', async () => {
    exclusions.prepare.mockResolvedValue({ revision: 0, confirmed: [], pending: true });
    await copyBack.prepareHomeCopy(run());
    await copyBack.copyHome(run());
    expect(text(home, state)).toBe('home-state');
    expect(text(vm, state)).toBe('vm-state');
    expect(result()).toEqual({
      copied: ['app-db-1'],
      kept: [],
      skipped: ['runner'],
      alreadyTargetEntries: 0,
    });
    expect(details.dockerCopyBackSkipped).toEqual([
      { path: state, reason: 'still synced by file sync' },
    ]);
    expect(records()).toContainEqual(
      expect.objectContaining({ bindPaths: [state], lastSyncDirection: 'to-vm' }),
    );
    const record = (await store.readCopyBack(OPERATION))!;
    expect(record.started).not.toContain(STATE_GROUP());
    expect(record.verified[STATE_GROUP()]).toBeUndefined();
    expect(exclusions.prepare).toHaveBeenCalledTimes(1);
  });

  it('rechecks installed peers despite a completed preparation record and repeats preparation on Retry', async () => {
    await copyBack.prepareHomeCopy(run());
    exclusions.confirm.mockResolvedValue([]);
    await makeCopyBack().copyHome(run());
    expect(text(home, state)).toBe('home-state');
    expect(result().skipped).toEqual(['runner']);
    const before = vm.calls.filter((call) => call.endsWith('/archive')).length;
    exclusions.confirm.mockImplementation(
      async (_p: string, _r: string, _root: string, paths: string[]) => paths,
    );
    await makeCopyBack().copyHome(run());
    expect(text(home, state)).toBe('vm-state');
    expect(exclusions.prepare).toHaveBeenCalledTimes(2);
    expect(vm.calls.filter((call) => call.endsWith('/archive')).length - before).toBe(1);
    expect(details.dockerCopyBackSkipped).toEqual([]);
    expect(result().skipped).toEqual([]);
  });

  it('refuses a bind whose proof changes at its final pre-clear check', async () => {
    let checks = 0;
    exclusions.confirm.mockImplementation(
      async (_p: string, _r: string, _root: string, paths: string[]) =>
        ++checks === 3 ? [] : paths,
    );
    await expect(copyBack.copyHome(run())).rejects.toThrow('still synced by file sync');
    expect(checks).toBe(3);
    expect(text(home, state)).toBe('home-state');
    expect(text(vm, state)).toBe('vm-state');
    expect(records()).toContainEqual(
      expect.objectContaining({ bindPaths: [state], lastSyncDirection: 'to-vm' }),
    );
    expect((await store.readCopyBack(OPERATION))!.verified[STATE_GROUP()]).toBeUndefined();
    expect(details.dockerCopyBackSkipped).toEqual([
      { path: state, reason: 'still synced by file sync' },
    ]);
  });

  it('prepares an older persisted copy record before it can clear binds', async () => {
    await copyBack.prepareHomeCopy(run());
    const record = (await store.readCopyBack(OPERATION))!;
    delete record.exclusions;
    await store.writeCopyBack(OPERATION, record);
    exclusions.prepare.mockClear();
    exclusions.prepare.mockResolvedValue({ revision: 0, confirmed: [], pending: true });
    await makeCopyBack().copyHome(run());
    expect(exclusions.prepare).toHaveBeenCalledTimes(1);
    expect(text(home, state)).toBe('home-state');
    expect((await store.readCopyBack(OPERATION))!.verified[STATE_GROUP()]).toBeUndefined();
  });

  // Two engines and the real host routes prove unlabelled Compose data reaches stop/read/restore.
  it.each(['project-root', 'imported-volume'])(
    'copies a VM Compose volume recognized through %s and records it in sync',
    async (association) => {
      delete vm.volumes.get('app_db')!.labels[OWNER];
      if (association === 'project-root')
        vm.containers.get('vm-db')!.Config.Labels![`${COMPOSE}.working_dir`] = root;
      else
        vm.volumes.set('app_seed', {
          labels: { [OWNER]: PROJECT, [COMPOSE]: 'app' },
          driver: 'local',
        });
      await copyBack.copyHome(run());
      expect(text(home, 'app_db')).toBe('vm-db-rows');
      expect(vm.containers.get('vm-db')!.State.Running).toBe(false);
      expect(records()).toContainEqual(
        expect.objectContaining({ volumes: ['app_db'], lastSyncDirection: 'to-home' }),
      );
      const after = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
      expect(after.groups.find((g) => g.key === DB_GROUP())!.state).toBe('in-sync');
    },
  );

  it('stops an unlabelled docker-run bind holder before copying its VM data', async () => {
    vm.containers.get('vm-runner')!.Config.Labels = {};
    vm.containers.get('vm-runner')!.State.Running = true;
    await copyBack.copyHome(run());
    expect(text(home, state)).toBe('vm-state');
    expect(vm.containers.get('vm-runner')!.State.Running).toBe(false);
    expect(vm.calls).toContain('POST /containers/vm-runner/stop');
  });

  it('refuses a foreign-owner VM bind holder before stopping it or replacing home data', async () => {
    vm.containers.get('vm-runner')!.Config.Labels = {
      [OWNER]: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    };
    vm.containers.get('vm-runner')!.State.Running = true;
    await expect(copyBack.copyHome(run())).rejects.toMatchObject({
      code: 'DOCKER_COPY_BACK_FAILED',
      message: expect.stringContaining('Running VM containers that are not part of this project'),
    });
    expect(text(home, state)).toBe('home-state');
    expect(vm.containers.get('vm-runner')!.State.Running).toBe(true);
    expect(vm.calls).not.toContain('POST /containers/vm-runner/stop');
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
    expect(result()).toEqual({
      copied: [],
      kept: [],
      skipped: ['app-db-1', 'runner'],
      alreadyTargetEntries: 0,
    });
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
    expect(result()).toEqual({
      copied: ['app-db-1'],
      kept: ['runner'],
      skipped: [],
      alreadyTargetEntries: 0,
    });

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

  it('passes a stopped Compose bind-only VM holder and leaves it stopped', async () => {
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
    home.images.clear();
    vm.containers.get('vm-db')!.Config.Image = 'sha256:gone';
    vm.images.set('sha256:gone', { architecture: 'amd64', tags: [], size: 1 });
    await expect(copyBack.copyHome(run())).rejects.toMatchObject({
      message: expect.stringContaining('Image sha256:gone is missing on this PC'),
    });
    expect(text(home, 'app_db')).toBe('home-db-rows');
  });

  // Real plan and stored retry decisions prove neither path can reach archive mutation.
  it.each(['initial decision', 'without inventory', 'stored retry'])(
    'refuses unknown user ids before copying or accepting kept data: %s',
    async (attempt) => {
      if (attempt === 'without inventory') inventory.clear();
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
        uid: null,
      });
      const before = structuredClone(inventory.get(`${PROJECT}/${REMOTE}`));

      await expect(copyBack.copyHome(run())).rejects.toMatchObject({
        code: 'DOCKER_COPY_BACK_UNAVAILABLE',
        message: expect.stringContaining('user ids differ'),
      });

      expect(text(home, 'app_db')).toBe('home-db-rows');
      expect(text(vm, 'app_db')).toBe('vm-db-rows');
      expect(vm.containers.get('vm-db')!.State.Running).toBe(true);
      expect(inventory.get(`${PROJECT}/${REMOTE}`)).toEqual(before);
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
      { assertRemoteEmpty: jest.fn().mockResolvedValue(null) } as never,
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
      { assertRemoteEmpty: jest.fn().mockResolvedValue(null) } as never,
      sharedVmGuardStub(),
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

// Fake engines plus the actual host/client/workflow are the cheapest discovery and copy boundary.
describe('data created on the VM', () => {
  function vmOnly() {
    inventory.clear();
    home.containers.clear();
    home.volumes.clear();
    home.data.clear();
    vm.containers.clear();
    vm.volumes.get('app_db')!.labels = {
      [COMPOSE]: 'app',
      'com.docker.compose.volume': 'db',
      'com.docker.compose.version': '5.6.0',
    };
    vm.addContainer({
      Id: 'vm-only',
      Name: '/vm-only',
      Image: 'sha256:db',
      Created: AFTER,
      startedAt: AFTER,
      Config: {
        Image: 'postgres:17',
        Labels: { [COMPOSE]: 'app', [`${COMPOSE}.working_dir`]: root },
      },
      HostConfig: {},
      Mounts: [volumeMount('app_db', '/data'), bindMount()],
      running: true,
    });
  }
  const key = () => dockerDataGroupKey({ volumes: ['app_db'], bindPaths: [state] });

  it('offers new grouped data without an import and creates a labelled home volume and data-only inventory', async () => {
    vmOnly();
    const sync = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(sync).toMatchObject({
      imported: false,
      availability: { available: true },
      groups: [
        {
          key: key(),
          createdOnVm: true,
          needsChoice: false,
          state: 'vm-newer',
          volumes: ['app_db'],
          bindPaths: [state],
        },
      ],
    });
    await copyBack.copyHome(run());
    expect(text(home, 'app_db')).toBe('vm-db-rows');
    expect(text(home, state)).toBe('vm-state');
    expect(home.volumes.get('app_db')!.labels).toEqual(vm.volumes.get('app_db')!.labels);
    expect(home.containers.size).toBe(0);
    expect(vm.containers.get('vm-only')!.State.Running).toBe(false);
    expect(inventory.get(`${PROJECT}/${REMOTE}`)).toMatchObject({
      items: [],
      groups: [{ volumes: ['app_db'], bindPaths: [state], lastSyncDirection: 'to-home' }],
    });
    expect(result()).toEqual({
      copied: ['vm-only'],
      kept: [],
      skipped: [],
      alreadyTargetEntries: 0,
    });
    const clear = home.calls.filter((call) => /\/start$/.test(call));
    expect(clear).toHaveLength(1); // Existing bind only; the newly created volume needs no clear.
    git.setDefaultResponse({ type: 'success', stdout: 'state/main.py\0' });
    expect((await copyBack.syncState(PROJECT, { remoteId: REMOTE })).groups).toContainEqual(
      expect.objectContaining({ volumes: ['app_db'], bindPaths: [state] }),
    );
    git.setDefaultResponse({ type: 'failure', exitCode: 128 });

    // This existing workflow is the smallest seam that carries the actual copy stamp into Connect.
    const copied = inventory.get(`${PROJECT}/${REMOTE}`)!;
    const plan = () => plans.plan(PROJECT, { remoteId: REMOTE }, undefined, { estimate: false });
    const withoutCompose = await plan();
    expect(withoutCompose.items).toEqual([]);
    expect(withoutCompose.dataGroups).toEqual([
      { itemIds: [], volumes: ['app_db'], bindPaths: [state], state: 'in-sync' },
    ]);
    expect(connectExclusions(withoutCompose, copied, root)).toEqual(['/state']);

    jest.mocked(source.compose).mockResolvedValue({
      name: 'app',
      services: {
        db: {
          image: 'postgres:17',
          volumes: [{ type: 'bind', source: state, target: '/state' }],
        },
      },
      volumes: { db: { name: 'app_db' } },
    });
    const reconnect = await plan();
    expect(reconnect.items).toEqual([
      expect.objectContaining({
        kind: 'compose-project',
        dataState: 'in-sync',
        dataAction: 'keep-vm',
        mounts: expect.arrayContaining([expect.objectContaining({ source: state })]),
      }),
    ]);
    expect(connectExclusions(reconnect, copied, root)).toEqual(['/state']);
    expect(home.containers.size).toBe(0);

    const changedAt = new Date(Date.parse(copied.groups![0].lastSyncedAt!) + 1000).toISOString();
    home.addContainer({
      Id: 'home-changed',
      Name: '/app-db-1',
      Image: 'sha256:db',
      Created: changedAt,
      startedAt: changedAt,
      Config: { Labels: { [COMPOSE]: 'app', [`${COMPOSE}.working_dir`]: root } },
      HostConfig: { Binds: ['app_db:/data', `${state}:/state`] },
      Mounts: [volumeMount('app_db', '/data'), bindMount()],
    });
    expect((await plan()).items[0]).toMatchObject({
      dataState: 'home-newer',
      dataAction: 'replace-home',
    });
    expect(inventory.get(`${PROJECT}/${REMOTE}`)).toEqual(copied);

    home.data.set('app_db', Buffer.from('changed-at-home'));
    details.dockerSelection = { items: [{ id: 'home-changed', mode: 'container-and-data' }] };
    const connectRun = () => ({
      ...run(),
      operation: {
        ...run().operation,
        kind: 'attach' as const,
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      },
    });
    await handoff.preflight(connectRun());
    await handoff.stopHome(connectRun());
    // Connect's push_replica freezes the VM project before docker_push; thaw_host comes later.
    new ProjectFreezeService({} as never, vmGate).hold(PROJECT, new Date().toISOString());
    let failDelete = true;
    vm.intercept = (method, path, response) => {
      if (!failDelete || method !== 'DELETE' || path !== '/volumes/app_db') return false;
      failDelete = false;
      response.statusCode = 500;
      response.end(JSON.stringify({ message: 'Temporary volume deletion failure' }));
      return true;
    };
    await expect(handoff.push(connectRun())).rejects.toMatchObject({ status: 502 });
    expect(vm.containers.has('vm-only')).toBe(false);
    expect(vm.volumes.has('app_db')).toBe(true);
    expect(text(vm, 'app_db')).toBe('vm-db-rows');
    expect(app.get(HostDockerVolumeAssociationsStore).matches(PROJECT, 'app_db', 'app')).toBe(true);
    await handoff.push(connectRun());
    await handoff.createHost(connectRun());
    expect(text(vm, 'app_db')).toBe('changed-at-home');
    expect([...vm.containers.values()].find((c) => c.Name === '/app-db-1')).toMatchObject({
      State: { Running: false },
      Config: { Labels: { [OWNER]: PROJECT } },
    });
    expect(app.get(HostDockerVolumeAssociationsStore).matches(PROJECT, 'app_db', 'app')).toBe(
      false,
    );
    expect(vmGate.isFrozen(PROJECT)).toBe(true);
    vmGate.markThawed(PROJECT);
  });

  it.each(['volume', 'partial folder'] as const)(
    'requires explicit replacement for existing home %s data',
    async (target) => {
      vmOnly();
      if (target === 'volume') {
        home.volumes.set('app_db', { driver: 'local', labels: {} });
        home.data.set('app_db', Buffer.from('existing-home'));
      } else {
        await writeFile(join(state, 'partial'), 'file-sync copy');
        home.data.set(state, Buffer.from('partial-home'));
      }
      const sync = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
      expect(sync.groups[0]).toMatchObject({
        createdOnVm: true,
        state: 'unknown',
        needsChoice: true,
      });
      await expect(copyBack.copyHome(run())).rejects.toMatchObject({
        code: 'DOCKER_COPY_BACK_CHOICE_REQUIRED',
      });
      expect(vm.containers.get('vm-only')!.State.Running).toBe(true);
      expect(home.calls.some((call) => /\/start$/.test(call))).toBe(false);
      details.dockerCopyBack = { choices: { [key()]: 'copy-home' } };
      await copyBack.copyHome(run());
      expect(text(home, 'app_db')).toBe('vm-db-rows');
      expect(text(home, state)).toBe('vm-state');
      expect(result().copied).toEqual(['vm-only']);
    },
  );

  it('retries a lost volume-create response without changing the saved default-copy decision', async () => {
    vmOnly();
    let lose = true;
    home.loseResponse = (method, path) => {
      if (!lose || method !== 'POST' || path !== '/volumes/create') return false;
      lose = false;
      return true;
    };
    await expect(copyBack.copyHome(run())).rejects.toMatchObject({
      code: 'DOCKER_COPY_BACK_FAILED',
    });
    expect(home.volumes.has('app_db')).toBe(true);
    expect(inventory.size).toBe(0);
    expect(details.dockerCopyBackResult).toBeUndefined();
    expect(await copyBack.partialGroups(OPERATION)).toEqual(['vm-only']);
    const saved = (await store.readCopyBack(OPERATION))!.groups;
    await makeCopyBack().copyHome(run());
    expect((await store.readCopyBack(OPERATION))!.groups).toEqual(saved);
    expect(text(home, 'app_db')).toBe('vm-db-rows');
    expect(text(home, state)).toBe('vm-state');
    expect(result().copied).toEqual(['vm-only']);
    expect(await copyBack.partialGroups(OPERATION)).toEqual([]);
    expect(home.calls.filter((call) => call === 'POST /volumes/create')).toHaveLength(1);
    expect(records()).toContainEqual(
      expect.objectContaining({
        volumes: ['app_db'],
        bindPaths: [state],
        lastSyncDirection: 'to-home',
      }),
    );
  });

  it('refuses home data that appears after the default-copy decision', async () => {
    vmOnly();
    await copyBack.prepareHomeCopy(run());
    await writeFile(join(state, 'late'), 'new home data');
    await expect(copyBack.copyHome(run())).rejects.toMatchObject({
      code: 'DOCKER_COPY_BACK_CHOICE_REQUIRED',
    });
    expect(home.volumes.size).toBe(0);
    expect(vm.containers.get('vm-only')!.State.Running).toBe(true);
    expect(inventory.size).toBe(0);
    expect(await copyBack.partialGroups(OPERATION)).toEqual([]);
  });

  it.each(['volume', 'holder'] as const)(
    'refuses a foreign home %s before stopping writers or restoring data',
    async (resource) => {
      vmOnly();
      if (resource === 'volume') {
        home.volumes.set('app_db', { driver: 'local', labels: { [OWNER]: 'other' } });
        home.data.set('app_db', Buffer.from('foreign-home'));
      } else {
        await writeFile(join(state, 'foreign'), 'foreign-home');
        home.data.set(state, Buffer.from('foreign-home'));
        home.addContainer({
          Id: 'foreign-home',
          Name: '/foreign-home',
          Image: 'sha256:db',
          Created: BEFORE,
          startedAt: BEFORE,
          Config: { Image: 'postgres:17', Labels: { [OWNER]: 'other' } },
          HostConfig: {},
          Mounts: [bindMount()],
          running: true,
        });
      }
      details.dockerCopyBack = { choices: { [key()]: 'copy-home' } };
      await expect(copyBack.copyHome(run())).rejects.toMatchObject({
        code: 'DOCKER_COPY_BACK_FAILED',
        message: expect.stringContaining(
          resource === 'volume' ? 'belongs to another project' : 'foreign-home',
        ),
      });
      expect(text(home, resource === 'volume' ? 'app_db' : state)).toBe('foreign-home');
      if (resource === 'holder')
        expect(home.containers.get('foreign-home')!.State.Running).toBe(true);
      expect(vm.containers.get('vm-only')!.State.Running).toBe(true);
      expect(inventory.size).toBe(0);
      expect(home.calls.some((call) => /\/(?:stop|archive)$/.test(call))).toBe(false);
      expect(await copyBack.partialGroups(OPERATION)).toEqual([]);
    },
  );

  it('keeps existing home data and creates a discard-only inventory', async () => {
    vmOnly();
    home.volumes.set('app_db', { driver: 'local', labels: {} });
    home.data.set('app_db', Buffer.from('keep-home'));
    details.dockerCopyBack = { choices: { [key()]: 'keep-home' } };
    await copyBack.copyHome(run());
    expect(text(home, 'app_db')).toBe('keep-home');
    expect(vm.containers.get('vm-only')!.State.Running).toBe(false);
    expect(inventory.get(`${PROJECT}/${REMOTE}`)).toMatchObject({
      items: [],
      groups: [{ volumes: ['app_db'], bindPaths: [state], vmDiscardedAt: expect.any(String) }],
    });
    expect(result().kept).toEqual(['vm-only']);
  });

  it('preserves the saved choice across failed pull and restart, then restores with the pulled home ID', async () => {
    vmOnly();
    home.images.clear();
    home.volumes.set('app_db', { driver: 'local', labels: {} });
    home.data.set('app_db', Buffer.from('home-before-pull'));
    details.dockerCopyBack = { choices: { [key()]: 'copy-home' } };
    home.intercept = (method, path, res) => {
      if (method !== 'POST' || path !== '/images/create') return false;
      res.end('{"status":"pulling"}\n{"errorDetail":{"message":"offline"}}\n');
      return true;
    };
    await expect(copyBack.copyHome(run())).rejects.toMatchObject({
      code: 'DOCKER_COPY_BACK_FAILED',
      message: expect.stringContaining('missing on this PC'),
    });
    expect(text(home, 'app_db')).toBe('home-before-pull');
    expect(vm.containers.get('vm-only')!.State.Running).toBe(true);
    const saved = await store.readCopyBack(OPERATION);
    expect(saved!.groups[0]).toMatchObject({
      action: 'copy-home',
      imageReferences: ['postgres:17'],
    });
    details.dockerCopyBack = { choices: { [key()]: 'keep-home' } };
    home.intercept = (method, path, res) => {
      if (method !== 'POST' || path !== '/images/create') return false;
      home.images.set('sha256:pulled', { architecture: 'amd64', tags: ['postgres:17'], size: 80 });
      res.end('{"status":"done"}\n');
      return true;
    };
    copyBack = makeCopyBack();
    await copyBack.copyHome(run());
    expect(text(home, 'app_db')).toBe('vm-db-rows');
    expect(result().copied).toEqual(['vm-only']);
    expect((await store.readCopyBack(OPERATION))!.groups).toEqual(saved!.groups);
    expect(home.calls.filter((call) => call === 'POST /images/create')).toHaveLength(2);
  });

  it('names an unconfirmed bind and leaves its entire group uncopied and unstamped', async () => {
    vmOnly();
    exclusions.preview.mockResolvedValue([]);
    const sync = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(sync.groups[0]).toMatchObject({ syncedByFileSync: [state], needsChoice: false });
    await copyBack.copyHome(run());
    expect(home.volumes.size).toBe(0);
    expect(text(home, state)).toBeUndefined();
    expect(inventory.size).toBe(0);
    expect(details.dockerCopyBackSkipped).toEqual([
      { path: state, reason: 'still synced by file sync' },
    ]);
    expect(result().skipped).toEqual(['vm-only']);
  });

  it('excludes wholly unlabelled and foreign volumes, external data and writable layers', async () => {
    vmOnly();
    vm.volumes.get('app_db')!.labels = {};
    vm.volumes.set('foreign', { driver: 'local', labels: { [OWNER]: 'other', [COMPOSE]: 'app' } });
    vm.containers.get('vm-only')!.Mounts = [
      volumeMount('app_db', '/data'),
      volumeMount('foreign', '/foreign'),
      { Type: 'bind', Source: scratch, Destination: '/outside', RW: true },
    ];
    expect(await copyBack.syncState(PROJECT, { remoteId: REMOTE })).toMatchObject({
      availability: { reason: { code: 'not-imported' } },
      groups: [],
    });
    await copyBack.copyHome(run());
    expect(home.volumes.size).toBe(0);
    expect(home.data.size).toBe(0);
    expect(inventory.size).toBe(0);
    expect(result().copied).toEqual([]);
  });

  it('stops a plain docker run bind holder before reading its archive', async () => {
    vmOnly();
    vm.containers.get('vm-only')!.Mounts = [bindMount()];
    vm.containers.get('vm-only')!.Config.Labels = {};
    await copyBack.copyHome(run());
    expect(vm.containers.get('vm-only')!.State.Running).toBe(false);
    expect(text(home, state)).toBe('vm-state');
    const stopped = vm.calls.indexOf('POST /containers/vm-only/stop');
    const read = vm.calls.findIndex(
      (call) => call.startsWith('GET /containers/') && call.endsWith('/archive'),
    );
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(stopped);
  });
});

it.each(['initial decision', 'stored retry'])(
  'copies exact data with known differing ids on %s',
  async (attempt) => {
    jest.spyOn(client, 'remoteRuntime').mockResolvedValue({
      ...(await client.remoteRuntime(REMOTE)),
      uid: (source.uid() ?? 1000) + 1,
    });
    const preview = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(preview.availability.available).toBe(true);
    expect(preview.groups).toContainEqual(
      expect.objectContaining({ key: DB_GROUP(), state: 'vm-newer' }),
    );
    if (attempt === 'stored retry')
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
            images: ['sha256:db'],
            sizeBytes: 12,
          },
        ],
      });
    await copyBack.copyHome(run());
    expect(text(home, 'app_db')).toBe('vm-db-rows');
    expect(result().copied).toContain('app-db-1');
  },
);

it.each(['items', 'groups'] as const)(
  'copies exact data but holds recorded follows-user %s with a reason',
  async (form) => {
    await differentIds();
    const imported = inventory.get(`${PROJECT}/${REMOTE}`)!;
    const ownership = {
      class: 'follows-user' as const,
      home: { uid: 1000, gid: 1000 },
      vm: { uid: 1001, gid: 1002 },
      targetUser: '1001:1002',
    };
    if (form === 'items')
      imported.items.find((item) => item.name === 'runner')!.ownership = ownership;
    else imported.groups!.find((group) => group.bindPaths.includes(state))!.ownership = ownership;
    const synced = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(synced.groups.find((group) => group.key === STATE_GROUP())).toMatchObject({
      needsChoice: false,
      skipReason: expect.stringContaining('stays on the VM'),
    });
    details.dockerCopyBack = { choices: { [STATE_GROUP()]: 'copy-home' } };
    await copyBack.copyHome(run());
    expect(text(home, 'app_db')).toBe('vm-db-rows');
    expect(text(home, state)).toBe('home-state');
    expect(result().skipped).toContain('runner');
    expect(details.dockerOwnershipSkipped).toEqual([
      expect.objectContaining({
        label: 'runner',
        reason: expect.stringContaining('stays on the VM'),
      }),
    ]);
  },
);

it('copies VM-created Compose follows-user data discovered with paired home and V environments', async () => {
  await differentIds();
  vm.volumes.set('app_new', {
    labels: { [COMPOSE]: 'app', 'com.docker.compose.volume': 'new' },
    driver: 'local',
  });
  vm.data.set('app_new', ownerArchive());
  vm.addContainer({
    Id: 'new',
    Name: '/app-new-1',
    Image: 'sha256:web',
    Config: {
      User: '1001:1002',
      Labels: {
        [COMPOSE]: 'app',
        'com.docker.compose.service': 'new',
        'com.docker.compose.project.working_dir': root,
      },
    },
    HostConfig: {},
    Mounts: [
      {
        Type: 'volume',
        Name: 'app_new',
        Source: '/docker/app_new',
        Destination: '/data',
        RW: true,
      },
    ],
  });
  jest.mocked(source.compose).mockImplementation(async (_directory, options) => ({
    name: 'app',
    services: {
      new: {
        image: 'app-web:latest',
        user: `${options?.env?.DEVCHAIN_UID ?? '1000'}:${options?.env?.DEVCHAIN_GID ?? '1000'}`,
      },
    },
  }));
  const synced = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
  expect(synced.groups.find((group) => group.volumes.includes('app_new'))).toMatchObject({
    createdOnVm: true,
    needsChoice: false,
    state: 'vm-newer',
  });
  expect(
    synced.groups.find((group) => group.volumes.includes('app_new'))!.skipReason,
  ).toBeUndefined();
  await copyBack.copyHome(run());
  expect(archiveEntries(home.data.get('app_new')!)).toEqual(
    archiveEntries(ownerArchive(1000, 1000)),
  );
  expect(result().copied).toContain('app-new-1');
  expect(records()).toContainEqual(
    expect.objectContaining({
      volumes: ['app_new'],
      representation: {
        kind: 'mapped',
        home: { uid: 1000, gid: 1000 },
        vm: { uid: 1001, gid: 1002 },
      },
      lastSyncDirection: 'to-home',
    }),
  );
});

it('resumed copy-back records still hold follows-user data even if an old saved action says copy', async () => {
  const imported = inventory.get(`${PROJECT}/${REMOTE}`)!;
  imported.items.find((item) => item.name === 'runner')!.ownership = {
    class: 'follows-user',
    home: { uid: 1000, gid: 1000 },
    vm: { uid: 1001, gid: 1002 },
    targetUser: '1001:1002',
  };
  await copyBack.prepareHomeCopy(run());
  const record = (await store.readCopyBack(OPERATION))!;
  const group = record.groups.find((group) => group.key === STATE_GROUP())!;
  delete group.ownership;
  delete group.skipReason;
  group.action = 'copy-home';
  await store.writeCopyBack(OPERATION, record);
  await copyBack.copyHome(run());
  expect(text(home, state)).toBe('home-state');
  expect(result().skipped).toContain('runner');
});

// Real copy-back and HTTP trailers are the smallest seam proving hash order, accepted checkpoints and inventory stamps.
describe('mapped copy-back representations', () => {
  async function ids(uid = 1001, gid = 1002) {
    await differentIds({ uid, gid });
    return { home: { uid: 1000, gid: 1000 }, vm: { uid, gid } };
  }
  async function mapped(uid = 1001, gid = 1002) {
    const context = await ids(uid, gid);
    const imported = inventory.get(`${PROJECT}/${REMOTE}`)!;
    for (const group of imported.groups!) {
      group.representation = { kind: 'mapped', ...context };
      group.ownership = { class: 'follows-user', ...context };
    }
    for (const item of imported.items) {
      item.ownership = { class: 'follows-user', ...context };
      item.dataRepresentations = [
        {
          volumes: item.volumes.map((volume) => volume.name),
          bindPaths: item.bindPaths.map((path) => join(root, path)),
          representation: { kind: 'mapped', ...context },
        },
      ];
    }
    for (const name of ['app_db', state]) vm.data.set(name, ownerArchive(uid, gid));
    for (const container of vm.containers.values()) container.Config.User ??= '';
    return context;
  }

  it('refuses a new exact VM holder of imported mapped data at preview and saved retry', async () => {
    const context = await mapped();
    await copyBack.prepareHomeCopy(run());
    const homeData = home.data.get('app_db');
    const baseline = structuredClone(records().find((group) => group.volumes.includes('app_db')));
    vm.addContainer({
      Id: 'new-exact',
      Name: '/exact-holder',
      Image: 'sha256:web',
      Config: { User: '1001', Labels: {} },
      HostConfig: {},
      Mounts: [volumeMount('app_db', '/data')],
    });
    inventory
      .get(`${PROJECT}/${REMOTE}`)!
      .items.find((item) => item.name === 'runner')!.ownership!.targetUser = '1001:1002';
    vm.containers.get('vm-runner')!.Config.User = 'named';
    const sync = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    const group = sync.groups.find((entry) => entry.volumes.includes('app_db'))!;
    expect(group.skipReason).toContain('exact-holder');
    expect(sync.groups.find((entry) => entry.bindPaths.includes(state))!.skipReason).toContain(
      'runner',
    );
    expect(group.dataRepresentations).toEqual([
      { volumes: ['app_db'], bindPaths: [], representation: { kind: 'mapped', ...context } },
    ]);
    await expect(makeCopyBack().copyHome(run())).rejects.toMatchObject({
      message: expect.stringContaining('exact-holder'),
    });
    expect(home.data.get('app_db')).toEqual(homeData);
    expect(vm.containers.get('vm-db')!.State.Running).toBe(true);
    expect((await store.readCopyBack(OPERATION))!.verified).toEqual({});
    expect(records().find((group) => group.volumes.includes('app_db'))).toEqual(baseline);
    expect(details.dockerCopyBackResult).toBeUndefined();

    await store.remove(OPERATION);
    details.dockerCopyBack = { choices: { [DB_GROUP()]: 'copy-home' } };
    await copyBack.copyHome(run());
    expect(result().skipped).toContain('app-db-1');
    expect(result().alreadyTargetEntries).toBe(0);
    expect(home.data.get('app_db')).toEqual(homeData);
    expect(vm.data.get('app_db')).toEqual(ownerArchive());
    expect(records().find((group) => group.volumes.includes('app_db'))).toEqual(baseline);
    vm.containers.get('vm-runner')!.Config.User = '1001:1002';
    const compatible = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(
      compatible.groups.find((entry) => entry.bindPaths.includes(state))!.skipReason,
    ).toBeUndefined();
  });

  it('maps and rechecks new VM resources added to an imported follower without changing recorded data', async () => {
    const context = await mapped();
    const folder = join(root, 'new-data');
    await mkdir(folder, { recursive: true });
    const imported = inventory.get(`${PROJECT}/${REMOTE}`)!;
    imported.groups!.find((group) => group.bindPaths.includes(state))!.representation = {
      kind: 'exact',
      ...context,
    };
    home.containers.get('db-id')!.Mounts.push(bindMount());
    home.containers.delete('runner-id');
    vm.containers.delete('vm-runner');
    home.containers.get('db-id')!.Mounts.push({
      Type: 'bind',
      Source: folder,
      Destination: '/new-data',
      RW: true,
    });
    const db = vm.containers.get('vm-db')!;
    db.Config.User = '1001:1002';
    db.Mounts.push(volumeMount('app_new', '/new'), bindMount(), {
      Type: 'bind',
      Source: folder,
      Destination: '/new-data',
      RW: true,
    });
    vm.volumes.set('app_new', { labels: { [COMPOSE]: 'app' }, driver: 'local' });
    vm.data.set('app_new', ownerArchive());
    vm.data.set(folder, ownerArchive());
    vm.volumes.set('app_exact', { labels: { [COMPOSE]: 'app' }, driver: 'local' });
    vm.data.set('app_exact', ownerArchive());
    vm.addContainer({
      Id: 'vm-root',
      Name: '/app-root-1',
      Image: 'sha256:db',
      Config: {
        User: '',
        Labels: { [COMPOSE]: 'app', 'com.docker.compose.service': 'root' },
      },
      HostConfig: {},
      Mounts: [volumeMount('app_db', '/db'), volumeMount('app_exact', '/exact')],
    });
    let rootFollows = false;
    let unreadable = false;
    jest.mocked(source.compose).mockImplementation(async (_directory, options) => {
      if (unreadable) throw new Error('Compose cannot be read');
      const user = `${options?.env?.DEVCHAIN_UID ?? '1000'}:${options?.env?.DEVCHAIN_GID ?? '1000'}`;
      return {
        name: 'app',
        services: {
          db: {
            image: 'postgres:17',
            user,
            volumes: [
              { type: 'volume', source: 'db', target: '/db' },
              { type: 'volume', source: 'new', target: '/new' },
              { type: 'bind', source: folder, target: '/new-data' },
            ],
          },
          root: { image: 'postgres:17', user: rootFollows ? user : '' },
        },
        volumes: { db: { name: 'app_db' }, new: { name: 'app_new' } },
      };
    });

    // An imported member with a missing snapshot remains unknown even beside mapped data.
    imported.groups!.push({
      volumes: ['app_new'],
      bindPaths: [],
      ownership: { class: 'follows-user', ...context },
    });
    const unknown = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(unknown.groups.find((group) => group.volumes.includes('app_new'))!.skipReason).toContain(
      'representation is unknown',
    );
    imported.groups!.pop();
    const sync = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    const group = sync.groups.find((entry) => entry.volumes.includes('app_new'))!;
    expect(group.skipReason).toBeUndefined();
    expect(group.dataRepresentations).toEqual(
      expect.arrayContaining([
        { volumes: ['app_new'], bindPaths: [], representation: { kind: 'mapped', ...context } },
        { volumes: ['app_exact'], bindPaths: [], representation: { kind: 'exact', ...context } },
      ]),
    );
    expect(JSON.stringify(group)).not.toContain('createdOnVm');
    details.dockerCopyBack = {
      choices: Object.fromEntries(sync.groups.map((group) => [group.key, 'copy-home'])),
    };
    await copyBack.prepareHomeCopy(run());
    const saved = (await store.readCopyBack(OPERATION))!;
    const savedGroup = saved.groups.find((entry) => entry.volumes.includes('app_new'))!;
    expect(savedGroup.dataRepresentations!.filter((part) => part.createdOnVm)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          volumes: ['app_new'],
          representation: { kind: 'mapped', ...context },
        }),
        expect.objectContaining({
          volumes: ['app_exact'],
          representation: { kind: 'exact', ...context },
        }),
        expect.objectContaining({
          bindPaths: [folder],
          representation: { kind: 'mapped', ...context },
        }),
      ]),
    );
    expect(
      savedGroup.dataRepresentations!.find((part) => part.volumes.includes('app_db'))!.createdOnVm,
    ).toBeUndefined();
    expect(
      savedGroup.dataRepresentations!.find((part) => part.bindPaths.includes(state))!.createdOnVm,
    ).toBeUndefined();
    expect(exclusions.prepare).toHaveBeenCalledWith(
      PROJECT,
      REMOTE,
      root,
      expect.arrayContaining([folder]),
      expect.any(AbortSignal),
    );
    const baseline = structuredClone(records());
    const unchanged = async (running = true) => {
      expect(home.data.get('app_db')!.toString()).toBe('home-db-rows');
      expect(home.data.has('app_new')).toBe(false);
      expect(home.data.has('app_exact')).toBe(false);
      expect(db.State.Running).toBe(running);
      const current = (await store.readCopyBack(OPERATION))!;
      expect(current.started).toEqual([]);
      expect(current.verified).toEqual({});
      expect(records()).toEqual(baseline);
      expect(details.dockerCopyBackResult).toBeUndefined();
    };

    // Restart rechecks newly derived exact decisions as well as mapped ones.
    rootFollows = true;
    vm.containers.get('vm-root')!.Config.User = '1001:1002';
    await expect(makeCopyBack().copyHome(run())).rejects.toMatchObject({
      message: expect.stringContaining(
        'app_exact: The current VM consumers require a different owner representation',
      ),
    });
    await unchanged();
    rootFollows = false;
    vm.containers.get('vm-root')!.Config.User = '';

    const addHolder = () =>
      vm.addContainer({
        Id: 'new-holder',
        Name: '/new-volume-holder',
        Image: 'sha256:web',
        Config: { User: '1001', Labels: {} },
        HostConfig: {},
        Mounts: [volumeMount('app_new', '/data')],
      });
    addHolder();
    const conflicted = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(
      conflicted.groups.find((entry) => entry.volumes.includes('app_new'))!.skipReason,
    ).toContain('new-volume-holder');
    await expect(makeCopyBack().copyHome(run())).rejects.toMatchObject({
      message: expect.stringContaining('new-volume-holder'),
    });
    await unchanged();
    vm.containers.delete('new-holder');

    unreadable = true;
    await expect(makeCopyBack().copyHome(run())).rejects.toMatchObject({
      message: expect.stringContaining('Cannot resolve the VM Compose data ownership'),
    });
    await unchanged();
    unreadable = false;

    // A new stopped holder after the stop is still refused before clearing home data.
    vm.intercept = (method, path) => {
      if (method === 'POST' && path === '/containers/vm-db/stop') addHolder();
      return false;
    };
    await expect(makeCopyBack().copyHome(run())).rejects.toMatchObject({
      message: expect.stringContaining('new-volume-holder'),
    });
    await unchanged(false);
    vm.intercept = undefined;
    vm.containers.delete('new-holder');
    await makeCopyBack().copyHome(run());
    for (const name of ['app_db', 'app_new', folder]) {
      expect(archiveEntries(home.data.get(name)!)).toEqual(
        archiveEntries(ownerArchive(1000, 1000)),
      );
      expect(vm.data.get(name)).toEqual(ownerArchive());
    }
    expect(home.data.get(state)).toEqual(ownerArchive());
    expect(home.data.get('app_exact')).toEqual(ownerArchive());
    expect(vm.data.get('app_exact')).toEqual(ownerArchive());
    expect(records()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          volumes: ['app_db'],
          representation: { kind: 'mapped', ...context },
        }),
        expect.objectContaining({
          volumes: ['app_new'],
          representation: { kind: 'mapped', ...context },
        }),
        expect.objectContaining({
          bindPaths: [folder],
          representation: { kind: 'mapped', ...context },
        }),
        expect.objectContaining({
          bindPaths: [state],
          representation: { kind: 'exact', ...context },
        }),
        expect.objectContaining({
          volumes: ['app_exact'],
          representation: { kind: 'exact', ...context },
        }),
      ]),
    );
    expect(JSON.stringify(records())).not.toContain('createdOnVm');
    expect(result().alreadyTargetEntries).toBe(6);
    await makeCopyBack().copyHome(run());
    expect(result().alreadyTargetEntries).toBe(6);
  });

  // The real endpoint and service expose representation snapshots to the dialog; serialization is part of the contract.
  it.each(['mapped', 'exact', 'mixed', 'unknown'] as const)(
    'returns minimal safe %s snapshots through the production sync-state API',
    async (kind) => {
      const context = await mapped();
      const imported = inventory.get(`${PROJECT}/${REMOTE}`)!;
      if (kind === 'exact')
        for (const group of imported.groups!) group.representation = { kind: 'exact', ...context };
      if (kind === 'mixed') {
        imported.groups!.find((group) => group.bindPaths.includes(state))!.representation = {
          kind: 'exact',
          ...context,
        };
        home.containers.get('db-id')!.Mounts.push(bindMount());
        vm.containers.get('vm-db')!.Mounts.push(bindMount());
        home.containers.delete('runner-id');
        vm.containers.delete('vm-runner');
      }
      if (kind === 'unknown') {
        for (const group of imported.groups!) delete group.representation;
        for (const item of imported.items) delete item.dataRepresentations;
      }
      home.containers.get('db-id')!.Config.Env = ['PRIVATE_TOKEN=copy-back-private'];
      for (const group of imported.groups!) group.ownership!.targetUser = '1001:1002';
      const module = await Test.createTestingModule({
        controllers: [DockerPlanController],
        providers: [
          { provide: DockerPlanService, useValue: plans },
          { provide: DockerCopyBack, useValue: copyBack },
        ],
      }).compile();
      const api = module.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter({ logger: false }),
      );
      api.useGlobalFilters(new AllExceptionsFilter());
      try {
        await api.init();
        const response = await api.inject({
          method: 'POST',
          url: `/api/projects/${PROJECT}/docker/sync-state`,
          payload: { remoteId: REMOTE },
        });
        expect(response.statusCode).toBe(200);
        const synced = response.json<DockerSyncState>();
        expect(synced.groups).toHaveLength(kind === 'mixed' ? 1 : 2);
        const snapshots = synced.groups.flatMap((group) => group.dataRepresentations!);
        expect(snapshots).toEqual(
          expect.arrayContaining([
            {
              volumes: ['app_db'],
              bindPaths: [],
              ...(kind === 'unknown'
                ? {}
                : { representation: { kind: kind === 'exact' ? 'exact' : 'mapped', ...context } }),
            },
            {
              volumes: [],
              bindPaths: [state],
              ...(kind === 'unknown'
                ? {}
                : {
                    representation: {
                      kind: kind === 'exact' || kind === 'mixed' ? 'exact' : 'mapped',
                      ...context,
                    },
                  }),
            },
          ]),
        );
        expect(snapshots).toHaveLength(2);
        for (const group of synced.groups) {
          expect(group.needsChoice).toBe(false);
          expect(group.state).toBe('vm-newer');
          if (kind === 'unknown') expect(group.skipReason).toContain('representation is unknown');
          else expect(group.skipReason).toBeUndefined();
        }
        expect(response.body).not.toContain('copy-back-private');
        expect(response.body).not.toContain('targetUser');
        expect(response.body).not.toContain('ownership');
        expect(response.body).not.toContain('compose.yaml');
        expect([...home.calls, ...vm.calls].some((call) => /^(POST|PUT|DELETE) /.test(call))).toBe(
          false,
        );
      } finally {
        await api.close();
      }
    },
  );

  it.each([
    { uid: 1001, gid: 1002, count: 4 },
    { uid: 1001, gid: 1000, count: 4 },
    { uid: 1000, gid: 1002, count: 2 },
    { uid: 1000, gid: 1000, count: 0 },
  ])(
    'restores mapped volume/bind owners and modes for V=$uid:$gid, counting once',
    async ({ uid, gid, count }) => {
      const context = await mapped(uid, gid);
      const raw = ownerArchive(uid, gid);
      const synced = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
      expect(synced.groups.every((group) => !group.skipReason)).toBe(true);
      await copyBack.prepareHomeCopy(run());
      await makeCopyBack().copyHome(run());
      for (const name of ['app_db', state]) {
        expect(archiveEntries(home.data.get(name)!)).toEqual(
          archiveEntries(ownerArchive(1000, 1000)),
        );
        expect(vm.data.get(name)).toEqual(raw);
      }
      expect(result().alreadyTargetEntries).toBe(count);
      expect(records().map((group) => group.representation)).toEqual([
        { kind: 'mapped', ...context },
        { kind: 'mapped', ...context },
      ]);
      for (const item of inventory.get(`${PROJECT}/${REMOTE}`)!.items)
        expect(item.dataRepresentations).toEqual([
          {
            volumes: item.volumes.map((volume) => volume.name),
            bindPaths: item.bindPaths.map((path) => join(root, path)),
            representation: { kind: 'mapped', ...context },
          },
        ]);
      const reads = vm.calls.filter((call) => call.endsWith('/archive')).length;
      await makeCopyBack().copyHome(run());
      expect(vm.calls.filter((call) => call.endsWith('/archive'))).toHaveLength(reads);
      expect(result().alreadyTargetEntries).toBe(count);
    },
  );

  it('uses actual item resource snapshots when group records are absent, after an explicit change choice', async () => {
    const context = await mapped();
    delete inventory.get(`${PROJECT}/${REMOTE}`)!.groups;
    const synced = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(synced.groups.every((group) => group.needsChoice && !group.skipReason)).toBe(true);
    details.dockerCopyBack = {
      choices: { [DB_GROUP()]: 'copy-home', [STATE_GROUP()]: 'copy-home' },
    };
    await copyBack.copyHome(run());
    expect(result().alreadyTargetEntries).toBe(4);
    expect(archiveEntries(home.data.get('app_db')!)).toEqual(
      archiveEntries(ownerArchive(1000, 1000)),
    );
    expect(records().every((group) => group.representation?.kind === 'mapped')).toBe(true);
    expect(
      inventory.get(`${PROJECT}/${REMOTE}`)!.items[0].dataRepresentations![0].representation,
    ).toEqual({ kind: 'mapped', ...context });
  });

  it('keeps recorded exact data raw beside mapped data under one aggregate choice', async () => {
    const context = await mapped();
    const imported = inventory.get(`${PROJECT}/${REMOTE}`)!;
    const exact = imported.groups!.find((group) => group.bindPaths.includes(state))!;
    exact.representation = { kind: 'exact', ...context };
    // Changed classification must not override the actual exact data snapshot.
    exact.ownership = { class: 'follows-user', ...context };
    home.containers.get('db-id')!.Mounts.push(bindMount());
    vm.containers.get('vm-db')!.Mounts.push(bindMount());
    home.containers.delete('runner-id');
    vm.containers.delete('vm-runner');
    home.images.get('sha256:db')!.metadata = { Config: { User: '' } };
    home.containers.get('db-id')!.Config.User = '1000:1000';
    home.containers.get('db-id')!.Config.Labels = {};
    vm.containers.get('vm-db')!.Config.User = '1001:1002';
    const changed = await plans.plan(PROJECT, { remoteId: REMOTE }, undefined, { estimate: false });
    expect(changed.items.find((item) => item.id === 'db-id')!.ownership!.class).toBe(
      'follows-user',
    );
    const synced = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(synced.groups).toHaveLength(1);
    expect(synced.groups[0]).toMatchObject({
      volumes: ['app_db'],
      bindPaths: [state],
      state: 'vm-newer',
    });
    await copyBack.copyHome(run());
    expect(archiveEntries(home.data.get('app_db')!)).toEqual(
      archiveEntries(ownerArchive(1000, 1000)),
    );
    expect(home.data.get(state)).toEqual(ownerArchive());
    expect(result().alreadyTargetEntries).toBe(2);
    expect(records()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          volumes: ['app_db'],
          representation: { kind: 'mapped', ...context },
        }),
        expect.objectContaining({
          bindPaths: [state],
          representation: { kind: 'exact', ...context },
        }),
      ]),
    );
    expect(inventory.get(`${PROJECT}/${REMOTE}`)!.items[0].dataRepresentations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          volumes: ['app_db'],
          representation: { kind: 'mapped', ...context },
        }),
      ]),
    );
  });

  it.each(['raw-trailer', 'home-destination', 'invalid-archive'] as const)(
    'accepts no mapped checkpoint/count on %s failure, then retries from untouched VM',
    async (failure) => {
      const context = await mapped();
      const read = client.dockerReadArchive.bind(client);
      if (failure === 'raw-trailer')
        jest.spyOn(client, 'dockerReadArchive').mockImplementation(async (...args) => {
          const answer = await read(...args);
          return args[1].source === 'app_db' ? { ...answer, sha256: () => 'f'.repeat(64) } : answer;
        });
      else if (failure === 'invalid-archive') vm.data.set('app_db', Buffer.from('invalid tar'));
      else
        home.intercept = (method, path, response) => {
          if (method !== 'PUT' || !path.endsWith('/archive')) return false;
          const helper = home.containers.get(path.split('/')[2]);
          const mounts = helper?.HostConfig.Mounts as Array<{ Source: string }> | undefined;
          if (!mounts?.some((mount) => mount.Source === 'app_db')) return false;
          response.statusCode = 500;
          response.end(JSON.stringify({ message: 'restore failed' }));
          return true;
        };
      const raw = vm.data.get('app_db');
      await expect(copyBack.copyHome(run())).rejects.toMatchObject({
        code: 'DOCKER_COPY_BACK_FAILED',
      });
      const failed = (await store.readCopyBack(OPERATION))!;
      expect(failed.verified[DB_GROUP()]).toBeUndefined();
      expect(failed.verified[STATE_GROUP()].alreadyTargetEntries).toBe(2);
      expect(records().find((group) => group.volumes.includes('app_db'))).toMatchObject({
        lastSyncedAt: SYNCED,
        lastSyncDirection: 'to-vm',
        representation: { kind: 'mapped', ...context },
      });
      expect(details.dockerCopyBackResult).toBeUndefined();
      expect(vm.data.get('app_db')).toEqual(raw);
      home.intercept = undefined;
      if (failure === 'raw-trailer') jest.mocked(client.dockerReadArchive).mockRestore();
      if (failure === 'invalid-archive') vm.data.set('app_db', ownerArchive());
      const writes = home.calls.filter(
        (call) => call.startsWith('PUT ') && call.endsWith('/archive'),
      ).length;
      await makeCopyBack().copyHome(run());
      expect(
        home.calls.filter((call) => call.startsWith('PUT ') && call.endsWith('/archive')),
      ).toHaveLength(writes + 1);
      expect(archiveEntries(home.data.get('app_db')!)).toEqual(
        archiveEntries(ownerArchive(1000, 1000)),
      );
      expect(vm.data.get('app_db')).toEqual(ownerArchive());
      expect(result().alreadyTargetEntries).toBe(4);
      expect(await copyBack.partialGroups(OPERATION)).toEqual([]);
    },
  );

  it('carries mapped copy-back baselines and item snapshots into an in-sync next Connect', async () => {
    const context = await mapped();
    for (const [engine, id] of [
      [home, 'db-id'],
      [vm, 'vm-db'],
    ] as const) {
      const container = engine.containers.get(id)!;
      container.Config.Labels = {
        [COMPOSE]: 'app',
        'com.docker.compose.service': 'db',
        'com.docker.compose.project.working_dir': root,
        'com.docker.compose.project.config_files': join(root, 'compose.yaml'),
      };
      container.Config.User = engine === home ? '1000:1000' : '1001:1002';
    }
    jest.mocked(source.compose).mockImplementation(async (_directory, options) => ({
      name: 'app',
      services: {
        db: {
          image: 'postgres:17',
          user: `${options?.env?.DEVCHAIN_UID ?? '1000'}:${options?.env?.DEVCHAIN_GID ?? '1000'}`,
          volumes: [{ type: 'volume', source: 'db', target: '/data' }],
        },
      },
      volumes: { db: { name: 'app_db' } },
    }));
    await copyBack.copyHome(run());
    const plan = await plans.plan(PROJECT, { remoteId: REMOTE }, undefined, { estimate: false });
    expect(plan.dataGroups!.find((group) => group.volumes.includes('app_db'))!.state).toBe(
      'in-sync',
    );
    expect(plan.items.find((item) => item.name === 'app-db-1')).toMatchObject({
      dataState: 'in-sync',
      dataAction: 'keep-vm',
      ownership: { class: 'follows-user', ...context },
    });
    expect(
      inventory.get(`${PROJECT}/${REMOTE}`)!.items[0].dataRepresentations![0].representation,
    ).toEqual({ kind: 'mapped', ...context });
  });

  it('preserves actual mapped representations when keeping home data through resume', async () => {
    const context = await mapped();
    home.containers.get('db-id')!.State.StartedAt = AFTER;
    details.dockerCopyBack = { choices: { [DB_GROUP()]: 'keep-home' } };
    await copyBack.copyHome(run());
    expect(home.data.get('app_db')).toEqual(Buffer.from('home-db-rows'));
    expect(
      records()
        .filter((group) => group.volumes.includes('app_db'))
        .map((group) => group.representation),
    ).toEqual([
      { kind: 'mapped', ...context },
      { kind: 'mapped', ...context },
    ]);
    expect(result().alreadyTargetEntries).toBe(2);
    await makeCopyBack().copyHome(run());
    expect(
      records()
        .filter((group) => group.volumes.includes('app_db'))
        .map((group) => group.representation),
    ).toEqual([
      { kind: 'mapped', ...context },
      { kind: 'mapped', ...context },
    ]);
    expect(result().alreadyTargetEntries).toBe(2);
  });

  it('keeps a legacy accepted copy representation unknown when re-stamping after resume', async () => {
    await mapped();
    await copyBack.prepareHomeCopy(run());
    const record = (await store.readCopyBack(OPERATION))!;
    record.verified[DB_GROUP()] = {
      volumes: ['app_db'],
      bindPaths: [],
      at: new Date().toISOString(),
    };
    await store.writeCopyBack(OPERATION, record);
    await makeCopyBack().copyHome(run());
    expect(
      records().find((group) => group.volumes.includes('app_db'))!.representation,
    ).toBeUndefined();
    expect(
      inventory.get(`${PROJECT}/${REMOTE}`)!.items[0].dataRepresentations![0].representation,
    ).toBeUndefined();
    expect(result().alreadyTargetEntries).toBe(2);
  });
});

// The discovery endpoint and actual copy share this resolution path; fake engines preserve every mounted holder.
describe('VM-created follows-user copy-back', () => {
  async function created() {
    await differentIds();
    inventory.clear();
    home.containers.clear();
    vm.containers.clear();
    home.volumes.clear();
    const folder = join(root, 'vm-only');
    await mkdir(folder, { recursive: true });
    vm.volumes.set('app_new', { labels: { [COMPOSE]: 'app' }, driver: 'local' });
    vm.data.set('app_new', ownerArchive());
    vm.data.set(folder, ownerArchive());
    vm.addContainer({
      Id: 'new',
      Name: '/app-new-1',
      Image: 'sha256:web',
      Config: {
        User: '1001:1002',
        Labels: {
          [COMPOSE]: 'app',
          'com.docker.compose.service': 'new',
          'com.docker.compose.project.working_dir': root,
        },
      },
      HostConfig: {},
      Created: AFTER,
      startedAt: AFTER,
      Mounts: [
        volumeMount('app_new', '/data'),
        { Type: 'bind', Source: folder, Destination: '/state', RW: true },
      ],
    });
    jest.mocked(source.compose).mockImplementation(async (_directory, options) => ({
      name: 'app',
      services: {
        new: {
          image: 'app-web:latest',
          user: `${options?.env?.DEVCHAIN_UID ?? '1000'}:${options?.env?.DEVCHAIN_GID ?? '1000'}`,
          volumes: [
            { type: 'volume', source: 'new', target: '/data' },
            { type: 'bind', source: folder, target: '/state' },
          ],
        },
        numeric: { image: 'bitnami/example:latest' },
      },
      volumes: { new: { name: 'app_new' }, numeric: { name: 'app_numeric' } },
    }));
    return folder;
  }

  it('returns VM-created follower volume/bind data home and preserves image USER 1001 data exactly', async () => {
    const folder = await created();
    for (const engine of [home, vm])
      engine.images.set('sha256:numeric', {
        architecture: 'amd64',
        tags: ['bitnami/example:latest'],
        size: 50,
        metadata: { Config: { User: '1001' } },
      });
    vm.volumes.set('app_numeric', { labels: { [COMPOSE]: 'app' }, driver: 'local' });
    vm.data.set('app_numeric', ownerArchive());
    vm.addContainer({
      Id: 'numeric',
      Name: '/app-numeric-1',
      Image: 'sha256:numeric',
      Config: {
        User: '1001',
        Labels: {
          [COMPOSE]: 'app',
          'com.docker.compose.service': 'numeric',
          'com.docker.compose.project.working_dir': root,
        },
      },
      HostConfig: {},
      Created: AFTER,
      startedAt: AFTER,
      Mounts: [volumeMount('app_numeric', '/data')],
    });
    const sync = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
    expect(sync.groups.every((group) => !group.skipReason && group.createdOnVm)).toBe(true);
    await copyBack.copyHome(run());
    for (const name of ['app_new', folder])
      expect(archiveEntries(home.data.get(name)!)).toEqual(
        archiveEntries(ownerArchive(1000, 1000)),
      );
    expect(home.data.get('app_numeric')).toEqual(ownerArchive());
    expect(result().alreadyTargetEntries).toBe(4);
    expect(records()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          volumes: ['app_new'],
          bindPaths: [folder],
          representation: {
            kind: 'mapped',
            home: { uid: 1000, gid: 1000 },
            vm: { uid: 1001, gid: 1002 },
          },
        }),
        expect.objectContaining({
          volumes: ['app_numeric'],
          representation: {
            kind: 'exact',
            home: { uid: 1000, gid: 1000 },
            vm: { uid: 1001, gid: 1002 },
          },
        }),
      ]),
    );
    const plan = await plans.plan(PROJECT, { remoteId: REMOTE }, undefined, { estimate: false });
    expect(plan.dataGroups!.every((group) => group.state === 'in-sync')).toBe(true);
    expect(plan.items.find((item) => item.kind === 'compose-project')).toMatchObject({
      dataAction: 'keep-vm',
      dataState: 'in-sync',
    });
  });

  it.each([
    { user: '1000', allowed: false },
    { user: '1001', allowed: false },
    { user: 'named', allowed: false },
    { user: '0', allowed: true },
    { user: '999', allowed: true },
  ])(
    'checks a stopped unrelated actual mounted consumer uid=$user before mapping',
    async ({ user, allowed }) => {
      await created();
      vm.addContainer({
        Id: 'other',
        Name: '/retained-other',
        Image: 'sha256:web',
        Config: { User: user, Labels: {} },
        HostConfig: {},
        Mounts: [volumeMount('app_new', '/retained')],
      });
      const sync = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
      const group = sync.groups.find((entry) => entry.volumes.includes('app_new'))!;
      if (allowed) {
        expect(group.skipReason).toBeUndefined();
        await copyBack.copyHome(run());
        expect(archiveEntries(home.data.get('app_new')!)).toEqual(
          archiveEntries(ownerArchive(1000, 1000)),
        );
      } else {
        expect(group.skipReason).toContain('retained-other');
        details.dockerCopyBack = { choices: { [group.key]: 'copy-home' } };
        await copyBack.copyHome(run());
        expect(home.volumes.has('app_new')).toBe(false);
        expect(result().alreadyTargetEntries).toBe(0);
        expect(inventory.get(`${PROJECT}/${REMOTE}`)).toBeUndefined();
      }
      expect(vm.data.get('app_new')).toEqual(ownerArchive());
    },
  );

  it.each(['unreadable', 'missing-service'] as const)(
    'holds VM-created data when paired Compose ownership is %s',
    async (failure) => {
      await created();
      if (failure === 'unreadable')
        jest.mocked(source.compose).mockRejectedValue(new Error('private configuration'));
      else jest.mocked(source.compose).mockResolvedValue({ name: 'app', services: {} });
      const sync = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
      expect(sync.groups[0]).toMatchObject({
        needsChoice: false,
        skipReason: expect.stringContaining('Cannot resolve'),
      });
      expect(sync.groups[0].skipReason).not.toContain('private configuration');
      await copyBack.copyHome(run());
      expect(home.volumes.has('app_new')).toBe(false);
      expect(result().alreadyTargetEntries).toBe(0);
      expect(inventory.get(`${PROJECT}/${REMOTE}`)).toBeUndefined();
    },
  );

  it.each(['unreadable', 'new-holder'] as const)(
    'rechecks a saved VM-created mapped decision before copying when %s changes',
    async (change) => {
      await created();
      await copyBack.prepareHomeCopy(run());
      if (change === 'unreadable')
        jest.mocked(source.compose).mockRejectedValue(new Error('private configuration'));
      else
        vm.addContainer({
          Id: 'later',
          Name: '/later-holder',
          Image: 'sha256:web',
          Config: { User: '1001', Labels: {} },
          HostConfig: {},
          Mounts: [volumeMount('app_new', '/other')],
        });
      await expect(makeCopyBack().copyHome(run())).rejects.toMatchObject({
        message: expect.stringContaining(
          change === 'unreadable' ? 'Cannot resolve' : 'later-holder',
        ),
      });
      expect(home.volumes.has('app_new')).toBe(false);
      expect(inventory.get(`${PROJECT}/${REMOTE}`)).toBeUndefined();
      expect((await store.readCopyBack(OPERATION))!.verified).toEqual({});
      expect(details.dockerCopyBackResult).toBeUndefined();
      expect(vm.data.get('app_new')).toEqual(ownerArchive());
    },
  );
});

// One workflow carries production plans, HTTP trailers and durable snapshots across both engines.
// Compose CLI resolution/recreation is simulated here; the external spec proves real non-root access.
describe('full different-user Docker round trip', () => {
  const homeIds = { uid: 1000, gid: 1000 };
  function archive(ids: typeof homeIds, already: typeof homeIds, contents: string): Buffer {
    return tarArchive([
      { path: 'data/', type: 'Directory', ...ids, mode: 0o700, contents: '' },
      { path: 'data/private', type: 'File', ...ids, mode: 0o600, contents },
      { path: 'data/root', type: 'File', uid: 0, gid: 0, mode: 0o600, contents: 'root' },
      { path: 'data/service', type: 'File', uid: 999, gid: 999, mode: 0o600, contents: 'fixed' },
      { path: 'data/already', type: 'File', ...already, mode: 0o600, contents: 'already' },
    ]);
  }
  function assertArchive(bytes: Buffer, ids: typeof homeIds, contents: string) {
    expect(archiveEntries(bytes)).toEqual([
      { path: 'data/', ...ids, mode: 0o700 },
      { path: 'data/private', ...ids, mode: 0o600 },
      { path: 'data/root', uid: 0, gid: 0, mode: 0o600 },
      { path: 'data/service', uid: 999, gid: 999, mode: 0o600 },
      { path: 'data/already', ...ids, mode: 0o600 },
    ]);
    expect(tarEntries(bytes).find((entry) => entry.path === 'data/private')?.contents).toBe(
      contents,
    );
  }

  it.each([
    { uid: 1001, gid: 1002 },
    { uid: 1001, gid: 1000 },
  ])(
    'completes Apply/Verify, Connect, recreation, keep, retry and copy home for V=$uid:$gid',
    async (vmIds) => {
      await differentIds(vmIds);
      for (const engine of [home, vm]) {
        engine.containers.clear();
        engine.volumes.clear();
        engine.data.clear();
        engine.images.set('sha256:numeric', {
          architecture: 'amd64',
          tags: ['bitnami/example:latest'],
          size: 50,
          metadata: { Config: { User: '1001' } },
        });
      }
      inventory.clear();
      const code = join(root, 'code');
      await mkdir(code);
      await chmod(code, 0o755);
      await writeFile(join(code, 'main.ts'), 'export const marker = "project code";\n');
      // File sync supplies project code owned by the VM user before Docker handoff.
      vm.directoryOwners.set(code, vmIds);
      const gitRun = git.run.bind(git);
      jest.spyOn(git, 'run').mockImplementation(async (options) => {
        git.setDefaultResponse({
          type: 'success',
          stdout: options.argv.includes(':(literal)code') ? 'code/main.ts\0' : '',
        });
        return gitRun(options);
      });
      const composeFile = join(root, 'compose.yaml');
      const follows = '${DEVCHAIN_UID:-1000}:${DEVCHAIN_GID:-1000}';
      const mappedMounts = [
        { type: 'volume', source: 'shared', target: '/data' },
        { type: 'bind', source: state, target: '/state' },
        { type: 'bind', source: code, target: '/code' },
      ];
      const config: ComposeConfig = {
        name: 'app',
        services: {
          follow: { image: 'app-web:latest', user: follows, volumes: mappedMounts },
          pin: { image: 'app-web:latest', user: '1000:1000', volumes: mappedMounts },
          fixed: { image: 'app-web:latest', user: '999:999', volumes: [mappedMounts[0]] },
          root: { image: 'app-web:latest', user: '0:0', volumes: [mappedMounts[0]] },
          numeric: {
            image: 'bitnami/example:latest',
            volumes: [{ type: 'volume', source: 'exact', target: '/data' }],
          },
        },
        volumes: { shared: { name: 'app_shared' }, exact: { name: 'app_exact' } },
      };
      await writeFile(composeFile, stringify(config, { aliasDuplicateObjects: false }));
      // Read the edited file each time, resolving the same fixture under the supplied H or V environment.
      jest.mocked(source.compose).mockImplementation(async (_directory, options) => {
        const text = await readFile(composeFile, 'utf8');
        return parse(
          text.replace(
            /\$\{DEVCHAIN_(UID|GID):-([0-9]+)\}/g,
            (_match, key: string, fallback: string) =>
              options?.env?.[`DEVCHAIN_${key}`] ?? fallback,
          ),
        ) as ComposeConfig;
      });
      const labels = (service: string) => ({
        [COMPOSE]: 'app',
        [`${COMPOSE}.working_dir`]: root,
        [`${COMPOSE}.config_files`]: composeFile,
        'com.docker.compose.service': service,
      });
      for (const name of ['app_shared', 'app_exact'])
        home.volumes.set(name, { driver: 'local', labels: { [COMPOSE]: 'app' } });
      for (const name of ['app_shared', state])
        home.data.set(name, archive(homeIds, vmIds, 'home secret'));
      const exact = archive({ uid: 1001, gid: 1001 }, { uid: 1001, gid: 1001 }, 'exact secret');
      home.data.set('app_exact', exact);
      for (const [service, user] of Object.entries({
        follow: '1000:1000',
        pin: '1000:1000',
        fixed: '999:999',
        root: '0:0',
        numeric: '1001',
      })) {
        let mounts: FakeMount[] = [volumeMount('app_shared', '/data')];
        if (service === 'numeric') mounts = [volumeMount('app_exact', '/data')];
        else if (service === 'follow' || service === 'pin')
          mounts = [
            volumeMount('app_shared', '/data'),
            bindMount(),
            { Type: 'bind', Source: code, Destination: '/code', RW: true },
          ];
        home.addContainer({
          Id: service,
          Name: `/app-${service}-1`,
          Image: service === 'numeric' ? 'sha256:numeric' : 'sha256:web',
          Config: { Image: config.services![service].image, User: user, Labels: labels(service) },
          HostConfig: {
            Binds: mounts.map((mount) => `${mount.Name ?? mount.Source}:${mount.Destination}`),
          },
          Mounts: mounts,
          Created: BEFORE,
          startedAt: BEFORE,
          running: true,
        });
      }
      const plan = () => plans.plan(PROJECT, { remoteId: REMOTE }, undefined, { estimate: false });
      const blocked = await plan();
      expect(blocked.canConnect).toBe(false);
      const pin = blocked.items.find((item) => item.id === 'pin')!;
      expect(pin.ownership?.class).toBe('needs-user-fix');
      expect(blocked.dataGroups!.some((group) => group.ownership?.refusalReasons?.length)).toBe(
        true,
      );
      expect(pin.ownership!.fixProposal!.canApply).toBe(true);
      await expect(
        plans.applyUserFix(PROJECT, {
          remoteId: REMOTE,
          proposalId: pin.ownership!.fixProposal!.id,
          confirmed: true,
        }),
      ).resolves.toEqual({ applied: true });
      expect((parse(await readFile(composeFile, 'utf8')) as ComposeConfig).services!.pin.user).toBe(
        follows,
      );
      const verified = await plans.verifyUserFix(PROJECT, { remoteId: REMOTE });
      expect(verified.availability.available).toBe(true);
      expect(verified.codePaths).toContain('/code');
      expect(verified.items.find((item) => item.id === 'pin')).toMatchObject({
        ownership: { class: 'follows-user', target: { user: `${vmIds.uid}:${vmIds.gid}` } },
        choices: expect.arrayContaining(['container-and-data', 'data-only']),
      });
      expect(verified.dataGroups!.every((group) => !group.ownership?.refusalReasons?.length)).toBe(
        true,
      );
      expect(verified.items.find((item) => item.id === 'numeric')!.ownership?.class).toBe('exact');
      const context = { home: homeIds, vm: vmIds };
      const mappedRepresentation = { kind: 'mapped' as const, ...context };
      const vmContainer = (service: string) =>
        [...vm.containers.values()].find((container) => container.Name === `/app-${service}-1`)!;
      const connect = async (id: string, dataChoice: 'replace-home' | 'keep-vm') => {
        details = {
          dockerSelection: {
            items: verified.items.map((item) => ({
              id: item.id,
              mode: 'container-and-data',
              dataChoice,
            })),
          },
        };
        const step = { ...run(), operation: { ...run().operation, id, kind: 'attach' as const } };
        const selected = await plans.plan(
          PROJECT,
          { remoteId: REMOTE, ...(details.dockerSelection as object) },
          undefined,
          { estimate: false },
        );
        expect(selected.canConnect).toBe(true);
        await handoff.preflight(step);
        await handoff.stopHome(step);
        await handoff.push(step);
        await handoff.createHost(step);
      };
      await connect('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'replace-home');
      for (const service of ['follow', 'pin']) {
        expect(vmContainer(service).Config.User).toBe(`${vmIds.uid}:${vmIds.gid}`);
        expect(vmContainer(service).Mounts).toContainEqual({
          Type: 'bind',
          Source: code,
          Destination: '/code',
          RW: true,
        });
      }
      expect(vm.directoryOwners.get(code)).toEqual(vmIds);
      expect((await stat(code)).mode & 0o777).toBe(0o755);
      expect(vmContainer('fixed').Config.User).toBe('999:999');
      expect(vmContainer('root').Config.User).toBe('0:0');
      expect(vmContainer('numeric').Config.User).toBe('1001');
      for (const name of ['app_shared', state])
        assertArchive(vm.data.get(name)!, vmIds, 'home secret');
      expect(vm.data.get('app_exact')).toEqual(exact);
      expect(
        (details.docker as { result: { alreadyTargetEntries: number } }).result
          .alreadyTargetEntries,
      ).toBe(2);
      expect(
        records().find((group) => group.volumes.includes('app_shared'))!.representation,
      ).toEqual(mappedRepresentation);
      expect(
        records().find((group) => group.volumes.includes('app_exact'))!.representation,
      ).toEqual({ kind: 'exact', ...context });

      // Model compose up replacing the follower from freshly resolved VM settings, keeping its mounted resources.
      const vmConfig = await source.compose(root, {
        env: { DEVCHAIN_UID: String(vmIds.uid), DEVCHAIN_GID: String(vmIds.gid) },
      });
      const old = vmContainer('follow');
      vm.containers.delete(old.Id);
      vm.addContainer({
        ...old,
        Id: 'compose-recreated',
        Config: {
          ...old.Config,
          User: vmConfig!.services!.follow.user,
          Labels: { ...labels('follow'), 'com.docker.compose.config-hash': 'fresh-vm' },
        },
        Created: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        running: true,
      });
      expect(vmContainer('follow').Id).not.toBe(old.Id);
      expect(vmContainer('follow').Config.User).toBe(`${vmIds.uid}:${vmIds.gid}`);
      expect(vmContainer('follow').Mounts).toEqual(old.Mounts);
      assertArchive(vm.data.get('app_shared')!, vmIds, 'home secret');
      assertArchive(vm.data.get(state)!, vmIds, 'home secret');

      // A missing counterpart can be recreated against kept mapped data without another archive upload.
      vm.containers.delete(vmContainer('follow').Id);
      const kept = Buffer.from(vm.data.get('app_shared')!);
      const keptBind = Buffer.from(vm.data.get(state)!);
      const uploadsBeforeKeep = vm.calls.filter(
        (call) => call.startsWith('PUT ') && call.endsWith('/archive'),
      ).length;
      await connect('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'keep-vm');
      expect(vmContainer('follow').Config.User).toBe(`${vmIds.uid}:${vmIds.gid}`);
      expect(vm.data.get('app_shared')).toEqual(kept);
      expect(vm.data.get(state)).toEqual(keptBind);
      expect(
        vm.calls.filter((call) => call.startsWith('PUT ') && call.endsWith('/archive')),
      ).toHaveLength(uploadsBeforeKeep);
      expect(
        records().find((group) => group.volumes.includes('app_shared'))!.representation,
      ).toEqual(mappedRepresentation);
      expect(
        (details.docker as { result: { alreadyTargetEntries: number } }).result
          .alreadyTargetEntries,
      ).toBe(0);

      for (const name of ['app_shared', state])
        vm.data.set(name, archive(vmIds, homeIds, 'VM changed secret'));
      const createdFolder = join(root, 'vm-only');
      await mkdir(createdFolder);
      const current = parse(await readFile(composeFile, 'utf8')) as ComposeConfig;
      current.services!.created = {
        image: 'app-web:latest',
        user: follows,
        volumes: [
          { type: 'volume', source: 'created', target: '/data' },
          { type: 'bind', source: createdFolder, target: '/state' },
        ],
      };
      current.volumes!.created = { name: 'app_created' };
      await writeFile(composeFile, stringify(current));
      source.invalidate();
      vm.volumes.set('app_created', { driver: 'local', labels: { [COMPOSE]: 'app' } });
      for (const name of ['app_created', createdFolder])
        vm.data.set(name, archive(vmIds, homeIds, 'VM created secret'));
      vm.addContainer({
        Id: 'created',
        Name: '/app-created-1',
        Image: 'sha256:web',
        Config: { User: `${vmIds.uid}:${vmIds.gid}`, Labels: labels('created') },
        HostConfig: {},
        Mounts: [
          volumeMount('app_created', '/data'),
          { Type: 'bind', Source: createdFolder, Destination: '/state', RW: true },
        ],
        Created: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        running: true,
      });
      for (const container of vm.containers.values()) {
        container.Created ??= new Date().toISOString();
        container.State = { Running: true, StartedAt: new Date().toISOString() };
      }
      const sync = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
      expect(sync.groups.every((group) => !group.skipReason)).toBe(true);
      expect(sync.groups.find((group) => group.volumes.includes('app_created'))).toMatchObject({
        createdOnVm: true,
      });
      details = {
        dockerCopyBack: {
          choices: Object.fromEntries(sync.groups.map((group) => [group.key, 'copy-home'])),
        },
      };
      const sharedKey = sync.groups.find((group) => group.volumes.includes('app_shared'))!.key;
      const beforeFailure = structuredClone(
        records().find((group) => group.volumes.includes('app_shared'))!,
      );
      const read = client.dockerReadArchive.bind(client);
      jest.spyOn(client, 'dockerReadArchive').mockImplementation(async (...args) => {
        const answer = await read(...args);
        return args[1].source === 'app_shared'
          ? { ...answer, sha256: () => 'f'.repeat(64) }
          : answer;
      });
      await expect(copyBack.copyHome(run())).rejects.toMatchObject({
        code: 'DOCKER_COPY_BACK_FAILED',
      });
      expect((await store.readCopyBack(OPERATION))!.verified[sharedKey]).toBeUndefined();
      expect(records().find((group) => group.volumes.includes('app_shared'))).toEqual(
        beforeFailure,
      );
      expect(details.dockerCopyBackResult).toBeUndefined();
      expect(vm.data.get('app_shared')).toEqual(archive(vmIds, homeIds, 'VM changed secret'));
      jest.mocked(client.dockerReadArchive).mockRestore();
      await makeCopyBack().copyHome(run());
      for (const name of ['app_shared', state])
        assertArchive(home.data.get(name)!, homeIds, 'VM changed secret');
      for (const name of ['app_created', createdFolder])
        assertArchive(home.data.get(name)!, homeIds, 'VM created secret');
      for (const name of ['app_shared', state])
        expect(vm.data.get(name)).toEqual(archive(vmIds, homeIds, 'VM changed secret'));
      for (const name of ['app_created', createdFolder])
        expect(vm.data.get(name)).toEqual(archive(vmIds, homeIds, 'VM created secret'));
      expect(home.data.get('app_exact')).toEqual(exact);
      expect(home.containers.get('numeric')!.Config.User).toBe('1001');
      expect(await readFile(join(code, 'main.ts'), 'utf8')).toBe(
        'export const marker = "project code";\n',
      );
      expect(result().alreadyTargetEntries).toBe(4);
      const completed = structuredClone(result());
      const copies = home.calls.filter(
        (call) => call.startsWith('PUT ') && call.endsWith('/archive'),
      ).length;
      await makeCopyBack().copyHome(run());
      expect(result()).toEqual(completed);
      expect(
        home.calls.filter((call) => call.startsWith('PUT ') && call.endsWith('/archive')),
      ).toHaveLength(copies);
      for (const name of ['app_shared', 'app_created'])
        expect(records().find((group) => group.volumes.includes(name))).toMatchObject({
          volumes: [name],
          bindPaths: [name === 'app_created' ? createdFolder : state],
          representation: mappedRepresentation,
          lastSyncDirection: 'to-home',
        });
      expect(
        inventory.get(`${PROJECT}/${REMOTE}`)!.items.find((item) => item.name === 'app-follow-1')!
          .dataRepresentations,
      ).toContainEqual({
        volumes: ['app_shared'],
        bindPaths: [state],
        representation: mappedRepresentation,
      });
      const next = await plan();
      for (const name of ['app_shared', 'app_created'])
        expect(next.dataGroups!.find((group) => group.volumes.includes(name))?.state).toBe(
          'in-sync',
        );
      // An unrecorded VM holder remains an exact consumer, independently of its verified data representation.
      expect(next.dataGroups!.find((group) => group.volumes.includes('app_created'))).toMatchObject(
        {
          itemIds: [],
          ownership: {
            refusalReasons: [
              {
                code: 'ownership-consumer-conflict',
                message: expect.stringContaining(
                  'VM app-created-1: exact consumer runs as uid 1001',
                ),
              },
            ],
          },
        },
      );
      expect(
        next.dataGroups!.find((group) => group.volumes.includes('app_shared'))!.ownership
          ?.refusalReasons,
      ).toBeUndefined();
      for (const id of ['follow', 'pin'])
        expect(next.items.find((item) => item.id === id)).toMatchObject({
          selectedMode: 'container-and-data',
          dataAction: 'keep-vm',
          blockers: [],
        });
      expect(next.canConnect).toBe(true);
    },
  );
});
