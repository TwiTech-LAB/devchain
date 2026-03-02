import type { ListOptions, ListResult } from '../../interfaces/storage.interface';
import type { CreateStatus, Status, UpdateStatus } from '../../models/domain.models';
import { NotFoundError } from '../../../../common/errors/error-types';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

export class StatusStorageDelegate extends BaseStorageDelegate {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async createStatus(data: CreateStatus): Promise<Status> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { statuses } = await import('../../db/schema');

    const status: Status = {
      id: randomUUID(),
      ...data,
      mcpHidden: data.mcpHidden ?? false,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(statuses).values({
      id: status.id,
      projectId: status.projectId,
      label: status.label,
      color: status.color,
      position: status.position,
      mcpHidden: status.mcpHidden,
      createdAt: status.createdAt,
      updatedAt: status.updatedAt,
    });

    return status;
  }

  async getStatus(id: string): Promise<Status> {
    const { statuses } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const result = await this.db.select().from(statuses).where(eq(statuses.id, id)).limit(1);
    if (!result[0]) {
      throw new NotFoundError('Status', id);
    }
    return result[0] as Status;
  }

  async listStatuses(projectId: string, options: ListOptions = {}): Promise<ListResult<Status>> {
    const { statuses } = await import('../../db/schema');
    const { eq, asc, sql } = await import('drizzle-orm');
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const items = await this.db
      .select()
      .from(statuses)
      .where(eq(statuses.projectId, projectId))
      .orderBy(asc(statuses.position))
      .limit(limit)
      .offset(offset);

    const totalResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(statuses)
      .where(eq(statuses.projectId, projectId));

    const total = Number(totalResult[0]?.count ?? 0);

    return {
      items: items as Status[],
      total,
      limit,
      offset,
    };
  }

  async findStatusByName(projectId: string, name: string): Promise<Status | null> {
    const normalized = name.trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    const { statuses } = await import('../../db/schema');
    const { and, eq, sql } = await import('drizzle-orm');

    const result = await this.db
      .select()
      .from(statuses)
      .where(and(eq(statuses.projectId, projectId), sql`lower(${statuses.label}) = ${normalized}`))
      .limit(1);

    return result[0] ? (result[0] as Status) : null;
  }

  async updateStatus(id: string, data: UpdateStatus): Promise<Status> {
    const { statuses } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    await this.db
      .update(statuses)
      .set({ ...data, updatedAt: now })
      .where(eq(statuses.id, id));

    return this.getStatus(id);
  }

  async deleteStatus(id: string): Promise<void> {
    const { statuses } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(statuses).where(eq(statuses.id, id));
  }
}
