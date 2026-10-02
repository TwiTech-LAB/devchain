import { DockerArchiveJournal } from '../../core/controllers/docker-archive-journal';
// Local Fastify and a fake Unix engine exercise parser, ownership and streaming boundaries without Docker.
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { DockerEngineClient } from '../../core/controllers/docker-engine.client';
import { FakeDockerEngine } from '../../../common/test/fake-docker-engine.server';
import { RemoteHostClient } from '../operations/remote-host.client';
import { HostDockerController } from './host-docker.controller';
import { HostDockerService } from './host-docker.service';
import { HostDockerBodyParser } from './host-docker-body.parser';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { fixtureTls, installFixtureTlsFront } from '../../../common/test/tls-fixture';
import { DOCKER_PROJECT_LABEL as OWNER, COMPOSE_PROJECT_LABEL as COMPOSE } from './host-docker.dto';

const PROJECT = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
type Labels = Record<string, string>;
type Container = {
  Id: string;
  Config: { Labels: Labels };
  Mounts: Array<{ Type: string; Name?: string; Destination?: string }>;
};
let app: NestFastifyApplication;
let server: Server;
let root: string;
let homeFixture: string;
let client: RemoteHostClient;
let volumes: Map<string, Labels>;
let containers: Map<string, Container>;
let networks: Map<string, Labels>;
let calls: string[];
let received: number;
let createBody: Record<string, unknown>;
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
let failLoad = false;
let clearExit = 0;
/** `stream` messages the fake engine answers an image load with. */
let loadMessages: string[];
/** Inspect answers for specific image references; anything else gets the default. */
let imageInspects: Map<string, { Id: string; RootFS?: { Layers: string[] } }>;
const clearHelpers = new Map<string, { source: string; started: boolean }>();
let earlyArchiveAnswer = false;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}
function reply(res: ServerResponse, value: unknown, status = 200) {
  res.statusCode = status;
  res.end(JSON.stringify(value));
}
async function fakeEngine(req: IncomingMessage, res: ServerResponse) {
  calls.push(`${req.method} ${req.url}`);
  const url = new URL(req.url!, 'http://engine');
  const path = decodeURIComponent(url.pathname).replace(/^\/v\d+\.\d+/, '');
  if (path === '/info')
    return reply(res, {
      ID: 'fake-engine',
      Architecture: 'x86_64',
      Driver: 'overlay2',
      DockerRootDir: '/docker',
    });
  if (path === '/version') return reply(res, { ApiVersion: '1.55', MinAPIVersion: '1.40' });
  if (path === '/images/load') {
    received = 0;
    for await (const chunk of req) received += chunk.length;
    if (failLoad) return reply(res, { error: 'Env PRIVATE=fake-sensitive' });
    if (!loadMessages.length) return reply(res, { stream: 'Loaded' });
    return void res.end(
      loadMessages.map((message) => JSON.stringify({ stream: message })).join('\n') + '\n',
    );
  }
  if (path.endsWith('/get')) return void res.end('saved-image');
  if (path.startsWith('/images/')) {
    const inspect = imageInspects.get(path.slice('/images/'.length).replace(/\/json$/, ''));
    if (inspect) return reply(res, inspect);
    return path.includes('missing') ? reply(res, {}, 404) : reply(res, { Id: 'image' });
  }
  if (path === '/volumes' && req.method === 'GET')
    return reply(res, {
      Volumes: [...volumes].map(([Name, Labels]) => ({ Name, Driver: 'local', Labels })),
    });
  if (path === '/volumes/create') {
    const body = await readJson(req);
    volumes.set(body.Name as string, body.Labels as Labels);
    return reply(res, body, 201);
  }
  if (path.startsWith('/volumes/')) {
    const name = path.slice('/volumes/'.length);
    if (!volumes.has(name)) return reply(res, {}, 404);
    if (req.method === 'DELETE') {
      volumes.delete(name);
      res.statusCode = 204;
      return void res.end();
    }
    return reply(res, {
      Name: name,
      Labels: volumes.get(name),
      CreatedAt: '2026-01-01T00:00:00Z',
      Driver: 'local',
      Mountpoint: `/docker/volumes/${name}`,
    });
  }
  if (path === '/networks/create') {
    const body = await readJson(req);
    networks.set(body.Name as string, body.Labels as Labels);
    return reply(res, { Id: body.Name }, 201);
  }
  if (path.startsWith('/networks/')) {
    const id = path.slice('/networks/'.length);
    if (!networks.has(id)) return reply(res, {}, 404);
    if (req.method === 'DELETE') {
      networks.delete(id);
      res.statusCode = 204;
      return void res.end();
    }
    return reply(res, { Id: id, Labels: networks.get(id) });
  }
  if (path === '/containers/create') {
    const body = await readJson(req);
    createBody = body;
    const id = `created-${containers.size}`;
    const host = body.HostConfig as {
      Mounts?: Array<{
        Type: string;
        Source: string;
        Target: string;
        VolumeOptions?: { NoCopy?: boolean };
      }>;
    };
    const mounts = (host.Mounts ?? []).map((mount) => {
      if (mount.Type === 'volume') expect(mount.VolumeOptions?.NoCopy).toBe(true);
      return {
        Type: mount.Type,
        Name: mount.Type === 'volume' ? mount.Source : undefined,
        Destination: mount.Target,
      };
    });
    if (Array.isArray(body.Cmd) && body.Cmd[0] === 'devchain-archive-helper') {
      volumes.set(`owned-${id}`, {});
      mounts.push({ Type: 'volume', Name: `owned-${id}`, Destination: '/image-volume' });
    }
    containers.set(id, {
      Id: id,
      Config: { Labels: (body.Labels as Labels) ?? {} },
      Mounts: mounts,
    });
    if ((body.Entrypoint as string[] | undefined)?.[0] === 'find')
      clearHelpers.set(id, { source: host.Mounts![0].Source, started: false });
    return reply(res, { Id: id }, 201);
  }
  const lifecycle = path.match(/^\/containers\/([^/]+)\/(start|wait)$/);
  if (lifecycle) {
    const clear = clearHelpers.get(lifecycle[1]);
    if (!clear) return reply(res, {}, 404);
    if (lifecycle[2] === 'start') {
      // Stands in for root inside the helper: `find /target -mindepth 1 -delete`.
      clear.started = true;
      for (const entry of await readdir(clear.source))
        await rm(join(clear.source, entry), { recursive: true, force: true });
      res.statusCode = 204;
      return void res.end();
    }
    return reply(res, { StatusCode: clearExit });
  }
  if (path === '/containers/json')
    return reply(
      res,
      [...containers.values()]
        .filter((c) => {
          const volume = JSON.parse(url.searchParams.get('filters') ?? '{}').volume?.[0];
          return !volume || c.Mounts.some((m) => m.Type === 'volume' && m.Name === volume);
        })
        .map((c) => ({
          ...c,
          Names: ['/' + c.Id],
          Labels: c.Config.Labels,
          Env: ['PRIVATE=fake-sensitive'],
          Command: 'secret-command',
        })),
    );
  const match = path.match(/^\/containers\/([^/]+)(?:\/(json|archive))?$/);
  if (match) {
    const [, id, operation] = match;
    if (!containers.has(id)) return reply(res, {}, 404);
    if (operation === 'json') return reply(res, containers.get(id));
    if (operation === 'archive' && req.method === 'GET') return void res.end('archive-data');
    if (operation === 'archive' && req.method === 'PUT') {
      received = 0;
      if (earlyArchiveAnswer) {
        // As the real engine: answer at the tar's end marker, then close unread.
        await once(req, 'data');
        res.writeHead(200, { Connection: 'close' });
        res.end();
        return void res.once('finish', () => req.socket.destroy());
      }
      for await (const chunk of req) received += chunk.length;
      res.statusCode = 200;
      return void res.end();
    }
    if (req.method === 'DELETE') {
      expect(url.searchParams.has('v')).toBe(false);
      containers.delete(id);
      res.statusCode = 204;
      return void res.end();
    }
  }
  reply(res, {}, 404);
}

beforeEach(async () => {
  clearHelpers.clear();
  root = await mkdtemp(join(tmpdir(), 'host-docker-'));
  homeFixture = await mkdtemp(join(homedir(), '.host-docker-test-'));
  volumes = new Map<string, Labels>([
    ['imported', { [OWNER]: PROJECT, [COMPOSE]: 'app' }],
    ['unlabelled', {}],
  ]);
  containers = new Map();
  networks = new Map();
  calls = [];
  received = 0;
  failLoad = false;
  loadMessages = [];
  imageInspects = new Map();
  handler = fakeEngine;
  server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  server.listen(join(root, 'docker.sock'));
  await once(server, 'listening');
  jest
    .spyOn(DockerEngineClient, 'connect')
    .mockImplementation(async () => new DockerEngineClient(join(root, 'docker.sock')));
  const module = await Test.createTestingModule({
    controllers: [HostDockerController],
    providers: [
      HostDockerService,
      HostDockerBodyParser,
      { provide: DockerArchiveJournal, useValue: new DockerArchiveJournal(root) },
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
        id: 'remote',
        name: 'remote',
        baseUrl,
        tlsCertificate: fixtureTls.cert,
      }),
    } as never,
    { get: async () => null, headers: async () => ({}) } as never,
  );
});
afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  await app?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
  await rm(homeFixture, { recursive: true, force: true });
});

it('covers image presence/save, project volume/network/create routes, holders and all delete kinds', async () => {
  expect(await client.dockerImagesPresent('remote', ['present', 'missing'])).toEqual({
    ids: ['present'],
  });
  let saved = '';
  for await (const chunk of await client.dockerSaveImage('remote', 'present')) saved += chunk;
  expect(saved).toBe('saved-image');
  const volume = await client.dockerCreateVolume('remote', {
    projectId: PROJECT,
    name: 'new',
    labels: { original: 'kept' },
  });
  expect(volume.Labels).toEqual({ original: 'kept', [OWNER]: PROJECT });
  await client.dockerCreateNetwork('remote', {
    projectId: PROJECT,
    name: 'net',
    labels: {},
    internal: false,
    attachable: true,
    options: {},
  });
  const container = await client.dockerCreateContainer('remote', {
    projectId: PROJECT,
    name: 'service',
    config: { Image: 'image', Env: ['PRIVATE=fake-sensitive'], HostConfig: { NetworkMode: 'net' } },
  });
  expect(Array.isArray(createBody.Env)).toBe(true);
  expect(JSON.stringify(createBody.Env) === JSON.stringify(['PRIVATE=fake-sensitive'])).toBe(true);
  expect(calls.some((call) => call.includes('/start'))).toBe(false);
  containers.get(container.Id)!.Mounts.push({ Type: 'volume', Name: 'new' });
  expect(
    (await client.dockerVolumeHolders('remote', 'new')).holders.map((holder) => holder.id),
  ).toEqual([container.Id]);
  await client.dockerDelete('remote', 'containers', container.Id, PROJECT);
  await client.dockerDelete('remote', 'volumes', 'new', PROJECT);
  await client.dockerDelete('remote', 'networks', 'net', PROJECT);
  expect(containers.size).toBe(0);
  expect(volumes.has('new')).toBe(false);
  expect(networks.size).toBe(0);
});

it('refuses unlabelled same-name volume creation and all unowned deletion kinds', async () => {
  await expect(
    client.dockerCreateVolume('remote', { projectId: PROJECT, name: 'unlabelled', labels: {} }),
  ).rejects.toMatchObject({ status: 409 });
  networks.set('unlabelled', {});
  containers.set('unlabelled', { Id: 'unlabelled', Config: { Labels: {} }, Mounts: [] });
  for (const kind of ['volumes', 'containers', 'networks'] as const)
    await expect(client.dockerDelete('remote', kind, 'unlabelled', PROJECT)).rejects.toMatchObject({
      status: 403,
    });
  expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false);
});

it.each([
  'valid',
  'missing-compose',
  'wrong-compose',
  'wrong-project',
  'unrelated-mount',
  'other-owner',
  'volume-missing-compose',
  'volume-missing-owner',
  'no-mount',
])('checks Compose holder deletion evidence: %s', async (scenario) => {
  const labels: Labels =
    scenario === 'missing-compose'
      ? {}
      : { [COMPOSE]: scenario === 'wrong-compose' ? 'other' : 'app' };
  if (scenario === 'other-owner') labels[OWNER] = OTHER;
  if (scenario === 'wrong-project') volumes.set('imported', { [OWNER]: OTHER, [COMPOSE]: 'app' });
  if (scenario === 'volume-missing-compose') volumes.set('imported', { [OWNER]: PROJECT });
  if (scenario === 'volume-missing-owner') volumes.set('imported', { [COMPOSE]: 'app' });
  containers.set('holder', {
    Id: 'holder',
    Config: { Labels: labels },
    Mounts: [{ Type: 'volume', Name: scenario === 'unrelated-mount' ? 'unlabelled' : 'imported' }],
  });
  if (scenario === 'no-mount') containers.get('holder')!.Mounts = [];
  if (scenario === 'valid') await client.dockerDelete('remote', 'containers', 'holder', PROJECT);
  else
    await expect(
      client.dockerDelete('remote', 'containers', 'holder', PROJECT),
    ).rejects.toMatchObject({ status: 403 });
  expect(containers.has('holder')).toBe(scenario !== 'valid');
});

it('hashes the whole upload when the engine answers an archive PUT before the body ends', async () => {
  earlyArchiveAnswer = true;
  const chunks = [Buffer.alloc(65536, 1), Buffer.alloc(65536, 2), Buffer.alloc(4096, 3)];
  const body = Readable.from(
    (async function* () {
      yield chunks[0];
      yield chunks[1];
      await new Promise((resolve) => setTimeout(resolve, 300));
      yield chunks[2];
    })(),
  );
  try {
    const written = await client.dockerWriteArchive(
      'remote',
      { projectId: PROJECT, image: 'image', mountType: 'volume', source: 'imported' },
      body,
    );
    expect(written).toEqual({
      sha256: createHash('sha256').update(Buffer.concat(chunks)).digest('hex'),
      bytes: 65536 * 2 + 4096,
    });
    expect(containers.size).toBe(0);
  } finally {
    earlyArchiveAnswer = false;
  }
});
it('streams images, archives and probe past the JSON body limit, cleaning helper-owned volumes only', async () => {
  const size = 8 * 1024 * 1024;
  const stream = () =>
    Readable.from(
      (function* () {
        for (let i = 0; i < size / 65536; i++) yield Buffer.alloc(65536);
      })(),
    );
  await client.dockerLoadImage('remote', stream());
  expect(received).toBe(size);
  const archive = {
    projectId: PROJECT,
    image: 'image',
    mountType: 'volume' as const,
    source: 'imported',
  };
  const written = await client.dockerWriteArchive('remote', archive, stream());
  expect(received).toBe(size);
  expect(written).toEqual({
    sha256: createHash('sha256').update(Buffer.alloc(size)).digest('hex'),
    bytes: size,
  });
  let downloaded = '';
  const read = await client.dockerReadArchive('remote', archive);
  expect(read.sha256()).toBeNull();
  for await (const chunk of read.archive) downloaded += chunk;
  expect(downloaded).toBe('archive-data');
  // The VM's digest arrives as a trailer once the stream ended.
  expect(read.sha256()).toBe(createHash('sha256').update('archive-data').digest('hex'));
  expect([...volumes.keys()].sort()).toEqual(['imported', 'unlabelled']);
  expect(containers.size).toBe(0);
  const before = calls.length;
  await client.dockerProbe('remote', stream());
  expect(calls.length).toBe(before);
});

it('allows existing binds under home and rejects outside paths and symlink escapes', async () => {
  await mkdir(join(homeFixture, 'data'));
  await symlink(root, join(homeFixture, 'escape'));
  const input = {
    projectId: PROJECT,
    image: 'image',
    mountType: 'bind' as const,
    source: join(homeFixture, 'data'),
  };
  await client.dockerWriteArchive('remote', input, Readable.from('tar'));
  for (const source of [root, join(homeFixture, 'escape')])
    await expect(
      client.dockerWriteArchive('remote', { ...input, source }, Readable.from('tar')),
    ).rejects.toMatchObject({ status: 403 });
});

it('prepares bind destinations under home, emptying only replaced subtrees', async () => {
  const kept = join(homeFixture, 'kept');
  const replaced = join(homeFixture, 'project', 'state');
  await mkdir(kept);
  await writeFile(join(kept, 'file'), 'kept');
  await mkdir(replaced, { recursive: true });
  await writeFile(join(replaced, 'vm-only'), 'stale');
  await client.dockerPrepareBinds('remote', {
    projectId: PROJECT,
    paths: [
      { path: kept, replace: false },
      { path: replaced, replace: true, image: 'image' },
      { path: join(homeFixture, 'new', 'nested'), replace: false },
    ],
  });
  expect(existsSync(join(kept, 'file'))).toBe(true);
  expect(existsSync(replaced)).toBe(true);
  expect(existsSync(join(replaced, 'vm-only'))).toBe(false);
  expect(existsSync(join(homeFixture, 'new', 'nested'))).toBe(true);
  // The clear helper ran the owning item's image on the checked folder and is gone.
  expect([...clearHelpers.values()]).toEqual([{ source: replaced, started: true }]);
  expect(createBody).toMatchObject({ Image: 'image', Entrypoint: ['find'], User: '0:0' });
  expect(containers.size).toBe(0);

  await symlink(root, join(homeFixture, 'escape'));
  for (const path of [
    root,
    homedir(),
    join(homeFixture, 'escape'),
    join(homeFixture, 'escape', 'x'),
  ])
    await expect(
      client.dockerPrepareBinds('remote', {
        projectId: PROJECT,
        paths: [{ path, replace: true, image: 'image' }],
      }),
    ).rejects.toMatchObject({ status: 403 });
  expect(existsSync(root)).toBe(true);
});

it('clears only a non-empty replaced folder, needs its image, and fails cleanly on a helper exit code', async () => {
  const empty = join(homeFixture, 'empty');
  await mkdir(empty);
  await client.dockerPrepareBinds('remote', {
    projectId: PROJECT,
    paths: [
      { path: empty, replace: true, image: 'image' },
      { path: join(homeFixture, 'absent'), replace: true, image: 'image' },
    ],
  });
  expect(clearHelpers.size).toBe(0);
  expect(existsSync(join(homeFixture, 'absent'))).toBe(true);

  await expect(
    client.dockerPrepareBinds('remote', {
      projectId: PROJECT,
      paths: [{ path: empty, replace: true }],
    }),
  ).rejects.toMatchObject({ status: 400 });

  const full = join(homeFixture, 'full');
  await mkdir(full);
  await writeFile(join(full, 'vm-only'), 'stale');
  clearExit = 1;
  try {
    await expect(
      client.dockerPrepareBinds('remote', {
        projectId: PROJECT,
        paths: [{ path: full, replace: true, image: 'distroless' }],
      }),
    ).rejects.toMatchObject({ status: 422 });
  } finally {
    clearExit = 0;
  }
  expect(containers.size).toBe(0);
});

it('prepares only the folder of a single file and moves the file through that folder', async () => {
  const folder = join(homeFixture, 'project', 'dev-https');
  const file = join(folder, 'Caddy file');
  // A folder an earlier version made of the file is left to the restore to replace.
  await mkdir(file, { recursive: true });
  await client.dockerPrepareBinds('remote', {
    projectId: PROJECT,
    paths: [
      { path: file, replace: true, image: 'image', file: true },
      { path: join(homeFixture, 'new', 'app.conf'), replace: false, file: true },
    ],
  });
  expect(clearHelpers.size).toBe(0);
  expect(existsSync(join(homeFixture, 'new'))).toBe(true);
  expect(existsSync(join(homeFixture, 'new', 'app.conf'))).toBe(false);

  const input = { projectId: PROJECT, image: 'image', mountType: 'file' as const, source: file };
  calls = [];
  await client.dockerWriteArchive('remote', input, Readable.from('tar'));
  expect(createBody.HostConfig).toMatchObject({
    Mounts: [{ Type: 'bind', Source: folder, Target: '/data' }],
  });
  expect(calls).toContainEqual(
    expect.stringMatching(/^PUT \S*\/containers\/[^/]+\/archive\?copyUIDGID=true&path=\/data$/),
  );

  calls = [];
  const { archive } = await client.dockerReadArchive('remote', input);
  for await (const chunk of archive) void chunk;
  expect(createBody.HostConfig).toMatchObject({
    Mounts: [{ Type: 'bind', Source: folder, Target: '/data', ReadOnly: true }],
  });
  expect(calls).toContainEqual(
    expect.stringMatching(/^GET \S*\/containers\/[^/]+\/archive\?path=\/data\/Caddy%20file$/),
  );
  // The folder must exist; the file itself need not.
  await expect(
    client.dockerWriteArchive(
      'remote',
      { ...input, source: join(homeFixture, 'absent', 'app.conf') },
      Readable.from('tar'),
    ),
  ).rejects.toMatchObject({ status: 403 });
});

it('stops only running project containers, and stops a holder before deleting it', async () => {
  containers.set('mine', { Id: 'mine', Config: { Labels: { [OWNER]: PROJECT } }, Mounts: [] });
  containers.set('theirs', { Id: 'theirs', Config: { Labels: { [OWNER]: OTHER } }, Mounts: [] });
  const running = new Set(['mine', 'theirs']);
  handler = async (req, res) => {
    const path = new URL(req.url!, 'http://engine').pathname.replace(/^\/v\d+\.\d+/, '');
    const stop = path.match(/^\/containers\/([^/]+)\/stop$/);
    if (stop) {
      calls.push(`POST ${path}`);
      res.statusCode = running.delete(stop[1]) ? 204 : 304;
      return void res.end();
    }
    if (path === '/containers/json' && !req.url!.includes('all=true')) {
      const filters = JSON.parse(new URL(req.url!, 'http://engine').searchParams.get('filters')!);
      expect(filters.label).toEqual([`${OWNER}=${PROJECT}`]);
      return reply(
        res,
        [...containers.values()]
          .filter((c) => running.has(c.Id) && c.Config.Labels[OWNER] === PROJECT)
          .map((c) => ({ Id: c.Id, Labels: c.Config.Labels })),
      );
    }
    return fakeEngine(req, res);
  };
  expect(await client.dockerStopProject('remote', PROJECT)).toEqual({ stopped: ['mine'] });
  expect(running).toEqual(new Set(['theirs']));
  calls = [];
  await client.dockerDelete('remote', 'containers', 'mine', PROJECT);
  const stopAt = calls.findIndex((c) => c.endsWith('/containers/mine/stop'));
  expect(stopAt).toBeGreaterThanOrEqual(0);
  expect(
    calls.findIndex((c) => c.startsWith('DELETE') && c.endsWith('/containers/mine')),
  ).toBeGreaterThan(stopAt);
});

it('cleans image-load errors inside HTTP 200 streams without echoing Env', async () => {
  failLoad = true;
  try {
    await client.dockerLoadImage('remote', Readable.from('tar'));
    throw new Error('expected failure');
  } catch (error) {
    expect((error as { status: number }).status).toBe(502);
    expect(JSON.stringify(error).includes('fake-sensitive')).toBe(false);
    expect(String(error).includes('PRIVATE')).toBe(false);
  }
});

it('answers 200 with the ID and layers of each loaded image, tagged or untagged', async () => {
  imageInspects.set('repo/img:v1', {
    Id: 'sha256:tagged',
    RootFS: { Layers: ['sha256:a', 'sha256:b'] },
  });
  imageInspects.set('sha256:plain', { Id: 'sha256:plain', RootFS: { Layers: [] } });
  loadMessages = ['Loaded image: repo/img:v1\n', 'Loaded image ID: sha256:plain\n'];
  const response = await app.inject({
    method: 'POST',
    url: '/api/host/docker/images/load',
    headers: { 'content-type': 'application/x-tar' },
    payload: 'tar',
  });
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({
    images: [
      { id: 'sha256:tagged', layers: ['sha256:a', 'sha256:b'] },
      { id: 'sha256:plain', layers: [] },
    ],
  });
  await expect(client.dockerLoadImage('remote', Readable.from('tar'))).resolves.toEqual({
    images: [
      { id: 'sha256:tagged', layers: ['sha256:a', 'sha256:b'] },
      { id: 'sha256:plain', layers: [] },
    ],
  });
});

it('reports a loaded image once and skips references the engine no longer has', async () => {
  imageInspects.set('repo/img:v1', { Id: 'sha256:same', RootFS: { Layers: ['sha256:a'] } });
  imageInspects.set('repo/img:v2', { Id: 'sha256:same', RootFS: { Layers: ['sha256:a'] } });
  loadMessages = [
    'Loaded image: repo/img:v1\n',
    'Loaded image: repo/img:v2\n',
    'Loaded image ID: sha256:missing\n',
  ];
  await expect(client.dockerLoadImage('remote', Readable.from('tar'))).resolves.toEqual({
    images: [{ id: 'sha256:same', layers: ['sha256:a'] }],
  });
});

it('rejects a load answer that does not match the result schema', async () => {
  imageInspects.set('sha256:broken', {
    Id: 'sha256:broken',
    RootFS: { Layers: 42 as unknown as string[] },
  });
  loadMessages = ['Loaded image ID: sha256:broken\n'];
  await expect(client.dockerLoadImage('remote', Readable.from('tar'))).rejects.toMatchObject({
    message: 'Docker host request failed',
    details: { hostCode: 'invalid-response' },
  });
});

/** Saves an image through the currently mocked engine socket and returns its archive text. */
async function savedArchive(name: string): Promise<string> {
  const saver = await DockerEngineClient.connect();
  const stream = await saver.stream('GET', `/images/get?names=${encodeURIComponent(name)}`);
  let archive = '';
  for await (const chunk of stream) archive += chunk.toString('utf8');
  return archive;
}

it('keeps the archive ID and layers through a classic-store save and load', async () => {
  const source = new FakeDockerEngine('classic-source');
  const target = new FakeDockerEngine('classic-target');
  await source.listen(join(root, 'source.sock'));
  await target.listen(join(root, 'target.sock'));
  const connect = jest.spyOn(DockerEngineClient, 'connect');
  source.images.set('sha256:cfg', {
    architecture: 'amd64',
    tags: ['app:1'],
    size: 4,
    layers: ['sha256:l1', 'sha256:l2'],
  });
  try {
    connect.mockImplementation(async () => new DockerEngineClient(join(root, 'source.sock')));
    const archive = await savedArchive('app:1');
    connect.mockImplementation(async () => new DockerEngineClient(join(root, 'target.sock')));
    await expect(client.dockerLoadImage('remote', Readable.from(archive))).resolves.toEqual({
      images: [{ id: 'sha256:cfg', layers: ['sha256:l1', 'sha256:l2'] }],
    });
    expect(target.images.get('sha256:cfg')).toMatchObject({ tags: ['app:1'] });
  } finally {
    await source.close();
    await target.close();
  }
});

it('answers the derived image ID a containerd-store engine assigned on load', async () => {
  const source = new FakeDockerEngine('containerd-source');
  const target = new FakeDockerEngine('containerd-target', { imageStore: 'containerd' });
  await source.listen(join(root, 'source.sock'));
  await target.listen(join(root, 'target.sock'));
  const connect = jest.spyOn(DockerEngineClient, 'connect');
  source.images.set('sha256:cfg', {
    architecture: 'amd64',
    tags: [],
    size: 4,
    layers: ['sha256:l1'],
  });
  try {
    connect.mockImplementation(async () => new DockerEngineClient(join(root, 'source.sock')));
    const archive = await savedArchive('sha256:cfg');
    connect.mockImplementation(async () => new DockerEngineClient(join(root, 'target.sock')));
    const loaded = await client.dockerLoadImage('remote', Readable.from(archive));
    const derived = 'sha256:' + createHash('sha256').update('manifest:sha256:cfg').digest('hex');
    expect(derived).not.toBe('sha256:cfg');
    expect(loaded).toEqual({ images: [{ id: derived, layers: ['sha256:l1'] }] });
    expect(target.images.has(derived)).toBe(true);
    expect(target.images.has('sha256:cfg')).toBe(false);
  } finally {
    await source.close();
    await target.close();
  }
});

it('refuses a container create whose image the engine never registered', async () => {
  const engine = new FakeDockerEngine('strict-target');
  await engine.listen(join(root, 'strict.sock'));
  jest
    .spyOn(DockerEngineClient, 'connect')
    .mockImplementation(async () => new DockerEngineClient(join(root, 'strict.sock')));
  try {
    engine.images.set('sha256:known', { architecture: 'amd64', tags: [], size: 1 });
    await expect(
      client.dockerCreateContainer('remote', {
        projectId: PROJECT,
        name: 'unknown-image',
        config: { Image: 'sha256:unknown' },
      }),
    ).rejects.toMatchObject({ status: 404 });
  } finally {
    await engine.close();
  }
});

it('streams more than 1 GiB through the route without a size cap or whole-body buffering', async () => {
  const total = 1024 * 1024 * 1024 + 1;
  const block = Buffer.alloc(256 * 1024);
  let produced = 0;
  let maximumAhead = 0;
  const body = new Readable({
    read() {
      if (produced === total) return void this.push(null);
      const size = Math.min(block.length, total - produced);
      produced += size;
      maximumAhead = Math.max(maximumAhead, produced - received);
      this.push(block.subarray(0, size));
    },
  });
  await client.dockerLoadImage('remote', body);
  expect(received).toBe(total);
  expect(maximumAhead).toBeLessThan(32 * 1024 * 1024);
}, 30_000);

it('reports the target API range and pins subsequent calls, refusing versions outside its interval', async () => {
  expect(await client.dockerVersion('remote')).toEqual({
    ApiVersion: '1.55',
    MinAPIVersion: '1.40',
  });
  const before = calls.length;
  await client.dockerCreateVolume(
    'remote',
    { projectId: PROJECT, name: 'pinned', labels: {} },
    { apiVersion: '1.50' },
  );
  expect(calls.slice(before)).toEqual(
    expect.arrayContaining([
      'GET /version',
      'GET /v1.50/volumes/pinned',
      'POST /v1.50/volumes/create',
    ]),
  );
  await expect(
    client.dockerImagesPresent('remote', ['image'], { apiVersion: '1.39' }),
  ).rejects.toMatchObject({ status: 400 });
});

it('lists unrelated holders and rejects malformed target API metadata without leaking engine values', async () => {
  containers.set('unrelated', {
    Id: 'unrelated',
    Config: { Labels: {} },
    Mounts: [{ Type: 'volume', Name: 'imported' }],
  });
  expect(
    (await client.dockerVolumeHolders('remote', 'imported')).holders.map((holder) => holder.id),
  ).toEqual(['unrelated']);
  handler = async (_req, res) =>
    reply(res, { ApiVersion: 'PRIVATE=fake-sensitive', MinAPIVersion: '1.40' });
  try {
    await client.dockerVersion('remote');
    throw new Error('expected failure');
  } catch (error) {
    expect((error as { status: number }).status).toBe(502);
    expect(String(error).includes('fake-sensitive')).toBe(false);
  }
});

it('exposes bounded destination capacity through the LAN client', async () => {
  const result = await client.dockerCapacity('remote', [
    homeFixture,
    join(homeFixture, 'missing', 'destination'),
  ]);
  expect(result.paths).toHaveLength(2);
  expect(result.paths[0]).toMatchObject({
    path: homeFixture,
    filesystemId: expect.any(String),
    freeBytes: expect.any(Number),
  });
  expect(result.paths[1]).toMatchObject({
    filesystemId: (result.paths[0] as { filesystemId: string }).filesystemId,
  });
  await expect(client.dockerCapacity('remote', ['/outside'])).rejects.toMatchObject({
    status: 403,
  });
  await expect(client.dockerCapacity('remote', Array(65).fill('/x'))).rejects.toMatchObject({
    status: 400,
  });
});

it('projects scan metadata and checks outside-home existence with a pinned API', async () => {
  containers.set('scanned', {
    Id: 'scanned',
    Config: { Labels: { [COMPOSE]: 'app' } },
    Mounts: [{ Type: 'volume', Name: 'data', Destination: '/data' }],
  });
  const result = await client.dockerScan('remote', ['/etc/hosts', join(root, 'missing')], {
    apiVersion: '1.42',
  });
  expect(result.architecture).toBe('x86_64');
  expect(result.paths).toEqual([
    { path: '/etc/hosts', exists: true, file: true },
    { path: join(root, 'missing'), exists: false },
  ]);
  expect(result.containers).toEqual([
    {
      id: 'scanned',
      name: 'scanned',
      labels: { [COMPOSE]: 'app' },
      mounts: [{ type: 'volume', name: 'data', destination: '/data' }],
    },
  ]);
  for (const container of result.containers) {
    expect(Object.keys(container).sort()).toEqual(['id', 'labels', 'mounts', 'name']);
    expect(container.name).not.toMatch(/^\//);
  }
  for (const volume of result.volumes)
    expect(Object.keys(volume).sort()).toEqual(['driver', 'labels', 'name']);
  expect(JSON.stringify(result).includes('fake-sensitive')).toBe(false);
  expect(calls).toContain('GET /v1.42/containers/json?all=true');
});
it.each([['relative'], ['/etc/../etc/hosts'], ['/etc//hosts'], Array(65).fill('/x')])(
  'refuses invalid scan path list %#',
  async (...paths) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/host/docker/scan',
      payload: { paths },
    });
    expect(response.statusCode).toBe(400);
  },
);
it('returns a cleaned scan failure when the engine is unreachable', async () => {
  const spy = jest
    .spyOn(DockerEngineClient, 'connect')
    .mockRejectedValue(new Error('Env PRIVATE=fake-sensitive'));
  await expect(client.dockerScan('remote', [])).rejects.toMatchObject({
    message: 'Docker host request failed',
    status: 502,
  });
  spy.mockRestore();
});
