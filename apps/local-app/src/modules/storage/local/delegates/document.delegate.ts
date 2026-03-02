import type { SQL } from 'drizzle-orm';
import type {
  DocumentIdentifier,
  DocumentListFilters,
  ListResult,
} from '../../interfaces/storage.interface';
import type {
  CreateDocument,
  CreateTag,
  Document,
  Tag,
  UpdateDocument,
} from '../../models/domain.models';
import {
  NotFoundError,
  OptimisticLockError,
  ValidationError,
} from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { normalizeTagList, slugify } from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('DocumentStorageDelegate');

export interface DocumentStorageDelegateDependencies {
  createTag: (data: CreateTag) => Promise<Tag>;
  getDocument: (identifier: DocumentIdentifier) => Promise<Document>;
  generateDocumentSlug: (
    projectId: string | null,
    desired: string,
    excludeId?: string,
  ) => Promise<string>;
  setDocumentTags: (
    documentId: string,
    tagNames: string[],
    projectId: string | null,
  ) => Promise<void>;
}

export class DocumentStorageDelegate extends BaseStorageDelegate {
  constructor(
    context: StorageDelegateContext,
    private readonly dependencies: DocumentStorageDelegateDependencies,
  ) {
    super(context);
  }

  async listDocuments(filters: DocumentListFilters = {}): Promise<ListResult<Document>> {
    const { documents, documentTags, tags } = await import('../../db/schema');
    const { and, eq, isNull, like, or, desc, sql } = await import('drizzle-orm');

    const whereClauses: SQL[] = [];
    if (filters.projectId !== undefined) {
      whereClauses.push(
        filters.projectId === null
          ? isNull(documents.projectId)
          : eq(documents.projectId, filters.projectId),
      );
    }

    const tagKeys = normalizeTagList(filters.tagKeys);
    if (tagKeys.length) {
      for (const key of tagKeys) {
        whereClauses.push(
          sql`EXISTS (
            SELECT 1
            FROM ${documentTags} dt
            INNER JOIN ${tags} t ON t.id = dt.tag_id
            WHERE dt.document_id = ${documents.id}
              AND (
                (
                  CASE
                    WHEN instr(t.name, ':') > 0 THEN substr(t.name, 1, instr(t.name, ':') - 1)
                    ELSE NULL
                  END
                ) = ${key}
                OR t.name = ${key}
              )
          )`,
        );
      }
    }

    const searchTerm = filters.q?.trim();
    if (searchTerm) {
      const pattern = `%${searchTerm}%`;
      whereClauses.push(
        or(like(documents.title, pattern), like(documents.contentMd, pattern)) as SQL,
      );
    }

    const whereCondition: SQL | undefined =
      whereClauses.length === 0
        ? undefined
        : whereClauses.length === 1
          ? whereClauses[0]
          : and(...whereClauses);

    const rows = await (whereCondition
      ? this.db.select().from(documents).where(whereCondition).orderBy(desc(documents.updatedAt))
      : this.db.select().from(documents).orderBy(desc(documents.updatedAt)));
    if (!rows.length) {
      return {
        items: [],
        total: 0,
        limit: filters.limit ?? 100,
        offset: filters.offset ?? 0,
      };
    }

    const documentsWithTags = await Promise.all(
      rows.map((row) => this.dependencies.getDocument({ id: row.id })),
    );

    let filtered = documentsWithTags;
    if (filters.tags?.length) {
      const requiredTags = normalizeTagList(filters.tags);
      filtered = documentsWithTags.filter((doc) =>
        requiredTags.every((tag) => doc.tags.includes(tag)),
      );
    }

    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    const items = filtered.slice(offset, offset + limit);

    return {
      items,
      total: filtered.length,
      limit,
      offset,
    };
  }

  async getDocument(identifier: DocumentIdentifier): Promise<Document> {
    const { documents, documentTags, tags } = await import('../../db/schema');
    const { eq, and, isNull } = await import('drizzle-orm');

    let whereCondition;
    if (identifier.id) {
      whereCondition = eq(documents.id, identifier.id);
    } else if (identifier.slug) {
      if (identifier.projectId === undefined) {
        throw new ValidationError('projectId is required when querying document by slug');
      }
      whereCondition =
        identifier.projectId === null
          ? and(isNull(documents.projectId), eq(documents.slug, identifier.slug))
          : and(eq(documents.projectId, identifier.projectId), eq(documents.slug, identifier.slug));
    } else {
      throw new ValidationError('Document identifier requires either id or slug');
    }

    const result = await this.db.select().from(documents).where(whereCondition).limit(1);
    const record = result[0];
    if (!record) {
      const lookup = identifier.id ?? `${identifier.projectId ?? 'global'}:${identifier.slug}`;
      throw new NotFoundError('Document', lookup || 'unknown');
    }

    const tagRows = await this.db
      .select({ tag: tags })
      .from(documentTags)
      .innerJoin(tags, eq(documentTags.tagId, tags.id))
      .where(eq(documentTags.documentId, record.id));

    return {
      ...record,
      projectId: record.projectId ?? null,
      tags: tagRows.map((row) => row.tag.name),
    } as Document;
  }

  async createDocument(data: CreateDocument): Promise<Document> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const normalizedProjectId = data.projectId ?? null;
    const { documents } = await import('../../db/schema');

    const slugSource = data.slug ?? data.title;
    const slug = await this.dependencies.generateDocumentSlug(normalizedProjectId, slugSource);
    const tags = normalizeTagList(data.tags);

    const id = randomUUID();
    await this.db.insert(documents).values({
      id,
      projectId: normalizedProjectId,
      title: data.title,
      slug,
      contentMd: data.contentMd,
      version: 1,
      archived: false,
      createdAt: now,
      updatedAt: now,
    });

    if (tags.length) {
      await this.dependencies.setDocumentTags(id, tags, normalizedProjectId);
    }

    logger.info({ documentId: id }, 'Created document');
    return this.dependencies.getDocument({ id });
  }

  async updateDocument(id: string, data: UpdateDocument): Promise<Document> {
    const { documents } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const current = await this.dependencies.getDocument({ id });
    if (data.version !== undefined && data.version !== current.version) {
      throw new OptimisticLockError('Document', id, {
        expectedVersion: data.version,
        actualVersion: current.version,
      });
    }

    const updatePayload: Record<string, unknown> = {
      updatedAt: now,
      version: current.version + 1,
    };

    if (data.title !== undefined) {
      updatePayload.title = data.title;
    }
    if (data.contentMd !== undefined) {
      updatePayload.contentMd = data.contentMd;
    }
    if (data.archived !== undefined) {
      updatePayload.archived = data.archived;
    }
    if (data.slug !== undefined) {
      updatePayload.slug = await this.dependencies.generateDocumentSlug(
        current.projectId,
        data.slug,
        id,
      );
    }

    await this.db.update(documents).set(updatePayload).where(eq(documents.id, id));

    if (data.tags !== undefined) {
      const tags = normalizeTagList(data.tags);
      await this.dependencies.setDocumentTags(id, tags, current.projectId);
    }

    logger.info({ documentId: id }, 'Updated document');
    return this.dependencies.getDocument({ id });
  }

  async deleteDocument(id: string): Promise<void> {
    const { documents } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(documents).where(eq(documents.id, id));
    logger.info({ documentId: id }, 'Deleted document');
  }

  async generateDocumentSlug(
    projectId: string | null,
    desired: string,
    excludeId?: string,
  ): Promise<string> {
    const { documents } = await import('../../db/schema');
    const { eq, and, isNull, ne } = await import('drizzle-orm');

    const base = slugify(desired || 'document') || 'document';
    let candidate = base;
    let attempt = 1;

    // Attempt to find a unique slug, appending a counter if necessary
    // We guard against infinite loops by incrementing attempt on each collision
    // (Slug uniqueness is enforced per project.)
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const projectCondition =
        projectId === null ? isNull(documents.projectId) : eq(documents.projectId, projectId);
      const slugCondition = eq(documents.slug, candidate);
      const whereClause = excludeId
        ? and(slugCondition, projectCondition, ne(documents.id, excludeId))
        : and(slugCondition, projectCondition);

      const existing = await this.db
        .select({ id: documents.id })
        .from(documents)
        .where(whereClause)
        .limit(1);

      if (!existing[0]) {
        return candidate;
      }

      attempt += 1;
      candidate = `${base}-${attempt}`;
    }
  }

  async setDocumentTags(
    documentId: string,
    tagNames: string[],
    projectId: string | null,
  ): Promise<void> {
    const normalizedTags = normalizeTagList(tagNames);
    const { documentTags, tags } = await import('../../db/schema');
    const { eq, and, or, isNull } = await import('drizzle-orm');

    await this.db.delete(documentTags).where(eq(documentTags.documentId, documentId));

    for (const tagName of normalizedTags) {
      const projectCondition =
        projectId === null
          ? isNull(tags.projectId)
          : or(eq(tags.projectId, projectId), isNull(tags.projectId));

      const existing = await this.db
        .select()
        .from(tags)
        .where(and(eq(tags.name, tagName), projectCondition))
        .limit(1);

      let tagId = existing[0]?.id as string | undefined;
      if (!tagId) {
        const newTag = await this.dependencies.createTag({ projectId, name: tagName });
        tagId = newTag.id;
      }

      await this.db.insert(documentTags).values({
        documentId,
        tagId,
      });
    }
  }
}
