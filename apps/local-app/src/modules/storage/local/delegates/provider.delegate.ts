import type { ListOptions, ListResult } from '../../interfaces/storage.interface';
import type {
  CreateProvider,
  Provider,
  ProviderMcpMetadata,
  UpdateProvider,
  UpdateProviderMcpMetadata,
} from '../../models/domain.models';
import { NotFoundError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('ProviderStorageDelegate');

export interface ProviderStorageDelegateDependencies {
  updateProvider: (id: string, data: UpdateProvider) => Promise<Provider>;
}

export class ProviderStorageDelegate extends BaseStorageDelegate {
  constructor(
    context: StorageDelegateContext,
    private readonly dependencies: ProviderStorageDelegateDependencies,
  ) {
    super(context);
  }

  async createProvider(data: CreateProvider): Promise<Provider> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { providers } = await import('../../db/schema');

    // Default autoCompactThreshold to 85 for Claude providers if not explicitly provided
    const autoCompactThreshold =
      data.autoCompactThreshold !== undefined
        ? data.autoCompactThreshold
        : data.name.toLowerCase() === 'claude'
          ? 85
          : null;

    const provider: Provider = {
      id: randomUUID(),
      name: data.name,
      binPath: data.binPath ?? null,
      mcpConfigured: data.mcpConfigured ?? false,
      mcpEndpoint: data.mcpEndpoint ?? null,
      mcpRegisteredAt: data.mcpRegisteredAt ?? null,
      autoCompactThreshold,
      oneMillionContextEnabled: data.oneMillionContextEnabled ?? false,
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
      autoCompactThreshold: provider.autoCompactThreshold,
      oneMillionContextEnabled: provider.oneMillionContextEnabled,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
    });

    logger.info({ providerId: provider.id, name: provider.name }, 'Created provider');
    return provider;
  }

  async getProvider(id: string): Promise<Provider> {
    const { providers } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const result = await this.db.select().from(providers).where(eq(providers.id, id)).limit(1);
    if (!result[0]) {
      throw new NotFoundError('Provider', id);
    }
    return result[0] as Provider;
  }

  async listProviders(options: ListOptions = {}): Promise<ListResult<Provider>> {
    const { providers } = await import('../../db/schema');
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

  async listProvidersByIds(ids: string[]): Promise<Provider[]> {
    if (ids.length === 0) {
      return [];
    }

    const { providers } = await import('../../db/schema');
    const { inArray } = await import('drizzle-orm');

    const results = await this.db.select().from(providers).where(inArray(providers.id, ids));

    return results as Provider[];
  }

  async updateProvider(id: string, data: UpdateProvider): Promise<Provider> {
    const { providers } = await import('../../db/schema');
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
    const { providers } = await import('../../db/schema');
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
    return this.dependencies.updateProvider(id, update);
  }
}
