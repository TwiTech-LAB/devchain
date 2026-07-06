import type { CreateProviderEffort, ProviderEffort } from '../../models/domain.models';
import { ConflictError, ValidationError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { isSqliteUniqueConstraint } from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('ProviderEffortStorageDelegate');

export class ProviderEffortStorageDelegate extends BaseStorageDelegate {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async createProviderEffort(data: CreateProviderEffort): Promise<ProviderEffort> {
    const { randomUUID } = await import('crypto');
    const { providerEfforts } = await import('../../db/schema');
    const { eq, sql } = await import('drizzle-orm');

    const name = this.normalizeAndValidateName(data.name);
    const now = new Date().toISOString();

    let position = data.position;
    if (position === undefined) {
      const maxResult = await this.db
        .select({ maxPos: sql<number>`COALESCE(MAX(${providerEfforts.position}), -1)` })
        .from(providerEfforts)
        .where(eq(providerEfforts.providerId, data.providerId));
      position = (maxResult[0]?.maxPos ?? -1) + 1;
    }

    const providerEffort: ProviderEffort = {
      id: randomUUID(),
      providerId: data.providerId,
      name,
      position,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.db.insert(providerEfforts).values({
        id: providerEffort.id,
        providerId: providerEffort.providerId,
        name: providerEffort.name,
        position: providerEffort.position,
        createdAt: providerEffort.createdAt,
        updatedAt: providerEffort.updatedAt,
      });
    } catch (error) {
      if (isSqliteUniqueConstraint(error)) {
        throw new ConflictError(`Effort "${name}" already exists for this provider.`, {
          providerId: data.providerId,
          name,
        });
      }
      throw error;
    }

    logger.info(
      { providerEffortId: providerEffort.id, providerId: providerEffort.providerId },
      'Created provider effort',
    );

    return providerEffort;
  }

  async listProviderEffortsByProvider(providerId: string): Promise<ProviderEffort[]> {
    const { providerEfforts } = await import('../../db/schema');
    const { eq, asc } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(providerEfforts)
      .where(eq(providerEfforts.providerId, providerId))
      .orderBy(asc(providerEfforts.position), asc(providerEfforts.id));

    return rows as ProviderEffort[];
  }

  async listProviderEffortsByProviderIds(providerIds: string[]): Promise<ProviderEffort[]> {
    if (providerIds.length === 0) {
      return [];
    }

    const { providerEfforts } = await import('../../db/schema');
    const { inArray, asc } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(providerEfforts)
      .where(inArray(providerEfforts.providerId, providerIds))
      .orderBy(
        asc(providerEfforts.providerId),
        asc(providerEfforts.position),
        asc(providerEfforts.id),
      );

    return rows as ProviderEffort[];
  }

  async deleteProviderEffort(id: string): Promise<void> {
    const { providerEfforts } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    await this.db.delete(providerEfforts).where(eq(providerEfforts.id, id));
    logger.info({ providerEffortId: id }, 'Deleted provider effort');
  }

  async bulkCreateProviderEfforts(
    providerId: string,
    names: string[],
  ): Promise<{ added: string[]; existing: string[] }> {
    const { randomUUID } = await import('crypto');
    const { providerEfforts } = await import('../../db/schema');
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

    return this.txRunner.runImmediateAsync(async () => {
      const existingRows = await this.db
        .select({ name: providerEfforts.name })
        .from(providerEfforts)
        .where(eq(providerEfforts.providerId, providerId));

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

      for (const normalized of orderedNormalized) {
        if (!duplicateNormalized.has(normalized) || existingOutputNormalized.has(normalized)) {
          continue;
        }
        existing.push(normalizedFirstName.get(normalized) as string);
        existingOutputNormalized.add(normalized);
      }

      if (added.length > 0) {
        const maxResult = await this.db
          .select({ maxPos: sql<number>`COALESCE(MAX(${providerEfforts.position}), -1)` })
          .from(providerEfforts)
          .where(eq(providerEfforts.providerId, providerId));

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

        await this.db.insert(providerEfforts).values(rowsToInsert);
      }

      logger.info(
        { providerId, addedCount: added.length, existingCount: existing.length },
        'Bulk created provider efforts',
      );

      return { added, existing };
    });
  }

  private normalizeAndValidateName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new ValidationError('Provider effort name must not be empty or whitespace only.');
    }
    return trimmed;
  }

  private normalizeName(name: string): string {
    return name.trim().toLowerCase();
  }
}
