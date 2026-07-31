import fastify, { FastifyInstance } from 'fastify';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { sendAllowlistedFile } from './send-allowlisted-file';

describe('sendAllowlistedFile', () => {
  let app: FastifyInstance;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'devchain-send-file-'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'present.txt'), 'present', 'utf8');

    app = fastify();
    app.get('/files/*', (request, reply) => {
      const encodedRelativePath = request.raw.url!.split('?')[0].slice('/files/'.length);
      sendAllowlistedFile(request, reply, {
        root,
        encodedRelativePath,
        allowedRelativePaths: new Set([encodedRelativePath]),
      });
    });
    app.get('/fixed/*', (request, reply) => {
      const encodedRelativePath = request.raw.url!.split('?')[0].slice('/fixed/'.length);
      sendAllowlistedFile(request, reply, {
        root,
        encodedRelativePath,
        allowedRelativePaths: new Set(['present.txt']),
      });
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it('streams an allowlisted file', async () => {
    const response = await app.inject({ method: 'GET', url: '/files/present.txt' });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toBe('present');
  });

  it.each([
    '/files/missing.txt',
    '/files/assets',
    '/files/%00.txt',
    '/files/%2e%2e%2fpresent.txt',
    '/fixed/missing.txt',
  ])('normalizes rejected file path %s to 404', async (url) => {
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(404);
  });
});
