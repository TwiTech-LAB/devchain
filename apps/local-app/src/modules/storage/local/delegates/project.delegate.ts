import type {
  CreateProjectWithTemplateOptions,
  ListOptions,
  ListResult,
} from '../../interfaces/storage.interface';
import type { CreateProject, Project, UpdateProject } from '../../models/domain.models';
import { ConflictError, StorageError, NotFoundError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { isSqliteUniqueConstraint } from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('ProjectStorageDelegate');

export class ProjectStorageDelegate extends BaseStorageDelegate {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  private listSeedableSourceNamesForNewProject(
    communitySkillSources: typeof import('../../db/schema').communitySkillSources,
  ): string[] {
    const communitySourceRows = this.db
      .select({ name: communitySkillSources.name })
      .from(communitySkillSources)
      .all();

    const sourceNames = communitySourceRows
      .map((row) => row.name.trim().toLowerCase())
      .filter((name) => name.length > 0);

    const sqlite = this.rawClient;
    if (sqlite && typeof sqlite.prepare === 'function') {
      try {
        const localRows = sqlite.prepare('SELECT name FROM local_skill_sources').all() as Array<{
          name: unknown;
        }>;
        for (const row of localRows) {
          if (typeof row.name !== 'string') {
            continue;
          }
          const normalized = row.name.trim().toLowerCase();
          if (normalized.length > 0) {
            sourceNames.push(normalized);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('no such table: local_skill_sources')) {
          throw new StorageError('Failed to list local skill sources for project source seeding.', {
            cause: message,
          });
        }
      }
    }

    return [...new Set(sourceNames)];
  }

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

    const { projects, statuses, sourceProjectEnabled, communitySkillSources } = await import(
      '../../db/schema'
    );

    this.txRunner.runImmediate(() => {
      const seedableSourceNames = this.listSeedableSourceNamesForNewProject(communitySkillSources);

      this.db
        .insert(projects)
        .values({
          id: project.id,
          name: project.name,
          description: project.description,
          rootPath: project.rootPath,
          isTemplate: project.isTemplate,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        })
        .run();

      // Create default statuses atomically with project
      const defaultStatuses = [
        { label: 'Proposed', color: '#6c757d', position: 0 },
        { label: 'In Progress', color: '#007bff', position: 1 },
        { label: 'Review', color: '#ffc107', position: 2 },
        { label: 'Done', color: '#28a745', position: 3 },
        { label: 'Blocked', color: '#dc3545', position: 4 },
      ];

      for (const status of defaultStatuses) {
        this.db
          .insert(statuses)
          .values({
            id: randomUUID(),
            projectId: project.id,
            label: status.label,
            color: status.color,
            position: status.position,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }

      if (seedableSourceNames.length > 0) {
        this.db
          .insert(sourceProjectEnabled)
          .values(
            seedableSourceNames.map((sourceName) => ({
              id: randomUUID(),
              projectId: project.id,
              sourceName,
              enabled: true,
              createdAt: now,
            })),
          )
          .run();
      }
    });

    logger.info({ projectId: project.id }, 'Created project with default statuses (transactional)');
    return project;
  }

  /** Run `fn` inside a single WAL-safe IMMEDIATE transaction (create-core atomicity). */
  runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.txRunner.runImmediateAsync(fn);
  }

  /**
   * Insert a project row + seed enabled skill sources, transaction-free (must run inside
   * `runInTransaction`) and WITHOUT default statuses (the template statuses codec supplies
   * them). Mirrors the project-row + sourceProjectEnabled seeding the create-core delegate did.
   */
  async createProjectShell(
    data: CreateProject,
    options?: CreateProjectWithTemplateOptions,
  ): Promise<Project> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const providedProjectId = options?.projectId?.trim();
    const project: Project = {
      id: providedProjectId || randomUUID(),
      ...data,
      isTemplate: data.isTemplate ?? false,
      createdAt: now,
      updatedAt: now,
    };

    const { projects, sourceProjectEnabled, communitySkillSources } = await import(
      '../../db/schema'
    );
    const seedableSourceNames = this.listSeedableSourceNamesForNewProject(communitySkillSources);

    try {
      await this.db.insert(projects).values({
        id: project.id,
        name: project.name,
        description: project.description,
        rootPath: project.rootPath,
        isTemplate: project.isTemplate,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      });
    } catch (error) {
      // Preserve the create-core behavior: a client-supplied projectId colliding with an
      // existing row surfaces as a domain ConflictError (409), not a raw SQLite constraint
      // error. This insert only targets the projects table and `id` is the sole
      // caller-controlled unique/primary-key column, so any PK/UNIQUE violation here IS the
      // duplicate id — gate strictly on an explicitly-provided id. Match on the stable error
      // `code` (better-sqlite3's `message` getter is unreliable under load, and `projects.id`
      // is a PRIMARY KEY, whose violation code the message-based helper alone does not cover).
      const code = (error as { code?: unknown }).code;
      const isDuplicateId =
        code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
        code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        code === 'SQLITE_CONSTRAINT' ||
        isSqliteUniqueConstraint(error);
      if (providedProjectId && isDuplicateId) {
        throw new ConflictError(`Project ID "${providedProjectId}" already exists.`, {
          field: 'projectId',
          projectId: providedProjectId,
        });
      }
      throw error;
    }

    if (seedableSourceNames.length > 0) {
      await this.db.insert(sourceProjectEnabled).values(
        seedableSourceNames.map((sourceName) => ({
          id: randomUUID(),
          projectId: project.id,
          sourceName,
          enabled: true,
          createdAt: now,
        })),
      );
    }

    return project;
  }

  async getProject(id: string): Promise<Project> {
    const { projects } = await import('../../db/schema');
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
    const { projects } = await import('../../db/schema');
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

  async getProjectByRootPath(rootPath: string): Promise<Project | null> {
    const { resolve } = await import('path');
    const { projects } = await import('../../db/schema');
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
    const { projects } = await import('../../db/schema');

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

  async listProjects(options: ListOptions = {}): Promise<ListResult<Project>> {
    const { projects } = await import('../../db/schema');
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
    const { projects } = await import('../../db/schema');
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
    } = await import('../../db/schema');
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

    // 9b. Teams — team_members then teams (must be BEFORE agents due to FK constraints)
    const { teamMembers, teams } = await import('../../db/schema');
    const projectTeams = await this.db
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.projectId, id));
    const teamIds = projectTeams.map((t) => t.id);

    if (teamIds.length > 0) {
      await this.db.delete(teamMembers).where(inArray(teamMembers.teamId, teamIds));
      await this.db.delete(teams).where(inArray(teams.id, teamIds));
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
}
