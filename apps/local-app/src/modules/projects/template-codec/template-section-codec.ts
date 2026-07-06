/**
 * TemplateSectionCodec — the deep, per-section unit of the template pipeline.
 *
 * Each codec OWNS one export section end-to-end and colocates:
 *  - `build(exportCtx)`   — produce the section's payload from project state (export side)
 *  - `apply(section, ctx, mode, rt)` — write the section into a target project (import side)
 *  - `declaration`        — the section's DECLARED context reads/writes + storage-state
 *                           preconditions/products, so ordering invariants are data the
 *                           pipeline can validate, not comments a reviewer must trust.
 *
 * Ordering that used to live implicitly in a 27-step orchestrator (and its ≥10 unwritten
 * invariants) becomes explicit here: a codec that needs `agentIdMap` declares `reads:
 * ['agentIdMap']`, and the pipeline refuses to run if no earlier codec writes it.
 */
import { ExportSchema } from '@devchain/shared';
import type { ProbeOutcome } from '../../providers/utils/probe-1m';
import type { SettingsService } from '../../settings/services/settings.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { WatchersService } from '../../watchers/services/watchers.service';
import type { selectProfilesForFamilies } from '../helpers/profile-mapping.helpers';
import type { TeamOverrideEntry } from '../helpers/team-overrides.helpers';
import type { ImportContext, ImportContextKey, StorageStateFlag } from './import-context';

/** The two template flows the pipeline serves. */
export type PipelineMode = 'replace' | 'create';

/**
 * How the pipeline treats a codec `apply` that throws, per mode. `fatal` (default) lets
 * the error propagate exactly as the legacy orchestrator did; `swallow` makes the pipeline
 * catch, log, and continue — the create-path teams contract (matrix row 13: create-mode is
 * non-fatal, logged). Declared per-mode so the fatality is data the pipeline enforces,
 * not a branch buried inside a codec's apply logic.
 */
export type CodecFatality = 'fatal' | 'swallow';

/** Parsed, validated template payload (post-`ExportSchema.parse`). */
export type ParsedTemplatePayload = ReturnType<typeof ExportSchema.parse>;

/**
 * Family-selection product computed pre-pipeline (family/provider substitution is input
 * resolution, not a codec) and seeded into the ImportContext. The profiles codec reads
 * `.profilesToCreate`; the agents codec reads `.agentProfileMap`.
 */
export type SelectedProfilesByFamily = ReturnType<
  typeof selectProfilesForFamilies<ParsedTemplatePayload['profiles'][number]>
>;

/**
 * A codec's declared ordering contract. `reads`/`writes` reference in-memory data
 * products in the `ImportContext`; `requiresState`/`producesState` reference named
 * storage side effects (e.g. rows persisted, existing data cleared).
 */
export interface CodecDeclaration {
  /** Unique section id (also the key used to select the payload slice). */
  readonly section: string;
  readonly reads: readonly ImportContextKey[];
  readonly writes: readonly ImportContextKey[];
  readonly requiresState?: readonly StorageStateFlag[];
  readonly producesState?: readonly StorageStateFlag[];
  /** Modes this codec participates in. */
  readonly modes: readonly PipelineMode[];
  /**
   * Per-mode fatality when `apply` throws. Omit = fatal in every mode (legacy behavior).
   * The teams codec declares `{ replace: 'fatal', create: 'swallow' }` (matrix row 13).
   */
  readonly onFailure?: Partial<Record<PipelineMode, CodecFatality>>;
}

/** Ambient runtime a codec needs to apply a section (not part of the ordering graph). */
export interface CodecApplyRuntime {
  readonly projectId: string;
  readonly storage: StorageService;
  /** Replace-mode status remap input (`statusMappings` from the import request). */
  readonly statusMappings?: Record<string, string>;
  /** Available providers as a name(lowercased) -> id map, for config/agent resolution. */
  readonly available?: Map<string, string>;
  /**
   * Existing statuses snapshot taken BEFORE clear (replace mode). Statuses are merged by
   * label, not deleted, to preserve epic references — the codec needs the pre-clear set
   * to perform that merge exactly as the legacy orchestrator did.
   */
  readonly existingStatuses?: ReadonlyArray<{
    id: string;
    label: string;
    color: string;
    position: number;
    mcpHidden: boolean;
  }>;
  /** Settings service for codecs that apply project settings/presets (projectSettings, presets). */
  readonly settings?: SettingsService;
  /** Watchers service for the watchers codec (createWatcher). */
  readonly watchersService?: Pick<WatchersService, 'createWatcher'>;
  /** Teams service for the teams codec (createTeam + scoped failure cleanup). */
  readonly teamsService?: CodecTeamsService;
  /** Per-team overrides from the import request (teams codec merges them post-remap). */
  readonly teamOverrides?: readonly TeamOverrideEntry[];
  /** 1M-context probe callback for the providerSettings codec (null/absent = skip probe). */
  readonly probe1m?: (binPath: string) => Promise<ProbeOutcome>;
  /** Refresh hook the scheduledEpics codec pings after creating schedules. */
  readonly scheduledEpicsRefresh?: { refreshScheduleWindow: () => void };
  /** next-run computer the scheduledEpics codec uses when seeding created schedules. */
  readonly computeNextRunAt?: (cronExpression: string, timezone: string) => Date | null;
}

/**
 * The slice of the teams service the teams codec depends on: create one team, and delete a
 * specific batch (scoped partial-failure cleanup). Structurally compatible with the full
 * TeamsService / ImportProjectDeps.teamsService shape.
 */
export interface CodecTeamsService {
  createTeam: (data: {
    projectId: string;
    name: string;
    description?: string | null;
    teamLeadAgentId?: string | null;
    maxMembers?: number;
    maxConcurrentTasks?: number;
    allowTeamLeadCreateAgents?: boolean;
    memberAgentIds: string[];
    profileIds?: string[];
    profileConfigSelections?: Array<{ profileId: string; configIds: string[] }>;
  }) => Promise<{ id: string }>;
  deleteTeamsByIds: (ids: string[]) => Promise<void>;
}

/** Optional per-section outcome (counts/log fields) surfaced back to the orchestrator. */
export interface CodecApplyResult {
  readonly section: string;
  readonly log?: Record<string, unknown>;
}

/**
 * Ambient state the export side hands each codec's `build`. A structural bag of the
 * already-loaded export state slices plus storage; each codec reads only what it needs.
 */
export interface ExportBuildContext {
  readonly storage: StorageService;
  readonly promptsRes: { items: ReadonlyArray<{ id: string }> };
  readonly statusesRes: {
    items: ReadonlyArray<{
      id: string;
      label: string;
      color: string;
      position: number;
      mcpHidden: boolean;
    }>;
  };
  readonly providersMap: ReadonlyMap<string, { name: string }>;
}

export interface TemplateSectionCodec<Section = unknown> {
  readonly declaration: CodecDeclaration;
  /** Extract this codec's payload slice from the full parsed template. */
  pick(payload: ParsedTemplatePayload): Section;
  /** Build this section's export payload from project state. */
  build(ctx: ExportBuildContext): Promise<unknown> | unknown;
  /** Apply this section's payload into the target project. */
  apply(
    section: Section,
    ctx: ImportContext,
    mode: PipelineMode,
    rt: CodecApplyRuntime,
  ): Promise<CodecApplyResult>;
}
