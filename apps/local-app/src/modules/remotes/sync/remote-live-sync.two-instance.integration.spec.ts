/**
 * Live sync between two real DevChain apps: home mirrors a connected project
 * by polling the host's changes feed.
 * Test layer: two-instance integration. The contract spans the host feed over
 * HTTP, the home applier and binding writes, and the home realtime output,
 * which only booted apps exercise.
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ReplicaApplyError } from '../../../common/errors/error-types';
import {
  startTwoInstances,
  waitForValue,
  type TestInstance,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import type { RemoteBindingChangedEventPayload } from '../../events/catalog/remote.binding.changed';
import {
  REALTIME_BROADCASTER,
  type RealtimeBroadcaster,
} from '../../realtime/ports/realtime-broadcaster.port';
import type { Remote, RemoteOperation } from '../../storage/models/domain.models';
import { RemoteHostClient } from '../operations/remote-host.client';
import { ProjectReplicaApplier } from '../replica/project-replica.applier';
import { T, ensureProvider, seedReplicaSource } from '../replica/__fixtures__/replica-seed';
import { RemoteLiveSyncService } from './remote-live-sync.service';

const WORKSPACE = '0defa017-0000-4000-8000-0000000000aa';
const SYNC_INTERVAL_MS = 150;
/** Two intervals plus room for the HTTP round trip and the apply. */
const TWO_INTERVALS_MS = 2 * SYNC_INTERVAL_MS + 700;

type Json = Record<string, unknown>;

describe('live sync between two instances', () => {
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

  const homeRow = <T>(sql: string, ...params: unknown[]) =>
    home.sqlite.prepare(sql).get(...params) as T | undefined;

  const binding = () =>
    homeRow<{ state: string; host_cursor: string | null; sync_error: string | null }>(
      "SELECT state, host_cursor, sync_error FROM remote_project_bindings WHERE project_id = 'A'",
    );

  const liveSync = () => home.app.get(RemoteLiveSyncService);

  async function hostEpicVersion(epicId: string): Promise<number> {
    const { body } = await api<{ version: number }>(host, 'GET', `/api/epics/${epicId}`);
    return body.version;
  }

  beforeAll(async () => {
    instances = await startTwoInstances({
      syncIntervalMs: SYNC_INTERVAL_MS,
      reconcileIntervalMs: 600_000,
    });
    home = instances.home;
    host = instances.host;
    seedReplicaSource(home.sqlite);
    home.sqlite.exec(`
      INSERT INTO project_workspaces (id, name, is_default, position, created_at, updated_at)
      VALUES ('${WORKSPACE}', 'Team', 0, 1, '${T}', '${T}');
      UPDATE projects SET workspace_id = '${WORKSPACE}' WHERE id IN ('A', 'B', 'C');
    `);
    // A home-only integration link on an epic that stays on the host.
    home.sqlite
      .prepare(
        `INSERT INTO external_task_links
           (id, epic_id, project_id, provider, remote_scope_key, remote_task_id, source_snapshot,
            created_at, updated_at)
         VALUES ('link-1', 'epic-1', 'A', 'jira', 'scope', 'TASK-1', '{}', ?, ?)`,
      )
      .run(T, T);
    ensureProvider(host.sqlite, 'host-claude', 'claude', null);
    ensureProvider(host.sqlite, 'host-codex', 'codex', null);

    remote = await instances.registerRemote('vm-1');
    await waitForValue(async () => {
      const { body } = await api<{ items: { online: boolean }[] }>(home, 'GET', '/api/remotes');
      return body.items[0]?.online === true;
    }, 10_000);

    const { body: started } = await api<RemoteOperation>(
      home,
      'POST',
      `/api/remotes/${remote.id}/attach`,
      { projectId: 'A' },
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

  it('mirrors host edits within two intervals and removes host-deleted epics on full reconcile', async () => {
    const broadcast = jest.spyOn(
      home.app.get<RealtimeBroadcaster>(REALTIME_BROADCASTER),
      'broadcastEvent',
    );
    const homeEpicUpdated = jest.fn();
    home.app.get(EventEmitter2).on('epic.updated', homeEpicUpdated);

    const edit = await api(host, 'PUT', '/api/epics/epic-2', {
      title: 'Edited on host',
      version: await hostEpicVersion('epic-2'),
    });
    expect(edit.status).toBe(200);
    await waitForValue(
      async () =>
        homeRow<{ title: string }>("SELECT title FROM epics WHERE id = 'epic-2'")?.title ===
        'Edited on host',
      TWO_INTERVALS_MS,
    );

    const comment = await api<{ id: string }>(host, 'POST', '/api/epics/epic-1/comments', {
      authorName: 'Host',
      content: 'Written on the host',
    });
    expect(comment.status).toBe(201);
    await waitForValue(
      async () => homeRow('SELECT 1 FROM epic_comments WHERE id = ?', comment.body.id),
      TWO_INTERVALS_MS,
    );

    host.sqlite
      .prepare(
        "UPDATE epic_relations SET type = 'blocks', direction = 'left_to_right' WHERE id = 'relation-internal'",
      )
      .run();
    await waitForValue(
      async () =>
        homeRow<{ type: string }>("SELECT type FROM epic_relations WHERE id = 'relation-internal'")
          ?.type === 'blocks',
      TWO_INTERVALS_MS,
    );

    const created = await api<{ id: string }>(host, 'POST', '/api/epics', {
      projectId: 'A',
      title: 'Doomed',
      statusId: 'A-status',
    });
    expect(created.status).toBe(201);
    await waitForValue(
      async () => homeRow('SELECT 1 FROM epics WHERE id = ?', created.body.id),
      TWO_INTERVALS_MS,
    );

    const deleted = await api(host, 'DELETE', `/api/epics/${created.body.id}`);
    expect(deleted.status).toBe(200);
    // Incremental pulls carry no deletes.
    await new Promise((resolve) => setTimeout(resolve, 3 * SYNC_INTERVAL_MS));
    expect(homeRow('SELECT 1 FROM epics WHERE id = ?', created.body.id)).toBeDefined();

    liveSync().start('A', remote.id, { full: true });
    await waitForValue(
      async () => !homeRow('SELECT 1 FROM epics WHERE id = ?', created.body.id),
      TWO_INTERVALS_MS,
    );
    expect(homeRow("SELECT epic_id FROM external_task_links WHERE id = 'link-1'")).toEqual({
      epic_id: 'epic-1',
    });

    const topics = broadcast.mock.calls.map(([topic, type]) => `${topic}::${type}`);
    expect(topics).toContain('project/A/epics::remote-synced');
    expect(topics).toContain(`workspace/${WORKSPACE}/epic-relations::remote-synced`);
    expect(homeEpicUpdated).not.toHaveBeenCalled();
    home.app.get(EventEmitter2).off('epic.updated', homeEpicUpdated);
  });

  it('shows a failed apply as syncError while the project stays remote-owned, then heals by re-snapshot', async () => {
    const bindingEvents: RemoteBindingChangedEventPayload[] = [];
    const onBinding = (payload: RemoteBindingChangedEventPayload) => bindingEvents.push(payload);
    home.app.get(EventEmitter2).on('remote.binding.changed', onBinding);

    const applier = home.app.get(ProjectReplicaApplier);
    const realApply = applier.apply.bind(applier);
    jest.spyOn(applier, 'apply').mockImplementation(async (replica, options) => {
      if (options.mode === 'live') {
        throw new ReplicaApplyError('epics', 'epic-2', 'injected failure');
      }
      return realApply(replica, options);
    });
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => (releaseSnapshot = resolve));
    const client = home.app.get(RemoteHostClient);
    const realExport = client.exportReplica.bind(client);
    const exportSpy = jest
      .spyOn(client, 'exportReplica')
      .mockImplementation(async (remoteId, projectId, scope) => {
        await snapshotGate;
        return realExport(remoteId, projectId, scope);
      });
    // A host-side change to a provider env value must not reach home.
    const homeEnvBefore = homeRow<{ env: string }>(
      "SELECT env FROM providers WHERE name = 'claude'",
    );
    host.sqlite
      .prepare(
        "UPDATE providers SET env = json_set(COALESCE(env, '{}'), '$.API_KEY', 'host-value') WHERE name = 'claude'",
      )
      .run();

    const edit = await api(host, 'PUT', '/api/epics/epic-2', {
      title: 'Edited during the failure',
      version: await hostEpicVersion('epic-2'),
    });
    expect(edit.status).toBe(200);

    await waitForValue(async () => binding()?.sync_error, TWO_INTERVALS_MS);
    const { body: bindings } = await api<{ items: Json[] }>(home, 'GET', '/api/remotes/bindings');
    expect(bindings.items.find((item) => item.projectId === 'A')).toMatchObject({
      state: 'remote',
      syncError: 'Replica apply failed at epics row epic-2: injected failure',
    });
    const refused = await api(home, 'POST', '/api/epics', {
      projectId: 'A',
      title: 'At home',
      statusId: 'A-status',
    });
    expect(refused.status).toBe(423);
    expect(refused.body).toMatchObject({ code: 'PROJECT_REMOTE' });
    expect(exportSpy).toHaveBeenCalledWith(remote.id, 'A', 'attach');

    releaseSnapshot();
    await waitForValue(async () => binding()?.sync_error === null, TWO_INTERVALS_MS);

    expect(homeRow<{ title: string }>("SELECT title FROM epics WHERE id = 'epic-2'")?.title).toBe(
      'Edited during the failure',
    );
    expect(homeRow("SELECT 1 FROM external_task_links WHERE id = 'link-1'")).toBeDefined();
    expect(homeRow<{ env: string }>("SELECT env FROM providers WHERE name = 'claude'")).toEqual(
      homeEnvBefore,
    );
    expect(binding()?.state).toBe('remote');
    const errors = bindingEvents.map((event) => event.syncError);
    expect(errors[0]).toBe('Replica apply failed at epics row epic-2: injected failure');
    expect(errors[errors.length - 1]).toBeNull();
    expect(bindingEvents.every((event) => event.state === 'remote')).toBe(true);
    home.app.get(EventEmitter2).off('remote.binding.changed', onBinding);
  });
});
