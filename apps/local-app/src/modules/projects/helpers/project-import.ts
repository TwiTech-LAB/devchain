import { ExportSchema } from '@devchain/shared';
import { ConflictError, StorageError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { ProbeOutcome } from '../../providers/utils/probe-1m';
import type { SettingsService } from '../../settings/services/settings.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { UnifiedTemplateService } from '../../registry/services/unified-template.service';
import {
  buildProviderConfigLookupKey,
  preserveImportedEnv,
  resolveProvidersFromStorage,
  selectProfilesForFamilies,
  type FamilyAlternative,
  type FamilyAlternativesResult,
  type ProjectSettingsTemplateInput,
} from './profile-mapping.helpers';
import {
  ensureNoDuplicateAgentNames,
  planAndApplySessionPreservation,
} from './project-import-sessions';
import type { PresetAgentConfig } from './project-presets.helpers';
import { ImportContext } from '../template-codec/import-context';
import { TemplatePipeline } from '../template-codec/template-pipeline';

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
type UnmatchedStatus = {
  id: string;
  label: string;
  color: string;
  epicCount: number;
};

type ImportPreparation = {
  isDryRun: boolean;
  payload: ParsedTemplatePayload;
  familyResult: FamilyAlternativesResult;
  needsMapping: boolean;
  available: Map<string, string>;
  missingProviders: string[];
  selectedProfilesByFamily: SelectedProfilesByFamily;
  existing: ExistingProjectData;
  unmatchedStatuses: UnmatchedStatus[];
};

export interface ImportProjectInputLike {
  projectId: string;
  payload: unknown;
  dryRun?: boolean;
  statusMappings?: Record<string, string>;
  familyProviderMappings?: Record<string, string>;
  /**
   * Wizard/API per-agent config overrides. NEW import capability: import previously applied no
   * per-agent configuration. Applied after the profiles+agents batch via `applyAgentConfigs`;
   * NEVER marks an active preset. Mutually exclusive with a preset selection (controller 400).
   */
  agentOverrides?: PresetAgentConfig[];
  /**
   * Transient, server-enforced provider allowlist (Step-1 wizard selection). When present
   * (validated non-empty + lowercased at the controller), providers outside it are treated as
   * uninstalled: excluded from family resolution AND from providerConfig creation, and reflected in
   * the dry-run counts/missingProviders. NOT persisted. Absent → byte-identical to today.
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
  storage: StorageService;
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
  probe1m?: (binPath: string) => Promise<ProbeOutcome>;
  teamsService?: {
    createTeam: (data: {
      projectId: string;
      name: string;
      description?: string | null;
      teamLeadAgentId?: string | null;
      maxMembers?: number;
      maxConcurrentTasks?: number;
      memberAgentIds: string[];
      profileIds?: string[];
      profileConfigSelections?: Array<{ profileId: string; configIds: string[] }>;
    }) => Promise<{ id: string }>;
    deleteTeamsByProject: (projectId: string) => Promise<void>;
    deleteTeamsByIds: (ids: string[]) => Promise<void>;
  };
  scheduledEpicsRefresh?: {
    refreshScheduleWindow: () => void;
  };
  computeNextRunAt?: (cronExpression: string, timezone: string) => Date | null;
}

export async function importProjectWithHelper(
  input: ImportProjectInputLike,
  deps: ImportProjectDeps,
) {
  logger.info({ projectId: input.projectId, dryRun: input.dryRun }, 'importProject');

  const context = await prepareImportContext(input, deps);

  if (context.isDryRun) {
    return buildDryRunResponse(context);
  }

  if (context.needsMapping && !input.familyProviderMappings) {
    return {
      success: false,
      providerMappingRequired: buildProviderMappingRequired(context.familyResult),
    };
  }

  ensureFamilyCanImport(context.familyResult);
  ensureSelectedProvidersAvailable(context.selectedProfilesByFamily, context.available);
  ensureNoActiveSessions(input.projectId, deps);
  ensureNoDuplicateAgentNames(context.payload.agents);

  try {
    const oldAgentIdToName = buildOldAgentIdToNameMap(context.existing.agents.items);

    const oldAgentIds = context.existing.agents.items.map((a) => a.id);
    const parkedByOldAgentId = await deps.storage.parkSessionsFromAgents(oldAgentIds);

    await clearExistingProjectData(input.projectId, context.existing, deps);

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
      settings: deps.settings,
      watchersService: watcherServiceForCodec,
      statusMappings: input.statusMappings,
      existingStatuses: context.existing.statuses.items,
      available: context.available,
      teamsService: deps.teamsService,
      teamOverrides: input.teamOverrides,
      probe1m: deps.probe1m,
      scheduledEpicsRefresh: deps.scheduledEpicsRefresh,
      computeNextRunAt: deps.computeNextRunAt,
    };
    await pipeline.applySections(
      ['statuses', 'prompts'],
      context.payload,
      pipelineCtx,
      'replace',
      codecRuntime,
    );
    const statusIdMap = pipelineCtx.get('statusIdMap');
    const promptIdMap = pipelineCtx.get('promptIdMap');

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

    // Per-agent config overrides (wizard/API) — a NEW import capability applied right after the
    // profiles+agents batch, while the freshly-created agents' name→id + config lookup maps are
    // in the ImportContext. It NEVER marks an active preset; the presets codec (batch-6 below)
    // still owns preset store/clear semantics unchanged. Unknown agent/config names surface as
    // warnings (not silent), mirroring preset apply.
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
    const epicResult = await remapEpicAgentAssignments(
      input.projectId,
      oldAgentIdToName,
      new Map(Object.entries(agentNameToId)),
      deps.storage,
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

    // presets codec — set-or-clear semantics (template WITH presets replaces; WITHOUT clears).
    await pipeline.applySections(
      ['presets'],
      context.payload,
      pipelineCtx,
      'replace',
      codecRuntime,
    );

    // providerSettings + providerModels + providerEfforts codecs (matrix rows 19–21):
    // additive provider-catalog mutations, no ImportContext products. providerSettings
    // resolves against live provider storage (threshold/probe/env matrix); the other two
    // add model/effort catalogs. Applied in registry order.
    await pipeline.applySections(
      ['providerSettings', 'providerModels', 'providerEfforts'],
      context.payload,
      pipelineCtx,
      'replace',
      codecRuntime,
    );

    return buildImportSuccessResponse({
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
      teamsImported,
      scheduledEpicsImported,
      sessionPreservation,
    });
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
  const payload = ExportSchema.parse(input.payload ?? {});

  const familyResult = await deps.computeFamilyAlternatives(
    payload.profiles,
    payload.agents,
    input.selectedProviderNames,
  );
  const needsMapping = familyResult.alternatives.some((alt) => !alt.defaultProviderAvailable);

  const providerNames = new Set(
    payload.profiles.map((profile) => profile.provider.name.trim().toLowerCase()),
  );
  const { available, missing: missingProviders } = await resolveProvidersFromStorage(
    deps.storage,
    providerNames,
    input.selectedProviderNames,
  );

  const selectedProfilesByFamily = selectProfilesForFamilies(
    payload.profiles,
    payload.agents,
    input.familyProviderMappings,
    available,
  );

  const existing = await loadExistingProjectData(input.projectId, deps.storage);
  const unmatchedStatuses = await collectUnmatchedStatuses(
    payload.statuses,
    existing.statuses.items,
    deps.storage,
  );

  return {
    isDryRun,
    payload,
    familyResult,
    needsMapping,
    available,
    missingProviders,
    selectedProfilesByFamily,
    existing,
    unmatchedStatuses,
  };
}

async function loadExistingProjectData(projectId: string, storage: StorageService) {
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
  storage: StorageService,
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
      };
      toDelete: {
        prompts: number;
        profiles: number;
        agents: number;
        statuses: number;
        watchers: number;
        subscribers: number;
        scheduledEpics: number;
      };
    };
  } = {
    dryRun: true,
    missingProviders: context.missingProviders,
    unmatchedStatuses: context.unmatchedStatuses,
    templateStatuses: context.payload.statuses.map((status) => ({
      label: status.label,
      color: status.color,
    })),
    counts: {
      toImport: {
        prompts: context.payload.prompts.length,
        profiles: context.selectedProfilesByFamily.profilesToCreate.length,
        agents: context.payload.agents.length,
        statuses: context.payload.statuses.length,
        watchers: context.payload.watchers.length,
        subscribers: context.payload.subscribers.length,
        scheduledEpics: context.payload.scheduledEpics?.length ?? 0,
      },
      toDelete: {
        prompts: context.existing.prompts.total,
        profiles: context.existing.profiles.total,
        agents: context.existing.agents.total,
        statuses: context.existing.statuses.total,
        watchers: context.existing.watchers.length,
        subscribers: context.existing.subscribers.length,
        scheduledEpics: context.existing.scheduledEpics?.total ?? 0,
      },
    },
  };

  if (context.needsMapping) {
    response.providerMappingRequired = buildProviderMappingRequired(context.familyResult);
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

function ensureFamilyCanImport(familyResult: FamilyAlternativesResult) {
  if (!familyResult.canImport) {
    throw new ValidationError('Cannot import: some profile families have no available providers', {
      hint: 'Install the required providers or use a different template',
      missingProviders: familyResult.missingProviders,
      familyAlternatives: familyResult.alternatives,
    });
  }
}

function ensureSelectedProvidersAvailable(
  selectedProfilesByFamily: SelectedProfilesByFamily,
  available: Map<string, string>,
) {
  const selectedProviderNames = new Set(
    selectedProfilesByFamily.profilesToCreate.map((profile) =>
      profile.provider.name.trim().toLowerCase(),
    ),
  );

  const unavailableSelectedProviders = Array.from(selectedProviderNames).filter(
    (name) => !available.has(name),
  );

  if (unavailableSelectedProviders.length > 0) {
    throw new ValidationError('Import aborted: missing providers', {
      missingProviders: unavailableSelectedProviders,
      hint: 'Install/configure providers by name before importing profiles.',
    });
  }
}

function ensureNoActiveSessions(projectId: string, deps: ImportProjectDeps) {
  const activeSessions = deps.sessions.getActiveSessionsForProject(projectId);
  if (activeSessions.length > 0) {
    throw new ConflictError('Import aborted: active agent sessions detected', {
      activeSessions: activeSessions.map((session) => ({
        id: session.id,
        agentId: session.agentId,
      })),
      hint: 'Terminate all running sessions for this project before importing.',
    });
  }
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
  deps: ImportProjectDeps,
) {
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
  for (const prompt of existing.prompts.items) {
    await deps.storage.deletePrompt(prompt.id);
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
}

async function remapEpicAgentAssignments(
  projectId: string,
  oldAgentIdToName: Map<string, string>,
  agentNameToNewId: Map<string, string>,
  storage: StorageService,
) {
  const existingEpics = await storage.listEpics(projectId, {
    limit: 100000,
    offset: 0,
  });

  let epicsRemapped = 0;
  let epicsCleared = 0;

  for (const epic of existingEpics.items) {
    if (!epic.agentId) {
      continue;
    }

    const oldAgentName = oldAgentIdToName.get(epic.agentId);
    if (oldAgentName) {
      const newAgentId = agentNameToNewId.get(oldAgentName);
      if (newAgentId) {
        await storage.updateEpic(epic.id, { agentId: newAgentId }, epic.version);
        epicsRemapped++;
      } else {
        await storage.updateEpic(epic.id, { agentId: null }, epic.version);
        epicsCleared++;
      }
      continue;
    }

    await storage.updateEpic(epic.id, { agentId: null }, epic.version);
    epicsCleared++;
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

export async function importProviderSettings(
  payload: ParsedTemplatePayload,
  storage: StorageService,
  options?: { probe1m?: (binPath: string) => Promise<ProbeOutcome> },
) {
  const importedProviderSettings = payload.providerSettings;

  if (!importedProviderSettings || importedProviderSettings.length === 0) {
    return;
  }

  const allProviders = await storage.listProviders();
  const providersByName = new Map(
    allProviders.items.map((provider) => [provider.name.trim().toLowerCase(), provider]),
  );

  for (const setting of importedProviderSettings) {
    const localProvider = providersByName.get(setting.name.trim().toLowerCase());
    if (!localProvider) {
      continue;
    }

    const updates: Record<string, unknown> = {};

    if (localProvider.autoCompactThreshold == null && setting.autoCompactThreshold != null) {
      updates.autoCompactThreshold = setting.autoCompactThreshold;
      logger.info(
        { providerName: setting.name, threshold: setting.autoCompactThreshold },
        'Applied autoCompactThreshold from template import',
      );
    } else if (localProvider.autoCompactThreshold != null) {
      logger.debug(
        { providerName: setting.name, existing: localProvider.autoCompactThreshold },
        'Skipping providerSettings import: local threshold already set',
      );
    }

    // Import autoCompactThreshold1m if present in template
    if (setting.autoCompactThreshold1m != null) {
      updates.autoCompactThreshold1m = setting.autoCompactThreshold1m;
    }

    // Import oneMillionContextEnabled: auto-probe when callback is available,
    // otherwise disable and set a safe threshold (95) to avoid degraded sessions.
    if (setting.oneMillionContextEnabled) {
      // Legacy compat: if template has 1M enabled but no autoCompactThreshold1m,
      // treat the old autoCompactThreshold as the 1M value
      const isLegacyTemplate = setting.autoCompactThreshold1m == null;

      if (localProvider.binPath && options?.probe1m) {
        const outcome = await options.probe1m(localProvider.binPath);
        if (outcome.supported) {
          updates.oneMillionContextEnabled = true;
          updates.autoCompactThreshold1m = isLegacyTemplate
            ? (setting.autoCompactThreshold ?? 50)
            : (setting.autoCompactThreshold1m ?? 50);
          // Only set standard threshold when local provider doesn't have one
          if (localProvider.autoCompactThreshold == null) {
            updates.autoCompactThreshold = isLegacyTemplate
              ? 95
              : (setting.autoCompactThreshold ?? 95);
          }
          logger.info(
            { providerName: setting.name },
            'Template had 1M context enabled — auto-probe confirmed support',
          );
        } else {
          updates.oneMillionContextEnabled = false;
          if (localProvider.autoCompactThreshold == null) {
            updates.autoCompactThreshold = 95;
          }
          updates.autoCompactThreshold1m = null;
          logger.info(
            { providerName: setting.name, status: outcome.status },
            'Template had 1M context enabled — auto-probe did not confirm support',
          );
        }
      } else {
        updates.oneMillionContextEnabled = false;
        if (localProvider.autoCompactThreshold == null) {
          updates.autoCompactThreshold = 95;
        }
        updates.autoCompactThreshold1m = null;
        logger.info(
          { providerName: setting.name },
          'Template had 1M context enabled — disabled during import (no binPath or probe unavailable)',
        );
      }
    }

    const importedEnv = preserveImportedEnv(setting.env);
    if (importedEnv) {
      if (localProvider.env == null) {
        updates.env = importedEnv;
        logger.info(
          { providerName: setting.name, keyCount: Object.keys(importedEnv).length },
          'Applied provider env from template import (no local env existed)',
        );
      } else {
        const merged = { ...localProvider.env };
        let addedCount = 0;
        for (const [key, value] of Object.entries(importedEnv)) {
          if (!(key in merged)) {
            merged[key] = value;
            addedCount++;
          }
        }
        if (addedCount > 0) {
          updates.env = merged;
          logger.info(
            { providerName: setting.name, addedCount },
            'Merged provider env from template import (local wins on conflicts)',
          );
        } else {
          logger.debug(
            { providerName: setting.name },
            'Skipping provider env import: all template keys already exist locally',
          );
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      await storage.updateProvider(localProvider.id, updates);
    }
  }
}

export async function createImportedTeams(
  projectId: string,
  exportedTeams: Array<{
    name: string;
    description?: string | null;
    teamLeadAgentName?: string | null;
    memberAgentNames: string[];
    maxMembers?: number;
    maxConcurrentTasks?: number;
    allowTeamLeadCreateAgents?: boolean;
    profileNames?: string[];
    profileSelections?: Array<{ profileName: string; configNames: string[] }>;
  }>,
  deps: ImportProjectDeps,
): Promise<number> {
  if (!deps.teamsService) return 0;

  // Build name→ID maps from the project's current agents and profiles
  const { items: agents } = await deps.storage.listAgents(projectId, { limit: 10000 });
  const agentNameToId = new Map<string, string>();
  for (const agent of agents) {
    agentNameToId.set(agent.name.trim().toLowerCase(), agent.id);
  }

  const { items: profiles } = await deps.storage.listAgentProfiles({ projectId });
  const profileNameToId = new Map<string, string>();
  for (const profile of profiles) {
    profileNameToId.set(profile.name.trim().toLowerCase(), profile.id);
  }

  const createdTeamIds: string[] = [];

  try {
    for (const exportedTeam of exportedTeams) {
      // Resolve member agent IDs
      const memberAgentIds: string[] = [];
      for (const memberName of exportedTeam.memberAgentNames) {
        const agentId = agentNameToId.get(memberName.trim().toLowerCase());
        if (!agentId) {
          throw new Error(
            `Team "${exportedTeam.name}" references agent "${memberName}" which was not found in the project`,
          );
        }
        memberAgentIds.push(agentId);
      }

      // Resolve team lead agent ID
      let teamLeadAgentId: string | null = null;
      if (exportedTeam.teamLeadAgentName) {
        teamLeadAgentId =
          agentNameToId.get(exportedTeam.teamLeadAgentName.trim().toLowerCase()) ?? null;
        if (!teamLeadAgentId) {
          throw new Error(
            `Team "${exportedTeam.name}" references team lead "${exportedTeam.teamLeadAgentName}" which was not found in the project`,
          );
        }
      }

      // Resolve profile IDs
      const profileIds: string[] = [];
      if (exportedTeam.profileNames) {
        for (const profileName of exportedTeam.profileNames) {
          const profileId = profileNameToId.get(profileName.trim().toLowerCase());
          if (!profileId) {
            throw new Error(
              `Team "${exportedTeam.name}" references profile "${profileName}" which was not found in the project`,
            );
          }
          profileIds.push(profileId);
        }
      }

      // Resolve profileSelections → profileConfigSelections (ID-based)
      let profileConfigSelections: Array<{ profileId: string; configIds: string[] }> | undefined;
      if (exportedTeam.profileSelections && exportedTeam.profileSelections.length > 0) {
        profileConfigSelections = [];
        for (const sel of exportedTeam.profileSelections) {
          const profileId = profileNameToId.get(sel.profileName.trim().toLowerCase());
          if (!profileId) {
            throw new Error(
              `Team "${exportedTeam.name}" references profile "${sel.profileName}" in profileSelections which was not found in the project`,
            );
          }
          const configs = await deps.storage.listProfileProviderConfigsByProfile(profileId);
          const configNameToId = new Map<string, string>();
          for (const c of configs) {
            configNameToId.set(c.name.trim().toLowerCase(), c.id);
          }
          const configIds: string[] = [];
          for (const configName of sel.configNames) {
            const configId = configNameToId.get(configName.trim().toLowerCase());
            if (!configId) {
              throw new Error(
                `Team "${exportedTeam.name}" references config "${configName}" for profile "${sel.profileName}" which was not found`,
              );
            }
            configIds.push(configId);
          }
          if (configIds.length > 0) {
            profileConfigSelections.push({ profileId, configIds });
          }
        }
      }

      const created = await deps.teamsService!.createTeam({
        projectId,
        name: exportedTeam.name,
        description: exportedTeam.description ?? null,
        teamLeadAgentId,
        memberAgentIds,
        ...(exportedTeam.maxMembers !== undefined ? { maxMembers: exportedTeam.maxMembers } : {}),
        ...(exportedTeam.maxConcurrentTasks !== undefined
          ? { maxConcurrentTasks: exportedTeam.maxConcurrentTasks }
          : {}),
        ...(exportedTeam.allowTeamLeadCreateAgents !== undefined
          ? { allowTeamLeadCreateAgents: exportedTeam.allowTeamLeadCreateAgents }
          : {}),
        profileIds,
        ...(profileConfigSelections ? { profileConfigSelections } : {}),
      });

      createdTeamIds.push(created.id);
    }

    return createdTeamIds.length;
  } catch (error) {
    // Team-scoped cleanup: delete any teams created in this run
    if (createdTeamIds.length > 0) {
      logger.warn(
        { createdTeamIds, error },
        'Teams import failed; cleaning up partially created teams',
      );
      try {
        await deps.teamsService!.deleteTeamsByIds(createdTeamIds);
      } catch (cleanupError) {
        logger.error({ cleanupError }, 'Failed to clean up partially imported teams');
      }
    }
    throw error;
  }
}

export function pruneUnavailableTeamProfileSelections<
  TTeam extends {
    name: string;
    profileNames?: string[];
    profileSelections?: Array<{ profileName: string; configNames: string[] }>;
  },
>(
  exportedTeams: TTeam[],
  profiles: Array<{
    id?: string;
    name: string;
    providerConfigs?: Array<{ name: string }>;
  }>,
  profileIdMap: Record<string, string>,
  configLookupMap: Map<string, string>,
): TTeam[] {
  const profileNameToNewId = new Map<string, string>();
  const knownConfigNamesByNewProfileId = new Map<string, Set<string>>();

  for (const profile of profiles) {
    if (!profile.id) continue;
    const newProfileId = profileIdMap[profile.id];
    if (!newProfileId) continue;

    profileNameToNewId.set(profile.name.trim().toLowerCase(), newProfileId);
    knownConfigNamesByNewProfileId.set(
      newProfileId,
      new Set((profile.providerConfigs ?? []).map((config) => config.name.trim().toLowerCase())),
    );
  }

  return exportedTeams.map((team) => {
    if (!team.profileSelections || team.profileSelections.length === 0) {
      return team;
    }

    const profileSelections: Array<{ profileName: string; configNames: string[] }> = [];
    const profilesWithNoAvailableConfigs = new Set<string>();
    for (const selection of team.profileSelections) {
      if (selection.configNames.length === 0) {
        profileSelections.push(selection);
        continue;
      }

      const newProfileId = profileNameToNewId.get(selection.profileName.trim().toLowerCase());
      if (!newProfileId) {
        profileSelections.push(selection);
        continue;
      }

      const knownConfigNames = knownConfigNamesByNewProfileId.get(newProfileId) ?? new Set();
      const availableConfigNames: string[] = [];
      for (const configName of selection.configNames) {
        const lookupKey = buildProviderConfigLookupKey(newProfileId, configName);
        if (configLookupMap.has(lookupKey)) {
          availableConfigNames.push(configName);
          continue;
        }

        if (knownConfigNames.has(configName.trim().toLowerCase())) {
          logger.warn(
            {
              teamName: team.name,
              profileName: selection.profileName,
              configName,
            },
            'Team profile config unavailable after provider filtering; skipping config',
          );
          continue;
        }

        availableConfigNames.push(configName);
      }

      if (availableConfigNames.length > 0) {
        profileSelections.push({ ...selection, configNames: availableConfigNames });
      } else {
        profilesWithNoAvailableConfigs.add(selection.profileName.trim().toLowerCase());
        logger.warn(
          {
            teamName: team.name,
            profileName: selection.profileName,
          },
          'Team profile selection has no available configs after provider filtering; skipping selection',
        );
      }
    }

    const profileNames =
      profilesWithNoAvailableConfigs.size > 0
        ? team.profileNames?.filter(
            (profileName) => !profilesWithNoAvailableConfigs.has(profileName.trim().toLowerCase()),
          )
        : team.profileNames;

    const nextTeam =
      profileNames !== team.profileNames
        ? ({
            ...team,
            ...(profileNames !== undefined ? { profileNames } : {}),
          } as TTeam)
        : team;

    if (profileSelections.length > 0) {
      return { ...nextTeam, profileSelections };
    }

    const { profileSelections: _profileSelections, ...teamWithoutSelections } = nextTeam;
    return teamWithoutSelections as TTeam;
  });
}

export type ScheduledEpicImportDeps = Pick<
  ImportProjectDeps,
  'storage' | 'scheduledEpicsRefresh' | 'computeNextRunAt'
>;

export async function createImportedScheduledEpics(
  projectId: string,
  scheduledEpics: ParsedTemplatePayload['scheduledEpics'],
  maps: {
    agentNameToId: Map<string, string>;
    statusLabelToId: Map<string, string>;
  },
  deps: ScheduledEpicImportDeps,
): Promise<number> {
  let created = 0;

  // Build epic title→id map for resolving templateParentEpicTitle
  const epicTitleToId = new Map<string, string>();
  const { items: existingEpics } = await deps.storage.listEpics(projectId, {
    limit: 100000,
    offset: 0,
  });
  for (const epic of existingEpics) {
    epicTitleToId.set(epic.title.trim().toLowerCase(), epic.id);
  }

  for (const schedule of scheduledEpics) {
    const templateStatusId = schedule.templateStatusLabel
      ? (maps.statusLabelToId.get(schedule.templateStatusLabel.trim().toLowerCase()) ?? null)
      : null;

    const templateAgentId = schedule.templateAgentName
      ? (maps.agentNameToId.get(schedule.templateAgentName.trim().toLowerCase()) ?? null)
      : null;

    const templateParentEpicId = schedule.templateParentEpicTitle
      ? (epicTitleToId.get(schedule.templateParentEpicTitle.trim().toLowerCase()) ?? null)
      : null;

    const nextRunAt = deps.computeNextRunAt
      ? deps.computeNextRunAt(schedule.cronExpression, schedule.timezone)
      : null;

    await deps.storage.createScheduledEpic({
      projectId,
      name: schedule.name,
      cronExpression: schedule.cronExpression,
      timezone: schedule.timezone,
      enabled: schedule.enabled,
      titleTemplate: schedule.titleTemplate,
      descriptionTemplate: schedule.descriptionTemplate ?? null,
      templateStatusId,
      templateParentEpicId,
      templateAgentId,
      templateTags: schedule.templateTags,
      allowOverlap: schedule.allowOverlap,
      missedRunPolicy: schedule.missedRunPolicy,
      nextRunAt: nextRunAt?.toISOString() ?? null,
    });

    created++;
  }

  if (created > 0 && deps.scheduledEpicsRefresh) {
    deps.scheduledEpicsRefresh.refreshScheduleWindow();
  }

  logger.info({ projectId, created }, 'Scheduled epics imported');
  return created;
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
  teamsImported?: number;
  scheduledEpicsImported?: number;
  sessionPreservation: { preservedCount: number; removedCount: number };
}) {
  return {
    success: true,
    mode: 'replace',
    replaced: true,
    missingProviders: [],
    counts: {
      imported: {
        prompts: args.payload.prompts.length,
        profiles: args.payload.profiles.length,
        agents: args.payload.agents.length,
        statuses: args.payload.statuses.length,
        watchers: args.payload.watchers.length,
        subscribers: args.payload.subscribers.length,
        teams: args.teamsImported ?? 0,
        scheduledEpics: args.scheduledEpicsImported ?? 0,
      },
      deleted: {
        prompts: args.existing.prompts.total,
        profiles: args.existing.profiles.total,
        agents: args.existing.agents.total,
        statuses: 0,
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
