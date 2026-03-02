import type { ListOptions, ListResult } from '../../interfaces/storage.interface';
import type { CreateTag, Tag, UpdateTag } from '../../models/domain.models';
import { NotFoundError } from '../../../../common/errors/error-types';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

export class TagStorageDelegate extends BaseStorageDelegate {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async createTag(data: CreateTag): Promise<Tag> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { tags } = await import('../../db/schema');

    const tag: Tag = {
      id: randomUUID(),
      ...data,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(tags).values({
      id: tag.id,
      projectId: tag.projectId,
      name: tag.name,
      createdAt: tag.createdAt,
      updatedAt: tag.updatedAt,
    });

    return tag;
  }

  async getTag(id: string): Promise<Tag> {
    const { tags } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const result = await this.db.select().from(tags).where(eq(tags.id, id)).limit(1);
    if (!result[0]) {
      throw new NotFoundError('Tag', id);
    }
    return result[0] as Tag;
  }

  async listTags(projectId: string | null, options: ListOptions = {}): Promise<ListResult<Tag>> {
    const { tags } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const query = projectId ? eq(tags.projectId, projectId) : undefined;

    const items = await this.db.select().from(tags).where(query).limit(limit).offset(offset);

    return {
      items: items as Tag[],
      total: items.length,
      limit,
      offset,
    };
  }

  async updateTag(id: string, data: UpdateTag): Promise<Tag> {
    const { tags } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    await this.db
      .update(tags)
      .set({ ...data, updatedAt: now })
      .where(eq(tags.id, id));

    return this.getTag(id);
  }

  async deleteTag(id: string): Promise<void> {
    const { tags } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(tags).where(eq(tags.id, id));
  }
}
