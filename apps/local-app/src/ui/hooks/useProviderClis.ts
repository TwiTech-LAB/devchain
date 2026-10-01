import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  ProviderCliName,
  ProviderCliStatus,
  ProviderClisOverview,
  ProviderCliVersionEntry,
} from '@devchain/shared';
import { providersQueryKeys } from '@/ui/lib/providers-query-keys';
import { useHomeFetch } from '@/ui/hooks/useFetchFactory';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';

const INSTALLING_POLL_MS = 3_000;

async function fetchClisOverview(
  homeFetch: ReturnType<typeof useHomeFetch>,
): Promise<ProviderClisOverview> {
  const res = await homeFetch('/api/provider-clis');
  if (!res.ok) throw new Error('Failed to load CLI versions');
  return res.json();
}

async function putProviderCliEntry(
  homeFetch: ReturnType<typeof useHomeFetch>,
  provider: ProviderCliName,
  entry: ProviderCliVersionEntry,
): Promise<ProviderCliStatus['setting']> {
  const res = await homeFetch(`/api/provider-clis/${provider}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    throw new Error(
      typeof body?.message === 'string' ? body.message : `Failed to save ${provider} version`,
    );
  }
  return res.json();
}

async function postProviderCliCheck(homeFetch: ReturnType<typeof useHomeFetch>) {
  const res = await homeFetch('/api/provider-clis/check', { method: 'POST' });
  if (!res.ok) throw new Error('Version check failed');
  return res.json();
}

/**
 * Mark one provider's cached CLI overview as own install and refetch it. The
 * server turns management off when a Binary Path save lands on a managed home
 * provider (docs/providers-lifecycle.md); writing the flag here synchronously
 * keeps a pin save issued before the refetch lands from re-sending the stale
 * homeManaged:true, which would re-enable the installer and replace the
 * custom binary.
 */
export function markProviderCliOwnInstall(client: QueryClient, provider: ProviderCliName): void {
  const key = providersQueryKeys.clis();
  client.setQueryData<ProviderClisOverview>(key, (previous) => {
    const status = previous?.providers[provider];
    if (!status) return previous;
    return {
      ...previous,
      providers: {
        ...previous.providers,
        [provider]: { ...status, setting: { ...status.setting, homeManaged: false } },
      },
    };
  });
  void client.invalidateQueries({ queryKey: key });
}

function anyProviderInstalling(overview: ProviderClisOverview | undefined): boolean {
  const providers = overview?.providers;
  return !!providers && Object.values(providers).some((s) => s.install?.state === 'installing');
}

/** Home-owned CLI overview only: read-only consumers that need the settings, not the actions. */
export function useProviderClisOverview() {
  const homeFetch = useHomeFetch();
  const homeClient = useHomeQueryClient();

  return useQuery(
    {
      queryKey: providersQueryKeys.clis(),
      queryFn: () => fetchClisOverview(homeFetch),
      // An activation installs through npm in the background and the mutation
      // refetch always lands mid-install; with refetchOnWindowFocus off
      // app-wide, this poll is the only reader of the final install state.
      refetchInterval: (query) =>
        anyProviderInstalling(query.state.data) ? INSTALLING_POLL_MS : false,
    },
    homeClient,
  );
}

/**
 * Home-owned provider CLI version state: the setting, registry lookup results,
 * and this machine's managed-install status. Every call names the home
 * backend, so a remote project being open never redirects a pin to a VM.
 * Mount it once per page: it also refreshes the page's provider cards when an
 * install ends.
 */
export function useProviderClis() {
  const homeFetch = useHomeFetch();
  const homeClient = useHomeQueryClient();
  // The page's own client: when the provider cards are home's, a managed flip
  // changes their Binary Path and the cards must refetch.
  const ambientClient = useQueryClient();

  const overviewQuery = useProviderClisOverview();

  // Completing an activation switched the provider's Binary Path (managed
  // symlink or restored own install), so the page's cards and preflight still
  // hold pre-install values until these invalidations land.
  const anyInstallingRef = useRef(false);
  const overviewData = overviewQuery.data;
  useEffect(() => {
    const anyInstalling = anyProviderInstalling(overviewData);
    const installEnded = anyInstallingRef.current && !anyInstalling;
    anyInstallingRef.current = anyInstalling;
    if (!installEnded) return;
    void ambientClient.invalidateQueries({ queryKey: providersQueryKeys.list() });
    void ambientClient.invalidateQueries({ queryKey: providersQueryKeys.preflightAll() });
  }, [overviewData, ambientClient]);

  const setEntryMutation = useMutation({
    mutationFn: ({
      provider,
      entry,
    }: {
      provider: ProviderCliName;
      entry: ProviderCliVersionEntry;
    }) => putProviderCliEntry(homeFetch, provider, entry),
    onSuccess: () => {
      void homeClient.invalidateQueries({ queryKey: providersQueryKeys.clis() });
      void ambientClient.invalidateQueries({ queryKey: providersQueryKeys.list() });
      void ambientClient.invalidateQueries({ queryKey: providersQueryKeys.preflightAll() });
    },
  });

  const checkNowMutation = useMutation({
    mutationFn: () => postProviderCliCheck(homeFetch),
    onSuccess: () => {
      void homeClient.invalidateQueries({ queryKey: providersQueryKeys.clis() });
    },
  });

  return {
    overviewQuery,
    overview: overviewQuery.data ?? null,
    setEntryMutation,
    checkNowMutation,
  };
}
