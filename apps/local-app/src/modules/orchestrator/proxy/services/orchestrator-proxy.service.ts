import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import fastifyHttpProxy = require('@fastify/http-proxy');
import { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createLogger } from '../../../../common/logging/logger';
import { isValidWorktreeName } from '../../worktrees/worktree-validation';
import { WORKTREES_STORE, WorktreesStore } from '../../worktrees/worktrees.store';

const logger = createLogger('OrchestratorProxyService');
const PROXY_PREFIX = '/wt/:name';
const REQUEST_UPSTREAM_KEY = '__orchestratorProxyUpstream';
const REQUEST_WORKTREE_NAME_KEY = '__orchestratorProxyWorktreeName';
const DEFAULT_UPSTREAM = 'http://127.0.0.1:65535';
const PROXYABLE_STATUSES = new Set(['running', 'completed']);

type RequestWithProxyContext = FastifyRequest & {
  raw: FastifyRequest['raw'] & {
    [REQUEST_UPSTREAM_KEY]?: string;
    [REQUEST_WORKTREE_NAME_KEY]?: string;
  };
};

@Injectable()
export class OrchestratorProxyService implements OnModuleInit {
  private registered = false;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(WORKTREES_STORE) private readonly worktreesStore: WorktreesStore,
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
    await fastify.register(fastifyHttpProxy, {
      upstream: '',
      prefix: PROXY_PREFIX,
      rewritePrefix: '/',
      websocket: true,
      // Nest/Fastify already has JSON parsers; providing preValidation prevents
      // @fastify/http-proxy from re-registering duplicate content type parsers.
      preValidation: async () => undefined,
      preHandler: async (request, reply) =>
        this.preHandleProxy(request as RequestWithProxyContext, reply),
      replyOptions: {
        getUpstream: (request) => this.resolveRequestUpstream(request as RequestWithProxyContext),
        rewriteRequestHeaders: (request, headers) =>
          this.rewriteProxyRequestHeaders(request as RequestWithProxyContext, headers),
      },
      wsClientOptions: {
        rewriteRequestHeaders: (
          headers: Record<string, unknown>,
          request: RequestWithProxyContext,
        ) => this.rewriteWebSocketHeaders(request, headers),
      },
    });

    // @fastify/http-proxy registers a blanket 'upgrade' handler that routes
    // ALL WebSocket upgrades through Fastify's router. Non-proxy paths like
    // /socket.io get a 404 and the socket is destroyed before Socket.IO can
    // handle the upgrade. Wrap the handler to only process /wt/ paths.
    const server = fastify.server;
    const upgradeListeners = server.listeners('upgrade') as Array<
      (req: IncomingMessage, socket: Duplex, head: Buffer) => void
    >;
    const proxyUpgradeHandler = upgradeListeners[upgradeListeners.length - 1];
    if (proxyUpgradeHandler) {
      server.removeListener('upgrade', proxyUpgradeHandler);
      server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (req.url && req.url.startsWith('/wt/')) {
          proxyUpgradeHandler(req, socket, head);
        }
      });
    }

    this.registered = true;
    logger.info({ prefix: PROXY_PREFIX }, 'Orchestrator worktree proxy registered');
  }

  private async preHandleProxy(
    request: RequestWithProxyContext,
    reply: FastifyReply,
  ): Promise<void> {
    const worktreeName = this.resolveWorktreeName(request);
    if (!worktreeName) {
      reply.code(400).send({
        statusCode: 400,
        message: 'Invalid worktree name',
      });
      return;
    }

    request.raw[REQUEST_WORKTREE_NAME_KEY] = worktreeName;

    const worktree = await this.worktreesStore.getByName(worktreeName);
    if (!worktree) {
      this.sendUnavailable(request, reply, 404, worktreeName, 'Worktree not found');
      return;
    }

    const normalizedStatus = String(worktree.status).toLowerCase();
    if (!worktree.containerPort || !PROXYABLE_STATUSES.has(normalizedStatus)) {
      this.sendUnavailable(
        request,
        reply,
        503,
        worktreeName,
        `Worktree is not running (status: ${worktree.status})`,
      );
      return;
    }

    request.raw[REQUEST_UPSTREAM_KEY] = `http://127.0.0.1:${worktree.containerPort}`;
  }

  private resolveRequestUpstream(request: RequestWithProxyContext): string {
    const upstream = request.raw[REQUEST_UPSTREAM_KEY];
    if (!upstream) {
      logger.warn({ url: request.url }, 'Missing resolved proxy upstream for request');
      return DEFAULT_UPSTREAM;
    }
    return upstream;
  }

  private rewriteProxyRequestHeaders(
    request: RequestWithProxyContext,
    headers: IncomingHttpHeaders,
  ): IncomingHttpHeaders {
    const worktreeName = request.raw[REQUEST_WORKTREE_NAME_KEY];
    if (!worktreeName) {
      return headers;
    }
    return {
      ...headers,
      'x-worktree-name': worktreeName,
    };
  }

  private rewriteWebSocketHeaders(
    request: RequestWithProxyContext,
    headers: Record<string, unknown>,
  ): Record<string, unknown> {
    const nextHeaders: Record<string, unknown> = {
      ...headers,
    };

    if (request.headers.cookie) {
      nextHeaders.cookie = request.headers.cookie;
    }

    const worktreeName = request.raw[REQUEST_WORKTREE_NAME_KEY];
    if (worktreeName) {
      nextHeaders['x-worktree-name'] = worktreeName;
    }

    return nextHeaders;
  }

  private resolveWorktreeName(request: RequestWithProxyContext): string | null {
    const params = request.params as { name?: unknown } | undefined;
    const rawName = typeof params?.name === 'string' ? params.name.trim() : '';
    if (!rawName || !isValidWorktreeName(rawName)) {
      return null;
    }
    return rawName;
  }

  private sendUnavailable(
    request: RequestWithProxyContext,
    reply: FastifyReply,
    statusCode: number,
    worktreeName: string,
    message: string,
  ): void {
    reply.header('X-Worktree-Name', worktreeName);

    if (this.prefersJson(request)) {
      reply.code(statusCode).send({
        statusCode,
        message,
        worktreeName,
      });
      return;
    }

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Worktree unavailable</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 2rem; background: #f7f8fb; color: #111827; }
      .card { max-width: 640px; margin: 0 auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 1.5rem; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04); }
      h1 { margin: 0 0 0.75rem; font-size: 1.25rem; }
      p { margin: 0.5rem 0; line-height: 1.5; }
      code { background: #f3f4f6; border-radius: 6px; padding: 0.15rem 0.35rem; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Worktree unavailable</h1>
      <p><strong>${this.escapeHtml(worktreeName)}</strong></p>
      <p>${this.escapeHtml(message)}</p>
      <p>Start the worktree and retry this page from the dashboard.</p>
    </div>
  </body>
</html>`;

    reply.code(statusCode).type('text/html; charset=utf-8').send(html);
  }

  private prefersJson(request: RequestWithProxyContext): boolean {
    const accept = request.headers.accept ?? '';
    const acceptsJson = accept.includes('application/json');
    const path = request.url;

    return (
      acceptsJson ||
      path.includes('/api/') ||
      path.includes('/mcp/') ||
      path.includes('/socket.io/')
    );
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
