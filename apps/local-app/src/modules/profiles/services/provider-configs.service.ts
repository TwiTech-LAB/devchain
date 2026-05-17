import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { SettingsService } from '../../settings/services/settings.service';
import {
  AgentProfileStorage,
  AgentStorage,
  ProfileProviderConfigStorage,
  STORAGE_SERVICE,
} from '../../storage/interfaces/storage.interface';
import {
  Agent,
  ProfileProviderConfig,
  UpdateProfileProviderConfig,
} from '../../storage/models/domain.models';

const logger = createLogger('ProviderConfigsService');
const CASCADE_AGENT_LIST_LIMIT = 10000;

type ProviderConfigsStorage = ProfileProviderConfigStorage & AgentProfileStorage & AgentStorage;

@Injectable()
export class ProviderConfigsService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ProviderConfigsStorage,
    private readonly settings: SettingsService,
  ) {}

  async updateProviderConfig(
    id: string,
    data: UpdateProfileProviderConfig,
  ): Promise<ProfileProviderConfig> {
    const oldConfig = await this.storage.getProfileProviderConfig(id);
    const updatedConfig = await this.storage.updateProfileProviderConfig(id, data);

    if (oldConfig.name.trim() !== updatedConfig.name.trim()) {
      await this.cascadeProviderConfigRename(oldConfig, updatedConfig);
    }

    return updatedConfig;
  }

  private async cascadeProviderConfigRename(
    oldConfig: ProfileProviderConfig,
    updatedConfig: ProfileProviderConfig,
  ): Promise<void> {
    try {
      const profile = await this.storage.getAgentProfile(updatedConfig.profileId);

      if (profile.projectId) {
        const { items: agents } = await this.storage.listAgents(profile.projectId, {
          limit: CASCADE_AGENT_LIST_LIMIT,
          offset: 0,
        });
        await this.renameInProjectPresets(
          profile.projectId,
          profile.id,
          oldConfig.name,
          updatedConfig.name,
          agents,
        );
        return;
      }

      const projectPresets = this.settings.getAllProjectPresetsMap();
      for (const projectId of projectPresets.keys()) {
        const { items: agents } = await this.storage.listAgents(projectId, {
          limit: CASCADE_AGENT_LIST_LIMIT,
          offset: 0,
        });
        const affectedAgents = agents.filter((agent) => agent.profileId === profile.id);

        if (affectedAgents.length === 0) {
          continue;
        }

        await this.renameInProjectPresets(
          projectId,
          profile.id,
          oldConfig.name,
          updatedConfig.name,
          affectedAgents,
        );
      }
    } catch (error) {
      logger.error(
        {
          error,
          configId: updatedConfig.id,
          profileId: updatedConfig.profileId,
          oldName: oldConfig.name,
          newName: updatedConfig.name,
        },
        'Failed to cascade provider config rename to project presets',
      );
      throw error;
    }
  }

  private async renameInProjectPresets(
    projectId: string,
    profileId: string,
    oldName: string,
    newName: string,
    agents: Agent[],
  ): Promise<void> {
    await this.settings.renameProviderConfigInProjectPresets(projectId, {
      profileId,
      oldName,
      newName,
      agents: agents.map((agent) => ({
        name: agent.name,
        profileId: agent.profileId,
      })),
    });
  }
}
