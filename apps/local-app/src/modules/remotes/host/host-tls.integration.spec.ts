import { Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { WebSocketGateway } from '@nestjs/websockets';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Agent, request as httpsRequest } from 'node:https';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import * as config from '../../../common/config/env.config';
import { HostApiKeyModule } from './host-api-key.module';
import { registerHostApiKeyBoundary } from './host-api-key.setup';
import { registerHostTls } from './host-tls.setup';
import {
  FIXTURE_TLS_DIR,
  FIXTURE_TLS_NAME as CERT_NAME,
  fixtureTls,
} from '../../../common/test/tls-fixture';
import { RemoteProxyService } from '../services/remote-proxy.service';
import { RemoteApiKeyService } from '../auth/remote-api-key.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { REMOTE_HEALTH_PORT } from '../ports/remote-health.port';

@Controller()
class ProbeController {
  @Get('api/runtime') runtime() {
    return { ok: true };
  }
  @Get('health') health() {
    return { ok: true };
  }
}
@WebSocketGateway()
class DefaultGateway {}
@WebSocketGateway({ namespace: '/mcp' })
class McpGateway {}
@Module({
  imports: [HostApiKeyModule],
  controllers: [ProbeController],
  providers: [
    DefaultGateway,
    McpGateway,
    // Wraps the server's upgrade listeners as in production.
    RemoteProxyService,
    { provide: STORAGE_SERVICE, useValue: {} },
    { provide: REMOTE_HEALTH_PORT, useValue: { getState: () => ({ online: false }) } },
    { provide: RemoteApiKeyService, useValue: {} },
  ],
})
class ProbeModule {}

const { cert } = fixtureTls;
const LAN_PEER = '192.0.2.10';
const key = `dck_${'a'.repeat(43)}`;

// Real Nest/Fastify, Engine.IO and TLS on one port of a claimed host.
describe('Host TLS transport integration', () => {
  let app: NestFastifyApplication;
  let root: string;
  let port: number;
  /** What the TLS front sees as the raw peer; null keeps loopback. */
  let frontPeer: string | null;
  /** What admission sees on the socket the HTTP server gets; null keeps the real peer. */
  let admissionPeer: string | null;

  const overridePeer = (current: () => string | null) => (socket: Socket) => {
    const peer = current();
    if (peer) Object.defineProperty(socket, 'remoteAddress', { get: () => peer });
  };

  beforeEach(async () => {
    frontPeer = null;
    admissionPeer = null;
    root = mkdtempSync(join(tmpdir(), 'host-tls-'));
    mkdirSync(join(root, '.devchain'));
    writeFileSync(join(root, 'claim.json'), JSON.stringify({ homePath: root }));
    writeFileSync(
      join(root, '.devchain', 'host-api-key'),
      `${createHash('sha256').update(key).digest('hex')}\n`,
    );
    const env = config.getEnvConfig();
    jest.spyOn(config, 'getEnvConfig').mockReturnValue({
      ...env,
      DEVCHAIN_HOST_ETC_DIR: root,
      DEVCHAIN_HOST_TLS_KEY_FILE: join(FIXTURE_TLS_DIR, 'key.pem'),
      DEVCHAIN_HOST_TLS_CERT_FILE: join(FIXTURE_TLS_DIR, 'cert.pem'),
    });
    const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    const server = app.getHttpServer();
    // Registered before the front, so it runs on the socket the front hands over.
    server.prependListener(
      'connection',
      overridePeer(() => admissionPeer),
    );
    registerHostApiKeyBoundary(app);
    registerHostTls(app);
    // Registered after the front, so it runs first, on the raw socket.
    server.prependListener(
      'connection',
      overridePeer(() => frontPeer),
    );
    await app.listen(0, '127.0.0.1');
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const lanPeer = () => {
    frontPeer = LAN_PEER;
    admissionPeer = LAN_PEER;
  };

  const secure = (path: string, authorization?: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          agent: false,
          ca: cert,
          servername: CERT_NAME,
          headers: authorization ? { authorization } : {},
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });

  const rawPlaintext = () =>
    new Promise<string>((resolve) => {
      const socket = netConnect(port, '127.0.0.1', () =>
        socket.write('GET /api/runtime HTTP/1.1\r\nHost: x\r\n\r\n'),
      );
      let received = '';
      socket.on('data', (chunk) => (received += chunk));
      socket.on('error', () => undefined);
      socket.on('close', () => resolve(received));
    });

  it('applies the API key to a LAN peer over TLS', async () => {
    lanPeer();
    const rejected = await secure('/health');
    expect(rejected.status).toBe(401);
    expect(JSON.parse(rejected.body)).toMatchObject({ code: 'HOST_API_KEY_REJECTED' });
    await expect(secure('/health', `Bearer ${key}`)).resolves.toMatchObject({ status: 200 });
    await expect(secure('/api/runtime')).resolves.toMatchObject({ status: 200 });
  });

  it('closes plaintext from a LAN peer without an answer', async () => {
    frontPeer = LAN_PEER;
    await expect(rawPlaintext()).resolves.toBe('');
  });

  it.each(['/', '/mcp'])(
    'connects Socket.IO on %s over TLS by polling, upgrades to WebSocket, and keeps the key check',
    async (namespace) => {
      lanPeer();
      const agent = new Agent({ ca: cert, servername: CERT_NAME });
      /** The transports the connection used, or null when it was refused. */
      const connect = (authorization?: string) =>
        new Promise<string[] | null>((resolve, reject) => {
          const client = io(`https://127.0.0.1:${port}${namespace}`, {
            agent: agent as unknown as string,
            transports: ['polling', 'websocket'],
            forceNew: true,
            reconnection: false,
            timeout: 3000,
            extraHeaders: authorization ? { authorization } : {},
          });
          const used: string[] = [];
          let connected = false;
          const timer = setTimeout(() => {
            client.close();
            reject(new Error('Socket test timed out'));
          }, 5000);
          const finish = (transports: string[] | null) => {
            clearTimeout(timer);
            client.close();
            resolve(transports);
          };
          client.io.on('open', () => {
            used.push(client.io.engine.transport.name);
            client.io.engine.once('upgrade', () => {
              used.push(client.io.engine.transport.name);
              if (connected) finish(used);
            });
          });
          client.once('connect_error', () => finish(null));
          client.once('connect', () => {
            connected = true;
            if (used.length === 2) finish(used);
          });
        });
      try {
        await expect(connect()).resolves.toBeNull();
        await expect(connect(`Bearer ${key}`)).resolves.toEqual(['polling', 'websocket']);
      } finally {
        agent.destroy();
      }
    },
  );

  it('closes cleanly while a connection waits for its first byte', async () => {
    const silent = netConnect(port, '127.0.0.1');
    silent.on('error', () => undefined);
    await new Promise((resolve) => silent.once('connect', resolve));
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    silent.destroy();
  });
});
