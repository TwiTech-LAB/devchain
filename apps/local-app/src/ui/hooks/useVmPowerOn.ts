import { useCallback, useState } from 'react';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';
import { REMOTES_LIST_QUERY_KEY } from '@/ui/lib/backend-provider';
import { getErrorMessage, useToastHelpers } from '@/ui/lib/toast-helpers';
import { readErrorMessage } from './useRemotes';

/**
 * Powers on stopped Proxmox VMs. Remembers, for this page only, when each one
 * was started, so a VM that does not answer yet reads "Starting" for a while.
 */
export function useVmPowerOn() {
  const client = useHomeQueryClient();
  const { showError } = useToastHelpers();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [poweredOnAt, setPoweredOnAt] = useState<ReadonlyMap<string, number>>(new Map());

  const powerOn = useCallback(
    async (remote: Pick<RemoteListItemDto, 'id' | 'name'>) => {
      setPending((current) => new Set(current).add(remote.id));
      try {
        const res = await apiFetch(
          `/api/remotes/${remote.id}/power-on`,
          { method: 'POST' },
          { backend: HOME_BACKEND },
        );
        if (!res.ok)
          throw new Error(await readErrorMessage(res, `Power on failed (${res.status})`));
        setPoweredOnAt((current) => new Map(current).set(remote.id, Date.now()));
        // The server answered that the VM runs; health catches up once DevChain boots.
        client.setQueryData<RemoteListItemDto[]>(REMOTES_LIST_QUERY_KEY, (current) =>
          current?.map((item) =>
            item.id === remote.id ? { ...item, powerState: 'running' } : item,
          ),
        );
      } catch (error) {
        showError({
          title: `Could not power on ${remote.name}`,
          description: getErrorMessage(error, String(error)),
        });
      } finally {
        setPending((current) => {
          const next = new Set(current);
          next.delete(remote.id);
          return next;
        });
      }
    },
    [client, showError],
  );

  return { powerOn, pending, poweredOnAt };
}
