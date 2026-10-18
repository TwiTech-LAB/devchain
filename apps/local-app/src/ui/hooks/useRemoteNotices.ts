import { useMutation, useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useRemoteVmApi } from '@/ui/pages/cloud/lib/remote-vm-api-context';
import type { WsEnvelope } from '@/ui/lib/socket';
import { useHomeSocket } from './useHomeSocket';

export const REMOTE_NOTICES_QUERY_KEY = ['remote-notices'] as const;

export function useRemoteNotices() {
  const api = useRemoteVmApi();
  const client = useHomeQueryClient();
  const query = useQuery(
    {
      queryKey: REMOTE_NOTICES_QUERY_KEY,
      queryFn: ({ signal }) => api.listNotices(signal),
      refetchInterval: 10_000,
    },
    client,
  );
  const refresh = () => {
    void client.invalidateQueries({ queryKey: REMOTE_NOTICES_QUERY_KEY });
  };
  useHomeSocket(
    {
      connect: refresh,
      message: (envelope: unknown) => {
        const { topic, type } = (envelope ?? {}) as Partial<WsEnvelope>;
        if (topic === 'remotes' && type === 'notices') refresh();
      },
    },
    [client],
  );
  const dismiss = useMutation(
    {
      mutationFn: ({ remoteId, id }: { remoteId: string; id: string }) =>
        api.dismissNotice(remoteId, id),
      onSuccess: refresh,
    },
    client,
  );
  return { notices: query.data ?? [], dismiss };
}
