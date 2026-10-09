import type {
  ScheduledEpicStorage,
  ListResult,
  ListScheduledEpicsOptions,
  ListScheduledEpicRunsOptions,
  ClaimRunResult,
  UpdateScheduledEpicOptions,
} from '../../interfaces/storage.interface';
import type {
  ScheduledEpic,
  CreateScheduledEpic,
  UpdateScheduledEpic,
  UpdateScheduledEpicRuntimeState,
  ScheduledEpicRun,
  CreateScheduledEpicRun,
  UpdateScheduledEpicRun,
} from '../../models/domain.models';
import { and as andSync, eq as eqSync } from 'drizzle-orm';
import {
  NotFoundError,
  ConflictError,
  OptimisticLockError,
} from '../../../../common/errors/error-types';
import { scheduledEpics as scheduledEpicsTable } from '../../db/schema';
import { normalizeListOptions } from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

export class ScheduledEpicStorageDelegate
  extends BaseStorageDelegate
  implements ScheduledEpicStorage
{
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  private mapScheduledEpicRow(row: Record<string, unknown>): ScheduledEpic {
    return {
      ...(row as unknown as ScheduledEpic),
      templateTags: (row.templateTags as string[] | null) ?? [],
    };
  }

  private mapScheduledEpicRunRow(row: Record<string, unknown>): ScheduledEpicRun {
    return row as unknown as ScheduledEpicRun;
  }

  async createScheduledEpic(data: CreateScheduledEpic): Promise<ScheduledEpic> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { scheduledEpics } = await import('../../db/schema');

    const id = randomUUID();
    const record: ScheduledEpic = {
      id,
      projectId: data.projectId,
      name: data.name,
      cronExpression: data.cronExpression,
      timezone: data.timezone,
      enabled: data.enabled,
      titleTemplate: data.titleTemplate,
      descriptionTemplate: data.descriptionTemplate,
      templateStatusId: data.templateStatusId,
      templateParentEpicId: data.templateParentEpicId,
      templateAgentId: data.templateAgentId,
      templateTags: data.templateTags,
      allowOverlap: data.allowOverlap,
      missedRunPolicy: data.missedRunPolicy,
      configVersion: 1,
      nextRunAt: data.nextRunAt ?? null,
      lastRunAt: null,
      lastRunStatus: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(scheduledEpics).values({
      id: record.id,
      projectId: record.projectId,
      name: record.name,
      cronExpression: record.cronExpression,
      timezone: record.timezone,
      enabled: record.enabled,
      titleTemplate: record.titleTemplate,
      descriptionTemplate: record.descriptionTemplate,
      templateStatusId: record.templateStatusId,
      templateParentEpicId: record.templateParentEpicId,
      templateAgentId: record.templateAgentId,
      templateTags: record.templateTags,
      allowOverlap: record.allowOverlap,
      missedRunPolicy: record.missedRunPolicy,
      configVersion: record.configVersion,
      nextRunAt: record.nextRunAt,
      lastRunAt: record.lastRunAt,
      lastRunStatus: record.lastRunStatus,
      lastError: record.lastError,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });

    return record;
  }

  async getScheduledEpic(id: string): Promise<ScheduledEpic> {
    return this.getScheduledEpicSync(id);
  }

  private getScheduledEpicSync(id: string): ScheduledEpic {
    const row = this.db
      .select()
      .from(scheduledEpicsTable)
      .where(eqSync(scheduledEpicsTable.id, id))
      .limit(1)
      .get();

    if (!row) {
      throw new NotFoundError('ScheduledEpic', id);
    }

    return this.mapScheduledEpicRow(row as unknown as Record<string, unknown>);
  }

  async listScheduledEpics(
    projectId: string,
    options: ListScheduledEpicsOptions = {},
  ): Promise<ListResult<ScheduledEpic>> {
    const { scheduledEpics } = await import('../../db/schema');
    const { eq, and, count } = await import('drizzle-orm');

    const { limit, offset } = normalizeListOptions(options);

    const conditions = [eq(scheduledEpics.projectId, projectId)];
    if (options.enabled !== undefined) {
      conditions.push(eq(scheduledEpics.enabled, options.enabled));
    }
    const where = conditions.length === 1 ? conditions[0]! : and(...conditions)!;

    const [rows, totalResult] = await Promise.all([
      this.db
        .select()
        .from(scheduledEpics)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(scheduledEpics.createdAt),
      this.db.select({ count: count() }).from(scheduledEpics).where(where),
    ]);

    return {
      items: rows.map((r) => this.mapScheduledEpicRow(r as unknown as Record<string, unknown>)),
      total: totalResult[0]?.count ?? 0,
      limit,
      offset,
    };
  }

  async updateScheduledEpic(
    id: string,
    data: UpdateScheduledEpic,
    expectedVersion: number,
    options?: UpdateScheduledEpicOptions,
  ): Promise<ScheduledEpic> {
    try {
      return await this.versionedMutationExecutor.execute({
        resource: 'ScheduledEpic',
        id,
        expectedVersion,
        loadCurrent: () => this.getScheduledEpicSync(id),
        versionOf: (current) => current.configVersion,
        prepare: () => ({
          kind: 'write',
          state: {
            updateData: {
              ...data,
              ...(options?.derivedRuntimeState ?? {}),
            },
            now: new Date().toISOString(),
          },
        }),
        write: (context, state) =>
          this.db
            .update(scheduledEpicsTable)
            .set({
              ...state.updateData,
              configVersion: context.nextVersion,
              updatedAt: state.now,
            })
            .where(
              andSync(
                eqSync(scheduledEpicsTable.id, id),
                eqSync(scheduledEpicsTable.configVersion, context.actualVersion),
              ),
            )
            .run().changes,
        loadResult: () => this.getScheduledEpicSync(id),
      });
    } catch (error) {
      if (error instanceof OptimisticLockError) {
        const currentVersion = error.details?.actualVersion;
        if (typeof currentVersion === 'number') {
          throw this.scheduledEpicConflict(id, expectedVersion, currentVersion);
        }
      }
      throw error;
    }
  }

  private scheduledEpicConflict(
    id: string,
    expectedVersion: number,
    currentVersion: number,
  ): ConflictError {
    return new ConflictError(
      `ScheduledEpic version conflict: expected ${expectedVersion}, current ${currentVersion}`,
      { id, expectedVersion, currentVersion },
    );
  }

  async deleteScheduledEpic(id: string): Promise<void> {
    const { scheduledEpics } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(scheduledEpics).where(eq(scheduledEpics.id, id));
  }

  async updateScheduledEpicRuntimeState(
    id: string,
    data: UpdateScheduledEpicRuntimeState,
  ): Promise<ScheduledEpic> {
    const { scheduledEpics } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    await this.getScheduledEpic(id);

    await this.db
      .update(scheduledEpics)
      .set({ ...data, updatedAt: now })
      .where(eq(scheduledEpics.id, id));

    return this.getScheduledEpic(id);
  }

  async listDueScheduledEpics(projectId: string, before: string): Promise<ScheduledEpic[]> {
    const { scheduledEpics } = await import('../../db/schema');
    const { eq, and, lte } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(scheduledEpics)
      .where(
        and(
          eq(scheduledEpics.projectId, projectId),
          eq(scheduledEpics.enabled, true),
          lte(scheduledEpics.nextRunAt, before),
        ),
      )
      .orderBy(scheduledEpics.nextRunAt);

    return rows.map((r) => this.mapScheduledEpicRow(r as unknown as Record<string, unknown>));
  }

  async createScheduledEpicRun(data: CreateScheduledEpicRun): Promise<ClaimRunResult> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { scheduledEpicRuns } = await import('../../db/schema');
    const { eq, and } = await import('drizzle-orm');

    const id = randomUUID();
    const record: ScheduledEpicRun = {
      id,
      scheduleId: data.scheduleId,
      plannedFor: data.plannedFor,
      source: data.source,
      status: data.status,
      createdEpicId: null,
      startedAt: null,
      finishedAt: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.db.insert(scheduledEpicRuns).values({
        id: record.id,
        scheduleId: record.scheduleId,
        plannedFor: record.plannedFor,
        source: record.source,
        status: record.status,
        createdEpicId: record.createdEpicId,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        errorMessage: record.errorMessage,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
      return { claimed: true, run: record };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE constraint failed') || message.includes('SQLITE_CONSTRAINT')) {
        const existing = await this.db
          .select()
          .from(scheduledEpicRuns)
          .where(
            and(
              eq(scheduledEpicRuns.scheduleId, data.scheduleId),
              eq(scheduledEpicRuns.plannedFor, data.plannedFor),
            ),
          )
          .limit(1);

        if (existing[0]) {
          return {
            claimed: false,
            run: this.mapScheduledEpicRunRow(existing[0] as unknown as Record<string, unknown>),
          };
        }
      }
      throw error;
    }
  }

  async getScheduledEpicRun(id: string): Promise<ScheduledEpicRun> {
    const { scheduledEpicRuns } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    const result = await this.db
      .select()
      .from(scheduledEpicRuns)
      .where(eq(scheduledEpicRuns.id, id))
      .limit(1);

    if (!result[0]) {
      throw new NotFoundError('ScheduledEpicRun', id);
    }

    return this.mapScheduledEpicRunRow(result[0] as unknown as Record<string, unknown>);
  }

  async listScheduledEpicRuns(
    scheduleId: string,
    options: ListScheduledEpicRunsOptions = {},
  ): Promise<ListResult<ScheduledEpicRun>> {
    const { scheduledEpicRuns } = await import('../../db/schema');
    const { eq, and, count, desc } = await import('drizzle-orm');

    const { limit, offset } = normalizeListOptions(options);

    const conditions = [eq(scheduledEpicRuns.scheduleId, scheduleId)];
    if (options.status) {
      conditions.push(eq(scheduledEpicRuns.status, options.status));
    }
    const where = conditions.length === 1 ? conditions[0]! : and(...conditions)!;

    const [rows, totalResult] = await Promise.all([
      this.db
        .select()
        .from(scheduledEpicRuns)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(desc(scheduledEpicRuns.plannedFor)),
      this.db.select({ count: count() }).from(scheduledEpicRuns).where(where),
    ]);

    return {
      items: rows.map((r) => this.mapScheduledEpicRunRow(r as unknown as Record<string, unknown>)),
      total: totalResult[0]?.count ?? 0,
      limit,
      offset,
    };
  }

  async claimScheduledEpicRun(runId: string): Promise<ClaimRunResult> {
    const { scheduledEpicRuns } = await import('../../db/schema');
    const { eq, and } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const result = this.txRunner.runImmediate(() => {
      const rows = this.db
        .select()
        .from(scheduledEpicRuns)
        .where(eq(scheduledEpicRuns.id, runId))
        .limit(1)
        .all();

      if (!rows[0]) {
        throw new NotFoundError('ScheduledEpicRun', runId);
      }

      if (rows[0].status !== 'pending') {
        return {
          claimed: false,
          run: this.mapScheduledEpicRunRow(rows[0] as unknown as Record<string, unknown>),
        };
      }

      this.db
        .update(scheduledEpicRuns)
        .set({ status: 'running', startedAt: now, updatedAt: now })
        .where(and(eq(scheduledEpicRuns.id, runId), eq(scheduledEpicRuns.status, 'pending')))
        .run();

      const updated = this.db
        .select()
        .from(scheduledEpicRuns)
        .where(eq(scheduledEpicRuns.id, runId))
        .limit(1)
        .all();

      return {
        claimed: updated[0]?.status === 'running',
        run: this.mapScheduledEpicRunRow(updated[0] as unknown as Record<string, unknown>),
      };
    });

    return result;
  }

  async updateScheduledEpicRun(
    id: string,
    data: UpdateScheduledEpicRun,
  ): Promise<ScheduledEpicRun> {
    const { scheduledEpicRuns } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    await this.getScheduledEpicRun(id);

    await this.db
      .update(scheduledEpicRuns)
      .set({ ...data, updatedAt: now })
      .where(eq(scheduledEpicRuns.id, id));

    return this.getScheduledEpicRun(id);
  }
}
