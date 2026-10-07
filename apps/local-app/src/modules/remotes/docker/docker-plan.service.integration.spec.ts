import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DockerPlanController } from './docker-plan.controller';
import { DockerCopyBack } from './docker-copy-back';
// The real source scanner talks to a fake Unix engine; the VM side is a stubbed RemoteHostClient.
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { ValidationError } from '../../../common/errors/error-types';
import type { DockerScanResult } from '../host/host-docker.dto';
import type { DockerImportInventory } from '../operations/docker-import-inventory.store';
import { buildRecord } from './docker-handoff';
import { DockerPlanService } from './docker-plan.service';
import { DOCKER_PLAN_REUSE_MS, DockerPlanSourceService } from './docker-plan-source.service';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import type { DockerPlan } from './docker-plan.dto';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { ConnectChoicesStore } from '../connect-choices.store';

const projectId = '11111111-1111-4111-8111-111111111111';
const remoteId = '22222222-2222-4222-8222-222222222222';
const asRoot = process.getuid?.() === 0;

let git: FakeProcessExecutor;
let root: string;
let socket: string;
let server: Server;
let requests: string[];
let info: Record<string, unknown>;
let containers: Array<Record<string, unknown>>;
let target: DockerScanResult;
let inventory: DockerImportInventory | null;
let runtime: Record<string, unknown>;
let remote: Record<string, jest.Mock>;
let service: DockerPlanService;
let savedDockerHost: string | undefined;
let projectRoot: string;
let source: DockerPlanSourceService;
let networkRanges: Map<string, string[]>;
let choices: ConnectChoicesStore;
let choicesDatabase: ReturnType<typeof createTestDatabase>;

const fs = (path: string, filesystemId: string, freeBytes = 1e12) => ({
  path,
  filesystemId,
  freeBytes,
});
const container = (
  id: string,
  mounts: unknown[] = [],
  host: Record<string, unknown> = {},
  config: Record<string, unknown> = {},
) => ({
  Id: id,
  Name: `/${id}`,
  Image: 'image',
  Config: { User: '1000', Labels: {}, Env: ['SECRET=must-never-escape'], ...config },
  HostConfig: host,
  Mounts: mounts,
});
const bind = (Source: string, Destination = '/state') => ({
  Type: 'bind',
  Source,
  Destination,
  RW: true,
});
const web = () =>
  container(
    'web',
    [
      bind(join(root, 'project', 'state')),
      { Type: 'volume', Name: 'named', Source: '/docker/named', Destination: '/db', RW: true },
    ],
    { Binds: ['named:/db', `${join(root, 'project', 'state')}:/state`] },
  );
const run = (body: Record<string, unknown> = {}) => service.plan(projectId, { remoteId, ...body });
const item = (plan: DockerPlan, id: string) => plan.items.find((i) => i.id === id)!;
function fixedWeb(): void {
  containers[0].NetworkSettings = {
    Networks: { 'shared-network': { IPAMConfig: { IPv4Address: '172.19.0.200' } } },
  };
  networkRanges.set('shared-network', ['172.19.0.0/16', 'fd00::/64']);
  target.networks = [{ name: 'shared-network', subnets: ['172.19.0.0/16'], addresses: [] }];
}

beforeEach(async () => {
  choicesDatabase = createTestDatabase();
  choices = new ConnectChoicesStore(choicesDatabase.db);
  root = await mkdtemp(join(tmpdir(), 'docker-plan-service-'));
  await mkdir(join(root, 'project', 'state'), { recursive: true });
  await writeFile(join(root, 'project', 'state', 'rows'), 'rows!');
  socket = join(root, 'engine.sock');
  requests = [];
  info = { Driver: 'overlay2', DockerRootDir: '/var/lib/docker', SecurityOptions: [] };
  containers = [web(), container('cache')];
  projectRoot = join(root, 'project');
  target = { architecture: 'x86_64', containers: [], volumes: [], paths: [] };
  networkRanges = new Map();
  inventory = null;
  runtime = {
    homePath: root,
    uid: 1000,
    gid: 1000,
    docker: {
      installed: true,
      engineVersion: '29.7.2',
      composeVersion: '5.5.1',
      userInGroup: true,
      dataRootFreeBytes: 1e12,
      capacity: {
        dockerRoot: fs('/var/lib/docker', 'root'),
        imageStore: fs('/var/lib/docker', 'root'),
        home: fs(root, 'home'),
      },
    },
  };
  remote = {
    remoteRuntime: jest.fn(async () => runtime),
    dockerVersion: jest.fn(async () => ({ ApiVersion: '1.47', MinAPIVersion: '1.24' })),
    dockerScan: jest.fn(async (_id: string, paths: string[]) => ({
      ...target,
      paths: paths.map(
        (path) => target.paths.find((p) => p.path === path) ?? { path, exists: false },
      ),
    })),
    dockerCapacity: jest.fn(async (_id: string, paths: string[]) => ({
      paths: paths.map((path) => ({ path, filesystemId: 'home', freeBytes: 1e12 })),
    })),
    dockerImagesPresent: jest.fn(async () => ({ ids: [] })),
    dockerProbe: jest.fn(async (_id: string, body: NodeJS.ReadableStream) => {
      for await (const chunk of body) void chunk;
    }),
  };
  server = createServer((req, res) => {
    const path = (req.url ?? '').replace(/^\/v\d+\.\d+/, '');
    requests.push(req.url ?? '');
    const json = (value: unknown) => res.end(JSON.stringify(value));
    if (path === '/info') return json(info);
    if (path === '/version') return json({ ApiVersion: '1.48', MinAPIVersion: '1.24' });
    if (path === '/containers/json?all=true')
      return json(
        containers.map((c) => ({
          Id: c.Id,
          Labels: (c.Config as { Labels?: Record<string, string> }).Labels,
          Mounts: c.Mounts,
        })),
      );
    if (path === '/system/df?type=image&type=volume')
      return json({
        Images: [{ Id: 'sha256:image', Size: 100 }],
        Volumes: [{ Name: 'named', UsageData: { Size: 9 } }],
      });
    if (path === '/volumes') return json({ Volumes: [{ Name: 'named', Driver: 'local' }] });
    if (path.startsWith('/networks/')) {
      const name = decodeURIComponent(path.slice('/networks/'.length));
      return json({
        Name: name,
        IPAM: { Config: (networkRanges.get(name) ?? []).map((Subnet) => ({ Subnet })) },
      });
    }
    if (path.startsWith('/containers/')) {
      const inspect = containers.find((c) => path.split('?')[0] === `/containers/${c.Id}/json`);
      return json({
        ...inspect,
        ...(path.endsWith('?size=true') && { SizeRw: inspect?.SizeRw ?? 17 }),
      });
    }
    if (path === '/images/image/json') return json({ Id: 'sha256:image', Architecture: 'amd64' });
    if (path === `/images/${encodeURIComponent('sha256:image')}/get`)
      return res.end(Buffer.alloc(64 * 1024));
    res.statusCode = 404;
    res.end('{}');
  });
  server.listen(socket);
  await once(server, 'listening');
  savedDockerHost = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = `unix://${socket}`;

  git = new FakeProcessExecutor();
  git.setDefaultResponse({ type: 'failure', exitCode: 128 });
  const sourceModule = await Test.createTestingModule({
    providers: [DockerPlanSourceService, { provide: ProcessExecutor, useValue: git }],
  }).compile();
  source = sourceModule.get(DockerPlanSourceService);
  jest.spyOn(source, 'homePath').mockReturnValue(root);
  jest.spyOn(source, 'uid').mockReturnValue(1000);
  jest.spyOn(source, 'gid').mockReturnValue(1000);
  jest.spyOn(source, 'compose').mockResolvedValue(null);
  service = new DockerPlanService(
    {
      getProject: async () => ({ id: projectId, rootPath: projectRoot }),
      getRemote: async () => ({ id: remoteId }),
    } as never,
    source,
    remote as never,
    { get: () => inventory } as never,
    choices,
  );
});
afterEach(async () => {
  choicesDatabase.sqlite.close();
  if (savedDockerHost === undefined) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = savedDockerHost;
  jest.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await chmod(join(root, 'project'), 0o700).catch(() => undefined);
  await chmod(join(root, 'project', 'locked'), 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

// The existing engine fixture proves the gate refuses before either side scans data.
it.each([
  { name: 'different uid', vmUid: 2000, vmGid: 1000, homeUid: 1000, homeGid: 1000 },
  { name: 'different gid', vmUid: 1000, vmGid: 2000, homeUid: 1000, homeGid: 1000 },
  { name: 'missing VM uid', vmUid: undefined, vmGid: 1000, homeUid: 1000, homeGid: 1000 },
  { name: 'missing VM gid', vmUid: 1000, vmGid: undefined, homeUid: 1000, homeGid: 1000 },
  { name: 'unknown VM ids', vmUid: null, vmGid: null, homeUid: 1000, homeGid: 1000 },
  { name: 'unknown home uid', vmUid: 1000, vmGid: 1000, homeUid: null, homeGid: 1000 },
  { name: 'unknown home gid', vmUid: 1000, vmGid: 1000, homeUid: 1000, homeGid: null },
])('disables automatic Docker moves for $name', async ({ vmUid, vmGid, homeUid, homeGid }) => {
  runtime.uid = vmUid;
  runtime.gid = vmGid;
  runtime.uidConflict = { requestedUid: 1000, holder: 'ubuntu' };
  jest.mocked(source.uid).mockReturnValue(homeUid);
  jest.mocked(source.gid).mockReturnValue(homeGid);

  const plan = await run();

  expect(plan.availability).toMatchObject({
    available: false,
    side: 'remote',
    reason: { code: 'vm-user-mismatch' },
    userMismatch: {
      homeUid,
      homeGid,
      vmUid: vmUid ?? null,
      vmGid: vmGid ?? null,
      uidConflict: { requestedUid: 1000, holder: 'ubuntu' },
    },
  });
  expect(plan.items).toEqual([]);
  expect(plan.apiVersion).toBeNull();
  expect(plan.canConnect).toBe(false);
  expect(
    requests.some((path) => path.includes('/containers/') || path.includes('/system/df')),
  ).toBe(false);
  expect(remote.dockerScan).not.toHaveBeenCalled();
});

it('evaluates fit from the restored mode in the first plan', async () => {
  const data = join(root, 'data');
  await mkdir(data);
  await writeFile(join(data, 'rows'), Buffer.alloc(2 * 1024 * 1024));
  containers = [
    container('web', [bind(projectRoot, '/code'), bind(data)], { Binds: [`${data}:/state`] }),
  ];
  runtime.docker = {
    ...(runtime.docker as Record<string, unknown>),
    capacity: {
      dockerRoot: fs('/var/lib/docker', 'root'),
      imageStore: fs('/var/lib/docker', 'root'),
      home: fs(root, 'home', 1000),
    },
  };
  remote.dockerCapacity.mockImplementation(async (_id: string, paths: string[]) => ({
    paths: paths.map((path) => fs(path, 'home', 1000)),
  }));
  expect((await run()).canConnect).toBe(false);
  choices.recordAttach(projectId, remoteId, true);
  choices.recordPlan(projectId, remoteId, [
    { ...item(await run(), 'web'), selectedMode: 'without-data' },
  ]);

  const restored = await run();
  expect(item(restored, 'web')).toMatchObject({
    defaultSelected: true,
    selectedMode: 'without-data',
  });
  expect(restored.fit).toBe('fits');
  expect(restored.canConnect).toBe(true);
});

it('plans linked and other containers with negotiated API, fit, estimate and exclusions', async () => {
  const plan = await run();
  expect(plan.availability).toEqual({ available: true, side: null, reason: null });
  expect(plan.apiVersion).toBe('1.47');
  expect(requests.filter((r) => r.includes('/containers/web'))).toEqual([
    '/v1.47/containers/web/json?size=true',
  ]);
  expect(item(plan, 'web')).toMatchObject({
    linkedReasons: [`bind:${join(root, 'project', 'state')}`],
    defaultSelected: true,
    selectedMode: 'container-and-data',
    targetAction: 'create',
    writerGroup: ['web'],
    alsoStops: [],
    writableLayer: { bytes: 17, unknown: false },
  });
  expect(item(plan, 'cache')).toMatchObject({ linkedReasons: [], selectedMode: null });
  expect(plan.managedExclusions).toEqual(['/state']);
  expect(remote.dockerCapacity).toHaveBeenCalledWith(
    remoteId,
    [join(root, 'project', 'state')],
    expect.objectContaining({ apiVersion: '1.47' }),
  );
  expect(plan.filesystems.map((f) => [f.filesystemId, f.status])).toEqual([
    ['root', 'fits'],
    ['home', 'fits'],
  ]);
  expect(plan.filesystems.find((f) => f.filesystemId === 'home')?.requiredBytes).toBe(5);
  expect(plan.fit).toBe('fits');
  expect(plan.canConnect).toBe(true);
  expect(plan.estimate).toMatchObject({ approximate: true, probeBytes: 16 * 1024 * 1024 });
  expect(plan.estimate!.maxSeconds).toBeGreaterThanOrEqual(plan.estimate!.minSeconds);
  expect(plan.estimate!.minSeconds).toBeGreaterThan(0);
  expect(plan.reconnect).toBeNull();
  expect(JSON.stringify(plan)).not.toContain('must-never-escape');
});

// The plan layer owns copy accounting, data groups, exclusion paths and the displayed stop list.
it('keeps tracked code linked without measuring, grouping, counting, excluding or recording its data', async () => {
  git.setDefaultResponse({ type: 'success', stdout: 'state/app.py\0' });
  containers = [container('code', [bind(join(projectRoot, 'state'))])];
  const measure = jest.spyOn(source, 'measure');
  const plan = await run();
  const code = item(plan, 'code');
  expect(code.mounts[0].kind).toBe('project-code');
  expect(code.defaultSelected).toBe(true);
  expect(code.dataSize).toEqual({ bytes: 0, unknown: false });
  expect(plan.copySize).toEqual({ bytes: 100, unknown: false });
  expect(plan.dataGroups).toEqual([]);
  expect(plan.managedExclusions).toEqual([]);
  expect(plan.codePaths).toEqual(['/state']);
  expect(measure).not.toHaveBeenCalled();
  expect(remote.dockerCapacity).not.toHaveBeenCalled();
  const record = buildRecord(plan.items, [code], plan.apiVersion!, projectRoot);
  expect(record.binds).toEqual([]);
  expect(record.items[0].binds).toEqual([]);
  expect(record.items[0].sizeBytes).toBe(0);
});

it('names an unselected writable code mount above selected data in the stop list', async () => {
  const code = join(projectRoot, 'plugins');
  const data = join(code, 'state');
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'rows'), 'rows');
  git.enqueueResponse({ type: 'success' }, { type: 'success', stdout: 'plugins/app.py\0' });
  containers = [container('db', [bind(data)]), container('writer', [bind(code)])];
  const plan = await run({ items: [{ id: 'db', mode: 'container-and-data' }] });
  expect(item(plan, 'writer').mounts[0].kind).toBe('project-code');
  expect(item(plan, 'db').writerGroup).toEqual(['db', 'writer']);
  expect(item(plan, 'db').alsoStops).toEqual(['writer']);
  expect(
    buildRecord(plan.items, [item(plan, 'db')], plan.apiVersion!, projectRoot).stopIds,
  ).toEqual(['db', 'writer']);
});

it('classifies previous import paths even when their containers are absent', async () => {
  containers = [];
  inventory = {
    importedAt: '2026-09-01T00:00:00.000Z',
    items: [
      {
        name: 'old',
        imageId: 'image',
        volumes: [],
        bindPaths: ['/plugins', '/state'],
        sizeBytes: 5,
      },
    ],
  };
  git.enqueueResponse({ type: 'success', stdout: 'plugins/app.py\0' }, { type: 'success' });
  const plan = await run();
  expect(plan.codePaths).toEqual(['/plugins']);
  expect(git.calls.map((call) => call.argv.at(-1))).toEqual([
    ':(literal)plugins',
    ':(literal)state',
  ]);
});

it('keeps a tracked inventory path as data when copy-back requests it', async () => {
  git.setDefaultResponse({ type: 'success', stdout: 'state/app.py\0' });
  const plan = await service.plan(projectId, { remoteId }, undefined, {
    estimate: false,
    dataBindPaths: ['/state'],
  });
  expect(item(plan, 'web').mounts[0].kind).toBe('project-bind');
  expect(plan.codePaths).toEqual([]);
  expect(plan.dataGroups).toEqual([
    expect.objectContaining({ bindPaths: [join(projectRoot, 'state')] }),
  ]);
});

it('requires acceptance separately for each selected privileged container', async () => {
  for (const c of containers) (c.HostConfig as Record<string, unknown>).Privileged = true;
  const plan = await run({
    items: [
      { id: 'web', mode: 'container-and-data', acceptPrivileged: true },
      { id: 'cache', mode: 'container-and-data' },
    ],
  });
  expect(item(plan, 'web').blockers).toEqual([]);
  expect(item(plan, 'cache').blockers).toEqual([
    expect.objectContaining({ code: 'privileged-not-accepted' }),
  ]);
  expect(plan.canConnect).toBe(false);
});

it('keeps privileged containers with devices runtime-bound and permits only their data', async () => {
  Object.assign(containers[0].HostConfig as object, {
    Privileged: true,
    Devices: [{ PathOnHost: '/dev/a' }],
  });
  const plan = await run({ items: [{ id: 'web', mode: 'data-only' }] });
  expect(item(plan, 'web')).toMatchObject({
    privileged: true,
    choices: ['data-only'],
    blockers: [{ code: 'runtime-bound', message: 'Container cannot move: HostConfig.Devices' }],
  });
  expect(plan.canConnect).toBe(true);
});

it.each([false, true])(
  'reuses measurements for two minutes; Connect reads fresh (new linked container: %s)',
  async (newLinked) => {
    const measure = jest.spyOn(source, 'measure');
    const exportRate = jest.spyOn(source, 'exportRate');
    const compose = jest.mocked(source.compose);
    for (const c of containers)
      c.Config = {
        Labels: {
          'com.docker.compose.project': 'app',
          'com.docker.compose.project.working_dir': projectRoot,
          'com.docker.compose.project.config_files': join(projectRoot, 'custom.yaml'),
          'com.docker.compose.service': 'web',
        },
      };
    compose.mockResolvedValue({
      name: 'app',
      services: { web: { build: { context: projectRoot } } },
    });
    const dialog = () => service.plan(projectId, { remoteId }, undefined, { reuse: true });
    const diskUsageReads = () =>
      requests.filter((r) => r.endsWith('/system/df?type=image&type=volume')).length;
    const sizedInspects = () => requests.filter((r) => r.endsWith('/json?size=true')).length;
    const composeReads = () =>
      compose.mock.calls.filter(([, options]) => options?.files?.length).length;

    const first = await dialog();
    expect(diskUsageReads()).toBe(1);
    expect(sizedInspects()).toBe(2);
    expect(remote.dockerProbe).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(composeReads()).toBe(1);

    // The next choice reads the containers again, but none of the measurements.
    containers[0].SizeRw = 99;
    containers.push(container('late', newLinked ? [bind(projectRoot)] : []));
    const second = await dialog();
    expect(item(second, 'late').writableLayer).toEqual({
      bytes: newLinked ? 17 : 0,
      unknown: !newLinked,
    });
    expect(item(first, 'web').writableLayer).toEqual({ bytes: 17, unknown: false });
    expect(item(second, 'web').writableLayer).toEqual(item(first, 'web').writableLayer);
    expect(item(second, 'web').mounts).toEqual(item(first, 'web').mounts);
    expect(second.estimate).toEqual(first.estimate);
    expect(diskUsageReads()).toBe(1);
    expect(sizedInspects()).toBe(newLinked ? 3 : 2);
    expect(remote.dockerProbe).toHaveBeenCalledTimes(1);
    expect(exportRate).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(composeReads()).toBe(1);

    // Connect measures again before it stops anything.
    const fresh = await service.plan(projectId, { remoteId }, undefined, { estimate: false });
    expect(item(fresh, 'web').writableLayer).toEqual({ bytes: 99, unknown: false });
    expect(sizedInspects()).toBe(newLinked ? 6 : 4);
    expect(diskUsageReads()).toBe(2);
    expect(measure).toHaveBeenCalledTimes(2);
    expect(composeReads()).toBe(2);

    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + DOCKER_PLAN_REUSE_MS);
    containers[0].SizeRw = 123;
    const expired = await dialog();
    expect(item(expired, 'web').writableLayer).toEqual({ bytes: 123, unknown: false });
    expect(sizedInspects()).toBe(newLinked ? 9 : 6);
    expect(diskUsageReads()).toBe(3);
    expect(remote.dockerProbe).toHaveBeenCalledTimes(2);
    expect(measure).toHaveBeenCalledTimes(3);
    expect(composeReads()).toBe(3);
  },
);

// The plan boundary verifies that another selected item's demand wins for a shared image ID.
it('copies a skipped build image when a selected container still needs it', async () => {
  containers = [container('kept'), container('new', [bind(projectRoot)])];
  containers[0].Config = {
    Labels: {
      'com.docker.compose.project': 'app',
      'com.docker.compose.project.working_dir': projectRoot,
      'com.docker.compose.project.config_files': join(projectRoot, 'custom.yaml'),
      'com.docker.compose.service': 'kept',
    },
  };
  jest
    .mocked(source.compose)
    .mockResolvedValue({ name: 'app', services: { kept: { build: { context: projectRoot } } } });
  target.containers = [
    { id: 'vm-kept', name: 'kept', labels: { 'com.docker.compose.project': 'app' }, mounts: [] },
  ];
  target.volumes = [
    {
      name: 'named',
      driver: 'local',
      labels: {
        'dev.devchain.project': projectId,
        'com.docker.compose.project': 'app',
      },
    },
  ];
  const plan = await run();
  expect(item(plan, 'kept').images[0].notCopied).toBe(true);
  expect(item(plan, 'new').images[0].notCopied).toBeUndefined();
  expect(plan.copySize.bytes).toBe(100);
  expect(remote.dockerImagesPresent).toHaveBeenCalledWith(
    remoteId,
    ['sha256:image'],
    expect.anything(),
  );
  const record = buildRecord(
    plan.items,
    plan.items.filter((i) => i.selectedMode),
    plan.apiVersion!,
    projectRoot,
  );
  expect(record.images).toEqual([{ id: 'sha256:image', sizeBytes: 100 }]);
});

it.each([
  ['as stored', ''],
  ['with a trailing slash', '/'],
])(
  'copies and excludes a data folder nested in a whole-project bind, rootPath %s',
  async (_label, suffix) => {
    const project = join(root, 'project');
    const pg = join(project, 'data', 'pg');
    await mkdir(pg, { recursive: true });
    await writeFile(join(pg, 'PG_VERSION'), '17');
    projectRoot = project + suffix;
    containers = [
      container('app', [bind(project, '/app')], { Binds: [`${project}:/app`] }),
      container('db', [bind(pg, '/var/lib/postgresql/data')], {
        Binds: [`${pg}:/var/lib/postgresql/data`],
      }),
    ];
    const plan = await run();
    expect(item(plan, 'app').selectedMode).toBe('container-and-data');
    expect(item(plan, 'db').selectedMode).toBe('container-and-data');
    expect(plan.managedExclusions).toEqual(['/data/pg']);
    expect(remote.dockerCapacity).toHaveBeenCalledWith(remoteId, [pg], expect.anything());
    // Only the Postgres folder counts; the project's other files travel by file sync.
    expect(plan.filesystems.find((f) => f.filesystemId === 'home')?.requiredBytes).toBe(2);
    expect(item(plan, 'app').dataSize).toEqual({ bytes: 0, unknown: false });
    expect(item(plan, 'db').dataSize).toEqual({ bytes: 2, unknown: false });

    const selected = plan.items.filter((i) => i.selectedMode);
    const record = buildRecord(plan.items, selected, plan.apiVersion!, projectRoot);
    expect(record.binds).toEqual([expect.objectContaining({ path: pg, replace: true })]);
    expect(record.items.find((i) => i.id === 'app')?.binds).toEqual([]);
    expect(record.items.find((i) => i.id === 'db')?.binds).toEqual([pg]);

    inventory = {
      importedAt: '2026-09-27T00:00:00.000Z',
      items: [{ name: 'db', imageId: 'image', volumes: [], bindPaths: ['/data/pg'], sizeBytes: 2 }],
    };
    target.paths = [{ path: pg, exists: true }];
    expect(
      (await run({ items: [{ id: 'db', mode: 'container-and-data', dataChoice: 'replace-home' }] }))
        .reconnect?.replacing,
    ).toEqual(['db']);
  },
);

it('counts an image the VM holds only under its paired VM ID as present', async () => {
  inventory = {
    importedAt: '2026-09-27T00:00:00.000Z',
    items: [
      {
        name: 'web',
        imageId: 'sha256:image',
        vmImageId: 'sha256:vm-image',
        volumes: [],
        bindPaths: [],
        sizeBytes: 0,
      },
    ],
  };
  remote.dockerImagesPresent.mockResolvedValue({ ids: ['sha256:vm-image'] });
  const plan = await run();
  expect(remote.dockerImagesPresent).toHaveBeenCalledWith(
    remoteId,
    expect.arrayContaining(['sha256:image', 'sha256:vm-image']),
    expect.anything(),
  );
  // No image bytes enter the fit, exactly as when the VM answers with the home ID.
  expect(plan.filesystems.find((f) => f.filesystemId === 'root')?.requiredBytes).toBe(9);
});

it('gates Connect on the destination filesystem fit', async () => {
  const capacity = (runtime.docker as { capacity: Record<string, unknown> }).capacity;
  capacity.imageStore = fs('/var/lib/containerd', 'images');
  capacity.dockerRoot = fs('/var/lib/docker', 'root', 5);
  let plan = await run();
  expect(plan.canConnect).toBe(false);

  capacity.dockerRoot = fs('/var/lib/docker', 'root', 10);
  plan = await run();
  expect(plan.canConnect).toBe(true);
});

it('reports the reconnect inventory, same-name conflicts and unrelated holders', async () => {
  inventory = {
    importedAt: '2026-09-01T00:00:00.000Z',
    items: [
      {
        name: 'web',
        imageId: 'sha256:image',
        volumes: [{ name: 'named', sizeBytes: 9 }],
        bindPaths: ['/state'],
        sizeBytes: 14,
      },
    ],
  };
  target.volumes = [
    { name: 'named', driver: 'local', labels: { 'dev.devchain.project': projectId } },
  ];
  target.containers = [
    {
      id: 'vm-web',
      name: 'web',
      labels: { 'dev.devchain.project': projectId },
      mounts: [{ type: 'volume', name: 'named', destination: '/db' }],
    },
    {
      id: 'vm-intruder',
      name: 'intruder',
      labels: {},
      mounts: [{ type: 'volume', name: 'named', destination: '/x' }],
    },
    { id: 'vm-cache', name: 'cache', labels: {}, mounts: [] },
  ];
  const plan = await run({
    items: [
      { id: 'web', mode: 'container-and-data', dataChoice: 'replace-home' },
      { id: 'cache', mode: 'container-and-data' },
    ],
  });
  expect(item(plan, 'web').targetAction).toBe('replace');
  expect(item(plan, 'web').blockers).toEqual([
    expect.objectContaining({
      code: 'unrelated-holder',
      message: expect.stringContaining('intruder'),
    }),
  ]);
  expect(item(plan, 'cache').targetAction).toBe('conflict');
  expect(item(plan, 'cache').blockers.map((b) => b.code)).toEqual(['container-conflict']);
  expect(plan.reconnect).toEqual({
    importedAt: '2026-09-01T00:00:00.000Z',
    replacing: ['web'],
    lossNotice: expect.stringContaining('VM changes not copied back are lost'),
  });
  expect(plan.canConnect).toBe(false);
});

(asRoot ? it.skip : it)(
  'warns about an unreadable in-project folder of an unselected container',
  async () => {
    await mkdir(join(root, 'project', 'locked'));
    await chmod(join(root, 'project', 'locked'), 0o000);
    containers.push(container('locked', [bind(join(root, 'project', 'locked'))]));
    const plan = await run({ items: [{ id: 'web', mode: 'container-and-data' }] });
    expect(item(plan, 'locked').mounts[0].size.unknown).toBe(true);
    expect(plan.warnings.map((w) => w.code)).toEqual(['unreadable-unselected-folder']);
    expect(plan.canConnect).toBe(true);
  },
);

it('keeps an unrelated container with an unsupported setting as cannot-move, not a failed plan', async () => {
  containers.push(container('odd', [], { VolumesFrom: ['secret-volume-reference'] }));
  const plan = await run();
  expect(plan.availability.available).toBe(true);
  const odd = item(plan, 'odd');
  expect(odd.blockers).toEqual([
    {
      code: 'runtime-bound',
      message: expect.stringMatching(/^odd: unsupported setting .+VolumesFrom$/),
    },
  ]);
  expect(odd.choices).toEqual(['data-only']);
  expect(JSON.stringify(plan)).not.toContain('secret-volume-reference');
});

it('plans one blocked Compose item when the compose config cannot be read', async () => {
  jest
    .spyOn(source, 'compose')
    .mockRejectedValue(new Error('Cannot read project Docker Compose configuration'));
  const plan = await run();
  const compose = plan.items.find((i) => i.kind === 'compose-project')!;
  expect(compose).toMatchObject({
    linkedReasons: ['compose-file-at-project-root'],
    blockers: [
      {
        code: 'compose-unreadable',
        message: expect.stringMatching(/: Cannot read project Docker Compose configuration$/),
      },
    ],
    choices: [],
    defaultSelected: false,
  });
  expect(plan.items.some((i) => i.id === 'web')).toBe(true);
});

it('accepts only item ids and modes that match the fresh scan', async () => {
  await expect(run({ paths: ['/etc'] })).rejects.toBeInstanceOf(ZodError);
  await expect(run({ items: [{ id: 'ghost', mode: 'data-only' }] })).rejects.toBeInstanceOf(
    ValidationError,
  );
});

type Setup = () => void | Promise<void>;
const reasons: Array<[string, 'home' | 'remote', Setup]> = [
  ['remote-docker-host', 'home', () => void (process.env.DOCKER_HOST = 'tcp://10.0.0.1:2375')],
  ['unsupported-endpoint', 'home', () => void (process.env.DOCKER_HOST = 'npipe:////./pipe/x')],
  ['no-socket', 'home', () => void (process.env.DOCKER_HOST = `unix://${root}/missing.sock`)],
  ['rootless', 'home', () => void (info.SecurityOptions = ['name=seccomp', 'name=rootless'])],
  ['docker-desktop', 'home', () => void (info.OperatingSystem = 'Docker Desktop')],
  ['remote-unreachable', 'remote', () => void remote.remoteRuntime.mockRejectedValue(new Error())],
  [
    'remote-no-docker',
    'remote',
    () => void ((runtime.docker as { installed: boolean }).installed = false),
  ],
  [
    'incompatible-api',
    'remote',
    () =>
      void remote.dockerVersion.mockResolvedValue({ ApiVersion: '1.20', MinAPIVersion: '1.12' }),
  ],
  ['remote-docker-routes', 'remote', () => void remote.dockerScan.mockRejectedValue(new Error())],
];
if (!asRoot) reasons.push(['no-socket-access', 'home', () => chmod(socket, 0o000)]);
it.each(reasons)('reports availability reason %s', async (code, side, setup) => {
  await setup();
  const plan = await run();
  expect(plan.availability).toEqual({
    available: false,
    side,
    reason: { code, message: expect.any(String) },
  });
  expect(plan.canConnect).toBe(false);
  expect(plan.items).toEqual([]);
});

it('projects group checks from existing home inspects without archive reads or another home scan', async () => {
  const baseline = '2026-09-21T00:00:00.000Z';
  const before = '2026-09-20T00:00:00.000Z';
  Object.assign(containers[0], { Created: before, State: { StartedAt: before, Running: false } });
  const path = join(projectRoot, 'state');
  target.volumes = [
    { name: 'named', driver: 'local', labels: { 'dev.devchain.project': projectId } },
  ];
  target.paths = [{ path, exists: true }];
  target.containers = [
    {
      id: 'vm-web',
      name: 'web',
      labels: { 'dev.devchain.project': projectId },
      mounts: [
        { type: 'volume', name: 'named', destination: '/db' },
        { type: 'bind', source: path, destination: '/state' },
      ],
      metadata: { created: before, startedAt: before, running: false },
    },
  ];
  inventory = {
    items: [],
    importedAt: baseline,
    groups: [
      { volumes: ['named'], bindPaths: [path], lastSyncedAt: baseline, lastSyncDirection: 'to-vm' },
    ],
  };
  const plan = await service.plan(projectId, { remoteId }, undefined, { estimate: false });
  expect(plan.dataGroups).toEqual([
    { itemIds: ['web'], volumes: ['named'], bindPaths: [path], state: 'in-sync' },
  ]);
  expect(requests.filter((r) => r.includes('/containers/web/json'))).toHaveLength(1);
  expect(requests.some((r) => r.includes('/archive') || r.includes('/get'))).toBe(false);
  expect(remote.dockerScan).toHaveBeenCalledWith(
    remoteId,
    [path],
    expect.objectContaining({ apiVersion: '1.47' }),
    ['named'],
  );
});

it('refuses a fixed address and keeps data-only available', async () => {
  fixedWeb();
  target.networks![0].subnets = ['172.20.0.0/16'];

  const plan = await run();
  const webItem = item(plan, 'web');
  expect(webItem.blockers).toEqual([
    { code: 'fixed-ipv4-unavailable', message: expect.any(String) },
  ]);
  const message = webItem.blockers[0].message;
  expect(webItem.choices).toEqual(['data-only']);
  expect(webItem.defaultSelected).toBe(false);
  await expect(run({ items: [{ id: 'web', mode: 'container-and-data' }] })).rejects.toThrow(
    message,
  );
  const dataOnly = await run({ items: [{ id: 'web', mode: 'data-only' }] });
  expect(item(dataOnly, 'web').targetAction).toBe('data-only');
  expect(dataOnly.canConnect).toBe(true);
});

it.each(['replace', 'keep-owned', 'keep-compose'])(
  'does not count the same-name VM counterpart when Connect will %s',
  async (action) => {
    fixedWeb();
    const path = join(projectRoot, 'state');
    const before = '2026-09-20T00:00:00.000Z';
    target.volumes = [
      {
        name: 'named',
        driver: 'local',
        labels: { 'dev.devchain.project': projectId, 'com.docker.compose.project': 'app' },
      },
    ];
    target.containers = [
      {
        id: 'vm-web',
        name: 'web',
        labels:
          action === 'keep-compose'
            ? { 'com.docker.compose.project': 'app' }
            : { 'dev.devchain.project': projectId },
        mounts:
          action === 'keep-compose' ? [] : [{ type: 'volume', name: 'named', destination: '/db' }],
        metadata: { created: before, startedAt: before, running: false },
      },
    ];
    target.networks![0].addresses = [
      { address: '172.19.0.200', containerId: 'vm-web', containerName: 'web' },
    ];
    if (action === 'keep-owned') {
      Object.assign(containers[0], {
        Created: before,
        State: { StartedAt: before, Running: false },
      });
      target.paths = [{ path, exists: true }];
      inventory = {
        items: [],
        importedAt: '2026-09-21T00:00:00.000Z',
        groups: [
          {
            volumes: ['named'],
            bindPaths: [path],
            lastSyncedAt: '2026-09-21T00:00:00.000Z',
            lastSyncDirection: 'to-vm',
          },
        ],
      };
    }
    const plan = await run({
      items: [
        {
          id: 'web',
          mode: 'container-and-data',
          dataChoice: action === 'replace' ? 'replace-home' : 'keep-vm',
        },
      ],
    });
    expect(item(plan, 'web').blockers).toEqual([]);
    expect(item(plan, 'web').targetAction).toBe(action === 'replace' ? 'replace' : 'leave-as-is');
    expect(plan.canConnect).toBe(true);

    target.networks![0].addresses!.push({
      address: '172.19.0.200',
      containerId: 'another-id',
      containerName: 'unrelated-holder',
    });
    expect(item(await run(), 'web').blockers).toContainEqual({
      code: 'fixed-ipv4-unavailable',
      message: expect.stringContaining('unrelated-holder'),
    });
  },
);

it.each([false, true])('scans home IPv4 ranges with a fixed address: %s', async (fixed) => {
  fixedWeb();
  if (!fixed) containers[0].NetworkSettings = { Networks: { 'shared-network': {}, bridge: {} } };
  containers[1].NetworkSettings = { Networks: { 'shared-network': {} } };
  const plan = await run();
  expect(item(plan, 'web').networks).toEqual([
    { name: 'shared-network', subnets: ['172.19.0.0/16'] },
  ]);
  expect(requests.filter((path) => path.endsWith('/networks/shared-network'))).toHaveLength(1);
  expect(requests.some((path) => path.endsWith('/networks/bridge'))).toBe(false);
  expect(item(plan, 'web').fixedIPv4).toEqual(
    fixed
      ? [{ network: 'shared-network', address: '172.19.0.200', subnets: ['172.19.0.0/16'] }]
      : undefined,
  );
  expect(item(plan, 'web').blockers).toEqual([]);
  expect(item(plan, 'web').selectedMode).toBe('container-and-data');
  expect(plan.canConnect).toBe(true);
  expect(remote.dockerScan).toHaveBeenCalledWith(
    remoteId,
    [join(projectRoot, 'state')],
    expect.objectContaining({ apiVersion: '1.47' }),
    ['named'],
    fixed ? ['shared-network'] : [],
  );
});

it.each([false, true])(
  'requests networks only on the first path page with a fixed address: %s',
  async (fixed) => {
    fixedWeb();
    if (!fixed) containers[0].NetworkSettings = { Networks: { 'shared-network': {} } };
    (containers[0].Mounts as unknown[]).push(
      ...Array.from({ length: 65 }, (_, index) => ({
        Type: 'bind',
        Source: `/outside/cert-${index}`,
        Destination: `/cert-${index}`,
        RW: false,
      })),
    );
    await run();
    expect(remote.dockerScan.mock.calls).toHaveLength(2);
    expect(remote.dockerScan.mock.calls[0][4]).toEqual(fixed ? ['shared-network'] : []);
    expect(remote.dockerScan.mock.calls[1]).toHaveLength(4);
  },
);

// app.inject is the cheapest layer that proves routing, project lookup and the response together.
it('serves Docker presence for the project through the GET route', async () => {
  await writeFile(join(projectRoot, 'compose.yaml'), 'services: {}');
  const module = await Test.createTestingModule({
    controllers: [DockerPlanController],
    providers: [
      { provide: DockerPlanService, useValue: service },
      { provide: DockerCopyBack, useValue: {} },
    ],
  }).compile();
  const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  try {
    await app.init();
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/docker/presence`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ state: 'present' });
    expect(requests).toEqual([]);
  } finally {
    await app.close();
  }
});
