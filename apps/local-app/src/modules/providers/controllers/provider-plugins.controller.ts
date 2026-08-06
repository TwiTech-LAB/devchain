import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import { ProviderPluginsService } from '../services/provider-plugins.service';

const logger = createLogger('ProviderPluginsController');
const ASCII_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

const InstallProviderPluginSchema = z
  .object({
    providerId: z.string().trim().min(1).max(100),
    pluginId: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((value) => !ASCII_CONTROL_PATTERN.test(value), {
        message: 'pluginId must not contain ASCII control characters',
      }),
  })
  .strict();

@Controller('api/provider-plugins')
export class ProviderPluginsController {
  constructor(private readonly providerPlugins: ProviderPluginsService) {}

  @Get()
  listCatalog() {
    logger.info('GET /api/provider-plugins');
    return this.providerPlugins.listCatalog();
  }

  @Post('refresh')
  refreshCatalog() {
    logger.info('POST /api/provider-plugins/refresh');
    return this.providerPlugins.refreshCatalog();
  }

  @Post('install')
  install(@Body() body: unknown) {
    logger.info('POST /api/provider-plugins/install');
    const request = InstallProviderPluginSchema.parse(body);
    return this.providerPlugins.install(request.providerId, request.pluginId);
  }
}
