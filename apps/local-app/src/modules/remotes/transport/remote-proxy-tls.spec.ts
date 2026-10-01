import { createServer, type Server } from 'node:tls';
import type { AddressInfo, Socket } from 'node:net';
import { fixtureTls } from '../../../common/test/tls-fixture';
import {
  originKey,
  originKeyOfUrl,
  pinnedUndiciConnector,
  pinnedWsConnection,
  RemoteOriginUnknownError,
} from './remote-proxy-tls';

describe('originKey', () => {
  it.each([
    ['10.0.0.1', '3000', '10.0.0.1:3000'],
    ['LAB.example', 3000, 'lab.example:3000'],
    ['[fd00::1]', '3000', 'fd00::1:3000'],
    ['fd00::1', 3000, 'fd00::1:3000'],
    ['10.0.0.1', '', '10.0.0.1:443'],
    ['10.0.0.1', undefined, '10.0.0.1:443'],
  ])('%s with port %p is %s', (host, port, expected) => {
    expect(originKey(host, port)).toBe(expected);
  });

  it('matches the key of a stored address', () => {
    expect(originKeyOfUrl('https://[FD00::1]:3000')).toBe(originKey('fd00::1', '3000'));
    expect(originKeyOfUrl('https://10.0.0.1')).toBe('10.0.0.1:443');
  });
});

describe('pinned connectors', () => {
  let server: Server;
  let port: number;
  let connections: number;

  beforeAll(async () => {
    connections = 0;
    server = createServer({ key: fixtureTls.key, cert: fixtureTls.cert }, (socket) => {
      connections += 1;
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const known = (origin: string) => (origin === `127.0.0.1:${port}` ? fixtureTls.cert : null);

  const connectUndici = (protocol: string, lookup = known) =>
    new Promise<Socket>((resolve, reject) =>
      pinnedUndiciConnector(lookup)(
        { protocol, hostname: '127.0.0.1', port: String(port) },
        (error, socket) => (error ? reject(error) : resolve(socket as Socket)),
      ),
    );

  it('opens a verified TLS socket for a known origin', async () => {
    const socket = await connectUndici('https:');
    expect((socket as unknown as { authorized: boolean }).authorized).toBe(true);
    socket.destroy();
  });

  it('refuses plain http and unknown origins without connecting', async () => {
    const before = connections;
    await expect(connectUndici('http:')).rejects.toThrow(/https only/);
    await expect(connectUndici('https:', () => null)).rejects.toBeInstanceOf(
      RemoteOriginUnknownError,
    );
    expect(connections).toBe(before);
  });

  it('gives ws a socket that fails at once for an unknown origin', async () => {
    const socket = pinnedWsConnection(() => null)({ host: '127.0.0.1', port });
    await expect(
      new Promise((_resolve, reject) => socket.once('error', reject)),
    ).rejects.toBeInstanceOf(RemoteOriginUnknownError);
  });
});
