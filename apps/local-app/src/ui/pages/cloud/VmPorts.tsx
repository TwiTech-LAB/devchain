import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import { remoteSyncthingDeviceQueryKey } from './lib/remote-vm-query-keys';

export function devchainPort(baseUrl: string | null): number | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return Number(url.port || (url.protocol === 'https:' ? '443' : '80'));
  } catch {
    return null;
  }
}

function syncthingPort(address: unknown): number | null {
  if (typeof address !== 'string') return null;
  try {
    const url = new URL(address);
    const port = Number(url.port);
    return url.protocol === 'tcp:' && Number.isInteger(port) && port > 0 && port <= 65535
      ? port
      : null;
  } catch {
    return null;
  }
}

function PortFact({ label, value }: { label: string; value: number | null }) {
  const id = useId();
  return (
    <div>
      <dt id={id} className="text-muted-foreground">
        {label}
      </dt>
      <dd aria-labelledby={id}>{value ?? 'Unknown'}</dd>
    </div>
  );
}

export function VmPorts({
  remoteId,
  port,
  enabled,
}: {
  remoteId: string;
  port: number | null;
  enabled: boolean;
}) {
  const api = useRemoteVmApi();
  const device = useQuery(
    {
      queryKey: remoteSyncthingDeviceQueryKey(remoteId),
      queryFn: ({ signal }) => api.readSyncthingDevice(remoteId, signal),
      enabled,
      refetchInterval: 10_000,
    },
    useHomeQueryClient(),
  );
  const listenPort = enabled && !device.isError ? syncthingPort(device.data?.address) : null;
  return (
    <section aria-label="VM ports" className="space-y-2 text-sm">
      <dl className="grid gap-2 sm:grid-cols-2">
        <PortFact label="DevChain port" value={port} />
        <PortFact label="Syncthing listen port" value={listenPort} />
      </dl>
      <p className="text-muted-foreground">
        Allow TCP {port ?? 'the DevChain port'} and {listenPort ?? 'the Syncthing listen port'} from
        this PC.
      </p>
    </section>
  );
}
