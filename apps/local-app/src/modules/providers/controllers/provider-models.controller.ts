import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Body,
} from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { z } from 'zod';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { McpProviderRegistrationService } from '../../mcp/services/mcp-provider-registration.service';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('ProviderModelsController');
const execFileAsync = promisify(execFile);

const ProviderModelCreateSchema = z
  .object({
    name: z.string().min(1, 'name is required'),
  })
  .strict();

const ProviderModelBulkCreateSchema = z
  .object({
    models: z
      .array(
        z
          .object({
            name: z.string().min(1, 'name is required'),
            position: z.number().int().optional(),
          })
          .strict(),
      )
      .min(1, 'models must contain at least one item'),
  })
  .strict();

const ProviderModelCreateRequestSchema = z.union([
  ProviderModelCreateSchema,
  ProviderModelBulkCreateSchema,
]);

@Controller('api/providers/:id/models')
export class ProviderModelsController {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly mcpRegistration: McpProviderRegistrationService,
  ) {}

  @Get()
  async listProviderModels(@Param('id') providerId: string) {
    logger.info({ providerId }, 'GET /api/providers/:id/models');
    await this.storage.getProvider(providerId);
    return this.storage.listProviderModelsByProvider(providerId);
  }

  @Post()
  async createProviderModel(@Param('id') providerId: string, @Body() body: unknown) {
    logger.info({ providerId }, 'POST /api/providers/:id/models');
    await this.storage.getProvider(providerId);
    const parsed = ProviderModelCreateRequestSchema.parse(body);

    if ('name' in parsed) {
      return this.storage.createProviderModel({
        providerId,
        name: parsed.name,
      });
    }

    const orderedNames = parsed.models
      .map((model, index) => ({
        name: model.name,
        position: model.position ?? Number.MAX_SAFE_INTEGER,
        index,
      }))
      .sort((a, b) => (a.position === b.position ? a.index - b.index : a.position - b.position))
      .map((item) => item.name);

    const result = await this.storage.bulkCreateProviderModels(providerId, orderedNames);
    return {
      ...result,
      total: result.added.length + result.existing.length,
    };
  }

  @Delete(':modelId')
  async deleteProviderModel(@Param('id') providerId: string, @Param('modelId') modelId: string) {
    logger.info({ providerId, modelId }, 'DELETE /api/providers/:id/models/:modelId');
    await this.storage.getProvider(providerId);

    const models = await this.storage.listProviderModelsByProvider(providerId);
    if (!models.some((model) => model.id === modelId)) {
      throw new NotFoundException(`Provider model ${modelId} not found for provider ${providerId}`);
    }

    await this.storage.deleteProviderModel(modelId);
    return { success: true };
  }

  @Post('discover')
  async discoverProviderModels(@Param('id') providerId: string) {
    logger.info({ providerId }, 'POST /api/providers/:id/models/discover');
    const provider = await this.storage.getProvider(providerId);

    if (provider.name.toLowerCase() !== 'opencode') {
      throw new BadRequestException('Model discovery is only supported for the opencode provider');
    }

    const resolution = await this.mcpRegistration.resolveBinary(provider);
    if (!resolution.success || !resolution.binaryPath) {
      throw new BadRequestException(resolution.message ?? 'Unable to resolve provider binary');
    }

    try {
      const { stdout } = await execFileAsync(resolution.binaryPath, ['models'], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const modelNames = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const result = await this.storage.bulkCreateProviderModels(providerId, modelNames);
      return {
        ...result,
        total: result.added.length + result.existing.length,
      };
    } catch (error) {
      throw this.handleDiscoverError(error, resolution.binaryPath);
    }
  }

  private handleDiscoverError(error: unknown, binaryPath: string): never {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      signal?: NodeJS.Signals | null;
      code?: string | number | null;
      killed?: boolean;
    };

    if (err.code === 'ENOENT') {
      throw new BadRequestException(`Provider binary not found: ${binaryPath}`);
    }

    if (err.killed || err.signal === 'SIGTERM') {
      throw new BadRequestException('Model discovery timed out after 30000ms');
    }

    if (typeof err.code === 'number') {
      throw new BadRequestException({
        message: `Model discovery command failed with exit code ${err.code}`,
        details: (err.stderr || err.stdout || err.message || '').trim(),
      });
    }

    logger.error({ error }, 'Unexpected error while discovering provider models');
    throw new InternalServerErrorException('Failed to discover provider models');
  }
}
