import { createLogger } from '../../../../common/logging/logger';
import type { SettingsDto, MessagePoolSettingsDto } from '../../dtos/settings.dto';
import {
  DEFAULT_MESSAGE_POOL_ENABLED,
  DEFAULT_MESSAGE_POOL_DELAY_MS,
  DEFAULT_MESSAGE_POOL_MAX_WAIT_MS,
  DEFAULT_MESSAGE_POOL_MAX_MESSAGES,
  DEFAULT_MESSAGE_POOL_SEPARATOR,
  type ProjectPoolSettings,
} from '../../services/settings.constants';

const logger = createLogger('MessagePoolSettingsDelegate');

export interface MessagePoolDelegateContext {
  getSettings: () => SettingsDto;
  updateSettings: (settings: SettingsDto) => Promise<SettingsDto>;
}

export class MessagePoolSettingsDelegate {
  constructor(private readonly context: MessagePoolDelegateContext) {}

  getMessagePoolConfig(): Required<Omit<MessagePoolSettingsDto, 'projects'>> {
    const settings = this.context.getSettings();
    const pool = settings.messagePool ?? {};

    return {
      enabled: pool.enabled ?? DEFAULT_MESSAGE_POOL_ENABLED,
      delayMs: pool.delayMs ?? DEFAULT_MESSAGE_POOL_DELAY_MS,
      maxWaitMs: pool.maxWaitMs ?? DEFAULT_MESSAGE_POOL_MAX_WAIT_MS,
      maxMessages: pool.maxMessages ?? DEFAULT_MESSAGE_POOL_MAX_MESSAGES,
      separator: pool.separator ?? DEFAULT_MESSAGE_POOL_SEPARATOR,
    };
  }

  getMessagePoolConfigForProject(
    projectId: string,
  ): Required<Omit<MessagePoolSettingsDto, 'projects'>> {
    const globalConfig = this.getMessagePoolConfig();
    const settings = this.context.getSettings();
    const projectOverrides = settings.messagePool?.projects?.[projectId];

    if (!projectOverrides) {
      return globalConfig;
    }

    return {
      enabled: projectOverrides.enabled ?? globalConfig.enabled,
      delayMs: projectOverrides.delayMs ?? globalConfig.delayMs,
      maxWaitMs: projectOverrides.maxWaitMs ?? globalConfig.maxWaitMs,
      maxMessages: projectOverrides.maxMessages ?? globalConfig.maxMessages,
      separator: projectOverrides.separator ?? globalConfig.separator,
    };
  }

  getProjectPoolSettings(projectId: string): ProjectPoolSettings | undefined {
    const settings = this.context.getSettings();
    return settings.messagePool?.projects?.[projectId];
  }

  async setProjectPoolSettings(
    projectId: string,
    poolSettings: ProjectPoolSettings | null,
  ): Promise<void> {
    const currentSettings = this.context.getSettings();
    const existingProjects = currentSettings.messagePool?.projects ?? {};

    if (poolSettings === null) {
      const remaining = { ...existingProjects };
      delete remaining[projectId];
      await this.context.updateSettings({
        messagePool: {
          projects: remaining,
        },
      });
    } else {
      await this.context.updateSettings({
        messagePool: {
          projects: {
            ...existingProjects,
            [projectId]: poolSettings,
          },
        },
      });
    }

    logger.info({ projectId, poolSettings }, 'Project pool settings updated');
  }
}
