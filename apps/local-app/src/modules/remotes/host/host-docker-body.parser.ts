import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';

@Injectable()
export class HostDockerBodyParser implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}
  onModuleInit(): void {
    const adapter = this.adapterHost.httpAdapter;
    if (!adapter || adapter.getType() !== 'fastify') return;
    const fastify = adapter.getInstance<FastifyInstance>();
    // application/octet-stream streams through HostTranscriptBodyParser's app-wide parser.
    if (!fastify.hasContentTypeParser('application/x-tar')) {
      fastify.addContentTypeParser('application/x-tar', (_request, payload, done) =>
        done(null, payload),
      );
    }
  }
}
