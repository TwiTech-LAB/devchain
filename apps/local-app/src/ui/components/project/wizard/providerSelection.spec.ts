import { ExportSchema } from '@devchain/shared';
import type {
  SetupPreviewFamilyAlternative,
  SetupPreviewResponse,
} from '@/ui/pages/projects/lib/project-contracts';
import { teamsDevSetupPreview } from '../../../../../test/helpers/teams-dev-setup-preview';
import {
  defaultSelectedProviders,
  deriveFamilyProviderMappings,
  setupProviderList,
} from './providerSelection';

const coderProfileId = '43e53727-a38b-4390-9910-a15631e46113';
const specialistProfileId = '69436e85-9d13-4041-952c-dce578bcde4c';

function partialSetupPreview(): SetupPreviewResponse {
  return {
    payload: ExportSchema.parse({
      profiles: [
        {
          id: coderProfileId,
          name: 'Coder',
          provider: { name: 'Claude' },
          providerConfigs: [
            { name: 'claude-option', providerName: 'Claude', env: {} },
            { name: 'codex-option', providerName: 'Codex', env: {} },
          ],
        },
        {
          id: specialistProfileId,
          name: 'Specialist',
          provider: { name: 'OpenCode' },
          providerConfigs: [{ name: 'opencode-option', providerName: 'OpenCode', env: {} }],
        },
      ],
      agents: [{ name: 'Agent A', profileId: coderProfileId, providerConfigName: 'claude-option' }],
      presets: [
        {
          name: 'Partial setup',
          agentConfigs: [{ agentName: 'Agent A', providerConfigName: 'claude-option' }],
        },
      ],
    }),
    providerSummary: [],
    familyAlternatives: [],
    presetProviderCoverage: [
      {
        presetName: 'Partial setup',
        referencedProviders: ['Claude'],
        coveredAgentNames: ['Agent A'],
        coversAllAgents: false,
        agentResolvedProviders: { 'Agent A': 'claude' },
      },
    ],
    localAvailability: {
      installedProviders: [
        { id: 'claude', name: 'Claude' },
        { id: 'codex', name: 'Codex' },
        { id: 'opencode', name: 'OpenCode' },
      ],
    },
  };
}

describe('setupProviderList', () => {
  it.each([
    {
      installed: ['claude', 'codex', 'copilot'],
      expectedList: [
        { name: 'claude', installed: true },
        { name: 'codex', installed: true },
      ],
      selected: ['claude', 'codex'],
    },
    {
      installed: ['copilot', 'opencode'],
      expectedList: [
        { name: 'claude', installed: false },
        { name: 'codex', installed: false },
        { name: 'copilot', installed: true },
        { name: 'opencode', installed: true },
      ],
      selected: ['copilot', 'opencode'],
    },
  ])(
    'lists and selects bundled template providers with $installed installed',
    ({ installed, expectedList, selected }) => {
      const list = setupProviderList(teamsDevSetupPreview(installed));

      expect(list).toEqual(expectedList);
      expect(defaultSelectedProviders(list)).toEqual(selected);
    },
  );

  it('includes the named option provider of an agent omitted by the setup', () => {
    const preview = partialSetupPreview();
    preview.payload.agents.push({
      name: 'Agent B',
      profileId: coderProfileId,
      providerConfigName: 'codex-option',
      isProjectOwner: false,
    });

    const list = setupProviderList(preview);

    expect(list).toEqual([
      { name: 'claude', installed: true },
      { name: 'codex', installed: true },
    ]);
    expect(defaultSelectedProviders(list)).toEqual(['claude', 'codex']);
  });

  it('adds an installed option provider for an agent that has no named option or listed option', () => {
    const preview = partialSetupPreview();
    preview.payload.agents.push({
      name: 'Agent B',
      profileId: specialistProfileId,
      isProjectOwner: false,
    });

    expect(setupProviderList(preview)).toEqual([
      { name: 'claude', installed: true },
      { name: 'opencode', installed: true },
    ]);
  });

  it.each([
    {
      installed: ['copilot', 'opencode', 'unreferenced'],
      expectedList: [
        { name: 'claude', installed: false },
        { name: 'codex', installed: false },
        { name: 'copilot', installed: true },
        { name: 'opencode', installed: true },
      ],
    },
    {
      installed: ['claude', 'codex', 'copilot', 'opencode', 'unreferenced'],
      expectedList: [
        { name: 'claude', installed: true },
        { name: 'codex', installed: true },
        { name: 'copilot', installed: true },
      ],
    },
  ])(
    'adds template-supported current providers after the fallback with $installed installed',
    ({ installed, expectedList }) => {
      const currentExport = ExportSchema.parse({
        profiles: [
          {
            id: coderProfileId,
            name: 'Current coder',
            provider: { name: 'Unreferenced' },
            providerConfigs: [
              { name: 'local-option', providerName: 'Copilot', env: {} },
              { name: 'other-option', providerName: 'Unreferenced', env: {} },
            ],
          },
        ],
        agents: [
          { name: 'Current A', profileId: coderProfileId, providerConfigName: 'local-option' },
          { name: 'Current B', profileId: coderProfileId, providerConfigName: 'other-option' },
        ],
      });

      expect(setupProviderList(teamsDevSetupPreview(installed), currentExport)).toEqual(
        expectedList,
      );
    },
  );
});

function family(
  over: Partial<SetupPreviewFamilyAlternative> & { familySlug: string },
): SetupPreviewFamilyAlternative {
  return {
    defaultProvider: 'claude',
    defaultProviderAvailable: true,
    availableProviders: ['claude'],
    hasAlternatives: false,
    ...over,
  };
}

describe('deriveFamilyProviderMappings', () => {
  it('maps a family to the first selected alternative when its default is not selected', () => {
    const alts = [
      family({
        familySlug: 'coder',
        defaultProvider: 'claude',
        defaultProviderAvailable: false,
        availableProviders: ['codex', 'openai'],
        hasAlternatives: true,
      }),
    ];
    expect(deriveFamilyProviderMappings(alts, ['openai'])).toEqual({ coder: 'openai' });
    // First in availableProviders order that is selected wins.
    expect(deriveFamilyProviderMappings(alts, ['codex', 'openai'])).toEqual({ coder: 'codex' });
  });

  it('emits nothing when the default provider is selected', () => {
    const alts = [
      family({
        familySlug: 'coder',
        defaultProvider: 'claude',
        availableProviders: ['claude', 'codex'],
      }),
    ];
    expect(deriveFamilyProviderMappings(alts, ['claude', 'codex'])).toEqual({});
  });

  it('emits nothing when no alternative is selected', () => {
    const alts = [
      family({
        familySlug: 'coder',
        defaultProvider: 'claude',
        defaultProviderAvailable: false,
        availableProviders: ['codex'],
        hasAlternatives: true,
      }),
    ];
    expect(deriveFamilyProviderMappings(alts, ['openai'])).toEqual({});
  });

  it('lowercases slugs and provider names', () => {
    const alts = [
      family({
        familySlug: 'Coder',
        defaultProvider: 'Claude',
        defaultProviderAvailable: false,
        availableProviders: ['Codex'],
        hasAlternatives: true,
      }),
    ];
    expect(deriveFamilyProviderMappings(alts, ['CODEX'])).toEqual({ coder: 'codex' });
  });
});
