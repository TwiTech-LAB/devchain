import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { TransactionRunner } from '../../storage/db/transaction-runner';

const TRACKING_STARTED_AT_KEY = 'epicTime.trackingStartedAt';
const ACTIVITY_IDLE_TIMEOUT_KEY = 'activity.idleTimeoutMs';
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

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
  eventName: 'epic.created' | 'epic.updated';
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

export interface EpicTimeScope {
  id: string;
  parentId: string | null;
}

export interface EpicTimeSummarySegment {
  id: string;
  rootEpicId: string | null;
  epicId: string;
  epicTitle: string;
  isDirect: boolean;
  agentId: string;
  agentName: string;
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
  agent_id_snapshot: string;
  last_activity_at: string;
  duration_ms: number;
}

interface PendingBufferClaimRow {
  segment_id: string;
  target_epic_id_snapshot: string;
}

interface PendingClaimResult {
  claimedSegmentIds: Set<string>;
  discardedSegmentIds: Set<string>;
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
    const nowIso = now.toISOString();
    return this.transactionRunner.runImmediateQueued(() => {
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
        const priorActivityAt =
          openSegment?.last_activity_at ?? watermark?.last_activity_at ?? null;
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
          segmentId = randomUUID();
          this.rawClient
            .prepare(
              `INSERT INTO epic_time_segments
                 (id, project_id, epic_id, session_id_snapshot, agent_id_snapshot,
                  agent_name_snapshot, started_at, last_activity_at, closed_at,
                  duration_ms, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
            )
            .run(
              segmentId,
              session.project_id,
              epicId,
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
    });
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

  listClosedSegmentsForEpic(
    epicId: string,
    includeDirectChildren: boolean,
  ): EpicTimeSummarySegment[] {
    const rows = this.rawClient
      .prepare(
        `SELECT s.id, scoped.id AS epic_id, scoped.title AS epic_title,
                s.agent_id_snapshot, s.agent_name_snapshot,
                s.duration_ms, s.last_activity_at, s.updated_at
         FROM epic_time_segments s
         INNER JOIN epics scoped ON scoped.id = s.epic_id AND scoped.project_id = s.project_id
         WHERE s.closed_at IS NOT NULL
           AND (scoped.id = ? OR (? = 1 AND scoped.parent_id = ?))
         ORDER BY s.last_activity_at, s.id`,
      )
      .all(epicId, includeDirectChildren ? 1 : 0, epicId) as Array<{
      id: string;
      epic_id: string;
      epic_title: string;
      agent_id_snapshot: string;
      agent_name_snapshot: string;
      duration_ms: number;
      last_activity_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => this.mapSummarySegment(row, null, row.epic_id === epicId));
  }

  listClosedSegmentsForRoots(rootEpicIds: readonly string[]): EpicTimeSummarySegment[] {
    if (rootEpicIds.length === 0) {
      return [];
    }
    const placeholders = rootEpicIds.map(() => '?').join(', ');
    const rows = this.rawClient
      .prepare(
        `SELECT roots.id AS root_epic_id, s.id, scoped.id AS epic_id,
                scoped.title AS epic_title, s.agent_id_snapshot,
                s.agent_name_snapshot, s.duration_ms, s.last_activity_at, s.updated_at
         FROM epics roots
         INNER JOIN epics scoped
           ON (scoped.id = roots.id OR scoped.parent_id = roots.id)
          AND scoped.project_id = roots.project_id
         INNER JOIN epic_time_segments s
           ON s.project_id = roots.project_id
          AND s.epic_id = scoped.id
          AND s.closed_at IS NOT NULL
         WHERE roots.id IN (${placeholders})
         ORDER BY roots.id, s.last_activity_at, s.id`,
      )
      .all(...rootEpicIds) as Array<{
      root_epic_id: string;
      id: string;
      epic_id: string;
      epic_title: string;
      agent_id_snapshot: string;
      agent_name_snapshot: string;
      duration_ms: number;
      last_activity_at: string;
      updated_at: string;
    }>;
    return rows.map((row) =>
      this.mapSummarySegment(row, row.root_epic_id, row.epic_id === row.root_epic_id),
    );
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
      duration_ms: number;
      last_activity_at: string;
      updated_at: string;
    },
    rootEpicId: string | null,
    isDirect: boolean,
  ): EpicTimeSummarySegment {
    return {
      id: row.id,
      rootEpicId,
      epicId: row.epic_id,
      epicTitle: row.epic_title,
      isDirect,
      agentId: row.agent_id_snapshot,
      agentName: row.agent_name_snapshot,
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
          `SELECT id, project_id, epic_id, agent_id_snapshot, last_activity_at, duration_ms
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
       SET epic_id = ?, updated_at = ?
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
