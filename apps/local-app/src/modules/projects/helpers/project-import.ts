import { ExportSchema } from '@devchain/shared';
import { StorageError, ValidationError } from '../../../common/errors/error-types';
import type {
  PreservationIssue,
  PreservationReview,
  PreserveTeamSetup,
} from '../../../common/project-preservation.contract';
import type { TeamsService } from '../../teams/services/teams.service';
import {
  mixesPreserveTeamSetup,
  PRESERVE_SETUP_EXCLUSIVE_MESSAGE,
} from '../dtos/preserve-team-setup.schema';
import {
  composePreservedRoster,
  preservedProfileDependencyIds,
  resolvePreservedRoster,
} from './project-preservation';
import { createLogger } from '../../../common/logging/logger';
import {
  buildPromptReferenceValidationFailure,
  findSkippedTemplatePromptReferences,
  type PromptReferenceIssue,
  type PromptReferenceValidationFailure,
} from '../../../common/prompt-references';
import {
  PROMPT_TRANSFER_POLICY,
  partitionPromptsForTransfer,
  planPromptReplacement,
  type PromptTransferCounts,
  type PromptTransferPolicy,
  type PromptReplacementPlan,
} from '../../../common/prompt-transfer';
import type { SettingsService } from '../../settings/services/settings.service';
import type {
  StorageService,
  AgentProfileStorage,
  AgentStorage,
  PromptStorage,
  ScheduledEpicStorage,
  SessionStorage,
  StatusStorage,
  SubscriberStorage,
  WatcherStorage,
} from '../../storage/interfaces/storage.interface';
import type { SnapshotPromptWriter } from '../../storage/interfaces/snapshot-prompt-writer.interface';
import type { UnifiedTemplateService } from '../../registry/services/unified-template.service';
import {
  collectReferencedProviderNames,
  computeFamilyAlternatives,
  derivePresetProviderCoverage,
  profileOptionProviderNames,
  resolveProvidersFromStorage,
  selectProfilesForFamilies,
  type FamilyAlternative,
  type FamilyAlternativesResult,
  type ProjectSettingsTemplateInput,
} from './profile-mapping.helpers';
import {
  findDuplicateAgentNames,
  planAndApplySessionPreservation,
} from './project-import-sessions';
import type { ApplyPresetFn, PresetAgentConfig } from './project-presets.helpers';
import { getPresetSkippedTeamNames } from './team-overrides.helpers';
import {
  restoreSnapshotEpicAssignments,
  type SnapshotEpicAssignments,
} from './snapshot-epic-assignments';
import { ImportContext } from '../template-codec/import-context';
import { TemplatePipeline } from '../template-codec/template-pipeline';
import type { CodecApplyRuntime } from '../template-codec/template-section-codec';

/**
 * Module-init-validated fallback pipeline. Constructed once when this module loads (so
 * its topological validation runs at module init, not per request), and reused by every
 * import that does not supply its own `deps.templatePipeline`. Production wires the
 * NestJS-provided `TemplatePipeline` through deps; tests and internal callers fall back
 * to this shared singleton. Either way there is no per-request validation cost.
 */
const DEFAULT_TEMPLATE_PIPELINE = new TemplatePipeline();

const logger = createLogger('ProjectImport');

type ParsedTemplatePayload = ReturnType<typeof ExportSchema.parse>;
type SelectedProfilesByFamily = ReturnType<
  typeof selectProfilesForFamilies<ParsedTemplatePayload['profiles'][number]>
>;

type ExistingProjectData = Awaited<ReturnType<typeof loadExistingProjectData>>;
type ProjectEpics = Awaited<ReturnType<StorageService['listEpics']>>;
type UnmatchedStatus = {
  id: string;
  label: string;
  color: string;
  epicCount: number;
};

export type ActiveSessionSummary = { id: string; agentId: string | null };

export type ImportReadinessIssue =
  | PreservationIssue
  | {
      code: 'prompt_reference_validation';
      message: string;
      details: PromptReferenceValidationFailure['promptReferenceValidation'];
    }
  | {
      code: 'selected_providers_not_installed';
      message: string;
      details: { providerNames: string[] };
    }
  | {
      code: 'preset_not_found';
      message: string;
      details: { presetName: string };
    }
  | {
      code: 'provider_mapping_required';
      message: string;
      details: ReturnType<typeof buildProviderMappingRequired>;
    }
  | {
      code: 'selected_profiles_unavailable';
      message: string;
      details: { providerNames: string[] };
    }
  | {
      code: 'active_sessions';
      message: string;
      details: { activeSessions: ActiveSessionSummary[] };
    }
  | {
      code: 'duplicate_agent_names';
      message: string;
      details: { agentNames: string[] };
    };

export interface ImportReadiness {
  ready: boolean;
  issues: ImportReadinessIssue[];
}

type ImportPreparation = {
  isDryRun: boolean;
  promptTransferPolicy: PromptTransferPolicy;
  promptTransfer: PromptTransferCounts;
  promptReplacementPlan: PromptReplacementPlan;
  promptReferenceIssues: PromptReferenceIssue[];
  payload: ParsedTemplatePayload;
  familyResult: FamilyAlternativesResult;
  providerMappingRequired: ReturnType<typeof buildProviderMappingRequired> | null;
  /** Full installed-provider map (name(lowercased) → id) — for persistence + validation. */
  installedProviders: Map<string, string>;
  /** Installed map narrowed to the Step-1 allowlist (≡ installed when none) — binding eligibility. */
  selectedProviders: Map<string, string>;
  missingProviders: string[];
  selectedProfilesByFamily: SelectedProfilesByFamily;
  existing: ExistingProjectData;
  unmatchedStatuses: UnmatchedStatus[];
  readiness: ImportReadiness;
  preservationPlan?: PreservationReview;
  existingTeamCount?: number;
};

export interface ImportProjectInputLike {
  projectId: string;
  payload: unknown;
  dryRun?: boolean;
  /** Internal-only. Public import requests always use the default template policy. */
  promptTransferPolicy?: PromptTransferPolicy;
  /** Assignments from the internal upgrade backup, keyed by surviving epic ID. */
  snapshotEpicAssignments?: SnapshotEpicAssignments;
  preserveTeamSetup?: PreserveTeamSetup;
  statusMappings?: Record<string, string>;
  familyProviderMappings?: Record<string, string>;
  /** Template preset to apply after the imported presets have been persisted. */
  presetName?: string;
  /**
   * Wizard/API per-agent config overrides. NEW import capability: import previously applied no
   * per-agent configuration. Applied after the profiles+agents batch via `applyAgentConfigs`;
   * NEVER marks an active preset. Mutually exclusive with a preset selection (controller 400).
   */
  agentOverrides?: PresetAgentConfig[];
  /**
   * Transient Step-1 wizard choice metadata. When present
   * (validated non-empty + lowercased at the controller), it narrows the SELECTION view used for
   * family/wizard choices — an installed provider outside it does not appear as a family
   * alternative. It does NOT affect persistence or missing reporting: installed-but-deselected
   * providers still have their configs created and never surface as missing (only genuinely
   * uninstalled providers do). Not persisted.
   */
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

interface ImportProjectDeps {
  storage: CodecApplyRuntime['storage'] &
    SessionStorage &
    WatcherStorage &
    Pick<StorageService, 'countEpicsByStatus' | 'updateEpic'>;
  snapshotPromptWriter?: SnapshotPromptWriter;
  settings: SettingsService;
  /** Template section pipeline; falls back to the module singleton when omitted. */
  templatePipeline?: TemplatePipeline;
  watchersService: {
    deleteWatcher: (watcherId: string) => Promise<void>;
  };
  sessions: {
    getActiveSessionsForProject: (
      projectId: string,
    ) => Array<{ id: string; agentId: string | null }>;
  };
  cleanupTeamsForProject?: (projectId: string) => Promise<void>;
  unifiedTemplateService: Pick<UnifiedTemplateService, 'getBundledTemplate'>;
  computeFamilyAlternatives: (
    templateProfiles: ParsedTemplatePayload['profiles'],
    templateAgents: ParsedTemplatePayload['agents'],
    selectedProviderNames?: string[],
  ) => Promise<FamilyAlternativesResult>;
  createWatchersFromPayload: (
    projectId: string,
    watchers: ParsedTemplatePayload['watchers'],
    maps: {
      agentNameToId: Map<string, string>;
      profileNameToId: Map<string, string>;
      providerNameToId: Map<string, string>;
      profileNameRemapMap?: Map<string, string>;
    },
  ) => Promise<{
    created: number;
    watcherIdMap: Record<string, string>;
  }>;
  createSubscribersFromPayload: (
    projectId: string,
    subscribers: ParsedTemplatePayload['subscribers'],
  ) => Promise<{
    created: number;
    subscriberIdMap: Record<string, string>;
  }>;
  applyProjectSettings: (
    projectId: string,
    projectSettings: ProjectSettingsTemplateInput | undefined,
    maps: {
      promptTitleToId: Map<string, string>;
      statusLabelToId: Map<string, string>;
    },
    archiveStatusId: string | null,
  ) => Promise<{ initialPromptSet: boolean }>;
  getImportErrorMessage: (error: unknown) => string;
  /**
   * Applies wizard/API `agentOverrides` after the profiles+agents batch. NEVER marks an active
   * preset. Falls back to building name maps from storage when they are omitted.
   */
  applyAgentConfigs: (
    projectId: string,
    agentConfigs: PresetAgentConfig[],
    nameMaps?: {
      agentNameToId: Map<string, string>;
      configLookupMap: Map<string, string>;
    },
  ) => Promise<{ applied: number; warnings: string[] }>;
  applyPreset: ApplyPresetFn;
  teamsService?: NonNullable<CodecApplyRuntime['teamsService']> &
    Pick<TeamsService, 'deleteTeamsByProject'> &
    Partial<Pick<TeamsService, 'getTeam'>>;
  scheduledEpicsRefresh?: {
    refreshScheduleWindow: () => void;
  };
  computeNextRunAt?: (cronExpression: string, timezone: string) => Date | null;
}

export async function importProjectWithHelper(
  input: ImportProjectInputLike,
  deps: ImportProjectDeps,
) {
  logger.info(
    {
      projectId: input.projectId,
      dryRun: input.dryRun,
      promptTransferPolicy: input.promptTransferPolicy ?? PROMPT_TRANSFER_POLICY.Template,
    },
    'importProject',
  );

  const context = await prepareImportContext(input, deps);

  if (context.isDryRun) {
    return buildDryRunResponse(context);
  }

  if (!context.readiness.ready) {
    return buildReadinessFailure(
      context.readiness,
      context.providerMappingRequired,
      context.preservationPlan,
    );
  }

  // SQLite clears epic assignments when their old agents are deleted.
  const previousEpicAssignments = context.preservationPlan
    ? captureEpicAgentAssignments(await listProjectEpics(input.projectId, deps.storage))
    : undefined;

  // Recheck the mutable session condition immediately before the first write. The preparation
  // result powers dry-run and normal preflight; this second guard closes the preflight-to-mutation
  // race and remains a structured, explicitly non-mutating outcome.
  const lateActiveSessions = getActiveSessions(input.projectId, deps);
  if (lateActiveSessions.length > 0) {
    return buildReadinessFailure(
      buildActiveSessionReadiness(lateActiveSessions),
      null,
      context.preservationPlan,
    );
  }

  try {
    const oldAgentIdToName = buildOldAgentIdToNameMap(context.existing.agents.items);

    const oldAgentIds = context.existing.agents.items.map((a) => a.id);
    const parkedByOldAgentId = await deps.storage.parkSessionsFromAgents(oldAgentIds);

    const clearedPrompts = await clearExistingProjectData(
      input.projectId,
      context.existing,
      context.promptReplacementPlan,
      deps,
    );

    // Template pipeline (replace mode). The statuses + prompts codecs own their sections;
    // their ordering invariants are declared reads/writes validated when the pipeline was
    // constructed. `existingDataCleared` is seeded because clearExistingProjectData just ran.
    const pipeline = deps.templatePipeline ?? DEFAULT_TEMPLATE_PIPELINE;
    const pipelineCtx = new ImportContext(
      { selectedProfilesByFamily: context.selectedProfilesByFamily },
      // `existingDataCleared`: clearExistingProjectData just ran. `epicsLoaded`: epics are
      // PRESERVED across replace (never cleared), so scheduledEpics may resolve parent titles.
      ['existingDataCleared', 'epicsLoaded'],
    );
    // Watcher-creation seam for the watchers codec. In production `deps.watchersService` is
    // the real service whose `createWatcher` also starts runners; some callers (and the
    // contract harness) provide a reduced `watchersService` and route creation through storage
    // instead. Mirror the legacy `createWatchersFromPayload` seam exactly by preferring the
    // service's `createWatcher` when present and falling back to `storage.createWatcher`, so the
    // codec path is byte-identical to the legacy inline path in every environment.
    const watcherServiceForCodec = {
      createWatcher: (
        data: Parameters<StorageService['createWatcher']>[0],
      ): ReturnType<StorageService['createWatcher']> => {
        const svc = deps.watchersService as { createWatcher?: StorageService['createWatcher'] };
        return svc.createWatcher ? svc.createWatcher(data) : deps.storage.createWatcher(data);
      },
    };
    const codecRuntime = {
      projectId: input.projectId,
      storage: deps.storage,
      ...(context.promptTransferPolicy === PROMPT_TRANSFER_POLICY.Snapshot &&
      deps.snapshotPromptWriter
        ? { snapshotPromptWriter: deps.snapshotPromptWriter }
        : {}),
      settings: deps.settings,
      watchersService: watcherServiceForCodec,
      statusMappings: input.statusMappings,
      existingStatuses: context.existing.statuses.items,
      installedProviders: context.installedProviders,
      selectedProviders: context.selectedProviders,
      applyPreservedRoster: context.preservationPlan !== undefined,
      teamsService: deps.teamsService,
      teamOverrides: input.teamOverrides,
      scheduledEpicsRefresh: deps.scheduledEpicsRefresh,
      computeNextRunAt: deps.computeNextRunAt,
      promptTransferPolicy: context.promptTransferPolicy,
    };
    const promptSectionResults = await pipeline.applySections(
      ['statuses', 'prompts'],
      context.payload,
      pipelineCtx,
      'replace',
      codecRuntime,
    );
    const statusIdMap = pipelineCtx.get('statusIdMap');
    const promptIdMap = pipelineCtx.get('promptIdMap');
    const statusesDeleted =
      (promptSectionResults.find((result) => result.section === 'statuses')?.log
        ?.statusesDeleted as number | undefined) ?? 0;
    const appliedPrompts = getPromptApplyCounts(promptSectionResults);

    // profiles (with embedded provider configs) + agents codecs.
    await pipeline.applySections(
      ['profiles', 'agents'],
      context.payload,
      pipelineCtx,
      'replace',
      codecRuntime,
    );
    const profileIdMap = pipelineCtx.get('profileIdMap');
    const agentIdMap = pipelineCtx.get('agentIdMap');
    const agentNameToId = pipelineCtx.get('agentNameToId');

    // An explicit per-agent override can use a config from any installed provider.
    if (input.agentOverrides && input.agentOverrides.length > 0) {
      const { applied, warnings } = await deps.applyAgentConfigs(
        input.projectId,
        input.agentOverrides,
        {
          agentNameToId: new Map(Object.entries(agentNameToId)),
          configLookupMap: pipelineCtx.get('configLookupMap'),
        },
      );
      logger.info(
        { projectId: input.projectId, applied, warnings: warnings.length },
        'Applied agentOverrides during import',
      );
    }

    const sessionPreservation = await planAndApplySessionPreservation(
      parkedByOldAgentId,
      context.existing.agents.items,
      agentNameToId,
      deps.storage,
    );
    logger.info(sessionPreservation, 'Session preservation applied');

    // watchers + subscribers codecs. They resolve name refs through the ImportContext maps
    // written by the profiles/agents codecs and publish watcherIdMap/subscriberIdMap for the
    // response `mappings` (byte-compatible with the legacy inline importWatchersAndSubscribers).
    await pipeline.applySections(
      ['watchers', 'subscribers'],
      context.payload,
      pipelineCtx,
      'replace',
      codecRuntime,
    );
    const watcherIdMap = pipelineCtx.get('watcherIdMap');
    const subscriberIdMap = pipelineCtx.get('subscriberIdMap');

    // Teams + scheduled-epics codecs (matrix rows 13–14), after agents/profiles. The teams
    // codec owns override-merge + pruning + creation (with scoped partial-failure cleanup);
    // the scheduled-epics codec owns schedule creation. Both resolve refs through the
    // ImportContext maps the profiles/agents codecs wrote. `agentsPersisted` is marked by the
    // agents codec; `epicsLoaded` was seeded above.
    const teamSectionResults = await pipeline.applySections(
      ['teams', 'scheduledEpics'],
      context.payload,
      pipelineCtx,
      'replace',
      codecRuntime,
    );
    const teamsImported =
      (teamSectionResults.find((r) => r.section === 'teams')?.log?.teams as number | undefined) ??
      0;
    const scheduledEpicsImported =
      (teamSectionResults.find((r) => r.section === 'scheduledEpics')?.log?.scheduledEpics as
        | number
        | undefined) ?? 0;

    // Epic agent remap keys on agent name(lowercased) -> new id. The agents codec's
    // `agentNameToId` (Record) is content-identical to the legacy buildNameToIdMaps result
    // (both map name(lowercased) -> created id, last-occurrence wins); adapt it to a Map.
    const recreatedAgents = new Map(Object.entries(agentNameToId));
    const epicResult = input.snapshotEpicAssignments
      ? await restoreSnapshotEpicAssignments(
          input.projectId,
          input.snapshotEpicAssignments,
          recreatedAgents,
          deps.storage,
        )
      : await remapEpicAgentAssignments(
          input.projectId,
          oldAgentIdToName,
          recreatedAgents,
          deps.storage,
          previousEpicAssignments,
        );

    // projectSettings codec — owns the projectSettings + initialPrompt resolution. It reads
    // createdPrompts/promptIdMap (prompts) + templateLabelToStatusId (statuses) from the context.
    const settingsResults = await pipeline.applySections(
      ['projectSettings'],
      context.payload,
      pipelineCtx,
      'replace',
      codecRuntime,
    );
    const initialPromptSet =
      (settingsResults.find((r) => r.section === 'projectSettings')?.log?.initialPromptSet as
        | boolean
        | undefined) ?? false;

    // Template metadata recording is a post-sections lifecycle step (needs unifiedTemplateService
    // + an install timestamp); intentionally NOT a codec (see project-settings.codec header).
    await updateTemplateMetadata(input.projectId, context.payload, deps);

    await pipeline.applySections(
      ['presets'],
      context.payload,
      pipelineCtx,
      'replace',
      codecRuntime,
    );

    // Apply only after the presets codec has stored the target presets. The fresh maps constrain
    // lookup to the agents/configs created by this run; applyPresetWithHelper alone decides whether
    // the full-match rule is satisfied and activePreset may be set.
    if (context.preservationPlan) {
      await deps.settings.setProjectActivePreset(input.projectId, null);
    } else if (input.presetName) {
      await deps.applyPreset(
        input.projectId,
        input.presetName,
        {
          agentNameToId: new Map(Object.entries(agentNameToId)),
          configLookupMap: pipelineCtx.get('selectionEligibleConfigLookupMap'),
        },
        getPresetSkippedTeamNames(input.teamOverrides),
      );
    }

    // providerSettings + providerModels + providerEfforts + vaultAccess codecs (matrix
    // rows 19–22): no ImportContext products. providerSettings resolves against live
    // provider storage (threshold/env merge); the next two add model/effort catalogs;
    // vaultAccess runs last and is non-fatal — an absent section leaves access untouched.
    // Applied in registry order.
    await pipeline.applySections(
      ['providerSettings', 'providerModels', 'providerEfforts', 'vaultAccess'],
      context.payload,
      pipelineCtx,
      'replace',
      codecRuntime,
    );

    const result = buildImportSuccessResponse({
      payload: context.payload,
      existing: context.existing,
      statusIdMap,
      promptIdMap,
      profileIdMap,
      agentIdMap,
      watcherIdMap,
      subscriberIdMap,
      initialPromptSet,
      epicsTotal: epicResult.epicsTotal,
      epicsRemapped: epicResult.epicsRemapped,
      epicsCleared: epicResult.epicsCleared,
      profilesImported: context.preservationPlan
        ? context.selectedProfilesByFamily.profilesToCreate.length
        : context.payload.profiles.length,
      teamsImported,
      teamsDeleted: context.existingTeamCount,
      scheduledEpicsImported,
      sessionPreservation,
      statusesDeleted,
      promptTransfer: {
        ...appliedPrompts,
        ...clearedPrompts,
      },
    });
    return {
      ...result,
      ...(context.preservationPlan ? { preservationPlan: context.preservationPlan } : {}),
    };
  } catch (error) {
    logger.error({ error, projectId: input.projectId }, 'Import failed');
    const message = deps.getImportErrorMessage(error);
    throw new StorageError(message);
  }
}

async function prepareImportContext(
  input: ImportProjectInputLike,
  deps: ImportProjectDeps,
): Promise<ImportPreparation> {
  const isDryRun = input.dryRun ?? false;
  const promptTransferPolicy = input.promptTransferPolicy ?? PROMPT_TRANSFER_POLICY.Template;
  const template = ExportSchema.parse(input.payload ?? {});
  if (mixesPreserveTeamSetup(input)) {
    throw new ValidationError(PRESERVE_SETUP_EXCLUSIVE_MESSAGE);
  }
  if (input.preserveTeamSetup && promptTransferPolicy === PROMPT_TRANSFER_POLICY.Snapshot) {
    throw new ValidationError('Snapshot restore cannot use preserveTeamSetup');
  }
  if (input.snapshotEpicAssignments && promptTransferPolicy !== PROMPT_TRANSFER_POLICY.Snapshot) {
    throw new ValidationError('Epic assignment recovery requires Snapshot restore');
  }

  const preserved = input.preserveTeamSetup
    ? await preparePreservedRoster(input.projectId, template, input.preserveTeamSetup, deps)
    : undefined;
  let payload = preserved
    ? { ...template, profiles: preserved.roster.profiles, agents: preserved.roster.agents }
    : template;

  const referencedProviderNames = collectReferencedProviderNames(payload.profiles);
  const { installed, selected, missing } = await resolveProvidersFromStorage(
    deps.storage,
    referencedProviderNames,
    input.selectedProviderNames,
  );
  const familyResult = preserved
    ? computeFamilyAlternatives(
        payload.profiles,
        payload.agents,
        new Set(selected.keys()),
        logger,
        new Set(installed.keys()),
        preservedProfileDependencyIds(
          preserved.roster,
          preserved.current,
          preserved.choices,
          payload.watchers,
          selected,
        ),
      )
    : await deps.computeFamilyAlternatives(
        payload.profiles,
        payload.agents,
        input.selectedProviderNames,
      );

  const selectedPreset = input.presetName
    ? payload.presets.find((preset) => preset.name === input.presetName)
    : undefined;
  const presetCoverage = selectedPreset
    ? derivePresetProviderCoverage(
        payload.presets,
        payload.profiles,
        payload.agents,
        new Set(selected.keys()),
        { selectedPresetName: input.presetName },
      )[0]
    : undefined;
  const presetCoversAllAgents = presetCoverage?.coversAllAgents ?? false;

  const providerMappingRequired = hasUnresolvedFamilySelection(
    familyResult,
    input.familyProviderMappings,
    presetCoversAllAgents,
    !preserved,
  )
    ? buildProviderMappingRequired(familyResult)
    : null;

  // An installed but deselected provider can still supply options for persistence.
  const selectedProfilesByFamily = selectProfilesForFamilies(
    payload.profiles,
    payload.agents,
    input.familyProviderMappings,
    installed,
    preserved
      ? { familySelectionProviders: selected, requireInstalledOptions: true }
      : presetCoverage
        ? {
            presetCoveredAgentNames: presetCoverage.coveredAgentNames,
            presetAgentResolvedProviders: presetCoverage.agentResolvedProviders,
          }
        : undefined,
  );

  const preservation =
    preserved &&
    resolvePreservedRoster({
      roster: preserved.roster,
      current: preserved.current,
      choices: preserved.choices,
      selectedProfiles: selectedProfilesByFamily,
      familyAlternatives: familyResult.alternatives,
      installedProviders: installed,
      selectedProviders: selected,
    });
  if (preservation) {
    payload = {
      ...payload,
      profiles: selectedProfilesByFamily.profilesToCreate,
      agents: preservation.agents,
      teams: preservation.teams,
    };
  }

  const existing =
    preserved?.existing ?? (await loadExistingProjectData(input.projectId, deps.storage));
  const incomingPromptPartition = partitionPromptsForTransfer(
    payload.prompts,
    promptTransferPolicy,
  );
  const promptReferenceIssues =
    promptTransferPolicy === PROMPT_TRANSFER_POLICY.Template
      ? findSkippedTemplatePromptReferences(
          selectedProfilesByFamily.profilesToCreate,
          payload.prompts,
        )
      : [];
  const promptReplacementPlan = planPromptReplacement(
    payload.prompts,
    existing.prompts.items,
    promptTransferPolicy,
  );
  const unmatchedStatuses = await collectUnmatchedStatuses(
    payload.statuses,
    existing.statuses.items,
    deps.storage,
  );

  const activeSessions = getActiveSessions(input.projectId, deps);
  const unavailableSelectedProviderNames = (input.selectedProviderNames ?? []).filter(
    (name) => !installed.has(name.trim().toLowerCase()),
  );
  const unavailableSelectedProfiles = preserved
    ? []
    : getUnavailableSelectedProfileProviders(selectedProfilesByFamily, installed);
  const duplicateAgentNames = findDuplicateAgentNames(template.agents);
  const readiness = buildImportReadiness({
    promptReferenceIssues,
    unavailableSelectedProviderNames,
    presetName: input.presetName,
    presetFound: !input.presetName || Boolean(selectedPreset),
    providerMappingRequired,
    unavailableSelectedProfiles,
    activeSessions,
    duplicateAgentNames,
    preservationIssues: preservation
      ? [
          ...preservation.issues,
          ...checkPreservedReferences(payload, selectedProfilesByFamily.profileNameRemapMap),
        ]
      : [],
  });

  return {
    isDryRun,
    promptTransferPolicy,
    promptReferenceIssues,
    promptReplacementPlan,
    promptTransfer: {
      imported: incomingPromptPartition.transfer.length,
      deleted: promptReplacementPlan.deleteIds.length,
      preserved: promptReplacementPlan.preserveIds.length,
      skipped: incomingPromptPartition.retain.length,
    },
    payload,
    familyResult,
    providerMappingRequired,
    installedProviders: installed,
    selectedProviders: selected,
    missingProviders: preserved
      ? [...new Set(payload.profiles.flatMap(profileOptionProviderNames))].filter(
          (name) => !installed.has(name),
        )
      : missing,
    selectedProfilesByFamily,
    existing,
    unmatchedStatuses,
    readiness,
    preservationPlan: preservation?.review,
    existingTeamCount: preserved?.current.teams.length,
  };
}

async function preparePreservedRoster(
  projectId: string,
  template: ParsedTemplatePayload,
  choices: PreserveTeamSetup,
  deps: ImportProjectDeps,
) {
  const { storage, teamsService } = deps;
  if (!teamsService?.listTeams || !teamsService.getTeam) {
    throw new ValidationError('Current teams are unavailable for preservation');
  }
  const [existing, { items: teamSummaries }] = await Promise.all([
    loadExistingProjectData(projectId, storage),
    teamsService.listTeams(projectId, { limit: 10000 }),
  ]);
  const getTeam = teamsService.getTeam.bind(teamsService);
  const teams = await Promise.all(teamSummaries.map(({ id }) => getTeam(id)));
  const agents = existing.agents.items;
  const configIds = new Set([
    ...agents.map(({ providerConfigId }) => providerConfigId),
    ...teams.flatMap(
      (team) => team?.profileConfigSelections.flatMap(({ configIds }) => configIds) ?? [],
    ),
  ]);
  const configs = configIds.size
    ? await storage.listProfileProviderConfigsByIds([...configIds])
    : [];
  const current = {
    teams: teams.filter((team) => team !== null),
    agents,
    profiles: existing.profiles.items,
    configs,
  };
  return { existing, current, choices, roster: composePreservedRoster(template, current, choices) };
}

function checkPreservedReferences(
  payload: ParsedTemplatePayload,
  profileNameRemapMap: ReadonlyMap<string, string>,
): PreservationIssue[] {
  const agentNames = new Set(payload.agents.map(({ name }) => name.trim().toLowerCase()));
  const profileNames = new Set(payload.profiles.map(({ name }) => name.trim().toLowerCase()));
  const issues: PreservationIssue[] = [];
  const check = (
    section: 'watchers' | 'scheduledEpics',
    name: string,
    agentName: string | null | undefined,
  ) => {
    if (!agentName || agentNames.has(agentName.trim().toLowerCase())) return;
    issues.push({
      code: 'preserve_agent_reference',
      message: `"${name}" references "${agentName}", an agent outside the roster. Select the addition or update the template reference.`,
      details: { agentName, section, name },
    });
  };
  for (const watcher of payload.watchers) {
    if (watcher.scope === 'agent') check('watchers', watcher.name, watcher.scopeFilterName);
    if (watcher.scope !== 'profile') continue;
    const original = watcher.scopeFilterName?.trim().toLowerCase();
    const remap = original ? profileNameRemapMap.get(original) : undefined;
    if ((!original || !profileNames.has(original)) && (!remap || !profileNames.has(remap))) {
      issues.push({
        code: 'preserve_profile_reference',
        message: `Watcher "${watcher.name}" needs an available profile${watcher.scopeFilterName ? ` for "${watcher.scopeFilterName}"` : ''}. Select an eligible provider or update the watcher in the template.`,
        details: { watcherName: watcher.name, profileName: watcher.scopeFilterName ?? null },
      });
    }
  }
  for (const schedule of payload.scheduledEpics ?? []) {
    check('scheduledEpics', schedule.name, schedule.templateAgentName);
  }
  return issues;
}

async function loadExistingProjectData(
  projectId: string,
  storage: AgentProfileStorage &
    AgentStorage &
    PromptStorage &
    ScheduledEpicStorage &
    StatusStorage &
    SubscriberStorage &
    WatcherStorage,
) {
  const [prompts, profiles, agents, statuses, watchers, subscribers, scheduledEpics] =
    await Promise.all([
      storage.listPrompts({ projectId, limit: 10000, offset: 0 }),
      storage.listAgentProfiles({ projectId, limit: 10000, offset: 0 }),
      storage.listAgents(projectId, { limit: 10000, offset: 0 }),
      storage.listStatuses(projectId, { limit: 10000, offset: 0 }),
      storage.listWatchers(projectId),
      storage.listSubscribers(projectId),
      storage.listScheduledEpics(projectId, { limit: 10000 }),
    ]);

  return { prompts, profiles, agents, statuses, watchers, subscribers, scheduledEpics };
}

async function collectUnmatchedStatuses(
  templateStatuses: ParsedTemplatePayload['statuses'],
  existingStatuses: ExistingProjectData['statuses']['items'],
  storage: Pick<StorageService, 'countEpicsByStatus'>,
): Promise<UnmatchedStatus[]> {
  const templateStatusLabels = new Set(
    templateStatuses.map((status) => status.label.trim().toLowerCase()),
  );
  const unmatchedStatuses: UnmatchedStatus[] = [];

  for (const status of existingStatuses) {
    const labelKey = status.label.trim().toLowerCase();
    if (templateStatusLabels.has(labelKey)) {
      continue;
    }

    const epicCount = await storage.countEpicsByStatus(status.id);
    if (epicCount > 0) {
      unmatchedStatuses.push({
        id: status.id,
        label: status.label,
        color: status.color,
        epicCount,
      });
    }
  }

  return unmatchedStatuses;
}

function buildDryRunResponse(context: ImportPreparation) {
  const response: {
    dryRun: true;
    preservationPlan?: PreservationReview;
    success?: false;
    mutationStarted?: false;
    error?: string;
    readiness: ImportReadiness;
    promptReferenceValidation?: PromptReferenceValidationFailure['promptReferenceValidation'];
    missingProviders: string[];
    unmatchedStatuses: UnmatchedStatus[];
    templateStatuses: { label: string; color: string }[];
    providerMappingRequired?: {
      missingProviders: string[];
      familyAlternatives: FamilyAlternative[];
      canImport: boolean;
    };
    counts: {
      toImport: {
        prompts: number;
        profiles: number;
        agents: number;
        statuses: number;
        watchers: number;
        subscribers: number;
        scheduledEpics: number;
        teams?: number;
      };
      toDelete: {
        prompts: number;
        profiles: number;
        agents: number;
        statuses: number;
        watchers: number;
        subscribers: number;
        scheduledEpics: number;
        teams?: number;
      };
    };
    promptTransfer: PromptTransferCounts;
  } = {
    dryRun: true,
    ...(context.preservationPlan ? { preservationPlan: context.preservationPlan } : {}),
    readiness: context.readiness,
    missingProviders: context.missingProviders,
    unmatchedStatuses: context.unmatchedStatuses,
    templateStatuses: context.payload.statuses.map((status) => ({
      label: status.label,
      color: status.color,
    })),
    counts: {
      toImport: {
        prompts: context.promptTransfer.imported,
        profiles: context.selectedProfilesByFamily.profilesToCreate.length,
        agents: context.payload.agents.length,
        statuses: context.payload.statuses.length,
        watchers: context.payload.watchers.length,
        subscribers: context.payload.subscribers.length,
        scheduledEpics: context.payload.scheduledEpics?.length ?? 0,
        ...(context.preservationPlan ? { teams: context.payload.teams.length } : {}),
      },
      toDelete: {
        prompts: context.promptTransfer.deleted,
        profiles: context.existing.profiles.total,
        agents: context.existing.agents.total,
        statuses: context.unmatchedStatuses.length,
        watchers: context.existing.watchers.length,
        subscribers: context.existing.subscribers.length,
        scheduledEpics: context.existing.scheduledEpics?.total ?? 0,
        ...(context.existingTeamCount !== undefined ? { teams: context.existingTeamCount } : {}),
      },
    },
    promptTransfer: context.promptTransfer,
  };

  if (context.providerMappingRequired) {
    response.providerMappingRequired = context.providerMappingRequired;
  }
  if (!context.readiness.ready) {
    Object.assign(
      response,
      buildReadinessFailureProperties(context.readiness, context.providerMappingRequired),
    );
  }

  return response;
}

function buildProviderMappingRequired(familyResult: FamilyAlternativesResult) {
  return {
    missingProviders: familyResult.missingProviders,
    familyAlternatives: familyResult.alternatives,
    canImport: familyResult.canImport,
  };
}

function getUnavailableSelectedProfileProviders(
  selectedProfilesByFamily: SelectedProfilesByFamily,
  available: Map<string, string>,
): string[] {
  const selectedProviderNames = new Set(
    selectedProfilesByFamily.profilesToCreate.map((profile) =>
      profile.provider.name.trim().toLowerCase(),
    ),
  );

  return Array.from(selectedProviderNames).filter((name) => !available.has(name));
}

function hasUnresolvedFamilySelection(
  familyResult: FamilyAlternativesResult,
  mappings: Record<string, string> | undefined,
  presetCoversAllAgents: boolean,
  requireMappingForUnavailableDefault: boolean,
): boolean {
  if (presetCoversAllAgents) return false;
  if (!familyResult.canImport) return true;

  const alternativesByFamily = new Map(
    familyResult.alternatives.map((alternative) => [alternative.familySlug, alternative]),
  );

  for (const [familySlug, providerName] of Object.entries(mappings ?? {})) {
    const alternative = alternativesByFamily.get(familySlug);
    const normalizedProvider = providerName.trim().toLowerCase();
    if (!alternative || !alternative.availableProviders.includes(normalizedProvider)) {
      return true;
    }
  }

  if (!requireMappingForUnavailableDefault) return false;

  for (const alternative of familyResult.alternatives) {
    if (alternative.defaultProviderAvailable) continue;
    const mappedProvider = mappings?.[alternative.familySlug]?.trim().toLowerCase();
    if (!mappedProvider || !alternative.availableProviders.includes(mappedProvider)) {
      return true;
    }
  }

  return false;
}

function getActiveSessions(projectId: string, deps: ImportProjectDeps): ActiveSessionSummary[] {
  return deps.sessions.getActiveSessionsForProject(projectId).map((session) => ({
    id: session.id,
    agentId: session.agentId,
  }));
}

function buildImportReadiness(input: {
  promptReferenceIssues: PromptReferenceIssue[];
  unavailableSelectedProviderNames: string[];
  presetName?: string;
  presetFound: boolean;
  providerMappingRequired: ReturnType<typeof buildProviderMappingRequired> | null;
  unavailableSelectedProfiles: string[];
  activeSessions: ActiveSessionSummary[];
  duplicateAgentNames: string[];
  preservationIssues: PreservationIssue[];
}): ImportReadiness {
  const issues: ImportReadinessIssue[] = [];
  const promptFailure = buildPromptReferenceValidationFailure(input.promptReferenceIssues);
  if (promptFailure) {
    issues.push({
      code: 'prompt_reference_validation',
      message: promptFailure.error,
      details: promptFailure.promptReferenceValidation,
    });
  }
  if (input.unavailableSelectedProviderNames.length > 0) {
    issues.push({
      code: 'selected_providers_not_installed',
      message: `Selected providers are not installed: ${input.unavailableSelectedProviderNames.join(', ')}`,
      details: { providerNames: input.unavailableSelectedProviderNames },
    });
  }
  if (input.presetName && !input.presetFound) {
    issues.push({
      code: 'preset_not_found',
      message: `Selected preset "${input.presetName}" was not found in the template`,
      details: { presetName: input.presetName },
    });
  }
  if (input.providerMappingRequired) {
    issues.push({
      code: 'provider_mapping_required',
      message: input.providerMappingRequired.canImport
        ? 'Provider selection requires a complete family mapping'
        : 'Cannot import: some profile families have no available providers',
      details: input.providerMappingRequired,
    });
  }
  if (input.unavailableSelectedProfiles.length > 0) {
    issues.push({
      code: 'selected_profiles_unavailable',
      message: `Import requires unavailable providers: ${input.unavailableSelectedProfiles.join(', ')}`,
      details: { providerNames: input.unavailableSelectedProfiles },
    });
  }
  if (input.activeSessions.length > 0) {
    issues.push(buildActiveSessionIssue(input.activeSessions));
  }
  if (input.duplicateAgentNames.length > 0) {
    issues.push({
      code: 'duplicate_agent_names',
      message: 'Template has duplicate agent names',
      details: { agentNames: input.duplicateAgentNames },
    });
  }
  issues.push(...input.preservationIssues);
  return { ready: issues.length === 0, issues };
}

function buildActiveSessionIssue(activeSessions: ActiveSessionSummary[]): ImportReadinessIssue {
  return {
    code: 'active_sessions',
    message: 'Import aborted: active agent sessions detected',
    details: { activeSessions },
  };
}

export function buildActiveSessionReadiness(
  activeSessions: ActiveSessionSummary[],
): ImportReadiness {
  return { ready: false, issues: [buildActiveSessionIssue(activeSessions)] };
}

function buildReadinessFailure(
  readiness: ImportReadiness,
  providerMappingRequired: ReturnType<typeof buildProviderMappingRequired> | null,
  preservationPlan?: PreservationReview,
) {
  return {
    ...buildReadinessFailureProperties(readiness, providerMappingRequired),
    ...(preservationPlan ? { preservationPlan } : {}),
    readiness,
  };
}

function buildReadinessFailureProperties(
  readiness: ImportReadiness,
  providerMappingRequired: ReturnType<typeof buildProviderMappingRequired> | null,
) {
  const firstIssue = readiness.issues[0];
  const promptIssue = readiness.issues.find(
    (issue): issue is Extract<ImportReadinessIssue, { code: 'prompt_reference_validation' }> =>
      issue.code === 'prompt_reference_validation',
  );
  return {
    success: false as const,
    mutationStarted: false as const,
    error: firstIssue?.message ?? 'Import readiness check failed',
    ...(providerMappingRequired ? { providerMappingRequired } : {}),
    ...(promptIssue ? { promptReferenceValidation: promptIssue.details } : {}),
  };
}

function buildOldAgentIdToNameMap(existingAgents: ExistingProjectData['agents']['items']) {
  const oldAgentIdToName = new Map<string, string>();
  for (const agent of existingAgents) {
    oldAgentIdToName.set(agent.id, agent.name.trim().toLowerCase());
  }
  return oldAgentIdToName;
}

async function clearExistingProjectData(
  projectId: string,
  existing: ExistingProjectData,
  promptReplacementPlan: PromptReplacementPlan,
  deps: ImportProjectDeps,
): Promise<Pick<PromptTransferCounts, 'deleted' | 'preserved'>> {
  // Clean up teams before deleting agents to avoid FK RESTRICT errors on team leads
  if (deps.cleanupTeamsForProject) {
    await deps.cleanupTeamsForProject(projectId);
  }

  // Bulk template-import cleanup intentionally does NOT emit agent.deleted — this is internal
  // data replacement, not a user action. Per-agent broadcasts here would spam the UI during
  // import. If a user-visible reset event is ever needed, emit a single project-level event instead.
  for (const agent of existing.agents.items) {
    await deps.storage.deleteAgent(agent.id);
  }
  for (const profile of existing.profiles.items) {
    await deps.storage.deleteAgentProfile(profile.id);
  }
  for (const promptId of promptReplacementPlan.deleteIds) {
    await deps.storage.deletePrompt(promptId);
  }
  for (const watcher of existing.watchers) {
    await deps.watchersService.deleteWatcher(watcher.id);
  }
  for (const subscriber of existing.subscribers) {
    await deps.storage.deleteSubscriber(subscriber.id);
  }
  for (const schedule of existing.scheduledEpics.items) {
    await deps.storage.deleteScheduledEpic(schedule.id);
  }

  await deps.settings.updateSettings({
    projectId,
    initialSessionPromptId: null,
  });

  return {
    deleted: promptReplacementPlan.deleteIds.length,
    preserved: promptReplacementPlan.preserveIds.length,
  };
}

function listProjectEpics(
  projectId: string,
  storage: Pick<StorageService, 'listEpics'>,
): Promise<ProjectEpics> {
  return storage.listEpics(projectId, { limit: 100000, offset: 0 });
}

function captureEpicAgentAssignments(epics: ProjectEpics): Map<string, string> {
  return new Map(epics.items.flatMap(({ id, agentId }) => (agentId ? [[id, agentId]] : [])));
}

async function remapEpicAgentAssignments(
  projectId: string,
  oldAgentIdToName: Map<string, string>,
  agentNameToNewId: Map<string, string>,
  storage: Pick<StorageService, 'listEpics' | 'updateEpic'>,
  previousAssignments?: Map<string, string>,
) {
  const existingEpics = await listProjectEpics(projectId, storage);

  let epicsRemapped = 0;
  let epicsCleared = 0;

  for (const epic of existingEpics.items) {
    const previousAgentId = epic.agentId ?? previousAssignments?.get(epic.id);
    if (!previousAgentId) continue;

    const oldAgentName = oldAgentIdToName.get(previousAgentId);
    const newAgentId = oldAgentName ? agentNameToNewId.get(oldAgentName) : undefined;
    if (newAgentId) {
      await storage.updateEpic(epic.id, { agentId: newAgentId }, epic.version);
      epicsRemapped++;
    } else {
      if (epic.agentId) await storage.updateEpic(epic.id, { agentId: null }, epic.version);
      epicsCleared++;
    }
  }

  logger.info({ epicsRemapped, epicsCleared }, 'Epic agent references updated after import');

  return {
    epicsTotal: existingEpics.total,
    epicsRemapped,
    epicsCleared,
  };
}

async function updateTemplateMetadata(
  projectId: string,
  payload: ParsedTemplatePayload,
  deps: ImportProjectDeps,
) {
  if (!payload._manifest?.slug) {
    return;
  }

  let templateSource: 'bundled' | 'registry' = 'registry';
  try {
    deps.unifiedTemplateService.getBundledTemplate(payload._manifest.slug);
    templateSource = 'bundled';
  } catch {
    templateSource = 'registry';
  }

  await deps.settings.setProjectTemplateMetadata(projectId, {
    templateSlug: payload._manifest.slug,
    source: templateSource,
    installedVersion: payload._manifest.version ?? null,
    registryUrl: null,
    installedAt: new Date().toISOString(),
  });

  logger.info(
    { projectId, slug: payload._manifest.slug, source: templateSource },
    'Updated template metadata after import',
  );
}

function buildImportSuccessResponse(args: {
  payload: ParsedTemplatePayload;
  existing: ExistingProjectData;
  statusIdMap: Record<string, string>;
  promptIdMap: Record<string, string>;
  profileIdMap: Record<string, string>;
  agentIdMap: Record<string, string>;
  watcherIdMap: Record<string, string>;
  subscriberIdMap: Record<string, string>;
  initialPromptSet: boolean;
  epicsTotal: number;
  epicsRemapped: number;
  epicsCleared: number;
  profilesImported: number;
  teamsImported?: number;
  teamsDeleted?: number;
  scheduledEpicsImported?: number;
  sessionPreservation: { preservedCount: number; removedCount: number };
  statusesDeleted: number;
  promptTransfer: PromptTransferCounts;
}) {
  return {
    success: true,
    mode: 'replace',
    replaced: true,
    missingProviders: [],
    counts: {
      imported: {
        prompts: args.promptTransfer.imported,
        profiles: args.profilesImported,
        agents: args.payload.agents.length,
        statuses: args.payload.statuses.length,
        watchers: args.payload.watchers.length,
        subscribers: args.payload.subscribers.length,
        teams: args.teamsImported ?? 0,
        scheduledEpics: args.scheduledEpicsImported ?? 0,
      },
      deleted: {
        prompts: args.promptTransfer.deleted,
        profiles: args.existing.profiles.total,
        agents: args.existing.agents.total,
        statuses: args.statusesDeleted,
        ...(args.teamsDeleted !== undefined ? { teams: args.teamsDeleted } : {}),
        watchers: args.existing.watchers.length,
        subscribers: args.existing.subscribers.length,
        scheduledEpics: args.existing.scheduledEpics?.total ?? 0,
      },
      epics: {
        preserved: args.epicsTotal,
        agentRemapped: args.epicsRemapped,
        agentCleared: args.epicsCleared,
      },
    },
    promptTransfer: args.promptTransfer,
    mappings: {
      promptIdMap: args.promptIdMap,
      profileIdMap: args.profileIdMap,
      agentIdMap: args.agentIdMap,
      statusIdMap: args.statusIdMap,
      watcherIdMap: args.watcherIdMap,
      subscriberIdMap: args.subscriberIdMap,
    },
    initialPromptSet: args.initialPromptSet,
    sessionPreservation: args.sessionPreservation,
    message: 'Project configuration replaced. Epics preserved.',
  };
}

function getPromptApplyCounts(
  results: Awaited<ReturnType<TemplatePipeline['applySections']>>,
): Pick<PromptTransferCounts, 'imported' | 'skipped'> {
  return (
    results.find((result) => result.section === 'prompts')?.promptTransfer ?? {
      imported: 0,
      skipped: 0,
    }
  );
}
