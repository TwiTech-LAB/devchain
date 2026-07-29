/**
 * A provider that can translate a single stored, provider-native effort value
 * into its own launch mechanism. The precedence (agent override → config default
 * → raw options) is resolved upstream; this capability only performs the final
 * strip-then-inject at launch. Adopters today: claude, codex, copilot (all argv
 * flags). OpenCode adoption (per-model env overlay) is a later task and is the
 * reason `applyEffort` returns env alongside argv and accepts `effectiveModel`.
 *
 * Mirrors `AutoCompactCapability`: consumed via `isEffortCapable` type-guard
 * narrowing at the `ProviderLaunchConfig` composition point only.
 */
export interface EffortCapability {
  /**
   * The default provider-native effort values for this adapter. STATIC metadata —
   * consumed by the effort-seeding task and the efforts API endpoint. It must NOT
   * depend on launch internals (no argv/env). Values are provider-native verbatim
   * strings (e.g. claude `low|medium|high|xhigh|max`), never normalized.
   */
  readonly defaultEffortValues: readonly string[];

  /**
   * True only for adapters whose effort mechanism is keyed per-model and thus
   * needs the effective model to place the value (opencode's per-model JSON
   * overlay). Absent/false for flag-based adapters (claude/codex/copilot) whose
   * effort flag is model-independent. Surfaced by the efforts endpoint so the UI
   * can require a model selection before offering effort for such providers.
   */
  readonly requiresModelForEffort?: boolean;

  /**
   * Strip any conflicting raw effort flags from `args`, then inject this
   * provider's native effort form for `effortValue`. Return shape is pinned to
   * `{ argv, env }` (mirrors `applyAutoCompactConfig`): flag-based adapters
   * return `env` unchanged; the env channel exists for the per-model overlay
   * adopter. `effectiveModel` is consulted only when `requiresModelForEffort`.
   */
  applyEffort(
    args: string[],
    env: Record<string, string>,
    effortValue: string,
    effectiveModel?: string,
  ): { argv: string[]; env: Record<string, string> };
}
