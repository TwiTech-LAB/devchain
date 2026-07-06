import { renderHook } from '@testing-library/react';
import type { Dispatch, SetStateAction } from 'react';
import {
  buildConfigEmission,
  buildConfigSteps,
  initialWizardConfigState,
  useWizardConfigHandlers,
  type WizardConfigState,
} from './useWizardConfig';
import type { SetupPreviewResponse } from '@/ui/pages/projects/lib/project-api';

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
      teams: [],
      // Storage/export order is oldest-first: AllClaude was created before MixedCodex.
      presets: [
        {
          name: 'AllClaude',
          agentConfigs: [{ agentName: 'Captain', providerConfigName: 'claude-cfg' }],
        },
        {
          name: 'MixedCodex',
          agentConfigs: [{ agentName: 'Solo', providerConfigName: 'codex-cfg' }],
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

describe('initialWizardConfigState', () => {
  it('preselects the default-setup providers and auto-applies the newest fitting preset', () => {
    const state = initialWizardConfigState(makePreview());

    // Both agents' template defaults resolve to claude-cfg → only claude is required;
    // codex (referenced by a config but not by the default setup) starts deselected.
    expect(state.selectedProviderNames).toEqual(['claude']);
    expect(state.agentPresetName).toBe('AllClaude');
    expect(state.agentPresetModified).toBe(false);
    expect(state.presetAuto).toBe(true);
  });

  it('includes providers required via an agent template-named config', () => {
    const preview = makePreview();
    (preview.payload.agents![1] as { providerConfigName?: string }).providerConfigName =
      'codex-cfg';

    const state = initialWizardConfigState(preview);

    expect(state.selectedProviderNames).toEqual(['claude', 'codex']);
    // With both providers preselected, the newest preset fits and applies.
    expect(state.agentPresetName).toBe('MixedCodex');
  });

  it('leaves required-but-unavailable providers deselected', () => {
    const preview = makePreview({
      providerSummary: [
        { name: 'claude', available: true, families: [], agentCount: 2 },
        { name: 'codex', available: false, families: [], agentCount: 0 },
      ] as unknown as SetupPreviewResponse['providerSummary'],
    });
    (preview.payload.agents![1] as { providerConfigName?: string }).providerConfigName =
      'codex-cfg';

    const state = initialWizardConfigState(preview);

    expect(state.selectedProviderNames).toEqual(['claude']);
  });

  it('auto-applies the most recently updated selectable preset once providers are selected', () => {
    const preview = makePreview();
    const state = changeSelection(preview, initialWizardConfigState(preview), ['claude', 'codex']);

    expect(state.agentPresetName).toBe('MixedCodex');
    expect(state.agentPresetModified).toBe(false);
    // The preset's row actually got applied (config pinned for the covered agent).
    expect(state.agentRows['solo']).toMatchObject({ configName: 'codex-cfg', pinned: true });
  });

  it('falls back to the older preset when the newest does not fit the selection', () => {
    const preview = makePreview();
    const state = changeSelection(preview, initialWizardConfigState(preview), ['claude']);

    expect(state.agentPresetName).toBe('AllClaude');
  });
});

/** Run setSelectedProviderNames against a seeded state and return the state it produces. */
function changeSelection(
  preview: SetupPreviewResponse,
  seeded: WizardConfigState,
  next: string[],
): WizardConfigState {
  let produced: WizardConfigState | null = seeded;
  const setState: Dispatch<SetStateAction<WizardConfigState | null>> = (action) => {
    produced = typeof action === 'function' ? action(produced) : action;
  };
  const { result } = renderHook(() => useWizardConfigHandlers(preview, setState));
  result.current.setSelectedProviderNames(next);
  return produced!;
}

describe('setSelectedProviderNames preset revalidation', () => {
  it('re-derives the default preset when narrowing kills the auto-applied preset', () => {
    const preview = makePreview();
    // Select both providers: the newest preset (MixedCodex) auto-applies, pinning codex-cfg on Solo.
    const seeded = changeSelection(preview, initialWizardConfigState(preview), ['claude', 'codex']);
    expect(seeded.agentPresetName).toBe('MixedCodex');
    expect(seeded.presetAuto).toBe(true);
    expect(seeded.agentRows['solo']).toMatchObject({ configName: 'codex-cfg', pinned: true });

    const next = changeSelection(preview, seeded, ['claude']);

    // As if the wizard had been opened with only claude: fallback preset applied, stale pin gone.
    expect(next.selectedProviderNames).toEqual(['claude']);
    expect(next.agentPresetName).toBe('AllClaude');
    expect(next.agentPresetModified).toBe(false);
    expect(next.presetAuto).toBe(true);
    expect(next.agentRows['captain']).toMatchObject({ configName: 'claude-cfg', pinned: true });
    // Solo's stale codex-cfg preset pin is replaced by its template default (explicitly named
    // in the template, hence pinned by initialAgentRows).
    expect(next.agentRows['solo']).toMatchObject({ configName: 'claude-cfg', pinned: true });

    // Payload contract: the re-derived preset emits as presetName, not as agentOverrides.
    const emission = buildConfigEmission(preview, next);
    expect(emission.presetName).toBe('AllClaude');
    expect(emission.agentOverrides).toBeUndefined();
  });

  it('re-widening in auto mode applies the newest now-selectable preset', () => {
    const preview = makePreview();
    const seeded = initialWizardConfigState(preview);

    // Narrow: only the older claude-only preset fits.
    const narrowed = changeSelection(preview, seeded, ['claude']);
    expect(narrowed.agentPresetName).toBe('AllClaude');

    // Widen back: the newest preset (MixedCodex) becomes selectable again and takes over.
    const widened = changeSelection(preview, narrowed, ['claude', 'codex']);
    expect(widened.agentPresetName).toBe('MixedCodex');
    expect(widened.presetAuto).toBe(true);
    expect(widened.agentRows['solo']).toMatchObject({ configName: 'codex-cfg', pinned: true });
  });

  it('re-widening after an auto drop to no-preset re-applies the default', () => {
    const preview = makePreview();
    // Start from the fully-selected auto state (MixedCodex applied with a codex-cfg pin).
    const seeded = changeSelection(preview, initialWizardConfigState(preview), ['claude', 'codex']);

    // Nothing fits an empty selection: plain template rows, no preset, still auto.
    const emptied = changeSelection(preview, seeded, []);
    expect(emptied.agentPresetName).toBeNull();
    expect(emptied.agentPresetModified).toBe(false);
    expect(emptied.presetAuto).toBe(true);
    // Rows return to template defaults: Solo's stale codex-cfg preset pin is gone.
    expect(emptied.agentRows['solo']).toMatchObject({ configName: 'claude-cfg', pinned: true });

    const restored = changeSelection(preview, emptied, ['claude', 'codex']);
    expect(restored.agentPresetName).toBe('MixedCodex');
  });

  it('keeps a user-picked preset while it still fits the selection', () => {
    const preview = makePreview();
    // The user explicitly picked the OLDER preset from the picker (manual mode).
    const seeded: WizardConfigState = {
      ...initialWizardConfigState(preview),
      agentPresetName: 'AllClaude',
      agentPresetModified: false,
      presetAuto: false,
    };

    const next = changeSelection(preview, seeded, ['claude']);

    // AllClaude is still selectable under claude-only — never switched away.
    expect(next.selectedProviderNames).toEqual(['claude']);
    expect(next.agentPresetName).toBe('AllClaude');
    expect(next.presetAuto).toBe(false);
    expect(next.agentRows).toEqual(seeded.agentRows);
  });

  it('falls back to auto-derivation when an unedited user pick becomes unselectable', () => {
    const preview = makePreview();
    // The user explicitly picked the newest preset (manual, unedited), then drops codex.
    const seeded: WizardConfigState = {
      ...changeSelection(preview, initialWizardConfigState(preview), ['claude', 'codex']),
      presetAuto: false,
    };
    expect(seeded.agentPresetName).toBe('MixedCodex');

    const next = changeSelection(preview, seeded, ['claude']);

    // The pick is impossible now — the default takes over again and auto mode resumes.
    expect(next.agentPresetName).toBe('AllClaude');
    expect(next.presetAuto).toBe(true);
    expect(next.agentRows['solo']).toMatchObject({ configName: 'claude-cfg', pinned: true });
  });

  it('keeps hand-edited rows and honestly clears the preset when it becomes unselectable', () => {
    const preview = makePreview();
    // Row edits on an applied preset set presetModified AND flip auto off.
    const seeded: WizardConfigState = {
      ...changeSelection(preview, initialWizardConfigState(preview), ['claude', 'codex']),
      agentPresetModified: true,
      presetAuto: false,
    };
    const editedRows = seeded.agentRows;

    const next = changeSelection(preview, seeded, ['claude']);

    expect(next.agentPresetName).toBeNull();
    expect(next.agentPresetModified).toBe(false);
    expect(next.agentRows).toEqual(editedRows);
  });

  it('never touches rows in Custom mode (preset null), where edits are not tracked as modified', () => {
    const preview = makePreview();
    const base = initialWizardConfigState(preview);
    // Clearing to Custom and editing rows both leave auto mode.
    const seeded: WizardConfigState = {
      ...base,
      agentPresetName: null,
      agentPresetModified: false,
      presetAuto: false,
      agentRows: {
        ...base.agentRows,
        solo: { ...base.agentRows['solo'], configName: 'codex-cfg', pinned: true },
      },
    };

    const next = changeSelection(preview, seeded, ['claude']);

    expect(next.selectedProviderNames).toEqual(['claude']);
    expect(next.agentPresetName).toBeNull();
    expect(next.agentRows).toEqual(seeded.agentRows);
  });
});

describe('useWizardConfigHandlers presetAuto transitions', () => {
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

  it('picking a preset from the picker leaves auto mode', () => {
    const preview = makePreview();
    const next = runHandler(preview, initialWizardConfigState(preview), (h) =>
      h.onApplyPreset('AllClaude'),
    );
    expect(next.agentPresetName).toBe('AllClaude');
    expect(next.presetAuto).toBe(false);
  });

  it('clearing to Custom leaves auto mode', () => {
    const preview = makePreview();
    const next = runHandler(preview, initialWizardConfigState(preview), (h) => h.onClearPreset());
    expect(next.agentPresetName).toBeNull();
    expect(next.presetAuto).toBe(false);
  });

  it('editing an agent row leaves auto mode', () => {
    const preview = makePreview();
    // Seed the auto-applied preset state (selection made, MixedCodex applied), then edit a row.
    const seeded = changeSelection(preview, initialWizardConfigState(preview), ['claude', 'codex']);
    const next = runHandler(preview, seeded, (h) =>
      h.onAgentRowChange('Captain', { configName: 'codex-cfg', pinned: true }),
    );
    expect(next.presetAuto).toBe(false);
    expect(next.agentPresetModified).toBe(true);
  });
});

describe('buildConfigSteps step descriptions', () => {
  it('gives the Providers step its provider-selection description', () => {
    const preview = makePreview();
    const { steps } = buildConfigSteps({
      preview,
      state: initialWizardConfigState(preview),
      handlers: {
        setSelectedProviderNames: jest.fn(),
        onAgentRowChange: jest.fn(),
        onApplyPreset: jest.fn(),
        onClearPreset: jest.fn(),
        onTeamStateChange: jest.fn(),
      },
    });

    expect(steps[0].description).toBe(
      'Select which providers you would like to use in this project.',
    );
  });
});

describe('buildConfigEmission team overrides', () => {
  it('filters team subset config names to the Step-1 selection', () => {
    const preview = makePreview();
    (preview.payload as { teams?: unknown }).teams = [
      {
        name: 'Squad',
        teamLeadAgentName: 'Captain',
        memberAgentNames: ['Solo'],
        allowTeamLeadCreateAgents: true,
        profileNames: ['Coder'],
        // Template pins the team to BOTH configs; only claude survives Step 1 below.
        profileSelections: [{ profileName: 'Coder', configNames: ['codex-cfg', 'claude-cfg'] }],
      },
    ];

    const seeded = changeSelection(preview, initialWizardConfigState(preview), ['claude']);
    const emission = buildConfigEmission(preview, seeded);

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
