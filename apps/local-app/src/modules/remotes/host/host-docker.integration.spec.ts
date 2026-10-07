import { DockerArchiveJournal } from '../../core/controllers/docker-archive-journal';
// Local Fastify and a fake Unix engine exercise parser, ownership and streaming boundaries without Docker.
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { Readable, getDefaultHighWaterMark } from 'node:stream';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { DockerEngineClient } from '../../core/controllers/docker-engine.client';
import { dockerImageMetadata } from '../../core/controllers/docker-image-metadata';
import fixtures from '../../core/controllers/__fixtures__/docker-image-inspect.json';
import { FakeDockerEngine } from '../../../common/test/fake-docker-engine.server';
import { RemoteHostClient } from '../operations/remote-host.client';
import { HostDockerController } from './host-docker.controller';
import { HostDockerService } from './host-docker.service';
import { HOST_IPV4_ROUTES } from './host-ipv4-routes';
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
  State?: { Running: boolean };
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
let networkInspects: Map<string, Record<string, unknown>>;
let calls: string[];
let received: number;
let createBody: Record<string, unknown>;
let networkCreateBody: Record<string, unknown>;
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
let failLoad = false;
let clearExit = 0;
/** `stream` messages the fake engine answers an image load with. */
let loadMessages: string[];
/** Inspect answers for specific image references; anything else gets the default. */
let imageInspects: Map<
  string,
  { Id: string; RootFS?: { Layers: string[] }; [key: string]: unknown }
>;
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
  if (path === '/networks' && req.method === 'GET')
    return reply(
      res,
      [...networks.keys()].map((Name) => ({ Name, IPAM: networkInspects.get(Name)?.IPAM })),
    );
  if (path === '/networks/create') {
    const body = await readJson(req);
    networkCreateBody = body;
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
    return reply(res, { Id: id, Labels: networks.get(id), ...networkInspects.get(id) });
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
  const stopping = path.match(/^\/containers\/([^/]+)\/stop$/);
  if (stopping && req.method === 'POST') {
    const holder = containers.get(stopping[1]);
    if (!holder) return reply(res, {}, 404);
    holder.State = { Running: false };
    res.statusCode = 204;
    return void res.end();
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
  networkInspects = new Map();
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
      { provide: HOST_IPV4_ROUTES, useValue: async () => [] },
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

it('keeps privileged settings through the VM container create route', async () => {
  await client.dockerCreateContainer('remote', {
    projectId: PROJECT,
    name: 'privileged-service',
    config: { Image: 'image', HostConfig: { Privileged: true } },
  });
  expect(createBody).toMatchObject({
    Image: 'image',
    HostConfig: { Privileged: true },
    Labels: { [OWNER]: PROJECT },
  });
  expect(calls.some((call) => call.includes('/start'))).toBe(false);
});

it('reports image metadata by encoded reference at the negotiated version and omits missing refs', async () => {
  const refs = [
    'registry.example:5000/app/db:latest',
    'registry.example/app/db@sha256:abc',
    '[2001:db8::1]:5000/app/db:latest',
  ];
  for (const ref of refs) imageInspects.set(ref, fixtures.containerd.inspect);
  const expected = {
    images: refs.map((ref) => ({
      ref,
      id: fixtures.containerd.inspect.Id,
      metadata: dockerImageMetadata(fixtures.containerd.inspect),
    })),
  };
  // Undefined inspect fields are omitted by JSON on the wire.
  expect(
    await client.dockerMatchImages('remote', [...refs, 'missing:latest'], { apiVersion: '1.47' }),
  ).toEqual(JSON.parse(JSON.stringify(expected)));
  expect(calls).toContain(`GET /v1.47/images/${encodeURIComponent(refs[0])}/json`);
  expect(calls).toContain(`GET /v1.47/images/${encodeURIComponent(refs[1])}/json`);
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

it('passes IPv4 IPAM through the network route and reuses an existing network unchanged', async () => {
  const ipam = {
    Config: [{ Subnet: '172.19.0.0/16', Gateway: '172.19.0.1', IPRange: '172.19.0.128/25' }],
  };
  const network = {
    projectId: PROJECT,
    name: 'fixed-network',
    labels: {},
    internal: false,
    attachable: false,
    options: {},
    shared: true as const,
    ipam,
  };
  await expect(client.dockerCreateNetwork('remote', network)).resolves.toMatchObject({
    created: true,
  });
  expect(networkCreateBody).toMatchObject({ IPAM: ipam, Labels: {} });
  await expect(
    client.dockerCreateNetwork('remote', {
      ...network,
      ipam: { Config: [{ Subnet: '10.0.0.0/24', Gateway: '10.0.0.1' }] },
    }),
  ).resolves.toMatchObject({ created: false });
  expect(calls.filter((call) => call.endsWith('/networks/create'))).toHaveLength(1);
  expect(networkCreateBody.IPAM).toEqual(ipam);
});

it.each([{ Config: [{ Subnet: '172.19.0.0/16', FutureSetting: true }] }])(
  'refuses an unsupported IPAM shape before reaching Docker',
  async (ipam) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/host/docker/networks',
      payload: { projectId: PROJECT, name: 'fixed-network', ipam },
    });
    expect(response.statusCode).toBe(400);
    expect(calls).toEqual([]);
  },
);

it('lets every project reuse a shared network and creates a missing one with no owner', async () => {
  const network = { labels: {}, internal: false, attachable: false, options: {} };
  networks.set('shared-network', { [OWNER]: OTHER });
  await expect(
    client.dockerCreateNetwork('remote', {
      ...network,
      projectId: PROJECT,
      name: 'shared-network',
      shared: true,
    }),
  ).resolves.toMatchObject({ created: false });
  // Without `shared`, another project's network stays refused, and the error says why.
  await expect(
    client.dockerCreateNetwork('remote', {
      ...network,
      projectId: PROJECT,
      name: 'shared-network',
    }),
  ).rejects.toMatchObject({
    status: 409,
    message:
      'Docker host request failed (HTTP 409): Docker resource is not owned by this imported project',
  });

  await client.dockerCreateNetwork('remote', {
    ...network,
    projectId: PROJECT,
    name: 'tools',
    shared: true,
  });
  expect(networks.get('tools')).toEqual({});
  await expect(client.dockerDelete('remote', 'networks', 'tools', PROJECT)).rejects.toMatchObject({
    status: 403,
  });
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

// Real routes plus the LAN client prove optional-root validation and VM mutation authorization.
it.each(['remove', 'stop'] as const)(
  '%s authorizes only project-root Compose labels when imported volumes lack Compose labels',
  async (action) => {
    volumes.set('imported', { [OWNER]: PROJECT });
    const scenarios = [
      { name: 'inside', path: homeFixture, root: homeFixture, allowed: true },
      {
        name: 'config-inside',
        config: `/etc/other.yml,${homeFixture}/compose.yml`,
        root: homeFixture,
        allowed: true,
      },
      { name: 'outside', path: `${homeFixture}-other`, root: homeFixture, allowed: false },
      { name: 'absent-root', path: homeFixture, allowed: false },
      { name: 'other-owner', path: homeFixture, root: homeFixture, owner: OTHER, allowed: false },
      { name: 'missing-paths', root: homeFixture, allowed: false },
    ];
    for (const scenario of scenarios) {
      containers.set(scenario.name, {
        Id: scenario.name,
        Config: {
          Labels: {
            [COMPOSE]: 'app',
            ...(scenario.path ? { [`${COMPOSE}.working_dir`]: scenario.path } : {}),
            ...(scenario.config ? { [`${COMPOSE}.config_files`]: scenario.config } : {}),
            ...(scenario.owner ? { [OWNER]: scenario.owner } : {}),
          },
        },
        State: { Running: true },
        Mounts: [],
      });
      const request =
        action === 'remove'
          ? client.dockerDelete('remote', 'containers', scenario.name, PROJECT, {
              projectRoot: scenario.root,
            })
          : client.dockerStopContainer('remote', scenario.name, PROJECT, {
              projectRoot: scenario.root,
            });
      if (scenario.allowed) await request;
      else await expect(request).rejects.toMatchObject({ status: 403 });
      expect(containers.has(scenario.name)).toBe(action !== 'remove' || !scenario.allowed);
      if (containers.has(scenario.name))
        expect(containers.get(scenario.name)!.State!.Running).toBe(!scenario.allowed);
    }
  },
);

it.each(['remove', 'stop'] as const)(
  '%s refuses invalid project roots with HTTP 400 before an engine mutation',
  async (action) => {
    containers.set('holder', {
      Id: 'holder',
      Config: { Labels: { [OWNER]: PROJECT } },
      State: { Running: true },
      Mounts: [],
    });
    for (const projectRoot of [
      'relative/project',
      '/',
      homedir(),
      '/tmp/outside-vm-home',
      `${homeFixture}/../project`,
    ]) {
      const request =
        action === 'remove'
          ? client.dockerDelete('remote', 'containers', 'holder', PROJECT, { projectRoot })
          : client.dockerStopContainer('remote', 'holder', PROJECT, { projectRoot });
      await expect(request).rejects.toMatchObject({ status: 400 });
      expect(containers.get('holder')!.State!.Running).toBe(true);
    }
    expect(calls.some((call) => call.startsWith('DELETE ') || call.startsWith('POST '))).toBe(
      false,
    );
  },
);

it('hashes the whole upload when the engine answers an archive PUT before the body ends', async () => {
  earlyArchiveAnswer = true;
  const chunks = [Buffer.alloc(65536, 1), Buffer.alloc(65536, 2), Buffer.alloc(4096, 3)];
  let engineUploadClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    engineUploadClosed = resolve;
  });
  const stream = DockerEngineClient.prototype.stream;
  jest.spyOn(DockerEngineClient.prototype, 'stream').mockImplementation(function (
    this: DockerEngineClient,
    method,
    path,
    options = {},
  ) {
    if (
      this.socketPath === join(root, 'docker.sock') &&
      method === 'PUT' &&
      path.includes('/archive')
    ) {
      (options.body as Readable).once('close', engineUploadClosed);
    }
    return stream.call(this, method, path, options);
  });
  const body = Readable.from(
    (async function* () {
      yield chunks[0];
      yield chunks[1];
      await closed;
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

it('loads an image when the engine answers before the upload ends', async () => {
  let engineClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    engineClosed = resolve;
  });
  handler = async (req, res) => {
    if (!req.url!.includes('/images/load')) return fakeEngine(req, res);
    // As the real engine: answer at the tar's end marker, then close before the request ends.
    await once(req, 'data');
    res.writeHead(200, { Connection: 'close' });
    res.end(JSON.stringify({ stream: 'Loaded image: repo/img:v1\n' }) + '\n');
    res.once('finish', () => {
      req.socket.destroy();
      engineClosed();
    });
  };
  imageInspects.set('repo/img:v1', { Id: 'sha256:loaded', RootFS: { Layers: ['sha256:a'] } });
  const body = Readable.from(
    (async function* () {
      yield Buffer.alloc(65536, 1);
      await closed;
      yield Buffer.alloc(4096, 2);
    })(),
  );

  await expect(client.dockerLoadImage('remote', body)).resolves.toEqual({
    images: [{ id: 'sha256:loaded', layers: ['sha256:a'], references: ['repo/img:v1'] }],
  });
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
  const chunk = Buffer.alloc(2 * getDefaultHighWaterMark(false));
  expect(await app.get(HostDockerService).writeArchive(archive, Readable.from(chunk))).toEqual({
    sha256: createHash('sha256').update(chunk).digest('hex'),
    bytes: chunk.length,
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
    expect.stringMatching(/^PUT \S*\/containers\/[^/]+\/archive\?copyUIDGID=false&path=\/data$/),
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
      { id: 'sha256:tagged', layers: ['sha256:a', 'sha256:b'], references: ['repo/img:v1'] },
      { id: 'sha256:plain', layers: [], references: ['sha256:plain'] },
    ],
  });
  await expect(client.dockerLoadImage('remote', Readable.from('tar'))).resolves.toEqual({
    images: [
      { id: 'sha256:tagged', layers: ['sha256:a', 'sha256:b'], references: ['repo/img:v1'] },
      { id: 'sha256:plain', layers: [], references: ['sha256:plain'] },
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
    images: [
      { id: 'sha256:same', layers: ['sha256:a'], references: ['repo/img:v1', 'repo/img:v2'] },
    ],
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
      images: [{ id: 'sha256:cfg', layers: ['sha256:l1', 'sha256:l2'], references: ['app:1'] }],
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
    expect(loaded).toEqual({
      images: [{ id: derived, layers: ['sha256:l1'], references: [derived] }],
    });
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

it('streams 64 MiB through the route above its body limit without whole-body buffering', async () => {
  const total = 64 * 1024 * 1024;
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
it('refuses an invalid scan path list through HTTP', async () => {
  const paths = ['relative'];
  const response = await app.inject({
    method: 'POST',
    url: '/api/host/docker/scan',
    payload: { paths },
  });
  expect(response.statusCode).toBe(400);
});
it('scans all IPv4 ranges and only the requested networks used addresses through the LAN route', async () => {
  networks.set('shared-network', {});
  networks.set('automatic-network', {});
  networkInspects.set('shared-network', {
    IPAM: { Config: [{ Subnet: '172.19.0.0/16' }, { Subnet: 'fd00::/64' }] },
    Containers: {
      holder: { Name: '/other-project', IPv4Address: '172.19.0.200/16', IPv6Address: 'fd00::3/64' },
      empty: { Name: 'stopped', IPv4Address: '' },
    },
    Env: ['PRIVATE=must-not-appear'],
  });
  networkInspects.set('automatic-network', {
    IPAM: { Config: [{ Subnet: '10.0.0.0/24' }] },
  });
  const result = await client.dockerScan(
    'remote',
    [],
    { apiVersion: '1.42' },
    [],
    ['shared-network'],
  );
  expect(result.networks).toEqual([
    {
      name: 'shared-network',
      subnets: ['172.19.0.0/16'],
      addresses: [
        { address: '172.19.0.200', containerId: 'holder', containerName: 'other-project' },
      ],
    },
    { name: 'automatic-network', subnets: ['10.0.0.0/24'] },
  ]);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(calls).toContain('GET /v1.42/networks');
  expect(calls).toContain('GET /v1.42/networks/shared-network');
  expect(calls).not.toContain('GET /v1.42/networks/automatic-network');

  calls = [];
  expect((await client.dockerScan('remote', [])).networks).toBeUndefined();
  expect(calls.some((call) => call.includes('/networks'))).toBe(false);
});

it('returns a cleaned scan failure when the engine is unreachable', async () => {
  const spy = jest
    .spyOn(DockerEngineClient, 'connect')
    .mockRejectedValue(new Error('Env PRIVATE=fake-sensitive'));
  const failure = client.dockerScan('remote', []);
  await expect(failure).rejects.toMatchObject({
    message: 'Docker host request failed (HTTP 502): Docker host operation failed',
    status: 502,
  });
  await expect(failure).rejects.not.toMatchObject({ message: expect.stringContaining('PRIVATE') });
  spy.mockRestore();
});
