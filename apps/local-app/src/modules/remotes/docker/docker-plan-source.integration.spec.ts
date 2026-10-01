// A fake Unix engine exercises the real client, inspect projection and local size walk without Docker.
import { Test } from '@nestjs/testing';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerEngineClient } from '../../core/controllers/docker-engine.client';
import { DockerPlanSourceService } from './docker-plan-source.service';
import { measureDockerBind } from './docker-plan-files';

let root: string;
let server: Server;
let client: DockerEngineClient;
let source: DockerPlanSourceService;
let containers: Array<Record<string, unknown>>;
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
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'docker-plan-'));
  await mkdir(join(root, 'project'));
  await writeFile(join(root, 'project', 'data'), 'abc');
  containers = [];
  const module = await Test.createTestingModule({ providers: [DockerPlanSourceService] }).compile();
  source = module.get(DockerPlanSourceService);
  jest.spyOn(source, 'homePath').mockReturnValue(root);
  jest.spyOn(source, 'uid').mockReturnValue(1000);
  jest.spyOn(source, 'compose').mockResolvedValue(null);
  server = createServer((req, res) => {
    const path = req.url ?? '';
    if (path === '/containers/json?all=true')
      return res.end(JSON.stringify(containers.map((c) => ({ Id: c.Id }))));
    if (path === '/system/df')
      return res.end(
        JSON.stringify({
          Containers: containers.map((c) => ({ Id: c.Id, SizeRw: 17 })),
          Images: [{ Id: 'image', Size: 100 }],
          Volumes: [
            { Name: 'named', UsageData: { Size: 9 } },
            { Name: 'anonymous', UsageData: { Size: 5 } },
          ],
        }),
      );
    if (path === '/volumes')
      return res.end(
        JSON.stringify({
          Volumes: [
            { Name: 'named', Driver: 'local' },
            { Name: 'anonymous', Driver: 'local' },
          ],
        }),
      );
    if (path.startsWith('/containers/'))
      return res.end(JSON.stringify(containers.find((c) => path === `/containers/${c.Id}/json`)));
    if (path === '/images/image/json' || path === '/images/present/json')
      return res.end(JSON.stringify({ Id: 'image', Architecture: 'amd64' }));
    res.statusCode = 404;
    res.end('{}');
  });
  server.listen(join(root, 'engine.sock'));
  await once(server, 'listening');
  client = new DockerEngineClient(join(root, 'engine.sock'));
});
afterEach(async () => {
  jest.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(root, { recursive: true, force: true });
});
it('scans each mount class, linked vs other containers, writer groups, SizeRw and uid without leaking settings', async () => {
  const bind = (Source: string, RW = true) => ({ Type: 'bind', Source, Destination: '/data', RW });
  containers = [
    container(
      'linked',
      [
        bind(join(root, 'project')),
        bind(join(root, 'else')),
        bind('/etc/cert', false),
        bind('/srv/db'),
        { Type: 'volume', Name: 'named', Source: '/docker/named', Destination: '/db', RW: true },
        {
          Type: 'volume',
          Name: 'anonymous',
          Source: '/docker/anonymous',
          Destination: '/anon',
          RW: true,
        },
      ],
      { Binds: ['named:/db'] },
    ),
    container('other', [{ Type: 'volume', Name: 'named', Destination: '/db', RW: true }], {
      Binds: ['named:/db'],
    }),
  ];
  const result = await source.scan(client, join(root, 'project'));
  expect(result.items[0].mounts.map((m) => m.kind)).toEqual([
    'project-bind',
    'home-bind',
    'readonly-external-bind',
    'external-bind',
    'named-volume',
    'anonymous-volume',
  ]);
  expect(result.items[0].linkedReasons).toContain(`bind:${join(root, 'project')}`);
  expect(result.items[1].linkedReasons).toEqual([]);
  expect(result.items[0].writerGroup).toEqual(['linked', 'other']);
  expect(result.items[0].writableLayer).toEqual({ bytes: 17, unknown: false });
  expect(result.items[0].warnings).toEqual([{ code: 'home-uid', message: expect.any(String) }]);
  expect(JSON.stringify(result)).not.toContain('must-never-escape');
});
it.each(['com.docker.compose.project.working_dir', 'com.docker.compose.project.config_files'])(
  'links from %s only at directory boundaries',
  async (label) => {
    containers = [
      container('linked', [], {}, { Labels: { [label]: join(root, 'project', 'compose.yaml') } }),
      container(
        'other',
        [],
        {},
        { Labels: { [label]: join(root, 'project-other', 'compose.yaml') } },
      ),
    ];
    const result = await source.scan(client, join(root, 'project'));
    expect(result.items[0].linkedReasons).toEqual([label]);
    expect(result.items[1].linkedReasons).toEqual([]);
  },
);
it.each([
  { Devices: [{ PathOnHost: '/dev/a' }] },
  { Privileged: true },
  { DeviceRequests: [{ Count: -1 }] },
  { NetworkMode: 'host' },
  { NetworkMode: 'container:other' },
  { PidMode: 'host' },
  { IpcMode: 'host' },
  { UsernsMode: 'host' },
  { Runtime: 'custom' },
  { CgroupParent: 'custom' },
  { SecurityOpt: ['custom'] },
  { Links: ['other'] },
  { Binds: ['/var/run/docker.sock:/socket'] },
])('classifies runtime-bound settings (%#)', async (host) => {
  containers = [container('c', [], host)];
  const result = await source.scan(client, join(root, 'project'));
  expect(result.items[0].blockers[0].code).toBe('runtime-bound');
});
it('marks an unsupported setting on one container as cannot-move instead of failing the scan', async () => {
  containers = [
    container('ok', []),
    container('odd', [], { VolumesFrom: ['secret-volume-reference'] }),
  ];
  const result = await source.scan(client, join(root, 'project'));
  expect(result.items.find((i) => i.id === 'ok')!.blockers).toEqual([]);
  expect(result.items.find((i) => i.id === 'odd')!.blockers).toEqual([
    {
      code: 'runtime-bound',
      message: expect.stringMatching(/^odd: unsupported setting .+VolumesFrom$/),
    },
  ]);
  expect(JSON.stringify(result)).not.toContain('secret-volume-reference');
});
it('never measures external read-only binds such as a host root mount', async () => {
  const measure = jest.spyOn(source, 'measure').mockResolvedValue({ bytes: 5, unknown: false });
  containers = [
    container('host', [
      { Type: 'bind', Source: '/', Destination: '/rootfs', RW: false },
      { Type: 'bind', Source: '/var/lib/docker', Destination: '/docker', RW: false },
    ]),
  ];
  const result = await source.scan(client, join(root, 'project'));
  expect(measure).not.toHaveBeenCalled();
  expect(result.items[0].mounts.map((m) => m.size)).toEqual([
    { bytes: 0, unknown: true },
    { bytes: 0, unknown: true },
  ]);
});
it('groups only writers of copied data: shared volumes and project or home folders', async () => {
  // External binds are never measured into a writer relation; skip the size walk of `/`.
  jest.spyOn(source, 'measure').mockResolvedValue({ bytes: 0, unknown: false });
  const bind = (Source: string, RW = true, Destination = '/data') => ({
    Type: 'bind',
    Source,
    Destination,
    RW,
  });
  const named = { Type: 'volume', Name: 'named', Destination: '/db', RW: true };
  const pg = join(root, 'project', 'pg');
  containers = [
    container('db', [bind(pg), bind('/etc/localtime', false, '/etc/localtime'), named], {
      Binds: ['named:/db'],
    }),
    container('clock', [bind('/etc/localtime', false, '/etc/localtime')]),
    container('host', [bind('/', false, '/host')]),
    container('volume-writer', [named], { Binds: ['named:/db'] }),
    container('folder-writer', [bind(join(pg, 'sub'))]),
    container('folder-reader', [bind(pg, false)]),
    container('reader-a', [bind(join(root, 'shared'), false)]),
    container('reader-b', [bind(join(root, 'shared'), false)]),
  ];
  const groups = Object.fromEntries(
    (await source.scan(client, join(root, 'project'))).items.map((i) => [i.id, i.writerGroup]),
  );
  expect(groups.db).toEqual(['db', 'folder-reader', 'folder-writer', 'volume-writer']);
  expect(groups.clock).toEqual(['clock']);
  expect(groups.host).toEqual(['host']);
  expect(groups['reader-a']).toEqual(['reader-a']);
  expect(groups['reader-b']).toEqual(['reader-b']);
});

it('marks unknown settings as cannot-move on that container only, with no secret values', async () => {
  containers = [container('c', [], { FutureSetting: 'never-log-this-value' })];
  const result = await source.scan(client, join(root, 'project'));
  expect(result.items[0].blockers).toEqual([
    { code: 'runtime-bound', message: 'c: unsupported setting HostConfig.FutureSetting' },
  ]);
  expect(JSON.stringify(result)).not.toContain('never-log-this-value');
});
it('identifies temporary containers without recreatable settings', async () => {
  containers = [container('c', [], { AutoRemove: true })];
  const result = await source.scan(client, join(root, 'project'));
  expect(result.items[0]).toMatchObject({
    temporary: true,
    blockers: [],
    notes: expect.arrayContaining([expect.stringContaining('only its named volumes move')]),
  });
});
it('down Compose projects contribute existing volumes/present images and disclose build services', async () => {
  jest.mocked(source.compose).mockResolvedValue({
    name: 'project',
    services: { web: { image: 'present' }, worker: { build: '.' } },
    volumes: { data: { name: 'named' }, absent: {} },
  });
  const result = await source.scan(client, join(root, 'project'));
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    kind: 'compose-project',
    images: [{ id: 'image' }],
    mounts: [{ source: 'named' }],
    notes: expect.arrayContaining([expect.stringContaining('agent builds them on the VM')]),
  });
});
it('walks files without following symlinks and retains partial sizes on missing paths', async () => {
  await symlink('/etc', join(root, 'project', 'outside'));
  expect(await measureDockerBind(join(root, 'project'))).toEqual({ bytes: 3, unknown: false });
  expect(await measureDockerBind(join(root, 'missing'))).toEqual({ bytes: 0, unknown: true });
});
