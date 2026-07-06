import {
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
import { ProviderAdapterFactory } from '../adapters';
import { isEffortCapable } from '../adapters/capabilities';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('ProviderEffortsController');

// Mirrors provider-models.controller.ts:20-39. `min(1)` is structural non-empty
// validation only — NOT catalog-membership validation. Effort values are stored
// provider-native verbatim (UI-only validation is the project decision; no
// backend catalog rejection on any path).
const ProviderEffortCreateSchema = z
  .object({
    name: z.string().min(1, 'name is required'),
  })
  .strict();

const ProviderEffortBulkCreateSchema = z
  .object({
    efforts: z
      .array(
        z
          .object({
            name: z.string().min(1, 'name is required'),
            position: z.number().int().optional(),
          })
          .strict(),
      )
      .min(1, 'efforts must contain at least one item'),
  })
  .strict();

const ProviderEffortCreateRequestSchema = z.union([
  ProviderEffortCreateSchema,
  ProviderEffortBulkCreateSchema,
]);

@Controller('api/providers/:id/efforts')
export class ProviderEffortsController {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly adapterFactory: ProviderAdapterFactory,
  ) {}

  @Get()
  async listProviderEfforts(@Param('id') providerId: string) {
    logger.info({ providerId }, 'GET /api/providers/:id/efforts');
    const provider = await this.storage.getProvider(providerId);

    // supportsEffort is derived via isEffortCapable(adapter) at THIS endpoint only —
    // provider list/get DTOs stay undecorated (validated team decision). An unknown
    // or unsupported provider yields supportsEffort=false. Empty ≠ unsupported: a
    // capable-but-unseeded catalog still returns supportsEffort=true with efforts: [],
    // so the UI can manage (add/remove) effort values for capable providers whose
    // catalog has been emptied, while hiding the surface entirely for agy.
    let supportsEffort = false;
    let requiresModelForEffort = false;
    if (this.adapterFactory.isSupported(provider.name)) {
      const adapter = this.adapterFactory.getAdapter(provider.name);
      if (isEffortCapable(adapter)) {
        supportsEffort = true;
        requiresModelForEffort = adapter.requiresModelForEffort === true;
      }
    }

    const efforts = await this.storage.listProviderEffortsByProvider(providerId);
    return { efforts, supportsEffort, requiresModelForEffort };
  }

  @Post()
  async createProviderEffort(@Param('id') providerId: string, @Body() body: unknown) {
    logger.info({ providerId }, 'POST /api/providers/:id/efforts');
    await this.storage.getProvider(providerId);
    const parsed = ProviderEffortCreateRequestSchema.parse(body);

    if ('name' in parsed) {
      return this.storage.createProviderEffort({
        providerId,
        name: parsed.name,
      });
    }

    const orderedNames = parsed.efforts
      .map((effort, index) => ({
        name: effort.name,
        position: effort.position ?? Number.MAX_SAFE_INTEGER,
        index,
      }))
      .sort((a, b) => (a.position === b.position ? a.index - b.index : a.position - b.position))
      .map((item) => item.name);

    const result = await this.storage.bulkCreateProviderEfforts(providerId, orderedNames);
    return {
      ...result,
      total: result.added.length + result.existing.length,
    };
  }

  @Delete(':effortId')
  async deleteProviderEffort(@Param('id') providerId: string, @Param('effortId') effortId: string) {
    logger.info({ providerId, effortId }, 'DELETE /api/providers/:id/efforts/:effortId');
    await this.storage.getProvider(providerId);

    const efforts = await this.storage.listProviderEffortsByProvider(providerId);
    if (!efforts.some((effort) => effort.id === effortId)) {
      throw new NotFoundException(
        `Provider effort ${effortId} not found for provider ${providerId}`,
      );
    }

    await this.storage.deleteProviderEffort(effortId);
    return { success: true };
  }
}
