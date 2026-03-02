import type { StorageService } from '../../storage/interfaces/storage.interface';

export interface FamilyAlternative {
  familySlug: string;
  defaultProvider: string;
  defaultProviderAvailable: boolean;
  availableProviders: string[];
  hasAlternatives: boolean;
}

export interface FamilyAlternativesResult {
  alternatives: FamilyAlternative[];
  missingProviders: string[];
  canImport: boolean;
}

export interface ProjectSettingsTemplateInput {
  initialPromptTitle?: string;
  autoCleanStatusLabels?: string[];
  epicAssignedTemplate?: string;
  messagePoolSettings?: {
    enabled?: boolean;
    delayMs?: number;
    maxWaitMs?: number;
    maxMessages?: number;
    separator?: string;
  };
}

interface LoggerLike {
  warn?: (obj: Record<string, unknown>, msg: string) => void;
}

type FamilyTemplateProfile = {
  id?: string;
  name: string;
  provider: { name: string };
  familySlug?: string | null;
  providerConfigs?: Array<{ name: string; providerName: string }>;
};

type FamilyTemplateAgent = {
  id?: string;
  name: string;
  profileId?: string;
  providerConfigName?: string | null;
};

type NamedEntity = {
  id?: string;
  name: string;
};

export async function resolveProvidersFromStorage(
  storage: Pick<StorageService, 'listProviders'>,
  providerNames: Set<string>,
): Promise<{
  available: Map<string, string>;
  missing: string[];
}> {
  const providers = await storage.listProviders();
  const available = new Map<string, string>();
  for (const prov of providers.items) {
    available.set(prov.name.trim().toLowerCase(), prov.id);
  }
  const missing = Array.from(providerNames).filter((name) => !available.has(name));
  return { available, missing };
}

export async function computeFamilyAlternativesFromStorage(
  storage: Pick<StorageService, 'listProviders'>,
  templateProfiles: FamilyTemplateProfile[],
  templateAgents: FamilyTemplateAgent[],
  logger?: LoggerLike,
): Promise<FamilyAlternativesResult> {
  const localProviders = await storage.listProviders();
  const availableProviderNames = new Set(
    localProviders.items.map((provider) => provider.name.trim().toLowerCase()),
  );
  return computeFamilyAlternatives(
    templateProfiles,
    templateAgents,
    availableProviderNames,
    logger,
  );
}

export function computeFamilyAlternatives(
  templateProfiles: FamilyTemplateProfile[],
  templateAgents: FamilyTemplateAgent[],
  availableProviderNames: Set<string>,
  logger?: LoggerLike,
): FamilyAlternativesResult {
  const profileById = new Map<string, FamilyTemplateProfile>();
  for (const prof of templateProfiles) {
    if (prof.id) {
      profileById.set(prof.id, prof);
    }
  }

  const usedFamilySlugs = new Set<string>();
  for (const agent of templateAgents) {
    if (!agent.profileId) continue;
    const profile = profileById.get(agent.profileId);
    if (profile?.familySlug) {
      usedFamilySlugs.add(profile.familySlug);
    }
  }

  const familyProviders = new Map<string, Map<string, string[]>>();
  for (const prof of templateProfiles) {
    if (!prof.familySlug) continue;

    if (!familyProviders.has(prof.familySlug)) {
      familyProviders.set(prof.familySlug, new Map());
    }

    const familyMap = familyProviders.get(prof.familySlug)!;
    const providerName = prof.provider.name.trim().toLowerCase();
    if (!familyMap.has(providerName)) {
      familyMap.set(providerName, []);
    }
    familyMap.get(providerName)!.push(prof.name);

    if (prof.providerConfigs) {
      for (const config of prof.providerConfigs) {
        const configProviderName = config.providerName.trim().toLowerCase();
        if (!familyMap.has(configProviderName)) {
          familyMap.set(configProviderName, []);
        }
        if (!familyMap.get(configProviderName)!.includes(prof.name)) {
          familyMap.get(configProviderName)!.push(prof.name);
        }
      }
    }
  }

  const alternatives: FamilyAlternative[] = [];
  const missingProviders = new Set<string>();
  let canImport = true;

  for (const familySlug of usedFamilySlugs) {
    const providersForFamily = familyProviders.get(familySlug);
    if (!providersForFamily || providersForFamily.size === 0) {
      logger?.warn?.({ familySlug }, 'Family used by agent has no profiles');
      continue;
    }

    const providerNamesForFamily = Array.from(providersForFamily.keys());
    const defaultProvider = providerNamesForFamily[0];
    const defaultProviderAvailable = availableProviderNames.has(defaultProvider);
    const availableForFamily = providerNamesForFamily.filter((name) =>
      availableProviderNames.has(name),
    );

    for (const providerName of providerNamesForFamily) {
      if (!availableProviderNames.has(providerName)) {
        missingProviders.add(providerName);
      }
    }

    const hasAlternatives = availableForFamily.length > 0;
    if (!hasAlternatives) {
      canImport = false;
    }

    alternatives.push({
      familySlug,
      defaultProvider,
      defaultProviderAvailable,
      availableProviders: availableForFamily.sort(),
      hasAlternatives,
    });
  }

  return {
    alternatives,
    missingProviders: Array.from(missingProviders).sort(),
    canImport,
  };
}

export function selectProfilesForFamilies<TProfile extends FamilyTemplateProfile>(
  templateProfiles: TProfile[],
  templateAgents: FamilyTemplateAgent[],
  familyProviderMappings: Record<string, string> | undefined,
  availableProviders: Map<string, string>,
  options?: {
    presetCoveredAgentNames?: Set<string>;
    /** Maps agent name (lowercase) → resolved provider name from the preset's providerConfig */
    presetAgentResolvedProviders?: Map<string, string>;
  },
): {
  profilesToCreate: TProfile[];
  agentProfileMap: Map<string, string | undefined>;
  profileNameRemapMap: Map<string, string>;
  /** Tracks profiles whose provider was substituted with a fallback provider */
  providerSubstitutions: Map<
    string,
    { originalProvider: string; substituteProvider: string; agentNames: string[] }
  >;
} {
  const profileById = new Map<string, TProfile>();
  for (const prof of templateProfiles) {
    if (prof.id) {
      profileById.set(prof.id, prof);
    }
  }

  // Resolve each template agent's providerConfigName against its profile's providerConfigs.
  // This gives us the actual provider each agent uses, independent of preset selection.
  const templateAgentResolvedProviders = new Map<string, string>();
  for (const agent of templateAgents) {
    if (!agent.providerConfigName || !agent.profileId) continue;
    const profile = profileById.get(agent.profileId);
    if (!profile?.providerConfigs) continue;
    const configName = agent.providerConfigName.trim().toLowerCase();
    const config = profile.providerConfigs.find(
      (pc) => pc.name.trim().toLowerCase() === configName,
    );
    if (config) {
      templateAgentResolvedProviders.set(
        agent.name.trim().toLowerCase(),
        config.providerName.trim().toLowerCase(),
      );
    }
  }

  const profilesByFamilyAndProvider = new Map<string, Map<string, TProfile>>();
  for (const prof of templateProfiles) {
    if (!prof.familySlug) continue;
    if (!profilesByFamilyAndProvider.has(prof.familySlug)) {
      profilesByFamilyAndProvider.set(prof.familySlug, new Map());
    }
    const providerName = prof.provider.name.trim().toLowerCase();
    const familyMap = profilesByFamilyAndProvider.get(prof.familySlug)!;
    if (!familyMap.has(providerName)) {
      familyMap.set(providerName, prof);
    }
  }

  const familyOriginalProviders = new Map<string, string>();
  for (const agent of templateAgents) {
    if (!agent.profileId) continue;
    const profile = profileById.get(agent.profileId);
    if (!profile?.familySlug) continue;
    familyOriginalProviders.set(profile.familySlug, profile.provider.name.trim().toLowerCase());
  }

  const selectedProfileIdsByFamily = new Map<string, string>();
  for (const [familySlug, providerMap] of profilesByFamilyAndProvider) {
    let selectedProvider: string | undefined;
    if (familyProviderMappings?.[familySlug]) {
      selectedProvider = familyProviderMappings[familySlug].trim().toLowerCase();
    } else {
      const originalProvider = familyOriginalProviders.get(familySlug);
      if (
        originalProvider &&
        availableProviders.has(originalProvider) &&
        providerMap.has(originalProvider)
      ) {
        selectedProvider = originalProvider;
      } else {
        for (const providerName of providerMap.keys()) {
          if (availableProviders.has(providerName)) {
            selectedProvider = providerName;
            break;
          }
        }
      }
    }

    if (selectedProvider && providerMap.has(selectedProvider)) {
      const profile = providerMap.get(selectedProvider)!;
      if (profile.id) {
        selectedProfileIdsByFamily.set(familySlug, profile.id);
      }
    }
  }

  // Include all profiles that agents reference. Profiles whose provider is available
  // are used as-is. Profiles whose provider is NOT available get assigned the first
  // available provider so the project can be created — the user must then reconfigure
  // the correct provider from /chat. We track these as warnings so the frontend can display a prompt.
  //
  // When presetCoveredAgentNames is provided, agents in that set are excluded from
  // substitution warnings (the preset will override their providerConfig post-creation).
  const coveredAgents = options?.presetCoveredAgentNames ?? new Set<string>();
  const profilesToCreate: TProfile[] = [];
  const usedProfileIds = new Set<string>();
  const providerSubstitutions = new Map<
    string,
    { originalProvider: string; substituteProvider: string; agentNames: string[] }
  >();
  const fallbackProviderName =
    availableProviders.size > 0 ? [...availableProviders.keys()][0] : undefined;

  // Collect which agents reference each profile (for warning context)
  const profileAgentNames = new Map<string, string[]>();
  for (const agent of templateAgents) {
    if (!agent.profileId) continue;
    const names = profileAgentNames.get(agent.profileId) ?? [];
    names.push(agent.name);
    profileAgentNames.set(agent.profileId, names);
  }

  for (const prof of templateProfiles) {
    if (!prof.id || usedProfileIds.has(prof.id)) continue;

    const providerName = prof.provider.name.trim().toLowerCase();

    if (availableProviders.has(providerName)) {
      // Provider is installed — always import as-is
      usedProfileIds.add(prof.id);
      profilesToCreate.push(prof);
    } else if (fallbackProviderName) {
      // Provider not installed — skip if the family already has a selected available profile
      if (prof.familySlug) {
        const selectedId = selectedProfileIdsByFamily.get(prof.familySlug);
        if (selectedId && selectedId !== prof.id) continue;
      }

      usedProfileIds.add(prof.id);

      // Only warn about agents NOT covered by the preset and whose template
      // providerConfig does not already resolve to an available provider.
      const allAgents = profileAgentNames.get(prof.id) ?? [];
      const uncoveredAgents = allAgents.filter((name) => {
        const agentKey = name.trim().toLowerCase();
        if (coveredAgents.has(agentKey)) return false;
        const templateResolved = templateAgentResolvedProviders.get(agentKey);
        if (templateResolved && availableProviders.has(templateResolved)) return false;
        return true;
      });
      if (uncoveredAgents.length > 0) {
        // Resolve the actual provider each agent needs for accurate warnings.
        // Priority: preset resolution > template providerConfigName resolution > profile default.
        const presetResolved = options?.presetAgentResolvedProviders;
        const agentsByMissingProvider = new Map<string, string[]>();
        for (const agentName of uncoveredAgents) {
          const agentKey = agentName.trim().toLowerCase();
          const missing =
            presetResolved?.get(agentKey) ??
            templateAgentResolvedProviders.get(agentKey) ??
            providerName;
          const list = agentsByMissingProvider.get(missing) ?? [];
          list.push(agentName);
          agentsByMissingProvider.set(missing, list);
        }
        for (const [missingProvider, agents] of agentsByMissingProvider) {
          const key =
            agentsByMissingProvider.size > 1 ? `${prof.name}:${missingProvider}` : prof.name;
          providerSubstitutions.set(key, {
            originalProvider: missingProvider,
            substituteProvider: fallbackProviderName,
            agentNames: agents,
          });
        }
      }

      profilesToCreate.push({
        ...prof,
        provider: { name: fallbackProviderName },
        options: null,
      });
    }
  }

  const agentProfileMap = new Map<string, string | undefined>();
  for (const agent of templateAgents) {
    if (!agent.id || !agent.profileId) continue;
    const originalProfile = profileById.get(agent.profileId);
    if (!originalProfile) {
      agentProfileMap.set(agent.id, agent.profileId);
      continue;
    }
    if (originalProfile.familySlug) {
      const selectedProfileId = selectedProfileIdsByFamily.get(originalProfile.familySlug);
      agentProfileMap.set(agent.id, selectedProfileId ?? agent.profileId);
    } else {
      agentProfileMap.set(agent.id, agent.profileId);
    }
  }

  const profileNameRemapMap = new Map<string, string>();
  for (const [familySlug, providerMap] of profilesByFamilyAndProvider) {
    const selectedProfileId = selectedProfileIdsByFamily.get(familySlug);
    const selectedProfile = selectedProfileId
      ? templateProfiles.find((profile) => profile.id === selectedProfileId)
      : undefined;
    if (!selectedProfile) continue;

    const selectedNameLower = selectedProfile.name.trim().toLowerCase();
    for (const profile of providerMap.values()) {
      const profileNameLower = profile.name.trim().toLowerCase();
      if (profileNameLower !== selectedNameLower) {
        profileNameRemapMap.set(profileNameLower, selectedNameLower);
      }
    }
  }

  return { profilesToCreate, agentProfileMap, profileNameRemapMap, providerSubstitutions };
}

export function buildNameToIdMaps(
  payload: {
    agents: NamedEntity[];
    profiles: NamedEntity[];
  },
  mappings: {
    agentIdMap: Record<string, string>;
    profileIdMap: Record<string, string>;
  },
  logger?: LoggerLike,
): {
  agentNameToId: Map<string, string>;
  profileNameToId: Map<string, string>;
} {
  const agentNameToId = new Map<string, string>();
  for (const agent of payload.agents) {
    if (!agent.id || !mappings.agentIdMap[agent.id]) continue;
    const nameLower = agent.name.trim().toLowerCase();
    if (agentNameToId.has(nameLower)) {
      logger?.warn?.(
        {
          name: agent.name,
          existingId: agentNameToId.get(nameLower),
          newId: mappings.agentIdMap[agent.id],
        },
        'Duplicate agent name detected, using last occurrence',
      );
    }
    agentNameToId.set(nameLower, mappings.agentIdMap[agent.id]);
  }

  const profileNameToId = new Map<string, string>();
  for (const profile of payload.profiles) {
    if (!profile.id || !mappings.profileIdMap[profile.id]) continue;
    const nameLower = profile.name.trim().toLowerCase();
    if (profileNameToId.has(nameLower)) {
      logger?.warn?.(
        {
          name: profile.name,
          existingId: profileNameToId.get(nameLower),
          newId: mappings.profileIdMap[profile.id],
        },
        'Duplicate profile name detected, using last occurrence',
      );
    }
    profileNameToId.set(nameLower, mappings.profileIdMap[profile.id]);
  }

  return { agentNameToId, profileNameToId };
}

export function buildProviderConfigLookupKey(profileId: string, configName: string): string {
  return `${profileId}:${configName.trim().toLowerCase()}`;
}

export function mergeProjectSettingsWithInitialPrompt(
  prompts: Array<{ id?: string; title: string }>,
  initialPrompt:
    | {
        title?: string | null;
        promptId?: string | null;
      }
    | null
    | undefined,
  projectSettings: ProjectSettingsTemplateInput | undefined,
): ProjectSettingsTemplateInput | undefined {
  let mergedInitialPromptTitle: string | undefined;

  if (initialPrompt?.title) {
    mergedInitialPromptTitle = initialPrompt.title;
  } else if (initialPrompt?.promptId) {
    const matchingPrompt = prompts.find((prompt) => prompt.id === initialPrompt.promptId);
    if (matchingPrompt) {
      mergedInitialPromptTitle = matchingPrompt.title;
    }
  } else if (projectSettings?.initialPromptTitle) {
    mergedInitialPromptTitle = projectSettings.initialPromptTitle;
  }

  if (projectSettings) {
    return {
      ...projectSettings,
      initialPromptTitle: mergedInitialPromptTitle,
    };
  }
  return mergedInitialPromptTitle ? { initialPromptTitle: mergedInitialPromptTitle } : undefined;
}

export function buildPromptTitleToIdMap(
  prompts: Array<{ id?: string; title: string }>,
  promptIdMap?: Record<string, string>,
): Map<string, string> {
  const promptTitleToId = new Map<string, string>();
  for (const prompt of prompts) {
    if (prompt.id) {
      const resolvedId = promptIdMap?.[prompt.id] ?? prompt.id;
      promptTitleToId.set(prompt.title.toLowerCase(), resolvedId);
    }
  }
  return promptTitleToId;
}

export function buildStatusLabelToIdMap(
  statuses: Array<{ id?: string; label: string }>,
  statusIdMap: Record<string, string>,
): Map<string, string> {
  const statusLabelToId = new Map<string, string>();
  for (const status of statuses) {
    if (status.id && statusIdMap[status.id]) {
      statusLabelToId.set(status.label.toLowerCase(), statusIdMap[status.id]);
    }
  }
  return statusLabelToId;
}

export function resolveArchiveStatusId(statusLabelToId: Map<string, string>): string | null {
  return statusLabelToId.get('archive') ?? null;
}

export function extractTemplatePresets(payload: { presets?: unknown }): unknown[] {
  return Array.isArray(payload.presets) ? payload.presets : [];
}

export function hasPresetName(preset: unknown, presetName: string): boolean {
  return (
    typeof preset === 'object' && preset !== null && 'name' in preset && preset.name === presetName
  );
}

export function resolveExportPresets<T>(
  presetsOverride: T[] | undefined,
  storedPresets: T[],
): T[] | undefined {
  if (presetsOverride !== undefined) {
    return presetsOverride;
  }
  return storedPresets.length > 0 ? storedPresets : undefined;
}
