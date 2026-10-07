import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { fixtureTls, otherTls } from '../../../common/test/tls-fixture';
import { certificateFingerprint } from '../../../common/tls/certificate';
import { discoverRuntime } from './remote-discovery';
import { RemoteHostClient } from '../operations/remote-host.client';

describe('discoverRuntime', () => {
  let server: Server;
  let origin: string;
  let seen: Array<{
    method?: string;
    url?: string;
    headers: Record<string, unknown>;
    body: string;
  }>;

  const start = async (tls: { key: string; cert: string }, status = 200, payload?: string) => {
    seen = [];
    server = createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(
          payload ?? JSON.stringify({ state: 'unclaimed', version: null, imageVersion: '0.2.0' }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it.each([
    ['the fixture', fixtureTls],
    ['an unrelated', otherTls],
  ])(
    'sends only GET /api/runtime to %s VM and returns the certificate it showed',
    async (_label, tls) => {
      await start(tls);
      const answer = await discoverRuntime(origin, 2_000);
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ state: 'unclaimed', version: null, imageVersion: '0.2.0' });
      expect(certificateFingerprint(answer.certificate)).toBe(certificateFingerprint(tls.cert));
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ method: 'GET', url: '/api/runtime', body: '' });
      expect(seen[0].headers.authorization).toBeUndefined();
      expect(seen[0].headers.cookie).toBeUndefined();
      expect(seen[0].headers['content-length']).toBeUndefined();
    },
  );

  it('refuses a plain http address', async () => {
    await start(fixtureTls);
    await expect(discoverRuntime(origin.replace('https:', 'http:'), 2_000)).rejects.toThrow(
      /https only/,
    );
    expect(seen).toHaveLength(0);
  });

  it('reports a non-JSON redirect without following it or treating it as a runtime', async () => {
    await start(fixtureTls, 302, '<html>Moved</html>');
    await expect(discoverRuntime(origin, 2_000)).resolves.toMatchObject({
      status: 302,
      body: null,
    });
    expect(seen).toHaveLength(1);
    const client = new RemoteHostClient({} as never, {} as never);
    await expect(client.discoverRuntime(origin)).resolves.toMatchObject({ runtime: null });
    expect(seen).toHaveLength(2);
    expect(seen.every((request) => request.url === '/api/runtime')).toBe(true);
  });
});
