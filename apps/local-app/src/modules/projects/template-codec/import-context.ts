/**
 * ImportContext — the typed data-product bag threaded between template section codecs
 * during an import (replace or create) run.
 *
 * Every value a codec produces for a LATER codec to consume flows through here. The
 * class enforces read-before-write at runtime: `get` on a key that was never `set`
 * throws, surfacing an ordering bug immediately instead of silently reading
 * `undefined`. The pipeline's static topological validation (see `template-pipeline.ts`)
 * prevents most of these before they run; this runtime guard is the belt-and-braces
 * backstop the tests assert on directly.
 *
 * Keys are a closed union (`ImportContextKey`) so a codec cannot declare a read/write
 * against a key that does not exist. Named storage-state flags (`StorageStateFlag`)
 * model side-effect preconditions that are NOT data products — e.g. "agents have been
 * persisted" or "existing project data has been cleared" — which some codecs require
 * before they may apply.
 */
import type { ExportSchema } from '@devchain/shared';
import type { selectProfilesForFamilies } from '../helpers/profile-mapping.helpers';

type ParsedTemplatePayload = ReturnType<typeof ExportSchema.parse>;

/**
 * Family-selection product computed pre-pipeline (family/provider substitution is input
 * resolution, not a codec) and seeded into the ImportContext. The profiles codec reads
 * `.profilesToCreate`; the agents codec reads `.agentProfileMap`. Defined here (not in
 * `template-section-codec.ts`) so the codec contract can type its context keys without
 * importing back into this file.
 */
export type SelectedProfilesByFamily = ReturnType<
  typeof selectProfilesForFamilies<ParsedTemplatePayload['profiles'][number]>
>;

/** Data products a codec can publish for downstream codecs. */
export interface ImportContextValues {
  statusIdMap: Record<string, string>;
  promptIdMap: Record<string, string>;
  profileIdMap: Record<string, string>;
  /** Profile name (lowercased) -> new profile id; written by the profiles codec. */
  profileNameToId: Map<string, string>;
  /**
   * Full config lookup (`profileId:configName(lowercased)` → new config id) for EVERY persisted
   * config — i.e. every config backed by an installed provider. Written by the profiles codec;
   * consumed by the teams codec and faithful template restoration.
   */
  configLookupMap: Map<string, string>;
  /**
   * The `configLookupMap` narrowed to configs whose provider is eligible under the Step-1
   * selection (identical to `configLookupMap` when no allowlist is active). Written by the
   * profiles codec; read by the agents codec for binding so an unpinned agent never resolves to
   * a stored-but-unselected config.
   */
  selectionEligibleConfigLookupMap: Map<string, string>;
  agentIdMap: Record<string, string>;
  agentNameToId: Record<string, string>;
  oldAgentIdToName: Map<string, string>;
  profileNameRemapMap: Map<string, string>;
  selectedProfilesByFamily: SelectedProfilesByFamily;
  parkedByOldAgentId: Map<string, string[]>;
  templateLabelToStatusId: Map<string, string>;
  statusLabelToId: Map<string, string>;
  /** Prompts created during import (id + title), consumed by initial-prompt resolution. */
  createdPrompts: Array<{ id: string; title: string }>;
  /** Watcher template id -> new watcher id; written by the watchers codec (response mapping). */
  watcherIdMap: Record<string, string>;
  /** Subscriber template id -> new subscriber id; written by the subscribers codec (response mapping). */
  subscriberIdMap: Record<string, string>;
}

export type ImportContextKey = keyof ImportContextValues;

/**
 * Named storage-state preconditions/products. These model observable side effects on
 * storage (rows persisted, data cleared) rather than in-memory data products, so codecs
 * can declare ordering against them without inventing sentinel context values.
 */
export type StorageStateFlag =
  | 'existingDataCleared'
  | 'statusesPersisted'
  | 'promptsPersisted'
  | 'profilesPersisted'
  | 'agentsPersisted'
  | 'epicsLoaded';

export class ImportContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportContextError';
  }
}

export class ImportContext {
  private readonly values = new Map<ImportContextKey, unknown>();
  private readonly states = new Set<StorageStateFlag>();

  /**
   * Seed keys/states that are produced OUTSIDE the migrated codec set (by the surrounding
   * orchestrator) so downstream codecs may legally read them. Used both by the pipeline's
   * topology validation (as pre-satisfied producers) and at runtime.
   */
  constructor(seed?: Partial<ImportContextValues>, seedStates?: readonly StorageStateFlag[]) {
    if (seed) {
      for (const [key, value] of Object.entries(seed) as [ImportContextKey, unknown][]) {
        if (value !== undefined) this.values.set(key, value);
      }
    }
    for (const state of seedStates ?? []) this.states.add(state);
  }

  set<K extends ImportContextKey>(key: K, value: ImportContextValues[K]): void {
    this.values.set(key, value);
  }

  /** Read a data product. Throws `ImportContextError` if it was never written. */
  get<K extends ImportContextKey>(key: K): ImportContextValues[K] {
    if (!this.values.has(key)) {
      throw new ImportContextError(
        `ImportContext read-before-write: "${key}" was read before any codec wrote it`,
      );
    }
    return this.values.get(key) as ImportContextValues[K];
  }

  has(key: ImportContextKey): boolean {
    return this.values.has(key);
  }

  markState(state: StorageStateFlag): void {
    this.states.add(state);
  }

  hasState(state: StorageStateFlag): boolean {
    return this.states.has(state);
  }

  /** Assert a storage-state precondition holds; throws otherwise. */
  requireState(state: StorageStateFlag): void {
    if (!this.states.has(state)) {
      throw new ImportContextError(`ImportContext missing required storage state: "${state}"`);
    }
  }
}
