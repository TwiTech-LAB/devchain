import { createServer, request as httpRequest, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { createSecureContext } from 'node:tls';
import {
  FIXTURE_TLS_NAME as CERT_NAME,
  fixtureTls,
  otherTls,
} from '../../../common/test/tls-fixture';
import { installTlsFront } from './host-tls-front';

const { key, cert } = fixtureTls;

interface Answer {
  status: number;
  body: { peer: string | undefined; encrypted: boolean; url: string };
}

// Real sockets on loopback: the front works on raw TCP bytes, so nothing is faked
// except the peer address a test sets to look like a LAN caller.
describe('installTlsFront', () => {
  let server: Server;
  let port: number;
  /** The raw peer the front sees; null keeps the real loopback address. */
  let frontPeer: string | null;

  const start = async (options: { firstByteTimeoutMs?: number; handshakeTimeoutMs?: number }) => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          peer: req.socket.remoteAddress,
          encrypted: 'encrypted' in req.socket && req.socket.encrypted === true,
          url: req.url,
        }),
      );
    });
    installTlsFront(server, { secureContext: createSecureContext({ key, cert }), ...options });
    // Runs before the front on the raw socket, as a LAN peer would look to it.
    server.prependListener('connection', (socket: Socket) => {
      const peer = frontPeer;
      if (peer) Object.defineProperty(socket, 'remoteAddress', { get: () => peer });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  };

  const collect = (resolve: (answer: Answer) => void) => (res: import('http').IncomingMessage) => {
    let text = '';
    res.on('data', (chunk) => (text += chunk));
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
  };

  const plain = (path = '/') =>
    new Promise<Answer>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, agent: false }, collect(resolve));
      req.on('error', reject);
      req.end();
    });

  const secure = (path = '/', ca: string = cert) =>
    new Promise<Answer>((resolve, reject) => {
      const req = httpsRequest(
        { host: '127.0.0.1', port, path, agent: false, ca, servername: CERT_NAME },
        collect(resolve),
      );
      req.on('error', reject);
      req.end();
    });

  /** Everything the server sends before it closes the connection. */
  const rawExchange = (send: (socket: Socket) => void) =>
    new Promise<{ received: string; ms: number }>((resolve) => {
      const started = Date.now();
      const socket = netConnect(port, '127.0.0.1', () => send(socket));
      let received = '';
      socket.on('data', (chunk) => (received += chunk.toString('latin1')));
      socket.on('error', () => undefined);
      socket.on('close', () => resolve({ received, ms: Date.now() - started }));
    });

  beforeEach(() => {
    frontPeer = null;
  });

  afterEach(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
  });

  it('answers loopback plaintext, pipelined requests included', async () => {
    await start({});
    await expect(plain('/a')).resolves.toEqual({
      status: 200,
      body: { peer: '127.0.0.1', encrypted: false, url: '/a' },
    });

    const { received } = await rawExchange((socket) =>
      socket.write(
        'GET /1 HTTP/1.1\r\nHost: x\r\n\r\nGET /2 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
      ),
    );
    expect(received.match(/HTTP\/1\.1 200 OK/g)).toHaveLength(2);
    expect(received).toContain('"url":"/2"');
  });

  it('answers TLS with the real peer address', async () => {
    await start({});
    await expect(secure('/b')).resolves.toEqual({
      status: 200,
      body: { peer: '127.0.0.1', encrypted: true, url: '/b' },
    });
  });

  it('answers TLS from a non-loopback peer', async () => {
    await start({});
    frontPeer = '192.0.2.10';
    await expect(secure('/c')).resolves.toMatchObject({ status: 200, body: { encrypted: true } });
  });

  it.each(['192.0.2.10', '::ffff:192.0.2.10', '10.0.0.5', '::1.2.3.4'])(
    'closes plaintext from %s without an answer',
    async (peer) => {
      await start({});
      frontPeer = peer;
      const { received } = await rawExchange((socket) =>
        socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'),
      );
      expect(received).toBe('');
    },
  );

  it.each(['::1', '::ffff:127.0.0.1', '127.0.0.2'])('answers plaintext from %s', async (peer) => {
    await start({});
    frontPeer = peer;
    await expect(plain()).resolves.toMatchObject({ status: 200 });
  });

  it('closes a connection that sends no first byte after the timeout', async () => {
    await start({ firstByteTimeoutMs: 150 });
    const { received, ms } = await rawExchange(() => undefined);
    expect(received).toBe('');
    expect(ms).toBeGreaterThanOrEqual(140);
    expect(ms).toBeLessThan(2_000);
  });

  it('closes a peer that ends its side before any byte', async () => {
    await start({ firstByteTimeoutMs: 10_000 });
    const { received, ms } = await rawExchange((socket) => socket.end());
    expect(received).toBe('');
    expect(ms).toBeLessThan(2_000);
  });

  it('closes a TLS handshake that stalls', async () => {
    await start({ handshakeTimeoutMs: 150 });
    // A handshake record header without the rest of the ClientHello.
    const { received, ms } = await rawExchange((socket) =>
      socket.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x40])),
    );
    expect(received).toBe('');
    expect(ms).toBeGreaterThanOrEqual(140);
    expect(ms).toBeLessThan(2_000);
  });

  it('fails the handshake for a client that trusts another certificate', async () => {
    await start({});
    await expect(secure('/', otherTls.cert)).rejects.toThrow();
    // The server keeps serving after a failed handshake.
    await expect(secure('/')).resolves.toMatchObject({ status: 200 });
  });

  it('lets close() finish while connections wait in the front', async () => {
    await start({ firstByteTimeoutMs: 60_000, handshakeTimeoutMs: 60_000 });
    const silent = netConnect(port, '127.0.0.1');
    // A handshake record header without the rest of the ClientHello.
    const stalled = netConnect(port, '127.0.0.1', () =>
      stalled.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x40])),
    );
    for (const socket of [silent, stalled]) socket.on('error', () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const started = Date.now();
    await new Promise((resolve) => server.close(resolve));
    expect(Date.now() - started).toBeLessThan(1_000);
    silent.destroy();
    stalled.destroy();
  });

  it('refuses a second install and an install after listen', async () => {
    await start({});
    const context = createSecureContext({ key, cert });
    expect(() => installTlsFront(server, { secureContext: context })).toThrow(/already installed/);
    const listening = createServer();
    await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
    try {
      expect(() => installTlsFront(listening, { secureContext: context })).toThrow(
        /before the server listens/,
      );
    } finally {
      await new Promise((resolve) => listening.close(resolve));
    }
  });
});
