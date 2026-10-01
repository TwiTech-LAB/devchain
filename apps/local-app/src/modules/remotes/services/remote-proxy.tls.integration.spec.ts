import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { WebSocket, WebSocketServer } from 'ws';
import { NotFoundError } from '../../../common/errors/error-types';
import { fixtureTls, otherTls } from '../../../common/test/tls-fixture';
import { certificateFingerprint } from '../../../common/tls/certificate';
import type { Remote } from '../../storage/models/domain.models';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { RemoteApiKeyService } from '../auth/remote-api-key.service';
import { REMOTE_HEALTH_PORT } from '../ports/remote-health.port';
import { RemoteProxyService } from './remote-proxy.service';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

jest.mock('../../../common/app-version', () => ({ getAppVersion: () => '1.2.3' }));

type Pair = { key: string; cert: string };

interface Vm {
  url: string;
  /** TLS handshakes the VM completed. */
  handshakes: () => number;
  close: () => Promise<void>;
}

/**
 * A VM that answers HTTP with its name and the Authorization it got, closes
 * every connection after one answer, and greets each WebSocket the same way.
 */
async function startVm(name: string, tls: Pair): Promise<Vm> {
  let handshakes = 0;
  const server: HttpsServer = createHttpsServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ vm: name, path: req.url, authorization: req.headers.authorization }));
  });
  server.on('secureConnection', () => (handshakes += 1));
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    socket.send(JSON.stringify({ vm: name, authorization: req.headers.authorization }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    handshakes: () => handshakes,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

interface Impostor {
  url: string;
  /** Every decrypted byte a client sent after a completed handshake. */
  received: () => Buffer;
  close: () => Promise<void>;
}

/** A TLS server with a certificate no remote pins, recording what it decrypts. */
async function startImpostor(): Promise<Impostor> {
  const chunks: Buffer[] = [];
  const server: TlsServer = createTlsServer(
    { key: otherTls.key, cert: otherTls.cert },
    (socket) => {
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('error', () => undefined);
    },
  );
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received: () => Buffer.concat(chunks),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function remoteRow(id: string, baseUrl: string, certificate: string | null): Remote {
  return {
    id,
    name: id,
    baseUrl,
    kind: 'address',
    vmProviderConnectionId: null,
    vmIdentity: null,
    vmSpec: null,
    tlsCertificate: certificate,
    tlsFingerprint: certificate ? certificateFingerprint(certificate) : null,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  };
}

/** The first message a WebSocket through the proxy gets, or the error that ends it. */
function firstWsMessage(url: string): Promise<{ vm: string; authorization?: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('message', (data) => {
      socket.close();
      resolve(JSON.parse(data.toString()));
    });
    socket.once('error', reject);
    socket.once('close', (code) => reject(new Error(`closed ${code} before a message`)));
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('RemoteProxyService pinned TLS', () => {
  const remotes = new Map<string, Remote>();
  const keys = new Map<string, string>();
  let vmA: Vm;
  let vmB: Vm;
  let impostor: Impostor;
  let home: NestFastifyApplication;
  let homeUrl: string;

  beforeAll(async () => {
    vmA = await startVm('a', fixtureTls);
    vmB = await startVm('b', otherTls);
    impostor = await startImpostor();

    const storage = {
      getRemote: jest.fn(async (id: string) => {
        const remote = remotes.get(id);
        if (!remote) throw new NotFoundError('Remote', id);
        return remote;
      }),
    };
    const apiKeys = new RemoteApiKeyService({
      readRemoteApiKey: async (id: string) => keys.get(id) ?? null,
      saveRemoteApiKey: async (id: string, value: string) => void keys.set(id, value),
    } as never);
    const health = {
      getState: jest.fn(() => ({
        online: true,
        version: '1.2.3',
        versionMatches: true,
        stats: null,
        lastSeenAt: '2026-09-22T00:00:00.000Z',
        error: null,
      })),
    };

    @Module({
      providers: [
        { provide: RemoteApiKeyService, useValue: apiKeys },
        RemoteProxyService,
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: REMOTE_HEALTH_PORT, useValue: health },
      ],
    })
    class HomeModule {}

    home = await NestFactory.create<NestFastifyApplication>(HomeModule, new FastifyAdapter(), {
      logger: false,
    });
    await home.listen(0, '127.0.0.1');
    homeUrl = `http://127.0.0.1:${(home.getHttpServer().address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    remotes.clear();
    keys.clear();
  });

  afterAll(async () => {
    await home?.close();
    await Promise.all([vmA?.close(), vmB?.close(), impostor?.close()]);
  });

  const add = (id: string, baseUrl: string, certificate: string | null, key = `key-${id}`) => {
    remotes.set(id, remoteRow(id, baseUrl, certificate));
    keys.set(id, key);
  };

  it('proxies HTTP to a VM whose certificate matches the pin, reached by IP', async () => {
    add('lab', vmA.url, fixtureTls.cert);
    const response = await fetch(`${homeUrl}/r/lab/api/runtime?x=1`, {
      headers: { authorization: 'Bearer from-browser' },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      vm: 'a',
      path: '/api/runtime?x=1',
      authorization: 'Bearer key-lab',
    });
  });

  it('proxies a WebSocket over wss to a VM whose certificate matches the pin', async () => {
    add('lab', vmA.url, fixtureTls.cert);
    await expect(firstWsMessage(`${homeUrl.replace('http', 'ws')}/r/lab/ws`)).resolves.toEqual({
      vm: 'a',
      authorization: 'Bearer key-lab',
    });
  });

  it('answers HTTP with an error and sends no byte to a VM with another certificate', async () => {
    add('lab', impostor.url, fixtureTls.cert);
    const response = await fetch(`${homeUrl}/r/lab/api/host/provider-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'secret-body' }),
    });
    expect(response.status).toBeGreaterThanOrEqual(500);
    await settle();
    expect(impostor.received().length).toBe(0);
  });

  it('fails a WebSocket and sends no byte to a VM with another certificate', async () => {
    add('lab', impostor.url, fixtureTls.cert);
    await expect(firstWsMessage(`${homeUrl.replace('http', 'ws')}/r/lab/ws`)).rejects.toThrow();
    await settle();
    expect(impostor.received().length).toBe(0);
  });

  it('refuses a remote without a stored certificate before connecting', async () => {
    add('lab', vmA.url, null);
    const before = vmA.handshakes();
    const response = await fetch(`${homeUrl}/r/lab/api/runtime`);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'REMOTE_TLS_CERTIFICATE_MISSING',
      remoteId: 'lab',
    });
    expect(vmA.handshakes()).toBe(before);
  });

  it('serves two remotes with different certificates at once, each pinned to its own', async () => {
    add('a', vmA.url, fixtureTls.cert);
    add('b', vmB.url, otherTls.cert);
    const [a, b, wsA, wsB] = await Promise.all([
      fetch(`${homeUrl}/r/a/api/runtime`).then((r) => r.json()),
      fetch(`${homeUrl}/r/b/api/runtime`).then((r) => r.json()),
      firstWsMessage(`${homeUrl.replace('http', 'ws')}/r/a/ws`),
      firstWsMessage(`${homeUrl.replace('http', 'ws')}/r/b/ws`),
    ]);
    expect([a.vm, b.vm, wsA.vm, wsB.vm]).toEqual(['a', 'b', 'a', 'b']);
    expect([a.authorization, b.authorization]).toEqual(['Bearer key-a', 'Bearer key-b']);

    // Each pin refuses the other VM's certificate.
    add('a', vmB.url, fixtureTls.cert);
    add('b', vmA.url, otherTls.cert);
    const [swappedA, swappedB] = await Promise.all([
      fetch(`${homeUrl}/r/a/api/runtime`),
      fetch(`${homeUrl}/r/b/api/runtime`),
    ]);
    expect(swappedA.status).toBeGreaterThanOrEqual(500);
    expect(swappedB.status).toBeGreaterThanOrEqual(500);
    await expect(firstWsMessage(`${homeUrl.replace('http', 'ws')}/r/a/ws`)).rejects.toThrow();
    await expect(firstWsMessage(`${homeUrl.replace('http', 'ws')}/r/b/ws`)).rejects.toThrow();
  });

  it('uses a changed stored certificate for the next connection', async () => {
    add('lab', vmA.url, fixtureTls.cert);
    expect((await fetch(`${homeUrl}/r/lab/api/runtime`)).status).toBe(200);

    add('lab', vmA.url, otherTls.cert);
    expect((await fetch(`${homeUrl}/r/lab/api/runtime`)).status).toBeGreaterThanOrEqual(500);
    await expect(firstWsMessage(`${homeUrl.replace('http', 'ws')}/r/lab/ws`)).rejects.toThrow();

    add('lab', vmA.url, fixtureTls.cert);
    expect((await fetch(`${homeUrl}/r/lab/api/runtime`)).status).toBe(200);
    await expect(
      firstWsMessage(`${homeUrl.replace('http', 'ws')}/r/lab/ws`),
    ).resolves.toMatchObject({ vm: 'a' });
  });
});
