// Home and a claimed host as full AppModule apps, with the host's TLS front
// seeing a LAN peer: every call that works here went over TLS pinned to the
// VM certificate, and the plaintext and wrong-certificate paths are refused.
import { randomBytes } from 'node:crypto';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { connect as netConnect, type Socket as NetSocket } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
} from '../../common/test/two-instance.fixture';
import { FIXTURE_TLS_NAME, fixtureTls, otherTls } from '../../common/test/tls-fixture';
import { RemoteHostClient } from './operations/remote-host.client';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from './ports/remote-health.port';
import type { Project, Remote, Status } from '../storage/models/domain.models';

const LAN_PEER = '192.0.2.10';

interface Envelope {
  topic: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Makes the host's TLS front see `current()` as the raw peer. Prepended after
 * the fixture set the front up, so it runs before the front; null keeps the
 * real loopback peer.
 */
function overrideFrontPeer(instances: TwoInstances, current: () => string | null): void {
  instances.host.app.getHttpServer().prependListener('connection', (socket: NetSocket) => {
    const peer = current();
    if (peer) Object.defineProperty(socket, 'remoteAddress', { get: () => peer });
  });
}

async function makeProject(instances: TwoInstances): Promise<{ project: Project; status: Status }> {
  const project = await instances.host.storage.createProject({
    name: 'Pinned project',
    description: null,
    rootPath: `${instances.host.dataDir}/workspace`,
    isTemplate: false,
  });
  const statuses = await instances.host.storage.listStatuses(project.id);
  const status =
    statuses.items[0] ??
    (await instances.host.storage.createStatus({
      projectId: project.id,
      label: 'New',
      color: '#888888',
      position: 0,
    }));
  return { project, status };
}

function connectThroughProxy(homeUrl: string, remoteId: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(homeUrl, {
      path: `/r/${remoteId}/socket.io`,
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => {
      socket.close();
      reject(error);
    });
  });
}

/** A direct wss connection to the host, trusting only the VM certificate. */
function connectToHostOverWss(
  hostUrl: string,
  namespace: string,
  authorization?: string,
): Promise<'connected' | 'refused'> {
  const agent = new HttpsAgent({ ca: fixtureTls.cert, servername: FIXTURE_TLS_NAME });
  return new Promise((resolve) => {
    const socket = io(`${hostUrl.replace(/^http:/, 'https:')}${namespace}`, {
      agent: agent as unknown as string,
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      timeout: 5000,
      extraHeaders: authorization ? { authorization } : {},
    });
    const finish = (outcome: 'connected' | 'refused') => {
      socket.close();
      agent.destroy();
      resolve(outcome);
    };
    socket.once('connect', () => finish('connected'));
    socket.once('connect_error', () => finish('refused'));
  });
}

function httpsToHost(
  hostUrl: string,
  path: string,
  authorization?: string,
): Promise<{ status: number; body: string }> {
  const { port } = new URL(hostUrl);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        agent: false,
        ca: fixtureTls.cert,
        servername: FIXTURE_TLS_NAME,
        headers: authorization ? { authorization } : {},
      },
      (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/** Sends a plaintext request on a raw socket; resolves with every byte the host answered. */
function rawPlaintext(hostUrl: string, request: string): Promise<string> {
  const { port } = new URL(hostUrl);
  return new Promise((resolve) => {
    const socket = netConnect(Number(port), '127.0.0.1', () => socket.write(request));
    let received = '';
    socket.on('data', (chunk: Buffer) => (received += chunk.toString('utf8')));
    socket.on('error', () => undefined);
    socket.on('close', () => resolve(received));
  });
}

describe('pinned TLS between home and a claimed host', () => {
  let instances: TwoInstances;
  let remote: Remote;
  let project: Project;
  let status: Status;
  let hostKey: string;
  let frontPeer: string | null = LAN_PEER;

  beforeAll(async () => {
    hostKey = `dck_${randomBytes(32).toString('base64url')}`;
    instances = await startTwoInstances({ claimedHost: { key: hostKey } });
    overrideFrontPeer(instances, () => frontPeer);
    ({ project, status } = await makeProject(instances));
    remote = await instances.registerRemote('pinned-host');
    await instances.bindProject(project.id, remote.id);
    await waitForValue(async () => {
      const response = await fetch(`${instances.home.url}/api/remotes`);
      const body = (await response.json()) as { items: Array<{ id: string; online: boolean }> };
      return body.items.find((item) => item.id === remote.id && item.online);
    }, 15_000);
  }, 60_000);

  afterEach(() => {
    frontPeer = LAN_PEER;
    instances.hostApiKey!.setSeenPeerAddress(LAN_PEER);
  });

  afterAll(async () => {
    await instances?.close();
  });

  it('registers the host by https with its certificate and keeps it online', async () => {
    const stored = await instances.home.storage.getRemote(remote.id);
    expect(stored.baseUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    expect(stored.tlsCertificate?.trim()).toBe(fixtureTls.cert.trim());
  });

  it('serves board and chat requests through /r', async () => {
    const created = await fetch(`${instances.home.url}/r/${remote.id}/api/epics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, title: 'Over TLS', statusId: status.id }),
    });
    expect(created.status).toBe(201);
    const epic = (await created.json()) as { id: string };

    const board = await fetch(
      `${instances.home.url}/r/${remote.id}/api/epics?projectId=${project.id}`,
    );
    expect(board.status).toBe(200);
    const listed = (await board.json()) as { items: Array<{ id: string }> };
    expect(listed.items.map((item) => item.id)).toContain(epic.id);

    const agents = await fetch(
      `${instances.home.url}/r/${remote.id}/api/agents?projectId=${project.id}&includeGuests=true`,
    );
    expect(agents.status).toBe(200);
    const sessions = await fetch(
      `${instances.home.url}/r/${remote.id}/api/sessions?projectId=${project.id}`,
    );
    expect(sessions.status).toBe(200);
  });

  it('carries the terminal and Socket.IO events over wss through /r', async () => {
    const socket = await connectThroughProxy(instances.home.url, remote.id);
    try {
      const envelopes: Envelope[] = [];
      socket.on('message', (envelope: Envelope) => envelopes.push(envelope));

      const sessionId = `pinned-${randomBytes(4).toString('hex')}`;
      socket.emit('terminal:subscribe', { sessionId });
      await waitForValue(
        async () =>
          envelopes.find(
            (envelope) =>
              envelope.topic === `terminal/${sessionId}` && envelope.type === 'subscribed',
          ),
        10_000,
      );

      const response = await fetch(`${instances.home.url}/r/${remote.id}/api/epics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, title: 'Pushed', statusId: status.id }),
      });
      const epic = (await response.json()) as { id: string };
      await waitForValue(
        async () =>
          envelopes.find(
            (envelope) =>
              envelope.topic === `project/${project.id}/epics` &&
              envelope.type === 'created' &&
              envelope.payload.epicId === epic.id,
          ),
        10_000,
      );
    } finally {
      socket.close();
    }
  });

  it('answers 401 without the key over HTTPS and refuses the handshake over WSS', async () => {
    const keyless = await httpsToHost(instances.host.url, '/health');
    expect(keyless.status).toBe(401);
    expect(keyless.body).toContain('HOST_API_KEY_REJECTED');
    expect((await httpsToHost(instances.host.url, '/health', `Bearer ${hostKey}`)).status).toBe(
      200,
    );

    for (const namespace of ['/', '/mcp']) {
      await expect(connectToHostOverWss(instances.host.url, namespace)).resolves.toBe('refused');
      await expect(
        connectToHostOverWss(instances.host.url, namespace, `Bearer ${hostKey}`),
      ).resolves.toBe('connected');
    }
  });

  it('closes plaintext from a LAN peer without an answer, the key included', async () => {
    const answer = await rawPlaintext(
      instances.host.url,
      `GET /health HTTP/1.1\r\nHost: vm\r\nAuthorization: Bearer ${hostKey}\r\n\r\n`,
    );
    expect(answer).toBe('');
  });

  it('answers MCP over loopback plaintext on the VM without a key', async () => {
    frontPeer = null;
    instances.hostApiKey!.setSeenPeerAddress('127.0.0.1');
    const response = await fetch(`${instances.host.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result?: { tools?: unknown[] } };
    expect(body.result?.tools?.length).toBeGreaterThan(0);
  });
});

// Its own instances: the proxy's connection pool must hold no connection the
// right certificate opened before the stored one changes.
describe('a host that shows another certificate than the stored one', () => {
  let instances: TwoInstances;
  let remote: Remote;
  let project: Project;
  const seen: Array<{ method?: string; url?: string; authorization?: string }> = [];
  let upgrades = 0;

  beforeAll(async () => {
    const hostKey = `dck_${randomBytes(32).toString('base64url')}`;
    instances = await startTwoInstances({ claimedHost: { key: hostKey } });
    overrideFrontPeer(instances, () => LAN_PEER);
    ({ project } = await makeProject(instances));
    remote = await instances.registerRemote('pinned-host');
    await instances.bindProject(project.id, remote.id);
    const health = instances.home.app.get<RemoteHealthPort>(REMOTE_HEALTH_PORT);
    await waitForValue(async () => health.getState(remote.id).online, 15_000);
    // Home now pins a certificate the host does not have; a poll already in
    // flight with the right one ends before the host is watched.
    await instances.home.storage.updateRemoteTlsCertificate(remote.id, otherTls.cert);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const server = instances.host.app.getHttpServer();
    server.on('request', (request) =>
      seen.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
      }),
    );
    server.on('upgrade', () => (upgrades += 1));
  }, 60_000);

  afterAll(async () => {
    await instances?.close();
  });

  it('sends no request, key or body on direct calls and on both proxy paths', async () => {
    // Keeps the proxy's health gate open, so each /r call reaches the connector.
    const health = instances.home.app.get<RemoteHealthPort>(REMOTE_HEALTH_PORT);
    const gate = jest.spyOn(health, 'getState').mockReturnValue({
      ...health.getState(remote.id),
      online: true,
      versionMatches: true,
      apiKeyRejected: false,
    });
    try {
      const hostClient = instances.home.app.get(RemoteHostClient);
      await expect(hostClient.projectExists(remote.id, project.id)).rejects.toThrow();
      await expect(hostClient.dockerVersion(remote.id)).rejects.toThrow();

      const proxied = await fetch(`${instances.home.url}/r/${remote.id}/api/epics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, title: 'must not arrive' }),
      });
      expect(proxied.status).toBeGreaterThanOrEqual(500);

      await expect(connectThroughProxy(instances.home.url, remote.id)).rejects.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(seen).toEqual([]);
      expect(upgrades).toBe(0);
    } finally {
      gate.mockRestore();
    }
    // The proxy accepts the browser's upgrade before it dials the VM, so the
    // client learns of the failure only at its own connect timeout.
  }, 20_000);

  it('marks the host offline through the health poll', async () => {
    const health = instances.home.app.get<RemoteHealthPort>(REMOTE_HEALTH_PORT);
    await waitForValue(async () => !health.getState(remote.id).online, 10_000);
    expect(seen).toEqual([]);
  });
});
