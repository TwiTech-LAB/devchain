import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { PROJECT_REPLICA_CONTENT_TYPE } from '@devchain/shared';

/** An attach replica carries a whole project; the app-wide JSON limit (1 MiB) is too small. */
export const PROJECT_REPLICA_BODY_LIMIT_BYTES = 256 * 1024 * 1024;

/**
 * Registers a JSON parser for `PROJECT_REPLICA_CONTENT_TYPE` with its own body
 * limit, leaving the default `application/json` limit untouched.
 */
@Injectable()
export class HostReplicaBodyParser implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const adapter = this.adapterHost.httpAdapter;
    if (!adapter || adapter.getType() !== 'fastify') return;
    const fastify = adapter.getInstance<FastifyInstance>();
    if (fastify.hasContentTypeParser(PROJECT_REPLICA_CONTENT_TYPE)) return;

    fastify.addContentTypeParser(
      PROJECT_REPLICA_CONTENT_TYPE,
      { parseAs: 'string', bodyLimit: PROJECT_REPLICA_BODY_LIMIT_BYTES },
      (_request, body, done) => {
        try {
          done(null, JSON.parse(body as string));
        } catch {
          done(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }), undefined);
        }
      },
    );
  }
}
