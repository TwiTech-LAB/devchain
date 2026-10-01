import { useQuery } from '@tanstack/react-query';
import { HOME_BACKEND, apiFetch, type BackendId } from '@/ui/lib/api-transport';
import { useCloudConnection } from './useCloudConnection';

export interface Device {
  id: string;
  platform: string;
  appVersion?: string;
  lastActiveAt?: string | null;
  createdAt: string;
}

export type DevicesQueryState =
  | { status: 'loading'; devices: Device[]; devicesAvailable: false; refetch: () => void }
  | { status: 'endpoint-missing'; devices: Device[]; devicesAvailable: false; refetch: () => void }
  | {
      status: 'error';
      error: Error;
      devices: Device[];
      devicesAvailable: false;
      refetch: () => void;
    }
  | { status: 'ready'; devices: Device[]; devicesAvailable: true; refetch: () => void };

export function useDevicesQuery(backend: BackendId = HOME_BACKEND): DevicesQueryState {
  const { status: cloudStatus } = useCloudConnection(backend);
  const query = useQuery({
    // Scope the cache by current userId so an account switch never reuses the
    // previous account's device list (which would wrongly hide the download CTA
    // for a new account that has zero devices). The backend id leads the key so
    // switching the Cloud page target never shows the other instance's devices.
    queryKey: [backend, 'cloud', 'devices', cloudStatus.userId ?? null],
    queryFn: async (): Promise<{ devices: Device[] } | null> => {
      const res = await apiFetch('/api/cloud/devices', undefined, { backend });
      if (res.status === 404 || res.status === 501) return null;
      if (!res.ok) throw new Error(`devices:${res.status}`);
      return res.json();
    },
    enabled: !!cloudStatus.connected,
    retry: false,
    staleTime: 30_000,
  });

  const refetch = () => {
    query.refetch();
  };

  if (query.isLoading) {
    return { status: 'loading', devices: [], devicesAvailable: false, refetch };
  }
  if (query.isError) {
    return {
      status: 'error',
      error: query.error as Error,
      devices: [],
      devicesAvailable: false,
      refetch,
    };
  }
  if (query.data === null || query.data === undefined) {
    return { status: 'endpoint-missing', devices: [], devicesAvailable: false, refetch };
  }
  return { status: 'ready', devices: query.data.devices, devicesAvailable: true, refetch };
}
