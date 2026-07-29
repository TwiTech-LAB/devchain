import type { ListOptions, ListResult } from '../../interfaces/storage.interface';
import type {
  CreateProvider,
  EnvScopesMap,
  Provider,
  ProviderMcpMetadata,
  UpdateProvider,
  UpdateProviderMcpMetadata,
} from '../../models/domain.models';
import { eq } from 'drizzle-orm';
import {
  DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON,
  validateClaudeLaunchSettingsJson,
} from '@devchain/shared';
import { NotFoundError, ValidationError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { providers as providersTable } from '../../db/schema';
import { normalizeEnvForStorage, parseProviderEnv } from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('ProviderStorageDelegate');

interface RawProviderRow {
  id: string;
  name: string;
  bin_path: string | null;
  mcp_configured: number;
  mcp_endpoint: string | null;
  mcp_registered_at: string | null;
  auto_compact_threshold: number | null;
  claude_launch_settings_json: string | null;
  env: string | null;
  created_at: string;
  updated_at: string;
}

function assertClaudeLaunchSettings(providerName: string, value: string | null): void {
  if (providerName.toLowerCase() !== 'claude' && value !== null) {
    throw new ValidationError('Claude launch settings are only supported by the Claude provider.', {
      field: 'claudeLaunchSettingsJson',
    });
  }

  const validation = validateClaudeLaunchSettingsJson(value);
  if (!validation.valid) {
    throw new ValidationError(validation.message, {
      field: 'claudeLaunchSettingsJson',
      ...(validation.path ? { path: validation.path } : {}),
    });
  }
}

function mapRawProviderRow(row: RawProviderRow): Provider {
  return {
    id: row.id,
    name: row.name,
    binPath: row.bin_path,
    mcpConfigured: row.mcp_configured !== 0,
    mcpEndpoint: row.mcp_endpoint,
    mcpRegisteredAt: row.mcp_registered_at,
    autoCompactThreshold: row.auto_compact_threshold,
    claudeLaunchSettingsJson: row.claude_launch_settings_json,
    env: parseProviderEnv(row.env, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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

    const env: Record<string, string> | null =
      data.env && Object.keys(data.env).length > 0 ? data.env : null;
    const isClaude = data.name.toLowerCase() === 'claude';
    const claudeLaunchSettingsJson = isClaude
      ? data.claudeLaunchSettingsJson === undefined
        ? DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON
        : data.claudeLaunchSettingsJson
      : (data.claudeLaunchSettingsJson ?? null);

    assertClaudeLaunchSettings(data.name, claudeLaunchSettingsJson);

    const provider: Provider = {
      id: randomUUID(),
      name: data.name,
      binPath: data.binPath ?? null,
      mcpConfigured: data.mcpConfigured ?? false,
      mcpEndpoint: data.mcpEndpoint ?? null,
      mcpRegisteredAt: data.mcpRegisteredAt ?? null,
      autoCompactThreshold,
      claudeLaunchSettingsJson,
      env,
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
      claudeLaunchSettingsJson: provider.claudeLaunchSettingsJson,
      env: normalizeEnvForStorage(provider.env),
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
    const row = result[0];
    return { ...row, env: parseProviderEnv(row.env, row.id) } as Provider;
  }

  async listProviders(options: ListOptions = {}): Promise<ListResult<Provider>> {
    const { providers } = await import('../../db/schema');
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const rows = await this.db.select().from(providers).limit(limit).offset(offset);
    const items = rows.map((row) => ({
      ...row,
      env: parseProviderEnv(row.env, row.id),
    })) as Provider[];

    return {
      items,
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

    const rows = await this.db.select().from(providers).where(inArray(providers.id, ids));

    return rows.map((row) => ({ ...row, env: parseProviderEnv(row.env, row.id) })) as Provider[];
  }

  async updateProvider(id: string, data: UpdateProvider): Promise<Provider> {
    const { providers } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();
    const existing = await this.getProvider(id);
    const resultingName = data.name ?? existing.name;
    const resultingClaudeLaunchSettingsJson =
      data.claudeLaunchSettingsJson !== undefined
        ? data.claudeLaunchSettingsJson
        : existing.claudeLaunchSettingsJson;
    assertClaudeLaunchSettings(resultingName, resultingClaudeLaunchSettingsJson);

    const updateData: Record<string, unknown> = { updatedAt: now };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.binPath !== undefined) updateData.binPath = data.binPath;
    if (data.mcpConfigured !== undefined) updateData.mcpConfigured = data.mcpConfigured;
    if (data.mcpEndpoint !== undefined) updateData.mcpEndpoint = data.mcpEndpoint;
    if (data.mcpRegisteredAt !== undefined) updateData.mcpRegisteredAt = data.mcpRegisteredAt;
    if (data.autoCompactThreshold !== undefined)
      updateData.autoCompactThreshold = data.autoCompactThreshold;
    if (data.claudeLaunchSettingsJson !== undefined)
      updateData.claudeLaunchSettingsJson = data.claudeLaunchSettingsJson;
    if (data.env !== undefined) updateData.env = normalizeEnvForStorage(data.env);

    await this.db.update(providers).set(updateData).where(eq(providers.id, id));

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

  listEnvScopesByProviderIds(providerIds: string[]): Map<string, EnvScopesMap> {
    const result = new Map<string, EnvScopesMap>();
    if (providerIds.length === 0) return result;

    const placeholders = providerIds.map(() => '?').join(', ');
    const rows = this.rawClient
      .prepare(
        `SELECT provider_id, env_key, project_id FROM provider_env_scopes WHERE provider_id IN (${placeholders})`,
      )
      .all(...providerIds) as Array<{ provider_id: string; env_key: string; project_id: string }>;

    for (const row of rows) {
      let providerScopes = result.get(row.provider_id);
      if (!providerScopes) {
        providerScopes = {};
        result.set(row.provider_id, providerScopes);
      }
      if (!providerScopes[row.env_key]) {
        providerScopes[row.env_key] = [];
      }
      providerScopes[row.env_key].push(row.project_id);
    }
    return result;
  }

  listEnvScopes(providerId: string): EnvScopesMap {
    const rows = this.rawClient
      .prepare('SELECT env_key, project_id FROM provider_env_scopes WHERE provider_id = ?')
      .all(providerId) as Array<{ env_key: string; project_id: string }>;

    const result: EnvScopesMap = {};
    for (const row of rows) {
      if (!result[row.env_key]) {
        result[row.env_key] = [];
      }
      result[row.env_key].push(row.project_id);
    }
    return result;
  }

  getProviderEnvForProject(providerId: string, projectId: string): Record<string, string> | null {
    const providerRow = this.rawClient
      .prepare('SELECT env FROM providers WHERE id = ?')
      .get(providerId) as { env: string | null } | undefined;

    if (!providerRow) {
      throw new NotFoundError('Provider', providerId);
    }

    const allEnv = parseProviderEnv(providerRow.env, providerId);
    if (!allEnv || Object.keys(allEnv).length === 0) {
      return null;
    }

    const scopeRows = this.rawClient
      .prepare('SELECT env_key, project_id FROM provider_env_scopes WHERE provider_id = ?')
      .all(providerId) as Array<{ env_key: string; project_id: string }>;

    const scopeMap: Record<string, Set<string>> = {};
    for (const row of scopeRows) {
      if (!scopeMap[row.env_key]) {
        scopeMap[row.env_key] = new Set();
      }
      scopeMap[row.env_key].add(row.project_id);
    }

    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(allEnv)) {
      const scopes = scopeMap[key];
      if (!scopes || scopes.has(projectId)) {
        filtered[key] = value;
      }
    }

    return Object.keys(filtered).length > 0 ? filtered : null;
  }

  updateProviderWithScopes(
    id: string,
    data: UpdateProvider,
    envScopes: EnvScopesMap | undefined,
    currentEnvKeys: string[],
  ): Provider {
    return this.txRunner.runImmediate(() => {
      const now = new Date().toISOString();
      const existing = this.rawClient
        .prepare('SELECT name, claude_launch_settings_json FROM providers WHERE id = ?')
        .get(id) as { name: string; claude_launch_settings_json: string | null } | undefined;

      if (!existing) {
        throw new NotFoundError('Provider', id);
      }

      const resultingName = data.name ?? existing.name;
      const resultingClaudeLaunchSettingsJson =
        data.claudeLaunchSettingsJson !== undefined
          ? data.claudeLaunchSettingsJson
          : existing.claude_launch_settings_json;
      assertClaudeLaunchSettings(resultingName, resultingClaudeLaunchSettingsJson);

      const updateData: Record<string, unknown> = { updatedAt: now };
      if (data.name !== undefined) updateData.name = data.name;
      if (data.binPath !== undefined) updateData.binPath = data.binPath;
      if (data.mcpConfigured !== undefined) updateData.mcpConfigured = data.mcpConfigured;
      if (data.mcpEndpoint !== undefined) updateData.mcpEndpoint = data.mcpEndpoint;
      if (data.mcpRegisteredAt !== undefined) updateData.mcpRegisteredAt = data.mcpRegisteredAt;
      if (data.autoCompactThreshold !== undefined)
        updateData.autoCompactThreshold = data.autoCompactThreshold;
      if (data.claudeLaunchSettingsJson !== undefined)
        updateData.claudeLaunchSettingsJson = data.claudeLaunchSettingsJson;
      if (data.env !== undefined) updateData.env = normalizeEnvForStorage(data.env);

      this.db.update(providersTable).set(updateData).where(eq(providersTable.id, id)).run();

      if (envScopes !== undefined) {
        this.rawClient.prepare('DELETE FROM provider_env_scopes WHERE provider_id = ?').run(id);

        const insert = this.rawClient.prepare(
          'INSERT INTO provider_env_scopes (provider_id, env_key, project_id, created_at) VALUES (?, ?, ?, ?)',
        );
        for (const [envKey, projectIds] of Object.entries(envScopes)) {
          if (!currentEnvKeys.includes(envKey)) continue;
          for (const projectId of projectIds) {
            insert.run(id, envKey, projectId, now);
          }
        }
      } else {
        if (currentEnvKeys.length > 0) {
          const placeholders = currentEnvKeys.map(() => '?').join(', ');
          this.rawClient
            .prepare(
              `DELETE FROM provider_env_scopes WHERE provider_id = ? AND env_key NOT IN (${placeholders})`,
            )
            .run(id, ...currentEnvKeys);
        } else {
          this.rawClient.prepare('DELETE FROM provider_env_scopes WHERE provider_id = ?').run(id);
        }
      }

      const row = this.rawClient.prepare('SELECT * FROM providers WHERE id = ?').get(id) as
        | RawProviderRow
        | undefined;

      if (!row) {
        throw new NotFoundError('Provider', id);
      }

      logger.info({ providerId: id }, 'Updated provider with scopes');
      return mapRawProviderRow(row);
    });
  }
}
