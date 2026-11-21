import type { ExportData } from '@devchain/shared';
import type {
  FamilyAlternative,
  TeamPermissionChoice,
  PreservationAgentIssueCode,
  PreservationAgentRow,
  PreservationField,
  PreservationIssue,
  PreservationOption,
  PreservationProfilePermission,
  PreservationReview,
  PreservationTeamRow,
  PreserveTeamSetup,
} from '../../../common/project-preservation.contract';
import type {
  Agent,
  AgentProfile,
  ProfileProviderConfig,
} from '../../storage/models/domain.models';
import type { TeamsService } from '../../teams/services/teams.service';
import {
  hasAvailableProfileOption,
  type selectProfilesForFamilies,
} from './profile-mapping.helpers';

type TemplateAgent = ExportData['agents'][number];
type TemplateProfile = ExportData['profiles'][number];
type TemplateTeam = ExportData['teams'][number];
type CurrentTeam = NonNullable<Awaited<ReturnType<TeamsService['getTeam']>>>;
type CurrentAgent = Pick<
  Agent,
  | 'id'
  | 'name'
  | 'profileId'
  | 'providerConfigId'
  | 'description'
  | 'isProjectOwner'
  | 'modelOverride'
  | 'effortOverride'
>;
type CurrentOption = Pick<
  ProfileProviderConfig,
  'id' | 'profileId' | 'name' | 'providerId' | 'model' | 'effort'
>;
type TargetOption = PreservationOption & { model?: string | null; effort?: string | null };
type SelectedProfiles = ReturnType<typeof selectProfilesForFamilies<TemplateProfile>>;

export interface CurrentTeamSetup {
  teams: CurrentTeam[];
  agents: CurrentAgent[];
  profiles: Array<Pick<AgentProfile, 'id' | 'name'>>;
  configs: CurrentOption[];
}

interface AgentCandidate {
  agent: TemplateAgent & { id: string };
  current?: CurrentAgent;
  currentProfileName?: string;
  incoming?: TemplateAgent;
  teamAddition?: boolean;
}

interface TeamCandidate {
  team: TemplateTeam;
  current?: CurrentTeam;
}

const key = (value: string) => value.trim().toLowerCase();
const nonEmpty = (value: string | null | undefined) => (value?.trim() ? value : null);
const byName = <T extends { name: string }>(rows: T[]) =>
  new Map(rows.map((row) => [key(row.name), row]));
const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((row) => [row.id, row]));

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const normalized = key(name);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function composeTeams(
  templateTeams: TemplateTeam[],
  current: CurrentTeamSetup,
  choices: PreserveTeamSetup,
) {
  const agents = byId(current.agents);
  const incoming = byName(templateTeams);
  const currentTeams = byName(current.teams);
  const selectedTeams = new Set((choices.addTeams ?? []).map(key));
  const selectedMembers = new Map<string, Set<string>>();
  for (const { teamName, agentName } of choices.addMembers ?? []) {
    const teamKey = key(teamName);
    const names = selectedMembers.get(teamKey) ?? new Set<string>();
    names.add(key(agentName));
    selectedMembers.set(teamKey, names);
  }

  const issues: PreservationIssue[] = [];
  const teams: TeamCandidate[] = [];
  const retainedAgentNames = new Set<string>();
  const members: PreservationReview['additions']['members'] = [];
  const optionalTeams: PreservationReview['additions']['teams'] = [];

  for (const teamName of choices.addTeams ?? []) {
    if (!incoming.has(key(teamName)) || currentTeams.has(key(teamName))) {
      issues.push({
        code: 'preserve_invalid_addition',
        message: `Team "${teamName}" is not an available template addition. Review the team selections.`,
        details: { teamName },
      });
    }
  }

  for (const team of current.teams) {
    const teamLeadAgentName = team.teamLeadAgentId
      ? (agents.get(team.teamLeadAgentId)?.name ?? null)
      : null;
    const currentMembers = team.members.flatMap(({ agentId }) => {
      const agent = agents.get(agentId);
      return agent ? [agent.name] : [];
    });
    if (
      currentMembers.length !== team.members.length ||
      (team.teamLeadAgentId && !teamLeadAgentName)
    ) {
      issues.push({
        code: 'preserve_team_roster',
        message: `Team "${team.name}" references a missing current member or lead. Refresh the team and check again.`,
        details: { teamName: team.name },
      });
    }

    const currentMemberNames = new Set(currentMembers.map(key));
    for (const name of currentMemberNames) retainedAgentNames.add(name);
    if (teamLeadAgentName) retainedAgentNames.add(key(teamLeadAgentName));
    const proposedMembers = uniqueNames(
      incoming.get(key(team.name))?.memberAgentNames ?? [],
    ).filter((name) => !currentMemberNames.has(key(name)));
    for (const agentName of proposedMembers) {
      members.push({
        teamName: team.name,
        agentName,
        selected: selectedMembers.get(key(team.name))?.has(key(agentName)) ?? false,
      });
    }
    const proposed = new Set(proposedMembers.map(key));
    for (const agentName of selectedMembers.get(key(team.name)) ?? []) {
      if (!proposed.has(agentName)) {
        issues.push({
          code: 'preserve_invalid_addition',
          message: `"${agentName}" is not an available template member for "${team.name}". Review the member selections.`,
          details: { teamName: team.name, agentName },
        });
      }
    }

    teams.push({
      current: team,
      team: {
        name: team.name,
        description: team.description,
        teamLeadAgentName,
        memberAgentNames: uniqueNames([
          ...currentMembers,
          ...proposedMembers.filter((name) => selectedMembers.get(key(team.name))?.has(key(name))),
        ]),
        maxMembers: team.maxMembers,
        maxConcurrentTasks: team.maxConcurrentTasks,
        allowTeamLeadCreateAgents: team.allowTeamLeadCreateAgents,
        profileNames: [],
      },
    });
  }

  for (const { teamName, agentName } of choices.addMembers ?? []) {
    if (!currentTeams.has(key(teamName))) {
      issues.push({
        code: 'preserve_invalid_addition',
        message: `"${teamName}" is not a current team. Select the template team to include its proposed roster.`,
        details: { teamName, agentName },
      });
    }
  }

  for (const team of templateTeams) {
    if (currentTeams.has(key(team.name))) continue;
    const selected = selectedTeams.has(key(team.name));
    const memberAgentNames = uniqueNames(team.memberAgentNames);
    optionalTeams.push({
      name: team.name,
      teamLeadAgentName: team.teamLeadAgentName ?? null,
      memberAgentNames,
      selected,
    });
    if (selected) teams.push({ team: { ...team, memberAgentNames } });
  }

  return { teams, retainedAgentNames, additions: { teams: optionalTeams, members }, issues };
}

export function composePreservedRoster(
  template: ExportData,
  current: CurrentTeamSetup,
  choices: PreserveTeamSetup,
) {
  const roster = composeTeams(template.teams, current, choices);
  const teamAgentKeys = (team: TemplateTeam) => {
    const names = team.memberAgentNames.map(key);
    if (team.teamLeadAgentName) names.push(key(team.teamLeadAgentName));
    return names;
  };
  const incomingMembers = new Set(template.teams.flatMap(teamAgentKeys));
  const includedMembers = new Set(roster.teams.flatMap(({ team }) => teamAgentKeys(team)));
  const localProfiles = byId(current.profiles);
  const profiles = template.profiles.map((profile, index) => ({
    ...profile,
    id: profile.id ?? `preserve-profile:${index}`,
    providerConfigs: profile.providerConfigs?.map((config) => ({
      ...config,
      model: nonEmpty(config.model),
      effort: nonEmpty(config.effort),
    })),
  }));
  const targetProfiles = byName(profiles);
  const incomingAgents = byName(template.agents);
  const candidates = new Map<string, AgentCandidate>();

  for (const agent of current.agents) {
    const name = key(agent.name);
    if (!roster.retainedAgentNames.has(name) || candidates.has(name)) continue;
    const currentProfileName = localProfiles.get(agent.profileId)?.name;
    candidates.set(name, {
      current: agent,
      currentProfileName,
      incoming: incomingAgents.get(name),
      agent: {
        id: `preserve-agent:${candidates.size}`,
        name: agent.name,
        description: agent.description,
        isProjectOwner: agent.isProjectOwner,
        profileId: currentProfileName ? targetProfiles.get(key(currentProfileName))?.id : undefined,
      },
    });
  }

  for (const incoming of template.agents) {
    const name = key(incoming.name);
    if (candidates.has(name) || (incomingMembers.has(name) && !includedMembers.has(name))) continue;
    candidates.set(name, {
      incoming,
      teamAddition: includedMembers.has(name),
      agent: { ...incoming, id: `preserve-agent:${candidates.size}` },
    });
  }

  return {
    ...roster,
    profiles,
    candidates,
    agents: Array.from(candidates.values(), ({ agent }) => agent),
  };
}

export function preservedProfileDependencyIds(
  roster: ReturnType<typeof composePreservedRoster>,
  current: CurrentTeamSetup,
  choices: PreserveTeamSetup,
  watchers: ExportData['watchers'],
  selectedProviders: ReadonlyMap<string, string>,
): Set<string> {
  const names = new Set(
    watchers.flatMap((watcher) =>
      watcher.scope === 'profile' && watcher.scopeFilterName ? [key(watcher.scopeFilterName)] : [],
    ),
  );
  const localProfiles = byId(current.profiles);
  const permissions = new Map(
    (choices.teamPermissions ?? []).map((choice) => [key(choice.teamName), choice]),
  );
  for (const { team, current: existing } of roster.teams) {
    const overrides = permissions.get(key(team.name))?.profiles;
    const profileNames = overrides
      ? overrides.map(({ profileName }) => profileName)
      : existing
        ? existing.profileIds.flatMap((id) => {
            const profile = localProfiles.get(id);
            return profile ? [profile.name] : [];
          })
        : [
            ...team.profileNames,
            ...(team.profileSelections ?? []).map(({ profileName }) => profileName),
          ];
    for (const name of profileNames) names.add(key(name));
  }

  const selectableFamilies = new Set(
    roster.profiles.flatMap((profile) =>
      profile.familySlug && hasAvailableProfileOption(profile, selectedProviders)
        ? [profile.familySlug]
        : [],
    ),
  );
  // Families that only back permissions or watchers need a provider choice only when they
  // have a selectable option. Their bindings still resolve against all installed options.
  return new Set(
    roster.profiles.flatMap(({ id, name, familySlug }) =>
      familySlug && selectableFamilies.has(familySlug) && names.has(key(name)) ? [id] : [],
    ),
  );
}

function checkPreservedProfileConflicts(
  sourceProfiles: TemplateProfile[],
  profiles: TemplateProfile[],
  installedProviders: Map<string, string>,
): PreservationIssue[] {
  const issues: PreservationIssue[] = [];
  const chosenIds = new Set(profiles.map(({ id }) => id));
  const chosenFamilies = new Map(
    profiles.flatMap((profile) =>
      profile.familySlug ? [[profile.familySlug, profile.id] as const] : [],
    ),
  );
  const claims = new Map<string, { name: string; target?: string }>();
  const check = (
    field: 'id' | 'name' | 'familySlug',
    value: string,
    name: string,
    target?: string,
  ) => {
    const claim = `${field}:${field === 'id' ? value : key(value)}`;
    const previous = claims.get(claim);
    if (!previous) {
      claims.set(claim, { name, target });
    } else if (!target || target !== previous.target) {
      issues.push({
        code: 'preserve_profile_conflict',
        message: `Profiles "${previous.name}" and "${name}" have a conflicting ${field === 'familySlug' ? 'family slug' : field} "${value}". Correct the template before replacing the project.`,
        details: { field, profileNames: [previous.name, name], value },
      });
    }
  };
  for (const profile of sourceProfiles) {
    if (profile.id && chosenIds.has(profile.id)) check('id', profile.id, profile.name);
    const target = profile.familySlug
      ? chosenFamilies.get(profile.familySlug)
      : chosenIds.has(profile.id)
        ? profile.id
        : undefined;
    if (target) check('name', profile.name, profile.name, target);
  }
  for (const profile of profiles) {
    if (profile.familySlug != null) check('familySlug', profile.familySlug, profile.name);

    const positions = new Map<number, string>();
    let maxPosition: number | undefined;
    for (const config of profile.providerConfigs ?? []) {
      if (!installedProviders.has(key(config.providerName))) continue;
      const position = config.position ?? (maxPosition ?? -1) + 1;
      const previous = positions.get(position);
      if (previous !== undefined) {
        issues.push({
          code: 'preserve_profile_conflict',
          message: `Options "${previous}" and "${config.name}" in "${profile.name}" share position ${position}. Give the options distinct positions in the template.`,
          details: { field: 'optionPosition', profileNames: [profile.name], value: position },
        });
      }
      positions.set(position, config.name);
      maxPosition = maxPosition === undefined ? position : Math.max(maxPosition, position);
    }
  }
  return issues;
}

function optionDefinitions(profile: TemplateProfile | undefined): TargetOption[] {
  if (!profile) return [];
  return profile.providerConfigs?.length
    ? profile.providerConfigs.map(({ name, providerName, model, effort }) => ({
        configName: name,
        providerName,
        model,
        effort,
      }))
    : [{ configName: 'default', providerName: profile.provider.name }];
}

function publicOption({ configName, providerName }: PreservationOption): PreservationOption {
  return { configName, providerName };
}

function sameOption(left: PreservationOption, right: PreservationOption): boolean {
  return (
    key(left.configName) === key(right.configName) &&
    key(left.providerName) === key(right.providerName)
  );
}

function optionNamed(options: TargetOption[], name: string): TargetOption | undefined {
  return options.find((option) => key(option.configName) === key(name));
}

function resolveField(
  incomingOverride: string | null | undefined,
  incomingDefault: string | null | undefined,
  currentValue: string | null,
): { field: PreservationField; override: string | null } {
  const explicit = nonEmpty(incomingOverride);
  if (explicit) return { field: { value: explicit, source: 'template-agent' }, override: explicit };
  const inherited = nonEmpty(incomingDefault);
  if (inherited) return { field: { value: inherited, source: 'template-option' }, override: null };
  return {
    field: { value: currentValue, source: currentValue ? 'retained' : 'unset' },
    override: currentValue,
  };
}

function resolveAgent(
  candidate: AgentCandidate,
  profile: TemplateProfile | undefined,
  sourceProfile: TemplateProfile | undefined,
  incomingProfile: TemplateProfile | undefined,
  eligibleOptions: TargetOption[],
  config: CurrentOption | undefined,
  providerName: string | undefined,
  choice: PreservationOption | undefined,
  issues: PreservationIssue[],
): { agent: TemplateAgent; row: PreservationAgentRow } {
  const { agent, current, incoming } = candidate;
  const currentOption = config && providerName ? { configName: config.name, providerName } : null;
  const templateOptionName = incoming?.providerConfigName;
  const optionInResolvedProfile = templateOptionName
    ? optionNamed(eligibleOptions, templateOptionName)
    : eligibleOptions[0];
  const originalIncomingOption = templateOptionName
    ? optionNamed(optionDefinitions(sourceProfile), templateOptionName)
    : undefined;

  let issue: PreservationAgentIssueCode | undefined;
  let option: TargetOption | undefined;
  if (!profile) {
    issue = 'preserve_profile_missing';
  } else if (eligibleOptions.length === 0) {
    issue = 'preserve_no_eligible_options';
  } else if (choice) {
    option = eligibleOptions.find((eligible) => sameOption(eligible, choice));
    if (!option) issue = 'preserve_option_unavailable';
  } else if (current) {
    // The same binding, then the same name, then the template's option, then the first eligible.
    option =
      (currentOption && eligibleOptions.find((eligible) => sameOption(eligible, currentOption))) ??
      (config && optionNamed(eligibleOptions, config.name)) ??
      optionInResolvedProfile ??
      eligibleOptions[0];
  } else if (candidate.teamAddition && templateOptionName && !optionInResolvedProfile) {
    issue = 'preserve_option_required';
  } else {
    option = optionInResolvedProfile ?? eligibleOptions[0];
  }

  const profileName = profile?.name ?? candidate.currentProfileName ?? sourceProfile?.name ?? null;
  if (issue) {
    const messages: Record<PreservationAgentIssueCode, string> = {
      preserve_profile_missing: `The target template has no matching profile for "${agent.name}"${profileName ? ` ("${profileName}")` : ''}. Use a template with that profile.`,
      preserve_no_eligible_options: `"${agent.name}" has no eligible options in "${profileName}". Select or install a provider for this profile.`,
      preserve_option_unavailable: `The selected option for "${agent.name}" is no longer eligible. Select an available option.`,
      preserve_option_required: `The template option "${templateOptionName}" for "${agent.name}" is unavailable in "${profileName}". Select an available option.`,
    };
    issues.push({
      code: issue,
      message: messages[issue],
      details: { agentName: agent.name, profileName },
    });
  }

  const bindingRetained = Boolean(option && currentOption && sameOption(option, currentOption));
  const templateBindingMatches = Boolean(
    option &&
      optionInResolvedProfile &&
      profile?.id === incomingProfile?.id &&
      sameOption(option, optionInResolvedProfile) &&
      (!originalIncomingOption || sameOption(option, originalIncomingOption)),
  );
  const model = resolveField(
    templateBindingMatches ? incoming?.modelOverride : null,
    option?.model,
    bindingRetained ? (nonEmpty(current?.modelOverride) ?? nonEmpty(config?.model)) : null,
  );
  const effort = resolveField(
    templateBindingMatches ? incoming?.effortOverride : null,
    option?.effort,
    bindingRetained ? (nonEmpty(current?.effortOverride) ?? nonEmpty(config?.effort)) : null,
  );

  return {
    agent: {
      ...agent,
      providerConfigName: option?.configName ?? null,
      modelOverride: model.override,
      effortOverride: effort.override,
    },
    row: {
      name: agent.name,
      profileName,
      status: current ? (bindingRetained ? 'kept' : 'changed') : 'new',
      reason: issue ?? (current && !bindingRetained ? 'option_changed' : undefined),
      currentOption,
      option: option ? publicOption(option) : null,
      eligibleOptions: eligibleOptions.map(publicOption),
      model: model.field,
      effort: effort.field,
    },
  };
}

interface PermissionInput {
  profileName: string;
  options: null | Array<{ configName: string; providerName?: string }>;
}

function requestedPermissions(
  candidate: TeamCandidate,
  choice: TeamPermissionChoice | undefined,
  localProfiles: Map<string, { name: string }>,
  localConfigs: Map<string, CurrentOption>,
  providerNames: Map<string, string>,
): PermissionInput[] {
  if (choice?.profiles) {
    return choice.profiles.map(({ profileName, configNames }) => ({
      profileName,
      options: configNames.length ? configNames.map((configName) => ({ configName })) : null,
    }));
  }

  const { current, team } = candidate;
  if (!current) {
    const selections = new Map(
      (team.profileSelections ?? []).map((entry) => [key(entry.profileName), entry.configNames]),
    );
    return uniqueNames([
      ...team.profileNames,
      ...(team.profileSelections ?? []).map((entry) => entry.profileName),
    ]).map((profileName) => ({
      profileName,
      options: selections.get(key(profileName))?.map((configName) => ({ configName })) ?? null,
    }));
  }

  const restrictions = new Map(
    current.profileConfigSelections.map((entry) => [entry.profileId, entry.configIds]),
  );
  return current.profileIds.map((id) => {
    const configIds = restrictions.get(id);
    return {
      profileName: localProfiles.get(id)?.name ?? '',
      options:
        configIds?.map((configId) => {
          const config = localConfigs.get(configId);
          return {
            configName: config?.profileId === id ? config.name : '',
            providerName: config ? (providerNames.get(config.providerId) ?? '') : '',
          };
        }) ?? null,
    };
  });
}

function resolveTeam(
  candidate: TeamCandidate,
  choice: TeamPermissionChoice | undefined,
  requested: PermissionInput[],
  resolveProfile: (name: string) => TemplateProfile | undefined,
  optionsByProfile: Map<string, TargetOption[]>,
  agents: Map<string, AgentCandidate>,
  issues: PreservationIssue[],
): { team: TemplateTeam; row: PreservationTeamRow } {
  const { team, current } = candidate;
  const lead = team.teamLeadAgentName ?? null;
  const members = team.memberAgentNames.map((name) => agents.get(key(name))?.agent.name ?? name);
  const maxMembers = team.maxMembers ?? 5;
  const maxConcurrentTasks = team.maxConcurrentTasks ?? maxMembers;
  const missingMembers = members.filter((name) => !agents.has(key(name)));
  const invalidLead = lead && !members.some((name) => key(name) === key(lead));
  const countWithoutLead = members.length - (lead && !invalidLead ? 1 : 0);

  const problems: string[] = [];
  if (!members.length) problems.push('include at least one member');
  if (invalidLead) problems.push(`include the lead "${lead}" as a member`);
  if (missingMembers.length) problems.push(`provide agents for ${missingMembers.join(', ')}`);
  if (countWithoutLead > maxMembers)
    problems.push(`select at most ${maxMembers} members besides the lead`);
  if (maxConcurrentTasks > maxMembers)
    problems.push('use a concurrency limit within the member limit');
  if (problems.length) {
    issues.push({
      code: 'preserve_team_roster',
      message: `To import team "${team.name}", ${problems.join(', ')}.`,
      details: { teamName: team.name },
    });
  }

  let permissionsChanged = false;
  const permissions = new Map<string, PreservationProfilePermission>();
  for (const permission of requested) {
    const profile = resolveProfile(permission.profileName);
    const options = profile?.id ? (optionsByProfile.get(profile.id) ?? []) : [];
    const configNames = permission.options?.flatMap((entry) => {
      const option = options.find(
        (candidate) =>
          key(candidate.configName) === key(entry.configName) &&
          (entry.providerName === undefined ||
            key(candidate.providerName) === key(entry.providerName)),
      );
      return option ? [option.configName] : [];
    });
    const incompatible =
      !options.length ||
      (configNames !== undefined && configNames.length !== permission.options?.length);
    if (incompatible) {
      permissionsChanged = true;
      if (choice?.profiles || !current) {
        issues.push({
          code: 'preserve_team_permissions',
          message: `Team "${team.name}" has unavailable permissions for "${permission.profileName}". Select compatible profile options.`,
          details: { teamName: team.name, profileName: permission.profileName },
        });
      }
    }
    if (!profile || !options.length || configNames?.length === 0) continue;
    if (key(profile.name) !== key(permission.profileName)) permissionsChanged = true;
    const previous = permissions.get(key(profile.name));
    const combined =
      previous && configNames && previous.configNames.length
        ? uniqueNames([...previous.configNames, ...configNames])
        : previous
          ? []
          : (configNames ?? []);
    permissions.set(key(profile.name), { profileName: profile.name, configNames: combined });
  }

  const resolvedPermissions = [...permissions.values()];
  const allowTeamLeadCreateAgents =
    choice?.allowTeamLeadCreateAgents ?? team.allowTeamLeadCreateAgents;
  const roster = {
    memberAgentNames: members,
    teamLeadAgentName: lead ? (agents.get(key(lead))?.agent.name ?? lead) : null,
    maxMembers,
    maxConcurrentTasks,
    allowTeamLeadCreateAgents,
  };
  return {
    team: {
      ...team,
      ...roster,
      profileNames: resolvedPermissions.map(({ profileName }) => profileName),
      profileSelections: resolvedPermissions.filter(({ configNames }) => configNames.length > 0),
    },
    row: {
      ...roster,
      name: team.name,
      retained: Boolean(current),
      permissions: resolvedPermissions,
      permissionsChanged,
    },
  };
}

export function resolvePreservedRoster(input: {
  roster: ReturnType<typeof composePreservedRoster>;
  current: CurrentTeamSetup;
  choices: PreserveTeamSetup;
  selectedProfiles: SelectedProfiles;
  familyAlternatives: FamilyAlternative[];
  installedProviders: Map<string, string>;
  selectedProviders: Map<string, string>;
}): {
  agents: TemplateAgent[];
  teams: TemplateTeam[];
  review: PreservationReview;
  issues: PreservationIssue[];
} {
  const { roster, current, choices, selectedProfiles, installedProviders, selectedProviders } =
    input;
  const issues = [
    ...roster.issues,
    ...checkPreservedProfileConflicts(
      roster.profiles,
      selectedProfiles.profilesToCreate,
      installedProviders,
    ),
  ];
  const originalProfiles = byId(roster.profiles);
  const persistedProfiles = new Map(
    selectedProfiles.profilesToCreate.map((profile) => [profile.id, profile]),
  );
  const familyProfiles = new Map(
    selectedProfiles.profilesToCreate.flatMap((profile) =>
      profile.familySlug ? [[profile.familySlug, profile] as const] : [],
    ),
  );
  const resolveProfile = (profile: TemplateProfile | undefined) =>
    profile?.familySlug
      ? familyProfiles.get(profile.familySlug)
      : persistedProfiles.get(profile?.id);

  const originalProfilesByName = byName(roster.profiles);
  const localProfiles = byId(current.profiles);
  const localConfigs = byId(current.configs);
  const providerNames = new Map([...installedProviders].map(([name, id]) => [id, name]));
  const optionsByProfile = new Map(
    selectedProfiles.profilesToCreate.flatMap((profile) => {
      if (!profile.id) return [];
      const options = optionDefinitions(originalProfiles.get(profile.id)).filter(
        ({ providerName }) => installedProviders.has(key(providerName)),
      );
      const seen = new Set<string>();
      const duplicates = options.flatMap(({ configName }) => {
        const normalized = key(configName);
        if (seen.has(normalized)) return [configName];
        seen.add(normalized);
        return [];
      });
      if (duplicates.length) {
        issues.push({
          code: 'preserve_ambiguous_options',
          message: `Profile "${profile.name}" has options with the same name. Give each option a unique name in the template.`,
          details: { profileName: profile.name, configNames: uniqueNames(duplicates) },
        });
      }
      return [[profile.id, options] as const];
    }),
  );

  const { candidates } = roster;
  const optionChoices = new Map(
    (choices.agentOptions ?? []).map((choice) => [key(choice.agentName), choice]),
  );
  const unknownAgents = (choices.agentOptions ?? [])
    .filter(({ agentName }) => !candidates.has(key(agentName)))
    .map(({ agentName }) => agentName);
  if (unknownAgents.length) {
    issues.push({
      code: 'preserve_unknown_agent',
      message: `These option selections reference agents outside the roster: ${unknownAgents.join(', ')}. Review the selections.`,
      details: { agentNames: unknownAgents },
    });
  }
  const ownerNames = roster.agents
    .filter(({ isProjectOwner }) => isProjectOwner)
    .map(({ name }) => name);
  if (ownerNames.length > 1) {
    issues.push({
      code: 'preserve_multiple_owners',
      message: `The roster would have multiple project owners: ${ownerNames.join(', ')}. Remove the addition or change the current owner.`,
      details: { agentNames: ownerNames },
    });
  }

  const resolvedAgents = Array.from(candidates.values(), (candidate) => {
    const { agent, incoming } = candidate;
    const profileId = selectedProfiles.agentProfileMap.get(agent.id) ?? agent.profileId;
    const targetProfile = profileId ? originalProfiles.get(profileId) : undefined;
    const persistedProfile = persistedProfiles.get(profileId);
    const sourceProfile = incoming?.profileId
      ? originalProfiles.get(incoming.profileId)
      : undefined;
    const options = optionDefinitions(targetProfile);
    const eligibleOptions = persistedProfile
      ? options.filter(({ providerName }) => selectedProviders.has(key(providerName)))
      : [];
    const storedConfig = candidate.current && localConfigs.get(candidate.current.providerConfigId);
    const config =
      storedConfig?.profileId === candidate.current?.profileId ? storedConfig : undefined;
    return resolveAgent(
      candidate,
      persistedProfile ?? targetProfile,
      sourceProfile,
      resolveProfile(sourceProfile),
      eligibleOptions,
      config,
      config && providerNames.get(config.providerId),
      optionChoices.get(key(agent.name)),
      issues,
    );
  });

  const permissionChoices = new Map(
    (choices.teamPermissions ?? []).map((choice) => [key(choice.teamName), choice]),
  );
  const includedTeams = new Set(roster.teams.map(({ team }) => key(team.name)));
  for (const { teamName } of choices.teamPermissions ?? []) {
    if (!includedTeams.has(key(teamName))) {
      issues.push({
        code: 'preserve_team_permissions',
        message: `Team "${teamName}" is outside the roster. Include the team or remove its permission selection.`,
        details: { teamName },
      });
    }
  }
  const resolvedTeams = roster.teams.map((candidate) => {
    const choice = permissionChoices.get(key(candidate.team.name));
    return resolveTeam(
      candidate,
      choice,
      requestedPermissions(candidate, choice, localProfiles, localConfigs, providerNames),
      (name) => resolveProfile(originalProfilesByName.get(key(name))),
      optionsByProfile,
      candidates,
      issues,
    );
  });

  return {
    agents: resolvedAgents.map(({ agent }) => agent),
    teams: resolvedTeams.map(({ team }) => team),
    issues,
    review: {
      agents: resolvedAgents.map(({ row }) => row),
      teams: resolvedTeams.map(({ row }) => row),
      additions: roster.additions,
      familyAlternatives: input.familyAlternatives,
      eligiblePermissions: selectedProfiles.profilesToCreate.flatMap(({ id, name }) => {
        const options = id ? (optionsByProfile.get(id) ?? []) : [];
        return options.length ? [{ profileName: name, options: options.map(publicOption) }] : [];
      }),
    },
  };
}
