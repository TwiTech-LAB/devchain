import { createServer as createHttpsServer, type Server } from 'node:https';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { fixtureTls, otherTls } from '../../../common/test/tls-fixture';
import { certificateFingerprint } from '../../../common/tls/certificate';
import { DockerEngineClient } from '../../core/controllers/docker-engine.client';
import {
  pinnedTlsOptions,
  remoteFetch,
  requireRemoteCertificate,
  requireRemoteTls,
} from './remote-tls';

const listen = async <T extends Server | TlsServer>(
  server: T,
): Promise<{ server: T; port: number }> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
};
const close = (server: Server | TlsServer) =>
  new Promise<void>((resolve) => {
    if ('closeAllConnections' in server) server.closeAllConnections();
    server.close(() => resolve());
  });

// Real TLS on loopback by IP: the fixture certificate names only `devchain-host`,
// so every passing call proves the fingerprint check replaced the name check.
describe('remoteFetch', () => {
  const servers: Array<Server | TlsServer> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
  });

  const serve = async (
    tls: { key: string; cert: string },
    handler: Parameters<typeof createHttpsServer>[1],
  ) => {
    const { server, port } = await listen(
      createHttpsServer({ key: tls.key, cert: tls.cert }, handler),
    );
    servers.push(server);
    return `https://127.0.0.1:${port}`;
  };

  it('reaches a VM whose certificate matches the pin, by IP address', async () => {
    const origin = await serve(fixtureTls, (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ path: req.url, authorization: req.headers.authorization }));
    });
    const response = await remoteFetch(
      `${origin}/api/runtime`,
      { headers: { authorization: 'Bearer k' } },
      fixtureTls.cert,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      path: '/api/runtime',
      authorization: 'Bearer k',
    });
  });

  it('fails before any request byte reaches a VM with another certificate', async () => {
    const received: Buffer[] = [];
    let handshakes = 0;
    const tlsServer = createTlsServer({ key: otherTls.key, cert: otherTls.cert }, (socket) => {
      handshakes += 1;
      socket.on('data', (chunk: Buffer) => received.push(chunk));
      socket.on('error', () => undefined);
    });
    tlsServer.on('tlsClientError', () => undefined);
    const { port } = await listen(tlsServer);
    servers.push(tlsServer);

    await expect(
      remoteFetch(
        `https://127.0.0.1:${port}/api/host/provider-auth`,
        {
          method: 'POST',
          headers: { authorization: 'Bearer secret-key', 'content-type': 'application/json' },
          body: JSON.stringify({ token: 'secret-body' }),
        },
        fixtureTls.cert,
      ),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The client drops the connection inside the handshake, so no decrypted
    // byte (request line, Authorization, body) ever arrives.
    expect(Buffer.concat(received).length).toBe(0);
    expect(Buffer.concat(received).toString()).not.toContain('secret');
    expect(handshakes).toBeLessThanOrEqual(1);
  });

  it('refuses to follow a redirect', async () => {
    let followed = false;
    const origin = await serve(fixtureTls, (req, res) => {
      if (req.url === '/elsewhere') {
        followed = true;
        res.end('{}');
        return;
      }
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    });
    await expect(remoteFetch(`${origin}/api/runtime`, {}, fixtureTls.cert)).rejects.toThrow();
    expect(followed).toBe(false);
  });

  it('refuses a plain http address', async () => {
    await expect(
      remoteFetch('http://127.0.0.1:1/api/runtime', {}, fixtureTls.cert),
    ).rejects.toThrow(/https only/);
  });

  it('streams an upload with duplex half and a download', async () => {
    const origin = await serve(fixtureTls, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.end(Buffer.concat(chunks).toString('utf8').toUpperCase());
      });
    });
    const response = await remoteFetch(
      `${origin}/upload`,
      {
        method: 'PUT',
        body: Readable.from(['abc', 'def']) as unknown as BodyInit,
        duplex: 'half',
      },
      fixtureTls.cert,
    );
    await expect(response.text()).resolves.toBe('ABCDEF');
  });

  it('uses a separate pool per certificate', async () => {
    const first = await serve(fixtureTls, (_req, res) => res.end('first'));
    const second = await serve(otherTls, (_req, res) => res.end('second'));
    await expect((await remoteFetch(first, {}, fixtureTls.cert)).text()).resolves.toBe('first');
    await expect((await remoteFetch(second, {}, otherTls.cert)).text()).resolves.toBe('second');
    // The first pin still refuses the second VM after both were reached.
    await expect(remoteFetch(second, {}, fixtureTls.cert)).rejects.toThrow();
  });
});

describe('pinnedTlsOptions', () => {
  it('trusts one certificate, keeps chain checks on and checks the fingerprint', () => {
    const options = pinnedTlsOptions(fixtureTls.cert);
    expect(options.ca).toEqual([fixtureTls.cert]);
    expect(options.rejectUnauthorized).toBe(true);
    const fingerprint = certificateFingerprint(fixtureTls.cert).replace(/(..)(?!$)/g, '$1:');
    expect(
      options.checkServerIdentity('10.0.0.1', { fingerprint256: fingerprint } as never),
    ).toBeUndefined();
    expect(
      options.checkServerIdentity('10.0.0.1', {
        fingerprint256: certificateFingerprint(otherTls.cert),
      } as never),
    ).toBeInstanceOf(Error);
  });
});

describe('requireRemoteTls', () => {
  const remote = {
    id: 'r1',
    name: 'lab',
    baseUrl: 'https://10.0.0.1:3000',
    tlsCertificate: fixtureTls.cert,
  };

  it('returns the address and the certificate', () => {
    expect(requireRemoteTls(remote)).toEqual({
      baseUrl: remote.baseUrl,
      certificate: fixtureTls.cert,
    });
  });

  it('refuses a remote without a certificate and names the next action', () => {
    expect(() => requireRemoteCertificate({ ...remote, tlsCertificate: null })).toThrow(
      /Add the VM again or reset it/,
    );
    try {
      requireRemoteTls({ ...remote, tlsCertificate: null });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as { details?: { code?: string } }).details?.code).toBe(
        'REMOTE_TLS_CERTIFICATE_MISSING',
      );
    }
  });
});

describe('DockerEngineClient.forHttp', () => {
  let server: Server;
  let origin: string;

  beforeEach(async () => {
    const created = await listen(
      createHttpsServer({ key: fixtureTls.key, cert: fixtureTls.cert }, (req, res) => {
        if (req.url === '/version') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ApiVersion: '1.45', MinAPIVersion: '1.24' }));
          return;
        }
        if (req.url === '/archive') {
          res.writeHead(200, { trailer: 'x-digest' });
          res.write('tar-bytes');
          res.addTrailers({ 'x-digest': 'abc' });
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      }),
    );
    server = created.server;
    origin = `https://127.0.0.1:${created.port}`;
  });

  afterEach(() => close(server));

  it('refuses plain http', () => {
    expect(() =>
      DockerEngineClient.forHttp('http://127.0.0.1:1', pinnedTlsOptions(fixtureTls.cert)),
    ).toThrow(/Unsupported Docker transport/);
  });

  it('reads JSON and a stream with trailers over the pinned connection', async () => {
    const client = DockerEngineClient.forHttp(origin, pinnedTlsOptions(fixtureTls.cert));
    await expect(client.version()).resolves.toEqual({ ApiVersion: '1.45', MinAPIVersion: '1.24' });
    let trailer: string | undefined;
    const stream = await client.stream('GET', '/archive', {
      unversioned: true,
      onTrailers: (trailers) => (trailer = trailers['x-digest']),
    });
    let text = '';
    for await (const chunk of stream) text += chunk.toString();
    expect(text).toBe('tar-bytes');
    expect(trailer).toBe('abc');
  });

  it('fails against a VM with another certificate', async () => {
    const client = DockerEngineClient.forHttp(origin, pinnedTlsOptions(otherTls.cert));
    await expect(client.version()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('cancels a request', async () => {
    const client = DockerEngineClient.forHttp(origin, pinnedTlsOptions(fixtureTls.cert));
    const controller = new AbortController();
    controller.abort();
    await expect(client.version(controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('pinned consumers', () => {
  const SRC = join(__dirname, '../../..');
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(name) && !/\.(spec|test)\.tsx?$/.test(name) ? [path] : [];
    });

  it('never turn off certificate checks; only discovery reads an untrusted certificate', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => /rejectUnauthorized:\s*false/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual(['modules/remotes/transport/remote-discovery.ts']);
  });
});
