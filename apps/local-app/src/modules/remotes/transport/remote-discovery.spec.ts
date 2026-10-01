import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { fixtureTls, otherTls } from '../../../common/test/tls-fixture';
import { certificateFingerprint } from '../../../common/tls/certificate';
import { discoverRuntime } from './remote-discovery';

describe('discoverRuntime', () => {
  let server: Server;
  let origin: string;
  let seen: Array<{
    method?: string;
    url?: string;
    headers: Record<string, unknown>;
    body: string;
  }>;

  const start = async (tls: { key: string; cert: string }, status = 200) => {
    seen = [];
    server = createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ state: 'unclaimed', version: null, imageVersion: '0.2.0' }));
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

  it('reports a non-200 answer without following it', async () => {
    await start(fixtureTls, 302);
    await expect(discoverRuntime(origin, 2_000)).resolves.toMatchObject({ status: 302 });
    expect(seen).toHaveLength(1);
  });
});
