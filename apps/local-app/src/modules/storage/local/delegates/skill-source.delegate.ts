import type Database from 'better-sqlite3';
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
  normalizeCommunitySourceNameForLookup,
  normalizeLocalSkillSourceFolderPath,
  normalizeProjectIdForSourceEnablement,
  normalizeSourceNameForSourceEnablement,
} from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('SkillSourceStorageDelegate');

export interface SkillSourceStorageDelegateDependencies {
  assertLocalSourceNameAvailableAcrossTypes: (sourceName: string) => Promise<void>;
  getCommunitySkillSource: (id: string) => Promise<CommunitySkillSource>;
  getLocalSkillSource: (id: string) => Promise<LocalSkillSource | null>;
}

export class SkillSourceStorageDelegate extends BaseStorageDelegate {
  constructor(
    context: StorageDelegateContext,
    private readonly dependencies: SkillSourceStorageDelegateDependencies,
  ) {
    super(context);
  }

  async getSourceProjectEnabled(projectId: string, sourceName: string): Promise<boolean | null> {
    const normalizedProjectId = normalizeProjectIdForSourceEnablement(projectId);
    const normalizedSourceName = normalizeSourceNameForSourceEnablement(sourceName);

    const { sourceProjectEnabled } = await import('../../db/schema');
    const { and, eq } = await import('drizzle-orm');
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

    const { sourceProjectEnabled } = await import('../../db/schema');
    const { and, eq } = await import('drizzle-orm');
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

    const { randomUUID } = await import('crypto');
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

    const { sourceProjectEnabled } = await import('../../db/schema');
    const { asc, eq } = await import('drizzle-orm');
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

  async seedSourceProjectDisabled(projectId: string, sourceNames: string[]): Promise<void> {
    const normalizedProjectId = normalizeProjectIdForSourceEnablement(projectId);
    const normalizedSourceNames = [
      ...new Set(sourceNames.map((name) => name.trim().toLowerCase())),
    ].filter((name) => name.length > 0);

    if (normalizedSourceNames.length === 0) {
      return;
    }

    const sqlite = this.rawClient as Database.Database | null;
    if (!sqlite || typeof sqlite.exec !== 'function') {
      throw new StorageError('Unable to access underlying SQLite client');
    }

    sqlite.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const { sourceProjectEnabled } = await import('../../db/schema');
      const { and, eq, inArray } = await import('drizzle-orm');
      const existingRows = await this.db
        .select({ sourceName: sourceProjectEnabled.sourceName })
        .from(sourceProjectEnabled)
        .where(
          and(
            eq(sourceProjectEnabled.projectId, normalizedProjectId),
            inArray(sourceProjectEnabled.sourceName, normalizedSourceNames),
          ),
        );

      const existingSourceNames = new Set(existingRows.map((row) => row.sourceName));
      const sourceNamesToInsert = normalizedSourceNames.filter(
        (sourceName) => !existingSourceNames.has(sourceName),
      );

      if (sourceNamesToInsert.length > 0) {
        const { randomUUID } = await import('crypto');
        const now = new Date().toISOString();
        await this.db.insert(sourceProjectEnabled).values(
          sourceNamesToInsert.map((sourceName) => ({
            id: randomUUID(),
            projectId: normalizedProjectId,
            sourceName,
            enabled: false,
            createdAt: now,
          })),
        );
      }

      sqlite.exec('COMMIT');
    } catch (error) {
      try {
        sqlite.exec('ROLLBACK');
      } catch (rollbackError) {
        logger.error({ rollbackError }, 'Failed to rollback seedSourceProjectDisabled transaction');
      }
      throw error;
    }
  }

  async deleteSourceProjectEnabledBySource(sourceName: string): Promise<void> {
    const normalizedSourceName = normalizeSourceNameForSourceEnablement(sourceName);
    const { sourceProjectEnabled } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db
      .delete(sourceProjectEnabled)
      .where(eq(sourceProjectEnabled.sourceName, normalizedSourceName));
  }

  async listCommunitySkillSources(): Promise<CommunitySkillSource[]> {
    const { communitySkillSources } = await import('../../db/schema');
    const { asc } = await import('drizzle-orm');
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

    const { communitySkillSources } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
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
    const normalizedName = normalizeCommunitySourceNameForLookup(name);
    const { communitySkillSources } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await this.db
      .select()
      .from(communitySkillSources)
      .where(eq(communitySkillSources.name, normalizedName))
      .limit(1);

    return (rows[0] as CommunitySkillSource | undefined) ?? null;
  }

  async createCommunitySkillSource(
    data: CreateCommunitySkillSource,
  ): Promise<CommunitySkillSource> {
    const normalizedName = normalizeCommunitySourceName(data.name);
    const normalizedRepoOwner = normalizeCommunityRepoPart(data.repoOwner, 'repoOwner');
    const normalizedRepoName = normalizeCommunityRepoPart(data.repoName, 'repoName');
    const normalizedBranch = normalizeCommunityBranch(data.branch);

    const { randomUUID } = await import('crypto');
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

    const { communitySkillSources } = await import('../../db/schema');
    try {
      await this.db.insert(communitySkillSources).values({
        id: record.id,
        name: record.name,
        repoOwner: record.repoOwner,
        repoName: record.repoName,
        branch: record.branch,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    } catch (error) {
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
    const source = await this.dependencies.getCommunitySkillSource(id);
    const { communitySkillSources, skills, sourceProjectEnabled } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    await this.db.transaction(async (tx) => {
      await tx.delete(skills).where(eq(skills.source, source.name));
      await tx.delete(sourceProjectEnabled).where(eq(sourceProjectEnabled.sourceName, source.name));
      await tx.delete(communitySkillSources).where(eq(communitySkillSources.id, source.id));
    });

    logger.info(
      { communitySkillSourceId: source.id, sourceName: source.name },
      'Deleted community skill source and related skills',
    );
  }

  async listLocalSkillSources(): Promise<LocalSkillSource[]> {
    const { localSkillSources } = await import('../../db/schema');
    const { asc } = await import('drizzle-orm');
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

    const { localSkillSources } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await this.db
      .select()
      .from(localSkillSources)
      .where(eq(localSkillSources.id, normalizedId))
      .limit(1);

    return (rows[0] as LocalSkillSource | undefined) ?? null;
  }

  async createLocalSkillSource(data: CreateLocalSkillSource): Promise<LocalSkillSource> {
    const normalizedName = normalizeCommunitySourceNameForLookup(data.name);
    const normalizedFolderPath = normalizeLocalSkillSourceFolderPath(data.folderPath);
    await this.dependencies.assertLocalSourceNameAvailableAcrossTypes(normalizedName);

    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const record: LocalSkillSource = {
      id: randomUUID(),
      name: normalizedName,
      folderPath: normalizedFolderPath,
      createdAt: now,
      updatedAt: now,
    };

    const { localSkillSources } = await import('../../db/schema');
    try {
      await this.db.insert(localSkillSources).values({
        id: record.id,
        name: record.name,
        folderPath: record.folderPath,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    } catch (error) {
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
    const source = await this.dependencies.getLocalSkillSource(id);
    if (!source) {
      throw new NotFoundError('Local skill source', id.trim());
    }

    const { localSkillSources, skills, sourceProjectEnabled } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    await this.db.transaction(async (tx) => {
      await tx.delete(skills).where(eq(skills.source, source.name));
      await tx.delete(sourceProjectEnabled).where(eq(sourceProjectEnabled.sourceName, source.name));
      await tx.delete(localSkillSources).where(eq(localSkillSources.id, source.id));
    });

    logger.info(
      { localSkillSourceId: source.id, sourceName: source.name },
      'Deleted local skill source and related skills',
    );
  }
}
