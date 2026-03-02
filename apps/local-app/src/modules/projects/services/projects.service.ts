import { Injectable, Inject } from '@nestjs/common';
import { type ManifestData } from '@devchain/shared';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SettingsService } from '../../settings/services/settings.service';
import { WatchersService } from '../../watchers/services/watchers.service';
import { WatcherRunnerService } from '../../watchers/services/watcher-runner.service';
import { UnifiedTemplateService } from '../../registry/services/unified-template.service';
import { importProjectWithHelper } from '../helpers/project-import';
import { exportProjectWithHelper } from '../helpers/project-export';
import { createFromTemplateWithHelper } from '../helpers/template-loader';
import {
  computeFamilyAlternativesFromStorage,
  type FamilyAlternative,
  type FamilyAlternativesResult,
} from '../helpers/profile-mapping.helpers';
import {
  applyPresetWithHelper,
  doesProjectMatchPresetWithHelper,
  type PresetAgentConfig,
} from '../helpers/project-presets.helpers';
import {
  applyProjectSettingsWithHelper,
  createSubscribersFromPayloadWithHelper,
  createWatchersFromPayloadWithHelper,
  getImportErrorMessage,
  normalizeProfileOptions,
} from '../helpers/project-runtime.helpers';
import {
  getTemplateManifestForProjectWithHelper,
  getBundledUpgradeVersionWithHelper,
  getBundledUpgradesForProjectsWithHelper,
} from '../helpers/project-template-manifest.helpers';
import {
  deriveSlugFromPath,
  getTemplateContentWithHelper,
  listTemplatesWithHelper,
  slugify,
} from '../helpers/template-file.helpers';

export interface TemplateInfo {
  id: string;
  fileName: string;
}

export interface CreateFromTemplateInput {
  name: string;
  description?: string | null;
  rootPath: string;
  projectId?: string;
  slug?: string;
  version?: string | null;
  templatePath?: string;
  familyProviderMappings?: Record<string, string>;
  presetName?: string;
}

export interface ProviderMappingRequired {
  missingProviders: string[];
  familyAlternatives: FamilyAlternative[];
  canImport: boolean;
}

export interface ImportProjectInput {
  projectId: string;
  payload: unknown;
  dryRun?: boolean;
  statusMappings?: Record<string, string>;
  familyProviderMappings?: Record<string, string>;
}

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly sessions: SessionsService,
    private readonly settings: SettingsService,
    private readonly watchersService: WatchersService,
    private readonly watcherRunner: WatcherRunnerService,
    private readonly unifiedTemplateService: UnifiedTemplateService,
  ) {}

  async listTemplates(): Promise<TemplateInfo[]> {
    return listTemplatesWithHelper(__dirname);
  }

  async getTemplateContent(templateId: string): Promise<unknown> {
    return getTemplateContentWithHelper(__dirname, templateId);
  }

  async createFromTemplate(input: CreateFromTemplateInput) {
    return createFromTemplateWithHelper(input, {
      storage: this.storage,
      settings: this.settings,
      unifiedTemplateService: this.unifiedTemplateService,
      deriveSlugFromPath,
      computeFamilyAlternatives: (profiles, agents) =>
        this.computeFamilyAlternatives(profiles, agents),
      normalizeProfileOptions,
      applyProjectSettings: (projectId, projectSettings, maps, archiveStatusId) =>
        applyProjectSettingsWithHelper(
          projectId,
          projectSettings,
          maps,
          archiveStatusId,
          this.settings,
        ),
      createWatchersFromPayload: (projectId, watchers, maps) =>
        createWatchersFromPayloadWithHelper(projectId, watchers, maps, this.watchersService),
      createSubscribersFromPayload: (projectId, subscribers) =>
        createSubscribersFromPayloadWithHelper(projectId, subscribers, this.storage),
      applyPreset: (projectId, presetName, nameMaps) =>
        applyPresetWithHelper(
          projectId,
          presetName,
          { storage: this.storage, settings: this.settings },
          nameMaps,
        ),
    });
  }

  async exportProject(
    projectId: string,
    opts?: {
      manifestOverrides?: Partial<ManifestData>;
      presets?: Array<{
        name: string;
        description?: string | null;
        agentConfigs: Array<{
          agentName: string;
          providerConfigName: string;
          modelOverride?: string | null;
        }>;
      }>;
    },
  ) {
    return exportProjectWithHelper(projectId, opts, {
      storage: this.storage,
      settings: this.settings,
      slugify,
    });
  }

  async doesProjectMatchPreset(
    projectId: string,
    preset: {
      name: string;
      agentConfigs: PresetAgentConfig[];
    },
  ): Promise<boolean> {
    return doesProjectMatchPresetWithHelper(projectId, preset, { storage: this.storage });
  }

  async applyPreset(
    projectId: string,
    presetName: string,
    nameMaps?: {
      agentNameToId: Map<string, string>;
      configLookupMap: Map<string, string>;
    },
  ): Promise<{ applied: number; warnings: string[] }> {
    return applyPresetWithHelper(
      projectId,
      presetName,
      { storage: this.storage, settings: this.settings },
      nameMaps,
    );
  }

  async importProject(input: ImportProjectInput) {
    return importProjectWithHelper(input, {
      storage: this.storage,
      settings: this.settings,
      watchersService: this.watchersService,
      sessions: this.sessions,
      unifiedTemplateService: this.unifiedTemplateService,
      computeFamilyAlternatives: (templateProfiles, templateAgents) =>
        this.computeFamilyAlternatives(templateProfiles, templateAgents),
      createWatchersFromPayload: (projectId, watchers, maps) =>
        createWatchersFromPayloadWithHelper(projectId, watchers, maps, this.watchersService),
      createSubscribersFromPayload: (projectId, subscribers) =>
        createSubscribersFromPayloadWithHelper(projectId, subscribers, this.storage),
      applyProjectSettings: (projectId, projectSettings, maps, archiveStatusId) =>
        applyProjectSettingsWithHelper(
          projectId,
          projectSettings,
          maps,
          archiveStatusId,
          this.settings,
        ),
      getImportErrorMessage,
    });
  }

  async computeFamilyAlternatives(
    templateProfiles: Array<{
      id?: string;
      name: string;
      provider: { name: string };
      familySlug?: string | null;
      providerConfigs?: Array<{ name: string; providerName: string }>;
    }>,
    templateAgents: Array<{
      id?: string;
      name: string;
      profileId?: string;
    }>,
  ): Promise<FamilyAlternativesResult> {
    return computeFamilyAlternativesFromStorage(this.storage, templateProfiles, templateAgents);
  }

  async getTemplateManifestForProject(projectId: string): Promise<ManifestData | null> {
    return getTemplateManifestForProjectWithHelper(projectId, {
      settings: this.settings,
      unifiedTemplateService: this.unifiedTemplateService,
    });
  }

  getBundledUpgradeVersion(templateSlug: string, installedVersion: string | null): string | null {
    return getBundledUpgradeVersionWithHelper(
      templateSlug,
      installedVersion,
      this.unifiedTemplateService,
    );
  }

  getBundledUpgradesForProjects(
    projects: Array<{
      projectId: string;
      templateSlug: string | null;
      installedVersion: string | null;
      source: 'bundled' | 'registry' | 'file' | null;
    }>,
  ): Map<string, string | null> {
    return getBundledUpgradesForProjectsWithHelper(projects, this.unifiedTemplateService);
  }
}
