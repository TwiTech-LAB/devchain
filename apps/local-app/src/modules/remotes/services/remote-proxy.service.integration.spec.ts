import { RemoteApiKeyService } from '../auth/remote-api-key.service';
import { Body, Controller, Get, Headers, Module, Post, Query } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'socket.io';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { NotFoundError } from '../../../common/errors/error-types';
import type { Remote } from '../../storage/models/domain.models';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { REMOTE_HEALTH_PORT, type RemoteHealthState } from '../ports/remote-health.port';
import { RemoteProxyService } from './remote-proxy.service';
import { fixtureTls, installFixtureTlsFront } from '../../../common/test/tls-fixture';
import { certificateFingerprint } from '../../../common/tls/certificate';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

jest.mock('../../../common/app-version', () => ({ getAppVersion: () => '1.2.3' }));

const REMOTE_ID = '8f5b1c2e-1d3a-4c5b-9e7f-0a1b2c3d4e5f';

@Controller('api')
class UpstreamController {
  @Get('runtime')
  runtime(@Query() query: Record<string, string>) {
    return { version: '1.2.3', side: 'upstream', query };
  }

  @Get('auth')
  auth(@Headers() headers: Record<string, string>) {
    return { authorization: headers.authorization };
  }

  @Post('echo')
  echo(@Body() body: unknown) {
    return { received: body };
  }
}

@WebSocketGateway()
class UpstreamGateway implements OnGatewayConnection {
  handleConnection(client: Socket) {
    client.emit('message', { topic: 'hello', payload: { side: 'upstream' } });
    client.emit('auth', {
      authorization: client.handshake.headers.authorization,
      cookie: client.handshake.headers.cookie,
    });
  }
}

@Module({ controllers: [UpstreamController], providers: [UpstreamGateway] })
class UpstreamModule {}

@WebSocketGateway()
class HomeGateway implements OnGatewayConnection {
  handleConnection(client: Socket) {
    client.emit('message', { topic: 'hello', payload: { side: 'home' } });
  }
}

async function listen(app: NestFastifyApplication): Promise<string> {
  app.useWebSocketAdapter(new IoAdapter(app));
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** The VM: TLS with the fixture certificate, reached by the proxy over https. */
async function listenAsVm(app: NestFastifyApplication): Promise<string> {
  installFixtureTlsFront(app);
  return (await listen(app)).replace(/^http:/, 'https:');
}

function firstMessage(baseUrl: string, path: string): Promise<{ topic: string; payload: unknown }> {
  return new Promise((resolve, reject) => {
    const socket: ClientSocket = io(baseUrl, {
      path,
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    socket.on('message', (envelope) => {
      socket.close();
      resolve(envelope);
    });
    socket.on('connect_error', (error) => {
      socket.close();
      reject(error);
    });
  });
}

describe('RemoteProxyService integration', () => {
  let upstream: NestFastifyApplication;
  let home: NestFastifyApplication;
  let homeUrl: string;
  let remote: Remote;
  let health: RemoteHealthState;
  let apiKeys: RemoteApiKeyService;

  beforeAll(async () => {
    upstream = await NestFactory.create<NestFastifyApplication>(
      UpstreamModule,
      new FastifyAdapter(),
      { logger: false },
    );
    const upstreamUrl = await listenAsVm(upstream);

    remote = {
      id: REMOTE_ID,
      name: 'lab-vm',
      baseUrl: upstreamUrl,
      kind: 'address',
      vmProviderConnectionId: null,
      vmIdentity: null,
      vmSpec: null,
      tlsCertificate: fixtureTls.cert,
      tlsFingerprint: certificateFingerprint(fixtureTls.cert),
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
    };

    const storage = {
      getRemote: jest.fn(async (id: string) => {
        if (id !== REMOTE_ID) {
          throw new NotFoundError('Remote', id);
        }
        return remote;
      }),
    };
    let key: string | null = null;
    apiKeys = new RemoteApiKeyService({
      readRemoteApiKey: async () => key,
      saveRemoteApiKey: async (_id: string, value: string) => {
        key = value;
      },
    } as never);
    const remoteHealth = { getState: jest.fn(() => health) };

    @Module({
      providers: [
        { provide: RemoteApiKeyService, useValue: apiKeys },
        RemoteProxyService,
        HomeGateway,
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: REMOTE_HEALTH_PORT, useValue: remoteHealth },
      ],
    })
    class HomeModule {}

    home = await NestFactory.create<NestFastifyApplication>(HomeModule, new FastifyAdapter(), {
      logger: false,
    });
    homeUrl = await listen(home);
  });

  beforeEach(() => {
    health = {
      online: true,
      version: '1.2.3',
      versionMatches: true,
      stats: null,
      lastSeenAt: '2026-09-22T00:00:00.000Z',
      error: null,
    };
  });

  afterAll(async () => {
    await home?.close();
    await upstream?.close();
  });

  // Real HTTP and WebSocket upgrades exercise both proxy header rewrite callbacks.
  it('overwrites browser authorization on HTTP and WebSocket after every saved key', async () => {
    for (const key of ['first', 'replacement']) {
      await apiKeys.save(REMOTE_ID, key);
      const response = await fetch(`${homeUrl}/r/${REMOTE_ID}/api/auth`, {
        headers: { Authorization: 'Bearer browser' },
      });
      expect(await response.json()).toEqual({ authorization: `Bearer ${key}` });
      const received = await new Promise((resolve, reject) => {
        const socket = io(homeUrl, {
          path: `/r/${REMOTE_ID}/socket.io`,
          transports: ['websocket'],
          reconnection: false,
          extraHeaders: { Authorization: 'Bearer browser', Cookie: 'session=preserved' },
        });
        socket.on('auth', (headers) => {
          socket.close();
          resolve(headers);
        });
        socket.on('connect_error', (error) => {
          socket.close();
          reject(error);
        });
      });
      expect(received).toEqual({ authorization: `Bearer ${key}`, cookie: 'session=preserved' });
    }
  });

  it('forwards GET to the upstream and preserves the query string', async () => {
    const response = await fetch(`${homeUrl}/r/${REMOTE_ID}/api/runtime?a=1&b=two%20words`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: '1.2.3',
      side: 'upstream',
      query: { a: '1', b: 'two words' },
    });
  });

  it('forwards POST bodies and JSON responses unchanged', async () => {
    const body = { nested: { list: [1, 'two', null] }, flag: true };
    const response = await fetch(`${homeUrl}/r/${REMOTE_ID}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ received: body });
  });

  it('returns 404 JSON for an unknown remote', async () => {
    const response = await fetch(`${homeUrl}/r/unknown-remote/api/runtime`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      statusCode: 404,
      message: 'Remote not found',
      remoteId: 'unknown-remote',
    });
  });

  it('answers a rejected key before offline with the VM name and recovery action', async () => {
    health = { ...health, online: false, apiKeyRejected: true };
    const response = await fetch(`${homeUrl}/r/${REMOTE_ID}/api/runtime`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: 'HOST_API_KEY_REJECTED',
      remoteName: 'lab-vm',
      message: 'API key rejected by "lab-vm". Use Enter API key in Remote VMs.',
    });
  });

  it('returns 503 JSON with the remote name when the remote is offline', async () => {
    health = { ...health, online: false };

    const response = await fetch(`${homeUrl}/r/${REMOTE_ID}/api/runtime`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      statusCode: 503,
      remoteId: REMOTE_ID,
      remoteName: 'lab-vm',
    });
  });

  it('never proxies a provisioning remote without an address', async () => {
    const previous = remote;
    remote = { ...remote, kind: 'proxmox', baseUrl: null };
    try {
      const response = await fetch(`${homeUrl}/r/${REMOTE_ID}/api/runtime`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ message: 'Remote "lab-vm" is provisioning' });
      await expect(firstMessage(homeUrl, `/r/${REMOTE_ID}/socket.io`)).rejects.toBeInstanceOf(
        Error,
      );
    } finally {
      remote = previous;
    }
  });

  it('returns 409 JSON with both versions on a version mismatch', async () => {
    health = { ...health, version: '1.0.0', versionMatches: false };

    const response = await fetch(`${homeUrl}/r/${REMOTE_ID}/api/runtime`);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      statusCode: 409,
      remoteId: REMOTE_ID,
      remoteName: 'lab-vm',
      homeVersion: '1.2.3',
      remoteVersion: '1.0.0',
    });
  });

  it('proxies Socket.IO on /r/:remoteId/socket.io to the upstream', async () => {
    await expect(firstMessage(homeUrl, `/r/${REMOTE_ID}/socket.io`)).resolves.toEqual({
      topic: 'hello',
      payload: { side: 'upstream' },
    });
  });

  it('keeps the home /socket.io working on the same server', async () => {
    await expect(firstMessage(homeUrl, '/socket.io')).resolves.toEqual({
      topic: 'hello',
      payload: { side: 'home' },
    });
  });

  it('refuses the WebSocket upgrade for an offline remote', async () => {
    health = { ...health, online: false };

    await expect(firstMessage(homeUrl, `/r/${REMOTE_ID}/socket.io`)).rejects.toBeInstanceOf(Error);
  });
});
