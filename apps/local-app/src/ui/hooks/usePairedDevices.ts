import { useCallback, useEffect, useState } from 'react';
import { HOME_BACKEND, apiFetch, type BackendId } from '@/ui/lib/api-transport';

/**
 * Renderer hook for the desktop "Paired devices" surface (E2EE trust).
 *
 * Lists the paired peer devices (metadata only) from `GET /api/e2ee/devices`, and exposes
 * an on-demand `fetchSafetyNumber(kid)` so the order-independent safety number is computed
 * by the backend ONLY when the user asks to compare it (it is never bulk-loaded). The number
 * the PC renders is identical to the one the phone's "Validate this device" screen shows.
 *
 * Pairing is per instance: `backend` selects whose devices and workspace grants
 * are listed; workspaces come from the same backend because grants name that
 * instance's workspace ids.
 */
export interface PairedDevice {
  kid: string;
  label?: string;
  localAlias?: string;
  trust: 'verified' | 'unverified';
  adoptedVia?: 'qr' | 'email-tofu';
  verifiedVia?: 'qr' | 'email-tofu' | 'safety-number';
  verifiedAt?: string;
  addedAt: string;
  workspaceIds: string[];
  workspaceAccessExplicit: boolean;
}

export interface PairedDeviceWorkspace {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface UsePairedDevices {
  devices: PairedDevice[];
  workspaces: PairedDeviceWorkspace[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Fetch the safety number for one device on demand (computed by the backend per call). */
  fetchSafetyNumber: (kid: string) => Promise<string>;
  /** Un-pair (remove) a device, then refresh the list. */
  unpairDevice: (kid: string) => Promise<void>;
  updateLocalAlias: (kid: string, localAlias: string | null) => Promise<void>;
  updateWorkspaceAccess: (kid: string, workspaceIds: string[]) => Promise<void>;
}

export function usePairedDevices(backend: BackendId = HOME_BACKEND): UsePairedDevices {
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [workspaces, setWorkspaces] = useState<PairedDeviceWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [devicesResponse, workspacesResponse] = await Promise.all([
        apiFetch('/api/e2ee/devices', undefined, { backend }),
        apiFetch('/api/workspaces', undefined, { backend }),
      ]);
      if (!devicesResponse.ok) throw new Error(`devices:${devicesResponse.status}`);
      if (!workspacesResponse.ok) throw new Error(`workspaces:${workspacesResponse.status}`);
      const deviceRows = (await devicesResponse.json()) as Array<
        Omit<PairedDevice, 'workspaceIds' | 'workspaceAccessExplicit'>
      >;
      const workspaceRows = (await workspacesResponse.json()) as PairedDeviceWorkspace[];
      const normalizedWorkspaces = Array.isArray(workspaceRows) ? workspaceRows : [];
      const normalizedDevices = Array.isArray(deviceRows) ? deviceRows : [];
      const accessRows =
        normalizedWorkspaces.length > 1
          ? await Promise.all(
              normalizedDevices.map(async (device) => {
                const response = await apiFetch(
                  `/api/e2ee/devices/${encodeURIComponent(device.kid)}/workspaces`,
                  undefined,
                  { backend },
                );
                if (!response.ok) throw new Error(`device-workspaces:${response.status}`);
                return (await response.json()) as {
                  workspaceIds: string[];
                  explicit: boolean;
                };
              }),
            )
          : normalizedDevices.map(() => ({
              workspaceIds: normalizedWorkspaces[0] ? [normalizedWorkspaces[0].id] : [],
              explicit: false,
            }));
      setWorkspaces(normalizedWorkspaces);
      setDevices(
        normalizedDevices.map((device, index) => ({
          ...device,
          workspaceIds: accessRows[index]?.workspaceIds ?? [],
          workspaceAccessExplicit: accessRows[index]?.explicit ?? false,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const fetchSafetyNumber = useCallback(
    async (kid: string): Promise<string> => {
      const res = await apiFetch(
        `/api/e2ee/devices/${encodeURIComponent(kid)}/safety-number`,
        undefined,
        { backend },
      );
      if (!res.ok) throw new Error(`safety-number:${res.status}`);
      const { safetyNumber } = (await res.json()) as { safetyNumber?: string };
      if (!safetyNumber) throw new Error('No safety number returned');
      return safetyNumber;
    },
    [backend],
  );

  const unpairDevice = useCallback(
    async (kid: string): Promise<void> => {
      const res = await apiFetch(
        `/api/e2ee/devices/${encodeURIComponent(kid)}`,
        {
          method: 'DELETE',
        },
        { backend },
      );
      if (!res.ok) throw new Error(`unpair:${res.status}`);
      await reload();
    },
    [reload],
  );

  const updateLocalAlias = useCallback(
    async (kid: string, localAlias: string | null): Promise<void> => {
      const response = await apiFetch(
        `/api/e2ee/devices/${encodeURIComponent(kid)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ localAlias }),
        },
        { backend },
      );
      if (!response.ok) throw new Error(`device-alias:${response.status}`);
      const updated = (await response.json()) as Omit<
        PairedDevice,
        'workspaceIds' | 'workspaceAccessExplicit'
      >;
      setDevices((current) =>
        current.map((device) =>
          device.kid === kid
            ? {
                ...device,
                ...updated,
                localAlias: updated.localAlias,
                workspaceIds: device.workspaceIds,
                workspaceAccessExplicit: device.workspaceAccessExplicit,
              }
            : device,
        ),
      );
    },
    [backend],
  );

  const updateWorkspaceAccess = useCallback(
    async (kid: string, workspaceIds: string[]): Promise<void> => {
      const response = await apiFetch(
        `/api/e2ee/devices/${encodeURIComponent(kid)}/workspaces`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceIds }),
        },
        { backend },
      );
      if (!response.ok) throw new Error(`device-workspaces:${response.status}`);
      const updated = (await response.json()) as { workspaceIds: string[]; explicit: boolean };
      setDevices((current) =>
        current.map((device) =>
          device.kid === kid
            ? {
                ...device,
                workspaceIds: updated.workspaceIds,
                workspaceAccessExplicit: updated.explicit,
              }
            : device,
        ),
      );
    },
    [backend],
  );

  return {
    devices,
    workspaces,
    loading,
    error,
    reload,
    fetchSafetyNumber,
    unpairDevice,
    updateLocalAlias,
    updateWorkspaceAccess,
  };
}
