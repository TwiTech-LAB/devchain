import {
  applyPresetToRows,
  buildAgentGroups,
  buildAgentOverrides,
  buildAgentPlanEmission,
  computeOverridePayload,
  initialAgentRows,
  resolveAgentRow,
  selectablePresetNames,
  type AgentRow,
  type TemplateAgent,
  type TemplateProfile,
  type TemplateTeam,
} from './agentPlan';

/** A profile with two configs: claude (model sonnet) + codex (model gpt-5, effort high). */
function makeProfiles(): TemplateProfile[] {
  return [
    {
      id: 'profile-1',
      name: 'Coder',
      provider: { name: 'claude' },
      providerConfigs: [
        { name: 'claude-cfg', providerName: 'claude', model: 'claude-sonnet', env: {} },
        { name: 'codex-cfg', providerName: 'codex', model: 'gpt-5', effort: 'high', env: {} },
      ],
    } as TemplateProfile,
    {
      id: 'profile-2',
      name: 'Reviewer',
      provider: { name: 'claude' },
      providerConfigs: [{ name: 'claude-only', providerName: 'claude', env: {} }],
    } as TemplateProfile,
  ];
}

function agent(over: Partial<TemplateAgent> & { name: string }): TemplateAgent {
  return { profileId: 'profile-1', ...over } as TemplateAgent;
}

describe('agentPlan — grouping', () => {
  it('groups team lead first then members, and collects the rest as independent', () => {
    const agents = [
      agent({ name: 'Lead' }),
      agent({ name: 'Member1' }),
      agent({ name: 'Member2' }),
      agent({ name: 'Solo' }),
    ];
    const teams: TemplateTeam[] = [
      {
        name: 'Squad',
        teamLeadAgentName: 'Lead',
        memberAgentNames: ['Member1', 'Member2'],
      } as TemplateTeam,
    ];

    const groups = buildAgentGroups(agents, teams);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      kind: 'team',
      teamName: 'Squad',
      leadAgentName: 'Lead',
      agentNames: ['Lead', 'Member1', 'Member2'],
    });
    expect(groups[1]).toMatchObject({ kind: 'independent', agentNames: ['Solo'] });
  });

  it('claims each agent for the first team that references it (no duplicate rows)', () => {
    const agents = [agent({ name: 'A' }), agent({ name: 'B' })];
    const teams: TemplateTeam[] = [
      { name: 'T1', teamLeadAgentName: 'A', memberAgentNames: ['B'] } as TemplateTeam,
      { name: 'T2', teamLeadAgentName: 'B', memberAgentNames: [] } as TemplateTeam,
    ];
    const groups = buildAgentGroups(agents, teams);
    expect(groups.map((g) => g.agentNames)).toEqual([['A', 'B']]);
  });

  it('produces only an independent group when there are no teams', () => {
    const groups = buildAgentGroups([agent({ name: 'Solo' })], []);
    expect(groups).toEqual([{ kind: 'independent', leadAgentName: null, agentNames: ['Solo'] }]);
  });
});

describe('agentPlan — resolution / Step-1 filtering', () => {
  const profiles = makeProfiles();

  it('resolves a named config when its provider is selected', () => {
    const rows = initialAgentRows([agent({ name: 'A', providerConfigName: 'codex-cfg' })]);
    const resolved = resolveAgentRow(rows['a'], profiles[0], ['claude', 'codex']);
    expect(resolved).toEqual({
      agentName: 'A',
      resolvedConfigName: 'codex-cfg',
      unresolved: false,
    });
  });

  it('flags a named config as unresolved when its provider is deselected (NO auto-fallback)', () => {
    const rows = initialAgentRows([agent({ name: 'A', providerConfigName: 'codex-cfg' })]);
    const resolved = resolveAgentRow(rows['a'], profiles[0], ['claude']);
    expect(resolved).toEqual({ agentName: 'A', resolvedConfigName: null, unresolved: true });
  });

  it('auto-picks the first available config for an agent with no named config', () => {
    const rows = initialAgentRows([agent({ name: 'A' })]);
    // Only codex selected → claude-cfg filtered out, codex-cfg auto-picked.
    const resolved = resolveAgentRow(rows['a'], profiles[0], ['codex']);
    expect(resolved.resolvedConfigName).toBe('codex-cfg');
    expect(resolved.unresolved).toBe(false);
  });

  it('marks unpinned agents unresolved when no config survives the selection', () => {
    const rows = initialAgentRows([agent({ name: 'A' })]);
    const resolved = resolveAgentRow(rows['a'], profiles[0], ['openai']);
    expect(resolved).toEqual({ agentName: 'A', resolvedConfigName: null, unresolved: true });
  });

  it('restores a named config when its provider is re-selected (name never lost)', () => {
    const rows = initialAgentRows([agent({ name: 'A', providerConfigName: 'codex-cfg' })]);
    expect(resolveAgentRow(rows['a'], profiles[0], ['claude']).unresolved).toBe(true);
    // Re-selecting codex restores the same config from the untouched stored row.
    expect(resolveAgentRow(rows['a'], profiles[0], ['claude', 'codex']).resolvedConfigName).toBe(
      'codex-cfg',
    );
  });
});

describe('agentPlan — preset filtering + apply', () => {
  const coverage = [
    {
      presetName: 'AllClaude',
      referencedProviders: ['claude'],
      coversAllAgents: true,
      coveredAgentNames: [],
      agentResolvedProviders: {},
    },
    {
      presetName: 'Mixed',
      referencedProviders: ['claude', 'codex'],
      coversAllAgents: true,
      coveredAgentNames: [],
      agentResolvedProviders: {},
    },
  ];

  it('keeps only presets whose every referenced provider is selected', () => {
    expect(selectablePresetNames(coverage, ['claude'])).toEqual(new Set(['AllClaude']));
    expect(selectablePresetNames(coverage, ['claude', 'codex'])).toEqual(
      new Set(['AllClaude', 'Mixed']),
    );
  });

  it('applies a preset by pinning configs + setting overrides, leaving unmentioned agents alone', () => {
    const rows = initialAgentRows([agent({ name: 'A' }), agent({ name: 'B' })]);
    const next = applyPresetToRows(rows, {
      name: 'Mixed',
      agentConfigs: [
        {
          agentName: 'A',
          providerConfigName: 'codex-cfg',
          modelOverride: 'gpt-5',
          effortOverride: 'high',
        },
      ],
    });
    expect(next['a']).toMatchObject({
      configName: 'codex-cfg',
      pinned: true,
      modelOverride: 'gpt-5',
      effortOverride: 'high',
    });
    expect(next['b']).toEqual(rows['b']); // untouched
    expect(rows['a'].pinned).toBe(false); // original not mutated
  });
});

describe('agentPlan — computeOverridePayload (delta 6)', () => {
  it('preserves (undefined) when unchanged vs the template override', () => {
    expect(computeOverridePayload('gpt-5', 'gpt-5', null)).toBeUndefined();
    expect(computeOverridePayload(null, null, null)).toBeUndefined();
  });

  it('clears (null) when the template carried an override and the user reverts to config default', () => {
    expect(computeOverridePayload(null, 'gpt-5', 'claude-sonnet')).toBeNull();
  });

  it('does NOT materialize a config default as an explicit override', () => {
    // Row set to the config default, template had none → no override at all.
    expect(computeOverridePayload('claude-sonnet', null, 'claude-sonnet')).toBeUndefined();
    // Row set to the config default, template HAD a different override → clear it.
    expect(computeOverridePayload('claude-sonnet', 'gpt-5', 'claude-sonnet')).toBeNull();
  });

  it('emits the new value when the user picks a non-default override', () => {
    expect(computeOverridePayload('gpt-5', null, 'claude-sonnet')).toBe('gpt-5');
    expect(computeOverridePayload('gpt-5', 'opus', 'claude-sonnet')).toBe('gpt-5');
  });
});

describe('agentPlan — buildAgentOverrides (emission)', () => {
  const profiles = makeProfiles();

  it('emits nothing for a fully untouched plan', () => {
    const agents = [
      agent({ name: 'A', providerConfigName: 'claude-cfg' }),
      agent({ name: 'B', profileId: 'profile-2', providerConfigName: 'claude-only' }),
    ];
    const rows = initialAgentRows(agents);
    const result = buildAgentOverrides(rows, agents, profiles, ['claude', 'codex']);
    expect(result.overrides).toEqual([]);
    expect(result.unresolvedAgents).toEqual([]);
  });

  it('emits a config change (providerConfigName only) when the user switches config', () => {
    const agents = [agent({ name: 'A', providerConfigName: 'claude-cfg' })];
    const rows = initialAgentRows(agents);
    rows['a'] = { ...rows['a'], configName: 'codex-cfg', pinned: true };
    const result = buildAgentOverrides(rows, agents, profiles, ['claude', 'codex']);
    expect(result.overrides).toEqual([{ agentName: 'A', providerConfigName: 'codex-cfg' }]);
  });

  it('emits an explicit null to clear a template model override reverted to the config default', () => {
    const agents = [agent({ name: 'A', providerConfigName: 'claude-cfg', modelOverride: 'opus' })];
    const rows = initialAgentRows(agents);
    rows['a'] = { ...rows['a'], modelOverride: null };
    const result = buildAgentOverrides(rows, agents, profiles, ['claude', 'codex']);
    expect(result.overrides).toEqual([
      { agentName: 'A', providerConfigName: 'claude-cfg', modelOverride: null },
    ]);
  });

  it('emits a new model override without touching effort', () => {
    const agents = [agent({ name: 'A', providerConfigName: 'claude-cfg' })];
    const rows = initialAgentRows(agents);
    rows['a'] = { ...rows['a'], modelOverride: 'opus' };
    const result = buildAgentOverrides(rows, agents, profiles, ['claude', 'codex']);
    expect(result.overrides).toEqual([
      { agentName: 'A', providerConfigName: 'claude-cfg', modelOverride: 'opus' },
    ]);
  });

  it('collects unresolved agents and omits them from overrides', () => {
    const agents = [agent({ name: 'A', providerConfigName: 'codex-cfg' })];
    const rows = initialAgentRows(agents);
    const result = buildAgentOverrides(rows, agents, profiles, ['claude']);
    expect(result.overrides).toEqual([]);
    expect(result.unresolvedAgents).toEqual(['A']);
  });
});

describe('agentPlan — buildAgentPlanEmission', () => {
  const profiles = makeProfiles();
  const agents = [agent({ name: 'A', providerConfigName: 'claude-cfg' })];

  function baseRows(): Record<string, AgentRow> {
    return initialAgentRows(agents);
  }

  it('emits { presetName } for an unmodified, selectable preset', () => {
    const emission = buildAgentPlanEmission({
      rows: baseRows(),
      agents,
      profiles,
      selectedProviderNames: ['claude', 'codex'],
      presetName: 'Mixed',
      presetModified: false,
      selectablePresets: new Set(['Mixed']),
    });
    expect(emission).toEqual({ presetName: 'Mixed' });
  });

  it('emits { agentOverrides } when the preset was modified', () => {
    const rows = baseRows();
    rows['a'] = { ...rows['a'], configName: 'codex-cfg', pinned: true };
    const emission = buildAgentPlanEmission({
      rows,
      agents,
      profiles,
      selectedProviderNames: ['claude', 'codex'],
      presetName: 'Mixed',
      presetModified: true,
      selectablePresets: new Set(['Mixed']),
    });
    expect(emission).toEqual({
      agentOverrides: [{ agentName: 'A', providerConfigName: 'codex-cfg' }],
    });
  });

  it('falls back to agentOverrides when the selected preset is no longer selectable', () => {
    const emission = buildAgentPlanEmission({
      rows: baseRows(),
      agents,
      profiles,
      selectedProviderNames: ['claude'],
      presetName: 'Mixed',
      presetModified: false,
      selectablePresets: new Set(['AllClaude']),
    });
    expect(emission).toEqual({}); // nothing changed → no overrides, no preset
  });

  it('emits {} for a custom, untouched plan', () => {
    const emission = buildAgentPlanEmission({
      rows: baseRows(),
      agents,
      profiles,
      selectedProviderNames: ['claude', 'codex'],
      presetName: null,
      presetModified: false,
      selectablePresets: new Set(),
    });
    expect(emission).toEqual({});
  });
});
