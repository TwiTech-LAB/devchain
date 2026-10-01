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
import { vmReachable } from './remote-status';
import { StartError } from './StartError';

export function ResetVmDialog({
  remote,
  projects,
  pending,
  error,
  onClose,
  onReset,
}: {
  remote: RemoteListItemDto;
  projects: Array<{ id: string; name: string }>;
  pending: boolean;
  /** The refusal of the last start request, shown above the buttons. */
  error?: string | null;
  onClose: () => void;
  onReset: (force: boolean) => void;
}) {
  const [force, setForce] = useState(false);
  const unreachable = !vmReachable(remote);
  let unreachableNote = 'This VM is unreachable.';
  if (remote.powerState === 'stopped') unreachableNote = 'This VM is powered off.';
  else if (remote.apiKeyRejected) unreachableNote = "This VM rejects this PC's API key.";

  const confirmReset = () => {
    if (unreachable && !force) return;
    onReset(force);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset {remote.name}?</DialogTitle>
          <DialogDescription>
            Reset destroys this VM and creates a replacement with the same resources, then
            reconnects its projects.
          </DialogDescription>
        </DialogHeader>

        <section className="space-y-2 text-sm">
          <p className="font-medium">Projects connected to this VM</p>
          {projects.length > 0 ? (
            <ul aria-label="Projects that will be reconnected" className="list-disc pl-5">
              {projects.map((project) => (
                <li key={project.id}>{project.name}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">No projects are currently connected.</p>
          )}
        </section>

        {unreachable && (
          <div className="space-y-3 rounded-md border border-status-warn/50 bg-status-warn/5 p-3 text-sm">
            <p role="alert" className="font-medium">
              {unreachableNote}
            </p>
            <p>
              A forced reset cannot pull the latest provider logins from the VM. It will use the
              last saved copies, and project file changes that never synced home may be lost.
            </p>
            <label className="flex items-start gap-2">
              <Checkbox
                checked={force}
                onCheckedChange={(checked) => setForce(checked === true)}
                disabled={pending}
                aria-label="Force reset while the VM is unreachable"
                className="mt-0.5"
              />
              Force reset and accept the possible loss of unsynced changes
            </label>
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
            onClick={confirmReset}
            disabled={pending || (unreachable && !force)}
          >
            {pending ? 'Starting…' : 'Reset VM'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
