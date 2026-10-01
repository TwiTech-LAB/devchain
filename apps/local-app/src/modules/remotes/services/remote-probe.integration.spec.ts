import { createServer as createHttpsServer, type Server } from 'node:https';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { getAppVersion } from '../../../common/app-version';
import { resetEnvConfig } from '../../../common/config/env.config';
import { FakeBootstrapServer } from '../../../common/test/fake-bootstrap.server';
import { fixtureTls } from '../../../common/test/tls-fixture';
import { BASE_URL_MESSAGE } from '../dtos/remote.dto';
import { RemoteProbeController } from '../controllers/remote-probe.controller';
import { RemoteHostClient } from '../operations/remote-host.client';
import { RemoteProbeService, type RemoteProbeOptions } from './remote-probe.service';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

type Handler = (path: string) => { status: number; body: unknown } | 'hang';

const servers: Server[] = [];

async function listen(server: Server | ReturnType<typeof createTcpServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as AddressInfo).port;
}

/** An HTTPS server that answers every path with `handler`; counts its requests. */
async function httpsServer(handler: Handler): Promise<{ port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = createHttpsServer({ key: fixtureTls.key, cert: fixtureTls.cert }, (req, res) => {
    requests.push(req.url ?? '');
    const answer = handler(req.url ?? '');
    if (answer === 'hang') return;
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
  servers.push(server);
  return { port: await listen(server), requests };
}

/** A port nothing listens on: bound once, then released. */
async function closedPort(): Promise<number> {
  const server = createTcpServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// Integration: real HTTPS and TCP sockets through the production RemoteHostClient;
// only the registration lookup is a stub, and it records any write attempt.
describe('POST /api/remotes/probe', () => {
  let homePort: number;
  let installer: FakeBootstrapServer;
  let remotes: Array<{ id: string; baseUrl: string | null }>;
  let storage: {
    listRemotes: jest.Mock;
    createRemote: jest.Mock;
    createRemoteOperation: jest.Mock;
  };

  function controller(options: Partial<RemoteProbeOptions> = {}) {
    const service = new RemoteProbeService(
      storage as never,
      new RemoteHostClient(
        storage as never,
        { get: async () => null, headers: async () => ({}) } as never,
      ),
      {} as never,
      {} as never,
      { installerPort: 3000, sshTimeoutMs: 2_000, ...options },
    );
    return new RemoteProbeController(service);
  }

  beforeAll(async () => {
    homePort = await closedPort();
  });

  beforeEach(async () => {
    // The shared setup pins PORT to 3000 before each test, where a real
    // DevChain may run on a developer's PC; this PC's port must answer nothing.
    process.env.PORT = String(homePort);
    resetEnvConfig();
    remotes = [];
    storage = {
      listRemotes: jest.fn(async () => ({ items: remotes, total: remotes.length })),
      createRemote: jest.fn(),
      createRemoteOperation: jest.fn(),
    };
    installer = new FakeBootstrapServer();
    await installer.listen();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => installer.server.close(() => resolve()));
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
    expect(storage.createRemote).not.toHaveBeenCalled();
    expect(storage.createRemoteOperation).not.toHaveBeenCalled();
  });

  it('classifies the installer by its body, whose version is null', async () => {
    const result = await controller().probe({ address: installer.url, checkSsh: false });

    expect(result).toEqual({
      kind: 'installer',
      bootstrapUrl: installer.url,
      state: 'unclaimed',
      imageVersion: '1.3.0',
      supported: true,
      remoteId: null,
    });
  });

  it('marks an installer image older than the claim accepts as unsupported', async () => {
    installer.imageVersion = '0.0.9';
    await expect(
      controller().probe({ address: installer.url, checkSsh: false }),
    ).resolves.toMatchObject({ kind: 'installer', supported: false });
  });

  it("finds an installer's registration at the DevChain address it will start", async () => {
    const installerPort = Number(new URL(installer.url).port);
    remotes = [{ id: 'registered', baseUrl: `https://127.0.0.1:${homePort}` }];

    const result = await controller({ installerPort }).probe({
      address: '127.0.0.1',
      checkSsh: false,
    });

    expect(result).toMatchObject({
      kind: 'installer',
      bootstrapUrl: installer.url,
      remoteId: 'registered',
    });
  });

  it("finds DevChain on the installer's port while this PC uses another port", async () => {
    const devchain = await httpsServer(() => ({
      status: 200,
      body: { version: getAppVersion(), homePath: homedir(), bootId: 'x' },
    }));
    const origin = `https://127.0.0.1:${devchain.port}`;
    remotes = [
      { id: 'other', baseUrl: `https://127.0.0.1:${homePort}` },
      { id: 'answering', baseUrl: origin },
    ];

    const result = await controller({ installerPort: devchain.port }).probe({
      address: '127.0.0.1',
      checkSsh: false,
    });

    expect(result).toEqual({
      kind: 'devchain',
      baseUrl: origin,
      version: getAppVersion(),
      versionMatches: true,
      homePath: homedir(),
      homePathMatches: true,
      remoteId: 'answering',
    });
  });

  it('reports a different version and home folder', async () => {
    const devchain = await httpsServer(() => ({
      status: 200,
      body: { version: '0.0.1-other', homePath: '/home/someone-else' },
    }));

    await expect(
      controller().probe({ address: `127.0.0.1:${devchain.port}`, checkSsh: false }),
    ).resolves.toMatchObject({
      kind: 'devchain',
      versionMatches: false,
      homePathMatches: false,
      remoteId: null,
    });
  });

  it('probes only the port written in the address', async () => {
    const other = await httpsServer(() => ({ status: 200, body: { version: getAppVersion() } }));
    const explicit = await closedPort();

    const result = await controller({ installerPort: other.port }).probe({
      address: `https://127.0.0.1:${explicit}`,
      checkSsh: false,
    });

    expect(result).toEqual({
      kind: 'nothing',
      tried: [`https://127.0.0.1:${explicit}`],
      sshReachable: null,
    });
    expect(other.requests).toEqual([]);
  });

  it('treats another web server that answers 200 as nothing and reports SSH', async () => {
    const web = await httpsServer(() => ({ status: 200, body: { hello: 'world' } }));
    const ssh = createTcpServer((socket) => socket.end());
    const sshPort = await listen(ssh);
    try {
      const result = await controller({ installerPort: web.port, sshPort }).probe({
        address: '127.0.0.1',
        checkSsh: true,
      });

      expect(result).toEqual({
        kind: 'nothing',
        tried: [`https://127.0.0.1:${homePort}`, `https://127.0.0.1:${web.port}`],
        sshReachable: true,
      });
    } finally {
      await new Promise<void>((resolve) => ssh.close(() => resolve()));
    }
  });

  it('reports a closed SSH port as unreachable', async () => {
    const result = await controller({
      installerPort: await closedPort(),
      sshPort: await closedPort(),
    }).probe({
      address: '127.0.0.1',
      checkSsh: true,
    });
    expect(result).toMatchObject({ kind: 'nothing', sshReachable: false });
  });

  it('answers within the 5 s runtime timeout when every probe hangs', async () => {
    const first = await httpsServer(() => 'hang');
    const second = await httpsServer(() => 'hang');
    process.env.PORT = String(first.port);
    resetEnvConfig();
    const started = Date.now();
    try {
      const result = await controller({ installerPort: second.port }).probe({
        address: '127.0.0.1',
        checkSsh: false,
      });
      expect(result).toMatchObject({ kind: 'nothing' });
    } finally {
      process.env.PORT = String(homePort);
      resetEnvConfig();
    }
    // Two sequential probes would take 10 s.
    expect(Date.now() - started).toBeLessThan(7_000);
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
  }, 15_000);

  it.each([
    'ftp://127.0.0.1',
    'http://127.0.0.1:4000',
    'https://127.0.0.1:4000/path',
    'https://user:pw@127.0.0.1',
    'https://127.0.0.1:99999',
  ])('refuses %s with the address rule', async (address) => {
    await expect(controller().probe({ address, checkSsh: false })).rejects.toMatchObject({
      statusCode: 400,
      message: BASE_URL_MESSAGE,
    });
    expect(storage.listRemotes).not.toHaveBeenCalled();
  });
});
