import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { SettingsService } from '../../settings/services/settings.service';
import {
  STORAGE_SERVICE,
  type AgentProfileStorage,
} from '../../storage/interfaces/storage.interface';
import type { AgentProfile, UpdateAgentProfile } from '../../storage/models/domain.models';

const logger = createLogger('ProfilesService');

@Injectable()
export class ProfilesService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: AgentProfileStorage,
    private readonly settings: SettingsService,
  ) {}

  async updateProfile(id: string, data: UpdateAgentProfile): Promise<AgentProfile> {
    const { projectId, ...updates } = data;
    const existing =
      projectId !== undefined || updates.name !== undefined
        ? await this.storage.getAgentProfile(id)
        : undefined;
    if (projectId !== undefined && projectId !== existing?.projectId) {
      throw new BadRequestException({
        message: 'Cannot change projectId of a profile',
        field: 'projectId',
      });
    }

    const updated = await this.storage.updateAgentProfile(id, updates);
    if (updates.name !== undefined && existing?.projectId && existing.name !== updated.name) {
      try {
        await this.settings.renameProfileInProjectPresets(
          existing.projectId,
          existing.name,
          updated.name,
        );
      } catch (error) {
        logger.error(
          {
            error,
            profileId: id,
            projectId: existing.projectId,
            oldName: existing.name,
            newName: updated.name,
          },
          'Failed to rename profile in project presets',
        );
      }
    }
    return updated;
  }
}
