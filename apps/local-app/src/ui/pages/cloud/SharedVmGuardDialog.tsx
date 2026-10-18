import { useEffect, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { sharedVmOccupied } from '@/modules/remotes/dtos/shared-vm.dto';
import type { SharedVmGuardContext, SharedVmForceRequest } from './lib/remote-vm-contracts';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { Textarea } from '@/ui/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { vmReachable } from './remote-status';
import { StartError } from './StartError';

export function SharedVmGuardDialog({
  remote,
  action,
  projects,
  pending,
  bindingsLoading = false,
  error,
  refusal,
  children,
  onClose,
  onConfirm,
  onDisconnectAll,
}: {
  remote: RemoteListItemDto;
  action: 'reset' | 'destroy';
  projects: Array<{ id: string; name: string }>;
  pending: boolean;
  bindingsLoading?: boolean;
  error?: string | null;
  refusal?: SharedVmGuardContext | null;
  children?: ReactNode;
  onClose: () => void;
  onConfirm: (input: SharedVmForceRequest) => void;
  onDisconnectAll?: () => void;
}): JSX.Element {
  const api = useRemoteVmApi();
  const queryClient = useHomeQueryClient();
  const query = useQuery(
    {
      queryKey: ['shared-vm', remote.id],
      queryFn: ({ signal }) => api.readSharedVm(remote.id, signal),
      staleTime: 0,
      retry: false,
    },
    queryClient,
  );
  const context = refusal ?? query.data;
  const occupancy =
    query.isError && !refusal
      ? { unavailable: true, instances: [] }
      : (context?.occupancy ?? { unavailable: true, instances: [] });
  const lastRoster = context?.lastRoster ?? remote.sharedVmRoster;
  const unreachable = !vmReachable(remote);
  const occupied = sharedVmOccupied(occupancy);
  const warn = unreachable || occupied;
  const [accepted, setAccepted] = useState(false);
  const [message, setMessage] = useState('');
  const checking = query.isPending && !refusal;
  const snapshotKey = JSON.stringify(occupancy);
  useEffect(() => setAccepted(false), [snapshotKey]);
  const notify = useMutation(
    {
      mutationFn: () =>
        api.notifySharedVm(remote.id, {
          action,
          ...(message.trim() ? { message: message.trim() } : {}),
        }),
    },
    queryClient,
  );
  const acceptLabel = unreachable
    ? `Force ${action === 'reset' ? 'reset' : 'destruction'} while the VM is unreachable`
    : `Force ${action} and accept the possible loss`;
  const cannotStart =
    checking ||
    (warn && !accepted) ||
    (action === 'destroy' && (bindingsLoading || projects.length > 0));
  const close = (open: boolean) => {
    if (!open && !pending) onClose();
  };
  const accept = (checked: boolean | 'indeterminate') => setAccepted(checked === true);
  const changeMessage = (event: ChangeEvent<HTMLTextAreaElement>) => setMessage(event.target.value);
  const sendNotice = () => notify.mutate();
  const confirm = () => {
    if (cannotStart) return;
    onConfirm({
      force: unreachable && accepted,
      forceOccupied: occupied && accepted,
      confirmedOccupancy: occupancy,
    });
  };
  const others =
    lastRoster?.roster.instances.filter(({ user }) => user !== lastRoster.ownUser) ?? [];

  return (
    <Dialog open onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {action === 'reset' ? 'Reset' : 'Destroy'} {remote.name}?
          </DialogTitle>
          <DialogDescription>
            {action === 'reset'
              ? 'Reset destroys this VM and recreates your instance with the same resources, then reconnects your projects.'
              : 'Destroy permanently deletes this VM and removes its registration.'}
          </DialogDescription>
        </DialogHeader>
        {children}
        {checking && <p role="status">Checking other users…</p>}
        {projects.length > 0 && (
          <section className="space-y-2 text-sm">
            <p>
              {action === 'reset'
                ? 'Your projects will be reconnected:'
                : 'Disconnect these projects first:'}
            </p>
            <ul
              aria-label={
                action === 'reset'
                  ? 'Projects that will be reconnected'
                  : 'Projects connected to this VM'
              }
              className="list-disc pl-5"
            >
              {projects.map((project) => (
                <li key={project.id}>{project.name}</li>
              ))}
            </ul>
            {action === 'destroy' && onDisconnectAll && (
              <Button
                variant="outline"
                disabled={pending || bindingsLoading}
                onClick={onDisconnectAll}
              >
                Disconnect all
              </Button>
            )}
          </section>
        )}
        {occupancy.instances.length > 0 && (
          <ul aria-label="Other users on this VM" className="list-disc pl-5 text-sm">
            {occupancy.instances.map((instance) => (
              <li key={instance.user}>
                {instance.user}:{' '}
                {instance.connectedProjectIds === 'unknown' ? 'unknown' : instance.connectedCount}{' '}
                projects
              </li>
            ))}
          </ul>
        )}
        {occupancy.unavailable && (
          <p role="note" className="text-sm">
            Other users’ connected projects are unknown.
          </p>
        )}
        {occupancy.unavailable && others.length > 0 && (
          <section className="text-sm text-muted-foreground">
            <p>Last known roster (context only):</p>
            <ul className="list-disc pl-5">
              {others.map((instance) => (
                <li key={instance.user}>
                  {instance.user}: {instance.connectedCount} projects
                </li>
              ))}
            </ul>
          </section>
        )}
        {warn && (
          <div className="space-y-3 rounded-md border border-status-warn/50 bg-status-warn/5 p-3 text-sm">
            {unreachable && (
              <p>
                {remote.apiKeyRejected
                  ? "This VM rejects this PC's API key."
                  : remote.powerState === 'stopped'
                    ? 'This VM is powered off.'
                    : 'This VM is unreachable.'}{' '}
                The latest provider logins cannot be pulled; DevChain uses their last saved copies.
                Your unsynced changes may be lost.
              </p>
            )}
            {occupied && (
              <p>
                Forcing this {action} can delete the other users’ projects and unsynced changes,
                including any projects whose occupancy is unknown.{' '}
                {action === 'reset' && 'Only your instance will be recreated.'}
              </p>
            )}
            <label className="flex items-start gap-2">
              <Checkbox
                checked={accepted}
                onCheckedChange={accept}
                disabled={pending || checking}
                aria-label={acceptLabel}
                className="mt-0.5"
              />
              I accept the possible loss and want to force {action}.
            </label>
          </div>
        )}
        {occupied && (
          <section className="space-y-2 text-sm">
            <label htmlFor="shared-vm-notice">Optional message to the other users</label>
            <Textarea
              id="shared-vm-notice"
              value={message}
              onChange={changeMessage}
              maxLength={2000}
              disabled={notify.isPending || pending}
            />
            <Button
              variant="outline"
              type="button"
              onClick={sendNotice}
              pending={notify.isPending}
              disabled={pending || checking}
            >
              Notify them
            </Button>
            {notify.data && (
              <p role="status">
                {notify.data.results.length === 0
                  ? 'No other users were notified.'
                  : notify.data.results
                      .map(
                        ({ user, delivered }) =>
                          `${user}: ${delivered ? 'notice sent' : 'could not notify'}`,
                      )
                      .join('; ')}
              </p>
            )}
            {notify.isError && <p role="alert">{notify.error.message}</p>}
          </section>
        )}
        <StartError error={error} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={confirm}
            disabled={cannotStart}
            pending={pending}
          >
            {pending ? 'Starting…' : action === 'reset' ? 'Reset VM' : 'Destroy VM'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
