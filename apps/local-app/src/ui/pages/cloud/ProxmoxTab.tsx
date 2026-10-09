import { useState, type ReactNode } from 'react';
import { useMutation, useQueries } from '@tanstack/react-query';
import { Server } from 'lucide-react';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { BusyStatus, Spinner } from '@/ui/components/ui/spinner';
import { vmProviderConnectionQueryKey, vmProviderRightsQueryKey } from './lib/remote-vm-query-keys';
import type { ProxmoxRightsCheck, VmProviderConnectionView } from './lib/remote-vm-contracts';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import type { RemoteVmApi } from './lib/remote-vm-api';

/** One rights check per server; kept for the page session, since the server stores none. */
function rightsQuery(api: RemoteVmApi, connectionId: string) {
  return {
    queryKey: vmProviderRightsQueryKey(connectionId),
    queryFn: () => api.checkVmProviderRights(connectionId),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  };
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-all font-mono text-xs">{children}</dd>
    </div>
  );
}

function Rights({
  check,
}: {
  check: {
    data?: ProxmoxRightsCheck;
    error: Error | null;
    isFetching: boolean;
    dataUpdatedAt: number;
  };
}) {
  const checkedAt = check.dataUpdatedAt ? new Date(check.dataUpdatedAt).toLocaleString() : null;
  if (check.isFetching && !check.data) {
    return (
      <BusyStatus className="text-sm text-muted-foreground">
        Checking the Proxmox rights…
      </BusyStatus>
    );
  }
  if (check.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {check.error.message}
      </p>
    );
  }
  if (!check.data) return null;
  return (
    <div className="space-y-1 text-sm">
      {check.data.missing.length === 0 ? (
        <p className="text-status-ok">All required Proxmox rights are present.</p>
      ) : (
        <div role="alert" className="space-y-1">
          <p className="font-medium text-destructive">Missing Proxmox rights:</p>
          <ul aria-label="Missing Proxmox rights" className="list-disc pl-5">
            {check.data.missing.map((right) => (
              <li key={right} className="break-all">
                {right}
              </li>
            ))}
          </ul>
          <p>Run the setup block on the Proxmox node again, then check again.</p>
        </div>
      )}
      {checkedAt && (
        <p className="text-xs text-muted-foreground">
          {check.isFetching && <Spinner className="mr-1 h-3 w-3" />}
          {check.isFetching ? 'Checking again…' : `Checked ${checkedAt}`}
        </p>
      )}
    </div>
  );
}

/**
 * One box per Proxmox server: its placement, its rights (checked once per
 * page session) and its VM count. Removing a server waits until no VM uses
 * it. The VMs tab owns the VMs themselves.
 */
export function ProxmoxTab({
  connections,
  loading,
  error,
  remotes,
  onOpenVms,
  onConnect,
}: {
  connections: VmProviderConnectionView[];
  loading: boolean;
  error: Error | null;
  remotes: readonly RemoteListItemDto[];
  onOpenVms: () => void;
  onConnect: () => void;
}) {
  const api = useRemoteVmApi();
  const client = useHomeQueryClient();
  const checks = useQueries(
    { queries: connections.map((connection) => rightsQuery(api, connection.id)) },
    client,
  );
  const [removeTarget, setRemoveTarget] = useState<VmProviderConnectionView | null>(null);
  const [removeError, setRemoveError] = useState<{ id: string; message: string } | null>(null);
  const remove = useMutation(
    {
      mutationFn: (connectionId: string) => api.deleteVmProvider(connectionId),
      onSuccess: () => {
        setRemoveError(null);
        void client.invalidateQueries({ queryKey: vmProviderConnectionQueryKey });
      },
      onError: (cause: Error, connectionId) =>
        setRemoveError({ id: connectionId, message: cause.message }),
    },
    client,
  );

  if (loading) {
    return (
      <BusyStatus className="text-sm text-muted-foreground">Loading Proxmox servers…</BusyStatus>
    );
  }

  const loadError = error && (
    <p role="alert" className="text-sm text-destructive">
      Could not load the Proxmox servers: {error.message}
    </p>
  );

  if (connections.length === 0) {
    return (
      <div className="space-y-3">
        {loadError}
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <Server aria-hidden="true" className="h-8 w-8 text-muted-foreground" />
            <div className="max-w-md space-y-2 text-sm">
              <p className="font-medium">Create VMs on your Proxmox server</p>
              <ol className="list-decimal space-y-1 pl-5 text-left text-muted-foreground">
                <li>Run the setup block in the Proxmox node&apos;s root shell.</li>
                <li>Paste the connection string it prints.</li>
                <li>Confirm the server&apos;s fingerprint.</li>
              </ol>
            </div>
            <Button onClick={onConnect}>Connect a server</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          DevChain creates, resets and destroys VMs on these servers.
        </p>
        <Button size="sm" variant="outline" onClick={onConnect}>
          Connect a server
        </Button>
      </div>
      {loadError}
      {connections.map((connection, index) => {
        const check = checks[index];
        const vms = remotes.filter((remote) => remote.vmProviderConnectionId === connection.id);
        const blocker = vms[0] ? `${vms[0].name} uses this server` : null;
        const removeButton = (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={blocker !== null}
            pending={remove.isPending && remove.variables === connection.id}
            onClick={() => setRemoveTarget(connection)}
          >
            Remove
          </Button>
        );
        return (
          <Card key={connection.id} aria-labelledby={`proxmox-${connection.id}`} role="region">
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0 pb-3">
              <div className="min-w-0 space-y-1">
                <CardTitle id={`proxmox-${connection.id}`} className="break-all text-base">
                  {connection.name}
                </CardTitle>
                <CardDescription className="break-all">{connection.apiUrl}</CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <Button size="sm" variant="outline" onClick={onOpenVms}>
                  {vms.length === 1 ? '1 VM' : `${vms.length} VMs`}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void check?.refetch()}
                  pending={check?.isFetching}
                >
                  Check again
                </Button>
                {blocker ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span tabIndex={0} aria-label={`Remove: ${blocker}`}>
                          {removeButton}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{blocker}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  removeButton
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Fact label="Node">{connection.node}</Fact>
                <Fact label="Pool">{connection.pool}</Fact>
                <Fact label="VM storage">{connection.storage}</Fact>
                <Fact label="Image storage">{connection.imageStorage}</Fact>
                <Fact label="Bridge">{connection.bridge}</Fact>
              </dl>
              {check && <Rights check={check} />}
              {removeError?.id === connection.id && (
                <p role="alert" className="text-sm text-destructive">
                  {removeError.message}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                To rotate the API token, run the setup block again with{' '}
                <span className="font-mono">--rotate</span> and connect the new string.
              </p>
            </CardContent>
          </Card>
        );
      })}
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        onConfirm={() => {
          if (removeTarget) remove.mutate(removeTarget.id);
        }}
        title={`Remove ${removeTarget?.name ?? 'this server'}?`}
        description="DevChain forgets this Proxmox server and its token. The server and its VMs stay as they are."
        confirmText="Remove"
        cancelText="Cancel"
        variant="destructive"
      />
    </div>
  );
}
