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
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { Provider, UpdateProviderMcpMetadata } from '../../storage/models/domain.models';
import { z } from 'zod';
import { EnvVarsSchema } from '@devchain/shared';
import { createLogger } from '../../../common/logging/logger';
import { McpProviderRegistrationService } from '../services/mcp-provider-registration.service';
import { ProviderMcpEnsureService } from '../services/provider-mcp-ensure.service';
import { ProviderAdapterFactory } from '../adapters';
import {
  ProviderStateManager,
  type UpdateProviderRequest,
  type CreateProviderInput,
} from '../services/provider-state-manager.service';
import {
  ProviderProjectSyncService,
  type SyncResult,
} from '../services/provider-project-sync.service';
import { ProviderDiscoveryService } from '../services/provider-discovery.service';

const logger = createLogger('ProvidersController');

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
    private readonly adapterFactory: ProviderAdapterFactory,
    private readonly mcpEnsureService: ProviderMcpEnsureService,
    private readonly providerStateManager: ProviderStateManager,
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
    const parsed = CreateProviderSchema.parse(body) as CreateProviderInput;
    return this.providerStateManager.create(parsed);
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

    const request: UpdateProviderRequest = {
      ...parsed,
      binPath:
        parsed.binPath !== undefined
          ? await this.providerStateManager.normalizeBinPath(parsed.binPath)
          : undefined,
    };

    const { provider } = await this.providerStateManager.update(id, request);

    return provider;
  }

  @Delete(':id')
  async deleteProvider(@Param('id') id: string): Promise<void> {
    logger.info({ id }, 'DELETE /api/providers/:id');
    await this.providerStateManager.deleteProvider(id);
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
      warnings: result.warnings,
    };
  }

  @Post(':id/auto-compact/disable')
  async disableAutoCompact(@Param('id') id: string) {
    logger.info({ id }, 'POST /api/providers/:id/auto-compact/disable');
    const result = await this.providerStateManager.disableAutoCompact(id);
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
    const result = await this.providerStateManager.enableAutoCompact(id);
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
    return this.providerStateManager.probe1m(id);
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

    return {
      success: true,
      message: result.message,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}
