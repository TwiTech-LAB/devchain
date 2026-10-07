import { useState } from 'react';
import type { ForceSyncSource } from '@/modules/remotes/operations/remote-operation.dto';
import type { ForceSyncOffer } from '@/modules/remotes/sync/remote-file-sync.dto';
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

export function ForceSyncDialog({
  projectName,
  remoteName,
  offer,
  pending,
  error,
  onClose,
  onForceSync,
}: {
  projectName: string;
  remoteName: string;
  offer: ForceSyncOffer;
  pending: boolean;
  error?: string | null;
  onClose: () => void;
  onForceSync: (source: ForceSyncSource) => void;
}) {
  const [source, setSource] = useState<ForceSyncSource | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const otherSide = source === 'home' ? 'the VM' : 'this PC';
  const count = source === 'home' ? offer.pending.fromVm : offer.pending.fromHome;
  const choose = (choice: ForceSyncSource) => {
    setSource(choice);
    setConfirmed(false);
  };
  const chooseHome = () => choose('home');
  const chooseVm = () => choose('vm');
  const confirm = (checked: boolean | 'indeterminate') => setConfirmed(checked === true);
  const start = () => {
    if (source && confirmed && !pending) onForceSync(source);
  };
  const changeOpen = (open: boolean) => {
    if (!open && !pending) onClose();
  };

  return (
    <Dialog open onOpenChange={changeOpen}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Force sync · {projectName}</DialogTitle>
          <DialogDescription>Choose which side's files to keep as the source.</DialogDescription>
        </DialogHeader>
        <fieldset disabled={pending} className="space-y-2 text-sm">
          <legend className="mb-2 font-medium">Files to keep</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="force-sync-source"
              checked={source === 'home'}
              onChange={chooseHome}
              className="accent-primary"
            />
            Use this PC's files
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="force-sync-source"
              checked={source === 'vm'}
              onChange={chooseVm}
              className="accent-primary"
            />
            Use the VM's files ({remoteName})
          </label>
        </fieldset>
        {source && (
          <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p>
              Files on {otherSide} that differ are replaced. Files that exist only on {otherSide}{' '}
              are deleted.
            </p>
            <p>
              Ignored files stay. Exception: ignored build and dependency folders (such as
              node_modules) inside a folder that exists only on {otherSide} are deleted with that
              folder, with no copy.
            </p>
            <p>
              DevChain keeps a copy of each replaced or deleted file in sync-backups in the DevChain
              folder on {otherSide}.
            </p>
            <p>
              DevChain locks the project on the VM and stops its agent sessions. Close editors and
              other programs that change files in this project.
            </p>
            <p>After the copy starts, you cannot cancel. You can retry, or force a disconnect.</p>
            {count !== null && (
              <p>
                {source === 'home' ? 'The VM' : 'This PC'} has about {count} changes that the chosen
                side does not have.
              </p>
            )}
            <label className="flex items-start gap-2">
              <Checkbox
                checked={confirmed}
                onCheckedChange={confirm}
                disabled={pending}
                aria-label={`Replace and delete files on ${otherSide}`}
                className="mt-0.5"
              />
              Replace and delete files on {otherSide}
            </label>
          </div>
        )}
        <StartError error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!source || !confirmed}
            pending={pending}
            onClick={start}
          >
            {pending ? 'Starting…' : 'Force sync'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
