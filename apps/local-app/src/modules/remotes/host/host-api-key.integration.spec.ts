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
import { io } from 'socket.io-client';
import * as config from '../../../common/config/env.config';
import { HostApiKeyModule } from './host-api-key.module';
import { registerHostApiKeyBoundary } from './host-api-key.setup';
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
  imports: [PluginModule],
  controllers: [ProbeController],
  providers: [DefaultGateway, McpGateway],
})
class ProbeModule {}

const key = `dck_${'a'.repeat(43)}`;
const nextKey = `dck_${'b'.repeat(43)}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

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
    const env = config.getEnvConfig();
    jest.spyOn(config, 'getEnvConfig').mockReturnValue({ ...env, DEVCHAIN_HOST_ETC_DIR: root });
    const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
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

  it.each([
    ['/', 'polling'],
    ['/', 'websocket'],
    ['/mcp', 'polling'],
    ['/mcp', 'websocket'],
  ])('guards namespace %s over %s using Engine.IO admission', async (namespace, transport) => {
    const connect = (authorization?: string): Promise<boolean> =>
      new Promise((resolve, reject) => {
        const client = io(`${url}${namespace}`, {
          transports: [transport],
          forceNew: true,
          reconnection: false,
          timeout: 2000,
          extraHeaders: authorization ? { authorization } : {},
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
    expect(await connect()).toBe(false);
    expect(await connect(`Bearer ${nextKey}`)).toBe(false);
    expect(await connect(`Bearer ${key}`)).toBe(true);
    peerAddress = '127.0.0.1';
    expect(await connect()).toBe(true);
  });
});
