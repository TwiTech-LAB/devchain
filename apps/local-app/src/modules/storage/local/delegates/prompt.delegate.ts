import type { SnapshotPromptWriter } from '../../interfaces/snapshot-prompt-writer.interface';
import type {
  PromptStorage,
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
import { and as andSync, eq as eqSync, isNull as isNullSync, or as orSync } from 'drizzle-orm';
import { NotFoundError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import {
  canonicalizePromptTypeTags,
  getPromptType,
  PROMPT_TYPE,
} from '../../../../common/prompt-type';
import { getRawSqliteClient } from '../../db/sqlite-raw';
import {
  promptTags as promptTagsTable,
  prompts as promptsTable,
  tags as tagsTable,
} from '../../db/schema';
import { extractPromptId, extractPromptIdFromMap } from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('PromptStorageDelegate');

export interface PromptStorageDelegateDependencies {
  createTag: (data: CreateTag) => Tag;
}

export class PromptStorageDelegate
  extends BaseStorageDelegate
  implements PromptStorage, SnapshotPromptWriter
{
  constructor(
    context: StorageDelegateContext,
    private readonly dependencies: PromptStorageDelegateDependencies,
  ) {
    super(context);
  }

  async createPrompt(data: CreatePrompt): Promise<Prompt> {
    const promptType = getPromptType(data.tags ?? [], PROMPT_TYPE.Custom);
    const canonicalTags = canonicalizePromptTypeTags(data.tags ?? [], promptType);
    return this.insertPrompt(data, canonicalTags);
  }

  async createPromptFromSnapshot(data: CreatePrompt): Promise<Prompt> {
    return this.insertPrompt(data, data.tags ?? []);
  }

  private async insertPrompt(
    data: CreatePrompt,
    persistedTags: readonly string[],
  ): Promise<Prompt> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { prompts, promptTags, tags } = await import('../../db/schema');

    const prompt: Prompt = {
      id: randomUUID(),
      ...data,
      tags: [...persistedTags],
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

    for (const tagName of persistedTags) {
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

    return prompt;
  }

  async getPrompt(id: string): Promise<Prompt> {
    return this.getPromptSync(id);
  }

  private getPromptSync(id: string): Prompt {
    const row = this.db
      .select()
      .from(promptsTable)
      .where(eqSync(promptsTable.id, id))
      .limit(1)
      .get();
    if (!row) {
      throw new NotFoundError('Prompt', id);
    }

    const promptTagsResult = this.db
      .select({ tag: tagsTable })
      .from(promptTagsTable)
      .innerJoin(tagsTable, eqSync(promptTagsTable.tagId, tagsTable.id))
      .where(eqSync(promptTagsTable.promptId, id))
      .all();

    return {
      ...row,
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
    logger.info({ id, data, expectedVersion }, 'updatePrompt called with data');
    const result = await this.versionedMutationExecutor.execute({
      resource: 'Prompt',
      id,
      expectedVersion,
      loadCurrent: () => this.getPromptSync(id),
      versionOf: (current) => current.version,
      prepare: ({ current }) => {
        const { tags: requestedTags, ...updateData } = data;
        const newTags =
          requestedTags === undefined
            ? undefined
            : canonicalizePromptTypeTags(
                requestedTags,
                getPromptType(requestedTags, getPromptType(current.tags, PROMPT_TYPE.Custom)),
              );
        return {
          kind: 'write',
          state: { updateData, newTags, now: new Date().toISOString() },
        };
      },
      write: (context, state) =>
        this.db
          .update(promptsTable)
          .set({
            ...state.updateData,
            version: context.nextVersion,
            updatedAt: state.now,
          })
          .where(
            andSync(
              eqSync(promptsTable.id, id),
              eqSync(promptsTable.version, context.actualVersion),
            ),
          )
          .run().changes,
      afterWrite: ({ current }, state) => {
        if (state.newTags !== undefined) {
          this.setPromptTagsSync(id, state.newTags, current.projectId, state.now);
        }
      },
      loadResult: () => this.getPromptSync(id),
    });

    logger.info({ promptId: id }, 'Updated prompt');
    return result;
  }

  private setPromptTagsSync(
    promptId: string,
    tagNames: string[],
    projectId: string | null,
    now: string,
  ): void {
    this.db.delete(promptTagsTable).where(eqSync(promptTagsTable.promptId, promptId)).run();

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

      this.db.insert(promptTagsTable).values({ promptId, tagId: tag.id, createdAt: now }).run();
    }
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
      return await this.getPrompt(promptId);
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
