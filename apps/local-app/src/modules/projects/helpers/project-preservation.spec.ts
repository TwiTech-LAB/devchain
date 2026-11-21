import { ExportSchema, type ExportDataInput } from '@devchain/shared';
import type { PreserveTeamSetup } from '../../../common/project-preservation.contract';
import { computeFamilyAlternatives, selectProfilesForFamilies } from './profile-mapping.helpers';
import {
  composePreservedRoster,
  resolvePreservedRoster,
  type CurrentTeamSetup,
} from './project-preservation';

const profileId = '10000000-0000-4000-a000-000000000001';
const installed = new Map([
  ['codex', 'provider-codex'],
  ['claude', 'provider-claude'],
]);
const agent = (name: string, fields: Partial<CurrentTeamSetup['agents'][number]> = {}) => ({
  id: name,
  name,
  profileId: 'local-profile',
  providerConfigId: 'local-config',
  description: 'Current description',
  isProjectOwner: false,
  modelOverride: null,
  effortOverride: null,
  ...fields,
});

function team(name: string, lead: string, members: string[]): CurrentTeamSetup['teams'][number] {
  return {
    id: name,
    name,
    projectId: 'project',
    description: null,
    teamLeadAgentId: lead,
    members: members.map((agentId) => ({ agentId, teamId: name, createdAt: '' })),
    maxMembers: 8,
    maxConcurrentTasks: 5,
    allowTeamLeadCreateAgents: false,
    profileIds: ['local-profile'],
    profileConfigSelections: [{ profileId: 'local-profile', configIds: ['local-config'] }],
    createdAt: '',
    updatedAt: '',
  };
}

function current(
  fields: Partial<CurrentTeamSetup['agents'][number]> = {},
  defaults: Partial<CurrentTeamSetup['configs'][number]> = {},
): CurrentTeamSetup {
  return {
    agents: [agent('Lead', fields), agent('Worker'), agent('Helper')],
    teams: [team('Planning', 'Lead', ['Lead', 'Worker', 'Helper'])],
    profiles: [{ id: 'local-profile', name: ' planner ' }],
    configs: [
      {
        id: 'local-config',
        profileId: 'local-profile',
        name: ' GPT ',
        providerId: 'provider-codex',
        model: 'old-model',
        effort: 'old-effort',
        ...defaults,
      },
    ],
  };
}

function template(
  option: Partial<
    NonNullable<ExportDataInput['profiles']>[number]['providerConfigs'] extends
      | Array<infer T>
      | undefined
      ? T
      : never
  > = {},
  targetAgent: Partial<NonNullable<ExportDataInput['agents']>[number]> = {},
): ExportDataInput {
  return {
    profiles: [
      {
        id: profileId,
        name: 'Planner',
        instructions: 'Template instructions',
        provider: { name: 'codex' },
        familySlug: 'planner',
        providerConfigs: [
          { name: 'gpt', providerName: 'codex', env: { EXAMPLE: 'never in review' }, ...option },
          { name: 'alternate', providerName: 'claude' },
        ],
      },
    ],
    agents: [{ name: ' lead ', profileId, providerConfigName: 'gpt', ...targetAgent }],
  };
}

function plan(
  target: ExportDataInput,
  live = current(),
  choices: PreserveTeamSetup = {},
  selectedProviders = installed,
  mappings?: Record<string, string>,
) {
  const roster = composePreservedRoster(ExportSchema.parse(target), live, choices);
  const selectedProfiles = selectProfilesForFamilies(
    roster.profiles,
    roster.agents,
    mappings,
    installed,
    {
      familySelectionProviders: selectedProviders,
    },
  );
  const familyAlternatives = computeFamilyAlternatives(
    roster.profiles,
    roster.agents,
    new Set(selectedProviders.keys()),
    undefined,
    new Set(installed.keys()),
  ).alternatives;
  return resolvePreservedRoster({
    roster,
    current: live,
    choices,
    selectedProfiles,
    familyAlternatives,
    installedProviders: installed,
    selectedProviders,
  });
}

// The planner's public inputs and outputs cover precedence without storage or HTTP fixtures.
describe('preserved settings planner', () => {
  it.each([
    {
      name: 'an incoming agent override stays explicit',
      incomingAgent: 'template-agent-model',
      incomingOption: 'template-option-model',
      oldOverride: 'old-override',
      oldDefault: 'old-default',
      value: 'template-agent-model',
      source: 'template-agent',
      stored: 'template-agent-model',
    },
    {
      name: 'an incoming option default is inherited',
      incomingAgent: ' ',
      incomingOption: 'template-option-model',
      oldOverride: 'old-override',
      oldDefault: 'old-default',
      value: 'template-option-model',
      source: 'template-option',
      stored: null,
    },
    {
      name: 'the old explicit value fills an empty incoming field',
      incomingAgent: null,
      incomingOption: ' ',
      oldOverride: 'old-override',
      oldDefault: 'old-default',
      value: 'old-override',
      source: 'retained',
      stored: 'old-override',
    },
    {
      name: 'the old inherited default becomes an explicit value',
      incomingAgent: undefined,
      incomingOption: null,
      oldOverride: ' ',
      oldDefault: 'old-default',
      value: 'old-default',
      source: 'retained',
      stored: 'old-default',
    },
    {
      name: 'an empty field stays unset',
      incomingAgent: null,
      incomingOption: ' ',
      oldOverride: null,
      oldDefault: ' ',
      value: null,
      source: 'unset',
      stored: null,
    },
  ])(
    '$name',
    ({ incomingAgent, incomingOption, oldOverride, oldDefault, value, source, stored }) => {
      const result = plan(
        template(
          { model: incomingOption, effort: 'target-effort' },
          { modelOverride: incomingAgent },
        ),
        current(
          { modelOverride: oldOverride, effortOverride: 'old-explicit-effort' },
          { model: oldDefault },
        ),
      );
      expect(result.issues).toEqual([]);
      expect(result.review.agents[0]).toMatchObject({
        status: 'kept',
        option: { configName: 'gpt', providerName: 'codex' },
        model: { value, source },
        effort: { value: 'target-effort', source: 'template-option' },
      });
      expect(result.agents[0]).toMatchObject({ modelOverride: stored, effortOverride: null });
      if (!incomingOption?.trim()) {
        const roster = composePreservedRoster(
          ExportSchema.parse(template({ model: incomingOption })),
          current(),
          {},
        );
        expect(roster.profiles[0].providerConfigs?.[0].model).toBeNull();
      }
    },
  );

  it.each([
    {
      label: 'the template agent option when the current option was renamed',
      change: { name: 'renamed' },
      templateOption: 'alternate',
      expected: { configName: 'alternate', providerName: 'claude' },
    },
    {
      label: 'the same option name on a different provider before the template agent option',
      change: { providerName: 'claude' },
      templateOption: 'alternate',
      expected: { configName: 'gpt', providerName: 'claude' },
    },
    {
      label: 'the first eligible option when the template agent has no named option',
      change: { name: 'renamed' },
      templateOption: null,
      expected: { configName: 'renamed', providerName: 'codex' },
    },
    {
      label: 'the first eligible option when the template agent option is unavailable',
      change: { name: 'renamed' },
      templateOption: 'renamed',
      selectedProviders: new Map([['claude', 'provider-claude']]),
      expected: { configName: 'alternate', providerName: 'claude' },
    },
  ])('selects $label', ({ change, templateOption, selectedProviders, expected }) => {
    const result = plan(
      template(change, { providerConfigName: templateOption }),
      current({ modelOverride: 'current-model', effortOverride: 'current-effort' }),
      {},
      selectedProviders,
    );
    expect(result.issues).toEqual([]);
    expect(result.review.agents[0]).toMatchObject({
      status: 'changed',
      reason: 'option_changed',
      currentOption: { configName: ' GPT ', providerName: 'codex' },
      option: expected,
      model: { value: null, source: 'unset' },
      effort: { value: null, source: 'unset' },
    });
    expect(result.agents[0]).toMatchObject({
      providerConfigName: expected.configName,
      modelOverride: null,
      effortOverride: null,
    });
  });

  it('uses the new option default and discards an override that belongs to a different binding', () => {
    const target = template({ model: 'same-option-model' }, { modelOverride: 'same-agent-model' });
    target.profiles![0].providerConfigs![1].model = 'alternate-model';
    const result = plan(target, current(), {
      agentOptions: [{ agentName: 'Lead', configName: 'alternate', providerName: 'claude' }],
    });
    expect(result.issues).toEqual([]);
    expect(result.review.agents[0]).toMatchObject({
      status: 'changed',
      model: { value: 'alternate-model', source: 'template-option' },
      effort: { value: null, source: 'unset' },
    });
    expect(result.agents[0]).toMatchObject({ modelOverride: null, effortOverride: null });
  });

  it('distinguishes missing profiles, no eligible options, and stale option choices', () => {
    const live = current();
    live.profiles[0].name = 'Missing';
    expect(plan(template(), live).issues[0]).toMatchObject({ code: 'preserve_profile_missing' });
    expect(plan(template(), current(), {}, new Map()).issues[0]).toMatchObject({
      code: 'preserve_no_eligible_options',
    });
    const stale = plan(template(), current(), {
      agentOptions: [{ agentName: 'Lead', configName: 'gpt', providerName: 'claude' }],
    });
    expect(stale.issues[0]).toMatchObject({ code: 'preserve_option_unavailable' });
  });
});

describe('preserved team roster', () => {
  it('gives duplicate normalized current names one import ID and keeps their team memberships', () => {
    const live = current();
    live.agents.splice(1, 0, agent(' lead ', { description: 'Duplicate description' }));
    live.teams.push(team('Second team', ' lead ', [' lead ', 'Worker']));

    const result = plan(template(), live);
    expect(result.issues).toEqual([]);
    expect(new Set(result.agents.map(({ id }) => id)).size).toBe(result.agents.length);
    expect(result.agents.map(({ name }) => name)).toEqual(['Lead', 'Worker', 'Helper']);
    expect(result.review.teams).toMatchObject([
      {
        name: 'Planning',
        teamLeadAgentName: 'Lead',
        memberAgentNames: ['Lead', 'Worker', 'Helper'],
      },
      { name: 'Second team', teamLeadAgentName: 'Lead', memberAgentNames: ['Lead', 'Worker'] },
    ]);
  });

  it.each([
    {
      name: 'a member of a retained team whose option is missing',
      teamName: 'Planning',
      option: 'retired',
      choices: { addMembers: [{ teamName: 'Planning', agentName: 'Extra' }] },
    },
    {
      name: 'a member of a selected team whose option provider is deselected',
      teamName: 'New team',
      option: 'alternate',
      choices: { addTeams: ['New team'] },
    },
  ])('requires an explicit repair for $name', ({ teamName, option, choices }) => {
    const target = template();
    target.agents!.push(
      { name: 'Extra', profileId, providerConfigName: option },
      { name: 'Standalone', profileId, providerConfigName: option },
    );
    target.teams = [{ name: teamName, memberAgentNames: ['Extra'] }];
    const providers = new Map([['codex', 'provider-codex']]);

    const unresolved = plan(target, current(), choices, providers);
    expect(unresolved.issues).toEqual([
      expect.objectContaining({
        code: 'preserve_option_required',
        details: { agentName: 'Extra', profileName: 'Planner' },
      }),
    ]);
    expect(unresolved.review.agents.find(({ name }) => name === 'Extra')).toMatchObject({
      status: 'new',
      reason: 'preserve_option_required',
      option: null,
      eligibleOptions: [{ configName: 'gpt', providerName: 'codex' }],
    });
    expect(unresolved.agents.find(({ name }) => name === 'Standalone')?.providerConfigName).toBe(
      'gpt',
    );

    const repaired = plan(
      target,
      current(),
      {
        ...choices,
        agentOptions: [{ agentName: 'Extra', configName: 'gpt', providerName: 'codex' }],
      },
      providers,
    );
    expect(repaired.issues).toEqual([]);
    expect(repaired.agents.find(({ name }) => name === 'Extra')?.providerConfigName).toBe('gpt');
  });

  it('keeps current-only teams, shares agents across memberships, and appends selected additions', () => {
    const live = current({ isProjectOwner: true });
    live.teams.push(team('Current Only', 'Worker', ['Worker']));
    const target = template();
    target.agents!.push(
      { name: 'Extra', profileId, providerConfigName: 'gpt' },
      { name: 'New Team Lead', profileId, providerConfigName: 'gpt' },
      { name: 'Standalone', profileId, providerConfigName: 'gpt' },
    );
    target.teams = [
      {
        name: ' planning ',
        memberAgentNames: ['Extra'],
        teamLeadAgentName: 'Extra',
        maxMembers: 2,
      },
      {
        name: 'New Team',
        memberAgentNames: ['New Team Lead', 'Extra'],
        teamLeadAgentName: 'New Team Lead',
      },
    ];

    const initial = plan(target, live);
    expect(initial.issues).toEqual([]);
    expect(initial.agents.map(({ name }) => name)).toEqual([
      'Lead',
      'Worker',
      'Helper',
      'Standalone',
    ]);
    expect(initial.review.teams).toMatchObject([
      {
        name: 'Planning',
        teamLeadAgentName: 'Lead',
        memberAgentNames: ['Lead', 'Worker', 'Helper'],
        maxMembers: 8,
        maxConcurrentTasks: 5,
        allowTeamLeadCreateAgents: false,
        permissions: [{ profileName: 'Planner', configNames: ['gpt'] }],
      },
      { name: 'Current Only', teamLeadAgentName: 'Worker', memberAgentNames: ['Worker'] },
    ]);
    expect(initial.review.additions).toMatchObject({
      teams: [{ name: 'New Team', selected: false }],
      members: [{ teamName: 'Planning', agentName: 'Extra', selected: false }],
    });
    expect(initial.agents[0]).toMatchObject({
      description: 'Current description',
      isProjectOwner: true,
    });
    expect(JSON.stringify(initial.review)).not.toContain('never in review');

    const result = plan(target, live, {
      addTeams: ['new team'],
      addMembers: [{ teamName: 'Planning', agentName: ' Extra ' }],
    });
    expect(result.issues).toEqual([]);
    expect(result.review.teams).toMatchObject([
      {
        name: 'Planning',
        teamLeadAgentName: 'Lead',
        memberAgentNames: ['Lead', 'Worker', 'Helper', 'Extra'],
      },
      { name: 'Current Only' },
      {
        name: 'New Team',
        teamLeadAgentName: 'New Team Lead',
        memberAgentNames: ['New Team Lead', 'Extra'],
      },
    ]);
    expect(result.agents.filter(({ name }) => name === 'Extra')).toHaveLength(1);
    expect(new Set(result.agents.map(({ id }) => id)).size).toBe(result.agents.length);
  });

  it('composes current-only families before resolving the selected family profile', () => {
    const target = template();
    target.profiles![0].providerConfigs!.pop();
    const siblingId = '10000000-0000-4000-a000-000000000002';
    target.profiles!.push({
      id: siblingId,
      name: 'Alternate Planner',
      familySlug: 'planner',
      provider: { name: 'claude' },
      providerConfigs: [{ name: 'review', providerName: 'claude' }],
    });
    target.profiles!.push({
      id: '10000000-0000-4000-a000-000000000003',
      name: 'Unused',
      familySlug: 'unused',
      provider: { name: 'codex' },
    });
    target.agents = [{ name: 'Unselected', profileId: target.profiles![2].id }];
    target.teams = [{ name: 'Template Only', memberAgentNames: ['Unselected'] }];

    const result = plan(target, current(), {}, installed, { planner: 'claude' });
    expect(result.review.familyAlternatives.map(({ familySlug }) => familySlug)).toEqual([
      'planner',
    ]);
    expect(result.review.agents[0]).toMatchObject({
      name: 'Lead',
      profileName: 'Alternate Planner',
      status: 'changed',
      eligibleOptions: [{ configName: 'review', providerName: 'claude' }],
    });
    expect(result.review.teams[0]).toMatchObject({ permissions: [], permissionsChanged: true });
  });

  it('blocks an addition that would exceed current capacity without counting the lead', () => {
    const live = current();
    live.teams[0].maxMembers = 2;
    live.teams[0].maxConcurrentTasks = 2;
    const target = template();
    target.agents!.push({ name: 'Extra', profileId, providerConfigName: 'gpt' });
    target.teams = [{ name: 'Planning', memberAgentNames: ['Extra'] }];
    expect(plan(target, live).issues).toEqual([]);
    const result = plan(target, live, {
      addMembers: [{ teamName: 'Planning', agentName: 'Extra' }],
    });
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'preserve_team_roster', details: { teamName: 'Planning' } }),
    ]);
  });
});
