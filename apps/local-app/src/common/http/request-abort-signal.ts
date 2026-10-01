import type { FastifyReply, FastifyRequest } from 'fastify';

/** Aborts when the client goes away: the request aborts, or the reply closes unfinished. */
export function requestAbortSignal(req: FastifyRequest, reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => {
    if (!reply.raw.writableFinished) abort();
    cleanup();
  };
  const cleanup = () => {
    req.raw.off('aborted', abort);
    reply.raw.off('close', close);
    reply.raw.off('finish', cleanup);
  };
  req.raw.once('aborted', abort);
  reply.raw.once('close', close);
  reply.raw.once('finish', cleanup);
  if (req.raw.aborted) abort();
  return controller.signal;
}
