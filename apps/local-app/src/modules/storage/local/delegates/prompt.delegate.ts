import type {
  ListResult,
  PromptListFilters,
  PromptSummary,
} from '../../interfaces/storage.interface';
import type {
  CreatePrompt,
  CreateTag,
  Prompt,
  Tag,
  UpdatePrompt,
} from '../../models/domain.models';
import { NotFoundError, OptimisticLockError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { getRawSqliteClient } from '../../db/sqlite-raw';
import { extractPromptId, extractPromptIdFromMap } from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('PromptStorageDelegate');

export interface PromptStorageDelegateDependencies {
  createTag: (data: CreateTag) => Promise<Tag>;
  getPrompt: (id: string) => Promise<Prompt>;
}

export class PromptStorageDelegate extends BaseStorageDelegate {
  constructor(
    context: StorageDelegateContext,
    private readonly dependencies: PromptStorageDelegateDependencies,
  ) {
    super(context);
  }

  async createPrompt(data: CreatePrompt): Promise<Prompt> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { prompts, promptTags, tags } = await import('../../db/schema');

    const prompt: Prompt = {
      id: randomUUID(),
      ...data,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(prompts).values({
      id: prompt.id,
      projectId: prompt.projectId,
      title: prompt.title,
      content: prompt.content,
      version: prompt.version,
      createdAt: prompt.createdAt,
      updatedAt: prompt.updatedAt,
    });

    // Add tags
    if (data.tags?.length) {
      for (const tagName of data.tags) {
        const { eq, and, or, isNull } = await import('drizzle-orm');
        let tag = await this.db
          .select()
          .from(tags)
          .where(
            and(
              eq(tags.name, tagName),
              or(eq(tags.projectId, data.projectId || ''), isNull(tags.projectId)),
            ),
          )
          .limit(1);

        if (!tag[0]) {
          const newTag = await this.dependencies.createTag({
            projectId: data.projectId,
            name: tagName,
          });
          tag = [newTag];
        }

        await this.db.insert(promptTags).values({
          promptId: prompt.id,
          tagId: tag[0].id,
          createdAt: now,
        });
      }
    }

    return prompt;
  }

  async getPrompt(id: string): Promise<Prompt> {
    const { prompts, promptTags, tags } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    const result = await this.db.select().from(prompts).where(eq(prompts.id, id)).limit(1);
    if (!result[0]) {
      throw new NotFoundError('Prompt', id);
    }

    const promptTagsResult = await this.db
      .select({ tag: tags })
      .from(promptTags)
      .innerJoin(tags, eq(promptTags.tagId, tags.id))
      .where(eq(promptTags.promptId, id));

    return {
      ...result[0],
      tags: promptTagsResult.map((pt) => pt.tag.name),
    } as Prompt;
  }

  async listPrompts(filters: PromptListFilters = {}): Promise<ListResult<PromptSummary>> {
    const { prompts, promptTags, tags } = await import('../../db/schema');
    const { and, eq, isNull, asc, sql } = await import('drizzle-orm');
    type SQL = ReturnType<typeof sql>;

    const whereClauses: SQL[] = [];

    // Project filter
    if (filters.projectId !== undefined) {
      whereClauses.push(
        filters.projectId === null
          ? isNull(prompts.projectId)
          : eq(prompts.projectId, filters.projectId),
      );
    }

    // Search filter (case-insensitive LIKE on title using lower())
    const searchTerm = filters.q?.trim();
    if (searchTerm) {
      const pattern = `%${searchTerm.toLowerCase()}%`;
      whereClauses.push(sql`lower(${prompts.title}) LIKE ${pattern}`);
    }

    const whereCondition: SQL | undefined =
      whereClauses.length === 0
        ? undefined
        : whereClauses.length === 1
          ? whereClauses[0]
          : and(...whereClauses);

    // Query prompts (with content for preview)
    const selectFields = {
      id: prompts.id,
      projectId: prompts.projectId,
      title: prompts.title,
      content: prompts.content,
      version: prompts.version,
      createdAt: prompts.createdAt,
      updatedAt: prompts.updatedAt,
    };

    const rows = await (whereCondition
      ? this.db.select(selectFields).from(prompts).where(whereCondition).orderBy(asc(prompts.title))
      : this.db.select(selectFields).from(prompts).orderBy(asc(prompts.title)));

    if (!rows.length) {
      return {
        items: [],
        total: 0,
        limit: filters.limit ?? 100,
        offset: filters.offset ?? 0,
      };
    }

    // Fetch tags for each prompt and create content preview
    const PREVIEW_LENGTH = 200;
    const promptsWithTags: PromptSummary[] = await Promise.all(
      rows.map(async (row) => {
        const tagRows = await this.db
          .select({ tagName: tags.name })
          .from(promptTags)
          .innerJoin(tags, eq(tags.id, promptTags.tagId))
          .where(eq(promptTags.promptId, row.id));

        const content = row.content ?? '';
        const contentPreview =
          content.length > PREVIEW_LENGTH ? content.slice(0, PREVIEW_LENGTH) + '…' : content;

        return {
          id: row.id,
          projectId: row.projectId,
          title: row.title,
          contentPreview,
          version: row.version,
          tags: tagRows.map((t) => t.tagName),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }),
    );

    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    const items = promptsWithTags.slice(offset, offset + limit);

    return {
      items,
      total: promptsWithTags.length,
      limit,
      offset,
    };
  }

  async updatePrompt(id: string, data: UpdatePrompt, expectedVersion: number): Promise<Prompt> {
    const { prompts, promptTags, tags } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    logger.info({ id, data, expectedVersion }, 'updatePrompt called with data');

    const current = await this.dependencies.getPrompt(id);
    if (current.version !== expectedVersion) {
      throw new OptimisticLockError('Prompt', id, {
        expectedVersion,
        actualVersion: current.version,
      });
    }

    // Separate tags from other data
    const { tags: newTags, ...updateData } = data;

    logger.info({ newTags, updateData }, 'Separated tags from updateData');

    // Update prompt fields (excluding tags)
    await this.db
      .update(prompts)
      .set({ ...updateData, version: expectedVersion + 1, updatedAt: now })
      .where(eq(prompts.id, id));

    logger.info('Updated prompt fields in database');

    // Update tags if provided
    if (newTags !== undefined) {
      logger.info({ newTags, newTagsLength: newTags.length }, 'Updating tags');

      // Delete existing tags
      await this.db.delete(promptTags).where(eq(promptTags.promptId, id));
      logger.info('Deleted existing prompt tags');

      // Add new tags
      if (newTags.length > 0) {
        for (const tagName of newTags) {
          logger.info({ tagName }, 'Processing tag');
          const { and, or, isNull } = await import('drizzle-orm');
          let tag = await this.db
            .select()
            .from(tags)
            .where(
              and(
                eq(tags.name, tagName),
                or(eq(tags.projectId, current.projectId || ''), isNull(tags.projectId)),
              ),
            )
            .limit(1);

          if (!tag[0]) {
            logger.info({ tagName }, 'Tag not found, creating new tag');
            const newTag = await this.dependencies.createTag({
              projectId: current.projectId,
              name: tagName,
            });
            tag = [newTag];
          } else {
            logger.info({ tagName, tagId: tag[0].id }, 'Found existing tag');
          }

          await this.db.insert(promptTags).values({
            promptId: id,
            tagId: tag[0].id,
            createdAt: now,
          });
          logger.info({ tagName, tagId: tag[0].id }, 'Inserted prompt tag');
        }
      }
    } else {
      logger.info('No tags provided in update data');
    }

    return this.dependencies.getPrompt(id);
  }

  async deletePrompt(id: string): Promise<void> {
    const { prompts } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(prompts).where(eq(prompts.id, id));
  }

  async getInitialSessionPrompt(projectId: string | null): Promise<Prompt | null> {
    const { settings } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    let rawValue: unknown;
    try {
      // Prefer per-project mapping under key 'initialSessionPromptIds'
      const mapRows = await this.db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, 'initialSessionPromptIds'))
        .limit(1);
      const mapRaw = mapRows[0]?.value;
      const promptIdFromMap = extractPromptIdFromMap(mapRaw, projectId);
      if (promptIdFromMap) {
        rawValue = promptIdFromMap;
      } else {
        const result = await this.db
          .select({ value: settings.value })
          .from(settings)
          .where(eq(settings.key, 'initialSessionPromptId'))
          .limit(1);
        rawValue = result[0]?.value;
      }
    } catch (error) {
      logger.warn(
        { error },
        'Drizzle read failed for initialSessionPromptId; falling back to raw SQLite',
      );
      try {
        // Try map first
        const mapRow = getRawSqliteClient(this.db)
          .prepare('SELECT value FROM settings WHERE key = ? LIMIT 1')
          .get('initialSessionPromptIds') as { value?: unknown } | undefined;
        const fromMap = extractPromptIdFromMap(mapRow?.value, projectId);
        if (fromMap) {
          rawValue = fromMap;
        } else {
          const row = getRawSqliteClient(this.db)
            .prepare('SELECT value FROM settings WHERE key = ? LIMIT 1')
            .get('initialSessionPromptId') as { value?: unknown } | undefined;
          rawValue = row?.value;
        }
      } catch (sqliteError) {
        logger.error({ sqliteError }, 'Raw SQLite read failed for initialSessionPromptId');
        return null;
      }
    }

    const promptId = typeof rawValue === 'string' ? rawValue : extractPromptId(rawValue);
    logger.debug(
      { rawType: typeof rawValue, rawValue: safePreview(rawValue), promptId },
      'Resolved initial session prompt id from settings',
    );

    if (!promptId) {
      return null;
    }

    try {
      return await this.dependencies.getPrompt(promptId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        logger.warn({ promptId }, 'Initial session prompt not found');
        return null;
      }
      throw error;
    }
  }
}

function safePreview(v: unknown): string {
  try {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '…' : v;
    return JSON.stringify(v).slice(0, 200);
  } catch {
    return '[unserializable]';
  }
}
