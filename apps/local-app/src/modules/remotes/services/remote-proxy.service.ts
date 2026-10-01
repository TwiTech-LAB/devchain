import { RemoteApiKeyService, remoteAuthorization } from '../auth/remote-api-key.service';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyHttpProxy = require('@fastify/http-proxy');
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createLogger } from '../../../common/logging/logger';
import { getAppVersion } from '../../../common/app-version';
import { NotFoundError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import { HOST_API_KEY_REJECTED } from '../host-api-key';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import { REMOTE_TLS_CERTIFICATE_MISSING, requireRemoteCertificate } from '../transport/remote-tls';
import {
  originKeyOfUrl,
  pinnedUndiciConnector,
  pinnedWsConnection,
} from '../transport/remote-proxy-tls';

const logger = createLogger('RemoteProxyService');

export const REMOTE_PROXY_PATH_PREFIX = '/r/';
const PROXY_PREFIX = '/r/:remoteId';
const REQUEST_UPSTREAM_KEY = '__remoteProxyUpstream';
const REQUEST_API_KEY = Symbol('remoteApiKey');
// Only reached if the preHandler did not resolve an upstream; nothing listens there.
const UNRESOLVED_UPSTREAM = 'http://127.0.0.1:65535';

type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

type RequestWithProxyContext = FastifyRequest & {
  raw: FastifyRequest['raw'] & {
    [REQUEST_UPSTREAM_KEY]?: string;
    [REQUEST_API_KEY]?: string | null;
  };
};

@Injectable()
export class RemoteProxyService implements OnModuleInit {
  private registered = false;
  /**
   * The certificate of each VM origin, refreshed from the remote row on every
   * proxied request before it connects. The connectors read it at connect time.
   */
  private readonly certificates = new Map<string, string>();
  private readonly certificateOf = (origin: string): string | null =>
    this.certificates.get(origin) ?? null;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    @Inject(REMOTE_HEALTH_PORT) private readonly remoteHealth: RemoteHealthPort,
    private readonly apiKeys: RemoteApiKeyService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.registered) {
      return;
    }

    const adapter = this.adapterHost.httpAdapter;
    if (!adapter || adapter.getType() !== 'fastify') {
      return;
    }

    const fastify = adapter.getInstance<FastifyInstance>();
    const server = fastify.server;
    const upgradeListenersBefore = new Set(server.listeners('upgrade'));

    await fastify.register(async (scope) => {
      // Bodies are forwarded as raw streams so every content type passes through
      // unchanged; the app-wide JSON parser must not run for proxied routes.
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser('*', (_request, payload, done) => done(null, payload));

      // @ts-expect-error — wsClientOptions.rewriteRequestHeaders is a valid runtime
      // option in @fastify/http-proxy but is missing from the declared ws ClientOptions.
      await scope.register(fastifyHttpProxy, {
        upstream: '',
        prefix: PROXY_PREFIX,
        rewritePrefix: '/',
        websocket: true,
        // A connect function replaces reply-from's TLS defaults, which trust any certificate.
        undici: { connect: pinnedUndiciConnector(this.certificateOf) },
        // A preValidation hook stops the plugin from adding its own content-type
        // parsers, which would collide with the ones registered above.
        preValidation: async () => undefined,
        preHandler: async (request: FastifyRequest, reply: FastifyReply) =>
          this.resolveUpstream(request as RequestWithProxyContext, reply),
        replyOptions: {
          rewriteRequestHeaders: (request, headers) =>
            this.authorizedHeaders(request as RequestWithProxyContext, headers),
          getUpstream: (request: FastifyRequest) =>
            (request as RequestWithProxyContext).raw[REQUEST_UPSTREAM_KEY] ?? UNRESOLVED_UPSTREAM,
        },
        wsClientOptions: {
          createConnection: pinnedWsConnection(this.certificateOf),
          rewriteRequestHeaders: (headers: Record<string, unknown>, request: FastifyRequest) =>
            this.authorizedHeaders(
              request as RequestWithProxyContext,
              request.headers.cookie ? { ...headers, cookie: request.headers.cookie } : headers,
            ),
        },
      });
    });

    // The plugin adds a blanket 'upgrade' listener that routes every WebSocket
    // upgrade through Fastify; for /socket.io that ends in a 404 that destroys the
    // socket before Socket.IO sees it. Restrict the new listener(s) to /r/ paths.
    const proxyUpgradeListeners = (server.listeners('upgrade') as UpgradeListener[]).filter(
      (listener) => !upgradeListenersBefore.has(listener),
    );
    for (const listener of proxyUpgradeListeners) {
      server.removeListener('upgrade', listener);
      server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (req.url?.startsWith(REMOTE_PROXY_PATH_PREFIX)) {
          listener(req, socket, head);
        }
      });
    }

    this.registered = true;
    logger.info({ prefix: PROXY_PREFIX }, 'Remote proxy registered');
  }

  private authorizedHeaders<T>(
    request: RequestWithProxyContext,
    headers: Record<string, T>,
  ): Record<string, T | string> {
    const clean = Object.fromEntries(
      Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'),
    );
    return { ...clean, ...remoteAuthorization(request.raw[REQUEST_API_KEY]) };
  }

  private async resolveUpstream(
    request: RequestWithProxyContext,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> {
    const params = request.params as { remoteId?: unknown } | undefined;
    const remoteId = typeof params?.remoteId === 'string' ? params.remoteId : '';

    let remote;
    try {
      remote = await this.storage.getRemote(remoteId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return reply.code(404).send({ statusCode: 404, message: 'Remote not found', remoteId });
      }
      throw error;
    }

    const health = this.remoteHealth.getState(remote.id);
    if (!remote.baseUrl) {
      return reply.code(503).send({
        statusCode: 503,
        message: `Remote "${remote.name}" is provisioning`,
        remoteId,
        remoteName: remote.name,
      });
    }
    if (health.apiKeyRejected) {
      return reply.code(401).send({
        statusCode: 401,
        code: HOST_API_KEY_REJECTED,
        message: `API key rejected by "${remote.name}". Use Enter API key in Remote VMs.`,
        remoteId,
        remoteName: remote.name,
      });
    }
    if (!health.online) {
      return reply.code(503).send({
        statusCode: 503,
        message: `Remote "${remote.name}" is offline`,
        remoteId,
        remoteName: remote.name,
      });
    }
    if (!health.versionMatches) {
      const homeVersion = getAppVersion();
      return reply.code(409).send({
        statusCode: 409,
        message: `Remote "${remote.name}" needs update: home ${homeVersion}, remote ${health.version ?? 'unknown'}`,
        remoteId,
        remoteName: remote.name,
        homeVersion,
        remoteVersion: health.version,
      });
    }

    // The health poll fails without a certificate too; this covers one cleared since the last poll.
    let certificate: string;
    try {
      certificate = requireRemoteCertificate(remote);
    } catch (error) {
      return reply.code(409).send({
        statusCode: 409,
        code: REMOTE_TLS_CERTIFICATE_MISSING,
        message: (error as Error).message,
        remoteId,
        remoteName: remote.name,
      });
    }
    this.certificates.set(originKeyOfUrl(remote.baseUrl), certificate);
    request.raw[REQUEST_UPSTREAM_KEY] = remote.baseUrl;
    request.raw[REQUEST_API_KEY] = await this.apiKeys.get(remote.id);
  }
}
