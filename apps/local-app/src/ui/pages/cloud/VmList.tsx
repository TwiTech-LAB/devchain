import { useEffect, useRef } from 'react';
import { Lock, LockOpen, MoreHorizontal, Plus, Server } from 'lucide-react';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardHeader } from '@/ui/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/components/ui/dropdown-menu';
import { RemoteMetricsStrip } from '@/ui/components/remote-metrics/RemoteMetricsStrip';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import type { VmProviderConnectionView } from '@/ui/hooks/useVmProviderConnections';
import { cn } from '@/ui/lib/utils';
import {
  VM_CONNECTION_LABELS,
  vmConnectionSecurity,
  vmReachable,
  type VmAction,
  type VmConnectionSecurity,
  type VmStatus,
} from './remote-status';
import { addressHost } from './own-vm-address';
import { TONE_CLASSES } from '@/ui/lib/status-tone';
import { StatusChip } from './StatusChip';

/**
 * A lock after the status when the VM answered over its pinned certificate,
 * an open lock when a set-up VM has no certificate; nothing otherwise.
 */
function ConnectionSign({ security }: { security: VmConnectionSecurity | null }) {
  if (security !== 'pinned' && security !== 'no-certificate') return null;
  const pinned = security === 'pinned';
  const Icon = pinned ? Lock : LockOpen;
  const label = VM_CONNECTION_LABELS[security];
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            tabIndex={0}
            aria-label={label}
            className={cn(
              'inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              pinned ? 'text-status-ok' : 'text-status-warn',
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export type RemovePurpose = 'registration' | 'failed-vm' | 'cancelled-create' | 'completed-destroy';

/** Which `RemoteDeleteDialog` a Remove opens for this VM. */
export function removePurpose(
  remote: RemoteListItemDto,
  status: VmStatus,
  failedVmOperation: boolean,
): RemovePurpose {
  if (status.state === 'removed') {
    return remote.lastOperation?.kind === 'destroy_vm' ? 'completed-destroy' : 'cancelled-create';
  }
  return failedVmOperation ? 'failed-vm' : 'registration';
}

export type VmMenuKey =
  | 'enter-api-key'
  | 'reset-api-key'
  | 'connect-project'
  | 'change-logins'
  | 'install-docker'
  | 'update'
  | 'power-on'
  | 'rename'
  | 'view'
  | 'reset'
  | 'remove'
  | 'destroy';

export interface VmMenuItem {
  key: VmMenuKey;
  label: string;
  /** Items after the separator change or remove the VM itself. */
  danger: boolean;
}

/**
 * The menu items that apply to a VM. Items that start a host operation hide
 * while one is open, because the server refuses them then.
 */
export function vmMenuItems(
  remote: RemoteListItemDto,
  status: VmStatus,
  failedVmOperation: boolean,
): VmMenuItem[] {
  const items: VmMenuItem[] = [];
  const add = (key: VmMenuKey, label: string, danger = false) => items.push({ key, label, danger });
  const removed = status.state === 'removed';
  const hostFree = status.state !== 'busy' && status.state !== 'stopped';
  const proxmox = remote.kind === 'proxmox';
  const reachable = vmReachable(remote);

  if (remote.apiKeyRejected) add('enter-api-key', 'Enter API key');
  if (hostFree && reachable && !removed) add('reset-api-key', 'Reset API key');
  if (status.state === 'ready') add('connect-project', 'Connect a project');
  // Change logins cancels a failed login change itself before it sends the new one.
  const loginChangeStopped =
    status.state === 'stopped' && status.operation?.kind === 'update_logins';
  if ((hostFree || loginChangeStopped) && reachable && remote.versionMatches && remote.logins) {
    add('change-logins', 'Change logins');
  }
  if (
    hostFree &&
    reachable &&
    remote.version &&
    !(remote.docker?.installed && remote.docker.userInGroup)
  ) {
    add('install-docker', 'Install Docker');
  }
  if (hostFree && reachable && !remote.versionMatches) add('update', 'Update');
  if (hostFree && proxmox && remote.powerState === 'stopped') add('power-on', 'Power on');
  if (!removed) {
    add('rename', 'Rename');
    add('view', 'View details');
  }
  if (hostFree && proxmox && remote.vmIdentity && remote.vmSpec) add('reset', 'Reset VM', true);
  add('remove', 'Remove', true);
  if (
    !removed &&
    status.state !== 'busy' &&
    proxmox &&
    remote.vmProviderConnectionId &&
    (remote.vmIdentity || failedVmOperation)
  ) {
    add('destroy', 'Destroy VM', true);
  }
  return items;
}

/**
 * Where the VM runs: its Proxmox server or its address. With a provisioned
 * user the address becomes the SSH target `user@host`; `addressHost` returns
 * the DNS name when the VM was added by name, so this is not always an IP.
 */
export function vmWhere(
  remote: RemoteListItemDto,
  connectionNames: ReadonlyMap<string, string>,
): string {
  const host = remote.baseUrl ? addressHost(remote.baseUrl) : null;
  const ssh = remote.userName && host ? `${remote.userName}@${host}` : null;
  const address = ssh ?? remote.baseUrl;
  if (remote.kind !== 'proxmox') return address ?? '—';
  const server = connectionNames.get(remote.vmProviderConnectionId ?? '') ?? 'server';
  return `Proxmox · ${server}${address ? ` · ${address}` : ''}`;
}

/** The VM name that opens its drawer, on the VMs tab and in Overview's summary. */
export const VM_NAME_BUTTON_CLASS =
  'break-all text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function formatSeen(iso: string | null): string {
  if (!iso) return 'Never seen';
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 'Never seen' : `Last seen ${new Date(parsed).toLocaleString()}`;
}

function VmRow({
  remote,
  status,
  menu,
  where,
  projectCount,
  highlighted,
  powerOnPending,
  onAction,
  onMenu,
  onOpenActivity,
  onView,
}: {
  remote: RemoteListItemDto;
  status: VmStatus;
  menu: VmMenuItem[];
  where: string;
  projectCount: number;
  highlighted: boolean;
  powerOnPending: boolean;
  onAction: (action: VmAction) => void;
  onMenu: (key: VmMenuKey) => void;
  onOpenActivity: (operationId: string) => void;
  onView: () => void;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [highlighted]);
  const { action } = status;
  const main = menu.filter((item) => !item.danger);
  const danger = menu.filter((item) => item.danger);

  return (
    <li
      ref={rowRef}
      aria-label={remote.name}
      aria-current={highlighted ? 'true' : undefined}
      className={cn(
        'flex flex-wrap items-start justify-between gap-x-3 gap-y-2 py-3',
        highlighted && '-mx-2 rounded-md bg-muted/50 px-2',
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={onView} className={VM_NAME_BUTTON_CLASS}>
            {remote.name}
          </button>
          <StatusChip tone={status.tone}>{status.label}</StatusChip>
          <ConnectionSign security={vmConnectionSecurity(remote, status.state)} />
          {status.note && <span className="text-xs text-muted-foreground">{status.note}</span>}
          {status.chips.map((chip) =>
            chip.operationId ? (
              <button
                key={chip.key}
                type="button"
                onClick={() => onOpenActivity(chip.operationId!)}
                className={cn(
                  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  TONE_CLASSES[chip.tone],
                )}
              >
                {chip.label}
              </button>
            ) : (
              <Badge key={chip.key} variant="outline" className={TONE_CLASSES[chip.tone]}>
                {chip.label}
              </Badge>
            ),
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="break-all">{where}</span>
          <span>{projectCount === 1 ? '1 project' : `${projectCount} projects`}</span>
          {vmReachable(remote) ? (
            <RemoteMetricsStrip remoteId={remote.id} remoteName={remote.name} />
          ) : (
            <span>{formatSeen(remote.lastSeenAt)}</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {action && (
          <Button
            size="sm"
            variant={status.tone === 'error' ? 'destructive' : 'outline'}
            disabled={action.kind === 'power-on' && powerOnPending}
            onClick={() => onAction(action)}
          >
            {action.kind === 'power-on' && powerOnPending ? 'Starting…' : action.label}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`More actions for ${remote.name}`}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {main.map((item) => (
              <DropdownMenuItem key={item.key} onSelect={() => onMenu(item.key)}>
                {item.label}
              </DropdownMenuItem>
            ))}
            {main.length > 0 && danger.length > 0 && <DropdownMenuSeparator />}
            {danger.map((item) => (
              <DropdownMenuItem
                key={item.key}
                onSelect={() => onMenu(item.key)}
                className="text-destructive focus:text-destructive"
              >
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

/** The VMs tab: one two-line row per VM with its state, next step and menu. */
export function VmList({
  remotes,
  loading,
  statuses,
  failedVmOperations,
  connectionNames,
  projectCounts,
  highlightedId,
  pendingPowerOn,
  connections,
  actionPending,
  onCreateOnServer,
  onAddOwnVm,
  onConnectServer,
  onAction,
  onMenu,
  onOpenActivity,
  onView,
}: {
  remotes: RemoteListItemDto[];
  loading: boolean;
  statuses: ReadonlyMap<string, VmStatus>;
  failedVmOperations: ReadonlySet<string>;
  connectionNames: ReadonlyMap<string, string>;
  projectCounts: ReadonlyMap<string, number>;
  highlightedId: string | null;
  pendingPowerOn: ReadonlySet<string>;
  connections: VmProviderConnectionView[];
  /** A host operation is in flight; creating a VM must wait for it. */
  actionPending: boolean;
  onCreateOnServer: (connection: VmProviderConnectionView) => void;
  onAddOwnVm: () => void;
  onConnectServer: () => void;
  onAction: (remote: RemoteListItemDto, action: VmAction) => void;
  onMenu: (remote: RemoteListItemDto, key: VmMenuKey) => void;
  onOpenActivity: (operationId: string) => void;
  onView: (remote: RemoteListItemDto) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-end space-y-0 pb-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              <Plus aria-hidden="true" className="mr-1 h-4 w-4" />
              Add VM
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {connections.length === 0 ? (
              <DropdownMenuItem onSelect={onConnectServer}>
                Connect a Proxmox server
              </DropdownMenuItem>
            ) : (
              connections.map((connection) => (
                <DropdownMenuItem
                  key={connection.id}
                  disabled={actionPending}
                  onSelect={() => onCreateOnServer(connection)}
                >
                  Create on {connection.name}
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onAddOwnVm}>Add your own VM</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading VMs…</p>
        ) : remotes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <Server aria-hidden="true" className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No VMs yet.</p>
          </div>
        ) : (
          <ul aria-label="VMs" className="divide-y">
            {remotes.map((remote) => {
              const status = statuses.get(remote.id);
              if (!status) return null;
              return (
                <VmRow
                  key={remote.id}
                  remote={remote}
                  status={status}
                  menu={vmMenuItems(remote, status, failedVmOperations.has(remote.id))}
                  where={vmWhere(remote, connectionNames)}
                  projectCount={projectCounts.get(remote.id) ?? 0}
                  highlighted={highlightedId === remote.id}
                  powerOnPending={pendingPowerOn.has(remote.id)}
                  onAction={(action) => onAction(remote, action)}
                  onMenu={(key) => onMenu(remote, key)}
                  onOpenActivity={onOpenActivity}
                  onView={() => onView(remote)}
                />
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
