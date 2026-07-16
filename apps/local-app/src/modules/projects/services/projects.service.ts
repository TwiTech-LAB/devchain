import { Injectable, Inject, Optional } from '@nestjs/common';
import { ExportSchema, type ExportData, type ManifestData } from '@devchain/shared';
import { ValidationError } from '../../../common/errors/error-types';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SettingsService } from '../../settings/services/settings.service';
import { WatchersService } from '../../watchers/services/watchers.service';
import { WatcherRunnerService } from '../../watchers/services/watcher-runner.service';
import { UnifiedTemplateService } from '../../registry/services/unified-template.service';
import { TeamsService } from '../../teams/services/teams.service';
import {
  SCHEDULED_EPIC_RUNNER_REFRESH,
  type ScheduledEpicRunnerRefresh,
} from '../../scheduled-epics/services/scheduled-epics.service';
import { getNextRunAt } from '../../scheduled-epics/helpers/cron-helpers';
import {
  ProjectProviderProvisioningService,
  type ProvisioningWarning,
} from './project-provider-provisioning.service';
import type { Project, UpdateProject } from '../../storage/models/domain.models';
import { TemplatePipeline } from '../template-codec/template-pipeline';
import { importProjectWithHelper } from '../helpers/project-import';
import { exportProjectWithHelper } from '../helpers/project-export';
import { createFromTemplateWithHelper } from '../helpers/template-loader';
import {
  buildProviderSummary,
  computeFamilyAlternatives,
  computeFamilyAlternativesFromStorage,
  derivePresetProviderCoverage,
  type FamilyAlternative,
  type FamilyAlternativesResult,
} from '../helpers/profile-mapping.helpers';
import {
  applyAgentConfigs,
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
import { probe1mSupport } from '../../providers/utils/probe-1m';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
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
import type { SetupPreviewInput, SetupPreviewResponse } from '../dtos/setup-preview.dto';

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
  agentOverrides?: PresetAgentConfig[];
  /** Transient Step-1 provider choice metadata. Narrows selection eligibility; not persisted. */
  selectedProviderNames?: string[];
  teamOverrides?: Array<{
    teamName: string;
    allowTeamLeadCreateAgents?: boolean;
    maxMembers?: number;
    maxConcurrentTasks?: number;
    profileSelections?: Array<{
      profileName: string;
      configNames: string[];
    }>;
  }>;
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
  agentOverrides?: PresetAgentConfig[];
  /** Transient Step-1 provider choice metadata. Narrows selection eligibility; not persisted. */
  selectedProviderNames?: string[];
  teamOverrides?: Array<{
    teamName: string;
    allowTeamLeadCreateAgents?: boolean;
    maxMembers?: number;
    maxConcurrentTasks?: number;
    profileNames?: string[];
    profileSelections?: Array<{ profileName: string; configNames: string[] }>;
  }>;
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
    private readonly teamsService: TeamsService,
    private readonly provisioning: ProjectProviderProvisioningService,
    private readonly executor: ProcessExecutor,
    @Optional()
    private readonly templatePipeline?: TemplatePipeline,
    @Optional()
    @Inject(SCHEDULED_EPIC_RUNNER_REFRESH)
    private readonly scheduledEpicRunnerRefresh?: ScheduledEpicRunnerRefresh,
  ) {}

  async listTemplates(): Promise<TemplateInfo[]> {
    return listTemplatesWithHelper(__dirname);
  }

  async getTemplateContent(templateId: string): Promise<unknown> {
    return getTemplateContentWithHelper(__dirname, templateId);
  }

  async createFromTemplate(input: CreateFromTemplateInput) {
    await this.assertSelectedProvidersInstalled(input.selectedProviderNames);
    const result = await createFromTemplateWithHelper(input, {
      storage: this.storage,
      settings: this.settings,
      unifiedTemplateService: this.unifiedTemplateService,
      deriveSlugFromPath,
      computeFamilyAlternatives: (profiles, agents, selectedProviderNames) =>
        this.computeFamilyAlternatives(profiles, agents, selectedProviderNames),
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
      // Real watchers service so the create-path watchers codec starts runners for enabled
      // watchers (the create orchestrator's seam falls back to storage.createWatcher only when
      // this is absent, e.g. reduced test deps).
      watchersService: this.watchersService,
      probe1m: (binPath: string) => probe1mSupport(this.executor, binPath),
      teamsService: this.teamsService,
      scheduledEpicsRefresh: this.scheduledEpicRunnerRefresh,
      computeNextRunAt: getNextRunAt,
      applyPreset: (projectId, presetName, nameMaps) =>
        applyPresetWithHelper(
          projectId,
          presetName,
          { storage: this.storage, settings: this.settings },
          nameMaps,
        ),
      applyAgentConfigs: (projectId, agentConfigs, nameMaps) =>
        applyAgentConfigs(projectId, agentConfigs, { storage: this.storage }, nameMaps),
    });

    if (result?.success && result.project && !('providerMappingRequired' in result)) {
      const { warnings } = await this.provisioning.provisionProject(
        result.project.id ?? input.projectId ?? '',
      );
      if (warnings.length > 0) {
        (result as Record<string, unknown>).provisioningWarnings = warnings;
      }
    }

    return result;
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
          effortOverride?: string | null;
        }>;
      }>;
    },
  ) {
    return exportProjectWithHelper(projectId, opts, {
      storage: this.storage,
      settings: this.settings,
      slugify,
      teamsService: this.teamsService,
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
    await this.assertSelectedProvidersInstalled(input.selectedProviderNames);
    const result = await importProjectWithHelper(input, {
      storage: this.storage,
      settings: this.settings,
      templatePipeline: this.templatePipeline,
      watchersService: this.watchersService,
      sessions: this.sessions,
      unifiedTemplateService: this.unifiedTemplateService,
      cleanupTeamsForProject: (projectId) => this.teamsService.deleteTeamsByProject(projectId),
      computeFamilyAlternatives: (templateProfiles, templateAgents, selectedProviderNames) =>
        this.computeFamilyAlternatives(templateProfiles, templateAgents, selectedProviderNames),
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
      applyAgentConfigs: (projectId, agentConfigs, nameMaps) =>
        applyAgentConfigs(projectId, agentConfigs, { storage: this.storage }, nameMaps),
      probe1m: (binPath: string) => probe1mSupport(this.executor, binPath),
      teamsService: this.teamsService,
      scheduledEpicsRefresh: this.scheduledEpicRunnerRefresh,
      computeNextRunAt: getNextRunAt,
    });

    if (result && 'success' in result && result.success && !input.dryRun) {
      const { warnings } = await this.provisioning.provisionProject(input.projectId);
      if (warnings.length > 0) {
        (result as Record<string, unknown>).provisioningWarnings = warnings;
      }
    }

    return result;
  }

  async updateProject(
    id: string,
    data: UpdateProject,
  ): Promise<{ project: Project; provisioningWarnings: ProvisioningWarning[] }> {
    const before = await this.storage.getProject(id);
    const project = await this.storage.updateProject(id, data);

    let provisioningWarnings: ProvisioningWarning[] = [];
    if (before && before.rootPath !== project.rootPath) {
      const { warnings } = await this.provisioning.provisionProject(id);
      provisioningWarnings = warnings;
    }

    return { project, provisioningWarnings };
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
    selectedProviderNames?: string[],
  ): Promise<FamilyAlternativesResult> {
    return computeFamilyAlternativesFromStorage(
      this.storage,
      templateProfiles,
      templateAgents,
      undefined,
      selectedProviderNames,
    );
  }

  /**
   * Enforce the transient `selectedProviderNames` choice contract: every selected name must
   * correspond to a locally installed provider (case-insensitive). Unknown names → 400. This is
   * the storage-dependent half of the contract; the request-shape half (non-empty, lowercased) is
   * validated at the controller. No-op when the field is absent.
   */
  private async assertSelectedProvidersInstalled(
    selectedProviderNames: string[] | undefined,
  ): Promise<void> {
    if (!selectedProviderNames) return;
    const installed = await this.storage.listProviders();
    const installedNames = new Set(installed.items.map((p) => p.name.trim().toLowerCase()));
    const unknown = selectedProviderNames.filter(
      (name) => !installedNames.has(name.trim().toLowerCase()),
    );
    if (unknown.length > 0) {
      throw new ValidationError('Unknown provider names in selectedProviderNames', {
        unknownProviders: unknown,
        hint: 'selectedProviderNames must reference locally installed providers.',
      });
    }
  }

  /**
   * Preview a template BEFORE creating/importing anything: resolve content from exactly one of
   * {slug(+version) | templatePath | rawContent}, ExportSchema.parse it (ZodError → 400 with
   * details via the global filter), and enrich with providerSummary + familyAlternatives +
   * per-preset referenced providers + local availability. Additive only; no persistence.
   */
  async setupPreview(input: SetupPreviewInput): Promise<SetupPreviewResponse> {
    const payload = await this.resolveSetupPreviewPayload(input);

    const localProviders = await this.storage.listProviders();
    const availableProviderNames = new Set(
      localProviders.items.map((p) => p.name.trim().toLowerCase()),
    );

    const providerSummary = buildProviderSummary(
      payload.profiles,
      payload.agents,
      availableProviderNames,
    );
    const familyResult = computeFamilyAlternatives(
      payload.profiles,
      payload.agents,
      availableProviderNames,
    );
    const coverage = derivePresetProviderCoverage(
      payload.presets,
      payload.profiles,
      payload.agents,
      availableProviderNames,
    );

    return {
      payload,
      providerSummary,
      familyAlternatives: familyResult.alternatives,
      presetProviderCoverage: coverage.map((c) => ({
        presetName: c.presetName,
        referencedProviders: c.referencedProviders,
        coversAllAgents: c.coversAllAgents,
        coveredAgentNames: Array.from(c.coveredAgentNames).sort(),
        agentResolvedProviders: Object.fromEntries(c.agentResolvedProviders),
      })),
      localAvailability: {
        installedProviders: localProviders.items.map((p) => ({ id: p.id, name: p.name })),
      },
    };
  }

  /** Resolve + ExportSchema.parse the template payload for setup-preview. Throws ZodError on
   * invalid payloads (mapped to 400 with details by the global filter); throws the
   * unified-template-service domain errors (NotFound/Forbidden/Validation) for slug/path issues. */
  private async resolveSetupPreviewPayload(input: SetupPreviewInput): Promise<ExportData> {
    let content: Record<string, unknown>;
    if (input.rawContent !== undefined) {
      content = input.rawContent;
    } else if (input.templatePath) {
      content = this.unifiedTemplateService.getTemplateFromFilePath(input.templatePath)
        .content as Record<string, unknown>;
    } else {
      content = (
        await this.unifiedTemplateService.getTemplate(input.slug!, input.version ?? undefined)
      ).content as Record<string, unknown>;
    }
    return ExportSchema.parse(content) as ExportData;
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
