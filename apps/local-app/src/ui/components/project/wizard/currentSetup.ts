import type {
  PreservationAgentRow,
  PreservationOption,
  PreservationReview,
  PreserveTeamSetup,
} from '@/common/project-preservation.contract';
import type { ExportData } from '@devchain/shared';
import { agentKey, eqName } from './agentPlan';
import { optionLabel } from './providerDisplay';

export function canPreserveTeams(current: ExportData | null): boolean {
  return current?.teams?.some((team) => team.memberAgentNames.length > 0) ?? false;
}

export function currentSetupRemovals(
  current: ExportData,
  target: ExportData,
  plan?: PreservationReview,
): string[] {
  const targetNames = new Set(
    (plan?.agents ?? target.agents ?? []).map(({ name }) => agentKey(name)),
  );
  return (current.agents ?? [])
    .map(({ name }) => name)
    .filter((name) => !targetNames.has(agentKey(name)));
}

/**
 * The trimmed description of the first entry with this name, matched as the server matches names;
 * null when it is missing or blank.
 */
function describe(
  entries: { name: string; description?: string | null }[] | undefined,
  name: string,
): string | null {
  return entries?.find((entry) => eqName(entry.name, name))?.description?.trim() || null;
}

/**
 * The plan's agent rows by team (the lead first, each agent once), then the agents in no team.
 * A team's `lead` is the name of its lead's row, or null when the plan has no row for the lead.
 * Descriptions are the ones the import gives: a kept agent or retained team keeps its current
 * description, and only a new agent or added team takes the template's.
 */
export function preservedAgentGroups(
  plan: PreservationReview,
  current: ExportData | null,
  template: ExportData,
) {
  const agentDescription = (agent: PreservationAgentRow) =>
    agent.status === 'new'
      ? describe(template.agents, agent.name)
      : describe(current?.agents, agent.name);
  const rows = plan.agents.map((agent) => ({ ...agent, description: agentDescription(agent) }));
  const rowsByKey = new Map(rows.map((row) => [agentKey(row.name), row]));
  const teams = plan.teams.map(
    ({ name, retained, permissionsChanged, teamLeadAgentName, memberAgentNames }) => {
      const keys = new Set(
        [teamLeadAgentName, ...memberAgentNames]
          .filter((agentName): agentName is string => agentName !== null)
          .map(agentKey),
      );
      const agents = [...keys].flatMap((key) => rowsByKey.get(key) ?? []);
      const lead = teamLeadAgentName
        ? (rowsByKey.get(agentKey(teamLeadAgentName))?.name ?? null)
        : null;
      const description = retained
        ? describe(current?.teams, name)
        : describe(template.teams, name);
      return { name, description, permissionsChanged, lead, agents };
    },
  );
  const inTeam = new Set(teams.flatMap(({ agents }) => agents.map(({ name }) => agentKey(name))));
  return { teams, independent: rows.filter(({ name }) => !inTeam.has(agentKey(name))) };
}

/**
 * The kept agents whose option the server replaced, as "name (before → after)". An agent with the
 * user's own choice is not listed. The provider shows only when the option name stays the same.
 */
export function automaticOptionChanges(
  plan: PreservationReview,
  choices: PreserveTeamSetup,
): string[] {
  const chosen = new Set(choices.agentOptions?.map(({ agentName }) => agentKey(agentName)));
  return plan.agents.flatMap(({ name, reason, currentOption, option }) => {
    if (reason !== 'option_changed' || !option || chosen.has(agentKey(name))) return [];
    const sameName = eqName(currentOption?.configName, option.configName);
    const label = ({ providerName, configName }: PreservationOption) =>
      sameName ? optionLabel(providerName, configName) : configName;
    return [`${name} (${currentOption ? label(currentOption) : 'No option'} → ${label(option)})`];
  });
}

export type PreservationAddition = { teamName: string; agentName?: string };

/** The new teams that the request adds: the user's list, or the planner's selection before the first edit. */
export function addedTeamNames(choices: PreserveTeamSetup, plan: PreservationReview): string[] {
  return (
    choices.addTeams ??
    plan.additions.teams.filter(({ selected }) => selected).map(({ name }) => name)
  );
}

function teamAgentNames(team: PreservationReview['additions']['teams'][number]): string[] {
  return [...team.memberAgentNames, ...(team.teamLeadAgentName ? [team.teamLeadAgentName] : [])];
}

export function updatePreservationAdditions(
  choices: PreserveTeamSetup,
  plan: PreservationReview,
  addition: PreservationAddition,
  selected: boolean,
): PreserveTeamSetup {
  const { teamName, agentName } = addition;
  const addTeams = addedTeamNames(choices, plan);
  const addMembers = choices.addMembers ?? [];
  const next = agentName
    ? {
        ...choices,
        addMembers: selected
          ? [...addMembers, { teamName, agentName }]
          : addMembers.filter(
              (entry) => entry.teamName !== teamName || entry.agentName !== agentName,
            ),
      }
    : {
        ...choices,
        addTeams: selected ? [...addTeams, teamName] : addTeams.filter((name) => name !== teamName),
      };
  if (selected) return next;

  const removedTeam = plan.additions.teams.find((team) => team.name === teamName);
  const removed = new Set(
    (agentName ? [agentName] : removedTeam ? teamAgentNames(removedTeam) : []).map(agentKey),
  );
  const stillIncluded = new Set([
    ...plan.agents.filter(({ status }) => status !== 'new').map(({ name }) => agentKey(name)),
    ...(next.addMembers ?? []).map((entry) => agentKey(entry.agentName)),
    ...plan.additions.teams
      .filter((team) => addedTeamNames(next, plan).includes(team.name))
      .flatMap((team) => teamAgentNames(team).map(agentKey)),
  ]);
  return {
    ...next,
    ...(choices.agentOptions
      ? {
          agentOptions: choices.agentOptions.filter(
            ({ agentName: name }) =>
              !removed.has(agentKey(name)) || stillIncluded.has(agentKey(name)),
          ),
        }
      : {}),
  };
}
