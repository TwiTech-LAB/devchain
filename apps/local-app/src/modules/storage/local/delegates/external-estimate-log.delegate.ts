import { and, asc, eq } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  OptimisticLockError,
  StorageError,
  ValidationError,
} from '../../../../common/errors/error-types';
import {
  externalEstimateLogDays,
  externalEstimateLogStates,
  externalTaskLinks,
  integrationConnections,
} from '../../db/schema';
import {
  LEGACY_UNASSIGNED_PROJECT_ID,
  type AssignUnassignedExternalEstimateLogCheckpoint,
  type ExternalEstimateDailyTotal,
  type ExternalEstimateLoggedMinutesEntry,
  type ExternalEstimateLogDailyCheckpoint,
  type ExternalEstimateLogDay,
  type ExternalEstimateLogIdentity,
  type ExternalEstimateLogOperationMutation,
  type ExternalEstimateLogState,
  type IntegrationProvider,
  type PrepareExternalEstimateLogOperation,
  type SetExternalEstimateLoggedMinutes,
  type StoreExternalEstimateLogResolution,
} from '../../models/domain.models';
import { isSqliteUniqueConstraint } from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const MAX_TIME_ENTRY_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_BATCH_IDENTITIES = 1_000;
// Ten years of daily rows: reads and daily-snapshot inputs fail closed at
// this bound instead of truncating the ledger.
const MAX_DAILY_LEDGER_ROWS = 3_660;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;
const ACTIVITY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ZONE_LENGTH = 128;

// One set-based read. The materialized input CTE stays the non-reorderable
// outer side of the CROSS JOIN, so each requested identity resolves through
// exactly one project-qualified index probe — never a provider-wide scan
// compared against every input.
const LIST_LOGGED_MINUTES_SQL = `
  WITH input(project_id, remote_scope_key, remote_task_id) AS MATERIALIZED (
    SELECT
      json_extract(value, '$.projectId'),
      json_extract(value, '$.remoteScopeKey'),
      json_extract(value, '$.remoteTaskId')
    FROM json_each(?)
  )
  SELECT
    states.project_id AS "projectId",
    states.remote_scope_key AS "remoteScopeKey",
    states.remote_task_id AS "remoteTaskId",
    states.logged_minutes AS "loggedMinutes"
  FROM input
  CROSS JOIN external_estimate_log_states AS states
    ON states.provider = ?
   AND states.project_id = input.project_id
   AND states.remote_scope_key = input.remote_scope_key
   AND states.remote_task_id = input.remote_task_id
  ORDER BY states.remote_scope_key, states.remote_task_id`;

type EstimateStateRow = typeof externalEstimateLogStates.$inferSelect;
type EstimateStateRowWithDaySum = EstimateStateRow & { daySum: number };
type PendingEstimateStateRow = EstimateStateRow & { pendingOperationId: string };

// SQL-side increment keeps the day upsert atomic under the composite key;
// the queued transaction serializes it with the scalar checkpoint write.
const UPSERT_DAY_SQL = `
  INSERT INTO external_estimate_log_days
    (project_id, provider, remote_scope_key, remote_task_id, activity_date,
     logged_minutes, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(project_id, provider, remote_scope_key, remote_task_id, activity_date) DO UPDATE SET
    logged_minutes = logged_minutes + excluded.logged_minutes,
    updated_at = excluded.updated_at`;

// The scalar row and its dated sum must come from one SQLite snapshot: a
// dated settlement committing between two separate reads would surface as a
// false ledger-exceeds-scalar error. The correlated sum probes the day
// ledger's composite primary-key prefix once per state row.
const LIST_BY_REMOTE_TASK_SQL = `
  SELECT
    states.project_id AS "projectId",
    states.provider AS "provider",
    states.remote_scope_key AS "remoteScopeKey",
    states.remote_task_id AS "remoteTaskId",
    states.logged_minutes AS "loggedMinutes",
    states.revision AS "revision",
    states.pending_operation_id AS "pendingOperationId",
    states.pending_delta_minutes AS "pendingDeltaMinutes",
    states.pending_estimate_total_minutes AS "pendingEstimateTotalMinutes",
    states.pending_started_at AS "pendingStartedAt",
    states.pending_connection_id AS "pendingConnectionId",
    states.pending_connection_generation AS "pendingConnectionGeneration",
    states.pending_phase AS "pendingPhase",
    states.pending_resolution AS "pendingResolution",
    states.aggregation_time_zone AS "aggregationTimeZone",
    states.pending_activity_date AS "pendingActivityDate",
    states.created_at AS "createdAt",
    states.updated_at AS "updatedAt",
    COALESCE((
      SELECT SUM(days.logged_minutes)
      FROM external_estimate_log_days AS days
      WHERE days.project_id = states.project_id
        AND days.provider = states.provider
        AND days.remote_scope_key = states.remote_scope_key
        AND days.remote_task_id = states.remote_task_id
    ), 0) AS "daySum"
  FROM external_estimate_log_states AS states
  WHERE states.provider = ? AND states.remote_task_id = ?
  ORDER BY states.remote_scope_key`;

export class ExternalEstimateLogStorageDelegate extends BaseStorageDelegate {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async get(identity: ExternalEstimateLogIdentity): Promise<ExternalEstimateLogState | null> {
    const normalized = this.normalizeIdentity(identity);
    const row = this.getRow(normalized);
    if (!row) {
      return null;
    }
    this.assertDaysWithinScalar(normalized, row.loggedMinutes);
    return this.mapState(row);
  }

  async getDailyCheckpoint(
    identity: ExternalEstimateLogIdentity,
  ): Promise<ExternalEstimateLogDailyCheckpoint | null> {
    const normalized = this.normalizeIdentity(identity);
    const row = this.getRow(normalized);
    if (!row) {
      return null;
    }
    return this.buildDailyCheckpoint(row, normalized);
  }

  async listByRemoteTask(
    provider: ExternalEstimateLogIdentity['provider'],
    remoteTaskId: string,
  ): Promise<ExternalEstimateLogState[]> {
    const normalizedProvider = this.requireProvider(provider);
    const normalizedTaskId = this.requireIdentifier(remoteTaskId, 'Remote task');
    const rows = this.rawClient
      .prepare(LIST_BY_REMOTE_TASK_SQL)
      .all(normalizedProvider, normalizedTaskId) as EstimateStateRowWithDaySum[];
    return rows.map((row) => {
      if (row.daySum > row.loggedMinutes) {
        throw this.ledgerExceedsScalar();
      }
      return this.mapState(row);
    });
  }

  listLoggedMinutes(
    provider: ExternalEstimateLogIdentity['provider'],
    identities: ReadonlyArray<{
      projectId: string;
      remoteScopeKey: string;
      remoteTaskId: string;
    }>,
  ): ExternalEstimateLoggedMinutesEntry[] {
    if (identities.length === 0) {
      return [];
    }
    const normalizedProvider = this.requireProvider(provider);
    const unique = new Map<
      string,
      { projectId: string; remoteScopeKey: string; remoteTaskId: string }
    >();
    for (const identity of identities) {
      const projectId = this.requireIdentifier(identity.projectId, 'Project');
      const remoteScopeKey = this.requireIdentifier(identity.remoteScopeKey, 'Remote scope');
      const remoteTaskId = this.requireIdentifier(identity.remoteTaskId, 'Remote task');
      unique.set(`${projectId}\u0000${remoteScopeKey}\u0000${remoteTaskId}`, {
        projectId,
        remoteScopeKey,
        remoteTaskId,
      });
    }
    if (unique.size > MAX_BATCH_IDENTITIES) {
      throw new ValidationError(
        `At most ${MAX_BATCH_IDENTITIES} estimate checkpoint identities may be read at once.`,
      );
    }
    const seed = JSON.stringify([...unique.values()]);
    return this.rawClient
      .prepare(LIST_LOGGED_MINUTES_SQL)
      .all(seed, normalizedProvider) as ExternalEstimateLoggedMinutesEntry[];
  }

  /**
   * Exact-identity read of unassigned legacy history. It deliberately
   * targets only the reserved legacy owner; callers authorize the requesting
   * project, current connection, and local link before acting on it.
   */
  async findUnassigned(
    provider: ExternalEstimateLogIdentity['provider'],
    remoteScopeKey: string,
    remoteTaskId: string,
  ): Promise<ExternalEstimateLogState | null> {
    const identity = this.normalizeUnassignedIdentity(provider, remoteScopeKey, remoteTaskId);
    const row = this.getRow(identity);
    return row ? this.mapState(row) : null;
  }

  /**
   * One-time ownership claim: moves the complete legacy scalar state and
   * every dated row to the claiming project inside one transaction. The
   * revision predicate on the legacy row plus the project-qualified unique
   * indexes guarantee exactly one winner among concurrent claims.
   */
  async assignUnassigned(
    data: AssignUnassignedExternalEstimateLogCheckpoint,
  ): Promise<ExternalEstimateLogDailyCheckpoint> {
    const target = this.normalizeIdentity({
      projectId: data.projectId,
      provider: data.provider,
      remoteScopeKey: data.remoteScopeKey,
      remoteTaskId: data.remoteTaskId,
    });
    const legacy = this.normalizeUnassignedIdentity(
      data.provider,
      data.remoteScopeKey,
      data.remoteTaskId,
    );
    const connectionId = this.requireIdentifier(data.connectionId, 'Connection');
    this.requirePositiveInteger(data.connectionGeneration, 'Connection generation');
    this.requireExpectedRevision(data.expectedRevision);

    return this.txRunner.runImmediateQueuedOrJoin(() => {
      // Assignment is admitted only through the project's currently
      // connected link: a disconnected snapshot or a link bound to another
      // connection must never claim legacy accounting.
      const link = this.db
        .select({ connectionId: externalTaskLinks.connectionId })
        .from(externalTaskLinks)
        .where(
          and(
            eq(externalTaskLinks.projectId, target.projectId),
            eq(externalTaskLinks.provider, target.provider),
            eq(externalTaskLinks.remoteScopeKey, target.remoteScopeKey),
            eq(externalTaskLinks.remoteTaskId, target.remoteTaskId),
          ),
        )
        .limit(1)
        .get();
      if (!link) {
        throw new NotFoundError('Current external task link');
      }
      if (link.connectionId !== connectionId) {
        throw new ConflictError(
          'The external task link does not belong to the current connection.',
          {
            reason: 'link_connection_mismatch',
          },
        );
      }
      this.assertConnectionEpoch(target.provider, connectionId, data.connectionGeneration, {
        projectId: target.projectId,
      });
      const legacyRow = this.getRow(legacy);
      if (!legacyRow) {
        // A concurrent winner may have moved the row between the caller's
        // discovery read and this transaction; that loss is a conflict,
        // not a missing-history corruption.
        const claimedElsewhere = this.db
          .select({ id: externalEstimateLogStates.provider })
          .from(externalEstimateLogStates)
          .where(
            and(
              eq(externalEstimateLogStates.provider, target.provider),
              eq(externalEstimateLogStates.remoteScopeKey, target.remoteScopeKey),
              eq(externalEstimateLogStates.remoteTaskId, target.remoteTaskId),
            ),
          )
          .limit(1)
          .get();
        if (claimedElsewhere) {
          throw new ConflictError(
            'The legacy estimate history was already assigned to a project.',
            {
              provider: target.provider,
              remoteScopeKey: target.remoteScopeKey,
              remoteTaskId: target.remoteTaskId,
            },
          );
        }
        throw new NotFoundError('Unassigned external estimate log state');
      }
      this.assertExpectedRevision(legacyRow, data.expectedRevision, legacy);
      if (this.getRow(target)) {
        throw new ConflictError(
          'The project already has an estimate checkpoint for this remote task.',
          {
            projectId: target.projectId,
            provider: target.provider,
            remoteScopeKey: target.remoteScopeKey,
            remoteTaskId: target.remoteTaskId,
          },
        );
      }
      const now = new Date().toISOString();
      try {
        // The revision predicate is the race fence: a concurrent winner
        // leaves zero matching rows and this claim fails closed below.
        const moved = this.db
          .update(externalEstimateLogStates)
          .set({ projectId: target.projectId, updatedAt: now })
          .where(
            and(
              this.identityPredicate(legacy),
              eq(externalEstimateLogStates.revision, data.expectedRevision),
            ),
          )
          .run();
        if (moved.changes !== 1) {
          throw new ConflictError(
            'The legacy estimate history was already assigned to a project.',
            {
              provider: target.provider,
              remoteScopeKey: target.remoteScopeKey,
              remoteTaskId: target.remoteTaskId,
            },
          );
        }
        this.db
          .update(externalEstimateLogDays)
          .set({ projectId: target.projectId, updatedAt: now })
          .where(this.dayPredicate(legacy))
          .run();
      } catch (error) {
        if (isSqliteUniqueConstraint(error)) {
          throw new ConflictError(
            'The project already has estimate history for this remote task.',
            {
              projectId: target.projectId,
              provider: target.provider,
              remoteScopeKey: target.remoteScopeKey,
              remoteTaskId: target.remoteTaskId,
            },
          );
        }
        throw error;
      }
      const moved = this.getRow(target);
      if (!moved) {
        throw new StorageError('Legacy estimate ownership assignment lost its state row.');
      }
      return this.buildDailyCheckpoint(moved, target);
    });
  }

  async setLoggedMinutes(
    data: SetExternalEstimateLoggedMinutes,
  ): Promise<ExternalEstimateLogState> {
    const normalized = this.normalizeIdentity(data);
    this.requireNonnegativeInteger(data.loggedMinutes, 'Logged minutes');
    this.requireExpectedRevision(data.expectedRevision);
    const aggregationTimeZone =
      data.aggregationTimeZone === null
        ? null
        : this.requireAggregationZone(data.aggregationTimeZone);
    const currentTotals = this.requireDailyTotals(data.currentDailyTotals, 'Current daily totals');

    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.assertCurrentLink(normalized);
      const existing = this.getRow(normalized);
      this.assertExpectedRevision(existing, data.expectedRevision, normalized);
      if (existing?.pendingOperationId) {
        throw new ConflictError('Estimate log state has a pending operation.', {
          operationId: existing.pendingOperationId,
        });
      }
      // Set logged rebuilds a valid checkpoint; it must never double as an
      // implicit corruption repair. The pre-existing ledger is checked
      // before any write so a violating checkpoint stays untouched.
      this.assertDaysWithinScalar(normalized, existing?.loggedMinutes ?? 0);

      const now = new Date().toISOString();
      const boundZone = aggregationTimeZone ?? existing?.aggregationTimeZone ?? null;
      if (!existing) {
        this.db
          .insert(externalEstimateLogStates)
          .values({
            ...normalized,
            loggedMinutes: data.loggedMinutes,
            revision: 1,
            aggregationTimeZone: boundZone,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      } else {
        this.updateByRevision(normalized, existing.revision, {
          loggedMinutes: data.loggedMinutes,
          aggregationTimeZone: boundZone,
          revision: existing.revision + 1,
          updatedAt: now,
        });
      }
      // Set logged rebuilds the dated baseline wholesale: the old rows must
      // never survive a correction that rewrites the scalar they roll up to.
      this.clearDays(normalized);
      const currentTotal = currentTotals.reduce((total, day) => total + day.minutes, 0);
      const placements = this.computeCreditPlacements(
        Math.min(data.loggedMinutes, currentTotal),
        currentTotals,
        [],
      );
      this.applyDayPlacements(normalized, placements, now);
      return this.requireState(normalized);
    });
  }

  async prepare(data: PrepareExternalEstimateLogOperation): Promise<ExternalEstimateLogState> {
    const normalized = this.normalizeIdentity(data);
    const operationId = this.requireOperationId(data.operationId);
    this.requireExpectedRevision(data.expectedRevision);
    const activityDate =
      data.activityDate === null ? null : this.requireActivityDate(data.activityDate);
    const aggregationTimeZone =
      data.aggregationTimeZone === null
        ? null
        : this.requireAggregationZone(data.aggregationTimeZone);
    const capturedTotals = this.requireDailyTotals(
      data.capturedDailyTotals,
      'Captured daily totals',
    );

    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.requirePositiveDelta(data.deltaMinutes);
      this.requireNonnegativeInteger(data.estimateTotalMinutes, 'Estimate total minutes');
      const startedAt = this.requireTimestamp(data.startedAt);
      const connectionId = this.requireIdentifier(data.connectionId, 'Connection');
      this.requirePositiveInteger(data.connectionGeneration, 'Connection generation');
      this.assertCurrentLink(normalized);
      this.assertConnectionEpoch(normalized.provider, connectionId, data.connectionGeneration);

      const existing = this.getRow(normalized);
      this.assertExpectedRevision(existing, data.expectedRevision, normalized);
      if (existing?.pendingOperationId) {
        throw new ConflictError('Estimate log state has a pending operation.', {
          operationId: existing.pendingOperationId,
        });
      }

      const now = new Date().toISOString();
      // Remaining scalar credit materializes oldest-first into the captured
      // buckets before the pending row exists — same placement rule as the
      // shared daily allocator, so the persisted ledger matches the preview.
      // loggedMinutes is untouched; excess credit stays unallocated.
      const existingDays = this.listDayRows(normalized);
      const daySum = existingDays.reduce((total, day) => total + day.loggedMinutes, 0);
      const creditMinutes = Math.max(0, (existing?.loggedMinutes ?? 0) - daySum);
      const placements = this.computeCreditPlacements(creditMinutes, capturedTotals, existingDays);
      this.applyDayPlacements(normalized, placements, now);

      const boundZone = aggregationTimeZone ?? existing?.aggregationTimeZone ?? null;
      const pending = {
        pendingOperationId: operationId,
        pendingDeltaMinutes: data.deltaMinutes,
        pendingEstimateTotalMinutes: data.estimateTotalMinutes,
        pendingStartedAt: startedAt,
        pendingConnectionId: connectionId,
        pendingConnectionGeneration: data.connectionGeneration,
        pendingPhase: 'prepared' as const,
        pendingResolution: null,
        pendingActivityDate: activityDate,
      };
      if (!existing) {
        this.db
          .insert(externalEstimateLogStates)
          .values({
            ...normalized,
            loggedMinutes: 0,
            revision: 1,
            aggregationTimeZone: boundZone,
            ...pending,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      } else {
        this.updateByRevision(normalized, existing.revision, {
          ...pending,
          aggregationTimeZone: boundZone,
          revision: existing.revision + 1,
          updatedAt: now,
        });
      }
      return this.requireState(normalized);
    });
  }

  async markOutcomeUnknown(
    data: ExternalEstimateLogOperationMutation,
  ): Promise<ExternalEstimateLogState> {
    const normalized = this.normalizeIdentity(data);
    const operationId = this.requireOperationId(data.operationId);
    this.requireExpectedRevision(data.expectedRevision);

    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.assertCurrentLink(normalized);
      const state = this.requirePending(normalized, operationId);
      this.assertExpectedRevision(state, data.expectedRevision, normalized);
      if (state.pendingPhase === 'outcome_unknown') {
        return this.mapState(state);
      }
      this.updateByRevision(normalized, state.revision, {
        pendingPhase: 'outcome_unknown',
        revision: state.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      return this.requireState(normalized);
    });
  }

  async confirm(data: ExternalEstimateLogOperationMutation): Promise<ExternalEstimateLogState> {
    return this.settle(data, 'logged');
  }

  async clear(data: ExternalEstimateLogOperationMutation): Promise<ExternalEstimateLogState> {
    return this.settle(data, 'not_logged');
  }

  async storeResolution(
    data: StoreExternalEstimateLogResolution,
  ): Promise<ExternalEstimateLogState> {
    const normalized = this.normalizeIdentity(data);
    const operationId = this.requireOperationId(data.operationId);
    this.requireExpectedRevision(data.expectedRevision);
    if (data.resolution !== 'logged' && data.resolution !== 'not_logged') {
      throw new ValidationError('Estimate operation resolution is invalid.');
    }

    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.assertCurrentLink(normalized);
      const state = this.requirePending(normalized, operationId);
      this.assertExpectedRevision(state, data.expectedRevision, normalized);
      if (state.pendingResolution === data.resolution) {
        return this.mapState(state);
      }
      if (state.pendingResolution !== null) {
        throw new ConflictError('Estimate operation already has a different resolution.', {
          operationId,
        });
      }
      this.updateByRevision(normalized, state.revision, {
        pendingResolution: data.resolution,
        revision: state.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      return this.requireState(normalized);
    });
  }

  async applyResolution(
    data: ExternalEstimateLogOperationMutation,
  ): Promise<ExternalEstimateLogState> {
    const normalized = this.normalizeIdentity(data);
    const operationId = this.requireOperationId(data.operationId);
    this.requireExpectedRevision(data.expectedRevision);

    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.assertCurrentLink(normalized);
      const state = this.requireState(normalized);
      if (state.pendingOperationId === null) {
        return state;
      }
      if (state.pendingOperationId !== operationId) {
        throw new ConflictError('A different estimate operation is pending.', {
          operationId: state.pendingOperationId,
        });
      }
      this.assertExpectedRevision(state, data.expectedRevision, normalized);
      if (state.pendingResolution === null) {
        throw new ConflictError('Estimate operation has no stored resolution.', { operationId });
      }
      return this.applySettlement(normalized, state, state.pendingResolution === 'logged');
    });
  }

  private settle(
    data: ExternalEstimateLogOperationMutation,
    resolution: 'logged' | 'not_logged',
  ): Promise<ExternalEstimateLogState> {
    const normalized = this.normalizeIdentity(data);
    const operationId = this.requireOperationId(data.operationId);
    this.requireExpectedRevision(data.expectedRevision);

    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.assertCurrentLink(normalized);
      const state = this.requireState(normalized);
      if (state.pendingOperationId === null) {
        return state;
      }
      if (state.pendingOperationId !== operationId) {
        throw new ConflictError('A different estimate operation is pending.', {
          operationId: state.pendingOperationId,
        });
      }
      this.assertExpectedRevision(state, data.expectedRevision, normalized);
      // confirm/clear carry exact provider truth. A stored manual resolution
      // is only a fallback and cannot veto later terminal evidence.
      return this.applySettlement(normalized, state, resolution === 'logged');
    });
  }

  private applySettlement(
    identity: ExternalEstimateLogIdentity,
    state: Extract<ExternalEstimateLogState, { pendingOperationId: string }>,
    addDelta: boolean,
  ): ExternalEstimateLogState {
    const nextLoggedMinutes = addDelta
      ? state.loggedMinutes + state.pendingDeltaMinutes
      : state.loggedMinutes;
    if (!Number.isSafeInteger(nextLoggedMinutes)) {
      throw new ValidationError('Logged minutes exceed the supported numeric range.');
    }
    const now = new Date().toISOString();
    this.updateByRevision(identity, state.revision, {
      loggedMinutes: nextLoggedMinutes,
      revision: state.revision + 1,
      pendingOperationId: null,
      pendingDeltaMinutes: null,
      pendingEstimateTotalMinutes: null,
      pendingStartedAt: null,
      pendingConnectionId: null,
      pendingConnectionGeneration: null,
      pendingPhase: null,
      pendingResolution: null,
      pendingActivityDate: null,
      updatedAt: now,
    });
    // A dated confirm or Mark-logged settles the date row and the scalar in
    // this one queued transaction; legacy null-date operations and
    // not-logged settlements touch the ledger not at all.
    if (addDelta && state.pendingActivityDate !== null) {
      this.upsertDayIncrement(identity, state.pendingActivityDate, state.pendingDeltaMinutes, now);
    }
    return this.requireState(identity);
  }

  private listDayRows(identity: ExternalEstimateLogIdentity): ExternalEstimateLogDay[] {
    return this.db
      .select({
        projectId: externalEstimateLogDays.projectId,
        provider: externalEstimateLogDays.provider,
        remoteScopeKey: externalEstimateLogDays.remoteScopeKey,
        remoteTaskId: externalEstimateLogDays.remoteTaskId,
        activityDate: externalEstimateLogDays.activityDate,
        loggedMinutes: externalEstimateLogDays.loggedMinutes,
      })
      .from(externalEstimateLogDays)
      .where(this.dayPredicate(identity))
      .orderBy(asc(externalEstimateLogDays.activityDate))
      .all();
  }

  /** Sync core shared by reads and the synchronous assignment transaction. */
  private buildDailyCheckpoint(
    row: EstimateStateRow,
    identity: ExternalEstimateLogIdentity,
  ): ExternalEstimateLogDailyCheckpoint {
    const days = this.listDayRows(identity);
    if (days.length > MAX_DAILY_LEDGER_ROWS) {
      throw new StorageError(
        `External estimate log dated ledger exceeds ${MAX_DAILY_LEDGER_ROWS} rows.`,
      );
    }
    const daySum = days.reduce((total, day) => total + day.loggedMinutes, 0);
    if (daySum > row.loggedMinutes) {
      throw this.ledgerExceedsScalar();
    }
    return {
      state: this.mapState(row),
      days,
      unallocatedLoggedMinutes: row.loggedMinutes - daySum,
    };
  }

  private sumDayMinutes(identity: ExternalEstimateLogIdentity): number {
    const row = this.rawClient
      .prepare(
        `SELECT COALESCE(SUM(logged_minutes), 0) AS total
         FROM external_estimate_log_days
         WHERE project_id = ? AND provider = ? AND remote_scope_key = ? AND remote_task_id = ?`,
      )
      .get(
        identity.projectId,
        identity.provider,
        identity.remoteScopeKey,
        identity.remoteTaskId,
      ) as {
      total: number;
    };
    return row.total;
  }

  private assertDaysWithinScalar(
    identity: ExternalEstimateLogIdentity,
    loggedMinutes: number,
  ): void {
    if (this.sumDayMinutes(identity) > loggedMinutes) {
      throw this.ledgerExceedsScalar();
    }
  }

  private ledgerExceedsScalar(): StorageError {
    return new StorageError('External estimate log dated ledger exceeds the scalar checkpoint.');
  }

  private clearDays(identity: ExternalEstimateLogIdentity): void {
    this.db.delete(externalEstimateLogDays).where(this.dayPredicate(identity)).run();
  }

  private upsertDayIncrement(
    identity: ExternalEstimateLogIdentity,
    activityDate: string,
    minutes: number,
    now: string,
  ): void {
    this.rawClient
      .prepare(UPSERT_DAY_SQL)
      .run(
        identity.projectId,
        identity.provider,
        identity.remoteScopeKey,
        identity.remoteTaskId,
        activityDate,
        minutes,
        now,
        now,
      );
  }

  private applyDayPlacements(
    identity: ExternalEstimateLogIdentity,
    placements: ReadonlyArray<ExternalEstimateDailyTotal>,
    now: string,
  ): void {
    for (const placement of placements) {
      this.upsertDayIncrement(identity, placement.activityDate, placement.minutes, now);
    }
  }

  /**
   * Oldest-first placement of scalar credit into daily buckets, capped by
   * each date's uncovered minutes so persisted dated credit never moves or
   * double-covers. Mirrors the shared daily allocator's materialization.
   */
  private computeCreditPlacements(
    creditMinutes: number,
    dailyTotals: ReadonlyArray<ExternalEstimateDailyTotal>,
    existingDays: ReadonlyArray<ExternalEstimateLogDay>,
  ): Array<ExternalEstimateDailyTotal> {
    const coveredByDate = new Map(existingDays.map((day) => [day.activityDate, day.loggedMinutes]));
    let remainingMinutes = creditMinutes;
    const placements: ExternalEstimateDailyTotal[] = [];
    for (const total of dailyTotals) {
      if (remainingMinutes <= 0) {
        break;
      }
      const covered = coveredByDate.get(total.activityDate) ?? 0;
      const uncovered = Math.max(0, total.minutes - covered);
      const placed = Math.min(remainingMinutes, uncovered);
      if (placed > 0) {
        placements.push({ activityDate: total.activityDate, minutes: placed });
        remainingMinutes -= placed;
      }
    }
    return placements;
  }

  private dayPredicate(identity: ExternalEstimateLogIdentity) {
    return and(
      eq(externalEstimateLogDays.projectId, identity.projectId),
      eq(externalEstimateLogDays.provider, identity.provider),
      eq(externalEstimateLogDays.remoteScopeKey, identity.remoteScopeKey),
      eq(externalEstimateLogDays.remoteTaskId, identity.remoteTaskId),
    )!;
  }

  private requireDailyTotals(
    entries: ReadonlyArray<ExternalEstimateDailyTotal>,
    label: string,
  ): ExternalEstimateDailyTotal[] {
    const totalsByDate = new Map<string, number>();
    for (const entry of entries ?? []) {
      const activityDate = this.requireActivityDate(entry?.activityDate, label);
      if (!Number.isSafeInteger(entry?.minutes) || entry.minutes < 0) {
        throw new ValidationError(`${label} minutes must be nonnegative whole numbers.`);
      }
      totalsByDate.set(activityDate, (totalsByDate.get(activityDate) ?? 0) + entry.minutes);
    }
    if (totalsByDate.size > MAX_DAILY_LEDGER_ROWS) {
      throw new ValidationError(
        `${label} may carry at most ${MAX_DAILY_LEDGER_ROWS} unique activity dates.`,
      );
    }
    return [...totalsByDate.entries()]
      .map(([activityDate, minutes]) => ({ activityDate, minutes }))
      .sort((left, right) => left.activityDate.localeCompare(right.activityDate));
  }

  private requireActivityDate(value: string, label = 'Daily totals'): string {
    const normalized = value?.trim();
    if (!normalized || !ACTIVITY_DATE_PATTERN.test(normalized)) {
      throw new ValidationError(`${label} activity date is invalid.`);
    }
    const [year, month, day] = normalized.split('-').map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (
      calendar.getUTCFullYear() !== year ||
      calendar.getUTCMonth() !== month - 1 ||
      calendar.getUTCDate() !== day
    ) {
      throw new ValidationError(`${label} activity date is invalid.`);
    }
    return normalized;
  }

  private requireAggregationZone(value: string): string {
    const normalized = value?.trim();
    if (!normalized || normalized.length > MAX_ZONE_LENGTH) {
      throw new ValidationError('Aggregation time zone is invalid.');
    }
    return normalized;
  }

  private getRow(identity: ExternalEstimateLogIdentity): EstimateStateRow | undefined {
    return this.db
      .select()
      .from(externalEstimateLogStates)
      .where(this.identityPredicate(identity))
      .limit(1)
      .get();
  }

  private requireState(identity: ExternalEstimateLogIdentity): ExternalEstimateLogState {
    const row = this.getRow(identity);
    if (!row) {
      throw new NotFoundError('External estimate log state');
    }
    this.assertDaysWithinScalar(identity, row.loggedMinutes);
    return this.mapState(row);
  }

  private requirePending(
    identity: ExternalEstimateLogIdentity,
    operationId: string,
  ): PendingEstimateStateRow {
    const state = this.getRow(identity);
    if (!state) {
      throw new NotFoundError('External estimate log state');
    }
    if (state.pendingOperationId === null) {
      throw new ConflictError('Estimate log state has no pending operation.');
    }
    if (state.pendingOperationId !== operationId) {
      throw new ConflictError('A different estimate operation is pending.', {
        operationId: state.pendingOperationId,
      });
    }
    return state as PendingEstimateStateRow;
  }

  private updateByRevision(
    identity: ExternalEstimateLogIdentity,
    revision: number,
    values: Partial<typeof externalEstimateLogStates.$inferInsert>,
  ): void {
    const result = this.db
      .update(externalEstimateLogStates)
      .set(values)
      .where(
        and(this.identityPredicate(identity), eq(externalEstimateLogStates.revision, revision)),
      )
      .run();
    if (result.changes !== 1) {
      throw this.optimisticLock(identity, revision);
    }
  }

  private assertCurrentLink(identity: ExternalEstimateLogIdentity): void {
    const row = this.db
      .select({ remoteTaskId: externalTaskLinks.remoteTaskId })
      .from(externalTaskLinks)
      .where(
        and(
          eq(externalTaskLinks.projectId, identity.projectId),
          eq(externalTaskLinks.provider, identity.provider),
          eq(externalTaskLinks.remoteScopeKey, identity.remoteScopeKey),
          eq(externalTaskLinks.remoteTaskId, identity.remoteTaskId),
        ),
      )
      .limit(1)
      .get();
    if (!row) {
      throw new NotFoundError('Current external task link');
    }
  }

  private assertConnectionEpoch(
    provider: ExternalEstimateLogIdentity['provider'],
    connectionId: string,
    generation: number,
    options?: { projectId?: string },
  ): void {
    const epochPredicate = and(
      eq(integrationConnections.id, connectionId),
      eq(integrationConnections.provider, provider),
      eq(integrationConnections.generation, generation),
      ...(options?.projectId ? [eq(integrationConnections.projectId, options.projectId)] : []),
    );
    const connection = this.db
      .select({ id: integrationConnections.id })
      .from(integrationConnections)
      .where(epochPredicate)
      .limit(1)
      .get();
    if (!connection) {
      throw new ConflictError('Integration connection epoch is stale.');
    }
  }

  private identityPredicate(identity: ExternalEstimateLogIdentity) {
    return and(
      eq(externalEstimateLogStates.projectId, identity.projectId),
      eq(externalEstimateLogStates.provider, identity.provider),
      eq(externalEstimateLogStates.remoteScopeKey, identity.remoteScopeKey),
      eq(externalEstimateLogStates.remoteTaskId, identity.remoteTaskId),
    )!;
  }

  private assertExpectedRevision(
    state: Pick<EstimateStateRow, 'revision'> | null | undefined,
    expectedRevision: number,
    identity: ExternalEstimateLogIdentity,
  ): void {
    const actualRevision = state?.revision ?? 0;
    if (actualRevision !== expectedRevision) {
      throw this.optimisticLock(identity, expectedRevision, actualRevision);
    }
  }

  private optimisticLock(
    identity: ExternalEstimateLogIdentity,
    expectedRevision: number,
    actualRevision?: number,
  ): OptimisticLockError {
    return new OptimisticLockError(
      'External estimate log state',
      `${identity.projectId}:${identity.provider}:${identity.remoteScopeKey}:${identity.remoteTaskId}`,
      { expectedRevision, ...(actualRevision === undefined ? {} : { actualRevision }) },
    );
  }

  private normalizeIdentity(identity: ExternalEstimateLogIdentity): ExternalEstimateLogIdentity {
    const projectId = this.requireIdentifier(identity.projectId, 'Project');
    if (projectId === LEGACY_UNASSIGNED_PROJECT_ID) {
      throw new ValidationError(
        'The reserved legacy project identity cannot be used for ordinary checkpoint access.',
      );
    }
    return {
      projectId,
      provider: this.requireProvider(identity.provider),
      remoteScopeKey: this.requireIdentifier(identity.remoteScopeKey, 'Remote scope'),
      remoteTaskId: this.requireIdentifier(identity.remoteTaskId, 'Remote task'),
    };
  }

  /** Reserved-owner variant used only by the dedicated unassigned read and assignment. */
  private normalizeUnassignedIdentity(
    provider: ExternalEstimateLogIdentity['provider'],
    remoteScopeKey: string,
    remoteTaskId: string,
  ): ExternalEstimateLogIdentity {
    const normalizedProvider = this.requireProvider(provider);
    return {
      projectId: LEGACY_UNASSIGNED_PROJECT_ID,
      provider: normalizedProvider,
      remoteScopeKey: this.requireIdentifier(remoteScopeKey, 'Remote scope'),
      remoteTaskId: this.requireIdentifier(remoteTaskId, 'Remote task'),
    };
  }

  private requireProvider(provider: ExternalEstimateLogIdentity['provider']): IntegrationProvider {
    if (provider !== 'clickup' && provider !== 'jira') {
      throw new ValidationError('Integration provider is invalid.');
    }
    return provider;
  }

  private requireIdentifier(value: string, label: string): string {
    const normalized = value?.trim();
    if (!normalized) {
      throw new ValidationError(`${label} identifier is required.`);
    }
    return normalized;
  }

  private requireOperationId(value: string): string {
    const normalized = value?.trim();
    if (!normalized || !OPERATION_ID_PATTERN.test(normalized)) {
      throw new ValidationError('Estimate operation ID is invalid.');
    }
    return normalized;
  }

  private requireExpectedRevision(value: number): void {
    this.requireNonnegativeInteger(value, 'Expected revision');
  }

  private requireNonnegativeInteger(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError(`${label} must be a nonnegative whole number.`);
    }
  }

  private requirePositiveInteger(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ValidationError(`${label} must be a positive whole number.`);
    }
  }

  private requirePositiveDelta(deltaMinutes: number): void {
    if (!Number.isSafeInteger(deltaMinutes) || deltaMinutes === 0) {
      throw new ValidationError('Estimate delta must be a nonzero whole number.');
    }
    if (deltaMinutes < 0) {
      throw new ValidationError('Estimate delta must be positive.');
    }
    if (deltaMinutes * 60_000 > MAX_TIME_ENTRY_DURATION_MS) {
      throw new ValidationError('Estimate delta exceeds the maximum time-entry duration.');
    }
  }

  private requireTimestamp(value: string): string {
    const normalized = value?.trim();
    if (!normalized || !Number.isFinite(Date.parse(normalized))) {
      throw new ValidationError('Estimate operation start time is invalid.');
    }
    return normalized;
  }

  private mapState(row: EstimateStateRow): ExternalEstimateLogState {
    const common = {
      projectId: row.projectId,
      provider: row.provider,
      remoteScopeKey: row.remoteScopeKey,
      remoteTaskId: row.remoteTaskId,
      loggedMinutes: row.loggedMinutes,
      revision: row.revision,
      aggregationTimeZone: row.aggregationTimeZone,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (row.pendingOperationId === null) {
      if (
        row.pendingDeltaMinutes !== null ||
        row.pendingEstimateTotalMinutes !== null ||
        row.pendingStartedAt !== null ||
        row.pendingConnectionId !== null ||
        row.pendingConnectionGeneration !== null ||
        row.pendingPhase !== null ||
        row.pendingResolution !== null ||
        row.pendingActivityDate !== null
      ) {
        throw new StorageError('External estimate log state has incomplete pending fields.');
      }
      return {
        ...common,
        pendingOperationId: null,
        pendingDeltaMinutes: null,
        pendingEstimateTotalMinutes: null,
        pendingStartedAt: null,
        pendingConnectionId: null,
        pendingConnectionGeneration: null,
        pendingPhase: null,
        pendingResolution: null,
        pendingActivityDate: null,
      };
    }
    if (
      row.pendingDeltaMinutes === null ||
      row.pendingEstimateTotalMinutes === null ||
      row.pendingStartedAt === null ||
      row.pendingConnectionId === null ||
      row.pendingConnectionGeneration === null ||
      row.pendingPhase === null
    ) {
      throw new StorageError('External estimate log state has incomplete pending fields.');
    }
    return {
      ...common,
      pendingOperationId: row.pendingOperationId,
      pendingDeltaMinutes: row.pendingDeltaMinutes,
      pendingEstimateTotalMinutes: row.pendingEstimateTotalMinutes,
      pendingStartedAt: row.pendingStartedAt,
      pendingConnectionId: row.pendingConnectionId,
      pendingConnectionGeneration: row.pendingConnectionGeneration,
      pendingPhase: row.pendingPhase,
      pendingResolution: row.pendingResolution,
      pendingActivityDate: row.pendingActivityDate,
    };
  }
}
