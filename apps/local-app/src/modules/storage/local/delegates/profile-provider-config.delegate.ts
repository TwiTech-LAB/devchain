import {
  type CreateProfileProviderConfig,
  type ProfileProviderConfig,
  type UpdateProfileProviderConfig,
} from '../../models/domain.models';
import {
  NotFoundError,
  StorageError,
  ValidationError,
} from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { isSqliteUniqueConstraint, parseProviderConfigEnv } from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

export type CreateIfMissingResult = {
  inserted: boolean;
  reason?:
    | 'name_exists_same_provider'
    | 'name_exists_other_provider'
    | 'position_conflict'
    | 'unknown_constraint';
  existingRow?: ProfileProviderConfig;
};

const logger = createLogger('ProfileProviderConfigStorageDelegate');

export interface ProfileProviderConfigStorageDelegateDependencies {
  getProfileProviderConfig: (id: string) => Promise<ProfileProviderConfig>;
}

export class ProfileProviderConfigStorageDelegate extends BaseStorageDelegate {
  constructor(
    context: StorageDelegateContext,
    private readonly dependencies: ProfileProviderConfigStorageDelegateDependencies,
  ) {
    super(context);
  }

  async createProfileProviderConfig(
    data: CreateProfileProviderConfig,
  ): Promise<ProfileProviderConfig> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { profileProviderConfigs } = await import('../../db/schema');
    const { eq, sql } = await import('drizzle-orm');

    // Calculate next position if not provided
    let position = data.position;
    if (position === undefined) {
      const maxResult = await this.db
        .select({ maxPos: sql<number>`COALESCE(MAX(${profileProviderConfigs.position}), -1)` })
        .from(profileProviderConfigs)
        .where(eq(profileProviderConfigs.profileId, data.profileId));
      position = (maxResult[0]?.maxPos ?? -1) + 1;
    }

    const config: ProfileProviderConfig = {
      id: randomUUID(),
      profileId: data.profileId,
      providerId: data.providerId,
      name: data.name,
      description: data.description ?? null,
      options: data.options ?? null,
      env: data.env ?? null,
      position,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(profileProviderConfigs).values({
      id: config.id,
      profileId: config.profileId,
      providerId: config.providerId,
      name: config.name,
      description: config.description,
      options: config.options,
      env: config.env ? JSON.stringify(config.env) : null,
      position: config.position,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    });

    logger.info(
      { configId: config.id, profileId: config.profileId, position },
      'Created profile provider config',
    );
    return config;
  }

  async createIfMissing(input: {
    profileId: string;
    providerId: string;
    name: string;
    description?: string | null;
    options?: string | null;
    env?: Record<string, string>;
  }): Promise<CreateIfMissingResult> {
    const { randomUUID } = await import('crypto');
    const { profileProviderConfigs } = await import('../../db/schema');
    const { eq, and, sql } = await import('drizzle-orm');

    const sqlite = this.rawClient;
    if (!sqlite || typeof sqlite.exec !== 'function') {
      throw new StorageError('Unable to access underlying SQLite client for transaction control');
    }

    sqlite.exec('BEGIN IMMEDIATE TRANSACTION');

    try {
      const existing = await this.db
        .select()
        .from(profileProviderConfigs)
        .where(
          and(
            eq(profileProviderConfigs.profileId, input.profileId),
            eq(profileProviderConfigs.name, input.name),
          ),
        )
        .limit(1);

      if (existing[0]) {
        const row = existing[0];
        const existingRow: ProfileProviderConfig = {
          id: row.id,
          profileId: row.profileId,
          providerId: row.providerId,
          name: row.name,
          description: row.description,
          options: row.options,
          env: parseProviderConfigEnv(row.env, row.id, row.profileId),
          position: row.position,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
        sqlite.exec('COMMIT');
        return {
          inserted: false,
          reason:
            row.providerId === input.providerId
              ? 'name_exists_same_provider'
              : 'name_exists_other_provider',
          existingRow,
        };
      }

      const maxResult = await this.db
        .select({ maxPos: sql<number>`COALESCE(MAX(${profileProviderConfigs.position}), -1)` })
        .from(profileProviderConfigs)
        .where(eq(profileProviderConfigs.profileId, input.profileId));
      const nextPosition = (maxResult[0]?.maxPos ?? -1) + 1;

      const now = new Date().toISOString();
      const id = randomUUID();

      try {
        await this.db.insert(profileProviderConfigs).values({
          id,
          profileId: input.profileId,
          providerId: input.providerId,
          name: input.name,
          description: input.description ?? null,
          options: input.options ?? null,
          env: input.env ? JSON.stringify(input.env) : null,
          position: nextPosition,
          createdAt: now,
          updatedAt: now,
        });

        sqlite.exec('COMMIT');
        logger.info(
          { configId: id, profileId: input.profileId, position: nextPosition },
          'Created profile provider config (createIfMissing)',
        );
        return { inserted: true };
      } catch (insertError) {
        if (!isSqliteUniqueConstraint(insertError)) {
          throw insertError;
        }

        const nameConflict = await this.db
          .select()
          .from(profileProviderConfigs)
          .where(
            and(
              eq(profileProviderConfigs.profileId, input.profileId),
              eq(profileProviderConfigs.name, input.name),
            ),
          )
          .limit(1);

        if (nameConflict[0]) {
          const row = nameConflict[0];
          const existingRow: ProfileProviderConfig = {
            id: row.id,
            profileId: row.profileId,
            providerId: row.providerId,
            name: row.name,
            description: row.description,
            options: row.options,
            env: parseProviderConfigEnv(row.env, row.id, row.profileId),
            position: row.position,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
          sqlite.exec('COMMIT');
          return {
            inserted: false,
            reason:
              row.providerId === input.providerId
                ? 'name_exists_same_provider'
                : 'name_exists_other_provider',
            existingRow,
          };
        }

        const posConflict = await this.db
          .select()
          .from(profileProviderConfigs)
          .where(
            and(
              eq(profileProviderConfigs.profileId, input.profileId),
              eq(profileProviderConfigs.position, nextPosition),
            ),
          )
          .limit(1);

        if (posConflict[0]) {
          sqlite.exec('COMMIT');
          return { inserted: false, reason: 'position_conflict' };
        }

        sqlite.exec('COMMIT');
        return { inserted: false, reason: 'unknown_constraint' };
      }
    } catch (error) {
      try {
        sqlite.exec('ROLLBACK');
      } catch (rollbackError) {
        logger.error({ rollbackError }, 'Failed to rollback createIfMissing transaction');
      }
      throw error;
    }
  }

  async getProfileProviderConfig(id: string): Promise<ProfileProviderConfig> {
    const { profileProviderConfigs } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const result = await this.db
      .select()
      .from(profileProviderConfigs)
      .where(eq(profileProviderConfigs.id, id))
      .limit(1);

    if (!result[0]) {
      throw new NotFoundError('ProfileProviderConfig', id);
    }

    const row = result[0];
    return {
      id: row.id,
      profileId: row.profileId,
      providerId: row.providerId,
      name: row.name,
      description: row.description,
      options: row.options,
      env: parseProviderConfigEnv(row.env, row.id, row.profileId),
      position: row.position,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async listProfileProviderConfigsByProfile(profileId: string): Promise<ProfileProviderConfig[]> {
    const { profileProviderConfigs, providers } = await import('../../db/schema');
    const { eq, asc } = await import('drizzle-orm');

    const results = await this.db
      .select({
        config: profileProviderConfigs,
        providerName: providers.name,
      })
      .from(profileProviderConfigs)
      .leftJoin(providers, eq(profileProviderConfigs.providerId, providers.id))
      .where(eq(profileProviderConfigs.profileId, profileId))
      .orderBy(asc(profileProviderConfigs.position), asc(profileProviderConfigs.id));

    return results.map((row) => ({
      id: row.config.id,
      profileId: row.config.profileId,
      providerId: row.config.providerId,
      providerName: row.providerName ?? row.config.providerId,
      name: row.config.name,
      description: row.config.description,
      options: row.config.options,
      env: parseProviderConfigEnv(row.config.env, row.config.id, row.config.profileId),
      position: row.config.position,
      createdAt: row.config.createdAt,
      updatedAt: row.config.updatedAt,
    }));
  }

  async listProfileProviderConfigsByIds(ids: string[]): Promise<ProfileProviderConfig[]> {
    if (ids.length === 0) {
      return [];
    }

    const { profileProviderConfigs } = await import('../../db/schema');
    const { inArray } = await import('drizzle-orm');

    const results = await this.db
      .select()
      .from(profileProviderConfigs)
      .where(inArray(profileProviderConfigs.id, ids));

    return results.map((row) => ({
      id: row.id,
      profileId: row.profileId,
      providerId: row.providerId,
      name: row.name,
      description: row.description,
      options: row.options,
      env: parseProviderConfigEnv(row.env, row.id, row.profileId),
      position: row.position,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async listAllProfileProviderConfigs(): Promise<ProfileProviderConfig[]> {
    const { profileProviderConfigs } = await import('../../db/schema');

    const results = await this.db.select().from(profileProviderConfigs);

    return results.map((row) => ({
      id: row.id,
      profileId: row.profileId,
      providerId: row.providerId,
      name: row.name,
      description: row.description,
      options: row.options,
      env: parseProviderConfigEnv(row.env, row.id, row.profileId),
      position: row.position,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async updateProfileProviderConfig(
    id: string,
    data: UpdateProfileProviderConfig,
  ): Promise<ProfileProviderConfig> {
    const { profileProviderConfigs } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    // Prepare update data with JSON serialization for env
    const updateData: Record<string, unknown> = { updatedAt: now };
    if (data.providerId !== undefined) {
      updateData.providerId = data.providerId;
    }
    if (data.name !== undefined) {
      updateData.name = data.name;
    }
    if (data.description !== undefined) {
      updateData.description = data.description;
    }
    if (data.options !== undefined) {
      updateData.options = data.options;
    }
    if (data.env !== undefined) {
      updateData.env = data.env ? JSON.stringify(data.env) : null;
    }
    if (data.position !== undefined) {
      updateData.position = data.position;
    }

    await this.db
      .update(profileProviderConfigs)
      .set(updateData)
      .where(eq(profileProviderConfigs.id, id));

    logger.info({ configId: id }, 'Updated profile provider config');
    return this.dependencies.getProfileProviderConfig(id);
  }

  async deleteProfileProviderConfig(id: string): Promise<void> {
    const { profileProviderConfigs } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    // Check if any agents reference this config
    const { agents } = await import('../../db/schema');
    const agentRefs = await this.db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.providerConfigId, id))
      .limit(1);

    if (agentRefs.length > 0) {
      throw new ValidationError('Cannot delete provider config: still referenced by agents', {
        configId: id,
        referencingAgentId: agentRefs[0].id,
      });
    }

    await this.db.delete(profileProviderConfigs).where(eq(profileProviderConfigs.id, id));
    logger.info({ configId: id }, 'Deleted profile provider config');
  }

  async reorderProfileProviderConfigs(profileId: string, configIds: string[]): Promise<void> {
    const { profileProviderConfigs } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    // Use raw SQL transaction for guaranteed atomicity
    const sqlite = this.rawClient;
    if (!sqlite || typeof sqlite.exec !== 'function') {
      throw new StorageError('Unable to access underlying SQLite client for transaction control');
    }

    try {
      // Start transaction
      sqlite.exec('BEGIN IMMEDIATE TRANSACTION');

      // Compute tempBase from max position to avoid conflicts
      const configs = await this.db
        .select({ position: profileProviderConfigs.position })
        .from(profileProviderConfigs)
        .where(eq(profileProviderConfigs.profileId, profileId));

      const maxPosition = Math.max(0, ...configs.map((c) => c.position ?? 0));
      const tempBase = maxPosition + 1000;

      // First pass: set all to temporary high positions
      for (let i = 0; i < configIds.length; i++) {
        await this.db
          .update(profileProviderConfigs)
          .set({ position: tempBase + i })
          .where(eq(profileProviderConfigs.id, configIds[i]));
      }

      // Second pass: set them to their final positions
      for (let i = 0; i < configIds.length; i++) {
        await this.db
          .update(profileProviderConfigs)
          .set({ position: i })
          .where(eq(profileProviderConfigs.id, configIds[i]));
      }

      // Commit transaction
      sqlite.exec('COMMIT');
      logger.info({ profileId, configIds }, 'Reordered provider configs');
    } catch (error) {
      // Rollback transaction on any error
      sqlite.exec('ROLLBACK');
      logger.error(
        { error, profileId, configIds },
        'Failed to reorder provider configs, rolled back',
      );
      throw error;
    }
  }
}
