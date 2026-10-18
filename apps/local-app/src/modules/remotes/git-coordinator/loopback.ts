import { ForbiddenException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { isLoopbackHost } from '../../../common/config/integration-admission';

/** Git admission endpoints serve processes on this machine only. */
export function assertLoopback(request: FastifyRequest, message: string): void {
  if (!isLoopbackHost(request.raw.socket.remoteAddress ?? ''))
    throw new ForbiddenException(message);
}
