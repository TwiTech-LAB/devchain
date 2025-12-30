import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';

interface ExpressLikeRequest {
  headers: Record<string, string | string[] | undefined>;
  id?: string;
}

interface ExpressLikeResponse {
  setHeader(name: string, value: string): void;
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: ExpressLikeRequest, res: ExpressLikeResponse, next: () => void) {
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    req.id = requestId;
    // When using NestJS middleware with Fastify, it goes through @fastify/middie
    // which provides Express compatibility, so we use Express-style setHeader
    res.setHeader('x-request-id', requestId);
    next();
  }
}
