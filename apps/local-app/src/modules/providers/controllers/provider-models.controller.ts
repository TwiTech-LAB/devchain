import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Body,
} from '@nestjs/common';
import { z } from 'zod';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { McpProviderRegistrationService } from '../services/mcp-provider-registration.service';
import { createLogger } from '../../../common/logging/logger';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';

const logger = createLogger('ProviderModelsController');

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
    private readonly executor: ProcessExecutor,
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

    const execResult = await this.executor.run({
      argv: [resolution.binaryPath, 'models'],
      mode: 'pipe',
      timeout: 30_000,
      outputLimits: { maxBytes: 1024 * 1024 },
    });

    if (execResult.timedOut) {
      throw new BadRequestException('Model discovery timed out after 30000ms');
    }

    if (!execResult.success) {
      const details = (execResult.stderr || execResult.stdout || '').trim();
      if (execResult.exitCode === null && !details) {
        throw new BadRequestException(`Provider binary not found: ${resolution.binaryPath}`);
      }
      throw new BadRequestException({
        message: `Model discovery command failed with exit code ${execResult.exitCode}`,
        details,
      });
    }

    const modelNames = execResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const result = await this.storage.bulkCreateProviderModels(providerId, modelNames);
    return {
      ...result,
      total: result.added.length + result.existing.length,
    };
  }
}
