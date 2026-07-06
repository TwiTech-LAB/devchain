import type { ExportData } from '@devchain/shared';
import type { FamilyAlternative, ProviderSummaryEntry } from '../helpers/profile-mapping.helpers';

/**
 * Per-preset referenced-provider summary — JSON-serializable view of the (in-process)
 * `PresetProviderCoverage` returned by `derivePresetProviderCoverage`. Maps/Sets are
 * flattened so the response survives `JSON.stringify`.
 */
export interface PresetProviderCoverageDto {
  /** Preset name (original case as declared in the template). */
  presetName: string;
  /** Sorted unique provider names this preset's agentConfigs resolve to. */
  referencedProviders: string[];
  /** True when every template agent is covered by an available provider via this preset. */
  coversAllAgents: boolean;
  /** Agent names (lowercase) whose resolved provider is locally available. */
  coveredAgentNames: string[];
  /** Agent name (lowercase) → resolved provider name (lowercase). */
  agentResolvedProviders: Record<string, string>;
}

/** Locally installed providers, so the UI never recomputes the installed-provider set. */
export interface SetupPreviewLocalAvailability {
  installedProviders: Array<{ id: string; name: string }>;
}

/**
 * Response for POST /api/projects/setup-preview. Adds provider/preset enrichment on top of
 * the parsed ExportSchema payload so the setup wizard can render Steps 1-2 without a second
 * round-trip and without re-deriving provider availability client-side.
 */
export interface SetupPreviewResponse {
  /** The ExportSchema-parsed template payload (same shape as the registry preview endpoint). */
  payload: ExportData;
  /** Per referenced provider: families, agent count, local availability. */
  providerSummary: ProviderSummaryEntry[];
  /** Reused `computeFamilyAlternatives` result (single implementation). */
  familyAlternatives: FamilyAlternative[];
  /** Per-preset referenced providers + coverage. */
  presetProviderCoverage: PresetProviderCoverageDto[];
  /** Locally installed providers. */
  localAvailability: SetupPreviewLocalAvailability;
}

/** Input shape after controller validation (exactly one source is provided). */
export interface SetupPreviewInput {
  slug?: string;
  version?: string | null;
  templatePath?: string;
  rawContent?: Record<string, unknown>;
}
