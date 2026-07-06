import {
  buildTeamOverrides,
  configurableTeams,
  initialTeamStates,
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

describe('teamPlan — buildTeamOverrides (byte-identical to legacy handleConfirm)', () => {
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

  it('emits subset config names verbatim', () => {
    const states = new Map<string, TeamPanelState>([
      [
        'Squad',
        {
          selections: [{ profileKey: 'Coder', mode: 'subset', configKeys: ['claude-cfg'] }],
          templateSelections: [],
        },
      ],
    ]);
    expect(buildTeamOverrides(visibleTeams, states)[0].profileSelections).toEqual([
      { profileName: 'Coder', configNames: ['claude-cfg'] },
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

  it('falls back to allow-all when every pinned config is filtered out', () => {
    const overrides = buildTeamOverrides(visibleTeams, subsetState(['gpt-high']), {
      profiles,
      selectedProviderNames: ['claude'],
    });
    // [] = allow-all: the team keeps the remaining selected-provider configs.
    expect(overrides[0].profileSelections).toEqual([{ profileName: 'Coder', configNames: [] }]);
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
