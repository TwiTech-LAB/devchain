import { RemoteApiKeyService } from '../auth/remote-api-key.service';
// A local HTTP peer verifies the actual LAN transport's deadlines, backpressure and abort lifecycle.
import type { Server, ServerResponse, ClientRequest } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { RemoteHostClient } from './remote-host.client';
import { fixtureTls } from '../../../common/test/tls-fixture';
const https = jest.requireActual<typeof import('node:https')>('node:https');
let server: Server;
let client: RemoteHostClient;
let apiKeys: RemoteApiKeyService;
beforeEach(async () => {
  server = createServer({ key: fixtureTls.key, cert: fixtureTls.cert });
  server.requestTimeout = 0;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let key = 'first';
  apiKeys = new RemoteApiKeyService({
    readRemoteApiKey: async () => key,
    saveRemoteApiKey: async (_id: string, value: string) => {
      key = value;
    },
  } as never);
  client = new RemoteHostClient(
    {
      getRemote: async () => ({
        id: 'remote',
        name: 'remote',
        baseUrl,
        tlsCertificate: fixtureTls.cert,
      }),
    } as never,
    apiKeys,
  );
});
afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it('retains a LAN download past 300 seconds before headers and between body chunks', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  const spy = jest.spyOn(https, 'request');
  let response!: ServerResponse;
  const received = new Promise<void>((resolve) =>
    server.once('request', (_req, res) => {
      response = res;
      resolve();
    }),
  );
  const downloading = client.dockerSaveImage('remote', 'sha256:abc');
  await received;
  expect(spy).toHaveBeenCalledWith(
    expect.objectContaining({ timeout: 0, agent: false }),
    expect.any(Function),
  );
  expect((spy.mock.results[0].value as ClientRequest).socket?.timeout ?? 0).toBe(0);
  await jest.advanceTimersByTimeAsync(301_000);
  response.write('first');
  const stream = await downloading;
  await jest.advanceTimersByTimeAsync(301_000);
  response.end('last');
  let output = '';
  for await (const chunk of stream) output += chunk;
  expect(output).toBe('firstlast');
});

it('aborts a LAN request while awaiting headers without leaking the abort reason', async () => {
  const controller = new AbortController();
  const received = new Promise<void>((resolve) => server.once('request', () => resolve()));
  const pending = client.dockerSaveImage('remote', 'image', { signal: controller.signal });
  await received;
  controller.abort('PRIVATE=fake-sensitive');
  await expect(pending).rejects.toMatchObject({
    message: 'Docker host request failed',
    details: { hostCode: 'cancelled' },
  });
});

it('aborts a LAN response body and an upload producer with bounded backpressure', async () => {
  server.once('request', (_req, res) => res.write('header'));
  const controller = new AbortController();
  const stream = await client.dockerSaveImage('remote', 'image', { signal: controller.signal });
  const reading = (async () => {
    for await (const chunk of stream) {
      void chunk;
      controller.abort();
    }
  })();
  await expect(reading).rejects.toMatchObject({ code: 'cancelled' });
  const uploadAbort = new AbortController();
  let produced = 0;
  const body = new Readable({
    read() {
      produced += 65536;
      this.push(Buffer.alloc(65536));
    },
  });
  const received = new Promise<void>((resolve) =>
    server.once('request', (req) => {
      req.pause();
      resolve();
    }),
  );
  const uploading = client.dockerProbe('remote', body, { signal: uploadAbort.signal });
  await received;
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(produced).toBeLessThan(16 * 1024 * 1024);
  uploadAbort.abort();
  await expect(uploading).rejects.toMatchObject({ details: { hostCode: 'cancelled' } });
  expect(body.destroyed).toBe(true);
});

it('authenticates Docker JSON and archive streaming with each saved key', async () => {
  const seen: Array<string | undefined> = [];
  server.on('request', (req, res) => {
    seen.push(req.headers.authorization);
    if (req.url?.includes('archive')) res.end('archive-bytes');
    else {
      res.setHeader('content-type', 'application/json');
      res.end('[]');
    }
  });
  for (const key of ['first', 'replacement']) {
    await apiKeys.save('remote', key);
    await client.dockerImagesPresent('remote', ['image']);
    const stream = await client.dockerSaveImage('remote', 'image');
    let body = '';
    for await (const chunk of stream) body += chunk;
    expect(body).toBe('archive-bytes');
    expect(seen.slice(-2)).toEqual([`Bearer ${key}`, `Bearer ${key}`]);
  }
});
