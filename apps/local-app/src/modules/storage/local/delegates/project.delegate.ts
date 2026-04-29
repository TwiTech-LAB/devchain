import type {
  CreateProjectWithTemplateOptions,
  CreateProjectWithTemplateResult,
  ListOptions,
  ListResult,
  TemplateImportPayload,
} from '../../interfaces/storage.interface';
import type { CreateProject, Project, UpdateProject } from '../../models/domain.models';
import {
  ConflictError,
  StorageError,
  ValidationError,
  NotFoundError,
} from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { getRawSqliteClient } from '../../db/sqlite-raw';
import { isSqliteUniqueConstraint } from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('ProjectStorageDelegate');

export class ProjectStorageDelegate extends BaseStorageDelegate {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  private async listSeedableSourceNamesForNewProject(): Promise<string[]> {
    const { communitySkillSources } = await import('../../db/schema');
    const communitySourceRows = await this.db
      .select({ name: communitySkillSources.name })
      .from(communitySkillSources);

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

    const seedableSourceNames = await this.listSeedableSourceNamesForNewProject();
    const { projects, statuses, sourceProjectEnabled } = await import('../../db/schema');

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

      if (seedableSourceNames.length > 0) {
        await tx.insert(sourceProjectEnabled).values(
          seedableSourceNames.map((sourceName) => ({
            id: randomUUID(),
            projectId: project.id,
            sourceName,
            enabled: true,
            createdAt: now,
          })),
        );
      }
    });

    logger.info({ projectId: project.id }, 'Created project with default statuses (transactional)');
    return project;
  }

  async createProjectWithTemplate(
    data: CreateProject,
    template: TemplateImportPayload,
    options?: CreateProjectWithTemplateOptions,
  ): Promise<CreateProjectWithTemplateResult> {
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

    const seedableSourceNames = await this.listSeedableSourceNamesForNewProject();
    const {
      projects,
      statuses,
      prompts,
      agentProfiles,
      agents,
      tags,
      promptTags,
      profileProviderConfigs,
      providers,
      sourceProjectEnabled,
    } = await import('../../db/schema');

    const statusIdMap: Record<string, string> = {};
    const promptIdMap: Record<string, string> = {};
    const profileIdMap: Record<string, string> = {};
    const configIdMap: Record<string, string> = {}; // Maps newProfileId -> configId
    const agentIdMap: Record<string, string> = {};

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
      // Note: providerId and options are now on profile_provider_configs, not on agent_profiles
      for (const prof of template.profiles) {
        const profileId = randomUUID();
        await this.db.insert(agentProfiles).values({
          id: profileId,
          projectId: project.id,
          name: prof.name,
          familySlug: prof.familySlug ?? null,
          systemPrompt: null,
          instructions: prof.instructions,
          // Temperature stored as integer (×100) to match createAgentProfile convention
          temperature: prof.temperature != null ? Math.round(prof.temperature * 100) : null,
          maxTokens: prof.maxTokens,
          createdAt: now,
          updatedAt: now,
        });
        if (prof.id) profileIdMap[prof.id] = profileId;

        // Handle provider configs for this profile
        // New format: providerConfigs array with positions
        // Fallback: Old format with single providerId/options
        if (prof.providerConfigs && prof.providerConfigs.length > 0) {
          // New format: multiple configs with positions
          // Sort by position (fallback to array index if position missing)
          const sortedConfigs = [...prof.providerConfigs].sort((a, b) => {
            const posA = a.position ?? 0;
            const posB = b.position ?? 0;
            return posA - posB;
          });

          for (const config of sortedConfigs) {
            // Resolve provider by name
            const provider = await this.db
              .select()
              .from(providers)
              .where(eq(providers.name, config.providerName))
              .limit(1);

            if (!provider[0]) {
              throw new ValidationError(`Provider not found: ${config.providerName}`);
            }

            const configId = randomUUID();
            await this.db.insert(profileProviderConfigs).values({
              id: configId,
              profileId: profileId,
              providerId: provider[0].id,
              name: config.name,
              options: config.options ?? null,
              env: config.env ? JSON.stringify(config.env) : null,
              position: config.position ?? sortedConfigs.indexOf(config), // Fallback to array index
              createdAt: now,
              updatedAt: now,
            });
            // Store first config as default for agents
            if (!configIdMap[profileId]) {
              configIdMap[profileId] = configId;
            }
          }
        } else {
          // Fallback for old templates: create single config from providerId/options
          const configId = randomUUID();
          await this.db.insert(profileProviderConfigs).values({
            id: configId,
            profileId: profileId,
            providerId: prof.providerId,
            name: prof.name, // Use profile name as config name
            options: prof.options ?? null,
            env: null,
            position: 0,
            createdAt: now,
            updatedAt: now,
          });
          configIdMap[profileId] = configId;
        }
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
        const configId = configIdMap[newProfileId];
        if (!configId) {
          throw new ValidationError(`Config mapping missing for agent ${a.name}`, {
            profileId: newProfileId,
          });
        }
        const agentId = randomUUID();
        await this.db.insert(agents).values({
          id: agentId,
          projectId: project.id,
          name: a.name,
          profileId: newProfileId,
          providerConfigId: configId,
          description: a.description ?? null,
          modelOverride: a.modelOverride ?? null,
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

      const errorMessage = error instanceof Error ? error.message : '';
      if (
        providedProjectId &&
        isSqliteUniqueConstraint(error) &&
        errorMessage.includes('projects.id')
      ) {
        throw new ConflictError(`Project ID "${providedProjectId}" already exists.`, {
          field: 'projectId',
          projectId: providedProjectId,
        });
      }

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
