import { Injectable, Inject } from '@nestjs/common';
import { access, stat } from 'fs/promises';
import { constants } from 'fs';
import { isAbsolute, resolve } from 'path';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { EnvScopesMap, Provider, UpdateProvider } from '../../storage/models/domain.models';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { ProviderProjectSyncService, type SyncResult } from './provider-project-sync.service';
import { ProviderEffortSeedingService } from './provider-effort-seeding.service';
import {
  disableClaudeAutoCompact,
  enableClaudeAutoCompact,
} from '../../sessions/utils/claude-config';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { createLogger } from '../../../common/logging/logger';
import { validateClaudeLaunchSettingsJson } from '@devchain/shared';

const logger = createLogger('ProviderStateManager');

export type CreateProviderInput = {
  name: string;
  binPath?: string | null;
  mcpEndpoint?: string | null;
  mcpRegisteredAt?: string | null;
  autoCompactThreshold?: number | null;
  claudeLaunchSettingsJson?: string | null;
  env: Record<string, string> | null;
};

export type AutoCompactResult = { success: boolean; error?: string; errorType?: string };

export type UpdateProviderRequest = {
  name?: string;
  binPath?: string | null;
  mcpConfigured?: boolean;
  mcpEndpoint?: string | null;
  mcpRegisteredAt?: string | null;
  autoCompactThreshold?: number | null;
  claudeLaunchSettingsJson?: string | null;
  env?: Record<string, string> | null;
  envScopes?: EnvScopesMap;
};

@Injectable()
export class ProviderStateManager {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly providerProjectSync: ProviderProjectSyncService,
    private readonly executor: ProcessExecutor,
    private readonly effortSeeding: ProviderEffortSeedingService,
  ) {}

  async update(
    providerId: string,
    partial: UpdateProviderRequest,
  ): Promise<{ provider: Provider }> {
    const existing = await this.storage.getProvider(providerId);
    const payload: UpdateProvider = {};

    if (partial.name !== undefined) {
      payload.name = partial.name.toLowerCase();
    }

    if (partial.binPath !== undefined) {
      payload.binPath = partial.binPath;
    }

    if (partial.mcpEndpoint !== undefined) {
      payload.mcpEndpoint = partial.mcpEndpoint ?? null;
    }

    if (partial.mcpConfigured !== undefined) {
      payload.mcpConfigured = partial.mcpConfigured;
      if (!partial.mcpConfigured) {
        payload.mcpRegisteredAt = null;
      }
    }

    if (partial.mcpRegisteredAt !== undefined) {
      payload.mcpRegisteredAt = partial.mcpRegisteredAt ?? null;
    }

    if (partial.autoCompactThreshold !== undefined) {
      payload.autoCompactThreshold = partial.autoCompactThreshold;
    }

    const resultingName = payload.name ?? existing.name;
    const resultingClaudeLaunchSettingsJson =
      partial.claudeLaunchSettingsJson !== undefined
        ? partial.claudeLaunchSettingsJson
        : (existing.claudeLaunchSettingsJson ?? null);
    this.assertClaudeLaunchSettings(resultingName, resultingClaudeLaunchSettingsJson);
    if (partial.claudeLaunchSettingsJson !== undefined) {
      payload.claudeLaunchSettingsJson = partial.claudeLaunchSettingsJson;
    }

    if (partial.env !== undefined) {
      payload.env = partial.env;
    }

    const { envScopes } = partial;

    const postUpdateEnv = payload.env !== undefined ? (payload.env ?? {}) : (existing.env ?? {});
    const postUpdateEnvKeys = Object.keys(postUpdateEnv);

    if (envScopes !== undefined) {
      for (const key of Object.keys(envScopes)) {
        if (!postUpdateEnvKeys.includes(key)) {
          throw new ValidationError('Unknown env key', { field: `envScopes.${key}` });
        }
      }

      const referencedProjectIds = new Set<string>();
      for (const projectIds of Object.values(envScopes)) {
        for (const pid of projectIds) referencedProjectIds.add(pid);
      }
      const existenceEntries = await Promise.all(
        Array.from(referencedProjectIds).map(async (pid) => {
          try {
            await this.storage.getProject(pid);
            return [pid, true] as const;
          } catch (err) {
            if (err instanceof NotFoundError) return [pid, false] as const;
            throw err;
          }
        }),
      );
      const validProjectIds = new Set(
        existenceEntries.filter(([, exists]) => exists).map(([pid]) => pid),
      );
      for (const [envKey, projectIds] of Object.entries(envScopes)) {
        const seen = new Set<string>();
        for (let i = 0; i < projectIds.length; i++) {
          const pid = projectIds[i];
          if (seen.has(pid)) {
            throw new ValidationError('Duplicate project ID', {
              field: `envScopes.${envKey}[${i}]`,
            });
          }
          seen.add(pid);
          if (!validProjectIds.has(pid)) {
            throw new ValidationError('Unknown project', { field: `envScopes.${envKey}[${i}]` });
          }
        }
      }
    }

    const provider = await this.storage.updateProviderWithScopes(
      providerId,
      payload,
      envScopes,
      postUpdateEnvKeys,
    );
    return { provider };
  }

  async create(
    input: CreateProviderInput,
  ): Promise<{ provider: Provider; sync: SyncResult | null; syncError?: string }> {
    if (input.claudeLaunchSettingsJson !== undefined) {
      this.assertClaudeLaunchSettings(input.name, input.claudeLaunchSettingsJson);
    } else if (input.name.toLowerCase() !== 'claude') {
      this.assertClaudeLaunchSettings(input.name, null);
    }

    const binPath = await this.normalizeBinPath(input.binPath ?? null);
    const provider = await this.storage.createProvider({
      name: input.name.toLowerCase(),
      binPath,
      mcpConfigured: false,
      mcpEndpoint: input.mcpEndpoint ?? null,
      mcpRegisteredAt: null,
      autoCompactThreshold: input.autoCompactThreshold,
      claudeLaunchSettingsJson: input.claudeLaunchSettingsJson,
      env: input.env,
    });

    // Seed the effort catalog from adapter defaults (idempotent, additive-only).
    // Non-fatal: a seeding hiccup must never fail provider creation, and the
    // startup backfill seeder is a safety net.
    await this.seedEffortDefaults(provider);

    try {
      const sync = await this.providerProjectSync.syncProviderToAllProjects(provider.id);
      return { provider, sync };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown sync error';
      logger.warn({ providerId: provider.id, error: message }, 'Provider sync failed after create');
      return { provider, sync: null, syncError: message };
    }
  }

  /**
   * Seed a newly created provider's effort catalog from adapter defaults.
   * Non-fatal — logs and swallows so provider creation always succeeds; the
   * one-time startup backfill seeder re-covers anything missed.
   */
  private async seedEffortDefaults(provider: Provider): Promise<void> {
    try {
      await this.effortSeeding.seedForProvider(provider);
    } catch (error) {
      logger.warn(
        { providerId: provider.id, providerName: provider.name, error },
        'Failed to seed provider effort defaults on create (non-fatal)',
      );
    }
  }

  private assertClaudeLaunchSettings(providerName: string, value: string | null): void {
    if (providerName.toLowerCase() !== 'claude' && value !== null) {
      throw new ValidationError(
        'Claude launch settings are only supported by the Claude provider.',
        { field: 'claudeLaunchSettingsJson' },
      );
    }

    const validation = validateClaudeLaunchSettingsJson(value);
    if (!validation.valid) {
      throw new ValidationError(validation.message, {
        field: 'claudeLaunchSettingsJson',
        ...(validation.path ? { path: validation.path } : {}),
      });
    }
  }

  async deleteProvider(id: string): Promise<void> {
    const allConfigs = await this.storage.listAllProfileProviderConfigs();
    const configsUsingProvider = allConfigs.filter((c) => c.providerId === id);

    if (configsUsingProvider.length > 0) {
      const profileIds = [...new Set(configsUsingProvider.map((c) => c.profileId))];
      const profiles = await this.storage.listAgentProfiles();
      const profileNames = profiles.items
        .filter((p) => profileIds.includes(p.id))
        .map((p) => p.name)
        .join(', ');
      throw new ValidationError(
        `Cannot delete provider: ${configsUsingProvider.length} config(s) are still using it`,
        {
          configCount: configsUsingProvider.length,
          profiles: profileNames,
        },
      );
    }

    await this.storage.deleteProvider(id);
  }

  async disableAutoCompact(id: string): Promise<AutoCompactResult> {
    const provider = await this.storage.getProvider(id);
    if (provider.name.toLowerCase() !== 'claude') {
      throw new ValidationError('Auto-compact configuration is only applicable to Claude provider');
    }
    return disableClaudeAutoCompact();
  }

  async enableAutoCompact(id: string): Promise<AutoCompactResult> {
    const provider = await this.storage.getProvider(id);
    if (provider.name.toLowerCase() !== 'claude') {
      throw new ValidationError('Auto-compact configuration is only applicable to Claude provider');
    }
    return enableClaudeAutoCompact();
  }

  async normalizeBinPath(binPath: string | null | undefined): Promise<string | null> {
    if (binPath === undefined || binPath === null) {
      return null;
    }

    const trimmed = binPath.trim();
    if (!trimmed) {
      return null;
    }

    if (!isAbsolute(trimmed)) {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const result = await this.executor.run({ argv: [whichCmd, trimmed], mode: 'pipe' });
      const discovered = result.stdout.trim();
      if (!result.success || !discovered) {
        throw new ValidationError(
          `Command '${trimmed}' not found on PATH. Provide an absolute path or install the binary.`,
          { field: 'binPath' },
        );
      }
      return trimmed;
    }

    const resolved = resolve(trimmed);

    try {
      const stats = await stat(resolved);
      if (!stats.isFile()) {
        throw new ValidationError('Provider binary path must point to an executable file.', {
          field: 'binPath',
        });
      }

      await access(resolved, constants.X_OK);
      return resolved;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }

      const err = error as NodeJS.ErrnoException;
      let message = 'Provider binary path does not exist or is not executable.';
      if (err?.code === 'ENOENT') {
        message = 'Provider binary path does not exist.';
      } else if (err?.code === 'EACCES' || err?.code === 'EPERM') {
        message = 'Provider binary path is not executable.';
      }

      throw new ValidationError(message, { field: 'binPath' });
    }
  }
}
