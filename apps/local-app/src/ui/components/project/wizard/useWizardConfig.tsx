import { useCallback, type ComponentType } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ExportData } from '@devchain/shared';
import type {
  AgentOverridePayload,
  SetupPreviewResponse,
} from '@/ui/pages/projects/lib/project-contracts';
import type { WizardStep } from '@/ui/hooks/useProjectSetupWizard';
import type { BackendId } from '@/ui/lib/api-transport';
import { SetupReviewProvider } from './SetupReviewContext';
import type { WizardConfigHandlers, WizardConfigState } from './wizardConfigTypes';
import {
  defaultSelectedProviders,
  deriveFamilyProviderMappings,
  installedProviderNames,
  setupProviderList,
} from './providerSelection';
import {
  agentKey,
  applyPresetToRows,
  buildAgentOverrides,
  buildAgentPlanEmission,
  configProviderName,
  eqName,
  profileForAgent,
  resolveAgentRow,
  selectablePresetNames,
  selectablePresetsNewestFirst,
  templateAgentRows,
  withoutProviderFallback,
  type AgentRow,
} from './agentPlan';
import {
  buildTeamOverrides,
  configurableTeams,
  templateTeamStates,
  type ParsedTemplateProfile,
  type ParsedTemplateTeam,
  type TeamPanelState,
} from './teamPlan';

export type { WizardConfigHandlers, WizardConfigState };

interface PresetChoice {
  presetName?: string | null;
  useSuggestedPreset?: boolean;
}

/**
 * The setup to apply for a provider selection: the named one when it fits, else the suggested
 * (newest fitting) one unless `useSuggestedPreset` is false. Undefined means the template defaults.
 */
export function presetFor(
  preview: SetupPreviewResponse,
  selectedProviderNames: string[],
  { presetName, useSuggestedPreset = true }: PresetChoice = {},
) {
  const presets = selectablePresetsNewestFirst(preview, selectedProviderNames);
  return (
    presets.find((candidate) => eqName(candidate.name, presetName)) ??
    (useSuggestedPreset ? presets[0] : undefined)
  );
}

export function wizardConfigStateFor(
  preview: SetupPreviewResponse,
  selectedProviderNames: string[],
  choice: PresetChoice = {},
): WizardConfigState {
  let agentRows = templateAgentRows(preview.payload, selectedProviderNames);
  const preset = presetFor(preview, selectedProviderNames, choice);
  if (preset) {
    agentRows = applyPresetToRows(agentRows, preset);
  }

  return {
    selectedProviderNames,
    agentRows,
    agentPresetName: preset?.name ?? null,
    agentPresetModified: false,
    teamStates: templateTeamStates(preview.payload, selectedProviderNames, preset),
    hasManualEdits: false,
  };
}

export function initialWizardConfigState(
  preview: SetupPreviewResponse,
  useSuggestedPreset = true,
  currentExport?: ExportData | null,
): WizardConfigState {
  return wizardConfigStateFor(
    preview,
    defaultSelectedProviders(setupProviderList(preview, currentExport)),
    { useSuggestedPreset },
  );
}

/**
 * Memoized setters for the shared setup state. `setState` is the flow controller's own `useState`
 * setter over a superset of {@link WizardConfigState}; the callbacks patch only the config slice,
 * so create/import can each carry extra fields untouched.
 */
export function useWizardConfigHandlers<S extends WizardConfigState>(
  preview: SetupPreviewResponse | null,
  setState: Dispatch<SetStateAction<S | null>>,
): WizardConfigHandlers {
  const onSelectedProvidersChange = useCallback(
    (next: string[]) => {
      if (!preview || next.length === 0) return;
      setState((prev) =>
        prev
          ? {
              ...prev,
              ...wizardConfigStateFor(preview, next, { presetName: prev.agentPresetName }),
            }
          : prev,
      );
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
          agentRows: {
            ...prev.agentRows,
            [key]: patchAgentRow(preview, prev.selectedProviderNames, existing, patch),
          },
          agentPresetModified: prev.agentPresetName ? true : prev.agentPresetModified,
          hasManualEdits: true,
        };
      });
    },
    [preview, setState],
  );

  const onApplyPreset = useCallback(
    (name: string) => {
      if (!preview) return;
      setState((prev) =>
        prev
          ? {
              ...prev,
              ...wizardConfigStateFor(preview, prev.selectedProviderNames, {
                presetName: name,
                useSuggestedPreset: false,
              }),
            }
          : prev,
      );
    },
    [preview, setState],
  );

  const onTeamStateChange = useCallback(
    (teamName: string, patch: Partial<TeamPanelState>) => {
      setState((prev) => {
        if (!prev) return prev;
        const current = prev.teamStates.get(teamName);
        if (!current) return prev;
        const nextStates = new Map(prev.teamStates);
        nextStates.set(teamName, { ...current, ...patch });
        return { ...prev, teamStates: nextStates, hasManualEdits: true };
      });
    },
    [setState],
  );

  const onResetSetup = useCallback(() => {
    if (!preview) return;
    setState((prev) =>
      prev
        ? {
            ...prev,
            ...wizardConfigStateFor(preview, prev.selectedProviderNames, {
              presetName: prev.agentPresetName,
              useSuggestedPreset: false,
            }),
          }
        : prev,
    );
  }, [preview, setState]);

  return {
    onSelectedProvidersChange,
    onAgentRowChange,
    onApplyPreset,
    onTeamStateChange,
    onResetSetup,
  };
}

/**
 * Apply a user edit to a row. A config change on another provider clears the model and effort
 * overrides (they name models of the old provider) unless the patch sets them itself; any config
 * change ends the row's fallback state.
 */
function patchAgentRow(
  preview: SetupPreviewResponse | null,
  selectedProviderNames: string[],
  existing: AgentRow,
  patch: Partial<AgentRow>,
): AgentRow {
  if (patch.configName === undefined || patch.configName === existing.configName) {
    return { ...existing, ...patch };
  }
  const agent = preview?.payload.agents?.find(
    (a) => agentKey(a.name) === agentKey(existing.agentName),
  );
  const profile = agent ? profileForAgent(agent, preview?.payload.profiles ?? []) : undefined;
  const currentConfigName =
    existing.configName ??
    resolveAgentRow(
      existing,
      profile,
      selectedProviderNames,
      preview ? installedProviderNames(preview) : [],
    ).resolvedConfigName;
  const fromProvider = configProviderName(profile, currentConfigName);
  const toProvider = configProviderName(profile, patch.configName);
  const providerChanged =
    fromProvider !== undefined && toProvider !== undefined && fromProvider !== toProvider;
  return {
    ...withoutProviderFallback(existing),
    ...(providerChanged ? { modelOverride: null, effortOverride: null } : {}),
    ...patch,
  };
}

/**
 * Build the shared "Review setup" step. `Review` is the flow's composition of the setup sections;
 * it renders inside a {@link SetupReviewProvider} for this state. Unresolved agent rows block the
 * step.
 */
export function buildSetupStep(params: {
  preview: SetupPreviewResponse | null;
  state: WizardConfigState | null;
  handlers: WizardConfigHandlers;
  Review: ComponentType;
  /** The backend that answered the preview. */
  backend: BackendId;
  currentExport?: ExportData | null;
  validateTemplateAgents?: boolean;
}): WizardStep {
  const { preview, state, handlers, Review, backend, currentExport } = params;

  const unresolvedAgents =
    params.validateTemplateAgents !== false && preview && state
      ? buildAgentOverrides(
          state.agentRows,
          preview.payload.agents ?? [],
          preview.payload.profiles ?? [],
          state.selectedProviderNames,
          installedProviderNames(preview),
        ).unresolvedAgents
      : [];

  return {
    id: 'setup',
    title: 'Review setup',
    description: 'Check what the template creates. Change any value in place.',
    wide: true,
    canProceed: unresolvedAgents.length === 0,
    render: () =>
      state && preview ? (
        <SetupReviewProvider
          preview={preview}
          state={state}
          handlers={handlers}
          backend={backend}
          currentExport={currentExport}
        >
          <Review />
        </SetupReviewProvider>
      ) : null,
  };
}

export interface ConfigEmission {
  selectedProviderNames?: string[];
  presetName?: string;
  agentOverrides?: AgentOverridePayload[];
  teamOverrides?: ReturnType<typeof buildTeamOverrides>;
  /**
   * Family→provider mappings (slug → selected available alternative), derived from the same
   * selection as selectedProviderNames. Present only when non-empty so callers can spread
   * directly, matching the create/import "conditional spread" contract.
   */
  familyProviderMappings?: Record<string, string>;
}

/** `selectedProviderNames` for a request body: present only when a provider is selected. */
export function selectedProvidersEmission(
  state: WizardConfigState,
): Pick<ConfigEmission, 'selectedProviderNames'> {
  return state.selectedProviderNames.length > 0
    ? { selectedProviderNames: state.selectedProviderNames }
    : {};
}

/**
 * The shared setup contribution to a create/import payload: transient provider choice metadata,
 * the family→provider mappings, the agent plan (presetName XOR agentOverrides,
 * delta-6), and the team overrides. Each field is present only when it carries content, so callers
 * can spread it directly. ONE emission path consumed by BOTH useCreateProjectWizard and
 * useImportProjectWizard — the two flows cannot drift.
 */
export function buildConfigEmission(
  preview: SetupPreviewResponse | null,
  state: WizardConfigState,
): ConfigEmission {
  const emission: ConfigEmission = selectedProvidersEmission(state);

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
      installedProviderNames: installedProviderNames(preview),
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
