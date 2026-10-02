// A claimed host and home, both as full AppModule apps: HTTP, both Socket.IO
// namespaces, the /r proxy (HTTP and WebSocket), Docker JSON and archive
// transfers, rotation and CLI-style recovery across the real admission checks.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { io, type Socket } from 'socket.io-client';
import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import { FakeDockerEngine } from '../../../common/test/fake-docker-engine.server';
import { FIXTURE_TLS_NAME, fixtureTls } from '../../../common/test/tls-fixture';
import { RemoteApiKeyService } from '../auth/remote-api-key.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import type { Project, Remote, Status } from '../../storage/models/domain.models';

const WRONG_KEY = `dck_${'c'.repeat(43)}`;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

interface RemoteListItem {
  id: string;
  name: string;
  online: boolean;
  apiKeyRejected: boolean;
  version: string | null;
  versionMatches: boolean;
}

interface Envelope {
  topic: string;
  type: string;
  payload: Record<string, unknown>;
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

function connectToHost(
  hostUrl: string,
  namespace: string,
  authorization?: string,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`${hostUrl}${namespace}`, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
      extraHeaders: authorization ? { authorization } : {},
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => {
      socket.close();
      reject(error);
    });
  });
}

// Closes the socket on either outcome so an unexpectedly admitted handshake
// fails the assertion without holding the worker open.
function expectHostSocketRefusal(
  hostUrl: string,
  namespace: string,
  authorization?: string,
): Promise<void> {
  return connectToHost(hostUrl, namespace, authorization).then(
    (socket) => {
      socket.close();
      throw new Error(`Handshake on ${namespace || '/'} was admitted without a valid key`);
    },
    () => undefined,
  );
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

describe('the host API key boundary between home and a claimed host', () => {
  let instances: TwoInstances;
  let remote: Remote;
  let project: Project;
  let status: Status;
  let hostKey: string;
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
    hostKey = `dck_${randomBytes(32).toString('base64url')}`;
    instances = await startTwoInstances({ claimedHost: { key: hostKey } });
    hostClient = instances.home.app.get(RemoteHostClient);

    const rootPath = join(instances.host.dataDir, 'workspace');
    mkdirSync(rootPath, { recursive: true });
    project = await instances.host.storage.createProject({
      name: 'Host project',
      description: null,
      rootPath,
      isTemplate: false,
    });
    const statuses = await instances.host.storage.listStatuses(project.id);
    status =
      statuses.items[0] ??
      (await instances.host.storage.createStatus({
        projectId: project.id,
        label: 'New',
        color: '#888888',
        position: 0,
      }));

    remote = await instances.registerRemote('claimed-host');
    await instances.bindProject(project.id, remote.id);

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
    await instances?.close();
  });

  it('refuses keyless and wrong-key HTTP calls from the non-loopback peer', async () => {
    const attempts: Record<string, string>[] = [{}, { authorization: `Bearer ${WRONG_KEY}` }];
    for (const headers of attempts) {
      const response = await fetchHost(`${instances.host.url}/health`, headers);
      expect(response.status).toBe(401);
      expect(response.body).toContain('HOST_API_KEY_REJECTED');
    }
    const docs = await fetchHost(`${instances.host.url}/api/docs`);
    expect(docs.status).toBe(401);
  });

  it('refuses Socket.IO handshakes without and with a wrong key on both namespaces', async () => {
    for (const namespace of ['/', '/mcp']) {
      await expectHostSocketRefusal(instances.host.url, namespace);
      await expectHostSocketRefusal(instances.host.url, namespace, `Bearer ${WRONG_KEY}`);
    }
  });

  it('serves TLS on the same port and keeps the key check there', async () => {
    const tlsUrl = instances.host.url.replace(/^http:/, 'https:');
    expect((await fetchHost(`${tlsUrl}/api/runtime`)).status).toBe(200);
    const keyless = await fetchHost(`${tlsUrl}/health`);
    expect(keyless.status).toBe(401);
    expect(keyless.body).toContain('HOST_API_KEY_REJECTED');
    expect(
      (await fetchHost(`${tlsUrl}/health`, { authorization: `Bearer ${hostKey}` })).status,
    ).toBe(200);
  });

  it('answers GET /api/runtime without a key', async () => {
    const response = await fetchHost(`${instances.host.url}/api/runtime`);
    expect(response.status).toBe(200);
    expect(response.body).toContain('version');
  });

  it('admits home client calls, proxied HTTP and the health poll with the right key', async () => {
    await expect(hostClient.projectExists(remote.id, project.id)).resolves.toBe(true);

    const proxied = await fetch(`${instances.home.url}/r/${remote.id}/api/projects/${project.id}`);
    expect(proxied.status).toBe(200);
    expect(await proxied.json()).toMatchObject({ id: project.id, name: 'Host project' });

    const entry = await remoteEntry(
      (item) => item.id === remote.id && item.online && !item.apiKeyRejected,
    );
    expect(entry).toMatchObject({ name: 'claimed-host', online: true, versionMatches: true });
  });

  it('admits a proxied WebSocket through /r', async () => {
    const socket = await connectThroughProxy(instances.home.url, remote.id);
    try {
      const envelopes: Envelope[] = [];
      socket.on('message', (envelope: Envelope) => envelopes.push(envelope));

      const response = await fetch(`${instances.home.url}/r/${remote.id}/api/epics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          title: 'Across the boundary',
          statusId: status.id,
        }),
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
      expect(created.payload).toMatchObject({
        projectId: project.id,
        title: 'Across the boundary',
      });
    } finally {
      socket.close();
    }
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
    const written = await hostClient.dockerWriteArchive(remote.id, archive, Readable.from(payload));
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

    const oldKey = await fetchHost(`${instances.host.url}/health`, {
      authorization: `Bearer ${hostKey}`,
    });
    expect(oldKey.status).toBe(401);
    const accepted = await fetchHost(`${instances.host.url}/health`, {
      authorization: `Bearer ${newKey}`,
    });
    expect(accepted.status).toBe(200);

    expect(instances.host.isClosed()).toBe(false);
    expect(instances.host.app).toBe(hostApp);

    const entry = await remoteEntry(
      (item) => item.id === remote.id && item.online && !item.apiKeyRejected,
    );
    expect(entry.online).toBe(true);
    const proxied = await fetch(`${instances.home.url}/r/${remote.id}/api/projects/${project.id}`);
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

    const blocked = await fetch(`${instances.home.url}/r/${remote.id}/api/projects/${project.id}`);
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
    const proxied = await fetch(`${instances.home.url}/r/${remote.id}/api/projects/${project.id}`);
    expect(proxied.status).toBe(200);
  });

  it('exempts loopback callers without a key', async () => {
    instances.hostApiKey!.setSeenPeerAddress('127.0.0.1');
    try {
      const response = await fetchHost(`${instances.host.url}/health`);
      expect(response.status).toBe(200);

      const socket = await connectToHost(instances.host.url, '/');
      expect(socket.connected).toBe(true);
      socket.close();
    } finally {
      instances.hostApiKey!.setSeenPeerAddress('192.0.2.10');
    }
  });
});
