import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';

@Injectable()
export class HostTranscriptBodyParser implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const adapter = this.adapterHost.httpAdapter;
    if (!adapter || adapter.getType() !== 'fastify') return;
    const fastify = adapter.getInstance<FastifyInstance>();
    if (!fastify.hasContentTypeParser('application/octet-stream')) {
      // The writer enforces the length while piping; Fastify must never buffer this body.
      fastify.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
        done(null, payload),
      );
    }
  }
}
