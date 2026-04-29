import { ExportSchema } from '@devchain/shared';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type {
  StorageService,
  TemplateImportPayload,
} from '../../storage/interfaces/storage.interface';
import type { SettingsService } from '../../settings/services/settings.service';
import type { UnifiedTemplateService } from '../../registry/services/unified-template.service';
import {
  buildNameToIdMaps,
  buildPromptTitleToIdMap,
  buildProviderConfigLookupKey,
  buildStatusLabelToIdMap,
  extractTemplatePresets,
  hasPresetName,
  mergeProjectSettingsWithInitialPrompt,
  resolveArchiveStatusId,
  resolveProvidersFromStorage,
  selectProfilesForFamilies,
  type FamilyAlternativesResult,
  type ProjectSettingsTemplateInput,
} from './profile-mapping.helpers';
import type { ProbeOutcome } from '../../providers/utils/probe-1m';
import { importProviderSettings, createImportedTeams, preserveImportedEnv } from './project-import';
import type { TeamsService } from '../../teams/services/teams.service';

const logger = createLogger('TemplateLoader');

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
  probe1m?: (binPath: string) => Promise<ProbeOutcome>;
  teamsService?: TeamsService;
}

type FamilyMappingResolution =
  | {
      success: true;
      payload: ParsedTemplatePayload;
      templateSlug: string;
      templateResult: Awaited<ReturnType<UnifiedTemplateService['getTemplate']>>;
      available: Map<string, string>;
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

  // When a preset is selected, resolve which agents are fully covered by it.
  // Walk preset agentConfig → template agent → profileId → profile.providerConfigs
  // to determine the actual provider each agent will use.
  const presetCoveredAgentNames = new Set<string>();
  const presetAgentResolvedProviders = new Map<string, string>();
  let presetCoversAllAgents = false;
  if (input.presetName) {
    const selectedPreset = (payload.presets ?? []).find(
      (p: { name: string }) => p.name === input.presetName,
    );
    if (selectedPreset) {
      const profileConfigsByProfileId = new Map<string, Map<string, string>>();
      for (const prof of payload.profiles ?? []) {
        if (!prof.id) continue;
        const providerConfigs = (
          prof as { providerConfigs?: Array<{ name: string; providerName: string }> }
        ).providerConfigs;
        if (providerConfigs) {
          const configMap = new Map<string, string>();
          for (const pc of providerConfigs) {
            configMap.set(pc.name.trim().toLowerCase(), pc.providerName.trim().toLowerCase());
          }
          profileConfigsByProfileId.set(prof.id, configMap);
        }
      }

      const agentNameToProfileId = new Map<string, string>();
      for (const agent of payload.agents ?? []) {
        if (agent.profileId) {
          agentNameToProfileId.set(agent.name.trim().toLowerCase(), agent.profileId);
        }
      }

      const localProviders = await deps.storage.listProviders();
      const localProviderNames = new Set(
        localProviders.items.map((p) => p.name.trim().toLowerCase()),
      );

      let allCovered = true;
      for (const ac of selectedPreset.agentConfigs) {
        const agentKey = ac.agentName.trim().toLowerCase();
        const profileId = agentNameToProfileId.get(agentKey);
        if (!profileId) {
          allCovered = false;
          continue;
        }
        const configMap = profileConfigsByProfileId.get(profileId);
        const providerName = configMap?.get(ac.providerConfigName.trim().toLowerCase());
        if (providerName) {
          presetAgentResolvedProviders.set(agentKey, providerName);
        }
        if (providerName && localProviderNames.has(providerName)) {
          presetCoveredAgentNames.add(agentKey);
        } else {
          allCovered = false;
        }
      }

      const allTemplateAgentNames = new Set(
        (payload.agents ?? []).map((a) => a.name.trim().toLowerCase()),
      );
      presetCoversAllAgents =
        allCovered && [...allTemplateAgentNames].every((n) => presetCoveredAgentNames.has(n));

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
    available,
    selectedProfilesByFamily,
    payload: resolvedPayload,
    templateResult: resolvedTemplateResult,
    templateSlug: resolvedTemplateSlug,
  } = mappingResolution;

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

  const templatePayload = buildTemplateImportPayload(
    resolvedPayload,
    selectedProfilesByFamily,
    available,
    deps.normalizeProfileOptions,
  );
  const result = await createProjectWithTemplate(input, templatePayload, deps.storage);

  const { agentNameToId: agentNameToNewId, profileNameToId: profileNameToNewId } =
    buildNameToIdMaps(templatePayload, result.mappings, logger);

  const configLookupMap = await createProviderConfigsAndAgentAssignments(
    resolvedPayload,
    selectedProfilesByFamily,
    available,
    result.mappings,
    deps.storage,
  );

  // Seed teams from template (after agents + configs exist)
  if (deps.teamsService && resolvedPayload.teams && resolvedPayload.teams.length > 0) {
    const overrideMap = new Map<
      string,
      NonNullable<CreateFromTemplateInputLike['teamOverrides']>[number]
    >();
    if (input.teamOverrides) {
      for (const ov of input.teamOverrides) {
        overrideMap.set(ov.teamName.trim().toLowerCase(), ov);
      }
    }

    const remapProfileName = (pn: string): string => {
      const remapped = selectedProfilesByFamily.profileNameRemapMap.get(pn.trim().toLowerCase());
      return remapped
        ? (resolvedPayload.profiles.find((p) => p.name.trim().toLowerCase() === remapped)?.name ??
            pn)
        : pn;
    };

    const remappedTeams = resolvedPayload.teams.map((team) => {
      const override = overrideMap.get(team.name.trim().toLowerCase());

      const mergedProfileSelections = override?.profileSelections
        ? override.profileSelections.map((sel) => ({
            ...sel,
            profileName: remapProfileName(sel.profileName),
          }))
        : team.profileSelections?.map((sel) => ({
            ...sel,
            profileName: remapProfileName(sel.profileName),
          }));

      const finalProfileNames =
        override?.profileNames !== undefined
          ? override.profileNames.map(remapProfileName)
          : team.profileNames?.map(remapProfileName);

      return {
        ...team,
        ...(override?.maxMembers !== undefined ? { maxMembers: override.maxMembers } : {}),
        ...(override?.maxConcurrentTasks !== undefined
          ? { maxConcurrentTasks: override.maxConcurrentTasks }
          : {}),
        ...(override?.allowTeamLeadCreateAgents !== undefined
          ? { allowTeamLeadCreateAgents: override.allowTeamLeadCreateAgents }
          : {}),
        profileNames: finalProfileNames,
        profileSelections: mergedProfileSelections,
      };
    });

    if (input.teamOverrides) {
      for (const ov of input.teamOverrides) {
        if (
          !resolvedPayload.teams.some(
            (t) => t.name.trim().toLowerCase() === ov.teamName.trim().toLowerCase(),
          )
        ) {
          logger.warn({ teamName: ov.teamName }, 'teamOverrides references unknown team; skipping');
        }
      }
    }

    try {
      await createImportedTeams(result.project.id, remappedTeams, {
        storage: deps.storage,
        teamsService: deps.teamsService,
      } as unknown as Parameters<typeof createImportedTeams>[2]);
    } catch (error) {
      logger.error({ error }, 'Failed to seed teams from template (non-fatal)');
    }
  }

  const mergedSettings = mergeProjectSettingsWithInitialPrompt(
    resolvedPayload.prompts,
    resolvedPayload.initialPrompt,
    resolvedPayload.projectSettings,
  );
  const promptTitleToId = buildPromptTitleToIdMap(
    resolvedPayload.prompts,
    result.mappings.promptIdMap,
  );
  const statusLabelToId = buildStatusLabelToIdMap(
    templatePayload.statuses,
    result.mappings.statusIdMap,
  );
  const archiveStatusId = resolveArchiveStatusId(statusLabelToId);

  const settingsResult = await deps.applyProjectSettings(
    result.project.id,
    mergedSettings,
    { promptTitleToId, statusLabelToId },
    archiveStatusId,
  );

  const { created: watchersCreated } = await deps.createWatchersFromPayload(
    result.project.id,
    resolvedPayload.watchers,
    {
      agentNameToId: agentNameToNewId,
      profileNameToId: profileNameToNewId,
      providerNameToId: available,
      profileNameRemapMap: selectedProfilesByFamily.profileNameRemapMap,
    },
  );

  const { created: subscribersCreated } = await deps.createSubscribersFromPayload(
    result.project.id,
    resolvedPayload.subscribers,
  );

  await importProviderSettings(resolvedPayload, deps.storage, { probe1m: deps.probe1m });

  await applyTemplateMetadata(
    result.project.id,
    resolvedPayload,
    resolvedTemplateSlug,
    resolvedTemplateResult,
    deps.settings,
  );

  const templatePresets = extractTemplatePresets(resolvedPayload as { presets?: unknown });
  if (templatePresets.length > 0) {
    await deps.settings.setProjectPresets(result.project.id, templatePresets);
    logger.info(
      { projectId: result.project.id, presetCount: templatePresets.length },
      'Presets stored for project',
    );
  }

  const presetName = input.presetName;
  if (presetName) {
    const selectedPreset = templatePresets.find((preset) => hasPresetName(preset, presetName));
    if (!selectedPreset) {
      logger.warn(
        { projectId: result.project.id, presetName },
        'Selected preset not found in template',
      );
    } else {
      await deps.applyPreset(result.project.id, presetName, {
        agentNameToId: agentNameToNewId,
        configLookupMap,
      });
      logger.info({ projectId: result.project.id, presetName }, 'Applied preset to project');
    }
  }

  return {
    success: true,
    project: result.project,
    imported: {
      ...result.imported,
      watchers: watchersCreated,
      subscribers: subscribersCreated,
    },
    mappings: result.mappings,
    initialPromptSet: settingsResult.initialPromptSet,
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
  const familyResult = await deps.computeFamilyAlternatives(payload.profiles, payload.agents);
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

  const providerNames = new Set(
    payload.profiles.map((profile) => profile.provider.name.trim().toLowerCase()),
  );
  const { available } = await resolveProvidersFromStorage(deps.storage, providerNames);

  // Fail-fast if no providers are installed but template requires profiles
  if (available.size === 0 && payload.profiles.length > 0) {
    throw new ValidationError(
      'No providers are installed. At least one provider is required to create a project from a template.',
    );
  }

  const selectedProfilesByFamily = selectProfilesForFamilies(
    payload.profiles,
    payload.agents,
    effectiveFamilyProviderMappings,
    available,
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
    available,
    selectedProfilesByFamily,
  };
}

function buildTemplateImportPayload(
  payload: ParsedTemplatePayload,
  selectedProfilesByFamily: ReturnType<
    typeof selectProfilesForFamilies<ParsedTemplatePayload['profiles'][number]>
  >,
  available: Map<string, string>,
  normalizeProfileOptions: (options: unknown) => string | null,
): TemplateImportPayload {
  return {
    prompts: payload.prompts.map((prompt) => ({
      id: prompt.id,
      title: prompt.title,
      content: prompt.content,
      version: prompt.version,
      tags: prompt.tags,
    })),
    profiles: selectedProfilesByFamily.profilesToCreate.map((profile) => {
      const providerId = available.get(profile.provider.name.trim().toLowerCase());
      if (!providerId) {
        throw new NotFoundError('Provider', profile.provider.name);
      }
      return {
        id: profile.id,
        name: profile.name,
        providerId,
        familySlug: profile.familySlug ?? null,
        options: normalizeProfileOptions(profile.options),
        instructions: profile.instructions ?? null,
        temperature: profile.temperature ?? null,
        maxTokens: profile.maxTokens ?? null,
      };
    }),
    agents: payload.agents.map((agent) => {
      const remappedProfileId =
        selectedProfilesByFamily.agentProfileMap.get(agent.id ?? '') ?? agent.profileId;
      return {
        id: agent.id,
        name: agent.name,
        profileId: remappedProfileId,
        description: agent.description,
        modelOverride: agent.modelOverride ?? null,
      };
    }),
    statuses: payload.statuses.map((status) => ({
      id: status.id,
      label: status.label,
      color: status.color,
      position: status.position,
      mcpHidden: status.mcpHidden,
    })),
    initialPrompt: payload.initialPrompt,
  };
}

async function createProjectWithTemplate(
  input: CreateFromTemplateInputLike,
  templatePayload: TemplateImportPayload,
  storage: StorageService,
) {
  const projectInput = {
    name: input.name,
    description: input.description ?? null,
    rootPath: input.rootPath,
    isTemplate: false,
  };
  if (input.projectId) {
    return storage.createProjectWithTemplate(projectInput, templatePayload, {
      projectId: input.projectId,
    });
  }
  return storage.createProjectWithTemplate(projectInput, templatePayload);
}

async function createProviderConfigsAndAgentAssignments(
  payload: ParsedTemplatePayload,
  selectedProfilesByFamily: ReturnType<
    typeof selectProfilesForFamilies<ParsedTemplatePayload['profiles'][number]>
  >,
  available: Map<string, string>,
  mappings: {
    profileIdMap: Record<string, string>;
    agentIdMap: Record<string, string>;
  },
  storage: StorageService,
): Promise<Map<string, string>> {
  const configLookupMap = new Map<string, string>();

  for (const profile of selectedProfilesByFamily.profilesToCreate) {
    if (!profile.id) continue;
    const newProfileId = mappings.profileIdMap[profile.id];
    if (!newProfileId) continue;

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

    if (!providerConfigs || providerConfigs.length === 0) continue;

    for (const config of providerConfigs) {
      const configProviderId = available.get(config.providerName.trim().toLowerCase());
      if (!configProviderId) {
        logger.warn(
          { profileName: profile.name, providerName: config.providerName },
          'Provider not found for config in createFromTemplate, skipping',
        );
        continue;
      }

      const createdConfig = await storage.createProfileProviderConfig({
        profileId: newProfileId,
        providerId: configProviderId,
        name: config.name,
        description: config.description ?? null,
        options: config.options ?? null,
        env: preserveImportedEnv(config.env),
      });

      const lookupKey = buildProviderConfigLookupKey(newProfileId, config.name);
      configLookupMap.set(lookupKey, createdConfig.id);
    }
  }

  const profilesWithProviderConfigs = buildProfilesWithProviderConfigs(
    selectedProfilesByFamily,
    mappings.profileIdMap,
  );

  for (const agent of payload.agents) {
    const agentWithConfig = agent as { providerConfigName?: string | null };
    if (!agentWithConfig.providerConfigName || !agent.id) continue;

    const newAgentId = mappings.agentIdMap[agent.id];
    if (!newAgentId) continue;

    const remappedProfileId =
      selectedProfilesByFamily.agentProfileMap.get(agent.id) ?? agent.profileId;
    const newProfileId = remappedProfileId ? mappings.profileIdMap[remappedProfileId] : null;
    if (!newProfileId) continue;

    const lookupKey = buildProviderConfigLookupKey(
      newProfileId,
      agentWithConfig.providerConfigName,
    );
    const providerConfigId = configLookupMap.get(lookupKey);

    if (providerConfigId) {
      await storage.updateAgent(newAgentId, { providerConfigId });
      logger.debug(
        { agentName: agent.name, providerConfigId },
        'Updated agent with providerConfigId',
      );
      continue;
    }

    const fallbackKey = Array.from(configLookupMap.keys()).find((key) =>
      key.startsWith(`${newProfileId}:`),
    );
    if (fallbackKey) {
      const fallbackConfigId = configLookupMap.get(fallbackKey)!;
      await storage.updateAgent(newAgentId, { providerConfigId: fallbackConfigId });
      logger.warn(
        {
          agentName: agent.name,
          providerConfigName: agentWithConfig.providerConfigName,
          fallbackConfigId,
        },
        'Agent providerConfigName unavailable, fell back to first available config',
      );
    } else {
      logger.warn(
        { agentName: agent.name, providerConfigName: agentWithConfig.providerConfigName },
        'No provider config available for agent in createFromTemplate',
      );
    }
  }

  await removeDuplicateDefaultConfigs(profilesWithProviderConfigs, storage);
  return configLookupMap;
}

function buildProfilesWithProviderConfigs(
  selectedProfilesByFamily: ReturnType<
    typeof selectProfilesForFamilies<ParsedTemplatePayload['profiles'][number]>
  >,
  profileIdMap: Record<string, string>,
): Map<string, { profileName: string; configNames: Set<string> }> {
  const profilesWithProviderConfigs = new Map<
    string,
    { profileName: string; configNames: Set<string> }
  >();

  for (const profile of selectedProfilesByFamily.profilesToCreate) {
    if (!profile.id) continue;
    const newProfileId = profileIdMap[profile.id];
    if (!newProfileId) continue;

    const providerConfigs = (profile as { providerConfigs?: Array<{ name: string }> })
      .providerConfigs;
    if (!providerConfigs || providerConfigs.length === 0) continue;

    profilesWithProviderConfigs.set(newProfileId, {
      profileName: profile.name,
      configNames: new Set(
        providerConfigs.map((providerConfig) => providerConfig.name.trim().toLowerCase()),
      ),
    });
  }

  return profilesWithProviderConfigs;
}

async function removeDuplicateDefaultConfigs(
  profilesWithProviderConfigs: Map<string, { profileName: string; configNames: Set<string> }>,
  storage: StorageService,
): Promise<void> {
  for (const [newProfileId, { profileName, configNames }] of profilesWithProviderConfigs) {
    const existingConfigs = await storage.listProfileProviderConfigsByProfile(newProfileId);
    for (const existingConfig of existingConfigs) {
      const isFromProviderConfigs = configNames.has(existingConfig.name.trim().toLowerCase());
      if (isFromProviderConfigs || existingConfig.name !== profileName) continue;

      try {
        await storage.deleteProfileProviderConfig(existingConfig.id);
        logger.debug(
          { profileName, configId: existingConfig.id },
          'Deleted duplicate config created by storage layer',
        );
      } catch {
        logger.debug(
          { profileName, configId: existingConfig.id },
          'Skipped deleting default config — still referenced by agents',
        );
      }
    }
  }
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
