import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type {
  AgentOverridePayload,
  SetupPreviewResponse,
} from '@/ui/pages/projects/lib/project-api';
import type { WizardStep } from '@/ui/hooks/useProjectSetupWizard';
import { Step1Providers } from './Step1Providers';
import { Step2Agents } from './Step2Agents';
import { Step3Teams } from './Step3Teams';
import { deriveFamilyProviderMappings, getUncoveredFamilies } from './providerSelection';
import {
  agentKey,
  applyPresetToRows,
  buildAgentOverrides,
  buildAgentPlanEmission,
  defaultSetupProviders,
  initialAgentRows,
  selectablePresetNames,
  type AgentRow,
  type TemplateProfile,
} from './agentPlan';
import {
  buildTeamOverrides,
  configurableTeams,
  initialTeamStates,
  type ParsedTemplateProfile,
  type ParsedTemplateTeam,
  type TeamPanelState,
} from './teamPlan';

/**
 * The Steps 1-3 domain state shared by BOTH the create and import wizards (Providers → Agents →
 * Teams). Lifted to each flow controller so Back/Next never lose it. The create-only submit fields
 * and the import-only dry-run/status state live in their respective hooks — this module owns only the
 * common config surface + its emission, so the two flows can't drift.
 */
export interface WizardConfigState {
  /** Step 1 selection. Starts EMPTY — the user must explicitly opt into providers. */
  selectedProviderNames: string[];
  /** Step 2 per-agent rows (config + model/effort overrides), keyed by lowercased agent name. */
  agentRows: Record<string, AgentRow>;
  /** Step 2 applied preset (null = custom). */
  agentPresetName: string | null;
  /** True once an applied preset was hand-edited (forces agentOverrides emission over presetName). */
  agentPresetModified: boolean;
  /**
   * True while the preset (or null) came from auto-derivation. In auto mode every Step-1 selection
   * change re-derives rows + the newest selectable preset; the flag flips off once the user takes
   * over the plan (picker apply/clear or a row edit) so their choice is never switched away.
   * Never emitted.
   */
  presetAuto: boolean;
  /** Step 3 per-team panel state (byte-identical emission to the legacy Configure Teams dialog). */
  teamStates: Map<string, TeamPanelState>;
}

/**
 * Derive the agent-plan slice for a provider selection as if the wizard had been opened with it:
 * fresh template rows, then the most recently updated selectable preset applied. Storage order
 * represents update time (newest appended last) — the same convention the Agents page's
 * PresetSelector sorts by. The user can switch or clear the preset on Step 2.
 */
function deriveDefaultAgentPlan(
  preview: SetupPreviewResponse,
  selectedProviderNames: string[],
): Pick<WizardConfigState, 'agentRows' | 'agentPresetName'> {
  let agentRows = initialAgentRows(preview.payload.agents ?? []);
  const selectable = selectablePresetNames(preview.presetProviderCoverage, selectedProviderNames);
  const defaultPreset = [...(preview.payload.presets ?? [])]
    .reverse()
    .find((p) => selectable.has(p.name));
  if (defaultPreset) {
    agentRows = applyPresetToRows(agentRows, defaultPreset);
  }
  return { agentRows, agentPresetName: defaultPreset?.name ?? null };
}

/** Build the initial Steps 1-3 state from a resolved setup-preview. */
export function initialWizardConfigState(preview: SetupPreviewResponse): WizardConfigState {
  // Preselect the providers the template's DEFAULT (non-preset) setup requires — the wizard
  // opens ready to create the template as authored, and the user only opts into extras.
  // Required-but-not-installed providers stay unchecked (Step 1 renders them disabled with a
  // "Not installed" hint); other referenced providers start deselected.
  const required = defaultSetupProviders(
    preview.payload.agents ?? [],
    (preview.payload.profiles ?? []) as TemplateProfile[],
  );
  const selectedProviderNames = preview.providerSummary
    .filter((entry) => entry.available && required.has(entry.name.trim().toLowerCase()))
    .map((entry) => entry.name);

  return {
    selectedProviderNames,
    ...deriveDefaultAgentPlan(preview, selectedProviderNames),
    agentPresetModified: false,
    presetAuto: true,
    teamStates: initialTeamStates(
      configurableTeams((preview.payload.teams ?? []) as ParsedTemplateTeam[]),
    ),
  };
}

export interface WizardConfigHandlers {
  setSelectedProviderNames: (next: string[]) => void;
  onAgentRowChange: (agentName: string, patch: Partial<AgentRow>) => void;
  onApplyPreset: (name: string) => void;
  onClearPreset: () => void;
  onTeamStateChange: (teamName: string, patch: Partial<TeamPanelState>) => void;
}

/**
 * Memoized setters for the shared Steps 1-3 state. `setState` is the flow controller's own
 * `useState` setter over a superset of {@link WizardConfigState}; the callbacks patch only the config
 * slice, so create/import can each carry extra fields untouched.
 */
export function useWizardConfigHandlers<S extends WizardConfigState>(
  preview: SetupPreviewResponse | null,
  setState: Dispatch<SetStateAction<S | null>>,
): WizardConfigHandlers {
  const setSelectedProviderNames = useCallback(
    (next: string[]) => {
      setState((prev) => {
        if (!prev) return prev;
        if (!preview) {
          return { ...prev, selectedProviderNames: next };
        }
        // Auto mode (the user never took over the plan): every selection change re-derives rows +
        // the newest selectable preset, as if the wizard had been opened with this selection.
        if (prev.presetAuto) {
          return {
            ...prev,
            selectedProviderNames: next,
            ...deriveDefaultAgentPlan(preview, next),
            agentPresetModified: false,
          };
        }
        // Manual mode: an explicit Custom (null) or a still-fitting user-picked preset is never
        // switched away, and hand-edited rows are never clobbered.
        if (
          !prev.agentPresetName ||
          selectablePresetNames(preview.presetProviderCoverage, next).has(prev.agentPresetName)
        ) {
          return { ...prev, selectedProviderNames: next };
        }
        // The user-picked preset no longer fits the selection. Hand-edited rows are kept and the
        // state honestly becomes Custom; an unedited pick falls back to auto-derivation (the pick
        // is impossible, so the default takes over again).
        if (prev.agentPresetModified) {
          return {
            ...prev,
            selectedProviderNames: next,
            agentPresetName: null,
            agentPresetModified: false,
          };
        }
        return {
          ...prev,
          selectedProviderNames: next,
          ...deriveDefaultAgentPlan(preview, next),
          agentPresetModified: false,
          presetAuto: true,
        };
      });
    },
    [preview, setState],
  );

  const onAgentRowChange = useCallback(
    (agentName: string, patch: Partial<AgentRow>) => {
      setState((prev) => {
        if (!prev) return prev;
        const key = agentKey(agentName);
        const existing = prev.agentRows[key];
        if (!existing) return prev;
        return {
          ...prev,
          agentRows: { ...prev.agentRows, [key]: { ...existing, ...patch } },
          agentPresetModified: prev.agentPresetName ? true : prev.agentPresetModified,
          presetAuto: false,
        };
      });
    },
    [setState],
  );

  const onApplyPreset = useCallback(
    (name: string) => {
      const preset = preview?.payload.presets?.find((p) => p.name === name);
      if (!preset) return;
      setState((prev) =>
        prev
          ? {
              ...prev,
              agentRows: applyPresetToRows(prev.agentRows, preset),
              agentPresetName: name,
              agentPresetModified: false,
              presetAuto: false,
            }
          : prev,
      );
    },
    [preview, setState],
  );

  const onClearPreset = useCallback(() => {
    setState((prev) =>
      prev
        ? { ...prev, agentPresetName: null, agentPresetModified: false, presetAuto: false }
        : prev,
    );
  }, [setState]);

  const onTeamStateChange = useCallback(
    (teamName: string, patch: Partial<TeamPanelState>) => {
      setState((prev) => {
        if (!prev) return prev;
        const current = prev.teamStates.get(teamName);
        if (!current) return prev;
        const nextStates = new Map(prev.teamStates);
        nextStates.set(teamName, { ...current, ...patch });
        return { ...prev, teamStates: nextStates };
      });
    },
    [setState],
  );

  return {
    setSelectedProviderNames,
    onAgentRowChange,
    onApplyPreset,
    onClearPreset,
    onTeamStateChange,
  };
}

export interface ConfigStepsResult {
  /** The Providers / Agents / Teams wizard steps, in order. */
  steps: WizardStep[];
  /** Agent names that cannot resolve a config under the current selection (Step-2 hard block). */
  unresolvedAgents: string[];
}

/**
 * Build the three shared wizard steps (Providers → Agents → Teams) with their gates + renders. Teams
 * is skipped when the template has no configurable team. Returns the unresolved-agent list too so the
 * caller can surface a Next block / status.
 */
export function buildConfigSteps(params: {
  preview: SetupPreviewResponse | null;
  state: WizardConfigState | null;
  handlers: WizardConfigHandlers;
}): ConfigStepsResult {
  const { preview, state, handlers } = params;
  const selectedProviders = state?.selectedProviderNames ?? [];

  const uncoveredFamilies = preview
    ? getUncoveredFamilies(preview.familyAlternatives, selectedProviders)
    : [];

  const unresolvedAgents =
    preview && state
      ? buildAgentOverrides(
          state.agentRows,
          preview.payload.agents ?? [],
          preview.payload.profiles ?? [],
          selectedProviders,
        ).unresolvedAgents
      : [];

  const visibleTeams = configurableTeams((preview?.payload.teams ?? []) as ParsedTemplateTeam[]);

  const steps: WizardStep[] = [
    {
      id: 'providers',
      title: 'Providers',
      description: 'Select which providers you would like to use in this project.',
      canProceed:
        (preview?.providerSummary.length ?? 0) === 0 ||
        (selectedProviders.length > 0 && uncoveredFamilies.length === 0),
      render: () =>
        state && preview ? (
          <Step1Providers
            providerSummary={preview.providerSummary}
            selectedProviderNames={selectedProviders}
            uncoveredFamilies={uncoveredFamilies}
            onSelectedChange={handlers.setSelectedProviderNames}
          />
        ) : null,
    },
    {
      id: 'agents',
      title: 'Agents',
      canProceed: unresolvedAgents.length === 0,
      render: () =>
        state && preview ? (
          <Step2Agents
            preview={preview}
            selectedProviderNames={selectedProviders}
            rows={state.agentRows}
            presetName={state.agentPresetName}
            presetModified={state.agentPresetModified}
            onRowChange={handlers.onAgentRowChange}
            onApplyPreset={handlers.onApplyPreset}
            onClearPreset={handlers.onClearPreset}
          />
        ) : null,
    },
    {
      id: 'teams',
      title: 'Teams',
      skipped: visibleTeams.length === 0,
      canProceed: true,
      render: () =>
        state && preview ? (
          <Step3Teams
            visibleTeams={visibleTeams}
            profiles={(preview.payload.profiles ?? []) as ParsedTemplateProfile[]}
            selectedProviderNames={selectedProviders}
            teamStates={state.teamStates}
            onTeamStateChange={handlers.onTeamStateChange}
          />
        ) : null,
    },
  ];

  return { steps, unresolvedAgents };
}

export interface ConfigEmission {
  selectedProviderNames?: string[];
  presetName?: string;
  agentOverrides?: AgentOverridePayload[];
  teamOverrides?: ReturnType<typeof buildTeamOverrides>;
  /**
   * Step-1 family→provider mappings (slug → selected available alternative), derived from the
   * same selection as selectedProviderNames. Omitted when empty — this is how the wizard's Step 1
   * ABSORBS the legacy ProviderMappingModal. Present only when non-empty so callers can spread
   * directly, matching the create/import "conditional spread" contract.
   */
  familyProviderMappings?: Record<string, string>;
}

/**
 * The shared Steps 1-3 contribution to a create/import payload: the transient provider allowlist,
 * the family→provider mappings absorbed from Step 1, the agent plan (presetName XOR agentOverrides,
 * delta-6), and the team overrides. Each field is present only when it carries content, so callers
 * can spread it directly. ONE emission path consumed by BOTH useCreateProjectWizard and
 * useImportProjectWizard — the two flows cannot drift.
 */
export function buildConfigEmission(
  preview: SetupPreviewResponse | null,
  state: WizardConfigState,
): ConfigEmission {
  const emission: ConfigEmission = {};
  if (state.selectedProviderNames.length > 0) {
    emission.selectedProviderNames = state.selectedProviderNames;
  }

  if (preview) {
    const familyProviderMappings = deriveFamilyProviderMappings(
      preview.familyAlternatives,
      state.selectedProviderNames,
    );
    if (Object.keys(familyProviderMappings).length > 0) {
      emission.familyProviderMappings = familyProviderMappings;
    }

    const agentPlan = buildAgentPlanEmission({
      rows: state.agentRows,
      agents: preview.payload.agents ?? [],
      profiles: preview.payload.profiles ?? [],
      selectedProviderNames: state.selectedProviderNames,
      presetName: state.agentPresetName,
      presetModified: state.agentPresetModified,
      selectablePresets: selectablePresetNames(
        preview.presetProviderCoverage,
        state.selectedProviderNames,
      ),
    });
    Object.assign(emission, agentPlan);

    const teamOverrides = buildTeamOverrides(
      configurableTeams((preview.payload.teams ?? []) as ParsedTemplateTeam[]),
      state.teamStates,
      {
        profiles: (preview.payload.profiles ?? []) as ParsedTemplateProfile[],
        selectedProviderNames: state.selectedProviderNames,
      },
    );
    if (teamOverrides.length > 0) emission.teamOverrides = teamOverrides;
  }

  return emission;
}
