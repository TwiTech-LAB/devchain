/**
 * Query-key factory for provider-list and providers-page preflight queries.
 *
 * Replaces the raw `['providers']` and `['preflight', 'providers-page', ...]`
 * arrays that were scattered across the app. Mirrors the shape of
 * `providerModelQueryKeys` / `providerEffortQueryKeys` (sibling factories for
 * the provider sub-resources) and `teamsQueryKeys` (the list-factory precedent).
 *
 * Scope: the global provider list and the providers-page preflight subtree.
 * Per-profile provider-config queries (`['provider-configs', profileId]`,
 * `['profile-provider-configs', ...]`, etc.) are a separate domain and stay
 * raw — they are fanned out by `invalidateProviderConfigQueries`' predicate,
 * not addressed by a single factory key.
 */
export const providersQueryKeys = {
  /** Global provider list. No project scoping — providers are top-level resources. */
  list: () => ['providers'] as const,

  /**
   * Providers-page preflight, scoped by project rootPath. Defaults to the
   * global (no-project) scope, matching the original
   * `['preflight', 'providers-page', rootPath ?? 'global']` literal.
   */
  preflight: (rootPath?: string) => ['preflight', 'providers-page', rootPath ?? 'global'] as const,

  /**
   * Broad prefix that prefix-matches every rootPath variant of `preflight`.
   * Use for "invalidate all providers-page preflight queries regardless of
   * project" (TanStack matches on key prefix).
   */
  preflightAll: () => ['preflight', 'providers-page'] as const,
};
