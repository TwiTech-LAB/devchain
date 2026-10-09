import { Module, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { HostApiKeyService } from './host-api-key.service';
import { HostApiKeyController } from './host-api-key.controller';

@Module({
  controllers: [HostApiKeyController],
  providers: [HostApiKeyService],
  exports: [HostApiKeyService],
})
export class HostApiKeyModule implements OnModuleInit {
  private registered = false;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly keys: HostApiKeyService,
  ) {}

  onModuleInit(): void {
    const adapter = this.adapterHost.httpAdapter;
    if (this.registered || !adapter || adapter.getType() !== 'fastify') return;
    adapter.getInstance<FastifyInstance>().addHook('onRequest', async (request, reply) => {
      const rotation =
        request.method === 'POST' && request.url.split('?', 1)[0] === '/api/host/api-key';
      const refusal = this.keys.allows(request.raw, 'http', rotation);
      if (refusal) {
        return reply.code(refusal.statusCode).send(refusal);
      }
    });
    this.registered = true;
  }
}
