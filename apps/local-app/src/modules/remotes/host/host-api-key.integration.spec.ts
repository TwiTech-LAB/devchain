import { Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { WebSocketGateway } from '@nestjs/websockets';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { io } from 'socket.io-client';
import { WebSocket } from 'ws';
import * as config from '../../../common/config/env.config';
import { HostApiKeyModule } from './host-api-key.module';
import { registerHostApiKeyBoundary } from './host-api-key.setup';
import { RemoteProxyService } from '../services/remote-proxy.service';
import { RemoteApiKeyService } from '../auth/remote-api-key.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { REMOTE_HEALTH_PORT } from '../ports/remote-health.port';
import { UiModule } from '../../ui/ui.module';
import { UI_ROOT } from '../../ui/ui.tokens';

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
  providers: [
    RemoteProxyService,
    {
      provide: STORAGE_SERVICE,
      useValue: {
        getRemote: async () => ({ id: 'vm', name: 'vm', baseUrl: 'http://127.0.0.1:65535' }),
      },
    },
    { provide: REMOTE_HEALTH_PORT, useValue: { getState: () => ({ online: false }) } },
    { provide: RemoteApiKeyService, useValue: {} },
  ],
})
class PluginModule {}
@Module({
  imports: [PluginModule, UiModule],
  controllers: [ProbeController],
  providers: [DefaultGateway, McpGateway],
})
class ProbeModule {}

const key = `dck_${'a'.repeat(43)}`;
const nextKey = `dck_${'b'.repeat(43)}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const SOCKET_NAMESPACE_TRANSPORTS = [
  ['/', 'polling'],
  ['/', 'websocket'],
  ['/mcp', 'polling'],
  ['/mcp', 'websocket'],
] as const;

// Real Nest/Fastify, Engine.IO and files verify hook timing, namespace sharing and atomic replacement.
describe('Host API key transport integration', () => {
  let app: NestFastifyApplication;
  let fastify: ReturnType<ReturnType<NestFastifyApplication['getHttpAdapter']>['getInstance']>;
  let root: string;
  let keyPath: string;
  let url: string;
  let peerAddress: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'host-api-key-'));
    mkdirSync(join(root, '.devchain'));
    writeFileSync(join(root, 'claim.json'), JSON.stringify({ homePath: root }));
    keyPath = join(root, '.devchain', 'host-api-key');
    writeFileSync(keyPath, `${hash(key)}\n`);
    mkdirSync(join(root, 'ui'));
    writeFileSync(join(root, 'ui', 'index.html'), '<div id="root">callback SPA shell</div>');
    const env = config.getEnvConfig();
    jest.spyOn(config, 'getEnvConfig').mockReturnValue({ ...env, DEVCHAIN_HOST_ETC_DIR: root });
    const module = await Test.createTestingModule({ imports: [ProbeModule] })
      .overrideProvider(UI_ROOT)
      .useValue(join(root, 'ui'))
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    registerHostApiKeyBoundary(app);
    fastify = app.getHttpAdapter().getInstance();
    peerAddress = '192.0.2.10';
    // Supply a deterministic raw peer without depending on a LAN interface in CI.
    fastify.server.prependListener('connection', (socket) => {
      Object.defineProperty(socket, 'remoteAddress', { get: () => peerAddress });
    });
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(fastify.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const connect = (
    namespace: string,
    transport: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<boolean> =>
    new Promise((resolve, reject) => {
      const client = io(`${url}${namespace}`, {
        transports: [transport],
        forceNew: true,
        reconnection: false,
        timeout: 2000,
        extraHeaders,
      });
      const timer = setTimeout(() => {
        client.close();
        reject(new Error('Socket test timed out'));
      }, 3000);
      const finish = (allowed: boolean) => {
        clearTimeout(timer);
        client.close();
        resolve(allowed);
      };
      client.once('connect', () => finish(true));
      client.once('connect_error', () => finish(false));
    });

  it.each([
    ['GET', '/api/runtime', { host: 'evil.example' }],
    ['GET', '/api/runtime', { 'sec-fetch-site': 'cross-site' }],
    [
      'POST',
      '/api/runtime',
      {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    ],
    ['GET', '/mcp', { origin: 'https://evil.example' }],
    ['GET', '/r/vm/health', { origin: 'https://evil.example' }],
  ] as const)(
    'refuses unclaimed HTTP %s %s with %p before routing',
    async (method, path, headers) => {
      rmSync(join(root, 'claim.json'));
      const response = await requestHttp(url, path, method, headers);
      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toEqual({
        statusCode: 403,
        code: 'BROWSER_ORIGIN_REJECTED',
        message: 'Browser origin rejected',
      });
    },
  );

  it('admits cross-site cloud callback navigation to the real SPA controller', async () => {
    rmSync(join(root, 'claim.json'));
    const response = await requestHttp(url, '/auth/cloud/callback?state=abc', 'GET', {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.body).toContain('callback SPA shell');
  });

  it.each([
    ['configured HOST', 'myhost.lan', [], 'myhost.lan'],
    ['ALLOWED_HOSTS', '0.0.0.0', ['alias.lan'], 'alias.lan'],
  ])(
    'admits unclaimed requests addressed by %s',
    async (_name, host, allowedHosts, requestHost) => {
      rmSync(join(root, 'claim.json'));
      jest.mocked(config.getEnvConfig).mockReturnValue({
        ...config.getEnvConfig(),
        HOST: host,
        ALLOWED_HOSTS: allowedHosts,
      });
      const response = await requestHttp(url, '/health', 'GET', {
        host: `${requestHost}:${new URL(url).port}`,
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ok: true });
    },
  );

  it('preserves claimed key admission with foreign browser headers and a DNS Host', async () => {
    for (const [authorization, status, code] of [
      [`Bearer ${key}`, 200, undefined],
      [`Bearer ${nextKey}`, 401, 'HOST_API_KEY_REJECTED'],
    ] as const) {
      const response = await requestHttp(url, '/health', 'GET', {
        host: 'evil.example:3000',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
        authorization,
      });
      expect(response.statusCode).toBe(status);
      expect(JSON.parse(response.body).code).toBe(code);
    }
  });

  it.each(SOCKET_NAMESPACE_TRANSPORTS)(
    'checks browser origins for unclaimed namespace %s over %s',
    async (namespace, transport) => {
      rmSync(join(root, 'claim.json'));
      expect(await connect(namespace, transport, { origin: 'https://evil.example' })).toBe(false);
      expect(await connect(namespace, transport, { origin: 'http://127.0.0.1:5175' })).toBe(true);
    },
  );

  // Only a real upgrade can prove the Engine.IO allowRequest callback's refusal code.
  it('returns the browser refusal code on the Socket.IO WebSocket handshake', async () => {
    rmSync(join(root, 'claim.json'));
    const response = await rejectedUpgrade(url, '/socket.io/?EIO=4&transport=websocket');
    // Engine.IO serializes upgrade refusals as HTTP 400 with the callback message as text.
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('BROWSER_ORIGIN_REJECTED');
  });

  // Fastify injection cannot exercise the proxy plugin's HTTP upgrade hook.
  it('refuses foreign-origin /r WebSocket upgrades at the HTTP boundary', async () => {
    rmSync(join(root, 'claim.json'));
    const response = await rejectedUpgrade(url, '/r/vm/socket.io/?EIO=4&transport=websocket');
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).code).toBe('BROWSER_ORIGIN_REJECTED');
  });

  it('protects HTTP before routing and opens only runtime or loopback', async () => {
    for (const path of [
      '/health',
      '/api/docs',
      '/assets/app.js',
      '/api/mcp/sse',
      '/unknown',
      '/r/vm/health',
    ]) {
      const rejected = await fastify.inject({
        url: path,
        remoteAddress: peerAddress,
        headers: { 'x-forwarded-for': '127.0.0.1' },
      });
      expect(rejected.statusCode).toBe(401);
      expect(rejected.json()).toEqual({
        statusCode: 401,
        code: 'HOST_API_KEY_REJECTED',
        message: 'Host API key rejected',
      });
    }
    expect(
      (
        await fastify.inject({
          url: '/health',
          remoteAddress: peerAddress,
          headers: { authorization: `Bearer ${nextKey}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await fastify.inject({
          url: '/health',
          remoteAddress: peerAddress,
          headers: { authorization: `Bearer ${key}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await fastify.inject({ url: '/api/runtime', remoteAddress: peerAddress })).statusCode,
    ).toBe(200);
    expect(
      (await fastify.inject({ url: '/health', remoteAddress: '::ffff:127.0.0.1' })).statusCode,
    ).toBe(200);
  });

  it('registers admission before the real proxy plugin inherits its hooks', async () => {
    const rejected = await fastify.inject({ url: '/r/vm/health', remoteAddress: peerAddress });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().code).toBe('HOST_API_KEY_REJECTED');
    const admitted = await fastify.inject({
      url: '/r/vm/health',
      remoteAddress: peerAddress,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(admitted.statusCode).toBe(503);
    expect(admitted.json().message).toBe('Remote "vm" is offline');
  });

  it('requires a key for loopback rotation, validates the digest, and immediately uses the replacement', async () => {
    const rotate = (authorization?: string, sha256: unknown = hash(nextKey)) =>
      fastify.inject({
        method: 'POST',
        url: '/api/host/api-key',
        remoteAddress: '127.0.0.1',
        headers: authorization ? { authorization } : {},
        payload: { sha256 },
      });
    expect((await rotate()).statusCode).toBe(401);
    expect((await rotate(`Bearer ${nextKey}`)).statusCode).toBe(401);
    for (const invalid of [hash(nextKey).toUpperCase(), 'short', null, key]) {
      const rejected = await rotate(`Bearer ${key}`, invalid);
      expect(rejected.statusCode).toBe(400);
      expect(rejected.body).not.toContain(key);
    }
    const result = await rotate(`Bearer ${key}`);
    expect(result.statusCode).toBe(204);
    expect(result.body).toBe('');
    expect(readFileSync(keyPath, 'utf8')).toBe(`${hash(nextKey)}\n`);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, '.devchain'))).toEqual(['host-api-key']);
    expect(
      (
        await fastify.inject({
          url: '/health',
          remoteAddress: peerAddress,
          headers: { authorization: `Bearer ${key}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await fastify.inject({
          url: '/health',
          remoteAddress: peerAddress,
          headers: { authorization: `Bearer ${nextKey}` },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('reloads external atomic replacements and fails closed for a missing or malformed file', async () => {
    const check = () =>
      fastify.inject({
        url: '/health',
        remoteAddress: peerAddress,
        headers: { authorization: `Bearer ${key}` },
      });
    expect((await check()).statusCode).toBe(200);
    writeFileSync(`${keyPath}.new`, `${hash(nextKey)}\n`);
    renameSync(`${keyPath}.new`, keyPath);
    expect((await check()).statusCode).toBe(401);
    writeFileSync(keyPath, 'bad');
    expect((await check()).statusCode).toBe(401);
    rmSync(keyPath);
    expect((await check()).statusCode).toBe(401);
    rmSync(join(root, 'claim.json'));
    expect((await fastify.inject({ url: '/health', remoteAddress: peerAddress })).statusCode).toBe(
      200,
    );
  });

  it.each(SOCKET_NAMESPACE_TRANSPORTS)(
    'guards namespace %s over %s using Engine.IO admission',
    async (namespace, transport) => {
      expect(await connect(namespace, transport)).toBe(false);
      expect(await connect(namespace, transport, { authorization: `Bearer ${nextKey}` })).toBe(
        false,
      );
      expect(await connect(namespace, transport, { authorization: `Bearer ${key}` })).toBe(true);
      peerAddress = '127.0.0.1';
      expect(await connect(namespace, transport)).toBe(true);
    },
  );
});

type HttpResponse = { statusCode: number | undefined; headers: IncomingHttpHeaders; body: string };

function readResponse(response: IncomingMessage): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.once('error', reject);
    response.once('end', () =>
      resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }),
    );
  });
}

function requestHttp(
  url: string,
  path: string,
  method: string,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${url}${path}`, { method, headers }, (response) => {
      readResponse(response).then(resolve, reject);
    });
    request.once('error', reject);
    request.end();
  });
}

function rejectedUpgrade(url: string, path: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`${url.replace(/^http/, 'ws')}${path}`, {
      headers: { origin: 'https://evil.example' },
      handshakeTimeout: 2000,
    });
    client.once('error', reject);
    client.once('open', () => {
      client.close();
      reject(new Error('Expected the WebSocket upgrade to be refused'));
    });
    client.once('unexpected-response', (_request, response) => {
      readResponse(response)
        .then(resolve, reject)
        .finally(() => client.terminate());
    });
  });
}
