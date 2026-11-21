import { renderHook } from '@testing-library/react';
import type { Dispatch, SetStateAction } from 'react';
import { buildProviderSummary } from '@/modules/projects/helpers/profile-mapping.helpers';
import { teamsDevSetupPreview } from '../../../../../test/helpers/teams-dev-setup-preview';
import { agentKey, buildAgentOverrides } from './agentPlan';
import { installedProviderNames } from './providerSelection';
import {
  buildConfigEmission,
  initialWizardConfigState,
  useWizardConfigHandlers,
  wizardConfigStateFor,
  type WizardConfigState,
} from './useWizardConfig';
import type { SetupPreviewResponse } from '@/ui/pages/projects/lib/project-contracts';

function makePreview(over: Partial<SetupPreviewResponse> = {}): SetupPreviewResponse {
  return {
    payload: {
      profiles: [
        {
          id: 'profile-1',
          name: 'Coder',
          provider: { name: 'claude' },
          providerConfigs: [
            { name: 'claude-cfg', providerName: 'claude', env: {} },
            { name: 'codex-cfg', providerName: 'codex', env: {} },
          ],
        },
      ],
      agents: [
        { name: 'Captain', profileId: 'profile-1', providerConfigName: 'claude-cfg' },
        { name: 'Solo', profileId: 'profile-1', providerConfigName: 'claude-cfg' },
      ],
      teams: [
        {
          name: 'Squad',
          teamLeadAgentName: 'Captain',
          memberAgentNames: ['Solo'],
          allowTeamLeadCreateAgents: true,
          profileNames: ['Coder'],
        },
      ],
      // Storage/export order is oldest-first: AllClaude was created before MixedCodex.
      presets: [
        {
          name: 'AllClaude',
          agentConfigs: [{ agentName: 'Captain', providerConfigName: 'claude-cfg' }],
          teamConfigs: [
            {
              teamName: 'Squad',
              profileSelections: [{ profileName: 'Coder', configNames: ['claude-cfg'] }],
            },
          ],
        },
        {
          name: 'MixedCodex',
          agentConfigs: [{ agentName: 'Solo', providerConfigName: 'codex-cfg' }],
          teamConfigs: [
            {
              teamName: 'Squad',
              profileSelections: [{ profileName: 'Coder', configNames: ['codex-cfg'] }],
            },
          ],
        },
      ],
    } as unknown as SetupPreviewResponse['payload'],
    providerSummary: [
      { name: 'claude', available: true, families: [], agentCount: 2 },
      { name: 'codex', available: true, families: [], agentCount: 0 },
    ] as unknown as SetupPreviewResponse['providerSummary'],
    familyAlternatives: [],
    presetProviderCoverage: [
      {
        presetName: 'AllClaude',
        referencedProviders: ['claude'],
        coversAllAgents: false,
        coveredAgentNames: [],
        agentResolvedProviders: {},
      },
      {
        presetName: 'MixedCodex',
        referencedProviders: ['codex'],
        coversAllAgents: false,
        coveredAgentNames: [],
        agentResolvedProviders: {},
      },
    ],
    localAvailability: {
      installedProviders: [
        { id: 'p-claude', name: 'claude' },
        { id: 'p-codex', name: 'codex' },
      ],
    },
    ...over,
  } as SetupPreviewResponse;
}

// Pure state derivation: a unit test over the real functions is the cheapest layer that sees it.
describe('initialWizardConfigState', () => {
  it('selects the installed listed providers and applies the newest fitting preset', () => {
    const state = initialWizardConfigState(makePreview());

    expect(state.selectedProviderNames).toEqual(['claude', 'codex']);
    expect(state.agentPresetName).toBe('MixedCodex');
    expect(state.agentPresetModified).toBe(false);
    expect(state.teamStates.get('Squad')?.selections).toEqual([
      { profileKey: 'Coder', mode: 'subset', configKeys: ['codex-cfg'] },
    ]);
  });

  it.each([
    ['both referenced providers', ['claude', 'codex'], ['claude', 'codex']],
    // The server summary has no codex entry: the profile has no familySlug.
    ['the config provider of a profile without a family', ['codex'], ['codex']],
    ['an installed provider the template does not reference', ['Claude', 'copilot'], ['claude']],
  ])('selects the installed listed providers: %s', (_case, installed, expected) => {
    const preview = makePreview();
    const installedNames = new Set(installed.map((n) => n.toLowerCase()));
    preview.providerSummary = buildProviderSummary(
      preview.payload.profiles as Parameters<typeof buildProviderSummary>[0],
      preview.payload.agents ?? [],
      installedNames,
    );
    preview.localAvailability = {
      installedProviders: installed.map((name) => ({ id: `p-${name}`, name })),
    };

    expect(initialWizardConfigState(preview).selectedProviderNames).toEqual(expected);
  });
});

type TeamsDevPayload = SetupPreviewResponse['payload'];

/** The newest setup of the bundled template: storage order is oldest first. */
function newestSetup(payload: TeamsDevPayload) {
  const presets = payload.presets ?? [];
  return presets[presets.length - 1];
}

function buildersTeam(payload: TeamsDevPayload) {
  return (payload.teams ?? []).find((team) => team.name === 'Builders')!;
}

// The bundled template exercises fallback across agents, families and teams together; only the
// real payload shows that a single-provider install yields a runnable setup. The template content
// changes often, so option names and setup names are read from the payload, not written here.
describe('teams-dev setup with installed providers', () => {
  it.each(['copilot', 'opencode', 'agy'])(
    'falls every agent and the Builders team back to the %s config',
    (provider) => {
      const preview = teamsDevSetupPreview([provider]);
      const state = initialWizardConfigState(preview);
      const emission = buildConfigEmission(preview, state);
      const epicManager = preview.payload.agents!.find(({ name }) => name === 'Epic Manager')!;
      const templateCoder = buildersTeam(preview.payload).profileSelections!.find(
        ({ profileName }) => profileName === 'Coder',
      )!;

      expect(
        buildAgentOverrides(
          state.agentRows,
          preview.payload.agents ?? [],
          preview.payload.profiles ?? [],
          state.selectedProviderNames,
          installedProviderNames(preview),
        ).unresolvedAgents,
      ).toEqual([]);
      expect(state.agentPresetName).toBeNull();
      for (const row of Object.values(state.agentRows)) {
        expect(row).toMatchObject({
          configName: provider,
          pinned: true,
          modelOverride: null,
          effortOverride: null,
        });
      }
      expect(state.agentRows['epic manager'].fallbackFromConfigName).toBe(
        epicManager.providerConfigName,
      );

      const builders = state.teamStates.get('Builders')!;
      const coder = { profileKey: 'Coder', mode: 'subset', configKeys: [provider] };
      expect(builders.selections).toEqual([coder]);
      expect(builders.templateSelections).toEqual([coder]);
      expect(builders.fallbacks).toEqual([
        {
          profileName: 'Coder',
          fromConfigNames: templateCoder.configNames,
          configName: provider,
        },
      ]);

      expect(emission.selectedProviderNames).toEqual([provider]);
      expect(emission.presetName).toBeUndefined();
      expect(emission.agentOverrides).toContainEqual({
        agentName: 'Epic Manager',
        providerConfigName: provider,
        modelOverride: null,
      });
      expect(emission.agentOverrides).toHaveLength(4);
      expect(emission.familyProviderMappings).toEqual({
        architect: provider,
        'code reviewer': provider,
        'epic manager': provider,
        'sub-architect': provider,
      });
      expect(emission.teamOverrides).toEqual([
        {
          teamName: 'Builders',
          allowTeamLeadCreateAgents: true,
          profileNames: ['Coder'],
          profileSelections: [{ profileName: 'Coder', configNames: [provider] }],
        },
      ]);
    },
  );

  it('applies the bundled setup with only its providers selected even when Copilot is installed', () => {
    const preview = teamsDevSetupPreview(['claude', 'codex', 'copilot']);
    const state = initialWizardConfigState(preview);
    // The newest setup runs on Claude and Codex, so it is the suggested setup. Its team entry
    // replaces the team's own allowed options; a setup with no entry leaves the team's options.
    const suggested = newestSetup(preview.payload);
    const allowed =
      suggested.teamConfigs?.find(({ teamName }) => teamName === 'Builders')?.profileSelections ??
      buildersTeam(preview.payload).profileSelections;

    expect(state.agentPresetName).toBe(suggested.name);
    expect(Object.values(state.agentRows).some((r) => r.fallbackFromConfigName)).toBe(false);
    expect(state.teamStates.get('Builders')!.fallbacks).toBeUndefined();
    expect(buildConfigEmission(preview, state)).toEqual({
      selectedProviderNames: ['claude', 'codex'],
      presetName: suggested.name,
      teamOverrides: [
        {
          teamName: 'Builders',
          allowTeamLeadCreateAgents: true,
          profileNames: ['Coder'],
          profileSelections: allowed,
        },
      ],
    });
  });
});

describe('useWizardConfigHandlers', () => {
  function runHandler(
    preview: SetupPreviewResponse,
    seeded: WizardConfigState,
    invoke: (handlers: ReturnType<typeof useWizardConfigHandlers>) => void,
  ): WizardConfigState {
    let produced: WizardConfigState | null = seeded;
    const setState: Dispatch<SetStateAction<WizardConfigState | null>> = (action) => {
      produced = typeof action === 'function' ? action(produced) : action;
    };
    const { result } = renderHook(() => useWizardConfigHandlers(preview, setState));
    invoke(result.current);
    return produced!;
  }

  it('keeps the applied setup when the new provider selection also fits a newer setup', () => {
    const preview = makePreview();
    const seeded = wizardConfigStateFor(preview, ['claude']);

    const next = runHandler(preview, seeded, (h) =>
      h.onSelectedProvidersChange(['claude', 'codex']),
    );

    expect(next.selectedProviderNames).toEqual(['claude', 'codex']);
    expect(next.agentPresetName).toBe('AllClaude');
  });

  it('rebuilds edited agent and team rows with the suggested setup when the applied setup no longer fits', () => {
    const preview = makePreview();
    const next = runHandler(preview, initialWizardConfigState(preview), (h) => {
      h.onAgentRowChange('Captain', { modelOverride: 'manual-model', effortOverride: 'high' });
      h.onTeamStateChange('Squad', { selections: [{ profileKey: 'Coder', mode: 'remove' }] });
      h.onSelectedProvidersChange(['claude']);
    });

    expect(next.selectedProviderNames).toEqual(['claude']);
    expect(next.agentPresetName).toBe('AllClaude');
    expect(next.agentPresetModified).toBe(false);
    expect(next.agentRows.captain).toMatchObject({
      configName: 'claude-cfg',
      modelOverride: null,
      effortOverride: null,
    });
    expect(next.agentRows.solo.configName).toBe('claude-cfg');
    const selection = { profileKey: 'Coder', mode: 'subset', configKeys: ['claude-cfg'] };
    expect(next.teamStates.get('Squad')).toEqual({
      selections: [selection],
      templateSelections: [selection],
    });
  });

  it('ignores attempts to clear the provider selection', () => {
    const preview = makePreview();
    const seeded = initialWizardConfigState(preview);

    expect(runHandler(preview, seeded, (h) => h.onSelectedProvidersChange([]))).toBe(seeded);
  });

  // The hook is the shared create/import entry point that rebuilds the team rows on a preset switch.
  it('applying a preset replaces edited team rows and clears the agent modified flag', () => {
    const preview = makePreview();
    const seeded: WizardConfigState = {
      ...initialWizardConfigState(preview),
      agentPresetModified: true,
    };

    const next = runHandler(preview, seeded, (h) => {
      h.onTeamStateChange('Squad', { selections: [{ profileKey: 'Coder', mode: 'remove' }] });
      h.onApplyPreset(' allclaude ');
    });

    expect(next.agentPresetName).toBe('AllClaude');
    expect(next.agentPresetModified).toBe(false);
    expect(next.agentRows['captain']).toMatchObject({ configName: 'claude-cfg', pinned: true });
    const selection = { profileKey: 'Coder', mode: 'subset', configKeys: ['claude-cfg'] };
    expect(next.teamStates.get('Squad')).toEqual({
      selections: [selection],
      templateSelections: [selection],
    });
  });

  it.each([
    ['another provider clears', 'codex-cfg', null, null],
    ['the same provider keeps', 'claude-alt', 'opus', 'high'],
  ])(
    'changing the config to %s the model and effort overrides',
    (_case, configName, model, effort) => {
      const preview = makePreview();
      preview.payload.profiles![0].providerConfigs!.push({
        name: 'claude-alt',
        providerName: 'claude',
      } as NonNullable<
        NonNullable<SetupPreviewResponse['payload']['profiles']>[number]['providerConfigs']
      >[number]);
      const base = initialWizardConfigState(preview);
      const seeded: WizardConfigState = {
        ...base,
        agentRows: {
          ...base.agentRows,
          captain: {
            ...base.agentRows['captain'],
            modelOverride: 'opus',
            effortOverride: 'high',
            fallbackFromConfigName: 'gone-cfg',
          },
        },
      };

      const next = runHandler(preview, seeded, (h) =>
        h.onAgentRowChange('Captain', { configName, pinned: true }),
      );

      expect(next.agentRows['captain']).toEqual({
        agentName: 'Captain',
        profileId: 'profile-1',
        configName,
        pinned: true,
        modelOverride: model,
        effortOverride: effort,
      });
    },
  );

  it('editing an agent row marks the applied preset modified', () => {
    const preview = makePreview();
    const next = runHandler(preview, initialWizardConfigState(preview), (h) =>
      h.onAgentRowChange('Captain', { configName: 'codex-cfg', pinned: true }),
    );
    expect(next.agentPresetName).toBe('MixedCodex');
    expect(next.agentPresetModified).toBe(true);
  });

  /** The Codex option of the fixture profile. */
  const codexOption = (preview: SetupPreviewResponse) =>
    preview.payload.profiles![0].providerConfigs!.find(
      ({ providerName }) => providerName === 'codex',
    )!;

  /** The row change that the agent popover sends for a user's choice. */
  const popoverChoice = (configName: string) => ({
    configName,
    pinned: true,
    userSelectedOption: true,
  });

  // The shared config hook and emission builder expose both sides of the request contract.
  it('emits a marked template option whose provider is outside the selection', () => {
    const preview = makePreview();
    const [agent] = preview.payload.agents!;
    const option = codexOption(preview);
    agent.providerConfigName = option.name;
    const state = runHandler(preview, wizardConfigStateFor(preview, ['claude']), (h) =>
      h.onAgentRowChange(agent.name, popoverChoice(option.name)),
    );

    const emission = buildConfigEmission(preview, state);
    expect(emission.selectedProviderNames).toEqual(['claude']);
    expect(emission.agentOverrides).toEqual([
      { agentName: agent.name, providerConfigName: option.name },
    ]);
    expect(emission.presetName).toBeUndefined();
  });

  // The shared hook exposes the rebuilt row and its matching emission without rendering a dialog.
  it('clears a manual edit to an agent omitted by the newly applied setup', () => {
    const preview = makePreview();
    const [partialSetup] = preview.payload.presets!;
    const agent = preview.payload.agents!.find(
      ({ name }) => !partialSetup.agentConfigs.some(({ agentName }) => agentName === name),
    )!;
    const option = codexOption(preview);
    const seeded = wizardConfigStateFor(preview, ['claude'], { useSuggestedPreset: false });
    const edited = runHandler(preview, seeded, (h) =>
      h.onAgentRowChange(agent.name, popoverChoice(option.name)),
    );
    const key = agentKey(agent.name);
    expect(edited.agentRows[key].configName).toBe(option.name);

    const next = runHandler(preview, edited, (h) => h.onApplyPreset(partialSetup.name));

    expect(next.agentRows[key]).toEqual(seeded.agentRows[key]);
    const emission = buildConfigEmission(preview, next);
    expect(emission.presetName).toBe(partialSetup.name);
    expect(emission.agentOverrides).toBeUndefined();
  });

  // The hook is the entry point that receives the requested setup name.
  it('uses template defaults when the requested setup is outside the provider selection', () => {
    const preview = makePreview();
    const unavailableSetup = preview.presetProviderCoverage.find(({ referencedProviders }) =>
      referencedProviders.includes('codex'),
    )!;
    const selected = ['claude'];
    const seeded = wizardConfigStateFor(preview, selected);

    const next = runHandler(preview, seeded, (h) => h.onApplyPreset(unavailableSetup.presetName));

    expect(next).toEqual(wizardConfigStateFor(preview, selected, { useSuggestedPreset: false }));
  });
});

describe('buildConfigEmission team overrides', () => {
  it('filters team subset config names to the selected providers', () => {
    const preview = makePreview({
      localAvailability: { installedProviders: [{ id: 'p-claude', name: 'claude' }] },
    });
    (preview.payload as { teams?: unknown }).teams = [
      {
        name: 'Squad',
        teamLeadAgentName: 'Captain',
        memberAgentNames: ['Solo'],
        allowTeamLeadCreateAgents: true,
        profileNames: ['Coder'],
        // Template pins the team to BOTH configs; only claude is installed.
        profileSelections: [{ profileName: 'Coder', configNames: ['codex-cfg', 'claude-cfg'] }],
      },
    ];

    const emission = buildConfigEmission(preview, initialWizardConfigState(preview, false));

    expect(emission.teamOverrides).toEqual([
      {
        teamName: 'Squad',
        allowTeamLeadCreateAgents: true,
        profileNames: ['Coder'],
        profileSelections: [{ profileName: 'Coder', configNames: ['claude-cfg'] }],
      },
    ]);
  });
});
