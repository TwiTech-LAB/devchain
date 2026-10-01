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
  onDestroy: (force: boolean) => void;
}) {
  const [confirmForce, setConfirmForce] = useState(false);
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
  // A VM that rejects this PC's API key cannot answer the final login pull either.
  const unreachable = remote.online === false || remote.apiKeyRejected === true;
  const hasBindings = projects.length > 0;
  const cannotDestroy =
    destroyVm && (bindingsLoading || hasBindings || (unreachable && !confirmForce));

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
                  setConfirmForce(false);
                }}
                disabled={pending}
                aria-label="Destroy VM too"
              />
              Destroy VM too
            </label>

            {destroyVm && bindingsLoading && <p role="status">Checking project connections…</p>}
            {destroyVm && hasBindings && (
              <div role="alert" className="space-y-1">
                <p>Disconnect these projects first:</p>
                <ul aria-label="Projects connected to this VM" className="list-disc pl-5">
                  {projects.map((project) => (
                    <li key={project.id}>{project.name}</li>
                  ))}
                </ul>
              </div>
            )}
            {destroyVm && unreachable && (
              <div className="space-y-2">
                <p role="note">
                  {remote.apiKeyRejected
                    ? "The VM rejects this PC's API key."
                    : 'The VM is offline.'}{' '}
                  Provider logins keep their last saved copy if they cannot be pulled from the VM.
                </p>
                <label className="flex items-start gap-2">
                  <Checkbox
                    checked={confirmForce}
                    onCheckedChange={(checked) => setConfirmForce(checked === true)}
                    disabled={pending}
                    aria-label="Force destruction while the VM is unreachable"
                    className="mt-0.5"
                  />
                  Use the last saved provider logins and continue.
                </label>
              </div>
            )}
          </div>
        )}

        <StartError error={error} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              if (destroyVm) onDestroy(unreachable && confirmForce);
              else onDelete();
            }}
            disabled={pending || cannotDestroy}
          >
            {pending
              ? 'Processing…'
              : terminal
                ? 'Remove'
                : destroyVm
                  ? 'Destroy VM'
                  : 'Delete registration'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
