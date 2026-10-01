import { mkdirSync } from 'fs';
import { join } from 'path';
import { io, type Socket } from 'socket.io-client';
import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
} from '../../common/test/two-instance.fixture';
import type { Project, Remote, Status } from '../storage/models/domain.models';

interface RemoteListItem {
  id: string;
  name: string;
  online: boolean;
  version: string | null;
  versionMatches: boolean;
}

interface Envelope {
  topic: string;
  type: string;
  payload: Record<string, unknown>;
}

async function listRemotes(instances: TwoInstances): Promise<RemoteListItem[]> {
  const response = await fetch(`${instances.home.url}/api/remotes`);
  const body = (await response.json()) as { items: RemoteListItem[] };
  return body.items;
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

describe('home and a second instance through the /r proxy', () => {
  let instances: TwoInstances;
  let remote: Remote;
  let project: Project;
  let status: Status;

  beforeAll(async () => {
    instances = await startTwoInstances();

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

    remote = await instances.registerRemote('lab-host');
    await instances.bindProject(project.id, remote.id);
    // The home copy gets a different name so a proxied read provably comes from the host.
    instances.home.sqlite
      .prepare('UPDATE projects SET name = ? WHERE id = ?')
      .run('Home copy', project.id);
  }, 45_000);

  afterAll(async () => {
    await instances?.close();
  });

  it('reports the host online with a matching version', async () => {
    const hostEntry = await waitForValue(
      async () =>
        (await listRemotes(instances)).find((item) => item.id === remote.id && item.online),
      10_000,
    );

    expect(hostEntry).toMatchObject({ name: 'lab-host', online: true, versionMatches: true });
    expect(hostEntry.version).toEqual(expect.any(String));
  });

  it('serves the host project through /r/<remoteId>/api/projects/<projectId>', async () => {
    const response = await fetch(`${instances.home.url}/r/${remote.id}/api/projects/${project.id}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: project.id, name: 'Host project' });
  });

  it('delivers an epic created on the host to a socket connected through the proxy', async () => {
    const socket = await connectThroughProxy(instances.home.url, remote.id);
    try {
      const envelopes: Envelope[] = [];
      socket.on('message', (envelope: Envelope) => envelopes.push(envelope));

      const response = await fetch(`${instances.home.url}/r/${remote.id}/api/epics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          title: 'Through the proxy',
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
      expect(created.payload).toMatchObject({ projectId: project.id, title: 'Through the proxy' });
      expect(await instances.host.storage.getEpic(epic.id)).toMatchObject({ id: epic.id });
    } finally {
      socket.close();
    }
  });

  it('marks the host offline and answers 503 once the host stops', async () => {
    await instances.host.close();

    const hostEntry = await waitForValue(
      async () =>
        (await listRemotes(instances)).find((item) => item.id === remote.id && !item.online),
      10_000,
    );
    expect(hostEntry.online).toBe(false);

    const response = await fetch(`${instances.home.url}/r/${remote.id}/api/projects/${project.id}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      statusCode: 503,
      remoteId: remote.id,
      remoteName: 'lab-host',
    });
  });
});
