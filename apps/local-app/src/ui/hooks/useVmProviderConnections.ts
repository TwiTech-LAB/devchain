import { useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';

export interface VmProviderConnectionView {
  id: string;
  kind: 'proxmox';
  name: string;
  apiUrl: string;
  node: string;
  pool: string;
  storage: string;
  imageStorage: string;
  bridge: string;
  vmidMin: number;
  vmidMax: number;
  namePrefix: string;
  tag: string;
  sslFingerprint: string;
  caPem: string | null;
  tokenId: string;
  createdAt: string;
  updatedAt: string;
  capabilities: { create: true; destroy: true; powerState: true };
}

export const vmProviderConnectionQueryKey = [HOME_BACKEND, 'vm-providers'] as const;

async function fetchConnections(signal: AbortSignal): Promise<VmProviderConnectionView[]> {
  const response = await apiFetch('/api/vm-providers', { signal }, { backend: HOME_BACKEND });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
    throw new Error(
      typeof body?.message === 'string'
        ? body.message
        : `Failed to load VM providers (${response.status})`,
    );
  }
  const body = (await response.json()) as { items?: VmProviderConnectionView[] };
  return body.items ?? [];
}

export function useVmProviderConnections() {
  const client = useHomeQueryClient();
  const query = useQuery(
    {
      queryKey: vmProviderConnectionQueryKey,
      queryFn: ({ signal }) => fetchConnections(signal),
      refetchInterval: 30_000,
    },
    client,
  );
  return { connections: query.data ?? [], loading: query.isLoading, error: query.error };
}
