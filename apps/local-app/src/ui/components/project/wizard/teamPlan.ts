import type { ProfileSelection } from '@/ui/components/team/ProviderGroupedConfigSelector';
import { filterConfigurableTeams } from '@/ui/lib/teams';
import type { SetupPreviewResponse } from '@/ui/pages/projects/lib/project-contracts';
import { eqName } from './agentPlan';

/** Pure state and emission logic for the team rows of the setup review. */

type TemplatePreset = NonNullable<SetupPreviewResponse['payload']['presets']>[number];

export interface ParsedTemplateTeam {
  name: string;
  description?: string | null;
  teamLeadAgentName?: string | null;
  memberAgentNames: string[];
  maxMembers?: number;
  maxConcurrentTasks?: number;
  allowTeamLeadCreateAgents?: boolean;
  profileNames?: string[];
  profileSelections?: Array<{ profileName: string; configNames: string[] }>;
}

export interface ParsedTemplateProfile {
  name: string;
  providerConfigs?: Array<{ name: string; providerName: string }>;
}

export interface TeamOverrideOutput {
  teamName: string;
  allowTeamLeadCreateAgents?: boolean;
  maxMembers?: number;
  maxConcurrentTasks?: number;
  profileNames?: string[];
  profileSelections?: Array<{ profileName: string; configNames: string[] }>;
}

export interface TeamPanelState {
  selections: ProfileSelection<string, string>[];
  templateSelections: ProfileSelection<string, string>[];
  /** Profiles whose initial config subset was replaced by the provider fallback. */
  fallbacks?: TeamProfileFallback[];
}

export interface TeamProfileFallback {
  profileName: string;
  /** The initial subset, none of which is on an installed provider. */
  fromConfigNames: string[];
  /** The replacement: the profile's first config, in template order, on an installed provider. */
  configName: string;
}

/** Template profiles + installed providers that drive the team provider fallback. */
export interface TeamFallbackInput {
  profiles: ParsedTemplateProfile[];
  installedProviderNames: string[];
}

/** Teams the wizard can configure (template enables team-lead agent creation). */
export function configurableTeams(teams: ParsedTemplateTeam[]): ParsedTemplateTeam[] {
  return filterConfigurableTeams(teams);
}

/**
 * Build the initial per-team panel state from the template: each profile starts in `subset` mode
 * when the template pins configs, else `allow-all`.
 *
 * With `fallback`, a subset whose every config is on a provider that is not installed is replaced by
 * the profile's first config on an installed provider, in both `selections` and
 * `templateSelections` (the config selector offers only template configs). A subset with an
 * unknown config name, or a profile with no installed config, is left unchanged.
 */
export function initialTeamStates(
  visibleTeams: ParsedTemplateTeam[],
  fallback?: TeamFallbackInput,
): Map<string, TeamPanelState> {
  const installed = new Set(
    (fallback?.installedProviderNames ?? []).map((n) => n.trim().toLowerCase()),
  );
  const findProfile = (name: string) => fallback?.profiles.find((p) => eqName(p.name, name));

  const initial = new Map<string, TeamPanelState>();
  for (const team of visibleTeams) {
    const profileNames = team.profileNames ?? [];
    const fallbacks: TeamProfileFallback[] = [];
    const selections: ProfileSelection<string, string>[] = profileNames.map((pn) => {
      const sel = team.profileSelections?.find((s) => eqName(s.profileName, pn));
      if (!sel || sel.configNames.length === 0) {
        return { profileKey: pn, mode: 'allow-all' as const };
      }
      const replacement = fallback
        ? fallbackConfigName(findProfile(pn), sel.configNames, installed)
        : undefined;
      if (replacement) {
        fallbacks.push({
          profileName: pn,
          fromConfigNames: sel.configNames,
          configName: replacement,
        });
        return { profileKey: pn, mode: 'subset' as const, configKeys: [replacement] };
      }
      return { profileKey: pn, mode: 'subset' as const, configKeys: sel.configNames };
    });

    initial.set(team.name, {
      selections,
      templateSelections: selections.map((s) => ({ ...s })),
      ...(fallbacks.length > 0 ? { fallbacks } : {}),
    });
  }
  return initial;
}

/** Start configurable teams from the selected preset when it supplies a team entry. */
export function templateTeamStates(
  payload: SetupPreviewResponse['payload'],
  providerNames: string[],
  preset?: TemplatePreset,
): Map<string, TeamPanelState> {
  const profiles = (payload.profiles ?? []) as ParsedTemplateProfile[];
  const teams = configurableTeams((payload.teams ?? []) as ParsedTemplateTeam[]).map((team) => {
    const entry = preset?.teamConfigs?.find((item) => eqName(item.teamName, team.name));
    if (!entry) return team;

    const profileSelections = (team.profileNames ?? []).flatMap((profileName) => {
      const selections = entry.profileSelections.filter((item) =>
        eqName(item.profileName, profileName),
      );
      if (selections.length === 0) return [];

      const configs = profiles.find((profile) =>
        eqName(profile.name, profileName),
      )?.providerConfigs;
      const configNames = new Set<string>();
      for (const name of selections.flatMap((selection) => selection.configNames)) {
        const config = configs?.find((item) => eqName(item.name, name));
        if (config) configNames.add(config.name);
      }
      if (configNames.size > 0) return [{ profileName, configNames: [...configNames] }];

      const templateSelection = team.profileSelections?.find((item) =>
        eqName(item.profileName, profileName),
      );
      return templateSelection ? [templateSelection] : [];
    });

    return { ...team, profileSelections };
  });

  return initialTeamStates(teams, {
    profiles,
    installedProviderNames: providerNames,
  });
}

/** The fallback config for a subset that has no config on an installed provider, else undefined. */
function fallbackConfigName(
  profile: ParsedTemplateProfile | undefined,
  configNames: string[],
  installed: ReadonlySet<string>,
): string | undefined {
  const configs = profile?.providerConfigs ?? [];
  const providerOf = (name: string) =>
    configs
      .find((c) => eqName(c.name, name))
      ?.providerName.trim()
      .toLowerCase();
  const subsetRuns = configNames.some((name) => {
    const provider = providerOf(name);
    return provider === undefined || installed.has(provider);
  });
  if (subsetRuns) return undefined;
  return configs.find((c) => installed.has(c.providerName.trim().toLowerCase()))?.name;
}

/** Restricts emitted subset config names to the selected providers. */
export interface TeamOverrideProviderFilter {
  profiles: ParsedTemplateProfile[];
  selectedProviderNames: string[];
}

/**
 * Emit team overrides. Removed profiles are dropped; kept profiles contribute a `profileSelections`
 * entry (subset config names, or `[]` for allow-all). `allowTeamLeadCreateAgents` is always `true`
 * for a configured team.
 *
 * With a `providerFilter`, subset config names that resolve to an unselected provider are dropped.
 * If no names survive, the profile permission is removed rather than broadened to allow-all (`[]`).
 * Names that cannot be resolved against the profiles are kept so strict backend validation can
 * report malformed templates.
 */
export function buildTeamOverrides(
  visibleTeams: ParsedTemplateTeam[],
  teamStates: Map<string, TeamPanelState>,
  providerFilter?: TeamOverrideProviderFilter,
): TeamOverrideOutput[] {
  // profileName(lower) → configName(lower) → providerName(lower)
  let configProviders: Map<string, Map<string, string>> | null = null;
  let selectedProviders: Set<string> | null = null;
  if (providerFilter) {
    configProviders = new Map();
    for (const profile of providerFilter.profiles) {
      const byConfig = new Map<string, string>();
      for (const pc of profile.providerConfigs ?? []) {
        byConfig.set(pc.name.trim().toLowerCase(), pc.providerName.trim().toLowerCase());
      }
      configProviders.set(profile.name.trim().toLowerCase(), byConfig);
    }
    selectedProviders = new Set(
      providerFilter.selectedProviderNames.map((n) => n.trim().toLowerCase()),
    );
  }

  const overrides: TeamOverrideOutput[] = [];
  for (const team of visibleTeams) {
    const state = teamStates.get(team.name);
    if (!state) continue;

    const profileSelections: Array<{ profileName: string; configNames: string[] }> = [];
    const profileNames: string[] = [];

    for (const sel of state.selections) {
      if (sel.mode === 'remove') continue;
      if (sel.mode === 'subset' && sel.configKeys && sel.configKeys.length > 0) {
        let configNames = sel.configKeys;
        if (configProviders && selectedProviders) {
          const byConfig = configProviders.get(sel.profileKey.trim().toLowerCase());
          configNames = configNames.filter((key) => {
            const provider = byConfig?.get(key.trim().toLowerCase());
            return !provider || selectedProviders.has(provider);
          });
        }
        if (configNames.length > 0) {
          profileNames.push(sel.profileKey);
          profileSelections.push({ profileName: sel.profileKey, configNames });
        }
      } else if (sel.mode === 'allow-all') {
        profileNames.push(sel.profileKey);
        profileSelections.push({ profileName: sel.profileKey, configNames: [] });
      }
    }

    overrides.push({
      teamName: team.name,
      allowTeamLeadCreateAgents: true,
      profileNames,
      ...(profileSelections.length > 0 ? { profileSelections } : {}),
    });
  }
  return overrides;
}
