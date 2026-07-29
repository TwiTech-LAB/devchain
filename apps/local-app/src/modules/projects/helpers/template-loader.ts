import { ExportSchema } from '@devchain/shared';
import { ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import {
  buildPromptReferenceValidationFailure,
  findSkippedTemplatePromptReferences,
} from '../../../common/prompt-references';
import { PROMPT_TRANSFER_POLICY, type PromptTransferCounts } from '../../../common/prompt-transfer';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { SettingsService } from '../../settings/services/settings.service';
import type { UnifiedTemplateService } from '../../registry/services/unified-template.service';
import {
  collectReferencedProviderNames,
  derivePresetProviderCoverage,
  extractTemplatePresets,
  hasPresetName,
  resolveProvidersFromStorage,
  selectProfilesForFamilies,
  type FamilyAlternativesResult,
  type ProjectSettingsTemplateInput,
} from './profile-mapping.helpers';
import type { PresetAgentConfig } from './project-presets.helpers';
import type { TeamsService } from '../../teams/services/teams.service';
import type { WatchersService } from '../../watchers/services/watchers.service';
import { ImportContext } from '../template-codec/import-context';
import { TemplatePipeline } from '../template-codec/template-pipeline';

const logger = createLogger('TemplateLoader');

/**
 * Module-init-validated pipeline for the create-new flow (topology validated once at load).
 * Reused by every create-from-template call; there is no per-request validation cost.
 */
const CREATE_TEMPLATE_PIPELINE = new TemplatePipeline();

export interface CreateFromTemplateInputLike {
  name: string;
  description?: string | null;
  rootPath: string;
  projectId?: string;
  slug?: string;
  version?: string | null;
  templatePath?: string;
  familyProviderMappings?: Record<string, string>;
  presetName?: string;
  /**
   * Wizard/API per-agent config overrides (preset-SHAPED but not a stored preset). Mutually
   * exclusive with `presetName` (enforced at the controller). Applied via `applyAgentConfigs`
   * and NEVER marks an active preset.
   */
  agentOverrides?: PresetAgentConfig[];
  /**
   * Transient Step-1 wizard choice metadata. When present (validated non-empty + lowercased at
   * the controller), it narrows family and agent selection eligibility without restricting
   * persistence or missing-provider reporting. Not persisted.
   */
  selectedProviderNames?: string[];
  teamOverrides?: Array<{
    teamName: string;
    allowTeamLeadCreateAgents?: boolean;
    maxMembers?: number;
    maxConcurrentTasks?: number;
    profileNames?: string[];
    profileSelections?: Array<{
      profileName: string;
      configNames: string[];
    }>;
  }>;
}

type ParsedTemplatePayload = ReturnType<typeof ExportSchema.parse>;

interface CreateFromTemplateDeps {
  storage: StorageService;
  settings: SettingsService;
  unifiedTemplateService: UnifiedTemplateService;
  deriveSlugFromPath: (templatePath: string) => string;
  computeFamilyAlternatives: (
    profiles: ParsedTemplatePayload['profiles'],
    agents: ParsedTemplatePayload['agents'],
    selectedProviderNames?: string[],
  ) => Promise<FamilyAlternativesResult>;
  normalizeProfileOptions: (options: unknown) => string | null;
  applyProjectSettings: (
    projectId: string,
    projectSettings: ProjectSettingsTemplateInput | undefined,
    maps: {
      promptTitleToId: Map<string, string>;
      statusLabelToId: Map<string, string>;
    },
    archiveStatusId: string | null,
  ) => Promise<{ initialPromptSet: boolean }>;
  createWatchersFromPayload: (
    projectId: string,
    watchers: ParsedTemplatePayload['watchers'],
    maps: {
      agentNameToId: Map<string, string>;
      profileNameToId: Map<string, string>;
      providerNameToId: Map<string, string>;
      profileNameRemapMap?: Map<string, string>;
    },
  ) => Promise<{ created: number; watcherIdMap: Record<string, string> }>;
  createSubscribersFromPayload: (
    projectId: string,
    subscribers: ParsedTemplatePayload['subscribers'],
  ) => Promise<{ created: number; subscriberIdMap: Record<string, string> }>;
  applyPreset: (
    projectId: string,
    presetName: string,
    nameMaps?: {
      agentNameToId: Map<string, string>;
      configLookupMap: Map<string, string>;
    },
  ) => Promise<{ applied: number; warnings: string[] }>;
  applyAgentConfigs: (
    projectId: string,
    agentConfigs: PresetAgentConfig[],
    nameMaps?: {
      agentNameToId: Map<string, string>;
      configLookupMap: Map<string, string>;
    },
  ) => Promise<{ applied: number; warnings: string[] }>;
  teamsService?: TeamsService;
  /**
   * Real watchers service (starts runners on create) for the watchers codec. Optional: when
   * absent (reduced/test deps), the create orchestrator falls back to `storage.createWatcher`.
   */
  watchersService?: Pick<WatchersService, 'createWatcher'>;
  scheduledEpicsRefresh?: {
    refreshScheduleWindow: () => void;
  };
  computeNextRunAt?: (cronExpression: string, timezone: string) => Date | null;
}

type FamilyMappingResolution =
  | {
      success: true;
      payload: ParsedTemplatePayload;
      templateSlug: string;
      templateResult: Awaited<ReturnType<UnifiedTemplateService['getTemplate']>>;
      /** Full installed-provider map (name(lowercased) → id) — for persistence + validation. */
      installedProviders: Map<string, string>;
      /** Installed map narrowed to the Step-1 allowlist (≡ installed when none) — binding eligibility. */
      selectedProviders: Map<string, string>;
      selectedProfilesByFamily: ReturnType<
        typeof selectProfilesForFamilies<ParsedTemplatePayload['profiles'][number]>
      >;
    }
  | {
      success: false;
      response: {
        success: false;
        providerMappingRequired: {
          missingProviders: string[];
          familyAlternatives: FamilyAlternativesResult['alternatives'];
          canImport: boolean;
        };
      };
    };

export async function createFromTemplateWithHelper(
  input: CreateFromTemplateInputLike,
  deps: CreateFromTemplateDeps,
) {
  logger.info({ input }, 'createFromTemplate');

  const { payload, templateResult, templateSlug } = await loadTemplate(input, deps);

  // When a preset is selected, resolve which agents are fully covered by it via the shared
  // preset→provider derivation (agentConfig → agent → profileId → profile.providerConfigs).
  const presetCoveredAgentNames = new Set<string>();
  const presetAgentResolvedProviders = new Map<string, string>();
  let presetCoversAllAgents = false;
  if (input.presetName) {
    const selectedPreset = (payload.presets ?? []).find(
      (p: { name: string }) => p.name === input.presetName,
    );
    if (selectedPreset) {
      const localProviders = await deps.storage.listProviders();
      // Preset coverage follows the Step-1 choice set: a preset targeting a deselected provider
      // must not count as covering that agent.
      const allow = input.selectedProviderNames
        ? new Set(input.selectedProviderNames.map((n) => n.trim().toLowerCase()))
        : undefined;
      const localProviderNames = new Set(
        localProviders.items
          .map((p) => p.name.trim().toLowerCase())
          .filter((name) => !allow || allow.has(name)),
      );
      const coverage = derivePresetProviderCoverage(
        payload.presets ?? [],
        payload.profiles ?? [],
        payload.agents ?? [],
        localProviderNames,
        { selectedPresetName: input.presetName },
      )[0];
      if (coverage) {
        for (const [k, v] of coverage.agentResolvedProviders) {
          presetAgentResolvedProviders.set(k, v);
        }
        for (const n of coverage.coveredAgentNames) {
          presetCoveredAgentNames.add(n);
        }
        presetCoversAllAgents = coverage.coversAllAgents;

        if (presetCoversAllAgents) {
          logger.info(
            { presetName: input.presetName, coveredAgents: [...presetCoveredAgentNames] },
            'Preset covers all agents with available providers — skipping family mapping',
          );
        } else if (presetCoveredAgentNames.size > 0) {
          logger.info(
            { presetName: input.presetName, coveredAgents: [...presetCoveredAgentNames] },
            'Preset partially covers agents — suppressing warnings for covered agents only',
          );
        }
      }
    }
  }

  const mappingResolution = await resolveFamilyMappings(
    input,
    payload,
    templateSlug,
    templateResult,
    deps,
    { presetCoveredAgentNames, presetAgentResolvedProviders, presetCoversAllAgents },
  );
  if (!mappingResolution.success) {
    return mappingResolution.response;
  }

  const {
    installedProviders,
    selectedProviders,
    selectedProfilesByFamily,
    payload: resolvedPayload,
    templateResult: resolvedTemplateResult,
    templateSlug: resolvedTemplateSlug,
  } = mappingResolution;

  const promptReferenceFailure = buildPromptReferenceValidationFailure(
    findSkippedTemplatePromptReferences(
      selectedProfilesByFamily.profilesToCreate,
      resolvedPayload.prompts,
    ),
  );
  if (promptReferenceFailure) {
    return promptReferenceFailure;
  }

  // Build warnings from provider substitutions (for frontend display)
  const warnings: Array<{
    type: 'provider_mismatch';
    originalProvider: string;
    substituteProvider: string;
    agentNames: string[];
  }> = [];
  for (const [, substitution] of selectedProfilesByFamily.providerSubstitutions) {
    warnings.push({
      type: 'provider_mismatch',
      originalProvider: substitution.originalProvider,
      substituteProvider: substitution.substituteProvider,
      agentNames: substitution.agentNames,
    });
  }

  // ---- Pipeline-driven create (one pipeline, both flows). ------------------------------
  // CREATE-CORE runs inside a single IMMEDIATE transaction: project row + sourceProjectEnabled
  // seeding (createProjectShell) + statuses + prompts + profiles(+configs) + agents. A mid-core
  // throw rolls the whole project back — no orphan project row. Reusing the section codecs is
  // what makes the create path carry agent effortOverride + config model/effort (parity #1/#2);
  // providerModels/providerEfforts are seeded by their codecs post-core (parity #3).
  const pipelineCtx = new ImportContext(
    { selectedProfilesByFamily },
    // Fresh project: nothing to clear, no epics to load — both preconditions trivially hold.
    ['existingDataCleared', 'epicsLoaded'],
  );

  // Watcher-creation seam (mirrors the import path): prefer the real service's `createWatcher`
  // (starts runners in production), else fall back to `storage.createWatcher` (reduced/test deps).
  const watcherServiceForCodec = {
    createWatcher: (data: Parameters<StorageService['createWatcher']>[0]) => {
      const svc = deps.watchersService;
      return svc?.createWatcher ? svc.createWatcher(data) : deps.storage.createWatcher(data);
    },
  };

  const buildRuntime = (projectId: string) => ({
    projectId,
    promptTransferPolicy: PROMPT_TRANSFER_POLICY.Template,
    storage: deps.storage,
    settings: deps.settings,
    watchersService: watcherServiceForCodec,
    installedProviders,
    selectedProviders,
    existingStatuses: [] as const,
    teamsService: deps.teamsService,
    teamOverrides: input.teamOverrides,
    scheduledEpicsRefresh: deps.scheduledEpicsRefresh,
    computeNextRunAt: deps.computeNextRunAt,
  });

  let coreResults: Awaited<ReturnType<TemplatePipeline['applySections']>> = [];
  const project = await deps.storage.runInTransaction(async () => {
    const created = await deps.storage.createProjectShell(
      {
        name: input.name,
        description: input.description ?? null,
        rootPath: input.rootPath,
        isTemplate: false,
      },
      input.projectId ? { projectId: input.projectId } : undefined,
    );
    coreResults = await CREATE_TEMPLATE_PIPELINE.applySections(
      ['statuses', 'prompts', 'profiles', 'agents'],
      resolvedPayload,
      pipelineCtx,
      'create',
      buildRuntime(created.id),
    );
    return created;
  });

  // POST-TX (non-transactional): watchers, subscribers, teams (non-fatal on create),
  // scheduledEpics, projectSettings + initialPrompt, presets, providerSettings, providerModels,
  // providerEfforts — in registry order.
  const postResults = await CREATE_TEMPLATE_PIPELINE.applySections(
    [
      'watchers',
      'subscribers',
      'teams',
      'scheduledEpics',
      'projectSettings',
      'presets',
      'providerSettings',
      'providerModels',
      'providerEfforts',
    ],
    resolvedPayload,
    pipelineCtx,
    'create',
    buildRuntime(project.id),
  );

  const logOf = (section: string): Record<string, unknown> =>
    postResults.find((r) => r.section === section)?.log ?? {};
  const watchersCreated = (logOf('watchers').watchers as number | undefined) ?? 0;
  const subscribersCreated = (logOf('subscribers').subscribers as number | undefined) ?? 0;
  const scheduledEpicsCreated = (logOf('scheduledEpics').scheduledEpics as number | undefined) ?? 0;
  const initialPromptSet =
    (logOf('projectSettings').initialPromptSet as boolean | undefined) ?? false;
  const promptApply = coreResults.find((result) => result.section === 'prompts')
    ?.promptTransfer ?? {
    imported: 0,
    skipped: 0,
  };
  const promptTransfer: PromptTransferCounts = {
    ...promptApply,
    deleted: 0,
    preserved: 0,
  };

  const statusIdMap = pipelineCtx.get('statusIdMap');
  const promptIdMap = pipelineCtx.get('promptIdMap');
  const profileIdMap = pipelineCtx.get('profileIdMap');
  const agentIdMap = pipelineCtx.get('agentIdMap');

  // Template metadata is a post-sections lifecycle step (needs slug + resolved source); not a codec.
  await applyTemplateMetadata(
    project.id,
    resolvedPayload,
    resolvedTemplateSlug,
    resolvedTemplateResult,
    deps.settings,
  );

  // Preset APPLICATION (create-specific: selects each agent's provider config by name). The presets
  // themselves were stored by the presets codec above; here we apply the chosen one.
  const presetName = input.presetName;
  if (presetName) {
    const templatePresets = extractTemplatePresets(resolvedPayload as { presets?: unknown });
    const selectedPreset = templatePresets.find((preset) => hasPresetName(preset, presetName));
    if (!selectedPreset) {
      logger.warn({ projectId: project.id, presetName }, 'Selected preset not found in template');
    } else {
      await deps.applyPreset(project.id, presetName, {
        agentNameToId: new Map(Object.entries(pipelineCtx.get('agentNameToId'))),
        configLookupMap: pipelineCtx.get('selectionEligibleConfigLookupMap'),
      });
      logger.info({ projectId: project.id, presetName }, 'Applied preset to project');
    }
  }

  // Per-agent config overrides (wizard/API). Mutually exclusive with presetName (enforced at the
  // controller); applied via the shared inner helper and NEVER marks an active preset. Uses the
  // same name maps the preset path uses so config resolution is byte-identical.
  const agentOverrides = input.agentOverrides;
  if (agentOverrides && agentOverrides.length > 0) {
    const { applied, warnings } = await deps.applyAgentConfigs(project.id, agentOverrides, {
      agentNameToId: new Map(Object.entries(pipelineCtx.get('agentNameToId'))),
      configLookupMap: pipelineCtx.get('selectionEligibleConfigLookupMap'),
    });
    logger.info(
      { projectId: project.id, applied, warnings: warnings.length },
      'Applied agentOverrides to project',
    );
  }

  return {
    success: true,
    project,
    imported: {
      prompts: promptTransfer.imported,
      profiles: selectedProfilesByFamily.profilesToCreate.length,
      agents: resolvedPayload.agents.length,
      statuses: resolvedPayload.statuses.length,
      watchers: watchersCreated,
      subscribers: subscribersCreated,
      scheduledEpics: scheduledEpicsCreated,
    },
    promptTransfer,
    mappings: { promptIdMap, profileIdMap, agentIdMap, statusIdMap },
    initialPromptSet,
    message: 'Project created from template successfully.',
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

async function loadTemplate(input: CreateFromTemplateInputLike, deps: CreateFromTemplateDeps) {
  let templateResult: Awaited<ReturnType<UnifiedTemplateService['getTemplate']>>;
  let templateSlug: string;

  if (input.templatePath) {
    templateResult = deps.unifiedTemplateService.getTemplateFromFilePath(input.templatePath);
    const manifest = templateResult.content._manifest as { slug?: string } | undefined;
    templateSlug = manifest?.slug ?? deps.deriveSlugFromPath(input.templatePath);
  } else if (input.slug) {
    templateResult = await deps.unifiedTemplateService.getTemplate(
      input.slug,
      input.version ?? undefined,
    );
    templateSlug = input.slug;
  } else {
    throw new ValidationError('Either slug or templatePath is required', {});
  }

  try {
    const payload = ExportSchema.parse(templateResult.content);
    return { payload, templateResult, templateSlug };
  } catch (error) {
    logger.error({ error, slug: templateSlug, version: input.version }, 'Invalid template format');
    throw new ValidationError('Invalid template format', {
      hint: 'Template file does not match expected export schema',
    });
  }
}

async function resolveFamilyMappings(
  input: CreateFromTemplateInputLike,
  payload: ParsedTemplatePayload,
  templateSlug: string,
  templateResult: Awaited<ReturnType<UnifiedTemplateService['getTemplate']>>,
  deps: CreateFromTemplateDeps,
  presetOptions?: {
    presetCoveredAgentNames: Set<string>;
    presetAgentResolvedProviders: Map<string, string>;
    presetCoversAllAgents: boolean;
  },
): Promise<FamilyMappingResolution> {
  const familyResult = await deps.computeFamilyAlternatives(
    payload.profiles,
    payload.agents,
    input.selectedProviderNames,
  );
  const needsMapping = familyResult.alternatives.some((alt) => !alt.defaultProviderAvailable);
  let effectiveFamilyProviderMappings = input.familyProviderMappings;

  if (!presetOptions?.presetCoversAllAgents) {
    if (needsMapping && !effectiveFamilyProviderMappings) {
      const autoMappings: Record<string, string> = {};
      let canAutoSelect = familyResult.canImport;

      for (const alt of familyResult.alternatives) {
        if (alt.defaultProviderAvailable) continue;
        if (alt.availableProviders.length === 1) {
          autoMappings[alt.familySlug] = alt.availableProviders[0];
        } else {
          canAutoSelect = false;
        }
      }

      if (canAutoSelect) {
        effectiveFamilyProviderMappings = autoMappings;
        logger.info({ autoMappings, templateSlug }, 'Auto-selected provider mappings for template');
      } else {
        return {
          success: false,
          response: {
            success: false,
            providerMappingRequired: {
              missingProviders: familyResult.missingProviders,
              familyAlternatives: familyResult.alternatives,
              canImport: familyResult.canImport,
            },
          },
        };
      }
    }

    if (!familyResult.canImport) {
      return {
        success: false,
        response: {
          success: false,
          providerMappingRequired: {
            missingProviders: familyResult.missingProviders,
            familyAlternatives: familyResult.alternatives,
            canImport: false,
          },
        },
      };
    }
  }

  const referencedProviderNames = collectReferencedProviderNames(payload.profiles);
  const { installed, selected } = await resolveProvidersFromStorage(
    deps.storage,
    referencedProviderNames,
    input.selectedProviderNames,
  );

  // Fail-fast if no providers are installed but template requires profiles
  if (installed.size === 0 && payload.profiles.length > 0) {
    throw new ValidationError(
      'No providers are installed. At least one provider is required to create a project from a template.',
    );
  }

  // Validate against the FULL installed map: an installed-but-deselected provider is available for
  // creation/binding — deselection only narrows the wizard's family alternatives.
  const selectedProfilesByFamily = selectProfilesForFamilies(
    payload.profiles,
    payload.agents,
    effectiveFamilyProviderMappings,
    installed,
    presetOptions
      ? {
          presetCoveredAgentNames: presetOptions.presetCoveredAgentNames,
          presetAgentResolvedProviders: presetOptions.presetAgentResolvedProviders,
        }
      : undefined,
  );

  return {
    success: true,
    payload,
    templateSlug,
    templateResult,
    installedProviders: installed,
    selectedProviders: selected,
    selectedProfilesByFamily,
  };
}

async function applyTemplateMetadata(
  projectId: string,
  payload: ParsedTemplatePayload,
  templateSlug: string,
  templateResult: Awaited<ReturnType<UnifiedTemplateService['getTemplate']>>,
  settings: SettingsService,
) {
  const manifestVersion = (payload._manifest as { version?: string } | undefined)?.version ?? null;
  const installedVersion = templateResult.version ?? manifestVersion;

  const registryConfig = settings.getRegistryConfig();
  await settings.setProjectTemplateMetadata(projectId, {
    templateSlug,
    source: templateResult.source,
    installedVersion,
    registryUrl: templateResult.source === 'registry' ? registryConfig.url : null,
    installedAt: new Date().toISOString(),
  });

  logger.info(
    {
      projectId,
      slug: templateSlug,
      source: templateResult.source,
      version: installedVersion,
    },
    'Template metadata set for project',
  );
}
