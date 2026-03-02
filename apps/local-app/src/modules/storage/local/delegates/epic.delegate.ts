import type { SQL } from 'drizzle-orm';
import {
  type CreateEpicForProjectInput,
  type ListAssignedEpicsOptions,
  type ListOptions,
  type ListProjectEpicsOptions,
  type ListResult,
  type ListSubEpicsForParentsOptions,
} from '../../interfaces/storage.interface';
import {
  type Agent,
  type CreateEpic,
  type CreateEpicComment,
  type CreateTag,
  type Epic,
  type EpicComment,
  type Status,
  type Tag,
  type UpdateEpic,
} from '../../models/domain.models';
import {
  NotFoundError,
  OptimisticLockError,
  StorageError,
  ValidationError,
} from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { parseSkillsRequired, serializeSkillsRequired } from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('EpicStorageDelegate');

export interface EpicStorageDelegateDependencies {
  createTag: (data: CreateTag) => Promise<Tag>;
  getAgent: (id: string) => Promise<Agent>;
  getAgentByName: (projectId: string, name: string) => Promise<Agent>;
  getStatus: (id: string) => Promise<Status>;
}

export class EpicStorageDelegate extends BaseStorageDelegate {
  constructor(
    context: StorageDelegateContext,
    private readonly dependencies: EpicStorageDelegateDependencies,
  ) {
    super(context);
  }

  async createEpic(data: CreateEpic): Promise<Epic> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { epics, epicTags, tags } = await import('../../db/schema');

    const epicId = randomUUID();
    await this.ensureValidEpicParent(data.projectId, data.parentId ?? null, epicId);
    await this.ensureValidAgent(data.projectId, data.agentId ?? null);

    const epic: Epic = {
      id: epicId,
      projectId: data.projectId,
      title: data.title,
      description: data.description ?? null,
      statusId: data.statusId,
      parentId: data.parentId ?? null,
      agentId: data.agentId ?? null,
      version: 1,
      data: data.data ?? null,
      skillsRequired: data.skillsRequired ?? null,
      tags: data.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(epics).values({
      id: epic.id,
      projectId: epic.projectId,
      title: epic.title,
      description: epic.description,
      statusId: epic.statusId,
      parentId: epic.parentId,
      agentId: epic.agentId,
      version: epic.version,
      data: epic.data ? JSON.stringify(epic.data) : null,
      skillsRequired: serializeSkillsRequired(epic.skillsRequired),
      createdAt: epic.createdAt,
      updatedAt: epic.updatedAt,
    });

    // Add tags
    if (epic.tags.length) {
      for (const tagName of epic.tags) {
        const { eq, and, or, isNull } = await import('drizzle-orm');
        let tag = await this.db
          .select()
          .from(tags)
          .where(
            and(
              eq(tags.name, tagName),
              or(eq(tags.projectId, data.projectId), isNull(tags.projectId)),
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

        await this.db.insert(epicTags).values({
          epicId: epic.id,
          tagId: tag[0].id,
          createdAt: now,
        });
      }
    }

    return epic;
  }

  async getEpic(id: string): Promise<Epic> {
    const { epics, epicTags, tags } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    const result = await this.db.select().from(epics).where(eq(epics.id, id)).limit(1);
    if (!result[0]) {
      throw new NotFoundError('Epic', id);
    }

    const epicTagsResult = await this.db
      .select({ tag: tags })
      .from(epicTags)
      .innerJoin(tags, eq(epicTags.tagId, tags.id))
      .where(eq(epicTags.epicId, id));

    return {
      ...result[0],
      data: result[0].data as Record<string, unknown> | null,
      skillsRequired: parseSkillsRequired(result[0].skillsRequired),
      tags: epicTagsResult.map((et) => et.tag.name),
    };
  }

  async listEpics(projectId: string, options: ListOptions = {}): Promise<ListResult<Epic>> {
    const { epics } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const items = await this.db
      .select()
      .from(epics)
      .where(eq(epics.projectId, projectId))
      .limit(limit)
      .offset(offset);

    // Batch fetch tags for all epics in one query (avoids N+1)
    const epicIds = items.map((item) => item.id);
    const tagsMap = await this.batchFetchTags(epicIds);

    // Combine epics with their tags
    const itemsWithTags: Epic[] = items.map((item) => ({
      ...item,
      data: item.data as Record<string, unknown> | null,
      skillsRequired: parseSkillsRequired(item.skillsRequired),
      tags: tagsMap.get(item.id) ?? [],
    }));

    return {
      items: itemsWithTags,
      total: items.length,
      limit,
      offset,
    };
  }

  async listEpicsByStatus(statusId: string, options: ListOptions = {}): Promise<ListResult<Epic>> {
    const { epics } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const items = await this.db
      .select()
      .from(epics)
      .where(eq(epics.statusId, statusId))
      .limit(limit)
      .offset(offset);

    // Batch fetch tags for all epics in one query (avoids N+1)
    const epicIds = items.map((item) => item.id);
    const tagsMap = await this.batchFetchTags(epicIds);

    // Combine epics with their tags
    const itemsWithTags: Epic[] = items.map((item) => ({
      ...item,
      data: item.data as Record<string, unknown> | null,
      skillsRequired: parseSkillsRequired(item.skillsRequired),
      tags: tagsMap.get(item.id) ?? [],
    }));

    return {
      items: itemsWithTags,
      total: items.length,
      limit,
      offset,
    };
  }

  async listProjectEpics(
    projectId: string,
    options: ListProjectEpicsOptions = {},
  ): Promise<ListResult<Epic>> {
    const { epics, statuses } = await import('../../db/schema');
    const { eq, and, sql, desc } = await import('drizzle-orm');
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const conditions: SQL<unknown>[] = [eq(epics.projectId, projectId)];
    if (options.q) {
      const search = options.q.trim().toLowerCase();
      if (search.length) {
        const pattern = `%${search}%`;
        // Check if search looks like a UUID/hex prefix (8+ chars, only hex digits and hyphens)
        const isUuidPrefix = search.length >= 8 && /^[a-f0-9-]+$/.test(search);
        if (isUuidPrefix) {
          // Match both title/description AND ID prefix
          // Note: epics.id is stored lowercase (UUID format), so no lower() needed - allows index usage
          const idPrefixPattern = `${search}%`;
          conditions.push(
            sql`(lower(${epics.title}) LIKE ${pattern} OR lower(ifnull(${epics.description}, '')) LIKE ${pattern} OR ${epics.id} LIKE ${idPrefixPattern})`,
          );
        } else {
          // Standard title/description search only
          conditions.push(
            sql`(lower(${epics.title}) LIKE ${pattern} OR lower(ifnull(${epics.description}, '')) LIKE ${pattern})`,
          );
        }
      }
    }
    if (options.statusId) {
      conditions.push(eq(epics.statusId, options.statusId));
    }

    // Optional archived filter by status label convention 'Archived' (case-insensitive)
    const listType = (options.type ?? 'active').toLowerCase();
    let archivedFilter: SQL<unknown> | null = null;
    if (listType === 'active') {
      // Exclude statuses whose label contains 'archiv' (matches 'Archive', 'Archived', etc.)
      archivedFilter = sql`lower(${statuses.label}) NOT LIKE '%archiv%'`;
    } else if (listType === 'archived') {
      // Include only statuses whose label contains 'archiv'
      archivedFilter = sql`lower(${statuses.label}) LIKE '%archiv%'`;
    } // 'all' => no additional filter

    if (archivedFilter) {
      conditions.push(archivedFilter);
    }

    // Optional MCP hidden filtering: exclude epics whose status has mcpHidden=true
    // AND all descendants of such epics (regardless of their own status)
    if (options.excludeMcpHidden) {
      conditions.push(await this.buildMcpHiddenExclusionPredicate(projectId, epics));
    }

    // Optional parentOnly filter: return only top-level epics (no parent)
    if (options.parentOnly) {
      conditions.push(sql`${epics.parentId} IS NULL`);
    }

    const whereClause = and(...conditions);

    const totalResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(epics)
      .innerJoin(statuses, eq(statuses.id, epics.statusId))
      .where(whereClause);

    const total = Number(totalResult[0]?.count ?? 0);

    // Select all epic fields in one query (optimized: no per-row getEpic calls)
    const rows = await this.db
      .select({ epic: epics })
      .from(epics)
      .innerJoin(statuses, eq(statuses.id, epics.statusId))
      .where(whereClause)
      .orderBy(desc(epics.updatedAt))
      .limit(limit)
      .offset(offset);

    // Batch fetch tags for all epics in one query (avoids N+1)
    const epicIds = rows.map((row) => row.epic.id);
    const tagsMap = await this.batchFetchTags(epicIds);

    // Combine epics with their tags
    const items: Epic[] = rows.map((row) => ({
      ...row.epic,
      data: row.epic.data as Record<string, unknown> | null,
      skillsRequired: parseSkillsRequired(row.epic.skillsRequired),
      tags: tagsMap.get(row.epic.id) ?? [],
    }));

    return {
      items,
      total,
      limit,
      offset,
    };
  }

  async listAssignedEpics(
    projectId: string,
    options: ListAssignedEpicsOptions,
  ): Promise<ListResult<Epic>> {
    if (!options.agentName?.trim()) {
      throw new ValidationError('agentName is required to list assigned epics.', {
        projectId,
      });
    }

    const { epics } = await import('../../db/schema');
    const { and, eq, sql, desc } = await import('drizzle-orm');
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const agent = await this.dependencies.getAgentByName(projectId, options.agentName);

    const conditions: SQL<unknown>[] = [
      eq(epics.projectId, projectId),
      eq(epics.agentId, agent.id),
    ];

    // Optional MCP hidden filtering: exclude epics whose status has mcpHidden=true
    // AND all descendants of such epics (regardless of their own status)
    if (options.excludeMcpHidden) {
      conditions.push(await this.buildMcpHiddenExclusionPredicate(projectId, epics));
    }

    const whereClause = and(...conditions);

    const totalResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(epics)
      .where(whereClause);

    const total = Number(totalResult[0]?.count ?? 0);

    const rows = await this.db
      .select()
      .from(epics)
      .where(whereClause)
      .orderBy(desc(epics.updatedAt))
      .limit(limit)
      .offset(offset);

    // Batch fetch tags for all epics in one query (avoids N+1)
    const epicIds = rows.map((row) => row.id);
    const tagsMap = await this.batchFetchTags(epicIds);

    // Combine epics with their tags
    const items: Epic[] = rows.map((row) => ({
      ...row,
      data: row.data as Record<string, unknown> | null,
      skillsRequired: parseSkillsRequired(row.skillsRequired),
      tags: tagsMap.get(row.id) ?? [],
    }));

    return {
      items,
      total,
      limit,
      offset,
    };
  }

  async createEpicForProject(projectId: string, input: CreateEpicForProjectInput): Promise<Epic> {
    const { statuses } = await import('../../db/schema');
    const { eq, asc } = await import('drizzle-orm');

    let statusId = input.statusId ?? null;

    if (statusId) {
      const status = await this.dependencies.getStatus(statusId);
      if (status.projectId !== projectId) {
        throw new ValidationError('Status must belong to the target project.', {
          statusId,
          projectId,
          statusProjectId: status.projectId,
        });
      }
    } else {
      const defaultStatusResult = await this.db
        .select({ id: statuses.id })
        .from(statuses)
        .where(eq(statuses.projectId, projectId))
        .orderBy(asc(statuses.position))
        .limit(1);

      const defaultStatus = defaultStatusResult[0];
      if (!defaultStatus) {
        throw new ValidationError('Project has no statuses configured.', { projectId });
      }
      statusId = defaultStatus.id;
    }

    let agentId = input.agentId ?? null;
    if (!agentId && input.agentName?.trim()) {
      const agent = await this.dependencies.getAgentByName(projectId, input.agentName);
      agentId = agent.id;
    }

    await this.ensureValidAgent(projectId, agentId);
    await this.ensureValidEpicParent(projectId, input.parentId ?? null);

    return this.createEpic({
      projectId,
      title: input.title,
      description: input.description ?? null,
      statusId,
      parentId: input.parentId ?? null,
      agentId,
      skillsRequired: input.skillsRequired ?? null,
      tags: input.tags ?? [],
      data: null,
    });
  }

  async updateEpic(id: string, data: UpdateEpic, expectedVersion: number): Promise<Epic> {
    const { epics } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const current = await this.getEpic(id);
    if (current.version !== expectedVersion) {
      throw new OptimisticLockError('Epic', id, {
        expectedVersion,
        actualVersion: current.version,
      });
    }

    if (data.parentId !== undefined) {
      await this.ensureValidEpicParent(current.projectId, data.parentId ?? null, id);
    }

    if (data.agentId !== undefined) {
      await this.ensureValidAgent(current.projectId, data.agentId ?? null);
    }

    const updateData: Record<string, unknown> = { ...data };
    if (data.data !== undefined) {
      updateData.data = JSON.stringify(data.data);
    }
    if (data.skillsRequired !== undefined) {
      updateData.skillsRequired = serializeSkillsRequired(data.skillsRequired);
    }
    for (const key of Object.keys(updateData)) {
      if (updateData[key] === undefined) {
        delete updateData[key];
      }
    }

    await this.db
      .update(epics)
      .set({ ...updateData, version: expectedVersion + 1, updatedAt: now })
      .where(eq(epics.id, id));

    return this.getEpic(id);
  }

  async deleteEpic(id: string): Promise<void> {
    const { epics } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    // Find all sub-epics
    const subEpics = await this.db
      .select({ id: epics.id })
      .from(epics)
      .where(eq(epics.parentId, id));

    // Recursively delete each sub-epic
    for (const subEpic of subEpics) {
      await this.deleteEpic(subEpic.id);
    }

    // Delete the parent epic
    await this.db.delete(epics).where(eq(epics.id, id));
    logger.info({ epicId: id, deletedSubEpics: subEpics.length }, 'Deleted epic and sub-epics');
  }

  async listSubEpics(parentId: string, options: ListOptions = {}): Promise<ListResult<Epic>> {
    await this.getEpic(parentId);
    const { epics } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const items = await this.db
      .select()
      .from(epics)
      .where(eq(epics.parentId, parentId))
      .limit(limit)
      .offset(offset);

    const itemsWithTags = await Promise.all(items.map((item) => this.getEpic(item.id)));

    return {
      items: itemsWithTags,
      total: items.length,
      limit,
      offset,
    };
  }

  async listSubEpicsForParents(
    projectId: string,
    parentIds: string[],
    options: ListSubEpicsForParentsOptions = {},
  ): Promise<Map<string, Epic[]>> {
    const result = new Map<string, Epic[]>();

    // Initialize result map with empty arrays for all requested parentIds
    for (const parentId of parentIds) {
      result.set(parentId, []);
    }

    // Return empty map if no parent IDs provided
    if (parentIds.length === 0) {
      return result;
    }

    const limitPerParent = options.limitPerParent ?? 50;

    // Build filter conditions for the WHERE clause
    const listType = (options.type ?? 'active').toLowerCase();
    let archivedCondition = '';
    if (listType === 'active') {
      archivedCondition = "AND lower(s.label) NOT LIKE '%archiv%'";
    } else if (listType === 'archived') {
      archivedCondition = "AND lower(s.label) LIKE '%archiv%'";
    }

    const mcpHiddenCondition = options.excludeMcpHidden ? 'AND s.mcp_hidden != 1' : '';

    // Build parent IDs placeholder for SQL IN clause
    const parentIdPlaceholders = parentIds.map(() => '?').join(', ');

    // Use window function to rank sub-epics per parent and limit in SQL
    // This eliminates N+1 queries by fetching all data in a single query
    const queryStr = `
      WITH ranked AS (
        SELECT
          e.id,
          e.project_id,
          e.title,
          e.description,
          e.status_id,
          e.parent_id,
          e.agent_id,
          e.version,
          e.data,
          e.skills_required,
          e.created_at,
          e.updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY e.parent_id
            ORDER BY e.updated_at DESC, e.id DESC
          ) as row_num
        FROM epics e
        INNER JOIN statuses s ON s.id = e.status_id
        WHERE e.project_id = ?
          AND e.parent_id IN (${parentIdPlaceholders})
          ${archivedCondition}
          ${mcpHiddenCondition}
      )
      SELECT * FROM ranked WHERE row_num <= ?
      ORDER BY parent_id, row_num
    `;

    const sqlite = this.rawClient;
    if (!sqlite || typeof (sqlite as unknown as { prepare?: unknown }).prepare !== 'function') {
      throw new StorageError('Unable to access underlying SQLite client for sub-epic batching');
    }
    const stmt = sqlite.prepare(queryStr);
    const rows = stmt.all(projectId, ...parentIds, limitPerParent) as Array<{
      id: string;
      project_id: string;
      title: string;
      description: string | null;
      status_id: string;
      parent_id: string | null;
      agent_id: string | null;
      version: number;
      data: string | null;
      skills_required: string | null;
      created_at: string;
      updated_at: string;
      row_num: number;
    }>;

    // Map rows to Epic objects and group by parentId
    // First pass: create epic objects with empty tags
    const allEpics: Epic[] = [];
    for (const row of rows) {
      if (!row.parent_id) continue;

      const epic: Epic = {
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        description: row.description,
        statusId: row.status_id,
        parentId: row.parent_id,
        agentId: row.agent_id,
        version: row.version,
        data: row.data ? JSON.parse(row.data) : null,
        skillsRequired: parseSkillsRequired(row.skills_required),
        tags: [], // Will be hydrated below
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };

      allEpics.push(epic);
      const group = result.get(row.parent_id) ?? [];
      group.push(epic);
      result.set(row.parent_id, group);
    }

    // Batch fetch tags for all epics (chunked to stay under SQLite 999 param limit)
    if (allEpics.length > 0) {
      const epicIds = allEpics.map((e) => e.id);
      const tagsMap = await this.batchFetchTags(epicIds);

      // Attach tags to each epic
      for (const epic of allEpics) {
        epic.tags = tagsMap.get(epic.id) ?? [];
      }
    }

    return result;
  }

  async countSubEpicsByStatus(parentId: string): Promise<Record<string, number>> {
    await this.getEpic(parentId);
    const { epics } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    const rows = await this.db
      .select({ statusId: epics.statusId })
      .from(epics)
      .where(eq(epics.parentId, parentId));

    return rows.reduce<Record<string, number>>((acc, row) => {
      const key = row.statusId as string;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
  }

  async countEpicsByStatus(statusId: string): Promise<number> {
    const { epics } = await import('../../db/schema');
    const { eq, count } = await import('drizzle-orm');
    const result = await this.db
      .select({ count: count() })
      .from(epics)
      .where(eq(epics.statusId, statusId));
    return Number(result[0]?.count ?? 0);
  }

  async updateEpicsStatus(oldStatusId: string, newStatusId: string): Promise<number> {
    const { epics } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();
    const result = await this.db
      .update(epics)
      .set({ statusId: newStatusId, updatedAt: now })
      .where(eq(epics.statusId, oldStatusId));
    return result.changes ?? 0;
  }

  async listEpicComments(
    epicId: string,
    options: ListOptions = {},
  ): Promise<ListResult<EpicComment>> {
    await this.getEpic(epicId);
    const { epicComments } = await import('../../db/schema');
    const { eq, asc, sql } = await import('drizzle-orm');
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const items = await this.db
      .select()
      .from(epicComments)
      .where(eq(epicComments.epicId, epicId))
      .orderBy(asc(epicComments.createdAt))
      .limit(limit)
      .offset(offset);

    const totalResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(epicComments)
      .where(eq(epicComments.epicId, epicId));

    const total = Number(totalResult[0]?.count ?? 0);

    return {
      items: items as EpicComment[],
      total,
      limit,
      offset,
    };
  }

  async createEpicComment(data: CreateEpicComment): Promise<EpicComment> {
    await this.getEpic(data.epicId);
    const { randomUUID } = await import('crypto');
    const { epicComments } = await import('../../db/schema');
    const now = new Date().toISOString();

    const comment: EpicComment = {
      id: randomUUID(),
      epicId: data.epicId,
      authorName: data.authorName,
      content: data.content,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(epicComments).values({
      id: comment.id,
      epicId: comment.epicId,
      authorName: comment.authorName,
      content: comment.content,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    });

    return comment;
  }

  async deleteEpicComment(id: string): Promise<void> {
    const { epicComments } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(epicComments).where(eq(epicComments.id, id));
  }

  async getEpicsByIdPrefix(
    projectId: string,
    prefix: string,
  ): Promise<Array<{ id: string; title: string }>> {
    const { epics } = await import('../../db/schema');
    const { eq, and, sql } = await import('drizzle-orm');

    return this.db
      .select({ id: epics.id, title: epics.title })
      .from(epics)
      .where(
        and(
          eq(epics.projectId, projectId),
          sql`substr(${epics.id}, 1, ${prefix.length}) = ${prefix}`,
        ),
      );
  }

  private async ensureValidEpicParent(
    projectId: string,
    parentId?: string | null,
    childId?: string,
  ): Promise<void> {
    if (!parentId) {
      return;
    }

    if (childId && parentId === childId) {
      throw new ValidationError('An epic cannot be its own parent.', {
        epicId: childId,
        parentId,
      });
    }

    const parent = await this.getEpic(parentId);

    if (parent.projectId !== projectId) {
      throw new ValidationError('Parent epic must belong to the same project.', {
        projectId,
        parentProjectId: parent.projectId,
        parentId,
      });
    }

    if (parent.parentId) {
      throw new ValidationError('Cannot assign a sub-epic as a parent (one-level hierarchy).', {
        parentId,
      });
    }

    if (childId) {
      const { epics } = await import('../../db/schema');
      const { eq } = await import('drizzle-orm');
      const descendants = await this.db
        .select({ id: epics.id })
        .from(epics)
        .where(eq(epics.parentId, childId));

      if (descendants.some((row) => row.id === parentId)) {
        throw new ValidationError('Cannot assign a descendant as the parent epic.', {
          parentId,
          epicId: childId,
        });
      }
    }
  }

  /**
   * Builds the SQL predicate for excluding epics with mcpHidden status and their descendants.
   * Uses a recursive CTE to find all epics in the excluded tree.
   */
  private async buildMcpHiddenExclusionPredicate(
    projectId: string,
    epicsTable: typeof import('../../db/schema').epics,
  ) {
    const { sql } = await import('drizzle-orm');
    return sql`${epicsTable.id} NOT IN (
      WITH RECURSIVE excluded_tree AS (
        SELECT e.id FROM epics e
        JOIN statuses s ON e.status_id = s.id
        WHERE s.mcp_hidden = 1 AND e.project_id = ${projectId}
        UNION ALL
        SELECT e.id FROM epics e
        JOIN excluded_tree et ON e.parent_id = et.id
        WHERE e.project_id = ${projectId}
      )
      SELECT id FROM excluded_tree
    )`;
  }

  private async ensureValidAgent(projectId: string, agentId?: string | null): Promise<void> {
    if (!agentId) {
      return;
    }

    const agent = await this.dependencies.getAgent(agentId);
    if (agent.projectId !== projectId) {
      throw new ValidationError('Agent must belong to the same project as the epic.', {
        projectId,
        agentProjectId: agent.projectId,
        agentId,
      });
    }
  }

  /**
   * Batch fetch tags for multiple epic IDs with chunking.
   * Chunks IDs into batches of 500 to stay under SQLite's 999 parameter limit.
   */
  private async batchFetchTags(epicIds: string[]): Promise<Map<string, string[]>> {
    const tagsMap = new Map<string, string[]>();

    if (epicIds.length === 0) {
      return tagsMap;
    }

    const { epicTags, tags } = await import('../../db/schema');
    const { eq, inArray } = await import('drizzle-orm');

    // Chunk size of 500 stays well under SQLite's 999 parameter limit
    const CHUNK_SIZE = 500;
    const chunks: string[][] = [];
    for (let i = 0; i < epicIds.length; i += CHUNK_SIZE) {
      chunks.push(epicIds.slice(i, i + CHUNK_SIZE));
    }

    // Query tags for each chunk
    for (const chunk of chunks) {
      const rows = await this.db
        .select({
          epicId: epicTags.epicId,
          tagName: tags.name,
        })
        .from(epicTags)
        .innerJoin(tags, eq(epicTags.tagId, tags.id))
        .where(inArray(epicTags.epicId, chunk));

      // Group tags by epicId
      for (const row of rows) {
        const existing = tagsMap.get(row.epicId) ?? [];
        existing.push(row.tagName);
        tagsMap.set(row.epicId, existing);
      }
    }

    return tagsMap;
  }
}
