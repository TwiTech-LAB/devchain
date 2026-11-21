import { firstPresetTeamEntries, presetNameKey, type PresetTeamConfigs } from '@devchain/shared';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { TemplatePresetDto } from '../../settings/dtos/settings.dto';
import type { SettingsService } from '../../settings/services/settings.service';
import type {
  AgentProfileStorage,
  AgentStorage,
  ProfileProviderConfigStorage,
} from '../../storage/interfaces/storage.interface';
import type { TeamsService } from '../../teams/services/teams.service';
import { buildProviderConfigLookupKey } from './profile-mapping.helpers';

const logger = createLogger('ProjectsService');

export type ProjectPreset = TemplatePresetDto;
export type PresetAgentConfig = ProjectPreset['agentConfigs'][number];

export interface ApplyPresetNameMaps {
  agentNameToId: Map<string, string>;
  configLookupMap: Map<string, string>;
}

interface PresetMatchDeps {
  storage: AgentProfileStorage & AgentStorage & ProfileProviderConfigStorage;
  teamsService: Pick<TeamsService, 'listTeams' | 'getTeam'>;
}

interface PresetDeps extends PresetMatchDeps {
  settings: SettingsService;
  teamsService: Pick<TeamsService, 'listTeams' | 'getTeam' | 'updateTeam'>;
}

export interface ApplyPresetResult {
  applied: number;
  warnings: string[];
  teamsApplied: number;
}

export type ApplyPresetFn = (
  projectId: string,
  presetName: string,
  nameMaps: ApplyPresetNameMaps,
  skipTeamNames: ReadonlySet<string>,
) => Promise<ApplyPresetResult>;

type TeamDetails = NonNullable<Awaited<ReturnType<TeamsService['getTeam']>>>;
type PresetTeamEntry = PresetTeamConfigs[number];

async function loadPresetTeamLookups(projectId: string, deps: PresetMatchDeps) {
  const [teams, profiles] = await Promise.all([
    deps.teamsService.listTeams(projectId, { limit: Number.MAX_SAFE_INTEGER }),
    deps.storage.listAgentProfiles({ projectId, limit: Number.MAX_SAFE_INTEGER }),
  ]);
  return {
    teamIds: buildNameToIdMap(teams.items),
    profileIds: buildNameToIdMap(profiles.items),
  };
}

async function resolveTeamSelections(
  entry: PresetTeamEntry,
  team: TeamDetails,
  profileIds: ReadonlyMap<string, string>,
  storage: ProfileProviderConfigStorage,
) {
  const linkedProfileIds = new Set(team.profileIds);
  const selections = new Map<string, Set<string>>();
  const warnings: string[] = [];

  for (const { profileName, configNames } of entry.profileSelections) {
    const profileId = profileIds.get(presetNameKey(profileName));
    if (!profileId || !linkedProfileIds.has(profileId)) {
      warnings.push(
        `Profile "${profileName}" not found among linked profiles for team "${entry.teamName}"`,
      );
      continue;
    }

    const configs = await storage.listProfileProviderConfigsByProfile(profileId);
    const configIdsByName = new Map(
      configs.map((config) => [presetNameKey(config.name), config.id]),
    );
    const configIds = selections.get(profileId) ?? new Set<string>();
    for (const configName of configNames) {
      const configId = configIdsByName.get(presetNameKey(configName));
      if (configId) {
        configIds.add(configId);
      } else {
        warnings.push(
          `Provider config "${configName}" not found for profile "${profileName}" on team "${entry.teamName}"`,
        );
      }
    }
    selections.set(profileId, configIds);
  }

  const currentSelections = new Map(
    team.profileConfigSelections.map((row) => [row.profileId, row.configIds]),
  );
  return { selections, warnings, currentSelections };
}

export async function doesProjectMatchPresetWithHelper(
  projectId: string,
  preset: Pick<ProjectPreset, 'agentConfigs' | 'teamConfigs'>,
  deps: PresetMatchDeps,
): Promise<boolean> {
  const agentsRes = await deps.storage.listAgents(projectId, { limit: 1000, offset: 0 });
  const agentsByName = new Map(agentsRes.items.map((agent) => [presetNameKey(agent.name), agent]));

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

  const providerConfigNames = new Map(
    allProviderConfigs.map((config) => [config.id, presetNameKey(config.name)]),
  );

  for (const agentConfig of preset.agentConfigs) {
    const agent = agentsByName.get(presetNameKey(agentConfig.agentName));
    if (!agent) {
      return false;
    }

    const currentProviderConfigName = providerConfigNames.get(agent.providerConfigId ?? '');
    if (currentProviderConfigName !== presetNameKey(agentConfig.providerConfigName)) {
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

    // Omitted effortOverride means "don't care" for preset matching.
    if (agentConfig.effortOverride !== undefined) {
      const expectedEffortOverride = agentConfig.effortOverride ?? null;
      const currentEffortOverride = agent.effortOverride ?? null;
      if (currentEffortOverride !== expectedEffortOverride) {
        return false;
      }
    }
  }

  if (!preset.teamConfigs?.length) return true;

  const { teamIds, profileIds } = await loadPresetTeamLookups(projectId, deps);
  for (const [teamName, entry] of firstPresetTeamEntries(preset.teamConfigs)) {
    const teamId = teamIds.get(teamName);
    const team = teamId ? await deps.teamsService.getTeam(teamId) : null;
    if (!team) return false;

    const { selections, warnings, currentSelections } = await resolveTeamSelections(
      entry,
      team,
      profileIds,
      deps.storage,
    );
    if (warnings.length > 0) return false;

    for (const profileId of team.profileIds) {
      const currentIds = currentSelections.get(profileId) ?? [];
      const expectedIds = selections.get(profileId);
      if (
        currentIds.length !== (expectedIds?.size ?? 0) ||
        currentIds.some((id) => !expectedIds?.has(id))
      ) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Apply an array of per-agent provider-config assignments (+ optional model/effort overrides)
 * to a project. This is the shared inner loop behind BOTH stored-preset application
 * (`applyPresetWithHelper`) and the wizard/API `agentOverrides` path (create + import).
 *
 * It NEVER touches active-preset state — that is a preset-name-only concern owned by
 * `applyPresetWithHelper`. Unknown agent / unknown provider-config names are surfaced as
 * warnings (not silent) and that agentConfig is skipped, mirroring preset-apply semantics.
 * Override semantics: `undefined` = preserve existing, `null` = clear.
 */
export async function applyAgentConfigs(
  projectId: string,
  agentConfigs: PresetAgentConfig[],
  deps: Pick<PresetDeps, 'storage'>,
  nameMaps?: ApplyPresetNameMaps,
): Promise<{ applied: number; warnings: string[] }> {
  const warnings: string[] = [];

  const agentsRes = await deps.storage.listAgents(projectId, { limit: 1000, offset: 0 });
  const agentNameToId = nameMaps?.agentNameToId ?? buildNameToIdMap(agentsRes.items);
  const configLookupMap =
    nameMaps?.configLookupMap ?? (await buildProjectConfigLookupMap(projectId, deps.storage));

  let applied = 0;
  const agentsById = new Map(agentsRes.items.map((agent) => [agent.id, agent]));

  for (const agentConfig of agentConfigs) {
    const agentId = agentNameToId.get(presetNameKey(agentConfig.agentName));
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

    const updatePayload: {
      providerConfigId: string;
      modelOverride?: string | null;
      effortOverride?: string | null;
    } = {
      providerConfigId,
    };
    if (agentConfig.modelOverride !== undefined) {
      updatePayload.modelOverride = agentConfig.modelOverride;
    }
    if (agentConfig.effortOverride !== undefined) {
      updatePayload.effortOverride = agentConfig.effortOverride;
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
        ...(agentConfig.effortOverride !== undefined
          ? { effortOverride: agentConfig.effortOverride }
          : {}),
      },
      'Applied agent config: updated agent provider config and overrides',
    );
  }

  return { applied, warnings };
}

export async function applyPresetWithHelper(
  projectId: string,
  presetName: string,
  deps: PresetDeps,
  nameMaps?: ApplyPresetNameMaps,
  skipTeamNames?: ReadonlySet<string>,
): Promise<ApplyPresetResult> {
  logger.info({ projectId, presetName }, 'applyPreset');

  const presets = deps.settings.getProjectPresets(projectId);
  const selectedPreset = presets.find((preset) => preset.name === presetName);

  if (!selectedPreset) {
    throw new NotFoundError('Preset', presetName);
  }

  if (!selectedPreset.agentConfigs || !Array.isArray(selectedPreset.agentConfigs)) {
    throw new ValidationError(`Preset "${presetName}" has invalid or missing agentConfigs`, {
      presetName,
    });
  }

  const { applied, warnings } = await applyAgentConfigs(
    projectId,
    selectedPreset.agentConfigs,
    deps,
    nameMaps,
  );

  const teamsApplied = selectedPreset.teamConfigs?.length
    ? await applyPresetTeams(projectId, selectedPreset.teamConfigs, deps, warnings, skipTeamNames)
    : 0;
  const fullMatch = warnings.length === 0 && applied === selectedPreset.agentConfigs.length;
  if (fullMatch) {
    await deps.settings.setProjectActivePreset(projectId, presetName);
    logger.info({ projectId, presetName }, 'Active preset set (full match)');
  }

  logger.info(
    { projectId, presetName, applied, teamsApplied, warnings: warnings.length },
    'Preset applied',
  );
  return { applied, warnings, teamsApplied };
}

async function applyPresetTeams(
  projectId: string,
  teamConfigs: PresetTeamConfigs,
  deps: PresetDeps,
  warnings: string[],
  skipTeamNames?: ReadonlySet<string>,
): Promise<number> {
  const { teamIds, profileIds } = await loadPresetTeamLookups(projectId, deps);
  const skipped = new Set(Array.from(skipTeamNames ?? [], presetNameKey));
  let applied = 0;

  for (const [teamName, entry] of firstPresetTeamEntries(teamConfigs)) {
    const teamId = teamIds.get(teamName);
    if (teamId && skipped.has(teamName)) continue;

    const team = teamId ? await deps.teamsService.getTeam(teamId) : null;
    if (!team) {
      warnings.push(`Team "${entry.teamName}" not found in project`);
      continue;
    }

    const resolved = await resolveTeamSelections(entry, team, profileIds, deps.storage);
    warnings.push(...resolved.warnings);

    const profileConfigSelections: TeamDetails['profileConfigSelections'] = [];
    for (const [profileId, resolvedIds] of resolved.selections) {
      // Missing rows allow all configs, so stale names must preserve existing restrictions.
      const configIds =
        resolvedIds.size > 0 ? [...resolvedIds] : resolved.currentSelections.get(profileId);
      if (configIds?.length) profileConfigSelections.push({ profileId, configIds });
    }

    try {
      await deps.teamsService.updateTeam(team.id, { profileConfigSelections });
      applied++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to apply preset to team "${entry.teamName}": ${message}`);
    }
  }

  return applied;
}

function buildNameToIdMap(items: ReadonlyArray<{ id: string; name: string }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    map.set(presetNameKey(item.name), item.id);
  }
  return map;
}

async function buildProjectConfigLookupMap(
  projectId: string,
  storage: AgentProfileStorage & ProfileProviderConfigStorage,
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
