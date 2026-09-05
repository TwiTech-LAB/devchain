import type { SQL } from 'drizzle-orm';
import { and as andSync, eq as eqSync, isNull as isNullSync, or as orSync } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  type CreateEpicForProjectInput,
  type ListAssignedEpicsOptions,
  type ListEpicRelationCandidatesOptions,
  type ListEpicRelationsOptions,
  type EpicRelationReadOptions,
  type ListParentChildrenOptions,
  type ListOptions,
  type ListProjectEpicsOptions,
  type ListResult,
  type ListSubEpicsForParentsOptions,
  type FactualEventFactory,
} from '../../interfaces/storage.interface';
import {
  type Agent,
  type CreateEpic,
  type CreateEpicComment,
  type CreateTag,
  type Epic,
  type EpicComment,
  type EpicRelation,
  type EpicRelationCandidate,
  type EpicRelationDirection,
  type EpicRelationListItem,
  type EpicRelationSummary,
  type EpicRelationType,
  type RelationRouteEffectFacts,
  type EpicRelationWriteContext,
  type SetEpicRelationResult,
  type DeleteEpicRelationResult,
  type SetEpicRelation,
  type StoredEpicRelationType,
  type Status,
  type Tag,
  type UpdateEpic,
  resolveRelationEndpoints,
} from '../../models/domain.models';
import {
  ForbiddenError,
  NotFoundError,
  RelationConfirmationRequiredError,
  StorageError,
  ValidationError,
} from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import {
  epicComments as epicCommentsTable,
  epicTags as epicTagsTable,
  epics as epicsTable,
  tags as tagsTable,
} from '../../db/schema';
import { parseSkillsRequired, serializeSkillsRequired } from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';
import type { PreparedEvent } from '../../../events/services/durable-event-registry.service';

const logger = createLogger('EpicStorageDelegate');
const MAX_RELATION_BATCH_SIZE = 1000;
const MAX_RELATION_LIST_LIMIT = 100;
const MAX_RELATION_PREFIX_RESULTS = 100;

interface EpicRelationRow {
  id: string;
  left_epic_id: string;
  right_epic_id: string;
  type: StoredEpicRelationType;
  direction: EpicRelationDirection;
  created_by: 'user' | 'agent' | null;
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
}

interface EpicRelationContextRow {
  id: string;
  project_id: string;
  workspace_id: string;
  parent_id: string | null;
}

export interface EpicStorageDelegateDependencies {
  createTag: (data: CreateTag) => Tag;
  getAgent: (id: string) => Agent;
  getAgentByName: (projectId: string, name: string) => Promise<Agent>;
  getStatus: (id: string) => Promise<Status>;
  appendEvent: (event: PreparedEvent) => void;
}

export class EpicStorageDelegate extends BaseStorageDelegate {
  constructor(
    context: StorageDelegateContext,
    private readonly dependencies: EpicStorageDelegateDependencies,
  ) {
    super(context);
  }

  async createEpic(
    data: CreateEpic,
    eventFactory?: (epic: Epic) => PreparedEvent | null,
  ): Promise<Epic> {
    return this.txRunner.runImmediateQueued(() => this.insertEpic(data, eventFactory));
  }

  async createEpicInCurrentTransaction(
    data: CreateEpic,
    eventFactory?: (epic: Epic) => PreparedEvent | null,
    beforeEventAppend?: (epic: Epic) => Promise<void>,
  ): Promise<Epic> {
    if (!this.rawClient.inTransaction) {
      throw new StorageError('Epic transaction insert requires an active storage transaction.');
    }
    const epic = this.insertEpic(data);
    await beforeEventAppend?.(epic);
    this.appendEpicEvent(epic, eventFactory);
    return epic;
  }

  private insertEpic(data: CreateEpic, eventFactory?: (epic: Epic) => PreparedEvent | null): Epic {
    const now = new Date().toISOString();

    const epicId = randomUUID();
    this.ensureValidEpicParentSync(data.projectId, data.parentId ?? null, epicId);
    this.ensureValidAgentSync(data.projectId, data.agentId ?? null);

    const epic: Epic = {
      id: epicId,
      projectId: data.projectId,
      title: data.title,
      description: data.description ?? null,
      statusId: data.statusId,
      parentId: data.parentId ?? null,
      agentId: data.agentId ?? null,
      createdBy: data.createdBy ?? null,
      version: 1,
      data: data.data ?? null,
      skillsRequired: data.skillsRequired ?? null,
      tags: data.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .insert(epicsTable)
      .values({
        id: epic.id,
        projectId: epic.projectId,
        title: epic.title,
        description: epic.description,
        statusId: epic.statusId,
        parentId: epic.parentId,
        agentId: epic.agentId,
        createdBy: epic.createdBy,
        version: epic.version,
        data: epic.data,
        skillsRequired: serializeSkillsRequired(epic.skillsRequired),
        createdAt: epic.createdAt,
        updatedAt: epic.updatedAt,
      })
      .run();

    // Add tags
    if (epic.tags.length) {
      for (const tagName of epic.tags) {
        let tag = this.db
          .select()
          .from(tagsTable)
          .where(
            andSync(
              eqSync(tagsTable.name, tagName),
              orSync(eqSync(tagsTable.projectId, data.projectId), isNullSync(tagsTable.projectId)),
            ),
          )
          .limit(1)
          .all();

        if (!tag[0]) {
          const newTag = this.dependencies.createTag({
            projectId: data.projectId,
            name: tagName,
          });
          tag = [newTag];
        }

        this.db
          .insert(epicTagsTable)
          .values({
            epicId: epic.id,
            tagId: tag[0].id,
            createdAt: now,
          })
          .run();
      }
    }

    this.appendEpicEvent(epic, eventFactory);
    return epic;
  }

  private appendEpicEvent(
    epic: Epic,
    eventFactory: ((epic: Epic) => PreparedEvent | null) | undefined,
  ): void {
    const event = eventFactory?.(epic);
    if (event) {
      this.dependencies.appendEvent(event);
    }
  }

  async getEpic(id: string): Promise<Epic> {
    return this.getEpicSync(id);
  }

  private getEpicSync(id: string): Epic {
    const row = this.db.select().from(epicsTable).where(eqSync(epicsTable.id, id)).limit(1).get();
    if (!row) {
      throw new NotFoundError('Epic', id);
    }

    const epicTagsResult = this.db
      .select({ tag: tagsTable })
      .from(epicTagsTable)
      .innerJoin(tagsTable, eqSync(epicTagsTable.tagId, tagsTable.id))
      .where(eqSync(epicTagsTable.epicId, id))
      .all();

    return {
      ...row,
      data: row.data as Record<string, unknown> | null,
      skillsRequired: parseSkillsRequired(row.skillsRequired),
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
    const { epics, statuses, externalTaskLinks } = await import('../../db/schema');
    const { eq, and, sql, desc } = await import('drizzle-orm');
    const { safeJsonText } = await import('../../db/sqlite-json');
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const conditions: SQL<unknown>[] = [eq(epics.projectId, projectId)];
    if (options.q) {
      const search = options.q.trim().toLowerCase();
      if (search.length) {
        const pattern = `%${search}%`;
        // Linked external identifiers (remote task ID and snapshot remoteKey) must ride in
        // BOTH search shapes: hex-only ClickUp task IDs land in the UUID-prefix branch, so
        // the EXISTS cannot live in only one arm. EXISTS keeps multi-link Epics unique.
        const externalIdentifierMatch = sql`EXISTS (
          SELECT 1 FROM ${externalTaskLinks}
          WHERE ${externalTaskLinks.epicId} = ${epics.id}
            AND (lower(${externalTaskLinks.remoteTaskId}) LIKE ${pattern}
              OR lower(${safeJsonText(externalTaskLinks.sourceSnapshot, '$.remoteKey')}) LIKE ${pattern})
        )`;
        // Check if search looks like a UUID/hex prefix (8+ chars, only hex digits and hyphens)
        const isUuidPrefix = search.length >= 8 && /^[a-f0-9-]+$/.test(search);
        if (isUuidPrefix) {
          // Match both title/description AND ID prefix
          // Note: epics.id is stored lowercase (UUID format), so no lower() needed - allows index usage
          const idPrefixPattern = `${search}%`;
          conditions.push(
            sql`(lower(${epics.title}) LIKE ${pattern} OR lower(ifnull(${epics.description}, '')) LIKE ${pattern} OR ${epics.id} LIKE ${idPrefixPattern} OR ${externalIdentifierMatch})`,
          );
        } else {
          // Standard title/description search only
          conditions.push(
            sql`(lower(${epics.title}) LIKE ${pattern} OR lower(ifnull(${epics.description}, '')) LIKE ${pattern} OR ${externalIdentifierMatch})`,
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
      .orderBy(desc(epics.updatedAt), desc(epics.id))
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

  async createEpicForProject(
    projectId: string,
    input: CreateEpicForProjectInput,
    eventFactory?: (epic: Epic) => PreparedEvent | null,
  ): Promise<Epic> {
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

    this.ensureValidAgentSync(projectId, agentId);
    this.ensureValidEpicParentSync(projectId, input.parentId ?? null);

    return this.createEpic(
      {
        projectId,
        title: input.title,
        description: input.description ?? null,
        statusId,
        parentId: input.parentId ?? null,
        agentId,
        createdBy: input.createdBy ?? null,
        skillsRequired: input.skillsRequired ?? null,
        tags: input.tags ?? [],
        data: null,
      },
      eventFactory,
    );
  }

  async updateEpic(
    id: string,
    data: UpdateEpic,
    expectedVersion: number,
    eventFactory?: FactualEventFactory<Epic, Epic>,
  ): Promise<Epic> {
    return this.versionedMutationExecutor.execute({
      resource: 'Epic',
      id,
      expectedVersion,
      loadCurrent: () => this.getEpicSync(id),
      versionOf: (current) => current.version,
      prepare: ({ current }) => {
        if (data.parentId !== undefined) {
          if (data.parentId !== current.parentId) {
            this.ensureEpicIsNotRouteEndpointSync(id);
          }
          if (data.parentId === null && current.parentId !== null) {
            // Promotion can activate previously ineligible routes; the
            // post-change graph must still satisfy ownership and acyclicity.
            this.assertPromotionKeepsEligibleRoutesSync(id, current.projectId);
          }
          this.ensureValidEpicParentSync(current.projectId, data.parentId ?? null, id);
        }
        if (data.agentId !== undefined) {
          this.ensureValidAgentSync(current.projectId, data.agentId ?? null);
        }

        const { tags: requestedTags, ...scalarData } = data;
        const updateData: Record<string, unknown> = { ...scalarData };
        delete updateData.createdBy;
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

        return {
          kind: 'write',
          state: {
            updateData,
            requestedTags:
              requestedTags === undefined ? undefined : Array.from(new Set(requestedTags)),
            now: new Date().toISOString(),
          },
        };
      },
      write: (context, state) =>
        this.db
          .update(epicsTable)
          .set({
            ...state.updateData,
            version: context.nextVersion,
            updatedAt: state.now,
          })
          .where(
            andSync(eqSync(epicsTable.id, id), eqSync(epicsTable.version, context.actualVersion)),
          )
          .run().changes,
      afterWrite: ({ current }, state) => {
        if (state.requestedTags !== undefined) {
          this.setEpicTagsSync(id, state.requestedTags, current.projectId, state.now);
        }
        const event = eventFactory?.(this.getEpicSync(id), current);
        if (event) {
          this.dependencies.appendEvent(event);
        }
      },
      loadResult: () => this.getEpicSync(id),
    });
  }

  async deleteEpic(
    id: string,
    eventFactory?: (epic: Epic, workspaceId: string) => PreparedEvent | null,
  ): Promise<void> {
    return this.txRunner.runImmediateQueued(() => {
      const rows = this.rawClient
        .prepare(
          `WITH RECURSIVE tree(id, depth) AS (
             SELECT id, 0 FROM epics WHERE id = ?
             UNION ALL
             SELECT e.id, tree.depth + 1
             FROM epics e
             INNER JOIN tree ON e.parent_id = tree.id
           )
           SELECT id, depth FROM tree ORDER BY depth DESC, id`,
        )
        .all(id) as Array<{ id: string; depth: number }>;
      if (rows.length === 0) {
        throw new NotFoundError('Epic', id);
      }
      const { workspace_id: workspaceId } = this.rawClient
        .prepare(
          `SELECT project.workspace_id
           FROM epics epic
           INNER JOIN projects project ON project.id = epic.project_id
           WHERE epic.id = ?`,
        )
        .get(id) as { workspace_id: string };

      for (const row of rows) {
        const event = eventFactory?.(this.getEpicSync(row.id), workspaceId);
        if (event) {
          this.dependencies.appendEvent(event);
        }
      }
      const deleteRow = this.rawClient.prepare('DELETE FROM epics WHERE id = ?');
      for (const row of rows) {
        deleteRow.run(row.id);
      }
      logger.info({ epicId: id, deletedSubEpics: rows.length - 1 }, 'Deleted epic and sub-epics');
    });
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

  async listParentChildren(
    parentId: string,
    options: ListParentChildrenOptions = {},
  ): Promise<ListResult<Epic>> {
    const parent = await this.getEpic(parentId);
    const { epics } = await import('../../db/schema');
    const { eq, and, sql, desc } = await import('drizzle-orm');
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const statusId = options.statusId;

    const conditions = [eq(epics.parentId, parentId)];
    if (typeof statusId === 'string' && statusId.length > 0) {
      conditions.push(eq(epics.statusId, statusId));
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
      .orderBy(desc(epics.updatedAt), desc(epics.id))
      .limit(limit)
      .offset(offset);

    const epicIds = rows.map((row) => row.id);
    const tagsMap = await this.batchFetchTags(epicIds);

    const items: Epic[] = rows.map((row) => ({
      ...row,
      projectId: parent.projectId,
      data: row.data as Record<string, unknown> | null,
      skillsRequired: parseSkillsRequired(row.skillsRequired),
      tags: tagsMap.get(row.id) ?? [],
    }));

    return { items, total, limit, offset };
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
          e.created_by,
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
      created_by: string | null;
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
        createdBy: row.created_by,
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

  async createEpicComment(
    data: CreateEpicComment,
    eventFactory?: FactualEventFactory<EpicComment, Epic>,
  ): Promise<EpicComment> {
    return this.txRunner.runImmediateQueued(() => this.insertEpicComment(data, eventFactory));
  }

  private insertEpicComment(
    data: CreateEpicComment,
    eventFactory?: FactualEventFactory<EpicComment, Epic>,
  ): EpicComment {
    const epic = this.getEpicSync(data.epicId);
    const now = new Date().toISOString();

    const comment: EpicComment = {
      id: randomUUID(),
      epicId: data.epicId,
      authorName: data.authorName,
      content: data.content,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .insert(epicCommentsTable)
      .values({
        id: comment.id,
        epicId: comment.epicId,
        authorName: comment.authorName,
        content: comment.content,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      })
      .run();

    const event = eventFactory?.(comment, epic);
    if (event) {
      this.dependencies.appendEvent(event);
    }
    return comment;
  }

  async deleteEpicComment(id: string): Promise<void> {
    const { epicComments } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(epicComments).where(eq(epicComments.id, id));
  }

  async deleteEpicCommentScoped(epicId: string, commentId: string): Promise<boolean> {
    const { epicComments } = await import('../../db/schema');
    const { eq, and } = await import('drizzle-orm');
    const result = await this.db
      .delete(epicComments)
      .where(and(eq(epicComments.id, commentId), eq(epicComments.epicId, epicId)));
    return (result.changes ?? 0) > 0;
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

  async setEpicRelation(
    data: SetEpicRelation,
    context: EpicRelationWriteContext,
  ): Promise<SetEpicRelationResult> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const [focal, related] = this.validateRelationPairSync(data.epicId, data.relatedEpicId);
      this.authorizeRelationWriteSync(focal, related, context);
      const { leftEpicId, rightEpicId } = this.canonicalRelationPair(focal.id, related.id);
      const { type, direction } = this.toStoredRelation(focal.id, leftEpicId, data.type);
      const createdBy = data.createdBy ?? null;
      const createdByAgentId = data.createdByAgentId ?? null;
      if (createdBy !== null && createdBy !== 'user' && createdBy !== 'agent') {
        throw new ValidationError('Relation creator type must be user or agent.');
      }
      if (createdByAgentId !== null) {
        if (createdBy !== 'agent') {
          throw new ValidationError('An agent relation creator requires createdBy="agent".');
        }
        const creator = this.dependencies.getAgent(createdByAgentId);
        if (creator.projectId !== focal.project_id) {
          throw new ValidationError('Relation creator must belong to the focal Epic project.', {
            createdByAgentId,
            projectId: focal.project_id,
          });
        }
      }

      const existing = this.rawClient
        .prepare(
          `SELECT id, left_epic_id, right_epic_id, type, direction,
                  created_by, created_by_agent_id, created_at, updated_at
           FROM epic_relations
           WHERE left_epic_id = ? AND right_epic_id = ?`,
        )
        .get(leftEpicId, rightEpicId) as EpicRelationRow | undefined;
      if (existing?.type === type && existing.direction === direction) {
        return {
          ...this.mapEpicRelation(existing),
          changed: false,
          workspaceId: focal.workspace_id,
        };
      }

      // Eligible time routes are the subset of Related pairs whose endpoints
      // are both root Epics in one project; every other Related linkage stays
      // a plain directional link that owns no route.
      const pairEligible =
        focal.parent_id === null &&
        related.parent_id === null &&
        focal.project_id === related.project_id;
      const directedEffect =
        type === 'related' ? resolveRelationEndpoints(leftEpicId, rightEpicId, direction) : null;
      const newEligibleRoute = pairEligible ? directedEffect : null;
      const oldEffect =
        existing && existing.type === 'related' && existing.direction !== 'none' && pairEligible
          ? resolveRelationEndpoints(
              existing.left_epic_id,
              existing.right_epic_id,
              existing.direction,
            )
          : null;
      const effectUnchanged =
        newEligibleRoute !== null &&
        oldEffect !== null &&
        newEligibleRoute.sourceEpicId === oldEffect.sourceEpicId &&
        newEligibleRoute.targetEpicId === oldEffect.targetEpicId;

      // One eligible source holds one eligible target: this write displaces the
      // pair's own stored route when the effect changes and any older route the
      // new source holds on another pair. A flip whose new source already
      // routes elsewhere displaces two at once and can never be confirmed by a
      // single accepted-effect fact, so that shape is rejected outright.
      const displacedEffects: RelationRouteEffectFacts[] = [];
      if (oldEffect !== null && !effectUnchanged) {
        displacedEffects.push(oldEffect);
      }
      if (newEligibleRoute) {
        const otherRoute = this.findOutgoingEligibleRouteSync(
          newEligibleRoute.sourceEpicId,
          existing?.id,
        );
        if (otherRoute) {
          displacedEffects.push(otherRoute);
        }
      }
      if (displacedEffects.length > 1) {
        throw new ValidationError(
          'This change would displace two active time routes. Delete one Related pair explicitly first, then retry the change.',
          { displacedEffects },
        );
      }
      const displacedEffect = displacedEffects[0] ?? null;
      if (displacedEffect) {
        // Humans must echo the current route facts; agents never carry them.
        // Both surfaces receive the current target — the agent remedy is to
        // delete the displaced Related pair explicitly and retry.
        const accepted = data.acceptedRouteEffect;
        if (
          context.trustedLocalHuman !== true ||
          !accepted ||
          accepted.sourceEpicId !== displacedEffect.sourceEpicId ||
          accepted.targetEpicId !== displacedEffect.targetEpicId
        ) {
          throw new RelationConfirmationRequiredError(displacedEffect);
        }
      }
      if (newEligibleRoute) {
        this.assertNoEligibleRouteCycleSync(newEligibleRoute, existing?.id);
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      this.rawClient
        .prepare(
          `INSERT INTO epic_relations (
             id, left_epic_id, right_epic_id, type, direction,
             created_by, created_by_agent_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(left_epic_id, right_epic_id) DO UPDATE SET
             type = excluded.type,
             direction = excluded.direction,
             updated_at = excluded.updated_at`,
        )
        .run(id, leftEpicId, rightEpicId, type, direction, createdBy, createdByAgentId, now, now);
      if (newEligibleRoute) {
        this.deleteOutgoingEligibleRouteSync(
          newEligibleRoute.sourceEpicId,
          leftEpicId,
          rightEpicId,
        );
      }

      const row = this.rawClient
        .prepare(
          `SELECT id, left_epic_id, right_epic_id, type, direction,
                  created_by, created_by_agent_id, created_at, updated_at
           FROM epic_relations
           WHERE left_epic_id = ? AND right_epic_id = ?`,
        )
        .get(leftEpicId, rightEpicId) as EpicRelationRow;
      return {
        ...this.mapEpicRelation(row),
        changed: true,
        workspaceId: focal.workspace_id,
      };
    });
  }

  async deleteEpicRelation(
    epicId: string,
    relatedEpicId: string,
    context: EpicRelationWriteContext,
  ): Promise<DeleteEpicRelationResult> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const [focal, related] = this.validateRelationPairSync(epicId, relatedEpicId);
      this.authorizeRelationWriteSync(focal, related, context);
      const pair = this.canonicalRelationPair(focal.id, related.id);
      // Explicit pair deletion is the one unconfirmed way to remove a pair —
      // it is the remedy both surfaces use to clear an eligible route.
      const deleted =
        this.rawClient
          .prepare('DELETE FROM epic_relations WHERE left_epic_id = ? AND right_epic_id = ?')
          .run(pair.leftEpicId, pair.rightEpicId).changes > 0;
      return { deleted, workspaceId: focal.workspace_id };
    });
  }

  async listEpicRelations(
    epicId: string,
    options: ListEpicRelationsOptions = {},
  ): Promise<ListResult<EpicRelationListItem>> {
    const focal = this.getRelationContextSync(epicId);
    this.assertRelationReadWorkspace(focal, options);
    const limit = this.normalizeRelationListLimit(options.limit, 'Relation');
    const offset = this.normalizeRelationListOffset(options.offset, 'Relation');
    const relatedEpicId = options.relatedEpicId ?? null;
    const queryArgs = [
      epicId,
      epicId,
      epicId,
      options.excludeMcpHidden ? 1 : 0,
      relatedEpicId,
      relatedEpicId,
    ] as const;
    const count = this.rawClient
      .prepare(
        `SELECT COUNT(*) AS total
         FROM epic_relations relation
         INNER JOIN epics target
           ON target.id = CASE
             WHEN relation.left_epic_id = ? THEN relation.right_epic_id
             ELSE relation.left_epic_id
           END
         INNER JOIN statuses status ON status.id = target.status_id
         WHERE (relation.left_epic_id = ? OR relation.right_epic_id = ?)
           AND (? = 0 OR status.mcp_hidden = 0)
           AND (? IS NULL OR target.id = ?)`,
      )
      .get(...queryArgs) as { total: number };
    const rows = this.rawClient
      .prepare(
        `SELECT
           relation.id AS relation_id,
           relation.left_epic_id,
           relation.right_epic_id,
           relation.type,
           relation.direction,
           relation.created_at,
           relation.updated_at,
           target.id AS epic_id,
           target.project_id,
           project.name AS project_name,
           target.title,
           target.status_id,
           status.label AS status_label,
           status.color AS status_color,
           status.mcp_hidden AS status_mcp_hidden
         FROM epic_relations relation
         INNER JOIN epics target
           ON target.id = CASE
             WHEN relation.left_epic_id = ? THEN relation.right_epic_id
             ELSE relation.left_epic_id
           END
         INNER JOIN projects project ON project.id = target.project_id
         INNER JOIN statuses status ON status.id = target.status_id
         WHERE (relation.left_epic_id = ? OR relation.right_epic_id = ?)
           AND (? = 0 OR status.mcp_hidden = 0)
           AND (? IS NULL OR target.id = ?)
         ORDER BY lower(project.name), lower(target.title), target.id
         LIMIT ? OFFSET ?`,
      )
      .all(...queryArgs, limit, offset) as Array<{
      relation_id: string;
      left_epic_id: string;
      right_epic_id: string;
      type: StoredEpicRelationType;
      direction: EpicRelationDirection;
      created_at: string;
      updated_at: string;
      epic_id: string;
      project_id: string;
      project_name: string;
      title: string;
      status_id: string;
      status_label: string;
      status_color: string;
      status_mcp_hidden: number;
    }>;

    return {
      items: rows.map((row) => {
        const endpoints = resolveRelationEndpoints(
          row.left_epic_id,
          row.right_epic_id,
          row.direction,
        );
        return {
          relationId: row.relation_id,
          epicId: row.epic_id,
          projectId: row.project_id,
          projectName: row.project_name,
          title: row.title,
          statusId: row.status_id,
          statusLabel: row.status_label,
          statusColor: row.status_color,
          statusMcpHidden: Boolean(row.status_mcp_hidden),
          type: this.toFocalRelationType(epicId, row),
          sourceEpicId: endpoints?.sourceEpicId ?? null,
          targetEpicId: endpoints?.targetEpicId ?? null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }),
      total: count.total,
      limit,
      offset,
    };
  }

  async summarizeEpicRelationsBatch(
    epicIds: string[],
    options: EpicRelationReadOptions = {},
  ): Promise<Map<string, EpicRelationSummary>> {
    if (!Array.isArray(epicIds)) {
      throw new ValidationError('epicIds must be an array.');
    }
    const uniqueIds = Array.from(
      new Set(epicIds.map((id) => (typeof id === 'string' ? id.trim() : ''))),
    );
    if (uniqueIds.some((id) => id.length === 0)) {
      throw new ValidationError('epicIds must contain non-empty strings.');
    }
    if (uniqueIds.length > MAX_RELATION_BATCH_SIZE) {
      throw new ValidationError(`epicIds cannot contain more than ${MAX_RELATION_BATCH_SIZE} IDs.`);
    }

    if (uniqueIds.length === 0) return new Map();

    const rows = this.rawClient
      .prepare(
        `WITH requested(epic_id) AS (
           SELECT value FROM json_each(?)
         ), focal_relations AS (
           SELECT relation.left_epic_id AS epic_id,
                  relation.right_epic_id AS target_epic_id,
                  relation.type, relation.direction, 1 AS focal_is_left
           FROM epic_relations relation
           UNION ALL
           SELECT relation.right_epic_id AS epic_id,
                  relation.left_epic_id AS target_epic_id,
                  relation.type, relation.direction, 0 AS focal_is_left
           FROM epic_relations relation
         )
         SELECT
           focal.epic_id,
           SUM(CASE WHEN focal.type = 'related' THEN 1 ELSE 0 END) AS related,
           SUM(CASE WHEN focal.type = 'related' AND (
             (focal.focal_is_left = 1 AND focal.direction = 'left_to_right') OR
             (focal.focal_is_left = 0 AND focal.direction = 'right_to_left')
           ) THEN 1 ELSE 0 END) AS related_targets,
           SUM(CASE WHEN focal.type = 'related' AND (
             (focal.focal_is_left = 1 AND focal.direction = 'right_to_left') OR
             (focal.focal_is_left = 0 AND focal.direction = 'left_to_right')
           ) THEN 1 ELSE 0 END) AS related_sources,
           SUM(CASE WHEN focal.type = 'related' AND focal.direction = 'none' THEN 1 ELSE 0 END) AS related_neutral,
           SUM(CASE WHEN focal.type = 'blocks' AND (
             (focal.focal_is_left = 1 AND focal.direction = 'left_to_right') OR
             (focal.focal_is_left = 0 AND focal.direction = 'right_to_left')
           ) THEN 1 ELSE 0 END) AS blocks,
           SUM(CASE WHEN focal.type = 'blocks' AND (
             (focal.focal_is_left = 1 AND focal.direction = 'right_to_left') OR
             (focal.focal_is_left = 0 AND focal.direction = 'left_to_right')
           ) THEN 1 ELSE 0 END) AS blocked_by,
           COUNT(*) AS total
         FROM requested
         INNER JOIN focal_relations focal ON focal.epic_id = requested.epic_id
         INNER JOIN epics target ON target.id = focal.target_epic_id
         INNER JOIN statuses target_status ON target_status.id = target.status_id
         INNER JOIN epics focal_epic ON focal_epic.id = focal.epic_id
         INNER JOIN projects focal_project ON focal_project.id = focal_epic.project_id
         WHERE (? = 0 OR target_status.mcp_hidden = 0)
           AND (? IS NULL OR focal_project.workspace_id = ?)
         GROUP BY focal.epic_id`,
      )
      .all(
        JSON.stringify(uniqueIds),
        options.excludeMcpHidden ? 1 : 0,
        options.workspaceId ?? null,
        options.workspaceId ?? null,
      ) as Array<{
      epic_id: string;
      related: number;
      related_targets: number;
      related_sources: number;
      related_neutral: number;
      blocks: number;
      blocked_by: number;
      total: number;
    }>;

    return new Map(
      rows.map((row) => [
        row.epic_id,
        {
          epicId: row.epic_id,
          related: Number(row.related),
          relatedTargets: Number(row.related_targets),
          relatedSources: Number(row.related_sources),
          relatedNeutral: Number(row.related_neutral),
          blocks: Number(row.blocks),
          blockedBy: Number(row.blocked_by),
          total: Number(row.total),
        },
      ]),
    );
  }

  async listEpicRelationCandidates(
    epicId: string,
    options: ListEpicRelationCandidatesOptions = {},
  ): Promise<ListResult<EpicRelationCandidate>> {
    const focal = this.getRelationContextSync(epicId);
    this.assertRelationReadWorkspace(focal, options);
    const limit = this.normalizeRelationListLimit(options.limit, 'Relation candidate');
    const offset = this.normalizeRelationListOffset(options.offset, 'Relation candidate');
    const search = typeof options.q === 'string' ? options.q.trim().toLowerCase() : '';
    if (search.length > 200) {
      throw new ValidationError('Relation candidate search cannot exceed 200 characters.');
    }

    const conditions = [
      'project.workspace_id = ?',
      'project.is_template = 0',
      '(? = 0 OR status.mcp_hidden = 0)',
      'candidate.id <> ?',
      '(candidate.parent_id IS NULL OR candidate.parent_id <> ?)',
      '(? IS NULL OR candidate.id <> ?)',
      `NOT EXISTS (
         SELECT 1 FROM epic_relations existing
         WHERE (existing.left_epic_id = ? AND existing.right_epic_id = candidate.id)
            OR (existing.right_epic_id = ? AND existing.left_epic_id = candidate.id)
       )`,
    ];
    const parameters: Array<string | number | null> = [
      focal.workspace_id,
      options.excludeMcpHidden ? 1 : 0,
      focal.id,
      focal.id,
      focal.parent_id,
      focal.parent_id,
      focal.id,
      focal.id,
    ];
    if (search) {
      const escapedSearch = search.replace(/[\\%_]/g, '\\$&');
      conditions.push(
        `(lower(candidate.title) LIKE ? ESCAPE '\\'
          OR lower(substr(candidate.id, 1, ?)) = ?)`,
      );
      parameters.push(`%${escapedSearch}%`, search.length, search);
    }
    const where = conditions.join('\n AND ');
    const totalRow = this.rawClient
      .prepare(
        `SELECT COUNT(*) AS count
         FROM epics candidate
         INNER JOIN projects project ON project.id = candidate.project_id
         INNER JOIN statuses status ON status.id = candidate.status_id
         WHERE ${where}`,
      )
      .get(...parameters) as { count: number };
    const rows = this.rawClient
      .prepare(
        `SELECT candidate.id, candidate.project_id, project.name AS project_name,
                candidate.title, candidate.status_id, status.label AS status_label,
                status.color AS status_color, status.mcp_hidden AS status_mcp_hidden,
                candidate.parent_id
         FROM epics candidate
         INNER JOIN projects project ON project.id = candidate.project_id
         INNER JOIN statuses status ON status.id = candidate.status_id
         WHERE ${where}
         ORDER BY lower(project.name), lower(candidate.title), candidate.id
         LIMIT ? OFFSET ?`,
      )
      .all(...parameters, limit, offset) as Array<{
      id: string;
      project_id: string;
      project_name: string;
      title: string;
      status_id: string;
      status_label: string;
      status_color: string;
      status_mcp_hidden: number;
      parent_id: string | null;
    }>;

    return {
      items: rows.map((row) => this.mapRelationCandidate(row)),
      total: Number(totalRow.count),
      limit,
      offset,
    };
  }

  async getWorkspaceEpicsByIdPrefix(
    epicId: string,
    prefix: string,
    options: EpicRelationReadOptions = {},
  ): Promise<EpicRelationCandidate[]> {
    const focal = this.getRelationContextSync(epicId);
    this.assertRelationReadWorkspace(focal, options);
    const normalizedPrefix = typeof prefix === 'string' ? prefix.trim().toLowerCase() : '';
    if (!/^[a-f0-9-]{8,36}$/.test(normalizedPrefix)) {
      return [];
    }
    const rows = this.rawClient
      .prepare(
        `SELECT candidate.id, candidate.project_id, project.name AS project_name,
                candidate.title, candidate.status_id, status.label AS status_label,
                status.color AS status_color, status.mcp_hidden AS status_mcp_hidden,
                candidate.parent_id
         FROM epics candidate
         INNER JOIN projects project ON project.id = candidate.project_id
         INNER JOIN statuses status ON status.id = candidate.status_id
         WHERE project.workspace_id = ?
           AND project.is_template = 0
           AND (? = 0 OR status.mcp_hidden = 0)
           AND candidate.id <> ?
           AND lower(substr(candidate.id, 1, ?)) = ?
         ORDER BY candidate.id
         LIMIT ?`,
      )
      .all(
        focal.workspace_id,
        options.excludeMcpHidden ? 1 : 0,
        focal.id,
        normalizedPrefix.length,
        normalizedPrefix,
        MAX_RELATION_PREFIX_RESULTS,
      ) as Array<{
      id: string;
      project_id: string;
      project_name: string;
      title: string;
      status_id: string;
      status_label: string;
      status_color: string;
      status_mcp_hidden: number;
      parent_id: string | null;
    }>;
    return rows.map((row) => this.mapRelationCandidate(row));
  }

  private validateRelationPairSync(
    epicId: string,
    relatedEpicId: string,
  ): [EpicRelationContextRow, EpicRelationContextRow] {
    if (typeof epicId !== 'string' || typeof relatedEpicId !== 'string') {
      throw new ValidationError('Relation Epic IDs must be strings.');
    }
    if (epicId === relatedEpicId) {
      throw new ValidationError('An Epic cannot have a relation to itself.', { epicId });
    }
    const focal = this.getRelationContextSync(epicId);
    let related: EpicRelationContextRow;
    try {
      related = this.getRelationContextSync(relatedEpicId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new NotFoundError('Related Epic');
      }
      throw error;
    }
    if (focal.workspace_id !== related.workspace_id) {
      throw new NotFoundError('Related Epic');
    }
    if (focal.parent_id === related.id || related.parent_id === focal.id) {
      throw new ValidationError('A parent and direct sub-Epic cannot have a relation.', {
        epicId,
        relatedEpicId,
      });
    }
    return [focal, related];
  }

  private authorizeRelationWriteSync(
    focal: EpicRelationContextRow,
    related: EpicRelationContextRow,
    context: EpicRelationWriteContext | undefined,
  ): void {
    if (context?.actor?.type === 'guest') {
      throw new ForbiddenError('Guests cannot write Epic relations.');
    }
    if (context?.trustedLocalHuman === true && !context.actor) {
      return;
    }
    if (context?.actor?.type !== 'agent') {
      throw new ForbiddenError('An authorized relation writer is required.');
    }

    const currentAgent = this.rawClient
      .prepare('SELECT project_id, is_project_owner FROM agents WHERE id = ?')
      .get(context.actor.id) as { project_id: string; is_project_owner: number } | undefined;
    if (!currentAgent || currentAgent.project_id !== focal.project_id) {
      throw new ForbiddenError('The caller must currently belong to the focal Epic project.');
    }
    if (related.project_id !== focal.project_id && !Boolean(currentAgent.is_project_owner)) {
      throw new ForbiddenError(
        'Cross-project Epic relations require the focal project current Project Owner.',
      );
    }
  }

  private assertRelationReadWorkspace(
    focal: EpicRelationContextRow,
    options: EpicRelationReadOptions,
  ): void {
    if (options.workspaceId && focal.workspace_id !== options.workspaceId) {
      throw new NotFoundError('Epic');
    }
  }

  private getRelationContextSync(epicId: string): EpicRelationContextRow {
    const row = this.rawClient
      .prepare(
        `SELECT epic.id, epic.project_id, project.workspace_id, epic.parent_id
         FROM epics epic
         INNER JOIN projects project ON project.id = epic.project_id
         WHERE epic.id = ?`,
      )
      .get(epicId) as EpicRelationContextRow | undefined;
    if (!row) {
      throw new NotFoundError('Epic', epicId);
    }
    return row;
  }

  private canonicalRelationPair(
    epicId: string,
    relatedEpicId: string,
  ): { leftEpicId: string; rightEpicId: string } {
    return epicId < relatedEpicId
      ? { leftEpicId: epicId, rightEpicId: relatedEpicId }
      : { leftEpicId: relatedEpicId, rightEpicId: epicId };
  }

  /**
   * The write's focal Epic is the semantic source; the related Epic is the
   * target. Related rows therefore never store direction 'none' — legacy
   * 'none' rows from pre-feature databases stay readable but cannot be
   * re-created. For Blocks, direction keeps encoding which side blocks the
   * other, unchanged.
   */
  private toStoredRelation(
    focalEpicId: string,
    leftEpicId: string,
    focalType: EpicRelationType,
  ): { type: StoredEpicRelationType; direction: EpicRelationDirection } {
    const focalIsLeft = focalEpicId === leftEpicId;
    if (focalType === 'related') {
      return { type: 'related', direction: focalIsLeft ? 'left_to_right' : 'right_to_left' };
    }
    if (focalType !== 'blocks' && focalType !== 'blocked_by') {
      throw new ValidationError('Relation type must be related, blocks, or blocked_by.');
    }
    const leftBlocksRight = focalType === 'blocks' ? focalIsLeft : !focalIsLeft;
    return {
      type: 'blocks',
      direction: leftBlocksRight ? 'left_to_right' : 'right_to_left',
    };
  }

  /**
   * Eligibility cannot live in an index: it depends on the endpoint Epic rows
   * (both roots, one project). This predicate is shared by every route-owning
   * query so ownership, cycles, and the reparent guard all see the same
   * eligible subset of Related pairs.
   */
  private static readonly ELIGIBLE_ROUTE_SOURCE_PREDICATE = `
      relation.type = 'related'
      AND relation.direction != 'none'
      AND left_epic.parent_id IS NULL
      AND right_epic.parent_id IS NULL
      AND left_epic.project_id = right_epic.project_id
      AND (
        (relation.left_epic_id = ? AND relation.direction = 'left_to_right')
        OR (relation.right_epic_id = ? AND relation.direction = 'right_to_left')
      )`;

  /**
   * Walks the post-change route graph from the proposed target; reaching the
   * proposed source again means the route closes a cycle. The row being
   * replaced stops contributing its old edge, so replacements are judged
   * against the graph that exists after this transaction commits.
   */
  private assertNoEligibleRouteCycleSync(
    newEffect: RelationRouteEffectFacts,
    replacedRowId?: string,
  ): void {
    const outgoing = this.rawClient.prepare(
      `SELECT relation.id, relation.left_epic_id, relation.right_epic_id, relation.direction
       FROM epic_relations relation
       INNER JOIN epics left_epic ON left_epic.id = relation.left_epic_id
       INNER JOIN epics right_epic ON right_epic.id = relation.right_epic_id
       WHERE${EpicStorageDelegate.ELIGIBLE_ROUTE_SOURCE_PREDICATE}`,
    );
    const visited = new Set<string>([newEffect.targetEpicId]);
    let current = newEffect.targetEpicId;
    for (let step = 0; step <= MAX_RELATION_BATCH_SIZE; step++) {
      if (current === newEffect.sourceEpicId) {
        throw new ValidationError('A time route cannot form a cycle.', {
          sourceEpicId: newEffect.sourceEpicId,
          targetEpicId: newEffect.targetEpicId,
        });
      }
      const edge = outgoing.get(current, current) as
        | {
            id: string;
            left_epic_id: string;
            right_epic_id: string;
            direction: EpicRelationDirection;
          }
        | undefined;
      if (!edge || edge.id === replacedRowId) {
        return;
      }
      const effect = resolveRelationEndpoints(
        edge.left_epic_id,
        edge.right_epic_id,
        edge.direction,
      );
      if (!effect || visited.has(effect.targetEpicId)) {
        return;
      }
      visited.add(effect.targetEpicId);
      current = effect.targetEpicId;
    }
  }

  private findOutgoingEligibleRouteSync(
    sourceEpicId: string,
    excludedRowId?: string,
  ): RelationRouteEffectFacts | null {
    const row = this.rawClient
      .prepare(
        `SELECT relation.id, relation.left_epic_id, relation.right_epic_id, relation.direction
         FROM epic_relations relation
         INNER JOIN epics left_epic ON left_epic.id = relation.left_epic_id
         INNER JOIN epics right_epic ON right_epic.id = relation.right_epic_id
         WHERE${EpicStorageDelegate.ELIGIBLE_ROUTE_SOURCE_PREDICATE}
         LIMIT 1`,
      )
      .get(sourceEpicId, sourceEpicId) as
      | {
          id: string;
          left_epic_id: string;
          right_epic_id: string;
          direction: EpicRelationDirection;
        }
      | undefined;
    if (!row || row.id === excludedRowId) {
      return null;
    }
    return resolveRelationEndpoints(row.left_epic_id, row.right_epic_id, row.direction);
  }

  /**
   * A confirmed replacement deletes the source's previous outgoing eligible
   * pair: the pair cannot stay behind as a plain link because every Related
   * pair is directional and would keep routing time.
   */
  private deleteOutgoingEligibleRouteSync(
    sourceEpicId: string,
    keepLeftEpicId: string,
    keepRightEpicId: string,
  ): void {
    this.rawClient
      .prepare(
        `DELETE FROM epic_relations
         WHERE id IN (
           SELECT relation.id
           FROM epic_relations relation
           INNER JOIN epics left_epic ON left_epic.id = relation.left_epic_id
           INNER JOIN epics right_epic ON right_epic.id = relation.right_epic_id
           WHERE${EpicStorageDelegate.ELIGIBLE_ROUTE_SOURCE_PREDICATE}
         )
         AND NOT (left_epic_id = ? AND right_epic_id = ?)`,
      )
      .run(sourceEpicId, sourceEpicId, keepLeftEpicId, keepRightEpicId);
  }

  /**
   * An eligible route endpoint must stay a root Epic; reparenting it would
   * silently destroy the route's eligibility, so the pair must be deleted
   * explicitly first. Ineligible Related links never block reparenting.
   */
  private ensureEpicIsNotRouteEndpointSync(epicId: string): void {
    const routed = this.rawClient
      .prepare(
        `SELECT relation.left_epic_id, relation.right_epic_id
         FROM epic_relations relation
         INNER JOIN epics left_epic ON left_epic.id = relation.left_epic_id
         INNER JOIN epics right_epic ON right_epic.id = relation.right_epic_id
         WHERE relation.type = 'related'
           AND relation.direction != 'none'
           AND left_epic.parent_id IS NULL
           AND right_epic.parent_id IS NULL
           AND left_epic.project_id = right_epic.project_id
           AND (relation.left_epic_id = ? OR relation.right_epic_id = ?)
         LIMIT 1`,
      )
      .get(epicId, epicId) as { left_epic_id: string; right_epic_id: string } | undefined;
    if (routed) {
      throw new ValidationError(
        'Delete the eligible Related pair explicitly before reparenting one of its endpoints.',
        { epicId, leftEpicId: routed.left_epic_id, rightEpicId: routed.right_epic_id },
      );
    }
  }

  /**
   * Runs inside the Epic update's versioned transaction before the row
   * changes, so eligibility is evaluated hypothetically: the promoted Epic
   * counts as a root on both sides of every predicate. A promotion activates
   * the directional Related rows whose other endpoint is a root Epic of the
   * same project — those newly eligible routes must leave every source with
   * at most one eligible target (a pre-existing route of another source
   * counts too) and must not close a cycle.
   */
  private assertPromotionKeepsEligibleRoutesSync(epicId: string, projectId: string): void {
    const newlyEligible = this.rawClient
      .prepare(
        `SELECT CASE WHEN relation.direction = 'left_to_right'
                  THEN relation.left_epic_id ELSE relation.right_epic_id END AS source_id,
                CASE WHEN relation.direction = 'left_to_right'
                  THEN relation.right_epic_id ELSE relation.left_epic_id END AS target_id
         FROM epic_relations relation
         INNER JOIN epics other
           ON other.id = CASE
             WHEN relation.left_epic_id = ? THEN relation.right_epic_id
             ELSE relation.left_epic_id END
         WHERE relation.type = 'related'
           AND relation.direction != 'none'
           AND (relation.left_epic_id = ? OR relation.right_epic_id = ?)
           AND other.parent_id IS NULL
           AND other.project_id = ?`,
      )
      .all(epicId, epicId, epicId, projectId) as Array<{
      source_id: string;
      target_id: string;
    }>;
    if (newlyEligible.length === 0) {
      return;
    }

    // Ownership over the post-change graph: any source holding two or more
    // eligible outgoing routes after the promotion is a hard rejection,
    // including a second target activated on an already-routing source.
    const duplicateSource = this.rawClient
      .prepare(
        `SELECT CASE WHEN relation.direction = 'left_to_right'
                  THEN relation.left_epic_id ELSE relation.right_epic_id END AS source_id,
                COUNT(*) AS route_count
         FROM epic_relations relation
         INNER JOIN epics left_epic ON left_epic.id = relation.left_epic_id
         INNER JOIN epics right_epic ON right_epic.id = relation.right_epic_id
         WHERE relation.type = 'related'
           AND relation.direction != 'none'
           AND (left_epic.parent_id IS NULL OR left_epic.id = ?)
           AND (right_epic.parent_id IS NULL OR right_epic.id = ?)
           AND left_epic.project_id = right_epic.project_id
         GROUP BY source_id
         HAVING COUNT(*) > 1
         LIMIT 1`,
      )
      .get(epicId, epicId) as { source_id: string; route_count: number } | undefined;
    if (duplicateSource) {
      throw new ValidationError(
        'Promoting this Epic would activate more than one eligible time route from one source. Delete the extra Related pair explicitly first.',
        {
          epicId,
          sourceEpicId: duplicateSource.source_id,
          routeCount: duplicateSource.route_count,
        },
      );
    }

    // Acyclicity over the post-change graph: the pre-existing graph is
    // acyclic, so only a newly eligible edge can close a cycle. Each edge is
    // walked from its target with the promoted Epic counting as a root.
    const outgoing = this.rawClient.prepare(
      `SELECT relation.left_epic_id, relation.right_epic_id, relation.direction
       FROM epic_relations relation
       INNER JOIN epics left_epic ON left_epic.id = relation.left_epic_id
       INNER JOIN epics right_epic ON right_epic.id = relation.right_epic_id
       WHERE relation.type = 'related'
         AND relation.direction != 'none'
         AND (left_epic.parent_id IS NULL OR left_epic.id = ?)
         AND (right_epic.parent_id IS NULL OR right_epic.id = ?)
         AND left_epic.project_id = right_epic.project_id
         AND (
           (relation.left_epic_id = ? AND relation.direction = 'left_to_right')
           OR (relation.right_epic_id = ? AND relation.direction = 'right_to_left')
         )`,
    );
    for (const edge of newlyEligible) {
      const visited = new Set<string>([edge.target_id]);
      let current = edge.target_id;
      for (let step = 0; step <= MAX_RELATION_BATCH_SIZE; step++) {
        if (current === edge.source_id) {
          throw new ValidationError(
            'Promoting this Epic would complete a time-route cycle. Delete one Related pair explicitly first.',
            { epicId, sourceEpicId: edge.source_id, targetEpicId: edge.target_id },
          );
        }
        const next = outgoing.get(epicId, epicId, current, current) as
          | {
              left_epic_id: string;
              right_epic_id: string;
              direction: EpicRelationDirection;
            }
          | undefined;
        if (!next) {
          break;
        }
        const effect = resolveRelationEndpoints(
          next.left_epic_id,
          next.right_epic_id,
          next.direction,
        );
        if (!effect || visited.has(effect.targetEpicId)) {
          break;
        }
        visited.add(effect.targetEpicId);
        current = effect.targetEpicId;
      }
    }
  }

  private toFocalRelationType(
    focalEpicId: string,
    relation: Pick<EpicRelationRow, 'left_epic_id' | 'right_epic_id' | 'type' | 'direction'>,
  ): EpicRelationType {
    if (relation.type === 'related') {
      return 'related';
    }
    const focalIsLeft = focalEpicId === relation.left_epic_id;
    const focalBlocks =
      (focalIsLeft && relation.direction === 'left_to_right') ||
      (!focalIsLeft && relation.direction === 'right_to_left');
    return focalBlocks ? 'blocks' : 'blocked_by';
  }

  private mapEpicRelation(row: EpicRelationRow): EpicRelation {
    const endpoints = resolveRelationEndpoints(row.left_epic_id, row.right_epic_id, row.direction);
    return {
      id: row.id,
      leftEpicId: row.left_epic_id,
      rightEpicId: row.right_epic_id,
      type: row.type,
      direction: row.direction,
      sourceEpicId: endpoints?.sourceEpicId ?? null,
      targetEpicId: endpoints?.targetEpicId ?? null,
      createdBy: row.created_by,
      createdByAgentId: row.created_by_agent_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRelationCandidate(row: {
    id: string;
    project_id: string;
    project_name: string;
    title: string;
    status_id: string;
    status_label: string;
    status_color: string;
    status_mcp_hidden: number;
    parent_id: string | null;
  }): EpicRelationCandidate {
    return {
      id: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      title: row.title,
      statusId: row.status_id,
      statusLabel: row.status_label,
      statusColor: row.status_color,
      statusMcpHidden: Boolean(row.status_mcp_hidden),
      parentId: row.parent_id,
    };
  }

  private normalizeRelationListLimit(limit: number | undefined, label: string): number {
    if (limit === undefined) return 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RELATION_LIST_LIMIT) {
      throw new ValidationError(`${label} limit must be between 1 and ${MAX_RELATION_LIST_LIMIT}.`);
    }
    return limit;
  }

  private normalizeRelationListOffset(offset: number | undefined, label: string): number {
    if (offset === undefined) return 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ValidationError(`${label} offset must be a non-negative integer.`);
    }
    return offset;
  }

  private ensureValidEpicParentSync(
    projectId: string,
    parentId?: string | null,
    childId?: string,
  ): void {
    if (!parentId) {
      return;
    }

    if (childId && parentId === childId) {
      throw new ValidationError('An epic cannot be its own parent.', {
        epicId: childId,
        parentId,
      });
    }

    const parent = this.getEpicSync(parentId);

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
      const existingRelation = this.rawClient
        .prepare(
          `SELECT 1 FROM epic_relations
           WHERE (left_epic_id = ? AND right_epic_id = ?)
              OR (left_epic_id = ? AND right_epic_id = ?)
           LIMIT 1`,
        )
        .get(childId, parentId, parentId, childId);
      if (existingRelation) {
        throw new ValidationError('A parent and direct sub-Epic cannot have a relation.', {
          epicId: childId,
          parentId,
        });
      }

      const descendants = this.db
        .select({ id: epicsTable.id })
        .from(epicsTable)
        .where(eqSync(epicsTable.parentId, childId))
        .all();

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

  private ensureValidAgentSync(projectId: string, agentId?: string | null): void {
    if (!agentId) {
      return;
    }

    const agent = this.dependencies.getAgent(agentId);
    if (agent.projectId !== projectId) {
      throw new ValidationError('Agent must belong to the same project as the epic.', {
        projectId,
        agentProjectId: agent.projectId,
        agentId,
      });
    }
  }

  private setEpicTagsSync(
    epicId: string,
    tagNames: string[],
    projectId: string,
    now: string,
  ): void {
    this.db.delete(epicTagsTable).where(eqSync(epicTagsTable.epicId, epicId)).run();

    for (const tagName of tagNames) {
      const existing = this.db
        .select()
        .from(tagsTable)
        .where(
          andSync(
            eqSync(tagsTable.name, tagName),
            orSync(eqSync(tagsTable.projectId, projectId), isNullSync(tagsTable.projectId)),
          ),
        )
        .limit(1)
        .get();
      const tag = existing ?? this.dependencies.createTag({ projectId, name: tagName });

      this.db.insert(epicTagsTable).values({ epicId, tagId: tag.id, createdAt: now }).run();
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
