import { queryOptions } from '@tanstack/react-query';
import { isLessThan } from '@devchain/shared';
import type { HealthResponse } from '@/modules/core/controllers/health.controller';
import { HOME_BACKEND, apiFetch } from './api-transport';
import { fetchJsonOrThrow } from './sessions';

export type { HealthResponse };

export const healthQueryKeys = {
  check: () => ['health'] as const,
};

export function fetchHealth(): Promise<HealthResponse> {
  return fetchJsonOrThrow('/health', {}, 'Failed to fetch health', (url) =>
    apiFetch(url, undefined, { backend: HOME_BACKEND }),
  );
}

export const healthQueries = {
  check: () =>
    queryOptions({
      queryKey: healthQueryKeys.check(),
      queryFn: fetchHealth,
      staleTime: Infinity,
    }),
};

export function selectAppVersion(health: HealthResponse | undefined): string | null {
  return health?.version || null;
}

export function isVersionCompatible(
  minDevchainVersion: string | null,
  currentVersion: string | null,
): boolean {
  if (!minDevchainVersion || !currentVersion) return true;
  try {
    return !isLessThan(currentVersion, minDevchainVersion);
  } catch {
    // Invalid version metadata follows the same policy as an unknown version.
    return true;
  }
}
