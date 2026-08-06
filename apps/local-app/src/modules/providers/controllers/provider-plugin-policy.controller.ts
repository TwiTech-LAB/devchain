import { Body, Controller, Delete, Get, Inject, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { ProviderPluginPolicyService } from '../services/provider-plugin-policy.service';

const logger = createLogger('ProviderPluginPolicyController');
const ASCII_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

const PolicyQuerySchema = z
  .object({
    projectId: z.string().trim().min(1).max(100),
    providerId: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

const ProviderPluginKeyQuerySchema = z
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

const ProjectProviderPluginKeyQuerySchema = ProviderPluginKeyQuerySchema.extend({
  projectId: z.string().trim().min(1).max(100),
}).strict();

const PolicyBodySchema = z
  .object({
    projectId: z.string().trim().min(1).max(100).optional(),
    providerId: z.string().trim().min(1).max(100),
    pluginId: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((value) => !ASCII_CONTROL_PATTERN.test(value), {
        message: 'pluginId must not contain ASCII control characters',
      }),
    enabled: z.boolean(),
  })
  .strict();

@Controller('api/provider-plugins/policy')
export class ProviderPluginPolicyController {
  constructor(
    private readonly policy: ProviderPluginPolicyService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  @Get()
  async list(@Query() query: unknown) {
    const parsed = PolicyQuerySchema.parse(query);
    logger.info(
      { projectId: parsed.projectId, providerId: parsed.providerId },
      'GET plugin policy',
    );
    await this.storage.getProject(parsed.projectId);

    if (parsed.providerId) {
      await this.storage.getProvider(parsed.providerId);
      return { items: await this.policy.listConfigured(parsed.projectId, parsed.providerId) };
    }

    const providers = await this.storage.listProviders({ limit: 1_000, offset: 0 });
    const items = await Promise.all(
      providers.items.map((provider) => this.policy.listConfigured(parsed.projectId, provider.id)),
    );
    return { items: items.flat() };
  }

  @Put('default')
  async setDefault(@Body() body: unknown) {
    logger.info('PUT default plugin policy');
    const parsed = PolicyBodySchema.omit({ projectId: true }).parse(body);
    await this.storage.getProvider(parsed.providerId);
    return this.policy.setDefault(parsed.providerId, parsed.pluginId, parsed.enabled);
  }

  @Delete('default')
  async resetDefault(@Query() query: unknown) {
    logger.info('DELETE default plugin policy');
    const parsed = ProviderPluginKeyQuerySchema.parse(query);
    await this.storage.getProvider(parsed.providerId);
    const deleted = await this.policy.resetDefault(parsed.providerId, parsed.pluginId);
    return { deleted };
  }

  @Put('project')
  async setProject(@Body() body: unknown) {
    logger.info('PUT project plugin policy');
    const parsed = PolicyBodySchema.required({ projectId: true }).parse(body);
    await this.storage.getProject(parsed.projectId);
    await this.storage.getProvider(parsed.providerId);
    return this.policy.setProjectOverride(
      parsed.projectId,
      parsed.providerId,
      parsed.pluginId,
      parsed.enabled,
    );
  }

  @Delete('project')
  async resetProject(@Query() query: unknown) {
    logger.info('DELETE project plugin policy');
    const parsed = ProjectProviderPluginKeyQuerySchema.parse(query);
    await this.storage.getProject(parsed.projectId);
    await this.storage.getProvider(parsed.providerId);
    const deleted = await this.policy.resetProjectOverride(
      parsed.projectId,
      parsed.providerId,
      parsed.pluginId,
    );
    return { deleted };
  }
}
