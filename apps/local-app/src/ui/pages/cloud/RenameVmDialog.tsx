import { useState, type FormEvent } from 'react';
import { REMOTE_NAME_MAX_LENGTH } from '@/modules/remotes/dtos/remote.dto';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

/** Whether a trimmed name can replace the VM's current name. */
export function isValidRename(trimmed: string, currentName: string): boolean {
  return trimmed.length > 0 && trimmed.length <= REMOTE_NAME_MAX_LENGTH && trimmed !== currentName;
}

export function RenameVmDialog({
  currentName,
  pending,
  onClose,
  onRename,
}: {
  currentName: string;
  pending: boolean;
  onClose: () => void;
  /** Resolves when the server accepted the name; a refusal rejects with the server's error. */
  onRename: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const canSubmit = !pending && isValidRename(trimmed, currentName);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    try {
      await onRename(trimmed);
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not rename the VM.'));
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] sm:w-full">
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Rename {currentName}</DialogTitle>
            <DialogDescription>The new name also shows in the mobile app.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="rename-vm-name">Name</Label>
            <Input
              id="rename-vm-name"
              value={name}
              maxLength={REMOTE_NAME_MAX_LENGTH}
              autoFocus
              aria-invalid={error ? true : undefined}
              onChange={(event) => setName(event.target.value)}
            />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} pending={pending}>
              {pending ? 'Renaming…' : 'Rename'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
