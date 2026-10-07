/**
 * Agent time across a connect and disconnect between two real DevChain apps.
 * Test layer: two-instance integration. Equality of the time totals depends on
 * both instances' accounting sweeps, the handoff steps over HTTP, the detach
 * copy and a home restart, which only booted apps exercise.
 */
import type Database from 'better-sqlite3';
import {
  startTwoInstances,
  waitForValue,
  type TestInstance,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import { AgentTimeAccountingService } from '../../epic-time/services/agent-time-accounting.service';
import { EpicTimeService } from '../../epic-time/services/epic-time.service';
import { EpicTimeStore } from '../../epic-time/services/epic-time.store';
import { SessionsService } from '../../sessions/services/sessions.service';
import type { Remote, RemoteOperation } from '../../storage/models/domain.models';
import { RemoteHostClient } from '../operations/remote-host.client';
import { ensureProvider, seedReplicaSource } from '../replica/__fixtures__/replica-seed';
import type { ProjectTimeSettlement } from './project-time-settler.service';

const SETTLE_TIMEOUT_MS = 300;

interface TimeTotals {
  byEpic: unknown[];
  byAgent: unknown[];
  summary: unknown;
  detail: unknown;
  buffers: unknown;
}

describe('agent time across a connect and disconnect', () => {
  let instances: TwoInstances;
  let remote: Remote;

  const home = (): TestInstance => instances.home;
  const host = (): TestInstance => instances.host;
  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

  async function api<T = RemoteOperation>(
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

  async function runOperation(
    kind: 'attach' | 'detach',
    body: Record<string, unknown>,
  ): Promise<RemoteOperation> {
    const started = await api(home(), 'POST', `/api/remotes/${remote.id}/${kind}`, body);
    expect(started.status).toBe(202);
    return waitForValue(async () => {
      const { body: operation } = await api(
        home(),
        'GET',
        `/api/remotes/operations/${started.body.id}`,
      );
      if (operation.state === 'failed') {
        throw new Error(`Operation failed: ${JSON.stringify(operation.steps)}`);
      }
      return operation.state === 'done' ? operation : null;
    }, 20_000);
  }

  /** Settled time of project A as the database holds it and as the time reads report it. */
  async function totals(instance: TestInstance): Promise<TimeTotals> {
    const byEpic = instance.sqlite
      .prepare(
        `SELECT epic_id, attribution_source, SUM(duration_ms) AS duration_ms, COUNT(*) AS count
         FROM epic_time_segments WHERE project_id = 'A'
         GROUP BY epic_id, attribution_source ORDER BY epic_id, attribution_source`,
      )
      .all();
    const byAgent = instance.sqlite
      .prepare(
        `SELECT agent_id_snapshot, SUM(duration_ms) AS duration_ms, COUNT(*) AS count
         FROM epic_time_segments WHERE project_id = 'A'
         GROUP BY agent_id_snapshot ORDER BY agent_id_snapshot`,
      )
      .all();
    // In process: the seed's IDs are not UUIDs, which the HTTP routes require.
    const epicTime = instance.app.get(EpicTimeService);
    return {
      byEpic,
      byAgent,
      summary: epicTime.getBatch(['epic-1', 'epic-2'], 'UTC'),
      detail: epicTime.getDetail('epic-1', 'UTC'),
      buffers: instance.app.get(EpicTimeStore).listAgentTimeBuffers('A'),
    };
  }

  function unsettled(sqlite: Database.Database): { segments: number; batches: number } {
    return sqlite
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM epic_time_segments
            WHERE project_id = 'A' AND (closed_at IS NULL OR team_batch_id IS NOT NULL))
             AS segments,
           (SELECT COUNT(*) FROM epic_time_team_batches WHERE project_id = 'A') AS batches`,
      )
      .get() as { segments: number; batches: number };
  }

  function timeRows(sqlite: Database.Database): unknown[] {
    return sqlite
      .prepare(
        `SELECT 'segment' AS kind, id, closed_at, team_batch_id, duration_ms, updated_at
         FROM epic_time_segments WHERE project_id = 'A'
         UNION ALL
         SELECT 'batch', id, sealed_at, NULL, NULL, updated_at
         FROM epic_time_team_batches WHERE project_id = 'A'
         UNION ALL
         SELECT 'watermark', session_id, last_activity_at, NULL, NULL, updated_at
         FROM epic_time_session_watermarks WHERE project_id = 'A'
         ORDER BY 1, 2`,
      )
      .all();
  }

  function insertSession(
    sqlite: Database.Database,
    row: {
      id: string;
      agentId: string;
      epicId: string | null;
      status: string;
      activityState: string | null;
      busySince: string | null;
      lastActivityAt: string;
    },
  ): void {
    sqlite
      .prepare(
        `INSERT INTO sessions
           (id, agent_id, epic_id, status, started_at, last_activity_at, activity_state,
            busy_since, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.agentId,
        row.epicId,
        row.status,
        row.busySince ?? row.lastActivityAt,
        row.lastActivityAt,
        row.activityState,
        row.busySince,
        row.lastActivityAt,
        row.lastActivityAt,
      );
  }

  /**
   * A finished provider session: stopped or failed with a provider session ID,
   * the exact shape restore needs. Its activity predates both instances'
   * tracking start, so home's settle step leaves it alone before the copy.
   */
  function insertRestorableSession(
    sqlite: Database.Database,
    row: {
      id: string;
      agentId: string;
      epicId: string | null;
      status: 'stopped' | 'failed';
      providerName: string;
      providerSessionId: string;
    },
  ): void {
    const at = '2026-01-01T00:00:00.000Z';
    sqlite
      .prepare(
        `INSERT INTO sessions
           (id, agent_id, epic_id, status, started_at, ended_at, last_activity_at,
            activity_state, provider_name_at_launch, provider_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.agentId,
        row.epicId,
        row.status,
        at,
        at,
        at,
        row.providerName,
        row.providerSessionId,
        at,
        at,
      );
  }

  function readTrackingStart(sqlite: Database.Database): string | null {
    return (
      (
        sqlite
          .prepare(`SELECT value FROM settings WHERE key = 'epicTime.trackingStartedAt'`)
          .get() as { value: string } | undefined
      )?.value ?? null
    );
  }

  function setTrackingStart(sqlite: Database.Database, value: string | null): void {
    if (value === null) {
      sqlite.prepare(`DELETE FROM settings WHERE key = 'epicTime.trackingStartedAt'`).run();
      return;
    }
    sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES ('epic-time-tracking-start', 'epicTime.trackingStartedAt', ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(value, iso(0), iso(0));
  }

  beforeAll(async () => {
    instances = await startTwoInstances({
      syncIntervalMs: 150,
      timeSettleTimeoutMs: SETTLE_TIMEOUT_MS,
    });
    // Home holds an open segment and an open team batch for A (from the seed).
    seedReplicaSource(home().sqlite);
    ensureProvider(host().sqlite, 'host-claude', 'claude', null);
    ensureProvider(host().sqlite, 'host-codex', 'codex', null);
    remote = await instances.registerRemote('vm-1');
    await waitForValue(async () => {
      const { body } = await api<{ items: { online: boolean }[] }>(home(), 'GET', '/api/remotes');
      return body.items[0]?.online === true;
    }, 10_000);
  }, 60_000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await instances?.close();
  }, 30_000);

  it('settles home time before the copy, so only settled segments reach the host', async () => {
    expect(unsettled(home().sqlite)).toEqual({ segments: 2, batches: 1 });
    // A restorable Claude row linked to another project's epic, and a failed
    // Codex row: both must travel with the connect copy.
    insertRestorableSession(home().sqlite, {
      id: 'home-claude',
      agentId: 'agent-1',
      epicId: 'epic-b',
      status: 'stopped',
      providerName: 'claude',
      providerSessionId: 'claude-resume-1',
    });
    insertRestorableSession(home().sqlite, {
      id: 'home-codex',
      agentId: 'agent-2',
      epicId: null,
      status: 'failed',
      providerName: 'codex',
      providerSessionId: 'codex-resume-1',
    });

    const done = await runOperation('attach', { projectId: 'A' });

    const step = done.steps.find((candidate) => candidate.id === 'wait_time_batches');
    expect(step?.state).toBe('done');
    expect(done.details.timeSettlement).toEqual<ProjectTimeSettlement>({
      outcome: 'settled',
      waitedMs: expect.any(Number),
      closedSegments: 1,
      finalizedBatchIds: ['batch-1'],
      cancelledBatchIds: [],
    });
    expect(unsettled(home().sqlite)).toEqual({ segments: 0, batches: 0 });
    expect(unsettled(host().sqlite)).toEqual({ segments: 0, batches: 0 });
    expect(await totals(host())).toEqual(await totals(home()));

    // The project's session history arrived restorable: stopped or failed rows
    // whose provider session ID and launch provider survived the copy. The
    // cross-project epic link cannot travel, so it arrived cleared.
    expect(
      host()
        .sqlite.prepare(
          `SELECT id, status, epic_id, provider_name_at_launch, provider_session_id
           FROM sessions WHERE id IN ('session-1', 'home-claude', 'home-codex') ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: 'home-claude',
        status: 'stopped',
        epic_id: null,
        provider_name_at_launch: 'claude',
        provider_session_id: 'claude-resume-1',
      },
      {
        id: 'home-codex',
        status: 'failed',
        epic_id: null,
        provider_name_at_launch: 'codex',
        provider_session_id: 'codex-resume-1',
      },
      {
        id: 'session-1',
        status: 'stopped',
        epic_id: 'epic-1',
        provider_name_at_launch: null,
        provider_session_id: null,
      },
    ]);
    expect(
      host()
        .sqlite.prepare(
          `SELECT session_id FROM epic_time_session_watermarks
           WHERE session_id IN ('home-claude', 'home-codex') ORDER BY session_id`,
        )
        .all(),
    ).toEqual([{ session_id: 'home-claude' }, { session_id: 'home-codex' }]);

    // The travelling watermarks, not the young tracking start, stop the host
    // sweep from counting the imported history a second time.
    const hostTrackingStart = readTrackingStart(host().sqlite);
    setTrackingStart(host().sqlite, '2020-01-01T00:00:00.000Z');
    await host().app.get(AgentTimeAccountingService).requestFullSweep();
    setTrackingStart(host().sqlite, hostTrackingStart);
    expect(await totals(host())).toEqual(await totals(home()));
    expect(unsettled(host().sqlite)).toEqual({ segments: 0, batches: 0 });
  });

  it('keeps home accounting inert for the bound project', async () => {
    const sqlite = home().sqlite;
    // Leftovers a sweep would otherwise act on: fresh activity without a
    // watermark, an open segment and an open team batch of the bound project.
    insertSession(sqlite, {
      id: 'home-late',
      agentId: 'agent-2',
      epicId: null,
      status: 'stopped',
      activityState: 'busy',
      busySince: iso(-4_000),
      lastActivityAt: iso(-1_000),
    });
    sqlite.exec(`
      INSERT INTO epic_time_team_batches
        (id, project_id, team_id_snapshot, team_name_snapshot, lead_agent_id_snapshot,
         lead_agent_name_snapshot, started_at, sealed_at, created_at, updated_at)
      VALUES ('home-batch', 'A', 'team-1', 'Builders', 'agent-1', 'Agent agent-1',
              '${iso(-60_000)}', NULL, '${iso(-60_000)}', '${iso(-60_000)}');
      INSERT INTO epic_time_segments
        (id, project_id, epic_id, team_batch_id, attribution_source, session_id_snapshot,
         agent_id_snapshot, agent_name_snapshot, started_at, last_activity_at, closed_at,
         duration_ms, created_at, updated_at)
      VALUES ('home-open', 'A', 'epic-1', NULL, 'direct', 'home-gone', 'agent-1',
              'Agent agent-1', '${iso(-60_000)}', '${iso(-50_000)}', NULL, 10000,
              '${iso(-60_000)}', '${iso(-60_000)}');
    `);
    const before = timeRows(sqlite);
    const accounting = home().app.get(AgentTimeAccountingService);

    await accounting.requestFullSweep(new Date(), { forceCloseOpenSegments: true });
    await accounting.requestSessionReconciliation('home-late');

    expect(timeRows(sqlite)).toEqual(before);
    sqlite.exec(`
      DELETE FROM epic_time_segments WHERE id = 'home-open';
      DELETE FROM epic_time_team_batches WHERE id = 'home-batch';
      DELETE FROM sessions WHERE id = 'home-late';
    `);
  });

  it('brings back exactly the host totals of the final pull, through a sweep and a restart', async () => {
    const sqlite = host().sqlite;
    const hostAccounting = host().app.get(AgentTimeAccountingService);
    // agent-2 works in agent-1's team without an epic (a team lane); agent-1
    // works on epic-1 directly; an older session predates host accounting.
    // Busy windows start no earlier than the host's tracking start, moments ago.
    sqlite
      .prepare(`INSERT INTO team_members (team_id, agent_id, created_at) VALUES (?, ?, ?)`)
      .run('team-1', 'agent-2', iso(0));
    insertSession(sqlite, {
      id: 'host-member',
      agentId: 'agent-2',
      epicId: null,
      status: 'running',
      activityState: 'busy',
      busySince: iso(-9_000),
      lastActivityAt: iso(0),
    });
    insertSession(sqlite, {
      id: 'host-direct',
      agentId: 'agent-1',
      epicId: 'epic-1',
      status: 'running',
      activityState: 'busy',
      busySince: iso(-7_000),
      lastActivityAt: iso(-10),
    });
    insertSession(sqlite, {
      id: 'host-old',
      agentId: 'agent-1',
      epicId: 'epic-1',
      status: 'stopped',
      activityState: 'busy',
      busySince: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-01T00:05:00.000Z',
    });
    await hostAccounting.requestFullSweep();
    const batch = sqlite
      .prepare(`SELECT id, sealed_at FROM epic_time_team_batches WHERE project_id = 'A'`)
      .get() as { id: string; sealed_at: string | null };
    expect(batch.sealed_at).toBeNull();

    // A delivery that stays pending holds the batch's event barrier once it seals.
    sqlite
      .prepare(
        `INSERT INTO events (id, name, payload_json, request_id, published_at)
         VALUES ('event-stuck', 'epic.updated', '{}', NULL, ?)`,
      )
      .run(iso(-500));
    sqlite
      .prepare(
        `INSERT INTO event_handlers
           (id, event_id, handler, status, delivery_key, attempts, retry_at,
            lease_owner, lease_expires_at, detail, started_at, ended_at)
         VALUES ('event-stuck-delivery', 'event-stuck', 'epic-time-accounting', 'retry',
                 'epic-time-accounting', 1, '2999-01-01T00:00:00.000Z', NULL, NULL, NULL, ?, NULL)`,
      )
      .run(iso(-500));
    // The member stops inside the idle timeout, busy_since still set: the batch seals and waits.
    await host()
      .app.get(SessionsService)
      .terminateSession('host-member', { source: 'remote-operation', reason: 'user-requested' });
    await hostAccounting.requestFullSweep();
    expect(unsettled(sqlite).batches).toBe(1);

    let atFinalPull: TimeTotals | null = null;
    const client = home().app.get(RemoteHostClient);
    const exportReplica = client.exportReplica.bind(client);
    jest.spyOn(client, 'exportReplica').mockImplementation(async (remoteId, projectId, scope) => {
      const replica = await exportReplica(remoteId, projectId, scope);
      if (scope === 'detach') atFinalPull = await totals(host());
      return replica;
    });

    const done = await runOperation('detach', { projectId: 'A' });

    expect(done.details.timeSettlement).toEqual<ProjectTimeSettlement>({
      outcome: 'forced',
      waitedMs: expect.any(Number),
      closedSegments: expect.any(Number),
      finalizedBatchIds: [batch.id],
      cancelledBatchIds: [],
    });
    expect((done.details.timeSettlement as ProjectTimeSettlement).waitedMs).toBeGreaterThanOrEqual(
      SETTLE_TIMEOUT_MS,
    );
    expect(atFinalPull).not.toBeNull();
    const hostTotals = atFinalPull as unknown as TimeTotals;
    // The finalized lane went to the lead's epic, and the direct work is there too.
    expect(hostTotals.byEpic).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ epic_id: 'epic-1', attribution_source: 'team' }),
      ]),
    );
    expect(await totals(home())).toEqual(hostTotals);
    expect(unsettled(home().sqlite)).toEqual({ segments: 0, batches: 0 });

    // Every travelling session arrived with a watermark at its last activity.
    expect(
      home()
        .sqlite.prepare(
          `SELECT s.id, w.last_activity_at = s.last_activity_at AS current
           FROM sessions s LEFT JOIN epic_time_session_watermarks w ON w.session_id = s.id
           WHERE s.id IN ('host-member', 'host-direct', 'host-old') ORDER BY s.id`,
        )
        .all(),
    ).toEqual([
      { id: 'host-direct', current: 1 },
      { id: 'host-member', current: 1 },
      { id: 'host-old', current: 1 },
    ]);

    // The connect + disconnect round trip kept home's link to another
    // project's epic: the host copy never carried it, so null must not win.
    expect(
      home().sqlite.prepare(`SELECT epic_id FROM sessions WHERE id = 'home-claude'`).get(),
    ).toEqual({ epic_id: 'epic-b' });

    await home().app.get(AgentTimeAccountingService).requestFullSweep();
    expect(await totals(home())).toEqual(hostTotals);

    // A home whose accounting started long ago would pick up any unwatermarked session.
    home()
      .sqlite.prepare(`UPDATE settings SET value = ? WHERE key = 'epicTime.trackingStartedAt'`)
      .run('2020-01-01T00:00:00.000Z');
    await instances.restartHome();
    expect(await totals(home())).toEqual(hostTotals);
    expect(unsettled(home().sqlite)).toEqual({ segments: 0, batches: 0 });
  });
});
