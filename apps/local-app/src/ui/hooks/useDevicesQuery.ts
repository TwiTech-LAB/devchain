import { useQuery } from '@tanstack/react-query';
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

export function useDevicesQuery(): DevicesQueryState {
  const { status: cloudStatus } = useCloudConnection();
  const query = useQuery({
    queryKey: ['cloud', 'devices'],
    queryFn: async (): Promise<{ devices: Device[] } | null> => {
      const res = await fetch('/api/cloud/devices');
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
