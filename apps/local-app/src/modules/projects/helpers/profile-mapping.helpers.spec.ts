import {
  buildProviderSummary,
  collectReferencedProviderNames,
  computeFamilyAlternatives,
  computeFamilyAlternativesFromStorage,
  derivePresetProviderCoverage,
  resolveProvidersFromStorage,
  selectProfilesForFamilies,
} from './profile-mapping.helpers';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

/** Minimal storage stub exposing only `listProviders` (the shape these helpers consume). */
function fakeProviderStorage(names: string[]) {
  return {
    listProviders: async () => ({
      items: names.map((name, i) => ({ id: `id-${i}-${name}`, name })),
    }),
  } as never;
}

describe('profile-mapping.helpers — setup-preview derivation', () => {
  describe('derivePresetProviderCoverage', () => {
    it('returns empty for no presets', () => {
      expect(derivePresetProviderCoverage([], [], [], new Set(['claude']))).toEqual([]);
    });

    it('derives each preset agentConfig → profile → config → provider and marks availability', () => {
      const profiles = [
        {
          id: 'p-1',
          name: 'Claude Profile',
          provider: { name: 'claude' },
          familySlug: 'reasoning',
          providerConfigs: [
            { name: 'default', providerName: 'claude' },
            { name: 'codex-fallback', providerName: 'codex' },
          ],
        },
      ];
      const agents = [
        { name: 'Coder', profileId: 'p-1' },
        { name: 'Architect', profileId: 'p-1' },
      ];
      const presets = [
        {
          name: 'all-claude',
          agentConfigs: [
            { agentName: 'Coder', providerConfigName: 'default' },
            { agentName: 'Architect', providerConfigName: 'default' },
          ],
        },
        {
          name: 'mixed',
          agentConfigs: [
            { agentName: 'Coder', providerConfigName: 'codex-fallback' },
            { agentName: 'Architect', providerConfigName: 'default' },
          ],
        },
      ];

      const result = derivePresetProviderCoverage(presets, profiles, agents, new Set(['claude']));

      expect(result).toHaveLength(2);

      const allClaude = result.find((c) => c.presetName === 'all-claude')!;
      expect(allClaude.agentResolvedProviders.get('coder')).toBe('claude');
      expect(allClaude.coveredAgentNames.has('coder')).toBe(true);
      expect(allClaude.coversAllAgents).toBe(true);
      expect(allClaude.referencedProviders).toEqual(['claude']);

      const mixed = result.find((c) => c.presetName === 'mixed')!;
      // Coder resolves to codex (not installed) → uncovered; Architect stays on claude.
      expect(mixed.agentResolvedProviders.get('coder')).toBe('codex');
      expect(mixed.coveredAgentNames.has('coder')).toBe(false);
      expect(mixed.coveredAgentNames.has('architect')).toBe(true);
      expect(mixed.coversAllAgents).toBe(false);
      expect(mixed.referencedProviders).toEqual(['claude', 'codex']);
    });

    it('resolves a preset that references a config-only provider (provider absent from profile default)', () => {
      // The gemini config exists only inside providerConfigs; the profile default is claude.
      const profiles = [
        {
          id: 'p-1',
          name: 'P',
          provider: { name: 'claude' },
          familySlug: 'reasoning',
          providerConfigs: [
            { name: 'claude-cfg', providerName: 'claude' },
            { name: 'gemini-cfg', providerName: 'gemini' },
          ],
        },
      ];
      const agents = [{ name: 'Bot', profileId: 'p-1' }];
      const presets = [
        {
          name: 'gemini-preset',
          agentConfigs: [{ agentName: 'Bot', providerConfigName: 'gemini-cfg' }],
        },
      ];

      const result = derivePresetProviderCoverage(presets, profiles, agents, new Set(['claude']));

      expect(result).toHaveLength(1);
      const coverage = result[0];
      expect(coverage.agentResolvedProviders.get('bot')).toBe('gemini');
      // gemini is not installed → not covered, preset does not cover all agents.
      expect(coverage.coveredAgentNames.has('bot')).toBe(false);
      expect(coverage.coversAllAgents).toBe(false);
      expect(coverage.referencedProviders).toEqual(['gemini']);
    });

    it('matches provider and config names case-insensitively', () => {
      const profiles = [
        {
          id: 'p-1',
          name: 'P',
          provider: { name: 'Claude' },
          providerConfigs: [{ name: 'Default', providerName: 'CLAUDE' }],
        },
      ];
      const agents = [{ name: 'Bot', profileId: 'p-1' }];
      const presets = [
        {
          name: 'preset',
          agentConfigs: [{ agentName: 'bot', providerConfigName: 'default' }],
        },
      ];

      const result = derivePresetProviderCoverage(presets, profiles, agents, new Set(['claude']));

      expect(result[0].agentResolvedProviders.get('bot')).toBe('claude');
      expect(result[0].coveredAgentNames.has('bot')).toBe(true);
      expect(result[0].coversAllAgents).toBe(true);
    });

    it('marks preset as not covering all agents when an agentConfig has no matching profile', () => {
      const profiles = [{ id: 'p-1', name: 'P', provider: { name: 'claude' } }];
      const agents = [{ name: 'Bot', profileId: 'p-1' }, { name: 'Ghost' }];
      const presets = [
        {
          name: 'preset',
          agentConfigs: [
            { agentName: 'Bot', providerConfigName: 'missing-cfg' },
            { agentName: 'Ghost', providerConfigName: 'default' },
          ],
        },
      ];

      const result = derivePresetProviderCoverage(presets, profiles, agents, new Set(['claude']));

      // Bot has a profile but the config does not resolve → no provider; Ghost has no profile.
      expect(result[0].agentResolvedProviders.size).toBe(0);
      expect(result[0].coversAllAgents).toBe(false);
    });

    it('short-circuits to only the selected preset when selectedPresetName is given', () => {
      const profiles = [
        {
          id: 'p-1',
          name: 'P',
          provider: { name: 'claude' },
          providerConfigs: [{ name: 'default', providerName: 'claude' }],
        },
      ];
      const agents = [{ name: 'Bot', profileId: 'p-1' }];
      const presets = [
        {
          name: 'a',
          agentConfigs: [{ agentName: 'Bot', providerConfigName: 'default' }],
        },
        {
          name: 'b',
          agentConfigs: [{ agentName: 'Bot', providerConfigName: 'default' }],
        },
      ];

      const result = derivePresetProviderCoverage(presets, profiles, agents, new Set(['claude']), {
        selectedPresetName: 'b',
      });

      expect(result).toHaveLength(1);
      expect(result[0].presetName).toBe('b');
    });

    it('returns [] when selectedPresetName matches nothing', () => {
      const result = derivePresetProviderCoverage(
        [{ name: 'a', agentConfigs: [] }],
        [],
        [],
        new Set(),
        { selectedPresetName: 'missing' },
      );
      expect(result).toEqual([]);
    });

    it('computeFamilyAlternatives stays consistent (shared helper unchanged)', () => {
      const profiles = [{ id: 'p-1', name: 'P', provider: { name: 'claude' }, familySlug: 'fam' }];
      const agents = [{ name: 'Bot', profileId: 'p-1' }];
      const result = computeFamilyAlternatives(profiles, agents, new Set(['claude']));
      expect(result.canImport).toBe(true);
      expect(result.alternatives[0].defaultProvider).toBe('claude');
    });
  });

  describe('buildProviderSummary', () => {
    it('unions profile default providers and providerConfig providers', () => {
      const profiles = [
        {
          id: 'p-1',
          name: 'P',
          provider: { name: 'claude' },
          familySlug: 'reasoning',
          providerConfigs: [{ name: 'default', providerName: 'claude' }],
        },
        {
          id: 'p-2',
          name: 'Q',
          provider: { name: 'codex' },
          familySlug: 'reasoning',
          providerConfigs: [
            { name: 'default', providerName: 'codex' },
            { name: 'gemini-alt', providerName: 'gemini' },
          ],
        },
      ];
      const agents = [
        { name: 'A', profileId: 'p-1' },
        { name: 'B', profileId: 'p-1' },
        { name: 'C', profileId: 'p-2' },
      ];

      const result = buildProviderSummary(profiles, agents, new Set(['claude']));

      const byName = new Map(result.map((r) => [r.name, r]));
      expect(result.map((r) => r.name)).toEqual(['claude', 'codex', 'gemini']);

      expect(byName.get('claude')).toEqual({
        name: 'claude',
        available: true,
        families: ['reasoning'],
        agentCount: 2,
      });
      expect(byName.get('codex')).toEqual({
        name: 'codex',
        available: false,
        families: ['reasoning'],
        agentCount: 1,
      });
      // gemini is config-only: referenced, part of the family, but no agent defaults to it.
      expect(byName.get('gemini')).toEqual({
        name: 'gemini',
        available: false,
        families: ['reasoning'],
        agentCount: 0,
      });
    });

    it('returns empty for empty profiles and agents', () => {
      expect(buildProviderSummary([], [], new Set())).toEqual([]);
    });

    it('attributes families case-insensitively and marks availability by lowercased name', () => {
      const profiles = [
        {
          id: 'p-1',
          name: 'P',
          provider: { name: 'Claude' },
          familySlug: 'Fam',
        },
      ];
      const agents = [{ name: 'A', profileId: 'p-1' }];

      const result = buildProviderSummary(profiles, agents, new Set(['claude']));
      expect(result[0].name).toBe('claude');
      expect(result[0].available).toBe(true);
      // Provider name is canonicalized to lowercase; family slug case is preserved
      // (consistent with computeFamilyAlternatives, which keys families case-sensitively).
      expect(result[0].families).toEqual(['Fam']);
      expect(result[0].agentCount).toBe(1);
    });
  });
});

describe('profile-mapping.helpers — transient selectedProviderNames choice metadata', () => {
  describe('collectReferencedProviderNames', () => {
    it('unions profile default providers AND embedded providerConfig provider names', () => {
      const referenced = collectReferencedProviderNames([
        {
          provider: { name: 'Claude' },
          providerConfigs: [
            { name: 'c1', providerName: 'Codex' },
            { name: 'c2', providerName: 'gpt' },
          ],
        },
        { provider: { name: 'claude' }, providerConfigs: [] },
      ]);
      // Lowercased + de-duplicated; the config-only `codex`/`gpt` are included, not just defaults.
      expect([...referenced].sort()).toEqual(['claude', 'codex', 'gpt']);
    });
  });

  describe('resolveProvidersFromStorage', () => {
    it('installed and selected are identical when no allowlist is given; nothing missing', async () => {
      const storage = fakeProviderStorage(['Claude', 'Codex']);
      const { installed, selected, missing } = await resolveProvidersFromStorage(
        storage,
        new Set(['claude', 'codex']),
      );
      expect([...installed.keys()].sort()).toEqual(['claude', 'codex']);
      expect([...selected.keys()].sort()).toEqual(['claude', 'codex']);
      expect(missing).toEqual([]);
    });

    it('narrows only the selected view for a deselected installed provider — it stays installed and is NOT missing', async () => {
      const storage = fakeProviderStorage(['Claude', 'Codex']);
      const { installed, selected, missing } = await resolveProvidersFromStorage(
        storage,
        new Set(['claude', 'codex']),
        ['claude'],
      );
      // codex is installed but deselected: present in the full installed map, absent from the
      // selection-filtered view, and NOT missing (deselection is wizard-scope, not availability).
      expect([...installed.keys()].sort()).toEqual(['claude', 'codex']);
      expect([...selected.keys()]).toEqual(['claude']);
      expect(missing).toEqual([]);
    });

    it('reports a genuinely uninstalled referenced provider (including a config-only one) as missing', async () => {
      const storage = fakeProviderStorage(['Claude']);
      // `gpt` is referenced (e.g. only via a providerConfig) but not installed → genuinely missing.
      const { installed, selected, missing } = await resolveProvidersFromStorage(
        storage,
        new Set(['claude', 'gpt']),
      );
      expect(installed.has('gpt')).toBe(false);
      expect(selected.has('gpt')).toBe(false);
      expect(missing).toEqual(['gpt']);
    });

    it('matches the allowlist case-insensitively (selection view)', async () => {
      const storage = fakeProviderStorage(['Claude']);
      const { installed, selected } = await resolveProvidersFromStorage(
        storage,
        new Set(['claude']),
        ['CLAUDE'],
      );
      expect(installed.has('claude')).toBe(true);
      expect(selected.has('claude')).toBe(true);
    });
  });

  describe('computeFamilyAlternativesFromStorage', () => {
    it('treats an excluded installed provider as unavailable in family resolution', async () => {
      const storage = fakeProviderStorage(['claude', 'codex']);
      const profiles = [
        { id: 'p-claude', name: 'Claude Coder', provider: { name: 'claude' }, familySlug: 'coder' },
        { id: 'p-codex', name: 'Codex Coder', provider: { name: 'codex' }, familySlug: 'coder' },
      ];
      const agents = [{ id: 'a1', name: 'Coder', profileId: 'p-claude' }];

      const withoutAllowlist = await computeFamilyAlternativesFromStorage(
        storage,
        profiles,
        agents,
      );
      expect(withoutAllowlist.alternatives[0].availableProviders).toEqual(['claude', 'codex']);
      expect(withoutAllowlist.missingProviders).toEqual([]);

      const withAllowlist = await computeFamilyAlternativesFromStorage(
        storage,
        profiles,
        agents,
        undefined,
        ['claude'],
      );
      // codex is installed but excluded → ineligible as a family choice, but NOT missing:
      // missingProviders reports installation state (installed view), never wizard deselection.
      expect(withAllowlist.alternatives[0].availableProviders).toEqual(['claude']);
      expect(withAllowlist.missingProviders).toEqual([]);
      expect(withAllowlist.canImport).toBe(true);
    });

    it('still reports a genuinely uninstalled provider as missing under an allowlist', async () => {
      const storage = fakeProviderStorage(['claude', 'codex']);
      const profiles = [
        { id: 'p-claude', name: 'Claude Coder', provider: { name: 'claude' }, familySlug: 'coder' },
        { id: 'p-codex', name: 'Codex Coder', provider: { name: 'codex' }, familySlug: 'coder' },
        { id: 'p-gemini', name: 'Gemini Coder', provider: { name: 'gemini' }, familySlug: 'coder' },
      ];
      const agents = [{ id: 'a1', name: 'Coder', profileId: 'p-claude' }];

      const result = await computeFamilyAlternativesFromStorage(
        storage,
        profiles,
        agents,
        undefined,
        ['claude'],
      );
      // gemini is not installed → missing; codex is installed-but-deselected → only ineligible.
      expect(result.alternatives[0].availableProviders).toEqual(['claude']);
      expect(result.missingProviders).toEqual(['gemini']);
      expect(result.canImport).toBe(true);
    });
  });

  describe('selectProfilesForFamilies — config-only-provider asymmetry fix', () => {
    // Red-Team regression row: mapping a family to a provider present ONLY in
    // profile.providerConfigs[].providerName must select the owning profile, not silently fall
    // back to the profile default provider.
    const profiles = [
      { id: 'p-claude', name: 'Claude Coder', provider: { name: 'claude' }, familySlug: 'coder' },
      {
        id: 'p-codex',
        name: 'Codex Coder',
        provider: { name: 'codex' },
        familySlug: 'coder',
        providerConfigs: [{ name: 'gemini-cfg', providerName: 'gemini' }],
      },
    ];
    const agents = [{ id: 'a1', name: 'Coder', profileId: 'p-claude' }];

    it('selects the config-owner profile when the family is mapped to a config-only provider', () => {
      const available = new Map([
        ['claude', 'id-claude'],
        ['gemini', 'id-gemini'],
      ]);

      const result = selectProfilesForFamilies(
        profiles,
        agents,
        { coder: 'gemini' }, // gemini appears only in p-codex.providerConfigs
        available,
      );

      // The agent is re-pointed at the gemini-config owner (p-codex), NOT the claude default.
      expect(result.agentProfileMap.get('a1')).toBe('p-codex');
      expect(result.agentProfileMap.get('a1')).not.toBe('p-claude');
      expect(result.profilesToCreate.some((p) => p.id === 'p-codex')).toBe(true);
    });

    it('still falls back to the profile default when no family mapping is provided', () => {
      const available = new Map([
        ['claude', 'id-claude'],
        ['gemini', 'id-gemini'],
      ]);

      const result = selectProfilesForFamilies(profiles, agents, undefined, available);

      // No mapping → the agent keeps its default-provider profile (claude), unchanged behavior.
      expect(result.agentProfileMap.get('a1')).toBe('p-claude');
    });
  });
});
