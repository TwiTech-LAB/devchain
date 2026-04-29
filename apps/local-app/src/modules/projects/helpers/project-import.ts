import { ExportSchema } from '@devchain/shared';
import { ConflictError, StorageError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { ProbeOutcome } from '../../providers/utils/probe-1m';
import type { SettingsService } from '../../settings/services/settings.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { UnifiedTemplateService } from '../../registry/services/unified-template.service';
import {
  buildNameToIdMaps,
  buildPromptTitleToIdMap,
  buildProviderConfigLookupKey,
  extractTemplatePresets,
  mergeProjectSettingsWithInitialPrompt,
  resolveArchiveStatusId,
  resolveProvidersFromStorage,
  selectProfilesForFamilies,
  type FamilyAlternative,
  type FamilyAlternativesResult,
  type ProjectSettingsTemplateInput,
} from './profile-mapping.helpers';

const logger = createLogger('ProjectImport');

/**
 * Preserve env entries from an imported template, including redacted ones
 * (value === '***'). Keeping redacted keys lets the user see which secrets the
 * config expects so they can fill in real values after import — stripping them
 * silently was confusing because the var would just disappear from the UI.
 */
export function preserveImportedEnv(
  env: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!env) return null;
  return Object.keys(env).length > 0 ? env : null;
}

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

  try {
    const oldAgentIdToName = buildOldAgentIdToNameMap(context.existing.agents.items);

    await clearExistingProjectData(input.projectId, context.existing, deps);

    const { statusIdMap, templateLabelToStatusId } = await recreateStatuses(
      input.projectId,
      context.payload.statuses,
      context.existing.statuses.items,
      deps.storage,
    );

    await applyStatusMappings(input.statusMappings, templateLabelToStatusId, deps.storage);

    const { promptIdMap, createdPrompts } = await createImportedPrompts(
      input.projectId,
      context.payload.prompts,
      deps.storage,
    );

    const { profileIdMap } = await createImportedProfiles(
      input.projectId,
      context.selectedProfilesByFamily.profilesToCreate,
      deps.storage,
    );

    const configLookupMap = await createImportedProviderConfigs(
      context.selectedProfilesByFamily.profilesToCreate,
      profileIdMap,
      context.available,
      deps.storage,
    );

    const { agentIdMap } = await createImportedAgents(
      input.projectId,
      context.payload.agents,
      context.selectedProfilesByFamily.agentProfileMap,
      profileIdMap,
      configLookupMap,
      deps.storage,
    );

    const mappingResults = await importWatchersAndSubscribers(
      input.projectId,
      context.payload,
      context.selectedProfilesByFamily,
      { agentIdMap, profileIdMap },
      context.available,
      deps,
    );

    // Import teams (after agents and profiles are created)
    let teamsImported = 0;
    if (deps.teamsService && context.payload.teams && context.payload.teams.length > 0) {
      const teamsToImport = applyTeamOverrides(
        context.payload.teams,
        input.teamOverrides,
        context.selectedProfilesByFamily.profileNameRemapMap,
      );
      teamsImported = await createImportedTeams(input.projectId, teamsToImport, deps);
    }

    const epicResult = await remapEpicAgentAssignments(
      input.projectId,
      oldAgentIdToName,
      mappingResults.agentNameToId,
      deps.storage,
    );

    const initialPromptSet = await applyImportedProjectSettings(
      input.projectId,
      context.payload,
      createdPrompts,
      templateLabelToStatusId,
      deps,
    );

    await updateTemplateMetadata(input.projectId, context.payload, deps);
    await replaceProjectPresets(input.projectId, context.payload, deps.settings);
    await importProviderSettings(context.payload, deps.storage, { probe1m: deps.probe1m });
    const providerModelsImportResult = await importProviderModels(context.payload, deps.storage);
    logger.info(
      {
        added: providerModelsImportResult.added,
        existing: providerModelsImportResult.existing,
        providersSkipped: providerModelsImportResult.providersSkipped,
      },
      'Imported provider models from template',
    );

    return buildImportSuccessResponse({
      payload: context.payload,
      existing: context.existing,
      statusIdMap,
      promptIdMap,
      profileIdMap,
      agentIdMap,
      watcherIdMap: mappingResults.watcherIdMap,
      subscriberIdMap: mappingResults.subscriberIdMap,
      initialPromptSet,
      epicsTotal: epicResult.epicsTotal,
      epicsRemapped: epicResult.epicsRemapped,
      epicsCleared: epicResult.epicsCleared,
      teamsImported,
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

  const familyResult = await deps.computeFamilyAlternatives(payload.profiles, payload.agents);
  const needsMapping = familyResult.alternatives.some((alt) => !alt.defaultProviderAvailable);

  const providerNames = new Set(
    payload.profiles.map((profile) => profile.provider.name.trim().toLowerCase()),
  );
  const { available, missing: missingProviders } = await resolveProvidersFromStorage(
    deps.storage,
    providerNames,
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
  const [prompts, profiles, agents, statuses, watchers, subscribers] = await Promise.all([
    storage.listPrompts({ projectId, limit: 10000, offset: 0 }),
    storage.listAgentProfiles({ projectId, limit: 10000, offset: 0 }),
    storage.listAgents(projectId, { limit: 10000, offset: 0 }),
    storage.listStatuses(projectId, { limit: 10000, offset: 0 }),
    storage.listWatchers(projectId),
    storage.listSubscribers(projectId),
  ]);

  return { prompts, profiles, agents, statuses, watchers, subscribers };
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
      };
      toDelete: {
        prompts: number;
        profiles: number;
        agents: number;
        statuses: number;
        watchers: number;
        subscribers: number;
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
      },
      toDelete: {
        prompts: context.existing.prompts.total,
        profiles: context.existing.profiles.total,
        agents: context.existing.agents.total,
        statuses: context.existing.statuses.total,
        watchers: context.existing.watchers.length,
        subscribers: context.existing.subscribers.length,
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

  await deps.settings.updateSettings({
    projectId,
    initialSessionPromptId: null,
  });
}

async function recreateStatuses(
  projectId: string,
  templateStatuses: ParsedTemplatePayload['statuses'],
  existingStatuses: ExistingProjectData['statuses']['items'],
  storage: StorageService,
) {
  const statusIdMap: Record<string, string> = {};
  const existingStatusByLabel = new Map<string, ExistingProjectData['statuses']['items'][number]>();

  for (const status of existingStatuses) {
    existingStatusByLabel.set(status.label.trim().toLowerCase(), status);
  }

  const tempPositionOffset = 100000;
  for (const status of existingStatuses) {
    await storage.updateStatus(status.id, {
      position: status.position + tempPositionOffset,
    });
  }

  for (const status of templateStatuses.sort((a, b) => a.position - b.position)) {
    const labelKey = status.label.trim().toLowerCase();
    const existing = existingStatusByLabel.get(labelKey);

    if (existing) {
      const updated = await storage.updateStatus(existing.id, {
        color: status.color,
        position: status.position,
        mcpHidden: status.mcpHidden,
      });
      if (status.id) {
        statusIdMap[status.id] = updated.id;
      }
      existingStatusByLabel.delete(labelKey);
      continue;
    }

    const created = await storage.createStatus({
      projectId,
      label: status.label,
      color: status.color,
      position: status.position,
      mcpHidden: status.mcpHidden,
    });
    if (status.id) {
      statusIdMap[status.id] = created.id;
    }
  }

  const templateLabelToStatusId = new Map<string, string>();
  const allStatuses = await storage.listStatuses(projectId, {
    limit: 10000,
    offset: 0,
  });
  for (const status of allStatuses.items) {
    templateLabelToStatusId.set(status.label.trim().toLowerCase(), status.id);
  }

  return { statusIdMap, templateLabelToStatusId };
}

async function applyStatusMappings(
  statusMappings: ImportProjectInputLike['statusMappings'],
  templateLabelToStatusId: Map<string, string>,
  storage: StorageService,
) {
  if (!statusMappings || Object.keys(statusMappings).length === 0) {
    return;
  }

  let epicsMapped = 0;
  let statusesDeleted = 0;

  for (const [oldStatusId, targetLabel] of Object.entries(statusMappings)) {
    const targetStatusId = templateLabelToStatusId.get(targetLabel.trim().toLowerCase());
    if (!targetStatusId) {
      continue;
    }

    const remapped = await storage.updateEpicsStatus(oldStatusId, targetStatusId);
    epicsMapped += remapped;
    await storage.deleteStatus(oldStatusId);
    statusesDeleted++;
  }

  logger.info(
    { epicsMapped, statusesDeleted },
    'Applied status mappings: epics remapped and old statuses deleted',
  );
}

async function createImportedPrompts(
  projectId: string,
  prompts: ParsedTemplatePayload['prompts'],
  storage: StorageService,
) {
  const promptIdMap: Record<string, string> = {};
  const createdPrompts: Array<{ id: string; title: string }> = [];

  for (const prompt of prompts) {
    const created = await storage.createPrompt({
      projectId,
      title: prompt.title,
      content: prompt.content,
      tags: prompt.tags ?? [],
    });

    if (prompt.id) {
      promptIdMap[prompt.id] = created.id;
    }
    createdPrompts.push({ id: created.id, title: created.title });
  }

  return { promptIdMap, createdPrompts };
}

async function createImportedProfiles(
  projectId: string,
  profilesToCreate: SelectedProfilesByFamily['profilesToCreate'],
  storage: StorageService,
) {
  const profileIdMap: Record<string, string> = {};

  for (const profile of profilesToCreate) {
    const created = await storage.createAgentProfile({
      projectId,
      name: profile.name,
      familySlug: profile.familySlug ?? null,
      systemPrompt: null,
      instructions: profile.instructions ?? null,
      temperature: profile.temperature ?? null,
      maxTokens: profile.maxTokens ?? null,
    });

    const profileKey = profile.id || `name:${profile.name.trim().toLowerCase()}`;
    profileIdMap[profileKey] = created.id;
  }

  return { profileIdMap };
}

async function createImportedProviderConfigs(
  profilesToCreate: SelectedProfilesByFamily['profilesToCreate'],
  profileIdMap: Record<string, string>,
  available: Map<string, string>,
  storage: StorageService,
) {
  const configLookupMap = new Map<string, string>();

  for (const profile of profilesToCreate) {
    const profileKey = profile.id || `name:${profile.name.trim().toLowerCase()}`;
    const newProfileId = profileIdMap[profileKey];
    if (!newProfileId) {
      continue;
    }

    const providerConfigs = (
      profile as {
        providerConfigs?: Array<{
          name: string;
          providerName: string;
          description?: string | null;
          options?: string | null;
          env?: Record<string, string> | null;
        }>;
      }
    ).providerConfigs;

    if (providerConfigs && providerConfigs.length > 0) {
      for (const config of providerConfigs) {
        const providerId = available.get(config.providerName.trim().toLowerCase());
        if (!providerId) {
          logger.warn(
            { profileName: profile.name, providerName: config.providerName },
            'Provider not found for config, skipping',
          );
          continue;
        }

        const created = await storage.createProfileProviderConfig({
          profileId: newProfileId,
          providerId,
          name: config.name,
          description: config.description ?? null,
          options: config.options ?? null,
          env: preserveImportedEnv(config.env),
        });

        const lookupKey = buildProviderConfigLookupKey(newProfileId, config.name);
        configLookupMap.set(lookupKey, created.id);
      }
      continue;
    }

    const providerName = profile.provider.name.trim().toLowerCase();
    const providerId = available.get(providerName);
    if (!providerId) {
      continue;
    }

    const options =
      profile.options != null
        ? typeof profile.options === 'string'
          ? profile.options
          : JSON.stringify(profile.options)
        : null;

    const created = await storage.createProfileProviderConfig({
      profileId: newProfileId,
      providerId,
      name: 'default',
      options,
      env: null,
    });

    const lookupKey = buildProviderConfigLookupKey(newProfileId, 'default');
    configLookupMap.set(lookupKey, created.id);
  }

  return configLookupMap;
}

async function createImportedAgents(
  projectId: string,
  agents: ParsedTemplatePayload['agents'],
  agentProfileMap: SelectedProfilesByFamily['agentProfileMap'],
  profileIdMap: Record<string, string>,
  configLookupMap: Map<string, string>,
  storage: StorageService,
) {
  const agentIdMap: Record<string, string> = {};

  for (const agent of agents) {
    const remappedProfileId = agentProfileMap.get(agent.id ?? '');
    const oldProfileId = remappedProfileId ?? agent.profileId ?? '';
    const newProfileId = oldProfileId ? profileIdMap[oldProfileId] : undefined;

    if (!newProfileId) {
      throw new ValidationError(`Profile mapping missing for agent ${agent.name}`, {
        profileId: oldProfileId || null,
      });
    }

    const agentWithConfig = agent as { providerConfigName?: string | null };
    let providerConfigId: string | undefined;

    if (agentWithConfig.providerConfigName) {
      const lookupKey = buildProviderConfigLookupKey(
        newProfileId,
        agentWithConfig.providerConfigName,
      );
      providerConfigId = configLookupMap.get(lookupKey);
    }

    if (!providerConfigId) {
      const profilePrefix = `${newProfileId}:`;
      for (const [lookupKey, configId] of configLookupMap.entries()) {
        if (lookupKey.startsWith(profilePrefix)) {
          providerConfigId = configId;
          break;
        }
      }
    }

    if (!providerConfigId) {
      throw new ValidationError(`No provider config available for agent ${agent.name}`, {
        profileId: newProfileId,
        providerConfigName: agentWithConfig.providerConfigName || null,
      });
    }

    const created = await storage.createAgent({
      projectId,
      name: agent.name,
      profileId: newProfileId,
      description: agent.description ?? null,
      providerConfigId,
      modelOverride: agent.modelOverride ?? null,
    });

    const agentKey = agent.id || `name:${agent.name.trim().toLowerCase()}`;
    agentIdMap[agentKey] = created.id;
  }

  return { agentIdMap };
}

async function importWatchersAndSubscribers(
  projectId: string,
  payload: ParsedTemplatePayload,
  selectedProfilesByFamily: SelectedProfilesByFamily,
  entityMaps: {
    agentIdMap: Record<string, string>;
    profileIdMap: Record<string, string>;
  },
  available: Map<string, string>,
  deps: ImportProjectDeps,
) {
  const augmentedPayload = {
    agents: payload.agents.map((agent) => ({
      ...agent,
      id: agent.id || `name:${agent.name.trim().toLowerCase()}`,
    })),
    profiles: selectedProfilesByFamily.profilesToCreate.map((profile) => ({
      ...profile,
      id: profile.id || `name:${profile.name.trim().toLowerCase()}`,
    })),
  };

  const { agentNameToId, profileNameToId } = buildNameToIdMaps(
    augmentedPayload,
    entityMaps,
    logger,
  );

  const { watcherIdMap } = await deps.createWatchersFromPayload(projectId, payload.watchers, {
    agentNameToId,
    profileNameToId,
    providerNameToId: available,
    profileNameRemapMap: selectedProfilesByFamily.profileNameRemapMap,
  });

  const { subscriberIdMap } = await deps.createSubscribersFromPayload(
    projectId,
    payload.subscribers,
  );

  logger.info(
    {
      watchersCreated: payload.watchers.length,
      subscribersCreated: payload.subscribers.length,
    },
    'Watchers and subscribers imported',
  );

  return { agentNameToId, watcherIdMap, subscriberIdMap };
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

async function applyImportedProjectSettings(
  projectId: string,
  payload: ParsedTemplatePayload,
  createdPrompts: Array<{ id: string; title: string }>,
  templateLabelToStatusId: Map<string, string>,
  deps: ImportProjectDeps,
) {
  const mergedSettings = mergeProjectSettingsWithInitialPrompt(
    payload.prompts,
    payload.initialPrompt,
    payload.projectSettings,
  );

  const promptTitleToId = buildPromptTitleToIdMap(createdPrompts);
  const archiveStatusId = resolveArchiveStatusId(templateLabelToStatusId);

  const settingsResult = await deps.applyProjectSettings(
    projectId,
    mergedSettings,
    { promptTitleToId, statusLabelToId: templateLabelToStatusId },
    archiveStatusId,
  );

  return settingsResult.initialPromptSet;
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

async function replaceProjectPresets(
  projectId: string,
  payload: ParsedTemplatePayload,
  settings: SettingsService,
) {
  const templatePresets = extractTemplatePresets(payload as { presets?: unknown });

  if (templatePresets.length > 0) {
    await settings.setProjectPresets(projectId, templatePresets);
    logger.info(
      { projectId, presetCount: templatePresets.length },
      'Presets replaced from template during import',
    );
    return;
  }

  await settings.clearProjectPresets(projectId);
  logger.info({ projectId }, 'Presets cleared during import (template has none)');
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

async function importProviderModels(payload: ParsedTemplatePayload, storage: StorageService) {
  const providerModelsData = (
    payload as {
      providerModels?: Array<{ providerName: string; models: string[] }>;
    }
  ).providerModels;

  if (!providerModelsData || providerModelsData.length === 0) {
    return { added: 0, existing: 0, providersSkipped: 0 };
  }

  const allProviders = await storage.listProviders();
  const providersByName = new Map(
    allProviders.items.map((provider) => [provider.name.trim().toLowerCase(), provider]),
  );

  let totalAdded = 0;
  let totalExisting = 0;
  let providersSkipped = 0;

  for (const entry of providerModelsData) {
    const localProvider = providersByName.get(entry.providerName.trim().toLowerCase());
    if (!localProvider) {
      providersSkipped++;
      logger.debug(
        { providerName: entry.providerName },
        'Skipping providerModels import: no matching local provider',
      );
      continue;
    }

    if (entry.models.length === 0) {
      continue;
    }

    const result = await storage.bulkCreateProviderModels(localProvider.id, entry.models);
    totalAdded += result.added.length;
    totalExisting += result.existing.length;
  }

  return { added: totalAdded, existing: totalExisting, providersSkipped };
}

export function applyTeamOverrides(
  teams: Array<{
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
  overrides?: ImportProjectInputLike['teamOverrides'],
  profileNameRemapMap?: Map<string, string>,
): typeof teams {
  const hasOverrides = overrides && overrides.length > 0;
  if (!hasOverrides && !profileNameRemapMap) return teams;

  const remapName = (name: string): string =>
    profileNameRemapMap?.get(name.trim().toLowerCase()) ?? name;

  const overrideMap = new Map<
    string,
    NonNullable<ImportProjectInputLike['teamOverrides']>[number]
  >();
  if (hasOverrides) {
    for (const ov of overrides!) {
      overrideMap.set(ov.teamName.trim().toLowerCase(), ov);
    }
    for (const ov of overrides!) {
      if (!teams.some((t) => t.name.trim().toLowerCase() === ov.teamName.trim().toLowerCase())) {
        logger.warn({ teamName: ov.teamName }, 'teamOverrides references unknown team; skipping');
      }
    }
  }

  return teams.map((team) => {
    const override = overrideMap.get(team.name.trim().toLowerCase());

    // Mirror template-loader.ts: remap profile names from override when provided, otherwise
    // remap the template team's own names — both reference pre-substitution profile names.
    const finalProfileNames =
      override?.profileNames !== undefined
        ? override.profileNames.map(remapName)
        : team.profileNames?.map(remapName);

    const finalProfileSelections =
      override?.profileSelections !== undefined
        ? override.profileSelections.map((sel) => ({
            ...sel,
            profileName: remapName(sel.profileName),
          }))
        : team.profileSelections?.map((sel) => ({
            ...sel,
            profileName: remapName(sel.profileName),
          }));

    return {
      ...team,
      ...(override?.maxMembers !== undefined ? { maxMembers: override.maxMembers } : {}),
      ...(override?.maxConcurrentTasks !== undefined
        ? { maxConcurrentTasks: override.maxConcurrentTasks }
        : {}),
      ...(override?.allowTeamLeadCreateAgents !== undefined
        ? { allowTeamLeadCreateAgents: override.allowTeamLeadCreateAgents }
        : {}),
      ...(finalProfileNames !== undefined ? { profileNames: finalProfileNames } : {}),
      ...(finalProfileSelections !== undefined
        ? { profileSelections: finalProfileSelections }
        : {}),
    };
  });
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
      },
      deleted: {
        prompts: args.existing.prompts.total,
        profiles: args.existing.profiles.total,
        agents: args.existing.agents.total,
        statuses: 0,
        watchers: args.existing.watchers.length,
        subscribers: args.existing.subscribers.length,
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
    message: 'Project configuration replaced. Epics preserved.',
  };
}
