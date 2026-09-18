import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { EpicTimeStore } from './epic-time.store';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');
const PROJECT_ID = 'project-time';
const AGENT_ID = 'agent-time';
const SESSION_ID = 'session-time';
const TEAM_ID = 'team-time';
const LEAD_ID = 'lead-time';
const DELIVERY_KEY = 'epic-time-accounting';

// Layer: backend integration. Reconciliation correctness depends on real foreign
// keys, partial uniqueness, transactional watermarks, and deterministic SQL order.
describe('EpicTimeStore', () => {
  let sqlite: Database.Database;
  let store: EpicTimeStore;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    store = new EpicTimeStore(drizzle(sqlite) as unknown as BetterSQLite3Database);
    seedAgentAndSession();
  });

  afterEach(() => sqlite.close());

  function seedAgentAndSession(): void {
    const createdAt = '2026-01-01T00:00:00.000Z';
    sqlite
      .prepare(
        `INSERT INTO projects
           (id, name, root_path, is_template, is_private, created_at, updated_at)
         VALUES (?, 'Time', '/tmp/time', 0, 0, ?, ?)`,
      )
      .run(PROJECT_ID, createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO providers
           (id, name, mcp_configured, created_at, updated_at)
         VALUES ('provider-time', 'time-provider', 0, ?, ?)`,
      )
      .run(createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO agent_profiles
           (id, project_id, name, created_at, updated_at)
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
        `INSERT INTO agents
           (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
         VALUES (?, ?, 'profile-time', 'config-time', 'Coder', ?, ?)`,
      )
      .run(AGENT_ID, PROJECT_ID, createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO statuses
           (id, project_id, label, color, position, created_at, updated_at)
         VALUES ('status-time', ?, 'New', '#fff', 0, ?, ?)`,
      )
      .run(PROJECT_ID, createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO sessions
           (id, agent_id, status, started_at, last_activity_at, activity_state,
            busy_since, created_at, updated_at)
         VALUES (?, ?, 'running', ?, ?, 'busy', ?, ?, ?)`,
      )
      .run(
        SESSION_ID,
        AGENT_ID,
        createdAt,
        '2026-01-01T00:00:05.000Z',
        '2026-01-01T00:00:04.000Z',
        createdAt,
        createdAt,
      );
  }

  function insertEpic(id: string, updatedAt: string, assigned = true): void {
    sqlite
      .prepare(
        `INSERT INTO epics
           (id, project_id, title, status_id, agent_id, version, created_at, updated_at)
         VALUES (?, ?, ?, 'status-time', ?, 1, ?, ?)`,
      )
      .run(id, PROJECT_ID, id, assigned ? AGENT_ID : null, updatedAt, updatedAt);
  }

  function insertAgent(id: string, name: string): void {
    sqlite
      .prepare(
        `INSERT INTO agents
           (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
         VALUES (?, ?, 'profile-time', 'config-time', ?,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(id, PROJECT_ID, name);
  }

  function insertTeam(
    id: string,
    leadAgentId: string | null,
    memberAgentIds: readonly string[],
    name = 'Builders',
  ): void {
    sqlite
      .prepare(
        `INSERT INTO teams
           (id, project_id, name, team_lead_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(id, PROJECT_ID, name, leadAgentId);
    const insertMember = sqlite.prepare(
      `INSERT INTO team_members (team_id, agent_id, created_at)
       VALUES (?, ?, '2026-01-01T00:00:00.000Z')`,
    );
    for (const memberAgentId of memberAgentIds) {
      insertMember.run(id, memberAgentId);
    }
  }

  function seedValidTeam(memberAgentIds: readonly string[] = [AGENT_ID]): void {
    insertAgent(LEAD_ID, 'Team Lead');
    insertTeam(TEAM_ID, LEAD_ID, memberAgentIds);
  }

  function updateSession(fields: {
    lastActivityAt: string;
    busySince?: string;
    status?: string;
    activityState?: string;
    epicId?: string | null;
  }): void {
    sqlite
      .prepare(
        `UPDATE sessions
         SET last_activity_at = ?, busy_since = ?, status = ?, activity_state = ?, epic_id = ?
         WHERE id = ?`,
      )
      .run(
        fields.lastActivityAt,
        fields.busySince ?? fields.lastActivityAt,
        fields.status ?? 'running',
        fields.activityState ?? 'busy',
        fields.epicId ?? null,
        SESSION_ID,
      );
  }

  function segments(): Array<Record<string, unknown>> {
    return sqlite
      .prepare(
        `SELECT id, epic_id, team_batch_id, attribution_source,
                team_id_snapshot, team_name_snapshot, session_id_snapshot,
                agent_id_snapshot, agent_name_snapshot, started_at,
                last_activity_at, closed_at, duration_ms
         FROM epic_time_segments
         ORDER BY created_at, id`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  function batches(): Array<Record<string, unknown>> {
    return sqlite
      .prepare(
        `SELECT id, project_id, team_id_snapshot, team_name_snapshot,
                lead_agent_id_snapshot, lead_agent_name_snapshot,
                started_at, sealed_at
         FROM epic_time_team_batches
         ORDER BY started_at, id`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  function barriers(): Array<Record<string, unknown>> {
    return sqlite
      .prepare(
        `SELECT team_batch_id, committed_event_id
         FROM epic_time_team_batch_event_barriers
         ORDER BY committed_event_id`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  function insertBufferedSegment(
    id: string,
    startedAt: string,
    lastActivityAt: string,
    epicId: string | null = null,
  ): void {
    sqlite
      .prepare(
        `INSERT INTO epic_time_segments
           (id, project_id, epic_id, session_id_snapshot, agent_id_snapshot,
            agent_name_snapshot, started_at, last_activity_at, closed_at,
            duration_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'Coder', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        PROJECT_ID,
        epicId,
        `${SESSION_ID}-${id}`,
        AGENT_ID,
        startedAt,
        lastActivityAt,
        lastActivityAt,
        Date.parse(lastActivityAt) - Date.parse(startedAt),
        lastActivityAt,
        lastActivityAt,
      );
  }

  function insertTeamSegment(input: {
    id: string;
    batchId: string;
    agentId: string;
    agentName: string;
    sessionId?: string;
    startedAt: string;
    lastActivityAt: string;
    durationMs: number;
    closed?: boolean;
  }): void {
    sqlite
      .prepare(
        `INSERT INTO epic_time_segments
           (id, project_id, epic_id, team_batch_id, attribution_source,
            team_id_snapshot, team_name_snapshot, session_id_snapshot,
            agent_id_snapshot, agent_name_snapshot, started_at, last_activity_at,
            closed_at, duration_ms, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'direct', ?, 'Builders', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        PROJECT_ID,
        input.batchId,
        TEAM_ID,
        input.sessionId ?? `${input.id}-session`,
        input.agentId,
        input.agentName,
        input.startedAt,
        input.lastActivityAt,
        input.closed ? input.lastActivityAt : null,
        input.durationMs,
        input.lastActivityAt,
        input.lastActivityAt,
      );
  }

  function insertBatch(id: string, startedAt: string, sealedAt: string | null): void {
    sqlite
      .prepare(
        `INSERT INTO epic_time_team_batches
           (id, project_id, team_id_snapshot, team_name_snapshot,
            lead_agent_id_snapshot, lead_agent_name_snapshot, started_at,
            sealed_at, created_at, updated_at)
         VALUES (?, ?, ?, 'Builders', ?, 'Team Lead', ?, ?, ?, ?)`,
      )
      .run(id, PROJECT_ID, TEAM_ID, LEAD_ID, startedAt, sealedAt, startedAt, startedAt);
  }

  function insertDelivery(
    eventId: string,
    status: 'pending' | 'running' | 'retry' | 'delivered',
    publishedAt: string,
  ): void {
    sqlite
      .prepare(
        `INSERT INTO events (id, name, payload_json, request_id, published_at)
         VALUES (?, 'epic.updated', '{}', NULL, ?)`,
      )
      .run(eventId, publishedAt);
    sqlite
      .prepare(
        `INSERT INTO event_handlers
           (id, event_id, handler, status, delivery_key, attempts, retry_at,
            lease_owner, lease_expires_at, detail, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, ?, NULL)`,
      )
      .run(`${eventId}-delivery`, eventId, DELIVERY_KEY, status, DELIVERY_KEY, publishedAt);
  }

  function receipts(): Array<Record<string, unknown>> {
    return sqlite
      .prepare(
        `SELECT claim_sequence, committed_event_id, event_name, agent_id_snapshot,
                target_epic_id_snapshot, published_at, source_event_row_id
         FROM epic_time_buffer_claims
         ORDER BY claim_sequence`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  function insertSegmentRow(input: {
    id: string;
    agentId?: string;
    projectId?: string;
    epicId?: string | null;
    teamBatchId?: string | null;
    durationMs?: number;
    closedAt?: string | null;
    startedAt: string;
    lastActivityAt: string;
    updatedAt?: string;
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
        input.projectId ?? PROJECT_ID,
        input.epicId ?? null,
        input.teamBatchId ?? null,
        `session-${input.id}`,
        input.agentId ?? AGENT_ID,
        input.startedAt,
        input.lastActivityAt,
        input.closedAt === undefined ? input.lastActivityAt : input.closedAt,
        input.durationMs ?? 60_000,
        input.lastActivityAt,
        input.updatedAt ?? input.lastActivityAt,
      );
  }

  function epicIds(ids: readonly string[]): Array<Record<string, unknown>> {
    const placeholders = ids.map(() => '?').join(', ');
    return sqlite
      .prepare(
        `SELECT id, epic_id, updated_at FROM epic_time_segments
         WHERE id IN (${placeholders}) ORDER BY id`,
      )
      .all(...ids) as Array<Record<string, unknown>>;
  }

  it('sets activation once and excludes historical activity from the first sweep', async () => {
    const first = await store.activate(new Date('2026-01-01T00:00:10.000Z'));
    const second = await store.activate(new Date('2026-01-01T00:00:20.000Z'));

    expect(first).toMatchObject({
      trackingStartedAt: '2026-01-01T00:00:10.000Z',
      firstActivation: true,
    });
    expect(second).toMatchObject({
      trackingStartedAt: '2026-01-01T00:00:10.000Z',
      firstActivation: false,
    });
    expect(store.listReconciliationSessionIds(first.trackingStartedAt)).toEqual([]);
  });

  it('prefers the bound Epic, then the latest exact-agent assignment', async () => {
    insertEpic('a-older', '2026-01-01T00:00:09.000Z');
    insertEpic('z-latest', '2026-01-01T00:00:09.000Z');
    insertEpic('bound-epic', '2026-01-01T00:00:01.000Z', false);
    const activation = await store.activate(new Date('2026-01-01T00:00:10.000Z'));

    updateSession({
      lastActivityAt: '2026-01-01T00:00:12.000Z',
      busySince: '2026-01-01T00:00:11.000Z',
    });
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date('2026-01-01T00:00:12.000Z'),
    );
    expect(segments()).toEqual([
      expect.objectContaining({
        last_activity_at: '2026-01-01T00:00:12.000Z',
        closed_at: null,
        duration_ms: 1000,
      }),
    ]);
    expect(segments()[0]).toMatchObject({ epic_id: 'z-latest', duration_ms: 1000 });

    updateSession({
      lastActivityAt: '2026-01-01T00:00:13.000Z',
      busySince: '2026-01-01T00:00:11.000Z',
      epicId: 'bound-epic',
    });
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date('2026-01-01T00:00:13.000Z'),
    );
    expect(segments()).toEqual([
      expect.objectContaining({ epic_id: 'z-latest', closed_at: '2026-01-01T00:00:12.000Z' }),
      expect.objectContaining({ epic_id: 'bound-epic', duration_ms: 1000 }),
    ]);
  });

  it('records a delayed terminal hint once and advances the watermark atomically', async () => {
    insertEpic('epic-1', '2026-01-01T00:00:09.000Z');
    const activation = await store.activate(new Date('2026-01-01T00:00:10.000Z'));
    updateSession({
      lastActivityAt: '2026-01-01T00:00:15.000Z',
      busySince: '2026-01-01T00:00:11.000Z',
      status: 'stopped',
    });

    const [first, duplicate] = await Promise.all([
      store.reconcileSession(
        SESSION_ID,
        activation.trackingStartedAt,
        activation.idleTimeoutMs,
        new Date('2026-01-01T00:00:20.000Z'),
      ),
      store.reconcileSession(
        SESSION_ID,
        activation.trackingStartedAt,
        activation.idleTimeoutMs,
        new Date('2026-01-01T00:00:20.000Z'),
      ),
    ]);

    expect([first.action, duplicate.action]).toEqual(['created_closed', 'noop']);
    expect(segments()).toEqual([
      expect.objectContaining({
        epic_id: 'epic-1',
        started_at: '2026-01-01T00:00:11.000Z',
        last_activity_at: '2026-01-01T00:00:15.000Z',
        closed_at: '2026-01-01T00:00:15.000Z',
        duration_ms: 4000,
      }),
    ]);
    expect(
      sqlite
        .prepare(`SELECT last_activity_at FROM epic_time_session_watermarks WHERE session_id = ?`)
        .get(SESSION_ID),
    ).toEqual({ last_activity_at: '2026-01-01T00:00:15.000Z' });
  });

  it('recovers persisted activity before startup close without counting process downtime', async () => {
    insertEpic('epic-1', '2026-01-01T00:00:09.000Z');
    const activation = await store.activate(new Date('2026-01-01T00:00:10.000Z'));
    updateSession({
      lastActivityAt: '2026-01-01T00:00:12.000Z',
      busySince: '2026-01-01T00:00:11.000Z',
    });
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date('2026-01-01T00:00:12.000Z'),
    );
    expect(segments()).toEqual([
      expect.objectContaining({
        last_activity_at: '2026-01-01T00:00:12.000Z',
        closed_at: null,
        duration_ms: 1000,
      }),
    ]);

    // T1 is accounted, then meaningful activity persists T2 without another sweep.
    updateSession({
      lastActivityAt: '2026-01-01T00:00:14.000Z',
      busySince: '2026-01-01T00:00:11.000Z',
    });
    const restart = await store.activate(new Date('2026-01-01T00:00:20.000Z'));
    expect(restart.recoveredOpenSegments).toBe(1);
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date('2026-01-01T00:00:20.000Z'),
      { forceCloseOpenSegment: true },
    );
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date('2026-01-01T00:00:20.000Z'),
      { forceCloseOpenSegment: true },
    );
    const secondRestart = await store.activate(new Date('2026-01-01T00:00:21.000Z'));
    expect(secondRestart.recoveredOpenSegments).toBe(0);
    expect(store.listReconciliationSessionIds(activation.trackingStartedAt)).toEqual([]);

    expect(segments()).toEqual([
      expect.objectContaining({
        started_at: '2026-01-01T00:00:11.000Z',
        last_activity_at: '2026-01-01T00:00:14.000Z',
        closed_at: '2026-01-01T00:00:14.000Z',
        duration_ms: 3000,
      }),
    ]);
    expect(
      sqlite
        .prepare(`SELECT last_activity_at FROM epic_time_session_watermarks WHERE session_id = ?`)
        .get(SESSION_ID),
    ).toEqual({ last_activity_at: '2026-01-01T00:00:14.000Z' });
  });

  it('keeps the high-water after Epic cascade deletion and segment discard', async () => {
    insertEpic('epic-1', '2026-01-01T00:00:09.000Z');
    const activation = await store.activate(new Date('2026-01-01T00:00:10.000Z'));
    updateSession({
      lastActivityAt: '2026-01-01T00:00:12.000Z',
      busySince: '2026-01-01T00:00:11.000Z',
      status: 'stopped',
    });
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date('2026-01-01T00:00:12.000Z'),
    );
    sqlite.prepare(`DELETE FROM epics WHERE id = 'epic-1'`).run();

    expect(segments()).toEqual([]);
    expect(store.listReconciliationSessionIds(activation.trackingStartedAt)).toEqual([]);
    expect(
      sqlite
        .prepare(`SELECT last_activity_at FROM epic_time_session_watermarks WHERE session_id = ?`)
        .get(SESSION_ID),
    ).toEqual({ last_activity_at: '2026-01-01T00:00:12.000Z' });
  });

  it('creates more time only after persisted activity advances past the watermark', async () => {
    const activation = await store.activate(new Date('2026-01-01T00:00:10.000Z'));
    updateSession({
      lastActivityAt: '2026-01-01T00:00:12.000Z',
      busySince: '2026-01-01T00:00:11.000Z',
      status: 'stopped',
    });
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date('2026-01-01T00:00:12.000Z'),
    );
    const countAfterFirst = segments().length;

    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date('2026-01-01T00:00:20.000Z'),
    );
    expect(segments()).toHaveLength(countAfterFirst);

    updateSession({
      lastActivityAt: '2026-01-01T00:00:21.000Z',
      busySince: '2026-01-01T00:00:21.000Z',
      status: 'stopped',
    });
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date('2026-01-01T00:00:21.000Z'),
    );
    expect(segments()).toHaveLength(countAfterFirst + 1);
  });

  it('claims buffered time on the next exact-agent creation exactly once', async () => {
    insertEpic('target-create', '2026-01-01T00:00:19.000Z', false);
    insertBufferedSegment('buffer-create', '2026-01-01T00:00:11.000Z', '2026-01-01T00:00:15.000Z');
    sqlite
      .prepare(
        `INSERT INTO events (id, name, payload_json, request_id, published_at)
         VALUES ('event-create', 'epic.created', '{}', NULL, '2026-01-01T00:00:20.000Z')`,
      )
      .run();

    const first = await store.recordTaskTouch({
      committedEventId: 'event-create',
      eventName: 'epic.created',
      projectId: PROJECT_ID,
      actorAgentId: AGENT_ID,
      targetEpicId: 'target-create',
      targetEpicTitle: 'Created target',
      publishedAt: '2026-01-01T00:00:20.000Z',
    });
    const duplicate = await store.recordTaskTouch({
      committedEventId: 'event-create',
      eventName: 'epic.created',
      projectId: PROJECT_ID,
      actorAgentId: AGENT_ID,
      targetEpicId: 'target-create',
      targetEpicTitle: 'Created target',
      publishedAt: '2026-01-01T00:00:20.000Z',
    });

    expect(first).toEqual({ receiptCreated: true, claimedSegments: 1, discardedSegments: 0 });
    expect(duplicate).toEqual({
      receiptCreated: false,
      claimedSegments: 0,
      discardedSegments: 0,
    });
    expect(segments()).toEqual([expect.objectContaining({ epic_id: 'target-create' })]);
    expect(receipts()).toEqual([
      expect.objectContaining({
        committed_event_id: 'event-create',
        event_name: 'epic.created',
        source_event_row_id: expect.any(Number),
      }),
    ]);
  });

  it('claims buffered time through a comment touch to the exact commented Epic once', async () => {
    insertEpic('comment-target', '2026-01-01T00:00:19.000Z', false);
    insertBufferedSegment('buffer-comment', '2026-01-01T00:00:11.000Z', '2026-01-01T00:00:15.000Z');
    sqlite
      .prepare(
        `INSERT INTO events (id, name, payload_json, request_id, published_at)
         VALUES ('event-comment', 'epic.comment.created', '{}', NULL, '2026-01-01T00:00:20.000Z')`,
      )
      .run();

    const first = await store.recordTaskTouch({
      committedEventId: 'event-comment',
      eventName: 'epic.comment.created',
      projectId: PROJECT_ID,
      actorAgentId: AGENT_ID,
      targetEpicId: 'comment-target',
      targetEpicTitle: 'Comment target',
      publishedAt: '2026-01-01T00:00:20.000Z',
    });
    const duplicate = await store.recordTaskTouch({
      committedEventId: 'event-comment',
      eventName: 'epic.comment.created',
      projectId: PROJECT_ID,
      actorAgentId: AGENT_ID,
      targetEpicId: 'comment-target',
      targetEpicTitle: 'Comment target',
      publishedAt: '2026-01-01T00:00:20.000Z',
    });

    expect(first).toEqual({ receiptCreated: true, claimedSegments: 1, discardedSegments: 0 });
    expect(duplicate).toEqual({
      receiptCreated: false,
      claimedSegments: 0,
      discardedSegments: 0,
    });
    expect(segments()).toEqual([expect.objectContaining({ epic_id: 'comment-target' })]);
    expect(receipts()).toEqual([
      expect.objectContaining({
        committed_event_id: 'event-comment',
        event_name: 'epic.comment.created',
        source_event_row_id: expect.any(Number),
      }),
    ]);
  });

  it('rolls back the permanent receipt when claim application fails', async () => {
    insertEpic('target-rollback', '2026-01-01T00:00:19.000Z', false);
    insertBufferedSegment(
      'buffer-rollback',
      '2026-01-01T00:00:11.000Z',
      '2026-01-01T00:00:15.000Z',
    );
    sqlite.exec(`
      CREATE TRIGGER fail_epic_time_claim
      BEFORE UPDATE OF epic_id ON epic_time_segments
      BEGIN
        SELECT RAISE(ABORT, 'claim application failed');
      END;
    `);

    await expect(
      store.recordTaskTouch({
        committedEventId: 'event-rollback',
        eventName: 'epic.updated',
        projectId: PROJECT_ID,
        actorAgentId: AGENT_ID,
        targetEpicId: 'target-rollback',
        targetEpicTitle: 'Rollback',
        publishedAt: '2026-01-01T00:00:20.000Z',
      }),
    ).rejects.toThrow('claim application failed');

    expect(receipts()).toEqual([]);
    expect(segments()).toEqual([expect.objectContaining({ epic_id: null })]);
  });

  it('uses the earliest published receipt and claim sequence for a late segment', async () => {
    insertEpic('target-first', '2026-01-01T00:00:19.000Z', false);
    insertEpic('target-second', '2026-01-01T00:00:19.000Z', false);
    for (const [eventId, targetEpicId] of [
      ['event-first', 'target-first'],
      ['event-second', 'target-second'],
    ] as const) {
      await store.recordTaskTouch({
        committedEventId: eventId,
        eventName: 'epic.updated',
        projectId: PROJECT_ID,
        actorAgentId: AGENT_ID,
        targetEpicId,
        targetEpicTitle: targetEpicId,
        publishedAt: '2026-01-01T00:00:20.000Z',
      });
    }
    const activation = await store.activate(new Date('2026-01-01T00:00:10.000Z'));
    updateSession({
      lastActivityAt: '2026-01-01T00:00:15.000Z',
      busySince: '2026-01-01T00:00:11.000Z',
      status: 'stopped',
    });

    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date('2026-01-01T00:00:21.000Z'),
    );

    expect(segments()).toEqual([expect.objectContaining({ epic_id: 'target-first' })]);
  });

  it('does not let an earlier receipt claim a segment that starts later', async () => {
    insertEpic('target-before', '2026-01-01T00:00:11.000Z', false);
    insertEpic('target-after', '2026-01-01T00:00:16.000Z', false);
    await store.recordTaskTouch({
      committedEventId: 'event-before',
      eventName: 'epic.updated',
      projectId: PROJECT_ID,
      actorAgentId: AGENT_ID,
      targetEpicId: 'target-before',
      targetEpicTitle: 'Before',
      publishedAt: '2026-01-01T00:00:12.000Z',
    });
    const activation = await store.activate(new Date('2026-01-01T00:00:10.000Z'));
    updateSession({
      lastActivityAt: '2026-01-01T00:00:15.000Z',
      busySince: '2026-01-01T00:00:15.000Z',
      status: 'stopped',
    });
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date('2026-01-01T00:00:15.000Z'),
    );
    expect(segments()).toEqual([expect.objectContaining({ epic_id: null })]);

    await store.recordTaskTouch({
      committedEventId: 'event-after',
      eventName: 'epic.created',
      projectId: PROJECT_ID,
      actorAgentId: AGENT_ID,
      targetEpicId: 'target-after',
      targetEpicTitle: 'After',
      publishedAt: '2026-01-01T00:00:16.000Z',
    });
    expect(segments()).toEqual([expect.objectContaining({ epic_id: 'target-after' })]);
  });

  it('permanently discards a late segment when its earliest target was deleted', async () => {
    insertEpic('deleted-target', '2026-01-01T00:00:19.000Z', false);
    await store.recordTaskTouch({
      committedEventId: 'event-deleted',
      eventName: 'epic.updated',
      projectId: PROJECT_ID,
      actorAgentId: AGENT_ID,
      targetEpicId: 'deleted-target',
      targetEpicTitle: 'Deleted',
      publishedAt: '2026-01-01T00:00:20.000Z',
    });
    sqlite.prepare(`DELETE FROM epics WHERE id = 'deleted-target'`).run();
    const activation = await store.activate(new Date('2026-01-01T00:00:10.000Z'));
    updateSession({
      lastActivityAt: '2026-01-01T00:00:15.000Z',
      busySince: '2026-01-01T00:00:11.000Z',
      status: 'stopped',
    });

    await expect(
      store.reconcileSession(
        SESSION_ID,
        activation.trackingStartedAt,
        activation.idleTimeoutMs,
        new Date('2026-01-01T00:00:21.000Z'),
      ),
    ).resolves.toMatchObject({ action: 'discarded', segmentId: null });
    expect(segments()).toEqual([]);

    insertEpic('later-target', '2026-01-01T00:00:22.000Z', false);
    await store.recordTaskTouch({
      committedEventId: 'event-later',
      eventName: 'epic.created',
      projectId: PROJECT_ID,
      actorAgentId: AGENT_ID,
      targetEpicId: 'later-target',
      targetEpicTitle: 'Later',
      publishedAt: '2026-01-01T00:00:22.000Z',
    });
    expect(segments()).toEqual([]);
  });

  it('scopes claims to the exact actor and never moves a non-null segment', async () => {
    insertEpic('original-target', '2026-01-01T00:00:10.000Z', false);
    insertEpic('later-target', '2026-01-01T00:00:20.000Z', false);
    sqlite
      .prepare(
        `INSERT INTO agents
           (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
         VALUES ('agent-other', ?, 'profile-time', 'config-time', 'Other',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(PROJECT_ID);
    insertBufferedSegment(
      'already-attributed',
      '2026-01-01T00:00:11.000Z',
      '2026-01-01T00:00:15.000Z',
      'original-target',
    );
    insertBufferedSegment(
      'buffer-for-coder',
      '2026-01-01T00:00:11.000Z',
      '2026-01-01T00:00:15.000Z',
    );

    await expect(
      store.recordTaskTouch({
        committedEventId: 'event-other-agent',
        eventName: 'epic.updated',
        projectId: PROJECT_ID,
        actorAgentId: 'agent-other',
        targetEpicId: 'later-target',
        targetEpicTitle: 'Later',
        publishedAt: '2026-01-01T00:00:20.000Z',
      }),
    ).resolves.toEqual({ receiptCreated: true, claimedSegments: 0, discardedSegments: 0 });
    await store.recordTaskTouch({
      committedEventId: 'event-later',
      eventName: 'epic.updated',
      projectId: PROJECT_ID,
      actorAgentId: AGENT_ID,
      targetEpicId: 'later-target',
      targetEpicTitle: 'Later',
      publishedAt: '2026-01-01T00:00:20.000Z',
    });

    expect(segments()).toEqual([
      expect.objectContaining({ id: 'already-attributed', epic_id: 'original-target' }),
      expect.objectContaining({ id: 'buffer-for-coder', epic_id: 'later-target' }),
    ]);
  });

  it('advances the watermark when attribution facts disappear and does not rediscover activity', async () => {
    insertEpic('bound-epic', '2026-01-01T00:00:09.000Z', false);
    const activation = await store.activate(new Date('2026-01-01T00:00:10.000Z'));
    updateSession({
      lastActivityAt: '2026-01-01T00:00:12.000Z',
      busySince: '2026-01-01T00:00:11.000Z',
      epicId: 'bound-epic',
    });
    sqlite.prepare(`UPDATE sessions SET agent_id = NULL WHERE id = ?`).run(SESSION_ID);

    await expect(
      store.reconcileSession(
        SESSION_ID,
        activation.trackingStartedAt,
        activation.idleTimeoutMs,
        new Date('2026-01-01T00:00:12.000Z'),
      ),
    ).resolves.toMatchObject({ action: 'discarded', watermark: '2026-01-01T00:00:12.000Z' });
    expect(segments()).toEqual([]);
    expect(store.listReconciliationSessionIds(activation.trackingStartedAt)).toEqual([]);
  });

  it('does not mutate the attributed Epic version or updated timestamp', async () => {
    insertEpic('epic-1', '2026-01-01T00:00:09.000Z');
    const before = sqlite
      .prepare(`SELECT version, updated_at FROM epics WHERE id = 'epic-1'`)
      .get();
    const activation = await store.activate(new Date('2026-01-01T00:00:10.000Z'));
    updateSession({
      lastActivityAt: '2026-01-01T00:00:12.000Z',
      busySince: '2026-01-01T00:00:11.000Z',
    });
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date('2026-01-01T00:00:12.000Z'),
    );

    expect(
      sqlite.prepare(`SELECT version, updated_at FROM epics WHERE id = 'epic-1'`).get(),
    ).toEqual(before);
  });

  it.each([
    ['valid member', 'valid', true],
    ['Team Lead', 'lead', false],
    ['leadless team member', 'leadless', false],
    ['agent without a team', 'none', false],
    ['multi-team member', 'multiple', false],
  ] as const)(
    'attributes eligible activity for a %s only when exactly one led team is valid',
    async (_label, setup, expectsBatch) => {
      if (setup === 'valid') {
        seedValidTeam();
      } else if (setup === 'lead') {
        insertTeam(TEAM_ID, AGENT_ID, [AGENT_ID]);
      } else if (setup === 'leadless') {
        insertTeam(TEAM_ID, null, [AGENT_ID]);
      } else if (setup === 'multiple') {
        insertAgent(LEAD_ID, 'Team Lead');
        insertTeam(TEAM_ID, LEAD_ID, [AGENT_ID]);
        insertTeam('team-other', LEAD_ID, [AGENT_ID], 'Other');
      }
      const activation = await store.activate(new Date('2026-01-01T00:00:10.000Z'));
      updateSession({
        lastActivityAt: '2026-01-01T00:00:12.000Z',
        busySince: '2026-01-01T00:00:11.000Z',
      });

      await store.reconcileSession(
        SESSION_ID,
        activation.trackingStartedAt,
        activation.idleTimeoutMs,
        new Date('2026-01-01T00:00:12.000Z'),
      );

      expect(segments()).toEqual([
        expect.objectContaining(
          expectsBatch
            ? {
                team_batch_id: expect.any(String),
                team_id_snapshot: TEAM_ID,
                team_name_snapshot: 'Builders',
              }
            : {
                team_batch_id: null,
                team_id_snapshot: null,
                team_name_snapshot: null,
              },
        ),
      ]);
      expect(batches()).toHaveLength(expectsBatch ? 1 : 0);
    },
  );

  it('seals at the last inactive member, snapshots active delivery UUIDs, and opens a later batch', async () => {
    seedValidTeam();
    const activation = await store.activate(new Date('2026-01-01T00:00:10.000Z'));
    updateSession({
      lastActivityAt: '2026-01-01T00:00:12.000Z',
      busySince: '2026-01-01T00:00:11.000Z',
    });
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date('2026-01-01T00:00:12.000Z'),
    );
    const firstBatchId = batches()[0]?.id as string;
    insertAgent('agent-helper', 'Helper');
    sqlite
      .prepare(
        `INSERT INTO team_members (team_id, agent_id, created_at)
         VALUES (?, 'agent-helper', '2026-01-01T00:00:00.000Z')`,
      )
      .run(TEAM_ID);
    insertTeamSegment({
      id: 'helper-open',
      batchId: firstBatchId,
      agentId: 'agent-helper',
      agentName: 'Helper',
      startedAt: '2026-01-01T00:00:11.500Z',
      lastActivityAt: '2026-01-01T00:00:12.500Z',
      durationMs: 1_000,
    });
    insertDelivery('event-pending', 'pending', '2026-01-01T00:00:12.100Z');
    insertDelivery('event-running', 'running', '2026-01-01T00:00:12.200Z');
    insertDelivery('event-retry', 'retry', '2026-01-01T00:00:12.300Z');
    insertDelivery('event-delivered', 'delivered', '2026-01-01T00:00:12.400Z');

    updateSession({
      lastActivityAt: '2026-01-01T00:00:12.000Z',
      busySince: '2026-01-01T00:00:11.000Z',
      activityState: 'idle',
    });
    await store.reconcileSession(
      SESSION_ID,
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      new Date('2026-01-01T00:00:13.000Z'),
    );
    await expect(
      store.processTeamBatches(
        DELIVERY_KEY,
        activation.idleTimeoutMs,
        new Date('2026-01-01T00:00:13.000Z'),
      ),
    ).resolves.toEqual({ sealedBatches: 1, finalizedBatches: 0, cancelledBatches: 0 });

    expect(batches()).toEqual([
      expect.objectContaining({ id: firstBatchId, sealed_at: '2026-01-01T00:00:13.000Z' }),
    ]);
    expect(segments()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          team_batch_id: firstBatchId,
          session_id_snapshot: SESSION_ID,
          closed_at: '2026-01-01T00:00:12.000Z',
        }),
        expect.objectContaining({
          id: 'helper-open',
          team_batch_id: firstBatchId,
          closed_at: '2026-01-01T00:00:12.500Z',
        }),
      ]),
    );
    expect(barriers()).toEqual([
      { team_batch_id: firstBatchId, committed_event_id: 'event-pending' },
      { team_batch_id: firstBatchId, committed_event_id: 'event-retry' },
      { team_batch_id: firstBatchId, committed_event_id: 'event-running' },
    ]);

    store = new EpicTimeStore(drizzle(sqlite) as unknown as BetterSQLite3Database);
    const restarted = await store.activate(new Date('2026-01-01T00:00:13.500Z'));
    updateSession({
      lastActivityAt: '2026-01-01T00:00:14.000Z',
      busySince: '2026-01-01T00:00:14.000Z',
      activityState: 'busy',
    });
    await store.reconcileSession(
      SESSION_ID,
      restarted.trackingStartedAt,
      restarted.idleTimeoutMs,
      new Date('2026-01-01T00:00:14.000Z'),
    );

    expect(batches()).toEqual([
      expect.objectContaining({ id: firstBatchId, sealed_at: '2026-01-01T00:00:13.000Z' }),
      expect.objectContaining({ id: expect.not.stringMatching(firstBatchId), sealed_at: null }),
    ]);
  });

  it('claims sealed team time only through exact barrier membership', async () => {
    seedValidTeam();
    insertEpic('target-pre-seal', '2026-01-01T00:00:19.000Z', false);
    insertEpic('target-post-seal', '2026-01-01T00:00:20.000Z', false);
    insertBatch('batch-pre', '2026-01-01T00:00:10.000Z', '2026-01-01T00:00:18.000Z');
    insertTeamSegment({
      id: 'segment-pre',
      batchId: 'batch-pre',
      agentId: AGENT_ID,
      agentName: 'Coder',
      startedAt: '2026-01-01T00:00:11.000Z',
      lastActivityAt: '2026-01-01T00:00:15.000Z',
      durationMs: 4_000,
      closed: true,
    });
    insertDelivery('event-pre-seal', 'running', '2026-01-01T00:00:17.000Z');
    sqlite
      .prepare(
        `INSERT INTO epic_time_team_batch_event_barriers
           (team_batch_id, committed_event_id, created_at)
         VALUES ('batch-pre', 'event-pre-seal', '2026-01-01T00:00:18.000Z')`,
      )
      .run();

    await expect(
      store.recordTaskTouch({
        committedEventId: 'event-pre-seal',
        eventName: 'epic.updated',
        projectId: PROJECT_ID,
        actorAgentId: AGENT_ID,
        targetEpicId: 'target-pre-seal',
        targetEpicTitle: 'Before seal',
        publishedAt: '2026-01-01T00:00:17.000Z',
      }),
    ).resolves.toEqual({ receiptCreated: true, claimedSegments: 1, discardedSegments: 0 });
    expect(segments()).toEqual([
      expect.objectContaining({
        id: 'segment-pre',
        epic_id: 'target-pre-seal',
        team_batch_id: null,
        attribution_source: 'direct',
        team_id_snapshot: null,
      }),
    ]);

    insertBatch('batch-post', '2026-01-01T00:00:18.000Z', '2026-01-01T00:00:19.000Z');
    insertTeamSegment({
      id: 'segment-post',
      batchId: 'batch-post',
      agentId: AGENT_ID,
      agentName: 'Coder',
      startedAt: '2026-01-01T00:00:18.000Z',
      lastActivityAt: '2026-01-01T00:00:19.000Z',
      durationMs: 1_000,
      closed: true,
    });
    insertDelivery('event-post-seal', 'running', '2026-01-01T00:00:20.000Z');
    await expect(
      store.recordTaskTouch({
        committedEventId: 'event-post-seal',
        eventName: 'epic.updated',
        projectId: PROJECT_ID,
        actorAgentId: AGENT_ID,
        targetEpicId: 'target-post-seal',
        targetEpicTitle: 'After seal',
        publishedAt: '2026-01-01T00:00:20.000Z',
      }),
    ).resolves.toEqual({ receiptCreated: true, claimedSegments: 0, discardedSegments: 0 });
    expect(segments()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'segment-post', epic_id: null, team_batch_id: 'batch-post' }),
      ]),
    );
  });

  it('waits for every barrier delivery, then transfers only the deterministic longest lane', async () => {
    insertAgent(LEAD_ID, 'Team Lead');
    insertAgent('agent-a', 'Agent A');
    insertAgent('agent-b', 'Agent B');
    insertTeam(TEAM_ID, LEAD_ID, [AGENT_ID, 'agent-a', 'agent-b']);
    sqlite
      .prepare(
        `INSERT INTO epics
           (id, project_id, title, status_id, agent_id, version, created_at, updated_at)
         VALUES ('lead-target', ?, 'Lead target', 'status-time', ?, 1,
                 '2026-01-01T00:00:09.000Z', '2026-01-01T00:00:09.000Z')`,
      )
      .run(PROJECT_ID, LEAD_ID);
    insertBatch('batch-longest', '2026-01-01T00:00:10.000Z', '2026-01-01T00:20:00.000Z');
    insertTeamSegment({
      id: 'lane-coder',
      batchId: 'batch-longest',
      agentId: AGENT_ID,
      agentName: 'Coder',
      startedAt: '2026-01-01T00:00:10.000Z',
      lastActivityAt: '2026-01-01T00:10:10.000Z',
      durationMs: 600_000,
      closed: true,
    });
    insertTeamSegment({
      id: 'lane-a-1',
      batchId: 'batch-longest',
      agentId: 'agent-a',
      agentName: 'Agent A',
      startedAt: '2026-01-01T00:00:20.000Z',
      lastActivityAt: '2026-01-01T00:08:20.000Z',
      durationMs: 500_000,
      closed: true,
    });
    insertTeamSegment({
      id: 'lane-a-2',
      batchId: 'batch-longest',
      agentId: 'agent-a',
      agentName: 'Agent A',
      startedAt: '2026-01-01T00:08:20.000Z',
      lastActivityAt: '2026-01-01T00:15:00.000Z',
      durationMs: 400_000,
      closed: true,
    });
    insertTeamSegment({
      id: 'lane-b',
      batchId: 'batch-longest',
      agentId: 'agent-b',
      agentName: 'Agent B',
      startedAt: '2026-01-01T00:00:05.000Z',
      lastActivityAt: '2026-01-01T00:08:05.000Z',
      durationMs: 480_000,
      closed: true,
    });
    insertDelivery('event-wait', 'retry', '2026-01-01T00:19:00.000Z');
    sqlite
      .prepare(
        `INSERT INTO epic_time_team_batch_event_barriers
           (team_batch_id, committed_event_id, created_at)
         VALUES ('batch-longest', 'event-wait', '2026-01-01T00:20:00.000Z')`,
      )
      .run();

    await expect(
      store.processTeamBatches(DELIVERY_KEY, 30_000, new Date('2026-01-01T00:21:00.000Z')),
    ).resolves.toEqual({ sealedBatches: 0, finalizedBatches: 0, cancelledBatches: 0 });
    sqlite
      .prepare(`UPDATE event_handlers SET status = 'delivered' WHERE event_id = 'event-wait'`)
      .run();
    await expect(
      store.processTeamBatches(DELIVERY_KEY, 30_000, new Date('2026-01-01T00:22:00.000Z')),
    ).resolves.toEqual({ sealedBatches: 0, finalizedBatches: 1, cancelledBatches: 0 });

    expect(batches()).toEqual([]);
    expect(segments()).toEqual([
      expect.objectContaining({
        id: 'lane-a-1',
        epic_id: 'lead-target',
        team_batch_id: null,
        attribution_source: 'team',
        team_id_snapshot: TEAM_ID,
        team_name_snapshot: 'Builders',
        session_id_snapshot: 'lane-a-1-session',
        agent_id_snapshot: LEAD_ID,
        agent_name_snapshot: 'Team Lead',
      }),
      expect.objectContaining({
        id: 'lane-a-2',
        epic_id: 'lead-target',
        attribution_source: 'team',
        agent_id_snapshot: LEAD_ID,
      }),
    ]);
  });

  it('breaks equal-duration ties by earliest start and then lexical agent ID', async () => {
    insertAgent(LEAD_ID, 'Team Lead');
    insertAgent('agent-a', 'Agent A');
    insertAgent('agent-b', 'Agent B');
    insertTeam(TEAM_ID, LEAD_ID, ['agent-a', 'agent-b']);
    insertBatch('batch-earliest', '2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z');
    for (const input of [
      {
        id: 'earliest-a',
        agentId: 'agent-a',
        agentName: 'Agent A',
        startedAt: '2026-01-01T00:00:02.000Z',
      },
      {
        id: 'earliest-b',
        agentId: 'agent-b',
        agentName: 'Agent B',
        startedAt: '2026-01-01T00:00:01.000Z',
      },
    ]) {
      insertTeamSegment({
        ...input,
        batchId: 'batch-earliest',
        lastActivityAt: '2026-01-01T00:01:00.000Z',
        durationMs: 60_000,
        closed: true,
      });
    }
    await store.processTeamBatches(DELIVERY_KEY, 30_000, new Date('2026-01-01T00:11:00.000Z'));
    expect(segments()).toEqual([
      expect.objectContaining({
        id: 'earliest-b',
        epic_id: null,
        attribution_source: 'team',
        team_id_snapshot: TEAM_ID,
        agent_id_snapshot: LEAD_ID,
      }),
    ]);
    insertEpic('lead-later-target', '2026-01-01T00:11:30.000Z', false);
    await store.recordTaskTouch({
      committedEventId: 'lead-later-touch',
      eventName: 'epic.updated',
      projectId: PROJECT_ID,
      actorAgentId: LEAD_ID,
      targetEpicId: 'lead-later-target',
      targetEpicTitle: 'Lead later target',
      publishedAt: '2026-01-01T00:11:30.000Z',
    });
    expect(segments()).toEqual([
      expect.objectContaining({
        id: 'earliest-b',
        epic_id: 'lead-later-target',
        attribution_source: 'team',
        team_id_snapshot: TEAM_ID,
        agent_id_snapshot: LEAD_ID,
      }),
    ]);

    insertBatch('batch-lexical', '2026-01-01T00:12:00.000Z', '2026-01-01T00:20:00.000Z');
    for (const input of [
      { id: 'lexical-a', agentId: 'agent-a', agentName: 'Agent A' },
      { id: 'lexical-b', agentId: 'agent-b', agentName: 'Agent B' },
    ]) {
      insertTeamSegment({
        ...input,
        batchId: 'batch-lexical',
        startedAt: '2026-01-01T00:12:01.000Z',
        lastActivityAt: '2026-01-01T00:13:01.000Z',
        durationMs: 60_000,
        closed: true,
      });
    }
    await store.processTeamBatches(DELIVERY_KEY, 30_000, new Date('2026-01-01T00:21:00.000Z'));
    expect(segments()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'lexical-a', agent_id_snapshot: LEAD_ID }),
      ]),
    );
    expect(segments().map((row) => row.id)).not.toContain('lexical-b');
  });

  it('cancels a churned batch back to personal buffers', async () => {
    seedValidTeam();
    insertBatch('batch-churn', '2026-01-01T00:00:10.000Z', '2026-01-01T00:10:00.000Z');
    insertTeamSegment({
      id: 'segment-churn',
      batchId: 'batch-churn',
      agentId: AGENT_ID,
      agentName: 'Coder',
      startedAt: '2026-01-01T00:00:10.000Z',
      lastActivityAt: '2026-01-01T00:05:00.000Z',
      durationMs: 290_000,
      closed: true,
    });
    sqlite
      .prepare(`DELETE FROM team_members WHERE team_id = ? AND agent_id = ?`)
      .run(TEAM_ID, AGENT_ID);

    await expect(
      store.processTeamBatches(DELIVERY_KEY, 30_000, new Date('2026-01-01T00:11:00.000Z')),
    ).resolves.toEqual({ sealedBatches: 0, finalizedBatches: 0, cancelledBatches: 1 });
    expect(batches()).toEqual([]);
    expect(segments()).toEqual([
      expect.objectContaining({
        id: 'segment-churn',
        epic_id: null,
        team_batch_id: null,
        attribution_source: 'direct',
        team_id_snapshot: null,
        team_name_snapshot: null,
        agent_id_snapshot: AGENT_ID,
      }),
    ]);
  });

  it('rolls back lane transfer, loser deletion, and coordinator deletion together', async () => {
    insertAgent(LEAD_ID, 'Team Lead');
    insertAgent('agent-other', 'Other');
    insertTeam(TEAM_ID, LEAD_ID, [AGENT_ID, 'agent-other']);
    insertBatch('batch-rollback', '2026-01-01T00:00:10.000Z', '2026-01-01T00:10:00.000Z');
    insertTeamSegment({
      id: 'winner-before-rollback',
      batchId: 'batch-rollback',
      agentId: AGENT_ID,
      agentName: 'Coder',
      startedAt: '2026-01-01T00:00:10.000Z',
      lastActivityAt: '2026-01-01T00:05:10.000Z',
      durationMs: 300_000,
      closed: true,
    });
    insertTeamSegment({
      id: 'loser-before-rollback',
      batchId: 'batch-rollback',
      agentId: 'agent-other',
      agentName: 'Other',
      startedAt: '2026-01-01T00:00:10.000Z',
      lastActivityAt: '2026-01-01T00:04:10.000Z',
      durationMs: 240_000,
      closed: true,
    });
    sqlite.exec(`
      CREATE TRIGGER fail_batch_finalize
      BEFORE DELETE ON epic_time_team_batches
      BEGIN
        SELECT RAISE(ABORT, 'coordinator deletion failed');
      END;
    `);

    await expect(
      store.processTeamBatches(DELIVERY_KEY, 30_000, new Date('2026-01-01T00:11:00.000Z')),
    ).rejects.toThrow('coordinator deletion failed');
    expect(batches()).toEqual([expect.objectContaining({ id: 'batch-rollback' })]);
    expect(segments()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'winner-before-rollback',
          team_batch_id: 'batch-rollback',
          agent_id_snapshot: AGENT_ID,
          attribution_source: 'direct',
        }),
        expect.objectContaining({
          id: 'loser-before-rollback',
          team_batch_id: 'batch-rollback',
          agent_id_snapshot: 'agent-other',
        }),
      ]),
    );
  });

  it('reads only closed direct and child segments for detail and roots in one batch projection', () => {
    insertEpic('root-summary', '2026-01-01T00:00:09.000Z', false);
    sqlite
      .prepare(
        `INSERT INTO epics
           (id, project_id, title, status_id, parent_id, version, created_at, updated_at)
          VALUES ('child-summary', ?, 'Child', 'status-time', 'root-summary', 1,
                  '2026-01-01T00:00:09.000Z', '2026-01-01T00:00:09.000Z')`,
      )
      .run(PROJECT_ID);
    insertBufferedSegment(
      'root-closed',
      '2026-01-01T00:00:10.000Z',
      '2026-01-01T00:01:10.000Z',
      'root-summary',
    );
    insertBufferedSegment(
      'child-closed',
      '2026-01-01T00:01:10.000Z',
      '2026-01-01T00:02:10.000Z',
      'child-summary',
    );
    sqlite
      .prepare(
        `UPDATE epic_time_segments
         SET attribution_source = 'team', team_id_snapshot = ?, team_name_snapshot = 'Builders'
         WHERE id = 'root-closed'`,
      )
      .run(TEAM_ID);
    sqlite
      .prepare(
        `INSERT INTO epic_time_segments
           (id, project_id, epic_id, session_id_snapshot, agent_id_snapshot,
            agent_name_snapshot, started_at, last_activity_at, closed_at,
            duration_ms, created_at, updated_at)
         VALUES ('root-open', ?, 'root-summary', 'open-session', ?, 'Coder',
                 '2026-01-01T00:02:10.000Z', '2026-01-01T00:03:10.000Z', NULL,
                 60000, '2026-01-01T00:03:10.000Z', '2026-01-01T00:03:10.000Z')`,
      )
      .run(PROJECT_ID, AGENT_ID);

    expect(store.getEpicTimeScope('root-summary')).toEqual({
      id: 'root-summary',
      parentId: null,
    });
    expect(store.getEpicTimeScope('child-summary')).toEqual({
      id: 'child-summary',
      parentId: 'root-summary',
    });
    expect(store.listResolvedScope(['root-summary']).segments).toEqual([
      expect.objectContaining({
        id: 'root-closed',
        epicId: 'root-summary',
        epicTitle: 'root-summary',
        rootEpicId: 'root-summary',
        isDirect: true,
        attributionSource: 'team',
        teamId: TEAM_ID,
        teamName: 'Builders',
      }),
      expect.objectContaining({
        id: 'child-closed',
        epicId: 'child-summary',
        epicTitle: 'Child',
        rootEpicId: 'root-summary',
        isDirect: false,
        attributionSource: 'direct',
        teamId: null,
        teamName: null,
      }),
    ]);
    // A child focal stays self-only and never traverses routes.
    expect(store.listResolvedScope(['child-summary']).segments).toEqual([
      expect.objectContaining({ id: 'child-closed', rootEpicId: 'child-summary', isDirect: true }),
    ]);
    expect(store.getEpicTimeScopes(['root-summary', 'child-summary'])).toHaveLength(2);
    // One statement resolves multiple batch focals at once; groups order by
    // focal id, so the child-summary group sorts before root-summary.
    expect(store.listResolvedScope(['root-summary', 'child-summary']).segments).toEqual([
      expect.objectContaining({
        id: 'child-closed',
        rootEpicId: 'child-summary',
        isDirect: true,
      }),
      expect.objectContaining({ id: 'root-closed', rootEpicId: 'root-summary', isDirect: true }),
      expect.objectContaining({
        id: 'child-closed',
        rootEpicId: 'root-summary',
        isDirect: false,
      }),
    ]);
  });

  describe('agent time buffer assignment', () => {
    function seedEligibleMatrix(): void {
      insertAgent('agent-two', 'Second Coder');
      insertEpic('bound-epic', '2026-01-01T00:00:08.000Z', false);
      insertBatch('batch-open', '2026-01-01T00:00:10.000Z', null);
      insertBatch('batch-sealed', '2026-01-01T00:00:10.000Z', '2026-01-01T00:25:00.000Z');
      insertSegmentRow({
        id: 'buf-a',
        startedAt: '2026-01-01T00:10:00.000Z',
        lastActivityAt: '2026-01-01T00:11:30.000Z',
        durationMs: 90_000,
      });
      insertSegmentRow({
        id: 'buf-b',
        startedAt: '2026-01-01T00:20:00.000Z',
        lastActivityAt: '2026-01-01T00:20:30.000Z',
        durationMs: 30_000,
      });
      insertSegmentRow({
        id: 'buf-other-agent',
        agentId: 'agent-two',
        startedAt: '2026-01-01T00:15:00.000Z',
        lastActivityAt: '2026-01-01T00:15:00.000Z',
        durationMs: 60_000,
      });
      // Every row below is ineligible and must stay absent from the read.
      insertSegmentRow({
        id: 'open-row',
        startedAt: '2026-01-01T00:21:00.000Z',
        lastActivityAt: '2026-01-01T00:21:30.000Z',
        closedAt: null,
        updatedAt: '2026-01-01T00:30:00.000Z',
      });
      insertSegmentRow({
        id: 'zero-row',
        startedAt: '2026-01-01T00:22:00.000Z',
        lastActivityAt: '2026-01-01T00:22:00.000Z',
        durationMs: 0,
        updatedAt: '2026-01-01T00:30:00.000Z',
      });
      insertSegmentRow({
        id: 'bound-row',
        startedAt: '2026-01-01T00:23:00.000Z',
        lastActivityAt: '2026-01-01T00:23:00.000Z',
        epicId: 'bound-epic',
        updatedAt: '2026-01-01T00:30:00.000Z',
      });
      insertSegmentRow({
        id: 'deleted-agent-row',
        agentId: 'deleted-agent',
        startedAt: '2026-01-01T00:24:00.000Z',
        lastActivityAt: '2026-01-01T00:24:00.000Z',
        updatedAt: '2026-01-01T00:30:00.000Z',
      });
      insertSegmentRow({
        id: 'open-batch-row',
        teamBatchId: 'batch-open',
        startedAt: '2026-01-01T00:25:00.000Z',
        lastActivityAt: '2026-01-01T00:25:00.000Z',
        updatedAt: '2026-01-01T00:30:00.000Z',
      });
      insertSegmentRow({
        id: 'sealed-batch-row',
        teamBatchId: 'batch-sealed',
        startedAt: '2026-01-01T00:26:00.000Z',
        lastActivityAt: '2026-01-01T00:26:00.000Z',
        updatedAt: '2026-01-01T00:30:00.000Z',
      });
      sqlite
        .prepare(
          `INSERT INTO projects
             (id, name, root_path, is_template, is_private, created_at, updated_at)
           VALUES ('project-other', 'Other', '/tmp/other', 0, 0,
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      insertSegmentRow({
        id: 'other-project-row',
        projectId: 'project-other',
        startedAt: '2026-01-01T00:27:00.000Z',
        lastActivityAt: '2026-01-01T00:27:00.000Z',
        updatedAt: '2026-01-01T00:30:00.000Z',
      });
    }

    it('aggregates only positive settled unlogged rows of current same-project agents', () => {
      seedEligibleMatrix();

      const snapshot = store.listAgentTimeBuffers(PROJECT_ID);
      expect(snapshot).toEqual({
        capturedAt: '2026-01-01T00:20:30.000Z',
        items: [
          {
            agentId: AGENT_ID,
            snapshotToken: expect.any(String),
            minutes: 2,
            durationMs: 120_000,
            segmentCount: 2,
            oldestActivityAt: '2026-01-01T00:11:30.000Z',
            newestActivityAt: '2026-01-01T00:20:30.000Z',
          },
          {
            agentId: 'agent-two',
            snapshotToken: expect.any(String),
            minutes: 1,
            durationMs: 60_000,
            segmentCount: 1,
            oldestActivityAt: '2026-01-01T00:15:00.000Z',
            newestActivityAt: '2026-01-01T00:15:00.000Z',
          },
        ],
      });
      // Byte-stable while the accounting rows stand still, and the projection
      // carries no segment, session, or team-membership detail.
      expect(JSON.stringify(store.listAgentTimeBuffers(PROJECT_ID))).toBe(JSON.stringify(snapshot));
      expect(Object.keys(snapshot.items[0]).sort()).toEqual([
        'agentId',
        'durationMs',
        'minutes',
        'newestActivityAt',
        'oldestActivityAt',
        'segmentCount',
        'snapshotToken',
      ]);
      expect(store.listAgentTimeBuffers('project-other')).toEqual({
        capturedAt: null,
        items: [],
      });
    });

    it('assigns the exact captured row set once and leaves every ineligible row alone', async () => {
      seedEligibleMatrix();
      const snapshot = store.listAgentTimeBuffers(PROJECT_ID);
      const item = snapshot.items.find((entry) => entry.agentId === AGENT_ID)!;
      const workspace = (
        sqlite.prepare(`SELECT workspace_id FROM projects WHERE id = ?`).get(PROJECT_ID) as {
          workspace_id: string;
        }
      ).workspace_id;

      const result = await store.assignAgentTimeBuffer(
        {
          projectId: PROJECT_ID,
          agentId: AGENT_ID,
          targetEpicId: 'bound-epic',
          capturedAt: snapshot.capturedAt!,
          snapshotToken: item.snapshotToken,
        },
        new Date('2026-01-01T01:00:00.000Z'),
      );

      expect(result).toEqual({ workspaceId: workspace });
      expect(epicIds(['buf-a', 'buf-b'])).toEqual([
        expect.objectContaining({
          id: 'buf-a',
          epic_id: 'bound-epic',
          updated_at: '2026-01-01T01:00:00.000Z',
        }),
        expect.objectContaining({
          id: 'buf-b',
          epic_id: 'bound-epic',
          updated_at: '2026-01-01T01:00:00.000Z',
        }),
      ]);
      expect(epicIds(['deleted-agent-row', 'buf-other-agent', 'open-row', 'zero-row'])).toEqual([
        expect.objectContaining({ id: 'buf-other-agent', epic_id: null }),
        expect.objectContaining({ id: 'deleted-agent-row', epic_id: null }),
        expect.objectContaining({ id: 'open-row', epic_id: null }),
        expect.objectContaining({ id: 'zero-row', epic_id: null }),
      ]);
      expect(
        sqlite
          .prepare(
            `SELECT epic_id, team_batch_id FROM epic_time_segments WHERE id = 'open-batch-row'`,
          )
          .get(),
      ).toEqual({ epic_id: null, team_batch_id: 'batch-open' });
      expect(receipts()).toEqual([]);
      // The moved rows leave the eligible read; the other agent keeps theirs.
      expect(store.listAgentTimeBuffers(PROJECT_ID).items.map((entry) => entry.agentId)).toEqual([
        'agent-two',
      ]);
    });

    it.each([
      [
        'an automatic attribution claim race',
        () =>
          sqlite
            .prepare(
              `UPDATE epic_time_segments SET epic_id = 'bound-epic',
                       updated_at = '2026-01-01T00:35:00.000Z' WHERE id = 'buf-a'`,
            )
            .run(),
      ],
      [
        'a same-total different-row-set race',
        () => {
          sqlite.prepare(`DELETE FROM epic_time_segments WHERE id = 'buf-a'`).run();
          insertSegmentRow({
            id: 'buf-a-replacement',
            startedAt: '2026-01-01T00:12:00.000Z',
            lastActivityAt: '2026-01-01T00:13:30.000Z',
            durationMs: 90_000,
          });
        },
      ],
      [
        'a changed-row-field race',
        () =>
          sqlite
            .prepare(
              `UPDATE epic_time_segments SET duration_ms = duration_ms + 1000
                       WHERE id = 'buf-a'`,
            )
            .run(),
      ],
      [
        'activity settled after the capture watermark',
        () =>
          sqlite
            .prepare(
              `UPDATE epic_time_segments SET duration_ms = duration_ms + 5000,
                       updated_at = '2026-01-01T00:40:00.000Z' WHERE id = 'buf-a'`,
            )
            .run(),
      ],
    ])('fails closed on %s without a partial update', async (_label, race) => {
      seedEligibleMatrix();
      const snapshot = store.listAgentTimeBuffers(PROJECT_ID);
      const item = snapshot.items.find((entry) => entry.agentId === AGENT_ID)!;
      race();

      await expect(
        store.assignAgentTimeBuffer({
          projectId: PROJECT_ID,
          agentId: AGENT_ID,
          targetEpicId: 'bound-epic',
          capturedAt: snapshot.capturedAt!,
          snapshotToken: item.snapshotToken,
        }),
      ).rejects.toMatchObject({ code: 'conflict', statusCode: 409 });
      // buf-b is still eligible in every scenario; it must not move alone.
      expect(epicIds(['buf-b'])).toEqual([expect.objectContaining({ id: 'buf-b', epic_id: null })]);
    });

    it('rejects a replay of an already applied assignment', async () => {
      insertSegmentRow({
        id: 'buf-a',
        startedAt: '2026-01-01T00:10:00.000Z',
        lastActivityAt: '2026-01-01T00:11:30.000Z',
        durationMs: 90_000,
      });
      insertEpic('bound-epic', '2026-01-01T00:00:08.000Z', false);
      const snapshot = store.listAgentTimeBuffers(PROJECT_ID);
      const input = {
        projectId: PROJECT_ID,
        agentId: AGENT_ID,
        targetEpicId: 'bound-epic',
        capturedAt: snapshot.capturedAt!,
        snapshotToken: snapshot.items[0].snapshotToken,
      };
      await store.assignAgentTimeBuffer(input);

      await expect(store.assignAgentTimeBuffer(input)).rejects.toMatchObject({
        code: 'conflict',
        statusCode: 409,
      });
    });

    it('makes a finalized lead-held team winner claimable and preserves its provenance', async () => {
      insertAgent('member-b', 'Member B');
      seedValidTeam([AGENT_ID, 'member-b']);
      insertBatch('batch-finalize', '2026-01-01T00:05:00.000Z', null);
      insertTeamSegment({
        id: 'team-winner-lane',
        batchId: 'batch-finalize',
        agentId: AGENT_ID,
        agentName: 'Coder',
        startedAt: '2026-01-01T00:05:00.000Z',
        lastActivityAt: '2026-01-01T00:20:00.000Z',
        durationMs: 900_000,
        closed: false,
      });
      insertTeamSegment({
        id: 'team-loser-lane',
        batchId: 'batch-finalize',
        agentId: 'member-b',
        agentName: 'Member B',
        startedAt: '2026-01-01T00:05:30.000Z',
        lastActivityAt: '2026-01-01T00:13:00.000Z',
        durationMs: 480_000,
        closed: false,
      });
      // The lead holds a settled personal buffer next to the team winner.
      insertSegmentRow({
        id: 'lead-personal',
        agentId: LEAD_ID,
        startedAt: '2026-01-01T00:30:00.000Z',
        lastActivityAt: '2026-01-01T00:31:00.000Z',
        durationMs: 60_000,
      });
      insertEpic('team-target', '2026-01-01T00:00:08.000Z', false);

      const processed = await store.processTeamBatches(
        DELIVERY_KEY,
        30_000,
        new Date('2026-01-01T00:40:00.000Z'),
      );
      expect(processed).toMatchObject({ sealedBatches: 1, finalizedBatches: 1 });
      // Batch deletion plus foreign_keys=ON is what re-admits the closed
      // winner: team_batch_id must be SET NULL while the team snapshots stay.
      expect(
        sqlite
          .prepare(
            `SELECT epic_id, team_batch_id, attribution_source, team_id_snapshot,
                    team_name_snapshot, agent_id_snapshot, closed_at
             FROM epic_time_segments WHERE id = 'team-winner-lane'`,
          )
          .get(),
      ).toEqual({
        epic_id: null,
        team_batch_id: null,
        attribution_source: 'team',
        team_id_snapshot: TEAM_ID,
        team_name_snapshot: 'Builders',
        agent_id_snapshot: LEAD_ID,
        closed_at: '2026-01-01T00:20:00.000Z',
      });

      const snapshot = store.listAgentTimeBuffers(PROJECT_ID);
      const leadItem = snapshot.items.find((entry) => entry.agentId === LEAD_ID)!;
      expect(leadItem).toMatchObject({
        minutes: 16,
        durationMs: 960_000,
        segmentCount: 2,
      });

      await store.assignAgentTimeBuffer(
        {
          projectId: PROJECT_ID,
          agentId: LEAD_ID,
          targetEpicId: 'team-target',
          capturedAt: snapshot.capturedAt!,
          snapshotToken: leadItem.snapshotToken,
        },
        new Date('2026-01-01T01:00:00.000Z'),
      );
      expect(
        sqlite
          .prepare(
            `SELECT epic_id, attribution_source, team_id_snapshot, team_name_snapshot,
                    updated_at FROM epic_time_segments
             WHERE id IN ('team-winner-lane', 'lead-personal') ORDER BY id`,
          )
          .all(),
      ).toEqual([
        expect.objectContaining({
          epic_id: 'team-target',
          attribution_source: 'direct',
          updated_at: '2026-01-01T01:00:00.000Z',
        }),
        expect.objectContaining({
          epic_id: 'team-target',
          attribution_source: 'team',
          team_id_snapshot: TEAM_ID,
          team_name_snapshot: 'Builders',
          updated_at: '2026-01-01T01:00:00.000Z',
        }),
      ]);
      expect(receipts()).toEqual([]);
    });

    it('rejects missing agent, missing project, and missing or cross-project targets', async () => {
      insertSegmentRow({
        id: 'buf-a',
        startedAt: '2026-01-01T00:10:00.000Z',
        lastActivityAt: '2026-01-01T00:11:30.000Z',
        durationMs: 90_000,
      });
      insertEpic('bound-epic', '2026-01-01T00:00:08.000Z', false);
      sqlite
        .prepare(
          `INSERT INTO projects
             (id, name, root_path, is_template, is_private, created_at, updated_at)
           VALUES ('project-other', 'Other', '/tmp/other', 0, 0,
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO epics (id, project_id, title, status_id, agent_id, version, created_at, updated_at)
           VALUES ('foreign-epic', 'project-other', 'Foreign', 'status-time', NULL, 1,
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      const snapshot = store.listAgentTimeBuffers(PROJECT_ID);
      const token = snapshot.items[0].snapshotToken;
      const base = {
        agentId: AGENT_ID,
        capturedAt: snapshot.capturedAt!,
        snapshotToken: token,
      };

      await expect(
        store.assignAgentTimeBuffer({
          ...base,
          projectId: PROJECT_ID,
          targetEpicId: 'bound-epic',
          agentId: 'ghost-agent',
        }),
      ).rejects.toMatchObject({ code: 'not_found', statusCode: 404 });
      await expect(
        store.assignAgentTimeBuffer({
          ...base,
          projectId: 'project-missing',
          targetEpicId: 'bound-epic',
        }),
      ).rejects.toMatchObject({ code: 'not_found', statusCode: 404 });
      await expect(
        store.assignAgentTimeBuffer({
          ...base,
          projectId: PROJECT_ID,
          targetEpicId: 'epic-missing',
        }),
      ).rejects.toMatchObject({ code: 'not_found', statusCode: 404 });
      await expect(
        store.assignAgentTimeBuffer({
          ...base,
          projectId: PROJECT_ID,
          targetEpicId: 'foreign-epic',
        }),
      ).rejects.toMatchObject({ code: 'not_found', statusCode: 404 });
      expect(epicIds(['buf-a'])).toEqual([expect.objectContaining({ id: 'buf-a', epic_id: null })]);
    });
  });

  describe('agent time buffer reset', () => {
    function seedResetMatrix(): void {
      insertAgent('agent-two', 'Second Coder');
      insertEpic('bound-epic', '2026-01-01T00:00:08.000Z', false);
      insertBatch('batch-open', '2026-01-01T00:00:10.000Z', null);
      insertSegmentRow({
        id: 'buf-sub',
        startedAt: '2026-01-01T00:20:00.000Z',
        lastActivityAt: '2026-01-01T00:20:30.000Z',
        durationMs: 30_000,
      });
      insertSegmentRow({
        id: 'buf-whole',
        startedAt: '2026-01-01T00:10:00.000Z',
        lastActivityAt: '2026-01-01T00:11:30.000Z',
        durationMs: 90_000,
      });
      insertSegmentRow({
        id: 'buf-other-agent',
        agentId: 'agent-two',
        startedAt: '2026-01-01T00:15:00.000Z',
        lastActivityAt: '2026-01-01T00:15:00.000Z',
        durationMs: 60_000,
      });
      // Every row below is ineligible and must survive the reset.
      insertSegmentRow({
        id: 'open-row',
        startedAt: '2026-01-01T00:21:00.000Z',
        lastActivityAt: '2026-01-01T00:21:30.000Z',
        closedAt: null,
        updatedAt: '2026-01-01T00:30:00.000Z',
      });
      insertSegmentRow({
        id: 'bound-row',
        startedAt: '2026-01-01T00:23:00.000Z',
        lastActivityAt: '2026-01-01T00:23:00.000Z',
        epicId: 'bound-epic',
        updatedAt: '2026-01-01T00:30:00.000Z',
      });
      insertSegmentRow({
        id: 'pending-lane-row',
        teamBatchId: 'batch-open',
        startedAt: '2026-01-01T00:25:00.000Z',
        lastActivityAt: '2026-01-01T00:25:00.000Z',
        updatedAt: '2026-01-01T00:30:00.000Z',
      });
      sqlite
        .prepare(
          `INSERT INTO projects
             (id, name, root_path, is_template, is_private, created_at, updated_at)
           VALUES ('project-other', 'Other', '/tmp/other', 0, 0,
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      insertSegmentRow({
        id: 'other-project-row',
        projectId: 'project-other',
        startedAt: '2026-01-01T00:27:00.000Z',
        lastActivityAt: '2026-01-01T00:27:00.000Z',
        updatedAt: '2026-01-01T00:30:00.000Z',
      });
      sqlite
        .prepare(
          `INSERT INTO epic_time_session_watermarks
             (session_id, project_id, last_activity_at, created_at, updated_at)
           VALUES (?, ?, '2026-01-01T00:12:00.000Z',
                   '2026-01-01T00:12:00.000Z', '2026-01-01T00:12:00.000Z')`,
        )
        .run(SESSION_ID, PROJECT_ID);
      sqlite
        .prepare(
          `INSERT INTO events (id, name, payload_json, request_id, published_at)
           VALUES ('event-receipt', 'epic.updated', '{}', NULL, '2026-01-01T00:28:00.000Z')`,
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO epic_time_buffer_claims
             (committed_event_id, event_name, project_id, agent_id_snapshot,
              agent_name_snapshot, target_epic_id_snapshot, target_epic_title_snapshot,
              published_at, source_event_row_id, created_at)
           VALUES ('event-receipt', 'epic.updated', ?, ?, 'Coder', 'bound-epic',
                   'Bound', '2026-01-01T00:28:00.000Z', NULL, '2026-01-01T00:28:00.000Z')`,
        )
        .run(PROJECT_ID, AGENT_ID);
    }

    it('deletes the exact captured row set and preserves every replay guard and ineligible row', async () => {
      seedResetMatrix();
      const snapshot = store.listAgentTimeBuffers(PROJECT_ID);
      const item = snapshot.items.find((entry) => entry.agentId === AGENT_ID)!;
      const workspace = (
        sqlite.prepare(`SELECT workspace_id FROM projects WHERE id = ?`).get(PROJECT_ID) as {
          workspace_id: string;
        }
      ).workspace_id;

      const result = await store.resetAgentTimeBuffer({
        projectId: PROJECT_ID,
        agentId: AGENT_ID,
        capturedAt: snapshot.capturedAt!,
        snapshotToken: item.snapshotToken,
      });

      expect(result).toEqual({ workspaceId: workspace });
      expect(epicIds(['buf-sub', 'buf-whole', 'buf-other-agent', 'open-row', 'bound-row'])).toEqual(
        [
          expect.objectContaining({ id: 'bound-row', epic_id: 'bound-epic' }),
          expect.objectContaining({ id: 'buf-other-agent', epic_id: null }),
          expect.objectContaining({ id: 'open-row', epic_id: null }),
        ],
      );
      expect(
        sqlite
          .prepare(
            `SELECT epic_id, team_batch_id FROM epic_time_segments WHERE id = 'pending-lane-row'`,
          )
          .get(),
      ).toEqual({ epic_id: null, team_batch_id: 'batch-open' });
      expect(epicIds(['other-project-row'])).toEqual([
        expect.objectContaining({ id: 'other-project-row', epic_id: null }),
      ]);
      // Deletion-proof replay guards: the watermark and the durable task-touch
      // receipt both survive so deleted time can never be reconciled back.
      expect(
        sqlite
          .prepare(
            `SELECT last_activity_at FROM epic_time_session_watermarks
             WHERE session_id = ?`,
          )
          .get(SESSION_ID),
      ).toEqual({ last_activity_at: '2026-01-01T00:12:00.000Z' });
      expect(receipts()).toHaveLength(1);
      expect(store.listAgentTimeBuffers(PROJECT_ID).items.map((entry) => entry.agentId)).toEqual([
        'agent-two',
      ]);
    });

    it.each([
      [
        'an automatic attribution claim race',
        () =>
          sqlite
            .prepare(
              `UPDATE epic_time_segments SET epic_id = 'bound-epic',
                       updated_at = '2026-01-01T00:35:00.000Z' WHERE id = 'buf-sub'`,
            )
            .run(),
      ],
      [
        'a changed-row-field race',
        () =>
          sqlite
            .prepare(
              `UPDATE epic_time_segments SET duration_ms = duration_ms + 1000
                       WHERE id = 'buf-whole'`,
            )
            .run(),
      ],
      [
        'activity settled after the capture watermark',
        () =>
          sqlite
            .prepare(
              `UPDATE epic_time_segments SET duration_ms = duration_ms + 5000,
                       updated_at = '2026-01-01T00:40:00.000Z' WHERE id = 'buf-sub'`,
            )
            .run(),
      ],
    ])('fails closed on %s without a partial delete', async (_label, race) => {
      seedResetMatrix();
      const snapshot = store.listAgentTimeBuffers(PROJECT_ID);
      const item = snapshot.items.find((entry) => entry.agentId === AGENT_ID)!;
      race();

      await expect(
        store.resetAgentTimeBuffer({
          projectId: PROJECT_ID,
          agentId: AGENT_ID,
          capturedAt: snapshot.capturedAt!,
          snapshotToken: item.snapshotToken,
        }),
      ).rejects.toMatchObject({ code: 'conflict', statusCode: 409 });
      expect(epicIds(['buf-whole'])).toEqual([
        expect.objectContaining({ id: 'buf-whole', epic_id: null }),
      ]);
    });

    it('rejects a replay of an already applied reset with the stale snapshot conflict', async () => {
      insertSegmentRow({
        id: 'buf-a',
        startedAt: '2026-01-01T00:10:00.000Z',
        lastActivityAt: '2026-01-01T00:11:30.000Z',
        durationMs: 90_000,
      });
      const snapshot = store.listAgentTimeBuffers(PROJECT_ID);
      const input = {
        projectId: PROJECT_ID,
        agentId: AGENT_ID,
        capturedAt: snapshot.capturedAt!,
        snapshotToken: snapshot.items[0].snapshotToken,
      };
      await store.resetAgentTimeBuffer(input);
      expect(epicIds(['buf-a'])).toEqual([]);

      await expect(store.resetAgentTimeBuffer(input)).rejects.toMatchObject({
        code: 'conflict',
        statusCode: 409,
      });
    });

    it('rejects missing agent and missing project without deleting anything', async () => {
      insertSegmentRow({
        id: 'buf-a',
        startedAt: '2026-01-01T00:10:00.000Z',
        lastActivityAt: '2026-01-01T00:11:30.000Z',
        durationMs: 90_000,
      });
      const snapshot = store.listAgentTimeBuffers(PROJECT_ID);
      const base = {
        agentId: AGENT_ID,
        capturedAt: snapshot.capturedAt!,
        snapshotToken: snapshot.items[0].snapshotToken,
      };

      await expect(
        store.resetAgentTimeBuffer({ ...base, projectId: PROJECT_ID, agentId: 'ghost-agent' }),
      ).rejects.toMatchObject({ code: 'not_found', statusCode: 404 });
      await expect(
        store.resetAgentTimeBuffer({ ...base, projectId: 'project-missing' }),
      ).rejects.toMatchObject({ code: 'not_found', statusCode: 404 });
      expect(epicIds(['buf-a'])).toEqual([expect.objectContaining({ id: 'buf-a', epic_id: null })]);
    });
  });
});

describe('EpicTimeStore related-time route resolution', () => {
  let sqlite: Database.Database;
  let store: EpicTimeStore;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    store = new EpicTimeStore(drizzle(sqlite) as unknown as BetterSQLite3Database);
    seedProjectStatuses();
  });

  afterEach(() => sqlite.close());

  function seedProjectStatuses(): void {
    const createdAt = '2026-01-01T00:00:00.000Z';
    sqlite
      .prepare(
        `INSERT INTO projects
           (id, name, root_path, is_template, is_private, created_at, updated_at)
         VALUES (?, 'Time', '/tmp/time', 0, 0, ?, ?)`,
      )
      .run(PROJECT_ID, createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO statuses
           (id, project_id, label, color, position, created_at, updated_at)
         VALUES ('status-time', ?, 'New', '#fff', 0, ?, ?)`,
      )
      .run(PROJECT_ID, createdAt, createdAt);
  }

  function insertEpicInProject(id: string, projectId: string, parentId: string | null): void {
    sqlite
      .prepare(
        `INSERT INTO epics
           (id, project_id, title, status_id, parent_id, version, created_at, updated_at)
         VALUES (?, ?, ?, 'status-time', ?, 1, '2026-01-01T00:00:00.000Z',
                 '2026-01-01T00:00:00.000Z')`,
      )
      .run(id, projectId, id, parentId);
  }

  function insertChildEpic(id: string, parentId: string): void {
    insertEpicInProject(id, PROJECT_ID, parentId);
  }

  function insertRoute(
    id: string,
    sourceId: string,
    targetId: string,
    type: 'related' | 'blocks' = 'related',
  ): void {
    // Relation rows order their pair canonically and direction stores the
    // semantic source -> target for Related routes and Blocks alike, exactly
    // like the relation write path.
    const sourceIsLeft = sourceId < targetId;
    const [leftEpicId, rightEpicId] = sourceIsLeft ? [sourceId, targetId] : [targetId, sourceId];
    const direction = sourceIsLeft ? 'left_to_right' : 'right_to_left';
    sqlite
      .prepare(
        `INSERT INTO epic_relations
           (id, left_epic_id, right_epic_id, type, direction,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(id, leftEpicId, rightEpicId, type, direction);
  }

  function insertExternalLink(epicId: string): void {
    sqlite
      .prepare(
        `INSERT INTO external_task_links
           (id, epic_id, provider, remote_scope_key, remote_task_id,
            source_snapshot, created_at, updated_at)
         VALUES (?, ?, 'clickup', 'scope', ?, '{}', '2026-01-01T00:00:00.000Z',
                 '2026-01-01T00:00:00.000Z')`,
      )
      .run(`link-${epicId}`, epicId, `task-${epicId}`);
  }

  function insertSegment(id: string, epicId: string, durationMs = 60_000): void {
    sqlite
      .prepare(
        `INSERT INTO epic_time_segments
           (id, project_id, epic_id, session_id_snapshot, agent_id_snapshot,
            agent_name_snapshot, started_at, last_activity_at, closed_at,
            duration_ms, created_at, updated_at)
         VALUES (?, ?, ?, 'session-x', 'agent-x', 'Coder',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z',
                 '2026-01-01T00:01:00.000Z', ?, '2026-01-01T00:01:00.000Z',
                 '2026-01-01T00:01:00.000Z')`,
      )
      .run(id, PROJECT_ID, epicId, durationMs);
  }

  function resolvedEpicIds(focalId: string, ...extraFocals: string[]): string[] {
    return store
      .listResolvedScope([focalId, ...extraFocals])
      .segments.filter((segment) => segment.rootEpicId === focalId)
      .map((segment) => segment.epicId)
      .sort();
  }

  it('reproduces the authoritative linked-anchor rollup split', () => {
    for (const id of ['epic-1', 'epic-2', 'epic-3', 'epic-4']) {
      insertEpicInProject(id, PROJECT_ID, null);
      insertSegment(`seg-${id}`, id);
    }
    insertExternalLink('epic-1');
    insertExternalLink('epic-3');
    insertRoute('rel-2-1', 'epic-2', 'epic-1');
    insertRoute('rel-3-2', 'epic-3', 'epic-2');
    insertRoute('rel-4-3', 'epic-4', 'epic-3');

    expect(resolvedEpicIds('epic-1')).toEqual(['epic-1', 'epic-2']);
    expect(resolvedEpicIds('epic-3')).toEqual(['epic-3', 'epic-4']);
  });

  it('expands accepted routed roots to unlinked direct children only', () => {
    insertEpicInProject('focal', PROJECT_ID, null);
    insertEpicInProject('routed', PROJECT_ID, null);
    insertChildEpic('routed-child-open', 'routed');
    insertChildEpic('routed-child-linked', 'routed');
    insertChildEpic('focal-child-linked', 'focal');
    insertExternalLink('routed-child-linked');
    insertExternalLink('focal-child-linked');
    insertRoute('rel-routed', 'routed', 'focal');
    for (const id of [
      'focal',
      'routed',
      'routed-child-open',
      'routed-child-linked',
      'focal-child-linked',
    ]) {
      insertSegment(`seg-${id}`, id);
    }

    expect(resolvedEpicIds('focal')).toEqual([
      'focal',
      'focal-child-linked',
      'routed',
      'routed-child-open',
    ]);
  });

  it('ignores cross-project routes, blocks rows, non-root sources, and legacy neutral rows', () => {
    insertEpicInProject('focal', PROJECT_ID, null);
    sqlite
      .prepare(
        `INSERT INTO projects
           (id, name, root_path, is_template, is_private, created_at, updated_at)
         VALUES ('project-other', 'Other', '/tmp/other', 0, 0,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    insertEpicInProject('foreign', 'project-other', null);
    insertEpicInProject('blocks-source', PROJECT_ID, null);
    insertEpicInProject('legacy-neutral', PROJECT_ID, null);
    insertChildEpic('child-source', 'focal');
    insertRoute('rel-foreign', 'foreign', 'focal');
    insertRoute('rel-blocks', 'blocks-source', 'focal', 'blocks');
    insertRoute('rel-child', 'child-source', 'focal');
    // Pre-feature rows still store direction 'none'; they stay readable as
    // plain neutral links and contribute no routed time.
    sqlite
      .prepare(
        `INSERT INTO epic_relations
           (id, left_epic_id, right_epic_id, type, direction, created_at, updated_at)
         VALUES ('rel-legacy', ?, ?, 'related', 'none',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(
        'legacy-neutral' < 'focal' ? 'legacy-neutral' : 'focal',
        'legacy-neutral' < 'focal' ? 'focal' : 'legacy-neutral',
      );
    for (const id of ['focal', 'blocks-source', 'child-source', 'legacy-neutral']) {
      insertSegment(`seg-${id}`, id);
    }

    expect(resolvedEpicIds('focal')).toEqual(['child-source', 'focal']);
  });

  it('terminates corrupt route cycles through the UNION visited set without double counting', () => {
    insertEpicInProject('cycle-a', PROJECT_ID, null);
    insertEpicInProject('cycle-b', PROJECT_ID, null);
    insertEpicInProject('cycle-c', PROJECT_ID, null);
    insertEpicInProject('focal-cycle', PROJECT_ID, null);
    // focal -> a -> b -> c -> focal is a cycle the write path rejects but raw
    // rows can still express across four distinct pairs; the resolver must
    // terminate and count each Epic once.
    insertRoute('rel-cycle-focal-a', 'focal-cycle', 'cycle-a');
    insertRoute('rel-cycle-ab', 'cycle-a', 'cycle-b');
    insertRoute('rel-cycle-bc', 'cycle-b', 'cycle-c');
    insertRoute('rel-cycle-c-focal', 'cycle-c', 'focal-cycle');
    for (const id of ['cycle-a', 'cycle-b', 'cycle-c', 'focal-cycle']) {
      insertSegment(`seg-${id}`, id);
    }

    const segments = store
      .listResolvedScope(['focal-cycle'])
      .segments.filter((segment) => segment.rootEpicId === 'focal-cycle');
    expect(segments.map((segment) => segment.epicId).sort()).toEqual([
      'cycle-a',
      'cycle-b',
      'cycle-c',
      'focal-cycle',
    ]);
    expect(new Set(segments.map((segment) => segment.id)).size).toBe(segments.length);
  });

  it('counts an epic reached as both a routed child and a corrupt non-root route source once', () => {
    insertEpicInProject('focal-overlap', PROJECT_ID, null);
    insertEpicInProject('routed-overlap', PROJECT_ID, null);
    insertChildEpic('shared-child', 'routed-overlap');
    insertRoute('rel-routed-overlap', 'routed-overlap', 'focal-overlap');
    // Corrupt: a non-root child also carries a route into the focal; the
    // resolver must ignore its route while still counting it once as the
    // routed root's child.
    insertRoute('rel-shared', 'shared-child', 'focal-overlap');
    for (const id of ['focal-overlap', 'routed-overlap', 'shared-child']) {
      insertSegment(`seg-${id}`, id);
    }

    const segments = store
      .listResolvedScope(['focal-overlap'])
      .segments.filter((segment) => segment.rootEpicId === 'focal-overlap');
    expect(segments.map((segment) => segment.epicId).sort()).toEqual([
      'focal-overlap',
      'routed-overlap',
      'shared-child',
    ]);
    expect(new Set(segments.map((segment) => segment.id)).size).toBe(segments.length);
  });

  it('exposes routed roots with zero closed segments and excludes linked roots', () => {
    insertEpicInProject('focal-meta', PROJECT_ID, null);
    insertEpicInProject('empty-routed', PROJECT_ID, null);
    insertEpicInProject('linked-routed', PROJECT_ID, null);
    insertExternalLink('linked-routed');
    insertRoute('rel-meta-empty', 'empty-routed', 'focal-meta');
    insertRoute('rel-meta-linked', 'linked-routed', 'focal-meta');
    insertSegment('seg-focal-meta', 'focal-meta');
    insertChildEpic('child-meta', 'focal-meta');

    expect(store.listResolvedScope(['focal-meta']).routedRootIdsByFocal.get('focal-meta')).toEqual([
      'empty-routed',
    ]);
    // The zero-segment routed root contributes no minutes, so the metadata
    // view of the same statement is the only place its routed scope stays
    // visible.
    expect(
      store.listResolvedScope(['focal-meta']).segments.map((segment) => segment.epicId),
    ).toEqual(['focal-meta']);
    expect(store.listResolvedScope(['child-meta']).routedRootIdsByFocal.get('child-meta')).toEqual(
      [],
    );
    expect(
      store.listResolvedScope(['linked-routed']).routedRootIdsByFocal.get('linked-routed'),
    ).toEqual([]);
  });

  it('resolves every batch focal in one statement with shared and routed scope', () => {
    insertEpicInProject('batch-1', PROJECT_ID, null);
    insertEpicInProject('batch-2', PROJECT_ID, null);
    insertEpicInProject('shared-routed', PROJECT_ID, null);
    insertRoute('rel-shared-b1', 'shared-routed', 'batch-1');
    for (const id of ['batch-1', 'batch-2', 'shared-routed']) {
      insertSegment(`seg-${id}`, id);
    }

    const segments = store.listResolvedScope(['batch-1', 'batch-2']).segments;
    const byFocal = new Map<string, string[]>();
    for (const segment of segments) {
      byFocal.set(segment.rootEpicId, [...(byFocal.get(segment.rootEpicId) ?? []), segment.epicId]);
    }
    expect(byFocal.get('batch-1')?.sort()).toEqual(['batch-1', 'shared-routed']);
    expect(byFocal.get('batch-2')?.sort()).toEqual(['batch-2']);
  });
});
