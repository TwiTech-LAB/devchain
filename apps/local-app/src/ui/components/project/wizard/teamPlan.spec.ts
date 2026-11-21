import type { SetupPreviewResponse } from '@/ui/pages/projects/lib/project-contracts';
import {
  buildTeamOverrides,
  configurableTeams,
  initialTeamStates,
  templateTeamStates,
  type ParsedTemplateTeam,
  type TeamPanelState,
} from './teamPlan';

function team(over: Partial<ParsedTemplateTeam> & { name: string }): ParsedTemplateTeam {
  return {
    memberAgentNames: [],
    allowTeamLeadCreateAgents: true,
    ...over,
  };
}

describe('teamPlan — configurableTeams', () => {
  it('keeps only teams that allow the lead to create agents', () => {
    const teams = [
      team({ name: 'Configurable', allowTeamLeadCreateAgents: true }),
      team({ name: 'Fixed', allowTeamLeadCreateAgents: false }),
    ];
    expect(configurableTeams(teams).map((t) => t.name)).toEqual(['Configurable']);
  });
});

describe('teamPlan — initialTeamStates', () => {
  it('starts each pinned profile in subset mode and unpinned in allow-all', () => {
    const teams = [
      team({
        name: 'Squad',
        profileNames: ['Coder', 'Reviewer'],
        profileSelections: [{ profileName: 'Coder', configNames: ['claude-cfg'] }],
      }),
    ];
    const states = initialTeamStates(teams);
    const squad = states.get('Squad')!;
    expect(squad.selections).toEqual([
      { profileKey: 'Coder', mode: 'subset', configKeys: ['claude-cfg'] },
      { profileKey: 'Reviewer', mode: 'allow-all' },
    ]);
    // templateSelections is a value-equal snapshot (distinct array instances).
    expect(squad.templateSelections).toEqual(squad.selections);
    expect(squad.templateSelections).not.toBe(squad.selections);
  });

  it('matches template profileSelections case-insensitively', () => {
    const teams = [
      team({
        name: 'Squad',
        profileNames: ['Coder'],
        profileSelections: [{ profileName: 'coder', configNames: ['a', 'b'] }],
      }),
    ];
    expect(initialTeamStates(teams).get('Squad')!.selections).toEqual([
      { profileKey: 'Coder', mode: 'subset', configKeys: ['a', 'b'] },
    ]);
  });
});

// Pure state derivation: a unit test over the function is the cheapest layer.
describe('teamPlan — initialTeamStates provider fallback', () => {
  const profiles = [
    {
      name: 'Coder',
      providerConfigs: [
        { name: 'opus', providerName: 'claude' },
        { name: 'gpt', providerName: 'codex' },
        { name: 'copilot-a', providerName: 'copilot' },
        { name: 'copilot-b', providerName: 'copilot' },
      ],
    },
  ];
  const squad = (configNames: string[]) => [
    team({
      name: 'Squad',
      profileNames: ['Coder'],
      profileSelections: [{ profileName: 'Coder', configNames }],
    }),
  ];

  it('replaces a subset with no installed config by the first installed config', () => {
    const state = initialTeamStates(squad(['opus', 'gpt']), {
      profiles,
      installedProviderNames: ['Copilot'],
    }).get('Squad')!;

    const selection = { profileKey: 'Coder', mode: 'subset', configKeys: ['copilot-a'] };
    expect(state.selections).toEqual([selection]);
    expect(state.templateSelections).toEqual([selection]);
    expect(state.fallbacks).toEqual([
      { profileName: 'Coder', fromConfigNames: ['opus', 'gpt'], configName: 'copilot-a' },
    ]);
  });

  it.each([
    ['one subset config is installed', ['opus', 'gpt'], ['codex', 'copilot']],
    ['the profile has no installed config', ['opus'], ['agy']],
    ['a subset name is unknown', ['opus', 'renamed'], ['copilot']],
  ])('keeps the template subset when %s', (_case, configNames, installed) => {
    const state = initialTeamStates(squad(configNames), {
      profiles,
      installedProviderNames: installed,
    }).get('Squad')!;

    expect(state.selections).toEqual([
      { profileKey: 'Coder', mode: 'subset', configKeys: configNames },
    ]);
    expect(state.fallbacks).toBeUndefined();
  });
});

// The pure team plan exposes both the row state and the overrides that create and import submit.
describe('teamPlan — templateTeamStates with a preset', () => {
  const squad = team({
    name: 'Squad',
    profileNames: ['Coder'],
    profileSelections: [{ profileName: ' CODER ', configNames: ['opus'] }],
  });
  const profiles = [
    {
      name: ' Coder ',
      providerConfigs: [
        { name: 'opus', providerName: 'claude' },
        { name: 'gpt', providerName: 'codex' },
      ],
    },
  ];
  const payload = { teams: [squad], profiles } as SetupPreviewResponse['payload'];
  const coder = (...configNames: string[]) => ({ profileName: ' coder ', configNames });
  const entry = (...profileSelections: ReturnType<typeof coder>[]) => ({
    teamName: ' SQUAD ',
    profileSelections,
  });

  it.each([
    {
      rule: 'uses the first matching entry',
      entries: [entry(coder(' GPT ')), entry(coder('opus'))],
      expected: ['gpt'],
    },
    {
      rule: 'allows all for an omitted linked profile',
      entries: [entry({ profileName: 'Unlinked', configNames: ['gpt'] })],
      expected: [],
    },
    {
      rule: 'keeps template selections for an omitted team',
      entries: [{ ...entry(coder('gpt')), teamName: 'Other' }],
      expected: ['opus'],
    },
    {
      rule: 'filters stale names before building state and overrides',
      entries: [entry(coder('deleted', 'gpt'))],
      expected: ['gpt'],
    },
    {
      rule: 'combines configs across repeated profile rows and removes duplicates',
      entries: [entry(coder(' GPT '), { profileName: 'CODER', configNames: ['gpt', 'opus'] })],
      expected: ['gpt', 'opus'],
    },
    {
      rule: 'uses a valid later row after a stale first row',
      entries: [entry(coder('deleted'), { profileName: ' Coder', configNames: ['gpt'] })],
      expected: ['gpt'],
    },
    {
      rule: 'keeps the template restriction when all names are stale',
      entries: [entry(coder('deleted'))],
      expected: ['opus'],
    },
  ])('$rule', ({ entries, expected }) => {
    const selectedProviderNames = ['claude', 'codex'];
    const states = templateTeamStates(payload, selectedProviderNames, {
      name: 'Preset',
      agentConfigs: [],
      teamConfigs: entries,
    });
    const selection = expected.length
      ? { profileKey: 'Coder', mode: 'subset', configKeys: expected }
      : { profileKey: 'Coder', mode: 'allow-all' };

    expect(states.get('Squad')).toEqual({
      selections: [selection],
      templateSelections: [selection],
    });
    expect(buildTeamOverrides([squad], states, { profiles, selectedProviderNames })).toEqual([
      {
        teamName: 'Squad',
        allowTeamLeadCreateAgents: true,
        profileNames: ['Coder'],
        profileSelections: [{ profileName: 'Coder', configNames: expected }],
      },
    ]);
  });

  it('records the provider fallback for a preset subset after removing stale names', () => {
    const states = templateTeamStates(payload, ['claude'], {
      name: 'Preset',
      agentConfigs: [],
      teamConfigs: [entry(coder('deleted', 'gpt'))],
    });

    const selection = { profileKey: 'Coder', mode: 'subset', configKeys: ['opus'] };
    expect(states.get('Squad')).toEqual({
      selections: [selection],
      templateSelections: [selection],
      fallbacks: [{ profileName: 'Coder', fromConfigNames: ['gpt'], configName: 'opus' }],
    });
  });
});

describe('teamPlan — buildTeamOverrides', () => {
  const visibleTeams = [team({ name: 'Squad', memberAgentNames: ['m1'] })];

  it('emits allow-all as an empty configNames selection + allowTeamLeadCreateAgents true', () => {
    const states = new Map<string, TeamPanelState>([
      [
        'Squad',
        { selections: [{ profileKey: 'Coder', mode: 'allow-all' }], templateSelections: [] },
      ],
    ]);
    expect(buildTeamOverrides(visibleTeams, states)).toEqual([
      {
        teamName: 'Squad',
        allowTeamLeadCreateAgents: true,
        profileNames: ['Coder'],
        profileSelections: [{ profileName: 'Coder', configNames: [] }],
      },
    ]);
  });

  it('drops removed profiles and omits profileSelections when all are removed', () => {
    const states = new Map<string, TeamPanelState>([
      [
        'Squad',
        {
          selections: [
            { profileKey: 'Coder', mode: 'remove' },
            { profileKey: 'Reviewer', mode: 'remove' },
          ],
          templateSelections: [],
        },
      ],
    ]);
    expect(buildTeamOverrides(visibleTeams, states)).toEqual([
      { teamName: 'Squad', allowTeamLeadCreateAgents: true, profileNames: [] },
    ]);
  });

  it('skips teams with no panel state', () => {
    expect(buildTeamOverrides(visibleTeams, new Map())).toEqual([]);
  });

  it('round-trips template defaults unchanged (initial → build)', () => {
    const teams = [
      team({
        name: 'Squad',
        memberAgentNames: ['m1'],
        profileNames: ['Coder', 'Reviewer'],
        profileSelections: [{ profileName: 'Coder', configNames: ['claude-cfg'] }],
      }),
    ];
    const overrides = buildTeamOverrides(teams, initialTeamStates(teams));
    expect(overrides).toEqual([
      {
        teamName: 'Squad',
        allowTeamLeadCreateAgents: true,
        profileNames: ['Coder', 'Reviewer'],
        profileSelections: [
          { profileName: 'Coder', configNames: ['claude-cfg'] },
          { profileName: 'Reviewer', configNames: [] },
        ],
      },
    ]);
  });
});

describe('teamPlan — buildTeamOverrides provider filter (Step-1 selection)', () => {
  const visibleTeams = [team({ name: 'Squad', memberAgentNames: ['m1'] })];
  const profiles = [
    {
      name: 'Coder',
      providerConfigs: [
        { name: 'claude-cfg', providerName: 'claude' },
        { name: 'gpt-high', providerName: 'codex' },
      ],
    },
  ];

  function subsetState(configKeys: string[]): Map<string, TeamPanelState> {
    return new Map<string, TeamPanelState>([
      [
        'Squad',
        {
          selections: [{ profileKey: 'Coder', mode: 'subset', configKeys }],
          templateSelections: [],
        },
      ],
    ]);
  }

  it('drops subset config names whose provider is not selected', () => {
    const overrides = buildTeamOverrides(visibleTeams, subsetState(['claude-cfg', 'gpt-high']), {
      profiles,
      selectedProviderNames: ['claude'],
    });
    expect(overrides[0].profileSelections).toEqual([
      { profileName: 'Coder', configNames: ['claude-cfg'] },
    ]);
  });

  it('removes the profile permission when every pinned config is filtered out', () => {
    const overrides = buildTeamOverrides(visibleTeams, subsetState(['gpt-high']), {
      profiles,
      selectedProviderNames: ['claude'],
    });
    expect(overrides[0]).toEqual({
      teamName: 'Squad',
      allowTeamLeadCreateAgents: true,
      profileNames: [],
    });
  });

  it('keeps config names it cannot resolve against the profiles', () => {
    const overrides = buildTeamOverrides(visibleTeams, subsetState(['mystery-cfg']), {
      profiles,
      selectedProviderNames: ['claude'],
    });
    expect(overrides[0].profileSelections).toEqual([
      { profileName: 'Coder', configNames: ['mystery-cfg'] },
    ]);
  });

  it('retains unknown names when every known name is filtered out', () => {
    const overrides = buildTeamOverrides(visibleTeams, subsetState(['gpt-high', 'mystery-cfg']), {
      profiles,
      selectedProviderNames: ['claude'],
    });
    expect(overrides[0]).toEqual({
      teamName: 'Squad',
      allowTeamLeadCreateAgents: true,
      profileNames: ['Coder'],
      profileSelections: [{ profileName: 'Coder', configNames: ['mystery-cfg'] }],
    });
  });

  it('preserves genuine allow-all when a provider filter is supplied', () => {
    const states = new Map<string, TeamPanelState>([
      [
        'Squad',
        { selections: [{ profileKey: 'Coder', mode: 'allow-all' }], templateSelections: [] },
      ],
    ]);
    const overrides = buildTeamOverrides(visibleTeams, states, {
      profiles,
      selectedProviderNames: ['claude'],
    });
    expect(overrides[0]).toEqual({
      teamName: 'Squad',
      allowTeamLeadCreateAgents: true,
      profileNames: ['Coder'],
      profileSelections: [{ profileName: 'Coder', configNames: [] }],
    });
  });

  it('matches providers and config names case-insensitively', () => {
    const overrides = buildTeamOverrides(visibleTeams, subsetState(['GPT-HIGH', 'claude-cfg']), {
      profiles,
      selectedProviderNames: ['CLAUDE'],
    });
    expect(overrides[0].profileSelections).toEqual([
      { profileName: 'Coder', configNames: ['claude-cfg'] },
    ]);
  });

  it('emits verbatim when no filter is supplied (legacy behavior)', () => {
    const overrides = buildTeamOverrides(visibleTeams, subsetState(['claude-cfg', 'gpt-high']));
    expect(overrides[0].profileSelections).toEqual([
      { profileName: 'Coder', configNames: ['claude-cfg', 'gpt-high'] },
    ]);
  });
});
