import send from '@fastify/send';
import { FastifyReply, FastifyRequest } from 'fastify';
import { isAbsolute } from 'path';

interface SendError extends Error {
  headers?: Record<string, string | number | readonly string[]>;
  status?: number;
  statusCode?: number;
}

export interface AllowlistedFile {
  allowedRelativePaths: ReadonlySet<string>;
  encodedRelativePath: string;
  root: string;
}

export function sendAllowlistedFile(
  request: FastifyRequest,
  reply: FastifyReply,
  file: AllowlistedFile,
): void {
  reply.hijack();

  if (
    !isAbsolute(file.root) ||
    !file.encodedRelativePath ||
    !file.allowedRelativePaths.has(file.encodedRelativePath) ||
    file.encodedRelativePath.startsWith('/') ||
    file.encodedRelativePath.startsWith('\\')
  ) {
    finish(reply, 404);
    return;
  }

  const stream = send(request.raw, file.encodedRelativePath, {
    root: file.root,
    dotfiles: 'deny',
    index: false,
    maxAge: 0,
    immutable: false,
  });

  stream.on('error', (error: SendError) => {
    const sendStatus = error.statusCode ?? error.status ?? 500;
    const status =
      sendStatus === 400 || sendStatus === 403 || sendStatus === 404 ? 404 : sendStatus;
    finish(reply, status, error.headers);
  });
  stream.on('directory', () => finish(reply, 404));
  stream.pipe(reply.raw);
}

function finish(
  reply: FastifyReply,
  statusCode: number,
  headers?: Record<string, string | number | readonly string[]>,
): void {
  if (reply.raw.writableEnded) {
    return;
  }

  reply.raw.statusCode = statusCode;
  if (headers) {
    for (const [name, value] of Object.entries(headers)) {
      reply.raw.setHeader(name, value);
    }
  }
  reply.raw.end();
}
