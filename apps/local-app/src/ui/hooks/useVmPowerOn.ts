import { useCallback, useState } from 'react';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useRemoteVmApi } from '@/ui/pages/cloud/lib/remote-vm-api-context';
import { REMOTES_LIST_QUERY_KEY } from '@/ui/pages/cloud/lib/remote-vm-query-keys';
import { getErrorMessage, useToastHelpers } from '@/ui/lib/toast-helpers';

/**
 * Powers on stopped Proxmox VMs. Remembers, for this page only, when each one
 * was started, so a VM that does not answer yet reads "Starting" for a while.
 */
export function useVmPowerOn() {
  const api = useRemoteVmApi();
  const client = useHomeQueryClient();
  const { showError } = useToastHelpers();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [poweredOnAt, setPoweredOnAt] = useState<ReadonlyMap<string, number>>(new Map());

  const powerOn = useCallback(
    async (remote: Pick<RemoteListItemDto, 'id' | 'name'>) => {
      setPending((current) => new Set(current).add(remote.id));
      try {
        await api.powerOn(remote.id);
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
    [api, client, showError],
  );

  return { powerOn, pending, poweredOnAt };
}
