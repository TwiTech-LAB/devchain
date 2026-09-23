import type {
  CreateSkillSourceOptions,
  ExistingProjectsEnablement,
} from '../../interfaces/storage.interface';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import {
  communitySkillSources,
  localSkillSources,
  projects,
  skills,
  sourceProjectEnabled,
} from '../../db/schema';
import type {
  CommunitySkillSource,
  CreateCommunitySkillSource,
  CreateLocalSkillSource,
  LocalSkillSource,
} from '../../models/domain.models';
import {
  ConflictError,
  NotFoundError,
  StorageError,
  ValidationError,
} from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import {
  isSqliteUniqueConstraint,
  normalizeCommunityBranch,
  normalizeCommunityRepoPart,
  normalizeCommunitySourceName,
  normalizeLocalSkillSourceFolderPath,
  normalizeProjectIdForSourceEnablement,
  normalizeSourceNameForSourceEnablement,
} from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('SkillSourceStorageDelegate');

export class SkillSourceStorageDelegate extends BaseStorageDelegate {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async getSourceProjectEnabled(projectId: string, sourceName: string): Promise<boolean | null> {
    const normalizedProjectId = normalizeProjectIdForSourceEnablement(projectId);
    const normalizedSourceName = normalizeSourceNameForSourceEnablement(sourceName);

    const rows = await this.db
      .select({ enabled: sourceProjectEnabled.enabled })
      .from(sourceProjectEnabled)
      .where(
        and(
          eq(sourceProjectEnabled.projectId, normalizedProjectId),
          eq(sourceProjectEnabled.sourceName, normalizedSourceName),
        ),
      )
      .limit(1);

    return rows[0] ? Boolean(rows[0].enabled) : null;
  }

  async setSourceProjectEnabled(
    projectId: string,
    sourceName: string,
    enabled: boolean,
  ): Promise<void> {
    const normalizedProjectId = normalizeProjectIdForSourceEnablement(projectId);
    const normalizedSourceName = normalizeSourceNameForSourceEnablement(sourceName);

    const existing = await this.db
      .select({ id: sourceProjectEnabled.id })
      .from(sourceProjectEnabled)
      .where(
        and(
          eq(sourceProjectEnabled.projectId, normalizedProjectId),
          eq(sourceProjectEnabled.sourceName, normalizedSourceName),
        ),
      )
      .limit(1);

    if (existing[0]) {
      await this.db
        .update(sourceProjectEnabled)
        .set({ enabled })
        .where(eq(sourceProjectEnabled.id, existing[0].id));
      return;
    }

    await this.db.insert(sourceProjectEnabled).values({
      id: randomUUID(),
      projectId: normalizedProjectId,
      sourceName: normalizedSourceName,
      enabled,
      createdAt: new Date().toISOString(),
    });
  }

  async listSourceProjectEnabled(
    projectId: string,
  ): Promise<Array<{ sourceName: string; enabled: boolean }>> {
    const normalizedProjectId = normalizeProjectIdForSourceEnablement(projectId);

    const rows = await this.db
      .select({
        sourceName: sourceProjectEnabled.sourceName,
        enabled: sourceProjectEnabled.enabled,
      })
      .from(sourceProjectEnabled)
      .where(eq(sourceProjectEnabled.projectId, normalizedProjectId))
      .orderBy(asc(sourceProjectEnabled.sourceName));

    return rows.map((row) => ({
      sourceName: row.sourceName,
      enabled: Boolean(row.enabled),
    }));
  }

  async listCommunitySkillSources(): Promise<CommunitySkillSource[]> {
    const rows = await this.db
      .select()
      .from(communitySkillSources)
      .orderBy(asc(communitySkillSources.name));
    return rows as CommunitySkillSource[];
  }

  async getCommunitySkillSource(id: string): Promise<CommunitySkillSource> {
    const normalizedId = id.trim();
    if (!normalizedId) {
      throw new ValidationError('id is required.', { fieldName: 'id' });
    }

    const rows = await this.db
      .select()
      .from(communitySkillSources)
      .where(eq(communitySkillSources.id, normalizedId))
      .limit(1);

    if (!rows[0]) {
      throw new NotFoundError('Community skill source', normalizedId);
    }

    return rows[0] as CommunitySkillSource;
  }

  async getCommunitySkillSourceByName(name: string): Promise<CommunitySkillSource | null> {
    const normalizedName = normalizeCommunitySourceName(name);
    const rows = await this.db
      .select()
      .from(communitySkillSources)
      .where(eq(communitySkillSources.name, normalizedName))
      .limit(1);

    return (rows[0] as CommunitySkillSource | undefined) ?? null;
  }

  async createCommunitySkillSource(
    data: CreateCommunitySkillSource,
    options?: CreateSkillSourceOptions,
  ): Promise<CommunitySkillSource> {
    const normalizedName = normalizeCommunitySourceName(data.name);
    const normalizedRepoOwner = normalizeCommunityRepoPart(data.repoOwner, 'repoOwner');
    const normalizedRepoName = normalizeCommunityRepoPart(data.repoName, 'repoName');
    const normalizedBranch = normalizeCommunityBranch(data.branch);

    const now = new Date().toISOString();
    const record: CommunitySkillSource = {
      id: randomUUID(),
      name: normalizedName,
      repoOwner: normalizedRepoOwner,
      repoName: normalizedRepoName,
      branch: normalizedBranch,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.txRunner.runImmediateQueued(() => {
        const oppositeKind = this.db
          .select({ id: localSkillSources.id })
          .from(localSkillSources)
          .where(eq(localSkillSources.name, normalizedName))
          .limit(1)
          .get();
        if (oppositeKind) {
          throw this.crossKindNameConflict(normalizedName);
        }

        this.db
          .insert(communitySkillSources)
          .values({
            id: record.id,
            name: record.name,
            repoOwner: record.repoOwner,
            repoName: record.repoName,
            branch: record.branch,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          })
          .run();

        if (options?.existingProjects) {
          this.seedExistingProjectsInCurrentTransaction(record.name, now, options.existingProjects);
        }
      });
    } catch (error) {
      if (error instanceof ConflictError || error instanceof ValidationError) {
        throw error;
      }
      if (isSqliteUniqueConstraint(error)) {
        const rawMessage =
          typeof error === 'object' && error !== null && 'message' in error
            ? String((error as { message?: unknown }).message ?? '')
            : '';
        if (rawMessage.includes('community_skill_sources.name')) {
          throw new ConflictError('Community skill source name already exists.', {
            name: normalizedName,
          });
        }
        throw new ConflictError('Community skill source repository already exists.', {
          repoOwner: normalizedRepoOwner,
          repoName: normalizedRepoName,
        });
      }
      throw new StorageError('Failed to create community skill source.', {
        name: normalizedName,
        repoOwner: normalizedRepoOwner,
        repoName: normalizedRepoName,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info(
      { communitySkillSourceId: record.id, name: record.name },
      'Created community skill source',
    );
    return record;
  }

  async deleteCommunitySkillSource(id: string): Promise<void> {
    const normalizedId = id.trim();
    if (!normalizedId) {
      throw new ValidationError('id is required.', { fieldName: 'id' });
    }

    const source = await this.txRunner.runImmediateQueued(() => {
      const existingSource = this.db
        .select()
        .from(communitySkillSources)
        .where(eq(communitySkillSources.id, normalizedId))
        .limit(1)
        .get() as CommunitySkillSource | undefined;

      if (!existingSource) {
        throw new NotFoundError('Community skill source', normalizedId);
      }

      this.db.delete(skills).where(eq(skills.source, existingSource.name)).run();
      this.db
        .delete(sourceProjectEnabled)
        .where(eq(sourceProjectEnabled.sourceName, existingSource.name))
        .run();
      this.db
        .delete(communitySkillSources)
        .where(eq(communitySkillSources.id, existingSource.id))
        .run();
      return existingSource;
    });

    logger.info(
      { communitySkillSourceId: source.id, sourceName: source.name },
      'Deleted community skill source and related skills',
    );
  }

  async listLocalSkillSources(): Promise<LocalSkillSource[]> {
    const rows = await this.db
      .select()
      .from(localSkillSources)
      .orderBy(asc(localSkillSources.name));
    return rows as LocalSkillSource[];
  }

  async getLocalSkillSource(id: string): Promise<LocalSkillSource | null> {
    const normalizedId = id.trim();
    if (!normalizedId) {
      throw new ValidationError('id is required.', { fieldName: 'id' });
    }

    const rows = await this.db
      .select()
      .from(localSkillSources)
      .where(eq(localSkillSources.id, normalizedId))
      .limit(1);

    return (rows[0] as LocalSkillSource | undefined) ?? null;
  }

  async getLocalSkillSourceByName(name: string): Promise<LocalSkillSource | null> {
    const normalizedName = normalizeCommunitySourceName(name);
    const row = await this.db
      .select()
      .from(localSkillSources)
      .where(eq(localSkillSources.name, normalizedName))
      .limit(1);

    return (row[0] as LocalSkillSource | undefined) ?? null;
  }

  async createLocalSkillSource(
    data: CreateLocalSkillSource,
    options?: CreateSkillSourceOptions,
  ): Promise<LocalSkillSource> {
    const normalizedName = normalizeCommunitySourceName(data.name);
    const normalizedFolderPath = normalizeLocalSkillSourceFolderPath(data.folderPath);

    const now = new Date().toISOString();
    const record: LocalSkillSource = {
      id: randomUUID(),
      name: normalizedName,
      folderPath: normalizedFolderPath,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.txRunner.runImmediateQueued(() => {
        const oppositeKind = this.db
          .select({ id: communitySkillSources.id })
          .from(communitySkillSources)
          .where(eq(communitySkillSources.name, normalizedName))
          .limit(1)
          .get();
        if (oppositeKind) {
          throw this.crossKindNameConflict(normalizedName);
        }

        this.db
          .insert(localSkillSources)
          .values({
            id: record.id,
            name: record.name,
            folderPath: record.folderPath,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          })
          .run();

        if (options?.existingProjects) {
          this.seedExistingProjectsInCurrentTransaction(record.name, now, options.existingProjects);
        }
      });
    } catch (error) {
      if (error instanceof ConflictError || error instanceof ValidationError) {
        throw error;
      }
      if (isSqliteUniqueConstraint(error)) {
        const rawMessage =
          typeof error === 'object' && error !== null && 'message' in error
            ? String((error as { message?: unknown }).message ?? '')
            : '';
        if (rawMessage.includes('local_skill_sources.name')) {
          throw new ConflictError('Local skill source name already exists.', {
            name: normalizedName,
          });
        }
        if (rawMessage.includes('local_skill_sources.folder_path')) {
          throw new ConflictError('Local skill source folder path already exists.', {
            folderPath: normalizedFolderPath,
          });
        }
        throw new ConflictError('Local skill source already exists.', {
          name: normalizedName,
          folderPath: normalizedFolderPath,
        });
      }
      throw new StorageError('Failed to create local skill source.', {
        name: normalizedName,
        folderPath: normalizedFolderPath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info({ localSkillSourceId: record.id, name: record.name }, 'Created local skill source');
    return record;
  }

  async deleteLocalSkillSource(id: string): Promise<void> {
    const normalizedId = id.trim();
    if (!normalizedId) {
      throw new ValidationError('id is required.', { fieldName: 'id' });
    }

    const source = await this.txRunner.runImmediateQueued(() => {
      const existingSource = this.db
        .select()
        .from(localSkillSources)
        .where(eq(localSkillSources.id, normalizedId))
        .limit(1)
        .get() as LocalSkillSource | undefined;

      if (!existingSource) {
        throw new NotFoundError('Local skill source', normalizedId);
      }

      this.db.delete(skills).where(eq(skills.source, existingSource.name)).run();
      this.db
        .delete(sourceProjectEnabled)
        .where(eq(sourceProjectEnabled.sourceName, existingSource.name))
        .run();
      this.db.delete(localSkillSources).where(eq(localSkillSources.id, existingSource.id)).run();
      return existingSource;
    });

    logger.info(
      { localSkillSourceId: source.id, sourceName: source.name },
      'Deleted local skill source and related skills',
    );
  }

  private seedExistingProjectsInCurrentTransaction(
    sourceName: string,
    createdAt: string,
    choice: ExistingProjectsEnablement,
  ): void {
    const projectRows = this.db.select({ id: projects.id }).from(projects).all();

    // Validation runs inside the owning transaction so an unknown project id
    // rolls back the source insert as well: no source row, no enablement rows.
    if (choice.mode === 'selected') {
      const knownIds = new Set(projectRows.map((row) => row.id));
      const unknownIds = choice.projectIds.filter((id) => !knownIds.has(id));
      if (unknownIds.length > 0) {
        throw new ValidationError('Unknown project ids in existing projects selection.', {
          unknownProjectIds: unknownIds,
        });
      }
    }

    if (projectRows.length === 0) {
      return;
    }

    const enabledProjectIds = new Set(this.enabledExistingProjectIds(choice, projectRows));

    this.db
      .insert(sourceProjectEnabled)
      .values(
        projectRows.map((project) => ({
          id: randomUUID(),
          projectId: project.id,
          sourceName,
          enabled: enabledProjectIds.has(project.id),
          createdAt,
        })),
      )
      .onConflictDoNothing()
      .run();
  }

  private enabledExistingProjectIds(
    choice: ExistingProjectsEnablement,
    projectRows: Array<{ id: string }>,
  ): string[] {
    switch (choice.mode) {
      case 'all':
        return projectRows.map((row) => row.id);
      case 'selected':
        return choice.projectIds;
      case 'none':
        return [];
    }
  }

  private crossKindNameConflict(name: string): ConflictError {
    return new ConflictError('Skill source name already exists for another managed source kind.', {
      name,
    });
  }
}
