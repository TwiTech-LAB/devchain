import { useQuery } from '@tanstack/react-query';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { providerConfigQueries, type ProfileProviderConfig } from '@/ui/lib/provider-configs';

/**
 * The configs of a profile, or undefined while a fetch is in flight or when the latest fetch
 * failed. TanStack Query keeps earlier data during and after a refetch; this hides it, so a
 * restore never relies on configs the server has not just confirmed.
 */
export function useProfileConfigsForSwitch(
  profileId: string | null | undefined,
): readonly ProfileProviderConfig[] | undefined {
  const apiFetch = useFetchFactory();
  const query = useQuery({
    ...providerConfigQueries.profile(apiFetch, profileId ?? null),
    enabled: Boolean(profileId),
  });
  return query.isSuccess && !query.isFetching ? query.data : undefined;
}
