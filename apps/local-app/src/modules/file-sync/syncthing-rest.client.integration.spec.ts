import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import { SyncthingRestClient, SyncthingRestError } from './syncthing-rest.client';

// A real loopback HTTP server stands in for Syncthing. The unit spec stubs fetch,
// so only this spec proves that the client's fetch honors the client's dispatcher:
// the fix for long scans depends on that dispatcher, not on undici's 300s default.

let server: Server;
let baseUrl: string;
const timers = new Set<NodeJS.Timeout>();

function handle(req: IncomingMessage, res: ServerResponse): void {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
  req.on('end', () => {
    const answer = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          method: req.method,
          apiKey: req.headers['x-api-key'],
          contentType: req.headers['content-type'] ?? null,
          body,
        }),
      );
    };
    if (req.url?.startsWith('/slow')) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        answer();
      }, 3_000);
      timers.add(timer);
      return;
    }
    answer();
  });
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('SyncthingRestClient over real HTTP', () => {
  it('sends the API key and a JSON body and parses the answer with the default dispatcher', async () => {
    const client = new SyncthingRestClient(baseUrl, 'test-key');

    await expect(
      client.request('PATCH', '/rest/config/options', { relaysEnabled: false }),
    ).resolves.toEqual({
      method: 'PATCH',
      apiKey: 'test-key',
      contentType: 'application/json',
      body: '{"relaysEnabled":false}',
    });
  });

  it("ends a slow answer by the dispatcher's headers timeout, not by undici's default", async () => {
    const shortHeaders = new Agent({ headersTimeout: 500, bodyTimeout: 500 });
    try {
      const client = new SyncthingRestClient(baseUrl, 'test-key', shortHeaders);

      const error: unknown = await client
        .request('POST', '/slow', undefined, 10_000)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SyncthingRestError);
      expect((error as Error).message).toContain('UND_ERR_HEADERS_TIMEOUT');
    } finally {
      await shortHeaders.close();
    }
  });
});
