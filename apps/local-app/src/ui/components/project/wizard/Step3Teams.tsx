import { useMemo, useState } from 'react';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import {
  ProviderGroupedConfigSelector,
  type ConfigItem,
} from '@/ui/components/team/ProviderGroupedConfigSelector';
import type { ParsedTemplateProfile, ParsedTemplateTeam, TeamPanelState } from './teamPlan';

export interface Step3TeamsProps {
  /** Already filtered to configurable teams (see `configurableTeams`). */
  visibleTeams: ParsedTemplateTeam[];
  profiles: ParsedTemplateProfile[];
  /** Step-1 selection — config options are limited to these providers. */
  selectedProviderNames: string[];
  /** Per-team panel state, keyed by team name. Owned by the flow controller (survives Back/Next). */
  teamStates: Map<string, TeamPanelState>;
  /** Patch a single team's panel state. */
  onTeamStateChange: (teamName: string, patch: Partial<TeamPanelState>) => void;
}

/**
 * Wizard Step 3 — Configure Teams. The presentational body extracted VERBATIM from the legacy
 * `ProjectTeamPreconfigDialog` (accordion of team panels, each a {@link ProviderGroupedConfigSelector}
 * over the team's profiles). Domain state (`teamStates`) is lifted to the controller so Back/Next
 * preserve it and the emission (`buildTeamOverrides`) runs once at submit; only the expanded-panel UI
 * bit stays local. Skipped entirely by the wizard when no team is configurable.
 */
export function Step3Teams({
  visibleTeams,
  profiles,
  selectedProviderNames,
  teamStates,
  onTeamStateChange,
}: Step3TeamsProps) {
  const [expandedTeam, setExpandedTeam] = useState<string | null>(
    visibleTeams.length > 0 ? visibleTeams[0].name : null,
  );

  const configsByProfile = useMemo(() => {
    // Only offer configs whose provider survived Step 1 — the created project won't have the
    // others, so listing them would let a team pin configs that cannot exist.
    const selected = new Set(selectedProviderNames.map((name) => name.trim().toLowerCase()));
    const result: Record<string, ConfigItem<string>[]> = {};
    for (const profile of profiles) {
      if (!profile.providerConfigs) continue;
      result[profile.name] = profile.providerConfigs
        .filter((pc) => selected.has(pc.providerName.trim().toLowerCase()))
        .map((pc) => ({
          key: pc.name,
          label: pc.name,
          providerName: pc.providerName,
        }));
    }
    return result;
  }, [profiles, selectedProviderNames]);

  return (
    <div className="space-y-1" data-testid="wizard-teams-step">
      <p className="text-sm text-muted-foreground">
        Choose which provider configs each team is allowed to use.
      </p>
      <ScrollArea className="max-h-[420px]">
        <div className="flex flex-col gap-4 pr-4">
          {visibleTeams.map((team) => {
            const state = teamStates.get(team.name);
            if (!state) return null;
            const isExpanded = expandedTeam === team.name;
            const isEmpty = team.memberAgentNames.length === 0;

            return (
              <div
                key={team.name}
                className="rounded-lg border p-4"
                data-testid={`wizard-team-${team.name}`}
              >
                <button
                  type="button"
                  className="flex w-full items-center justify-between text-left"
                  onClick={() => setExpandedTeam(isExpanded ? null : team.name)}
                >
                  <div>
                    <h3 className="text-sm font-semibold">{team.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      {team.memberAgentNames.length} member
                      {team.memberAgentNames.length !== 1 ? 's' : ''}
                      {team.teamLeadAgentName ? ` · Lead: ${team.teamLeadAgentName}` : ''}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">{isExpanded ? '▲' : '▼'}</span>
                </button>

                {isExpanded && (
                  <div className="mt-3 flex flex-col gap-3">
                    {isEmpty && (
                      <p className="rounded bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                        This team has no members — the lead will bootstrap them on demand.
                      </p>
                    )}

                    {state.selections.length > 0 && (
                      <div className="rounded border p-2">
                        <div className="flex flex-col gap-3">
                          {state.selections.map((sel) => (
                            <div key={sel.profileKey}>
                              {state.selections.length > 1 && (
                                <p className="mb-1 text-xs font-medium">{sel.profileKey}</p>
                              )}
                              <ProviderGroupedConfigSelector
                                focusedProfileKey={sel.profileKey}
                                configsByProfile={configsByProfile}
                                selections={state.selections}
                                templateSelections={state.templateSelections}
                                onChange={(sels) =>
                                  onTeamStateChange(team.name, { selections: sels })
                                }
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
