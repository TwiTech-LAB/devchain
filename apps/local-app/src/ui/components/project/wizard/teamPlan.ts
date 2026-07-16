import type { ProfileSelection } from '@/ui/components/team/ProviderGroupedConfigSelector';
import { filterConfigurableTeams } from '@/ui/lib/teams';

/**
 * Pure state + emission logic for wizard Step 3 (Configure Teams), extracted from the legacy
 * `ProjectTeamPreconfigDialog`. No React — the component owns rendering.
 */

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
}

/** Teams the wizard's Step 3 can configure (template enables team-lead agent creation). */
export function configurableTeams(teams: ParsedTemplateTeam[]): ParsedTemplateTeam[] {
  return filterConfigurableTeams(teams);
}

/**
 * Build the initial per-team panel state from the template (verbatim from the legacy dialog's
 * open-effect): each profile starts in `subset` mode when the template pins configs, else `allow-all`.
 */
export function initialTeamStates(visibleTeams: ParsedTemplateTeam[]): Map<string, TeamPanelState> {
  const initial = new Map<string, TeamPanelState>();
  for (const team of visibleTeams) {
    const profileNames = team.profileNames ?? [];
    const selections: ProfileSelection<string, string>[] = profileNames.map((pn) => {
      const sel = team.profileSelections?.find(
        (s) => s.profileName.toLowerCase() === pn.toLowerCase(),
      );
      if (sel && sel.configNames.length > 0) {
        return { profileKey: pn, mode: 'subset' as const, configKeys: sel.configNames };
      }
      return { profileKey: pn, mode: 'allow-all' as const };
    });

    initial.set(team.name, {
      selections,
      templateSelections: selections.map((s) => ({ ...s })),
    });
  }
  return initial;
}

/** Restricts emitted subset config names to the Step-1 provider selection. */
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
