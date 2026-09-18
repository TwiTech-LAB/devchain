import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type {
  AgentTimeBufferAssignmentInput,
  AgentTimeBufferAssignmentResult,
  AgentTimeBufferItem,
  AgentTimeBufferResetInput,
  AgentTimeBufferResetResult,
  AgentTimeBufferSnapshot,
  EpicTimeAttributionSource,
} from '../models/epic-time.models';
import { ConflictError, NotFoundError } from '../../../common/errors/error-types';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { TransactionRunner } from '../../storage/db/transaction-runner';

const TRACKING_STARTED_AT_KEY = 'epicTime.trackingStartedAt';
const ACTIVITY_IDLE_TIMEOUT_KEY = 'activity.idleTimeoutMs';
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const MILLIS_PER_MINUTE = 60_000;
const STALE_SNAPSHOT_MESSAGE =
  'The captured agent time snapshot changed. Refresh the buffered time and try again.';

/**
 * Shared resolved-scope recursion. The json_each table-valued function seeds
 * the focals (a one-element JSON array or a bound parameter), route_chain
 * walks incoming eligible Related time routes — type=related with a stored
 * direction between root Epics of one project — and stops at linked routed
 * roots, and the UNION acts as the visited set so corrupt cycles terminate.
 */
const RESOLVED_SCOPE_CTE = `
  focal(focal_id) AS (
    SELECT CAST(json_each.value AS TEXT) FROM json_each(?)
  ),
  route_chain(focal_id, epic_id) AS (
    SELECT f.focal_id, e.id
    FROM focal f
    JOIN epics e ON e.id = f.focal_id AND e.parent_id IS NULL
    UNION
    SELECT rc.focal_id, source.id
    FROM route_chain rc
    JOIN epics target ON target.id = rc.epic_id
    JOIN epics source
      ON source.parent_id IS NULL AND source.project_id = target.project_id
    JOIN epic_relations rel
      ON rel.type = 'related'
     AND (
       (rel.left_epic_id = source.id AND rel.right_epic_id = target.id
          AND rel.direction = 'left_to_right')
       OR (rel.left_epic_id = target.id AND rel.right_epic_id = source.id
          AND rel.direction = 'right_to_left')
     )
    WHERE NOT EXISTS (
      SELECT 1 FROM external_task_links link WHERE link.epic_id = source.id
    )
  )`;

export interface EpicTimeActivation {
  trackingStartedAt: string;
  idleTimeoutMs: number;
  firstActivation: boolean;
  recoveredOpenSegments: number;
}

export type EpicTimeReconciliationAction =
  | 'noop'
  | 'created'
  | 'created_closed'
  | 'advanced'
  | 'advanced_closed'
  | 'closed'
  | 'discarded';

export interface EpicTimeReconciliationResult {
  sessionId: string;
  action: EpicTimeReconciliationAction;
  watermark: string | null;
  segmentId: string | null;
}

export interface EpicTimeReconciliationOptions {
  forceCloseOpenSegment?: boolean;
}

export interface EpicTimeTaskTouch {
  committedEventId: string;
  eventName: 'epic.created' | 'epic.updated' | 'epic.comment.created';
  projectId: string;
  actorAgentId: string;
  targetEpicId: string;
  targetEpicTitle: string;
  publishedAt: string;
}

export interface EpicTimeTaskTouchResult {
  receiptCreated: boolean;
  claimedSegments: number;
  discardedSegments: number;
}

export interface EpicTimeBatchProcessingResult {
  sealedBatches: number;
  finalizedBatches: number;
  cancelledBatches: number;
}

export interface EpicTimeTerminationResetInput {
  sessionId: string;
  /** Current ownership key for the reset; null only reconciles final activity. */
  agentId: string | null;
  trackingStartedAt: string;
  idleTimeoutMs: number;
  deliveryKey: string;
  now: Date;
}

export interface EpicTimeTerminationResetResult {
  /** Workspace of the agent's current project; null when nothing was deleted. */
  workspaceId: string | null;
  deletedSegments: number;
}

export interface EpicTimeScope {
  id: string;
  parentId: string | null;
}

export interface EpicTimeSummarySegment {
  id: string;
  rootEpicId: string | null;
  epicId: string;
  epicTitle: string;
  /** Display owner: the focal for focal rows, the routed root for routed rows. */
  groupEpicId: string;
  groupEpicTitle: string;
  isDirect: boolean;
  agentId: string;
  agentName: string;
  attributionSource: EpicTimeAttributionSource;
  teamId: string | null;
  teamName: string | null;
  durationMs: number;
  lastActivityAt: string;
  updatedAt: string;
}

interface SessionRow {
  id: string;
  epic_id: string | null;
  agent_id: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  last_activity_at: string | null;
  activity_state: string | null;
  busy_since: string | null;
  project_id: string | null;
  epic_project_id: string | null;
  agent_name: string | null;
}

interface WatermarkRow {
  last_activity_at: string;
}

interface OpenSegmentRow {
  id: string;
  project_id: string;
  epic_id: string | null;
  team_batch_id: string | null;
  attribution_source: EpicTimeAttributionSource;
  team_id_snapshot: string | null;
  team_name_snapshot: string | null;
  agent_id_snapshot: string;
  last_activity_at: string;
  duration_ms: number;
}

interface EligibleTeamRow {
  team_id: string;
  team_name: string;
  lead_agent_id: string;
  lead_agent_name: string;
}

interface TeamBatchRow {
  id: string;
  project_id: string;
  team_id_snapshot: string;
  team_name_snapshot: string;
  lead_agent_id_snapshot: string;
  lead_agent_name_snapshot: string;
  started_at: string;
  sealed_at: string | null;
}

interface LaneWinnerRow {
  agent_id_snapshot: string;
  duration_ms: number;
  earliest_started_at: string;
}

interface PendingBufferClaimRow {
  segment_id: string;
  target_epic_id_snapshot: string;
}

interface PendingClaimResult {
  claimedSegmentIds: Set<string>;
  discardedSegmentIds: Set<string>;
}

/**
 * One settled, unlogged accounting row eligible for manual buffer
 * assignment. Column names match the epic_time_segments projection.
 */
interface EligibleBufferRow {
  id: string;
  agent_id_snapshot: string;
  duration_ms: number;
  started_at: string;
  last_activity_at: string;
  closed_at: string;
  updated_at: string;
}

/**
 * Fingerprint of one agent's exact eligible row set. Key order is fixed and
 * alphabetical so the JSON form is canonical; the caller-visible aggregates
 * (minutes, counts, capturedAt) never enter the hash, so only a real row-set
 * change can alter the token.
 */
function buildBufferSnapshotToken(
  projectId: string,
  agentId: string,
  rows: readonly EligibleBufferRow[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        agentId,
        projectId,
        rows: rows.map((row) => ({
          closedAt: row.closed_at,
          durationMs: row.duration_ms,
          id: row.id,
          lastActivityAt: row.last_activity_at,
          startedAt: row.started_at,
          updatedAt: row.updated_at,
        })),
      }),
    )
    .digest('hex');
}

@Injectable()
export class EpicTimeStore {
  private readonly rawClient: Database.Database;
  private readonly transactionRunner: TransactionRunner;

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.rawClient = getRawSqliteClient(db);
    this.transactionRunner = new TransactionRunner(this.rawClient);
  }

  async activate(now = new Date()): Promise<EpicTimeActivation> {
    const nowIso = now.toISOString();
    return this.transactionRunner.runImmediateQueued(() => {
      const stored = this.readSetting(TRACKING_STARTED_AT_KEY);
      const trackingStartedAt = stored ?? nowIso;
      this.timestampMs(trackingStartedAt);
      if (!stored) {
        this.rawClient
          .prepare(
            `INSERT INTO settings (id, key, value, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(randomUUID(), TRACKING_STARTED_AT_KEY, trackingStartedAt, nowIso, nowIso);
      }

      const recovered = this.rawClient
        .prepare(`SELECT COUNT(*) AS count FROM epic_time_segments WHERE closed_at IS NULL`)
        .get() as { count: number };

      return {
        trackingStartedAt,
        idleTimeoutMs: this.readIdleTimeoutMs(),
        firstActivation: stored === null,
        recoveredOpenSegments: recovered.count,
      };
    });
  }

  /**
   * Read-only activation settings. Session termination uses this to decide
   * whether accounting ever started without creating the tracking marker:
   * runtimes that never activated accounting must terminate lifecycle-only.
   */
  readActivationSettings(): { trackingStartedAt: string | null; idleTimeoutMs: number } {
    return {
      trackingStartedAt: this.readSetting(TRACKING_STARTED_AT_KEY),
      idleTimeoutMs: this.readIdleTimeoutMs(),
    };
  }

  listReconciliationSessionIds(trackingStartedAt: string): string[] {
    return (
      this.rawClient
        .prepare(
          `SELECT session_id
           FROM (
             SELECT s.id AS session_id
             FROM sessions s
             LEFT JOIN epic_time_session_watermarks w ON w.session_id = s.id
             WHERE s.last_activity_at IS NOT NULL
               AND s.last_activity_at > ?
               AND (w.last_activity_at IS NULL OR s.last_activity_at > w.last_activity_at)
             UNION
             SELECT session_id_snapshot AS session_id
             FROM epic_time_segments
             WHERE closed_at IS NULL
           )
           ORDER BY session_id`,
        )
        .all(trackingStartedAt) as Array<{ session_id: string }>
    ).map((row) => row.session_id);
  }

  async reconcileSession(
    sessionId: string,
    trackingStartedAt: string,
    idleTimeoutMs: number,
    now = new Date(),
    options: EpicTimeReconciliationOptions = {},
  ): Promise<EpicTimeReconciliationResult> {
    return this.transactionRunner.runImmediateQueued(() =>
      this.reconcileSessionCore(sessionId, trackingStartedAt, idleTimeoutMs, now, options),
    );
  }

  /**
   * Synchronous reconciliation core. Transaction-owning callers (session
   * termination) run it inside their own queued transaction; standalone
   * callers go through the queued wrapper above.
   */
  private reconcileSessionCore(
    sessionId: string,
    trackingStartedAt: string,
    idleTimeoutMs: number,
    now: Date,
    options: EpicTimeReconciliationOptions,
  ): EpicTimeReconciliationResult {
    const nowIso = now.toISOString();
    let openSegment = this.loadOpenSegment(sessionId);
    const session = this.loadSession(sessionId);
    if (!session) {
      if (openSegment) {
        this.closeSegment(openSegment.id, openSegment.last_activity_at, nowIso);
        return {
          sessionId,
          action: 'closed',
          watermark: null,
          segmentId: openSegment.id,
        };
      }
      return { sessionId, action: 'noop', watermark: null, segmentId: null };
    }

    const watermark = this.loadWatermark(sessionId);
    const activityAt = session.last_activity_at;
    const hasNewActivity =
      activityAt !== null &&
      this.isAfter(activityAt, trackingStartedAt) &&
      (!watermark || this.isAfter(activityAt, watermark.last_activity_at));

    if (!session.agent_id || !session.project_id || !session.agent_name) {
      if (openSegment) {
        this.closeSegment(openSegment.id, openSegment.last_activity_at, nowIso);
      }
      let action: EpicTimeReconciliationAction = 'noop';
      if (hasNewActivity) {
        action = 'discarded';
      } else if (openSegment) {
        action = 'closed';
      }
      const watermarkProjectId =
        session.project_id ?? session.epic_project_id ?? openSegment?.project_id;
      if (hasNewActivity && activityAt && watermarkProjectId) {
        this.upsertWatermark(session.id, watermarkProjectId, activityAt, nowIso);
      }
      return {
        sessionId,
        action,
        watermark: hasNewActivity ? activityAt : (watermark?.last_activity_at ?? null),
        segmentId: openSegment?.id ?? null,
      };
    }

    let action: EpicTimeReconciliationAction = 'noop';
    let segmentId = openSegment?.id ?? null;
    if (hasNewActivity && activityAt) {
      const hadOpenSegment = openSegment !== null;
      const epicId = this.resolveAttributionEpic(session);
      const eligibleTeam = epicId === null ? this.resolveEligibleTeam(session) : null;
      const openTeamBatch = eligibleTeam
        ? this.loadOpenTeamBatch(session.project_id, eligibleTeam.team_id)
        : null;
      const priorActivityAt = openSegment?.last_activity_at ?? watermark?.last_activity_at ?? null;
      const busyStart =
        session.activity_state === 'busy' && session.busy_since ? session.busy_since : activityAt;
      const continuityStart = priorActivityAt ?? busyStart;
      const continuityGapMs = this.elapsedMs(continuityStart, activityAt);
      const continuous = continuityGapMs >= 0 && continuityGapMs <= idleTimeoutMs;
      const sameSegment =
        openSegment !== null &&
        openSegment.project_id === session.project_id &&
        openSegment.agent_id_snapshot === session.agent_id &&
        openSegment.epic_id === epicId &&
        (eligibleTeam
          ? openTeamBatch !== null && openSegment.team_batch_id === openTeamBatch.id
          : openSegment.team_batch_id === null) &&
        continuous;

      if (sameSegment && openSegment) {
        const deltaMs = this.elapsedMs(openSegment.last_activity_at, activityAt);
        this.rawClient
          .prepare(
            `UPDATE epic_time_segments
               SET last_activity_at = ?, duration_ms = duration_ms + ?, updated_at = ?
               WHERE id = ? AND closed_at IS NULL`,
          )
          .run(activityAt, deltaMs, nowIso, openSegment.id);
        action = 'advanced';
      } else {
        if (openSegment) {
          this.closeSegment(openSegment.id, openSegment.last_activity_at, nowIso);
          openSegment = null;
        }
        const lowerBound = this.latestTimestamp([
          trackingStartedAt,
          session.started_at,
          watermark?.last_activity_at ?? null,
        ]);
        const busyStartProvesNewWindow =
          !watermark || this.isAfter(busyStart, watermark.last_activity_at);
        const startedAt =
          continuous && (hadOpenSegment || busyStartProvesNewWindow)
            ? this.latestTimestamp([busyStart, lowerBound])
            : activityAt;
        const durationMs = Math.max(0, this.elapsedMs(startedAt, activityAt));
        const teamBatch = eligibleTeam
          ? (openTeamBatch ??
            this.createOrLoadOpenTeamBatch(session.project_id, eligibleTeam, startedAt, nowIso))
          : null;
        segmentId = randomUUID();
        this.rawClient
          .prepare(
            `INSERT INTO epic_time_segments
                 (id, project_id, epic_id, team_batch_id, attribution_source,
                  team_id_snapshot, team_name_snapshot, session_id_snapshot,
                  agent_id_snapshot, agent_name_snapshot, started_at, last_activity_at,
                  closed_at, duration_ms, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'direct', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
          )
          .run(
            segmentId,
            session.project_id,
            epicId,
            teamBatch?.id ?? null,
            eligibleTeam?.team_id ?? null,
            eligibleTeam?.team_name ?? null,
            session.id,
            session.agent_id,
            session.agent_name,
            startedAt,
            activityAt,
            durationMs,
            nowIso,
            nowIso,
          );
        action = 'created';

        if (epicId === null) {
          const pendingClaim = this.applyPendingBufferClaims(
            session.project_id,
            session.agent_id,
            nowIso,
          );
          if (pendingClaim.discardedSegmentIds.has(segmentId)) {
            action = 'discarded';
            segmentId = null;
          }
        }
      }

      this.upsertWatermark(session.id, session.project_id, activityAt, nowIso);
      openSegment = this.loadOpenSegment(sessionId);
    }

    if (
      openSegment &&
      (options.forceCloseOpenSegment ||
        this.shouldClose(session, openSegment.last_activity_at, idleTimeoutMs, now))
    ) {
      this.closeSegment(openSegment.id, openSegment.last_activity_at, nowIso);
      if (action === 'created') {
        action = 'created_closed';
      } else if (action === 'advanced') {
        action = 'advanced_closed';
      } else {
        action = 'closed';
      }
      segmentId = openSegment.id;
    }

    return {
      sessionId,
      action,
      watermark: hasNewActivity ? activityAt : (watermark?.last_activity_at ?? null),
      segmentId,
    };
  }

  async processTeamBatches(
    deliveryKey: string,
    idleTimeoutMs: number,
    now = new Date(),
  ): Promise<EpicTimeBatchProcessingResult> {
    return this.transactionRunner.runImmediateQueued(() =>
      this.processTeamBatchesCore(deliveryKey, idleTimeoutMs, now),
    );
  }

  /**
   * Synchronous team-batch core: seals inactive batches behind their event
   * barriers, then finalizes or cancels sealed batches. Transaction-owning
   * callers (session termination) run it inside their own queued
   * transaction; standalone callers go through the queued wrapper above.
   */
  private processTeamBatchesCore(
    deliveryKey: string,
    idleTimeoutMs: number,
    now: Date,
  ): EpicTimeBatchProcessingResult {
    const nowIso = now.toISOString();
    const activeAfter = new Date(now.getTime() - idleTimeoutMs).toISOString();
    let sealedBatches = 0;
    let finalizedBatches = 0;
    let cancelledBatches = 0;
    const openBatches = this.loadTeamBatches(false);
    for (const batch of openBatches) {
      if (this.hasActiveEligibleMember(batch, activeAfter)) {
        continue;
      }
      this.rawClient
        .prepare(
          `UPDATE epic_time_segments
             SET closed_at = COALESCE(closed_at, last_activity_at), updated_at = ?
             WHERE team_batch_id = ?`,
        )
        .run(nowIso, batch.id);
      this.rawClient
        .prepare(
          `UPDATE epic_time_team_batches
             SET sealed_at = ?, updated_at = ?
             WHERE id = ? AND sealed_at IS NULL`,
        )
        .run(nowIso, nowIso, batch.id);
      this.rawClient
        .prepare(
          `INSERT OR IGNORE INTO epic_time_team_batch_event_barriers
               (team_batch_id, committed_event_id, created_at)
             SELECT ?, eh.event_id, ?
             FROM event_handlers eh
             INNER JOIN events e ON e.id = eh.event_id
             WHERE eh.delivery_key = ?
               AND eh.status IN ('pending', 'running', 'retry')
               AND e.published_at <= ?`,
        )
        .run(batch.id, nowIso, deliveryKey, nowIso);
      sealedBatches += 1;
    }

    const sealed = this.loadTeamBatches(true);
    for (const batch of sealed) {
      if (this.batchHasPendingBarrier(batch.id, deliveryKey)) {
        continue;
      }
      if (!this.isTeamBatchIdentityCurrent(batch)) {
        this.cancelTeamBatch(batch.id, nowIso);
        cancelledBatches += 1;
        continue;
      }
      this.finalizeTeamBatch(batch, nowIso);
      finalizedBatches += 1;
    }
    return { sealedBatches, finalizedBatches, cancelledBatches };
  }

  async recordTaskTouch(
    touch: EpicTimeTaskTouch,
    now = new Date(),
  ): Promise<EpicTimeTaskTouchResult> {
    const nowIso = now.toISOString();
    return this.transactionRunner.runImmediateQueued(() => {
      const agent = this.rawClient
        .prepare(`SELECT name FROM agents WHERE id = ? AND project_id = ?`)
        .get(touch.actorAgentId, touch.projectId) as { name: string } | undefined;
      if (!agent) {
        return { receiptCreated: false, claimedSegments: 0, discardedSegments: 0 };
      }

      const sourceEvent = this.rawClient
        .prepare(`SELECT rowid AS source_event_row_id FROM events WHERE id = ?`)
        .get(touch.committedEventId) as { source_event_row_id: number } | undefined;
      const inserted = this.rawClient
        .prepare(
          `INSERT INTO epic_time_buffer_claims
             (committed_event_id, event_name, project_id, agent_id_snapshot,
              agent_name_snapshot, target_epic_id_snapshot, target_epic_title_snapshot,
              published_at, source_event_row_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(committed_event_id) DO NOTHING`,
        )
        .run(
          touch.committedEventId,
          touch.eventName,
          touch.projectId,
          touch.actorAgentId,
          agent.name,
          touch.targetEpicId,
          touch.targetEpicTitle,
          touch.publishedAt,
          sourceEvent?.source_event_row_id ?? null,
          nowIso,
        );

      const applied = this.applyPendingBufferClaims(touch.projectId, touch.actorAgentId, nowIso);
      return {
        receiptCreated: inserted.changes === 1,
        claimedSegments: applied.claimedSegmentIds.size,
        discardedSegments: applied.discardedSegmentIds.size,
      };
    });
  }

  /**
   * One project-wide ordered read of settled unlogged activity per current
   * same-project agent. The inner join to live agents drops guests (separate
   * table) and deleted-agent snapshots; the eligibility predicate excludes
   * open activity, Epic-bound rows, and every open or sealed team-batch lane
   * — a finalized winner re-enters only after its batch row deletion sets
   * team_batch_id NULL, keeping the team attribution snapshots. Aggregation
   * happens in-process over the single ordered row set so the response is
   * byte-stable while the accounting rows do not change.
   */
  listAgentTimeBuffers(projectId: string): AgentTimeBufferSnapshot {
    const rows = this.listEligibleBufferRows(projectId, null);
    if (rows.length === 0) {
      return { capturedAt: null, items: [] };
    }

    let capturedAt = rows[0].updated_at;
    let capturedAtMs = this.timestampMs(capturedAt);
    const rowsByAgent = new Map<string, EligibleBufferRow[]>();
    for (const row of rows) {
      const updatedAtMs = this.timestampMs(row.updated_at);
      if (updatedAtMs > capturedAtMs) {
        capturedAt = row.updated_at;
        capturedAtMs = updatedAtMs;
      }
      const agentRows = rowsByAgent.get(row.agent_id_snapshot) ?? [];
      agentRows.push(row);
      rowsByAgent.set(row.agent_id_snapshot, agentRows);
    }

    const items: AgentTimeBufferItem[] = [];
    for (const [agentId, agentRows] of rowsByAgent) {
      const durationMs = agentRows.reduce((total, row) => total + row.duration_ms, 0);
      let oldest = agentRows[0].last_activity_at;
      let newest = agentRows[0].last_activity_at;
      for (const row of agentRows.slice(1)) {
        if (this.timestampMs(row.last_activity_at) < this.timestampMs(oldest)) {
          oldest = row.last_activity_at;
        }
        if (this.timestampMs(row.last_activity_at) > this.timestampMs(newest)) {
          newest = row.last_activity_at;
        }
      }
      items.push({
        agentId,
        snapshotToken: buildBufferSnapshotToken(projectId, agentId, agentRows),
        minutes: Math.floor(durationMs / MILLIS_PER_MINUTE),
        durationMs,
        segmentCount: agentRows.length,
        oldestActivityAt: oldest,
        newestActivityAt: newest,
      });
    }
    items.sort((left, right) => left.agentId.localeCompare(right.agentId));
    return { capturedAt, items };
  }

  /**
   * Snapshot-fenced manual assignment of one agent's complete eligible row
   * set to one same-project Epic. All validation — live agent, project,
   * same-project target, the eligibility predicate, the capturedAt
   * watermark, and the recomputed token — runs inside the single queued
   * transaction, so the write either moves the exact captured rows or
   * nothing (409). Only epic_id and updated_at change: attribution_source
   * and team snapshots survive, no buffer-claim receipt is created, and
   * nothing binds future activity.
   */
  async assignAgentTimeBuffer(
    input: AgentTimeBufferAssignmentInput,
    now = new Date(),
  ): Promise<AgentTimeBufferAssignmentResult> {
    const nowIso = now.toISOString();
    return this.transactionRunner.runImmediateQueued(() => {
      const project = this.rawClient
        .prepare(`SELECT workspace_id FROM projects WHERE id = ?`)
        .get(input.projectId) as { workspace_id: string } | undefined;
      if (!project) {
        throw new NotFoundError('Project', input.projectId);
      }
      const agent = this.rawClient
        .prepare(`SELECT id FROM agents WHERE id = ? AND project_id = ?`)
        .get(input.agentId, input.projectId);
      if (!agent) {
        throw new NotFoundError('Agent', input.agentId);
      }
      const epic = this.rawClient
        .prepare(`SELECT id FROM epics WHERE id = ? AND project_id = ?`)
        .get(input.targetEpicId, input.projectId);
      if (!epic) {
        throw new NotFoundError('Epic', input.targetEpicId);
      }

      const rows = this.requireCapturedBufferRows(input);
      const assignRow = this.rawClient.prepare(
        `UPDATE epic_time_segments
         SET epic_id = ?, updated_at = ?
         WHERE id = ?
           AND epic_id IS NULL
           AND team_batch_id IS NULL
           AND closed_at IS NOT NULL`,
      );
      for (const row of rows) {
        if (assignRow.run(input.targetEpicId, nowIso, row.id).changes !== 1) {
          throw new ConflictError(STALE_SNAPSHOT_MESSAGE);
        }
      }
      return { workspaceId: project.workspace_id };
    });
  }

  /**
   * Snapshot-fenced manual reset of one agent's complete eligible row set.
   * The same strict fence as assignment — live agent, project, the
   * eligibility predicate, the capturedAt watermark, and the recomputed
   * token — runs inside the single queued transaction, so the command either
   * deletes the exact captured rows or nothing (409). Watermarks and
   * buffer-claim receipts survive so deleted time can never be reconciled
   * back; open activity and pending or sealed team-batch lanes stay untouched.
   */
  async resetAgentTimeBuffer(
    input: AgentTimeBufferResetInput,
  ): Promise<AgentTimeBufferResetResult> {
    return this.transactionRunner.runImmediateQueued(() => {
      const project = this.rawClient
        .prepare(`SELECT workspace_id FROM projects WHERE id = ?`)
        .get(input.projectId) as { workspace_id: string } | undefined;
      if (!project) {
        throw new NotFoundError('Project', input.projectId);
      }
      const agent = this.rawClient
        .prepare(`SELECT id FROM agents WHERE id = ? AND project_id = ?`)
        .get(input.agentId, input.projectId);
      if (!agent) {
        throw new NotFoundError('Agent', input.agentId);
      }

      const rows = this.requireCapturedBufferRows(input);
      const deleteRow = this.rawClient.prepare(
        `DELETE FROM epic_time_segments
         WHERE id = ?
           AND epic_id IS NULL
           AND team_batch_id IS NULL
           AND closed_at IS NOT NULL
           AND duration_ms > 0`,
      );
      for (const row of rows) {
        if (deleteRow.run(row.id).changes !== 1) {
          throw new ConflictError(STALE_SNAPSHOT_MESSAGE);
        }
      }
      return { workspaceId: project.workspace_id };
    });
  }

  /**
   * Synchronous session-termination accounting core. The session lifecycle
   * caller owns one queued transaction that also writes the stopped session
   * row; this method must never open a transaction or await inside it.
   *
   * Ordering is load-bearing: team batches finalize BEFORE the deletion so
   * lead-owned winner time whose batch row disappears in finalization is
   * deleted as settled personal balance in this same transaction, while
   * lanes whose barriers are still pending survive with their existing
   * later-finalization semantics. The deletion matches current agent
   * ownership — never session provenance — and watermarks stay untouched so
   * no later reconcile can recreate the cleared activity.
   */
  runTerminationResetSync(input: EpicTimeTerminationResetInput): EpicTimeTerminationResetResult {
    const now = input.now;
    this.reconcileSessionCore(
      input.sessionId,
      input.trackingStartedAt,
      input.idleTimeoutMs,
      now,
      {},
    );
    this.processTeamBatchesCore(input.deliveryKey, input.idleTimeoutMs, now);
    if (!input.agentId) {
      return { workspaceId: null, deletedSegments: 0 };
    }
    const deleted = this.rawClient
      .prepare(
        `DELETE FROM epic_time_segments
         WHERE id IN (
           SELECT seg.id
           FROM epic_time_segments seg
           INNER JOIN agents a
             ON a.id = seg.agent_id_snapshot AND a.project_id = seg.project_id
           WHERE seg.agent_id_snapshot = ?
             AND seg.epic_id IS NULL
             AND seg.team_batch_id IS NULL
             AND seg.closed_at IS NOT NULL
             AND seg.duration_ms > 0
         )`,
      )
      .run(input.agentId);
    if (deleted.changes === 0) {
      return { workspaceId: null, deletedSegments: 0 };
    }
    const agentProject = this.rawClient
      .prepare(
        `SELECT p.workspace_id AS workspace_id
         FROM agents a
         INNER JOIN projects p ON p.id = a.project_id
         WHERE a.id = ?`,
      )
      .get(input.agentId) as { workspace_id: string } | undefined;
    return {
      workspaceId: agentProject?.workspace_id ?? null,
      deletedSegments: deleted.changes,
    };
  }

  getEpicTimeScope(epicId: string): EpicTimeScope | null {
    const row = this.rawClient
      .prepare(`SELECT id, parent_id FROM epics WHERE id = ?`)
      .get(epicId) as { id: string; parent_id: string | null } | undefined;
    return row ? { id: row.id, parentId: row.parent_id } : null;
  }

  getEpicTimeScopes(epicIds: readonly string[]): EpicTimeScope[] {
    if (epicIds.length === 0) {
      return [];
    }
    const placeholders = epicIds.map(() => '?').join(', ');
    return (
      this.rawClient
        .prepare(`SELECT id, parent_id FROM epics WHERE id IN (${placeholders})`)
        .all(...epicIds) as Array<{ id: string; parent_id: string | null }>
    ).map((row) => ({ id: row.id, parentId: row.parent_id }));
  }

  /**
   * One shared resolved-scope loader for detail and batch: a single prepared
   * recursive statement returns the deduplicated closed segments AND the
   * routed-root scope metadata from one database snapshot, so totals and
   * route metadata can never come from different route states. A child focal
   * stays self-only; a root focal keeps its unfiltered direct children and
   * additionally pulls same-project Related time routes. A linked routed root
   * is excluded and stops that traversal branch, and a linked child of a
   * routed root contributes nothing, while linked children of the focal root
   * stay included. The recursive CTE uses UNION as its visited set, so a
   * corrupt route cycle terminates instead of looping. Each scope row also
   * carries its display-owner group — the focal for focal rows, the routed
   * root for routed rows — so group identity is a pure function of
   * focal_id and epic_id; one outer join resolves the group title.
   */
  listResolvedScope(focalEpicIds: readonly string[]): {
    segments: EpicTimeSummarySegment[];
    routedRootIdsByFocal: Map<string, string[]>;
  } {
    if (focalEpicIds.length === 0) {
      return { segments: [], routedRootIdsByFocal: new Map() };
    }
    const rows = this.rawClient
      .prepare(
        `WITH RECURSIVE
         ${RESOLVED_SCOPE_CTE},
         scope(focal_id, epic_id, is_direct, group_epic_id) AS (
           SELECT f.focal_id, e.id, 1, f.focal_id
           FROM focal f
           JOIN epics e ON e.id = f.focal_id
           UNION
           SELECT f.focal_id, child.id, 0, f.focal_id
           FROM focal f
           JOIN epics e ON e.id = f.focal_id AND e.parent_id IS NULL
           JOIN epics child ON child.parent_id = e.id AND child.project_id = e.project_id
           UNION
           SELECT rc.focal_id, rc.epic_id, 0, rc.epic_id
           FROM route_chain rc
           WHERE rc.epic_id <> rc.focal_id
           UNION
           SELECT rc.focal_id, child.id, 0, rc.epic_id
           FROM route_chain rc
           JOIN epics routed ON routed.id = rc.epic_id
           JOIN epics child ON child.parent_id = routed.id AND child.project_id = routed.project_id
           WHERE rc.epic_id <> rc.focal_id
             AND NOT EXISTS (
               SELECT 1 FROM external_task_links link WHERE link.epic_id = child.id
             )
         )
         SELECT DISTINCT scope.focal_id AS root_epic_id,
                seg.id AS segment_id,
                scoped.id AS epic_id, scoped.title AS epic_title,
                seg.agent_id_snapshot, seg.agent_name_snapshot, seg.attribution_source,
                seg.team_id_snapshot, seg.team_name_snapshot,
                seg.duration_ms, seg.last_activity_at, seg.updated_at,
                scope.is_direct AS is_direct,
                scope.group_epic_id AS group_epic_id,
                group_epic.title AS group_epic_title,
                NULL AS routed_epic_id
         FROM scope
         JOIN epics scoped ON scoped.id = scope.epic_id
         LEFT JOIN epics group_epic ON group_epic.id = scope.group_epic_id
         JOIN epic_time_segments seg
           ON seg.epic_id = scoped.id
          AND seg.project_id = scoped.project_id
          AND seg.closed_at IS NOT NULL
         UNION ALL
         SELECT DISTINCT rc.focal_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                NULL, NULL, NULL, NULL, NULL, NULL, NULL, rc.epic_id
         FROM route_chain rc
         WHERE rc.epic_id <> rc.focal_id
         ORDER BY root_epic_id, last_activity_at, segment_id`,
      )
      .all(JSON.stringify(focalEpicIds)) as Array<{
      root_epic_id: string;
      segment_id: string | null;
      epic_id: string | null;
      epic_title: string | null;
      agent_id_snapshot: string | null;
      agent_name_snapshot: string | null;
      attribution_source: EpicTimeAttributionSource | null;
      team_id_snapshot: string | null;
      team_name_snapshot: string | null;
      duration_ms: number | null;
      last_activity_at: string | null;
      updated_at: string | null;
      is_direct: number | null;
      group_epic_id: string | null;
      group_epic_title: string | null;
      routed_epic_id: string | null;
    }>;
    const segments: EpicTimeSummarySegment[] = [];
    const routedRootIdsByFocal = new Map<string, string[]>();
    for (const row of rows) {
      if (row.routed_epic_id !== null) {
        const routed = routedRootIdsByFocal.get(row.root_epic_id) ?? [];
        routed.push(row.routed_epic_id);
        routedRootIdsByFocal.set(row.root_epic_id, routed);
        continue;
      }
      segments.push(
        this.mapSummarySegment(
          {
            id: row.segment_id!,
            epic_id: row.epic_id!,
            epic_title: row.epic_title!,
            agent_id_snapshot: row.agent_id_snapshot!,
            agent_name_snapshot: row.agent_name_snapshot!,
            attribution_source: row.attribution_source!,
            team_id_snapshot: row.team_id_snapshot,
            team_name_snapshot: row.team_name_snapshot,
            duration_ms: row.duration_ms!,
            last_activity_at: row.last_activity_at!,
            updated_at: row.updated_at!,
          },
          row.root_epic_id,
          row.is_direct === 1,
          row.group_epic_id!,
          row.group_epic_title!,
        ),
      );
    }
    for (const routed of routedRootIdsByFocal.values()) {
      routed.sort();
    }
    for (const focalId of focalEpicIds) {
      // Every requested focal carries an entry so callers never distinguish
      // "no routed roots" from "focal absent".
      if (!routedRootIdsByFocal.has(focalId)) {
        routedRootIdsByFocal.set(focalId, []);
      }
    }
    return { segments, routedRootIdsByFocal };
  }

  private resolveEligibleTeam(session: SessionRow): EligibleTeamRow | null {
    if (!session.agent_id || !session.project_id) {
      return null;
    }
    return (
      (this.rawClient
        .prepare(
          `SELECT t.id AS team_id, t.name AS team_name,
                  lead.id AS lead_agent_id, lead.name AS lead_agent_name
           FROM team_members tm
           INNER JOIN teams t ON t.id = tm.team_id AND t.project_id = ?
           INNER JOIN agents lead
             ON lead.id = t.team_lead_agent_id AND lead.project_id = t.project_id
           WHERE tm.agent_id = ?
             AND t.team_lead_agent_id <> tm.agent_id
             AND (
               SELECT COUNT(*)
               FROM team_members memberships
               INNER JOIN teams member_teams
                 ON member_teams.id = memberships.team_id
                AND member_teams.project_id = ?
               WHERE memberships.agent_id = tm.agent_id
             ) = 1
           LIMIT 1`,
        )
        .get(session.project_id, session.agent_id, session.project_id) as
        | EligibleTeamRow
        | undefined) ?? null
    );
  }

  private loadOpenTeamBatch(projectId: string, teamId: string): TeamBatchRow | null {
    return (
      (this.rawClient
        .prepare(
          `SELECT id, project_id, team_id_snapshot, team_name_snapshot,
                  lead_agent_id_snapshot, lead_agent_name_snapshot, started_at, sealed_at
           FROM epic_time_team_batches
           WHERE project_id = ? AND team_id_snapshot = ? AND sealed_at IS NULL`,
        )
        .get(projectId, teamId) as TeamBatchRow | undefined) ?? null
    );
  }

  private createOrLoadOpenTeamBatch(
    projectId: string,
    team: EligibleTeamRow,
    startedAt: string,
    nowIso: string,
  ): TeamBatchRow {
    this.rawClient
      .prepare(
        `INSERT INTO epic_time_team_batches
           (id, project_id, team_id_snapshot, team_name_snapshot,
            lead_agent_id_snapshot, lead_agent_name_snapshot, started_at,
            sealed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        randomUUID(),
        projectId,
        team.team_id,
        team.team_name,
        team.lead_agent_id,
        team.lead_agent_name,
        startedAt,
        nowIso,
        nowIso,
      );
    const batch = this.loadOpenTeamBatch(projectId, team.team_id);
    if (!batch) {
      throw new Error('Unable to create or load the open Epic-time team batch.');
    }
    return batch;
  }

  private loadTeamBatches(sealed: boolean): TeamBatchRow[] {
    return this.rawClient
      .prepare(
        `SELECT id, project_id, team_id_snapshot, team_name_snapshot,
                lead_agent_id_snapshot, lead_agent_name_snapshot, started_at, sealed_at
         FROM epic_time_team_batches
         WHERE sealed_at IS ${sealed ? 'NOT NULL' : 'NULL'}
         ORDER BY started_at, id`,
      )
      .all() as TeamBatchRow[];
  }

  private hasActiveEligibleMember(batch: TeamBatchRow, activeAfter: string): boolean {
    return Boolean(
      this.rawClient
        .prepare(
          `SELECT 1
           FROM sessions s
           INNER JOIN agents a
             ON a.id = s.agent_id AND a.project_id = ?
           INNER JOIN team_members tm
             ON tm.agent_id = a.id AND tm.team_id = ?
           INNER JOIN teams t
             ON t.id = tm.team_id
            AND t.project_id = ?
            AND t.team_lead_agent_id = ?
           INNER JOIN agents lead
             ON lead.id = t.team_lead_agent_id AND lead.project_id = t.project_id
           WHERE s.status = 'running'
             AND (s.activity_state IS NULL OR s.activity_state <> 'idle')
             AND s.last_activity_at > ?
             AND a.id <> t.team_lead_agent_id
             AND (
               SELECT COUNT(*)
               FROM team_members memberships
               INNER JOIN teams member_teams
                 ON member_teams.id = memberships.team_id
                AND member_teams.project_id = ?
               WHERE memberships.agent_id = a.id
             ) = 1
             AND NOT EXISTS (
               SELECT 1 FROM epics bound
               WHERE bound.id = s.epic_id AND bound.project_id = ?
             )
             AND NOT EXISTS (
               SELECT 1 FROM epics assigned
               WHERE assigned.project_id = ? AND assigned.agent_id = a.id
             )
           LIMIT 1`,
        )
        .get(
          batch.project_id,
          batch.team_id_snapshot,
          batch.project_id,
          batch.lead_agent_id_snapshot,
          activeAfter,
          batch.project_id,
          batch.project_id,
          batch.project_id,
        ),
    );
  }

  private batchHasPendingBarrier(batchId: string, deliveryKey: string): boolean {
    return Boolean(
      this.rawClient
        .prepare(
          `SELECT 1
           FROM epic_time_team_batch_event_barriers barrier
           INNER JOIN event_handlers delivery
             ON delivery.event_id = barrier.committed_event_id
            AND delivery.delivery_key = ?
           WHERE barrier.team_batch_id = ?
             AND delivery.status IN ('pending', 'running', 'retry')
           LIMIT 1`,
        )
        .get(deliveryKey, batchId),
    );
  }

  private isTeamBatchIdentityCurrent(batch: TeamBatchRow): boolean {
    const teamStillMatches = Boolean(
      this.rawClient
        .prepare(
          `SELECT 1
           FROM teams t
           INNER JOIN agents lead
             ON lead.id = t.team_lead_agent_id AND lead.project_id = t.project_id
           WHERE t.id = ? AND t.project_id = ? AND t.team_lead_agent_id = ?`,
        )
        .get(batch.team_id_snapshot, batch.project_id, batch.lead_agent_id_snapshot),
    );
    if (!teamStillMatches) {
      return false;
    }
    return !this.rawClient
      .prepare(
        `SELECT 1
         FROM epic_time_segments segment
         LEFT JOIN agents original
           ON original.id = segment.agent_id_snapshot AND original.project_id = segment.project_id
         WHERE segment.team_batch_id = ?
           AND segment.epic_id IS NULL
           AND (
             original.id IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM team_members exact_membership
               WHERE exact_membership.team_id = ?
                 AND exact_membership.agent_id = segment.agent_id_snapshot
             )
             OR (
               SELECT COUNT(*)
               FROM team_members memberships
               INNER JOIN teams member_teams
                 ON member_teams.id = memberships.team_id
                AND member_teams.project_id = segment.project_id
               WHERE memberships.agent_id = segment.agent_id_snapshot
             ) <> 1
           )
         LIMIT 1`,
      )
      .get(batch.id, batch.team_id_snapshot);
  }

  private cancelTeamBatch(batchId: string, nowIso: string): void {
    this.rawClient
      .prepare(
        `UPDATE epic_time_segments
         SET team_batch_id = NULL, attribution_source = 'direct',
             team_id_snapshot = NULL, team_name_snapshot = NULL, updated_at = ?
         WHERE team_batch_id = ? AND epic_id IS NULL`,
      )
      .run(nowIso, batchId);
    this.rawClient.prepare(`DELETE FROM epic_time_team_batches WHERE id = ?`).run(batchId);
  }

  private finalizeTeamBatch(batch: TeamBatchRow, nowIso: string): void {
    const winner = this.rawClient
      .prepare(
        `SELECT agent_id_snapshot, SUM(duration_ms) AS duration_ms,
                MIN(started_at) AS earliest_started_at
         FROM epic_time_segments
         WHERE team_batch_id = ? AND epic_id IS NULL
         GROUP BY agent_id_snapshot
         ORDER BY duration_ms DESC, earliest_started_at, agent_id_snapshot
         LIMIT 1`,
      )
      .get(batch.id) as LaneWinnerRow | undefined;
    if (winner) {
      const target = this.rawClient
        .prepare(
          `SELECT id
           FROM epics
           WHERE project_id = ? AND agent_id = ?
           ORDER BY updated_at DESC, id DESC
           LIMIT 1`,
        )
        .get(batch.project_id, batch.lead_agent_id_snapshot) as { id: string } | undefined;
      this.rawClient
        .prepare(
          `DELETE FROM epic_time_segments
           WHERE team_batch_id = ? AND epic_id IS NULL AND agent_id_snapshot <> ?`,
        )
        .run(batch.id, winner.agent_id_snapshot);
      this.rawClient
        .prepare(
          `UPDATE epic_time_segments
           SET epic_id = ?, agent_id_snapshot = ?, agent_name_snapshot = ?,
               attribution_source = 'team', updated_at = ?
           WHERE team_batch_id = ? AND epic_id IS NULL AND agent_id_snapshot = ?`,
        )
        .run(
          target?.id ?? null,
          batch.lead_agent_id_snapshot,
          batch.lead_agent_name_snapshot,
          nowIso,
          batch.id,
          winner.agent_id_snapshot,
        );
    }
    this.rawClient.prepare(`DELETE FROM epic_time_team_batches WHERE id = ?`).run(batch.id);
  }

  private loadSession(sessionId: string): SessionRow | null {
    return (
      (this.rawClient
        .prepare(
          `SELECT s.id, s.epic_id, s.agent_id, s.status, s.started_at, s.ended_at,
                  s.last_activity_at, s.activity_state, s.busy_since,
                  a.project_id, a.name AS agent_name, e.project_id AS epic_project_id
           FROM sessions s
           LEFT JOIN agents a ON a.id = s.agent_id
           LEFT JOIN epics e ON e.id = s.epic_id
           WHERE s.id = ?`,
        )
        .get(sessionId) as SessionRow | undefined) ?? null
    );
  }

  private mapSummarySegment(
    row: {
      id: string;
      epic_id: string;
      epic_title: string;
      agent_id_snapshot: string;
      agent_name_snapshot: string;
      attribution_source: EpicTimeAttributionSource;
      team_id_snapshot: string | null;
      team_name_snapshot: string | null;
      duration_ms: number;
      last_activity_at: string;
      updated_at: string;
    },
    rootEpicId: string | null,
    isDirect: boolean,
    groupEpicId: string,
    groupEpicTitle: string,
  ): EpicTimeSummarySegment {
    const attributionSource =
      row.attribution_source === 'team' && row.team_id_snapshot && row.team_name_snapshot
        ? 'team'
        : 'direct';
    return {
      id: row.id,
      rootEpicId,
      epicId: row.epic_id,
      epicTitle: row.epic_title,
      groupEpicId,
      groupEpicTitle,
      isDirect,
      agentId: row.agent_id_snapshot,
      agentName: row.agent_name_snapshot,
      attributionSource,
      teamId: attributionSource === 'team' ? row.team_id_snapshot : null,
      teamName: attributionSource === 'team' ? row.team_name_snapshot : null,
      durationMs: row.duration_ms,
      lastActivityAt: row.last_activity_at,
      updatedAt: row.updated_at,
    };
  }

  private loadWatermark(sessionId: string): WatermarkRow | null {
    return (
      (this.rawClient
        .prepare(
          `SELECT last_activity_at
           FROM epic_time_session_watermarks
           WHERE session_id = ?`,
        )
        .get(sessionId) as WatermarkRow | undefined) ?? null
    );
  }

  private loadOpenSegment(sessionId: string): OpenSegmentRow | null {
    return (
      (this.rawClient
        .prepare(
          `SELECT id, project_id, epic_id, team_batch_id, attribution_source,
                  team_id_snapshot, team_name_snapshot, agent_id_snapshot,
                  last_activity_at, duration_ms
           FROM epic_time_segments
           WHERE session_id_snapshot = ? AND closed_at IS NULL`,
        )
        .get(sessionId) as OpenSegmentRow | undefined) ?? null
    );
  }

  private resolveAttributionEpic(session: SessionRow): string | null {
    if (!session.project_id || !session.agent_id) {
      return null;
    }
    if (session.epic_id) {
      const bound = this.rawClient
        .prepare(`SELECT id FROM epics WHERE id = ? AND project_id = ?`)
        .get(session.epic_id, session.project_id) as { id: string } | undefined;
      if (bound) {
        return bound.id;
      }
    }
    const assigned = this.rawClient
      .prepare(
        `SELECT id
         FROM epics
         WHERE project_id = ? AND agent_id = ?
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
      )
      .get(session.project_id, session.agent_id) as { id: string } | undefined;
    return assigned?.id ?? null;
  }

  private upsertWatermark(
    sessionId: string,
    projectId: string,
    lastActivityAt: string,
    nowIso: string,
  ): void {
    this.rawClient
      .prepare(
        `INSERT INTO epic_time_session_watermarks
           (session_id, project_id, last_activity_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_activity_at = CASE
             WHEN excluded.last_activity_at > last_activity_at THEN excluded.last_activity_at
             ELSE last_activity_at
           END,
           updated_at = excluded.updated_at`,
      )
      .run(sessionId, projectId, lastActivityAt, nowIso, nowIso);
  }

  private applyPendingBufferClaims(
    projectId: string,
    agentId: string,
    nowIso: string,
  ): PendingClaimResult {
    const candidates = this.rawClient
      .prepare(
        `SELECT s.id AS segment_id, c.target_epic_id_snapshot
         FROM epic_time_segments s
         INNER JOIN epic_time_buffer_claims c ON c.claim_sequence = (
           SELECT earliest.claim_sequence
           FROM epic_time_buffer_claims earliest
           WHERE earliest.project_id = s.project_id
             AND earliest.agent_id_snapshot = s.agent_id_snapshot
             AND earliest.published_at >= s.started_at
             AND (
               s.team_batch_id IS NULL
               OR EXISTS (
                 SELECT 1
                 FROM epic_time_team_batches open_batch
                 WHERE open_batch.id = s.team_batch_id
                   AND open_batch.sealed_at IS NULL
               )
               OR EXISTS (
                 SELECT 1
                 FROM epic_time_team_batch_event_barriers barrier
                 WHERE barrier.team_batch_id = s.team_batch_id
                   AND barrier.committed_event_id = earliest.committed_event_id
               )
             )
           ORDER BY earliest.published_at, earliest.claim_sequence
           LIMIT 1
         )
         WHERE s.project_id = ?
           AND s.agent_id_snapshot = ?
           AND s.epic_id IS NULL
         ORDER BY s.started_at, s.id`,
      )
      .all(projectId, agentId) as PendingBufferClaimRow[];
    const claimedSegmentIds = new Set<string>();
    const discardedSegmentIds = new Set<string>();
    const targetExists = new Map<string, boolean>();
    const updateSegment = this.rawClient.prepare(
      `UPDATE epic_time_segments
       SET epic_id = ?,
           attribution_source = CASE
             WHEN team_batch_id IS NOT NULL THEN 'direct'
             ELSE attribution_source
           END,
           team_id_snapshot = CASE
             WHEN team_batch_id IS NOT NULL THEN NULL
             ELSE team_id_snapshot
           END,
           team_name_snapshot = CASE
             WHEN team_batch_id IS NOT NULL THEN NULL
             ELSE team_name_snapshot
           END,
           team_batch_id = NULL,
           updated_at = ?
       WHERE id = ? AND epic_id IS NULL`,
    );
    const deleteSegment = this.rawClient.prepare(
      `DELETE FROM epic_time_segments
       WHERE id = ? AND epic_id IS NULL`,
    );

    for (const candidate of candidates) {
      let exists = targetExists.get(candidate.target_epic_id_snapshot);
      if (exists === undefined) {
        exists = Boolean(
          this.rawClient
            .prepare(`SELECT 1 FROM epics WHERE id = ? AND project_id = ?`)
            .get(candidate.target_epic_id_snapshot, projectId),
        );
        targetExists.set(candidate.target_epic_id_snapshot, exists);
      }
      if (exists) {
        const updated = updateSegment.run(
          candidate.target_epic_id_snapshot,
          nowIso,
          candidate.segment_id,
        );
        if (updated.changes === 1) {
          claimedSegmentIds.add(candidate.segment_id);
        }
      } else {
        const deleted = deleteSegment.run(candidate.segment_id);
        if (deleted.changes === 1) {
          discardedSegmentIds.add(candidate.segment_id);
        }
      }
    }

    return { claimedSegmentIds, discardedSegmentIds };
  }

  /** Validate the captured rows inside the assignment or reset transaction. */
  private requireCapturedBufferRows(input: AgentTimeBufferResetInput): EligibleBufferRow[] {
    const rows = this.listEligibleBufferRows(input.projectId, input.agentId);
    const capturedAtMs = this.timestampMs(input.capturedAt);
    if (rows.length === 0 || rows.some((row) => this.timestampMs(row.updated_at) > capturedAtMs)) {
      throw new ConflictError(STALE_SNAPSHOT_MESSAGE);
    }
    if (buildBufferSnapshotToken(input.projectId, input.agentId, rows) !== input.snapshotToken) {
      throw new ConflictError(STALE_SNAPSHOT_MESSAGE);
    }
    return rows;
  }

  /**
   * Shared eligibility predicate for the buffer read and the fenced mutation
   * commands (assignment and reset): one ordered, project-scoped statement
   * whose live-agent inner join enforces the current real agent. A null
   * agentId widens the read to every current same-project agent; ordering by
   * agent, start, then row ID keeps both callers and the token fingerprint
   * deterministic.
   */
  private listEligibleBufferRows(projectId: string, agentId: string | null): EligibleBufferRow[] {
    return this.rawClient
      .prepare(
        `SELECT seg.id, seg.agent_id_snapshot, seg.duration_ms, seg.started_at,
                seg.last_activity_at, seg.closed_at, seg.updated_at
         FROM epic_time_segments seg
         INNER JOIN agents a
           ON a.id = seg.agent_id_snapshot AND a.project_id = seg.project_id
         WHERE seg.project_id = ?
           AND (? IS NULL OR seg.agent_id_snapshot = ?)
           AND seg.epic_id IS NULL
           AND seg.team_batch_id IS NULL
           AND seg.closed_at IS NOT NULL
           AND seg.duration_ms > 0
         ORDER BY seg.agent_id_snapshot, seg.started_at, seg.id`,
      )
      .all(projectId, agentId, agentId) as EligibleBufferRow[];
  }

  private closeSegment(segmentId: string, closedAt: string, nowIso: string): void {
    this.rawClient
      .prepare(
        `UPDATE epic_time_segments
         SET closed_at = ?, updated_at = ?
         WHERE id = ? AND closed_at IS NULL`,
      )
      .run(closedAt, nowIso, segmentId);
  }

  private shouldClose(
    session: SessionRow,
    lastActivityAt: string,
    idleTimeoutMs: number,
    now: Date,
  ): boolean {
    return (
      session.status !== 'running' ||
      session.activity_state === 'idle' ||
      now.getTime() - this.timestampMs(lastActivityAt) >= idleTimeoutMs
    );
  }

  private readSetting(key: string): string | null {
    const row = this.rawClient.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    if (!row) {
      return null;
    }
    try {
      const decoded = JSON.parse(row.value) as unknown;
      return typeof decoded === 'string' ? decoded : row.value;
    } catch {
      return row.value;
    }
  }

  private readIdleTimeoutMs(): number {
    const raw = this.readSetting(ACTIVITY_IDLE_TIMEOUT_KEY);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_TIMEOUT_MS;
  }

  private isAfter(left: string, right: string): boolean {
    return this.timestampMs(left) > this.timestampMs(right);
  }

  private elapsedMs(start: string, end: string): number {
    return this.timestampMs(end) - this.timestampMs(start);
  }

  private latestTimestamp(values: Array<string | null>): string {
    return values
      .filter((value): value is string => value !== null)
      .reduce((latest, value) => (this.isAfter(value, latest) ? value : latest));
  }

  private timestampMs(value: string): number {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      throw new Error('Epic time persistence contains an invalid timestamp.');
    }
    return parsed;
  }
}
