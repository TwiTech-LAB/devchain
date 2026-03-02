import type { ListOptions, ListResult } from '../../interfaces/storage.interface';
import type {
  CreateEpicRecord,
  CreateTag,
  EpicRecord,
  Tag,
  UpdateEpicRecord,
} from '../../models/domain.models';
import { NotFoundError, OptimisticLockError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('RecordStorageDelegate');

export interface RecordStorageDelegateDependencies {
  createTag: (data: CreateTag) => Promise<Tag>;
  getRecord: (id: string) => Promise<EpicRecord>;
}

export class RecordStorageDelegate extends BaseStorageDelegate {
  constructor(
    context: StorageDelegateContext,
    private readonly dependencies: RecordStorageDelegateDependencies,
  ) {
    super(context);
  }

  async createRecord(data: CreateEpicRecord): Promise<EpicRecord> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { records, recordTags, tags } = await import('../../db/schema');

    const record: EpicRecord = {
      id: randomUUID(),
      ...data,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(records).values({
      id: record.id,
      epicId: record.epicId,
      type: record.type,
      data: JSON.stringify(record.data),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });

    // Add tags
    if (data.tags?.length) {
      for (const tagName of data.tags) {
        const { eq, and, or, isNull } = await import('drizzle-orm');
        // Get the epic to find its projectId
        const { epics } = await import('../../db/schema');
        const epic = await this.db.select().from(epics).where(eq(epics.id, data.epicId)).limit(1);
        const projectId = epic[0]?.projectId || null;

        let tag = await this.db
          .select()
          .from(tags)
          .where(
            and(
              eq(tags.name, tagName),
              or(eq(tags.projectId, projectId || ''), isNull(tags.projectId)),
            ),
          )
          .limit(1);

        if (!tag[0]) {
          const newTag = await this.dependencies.createTag({ projectId, name: tagName });
          tag = [newTag];
        }

        await this.db.insert(recordTags).values({
          recordId: record.id,
          tagId: tag[0].id,
          createdAt: now,
        });
      }
    }

    logger.info(
      { recordId: record.id, epicId: record.epicId, type: record.type },
      'Created record',
    );
    return record;
  }

  async getRecord(id: string): Promise<EpicRecord> {
    const { records, recordTags, tags } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    const result = await this.db.select().from(records).where(eq(records.id, id)).limit(1);
    if (!result[0]) {
      throw new NotFoundError('Record', id);
    }

    const recordTagsResult = await this.db
      .select({ tag: tags })
      .from(recordTags)
      .innerJoin(tags, eq(recordTags.tagId, tags.id))
      .where(eq(recordTags.recordId, id));

    return {
      ...result[0],
      data: result[0].data as Record<string, unknown>,
      tags: recordTagsResult.map((rt) => rt.tag.name),
    } as EpicRecord;
  }

  async listRecords(epicId: string, options: ListOptions = {}): Promise<ListResult<EpicRecord>> {
    const { records } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const items = await this.db
      .select()
      .from(records)
      .where(eq(records.epicId, epicId))
      .limit(limit)
      .offset(offset);

    const itemsWithTags = await Promise.all(
      items.map((item) => this.dependencies.getRecord(item.id)),
    );

    return {
      items: itemsWithTags,
      total: items.length,
      limit,
      offset,
    };
  }

  async updateRecord(
    id: string,
    data: UpdateEpicRecord,
    expectedVersion: number,
  ): Promise<EpicRecord> {
    const { records, recordTags, tags } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const current = await this.dependencies.getRecord(id);
    if (current.version !== expectedVersion) {
      throw new OptimisticLockError('Record', id, {
        expectedVersion,
        actualVersion: current.version,
      });
    }

    const updateData: Record<string, unknown> = {};
    if (data.data !== undefined) {
      updateData.data = JSON.stringify(data.data);
    }
    if (data.type !== undefined) {
      updateData.type = data.type;
    }

    await this.db
      .update(records)
      .set({ ...updateData, version: expectedVersion + 1, updatedAt: now })
      .where(eq(records.id, id));

    // Update tags if provided
    if (data.tags !== undefined) {
      // Delete existing tags
      await this.db.delete(recordTags).where(eq(recordTags.recordId, id));

      // Add new tags
      if (data.tags.length > 0) {
        // Get the epic to find its projectId
        const { epics } = await import('../../db/schema');
        const epic = await this.db
          .select()
          .from(epics)
          .where(eq(epics.id, current.epicId))
          .limit(1);
        const projectId = epic[0]?.projectId || null;

        for (const tagName of data.tags) {
          const { and, or, isNull } = await import('drizzle-orm');
          let tag = await this.db
            .select()
            .from(tags)
            .where(
              and(
                eq(tags.name, tagName),
                or(eq(tags.projectId, projectId || ''), isNull(tags.projectId)),
              ),
            )
            .limit(1);

          if (!tag[0]) {
            const newTag = await this.dependencies.createTag({ projectId, name: tagName });
            tag = [newTag];
          }

          await this.db.insert(recordTags).values({
            recordId: id,
            tagId: tag[0].id,
            createdAt: now,
          });
        }
      }
    }

    logger.info({ recordId: id }, 'Updated record');
    return this.dependencies.getRecord(id);
  }

  async deleteRecord(id: string): Promise<void> {
    const { records } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(records).where(eq(records.id, id));
    logger.info({ recordId: id }, 'Deleted record');
  }
}
