/**
 * Importing a vendor task into a project a remote owns: the epic is created on
 * the host, home mirrors it and keeps the link row.
 * Test layer: two-instance integration. The contract spans the host epic
 * routes over HTTP, home's mirror pull and home's link write, and the recovery
 * cases need a host that really stops and restarts.
 */
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';
import {
  startTwoInstances,
  waitForValue,
  type TestInstance,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import { RemoteHostClient } from '../../remotes/operations/remote-host.client';
import { T, replicaSeeder } from '../../remotes/replica/__fixtures__/replica-seed';
import type { Remote, RemoteOperation } from '../../storage/models/domain.models';

const PROJECT = '5a1e0000-0000-4000-8000-000000000001';
const STATUS = '5a1e0000-0000-4000-8000-000000000002';

type Json = Record<string, unknown>;

interface ImportResponse {
  epic: { id: string; projectId: string };
  created: boolean;
}

describe('external task import into a remote-owned project', () => {
  let instances: TwoInstances;
  let remote: Remote;
  let home: TestInstance;
  let host: TestInstance;

  async function api<T = Json>(
    instance: TestInstance,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const response = await fetch(`${instance.url}${path}`, {
      method,
      ...(body !== undefined && {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  }

  function importTask(taskId: string) {
    return api<ImportResponse & { code?: string; details?: Json }>(
      home,
      'POST',
      '/api/epics/import-external-task',
      {
        projectId: PROJECT,
        statusId: STATUS,
        agentId: null,
        title: `Imported ${taskId}`,
        description: 'From Jira',
        remote: {
          provider: 'jira',
          scopeKey: 'acme.atlassian.net',
          taskId,
          remoteKey: taskId,
          title: `Remote ${taskId}`,
          description: null,
          webUrl: `https://acme.atlassian.net/browse/${taskId}`,
          workAreaId: '42',
          workAreaName: 'Delivery',
          statusName: 'To Do',
        },
      },
    );
  }

  const keyOf = (taskId: string) => `import:jira:acme.atlassian.net:${taskId}`;

  const hostEpicIds = (taskId: string) =>
    (
      host.sqlite
        .prepare(
          `SELECT id FROM epics WHERE project_id = ? AND json_extract(data, '$.idempotencyKey') = ?`,
        )
        .all(PROJECT, keyOf(taskId)) as { id: string }[]
    ).map((row) => row.id);

  const homeCount = (sql: string, ...params: unknown[]) =>
    (home.sqlite.prepare(sql).get(...params) as { n: number }).n;

  const homeLinks = (taskId: string) =>
    home.sqlite
      .prepare(
        'SELECT epic_id, connection_id FROM external_task_links WHERE project_id = ? AND remote_task_id = ?',
      )
      .all(PROJECT, taskId) as { epic_id: string; connection_id: string | null }[];

  async function setBindingState(state: 'attaching' | 'remote' | 'detaching'): Promise<void> {
    home.sqlite
      .prepare('UPDATE remote_project_bindings SET state = ? WHERE project_id = ?')
      .run(state, PROJECT);
    await home.app.get(ProjectWriteGate).refresh();
  }

  async function waitOnline(): Promise<void> {
    await waitForValue(async () => {
      const { body } = await api<{ items: { online: boolean }[] }>(home, 'GET', '/api/remotes');
      return body.items[0]?.online === true;
    }, 10_000);
  }

  beforeAll(async () => {
    // No background pulls: every mirror change in these tests comes from the
    // import's own pull, so a stopped host really leaves the mirror behind.
    instances = await startTwoInstances({
      syncIntervalMs: 600_000,
      reconcileIntervalMs: 600_000,
    });
    home = instances.home;
    host = instances.host;
    const { insert } = replicaSeeder(home.sqlite);
    insert('projects', {
      id: PROJECT,
      workspace_id: '0defa017-0000-4000-8000-000000000001',
      name: 'Imports',
      description: null,
      root_path: '/tmp/imports',
      is_template: 0,
      is_private: 0,
      created_at: T,
      updated_at: T,
    });
    insert('statuses', {
      id: STATUS,
      project_id: PROJECT,
      label: 'New',
      color: '#fff',
      position: 0,
      mcp_hidden: 0,
      created_at: T,
      updated_at: T,
    });
    insert('integration_connections', {
      id: 'connection-jira',
      project_id: PROJECT,
      provider: 'jira',
      credential_ciphertext: 'home-only-ciphertext',
      created_at: T,
      updated_at: T,
    });

    remote = await instances.registerRemote('vm-1');
    await waitOnline();
    const { body: started } = await api<RemoteOperation>(
      home,
      'POST',
      `/api/remotes/${remote.id}/attach`,
      { projectId: PROJECT },
    );
    await waitForValue(async () => {
      const { body } = await api<RemoteOperation>(
        home,
        'GET',
        `/api/remotes/operations/${started.id}`,
      );
      if (body.state === 'failed') throw new Error(JSON.stringify(body.steps));
      return body.state === 'done';
    }, 15_000);
  }, 60_000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await instances?.close();
  }, 30_000);

  it('creates one host epic, one mirror row and one link row; a repeat returns created: false', async () => {
    const first = await importTask('ENG-1');
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);

    const [hostEpicId] = hostEpicIds('ENG-1');
    expect(hostEpicIds('ENG-1')).toHaveLength(1);
    expect(first.body.epic.id).toBe(hostEpicId);
    expect(homeCount('SELECT COUNT(*) AS n FROM epics WHERE id = ?', hostEpicId)).toBe(1);
    expect(homeLinks('ENG-1')).toEqual([{ epic_id: hostEpicId, connection_id: 'connection-jira' }]);

    // Credentials and the connection stay at home.
    expect(
      (
        host.sqlite.prepare('SELECT COUNT(*) AS n FROM integration_connections').get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    const hostEpic = host.sqlite
      .prepare('SELECT title, description, status_id, created_by, data FROM epics WHERE id = ?')
      .get(hostEpicId) as Json;
    expect(hostEpic).toEqual({
      title: 'Imported ENG-1',
      description: 'From Jira',
      status_id: STATUS,
      created_by: null,
      data: JSON.stringify({ idempotencyKey: keyOf('ENG-1') }),
    });

    const again = await importTask('ENG-1');
    expect(again.body).toEqual({ epic: { id: hostEpicId, projectId: PROJECT }, created: false });
    expect(hostEpicIds('ENG-1')).toHaveLength(1);
    expect(homeLinks('ENG-1')).toHaveLength(1);
  });

  it('reuses the host epic after a failure between the host create and the link write', async () => {
    jest
      .spyOn(home.storage, 'createExternalTaskLink')
      .mockRejectedValueOnce(new Error('link write failed'));

    const failed = await importTask('ENG-2');
    expect(failed.status).toBe(500);
    expect(hostEpicIds('ENG-2')).toHaveLength(1);
    expect(homeLinks('ENG-2')).toHaveLength(0);

    const retried = await importTask('ENG-2');
    expect(retried.status).toBe(201);
    expect(retried.body.created).toBe(true);
    expect(hostEpicIds('ENG-2')).toEqual([retried.body.epic.id]);
    expect(homeLinks('ENG-2')).toEqual([
      { epic_id: retried.body.epic.id, connection_id: 'connection-jira' },
    ]);
  });

  it('answers REMOTE_MIRROR_PENDING when the host stops after the create, and completes after it restarts', async () => {
    const client = home.app.get(RemoteHostClient);
    const createEpic = client.createEpic.bind(client);
    jest.spyOn(client, 'createEpic').mockImplementationOnce(async (...args) => {
      const created = await createEpic(...args);
      await host.close();
      return created;
    });

    const pending = await importTask('ENG-3');
    expect(pending.status).toBe(409);
    expect(pending.body.details).toMatchObject({
      code: 'REMOTE_MIRROR_PENDING',
      retryable: true,
    });
    expect(homeLinks('ENG-3')).toHaveLength(0);

    host = await instances.restartHost();
    await waitOnline();
    expect(hostEpicIds('ENG-3')).toHaveLength(1);

    const retried = await importTask('ENG-3');
    expect(retried.status).toBe(201);
    expect(hostEpicIds('ENG-3')).toEqual([retried.body.epic.id]);
    expect(homeLinks('ENG-3')).toHaveLength(1);
  }, 30_000);

  it.each(['attaching', 'detaching'] as const)(
    'answers 423 while the binding is %s',
    async (state) => {
      await setBindingState(state);
      try {
        const refused = await importTask(`ENG-${state}`);
        expect(refused.status).toBe(423);
        expect(refused.body.code).toBe('PROJECT_REMOTE');
        expect(hostEpicIds(`ENG-${state}`)).toHaveLength(0);
      } finally {
        await setBindingState('remote');
      }
    },
  );

  it('keeps data.idempotencyKey through epic edits on the host', async () => {
    const imported = await importTask('ENG-4');
    const epicId = imported.body.epic.id;
    const read = async () =>
      (await api<{ version: number; data: Json | null }>(host, 'GET', `/api/epics/${epicId}`)).body;

    const titleEdit = await api(host, 'PUT', `/api/epics/${epicId}`, {
      title: 'Renamed on host',
      version: (await read()).version,
    });
    expect(titleEdit.status).toBe(200);
    const dataEdit = await api(host, 'PUT', `/api/epics/${epicId}`, {
      data: { note: 'kept' },
      version: (await read()).version,
    });
    expect(dataEdit.status).toBe(200);

    expect((await read()).data).toEqual({ note: 'kept', idempotencyKey: keyOf('ENG-4') });
    expect(hostEpicIds('ENG-4')).toEqual([epicId]);
  });
});
