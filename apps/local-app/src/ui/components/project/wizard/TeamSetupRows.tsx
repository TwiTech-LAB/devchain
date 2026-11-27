import { useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import {
  ProviderGroupedConfigSelector,
  type ConfigItem,
  type ProfileSelection,
} from '@/ui/components/team/ProviderGroupedConfigSelector';
import { availableConfigs } from './agentPlan';
import type { ParsedTemplateTeam, TeamPanelState } from './teamPlan';
import { providerDisplayList } from './providerDisplay';
import { useSetupReview } from './SetupReviewContext';
import { RosterRow, type RosterRole } from './Roster';

/**
 * One row per profile in a configurable team's state: the agents its lead may start, and the
 * providers they may run on. The popover edits the team's config permission.
 */
export function TeamSetupRows({ team, role }: { team: ParsedTemplateTeam; role?: RosterRole }) {
  const { preview, state } = useSetupReview();
  const profiles = preview.payload.profiles;
  const selectedProviderNames = state.selectedProviderNames;

  const configsByProfile = useMemo(() => {
    const result: Record<string, ConfigItem<string>[]> = {};
    for (const profile of profiles ?? []) {
      result[profile.name] = availableConfigs(profile, selectedProviderNames).map((pc) => ({
        key: pc.name,
        label: pc.name,
        providerName: pc.providerName,
      }));
    }
    return result;
  }, [profiles, selectedProviderNames]);

  const teamState = state.teamStates.get(team.name);
  if (!teamState) return null;

  // The selector moves an edited selection to the end of the list; rows keep the template order.
  const order = new Map(teamState.templateSelections.map((sel, index) => [sel.profileKey, index]));
  const orderedSelections = [...teamState.selections].sort(
    (a, b) => (order.get(a.profileKey) ?? 0) - (order.get(b.profileKey) ?? 0),
  );

  return (
    <>
      {orderedSelections.map((selection) => (
        <TeamProfileRow
          key={selection.profileKey}
          team={team}
          role={role}
          selection={selection}
          teamState={teamState}
          configsByProfile={configsByProfile}
        />
      ))}
    </>
  );
}

interface TeamProfileRowProps {
  team: ParsedTemplateTeam;
  role?: RosterRole;
  selection: ProfileSelection<string, string>;
  teamState: TeamPanelState;
  configsByProfile: Record<string, ConfigItem<string>[]>;
}

function TeamProfileRow({
  team,
  role,
  selection,
  teamState,
  configsByProfile,
}: TeamProfileRowProps) {
  const { handlers } = useSetupReview();
  const configs = configsByProfile[selection.profileKey] ?? [];
  const title = `${selection.profileKey} agents`;
  const label = providerDisplayList(selectedConfigProviders(selection, configs)) || 'None';
  const details = [
    team.teamLeadAgentName ? `Started by ${team.teamLeadAgentName} when needed` : null,
    team.maxConcurrentTasks ? `up to ${team.maxConcurrentTasks} tasks at a time` : null,
  ].filter(Boolean);

  return (
    <RosterRow
      name={title}
      role={role}
      description={details.join(', ')}
      testId={`wizard-team-row-${team.name}-${selection.profileKey}`}
    >
      {/* Modal: the dialog's scroll lock would otherwise block wheel scrolling in this portal. */}
      <Popover modal>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-w-0 max-w-full gap-1.5"
            aria-label={`${title}: ${label}`}
          >
            <span className="min-w-0 max-w-[12rem] truncate">{label}</span>
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          collisionPadding={16}
          className="max-h-[var(--radix-popover-content-available-height)] w-80 overflow-y-auto"
        >
          <ProviderGroupedConfigSelector
            focusedProfileKey={selection.profileKey}
            configsByProfile={configsByProfile}
            selections={teamState.selections}
            templateSelections={teamState.templateSelections}
            onChange={(selections) => handlers.onTeamStateChange(team.name, { selections })}
          />
        </PopoverContent>
      </Popover>
    </RosterRow>
  );
}

/** Providers of the configs a selection permits, in config order. */
function selectedConfigProviders(
  selection: ProfileSelection<string, string>,
  configs: ConfigItem<string>[],
): string[] {
  if (selection.mode === 'remove') return [];
  if (selection.mode === 'allow-all') return configs.map((c) => c.providerName);
  const keys = new Set(selection.configKeys ?? []);
  return configs.filter((c) => keys.has(c.key)).map((c) => c.providerName);
}
