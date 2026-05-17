import type {
  ScheduledEpic,
  CreateScheduledEpic,
  UpdateScheduledEpic,
  ScheduledEpicRun,
  CreateScheduledEpicRun,
} from '../../models/domain.models';
import { NotFoundError } from '../../../../common/errors/error-types';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

export class ScheduledEpicStorageDelegate extends BaseStorageDelegate {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async listScheduledEpics(projectId: string): Promise<ScheduledEpic[]> {
    const { scheduledEpics } = await import('../../db/schema');
    const { eq, asc } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(scheduledEpics)
      .where(eq(scheduledEpics.projectId, projectId))
      .orderBy(asc(scheduledEpics.position), asc(scheduledEpics.createdAt));

    return rows.map((row) => this.mapRow(row)) as ScheduledEpic[];
  }

  async getScheduledEpic(id: string): Promise<ScheduledEpic | null> {
    const { scheduledEpics } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    const result = await this.db
      .select()
      .from(scheduledEpics)
      .where(eq(scheduledEpics.id, id))
      .limit(1);

    if (!result[0]) {
      return null;
    }

    return this.mapRow(result[0]) as ScheduledEpic;
  }

  async createScheduledEpic(data: CreateScheduledEpic): Promise<ScheduledEpic> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { scheduledEpics } = await import('../../db/schema');

    const id = randomUUID();

    await this.db.insert(scheduledEpics).values({
      id,
      projectId: data.projectId,
      name: data.name,
      description: data.description ?? null,
      enabled: data.enabled,
      cronExpression: data.cronExpression,
      timezone: data.timezone,
      lastRunAt: data.lastRunAt ?? null,
      nextRunAt: data.nextRunAt ?? null,
      templateTitle: data.templateTitle,
      templateDescription: data.templateDescription ?? null,
      templateStatusId: data.templateStatusId ?? null,
      templateAgentId: data.templateAgentId ?? null,
      templateParentId: data.templateParentId ?? null,
      templateTags: data.templateTags ?? null,
      templateSkillsRequired: data.templateSkillsRequired ?? null,
      templateData: data.templateData ?? null,
      maxOccurrences: data.maxOccurrences ?? null,
      cooldownMs: data.cooldownMs ?? 0,
      position: data.position ?? 0,
      createdAt: now,
      updatedAt: now,
    });

    const created = await this.getScheduledEpic(id);
    if (!created) {
      throw new NotFoundError('ScheduledEpic', id);
    }
    return created;
  }

  async updateScheduledEpic(id: string, data: UpdateScheduledEpic): Promise<ScheduledEpic> {
    const { scheduledEpics } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const existing = await this.getScheduledEpic(id);
    if (!existing) {
      throw new NotFoundError('ScheduledEpic', id);
    }

    await this.db
      .update(scheduledEpics)
      .set({ ...data, updatedAt: now })
      .where(eq(scheduledEpics.id, id));

    const updated = await this.getScheduledEpic(id);
    if (!updated) {
      throw new NotFoundError('ScheduledEpic', id);
    }
    return updated;
  }

  async deleteScheduledEpic(id: string): Promise<void> {
    const { scheduledEpics } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(scheduledEpics).where(eq(scheduledEpics.id, id));
  }

  async listDueScheduledEpics(): Promise<ScheduledEpic[]> {
    const { scheduledEpics } = await import('../../db/schema');
    const { eq, and, lte, isNotNull } = await import('drizzle-orm');

    const now = new Date().toISOString();

    const rows = await this.db
      .select()
      .from(scheduledEpics)
      .where(
        and(
          eq(scheduledEpics.enabled, true),
          isNotNull(scheduledEpics.nextRunAt),
          lte(scheduledEpics.nextRunAt, now),
        ),
      );

    return rows.map((row) => this.mapRow(row)) as ScheduledEpic[];
  }

  async createScheduledEpicRun(data: CreateScheduledEpicRun): Promise<ScheduledEpicRun> {
    const { randomUUID } = await import('crypto');
    const { scheduledEpicRuns } = await import('../../db/schema');

    const id = randomUUID();

    await this.db.insert(scheduledEpicRuns).values({
      id,
      scheduledEpicId: data.scheduledEpicId,
      epicId: data.epicId ?? null,
      status: data.status,
      error: data.error ?? null,
      scheduledAt: data.scheduledAt,
      executedAt: data.executedAt,
    });

    return {
      id,
      scheduledEpicId: data.scheduledEpicId,
      epicId: data.epicId ?? null,
      status: data.status,
      error: data.error ?? null,
      scheduledAt: data.scheduledAt,
      executedAt: data.executedAt,
    };
  }

  async listScheduledEpicRuns(scheduledEpicId: string): Promise<ScheduledEpicRun[]> {
    const { scheduledEpicRuns } = await import('../../db/schema');
    const { eq, desc } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(scheduledEpicRuns)
      .where(eq(scheduledEpicRuns.scheduledEpicId, scheduledEpicId))
      .orderBy(desc(scheduledEpicRuns.executedAt))
      .limit(50);

    return rows as ScheduledEpicRun[];
  }

  private mapRow(row: Record<string, unknown>): ScheduledEpic {
    return {
      ...row,
      templateTags: (row.templateTags as string[] | null) ?? null,
      templateSkillsRequired: (row.templateSkillsRequired as string[] | null) ?? null,
      templateData: (row.templateData as Record<string, unknown> | null) ?? null,
    } as ScheduledEpic;
  }
}
