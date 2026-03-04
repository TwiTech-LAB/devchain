import type { CreateProviderModel, ProviderModel } from '../../models/domain.models';
import {
  ConflictError,
  StorageError,
  ValidationError,
} from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { isSqliteUniqueConstraint } from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('ProviderModelStorageDelegate');

export class ProviderModelStorageDelegate extends BaseStorageDelegate {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async createProviderModel(data: CreateProviderModel): Promise<ProviderModel> {
    const { randomUUID } = await import('crypto');
    const { providerModels } = await import('../../db/schema');
    const { eq, sql } = await import('drizzle-orm');

    const name = this.normalizeAndValidateName(data.name);
    const now = new Date().toISOString();

    let position = data.position;
    if (position === undefined) {
      const maxResult = await this.db
        .select({ maxPos: sql<number>`COALESCE(MAX(${providerModels.position}), -1)` })
        .from(providerModels)
        .where(eq(providerModels.providerId, data.providerId));
      position = (maxResult[0]?.maxPos ?? -1) + 1;
    }

    const providerModel: ProviderModel = {
      id: randomUUID(),
      providerId: data.providerId,
      name,
      position,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.db.insert(providerModels).values({
        id: providerModel.id,
        providerId: providerModel.providerId,
        name: providerModel.name,
        position: providerModel.position,
        createdAt: providerModel.createdAt,
        updatedAt: providerModel.updatedAt,
      });
    } catch (error) {
      if (isSqliteUniqueConstraint(error)) {
        throw new ConflictError(`Model "${name}" already exists for this provider.`, {
          providerId: data.providerId,
          name,
        });
      }
      throw error;
    }

    logger.info(
      { providerModelId: providerModel.id, providerId: providerModel.providerId },
      'Created provider model',
    );

    return providerModel;
  }

  async listProviderModelsByProvider(providerId: string): Promise<ProviderModel[]> {
    const { providerModels } = await import('../../db/schema');
    const { eq, asc } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(providerModels)
      .where(eq(providerModels.providerId, providerId))
      .orderBy(asc(providerModels.position), asc(providerModels.id));

    return rows as ProviderModel[];
  }

  async listProviderModelsByProviderIds(providerIds: string[]): Promise<ProviderModel[]> {
    if (providerIds.length === 0) {
      return [];
    }

    const { providerModels } = await import('../../db/schema');
    const { inArray, asc } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(providerModels)
      .where(inArray(providerModels.providerId, providerIds))
      .orderBy(
        asc(providerModels.providerId),
        asc(providerModels.position),
        asc(providerModels.id),
      );

    return rows as ProviderModel[];
  }

  async deleteProviderModel(id: string): Promise<void> {
    const { providerModels } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    await this.db.delete(providerModels).where(eq(providerModels.id, id));
    logger.info({ providerModelId: id }, 'Deleted provider model');
  }

  async bulkCreateProviderModels(
    providerId: string,
    names: string[],
  ): Promise<{ added: string[]; existing: string[] }> {
    const { randomUUID } = await import('crypto');
    const { providerModels } = await import('../../db/schema');
    const { eq, sql } = await import('drizzle-orm');

    if (!Array.isArray(names)) {
      throw new ValidationError('names must be an array.', { providerId });
    }

    const normalizedFirstName = new Map<string, string>();
    const orderedNormalized: string[] = [];
    const duplicateNormalized = new Set<string>();

    for (const rawName of names) {
      const name = this.normalizeAndValidateName(rawName);
      const normalized = this.normalizeName(name);

      if (normalizedFirstName.has(normalized)) {
        duplicateNormalized.add(normalized);
        continue;
      }

      normalizedFirstName.set(normalized, name);
      orderedNormalized.push(normalized);
    }

    if (orderedNormalized.length === 0) {
      return { added: [], existing: [] };
    }

    const sqlite = this.rawClient;
    if (!sqlite || typeof sqlite.exec !== 'function') {
      throw new StorageError('Unable to access underlying SQLite client for transaction control');
    }

    sqlite.exec('BEGIN IMMEDIATE TRANSACTION');

    try {
      const existingRows = await this.db
        .select({ name: providerModels.name })
        .from(providerModels)
        .where(eq(providerModels.providerId, providerId));

      const existingNormalized = new Set(existingRows.map((row) => this.normalizeName(row.name)));
      const added: string[] = [];
      const existing: string[] = [];
      const existingOutputNormalized = new Set<string>();

      for (const normalized of orderedNormalized) {
        const displayName = normalizedFirstName.get(normalized) as string;
        if (existingNormalized.has(normalized)) {
          existing.push(displayName);
          existingOutputNormalized.add(normalized);
          continue;
        }
        added.push(displayName);
      }

      // Duplicate names in the same input payload are also skipped.
      for (const normalized of orderedNormalized) {
        if (!duplicateNormalized.has(normalized) || existingOutputNormalized.has(normalized)) {
          continue;
        }
        existing.push(normalizedFirstName.get(normalized) as string);
        existingOutputNormalized.add(normalized);
      }

      if (added.length > 0) {
        const maxResult = await this.db
          .select({ maxPos: sql<number>`COALESCE(MAX(${providerModels.position}), -1)` })
          .from(providerModels)
          .where(eq(providerModels.providerId, providerId));

        let nextPosition = (maxResult[0]?.maxPos ?? -1) + 1;
        const now = new Date().toISOString();
        const rowsToInsert = added.map((name) => ({
          id: randomUUID(),
          providerId,
          name,
          position: nextPosition++,
          createdAt: now,
          updatedAt: now,
        }));

        await this.db.insert(providerModels).values(rowsToInsert);
      }

      sqlite.exec('COMMIT');

      logger.info(
        { providerId, addedCount: added.length, existingCount: existing.length },
        'Bulk created provider models',
      );

      return { added, existing };
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  private normalizeAndValidateName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new ValidationError('Provider model name must not be empty or whitespace only.');
    }
    return trimmed;
  }

  private normalizeName(name: string): string {
    return name.trim().toLowerCase();
  }
}
