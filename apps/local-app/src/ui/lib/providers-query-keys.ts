import type { ProvidersController } from '@/modules/providers/controllers/providers.controller';
import type { FetchFn } from './api-transport';

export type ProvidersResponse = Awaited<ReturnType<ProvidersController['listProviders']>>;
export type Provider = ProvidersResponse['items'][number];

export async function fetchProviders(fetchFn: FetchFn): Promise<ProvidersResponse> {
  const res = await fetchFn('/api/providers');
  if (!res.ok) throw new Error('Failed to fetch providers');
  return res.json() as Promise<ProvidersResponse>;
}

/** Provider-list and providers-page preflight keys. */
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

  /**
   * Home-owned provider CLI version overview (GET /api/provider-clis). Kept a
   * sibling of `list` rather than a child so invalidating the provider list
   * does not refetch the registry overview.
   */
  clis: () => ['provider-clis'] as const,
};
