// Backend integration: real in-memory SQLite plus the real EpicTimeStore is
// the cheapest layer that proves the atomic stop/reset boundary — one queued
// transaction covering the stopped-state write, final reconciliation, team
// finalization ordering, and the ownership-scoped deletion, plus its rollback
// and retry behavior.
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { SessionCoordinatorService } from './session-coordinator.service';
import { SessionsService } from './sessions.service';
import { EpicTimeStore } from '../../epic-time/services/epic-time.store';
import { EPIC_TIME_DELIVERY_KEY } from '../../epic-time/services/agent-time-accounting.service';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '0defa017-0000-4000-8000-000000000001';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const MEMBER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_AGENT_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const TEAM_ID = 'team-time';
const TMUX_ID = 'tmux-time';
const TEST_TERMINATION = { source: 'web-api' as const, reason: 'user-requested' as const };
const T0 = '2026-01-01T00:00:10.000Z';
const T1 = '2026-01-01T00:00:12.000Z';
const T2 = '2026-01-01T00:00:16.000Z';

describe('session termination unlogged-time reset', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let store: EpicTimeStore;
  let sessionsService: SessionsService;
  let liveTmux: Set<string>;
  let eventsService: { publish: jest.Mock };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite);
    store = new EpicTimeStore(db);
    seedProject();
    seedAgent(AGENT_ID, 'Coder');
    seedSession(T1);
    liveTmux = new Set([TMUX_ID]);
    eventsService = { publish: jest.fn().mockResolvedValue(undefined) };

    const terminalIO = {
      destroyExpectedSession: jest.fn().mockImplementation(async ({ name }: { name: string }) => {
        if (!liveTmux.delete(name)) return { outcome: 'known-absent' };
        return { outcome: 'destroyed' };
      }),
    };
    sessionsService = new SessionsService(
      db,
      {} as never,
      terminalIO as never,
      { stopStreaming: jest.fn() } as never,
      {} as never,
      {} as never,
      new SessionCoordinatorService(),
      {} as never,
      { getAdapter: jest.fn() } as never,
      eventsService as never,
      { dispose: jest.fn() } as never,
      { clear: jest.fn() } as never,
      { cleanupSessionSync: jest.fn() } as never,
      { cleanupSession: jest.fn().mockResolvedValue(undefined) } as never,
      store,
    );
  });

  afterEach(() => sqlite.close());

  function seedProject(): void {
    const createdAt = '2026-01-01T00:00:00.000Z';
    sqlite
      .prepare(
        `INSERT INTO projects
           (id, workspace_id, name, root_path, is_template, is_private, created_at, updated_at)
         VALUES (?, ?, 'Time', '/tmp/time', 0, 0, ?, ?)`,
      )
      .run(PROJECT_ID, WORKSPACE_ID, createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO providers (id, name, mcp_configured, created_at, updated_at)
         VALUES ('provider-time', 'time-provider', 0, ?, ?)`,
      )
      .run(createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, project_id, name, created_at, updated_at)
         VALUES ('profile-time', ?, 'Time profile', ?, ?)`,
      )
      .run(PROJECT_ID, createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO profile_provider_configs
           (id, profile_id, provider_id, name, position, created_at, updated_at)
         VALUES ('config-time', 'profile-time', 'provider-time', 'Time config', 0, ?, ?)`,
      )
      .run(createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO statuses (id, project_id, label, color, position, created_at, updated_at)
         VALUES ('status-time', ?, 'New', '#fff', 0, ?, ?)`,
      )
      .run(PROJECT_ID, createdAt, createdAt);
  }

  function seedAgent(id: string, name: string): void {
    sqlite
      .prepare(
        `INSERT INTO agents
           (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
         VALUES (?, ?, 'profile-time', 'config-time', ?,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(id, PROJECT_ID, name);
  }

  function seedSession(lastActivityAt: string): void {
    sqlite
      .prepare(
        `INSERT INTO sessions
           (id, agent_id, tmux_session_id, status, started_at, last_activity_at,
            activity_state, busy_since, created_at, updated_at)
         VALUES (?, ?, ?, 'running', ?, ?, 'busy', ?, ?, ?)`,
      )
      .run(SESSION_ID, AGENT_ID, TMUX_ID, T0, lastActivityAt, '2026-01-01T00:00:11.000Z', T0, T0);
  }

  function updateSessionActivity(lastActivityAt: string, busySince: string): void {
    sqlite
      .prepare(
        `UPDATE sessions SET last_activity_at = ?, busy_since = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(lastActivityAt, busySince, lastActivityAt, SESSION_ID);
  }

  function sessionRow(): { status: string; ended_at: string | null } {
    return sqlite.prepare(`SELECT status, ended_at FROM sessions WHERE id = ?`).get(SESSION_ID) as {
      status: string;
      ended_at: string | null;
    };
  }

  function insertEpic(id: string): void {
    sqlite
      .prepare(
        `INSERT INTO epics
           (id, project_id, title, status_id, agent_id, version, created_at, updated_at)
         VALUES (?, ?, ?, 'status-time', NULL, 1, '2026-01-01T00:00:01.000Z',
                 '2026-01-01T00:00:01.000Z')`,
      )
      .run(id, PROJECT_ID, id);
  }

  function insertSegmentRow(input: {
    id: string;
    agentId?: string;
    epicId?: string | null;
    teamBatchId?: string | null;
    durationMs?: number;
    closed?: boolean;
    startedAt: string;
    lastActivityAt: string;
  }): void {
    sqlite
      .prepare(
        `INSERT INTO epic_time_segments
           (id, project_id, epic_id, team_batch_id, session_id_snapshot,
            agent_id_snapshot, agent_name_snapshot, started_at, last_activity_at,
            closed_at, duration_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'Coder', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        PROJECT_ID,
        input.epicId ?? null,
        input.teamBatchId ?? null,
        `session-${input.id}`,
        input.agentId ?? AGENT_ID,
        input.startedAt,
        input.lastActivityAt,
        input.closed === false ? null : input.lastActivityAt,
        input.durationMs ?? 60_000,
        input.lastActivityAt,
        input.lastActivityAt,
      );
  }

  function segments(): Array<Record<string, unknown>> {
    return sqlite
      .prepare(
        `SELECT id, epic_id, team_batch_id, agent_id_snapshot, closed_at, duration_ms
         FROM epic_time_segments ORDER BY id`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  function insertTeam(leadAgentId: string, memberAgentIds: readonly string[]): void {
    sqlite
      .prepare(
        `INSERT INTO teams
           (id, project_id, name, team_lead_agent_id, created_at, updated_at)
         VALUES (?, ?, 'Builders', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(TEAM_ID, PROJECT_ID, leadAgentId);
    const insertMember = sqlite.prepare(
      `INSERT INTO team_members (team_id, agent_id, created_at)
       VALUES (?, ?, '2026-01-01T00:00:00.000Z')`,
    );
    for (const memberAgentId of memberAgentIds) {
      insertMember.run(TEAM_ID, memberAgentId);
    }
  }

  function insertBatch(id: string, startedAt: string): void {
    sqlite
      .prepare(
        `INSERT INTO epic_time_team_batches
           (id, project_id, team_id_snapshot, team_name_snapshot,
            lead_agent_id_snapshot, lead_agent_name_snapshot, started_at,
            sealed_at, created_at, updated_at)
         VALUES (?, ?, ?, 'Builders', ?, 'Coder', ?, NULL, ?, ?)`,
      )
      .run(id, PROJECT_ID, TEAM_ID, AGENT_ID, startedAt, startedAt, startedAt);
  }

  function insertPendingDelivery(eventId: string): void {
    sqlite
      .prepare(
        `INSERT INTO events (id, name, payload_json, request_id, published_at)
         VALUES (?, 'epic.updated', '{}', NULL, '2026-01-01T00:00:05.000Z')`,
      )
      .run(eventId);
    sqlite
      .prepare(
        `INSERT INTO event_handlers
           (id, event_id, handler, status, delivery_key, attempts, retry_at,
            lease_owner, lease_expires_at, detail, started_at, ended_at)
         VALUES (?, ?, ?, 'pending', ?, 0, NULL, NULL, NULL, NULL, '2026-01-01T00:00:05.000Z', NULL)`,
      )
      .run(`${eventId}-delivery`, eventId, EPIC_TIME_DELIVERY_KEY, EPIC_TIME_DELIVERY_KEY);
  }

  function publishedNames(): string[] {
    return eventsService.publish.mock.calls.map(([name]) => name);
  }

  it('commits the stopped state, final reconciliation, and the ownership-scoped reset in one transaction', async () => {
    const activation = await store.activate(new Date(T0));
    // An earlier sweep already opened the live segment at T1.
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date(T1),
    );
    // Final activity at T2 is only reconciled by termination itself.
    updateSessionActivity(T2, '2026-01-01T00:00:11.000Z');
    insertEpic('task-epic');
    seedAgent(OTHER_AGENT_ID, 'Reviewer');
    insertSegmentRow({
      id: 'old-whole',
      startedAt: '2026-01-01T00:01:00.000Z',
      lastActivityAt: '2026-01-01T00:02:30.000Z',
      durationMs: 90_000,
    });
    insertSegmentRow({
      id: 'old-sub',
      startedAt: '2026-01-01T00:03:00.000Z',
      lastActivityAt: '2026-01-01T00:03:30.000Z',
      durationMs: 30_000,
    });
    insertSegmentRow({
      id: 'bound-row',
      epicId: 'task-epic',
      startedAt: '2026-01-01T00:04:00.000Z',
      lastActivityAt: '2026-01-01T00:05:00.000Z',
    });
    insertSegmentRow({
      id: 'other-agent-row',
      agentId: OTHER_AGENT_ID,
      startedAt: '2026-01-01T00:06:00.000Z',
      lastActivityAt: '2026-01-01T00:07:00.000Z',
    });

    await sessionsService.terminateSession(SESSION_ID, TEST_TERMINATION);

    expect(sessionRow()).toMatchObject({ status: 'stopped', ended_at: expect.any(String) });
    // The agent's whole settled unlogged balance — including its final
    // activity — is gone; Epic-bound and other-agent rows survive.
    expect(segments().map((row) => row.id)).toEqual(['bound-row', 'other-agent-row']);
    expect(
      sqlite
        .prepare(`SELECT last_activity_at FROM epic_time_session_watermarks WHERE session_id = ?`)
        .get(SESSION_ID),
    ).toEqual({ last_activity_at: T2 });
    expect(publishedNames()).toEqual([
      'session.stopped',
      'session.presence.changed',
      'epic.time.scope.invalidated',
    ]);
    expect(eventsService.publish).toHaveBeenCalledWith('epic.time.scope.invalidated', {
      workspaceId: WORKSPACE_ID,
    });
  });

  it('finalizes lead-owned team time before deleting it as the stopped lead settled balance', async () => {
    seedAgent(MEMBER_ID, 'Member');
    insertTeam(AGENT_ID, [MEMBER_ID]);
    insertBatch('batch-ready', '2026-01-01T00:00:05.000Z');
    insertSegmentRow({
      id: 'member-lane',
      agentId: MEMBER_ID,
      teamBatchId: 'batch-ready',
      startedAt: '2026-01-01T00:00:05.000Z',
      lastActivityAt: '2026-01-01T00:08:00.000Z',
      durationMs: 600_000,
      closed: false,
    });
    const activation = await store.activate(new Date(T0));
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date(T1),
    );
    updateSessionActivity(T2, '2026-01-01T00:00:11.000Z');

    await sessionsService.terminateSession(SESSION_ID, TEST_TERMINATION);

    // Sealing and finalization run inside the termination transaction: the
    // winner lane is transferred to the stopped lead and deleted together
    // with the lead's own final activity in the same commit. Had the
    // deletion run before finalization, the lane would have survived as a
    // lead-owned balance.
    expect(segments()).toEqual([]);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM epic_time_team_batches`).get()).toEqual({
      count: 0,
    });
    expect(publishedNames()).toContain('epic.time.scope.invalidated');
  });

  it('keeps a pending-barrier team lane so it can add time later', async () => {
    seedAgent(MEMBER_ID, 'Member');
    insertTeam(AGENT_ID, [MEMBER_ID]);
    insertBatch('batch-ready', '2026-01-01T00:00:05.000Z');
    insertSegmentRow({
      id: 'member-lane',
      agentId: MEMBER_ID,
      teamBatchId: 'batch-ready',
      startedAt: '2026-01-01T00:00:05.000Z',
      lastActivityAt: '2026-01-01T00:08:00.000Z',
      durationMs: 600_000,
      closed: false,
    });
    insertPendingDelivery('event-pending');
    const activation = await store.activate(new Date(T0));
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date(T1),
    );
    updateSessionActivity(T2, '2026-01-01T00:00:11.000Z');

    await sessionsService.terminateSession(SESSION_ID, TEST_TERMINATION);

    // The lane seals but its delivery barrier still blocks finalization, so
    // it keeps its batch membership and survives the reset untouched.
    expect(segments()).toEqual([
      expect.objectContaining({
        id: 'member-lane',
        team_batch_id: 'batch-ready',
        agent_id_snapshot: MEMBER_ID,
        closed_at: '2026-01-01T00:08:00.000Z',
      }),
    ]);
    expect(
      sqlite.prepare(`SELECT sealed_at FROM epic_time_team_batches WHERE id = 'batch-ready'`).get(),
    ).toMatchObject({ sealed_at: expect.any(String) });
    expect(publishedNames()).toContain('epic.time.scope.invalidated');
  });

  it('rolls back accounting writes with the stop state and completes on an explicit known-absent retry', async () => {
    const activation = await store.activate(new Date(T0));
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date(T1),
    );
    updateSessionActivity(T2, '2026-01-01T00:00:11.000Z');
    insertSegmentRow({
      id: 'old-whole',
      startedAt: '2026-01-01T00:01:00.000Z',
      lastActivityAt: '2026-01-01T00:02:30.000Z',
      durationMs: 90_000,
    });
    // Snapshot the exact pre-attempt accounting state: one open live segment,
    // one settled row, and the T1 watermark left by the earlier reconcile.
    const segmentsBefore = segments();
    expect(segmentsBefore).toHaveLength(2);
    const openLiveId = segmentsBefore.find((row) => row.id !== 'old-whole')!.id as string;
    const watermarkBefore = sqlite
      .prepare(`SELECT last_activity_at FROM epic_time_session_watermarks WHERE session_id = ?`)
      .get(SESSION_ID) as { last_activity_at: string };

    // The injected failure lands AFTER the real synchronous core has written:
    // the stopped row, the reconciled-and-closed live segment, the advanced
    // watermark, and the deletion all ran, so the rollback must restore them.
    const originalCore = store.runTerminationResetSync.bind(store);
    const resetSpy = jest
      .spyOn(store, 'runTerminationResetSync')
      .mockImplementationOnce((input) => {
        originalCore(input);
        throw new Error('injected accounting failure');
      });

    await expect(sessionsService.terminateSession(SESSION_ID, TEST_TERMINATION)).rejects.toThrow(
      'injected accounting failure',
    );
    // Physical destruction already happened, but nothing durable moved: the
    // row stays running, every accounting row and the watermark are restored
    // exactly, and no event was published.
    expect(sessionRow()).toMatchObject({ status: 'running', ended_at: null });
    expect(segments()).toEqual(segmentsBefore);
    expect(
      sqlite
        .prepare(`SELECT last_activity_at FROM epic_time_session_watermarks WHERE session_id = ?`)
        .get(SESSION_ID),
    ).toEqual(watermarkBefore);
    expect(
      sqlite.prepare(`SELECT closed_at FROM epic_time_segments WHERE id = ?`).get(openLiveId),
    ).toEqual({ closed_at: null });
    expect(eventsService.publish).not.toHaveBeenCalled();

    await sessionsService.terminateSession(SESSION_ID, TEST_TERMINATION);
    expect(resetSpy).toHaveBeenCalledTimes(2);
    expect(sessionRow()).toMatchObject({ status: 'stopped', ended_at: expect.any(String) });
    expect(segments()).toEqual([]);
    expect(
      sqlite
        .prepare(`SELECT last_activity_at FROM epic_time_session_watermarks WHERE session_id = ?`)
        .get(SESSION_ID),
    ).toEqual({ last_activity_at: T2 });
    expect(publishedNames()).toEqual([
      'session.stopped',
      'session.presence.changed',
      'epic.time.scope.invalidated',
    ]);
  });

  it('keeps a duplicate stop a no-op and preserves new time after a same-ID restore', async () => {
    const activation = await store.activate(new Date(T0));
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date(T1),
    );
    updateSessionActivity(T2, '2026-01-01T00:00:11.000Z');
    await sessionsService.terminateSession(SESSION_ID, TEST_TERMINATION);
    const eventsAfterFirstStop = eventsService.publish.mock.calls.length;
    expect(segments()).toEqual([]);

    await sessionsService.terminateSession(SESSION_ID, TEST_TERMINATION);
    expect(eventsService.publish.mock.calls.length).toBe(eventsAfterFirstStop);
    expect(segments()).toEqual([]);

    // Same-ID restore: the row flips back to running and later activity must
    // accumulate normally — the completed reset never touches new time.
    const T3 = '2026-01-01T00:00:20.000Z';
    const T4 = '2026-01-01T00:00:22.000Z';
    sqlite
      .prepare(
        `UPDATE sessions
         SET status = 'running', ended_at = NULL, last_activity_at = ?, busy_since = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(T4, T3, T4, SESSION_ID);
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date(T4),
    );

    // A full sweep after the reset cannot recreate the cleared rows.
    for (const sessionId of store.listReconciliationSessionIds(activation.trackingStartedAt)) {
      await store.reconcileSession(
        sessionId,
        activation.trackingStartedAt,
        activation.idleTimeoutMs,
        new Date(T4),
      );
    }
    await store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, activation.idleTimeoutMs, new Date(T4));

    expect(segments().map((row) => row.id)).toEqual([expect.any(String)]);
    expect(segments()[0]).toMatchObject({
      agent_id_snapshot: AGENT_ID,
      duration_ms: 2000,
      epic_id: null,
    });
    expect(
      sqlite
        .prepare(`SELECT last_activity_at FROM epic_time_session_watermarks WHERE session_id = ?`)
        .get(SESSION_ID),
    ).toEqual({ last_activity_at: T4 });
  });

  it('terminates lifecycle-only when the tracking-start setting is absent', async () => {
    expect(store.readActivationSettings().trackingStartedAt).toBeNull();
    updateSessionActivity(T2, '2026-01-01T00:00:11.000Z');
    insertSegmentRow({
      id: 'old-whole',
      startedAt: '2026-01-01T00:01:00.000Z',
      lastActivityAt: '2026-01-01T00:02:30.000Z',
      durationMs: 90_000,
    });

    await sessionsService.terminateSession(SESSION_ID, TEST_TERMINATION);

    expect(sessionRow()).toMatchObject({ status: 'stopped', ended_at: expect.any(String) });
    expect(segments().map((row) => row.id)).toEqual(['old-whole']);
    expect(publishedNames()).toEqual(['session.stopped', 'session.presence.changed']);
  });
});
