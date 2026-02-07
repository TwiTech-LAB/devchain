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
import { createLogger } from '../../../common/logging/logger';
import { McpProviderRegistrationService } from '../../mcp/services/mcp-provider-registration.service';
import { PreflightService } from '../../core/services/preflight.service';
import { ProviderMcpEnsureService } from '../../core/services/provider-mcp-ensure.service';
import { ProviderAdapterFactory } from '../adapters';
import { disableClaudeAutoCompact } from '../../sessions/utils/claude-config';

const logger = createLogger('ProvidersController');
const execFileAsync = promisify(execFile);

const CreateProviderSchema = z.object({
  name: z.string().min(1).max(100),
  binPath: z.string().nullable().optional(),
  mcpConfigured: z.boolean().optional(),
  mcpEndpoint: z.string().nullable().optional(),
  mcpRegisteredAt: z.string().nullable().optional(),
});

const UpdateProviderSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  binPath: z.string().nullable().optional(),
  mcpConfigured: z.boolean().optional(),
  mcpEndpoint: z.string().nullable().optional(),
  mcpRegisteredAt: z.string().nullable().optional(),
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
  ) {}

  @Get()
  async listProviders() {
    logger.info('GET /api/providers');
    return this.storage.listProviders();
  }

  @Get(':id')
  async getProvider(@Param('id') id: string): Promise<Provider> {
    logger.info({ id }, 'GET /api/providers/:id');
    return this.storage.getProvider(id);
  }

  @Post()
  async createProvider(@Body() body: unknown): Promise<Provider> {
    logger.info('POST /api/providers');
    const parsed = CreateProviderSchema.parse(body);
    const normalizedPath = await this.normalizeBinPath(parsed.binPath ?? null);

    const payload: CreateProvider = {
      name: parsed.name.toLowerCase(),
      binPath: normalizedPath,
      mcpConfigured: false,
      mcpEndpoint: parsed.mcpEndpoint ?? null,
      mcpRegisteredAt: null,
    };

    // Do not auto-register on create; use Configure MCP action instead

    return this.storage.createProvider(payload);
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
