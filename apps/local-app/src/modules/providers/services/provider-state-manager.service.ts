import { Injectable, Inject } from '@nestjs/common';
import { access, stat } from 'fs/promises';
import { constants } from 'fs';
import { isAbsolute, resolve } from 'path';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { Provider, UpdateProvider } from '../../storage/models/domain.models';
import { ValidationError } from '../../../common/errors/error-types';
import { ProbeProofService } from './probe-proof.service';
import { ProviderProjectSyncService, type SyncResult } from './provider-project-sync.service';
import { probe1mSupport, ProbeOutcome } from '../utils/probe-1m';
import {
  disableClaudeAutoCompact,
  enableClaudeAutoCompact,
} from '../../sessions/utils/claude-config';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('ProviderStateManager');

export type CreateProviderInput = {
  name: string;
  binPath?: string | null;
  mcpEndpoint?: string | null;
  mcpRegisteredAt?: string | null;
  autoCompactThreshold?: number | null;
  oneMillionContextEnabled?: boolean;
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
  autoCompactThreshold1m?: number | null;
  oneMillionContextEnabled?: boolean;
  env?: Record<string, string> | null;
};

const THRESHOLD_1M_DEFAULT = 50;
const THRESHOLD_STANDARD_DEFAULT = 95;

@Injectable()
export class ProviderStateManager {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly probeProofService: ProbeProofService,
    private readonly providerProjectSync: ProviderProjectSyncService,
    private readonly executor: ProcessExecutor,
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
      if (
        existing.oneMillionContextEnabled &&
        existing.name.toLowerCase() === 'claude' &&
        payload.binPath !== existing.binPath &&
        (!payload.binPath || !this.probeProofService.hasValidProof(providerId, payload.binPath))
      ) {
        payload.oneMillionContextEnabled = false;
        payload.autoCompactThreshold = THRESHOLD_STANDARD_DEFAULT;
        payload.autoCompactThreshold1m = null;
        this.probeProofService.clearProof(providerId);
        logger.info(
          { providerId },
          'Auto-disabled 1M context: binPath changed without valid proof',
        );
      }
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

    if (partial.autoCompactThreshold1m !== undefined) {
      payload.autoCompactThreshold1m = partial.autoCompactThreshold1m;
    }

    if (partial.env !== undefined) {
      payload.env = partial.env;
    }

    if (partial.oneMillionContextEnabled !== undefined) {
      if (partial.oneMillionContextEnabled) {
        const effectiveBinPath = payload.binPath !== undefined ? payload.binPath : existing.binPath;

        if (
          !effectiveBinPath ||
          !this.probeProofService.hasValidProof(providerId, effectiveBinPath)
        ) {
          throw new ValidationError(
            'Cannot enable 1M context without a confirmed support probe for the current binary',
            { field: 'oneMillionContextEnabled' },
          );
        }

        if (partial.autoCompactThreshold1m === undefined) {
          payload.autoCompactThreshold1m = THRESHOLD_1M_DEFAULT;
        }
        if (partial.autoCompactThreshold === undefined && existing.autoCompactThreshold == null) {
          payload.autoCompactThreshold = THRESHOLD_STANDARD_DEFAULT;
        }
      } else {
        payload.autoCompactThreshold1m = null;
        if (partial.autoCompactThreshold === undefined) {
          payload.autoCompactThreshold = THRESHOLD_STANDARD_DEFAULT;
        }
      }
      payload.oneMillionContextEnabled = partial.oneMillionContextEnabled;
    }

    const provider = await this.storage.updateProvider(providerId, payload);
    return { provider };
  }

  async enableOneMillion(providerId: string): Promise<Provider> {
    const existing = await this.storage.getProvider(providerId);

    if (!existing.binPath || !this.probeProofService.hasValidProof(providerId, existing.binPath)) {
      throw new ValidationError(
        'Cannot enable 1M context without a confirmed support probe for the current binary',
        { field: 'oneMillionContextEnabled' },
      );
    }

    const payload: UpdateProvider = {
      oneMillionContextEnabled: true,
      autoCompactThreshold1m: THRESHOLD_1M_DEFAULT,
    };

    if (existing.autoCompactThreshold == null) {
      payload.autoCompactThreshold = THRESHOLD_STANDARD_DEFAULT;
    }

    return this.storage.updateProvider(providerId, payload);
  }

  async disableOneMillion(providerId: string): Promise<Provider> {
    const payload: UpdateProvider = {
      oneMillionContextEnabled: false,
      autoCompactThreshold1m: null,
      autoCompactThreshold: THRESHOLD_STANDARD_DEFAULT,
    };
    return this.storage.updateProvider(providerId, payload);
  }

  async create(
    input: CreateProviderInput,
  ): Promise<{ provider: Provider; sync: SyncResult | null; syncError?: string }> {
    if (input.oneMillionContextEnabled) {
      throw new ValidationError(
        'Cannot enable 1M context on create — save the provider first, then run the probe',
        { field: 'oneMillionContextEnabled' },
      );
    }

    const binPath = await this.normalizeBinPath(input.binPath ?? null);
    const provider = await this.storage.createProvider({
      name: input.name.toLowerCase(),
      binPath,
      mcpConfigured: false,
      mcpEndpoint: input.mcpEndpoint ?? null,
      mcpRegisteredAt: null,
      autoCompactThreshold: input.autoCompactThreshold,
      oneMillionContextEnabled: input.oneMillionContextEnabled,
      env: input.env,
    });

    try {
      const sync = await this.providerProjectSync.syncProviderToAllProjects(provider.id);
      return { provider, sync };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown sync error';
      logger.warn({ providerId: provider.id, error: message }, 'Provider sync failed after create');
      return { provider, sync: null, syncError: message };
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

  async probe1m(providerId: string): Promise<ProbeOutcome> {
    const provider = await this.storage.getProvider(providerId);

    if (provider.name.toLowerCase() !== 'claude') {
      throw new ValidationError('1M context probe is only available for Claude providers');
    }

    if (!provider.binPath) {
      throw new ValidationError('Claude binary path is required for 1M context probe', {
        field: 'binPath',
      });
    }

    const outcome = await probe1mSupport(this.executor, provider.binPath, 30_000);
    if (outcome.supported) {
      this.probeProofService.recordProof(providerId, provider.binPath);
    }
    return outcome;
  }
}
