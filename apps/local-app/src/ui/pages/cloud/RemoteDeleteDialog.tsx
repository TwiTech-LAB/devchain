import { useState } from 'react';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { StartError } from './StartError';
import { SharedVmGuardDialog } from './SharedVmGuardDialog';
import type { SharedVmGuardContext, SharedVmForceRequest } from './lib/remote-vm-contracts';

interface BoundProject {
  id: string;
  name: string;
}

type DeletePurpose = 'registration' | 'failed-vm' | 'cancelled-create' | 'completed-destroy';

export function RemoteDeleteDialog({
  remote,
  purpose,
  projects,
  bindingsLoading,
  pending,
  error,
  initialDestroy = false,
  onClose,
  onDelete,
  onDestroy,
  onDisconnectAll,
  refusal,
}: {
  remote: RemoteListItemDto;
  purpose: DeletePurpose;
  projects: BoundProject[];
  bindingsLoading: boolean;
  pending: boolean;
  /** The refusal of the last start request, shown above the buttons. */
  error?: string | null;
  /** Opens with "Destroy VM too" checked, for the Destroy VM menu item. */
  initialDestroy?: boolean;
  onClose: () => void;
  onDelete: () => void;
  onDestroy: (input: SharedVmForceRequest) => void;
  onDisconnectAll?: () => void;
  refusal?: SharedVmGuardContext | null;
}) {
  const terminal = purpose === 'cancelled-create' || purpose === 'completed-destroy';
  const failedVm = purpose === 'failed-vm';
  const cancelledCreate = purpose === 'cancelled-create';
  const completedDestroy = purpose === 'completed-destroy';
  const managedVm =
    (purpose === 'registration' || failedVm) &&
    remote.kind === 'proxmox' &&
    !!remote.vmProviderConnectionId &&
    (!!remote.vmIdentity || failedVm);
  const [destroyVm, setDestroyVm] = useState(initialDestroy && managedVm);

  if (destroyVm)
    return (
      <SharedVmGuardDialog
        remote={remote}
        action="destroy"
        projects={projects}
        bindingsLoading={bindingsLoading}
        pending={pending}
        error={error}
        refusal={refusal}
        onClose={onClose}
        onConfirm={onDestroy}
        onDisconnectAll={onDisconnectAll}
      >
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked
            onCheckedChange={() => setDestroyVm(false)}
            disabled={pending}
            aria-label="Destroy VM too"
          />
          Destroy VM too
        </label>
      </SharedVmGuardDialog>
    );

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {terminal ? `Remove ${remote.name}?` : `Delete ${remote.name}?`}
          </DialogTitle>
          <DialogDescription>
            {cancelledCreate
              ? 'The create operation was cancelled and its guarded VM cleanup completed. This removes the leftover row.'
              : completedDestroy
                ? 'The VM is already destroyed. This removes the leftover DevChain registration.'
                : failedVm
                  ? 'The VM operation failed. Delete registration leaves any VM in Proxmox. Destroy VM too checks ownership and removes the VM when one was created.'
                  : remote.kind === 'proxmox'
                    ? 'This removes the DevChain registration only; the Proxmox VM remains. It fails while a project is connected to it.'
                    : 'This only removes the registration. It fails if any project is still bound to it.'}
          </DialogDescription>
        </DialogHeader>

        {managedVm && (
          <div className="space-y-3 rounded-md border p-3 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox
                checked={destroyVm}
                onCheckedChange={(checked) => {
                  setDestroyVm(checked === true);
                }}
                disabled={pending}
                aria-label="Destroy VM too"
              />
              Destroy VM too
            </label>
          </div>
        )}

        <StartError error={error} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onDelete} pending={pending}>
            {pending ? 'Processing…' : terminal ? 'Remove' : 'Delete registration'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
