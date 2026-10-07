/**
 * The whole handoff: connect a project to a remote, edit it there, mirror the
 * edits home, and disconnect it again, normally and forced.
 * Test layer: two-instance integration. The applier order, the changes feed,
 * the write guards and the time-accounting exemption only prove themselves
 * together in two booted apps.
 */
import type Database from 'better-sqlite3';
import { existsSync } from 'fs';
import {
  ATTACH_REPLICA_TABLES,
  DETACH_ONLY_TABLES,
  LIVE_REPLICA_TABLES,
  diffProjectRowKeys,
  readProjectRowKeys,
  readProjectRows,
  seedRemoteProject,
  type SeededRemoteProject,
} from '../../common/test/remote-project.fixture';
import {
  startTwoInstances,
  waitForValue,
  type TestInstance,
  type TwoInstances,
} from '../../common/test/two-instance.fixture';
import { AgentTimeAccountingService } from '../epic-time/services/agent-time-accounting.service';
import { SessionsService } from '../sessions/services/sessions.service';
import type { Remote, RemoteOperation } from '../storage/models/domain.models';
import { RemoteHostClient } from './operations/remote-host.client';
import { ensureProvider } from './replica/__fixtures__/replica-seed';
import { RemoteLiveSyncService } from './sync/remote-live-sync.service';
import type { ProjectTimeSettlement } from './time/project-time-settler.service';

const SYNC_INTERVAL_MS = 500;
const SETTLE_TIMEOUT_MS = 300;

interface TimeTotals {
  byEpic: unknown[];
  byAgent: unknown[];
  summary: unknown;
  detail: unknown;
  buffers: unknown;
}

describe('connect, edit on the host, mirror, and disconnect', () => {
  let instances: TwoInstances;
  let remote: Remote;
  let seed: SeededRemoteProject;
  let totalsBeforeConnect: TimeTotals;

  const home = (): TestInstance => instances.home;
  const host = (): TestInstance => instances.host;
  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

  async function api<T = unknown>(
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
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  /** Sends a write that must succeed; a failure names the route and the answer. */
  async function write<T = unknown>(
    instance: TestInstance,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await api<T>(instance, method, path, body);
    expect({ route: `${method} ${path}`, status: response.status < 300 ? 'ok' : response }).toEqual(
      { route: `${method} ${path}`, status: 'ok' },
    );
    return response.body;
  }

  async function runOperation(
    kind: 'attach' | 'detach',
    body: Record<string, unknown>,
  ): Promise<RemoteOperation> {
    const started = await write<RemoteOperation>(
      home(),
      'POST',
      `/api/remotes/${remote.id}/${kind}`,
      body,
    );
    return waitForValue(async () => {
      const { body: operation } = await api<RemoteOperation>(
        home(),
        'GET',
        `/api/remotes/operations/${started.id}`,
      );
      if (operation.state === 'failed') {
        throw new Error(`${kind} failed: ${JSON.stringify(operation.steps)}`);
      }
      return operation.state === 'done' ? operation : null;
    }, 20_000);
  }

  const waitForRemoteOnline = (online: boolean) =>
    waitForValue(async () => {
      const { body } = await api<{ items: { online: boolean }[] }>(home(), 'GET', '/api/remotes');
      return body.items[0]?.online === online;
    }, 10_000);

  const rowKeys = (instance: TestInstance, tables: Parameters<typeof readProjectRowKeys>[2]) =>
    readProjectRowKeys(instance.sqlite, seed.projectId, tables);

  const linkRows = (sqlite: Database.Database) =>
    sqlite
      .prepare('SELECT id, epic_id FROM external_task_links WHERE project_id = ?')
      .all(seed.projectId);

  const bindingRow = () =>
    home()
      .sqlite.prepare('SELECT state FROM remote_project_bindings WHERE project_id = ?')
      .get(seed.projectId) as { state: string } | undefined;

  /** Settled time of the project as stored and as the time routes report it. */
  async function totals(instance: TestInstance): Promise<TimeTotals> {
    const byEpic = instance.sqlite
      .prepare(
        `SELECT epic_id, attribution_source, SUM(duration_ms) AS duration_ms, COUNT(*) AS count
         FROM epic_time_segments WHERE project_id = ?
         GROUP BY epic_id, attribution_source ORDER BY epic_id, attribution_source`,
      )
      .all(seed.projectId);
    const byAgent = instance.sqlite
      .prepare(
        `SELECT agent_id_snapshot, SUM(duration_ms) AS duration_ms, COUNT(*) AS count
         FROM epic_time_segments WHERE project_id = ?
         GROUP BY agent_id_snapshot ORDER BY agent_id_snapshot`,
      )
      .all(seed.projectId);
    const summary = await api(instance, 'POST', '/api/epics/time-summary/batch', {
      epicIds: [seed.rootEpicId, seed.childEpicId, seed.peerEpicId],
      timeZone: 'UTC',
    });
    const detail = await api(
      instance,
      'GET',
      `/api/epics/${seed.rootEpicId}/time-logs?timeZone=UTC`,
    );
    const buffers = await api(
      instance,
      'GET',
      `/api/agent-time-buffers?projectId=${seed.projectId}`,
    );
    expect([summary.status, detail.status, buffers.status]).toEqual([200, 200, 200]);
    return { byEpic, byAgent, summary: summary.body, detail: detail.body, buffers: buffers.body };
  }

  function unsettled(sqlite: Database.Database): { segments: number; batches: number } {
    return sqlite
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM epic_time_segments
            WHERE project_id = @p AND (closed_at IS NULL OR team_batch_id IS NOT NULL)) AS segments,
           (SELECT COUNT(*) FROM epic_time_team_batches WHERE project_id = @p) AS batches`,
      )
      .get({ p: seed.projectId }) as { segments: number; batches: number };
  }

  function insertSession(
    sqlite: Database.Database,
    row: { id: string; agentId: string; epicId: string | null; busySince: string; at: string },
  ): void {
    sqlite
      .prepare(
        `INSERT INTO sessions
           (id, agent_id, epic_id, status, started_at, last_activity_at, activity_state,
            busy_since, created_at, updated_at)
         VALUES (?, ?, ?, 'running', ?, ?, 'busy', ?, ?, ?)`,
      )
      .run(row.id, row.agentId, row.epicId, row.busySince, row.at, row.busySince, row.at, row.at);
  }

  beforeAll(async () => {
    instances = await startTwoInstances({
      syncIntervalMs: SYNC_INTERVAL_MS,
      // Only the forced reconcile below may run a full pull.
      reconcileIntervalMs: 600_000,
      timeSettleTimeoutMs: SETTLE_TIMEOUT_MS,
    });
    seed = seedRemoteProject(home().sqlite);
    ensureProvider(host().sqlite, 'host-claude', seed.providerName, null);
    remote = await instances.registerRemote('vm-1');
    await waitForRemoteOnline(true);
    totalsBeforeConnect = await totals(home());
  }, 60_000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    const rootDir = instances?.rootDir;
    await instances?.close();
    if (rootDir) expect(existsSync(rootDir)).toBe(false);
  }, 30_000);

  it('connects: the host holds every replicated row with the same IDs', async () => {
    await runOperation('attach', { projectId: seed.projectId });

    expect(bindingRow()).toEqual({ state: 'remote' });
    const homeKeys = rowKeys(home(), ATTACH_REPLICA_TABLES);
    expect(Object.entries(homeKeys).filter(([, keys]) => keys.length === 0)).toEqual([
      ['terminal_watchers', []],
      ['automation_subscribers', []],
      ['reviews', []],
      ['review_comments', []],
    ]);
    expect(diffProjectRowKeys(homeKeys, rowKeys(host(), ATTACH_REPLICA_TABLES))).toEqual([]);
    // Links stay home; the project's stopped session travels with its watermark.
    expect(linkRows(host().sqlite)).toEqual([]);
    expect(rowKeys(host(), DETACH_ONLY_TABLES)).toEqual({
      sessions: [seed.sessionId],
      epic_time_session_watermarks: [seed.sessionId],
    });
    expect(await totals(host())).toEqual(totalsBeforeConnect);
  });

  it('mirrors host edits within two intervals and host deletes after a full reconcile', async () => {
    const sqlite = host().sqlite;
    const hostProvider = sqlite
      .prepare('SELECT id FROM providers WHERE name = ?')
      .get(seed.providerName) as { id: string };
    const reordered = [...seed.statusIds].reverse();

    await write(host(), 'POST', '/api/statuses/reorder', {
      projectId: seed.projectId,
      statusIds: reordered,
    });
    const profile = await write<{ id: string }>(host(), 'POST', '/api/profiles', {
      projectId: seed.projectId,
      name: 'Reviewer',
    });
    const config = await write<{ id: string }>(
      host(),
      'POST',
      `/api/profiles/${profile.id}/provider-configs`,
      { providerId: hostProvider.id, name: 'reviewer-default' },
    );
    const agent = await write<{ id: string }>(host(), 'POST', '/api/agents', {
      projectId: seed.projectId,
      profileId: profile.id,
      providerConfigId: config.id,
      name: 'Reviewer',
    });
    await write(host(), 'PUT', `/api/epics/${seed.rootEpicId}`, {
      title: 'Root, edited on the host',
      version: 1,
    });
    const comment = await write<{ id: string }>(
      host(),
      'POST',
      `/api/epics/${seed.childEpicId}/comments`,
      { authorName: 'Host user', content: 'Written on the host' },
    );
    await write(host(), 'DELETE', `/api/epics/${seed.spareEpicId}`);
    await write(host(), 'PUT', `/api/epics/${seed.rootEpicId}/relations/${seed.peerEpicId}`, {
      type: 'blocks',
    });

    const homeDb = home().sqlite;
    const mirrored = () => ({
      statuses: (
        homeDb
          .prepare('SELECT id FROM statuses WHERE project_id = ? ORDER BY position')
          .all(seed.projectId) as Array<{ id: string }>
      ).map((row) => row.id),
      agent: Boolean(homeDb.prepare('SELECT 1 FROM agents WHERE id = ?').get(agent.id)),
      title: (
        homeDb.prepare('SELECT title FROM epics WHERE id = ?').get(seed.rootEpicId) as {
          title: string;
        }
      ).title,
      comment: Boolean(homeDb.prepare('SELECT 1 FROM epic_comments WHERE id = ?').get(comment.id)),
      relation: (homeDb
        .prepare('SELECT type FROM epic_relations WHERE id = ?')
        .get(seed.relationId) ??
        homeDb
          .prepare(
            `SELECT type FROM epic_relations
           WHERE ? IN (left_epic_id, right_epic_id) AND ? IN (left_epic_id, right_epic_id)`,
          )
          .get(seed.rootEpicId, seed.peerEpicId)) as { type: string } | undefined,
    });
    const expected = {
      statuses: reordered,
      agent: true,
      title: 'Root, edited on the host',
      comment: true,
      relation: { type: 'blocks' },
    };
    // Two intervals, plus slack for the pull itself.
    await waitForValue(
      async () => JSON.stringify(mirrored()) === JSON.stringify(expected),
      2 * SYNC_INTERVAL_MS + 1_500,
    ).catch(() => undefined);
    expect(mirrored()).toEqual(expected);
    // An incremental pull carries no deletes.
    expect(homeDb.prepare('SELECT 1 FROM epics WHERE id = ?').get(seed.spareEpicId)).toBeTruthy();

    const liveSync = home().app.get(RemoteLiveSyncService);
    liveSync.start(seed.projectId, remote.id, { full: true });
    await liveSync.syncNow(seed.projectId);

    expect(
      homeDb.prepare('SELECT 1 FROM epics WHERE id = ?').get(seed.spareEpicId),
    ).toBeUndefined();
    expect(
      diffProjectRowKeys(
        rowKeys(home(), LIVE_REPLICA_TABLES),
        rowKeys(host(), LIVE_REPLICA_TABLES),
      ),
    ).toEqual([]);
    for (const table of [
      'statuses',
      'agents',
      'epics',
      'epic_relations',
      'epic_time_segments',
    ] as const) {
      expect({ table, rows: readProjectRows(homeDb, table, seed.projectId) }).toEqual({
        table,
        rows: readProjectRows(sqlite, table, seed.projectId),
      });
    }
    expect(linkRows(homeDb)).toEqual([{ id: seed.externalLinkId, epic_id: seed.rootEpicId }]);
  });

  it('disconnects: home gets the host rows and sessions back, and time totals stay equal', async () => {
    const sqlite = host().sqlite;
    const hostAccounting = host().app.get(AgentTimeAccountingService);
    // The member works in the lead's team without an epic (a team lane) while
    // the lead works on the root epic; activity starts after host tracking began.
    const memberSession = 'a1b2c3d4-0000-4000-8000-000000000001';
    const leadSession = 'a1b2c3d4-0000-4000-8000-000000000002';
    insertSession(sqlite, {
      id: memberSession,
      agentId: seed.memberAgentId,
      epicId: null,
      busySince: iso(-9_000),
      at: iso(0),
    });
    insertSession(sqlite, {
      id: leadSession,
      agentId: seed.leadAgentId,
      epicId: seed.rootEpicId,
      busySince: iso(-7_000),
      at: iso(-10),
    });
    await hostAccounting.requestFullSweep();
    const batch = sqlite
      .prepare('SELECT id FROM epic_time_team_batches WHERE project_id = ?')
      .get(seed.projectId) as { id: string } | undefined;
    expect(batch).toBeDefined();
    // A delivery that never drains holds the batch's barrier once it seals.
    sqlite
      .prepare(
        `INSERT INTO events (id, name, payload_json, request_id, published_at)
         VALUES ('handoff-stuck-event', 'epic.updated', '{}', NULL, ?)`,
      )
      .run(iso(-500));
    sqlite
      .prepare(
        `INSERT INTO event_handlers
           (id, event_id, handler, status, delivery_key, attempts, retry_at,
            lease_owner, lease_expires_at, detail, started_at, ended_at)
         VALUES ('handoff-stuck-delivery', 'handoff-stuck-event', 'epic-time-accounting', 'retry',
                 'epic-time-accounting', 1, '2999-01-01T00:00:00.000Z', NULL, NULL, NULL, ?, NULL)`,
      )
      .run(iso(-500));
    // The member stops inside the idle timeout: the batch seals and waits on the barrier.
    await host()
      .app.get(SessionsService)
      .terminateSession(memberSession, { source: 'remote-operation', reason: 'user-requested' });
    await hostAccounting.requestFullSweep();
    expect(unsettled(sqlite).batches).toBe(1);

    const tables = [...ATTACH_REPLICA_TABLES, ...DETACH_ONLY_TABLES];
    let atFinalPull: { keys: Record<string, string[]>; totals: TimeTotals } | null = null;
    const client = home().app.get(RemoteHostClient);
    const exportReplica = client.exportReplica.bind(client);
    jest
      .spyOn(client, 'exportReplica')
      .mockImplementation(
        async (remoteId: string, projectId: string, scope: 'attach' | 'detach') => {
          const replica = await exportReplica(remoteId, projectId, scope);
          if (scope === 'detach') {
            atFinalPull = { keys: rowKeys(host(), tables), totals: await totals(host()) };
          }
          return replica;
        },
      );

    const done = await runOperation('detach', { projectId: seed.projectId });

    expect(done.details.timeSettlement).toEqual<ProjectTimeSettlement>({
      outcome: 'forced',
      waitedMs: expect.any(Number),
      closedSegments: expect.any(Number),
      finalizedBatchIds: [batch!.id],
      cancelledBatchIds: [],
    });
    const final = atFinalPull as unknown as { keys: Record<string, string[]>; totals: TimeTotals };
    expect(final).not.toBeNull();
    // Home's own session travelled out at connect and returns with the copy.
    expect(diffProjectRowKeys(rowKeys(home(), tables), final.keys)).toEqual([]);
    expect(final.keys.sessions).toEqual([memberSession, leadSession, seed.sessionId].sort());
    expect(rowKeys(home(), DETACH_ONLY_TABLES)).toEqual({
      sessions: [memberSession, leadSession, seed.sessionId].sort(),
      epic_time_session_watermarks: [memberSession, leadSession, seed.sessionId].sort(),
    });
    // The host copy is gone; home owns and writes the project again.
    expect(Object.entries(rowKeys(host(), tables)).filter(([, keys]) => keys.length > 0)).toEqual(
      [],
    );
    expect(bindingRow()).toBeUndefined();
    expect(linkRows(home().sqlite)).toEqual([
      { id: seed.externalLinkId, epic_id: seed.rootEpicId },
    ]);
    expect(await totals(home())).toEqual(final.totals);
    expect(unsettled(home().sqlite)).toEqual({ segments: 0, batches: 0 });

    await home().app.get(AgentTimeAccountingService).requestFullSweep();
    expect(await totals(home())).toEqual(final.totals);
    await instances.restartHome();
    expect(await totals(home())).toEqual(final.totals);
    expect(unsettled(home().sqlite)).toEqual({ segments: 0, batches: 0 });

    const current = home()
      .sqlite.prepare('SELECT version FROM epics WHERE id = ?')
      .get(seed.rootEpicId) as { version: number };
    await write(home(), 'PUT', `/api/epics/${seed.rootEpicId}`, {
      title: 'Back home',
      version: current.version,
    });
  });

  it('a forced disconnect with the host stopped keeps the mirror and lists what may be lost', async () => {
    await waitForRemoteOnline(true);
    await runOperation('attach', { projectId: seed.projectId });
    const mirrorKeys = rowKeys(home(), LIVE_REPLICA_TABLES);
    await host().close();
    await waitForRemoteOnline(false);

    const done = await runOperation('detach', { projectId: seed.projectId, force: true });

    expect(Object.fromEntries(done.steps.map((step) => [step.id, step.state]))).toEqual({
      preflight: 'done',
      freeze_host: 'skipped',
      stop_host_sessions: 'skipped',
      docker_stop_host: 'skipped',
      wait_time_batches: 'skipped',
      final_pull: 'skipped',
      transcripts_pull: 'skipped',
      file_sync_final: 'skipped',
      file_sync_flip: 'done',
      host_release: 'skipped',
      unbind: 'done',
      thaw_home: 'done',
    });
    expect(done.details.forcedLoss).toEqual({
      hostCursor: expect.any(String),
      mirrorAgeMs: expect.any(Number),
      fileSync: {
        folders: [{ id: `code:${seed.projectId}`, needItems: 0, needBytes: 0 }],
      },
      teamLanes: 'unfinalized',
      transcripts: 'remote-changes',
    });
    expect(bindingRow()).toBeUndefined();
    expect(diffProjectRowKeys(rowKeys(home(), LIVE_REPLICA_TABLES), mirrorKeys)).toEqual([]);
    const current = home()
      .sqlite.prepare('SELECT version FROM epics WHERE id = ?')
      .get(seed.rootEpicId) as { version: number };
    await write(home(), 'PUT', `/api/epics/${seed.rootEpicId}`, {
      title: 'Home again after a forced disconnect',
      version: current.version,
    });
  });
});
