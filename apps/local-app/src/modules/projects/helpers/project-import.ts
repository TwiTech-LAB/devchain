import { ExportSchema } from '@devchain/shared';
import { ConflictError, StorageError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
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
    await importProviderSettings(context.payload, deps.storage);
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
          options: config.options ?? null,
          env: config.env ?? null,
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

async function importProviderSettings(payload: ParsedTemplatePayload, storage: StorageService) {
  const importedProviderSettings = (
    payload as {
      providerSettings?: Array<{ name: string; autoCompactThreshold?: number | null }>;
    }
  ).providerSettings;

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

    if (localProvider.autoCompactThreshold != null) {
      logger.debug(
        { providerName: setting.name, existing: localProvider.autoCompactThreshold },
        'Skipping providerSettings import: local threshold already set',
      );
      continue;
    }

    if (setting.autoCompactThreshold != null) {
      await storage.updateProvider(localProvider.id, {
        autoCompactThreshold: setting.autoCompactThreshold,
      });
      logger.info(
        { providerName: setting.name, threshold: setting.autoCompactThreshold },
        'Applied autoCompactThreshold from template import',
      );
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
