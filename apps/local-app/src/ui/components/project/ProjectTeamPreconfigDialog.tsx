import { useState, useEffect, useMemo } from 'react';
import { filterConfigurableTeams } from '@/ui/lib/teams';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Button } from '@/ui/components/ui/button';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import {
  ProviderGroupedConfigSelector,
  type ProfileSelection,
  type ConfigItem,
} from '@/ui/components/team/ProviderGroupedConfigSelector';

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

interface TeamPanelState {
  selections: ProfileSelection<string, string>[];
  templateSelections: ProfileSelection<string, string>[];
}

interface ProjectTeamPreconfigDialogProps {
  open: boolean;
  teams: ParsedTemplateTeam[];
  profiles: ParsedTemplateProfile[];
  onConfirm: (overrides: TeamOverrideOutput[]) => void;
  onCancel: () => void;
}

export function ProjectTeamPreconfigDialog({
  open,
  teams,
  profiles,
  onConfirm,
  onCancel,
}: ProjectTeamPreconfigDialogProps) {
  const [teamStates, setTeamStates] = useState<Map<string, TeamPanelState>>(new Map());
  const [expandedTeam, setExpandedTeam] = useState<string | null>(null);

  // Only teams whose template enables team-lead agent creation are configurable here.
  const visibleTeams = useMemo(() => filterConfigurableTeams(teams), [teams]);

  useEffect(() => {
    if (!open) return;
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
    setTeamStates(initial);
    setExpandedTeam(visibleTeams.length > 0 ? visibleTeams[0].name : null);
  }, [open, visibleTeams]);

  const configsByProfile = useMemo(() => {
    const result: Record<string, ConfigItem<string>[]> = {};
    for (const profile of profiles) {
      if (!profile.providerConfigs) continue;
      result[profile.name] = profile.providerConfigs.map((pc) => ({
        key: pc.name,
        label: pc.name,
        providerName: pc.providerName,
      }));
    }
    return result;
  }, [profiles]);

  function updateTeamState(teamName: string, patch: Partial<TeamPanelState>) {
    setTeamStates((prev) => {
      const next = new Map(prev);
      const current = next.get(teamName);
      if (!current) return prev;
      next.set(teamName, { ...current, ...patch });
      return next;
    });
  }

  function handleConfirm() {
    const overrides: TeamOverrideOutput[] = [];
    for (const team of visibleTeams) {
      const state = teamStates.get(team.name);
      if (!state) continue;

      const profileSelections: Array<{ profileName: string; configNames: string[] }> = [];
      const profileNames: string[] = [];

      for (const sel of state.selections) {
        if (sel.mode === 'remove') continue;
        profileNames.push(sel.profileKey);
        if (sel.mode === 'subset' && sel.configKeys && sel.configKeys.length > 0) {
          profileSelections.push({ profileName: sel.profileKey, configNames: sel.configKeys });
        } else {
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
    onConfirm(overrides);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Configure Teams</DialogTitle>
          <DialogDescription>
            Choose which provider configs each team is allowed to use.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[500px]">
          <div className="flex flex-col gap-4 pr-4">
            {visibleTeams.map((team) => {
              const state = teamStates.get(team.name);
              if (!state) return null;
              const isExpanded = expandedTeam === team.name;
              const isEmpty = team.memberAgentNames.length === 0;

              return (
                <div key={team.name} className="rounded-lg border p-4">
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
                                    updateTeamState(team.name, { selections: sels })
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

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={handleConfirm}>
            Create Project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
