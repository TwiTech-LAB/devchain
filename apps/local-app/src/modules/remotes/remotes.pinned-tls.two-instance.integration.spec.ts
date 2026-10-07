import { randomBytes, createHash } from 'node:crypto';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { Socket as NetSocket } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
} from '../../common/test/two-instance.fixture';
import { FIXTURE_TLS_NAME, fixtureTls, otherTls } from '../../common/test/tls-fixture';
import { RemoteHostClient } from './operations/remote-host.client';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from './ports/remote-health.port';
import { type Project, type Remote, type Status } from '../storage/models/domain.models';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { FakeDockerEngine } from '../../common/test/fake-docker-engine.server';
import { RemoteApiKeyService } from './auth/remote-api-key.service';

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
  const rootPath = join(instances.host.dataDir, 'workspace');
  mkdirSync(rootPath, { recursive: true });
  const project = await instances.host.storage.createProject({
    name: 'Pinned project',
    description: null,
    rootPath,
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

function connectThroughProxy(homeUrl: string, remoteId: string, timeoutMs = 5000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(homeUrl, {
      path: `/r/${remoteId}/socket.io`,
      transports: ['websocket'],
      reconnection: false,
      timeout: timeoutMs,
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

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

interface RemoteListItem {
  id: string;
  name: string;
  online: boolean;
  apiKeyRejected: boolean;
  version: string | null;
  versionMatches: boolean;
}

// Every direct host call opens its own connection, so it always reports the
// peer address the fixture currently injects instead of a pooled one.
function fetchHost(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const secure = url.startsWith('https:');
  const send = secure ? httpsRequest : httpRequest;
  // The VM certificate names only devchain-host.
  const tls = secure ? { ca: fixtureTls.cert, servername: FIXTURE_TLS_NAME } : {};
  return new Promise((resolve, reject) => {
    const request = send(url, { agent: false, headers, ...tls }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('Host request timed out')));
    request.end();
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
    instances.home.sqlite
      .prepare('UPDATE projects SET name = ? WHERE id = ?')
      .run('Home copy', project.id);
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
      expect(response.status).toBe(201);
      const epic = (await response.json()) as { id: string };
      const created = await waitForValue(
        async () =>
          envelopes.find(
            (envelope) =>
              envelope.topic === `project/${project.id}/epics` &&
              envelope.type === 'created' &&
              envelope.payload.epicId === epic.id,
          ),
        10_000,
      );
      expect(created.payload).toMatchObject({ projectId: project.id, title: 'Pushed' });
      expect(await instances.host.storage.getEpic(epic.id)).toMatchObject({ id: epic.id });
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

  describe('the host API key boundary between home and a claimed host', () => {
    let hostClient: RemoteHostClient;
    let engine: FakeDockerEngine;
    let savedDockerHost: string | undefined;
    let savedNpmRegistry: string | undefined;

    const listRemotes = async (): Promise<RemoteListItem[]> => {
      const response = await fetch(`${instances.home.url}/api/remotes`);
      const body = (await response.json()) as { items: RemoteListItem[] };
      return body.items;
    };
    const remoteEntry = (predicate: (item: RemoteListItem) => boolean) =>
      waitForValue(async () => (await listRemotes()).find(predicate), 15_000);

    beforeAll(async () => {
      hostClient = instances.home.app.get(RemoteHostClient);

      // A claimed host manages its provider CLIs, so the background installer
      // may run npm; a dead local registry keeps that inside the machine.
      savedNpmRegistry = process.env.npm_config_registry;
      process.env.npm_config_registry = 'http://127.0.0.1:9';
      savedDockerHost = process.env.DOCKER_HOST;
      const engineSocket = join(instances.rootDir, 'engine.sock');
      engine = new FakeDockerEngine('boundary-engine');
      await engine.listen(engineSocket);
      process.env.DOCKER_HOST = `unix://${engineSocket}`;
      engine.images.set('helper', { architecture: 'amd64', tags: [], size: 4 });
      engine.volumes.set('imported', {
        labels: { 'dev.devchain.project': project.id },
        driver: 'local',
      });

      await remoteEntry((item) => item.id === remote.id && item.online && !item.apiKeyRejected);
    }, 60_000);

    afterAll(async () => {
      if (savedDockerHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = savedDockerHost;
      if (savedNpmRegistry === undefined) delete process.env.npm_config_registry;
      else process.env.npm_config_registry = savedNpmRegistry;
      await engine?.close();
    });

    it('admits home client calls, proxied HTTP and the health poll with the right key', async () => {
      await expect(hostClient.projectExists(remote.id, project.id)).resolves.toBe(true);

      const proxied = await fetch(
        `${instances.home.url}/r/${remote.id}/api/projects/${project.id}`,
      );
      expect(proxied.status).toBe(200);
      expect(await proxied.json()).toMatchObject({ id: project.id, name: project.name });

      const entry = await remoteEntry(
        (item) => item.id === remote.id && item.online && !item.apiKeyRejected,
      );
      expect(entry).toMatchObject({ name: remote.name, online: true, versionMatches: true });
      expect(entry.version).toEqual(expect.any(String));
    });

    it('admits Docker JSON and archive transfers with the right key', async () => {
      await expect(hostClient.dockerVersion(remote.id)).resolves.toMatchObject({
        ApiVersion: expect.any(String),
      });

      const archive = {
        projectId: project.id,
        image: 'helper',
        mountType: 'volume' as const,
        source: 'imported',
      };
      const payload = Buffer.from('boundary-archive-payload');
      const written = await hostClient.dockerWriteArchive(
        remote.id,
        archive,
        Readable.from(payload),
      );
      expect(written).toEqual({ sha256: sha256(payload), bytes: payload.length });

      const read = await hostClient.dockerReadArchive(remote.id, archive);
      let downloaded = '';
      for await (const chunk of read.archive) downloaded += chunk.toString('utf8');
      expect(downloaded).toBe(payload.toString('utf8'));
      expect(read.sha256()).toBe(sha256(payload));
    });

    it('rotates the key through home without a host restart', async () => {
      const hostApp = instances.host.app;

      const reset = await fetch(`${instances.home.url}/api/remotes/${remote.id}/api-key/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(reset.status).toBe(204);

      const newKey = await instances.home.app.get(RemoteApiKeyService).get(remote.id);
      expect(newKey).toMatch(/^dck_[A-Za-z0-9_-]{43}$/);
      expect(newKey).not.toBe(hostKey);

      const oldKey = await fetchHost(`${instances.host.url.replace(/^http:/, 'https:')}/health`, {
        authorization: `Bearer ${hostKey}`,
      });
      expect(oldKey.status).toBe(401);
      const accepted = await fetchHost(`${instances.host.url.replace(/^http:/, 'https:')}/health`, {
        authorization: `Bearer ${newKey}`,
      });
      expect(accepted.status).toBe(200);

      expect(instances.host.isClosed()).toBe(false);
      expect(instances.host.app).toBe(hostApp);

      const entry = await remoteEntry(
        (item) => item.id === remote.id && item.online && !item.apiKeyRejected,
      );
      expect(entry.online).toBe(true);
      const proxied = await fetch(
        `${instances.home.url}/r/${remote.id}/api/projects/${project.id}`,
      );
      expect(proxied.status).toBe(200);
    });

    it('recovers from a CLI-style on-disk key replacement through Enter API key', async () => {
      const replacementKey = `dck_${randomBytes(32).toString('base64url')}`;
      const keyPath = instances.hostApiKey!.keyPath;
      const staged = `${keyPath}.staged`;
      writeFileSync(staged, `${sha256(replacementKey)}\n`);
      renameSync(staged, keyPath);

      const rejected = await remoteEntry((item) => item.id === remote.id && item.apiKeyRejected);
      expect(rejected.online).toBe(true);

      const blocked = await fetch(
        `${instances.home.url}/r/${remote.id}/api/projects/${project.id}`,
      );
      expect(blocked.status).toBe(401);
      expect(await blocked.json()).toMatchObject({ code: 'HOST_API_KEY_REJECTED' });

      const enter = await fetch(`${instances.home.url}/api/remotes/${remote.id}/api-key`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: replacementKey }),
      });
      expect(enter.status).toBe(204);

      const restored = await remoteEntry(
        (item) => item.id === remote.id && item.online && !item.apiKeyRejected,
      );
      expect(restored.online).toBe(true);
      const proxied = await fetch(
        `${instances.home.url}/r/${remote.id}/api/projects/${project.id}`,
      );
      expect(proxied.status).toBe(200);
    });
  });

  it('marks the host offline and answers 503 once the host stops', async () => {
    await instances.host.close();

    const hostEntry = await waitForValue(
      async () =>
        (
          (await (await fetch(`${instances.home.url}/api/remotes`)).json()) as {
            items: RemoteListItem[];
          }
        ).items.find((item) => item.id === remote.id && !item.online),
      10_000,
    );
    expect(hostEntry.online).toBe(false);

    const response = await fetch(`${instances.home.url}/r/${remote.id}/api/projects/${project.id}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      statusCode: 503,
      remoteId: remote.id,
      remoteName: remote.name,
    });
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
    await new Promise((resolve) => setTimeout(resolve, 200));

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

      await expect(connectThroughProxy(instances.home.url, remote.id, 1000)).rejects.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 150));
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
