import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { EpicTimeStore } from './epic-time.store';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');
const PROJECT_ID = 'project-time';
const AGENT_ID = 'agent-time';
const SESSION_ID = 'session-time';

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
        `SELECT id, epic_id, started_at, last_activity_at, closed_at, duration_ms
         FROM epic_time_segments
         ORDER BY created_at, id`,
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
    expect(store.listClosedSegmentsForEpic('root-summary', true)).toEqual([
      expect.objectContaining({
        id: 'root-closed',
        epicId: 'root-summary',
        epicTitle: 'root-summary',
        isDirect: true,
      }),
      expect.objectContaining({
        id: 'child-closed',
        epicId: 'child-summary',
        epicTitle: 'Child',
        isDirect: false,
      }),
    ]);
    expect(store.listClosedSegmentsForEpic('child-summary', false)).toEqual([
      expect.objectContaining({ id: 'child-closed', isDirect: true }),
    ]);
    expect(store.getEpicTimeScopes(['root-summary', 'child-summary'])).toHaveLength(2);
    expect(store.listClosedSegmentsForRoots(['root-summary'])).toEqual([
      expect.objectContaining({ id: 'root-closed', rootEpicId: 'root-summary', isDirect: true }),
      expect.objectContaining({ id: 'child-closed', rootEpicId: 'root-summary', isDirect: false }),
    ]);
  });
});
