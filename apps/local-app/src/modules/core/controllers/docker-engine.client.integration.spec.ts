// A local fake Unix engine is the cheapest layer that verifies HTTP streaming/backpressure.
import type { ClientRequest } from 'node:http';
const http = jest.requireActual<typeof import('node:http')>('node:http');
import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import {
  DockerEngineClient,
  DockerEngineError,
  negotiateDockerApi,
  resolveDockerSocket,
  resolveDockerImageStore,
} from './docker-engine.client';
import {
  DockerArchiveHelperError,
  cleanupDockerArchiveHelper,
  createDockerArchiveHelper,
  readDockerArchive,
  writeDockerArchive,
} from './docker-archive';

let server: Server;
let root: string;
let client: DockerEngineClient;
let handler: (req: IncomingMessage, res: ServerResponse) => void;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'docker-client-'));
  server = createServer((req, res) => handler(req, res));
  server.requestTimeout = 0;
  server.listen(join(root, 'engine.sock'));
  await once(server, 'listening');
  client = new DockerEngineClient(join(root, 'engine.sock'));
});
afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

it('resolves environment, context and fallback socket without invoking context unnecessarily', async () => {
  const inspectContext = jest.fn().mockResolvedValue('unix:///run/context.sock');
  expect(
    await resolveDockerSocket({ env: { DOCKER_HOST: 'unix:///run/custom.sock' }, inspectContext }),
  ).toBe('/run/custom.sock');
  expect(inspectContext).not.toHaveBeenCalled();
  expect(await resolveDockerSocket({ env: {}, inspectContext })).toBe('/run/context.sock');
  inspectContext.mockResolvedValue(undefined);
  expect(await resolveDockerSocket({ env: {}, inspectContext })).toBe('/var/run/docker.sock');
});
it.each(['tcp://localhost:2375', 'ssh://host', 'unix://relative', '/var/run/docker.sock'])(
  'refuses endpoint %s',
  async (host) => {
    await expect(resolveDockerSocket({ env: { DOCKER_HOST: host } })).rejects.toBeInstanceOf(
      DockerEngineError,
    );
    await expect(
      resolveDockerSocket({ env: {}, inspectContext: async () => host }),
    ).rejects.toThrow('Docker');
  },
);
it.each(['name=rootless', 'rootless'])('refuses rootless info %s', async (option) => {
  handler = (_req, res) => res.end(JSON.stringify({ SecurityOptions: [option] }));
  await expect(client.info()).rejects.toThrow('Rootless');
});
it('negotiates both version endpoints, pins the smaller maximum and versions later requests', async () => {
  const paths: string[] = [];
  handler = (req, res) => {
    paths.push(req.url!);
    res.end(
      JSON.stringify(
        paths.length === 1
          ? { ApiVersion: '1.56', MinAPIVersion: '1.40' }
          : { ApiVersion: '1.55', MinAPIVersion: '1.41' },
      ),
    );
  };
  const target = new DockerEngineClient(client.socketPath);
  expect(await negotiateDockerApi(client, target)).toBe('1.55');
  await target.diskUsage();
  expect(paths).toEqual(['/version', '/version', '/v1.55/system/df']);
});
it('refuses an empty API interval', async () => {
  let calls = 0;
  handler = (_req, res) =>
    res.end(
      JSON.stringify(
        ++calls === 1
          ? { ApiVersion: '1.56', MinAPIVersion: '1.56' }
          : { ApiVersion: '1.55', MinAPIVersion: '1.40' },
      ),
    );
  await expect(
    negotiateDockerApi(client, new DockerEngineClient(client.socketPath)),
  ).rejects.toMatchObject({ code: 'incompatible-api' });
  expect(client.apiVersion).toBeUndefined();
});
it.each([404, 409, 500])(
  'cleans HTTP %s errors without retaining Env or engine body',
  async (status) => {
    handler = (_req, res) => {
      res.statusCode = status;
      res.end('{"message":"Env SECRET=value request body"}');
    };
    try {
      await client.json('POST', '/containers/create', { Env: ['SECRET=value'] });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(DockerEngineError);
      expect(JSON.stringify(error)).not.toMatch(/SECRET|Env|value|request body/);
      expect(String(error)).not.toMatch(/SECRET|Env|value|request body/);
      expect((error as DockerEngineError).status).toBe(status);
    }
  },
);
it('cancels before headers and during a response body', async () => {
  let received!: () => void;
  handler = (_req, _res) => received();
  const headers = new AbortController();
  const waiting = new Promise<void>((resolve) => {
    received = resolve;
  });
  const result = client.stream('GET', '/hang', { signal: headers.signal });
  await waiting;
  headers.abort();
  await expect(result).rejects.toMatchObject({ code: 'cancelled' });
  handler = (_req, res) => {
    res.writeHead(200);
    res.write('first');
  };
  const body = new AbortController();
  const stream = await client.stream('GET', '/body', { signal: body.signal });
  const consuming = (async () => {
    for await (const chunk of stream) {
      void chunk;
      body.abort();
    }
  })();
  await expect(consuming).rejects.toMatchObject({ code: 'cancelled' });
});
it('has no 300 second header/body timeout, retaining cancellation after both waits', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  let response!: ServerResponse;
  let ready!: () => void;
  const received = new Promise<void>((resolve) => {
    ready = resolve;
  });
  handler = (req, res) => {
    expect(req.socket.timeout ?? 0).toBe(0);
    response = res;
    ready();
  };
  const requestSpy = jest.spyOn(http, 'request');
  const pending = client.stream('GET', '/slow');
  expect(requestSpy).toHaveBeenCalledWith(
    expect.objectContaining({ agent: false, timeout: 0 }),
    expect.any(Function),
  );
  const request = requestSpy.mock.results[0].value as ClientRequest;
  request.on('socket', (socket) => expect(socket.timeout ?? 0).toBe(0));
  await received;
  await jest.advanceTimersByTimeAsync(301_000);
  response.writeHead(200);
  response.write('first');
  const stream = await pending;
  await jest.advanceTimersByTimeAsync(301_000);
  response.end('last');
  let text = '';
  for await (const chunk of stream) text += chunk;
  expect(text).toBe('firstlast');
});
it('streams archive upload with backpressure and preserves GET/PUT archive paths and type', async () => {
  const bytes = 8 * 1024 * 1024;
  let produced = 0;
  let uploaded = 0;
  const upload = new Readable({
    read() {
      if (produced === bytes) this.push(null);
      else {
        produced += 64 * 1024;
        this.push(Buffer.alloc(64 * 1024, 7));
      }
    },
  });
  let release!: () => void;
  const received = new Promise<void>((resolve) => {
    release = resolve;
  });
  let request!: IncomingMessage;
  handler = (req, res) => {
    if (req.method === 'GET') {
      expect(req.url).toBe('/containers/reader/archive?path=/data');
      res.end('tar-with-directory-header');
      return;
    }
    expect(req.url).toBe('/containers/writer/archive?copyUIDGID=true&path=/');
    expect(req.headers['content-type']).toBe('application/x-tar');
    request = req;
    req.pause();
    release();
    req.on('data', (chunk) => {
      uploaded += chunk.length;
    });
    req.on('end', () => res.end());
  };
  const result = writeDockerArchive(client, 'writer', upload);
  await received;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(produced).toBeLessThan(bytes);
  request.resume();
  await result;
  expect(uploaded).toBe(bytes);
  let archive = '';
  for await (const chunk of await readDockerArchive(client, 'reader')) archive += chunk;
  expect(archive).toBe('tar-with-directory-header');
});
it('records only helper-created anonymous IDs and deletes them after helper, never protected volumes', async () => {
  const calls: string[] = [];
  handler = (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === '/volumes')
      return void res.end(
        JSON.stringify({
          Volumes: [{ Name: 'source' }, { Name: 'preexisting' }, { Name: 'imported' }],
        }),
      );
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        expect(JSON.parse(body)).toMatchObject({
          Image: 'service-image',
          HostConfig: {
            AutoRemove: false,
            Mounts: [{ Type: 'volume', Source: 'source', Target: '/data' }],
          },
        });
        res.end('{"Id":"helper"}');
      });
      return;
    }
    if (req.method === 'GET')
      return void res.end(
        JSON.stringify({
          Mounts: [
            { Type: 'volume', Name: 'source', Destination: '/data' },
            { Type: 'volume', Name: 'preexisting', Destination: '/prior' },
            { Type: 'volume', Name: 'imported', Destination: '/import' },
            { Type: 'volume', Name: 'anonymous-exact-id', Destination: '/image-volume' },
          ],
        }),
      );
    res.statusCode = 204;
    res.end();
  };
  const helper = await createDockerArchiveHelper(client, 'service-image', [
    { Type: 'volume', Source: 'source', Target: '/data' },
  ]);
  expect(helper).toEqual({ id: 'helper', ownedVolumeIds: ['anonymous-exact-id'] });
  await cleanupDockerArchiveHelper(client, helper);
  expect(calls).toEqual([
    'GET /volumes',
    'POST /containers/create',
    'GET /containers/helper/json',
    'DELETE /containers/helper',
    'DELETE /volumes/anonymous-exact-id',
  ]);
});
it('reports df sizes and resolves containerd root separately from DockerRootDir', async () => {
  const usage = {
    Volumes: [{ Name: 'db', UsageData: { Size: 12, RefCount: 1 } }],
    Images: [{ Id: 'image', Size: 100, SharedSize: 20 }],
    Containers: [{ Id: 'c', SizeRw: 30 }],
  };
  handler = (req, res) => {
    expect(req.url).toBe('/system/df');
    res.end(JSON.stringify(usage));
  };
  expect(await client.diskUsage()).toEqual(usage);
  const info = {
    Driver: 'overlayfs',
    DriverStatus: [['driver-type', 'io.containerd.snapshotter.v1']],
    DockerRootDir: '/docker',
  };
  expect(
    await resolveDockerImageStore(
      info,
      async () => 'version = 3\nroot = "/custom/containerd"\n[plugins]\nroot = "/other"',
    ),
  ).toBe('/custom/containerd');
  expect(await resolveDockerImageStore(info, async () => '[plugins]\nroot = "/other"')).toBe(
    '/var/lib/containerd',
  );
  expect(await resolveDockerImageStore({ Driver: 'overlay2', DockerRootDir: '/docker' })).toBe(
    '/docker',
  );
  await expect(
    resolveDockerImageStore(info, async () => {
      throw Object.assign(new Error(), { code: 'EACCES' });
    }),
  ).rejects.toThrow('Cannot read');
});

it('retains an inspect-failure ownership record so cleanup can inventory before removing anything', async () => {
  const calls: string[] = [];
  let inspectionFails = true;
  handler = (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === '/volumes') return void res.end('{"Volumes":[{"Name":"source"}]}');
    if (req.method === 'POST') return void res.end('{"Id":"helper"}');
    if (req.method === 'GET') {
      if (inspectionFails) {
        res.statusCode = 500;
        return void res.end('SECRET=hidden');
      }
      return void res.end(
        '{"Mounts":[{"Type":"volume","Name":"source","Destination":"/data"},{"Type":"volume","Name":"owned","Destination":"/other"}]}',
      );
    }
    res.statusCode = 204;
    res.end();
  };
  let failure: DockerArchiveHelperError | undefined;
  try {
    await createDockerArchiveHelper(client, 'image', [
      { Type: 'volume', Source: 'source', Target: '/data' },
    ]);
  } catch (error) {
    expect(error).toBeInstanceOf(DockerArchiveHelperError);
    failure = error as DockerArchiveHelperError;
  }
  expect(failure).toBeDefined();
  expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false);
  expect(JSON.stringify(failure)).not.toContain('SECRET');
  inspectionFails = false;
  await cleanupDockerArchiveHelper(client, failure!.helper);
  expect(calls.slice(-3)).toEqual([
    'GET /containers/helper/json',
    'DELETE /containers/helper',
    'DELETE /volumes/owned',
  ]);
});

it('finishes inventory and exact cleanup when cancelled immediately after create', async () => {
  const controller = new AbortController();
  const deletes: string[] = [];
  handler = (req, res) => {
    if (req.url === '/volumes') return void res.end('{"Volumes":[{"Name":"source"}]}');
    if (req.method === 'POST') {
      controller.abort();
      return void res.end('{"Id":"helper"}');
    }
    if (req.method === 'GET')
      return void res.end('{"Mounts":[{"Type":"volume","Name":"owned","Destination":"/other"}]}');
    deletes.push(req.url!);
    res.statusCode = 204;
    res.end();
  };
  await expect(
    createDockerArchiveHelper(
      client,
      'image',
      [{ Type: 'volume', Source: 'source', Target: '/data' }],
      controller.signal,
    ),
  ).rejects.toMatchObject({ code: 'cancelled' });
  expect(deletes).toEqual(['/containers/helper', '/volumes/owned']);
});

it('refuses missing source volumes before creating a helper', async () => {
  handler = (req, res) => {
    expect(req.url).toBe('/volumes');
    res.end('{"Volumes":[]}');
  };
  await expect(
    createDockerArchiveHelper(client, 'image', [
      { Type: 'volume', Source: 'missing', Target: '/data' },
    ]),
  ).rejects.toMatchObject({ code: 'not-found' });
});

it('cancels an upload and closes its producer', async () => {
  let received!: () => void;
  const receiving = new Promise<void>((resolve) => (received = resolve));
  handler = (req, _res) => {
    req.pause();
    received();
  };
  const body = new Readable({
    read() {
      this.push(Buffer.alloc(64 * 1024));
    },
  });
  const controller = new AbortController();
  const writing = writeDockerArchive(client, 'helper', body, controller.signal);
  await receiving;
  controller.abort();
  await expect(writing).rejects.toMatchObject({ code: 'cancelled' });
  expect(body.destroyed).toBe(true);
});

it('keeps a complete 2xx answer when the engine closes before the upload ends', async () => {
  // The real engine answers an archive PUT at the tar's end marker and closes unread.
  handler = (req, res) => {
    req.once('data', () => {
      res.writeHead(200, { Connection: 'close' });
      res.end('{"done":true}');
      res.once('finish', () => req.socket.destroy());
    });
  };
  const upload = (): Readable =>
    Readable.from(
      (async function* () {
        yield Buffer.alloc(1024);
        await new Promise((resolve) => setTimeout(resolve, 100));
        yield Buffer.alloc(1024);
      })(),
    );
  const response = await client.stream('PUT', '/containers/helper/archive', { body: upload() });
  // Read only after the close has failed the upload pipeline.
  await new Promise((resolve) => setTimeout(resolve, 300));
  let text = '';
  for await (const chunk of response) text += chunk;
  expect(text).toBe('{"done":true}');

  handler = (req, res) => {
    req.once('data', () => {
      res.writeHead(500, { Connection: 'close' });
      res.end();
      res.once('finish', () => req.socket.destroy());
    });
  };
  await expect(writeDockerArchive(client, 'helper', upload())).rejects.toMatchObject({
    code: 'engine-error',
    status: 500,
  });
});

it('maps malformed JSON and producer errors without retaining raw content', async () => {
  handler = (_req, res) => res.end('SECRET=value');
  await expect(client.json('GET', '/info')).rejects.toMatchObject({
    code: 'invalid-response',
    message: 'Invalid Docker JSON response',
  });
  handler = (req, _res) => req.resume();
  const body = new Readable({
    read() {
      this.destroy(new Error('SECRET=value'));
    },
  });
  await expect(writeDockerArchive(client, 'helper', body)).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Docker engine connection failed',
  });
});

it('forces NoCopy on every helper volume mount while leaving bind mount options unchanged', async () => {
  const mounts = [
    { Type: 'volume' as const, Source: 'source', Target: '/etc', ReadOnly: true },
    { Type: 'volume' as const, Source: 'target', Target: '/data' },
    { Type: 'bind' as const, Source: '/fixture', Target: '/bind', ReadOnly: true },
  ];
  let captured: unknown;
  handler = (req, res) => {
    if (req.url === '/volumes')
      return void res.end('{"Volumes":[{"Name":"source"},{"Name":"target"}]}');
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        captured = JSON.parse(body).HostConfig.Mounts;
        res.end('{"Id":"helper"}');
      });
      return;
    }
    res.end('{"Mounts":[]}');
  };
  await createDockerArchiveHelper(client, 'service-image', mounts);
  expect(captured).toEqual([
    { ...mounts[0], VolumeOptions: { NoCopy: true } },
    { ...mounts[1], VolumeOptions: { NoCopy: true } },
    mounts[2],
  ]);
  expect(mounts.every((mount) => !('VolumeOptions' in mount))).toBe(true);
});
