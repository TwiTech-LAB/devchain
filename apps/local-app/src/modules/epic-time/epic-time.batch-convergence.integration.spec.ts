import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { EventLogService } from '../events/services/event-log.service';
import type { EventsService } from '../events/services/events.service';
import type { EventsStreamService } from '../events/services/events-stream.service';
import { CommittedEventStore } from '../events/services/committed-event.store';
import { DurableEventDispatcherService } from '../events/services/durable-event-dispatcher.service';
import { DurableEventRegistryService } from '../events/services/durable-event-registry.service';
import {
  AgentTimeAccountingService,
  EPIC_TIME_DELIVERY_KEY,
} from './services/agent-time-accounting.service';
import { EpicTimeStore } from './services/epic-time.store';

const MIGRATIONS_FOLDER = join(__dirname, '../../../drizzle');
const NOW = new Date('2026-08-30T08:00:00.000Z');
const PROJECT_ID = 'project-convergence';
const TEAM_ID = 'team-convergence';
const LEAD_ID = 'lead-convergence';
const SUBAGENT_ID = 'subagent-convergence';

// Layer: cross-cutting backend integration. The contracts under test span real
// SQLite transactions, durable delivery leases, retention cascades, and restart.
describe('Epic-time team batch convergence', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let registry: DurableEventRegistryService;
  let committedEvents: CommittedEventStore;
  let store: EpicTimeStore;
  let accounting: AgentTimeAccountingService;
  let dispatcher: DurableEventDispatcherService;
  let accountingStarted: boolean;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite) as unknown as BetterSQLite3Database;
    seedIdentity();

    registry = new DurableEventRegistryService();
    committedEvents = new CommittedEventStore(db, registry);
    store = new EpicTimeStore(db);
    accounting = createAccountingService();
    dispatcher = new DurableEventDispatcherService(committedEvents, registry);
    accountingStarted = false;
  });

  afterEach(() => {
    if (accountingStarted) {
      accounting.onModuleDestroy();
    }
    sqlite.close();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function seedIdentity(): void {
    const createdAt = '2026-08-30T07:00:00.000Z';
    sqlite
      .prepare(
        `INSERT INTO projects
           (id, name, root_path, is_template, is_private, created_at, updated_at)
         VALUES (?, 'Convergence', '/tmp/convergence', 0, 0, ?, ?)`,
      )
      .run(PROJECT_ID, createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO providers
           (id, name, mcp_configured, created_at, updated_at)
         VALUES ('provider-convergence', 'provider-convergence', 0, ?, ?)`,
      )
      .run(createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO agent_profiles
           (id, project_id, name, created_at, updated_at)
         VALUES ('profile-convergence', ?, 'Convergence profile', ?, ?)`,
      )
      .run(PROJECT_ID, createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO profile_provider_configs
           (id, profile_id, provider_id, name, position, created_at, updated_at)
         VALUES ('config-convergence', 'profile-convergence', 'provider-convergence',
                 'Convergence config', 0, ?, ?)`,
      )
      .run(createdAt, createdAt);
    const insertAgent = sqlite.prepare(
      `INSERT INTO agents
         (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
       VALUES (?, ?, 'profile-convergence', 'config-convergence', ?, ?, ?)`,
    );
    insertAgent.run(LEAD_ID, PROJECT_ID, 'Team Lead', createdAt, createdAt);
    insertAgent.run(SUBAGENT_ID, PROJECT_ID, 'Subagent', createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO statuses
           (id, project_id, label, color, position, created_at, updated_at)
         VALUES ('status-convergence', ?, 'New', '#fff', 0, ?, ?)`,
      )
      .run(PROJECT_ID, createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO teams
           (id, project_id, name, team_lead_agent_id, created_at, updated_at)
         VALUES (?, ?, 'Builders', ?, ?, ?)`,
      )
      .run(TEAM_ID, PROJECT_ID, LEAD_ID, createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO team_members (team_id, agent_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(TEAM_ID, SUBAGENT_ID, createdAt);
    insertEpic('lead-target', LEAD_ID);
    insertEpic('subagent-target', null);
  }

  function insertEpic(id: string, agentId: string | null): void {
    sqlite
      .prepare(
        `INSERT INTO epics
           (id, project_id, title, status_id, agent_id, version, created_at, updated_at)
         VALUES (?, ?, ?, 'status-convergence', ?, 1,
                 '2026-08-30T07:00:00.000Z', '2026-08-30T07:00:00.000Z')`,
      )
      .run(id, PROJECT_ID, id, agentId);
  }

  function insertBatch(input: { id: string; startedAt: string; sealedAt?: string | null }): void {
    sqlite
      .prepare(
        `INSERT INTO epic_time_team_batches
           (id, project_id, team_id_snapshot, team_name_snapshot,
            lead_agent_id_snapshot, lead_agent_name_snapshot, started_at,
            sealed_at, created_at, updated_at)
         VALUES (?, ?, ?, 'Builders', ?, 'Team Lead', ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        PROJECT_ID,
        TEAM_ID,
        LEAD_ID,
        input.startedAt,
        input.sealedAt ?? null,
        input.startedAt,
        input.startedAt,
      );
  }

  function insertSegment(input: {
    id: string;
    batchId: string;
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
         VALUES (?, ?, NULL, ?, 'direct', ?, 'Builders', ?, ?, 'Subagent',
                 ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        PROJECT_ID,
        input.batchId,
        TEAM_ID,
        `${input.id}-session`,
        SUBAGENT_ID,
        input.startedAt,
        input.lastActivityAt,
        input.closed ? input.lastActivityAt : null,
        input.durationMs,
        input.lastActivityAt,
        input.lastActivityAt,
      );
  }

  function createAccountingService(): AgentTimeAccountingService {
    const events = {
      registerDurableSubscriber: registry.register.bind(registry),
    } as unknown as EventsService;
    return new AgentTimeAccountingService(store, events);
  }

  async function startAccounting(): Promise<void> {
    await accounting.onModuleInit();
    accountingStarted = true;
  }

  async function appendEpicUpdate(input: {
    id: string;
    publishedAt: string;
    actorAgentId?: string | null;
    targetEpicId?: string;
  }): Promise<void> {
    const targetEpicId = input.targetEpicId ?? 'subagent-target';
    await committedEvents.appendCommitted({
      id: input.id,
      name: 'epic.updated',
      payload: {
        epicId: targetEpicId,
        projectId: PROJECT_ID,
        parentId: null,
        version: 2,
        epicTitle: targetEpicId,
        actor:
          input.actorAgentId === null
            ? null
            : { type: 'agent', id: input.actorAgentId ?? SUBAGENT_ID },
        changes: {},
      },
      requestId: null,
      publishedAt: input.publishedAt,
    });
  }

  function batchRows(): Array<Record<string, unknown>> {
    return sqlite
      .prepare(
        `SELECT id, sealed_at FROM epic_time_team_batches
         ORDER BY started_at, id`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  function segmentRows(): Array<Record<string, unknown>> {
    return sqlite
      .prepare(
        `SELECT id, epic_id, team_batch_id, attribution_source,
                team_id_snapshot, agent_id_snapshot, session_id_snapshot,
                closed_at, duration_ms
         FROM epic_time_segments
         ORDER BY started_at, id`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  function barrierIds(): string[] {
    return (
      sqlite
        .prepare(
          `SELECT committed_event_id
           FROM epic_time_team_batch_event_barriers
           ORDER BY committed_event_id`,
        )
        .all() as Array<{ committed_event_id: string }>
    ).map((row) => row.committed_event_id);
  }

  it('snapshots only pending, running, and retrying pre-seal deliveries and waits for all three', async () => {
    await startAccounting();
    insertBatch({ id: 'batch-statuses', startedAt: '2026-08-30T07:50:00.000Z' });
    insertSegment({
      id: 'segment-statuses',
      batchId: 'batch-statuses',
      startedAt: '2026-08-30T07:50:00.000Z',
      lastActivityAt: '2026-08-30T07:55:00.000Z',
      durationMs: 300_000,
    });
    for (const [id, status] of [
      ['event-pending', 'pending'],
      ['event-running', 'running'],
      ['event-retry', 'retry'],
      ['event-delivered', 'delivered'],
    ] as const) {
      await appendEpicUpdate({ id, publishedAt: '2026-08-30T07:59:00.000Z', actorAgentId: null });
      sqlite.prepare(`UPDATE event_handlers SET status = ? WHERE event_id = ?`).run(status, id);
    }

    await expect(store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, 30_000, NOW)).resolves.toEqual({
      sealedBatches: 1,
      finalizedBatches: 0,
      cancelledBatches: 0,
    });
    expect(barrierIds()).toEqual(['event-pending', 'event-retry', 'event-running']);
    await expect(store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, 30_000, NOW)).resolves.toEqual({
      sealedBatches: 0,
      finalizedBatches: 0,
      cancelledBatches: 0,
    });

    sqlite
      .prepare(
        `UPDATE event_handlers SET status = 'delivered'
         WHERE event_id IN ('event-pending', 'event-running', 'event-retry')`,
      )
      .run();
    await expect(store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, 30_000, NOW)).resolves.toEqual({
      sealedBatches: 0,
      finalizedBatches: 1,
      cancelledBatches: 0,
    });
    expect(batchRows()).toEqual([]);
    expect(segmentRows()).toEqual([
      expect.objectContaining({
        id: 'segment-statuses',
        epic_id: 'lead-target',
        attribution_source: 'team',
        agent_id_snapshot: LEAD_ID,
      }),
    ]);
  });

  it('delivers a delayed pre-seal claim before allowing finalization', async () => {
    await startAccounting();
    insertBatch({ id: 'batch-valid-claim', startedAt: '2026-08-30T07:50:00.000Z' });
    insertSegment({
      id: 'segment-valid-claim',
      batchId: 'batch-valid-claim',
      startedAt: '2026-08-30T07:50:00.000Z',
      lastActivityAt: '2026-08-30T07:55:00.000Z',
      durationMs: 300_000,
    });
    await appendEpicUpdate({
      id: 'event-valid-claim',
      publishedAt: '2026-08-30T07:59:00.000Z',
    });
    await store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, 30_000, NOW);
    expect(barrierIds()).toEqual(['event-valid-claim']);

    await expect(dispatcher.dispatchAvailable()).resolves.toBe(1);
    expect(
      sqlite
        .prepare(`SELECT status FROM event_handlers WHERE event_id = 'event-valid-claim'`)
        .get(),
    ).toEqual({ status: 'delivered' });
    expect(batchRows()).toEqual([
      { id: 'batch-valid-claim', sealed_at: '2026-08-30T08:00:00.000Z' },
    ]);
    expect(segmentRows()).toEqual([
      expect.objectContaining({
        id: 'segment-valid-claim',
        epic_id: 'subagent-target',
        team_batch_id: null,
        attribution_source: 'direct',
        agent_id_snapshot: SUBAGENT_ID,
      }),
    ]);

    await store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, 30_000, NOW);
    expect(batchRows()).toEqual([]);
    expect(segmentRows()).toHaveLength(1);
  });

  it('persists a callback accepted behind workTail before teardown can acknowledge it', async () => {
    await startAccounting();
    insertBatch({ id: 'batch-teardown-drain', startedAt: '2026-08-30T07:40:00.000Z' });
    insertSegment({
      id: 'segment-teardown-drain',
      batchId: 'batch-teardown-drain',
      startedAt: '2026-08-30T07:40:00.000Z',
      lastActivityAt: '2026-08-30T07:50:00.000Z',
      durationMs: 600_000,
    });
    await appendEpicUpdate({
      id: 'event-teardown-drain',
      publishedAt: '2026-08-30T07:59:00.000Z',
    });
    await store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, 30_000, NOW);

    let releaseExistingWork!: () => void;
    jest.spyOn(store, 'reconcileSession').mockImplementationOnce(
      (sessionId) =>
        new Promise((resolve) => {
          releaseExistingWork = () =>
            resolve({ sessionId, action: 'noop', watermark: null, segmentId: null });
        }),
    );
    const existingWork = accounting.requestSessionReconciliation('occupied-work');
    await Promise.resolve();
    const handleCommittedTaskTouch = accounting.handleCommittedTaskTouch.bind(accounting);
    let signalAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => {
      signalAccepted = resolve;
    });
    jest.spyOn(accounting, 'handleCommittedTaskTouch').mockImplementation((event) => {
      const result = handleCommittedTaskTouch(event);
      signalAccepted();
      return result;
    });
    const dispatch = dispatcher.dispatchAvailable();
    await accepted;

    accounting.onModuleDestroy();
    accountingStarted = false;
    releaseExistingWork();
    await existingWork;
    await expect(dispatch).resolves.toBe(1);

    expect(
      sqlite
        .prepare(`SELECT status FROM event_handlers WHERE event_id = ?`)
        .get('event-teardown-drain'),
    ).toEqual({ status: 'delivered' });
    expect(
      sqlite
        .prepare(
          `SELECT committed_event_id FROM epic_time_buffer_claims WHERE committed_event_id = ?`,
        )
        .get('event-teardown-drain'),
    ).toEqual({ committed_event_id: 'event-teardown-drain' });
    expect(segmentRows()).toEqual([
      expect.objectContaining({
        id: 'segment-teardown-drain',
        epic_id: 'subagent-target',
        team_batch_id: null,
        attribution_source: 'direct',
        agent_id_snapshot: SUBAGENT_ID,
      }),
    ]);
  });

  it('leaves a claim retryable when teardown unregisters before callback acceptance, then applies once after restart', async () => {
    await startAccounting();
    insertBatch({ id: 'batch-teardown-retry', startedAt: '2026-08-30T07:40:00.000Z' });
    insertSegment({
      id: 'segment-teardown-retry',
      batchId: 'batch-teardown-retry',
      startedAt: '2026-08-30T07:40:00.000Z',
      lastActivityAt: '2026-08-30T07:50:00.000Z',
      durationMs: 600_000,
    });
    await appendEpicUpdate({
      id: 'event-teardown-retry',
      publishedAt: '2026-08-30T07:59:00.000Z',
    });
    await store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, 30_000, NOW);

    const claimNext = committedEvents.claimNext.bind(committedEvents);
    let releaseClaim!: () => void;
    let signalClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => {
      signalClaimed = resolve;
    });
    jest
      .spyOn(committedEvents, 'claimNext')
      .mockImplementationOnce(async (leaseOwner, leaseMs, now) => {
        const delivery = await claimNext(leaseOwner, leaseMs, now);
        signalClaimed();
        await new Promise<void>((resolve) => {
          releaseClaim = resolve;
        });
        return delivery;
      });

    const firstDispatch = dispatcher.dispatchAvailable();
    await claimed;
    expect(
      sqlite
        .prepare(`SELECT status FROM event_handlers WHERE event_id = ?`)
        .get('event-teardown-retry'),
    ).toEqual({ status: 'running' });
    accounting.onModuleDestroy();
    accountingStarted = false;
    releaseClaim();
    await expect(firstDispatch).resolves.toBe(0);
    expect(
      sqlite
        .prepare(`SELECT status, attempts FROM event_handlers WHERE event_id = ?`)
        .get('event-teardown-retry'),
    ).toEqual({ status: 'retry', attempts: 1 });
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM epic_time_buffer_claims WHERE committed_event_id = ?`,
        )
        .get('event-teardown-retry'),
    ).toEqual({ count: 0 });

    accounting = createAccountingService();
    await startAccounting();
    jest.setSystemTime(new Date(NOW.getTime() + 1_000));
    await expect(dispatcher.dispatchAvailable()).resolves.toBe(1);
    await store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, 30_000, new Date(NOW.getTime() + 1_000));

    expect(
      sqlite
        .prepare(`SELECT status, attempts FROM event_handlers WHERE event_id = ?`)
        .get('event-teardown-retry'),
    ).toEqual({ status: 'delivered', attempts: 2 });
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM epic_time_buffer_claims WHERE committed_event_id = ?`,
        )
        .get('event-teardown-retry'),
    ).toEqual({ count: 1 });
    expect(batchRows()).toEqual([]);
    expect(segmentRows()).toEqual([
      expect.objectContaining({
        id: 'segment-teardown-retry',
        epic_id: 'subagent-target',
        team_batch_id: null,
        attribution_source: 'direct',
        agent_id_snapshot: SUBAGENT_ID,
      }),
    ]);
    await expect(dispatcher.dispatchAvailable()).resolves.toBe(0);
  });

  it('does not snapshot, admit, or wait for a post-seal event UUID', async () => {
    await startAccounting();
    insertBatch({
      id: 'batch-post-seal',
      startedAt: '2026-08-30T07:40:00.000Z',
      sealedAt: '2026-08-30T07:59:00.000Z',
    });
    insertSegment({
      id: 'segment-post-seal',
      batchId: 'batch-post-seal',
      startedAt: '2026-08-30T07:40:00.000Z',
      lastActivityAt: '2026-08-30T07:50:00.000Z',
      durationMs: 600_000,
      closed: true,
    });
    await appendEpicUpdate({
      id: 'event-post-seal',
      publishedAt: '2026-08-30T08:00:00.000Z',
    });

    await expect(dispatcher.dispatchAvailable()).resolves.toBe(1);
    expect(barrierIds()).toEqual([]);
    expect(batchRows()).toEqual([]);
    expect(segmentRows()).toEqual([
      expect.objectContaining({
        id: 'segment-post-seal',
        epic_id: 'lead-target',
        attribution_source: 'team',
        agent_id_snapshot: LEAD_ID,
      }),
    ]);
  });

  it('keeps a failed delayed claim retryable and applies it exactly once on retry', async () => {
    await startAccounting();
    insertBatch({ id: 'batch-handler-retry', startedAt: '2026-08-30T07:40:00.000Z' });
    insertSegment({
      id: 'segment-handler-retry',
      batchId: 'batch-handler-retry',
      startedAt: '2026-08-30T07:40:00.000Z',
      lastActivityAt: '2026-08-30T07:50:00.000Z',
      durationMs: 600_000,
    });
    await appendEpicUpdate({
      id: 'event-handler-retry',
      publishedAt: '2026-08-30T07:59:00.000Z',
    });
    await store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, 30_000, NOW);
    sqlite.exec(`
      CREATE TRIGGER fail_delayed_claim_receipt
      BEFORE INSERT ON epic_time_buffer_claims
      BEGIN
        SELECT RAISE(ABORT, 'delayed claim failed');
      END;
    `);

    await expect(dispatcher.dispatchAvailable()).resolves.toBe(0);
    expect(
      sqlite
        .prepare(`SELECT status, attempts FROM event_handlers WHERE event_id = ?`)
        .get('event-handler-retry'),
    ).toEqual({ status: 'retry', attempts: 1 });
    expect(segmentRows()).toEqual([
      expect.objectContaining({
        id: 'segment-handler-retry',
        epic_id: null,
        team_batch_id: 'batch-handler-retry',
      }),
    ]);

    sqlite.exec(`DROP TRIGGER fail_delayed_claim_receipt`);
    jest.setSystemTime(new Date(NOW.getTime() + 1_000));
    await expect(dispatcher.dispatchAvailable()).resolves.toBe(1);
    expect(
      sqlite
        .prepare(`SELECT status, attempts FROM event_handlers WHERE event_id = ?`)
        .get('event-handler-retry'),
    ).toEqual({ status: 'delivered', attempts: 2 });
    expect(segmentRows()).toEqual([
      expect.objectContaining({
        id: 'segment-handler-retry',
        epic_id: 'subagent-target',
        team_batch_id: null,
        attribution_source: 'direct',
        agent_id_snapshot: SUBAGENT_ID,
      }),
    ]);

    await store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, 30_000, new Date(NOW.getTime() + 1_000));
    await store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, 30_000, new Date(NOW.getTime() + 1_000));
    expect(batchRows()).toEqual([]);
    expect(segmentRows()).toHaveLength(1);
  });

  it('survives safe retention deletion and reuse of the deleted maximum SQLite rowid', async () => {
    await startAccounting();
    insertBatch({ id: 'batch-rowid', startedAt: '2026-08-30T07:40:00.000Z' });
    insertSegment({
      id: 'segment-rowid',
      batchId: 'batch-rowid',
      startedAt: '2026-08-30T07:40:00.000Z',
      lastActivityAt: '2026-08-30T07:50:00.000Z',
      durationMs: 600_000,
    });
    await appendEpicUpdate({
      id: 'event-retained-old',
      publishedAt: '2026-07-30T08:00:00.000Z',
      actorAgentId: null,
    });
    await store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, 30_000, NOW);
    await expect(dispatcher.dispatchAvailable()).resolves.toBe(1);
    const oldRowId = (
      sqlite.prepare(`SELECT rowid FROM events WHERE id = 'event-retained-old'`).get() as {
        rowid: number;
      }
    ).rowid;

    const eventLog = new EventLogService(
      db,
      {
        broadcastEventCreated: jest.fn(),
        broadcastHandlerResult: jest.fn(),
      } as unknown as EventsStreamService,
      committedEvents,
    );
    await expect(eventLog.cleanupExpiredEvents()).resolves.toBe(1);
    expect(barrierIds()).toEqual([]);

    await appendEpicUpdate({
      id: 'event-rowid-reused',
      publishedAt: '2026-08-30T08:00:00.000Z',
    });
    const reusedRowId = (
      sqlite.prepare(`SELECT rowid FROM events WHERE id = 'event-rowid-reused'`).get() as {
        rowid: number;
      }
    ).rowid;
    expect(reusedRowId).toBe(oldRowId);
    await expect(dispatcher.dispatchAvailable()).resolves.toBe(1);

    expect(barrierIds()).toEqual([]);
    expect(batchRows()).toEqual([]);
    expect(segmentRows()).toEqual([
      expect.objectContaining({
        id: 'segment-rowid',
        epic_id: 'lead-target',
        attribution_source: 'team',
        agent_id_snapshot: LEAD_ID,
      }),
    ]);
  });

  it('drains startup backlog for sequential batches exactly once across repeated sweeps', async () => {
    insertBatch({
      id: 'batch-startup-old',
      startedAt: '2026-08-30T07:20:00.000Z',
      sealedAt: '2026-08-30T07:30:00.000Z',
    });
    insertSegment({
      id: 'segment-startup-old',
      batchId: 'batch-startup-old',
      startedAt: '2026-08-30T07:20:00.000Z',
      lastActivityAt: '2026-08-30T07:30:00.000Z',
      durationMs: 600_000,
      closed: true,
    });
    insertBatch({ id: 'batch-startup-new', startedAt: '2026-08-30T07:40:00.000Z' });
    insertSegment({
      id: 'segment-startup-new',
      batchId: 'batch-startup-new',
      startedAt: '2026-08-30T07:40:00.000Z',
      lastActivityAt: '2026-08-30T07:55:00.000Z',
      durationMs: 900_000,
    });

    await startAccounting();
    expect(batchRows()).toEqual([]);
    const converged = segmentRows();
    expect(converged).toEqual([
      expect.objectContaining({
        id: 'segment-startup-old',
        epic_id: 'lead-target',
        attribution_source: 'team',
        agent_id_snapshot: LEAD_ID,
        duration_ms: 600_000,
      }),
      expect.objectContaining({
        id: 'segment-startup-new',
        epic_id: 'lead-target',
        attribution_source: 'team',
        agent_id_snapshot: LEAD_ID,
        duration_ms: 900_000,
      }),
    ]);

    await accounting.requestFullSweep(NOW);
    await accounting.requestFullSweep(NOW);
    expect(segmentRows()).toEqual(converged);
    expect(
      sqlite.prepare(`SELECT SUM(duration_ms) AS duration_ms FROM epic_time_segments`).get(),
    ).toEqual({ duration_ms: 1_500_000 });
  });

  it('rolls a failed seal back completely and converges on retry', async () => {
    await startAccounting();
    insertBatch({ id: 'batch-rollback', startedAt: '2026-08-30T07:40:00.000Z' });
    insertSegment({
      id: 'segment-rollback',
      batchId: 'batch-rollback',
      startedAt: '2026-08-30T07:40:00.000Z',
      lastActivityAt: '2026-08-30T07:50:00.000Z',
      durationMs: 600_000,
    });
    await appendEpicUpdate({
      id: 'event-rollback',
      publishedAt: '2026-08-30T07:59:00.000Z',
      actorAgentId: null,
    });
    sqlite.exec(`
      CREATE TRIGGER fail_barrier_snapshot
      BEFORE INSERT ON epic_time_team_batch_event_barriers
      BEGIN
        SELECT RAISE(ABORT, 'barrier snapshot failed');
      END;
    `);

    await expect(store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, 30_000, NOW)).rejects.toThrow(
      'barrier snapshot failed',
    );
    expect(batchRows()).toEqual([{ id: 'batch-rollback', sealed_at: null }]);
    expect(segmentRows()).toEqual([
      expect.objectContaining({ id: 'segment-rollback', closed_at: null }),
    ]);
    expect(barrierIds()).toEqual([]);

    sqlite.exec(`DROP TRIGGER fail_barrier_snapshot`);
    await store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, 30_000, NOW);
    expect(barrierIds()).toEqual(['event-rollback']);
    await expect(dispatcher.dispatchAvailable()).resolves.toBe(1);
    await store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, 30_000, NOW);
    await store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, 30_000, NOW);

    expect(batchRows()).toEqual([]);
    expect(segmentRows()).toEqual([
      expect.objectContaining({
        id: 'segment-rollback',
        epic_id: 'lead-target',
        attribution_source: 'team',
        agent_id_snapshot: LEAD_ID,
        duration_ms: 600_000,
      }),
    ]);
  });
});
