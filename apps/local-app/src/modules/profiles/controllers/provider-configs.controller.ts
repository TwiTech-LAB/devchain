import {
  Controller,
  Get,
  Put,
  Delete,
  Param,
  Body,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ProfileProviderConfig } from '../../storage/models/domain.models';
import { createLogger } from '../../../common/logging/logger';
import { UpdateProviderConfigSchema, ProfileProviderConfigSchema } from '../dto';
import { ValidationError } from '../../../common/errors/error-types';

const logger = createLogger('ProviderConfigsController');

@Controller('api/provider-configs')
export class ProviderConfigsController {
  constructor(@Inject(STORAGE_SERVICE) private readonly storage: StorageService) {}

  @Get(':id')
  async getProviderConfig(@Param('id') id: string): Promise<ProfileProviderConfig> {
    logger.info({ id }, 'GET /api/provider-configs/:id');
    const config = await this.storage.getProfileProviderConfig(id);
    return ProfileProviderConfigSchema.parse(config);
  }

  @Put(':id')
  async updateProviderConfig(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ProfileProviderConfig> {
    logger.info({ id }, 'PUT /api/provider-configs/:id');

    const data = UpdateProviderConfigSchema.parse(body);

    // Build update object, only including fields that were provided
    const updateData: {
      providerId?: string;
      name?: string;
      options?: string | null;
      env?: Record<string, string> | null;
    } = {};

    if (data.providerId !== undefined) {
      updateData.providerId = data.providerId;
    }
    if (data.name !== undefined) {
      updateData.name = data.name;
    }
    if (data.options !== undefined) {
      updateData.options = data.options;
    }
    if (data.env !== undefined) {
      updateData.env = data.env;
    }

    const config = await this.storage.updateProfileProviderConfig(id, updateData);
    return ProfileProviderConfigSchema.parse(config);
  }

  @Delete(':id')
  async deleteProviderConfig(@Param('id') id: string): Promise<void> {
    logger.info({ id }, 'DELETE /api/provider-configs/:id');
    try {
      await this.storage.deleteProfileProviderConfig(id);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new BadRequestException({
          message: error.message,
          code: 'CONFIG_IN_USE',
        });
      }
      throw error;
    }
  }
}
