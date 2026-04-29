import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { NotFoundError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { SettingsService } from '../../settings/services/settings.service';
import { UnifiedTemplateService } from '../../registry/services/unified-template.service';

const logger = createLogger('ProviderProjectSyncService');

export interface SyncWarning {
  projectId: string;
  profileId?: string;
  configName?: string;
  reason:
    | 'no_template'
    | 'no_manifest_match'
    | 'name_taken_by_other_provider'
    | 'position_conflict'
    | 'unknown_constraint';
}

export interface SyncResult {
  providerId: string;
  insertedCount: number;
  affectedProjectIds: string[];
  skippedExistingCount: number;
  skippedConflictCount: number;
  warnings: SyncWarning[];
}

interface TemplateProfileConfig {
  name: string;
  providerName: string;
  description: string | null;
  options: string | null;
  env: Record<string, string> | null;
}

interface TemplateProfile {
  name: string;
  providerConfigs?: TemplateProfileConfig[];
}

@Injectable()
export class ProviderProjectSyncService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly unifiedTemplateService: UnifiedTemplateService,
  ) {}

  async syncProviderToAllProjects(providerId: string): Promise<SyncResult> {
    const provider = await this.storage.getProvider(providerId);
    if (!provider) {
      throw new NotFoundError('Provider', providerId);
    }

    const providerNameLower = provider.name.trim().toLowerCase();
    const result: SyncResult = {
      providerId,
      insertedCount: 0,
      affectedProjectIds: [],
      skippedExistingCount: 0,
      skippedConflictCount: 0,
      warnings: [],
    };

    const { items: projects } = await this.storage.listProjects();

    for (const project of projects) {
      const templateProfiles = await this.getTemplateProfilesForProject(project.id);
      const { items: profiles } = await this.storage.listAgentProfiles({
        projectId: project.id,
      });

      let projectInserted = false;

      for (const profile of profiles) {
        const candidates = this.resolveCandidates(
          templateProfiles,
          profile.name,
          providerNameLower,
          provider.name,
          project.id,
          result.warnings,
        );

        for (const candidate of candidates) {
          const createResult = await this.storage.createIfMissing({
            profileId: profile.id,
            providerId,
            name: candidate.name,
            description: candidate.description ?? null,
            options: candidate.options ?? null,
            env: candidate.env ?? undefined,
          });

          if (createResult.inserted) {
            result.insertedCount++;
            projectInserted = true;
          } else if (createResult.reason === 'name_exists_same_provider') {
            result.skippedExistingCount++;
          } else {
            result.skippedConflictCount++;
            const warningReason = this.mapConflictReason(createResult.reason);
            if (warningReason) {
              result.warnings.push({
                projectId: project.id,
                profileId: profile.id,
                configName: candidate.name,
                reason: warningReason,
              });
            }
          }
        }
      }

      if (projectInserted) {
        result.affectedProjectIds.push(project.id);
      }
    }

    logger.info(
      {
        providerId,
        insertedCount: result.insertedCount,
        skippedExistingCount: result.skippedExistingCount,
        skippedConflictCount: result.skippedConflictCount,
        affectedProjects: result.affectedProjectIds.length,
        warnings: result.warnings.length,
      },
      'Provider sync to projects completed',
    );

    return result;
  }

  private resolveCandidates(
    templateProfiles: TemplateProfile[] | null,
    profileName: string,
    providerNameLower: string,
    providerOriginalName: string,
    projectId: string,
    warnings: SyncWarning[],
  ): Array<{
    name: string;
    description: string | null;
    options: string | null;
    env: Record<string, string> | null;
  }> {
    if (!templateProfiles) {
      warnings.push({ projectId, reason: 'no_template' });
      return [{ name: providerOriginalName, description: null, options: null, env: null }];
    }

    const profileNameLower = profileName.trim().toLowerCase();
    const manifestProfile = templateProfiles.find(
      (p) => p.name.trim().toLowerCase() === profileNameLower,
    );

    if (!manifestProfile || !manifestProfile.providerConfigs?.length) {
      warnings.push({ projectId, reason: 'no_manifest_match' });
      return [{ name: providerOriginalName, description: null, options: null, env: null }];
    }

    const matchingConfigs = manifestProfile.providerConfigs.filter(
      (c) => c.providerName.trim().toLowerCase() === providerNameLower,
    );

    if (matchingConfigs.length === 0) {
      warnings.push({ projectId, reason: 'no_manifest_match' });
      return [{ name: providerOriginalName, description: null, options: null, env: null }];
    }

    return matchingConfigs.map((c) => ({
      name: c.name,
      description: c.description ?? null,
      options: c.options ?? null,
      env: c.env ?? null,
    }));
  }

  private async getTemplateProfilesForProject(
    projectId: string,
  ): Promise<TemplateProfile[] | null> {
    const metadata = this.settings.getProjectTemplateMetadata(projectId);
    if (!metadata?.templateSlug) {
      return null;
    }

    try {
      if (metadata.source === 'file') {
        return null;
      }

      let content: Record<string, unknown>;

      if (metadata.source === 'bundled') {
        const template = this.unifiedTemplateService.getBundledTemplate(metadata.templateSlug);
        content = template.content;
      } else {
        const template = await this.unifiedTemplateService.getTemplate(
          metadata.templateSlug,
          metadata.installedVersion ?? undefined,
        );

        if (template.source !== 'registry') {
          return null;
        }

        content = template.content;
      }

      const profiles = content.profiles;
      if (!Array.isArray(profiles)) {
        return null;
      }

      return profiles as TemplateProfile[];
    } catch (error) {
      logger.debug(
        { projectId, templateSlug: metadata.templateSlug, error },
        'Failed to fetch template content for project',
      );
      return null;
    }
  }

  private mapConflictReason(reason?: string): SyncWarning['reason'] | null {
    switch (reason) {
      case 'name_exists_other_provider':
        return 'name_taken_by_other_provider';
      case 'position_conflict':
        return 'position_conflict';
      case 'unknown_constraint':
        return 'unknown_constraint';
      default:
        return null;
    }
  }
}
