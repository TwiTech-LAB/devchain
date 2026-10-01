import { useQuery } from '@tanstack/react-query';
import type { RemoteReadinessDto } from '@/modules/remotes/dtos/remote-probe.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';

// Outside the `remotes` prefix: a remotes event must not rerun the check, which
// can start Syncthing.
const REMOTE_READINESS_QUERY_KEY = [HOME_BACKEND, 'remote-readiness'] as const;

async function fetchReadiness(signal: AbortSignal): Promise<RemoteReadinessDto> {
  const res = await apiFetch('/api/remotes/readiness', { signal }, { backend: HOME_BACKEND });
  if (!res.ok) throw new Error(`Could not check this PC (${res.status})`);
  const body = (await res.json()) as Partial<RemoteReadinessDto> | null;
  if (!body?.syncthing || !body.identity || !body.docker) {
    throw new Error('Could not check this PC: the answer was incomplete.');
  }
  return body as RemoteReadinessDto;
}

/** Whether this PC can set up a VM: Syncthing, identity and Docker. */
export function useRemoteReadiness() {
  const query = useQuery(
    {
      queryKey: REMOTE_READINESS_QUERY_KEY,
      queryFn: ({ signal }) => fetchReadiness(signal),
      staleTime: 60_000,
    },
    useHomeQueryClient(),
  );
  return {
    readiness: query.data ?? null,
    checking: query.isFetching,
    error: query.error,
    checkAgain: () => void query.refetch(),
  };
}
