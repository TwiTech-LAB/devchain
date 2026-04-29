import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Inject,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { access, stat } from 'fs/promises';
import { constants } from 'fs';
import { isAbsolute, resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import {
  CreateProvider,
  UpdateProvider,
  Provider,
  UpdateProviderMcpMetadata,
} from '../../storage/models/domain.models';
import { z } from 'zod';
import { EnvVarsSchema } from '@devchain/shared';
import { createLogger } from '../../../common/logging/logger';
import { McpProviderRegistrationService } from '../../mcp/services/mcp-provider-registration.service';
import { PreflightService } from '../../core/services/preflight.service';
import { ProviderMcpEnsureService } from '../../core/services/provider-mcp-ensure.service';
import { ProviderAdapterFactory } from '../adapters';
import {
  disableClaudeAutoCompact,
  enableClaudeAutoCompact,
} from '../../sessions/utils/claude-config';
import { ProbeProofService } from '../services/probe-proof.service';
import {
  ProviderProjectSyncService,
  type SyncResult,
} from '../services/provider-project-sync.service';
import { ProviderDiscoveryService } from '../services/provider-discovery.service';
import { probe1mSupport } from '../utils/probe-1m';

const logger = createLogger('ProvidersController');
const execFileAsync = promisify(execFile);

const CreateProviderSchema = z.object({
  name: z.string().min(1).max(100),
  binPath: z.string().nullable().optional(),
  mcpConfigured: z.boolean().optional(),
  mcpEndpoint: z.string().nullable().optional(),
  mcpRegisteredAt: z.string().nullable().optional(),
  autoCompactThreshold: z.number().int().min(1).max(100).nullable().optional(),
  oneMillionContextEnabled: z.boolean().optional(),
  env: EnvVarsSchema.transform((v) => (v === undefined ? null : v)),
});

const UpdateProviderSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  binPath: z.string().nullable().optional(),
  mcpConfigured: z.boolean().optional(),
  mcpEndpoint: z.string().nullable().optional(),
  mcpRegisteredAt: z.string().nullable().optional(),
  autoCompactThreshold: z.number().int().min(1).max(100).nullable().optional(),
  autoCompactThreshold1m: z.number().int().min(1).max(100).nullable().optional(),
  oneMillionContextEnabled: z.boolean().optional(),
  env: EnvVarsSchema,
});

const ConfigureMcpSchema = z.object({
  endpoint: z.string().min(1).optional(),
  alias: z.string().min(1).max(100).optional(),
  extraArgs: z.array(z.string()).optional(),
  projectPath: z.string().min(1).optional(),
  addCommand: z.string().min(1).optional(),
});

const EnsureMcpSchema = z.object({
  projectPath: z.string().min(1).optional(),
});

@Controller('api/providers')
export class ProvidersController {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly mcpRegistration: McpProviderRegistrationService,
    private readonly preflight: PreflightService,
    private readonly adapterFactory: ProviderAdapterFactory,
    private readonly mcpEnsureService: ProviderMcpEnsureService,
    private readonly probeProofService: ProbeProofService,
    private readonly providerProjectSync: ProviderProjectSyncService,
    private readonly providerDiscovery: ProviderDiscoveryService,
  ) {}

  @Get()
  async listProviders() {
    logger.info('GET /api/providers');
    return this.storage.listProviders();
  }

  @Post('rescan')
  async rescanProviders() {
    logger.info('POST /api/providers/rescan');
    const discovery = await this.providerDiscovery.discoverInstalledBinaries();
    const syncResults: SyncResult[] = [];

    for (const binary of discovery.discovered) {
      const provider = await this.storage.createProvider({
        name: binary.name,
        binPath: binary.binPath,
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
      });

      try {
        const sync = await this.providerProjectSync.syncProviderToAllProjects(provider.id);
        syncResults.push(sync);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown sync error';
        logger.warn({ providerId: provider.id, error: message }, 'Sync failed during rescan');
      }
    }

    return {
      discovered: discovery.discovered,
      alreadyPresent: discovery.alreadyPresent,
      notFound: discovery.notFound,
      syncResults,
    };
  }

  @Get(':id')
  async getProvider(@Param('id') id: string): Promise<Provider> {
    logger.info({ id }, 'GET /api/providers/:id');
    return this.storage.getProvider(id);
  }

  @Post()
  async createProvider(
    @Body() body: unknown,
  ): Promise<{ provider: Provider; sync: SyncResult | null; syncError?: string }> {
    logger.info('POST /api/providers');
    const parsed = CreateProviderSchema.parse(body);
    const normalizedPath = await this.normalizeBinPath(parsed.binPath ?? null);

    if (parsed.oneMillionContextEnabled) {
      throw new BadRequestException({
        message: 'Cannot enable 1M context on create — save the provider first, then run the probe',
        field: 'oneMillionContextEnabled',
      });
    }

    const payload: CreateProvider = {
      name: parsed.name.toLowerCase(),
      binPath: normalizedPath,
      mcpConfigured: false,
      mcpEndpoint: parsed.mcpEndpoint ?? null,
      mcpRegisteredAt: null,
      autoCompactThreshold: parsed.autoCompactThreshold,
      oneMillionContextEnabled: parsed.oneMillionContextEnabled,
      env: parsed.env,
    };

    // Do not auto-register on create; use Configure MCP action instead

    const provider = await this.storage.createProvider(payload);

    try {
      const sync = await this.providerProjectSync.syncProviderToAllProjects(provider.id);
      return { provider, sync };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown sync error';
      logger.warn({ providerId: provider.id, error: message }, 'Provider sync failed after create');
      return { provider, sync: null, syncError: message };
    }
  }

  @Post(':id/sync-to-projects')
  async syncToProjects(@Param('id') id: string): Promise<SyncResult> {
    logger.info({ id }, 'POST /api/providers/:id/sync-to-projects');
    try {
      await this.storage.getProvider(id);
    } catch {
      throw new NotFoundException(`Provider ${id} not found`);
    }
    return this.providerProjectSync.syncProviderToAllProjects(id);
  }

  @Put(':id')
  async updateProvider(@Param('id') id: string, @Body() body: unknown): Promise<Provider> {
    logger.info({ id }, 'PUT /api/providers/:id');
    const parsed = UpdateProviderSchema.parse(body);
    const payload: UpdateProvider = {};

    if (parsed.name !== undefined) {
      payload.name = parsed.name.toLowerCase();
    }
    if (parsed.binPath !== undefined) {
      payload.binPath = await this.normalizeBinPath(parsed.binPath);

      // Auto-disable 1M when binPath changes on an already-enabled Claude provider
      // unless the new binPath has valid proof
      const existing = await this.storage.getProvider(id);
      if (
        existing.oneMillionContextEnabled &&
        existing.name.toLowerCase() === 'claude' &&
        payload.binPath !== existing.binPath &&
        (!payload.binPath || !this.probeProofService.hasValidProof(id, payload.binPath))
      ) {
        payload.oneMillionContextEnabled = false;
        payload.autoCompactThreshold = 95;
        payload.autoCompactThreshold1m = null;
        this.probeProofService.clearProof(id);
        logger.info({ id }, 'Auto-disabled 1M context: binPath changed without valid proof');
      }
    }
    if (parsed.mcpEndpoint !== undefined) {
      payload.mcpEndpoint = parsed.mcpEndpoint ?? null;
    }

    // Do not auto re-register on update; Configure MCP handles registration
    if (parsed.mcpConfigured !== undefined) {
      payload.mcpConfigured = parsed.mcpConfigured;
      if (!parsed.mcpConfigured) {
        payload.mcpRegisteredAt = null;
      }
    }

    if (parsed.mcpRegisteredAt !== undefined) {
      payload.mcpRegisteredAt = parsed.mcpRegisteredAt ?? null;
    }

    if (parsed.autoCompactThreshold !== undefined) {
      payload.autoCompactThreshold = parsed.autoCompactThreshold;
    }
    if (parsed.autoCompactThreshold1m !== undefined) {
      payload.autoCompactThreshold1m = parsed.autoCompactThreshold1m;
    }

    if (parsed.env !== undefined) {
      payload.env = parsed.env;
    }

    if (parsed.oneMillionContextEnabled !== undefined) {
      if (parsed.oneMillionContextEnabled) {
        // Determine the effective binPath: updated value or existing from storage
        const existing = await this.storage.getProvider(id);
        const effectiveBinPath = payload.binPath !== undefined ? payload.binPath : existing.binPath;

        if (!effectiveBinPath || !this.probeProofService.hasValidProof(id, effectiveBinPath)) {
          throw new BadRequestException({
            message:
              'Cannot enable 1M context without a confirmed support probe for the current binary',
            field: 'oneMillionContextEnabled',
          });
        }

        // Default 1M threshold to 50 when caller doesn't explicitly set one
        if (parsed.autoCompactThreshold1m === undefined) {
          payload.autoCompactThreshold1m = 50;
        }
        // Default standard threshold to 95 only if not already set by user
        if (parsed.autoCompactThreshold === undefined && existing.autoCompactThreshold == null) {
          payload.autoCompactThreshold = 95;
        }
      } else {
        // Disabling 1M: clear 1M threshold, default standard to 95 when not explicitly set
        payload.autoCompactThreshold1m = null;
        if (parsed.autoCompactThreshold === undefined) {
          payload.autoCompactThreshold = 95;
        }
      }
      payload.oneMillionContextEnabled = parsed.oneMillionContextEnabled;
    }

    const result = await this.storage.updateProvider(id, payload);

    // Clear preflight cache so UI gets fresh MCP status immediately
    this.preflight.clearCache();
    logger.debug('Cleared preflight cache after provider update');

    return result;
  }

  @Delete(':id')
  async deleteProvider(@Param('id') id: string): Promise<void> {
    logger.info({ id }, 'DELETE /api/providers/:id');

    // Check if any profile configs are using this provider
    const allConfigs = await this.storage.listAllProfileProviderConfigs();
    const configsUsingProvider = allConfigs.filter((c) => c.providerId === id);

    if (configsUsingProvider.length > 0) {
      // Get profile names for the error message
      const profileIds = [...new Set(configsUsingProvider.map((c) => c.profileId))];
      const profiles = await this.storage.listAgentProfiles();
      const profileNames = profiles.items
        .filter((p) => profileIds.includes(p.id))
        .map((p) => p.name)
        .join(', ');
      throw new BadRequestException({
        message: `Cannot delete provider: ${configsUsingProvider.length} config(s) are still using it`,
        details: `The following profiles have configs using this provider: ${profileNames}`,
        configCount: configsUsingProvider.length,
        profiles: profileNames,
      });
    }

    await this.storage.deleteProvider(id);

    // Clear preflight cache so UI updates immediately
    this.preflight.clearCache();
    logger.debug('Cleared preflight cache after provider deletion');
  }

  @Post(':id/mcp/ensure')
  async ensureMcp(@Param('id') id: string, @Body() body: unknown) {
    logger.info({ id }, 'POST /api/providers/:id/mcp/ensure');
    const parsed = EnsureMcpSchema.parse(body);
    const provider = await this.storage.getProvider(id);

    // Delegate to shared service
    const result = await this.mcpEnsureService.ensureMcp(provider, parsed.projectPath);

    if (!result.success) {
      throw new BadRequestException({
        message: result.message ?? 'MCP ensure failed',
        field: 'provider',
      });
    }

    return {
      success: result.success,
      action: result.action,
      endpoint: result.endpoint,
      alias: result.alias,
    };
  }

  @Post(':id/auto-compact/disable')
  async disableAutoCompact(@Param('id') id: string) {
    logger.info({ id }, 'POST /api/providers/:id/auto-compact/disable');
    const provider = await this.storage.getProvider(id);

    if (provider.name.toLowerCase() !== 'claude') {
      throw new BadRequestException(
        'Auto-compact configuration is only applicable to Claude provider',
      );
    }

    const result = await disableClaudeAutoCompact();
    if (!result.success) {
      if (result.errorType === 'invalid_config') {
        throw new BadRequestException(
          '~/.claude.json contains invalid JSON. Please fix the file manually.',
        );
      }

      throw new InternalServerErrorException('Failed to write ~/.claude.json');
    }

    return { success: true };
  }

  @Post(':id/auto-compact/enable')
  async enableAutoCompact(@Param('id') id: string) {
    logger.info({ id }, 'POST /api/providers/:id/auto-compact/enable');
    const provider = await this.storage.getProvider(id);

    if (provider.name.toLowerCase() !== 'claude') {
      throw new BadRequestException(
        'Auto-compact configuration is only applicable to Claude provider',
      );
    }

    const result = await enableClaudeAutoCompact();
    if (!result.success) {
      if (result.errorType === 'invalid_config') {
        throw new BadRequestException(
          '~/.claude.json contains invalid JSON. Please fix the file manually.',
        );
      }

      throw new InternalServerErrorException('Failed to write ~/.claude.json');
    }

    return { success: true };
  }

  @Post(':id/1m-context/probe')
  async probe1mContext(@Param('id') id: string) {
    logger.info({ id }, 'POST /api/providers/:id/1m-context/probe');
    const provider = await this.storage.getProvider(id);

    if (provider.name.toLowerCase() !== 'claude') {
      throw new BadRequestException('1M context probe is only available for Claude providers');
    }

    if (!provider.binPath) {
      throw new BadRequestException({
        message: 'Claude binary path is required for 1M context probe',
        field: 'binPath',
      });
    }

    const outcome = await probe1mSupport(provider.binPath, 30_000);
    if (outcome.supported) {
      this.probeProofService.recordProof(id, provider.binPath);
    }
    return outcome;
  }

  @Post(':id/mcp')
  async configureMcp(@Param('id') id: string, @Body() body: unknown) {
    logger.info({ id }, 'POST /api/providers/:id/mcp');
    const parsed = ConfigureMcpSchema.parse(body);
    const provider = await this.storage.getProvider(id);
    const endpoint = parsed.endpoint ?? provider.mcpEndpoint ?? null;

    if (!endpoint) {
      throw new BadRequestException({
        message: 'Endpoint is required for MCP configuration',
        field: 'endpoint',
      });
    }

    // Use adapters for registration
    if (!this.adapterFactory.isSupported(provider.name)) {
      throw new BadRequestException({
        message: `MCP configuration not supported for provider: ${provider.name}`,
        field: 'provider',
      });
    }

    const alias = parsed.alias ?? 'devchain';
    const result = await this.mcpRegistration.registerProvider(
      provider,
      {
        endpoint,
        alias,
        extraArgs: parsed.extraArgs,
      },
      {
        cwd: parsed.projectPath,
        timeoutMs: 10_000,
      },
    );

    if (!result.success) {
      throw new BadRequestException({
        message: result.message,
        field: 'mcpEndpoint',
        details: (result.stderr || result.stdout || '').trim(),
      });
    }

    const metadata: UpdateProviderMcpMetadata = {
      mcpConfigured: true,
      mcpEndpoint: endpoint,
      mcpRegisteredAt: new Date().toISOString(),
    };
    await this.storage.updateProviderMcpMetadata(id, metadata);

    // Clear preflight cache so UI gets fresh MCP status immediately
    this.preflight.clearCache();
    logger.debug('Cleared preflight cache after MCP configuration');

    return {
      success: true,
      message: result.message,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  private async normalizeBinPath(binPath: string | null | undefined): Promise<string | null> {
    if (binPath === undefined || binPath === null) {
      return null;
    }

    const trimmed = binPath.trim();
    if (!trimmed) {
      return null;
    }

    if (!isAbsolute(trimmed)) {
      // Accept command names; validate they exist on PATH but store the original
      try {
        const { stdout } = await execFileAsync('which', [trimmed]);
        const discovered = stdout.trim();
        if (!discovered) {
          throw new BadRequestException({
            message: `Command '${trimmed}' not found on PATH. Provide an absolute path or install the binary.`,
            field: 'binPath',
          });
        }
        // Store the original command for portability across systems
        return trimmed;
      } catch (error) {
        throw new BadRequestException({
          message: `Command '${trimmed}' not found on PATH. Provide an absolute path or install the binary.`,
          field: 'binPath',
        });
      }
    }

    const resolved = resolve(trimmed);

    try {
      const stats = await stat(resolved);
      if (!stats.isFile()) {
        throw new BadRequestException({
          message: 'Provider binary path must point to an executable file.',
          field: 'binPath',
        });
      }

      await access(resolved, constants.X_OK);
      return resolved;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      const err = error as NodeJS.ErrnoException;
      let message = 'Provider binary path does not exist or is not executable.';
      if (err?.code === 'ENOENT') {
        message = 'Provider binary path does not exist.';
      } else if (err?.code === 'EACCES' || err?.code === 'EPERM') {
        message = 'Provider binary path is not executable.';
      }

      throw new BadRequestException({
        message,
        field: 'binPath',
      });
    }
  }

  private shouldAttemptMcpRegistration(name: string, endpoint: string | null | undefined) {
    return this.adapterFactory.isSupported(name) && !!endpoint;
  }

  private composePreviewProvider(
    existing: Provider,
    update: UpdateProvider = {},
    parsed: z.infer<typeof UpdateProviderSchema> = {},
  ): Provider {
    return {
      ...existing,
      name: update.name ?? existing.name,
      binPath: update.binPath !== undefined ? update.binPath : existing.binPath,
      mcpConfigured:
        parsed.mcpConfigured !== undefined ? parsed.mcpConfigured : existing.mcpConfigured,
      mcpEndpoint: update.mcpEndpoint !== undefined ? update.mcpEndpoint : existing.mcpEndpoint,
      mcpRegisteredAt:
        parsed.mcpRegisteredAt !== undefined ? parsed.mcpRegisteredAt : existing.mcpRegisteredAt,
    };
  }

  private async ensureMcpRegistrationSuccess(
    provider: Provider,
    options: { endpoint: string; alias?: string; extraArgs?: string[] },
    execOptions?: { cwd?: string },
  ) {
    const result = await this.mcpRegistration.registerProvider(provider, options, execOptions);
    if (!result.success) {
      throw new BadRequestException({
        message: result.message,
        field: 'mcpEndpoint',
        details: (result.stderr || result.stdout || '').trim(),
      });
    }
    return result;
  }
}
