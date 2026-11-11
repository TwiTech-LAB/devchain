import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import {
  HOST_VAULT_BODY_LIMIT_BYTES,
  HOST_VAULT_CONTENT_TYPE,
  PROJECT_REPLICA_CONTENT_TYPE,
} from '@devchain/shared';
import {
  GIT_CHECKPOINT_CONTENT_TYPE,
  GIT_CHECKPOINT_MAX_INDEX_BASE64_LENGTH,
} from '../git-coordinator/git-coordinator.dto';

/** An attach replica carries a whole project; the app-wide JSON limit (1 MiB) is too small. */
export const PROJECT_REPLICA_BODY_LIMIT_BYTES = 256 * 1024 * 1024;

/** The largest index snapshot (base64) plus 1 MiB for the rest of the JSON body. */
const GIT_CHECKPOINT_BODY_LIMIT_BYTES = GIT_CHECKPOINT_MAX_INDEX_BASE64_LENGTH + 1024 * 1024;

const JSON_BODY_LIMITS: ReadonlyArray<readonly [contentType: string, limitBytes: number]> = [
  [PROJECT_REPLICA_CONTENT_TYPE, PROJECT_REPLICA_BODY_LIMIT_BYTES],
  [GIT_CHECKPOINT_CONTENT_TYPE, GIT_CHECKPOINT_BODY_LIMIT_BYTES],
  [HOST_VAULT_CONTENT_TYPE, HOST_VAULT_BODY_LIMIT_BYTES],
];

/**
 * Registers a JSON parser per host content type, each with its own body limit,
 * leaving the default `application/json` limit untouched.
 */
@Injectable()
export class HostJsonBodyParser implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const adapter = this.adapterHost.httpAdapter;
    if (!adapter || adapter.getType() !== 'fastify') return;
    const fastify = adapter.getInstance<FastifyInstance>();

    for (const [contentType, bodyLimit] of JSON_BODY_LIMITS) {
      if (fastify.hasContentTypeParser(contentType)) continue;
      fastify.addContentTypeParser(
        contentType,
        { parseAs: 'string', bodyLimit },
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
}
