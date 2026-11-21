import type { AgentRow } from './agentPlan';
import type { TeamPanelState } from './teamPlan';

/**
 * The setup state shared by the create and import wizards. Lifted to each flow controller so
 * Back/Next never lose it. The create-only submit fields and the import-only dry-run/status state
 * live in their respective hooks — this module owns only the common config surface + its emission,
 * so the two flows can't drift.
 */
export interface WizardConfigState {
  /** The installed providers selected by the user, initially all installed providers in the list. */
  selectedProviderNames: string[];
  /** Per-agent rows (config + model/effort overrides), keyed by lowercased agent name. */
  agentRows: Record<string, AgentRow>;
  /** Applied preset (null = none). */
  agentPresetName: string | null;
  /** True once an applied preset was hand-edited (forces agentOverrides emission over presetName). */
  agentPresetModified: boolean;
  /** Per-team panel state: the config options each team lead may use. */
  teamStates: Map<string, TeamPanelState>;
}

export interface WizardConfigHandlers {
  onSelectedProvidersChange: (next: string[]) => void;
  onAgentRowChange: (agentName: string, patch: Partial<AgentRow>) => void;
  onApplyPreset: (name: string) => void;
  onTeamStateChange: (teamName: string, patch: Partial<TeamPanelState>) => void;
}
