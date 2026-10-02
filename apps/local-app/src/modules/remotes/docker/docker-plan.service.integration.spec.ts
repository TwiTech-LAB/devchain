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
import type { DockerPlan } from './docker-plan.dto';

const projectId = '11111111-1111-4111-8111-111111111111';
const remoteId = '22222222-2222-4222-8222-222222222222';
const asRoot = process.getuid?.() === 0;

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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'docker-plan-service-'));
  await mkdir(join(root, 'project', 'state'), { recursive: true });
  await writeFile(join(root, 'project', 'state', 'rows'), 'rows!');
  socket = join(root, 'engine.sock');
  requests = [];
  info = { Driver: 'overlay2', DockerRootDir: '/var/lib/docker', SecurityOptions: [] };
  containers = [web(), container('cache')];
  projectRoot = join(root, 'project');
  target = { architecture: 'x86_64', containers: [], volumes: [], paths: [] };
  inventory = null;
  runtime = {
    homePath: root,
    uid: 1000,
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
    if (path === '/containers/json?all=true') return json(containers.map((c) => ({ Id: c.Id })));
    if (path === '/system/df')
      return json({
        Containers: containers.map((c) => ({ Id: c.Id, SizeRw: 17 })),
        Images: [{ Id: 'sha256:image', Size: 100 }],
        Volumes: [{ Name: 'named', UsageData: { Size: 9 } }],
      });
    if (path === '/volumes') return json({ Volumes: [{ Name: 'named', Driver: 'local' }] });
    if (path.startsWith('/containers/'))
      return json(containers.find((c) => path === `/containers/${c.Id}/json`));
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

  source = new DockerPlanSourceService();
  jest.spyOn(source, 'homePath').mockReturnValue(root);
  jest.spyOn(source, 'uid').mockReturnValue(1000);
  jest.spyOn(source, 'compose').mockResolvedValue(null);
  service = new DockerPlanService(
    {
      getProject: async () => ({ id: projectId, rootPath: projectRoot }),
      getRemote: async () => ({ id: remoteId }),
    } as never,
    source,
    remote as never,
    { get: () => inventory } as never,
  );
});
afterEach(async () => {
  if (savedDockerHost === undefined) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = savedDockerHost;
  jest.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await chmod(join(root, 'project'), 0o700).catch(() => undefined);
  await chmod(join(root, 'project', 'locked'), 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

it('plans linked and other containers with negotiated API, fit, estimate and exclusions', async () => {
  const plan = await run();
  expect(plan.availability).toEqual({ available: true, side: null, reason: null });
  expect(plan.apiVersion).toBe('1.47');
  expect(requests.filter((r) => r.includes('/containers/web'))).toEqual([
    '/v1.47/containers/web/json',
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

it('lets the dialog reuse disk usage, folder sizes and copy speeds for two minutes; Connect reads fresh', async () => {
  const measure = jest.spyOn(source, 'measure');
  const exportRate = jest.spyOn(source, 'exportRate');
  const dialog = () => service.plan(projectId, { remoteId }, undefined, { reuse: true });
  const diskUsageReads = () => requests.filter((r) => r.endsWith('/system/df')).length;

  const first = await dialog();
  expect(diskUsageReads()).toBe(1);
  expect(remote.dockerProbe).toHaveBeenCalledTimes(1);
  expect(measure).toHaveBeenCalledTimes(1);

  // The next choice reads the containers again, but none of the measurements.
  containers.push(container('late'));
  const second = await dialog();
  expect(item(second, 'late')).toBeDefined();
  expect(item(second, 'web').mounts).toEqual(item(first, 'web').mounts);
  expect(second.estimate).toEqual(first.estimate);
  expect(diskUsageReads()).toBe(1);
  expect(remote.dockerProbe).toHaveBeenCalledTimes(1);
  expect(exportRate).toHaveBeenCalledTimes(1);
  expect(measure).toHaveBeenCalledTimes(1);

  // Connect measures again before it stops anything.
  await service.plan(projectId, { remoteId }, undefined, { estimate: false });
  expect(diskUsageReads()).toBe(2);
  expect(measure).toHaveBeenCalledTimes(2);

  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + DOCKER_PLAN_REUSE_MS);
  await dialog();
  expect(diskUsageReads()).toBe(3);
  expect(remote.dockerProbe).toHaveBeenCalledTimes(2);
  expect(measure).toHaveBeenCalledTimes(3);
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

it('images the VM already has cost nothing and need no estimate probe for them', async () => {
  remote.dockerImagesPresent.mockResolvedValue({ ids: ['sha256:image'] });
  const plan = await run();
  expect(plan.filesystems.find((f) => f.filesystemId === 'root')?.requiredBytes).toBe(9);
});

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

it('refuses above 100% and warns above 80% per destination filesystem', async () => {
  const capacity = (runtime.docker as { capacity: Record<string, unknown> }).capacity;
  capacity.imageStore = fs('/var/lib/containerd', 'images');
  capacity.dockerRoot = fs('/var/lib/docker', 'root', 5);
  let plan = await run();
  expect(Object.fromEntries(plan.filesystems.map((f) => [f.filesystemId, f.status]))).toEqual({
    images: 'fits',
    root: 'refused',
    home: 'fits',
  });
  expect(plan.fit).toBe('refused');
  expect(plan.canConnect).toBe(false);

  capacity.dockerRoot = fs('/var/lib/docker', 'root', 10);
  plan = await run();
  expect(plan.filesystems.find((f) => f.filesystemId === 'root')?.status).toBe('warning');
  expect(plan.fit).toBe('warning');
  expect(plan.canConnect).toBe(true);
});

it('warns when the VM uid differs from home and the container runs as the home uid', async () => {
  runtime.uid = 2000;
  const plan = await run();
  expect(item(plan, 'web').warnings).toEqual([
    { code: 'home-uid', message: expect.stringContaining('VM uid is 2000') },
  ]);
  runtime.uid = 1000;
  expect(item(await run(), 'web').warnings).toEqual([]);
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
