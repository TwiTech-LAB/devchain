import type { RecordStorage, ListOptions, ListResult } from '../../interfaces/storage.interface';
import type {
  CreateEpicRecord,
  CreateTag,
  EpicRecord,
  Tag,
  UpdateEpicRecord,
} from '../../models/domain.models';
import { and as andSync, eq as eqSync, isNull as isNullSync, or as orSync } from 'drizzle-orm';
import { NotFoundError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import {
  epics as epicsTable,
  recordTags as recordTagsTable,
  records as recordsTable,
  tags as tagsTable,
} from '../../db/schema';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('RecordStorageDelegate');

export interface RecordStorageDelegateDependencies {
  createTag: (data: CreateTag) => Tag;
}

export class RecordStorageDelegate extends BaseStorageDelegate implements RecordStorage {
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
    return this.getRecordSync(id);
  }

  private getRecordSync(id: string): EpicRecord {
    const row = this.db
      .select()
      .from(recordsTable)
      .where(eqSync(recordsTable.id, id))
      .limit(1)
      .get();
    if (!row) {
      throw new NotFoundError('Record', id);
    }

    const recordTagsResult = this.db
      .select({ tag: tagsTable })
      .from(recordTagsTable)
      .innerJoin(tagsTable, eqSync(recordTagsTable.tagId, tagsTable.id))
      .where(eqSync(recordTagsTable.recordId, id))
      .all();

    return {
      ...row,
      data: row.data as Record<string, unknown>,
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

    const itemsWithTags = items.map((item) => this.getRecordSync(item.id));

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
    const result = await this.versionedMutationExecutor.execute({
      resource: 'Record',
      id,
      expectedVersion,
      loadCurrent: () => this.getRecordSync(id),
      versionOf: (current) => current.version,
      prepare: () => {
        const updateData: Record<string, unknown> = {};
        if (data.data !== undefined) updateData.data = JSON.stringify(data.data);
        if (data.type !== undefined) updateData.type = data.type;
        return {
          kind: 'write',
          state: { updateData, requestedTags: data.tags, now: new Date().toISOString() },
        };
      },
      write: (context, state) =>
        this.db
          .update(recordsTable)
          .set({
            ...state.updateData,
            version: context.nextVersion,
            updatedAt: state.now,
          })
          .where(
            andSync(
              eqSync(recordsTable.id, id),
              eqSync(recordsTable.version, context.actualVersion),
            ),
          )
          .run().changes,
      afterWrite: ({ current }, state) => {
        if (state.requestedTags !== undefined) {
          this.setRecordTagsSync(id, state.requestedTags, current.epicId, state.now);
        }
      },
      loadResult: () => this.getRecordSync(id),
    });

    logger.info({ recordId: id }, 'Updated record');
    return result;
  }

  private setRecordTagsSync(
    recordId: string,
    tagNames: string[],
    epicId: string,
    now: string,
  ): void {
    this.db.delete(recordTagsTable).where(eqSync(recordTagsTable.recordId, recordId)).run();

    if (tagNames.length === 0) return;

    const epic = this.db
      .select({ projectId: epicsTable.projectId })
      .from(epicsTable)
      .where(eqSync(epicsTable.id, epicId))
      .limit(1)
      .get();
    const projectId = epic?.projectId || null;

    for (const tagName of tagNames) {
      const existing = this.db
        .select()
        .from(tagsTable)
        .where(
          andSync(
            eqSync(tagsTable.name, tagName),
            orSync(eqSync(tagsTable.projectId, projectId || ''), isNullSync(tagsTable.projectId)),
          ),
        )
        .limit(1)
        .get();
      const tag = existing ?? this.dependencies.createTag({ projectId, name: tagName });

      this.db.insert(recordTagsTable).values({ recordId, tagId: tag.id, createdAt: now }).run();
    }
  }

  async deleteRecord(id: string): Promise<void> {
    const { records } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(records).where(eq(records.id, id));
    logger.info({ recordId: id }, 'Deleted record');
  }
}
