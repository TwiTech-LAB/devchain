import { Injectable, Inject } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DB_CONNECTION } from '../db/db.provider';
import {
  StorageService,
  ListOptions,
  ListResult,
  DocumentListFilters,
  DocumentIdentifier,
  ListProjectEpicsOptions,
  ListAssignedEpicsOptions,
  ListSubEpicsForParentsOptions,
  CreateEpicForProjectInput,
  ProfileListOptions,
  PromptListFilters,
  PromptSummary,
  ListReviewsOptions,
  ListReviewCommentsOptions,
} from '../interfaces/storage.interface';
import {
  Project,
  CreateProject,
  UpdateProject,
  Status,
  CreateStatus,
  UpdateStatus,
  Epic,
  CreateEpic,
  UpdateEpic,
  Prompt,
  CreatePrompt,
  UpdatePrompt,
  Tag,
  CreateTag,
  UpdateTag,
  Provider,
  CreateProvider,
  UpdateProvider,
  ProviderMcpMetadata,
  UpdateProviderMcpMetadata,
  AgentProfile,
  CreateAgentProfile,
  UpdateAgentProfile,
  Agent,
  CreateAgent,
  UpdateAgent,
  EpicRecord,
  CreateEpicRecord,
  UpdateEpicRecord,
  EpicComment,
  CreateEpicComment,
  Document,
  CreateDocument,
  UpdateDocument,
  Guest,
  CreateGuest,
  Watcher,
  CreateWatcher,
  UpdateWatcher,
  Subscriber,
  CreateSubscriber,
  UpdateSubscriber,
  Review,
  CreateReview,
  UpdateReview,
  ReviewComment,
  ReviewCommentEnriched,
  ReviewCommentTargetAgent,
  CreateReviewComment,
  UpdateReviewComment,
  ReviewCommentTarget,
} from '../models/domain.models';
import {
  NotFoundError,
  OptimisticLockError,
  ValidationError,
  ConflictError,
  StorageError,
} from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
// Prefer Drizzle; raw sqlite access is encapsulated in db/sqlite-raw if needed
import { getRawSqliteClient } from '../db/sqlite-raw';
import {
  DEFAULT_FEATURE_FLAGS,
  type FeatureFlagConfig,
} from '../../../common/config/feature-flags';

const logger = createLogger('LocalStorageService');

/**
 * LocalStorage implementation of StorageService
 * Uses Drizzle ORM with SQLite (better-sqlite3)
 *
 * NOTE: This implementation requires database schemas from task 004.
 * The actual Drizzle queries will be implemented once schemas are available.
 * Current implementation provides the structure and error handling patterns.
 */
@Injectable()
export class LocalStorageService implements StorageService {
  constructor(@Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database) {
    logger.info('LocalStorageService initialized');
  }

  getFeatureFlags(): FeatureFlagConfig {
    return { ...DEFAULT_FEATURE_FLAGS };
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
      const { epics } = await import('../db/schema');
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
   *
   * @param projectId - Project ID to constrain the CTE
   * @param epicsTable - Reference to the epics table from schema
   * @returns SQL predicate for use in WHERE clause conditions
   */
  private async buildMcpHiddenExclusionPredicate(
    projectId: string,
    epicsTable: typeof import('../db/schema').epics,
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

    const agent = await this.getAgent(agentId);
    if (agent.projectId !== projectId) {
      throw new ValidationError('Agent must belong to the same project as the epic.', {
        projectId,
        agentProjectId: agent.projectId,
        agentId,
      });
    }
  }

  // Projects
  async createProject(data: CreateProject): Promise<Project> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      ...data,
      isTemplate: data.isTemplate ?? false,
      createdAt: now,
      updatedAt: now,
    };

    const { projects, statuses } = await import('../db/schema');

    await this.db.transaction(async (tx) => {
      await tx.insert(projects).values({
        id: project.id,
        name: project.name,
        description: project.description,
        rootPath: project.rootPath,
        isTemplate: project.isTemplate,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      });

      // Create default statuses atomically with project
      const defaultStatuses = [
        { label: 'Proposed', color: '#6c757d', position: 0 },
        { label: 'In Progress', color: '#007bff', position: 1 },
        { label: 'Review', color: '#ffc107', position: 2 },
        { label: 'Done', color: '#28a745', position: 3 },
        { label: 'Blocked', color: '#dc3545', position: 4 },
      ];

      for (const status of defaultStatuses) {
        await tx.insert(statuses).values({
          id: randomUUID(),
          projectId: project.id,
          label: status.label,
          color: status.color,
          position: status.position,
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    logger.info({ projectId: project.id }, 'Created project with default statuses (transactional)');
    return project;
  }

  async createProjectWithTemplate(
    data: CreateProject,
    template: import('../interfaces/storage.interface').TemplateImportPayload,
  ): Promise<import('../interfaces/storage.interface').CreateProjectWithTemplateResult> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      ...data,
      isTemplate: data.isTemplate ?? false,
      createdAt: now,
      updatedAt: now,
    };

    const { projects, statuses, prompts, agentProfiles, agents, tags, promptTags } = await import(
      '../db/schema'
    );

    const statusIdMap: Record<string, string> = {};
    const promptIdMap: Record<string, string> = {};
    const profileIdMap: Record<string, string> = {};
    const agentIdMap: Record<string, string> = {};
    const createdPrompts: Array<{ id: string; title: string }> = [];

    // NOTE: Using raw SQL transaction control instead of Drizzle's transaction() method
    // Reason: Drizzle's transaction wrapper with better-sqlite3 does NOT properly rollback
    // on errors. Testing revealed that when ValidationError is thrown during agent creation,
    // the error is caught and logged as "rolled back" but database changes persist.
    // Root cause: Drizzle's transaction implementation may not properly handle Error subclasses
    // or has issues with better-sqlite3 in WAL mode.
    // Solution: Use getRawSqliteClient helper to obtain the underlying better-sqlite3 client,
    // then use raw SQL BEGIN/COMMIT/ROLLBACK for guaranteed atomicity.
    //
    // WAL Mode Considerations:
    // - WAL (Write-Ahead Logging) allows concurrent readers during writes
    // - BEGIN IMMEDIATE ensures write lock is acquired immediately, preventing concurrent writes
    // - This prevents "database is locked" errors in multi-threaded scenarios
    // - ROLLBACK is guaranteed to undo all changes since BEGIN, even across multiple statements
    const sqlite = getRawSqliteClient(this.db);
    if (!sqlite || typeof sqlite.exec !== 'function') {
      throw new StorageError('Unable to access underlying SQLite client for transaction control');
    }

    sqlite.exec('BEGIN IMMEDIATE TRANSACTION');

    try {
      // 1. Create project
      await this.db.insert(projects).values({
        id: project.id,
        name: project.name,
        description: project.description,
        rootPath: project.rootPath,
        isTemplate: project.isTemplate,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      });

      // 2. Create statuses from template
      for (const s of template.statuses.sort((a, b) => a.position - b.position)) {
        const statusId = randomUUID();
        await this.db.insert(statuses).values({
          id: statusId,
          projectId: project.id,
          label: s.label,
          color: s.color,
          position: s.position,
          mcpHidden: s.mcpHidden ?? false,
          createdAt: now,
          updatedAt: now,
        });
        if (s.id) statusIdMap[s.id] = statusId;
      }

      // 3. Create prompts from template with tags
      const { eq, and, or, isNull } = await import('drizzle-orm');
      for (const p of template.prompts) {
        const promptId = randomUUID();
        await this.db.insert(prompts).values({
          id: promptId,
          projectId: project.id,
          title: p.title,
          content: p.content ?? '',
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        if (p.id) promptIdMap[p.id] = promptId;
        createdPrompts.push({ id: promptId, title: p.title });

        // Handle tags for this prompt
        if (p.tags?.length) {
          for (const tagName of p.tags) {
            // Find or create the tag
            let tag = await this.db
              .select()
              .from(tags)
              .where(
                and(
                  eq(tags.name, tagName),
                  or(eq(tags.projectId, project.id), isNull(tags.projectId)),
                ),
              )
              .limit(1);

            if (!tag[0]) {
              const tagId = randomUUID();
              await this.db.insert(tags).values({
                id: tagId,
                projectId: project.id,
                name: tagName,
                createdAt: now,
                updatedAt: now,
              });
              tag = [
                { id: tagId, projectId: project.id, name: tagName, createdAt: now, updatedAt: now },
              ];
            }

            // Create prompt-tag junction
            await this.db.insert(promptTags).values({
              promptId,
              tagId: tag[0].id,
              createdAt: now,
            });
          }
        }
      }

      // 4. Create profiles from template
      for (const prof of template.profiles) {
        const profileId = randomUUID();
        await this.db.insert(agentProfiles).values({
          id: profileId,
          projectId: project.id,
          name: prof.name,
          providerId: prof.providerId,
          familySlug: prof.familySlug ?? null,
          options: prof.options,
          systemPrompt: null,
          instructions: prof.instructions,
          // Temperature stored as integer (×100) to match createAgentProfile convention
          temperature: prof.temperature != null ? Math.round(prof.temperature * 100) : null,
          maxTokens: prof.maxTokens,
          createdAt: now,
          updatedAt: now,
        });
        if (prof.id) profileIdMap[prof.id] = profileId;
      }

      // 5. Create agents from template (remap profile ids)
      for (const a of template.agents) {
        const oldProfileId = a.profileId ?? '';
        const newProfileId =
          oldProfileId && profileIdMap[oldProfileId] ? profileIdMap[oldProfileId] : undefined;
        if (!newProfileId) {
          throw new ValidationError(`Profile mapping missing for agent ${a.name}`, {
            profileId: oldProfileId || null,
          });
        }
        const agentId = randomUUID();
        await this.db.insert(agents).values({
          id: agentId,
          projectId: project.id,
          name: a.name,
          profileId: newProfileId,
          description: a.description ?? null,
          createdAt: now,
          updatedAt: now,
        });
        if (a.id) agentIdMap[a.id] = agentId;
      }

      // If we reached here, all operations succeeded - commit the transaction
      sqlite.exec('COMMIT');

      logger.info(
        { projectId: project.id, counts: template },
        'Created project with template (transactional)',
      );
    } catch (error) {
      // Rollback transaction on any error
      try {
        sqlite.exec('ROLLBACK');
        logger.info({ projectId: project.id }, 'Transaction rolled back successfully');
      } catch (rollbackError) {
        logger.error({ rollbackError }, 'Failed to rollback transaction');
      }
      logger.error({ error, projectId: project.id }, 'Transaction failed');
      throw error;
    }

    return {
      project,
      imported: {
        prompts: template.prompts.length,
        profiles: template.profiles.length,
        agents: template.agents.length,
        statuses: template.statuses.length,
      },
      mappings: {
        promptIdMap,
        profileIdMap,
        agentIdMap,
        statusIdMap,
      },
      initialPromptSet: false, // Will be set by controller if needed
    };
  }

  async getProject(id: string): Promise<Project> {
    const { projects } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const result = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!result[0]) {
      throw new NotFoundError('Project', id);
    }
    const row = result[0] as Record<string, unknown>;
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      rootPath: row.rootPath,
      isTemplate: Boolean(row.isTemplate ?? false),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as Project;
  }

  async findProjectByPath(path: string): Promise<Project | null> {
    const { projects } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const result = await this.db
      .select()
      .from(projects)
      .where(eq(projects.rootPath, path))
      .limit(1);
    if (!result[0]) return null;
    const row = result[0] as Record<string, unknown>;
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      rootPath: row.rootPath,
      isTemplate: Boolean(row.isTemplate ?? false),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as Project;
  }

  async listProjects(options: ListOptions = {}): Promise<ListResult<Project>> {
    const { projects } = await import('../db/schema');
    const { sql } = await import('drizzle-orm');
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const items = await this.db.select().from(projects).limit(limit).offset(offset);
    const countResult = await this.db.select({ count: sql<number>`count(*)` }).from(projects);
    const total = Number(countResult[0]?.count ?? 0);

    const mapped = (items as Array<Record<string, unknown>>).map(
      (row) =>
        ({
          id: row.id,
          name: row.name,
          description: row.description ?? null,
          rootPath: row.rootPath,
          isTemplate: Boolean(row.isTemplate ?? false),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }) as Project,
    );

    return {
      items: mapped,
      total,
      limit,
      offset,
    };
  }

  async updateProject(id: string, data: UpdateProject): Promise<Project> {
    const { projects } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    await this.db
      .update(projects)
      .set({ ...data, updatedAt: now })
      .where(eq(projects.id, id));

    return this.getProject(id);
  }

  async deleteProject(id: string): Promise<void> {
    const {
      projects,
      chatThreads,
      chatMessages,
      chatMembers,
      chatMessageTargets,
      chatMessageReads,
      chatThreadSessionInvites,
      chatActivities,
      sessions,
      transcripts,
      epicComments,
      records,
      recordTags,
      epicTags,
      epics,
      documents,
      documentTags,
      prompts,
      promptTags,
      agentProfilePrompts,
      agents,
      agentProfiles,
      tags,
      statuses,
      guests,
    } = await import('../db/schema');
    const { eq, inArray } = await import('drizzle-orm');

    // Manual cascade delete to handle foreign key constraints properly
    // Order matters: delete children before parents

    // Get all IDs we'll need for cascade deletion
    const projectEpics = await this.db
      .select({ id: epics.id })
      .from(epics)
      .where(eq(epics.projectId, id));
    const epicIds = projectEpics.map((e) => e.id);

    const projectChatThreads = await this.db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.projectId, id));
    const threadIds = projectChatThreads.map((t) => t.id);

    const projectMessages =
      threadIds.length > 0
        ? await this.db
            .select({ id: chatMessages.id })
            .from(chatMessages)
            .where(inArray(chatMessages.threadId, threadIds))
        : [];
    const messageIds = projectMessages.map((m) => m.id);

    const projectAgents = await this.db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.projectId, id));
    const agentIds = projectAgents.map((a) => a.id);

    const projectDocs = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.projectId, id));
    const docIds = projectDocs.map((d) => d.id);

    const projectPrompts = await this.db
      .select({ id: prompts.id })
      .from(prompts)
      .where(eq(prompts.projectId, id));
    const promptIds = projectPrompts.map((p) => p.id);

    const projectProfiles = await this.db
      .select({ id: agentProfiles.id })
      .from(agentProfiles)
      .where(eq(agentProfiles.projectId, id));
    const profileIds = projectProfiles.map((p) => p.id);

    const projectTags = await this.db
      .select({ id: tags.id })
      .from(tags)
      .where(eq(tags.projectId, id));
    const tagIds = projectTags.map((t) => t.id);

    const projectSessions =
      agentIds.length > 0
        ? await this.db
            .select({ id: sessions.id })
            .from(sessions)
            .where(inArray(sessions.agentId, agentIds))
        : [];
    const sessionIds = projectSessions.map((s) => s.id);

    // Delete in order: deepest children first

    // 1. Chat message-related records
    if (messageIds.length > 0) {
      await this.db.delete(chatMessageReads).where(inArray(chatMessageReads.messageId, messageIds));
      await this.db
        .delete(chatMessageTargets)
        .where(inArray(chatMessageTargets.messageId, messageIds));
      await this.db
        .delete(chatThreadSessionInvites)
        .where(inArray(chatThreadSessionInvites.inviteMessageId, messageIds));
    }

    // 2. Chat activities, members, and other agent-related chat records
    if (agentIds.length > 0) {
      await this.db.delete(chatMessageReads).where(inArray(chatMessageReads.agentId, agentIds));
      await this.db.delete(chatMessageTargets).where(inArray(chatMessageTargets.agentId, agentIds));
      await this.db
        .delete(chatThreadSessionInvites)
        .where(inArray(chatThreadSessionInvites.agentId, agentIds));
      await this.db.delete(chatActivities).where(inArray(chatActivities.agentId, agentIds));
      await this.db.delete(chatMembers).where(inArray(chatMembers.agentId, agentIds));
    }

    // 3. Chat messages
    if (messageIds.length > 0) {
      await this.db.delete(chatMessages).where(inArray(chatMessages.threadId, threadIds));
    }

    // 4. Chat threads
    if (threadIds.length > 0) {
      await this.db.delete(chatThreads).where(inArray(chatThreads.id, threadIds));
    }

    // 5. Session transcripts and sessions (sessions.agentId has onDelete: 'restrict')
    if (sessionIds.length > 0) {
      await this.db.delete(transcripts).where(inArray(transcripts.sessionId, sessionIds));
      await this.db.delete(sessions).where(inArray(sessions.id, sessionIds));
    }

    // 6. Epic-related records
    if (epicIds.length > 0) {
      await this.db.delete(epicComments).where(inArray(epicComments.epicId, epicIds));
      const projectRecords = await this.db
        .select({ id: records.id })
        .from(records)
        .where(inArray(records.epicId, epicIds));
      const recordIds = projectRecords.map((r) => r.id);
      if (recordIds.length > 0) {
        await this.db.delete(recordTags).where(inArray(recordTags.recordId, recordIds));
        await this.db.delete(records).where(inArray(records.id, recordIds));
      }
      await this.db.delete(epicTags).where(inArray(epicTags.epicId, epicIds));
    }

    // 7. Delete epics (must be before statuses)
    if (epicIds.length > 0) {
      await this.db.delete(epics).where(inArray(epics.id, epicIds));
    }

    // 8. Document-related records
    if (docIds.length > 0) {
      await this.db.delete(documentTags).where(inArray(documentTags.documentId, docIds));
      await this.db.delete(documents).where(inArray(documents.id, docIds));
    }

    // 9. Prompt-related records
    if (promptIds.length > 0) {
      await this.db.delete(promptTags).where(inArray(promptTags.promptId, promptIds));
      await this.db
        .delete(agentProfilePrompts)
        .where(inArray(agentProfilePrompts.promptId, promptIds));
      await this.db.delete(prompts).where(inArray(prompts.id, promptIds));
    }

    // 10. Agents (must be BEFORE agent profiles since agents.profileId references agentProfiles.id)
    if (agentIds.length > 0) {
      await this.db.delete(agents).where(inArray(agents.id, agentIds));
    }

    // 11. Agent profiles (also handles agentProfilePrompts if any remain)
    if (profileIds.length > 0) {
      await this.db
        .delete(agentProfilePrompts)
        .where(inArray(agentProfilePrompts.profileId, profileIds));
      await this.db.delete(agentProfiles).where(inArray(agentProfiles.id, profileIds));
    }

    // 12. Tags
    if (tagIds.length > 0) {
      await this.db.delete(tags).where(inArray(tags.id, tagIds));
    }

    // 13. Statuses (must be after epics)
    await this.db.delete(statuses).where(eq(statuses.projectId, id));

    // 14. Guests
    await this.db.delete(guests).where(eq(guests.projectId, id));

    // 15. Finally, delete the project itself
    await this.db.delete(projects).where(eq(projects.id, id));

    logger.info({ projectId: id }, 'Deleted project and all related records');
  }

  // Statuses
  async createStatus(data: CreateStatus): Promise<Status> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { statuses } = await import('../db/schema');

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
    const { statuses } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const result = await this.db.select().from(statuses).where(eq(statuses.id, id)).limit(1);
    if (!result[0]) {
      throw new NotFoundError('Status', id);
    }
    return result[0] as Status;
  }

  async listStatuses(projectId: string, options: ListOptions = {}): Promise<ListResult<Status>> {
    const { statuses } = await import('../db/schema');
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

    const { statuses } = await import('../db/schema');
    const { and, eq, sql } = await import('drizzle-orm');

    const result = await this.db
      .select()
      .from(statuses)
      .where(and(eq(statuses.projectId, projectId), sql`lower(${statuses.label}) = ${normalized}`))
      .limit(1);

    return result[0] ? (result[0] as Status) : null;
  }

  async updateStatus(id: string, data: UpdateStatus): Promise<Status> {
    const { statuses } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    await this.db
      .update(statuses)
      .set({ ...data, updatedAt: now })
      .where(eq(statuses.id, id));

    return this.getStatus(id);
  }

  async deleteStatus(id: string): Promise<void> {
    const { statuses } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(statuses).where(eq(statuses.id, id));
  }

  // Epics (with optimistic locking)
  async createEpic(data: CreateEpic): Promise<Epic> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { epics, epicTags, tags } = await import('../db/schema');

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
          const newTag = await this.createTag({ projectId: data.projectId, name: tagName });
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
    const { epics, epicTags, tags } = await import('../db/schema');
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
      tags: epicTagsResult.map((et) => et.tag.name),
    } as Epic;
  }

  async listEpics(projectId: string, options: ListOptions = {}): Promise<ListResult<Epic>> {
    const { epics } = await import('../db/schema');
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
    const { epics } = await import('../db/schema');
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
    const { epics, statuses } = await import('../db/schema');
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

    const { epics } = await import('../db/schema');
    const { and, eq, sql, desc } = await import('drizzle-orm');
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const agent = await this.getAgentByName(projectId, options.agentName);

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
    const { statuses } = await import('../db/schema');
    const { eq, asc } = await import('drizzle-orm');

    let statusId = input.statusId ?? null;

    if (statusId) {
      const status = await this.getStatus(statusId);
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
      const agent = await this.getAgentByName(projectId, input.agentName);
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
      tags: input.tags ?? [],
      data: null,
    });
  }

  async updateEpic(id: string, data: UpdateEpic, expectedVersion: number): Promise<Epic> {
    const { epics } = await import('../db/schema');
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
    const { epics } = await import('../db/schema');
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
    const { epics } = await import('../db/schema');
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

    // Execute raw query using underlying better-sqlite3 client
    const sqlite = getRawSqliteClient(this.db);
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

  /**
   * Batch fetch tags for multiple epic IDs with chunking.
   * Chunks IDs into batches of 500 to stay under SQLite's 999 parameter limit.
   */
  private async batchFetchTags(epicIds: string[]): Promise<Map<string, string[]>> {
    const tagsMap = new Map<string, string[]>();

    if (epicIds.length === 0) {
      return tagsMap;
    }

    const { epicTags, tags } = await import('../db/schema');
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

  async countSubEpicsByStatus(parentId: string): Promise<Record<string, number>> {
    await this.getEpic(parentId);
    const { epics } = await import('../db/schema');
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
    const { epics } = await import('../db/schema');
    const { eq, count } = await import('drizzle-orm');
    const result = await this.db
      .select({ count: count() })
      .from(epics)
      .where(eq(epics.statusId, statusId));
    return Number(result[0]?.count ?? 0);
  }

  async updateEpicsStatus(oldStatusId: string, newStatusId: string): Promise<number> {
    const { epics } = await import('../db/schema');
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
    const { epicComments } = await import('../db/schema');
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
    const { epicComments } = await import('../db/schema');
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
    const { epicComments } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(epicComments).where(eq(epicComments.id, id));
  }

  // Prompts (with optimistic locking)
  async createPrompt(data: CreatePrompt): Promise<Prompt> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { prompts, promptTags, tags } = await import('../db/schema');

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
          const newTag = await this.createTag({ projectId: data.projectId, name: tagName });
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
    const { prompts, promptTags, tags } = await import('../db/schema');
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
    const { prompts, promptTags, tags } = await import('../db/schema');
    const { and, eq, isNull, desc, sql } = await import('drizzle-orm');
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
      ? this.db
          .select(selectFields)
          .from(prompts)
          .where(whereCondition)
          .orderBy(desc(prompts.updatedAt))
      : this.db.select(selectFields).from(prompts).orderBy(desc(prompts.updatedAt)));

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
    const { prompts, promptTags, tags } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    logger.info({ id, data, expectedVersion }, 'updatePrompt called with data');

    const current = await this.getPrompt(id);
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
            const newTag = await this.createTag({ projectId: current.projectId, name: tagName });
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

    return this.getPrompt(id);
  }

  async deletePrompt(id: string): Promise<void> {
    const { prompts } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(prompts).where(eq(prompts.id, id));
  }

  async getInitialSessionPrompt(projectId: string | null): Promise<Prompt | null> {
    const { settings } = await import('../db/schema');
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
      const promptIdFromMap = this.extractPromptIdFromMap(mapRaw, projectId);
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
        const fromMap = this.extractPromptIdFromMap(mapRow?.value, projectId);
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

    const promptId = typeof rawValue === 'string' ? rawValue : this.extractPromptId(rawValue);
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

  private extractPromptId(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value === 'object') {
      if ('initialSessionPromptId' in (value as Record<string, unknown>)) {
        return this.extractPromptId(
          (value as { initialSessionPromptId?: unknown }).initialSessionPromptId,
        );
      }
      if ('value' in (value as Record<string, unknown>)) {
        return this.extractPromptId((value as { value?: unknown }).value);
      }
      return null;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }

      try {
        const parsed = JSON.parse(trimmed);
        return this.extractPromptId(parsed);
      } catch {
        // not JSON encoded
      }

      if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
        return trimmed.slice(1, -1).trim() || null;
      }

      return trimmed;
    }

    return String(value).trim() || null;
  }

  private extractPromptIdFromMap(value: unknown, projectId: string | null): string | null {
    try {
      const obj = typeof value === 'string' ? JSON.parse(value) : (value as unknown);
      if (obj && typeof obj === 'object') {
        const map = obj as Record<string, unknown>;
        if (projectId && typeof map[projectId] === 'string') {
          const v = (map[projectId] as string).trim();
          return v || null;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  // Documents
  async listDocuments(filters: DocumentListFilters = {}): Promise<ListResult<Document>> {
    const { documents, documentTags, tags } = await import('../db/schema');
    const { and, eq, isNull, like, or, desc, sql } = await import('drizzle-orm');

    const whereClauses: SQL[] = [];
    if (filters.projectId !== undefined) {
      whereClauses.push(
        filters.projectId === null
          ? isNull(documents.projectId)
          : eq(documents.projectId, filters.projectId),
      );
    }

    const tagKeys = this.normalizeTagList(filters.tagKeys);
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
      rows.map((row) => this.getDocument({ id: row.id })),
    );

    let filtered = documentsWithTags;
    if (filters.tags?.length) {
      const requiredTags = this.normalizeTagList(filters.tags);
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
    const { documents, documentTags, tags } = await import('../db/schema');
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
    const { documents } = await import('../db/schema');

    const slugSource = data.slug ?? data.title;
    const slug = await this.generateDocumentSlug(normalizedProjectId, slugSource);
    const tags = this.normalizeTagList(data.tags);

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
      await this.setDocumentTags(id, tags, normalizedProjectId);
    }

    logger.info({ documentId: id }, 'Created document');
    return this.getDocument({ id });
  }

  async updateDocument(id: string, data: UpdateDocument): Promise<Document> {
    const { documents } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const current = await this.getDocument({ id });
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
      updatePayload.slug = await this.generateDocumentSlug(current.projectId, data.slug, id);
    }

    await this.db.update(documents).set(updatePayload).where(eq(documents.id, id));

    if (data.tags !== undefined) {
      const tags = this.normalizeTagList(data.tags);
      await this.setDocumentTags(id, tags, current.projectId);
    }

    logger.info({ documentId: id }, 'Updated document');
    return this.getDocument({ id });
  }

  async deleteDocument(id: string): Promise<void> {
    const { documents } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(documents).where(eq(documents.id, id));
    logger.info({ documentId: id }, 'Deleted document');
  }

  // Tags
  async createTag(data: CreateTag): Promise<Tag> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { tags } = await import('../db/schema');

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
    const { tags } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const result = await this.db.select().from(tags).where(eq(tags.id, id)).limit(1);
    if (!result[0]) {
      throw new NotFoundError('Tag', id);
    }
    return result[0] as Tag;
  }

  async listTags(projectId: string | null, options: ListOptions = {}): Promise<ListResult<Tag>> {
    const { tags } = await import('../db/schema');
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
    const { tags } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    await this.db
      .update(tags)
      .set({ ...data, updatedAt: now })
      .where(eq(tags.id, id));

    return this.getTag(id);
  }

  async deleteTag(id: string): Promise<void> {
    const { tags } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(tags).where(eq(tags.id, id));
  }

  // Providers
  async createProvider(data: CreateProvider): Promise<Provider> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { providers } = await import('../db/schema');

    const provider: Provider = {
      id: randomUUID(),
      name: data.name,
      binPath: data.binPath ?? null,
      mcpConfigured: data.mcpConfigured ?? false,
      mcpEndpoint: data.mcpEndpoint ?? null,
      mcpRegisteredAt: data.mcpRegisteredAt ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(providers).values({
      id: provider.id,
      name: provider.name,
      binPath: provider.binPath,
      mcpConfigured: provider.mcpConfigured,
      mcpEndpoint: provider.mcpEndpoint,
      mcpRegisteredAt: provider.mcpRegisteredAt,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
    });

    logger.info({ providerId: provider.id, name: provider.name }, 'Created provider');
    return provider;
  }

  async getProvider(id: string): Promise<Provider> {
    const { providers } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const result = await this.db.select().from(providers).where(eq(providers.id, id)).limit(1);
    if (!result[0]) {
      throw new NotFoundError('Provider', id);
    }
    return result[0] as Provider;
  }

  async listProviders(options: ListOptions = {}): Promise<ListResult<Provider>> {
    const { providers } = await import('../db/schema');
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const items = await this.db.select().from(providers).limit(limit).offset(offset);

    return {
      items: items as Provider[],
      total: items.length,
      limit,
      offset,
    };
  }

  async updateProvider(id: string, data: UpdateProvider): Promise<Provider> {
    const { providers } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const payload = Object.fromEntries(
      Object.entries({
        ...data,
        updatedAt: now,
      }).filter(([, value]) => value !== undefined),
    );

    await this.db.update(providers).set(payload).where(eq(providers.id, id));

    logger.info({ providerId: id }, 'Updated provider');
    return this.getProvider(id);
  }

  async deleteProvider(id: string): Promise<void> {
    const { providers } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(providers).where(eq(providers.id, id));
    logger.info({ providerId: id }, 'Deleted provider');
  }

  async getProviderMcpMetadata(id: string): Promise<ProviderMcpMetadata> {
    const provider = await this.getProvider(id);
    return {
      mcpConfigured: provider.mcpConfigured,
      mcpEndpoint: provider.mcpEndpoint,
      mcpRegisteredAt: provider.mcpRegisteredAt,
    };
  }

  async updateProviderMcpMetadata(
    id: string,
    metadata: UpdateProviderMcpMetadata,
  ): Promise<Provider> {
    const update: UpdateProvider = {};
    if (metadata.mcpConfigured !== undefined) {
      update.mcpConfigured = metadata.mcpConfigured;
    }
    if (metadata.mcpEndpoint !== undefined) {
      update.mcpEndpoint = metadata.mcpEndpoint ?? null;
    }
    if (metadata.mcpRegisteredAt !== undefined) {
      update.mcpRegisteredAt = metadata.mcpRegisteredAt ?? null;
    }
    return this.updateProvider(id, update);
  }

  // Agent Profiles
  async createAgentProfile(data: CreateAgentProfile): Promise<AgentProfile> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { agentProfiles } = await import('../db/schema');

    const profile: AgentProfile = {
      id: randomUUID(),
      projectId: data.projectId ?? null,
      name: data.name,
      providerId: data.providerId,
      familySlug: data.familySlug ?? null,
      options: data.options ?? null,
      systemPrompt: data.systemPrompt ?? null,
      instructions: data.instructions ?? null,
      temperature: data.temperature ?? null,
      maxTokens: data.maxTokens ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(agentProfiles).values({
      id: profile.id,
      projectId: profile.projectId,
      name: profile.name,
      providerId: profile.providerId,
      familySlug: profile.familySlug,
      options: profile.options,
      systemPrompt: profile.systemPrompt,
      instructions: profile.instructions,
      temperature: profile.temperature != null ? Math.round(profile.temperature * 100) : null,
      maxTokens: profile.maxTokens,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    });

    return profile;
  }

  async getAgentProfile(id: string): Promise<AgentProfile> {
    const { agentProfiles } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const result = await this.db
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.id, id))
      .limit(1);
    if (!result[0]) {
      throw new NotFoundError('Agent profile', id);
    }
    const profile = result[0];
    return {
      ...profile,
      temperature: profile.temperature != null ? profile.temperature / 100 : null,
      options: profile.options ?? null,
    } as AgentProfile;
  }

  async listAgentProfiles(options: ProfileListOptions = {}): Promise<ListResult<AgentProfile>> {
    const { agentProfiles } = await import('../db/schema');
    const { eq, isNull } = await import('drizzle-orm');
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    let whereClause: SQL | undefined;
    if (options.projectId !== undefined) {
      whereClause =
        options.projectId === null
          ? isNull(agentProfiles.projectId)
          : eq(agentProfiles.projectId, options.projectId);
    }

    const items = await this.db
      .select()
      .from(agentProfiles)
      .where(whereClause)
      .limit(limit)
      .offset(offset);

    return {
      items: items.map((p) => ({
        ...p,
        temperature: p.temperature != null ? p.temperature / 100 : null,
        options: p.options ?? null,
      })) as AgentProfile[],
      total: items.length,
      limit,
      offset,
    };
  }

  async updateAgentProfile(id: string, data: UpdateAgentProfile): Promise<AgentProfile> {
    const { agentProfiles } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const updateData: Record<string, unknown> = { ...data };
    if (data.temperature !== undefined && data.temperature !== null) {
      updateData.temperature = Math.round(data.temperature * 100);
    }
    if (data.temperature === null) {
      updateData.temperature = null;
    }
    if (data.instructions !== undefined) {
      updateData.instructions = data.instructions ?? null;
    }
    if (data.options !== undefined) {
      updateData.options = data.options ?? null;
    }
    if (data.familySlug !== undefined) {
      updateData.familySlug = data.familySlug ?? null;
    }

    await this.db
      .update(agentProfiles)
      .set({ ...updateData, updatedAt: now })
      .where(eq(agentProfiles.id, id));

    return this.getAgentProfile(id);
  }

  async deleteAgentProfile(id: string): Promise<void> {
    const { agentProfiles } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(agentProfiles).where(eq(agentProfiles.id, id));
  }

  async setAgentProfilePrompts(profileId: string, promptIdsOrdered: string[]): Promise<void> {
    const { agentProfilePrompts, prompts } = await import('../db/schema');
    const { eq, inArray } = await import('drizzle-orm');

    // Validate profile exists and obtain its projectId
    const profile = await this.getAgentProfile(profileId);

    // Validate provided prompts exist and belong to same project
    if (promptIdsOrdered.length > 0) {
      const items = await this.db
        .select({ id: prompts.id, projectId: prompts.projectId })
        .from(prompts)
        .where(inArray(prompts.id, promptIdsOrdered));

      const foundIds = new Set(items.map((i) => i.id));
      const missing = promptIdsOrdered.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new ValidationError('Unknown prompt ids provided', { missing });
      }

      // Enforce project scoping: prompt.projectId must equal profile.projectId
      const crossProject = items.filter((i) => i.projectId !== (profile.projectId ?? null));
      if (crossProject.length > 0) {
        throw new ValidationError('Cross-project prompts are not allowed for this profile', {
          profileProjectId: profile.projectId ?? null,
          promptIds: crossProject.map((i) => i.id),
        });
      }
    }

    // Replace assignments atomically
    await this.db.transaction(async (tx) => {
      await tx.delete(agentProfilePrompts).where(eq(agentProfilePrompts.profileId, profileId));

      if (promptIdsOrdered.length === 0) return;

      const base = new Date();
      const rows = promptIdsOrdered.map((pid, idx) => ({
        profileId,
        promptId: pid,
        createdAt: new Date(base.getTime() + idx).toISOString(),
      }));
      await tx.insert(agentProfilePrompts).values(rows);
    });
  }

  async getAgentProfilePrompts(
    profileId: string,
  ): Promise<Array<{ promptId: string; createdAt: string }>> {
    const { agentProfilePrompts } = await import('../db/schema');
    const { eq, asc } = await import('drizzle-orm');
    const rows = await this.db
      .select({ promptId: agentProfilePrompts.promptId, createdAt: agentProfilePrompts.createdAt })
      .from(agentProfilePrompts)
      .where(eq(agentProfilePrompts.profileId, profileId))
      .orderBy(asc(agentProfilePrompts.createdAt));
    return rows as Array<{ promptId: string; createdAt: string }>;
  }

  async getAgentProfileWithPrompts(
    id: string,
  ): Promise<
    AgentProfile & { prompts: Array<{ promptId: string; title: string; order: number }> }
  > {
    const profile = await this.getAgentProfile(id);
    const { agentProfilePrompts, prompts } = await import('../db/schema');
    const { eq, asc } = await import('drizzle-orm');
    const rows = await this.db
      .select({
        promptId: agentProfilePrompts.promptId,
        createdAt: agentProfilePrompts.createdAt,
        title: prompts.title,
      })
      .from(agentProfilePrompts)
      .innerJoin(prompts, eq(agentProfilePrompts.promptId, prompts.id))
      .where(eq(agentProfilePrompts.profileId, id))
      .orderBy(asc(agentProfilePrompts.createdAt));
    const promptsDetailed = rows.map((row, idx) => ({
      promptId: row.promptId as string,
      title: row.title as string,
      order: idx + 1,
    }));
    return { ...profile, prompts: promptsDetailed };
  }

  async listAgentProfilesWithPrompts(
    options: ProfileListOptions = {},
  ): Promise<
    ListResult<
      AgentProfile & { prompts: Array<{ promptId: string; title: string; order: number }> }
    >
  > {
    const base = await this.listAgentProfiles(options);
    if (!base.items.length) return { ...base, items: [] };
    const ids = base.items.map((p) => p.id);
    const { agentProfilePrompts, prompts } = await import('../db/schema');
    const { inArray, asc, eq } = await import('drizzle-orm');
    const rows = await this.db
      .select({
        profileId: agentProfilePrompts.profileId,
        promptId: agentProfilePrompts.promptId,
        createdAt: agentProfilePrompts.createdAt,
        title: prompts.title,
      })
      .from(agentProfilePrompts)
      .innerJoin(prompts, eq(agentProfilePrompts.promptId, prompts.id))
      .where(inArray(agentProfilePrompts.profileId, ids))
      .orderBy(asc(agentProfilePrompts.profileId), asc(agentProfilePrompts.createdAt));

    const grouped = new Map<
      string,
      Array<{ promptId: string; title: string; createdAt: string }>
    >();
    for (const r of rows) {
      const pid = r.profileId as string;
      const arr = grouped.get(pid) ?? [];
      arr.push({
        promptId: r.promptId as string,
        title: r.title as string,
        createdAt: r.createdAt as string,
      });
      grouped.set(pid, arr);
    }

    const items = base.items.map((p) => {
      const arr = grouped.get(p.id) ?? [];
      const promptsDetailed = arr.map((row, idx) => ({
        promptId: row.promptId,
        title: row.title,
        order: idx + 1,
      }));
      return { ...p, prompts: promptsDetailed };
    });

    return { ...base, items };
  }

  // Agents
  async createAgent(data: CreateAgent): Promise<Agent> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { agents } = await import('../db/schema');

    const agent: Agent = {
      id: randomUUID(),
      ...data,
      description: data.description ?? null,
      createdAt: now,
      updatedAt: now,
    };

    // Validate that profile belongs to the same project
    const profile = await this.getAgentProfile(agent.profileId);
    if (profile.projectId !== agent.projectId) {
      throw new ValidationError('Agent.profileId must belong to the same project as the agent.', {
        agentProjectId: agent.projectId,
        profileProjectId: profile.projectId,
        profileId: agent.profileId,
      });
    }

    await this.db.insert(agents).values({
      id: agent.id,
      projectId: agent.projectId,
      profileId: agent.profileId,
      name: agent.name,
      description: agent.description,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    });

    logger.info({ agentId: agent.id, projectId: agent.projectId }, 'Created agent');
    return agent;
  }

  async getAgent(id: string): Promise<Agent> {
    const { agents } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const result = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    if (!result[0]) {
      throw new NotFoundError('Agent', id);
    }
    return result[0] as Agent;
  }

  async listAgents(projectId: string, options: ListOptions = {}): Promise<ListResult<Agent>> {
    const { agents } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const items = await this.db
      .select()
      .from(agents)
      .where(eq(agents.projectId, projectId))
      .limit(limit)
      .offset(offset);

    return {
      items: items as Agent[],
      total: items.length,
      limit,
      offset,
    };
  }

  async getAgentByName(
    projectId: string,
    name: string,
  ): Promise<Agent & { profile?: AgentProfile }> {
    const { agents } = await import('../db/schema');
    const { and, eq, sql } = await import('drizzle-orm');

    const normalized = name.toLowerCase();

    const result = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.projectId, projectId), sql`lower(${agents.name}) = ${normalized}`))
      .limit(1);

    const record = result[0];
    if (!record) {
      throw new NotFoundError('Agent', `${projectId}:${name}`);
    }

    const agent = record as Agent;
    const profile = await this.getAgentProfile(agent.profileId);

    return { ...agent, profile };
  }

  async updateAgent(id: string, data: UpdateAgent): Promise<Agent> {
    const { agents } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    // If projectId or profileId changes, validate they match
    if (data.projectId !== undefined || data.profileId !== undefined) {
      const current = await this.getAgent(id);
      const newProjectId = data.projectId ?? current.projectId;
      const newProfileId = data.profileId ?? current.profileId;
      const profile = await this.getAgentProfile(newProfileId);
      if (profile.projectId !== newProjectId) {
        throw new ValidationError('Agent.profileId must belong to the same project as the agent.', {
          agentProjectId: newProjectId,
          profileProjectId: profile.projectId,
          profileId: newProfileId,
        });
      }
    }

    await this.db
      .update(agents)
      .set({ ...data, updatedAt: now })
      .where(eq(agents.id, id));

    return this.getAgent(id);
  }

  async deleteAgent(id: string): Promise<void> {
    const { agents, sessions } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');

    // Check for related sessions
    const relatedSessions = await this.db.select().from(sessions).where(eq(sessions.agentId, id));

    // Check if there are any running sessions
    const runningSessions = relatedSessions.filter((s) => s.status === 'running');

    if (runningSessions.length > 0) {
      throw new ConflictError(
        `Cannot delete agent: ${runningSessions.length} active session(s) are still running. Please terminate the active sessions first.`,
      );
    }

    // Automatically delete stopped/failed sessions
    const completedSessions = relatedSessions.filter(
      (s) => s.status === 'stopped' || s.status === 'failed',
    );

    if (completedSessions.length > 0) {
      logger.info(
        { agentId: id, count: completedSessions.length },
        'Auto-deleting completed sessions for agent',
      );

      for (const session of completedSessions) {
        await this.db.delete(sessions).where(eq(sessions.id, session.id));
      }
    }

    await this.db.delete(agents).where(eq(agents.id, id));
    logger.info({ agentId: id, deletedSessions: completedSessions.length }, 'Deleted agent');
  }

  // Records (with optimistic locking)
  async createRecord(data: CreateEpicRecord): Promise<EpicRecord> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { records, recordTags, tags } = await import('../db/schema');

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
        const { epics } = await import('../db/schema');
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
          const newTag = await this.createTag({ projectId, name: tagName });
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
    const { records, recordTags, tags } = await import('../db/schema');
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
    const { records } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const items = await this.db
      .select()
      .from(records)
      .where(eq(records.epicId, epicId))
      .limit(limit)
      .offset(offset);

    const itemsWithTags = await Promise.all(items.map((item) => this.getRecord(item.id)));

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
    const { records, recordTags, tags } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const current = await this.getRecord(id);
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
        const { epics } = await import('../db/schema');
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
            const newTag = await this.createTag({ projectId, name: tagName });
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
    return this.getRecord(id);
  }

  async deleteRecord(id: string): Promise<void> {
    const { records } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(records).where(eq(records.id, id));
    logger.info({ recordId: id }, 'Deleted record');
  }

  // Chat message reads
  async markMessageAsRead(messageId: string, agentId: string, readAt: string): Promise<void> {
    const { chatMessageReads } = await import('../db/schema');
    const { eq, and } = await import('drizzle-orm');

    // Check if already exists
    const existing = await this.db
      .select()
      .from(chatMessageReads)
      .where(and(eq(chatMessageReads.messageId, messageId), eq(chatMessageReads.agentId, agentId)))
      .limit(1);

    if (!existing[0]) {
      // Insert new read record
      await this.db.insert(chatMessageReads).values({
        messageId,
        agentId,
        readAt,
      });
      logger.info({ messageId, agentId }, 'Marked message as read');
    } else {
      logger.debug({ messageId, agentId }, 'Message already marked as read');
    }
  }

  private normalizeTagList(tags?: string[]): string[] {
    if (!tags?.length) {
      return [];
    }

    const unique = new Set<string>();
    for (const tag of tags) {
      const trimmed = tag.trim();
      if (trimmed) {
        unique.add(trimmed);
      }
    }

    return Array.from(unique);
  }

  private slugify(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private async generateDocumentSlug(
    projectId: string | null,
    desired: string,
    excludeId?: string,
  ): Promise<string> {
    const { documents } = await import('../db/schema');
    const { eq, and, isNull, ne } = await import('drizzle-orm');

    const base = this.slugify(desired || 'document') || 'document';
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

  private async setDocumentTags(
    documentId: string,
    tagNames: string[],
    projectId: string | null,
  ): Promise<void> {
    const normalizedTags = this.normalizeTagList(tagNames);
    const { documentTags, tags } = await import('../db/schema');
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
        const newTag = await this.createTag({ projectId, name: tagName });
        tagId = newTag.id;
      }

      await this.db.insert(documentTags).values({
        documentId,
        tagId,
      });
    }
  }

  // ============================================
  // TERMINAL WATCHERS
  // ============================================

  async listWatchers(projectId: string): Promise<Watcher[]> {
    const { terminalWatchers } = await import('../db/schema');
    const { eq, desc } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(terminalWatchers)
      .where(eq(terminalWatchers.projectId, projectId))
      .orderBy(desc(terminalWatchers.createdAt));

    return rows.map((row) => ({
      ...row,
      condition: row.condition as Watcher['condition'],
    })) as Watcher[];
  }

  async getWatcher(id: string): Promise<Watcher | null> {
    const { terminalWatchers } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');

    const result = await this.db
      .select()
      .from(terminalWatchers)
      .where(eq(terminalWatchers.id, id))
      .limit(1);

    if (!result[0]) {
      return null;
    }

    return {
      ...result[0],
      condition: result[0].condition as Watcher['condition'],
    } as Watcher;
  }

  async createWatcher(data: CreateWatcher): Promise<Watcher> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { terminalWatchers } = await import('../db/schema');

    const watcher: Watcher = {
      id: randomUUID(),
      ...data,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(terminalWatchers).values({
      id: watcher.id,
      projectId: watcher.projectId,
      name: watcher.name,
      description: watcher.description,
      enabled: watcher.enabled,
      scope: watcher.scope,
      scopeFilterId: watcher.scopeFilterId,
      pollIntervalMs: watcher.pollIntervalMs,
      viewportLines: watcher.viewportLines,
      condition: watcher.condition,
      cooldownMs: watcher.cooldownMs,
      cooldownMode: watcher.cooldownMode,
      eventName: watcher.eventName,
      createdAt: watcher.createdAt,
      updatedAt: watcher.updatedAt,
    });

    return watcher;
  }

  async updateWatcher(id: string, data: UpdateWatcher): Promise<Watcher> {
    const { terminalWatchers } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const existing = await this.getWatcher(id);
    if (!existing) {
      throw new NotFoundError('Watcher', id);
    }

    await this.db
      .update(terminalWatchers)
      .set({ ...data, updatedAt: now })
      .where(eq(terminalWatchers.id, id));

    const updated = await this.getWatcher(id);
    if (!updated) {
      throw new NotFoundError('Watcher', id);
    }
    return updated;
  }

  async deleteWatcher(id: string): Promise<void> {
    const { terminalWatchers } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(terminalWatchers).where(eq(terminalWatchers.id, id));
  }

  async listEnabledWatchers(): Promise<Watcher[]> {
    const { terminalWatchers } = await import('../db/schema');
    const { eq, desc } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(terminalWatchers)
      .where(eq(terminalWatchers.enabled, true))
      .orderBy(desc(terminalWatchers.createdAt));

    return rows.map((row) => ({
      ...row,
      condition: row.condition as Watcher['condition'],
    })) as Watcher[];
  }

  // ============================================
  // AUTOMATION SUBSCRIBERS
  // ============================================

  async listSubscribers(projectId: string): Promise<Subscriber[]> {
    const { automationSubscribers } = await import('../db/schema');
    const { eq, desc } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(automationSubscribers)
      .where(eq(automationSubscribers.projectId, projectId))
      .orderBy(desc(automationSubscribers.createdAt));

    return rows.map((row) => ({
      ...row,
      eventFilter: row.eventFilter as Subscriber['eventFilter'],
      actionInputs: row.actionInputs as Subscriber['actionInputs'],
    })) as Subscriber[];
  }

  async getSubscriber(id: string): Promise<Subscriber | null> {
    const { automationSubscribers } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');

    const result = await this.db
      .select()
      .from(automationSubscribers)
      .where(eq(automationSubscribers.id, id))
      .limit(1);

    if (!result[0]) {
      return null;
    }

    return {
      ...result[0],
      eventFilter: result[0].eventFilter as Subscriber['eventFilter'],
      actionInputs: result[0].actionInputs as Subscriber['actionInputs'],
    } as Subscriber;
  }

  async createSubscriber(data: CreateSubscriber): Promise<Subscriber> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { automationSubscribers } = await import('../db/schema');

    const subscriber: Subscriber = {
      id: randomUUID(),
      ...data,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(automationSubscribers).values({
      id: subscriber.id,
      projectId: subscriber.projectId,
      name: subscriber.name,
      description: subscriber.description,
      enabled: subscriber.enabled,
      eventName: subscriber.eventName,
      eventFilter: subscriber.eventFilter,
      actionType: subscriber.actionType,
      actionInputs: subscriber.actionInputs,
      delayMs: subscriber.delayMs,
      cooldownMs: subscriber.cooldownMs,
      retryOnError: subscriber.retryOnError,
      groupName: subscriber.groupName,
      position: subscriber.position,
      priority: subscriber.priority,
      createdAt: subscriber.createdAt,
      updatedAt: subscriber.updatedAt,
    });

    return subscriber;
  }

  async updateSubscriber(id: string, data: UpdateSubscriber): Promise<Subscriber> {
    const { automationSubscribers } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const existing = await this.getSubscriber(id);
    if (!existing) {
      throw new NotFoundError('Subscriber', id);
    }

    await this.db
      .update(automationSubscribers)
      .set({ ...data, updatedAt: now })
      .where(eq(automationSubscribers.id, id));

    const updated = await this.getSubscriber(id);
    if (!updated) {
      throw new NotFoundError('Subscriber', id);
    }
    return updated;
  }

  async deleteSubscriber(id: string): Promise<void> {
    const { automationSubscribers } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(automationSubscribers).where(eq(automationSubscribers.id, id));
  }

  async findSubscribersByEventName(projectId: string, eventName: string): Promise<Subscriber[]> {
    const { automationSubscribers } = await import('../db/schema');
    const { eq, and, desc } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(automationSubscribers)
      .where(
        and(
          eq(automationSubscribers.projectId, projectId),
          eq(automationSubscribers.eventName, eventName),
          eq(automationSubscribers.enabled, true),
        ),
      )
      .orderBy(desc(automationSubscribers.createdAt));

    return rows.map((row) => ({
      ...row,
      eventFilter: row.eventFilter as Subscriber['eventFilter'],
      actionInputs: row.actionInputs as Subscriber['actionInputs'],
    })) as Subscriber[];
  }

  // ============================================
  // PROJECT PATH LOOKUPS
  // ============================================

  async getProjectByRootPath(rootPath: string): Promise<Project | null> {
    const { resolve } = await import('path');
    const { projects } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');

    const normalizedPath = resolve(rootPath);

    const rows = await this.db
      .select()
      .from(projects)
      .where(eq(projects.rootPath, normalizedPath))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return {
      id: rows[0].id,
      name: rows[0].name,
      description: rows[0].description,
      rootPath: rows[0].rootPath,
      isTemplate: rows[0].isTemplate,
      createdAt: rows[0].createdAt,
      updatedAt: rows[0].updatedAt,
    };
  }

  async findProjectContainingPath(absolutePath: string): Promise<Project | null> {
    const { resolve, sep } = await import('path');
    const { projects } = await import('../db/schema');

    const normalizedPath = resolve(absolutePath);

    // Fetch all projects (handle pagination internally)
    const allProjects: Project[] = [];
    const pageSize = 100;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const rows = await this.db.select().from(projects).limit(pageSize).offset(offset);

      if (rows.length === 0) {
        hasMore = false;
      } else {
        for (const row of rows) {
          allProjects.push({
            id: row.id,
            name: row.name,
            description: row.description,
            rootPath: row.rootPath,
            isTemplate: row.isTemplate,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          });
        }
        offset += pageSize;
        if (rows.length < pageSize) {
          hasMore = false;
        }
      }
    }

    // Find the most specific match (longest rootPath that is a prefix of the given path)
    let bestMatch: Project | null = null;
    let longestRootPath = 0;

    for (const project of allProjects) {
      const projectRoot = resolve(project.rootPath);

      // Check if normalizedPath starts with projectRoot
      // Must be exact match or followed by path separator
      if (normalizedPath === projectRoot || normalizedPath.startsWith(projectRoot + sep)) {
        if (projectRoot.length > longestRootPath) {
          longestRootPath = projectRoot.length;
          bestMatch = project;
        }
      }
    }

    return bestMatch;
  }

  // ============================================
  // GUESTS - External agents registered via MCP
  // ============================================

  async createGuest(data: CreateGuest): Promise<Guest> {
    const { randomUUID } = await import('crypto');
    const { guests } = await import('../db/schema');
    const { eq, and, sql } = await import('drizzle-orm');

    const now = new Date().toISOString();

    // Check for existing guest with same name in project (case-insensitive)
    const existingByName = await this.db
      .select()
      .from(guests)
      .where(
        and(
          eq(guests.projectId, data.projectId),
          sql`${guests.name} = ${data.name} COLLATE NOCASE`,
        ),
      )
      .limit(1);

    if (existingByName.length > 0) {
      throw new ConflictError(`Guest with name "${data.name}" already exists in project`, {
        projectId: data.projectId,
        name: data.name,
      });
    }

    // Check for existing guest with same tmux session
    const existingByTmux = await this.db
      .select()
      .from(guests)
      .where(eq(guests.tmuxSessionId, data.tmuxSessionId))
      .limit(1);

    if (existingByTmux.length > 0) {
      throw new ConflictError(`Guest with tmux session "${data.tmuxSessionId}" already exists`, {
        tmuxSessionId: data.tmuxSessionId,
      });
    }

    const guest: Guest = {
      id: randomUUID(),
      projectId: data.projectId,
      name: data.name,
      description: data.description ?? null,
      tmuxSessionId: data.tmuxSessionId,
      lastSeenAt: data.lastSeenAt,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(guests).values(guest);

    logger.info({ guestId: guest.id, projectId: data.projectId, name: data.name }, 'Created guest');

    return guest;
  }

  async getGuest(id: string): Promise<Guest> {
    const { guests } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');

    const rows = await this.db.select().from(guests).where(eq(guests.id, id)).limit(1);

    if (rows.length === 0) {
      throw new NotFoundError('Guest', id);
    }

    return rows[0] as Guest;
  }

  async getGuestByName(projectId: string, name: string): Promise<Guest | null> {
    const { guests } = await import('../db/schema');
    const { eq, and, sql } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(guests)
      .where(and(eq(guests.projectId, projectId), sql`${guests.name} = ${name} COLLATE NOCASE`))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return rows[0] as Guest;
  }

  async getGuestByTmuxSessionId(tmuxSessionId: string): Promise<Guest | null> {
    const { guests } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(guests)
      .where(eq(guests.tmuxSessionId, tmuxSessionId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return rows[0] as Guest;
  }

  async getGuestsByIdPrefix(prefix: string): Promise<Guest[]> {
    const { guests } = await import('../db/schema');
    const { like } = await import('drizzle-orm');

    // Use SQL LIKE for efficient prefix matching (uses index)
    const rows = await this.db
      .select()
      .from(guests)
      .where(like(guests.id, `${prefix}%`));

    return rows as Guest[];
  }

  async listGuests(projectId: string): Promise<Guest[]> {
    const { guests } = await import('../db/schema');
    const { eq, asc } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(guests)
      .where(eq(guests.projectId, projectId))
      .orderBy(asc(guests.name));

    return rows as Guest[];
  }

  async listAllGuests(): Promise<Guest[]> {
    const { guests } = await import('../db/schema');
    const { asc } = await import('drizzle-orm');

    const rows = await this.db.select().from(guests).orderBy(asc(guests.createdAt));

    return rows as Guest[];
  }

  async deleteGuest(id: string): Promise<void> {
    const { guests } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');

    // Verify guest exists
    await this.getGuest(id);

    await this.db.delete(guests).where(eq(guests.id, id));

    logger.info({ guestId: id }, 'Deleted guest');
  }

  async updateGuestLastSeen(id: string, lastSeenAt: string): Promise<Guest> {
    const { guests } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');

    // Verify guest exists
    const existing = await this.getGuest(id);

    const now = new Date().toISOString();

    await this.db
      .update(guests)
      .set({
        lastSeenAt,
        updatedAt: now,
      })
      .where(eq(guests.id, id));

    return {
      ...existing,
      lastSeenAt,
      updatedAt: now,
    };
  }

  // ============================================
  // CODE REVIEWS
  // ============================================

  async createReview(data: CreateReview): Promise<Review> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { reviews } = await import('../db/schema');

    const review: Review = {
      id: randomUUID(),
      projectId: data.projectId,
      epicId: data.epicId,
      title: data.title,
      description: data.description,
      status: data.status,
      mode: data.mode,
      baseRef: data.baseRef,
      headRef: data.headRef,
      baseSha: data.baseSha,
      headSha: data.headSha,
      createdBy: data.createdBy,
      createdByAgentId: data.createdByAgentId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(reviews).values({
      id: review.id,
      projectId: review.projectId,
      epicId: review.epicId,
      title: review.title,
      description: review.description,
      status: review.status,
      mode: review.mode,
      baseRef: review.baseRef,
      headRef: review.headRef,
      baseSha: review.baseSha,
      headSha: review.headSha,
      createdBy: review.createdBy,
      createdByAgentId: review.createdByAgentId,
      version: review.version,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
    });

    logger.info({ reviewId: review.id, projectId: review.projectId }, 'Created review');
    return review;
  }

  async getReview(id: string): Promise<Review> {
    const { reviews, reviewComments } = await import('../db/schema');
    const { eq, count } = await import('drizzle-orm');

    const result = await this.db.select().from(reviews).where(eq(reviews.id, id)).limit(1);
    if (!result[0]) {
      throw new NotFoundError('Review', id);
    }

    // Get comment count
    const countResult = await this.db
      .select({ count: count() })
      .from(reviewComments)
      .where(eq(reviewComments.reviewId, id));

    return {
      ...result[0],
      commentCount: countResult[0]?.count ?? 0,
    } as Review;
  }

  async updateReview(id: string, data: UpdateReview, expectedVersion: number): Promise<Review> {
    const { reviews } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const current = await this.getReview(id);
    if (current.version !== expectedVersion) {
      throw new OptimisticLockError('Review', id, {
        expectedVersion,
        actualVersion: current.version,
      });
    }

    const updateData: Record<string, unknown> = {};
    if (data.title !== undefined) updateData.title = data.title;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.headSha !== undefined) updateData.headSha = data.headSha;

    await this.db
      .update(reviews)
      .set({ ...updateData, version: expectedVersion + 1, updatedAt: now })
      .where(eq(reviews.id, id));

    logger.info({ reviewId: id }, 'Updated review');
    return this.getReview(id);
  }

  async deleteReview(id: string): Promise<void> {
    const { reviews } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');

    // Cascade delete of comments handled by FK constraint
    await this.db.delete(reviews).where(eq(reviews.id, id));
    logger.info({ reviewId: id }, 'Deleted review');
  }

  async listReviews(
    projectId: string,
    options: ListReviewsOptions = {},
  ): Promise<ListResult<Review>> {
    const { reviews, reviewComments } = await import('../db/schema');
    const { eq, and, count, desc } = await import('drizzle-orm');
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const conditions: SQL<unknown>[] = [eq(reviews.projectId, projectId)];
    if (options.status) {
      conditions.push(eq(reviews.status, options.status));
    }
    if (options.epicId) {
      conditions.push(eq(reviews.epicId, options.epicId));
    }

    const rows = await this.db
      .select()
      .from(reviews)
      .where(and(...conditions))
      .orderBy(desc(reviews.createdAt))
      .limit(limit)
      .offset(offset);

    // Get comment counts for all reviews in a single query (avoids N+1)
    const reviewIds = rows.map((r) => r.id);
    let commentCountMap: Map<string, number> = new Map();

    if (reviewIds.length > 0) {
      const { inArray } = await import('drizzle-orm');
      const countRows = await this.db
        .select({
          reviewId: reviewComments.reviewId,
          count: count(),
        })
        .from(reviewComments)
        .where(inArray(reviewComments.reviewId, reviewIds))
        .groupBy(reviewComments.reviewId);

      commentCountMap = new Map(countRows.map((r) => [r.reviewId, r.count]));
    }

    const items = rows.map(
      (row) =>
        ({
          ...row,
          commentCount: commentCountMap.get(row.id) ?? 0,
        }) as Review,
    );

    return {
      items,
      total: items.length,
      limit,
      offset,
    };
  }

  // Review Comments

  async createReviewComment(
    data: CreateReviewComment,
    targetAgentIds?: string[],
  ): Promise<ReviewComment> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { reviewComments, reviewCommentTargets } = await import('../db/schema');

    const sqlite = getRawSqliteClient(this.db);
    if (!sqlite || typeof sqlite.exec !== 'function') {
      throw new StorageError('Unable to access underlying SQLite client');
    }

    sqlite.exec('BEGIN IMMEDIATE TRANSACTION');

    try {
      const comment: ReviewComment = {
        id: randomUUID(),
        reviewId: data.reviewId,
        filePath: data.filePath,
        parentId: data.parentId,
        lineStart: data.lineStart,
        lineEnd: data.lineEnd,
        side: data.side,
        content: data.content,
        commentType: data.commentType,
        status: data.status,
        authorType: data.authorType,
        authorAgentId: data.authorAgentId,
        version: 1,
        editedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      await this.db.insert(reviewComments).values({
        id: comment.id,
        reviewId: comment.reviewId,
        filePath: comment.filePath,
        parentId: comment.parentId,
        lineStart: comment.lineStart,
        lineEnd: comment.lineEnd,
        side: comment.side,
        content: comment.content,
        commentType: comment.commentType,
        status: comment.status,
        authorType: comment.authorType,
        authorAgentId: comment.authorAgentId,
        version: comment.version,
        editedAt: comment.editedAt,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      });

      // Add targets if provided
      if (targetAgentIds && targetAgentIds.length > 0) {
        for (const agentId of targetAgentIds) {
          await this.db.insert(reviewCommentTargets).values({
            id: randomUUID(),
            commentId: comment.id,
            agentId,
            createdAt: now,
          });
        }
      }

      sqlite.exec('COMMIT');
      logger.info(
        { commentId: comment.id, reviewId: comment.reviewId, targets: targetAgentIds?.length ?? 0 },
        'Created review comment',
      );
      return comment;
    } catch (error) {
      try {
        sqlite.exec('ROLLBACK');
        logger.info('Transaction rolled back successfully');
      } catch (rollbackError) {
        logger.error({ rollbackError }, 'Failed to rollback transaction');
      }
      throw error;
    }
  }

  async getReviewComment(id: string): Promise<ReviewComment> {
    const { reviewComments } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');

    const result = await this.db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.id, id))
      .limit(1);
    if (!result[0]) {
      throw new NotFoundError('ReviewComment', id);
    }

    return result[0] as ReviewComment;
  }

  async updateReviewComment(
    id: string,
    data: UpdateReviewComment,
    expectedVersion: number,
  ): Promise<ReviewComment> {
    const { reviewComments } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const current = await this.getReviewComment(id);
    if (current.version !== expectedVersion) {
      throw new OptimisticLockError('ReviewComment', id, {
        expectedVersion,
        actualVersion: current.version,
      });
    }

    const updateData: Record<string, unknown> = {};
    if (data.content !== undefined && data.content !== current.content) {
      updateData.content = data.content;
      updateData.editedAt = now;
    }
    if (data.status !== undefined && data.status !== current.status) {
      updateData.status = data.status;
    }

    // No-op update: avoid bumping version/updatedAt when nothing changed.
    if (Object.keys(updateData).length === 0) {
      logger.info({ commentId: id }, 'Skipped review comment update (no changes)');
      return current;
    }

    await this.db
      .update(reviewComments)
      .set({ ...updateData, version: expectedVersion + 1, updatedAt: now })
      .where(eq(reviewComments.id, id));

    logger.info({ commentId: id }, 'Updated review comment');
    return this.getReviewComment(id);
  }

  async listReviewComments(
    reviewId: string,
    options: ListReviewCommentsOptions = {},
  ): Promise<ListResult<ReviewCommentEnriched>> {
    const { reviewComments, agents, reviewCommentTargets } = await import('../db/schema');
    const { eq, and, isNull, desc, inArray } = await import('drizzle-orm');
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const conditions: SQL<unknown>[] = [eq(reviewComments.reviewId, reviewId)];
    if (options.status) {
      conditions.push(eq(reviewComments.status, options.status));
    }
    if (options.filePath) {
      conditions.push(eq(reviewComments.filePath, options.filePath));
    }
    if (options.parentId === null) {
      conditions.push(isNull(reviewComments.parentId));
    } else if (options.parentId !== undefined) {
      conditions.push(eq(reviewComments.parentId, options.parentId));
    }

    // Query 1: Get comments (preserves pagination)
    const rows = await this.db
      .select()
      .from(reviewComments)
      .where(and(...conditions))
      .orderBy(desc(reviewComments.createdAt))
      .limit(limit)
      .offset(offset);

    if (rows.length === 0) {
      return { items: [], total: 0, limit, offset };
    }

    // Query 2: Batch fetch author agent names for agent-authored comments
    const authorAgentIds = [
      ...new Set(
        rows.map((r) => r.authorAgentId).filter((id): id is string => typeof id === 'string'),
      ),
    ];
    const agentNameMap = new Map<string, string>();
    if (authorAgentIds.length > 0) {
      const authorAgents = await this.db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(inArray(agents.id, authorAgentIds));
      authorAgents.forEach((a) => agentNameMap.set(a.id, a.name));
    }

    // Query 3: Batch fetch targets with agent names
    const commentIds = rows.map((r) => r.id);
    const targetsWithNames = await this.db
      .select({
        commentId: reviewCommentTargets.commentId,
        agentId: reviewCommentTargets.agentId,
        agentName: agents.name,
      })
      .from(reviewCommentTargets)
      .leftJoin(agents, eq(reviewCommentTargets.agentId, agents.id))
      .where(inArray(reviewCommentTargets.commentId, commentIds));

    // Group targets by commentId for efficient lookup
    const targetsByCommentId = new Map<string, ReviewCommentTargetAgent[]>();
    targetsWithNames.forEach((t) => {
      const list = targetsByCommentId.get(t.commentId) ?? [];
      list.push({ agentId: t.agentId, name: t.agentName ?? 'Unknown' });
      targetsByCommentId.set(t.commentId, list);
    });

    // Enrich comments with author names and targets
    const enrichedItems: ReviewCommentEnriched[] = rows.map((row) => ({
      ...(row as ReviewComment),
      authorAgentName: row.authorAgentId ? (agentNameMap.get(row.authorAgentId) ?? null) : null,
      targetAgents: targetsByCommentId.get(row.id) ?? [],
    }));

    return {
      items: enrichedItems,
      total: rows.length,
      limit,
      offset,
    };
  }

  // Review Comment Targets

  async addReviewCommentTargets(
    commentId: string,
    agentIds: string[],
  ): Promise<ReviewCommentTarget[]> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { reviewCommentTargets } = await import('../db/schema');

    // Verify comment exists
    await this.getReviewComment(commentId);

    const targets: ReviewCommentTarget[] = [];
    for (const agentId of agentIds) {
      const target: ReviewCommentTarget = {
        id: randomUUID(),
        commentId,
        agentId,
        createdAt: now,
      };
      await this.db.insert(reviewCommentTargets).values(target);
      targets.push(target);
    }

    logger.info({ commentId, count: targets.length }, 'Added review comment targets');
    return targets;
  }

  async getReviewCommentTargets(commentId: string): Promise<ReviewCommentTarget[]> {
    const { reviewCommentTargets } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(reviewCommentTargets)
      .where(eq(reviewCommentTargets.commentId, commentId));

    return rows as ReviewCommentTarget[];
  }

  async deleteReviewComment(id: string): Promise<void> {
    const { reviewComments } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');

    // Note: Cascade delete on parentId foreign key handles replies automatically
    await this.db.delete(reviewComments).where(eq(reviewComments.id, id));
  }

  async deleteNonResolvedComments(reviewId: string): Promise<number> {
    const { reviewComments } = await import('../db/schema');
    const { eq, and, notInArray } = await import('drizzle-orm');

    // Delete all comments that are not resolved or wont_fix (keep those with conversation value)
    const result = await this.db
      .delete(reviewComments)
      .where(
        and(
          eq(reviewComments.reviewId, reviewId),
          notInArray(reviewComments.status, ['resolved', 'wont_fix']),
        ),
      );

    // Drizzle returns { changes: number } for SQLite
    return (result as unknown as { changes: number }).changes ?? 0;
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
