import { createLogger } from '../../../../common/logging/logger';
import type {
  SettingsDto,
  RegistryConfigDto,
  RegistryTemplateMetadataDto,
} from '../../dtos/settings.dto';

const logger = createLogger('RegistrySettingsDelegate');

const DEFAULT_REGISTRY_URL = 'https://a1-devchain.twitechlab.com';

export interface RegistryDelegateContext {
  getSettings: () => SettingsDto;
  updateSettings: (settings: SettingsDto) => Promise<SettingsDto>;
}

export class RegistrySettingsDelegate {
  constructor(private readonly context: RegistryDelegateContext) {}

  getRegistryConfig(): Required<RegistryConfigDto> {
    const settings = this.context.getSettings();
    const registry = settings.registry ?? {};

    const url = registry.url || process.env.REGISTRY_URL || DEFAULT_REGISTRY_URL;

    return {
      url,
      cacheDir: registry.cacheDir ?? '',
      checkUpdatesOnStartup: registry.checkUpdatesOnStartup ?? true,
    };
  }

  async setRegistryConfig(config: Partial<RegistryConfigDto>): Promise<void> {
    const currentSettings = this.context.getSettings();
    const existingRegistry = currentSettings.registry ?? {};

    await this.context.updateSettings({
      registry: {
        ...existingRegistry,
        ...config,
      },
    });

    logger.info({ config }, 'Registry config updated');
  }

  getProjectTemplateMetadata(projectId: string): RegistryTemplateMetadataDto | null {
    const settings = this.context.getSettings();
    return settings.registryTemplates?.[projectId] ?? null;
  }

  async setProjectTemplateMetadata(
    projectId: string,
    metadata: RegistryTemplateMetadataDto,
  ): Promise<void> {
    const currentSettings = this.context.getSettings();
    const existingTemplates = currentSettings.registryTemplates ?? {};

    await this.context.updateSettings({
      registryTemplates: {
        ...existingTemplates,
        [projectId]: metadata,
      },
    });

    logger.info(
      { projectId, templateSlug: metadata.templateSlug, version: metadata.installedVersion },
      'Project template metadata updated',
    );
  }

  async clearProjectTemplateMetadata(projectId: string): Promise<void> {
    const currentSettings = this.context.getSettings();
    const existingTemplates = currentSettings.registryTemplates ?? {};

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { [projectId]: _removed, ...remaining } = existingTemplates;

    await this.context.updateSettings({
      registryTemplates: remaining,
    });

    logger.info({ projectId }, 'Project template metadata cleared');
  }

  getAllTrackedProjects(): Array<{ projectId: string; metadata: RegistryTemplateMetadataDto }> {
    const settings = this.context.getSettings();
    const templates = settings.registryTemplates ?? {};

    return Object.entries(templates).map(([projectId, metadata]) => ({
      projectId,
      metadata,
    }));
  }

  getAllProjectTemplateMetadataMap(): Map<string, RegistryTemplateMetadataDto> {
    const settings = this.context.getSettings();
    const templates = settings.registryTemplates ?? {};
    return new Map(Object.entries(templates));
  }

  async updateLastUpdateCheck(projectId: string): Promise<void> {
    const existing = this.getProjectTemplateMetadata(projectId);
    if (!existing) {
      logger.warn({ projectId }, 'Cannot update lastUpdateCheckAt: project not tracked');
      return;
    }

    await this.setProjectTemplateMetadata(projectId, {
      ...existing,
      lastUpdateCheckAt: new Date().toISOString(),
    });
  }
}
