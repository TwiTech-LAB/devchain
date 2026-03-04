import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { SettingsService } from '../../settings/services/settings.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { buildProviderConfigLookupKey } from './profile-mapping.helpers';

const logger = createLogger('ProjectsService');

export interface PresetAgentConfig {
  agentName: string;
  providerConfigName: string;
  modelOverride?: string | null;
}

export interface ProjectPreset {
  name: string;
  description?: string | null;
  agentConfigs: PresetAgentConfig[];
}

export interface ApplyPresetNameMaps {
  agentNameToId: Map<string, string>;
  configLookupMap: Map<string, string>;
}

interface PresetDeps {
  storage: StorageService;
  settings: SettingsService;
}

export async function doesProjectMatchPresetWithHelper(
  projectId: string,
  preset: Pick<ProjectPreset, 'agentConfigs'>,
  deps: Pick<PresetDeps, 'storage'>,
): Promise<boolean> {
  const agentsRes = await deps.storage.listAgents(projectId, { limit: 1000, offset: 0 });
  const agentsByName = new Map(agentsRes.items.map((agent) => [agent.name.toLowerCase(), agent]));

  const uniqueProviderConfigIds = new Set<string>();
  for (const agent of agentsRes.items) {
    if (agent.providerConfigId) {
      uniqueProviderConfigIds.add(agent.providerConfigId);
    }
  }

  const allProviderConfigs =
    uniqueProviderConfigIds.size > 0
      ? await deps.storage.listProfileProviderConfigsByIds(Array.from(uniqueProviderConfigIds))
      : [];

  const providerConfigNames = new Map(allProviderConfigs.map((config) => [config.id, config.name]));

  for (const agentConfig of preset.agentConfigs) {
    const agent = agentsByName.get(agentConfig.agentName.trim().toLowerCase());
    if (!agent) {
      return false;
    }

    const currentProviderConfigName = providerConfigNames.get(agent.providerConfigId ?? '');
    if (
      currentProviderConfigName?.toLowerCase() !==
      agentConfig.providerConfigName.trim().toLowerCase()
    ) {
      return false;
    }

    // Omitted modelOverride means "don't care" for preset matching.
    if (agentConfig.modelOverride !== undefined) {
      const expectedModelOverride = agentConfig.modelOverride ?? null;
      const currentModelOverride = agent.modelOverride ?? null;
      if (currentModelOverride !== expectedModelOverride) {
        return false;
      }
    }
  }

  return true;
}

export async function applyPresetWithHelper(
  projectId: string,
  presetName: string,
  deps: PresetDeps,
  nameMaps?: ApplyPresetNameMaps,
): Promise<{ applied: number; warnings: string[] }> {
  logger.info({ projectId, presetName }, 'applyPreset');

  const warnings: string[] = [];

  const presets = deps.settings.getProjectPresets(projectId) as ProjectPreset[];
  const selectedPreset = presets.find((preset) => preset.name === presetName);

  if (!selectedPreset) {
    throw new NotFoundError('Preset', presetName);
  }

  if (!selectedPreset.agentConfigs || !Array.isArray(selectedPreset.agentConfigs)) {
    throw new ValidationError(`Preset "${presetName}" has invalid or missing agentConfigs`, {
      presetName,
    });
  }

  const agentsRes = await deps.storage.listAgents(projectId, { limit: 1000, offset: 0 });
  const agentNameToId = nameMaps?.agentNameToId ?? buildAgentNameToIdMap(agentsRes.items);
  const configLookupMap =
    nameMaps?.configLookupMap ?? (await buildProjectConfigLookupMap(projectId, deps.storage));

  let applied = 0;
  const agentsById = new Map(agentsRes.items.map((agent) => [agent.id, agent]));

  for (const agentConfig of selectedPreset.agentConfigs) {
    const agentId = agentNameToId.get(agentConfig.agentName.trim().toLowerCase());
    if (!agentId) {
      warnings.push(`Agent "${agentConfig.agentName}" not found in project`);
      continue;
    }

    const agent = agentsById.get(agentId);
    if (!agent) {
      continue;
    }

    const lookupKey = buildProviderConfigLookupKey(agent.profileId, agentConfig.providerConfigName);
    const providerConfigId = configLookupMap.get(lookupKey);

    if (!providerConfigId) {
      warnings.push(
        `Provider config "${agentConfig.providerConfigName}" not found for agent "${agentConfig.agentName}"`,
      );
      continue;
    }

    const updatePayload: { providerConfigId: string; modelOverride?: string | null } = {
      providerConfigId,
    };
    if (agentConfig.modelOverride !== undefined) {
      updatePayload.modelOverride = agentConfig.modelOverride;
    }
    await deps.storage.updateAgent(agentId, updatePayload);
    applied++;
    logger.debug(
      {
        projectId,
        agentId,
        agentName: agentConfig.agentName,
        providerConfigId,
        ...(agentConfig.modelOverride !== undefined
          ? { modelOverride: agentConfig.modelOverride }
          : {}),
      },
      'Applied preset: updated agent provider config and model override',
    );
  }

  const fullMatch = warnings.length === 0 && applied === selectedPreset.agentConfigs.length;
  if (fullMatch) {
    await deps.settings.setProjectActivePreset(projectId, presetName);
    logger.info({ projectId, presetName }, 'Active preset set (full match)');
  }

  logger.info({ projectId, presetName, applied, warnings: warnings.length }, 'Preset applied');
  return { applied, warnings };
}

function buildAgentNameToIdMap(agents: Array<{ id: string; name: string }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const agent of agents) {
    map.set(agent.name.toLowerCase(), agent.id);
  }
  return map;
}

async function buildProjectConfigLookupMap(
  projectId: string,
  storage: StorageService,
): Promise<Map<string, string>> {
  const configLookupMap = new Map<string, string>();

  const profilesRes = await storage.listAgentProfiles({
    projectId,
    limit: 1000,
    offset: 0,
  });

  for (const profile of profilesRes.items) {
    const configs = await storage.listProfileProviderConfigsByProfile(profile.id);
    for (const config of configs) {
      const lookupKey = buildProviderConfigLookupKey(profile.id, config.name);
      configLookupMap.set(lookupKey, config.id);
    }
  }

  return configLookupMap;
}
