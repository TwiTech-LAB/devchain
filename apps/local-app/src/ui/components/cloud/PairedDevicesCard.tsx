import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Pencil, Smartphone } from 'lucide-react';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { cn } from '@/ui/lib/utils';
import {
  usePairedDevices,
  type PairedDevice,
  type PairedDeviceWorkspace,
} from '@/ui/hooks/usePairedDevices';
import type { BackendId } from '@/ui/lib/api-transport';

/**
 * Desktop "Paired devices" card — lists the phones/devices paired with this account and lets
 * the user reveal each one's E2EE safety number on demand to compare with the phone's
 * "Validate this device" screen. Trust state remains read-only here, while the displayed
 * local alias can be edited without changing the phone-reported name.
 */
export function PairedDevicesCard({
  backend,
  className,
}: {
  /** Lists the selected instance's devices; defaults to this PC. */
  backend?: BackendId;
  className?: string;
}) {
  const {
    devices,
    workspaces,
    loading,
    error,
    reload,
    fetchSafetyNumber,
    unpairDevice,
    updateLocalAlias,
    updateWorkspaceAccess,
  } = usePairedDevices(backend);
  const [pendingRemoval, setPendingRemoval] = useState<PairedDevice | null>(null);

  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card shadow-sm p-6 lg:p-8 space-y-4',
        className,
      )}
      data-testid="paired-devices-card"
    >
      <div className="flex items-center gap-2">
        <Smartphone className="h-5 w-5 text-muted-foreground" />
        <span className="text-base font-semibold">Paired devices</span>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Checking paired devices…</p>
      ) : error ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Couldn’t load paired devices.</p>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            Retry
          </Button>
        </div>
      ) : devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No devices paired yet. Sign in a phone to compare its safety number here.
        </p>
      ) : (
        <div className="divide-y divide-border border-y border-border">
          {devices.map((device) => (
            <DeviceRow
              key={device.kid}
              device={device}
              workspaces={workspaces}
              fetchSafetyNumber={fetchSafetyNumber}
              updateLocalAlias={updateLocalAlias}
              updateWorkspaceAccess={updateWorkspaceAccess}
              onUnpair={() => setPendingRemoval(device)}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
        onConfirm={() => {
          if (pendingRemoval) void unpairDevice(pendingRemoval.kid);
        }}
        title="Un-pair this device?"
        description={
          <>
            <span className="block">
              Remove "{pendingRemoval ? displayName(pendingRemoval) : 'this device'}" from your
              paired devices. Handy for clearing stale entries from old app installs. If it is still
              your active phone, encryption re-establishes automatically the next time it connects.
            </span>
            {pendingRemoval?.localAlias !== undefined && pendingRemoval.label !== undefined && (
              <span className="mt-2 block text-xs text-muted-foreground">
                Reported name: {pendingRemoval.label}
              </span>
            )}
          </>
        }
        confirmText="Un-pair"
        cancelText="Cancel"
        variant="destructive"
      />
    </div>
  );
}

function displayName(device: Pick<PairedDevice, 'localAlias' | 'label'>): string {
  return device.localAlias ?? device.label ?? 'Mobile device';
}

function trustBadge(device: PairedDevice): {
  text: string;
  variant: 'default' | 'secondary';
} {
  return device.trust === 'verified'
    ? { text: 'Verified', variant: 'default' }
    : { text: 'Trusted on first use', variant: 'secondary' };
}

function formatPairedDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function DeviceRow({
  device,
  workspaces,
  fetchSafetyNumber,
  updateLocalAlias,
  updateWorkspaceAccess,
  onUnpair,
}: {
  device: PairedDevice;
  workspaces: PairedDeviceWorkspace[];
  fetchSafetyNumber: (kid: string) => Promise<string>;
  updateLocalAlias: (kid: string, localAlias: string | null) => Promise<void>;
  updateWorkspaceAccess: (kid: string, workspaceIds: string[]) => Promise<void>;
  onUnpair: () => void;
}) {
  const [shown, setShown] = useState(false);
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [editingAlias, setEditingAlias] = useState(false);
  const [aliasDraft, setAliasDraft] = useState('');
  const [aliasPending, setAliasPending] = useState(false);
  const [aliasError, setAliasError] = useState<string | null>(null);
  const aliasInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingAlias) {
      aliasInputRef.current?.focus();
      aliasInputRef.current?.select();
    }
  }, [editingAlias]);

  const startAliasEdit = useCallback(() => {
    setAliasDraft(device.localAlias ?? '');
    setAliasError(null);
    setEditingAlias(true);
  }, [device.localAlias]);

  const cancelAliasEdit = useCallback(() => {
    if (aliasPending) return;
    setAliasError(null);
    setEditingAlias(false);
  }, [aliasPending]);

  const commitAliasEdit = useCallback(async () => {
    if (aliasPending) return;
    const localAlias = aliasDraft.trim() || null;
    if (localAlias === (device.localAlias ?? null)) {
      setEditingAlias(false);
      return;
    }
    setAliasPending(true);
    setAliasError(null);
    try {
      await updateLocalAlias(device.kid, localAlias);
      setEditingAlias(false);
    } catch {
      setAliasError('Couldn’t update the local alias for this device.');
    } finally {
      setAliasPending(false);
    }
  }, [aliasDraft, aliasPending, device.kid, device.localAlias, updateLocalAlias]);

  const toggle = useCallback(async () => {
    if (shown) {
      setShown(false);
      return;
    }
    setShown(true);
    if (safetyNumber) return; // already fetched once — reveal without re-fetching
    setBusy(true);
    setError(null);
    try {
      setSafetyNumber(await fetchSafetyNumber(device.kid));
    } catch {
      setError('Couldn’t load the safety number for this device.');
    } finally {
      setBusy(false);
    }
  }, [shown, safetyNumber, device.kid, fetchSafetyNumber]);

  const badge = trustBadge(device);
  const name = displayName(device);

  const toggleWorkspace = useCallback(
    async (workspaceId: string, checked: boolean) => {
      const selected = checked
        ? [...device.workspaceIds, workspaceId]
        : device.workspaceIds.filter((id) => id !== workspaceId);
      if (selected.length === 0) return;
      setWorkspaceBusy(true);
      setWorkspaceError(null);
      try {
        await updateWorkspaceAccess(device.kid, selected);
      } catch {
        setWorkspaceError('Couldn’t update workspace access for this device.');
      } finally {
        setWorkspaceBusy(false);
      }
    },
    [device.kid, device.workspaceIds, updateWorkspaceAccess],
  );

  return (
    <div className="py-4 space-y-2" data-testid={`paired-device-${device.kid}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {editingAlias ? (
              <div className="flex min-w-0 items-center gap-2">
                <input
                  ref={aliasInputRef}
                  type="text"
                  maxLength={120}
                  className="h-7 min-w-0 rounded border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  value={aliasDraft}
                  aria-label={`Local alias for ${name}`}
                  disabled={aliasPending}
                  onChange={(event) => setAliasDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void commitAliasEdit();
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelAliasEdit();
                    }
                  }}
                  onBlur={() => void commitAliasEdit()}
                />
                {aliasPending && (
                  <span
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                    role="status"
                    aria-live="polite"
                  >
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Saving…
                  </span>
                )}
              </div>
            ) : (
              <button
                type="button"
                className="flex min-w-0 items-center gap-1 text-left text-sm font-medium hover:text-primary"
                aria-label={`Rename ${name}`}
                onClick={startAliasEdit}
              >
                <span className="truncate">{name}</span>
                <Pencil className="h-3 w-3 shrink-0 text-muted-foreground" />
              </button>
            )}
            <Badge variant={badge.variant}>{badge.text}</Badge>
          </div>
          {device.localAlias !== undefined && device.label !== undefined && (
            <p className="truncate text-xs text-muted-foreground">Reported name: {device.label}</p>
          )}
          <p className="text-xs text-muted-foreground">Paired {formatPairedDate(device.addedAt)}</p>
          {aliasError && (
            <p className="text-xs text-destructive" role="alert">
              {aliasError}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={() => void toggle()} disabled={busy}>
            {shown ? 'Hide' : busy ? 'Loading…' : 'Show safety number'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={onUnpair}
            aria-label={`Un-pair ${name}`}
          >
            Un-pair
          </Button>
        </div>
      </div>

      {shown && safetyNumber && (
        <div className="space-y-1" data-testid="device-safety-number">
          <code className="block text-sm font-mono tracking-wide font-semibold leading-6 break-all">
            {safetyNumber}
          </code>
          <p className="text-xs text-muted-foreground">
            Should match the “Validate this device” number on your phone.
          </p>
        </div>
      )}
      {shown && error && <p className="text-xs text-destructive">{error}</p>}

      {workspaces.length > 1 && (
        <fieldset className="space-y-2 pt-2" disabled={workspaceBusy}>
          <legend className="text-xs font-medium">Workspace access</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {workspaces.map((workspace) => {
              const checked = device.workspaceIds.includes(workspace.id);
              const isOnlySelection = checked && device.workspaceIds.length === 1;
              const inputId = `device-${device.kid}-workspace-${workspace.id}`;
              return (
                <div key={workspace.id} className="flex items-center gap-2">
                  <Checkbox
                    id={inputId}
                    checked={checked}
                    disabled={workspaceBusy || isOnlySelection}
                    onCheckedChange={(value) => void toggleWorkspace(workspace.id, value === true)}
                  />
                  <label htmlFor={inputId} className="text-xs">
                    {workspace.name}
                    {workspace.isDefault ? ' (Default)' : ''}
                  </label>
                </div>
              );
            })}
          </div>
          {workspaceError && <p className="text-xs text-destructive">{workspaceError}</p>}
        </fieldset>
      )}
    </div>
  );
}
